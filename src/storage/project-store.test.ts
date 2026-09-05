import { afterEach, describe, expect, it } from "vitest";
import {
  GovernanceError,
  type HierarchyVocabulary,
  ProjectNotFoundError,
  RecordNotFoundError,
  RelationshipAlreadyExistsError,
} from "../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { createProjectStore } from "./project-store.js";

describe("project store", () => {
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

  it("creates projects at revision zero and lists them by creation time then ID", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-b", "audit-1", "project-a", "audit-2"];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });

    const first = store.createProject({
      name: "Second by ID",
      primaryRepositoryPath: "C:\\projects\\second",
    });
    store.createProject({ name: "First by ID" });

    expect(first).toEqual({
      id: "project-b",
      name: "Second by ID",
      revision: 0,
      primaryRepositoryPath: "C:\\projects\\second",
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(store.listProjects().map((project) => project.id)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(store.getProject(first.id)?.primaryRepositoryPath).toBe(
      "C:\\projects\\second",
    );
  });

  it("persists exact default and supplied hierarchy vocabularies across a reopen", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-neutral", "audit-neutral", "project-software", "audit-software"];
    const dependencies = {
      now: () => "2026-08-23T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    };
    const store = createProjectStore(database, dependencies);
    const software: HierarchyVocabulary = {
      preset: "software",
      outcome: "Product outcome",
      initiative: "Epic",
      deliverable: "Feature",
      milestone: "Milestone",
      task: "Story or Task",
      nestedTask: "Subtask",
    };
    const neutral = store.createProject({ name: "Neutral" });
    const configured = store.createProject({
      name: "Software",
      hierarchyVocabulary: software,
    });

    expect(store.getHierarchyVocabulary(neutral.id)).toEqual({
      preset: "neutral",
      outcome: "Outcome",
      initiative: "Initiative",
      deliverable: "Deliverable",
      milestone: "Milestone",
      task: "Work item",
      nestedTask: "Subtask",
    });
    expect(store.getHierarchyVocabulary(configured.id)).toEqual(software);

    database.close();
    database = openDatabase(temporaryDatabase.path);
    const reopened = createProjectStore(database, dependencies);

    expect(reopened.getHierarchyVocabulary(neutral.id)).toEqual({
      preset: "neutral",
      outcome: "Outcome",
      initiative: "Initiative",
      deliverable: "Deliverable",
      milestone: "Milestone",
      task: "Work item",
      nestedTask: "Subtask",
    });
    expect(reopened.getHierarchyVocabulary(configured.id)).toEqual(software);
    expect(() => reopened.getHierarchyVocabulary("missing-project"))
      .toThrow(new ProjectNotFoundError("missing-project"));
  });

  it("updates one canonical vocabulary at the expected revision and leaves stale state untouched", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const counters: Record<string, number> = {};
    const store = createProjectStore(database, {
      now: () => "2026-08-23T12:30:00.000Z",
      newId: (prefix) => `${prefix}-${counters[prefix] = (counters[prefix] ?? 0) + 1}`,
    });
    const project = store.createProject({ name: "Vocabulary authority" });
    const initiative = store.createRecord({
      projectId: project.id,
      kind: "initiative",
      status: "accepted",
      title: "Initiative",
      body: "Preserve this governed record.",
      sourceKind: "human",
      sourceRef: null,
    });
    const deliverable = store.createRecord({
      projectId: project.id,
      kind: "deliverable",
      status: "accepted",
      title: "Deliverable",
      body: "Preserve this governed child.",
      sourceKind: "human",
      sourceRef: null,
    });
    store.createRelationship({
      projectId: project.id,
      fromRecordId: initiative.id,
      toRecordId: deliverable.id,
      kind: "parent_of",
    });
    const software: HierarchyVocabulary = {
      preset: "software",
      outcome: "Product outcome",
      initiative: "Epic",
      deliverable: "Feature",
      milestone: "Milestone",
      task: "Story or Task",
      nestedTask: "Subtask",
    };

    expect(store.updateHierarchyVocabulary({
      projectId: project.id,
      expectedProjectRevision: 3,
      vocabulary: software,
    })).toEqual({
      projectRevision: 4,
      hierarchyVocabulary: software,
    });
    const beforeStale = {
      project: store.getProject(project.id),
      vocabulary: store.getHierarchyVocabulary(project.id),
      records: store.listRecords(project.id),
      relationships: store.listRelationships(project.id),
      audits: database.prepare(
        "SELECT action_category, revision_before, revision_after FROM audit_events ORDER BY rowid",
      ).all(),
      proposals: database.prepare("SELECT COUNT(*) AS count FROM change_proposals").get(),
    };

    expect(() => store.updateHierarchyVocabulary({
      projectId: project.id,
      expectedProjectRevision: 3,
      vocabulary: {
        preset: "simple",
        outcome: "Outcome",
        initiative: "Initiative",
        deliverable: "Deliverable",
        milestone: "Milestone",
        task: "Task",
        nestedTask: "Subtask",
      },
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      name: "GovernanceError",
      code: "project_revision_conflict",
    }));
    expect({
      project: store.getProject(project.id),
      vocabulary: store.getHierarchyVocabulary(project.id),
      records: store.listRecords(project.id),
      relationships: store.listRelationships(project.id),
      audits: database.prepare(
        "SELECT action_category, revision_before, revision_after FROM audit_events ORDER BY rowid",
      ).all(),
      proposals: database.prepare("SELECT COUNT(*) AS count FROM change_proposals").get(),
    }).toEqual(beforeStale);
    expect(beforeStale.audits).toContainEqual({
      action_category: "hierarchy_vocabulary_updated",
      revision_before: 3,
      revision_after: 4,
    });
  });

  it("creates an accepted record with a revision snapshot in one transaction", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-1", "audit-1", "record-1", "record-2"];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "IntentArc" });

    const record = store.createRecord({
      projectId: project.id,
      kind: "vision",
      status: "accepted",
      title: "Persist authoritative project state",
      body: "Store project records with immutable revision snapshots.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(record.revision).toBe(1);
    expect(store.getProject(project.id)?.revision).toBe(1);

    const revision = database
      .prepare(
        "SELECT snapshot_json FROM project_record_revisions WHERE record_id = ? AND revision = 1",
      )
      .get(record.id) as { snapshot_json: string };

    expect(JSON.parse(revision.snapshot_json)).toEqual(record);

    expect(() =>
      store.createRecord({
        projectId: "missing-project",
        kind: "vision",
        status: "accepted",
        title: "Missing project record",
        body: "This transaction must be rolled back.",
        sourceKind: "human",
        sourceRef: null,
      }),
    ).toThrow(new ProjectNotFoundError("missing-project"));
    expect(store.getRecord("missing-project", "record-2")).toBeNull();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM project_records").get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM project_record_revisions")
        .get(),
    ).toEqual({ count: 1 });
    expect(store.getProject(project.id)?.revision).toBe(1);
  });

  it("retries a complete record write after a concurrent connection invalidates its read snapshot", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    concurrentDatabase = openDatabase(temporaryDatabase.path);
    const readerIds = [
      "project-1",
      "audit-1",
      "record-reader-1",
      "record-reader-2",
    ];
    let interleaveWrite = false;
    const writerStore = createProjectStore(concurrentDatabase, {
      now: () => "2026-07-26T12:01:00.000Z",
      newId: () => "record-writer",
    });
    const readerStore = createProjectStore(database, {
      now: () => {
        if (interleaveWrite) {
          interleaveWrite = false;
          writerStore.createRecord({
            projectId: "project-1",
            kind: "evidence",
            status: "accepted",
            title: "Concurrent evidence",
            body: "Commit after the reader establishes its snapshot.",
            sourceKind: "agent",
            sourceRef: "writer-connection",
          });
        }

        return "2026-07-26T12:02:00.000Z";
      },
      newId: () => readerIds.shift() ?? "unexpected-reader-id",
    });
    const project = readerStore.createProject({ name: "IntentArc" });
    interleaveWrite = true;

    const readerRecord = readerStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Reader task",
      body: "Retry the whole write against a fresh snapshot.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(readerRecord.id).toBe("record-reader-2");
    expect(
      readerStore.listRecords(project.id).map(({ id }) => id),
    ).toEqual(["record-writer", "record-reader-2"]);
    expect(readerStore.getProject(project.id)?.revision).toBe(2);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM project_record_revisions")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("creates relationships that are queryable from either endpoint in deterministic order", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = [
      "project-1",
      "audit-1",
      "task-1",
      "decision-1",
      "component-1",
      "relationship-1",
      "relationship-2",
      "relationship-3",
    ];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "IntentArc" });
    const task = store.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Persist relationships",
      body: "Link project records explicitly.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = store.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Use explicit links",
      body: "Relationships are first-class records.",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = store.createRecord({
      projectId: project.id,
      kind: "component",
      status: "active",
      title: "Project store",
      body: "Persists project data.",
      sourceKind: "human",
      sourceRef: null,
    });

    const decidedBy = store.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });
    expect(store.getProject(project.id)?.revision).toBe(4);
    const implementsRelationship = store.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: component.id,
      kind: "implements",
    });
    expect(store.getProject(project.id)?.revision).toBe(5);
    const reverseImplementsRelationship = store.createRelationship({
      projectId: project.id,
      fromRecordId: component.id,
      toRecordId: task.id,
      kind: "implements",
    });

    expect(store.listRelationshipsForRecord(project.id, task.id)).toEqual([
      decidedBy,
      reverseImplementsRelationship,
      implementsRelationship,
    ]);
    expect(store.listRelationshipsForRecord(project.id, decision.id)).toEqual([
      decidedBy,
    ]);
    expect(store.listRelationshipsForRecord(project.id, component.id)).toEqual([
      reverseImplementsRelationship,
      implementsRelationship,
    ]);
    expect(store.getProject(project.id)?.revision).toBe(6);
  });

  it("retries a complete relationship write after a concurrent connection invalidates its read snapshot", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    concurrentDatabase = openDatabase(temporaryDatabase.path);
    const readerIds = [
      "project-1",
      "audit-1",
      "task-1",
      "decision-1",
      "component-1",
      "relationship-reader-1",
      "relationship-reader-2",
    ];
    let interleaveWrite = false;
    const writerStore = createProjectStore(concurrentDatabase, {
      now: () => "2026-07-26T12:03:00.000Z",
      newId: () => "relationship-writer",
    });
    const readerStore = createProjectStore(database, {
      now: () => {
        if (interleaveWrite) {
          interleaveWrite = false;
          writerStore.createRelationship({
            projectId: "project-1",
            fromRecordId: "task-1",
            toRecordId: "component-1",
            kind: "implements",
          });
        }

        return "2026-07-26T12:04:00.000Z";
      },
      newId: () => readerIds.shift() ?? "unexpected-reader-id",
    });
    const project = readerStore.createProject({ name: "IntentArc" });
    const task = readerStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Reader task",
      body: "Link after a concurrent relationship commit.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = readerStore.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Retry complete transactions",
      body: "A stale snapshot must restart from the first read.",
      sourceKind: "human",
      sourceRef: null,
    });
    readerStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "active",
      title: "Project store",
      body: "Own the SQLite transaction boundary.",
      sourceKind: "human",
      sourceRef: null,
    });
    interleaveWrite = true;

    const readerRelationship = readerStore.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });

    expect(readerRelationship.id).toBe("relationship-reader-2");
    expect(
      readerStore
        .listRelationshipsForRecord(project.id, task.id)
        .map(({ id }) => id),
    ).toEqual(["relationship-reader-2", "relationship-writer"]);
    expect(readerStore.getProject(project.id)?.revision).toBe(5);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM record_relationships")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("rejects cross-project and duplicate relationships without incrementing the project revision", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = [
      "project-1",
      "audit-1",
      "project-2",
      "audit-2",
      "task-1",
      "decision-1",
      "other-task-1",
      "relationship-1",
    ];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "IntentArc" });
    const otherProject = store.createProject({ name: "Other" });
    const task = store.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Persist relationships",
      body: "Link project records explicitly.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = store.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Use explicit links",
      body: "Relationships are first-class records.",
      sourceKind: "human",
      sourceRef: null,
    });
    const otherTask = store.createRecord({
      projectId: otherProject.id,
      kind: "task",
      status: "active",
      title: "Do not cross projects",
      body: "Relationships stay within their project.",
      sourceKind: "human",
      sourceRef: null,
    });

    const revisionBeforeFailures = store.getProject(project.id)?.revision;

    expect(() =>
      store.createRelationship({
        projectId: project.id,
        fromRecordId: task.id,
        toRecordId: otherTask.id,
        kind: "implements",
      }),
    ).toThrow(new RecordNotFoundError("other-task-1"));
    expect(store.getProject(project.id)?.revision).toBe(revisionBeforeFailures);

    store.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });
    const revisionBeforeDuplicate = store.getProject(project.id)?.revision;

    expect(() =>
      store.createRelationship({
        projectId: project.id,
        fromRecordId: task.id,
        toRecordId: decision.id,
        kind: "decided_by",
      }),
    ).toThrow(
      new RelationshipAlreadyExistsError("task-1", "decision-1", "decided_by"),
    );
    expect(store.getProject(project.id)?.revision).toBe(revisionBeforeDuplicate);
  });

  it("rejects missing relationship endpoints without incrementing the project revision", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-1", "audit-1", "task-1", "decision-1"];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "IntentArc" });
    const task = store.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Persist relationships",
      body: "Link project records explicitly.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = store.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Use explicit links",
      body: "Relationships are first-class records.",
      sourceKind: "human",
      sourceRef: null,
    });
    const revisionBeforeFailures = store.getProject(project.id)?.revision;

    expect(() =>
      store.createRelationship({
        projectId: project.id,
        fromRecordId: "missing-from-record",
        toRecordId: decision.id,
        kind: "decided_by",
      }),
    ).toThrow(new RecordNotFoundError("missing-from-record"));
    expect(store.getProject(project.id)?.revision).toBe(revisionBeforeFailures);

    expect(() =>
      store.createRelationship({
        projectId: project.id,
        fromRecordId: task.id,
        toRecordId: "missing-to-record",
        kind: "decided_by",
      }),
    ).toThrow(new RecordNotFoundError("missing-to-record"));
    expect(store.getProject(project.id)?.revision).toBe(revisionBeforeFailures);
  });

  it("rethrows an unexpected relationship primary-key constraint without incrementing the project revision", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = [
      "project-1",
      "audit-1",
      "task-1",
      "decision-1",
      "component-1",
      "relationship-1",
      "relationship-1",
    ];
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "IntentArc" });
    const task = store.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Persist relationships",
      body: "Link project records explicitly.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = store.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Use explicit links",
      body: "Relationships are first-class records.",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = store.createRecord({
      projectId: project.id,
      kind: "component",
      status: "active",
      title: "Project store",
      body: "Persists project data.",
      sourceKind: "human",
      sourceRef: null,
    });

    store.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
    });
    const revisionBeforeFailure = store.getProject(project.id)?.revision;
    let thrown: unknown;

    try {
      store.createRelationship({
        projectId: project.id,
        fromRecordId: task.id,
        toRecordId: component.id,
        kind: "implements",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      message: "UNIQUE constraint failed: record_relationships.id",
    });
    expect(thrown).not.toBeInstanceOf(RelationshipAlreadyExistsError);
    expect(store.getProject(project.id)?.revision).toBe(revisionBeforeFailure);
  });

  it("lists every project relationship without leaking another project", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let generatedId = 0;
    const store = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId: (prefix) => `${prefix}-${generatedId += 1}`,
    });
    const project = store.createProject({ name: "IntentArc" });
    const other = store.createProject({ name: "Other" });
    const parent = store.createRecord({
      projectId: project.id, kind: "outcome", status: "active", title: "Outcome",
      body: "Outcome", sourceKind: "human", sourceRef: null,
    });
    const child = store.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Task",
      body: "Task", sourceKind: "human", sourceRef: null,
    });
    const otherParent = store.createRecord({
      projectId: other.id, kind: "outcome", status: "active", title: "Other outcome",
      body: "Other", sourceKind: "human", sourceRef: null,
    });
    const otherChild = store.createRecord({
      projectId: other.id, kind: "task", status: "active", title: "Other task",
      body: "Other", sourceKind: "human", sourceRef: null,
    });
    const relationship = store.createRelationship({
      projectId: project.id,
      fromRecordId: parent.id,
      toRecordId: child.id,
      kind: "parent_of",
    });
    store.createRelationship({
      projectId: other.id,
      fromRecordId: otherParent.id,
      toRecordId: otherChild.id,
      kind: "parent_of",
    });

    expect(store.listRelationships(project.id)).toEqual([relationship]);
  });

  it("rejects either non-hierarchy parent_of endpoint without mutating governed state", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let generatedId = 0;
    const store = createProjectStore(database, {
      now: () => "2026-08-24T12:00:00.000Z",
      newId: (prefix) => `${prefix}-${generatedId += 1}`,
    });
    const project = store.createProject({ name: "Hierarchy authority" });
    const task = store.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Task",
      body: "A valid hierarchy endpoint.", sourceKind: "human", sourceRef: null,
    });
    const decision = store.createRecord({
      projectId: project.id, kind: "decision", status: "accepted", title: "Decision",
      body: "An informational record.", sourceKind: "human", sourceRef: null,
    });
    const before = {
      project: store.getProject(project.id),
      relationships: store.listRelationships(project.id),
      audits: database.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
    };

    for (const [fromRecordId, toRecordId] of [
      [decision.id, task.id],
      [task.id, decision.id],
    ] as const) {
      expect(() => store.createRelationship({
        projectId: project.id,
        fromRecordId,
        toRecordId,
        kind: "parent_of",
      })).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    }

    expect({
      project: store.getProject(project.id),
      relationships: store.listRelationships(project.id),
      audits: database.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
    }).toEqual(before);
  });

  it("locates and detaches one registered repository through audited expected-revision changes", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = [
      "project-1",
      "audit-1",
      "audit-locate",
      "audit-detach",
      "audit-attach",
    ];
    const store = createProjectStore(database, {
      now: () => "2026-08-02T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({
      name: "IntentArc",
      primaryRepositoryPath: "C:/old/repository",
    });
    database.prepare(`
      INSERT INTO repository_sources (
        id, project_id, root, canonical_subpath, repository_identity, status,
        current_snapshot_id, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'available', NULL, ?, ?)
    `).run(
      "repository-source-1",
      project.id,
      "C:/old/repository",
      "git:stable",
      "2026-08-02T12:00:00.000Z",
      "2026-08-02T12:00:00.000Z",
    );

    expect(store.locateRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 0,
      root: "C:/new/repository",
      repositoryIdentity: "git:stable",
    })).toMatchObject({ revision: 1, primaryRepositoryPath: "C:/new/repository" });
    expect(database.prepare(
      "SELECT root, status FROM repository_sources WHERE project_id = ?",
    ).get(project.id)).toEqual({ root: "C:/new/repository", status: "available" });

    expect(() => store.detachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 0,
    })).toThrow(expect.objectContaining({
      name: "RepositorySourceRevisionConflictError",
    }));
    expect(store.detachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 1,
    })).toMatchObject({ revision: 2, primaryRepositoryPath: null });
    expect(database.prepare(
      "SELECT root, status FROM repository_sources WHERE project_id = ?",
    ).get(project.id)).toEqual({ root: "C:/new/repository", status: "detached" });
    expect(store.attachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 2,
      root: "C:/replacement/repository",
      canonicalSubpath: null,
      repositoryIdentity: "git:replacement",
    })).toMatchObject({ revision: 3, primaryRepositoryPath: "C:/replacement/repository" });
    expect(database.prepare(
      "SELECT root, repository_identity, status FROM repository_sources WHERE project_id = ?",
    ).get(project.id)).toEqual({
      root: "C:/replacement/repository",
      repository_identity: "git:replacement",
      status: "available",
    });
    expect(database.prepare(`
      SELECT action_category, revision_before, revision_after
      FROM audit_events
      WHERE action_category LIKE 'repository_source_%'
      ORDER BY revision_before
    `).all()).toEqual([
      {
        action_category: "repository_source_located",
        revision_before: 0,
        revision_after: 1,
      },
      {
        action_category: "repository_source_detached",
        revision_before: 1,
        revision_after: 2,
      },
      {
        action_category: "repository_source_attached",
        revision_before: 2,
        revision_after: 3,
      },
    ]);
  });

  it("attaches one verified repository to the same expected-revision project", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-1", "audit-created", "repository-source-1", "audit-attached"];
    const store = createProjectStore(database, {
      now: () => "2026-08-02T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({ name: "Attach target" });

    expect(store.attachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 0,
      root: "C:/verified/repository",
      canonicalSubpath: null,
      repositoryIdentity: "git:verified",
    })).toMatchObject({
      id: project.id,
      revision: 1,
      primaryRepositoryPath: "C:/verified/repository",
    });
    expect(database.prepare(`
      SELECT id, project_id, root, canonical_subpath, repository_identity, status
      FROM repository_sources WHERE project_id = ?
    `).get(project.id)).toEqual({
      id: "repository-source-1",
      project_id: project.id,
      root: "C:/verified/repository",
      canonical_subpath: null,
      repository_identity: "git:verified",
      status: "available",
    });
    expect(database.prepare(`
      SELECT action_category, revision_before, revision_after
      FROM audit_events WHERE action_category = 'repository_source_attached'
    `).get()).toEqual({
      action_category: "repository_source_attached",
      revision_before: 0,
      revision_after: 1,
    });
    expect(() => store.attachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 0,
      root: "C:/other/repository",
      canonicalSubpath: null,
      repositoryIdentity: "git:other",
    })).toThrow(expect.objectContaining({ name: "RepositorySourceRevisionConflictError" }));
    expect(store.getProject(project.id)?.primaryRepositoryPath)
      .toBe("C:/verified/repository");
  });

  it("marks a registered source unavailable without changing project authority and audits once", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["project-1", "audit-1", "audit-unavailable", "audit-reactivated"];
    const store = createProjectStore(database, {
      now: () => "2026-08-02T12:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const project = store.createProject({
      name: "IntentArc",
      primaryRepositoryPath: "C:/missing/repository",
    });
    database.prepare(`
      INSERT INTO repository_sources (
        id, project_id, root, canonical_subpath, repository_identity, status,
        current_snapshot_id, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'available', NULL, ?, ?)
    `).run(
      "repository-source-1",
      project.id,
      "C:/missing/repository",
      "git:stable",
      "2026-08-02T12:00:00.000Z",
      "2026-08-02T12:00:00.000Z",
    );

    const claim = {
      id: "repository-source-1",
      projectId: project.id,
      root: "C:/missing/repository",
      canonicalSubpath: null,
      repositoryIdentity: "git:stable",
      status: "available" as const,
      currentSnapshotId: null,
      expectedProjectRevision: 0,
    };
    expect(store.markRepositorySourceUnavailable(claim)).toBe("changed");
    expect(store.markRepositorySourceUnavailable(claim)).toBe("already_unavailable");
    expect(store.markRepositorySourceUnavailable({
      ...claim,
      root: "C:/stale/repository",
    })).toBe("stale");
    expect(store.getProject(project.id)).toEqual(project);
    expect(database.prepare(`
      SELECT root, status, current_snapshot_id
      FROM repository_sources
      WHERE project_id = ?
    `).get(project.id)).toEqual({
      root: "C:/missing/repository",
      status: "unavailable",
      current_snapshot_id: null,
    });
    expect(database.prepare(`
      SELECT action_category, revision_before, revision_after
      FROM audit_events
      WHERE action_category = 'repository_source_unavailable'
    `).all()).toEqual([{
      action_category: "repository_source_unavailable",
      revision_before: 0,
      revision_after: 0,
    }]);
    expect(store.reactivateRepositorySource({
      ...claim,
      status: "unavailable",
    })).toBe(true);
    expect(store.reactivateRepositorySource({
      ...claim,
      status: "unavailable",
    })).toBe(false);
    expect(database.prepare(`
      SELECT status FROM repository_sources WHERE project_id = ?
    `).get(project.id)).toEqual({ status: "available" });
    expect(database.prepare(`
      SELECT action_category, revision_before, revision_after
      FROM audit_events
      WHERE action_category = 'repository_source_reactivated'
    `).all()).toEqual([{
      action_category: "repository_source_reactivated",
      revision_before: 0,
      revision_after: 0,
    }]);
  });
});
