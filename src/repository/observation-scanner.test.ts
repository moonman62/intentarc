import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryObservationCandidate } from "../domain/repository-index-model.js";
import { createRepositoryFixture, type RepositoryFixture } from "../test-support/repository-fixture.js";
import {
  createRepositoryObservationScanner,
  RepositoryObservationDriftError,
  RepositoryObservationLimitError,
} from "./observation-scanner.js";

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

const scan = async (
  repository: RepositoryFixture,
  canonicalSubpath: string | null = null,
): Promise<RepositoryObservationCandidate> => {
  const scanner = createRepositoryObservationScanner();
  return scanner.scan(
    { root: repository.root, canonicalSubpath },
    { signal: new AbortController().signal, onProgress: () => undefined },
  );
};

const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const gitFilterCommand = (...arguments_: readonly string[]): string =>
  arguments_.map((argument) =>
    `"${argument.replaceAll("\\", "/").replaceAll('"', '\\"')}"`
  ).join(" ");

describe("repository observation scanner", () => {
  it.each(["sha1", "sha256"] as const)(
    "refreshes staged and untracked facts from an unborn %s repository",
    async (objectFormat) => {
      const root = mkdtempSync(join(tmpdir(), `intentarc unborn refresh ${objectFormat} `));
      temporaryDirectories.push(root);
      execFileSync("git", [
        "init",
        "--initial-branch=main",
        `--object-format=${objectFormat}`,
        root,
      ], { stdio: "ignore", windowsHide: true });
      writeFileSync(join(root, "README.md"), "# Unborn repository\n");
      writeFileSync(join(root, "notes.txt"), "untracked notes\n");
      execFileSync("git", ["-C", root, "add", "--", "README.md"], {
        stdio: "ignore",
        windowsHide: true,
      });

      const candidate = await createRepositoryObservationScanner().scan(
        { root, canonicalSubpath: null },
        { signal: new AbortController().signal, onProgress: () => undefined },
      );

      expect(candidate).toMatchObject({ branch: "main", head: null });
      expect(candidate.observations.map(({ path }) => path)).toContain("README.md");
      expect(candidate.exclusions).toContainEqual(expect.objectContaining({
        reason: "untracked_not_eligible",
        count: 1,
      }));
    },
  );

  it("does not execute a repository process filter while refreshing", async () => {
    const repository = fixture({
      ".gitattributes": "README.md filter=intentarc-refresh-canary\n",
      ".intentarc-process-filter.cjs": [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.argv[2], 'executed');",
        "process.exit(1);",
        "",
      ].join("\n"),
      "README.md": "# Fixture\n",
    });
    const canaryPath = join(repository.root, "process-filter-canary.txt");
    repository.runGit([
      "config",
      "filter.intentarc-refresh-canary.process",
      gitFilterCommand(
        process.execPath,
        join(repository.root, ".intentarc-process-filter.cjs"),
        canaryPath,
      ),
    ]);
    repository.runGit([
      "config",
      "filter.intentarc-refresh-canary.required",
      "true",
    ]);
    repository.write("README.md", "# Changed\n");

    const candidate = await scan(repository);

    expect(candidate.observations.map(({ path }) => path)).toContain("README.md");
    expect(existsSync(canaryPath)).toBe(false);
  });

  it("returns only normalized relative paths as exact transient rename evidence", async () => {
    const repository = fixture({ "docs/old.md": "# Guide\n" });
    repository.runGit(["mv", "docs/old.md", "docs/new.md"]);

    const candidate = await scan(repository);

    expect(candidate.renameEvidence).toEqual([{
      originalPath: "docs/old.md",
      path: "docs/new.md",
    }]);
    expect(JSON.stringify(candidate.renameEvidence)).not.toContain(repository.root);
    expect(JSON.stringify(candidate.renameEvidence)).not.toContain("# Guide");
  });

  it("omits rename evidence when either endpoint is secret or hard-excluded", async () => {
    const repository = fixture({
      ".env": "SECRET=value\n",
      "source.md": "# Private build input\n",
    });
    repository.write("build/.placeholder", "ignored\n");
    repository.write("docs/.placeholder", "ignored\n");
    repository.runGit(["mv", ".env", "docs/public.md"]);
    repository.runGit(["mv", "source.md", "build/private.md"]);

    const candidate = await scan(repository);
    const serialized = JSON.stringify(candidate);

    expect(candidate.renameEvidence).toEqual([]);
    expect(candidate.observations.map(({ path }) => path)).toContain("docs/public.md");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("build/private.md");
  });

  it("observes eligible file metadata, derived directories, formats, and AI instruction scope", async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const pdf = Buffer.from("%PDF-1.7\n", "ascii");
    const repository = fixture({
      "AGENTS.md": "# Codex instructions\n",
      "README.md": "# Fixture\n",
      "docs/architecture-spec.md": "# Architecture specification\n",
      "docs/decisions/0001-store.md": "# Decision\n",
      "docs/runbook.txt": "restart safely\n",
      "docs/tests/evidence.md": "# Test evidence\n",
      "assets/icon.png": image,
      "docs/reference.pdf": pdf,
      "src/index.ts": "export const value = 1;\n",
    });
    repository.write("docs/local-note.md", "# Local note\n");
    repository.write("scripts/local.ps1", "Write-Output ignored\n");

    const candidate = await scan(repository);
    const byPath = new Map(candidate.observations.map((value) => [value.path, value]));

    expect([...byPath.keys()]).toEqual([
      "AGENTS.md",
      "README.md",
      "assets",
      "assets/icon.png",
      "docs",
      "docs/architecture-spec.md",
      "docs/decisions",
      "docs/decisions/0001-store.md",
      "docs/local-note.md",
      "docs/reference.pdf",
      "docs/runbook.txt",
      "docs/tests",
      "docs/tests/evidence.md",
      "src",
      "src/index.ts",
    ]);
    expect(byPath.get("README.md")).toMatchObject({
      kind: "file",
      sha256: sha256("# Fixture\n"),
      sourceStatus: "tracked",
      role: "supporting_document",
      documentKind: "overview",
      documentFormat: "markdown",
      contentEligible: true,
    });
    expect(byPath.get("docs/architecture-spec.md")).toMatchObject({
      documentKind: "specification",
      documentFormat: "markdown",
    });
    expect(byPath.get("docs/decisions/0001-store.md")).toMatchObject({
      documentKind: "decision_support",
      documentFormat: "markdown",
    });
    expect(byPath.get("docs/runbook.txt")).toMatchObject({
      documentKind: "operational_guide",
      documentFormat: "plain_text",
    });
    expect(byPath.get("docs/tests/evidence.md")).toMatchObject({
      documentKind: "test_evidence",
      documentFormat: "markdown",
      role: "supporting_document",
    });
    expect(byPath.get("AGENTS.md")).toMatchObject({
      documentKind: "ai_instruction",
      documentFormat: "markdown",
      instructionClient: "codex",
      instructionScope: "repository",
    });
    expect(byPath.get("assets/icon.png")).toMatchObject({
      sha256: sha256(image),
      byteSize: image.byteLength,
      role: "asset",
      documentKind: "unlinked",
      documentFormat: "image",
      contentEligible: true,
    });
    expect(byPath.get("docs/reference.pdf")).toMatchObject({
      sha256: sha256(pdf),
      documentKind: "unlinked",
      documentFormat: "pdf",
      contentEligible: true,
    });
    expect(byPath.get("src/index.ts")).toMatchObject({
      documentKind: null,
      documentFormat: "unsupported",
      contentEligible: false,
    });
    expect(byPath.get("docs")).toEqual({
      path: "docs",
      kind: "directory",
      sha256: null,
      byteSize: 0,
      sourceStatus: "derived",
      role: "supporting_document",
      documentKind: null,
      documentFormat: null,
      contentEligible: false,
      instructionClient: null,
      instructionScope: null,
    });
    expect(candidate.exclusions).toContainEqual({
      path: "scripts/local.ps1",
      reason: "untracked_not_eligible",
      count: 1,
    });
    expect(candidate.warnings).toContainEqual({ code: "untracked_document", count: 1 });
    expect(candidate.links).toEqual([]);
    expect(JSON.stringify(candidate)).not.toContain("Codex instructions");
    expect(JSON.stringify(candidate)).not.toContain("export const value");
  });

  it("keeps known-secret paths aggregated and marks sensitive or invalid text ineligible", async () => {
    const repository = fixture({
      ".env": "API_KEY=synthetic-secret-never-disclose\n",
      "README.md": "Contact owner@example.com\n",
      "docs/invalid.txt": Buffer.from([0xc3, 0x28]),
    });

    const candidate = await scan(repository);
    const serialized = JSON.stringify(candidate);

    expect(candidate.exclusions).toContainEqual({
      path: null,
      reason: "known_secret_path",
      count: 1,
    });
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("synthetic-secret-never-disclose");
    expect(candidate.findingCounts).toEqual({ sensitive: 1 });
    expect(candidate.observations.find(({ path }) => path === "README.md")).toMatchObject({
      contentEligible: false,
    });
    expect(candidate.observations.find(({ path }) => path === "docs/invalid.txt")).toMatchObject({
      documentKind: null,
      documentFormat: "unsupported",
      contentEligible: false,
    });
  });

  it("emits closed monotonic progress, yields bounded work, and aborts without returning a partial candidate", async () => {
    const files: Record<string, string> = { "README.md": "# Fixture\n" };
    for (let index = 0; index < 130; index += 1) {
      files[`docs/file-${String(index).padStart(3, "0")}.md`] = `# File ${index}\n`;
    }
    const repository = fixture(files);
    const scanner = createRepositoryObservationScanner();
    const progress: Array<{ phase: string; processed: number; total: number }> = [];
    let timerObserved = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerObserved = true;
        resolve();
      }, 0);
    });

    const candidate = await scanner.scan(
      { root: repository.root, canonicalSubpath: null },
      {
        signal: new AbortController().signal,
        onProgress: (value) => progress.push(value),
      },
    );
    await timer;

    expect(candidate.observations.length).toBeGreaterThan(130);
    expect(timerObserved).toBe(true);
    expect([...new Set(progress.map(({ phase }) => phase))]).toEqual([
      "discovering",
      "hashing",
      "classifying",
      "finalizing",
    ]);
    expect(progress.every((value, index) =>
      index === 0 ||
      (value.total === progress[index - 1]!.total &&
        value.processed >= progress[index - 1]!.processed)
    )).toBe(true);
    expect(progress.at(-1)).toEqual({
      phase: "finalizing",
      processed: progress.at(-1)!.total,
      total: progress.at(-1)!.total,
    });

    const controller = new AbortController();
    const abortedProgress: typeof progress = [];
    await expect(scanner.scan(
      { root: repository.root, canonicalSubpath: null },
      {
        signal: controller.signal,
        onProgress: (value) => {
          abortedProgress.push(value);
          if (value.phase === "hashing") controller.abort();
        },
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedProgress.some(({ phase }) => phase === "finalizing")).toBe(false);
  });

  it("fails closed when an eligible path exceeds the fixed depth budget", async () => {
    const deepPath = `${Array.from({ length: 65 }, () => "d").join("/")}/file.md`;
    const repository = fixture({
      "README.md": "# Fixture\n",
      [deepPath]: "# Too deep\n",
    });

    await expect(scan(repository)).rejects.toEqual(expect.objectContaining({
      name: "RepositoryObservationLimitError",
      limit: "depth",
    } satisfies Partial<RepositoryObservationLimitError>));
  });

  it("applies hard exclusions before the observed-depth budget", async () => {
    const excludedPath = `dist/${Array.from({ length: 65 }, () => "d").join("/")}/file.md`;
    const repository = fixture({
      "README.md": "# Fixture\n",
      [excludedPath]: "# Generated and excluded\n",
    });

    const candidate = await scan(repository);

    expect(candidate.exclusions).toContainEqual({
      path: "dist",
      reason: "hard_exclusion",
      count: 1,
    });
    expect(candidate.observations.some(({ path }) => path.startsWith("dist/"))).toBe(false);
  });

  it("preserves cancellation raised during verification instead of reporting drift", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const candidate = await scan(repository);
    const controller = new AbortController();
    const scanner = createRepositoryObservationScanner({
      readGitRepositoryStateAsync: async (_root, signal) => {
        controller.abort();
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
    });

    await expect(scanner.verify(candidate, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("uses abortable asynchronous Git discovery instead of the blocking import path", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const controller = new AbortController();
    const scanner = createRepositoryObservationScanner({
      readGitRepositoryState: () => {
        throw new Error("blocking Git path was used");
      },
      readGitRepositoryStateAsync: (_root, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const candidate = scanner.scan(
      { root: repository.root, canonicalSubpath: null },
      { signal: controller.signal, onProgress: () => undefined },
    );
    setTimeout(() => controller.abort(), 25);

    await expect(candidate).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interrupts a large tracked binary after a bounded number of hash chunks", async () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "assets/large.bin": Buffer.alloc(4 * 1024 * 1024, 0x5a),
    });
    const controller = new AbortController();
    let chunksRead = 0;
    let abortScheduled = false;
    const scanner = createRepositoryObservationScanner({
      readFileChunk: (descriptor, buffer, offset, length, position) => {
        chunksRead += 1;
        return readSync(descriptor, buffer, offset, length, position);
      },
    });

    const candidate = scanner.scan(
      { root: repository.root, canonicalSubpath: null },
      {
        signal: controller.signal,
        onProgress: ({ phase }) => {
          if (phase === "hashing" && !abortScheduled) {
            abortScheduled = true;
            setImmediate(() => controller.abort());
          }
        },
      },
    );

    await expect(candidate).rejects.toMatchObject({ name: "AbortError" });
    expect(chunksRead).toBeGreaterThan(0);
    expect(chunksRead).toBeLessThanOrEqual(2);
  });

  it("changes repository identity and rejects verify after an equivalent same-path clone replacement", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const scanner = createRepositoryObservationScanner();
    const candidate = await scan(repository);
    const clone = `${repository.root}-clone`;
    const parked = `${repository.root}-parked`;

    try {
      repository.runGit(["clone", "--no-hardlinks", repository.root, clone]);
      repository.runGit(["-C", clone, "config", "core.autocrlf", "false"]);
      repository.runGit(["-C", clone, "reset", "--hard", "HEAD"]);
      renameSync(repository.root, parked);
      renameSync(clone, repository.root);

      const replacement = await scan(repository);

      expect(replacement.head).toBe(candidate.head);
      expect(replacement.observations).toEqual(candidate.observations);
      expect.soft(replacement.repositoryIdentity).not.toBe(candidate.repositoryIdentity);
      await expect(scanner.verify(candidate)).rejects.toMatchObject({
        name: "RepositoryObservationDriftError",
        reason: "root",
      });
    } finally {
      if (existsSync(clone)) rmSync(clone, { recursive: true, force: true });
      if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    }
  });

  it("rejects an equivalent same-path clone replacement after hashing before candidate return", async () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "assets/icon.bin": Buffer.alloc(256 * 1024, 0x5a),
    });
    const clone = `${repository.root}-clone`;
    const parked = `${repository.root}-parked`;
    let replaced = false;

    try {
      repository.runGit(["clone", "--no-hardlinks", repository.root, clone]);
      repository.runGit(["-C", clone, "config", "core.autocrlf", "false"]);
      repository.runGit(["-C", clone, "reset", "--hard", "HEAD"]);
      const candidate = createRepositoryObservationScanner().scan(
        { root: repository.root, canonicalSubpath: null },
        {
          signal: new AbortController().signal,
          onProgress: ({ phase }) => {
            if (!replaced && phase === "classifying") {
              replaced = true;
              renameSync(repository.root, parked);
              renameSync(clone, repository.root);
            }
          },
        },
      );

      await expect(candidate).rejects.toMatchObject({
        code: "unsupported_repository",
        message: "Repository is unsupported.",
      });
      expect(replaced).toBe(true);
    } finally {
      if (existsSync(clone)) rmSync(clone, { recursive: true, force: true });
      if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    }
  });

  it.each([
    ["branch", (repository: RepositoryFixture) => {
      repository.runGit(["switch", "--create", "changed-branch"]);
    }, "branch"],
    ["HEAD", (repository: RepositoryFixture) => {
      repository.runGit(["-c", "commit.gpgSign=false", "commit", "--allow-empty", "--message", "Changed HEAD"]);
    }, "head"],
    ["path set", (repository: RepositoryFixture) => {
      repository.write("docs/new.md", "# New\n");
    }, "path_set"],
    ["content hash", (repository: RepositoryFixture) => {
      repository.write("README.md", "# Changed\n");
    }, "content_hash"],
  ] as const)("rejects current %s drift with a sanitized typed error", async (
    _label,
    mutate,
    reason,
  ) => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const scanner = createRepositoryObservationScanner();
    const candidate = await scan(repository);
    mutate(repository);

    await expect(scanner.verify(candidate)).rejects.toEqual(expect.objectContaining({
      name: "RepositoryObservationDriftError",
      reason,
    } satisfies Partial<RepositoryObservationDriftError>));
  });

  it("rejects candidate ruleset and canonical-root claim drift", async () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const scanner = createRepositoryObservationScanner();
    const candidate = await scan(repository);

    await expect(scanner.verify({ ...candidate, rulesetVersion: "false-ruleset" }))
      .rejects.toMatchObject({ name: "RepositoryObservationDriftError", reason: "ruleset" });
    await expect(scanner.verify({ ...candidate, root: `${candidate.root}/.` }))
      .rejects.toMatchObject({ name: "RepositoryObservationDriftError", reason: "root" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a canonical repository root replaced by a symlink before verify",
    async () => {
      const repository = fixture({ "README.md": "# Fixture\n" });
      const scanner = createRepositoryObservationScanner();
      const candidate = await scan(repository);
      const parked = `${repository.root}-parked`;
      renameSync(repository.root, parked);
      symlinkSync(parked, repository.root, "dir");

      await expect(scanner.verify(candidate)).rejects.toMatchObject({
        name: "RepositoryObservationDriftError",
        reason: "root",
      });

      // Restore the fixture path so its ordinary cleanup remains bounded.
      renameSync(repository.root, `${repository.root}-link`);
      renameSync(parked, repository.root);
      rmSync(`${repository.root}-link`);
    },
  );
});
