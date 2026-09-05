import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GovernanceError,
  ProjectNotFoundError,
  type CoordinationService,
} from "../domain/index.js";
import { createChangeService } from "./change-service.js";
import { createContextService } from "./context-service.js";
import { createDestinationService } from "./destination-service.js";
import type { DocumentRegistryService } from "./document-registry-service.js";
import { createIntentArcService } from "./intentarc-service.js";
import { createOutboundContextService } from "./outbound-context-service.js";
import { createProfileService } from "./profile-service.js";
import { createProposalService } from "./proposal-service.js";
import { createProjectMapService } from "./project-map-service.js";
import { createRepositoryImportService } from "./repository-import-service.js";
import type { RepositoryRefreshService } from "./repository-refresh-service.js";
import { createOutboundSafetyEngine } from "../outbound/safety-engine.js";
import { createContextPackStore } from "../storage/context-pack-store.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { createOutboundContextStore } from "../storage/outbound-context-store.js";
import { createProfileStore } from "../storage/profile-store.js";
import { createProjectStore } from "../storage/project-store.js";
import { createRepositoryImportStore } from "../storage/repository-import-store.js";
import { createOutboundDestinationStore } from "../storage/outbound-destination-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

describe("IntentArc service", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;
  const coordinationService = {} as CoordinationService;

  afterEach(() => {
    database?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  const createService = () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const scriptedIds: Record<string, string[]> = {
      project: ["project-1"],
      record: [
        "record-vision",
        "record-active-b",
        "record-blocked-b",
        "record-active-a",
        "record-completed",
        "record-decision",
      ],
      context: ["context-1"],
    };
    const counters: Record<string, number> = {};
    const newId = (prefix: string): string =>
      scriptedIds[prefix]?.shift() ??
      `${prefix}-${counters[prefix] = (counters[prefix] ?? 0) + 1}`;
    const projectStore = createProjectStore(database, {
      now: () => "2026-07-26T12:00:00.000Z",
      newId,
    });
    const profileStore = createProfileStore(database);
    const governanceStore = createGovernanceStore(database, { newId });
    const contextPackStore = createContextPackStore(database);
    const contextService = createContextService({
      projectStore,
      contextPackStore,
      now: () => "2026-07-26T12:00:01.000Z",
      newId: () => newId("context"),
      estimateTokens: (text) => text.length,
    });
    const profileService = createProfileService({
      profileStore,
      now: () => "2026-07-26T12:00:00.000Z",
      newId,
    });
    const changeService = createChangeService({
      profileStore,
      governanceStore,
      now: () => "2026-07-26T12:00:00.000Z",
    });
    const proposalService = createProposalService({
      governanceStore,
      now: () => "2026-07-26T12:00:00.000Z",
    });
    const destinationService = createDestinationService({
      destinationStore: createOutboundDestinationStore(database),
      profileStore,
      now: () => "2026-07-26T12:00:00.000Z",
      newId,
    });
    const outbound = createOutboundContextService({
      contextService,
      contextPackStore,
      profileService,
      destinationService,
      outboundStore: createOutboundContextStore(database),
      safetyEngine: createOutboundSafetyEngine(),
      now: () => "2026-07-26T12:00:00.000Z",
      newId,
    });
    const repositoryRefresh = {
      start: vi.fn(),
      get: vi.fn(() => null),
      sourceStatus: vi.fn(() => null),
      updateSelection: vi.fn(),
      cancel: vi.fn(),
    } satisfies RepositoryRefreshService;
    const documents = {
      list: vi.fn(() => ({
        documents: [],
        facets: { documentKinds: [], formats: [], roles: [], freshness: [] },
      })),
      get: vi.fn(),
      read: vi.fn(),
      readPreview: vi.fn(),
      resolveExternalOpen: vi.fn(),
    } satisfies DocumentRegistryService;
    const projectMap = createProjectMapService({
      projectStore,
      repositoryStore: {
        getCurrentSnapshot: () => null,
        listObservations: () => [],
        listLinks: () => [],
      },
    });

    return createIntentArcService({
      projectStore,
      contextService,
      profileService,
      changeService,
      proposalService,
      governanceStore,
      destinationService,
      outbound,
      repositoryImportService: createRepositoryImportService({
        store: createRepositoryImportStore(database, {
          now: () => "2026-07-26T12:00:00.000Z",
          newId,
        }),
      }),
      repositoryRefreshService: repositoryRefresh,
      documentRegistryService: documents,
      projectMapService: projectMap,
      coordinationService,
    });
  };

  it("exposes the injected coordination service without exposing its store", () => {
    const service = createService();

    expect(service.coordination).toBe(coordinationService);
    expect(service).not.toHaveProperty("coordinationStore");
  });

  it("exposes repository refresh orchestration without exposing its store", () => {
    const service = createService();

    expect(service.repositoryRefresh.get("project-1")).toBeNull();
    expect(service).not.toHaveProperty("repositoryIndexStore");
  });

  it("exposes read-only documentation orchestration without exposing repository storage", () => {
    const service = createService();

    expect(service.documents.list("project-1", {})).toEqual({
      documents: [],
      facets: { documentKinds: [], formats: [], roles: [], freshness: [] },
    });
    expect(service).not.toHaveProperty("repositoryIndexStore");
  });

  it("exposes the authoritative project map without exposing either backing store", () => {
    const service = createService();
    const createdProject = service.createProject({ name: "IntentArc" });
    const outcome = service.createRecord({
      projectId: createdProject.id,
      kind: "outcome",
      status: "active",
      title: "Structured knowledge",
      body: "Expose focused authoritative hierarchy.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(service.projectMap.getProjectMap(createdProject.id, outcome.id).selectedRecordId)
      .toBe(outcome.id);
    expect(service).not.toHaveProperty("projectStore");
    expect(service).not.toHaveProperty("repositoryIndexStore");
  });

  it("updates hierarchy vocabulary through one revision-checked human service operation", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });

    expect(service.updateHierarchyVocabulary({
      projectId: project.id,
      expectedProjectRevision: 0,
      vocabulary: {
        preset: "software",
        outcome: "Product outcome",
        initiative: "Epic",
        deliverable: "Feature",
        milestone: "Milestone",
        task: "Story or Task",
        nestedTask: "Subtask",
      },
    })).toEqual({
      projectRevision: 1,
      hierarchyVocabulary: {
        preset: "software",
        outcome: "Product outcome",
        initiative: "Epic",
        deliverable: "Feature",
        milestone: "Milestone",
        task: "Story or Task",
        nestedTask: "Subtask",
      },
    });
    expect(service.getProjectSummary(project.id).project.revision).toBe(1);
    expect(service.projectMap.getProjectMap(project.id).hierarchyVocabulary.preset)
      .toBe("software");
  });

  it("summarizes every record kind while showing only active and blocked tasks by status then ID", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });

    service.createRecord({
      projectId: project.id,
      kind: "vision",
      status: "accepted",
      title: "Vision",
      body: "A durable plan.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Active B",
      body: "Second active task.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "blocked",
      title: "Blocked B",
      body: "Blocked task.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Active A",
      body: "First active task.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "completed",
      title: "Completed",
      body: "Completed task.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Decision",
      body: "An accepted decision.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(service.getProjectSummary(project.id)).toEqual({
      project: expect.objectContaining({ id: "project-1", revision: 6 }),
      recordsByKind: { vision: 1, task: 4, decision: 1 },
      activeTasks: [
        { id: "record-active-a", title: "Active A", status: "active" },
        { id: "record-active-b", title: "Active B", status: "active" },
        { id: "record-blocked-b", title: "Blocked B", status: "blocked" },
      ],
    });
  });

  it("rejects a summary request for a project that does not exist", () => {
    const service = createService();

    expect(() => service.getProjectSummary("missing-project")).toThrow(
      new ProjectNotFoundError("missing-project"),
    );
  });

  it("uses the injected context service to create and persist a task context pack", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });
    const task = service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Deliver facade",
      body: "Expose one shared application service.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(
      service.getTaskContext({
        projectId: project.id,
        taskId: task.id,
        budgetTokens: 100,
      }),
    ).toMatchObject({
      id: "context-1",
      projectId: project.id,
      taskId: task.id,
      generatedAt: "2026-07-26T12:00:01.000Z",
      task: { record: { id: task.id } },
    });
  });

  it("exposes profile-scoped destination administration", () => {
    const service = createService();
    const profile = service.profiles.createProfile({ name: "Build agent" });

    const destination = service.destinations.set({
      profileId: profile.profile.id,
      clientLabel: "Claude Code laptop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: null,
      accountBoundaryLabel: "personal subscription",
      dataBoundary: "remote",
    });

    expect(service.destinations.getCurrent(profile.profile.id)).toEqual(destination);
  });

  it("exposes outbound request orchestration on the shared service facade", () => {
    const service = createService();

    expect(service.outbound.list({})).toEqual([]);
  });

  it("routes human create, update, and link writes through governed changes while preserving legacy return shapes", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });
    const task = service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Wire governance",
      body: "Use one authoritative write boundary.",
      sourceKind: "human",
      sourceRef: null,
    });
    const updated = service.updateRecord({
      projectId: project.id,
      recordId: task.id,
      expectedRecordRevision: 1,
      patch: {
        status: "completed",
        title: "Governance wired",
      },
    });
    const decision = service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "One write boundary",
      body: "All authoritative writes enter the change service.",
      sourceKind: "human",
      sourceRef: null,
    });
    const relationship = service.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
      expectedProjectRevision: 3,
    });
    expect(() => service.createRelationship({
      projectId: project.id,
      fromRecordId: decision.id,
      toRecordId: task.id,
      kind: "related_to",
      expectedProjectRevision: 3,
    })).toThrowError(expect.objectContaining({ code: "project_revision_conflict" }));
    const removed = service.removeRelationship({
      projectId: project.id,
      relationshipId: relationship.id,
      expectedProjectRevision: 4,
    });

    expect(task).toEqual({
      id: "record-vision",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Wire governance",
      body: "Use one authoritative write boundary.",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(updated).toEqual({
      ...task,
      status: "completed",
      title: "Governance wired",
      revision: 2,
    });
    expect(relationship).toEqual({
      id: "relationship-1",
      projectId: "project-1",
      fromRecordId: "record-vision",
      toRecordId: "record-active-b",
      kind: "decided_by",
      createdAt: "2026-07-26T12:00:00.000Z",
    });
    expect(removed).toEqual(relationship);
    expect(
      service
        .listAuditEvents({ projectId: project.id })
        .filter(({ actionCategory }) => actionCategory === "change_applied"),
    ).toHaveLength(5);
  });

  it("creates a project and its local-human administrative audit event atomically", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });

    expect(service.listAuditEvents({
      projectId: project.id,
      actionCategory: "project_created",
    })).toEqual([{
      id: "audit-1",
      projectId: "project-1",
      actorType: "local_human",
      profileId: null,
      authorityMode: "human",
      scopeDecision: "human_admin",
      actionCategory: "project_created",
      targetId: "project-1",
      idempotencyKey: null,
      revisionBefore: null,
      revisionAfter: 0,
      outcome: "applied",
      reason: null,
      createdAt: "2026-07-26T12:00:00.000Z",
    }]);
  });

  it("rolls project creation back when its audit event cannot be inserted", () => {
    const service = createService();
    database!.prepare(`
      INSERT INTO audit_events (
        id, project_id, actor_type, profile_id, authority_mode, scope_decision,
        action_category, target_id, idempotency_key, revision_before,
        revision_after, outcome, reason, created_at
      ) VALUES (
        'audit-1', NULL, 'local_human', NULL, 'human', 'human_admin',
        'existing_event', NULL, NULL, NULL, NULL, 'applied', NULL,
        '2026-07-26T11:00:00.000Z'
      )
    `).run();

    expect(() => service.createProject({ name: "Must roll back" })).toThrow();
    expect(service.listProjects()).toEqual([]);
  });

  it("exposes profile-owned change history and hides missing or mismatched changes behind a safe error", () => {
    const service = createService();
    const project = service.createProject({ name: "IntentArc" });
    const owner = service.profiles.createProfile({
      name: "Owner",
      projectId: project.id,
    });
    const other = service.profiles.createProfile({ name: "Other profile" });
    const principal = service.profiles.authenticate({
      profileId: owner.profile.id,
      token: owner.token,
    })!;
    const submission = service.submitChangeSet(principal, {
      projectId: project.id,
      baseProjectRevision: 0,
      idempotencyKey: "profile-change-1",
      rationale: "Propose a governed task.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-task",
        type: "create_record",
        kind: "task",
        status: "provisional",
        title: "Governed task",
        body: "This proposal must remain visible to its owner.",
      }],
    });

    expect(submission).toMatchObject({
      outcome: "proposed",
      changeId: "change-1",
      proposalId: "proposal-1",
    });
    database!.exec(`
      INSERT INTO repository_sources VALUES (
        'source-1', '${project.id}', 'C:/repositories/intentarc', NULL,
        'repository-1', 'available', NULL,
        '2026-07-26T12:00:00.000Z', '2026-07-26T12:00:00.000Z'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-candidate', 'source-1', '${project.id}', 'candidate', NULL, 0,
        'main', '${"a".repeat(40)}', '${"b".repeat(64)}', '1', '1',
        '{}', '{}', '{}', '2026-07-26T12:00:00.000Z', NULL, NULL
      );
    `);
    expect(service.proposals.createRepositoryRefresh({
      projectId: project.id,
      repositorySnapshotId: "snapshot-candidate",
      baseProjectRevision: 0,
      rationale: "Local repository refresh proposal.",
      operations: [{
        operationId: "create-refresh-decision",
        type: "create_record",
        kind: "decision",
        status: "provisional",
        title: "Repository meaning",
        body: "This local proposal has no profile owner.",
      }],
    })).toMatchObject({
      id: "proposal-2",
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "snapshot-candidate",
      },
    });
    expect(service.listMyChanges(owner.profile.id, project.id)).toEqual([
      expect.objectContaining({
        changeId: "change-1",
        profileId: owner.profile.id,
        projectId: project.id,
        outcome: "proposed",
      }),
    ]);
    expect(service.getMyChange(owner.profile.id, "change-1")).toMatchObject({
      changeId: "change-1",
      idempotencyKey: "profile-change-1",
      proposal: { id: "proposal-1" },
    });
    expect(service.proposals.get("proposal-1")).toMatchObject({
      id: "proposal-1",
      origin: { type: "profile", profileId: owner.profile.id },
    });

    for (const read of [
      () => service.getMyChange(other.profile.id, "change-1"),
      () => service.getMyChange(owner.profile.id, "missing-change"),
    ]) {
      expect(read).toThrowError(
        expect.objectContaining<Partial<GovernanceError>>({
          code: "validation_failed",
          message: "Change not found",
        }),
      );
    }
  });
});
