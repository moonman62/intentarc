import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IntentArcApplication } from "../app/create-application.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import type { RepositoryImportTools } from "../core/repository-import-service.js";
import type {
  ImportInspection,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import { DurabilityError } from "../durability/errors.js";
import type { DurabilityService } from "../durability/service.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import { ensurePackagedTestBuild } from "../test-support/packaged-test-build.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../test-support/repository-fixture.js";
import { classifyCommand, runCli } from "./bin.js";

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const digest = "a".repeat(64);
const repositoryFingerprint = "b".repeat(64);
const coordinationTask = {
  id: "task-1",
  projectId: "project-1",
  kind: "task" as const,
  status: "active" as const,
  title: "Expose coordination CLI",
  body: "Add the authenticated coordination command group.",
  sourceKind: "human" as const,
  sourceRef: null,
  revision: 7,
  createdAt: "2026-08-15T08:00:00.000Z",
  updatedAt: "2026-08-15T08:00:00.000Z",
};
const coordinationReadyPage = {
  tasks: [{
    task: coordinationTask,
    blockers: [],
    liveClaimId: null,
    liveDelegationId: null,
  }],
  nextCursor: null,
  projectRevision: 3,
};

const validImportManifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: "2026-07-28T12:00:00.000Z",
  repository: {
    root: "C:/projects/example",
    canonicalSubpath: null,
    branch: "main",
    head: "c".repeat(40),
    fingerprint: repositoryFingerprint,
  },
  discovery: {
    sources: [],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Imported project",
      primaryRepositoryPath: "C:/projects/example",
    },
    records: [],
    relationships: [],
  },
});

const validImportInspection = (
  candidate: RepositoryImportManifest,
): ImportInspection => ({
  manifestDigest: digest,
  repository: candidate.repository,
  project: candidate.proposal.project,
  counts: {
    recordsByKind: [],
    recordsByStatus: [],
    recordsBySourceKind: [],
  },
  stableFrame: [],
  activeTasks: [],
  curatedOrProvisionalClaims: [],
  sensitiveFindings: [],
  warnings: [],
  exclusions: [],
});

const captureOutput = () => {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text: () => value,
  };
};

