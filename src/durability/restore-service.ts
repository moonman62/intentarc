import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { IntentArcDatabase } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import type { BackupService } from "./backup-service.js";
import type { BundleRepository } from "./bundles.js";
import type { DurabilityCoordinator } from "./coordinator.js";
import {
  DurabilityError,
  type DurabilityErrorDetails,
} from "./errors.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";
import type { IntegrityChecker } from "./integrity.js";
import type { LeaseManager } from "./leases.js";
import {
  diagnosticCaptureManifestSchema,
  integrityIssueCodeSchema,
  restoreBackupInputSchema,
  type BackupSummary,
  type IntegrityReport,
  type RestoreBackupInput,
  type RestoreResult,
  type VerifiedBackup,
} from "./model.js";

export interface RestoreService {
  restore(input: RestoreBackupInput): Promise<RestoreResult>;
}

export type RestoreReplacementPhase =
  | "target-moved"
  | "stage-installed"
  | "target-opened"
  | "post-install-checked";

type RenamePath = (from: string, to: string) => Promise<void>;

export interface RestoreServiceOptions {
  readonly repository: BundleRepository;
  readonly backupService: BackupService;
  readonly coordinator: Pick<DurabilityCoordinator, "migrateStagedBackup">;
  readonly checker: IntegrityChecker;
  readonly leaseManager: LeaseManager;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly afterPhase?: (phase: RestoreReplacementPhase) => void;
  readonly renamePath?: RenamePath;
}

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

type OriginalFile = {
  readonly activePath: string;
  readonly storageName: string;
  readonly identity: FileIdentity;
  movedTo?: string;
};

type OwnedDirectory = {
  readonly path: string;
  readonly identity: FileIdentity;
};

type StagedSource = {
  readonly id: string;
  readonly path: string;
  readonly identity: FileIdentity;
  readonly verified: VerifiedBackup;
  readonly report: IntegrityReport & { passed: true };
};

type RestorePaths = {
  readonly stage: string;
  readonly inspectionDirectory: string;
  readonly rollbackDirectory: string;
  readonly failedDirectory: string;
  readonly diagnosticDirectory: string;
};

const currentSchemaVersion = migrations.at(-1)!.version;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const sourceSnapshotName = "database.sqlite";
const diagnosticManifestName = "manifest.json";

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const isMissing = (error: unknown): boolean =>
  hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");

const identityFor = (
  entry: { readonly dev: bigint; readonly ino: bigint },
): FileIdentity => ({ device: entry.dev, inode: entry.ino });

const sameIdentity = (
  left: FileIdentity,
  right: FileIdentity,
): boolean =>
  left.device === right.device &&
  left.inode === right.inode;

const pathIdentity = async (
  path: string,
  expected: "file" | "directory",
): Promise<FileIdentity> => {
  const entry = await lstat(path, { bigint: true });
  if (
    entry.isSymbolicLink() ||
    (expected === "file" ? !entry.isFile() : !entry.isDirectory())
  ) {
    throw new DurabilityError("restore_failed");
  }
  return identityFor(entry);
};

const optionalFileIdentity = async (
  path: string,
): Promise<FileIdentity | undefined> => {
  try {
    return await pathIdentity(path, "file");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const pathHasIdentity = async (
  path: string,
  identity: FileIdentity,
  expected: "file" | "directory" = "file",
): Promise<boolean> => {
  try {
    return sameIdentity(await pathIdentity(path, expected), identity);
  } catch {
    return false;
  }
};

const pathIsMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isMissing(error);
  }
};

const removeOwnedFile = async (
  path: string,
  identity: FileIdentity,
): Promise<void> => {
  try {
    if (await pathHasIdentity(path, identity)) {
      await rm(path);
    }
  } catch {
    // Unknown or replaced paths are retained rather than followed.
  }
};

const removeOwnedDirectory = async (
  directory: OwnedDirectory,
): Promise<void> => {
  try {
    if (await pathHasIdentity(
      directory.path,
      directory.identity,
      "directory",
    )) {
      await rm(directory.path, { recursive: true });
    }
  } catch {
    // Cleanup is fail-safe. A path whose identity changed is retained.
  }
};

