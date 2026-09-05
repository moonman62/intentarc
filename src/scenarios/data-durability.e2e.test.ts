import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  linkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { openIntentArcApplication } from "../app/create-application.js";
import { createBackupService } from "../durability/backup-service.js";
import { createBundleRepository } from "../durability/bundles.js";
import { createDurabilityCoordinator } from "../durability/coordinator.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import { createLeaseManager } from "../durability/leases.js";
import {
  diagnosticCaptureManifestSchema,
  type BackupSummary,
  type RestoreResult,
  type VerifiedBackup,
} from "../durability/model.js";
import type {
  OutboundRelease,
  RepositoryImportManifest,
  TaskContextPack,
} from "../domain/index.js";
import { computeImportManifestDigest } from "../import/canonical-manifest.js";
import {
  coordinationEventsNoUpdateTriggerSql,
  migrations,
} from "../storage/migrations.js";
import {
  createRestoreService,
  type RestoreReplacementPhase,
} from "../durability/restore-service.js";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { ensurePackagedTestBuild } from "../test-support/packaged-test-build.js";

const currentSchemaVersion = migrations.at(-1)!.version;

type ProcessResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type McpChild = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
let cliExecutable: string;
let mcpExecutable: string;
const fixtureTimestamp = "2026-07-27T12:00:00.000Z";
const fixtureTables = [
  "projects",
  "project_records",
  "project_record_revisions",
  "record_relationships",
  "context_packs",
  "client_profiles",
  "profile_project_authorities",
  "profile_scopes",
  "change_proposals",
  "proposal_operations",
  "idempotency_results",
  "audit_events",
] as const;
const coordinationDurabilityTables = [
  "task_claims",
  "task_checkpoints",
  "task_delegations",
  "task_submissions",
  "coordination_events",
  "coordination_idempotency",
] as const;
const outboundDurabilityTables = [
  "outbound_destinations",
  "outbound_policies",
  "outbound_requests",
  "outbound_findings",
  "outbound_releases",
  "audit_events",
] as const;
const repositoryImportDurabilityTables = [
  "repository_import_receipts",
  "audit_events",
] as const;
const repositoryIndexDurabilityTables = [
  ...repositoryImportDurabilityTables,
  "repository_sources",
  "repository_snapshots",
  "repository_nodes",
  "repository_node_observations",
  "repository_links",
  "repository_refresh_reviews",
] as const;

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const runProcess = (
  command: string,
  arguments_: readonly string[],
  environment: Record<string, string> = inheritedEnvironment(),
): Promise<ProcessResult> =>
  new Promise((resolveProcess, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({ code, stdout, stderr });
    });
    child.stdin.end();
  });

const runCli = (
  arguments_: readonly string[],
): Promise<ProcessResult> =>
  runProcess(process.execPath, [cliExecutable, ...arguments_]);

const successfulJson = async <Result>(
  operation: Promise<ProcessResult>,
): Promise<Result> => {
  const result = await operation;
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as Result;
};

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const readDatabase = <Result>(
  databasePath: string,
  operation: (database: Database.Database) => Result,
): Result => {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
};

const userVersion = (databasePath: string): number =>
  readDatabase(
    databasePath,
    (database) =>
      database.pragma("user_version", { simple: true }) as number,
  );

const storeIdentity = (databasePath: string): string =>
  readDatabase(
    databasePath,
    (database) =>
      (
        database.prepare(
          "SELECT store_id FROM store_metadata WHERE singleton = 1",
        ).get() as { store_id: string }
      ).store_id,
  );

