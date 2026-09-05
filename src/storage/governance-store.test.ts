import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  GovernanceError,
  RelationshipAlreadyExistsError,
  type AuthenticatedProfile,
  type ChangeOperation,
  type ProjectRecord,
  type RecordRelationship,
} from "../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { createProfileStore } from "./profile-store.js";
import { serializeIdeaCaptureReplayPayload } from "./human-change-replay.js";
import {
  type AuditEventRow,
  mapAuditEventRow,
} from "./governance-mappers.js";
import {
  createGovernanceStore,
  type ApplyHumanChangeCommand,
  type ApplyPreparedChangeSetCommand,
  type ApplyDirectCommand,
  type CreateRepositoryRefreshProposalCommand,
  type CreateProposalCommand,
  type PreparedChangeOperation,
  type PreparedChangeSet,
  type SubmissionResult,
} from "./governance-store.js";

const timestamp = "2026-07-27T12:00:00.000Z";

const replaySafeIdeaChange = (
  body: string,
  key = "capture-request-1",
): ApplyHumanChangeCommand => {
  const requestHash = createHash("sha256").update(JSON.stringify({
    v: 1,
    projectId: "project-1",
    expectedProjectRevision: 1,
    body,
    contextRecordIds: [],
  })).digest("hex");
  return {
    projectId: "project-1",
    expectedProjectRevision: 1,
    rationale: "Persist a replay-safe idea.",
    operations: [{
      operationId: "human-capture-idea",
      type: "create_record",
      localRef: "captured-idea",
      kind: "idea",
      status: "provisional",
      title: body.split("\n")[0]!,
      body,
      sourceKind: "human",
      sourceRef: "web:idea-capture",
    }],
    completedAt: timestamp,
    idempotency: {
      operationScope: "idea_capture",
      key,
      requestHash,
      replayPayloadJson: serializeIdeaCaptureReplayPayload({
        projectId: "project-1",
        operationScope: "idea_capture",
        idempotencyKey: key,
        requestHash,
      }, []),
    },
  };
};

const taskRecord = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "task-1",
  projectId: "project-1",
  kind: "task",
  status: "active",
  title: "Implement authoritative changes",
  body: "Apply the requested change set atomically.",
  sourceKind: "human",
  sourceRef: "task-source",
  revision: 1,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
  ...overrides,
});

