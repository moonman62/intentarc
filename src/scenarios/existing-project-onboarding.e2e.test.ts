import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getReleasedContextResultSchema,
  requestTaskContextResultSchema,
  type ImportApplyResult,
  type ImportInspection,
  type OutboundInspection,
  type ProposedImportRecord,
  type RepositoryImportManifest,
  type TaskContextPack,
} from "../domain/index.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../test-support/repository-fixture.js";
import { ensurePackagedTestBuild } from "../test-support/packaged-test-build.js";

type ProcessResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type SourceSnapshot = {
  readonly status: string;
  readonly head: string;
  readonly worktrees: string;
  readonly index: {
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly trackedHashes: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
  }>;
};

type ScenarioRepository = {
  readonly workspace: string;
  readonly fixture: RepositoryFixture;
  readonly linkedWorktree: string | null;
  readonly linkedWorktreeCapability:
    | { readonly status: "not_requested" }
    | { readonly status: "supported" }
    | {
      readonly status: "gated";
      readonly reason: LinkedWorktreeCapabilityGateReason;
    };
  readonly cleanup: () => void;
};

type CreatedProfile = {
  readonly profile: { readonly id: string };
  readonly token: string;
};

type ProjectSummary = {
  readonly project: { readonly id: string; readonly revision: number };
  readonly recordsByKind: Readonly<Record<string, number>>;
  readonly activeTasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
  }>;
};

type McpChild = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

type LinkedWorktreeAdder = (
  fixture: RepositoryFixture,
  candidate: string,
) => void;

type LinkedWorktreeCapabilityGateReason =
  | "os_enosys"
  | "os_enotsup"
  | "git_operation_not_supported"
  | "git_function_not_implemented";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const taskKey = "task.validate-onboarding";
const taskTitle = "Validate the imported release path";
const visionTitle = "Keep repository knowledge reviewable";
const outcomeTitle = "Ship a verified synthetic onboarding";
const constraintTitle = "Preserve every source byte";
const nonGoalTitle = "Do not execute repository code";
const decisionTitle = "Use the Godot subtree as canonical";
const componentTitle = "Synthetic onboarding runtime";
const evidenceTitle = "Synthetic repository README";
const possibleEmail = "onboarding-owner@example.invalid";
const possibleEmailMask = "[REDACTED:EMAIL:1]";
const excludedFileCanary = "UNTRACKED_SCRIPT_MUST_NOT_REACH_CONTEXT";
const detectorCanary =
  "sk-proj-SyntheticImporterCredentialCanary0123456789";
const GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
let packageRoot: string;
let cliExecutable: string;
let mcpExecutable: string;

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          "INTENTARC_DB_PATH",
          "INTENTARC_PROFILE_ID",
          "INTENTARC_PROFILE_TOKEN",
        ].includes(entry[0]),
    ),
  );

const runProcess = (
  command: string,
  arguments_: readonly string[],
  environment: Record<string, string> = inheritedEnvironment(),
): Promise<ProcessResult> =>
  new Promise((resolveProcess, reject) => {
    const child = spawn(command, arguments_, {
      cwd: packageRoot,
      env: environment,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({ code, stdout, stderr });
    });
    child.stdin.end();
  });

const runCli = (
  arguments_: readonly string[],
  databasePath?: string,
): Promise<ProcessResult> =>
  runProcess(process.execPath, [
    cliExecutable,
    ...(databasePath === undefined ? [] : ["--db", databasePath]),
    ...arguments_,
  ]);

const successfulJson = async <Result>(
  operation: Promise<ProcessResult>,
): Promise<Result> => {
  const result = await operation;
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as Result;
};

const sha256 = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const hardenedGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  ),
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const runReadOnlyGit = (
  root: string,
  arguments_: readonly string[],
): string =>
  execFileSync("git", [
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
  ], {
    encoding: "utf8",
    env: hardenedGitEnvironment(),
    windowsHide: true,
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });

const captureSource = (fixture: RepositoryFixture): SourceSnapshot => {
  const runGit = (arguments_: readonly string[]): string =>
    runReadOnlyGit(fixture.root, arguments_);
  const indexOutput = runGit(["rev-parse", "--git-path", "index"]).trim();
  const indexPath = resolve(fixture.root, indexOutput);
  const indexBefore = readFileSync(indexPath);
  const tracked = runGit(["ls-files", "-z"])
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const snapshot: SourceSnapshot = {
    status: runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    head: runGit(["rev-parse", "HEAD"]).trim(),
    worktrees: runGit(["worktree", "list", "--porcelain"]),
    index: {
      byteSize: indexBefore.byteLength,
      sha256: sha256(indexBefore),
    },
    trackedHashes: tracked.map((path) => ({
      path: path.replaceAll("\\", "/"),
      sha256: sha256(readFileSync(resolve(fixture.root, path))),
    })),
  };
  expect(readFileSync(indexPath)).toEqual(indexBefore);
  return snapshot;
};

