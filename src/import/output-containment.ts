import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { RepositoryImportError } from "./errors.js";

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const isMissing = (error: unknown): boolean =>
  hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");

const comparisonPath = (path: string): string => {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isAtOrBelow = (root: string, candidate: string): boolean => {
  const fromRoot = relative(comparisonPath(root), comparisonPath(candidate));
  return fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

const safePath = (path: string): string => resolve(path).replaceAll("\\", "/");

const cannotProveOutside = (outputPath: string): never => {
  throw new RepositoryImportError("path_escape", {
    path: safePath(outputPath),
  });
};

const canonicalizeThroughNearestExistingAncestor = (
  inputPath: string,
): string => {
  let candidate = resolve(inputPath);
  const missingSegments: string[] = [];

  while (true) {
    let status;
    try {
      status = lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) return cannotProveOutside(inputPath);
      const parent = dirname(candidate);
      if (parent === candidate) return cannotProveOutside(inputPath);
      missingSegments.push(basename(candidate));
      candidate = parent;
      continue;
    }

    if (missingSegments.length > 0 && !status.isDirectory()) {
      return cannotProveOutside(inputPath);
    }
    try {
      return resolve(
        realpathSync.native(candidate),
        ...missingSegments.reverse(),
      );
    } catch {
      return cannotProveOutside(inputPath);
    }
  }
};

export const assertOutputOutsideRepository = (
  repositoryRoot: string,
  outputPath: string,
): void => {
  const lexicalRoot = resolve(repositoryRoot);
  const lexicalOutput = resolve(outputPath);
  const canonicalRoot = canonicalizeThroughNearestExistingAncestor(
    repositoryRoot,
  );
  const canonicalOutput = canonicalizeThroughNearestExistingAncestor(
    outputPath,
  );

  if (
    isAtOrBelow(lexicalRoot, lexicalOutput) ||
    isAtOrBelow(canonicalRoot, canonicalOutput)
  ) {
    cannotProveOutside(outputPath);
  }
};

export const assertDatabaseOutsideRepository = (
  repositoryRoot: string,
  databasePath: string,
): void => {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
    `${databasePath}.intentarc-lock`,
  ]) {
    assertOutputOutsideRepository(repositoryRoot, path);
  }
};
