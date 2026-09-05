import {
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryImportManifest } from "../domain/import-model.js";
import { createRepositoryFixture, type RepositoryFixture } from "../test-support/repository-fixture.js";
import type { DiscoveredRepository } from "./discovery-model.js";
import {
  discoverRepository,
  verifyRepositorySnapshot,
} from "./repository-scanner.js";

const fixtures: RepositoryFixture[] = [];
const temporaryDirectories: string[] = [];

const fixture = (
  files: Readonly<Record<string, string | Buffer>>,
): RepositoryFixture => {
  const repository = createRepositoryFixture(files);
  fixtures.push(repository);
  return repository;
};

const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `intentarc scanner ${label} `));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const manifestFor = (
  repository: DiscoveredRepository,
): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: repository.scannerVersion,
  rulesetVersion: repository.rulesetVersion,
  createdAt: "2026-07-28T12:00:00.000Z",
  repository: { ...repository.repository },
  discovery: {
    sources: repository.discovery.sources.map((source) => ({
      ...source,
      extraction: {
        ...source.extraction,
        headings: [...source.extraction.headings],
      },
    })),
    binaryCollections: repository.discovery.binaryCollections.map((collection) => ({
      ...collection,
      extensions: [...collection.extensions],
    })),
    warnings: repository.discovery.warnings.map((warning) => ({ ...warning })),
    exclusions: repository.discovery.exclusions.map((exclusion) => ({ ...exclusion })),
  },
  proposal: {
    project: {
      name: "Synthetic fixture",
      primaryRepositoryPath: repository.repository.root,
    },
    records: [],
    relationships: [],
  },
});

const thrownBy = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
};

const gitFilterCommand = (...arguments_: readonly string[]): string =>
  arguments_.map((argument) =>
    `"${argument.replaceAll("\\", "/").replaceAll('"', '\\"')}"`
  ).join(" ");

