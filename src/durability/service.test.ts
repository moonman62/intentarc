import {
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { defaultBackupRoot } from "./bundles.js";
import * as filesystemIdentity from "./filesystem-identity.js";
import { createLeaseManager, type LeaseHandle } from "./leases.js";
import { createDurabilityService } from "./service.js";

const now = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;

const fileSymlinksSupported = (): boolean => {
  const temporary = createTemporaryDatabase();
  const target = join(temporary.directory, "target");
  const link = join(temporary.directory, "link");
  try {
    writeFileSync(target, "");
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    removeTemporaryDatabase(temporary);
  }
};

const supportsFileSymlinks = fileSymlinksSupported();

describe("durability service facade", () => {
  const temporaries: TemporaryDatabase[] = [];
  const leases: LeaseHandle[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    leases.splice(0).reverse().forEach((lease) => lease.release());
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const fixture = createTemporaryDatabase();
    temporaries.push(fixture);
    return fixture;
  };

  const currentStore = (
    path: string,
    storeId: string,
    projectName: string,
  ): void => {
    const database = openDatabase(path, {
      now: () => now,
      storeId,
    });
    try {
      database.prepare(`
        INSERT INTO projects (id, name, revision, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(`project-${projectName}`, projectName, now, now);
    } finally {
      database.close();
    }
  };

  const ids = (...values: string[]) => {
    const remaining = [...values];
    return (): string => {
      const value = remaining.shift();
      if (value === undefined) throw new Error("test ID sequence exhausted");
      return value;
    };
  };

  it("checks full integrity while holding active access", async () => {
    const fixture = temporary();
    currentStore(fixture.path, "store-check", "checked");
    const service = createDurabilityService({ now: () => now });

    await expect(service.checkIntegrity(fixture.path)).resolves.toMatchObject({
      level: "full",
      passed: true,
      storeId: "store-check",
      schemaVersion: currentSchemaVersion,
    });

    const leaseManager = createLeaseManager();
    leases.push(leaseManager.acquireMaintenance(fixture.path));
    await expect(service.checkIntegrity(fixture.path)).rejects.toMatchObject({
      code: "maintenance_conflict",
    });
  });

  it("creates, lists, and independently verifies a manual backup", async () => {
    const fixture = temporary();
    currentStore(fixture.path, "store-backup", "backed-up");
    const service = createDurabilityService({
      now: () => now,
      newId: ids("manual-backup"),
    });

    const created = await service.createBackup({
      databasePath: fixture.path,
      reason: "manual",
    });

    expect(created).toMatchObject({
      verificationStatus: "verified",
      manifest: {
        backupId: "manual-backup",
        reason: "manual",
        storeId: "store-backup",
      },
    });
    await expect(service.listBackups(fixture.path)).resolves.toEqual([
      expect.objectContaining({
        bundlePath: created.bundlePath,
        verificationStatus: "not_checked",
      }),
    ]);
    rmSync(fixture.path);
    expect(existsSync(fixture.path)).toBe(false);
    await expect(service.verifyBackup(created.bundlePath)).resolves.toMatchObject({
      verificationStatus: "verified",
      manifest: { backupId: "manual-backup" },
    });
  });

  it("derives the implicit listing root from the canonical database path", async () => {
    const fixture = temporary();
    currentStore(fixture.path, "store-canonical-list", "canonical");
    const callerPath = join(temporary().directory, "database-alias.sqlite");
    const service = createDurabilityService({
      now: () => now,
      newId: ids("canonical-list-backup"),
    });
    const created = await service.createBackup({
      databasePath: fixture.path,
      reason: "manual",
    });
    vi.spyOn(filesystemIdentity, "canonicalDatabasePath").mockReturnValue(
      fixture.path,
    );

    const listed = await service.listBackups(callerPath);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      bundlePath: created.bundlePath,
      manifest: { backupId: "canonical-list-backup" },
      verificationStatus: "not_checked",
    });
  });

  it.skipIf(!supportsFileSymlinks)(
    "lists a default-root backup created through a file-symlink database alias",
    async () => {
      const fixture = temporary();
      currentStore(fixture.path, "store-alias", "aliased");
      const aliasPath = join(temporary().directory, "database-alias.sqlite");
      symlinkSync(fixture.path, aliasPath, "file");
      const service = createDurabilityService({
        now: () => now,
        newId: ids("alias-backup"),
      });

      const created = await service.createBackup({
        databasePath: aliasPath,
        reason: "manual",
      });

      const listed = await service.listBackups(aliasPath);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        bundlePath: created.bundlePath,
        manifest: { backupId: "alias-backup" },
        verificationStatus: "not_checked",
      });
    },
  );

  it("uses an explicit listing root without opening the primary database", async () => {
    const fixture = temporary();
    const explicitRoot = temporary().directory;
    const service = createDurabilityService({ now: () => now });
    vi.spyOn(filesystemIdentity, "canonicalDatabasePath").mockImplementation(
      () => {
        throw new Error("explicit roots must bypass canonical derivation");
      },
    );

    await expect(
      service.listBackups(fixture.path, explicitRoot),
    ).resolves.toEqual([]);
    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(defaultBackupRoot(fixture.path))).toBe(false);
  });

  it("delegates restore to the maintenance-owning restore service", async () => {
    const source = temporary();
    currentStore(source.path, "store-facade", "source-state");
    const service = createDurabilityService({
      now: () => now,
      newId: ids("manual-source", "restore-stage"),
    });
    const backup = await service.createBackup({
      databasePath: source.path,
      reason: "manual",
    });
    const target = temporary().path;

    const restored = await service.restoreBackup({
      targetDatabasePath: target,
      bundlePath: backup.bundlePath,
      confirmed: false,
      allowDifferentStore: false,
    });

    expect(restored).toMatchObject({
      backupId: "manual-source",
      storeId: "store-facade",
      schemaVersion: currentSchemaVersion,
      preRestoreBackup: null,
      diagnosticCapturePath: null,
    });
    await expect(service.checkIntegrity(target)).resolves.toMatchObject({
      passed: true,
      storeId: "store-facade",
    });
  });

  it("surfaces maintenance conflict when an active client owns the restore target", async () => {
    const source = temporary();
    currentStore(source.path, "store-shared", "source-state");
    const target = temporary();
    currentStore(target.path, "store-shared", "target-state");
    const service = createDurabilityService({
      now: () => now,
      newId: ids("manual-source", "restore-stage"),
    });
    const backup = await service.createBackup({
      databasePath: source.path,
      reason: "manual",
    });
    const leaseManager = createLeaseManager();
    leases.push(leaseManager.acquireActive(target.path));

    await expect(service.restoreBackup({
      targetDatabasePath: target.path,
      bundlePath: backup.bundlePath,
      confirmed: true,
      allowDifferentStore: false,
    })).rejects.toMatchObject({ code: "maintenance_conflict" });
  });
});
