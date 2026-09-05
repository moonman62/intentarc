import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryFixture, type RepositoryFixture } from "../test-support/repository-fixture.js";
import {
  readGitRepositoryState,
  readGitRepositoryStateAsync,
} from "./git-repository.js";

const fixtures: RepositoryFixture[] = [];
const temporaryDirectories: string[] = [];

const fixture = (
  files: Readonly<Record<string, string | Buffer>>,
): RepositoryFixture => {
  const repository = createRepositoryFixture(files);
  fixtures.push(repository);
  return repository;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const thrownBy = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
};

const nonExecutingGitViews = (): string[] => readdirSync(tmpdir())
  .filter((name) => name.startsWith("intentarc git metadata "))
  .sort();

const unbornRepository = (objectFormat: "sha1" | "sha256"): string => {
  const directory = mkdtempSync(join(tmpdir(), `intentarc unborn ${objectFormat} `));
  temporaryDirectories.push(directory);
  execFileSync("git", [
    "init",
    "--initial-branch=main",
    `--object-format=${objectFormat}`,
    directory,
  ], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", directory, "config", "core.autocrlf", "false"], {
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(join(directory, "staged.txt"), "staged\n");
  writeFileSync(join(directory, "untracked.txt"), "untracked\n");
  execFileSync("git", ["-C", directory, "add", "--", "staged.txt"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return directory;
};

describe("Git repository state", () => {
  it.each(["sha1", "sha256"] as const)(
    "reads a real unborn %s repository synchronously and asynchronously",
    async (objectFormat) => {
      const root = unbornRepository(objectFormat);

      expect(readGitRepositoryState(root)).toMatchObject({
        root: root.replaceAll("\\", "/"),
        branch: "main",
        head: null,
        entries: [
          { index: "A", worktree: " ", path: "staged.txt", originalPath: null },
          { index: "?", worktree: "?", path: "untracked.txt", originalPath: null },
        ],
        tracked: ["staged.txt"],
        untracked: ["untracked.txt"],
      });
      await expect(readGitRepositoryStateAsync(
        root,
        new AbortController().signal,
      )).resolves.toMatchObject({
        root: root.replaceAll("\\", "/"),
        branch: "main",
        head: null,
        entries: [
          { index: "A", worktree: " ", path: "staged.txt", originalPath: null },
          { index: "?", worktree: "?", path: "untracked.txt", originalPath: null },
        ],
      });
    },
  );

  it("pins synthetic commit identity and timestamps for deterministic fixtures", () => {
    const repository = fixture({ "README.md": "# Fixture\n" });

    expect(repository.runGit([
      "show",
      "--no-patch",
      "--format=%an%n%ae%n%aI%n%cI",
      "HEAD",
    ]).trim()).toBe([
      "IntentArc Synthetic Fixture",
      "fixture@intentarc.invalid",
      "2000-01-01T00:00:00Z",
      "2000-01-01T00:00:00Z",
    ].join("\n"));
  });

  it("reads a clean repository whose root contains spaces through real Git processes", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "godot/project.godot": "config_version=5\n",
    });

    const state = readGitRepositoryState(repository.root);

    expect(repository.root).toContain(" ");
    expect(state.root).toBe(repository.runGit(["rev-parse", "--show-toplevel"]).trim().replaceAll("\\", "/"));
    expect(state.branch).toBe("main");
    expect(state.head).toMatch(/^[a-f0-9]{40}$/);
    expect(state.entries).toEqual([]);
    expect(state.tracked).toEqual(["README.md", "godot/project.godot"]);
    expect(state.untracked).toEqual([]);
    expect(state.worktreeCount).toBe(1);
  });

  it("removes the temporary non-executing Git view after successful and failed status reads", () => {
    const successful = fixture({ "README.md": "# Fixture\n" });
    const beforeSuccess = nonExecutingGitViews();
    readGitRepositoryState(successful.root);
    expect(nonExecutingGitViews()).toEqual(beforeSuccess);

    const failing = fixture({ "README.md": "# Fixture\n" });
    const indexPath = resolve(
      failing.root,
      failing.runGit(["rev-parse", "--git-path", "index"]).trim(),
    );
    writeFileSync(indexPath, "not a Git index\n");
    const beforeFailure = nonExecutingGitViews();
    expect(() => readGitRepositoryState(failing.root)).toThrowError(
      expect.objectContaining({ code: "unsupported_repository" }),
    );
    expect(nonExecutingGitViews()).toEqual(beforeFailure);
  });

  it("ignores a repository-controlled fsmonitor without changing the index", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "godot/project.godot": "config_version=5\n",
    });
    const canaryPath = join(repository.root, "fsmonitor-canary.txt");
    const hookName = process.platform === "win32"
      ? "malicious-fsmonitor.cmd"
      : "malicious-fsmonitor.sh";
    const hookPath = join(repository.root, hookName);
    repository.write(
      hookName,
      process.platform === "win32"
        ? "@echo off\r\n> \"%~dp0fsmonitor-canary.txt\" echo invoked\r\nexit /b 0\r\n"
        : "#!/bin/sh\nprintf invoked > \"$(dirname \"$0\")/fsmonitor-canary.txt\"\nexit 0\n",
    );
    if (process.platform !== "win32") chmodSync(hookPath, 0o700);
    repository.runGit(["config", "core.fsmonitor", `./${hookName}`]);
    const readmePath = join(repository.root, "README.md");
    utimesSync(
      readmePath,
      new Date("2026-07-28T12:00:00.000Z"),
      new Date("2026-07-28T12:00:00.000Z"),
    );
    const indexOutput = repository.runGit(["rev-parse", "--git-path", "index"]).trim();
    const indexPath = resolve(repository.root, indexOutput);
    const indexBefore = readFileSync(indexPath);

    const state = readGitRepositoryState(repository.root);

    expect(state.head).toMatch(/^[a-f0-9]{40}$/);
    expect(existsSync(canaryPath)).toBe(false);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it("uses raw Git objects for status even when the repository defines a replacement commit", () => {
    const repository = fixture({ "README.md": "# Original\n" });
    const originalHead = repository.runGit(["rev-parse", "HEAD"]).trim();
    repository.write("README.md", "# Replacement\n");
    repository.runGit(["add", "--", "README.md"]);
    const replacementTree = repository.runGit(["write-tree"]).trim();
    const replacementCommit = repository.runGit([
      "commit-tree",
      replacementTree,
      "-p",
      originalHead,
      "-m",
      "Replacement view",
    ]).trim();
    repository.runGit(["reset", "--hard", originalHead]);
    repository.runGit(["replace", originalHead, replacementCommit]);

    expect(repository.runGit(["status", "--porcelain=v1"]).trim()).not.toBe("");
    expect(readGitRepositoryState(repository.root).entries).toEqual([]);
  });

  it("forces replacement objects off in every asynchronous Git child environment", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    let calls = 0;
    await readGitRepositoryStateAsync(repository.root, new AbortController().signal, {
      execFile: (file, arguments_, options, callback) => {
        calls += 1;
        expect(options.env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
        return execFile(file, arguments_, options, callback);
      },
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("falls back when Git does not support the storage-specific object-format query", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    let fallbackUsed = false;
    await expect(readGitRepositoryStateAsync(
      repository.root,
      new AbortController().signal,
      {
        execFile: (file, arguments_, options, callback) => {
          if (arguments_.includes("--show-object-format=storage")) {
            const unsupported = Object.assign(new Error("unsupported option"), { code: 129 });
            callback(unsupported, "", "");
            return {} as ReturnType<typeof execFile>;
          }
          if (arguments_.includes("--show-object-format")) fallbackUsed = true;
          return execFile(file, arguments_, options, callback);
        },
      },
    )).resolves.toMatchObject({ head: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(fallbackUsed).toBe(true);
  });

  it("parses modified, staged, deleted, renamed, and untracked porcelain-v1 -z entries", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "docs/delete.md": "# Delete\n",
      "godot/project.godot": "config_version=5\n",
      "src/old.ts": "export const old = true;\n",
    });
    repository.write("README.md", "# Modified\n");
    repository.write("godot/project.godot", "config_version=6\n");
    repository.runGit(["add", "--", "godot/project.godot"]);
    repository.runGit(["rm", "--", "docs/delete.md"]);
    repository.runGit(["mv", "--", "src/old.ts", "src/new.ts"]);
    repository.write("docs/untracked.md", "# Local handoff\n");

    const state = readGitRepositoryState(repository.root);

    expect(state.entries).toEqual([
      { index: " ", worktree: "M", path: "README.md", originalPath: null },
      { index: "D", worktree: " ", path: "docs/delete.md", originalPath: null },
      { index: "?", worktree: "?", path: "docs/untracked.md", originalPath: null },
      { index: "M", worktree: " ", path: "godot/project.godot", originalPath: null },
      { index: "R", worktree: " ", path: "src/new.ts", originalPath: "src/old.ts" },
    ]);
    expect(state.untracked).toContain("docs/untracked.md");
  });

  it("returns a safe typed error without raw stderr when Git rejects an existing directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "intentarc invalid git "));
    try {
      const error = thrownBy(() => readGitRepositoryState(directory));

      expect(error).toMatchObject({
        code: "unsupported_repository",
        message: "Repository is unsupported.",
        details: { path: directory.replaceAll("\\", "/") },
      });
      expect(JSON.stringify(error)).not.toMatch(/fatal|not a git repository|stderr/i);
      expect(error).not.toHaveProperty("cause");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight asynchronous Git command instead of waiting for its timeout", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const controller = new AbortController();
    const startedAt = Date.now();
    const state = readGitRepositoryStateAsync(
      repository.root,
      controller.signal,
      {
        execFile: (_file, _arguments, options, callback) => execFile(
          process.execPath,
          ["-e", "setTimeout(() => undefined, 10_000)"],
          {
            ...options,
            signal: controller.signal,
          },
          callback,
        ),
      },
    );
    setTimeout(() => controller.abort(), 25);

    await expect(state).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("removes the temporary non-executing Git view when asynchronous status is aborted", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const controller = new AbortController();
    const before = nonExecutingGitViews();
    const state = readGitRepositoryStateAsync(
      repository.root,
      controller.signal,
      {
        execFile: (file, arguments_, options, callback) => {
          if (arguments_.includes("status")) {
            setTimeout(() => controller.abort(), 25);
            return execFile(
              process.execPath,
              ["-e", "setTimeout(() => undefined, 10_000)"],
              { ...options, signal: controller.signal },
              callback,
            );
          }
          return execFile(file, arguments_, options, callback);
        },
      },
    );

    await expect(state).rejects.toMatchObject({ name: "AbortError" });
    expect(nonExecutingGitViews()).toEqual(before);
  });

  it("uses bounded exact-directory cleanup for the temporary Git view", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    let cleanupPath = "";
    let cleanupOptions: Parameters<typeof rmSync>[1];
    await readGitRepositoryStateAsync(repository.root, new AbortController().signal, {
      removeDirectory: (path, options) => {
        cleanupPath = String(path);
        cleanupOptions = options;
        rmSync(path, options);
      },
    });

    expect(cleanupPath).toContain("intentarc git metadata ");
    expect(cleanupOptions).toMatchObject({
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 4 : 0,
      retryDelay: 50,
    });
  });

  it.each(["abort", "git_failure"] as const)(
    "preserves the primary %s when bounded temporary-view cleanup also fails",
    async (failure) => {
      const repository = fixture({ "README.md": "# Fixture\n" });
      const controller = new AbortController();
      let leakedDirectory = "";
      const state = readGitRepositoryStateAsync(repository.root, controller.signal, {
        execFile: (file, arguments_, options, callback) => {
          if (!arguments_.includes("status")) {
            return execFile(file, arguments_, options, callback);
          }
          if (failure === "abort") setTimeout(() => controller.abort(), 25);
          return execFile(
            process.execPath,
            ["-e", failure === "abort"
              ? "setTimeout(() => undefined, 10_000)"
              : "process.exit(1)"],
            { ...options, signal: controller.signal },
            callback,
          );
        },
        removeDirectory: (path) => {
          leakedDirectory = String(path);
          throw new Error("simulated cleanup failure");
        },
      });

      try {
        if (failure === "abort") {
          await expect(state).rejects.toMatchObject({ name: "AbortError" });
        } else {
          await expect(state).rejects.toMatchObject({
            name: "RepositoryImportError",
            code: "unsupported_repository",
            message: "Repository is unsupported.",
          });
        }
      } finally {
        if (leakedDirectory !== "") {
          rmSync(leakedDirectory, { recursive: true, force: true });
        }
      }
    },
  );

  it("aborts asynchronous index discovery before creating a temporary Git view", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const controller = new AbortController();
    const before = nonExecutingGitViews();
    let indexDiscoveryStarted = false;
    let statusStarted = false;
    const state = readGitRepositoryStateAsync(repository.root, controller.signal, {
      execFile: (file, arguments_, options, callback) => {
        if (arguments_.includes("--git-path") && arguments_.includes("index")) {
          indexDiscoveryStarted = true;
          setTimeout(() => controller.abort(), 25);
          return execFile(
            process.execPath,
            ["-e", "setTimeout(() => undefined, 10_000)"],
            { ...options, signal: controller.signal },
            callback,
          );
        }
        if (arguments_.includes("status")) statusStarted = true;
        return execFile(file, arguments_, options, callback);
      },
    });

    await expect(state).rejects.toMatchObject({ name: "AbortError" });
    expect(indexDiscoveryStarted).toBe(true);
    expect(statusStarted).toBe(false);
    expect(nonExecutingGitViews()).toEqual(before);
  });

  it("rejects an equivalent repository replacement after the initial common-directory claim", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const clone = `${repository.root}-clone`;
    const parked = `${repository.root}-parked`;
    let replaced = false;

    try {
      repository.runGit(["clone", "--no-hardlinks", repository.root, clone]);
      repository.runGit(["-C", clone, "config", "core.autocrlf", "false"]);
      repository.runGit(["-C", clone, "reset", "--hard", "HEAD"]);

      const state = readGitRepositoryStateAsync(
        repository.root,
        new AbortController().signal,
        {
          execFile: (file, arguments_, options, callback) => {
            if (!replaced && arguments_.includes("status")) {
              replaced = true;
              renameSync(repository.root, parked);
              renameSync(clone, repository.root);
            }
            return execFile(file, arguments_, options, callback);
          },
        },
      );

      await expect(state).rejects.toMatchObject({
        code: "unsupported_repository",
        message: "Repository is unsupported.",
      });
      expect(replaced).toBe(true);
    } finally {
      if (existsSync(clone)) rmSync(clone, { recursive: true, force: true });
      if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    }
  });
});
