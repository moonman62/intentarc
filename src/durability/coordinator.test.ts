import Database from "better-sqlite3";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import type { BackupService } from "./backup-service.js";
import {
  createDurabilityCoordinator,
  type PreparedStore,
} from "./coordinator.js";
import { DurabilityError } from "./errors.js";
import {
  createLeaseManager,
  type LeaseHandle,
  type LeaseManager,
} from "./leases.js";
import {
  createIntegrityChecker,
  type IntegrityChecker,
} from "./integrity.js";
import type { BackupManifest } from "./model.js";

const now = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;

describe("durability coordinator", () => {
  const temporaries: TemporaryDatabase[] = [];
  const preparedStores: PreparedStore[] = [];
  const leases: LeaseHandle[] = [];

  afterEach(() => {
    preparedStores.splice(0).forEach((prepared) => prepared.close());
    leases.splice(0).forEach((lease) => lease.release());
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const value = createTemporaryDatabase();
    temporaries.push(value);
    return value;
  };

  const createSchemaEightStore = (
    path: string,
    storeId: string,
    projectName: string,
  ): void => {
    const database = new Database(path);
    for (const migration of migrations.filter(({ version }) => version <= 8)) {
      database.exec(migration.sql);
      migration.initialize?.(database, { storeId, now });
    }
    database.pragma("user_version = 8");
    database.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES ('project-schema-eight', ?, 0, ?, ?)
    `).run(projectName, now, now);
    database.close();
  };

  const requireMaintenanceConflict = (
    acquire: () => LeaseHandle,
    missingMessage: string,
  ): void => {
    let acquired: LeaseHandle | undefined;
    try {
      acquired = acquire();
    } catch (error) {
      expect(error).toMatchObject({ code: "maintenance_conflict" });
      return;
    }
    acquired.release();
    throw new Error(missingMessage);
  };

  it("initializes a new store without an automatic backup and holds active access until idempotent close", async () => {
    const candidate = temporary();
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: () => "new-lineage",
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(prepared.storeId).toBe("store-new-lineage");
    expect(prepared.database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(
      prepared.database.prepare(
        "SELECT singleton, store_id, created_at FROM store_metadata",
      ).get(),
    ).toEqual({
      singleton: 1,
      store_id: "store-new-lineage",
      created_at: now,
    });
    expect(existsSync(`${candidate.path}.backups`)).toBe(false);
    expect(() => leaseManager.acquireMaintenance(candidate.path)).toThrow(
      DurabilityError,
    );

    prepared.close();
    prepared.close();
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("probes an existing current store under the one active lease retained by the prepared store", async () => {
    const candidate = temporary();
    openDatabase(candidate.path, {
      now: () => now,
      storeId: "store-current-ordering",
    }).close();
    const realLeaseManager = createLeaseManager();
    let activeAcquisitions = 0;
    let activeReleases = 0;
    const leaseManager: LeaseManager = {
      acquireActive(databasePath) {
        activeAcquisitions += 1;
        const lease = realLeaseManager.acquireActive(databasePath);
        let released = false;
        return {
          id: lease.id,
          kind: lease.kind,
          release() {
            if (released) return;
            released = true;
            activeReleases += 1;
            lease.release();
          },
        };
      },
      acquireMaintenance: (databasePath) =>
        realLeaseManager.acquireMaintenance(databasePath),
      handoffMaintenanceToActive: (databasePath, maintenance) =>
        realLeaseManager.handoffMaintenanceToActive(
          databasePath,
          maintenance,
        ),
    };
    const realChecker = createIntegrityChecker({ now: () => now });
    const checker: IntegrityChecker = {
      checkPath(databasePath, level) {
        requireMaintenanceConflict(
          () => realLeaseManager.acquireMaintenance(databasePath),
          "compatibility probe ran without active ownership",
        );
        return realChecker.checkPath(databasePath, level);
      },
      checkConnection: realChecker.checkConnection,
    };
    const coordinator = createDurabilityCoordinator({
      checker,
      leaseManager,
      now: () => now,
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(activeAcquisitions).toBe(1);
    expect(activeReleases).toBe(0);
    expect(prepared.storeId).toBe("store-current-ordering");
    expect(existsSync(`${candidate.path}.backups`)).toBe(false);

    prepared.close();
    expect(activeReleases).toBe(1);
  });

  it("re-probes under maintenance and rejects a store replaced after releasing old-schema active access", async () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const realLeaseManager = createLeaseManager();
    const realChecker = createIntegrityChecker({ now: () => now });
    let activeReleased = false;
    let storeChanged = false;
    let pathChecks = 0;
    const leaseManager: LeaseManager = {
      acquireActive(databasePath) {
        const lease = realLeaseManager.acquireActive(databasePath);
        let released = false;
        return {
          id: lease.id,
          kind: lease.kind,
          release() {
            if (released) return;
            released = true;
            activeReleased = true;
            lease.release();
          },
        };
      },
      acquireMaintenance(databasePath) {
        if (!activeReleased) {
          throw new Error(
            "maintenance acquisition occurred before active release",
          );
        }
        if (!storeChanged) {
          const replacement = new Database(databasePath);
          replacement.pragma(`user_version = ${currentSchemaVersion + 1}`);
          replacement.close();
          storeChanged = true;
        }
        return realLeaseManager.acquireMaintenance(databasePath);
      },
      handoffMaintenanceToActive: (databasePath, maintenance) =>
        realLeaseManager.handoffMaintenanceToActive(
          databasePath,
          maintenance,
        ),
    };
    const checker: IntegrityChecker = {
      checkPath(databasePath, level) {
        pathChecks += 1;
        if (pathChecks === 2) {
          requireMaintenanceConflict(
            () => realLeaseManager.acquireActive(databasePath),
            "old-schema re-probe ran without maintenance ownership",
          );
        }
        return realChecker.checkPath(databasePath, level);
      },
      checkConnection: realChecker.checkConnection,
    };
    const coordinator = createDurabilityCoordinator({
      checker,
      leaseManager,
      now: () => now,
      newId: () => "must-not-be-used",
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toMatchObject({ code: "unsupported_schema" });

    expect(pathChecks).toBe(2);
    expect(storeChanged).toBe(true);
    expect(existsSync(`${candidate.path}.backups`)).toBe(false);
    const unchangedFuture = new Database(candidate.path);
    expect(unchangedFuture.pragma("user_version", { simple: true })).toBe(currentSchemaVersion + 1);
    unchangedFuture.close();
    leases.push(realLeaseManager.acquireActive(candidate.path));
  });

  it("creates one verified pre-migration bundle with the migrated store lineage and preserves rows", async () => {
    const candidate = temporary();
    const old = createVersionedDatabaseFixture(candidate.path, 2);
    old.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run("project-existing", "Existing project", now, now);
    old.close();
    const ids = ["lineage-uuid", "backup-id"];
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: () => ids.shift()!,
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(prepared.storeId).toBe("store-lineage-uuid");
    expect(prepared.database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(
      prepared.database.prepare(
        "SELECT name FROM projects WHERE id = 'project-existing'",
      ).get(),
    ).toEqual({ name: "Existing project" });
    expect(
      prepared.database.prepare(
        "SELECT store_id FROM store_metadata WHERE singleton = 1",
      ).get(),
    ).toEqual({ store_id: "store-lineage-uuid" });

    const backupRoot = `${candidate.path}.backups`;
    const bundles = readdirSync(backupRoot);
    expect(bundles).toHaveLength(1);
    const bundlePath = join(backupRoot, bundles[0]!);
    const manifest = JSON.parse(
      readFileSync(join(bundlePath, "manifest.json"), "utf8"),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      backupId: "backup-id",
      reason: "pre-migration",
      schemaVersion: 2,
      storeId: "store-lineage-uuid",
    });

    const snapshot = new Database(join(bundlePath, "database.sqlite"), {
      readonly: true,
    });
    expect(snapshot.pragma("user_version", { simple: true })).toBe(2);
    snapshot.close();
    expect(() => leaseManager.acquireMaintenance(candidate.path)).toThrow(
      DurabilityError,
    );
  });

  it("creates one verified pre-migration bundle and preserves lineage before schema three becomes current", async () => {
    const candidate = temporary();
    const old = createVersionedDatabaseFixture(candidate.path, 2);
    old.exec(`
      CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO store_metadata VALUES (
        1, 'store-existing-lineage', '${now}'
      );
    `);
    old.pragma("user_version = 3");
    old.close();
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: () => "schema-three-backup",
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(prepared.storeId).toBe("store-existing-lineage");
    expect(prepared.database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    const backupRoot = `${candidate.path}.backups`;
    const bundles = readdirSync(backupRoot);
    expect(bundles).toHaveLength(1);
    const bundlePath = join(backupRoot, bundles[0]!);
    const manifest = JSON.parse(
      readFileSync(join(bundlePath, "manifest.json"), "utf8"),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      backupId: "schema-three-backup",
      reason: "pre-migration",
      schemaVersion: 3,
      storeId: "store-existing-lineage",
    });
    const snapshot = new Database(join(bundlePath, "database.sqlite"), {
      readonly: true,
    });
    expect(snapshot.pragma("user_version", { simple: true })).toBe(3);
    expect(
      snapshot.prepare(
        "SELECT store_id FROM store_metadata WHERE singleton = 1",
      ).get(),
    ).toEqual({ store_id: "store-existing-lineage" });
    snapshot.close();
  });

  it("backs up schema eight before migrating only the active store to schema nine", async () => {
    const candidate = temporary();
    createSchemaEightStore(
      candidate.path,
      "store-schema-eight-backup",
      "Before schema nine",
    );
    const coordinator = createDurabilityCoordinator({
      leaseManager: createLeaseManager(),
      now: () => now,
      newId: () => "schema-eight-backup",
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(prepared.database.pragma("user_version", { simple: true }))
      .toBe(currentSchemaVersion);
    expect(prepared.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'human_change_idempotency_results'
    `).get()).toEqual({ name: "human_change_idempotency_results" });
    const bundlePath = join(
      `${candidate.path}.backups`,
      readdirSync(`${candidate.path}.backups`)[0]!,
    );
    const manifest = JSON.parse(
      readFileSync(join(bundlePath, "manifest.json"), "utf8"),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      backupId: "schema-eight-backup",
      schemaVersion: 8,
      storeId: "store-schema-eight-backup",
    });
    const snapshot = new Database(join(bundlePath, "database.sqlite"), {
      readonly: true,
    });
    expect(snapshot.pragma("user_version", { simple: true })).toBe(8);
    expect(snapshot.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'human_change_idempotency_results'
    `).get()).toBeUndefined();
    snapshot.close();
  });

  it("reopens and checks a migrated store before atomically handing maintenance to active access", async () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const leaseManager = createLeaseManager();
    let reopenedUnderMaintenance = false;
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: (() => {
        const ids = ["handoff-lineage", "handoff-backup"];
        return () => ids.shift()!;
      })(),
      openCurrentDatabase(path, options) {
        requireMaintenanceConflict(
          () => leaseManager.acquireActive(path),
          "migrated database reopened after maintenance was released",
        );
        reopenedUnderMaintenance = true;
        return openDatabase(path, options);
      },
    });

    const prepared = await coordinator.prepareForApplication(candidate.path);
    preparedStores.push(prepared);

    expect(reopenedUnderMaintenance).toBe(true);
    expect(prepared.storeId).toBe("store-handoff-lineage");
    requireMaintenanceConflict(
      () => leaseManager.acquireMaintenance(candidate.path),
      "prepared store did not retain active access after handoff",
    );
  });

  it("retains the verified bundle and reports a preserved transaction when a later migration fails", async () => {
    const candidate = temporary();
    const old = createVersionedDatabaseFixture(candidate.path, 1);
    old.exec(`
      CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    old.close();
    const ids = ["failed-lineage", "failure-backup"];
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: () => ids.shift()!,
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toMatchObject({
      code: "migration_failed",
      details: {
        originalSchemaVersion: 1,
        requestedSchemaVersion: currentSchemaVersion,
        transactionPreserved: true,
        backupId: "failure-backup",
      },
    });

    const database = new Database(candidate.path);
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(
      database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'client_profiles'",
      ).get(),
    ).toBeUndefined();
    database.close();
    expect(readdirSync(`${candidate.path}.backups`)).toHaveLength(1);
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("reports a committed transaction and releases active access when current-schema reopening fails", async () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const ids = ["committed-lineage", "committed-backup"];
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      now: () => now,
      newId: () => ids.shift()!,
      openCurrentDatabase() {
        throw new Error("injected reopen failure");
      },
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toMatchObject({
      code: "migration_failed",
      details: {
        originalSchemaVersion: 2,
        requestedSchemaVersion: currentSchemaVersion,
        transactionPreserved: false,
        backupId: "committed-backup",
      },
    });

    const migrated = new Database(candidate.path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    migrated.close();
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("releases maintenance and its old-schema connection when backup creation fails", async () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const leaseManager = createLeaseManager();
    const backupService: BackupService = {
      async create() {
        throw new Error("not used");
      },
      async createFromConnection() {
        throw new DurabilityError("backup_failed");
      },
    };
    const coordinator = createDurabilityCoordinator({
      backupService,
      leaseManager,
      now: () => now,
      newId: () => "backup-failure-lineage",
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toMatchObject({ code: "backup_failed" });

    const writable = new Database(candidate.path);
    expect(writable.pragma("user_version", { simple: true })).toBe(2);
    writable.close();
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("refuses an unverified pre-migration summary before changing the old schema", async () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const leaseManager = createLeaseManager();
    const backupService: BackupService = {
      async create() {
        throw new Error("not used");
      },
      async createFromConnection() {
        return {
          manifest: {
            formatVersion: 1,
            backupId: "unverified-backup",
            createdAt: now,
            reason: "pre-migration",
            storeId: "store-unverified-lineage",
            schemaVersion: 2,
            applicationVersion: "intentarc test",
            byteSize: 1,
            sha256: "a".repeat(64),
          },
          bundlePath: join(
            candidate.directory,
            "unverified.intentarc-backup",
          ),
          verificationStatus: "not_checked",
        };
      },
    };
    const coordinator = createDurabilityCoordinator({
      backupService,
      leaseManager,
      now: () => now,
      newId: () => "unverified-lineage",
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toMatchObject({ code: "backup_failed" });

    const unchanged = new Database(candidate.path);
    expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
    unchanged.close();
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("releases active access when opening an already-current store fails", async () => {
    const candidate = temporary();
    openDatabase(candidate.path, { now: () => now, storeId: "store-current" })
      .close();
    const leaseManager = createLeaseManager();
    const coordinator = createDurabilityCoordinator({
      leaseManager,
      openCurrentDatabase() {
        throw new Error("injected current open failure");
      },
    });

    await expect(
      coordinator.prepareForApplication(candidate.path),
    ).rejects.toThrow("injected current open failure");
    leases.push(leaseManager.acquireMaintenance(candidate.path));
  });

  it("migrates an already-staged old backup without creating another bundle", () => {
    const candidate = temporary();
    createVersionedDatabaseFixture(candidate.path, 2).close();
    const coordinator = createDurabilityCoordinator({ now: () => now });

    coordinator.migrateStagedBackup({
      databasePath: candidate.path,
      storeId: "store-from-manifest",
    });

    const migrated = new Database(candidate.path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(
      migrated.prepare(
        "SELECT store_id FROM store_metadata WHERE singleton = 1",
      ).get(),
    ).toEqual({ store_id: "store-from-manifest" });
    migrated.close();
    expect(existsSync(`${candidate.path}.backups`)).toBe(false);
  });
});
