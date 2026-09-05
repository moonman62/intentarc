import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import type { TaskContextPack } from "../domain/index.js";
import {
  openDatabase,
  type IntentArcDatabase,
} from "../storage/database.js";
import {
  allocateBundlePaths,
  createBundleRepository,
  type BundleRepository,
} from "./bundles.js";
import { createIntegrityChecker, type IntegrityChecker } from "./integrity.js";
import { createLeaseManager, type LeaseManager } from "./leases.js";
import type { IntegrityIssueCode, IntegrityReport } from "./model.js";
import {
  createBackupService,
  type BackupService,
} from "./backup-service.js";
import { DurabilityError, durabilityErrorMessageFor } from "./errors.js";

const createdAt = "2026-07-27T12:00:00.000Z";
const backupId = "backup-test";
const storeId = "store-test";
const projectSecret = "private project alpha";

const createDirectoryLink = (target: string, link: string): void => {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
};

const failedReport = (code: IntegrityIssueCode): IntegrityReport => ({
  level: "full",
  passed: false,
  checkedAt: createdAt,
  storeId: null,
  schemaVersion: 2,
  issues: [{ code, severity: "error", description: "injected failure" }],
});

const checkerWithStoreIdentity = (): IntegrityChecker => {
  const real = createIntegrityChecker({ now: () => createdAt });
  return {
    checkConnection(database, level) {
      return { ...real.checkConnection(database, level), storeId };
    },
    checkPath: real.checkPath,
  };
};

