import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentArcService } from "../core/intentarc-service.js";
import type { RepositoryImportTools } from "../core/repository-import-service.js";
import type {
  ImportInspection,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  MAX_IMPORT_MANIFEST_BYTES,
  readImportManifest,
  type ImportCommandFileSystem,
} from "./import-commands.js";
import {
  createProgram,
  formatRepositoryImportErrorForCli,
} from "./program.js";

const digest = "a".repeat(64);
const repositoryFingerprint = "b".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const createTemporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc-import-cli-"));
  temporaryDirectories.push(directory);
  return directory;
};

const manifest = (): RepositoryImportManifest => ({
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

const inspection = (): ImportInspection => ({
  manifestDigest: digest,
  repository: manifest().repository,
  project: manifest().proposal.project,
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

const captureOutput = (isTTY?: boolean) => {
  let value = "";
  return {
    isTTY,
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text: () => value,
  };
};

const createHarness = (options: {
  readonly isTTY?: boolean;
  readonly confirm?: boolean;
  readonly databasePath?: string;
  readonly importFileSystem?: Partial<ImportCommandFileSystem>;
  readonly bypassOutputContainment?: boolean;
} = {}) => {
  const stdout = captureOutput(options.isTTY);
  const stderr = captureOutput();
  const confirmationService = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? true),
  };
  const repositoryImportTools: RepositoryImportTools = {
    scan: vi.fn().mockReturnValue(manifest()),
    inspect: vi.fn().mockReturnValue(inspection()),
  };
  const apply = vi.fn().mockReturnValue({
    projectId: "project-1",
    manifestDigest: digest,
    repositoryFingerprint,
    revisionBefore: 0,
    revisionAfter: 1,
    replayed: false,
  });
  const service = {
    imports: { ...repositoryImportTools, apply },
  } as unknown as IntentArcService;
  const program = createProgram({
    service,
    repositoryImportTools,
    stdout,
    stderr,
    stdin: { isTTY: options.isTTY },
    confirmationService,
    ...(options.databasePath === undefined
      ? {}
      : { databasePath: options.databasePath }),
    ...(options.importFileSystem === undefined
      ? {}
      : { importFileSystem: options.importFileSystem }),
    ...(options.bypassOutputContainment !== true
      ? {}
      : {
        importOutputContainment: {
          assertDatabaseOutsideRepository: vi.fn(),
          assertOutputOutsideRepository: vi.fn(),
        },
      }),
  });

  return {
    program,
    stdout,
    stderr,
    confirmationService,
    repositoryImportTools,
    apply,
  };
};

describe("repository import CLI commands", () => {
  it("scans absolute inputs and exclusively creates the requested manifest", async () => {
    const directory = createTemporaryDirectory();
    const output = join(directory, "candidate.json");
    const repository = join(directory, "repository");
    const harness = createHarness();

    await harness.program.parseAsync([
      "project",
      "import",
      "scan",
      "--repository",
      repository,
      "--canonical-subpath",
      "game",
      "--manifest",
      output,
    ], { from: "user" });

    expect(harness.repositoryImportTools.scan).toHaveBeenCalledWith({
      repositoryPath: resolve(repository),
      canonicalSubpath: "game",
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(manifest());
    expect(JSON.parse(harness.stdout.text())).toEqual({
      manifestPath: resolve(output),
    });
  });

  it("never overwrites an existing manifest and reports only the safe path", async () => {
    const directory = createTemporaryDirectory();
    const output = join(directory, "candidate.json");
    writeFileSync(output, "PRIVATE EXISTING MANIFEST");
    const harness = createHarness();

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "scan",
      "--repository",
      directory,
      "--manifest",
      output,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(readFileSync(output, "utf8")).toBe("PRIVATE EXISTING MANIFEST");
    expect(harness.stderr.text()).toContain("manifest_exists");
    expect(harness.stderr.text()).not.toContain("PRIVATE EXISTING MANIFEST");
  });

  it("rejects a manifest output inside the inspected repository before creating it", async () => {
    const directory = createTemporaryDirectory();
    const repository = join(directory, "repository");
    mkdirSync(repository);
    const output = join(repository, "onboarding.json");
    const candidate = manifest();
    candidate.repository.root = repository.replaceAll("\\", "/");
    candidate.proposal.project.primaryRepositoryPath = candidate.repository.root;
    const harness = createHarness();
    vi.mocked(harness.repositoryImportTools.scan).mockReturnValue(candidate);

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "scan",
      "--repository",
      repository,
      "--manifest",
      output,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(existsSync(output)).toBe(false);
    expect(harness.stderr.text()).toContain("path_escape");
  });

  it("rejects a manifest output whose existing junction parent resolves inside the repository", async () => {
    const directory = createTemporaryDirectory();
    const repository = join(directory, "repository");
    const alias = join(directory, "repository-alias");
    mkdirSync(repository);
    symlinkSync(repository, alias, "junction");
    const output = join(alias, "onboarding.json");
    const candidate = manifest();
    candidate.repository.root = repository.replaceAll("\\", "/");
    candidate.proposal.project.primaryRepositoryPath = candidate.repository.root;
    const harness = createHarness();
    vi.mocked(harness.repositoryImportTools.scan).mockReturnValue(candidate);

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "scan",
      "--repository",
      repository,
      "--manifest",
      output,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(existsSync(join(repository, "onboarding.json"))).toBe(false);
    expect(harness.stderr.text()).toContain("path_escape");
  });

  it.runIf(process.platform === "win32")(
    "preserves a UNC output path when exclusive creation reports EEXIST",
    async () => {
      const uncPath = "\\\\server\\share\\candidate.json";
      const writeExclusive = vi.fn(() => {
        throw Object.assign(new Error("synthetic existing target"), {
          code: "EEXIST",
        });
      });
      const harness = createHarness({
        importFileSystem: { writeExclusive },
        bypassOutputContainment: true,
      });

      await expect(harness.program.parseAsync([
        "project",
        "import",
        "scan",
        "--repository",
        "C:\\repo",
        "--manifest",
        uncPath,
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

      expect(writeExclusive).toHaveBeenCalledWith(
        uncPath,
        `${JSON.stringify(manifest(), null, 2)}\n`,
      );
      expect(harness.stderr.text()).toBe(
        "manifest_exists: Import manifest already exists. " +
          "Details: {\"path\":\"//server/share/candidate.json\"}\n",
      );
    },
  );

  it("reads a UTF-8 manifest and prints only the strict safe inspection", async () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "candidate.json");
    writeFileSync(path, JSON.stringify(manifest()));
    const harness = createHarness();

    await harness.program.parseAsync([
      "project",
      "import",
      "inspect",
      "--manifest",
      path,
    ], { from: "user" });

    expect(harness.repositoryImportTools.inspect).toHaveBeenCalledWith(manifest());
    expect(JSON.parse(harness.stdout.text())).toEqual(inspection());
    expect(harness.stdout.text()).not.toContain("PRIVATE RECORD BODY");
  });

  it("rejects an in-repository database and sidecars before invoking apply", async () => {
    const directory = createTemporaryDirectory();
    const repository = join(directory, "repository");
    mkdirSync(repository);
    const databasePath = join(repository, "intentarc.sqlite");
    const path = join(directory, "candidate.json");
    const candidate = manifest();
    candidate.repository.root = repository.replaceAll("\\", "/");
    candidate.proposal.project.primaryRepositoryPath = candidate.repository.root;
    writeFileSync(path, JSON.stringify(candidate));
    const candidateInspection = inspection();
    candidateInspection.repository = candidate.repository;
    candidateInspection.project = candidate.proposal.project;
    const harness = createHarness({ databasePath });
    vi.mocked(harness.repositoryImportTools.inspect).mockReturnValue(
      candidateInspection,
    );

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      path,
      "--confirm-digest",
      digest,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.apply).not.toHaveBeenCalled();
    for (const artifact of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
      `${databasePath}.intentarc-lock`,
    ]) {
      expect(existsSync(artifact)).toBe(false);
    }
    expect(harness.stderr.text()).toContain("path_escape");
  });

  it("rejects oversized and invalid UTF-8 manifest input without rendering bytes", async () => {
    const directory = createTemporaryDirectory();
    const oversized = join(directory, "oversized.json");
    const invalidUtf8 = join(directory, "invalid.json");
    writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 0x58));
    writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));

    for (const path of [oversized, invalidUtf8]) {
      const harness = createHarness();
      await expect(harness.program.parseAsync([
        "project",
        "import",
        "inspect",
        "--manifest",
        path,
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(harness.repositoryImportTools.inspect).not.toHaveBeenCalled();
      expect(harness.stderr.text()).toBe(
        "manifest_invalid: Import manifest is invalid.\n",
      );
      expect(harness.stderr.text()).not.toMatch(/XXX|�|stack|cause/i);
    }
  });

  it("caps descriptor acquisition at the manifest limit plus one byte", () => {
    const allocations: number[] = [];
    const requestedLengths: number[] = [];
    const close = vi.fn();
    const fileSystem: Partial<ImportCommandFileSystem> = {
      openForRead: vi.fn(() => 7),
      allocate: (byteLength) => {
        allocations.push(byteLength);
        return Buffer.allocUnsafe(byteLength);
      },
      read: (_descriptor, buffer, offset, byteLength) => {
        requestedLengths.push(byteLength);
        buffer.fill(0x58, offset, offset + byteLength);
        return byteLength;
      },
      close,
    };

    expect(() => readImportManifest("race-capable.json", fileSystem))
      .toThrowError(expect.objectContaining({ code: "manifest_invalid" }));
    expect(allocations).toEqual([MAX_IMPORT_MANIFEST_BYTES + 1]);
    expect(requestedLengths).toEqual([MAX_IMPORT_MANIFEST_BYTES + 1]);
    expect(close).toHaveBeenCalledWith(7);
  });

  it("applies a manifest only with the exact provided digest", async () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "candidate.json");
    writeFileSync(path, JSON.stringify(manifest()));
    const harness = createHarness({ isTTY: false });

    await harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      path,
      "--confirm-digest",
      digest,
    ], { from: "user" });

    expect(harness.apply).toHaveBeenCalledWith({
      manifest: manifest(),
      confirmedDigest: digest,
    });
    expect(JSON.parse(harness.stdout.text())).toMatchObject({
      projectId: "project-1",
      manifestDigest: digest,
    });
  });

  it("requires an exact digest option without a TTY before reading or applying", async () => {
    const harness = createHarness({ isTTY: false });

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      "missing-private-manifest.json",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.repositoryImportTools.inspect).not.toHaveBeenCalled();
    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
  });

  it("shows safe inspection and prompts before interactive apply", async () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "candidate.json");
    writeFileSync(path, JSON.stringify(manifest()));
    const harness = createHarness({ isTTY: true });

    await harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      path,
    ], { from: "user" });

    expect(harness.stdout.text()).toContain(
      `${JSON.stringify(inspection(), null, 2)}\n`,
    );
    expect(harness.confirmationService.confirm).toHaveBeenCalledWith(
      `Apply import manifest ${digest}?`,
    );
    expect(harness.apply).toHaveBeenCalledWith({
      manifest: manifest(),
      confirmedDigest: digest,
    });
  });

  it("does not apply or create state when interactive confirmation is cancelled", async () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "candidate.json");
    writeFileSync(path, JSON.stringify(manifest()));
    const harness = createHarness({ isTTY: true, confirm: false });

    await harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      path,
    ], { from: "user" });

    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.stdout.text()).toContain('"cancelled": true');
  });

  it("formats digest mismatch with only canonical expected and actual details", async () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "candidate.json");
    const actualDigest = "d".repeat(64);
    writeFileSync(path, JSON.stringify(manifest()));
    const harness = createHarness({ isTTY: false });

    await expect(harness.program.parseAsync([
      "project",
      "import",
      "apply",
      "--manifest",
      path,
      "--confirm-digest",
      actualDigest,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.repositoryImportTools.inspect).toHaveBeenCalledWith(
      manifest(),
    );
    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toBe(
      "manifest_digest_mismatch: Import manifest digest does not match confirmation. " +
        `Details: {\"expectedDigest\":\"${digest}\",\"actualDigest\":\"${actualDigest}\"}\n`,
    );
    expect(harness.stderr.text()).not.toMatch(/PRIVATE RECORD BODY|stack|cause/i);
  });

  it("refuses forged typed import errors instead of rendering attached private data", () => {
    const error = new RepositoryImportError("import_failed", {});
    Object.assign(error, {
      code: "forged_private_code",
      details: { manifest: "PRIVATE RECORD BODY" },
      cause: new Error("git stderr raw-secret"),
    });

    expect(formatRepositoryImportErrorForCli(error)).toBeUndefined();
  });
});
