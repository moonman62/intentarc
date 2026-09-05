import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DurabilityError } from "./errors.js";
import type { IntegrityChecker } from "./integrity.js";
import {
  backupManifestSchema,
  backupReasonSchema,
  type BackupReason,
  type BackupSummary,
  type VerifiedBackup,
} from "./model.js";

const snapshotFileName = "database.sqlite";
const manifestFileName = "manifest.json";
const bundleSuffix = ".intentarc-backup";
const requiredBundleFiles = [snapshotFileName, manifestFileName] as const;
const backupIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const parseCreatedAt = (value: string): Date | null => {
  const match = timestampPattern.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const values = [year, month, day, hour, minute, second, offsetHour, offsetMinute]
    .map((part) => part === undefined ? 0 : Number(part));
  const [parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute, parsedSecond,
    parsedOffsetHour, parsedOffsetMinute] = values;
  if (
    parsedYear === undefined || parsedMonth === undefined || parsedDay === undefined ||
    parsedHour === undefined || parsedMinute === undefined || parsedSecond === undefined ||
    parsedOffsetHour === undefined || parsedOffsetMinute === undefined ||
    parsedYear < 1 || parsedMonth < 1 || parsedMonth > 12 || parsedDay < 1 ||
    parsedDay > new Date(Date.UTC(parsedYear, parsedMonth, 0)).getUTCDate() ||
    parsedHour > 23 || parsedMinute > 59 || parsedSecond > 59 ||
    parsedOffsetHour > 23 || parsedOffsetMinute > 59
  ) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export interface BundleRepository {
  verify(bundlePath: string): Promise<VerifiedBackup>;
  list(root: string): Promise<BackupSummary[]>;
}

export interface BundleRepositoryOptions {
  readonly afterPrivateCopy?: (
    privateSnapshotPath: string,
  ) => void | Promise<void>;
}

export const defaultBackupRoot = (databasePath: string): string =>
  `${databasePath}.backups`;

export const allocateBundlePaths = (input: {
  root: string;
  createdAt: string;
  reason: BackupReason;
  backupId: string;
}): {
  temporaryDirectory: string;
  finalDirectory: string;
  snapshotPath: string;
  manifestPath: string;
} => {
  if (
    typeof input.root !== "string" || input.root.trim().length === 0 ||
    typeof input.createdAt !== "string" ||
    typeof input.backupId !== "string" || !backupIdPattern.test(input.backupId)
  ) {
    return backupInvalid();
  }
  const createdAt = parseCreatedAt(input.createdAt);
  const reason = backupReasonSchema.safeParse(input.reason);
  if (createdAt === null || !reason.success) return backupInvalid();

  const root = resolve(input.root);
  const timestamp = createdAt.toISOString().replace(/:/g, "-");
  const name = `${timestamp}-${reason.data}-${input.backupId}`;
  const temporaryDirectory = join(root, `.${name}.intentarc-tmp`);
  const finalDirectory = join(root, `${name}${bundleSuffix}`);
  const isChildOfRoot = (path: string): boolean => {
    const pathFromRoot = relative(root, path);
    return pathFromRoot.length > 0 &&
      !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      pathFromRoot !== ".." && !isAbsolute(pathFromRoot);
  };
  if (!isChildOfRoot(temporaryDirectory) || !isChildOfRoot(finalDirectory)) {
    return backupInvalid();
  }

  return {
    temporaryDirectory,
    finalDirectory,
    snapshotPath: join(temporaryDirectory, snapshotFileName),
    manifestPath: join(temporaryDirectory, manifestFileName),
  };
};

const backupInvalid = (): never => {
  throw new DurabilityError("backup_invalid");
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const hashSnapshot = async (snapshotPath: string): Promise<Buffer> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(snapshotPath)) {
    hash.update(chunk);
  }
  return hash.digest();
};

const readManifest = async (manifestPath: string) => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return backupInvalid();
  }

  try {
    return backupManifestSchema.parse(value);
  } catch {
    return backupInvalid();
  }
};

