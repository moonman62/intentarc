import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type RepositorySourceSnapshot = {
  readonly status: string;
  readonly head: string;
  readonly indexHash: string;
  readonly tracked: readonly { path: string; sha256: string | null }[];
};

const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const regularFileHash = (root: string, repositoryPath: string): string | null => {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, repositoryPath);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Git returned an unsafe repository snapshot path.");
  }
  try {
    const stats = lstatSync(absolutePath);
    return stats.isFile() ? sha256(readFileSync(absolutePath)) : null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) return null;
    throw error;
  }
};

const git = (root: string, arguments_: readonly string[]): string =>
  execFileSync("git", [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-C",
    root,
    ...arguments_,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    windowsHide: true,
  });

export const captureRepositorySource = (
  root: string,
): RepositorySourceSnapshot => {
  const indexPath = resolve(
    root,
    git(root, ["rev-parse", "--git-path", "index"]).trim(),
  );
  const sourcePaths = [...new Set(
    git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean),
  )].sort();
  return {
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    indexHash: sha256(readFileSync(indexPath)),
    tracked: sourcePaths.map((path) => ({
      path: path.replaceAll("\\", "/"),
      sha256: regularFileHash(root, path),
    })),
  };
};

export const assertRepositorySourceUnchanged = (
  root: string,
  before: RepositorySourceSnapshot,
): void => {
  const after = captureRepositorySource(root);
  if (!isDeepStrictEqual(after, before)) {
    throw new Error(
      "Repository or Git state changed during a read-only operation.",
      { cause: { before, after } },
    );
  }
};

export const withReadOnlyRepositorySource = <Result>(
  root: string,
  before: RepositorySourceSnapshot,
  operation: () => Result,
): Result => {
  try {
    return operation();
  } finally {
    assertRepositorySourceUnchanged(root, before);
  }
};

export const withReadOnlyRepositorySourceAsync = async <Result>(
  root: string,
  before: RepositorySourceSnapshot,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } finally {
    assertRepositorySourceUnchanged(root, before);
  }
};