describe("repository discovery", () => {
  it.each(["sha1", "sha256"] as const)(
    "imports staged and untracked facts from an unborn %s repository",
    (objectFormat) => {
      const root = temporaryDirectory(`unborn ${objectFormat}`);
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

      const discovered = discoverRepository({ root });

      expect(discovered.repository).toMatchObject({ branch: "main", head: null });
      expect(discovered.discovery.sources.map(({ path }) => path)).toContain("README.md");
      expect(discovered.discovery.exclusions).toContainEqual(expect.objectContaining({
        reason: "untracked_not_eligible",
        count: 1,
      }));
    },
  );

  it("does not execute a repository clean filter while importing", () => {
    const repository = fixture({
      ".gitattributes": "README.md filter=intentarc-import-canary\n",
      ".intentarc-clean-filter.cjs": [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.argv[2], 'executed');",
        "process.stdin.pipe(process.stdout);",
        "",
      ].join("\n"),
      "README.md": "# Fixture\n",
    });
    const canaryPath = join(repository.root, "clean-filter-canary.txt");
    repository.runGit([
      "config",
      "filter.intentarc-import-canary.clean",
      gitFilterCommand(
        process.execPath,
        join(repository.root, ".intentarc-clean-filter.cjs"),
        canaryPath,
      ),
    ]);
    repository.write("README.md", "# Changed\n");

    const discovered = discoverRepository({ root: repository.root });

    expect(discovered.discovery.sources.map(({ path }) => path))
      .toContain("README.md");
    expect(existsSync(canaryPath)).toBe(false);
  });

  it("keeps root binaries distinct from a real repository-root directory", () => {
    const repository = fixture({
      "icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "repository-root/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    });

    const result = discoverRepository({ root: repository.root });

    expect(result.discovery.binaryCollections).toEqual([
      {
        directory: "",
        role: "asset",
        extensions: [".png"],
        count: 1,
        byteSize: 4,
      },
      {
        directory: "repository-root",
        role: "asset",
        extensions: [".png"],
        count: 1,
        byteSize: 5,
      },
    ]);
  });

  it.skipIf(process.platform !== "win32")(
    "canonicalizes a real Windows case-variant subpath without changing source content",
    () => {
      const repository = fixture({
        "README.md": "# Fixture\n",
        "godot/project.godot": "config/name=\"MiXeD Fixture\"\n",
      });

      const canonicalCase = discoverRepository({
        root: repository.root,
        canonicalSubpath: "godot",
      });
      const variantCase = discoverRepository({
        root: repository.root,
        canonicalSubpath: "GODOT",
      });

      expect(variantCase.repository.canonicalSubpath).toBe("godot");
      expect(variantCase.repository.fingerprint).toBe(
        canonicalCase.repository.fingerprint,
      );
      expect(variantCase.discovery.sources.find(
        (source) => source.path === "godot/project.godot",
      )).toMatchObject({ role: "canonical_source" });
      expect(variantCase.selectedSources.find(
        (source) => source.path === "godot/project.godot",
      )?.text).toBe("config/name=\"MiXeD Fixture\"\n");
    },
  );

  it("rejects a canonical subpath below an escaping junction", () => {
    const repository = fixture({ "README.md": "# Fixture\n" });
    const outside = temporaryDirectory("canonical-outside");
    mkdirSync(join(outside, "nested"));
    symlinkSync(outside, join(repository.root, "canonical-link"), "junction");

    expect(thrownBy(() => discoverRepository({
      root: repository.root,
      canonicalSubpath: "canonical-link/nested",
    }))).toMatchObject({ code: "canonical_path_invalid" });
  });

  it("keeps selected bodies ephemeral while safely grouping and excluding repository content", () => {
    const repository = fixture({
      ".env": "API_KEY=synthetic-secret-never-disclose\n",
      ".gitignore": "node_modules/\n",
      "README.md": "# Fixture\n\nPublic overview.\n",
      "dist/generated.md": "# Generated\n",
      "docs/guide.md": "# Guide\n",
      "godot/assets/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      "godot/project.godot": "config_version=5\n",
      "godot/src/main.gd": "extends Node\n",
      "godot/tests/test_main.gd": "extends Node\n",
      "node_modules/ignored/index.js": "ignored dependency\n",
    });
    repository.write("docs/local-plan.md", "# Local plan\n");
    repository.write("scripts/local.ps1", "Write-Output local\n");

    const outside = temporaryDirectory("outside");
    writeFileSync(join(outside, "outside.txt"), "junction target must not be read");
    symlinkSync(outside, join(repository.root, "escaping-link"), "junction");

    const linkedWorktree = join(repository.root, ".worktrees", "linked");
    repository.runGit(["worktree", "add", "--detach", linkedWorktree]);

    const result = discoverRepository({
      root: repository.root,
      canonicalSubpath: "godot",
    });

    expect(result.selectedSources.find((source) => source.path === "godot/src/main.gd"))
      .toMatchObject({ text: "extends Node\n", provisional: false });
    expect(result.selectedSources.find((source) => source.path === "docs/local-plan.md"))
      .toMatchObject({ text: "# Local plan\n", provisional: true });

    const publicProjection = JSON.stringify(result.discovery);
    expect(publicProjection).not.toContain("extends Node");
    expect(result.discovery.sources.find((source) => source.path === "godot/src/main.gd"))
      .toMatchObject({
        status: "tracked",
        role: "canonical_source",
        byteSize: 13,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    expect(result.discovery.sources.find((source) => source.path === "docs/local-plan.md"))
      .toMatchObject({
        status: "untracked",
        role: "supporting_document",
      });
    expect(result.discovery.binaryCollections).toEqual([
      {
        directory: "godot/assets",
        role: "asset",
        extensions: [".png"],
        count: 1,
        byteSize: 6,
      },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("synthetic-secret-never-disclose");
    expect([
      ...result.discovery.sources.map((source) => source.path),
      ...result.selectedSources.map((source) => source.path),
      ...result.discovery.exclusions.flatMap((exclusion) =>
        exclusion.path === null ? [] : [exclusion.path],
      ),
    ].some((path) => path.startsWith("node_modules/"))).toBe(false);
    expect(serialized).not.toContain("junction target must not be read");
    expect(result.discovery.exclusions).toContainEqual({
      path: null,
      reason: "known_secret_path",
      count: 1,
    });
    expect(result.discovery.exclusions).toContainEqual({
      path: "dist",
      reason: "hard_exclusion",
      count: 1,
    });
    expect(result.discovery.exclusions).toContainEqual({
      path: "scripts/local.ps1",
      reason: "untracked_not_eligible",
      count: 1,
    });
    expect(result.discovery.exclusions).toContainEqual({
      path: "escaping-link",
      reason: "link_not_followed",
      count: 1,
    });
    expect(result.discovery.warnings).toEqual([
      { code: "multiple_worktrees", count: 2 },
      { code: "untracked_document", count: 1 },
      { code: "working_tree_dirty", count: expect.any(Number) },
    ]);
  });

  it("publishes no outside bytes when a selected parent is replaced during open", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "docs/race.md": "# Original repository evidence\n",
    });
    const outside = temporaryDirectory("replacement-outside");
    writeFileSync(join(outside, "race.md"), "# OUTSIDE-RACE-CANARY\n");
    const originalParent = join(repository.root, "docs");
    const parkedParent = join(repository.root, "docs-before-race");
    let replacementAttempted = false;

    const error = thrownBy(() =>
      discoverRepository(
        { root: repository.root },
        {
          openFileForRead: (path: string, flags: number): number => {
            if (!replacementAttempted && path === join(originalParent, "race.md")) {
              replacementAttempted = true;
              renameSync(originalParent, parkedParent);
              symlinkSync(outside, originalParent, "junction");
            }
            return openSync(path, flags || constants.O_RDONLY);
          },
        },
      )
    );

    expect(error).toMatchObject({ code: "unsupported_repository" });
    expect(replacementAttempted).toBe(true);
    expect(JSON.stringify(error)).not.toContain("OUTSIDE-RACE-CANARY");
  });

  it("rejects selected-file growth after fstat instead of accepting the original prefix", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "docs/evidence.md": "# Stable evidence\n",
    });
    const evidencePath = join(repository.root, "README.md");
    let grew = false;

    const error = thrownBy(() => discoverRepository(
      { root: repository.root },
      {
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          if (!grew && position === 0) {
            grew = true;
            appendFileSync(evidencePath, "changed after fstat\n");
          }
          return readSync(descriptor, buffer, offset, length, position);
        },
      },
    ));

    expect(error).toMatchObject({ code: "unsupported_repository" });
    expect(grew).toBe(true);
  });

  it("preserves oversized and invalid UTF-8 rejection through the shared reader", () => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "docs/large.txt": Buffer.alloc(1024 * 1024 + 1, 0x61),
      "docs/invalid.txt": Buffer.from([0xc3, 0x28]),
    });

    const result = discoverRepository({ root: repository.root });

    expect(result.discovery.sources.map(({ path }) => path)).not.toContain("docs/large.txt");
    expect(result.discovery.sources.map(({ path }) => path)).not.toContain("docs/invalid.txt");
    expect(result.discovery.exclusions).toContainEqual({
      path: "docs/large.txt",
      reason: "oversized_text",
      count: 1,
    });
    expect(result.discovery.binaryCollections).toContainEqual({
      directory: "docs",
      role: "asset",
      extensions: [".txt"],
      count: 1,
      byteSize: 2,
    });
  });

  it("fingerprints content rather than mtimes and ignores unselected-file drift", () => {
    const repository = fixture({
      "README.md": "# Stable\n",
      "godot/project.godot": "config_version=5\n",
      "godot/src/main.gd": "extends Node\n",
    });
    repository.write("scripts/local.ps1", "Write-Output before\n");
    const discovered = discoverRepository({
      root: repository.root,
      canonicalSubpath: "godot",
    });
    const manifest = manifestFor(discovered);

    const readmePath = join(repository.root, "README.md");
    utimesSync(readmePath, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
    repository.write("scripts/local.ps1", "Write-Output after\n");

    expect(() => verifyRepositorySnapshot(manifest)).not.toThrow();
    expect(discoverRepository({
      root: repository.root,
      canonicalSubpath: "godot",
    }).repository.fingerprint).toBe(discovered.repository.fingerprint);

    repository.write("README.md", "# Changed selected source\n");
    const error = thrownBy(() => verifyRepositorySnapshot(manifest));
    expect(error).toMatchObject({
      code: "source_drift",
      message: "Repository sources have changed.",
      details: {
        expectedDigest: discovered.repository.fingerprint,
        actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(error)).not.toContain("Changed selected source");
  });

  it.each([
    ["canonical repository root", (value: RepositoryImportManifest) => {
      value.repository.root = `${value.repository.root}/.`;
    }],
    ["Git repository root identity", (value: RepositoryImportManifest) => {
      value.repository.root = `${value.repository.root}/game`;
    }],
    ["persisted primary repository path", (value: RepositoryImportManifest) => {
      value.proposal.project.primaryRepositoryPath =
        `${value.repository.root}/.`;
    }],
    ["branch", (value: RepositoryImportManifest) => {
      value.repository.branch = "false-branch";
    }],
    ["HEAD", (value: RepositoryImportManifest) => {
      value.repository.head = "f".repeat(40);
    }],
    ["canonical subpath", (value: RepositoryImportManifest) => {
      value.repository.canonicalSubpath = null;
    }],
    ["scanner version", (value: RepositoryImportManifest) => {
      (value as { scannerVersion: string }).scannerVersion = "false-scanner";
    }],
    ["ruleset version", (value: RepositoryImportManifest) => {
      (value as { rulesetVersion: string }).rulesetVersion = "false-ruleset";
    }],
    ["selected source paths", (value: RepositoryImportManifest) => {
      value.discovery.sources = value.discovery.sources.slice(1);
    }],
    ["selected source content hashes", (value: RepositoryImportManifest) => {
      value.discovery.sources[0]!.sha256 = "e".repeat(64);
    }],
  ])("independently rejects a false %s claim as sanitized source drift", (
    _name,
    mutate,
  ) => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "game/project.godot": "[application]\nconfig/name=\"Fixture\"\n",
      "game/src/main.gd": "extends Node\n",
    });
    const discovered = discoverRepository({
      root: repository.root,
      canonicalSubpath: "game",
    });
    const candidate = manifestFor(discovered);
    mutate(candidate);

    const error = thrownBy(() => verifyRepositorySnapshot(candidate));

    expect(error).toMatchObject({
      code: "source_drift",
      message: "Repository sources have changed.",
      details: {
        expectedDigest: discovered.repository.fingerprint,
        actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(error)).not.toContain("false-");
  });

  it.each([
    ["branch", (repository: RepositoryFixture) => {
      repository.runGit(["switch", "--create", "changed-branch"]);
    }],
    ["HEAD", (repository: RepositoryFixture) => {
      repository.runGit([
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "--message",
        "Changed HEAD",
      ]);
    }],
    ["selected source paths", (repository: RepositoryFixture) => {
      repository.write("docs/new-plan.md", "# Newly selected\n");
    }],
    ["selected source content", (repository: RepositoryFixture) => {
      repository.write("README.md", "# Changed selected source\n");
    }],
  ])("rejects independently changed current %s state", (_name, mutate) => {
    const repository = fixture({
      "README.md": "# Fixture\n",
      "game/project.godot": "[application]\nconfig/name=\"Fixture\"\n",
      "game/src/main.gd": "extends Node\n",
    });
    const discovered = discoverRepository({
      root: repository.root,
      canonicalSubpath: "game",
    });
    const candidate = manifestFor(discovered);
    mutate(repository);

    expect(() => verifyRepositorySnapshot(candidate)).toThrowError(
      expect.objectContaining({
        code: "source_drift",
        details: {
          expectedDigest: discovered.repository.fingerprint,
          actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    );
  });
});