const dumpFixtureRows = (
  databasePath: string,
): Record<string, unknown[]> =>
  readDatabase(databasePath, (database) =>
    Object.fromEntries(
      fixtureTables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );

const dumpSchema = (databasePath: string): unknown[] =>
  readDatabase(
    databasePath,
    (database) =>
      database.prepare(`
        SELECT type, name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all(),
  );

const assertAuditIsAppendOnly = (
  databasePath: string,
  auditId = "audit-fixture",
): void => {
  const database = new Database(databasePath);
  try {
    expect(() =>
      database.prepare(
        "UPDATE audit_events SET outcome = 'changed' WHERE id = ?",
      ).run(auditId),
    ).toThrow(/append-only/);
    expect(() =>
      database.prepare(
        "DELETE FROM audit_events WHERE id = ?",
      ).run(auditId),
    ).toThrow(/append-only/);
  } finally {
    database.close();
  }
};

const dumpExactRows = (
  databasePath: string,
  tables: readonly string[],
): Record<string, unknown[]> =>
  readDatabase(databasePath, (database) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );

const seedCoordinationDurability = (databasePath: string): void => {
  const database = new Database(databasePath);
  const projectId = "project-coordination-durability";
  const parentProfileId = "profile-coordination-parent";
  const childProfileId = "profile-coordination-child";
  const timeline = {
    fixtureCreatedAt: "2026-08-15T09:30:00.000Z",
    delegationOfferedAt: "2026-08-15T09:45:00.000Z",
    delegationAcceptedAt: "2026-08-15T09:50:00.000Z",
    claimAcquiredAt: "2026-08-15T10:00:00.000Z",
    renewalAt: "2026-08-15T10:03:00.000Z",
    checkpointAt: "2026-08-15T10:05:00.000Z",
    submissionAt: "2026-08-15T10:10:00.000Z",
    decisionAt: "2026-08-15T10:15:00.000Z",
    delegationExpiredAt: "2026-08-15T10:20:00.000Z",
    releasedAfterDecisionAt: "2026-08-15T10:25:00.000Z",
    claimExpiredAt: "2026-08-15T10:35:00.000Z",
    absoluteExpiresAt: "2026-08-15T14:00:00.000Z",
  } as const;
  const acquiredAt = timeline.claimAcquiredAt;
  const checkpointAt = timeline.checkpointAt;
  const endedAt = timeline.decisionAt;
  const expiresAt = timeline.claimExpiredAt;
  const absoluteExpiresAt = timeline.absoluteExpiresAt;
  const taskIds = [
    "task-claim-active",
    "task-claim-paused",
    "task-claim-released",
    "task-claim-submitted",
    "task-claim-expired",
    "task-claim-reconciled",
    "task-submission-conflicted",
    "task-submission-rejected",
    "task-submission-withdrawn",
    "task-delegation-offered",
    "task-delegation-accepted",
    "task-delegation-revoked",
    "task-delegation-expired",
  ] as const;
  const claimRows = [
    { id: "claim-active", taskId: "task-claim-active", state: "active", delegationId: "delegation-claimed", endedAt: null },
    { id: "claim-paused", taskId: "task-claim-paused", state: "paused", delegationId: null, endedAt: timeline.decisionAt },
    { id: "claim-released", taskId: "task-claim-released", state: "released", delegationId: null, endedAt: timeline.decisionAt },
    { id: "claim-submitted", taskId: "task-claim-submitted", state: "submitted", delegationId: null, endedAt: timeline.submissionAt },
    { id: "claim-expired", taskId: "task-claim-expired", state: "expired", delegationId: null, endedAt: timeline.claimExpiredAt },
    { id: "claim-reconciled", taskId: "task-claim-reconciled", state: "reconciled", delegationId: "delegation-completed", endedAt: timeline.decisionAt },
    { id: "claim-conflicted", taskId: "task-submission-conflicted", state: "released", delegationId: null, endedAt: timeline.releasedAfterDecisionAt },
    { id: "claim-rejected", taskId: "task-submission-rejected", state: "released", delegationId: null, endedAt: timeline.releasedAfterDecisionAt },
    { id: "claim-withdrawn", taskId: "task-submission-withdrawn", state: "released", delegationId: null, endedAt: timeline.releasedAfterDecisionAt },
  ] as const;
  const claimObjects = new Map<string, Record<string, unknown>>();

  try {
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      database.prepare(`
        INSERT INTO projects (id, name, revision, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(
        projectId,
        "Coordination durability",
        timeline.fixtureCreatedAt,
        timeline.fixtureCreatedAt,
      );
      for (const [profileId, name] of [
        [parentProfileId, "Coordination parent"],
        [childProfileId, "Coordination child"],
      ] as const) {
        database.prepare(`
          INSERT INTO client_profiles (
            id, name, status, token_hash, created_at, updated_at,
            token_rotated_at, last_used_at, execution_mode
          ) VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
        `).run(
          profileId,
          name,
          "a".repeat(64),
          timeline.fixtureCreatedAt,
          timeline.fixtureCreatedAt,
          timeline.fixtureCreatedAt,
        );
        database.prepare(`
          INSERT INTO profile_project_authorities (
            id, profile_id, project_id, mode, created_at, updated_at
          ) VALUES (?, ?, ?, 'proposal', ?, ?)
        `).run(
          `authority-${profileId}`,
          profileId,
          projectId,
          timeline.fixtureCreatedAt,
          timeline.fixtureCreatedAt,
        );
      }

      const insertRecord = database.prepare(`
        INSERT INTO project_records (
          id, project_id, kind, status, title, body, source_kind,
          source_ref, revision, created_at, updated_at
        ) VALUES (?, ?, 'task', 'active', ?, ?, 'human', NULL, 1, ?, ?)
      `);
      const insertRevision = database.prepare(`
        INSERT INTO project_record_revisions (
          record_id, revision, snapshot_json, created_at
        ) VALUES (?, 1, ?, ?)
      `);
      const insertPack = database.prepare(`
        INSERT INTO context_packs (
          id, project_id, task_id, project_revision, budget_tokens,
          estimated_tokens, content_json, created_at
        ) VALUES (?, ?, ?, 1, 4000, 80, ?, ?)
      `);
      for (const taskId of taskIds) {
        const record = {
          id: taskId,
          projectId,
          kind: "task" as const,
          status: "active" as const,
          title: `Durable ${taskId}`,
          body: "Preserve this coordination state exactly.",
          sourceKind: "human" as const,
          sourceRef: null,
          revision: 1,
          createdAt: timeline.fixtureCreatedAt,
          updatedAt: timeline.fixtureCreatedAt,
        };
        const pack: TaskContextPack = {
          id: `pack-${taskId}`,
          projectId,
          taskId,
          projectRevision: 1,
          generatedAt: acquiredAt,
          budgetTokens: 4_000,
          estimatedTokens: 80,
          stableFrame: [],
          task: {
            record,
            mandatory: true,
            relevance: "active_task",
            relationshipKind: null,
          },
          related: [],
          omissions: [],
          sourceRevisions: [{ recordId: taskId, revision: 1 }],
        };
        insertRecord.run(
          taskId,
          projectId,
          record.title,
          record.body,
          timeline.fixtureCreatedAt,
          timeline.fixtureCreatedAt,
        );
        insertRevision.run(taskId, JSON.stringify(record), timeline.fixtureCreatedAt);
        insertPack.run(pack.id, projectId, taskId, JSON.stringify(pack), acquiredAt);
      }
      const completedRecord = {
        id: "task-claim-reconciled",
        projectId,
        kind: "task" as const,
        status: "completed" as const,
        title: "Durable task-claim-reconciled",
        body: "Preserve this coordination state exactly.",
        sourceKind: "human" as const,
        sourceRef: null,
        revision: 2,
        createdAt: timeline.fixtureCreatedAt,
        updatedAt: endedAt,
      };
      database.prepare(`
        UPDATE project_records
        SET status = 'completed', revision = 2, updated_at = ?
        WHERE id = ?
      `).run(endedAt, completedRecord.id);
      database.prepare(`
        INSERT INTO project_record_revisions (
          record_id, revision, snapshot_json, created_at
        ) VALUES (?, 2, ?, ?)
      `).run(completedRecord.id, JSON.stringify(completedRecord), endedAt);
      database.prepare(`
        UPDATE projects SET revision = 2, updated_at = ? WHERE id = ?
      `).run(endedAt, projectId);

      const insertClaim = database.prepare(`
        INSERT INTO task_claims (
          id, project_id, task_id, profile_id, delegation_id, state,
          base_project_revision, base_task_revision, context_pack_id,
          acquired_at, expires_at, absolute_expires_at, ended_at,
          latest_checkpoint_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)
      `);
      const insertCheckpoint = database.prepare(`
        INSERT INTO task_checkpoints (
          id, claim_id, sequence, document_json, created_at,
          project_revision, task_revision, context_pack_id
        ) VALUES (?, ?, 1, ?, ?, 1, 1, ?)
      `);
      const checkpointDocument = {
        summary: "Durable checkpoint",
        completedWork: ["coordination state"],
        remainingWork: ["operator restore"],
        blockers: [],
        verificationEvidence: {
          tests: ["coordination durability"],
          artifacts: [],
        },
        repositoryEvidence: null,
      };
      for (const claimRow of claimRows) {
        const { id: claimId, taskId, state, delegationId } = claimRow;
        const checkpointId = `checkpoint-${claimId}`;
        const claim = {
          id: claimId,
          projectId,
          taskId,
          profileId: childProfileId,
          delegationId,
          state,
          baseProjectRevision: 1,
          baseTaskRevision: 1,
          contextPackId: `pack-${taskId}`,
          acquiredAt,
          expiresAt,
          absoluteExpiresAt,
          endedAt: claimRow.endedAt,
          latestCheckpointId: checkpointId,
        };
        claimObjects.set(claimId, claim);
        insertClaim.run(
          claimId,
          projectId,
          taskId,
          childProfileId,
          delegationId,
          state,
          claim.contextPackId,
          acquiredAt,
          expiresAt,
          absoluteExpiresAt,
          claim.endedAt,
          checkpointId,
        );
        insertCheckpoint.run(
          checkpointId,
          claimId,
          JSON.stringify(checkpointDocument),
          checkpointAt,
          claim.contextPackId,
        );
      }

      const insertDelegation = database.prepare(`
        INSERT INTO task_delegations (
          id, project_id, task_id, parent_profile_id, child_profile_id,
          state, base_project_revision, base_task_revision, scope_json,
          allowed_outputs_json, offered_at, deadline, accepted_at, ended_at,
          claim_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const delegation of [
        { id: "delegation-offered", taskId: "task-delegation-offered", state: "offered", acceptedAt: null, endedAt: null, claimId: null, deadline: "2026-08-15T13:00:00.000Z" },
        { id: "delegation-accepted", taskId: "task-delegation-accepted", state: "accepted", acceptedAt: timeline.delegationAcceptedAt, endedAt: null, claimId: null, deadline: "2026-08-15T13:00:00.000Z" },
        { id: "delegation-revoked", taskId: "task-delegation-revoked", state: "revoked", acceptedAt: null, endedAt: timeline.decisionAt, claimId: null, deadline: "2026-08-15T13:00:00.000Z" },
        { id: "delegation-expired", taskId: "task-delegation-expired", state: "expired", acceptedAt: null, endedAt: timeline.delegationExpiredAt, claimId: null, deadline: timeline.delegationExpiredAt },
        { id: "delegation-claimed", taskId: "task-claim-active", state: "claimed", acceptedAt: timeline.delegationAcceptedAt, endedAt: null, claimId: "claim-active", deadline: "2026-08-15T13:00:00.000Z" },
        { id: "delegation-completed", taskId: "task-claim-reconciled", state: "completed", acceptedAt: timeline.delegationAcceptedAt, endedAt: timeline.decisionAt, claimId: "claim-reconciled", deadline: "2026-08-15T13:00:00.000Z" },
      ] as const) {
        insertDelegation.run(
          delegation.id,
          projectId,
          delegation.taskId,
          parentProfileId,
          childProfileId,
          delegation.state,
          JSON.stringify({
            summary: `Durable ${delegation.state} delegation`,
            constraints: [],
          }),
          JSON.stringify(["update_record"]),
          timeline.delegationOfferedAt,
          delegation.deadline,
          delegation.acceptedAt,
          delegation.endedAt,
          delegation.claimId,
        );
      }

      const insertProposal = database.prepare(`
        INSERT INTO change_proposals (
          id, project_id, profile_id, source_task_id,
          predecessor_proposal_id, base_project_revision, state, rationale,
          idempotency_key, request_hash, review_reason, reviewer_actor,
          created_at, updated_at, reviewed_at, origin_type,
          repository_snapshot_id
        ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'profile', NULL)
      `);
      const insertOperation = database.prepare(`
        INSERT INTO proposal_operations (
          proposal_id, position, operation_id, operation_type,
          expected_record_revision, payload_json
        ) VALUES (?, 0, ?, 'update_record', 1, ?)
      `);
      const insertSubmission = database.prepare(`
        INSERT INTO task_submissions (
          id, claim_id, checkpoint_id, profile_id, project_id, task_id,
          base_project_revision, base_task_revision, context_pack_id,
          document_json, proposal_id, state, submitted_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)
      `);
      const submissionRows = [
        { state: "submitted", claimId: "claim-submitted", taskId: "task-claim-submitted", decidedAt: null },
        { state: "conflicted", claimId: "claim-conflicted", taskId: "task-submission-conflicted", decidedAt: timeline.submissionAt },
        { state: "accepted", claimId: "claim-reconciled", taskId: "task-claim-reconciled", decidedAt: timeline.decisionAt },
        { state: "rejected", claimId: "claim-rejected", taskId: "task-submission-rejected", decidedAt: timeline.decisionAt },
        { state: "withdrawn", claimId: "claim-withdrawn", taskId: "task-submission-withdrawn", decidedAt: timeline.decisionAt },
      ] as const;
      for (const submissionRow of submissionRows) {
        const { state, claimId, taskId, decidedAt } = submissionRow;
        const proposalId = `proposal-${state}`;
        const operationId = `operation-${state}`;
        const operation = {
          operationId,
          type: "update_record" as const,
          recordId: taskId,
          expectedRecordRevision: 1,
          patch: { status: "completed" as const },
        };
        const document = {
          summary: `Durable ${state} submission`,
          verificationEvidence: {
            tests: ["coordination durability"],
            artifacts: [],
          },
          repositoryEvidence: null,
          changes: {
            rationale: `Preserve the ${state} decision.`,
            operations: [operation],
          },
        };
        insertProposal.run(
          proposalId,
          projectId,
          childProfileId,
          taskId,
          state === "submitted" ? "pending" : state,
          document.changes.rationale,
          `proposal-${state}-key`,
          "b".repeat(64),
          timeline.submissionAt,
          decidedAt ?? timeline.submissionAt,
          decidedAt,
        );
        insertOperation.run(proposalId, operationId, JSON.stringify(operation));
        insertSubmission.run(
          `submission-${state}`,
          claimId,
          `checkpoint-${claimId}`,
          childProfileId,
          projectId,
          taskId,
          `pack-${taskId}`,
          JSON.stringify(document),
          proposalId,
          state,
          timeline.submissionAt,
          decidedAt,
        );
      }

      type EventSeed = {
        category: string;
        taskId: string;
        claimId: string | null;
        delegationId: string | null;
        checkpointId: string | null;
        submissionId: string | null;
        proposalId: string | null;
        resultingState: string | null;
        createdAt: string;
      };
      const eventRows: EventSeed[] = [
        { category: "ready_evaluation", taskId: "task-claim-active", claimId: null, delegationId: null, checkpointId: null, submissionId: null, proposalId: null, resultingState: null, createdAt: timeline.claimAcquiredAt },
        ...claimRows.map((claim) => ({
          category: "claim", taskId: claim.taskId, claimId: claim.id,
          delegationId: claim.delegationId, checkpointId: null, submissionId: null,
          proposalId: null, resultingState: "active", createdAt: timeline.claimAcquiredAt,
        })),
        ...claimRows.map((claim) => ({
          category: "checkpoint", taskId: claim.taskId, claimId: claim.id,
          delegationId: null, checkpointId: `checkpoint-${claim.id}`, submissionId: null,
          proposalId: null, resultingState: "active", createdAt: timeline.checkpointAt,
        })),
        { category: "renewal", taskId: "task-claim-active", claimId: "claim-active", delegationId: null, checkpointId: null, submissionId: null, proposalId: null, resultingState: "active", createdAt: timeline.renewalAt },
        { category: "switch", taskId: "task-claim-active", claimId: "claim-active", delegationId: "delegation-claimed", checkpointId: null, submissionId: null, proposalId: null, resultingState: "active", createdAt: timeline.claimAcquiredAt },
        ...claimRows.filter((claim) => claim.state === "paused").map((claim) => ({
          category: "pause", taskId: claim.taskId, claimId: claim.id, delegationId: claim.delegationId,
          checkpointId: null, submissionId: null, proposalId: null,
          resultingState: "paused", createdAt: claim.endedAt!,
        })),
        ...claimRows.filter((claim) => claim.state === "released").map((claim) => ({
          category: "release", taskId: claim.taskId, claimId: claim.id, delegationId: claim.delegationId,
          checkpointId: null, submissionId: null, proposalId: null,
          resultingState: "released", createdAt: claim.endedAt!,
        })),
        ...claimRows.filter((claim) => claim.state === "expired").map((claim) => ({
          category: "expiry", taskId: claim.taskId, claimId: claim.id, delegationId: claim.delegationId,
          checkpointId: null, submissionId: null, proposalId: null,
          resultingState: "expired", createdAt: claim.endedAt!,
        })),
        ...([
          ["delegation-offered", "task-delegation-offered"],
          ["delegation-accepted", "task-delegation-accepted"],
          ["delegation-revoked", "task-delegation-revoked"],
          ["delegation-expired", "task-delegation-expired"],
          ["delegation-claimed", "task-claim-active"],
          ["delegation-completed", "task-claim-reconciled"],
        ] as const).map(([delegationId, taskId]) => ({
          category: "delegation_offer", taskId, claimId: null, delegationId,
          checkpointId: null, submissionId: null, proposalId: null,
          resultingState: "offered", createdAt: timeline.delegationOfferedAt,
        })),
        ...([
          ["delegation-accepted", "task-delegation-accepted"],
          ["delegation-claimed", "task-claim-active"],
          ["delegation-completed", "task-claim-reconciled"],
        ] as const).map(([delegationId, taskId]) => ({
          category: "delegation_accept", taskId, claimId: null, delegationId,
          checkpointId: null, submissionId: null, proposalId: null,
          resultingState: "accepted", createdAt: timeline.delegationAcceptedAt,
        })),
        { category: "delegation_revoke", taskId: "task-delegation-revoked", claimId: null, delegationId: "delegation-revoked", checkpointId: null, submissionId: null, proposalId: null, resultingState: "revoked", createdAt: timeline.decisionAt },
        { category: "expiry", taskId: "task-delegation-expired", claimId: null, delegationId: "delegation-expired", checkpointId: null, submissionId: null, proposalId: null, resultingState: "expired", createdAt: timeline.delegationExpiredAt },
        ...submissionRows.map((submission) => ({
          category: submission.state === "conflicted" ? "conflict" : "submission",
          taskId: submission.taskId, claimId: submission.claimId,
          delegationId: submission.state === "accepted" ? "delegation-completed" : null,
          checkpointId: `checkpoint-${submission.claimId}`,
          submissionId: `submission-${submission.state}`,
          proposalId: `proposal-${submission.state}`,
          resultingState: submission.state === "conflicted" ? "conflicted" : "submitted",
          createdAt: timeline.submissionAt,
        })),
        { category: "reconciliation", taskId: "task-claim-reconciled", claimId: "claim-reconciled", delegationId: "delegation-completed", checkpointId: "checkpoint-claim-reconciled", submissionId: "submission-accepted", proposalId: "proposal-accepted", resultingState: "reconciled", createdAt: timeline.decisionAt },
      ];
      const insertEvent = database.prepare(`
        INSERT INTO coordination_events (
          id, category, project_id, task_id, profile_id, claim_id,
          delegation_id, checkpoint_id, submission_id, proposal_id,
          prior_state, resulting_state, project_revision, task_revision,
          detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      eventRows.forEach((event, index) => {
        const priorState = (() => {
          switch (event.category) {
            case "ready_evaluation":
            case "claim":
            case "delegation_offer":
              return null;
            case "renewal":
            case "checkpoint":
            case "pause":
            case "switch":
            case "submission":
            case "conflict":
              return "active";
            case "release":
              return submissionRows.some(({ claimId }) => claimId === event.claimId)
                ? "submitted"
                : "active";
            case "expiry":
              return event.claimId === null ? "offered" : "active";
            case "delegation_accept":
              return "offered";
            case "delegation_revoke":
              return "offered";
            case "reconciliation":
              return "submitted";
            default:
              throw new Error(`Unexpected coordination event category: ${event.category}`);
          }
        })();
        insertEvent.run(
          `event-${String(index + 1).padStart(2, "0")}`,
          event.category,
          projectId,
          event.taskId,
          event.category === "ready_evaluation"
            ? null
            : ["delegation_offer", "delegation_revoke"].includes(event.category)
              ? parentProfileId
              : childProfileId,
          event.claimId,
          event.delegationId,
          event.checkpointId,
          event.submissionId,
          event.proposalId,
          priorState,
          event.resultingState,
          event.category === "reconciliation" ? 2 : 1,
          event.category === "reconciliation" ? 2 : 1,
          `durable ${event.category}`,
          event.createdAt,
        );
      });

      const insertIdempotency = database.prepare(`
        INSERT INTO coordination_idempotency (
          profile_id, project_id, operation, idempotency_key,
          request_hash, result_json, created_at
        ) VALUES (?, ?, 'checkpoint', ?, ?, ?, ?)
      `);
      for (const claimRow of claimRows) {
        const claimId = claimRow.id;
        const claimAtCheckpoint = {
          ...claimObjects.get(claimId),
          state: "active",
          endedAt: null,
        };
        const checkpoint = {
          id: `checkpoint-${claimId}`,
          claimId,
          sequence: 1,
          ...checkpointDocument,
          createdAt: timeline.checkpointAt,
          projectRevision: 1,
          taskRevision: 1,
          contextPackId: `pack-${claimRow.taskId}`,
        };
        insertIdempotency.run(
          childProfileId,
          projectId,
          `checkpoint-${claimId}`,
          "c".repeat(64),
          JSON.stringify({ claim: claimAtCheckpoint, checkpoint }),
          timeline.checkpointAt,
        );
      }
    })();
  } finally {
    database.close();
  }
};

const seedRepositoryIndexDurability = (databasePath: string): void => {
  const database = new Database(databasePath);
  try {
    const receipt = database.prepare(`
      SELECT project_id FROM repository_import_receipts
    `).get() as { project_id: string };
    const record = database.prepare(`
      SELECT id FROM project_records WHERE project_id = ? ORDER BY id LIMIT 1
    `).get(receipt.project_id) as { id: string };
    database.prepare(`
      INSERT INTO repository_sources (
        id, project_id, root, canonical_subpath, repository_identity,
        status, current_snapshot_id, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'available', NULL, ?, ?)
    `).run(
      "source-durability",
      receipt.project_id,
      "C:/synthetic/repository",
      "repository-durability",
      fixtureTimestamp,
      fixtureTimestamp,
    );
    database.prepare(`
      INSERT INTO repository_snapshots (
        id, source_id, project_id, state, base_snapshot_id,
        base_project_revision, branch, head, fingerprint, scanner_version,
        ruleset_version, warning_counts_json, exclusion_counts_json,
        finding_counts_json, created_at, decided_at, applied_at
      ) VALUES (
        'snapshot-durability', 'source-durability', ?, 'accepted', NULL, 1,
        'main', ?, ?, '1', '1', '{}', '{}', '{"overview":1}', ?, ?, ?
      )
    `).run(
      receipt.project_id,
      "a".repeat(40),
      "b".repeat(64),
      fixtureTimestamp,
      fixtureTimestamp,
      fixtureTimestamp,
    );
    database.exec(`
      UPDATE repository_sources
      SET current_snapshot_id = 'snapshot-durability'
      WHERE id = 'source-durability';
      INSERT INTO repository_nodes VALUES (
        'node-durability', 'source-durability', 'file', '${fixtureTimestamp}'
      );
      INSERT INTO repository_node_observations VALUES (
        'snapshot-durability', 'node-durability', 'source-durability', NULL,
        'README.md', 'file', '${"c".repeat(64)}', 42, 'tracked',
        'canonical_source', 'overview', 'markdown', 1, NULL, NULL
      );
    `);
    database.prepare(`
      INSERT INTO repository_links VALUES (
        'link-durability', ?, 'snapshot-durability', 'source-durability',
        'node-durability', ?, NULL, 'documents', 'observed', ?
      )
    `).run(receipt.project_id, record.id, fixtureTimestamp);
    database.prepare(`
      INSERT INTO repository_refresh_reviews VALUES (
        ?, 'source-durability', 'snapshot-durability', 'applied',
        '["operation-durability"]', ?, ?, ?
      )
    `).run(
      receipt.project_id,
      fixtureTimestamp,
      fixtureTimestamp,
      fixtureTimestamp,
    );
  } finally {
    database.close();
  }
};

const promoteFixtureToVersionThree = (
  databasePath: string,
  fixtureStoreId: string,
): void => {
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      database.exec(migrations.find(({ version }) => version === 3)!.sql);
      database.prepare(`
        INSERT INTO store_metadata (singleton, store_id, created_at)
        VALUES (1, ?, ?)
      `).run(fixtureStoreId, fixtureTimestamp);
      database.pragma("user_version = 3");
    })();
  } finally {
    database.close();
  }
};

