import { afterEach, describe, expect, it } from "vitest";
import {
  CorruptStoredContextPackError,
  InvalidTaskError,
  neutralHierarchyVocabulary,
  softwareHierarchyVocabulary,
  type ProjectRecord,
  type RecordKind,
  type RecordStatus,
} from "../domain/index.js";
import {
  createContextPackStore,
  type ContextPackStore,
} from "../storage/context-pack-store.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import {
  createProjectStore,
  type ProjectStore,
} from "../storage/project-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  createContextService,
  estimateContextItemTokens,
} from "./context-service.js";

const generatedAt = "2026-07-26T21:00:00.000Z";

describe("context service", () => {
  let database: IntentArcDatabase | undefined;
  let concurrentDatabase: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    concurrentDatabase?.close();
    database?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  const createFixture = (): {
    database: IntentArcDatabase;
    projectStore: ProjectStore;
    contextPackStore: ContextPackStore;
    projectId: string;
    createService: (packIds?: string[]) => ReturnType<typeof createContextService>;
  } => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const counters = {
      project: 0,
      record: 0,
      relationship: 0,
      audit: 0,
    };
    const projectStore = createProjectStore(database, {
      now: () => generatedAt,
      newId: (prefix) => `${prefix}-${++counters[prefix]}`,
    });
    const contextPackStore = createContextPackStore(database);
    const project = projectStore.createProject({ name: "IntentArc" });

    return {
      database,
      projectStore,
      contextPackStore,
      projectId: project.id,
      createService: (packIds = ["pack-1"]) =>
        createContextService({
          projectStore,
          contextPackStore,
          now: () => generatedAt,
          newId: () => packIds.shift() ?? "unexpected-pack-id",
          estimateTokens: (text) => text.length,
        }),
    };
  };

  const createRecord = (
    projectStore: ProjectStore,
    projectId: string,
    kind: RecordKind,
    status: RecordStatus,
    title: string,
    body: string,
  ): ProjectRecord =>
    projectStore.createRecord({
      projectId,
      kind,
      status,
      title,
      body,
      sourceKind: "human",
      sourceRef: null,
    });

  it("selects the stable frame and linked records in deterministic relationship order", () => {
    const {
      database: fixtureDatabase,
      projectStore,
      contextPackStore,
      projectId,
      createService,
    } = createFixture();
    const constraint = createRecord(
      projectStore,
      projectId,
      "constraint",
      "accepted",
      "Local only",
      "Keep authoritative state local.",
    );
    const vision = createRecord(
      projectStore,
      projectId,
      "vision",
      "accepted",
      "Coherent work",
      "Keep implementation aligned with intent.",
    );
    const nonGoal = createRecord(
      projectStore,
      projectId,
      "non_goal",
      "accepted",
      "No hosted control plane",
      "Do not require a cloud service.",
    );
    const outcome = createRecord(
      projectStore,
      projectId,
      "outcome",
      "accepted",
      "Focused context",
      "Give every task the context it needs.",
    );
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Assemble context",
      "Build a deterministic context pack.",
    );
    const component = createRecord(
      projectStore,
      projectId,
      "component",
      "provisional",
      "Context engine",
      "Selects authoritative records.",
    );
    const evidence = createRecord(
      projectStore,
      projectId,
      "evidence",
      "accepted",
      "Selection fixture",
      "The fixture demonstrates stable ordering.",
    );
    const decision = createRecord(
      projectStore,
      projectId,
      "decision",
      "accepted",
      "Use explicit relationships",
      "Only one-hop links are context candidates.",
    );
    const unrelatedIdea = createRecord(
      projectStore,
      projectId,
      "idea",
      "provisional",
      "Graph visualization",
      "Render the project graph.",
    );

    projectStore.createRelationship({
      projectId,
      fromRecordId: task.id,
      toRecordId: component.id,
      kind: "related_to",
    });
    projectStore.createRelationship({
      projectId,
      fromRecordId: task.id,
      toRecordId: component.id,
      kind: "implements",
    });
    projectStore.createRelationship({
      projectId,
      fromRecordId: evidence.id,
      toRecordId: task.id,
      kind: "evidenced_by",
    });
    projectStore.createRelationship({
      projectId,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });
    const revisionBeforePack = projectStore.getProject(projectId)?.revision;

    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 10_000,
    });

    expect(pack.stableFrame.map((item) => item.record.kind)).toEqual([
      "vision",
      "outcome",
      "constraint",
      "non_goal",
    ]);
    expect(pack.stableFrame.map((item) => item.record.id)).toEqual([
      vision.id,
      outcome.id,
      constraint.id,
      nonGoal.id,
    ]);
    expect(pack.task.record.id).toBe(task.id);
    expect(pack.related.map((item) => item.record.id)).toEqual([
      decision.id,
      evidence.id,
      component.id,
    ]);
    expect(pack.related.map((item) => item.relationshipKind)).toEqual([
      "decided_by",
      "evidenced_by",
      "implements",
    ]);
    expect(pack.related.some((item) => item.record.id === unrelatedIdea.id)).toBe(
      false,
    );
    expect(pack.sourceRevisions).toEqual(
      [...pack.stableFrame, pack.task, ...pack.related]
        .map((item) => ({
          recordId: item.record.id,
          revision: item.record.revision,
        }))
        .sort((a, b) => a.recordId.localeCompare(b.recordId)),
    );
    expect(pack).toMatchObject({
      id: "pack-1",
      projectId,
      taskId: task.id,
      projectRevision: revisionBeforePack,
      generatedAt,
      budgetTokens: 10_000,
      omissions: [],
    });
    expect(contextPackStore.get(pack.id)).toEqual(pack);
    expect(projectStore.getProject(projectId)?.revision).toBe(revisionBeforePack);
    expect(
      fixtureDatabase
        .prepare(
          `SELECT project_id, task_id, project_revision, budget_tokens,
                  estimated_tokens, created_at
           FROM context_packs
           WHERE id = ?`,
        )
        .get(pack.id),
    ).toEqual({
      project_id: projectId,
      task_id: task.id,
      project_revision: revisionBeforePack,
      budget_tokens: 10_000,
      estimated_tokens: pack.estimatedTokens,
      created_at: generatedAt,
    });
  });

  it("assembles and persists a pack from one read snapshot while another connection commits", () => {
    const {
      projectStore,
      contextPackStore,
      projectId,
    } = createFixture();
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Snapshot task",
      "Keep every item aligned with the labeled project revision.",
    );
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    const writerStore = createProjectStore(concurrentDatabase, {
      now: () => "2026-07-26T21:01:00.000Z",
      newId: () => "vision-concurrent",
    });
    let interleaved = false;
    const interleavingProjectStore: ProjectStore = {
      ...projectStore,
      getProject: (requestedProjectId) => {
        const project = projectStore.getProject(requestedProjectId);

        if (!interleaved && project) {
          interleaved = true;
          writerStore.createRecord({
            projectId,
            kind: "vision",
            status: "accepted",
            title: "Concurrent vision",
            body: "This belongs to the next project revision.",
            sourceKind: "agent",
            sourceRef: "writer-connection",
          });
        }

        return project;
      },
    };
    const service = createContextService({
      projectStore: interleavingProjectStore,
      contextPackStore,
      now: () => generatedAt,
      newId: () => "pack-snapshot",
      estimateTokens: (text) => text.length,
    });

    const pack = service.getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 10_000,
    });

    expect(pack.projectRevision).toBe(1);
    expect(pack.task.record.id).toBe(task.id);
    expect(pack.stableFrame).toEqual([]);
    expect(contextPackStore.get(pack.id)).toEqual(pack);
    expect(projectStore.getProject(projectId)?.revision).toBe(2);
    expect(projectStore.listRecords(projectId).map(({ id }) => id)).toEqual([
      task.id,
      "vision-concurrent",
    ]);
  });

  it("retains the stable frame and task when their serialized text exceeds the budget", () => {
    const { projectStore, projectId, createService } = createFixture();
    const vision = createRecord(
      projectStore,
      projectId,
      "vision",
      "accepted",
      "Vision",
      "Body",
    );
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Task",
      "Work",
    );

    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 1,
    });

    expect(pack.stableFrame).toHaveLength(1);
    expect(pack.stableFrame[0]).toMatchObject({
      record: { id: vision.id },
      mandatory: true,
      relevance: "stable_frame",
      relationshipKind: null,
    });
    expect(pack.task).toMatchObject({
      record: { id: task.id },
      mandatory: true,
      relevance: "active_task",
      relationshipKind: null,
    });
    expect(
      estimateContextItemTokens(pack.stableFrame[0]!, (text) => text.length),
    ).toBe("Vision\nBody".length);
    expect(
      estimateContextItemTokens(pack.task, (text) => text.length),
    ).toBe("Task\nWork".length);
    expect(pack.estimatedTokens).toBe(
      "Vision\nBody".length + "Task\nWork".length,
    );
    expect(pack.estimatedTokens).toBeGreaterThan(pack.budgetTokens);
  });

  it("omits an oversized candidate but still includes a later smaller candidate", () => {
    const { projectStore, projectId, createService } = createFixture();
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "T",
      "t",
    );
    const decision = createRecord(
      projectStore,
      projectId,
      "decision",
      "accepted",
      "D",
      "d",
    );
    const evidence = createRecord(
      projectStore,
      projectId,
      "evidence",
      "accepted",
      "Evidence",
      "This record is too large for the remaining budget.",
    );
    const component = createRecord(
      projectStore,
      projectId,
      "component",
      "completed",
      "C",
      "c",
    );
    const rejectedRisk = createRecord(
      projectStore,
      projectId,
      "risk",
      "rejected",
      "Rejected",
      "This is not a candidate.",
    );

    for (const [record, kind] of [
      [decision, "decided_by"],
      [evidence, "evidenced_by"],
      [component, "implements"],
      [rejectedRisk, "depends_on"],
    ] as const) {
      projectStore.createRelationship({
        projectId,
        fromRecordId: task.id,
        toRecordId: record.id,
        kind,
      });
    }

    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: "T\nt".length + "D\nd".length + "C\nc".length,
    });

    expect(pack.related.map((item) => item.record.id)).toEqual([
      decision.id,
      component.id,
    ]);
    expect(pack.estimatedTokens).toBe(
      "T\nt".length + "D\nd".length + "C\nc".length,
    );
    expect(pack.omissions).toEqual([
      {
        recordId: evidence.id,
        kind: "evidence",
        reason: "budget",
        retrievalRef: `intentarc://projects/${projectId}/records/${evidence.id}`,
      },
    ]);
    expect(pack.omissions.some(({ recordId }) => recordId === rejectedRisk.id)).toBe(
      false,
    );
  });

  it("captures the project's validated hierarchy vocabulary in each new pack", () => {
    const { projectStore, projectId, createService } = createFixture();
    projectStore.updateHierarchyVocabulary({
      projectId,
      expectedProjectRevision: 0,
      vocabulary: softwareHierarchyVocabulary,
    });
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Portable hierarchy",
      "Carry project labels with task context.",
    );

    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 1_000,
    });

    expect(pack.hierarchyVocabulary).toEqual(softwareHierarchyVocabulary);
  });

  it("keeps persisted packs immutable when the project vocabulary changes", () => {
    const {
      projectStore,
      contextPackStore,
      projectId,
      createService,
    } = createFixture();
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Immutable hierarchy",
      "Keep released context labels stable.",
    );
    const service = createService(["pack-neutral", "pack-software"]);
    const neutralPack = service.getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 1_000,
    });

    projectStore.updateHierarchyVocabulary({
      projectId,
      expectedProjectRevision: neutralPack.projectRevision,
      vocabulary: softwareHierarchyVocabulary,
    });
    const softwarePack = service.getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 1_000,
    });

    expect(contextPackStore.get(neutralPack.id)?.hierarchyVocabulary).toEqual(
      neutralHierarchyVocabulary,
    );
    expect(softwarePack.hierarchyVocabulary).toEqual(
      softwareHierarchyVocabulary,
    );
  });

  it("does not let parent links displace higher-priority context under budget", () => {
    const { projectStore, projectId, createService } = createFixture();
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "T",
      "t",
    );
    const decision = createRecord(
      projectStore,
      projectId,
      "decision",
      "accepted",
      "D",
      "d",
    );
    const parent = createRecord(
      projectStore,
      projectId,
      "milestone",
      "accepted",
      "P",
      "p",
    );
    const related = createRecord(
      projectStore,
      projectId,
      "component",
      "accepted",
      "R",
      "r",
    );

    projectStore.createRelationship({
      projectId,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });
    projectStore.createRelationship({
      projectId,
      fromRecordId: parent.id,
      toRecordId: task.id,
      kind: "parent_of",
    });
    projectStore.createRelationship({
      projectId,
      fromRecordId: task.id,
      toRecordId: related.id,
      kind: "related_to",
    });

    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: "T\nt".length + "D\nd".length,
    });

    expect(pack.related.map((item) => ({
      recordId: item.record.id,
      relationshipKind: item.relationshipKind,
    }))).toEqual([{
      recordId: decision.id,
      relationshipKind: "decided_by",
    }]);
    expect(pack.omissions.map(({ recordId }) => recordId)).toEqual([
      parent.id,
      related.id,
    ]);
  });

  it("throws InvalidTaskError without saving a pack for a non-task record", () => {
    const {
      database: fixtureDatabase,
      projectStore,
      projectId,
      createService,
    } = createFixture();
    const decision = createRecord(
      projectStore,
      projectId,
      "decision",
      "accepted",
      "Decision",
      "Not a task.",
    );

    expect(() =>
      createService().getTaskContext({
        projectId,
        taskId: decision.id,
        budgetTokens: 100,
      }),
    ).toThrow(new InvalidTaskError(decision.id));
    expect(
      fixtureDatabase.prepare("SELECT COUNT(*) AS count FROM context_packs").get(),
    ).toEqual({ count: 0 });
  });

  it("turns corrupt persisted JSON into CorruptStoredContextPackError", () => {
    const {
      database: fixtureDatabase,
      projectStore,
      contextPackStore,
      projectId,
      createService,
    } = createFixture();
    const task = createRecord(
      projectStore,
      projectId,
      "task",
      "active",
      "Task",
      "Work",
    );
    const pack = createService().getTaskContext({
      projectId,
      taskId: task.id,
      budgetTokens: 100,
    });
    fixtureDatabase
      .prepare("UPDATE context_packs SET content_json = ? WHERE id = ?")
      .run('{"id":', pack.id);

    expect(() => contextPackStore.get(pack.id)).toThrow(
      new CorruptStoredContextPackError(pack.id),
    );
  });
});