describe("IntentArc CLI startup routing", () => {
  it.each([
    [["--help"], "informational"],
    [["backup", "--help"], "informational"],
    [["integrity", "check"], "durability"],
    [["backup", "create"], "durability"],
    [["backup", "verify", "--backup", "x"], "durability"],
    [[
      "project", "import", "scan", "--repository", "C:\\repo",
    ], "import_read"],
    [[
      "project", "import", "inspect", "--manifest", "C:\\m.json",
    ], "import_read"],
    [[
      "project", "import", "apply", "--manifest", "C:\\m.json",
    ], "application"],
    [["project", "list"], "application"],
  ] as const)("classifies %j as %s", (arguments_, expected) => {
    expect(classifyCommand(arguments_)).toBe(expected);
  });

  it("runs durability commands without opening the normal application", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const checkIntegrity = vi.fn().mockResolvedValue({ passed: true });
    const durability = {
      checkIntegrity,
      createBackup: vi.fn(),
      listBackups: vi.fn(),
      verifyBackup: vi.fn(),
      restoreBackup: vi.fn(),
    } as unknown as DurabilityService;
    const openApplication = vi.fn();
    const setExitCode = vi.fn();
    const databasePath = resolve("relative/intentarc.sqlite");

    await runCli(["--db", "relative/intentarc.sqlite", "integrity", "check"], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      createDurabilityService: () => durability,
      openApplication,
      setExitCode,
    });

    expect(openApplication).not.toHaveBeenCalled();
    expect(checkIntegrity).toHaveBeenCalledWith(databasePath);
    expect(stdout.text()).toBe(`${JSON.stringify({ passed: true }, null, 2)}\n`);
    expect(stderr.text()).toBe("");
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it("awaits normal application opening only for application commands", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const listProjects = vi.fn().mockReturnValue([]);
    const application = {
      service: { listProjects } as unknown as IntentArcService,
      close: vi.fn(),
    } satisfies IntentArcApplication;
    const openApplication = vi.fn().mockResolvedValue(application);
    const createDurabilityService = vi.fn();

    await runCli(["--db=relative/intentarc.sqlite", "project", "list"], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      createDurabilityService,
      openApplication,
      setExitCode: vi.fn(),
    });

    expect(openApplication).toHaveBeenCalledWith({
      databasePath: resolve("relative/intentarc.sqlite"),
    });
    expect(createDurabilityService).not.toHaveBeenCalled();
    expect(stdout.text()).toBe("[]\n");
    expect(application.close).toHaveBeenCalledTimes(1);
  });

  it("loads coordination profile credentials only from the exact environment variables", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const authenticate = vi.fn().mockReturnValue({
      id: "profile-1",
      name: "Coordination worker",
      status: "enabled",
      credentialGeneration: "generation-1",
    });
    const revalidatePrincipal = vi.fn((candidate) => candidate);
    const listReadyTasks = vi.fn().mockReturnValue(coordinationReadyPage);
    const application = {
      service: {
        profiles: { authenticate, revalidatePrincipal },
        coordination: { listReadyTasks },
      } as unknown as IntentArcService,
      close: vi.fn(),
    } satisfies IntentArcApplication;
    const setExitCode = vi.fn();

    await runCli([
      "--db", "relative/intentarc.sqlite", "coordination", "ready",
      "--project", "project-1", "--expected-project-revision", "3",
    ], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      environment: {
        INTENTARC_PROFILE_ID: "profile-1",
        INTENTARC_PROFILE_TOKEN: "environment-token-must-not-leak",
      },
      openApplication: vi.fn().mockResolvedValue(application),
      setExitCode,
    });

    expect(authenticate).toHaveBeenCalledWith({
      profileId: "profile-1",
      token: "environment-token-must-not-leak",
    });
    expect(listReadyTasks).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.text())).toEqual(coordinationReadyPage);
    expect(stderr.text()).toBe("");
    expect(stderr.text()).not.toContain("environment-token-must-not-leak");
    expect(setExitCode).not.toHaveBeenCalled();
    expect(application.close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ INTENTARC_PROFILE_ID: "profile-1" }, "profile-1"],
    [{ INTENTARC_PROFILE_TOKEN: "partial-token-must-not-leak" }, "partial-token-must-not-leak"],
  ])("rejects a partial coordination credential environment before opening the application", async (
    environment,
    privateValue,
  ) => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const openApplication = vi.fn();
    const setExitCode = vi.fn();

    await runCli(["--db", "relative/intentarc.sqlite", "project", "list"], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      environment,
      openApplication,
      setExitCode,
    });

    expect(openApplication).not.toHaveBeenCalled();
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("Invalid command input.\n");
    expect(stderr.text()).not.toContain(privateValue);
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it("requires --db before opening outbound application commands", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const openApplication = vi.fn();
    const setExitCode = vi.fn();

    await runCli(["context", "outbound", "list"], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      openApplication,
      setExitCode,
    });

    expect(openApplication).not.toHaveBeenCalled();
    expect(stderr.text()).toBe("Invalid command input.\n");
    expect(stdout.text()).toBe("");
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it("runs scan and inspect without opening a database application", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const setExitCode = vi.fn();
    const openApplication = vi.fn();
    const repositoryImportTools = {
      scan: vi.fn(),
      inspect: vi.fn(),
    } as unknown as RepositoryImportTools;

    await runCli([
      "project",
      "import",
      "inspect",
      "--manifest",
      "missing.json",
    ], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      createRepositoryImportTools: () => repositoryImportTools,
      openApplication,
      setExitCode,
    });

    expect(openApplication).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(stderr.text()).toBe(
      "manifest_invalid: Import manifest is invalid.\n",
    );
  });

  it("requires --db for import apply before reading its manifest", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const setExitCode = vi.fn();
    const openApplication = vi.fn();

    await runCli([
      "project",
      "import",
      "apply",
      "--manifest",
      "private-manifest.json",
      "--confirm-digest",
      digest,
    ], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      openApplication,
      setExitCode,
    });

    expect(openApplication).not.toHaveBeenCalled();
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("Invalid command input.\n");
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it("does not create a database when interactive import apply is cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
    try {
      const databasePath = join(directory, "must-not-exist.sqlite");
      const manifestPath = join(directory, "candidate.json");
      await writeFile(manifestPath, JSON.stringify(validImportManifest()));
      const stdout = captureOutput();
      const stderr = captureOutput();
      const setExitCode = vi.fn();
      const confirmationService = {
        confirm: vi.fn().mockResolvedValue(false),
      };

      await runCli([
        "--db",
        databasePath,
        "project",
        "import",
        "apply",
        "--manifest",
        manifestPath,
      ], {
        stdout,
        stderr,
        stdin: { isTTY: true },
        confirmationService,
        setExitCode,
      });

      await expect(access(databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(confirmationService.confirm).toHaveBeenCalledTimes(1);
      expect(stdout.text()).toContain('"cancelled": true');
      expect(stderr.text()).toBe("");
      expect(setExitCode).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create a database for malformed import apply input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
    try {
      const databasePath = join(directory, "must-not-exist.sqlite");
      const manifestPath = join(directory, "malformed.json");
      await writeFile(manifestPath, "{ PRIVATE MALFORMED MANIFEST");
      const stderr = captureOutput();
      const setExitCode = vi.fn();

      await runCli([
        "--db",
        databasePath,
        "project",
        "import",
        "apply",
        "--manifest",
        manifestPath,
        "--confirm-digest",
        digest,
      ], {
        stdout: captureOutput(),
        stderr,
        stdin: { isTTY: false },
        confirmationService: { confirm: vi.fn() },
        setExitCode,
      });

      await expect(access(databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(stderr.text()).toBe(
        "manifest_invalid: Import manifest is invalid.\n",
      );
      expect(stderr.text()).not.toContain("PRIVATE MALFORMED MANIFEST");
      expect(setExitCode).toHaveBeenCalledWith(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create a database when non-TTY import apply lacks a digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
    try {
      const databasePath = join(directory, "must-not-exist.sqlite");
      const manifestPath = join(directory, "candidate.json");
      await writeFile(manifestPath, JSON.stringify(validImportManifest()));
      const stderr = captureOutput();
      const setExitCode = vi.fn();

      await runCli([
        "--db",
        databasePath,
        "project",
        "import",
        "apply",
        "--manifest",
        manifestPath,
      ], {
        stdout: captureOutput(),
        stderr,
        stdin: { isTTY: false },
        confirmationService: { confirm: vi.fn() },
        setExitCode,
      });

      await expect(access(databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(stderr.text()).toBe("Invalid command input.\n");
      expect(setExitCode).toHaveBeenCalledWith(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create a database when import apply confirmation has the wrong digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
    try {
      const databasePath = join(directory, "must-not-exist.sqlite");
      const manifestPath = join(directory, "candidate.json");
      await writeFile(manifestPath, JSON.stringify(validImportManifest()));
      const stderr = captureOutput();
      const setExitCode = vi.fn();

      await runCli([
        "--db",
        databasePath,
        "project",
        "import",
        "apply",
        "--manifest",
        manifestPath,
        "--confirm-digest",
        digest,
      ], {
        stdout: captureOutput(),
        stderr,
        stdin: { isTTY: false },
        confirmationService: { confirm: vi.fn() },
        setExitCode,
      });

      await expect(access(databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(stderr.text()).toMatch(
        /^manifest_digest_mismatch: Import manifest digest does not match confirmation\./,
      );
      expect(stderr.text()).toContain(
        `"actualDigest":"${digest}"`,
      );
      expect(setExitCode).toHaveBeenCalledWith(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["manifest directly inside", "manifest", false],
    ["manifest through a junction into", "manifest", true],
    ["database directly inside", "database", false],
    ["database through a junction into", "database", true],
  ] as const)(
    "rejects a %s the repository before opening any database artifact",
    async (_label, containedTarget, aliased) => {
      const directory = await mkdtemp(join(tmpdir(), "intentarc-containment-"));
      try {
        const repository = join(directory, "repository");
        const alias = join(directory, "repository-alias");
        await mkdir(repository);
        if (aliased) {
          await symlink(
            repository,
            alias,
            process.platform === "win32" ? "junction" : "dir",
          );
        }

        const containedRoot = aliased ? alias : repository;
        const actualManifestPath = join(repository, "candidate.json");
        const manifestPath = containedTarget === "manifest"
          ? join(containedRoot, "candidate.json")
          : join(directory, "candidate.json");
        const actualDatabasePath = join(repository, "intentarc.sqlite");
        const databasePath = containedTarget === "database"
          ? join(containedRoot, "intentarc.sqlite")
          : join(directory, "intentarc.sqlite");
        const databaseArtifactPath = containedTarget === "database"
          ? actualDatabasePath
          : databasePath;
        const candidate = validImportManifest();
        const canonicalRepository = repository.replaceAll("\\", "/");
        candidate.repository.root = canonicalRepository;
        candidate.proposal.project.primaryRepositoryPath =
          canonicalRepository;
        const candidateInspection = validImportInspection(candidate);
        const repositoryImportTools: RepositoryImportTools = {
          scan: vi.fn(),
          inspect: vi.fn(() => candidateInspection),
        };
        await writeFile(manifestPath, JSON.stringify(candidate));

        const stdout = captureOutput();
        const stderr = captureOutput();
        const openApplication = vi.fn();
        const setExitCode = vi.fn();

        await runCli([
          "--db",
          databasePath,
          "project",
          "import",
          "apply",
          "--manifest",
          manifestPath,
          "--confirm-digest",
          candidateInspection.manifestDigest,
        ], {
          stdout,
          stderr,
          stdin: { isTTY: false },
          confirmationService: { confirm: vi.fn() },
          createRepositoryImportTools: () => repositoryImportTools,
          openApplication,
          setExitCode,
        });

        expect(openApplication).not.toHaveBeenCalled();
        expect(stdout.text()).toBe("");
        expect(stderr.text()).toContain("path_escape");
        expect(setExitCode).toHaveBeenCalledWith(1);
        for (const artifact of [
          databaseArtifactPath,
          `${databaseArtifactPath}-wal`,
          `${databaseArtifactPath}-shm`,
          `${databaseArtifactPath}-journal`,
          `${databaseArtifactPath}.intentarc-lock`,
        ]) {
          await expect(access(artifact)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        if (containedTarget === "database") {
          await expect(access(actualManifestPath)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("opens once and applies the exact preflight object without prompting twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
    try {
      const databasePath = join(directory, "application.sqlite");
      const manifestPath = join(directory, "candidate.json");
      const candidate = validImportManifest();
      await writeFile(manifestPath, JSON.stringify(candidate));
      const apply = vi.fn((input: {
        manifest: unknown;
        confirmedDigest: string;
      }) => ({
        projectId: "project-1",
        manifestDigest: input.confirmedDigest,
        repositoryFingerprint,
        revisionBefore: 0,
        revisionAfter: 1,
        replayed: false,
      }));
      const application = {
        service: {
          imports: { apply },
        } as unknown as IntentArcService,
        close: vi.fn(),
      } satisfies IntentArcApplication;
      const openApplication = vi.fn().mockResolvedValue(application);
      const confirmationService = {
        confirm: vi.fn().mockResolvedValue(true),
      };
      const setExitCode = vi.fn();

      await runCli([
        "--db",
        databasePath,
        "project",
        "import",
        "apply",
        "--manifest",
        manifestPath,
      ], {
        stdout: captureOutput(),
        stderr: captureOutput(),
        stdin: { isTTY: true },
        confirmationService,
        openApplication,
        setExitCode,
      });

      expect(confirmationService.confirm).toHaveBeenCalledTimes(1);
      expect(openApplication).toHaveBeenCalledOnce();
      expect(openApplication).toHaveBeenCalledWith({
        databasePath: resolve(databasePath),
      });
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith({
        manifest: candidate,
        confirmedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(application.close).toHaveBeenCalledOnce();
      expect(setExitCode).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["success", false],
    ["failure", true],
  ] as const)("closes an outbound application once after %s", async (_, fails) => {
    const outboundList = fails
      ? vi.fn(() => {
        throw new OutboundSafetyError("outbound_safety_failed", {});
      })
      : vi.fn().mockReturnValue([]);
    const application = {
      service: {
        outbound: { list: outboundList },
      } as unknown as IntentArcService,
      close: vi.fn(),
    } satisfies IntentArcApplication;
    const stderr = captureOutput();
    const setExitCode = vi.fn();

    await runCli([
      "--db",
      "relative/intentarc.sqlite",
      "context",
      "outbound",
      "list",
    ], {
      stdout: captureOutput(),
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      openApplication: vi.fn().mockResolvedValue(application),
      setExitCode,
    });

    expect(application.close).toHaveBeenCalledTimes(1);
    if (fails) {
      expect(setExitCode).toHaveBeenCalledWith(1);
      expect(stderr.text()).toBe(
        "outbound_safety_failed: Outbound safety processing failed.\n",
      );
    } else {
      expect(setExitCode).not.toHaveBeenCalled();
      expect(stderr.text()).toBe("");
    }
  });

  it("does not render unexpected reveal error data or finding values", async () => {
    const error = new OutboundSafetyError(
      "outbound_release_invalid",
      { requestId: "request-1" },
    );
    Object.assign(error, {
      cause: new Error("matched-secret at C:/private/store.sqlite"),
      destinationLabel: "private destination label",
    });
    const application = {
      service: {
        outbound: {
          reveal: vi.fn(() => {
            throw error;
          }),
        },
      } as unknown as IntentArcService,
      close: vi.fn(),
    } satisfies IntentArcApplication;
    const stdout = captureOutput();
    const stderr = captureOutput();
    const setExitCode = vi.fn();

    await runCli([
      "--db",
      "relative/intentarc.sqlite",
      "context",
      "outbound",
      "reveal",
      "--request",
      "request-1",
      "--finding",
      "finding-1",
    ], {
      stdout: { ...stdout, isTTY: true },
      stderr,
      stdin: { isTTY: true },
      confirmationService: { confirm: vi.fn() },
      openApplication: vi.fn().mockResolvedValue(application),
      setExitCode,
    });

    expect(stderr.text()).toContain(
      "outbound_release_invalid: Outbound release is invalid.",
    );
    expect(stderr.text()).not.toMatch(
      /matched-secret|private destination label|store\.sqlite|stack|cause/i,
    );
    expect(stdout.text()).toBe("");
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(application.close).toHaveBeenCalledTimes(1);
  });

  it("prints a canonical durability error when prepared application opening fails", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const setExitCode = vi.fn();
    const recoveryBundlePath = resolve(
      "recovery",
      "manual.intentarc-backup",
    );
    const error = new DurabilityError("migration_failed", {
      originalSchemaVersion: 2,
      requestedSchemaVersion: 3,
      transactionPreserved: true,
      backupId: "backup-safe",
      bundlePath: recoveryBundlePath,
      recoveryAction: "restore_verified_backup",
    });
    Object.assign(error, {
      cause: new Error(
        "SELECT secret FROM credentials at C:/private/authoritative.sqlite",
      ),
    });

    await runCli(["--db", "relative/intentarc.sqlite", "project", "list"], {
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      createDurabilityService: vi.fn(),
      openApplication: vi.fn().mockRejectedValue(error),
      setExitCode,
    });

    expect(stderr.text()).toBe(
      "migration_failed: Store migration failed. Recovery details: " +
        JSON.stringify({
          originalSchemaVersion: 2,
          requestedSchemaVersion: 3,
          transactionPreserved: true,
          backupId: "backup-safe",
          bundlePath: recoveryBundlePath,
          recoveryAction: "restore_verified_backup",
        }) +
        "\n",
    );
    expect(stderr.text()).not.toMatch(
      /SELECT|secret|credentials|authoritative\.sqlite|stack|cause/i,
    );
    expect(stdout.text()).toBe("");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("allows backup verification without --db", async () => {
    const stdout = captureOutput();
    const verifyBackup = vi
      .fn()
      .mockResolvedValue({ verificationStatus: "verified" });
    const durability = {
      checkIntegrity: vi.fn(),
      createBackup: vi.fn(),
      listBackups: vi.fn(),
      verifyBackup,
      restoreBackup: vi.fn(),
    } as unknown as DurabilityService;

    await runCli(["backup", "verify", "--backup", "relative/b.intentarc-backup"], {
      stdout,
      stderr: captureOutput(),
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
      createDurabilityService: () => durability,
      openApplication: vi.fn(),
      setExitCode: vi.fn(),
    });

    expect(verifyBackup).toHaveBeenCalledWith(
      resolve("relative/b.intentarc-backup"),
    );
  });

  it.each([
    ["integrity", "check"],
    ["backup", "create"],
    ["backup", "list"],
    ["backup", "restore", "--backup", "relative/b.intentarc-backup", "--yes"],
  ])(
    "returns exit code 2 when a durability database argument is absent: %s",
    async (...arguments_) => {
      const stdout = captureOutput();
      const stderr = captureOutput();
      const setExitCode = vi.fn();
      const openApplication = vi.fn();
      const createDurabilityService = vi.fn();

      await runCli(arguments_, {
        stdout,
        stderr,
        stdin: { isTTY: false },
        confirmationService: { confirm: vi.fn() },
        createDurabilityService,
        openApplication,
        setExitCode,
      });

      expect(setExitCode).toHaveBeenCalledWith(2);
      expect(stderr.text()).toBe("Invalid command input.\n");
      expect(stdout.text()).toBe("");
      expect(openApplication).not.toHaveBeenCalled();
      expect(createDurabilityService).not.toHaveBeenCalled();
    },
  );
});

const runProcess = (
  command: string,
  arguments_: string[],
  cwd: string,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: { ...process.env, INTENTARC_DB_PATH: "" },
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
      resolve({ code, stdout, stderr });
    });
  });

describe("IntentArc packaged CLI executable", () => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  let emittedBin: string;
  let temporaryDirectory: string;
  let linkedBin: string;
  let repositoryFixture: RepositoryFixture | undefined;

  beforeAll(async () => {
    const packageManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { bin?: { intentarc?: unknown } };
    const declaredBin = packageManifest.bin?.intentarc;

    if (typeof declaredBin !== "string") {
      throw new Error("package.json must declare the intentarc executable");
    }

    const build = await ensurePackagedTestBuild(repositoryRoot);
    emittedBin = resolve(build.packageRoot, declaredBin);

    temporaryDirectory = await mkdtemp(join(tmpdir(), "intentarc-cli-bin-"));
    const nodeModules = join(temporaryDirectory, "node_modules");
    const linkedPackage = join(nodeModules, "intentarc");
    await mkdir(nodeModules);
    await symlink(
      build.packageRoot,
      linkedPackage,
      process.platform === "win32" ? "junction" : "dir",
    );

    if (process.platform === "win32") {
      linkedBin = resolve(linkedPackage, declaredBin);
    } else {
      const packageBinDirectory = join(nodeModules, ".bin");
      await mkdir(packageBinDirectory);
      linkedBin = join(packageBinDirectory, "intentarc");
      await symlink(
        join("..", "intentarc", declaredBin),
        linkedBin,
        "file",
      );
    }
  }, 30_000);

  afterAll(async () => {
    repositoryFixture?.cleanup();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("preserves the Node interpreter directive in emitted output", async () => {
    const emittedSource = await readFile(emittedBin, "utf8");

    expect(emittedSource).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
  });

  const runLinkedCli = async (arguments_: string[]): Promise<ProcessResult> => {
    if (process.platform !== "win32") {
      await chmod(emittedBin, 0o755);
    }

    return process.platform === "win32"
      ? runProcess(
          process.execPath,
          [linkedBin, ...arguments_],
          temporaryDirectory,
        )
      : runProcess(linkedBin, arguments_, temporaryDirectory);
  };

  it("runs bare --version through the declared linked package executable", async () => {
    const result = await runLinkedCli(["--version"]);

    expect(result).toEqual({
      code: 0,
      stdout: "intentarc 0.1.0\n",
      stderr: "",
    });
  });

  it("scans and safely inspects through the packaged executable without a database", async () => {
    repositoryFixture = createRepositoryFixture({
      "README.md": "# Existing project\n\nPublic project overview.\n",
    }, { parentDirectory: repositoryRoot });
    const manifestPath = join(temporaryDirectory, "candidate.json");

    const scan = await runLinkedCli([
      "project",
      "import",
      "scan",
      "--repository",
      repositoryFixture.root,
      "--manifest",
      manifestPath,
    ]);

    expect(scan.code).toBe(0);
    expect(scan.stderr).toBe("");
    expect(JSON.parse(scan.stdout)).toEqual({
      manifestPath: resolve(manifestPath),
    });

    const inspect = await runLinkedCli([
      "project",
      "import",
      "inspect",
      "--manifest",
      manifestPath,
    ]);

    expect(inspect.code).toBe(0);
    expect(inspect.stderr).toBe("");
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository: { root: repositoryFixture.root.replaceAll("\\", "/") },
      project: { primaryRepositoryPath: repositoryFixture.root.replaceAll("\\", "/") },
    });
    expect(inspect.stdout).not.toContain("Public project overview.");
    await expect(access(join(temporaryDirectory, "intentarc.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects packaged apply without a database before opening the manifest", async () => {
    const result = await runLinkedCli([
      "project",
      "import",
      "apply",
      "--manifest",
      join(temporaryDirectory, "missing-private.json"),
      "--confirm-digest",
      digest,
    ]);

    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "Invalid command input.\n",
    });
  });

  it("does not open a supplied database while displaying version", async () => {
    const databasePath = join(temporaryDirectory, "must-not-exist.sqlite");
    const result = await runLinkedCli([
      "--db",
      databasePath,
      "--version",
    ]);

    expect(result).toEqual({
      code: 0,
      stdout: "intentarc 0.1.0\n",
      stderr: "",
    });
    await expect(access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