const createOwnedDirectory = async (
  path: string,
): Promise<OwnedDirectory> => {
  await mkdir(path);
  return {
    path,
    identity: await pathIdentity(path, "directory"),
  };
};

const nextSafeId = (newId: () => string): string => {
  const value = newId();
  if (!safeIdPattern.test(value)) {
    throw new DurabilityError("restore_failed");
  }
  return value;
};

const allocateRestorePaths = (
  targetPath: string,
  operationId: string,
): RestorePaths => {
  const parent = dirname(targetPath);
  const targetName = basename(targetPath);
  return {
    stage: join(
      parent,
      `.${targetName}.${operationId}.intentarc-restore-stage`,
    ),
    inspectionDirectory: join(
      parent,
      `.${targetName}.${operationId}.intentarc-target-inspection`,
    ),
    rollbackDirectory: join(
      parent,
      `.${targetName}.${operationId}.intentarc-rollback`,
    ),
    failedDirectory: join(
      parent,
      `.${targetName}.${operationId}.intentarc-failed`,
    ),
    diagnosticDirectory: join(
      parent,
      `${targetName}.${operationId}.intentarc-diagnostic`,
    ),
  };
};

const canonicalizePotentialPath = async (
  path: string,
): Promise<string> => {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) throw new DurabilityError("restore_failed");
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new DurabilityError("restore_failed");
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
      continue;
    }

    try {
      return resolve(
        await realpath(candidate),
        ...missingSegments.reverse(),
      );
    } catch {
      throw new DurabilityError("restore_failed");
    }
  }
};

const comparablePath = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path;

const isWithinOrEqual = (
  root: string,
  candidate: string,
): boolean => {
  const pathFromRoot = relative(
    comparablePath(root),
    comparablePath(candidate),
  );
  return pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    );
};

const genericIdentity = async (
  path: string,
): Promise<FileIdentity | undefined> => {
  try {
    const entry = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink()) {
      throw new DurabilityError("restore_failed");
    }
    return identityFor(entry);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const assertRestoreBoundary = async (input: {
  readonly verified: VerifiedBackup;
  readonly targetPath: string;
  readonly paths: RestorePaths;
}): Promise<void> => {
  const { verified, targetPath, paths } = input;
  let canonicalBundle: string;
  try {
    canonicalBundle = await realpath(resolve(verified.bundlePath));
  } catch {
    throw new DurabilityError("restore_failed");
  }

  const protectedIdentities = await Promise.all([
    genericIdentity(verified.bundlePath),
    genericIdentity(verified.snapshotPath),
    genericIdentity(join(verified.bundlePath, diagnosticManifestName)),
  ]);

  for (const candidate of [
    targetPath,
    paths.stage,
    paths.inspectionDirectory,
    paths.rollbackDirectory,
    paths.failedDirectory,
    paths.diagnosticDirectory,
  ]) {
    const canonicalCandidate = await canonicalizePotentialPath(candidate);
    if (isWithinOrEqual(canonicalBundle, canonicalCandidate)) {
      throw new DurabilityError("restore_failed");
    }

    const candidateIdentity = await genericIdentity(candidate);
    if (
      candidateIdentity !== undefined &&
      protectedIdentities.some((protectedIdentity) =>
        protectedIdentity !== undefined &&
        sameIdentity(candidateIdentity, protectedIdentity)
      )
    ) {
      throw new DurabilityError("restore_failed");
    }
  }
};

const canonicalIssueCodes = (
  report: IntegrityReport,
  failureCode: "backup_invalid" | "restore_failed",
): ReturnType<typeof integrityIssueCodeSchema.array>["_output"] => {
  const parsed = integrityIssueCodeSchema.array().safeParse(
    report.issues.map(({ code }) => code),
  );
  if (!parsed.success) throw new DurabilityError(failureCode);
  return parsed.data;
};

const failedIntegrity = (
  report: IntegrityReport,
): never => {
  throw new DurabilityError("integrity_failed", {
    issueCodes: canonicalIssueCodes(report, "backup_invalid"),
  });
};

const hashFile = async (
  path: string,
): Promise<{ readonly byteSize: number; readonly sha256: string }> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  const entry = await lstat(path);
  return { byteSize: entry.size, sha256: hash.digest("hex") };
};

