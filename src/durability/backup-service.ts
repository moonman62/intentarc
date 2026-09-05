import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { IntentArcDatabase } from "../storage/database.js";
import { formatVersion, packageVersion } from "../system/version.js";
import {
  allocateBundlePaths,
  defaultBackupRoot,
  type BundleRepository,
} from "./bundles.js";
import { DurabilityError } from "./errors.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";
import type { IntegrityChecker } from "./integrity.js";
import type { LeaseManager } from "./leases.js";
import {
  backupManifestSchema,
  createBackupInputSchema,
  integrityIssueCodeSchema,
  type BackupSummary,
  type CreateBackupInput,
  type IntegrityReport,
} from "./model.js";

export interface BackupService {
  create(input: CreateBackupInput): Promise<BackupSummary>;
  createFromConnection(
    database: IntentArcDatabase,
    input: CreateBackupInput & { storeId: string },
  ): Promise<BackupSummary>;
}

export interface BackupServiceOptions {
  checker: IntegrityChecker;
  repository: BundleRepository;
  leaseManager: LeaseManager;
  applicationVersion?: string;
  now?: () => string;
  newId?: () => string;
  beforePublicationIdentityCapture?: (
    reservationPath: string,
  ) => void | Promise<void>;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ["ENOENT", "ENOTDIR"].includes(
    String((error as { code?: unknown }).code),
  );

const destinationInvalid = (): never => {
  throw new DurabilityError("backup_destination_invalid");
};

const assertDestinationAvailable = async (path: string): Promise<void> => {
  try {
    await lstat(path);
    destinationInvalid();
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
};

const containsCompletedBundle = (path: string): boolean => {
  let candidate = path;
  while (true) {
    if (basename(candidate).toLowerCase().endsWith(".intentarc-backup")) {
      return true;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
};

const canonicalizeSourcePath = async (path: string): Promise<string> => {
  try {
    return await realpath(resolve(path));
  } catch {
    throw new DurabilityError("backup_failed");
  }
};

const canonicalizePotentialOutputPath = async (
  path: string,
): Promise<string> => {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) destinationInvalid();
      const parent = dirname(candidate);
      if (parent === candidate) destinationInvalid();
      missingSegments.push(basename(candidate));
      candidate = parent;
      continue;
    }

    try {
      const canonicalAncestor = await realpath(candidate);
      return resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch {
      return destinationInvalid();
    }
  }
};

const assertSafeOutputRoot = async (
  databasePath: string,
  outputRoot: string,
): Promise<void> => {
  const lexicalSource = resolve(databasePath);
  const lexicalOutput = resolve(outputRoot);
  const protectedSuffixes = [
    "",
    "-wal",
    "-shm",
    "-journal",
    ".intentarc-lock",
  ] as const;
  const lexicalProtected = protectedSuffixes.map(
    (suffix) => `${lexicalSource}${suffix}`,
  );
  const comparablePath = (path: string): string =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const samePath = (left: string, right: string): boolean =>
    comparablePath(left) === comparablePath(right);
  const isWithinOrEqual = (root: string, candidate: string): boolean => {
    const fromRoot = relative(
      comparablePath(root),
      comparablePath(candidate),
    );
    return fromRoot === "" ||
      (
        fromRoot !== ".." &&
        !fromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(fromRoot)
      );
  };
  if (
    lexicalProtected.some((path) => samePath(lexicalOutput, path)) ||
    isWithinOrEqual(
      `${lexicalSource}.intentarc-lock`,
      lexicalOutput,
    ) ||
    containsCompletedBundle(lexicalOutput)
  ) {
    destinationInvalid();
  }

  const [canonicalSource, canonicalOutput] = await Promise.all([
    canonicalizeSourcePath(lexicalSource),
    canonicalizePotentialOutputPath(lexicalOutput),
  ]);
  const canonicalProtected = protectedSuffixes.map(
    (suffix) => `${canonicalSource}${suffix}`,
  );
  if (
    canonicalProtected.some((path) => samePath(canonicalOutput, path)) ||
    isWithinOrEqual(
      `${canonicalSource}.intentarc-lock`,
      canonicalOutput,
    ) ||
    containsCompletedBundle(canonicalOutput)
  ) {
    destinationInvalid();
  }

  const outputIdentity = await (async (): Promise<FileIdentity | undefined> => {
    try {
      return await captureIdentity(lexicalOutput);
    } catch (error) {
      if (isMissing(error)) return undefined;
      return destinationInvalid();
    }
  })();
  if (outputIdentity === undefined) return;

  for (const protectedPath of [
    ...lexicalProtected,
    ...canonicalProtected,
  ]) {
    try {
      if (
        identityMatches(
          outputIdentity,
          await captureIdentity(protectedPath),
        )
      ) {
        destinationInvalid();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
};

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

const captureIdentity = async (path: string): Promise<FileIdentity> => {
  const entry = await lstat(path, { bigint: true });
  return { device: entry.dev, inode: entry.ino };
};

const identityMatches = (
  left: FileIdentity,
  right: FileIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const removeOwnedDirectory = async (
  path: string,
  identity: FileIdentity,
): Promise<void> => {
  try {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isDirectory() ||
      !identityMatches(identity, { device: current.dev, inode: current.ino })
    ) {
      return;
    }
    await rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup is fail-safe: unknown or replaced paths are retained.
  }
};

const removeOwnedFile = async (
  path: string,
  identity: FileIdentity,
): Promise<void> => {
  try {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      !identityMatches(identity, { device: current.dev, inode: current.ino })
    ) {
      return;
    }
    await rm(path, { force: true });
  } catch {
    // Cleanup is fail-safe: unknown or replaced paths are retained.
  }
};

const publicationReservationPath = (finalDirectory: string): string =>
  resolve(
    dirname(finalDirectory),
    `.${basename(finalDirectory)}.intentarc-publish-lock`,
  );

const acquirePublicationReservation = async (
  finalDirectory: string,
  backupId: string,
  beforeIdentityCapture: (path: string) => void | Promise<void>,
): Promise<{ path: string; identity: FileIdentity }> => {
  const path = publicationReservationPath(finalDirectory);
  let createdFile: Awaited<ReturnType<typeof open>> | undefined;
  let identity: FileIdentity | undefined;
  try {
    createdFile = await open(path, "wx");
    await createdFile.writeFile(backupId, { encoding: "utf8" });
    await beforeIdentityCapture(path);
    const created = await createdFile.stat({ bigint: true });
    if (!created.isFile()) destinationInvalid();
    identity = { device: created.dev, inode: created.ino };
    if (!identityMatches(identity, await captureIdentity(path))) {
      destinationInvalid();
    }
    await createdFile.close();
    createdFile = undefined;
    return { path, identity };
  } catch (error) {
    if (createdFile !== undefined) {
      if (identity === undefined) {
        try {
          const created = await createdFile.stat({ bigint: true });
          if (created.isFile()) {
            identity = { device: created.dev, inode: created.ino };
          }
        } catch {
          // Without creator-handle identity, cleanup cannot prove ownership.
        }
      }
      try {
        await createdFile.close();
      } catch {
        // Cleanup below remains identity-checked and best effort.
      }
      createdFile = undefined;
    }
    if (identity !== undefined) {
      await removeOwnedFile(path, identity);
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      destinationInvalid();
    }
    throw error;
  }
};

const hashSnapshot = async (
  snapshotPath: string,
): Promise<{ byteSize: number; sha256: string }> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(snapshotPath)) {
    hash.update(chunk);
  }
  const snapshot = await stat(snapshotPath);
  return { byteSize: snapshot.size, sha256: hash.digest("hex") };
};

const removeEmptySnapshotSidecars = async (
  snapshotPath: string,
): Promise<void> => {
  const walPath = `${snapshotPath}-wal`;
  try {
    const wal = await stat(walPath);
    if (wal.size !== 0) throw new DurabilityError("backup_failed");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rm(walPath, { force: true });
  await rm(`${snapshotPath}-shm`, { force: true });
};

const writeManifestExclusively = async (
  manifestPath: string,
  manifest: unknown,
): Promise<void> => {
  await writeFile(manifestPath, JSON.stringify(manifest), {
    encoding: "utf8",
    flag: "wx",
  });
};

const requireHealthySource = (
  checker: IntegrityChecker,
  database: IntentArcDatabase,
): IntegrityReport => {
  const report = checker.checkConnection(database, "full");
  if (!report.passed) {
    throw new DurabilityError("integrity_failed", {
      issueCodes: integrityIssueCodeSchema.array().parse(
        report.issues.map(({ code }) => code),
      ),
    });
  }
  return report;
};

export const createBackupService = (
  options: BackupServiceOptions,
): BackupService => {
  const {
    checker,
    repository,
    leaseManager,
    applicationVersion = formatVersion(packageVersion),
    now = () => new Date().toISOString(),
    newId = randomUUID,
    beforePublicationIdentityCapture = () => {},
  } = options;

  const createCheckedBundle = async (
    database: IntentArcDatabase,
    input: CreateBackupInput & { storeId: string },
    sourceReport?: IntegrityReport,
  ): Promise<BackupSummary> => {
    const parsedInputResult = createBackupInputSchema.safeParse({
      databasePath: input.databasePath,
      outputRoot: input.outputRoot,
      reason: input.reason,
    });
    if (!parsedInputResult.success) return destinationInvalid();
    const rawInput = parsedInputResult.data;
    const canonicalSource = await canonicalizeSourcePath(
      rawInput.databasePath,
    );
    const root = rawInput.outputRoot ??
      defaultBackupRoot(canonicalSource);
    await assertSafeOutputRoot(rawInput.databasePath, root);
    const parsedInput = {
      ...rawInput,
      databasePath: canonicalDatabasePath(rawInput.databasePath),
    };

    const report = sourceReport ?? requireHealthySource(checker, database);
    if (!report.passed) {
      throw new DurabilityError("integrity_failed", {
        issueCodes: integrityIssueCodeSchema.array().parse(
          report.issues.map(({ code }) => code),
        ),
      });
    }

    const backupId = newId();
    const createdAt = now();
    const paths = allocateBundlePaths({
      root,
      createdAt,
      reason: parsedInput.reason,
      backupId,
    });
    let finalized = false;
    let temporaryIdentity: FileIdentity | undefined;
    let reservation:
      | { path: string; identity: FileIdentity }
      | undefined;

    try {
      await assertDestinationAvailable(paths.finalDirectory);
      await mkdir(root, { recursive: true });
      reservation = await acquirePublicationReservation(
        paths.finalDirectory,
        backupId,
        beforePublicationIdentityCapture,
      );
      await assertDestinationAvailable(paths.finalDirectory);
      await mkdir(paths.temporaryDirectory);
      temporaryIdentity = await captureIdentity(paths.temporaryDirectory);
      await database.backup(paths.snapshotPath);

      const snapshotReport = checker.checkPath(paths.snapshotPath, "full");
      if (!snapshotReport.passed) {
        throw new DurabilityError("backup_failed", {
          issueCodes: integrityIssueCodeSchema.array().parse(
            snapshotReport.issues.map(({ code }) => code),
          ),
        });
      }
      if (snapshotReport.schemaVersion === null) {
        throw new DurabilityError("backup_failed");
      }

      await removeEmptySnapshotSidecars(paths.snapshotPath);
      const { byteSize, sha256 } = await hashSnapshot(paths.snapshotPath);
      const backupManifest = backupManifestSchema.parse({
        formatVersion: 1,
        backupId,
        createdAt,
        reason: parsedInput.reason,
        storeId: input.storeId,
        schemaVersion: snapshotReport.schemaVersion,
        applicationVersion,
        byteSize,
        sha256,
      });
      await writeManifestExclusively(paths.manifestPath, backupManifest);
      await repository.verify(paths.temporaryDirectory);
      await removeEmptySnapshotSidecars(paths.snapshotPath);
      await assertDestinationAvailable(paths.finalDirectory);
      // Node has no portable no-replace directory rename. Cooperating writers
      // honor the exclusive root-scoped reservation held across this rename;
      // the immediate existence check fails closed for a raced final target.
      await rename(paths.temporaryDirectory, paths.finalDirectory);
      finalized = true;

      return {
        manifest: backupManifest,
        bundlePath: paths.finalDirectory,
        verificationStatus: "verified",
      };
    } catch (error) {
      if (error instanceof DurabilityError) throw error;
      throw new DurabilityError("backup_failed");
    } finally {
      if (temporaryIdentity !== undefined && !finalized) {
        await removeOwnedDirectory(paths.temporaryDirectory, temporaryIdentity);
      }
      if (reservation !== undefined) {
        await removeOwnedFile(reservation.path, reservation.identity);
      }
    }
  };

  const normalizePublicFailure = (error: unknown): never => {
    if (
      error instanceof DurabilityError &&
      (
        error.code === "integrity_failed" ||
        error.code === "backup_failed" ||
        error.code === "backup_destination_invalid" ||
        error.code === "maintenance_conflict"
      )
    ) {
      throw error;
    }
    throw new DurabilityError("backup_failed");
  };

  return {
    async create(input) {
      try {
        const parsedInputResult = createBackupInputSchema.safeParse(input);
        if (!parsedInputResult.success) return destinationInvalid();
        const parsedInput = parsedInputResult.data;
        const canonicalSource = await canonicalizeSourcePath(
          parsedInput.databasePath,
        );
        const root = parsedInput.outputRoot ??
          defaultBackupRoot(canonicalSource);
        await assertSafeOutputRoot(parsedInput.databasePath, root);

        const databasePath = canonicalDatabasePath(
          parsedInput.databasePath,
        );
        const lease = leaseManager.acquireActive(databasePath);
        let database: IntentArcDatabase | undefined;
        try {
          database = new Database(canonicalDatabasePath(databasePath), {
            readonly: true,
            fileMustExist: true,
          });
          const report = requireHealthySource(checker, database);
          if (report.storeId === null) {
            throw new DurabilityError("integrity_failed", {
              issueCodes: integrityIssueCodeSchema.array().parse(
                report.issues.map(({ code }) => code),
              ),
            });
          }
          return await createCheckedBundle(
            database,
            {
              ...input,
              databasePath,
              storeId: report.storeId,
            },
            report,
          );
        } finally {
          database?.close();
          lease.release();
        }
      } catch (error) {
        return normalizePublicFailure(error);
      }
    },

    async createFromConnection(database, input) {
      try {
        return await createCheckedBundle(database, input);
      } catch (error) {
        return normalizePublicFailure(error);
      }
    },
  };
};