const verifyBundleLayout = async (bundlePath: string): Promise<{
  snapshotPath: string;
  manifestPath: string;
}> => {
  let bundle;
  let entries;
  try {
    bundle = await lstat(bundlePath);
  } catch {
    return backupInvalid();
  }

  if (!bundle.isDirectory() || bundle.isSymbolicLink()) return backupInvalid();
  try {
    entries = await readdir(bundlePath);
  } catch {
    return backupInvalid();
  }
  const sortedEntries = [...entries].sort();
  if (
    sortedEntries.length !== requiredBundleFiles.length ||
    sortedEntries.some((entry, index) => entry !== requiredBundleFiles[index])
  ) {
    return backupInvalid();
  }

  const snapshotPath = join(bundlePath, snapshotFileName);
  const manifestPath = join(bundlePath, manifestFileName);
  let snapshot;
  let manifest;
  try {
    [snapshot, manifest] = await Promise.all([lstat(snapshotPath), lstat(manifestPath)]);
  } catch {
    return backupInvalid();
  }
  if (
    !snapshot.isFile() || snapshot.isSymbolicLink() ||
    !manifest.isFile() || manifest.isSymbolicLink()
  ) {
    return backupInvalid();
  }

  return { snapshotPath, manifestPath };
};

export const createBundleRepository = (
  checker: IntegrityChecker,
  options: BundleRepositoryOptions = {},
): BundleRepository => ({
  async verify(bundlePath) {
    try {
      const { snapshotPath, manifestPath } = await verifyBundleLayout(bundlePath);
      const manifest = await readManifest(manifestPath);
      const verificationDirectory = await mkdtemp(join(tmpdir(), "intentarc-verify-"));
      let integrity;
      try {
        const verificationSnapshot = join(verificationDirectory, snapshotFileName);
        await copyFile(snapshotPath, verificationSnapshot);
        await options.afterPrivateCopy?.(verificationSnapshot);

        const snapshotSize = await stat(verificationSnapshot);
        if (snapshotSize.size !== manifest.byteSize) return backupInvalid();

        const digest = await hashSnapshot(verificationSnapshot);
        const expectedDigest = Buffer.from(manifest.sha256, "hex");
        if (
          expectedDigest.length !== digest.length ||
          !timingSafeEqual(expectedDigest, digest)
        ) {
          return backupInvalid();
        }

        integrity = checker.checkPath(verificationSnapshot, "full");
      } finally {
        await rm(verificationDirectory, { recursive: true, force: true });
      }
      if (!integrity.passed || integrity.level !== "full") return backupInvalid();
      if (integrity.schemaVersion !== null && integrity.schemaVersion >= 3 &&
        integrity.storeId !== manifest.storeId) {
        return backupInvalid();
      }

      return {
        manifest,
        bundlePath,
        verificationStatus: "verified",
        snapshotPath,
        integrity: { ...integrity, passed: true },
      };
    } catch {
      return backupInvalid();
    }
  },

  async list(root) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (isMissing(error)) return [];
      return backupInvalid();
    }

    const summaries: Array<BackupSummary | null> = await Promise.all(entries.map(async (
      entry,
    ): Promise<BackupSummary | null> => {
      if (!entry.endsWith(bundleSuffix)) return null;
      const bundlePath = join(root, entry);
      const manifestPath = join(bundlePath, manifestFileName);
      try {
        const directory = await lstat(bundlePath);
        const manifest = await lstat(manifestPath);
        if (
          !directory.isDirectory() || directory.isSymbolicLink() ||
          !manifest.isFile() || manifest.isSymbolicLink()
        ) {
          return null;
        }
        const parsed = backupManifestSchema.safeParse(
          JSON.parse(await readFile(manifestPath, "utf8")),
        );
        if (!parsed.success) return null;
        return {
          manifest: parsed.data,
          bundlePath,
          verificationStatus: "not_checked" as const,
        };
      } catch {
        return null;
      }
    }));

    return summaries
      .filter((summary): summary is BackupSummary => summary !== null)
      .sort((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt) ||
        right.manifest.backupId.localeCompare(left.manifest.backupId));
  },
});
