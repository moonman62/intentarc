import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const GIT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const WINDOWS_CLEANUP_RETRY_COUNT = 20;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 50;

const isWindowsCleanupRace = (
  error: unknown,
): error is NodeJS.ErrnoException => {
  if (process.platform !== "win32" || !(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
};

const waitSynchronously = (milliseconds: number): void => {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
};

const removeFixtureRoot = (root: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !isWindowsCleanupRace(error) ||
        attempt >= WINDOWS_CLEANUP_RETRY_COUNT
      ) {
        throw error;
      }
      waitSynchronously(WINDOWS_CLEANUP_RETRY_DELAY_MS);
    }
  }
};

export interface RepositoryFixture {
  readonly root: string;
  readonly runGit: (arguments_: readonly string[]) => string;
  readonly write: (relativePath: string, content: string | Buffer) => void;
  readonly cleanup: () => void;
}

export interface CreateRepositoryFixtureOptions {
  readonly parentDirectory?: string;
}

const resolveFixturePath = (root: string, relativePath: string): string => {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error("Fixture paths must be non-empty relative paths");
  }

  const path = resolve(root, relativePath);
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Fixture paths must stay inside the fixture root");
  }
  return path;
};

export const createRepositoryFixture = (
  files: Readonly<Record<string, string | Buffer>>,
  options: CreateRepositoryFixtureOptions = {},
): RepositoryFixture => {
  const root = mkdtempSync(join(
    options.parentDirectory ?? tmpdir(),
    "intentarc repository fixture ",
  ));
  let cleaned = false;

  const runGit = (arguments_: readonly string[]): string =>
    execFileSync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const write = (relativePath: string, content: string | Buffer): void => {
    if (cleaned) throw new Error("Repository fixture has been cleaned up");
    const path = resolveFixturePath(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  const cleanup = (): void => {
    if (cleaned) return;
    removeFixtureRoot(root);
    cleaned = true;
  };

  try {
    runGit(["init", "--initial-branch=main"]);
    runGit(["config", "user.name", "IntentArc Synthetic Fixture"]);
    runGit(["config", "user.email", "fixture@intentarc.invalid"]);
    runGit(["config", "core.autocrlf", "false"]);
    for (const [path, content] of Object.entries(files)) write(path, content);
    runGit(["add", "--all"]);
    runGit(["-c", "commit.gpgSign=false", "commit", "--message", "Synthetic fixture"]);
  } catch (error) {
    cleanup();
    throw error;
  }

  return { root, runGit, write, cleanup };
};