const expectSourceUnchanged = (
  fixture: RepositoryFixture,
  expected: SourceSnapshot,
): void => {
  expect(captureSource(fixture)).toEqual(expected);
};

const runCliPreservingSource = async (
  fixture: RepositoryFixture,
  expected: SourceSnapshot,
  arguments_: readonly string[],
  databasePath?: string,
): Promise<ProcessResult> => {
  const result = await runCli(arguments_, databasePath);
  expectSourceUnchanged(fixture, expected);
  return result;
};

const callToolPreservingSource = async (
  fixture: RepositoryFixture,
  expected: SourceSnapshot,
  child: McpChild,
  input: Parameters<Client["callTool"]>[0],
) => {
  const result = await child.client.callTool(input);
  expectSourceUnchanged(fixture, expected);
  return result;
};

const writeManifest = (
  path: string,
  manifest: RepositoryImportManifest,
): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

const readManifest = (path: string): RepositoryImportManifest =>
  JSON.parse(readFileSync(path, "utf8")) as RepositoryImportManifest;

const curatedRecord = (
  key: string,
  kind: ProposedImportRecord["kind"],
  status: ProposedImportRecord["status"],
  title: string,
  body: string,
): ProposedImportRecord => ({
  key,
  kind,
  status,
  title,
  body,
  sourceKind: "agent",
  sourceRef: null,
  sourceRefs: [],
  curationReason: "Curated for the synthetic packaged onboarding proof.",
});

const addCuratedProposal = (
  manifest: RepositoryImportManifest,
  taskBody = "Confirm scan, import, context, and outbound release behavior.",
): void => {
  manifest.proposal.records.push(
    curatedRecord(
      "vision.reviewable-knowledge",
      "vision",
      "accepted",
      visionTitle,
      "Keep existing-project knowledge explicit and reviewable.",
    ),
    curatedRecord(
      "outcome.verified-onboarding",
      "outcome",
      "accepted",
      outcomeTitle,
      "Complete the synthetic onboarding proof through packaged boundaries.",
    ),
    curatedRecord(
      "constraint.preserve-source",
      "constraint",
      "accepted",
      constraintTitle,
      "Scanning and importing must leave source state unchanged.",
    ),
    curatedRecord(
      "non-goal.execute-code",
      "non_goal",
      "accepted",
      nonGoalTitle,
      "Onboarding does not run project scripts, tests, or the Godot editor.",
    ),
    curatedRecord(
      taskKey,
      "task",
      "active",
      taskTitle,
      taskBody,
    ),
    curatedRecord(
      "decision.canonical-godot",
      "decision",
      "accepted",
      decisionTitle,
      "Treat godot/ as the canonical implementation boundary.",
    ),
    curatedRecord(
      "component.onboarding-runtime",
      "component",
      "accepted",
      componentTitle,
      "The canonical runtime represented by the synthetic core and UI.",
    ),
    curatedRecord(
      "evidence.synthetic-readme",
      "evidence",
      "accepted",
      evidenceTitle,
      "README.md and godot/project.godot support this curated graph.",
    ),
  );
  manifest.proposal.relationships.push(
    { fromKey: taskKey, toKey: "vision.reviewable-knowledge", kind: "related_to" },
    { fromKey: taskKey, toKey: "outcome.verified-onboarding", kind: "implements" },
    { fromKey: taskKey, toKey: "constraint.preserve-source", kind: "constrained_by" },
    { fromKey: taskKey, toKey: "non-goal.execute-code", kind: "related_to" },
    { fromKey: taskKey, toKey: "decision.canonical-godot", kind: "decided_by" },
    { fromKey: taskKey, toKey: "component.onboarding-runtime", kind: "implements" },
    { fromKey: taskKey, toKey: "evidence.synthetic-readme", kind: "evidenced_by" },
  );
};