const assertVerifiedSourceLayout = async (
  verified: VerifiedBackup,
): Promise<void> => {
  const expectedSnapshot = resolve(verified.bundlePath, sourceSnapshotName);
  if (
    resolve(verified.snapshotPath).toLowerCase() !==
      expectedSnapshot.toLowerCase()
  ) {
    throw new DurabilityError("backup_invalid");
  }

  try {
    const bundle = await lstat(verified.bundlePath);
    const snapshot = await lstat(verified.snapshotPath);
    if (
      !bundle.isDirectory() ||
      bundle.isSymbolicLink() ||
      !snapshot.isFile() ||
      snapshot.isSymbolicLink()
    ) {
      throw new DurabilityError("backup_invalid");
    }
  } catch (error) {
    if (error instanceof DurabilityError) throw error;
    throw new DurabilityError("backup_invalid");
  }
};

const removeEmptyStageSidecars = async (
  stagePath: string,
): Promise<void> => {
  const walPath = `${stagePath}-wal`;
  let wal;
  try {
    wal = await lstat(walPath, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw new DurabilityError("backup_invalid");
  }
  if (wal !== undefined) {
    if (
      wal.isSymbolicLink() ||
      !wal.isFile() ||
      wal.size !== 0n
    ) {
      throw new DurabilityError("backup_invalid");
    }
    await removeOwnedFile(walPath, identityFor(wal));
  }

  const sharedMemoryPath = `${stagePath}-shm`;
  let sharedMemory;
  try {
    sharedMemory = await lstat(sharedMemoryPath, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw new DurabilityError("backup_invalid");
  }
  if (sharedMemory !== undefined) {
    if (
      sharedMemory.isSymbolicLink() ||
      !sharedMemory.isFile()
    ) {
      throw new DurabilityError("backup_invalid");
    }
    await removeOwnedFile(
      sharedMemoryPath,
      identityFor(sharedMemory),
    );
  }
};

const stageSource = async (input: {
  readonly id: string;
  readonly path: string;
  readonly verified: VerifiedBackup;
  readonly coordinator: Pick<DurabilityCoordinator, "migrateStagedBackup">;
  readonly checker: IntegrityChecker;
}): Promise<StagedSource> => {
  const {
    id,
    path,
    verified,
    coordinator,
    checker,
  } = input;
  const parent = dirname(path);
  const parentEntry = await lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new DurabilityError("restore_failed");
  }
  let identity: FileIdentity | undefined;

  try {
    try {
      await copyFile(
        verified.snapshotPath,
        path,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (isMissing(error)) throw new DurabilityError("backup_invalid");
      throw new DurabilityError("restore_failed");
    }
    identity = await pathIdentity(path, "file");

    const copied = await hashFile(path);
    if (
      copied.byteSize !== verified.manifest.byteSize ||
      copied.sha256 !== verified.manifest.sha256
    ) {
      throw new DurabilityError("backup_invalid");
    }

    try {
      coordinator.migrateStagedBackup({
        databasePath: path,
        storeId: verified.manifest.storeId,
      });
    } catch (error) {
      if (
        error instanceof DurabilityError &&
        error.code === "integrity_failed"
      ) {
        throw error;
      }
      throw new DurabilityError("backup_invalid");
    }

    const report = checker.checkPath(path, "full");
    if (!report.passed) failedIntegrity(report);
    if (
      report.level !== "full" ||
      report.schemaVersion !== currentSchemaVersion ||
      report.storeId !== verified.manifest.storeId
    ) {
      throw new DurabilityError("backup_invalid");
    }

    await removeEmptyStageSidecars(path);
    identity = await pathIdentity(path, "file");
    return {
      id,
      path,
      identity,
      verified,
      report: { ...report, passed: true },
    };
  } catch (error) {
    if (identity !== undefined) await removeOwnedFile(path, identity);
    throw error;
  }
};

const originalPaths = (targetPath: string): readonly {
  readonly activePath: string;
  readonly storageName: string;
}[] => [
  { activePath: targetPath, storageName: "database.sqlite" },
  { activePath: `${targetPath}-wal`, storageName: "database.sqlite-wal" },
  { activePath: `${targetPath}-shm`, storageName: "database.sqlite-shm" },
];

const inspectOriginalFiles = async (
  targetPath: string,
): Promise<OriginalFile[]> => {
  const files: OriginalFile[] = [];
  for (const candidate of originalPaths(targetPath)) {
    const identity = await optionalFileIdentity(candidate.activePath);
    if (identity !== undefined) {
      files.push({ ...candidate, identity });
    }
  }
  return files;
};

const sameOriginalSet = (
  left: readonly OriginalFile[],
  right: readonly OriginalFile[],
): boolean =>
  left.length === right.length &&
  left.every((original) => {
    const current = originalForPath(right, original.activePath);
    return current !== undefined &&
      sameIdentity(original.identity, current.identity);
  });

const createTargetInspectionCopy = async (input: {
  readonly directoryPath: string;
  readonly originals: readonly OriginalFile[];
}): Promise<{
  readonly directory: OwnedDirectory;
  readonly databasePath: string;
}> => {
  const { directoryPath, originals } = input;
  const directory = await createOwnedDirectory(directoryPath);

  try {
    for (const original of originals) {
      if (!await pathHasIdentity(original.activePath, original.identity)) {
        throw new DurabilityError("restore_failed");
      }
      const destination = join(directory.path, original.storageName);
      await copyFile(
        original.activePath,
        destination,
        constants.COPYFILE_EXCL,
      );
      await pathIdentity(destination, "file");
      if (!await pathHasIdentity(original.activePath, original.identity)) {
        throw new DurabilityError("restore_failed");
      }
    }
    return {
      directory,
      databasePath: join(directory.path, "database.sqlite"),
    };
  } catch (error) {
    await removeOwnedDirectory(directory);
    throw error;
  }
};

const originalForPath = (
  originals: readonly OriginalFile[],
  path: string,
): OriginalFile | undefined =>
  originals.find(({ activePath }) => activePath === path);

const moveOriginal = async (
  original: OriginalFile,
  destination: string,
  renamePath: RenamePath,
): Promise<void> => {
  if (!await pathHasIdentity(original.activePath, original.identity)) {
    throw new DurabilityError("restore_failed");
  }
  if (!await pathIsMissing(destination)) {
    throw new DurabilityError("restore_failed");
  }

  try {
    await renamePath(original.activePath, destination);
  } catch (error) {
    if (await pathHasIdentity(destination, original.identity)) {
      original.movedTo = destination;
    }
    throw error;
  }
  original.movedTo = destination;
  if (!await pathHasIdentity(destination, original.identity)) {
    throw new DurabilityError("restore_failed");
  }
};

const installStage = async (
  staged: StagedSource,
  targetPath: string,
  renamePath: RenamePath,
): Promise<void> => {
  if (!await pathHasIdentity(staged.path, staged.identity)) {
    throw new DurabilityError("restore_failed");
  }
  if (!await pathIsMissing(targetPath)) {
    throw new DurabilityError("restore_failed");
  }

  try {
    await renamePath(staged.path, targetPath);
  } catch (error) {
    throw error;
  }
  if (!await pathHasIdentity(targetPath, staged.identity)) {
    throw new DurabilityError("restore_failed");
  }
};

const moveFailedReplacementAside = async (input: {
  readonly targetPath: string;
  readonly originals: readonly OriginalFile[];
  readonly failedDirectoryPath: string;
  readonly renamePath: RenamePath;
}): Promise<OwnedDirectory | undefined> => {
  const {
    targetPath,
    originals,
    failedDirectoryPath,
    renamePath,
  } = input;
  const candidates: Array<{
    readonly activePath: string;
    readonly storageName: string;
    readonly identity: FileIdentity;
  }> = [];

  for (const path of originalPaths(targetPath)) {
    const identity = await optionalFileIdentity(path.activePath);
    if (identity === undefined) continue;
    const original = originalForPath(originals, path.activePath);
    if (
      original !== undefined &&
      original.movedTo === undefined &&
      sameIdentity(original.identity, identity)
    ) {
      continue;
    }
    candidates.push({ ...path, identity });
  }
  if (candidates.length === 0) return undefined;

  const directory = await createOwnedDirectory(failedDirectoryPath);
  for (const candidate of candidates) {
    const destination = join(directory.path, candidate.storageName);
    try {
      await renamePath(candidate.activePath, destination);
    } catch (error) {
      if (!await pathHasIdentity(destination, candidate.identity)) {
        throw error;
      }
    }
  }
  return directory;
};

const reinstateOriginals = async (input: {
  readonly targetPath: string;
  readonly originals: OriginalFile[];
  readonly recoveryDirectory?: OwnedDirectory;
  readonly failedDirectoryPath: string;
  readonly renamePath: RenamePath;
}): Promise<boolean> => {
  const {
    targetPath,
    originals,
    recoveryDirectory,
    failedDirectoryPath,
    renamePath,
  } = input;
  let failedDirectory: OwnedDirectory | undefined;
  let successful = true;

  try {
    failedDirectory = await moveFailedReplacementAside({
      targetPath,
      originals,
      failedDirectoryPath,
      renamePath,
    });
  } catch {
    successful = false;
  }

  for (const original of originals) {
    if (original.movedTo === undefined) continue;
    try {
      if (!await pathHasIdentity(original.movedTo, original.identity)) {
        successful = false;
        continue;
      }
      if (!await pathIsMissing(original.activePath)) {
        successful = false;
        continue;
      }
      try {
        await renamePath(original.movedTo, original.activePath);
      } catch {
        if (!await pathHasIdentity(
          original.activePath,
          original.identity,
        )) {
          successful = false;
          continue;
        }
      }
      if (await pathHasIdentity(original.activePath, original.identity)) {
        delete original.movedTo;
      } else {
        successful = false;
      }
    } catch {
      successful = false;
    }
  }

  for (const path of originalPaths(targetPath)) {
    const original = originalForPath(originals, path.activePath);
    if (original === undefined) {
      if (!await pathIsMissing(path.activePath)) successful = false;
    } else if (!await pathHasIdentity(path.activePath, original.identity)) {
      successful = false;
    }
  }

  if (successful && recoveryDirectory !== undefined) {
    await removeOwnedDirectory(recoveryDirectory);
  }
  if (successful && failedDirectory !== undefined) {
    await removeOwnedDirectory(failedDirectory);
  }
  return successful;
};

const preRestoreBackup = async (input: {
  readonly targetPath: string;
  readonly inspectionPath: string;
  readonly targetReport: IntegrityReport;
  readonly backupService: BackupService;
  readonly newId: () => string;
}): Promise<BackupSummary> => {
  const {
    targetPath,
    inspectionPath,
    targetReport,
    backupService,
    newId,
  } = input;
  let database: IntentArcDatabase | undefined;
  try {
    database = new Database(canonicalDatabasePath(inspectionPath), {
      readonly: true,
      fileMustExist: true,
    });
    const storeId = targetReport.storeId ??
      `store-${nextSafeId(newId)}`;
    const backup = await backupService.createFromConnection(database, {
      databasePath: targetPath,
      reason: "pre-restore",
      storeId,
    });
    if (backup.verificationStatus !== "verified") {
      throw new DurabilityError("backup_failed");
    }
    return backup;
  } finally {
    database?.close();
  }
};

const restoreFailureDetails = (input: {
  readonly originalReinstated: boolean;
  readonly preRestoreBackup: BackupSummary | null;
  readonly diagnosticCapture: OwnedDirectory | undefined;
}): DurabilityErrorDetails => {
  const {
    originalReinstated,
    preRestoreBackup: backup,
    diagnosticCapture,
  } = input;
  if (backup !== null) {
    return {
      originalReinstated,
      backupId: backup.manifest.backupId,
      bundlePath: backup.bundlePath,
      recoveryAction: "restore_verified_backup",
    };
  }
  if (!originalReinstated && diagnosticCapture !== undefined) {
    return {
      originalReinstated,
      diagnosticCapturePath: diagnosticCapture.path,
      recoveryAction: "inspect_diagnostic_capture",
    };
  }
  return { originalReinstated };
};

const normalizePublicError = (error: unknown): never => {
  if (
    error instanceof DurabilityError &&
    (
      error.code === "backup_invalid" ||
      error.code === "integrity_failed" ||
      error.code === "backup_failed" ||
      error.code === "backup_destination_invalid" ||
      error.code === "maintenance_conflict" ||
      error.code === "restore_failed" ||
      error.code === "store_identity_mismatch" ||
      error.code === "confirmation_required"
    )
  ) {
    throw error;
  }
  throw new DurabilityError("restore_failed");
};

export const createRestoreService = (
  options: RestoreServiceOptions,
): RestoreService => {
  const {
    repository,
    backupService,
    coordinator,
    checker,
    leaseManager,
    now = () => new Date().toISOString(),
    newId = randomUUID,
    afterPhase = () => {},
    renamePath = rename,
  } = options;

  return {
    async restore(input) {
      const parsed = restoreBackupInputSchema.safeParse(input);
      if (!parsed.success) throw new DurabilityError("restore_failed");
      let staged: StagedSource | undefined;

      try {
        const targetPath = canonicalDatabasePath(
          parsed.data.targetDatabasePath,
        );
        let verified: VerifiedBackup;
        try {
          verified = await repository.verify(parsed.data.bundlePath);
          await removeEmptyStageSidecars(verified.snapshotPath);
          await assertVerifiedSourceLayout(verified);
        } catch (error) {
          if (
            error instanceof DurabilityError &&
            error.code === "backup_invalid"
          ) {
            throw error;
          }
          throw new DurabilityError("backup_invalid");
        }

        if (
          verified.manifest.schemaVersion < 1 ||
          verified.manifest.schemaVersion > currentSchemaVersion ||
          verified.integrity.schemaVersion !==
            verified.manifest.schemaVersion
        ) {
          throw new DurabilityError("backup_invalid");
        }

        const operationId = nextSafeId(newId);
        const restorePaths = allocateRestorePaths(
          targetPath,
          operationId,
        );
        await assertRestoreBoundary({
          verified,
          targetPath,
          paths: restorePaths,
        });
        const stagedSource = await stageSource({
          id: operationId,
          path: restorePaths.stage,
          verified,
          coordinator,
          checker,
        });
        staged = stagedSource;

        const maintenance = leaseManager.acquireMaintenance(targetPath);
        try {
          let originals = await inspectOriginalFiles(targetPath);
          let targetReport: IntegrityReport | null = null;
          let backup: BackupSummary | null = null;

          const evaluateExistingTarget = async (
            candidateOriginals: OriginalFile[],
          ): Promise<{
            readonly originals: OriginalFile[];
            readonly report: IntegrityReport | null;
            readonly backup: BackupSummary | null;
          }> => {
            if (candidateOriginals.length === 0) {
              return {
                originals: candidateOriginals,
                report: null,
                backup: null,
              };
            }
            if (!parsed.data.confirmed) {
              throw new DurabilityError("confirmation_required");
            }

            let evaluatedReport: IntegrityReport;
            let evaluatedBackup: BackupSummary | null = null;
            const inspection = await createTargetInspectionCopy({
              directoryPath: restorePaths.inspectionDirectory,
              originals: candidateOriginals,
            });
            try {
              evaluatedReport = checker.checkPath(
                inspection.databasePath,
                "full",
              );
              if (
                evaluatedReport.storeId === null ||
                evaluatedReport.storeId !==
                  stagedSource.verified.manifest.storeId
              ) {
                if (!parsed.data.allowDifferentStore) {
                  throw new DurabilityError("store_identity_mismatch");
                }
              }

              if (
                evaluatedReport.passed &&
                candidateOriginals.some(({ activePath }) =>
                  activePath === targetPath
                )
              ) {
                evaluatedBackup = await preRestoreBackup({
                  targetPath,
                  inspectionPath: inspection.databasePath,
                  targetReport: evaluatedReport,
                  backupService,
                  newId,
                });
              }
            } finally {
              await removeOwnedDirectory(inspection.directory);
            }

            const currentOriginals = await inspectOriginalFiles(targetPath);
            if (!sameOriginalSet(candidateOriginals, currentOriginals)) {
              throw new DurabilityError("restore_failed");
            }
            return {
              originals: currentOriginals,
              report: evaluatedReport,
              backup: evaluatedBackup,
            };
          };

          let evaluatedTarget = await evaluateExistingTarget(originals);
          originals = evaluatedTarget.originals;
          targetReport = evaluatedTarget.report;
          backup = evaluatedTarget.backup;
          const finalProbe = await inspectOriginalFiles(targetPath);
          if (!sameOriginalSet(originals, finalProbe)) {
            if (originals.length !== 0) {
              throw new DurabilityError("restore_failed");
            }
            evaluatedTarget = await evaluateExistingTarget(finalProbe);
            originals = evaluatedTarget.originals;
            targetReport = evaluatedTarget.report;
            backup = evaluatedTarget.backup;
          }

          const healthyTarget =
            targetReport !== null &&
            targetReport.passed &&
            originals.some(({ activePath }) => activePath === targetPath);
          let recoveryDirectory: OwnedDirectory | undefined;
          let diagnosticCapture: OwnedDirectory | undefined;
          let replacementStarted = false;

          try {
            if (originals.length > 0) {
              if (healthyTarget) {
                recoveryDirectory = await createOwnedDirectory(
                  restorePaths.rollbackDirectory,
                );
              } else {
                diagnosticCapture = await createOwnedDirectory(
                  restorePaths.diagnosticDirectory,
                );
                recoveryDirectory = diagnosticCapture;
              }

              for (const original of originals) {
                await moveOriginal(
                  original,
                  join(recoveryDirectory.path, original.storageName),
                  renamePath,
                );
                replacementStarted = true;
              }

              if (diagnosticCapture !== undefined) {
                if (targetReport === null) {
                  throw new DurabilityError("restore_failed");
                }
                const manifest = diagnosticCaptureManifestSchema.parse({
                  formatVersion: 1,
                  captureId: operationId,
                  createdAt: now(),
                  classification: "unverified_diagnostic",
                  storeId: targetReport.storeId,
                  schemaVersion: targetReport.schemaVersion,
                  issueCodes: canonicalIssueCodes(
                    targetReport,
                    "restore_failed",
                  ),
                  files: originals.map(({ storageName }) => storageName),
                });
                await writeFile(
                  join(diagnosticCapture.path, diagnosticManifestName),
                  JSON.stringify(manifest),
                  { encoding: "utf8", flag: "wx" },
                );
              }
            }

            replacementStarted = true;
            afterPhase("target-moved");
            await installStage(
              stagedSource,
              targetPath,
              renamePath,
            );
            afterPhase("stage-installed");

            let installedDatabase: IntentArcDatabase | undefined;
            try {
              installedDatabase = new Database(
                canonicalDatabasePath(targetPath),
                {
                  readonly: true,
                  fileMustExist: true,
                },
              );
              afterPhase("target-opened");
              const installedReport = checker.checkConnection(
                installedDatabase,
                "full",
              );
              if (
                !installedReport.passed ||
                installedReport.level !== "full" ||
                installedReport.schemaVersion !== currentSchemaVersion ||
                installedReport.storeId !==
                  stagedSource.verified.manifest.storeId
              ) {
                throw new DurabilityError("restore_failed");
              }
              afterPhase("post-install-checked");
            } finally {
              installedDatabase?.close();
            }

            if (
              recoveryDirectory !== undefined &&
              diagnosticCapture === undefined
            ) {
              await removeOwnedDirectory(recoveryDirectory);
            }

            return {
              backupId: stagedSource.verified.manifest.backupId,
              targetDatabasePath: parsed.data.targetDatabasePath,
              storeId: stagedSource.verified.manifest.storeId,
              schemaVersion: currentSchemaVersion,
              preRestoreBackup: backup,
              diagnosticCapturePath: diagnosticCapture?.path ?? null,
            };
          } catch (error) {
            if (
              !replacementStarted &&
              !originals.some(({ movedTo }) => movedTo !== undefined)
            ) {
              if (recoveryDirectory !== undefined) {
                await removeOwnedDirectory(recoveryDirectory);
              }
              throw error;
            }
            const originalReinstated = await reinstateOriginals({
              targetPath,
              originals,
              ...(recoveryDirectory === undefined
                ? {}
                : { recoveryDirectory }),
              failedDirectoryPath: restorePaths.failedDirectory,
              renamePath,
            });
            throw new DurabilityError(
              "restore_failed",
              restoreFailureDetails({
                originalReinstated,
                preRestoreBackup: backup,
                diagnosticCapture,
              }),
            );
          }
        } finally {
          maintenance.release();
        }
      } catch (error) {
        return normalizePublicError(error);
      } finally {
        if (staged !== undefined) {
          await removeOwnedFile(staged.path, staged.identity);
        }
      }
    },
  };
};
