import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  outboundDestinationSnapshotSchema,
  outboundDisclosureSchema,
  outboundFindingCountsSchema,
  outboundReleaseSchema,
  projectRecordSchema,
  neutralHierarchyVocabulary,
  simpleHierarchyVocabulary,
  softwareHierarchyVocabulary,
  taskContextPackSchema,
  coordinationIdempotencyOperations,
  type OutboundDestinationSnapshot,
  type OutboundRelease,
  type TaskContextPack,
} from "../domain/index.js";
import { openDatabase } from "../storage/database.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { createProjectStore } from "../storage/project-store.js";
import { createIdeaService } from "../core/idea-service.js";
import {
  coordinationEventsNoDeleteTriggerSql,
  coordinationEventsNoUpdateTriggerSql,
  migrations,
  repositoryImportReceiptsNoDeleteTriggerSql,
  repositoryImportReceiptsNoUpdateTriggerSql,
  repositoryImportReceiptsTableSql,
  taskSubmissionsImmutableFieldsTriggerSql,
  taskSubmissionsNoDeleteTriggerSql,
  taskCheckpointsNoUpdateTriggerSql,
} from "../storage/migrations.js";
import {
  computeOutboundReleaseDigest,
  createOutboundSafetyEngine,
  OUTBOUND_DETECTOR_VERSION,
  OUTBOUND_SAFETY_POLICY_VERSION,
} from "../outbound/safety-engine.js";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createIntegrityChecker } from "./integrity.js";
import {
  integrityIssueDescriptionFor,
  integrityIssueSchema,
} from "./model.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;
const importManifestDigest = "b".repeat(64);
const importRepositoryFingerprint = "c".repeat(64);
const importRecordOne = {
  id: "record-import-1",
  projectId: "project-import",
  kind: "vision",
  status: "active",
  title: "Imported vision",
  body: "The initial imported vision.",
  sourceKind: "repository",
  sourceRef: "README.md",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const importRecordTwo = {
  id: "record-import-2",
  projectId: "project-import",
  kind: "task",
  status: "active",
  title: "Imported task",
  body: "The initial imported task.",
  sourceKind: "repository",
  sourceRef: "docs/plan.md",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const importInitialSnapshot = {
  version: 1,
  projectId: "project-import",
  recordIds: ["record-import-1", "record-import-2"],
  relationships: [{
    id: "relationship-import-1",
    fromRecordId: "record-import-2",
    toRecordId: "record-import-1",
    kind: "implements",
  }],
} as const;
const importInitialSnapshotJson = JSON.stringify(importInitialSnapshot);
const importInitialSnapshotDigest = createHash("sha256")
  .update(importInitialSnapshotJson, "utf8")
  .digest("hex");
const requestHash = createHash("sha256").update(JSON.stringify({
  projectId: "project-1",
  taskId: "task-1",
  budgetTokens: 4000,
  destinationId: "destination-1",
  destinationRevision: 1,
  detectorVersion: OUTBOUND_DETECTOR_VERSION,
  safetyPolicyVersion: OUTBOUND_SAFETY_POLICY_VERSION,
}), "utf8").digest("hex");

const coordinationObjects = [
  ["table", "task_claims"],
  ["table", "task_checkpoints"],
  ["table", "task_delegations"],
  ["table", "task_submissions"],
  ["table", "coordination_events"],
  ["table", "coordination_idempotency"],
  ["index", "idx_task_claims_one_active"],
  ["index", "idx_task_claims_one_submitted"],
  ["index", "idx_task_delegations_one_live"],
  ["trigger", "task_checkpoints_no_update"],
  ["trigger", "task_checkpoints_no_delete"],
  ["trigger", "task_submissions_immutable_fields"],
  ["trigger", "task_submissions_no_delete"],
  ["trigger", "coordination_events_no_update"],
  ["trigger", "coordination_events_no_delete"],
  ["trigger", "coordination_proposal_state_sync"],
] as const;
const coordinationMutationOperations = [
  coordinationIdempotencyOperations.claim,
  coordinationIdempotencyOperations.renew,
  coordinationIdempotencyOperations.checkpoint,
  coordinationIdempotencyOperations.transition,
  coordinationIdempotencyOperations.switch,
  coordinationIdempotencyOperations.createDelegation,
  coordinationIdempotencyOperations.acceptDelegation,
  coordinationIdempotencyOperations.revokeDelegation,
  coordinationIdempotencyOperations.submit,
] as const;

describe("integrity checker", () => {
  const temporaries: TemporaryDatabase[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const fixture = (version: 1 | 2 = 2) => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = createVersionedDatabaseFixture(temporary.path, version);
    database.close();
    return temporary.path;
  };

  const schemaTenDatabase = (): Database.Database => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = new Database(temporary.path);
    for (const migration of migrations.filter(({ version }) => version <= 10)) {
      database.exec(migration.sql);
      migration.initialize?.(database, { storeId: "store-schema-ten", now: timestamp });
    }
    database.pragma("user_version = 10");
    return database;
  };

  const checker = () => createIntegrityChecker({ now: () => timestamp });

  const hierarchyDatabase = () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-hierarchy",
    });
    const generatedIds: Record<string, string[]> = {
      project: ["project-hierarchy"],
      audit: ["audit-hierarchy"],
      record: [
        "record-outcome",
        "record-initiative",
        "record-deliverable",
        "record-task",
        "record-decision",
      ],
    };
    const fallbackIds: Record<string, number> = {};
    const store = createProjectStore(database, {
      now: () => timestamp,
      newId: (prefix) => generatedIds[prefix]?.shift() ??
        `${prefix}-extra-${fallbackIds[prefix] = (fallbackIds[prefix] ?? 0) + 1}`,
    });
    const project = store.createProject({ name: "Hierarchy integrity" });
    for (const [kind, title] of [
      ["outcome", "Outcome"],
      ["initiative", "Initiative"],
      ["deliverable", "Deliverable"],
      ["task", "Task"],
      ["decision", "Decision"],
    ] as const) {
      store.createRecord({
        projectId: project.id,
        kind,
        status: "active",
        title,
        body: `${title} body.`,
        sourceKind: "human",
        sourceRef: null,
      });
    }
    return { database, store };
  };

  const restoreRepositoryImportEvidenceTriggers = (
    database: Database.Database,
  ): void => {
    database.exec(`
      CREATE TRIGGER repository_import_receipts_no_update
      BEFORE UPDATE ON repository_import_receipts
      BEGIN
        SELECT RAISE(ABORT, 'repository import receipts are append-only');
      END;
      CREATE TRIGGER repository_import_receipts_no_delete
      BEFORE DELETE ON repository_import_receipts
      BEGIN
        SELECT RAISE(ABORT, 'repository import receipts are append-only');
      END;
      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;
      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;
    `);
  };

  const mutateRepositoryImportEvidence = (
    database: Database.Database,
    mutate: () => void,
  ): void => {
    database.exec(`
      DROP TRIGGER repository_import_receipts_no_update;
      DROP TRIGGER repository_import_receipts_no_delete;
      DROP TRIGGER audit_events_no_update;
      DROP TRIGGER audit_events_no_delete;
    `);
    database.pragma("ignore_check_constraints = ON");
    mutate();
    database.pragma("ignore_check_constraints = OFF");
    restoreRepositoryImportEvidenceTriggers(database);
  };

  const repositoryImportDatabase = (): Database.Database => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-import",
    });
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-import', 'Imported project', 1, 'C:/synthetic/repository',
        '${timestamp}', '${timestamp}'
      );
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-other', 'Other project', 1, NULL,
        '${timestamp}', '${timestamp}'
      );
    `);
    const insertRecord = database.prepare(`
      INSERT INTO project_records VALUES (
        @id, @projectId, @kind, @status, @title, @body, @sourceKind,
        @sourceRef, @revision, @createdAt, @updatedAt
      )
    `);
    const insertRevision = database.prepare(`
      INSERT INTO project_record_revisions VALUES (
        @id, @revision, @snapshotJson, @createdAt
      )
    `);
    for (const record of [importRecordOne, importRecordTwo]) {
      insertRecord.run(record);
      insertRevision.run({
        id: record.id,
        revision: record.revision,
        snapshotJson: JSON.stringify(record),
        createdAt: record.createdAt,
      });
    }
    database.exec(`
      INSERT INTO record_relationships VALUES (
        'relationship-import-1', 'project-import',
        'record-import-2', 'record-import-1', 'implements', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO repository_import_receipts (
        manifest_digest, project_id, repository_fingerprint, scanner_version,
        ruleset_version, manifest_version, record_count, relationship_count,
        initial_snapshot_digest, initial_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importManifestDigest,
      "project-import",
      importRepositoryFingerprint,
      "1",
      "1",
      1,
      2,
      1,
      importInitialSnapshotDigest,
      importInitialSnapshotJson,
      timestamp,
    );
    database.exec(`
      INSERT INTO audit_events VALUES (
        'audit-import', 'project-import', 'local_human', NULL, 'human',
        'human_import', 'repository_import_applied', 'project-import', NULL,
        0, 1, 'applied', NULL, '${timestamp}'
      );
    `);
    return database;
  };

  const coordinationDatabase = (): Database.Database => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-coordination",
    });
    const task = {
      id: "task-coordination",
      projectId: "project-coordination",
      kind: "task",
      status: "active",
      title: "Coordinate durable work",
      body: "Keep one authoritative coordination history.",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const pack: TaskContextPack = {
      id: "pack-coordination",
      projectId: task.projectId,
      taskId: task.id,
      projectRevision: 1,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 80,
      stableFrame: [],
      task: { record: task, mandatory: true, relevance: "active_task", relationshipKind: null },
      related: [],
      omissions: [],
      sourceRevisions: [{ recordId: task.id, revision: 1 }],
    };
    const checkpoint = {
      summary: "Durable checkpoint",
      completedWork: ["schema"],
      remainingWork: ["service"],
      blockers: [],
      verificationEvidence: { tests: ["focused"], artifacts: [] },
      repositoryEvidence: null,
    };
    const operation = {
      operationId: "keep-task-active",
      type: "update_record",
      recordId: task.id,
      expectedRecordRevision: 1,
      patch: { status: "active" },
    };
    const submission = {
      summary: "Submit coordinated work",
      verificationEvidence: { tests: ["focused"], artifacts: [] },
      repositoryEvidence: null,
      changes: { rationale: "Preserve the reviewed work.", operations: [operation] },
    };
    const claim = {
      id: "claim-coordination",
      projectId: task.projectId,
      taskId: task.id,
      profileId: "profile-coordination",
      delegationId: null,
      state: "submitted",
      baseProjectRevision: 1,
      baseTaskRevision: 1,
      contextPackId: pack.id,
      acquiredAt: timestamp,
      expiresAt: "2026-07-27T12:30:00.000Z",
      absoluteExpiresAt: "2026-07-27T16:00:00.000Z",
      endedAt: timestamp,
      latestCheckpointId: "checkpoint-coordination",
    } as const;
    const storedCheckpoint = {
      id: "checkpoint-coordination",
      claimId: claim.id,
      sequence: 1,
      createdAt: timestamp,
      ...checkpoint,
      projectRevision: 1,
      taskRevision: 1,
      contextPackId: pack.id,
    };
    const delegation = {
      id: "delegation-coordination",
      projectId: task.projectId,
      taskId: task.id,
      parentProfileId: "profile-coordination",
      childProfileId: "profile-coordination",
      state: "offered",
      baseProjectRevision: 1,
      baseTaskRevision: 1,
      scope: { summary: "Coordinate this task.", constraints: [] },
      allowedOutputs: ["update_record"],
      offeredAt: timestamp,
      deadline: "2026-07-27T13:00:00.000Z",
      acceptedAt: null,
      endedAt: null,
      claimId: null,
    } as const;
    const storedSubmission = {
      id: "submission-coordination",
      claimId: claim.id,
      checkpointId: storedCheckpoint.id,
      profileId: claim.profileId,
      projectId: task.projectId,
      taskId: task.id,
      baseProjectRevision: 1,
      baseTaskRevision: 1,
      contextPackId: pack.id,
      summary: submission.summary,
      verificationEvidence: submission.verificationEvidence,
      repositoryEvidence: submission.repositoryEvidence,
      proposalId: "proposal-coordination",
      state: "submitted",
      submittedAt: timestamp,
      decidedAt: null,
    } as const;
    const proposal = {
      id: storedSubmission.proposalId,
      projectId: task.projectId,
      origin: { type: "profile", profileId: claim.profileId },
      sourceTaskId: task.id,
      predecessorProposalId: null,
      baseProjectRevision: 1,
      state: "pending",
      rationale: submission.changes.rationale,
      idempotencyKey: "proposal-key",
      requestHash: "b".repeat(64),
      reviewReason: null,
      reviewerActor: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewedAt: null,
    } as const;
    database.prepare(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, 1, NULL, ?, ?)
    `).run(task.projectId, "Coordination", timestamp, timestamp);
    database.prepare(`
      INSERT INTO project_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.projectId, task.kind, task.status, task.title, task.body,
      task.sourceKind, task.sourceRef, task.revision, task.createdAt, task.updatedAt);
    database.prepare(`INSERT INTO project_record_revisions VALUES (?, 1, ?, ?)`)
      .run(task.id, JSON.stringify(task), timestamp);
    database.prepare(`
      INSERT INTO client_profiles VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
    `).run("profile-coordination", "Coordinator", "a".repeat(64), timestamp, timestamp, timestamp);
    database.prepare(`
      INSERT INTO profile_project_authorities VALUES (?, ?, ?, 'proposal', ?, ?)
    `).run("authority-coordination", "profile-coordination", task.projectId, timestamp, timestamp);
    database.prepare(`
      INSERT INTO context_packs VALUES (?, ?, ?, 1, 4000, 80, ?, ?)
    `).run(pack.id, pack.projectId, pack.taskId, JSON.stringify(pack), timestamp);
    database.prepare(`
      INSERT INTO task_claims (
        id, project_id, task_id, profile_id, delegation_id, state,
        base_project_revision, base_task_revision, context_pack_id,
        acquired_at, expires_at, absolute_expires_at, ended_at,
        latest_checkpoint_id
      ) VALUES (?, ?, ?, ?, NULL, 'submitted', 1, 1, ?, ?, ?, ?, ?, ?)
    `).run("claim-coordination", task.projectId, task.id, "profile-coordination", pack.id,
      timestamp, "2026-07-27T12:30:00.000Z", "2026-07-27T16:00:00.000Z",
      timestamp, "checkpoint-coordination");
    database.prepare(`
      INSERT INTO task_checkpoints (
        id, claim_id, sequence, document_json, created_at,
        project_revision, task_revision, context_pack_id
      ) VALUES (?, ?, 1, ?, ?, 1, 1, ?)
    `).run("checkpoint-coordination", "claim-coordination", JSON.stringify(checkpoint), timestamp, pack.id);
    database.prepare(`
      INSERT INTO change_proposals VALUES (
        ?, ?, ?, ?, NULL, 1, 'pending', ?, ?, ?, NULL, NULL, ?, ?, NULL,
        'profile', NULL
      )
    `).run("proposal-coordination", task.projectId, "profile-coordination", task.id,
      submission.changes.rationale, "proposal-key", "b".repeat(64), timestamp, timestamp);
    database.prepare(`INSERT INTO proposal_operations VALUES (?, 0, ?, ?, 1, ?)`)
      .run("proposal-coordination", operation.operationId, operation.type, JSON.stringify(operation));
    database.prepare(`
      INSERT INTO task_submissions (
        id, claim_id, checkpoint_id, profile_id, project_id, task_id,
        base_project_revision, base_task_revision, context_pack_id,
        document_json, proposal_id, state, submitted_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'submitted', ?, NULL)
    `).run("submission-coordination", "claim-coordination", "checkpoint-coordination",
      "profile-coordination", task.projectId, task.id, pack.id,
      JSON.stringify(submission), "proposal-coordination", timestamp);
    database.prepare(`
      INSERT INTO task_delegations (
        id, project_id, task_id, parent_profile_id, child_profile_id, state,
        base_project_revision, base_task_revision, scope_json,
        allowed_outputs_json, offered_at, deadline, accepted_at, ended_at,
        claim_id
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(delegation.id, delegation.projectId, delegation.taskId,
      delegation.parentProfileId, delegation.childProfileId, delegation.state,
      JSON.stringify(delegation.scope), JSON.stringify(delegation.allowedOutputs),
      delegation.offeredAt, delegation.deadline);
    const insertCoordinationEvent = database.prepare(`
      INSERT INTO coordination_events (
        id, category, project_id, task_id, profile_id, claim_id,
        delegation_id, checkpoint_id, submission_id, proposal_id,
        prior_state, resulting_state, project_revision, task_revision,
        detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?)
    `);
    insertCoordinationEvent.run(
      "event-claim-coordination", "claim", task.projectId, task.id,
      claim.profileId, claim.id, null, null, null, null,
      null, "active", timestamp,
    );
    insertCoordinationEvent.run(
      "event-checkpoint-coordination", "checkpoint", task.projectId, task.id,
      claim.profileId, claim.id, null, storedCheckpoint.id, null, null,
      "active", "active", timestamp,
    );
    insertCoordinationEvent.run(
      "event-submission-coordination", "submission", task.projectId, task.id,
      claim.profileId, claim.id, null, storedCheckpoint.id,
      storedSubmission.id, proposal.id, "active", "submitted", timestamp,
    );
    insertCoordinationEvent.run(
      "event-delegation-offer-coordination", "delegation_offer", task.projectId, task.id,
      delegation.parentProfileId, null, delegation.id, null, null, null,
      null, "offered", timestamp,
    );
    const idempotencyResults = [
      [coordinationIdempotencyOperations.claim, { claim, readiness: {
        task, blockers: [], liveClaimId: null, liveDelegationId: delegation.id,
      }, contextPack: pack }],
      [coordinationIdempotencyOperations.renew, { claim }],
      [coordinationIdempotencyOperations.checkpoint, { claim, checkpoint: storedCheckpoint }],
      [coordinationIdempotencyOperations.transition, { claim }],
      [coordinationIdempotencyOperations.switch, {
        previousClaim: claim, nextClaim: claim, checkpoint: storedCheckpoint,
        contextPack: pack,
      }],
      [coordinationIdempotencyOperations.createDelegation, { delegation }],
      [coordinationIdempotencyOperations.acceptDelegation, { delegation: {
        ...delegation, state: "accepted", acceptedAt: timestamp,
      } }],
      [coordinationIdempotencyOperations.revokeDelegation, { delegation: {
        ...delegation, state: "revoked", endedAt: timestamp,
      } }],
      [coordinationIdempotencyOperations.submit, { claim, submission: storedSubmission, proposal }],
    ] as const;
    const insertIdempotency = database.prepare(`
      INSERT INTO coordination_idempotency (
        profile_id, project_id, operation, idempotency_key,
        request_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [idempotencyOperation, result] of idempotencyResults) {
      insertIdempotency.run(
        claim.profileId,
        task.projectId,
        idempotencyOperation,
        `${idempotencyOperation}-key`,
        "c".repeat(64),
        JSON.stringify(result),
        timestamp,
      );
    }
    return database;
  };

  const seedRepositoryIndex = (database: Database.Database): void => {
    database.exec(`
      INSERT INTO repository_sources VALUES (
        'source-import', 'project-import', 'C:/synthetic/repository', NULL,
        'repository-import', 'available', NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO repository_sources VALUES (
        'source-other', 'project-other', 'C:/synthetic/other', NULL,
        'repository-other', 'available', NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-import', 'source-import', 'project-import', 'accepted', NULL, 1,
        'main', '${"a".repeat(40)}', '${"b".repeat(64)}', '1', '1',
        '{}', '{}', '{}', '${timestamp}', '${timestamp}', '${timestamp}'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-other', 'source-other', 'project-other', 'accepted', NULL, 1,
        'main', '${"c".repeat(40)}', '${"d".repeat(64)}', '1', '1',
        '{}', '{}', '{}', '${timestamp}', '${timestamp}', '${timestamp}'
      );
      UPDATE repository_sources
      SET current_snapshot_id = 'snapshot-import'
      WHERE id = 'source-import';
      UPDATE repository_sources
      SET current_snapshot_id = 'snapshot-other'
      WHERE id = 'source-other';
      INSERT INTO repository_nodes VALUES (
        'node-import', 'source-import', 'file', '${timestamp}'
      );
      INSERT INTO repository_node_observations VALUES (
        'snapshot-import', 'node-import', 'source-import', NULL, 'README.md',
        'file', '${"e".repeat(64)}', 42, 'tracked', 'canonical_source',
        'overview', 'markdown', 1, NULL, NULL
      );
      INSERT INTO repository_links VALUES (
        'link-import', 'project-import', 'snapshot-import', 'source-import',
        'node-import', 'record-import-1', NULL, 'documents', 'observed',
        '${timestamp}'
      );
      INSERT INTO repository_refresh_reviews VALUES (
        'project-import', 'source-import', 'snapshot-import', 'applied',
        '["operation-1"]', '${timestamp}', '${timestamp}', '${timestamp}'
      );
    `);
  };

  const replaceProposalOperationsTable = (
    database: Database.Database,
    replacementSql: string,
  ): void => {
    database.pragma("foreign_keys = OFF");
    database.exec(`
      DROP TRIGGER proposal_operations_no_update;
      DROP TRIGGER proposal_operations_no_delete;
      ALTER TABLE proposal_operations RENAME TO proposal_operations_original;
      ${replacementSql}
      DROP TABLE proposal_operations_original;
      CREATE TRIGGER proposal_operations_no_update
      BEFORE UPDATE ON proposal_operations
      BEGIN
        SELECT RAISE(ABORT, 'proposal operations are immutable');
      END;
      CREATE TRIGGER proposal_operations_no_delete
      BEFORE DELETE ON proposal_operations
      WHEN EXISTS (
        SELECT 1 FROM change_proposals WHERE id = OLD.proposal_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'proposal operations are immutable');
      END;
    `);
    database.pragma("foreign_keys = ON");
  };

  const replaceProposalTableWithBypassableOriginCheck = (
    database: Database.Database,
  ): void => {
    database.pragma("foreign_keys = OFF");
    database.exec(`
      DROP TRIGGER proposal_operations_no_update;
      DROP TRIGGER proposal_operations_no_delete;
      DROP TABLE proposal_operations;
      ALTER TABLE change_proposals RENAME TO change_proposals_original;
      CREATE TABLE change_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        profile_id TEXT REFERENCES client_profiles(id),
        source_task_id TEXT,
        predecessor_proposal_id TEXT REFERENCES change_proposals(id),
        base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'accepted', 'rejected', 'conflicted', 'withdrawn')
        ),
        rationale TEXT NOT NULL,
        idempotency_key TEXT,
        request_hash TEXT,
        review_reason TEXT,
        reviewer_actor TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        origin_type TEXT NOT NULL CHECK (
          origin_type IN ('profile', 'repository_refresh')
        ),
        repository_snapshot_id TEXT,
        CHECK (
          (origin_type = 'profile'
            AND profile_id IS NOT NULL
            AND repository_snapshot_id IS NULL
            AND idempotency_key IS NOT NULL
            AND request_hash IS NOT NULL)
          OR
          (origin_type = 'repository_refresh'
            AND profile_id IS NULL
            AND repository_snapshot_id IS NOT NULL
            AND idempotency_key IS NULL
            AND request_hash IS NULL
            AND source_task_id IS NULL
            AND predecessor_proposal_id IS NULL)
          OR (origin_type = 'repository_refresh' AND profile_id IS NOT NULL)
        ),
        FOREIGN KEY (repository_snapshot_id, project_id)
          REFERENCES repository_snapshots(id, project_id) ON DELETE RESTRICT
      );
      DROP TABLE change_proposals_original;
      CREATE TABLE proposal_operations (
        proposal_id TEXT NOT NULL
          REFERENCES change_proposals(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        expected_record_revision INTEGER CHECK (
          expected_record_revision IS NULL OR expected_record_revision > 0
        ),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (proposal_id, position),
        UNIQUE (proposal_id, operation_id)
      );
      CREATE INDEX idx_change_proposals_project_state_created_at
        ON change_proposals(project_id, state, created_at);
      CREATE UNIQUE INDEX idx_change_proposals_profile_idempotency
        ON change_proposals(profile_id, project_id, idempotency_key)
        WHERE origin_type = 'profile';
      CREATE UNIQUE INDEX idx_change_proposals_repository_snapshot
        ON change_proposals(repository_snapshot_id)
        WHERE origin_type = 'repository_refresh';
      CREATE TRIGGER proposal_operations_no_update
      BEFORE UPDATE ON proposal_operations
      BEGIN
        SELECT RAISE(ABORT, 'proposal operations are immutable');
      END;
      CREATE TRIGGER proposal_operations_no_delete
      BEFORE DELETE ON proposal_operations
      WHEN EXISTS (
        SELECT 1 FROM change_proposals WHERE id = OLD.proposal_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'proposal operations are immutable');
      END;
    `);
    database.pragma("foreign_keys = ON");
  };

  const expectRepositoryImportInvalid = (
    database: Database.Database,
  ): void => {
    const report = checker().checkConnection(database, "full");
    expect(report.passed).toBe(false);
    expect(report.issues.filter(
      ({ code }) => code === "repository_import_state_invalid",
    )).toHaveLength(1);
    database.close();
  };

  const destination: OutboundDestinationSnapshot = {
    id: "destination-1",
    revision: 1,
    clientLabel: "ops@example.invalid",
    type: "ide_managed",
    providerLabel: "OpenAI",
    modelLabel: null,
    accountBoundaryLabel:
      "sk-proj-SyntheticDestinationIntegrityToken0123456789",
    dataBoundary: "remote",
  };
  const pack: TaskContextPack = {
    id: "pack-1",
    projectId: "project-1",
    taskId: "task-1",
    projectRevision: 1,
    generatedAt: timestamp,
    budgetTokens: 4000,
    estimatedTokens: 80,
    hierarchyVocabulary: neutralHierarchyVocabulary,
    stableFrame: [],
    task: {
      record: {
        id: "task-1",
        projectId: "project-1",
        kind: "task",
        status: "active",
        title: "Safe outbound context",
        body: "Contact person@example.com before release.",
        sourceKind: "human",
        sourceRef: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      mandatory: true,
      relevance: "active_task",
      relationshipKind: null,
    },
    related: [],
    omissions: [],
    sourceRevisions: [{ recordId: "task-1", revision: 1 }],
  };

  const seedValidOutboundGraph = (
    database: Database.Database,
    sourcePack: TaskContextPack = pack,
    historicalMissingHierarchyVocabulary = false,
  ): void => {
    const engine = createOutboundSafetyEngine();
    const storedSourcePack = historicalMissingHierarchyVocabulary
      ? (({
        hierarchyVocabulary: _legacyMissingVocabulary,
        ...legacyPack
      }) => legacyPack)(sourcePack)
      : sourcePack;
    const sourcePackShape = {
      hierarchyVocabularyPresent: !historicalMissingHierarchyVocabulary,
    };
    const scan = engine.scanStoredPack(
      storedSourcePack,
      destination,
      sourcePackShape,
    );
    const release = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: storedSourcePack,
      sourcePackShape,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Profile', 'enabled', '${"a".repeat(64)}',
        '${timestamp}', '${timestamp}', '${timestamp}', NULL, 'safe'
      );
      INSERT INTO project_records VALUES (
        'task-1', 'project-1', 'task', 'active',
        'Safe outbound context', 'Contact person@example.com before release.',
        'human', NULL, 1, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions VALUES (
        'task-1', 1, ?, ?
      )
    `).run(JSON.stringify(storedSourcePack.task.record), timestamp);
    database.prepare(`
      INSERT INTO context_packs VALUES (
        'pack-1', 'project-1', 'task-1', 1, 4000, 80, ?, ?
      )
    `).run(JSON.stringify(storedSourcePack), timestamp);
    database.prepare(`
      INSERT INTO outbound_destinations VALUES (
        'destination-1', 1, 'profile-1', 'ops@example.invalid',
        'ide_managed', 'OpenAI', NULL,
        'sk-proj-SyntheticDestinationIntegrityToken0123456789',
        'remote', 'enabled', 1, ?, ?
      )
    `).run(timestamp, timestamp);
    database.prepare(`
      INSERT INTO outbound_policies VALUES (
        'profile-1', 'project-1', 'destination-1', 1, ?, ?, 'manual', ?, ?
      )
    `).run(
      OUTBOUND_DETECTOR_VERSION,
      OUTBOUND_SAFETY_POLICY_VERSION,
      timestamp,
      timestamp,
    );
    database.prepare(`
      INSERT INTO outbound_requests (
        id, profile_id, project_id, task_id, source_pack_id,
        idempotency_key, request_hash, destination_id,
        destination_revision, destination_snapshot_json, detector_version,
        safety_policy_version, candidate_digest, status,
        finding_counts_json, decision_actor, decision_reason, release_id,
        created_at, decided_at
      ) VALUES (
        'request-1', 'profile-1', 'project-1', 'task-1', 'pack-1',
        'key-1', ?, 'destination-1', 1, ?, ?, ?, ?, 'released',
        ?, 'local_human', 'approved', 'release-1', ?, ?
      )
    `).run(
      requestHash,
      JSON.stringify(destination),
      OUTBOUND_DETECTOR_VERSION,
      OUTBOUND_SAFETY_POLICY_VERSION,
      scan.candidateDigest,
      JSON.stringify(release.disclosure.findingCounts),
      timestamp,
      timestamp,
    );
    const insertFinding = database.prepare(`
      INSERT INTO outbound_findings (
        id, request_id, ordinal, detector_id, detector_version, category,
        confidence, severity, field_path, start_offset, end_offset,
        finding_key, required_action, decision
      ) VALUES (
        ?, 'request-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    scan.findings.forEach((finding) => {
      insertFinding.run(
        finding.id,
        finding.ordinal,
        finding.detectorId,
        finding.detectorVersion,
        finding.category,
        finding.confidence,
        finding.severity,
        finding.path,
        finding.start,
        finding.end,
        finding.findingKey,
        finding.requiredAction,
        "redact",
      );
    });
    database.prepare(`
      INSERT INTO outbound_releases (
        id, request_id, source_pack_id, content_json, disclosure_json,
        sha256, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      release.releaseId,
      release.requestId,
      release.sourcePackId,
      JSON.stringify(release.pack),
      JSON.stringify(release.disclosure),
      release.sha256,
      release.releasedAt,
    );
    const insertAudit = database.prepare(`
      INSERT INTO audit_events (
        id, project_id, actor_type, profile_id, authority_mode, scope_decision,
        action_category, target_id, idempotency_key, revision_before,
        revision_after, outcome, reason, created_at
      ) VALUES (
        ?, 'project-1', ?, ?, ?, ?, ?, 'request-1', NULL, NULL, NULL,
        'applied', ?, ?
      )
    `);
    insertAudit.run(
      "audit-request",
      "profile",
      "profile-1",
      null,
      "outbound_safety",
      "outbound_request_created",
      "request_status:review_required",
      timestamp,
    );
    insertAudit.run(
      "audit-scan",
      "profile",
      "profile-1",
      null,
      "outbound_safety",
      "outbound_scan_completed",
      `scan_completed:total:${scan.findings.length};` +
        `credential:${scan.findings.filter(({ severity }) => severity === "credential").length};` +
        `sensitive:${scan.findings.filter(({ severity }) => severity === "sensitive").length};` +
        `forced_redact:${scan.findings.filter(({ requiredAction }) => requiredAction === "forced_redact").length};` +
        `redact_by_default:${scan.findings.filter(({ requiredAction }) => requiredAction === "redact_by_default").length};` +
        `detector_version:${OUTBOUND_DETECTOR_VERSION};` +
        `safety_policy_version:${OUTBOUND_SAFETY_POLICY_VERSION};` +
        "destination_revision:1",
      timestamp,
    );
    insertAudit.run(
      "audit-approve",
      "local_human",
      null,
      "human",
      "human_admin",
      "outbound_request_approved",
      "approved",
      timestamp,
    );
  };

  const outboundDatabase = (
    options: {
      mutableReleases?: boolean;
      sourcePack?: TaskContextPack;
      historicalMissingHierarchyVocabulary?: boolean;
    } = {},
  ): Database.Database => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-outbound",
    });
    if (options.mutableReleases) {
      database.exec(`
        DROP TRIGGER outbound_releases_no_update;
        DROP TRIGGER outbound_releases_no_delete;
      `);
    }
    seedValidOutboundGraph(
      database,
      options.sourcePack,
      options.historicalMissingHierarchyVocabulary,
    );
    return database;
  };

  const restoreReleaseTriggers = (database: Database.Database): void => {
    database.exec(`
      CREATE TRIGGER outbound_releases_no_update
      BEFORE UPDATE ON outbound_releases
      BEGIN
        SELECT RAISE(ABORT, 'outbound releases are immutable');
      END;
      CREATE TRIGGER outbound_releases_no_delete
      BEFORE DELETE ON outbound_releases
      BEGIN
        SELECT RAISE(ABORT, 'outbound releases are immutable');
      END;
    `);
  };

  const rewriteReleaseWithValidDigest = (
    database: Database.Database,
    mutate: (release: OutboundRelease) => OutboundRelease,
  ): void => {
    const row = database.prepare(`
      SELECT
        id, request_id, source_pack_id, content_json, disclosure_json,
        sha256, released_at
      FROM outbound_releases
      WHERE id = 'release-1'
    `).get() as {
      id: string;
      request_id: string;
      source_pack_id: string;
      content_json: string;
      disclosure_json: string;
      sha256: string;
      released_at: string;
    };
    const stored = outboundReleaseSchema.parse({
      releaseId: row.id,
      requestId: row.request_id,
      sourcePackId: row.source_pack_id,
      pack: JSON.parse(row.content_json),
      disclosure: JSON.parse(row.disclosure_json),
      sha256: row.sha256,
      releasedAt: row.released_at,
    });
    const changed = mutate(stored);
    const provisional = outboundReleaseSchema.parse({
      ...changed,
      sha256: "0".repeat(64),
      disclosure: {
        ...changed.disclosure,
        releaseDigest: "0".repeat(64),
      },
    });
    const digest = computeOutboundReleaseDigest(provisional);
    const rewritten = outboundReleaseSchema.parse({
      ...provisional,
      sha256: digest,
      disclosure: {
        ...provisional.disclosure,
        releaseDigest: digest,
      },
    });
    database.prepare(`
      UPDATE outbound_releases
      SET content_json = ?, disclosure_json = ?, sha256 = ?, released_at = ?
      WHERE id = 'release-1'
    `).run(
      JSON.stringify(rewritten.pack),
      JSON.stringify(rewritten.disclosure),
      rewritten.sha256,
      rewritten.releasedAt,
    );
  };

  const expectOutboundInvalid = (database: Database.Database): void => {
    const report = checker().checkConnection(database, "full");
    expect(report.issues.map(({ code }) => code)).toContain(
      "outbound_state_invalid",
    );
    database.close();
  };

  const schemaThreeFixture = (
    rows: readonly {
      singleton: number;
      storeId: string;
      createdAt: string;
    }[] = [{
      singleton: 1,
      storeId: "store-healthy",
      createdAt: timestamp,
    }],
  ): string => {
    const path = fixture(2);
    const database = new Database(path);
    database.exec(`
      CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    database.pragma("ignore_check_constraints = ON");
    const insert = database.prepare(`
      INSERT INTO store_metadata (singleton, store_id, created_at)
      VALUES (?, ?, ?)
    `);
    rows.forEach((row) => {
      insert.run(row.singleton, row.storeId, row.createdAt);
    });
    database.pragma("user_version = 3");
    database.close();
    return path;
  };

  it("accepts version-one and version-two compatibility fixtures", () => {
    const v1Path = fixture(1);
    expect(checker().checkPath(v1Path, "compatibility")).toMatchObject({
      passed: true,
      schemaVersion: 1,
    });

    const v2Path = fixture(2);
    expect(checker().checkPath(v2Path, "compatibility")).toMatchObject({
      passed: true,
      schemaVersion: 2,
    });
  });

  it("accepts one valid version-three metadata row and returns its lineage", () => {
    const path = schemaThreeFixture();

    expect(checker().checkPath(path, "compatibility")).toMatchObject({
      passed: true,
      schemaVersion: 3,
      storeId: "store-healthy",
      issues: [],
    });
  });

  it("accepts the current schema only when its required tables and immutable triggers exist", () => {
    expect(currentSchemaVersion).toBe(11);
    const healthy = repositoryImportDatabase();
    expect(checker().checkConnection(healthy, "compatibility")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-import",
      issues: [],
    });
    healthy.close();

    for (const [type, name] of [
      ["table", "repository_import_receipts"],
      ["trigger", "repository_import_receipts_no_update"],
      ["trigger", "repository_import_receipts_no_delete"],
    ] as const) {
      const database = repositoryImportDatabase();
      if (type === "table") {
        database.exec("DROP TABLE repository_import_receipts");
      } else {
        database.exec(`DROP TRIGGER ${name}`);
      }

      expect(checker().checkConnection(database, "compatibility")).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: [
          expect.objectContaining({ code: "schema_object_missing" }),
        ],
      });
      database.close();
    }
  });

  it.each([
    ["missing hierarchy vocabulary column", null],
    [
      "noncanonical hierarchy vocabulary default",
      `ALTER TABLE projects ADD COLUMN hierarchy_vocabulary_json TEXT NOT NULL
       DEFAULT '{}' CHECK (json_valid(hierarchy_vocabulary_json) AND json_type(hierarchy_vocabulary_json) = 'object')`,
    ],
    [
      "noncanonical hierarchy vocabulary check",
      `ALTER TABLE projects ADD COLUMN hierarchy_vocabulary_json TEXT NOT NULL
       DEFAULT '{"preset":"neutral","outcome":"Outcome","initiative":"Initiative","deliverable":"Deliverable","milestone":"Milestone","task":"Work item","nestedTask":"Subtask"}'
       CHECK (json_valid(hierarchy_vocabulary_json))`,
    ],
  ])("rejects schema eleven with %s", (_name, alteration) => {
    const database = schemaTenDatabase();
    if (alteration) database.exec(alteration);
    database.pragma("user_version = 11");

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      schemaVersion: 11,
      issues: [expect.objectContaining({ code: "schema_object_missing" })],
    });
    database.close();
  });

  it.each([
    ["malformed hierarchy vocabulary JSON", "{bad", "integrity_check_failed"],
    ["incomplete hierarchy vocabulary object", '{"preset":"neutral"}', "stored_json_invalid"],
  ])("rejects a %s stored in a schema-eleven project", (_name, vocabulary, code) => {
    const database = repositoryImportDatabase();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      UPDATE projects SET hierarchy_vocabulary_json = ? WHERE id = 'project-import'
    `).run(vocabulary);
    database.pragma("ignore_check_constraints = OFF");

    expect(checker().checkConnection(database, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code }),
      ]),
    );
    database.close();
  });

  it.each(coordinationObjects)(
    "rejects schema eleven when its required %s %s is missing",
    (type, name) => {
      const database = coordinationDatabase();
      try {
        if (type === "table") database.pragma("foreign_keys = OFF");
        database.exec(`DROP ${type.toUpperCase()} ${name}`);
        if (type === "table") database.pragma("foreign_keys = ON");

        expect(checker().checkConnection(database, "compatibility").issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "schema_object_missing" }),
          ]),
        );
      } finally {
        database.close();
      }
    },
  );

  it("rejects an accepted coordination submission whose exact linked delegation is not completed", () => {
    const database = coordinationDatabase();
    try {
      database.exec("DROP TRIGGER coordination_events_no_update; DROP TRIGGER coordination_events_no_delete;");
      database.exec(`
        UPDATE task_delegations
        SET state = 'claimed', accepted_at = '${timestamp}', claim_id = 'claim-coordination'
        WHERE id = 'delegation-coordination';
        UPDATE task_claims
        SET delegation_id = 'delegation-coordination'
        WHERE id = 'claim-coordination';
        UPDATE change_proposals
        SET state = 'accepted', updated_at = '2026-07-27T13:05:00.000Z',
            reviewed_at = '2026-07-27T13:05:00.000Z'
        WHERE id = 'proposal-coordination';
        DELETE FROM coordination_idempotency;
        UPDATE coordination_events
        SET delegation_id = 'delegation-coordination'
        WHERE id IN ('event-claim-coordination', 'event-submission-coordination');
        INSERT INTO coordination_events VALUES (
          'event-delegation-accept-coordination', 'delegation_accept',
          'project-coordination', 'task-coordination', 'profile-coordination',
          NULL, 'delegation-coordination', NULL, NULL, NULL,
          'offered', 'accepted', 1, 1, NULL, '${timestamp}'
        );
        INSERT INTO coordination_events VALUES (
          'event-reconciliation-coordination', 'reconciliation',
          'project-coordination', 'task-coordination', 'profile-coordination',
          'claim-coordination', 'delegation-coordination', 'checkpoint-coordination',
          'submission-coordination', 'proposal-coordination',
          'submitted', 'reconciled', 1, 1, NULL, '2026-07-27T13:05:00.000Z'
        );
      `);
      database.exec(coordinationEventsNoUpdateTriggerSql);
      database.exec(coordinationEventsNoDeleteTriggerSql);
      expect(checker().checkConnection(database, "full").issues.map(({ code }) => code))
        .not.toContain("coordination_state_invalid");
      database.exec(`
        UPDATE task_delegations
        SET state = 'claimed', ended_at = NULL
        WHERE id = 'delegation-coordination';
      `);

      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("accepts an explicitly released claim after a terminal non-accepted coordination proposal", () => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        UPDATE change_proposals
        SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
            reviewed_at = '2026-07-27T13:00:00.000Z'
        WHERE id = 'proposal-coordination';
        UPDATE task_claims
        SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z'
        WHERE id = 'claim-coordination';
        INSERT INTO coordination_events VALUES (
          'event-release-coordination', 'release', 'project-coordination',
          'task-coordination', 'profile-coordination', 'claim-coordination',
          NULL, NULL, NULL, NULL, 'submitted', 'released', 1, 1, NULL,
          '2026-07-27T13:05:00.000Z'
        );
        DELETE FROM coordination_idempotency;
      `);

      expect(checker().checkConnection(database, "full").issues.map(({ code }) => code))
        .not.toContain("coordination_state_invalid");
    } finally {
      database.close();
    }
  });

  it("accepts linked lazy expiry when the shorter claim lease ends before the delegation deadline", () => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        INSERT INTO task_claims VALUES (
          'claim-shorter-lease-expiry', 'project-coordination', 'task-coordination',
          'profile-coordination', 'delegation-coordination', 'expired', 1, 1,
          'pack-coordination', '${timestamp}', '2026-07-27T12:30:00.000Z',
          '2026-07-27T16:00:00.000Z', '2026-07-27T12:31:00.000Z', NULL
        );
        UPDATE task_delegations
        SET state = 'expired', accepted_at = '${timestamp}',
            ended_at = '2026-07-27T12:31:00.000Z',
            claim_id = 'claim-shorter-lease-expiry'
        WHERE id = 'delegation-coordination';
        INSERT INTO coordination_events VALUES (
          'event-shorter-lease-accept', 'delegation_accept',
          'project-coordination', 'task-coordination', 'profile-coordination',
          NULL, 'delegation-coordination', NULL, NULL, NULL, 'offered',
          'accepted', 1, 1, NULL, '${timestamp}'
        );
        INSERT INTO coordination_events VALUES (
          'event-shorter-lease-claim', 'claim', 'project-coordination',
          'task-coordination', 'profile-coordination', 'claim-shorter-lease-expiry',
          'delegation-coordination', NULL, NULL, NULL, NULL, 'active',
          1, 1, NULL, '${timestamp}'
        );
        INSERT INTO coordination_events VALUES (
          'event-shorter-lease-expiry', 'expiry', 'project-coordination',
          'task-coordination', 'profile-coordination', 'claim-shorter-lease-expiry',
          'delegation-coordination', NULL, NULL, NULL, 'active', 'expired',
          1, 1, NULL, '2026-07-27T12:31:00.000Z'
        );
        DELETE FROM coordination_idempotency;
      `);

      expect(checker().checkConnection(database, "full").issues.map(({ code }) => code))
        .not.toContain("coordination_state_invalid");
    } finally {
      database.close();
    }
  });

  it("accepts a direct released claim with no submission history", () => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        DROP TRIGGER coordination_events_no_delete;
        DROP TRIGGER task_submissions_no_delete;
        DELETE FROM coordination_events WHERE category = 'submission';
        DELETE FROM task_submissions WHERE id = 'submission-coordination';
        DELETE FROM coordination_idempotency;
        UPDATE task_claims
        SET state = 'released', ended_at = '2026-07-27T12:05:00.000Z'
        WHERE id = 'claim-coordination';
        INSERT INTO coordination_events VALUES (
          'event-release-coordination', 'release', 'project-coordination',
          'task-coordination', 'profile-coordination', 'claim-coordination',
          NULL, NULL, NULL, NULL, 'active', 'released', 1, 1, NULL,
          '2026-07-27T12:05:00.000Z'
        );
      `);
      database.exec(coordinationEventsNoDeleteTriggerSql);
      database.exec(taskSubmissionsNoDeleteTriggerSql);

      expect(checker().checkConnection(database, "full").issues.map(({ code }) => code))
        .not.toContain("coordination_state_invalid");
    } finally {
      database.close();
    }
  });

  it("accepts a terminalized exact delegation after explicit release", () => {
    const database = coordinationDatabase();
    try {
      database.exec("DROP TRIGGER coordination_events_no_update; DROP TRIGGER coordination_events_no_delete;");
      database.exec(`
        UPDATE task_delegations
        SET state = 'claimed', accepted_at = '${timestamp}',
            deadline = '2026-07-27T13:00:00.000Z',
            claim_id = 'claim-coordination'
        WHERE id = 'delegation-coordination';
        UPDATE task_claims SET delegation_id = 'delegation-coordination'
        WHERE id = 'claim-coordination';
        UPDATE change_proposals
        SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
            reviewed_at = '2026-07-27T13:00:00.000Z'
        WHERE id = 'proposal-coordination';
        UPDATE task_claims
        SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z'
        WHERE id = 'claim-coordination';
        UPDATE task_delegations
        SET state = 'revoked', ended_at = '2026-07-27T13:05:00.000Z'
        WHERE id = 'delegation-coordination';
        UPDATE coordination_events
        SET delegation_id = 'delegation-coordination'
        WHERE id IN ('event-claim-coordination', 'event-submission-coordination');
        INSERT INTO coordination_events VALUES (
          'event-delegation-accept-coordination', 'delegation_accept',
          'project-coordination', 'task-coordination', 'profile-coordination',
          NULL, 'delegation-coordination', NULL, NULL, NULL,
          'offered', 'accepted', 1, 1, NULL, '${timestamp}'
        );
        INSERT INTO coordination_events VALUES (
          'event-release-coordination', 'release', 'project-coordination',
          'task-coordination', 'profile-coordination', 'claim-coordination',
          'delegation-coordination', NULL, NULL, NULL, 'submitted', 'released',
          1, 1, NULL, '2026-07-27T13:05:00.000Z'
        );
        DELETE FROM coordination_idempotency;
      `);
      database.exec(coordinationEventsNoUpdateTriggerSql);
      database.exec(coordinationEventsNoDeleteTriggerSql);

      expect(checker().checkConnection(database, "full").issues.map(({ code }) => code))
        .not.toContain("coordination_state_invalid");
    } finally {
      database.close();
    }
  });

  it("rejects a released claim whose exact delegation remains live", () => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        UPDATE task_delegations
        SET state = 'claimed', accepted_at = '${timestamp}', claim_id = 'claim-coordination'
        WHERE id = 'delegation-coordination';
        UPDATE task_claims SET delegation_id = 'delegation-coordination'
        WHERE id = 'claim-coordination';
        UPDATE change_proposals
        SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
            reviewed_at = '2026-07-27T13:00:00.000Z'
        WHERE id = 'proposal-coordination';
        UPDATE task_claims
        SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z'
        WHERE id = 'claim-coordination';
        DELETE FROM coordination_idempotency;
      `);

      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("rejects a pending submitted claim whose exact delegation was expired", () => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        UPDATE task_delegations
        SET state = 'expired', accepted_at = '${timestamp}',
            ended_at = '2026-07-27T13:00:00.000Z', claim_id = 'claim-coordination'
        WHERE id = 'delegation-coordination';
        UPDATE task_claims SET delegation_id = 'delegation-coordination'
        WHERE id = 'claim-coordination';
        DELETE FROM coordination_idempotency;
      `);

      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "cross-project task claim",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO projects (
            id, name, revision, primary_repository_path, created_at, updated_at
          ) VALUES (
            'project-coordination-other', 'Other', 1, NULL, '${timestamp}', '${timestamp}'
          );
          UPDATE task_claims
          SET project_id = 'project-coordination-other'
          WHERE id = 'claim-coordination';
        `);
      },
      code: "coordination_state_invalid",
    },
    {
      label: "invalid checkpoint JSON",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_checkpoints SET document_json = '{"summary":1}'
          WHERE id = 'checkpoint-coordination'
        `);
      },
      code: "stored_json_invalid",
    },
    {
      label: "invalid claim state",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_claims SET state = 'unknown'
          WHERE id = 'claim-coordination'
        `);
      },
      code: "coordination_state_invalid",
    },
    {
      label: "malformed checkpoint metadata",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_checkpoints SET created_at = 'not-a-timestamp'
          WHERE id = 'checkpoint-coordination'
        `);
      },
      code: "coordination_state_invalid",
    },
    {
      label: "dangling delegation claim",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_delegations SET claim_id = 'claim-missing'
          WHERE id = 'delegation-coordination'
        `);
      },
      code: "coordination_state_invalid",
    },
    {
      label: "invalid submit replay result",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_idempotency SET result_json = '{}'
          WHERE operation = '${coordinationIdempotencyOperations.submit}'
        `);
      },
      code: "stored_json_invalid",
    },
    {
      label: "non-monotonic checkpoint sequence",
      mutate(database: Database.Database) {
        database.prepare(`
          INSERT INTO task_checkpoints (
            id, claim_id, sequence, document_json, created_at,
            project_revision, task_revision, context_pack_id
          ) SELECT 'checkpoint-gap', claim_id, 3, document_json, created_at,
                   project_revision, task_revision, context_pack_id
            FROM task_checkpoints WHERE id = 'checkpoint-coordination'
        `).run();
      },
      code: "coordination_state_invalid",
    },
    {
      label: "submission proposal for another task",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO project_records VALUES (
            'task-coordination-other', 'project-coordination', 'task', 'active',
            'Other task', 'Other task body', 'human', NULL, 1,
            '${timestamp}', '${timestamp}'
          );
          UPDATE change_proposals
          SET source_task_id = 'task-coordination-other'
          WHERE id = 'proposal-coordination';
        `);
      },
      code: "coordination_state_invalid",
    },
  ])("reports a coordination boundary violation for $label", ({ mutate, code }) => {
    const database = coordinationDatabase();
    try {
      database.pragma("foreign_keys = OFF");
      database.pragma("ignore_check_constraints = ON");
      database.exec(`
        DROP TRIGGER task_checkpoints_no_update;
        DROP TRIGGER task_submissions_immutable_fields;
      `);
      mutate(database);
      database.pragma("ignore_check_constraints = OFF");
      database.pragma("foreign_keys = ON");

      const issueCodes = checker().checkConnection(database, "full")
        .issues.map((issue) => issue.code);
      expect(issueCodes).toContain(code);
    } finally {
      database.close();
    }
  });

  it.each(coordinationMutationOperations)(
    "rejects an invalid %s idempotency replay result",
    (operation) => {
      const database = coordinationDatabase();
      try {
        database.prepare(`
          UPDATE coordination_idempotency SET result_json = '{}'
          WHERE operation = ?
        `).run(operation);

        expect(checker().checkConnection(database, "full").issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "stored_json_invalid" }),
          ]),
        );
      } finally {
        database.close();
      }
    },
  );

  it.each([
    {
      label: "claim result delegation linkage",
      operation: coordinationIdempotencyOperations.claim,
      mutate(result: any) {
        result.claim.delegationId = "delegation-coordination";
      },
    },
    {
      label: "delegation result claim linkage",
      operation: coordinationIdempotencyOperations.createDelegation,
      mutate(result: any) {
        result.delegation.claimId = "claim-coordination";
      },
    },
    {
      label: "submission result context-pack linkage",
      operation: coordinationIdempotencyOperations.submit,
      mutate(result: any) {
        result.submission.contextPackId = "pack-mismatch";
      },
    },
  ])("rejects a valid-schema $label mismatch", ({ operation, mutate }) => {
    const database = coordinationDatabase();
    try {
      const row = database.prepare(`
        SELECT result_json FROM coordination_idempotency WHERE operation = ?
      `).get(operation) as { result_json: string };
      const result = JSON.parse(row.result_json);
      mutate(result);
      database.prepare(`
        UPDATE coordination_idempotency SET result_json = ? WHERE operation = ?
      `).run(JSON.stringify(result), operation);

      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("accepts authoritative results for every coordination replay operation", () => {
    const database = coordinationDatabase();
    try {
      expect(checker().checkConnection(database, "full")).toMatchObject({
        passed: true,
        schemaVersion: 11,
        issues: [],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "active claim with a terminal timestamp",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-active-ended', 'project-coordination', 'task-coordination',
            'profile-coordination', NULL, 'active', 1, 1, 'pack-coordination',
            '${timestamp}', '2026-07-27T12:30:00.000Z',
            '2026-07-27T16:00:00.000Z', '${timestamp}', NULL
          )
        `);
      },
    },
    {
      label: "paused claim without a terminal timestamp",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-paused-live', 'project-coordination', 'task-coordination',
            'profile-coordination', NULL, 'paused', 1, 1, 'pack-coordination',
            '${timestamp}', '2026-07-27T12:30:00.000Z',
            '2026-07-27T16:00:00.000Z', NULL, NULL
          )
        `);
      },
    },
    {
      label: "offered delegation with an acceptance timestamp",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_delegations SET accepted_at = '${timestamp}'
          WHERE id = 'delegation-coordination'
        `);
      },
    },
    {
      label: "claimed delegation without an exact claim",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE task_delegations
          SET state = 'claimed', accepted_at = '${timestamp}', claim_id = NULL
          WHERE id = 'delegation-coordination'
        `);
      },
    },
    {
      label: "linked terminal delegation with a different terminal timestamp",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          UPDATE task_claims
          SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z',
              delegation_id = 'delegation-coordination'
          WHERE id = 'claim-coordination';
          UPDATE task_delegations
          SET state = 'revoked', accepted_at = '${timestamp}',
              ended_at = '2026-07-27T13:06:00.000Z', claim_id = 'claim-coordination'
          WHERE id = 'delegation-coordination';
          DELETE FROM coordination_idempotency;
        `);
      },
    },
  ])("rejects terminal state corruption for $label", ({ mutate }) => {
    const database = coordinationDatabase();
    try {
      mutate(database);
      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "unknown event actor",
      claimId: "claim-coordination",
      checkpointId: null,
      submissionId: null,
      proposalId: null,
      profileId: "profile-missing",
    },
    {
      label: "submission event without its exact claim and checkpoint",
      claimId: null,
      checkpointId: null,
      submissionId: "submission-coordination",
      proposalId: "proposal-coordination",
      profileId: "profile-coordination",
    },
  ])("rejects coordination lineage corruption for $label", (corruption) => {
    const database = coordinationDatabase();
    try {
      database.prepare(`
        INSERT INTO coordination_events (
          id, category, project_id, task_id, profile_id, claim_id,
          delegation_id, checkpoint_id, submission_id, proposal_id,
          prior_state, resulting_state, project_revision, task_revision,
          detail, created_at
        ) VALUES (
          'event-corrupt', 'submission', 'project-coordination', 'task-coordination',
          ?, ?, NULL, ?, ?, ?, 'active', 'submitted', 1, 1, NULL, ?
        )
      `).run(
        corruption.profileId,
        corruption.claimId,
        corruption.checkpointId,
        corruption.submissionId,
        corruption.proposalId,
        timestamp,
      );

      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "missing claim origin event",
      mutate(database: Database.Database) {
        database.exec("DELETE FROM coordination_events WHERE category = 'claim'");
      },
    },
    {
      label: "duplicate claim origin event",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO coordination_events
          SELECT 'event-claim-duplicate', category, project_id, task_id, profile_id,
                 claim_id, delegation_id, checkpoint_id, submission_id, proposal_id,
                 prior_state, resulting_state, project_revision, task_revision,
                 detail, created_at
          FROM coordination_events WHERE category = 'claim'
        `);
      },
    },
    {
      label: "missing delegation offer event",
      mutate(database: Database.Database) {
        database.exec("DELETE FROM coordination_events WHERE category = 'delegation_offer'");
      },
    },
    {
      label: "missing checkpoint lifecycle event",
      mutate(database: Database.Database) {
        database.exec("DELETE FROM coordination_events WHERE category = 'checkpoint'");
      },
    },
    {
      label: "duplicate initial submission event",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO coordination_events
          SELECT 'event-submission-duplicate', category, project_id, task_id, profile_id,
                 claim_id, delegation_id, checkpoint_id, submission_id, proposal_id,
                 prior_state, resulting_state, project_revision, task_revision,
                 detail, created_at
          FROM coordination_events WHERE category = 'submission'
        `);
      },
    },
    {
      label: "released claim with duplicate proposal and submission histories",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          UPDATE task_claims
          SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z'
          WHERE id = 'claim-coordination';
          INSERT INTO coordination_events VALUES (
            'event-release-coordination', 'release', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-coordination',
            NULL, NULL, NULL, NULL, 'submitted', 'released', 1, 1, NULL,
            '2026-07-27T13:05:00.000Z'
          );
          INSERT INTO change_proposals
          SELECT 'proposal-coordination-duplicate', project_id, profile_id,
                 source_task_id, predecessor_proposal_id, base_project_revision,
                 state, rationale, 'proposal-key-duplicate', request_hash,
                 review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
                 origin_type, repository_snapshot_id
          FROM change_proposals WHERE id = 'proposal-coordination';
          INSERT INTO proposal_operations
          SELECT 'proposal-coordination-duplicate', position,
                 'keep-task-active-duplicate', operation_type,
                 expected_record_revision,
                 replace(payload_json, 'keep-task-active', 'keep-task-active-duplicate')
          FROM proposal_operations WHERE proposal_id = 'proposal-coordination';
          INSERT INTO task_submissions
          SELECT 'submission-coordination-duplicate', claim_id, checkpoint_id,
                 profile_id, project_id, task_id, base_project_revision,
                 base_task_revision, context_pack_id, document_json,
                 'proposal-coordination-duplicate', state, submitted_at, decided_at
          FROM task_submissions WHERE id = 'submission-coordination';
          INSERT INTO coordination_events
          SELECT 'event-submission-duplicate-history', category, project_id, task_id,
                 profile_id, claim_id, delegation_id, checkpoint_id,
                 'submission-coordination-duplicate', 'proposal-coordination-duplicate',
                 prior_state, resulting_state, project_revision, task_revision,
                 detail, created_at
          FROM coordination_events WHERE id = 'event-submission-coordination';
        `);
      },
    },
    {
      label: "submitted claim without its exact submission or event",
      mutate(database: Database.Database) {
        database.exec(`
          DROP TRIGGER task_submissions_no_delete;
          DELETE FROM coordination_events WHERE category = 'submission';
          DELETE FROM coordination_idempotency WHERE operation = 'submit';
          DELETE FROM task_submissions WHERE id = 'submission-coordination';
        `);
      },
    },
    {
      label: "accepted submission without an exact reconciliation event",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'accepted', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination'
        `);
      },
    },
    {
      label: "accepted submission with duplicate reconciliation events",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'accepted', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          INSERT INTO coordination_events
          SELECT 'event-reconciliation-1', 'reconciliation', project_id, task_id, profile_id,
                 claim_id, delegation_id, checkpoint_id, submission_id, proposal_id,
                 'submitted', 'reconciled', project_revision, task_revision,
                 detail, '2026-07-27T13:00:00.000Z'
          FROM coordination_events WHERE category = 'submission';
          INSERT INTO coordination_events
          SELECT 'event-reconciliation-2', 'reconciliation', project_id, task_id, profile_id,
                 claim_id, delegation_id, checkpoint_id, submission_id, proposal_id,
                 'submitted', 'reconciled', project_revision, task_revision,
                 detail, '2026-07-27T13:00:00.000Z'
          FROM coordination_events WHERE category = 'submission';
        `);
      },
    },
    {
      label: "checkpoint event with an inapplicable proposal reference",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events SET proposal_id = 'proposal-coordination'
          WHERE category = 'checkpoint'
        `);
      },
    },
  ])("rejects lifecycle event cardinality corruption for $label", ({ mutate }) => {
    const database = coordinationDatabase();
    try {
      database.exec(`
        DROP TRIGGER coordination_events_no_update;
        DROP TRIGGER coordination_events_no_delete;
      `);
      mutate(database);
      database.exec(`
        ${coordinationEventsNoUpdateTriggerSql};
        ${coordinationEventsNoDeleteTriggerSql};
      `);
      const submissionDeleteTrigger = database.prepare(`
        SELECT 1 FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'task_submissions_no_delete'
      `).get();
      if (!submissionDeleteTrigger) database.exec(taskSubmissionsNoDeleteTriggerSql);
      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "claim origin event timestamp drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE category = 'claim'
        `);
      },
    },
    {
      label: "delegation offer event timestamp drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE category = 'delegation_offer'
        `);
      },
    },
    {
      label: "submission event timestamp drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE category = 'submission'
        `);
      },
    },
    {
      label: "checkpoint event timestamp drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE category = 'checkpoint'
        `);
      },
    },
    {
      label: "checkpoint event revision drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE coordination_events
          SET project_revision = 2, task_revision = 2
          WHERE category = 'checkpoint'
        `);
      },
    },
    {
      label: "checkpoint before claim acquisition",
      mutate(database: Database.Database) {
        database.exec(`
          DROP TRIGGER task_checkpoints_no_update;
          UPDATE task_checkpoints
          SET created_at = '2026-07-27T11:59:59.000Z'
          WHERE id = 'checkpoint-coordination';
          ${taskCheckpointsNoUpdateTriggerSql};
          UPDATE coordination_events
          SET created_at = '2026-07-27T11:59:59.000Z'
          WHERE category = 'checkpoint'
        `);
      },
    },
    {
      label: "checkpoint after terminal claim",
      mutate(database: Database.Database) {
        database.exec(`
          DROP TRIGGER task_checkpoints_no_update;
          UPDATE task_checkpoints
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE id = 'checkpoint-coordination';
          ${taskCheckpointsNoUpdateTriggerSql};
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:00:01.000Z'
          WHERE category = 'checkpoint'
        `);
      },
    },
    {
      label: "linked revoked delegation without acceptance",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          UPDATE task_claims
          SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z',
              delegation_id = 'delegation-coordination'
          WHERE id = 'claim-coordination';
          UPDATE task_delegations
          SET state = 'revoked', accepted_at = NULL,
              ended_at = '2026-07-27T13:05:00.000Z',
              claim_id = 'claim-coordination'
          WHERE id = 'delegation-coordination';
          UPDATE coordination_events SET delegation_id = 'delegation-coordination'
          WHERE claim_id = 'claim-coordination'
            AND category IN ('claim', 'submission');
          INSERT INTO coordination_events VALUES (
            'event-linked-release-no-accept', 'release', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-coordination',
            'delegation-coordination', NULL, NULL, NULL, 'submitted', 'released',
            1, 1, NULL, '2026-07-27T13:05:00.000Z'
          )
        `);
      },
    },
    {
      label: "release before submission decision",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          UPDATE task_claims
          SET state = 'released', ended_at = '2026-07-27T12:59:00.000Z'
          WHERE id = 'claim-coordination';
          INSERT INTO coordination_events VALUES (
            'event-release-before-decision', 'release', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-coordination',
            NULL, NULL, NULL, NULL, 'submitted', 'released', 1, 1, NULL,
            '2026-07-27T12:59:00.000Z'
          )
        `);
      },
    },
    {
      label: "linked active pause at delegation deadline",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-linked-active-boundary', 'project-coordination', 'task-coordination',
            'profile-coordination', 'delegation-coordination', 'paused', 1, 1,
            'pack-coordination', '${timestamp}', '2026-07-27T14:00:00.000Z',
            '2026-07-27T16:00:00.000Z', '2026-07-27T13:00:00.000Z', NULL
          );
          UPDATE task_delegations
          SET state = 'revoked', accepted_at = '${timestamp}',
              ended_at = '2026-07-27T13:00:00.000Z',
              claim_id = 'claim-linked-active-boundary'
          WHERE id = 'delegation-coordination';
          INSERT INTO coordination_events VALUES (
            'event-linked-accept-deadline', 'delegation_accept',
            'project-coordination', 'task-coordination', 'profile-coordination',
            NULL, 'delegation-coordination', NULL, NULL, NULL, 'offered',
            'accepted', 1, 1, NULL, '${timestamp}'
          );
          INSERT INTO coordination_events VALUES (
            'event-linked-claim-deadline', 'claim', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-linked-active-boundary',
            'delegation-coordination', NULL, NULL, NULL, NULL, 'active',
            1, 1, NULL, '${timestamp}'
          );
          INSERT INTO coordination_events VALUES (
            'event-linked-pause-deadline', 'pause', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-linked-active-boundary',
            'delegation-coordination', NULL, NULL, NULL, 'active', 'paused',
            1, 1, NULL, '2026-07-27T13:00:00.000Z'
          )
        `);
      },
    },
    ...[
      ["at lease", "2026-07-27T12:30:00.000Z"],
      ["at absolute horizon", "2026-07-27T16:00:00.000Z"],
      ["after lease", "2026-07-27T12:30:01.000Z"],
      ["after absolute horizon", "2026-07-27T16:00:01.000Z"],
    ].map(([label, checkpointAt]) => ({
      label: `active checkpoint ${label}`,
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-checkpoint-window', 'project-coordination', 'task-coordination',
            'profile-coordination', NULL, 'active', 1, 1, 'pack-coordination',
            '${timestamp}', '2026-07-27T12:30:00.000Z',
            '2026-07-27T16:00:00.000Z', NULL, 'checkpoint-window'
          );
          INSERT INTO task_checkpoints
          SELECT 'checkpoint-window', 'claim-checkpoint-window', 1,
                 document_json, '${checkpointAt}', project_revision, task_revision,
                 context_pack_id
          FROM task_checkpoints WHERE id = 'checkpoint-coordination';
          INSERT INTO coordination_events VALUES (
            'event-claim-checkpoint-window', 'claim', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-checkpoint-window',
            NULL, NULL, NULL, NULL, NULL, 'active', 1, 1, NULL, '${timestamp}'
          );
          INSERT INTO coordination_events VALUES (
            'event-checkpoint-window', 'checkpoint', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-checkpoint-window',
            NULL, 'checkpoint-window', NULL, NULL, 'active', 'active', 1, 1,
            NULL, '${checkpointAt}'
          )
        `);
      },
    })),
    {
      label: "direct expiry before the claim lease",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-direct-early-expiry', 'project-coordination', 'task-coordination',
            'profile-coordination', NULL, 'expired', 1, 1, 'pack-coordination',
            '${timestamp}', '2026-07-27T12:30:00.000Z',
            '2026-07-27T16:00:00.000Z', '2026-07-27T12:29:59.000Z', NULL
          );
          INSERT INTO coordination_events VALUES (
            'event-claim-direct-early-expiry', 'claim', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-direct-early-expiry',
            NULL, NULL, NULL, NULL, NULL, 'active', 1, 1, NULL, '${timestamp}'
          );
          INSERT INTO coordination_events VALUES (
            'event-direct-early-expiry', 'expiry', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-direct-early-expiry',
            NULL, NULL, NULL, NULL, 'active', 'expired', 1, 1, NULL,
            '2026-07-27T12:29:59.000Z'
          )
        `);
      },
    },
    {
      label: "submission at the claim lease boundary",
      mutate(database: Database.Database) {
        database.exec(`
          DROP TRIGGER task_submissions_immutable_fields;
          UPDATE task_submissions
          SET submitted_at = '2026-07-27T12:30:00.000Z'
          WHERE id = 'submission-coordination';
          ${taskSubmissionsImmutableFieldsTriggerSql};
          UPDATE task_claims
          SET ended_at = '2026-07-27T12:30:00.000Z'
          WHERE id = 'claim-coordination';
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:30:00.000Z'
          WHERE category = 'submission'
        `);
      },
    },
    {
      label: "submission at the linked delegation deadline",
      mutate(database: Database.Database) {
        database.exec(`
          DROP TRIGGER task_submissions_immutable_fields;
          UPDATE task_submissions
          SET submitted_at = '2026-07-27T12:15:00.000Z'
          WHERE id = 'submission-coordination';
          ${taskSubmissionsImmutableFieldsTriggerSql};
          UPDATE task_claims
          SET delegation_id = 'delegation-coordination',
              ended_at = '2026-07-27T12:15:00.000Z'
          WHERE id = 'claim-coordination';
          UPDATE task_delegations
          SET state = 'claimed', accepted_at = '${timestamp}',
              deadline = '2026-07-27T12:15:00.000Z',
              claim_id = 'claim-coordination'
          WHERE id = 'delegation-coordination';
          UPDATE coordination_events
          SET delegation_id = 'delegation-coordination'
          WHERE category IN ('claim', 'submission');
          UPDATE coordination_events
          SET created_at = '2026-07-27T12:15:00.000Z'
          WHERE category = 'submission';
          INSERT INTO coordination_events VALUES (
            'event-linked-submit-deadline-accept', 'delegation_accept',
            'project-coordination', 'task-coordination', 'profile-coordination',
            NULL, 'delegation-coordination', NULL, NULL, NULL, 'offered',
            'accepted', 1, 1, NULL, '${timestamp}'
          )
        `);
      },
    },
    {
      label: "direct release with submitted prior state",
      mutate(database: Database.Database) {
        database.exec(`
          INSERT INTO task_claims VALUES (
            'claim-direct-release-origin', 'project-coordination', 'task-coordination',
            'profile-coordination', NULL, 'released', 1, 1, 'pack-coordination',
            '${timestamp}', '2026-07-27T12:30:00.000Z',
            '2026-07-27T16:00:00.000Z', '2026-07-27T13:00:00.000Z', NULL
          );
          INSERT INTO coordination_events VALUES (
            'event-claim-direct-release-origin', 'claim', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-direct-release-origin',
            NULL, NULL, NULL, NULL, NULL, 'active', 1, 1, NULL, '${timestamp}'
          );
          INSERT INTO coordination_events VALUES (
            'event-direct-release-origin', 'release', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-direct-release-origin',
            NULL, NULL, NULL, NULL, 'submitted', 'released', 1, 1, NULL,
            '2026-07-27T13:00:00.000Z'
          )
        `);
      },
    },
    {
      label: "post-decision release with active prior state",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'rejected', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          UPDATE task_claims
          SET state = 'released', ended_at = '2026-07-27T13:05:00.000Z'
          WHERE id = 'claim-coordination';
          INSERT INTO coordination_events VALUES (
            'event-post-decision-active-origin', 'release', 'project-coordination',
            'task-coordination', 'profile-coordination', 'claim-coordination',
            NULL, NULL, NULL, NULL, 'active', 'released', 1, 1, NULL,
            '2026-07-27T13:05:00.000Z'
          )
        `);
      },
    },
    {
      label: "accepted submission decision timestamp drift",
      mutate(database: Database.Database) {
        database.exec(`
          UPDATE change_proposals
          SET state = 'accepted', updated_at = '2026-07-27T13:00:00.000Z',
              reviewed_at = '2026-07-27T13:00:00.000Z'
          WHERE id = 'proposal-coordination';
          INSERT INTO coordination_events
          SELECT 'event-reconciliation-timestamp', 'reconciliation', project_id,
                 task_id, profile_id, claim_id, delegation_id, checkpoint_id,
                 submission_id, proposal_id, 'submitted', 'reconciled',
                 project_revision, task_revision, detail,
                 '2026-07-27T13:00:00.000Z'
          FROM coordination_events WHERE category = 'submission';
          DROP TRIGGER task_submissions_immutable_fields;
          UPDATE task_submissions
          SET decided_at = '2026-07-27T13:00:01.000Z'
          WHERE id = 'submission-coordination';
          ${taskSubmissionsImmutableFieldsTriggerSql};
        `);
      },
    },
  ])("rejects coordination row/event parity corruption for $label", ({ mutate }) => {
    const database = coordinationDatabase();
    try {
      database.exec("DROP TRIGGER coordination_events_no_update");
      mutate(database);
      database.exec(coordinationEventsNoUpdateTriggerSql);
      expect(checker().checkConnection(database, "full").issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "coordination_state_invalid" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "snapshot path index with the wrong columns",
      replace: `
        DROP INDEX idx_repository_node_observations_snapshot_path;
        CREATE UNIQUE INDEX idx_repository_node_observations_snapshot_path
          ON repository_node_observations(node_id);
      `,
    },
    {
      label: "pending review index with the wrong columns and predicate",
      replace: `
        DROP INDEX idx_repository_refresh_reviews_pending_source;
        CREATE UNIQUE INDEX idx_repository_refresh_reviews_pending_source
          ON repository_refresh_reviews(snapshot_id)
          WHERE state = 'applied';
      `,
    },
  ])("rejects a same-named counterfeit $label", ({ replace }) => {
    const database = repositoryImportDatabase();
    try {
      database.exec(replace);

      expect(checker().checkConnection(database, "compatibility")).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: [
          expect.objectContaining({ code: "schema_object_missing" }),
        ],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "proposal operation table with an extra column and no parent foreign key",
      replacementSql: `
        CREATE TABLE proposal_operations (
          proposal_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          operation_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          expected_record_revision INTEGER CHECK (
            expected_record_revision IS NULL OR expected_record_revision > 0
          ),
          payload_json TEXT NOT NULL,
          counterfeit_note TEXT,
          PRIMARY KEY (proposal_id, position),
          UNIQUE (proposal_id, operation_id)
        );
      `,
    },
    {
      label: "proposal operation table missing its payload column",
      replacementSql: `
        CREATE TABLE proposal_operations (
          proposal_id TEXT NOT NULL
            REFERENCES change_proposals(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          operation_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          expected_record_revision INTEGER CHECK (
            expected_record_revision IS NULL OR expected_record_revision > 0
          ),
          PRIMARY KEY (proposal_id, position),
          UNIQUE (proposal_id, operation_id)
        );
      `,
    },
    {
      label: "proposal operation table with reordered columns",
      replacementSql: `
        CREATE TABLE proposal_operations (
          proposal_id TEXT NOT NULL
            REFERENCES change_proposals(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          operation_type TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          expected_record_revision INTEGER CHECK (
            expected_record_revision IS NULL OR expected_record_revision > 0
          ),
          payload_json TEXT NOT NULL,
          PRIMARY KEY (proposal_id, position),
          UNIQUE (proposal_id, operation_id)
        );
      `,
    },
    {
      label: "proposal operation table with nullable operation identity",
      replacementSql: `
        CREATE TABLE proposal_operations (
          proposal_id TEXT NOT NULL
            REFERENCES change_proposals(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          operation_id TEXT,
          operation_type TEXT NOT NULL,
          expected_record_revision INTEGER CHECK (
            expected_record_revision IS NULL OR expected_record_revision > 0
          ),
          payload_json TEXT NOT NULL,
          PRIMARY KEY (proposal_id, position),
          UNIQUE (proposal_id, operation_id)
        );
      `,
    },
    {
      label: "proposal operation parent foreign key without cascade deletion",
      replacementSql: `
        CREATE TABLE proposal_operations (
          proposal_id TEXT NOT NULL
            REFERENCES change_proposals(id) ON DELETE RESTRICT,
          position INTEGER NOT NULL CHECK (position >= 0),
          operation_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          expected_record_revision INTEGER CHECK (
            expected_record_revision IS NULL OR expected_record_revision > 0
          ),
          payload_json TEXT NOT NULL,
          PRIMARY KEY (proposal_id, position),
          UNIQUE (proposal_id, operation_id)
        );
      `,
    },
  ])("rejects a counterfeit $label", ({ replacementSql }) => {
    const database = repositoryImportDatabase();
    try {
      replaceProposalOperationsTable(database, replacementSql);

      expect(checker().checkConnection(database, "compatibility")).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: [expect.objectContaining({ code: "schema_object_missing" })],
      });
    } finally {
      database.close();
    }
  });

  it("rejects a proposal table whose origin check admits an ungoverned field combination", () => {
    const database = repositoryImportDatabase();
    try {
      replaceProposalTableWithBypassableOriginCheck(database);

      expect(checker().checkConnection(database, "compatibility")).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: [expect.objectContaining({ code: "schema_object_missing" })],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "profile proposal idempotency index",
      replace: `
        DROP INDEX idx_change_proposals_profile_idempotency;
        CREATE UNIQUE INDEX idx_change_proposals_profile_idempotency
          ON change_proposals(project_id, idempotency_key)
          WHERE origin_type = 'repository_refresh';
      `,
    },
    {
      label: "repository snapshot proposal index",
      replace: `
        DROP INDEX idx_change_proposals_repository_snapshot;
        CREATE UNIQUE INDEX idx_change_proposals_repository_snapshot
          ON change_proposals(project_id)
          WHERE origin_type = 'repository_refresh';
      `,
    },
    {
      label: "proposal operation immutability trigger",
      replace: `
        DROP TRIGGER proposal_operations_no_update;
        CREATE TRIGGER proposal_operations_no_update
        AFTER UPDATE ON proposal_operations
        BEGIN
          SELECT 1;
        END;
      `,
    },
  ])("rejects a same-named counterfeit $label", ({ replace }) => {
    const database = repositoryImportDatabase();
    try {
      database.exec(replace);
      expect(checker().checkConnection(database, "compatibility")).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: [expect.objectContaining({ code: "schema_object_missing" })],
      });
    } finally {
      database.close();
    }
  });

  it("rejects a version-six label on a version-five client profile layout", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = new Database(temporary.path);
    for (const migration of migrations) {
      if (migration.version > 5) break;
      database.exec(migration.sql);
    }
    database.prepare(`
      INSERT INTO store_metadata (singleton, store_id, created_at)
      VALUES (1, 'store-mislabeled-v6', ?)
    `).run(timestamp);
    database.pragma("user_version = 6");

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      schemaVersion: 6,
      issues: [
        expect.objectContaining({ code: "schema_object_missing" }),
      ],
    });
    database.close();
  });

  it("rejects a version-six execution-mode column with a weakened mode check", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = new Database(temporary.path);
    for (const migration of migrations) {
      if (migration.version > 5) break;
      database.exec(migration.sql);
    }
    database.prepare(`
      INSERT INTO store_metadata (singleton, store_id, created_at)
      VALUES (1, 'store-corrupt-v6', ?)
    `).run(timestamp);
    database.exec(`
      ALTER TABLE client_profiles
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe'
        CHECK (execution_mode IN ('safe','trusted'));
    `);
    database.pragma("user_version = 6");

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      schemaVersion: 6,
      issues: [
        expect.objectContaining({ code: "schema_object_missing" }),
      ],
    });
    database.close();
  });

  it("closes the repository import integrity issue over its canonical definition", () => {
    const issue = {
      code: "repository_import_state_invalid",
      severity: "error",
      description: "Repository import state is invalid.",
    } as const;

    expect(integrityIssueDescriptionFor(issue.code)).toBe(issue.description);
    expect(integrityIssueSchema.parse(issue)).toEqual(issue);
    expect(() =>
      integrityIssueSchema.parse({
        ...issue,
        description: "Repository import receipt is invalid.",
      }),
    ).toThrow();
  });

  it("closes the repository index integrity issue over its canonical definition", () => {
    const issue = {
      code: "repository_index_state_invalid",
      severity: "error",
      description: "Repository index state is invalid.",
    } as const;

    expect(integrityIssueDescriptionFor(issue.code)).toBe(issue.description);
    expect(integrityIssueSchema.parse(issue)).toEqual(issue);
    expect(() => integrityIssueSchema.parse({
      ...issue,
      description: "Repository snapshot state is invalid.",
    })).toThrow();
  });

  it.each([
    ["proposal_origin_invalid", "Proposal origin state is invalid."],
    ["proposal_operation_invalid", "Proposal operation state is invalid."],
    ["proposal_project_invalid", "Proposal project ownership is invalid."],
    ["proposal_snapshot_invalid", "Proposal repository snapshot is invalid."],
  ] as const)("closes %s over its canonical description", (code, description) => {
    expect(integrityIssueDescriptionFor(code)).toBe(description);
    expect(integrityIssueSchema.parse({
      code,
      severity: "error",
      description,
    })).toEqual({ code, severity: "error", description });
  });

  it.each([
    {
      label: "origin discriminator and nullability",
      code: "proposal_origin_invalid",
      proposal: `
        'proposal-invalid-origin', 'project-import', NULL, NULL, NULL, 1,
        'pending', 'Invalid origin', NULL, NULL, NULL, NULL,
        '${timestamp}', '${timestamp}', NULL, 'profile', NULL
      `,
      operation: null,
    },
    {
      label: "operation metadata and payload",
      code: "proposal_operation_invalid",
      proposal: `
        'proposal-invalid-operation', 'project-import', NULL, NULL, NULL, 1,
        'pending', 'Invalid operation', NULL, NULL, NULL, NULL,
        '${timestamp}', '${timestamp}', NULL, 'repository_refresh',
        'snapshot-candidate'
      `,
      operation: `
        'proposal-invalid-operation', 0, 'metadata-operation',
        'update_record', 1,
        '{"operationId":"payload-operation","type":"create_record","kind":"task","status":"provisional","title":"Title","body":"Body"}'
      `,
    },
    {
      label: "project and snapshot ownership",
      code: "proposal_project_invalid",
      proposal: `
        'proposal-invalid-project', 'project-import', NULL, NULL, NULL, 1,
        'pending', 'Wrong project', NULL, NULL, NULL, NULL,
        '${timestamp}', '${timestamp}', NULL, 'repository_refresh',
        'snapshot-other-candidate'
      `,
      operation: null,
    },
    {
      label: "candidate snapshot lifecycle",
      code: "proposal_snapshot_invalid",
      proposal: `
        'proposal-invalid-snapshot', 'project-import', NULL, NULL, NULL, 1,
        'pending', 'Wrong snapshot state', NULL, NULL, NULL, NULL,
        '${timestamp}', '${timestamp}', NULL, 'repository_refresh',
        'snapshot-import'
      `,
      operation: null,
    },
  ])("reports a precise proposal diagnostic for $label", ({ code, proposal, operation }) => {
    const database = repositoryImportDatabase();
    try {
      seedRepositoryIndex(database);
      database.exec(`
        INSERT INTO repository_snapshots VALUES (
          'snapshot-candidate', 'source-import', 'project-import', 'candidate',
          'snapshot-import', 1, 'main', '${"a".repeat(40)}', '${"1".repeat(64)}',
          '1', '1', '{}', '{}', '{}', '${timestamp}', NULL, NULL
        );
        INSERT INTO repository_snapshots VALUES (
          'snapshot-other-candidate', 'source-other', 'project-other', 'candidate',
          'snapshot-other', 1, 'main', '${"c".repeat(40)}', '${"2".repeat(64)}',
          '1', '1', '{}', '{}', '{}', '${timestamp}', NULL, NULL
        );
      `);
      database.pragma("foreign_keys = OFF");
      database.pragma("ignore_check_constraints = ON");
      database.exec(`INSERT INTO change_proposals VALUES (${proposal})`);
      if (operation !== null) {
        database.exec(`INSERT INTO proposal_operations VALUES (${operation})`);
      }
      database.pragma("ignore_check_constraints = OFF");
      database.pragma("foreign_keys = ON");

      const issueCodes = checker().checkConnection(database, "full")
        .issues.map((issue) => issue.code);
      expect(issueCodes).toContain(code);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "relationship local reference that is never created",
      operations: [{
        operationId: "relationship-missing-local",
        type: "create_relationship",
        from: { localRef: "missing-record" },
        to: { recordId: "record-import-1" },
        kind: "related_to",
      }],
    },
    {
      label: "duplicate update target",
      operations: [{
        operationId: "update-target-first",
        type: "update_record",
        recordId: "record-import-1",
        expectedRecordRevision: 1,
        patch: { title: "First update" },
      }, {
        operationId: "update-target-second",
        type: "update_record",
        recordId: "record-import-1",
        expectedRecordRevision: 1,
        patch: { body: "Second update" },
      }],
    },
    {
      label: "duplicate create-record local reference",
      operations: [{
        operationId: "create-local-first",
        type: "create_record",
        localRef: "same-local",
        kind: "task",
        status: "provisional",
        title: "First local record",
        body: "First body",
      }, {
        operationId: "create-local-second",
        type: "create_record",
        localRef: "same-local",
        kind: "task",
        status: "provisional",
        title: "Second local record",
        body: "Second body",
      }],
    },
    {
      label: "relationship forward reference",
      operations: [{
        operationId: "relationship-forward-local",
        type: "create_relationship",
        from: { localRef: "future-record" },
        to: { recordId: "record-import-1" },
        kind: "related_to",
      }, {
        operationId: "create-future-local",
        type: "create_record",
        localRef: "future-record",
        kind: "task",
        status: "provisional",
        title: "Future local record",
        body: "Created too late for the relationship",
      }],
    },
    {
      label: "self-link relationship",
      operations: [{
        operationId: "relationship-self-link",
        type: "create_relationship",
        from: { recordId: "record-import-1" },
        to: { recordId: "record-import-1" },
        kind: "related_to",
      }],
    },
  ] as const)("reports one proposal operation issue for a $label", ({ operations }) => {
    const database = repositoryImportDatabase();
    try {
      seedRepositoryIndex(database);
      database.exec(`
        INSERT INTO repository_snapshots VALUES (
          'snapshot-operation-set', 'source-import', 'project-import',
          'candidate', 'snapshot-import', 1, 'main', '${"a".repeat(40)}',
          '${"3".repeat(64)}', '1', '1', '{}', '{}', '{}', '${timestamp}',
          NULL, NULL
        );
        INSERT INTO change_proposals VALUES (
          'proposal-operation-set', 'project-import', NULL, NULL, NULL, 1,
          'pending', 'Invalid ordered operation set', NULL, NULL, NULL, NULL,
          '${timestamp}', '${timestamp}', NULL, 'repository_refresh',
          'snapshot-operation-set'
        );
      `);
      const insertOperation = database.prepare(`
        INSERT INTO proposal_operations VALUES (?, ?, ?, ?, ?, ?)
      `);
      operations.forEach((operation, position) => {
        insertOperation.run(
          "proposal-operation-set",
          position,
          operation.operationId,
          operation.type,
          "expectedRecordRevision" in operation
            ? operation.expectedRecordRevision
            : null,
          JSON.stringify(operation),
        );
      });

      const operationIssues = checker().checkConnection(database, "full")
        .issues.filter(({ code }) => code === "proposal_operation_invalid");
      expect(operationIssues).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each([
    ["missing", []],
    ["empty identity", [{
      singleton: 1,
      storeId: "",
      createdAt: timestamp,
    }]],
    ["invalid timestamp", [{
      singleton: 1,
      storeId: "store-invalid-time",
      createdAt: "not-a-timestamp",
    }]],
    ["multiple rows", [{
      singleton: 1,
      storeId: "store-one",
      createdAt: timestamp,
    }, {
      singleton: 2,
      storeId: "store-two",
      createdAt: timestamp,
    }]],
  ])("reports invalid version-three metadata when it is %s", (_name, rows) => {
    const report = checker().checkPath(
      schemaThreeFixture(rows),
      "compatibility",
    );

    expect(report).toMatchObject({
      passed: false,
      schemaVersion: 3,
      storeId: null,
    });
    expect(report.issues.filter(
      ({ code }) => code === "store_metadata_invalid",
    )).toHaveLength(1);
  });

  it("reports a future schema with the canonical unsupported issue", () => {
    const path = fixture(2);
    const database = new Database(path);
    database.pragma(`user_version = ${migrations.at(-1)!.version + 1}`);
    database.close();

    expect(checker().checkPath(path, "compatibility")).toMatchObject({
      passed: false,
      schemaVersion: migrations.at(-1)!.version + 1,
      storeId: null,
      issues: [
        expect.objectContaining({ code: "unsupported_schema" }),
      ],
    });
  });

  it("requires the canonical schema-nine replay table", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-schema-nine",
    });
    database.exec(`
      DROP TABLE human_change_idempotency_results;
      CREATE TABLE human_change_idempotency_results (
        project_id TEXT NOT NULL,
        operation_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const report = checker().checkConnection(database, "compatibility");

    expect(report.schemaVersion).toBe(migrations.at(-1)!.version);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "schema_object_missing" }),
    ]));
    database.close();
  });

  it("runs semantic record checks through the latest schema", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-current-full",
    });
    database.pragma("foreign_keys = OFF");
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-current', 'Current project', 1, NULL,
        '${timestamp}', '${timestamp}'
      );
      INSERT INTO project_records VALUES (
        'record-current', 'project-current', 'task', 'active', 'Title', 'Body',
        'human', NULL, 2, '${timestamp}', '${timestamp}'
      );
    `);
    database.pragma("foreign_keys = ON");

    const report = checker().checkConnection(database, "full");

    expect(report.schemaVersion).toBe(migrations.at(-1)!.version);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "record_revision_mismatch" }),
    ]));
    database.close();
  });

  it("rejects a human-change replay whose stored result belongs to another project", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-replay-integrity",
    });
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-replay', 'Replay project', 1, NULL,
        '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO human_change_idempotency_results (
        project_id, operation_scope, idempotency_key, request_hash,
        result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "project-replay",
      "idea_capture",
      "request-replay",
      "a".repeat(64),
      JSON.stringify({
        outcome: "applied",
        projectId: "project-other",
        revisionBefore: 0,
        revisionAfter: 1,
        operations: [{
          operationId: "create-idea",
          type: "create_record",
          record: {
            id: "idea-other",
            projectId: "project-other",
            kind: "idea",
            status: "provisional",
            title: "Other idea",
            body: "Other idea",
            sourceKind: "human",
            sourceRef: "web:idea-capture",
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }],
        replayPayloadJson: "[]",
      }),
      timestamp,
    );

    try {
      const report = checker().checkConnection(database, "full");

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "stored_json_invalid" }),
      ]));
    } finally {
      database.close();
    }
  });

  it.each([
    ["idea status", (row: any) => {
      row.result.operations[0].record.status = "accepted";
    }],
    ["idea provenance", (row: any) => {
      row.result.operations[0].record.sourceKind = "agent";
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
      row.idempotency_key = ` ${row.idempotency_key} `;
    }],
    ["bounded idempotency key", (row: any) => {
      row.idempotency_key = "x".repeat(129);
    }],
  ])("rejects full-integrity replay tampering in %s", (_label, mutate) => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-replay-tamper",
    });
    let projectSequence = 0;
    let governanceSequence = 0;
    const projectStore = createProjectStore(database, {
      now: () => timestamp,
      newId: (prefix) => `${prefix}-project-store-${projectSequence += 1}`,
    });
    const governanceStore = createGovernanceStore(database, {
      newId: (prefix) => `${prefix}-governance-store-${governanceSequence += 1}`,
    });
    const service = createIdeaService({
      projectStore,
      governanceStore,
      now: () => timestamp,
    });
    const project = projectStore.createProject({ name: "Replay integrity" });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Integrity context",
      body: "Keep replay context typed and ordered.",
      sourceKind: "human",
      sourceRef: null,
    });
    service.capture({
      projectId: project.id,
      expectedProjectRevision: projectStore.getProject(project.id)!.revision,
      captureRequestId: "capture-integrity",
      text: "Integrity replay\nKeep the semantic result exact.",
      contextRecordIds: [task.id],
    });
    const stored = database.prepare(`
      SELECT operation_scope, idempotency_key, request_hash, result_json
      FROM human_change_idempotency_results
      WHERE project_id = ?
    `).get(project.id) as {
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
    database.prepare(`
      UPDATE human_change_idempotency_results
      SET operation_scope = ?, idempotency_key = ?, request_hash = ?,
          result_json = ?
      WHERE project_id = ?
    `).run(
      tampered.operation_scope,
      tampered.idempotency_key,
      tampered.request_hash,
      JSON.stringify(tampered.result),
      project.id,
    );

    try {
      const report = checker().checkConnection(database, "full");

      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "stored_json_invalid" }),
      ]));
    } finally {
      database.close();
    }
  });

  it("passes every full check for a healthy version-two fixture", () => {
    const path = fixture(2);

    expect(checker().checkPath(path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 2,
      issues: [],
    });
  });

  it("passes full integrity for a healthy schema-eight pre-migration store", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = new Database(temporary.path);
    for (const migration of migrations.filter(({ version }) => version <= 8)) {
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-schema-eight",
        now: timestamp,
      });
    }
    database.pragma("user_version = 8");

    expect(checker().checkConnection(database, "full")).toMatchObject({
      passed: true,
      schemaVersion: 8,
      storeId: "store-schema-eight",
      issues: [],
    });
    database.close();
  });

  it("passes every full check for a healthy schema-four outbound graph", () => {
    const database = outboundDatabase();

    expect(checker().checkConnection(database, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-outbound",
      issues: [],
    });
    database.close();
  });

  it("accepts a pre-v11 immutable release with its historical missing-field digest", () => {
    const database = outboundDatabase({
      historicalMissingHierarchyVocabulary: true,
    });
    const row = database.prepare(`
      SELECT
        r.candidate_digest, c.content_json, o.content_json AS pack_json,
        o.sha256
      FROM outbound_requests AS r
      JOIN context_packs AS c ON c.id = r.source_pack_id
      JOIN outbound_releases AS o ON o.request_id = r.id
      WHERE r.id = 'request-1'
    `).get() as {
      candidate_digest: string;
      content_json: string;
      pack_json: string;
      sha256: string;
    };
    const findingIds = database.prepare(`
      SELECT id
      FROM outbound_findings
      WHERE request_id = 'request-1'
      ORDER BY ordinal
    `).all().map(({ id }) => id) as string[];

    const report = checker().checkConnection(database, "full");
    database.close();

    expect(row.candidate_digest).toBe(
      "8add1ce25a8f287c0c66381b74d90cea45688b4234a80810fbc01973aae4d99a",
    );
    expect(findingIds).toEqual([
      "finding-006c4d71f5a631235599b5c778e6b85623996496b314966edeeda0f0b5bc0257",
      "finding-a8c45d4f3770bcd9e946b4972c3c126ba465aa5cfe739d5002d201dd0e6713e2",
      "finding-34b9bc8670f585d61f5d06ffa43d9adde80887151d4c2837ae9e031411bc3ec9",
    ]);
    expect(Object.hasOwn(JSON.parse(row.content_json), "hierarchyVocabulary"))
      .toBe(false);
    expect(Object.hasOwn(JSON.parse(row.pack_json), "hierarchyVocabulary"))
      .toBe(false);
    expect(row.sha256).toBe(
      "ee3d0a3a7c19a3087fa3eb90bdff0164c44a7fcdb14890c5f8d6c317d4f41daf",
    );
    expect(report).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-outbound",
      issues: [],
    });
  });

  it("rejects an explicit-field release attached to a missing-field historical request", () => {
    const database = outboundDatabase({
      mutableReleases: true,
      historicalMissingHierarchyVocabulary: true,
    });
    rewriteReleaseWithValidDigest(database, (release) => release);
    restoreReleaseTriggers(database);

    expectOutboundInvalid(database);
  });

  it.each([
    ["candidate digest", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_requests
        SET candidate_digest = ?
        WHERE id = 'request-1'
      `).run("f".repeat(64));
    }],
    ["finding identity", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_findings
        SET finding_key = ?
        WHERE request_id = 'request-1' AND ordinal = 0
      `).run("f".repeat(64));
    }],
  ])("rejects tampered historical request %s", (_case, tamper) => {
    const database = outboundDatabase({
      historicalMissingHierarchyVocabulary: true,
    });
    tamper(database);

    expectOutboundInvalid(database);
  });

  it.each([
    ["explicit Neutral", neutralHierarchyVocabulary],
    ["Software", softwareHierarchyVocabulary],
    ["Simple", simpleHierarchyVocabulary],
  ])("rejects a missing-field release when the source pack uses %s vocabulary", (
    _preset,
    hierarchyVocabulary,
  ) => {
    const database = outboundDatabase({
      mutableReleases: true,
      sourcePack: {
        ...pack,
        hierarchyVocabulary,
      },
    });
    const row = database.prepare(`
      SELECT content_json, disclosure_json, released_at
      FROM outbound_releases
      WHERE id = 'release-1'
    `).get() as {
      content_json: string;
      disclosure_json: string;
      released_at: string;
    };
    const storedPack = taskContextPackSchema.parse(JSON.parse(row.content_json));
    const {
      hierarchyVocabulary: _missingVocabulary,
      ...missingVocabularyPack
    } = storedPack;
    const disclosure = outboundDisclosureSchema.parse(
      JSON.parse(row.disclosure_json),
    );
    const provisional: OutboundRelease = {
      releaseId: "release-1",
      requestId: "request-1",
      sourcePackId: "pack-1",
      releasedAt: row.released_at,
      sha256: "0".repeat(64),
      disclosure: {
        ...disclosure,
        releaseDigest: "0".repeat(64),
      },
      pack: missingVocabularyPack,
    };
    const missingVocabularyDigest = computeOutboundReleaseDigest(provisional);
    database.prepare(`
      UPDATE outbound_releases
      SET content_json = ?, disclosure_json = ?, sha256 = ?
      WHERE id = 'release-1'
    `).run(
      JSON.stringify(missingVocabularyPack),
      JSON.stringify({
        ...disclosure,
        releaseDigest: missingVocabularyDigest,
      }),
      missingVocabularyDigest,
    );
    restoreReleaseTriggers(database);

    const report = checker().checkConnection(database, "full");
    database.close();

    expect(report.issues.map(({ code }) => code)).toContain(
      "outbound_state_invalid",
    );
  });

  it("passes full integrity for a valid repository import receipt and audit", () => {
    const database = repositoryImportDatabase();

    expect(checker().checkConnection(database, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-import",
      issues: [],
    });
    database.close();
  });

  it("reports a repository index current snapshot owned by another source", () => {
    const database = repositoryImportDatabase();
    seedRepositoryIndex(database);
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      UPDATE repository_sources
      SET current_snapshot_id = 'snapshot-other'
      WHERE id = 'source-import'
    `).run();
    database.pragma("foreign_keys = ON");

    const report = checker().checkConnection(database, "full");

    expect(report.passed).toBe(false);
    expect(report.issues.filter(
      ({ code }) => code === "repository_index_state_invalid",
    )).toHaveLength(1);
    database.close();
  });

  it.each([
    {
      label: "snapshot hash",
      mutate: `
        UPDATE repository_snapshots
        SET fingerprint = '${"A".repeat(64)}'
        WHERE id = 'snapshot-import'
      `,
    },
    {
      label: "review lifecycle",
      mutate: `
        UPDATE repository_refresh_reviews
        SET state = 'pending'
        WHERE snapshot_id = 'snapshot-import'
      `,
    },
  ])("does not classify an invalid $label as stored JSON", ({ mutate }) => {
    const database = repositoryImportDatabase();
    try {
      seedRepositoryIndex(database);
      database.pragma("ignore_check_constraints = ON");
      database.exec(mutate);
      database.pragma("ignore_check_constraints = OFF");

      const issueCodes = checker().checkConnection(database, "full")
        .issues.map(({ code }) => code);

      expect(issueCodes).toContain("repository_index_state_invalid");
      expect(issueCodes).not.toContain("stored_json_invalid");
    } finally {
      database.close();
    }
  });

  it("rejects plausible positive receipt counts without matching immutable snapshot evidence", () => {
    const database = repositoryImportDatabase();
    mutateRepositoryImportEvidence(database, () => {
      database.exec(`
        UPDATE repository_import_receipts
        SET record_count = 3, relationship_count = 2
      `);
    });

    expectRepositoryImportInvalid(database);
  });

  it("rejects an orphan repository-import success audit", () => {
    const database = repositoryImportDatabase();
    database.exec(`
      INSERT INTO audit_events VALUES (
        'audit-import-orphan', 'project-other', 'local_human', NULL, 'human',
        'human_import', 'repository_import_applied', 'project-other', NULL,
        0, 1, 'applied', NULL, '${timestamp}'
      )
    `);

    expectRepositoryImportInvalid(database);
  });

  it("rejects same-named no-op repository receipt triggers", () => {
    const database = repositoryImportDatabase();
    database.exec(`
      DROP TRIGGER repository_import_receipts_no_update;
      DROP TRIGGER repository_import_receipts_no_delete;
      CREATE TRIGGER repository_import_receipts_no_update
      BEFORE UPDATE ON repository_import_receipts
      BEGIN
        SELECT 1;
      END;
      CREATE TRIGGER repository_import_receipts_no_delete
      BEFORE DELETE ON repository_import_receipts
      BEGIN
        SELECT 1;
      END;
    `);

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      issues: [expect.objectContaining({ code: "schema_object_missing" })],
    });
    database.close();
  });

  it("rejects a same-named receipt table without its constraints", () => {
    const database = repositoryImportDatabase();
    database.exec(`
      DROP TABLE repository_import_receipts;
      CREATE TABLE repository_import_receipts (
        manifest_digest TEXT,
        project_id TEXT,
        repository_fingerprint TEXT,
        scanner_version TEXT,
        ruleset_version TEXT,
        record_count INTEGER,
        relationship_count INTEGER,
        created_at TEXT
      );
      CREATE TRIGGER repository_import_receipts_no_update
      BEFORE UPDATE ON repository_import_receipts BEGIN SELECT 1; END;
      CREATE TRIGGER repository_import_receipts_no_delete
      BEFORE DELETE ON repository_import_receipts BEGIN SELECT 1; END;
    `);

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      issues: [expect.objectContaining({ code: "schema_object_missing" })],
    });
    database.close();
  });

  it.each([
    [
      "project uniqueness",
      repositoryImportReceiptsTableSql.replace(
        "project_id TEXT NOT NULL UNIQUE",
        "project_id TEXT NOT NULL",
      ),
    ],
    [
      "project foreign key",
      repositoryImportReceiptsTableSql.replace(
        "REFERENCES projects(id) ON DELETE RESTRICT",
        "",
      ),
    ],
    [
      "manifest-version check",
      repositoryImportReceiptsTableSql.replace(
        "AND manifest_version = 1",
        "AND manifest_version >= 1",
      ),
    ],
  ])("rejects a receipt table with malformed %s structure", (_name, tableSql) => {
    const database = repositoryImportDatabase();
    database.exec(`
      DROP TABLE repository_import_receipts;
      ${tableSql};
      ${repositoryImportReceiptsNoUpdateTriggerSql};
      ${repositoryImportReceiptsNoDeleteTriggerSql};
    `);

    expect(checker().checkConnection(database, "compatibility")).toMatchObject({
      passed: false,
      issues: [expect.objectContaining({ code: "schema_object_missing" })],
    });
    database.close();
  });

  it("enforces append-only repository import receipts directly", () => {
    const database = repositoryImportDatabase();

    expect(() =>
      database.prepare(`
        UPDATE repository_import_receipts SET scanner_version = '2'
      `).run()
    ).toThrow(/append-only/);
    expect(() =>
      database.prepare("DELETE FROM repository_import_receipts").run()
    ).toThrow(/append-only/);
    expect(database.prepare(`
      SELECT manifest_digest, scanner_version
      FROM repository_import_receipts
    `).all()).toEqual([{
      manifest_digest: importManifestDigest,
      scanner_version: "1",
    }]);
    database.close();
  });

  it.each([
    ["manifest digest", `
      UPDATE repository_import_receipts
      SET manifest_digest = '${"B".repeat(64)}'
    `],
    ["project reference", `
      UPDATE repository_import_receipts SET project_id = 'project-other'
    `],
    ["repository fingerprint", `
      UPDATE repository_import_receipts
      SET repository_fingerprint = '${"C".repeat(64)}'
    `],
    ["blank scanner version", `
      UPDATE repository_import_receipts SET scanner_version = ' '
    `],
    ["untrimmed scanner version", `
      UPDATE repository_import_receipts SET scanner_version = ' 1'
    `],
    ["blank ruleset version", `
      UPDATE repository_import_receipts SET ruleset_version = ' '
    `],
    ["untrimmed ruleset version", `
      UPDATE repository_import_receipts SET ruleset_version = '1 '
    `],
    ["manifest version", `
      UPDATE repository_import_receipts SET manifest_version = 2
    `],
    ["negative record count", `
      UPDATE repository_import_receipts SET record_count = -1
    `],
    ["fractional record count", `
      UPDATE repository_import_receipts SET record_count = 1.5
    `],
    ["negative relationship count", `
      UPDATE repository_import_receipts SET relationship_count = -1
    `],
    ["fractional relationship count", `
      UPDATE repository_import_receipts SET relationship_count = 1.5
    `],
    ["initial snapshot digest", `
      UPDATE repository_import_receipts
      SET initial_snapshot_digest = upper(initial_snapshot_digest)
    `],
    ["initial snapshot JSON", `
      UPDATE repository_import_receipts
      SET initial_snapshot_json = json_set(
        initial_snapshot_json, '$.projectId', 'project-other'
      )
    `],
    ["invalid timestamp", `
      UPDATE repository_import_receipts SET created_at = 'not-a-timestamp'
    `],
  ])("rejects a repository import receipt with a corrupt %s", (_name, sql) => {
    const database = repositoryImportDatabase();
    mutateRepositoryImportEvidence(database, () => database.exec(sql));

    expectRepositoryImportInvalid(database);
  });

  it("rejects a repository import receipt whose project is below revision one", () => {
    const database = repositoryImportDatabase();
    database.prepare(
      "UPDATE projects SET revision = 0 WHERE id = 'project-import'",
    ).run();

    expectRepositoryImportInvalid(database);
  });

  it.each([
    ["project", "project_id = 'project-other'"],
    ["actor type", "actor_type = 'profile'"],
    ["profile", "profile_id = 'profile-1'"],
    ["authority mode", "authority_mode = 'proposal'"],
    ["scope decision", "scope_decision = 'human_admin'"],
    ["action category", "action_category = 'repository_import_failed'"],
    ["target", "target_id = 'project-other'"],
    ["idempotency key", "idempotency_key = 'key-1'"],
    ["revision before", "revision_before = 1"],
    ["revision after", "revision_after = 2"],
    ["outcome", "outcome = 'rejected'"],
    ["reason", "reason = 'changed'"],
    ["timestamp", "created_at = '2026-07-27T12:00:01.000Z'"],
  ])("rejects a repository import receipt with a corrupt success audit %s", (
    _name,
    assignment,
  ) => {
    const database = repositoryImportDatabase();
    mutateRepositoryImportEvidence(database, () => {
      database.exec(`
        UPDATE audit_events SET ${assignment} WHERE id = 'audit-import'
      `);
    });

    expectRepositoryImportInvalid(database);
  });

  it("rejects multiple matching repository import success audits", () => {
    const database = repositoryImportDatabase();
    database.exec(`
      INSERT INTO audit_events
      SELECT
        'audit-import-duplicate', project_id, actor_type, profile_id,
        authority_mode, scope_decision, action_category, target_id,
        idempotency_key, revision_before, revision_after, outcome, reason,
        created_at
      FROM audit_events
      WHERE id = 'audit-import'
    `);

    expectRepositoryImportInvalid(database);
  });

  it("keeps historical repository import evidence valid after governed changes", () => {
    const database = repositoryImportDatabase();
    database.exec(`
      UPDATE projects
      SET revision = 3, updated_at = '2026-07-27T12:00:02.000Z'
      WHERE id = 'project-import';
      INSERT INTO project_records VALUES (
        'later-record', 'project-import', 'decision', 'accepted',
        'Later governed record', 'Created after repository import.',
        'human', NULL, 1, '2026-07-27T12:00:02.000Z',
        '2026-07-27T12:00:02.000Z'
      );
    `);
    const laterRecord = {
      id: "later-record",
      projectId: "project-import",
      kind: "decision",
      status: "accepted",
      title: "Later governed record",
      body: "Created after repository import.",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: "2026-07-27T12:00:02.000Z",
      updatedAt: "2026-07-27T12:00:02.000Z",
    };
    database.prepare(`
      INSERT INTO project_record_revisions VALUES (
        'later-record', 1, ?, '2026-07-27T12:00:02.000Z'
      )
    `).run(JSON.stringify(laterRecord));

    expect(checker().checkConnection(database, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      issues: [],
    });
    database.close();
  });

  it.each([
    ["task record ID", {
      ...pack,
      task: {
        ...pack.task,
        record: { ...pack.task.record, id: "other-task" },
      },
    }],
    ["task record project", {
      ...pack,
      task: {
        ...pack.task,
        record: { ...pack.task.record, projectId: "other-project" },
      },
    }],
    ["task revision snapshot", {
      ...pack,
      task: {
        ...pack.task,
        record: { ...pack.task.record, body: "Self-consistent forged body." },
      },
    }],
    ["source revision declaration", {
      ...pack,
      sourceRevisions: [{ recordId: "task-1", revision: 2 }],
    }],
  ])("rejects a context pack whose %s contradicts authoritative revisions", (
    _name,
    changedPack,
  ) => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    const database = openDatabase(temporary.path, {
      now: () => timestamp,
      storeId: "store-pack-linkage",
    });
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO project_records VALUES (
        'task-1', 'project-1', 'task', 'active',
        'Safe outbound context', 'Contact person@example.com before release.',
        'human', NULL, 1, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions VALUES ('task-1', 1, ?, ?)
    `).run(JSON.stringify(pack.task.record), timestamp);
    database.prepare(`
      INSERT INTO context_packs VALUES (
        'pack-1', 'project-1', 'task-1', 1, 4000, 80, ?, ?
      )
    `).run(JSON.stringify(changedPack), timestamp);

    const report = checker().checkConnection(database, "full");
    database.close();

    expect(report.issues.map(({ code }) => code)).toContain(
      "outbound_state_invalid",
    );
  });

  it.each([
    ["two current destination revisions", (database: Database.Database) => {
      database.exec(`
        DROP INDEX idx_outbound_destinations_current_profile;
        INSERT INTO outbound_destinations VALUES (
          'destination-2', 2, 'profile-1', 'Other', 'gateway', 'Provider',
          NULL, NULL, 'remote', 'enabled', 1, '${timestamp}', '${timestamp}'
        );
      `);
    }],
    ["a destination revision gap", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_destinations SET is_current = 0
        WHERE destination_id = 'destination-1';
        INSERT INTO outbound_destinations VALUES (
          'destination-1', 3, 'profile-1', 'Codex workstation',
          'ide_managed', 'OpenAI', NULL, NULL, 'remote', 'enabled', 1,
          '${timestamp}', '${timestamp}'
        );
      `);
    }],
    ["a changed destination identity within one profile history", (database: Database.Database) => {
      database.exec(`
        DELETE FROM outbound_policies;
        UPDATE outbound_destinations SET is_current = 0
        WHERE destination_id = 'destination-1';
        INSERT INTO outbound_destinations VALUES (
          'destination-2', 2, 'profile-1', 'Other',
          'ide_managed', 'OpenAI', NULL, NULL, 'remote', 'enabled', 1,
          '${timestamp}', '${timestamp}'
        );
      `);
    }],
    ["a current destination revision that is not the latest", (database: Database.Database) => {
      database.exec(`
        INSERT INTO outbound_destinations VALUES (
          'destination-1', 2, 'profile-1', 'Later',
          'ide_managed', 'OpenAI', NULL, NULL, 'remote', 'enabled', 0,
          '${timestamp}', '${timestamp}'
        );
      `);
    }],
    ["an invalid destination timestamp", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_destinations SET updated_at = 'not-a-timestamp'
        WHERE destination_id = 'destination-1';
      `);
    }],
    ["a request destination snapshot mismatch", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_requests SET destination_snapshot_json = ?
        WHERE id = 'request-1'
      `).run(JSON.stringify({ ...destination, providerLabel: "Wrong" }));
    }],
    ["a request hash mismatch", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_requests SET request_hash = ?
        WHERE id = 'request-1'
      `).run("0".repeat(64));
    }],
    ["an invalid request timestamp", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_requests SET created_at = 'not-a-timestamp'
        WHERE id = 'request-1';
      `);
    }],
    ["a request candidate digest mismatch", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_requests SET candidate_digest = ?
        WHERE id = 'request-1'
      `).run("f".repeat(64));
    }],
    ["an invalid released-request decision matrix", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_requests SET decision_actor = NULL
        WHERE id = 'request-1';
      `);
    }],
    ["a request task, pack, and project mismatch", (database: Database.Database) => {
      database.exec(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES (
          'project-2', 'Other', 1, NULL, '${timestamp}', '${timestamp}'
        );
        INSERT INTO project_records VALUES (
          'task-2', 'project-2', 'task', 'active', 'Other', 'Other body',
          'human', NULL, 1, '${timestamp}', '${timestamp}'
        );
        UPDATE outbound_requests SET task_id = 'task-2'
        WHERE id = 'request-1';
      `);
    }],
    ["context-pack columns that disagree with the raw pack", (database: Database.Database) => {
      database.exec(`
        UPDATE context_packs SET budget_tokens = budget_tokens + 1
        WHERE id = 'pack-1';
      `);
    }],
    ["a finding ordinal gap", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_findings SET ordinal = 99
        WHERE request_id = 'request-1' AND ordinal = 0
      `);
    }],
    ["a finding from a different detector version", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_findings SET detector_version = 'wrong'
        WHERE request_id = 'request-1';
      `);
    }],
    ["a recomputed finding key mismatch", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_findings SET finding_key = ?
        WHERE request_id = 'request-1' AND ordinal = 0
      `).run("f".repeat(64));
    }],
    ["finding counts that disagree with persisted decisions", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_requests SET finding_counts_json = ?
        WHERE id = 'request-1'
      `).run(JSON.stringify({
        total: 0,
        credential: 0,
        sensitive: 0,
        forcedRedact: 0,
        redactByDefault: 0,
        redacted: 0,
        includedOnce: 0,
      }));
    }],
    ["a forced finding included by decision", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_findings
        SET required_action = 'forced_redact', decision = 'include_once'
        WHERE request_id = 'request-1'
      `);
    }],
    ["a released request without exactly one release", (database: Database.Database) => {
      database.exec("DELETE FROM outbound_releases");
    }, true],
    ["a review-required request with a release", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_requests
        SET status = 'review_required'
        WHERE id = 'request-1'
      `);
    }],
    ["a denied request with a release", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_requests
        SET status = 'denied'
        WHERE id = 'request-1'
      `);
    }],
    ["a review-required request with terminal decision metadata", (database: Database.Database) => {
      database.exec(`
        DELETE FROM outbound_releases;
        UPDATE outbound_findings SET decision = NULL
        WHERE request_id = 'request-1';
        UPDATE outbound_requests
        SET status = 'review_required', release_id = NULL
        WHERE id = 'request-1';
      `);
    }, true],
    ["a denied request with a non-human decision actor", (database: Database.Database) => {
      database.exec(`
        DELETE FROM outbound_releases;
        UPDATE outbound_findings SET decision = NULL
        WHERE request_id = 'request-1';
        UPDATE outbound_requests
        SET status = 'denied', decision_actor = 'policy',
            decision_reason = 'denied', release_id = NULL
        WHERE id = 'request-1';
      `);
    }, true],
    ["a release source-pack mismatch", (database: Database.Database) => {
      database.exec(`
        INSERT INTO context_packs VALUES (
          'pack-2', 'project-1', 'task-1', 1, 4000, 80, '{}', '${timestamp}'
        );
        UPDATE outbound_releases SET source_pack_id = 'pack-2'
        WHERE id = 'release-1';
      `);
    }, true],
    ["a release request mismatch", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_requests SET status = 'denied', release_id = NULL
        WHERE id = 'request-1';
        INSERT INTO outbound_requests (
          id, profile_id, project_id, task_id, source_pack_id,
          idempotency_key, request_hash, destination_id,
          destination_revision, destination_snapshot_json, detector_version,
          safety_policy_version, candidate_digest, status,
          finding_counts_json, decision_actor, decision_reason, release_id,
          created_at, decided_at
        )
        SELECT
          'request-2', profile_id, project_id, task_id, source_pack_id,
          'key-2', request_hash, destination_id,
          destination_revision, destination_snapshot_json, detector_version,
          safety_policy_version, candidate_digest, 'released',
          finding_counts_json, decision_actor, decision_reason, 'release-1',
          created_at, decided_at
        FROM outbound_requests WHERE id = 'request-1';
        UPDATE outbound_releases SET request_id = 'request-2'
        WHERE id = 'release-1';
      `);
    }, true],
    ["a release JSON schema failure", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_releases SET content_json = '{}'
        WHERE id = 'release-1'
      `);
    }, true],
    ["a release digest mismatch", (database: Database.Database) => {
      database.prepare(`
        UPDATE outbound_releases SET sha256 = ?
        WHERE id = 'release-1'
      `).run("0".repeat(64));
    }, true],
    ["self-consistent release source metadata from a different candidate", (database: Database.Database) => {
      rewriteReleaseWithValidDigest(database, (release) => ({
        ...release,
        disclosure: {
          ...release.disclosure,
          sourceRecords: [],
        },
      }));
    }, true],
    ["a self-consistent wrong released-token estimate", (database: Database.Database) => {
      rewriteReleaseWithValidDigest(database, (release) => ({
        ...release,
        disclosure: {
          ...release.disclosure,
          releasedEstimatedTokens:
            release.disclosure.releasedEstimatedTokens + 1,
        },
      }));
    }, true],
    ["self-consistent release omissions absent from the source pack", (database: Database.Database) => {
      rewriteReleaseWithValidDigest(database, (release) => ({
        ...release,
        disclosure: {
          ...release.disclosure,
          omissions: [{
            recordId: "omitted-1",
            kind: "evidence",
            reason: "budget",
            retrievalRef: "record:omitted-1",
          }],
        },
      }));
    }, true],
    ["a self-consistent wrong release project revision", (database: Database.Database) => {
      rewriteReleaseWithValidDigest(database, (release) => ({
        ...release,
        disclosure: {
          ...release.disclosure,
          projectRevision: release.disclosure.projectRevision + 1,
        },
      }));
    }, true],
    ["a policy for a non-current descriptor", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_destinations SET is_current = 0
        WHERE destination_id = 'destination-1'
      `);
    }],
    ["a policy for the wrong safety version", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_policies SET safety_policy_version = 'wrong'
        WHERE profile_id = 'profile-1'
      `);
    }],
    ["a policy for the wrong detector version", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_policies SET detector_version = 'wrong'
        WHERE profile_id = 'profile-1';
      `);
    }],
    ["a policy with an invalid timestamp", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_policies SET updated_at = 'not-a-timestamp'
        WHERE profile_id = 'profile-1';
      `);
    }],
    ["automatic clean policy state without its enable audit", (database: Database.Database) => {
      database.exec(`
        UPDATE outbound_policies SET mode = 'auto_release_clean'
        WHERE profile_id = 'profile-1';
      `);
    }],
    ["a missing transactional scan-complete audit", (database: Database.Database) => {
      database.exec(`
        DROP TRIGGER audit_events_no_delete;
        DELETE FROM audit_events
        WHERE action_category = 'outbound_scan_completed';
      `);
    }],
    ["a raw value in an outbound audit idempotency field", (database: Database.Database) => {
      database.exec(`
        DROP TRIGGER audit_events_no_update;
        UPDATE audit_events
        SET idempotency_key =
          'sk-proj-SyntheticAuditIntegrityToken0123456789'
        WHERE action_category = 'outbound_scan_completed';
      `);
    }],
  ] as const)("rejects %s", (_name, corrupt, needsMutableRelease = false) => {
    const database = outboundDatabase({
      mutableReleases: needsMutableRelease,
    });
    corrupt(database);
    if (needsMutableRelease) restoreReleaseTriggers(database);
    expectOutboundInvalid(database);
  });

  it("rejects a finding with an invalid range", () => {
    const database = outboundDatabase();
    database.pragma("ignore_check_constraints = ON");
    database.exec(`
      UPDATE outbound_findings SET end_offset = start_offset
      WHERE request_id = 'request-1'
    `);

    expectOutboundInvalid(database);
  });

  it("parses every outbound JSON row after earlier malformed rows", () => {
    const database = outboundDatabase();
    database.exec(`
      INSERT INTO outbound_requests (
        id, profile_id, project_id, task_id, source_pack_id,
        idempotency_key, request_hash, destination_id,
        destination_revision, destination_snapshot_json, detector_version,
        safety_policy_version, candidate_digest, status,
        finding_counts_json, created_at
      ) VALUES (
        'request-0', 'profile-1', 'project-1', 'task-1', 'pack-1',
        'key-0', '${"c".repeat(64)}', 'destination-1', 1, '{bad', '1', '1',
        '${"d".repeat(64)}', 'denied', '{bad', '${timestamp}'
      );
      INSERT INTO outbound_releases (
        id, request_id, source_pack_id, content_json, disclosure_json,
        sha256, released_at
      ) VALUES (
        'release-0', 'request-0', 'pack-1', '{bad', '{bad',
        '${"e".repeat(64)}', '${timestamp}'
      );
    `);
    const destinationParse = vi.spyOn(
      outboundDestinationSnapshotSchema,
      "parse",
    );
    const countsParse = vi.spyOn(outboundFindingCountsSchema, "parse");
    const disclosureParse = vi.spyOn(outboundDisclosureSchema, "parse");
    const releaseParse = vi.spyOn(outboundReleaseSchema, "parse");

    const report = checker().checkConnection(database, "full");

    expect(destinationParse).toHaveBeenCalled();
    expect(countsParse).toHaveBeenCalled();
    expect(disclosureParse).toHaveBeenCalled();
    expect(releaseParse).toHaveBeenCalled();
    expect(report.issues.map(({ code }) => code)).toContain(
      "outbound_state_invalid",
    );
    database.close();
  });

  it("validates rows after an early malformed snapshot while emitting its issue once", () => {
    const path = fixture(2);
    const database = new Database(path);
    const validSnapshot = {
      id: "record-valid",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Valid title",
      body: "Valid body",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES (?, 1, ?, ?), (?, 1, ?, ?)
    `).run(
      "record-invalid",
      "{bad",
      timestamp,
      "record-valid",
      JSON.stringify(validSnapshot),
      timestamp,
    );
    database.close();
    const parse = vi.spyOn(projectRecordSchema, "parse");

    const report = checker().checkPath(path, "full");

    expect(parse).toHaveBeenCalledTimes(1);
    expect(report.issues.filter(
      ({ code }) => code === "revision_snapshot_invalid",
    )).toHaveLength(1);
  });

  it("reports unreadable SQLite inputs without exposing the path or stored bodies", () => {
    const temporary = createTemporaryDatabase();
    temporaries.push(temporary);
    writeFileSync(temporary.path, "not a SQLite database with private record body");

    const report = checker().checkPath(temporary.path, "full");

    expect(report).toMatchObject({
      passed: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "database_unreadable" }),
      ]),
    });
    expect(JSON.stringify(report)).not.toContain(temporary.path);
    expect(JSON.stringify(report)).not.toContain("private record body");
  });

  it("reports missing required objects and foreign key violations with stable codes", () => {
    const path = fixture();
    const database = new Database(path);
    database.pragma("foreign_keys = OFF");
    database.prepare("DROP TRIGGER audit_events_no_delete").run();
    database
      .prepare(
        `INSERT INTO project_records (
          id, project_id, kind, status, title, body, source_kind, source_ref,
          revision, created_at, updated_at
        ) VALUES ('bad-record', 'missing-project', 'task', 'active', 'Private title',
          'Private body', 'human', NULL, 1, ?, ?)`,
      )
      .run(timestamp, timestamp);
    database.close();

    const report = checker().checkPath(path, "full");

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "foreign_key_violation" }),
      expect.objectContaining({ code: "schema_object_missing" }),
    ]));
    expect(JSON.stringify(report)).not.toContain("Private body");
  });

  it.each([
    ["record revision mismatch", "record_revision_mismatch", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO project_records VALUES ('record-1', 'project-1', 'task', 'active', 'Title', 'Body', 'human', NULL, 2, '${timestamp}', '${timestamp}');
        INSERT INTO project_record_revisions VALUES ('record-1', 1, '{}', '${timestamp}');`);
      database.close();
    }],
    ["invalid revision snapshot", "revision_snapshot_invalid", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO project_records VALUES ('record-1', 'project-1', 'task', 'active', 'Title', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}');
        INSERT INTO project_record_revisions VALUES ('record-1', 1, '{bad', '${timestamp}');`);
      database.close();
    }],
    ["cross project relationship", "cross_project_relationship", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'One', 1, NULL, '${timestamp}', '${timestamp}'), ('project-2', 'Two', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO project_records VALUES ('record-1', 'project-1', 'task', 'active', 'Title', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}'), ('record-2', 'project-2', 'task', 'active', 'Title', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}');
        INSERT INTO record_relationships VALUES ('relation-1', 'project-1', 'record-1', 'record-2', 'related_to', '${timestamp}');`);
      database.close();
    }],
    ["cross project context pack", "cross_project_context_pack", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'One', 1, NULL, '${timestamp}', '${timestamp}'), ('project-2', 'Two', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO project_records VALUES ('task-1', 'project-2', 'task', 'active', 'Title', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}');
        INSERT INTO context_packs VALUES ('pack-1', 'project-1', 'task-1', 1, 1, 1, '{}', '${timestamp}');`);
      database.close();
    }],
    ["cross project governance references", "cross_project_governance_reference", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'One', 1, NULL, '${timestamp}', '${timestamp}'), ('project-2', 'Two', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO client_profiles VALUES ('profile-1', 'Profile', 'enabled', '${"a".repeat(64)}', '${timestamp}', '${timestamp}', '${timestamp}', NULL);
        INSERT INTO project_records VALUES ('task-1', 'project-2', 'task', 'active', 'Title', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}');
        INSERT INTO change_proposals VALUES ('proposal-1', 'project-1', 'profile-1', 'task-1', NULL, 1, 'pending', 'Reason', 'key-1', 'hash', NULL, NULL, '${timestamp}', '${timestamp}', NULL);`);
      database.close();
    }],
    ["invalid stored JSON", "stored_json_invalid", (path: string) => {
      const database = new Database(path);
      database.pragma("foreign_keys = OFF");
      database.exec(`INSERT INTO projects VALUES ('project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO client_profiles VALUES ('profile-1', 'Profile', 'enabled', '${"a".repeat(64)}', '${timestamp}', '${timestamp}', '${timestamp}', NULL);
        INSERT INTO idempotency_results VALUES ('profile-1', 'project-1', 'key-1', 'change-1', 'hash', 'applied', '{bad', '${timestamp}');`);
      database.close();
    }],
    ["invalid credential hash", "credential_hash_invalid", (path: string) => {
      const database = new Database(path);
      database.pragma("ignore_check_constraints = ON");
      database.exec(`INSERT INTO client_profiles VALUES ('profile-1', 'Profile', 'enabled', 'UPPERCASE', '${timestamp}', '${timestamp}', '${timestamp}', NULL);`);
      database.close();
    }],
  ])("reports %s", (_name, code, populate) => {
    const path = fixture();
    populate(path);
    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  it.each([
    [
      "a non-hierarchy parent_of endpoint",
      "hierarchy_endpoint_invalid",
      "Hierarchy relationship has a non-hierarchy endpoint.",
      `INSERT INTO record_relationships VALUES (
        'invalid-endpoint', 'project-hierarchy', 'record-decision', 'record-task',
        'parent_of', '${timestamp}'
      )`,
    ],
    [
      "multiple hierarchy parents",
      "hierarchy_multiple_parents",
      "Hierarchy record has multiple parents.",
      `INSERT INTO record_relationships VALUES
        ('parent-a', 'project-hierarchy', 'record-outcome', 'record-task', 'parent_of', '${timestamp}'),
        ('parent-b', 'project-hierarchy', 'record-initiative', 'record-task', 'parent_of', '${timestamp}')`,
    ],
    [
      "a hierarchy cycle",
      "hierarchy_cycle",
      "Hierarchy relationships contain a cycle.",
      `INSERT INTO record_relationships VALUES
        ('cycle-a', 'project-hierarchy', 'record-outcome', 'record-initiative', 'parent_of', '${timestamp}'),
        ('cycle-b', 'project-hierarchy', 'record-initiative', 'record-outcome', 'parent_of', '${timestamp}')`,
    ],
  ])("reports %s with one stable hierarchy issue", (_label, code, description, sql) => {
    const { database } = hierarchyDatabase();
    database.exec(sql);

    const report = checker().checkConnection(database, "full");

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([{ code, severity: "error", description }]);
    expect(integrityIssueSchema.parse(report.issues[0])).toEqual(report.issues[0]);
    database.close();
  });

  it("keeps valid hierarchy graphs project-scoped and clean", () => {
    const { database, store } = hierarchyDatabase();
    store.createRelationship({
      projectId: "project-hierarchy",
      fromRecordId: "record-outcome",
      toRecordId: "record-initiative",
      kind: "parent_of",
    });
    store.createRelationship({
      projectId: "project-hierarchy",
      fromRecordId: "record-initiative",
      toRecordId: "record-deliverable",
      kind: "parent_of",
    });
    const other = store.createProject({ name: "Other hierarchy" });
    const otherOutcome = store.createRecord({
      projectId: other.id, kind: "outcome", status: "active", title: "Other outcome",
      body: "A separate root.", sourceKind: "human", sourceRef: null,
    });
    const otherTask = store.createRecord({
      projectId: other.id, kind: "task", status: "active", title: "Other task",
      body: "A separate child.", sourceKind: "human", sourceRef: null,
    });
    store.createRelationship({
      projectId: other.id,
      fromRecordId: otherOutcome.id,
      toRecordId: otherTask.id,
      kind: "parent_of",
    });

    expect(checker().checkConnection(database, "full")).toMatchObject({
      passed: true,
      issues: [],
    });
    database.close();
  });

  it("rejects a revision history with a missing sequence member", () => {
    const path = fixture();
    const database = new Database(path);
    const snapshot = (revision: number) => JSON.stringify({
      id: "record-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: `Title ${revision}`,
      body: `Body ${revision}`,
      sourceKind: "human",
      sourceRef: null,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Project', 3, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO project_records VALUES (
        'record-1', 'project-1', 'task', 'active', 'Title 3', 'Body 3',
        'human', NULL, 3, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES ('record-1', 1, ?, ?), ('record-1', 3, ?, ?)
    `).run(snapshot(1), timestamp, snapshot(3), timestamp);
    database.close();

    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "record_revision_mismatch" }),
      ]),
    );
  });

  it("rejects an orphan revision row even when its JSON is valid", () => {
    const path = fixture();
    const database = new Database(path);
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES (?, 1, ?, ?)
    `).run("orphan-record", JSON.stringify({
      id: "orphan-record",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Orphan",
      body: "Orphan body",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }), timestamp);
    database.close();

    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "record_revision_mismatch" }),
      ]),
    );
  });

  it.each([
    ["record ID", { id: "other-record" }],
    ["project ID", { projectId: "other-project" }],
    ["revision", { revision: 2 }],
  ])("rejects snapshot JSON whose %s disagrees with its row", (
    _field,
    override,
  ) => {
    const path = fixture();
    const database = new Database(path);
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO project_records VALUES (
        'record-1', 'project-1', 'task', 'active', 'Title', 'Body',
        'human', NULL, 1, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES ('record-1', 1, ?, ?)
    `).run(JSON.stringify({
      id: "record-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Title",
      body: "Body",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...override,
    }), timestamp);
    database.close();

    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "record_revision_mismatch" }),
      ]),
    );
  });

  it("rejects a current snapshot whose record fields are stale", () => {
    const path = fixture();
    const database = new Database(path);
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO project_records VALUES (
        'record-1', 'project-1', 'task', 'active', 'Current title',
        'Current body', 'human', NULL, 1, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES ('record-1', 1, ?, ?)
    `).run(JSON.stringify({
      id: "record-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Stale title",
      body: "Current body",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }), timestamp);
    database.close();

    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "record_revision_mismatch" }),
      ]),
    );
  });

  it("rejects a non-null governance source task that does not exist", () => {
    const path = fixture();
    const database = new Database(path);
    database.pragma("foreign_keys = OFF");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Project', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Profile', 'enabled', '${"a".repeat(64)}',
        '${timestamp}', '${timestamp}', '${timestamp}', NULL
      );
      INSERT INTO change_proposals VALUES (
        'proposal-1', 'project-1', 'profile-1', 'missing-task', NULL, 1,
        'pending', 'Reason', 'key-1', 'hash', NULL, NULL,
        '${timestamp}', '${timestamp}', NULL
      );
    `);
    database.close();

    expect(checker().checkPath(path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "cross_project_governance_reference",
        }),
      ]),
    );
  });
});