const linkedWorktreeCapabilityGateReason = (
  error: unknown,
): LinkedWorktreeCapabilityGateReason | null => {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    readonly code?: unknown;
    readonly stderr?: unknown;
  };
  if (candidate.code === "ENOSYS") return "os_enosys";
  if (candidate.code === "ENOTSUP") return "os_enotsup";

  const stderr = Buffer.isBuffer(candidate.stderr)
    ? candidate.stderr.toString("utf8")
    : typeof candidate.stderr === "string"
      ? candidate.stderr
      : "";
  const lines = stderr.trim().split(/\r?\n/);
  if (lines.some((line) => /(?:^|: )operation not supported\.?$/i.test(line))) {
    return "git_operation_not_supported";
  }
  if (lines.some((line) => /(?:^|: )function not implemented\.?$/i.test(line))) {
    return "git_function_not_implemented";
  }
  return null;
};

const createGodotRepository = (
  includeLinkedWorktree = false,
  addLinkedWorktree: LinkedWorktreeAdder = (fixture, candidate) => {
    fixture.runGit(["worktree", "add", "--detach", candidate]);
  },
): ScenarioRepository => {
  const scenarioCache = join(
    repositoryRoot,
    "node_modules",
    ".cache",
    "intentarc-existing-project-onboarding",
  );
  mkdirSync(scenarioCache, { recursive: true });
  const workspace = mkdtempSync(join(scenarioCache, "scenario-"));
  const repositoryParent = join(workspace, "repositories");
  mkdirSync(repositoryParent, { recursive: true });
  const fixture = createRepositoryFixture({
    ".gitignore": "node_modules/\n.godot/\nbuild/\n",
    "README.md": [
      "# Synthetic Godot project",
      "",
      "The repository is used only by packaged onboarding tests.",
      "",
    ].join("\n"),
    "godot/project.godot": [
      "; Engine configuration file.",
      "[application]",
      'config/name="Synthetic Onboarding"',
      'config/features=PackedStringArray("4.7")',
      'run/main_scene="res://src/ui/main.tscn"',
      "",
    ].join("\n"),
    "godot/src/core/runtime.gd": [
      "class_name SyntheticRuntime",
      "func tick() -> void:",
      "\tpass",
      "",
    ].join("\n"),
    "godot/src/ui/hud.gd": [
      "class_name SyntheticHud",
      "func render() -> void:",
      "\tpass",
      "",
    ].join("\n"),
    "godot/tests/runtime_test.gd": [
      "func test_runtime() -> void:",
      "\tassert_true(true)",
      "",
    ].join("\n"),
    "godot/assets/icon.png": Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]),
  }, { parentDirectory: repositoryParent });

  fixture.write(
    "godot/src/ui/hud.gd",
    [
      "class_name SyntheticHud",
      "func render() -> void:",
      "\t# Dirty tracked work must be preserved.",
      "\tpass",
      "",
    ].join("\n"),
  );
  fixture.write(
    "docs/HANDOFF.md",
    "# Local handoff\n\nPreserve this recognized untracked document.\n",
  );
  fixture.write(
    "scripts/local-only.gd",
    `${excludedFileCanary}\napi_key=${detectorCanary}\n`,
  );
  fixture.write(
    "node_modules/synthetic-dependency/index.js",
    `export const ignored = "${excludedFileCanary}";\n`,
  );

  let linkedWorktree: string | null = null;
  let linkedWorktreeCapability: ScenarioRepository["linkedWorktreeCapability"] =
    { status: "not_requested" };
  if (includeLinkedWorktree) {
    const candidate = join(workspace, "linked worktree");
    try {
      addLinkedWorktree(fixture, candidate);
      linkedWorktree = candidate;
      linkedWorktreeCapability = { status: "supported" };
    } catch (error) {
      const gateReason = linkedWorktreeCapabilityGateReason(error);
      rmSync(candidate, { recursive: true, force: true });
      if (gateReason === null) {
        fixture.cleanup();
        rmSync(workspace, { recursive: true, force: true });
        throw error;
      }
      linkedWorktreeCapability = {
        status: "gated",
        reason: gateReason,
      };
    }
  }

  return {
    workspace,
    fixture,
    linkedWorktree,
    linkedWorktreeCapability,
    cleanup: () => {
      if (linkedWorktree !== null) {
        try {
          fixture.runGit(["worktree", "remove", "--force", linkedWorktree]);
        } catch {
          // The workspace removal below is the final bounded cleanup.
        }
      }
      fixture.cleanup();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
};

const scan = async (
  repository: ScenarioRepository,
  manifestPath: string,
  expected: SourceSnapshot,
): Promise<ProcessResult> => {
  mkdirSync(dirname(manifestPath), { recursive: true });
  return runCliPreservingSource(repository.fixture, expected, [
    "project",
    "import",
    "scan",
    "--repository",
    repository.fixture.root,
    "--canonical-subpath",
    "godot",
    "--manifest",
    manifestPath,
  ]);
};

const inspect = async (
  repository: ScenarioRepository,
  manifestPath: string,
  expected: SourceSnapshot,
): Promise<ProcessResult> =>
  runCliPreservingSource(repository.fixture, expected, [
    "project",
    "import",
    "inspect",
    "--manifest",
    manifestPath,
  ]);

const apply = async (
  repository: ScenarioRepository,
  databasePath: string,
  manifestPath: string,
  digest: string,
  expected: SourceSnapshot,
): Promise<ProcessResult> =>
  runCliPreservingSource(
    repository.fixture,
    expected,
    [
      "project",
      "import",
      "apply",
      "--manifest",
      manifestPath,
      "--confirm-digest",
      digest,
    ],
    databasePath,
  );

const emptyImportState = (
  databasePath: string,
): { projects: number; receipts: number; audits: number } => {
  if (!existsSync(databasePath)) {
    return { projects: 0, receipts: 0, audits: 0 };
  }
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const count = (table: string): number => {
      const exists = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table);
      if (exists === undefined) return 0;
      return (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
    };
    return {
      projects: count("projects"),
      receipts: count("repository_import_receipts"),
      audits: count("audit_events"),
    };
  } finally {
    database.close();
  }
};