const decisionRecord = (
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord => ({
  id: "decision-existing",
  projectId: "project-1",
  kind: "decision",
  status: "accepted",
  title: "Existing decision",
  body: "Keep an existing decision available for relationship tests.",
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
  ...overrides,
});

const insertRecord = (
  database: IntentArcDatabase,
  record: ProjectRecord,
): void => {
  database
    .prepare(
      `INSERT INTO project_records (
         id, project_id, kind, status, title, body, source_kind, source_ref,
         revision, created_at, updated_at
       ) VALUES (
         @id, @projectId, @kind, @status, @title, @body, @sourceKind,
         @sourceRef, @revision, @createdAt, @updatedAt
       )`,
    )
    .run(record);
  database
    .prepare(
      `INSERT INTO project_record_revisions (
         record_id, revision, snapshot_json, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(record.id, record.revision, JSON.stringify(record), record.updatedAt);
};

const insertRelationship = (
  database: IntentArcDatabase,
  relationship: RecordRelationship,
): void => {
  database
    .prepare(
      `INSERT INTO record_relationships (
         id, project_id, from_record_id, to_record_id, kind, created_at
       ) VALUES (
         @id, @projectId, @fromRecordId, @toRecordId, @kind, @createdAt
       )`,
    )
    .run(relationship);
};

const setupProject = (
  database: IntentArcDatabase,
  record: ProjectRecord = taskRecord(),
): void => {
  database
    .prepare(
      `INSERT INTO projects (
         id, name, revision, primary_repository_path, created_at, updated_at
       ) VALUES (?, ?, 1, NULL, ?, ?)`,
    )
    .run("project-1", "IntentArc", timestamp, timestamp);
  insertRecord(database, record);
};

const insertProfile = (
  database: IntentArcDatabase,
  profileId: string,
): void => {
  database
    .prepare(
      `INSERT INTO client_profiles (
         id, name, status, token_hash, created_at, updated_at,
         token_rotated_at, last_used_at
       ) VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL)`,
    )
    .run(
      profileId,
      `Profile ${profileId}`,
      "a".repeat(64),
      timestamp,
      timestamp,
      timestamp,
    );
};

const preparedChangeSet = (
  operations: PreparedChangeOperation[],
  overrides: Partial<PreparedChangeSet> = {},
): PreparedChangeSet => ({
  changeId: "change-1",
  projectId: "project-1",
  idempotencyKey: "idempotency-1",
  rationale: "Apply the authoritative project changes.",
  sourceTaskId: "task-1",
  operations,
  ...overrides,
});

const command = (
  operations: PreparedChangeOperation[],
  overrides: Partial<ApplyPreparedChangeSetCommand> = {},
): ApplyPreparedChangeSetCommand => ({
  actor: { type: "local_human" },
  authorityMode: "human",
  scopeDecision: "human_direct",
  changeSet: preparedChangeSet(operations),
  expectedProjectRevision: 1,
  auditEventId: "audit-1",
  completedAt: timestamp,
  ...overrides,
});

const proposalCommand = (
  operations: ChangeOperation[],
  overrides: Partial<CreateProposalCommand["input"]> = {},
): CreateProposalCommand => ({
  profileId: "profile-1",
  credentialGeneration: timestamp,
  authorityMode: "proposal",
  scopeDecision: "proposal_mode",
  input: {
    projectId: "project-1",
    baseProjectRevision: 1,
    idempotencyKey: "proposal-key",
    rationale: "Review this proposed change.",
    sourceTaskId: "task-1",
    predecessorProposalId: null,
    operations,
    ...overrides,
  },
  submittedAt: "2026-07-27T12:00:00.000Z",
});

const insertRepositorySnapshot = (
  database: IntentArcDatabase,
  input: {
    projectId?: string;
    sourceId?: string;
    snapshotId?: string;
    state?: "candidate" | "accepted" | "discarded";
  } = {},
): void => {
  const projectId = input.projectId ?? "project-1";
  const sourceId = input.sourceId ?? "source-1";
  const snapshotId = input.snapshotId ?? "snapshot-candidate";
  const state = input.state ?? "candidate";
  database.prepare(`
    INSERT OR IGNORE INTO repository_sources (
      id, project_id, root, canonical_subpath, repository_identity, status,
      current_snapshot_id, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'available', NULL, ?, ?)
  `).run(sourceId, projectId, `C:/repositories/${sourceId}`, `identity-${sourceId}`, timestamp, timestamp);
  database.prepare(`
    INSERT INTO repository_snapshots (
      id, source_id, project_id, state, base_snapshot_id,
      base_project_revision, branch, head, fingerprint, scanner_version,
      ruleset_version, warning_counts_json, exclusion_counts_json,
      finding_counts_json, created_at, decided_at, applied_at
    ) VALUES (?, ?, ?, ?, NULL, 1, 'main', ?, ?, '1', '1', '{}', '{}', '{}', ?, ?, ?)
  `).run(
    snapshotId,
    sourceId,
    projectId,
    state,
    "a".repeat(40),
    "b".repeat(64),
    timestamp,
    state === "candidate" ? null : timestamp,
    state === "accepted" ? timestamp : null,
  );
};

const repositoryProposalCommand = (
  operations: ChangeOperation[],
  overrides: Partial<CreateRepositoryRefreshProposalCommand["input"]> = {},
): CreateRepositoryRefreshProposalCommand => ({
  input: {
    projectId: "project-1",
    repositorySnapshotId: "snapshot-candidate",
    baseProjectRevision: 1,
    rationale: "Review repository-derived project meaning.",
    operations,
    ...overrides,
  },
  createdAt: timestamp,
});

describe("governance store", () => {
  let database: IntentArcDatabase | undefined;
  let concurrentDatabase: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    concurrentDatabase?.close();
    database?.close();
    concurrentDatabase = undefined;
    database = undefined;

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
      temporaryDatabase = undefined;
    }
  });

  const setup = (record: ProjectRecord = taskRecord()) => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    setupProject(database, record);
    return database;
  };

  const insertCoordinationSubmission = (
    db: IntentArcDatabase,
    proposalId: string,
    delegationId: string | null = null,
  ): void => {
    db.prepare(`INSERT INTO context_packs VALUES (
      'pack-coordination', 'project-1', 'task-1', 1, 100, 1, '{}', ?
    )`).run(timestamp);
    db.prepare(`
      INSERT INTO task_claims VALUES (
        'claim-coordination', 'project-1', 'task-1', 'profile-1', ?, 'submitted',
        1, 1, 'pack-coordination', ?, '2026-07-27T12:30:00.000Z',
        '2026-07-27T16:00:00.000Z', ?, 'checkpoint-coordination'
      )
    `).run(delegationId, timestamp, timestamp);
    db.prepare(`INSERT INTO task_checkpoints VALUES (
      'checkpoint-coordination', 'claim-coordination', 1, '{}', ?, 1, 1, 'pack-coordination'
    )`).run(timestamp);
    if (delegationId) {
      db.prepare(`INSERT INTO task_delegations VALUES (
        ?, 'project-1', 'task-1', 'profile-parent', 'profile-1', 'claimed',
        1, 1, '{"summary":"Complete task","constraints":[]}', '["update_record"]',
        ?, '2026-07-27T16:00:00.000Z', ?, NULL, 'claim-coordination'
      )`).run(delegationId, timestamp, timestamp);
    }
    db.prepare(`INSERT INTO task_submissions VALUES (
      'submission-coordination', 'claim-coordination', 'checkpoint-coordination',
      'profile-1', 'project-1', 'task-1', 1, 1, 'pack-coordination',
      '{"summary":"Complete","verificationEvidence":{"tests":[],"artifacts":[]},"repositoryEvidence":null,"changes":{"rationale":"Complete task","operations":[]}}',
      ?, 'submitted', ?, NULL
    )`).run(proposalId, timestamp);
  };

  it("reconciles coordination submission acceptance atomically with the governed task change", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    insertProfile(db, "profile-parent");
    db.prepare(`INSERT INTO profile_project_authorities VALUES (
      'authority-coordination', 'profile-1', 'project-1', 'proposal', ?, ?
    )`).run(timestamp, timestamp);
    const ids = ["change-coordination", "proposal-coordination", "audit-created", "audit-applied", "audit-accepted"];
    const store = createGovernanceStore(db, { newId: () => ids.shift() ?? "unexpected" });
    const created = store.createProposal(proposalCommand([{
      operationId: "coordination-task-completion",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { status: "completed" },
    }], { idempotencyKey: "coordination-proposal" }));
    expect(created).toMatchObject({ outcome: "proposed", proposalId: "proposal-coordination" });
    insertCoordinationSubmission(db, "proposal-coordination", "delegation-coordination");

    expect(store.acceptProposal({
      proposalId: "proposal-coordination",
      reason: null,
      reviewedAt: "2026-07-27T13:00:00.000Z",
    })).toMatchObject({ outcome: "applied", projectRevision: 2 });
    expect(db.prepare("SELECT status, revision FROM project_records WHERE id = 'task-1'").get())
      .toEqual({ status: "completed", revision: 2 });
    expect(db.prepare("SELECT state, decided_at FROM task_submissions WHERE id = 'submission-coordination'").get())
      .toEqual({ state: "accepted", decided_at: "2026-07-27T13:00:00.000Z" });
    expect(db.prepare("SELECT state, ended_at FROM task_claims WHERE id = 'claim-coordination'").get())
      .toEqual({ state: "reconciled", ended_at: "2026-07-27T13:00:00.000Z" });
    expect(db.prepare("SELECT state, ended_at FROM task_delegations WHERE id = 'delegation-coordination'").get())
      .toEqual({ state: "completed", ended_at: "2026-07-27T13:00:00.000Z" });
  });

  it("creates a client-free repository refresh proposal with immutable ordered operations", () => {
    const db = setup();
    insertRepositorySnapshot(db);
    const ids = {
      proposal: ["proposal-refresh"],
      audit: ["audit-refresh-created"],
      change: [] as string[],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix]?.shift() ?? `generated-${prefix}`,
    });
    const operations: ChangeOperation[] = [{
      operationId: "operation-first",
      type: "create_record",
      kind: "decision",
      status: "provisional",
      title: "Repository decision",
      body: "Derived from reviewed repository evidence.",
    }, {
      operationId: "operation-second",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { title: "Repository-aligned task" },
    }];

    expect(store.createRepositoryRefreshProposal(
      repositoryProposalCommand(operations),
    )).toEqual(expect.objectContaining({
      id: "proposal-refresh",
      projectId: "project-1",
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "snapshot-candidate",
      },
      idempotencyKey: null,
      requestHash: null,
      state: "pending",
      operations,
    }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT position, operation_id FROM proposal_operations
      WHERE proposal_id = 'proposal-refresh' ORDER BY position
    `).all()).toEqual([
      { position: 0, operation_id: "operation-first" },
      { position: 1, operation_id: "operation-second" },
    ]);
    expect(() => db.prepare(`
      UPDATE proposal_operations SET position = 3
      WHERE proposal_id = 'proposal-refresh' AND position = 0
    `).run()).toThrow("proposal operations are immutable");
    expect(() => db.prepare(`
      DELETE FROM proposal_operations
      WHERE proposal_id = 'proposal-refresh' AND position = 0
    `).run()).toThrow("proposal operations are immutable");
    expect(db.prepare(`
      SELECT actor_type, profile_id, idempotency_key, action_category
      FROM audit_events WHERE id = 'audit-refresh-created'
    `).get()).toEqual({
      actor_type: "local_human",
      profile_id: null,
      idempotency_key: null,
      action_category: "proposal_created",
    });
  });

  it("validates repository snapshot project and candidate state inside proposal creation", () => {
    const db = setup();
    db.prepare(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-2', 'Other', 1, NULL, ?, ?
      )
    `).run(timestamp, timestamp);
    insertRepositorySnapshot(db, {
      projectId: "project-2",
      sourceId: "source-other",
      snapshotId: "snapshot-other",
    });
    insertRepositorySnapshot(db, {
      sourceId: "source-accepted",
      snapshotId: "snapshot-accepted",
      state: "accepted",
    });
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-must-not-be-used`,
    });
    const operations: ChangeOperation[] = [{
      operationId: "operation-1",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { status: "completed" },
    }];

    expect(() => store.createRepositoryRefreshProposal(
      repositoryProposalCommand(operations, {
        repositorySnapshotId: "snapshot-other",
      }),
    )).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(() => store.createRepositoryRefreshProposal(
      repositoryProposalCommand(operations, {
        repositorySnapshotId: "snapshot-accepted",
      }),
    )).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM change_proposals").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual({ count: 0 });
  });

  it("accepts and conflicts repository refresh proposals through the shared review path", () => {
    const db = setup();
    insertRepositorySnapshot(db);
    insertRepositorySnapshot(db, {
      sourceId: "source-1",
      snapshotId: "snapshot-stale",
    });
    const ids = {
      proposal: ["proposal-refresh", "proposal-stale"],
      audit: [
        "audit-create-refresh",
        "audit-create-stale",
        "audit-change-applied",
        "audit-proposal-accepted",
        "audit-proposal-conflicted",
      ],
      change: [] as string[],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix]?.shift() ?? `generated-${prefix}`,
    });
    const acceptedOperations: ChangeOperation[] = [{
      operationId: "operation-create",
      type: "create_record",
      kind: "decision",
      status: "accepted",
      title: "Repository-derived decision",
      body: "Accepted after local review.",
    }];
    store.createRepositoryRefreshProposal(repositoryProposalCommand(
      acceptedOperations,
    ));
    store.createRepositoryRefreshProposal(repositoryProposalCommand([{
      operationId: "operation-stale",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { title: "Stale repository meaning" },
    }], {
      repositorySnapshotId: "snapshot-stale",
      baseProjectRevision: 1,
    }));

    expect(store.acceptProposal({
      proposalId: "proposal-refresh",
      reason: null,
      reviewedAt: "2026-07-27T13:00:00.000Z",
    })).toMatchObject({
      outcome: "applied",
      changeId: "proposal-refresh",
      proposalId: "proposal-refresh",
      projectRevision: 2,
    });
    expect(db.prepare(`
      SELECT source_kind, source_ref FROM project_records
      WHERE title = 'Repository-derived decision'
    `).get()).toEqual({
      source_kind: "repository",
      source_ref: "snapshot-candidate",
    });
    expect(store.acceptProposal({
      proposalId: "proposal-stale",
      reason: null,
      reviewedAt: "2026-07-27T14:00:00.000Z",
    })).toEqual({
      outcome: "conflicted",
      changeId: "proposal-stale",
      proposalId: "proposal-stale",
      currentProjectRevision: 2,
    });
    expect(store.getProposal("proposal-stale")).toMatchObject({
      state: "conflicted",
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "snapshot-stale",
      },
    });
  });

  it("rejects and withdraws only pending proposals while preserving their ordered operations", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-reject", "change-withdraw"],
      proposal: ["proposal-reject", "proposal-withdraw"],
      audit: [
        "audit-create-reject",
        "audit-create-withdraw",
        "audit-reject",
        "audit-reject-replay",
        "audit-withdraw",
      ],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const rejectedOperations: ChangeOperation[] = [{
      operationId: "operation-reject",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { title: "Rejected title" },
    }];
    const withdrawnOperations: ChangeOperation[] = [{
      operationId: "operation-withdraw",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { body: "Withdrawn body" },
    }];
    const rejectedCommand = proposalCommand(rejectedOperations, {
      idempotencyKey: "reject-key",
    });
    store.createProposal(rejectedCommand);
    store.createProposal(proposalCommand(withdrawnOperations, {
      idempotencyKey: "withdraw-key",
    }));

    expect(store.rejectProposal).toEqual(expect.any(Function));
    expect(store.withdrawProposal).toEqual(expect.any(Function));

    expect(store.rejectProposal({
      proposalId: "proposal-reject",
      reason: "The requested status is not appropriate.",
      reviewedAt: "2026-07-27T13:00:00.000Z",
    })).toMatchObject({
      id: "proposal-reject",
      state: "rejected",
      reviewReason: "The requested status is not appropriate.",
      reviewerActor: "local_human",
      updatedAt: "2026-07-27T13:00:00.000Z",
      reviewedAt: "2026-07-27T13:00:00.000Z",
      operations: rejectedOperations,
    });
    expect(store.getIdempotencyResult({
      profileId: "profile-1",
      projectId: "project-1",
      idempotencyKey: "reject-key",
    })?.result).toEqual({
      outcome: "rejected",
      changeId: "change-reject",
      code: "operation_denied",
      reason: "The requested status is not appropriate.",
      replayed: false,
    });
    expect(store.createProposal({
      ...rejectedCommand,
      submittedAt: "2026-07-27T13:00:30.000Z",
    })).toEqual({
      outcome: "rejected",
      changeId: "change-reject",
      code: "operation_denied",
      reason: "The requested status is not appropriate.",
      replayed: true,
    });
    expect(() => store.rejectProposal({
      proposalId: "proposal-reject",
      reason: "Try to decide it twice.",
      reviewedAt: "2026-07-27T13:01:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "proposal_not_pending" }));
    expect(() => store.acceptProposal({
      proposalId: "proposal-reject",
      reason: null,
      reviewedAt: "2026-07-27T13:01:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "proposal_not_pending" }));

    expect(store.withdrawProposal({
      proposalId: "proposal-withdraw",
      reason: "The submitting profile superseded this request.",
      reviewedAt: "2026-07-27T13:02:00.000Z",
    })).toMatchObject({
      id: "proposal-withdraw",
      state: "withdrawn",
      reviewReason: "The submitting profile superseded this request.",
      reviewerActor: "local_human",
      updatedAt: "2026-07-27T13:02:00.000Z",
      reviewedAt: "2026-07-27T13:02:00.000Z",
      operations: withdrawnOperations,
    });
    expect(store.getIdempotencyResult({
      profileId: "profile-1",
      projectId: "project-1",
      idempotencyKey: "withdraw-key",
    })?.result).toEqual({
      outcome: "proposed",
      changeId: "change-withdraw",
      proposalId: "proposal-withdraw",
      state: "pending",
      replayed: false,
    });
    expect(store.getProfileChange("profile-1", "change-withdraw"))
      .toMatchObject({
        state: "withdrawn",
        proposal: {
          id: "proposal-withdraw",
          state: "withdrawn",
          operations: withdrawnOperations,
        },
      });
    expect(() => store.withdrawProposal({
      proposalId: "proposal-withdraw",
      reason: "Try to withdraw it twice.",
      reviewedAt: "2026-07-27T13:03:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "proposal_not_pending" }));
    expect(store.listAuditEvents({
      projectId: "project-1",
      limit: 20,
    }).filter(({ actionCategory }) =>
      ["proposal_rejected", "proposal_withdrawn"].includes(actionCategory)
    )).toEqual([
      expect.objectContaining({
        actionCategory: "proposal_withdrawn",
        targetId: "proposal-withdraw",
        outcome: "withdrawn",
        reason: "The submitting profile superseded this request.",
      }),
      expect.objectContaining({
        actionCategory: "proposal_rejected",
        targetId: "proposal-reject",
        outcome: "rejected",
        reason: "The requested status is not appropriate.",
      }),
    ]);
  });

  it("accepts a pending proposal through the kernel and commits both audits with the original change", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-accept"],
      proposal: ["proposal-accept"],
      audit: [
        "audit-create",
        "audit-change-applied",
        "audit-proposal-accepted",
      ],
      record: ["decision-accepted"],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const operations: ChangeOperation[] = [
      {
        operationId: "operation-update",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { title: "Human-reviewed proposal", status: "completed" },
      },
      {
        operationId: "operation-create",
        type: "create_record",
        kind: "decision",
        status: "accepted",
        title: "Accept the proposal",
        body: "A human approved the complete operation set.",
      },
    ];
    store.createProposal(proposalCommand(operations, {
      idempotencyKey: "accept-key",
    }));

    expect(store.acceptProposal).toEqual(expect.any(Function));
    const result = store.acceptProposal({
      proposalId: "proposal-accept",
      reason: null,
      reviewedAt: "2026-07-27T13:00:00.000Z",
    });

    expect(result).toEqual({
      outcome: "applied",
      changeId: "change-accept",
      proposalId: "proposal-accept",
      projectRevision: 2,
      operations: [
        expect.objectContaining({
          operationId: "operation-update",
          type: "update_record",
          record: expect.objectContaining({
            id: "task-1",
            revision: 2,
            status: "completed",
          }),
        }),
        expect.objectContaining({
          operationId: "operation-create",
          type: "create_record",
          record: expect.objectContaining({
            id: "decision-accepted",
            sourceKind: "agent",
            sourceRef: "profile-1",
            revision: 1,
          }),
        }),
      ],
    });
    expect(store.getProposal("proposal-accept")).toMatchObject({
      state: "accepted",
      reviewReason: null,
      reviewerActor: "local_human",
      updatedAt: "2026-07-27T13:00:00.000Z",
      reviewedAt: "2026-07-27T13:00:00.000Z",
      operations,
    });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db.prepare(
        "SELECT record_id, revision FROM project_record_revisions ORDER BY record_id, revision",
      ).all(),
    ).toEqual([
      { record_id: "decision-accepted", revision: 1 },
      { record_id: "task-1", revision: 1 },
      { record_id: "task-1", revision: 2 },
    ]);
    expect(store.getIdempotencyResult({
      profileId: "profile-1",
      projectId: "project-1",
      idempotencyKey: "accept-key",
    })?.result).toEqual({
      ...result,
      replayed: false,
    });
    expect(store.listAuditEvents({
      projectId: "project-1",
      limit: 10,
    }).filter(({ actionCategory }) =>
      ["change_applied", "proposal_accepted"].includes(actionCategory)
    )).toEqual([
      expect.objectContaining({
        id: "audit-proposal-accepted",
        actorType: "local_human",
        authorityMode: "human",
        scopeDecision: "human_review",
        actionCategory: "proposal_accepted",
        targetId: "proposal-accept",
        revisionBefore: 1,
        revisionAfter: 2,
        outcome: "applied",
        reason: null,
      }),
      expect.objectContaining({
        id: "audit-change-applied",
        actorType: "local_human",
        authorityMode: "human",
        scopeDecision: "human_review",
        actionCategory: "change_applied",
        targetId: "change-accept",
        revisionBefore: 1,
        revisionAfter: 2,
        outcome: "applied",
      }),
    ]);
  });

  it("marks a stale acceptance conflicted without applying any proposed operation", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-proposal", "change-human"],
      proposal: ["proposal-stale"],
      audit: ["audit-created", "audit-human", "audit-conflicted"],
      record: [],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal(proposalCommand([{
      operationId: "operation-proposed",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { title: "Must not apply" },
    }], {
      idempotencyKey: "stale-key",
    }));
    store.applyHumanChange({
      projectId: "project-1",
      rationale: "Advance the project before review.",
      operations: [{
        operationId: "operation-human",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { body: "Human change wins." },
      }],
      completedAt: "2026-07-27T12:30:00.000Z",
    });

    const result = store.acceptProposal({
      proposalId: "proposal-stale",
      reason: "Approve if still current.",
      reviewedAt: "2026-07-27T13:00:00.000Z",
    });

    expect(result).toEqual({
      outcome: "conflicted",
      changeId: "change-proposal",
      proposalId: "proposal-stale",
      currentProjectRevision: 2,
    });
    expect(store.getProposal("proposal-stale")).toMatchObject({
      state: "conflicted",
      reviewReason: "Proposal revisions changed before human acceptance",
      reviewerActor: "local_human",
      updatedAt: "2026-07-27T13:00:00.000Z",
      reviewedAt: "2026-07-27T13:00:00.000Z",
    });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db.prepare("SELECT title, body, revision FROM project_records WHERE id = 'task-1'").get(),
    ).toEqual({
      title: taskRecord().title,
      body: "Human change wins.",
      revision: 2,
    });
    expect(store.getIdempotencyResult({
      profileId: "profile-1",
      projectId: "project-1",
      idempotencyKey: "stale-key",
    })?.result).toEqual({
      outcome: "conflicted",
      changeId: "change-proposal",
      proposalId: "proposal-stale",
      state: "conflicted",
      currentProjectRevision: 2,
      replayed: false,
    });
    expect(store.listAuditEvents({
      actionCategory: "proposal_conflicted",
    })).toEqual([
      expect.objectContaining({
        actorType: "local_human",
        targetId: "proposal-stale",
        revisionBefore: 2,
        revisionAfter: 2,
        outcome: "conflicted",
        reason: "Proposal revisions changed before human acceptance",
      }),
    ]);
  });

  it.each([
    [
      "kernel",
      "audit-change-collision",
      [
        "audit-created",
        "audit-change-collision",
        "audit-review-unused",
      ],
    ],
    [
      "review",
      "audit-review-collision",
      [
        "audit-created",
        "audit-change-applied",
        "audit-review-collision",
      ],
    ],
  ])("rolls back proposal acceptance, idempotency, records, revisions, and audits when the %s audit insertion fails", (
    _failedAudit,
    collisionId,
    auditIds,
  ) => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-accept"],
      proposal: ["proposal-accept"],
      audit: [...auditIds],
      record: ["decision-rolled-back"],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal(proposalCommand([{
      operationId: "operation-create",
      type: "create_record",
      kind: "decision",
      status: "accepted",
      title: "Rolled-back acceptance",
      body: "The review audit must commit too.",
    }], {
      idempotencyKey: "rollback-key",
    }));
    db.prepare(
      `INSERT INTO audit_events (
         id, project_id, actor_type, profile_id, authority_mode, scope_decision,
         action_category, target_id, idempotency_key, revision_before,
         revision_after, outcome, reason, created_at
       ) VALUES (
         @collisionId, NULL, 'local_human', NULL, 'human', 'seed',
         'seed', NULL, NULL, NULL, NULL, 'applied', NULL, @timestamp
       )`,
    ).run({ collisionId, timestamp });

    expect(() => store.acceptProposal({
      proposalId: "proposal-accept",
      reason: null,
      reviewedAt: "2026-07-27T13:00:00.000Z",
    })).toThrowError(/UNIQUE constraint failed: audit_events.id/);

    expect(store.getProposal("proposal-accept")).toMatchObject({
      state: "pending",
      reviewReason: null,
      reviewerActor: null,
      reviewedAt: null,
    });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_records WHERE id = 'decision-rolled-back'").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_record_revisions").get(),
    ).toEqual({ count: 1 });
    expect(store.getIdempotencyResult({
      profileId: "profile-1",
      projectId: "project-1",
      idempotencyKey: "rollback-key",
    })?.result).toMatchObject({
      outcome: "proposed",
      state: "pending",
    });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action_category IN ('change_applied', 'proposal_accepted')",
      ).get(),
    ).toEqual({ count: 0 });
  });

  it("allows exactly one acceptance across two connections and reports the other proposal is no longer pending", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-concurrent"],
      proposal: ["proposal-concurrent"],
      audit: [
        "audit-created",
        "audit-change-applied",
        "audit-proposal-accepted",
      ],
      record: [],
      relationship: [],
    };
    let raceAcceptance = false;
    let attemptedSecondAcceptance = false;
    let concurrentError: unknown;
    let secondStore: ReturnType<typeof createGovernanceStore> | undefined;
    const firstStore = createGovernanceStore(db, {
      newId: (prefix) => {
        if (
          raceAcceptance &&
          prefix === "audit" &&
          !attemptedSecondAcceptance
        ) {
          attemptedSecondAcceptance = true;
          try {
            secondStore!.acceptProposal({
              proposalId: "proposal-concurrent",
              reason: null,
              reviewedAt: "2026-07-27T13:00:01.000Z",
            });
          } catch (error) {
            concurrentError = error;
          }
        }
        return ids[prefix].shift() ?? `unexpected-${prefix}`;
      },
    });
    firstStore.createProposal(proposalCommand([{
      operationId: "operation-concurrent",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { status: "completed" },
    }], {
      idempotencyKey: "concurrent-key",
    }));
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    concurrentDatabase.pragma("busy_timeout = 0");
    secondStore = createGovernanceStore(concurrentDatabase, {
      newId: (prefix) => `second-${prefix}`,
    });

    raceAcceptance = true;
    expect(firstStore.acceptProposal({
      proposalId: "proposal-concurrent",
      reason: null,
      reviewedAt: "2026-07-27T13:00:00.000Z",
    })).toMatchObject({
      outcome: "applied",
      changeId: "change-concurrent",
      projectRevision: 2,
    });
    expect(concurrentError).toMatchObject({ code: "SQLITE_BUSY" });
    expect(() => secondStore!.acceptProposal({
      proposalId: "proposal-concurrent",
      reason: null,
      reviewedAt: "2026-07-27T13:00:02.000Z",
    })).toThrowError(expect.objectContaining({
      code: "proposal_not_pending",
    }));
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db.prepare("SELECT revision, status FROM project_records WHERE id = 'task-1'").get(),
    ).toEqual({ revision: 2, status: "completed" });
    expect(
      db.prepare(
        "SELECT state, COUNT(*) AS count FROM change_proposals GROUP BY state",
      ).all(),
    ).toEqual([{ state: "accepted", count: 1 }]);
    expect(
      db.prepare(
        `SELECT action_category, COUNT(*) AS count
         FROM audit_events
         WHERE action_category IN ('change_applied', 'proposal_accepted')
         GROUP BY action_category
         ORDER BY action_category`,
      ).all(),
    ).toEqual([
      { action_category: "change_applied", count: 1 },
      { action_category: "proposal_accepted", count: 1 },
    ]);
  });

  it("atomically applies ordered updates, local-reference creates, and relationships at one project revision", () => {
    const db = setup();
    const generatedIds = ["decision-1", "relationship-1"];
    const store = createGovernanceStore(db, {
      newId: () => generatedIds.shift() ?? "unexpected-id",
    });

    const result = store.applyPreparedChangeSet(
      command(
        [
          {
            operationId: "operation-update",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: {
              title: "Implement the atomic kernel",
              body: "Resolve and commit the entire plan in one transaction.",
              status: "completed",
            },
          },
          {
            operationId: "operation-create",
            type: "create_record",
            localRef: "new-decision",
            kind: "decision",
            status: "accepted",
            title: "Use one immediate transaction",
            body: "The project revision advances once for the complete set.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
          {
            operationId: "operation-link",
            type: "create_relationship",
            from: { recordId: "task-1" },
            to: { localRef: "new-decision" },
            kind: "decided_by",
          },
        ],
        {
          actor: { type: "profile", profileId: "profile-1" },
          authorityMode: "full_direct",
          scopeDecision: "full_direct",
        },
      ),
    );

    expect(result).toEqual({
      outcome: "applied",
      projectId: "project-1",
      revisionBefore: 1,
      revisionAfter: 2,
      operations: [
        {
          operationId: "operation-update",
          type: "update_record",
          record: {
            ...taskRecord(),
            title: "Implement the atomic kernel",
            body: "Resolve and commit the entire plan in one transaction.",
            status: "completed",
            revision: 2,
            updatedAt: timestamp,
          },
        },
        {
          operationId: "operation-create",
          type: "create_record",
          record: {
            id: "decision-1",
            projectId: "project-1",
            kind: "decision",
            status: "accepted",
            title: "Use one immediate transaction",
            body: "The project revision advances once for the complete set.",
            sourceKind: "agent",
            sourceRef: "change-1",
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        {
          operationId: "operation-link",
          type: "create_relationship",
          relationship: {
            id: "relationship-1",
            projectId: "project-1",
            fromRecordId: "task-1",
            toRecordId: "decision-1",
            kind: "decided_by",
            createdAt: timestamp,
          },
        },
      ],
    });

    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db
        .prepare(
          `SELECT record_id, revision, snapshot_json
           FROM project_record_revisions
           ORDER BY record_id, revision`,
        )
        .all()
        .map((row) => {
          const revision = row as {
            record_id: string;
            revision: number;
            snapshot_json: string;
          };
          return {
            recordId: revision.record_id,
            revision: revision.revision,
            snapshot: JSON.parse(revision.snapshot_json),
          };
        }),
    ).toEqual([
      {
        recordId: "decision-1",
        revision: 1,
        snapshot: result.operations[1]?.record,
      },
      {
        recordId: "task-1",
        revision: 1,
        snapshot: taskRecord(),
      },
      {
        recordId: "task-1",
        revision: 2,
        snapshot: result.operations[0]?.record,
      },
    ]);

    const auditRow = db
      .prepare("SELECT * FROM audit_events WHERE id = 'audit-1'")
      .get() as AuditEventRow;
    expect(mapAuditEventRow(auditRow)).toEqual({
      id: "audit-1",
      projectId: "project-1",
      actorType: "profile",
      profileId: "profile-1",
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
      actionCategory: "change_applied",
      targetId: "change-1",
      idempotencyKey: "idempotency-1",
      revisionBefore: 1,
      revisionAfter: 2,
      outcome: "applied",
      reason: "Apply the authoritative project changes.",
      createdAt: timestamp,
    });
  });

  it("rejects duplicate prepared update targets before any state is written", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) => `unexpected-${prefix}`,
    });

    expect(() =>
      store.applyPreparedChangeSet(command([
        {
          operationId: "update-first",
          type: "update_record",
          recordId: " task-1 ",
          expectedRecordRevision: 1,
          patch: { title: "First update" },
        },
        {
          operationId: "update-second",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 2,
          patch: { body: "Second update" },
        },
      ])),
    ).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "validation_failed",
        message: "update_record targets must be unique",
        details: { recordId: "task-1" },
      }),
    );
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare(
        "SELECT title, body, revision FROM project_records WHERE id = 'task-1'",
      ).get(),
    ).toEqual({
      title: taskRecord().title,
      body: taskRecord().body,
      revision: 1,
    });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM project_record_revisions WHERE record_id = 'task-1'",
      ).get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 0 });
  });

  it("preflights the complete plan before writes and rolls back an invalid third operation", () => {
    const db = setup();
    let insertStarted = false;
    db.function("mark_governance_insert", () => {
      insertStarted = true;
      return 1;
    });
    db.exec(`
      CREATE TRIGGER observe_governance_record_insert
      BEFORE INSERT ON project_records
      BEGIN
        SELECT mark_governance_insert();
      END
    `);
    const store = createGovernanceStore(db, {
      newId: (prefix) =>
        prefix === "record" ? "decision-1" : "relationship-1",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-create",
            type: "create_record",
            localRef: "decision",
            kind: "decision",
            status: "accepted",
            title: "Prepared decision",
            body: "This valid operation must never start writing.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
          {
            operationId: "operation-update",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: { status: "completed" },
          },
          {
            operationId: "operation-invalid",
            type: "create_relationship",
            from: { localRef: "decision" },
            to: { recordId: "missing-record" },
            kind: "related_to",
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "validation_failed",
      }),
    );

    expect(insertStarted).toBe(false);
    expect(
      db.prepare("SELECT id, revision, status FROM project_records").all(),
    ).toEqual([{ id: "task-1", revision: 1, status: "active" }]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_record_revisions").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects stale project revisions without mutations", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: () => "unused-id",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command(
          [
            {
              operationId: "operation-update",
              type: "update_record",
              recordId: "task-1",
              expectedRecordRevision: 1,
              patch: { status: "completed" },
            },
          ],
          { expectedProjectRevision: 0 },
        ),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "project_revision_conflict",
        details: {
          projectId: "project-1",
          expectedRevision: 0,
          actualRevision: 1,
        },
      }),
    );
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects stale record revisions without mutations", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: () => "unused-id",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-update",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 2,
            patch: { status: "completed" },
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "record_revision_conflict",
        details: {
          recordId: "task-1",
          expectedRevision: 2,
          actualRevision: 1,
        },
      }),
    );
    expect(
      db
        .prepare(
          "SELECT revision, status FROM project_records WHERE id = 'task-1'",
        )
        .get(),
    ).toEqual({ revision: 1, status: "active" });
  });

  it("allows only one stale concurrent submission to commit across two connections", () => {
    const db = setup();
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    concurrentDatabase.pragma("busy_timeout = 0");
    const secondStore = createGovernanceStore(concurrentDatabase, {
      newId: () => "unused-second-id",
    });
    const secondOperation: PreparedChangeOperation = {
      operationId: "operation-concurrent-update",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { status: "blocked" },
    };
    let secondError: unknown;
    const firstStore = createGovernanceStore(db, {
      newId: () => {
        try {
          secondStore.applyPreparedChangeSet(
            command([secondOperation], {
              auditEventId: "audit-2",
              changeSet: preparedChangeSet([secondOperation], {
                changeId: "change-2",
                idempotencyKey: "idempotency-2",
              }),
            }),
          );
        } catch (error) {
          secondError = error;
        }
        return "decision-1";
      },
    });

    firstStore.applyPreparedChangeSet(
      command([
        {
          operationId: "operation-create",
          type: "create_record",
          kind: "decision",
          status: "accepted",
          title: "Serialize authoritative writers",
          body: "The immediate transaction owns the writer lock.",
          sourceKind: "agent",
          sourceRef: "change-1",
        },
      ]),
    );

    expect(secondError).toMatchObject({ code: "SQLITE_BUSY" });
    expect(() =>
      secondStore.applyPreparedChangeSet(
        command([secondOperation], {
          auditEventId: "audit-2",
          changeSet: preparedChangeSet([secondOperation], {
            changeId: "change-2",
            idempotencyKey: "idempotency-2",
          }),
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "project_revision_conflict" }),
    );
    expect(
      db
        .prepare(
          "SELECT revision, status FROM project_records WHERE id = 'task-1'",
        )
        .get(),
    ).toEqual({ revision: 1, status: "active" });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back all mutations when the success audit insert fails", () => {
    const db = setup();
    db.prepare(
      `INSERT INTO audit_events (
         id, project_id, actor_type, profile_id, authority_mode, scope_decision,
         action_category, target_id, idempotency_key, revision_before,
         revision_after, outcome, reason, created_at
       ) VALUES (
         'audit-1', NULL, 'local_human', NULL, 'human', 'seed',
         'seed', NULL, NULL, NULL, NULL, 'applied', NULL, ?
       )`,
    ).run(timestamp);
    const store = createGovernanceStore(db, {
      newId: () => "decision-1",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-update",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: { status: "completed" },
          },
          {
            operationId: "operation-create",
            type: "create_record",
            kind: "decision",
            status: "accepted",
            title: "Rolled-back decision",
            body: "An audit failure must undo this record.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
        ]),
      ),
    ).toThrowError(/UNIQUE constraint failed: audit_events.id/);

    expect(
      db
        .prepare("SELECT id, revision, status FROM project_records ORDER BY id")
        .all(),
    ).toEqual([{ id: "task-1", revision: 1, status: "active" }]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_record_revisions").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 1 });
  });

  it.each([
    [
      "title",
      { title: "Renamed task" },
      {
        title: "Renamed task",
        body: taskRecord().body,
        status: "active",
      },
    ],
    [
      "body",
      { body: "Rewritten task body." },
      {
        title: taskRecord().title,
        body: "Rewritten task body.",
        status: "active",
      },
    ],
    [
      "status",
      { status: "completed" as const },
      {
        title: taskRecord().title,
        body: taskRecord().body,
        status: "completed",
      },
    ],
    [
      "title, body, and status",
      {
        title: "Completed atomic kernel",
        body: "The complete update is stored.",
        status: "completed" as const,
      },
      {
        title: "Completed atomic kernel",
        body: "The complete update is stored.",
        status: "completed",
      },
    ],
  ])("updates %s while preserving immutable record fields", (_name, patch, expected) => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: () => "unused-id",
    });

    const result = store.applyPreparedChangeSet(
      command([
        {
          operationId: "operation-update",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch,
        },
      ]),
    );

    expect(result.operations[0]).toEqual({
      operationId: "operation-update",
      type: "update_record",
      record: {
        ...taskRecord(),
        ...expected,
        revision: 2,
        updatedAt: timestamp,
      },
    });
  });

  it.each(["kind", "sourceKind", "sourceRef"] as const)(
    "rejects an attempt to update immutable %s",
    (field) => {
      const db = setup();
      const store = createGovernanceStore(db, {
        newId: () => "unused-id",
      });
      const invalidPatch = {
        title: "Still a valid mutable field",
        [field]: field === "kind" ? "decision" : "agent",
      };
      const invalidChangeSet = preparedChangeSet([
        {
          operationId: "operation-update",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: invalidPatch,
        } as unknown as PreparedChangeOperation,
      ]);

      expect(() =>
        store.applyPreparedChangeSet(
          command([], { changeSet: invalidChangeSet }),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "validation_failed",
        }),
      );
      expect(
        db
          .prepare(
            "SELECT kind, source_kind, source_ref, revision FROM project_records WHERE id = 'task-1'",
          )
          .get(),
      ).toEqual({
        kind: "task",
        source_kind: "human",
        source_ref: "task-source",
        revision: 1,
      });
    },
  );

  it("enforces record status transitions before updating", () => {
    const db = setup(taskRecord({ status: "archived" }));
    const store = createGovernanceStore(db, {
      newId: () => "unused-id",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-update",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: { status: "active" },
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "validation_failed",
      }),
    );
  });

  it("translates duplicate relationships without changing project state", () => {
    const db = setup();
    insertRecord(db, decisionRecord());
    insertRelationship(db, {
      id: "relationship-existing",
      projectId: "project-1",
      fromRecordId: "task-1",
      toRecordId: "decision-existing",
      kind: "decided_by",
      createdAt: timestamp,
    });
    const store = createGovernanceStore(db, {
      newId: () => "relationship-new",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-link",
            type: "create_relationship",
            from: { recordId: "task-1" },
            to: { recordId: "decision-existing" },
            kind: "decided_by",
          },
        ]),
      ),
    ).toThrow(
      new RelationshipAlreadyExistsError(
        "task-1",
        "decision-existing",
        "decided_by",
      ),
    );
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
  });

  it("normalizes a remove_relationship operation to the stored project relationship", () => {
    const db = setup();
    insertRecord(db, decisionRecord());
    const relationship: RecordRelationship = {
      id: "relationship-existing",
      projectId: "project-1",
      fromRecordId: "task-1",
      toRecordId: "decision-existing",
      kind: "decided_by",
      createdAt: timestamp,
    };
    insertRelationship(db, relationship);
    db.prepare(
      `INSERT INTO projects (
         id, name, revision, primary_repository_path, created_at, updated_at
       ) VALUES ('project-2', 'Other', 1, NULL, ?, ?)`,
    ).run(timestamp, timestamp);
    insertRecord(
      db,
      taskRecord({
        id: "other-task",
        projectId: "project-2",
        sourceRef: null,
      }),
    );
    insertRecord(
      db,
      decisionRecord({
        id: "other-decision",
        projectId: "project-2",
      }),
    );
    const otherRelationship: RecordRelationship = {
      id: "relationship-other-project",
      projectId: "project-2",
      fromRecordId: "other-task",
      toRecordId: "other-decision",
      kind: "decided_by",
      createdAt: timestamp,
    };
    insertRelationship(db, otherRelationship);
    const store = createGovernanceStore(db, {
      newId: () => "unused-id",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-remove-cross-project",
            type: "remove_relationship",
            relationshipId: "relationship-other-project",
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "validation_failed",
      }),
    );
    expect(
      db
        .prepare(
          "SELECT id FROM record_relationships WHERE id = 'relationship-other-project'",
        )
        .get(),
    ).toEqual({ id: "relationship-other-project" });

    const result = store.applyPreparedChangeSet(
      command([
        {
          operationId: "operation-remove",
          type: "remove_relationship",
          relationshipId: " relationship-existing ",
        },
      ]),
    );

    expect(result.operations).toEqual([
      {
        operationId: "operation-remove",
        type: "remove_relationship",
        relationship,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT id FROM record_relationships WHERE id = 'relationship-existing'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT revision FROM projects WHERE id IN ('project-1', 'project-2') ORDER BY id",
        )
        .all(),
    ).toEqual([{ revision: 2 }, { revision: 1 }]);
  });

  it("uses normalized create fields and local references for planning and storage", () => {
    const db = setup();
    const generatedIds = ["decision-1", "relationship-1"];
    const store = createGovernanceStore(db, {
      newId: () => generatedIds.shift() ?? "unexpected-id",
    });

    const result = store.applyPreparedChangeSet(
      command([
        {
          operationId: " operation-create ",
          type: "create_record",
          localRef: " decision ",
          kind: "decision",
          status: "accepted",
          title: " Normalized decision ",
          body: " Store normalized prepared values. ",
          sourceKind: "agent",
          sourceRef: " change-1 ",
        },
        {
          operationId: " operation-link ",
          type: "create_relationship",
          from: { recordId: " task-1 " },
          to: { localRef: "decision" },
          kind: "decided_by",
        },
      ]),
    );

    expect(result.operations).toEqual([
      {
        operationId: "operation-create",
        type: "create_record",
        record: {
          id: "decision-1",
          projectId: "project-1",
          kind: "decision",
          status: "accepted",
          title: "Normalized decision",
          body: "Store normalized prepared values.",
          sourceKind: "agent",
          sourceRef: "change-1",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      {
        operationId: "operation-link",
        type: "create_relationship",
        relationship: {
          id: "relationship-1",
          projectId: "project-1",
          fromRecordId: "task-1",
          toRecordId: "decision-1",
          kind: "decided_by",
          createdAt: timestamp,
        },
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT title, body, source_ref FROM project_records WHERE id = 'decision-1'",
        )
        .get(),
    ).toEqual({
      title: "Normalized decision",
      body: "Store normalized prepared values.",
      source_ref: "change-1",
    });
  });

  it("rejects cross-project records used by updates or relationship endpoints", () => {
    const db = setup();
    db.prepare(
      `INSERT INTO projects (
         id, name, revision, primary_repository_path, created_at, updated_at
       ) VALUES ('project-2', 'Other', 1, NULL, ?, ?)`,
    ).run(timestamp, timestamp);
    insertRecord(
      db,
      taskRecord({
        id: "other-task",
        projectId: "project-2",
        sourceRef: null,
      }),
    );
    const store = createGovernanceStore(db, {
      newId: () => "relationship-new",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-update-cross-project",
            type: "update_record",
            recordId: "other-task",
            expectedRecordRevision: 1,
            patch: { status: "completed" },
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation_failed" }));

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-link-cross-project",
            type: "create_relationship",
            from: { recordId: "task-1" },
            to: { recordId: "other-task" },
            kind: "related_to",
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
  });

  it("rejects two creates that reuse a local reference before inserting either record", () => {
    const db = setup();
    const generatedIds = ["decision-1", "decision-2"];
    const store = createGovernanceStore(db, {
      newId: () => generatedIds.shift() ?? "unexpected-id",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-first",
            type: "create_record",
            localRef: "decision",
            kind: "decision",
            status: "accepted",
            title: "First decision",
            body: "First local reference owner.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
          {
            operationId: "operation-second",
            type: "create_record",
            localRef: "decision",
            kind: "decision",
            status: "accepted",
            title: "Second decision",
            body: "Duplicate local reference owner.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_records").get(),
    ).toEqual({ count: 1 });
  });

  it("detects self-links after resolving local references", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) =>
        prefix === "record" ? "decision-1" : "relationship-1",
    });

    expect(() =>
      store.applyPreparedChangeSet(
        command([
          {
            operationId: "operation-create",
            type: "create_record",
            localRef: "decision",
            kind: "decision",
            status: "accepted",
            title: "Self-linked decision",
            body: "This record must not link to itself.",
            sourceKind: "agent",
            sourceRef: "change-1",
          },
          {
            operationId: "operation-link",
            type: "create_relationship",
            from: { localRef: "decision" },
            to: { localRef: "decision" },
            kind: "related_to",
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_records").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get(),
    ).toEqual({ count: 0 });
  });

  it("persists proposal operations in order without advancing the project revision", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-predecessor", "change-current"],
      proposal: ["proposal-predecessor", "proposal-current"],
      audit: ["audit-predecessor", "audit-current"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const predecessor = store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: {
        projectId: "project-1",
        baseProjectRevision: 0,
        idempotencyKey: "predecessor-key",
        rationale: "Preserve the stale predecessor.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [
          {
            operationId: "operation-predecessor",
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: { title: "Stale predecessor" },
          },
        ],
      },
      submittedAt: "2026-07-27T12:00:00.000Z",
    });
    expect(predecessor).toEqual({
      outcome: "conflicted",
      changeId: "change-predecessor",
      proposalId: "proposal-predecessor",
      state: "conflicted",
      currentProjectRevision: 1,
      replayed: false,
    });

    const operations: ChangeOperation[] = [
      {
        operationId: "operation-update",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { title: "Review the persisted proposal" },
      },
      {
        operationId: "operation-create",
        type: "create_record",
        localRef: "decision",
        kind: "decision",
        status: "provisional",
        title: "Proposal persistence",
        body: "Keep proposal operations ordered.",
      },
      {
        operationId: "operation-link",
        type: "create_relationship",
        from: { recordId: "task-1" },
        to: { localRef: "decision" },
        kind: "decided_by",
      },
    ];
    const result = store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "scoped_direct",
      scopeDecision: "scope_fallback",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "current-key",
        rationale: "Review this ordered change set.",
        sourceTaskId: "task-1",
        predecessorProposalId: "proposal-predecessor",
        operations,
      },
      submittedAt: "2026-07-27T12:01:00.000Z",
    });

    expect(result).toEqual({
      outcome: "proposed",
      changeId: "change-current",
      proposalId: "proposal-current",
      state: "pending",
      replayed: false,
    });
    expect(store.getProposal("proposal-current")).toEqual({
      id: "proposal-current",
      projectId: "project-1",
      origin: { type: "profile", profileId: "profile-1" },
      sourceTaskId: "task-1",
      predecessorProposalId: "proposal-predecessor",
      baseProjectRevision: 1,
      state: "pending",
      rationale: "Review this ordered change set.",
      idempotencyKey: "current-key",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewReason: null,
      reviewerActor: null,
      createdAt: "2026-07-27T12:01:00.000Z",
      updatedAt: "2026-07-27T12:01:00.000Z",
      reviewedAt: null,
      operations,
    });
    expect(store.listProposals({ projectId: "project-1" })).toEqual([
      expect.objectContaining({
        id: "proposal-current",
        state: "pending",
        createdAt: "2026-07-27T12:01:00.000Z",
      }),
      expect.objectContaining({
        id: "proposal-predecessor",
        state: "conflicted",
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    ]);
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
  });

  it("rechecks rotated credential generation inside the proposal transaction", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    db.prepare(
      "UPDATE client_profiles SET token_rotated_at = ? WHERE id = ?",
    ).run("2026-07-27T12:01:00.000Z", "profile-1");
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-rotated`,
    });
    const proposal = {
      ...proposalCommand([{
        operationId: "operation-update",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { title: "Must not be proposed" },
      }]),
      credentialGeneration: timestamp,
    };

    expect(() => store.createProposal(proposal)).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "invalid_profile_credentials",
        message: "invalid_profile_credentials",
      }),
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM change_proposals").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE actor_type = 'profile'",
      ).get(),
    ).toEqual({ count: 0 });
  });

  it("validates proposal provenance before reserving an idempotency key", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    insertProfile(db, "profile-2");
    insertRecord(db, decisionRecord());
    const ids = {
      change: ["change-other"],
      proposal: ["proposal-other"],
      audit: ["audit-other"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal({
      profileId: "profile-2",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: {
        projectId: "project-1",
        baseProjectRevision: 0,
        idempotencyKey: "other-key",
        rationale: "Create another profile's conflicted proposal.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-other",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "Other" },
        }],
      },
      submittedAt: timestamp,
    });

    const invalidInputs = [
      {
        idempotencyKey: "invalid-source",
        sourceTaskId: "decision-existing",
        predecessorProposalId: null,
      },
      {
        idempotencyKey: "invalid-predecessor",
        sourceTaskId: "task-1",
        predecessorProposalId: "proposal-other",
      },
    ];
    for (const invalid of invalidInputs) {
      expect(() =>
        store.createProposal({
          profileId: "profile-1",
          credentialGeneration: timestamp,
          authorityMode: "proposal",
          scopeDecision: "proposal_mode",
          input: {
            projectId: "project-1",
            baseProjectRevision: 1,
            rationale: "Reject invalid provenance.",
            operations: [{
              operationId: "operation-invalid",
              type: "update_record",
              recordId: "task-1",
              expectedRecordRevision: 1,
              patch: { title: "Invalid" },
            }],
            ...invalid,
          },
          submittedAt: timestamp,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GovernanceError>>({
          code: "validation_failed",
        }),
      );
      expect(
        store.getIdempotencyResult({
          profileId: "profile-1",
          projectId: "project-1",
          idempotencyKey: invalid.idempotencyKey,
        }),
      ).toBeNull();
    }
  });

  it("replays matching proposal idempotency and commits audited hash conflicts", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-1"],
      proposal: ["proposal-1"],
      audit: ["audit-created", "audit-replay", "audit-conflict"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const command: CreateProposalCommand = {
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: {
        projectId: " project-1 ",
        baseProjectRevision: 1,
        idempotencyKey: " proposal-key ",
        rationale: " Persist this proposal. ",
        sourceTaskId: " task-1 ",
        predecessorProposalId: null,
        operations: [{
          operationId: " operation-update ",
          type: "update_record",
          recordId: " task-1 ",
          expectedRecordRevision: 1,
          patch: { title: " Normalized title " },
        }],
      },
      submittedAt: timestamp,
    };

    const first = store.createProposal(command);
    const replay = store.createProposal({
      ...command,
      submittedAt: "2026-07-27T12:05:00.000Z",
    });
    const conflict = store.createProposal({
      ...command,
      input: {
        ...command.input,
        rationale: "A different normalized request.",
      },
      submittedAt: "2026-07-27T12:06:00.000Z",
    });

    expect(first).toEqual({
      outcome: "proposed",
      changeId: "change-1",
      proposalId: "proposal-1",
      state: "pending",
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(conflict).toEqual({
      outcome: "rejected",
      changeId: "change-1",
      code: "idempotency_conflict",
      reason: "The idempotency key was already used for a different request",
      replayed: false,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM change_proposals").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      store.getIdempotencyResult({
        profileId: "profile-1",
        projectId: "project-1",
        idempotencyKey: "proposal-key",
      }),
    ).toEqual(
      expect.objectContaining({
        changeId: "change-1",
        outcome: "proposed",
        requestHash:
          "82c84f7377f8e7222ec3a1f628fda8221cf6469c15fcbf9978fdd7584fc762d6",
        result: first,
      }),
    );
    expect(
      store.listAuditEvents({
        profileId: "profile-1",
        idempotencyKey: "proposal-key",
        limit: 10,
      }).map(({ actionCategory, outcome, reason }) => ({
        actionCategory,
        outcome,
        reason,
      })),
    ).toEqual([
      {
        actionCategory: "idempotency_conflict",
        outcome: "rejected",
        reason: "The idempotency key was already used for a different request",
      },
      {
        actionCategory: "idempotent_replay",
        outcome: "proposed",
        reason: null,
      },
      {
        actionCategory: "proposal_created",
        outcome: "proposed",
        reason: "Persist this proposal.",
      },
    ]);
  });

  it("binds forced coordination conflict semantics into proposal idempotency", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-normal", "change-forced"],
      proposal: ["proposal-normal", "proposal-forced"],
      audit: [
        "audit-normal", "audit-semantic-conflict", "audit-normal-replay",
        "audit-create-semantic-conflict", "audit-forced", "audit-forced-replay",
        "audit-forced-resolve", "audit-reverse-conflict",
      ],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const operation: ChangeOperation = {
      operationId: "operation-semantic-idempotency",
      type: "update_record",
      recordId: "task-1",
      expectedRecordRevision: 1,
      patch: { title: "Semantically bound proposal" },
    };
    const normal = proposalCommand([operation], { idempotencyKey: "semantic-normal" });
    const forced = {
      ...proposalCommand([operation], { idempotencyKey: "semantic-forced" }),
      forceConflict: true,
    };

    expect(store.createProposal(normal)).toMatchObject({
      outcome: "proposed", proposalId: "proposal-normal", replayed: false,
    });
    expect(store.resolveSubmissionIdempotency({
      profileId: normal.profileId,
      credentialGeneration: normal.credentialGeneration,
      input: normal.input,
      resolvedAt: timestamp,
      forceConflict: true,
    })).toMatchObject({
      outcome: "rejected", code: "idempotency_conflict", replayed: false,
    });
    expect(store.resolveSubmissionIdempotency({
      profileId: normal.profileId,
      credentialGeneration: normal.credentialGeneration,
      input: normal.input,
      resolvedAt: timestamp,
    })).toMatchObject({
      outcome: "proposed", proposalId: "proposal-normal", replayed: true,
    });
    expect(store.createProposal({ ...normal, forceConflict: true })).toMatchObject({
      outcome: "rejected", code: "idempotency_conflict", replayed: false,
    });
    const firstForced = store.createProposal(forced);
    expect(firstForced).toMatchObject({
      outcome: "conflicted", proposalId: "proposal-forced", replayed: false,
    });
    expect(store.createProposal(forced)).toEqual({ ...firstForced, replayed: true });
    expect(store.resolveSubmissionIdempotency({
      profileId: forced.profileId,
      credentialGeneration: forced.credentialGeneration,
      input: forced.input,
      resolvedAt: timestamp,
      forceConflict: true,
    })).toEqual({ ...firstForced, replayed: true });
    expect(store.createProposal({ ...forced, forceConflict: false })).toMatchObject({
      outcome: "rejected", code: "idempotency_conflict", replayed: false,
    });
    expect(db.prepare(`
      SELECT change_proposals.id, change_proposals.state,
             change_proposals.request_hash, idempotency_results.request_hash AS replay_hash
      FROM change_proposals
      JOIN idempotency_results ON idempotency_results.change_id =
        (SELECT change_id FROM idempotency_results AS owned
         WHERE owned.profile_id = change_proposals.profile_id
           AND owned.project_id = change_proposals.project_id
           AND owned.idempotency_key = change_proposals.idempotency_key)
      ORDER BY change_proposals.id
    `).all()).toEqual([
      {
        id: "proposal-forced", state: "conflicted",
        request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        replay_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        id: "proposal-normal", state: "pending",
        request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        replay_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const hashes = db.prepare("SELECT DISTINCT request_hash FROM idempotency_results").pluck().all();
    expect(hashes).toHaveLength(2);
  });

  it("does not reserve proposal idempotency when envelope validation fails", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const store = createGovernanceStore(db, {
      newId: (prefix) => `unused-${prefix}`,
    });

    expect(() =>
      store.createProposal({
        profileId: "profile-1",
        credentialGeneration: timestamp,
        authorityMode: "proposal",
        scopeDecision: "proposal_mode",
        input: {
          projectId: "project-1",
          baseProjectRevision: 1,
          idempotencyKey: "invalid-key",
          rationale: " ",
          sourceTaskId: "task-1",
          predecessorProposalId: null,
          operations: [],
        },
        submittedAt: timestamp,
      }),
    ).toThrow();
    expect(
      store.getIdempotencyResult({
        profileId: "profile-1",
        projectId: "project-1",
        idempotencyKey: "invalid-key",
      }),
    ).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects an idempotency result whose validated JSON disagrees with its row", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-1"],
      proposal: ["proposal-1"],
      audit: ["audit-1"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "corrupt-key",
        rationale: "Create a result to corrupt.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-update",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "Proposal" },
        }],
      },
      submittedAt: timestamp,
    });
    db.prepare(
      `UPDATE idempotency_results
       SET result_json = ?
       WHERE profile_id = 'profile-1' AND idempotency_key = 'corrupt-key'`,
    ).run(JSON.stringify({
      outcome: "proposed",
      changeId: "different-change",
      proposalId: "proposal-1",
      state: "pending",
      replayed: false,
    }));

    expect(() =>
      store.getIdempotencyResult({
        profileId: "profile-1",
        projectId: "project-1",
        idempotencyKey: "corrupt-key",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "internal_error",
      }),
    );
  });

  it.each([
    [
      "invalid outcome",
      `UPDATE idempotency_results
       SET outcome = 'unexpected'
       WHERE profile_id = 'profile-1' AND idempotency_key = 'history-key'`,
    ],
    [
      "malformed result JSON",
      `UPDATE idempotency_results
       SET result_json = 'not-json'
       WHERE profile_id = 'profile-1' AND idempotency_key = 'history-key'`,
    ],
    [
      "invalid proposal state",
      `UPDATE change_proposals
       SET state = 'unexpected'
       WHERE profile_id = 'profile-1' AND idempotency_key = 'history-key'`,
    ],
  ])("rejects profile history with %s", (_case, corruptSql) => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-history"],
      proposal: ["proposal-history"],
      audit: ["audit-history"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "history-key",
        rationale: "Create profile history to validate.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-history",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "History proposal" },
        }],
      },
      submittedAt: timestamp,
    });
    db.pragma("ignore_check_constraints = ON");
    db.exec(corruptSql);

    expect(() =>
      store.listProfileChanges({ profileId: "profile-1" }),
    ).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "internal_error",
      }),
    );
  });

  it("applies a direct submission once and replays the complete stored result", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-direct"],
      proposal: [],
      audit: ["audit-applied", "audit-replay"],
      record: ["decision-direct"],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const direct: ApplyDirectCommand = {
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "direct-key",
        rationale: "Apply once.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-create",
          type: "create_record",
          localRef: "decision",
          kind: "decision",
          status: "accepted",
          title: "Direct decision",
          body: "Create this record once.",
        }],
      },
      completedAt: timestamp,
    };

    const first = store.applyDirect(direct);
    const replay = store.applyDirect({
      ...direct,
      completedAt: "2026-07-27T12:05:00.000Z",
    });

    expect(first).toEqual({
      outcome: "applied",
      changeId: "change-direct",
      projectId: "project-1",
      revisionBefore: 1,
      revisionAfter: 2,
      operations: [{
        operationId: "operation-create",
        type: "create_record",
        record: {
          id: "decision-direct",
          projectId: "project-1",
          kind: "decision",
          status: "accepted",
          title: "Direct decision",
          body: "Create this record once.",
          sourceKind: "agent",
          sourceRef: "profile-1",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }],
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM project_records WHERE id = 'decision-direct'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      store.getIdempotencyResult({
        profileId: "profile-1",
        projectId: "project-1",
        idempotencyKey: "direct-key",
      })?.result,
    ).toEqual(first);
  });

  it("rechecks profile security inside the direct transaction after outer revalidation", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    const principal: AuthenticatedProfile = {
      id: "profile-1",
      name: "Profile profile-1",
      status: "enabled",
      credentialGeneration: timestamp,
    };
    expect(
      createProfileStore(db).revalidatePrincipal(principal),
    ).toEqual(principal);
    concurrentDatabase
      .prepare("UPDATE client_profiles SET status = 'disabled' WHERE id = ?")
      .run(principal.id);
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-race`,
    });
    const direct = {
      profileId: principal.id,
      credentialGeneration: principal.credentialGeneration,
      authorityMode: "full_direct" as const,
      scopeDecision: "full_direct",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "disabled-race",
        rationale: "This must not pass the transaction security check.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "create-after-disable",
          type: "create_record" as const,
          kind: "decision" as const,
          status: "provisional" as const,
          title: "Must not exist",
          body: "Disablement won the race before the write transaction.",
        }],
      },
      completedAt: timestamp,
    };

    expect(() => store.applyDirect(direct)).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "profile_disabled",
        message: "profile_disabled",
      }),
    );
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM project_records WHERE kind = 'decision'",
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE actor_type = 'profile'",
      ).get(),
    ).toEqual({ count: 0 });
  });

  it("rechecks route idempotency before mutable provenance inspection", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-direct"],
      proposal: [],
      audit: ["audit-applied", "audit-replayed"],
      record: ["decision-direct"],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const direct: ApplyDirectCommand = {
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "route-replay",
        rationale: "Replay before inspecting mutable provenance.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-create",
          type: "create_record",
          kind: "decision",
          status: "accepted",
          title: "Direct decision",
          body: "The stored result must survive later provenance changes.",
        }],
      },
      completedAt: timestamp,
    };
    const first = store.applyDirect(direct);
    db.prepare(
      "DELETE FROM project_record_revisions WHERE record_id = 'task-1'",
    ).run();
    db.prepare("DELETE FROM project_records WHERE id = 'task-1'").run();

    expect(store.applyDirect({
      ...direct,
      completedAt: "2026-07-27T12:05:00.000Z",
    })).toEqual({ ...first, replayed: true });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
  });

  it("serializes two-connection identical direct submissions exactly once", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    concurrentDatabase.pragma("busy_timeout = 0");
    const secondStore = createGovernanceStore(concurrentDatabase, {
      newId: (prefix) => `second-${prefix}`,
    });
    const direct: ApplyDirectCommand = {
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "concurrent-identical",
        rationale: "Serialize identical first submissions.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-create",
          type: "create_record",
          kind: "decision",
          status: "accepted",
          title: "Exactly once",
          body: "Only one connection may apply this record.",
        }],
      },
      completedAt: timestamp,
    };
    let concurrentError: unknown;
    const firstIds = {
      change: ["change-first"],
      audit: ["audit-first"],
      record: ["record-first"],
      proposal: [],
      relationship: [],
    };
    const firstStore = createGovernanceStore(db, {
      newId: (prefix) => {
        if (prefix === "record") {
          try {
            secondStore.applyDirect(direct);
          } catch (error) {
            concurrentError = error;
          }
        }
        return firstIds[prefix].shift() ?? `unexpected-${prefix}`;
      },
    });

    const first = firstStore.applyDirect(direct);
    const replay = secondStore.applyDirect({
      ...direct,
      completedAt: "2026-07-27T12:01:00.000Z",
    });

    expect(concurrentError).toMatchObject({ code: "SQLITE_BUSY" });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM project_records WHERE id = 'record-first'",
      ).get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 1 });
  });

  it("replays the first committed result across proposal and direct submission paths", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-proposal", "change-direct"],
      proposal: ["proposal-1"],
      audit: [
        "audit-proposed",
        "audit-proposed-replay",
        "audit-applied",
        "audit-applied-replay",
      ],
      record: ["decision-direct"],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const proposalInput: CreateProposalCommand["input"] = {
      projectId: "project-1",
      baseProjectRevision: 1,
      idempotencyKey: "proposal-first-key",
      rationale: "Keep the first proposal result.",
      sourceTaskId: "task-1",
      predecessorProposalId: null,
      operations: [{
        operationId: "operation-proposed",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { title: "Proposed title" },
      }],
    };
    const proposed = store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: proposalInput,
      submittedAt: "2026-07-27T12:00:00.000Z",
    });
    const proposalReplay: SubmissionResult = store.applyDirect({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "authority_upgraded",
      input: proposalInput,
      completedAt: "2026-07-27T12:01:00.000Z",
    });
    expect(proposalReplay).toEqual({ ...proposed, replayed: true });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });

    const directInput: ApplyDirectCommand["input"] = {
      projectId: "project-1",
      baseProjectRevision: 1,
      idempotencyKey: "direct-first-key",
      rationale: "Keep the first applied result.",
      sourceTaskId: "task-1",
      predecessorProposalId: null,
      operations: [{
        operationId: "operation-direct",
        type: "create_record",
        kind: "decision",
        status: "accepted",
        title: "Direct decision",
        body: "Apply only once across routing changes.",
      }],
    };
    const applied = store.applyDirect({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
      input: directInput,
      completedAt: "2026-07-27T12:02:00.000Z",
    });
    const directReplay: SubmissionResult = store.createProposal({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "authority_downgraded",
      input: directInput,
      submittedAt: "2026-07-27T12:03:00.000Z",
    });
    expect(directReplay).toEqual({ ...applied, replayed: true });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 2 });
    expect(
      db
        .prepare(
          `SELECT authority_mode, scope_decision
           FROM audit_events
           WHERE action_category = 'idempotent_replay'
           ORDER BY created_at`,
        )
        .all(),
    ).toEqual([
      {
        authority_mode: "full_direct",
        scope_decision: "authority_upgraded",
      },
      {
        authority_mode: "proposal",
        scope_decision: "authority_downgraded",
      },
    ]);
  });

  it("stores direct project and record revision conflicts for stable replay", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-project-conflict", "change-record-conflict"],
      proposal: [],
      audit: ["audit-project-conflict", "audit-record-conflict"],
      record: [],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const base: ApplyDirectCommand = {
      profileId: "profile-1",
      credentialGeneration: timestamp,
      authorityMode: "scoped_direct",
      scopeDecision: "scope-1",
      input: {
        projectId: "project-1",
        baseProjectRevision: 0,
        idempotencyKey: "project-conflict-key",
        rationale: "Detect stale direct changes.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-update",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "Never applied" },
        }],
      },
      completedAt: timestamp,
    };

    const projectConflict = store.applyDirect(base);
    const recordConflict = store.applyDirect({
      ...base,
      input: {
        ...base.input,
        baseProjectRevision: 1,
        idempotencyKey: "record-conflict-key",
        operations: [{
          ...base.input.operations[0]!,
          expectedRecordRevision: 2,
        }],
      },
    });

    expect(projectConflict).toEqual({
      outcome: "conflicted",
      changeId: "change-project-conflict",
      code: "project_revision_conflict",
      currentProjectRevision: 1,
      expectedProjectRevision: 0,
      replayed: false,
    });
    expect(recordConflict).toEqual({
      outcome: "conflicted",
      changeId: "change-record-conflict",
      code: "record_revision_conflict",
      currentProjectRevision: 1,
      recordId: "task-1",
      expectedRecordRevision: 2,
      actualRecordRevision: 1,
      replayed: false,
    });
    expect(
      db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
    ).toEqual({ revision: 1 });
    expect(
      db.prepare("SELECT title FROM project_records WHERE id = 'task-1'").get(),
    ).toEqual({ title: "Implement authoritative changes" });
    expect(
      store.listProfileChanges({ profileId: "profile-1" }),
    ).toEqual([
      expect.objectContaining({
        changeId: "change-record-conflict",
        outcome: "conflicted",
      }),
      expect.objectContaining({
        changeId: "change-project-conflict",
        outcome: "conflicted",
      }),
    ]);
  });

  it("returns profile-private proposal changes and clamps newest-first audit queries", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    insertProfile(db, "profile-2");
    const ids = {
      change: ["change-profile-1", "change-profile-2"],
      proposal: ["proposal-profile-1", "proposal-profile-2"],
      audit: ["audit-b", "audit-a"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    for (const [profileId, idempotencyKey] of [
      ["profile-1", "shared-key"],
      ["profile-2", "shared-key"],
    ] as const) {
      store.createProposal({
        profileId,
        credentialGeneration: timestamp,
        authorityMode: "proposal",
        scopeDecision: "proposal_mode",
        input: {
          projectId: "project-1",
          baseProjectRevision: 1,
          idempotencyKey,
          rationale: `Proposal from ${profileId}.`,
          sourceTaskId: "task-1",
          predecessorProposalId: null,
          operations: [{
            operationId: `operation-${profileId}`,
            type: "update_record",
            recordId: "task-1",
            expectedRecordRevision: 1,
            patch: { title: `Title ${profileId}` },
          }],
        },
        submittedAt: timestamp,
      });
    }

    expect(store.listProfileChanges({
      profileId: "profile-1",
      projectId: "project-1",
    })).toEqual([{
      changeId: "change-profile-1",
      profileId: "profile-1",
      projectId: "project-1",
      outcome: "proposed",
      proposalId: "proposal-profile-1",
      state: "pending",
      createdAt: timestamp,
    }]);
    expect(store.getProfileChange("profile-1", "change-profile-2")).toBeNull();
    expect(store.getProfileChange("profile-1", "change-profile-1")).toEqual(
      expect.objectContaining({
        changeId: "change-profile-1",
        idempotencyKey: "shared-key",
        result: expect.objectContaining({
          proposalId: "proposal-profile-1",
        }),
        proposal: expect.objectContaining({
          id: "proposal-profile-1",
          operations: [
            expect.objectContaining({
              operationId: "operation-profile-1",
              expectedRecordRevision: 1,
            }),
          ],
        }),
      }),
    );
    expect(store.listAuditEvents({ limit: 0 })).toHaveLength(1);
    expect(store.listAuditEvents({ limit: 999 })).toHaveLength(2);
    expect(
      store.listAuditEvents({ limit: 10 }).map(({ id }) => id),
    ).toEqual(["audit-b", "audit-a"]);
  });

  it("inspects operation authorization facts in order without mutating records", () => {
    const db = setup();
    insertRecord(db, decisionRecord());
    const relationship: RecordRelationship = {
      id: "relationship-existing",
      projectId: "project-1",
      fromRecordId: "task-1",
      toRecordId: "decision-existing",
      kind: "decided_by",
      createdAt: timestamp,
    };
    insertRelationship(db, relationship);
    const store = createGovernanceStore(db, {
      newId: () => "unused",
    });

    expect(
      store.inspectChangeSet("project-1", [
        {
          operationId: "operation-update",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "Inspected only" },
        },
        {
          operationId: "operation-create",
          type: "create_record",
          localRef: "decision",
          kind: "decision",
          status: "provisional",
          title: "Local decision",
          body: "Inspect local relationship kinds.",
        },
        {
          operationId: "operation-link",
          type: "create_relationship",
          from: { recordId: "task-1" },
          to: { localRef: "decision" },
          kind: "depends_on",
        },
        {
          operationId: "operation-remove",
          type: "remove_relationship",
          relationshipId: "relationship-existing",
        },
      ]),
    ).toEqual({
      projectRevision: 1,
      operations: [
        {
          operationId: "operation-update",
          operationType: "update_record",
          recordKind: "task",
          fromRecordKind: null,
          toRecordKind: null,
          relationshipKind: null,
        },
        {
          operationId: "operation-create",
          operationType: "create_record",
          recordKind: "decision",
          fromRecordKind: null,
          toRecordKind: null,
          relationshipKind: null,
        },
        {
          operationId: "operation-link",
          operationType: "create_relationship",
          recordKind: null,
          fromRecordKind: "task",
          toRecordKind: "decision",
          relationshipKind: "depends_on",
        },
        {
          operationId: "operation-remove",
          operationType: "remove_relationship",
          recordKind: null,
          fromRecordKind: "task",
          toRecordKind: "decision",
          relationshipKind: "decided_by",
        },
      ],
    });
    expect(
      db.prepare("SELECT title, revision FROM project_records WHERE id = 'task-1'").get(),
    ).toEqual({
      title: "Implement authoritative changes",
      revision: 1,
    });
  });

  it("applies a human change at the project revision captured inside one transaction", () => {
    const db = setup();
    const ids = {
      change: ["change-human"],
      audit: ["audit-human"],
      record: ["record-human"],
      proposal: [],
      relationship: [],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });

    const result = store.applyHumanChange({
      projectId: "project-1",
      rationale: "Create project record",
      operations: [{
        operationId: "human-create-record",
        type: "create_record",
        kind: "evidence",
        status: "accepted",
        title: "Repository evidence",
        body: "Preserve the original human source.",
        sourceKind: "repository",
        sourceRef: "docs/evidence.md",
      }],
      completedAt: timestamp,
    });

    expect(result).toEqual({
      outcome: "applied",
      projectId: "project-1",
      revisionBefore: 1,
      revisionAfter: 2,
      operations: [{
        operationId: "human-create-record",
        type: "create_record",
        record: {
          id: "record-human",
          projectId: "project-1",
          kind: "evidence",
          status: "accepted",
          title: "Repository evidence",
          body: "Preserve the original human source.",
          sourceKind: "repository",
          sourceRef: "docs/evidence.md",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }],
    });
    expect(
      db.prepare(
        `SELECT actor_type, profile_id, authority_mode, scope_decision,
                action_category, target_id, idempotency_key, revision_before,
                revision_after, outcome, reason
         FROM audit_events WHERE id = 'audit-human'`,
      ).get(),
    ).toEqual({
      actor_type: "local_human",
      profile_id: null,
      authority_mode: "human",
      scope_decision: "human_admin",
      action_category: "change_applied",
      target_id: "change-human",
      idempotency_key: null,
      revision_before: 1,
      revision_after: 2,
      outcome: "applied",
      reason: "Create project record",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 0 });
  });

  it("replays an idempotent human change before revision validation without allocating IDs", () => {
    const db = setup();
    const ids = ["change-first", "audit-first", "record-first"];
    const store = createGovernanceStore(db, {
      newId: () => ids.shift() ?? "unexpected-id",
    });
    const humanChange = replaySafeIdeaChange(
      "The response may be lost after commit.",
    );

    const first = store.applyHumanChange(humanChange);
    const replay = store.applyHumanChange({
      ...humanChange,
      expectedProjectRevision: 0,
    });

    expect(replay).toEqual(first);
    expect(ids).toEqual([]);
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get())
      .toEqual({ revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_records WHERE kind = 'idea'").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT request_hash, result_json FROM human_change_idempotency_results").get())
      .toEqual({
        request_hash: humanChange.idempotency!.requestHash,
        result_json: JSON.stringify(first),
      });
  });

  it("loads a replay result blob only after resolving one exact canonical key", () => {
    const db = setup();
    const guardedDatabase = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (source: string) => {
            const selectsReplayBlob = /^\s*SELECT[\s\S]*\bresult_json\b[\s\S]*\bFROM\s+human_change_idempotency_results\b/i
              .test(source);
            const hasExactLookup = /\bproject_id\s*=\s*@projectId\b/i.test(source) &&
              /\boperation_scope\s*=\s*@operationScope\b/i.test(source) &&
              /\bidempotency_key\s*=\s*@key\b/i.test(source);
            if (selectsReplayBlob && !hasExactLookup) {
              throw new Error("unbounded replay result blob scan");
            }
            return target.prepare(source);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as IntentArcDatabase;
    const store = createGovernanceStore(guardedDatabase, {
      newId: (prefix) => `${prefix}-bounded-replay`,
    });
    const change = replaySafeIdeaChange(
      "Resolve metadata before loading the exact replay result.",
      "capture-request-bounded-replay",
    );

    const first = store.applyHumanChange(change);

    expect(store.applyHumanChange({
      ...change,
      expectedProjectRevision: 0,
    })).toEqual(first);
  });

  it.each([
    ["result project", (stored: any) => ({ ...stored, projectId: "project-2" })],
    ["operation project", (stored: any) => ({
      ...stored,
      operations: stored.operations.map((operation: any) => ({
        ...operation,
        record: { ...operation.record, projectId: "project-2" },
      })),
    })],
    ["project revision sequence", (stored: any) => ({
      ...stored,
      revisionAfter: stored.revisionBefore,
    })],
  ])("rejects a replay whose %s disagrees with its lookup", (_label, mutate) => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-semantic-replay`,
    });
    const change = replaySafeIdeaChange(
      "Keep lookup and result ownership aligned.",
      "capture-request-semantic",
    );
    store.applyHumanChange(change);
    const row = db.prepare(`
      SELECT result_json
      FROM human_change_idempotency_results
      WHERE project_id = 'project-1'
    `).get() as { result_json: string };
    db.prepare(`
      UPDATE human_change_idempotency_results
      SET result_json = ?
      WHERE project_id = 'project-1'
    `).run(JSON.stringify(mutate(JSON.parse(row.result_json))));

    expect(() => store.applyHumanChange(change)).toThrowError(
      expect.objectContaining({ code: "internal_error" }),
    );
  });

  it.each([
    ["idea status", (row: any) => {
      row.result.operations[0].record.status = "accepted";
    }],
    ["idea provenance", (row: any) => {
      row.result.operations[0].record.sourceRef = "web:other";
    }],
    ["derived idea title", (row: any) => {
      row.result.operations[0].record.title = "Tampered title";
    }],
    ["normalized idea body", (row: any) => {
      row.result.operations[0].record.body = "Tampered body";
    }],
    ["canonical raw idea title", (row: any) => {
      row.result.operations[0].record.title =
        ` ${row.result.operations[0].record.title} `;
    }],
    ["canonical raw idea body", (row: any) => {
      row.result.operations[0].record.body =
        ` ${row.result.operations[0].record.body} `;
    }],
    ["canonical request hash", (row: any) => {
      row.request_hash = "b".repeat(64);
    }],
    ["related context ordering", (row: any) => {
      const replayPayload = JSON.parse(row.result.replayPayloadJson);
      replayPayload.context[0].id = "task-other";
      row.result.replayPayloadJson = JSON.stringify(replayPayload);
    }],
    ["context kind snapshot", (row: any) => {
      const replayPayload = JSON.parse(row.result.replayPayloadJson);
      replayPayload.context[0].kind = "component";
      row.result.replayPayloadJson = JSON.stringify(replayPayload);
    }],
    ["context title snapshot", (row: any) => {
      const replayPayload = JSON.parse(row.result.replayPayloadJson);
      replayPayload.context[0].title = "Different but valid context title";
      row.result.replayPayloadJson = JSON.stringify(replayPayload);
    }],
    ["context status snapshot", (row: any) => {
      const replayPayload = JSON.parse(row.result.replayPayloadJson);
      replayPayload.context[0].status = "blocked";
      row.result.replayPayloadJson = JSON.stringify(replayPayload);
    }],
    ["operation shape", (row: any) => {
      row.result.operations[1].relationship.kind = "depends_on";
    }],
    ["canonical raw relationship target", (row: any) => {
      row.result.operations[1].relationship.toRecordId =
        ` ${row.result.operations[1].relationship.toRecordId} `;
    }],
    ["canonical operation scope", (row: any) => {
      row.operation_scope = " idea_capture ";
    }],
    ["canonical idempotency key", (row: any) => {
      row.idempotency_key = " capture-request-semantic ";
    }],
  ])("rejects a semantically tampered idea replay with invalid %s", (_label, mutate) => {
    const db = setup();
    const body = "Replay semantics\nKeep the stored response exact.";
    const requestHash = createHash("sha256").update(JSON.stringify({
      v: 1,
      projectId: "project-1",
      expectedProjectRevision: 1,
      body,
      contextRecordIds: ["task-1"],
    })).digest("hex");
    const change = {
      projectId: "project-1",
      expectedProjectRevision: 1,
      rationale: "Capture replay semantics.",
      operations: [{
        operationId: "human-capture-idea",
        type: "create_record" as const,
        localRef: "captured-idea",
        kind: "idea" as const,
        status: "provisional" as const,
        title: "Replay semantics",
        body,
        sourceKind: "human" as const,
        sourceRef: "web:idea-capture",
      }, {
        operationId: "human-link-idea-context-1",
        type: "create_relationship" as const,
        from: { localRef: "captured-idea" },
        to: { recordId: "task-1" },
        kind: "related_to" as const,
      }],
      completedAt: timestamp,
      idempotency: {
        operationScope: "idea_capture",
        key: "capture-request-semantic",
        requestHash,
        replayPayloadJson: serializeIdeaCaptureReplayPayload({
          projectId: "project-1",
          operationScope: "idea_capture",
          idempotencyKey: "capture-request-semantic",
          requestHash,
        }, [{
          projectId: "project-1",
          id: "task-1",
          kind: "task",
          title: taskRecord().title,
          status: "active",
        }]),
      },
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-semantic-replay`,
    });
    store.applyHumanChange(change);
    const stored = db.prepare(`
      SELECT operation_scope, idempotency_key, request_hash, result_json
      FROM human_change_idempotency_results
      WHERE project_id = 'project-1'
    `).get() as {
      operation_scope: string;
      idempotency_key: string;
      request_hash: string;
      result_json: string;
    };
    const tampered = {
      ...stored,
      result: JSON.parse(stored.result_json),
    };
    mutate(tampered);
    db.prepare(`
      UPDATE human_change_idempotency_results
      SET operation_scope = ?, idempotency_key = ?, request_hash = ?,
          result_json = ?
      WHERE project_id = 'project-1'
    `).run(
      tampered.operation_scope,
      tampered.idempotency_key,
      tampered.request_hash,
      JSON.stringify(tampered.result),
    );

    expect(() => store.applyHumanChange(change)).toThrowError(
      expect.objectContaining({ code: "internal_error" }),
    );
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get())
      .toEqual({ revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_records WHERE kind = 'idea'").get())
      .toEqual({ count: 1 });
  });

  it("rejects an overlong human-change idempotency key before mutation", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-overlong-key`,
    });

    expect(() => store.applyHumanChange({
      projectId: "project-1",
      expectedProjectRevision: 1,
      rationale: "Reject an overlong replay key.",
      operations: [{
        operationId: "human-capture-idea",
        type: "create_record",
        kind: "idea",
        status: "provisional",
        title: "Overlong key",
        body: "Overlong key",
        sourceKind: "human",
        sourceRef: "web:idea-capture",
      }],
      completedAt: timestamp,
      idempotency: {
        operationScope: "idea_capture",
        key: "x".repeat(129),
        requestHash: "a".repeat(64),
        replayPayloadJson: "[]",
      },
    })).toThrow();
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get())
      .toEqual({ revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM human_change_idempotency_results").get())
      .toEqual({ count: 0 });
  });

  it("rejects a changed human request under an existing idempotency key without mutation", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-once`,
    });
    const change = replaySafeIdeaChange("Original body");
    store.applyHumanChange(change);
    const before = db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get();

    expect(() => store.applyHumanChange({
      ...change,
      idempotency: { ...change.idempotency, requestHash: "b".repeat(64) },
    })).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get())
      .toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_records WHERE kind = 'idea'").get())
      .toEqual({ count: 1 });
  });

  it("persists an idempotent human replay across a database reopen", () => {
    const db = setup();
    const change = replaySafeIdeaChange("Persist the exact result.");
    const first = createGovernanceStore(db, { newId: (prefix) => `${prefix}-first` })
      .applyHumanChange(change);
    db.close();
    database = undefined;
    const reopened = openDatabase(temporaryDatabase!.path);
    database = reopened;

    expect(createGovernanceStore(reopened, { newId: () => "unexpected-id" })
      .applyHumanChange({ ...change, expectedProjectRevision: 0 }))
      .toEqual(first);
  });

  it("rolls back every authoritative write when the replay-row insert fails late", () => {
    const db = setup();
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-late-replay`,
    });
    const body = "Rollback the complete context-bearing idea change.";
    const base = replaySafeIdeaChange(body, "capture-request-late-replay");
    const change: ApplyHumanChangeCommand = {
      ...base,
      operations: [...base.operations, {
        operationId: "human-link-idea-context-1",
        type: "create_relationship",
        from: { localRef: "captured-idea" },
        to: { recordId: "task-1" },
        kind: "related_to",
      }],
      idempotency: {
        ...base.idempotency!,
        requestHash: createHash("sha256").update(JSON.stringify({
          v: 1,
          projectId: "project-1",
          expectedProjectRevision: 1,
          body,
          contextRecordIds: ["task-1"],
        })).digest("hex"),
      },
    };
    change.idempotency!.replayPayloadJson = serializeIdeaCaptureReplayPayload({
      projectId: "project-1",
      operationScope: "idea_capture",
      idempotencyKey: change.idempotency!.key,
      requestHash: change.idempotency!.requestHash,
    }, [{
      projectId: "project-1",
      id: "task-1",
      kind: "task",
      title: taskRecord().title,
      status: "active",
    }]);
    const authoritativeState = () => ({
      project: db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get(),
      records: db.prepare("SELECT COUNT(*) AS count FROM project_records").get(),
      ideas: db.prepare("SELECT COUNT(*) AS count FROM project_records WHERE kind = 'idea'").get(),
      relationships: db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get(),
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
      replays: db.prepare("SELECT COUNT(*) AS count FROM human_change_idempotency_results").get(),
    });
    const before = authoritativeState();

    db.exec(`
      CREATE TRIGGER reject_late_human_change_replay
      BEFORE INSERT ON human_change_idempotency_results
      BEGIN
        SELECT RAISE(ABORT, 'reject late human change replay');
      END
    `);
    try {
      expect(() => store.applyHumanChange(change)).toThrowError(
        /reject late human change replay/,
      );
    } finally {
      db.exec("DROP TRIGGER reject_late_human_change_replay");
    }

    expect(authoritativeState()).toEqual(before);

    const applied = store.applyHumanChange(change);
    expect(applied.revisionAfter).toBe(2);
    expect(authoritativeState()).toEqual({
      project: { revision: 2 },
      records: { count: 2 },
      ideas: { count: 1 },
      relationships: { count: 1 },
      audits: { count: 1 },
      replays: { count: 1 },
    });

    expect(store.applyHumanChange({
      ...change,
      expectedProjectRevision: 0,
    })).toEqual(applied);
    expect(authoritativeState()).toEqual({
      project: { revision: 2 },
      records: { count: 2 },
      ideas: { count: 1 },
      relationships: { count: 1 },
      audits: { count: 1 },
      replays: { count: 1 },
    });
  });

  it("validates the final parent hierarchy before writing any operation", () => {
    const db = setup(taskRecord({ id: "outcome-1", kind: "outcome", title: "Outcome" }));
    insertRecord(db, taskRecord({ id: "milestone-1", kind: "milestone", title: "Milestone" }));
    insertRecord(db, taskRecord({ id: "task-1", kind: "task", title: "Task" }));
    insertRecord(db, decisionRecord({ id: "decision-1" }));
    insertRelationship(db, {
      id: "parent-existing",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "milestone-1",
      kind: "parent_of",
      createdAt: timestamp,
    });
    let generated = 0;
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-${generated += 1}`,
    });

    const invalidOperations: PreparedChangeOperation[][] = [
      [{ operationId: "self", type: "create_relationship", from: { recordId: "task-1" }, to: { recordId: "task-1" }, kind: "parent_of" }],
      [{ operationId: "cycle", type: "create_relationship", from: { recordId: "milestone-1" }, to: { recordId: "outcome-1" }, kind: "parent_of" }],
      [{ operationId: "second-parent", type: "create_relationship", from: { recordId: "task-1" }, to: { recordId: "milestone-1" }, kind: "parent_of" }],
      [{ operationId: "bad-parent-kind", type: "create_relationship", from: { recordId: "decision-1" }, to: { recordId: "task-1" }, kind: "parent_of" }],
      [
        { operationId: "batch-cycle-a", type: "create_relationship", from: { recordId: "milestone-1" }, to: { recordId: "task-1" }, kind: "parent_of" },
        { operationId: "batch-cycle-b", type: "create_relationship", from: { recordId: "task-1" }, to: { recordId: "outcome-1" }, kind: "parent_of" },
      ],
      [
        { operationId: "batch-parent-a", type: "create_relationship", from: { recordId: "outcome-1" }, to: { recordId: "task-1" }, kind: "parent_of" },
        { operationId: "batch-parent-b", type: "create_relationship", from: { recordId: "milestone-1" }, to: { recordId: "task-1" }, kind: "parent_of" },
      ],
    ];

    for (const operations of invalidOperations) {
      expect(() => store.applyPreparedChangeSet(command(operations))).toThrowError(
        expect.objectContaining({ code: "validation_failed" }),
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get()).toEqual({ revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
  });

  it("accepts deep parent chains and ordinary cross-links without recursive traversal", () => {
    const db = setup(taskRecord({ id: "node-0", kind: "outcome" }));
    const depth = 1_200;
    for (let index = 1; index <= depth; index += 1) {
      insertRecord(db, taskRecord({ id: `node-${index}`, kind: "task", title: `Node ${index}` }));
      insertRelationship(db, {
        id: `parent-${index}`,
        projectId: "project-1",
        fromRecordId: `node-${index - 1}`,
        toRecordId: `node-${index}`,
        kind: "parent_of",
        createdAt: timestamp,
      });
    }
    insertRecord(db, decisionRecord({ id: "decision-1" }));
    const ids = ["relationship-related", "change-human", "audit-human"];
    const store = createGovernanceStore(db, { newId: () => ids.shift() ?? "unexpected" });

    const result = store.applyHumanChange({
      projectId: "project-1",
      expectedProjectRevision: 1,
      rationale: "Add an ordinary cross-link",
      operations: [{
        operationId: "related",
        type: "create_relationship",
        from: { recordId: `node-${depth}` },
        to: { recordId: "decision-1" },
        kind: "related_to",
      }],
      completedAt: timestamp,
    });

    expect(result.revisionAfter).toBe(2);
  });

  it("keeps an invalid hierarchy proposal pending and rolls back its acceptance", () => {
    const db = setup(taskRecord({ id: "outcome-1", kind: "outcome" }));
    insertRecord(db, taskRecord({ id: "milestone-1", kind: "milestone" }));
    insertRelationship(db, {
      id: "parent-existing",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "milestone-1",
      kind: "parent_of",
      createdAt: timestamp,
    });
    insertProfile(db, "profile-1");
    const ids = {
      change: ["change-cycle"],
      proposal: ["proposal-cycle"],
      audit: ["audit-created", "audit-apply-unused"],
      relationship: ["relationship-cycle"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    store.createProposal(proposalCommand([{
      operationId: "cycle",
      type: "create_relationship",
      from: { recordId: "milestone-1" },
      to: { recordId: "outcome-1" },
      kind: "parent_of",
    }], { idempotencyKey: "cycle-proposal", sourceTaskId: null }));

    expect(() => store.acceptProposal({
      proposalId: "proposal-cycle",
      reason: null,
      reviewedAt: timestamp,
    })).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(store.getProposal("proposal-cycle")).toMatchObject({
      state: "pending",
      reviewedAt: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get()).toEqual({ revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
  });

  it("rejects a stale human relationship removal without deleting or auditing", () => {
    const db = setup(taskRecord({ id: "outcome-1", kind: "outcome" }));
    insertRecord(db, taskRecord({ id: "task-1", kind: "task" }));
    insertRelationship(db, {
      id: "parent-existing",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      createdAt: timestamp,
    });
    const store = createGovernanceStore(db, {
      newId: (prefix) => `${prefix}-unused`,
    });

    expect(() => store.applyHumanChange({
      projectId: "project-1",
      expectedProjectRevision: 0,
      rationale: "Remove stale parent",
      operations: [{
        operationId: "remove-parent",
        type: "remove_relationship",
        relationshipId: "parent-existing",
      }],
      completedAt: timestamp,
    })).toThrowError(expect.objectContaining({ code: "project_revision_conflict" }));
    expect(db.prepare("SELECT id FROM record_relationships WHERE id = 'parent-existing'").get())
      .toEqual({ id: "parent-existing" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
  });

  it("audits an exact-revision human removal once and rejects its replay", () => {
    const db = setup(taskRecord({ id: "outcome-1", kind: "outcome" }));
    insertRecord(db, taskRecord({ id: "task-1", kind: "task" }));
    insertRelationship(db, {
      id: "parent-existing",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      createdAt: timestamp,
    });
    const ids = {
      change: ["change-remove", "change-replay"],
      audit: ["audit-remove", "audit-replay"],
    };
    const store = createGovernanceStore(db, {
      newId: (prefix) => ids[prefix].shift() ?? `unexpected-${prefix}`,
    });
    const removal = {
      projectId: "project-1",
      expectedProjectRevision: 1,
      rationale: "Remove parent relationship",
      operations: [{
        operationId: "remove-parent",
        type: "remove_relationship" as const,
        relationshipId: "parent-existing",
      }],
      completedAt: timestamp,
    };

    expect(store.applyHumanChange(removal)).toMatchObject({
      revisionBefore: 1,
      revisionAfter: 2,
      operations: [{ type: "remove_relationship" }],
    });
    expect(() => store.applyHumanChange(removal)).toThrowError(
      expect.objectContaining({ code: "project_revision_conflict" }),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT revision FROM projects WHERE id = 'project-1'").get()).toEqual({ revision: 2 });
    expect(db.prepare("SELECT id, revision_before, revision_after FROM audit_events").all()).toEqual([
      { id: "audit-remove", revision_before: 1, revision_after: 2 },
    ]);
  });

  it("stores a sanitized missing-authority rejection and its audit atomically", () => {
    const db = setup();
    insertProfile(db, "profile-1");
    const store = createGovernanceStore(db, {
      newId: (prefix) =>
        prefix === "change"
          ? "change-rejected"
          : prefix === "audit"
          ? "audit-rejected"
          : "unexpected-id",
    });

    expect(store.recordSubmissionRejection({
      profileId: "profile-1",
      credentialGeneration: timestamp,
      input: {
        projectId: "project-1",
        baseProjectRevision: 1,
        idempotencyKey: "request-denied",
        rationale: "Reject without project authority.",
        sourceTaskId: "task-1",
        predecessorProposalId: null,
        operations: [{
          operationId: "operation-denied",
          type: "update_record",
          recordId: "task-1",
          expectedRecordRevision: 1,
          patch: { title: "Must not change" },
        }],
      },
      rejectedAt: timestamp,
    })).toEqual({
      outcome: "rejected",
      changeId: "change-rejected",
      code: "project_authority_missing",
      reason: "project_authority_missing",
      replayed: false,
    });
    expect(
      db.prepare(
        `SELECT actor_type, profile_id, authority_mode, scope_decision,
                action_category, target_id, idempotency_key, revision_before,
                revision_after, outcome, reason
         FROM audit_events WHERE id = 'audit-rejected'`,
      ).get(),
    ).toEqual({
      actor_type: "profile",
      profile_id: "profile-1",
      authority_mode: null,
      scope_decision: "authority_missing",
      action_category: "submission_rejected",
      target_id: "change-rejected",
      idempotency_key: "request-denied",
      revision_before: 1,
      revision_after: 1,
      outcome: "rejected",
      reason: "project_authority_missing",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_results").get(),
    ).toEqual({ count: 1 });
  });
});
