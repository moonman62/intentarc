import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createIntegrityChecker } from "./integrity.js";
import type { BackupManifest, IntegrityChecker, IntegrityReport } from "./model.js";
import {
  allocateBundlePaths,
  createBundleRepository,
  defaultBackupRoot,
} from "./bundles.js";

const createdAt = "2026-07-27T12:00:00.000Z";
const storeId = "store-1";

const manifestFor = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  formatVersion: 1,
  backupId: "backup-1",
  createdAt,
  reason: "manual",
  storeId,
  schemaVersion: 2,
  applicationVersion: "0.0.0-test",
  byteSize: 0,
  sha256: "0".repeat(64),
  ...overrides,
});

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const invalidBackup = (promise: Promise<unknown>): Promise<void> =>
  expect(promise).rejects.toMatchObject({ code: "backup_invalid", details: {} });

const fileSymlinksSupported = (): boolean => {
  const temporary = createTemporaryDatabase();
  const target = join(temporary.directory, "target");
  const link = join(temporary.directory, "link");
  try {
    writeFileSync(target, "target");
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    removeTemporaryDatabase(temporary);
  }
};

const supportsFileSymlinks = fileSymlinksSupported();

const createDirectoryLink = (target: string, link: string): void => {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
};

describe("backup bundles", () => {
  const temporaries: TemporaryDatabase[] = [];

  afterEach(() => {
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const value = createTemporaryDatabase();
    temporaries.push(value);
    return value;
  };

  const healthySnapshot = (): string => {
    const fixture = temporary();
    const database = createVersionedDatabaseFixture(fixture.path, 2);
    database.close();
    return fixture.path;
  };

  const bundle = (options: {
    readonly manifest?: Partial<BackupManifest>;
    readonly directoryName?: string;
  } = {}): { readonly directory: string; readonly snapshot: string; readonly manifest: BackupManifest } => {
    const root = temporary().directory;
    const directory = join(root, options.directoryName ?? "valid.intentarc-backup");
    const snapshot = join(directory, "database.sqlite");
    mkdirSync(directory);
    cpSync(healthySnapshot(), snapshot);
    const manifest = manifestFor({
      byteSize: lstatSync(snapshot).size,
      sha256: sha256(snapshot),
      ...options.manifest,
    });
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    return { directory, snapshot, manifest };
  };

  const repository = () => createBundleRepository(createIntegrityChecker());

  it("derives the default root beside the database", () => {
    expect(defaultBackupRoot("C:/data/intentarc.sqlite")).toBe(
      "C:/data/intentarc.sqlite.backups",
    );
  });

  it("allocates filesystem-safe final and visibly temporary bundle names", () => {
    const paths = allocateBundlePaths({
      root: "C:/data/intentarc.sqlite.backups",
      createdAt,
      reason: "pre-migration",
      backupId: "backup_123",
    });

    expect(paths.finalDirectory).toBe(
      "C:\\data\\intentarc.sqlite.backups\\2026-07-27T12-00-00.000Z-pre-migration-backup_123.intentarc-backup",
    );
    expect(paths.temporaryDirectory).not.toMatch(/\.intentarc-backup$/);
    expect(paths.snapshotPath).toBe(`${paths.temporaryDirectory}\\database.sqlite`);
    expect(paths.manifestPath).toBe(`${paths.temporaryDirectory}\\manifest.json`);
  });

  it("canonicalizes an offset timestamp to a filesystem-safe UTC bundle name", () => {
    const root = temporary().directory;
    const paths = allocateBundlePaths({
      root,
      createdAt: "2026-07-27T13:00:00.000+01:00",
      reason: "manual",
      backupId: "backup_123",
    });

    expect(paths.finalDirectory).toBe(join(
      resolve(root),
      "2026-07-27T12-00-00.000Z-manual-backup_123.intentarc-backup",
    ));
    for (const path of [
      paths.temporaryDirectory,
      paths.finalDirectory,
      paths.snapshotPath,
      paths.manifestPath,
    ]) {
      expect(relative(resolve(root), resolve(path))).not.toMatch(/^\.\.(?:[\\/]|$)/);
    }
  });

  it.each([
    ["an invalid timestamp", { createdAt: "not-a-timestamp" }],
    ["a nonexistent calendar timestamp", { createdAt: "2026-02-30T12:00:00.000Z" }],
    ["a traversal backup ID", { backupId: "../outside" }],
    ["a runtime-invalid reason", { reason: "../outside" }],
  ])("rejects allocation with %s", (_name, unsafeInput) => {
    expect(() => allocateBundlePaths({
      root: temporary().directory,
      createdAt,
      reason: "manual",
      backupId: "backup_123",
      ...unsafeInput,
    } as never)).toThrowError(expect.objectContaining({ code: "backup_invalid" }));
  });

  it("verifies an immutable bundle with a complete healthy integrity report", async () => {
    const candidate = bundle();

    await expect(repository().verify(candidate.directory)).resolves.toMatchObject({
      manifest: candidate.manifest,
      bundlePath: candidate.directory,
      snapshotPath: candidate.snapshot,
      verificationStatus: "verified",
      integrity: { level: "full", passed: true, schemaVersion: 2, issues: [] },
    });
  });

  it("leaves a verified bundle byte-for-byte unchanged and eligible for repeated verification", async () => {
    const candidate = bundle();
    const snapshot = new Database(candidate.snapshot);
    snapshot.pragma("journal_mode = WAL");
    snapshot.close();
    writeFileSync(join(candidate.directory, "manifest.json"), JSON.stringify({
      ...candidate.manifest,
      byteSize: lstatSync(candidate.snapshot).size,
      sha256: sha256(candidate.snapshot),
    }));
    const snapshotBytes = readFileSync(candidate.snapshot);
    const manifestPath = join(candidate.directory, "manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    const bundleRepository = repository();
    const expectBundleUnchanged = (): void => {
      expect(readdirSync(candidate.directory).sort()).toEqual([
        "database.sqlite",
        "manifest.json",
      ]);
      expect(readFileSync(candidate.snapshot)).toEqual(snapshotBytes);
      expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    };

    await expect(bundleRepository.verify(candidate.directory)).resolves.toMatchObject({
      verificationStatus: "verified",
    });
    expectBundleUnchanged();
    await expect(bundleRepository.verify(candidate.directory)).resolves.toMatchObject({
      verificationStatus: "verified",
    });
    expectBundleUnchanged();
  });

  it("checks integrity on a private copy and removes its workspace after success", async () => {
    const candidate = bundle();
    const sourceBytes = readFileSync(candidate.snapshot);
    const realChecker = createIntegrityChecker();
    let checkedPath: string | undefined;
    const observingChecker: IntegrityChecker = {
      checkPath: (path, level) => {
        checkedPath = path;
        expect(readFileSync(path)).toEqual(sourceBytes);
        expect(readFileSync(candidate.snapshot)).toEqual(sourceBytes);
        return realChecker.checkPath(path, level);
      },
      checkConnection: (database, level) => realChecker.checkConnection(database, level),
    };

    try {
      await expect(
        createBundleRepository(observingChecker).verify(candidate.directory),
      ).resolves.toMatchObject({ verificationStatus: "verified" });

      expect(checkedPath).toBeDefined();
      expect(checkedPath).not.toBe(candidate.snapshot);
      expect(existsSync(dirname(checkedPath!))).toBe(false);
      expect(readFileSync(candidate.snapshot)).toEqual(sourceBytes);
    } finally {
      if (checkedPath !== undefined && checkedPath !== candidate.snapshot) {
        rmSync(dirname(checkedPath), { recursive: true, force: true });
      }
    }
  });

  it("sizes, hashes, and integrity-checks one private snapshot copy", async () => {
    const candidate = bundle();
    const sourceBytes = readFileSync(candidate.snapshot);
    const realChecker = createIntegrityChecker();
    let privateSnapshotPath: string | undefined;
    let copied = false;
    const observingChecker: IntegrityChecker = {
      checkPath: (path, level) => {
        privateSnapshotPath = path;
        expect(copied).toBe(true);
        expect(readFileSync(path)).toEqual(sourceBytes);
        expect(readFileSync(candidate.snapshot, "utf8")).toBe(
          "changed after the private copy",
        );
        return realChecker.checkPath(path, level);
      },
      checkConnection: realChecker.checkConnection,
    };

    await expect(createBundleRepository(observingChecker, {
      afterPrivateCopy: () => {
        copied = true;
        writeFileSync(candidate.snapshot, "changed after the private copy");
      },
    }).verify(candidate.directory)).resolves.toMatchObject({
      verificationStatus: "verified",
    });
    expect(privateSnapshotPath).toBeDefined();
  });

  it("does not delete source artifacts introduced during integrity checking", async () => {
    const candidate = bundle();
    const walPath = `${candidate.snapshot}-wal`;
    const shmPath = `${candidate.snapshot}-shm`;
    const realChecker = createIntegrityChecker();
    const observingChecker: IntegrityChecker = {
      checkPath: (path, level) => {
        const report = realChecker.checkPath(path, level);
        writeFileSync(walPath, "");
        writeFileSync(shmPath, "unrelated");
        return report;
      },
      checkConnection: (database, level) => realChecker.checkConnection(database, level),
    };

    await expect(
      createBundleRepository(observingChecker).verify(candidate.directory),
    ).resolves.toMatchObject({ verificationStatus: "verified" });
    expect(readFileSync(walPath, "utf8")).toBe("");
    expect(readFileSync(shmPath, "utf8")).toBe("unrelated");
  });

  it("removes its private workspace when integrity checking fails", async () => {
    const candidate = bundle();
    let checkedPath: string | undefined;
    const failingChecker: IntegrityChecker = {
      checkPath: (path) => {
        checkedPath = path;
        throw new Error("injected integrity failure");
      },
      checkConnection: () => {
        throw new Error("connection checking is not expected");
      },
    };

    try {
      await invalidBackup(
        createBundleRepository(failingChecker).verify(candidate.directory),
      );
      expect(checkedPath).toBeDefined();
      expect(checkedPath).not.toBe(candidate.snapshot);
      expect(existsSync(dirname(checkedPath!))).toBe(false);
    } finally {
      if (checkedPath !== undefined && checkedPath !== candidate.snapshot) {
        rmSync(dirname(checkedPath), { recursive: true, force: true });
      }
    }
  });

  it("rejects a manifest with unrecognized fields", async () => {
    const candidate = bundle();
    writeFileSync(
      join(candidate.directory, "manifest.json"),
      JSON.stringify({ ...candidate.manifest, sourcePath: "C:/private/intentarc.sqlite" }),
    );

    await invalidBackup(repository().verify(candidate.directory));
  });

  it.each([
    ["incorrect byte size", (candidate: ReturnType<typeof bundle>) =>
      writeFileSync(join(candidate.directory, "manifest.json"), JSON.stringify({
        ...candidate.manifest,
        byteSize: candidate.manifest.byteSize + 1,
      }))],
    ["incorrect checksum", (candidate: ReturnType<typeof bundle>) =>
      writeFileSync(join(candidate.directory, "manifest.json"), JSON.stringify({
        ...candidate.manifest,
        sha256: "a".repeat(64),
      }))],
    ["missing manifest", (candidate: ReturnType<typeof bundle>) =>
      rmSync(join(candidate.directory, "manifest.json"))],
    ["missing snapshot", (candidate: ReturnType<typeof bundle>) =>
      rmSync(candidate.snapshot)],
    ["extra bundle file", (candidate: ReturnType<typeof bundle>) =>
      writeFileSync(join(candidate.directory, "notes.txt"), "private notes")],
  ])("rejects bundles with %s", async (_name, damage) => {
    const candidate = bundle();
    damage(candidate);
    await invalidBackup(repository().verify(candidate.directory));
  });

  it.skipIf(!supportsFileSymlinks)("rejects a symlinked snapshot without following it", async () => {
    const candidate = bundle();
    const target = healthySnapshot();
    rmSync(candidate.snapshot);
    symlinkSync(target, candidate.snapshot, "file");

    await invalidBackup(repository().verify(candidate.directory));
  });

  it.skipIf(!supportsFileSymlinks)("rejects a symlinked manifest without following it", async () => {
    const candidate = bundle();
    const target = join(temporary().directory, "manifest.json");
    writeFileSync(target, JSON.stringify(candidate.manifest));
    rmSync(join(candidate.directory, "manifest.json"));
    symlinkSync(target, join(candidate.directory, "manifest.json"), "file");

    await invalidBackup(repository().verify(candidate.directory));
  });

  it("rejects a portable directory link used as the bundle path", async () => {
    const candidate = bundle();
    const linkedPath = join(temporary().directory, "linked.intentarc-backup");
    createDirectoryLink(candidate.directory, linkedPath);

    await invalidBackup(repository().verify(linkedPath));
  });

  it.each([
    ["snapshot", (candidate: ReturnType<typeof bundle>) => {
      rmSync(candidate.snapshot);
      createDirectoryLink(temporary().directory, candidate.snapshot);
    }],
    ["manifest", (candidate: ReturnType<typeof bundle>) => {
      const manifestPath = join(candidate.directory, "manifest.json");
      rmSync(manifestPath);
      createDirectoryLink(temporary().directory, manifestPath);
    }],
  ])("rejects a portable directory link at the %s path", async (_name, replace) => {
    const candidate = bundle();
    replace(candidate);

    await invalidBackup(repository().verify(candidate.directory));
  });

  it("rejects an unsupported manifest format", async () => {
    const candidate = bundle({ manifest: { formatVersion: 2 } as never });

    await invalidBackup(repository().verify(candidate.directory));
  });

  it("requires version-three internal store metadata to match the manifest", async () => {
    const candidate = bundle({ manifest: { schemaVersion: 3 } });
    const report: IntegrityReport = {
      level: "full",
      passed: true,
      checkedAt: createdAt,
      storeId: "other-store",
      schemaVersion: 3,
      issues: [],
    };
    const checker: IntegrityChecker = {
      checkPath: () => report,
      checkConnection: () => report,
    };

    await invalidBackup(createBundleRepository(checker).verify(candidate.directory));
  });

  it("lists completed manifests newest first without verifying candidates", async () => {
    const root = temporary().directory;
    const newer = bundle({
      directoryName: "newer.intentarc-backup",
      manifest: { createdAt: "2026-07-28T12:00:00.000Z", backupId: "newer" },
    });
    const older = bundle({
      directoryName: "older.intentarc-backup",
      manifest: { createdAt: "2026-07-26T12:00:00.000Z", backupId: "older" },
    });
    cpSync(newer.directory, join(root, "newer.intentarc-backup"), { recursive: true });
    cpSync(older.directory, join(root, "older.intentarc-backup"), { recursive: true });
    mkdirSync(join(root, ".interrupted.intentarc-tmp"));
    mkdirSync(join(root, "capture.intentarc-diagnostic"));

    const checker: IntegrityChecker = {
      checkPath: () => { throw new Error("listing must not inspect SQLite"); },
      checkConnection: () => { throw new Error("listing must not inspect SQLite"); },
    };

    await expect(createBundleRepository(checker).list(root)).resolves.toEqual([
      {
        manifest: expect.objectContaining({ backupId: "newer" }),
        bundlePath: join(root, "newer.intentarc-backup"),
        verificationStatus: "not_checked",
      },
      {
        manifest: expect.objectContaining({ backupId: "older" }),
        bundlePath: join(root, "older.intentarc-backup"),
        verificationStatus: "not_checked",
      },
    ]);
  });

  it("returns an empty listing only when the root is missing", async () => {
    const missingRoot = join(temporary().directory, "missing");
    await expect(repository().list(missingRoot)).resolves.toEqual([]);

    const fileRoot = join(temporary().directory, "not-a-directory");
    writeFileSync(fileRoot, "not a backup root");
    await invalidBackup(repository().list(fileRoot));
  });
});