const expectNoImportState = (databasePath: string): void => {
  expect(emptyImportState(databasePath)).toEqual({
    projects: 0,
    receipts: 0,
    audits: 0,
  });
};

const openMcpChild = async (
  databasePath: string,
  credentials: CreatedProfile,
): Promise<McpChild> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpExecutable],
    cwd: packageRoot,
    env: {
      ...inheritedEnvironment(),
      INTENTARC_DB_PATH: databasePath,
      INTENTARC_PROFILE_ID: credentials.profile.id,
      INTENTARC_PROFILE_TOKEN: credentials.token,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "intentarc-existing-project-onboarding-scenario",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
};

const closeMcpChild = async (
  child: McpChild | undefined,
): Promise<void> => {
  if (child === undefined) return;
  await Promise.allSettled([child.client.close(), child.transport.close()]);
};

const expectCanariesAbsent = (value: unknown, canaries: readonly string[]): void => {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) expect(serialized).not.toContain(canary);
};

describe("packaged existing-project onboarding", () => {
  const repositories: ScenarioRepository[] = [];
  let mcpChild: McpChild | undefined;

  beforeAll(async () => {
    const build = await ensurePackagedTestBuild(repositoryRoot);
    packageRoot = build.packageRoot;
    cliExecutable = resolve(packageRoot, "dist", "cli", "bin.js");
    mcpExecutable = resolve(packageRoot, "dist", "mcp", "bin.js");
  }, 45_000);

  afterEach(async () => {
    await closeMcpChild(mcpChild);
    mcpChild = undefined;
    repositories.splice(0).forEach((repository) => repository.cleanup());
  });

  const temporaryRepository = (
    includeLinkedWorktree = false,
  ): ScenarioRepository => {
    const repository = createGodotRepository(includeLinkedWorktree);
    repositories.push(repository);
    return repository;
  };

  it("captures source and index baselines without executing repository-controlled Git code", () => {
    const repository = temporaryRepository();
    const hookName = process.platform === "win32"
      ? "baseline-fsmonitor.cmd"
      : "baseline-fsmonitor.sh";
    const hookPath = join(repository.fixture.root, hookName);
    const canaryPath = join(
      repository.fixture.root,
      "baseline-fsmonitor-canary.txt",
    );
    repository.fixture.write(
      hookName,
      process.platform === "win32"
        ? "@echo off\r\n> \"%~dp0baseline-fsmonitor-canary.txt\" echo invoked\r\nexit /b 0\r\n"
        : "#!/bin/sh\nprintf invoked > \"$(dirname \"$0\")/baseline-fsmonitor-canary.txt\"\nexit 0\n",
    );
    if (process.platform !== "win32") chmodSync(hookPath, 0o700);
    repository.fixture.runGit([
      "config",
      "core.fsmonitor",
      `./${hookName}`,
    ]);
    const indexPath = join(repository.fixture.root, ".git", "index");
    const indexBefore = readFileSync(indexPath);

    const baseline = captureSource(repository.fixture);

    expect(existsSync(canaryPath)).toBe(false);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    expect(baseline.index).toEqual({
      byteSize: indexBefore.byteLength,
      sha256: sha256(indexBefore),
    });
    expect(captureSource(repository.fixture)).toEqual(baseline);
  });

  it("does not swallow an unexpected linked-worktree creation failure", () => {
    const failure = Object.assign(
      new Error("synthetic ordinary git failure"),
      {
        status: 128,
        stderr: Buffer.from("fatal: invalid synthetic worktree reference\n"),
      },
    );
    let created: ScenarioRepository | undefined;

    try {
      expect(() => {
        created = createGodotRepository(
          true,
          () => {
            throw failure;
          },
        );
      }).toThrow(failure);
    } finally {
      created?.cleanup();
    }
  });

  it("records an explicit gate for an unsupported linked-worktree capability", () => {
    const capabilityError = Object.assign(
      new Error("synthetic unsupported filesystem capability"),
      { code: "ENOTSUP" },
    );
    const repository = createGodotRepository(
      true,
      () => {
        throw capabilityError;
      },
    );

    try {
      expect(repository.linkedWorktree).toBeNull();
      expect(repository.linkedWorktreeCapability).toEqual({
        status: "gated",
        reason: "os_enotsup",
      });
    } finally {
      repository.cleanup();
    }
  });

  it("scans, curates, applies, replays, selects, and releases without mutating the dirty Godot source", async () => {
    const repository = temporaryRepository(true);
    const baseline = captureSource(repository.fixture);
    const manifestAPath = join(repository.workspace, "artifacts", "manifest-a.json");
    const manifestBPath = join(repository.workspace, "artifacts", "manifest-b.json");
    const databasePath = join(repository.workspace, "state", "onboarding.sqlite");

    expect(baseline.status).toContain(" M godot/src/ui/hud.gd");
    expect(baseline.status).toContain("?? docs/HANDOFF.md");
    expect(baseline.status).toContain("?? scripts/local-only.gd");
    expect(baseline.status).not.toContain("node_modules/");
    switch (repository.linkedWorktreeCapability.status) {
      case "supported":
        expect(repository.linkedWorktree).not.toBeNull();
        expect(baseline.worktrees).toContain(
          repository.linkedWorktree!.replaceAll("\\", "/"),
        );
        break;
      case "gated":
        expect(repository.linkedWorktree).toBeNull();
        expect([
          "os_enosys",
          "os_enotsup",
          "git_operation_not_supported",
          "git_function_not_implemented",
        ]).toContain(repository.linkedWorktreeCapability.reason);
        break;
      case "not_requested":
        throw new Error(
          "The linked-worktree capability probe was not executed",
        );
    }

    await successfulJson(scan(repository, manifestAPath, baseline));
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    await successfulJson(scan(repository, manifestBPath, baseline));
    const manifestA = readManifest(manifestAPath);
    const manifestB = readManifest(manifestBPath);
    expect(manifestA.createdAt).not.toBe(manifestB.createdAt);
    expect(manifestA.repository.canonicalSubpath).toBe("godot");
    expect(manifestA.discovery.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", status: "tracked" }),
      expect.objectContaining({ path: "docs/HANDOFF.md", status: "untracked" }),
      expect.objectContaining({ path: "godot/project.godot", status: "tracked" }),
      expect.objectContaining({ path: "godot/src/core/runtime.gd", role: "canonical_source" }),
      expect.objectContaining({ path: "godot/src/ui/hud.gd", role: "canonical_source" }),
      expect.objectContaining({ path: "godot/tests/runtime_test.gd", role: "test" }),
    ]));
    expect(manifestA.discovery.sources.map(({ path }) => path)).not.toContain(
      "scripts/local-only.gd",
    );
    expect(manifestA.discovery.binaryCollections).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: "godot/assets", extensions: [".png"], count: 1 }),
    ]));
    expect(JSON.stringify(manifestA)).not.toContain(detectorCanary);
    expect(JSON.stringify(manifestA)).not.toContain("synthetic-dependency");
    expect(manifestA.discovery.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "working_tree_dirty" }),
      expect.objectContaining({ code: "untracked_document" }),
    ]));
    if (repository.linkedWorktreeCapability.status === "supported") {
      expect(manifestA.discovery.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "multiple_worktrees", count: 2 }),
      ]));
    } else {
      expect(manifestA.discovery.warnings.map(({ code }) => code)).not.toContain(
        "multiple_worktrees",
      );
    }

    const inspectionA = await successfulJson<ImportInspection>(
      inspect(repository, manifestAPath, baseline),
    );
    const inspectionB = await successfulJson<ImportInspection>(
      inspect(repository, manifestBPath, baseline),
    );
    expect(inspectionA.manifestDigest).toBe(inspectionB.manifestDigest);

    const immutableBeforeCuration = {
      manifestVersion: manifestA.manifestVersion,
      scannerVersion: manifestA.scannerVersion,
      rulesetVersion: manifestA.rulesetVersion,
      createdAt: manifestA.createdAt,
      repository: structuredClone(manifestA.repository),
      discovery: structuredClone(manifestA.discovery),
    };
    const baselineRecordCount = manifestA.proposal.records.length;
    addCuratedProposal(manifestA);
    writeManifest(manifestAPath, manifestA);
    const curated = readManifest(manifestAPath);
    expect({
      manifestVersion: curated.manifestVersion,
      scannerVersion: curated.scannerVersion,
      rulesetVersion: curated.rulesetVersion,
      createdAt: curated.createdAt,
      repository: curated.repository,
      discovery: curated.discovery,
    }).toEqual(immutableBeforeCuration);
    expect(curated.proposal.records.slice(baselineRecordCount).map(({ kind }) => kind))
      .toEqual([
        "vision",
        "outcome",
        "constraint",
        "non_goal",
        "task",
        "decision",
        "component",
        "evidence",
      ]);
    expect(curated.proposal.relationships).toHaveLength(7);

    const curatedInspection = await successfulJson<ImportInspection>(
      inspect(repository, manifestAPath, baseline),
    );
    expect(curatedInspection.manifestDigest).not.toBe(inspectionA.manifestDigest);
    expect(curatedInspection.activeTasks.find(({ key }) => key === taskKey)?.directLinks)
      .toHaveLength(7);

    const firstApply = await successfulJson<ImportApplyResult>(
      apply(
        repository,
        databasePath,
        manifestAPath,
        curatedInspection.manifestDigest,
        baseline,
      ),
    );
    expect(firstApply).toMatchObject({
      manifestDigest: curatedInspection.manifestDigest,
      replayed: false,
      revisionBefore: 0,
      revisionAfter: 1,
    });
    const replay = await successfulJson<ImportApplyResult>(
      apply(
        repository,
        databasePath,
        manifestAPath,
        curatedInspection.manifestDigest,
        baseline,
      ),
    );
    expect(replay).toMatchObject({
      projectId: firstApply.projectId,
      manifestDigest: curatedInspection.manifestDigest,
      replayed: true,
      revisionBefore: 0,
      revisionAfter: 1,
    });

    const summary = await successfulJson<ProjectSummary>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        ["project", "summary", "--project", firstApply.projectId],
        databasePath,
      ),
    );
    expect(summary.project).toMatchObject({ id: firstApply.projectId, revision: 1 });
    expect(summary.recordsByKind).toMatchObject({
      vision: 1,
      outcome: 1,
      constraint: 1,
      non_goal: 1,
      task: 1,
      decision: 1,
    });
    const importedTask = summary.activeTasks.find(({ title }) => title === taskTitle);
    expect(importedTask).toBeDefined();

    const localContext = await successfulJson<TaskContextPack>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        [
          "context",
          "get",
          "--project",
          firstApply.projectId,
          "--task",
          importedTask!.id,
          "--budget",
          "4000",
        ],
        databasePath,
      ),
    );
    expect(localContext.stableFrame.map(({ record }) => record.title)).toEqual([
      visionTitle,
      outcomeTitle,
      constraintTitle,
      nonGoalTitle,
    ]);
    expect(localContext.task.record.title).toBe(taskTitle);
    expect(new Set(localContext.related.map(({ record }) => record.title))).toEqual(
      new Set([decisionTitle, componentTitle, evidenceTitle]),
    );

    const credentials = await successfulJson<CreatedProfile>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        [
          "profile",
          "create",
          "--name",
          "Synthetic packaged onboarding client",
          "--project",
          firstApply.projectId,
        ],
        databasePath,
      ),
    );
    const listedProfiles = await successfulJson<unknown>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        ["profile", "list"],
        databasePath,
      ),
    );
    expect(JSON.stringify(listedProfiles)).not.toContain(credentials.token);
    await successfulJson(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        [
          "profile",
          "destination",
          "set",
          "--profile",
          credentials.profile.id,
          "--client-label",
          "Synthetic packaged MCP client",
          "--type",
          "ide_managed",
          "--provider",
          "Synthetic declared provider",
          "--model",
          "Synthetic declared model",
          "--account-boundary",
          "Synthetic local account",
          "--data-boundary",
          "remote",
        ],
        databasePath,
      ),
    );

    mcpChild = await openMcpChild(databasePath, credentials);
    expectSourceUnchanged(repository.fixture, baseline);
    const requestResult = await callToolPreservingSource(
      repository.fixture,
      baseline,
      mcpChild,
      {
        name: "request_task_context",
        arguments: {
          projectId: firstApply.projectId,
          taskId: importedTask!.id,
          budgetTokens: 4000,
          idempotencyKey: "synthetic-onboarding-outbound-request",
        },
      },
    );
    expect(requestResult.isError).not.toBe(true);
    const request = requestTaskContextResultSchema.parse(
      requestResult.structuredContent,
    );
    expect(request).toMatchObject({
      status: "review_required",
      findingCounts: { credential: 0, forcedRedact: 0 },
    });
    expectCanariesAbsent(requestResult, [
      excludedFileCanary,
      detectorCanary,
      credentials.token,
    ]);

    const outboundInspection = await successfulJson<OutboundInspection>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        [
          "context",
          "outbound",
          "inspect",
          "--request",
          request.requestId,
        ],
        databasePath,
      ),
    );
    expect(outboundInspection).toMatchObject({
      request: { requestId: request.requestId },
    });
    expect(outboundInspection.findings).toHaveLength(
      request.findingCounts.total,
    );
    expect(outboundInspection.findings.every(
      ({ category, severity, requiredAction }) =>
        category === "phone" &&
        severity === "sensitive" &&
        requiredAction === "redact_by_default",
    )).toBe(true);
    expectCanariesAbsent(outboundInspection, [
      excludedFileCanary,
      detectorCanary,
      credentials.token,
    ]);
    await successfulJson(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        [
          "context",
          "outbound",
          "approve",
          "--request",
          request.requestId,
        ],
        databasePath,
      ),
    );

    const retrievalResult = await callToolPreservingSource(
      repository.fixture,
      baseline,
      mcpChild,
      {
        name: "get_released_context",
        arguments: { requestId: request.requestId },
      },
    );
    expect(retrievalResult.isError).not.toBe(true);
    const retrieval = getReleasedContextResultSchema.parse(
      retrievalResult.structuredContent,
    );
    expect(retrieval.status).toBe("released");
    if (retrieval.status !== "released") {
      throw new Error("Expected an approved outbound release");
    }
    expect(retrieval.release.pack.stableFrame.map(({ record }) => record.title))
      .toEqual([visionTitle, outcomeTitle, constraintTitle, nonGoalTitle]);
    expect(retrieval.release.pack.task.record.title).toBe(taskTitle);
    expect(new Set(retrieval.release.pack.related.map(({ record }) => record.title)))
      .toEqual(new Set([decisionTitle, componentTitle, evidenceTitle]));
    expectCanariesAbsent(retrieval, [
      excludedFileCanary,
      detectorCanary,
      credentials.token,
    ]);
    await closeMcpChild(mcpChild);
    mcpChild = undefined;
    expectSourceUnchanged(repository.fixture, baseline);
  }, 90_000);

  it("rejects first-apply source drift without creating import state", async () => {
    const repository = temporaryRepository();
    const baseline = captureSource(repository.fixture);
    const manifestPath = join(repository.workspace, "artifacts", "drift.json");
    const databasePath = join(repository.workspace, "state", "drift.sqlite");
    await successfulJson(scan(repository, manifestPath, baseline));
    const inspection = await successfulJson<ImportInspection>(
      inspect(repository, manifestPath, baseline),
    );

    repository.fixture.write(
      "README.md",
      "# Synthetic Godot project\n\nSelected content drifted after scan.\n",
    );
    const driftedBaseline = captureSource(repository.fixture);
    const rejected = await apply(
      repository,
      databasePath,
      manifestPath,
      inspection.manifestDigest,
      driftedBaseline,
    );
    expect(rejected).toMatchObject({ code: 1, stdout: "" });
    expect(rejected.stderr).toContain("source_drift");
    expectNoImportState(databasePath);
  }, 30_000);

  it("blocks a curated credential during inspect and apply without disclosure or state", async () => {
    const repository = temporaryRepository();
    const baseline = captureSource(repository.fixture);
    const manifestPath = join(repository.workspace, "artifacts", "credential.json");
    const databasePath = join(repository.workspace, "state", "credential.sqlite");
    await successfulJson(scan(repository, manifestPath, baseline));
    const originalInspection = await successfulJson<ImportInspection>(
      inspect(repository, manifestPath, baseline),
    );
    const manifest = readManifest(manifestPath);
    addCuratedProposal(
      manifest,
      `Use api_key=${detectorCanary} while testing the synthetic import.`,
    );
    writeManifest(manifestPath, manifest);

    const blockedInspect = await inspect(repository, manifestPath, baseline);
    expect(blockedInspect).toMatchObject({ code: 1, stdout: "" });
    expect(blockedInspect.stderr).toContain("sensitive_content_blocked");
    expect(blockedInspect.stderr).not.toContain(detectorCanary);
    expectNoImportState(databasePath);
    const blockedApply = await apply(
      repository,
      databasePath,
      manifestPath,
      originalInspection.manifestDigest,
      baseline,
    );
    expect(blockedApply).toMatchObject({ code: 1, stdout: "" });
    expect(blockedApply.stderr).toContain("sensitive_content_blocked");
    expect(blockedApply.stderr).not.toContain(detectorCanary);
    expectNoImportState(databasePath);
  }, 30_000);

  it("stores only the deterministic redaction for possible curated email content", async () => {
    const repository = temporaryRepository();
    const baseline = captureSource(repository.fixture);
    const manifestPath = join(repository.workspace, "artifacts", "email.json");
    const databasePath = join(repository.workspace, "state", "email.sqlite");
    await successfulJson(scan(repository, manifestPath, baseline));
    const manifest = readManifest(manifestPath);
    addCuratedProposal(
      manifest,
      `Contact ${possibleEmail} before finalizing the imported task.`,
    );
    writeManifest(manifestPath, manifest);
    const inspection = await successfulJson<ImportInspection>(
      inspect(repository, manifestPath, baseline),
    );
    expect(inspection.sensitiveFindings).toEqual([
      { category: "email", severity: "sensitive", count: 1 },
    ]);
    const imported = await successfulJson<ImportApplyResult>(
      apply(
        repository,
        databasePath,
        manifestPath,
        inspection.manifestDigest,
        baseline,
      ),
    );
    const summary = await successfulJson<ProjectSummary>(
      runCliPreservingSource(
        repository.fixture,
        baseline,
        ["project", "summary", "--project", imported.projectId],
        databasePath,
      ),
    );
    const task = summary.activeTasks.find(({ title }) => title === taskTitle);
    expect(task).toBeDefined();
    const contextResult = await runCliPreservingSource(
      repository.fixture,
      baseline,
      [
        "context",
        "get",
        "--project",
        imported.projectId,
        "--task",
        task!.id,
        "--budget",
        "4000",
      ],
      databasePath,
    );
    expect(contextResult).toMatchObject({ code: 0, stderr: "" });
    expect(contextResult.stdout).not.toContain(possibleEmail);
    const context = JSON.parse(contextResult.stdout) as TaskContextPack;
    expect(context.task.record.body).toBe(
      `Contact ${possibleEmailMask} before finalizing the imported task.`,
    );
    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const storedContexts = database.prepare(
        "SELECT content_json FROM context_packs ORDER BY rowid",
      ).all() as Array<{ content_json: string }>;
      expect(storedContexts).toHaveLength(1);
      expect(storedContexts[0]!.content_json).not.toContain(possibleEmail);
      expect(storedContexts[0]!.content_json).toContain(possibleEmailMask);
    } finally {
      database.close();
    }
  }, 30_000);

  it("rejects a broken proposal relationship without creating import state", async () => {
    const repository = temporaryRepository();
    const baseline = captureSource(repository.fixture);
    const manifestPath = join(repository.workspace, "artifacts", "broken-link.json");
    const databasePath = join(repository.workspace, "state", "broken-link.sqlite");
    await successfulJson(scan(repository, manifestPath, baseline));
    const originalInspection = await successfulJson<ImportInspection>(
      inspect(repository, manifestPath, baseline),
    );
    const manifest = readManifest(manifestPath);
    addCuratedProposal(manifest);
    manifest.proposal.relationships[0]!.toKey = "missing.relationship-target";
    writeManifest(manifestPath, manifest);

    const rejectedInspect = await inspect(repository, manifestPath, baseline);
    expect(rejectedInspect).toMatchObject({ code: 1, stdout: "" });
    expect(rejectedInspect.stderr).toContain("manifest_invalid");
    expectNoImportState(databasePath);
    const rejectedApply = await apply(
      repository,
      databasePath,
      manifestPath,
      originalInspection.manifestDigest,
      baseline,
    );
    expect(rejectedApply).toMatchObject({ code: 1, stdout: "" });
    expect(rejectedApply.stderr).toContain("manifest_invalid");
    expectNoImportState(databasePath);
  }, 30_000);
});