describe("online backup creation", () => {
  const temporaries: TemporaryDatabase[] = [];
  const connections: IntentArcDatabase[] = [];

  afterEach(() => {
    connections.splice(0).forEach((database) => {
      if (database.open) database.close();
    });
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const value = createTemporaryDatabase();
    temporaries.push(value);
    return value;
  };

  const source = (): {
    readonly fixture: TemporaryDatabase;
    readonly database: IntentArcDatabase;
    readonly outputRoot: string;
  } => {
    const fixture = temporary();
    const database = createVersionedDatabaseFixture(fixture.path, 2);
    connections.push(database);
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    return {
      fixture,
      database,
      outputRoot: join(fixture.directory, "backups"),
    };
  };

  const coordinationSource = (): {
    readonly fixture: TemporaryDatabase;
    readonly database: IntentArcDatabase;
    readonly outputRoot: string;
  } => {
    const fixture = temporary();
    const database = openDatabase(fixture.path, {
      now: () => createdAt,
      storeId,
    });
    connections.push(database);
    const task = {
      id: "task-backup-coordination",
      projectId: "project-backup-coordination",
      kind: "task" as const,
      status: "active" as const,
      title: "Back up coordination",
      body: "Keep the claim and checkpoint together.",
      sourceKind: "human" as const,
      sourceRef: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const pack: TaskContextPack = {
      id: "pack-backup-coordination",
      projectId: task.projectId,
      taskId: task.id,
      projectRevision: 1,
      generatedAt: createdAt,
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
      summary: "Backup checkpoint",
      completedWork: ["claim"],
      remainingWork: ["restore"],
      blockers: [],
      verificationEvidence: { tests: ["backup coordination"], artifacts: [] },
      repositoryEvidence: null,
    };
    database.transaction(() => {
      database.prepare(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES (?, ?, 1, NULL, ?, ?)
      `).run(task.projectId, "Backup coordination", createdAt, createdAt);
      database.prepare(`
        INSERT INTO project_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(task.id, task.projectId, task.kind, task.status, task.title, task.body,
        task.sourceKind, task.sourceRef, createdAt, createdAt);
      database.prepare(`
        INSERT INTO project_record_revisions VALUES (?, 1, ?, ?)
      `).run(task.id, JSON.stringify(task), createdAt);
      database.prepare(`
        INSERT INTO client_profiles VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
      `).run("profile-backup-coordination", "Backup worker", "a".repeat(64),
        createdAt, createdAt, createdAt);
      database.prepare(`
        INSERT INTO profile_project_authorities VALUES (?, ?, ?, 'proposal', ?, ?)
      `).run("authority-backup-coordination", "profile-backup-coordination",
        task.projectId, createdAt, createdAt);
      database.prepare(`
        INSERT INTO context_packs VALUES (?, ?, ?, 1, 4000, 80, ?, ?)
      `).run(pack.id, task.projectId, task.id, JSON.stringify(pack), createdAt);
      database.prepare(`
        INSERT INTO task_claims VALUES (
          'claim-backup-coordination', ?, ?, 'profile-backup-coordination', NULL,
          'active', 1, 1, ?, ?, '2026-07-27T12:30:00.000Z',
          '2026-07-27T16:00:00.000Z', NULL, 'checkpoint-backup-coordination'
        )
      `).run(task.projectId, task.id, pack.id, createdAt);
      database.prepare(`
        INSERT INTO task_checkpoints VALUES (
          'checkpoint-backup-coordination', 'claim-backup-coordination', 1,
          ?, ?, 1, 1, ?
        )
      `).run(JSON.stringify(checkpoint), createdAt, pack.id);
      database.prepare(`
        INSERT INTO coordination_events (
          id, category, project_id, task_id, profile_id, claim_id, delegation_id,
          checkpoint_id, submission_id, proposal_id, prior_state, resulting_state,
          project_revision, task_revision, detail, created_at
        ) VALUES (
          'event-backup-coordination-claim', 'claim', ?, ?,
          'profile-backup-coordination', 'claim-backup-coordination', NULL,
          NULL, NULL, NULL, NULL, 'active', 1, 1, NULL, ?
        )
      `).run(task.projectId, task.id, createdAt);
      database.prepare(`
        INSERT INTO coordination_events (
          id, category, project_id, task_id, profile_id, claim_id, delegation_id,
          checkpoint_id, submission_id, proposal_id, prior_state, resulting_state,
          project_revision, task_revision, detail, created_at
        ) VALUES (
          'event-backup-coordination-checkpoint', 'checkpoint', ?, ?,
          'profile-backup-coordination', 'claim-backup-coordination', NULL,
          'checkpoint-backup-coordination', NULL, NULL, 'active', 'active',
          1, 1, NULL, ?
        )
      `).run(task.projectId, task.id, createdAt);
    })();
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    return {
      fixture,
      database,
      outputRoot: join(fixture.directory, "backups"),
    };
  };

  const service = (overrides: {
    readonly checker?: IntegrityChecker;
    readonly repository?: BundleRepository;
    readonly leaseManager?: LeaseManager;
    readonly now?: () => string;
    readonly newId?: () => string;
    readonly beforePublicationIdentityCapture?: (path: string) => void;
  } = {}) => {
    const checker = overrides.checker ?? checkerWithStoreIdentity();
    return createBackupService({
      checker,
      repository: overrides.repository ?? createBundleRepository(checker),
      leaseManager: overrides.leaseManager ?? createLeaseManager(),
      applicationVersion: "intentarc test",
      now: overrides.now ?? (() => createdAt),
      newId: overrides.newId ?? (() => backupId),
      ...(overrides.beforePublicationIdentityCapture === undefined
        ? {}
        : {
            beforePublicationIdentityCapture:
              overrides.beforePublicationIdentityCapture,
          }),
    });
  };

  it("creates a standalone verified snapshot containing commits from all WAL connections", async () => {
    const candidate = source();
    const concurrent = new Database(candidate.fixture.path);
    connections.push(concurrent);
    concurrent.pragma("journal_mode = WAL");
    concurrent.pragma("wal_autocheckpoint = 0");

    candidate.database.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run("project-1", projectSecret, createdAt, createdAt);
    concurrent.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run("project-2", "second committed project", createdAt, createdAt);
    expect(existsSync(`${candidate.fixture.path}-wal`)).toBe(true);

    const result = await service().create({
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
    });

    expect(result.verificationStatus).toBe("verified");
    expect(result.bundlePath).toMatch(/\.intentarc-backup$/);
    const snapshotPath = join(result.bundlePath, "database.sqlite");
    expect(existsSync(`${snapshotPath}-wal`)).toBe(false);
    expect(existsSync(`${snapshotPath}-shm`)).toBe(false);
    const snapshot = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(snapshot.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([
        { id: "project-1" },
        { id: "project-2" },
      ]);
    } finally {
      snapshot.close();
    }

    const serializedManifest = readFileSync(
      join(result.bundlePath, "manifest.json"),
      "utf8",
    );
    expect(serializedManifest).not.toContain(candidate.fixture.path);
    expect(serializedManifest).not.toContain(projectSecret);
    expect(JSON.parse(serializedManifest)).toEqual(result.manifest);
  });

  it("preserves exact coordination rows in the verified online snapshot", async () => {
    const candidate = coordinationSource();
    const exactTables = [
      "task_claims",
      "task_checkpoints",
      "task_delegations",
      "task_submissions",
      "coordination_events",
      "coordination_idempotency",
    ] as const;
    const exactRows = Object.fromEntries(exactTables.map((table) => [
      table,
      candidate.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));

    const result = await service().create({
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
    });

    const probe = temporary();
    cpSync(join(result.bundlePath, "database.sqlite"), probe.path);
    const snapshot = new Database(probe.path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(Object.fromEntries(exactTables.map((table) => [
        table,
        snapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]))).toEqual(exactRows);
    } finally {
      snapshot.close();
    }
  });

  it("creates no final bundle when source full integrity fails", async () => {
    const candidate = source();
    const checker: IntegrityChecker = {
      checkConnection: () => failedReport("integrity_check_failed"),
      checkPath: () => {
        throw new Error("snapshot integrity must not run");
      },
    };

    await expect(service({ checker }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "integrity_failed",
      details: { issueCodes: ["integrity_check_failed"] },
    });
    expect(existsSync(candidate.outputRoot)).toBe(false);
  });

  it("creates no final bundle when snapshot full integrity fails", async () => {
    const candidate = source();
    const healthy = checkerWithStoreIdentity();
    const checker: IntegrityChecker = {
      checkConnection: healthy.checkConnection,
      checkPath: () => failedReport("foreign_key_violation"),
    };

    await expect(service({ checker }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_failed",
      details: { issueCodes: ["foreign_key_violation"] },
    });
    expect(
      existsSync(candidate.outputRoot)
        ? readdirSync(candidate.outputRoot).filter((entry) =>
            entry.endsWith(".intentarc-backup"))
        : [],
    ).toEqual([]);
  });

  it("never overwrites an existing final directory", async () => {
    const candidate = source();
    const paths = allocateBundlePaths({
      root: candidate.outputRoot,
      createdAt,
      reason: "manual",
      backupId,
    });
    mkdirSync(paths.finalDirectory, { recursive: true });
    writeFileSync(join(paths.finalDirectory, "keep.txt"), "existing backup");

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_destination_invalid" });
    expect(readFileSync(join(paths.finalDirectory, "keep.txt"), "utf8")).toBe(
      "existing backup",
    );
  });

  it("serializes cooperative publication and preserves an empty final raced after the initial check", async () => {
    const candidate = source();
    const checker = checkerWithStoreIdentity();
    const realRepository = createBundleRepository(checker);
    const paths = allocateBundlePaths({
      root: candidate.outputRoot,
      createdAt,
      reason: "manual",
      backupId,
    });
    const input = {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual" as const,
      storeId,
    };
    let concurrentError: unknown;
    let backupService: BackupService;
    const repository: BundleRepository = {
      async verify(bundlePath) {
        const verified = await realRepository.verify(bundlePath);
        try {
          await backupService.createFromConnection(candidate.database, input);
        } catch (error) {
          concurrentError = error;
        }
        mkdirSync(paths.finalDirectory);
        return verified;
      },
      list: realRepository.list,
    };
    backupService = service({ checker, repository });

    await expect(
      backupService.createFromConnection(candidate.database, input),
    ).rejects.toMatchObject({ code: "backup_destination_invalid", details: {} });
    expect(concurrentError).toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
    expect(readdirSync(paths.finalDirectory)).toEqual([]);
    expect(
      readdirSync(candidate.outputRoot).filter((entry) =>
        entry.endsWith(".intentarc-publish-lock")),
    ).toEqual([]);
  });

  it.each([
    ["equal to the source path", (candidate: ReturnType<typeof source>) =>
      candidate.fixture.path],
    ["inside a completed bundle", (candidate: ReturnType<typeof source>) => {
      const completed = join(candidate.fixture.directory, "old.intentarc-backup");
      mkdirSync(completed);
      return join(completed, "nested");
    }],
    ["inside a case-variant completed bundle", (
      candidate: ReturnType<typeof source>,
    ) => {
      const completed = join(candidate.fixture.directory, "old.INTENTARC-BACKUP");
      mkdirSync(completed);
      return join(completed, "nested");
    }],
  ])("rejects an output root %s", async (_name, outputRootFor) => {
    const candidate = source();
    const outputRoot = outputRootFor(candidate);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
  });

  it("rejects an output root whose junction ancestor resolves inside a completed bundle", async () => {
    const candidate = source();
    const completed = join(candidate.fixture.directory, "old.intentarc-backup");
    mkdirSync(completed);
    const links = temporary();
    const alias = join(links.directory, "bundle-alias");
    createDirectoryLink(completed, alias);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: join(alias, "nested"),
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
    expect(readdirSync(completed)).toEqual([]);
  });

  it("rejects an output junction alias resolving to the source database", async () => {
    const candidate = source();
    const links = temporary();
    const alias = join(links.directory, "source-directory-alias");
    createDirectoryLink(candidate.fixture.directory, alias);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: join(alias, "intentarc.sqlite"),
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
  });

  it.each([
    ["WAL", (path: string) => `${path}-wal`],
    ["shared memory", (path: string) => `${path}-shm`],
    ["rollback journal", (path: string) => `${path}-journal`],
    ["lease control", (path: string) => `${path}.intentarc-lock`],
  ])("rejects an absent %s path as the backup root before creating it", async (
    _name,
    outputRootFor,
  ) => {
    const candidate = source();
    candidate.database.pragma("journal_mode = DELETE");
    rmSync(`${candidate.fixture.path}-wal`, { force: true });
    rmSync(`${candidate.fixture.path}-shm`, { force: true });
    const outputRoot = outputRootFor(candidate.fixture.path);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
    expect(existsSync(outputRoot)).toBe(false);
  });

  it("rejects a canonical directory alias of a protected SQLite sidecar path", async () => {
    const candidate = source();
    candidate.database.pragma("journal_mode = DELETE");
    rmSync(`${candidate.fixture.path}-wal`, { force: true });
    rmSync(`${candidate.fixture.path}-shm`, { force: true });
    const links = temporary();
    const alias = join(links.directory, "source-directory-alias");
    createDirectoryLink(candidate.fixture.directory, alias);
    const outputRoot = join(alias, `${candidate.fixture.path.split(/[\\/]/).at(-1)}-wal`);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
    expect(existsSync(`${candidate.fixture.path}-wal`)).toBe(false);
  });

  it("rejects an existing hard-link alias of a protected SQLite path", async () => {
    const candidate = source();
    candidate.database.pragma("journal_mode = DELETE");
    const outputRoot = join(candidate.fixture.directory, "hard-link-root");
    linkSync(candidate.fixture.path, outputRoot);

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({
      code: "backup_destination_invalid",
      details: {},
    });
  });

  it("removes its publication reservation when identity capture cannot begin", async () => {
    const candidate = source();

    await expect(service({
      beforePublicationIdentityCapture: () => {
        throw new Error("injected identity capture failure");
      },
    }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });

    expect(
      readdirSync(candidate.outputRoot).filter((entry) =>
        entry.endsWith(".intentarc-publish-lock")),
    ).toEqual([]);
  });

  it("retains a replacement publication reservation it does not own", async () => {
    const candidate = source();
    let replacementPath: string | undefined;

    await expect(service({
      beforePublicationIdentityCapture: (path) => {
        replacementPath = path;
        rmSync(path);
        writeFileSync(path, backupId);
        throw new Error("injected identity capture failure");
      },
    }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });

    expect(replacementPath).toBeDefined();
    expect(readFileSync(replacementPath!, "utf8")).toBe(backupId);
  });

  it("cleans a visibly temporary bundle when the online backup promise throws", async () => {
    const candidate = source();
    const throwingDatabase = {
      backup: async () => {
        throw new Error("injected online backup failure");
      },
    } as IntentArcDatabase;
    const checker: IntegrityChecker = {
      checkConnection: () => ({
        level: "full",
        passed: true,
        checkedAt: createdAt,
        storeId,
        schemaVersion: 2,
        issues: [],
      }),
      checkPath: () => {
        throw new Error("snapshot integrity must not run");
      },
    };

    await expect(service({ checker }).createFromConnection(throwingDatabase, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(
      existsSync(candidate.outputRoot) ? readdirSync(candidate.outputRoot) : [],
    ).toEqual([]);
  });

  it("create is blocked by a maintenance lease", async () => {
    const candidate = source();
    const leases = createLeaseManager();
    const maintenance = leases.acquireMaintenance(candidate.fixture.path);
    try {
      await expect(service({ leaseManager: leases }).create({
        databasePath: candidate.fixture.path,
        outputRoot: candidate.outputRoot,
        reason: "manual",
      })).rejects.toMatchObject({ code: "maintenance_conflict" });
    } finally {
      maintenance.release();
    }
  });

  it("createFromConnection never acquires a lease", async () => {
    const candidate = source();
    const forbiddenLeaseManager: LeaseManager = {
      acquireActive: () => {
        throw new Error("createFromConnection must not acquire active access");
      },
      acquireMaintenance: () => {
        throw new Error("createFromConnection must not acquire maintenance access");
      },
      handoffMaintenanceToActive: () => {
        throw new Error("createFromConnection must not hand off maintenance access");
      },
    };

    await expect(service({
      leaseManager: forbiddenLeaseManager,
    }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "pre-migration",
      storeId,
    })).resolves.toMatchObject({ verificationStatus: "verified" });
  });

  it("leaves no final-looking directory when bundle verification throws", async () => {
    const candidate = source();
    const repository: BundleRepository = {
      verify: async () => {
        throw new Error("injected verification failure");
      },
      list: async () => [],
    };

    await expect(service({ repository }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(
      existsSync(candidate.outputRoot) ? readdirSync(candidate.outputRoot) : [],
    ).toEqual([]);
  });

  it("uses exclusive manifest creation and cleans the staged bundle on collision", async () => {
    const candidate = source();
    const healthy = checkerWithStoreIdentity();
    const paths = allocateBundlePaths({
      root: candidate.outputRoot,
      createdAt,
      reason: "manual",
      backupId,
    });
    const checker: IntegrityChecker = {
      checkConnection: healthy.checkConnection,
      checkPath(snapshotPath, level) {
        const report = healthy.checkPath(snapshotPath, level);
        writeFileSync(paths.manifestPath, "do not overwrite");
        return report;
      },
    };

    await expect(service({ checker }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(readdirSync(candidate.outputRoot)).toEqual([]);
  });

  it("does not remove a pre-existing temporary directory when exclusive creation collides", async () => {
    const candidate = source();
    const paths = allocateBundlePaths({
      root: candidate.outputRoot,
      createdAt,
      reason: "manual",
      backupId,
    });
    mkdirSync(paths.temporaryDirectory, { recursive: true });
    writeFileSync(join(paths.temporaryDirectory, "keep.txt"), "not owned");

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(
      readFileSync(join(paths.temporaryDirectory, "keep.txt"), "utf8"),
    ).toBe("not owned");
  });

  it("does not remove a replacement moved onto the owned temporary path", async () => {
    const candidate = source();
    const checker = checkerWithStoreIdentity();
    const realRepository = createBundleRepository(checker);
    const paths = allocateBundlePaths({
      root: candidate.outputRoot,
      createdAt,
      reason: "manual",
      backupId,
    });
    const movedStage = join(candidate.outputRoot, ".moved-stage.intentarc-tmp");
    const repository: BundleRepository = {
      async verify(bundlePath) {
        const verified = await realRepository.verify(bundlePath);
        renameSync(bundlePath, movedStage);
        mkdirSync(bundlePath);
        writeFileSync(join(bundlePath, "replacement.txt"), "not owned");
        throw new Error(`injected replacement after ${verified.manifest.backupId}`);
      },
      list: realRepository.list,
    };

    await expect(service({ checker, repository }).createFromConnection(
      candidate.database,
      {
        databasePath: candidate.fixture.path,
        outputRoot: candidate.outputRoot,
        reason: "manual",
        storeId,
      },
    )).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(
      readFileSync(join(paths.temporaryDirectory, "replacement.txt"), "utf8"),
    ).toBe("not owned");
    expect(readdirSync(movedStage)).toEqual(expect.arrayContaining([
      "database.sqlite",
      "manifest.json",
    ]));
    expect(
      readdirSync(candidate.outputRoot).filter((entry) =>
        entry.endsWith(".intentarc-backup")),
    ).toEqual([]);
  });

  it("does not alter an output-root file when root preparation fails", async () => {
    const candidate = source();
    writeFileSync(candidate.outputRoot, "not a directory");

    await expect(service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(readFileSync(candidate.outputRoot, "utf8")).toBe("not a directory");
  });

  it("cleans the staged directory when snapshot hashing cannot begin", async () => {
    const candidate = source();
    const healthy = checkerWithStoreIdentity();
    const checker: IntegrityChecker = {
      checkConnection: healthy.checkConnection,
      checkPath(snapshotPath, level) {
        const report = healthy.checkPath(snapshotPath, level);
        rmSync(snapshotPath);
        return report;
      },
    };

    await expect(service({ checker }).createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: candidate.outputRoot,
      reason: "manual",
      storeId,
    })).rejects.toMatchObject({ code: "backup_failed", details: {} });
    expect(readdirSync(candidate.outputRoot)).toEqual([]);
  });

  it("normalizes a native source-open failure", async () => {
    const candidate = temporary();

    const promise = service().create({
      databasePath: candidate.path,
      outputRoot: join(candidate.directory, "backups"),
      reason: "manual",
    });

    await expect(promise).rejects.toBeInstanceOf(DurabilityError);
    await expect(promise).rejects.toMatchObject({
      code: "backup_failed",
      message: durabilityErrorMessageFor("backup_failed"),
      details: {},
    });
  });

  it("normalizes an early checker exception", async () => {
    const candidate = source();
    const checker: IntegrityChecker = {
      checkConnection: () => {
        throw new Error("native checker detail");
      },
      checkPath: () => {
        throw new Error("snapshot check must not run");
      },
    };

    const promise = service({ checker }).createFromConnection(
      candidate.database,
      {
        databasePath: candidate.fixture.path,
        outputRoot: candidate.outputRoot,
        reason: "manual",
        storeId,
      },
    );

    await expect(promise).rejects.toBeInstanceOf(DurabilityError);
    await expect(promise).rejects.toMatchObject({
      code: "backup_failed",
      message: durabilityErrorMessageFor("backup_failed"),
      details: {},
    });
  });

  it("normalizes invalid destination input before staging", async () => {
    const candidate = source();

    const promise = service().createFromConnection(candidate.database, {
      databasePath: candidate.fixture.path,
      outputRoot: " ",
      reason: "manual",
      storeId,
    });

    await expect(promise).rejects.toBeInstanceOf(DurabilityError);
    await expect(promise).rejects.toMatchObject({
      code: "backup_destination_invalid",
      message: durabilityErrorMessageFor("backup_destination_invalid"),
      details: {},
    });
  });
});
