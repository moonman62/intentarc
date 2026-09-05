import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RepositoryImportError } from "./errors.js";

const GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 15_000;

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const normalizeGitPath = (path: string): string => {
  const normalized = normalizePath(path).replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RepositoryImportError("repository_root_invalid", {
      path: "repository",
    });
  }
  return normalized;
};

const safeRootPath = (root: string): string => normalizePath(resolve(root));

const gitArguments = (root: string, arguments_: readonly string[]): string[] => [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-C",
  root,
  ...arguments_,
];

const sanitizedGitEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  ),
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  ...overrides,
});

const runGit = (root: string, arguments_: readonly string[]): string => {
  try {
    return execFileSync("git", gitArguments(root, arguments_), {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch {
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
};

export interface AsyncGitRepositoryDependencies {
  readonly execFile?: typeof execFile;
  readonly removeDirectory?: typeof rmSync;
}

const runGitOptional = (
  root: string,
  arguments_: readonly string[],
  allowedFailureStatuses: readonly number[] = [1],
): string | null => {
  try {
    return execFileSync("git", gitArguments(root, arguments_), {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "status" in error &&
      typeof error.status === "number" && allowedFailureStatuses.includes(error.status)
    ) {
      return null;
    }
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
};

const runGitAsync = (
  root: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies,
  environment: NodeJS.ProcessEnv = sanitizedGitEnvironment(),
): Promise<string> => {
  signal.throwIfAborted();
  const execute = dependencies.execFile ?? execFile;
  return new Promise((resolvePromise, reject) => {
    execute("git", gitArguments(root, arguments_), {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      signal,
    }, (error, stdout) => {
      if (error !== null) {
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          reject(new RepositoryImportError("unsupported_repository", {
            path: safeRootPath(root),
          }));
        }
        return;
      }
      resolvePromise(stdout);
    });
  });
};

const runGitOptionalAsync = (
  root: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies,
  allowedFailureStatuses: readonly number[] = [1],
): Promise<string | null> => {
  signal.throwIfAborted();
  const execute = dependencies.execFile ?? execFile;
  return new Promise((resolvePromise, reject) => {
    execute("git", gitArguments(root, arguments_), {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      signal,
    }, (error, stdout) => {
      if (error === null) return resolvePromise(stdout);
      if (signal.aborted) return reject(signal.reason);
      const exitCode = (error as unknown as { code?: string | number }).code;
      if (typeof exitCode === "number" && allowedFailureStatuses.includes(exitCode)) {
        return resolvePromise(null);
      }
      reject(new RepositoryImportError("unsupported_repository", {
        path: safeRootPath(root),
      }));
    });
  });
};

type GitObjectFormat = "sha1" | "sha256";

const parseObjectFormat = (root: string, output: string | null): GitObjectFormat => {
  const format = output?.trim() || "sha1";
  if (format !== "sha1" && format !== "sha256") {
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
  return format;
};

const readGitObjectFormat = (root: string): GitObjectFormat => parseObjectFormat(
  root,
  runGitOptional(root, ["rev-parse", "--show-object-format=storage"], [1, 128, 129]) ??
    runGitOptional(root, ["rev-parse", "--show-object-format"], [1, 128, 129]),
);

const readGitObjectFormatAsync = async (
  root: string,
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies,
): Promise<GitObjectFormat> => parseObjectFormat(
  root,
  await runGitOptionalAsync(
    root,
    ["rev-parse", "--show-object-format=storage"],
    signal,
    dependencies,
    [1, 128, 129],
  ) ?? await runGitOptionalAsync(
    root,
    ["rev-parse", "--show-object-format"],
    signal,
    dependencies,
    [1, 128, 129],
  ),
);

interface NonExecutingGitView {
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => void;
}

const createNonExecutingGitView = (
  root: string,
  head: string | null,
  branch: string | null,
  objectFormat: GitObjectFormat,
  commonDirectory: string,
  indexPath: string,
  removeDirectory: typeof rmSync = rmSync,
): NonExecutingGitView => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc git metadata "));
  try {
    const sha256Objects = objectFormat === "sha256";
    mkdirSync(join(directory, "objects"));
    mkdirSync(join(directory, "refs"));
    writeFileSync(
      join(directory, "HEAD"),
      head === null ? `ref: refs/heads/${branch ?? "intentarc-unborn"}\n` : `${head}\n`,
      { flag: "wx" },
    );
    writeFileSync(join(directory, "config"), [
      "[core]",
      `repositoryformatversion = ${sha256Objects ? 1 : 0}`,
      "bare = false",
      ...(sha256Objects
        ? ["[extensions]", "objectformat = sha256"]
        : []),
      "",
    ].join("\n"), { flag: "wx" });
    if (indexPath.length === 0) throw new Error("Git index is unavailable.");
    return {
      environment: sanitizedGitEnvironment({
        GIT_DIR: directory,
        GIT_INDEX_FILE: indexPath,
        GIT_OBJECT_DIRECTORY: join(commonDirectory, "objects"),
        GIT_WORK_TREE: root,
      }),
      cleanup: () => removeDirectory(directory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 4 : 0,
        retryDelay: 50,
      }),
    };
  } catch {
    try {
      removeDirectory(directory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 4 : 0,
        retryDelay: 50,
      });
    } catch {
      // Preserve the sanitized setup failure below.
    }
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
};

const runGitStatus = (
  root: string,
  head: string | null,
  branch: string | null,
  objectFormat: GitObjectFormat,
  commonDirectory: string,
  indexPath: string,
): string => {
  const view = createNonExecutingGitView(
    root,
    head,
    branch,
    objectFormat,
    commonDirectory,
    indexPath,
  );
  let primaryError: unknown;
  try {
    return execFileSync("git", gitArguments(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]), {
      encoding: "utf8",
      env: view.environment,
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch {
    primaryError = new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
    throw primaryError;
  } finally {
    try {
      view.cleanup();
    } catch {
      if (primaryError === undefined) {
        throw new RepositoryImportError("unsupported_repository", {
          path: safeRootPath(root),
        });
      }
    }
  }
};

const runGitStatusAsync = async (
  root: string,
  head: string | null,
  branch: string | null,
  objectFormat: GitObjectFormat,
  commonDirectory: string,
  indexPath: string,
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies,
): Promise<string> => {
  const view = createNonExecutingGitView(
    root,
    head,
    branch,
    objectFormat,
    commonDirectory,
    indexPath,
    dependencies.removeDirectory,
  );
  let primaryError: unknown;
  try {
    return await runGitAsync(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
      ],
      signal,
      dependencies,
      view.environment,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      view.cleanup();
    } catch {
      if (primaryError === undefined) {
        throw new RepositoryImportError("unsupported_repository", {
          path: safeRootPath(root),
        });
      }
    }
  }
};

const splitNulPaths = (output: string): string[] =>
  output
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizeGitPath)
    .sort(compareOrdinal);

export interface GitStatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly path: string;
  readonly originalPath: string | null;
}

export interface GitRepositoryState {
  readonly root: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly entries: readonly GitStatusEntry[];
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly worktreeCount: number;
}

export interface GitRepositoryObservationState extends GitRepositoryState {
  readonly repositoryIdentity: string;
  readonly repositoryFilesystemClaim: GitRepositoryFilesystemClaim;
}

export interface GitRepositoryFilesystemClaim {
  readonly canonicalCommonDirectory: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly repositoryIdentity: string;
}

export interface GitRepositoryIdentity {
  readonly root: string;
  readonly branch: string | null;
  readonly head: string | null;
}

const parseStatus = (output: string): GitStatusEntry[] => {
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length === 0) continue;
    if (field.length < 4 || field[2] !== " ") {
      throw new RepositoryImportError("repository_root_invalid", {
        path: "repository",
      });
    }

    const indexStatus = field[0]!;
    const worktreeStatus = field[1]!;
    const renamed = indexStatus === "R" || indexStatus === "C" ||
      worktreeStatus === "R" || worktreeStatus === "C";
    const originalPath = renamed ? fields[index + 1] : undefined;
    if (renamed) index += 1;

    entries.push({
      index: indexStatus,
      worktree: worktreeStatus,
      path: normalizeGitPath(field.slice(3)),
      originalPath: originalPath === undefined ? null : normalizeGitPath(originalPath),
    });
  }
  return entries.sort((left, right) =>
    compareOrdinal(left.path, right.path) ||
    compareOrdinal(left.originalPath ?? "", right.originalPath ?? ""),
  );
};

const parseWorktreeCount = (output: string): number =>
  output.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length;

const validateRoot = (inputRoot: string): string => {
  const root = resolve(inputRoot);
  if (!existsSync(root)) {
    throw new RepositoryImportError("repository_not_found", {
      path: safeRootPath(root),
    });
  }
  if (!statSync(root).isDirectory()) {
    throw new RepositoryImportError("repository_root_invalid", {
      path: safeRootPath(root),
    });
  }
  return root;
};

const repositoryFilesystemClaim = (
  root: string,
  commonDirectoryOutput: string,
): GitRepositoryFilesystemClaim => {
  try {
    const commonDirectoryPath = commonDirectoryOutput.trim();
    if (commonDirectoryPath.length === 0) {
      throw new Error("Git common directory is unavailable");
    }
    const commonDirectory = normalizePath(realpathSync.native(resolve(
      root,
      commonDirectoryPath,
    )));
    const status = statSync(commonDirectory, { bigint: true });
    if (!status.isDirectory() || status.dev === 0n || status.ino === 0n) {
      throw new Error("Git filesystem identity is unavailable");
    }
    const digest = createHash("sha256")
      .update(`git-common-directory-v1\0${status.dev}\0${status.ino}`)
      .digest("hex");
    return {
      canonicalCommonDirectory: commonDirectory,
      device: status.dev,
      inode: status.ino,
      repositoryIdentity: `git-fs-v1:${digest}`,
    };
  } catch {
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
};

const sameCanonicalPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

export const readGitRepositoryFilesystemClaimAsync = async (
  root: string,
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies = {},
): Promise<GitRepositoryFilesystemClaim> => {
  signal.throwIfAborted();
  const commonDirectoryOutput = await runGitAsync(
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
    dependencies,
  );
  signal.throwIfAborted();
  const claim = repositoryFilesystemClaim(root, commonDirectoryOutput);
  signal.throwIfAborted();
  return claim;
};

export const revalidateGitRepositoryFilesystemClaimAsync = async (
  root: string,
  expected: GitRepositoryFilesystemClaim,
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies = {},
): Promise<void> => {
  const actual = await readGitRepositoryFilesystemClaimAsync(
    root,
    signal,
    dependencies,
  );
  signal.throwIfAborted();
  if (
    !sameCanonicalPath(
      expected.canonicalCommonDirectory,
      actual.canonicalCommonDirectory,
    ) ||
    expected.device === 0n ||
    expected.inode === 0n ||
    actual.device === 0n ||
    actual.inode === 0n ||
    expected.device !== actual.device ||
    expected.inode !== actual.inode
  ) {
    throw new RepositoryImportError("unsupported_repository", {
      path: safeRootPath(root),
    });
  }
};

export const readGitRepositoryIdentity = (
  inputRoot: string,
): GitRepositoryIdentity => {
  const root = validateRoot(inputRoot);
  const repositoryRoot = normalizePath(
    runGit(root, ["rev-parse", "--show-toplevel"]).trim(),
  );
  const branchOutput = runGitOptional(root, ["symbolic-ref", "--short", "-q", "HEAD"])
    ?.trim() ?? "";
  const headOutput = runGitOptional(root, ["rev-parse", "--verify", "-q", "HEAD"])
    ?.trim() ?? "";

  return {
    root: repositoryRoot,
    branch: branchOutput === "HEAD" || branchOutput.length === 0 ? null : branchOutput,
    head: headOutput.length === 0 ? null : headOutput,
  };
};

export const readGitRepositoryState = (inputRoot: string): GitRepositoryState => {
  const root = validateRoot(inputRoot);
  const identity = readGitRepositoryIdentity(root);
  const objectFormat = readGitObjectFormat(root);
  const filesystemClaim = repositoryFilesystemClaim(root, runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]));
  const indexPath = runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]).trim();
  const statusOutput = runGitStatus(
    root,
    identity.head,
    identity.branch,
    objectFormat,
    filesystemClaim.canonicalCommonDirectory,
    indexPath,
  );
  const trackedOutput = runGit(root, ["ls-files", "-z", "--cached"]);
  const untrackedOutput = runGit(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  const worktreeOutput = runGit(root, ["worktree", "list", "--porcelain"]);

  return {
    ...identity,
    entries: parseStatus(statusOutput),
    tracked: splitNulPaths(trackedOutput),
    untracked: splitNulPaths(untrackedOutput),
    worktreeCount: parseWorktreeCount(worktreeOutput),
  };
};

