import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskContextPack } from "../domain/index.js";
import { openDatabase } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  createBackupService,
  type BackupService,
} from "./backup-service.js";
import {
  createBundleRepository,
  defaultBackupRoot,
  type BundleRepository,
} from "./bundles.js";
import {
  createDurabilityCoordinator,
  type DurabilityCoordinator,
} from "./coordinator.js";
import { DurabilityError } from "./errors.js";
import {
  createIntegrityChecker,
  type IntegrityChecker,
} from "./integrity.js";
import {
  createLeaseManager,
  type LeaseHandle,
  type LeaseManager,
} from "./leases.js";
import {
  diagnosticCaptureManifestSchema,
  type BackupManifest,
} from "./model.js";
import {
  createRestoreService,
  type RestoreReplacementPhase,
  type RestoreService,
} from "./restore-service.js";

const now = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

type BundleFixture = {
  readonly directory: string;
  readonly snapshotPath: string;
  readonly manifest: BackupManifest;
};

describe("reversible restore", () => {
  const temporaries: TemporaryDatabase[] = [];
  const leases: LeaseHandle[] = [];

  afterEach(() => {
    leases.splice(0).reverse().forEach((lease) => lease.release());
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const value = createTemporaryDatabase();
    temporaries.push(value);
    return value;
  };

  const writeProject = (
    database: Database.Database,
    id: string,
    name: string,
  ): void => {
    database.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(id, name, now, now);
  };

  const currentStore = (
    path: string,
    storeId: string,
    marker: string,
  ): void => {
    const database = openDatabase(path, {
      now: () => now,
      storeId,
    });
    try {
      writeProject(database, `project-${marker}`, marker);
    } finally {
      database.close();
    }
  };

  const oldStore = (
    path: string,
    marker: string,
  ): void => {
    const database = createVersionedDatabaseFixture(path, 2);
    try {
      writeProject(database, `project-${marker}`, marker);
    } finally {
      database.close();
    }
  };

  const schemaEightStore = (
    path: string,
    storeId: string,
    marker: string,
  ): void => {
    const database = new Database(path);
    try {
      for (const migration of migrations.filter(({ version }) => version <= 8)) {
        database.exec(migration.sql);
        migration.initialize?.(database, { storeId, now });
      }
      database.pragma("user_version = 8");
      writeProject(database, `project-${marker}`, marker);
    } finally {
      database.close();
    }
  };

  const schemaNineStore = (
    path: string,
    storeId: string,
    marker: string,
  ): void => {
    const database = new Database(path);
    try {
      for (const migration of migrations.filter(({ version }) => version <= 9)) {
        database.exec(migration.sql);
        migration.initialize?.(database, { storeId, now });
      }
      database.pragma("user_version = 9");
      writeProject(database, `project-${marker}`, marker);
    } finally {
      database.close();
    }
  };

  const coordinationTables = [
    "task_claims",
    "task_checkpoints",
    "task_delegations",
    "task_submissions",
    "coordination_events",
    "coordination_idempotency",
  ] as const;

  const seedCoordination = (path: string, marker: string): void => {
    const database = new Database(path);
    const projectId = `project-${marker}`;
    const task = {
      id: `task-${marker}`,
      projectId,
      kind: "task" as const,
      status: "active" as const,
      title: `Coordinate ${marker}`,
      body: "Preserve this exact restore state.",
      sourceKind: "human" as const,
      sourceRef: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const pack: TaskContextPack = {
      id: `pack-${marker}`,
      projectId,
      taskId: task.id,
      projectRevision: 1,
      generatedAt: now,
      budgetTokens: 4_000,
      estimatedTokens: 80,
      stableFrame: [],
      task: {
        record: task,
        mandatory: true,
        relevance: "active_task",
        relationshipKind: null,
      },
      related: [],
      omissions: [],
      sourceRevisions: [{ recordId: task.id, revision: 1 }],
    };
    const checkpoint = {
      summary: `Checkpoint ${marker}`,
      completedWork: ["restore fixture"],
      remainingWork: ["restore verification"],
      blockers: [],
      verificationEvidence: { tests: ["restore coordination"], artifacts: [] },
      repositoryEvidence: null,
    };
    const workerProfileId = `profile-${marker}`;
    const parentProfileId = `parent-${marker}`;
    const claimId = `claim-${marker}`;
    const checkpointId = `checkpoint-${marker}`;
    const delegationId = `delegation-${marker}`;
    const proposalId = `proposal-${marker}`;
    const submissionId = `submission-${marker}`;
    const operation = {
      operationId: `operation-${marker}`,
      type: "update_record" as const,
      recordId: task.id,
      expectedRecordRevision: 1,
      patch: { status: "completed" as const },
    };
    const delegationOfferedAt = "2026-07-27T11:50:00.000Z";
    const delegationAcceptedAt = "2026-07-27T11:55:00.000Z";
    const submissionDocument = {
      summary: `Submission ${marker}`,
      verificationEvidence: {
        tests: ["restore coordination"],
        artifacts: [],
      },
      repositoryEvidence: null,
      changes: {
        rationale: `Complete ${marker} after restore verification.`,
        operations: [operation],
      },
    };
    const claimAtCheckpoint = {
      id: claimId,
      projectId,
      taskId: task.id,
      profileId: workerProfileId,
      delegationId,
      state: "active" as const,
      baseProjectRevision: 1,
      baseTaskRevision: 1,
      contextPackId: pack.id,
      acquiredAt: now,
      expiresAt: "2026-07-27T12:30:00.000Z",
      absoluteExpiresAt: "2026-07-27T16:00:00.000Z",
      endedAt: null,
      latestCheckpointId: checkpointId,
    };
    const storedCheckpoint = {
      id: checkpointId,
      claimId,
      sequence: 1,
      ...checkpoint,
      createdAt: now,
      projectRevision: 1,
      taskRevision: 1,
      contextPackId: pack.id,
    };
    try {
      database.pragma("foreign_keys = ON");
      database.transaction(() => {
        database.prepare(`
          INSERT INTO project_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(task.id, projectId, task.kind, task.status, task.title, task.body,
          task.sourceKind, task.sourceRef, now, now);
        database.prepare(`
          INSERT INTO project_record_revisions VALUES (?, 1, ?, ?)
        `).run(task.id, JSON.stringify(task), now);
        database.prepare(`
          UPDATE projects SET revision = 1, updated_at = ? WHERE id = ?
        `).run(now, projectId);
        for (const [profileId, name] of [
          [workerProfileId, `Worker ${marker}`],
          [parentProfileId, `Parent ${marker}`],
        ] as const) {
          database.prepare(`
            INSERT INTO client_profiles VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
          `).run(profileId, name, "a".repeat(64), now, now, now);
          database.prepare(`
            INSERT INTO profile_project_authorities VALUES (?, ?, ?, 'proposal', ?, ?)
          `).run(`authority-${profileId}`, profileId, projectId, now, now);
        }
        database.prepare(`
          INSERT INTO context_packs VALUES (?, ?, ?, 1, 4000, 80, ?, ?)
        `).run(pack.id, projectId, task.id, JSON.stringify(pack), now);
        database.prepare(`
          INSERT INTO task_claims VALUES (
            ?, ?, ?, ?, ?, 'submitted', 1, 1, ?, ?,
            '2026-07-27T12:30:00.000Z', '2026-07-27T16:00:00.000Z',
            ?, ?
          )
        `).run(claimId, projectId, task.id, workerProfileId, delegationId,
          pack.id, now, now, checkpointId);
        database.prepare(`
          INSERT INTO task_checkpoints VALUES (?, ?, 1, ?, ?, 1, 1, ?)
        `).run(checkpointId, claimId,
          JSON.stringify(checkpoint), now, pack.id);
        database.prepare(`
          INSERT INTO task_delegations VALUES (
            ?, ?, ?, ?, ?, 'claimed', 1, 1, ?, ?, ?, ?, ?, NULL, ?
          )
        `).run(delegationId, projectId, task.id, parentProfileId,
          workerProfileId, JSON.stringify({
            summary: `Restore ${marker}`,
            constraints: [],
          }), JSON.stringify(["update_record"]), delegationOfferedAt,
          "2026-07-27T15:00:00.000Z", delegationAcceptedAt, claimId);
        database.prepare(`
          INSERT INTO change_proposals (
            id, project_id, profile_id, source_task_id,
            predecessor_proposal_id, base_project_revision, state, rationale,
            idempotency_key, request_hash, review_reason, reviewer_actor,
            created_at, updated_at, reviewed_at, origin_type,
            repository_snapshot_id
          ) VALUES (?, ?, ?, ?, NULL, 1, 'pending', ?, ?, ?, NULL, NULL,
            ?, ?, NULL, 'profile', NULL)
        `).run(proposalId, projectId, workerProfileId, task.id,
          submissionDocument.changes.rationale, `proposal-key-${marker}`,
          "b".repeat(64), now, now);
        database.prepare(`
          INSERT INTO proposal_operations VALUES (?, 0, ?, 'update_record', 1, ?)
        `).run(proposalId, operation.operationId, JSON.stringify(operation));
        database.prepare(`
          INSERT INTO task_submissions VALUES (
            ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'submitted', ?, NULL
          )
        `).run(submissionId, claimId, checkpointId, workerProfileId,
          projectId, task.id, pack.id, JSON.stringify(submissionDocument),
          proposalId, now);
        const insertCoordinationEvent = database.prepare(`
          INSERT INTO coordination_events (
            id, category, project_id, task_id, profile_id, claim_id, delegation_id,
            checkpoint_id, submission_id, proposal_id, prior_state, resulting_state,
            project_revision, task_revision, detail, created_at
          ) VALUES (
            @id, @category, @projectId, @taskId, @profileId, @claimId, @delegationId,
            @checkpointId, @submissionId, @proposalId, @priorState, @resultingState,
            1, 1, @detail, @createdAt
          )
        `);
        insertCoordinationEvent.run({
          id: `event-delegation-offer-${marker}`,
          category: "delegation_offer",
          projectId,
          taskId: task.id,
          profileId: parentProfileId,
          claimId: null,
          delegationId,
          checkpointId: null,
          submissionId: null,
          proposalId: null,
          priorState: null,
          resultingState: "offered",
          detail: `offered ${marker}`,
          createdAt: delegationOfferedAt,
        });
        insertCoordinationEvent.run({
          id: `event-delegation-accept-${marker}`,
          category: "delegation_accept",
          projectId,
          taskId: task.id,
          profileId: workerProfileId,
          claimId: null,
          delegationId,
          checkpointId: null,
          submissionId: null,
          proposalId: null,
          priorState: "offered",
          resultingState: "accepted",
          detail: `accepted ${marker}`,
          createdAt: delegationAcceptedAt,
        });
        insertCoordinationEvent.run({
          id: `event-claim-${marker}`,
          category: "claim",
          projectId,
          taskId: task.id,
          profileId: workerProfileId,
          claimId,
          delegationId,
          checkpointId: null,
          submissionId: null,
          proposalId: null,
          priorState: null,
          resultingState: "active",
          detail: `claimed ${marker}`,
          createdAt: now,
        });
        insertCoordinationEvent.run({
          id: `event-checkpoint-${marker}`,
          category: "checkpoint",
          projectId,
          taskId: task.id,
          profileId: workerProfileId,
          claimId,
          delegationId: null,
          checkpointId,
          submissionId: null,
          proposalId: null,
          priorState: "active",
          resultingState: "active",
          detail: `checkpointed ${marker}`,
          createdAt: now,
        });
        insertCoordinationEvent.run({
          id: `event-${marker}`,
          category: "submission",
          projectId,
          taskId: task.id,
          profileId: workerProfileId,
          claimId,
          delegationId,
          checkpointId,
          submissionId,
          proposalId,
          priorState: "active",
          resultingState: "submitted",
          detail: `submitted ${marker}`,
          createdAt: now,
        });
        database.prepare(`
          INSERT INTO coordination_idempotency VALUES (
            ?, ?, 'checkpoint', ?, ?, ?, ?
          )
        `).run(workerProfileId, projectId, `checkpoint-key-${marker}`,
          "c".repeat(64), JSON.stringify({
            claim: claimAtCheckpoint,
            checkpoint: storedCheckpoint,
          }), now);
      })();
    } finally {
      database.close();
    }
  };

  const coordinationRows = (path: string): Record<string, unknown[]> => {
    const database = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return Object.fromEntries(coordinationTables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]));
    } finally {
      database.close();
    }
  };

  const coordinationBaseRevisions = (path: string): Record<string, number> => {
    const database = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return database.prepare(`
        SELECT
          projects.revision AS project,
          context_packs.project_revision AS context_column,
          json_extract(context_packs.content_json, '$.projectRevision') AS context_json,
          task_claims.base_project_revision AS claim,
          task_checkpoints.project_revision AS checkpoint,
          task_submissions.base_project_revision AS submission,
          change_proposals.base_project_revision AS proposal
        FROM task_claims
        JOIN projects ON projects.id = task_claims.project_id
        JOIN context_packs ON context_packs.id = task_claims.context_pack_id
        JOIN task_checkpoints ON task_checkpoints.claim_id = task_claims.id
        JOIN task_submissions ON task_submissions.claim_id = task_claims.id
        JOIN change_proposals ON change_proposals.id = task_submissions.proposal_id
      `).get() as Record<string, number>;
    } finally {
      database.close();
    }
  };

  const projectNames = (path: string): string[] => {
    const database = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return (
        database.prepare("SELECT name FROM projects ORDER BY name").all() as {
          name: string;
        }[]
      ).map(({ name }) => name);
    } finally {
      database.close();
    }
  };

  const storeIdentity = (path: string): string => {
    const database = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return (
        database.prepare(
          "SELECT store_id FROM store_metadata WHERE singleton = 1",
        ).get() as { store_id: string }
      ).store_id;
    } finally {
      database.close();
    }
  };

  const bundle = (options: {
    readonly sourcePath: string;
    readonly storeId: string;
    readonly schemaVersion?: number;
    readonly backupId?: string;
  }): BundleFixture => {
    const fixture = temporary();
    const directory = join(
      fixture.directory,
      `${options.backupId ?? "source-backup"}.intentarc-backup`,
    );
    const snapshotPath = join(directory, "database.sqlite");
    mkdirSync(directory);
    cpSync(options.sourcePath, snapshotPath);
    const manifest: BackupManifest = {
      formatVersion: 1,
      backupId: options.backupId ?? "source-backup",
      createdAt: now,
      reason: "manual",
      storeId: options.storeId,
      schemaVersion: options.schemaVersion ?? currentSchemaVersion,
      applicationVersion: "intentarc test",
      byteSize: lstatSync(snapshotPath).size,
      sha256: sha256(snapshotPath),
    };
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify(manifest),
    );
    return { directory, snapshotPath, manifest };
  };

  const sourceBundle = (
    storeId = "store-source",
    marker = "source-state",
  ): BundleFixture => {
    const source = temporary();
    currentStore(source.path, storeId, marker);
    return bundle({ sourcePath: source.path, storeId });
  };

  const coordinationSourceBundle = (
    storeId: string,
    marker: string,
  ): BundleFixture => {
    const source = temporary();
    currentStore(source.path, storeId, marker);
    seedCoordination(source.path, marker);
    expect(createIntegrityChecker({ now: () => now }).checkPath(source.path, "full"))
      .toMatchObject({ passed: true, schemaVersion: 11, issues: [] });
    return bundle({ sourcePath: source.path, storeId });
  };

  const dependencies = (overrides: {
    readonly checker?: IntegrityChecker;
    readonly repository?: BundleRepository;
    readonly leaseManager?: LeaseManager;
    readonly backupService?: BackupService;
    readonly coordinator?: DurabilityCoordinator;
    readonly afterPhase?: (phase: RestoreReplacementPhase) => void;
    readonly renamePath?: (from: string, to: string) => Promise<void>;
  } = {}): RestoreService => {
    let nextId = 0;
    const newId = (): string => `restore-${++nextId}`;
    const checker = overrides.checker ??
      createIntegrityChecker({ now: () => now });
    const repository = overrides.repository ??
      createBundleRepository(checker);
    const leaseManager = overrides.leaseManager ?? createLeaseManager();
    const backupService = overrides.backupService ?? createBackupService({
      checker,
      repository,
      leaseManager,
      applicationVersion: "intentarc test",
      now: () => now,
      newId,
    });
    const coordinator = overrides.coordinator ??
      createDurabilityCoordinator({
        checker,
        leaseManager,
        backupService,
        now: () => now,
        newId,
      });

    return createRestoreService({
      checker,
      repository,
      leaseManager,
      backupService,
      coordinator,
      now: () => now,
      newId,
      ...(overrides.afterPhase === undefined
        ? {}
        : { afterPhase: overrides.afterPhase }),
      ...(overrides.renamePath === undefined
        ? {}
        : { renamePath: overrides.renamePath }),
    });
  };

  const restoreInput = (
    targetDatabasePath: string,
    source: BundleFixture,
    overrides: Partial<{
      confirmed: boolean;
      allowDifferentStore: boolean;
    }> = {},
  ) => ({
    targetDatabasePath,
    bundlePath: source.directory,
    confirmed: false,
    allowDifferentStore: false,
    ...overrides,
  });

  const expectRestoreError = async (
    operation: Promise<unknown>,
    code: string,
  ): Promise<DurabilityError> => {
    try {
      await operation;
    } catch (error) {
      expect(error).toBeInstanceOf(DurabilityError);
      expect(error).toMatchObject({ code });
      return error as DurabilityError;
    }
    throw new Error(`expected ${code}`);
  };

  const restoreArtifacts = (target: string): string[] =>
    readdirSync(join(target, "..")).filter((entry) =>
      entry.includes("intentarc-restore-stage") ||
      entry.includes("intentarc-rollback") ||
      entry.includes("intentarc-failed"),
    );

  it("restores a verified lineage to a new target without confirmation", async () => {
    const source = sourceBundle();
    const target = temporary().path;

    const result = await dependencies().restore(
      restoreInput(target, source),
    );

    expect(result).toMatchObject({
      backupId: source.manifest.backupId,
      targetDatabasePath: target,
      storeId: source.manifest.storeId,
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: null,
      diagnosticCapturePath: null,
    });
    expect(projectNames(target)).toEqual(["source-state"]);
    expect(storeIdentity(target)).toBe("store-source");
    expect(restoreArtifacts(target)).toEqual([]);
  });

  it("requires confirmation before replacing an existing same-lineage target", async () => {
    const source = sourceBundle("store-shared");
    const target = temporary().path;
    currentStore(target, "store-shared", "original-state");

    await expectRestoreError(
      dependencies().restore(restoreInput(target, source)),
      "confirmation_required",
    );

    expect(projectNames(target)).toEqual(["original-state"]);
    expect(existsSync(defaultBackupRoot(target))).toBe(false);
    expect(restoreArtifacts(target)).toEqual([]);
  });

  it("requires explicit cross-store permission in addition to confirmation", async () => {
    const source = sourceBundle("store-source");
    const target = temporary().path;
    currentStore(target, "store-target", "target-state");

    await expectRestoreError(
      dependencies().restore(restoreInput(target, source, {
        confirmed: true,
      })),
      "store_identity_mismatch",
    );

    expect(storeIdentity(target)).toBe("store-target");
    expect(projectNames(target)).toEqual(["target-state"]);
  });

  it("treats an unreadable target identity as a cross-store replacement", async () => {
    const source = sourceBundle();
    const target = temporary().path;
    writeFileSync(target, "not a sqlite database");
    const original = readFileSync(target);

    await expectRestoreError(
      dependencies().restore(restoreInput(target, source, {
        confirmed: true,
      })),
      "store_identity_mismatch",
    );

    expect(readFileSync(target)).toEqual(original);
    expect(
      readdirSync(join(target, "..")).filter((entry) =>
        entry.endsWith(".intentarc-diagnostic"),
      ),
    ).toEqual([]);
  });

  it("keeps coordination history unchanged when an active maintenance lease blocks restore", async () => {
    const source = sourceBundle("store-shared");
    const target = temporary().path;
    currentStore(target, "store-shared", "target-state");
    seedCoordination(target, "target-state");
    const coordinationBefore = coordinationRows(target);
    for (const table of coordinationTables) {
      expect(coordinationBefore[table]).not.toHaveLength(0);
    }
    expect(coordinationBaseRevisions(target)).toEqual({
      project: 1,
      context_column: 1,
      context_json: 1,
      claim: 1,
      checkpoint: 1,
      submission: 1,
      proposal: 1,
    });
    const leaseManager = createLeaseManager();
    leases.push(leaseManager.acquireMaintenance(target));

    await expectRestoreError(
      dependencies({ leaseManager }).restore(restoreInput(target, source, {
        confirmed: true,
      })),
      "maintenance_conflict",
    );

    expect(projectNames(target)).toEqual(["target-state"]);
    expect(coordinationRows(target)).toEqual(coordinationBefore);
    expect(restoreArtifacts(target)).toEqual([]);
  });

  it("rejects an invalid source before acquiring maintenance or touching the target", async () => {
    const source = sourceBundle("store-shared");
    const target = temporary().path;
    currentStore(target, "store-shared", "target-state");
    writeFileSync(
      join(source.directory, "manifest.json"),
      JSON.stringify({ ...source.manifest, sha256: "a".repeat(64) }),
    );

    await expectRestoreError(
      dependencies().restore(restoreInput(target, source, {
        confirmed: true,
      })),
      "backup_invalid",
    );

    expect(projectNames(target)).toEqual(["target-state"]);
    expect(existsSync(`${target}.intentarc-lock`)).toBe(false);
    expect(existsSync(defaultBackupRoot(target))).toBe(false);
  });

  it.each([
    [
      "a new target inside",
      (source: BundleFixture) =>
        join(source.directory, "new-target.sqlite"),
      false,
      false,
    ],
    [
      "the snapshot file in",
      (source: BundleFixture) => source.snapshotPath,
      true,
      false,
    ],
    [
      "the manifest file in",
      (source: BundleFixture) =>
        join(source.directory, "manifest.json"),
      true,
      true,
    ],
  ])(
    "rejects %s the verified source bundle without changing its bytes or layout",
    async (
      _case,
      targetFor: (source: BundleFixture) => string,
      confirmed: boolean,
      allowDifferentStore: boolean,
    ) => {
      const source = sourceBundle();
      const originalSnapshot = readFileSync(source.snapshotPath);
      const manifestPath = join(source.directory, "manifest.json");
      const originalManifest = readFileSync(manifestPath);

      await expectRestoreError(
        dependencies().restore(restoreInput(
          targetFor(source),
          source,
          { confirmed, allowDifferentStore },
        )),
        "restore_failed",
      );

      expect(readdirSync(source.directory).sort()).toEqual([
        "database.sqlite",
        "manifest.json",
      ]);
      expect(readFileSync(source.snapshotPath)).toEqual(originalSnapshot);
      expect(readFileSync(manifestPath)).toEqual(originalManifest);
      await expect(
        createBundleRepository(
          createIntegrityChecker({ now: () => now }),
        ).verify(source.directory),
      ).resolves.toMatchObject({
        verificationStatus: "verified",
        manifest: { backupId: source.manifest.backupId },
      });
    },
  );

  it("rejects a target canonically inside a directory alias of the source bundle", async () => {
    const source = sourceBundle();
    const aliasRoot = join(temporary().directory, "bundle-alias");
    symlinkSync(
      source.directory,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const originalSnapshot = readFileSync(source.snapshotPath);
    const manifestPath = join(source.directory, "manifest.json");
    const originalManifest = readFileSync(manifestPath);

    await expectRestoreError(
      dependencies().restore(restoreInput(
        join(aliasRoot, "new-target.sqlite"),
        source,
      )),
      "restore_failed",
    );

    expect(readdirSync(source.directory).sort()).toEqual([
      "database.sqlite",
      "manifest.json",
    ]);
    expect(readFileSync(source.snapshotPath)).toEqual(originalSnapshot);
    expect(readFileSync(manifestPath)).toEqual(originalManifest);
  });

  it("migrates only the staged copy of an old bundle with manifest lineage", async () => {
    const old = temporary();
    oldStore(old.path, "old-source-state");
    const source = bundle({
      sourcePath: old.path,
      storeId: "store-from-manifest",
      schemaVersion: 2,
      backupId: "old-source",
    });
    const immutableChecksum = sha256(source.snapshotPath);
    const target = temporary().path;

    await dependencies().restore(restoreInput(target, source));

    expect(sha256(source.snapshotPath)).toBe(immutableChecksum);
    const immutableSource = new Database(source.snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        immutableSource.pragma("user_version", { simple: true }),
      ).toBe(2);
    } finally {
      immutableSource.close();
    }
    const installed = new Database(target, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(installed.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
      expect(
        installed.prepare(
          "SELECT store_id FROM store_metadata WHERE singleton = 1",
        ).get(),
      ).toEqual({ store_id: "store-from-manifest" });
    } finally {
      installed.close();
    }
    expect(projectNames(target)).toEqual(["old-source-state"]);
  });

  it("restores a schema-eight bundle by migrating only its staged copy to schema nine", async () => {
    const old = temporary();
    schemaEightStore(old.path, "store-schema-eight", "schema-eight-source");
    const source = bundle({
      sourcePath: old.path,
      storeId: "store-schema-eight",
      schemaVersion: 8,
      backupId: "schema-eight-source",
    });
    const immutableChecksum = sha256(source.snapshotPath);
    const target = temporary().path;

    const result = await dependencies().restore(restoreInput(target, source));

    expect(result.schemaVersion).toBe(currentSchemaVersion);
    expect(sha256(source.snapshotPath)).toBe(immutableChecksum);
    const immutableSource = new Database(source.snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(immutableSource.pragma("user_version", { simple: true })).toBe(8);
    expect(immutableSource.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'human_change_idempotency_results'
    `).get()).toBeUndefined();
    immutableSource.close();
    const installed = new Database(target, {
      readonly: true,
      fileMustExist: true,
    });
    expect(installed.pragma("user_version", { simple: true }))
      .toBe(currentSchemaVersion);
    expect(installed.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'human_change_idempotency_results'
    `).get()).toEqual({ name: "human_change_idempotency_results" });
    installed.close();
    expect(projectNames(target)).toEqual(["schema-eight-source"]);
  });

  it("migrates a staged schema-nine bundle to the exact empty coordination schema", async () => {
    const old = temporary();
    schemaNineStore(old.path, "store-schema-nine", "schema-nine-source");
    const source = bundle({
      sourcePath: old.path,
      storeId: "store-schema-nine",
      schemaVersion: 9,
      backupId: "schema-nine-coordination-source",
    });
    const immutableChecksum = sha256(source.snapshotPath);
    const target = temporary().path;

    const result = await dependencies().restore(restoreInput(target, source));

    expect(result.schemaVersion).toBe(11);
    expect(sha256(source.snapshotPath)).toBe(immutableChecksum);
    const immutableSource = new Database(source.snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(immutableSource.pragma("user_version", { simple: true })).toBe(9);
      expect(immutableSource.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'task_claims'
      `).get()).toBeUndefined();
    } finally {
      immutableSource.close();
    }
    expect(coordinationRows(target)).toEqual(Object.fromEntries(
      coordinationTables.map((table) => [table, []]),
    ));
    expect(createIntegrityChecker({ now: () => now }).checkPath(target, "full"))
      .toMatchObject({ passed: true, schemaVersion: 11, issues: [] });
    expect(restoreArtifacts(target)).toEqual([]);
  });

  it("rechecks target identity after maintenance acquisition", async () => {
    const source = sourceBundle("store-shared");
    const target = temporary().path;
    currentStore(target, "store-shared", "initial-target");
    const raced = temporary();
    currentStore(raced.path, "store-raced", "raced-target");
    const realLeaseManager = createLeaseManager();
    let replaced = false;
    const leaseManager: LeaseManager = {
      acquireActive: (databasePath) =>
        realLeaseManager.acquireActive(databasePath),
      acquireMaintenance(databasePath) {
        const lease = realLeaseManager.acquireMaintenance(databasePath);
        if (!replaced) {
          replaced = true;
          rmSync(databasePath);
          renameSync(raced.path, databasePath);
        }
        return lease;
      },
      handoffMaintenanceToActive: (databasePath, maintenance) =>
        realLeaseManager.handoffMaintenanceToActive(
          databasePath,
          maintenance,
        ),
    };

    await expectRestoreError(
      dependencies({ leaseManager }).restore(restoreInput(target, source, {
        confirmed: true,
      })),
      "store_identity_mismatch",
    );

    expect(storeIdentity(target)).toBe("store-raced");
    expect(projectNames(target)).toEqual(["raced-target"]);
    expect(existsSync(defaultBackupRoot(target))).toBe(false);
  });

  it("retains a verified pre-restore bundle for a healthy target", async () => {
    const source = sourceBundle("store-shared", "restored-state");
    const target = temporary().path;
    currentStore(target, "store-shared", "pre-restore-state");
    const checker = createIntegrityChecker({ now: () => now });
    const repository = createBundleRepository(checker);

    const result = await dependencies({ checker, repository }).restore(
      restoreInput(target, source, { confirmed: true }),
    );

    expect(result.preRestoreBackup).toMatchObject({
      manifest: {
        reason: "pre-restore",
        storeId: "store-shared",
        schemaVersion: currentSchemaVersion,
      },
      verificationStatus: "verified",
    });
    expect(result.diagnosticCapturePath).toBeNull();
    const retained = await repository.list(defaultBackupRoot(target));
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      manifest: { reason: "pre-restore", storeId: "store-shared" },
    });
    const verified = await repository.verify(retained[0]!.bundlePath);
    expect(projectNames(verified.snapshotPath)).toEqual([
      "pre-restore-state",
    ]);
    expect(projectNames(target)).toEqual(["restored-state"]);
  });

  it("retains a strict diagnostic capture for an unhealthy target and never lists it as backup", async () => {
    const source = sourceBundle();
    const target = temporary().path;
    const originalFiles = new Map<string, Buffer>([
      [target, Buffer.from("damaged primary")],
      [`${target}-wal`, Buffer.from("damaged wal")],
      [`${target}-shm`, Buffer.from("damaged shm")],
    ]);
    for (const [path, content] of originalFiles) writeFileSync(path, content);
    const checker = createIntegrityChecker({ now: () => now });
    const repository = createBundleRepository(checker);

    const result = await dependencies({ checker, repository }).restore(
      restoreInput(target, source, {
        confirmed: true,
        allowDifferentStore: true,
      }),
    );

    expect(result.preRestoreBackup).toBeNull();
    expect(result.diagnosticCapturePath).toMatch(
      /\.intentarc-diagnostic$/,
    );
    const capturePath = result.diagnosticCapturePath!;
    const expectedNames = [
      "database.sqlite",
      "database.sqlite-wal",
      "database.sqlite-shm",
    ];
    const capturedByOriginalPath = new Map([
      [target, "database.sqlite"],
      [`${target}-wal`, "database.sqlite-wal"],
      [`${target}-shm`, "database.sqlite-shm"],
    ]);
    for (const [path, content] of originalFiles) {
      expect(
        readFileSync(join(capturePath, capturedByOriginalPath.get(path)!)),
      ).toEqual(content);
    }
    const serializedManifest = readFileSync(
      join(capturePath, "manifest.json"),
      "utf8",
    );
    expect(serializedManifest).not.toContain("damaged primary");
    expect(serializedManifest).not.toContain(target);
    expect(
      diagnosticCaptureManifestSchema.parse(JSON.parse(serializedManifest)),
    ).toEqual({
      formatVersion: 1,
      captureId: expect.any(String),
      createdAt: now,
      classification: "unverified_diagnostic",
      storeId: null,
      schemaVersion: null,
      issueCodes: ["database_unreadable"],
      files: expectedNames,
    });
    expect(await repository.list(join(target, ".."))).toEqual([]);
    expect(projectNames(target)).toEqual(["source-state"]);
  });

  it("reinstates exact coordination history and removes restore residue after interruption", async () => {
    const source = coordinationSourceBundle("store-shared", "restored-coordination");
    const target = temporary().path;
    currentStore(target, "store-shared", "original-coordination");
    seedCoordination(target, "original-coordination");
    const coordinationBefore = coordinationRows(target);
    for (const table of coordinationTables) {
      expect(coordinationBefore[table]).not.toHaveLength(0);
    }
    expect(coordinationBaseRevisions(target)).toEqual({
      project: 1,
      context_column: 1,
      context_json: 1,
      claim: 1,
      checkpoint: 1,
      submission: 1,
      proposal: 1,
    });
    const service = dependencies({
      afterPhase(phase) {
        if (phase === "stage-installed") {
          throw new Error("injected coordination restore interruption");
        }
      },
    });

    const error = await expectRestoreError(
      service.restore(restoreInput(target, source, { confirmed: true })),
      "restore_failed",
    );

    expect(error.details.originalReinstated).toBe(true);
    expect(coordinationRows(target)).toEqual(coordinationBefore);
    expect(projectNames(target)).toEqual(["original-coordination"]);
    expect(restoreArtifacts(target)).toEqual([]);
  });

  it.each<RestoreReplacementPhase>([
    "target-moved",
    "stage-installed",
    "target-opened",
    "post-install-checked",
  ])("reinstates primary and sidecars after failure at %s", async (phase) => {
    const source = sourceBundle();
    const target = temporary().path;
    const originals = new Map<string, Buffer>([
      [target, Buffer.from("original primary bytes")],
      [`${target}-wal`, Buffer.from("original wal bytes")],
      [`${target}-shm`, Buffer.from("original shm bytes")],
    ]);
    for (const [path, content] of originals) writeFileSync(path, content);
    const service = dependencies({
      afterPhase(completedPhase) {
        if (completedPhase === phase) {
          throw new Error(`injected failure after ${phase}`);
        }
      },
    });

    const error = await expectRestoreError(
      service.restore(restoreInput(target, source, {
        confirmed: true,
        allowDifferentStore: true,
      })),
      "restore_failed",
    );

    expect(error.message).toBe("Store restore failed.");
    expect(error.details.originalReinstated).toBe(true);
    for (const [path, content] of originals) {
      expect(readFileSync(path)).toEqual(content);
    }
    expect(restoreArtifacts(target)).toEqual([]);
    expect(
      readdirSync(join(target, "..")).filter((entry) =>
        entry.endsWith(".intentarc-diagnostic"),
      ),
    ).toEqual([]);
  });

  it("retains recovery and failed replacement artifacts when originals cannot be reinstated", async () => {
    const source = sourceBundle();
    const target = temporary().path;
    const originalPrimary = Buffer.from("original damaged primary");
    const originalWal = Buffer.from("original damaged wal");
    writeFileSync(target, originalPrimary);
    writeFileSync(`${target}-wal`, originalWal);
    const service = dependencies({
      afterPhase(phase) {
        if (phase === "stage-installed") {
          throw new Error("injected installed-stage failure");
        }
      },
      async renamePath(from, to) {
        if (from.includes(".intentarc-diagnostic")) {
          throw new Error("injected rollback failure");
        }
        await rename(from, to);
      },
    });

    const error = await expectRestoreError(
      service.restore(restoreInput(target, source, {
        confirmed: true,
        allowDifferentStore: true,
      })),
      "restore_failed",
    );

    expect(error.details.originalReinstated).toBe(false);
    expect(error.details.diagnosticCapturePath).toMatch(
      /\.intentarc-diagnostic$/,
    );
    expect(existsSync(error.details.diagnosticCapturePath!)).toBe(true);
    expect(readFileSync(join(
      error.details.diagnosticCapturePath!,
      "database.sqlite",
    ))).toEqual(originalPrimary);
    expect(readFileSync(join(
      error.details.diagnosticCapturePath!,
      "database.sqlite-wal",
    ))).toEqual(originalWal);

    const failedDirectories = readdirSync(join(target, "..")).filter(
      (entry) => entry.endsWith(".intentarc-failed"),
    );
    expect(failedDirectories).toHaveLength(1);
    const failedReplacement = join(
      target,
      "..",
      failedDirectories[0]!,
      "database.sqlite",
    );
    expect(projectNames(failedReplacement)).toEqual(["source-state"]);
  });

  it("reinstates originals when a target move completes and then reports failure", async () => {
    const source = sourceBundle();
    const target = temporary().path;
    const originals = new Map<string, Buffer>([
      [target, Buffer.from("original primary")],
      [`${target}-wal`, Buffer.from("original wal")],
      [`${target}-shm`, Buffer.from("original shm")],
    ]);
    for (const [path, content] of originals) writeFileSync(path, content);
    let injected = false;
    const service = dependencies({
      async renamePath(from, to) {
        await rename(from, to);
        if (!injected && from === target) {
          injected = true;
          throw new Error("target move reported failure after completion");
        }
      },
    });

    const error = await expectRestoreError(
      service.restore(restoreInput(target, source, {
        confirmed: true,
        allowDifferentStore: true,
      })),
      "restore_failed",
    );

    expect(error.details.originalReinstated).toBe(true);
    for (const [path, content] of originals) {
      expect(readFileSync(path)).toEqual(content);
    }
  });

  it("rolls back when stage installation completes and then reports failure", async () => {
    const source = sourceBundle();
    const target = temporary().path;
    writeFileSync(target, "original damaged primary");
    const original = readFileSync(target);
    const service = dependencies({
      async renamePath(from, to) {
        await rename(from, to);
        if (
          from.includes(".intentarc-restore-stage") &&
          to === target
        ) {
          throw new Error("stage install reported failure after completion");
        }
      },
    });

    const error = await expectRestoreError(
      service.restore(restoreInput(target, source, {
        confirmed: true,
        allowDifferentStore: true,
      })),
      "restore_failed",
    );

    expect(error.details.originalReinstated).toBe(true);
    expect(readFileSync(target)).toEqual(original);
  });

  const fileSymlinkSupported = (() => {
    const fixture = temporary();
    const target = join(fixture.directory, "symlink-target");
    const link = join(fixture.directory, "symlink-link");
    try {
      writeFileSync(target, "target");
      symlinkSync(target, link, "file");
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!fileSymlinkSupported)(
    "rejects a symlinked target without following or replacing it",
    async () => {
      const source = sourceBundle();
      const realTarget = temporary().path;
      currentStore(realTarget, "store-real", "real-target");
      const linkedTarget = join(temporary().directory, "linked.sqlite");
      symlinkSync(realTarget, linkedTarget, "file");

      await expectRestoreError(
        dependencies().restore(restoreInput(linkedTarget, source, {
          confirmed: true,
          allowDifferentStore: true,
        })),
        "restore_failed",
      );

      expect(projectNames(realTarget)).toEqual(["real-target"]);
      expect(lstatSync(linkedTarget).isSymbolicLink()).toBe(true);
    },
  );
});