const createVersionFourFixture = (
  databasePath: string,
  fixtureStoreId: string,
): void => {
  const database = createVersionedDatabaseFixture(databasePath, 4);
  try {
    database.prepare(`
      INSERT INTO store_metadata (singleton, store_id, created_at)
      VALUES (1, ?, ?)
    `).run(fixtureStoreId, fixtureTimestamp);
  } finally {
    database.close();
  }
};

const rewriteBackupManifestForSnapshot = (
  bundlePath: string,
): void => {
  const snapshotPath = join(bundlePath, "database.sqlite");
  const manifestPath = join(bundlePath, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.byteSize = statSync(snapshotPath).size;
  manifest.sha256 = sha256(snapshotPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const corruptReleaseSnapshot = (
  bundlePath: string,
  corruption: "content_json" | "sha256",
): void => {
  const snapshotPath = join(bundlePath, "database.sqlite");
  const database = new Database(snapshotPath);
  try {
    database.transaction(() => {
      database.exec("DROP TRIGGER outbound_releases_no_update");
      if (corruption === "content_json") {
        database.prepare(`
          UPDATE outbound_releases
          SET content_json = '{"invalid":true}'
          WHERE rowid = (SELECT MIN(rowid) FROM outbound_releases)
        `).run();
      } else {
        database.prepare(`
          UPDATE outbound_releases
          SET sha256 = ?
          WHERE rowid = (SELECT MIN(rowid) FROM outbound_releases)
        `).run("f".repeat(64));
      }
      database.exec(`
        CREATE TRIGGER outbound_releases_no_update
        BEFORE UPDATE ON outbound_releases
        BEGIN
          SELECT RAISE(ABORT, 'outbound releases are immutable');
        END
      `);
    })();
  } finally {
    database.close();
  }
  rewriteBackupManifestForSnapshot(bundlePath);
};

const corruptRepositoryImportSnapshot = (bundlePath: string): void => {
  const snapshotPath = join(bundlePath, "database.sqlite");
  const database = new Database(snapshotPath);
  try {
    database.transaction(() => {
      database.exec("DROP TRIGGER repository_import_receipts_no_update");
      database.pragma("ignore_check_constraints = ON");
      database.prepare(`
        UPDATE repository_import_receipts
        SET manifest_digest = ?
        WHERE rowid = (SELECT MIN(rowid) FROM repository_import_receipts)
      `).run("A".repeat(64));
      database.pragma("ignore_check_constraints = OFF");
      database.exec(`
        CREATE TRIGGER repository_import_receipts_no_update
        BEFORE UPDATE ON repository_import_receipts
        BEGIN
          SELECT RAISE(ABORT, 'repository import receipts are append-only');
        END
      `);
    })();
  } finally {
    database.close();
  }
  rewriteBackupManifestForSnapshot(bundlePath);
};

const repositoryImportManifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: fixtureTimestamp,
  repository: {
    root: "C:/synthetic/repository",
    canonicalSubpath: null,
    branch: "main",
    head: "d".repeat(40),
    fingerprint: "e".repeat(64),
  },
  discovery: {
    sources: [{
      path: "README.md",
      status: "tracked",
      role: "canonical_source",
      byteSize: 42,
      sha256: "f".repeat(64),
      extraction: {
        title: "Synthetic repository",
        headings: ["Plan"],
      },
    }],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Imported durability project",
      primaryRepositoryPath: "C:/synthetic/repository",
    },
    records: [{
      key: "task",
      kind: "task",
      status: "active",
      title: "Verify imported durability",
      body: "Preserve repository import evidence through local backups.",
      sourceKind: "repository",
      sourceRef: "README.md",
      sourceRefs: ["README.md"],
      curationReason: null,
    }],
    relationships: [],
  },
});

const recordSnapshot = (input: {
  readonly id: string;
  readonly kind: "task" | "decision";
  readonly status: "active" | "accepted";
  readonly title: string;
  readonly body: string;
  readonly revision: number;
}) => ({
  id: input.id,
  projectId: "project-fixture",
  kind: input.kind,
  status: input.status,
  title: input.title,
  body: input.body,
  sourceKind: "human",
  sourceRef: null,
  revision: input.revision,
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
});