export const readGitRepositoryStateAsync = async (
  inputRoot: string,
  signal: AbortSignal,
  dependencies: AsyncGitRepositoryDependencies = {},
): Promise<GitRepositoryObservationState> => {
  signal.throwIfAborted();
  const root = validateRoot(inputRoot);
  signal.throwIfAborted();
  const repositoryRoot = normalizePath((await runGitAsync(
    root,
    ["rev-parse", "--show-toplevel"],
    signal,
    dependencies,
  )).trim());
  const branchOutput = (await runGitOptionalAsync(
    root,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    signal,
    dependencies,
  ))?.trim() ?? "";
  const headOutput = (await runGitOptionalAsync(
    root,
    ["rev-parse", "--verify", "-q", "HEAD"],
    signal,
    dependencies,
  ))?.trim() ?? "";
  const objectFormat = await readGitObjectFormatAsync(root, signal, dependencies);
  const repositoryFilesystemClaim = await readGitRepositoryFilesystemClaimAsync(
    root,
    signal,
    dependencies,
  );
  const indexPath = (await runGitAsync(
    root,
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    signal,
    dependencies,
  )).trim();
  signal.throwIfAborted();
  const statusOutput = await runGitStatusAsync(
    root,
    headOutput.length === 0 ? null : headOutput,
    branchOutput.length === 0 ? null : branchOutput,
    objectFormat,
    repositoryFilesystemClaim.canonicalCommonDirectory,
    indexPath,
    signal,
    dependencies,
  );
  const trackedOutput = await runGitAsync(
    root,
    ["ls-files", "-z", "--cached"],
    signal,
    dependencies,
  );
  const untrackedOutput = await runGitAsync(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ], signal, dependencies);
  const worktreeOutput = await runGitAsync(
    root,
    ["worktree", "list", "--porcelain"],
    signal,
    dependencies,
  );
  signal.throwIfAborted();
  await revalidateGitRepositoryFilesystemClaimAsync(
    root,
    repositoryFilesystemClaim,
    signal,
    dependencies,
  );

  return {
    root: repositoryRoot,
    branch: branchOutput === "HEAD" || branchOutput.length === 0 ? null : branchOutput,
    head: headOutput.length === 0 ? null : headOutput,
    entries: parseStatus(statusOutput),
    tracked: splitNulPaths(trackedOutput),
    untracked: splitNulPaths(untrackedOutput),
    worktreeCount: parseWorktreeCount(worktreeOutput),
    repositoryIdentity: repositoryFilesystemClaim.repositoryIdentity,
    repositoryFilesystemClaim,
  };
};