const createCompleteVersionTwoFixture = (
  databasePath: string,
): void => {
  const database = createVersionedDatabaseFixture(databasePath, 2);
  const taskRevisionOne = recordSnapshot({
    id: "task-fixture",
    kind: "task",
    status: "active",
    title: "Original durability task",
    body: "The first immutable task revision.",
    revision: 1,
  });
  const taskRevisionTwo = {
    ...taskRevisionOne,
    title: "Durability task",
    body: "The current immutable task revision.",
    revision: 2,
  };
  const decision = recordSnapshot({
    id: "decision-fixture",
    kind: "decision",
    status: "accepted",
    title: "Keep recovery local",
    body: "Use portable local backup bundles.",
    revision: 1,
  });
  const contextPack = {
    id: "context-fixture",
    projectId: "project-fixture",
    taskId: taskRevisionTwo.id,
    projectRevision: 2,
    generatedAt: fixtureTimestamp,
    budgetTokens: 1000,
    estimatedTokens: 100,
    stableFrame: [],
    task: {
      record: taskRevisionTwo,
      mandatory: true,
      relevance: "active_task",
      relationshipKind: null,
    },
    related: [{
      record: decision,
      mandatory: false,
      relevance: "linked",
      relationshipKind: "decided_by",
    }],
    omissions: [],
    sourceRevisions: [
      { recordId: decision.id, revision: 1 },
      { recordId: taskRevisionTwo.id, revision: 2 },
    ],
  };
  const proposalOperation = {
    operationId: "operation-fixture",
    type: "update_record",
    recordId: taskRevisionTwo.id,
    expectedRecordRevision: 2,
    patch: { status: "completed" },
  };
  const storedResult = {
    outcome: "proposed",
    changeId: "change-fixture",
    proposalId: "proposal-fixture",
    state: "pending",
    replayed: false,
  };

  try {
    database.transaction(() => {
      database.prepare(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "project-fixture",
        "Durability fixture",
        2,
        null,
        fixtureTimestamp,
        fixtureTimestamp,
      );

      const insertRecord = database.prepare(`
        INSERT INTO project_records (
          id, project_id, kind, status, title, body, source_kind,
          source_ref, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of [taskRevisionTwo, decision]) {
        insertRecord.run(
          record.id,
          record.projectId,
          record.kind,
          record.status,
          record.title,
          record.body,
          record.sourceKind,
          record.sourceRef,
          record.revision,
          record.createdAt,
          record.updatedAt,
        );
      }

      const insertRevision = database.prepare(`
        INSERT INTO project_record_revisions (
          record_id, revision, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const record of [taskRevisionOne, taskRevisionTwo, decision]) {
        insertRevision.run(
          record.id,
          record.revision,
          JSON.stringify(record),
          fixtureTimestamp,
        );
      }

      database.prepare(`
        INSERT INTO record_relationships (
          id, project_id, from_record_id, to_record_id, kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "relationship-fixture",
        "project-fixture",
        taskRevisionTwo.id,
        decision.id,
        "decided_by",
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO context_packs (
          id, project_id, task_id, project_revision, budget_tokens,
          estimated_tokens, content_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contextPack.id,
        contextPack.projectId,
        contextPack.taskId,
        contextPack.projectRevision,
        contextPack.budgetTokens,
        contextPack.estimatedTokens,
        JSON.stringify(contextPack),
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO client_profiles (
          id, name, status, token_hash, created_at, updated_at,
          token_rotated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "profile-fixture",
        "Fixture client",
        "enabled",
        "a".repeat(64),
        fixtureTimestamp,
        fixtureTimestamp,
        fixtureTimestamp,
        null,
      );
      database.prepare(`
        INSERT INTO profile_project_authorities (
          id, profile_id, project_id, mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "authority-fixture",
        "profile-fixture",
        "project-fixture",
        "scoped_direct",
        fixtureTimestamp,
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO profile_scopes (
          id, authority_id, operation_type, record_kind, from_record_kind,
          to_record_kind, relationship_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "scope-fixture",
        "authority-fixture",
        "update_record",
        "task",
        null,
        null,
        null,
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO change_proposals (
          id, project_id, profile_id, source_task_id,
          predecessor_proposal_id, base_project_revision, state, rationale,
          idempotency_key, request_hash, review_reason, reviewer_actor,
          created_at, updated_at, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "proposal-fixture",
        "project-fixture",
        "profile-fixture",
        taskRevisionTwo.id,
        null,
        2,
        "pending",
        "Exercise durable proposal persistence.",
        "idempotency-fixture",
        "request-hash-fixture",
        null,
        null,
        fixtureTimestamp,
        fixtureTimestamp,
        null,
      );
      database.prepare(`
        INSERT INTO proposal_operations (
          proposal_id, position, operation_id, operation_type,
          expected_record_revision, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "proposal-fixture",
        0,
        proposalOperation.operationId,
        proposalOperation.type,
        proposalOperation.expectedRecordRevision,
        JSON.stringify(proposalOperation),
      );
      database.prepare(`
        INSERT INTO idempotency_results (
          profile_id, project_id, idempotency_key, change_id, request_hash,
          outcome, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "profile-fixture",
        "project-fixture",
        "idempotency-fixture",
        "change-fixture",
        "request-hash-fixture",
        "proposed",
        JSON.stringify(storedResult),
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO audit_events (
          id, project_id, actor_type, profile_id, authority_mode,
          scope_decision, action_category, target_id, idempotency_key,
          revision_before, revision_after, outcome, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "audit-fixture",
        "project-fixture",
        "profile",
        "profile-fixture",
        "scoped_direct",
        "allowed",
        "change_submitted",
        "proposal-fixture",
        "idempotency-fixture",
        2,
        2,
        "proposed",
        null,
        fixtureTimestamp,
      );
    })();
  } finally {
    database.close();
  }
};

const createCurrentStore = async (
  candidate: TemporaryDatabase,
  projectName: string,
): Promise<string> => {
  const application = await openIntentArcApplication({
    databasePath: candidate.path,
  });
  try {
    application.service.createProject({ name: projectName });
  } finally {
    application.close();
  }
  return storeIdentity(candidate.path);
};

const createOutboundDurabilityState = async (
  candidate: TemporaryDatabase,
): Promise<{
  readonly profileId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly releases: readonly OutboundRelease[];
}> => {
  const application = await openIntentArcApplication({
    databasePath: candidate.path,
  });
  try {
    const project = application.service.createProject({
      name: "Outbound durability fixture",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Protect the release history",
      body: "Keep exact outbound rows in every verified restore.",
      sourceKind: "human",
      sourceRef: null,
    });
    const credentials = application.service.profiles.createProfile({
      name: "Synthetic durability client",
      projectId: project.id,
    });
    application.service.destinations.set({
      profileId: credentials.profile.id,
      clientLabel: "Synthetic durability destination",
      type: "gateway",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic account",
      dataBoundary: "remote",
    });
    const principal = application.service.profiles.authenticate({
      profileId: credentials.profile.id,
      token: credentials.token,
    });
    if (!principal) throw new Error("Expected an authenticated fixture profile");

    const cleanRequest = application.service.outbound.request(principal, {
      projectId: project.id,
      taskId: task.id,
      budgetTokens: 4000,
      idempotencyKey: "durability-clean-request",
    });
    const cleanRelease = application.service.outbound.approve({
      requestId: cleanRequest.requestId,
      rememberClean: true,
      includeFindingIds: [],
    });

    application.service.updateRecord({
      projectId: project.id,
      recordId: task.id,
      expectedRecordRevision: 1,
      patch: {
        body:
          "Use api_key=synthetic-value-123456789 with owner@example.invalid only in this fixture.",
      },
    });
    const findingRequest = application.service.outbound.request(principal, {
      projectId: project.id,
      taskId: task.id,
      budgetTokens: 4000,
      idempotencyKey: "durability-finding-request",
    });
    const possibleFinding = application.service.outbound
      .inspect(findingRequest.requestId)
      .findings.find(({ category }) => category === "email");
    if (!possibleFinding) {
      throw new Error("Expected an eligible synthetic finding");
    }
    const findingRelease = application.service.outbound.approve({
      requestId: findingRequest.requestId,
      rememberClean: false,
      includeFindingIds: [possibleFinding.id],
    });

    return {
      profileId: credentials.profile.id,
      projectId: project.id,
      taskId: task.id,
      releases: [cleanRelease, findingRelease],
    };
  } finally {
    application.close();
  }
};

const restoreWithFailureAfter = (
  phase: RestoreReplacementPhase,
) => {
  const checker = createIntegrityChecker();
  const repository = createBundleRepository(checker);
  const leaseManager = createLeaseManager();
  const backupService = createBackupService({
    checker,
    repository,
    leaseManager,
  });
  const coordinator = createDurabilityCoordinator({
    checker,
    leaseManager,
    backupService,
  });
  return createRestoreService({
    checker,
    repository,
    leaseManager,
    backupService,
    coordinator,
    afterPhase(completedPhase) {
      if (completedPhase === phase) {
        throw new Error(`injected failure after ${phase}`);
      }
    },
  });
};

const openMcpChild = async (
  databasePath: string,
): Promise<McpChild> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpExecutable],
    cwd: repositoryRoot,
    env: {
      ...inheritedEnvironment(),
      INTENTARC_DB_PATH: databasePath,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "intentarc-durability-scenario",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
};

const closeMcpChild = async (
  child: McpChild | undefined,
): Promise<void> => {
  if (!child) return;
  await Promise.allSettled([
    child.client.close(),
    child.transport.close(),
  ]);
};

const waitForMaintenanceRelease = async (
  databasePath: string,
): Promise<void> => {
  const leaseManager = createLeaseManager();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const maintenance = leaseManager.acquireMaintenance(databasePath);
      maintenance.release();
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error("MCP child did not release its active lease");
};

describe("IntentArc data durability", () => {
  const temporaries: TemporaryDatabase[] = [];
  let mcpChild: McpChild | undefined;

  beforeAll(async () => {
    const build = await ensurePackagedTestBuild(repositoryRoot);
    cliExecutable = resolve(build.outputDirectory, "cli/bin.js");
    mcpExecutable = resolve(build.outputDirectory, "mcp/bin.js");
  }, 30_000);

  afterEach(async () => {
    await closeMcpChild(mcpChild);
    mcpChild = undefined;
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const candidate = createTemporaryDatabase();
    temporaries.push(candidate);
    return candidate;
  };

  it("preserves exact schema-11 coordination history through backup and restore", async () => {
    const source = temporary();
    const initialized = await openIntentArcApplication({
      databasePath: source.path,
    });
    initialized.close();
    seedCoordinationDurability(source.path);

    expect(createIntegrityChecker().checkPath(source.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });
    const rowsAtBackup = dumpExactRows(
      source.path,
      coordinationDurabilityTables,
    );
    expect([...new Set(rowsAtBackup.task_claims.map((row) =>
      (row as { state: string }).state))].sort()).toEqual([
      "active",
      "expired",
      "paused",
      "reconciled",
      "released",
      "submitted",
    ]);
    expect(rowsAtBackup.task_delegations.map((row) =>
      (row as { state: string }).state).sort()).toEqual([
      "accepted",
      "claimed",
      "completed",
      "expired",
      "offered",
      "revoked",
    ]);
    expect(rowsAtBackup.task_submissions.map((row) =>
      (row as { state: string }).state).sort()).toEqual([
      "accepted",
      "conflicted",
      "rejected",
      "submitted",
      "withdrawn",
    ]);
    expect(new Set(rowsAtBackup.task_submissions.map((row) =>
      (row as { claim_id: string }).claim_id)).size)
      .toBe(rowsAtBackup.task_submissions.length);
    expect(new Set(rowsAtBackup.task_submissions.map((row) =>
      (row as { checkpoint_id: string }).checkpoint_id)).size)
      .toBe(rowsAtBackup.task_submissions.length);
    expect(rowsAtBackup.task_checkpoints).toHaveLength(9);
    expect([...new Set(rowsAtBackup.coordination_events.map((row) =>
      (row as { category: string }).category))].sort()).toEqual([
      "checkpoint",
      "claim",
      "conflict",
      "delegation_accept",
      "delegation_offer",
      "delegation_revoke",
      "expiry",
      "pause",
      "ready_evaluation",
      "reconciliation",
      "release",
      "renewal",
      "submission",
      "switch",
    ]);
    expect(rowsAtBackup.coordination_idempotency).toHaveLength(9);
    expect(readDatabase(source.path, (database) => database.prepare(`
      SELECT status, revision FROM project_records
      WHERE id = 'task-claim-reconciled'
    `).get())).toEqual({ status: "completed", revision: 2 });
    expect(readDatabase(source.path, (database) => database.prepare(`
      SELECT revision FROM projects
      WHERE id = 'project-coordination-durability'
    `).get())).toEqual({ revision: 2 });
    const claimsById = new Map(rowsAtBackup.task_claims.map((row) => {
      const claim = row as { id: string };
      return [claim.id, claim] as const;
    }));
    const checkpointsById = new Map(rowsAtBackup.task_checkpoints.map((row) => {
      const checkpoint = row as { id: string };
      return [checkpoint.id, checkpoint] as const;
    }));
    const delegationsById = new Map(rowsAtBackup.task_delegations.map((row) => {
      const delegation = row as { id: string };
      return [delegation.id, delegation] as const;
    }));
    const submissionsById = new Map(rowsAtBackup.task_submissions.map((row) => {
      const submission = row as { id: string };
      return [submission.id, submission] as const;
    }));
    const delegationPrerequisites = readDatabase(source.path, (database) =>
      database.prepare(`
        SELECT
          task_delegations.id,
          task_delegations.offered_at,
          task_delegations.accepted_at,
          projects.created_at AS project_created_at,
          project_records.created_at AS task_created_at,
          parent_profiles.created_at AS parent_profile_created_at,
          child_profiles.created_at AS child_profile_created_at,
          parent_authorities.created_at AS parent_authority_created_at,
          child_authorities.created_at AS child_authority_created_at
        FROM task_delegations
        JOIN projects ON projects.id = task_delegations.project_id
        JOIN project_records ON project_records.id = task_delegations.task_id
        JOIN client_profiles AS parent_profiles
          ON parent_profiles.id = task_delegations.parent_profile_id
        JOIN client_profiles AS child_profiles
          ON child_profiles.id = task_delegations.child_profile_id
        JOIN profile_project_authorities AS parent_authorities
          ON parent_authorities.profile_id = task_delegations.parent_profile_id
          AND parent_authorities.project_id = task_delegations.project_id
        JOIN profile_project_authorities AS child_authorities
          ON child_authorities.profile_id = task_delegations.child_profile_id
          AND child_authorities.project_id = task_delegations.project_id
        ORDER BY task_delegations.id
      `).all() as Array<Record<string, string | null>>,
    );
    for (const prerequisite of delegationPrerequisites) {
      for (const field of [
        "project_created_at",
        "task_created_at",
        "parent_profile_created_at",
        "child_profile_created_at",
        "parent_authority_created_at",
        "child_authority_created_at",
      ] as const) {
        expect.soft(prerequisite[field]! < prerequisite.offered_at!).toBe(true);
        if (prerequisite.accepted_at) {
          expect.soft(prerequisite[field]! < prerequisite.accepted_at).toBe(true);
        }
      }
    }
    const contextPackClaimTimes = readDatabase(source.path, (database) =>
      database.prepare(`
        SELECT
          context_packs.created_at,
          json_extract(context_packs.content_json, '$.generatedAt') AS generated_at,
          task_claims.acquired_at
        FROM task_claims
        JOIN context_packs ON context_packs.id = task_claims.context_pack_id
        ORDER BY task_claims.id
      `).all() as Array<{
        created_at: string;
        generated_at: string;
        acquired_at: string;
      }>,
    );
    for (const timing of contextPackClaimTimes) {
      expect.soft(timing.created_at).toBe(timing.acquired_at);
      expect.soft(timing.generated_at).toBe(timing.acquired_at);
    }
    for (const row of rowsAtBackup.task_submissions) {
      const submission = row as {
        claim_id: string;
        checkpoint_id: string;
        state: string;
        submitted_at: string;
        decided_at: string | null;
      };
      const claim = claimsById.get(submission.claim_id) as {
        state: string;
        ended_at: string;
      };
      const checkpoint = checkpointsById.get(submission.checkpoint_id) as {
        created_at: string;
      };
      expect(checkpoint.created_at <= submission.submitted_at).toBe(true);
      if (submission.decided_at) {
        expect(submission.submitted_at <= submission.decided_at).toBe(true);
      }
      if (claim.state === "submitted") {
        expect(claim.ended_at).toBe(submission.submitted_at);
      } else if (claim.state === "reconciled") {
        expect(claim.ended_at).toBe(submission.decided_at);
      } else {
        expect(claim.ended_at >= submission.decided_at!).toBe(true);
      }
    }
    for (const row of rowsAtBackup.task_delegations) {
      const delegation = row as {
        state: string;
        accepted_at: string | null;
        claim_id: string | null;
      };
      if (delegation.claim_id) {
        const claim = claimsById.get(delegation.claim_id) as {
          acquired_at: string;
        };
        expect(delegation.accepted_at! <= claim.acquired_at).toBe(true);
      }
    }
    const expectedEventStates = {
      ready_evaluation: null,
      claim: "active",
      renewal: "active",
      checkpoint: "active",
      pause: "paused",
      release: "released",
      switch: "active",
      expiry: "expired",
      delegation_offer: "offered",
      delegation_accept: "accepted",
      delegation_revoke: "revoked",
      submission: "submitted",
      conflict: "conflicted",
      reconciliation: "reconciled",
    } as const;
    const expectedEventActors = {
      ready_evaluation: null,
      claim: "profile-coordination-child",
      renewal: "profile-coordination-child",
      checkpoint: "profile-coordination-child",
      pause: "profile-coordination-child",
      release: "profile-coordination-child",
      switch: "profile-coordination-child",
      expiry: "profile-coordination-child",
      delegation_offer: "profile-coordination-parent",
      delegation_accept: "profile-coordination-child",
      delegation_revoke: "profile-coordination-parent",
      submission: "profile-coordination-child",
      conflict: "profile-coordination-child",
      reconciliation: "profile-coordination-child",
    } as const;
    for (const row of rowsAtBackup.coordination_events) {
      const event = row as {
        category: keyof typeof expectedEventStates;
        claim_id: string | null;
        delegation_id: string | null;
        checkpoint_id: string | null;
        submission_id: string | null;
        profile_id: string | null;
        prior_state: string | null;
        resulting_state: string | null;
        created_at: string;
      };
      expect.soft(event.profile_id).toBe(expectedEventActors[event.category]);
      const expectedPriorState = (() => {
        switch (event.category) {
          case "ready_evaluation":
          case "claim":
          case "delegation_offer":
            return null;
          case "release":
            return rowsAtBackup.task_submissions.some((submission) =>
              (submission as { claim_id: string }).claim_id === event.claim_id)
              ? "submitted"
              : "active";
          case "expiry":
            return event.claim_id === null ? "offered" : "active";
          case "delegation_accept":
          case "delegation_revoke":
            return "offered";
          case "reconciliation":
            return "submitted";
          default:
            return "active";
        }
      })();
      expect.soft(event.prior_state).toBe(expectedPriorState);
      expect(event.resulting_state).toBe(expectedEventStates[event.category]);
      const underlyingTime = event.submission_id
        ? (event.category === "reconciliation"
          ? (submissionsById.get(event.submission_id) as {
              decided_at: string;
            }).decided_at
          : (submissionsById.get(event.submission_id) as {
              submitted_at: string;
            }).submitted_at)
        : event.checkpoint_id
          ? (checkpointsById.get(event.checkpoint_id) as { created_at: string }).created_at
          : event.delegation_id
            ? (event.category === "delegation_offer"
              ? (delegationsById.get(event.delegation_id) as { offered_at: string }).offered_at
              : event.category === "delegation_accept"
                ? (delegationsById.get(event.delegation_id) as { accepted_at: string }).accepted_at
                : event.category === "claim" || event.category === "switch"
                  ? (claimsById.get(event.claim_id!) as { acquired_at: string }).acquired_at
                  : (delegationsById.get(event.delegation_id) as { ended_at: string }).ended_at)
            : event.claim_id
              ? (["pause", "release", "expiry"].includes(event.category)
                ? (claimsById.get(event.claim_id) as {
                  acquired_at: string;
                  ended_at: string | null;
                }).ended_at
                : (claimsById.get(event.claim_id) as {
                  acquired_at: string;
                }).acquired_at)
              : null;
      if (underlyingTime) expect(event.created_at >= underlyingTime).toBe(true);
    }

    const backup = await successfulJson<BackupSummary>(
      runCli(["--db", source.path, "backup", "create"]),
    );
    expect(backup).toMatchObject({
      manifest: {
        reason: "manual",
        schemaVersion: 11,
        storeId: storeIdentity(source.path),
      },
      verificationStatus: "verified",
    });
    const stagedProbe = temporary();
    cpSync(join(backup.bundlePath, "database.sqlite"), stagedProbe.path);
    expect(dumpExactRows(stagedProbe.path, coordinationDurabilityTables))
      .toEqual(rowsAtBackup);
    createDurabilityCoordinator().migrateStagedBackup({
      databasePath: stagedProbe.path,
      storeId: backup.manifest.storeId,
    });
    expect(dumpExactRows(stagedProbe.path, coordinationDurabilityTables))
      .toEqual(rowsAtBackup);

    const checker = createIntegrityChecker();
    const repository = createBundleRepository(checker);
    const leaseManager = createLeaseManager();
    const backupService = createBackupService({ checker, repository, leaseManager });
    const coordinator = createDurabilityCoordinator({
      checker,
      leaseManager,
      backupService,
    });
    const restoreService = createRestoreService({
      checker,
      repository,
      leaseManager,
      backupService,
      coordinator,
    });
    const restored = temporary();
    await expect(restoreService.restore({
      targetDatabasePath: restored.path,
      bundlePath: backup.bundlePath,
      confirmed: false,
      allowDifferentStore: false,
    })).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      storeId: backup.manifest.storeId,
      schemaVersion: 11,
      preRestoreBackup: null,
    });
    expect(dumpExactRows(restored.path, coordinationDurabilityTables))
      .toEqual(rowsAtBackup);
    expect(createIntegrityChecker().checkPath(restored.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });
  }, 15_000);

  it.each([
    { label: "ready evaluation origin", category: "ready_evaluation", lineage: "any", prior: "active", result: null },
    { label: "claim origin", category: "claim", lineage: "claim", prior: "offered", result: "active" },
    { label: "renewal result", category: "renewal", lineage: "claim", prior: "active", result: "expired" },
    { label: "checkpoint origin", category: "checkpoint", lineage: "claim", prior: null, result: "active" },
    { label: "pause origin", category: "pause", lineage: "claim", prior: "submitted", result: "paused" },
    { label: "release origin", category: "release", lineage: "claim", prior: "offered", result: "released" },
    { label: "switch origin", category: "switch", lineage: "claim", prior: null, result: "active" },
    { label: "claim expiry origin", category: "expiry", lineage: "claim", prior: "submitted", result: "expired" },
    { label: "delegation expiry origin", category: "expiry", lineage: "delegation", prior: "active", result: "expired" },
    { label: "delegation offer origin", category: "delegation_offer", lineage: "delegation", prior: "active", result: "offered" },
    { label: "delegation acceptance origin", category: "delegation_accept", lineage: "delegation", prior: null, result: "accepted" },
    { label: "delegation revocation origin", category: "delegation_revoke", lineage: "delegation", prior: "claimed", result: "revoked" },
    { label: "submission result", category: "submission", lineage: "claim", prior: "active", result: "conflicted" },
    { label: "conflict result", category: "conflict", lineage: "claim", prior: "active", result: "submitted" },
    { label: "reconciliation origin", category: "reconciliation", lineage: "claim", prior: "accepted", result: "reconciled" },
  ] as const)("rejects corrupted coordination transition for $label", async ({
    category,
    lineage,
    prior,
    result,
  }) => {
    const source = temporary();
    const initialized = await openIntentArcApplication({ databasePath: source.path });
    initialized.close();
    seedCoordinationDurability(source.path);
    const database = new Database(source.path);
    try {
      database.exec("DROP TRIGGER coordination_events_no_update");
      const lineagePredicate = lineage === "claim"
        ? "AND claim_id IS NOT NULL"
        : lineage === "delegation"
          ? "AND delegation_id IS NOT NULL AND claim_id IS NULL"
          : "";
      database.prepare(`
        UPDATE coordination_events SET prior_state = ?, resulting_state = ?
        WHERE id = (
          SELECT id FROM coordination_events
          WHERE category = ? ${lineagePredicate}
          ORDER BY id LIMIT 1
        )
      `).run(prior, result, category);
      database.exec(coordinationEventsNoUpdateTriggerSql);
    } finally {
      database.close();
    }

    expect(createIntegrityChecker().checkPath(source.path, "full").issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "coordination_state_invalid" }),
      ]),
    );
  });

  it("preserves production-service coordination receipts through full integrity, backup, and restore", async () => {
    const source = temporary();
    const application = await openIntentArcApplication({
      databasePath: source.path,
      now: () => fixtureTimestamp,
    });
    const project = application.service.createProject({
      name: "Production coordination durability",
    });
    const tasks = ["switch-from", "switch-to", "delegated-submit", "delegated-revoke"]
      .map((suffix) => application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title: `Persist production ${suffix} receipts`,
        body: "Exercise the real coordination service and store contract.",
        sourceKind: "human",
        sourceRef: null,
      }));
    const createdProfile = application.service.profiles.createProfile({
      name: "Durable production worker",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const createdChild = application.service.profiles.createProfile({
      name: "Durable production child",
      projectId: project.id,
    });
    const child = application.service.profiles.authenticate({
      profileId: createdChild.profile.id,
      token: createdChild.token,
    })!;
    const checkpoint = (summary: string) => ({
      summary,
      completedWork: ["Persisted production coordination history"],
      remainingWork: ["Verify durability"],
      blockers: [],
      verificationEvidence: { tests: ["focused durability"], artifacts: [] },
      repositoryEvidence: null,
    });
    const claimed = application.service.coordination.claimTask({
      projectId: project.id,
      taskId: tasks[0]!.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      contextBudgetTokens: 200,
      acceptedDelegationId: null,
      idempotencyKey: "production-durability-claim",
    }, principal);
    application.service.coordination.renewClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "production-durability-renew",
    }, principal);
    const emptyMaximumCheckpoint = checkpoint("");
    const maximumCheckpointDocument = {
      ...emptyMaximumCheckpoint,
      summary: "x".repeat(
        65_536 - Buffer.byteLength(JSON.stringify(emptyMaximumCheckpoint), "utf8"),
      ),
    };
    const maximumCheckpointInput = {
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: maximumCheckpointDocument,
      idempotencyKey: "production-durability-checkpoint",
    };
    const maximumCheckpoint = application.service.coordination.checkpointClaim(
      maximumCheckpointInput,
      principal,
    );
    expect(Buffer.byteLength(JSON.stringify(maximumCheckpointDocument), "utf8")).toBe(65_536);
    expect(application.service.coordination.checkpointClaim(
      maximumCheckpointInput,
      principal,
    )).toEqual(maximumCheckpoint);
    const maximumSwitchInput = {
      currentClaimId: claimed.claim.id,
      projectId: project.id,
      currentTaskId: tasks[0]!.id,
      expectedCurrentProjectRevision: 4,
      expectedCurrentTaskRevision: 1,
      checkpoint: maximumCheckpointDocument,
      terminalAction: "pause" as const,
      nextTaskId: tasks[1]!.id,
      expectedNextProjectRevision: 4,
      expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 200,
      acceptedDelegationId: null,
      idempotencyKey: "production-durability-switch",
    };
    const switched = application.service.coordination.switchTask(maximumSwitchInput, principal);
    expect(switched.checkpoint.summary).toHaveLength(maximumCheckpointDocument.summary.length);
    expect(application.service.coordination.switchTask(maximumSwitchInput, principal)).toEqual(switched);
    application.service.coordination.transitionClaim({
      claimId: switched.nextClaim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      action: "release",
      idempotencyKey: "production-durability-transition",
    }, principal);
    const delegated = application.service.coordination.createDelegation({
      projectId: project.id,
      taskId: tasks[2]!.id,
      childProfileId: child.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      scope: { summary: "Persist delegated production history.", constraints: [] },
      allowedOutputs: ["update_record"],
      deadline: "2026-07-27T13:00:00.000Z",
      idempotencyKey: "production-durability-delegate",
    }, principal);
    application.service.coordination.acceptDelegation({
      delegationId: delegated.delegation.id,
      projectId: project.id,
      taskId: tasks[2]!.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "production-durability-accept",
    }, child);
    const delegatedClaim = application.service.coordination.claimTask({
      projectId: project.id,
      taskId: tasks[2]!.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      contextBudgetTokens: 200,
      acceptedDelegationId: delegated.delegation.id,
      idempotencyKey: "production-durability-delegated-claim",
    }, child);
    const delegatedCheckpoint = application.service.coordination.checkpointClaim({
      claimId: delegatedClaim.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpoint("Delegated production durability checkpoint"),
      idempotencyKey: "production-durability-delegated-checkpoint",
    }, child);
    application.service.coordination.submitTaskResult({
      claimId: delegatedClaim.claim.id,
      checkpointId: delegatedCheckpoint.checkpoint.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      submission: {
        summary: "Preserve delegated production evidence.",
        verificationEvidence: { tests: ["focused durability"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Preserve delegated production evidence.", operations: [] },
      },
      idempotencyKey: "production-durability-submit",
    }, child);
    const revoked = application.service.coordination.createDelegation({
      projectId: project.id,
      taskId: tasks[3]!.id,
      childProfileId: child.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      scope: { summary: "Persist revoked production history.", constraints: [] },
      allowedOutputs: ["update_record"],
      deadline: "2026-07-27T13:00:00.000Z",
      idempotencyKey: "production-durability-delegate-revoke",
    }, principal);
    application.service.coordination.revokeDelegation({
      delegationId: revoked.delegation.id,
      projectId: project.id,
      taskId: tasks[3]!.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "production-durability-revoke",
    }, principal);
    application.close();

    expect(claimed.readiness.liveClaimId).toBeNull();
    expect(readDatabase(source.path, (database) => database.prepare(`
      SELECT DISTINCT operation FROM coordination_idempotency ORDER BY operation
    `).pluck().all())).toEqual([
      "accept_delegation",
      "checkpoint",
      "claim",
      "create_delegation",
      "renew",
      "revoke_delegation",
      "submit",
      "switch",
      "transition",
    ]);
    expect(createIntegrityChecker().checkPath(source.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });

    const rowsAtBackup = dumpExactRows(source.path, coordinationDurabilityTables);
    const checker = createIntegrityChecker();
    const repository = createBundleRepository(checker);
    const leaseManager = createLeaseManager();
    const backupService = createBackupService({ checker, repository, leaseManager });
    const backup = await backupService.create({
      databasePath: source.path,
      outputRoot: join(source.directory, "production-coordination-backups"),
      reason: "manual",
    });
    const coordinator = createDurabilityCoordinator({
      checker,
      leaseManager,
      backupService,
    });
    const restoreService = createRestoreService({
      checker,
      repository,
      leaseManager,
      backupService,
      coordinator,
    });
    const restored = temporary();
    await expect(restoreService.restore({
      targetDatabasePath: restored.path,
      bundlePath: backup.bundlePath,
      confirmed: false,
      allowDifferentStore: false,
    })).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      preRestoreBackup: null,
    });
    expect(dumpExactRows(restored.path, coordinationDurabilityTables))
      .toEqual(rowsAtBackup);
    expect(createIntegrityChecker().checkPath(restored.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });
  }, 15_000);

  it("preserves delegated deadline recovery through full integrity, backup, and restore", async () => {
    let now = "2026-08-15T10:00:00.000Z";
    const source = temporary();
    const application = await openIntentArcApplication({
      databasePath: source.path,
      now: () => now,
    });
    const project = application.service.createProject({ name: "Delegation deadline durability" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Recover a delegated deadline",
      body: "Expire the exact linked claim and delegation atomically.",
      sourceKind: "human",
      sourceRef: null,
    });
    const parentProfile = application.service.profiles.createProfile({
      name: "Deadline parent",
      projectId: project.id,
    });
    const childProfile = application.service.profiles.createProfile({
      name: "Deadline child",
      projectId: project.id,
    });
    const parent = application.service.profiles.authenticate({
      profileId: parentProfile.profile.id,
      token: parentProfile.token,
    })!;
    const child = application.service.profiles.authenticate({
      profileId: childProfile.profile.id,
      token: childProfile.token,
    })!;
    const offered = application.service.coordination.createDelegation({
      projectId: project.id,
      taskId: task.id,
      childProfileId: child.id,
      expectedProjectRevision: 1,
      expectedTaskRevision: 1,
      scope: { summary: "Recover after the fixed deadline.", constraints: [] },
      allowedOutputs: ["update_record"],
      deadline: "2026-08-15T10:45:00.000Z",
      idempotencyKey: "deadline-durability-offer",
    }, parent);
    application.service.coordination.acceptDelegation({
      delegationId: offered.delegation.id,
      projectId: project.id,
      taskId: task.id,
      expectedProjectRevision: 1,
      expectedTaskRevision: 1,
      idempotencyKey: "deadline-durability-accept",
    }, child);
    const claimed = application.service.coordination.claimTask({
      projectId: project.id,
      taskId: task.id,
      expectedProjectRevision: 1,
      expectedTaskRevision: 1,
      contextBudgetTokens: 200,
      acceptedDelegationId: offered.delegation.id,
      idempotencyKey: "deadline-durability-claim",
    }, child);
    now = "2026-08-15T10:20:00.000Z";
    expect(application.service.coordination.renewClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 1,
      expectedTaskRevision: 1,
      idempotencyKey: "deadline-durability-renew",
    }, child).claim.expiresAt).toBe("2026-08-15T10:50:00.000Z");
    now = "2026-08-15T10:45:00.000Z";
    expect(application.service.coordination.listReadyTasks({
      projectId: project.id,
      expectedProjectRevision: 1,
      cursor: null,
      limit: 10,
    }, parent).tasks[0]).toMatchObject({
      liveClaimId: null,
      liveDelegationId: null,
      blockers: [],
    });
    application.close();

    expect(readDatabase(source.path, (database) => ({
      claim: database.prepare("SELECT state, ended_at FROM task_claims WHERE id = ?")
        .get(claimed.claim.id),
      delegation: database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
        .get(offered.delegation.id),
      expiry: database.prepare(`
        SELECT claim_id, delegation_id FROM coordination_events WHERE category = 'expiry'
      `).get(),
    }))).toEqual({
      claim: { state: "expired", ended_at: now },
      delegation: { state: "expired", ended_at: now },
      expiry: { claim_id: claimed.claim.id, delegation_id: offered.delegation.id },
    });
    expect(createIntegrityChecker().checkPath(source.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });

    const rowsAtBackup = dumpExactRows(source.path, coordinationDurabilityTables);
    const checker = createIntegrityChecker();
    const repository = createBundleRepository(checker);
    const leaseManager = createLeaseManager();
    const backupService = createBackupService({ checker, repository, leaseManager });
    const backup = await backupService.create({
      databasePath: source.path,
      outputRoot: join(source.directory, "deadline-coordination-backups"),
      reason: "manual",
    });
    const coordinator = createDurabilityCoordinator({ checker, leaseManager, backupService });
    const restoreService = createRestoreService({
      checker,
      repository,
      leaseManager,
      backupService,
      coordinator,
    });
    const restored = temporary();
    await restoreService.restore({
      targetDatabasePath: restored.path,
      bundlePath: backup.bundlePath,
      confirmed: false,
      allowDifferentStore: false,
    });
    expect(dumpExactRows(restored.path, coordinationDurabilityTables)).toEqual(rowsAtBackup);
    expect(createIntegrityChecker().checkPath(restored.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: 11,
      issues: [],
    });
  }, 15_000);

  it("migrates a complete schema-2 store once, then backs up and restores its full history", async () => {
    const candidate = temporary();
    createCompleteVersionTwoFixture(candidate.path);
    const versionTwoRows = dumpFixtureRows(candidate.path);
    const migratedVersionTwoRows = {
      ...versionTwoRows,
      projects: versionTwoRows.projects.map((project) => ({
        ...project,
        hierarchy_vocabulary_json: "{\"preset\":\"neutral\",\"outcome\":\"Outcome\",\"initiative\":\"Initiative\",\"deliverable\":\"Deliverable\",\"milestone\":\"Milestone\",\"task\":\"Work item\",\"nestedTask\":\"Subtask\"}",
      })),
      client_profiles: versionTwoRows.client_profiles.map((profile) => ({
        ...profile,
        execution_mode: "safe",
      })),
      change_proposals: versionTwoRows.change_proposals.map((proposal) => ({
        ...proposal,
        origin_type: "profile",
        repository_snapshot_id: null,
      })),
    };

    const migrated = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    migrated.close();

    const automaticBackups = await successfulJson<BackupSummary[]>(
      runCli(["--db", candidate.path, "backup", "list"]),
    );
    expect(automaticBackups).toHaveLength(1);
    expect(automaticBackups[0]).toMatchObject({
      manifest: {
        reason: "pre-migration",
        schemaVersion: 2,
        storeId: storeIdentity(candidate.path),
      },
      verificationStatus: "not_checked",
    });
    const verifiedAutomatic = await successfulJson<VerifiedBackup>(
      runCli([
        "backup",
        "verify",
        "--backup",
        automaticBackups[0]!.bundlePath,
      ]),
    );
    expect(verifiedAutomatic).toMatchObject({
      manifest: {
        reason: "pre-migration",
        storeId: storeIdentity(candidate.path),
      },
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: 2 },
    });
    expect(userVersion(candidate.path)).toBe(currentSchemaVersion);
    expect(dumpFixtureRows(candidate.path)).toEqual(migratedVersionTwoRows);
    assertAuditIsAppendOnly(candidate.path);

    const secondStartup = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    secondStartup.close();
    expect(
      await successfulJson<BackupSummary[]>(
        runCli(["--db", candidate.path, "backup", "list"]),
      ),
    ).toHaveLength(1);

    const manualBackup = await successfulJson<BackupSummary>(
      runCli(["--db", candidate.path, "backup", "create"]),
    );
    expect(manualBackup).toMatchObject({
      manifest: {
        reason: "manual",
        schemaVersion: currentSchemaVersion,
        storeId: storeIdentity(candidate.path),
      },
      verificationStatus: "verified",
    });
    await successfulJson<VerifiedBackup>(
      runCli(["backup", "verify", "--backup", manualBackup.bundlePath]),
    );
    const stateAtManualBackup = dumpFixtureRows(candidate.path);
    const lineageAtManualBackup = storeIdentity(candidate.path);
    const manualSnapshotPath = join(
      manualBackup.bundlePath,
      "database.sqlite",
    );
    const manualSnapshotBytes = readFileSync(manualSnapshotPath);
    const manualSnapshotChecksum = sha256(manualSnapshotPath);
    const manualManifestBytes = readFileSync(
      join(manualBackup.bundlePath, "manifest.json"),
    );

    const mutatingApplication = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    mutatingApplication.service.updateRecord({
      projectId: "project-fixture",
      recordId: "task-fixture",
      expectedRecordRevision: 2,
      patch: { title: "State created after the manual backup" },
    });
    mutatingApplication.service.profiles.setEnabled(
      "profile-fixture",
      false,
    );
    mutatingApplication.close();
    expect(dumpFixtureRows(candidate.path)).not.toEqual(stateAtManualBackup);

    const aliasContainer = temporary();
    const aliasedParent = join(aliasContainer.directory, "database-parent");
    symlinkSync(
      candidate.directory,
      aliasedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    mcpChild = await openMcpChild(
      join(aliasedParent, basename(candidate.path)),
    );
    expect(readdirSync(manualBackup.bundlePath).sort()).toEqual([
      "database.sqlite",
      "manifest.json",
    ]);
    expect(readFileSync(manualSnapshotPath)).toEqual(manualSnapshotBytes);
    expect(sha256(manualSnapshotPath)).toBe(manualSnapshotChecksum);
    expect(
      readFileSync(join(manualBackup.bundlePath, "manifest.json")),
    ).toEqual(manualManifestBytes);
    await successfulJson<VerifiedBackup>(
      runCli(["backup", "verify", "--backup", manualBackup.bundlePath]),
    );
    const conflict = await runCli([
      "--db",
      candidate.path,
      "backup",
      "restore",
      "--backup",
      manualBackup.bundlePath,
      "--yes",
    ]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(/^maintenance_conflict:/);
    expect(dumpFixtureRows(candidate.path)).not.toEqual(stateAtManualBackup);

    await closeMcpChild(mcpChild);
    mcpChild = undefined;
    await waitForMaintenanceRelease(candidate.path);

    const hardLinkedPath = join(
      candidate.directory,
      "hard-linked-primary.sqlite",
    );
    linkSync(candidate.path, hardLinkedPath);
    try {
      const rejectedHardLink = await runCli([
        "--db",
        hardLinkedPath,
        "integrity",
        "check",
      ]);
      expect(rejectedHardLink.code).toBe(1);
      expect(rejectedHardLink.stderr).toMatch(/^maintenance_conflict:/);
    } finally {
      rmSync(hardLinkedPath, { force: true });
    }

    const restored = await successfulJson<RestoreResult>(
      runCli([
        "--db",
        candidate.path,
        "backup",
        "restore",
        "--backup",
        manualBackup.bundlePath,
        "--yes",
      ]),
    );
    expect(restored).toMatchObject({
      backupId: manualBackup.manifest.backupId,
      storeId: lineageAtManualBackup,
      schemaVersion: currentSchemaVersion,
      diagnosticCapturePath: null,
      preRestoreBackup: {
        manifest: { reason: "pre-restore" },
        verificationStatus: "verified",
      },
    });

    const restarted = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    restarted.close();
    expect(userVersion(candidate.path)).toBe(currentSchemaVersion);
    expect(storeIdentity(candidate.path)).toBe(lineageAtManualBackup);
    expect(dumpFixtureRows(candidate.path)).toEqual(stateAtManualBackup);
    assertAuditIsAppendOnly(candidate.path);
    await successfulJson<VerifiedBackup>(
      runCli(["backup", "verify", "--backup", manualBackup.bundlePath]),
    );
    expect(readdirSync(manualBackup.bundlePath).sort()).toEqual([
      "database.sqlite",
      "manifest.json",
    ]);
    expect(readFileSync(manualSnapshotPath)).toEqual(manualSnapshotBytes);
    expect(sha256(manualSnapshotPath)).toBe(manualSnapshotChecksum);
    expect(
      readFileSync(join(manualBackup.bundlePath, "manifest.json")),
    ).toEqual(manualManifestBytes);
  }, 15_000);

  it("preserves repository observations and immutable import evidence through backup and restore", async () => {
    const source = temporary();
    createVersionFourFixture(source.path, "store-import-durability");
    const manifest = repositoryImportManifest();
    const idCounts: Record<string, number> = {};
    const application = await openIntentArcApplication({
      databasePath: source.path,
      now: () => fixtureTimestamp,
      newId: (prefix) =>
        `${prefix}-import-${idCounts[prefix] = (idCounts[prefix] ?? 0) + 1}`,
      repositoryImportDependencies: {
        driftVerifier: () => {},
      },
    });
    try {
      application.service.imports.apply({
        manifest,
        confirmedDigest: computeImportManifestDigest(manifest),
      });
    } finally {
      application.close();
    }

    const receiptBeforeIndexing = dumpExactRows(
      source.path,
      ["repository_import_receipts"],
    );
    seedRepositoryIndexDurability(source.path);
    expect(dumpExactRows(source.path, ["repository_import_receipts"]))
      .toEqual(receiptBeforeIndexing);

    expect(userVersion(source.path)).toBe(currentSchemaVersion);
    expect(createIntegrityChecker().checkPath(source.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-import-durability",
      issues: [],
    });
    const exactEvidence = dumpExactRows(
      source.path,
      repositoryIndexDurabilityTables,
    );

    const backup = await successfulJson<BackupSummary>(
      runCli(["--db", source.path, "backup", "create"]),
    );
    expect(backup).toMatchObject({
      manifest: {
        reason: "manual",
        schemaVersion: currentSchemaVersion,
        storeId: "store-import-durability",
      },
      verificationStatus: "verified",
    });
    await expect(
      successfulJson<VerifiedBackup>(
        runCli(["backup", "verify", "--backup", backup.bundlePath]),
      ),
    ).resolves.toMatchObject({
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: currentSchemaVersion },
    });

    const restored = temporary();
    await expect(
      successfulJson<RestoreResult>(
        runCli([
          "--db",
          restored.path,
          "backup",
          "restore",
          "--backup",
          backup.bundlePath,
          "--yes",
        ]),
      ),
    ).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      storeId: "store-import-durability",
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: null,
    });
    expect(createIntegrityChecker().checkPath(restored.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      storeId: "store-import-durability",
      issues: [],
    });
    expect(
      dumpExactRows(restored.path, repositoryIndexDurabilityTables),
    ).toEqual(exactEvidence);

    const corruptContainer = temporary();
    const corruptBundle = join(
      corruptContainer.directory,
      "corrupt-repository-import.intentarc-backup",
    );
    cpSync(backup.bundlePath, corruptBundle, { recursive: true });
    corruptRepositoryImportSnapshot(corruptBundle);
    expect(
      createIntegrityChecker().checkPath(
        join(corruptBundle, "database.sqlite"),
        "full",
      ),
    ).toMatchObject({
      passed: false,
      schemaVersion: currentSchemaVersion,
      issues: [
        expect.objectContaining({
          code: "repository_import_state_invalid",
        }),
      ],
    });
    const verification = await runCli([
      "backup",
      "verify",
      "--backup",
      corruptBundle,
    ]);
    expect(verification.code).toBe(1);
    expect(verification.stderr).toMatch(/^backup_invalid:/);
  }, 15_000);

  it("restores exact outbound rows and rejects internally checksummed release corruption", async () => {
    const candidate = temporary();
    const fixture = await createOutboundDurabilityState(candidate);
    const rowsAtBackup = dumpExactRows(
      candidate.path,
      outboundDurabilityTables,
    );
    const releaseRows = rowsAtBackup.outbound_releases as Array<{
      id: string;
      request_id: string;
      source_pack_id: string;
      content_json: string;
      disclosure_json: string;
      sha256: string;
      released_at: string;
    }>;
    expect(releaseRows).toHaveLength(2);
    expect(releaseRows.map(({ sha256: digest }) => digest)).toEqual(
      fixture.releases.map(({ sha256: digest }) => digest),
    );
    expect(
      releaseRows.map(({ disclosure_json: disclosureJson }) =>
        (JSON.parse(disclosureJson) as { releaseDigest: string }).releaseDigest),
    ).toEqual(fixture.releases.map(({ sha256: digest }) => digest));
    expect(
      releaseRows.map(({ content_json: contentJson }) =>
        JSON.parse(contentJson)),
    ).toEqual(fixture.releases.map(({ pack }) => pack));

    const backup = await successfulJson<BackupSummary>(
      runCli(["--db", candidate.path, "backup", "create"]),
    );
    expect(backup).toMatchObject({
      manifest: {
        reason: "manual",
        schemaVersion: currentSchemaVersion,
        storeId: storeIdentity(candidate.path),
      },
      verificationStatus: "verified",
    });
    await expect(
      successfulJson<VerifiedBackup>(
        runCli(["backup", "verify", "--backup", backup.bundlePath]),
      ),
    ).resolves.toMatchObject({
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: currentSchemaVersion },
    });

    const mutatingApplication = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    try {
      mutatingApplication.service.destinations.set({
        profileId: fixture.profileId,
        clientLabel: "Changed synthetic durability destination",
        type: "gateway",
        providerLabel: "Changed synthetic provider",
        modelLabel: "Changed synthetic model",
        accountBoundaryLabel: "Changed synthetic account",
        dataBoundary: "mixed",
      });
      mutatingApplication.service.updateRecord({
        projectId: fixture.projectId,
        recordId: fixture.taskId,
        expectedRecordRevision: 2,
        patch: { title: "State created after the outbound backup" },
      });
    } finally {
      mutatingApplication.close();
    }
    expect(
      dumpExactRows(candidate.path, outboundDurabilityTables),
    ).not.toEqual(rowsAtBackup);

    const restored = await successfulJson<RestoreResult>(
      runCli([
        "--db",
        candidate.path,
        "backup",
        "restore",
        "--backup",
        backup.bundlePath,
        "--yes",
      ]),
    );
    expect(restored).toMatchObject({
      backupId: backup.manifest.backupId,
      storeId: backup.manifest.storeId,
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: {
        manifest: {
          reason: "pre-restore",
          schemaVersion: currentSchemaVersion,
        },
        verificationStatus: "verified",
      },
    });
    expect(
      dumpExactRows(candidate.path, outboundDurabilityTables),
    ).toEqual(rowsAtBackup);
    const firstAuditId = (
      rowsAtBackup.audit_events[0] as { id: string }
    ).id;
    assertAuditIsAppendOnly(candidate.path, firstAuditId);

    for (const corruption of ["content_json", "sha256"] as const) {
      const corruptContainer = temporary();
      const corruptBundle = join(
        corruptContainer.directory,
        `corrupt-${corruption}.intentarc-backup`,
      );
      cpSync(backup.bundlePath, corruptBundle, { recursive: true });
      corruptReleaseSnapshot(corruptBundle, corruption);

      expect(
        createIntegrityChecker().checkPath(
          join(corruptBundle, "database.sqlite"),
          "full",
        ),
      ).toMatchObject({
        passed: false,
        schemaVersion: currentSchemaVersion,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "outbound_state_invalid" }),
        ]),
      });
      const verification = await runCli([
        "backup",
        "verify",
        "--backup",
        corruptBundle,
      ]);
      expect(verification.code).toBe(1);
      expect(verification.stderr).toMatch(/^backup_invalid:/);

      const targetDigest = sha256(candidate.path);
      const rejectedRestore = await runCli([
        "--db",
        candidate.path,
        "backup",
        "restore",
        "--backup",
        corruptBundle,
        "--yes",
      ]);
      expect(rejectedRestore.code).toBe(1);
      expect(rejectedRestore.stderr).toMatch(/^backup_invalid:/);
      expect(sha256(candidate.path)).toBe(targetDigest);
      expect(
        dumpExactRows(candidate.path, outboundDurabilityTables),
      ).toEqual(rowsAtBackup);
    }
  }, 15_000);

  it("restores an immutable verified schema-3 pre-migration backup through staged migration exactly", async () => {
    const candidate = temporary();
    createCompleteVersionTwoFixture(candidate.path);
    promoteFixtureToVersionThree(
      candidate.path,
      "store-schema-three-restoration",
    );
    const schemaThreeTables = [...fixtureTables, "store_metadata"];
    const rowsBeforeMigration = dumpExactRows(
      candidate.path,
      schemaThreeTables,
    );
    const migratedRowsBeforeMigration = {
      ...rowsBeforeMigration,
      projects: rowsBeforeMigration.projects.map((project) => ({
        ...project,
        hierarchy_vocabulary_json: "{\"preset\":\"neutral\",\"outcome\":\"Outcome\",\"initiative\":\"Initiative\",\"deliverable\":\"Deliverable\",\"milestone\":\"Milestone\",\"task\":\"Work item\",\"nestedTask\":\"Subtask\"}",
      })),
      client_profiles: rowsBeforeMigration.client_profiles.map((profile) => ({
        ...profile,
        execution_mode: "safe",
      })),
      change_proposals: rowsBeforeMigration.change_proposals.map((proposal) => ({
        ...proposal,
        origin_type: "profile",
        repository_snapshot_id: null,
      })),
    };
    const migrated = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    migrated.close();
    expect(userVersion(candidate.path)).toBe(currentSchemaVersion);

    const backups = await successfulJson<BackupSummary[]>(
      runCli(["--db", candidate.path, "backup", "list"]),
    );
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      manifest: {
        reason: "pre-migration",
        schemaVersion: 3,
        storeId: "store-schema-three-restoration",
      },
      verificationStatus: "not_checked",
    });
    const snapshotPath = join(backups[0]!.bundlePath, "database.sqlite");
    const snapshotBytes = readFileSync(snapshotPath);
    const snapshotDigest = sha256(snapshotPath);
    const manifestBytes = readFileSync(
      join(backups[0]!.bundlePath, "manifest.json"),
    );
    await expect(
      successfulJson<VerifiedBackup>(
        runCli(["backup", "verify", "--backup", backups[0]!.bundlePath]),
      ),
    ).resolves.toMatchObject({
      verificationStatus: "verified",
      integrity: {
        passed: true,
        schemaVersion: 3,
        storeId: "store-schema-three-restoration",
      },
    });

    const mutatingApplication = await openIntentArcApplication({
      databasePath: candidate.path,
    });
    try {
      mutatingApplication.service.updateRecord({
        projectId: "project-fixture",
        recordId: "task-fixture",
        expectedRecordRevision: 2,
        patch: { title: "State after schema-3 migration" },
      });
    } finally {
      mutatingApplication.close();
    }

    const restored = await successfulJson<RestoreResult>(
      runCli([
        "--db",
        candidate.path,
        "backup",
        "restore",
        "--backup",
        backups[0]!.bundlePath,
        "--yes",
      ]),
    );
    expect(restored).toMatchObject({
      backupId: backups[0]!.manifest.backupId,
      storeId: "store-schema-three-restoration",
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: {
        manifest: {
          reason: "pre-restore",
          schemaVersion: currentSchemaVersion,
        },
        verificationStatus: "verified",
      },
    });
    expect(userVersion(candidate.path)).toBe(currentSchemaVersion);
    expect(
      dumpExactRows(candidate.path, schemaThreeTables),
    ).toEqual(migratedRowsBeforeMigration);
    expect(
      dumpExactRows(candidate.path, outboundDurabilityTables.slice(0, 5)),
    ).toEqual({
      outbound_destinations: [],
      outbound_policies: [],
      outbound_requests: [],
      outbound_findings: [],
      outbound_releases: [],
    });
    assertAuditIsAppendOnly(candidate.path);

    expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
    expect(sha256(snapshotPath)).toBe(snapshotDigest);
    expect(
      readFileSync(join(backups[0]!.bundlePath, "manifest.json")),
    ).toEqual(manifestBytes);
    await expect(
      successfulJson<VerifiedBackup>(
        runCli(["backup", "verify", "--backup", backups[0]!.bundlePath]),
      ),
    ).resolves.toMatchObject({
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: 3 },
    });
  });

  it("rejects a changed snapshot byte and requires both cross-store override and confirmation", async () => {
    const source = temporary();
    const target = temporary();
    const sourceStoreId = await createCurrentStore(
      source,
      "Source lineage",
    );
    const targetStoreId = await createCurrentStore(
      target,
      "Target lineage",
    );
    expect(targetStoreId).not.toBe(sourceStoreId);

    const tampered = await successfulJson<BackupSummary>(
      runCli(["--db", source.path, "backup", "create"]),
    );
    const snapshotPath = join(tampered.bundlePath, "database.sqlite");
    const snapshot = readFileSync(snapshotPath);
    snapshot[snapshot.length - 1] ^= 0xff;
    writeFileSync(snapshotPath, snapshot);
    const targetChecksum = sha256(target.path);

    const invalid = await runCli([
      "--db",
      target.path,
      "backup",
      "restore",
      "--backup",
      tampered.bundlePath,
      "--yes",
      "--allow-different-store",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/^backup_invalid:/);
    expect(sha256(target.path)).toBe(targetChecksum);

    const healthy = await successfulJson<BackupSummary>(
      runCli(["--db", source.path, "backup", "create"]),
    );
    const identityMismatch = await runCli([
      "--db",
      target.path,
      "backup",
      "restore",
      "--backup",
      healthy.bundlePath,
      "--yes",
    ]);
    expect(identityMismatch.code).toBe(1);
    expect(identityMismatch.stderr).toMatch(/^store_identity_mismatch:/);
    expect(storeIdentity(target.path)).toBe(targetStoreId);

    const confirmationMissing = await runCli([
      "--db",
      target.path,
      "backup",
      "restore",
      "--backup",
      healthy.bundlePath,
      "--allow-different-store",
    ]);
    expect(confirmationMissing.code).toBe(1);
    expect(confirmationMissing.stderr).toMatch(/^confirmation_required:/);
    expect(storeIdentity(target.path)).toBe(targetStoreId);

    const restored = await successfulJson<RestoreResult>(
      runCli([
        "--db",
        target.path,
        "backup",
        "restore",
        "--backup",
        healthy.bundlePath,
        "--yes",
        "--allow-different-store",
      ]),
    );
    expect(restored.storeId).toBe(sourceStoreId);
    expect(storeIdentity(target.path)).toBe(sourceStoreId);
  });

  it("rolls an injected schema-3 migration failure back to the exact schema-2 store and retains its verified bundle", async () => {
    const candidate = temporary();
    createCompleteVersionTwoFixture(candidate.path);
    const database = new Database(candidate.path);
    database.exec(`
      CREATE TABLE store_metadata (
        injected_failure INTEGER PRIMARY KEY
      )
    `);
    database.close();
    const rowsBefore = dumpFixtureRows(candidate.path);
    const schemaBefore = dumpSchema(candidate.path);

    await expect(
      openIntentArcApplication({ databasePath: candidate.path }),
    ).rejects.toMatchObject({
      code: "migration_failed",
      details: {
        originalSchemaVersion: 2,
        requestedSchemaVersion: currentSchemaVersion,
        transactionPreserved: true,
      },
    });

    expect(userVersion(candidate.path)).toBe(2);
    expect(dumpFixtureRows(candidate.path)).toEqual(rowsBefore);
    expect(dumpSchema(candidate.path)).toEqual(schemaBefore);
    const retained = await successfulJson<BackupSummary[]>(
      runCli(["--db", candidate.path, "backup", "list"]),
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      manifest: { reason: "pre-migration", schemaVersion: 2 },
      verificationStatus: "not_checked",
    });
    await expect(
      successfulJson<VerifiedBackup>(
        runCli(["backup", "verify", "--backup", retained[0]!.bundlePath]),
      ),
    ).resolves.toMatchObject({
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: 2 },
    });
  });

  it("restores a damaged SQLite header and keeps its capture out of backup discovery", async () => {
    const source = temporary();
    const target = temporary();
    const sourceStoreId = await createCurrentStore(
      source,
      "Healthy recovery source",
    );
    const sourceBackup = await successfulJson<BackupSummary>(
      runCli(["--db", source.path, "backup", "create"]),
    );
    const damagedFiles = new Map<string, Buffer>([
      [target.path, Buffer.from("damaged SQLite header")],
      [`${target.path}-wal`, Buffer.from("damaged WAL")],
      [`${target.path}-shm`, Buffer.from("damaged SHM")],
    ]);
    for (const [path, bytes] of damagedFiles) {
      writeFileSync(path, bytes);
    }

    await expect(
      restoreWithFailureAfter("stage-installed").restore({
        targetDatabasePath: target.path,
        bundlePath: sourceBackup.bundlePath,
        confirmed: true,
        allowDifferentStore: true,
      }),
    ).rejects.toMatchObject({
      code: "restore_failed",
      details: { originalReinstated: true },
    });
    for (const [path, bytes] of damagedFiles) {
      expect(readFileSync(path)).toEqual(bytes);
    }

    const restored = await successfulJson<RestoreResult>(
      runCli([
        "--db",
        target.path,
        "backup",
        "restore",
        "--backup",
        sourceBackup.bundlePath,
        "--yes",
        "--allow-different-store",
      ]),
    );
    expect(restored).toMatchObject({
      storeId: sourceStoreId,
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: null,
      diagnosticCapturePath: expect.stringMatching(
        /\.intentarc-diagnostic$/,
      ),
    });
    expect(
      readdirSync(target.directory).filter((entry) =>
        entry.endsWith(".intentarc-diagnostic"),
      ),
    ).toHaveLength(1);
    const capturePath = restored.diagnosticCapturePath!;
    expect(readdirSync(capturePath).sort()).toEqual([
      "database.sqlite",
      "database.sqlite-shm",
      "database.sqlite-wal",
      "manifest.json",
    ]);
    for (const [path, bytes] of damagedFiles) {
      const capturedName = path === target.path
        ? "database.sqlite"
        : path.endsWith("-wal")
          ? "database.sqlite-wal"
          : "database.sqlite-shm";
      expect(readFileSync(join(capturePath, capturedName))).toEqual(bytes);
    }
    expect(
      diagnosticCaptureManifestSchema.parse(
        JSON.parse(readFileSync(
          join(capturePath, "manifest.json"),
          "utf8",
        )),
      ),
    ).toEqual({
      formatVersion: 1,
      captureId: expect.any(String),
      createdAt: expect.any(String),
      classification: "unverified_diagnostic",
      storeId: null,
      schemaVersion: null,
      issueCodes: ["database_unreadable"],
      files: [
        "database.sqlite",
        "database.sqlite-wal",
        "database.sqlite-shm",
      ],
    });
    expect(
      await successfulJson<BackupSummary[]>(
        runCli([
          "--db",
          target.path,
          "backup",
          "list",
          "--root",
          target.directory,
        ]),
      ),
    ).toEqual([]);

    const reopened = await openIntentArcApplication({
      databasePath: target.path,
    });
    try {
      expect(reopened.service.listProjects()).toEqual([
        expect.objectContaining({ name: "Healthy recovery source" }),
      ]);
    } finally {
      reopened.close();
    }
    expect(storeIdentity(target.path)).toBe(sourceStoreId);
    expect(userVersion(target.path)).toBe(currentSchemaVersion);
  });
});
