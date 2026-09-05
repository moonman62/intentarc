import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  dirname,
  join,
  parse,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import forgeConfig, {
  desktopPackageIgnore,
} from "../../forge.config.js";

interface BuildBridgeModule {
  BRIDGE_NODE_VERSION: string;
  buildIntentArcBridge(options?: {
    buildParent?: string;
    outputRoot?: string;
    stagingRoot?: string;
    releaseVersion?: string;
    buildMode?: "signed-release" | "unsigned-development";
    authorizedPredecessor?: {
      formatVersion: 1;
      versionDirectory: string;
      releaseVersion: string;
      buildMode: "signed-release" | "unsigned-development";
      executableSha256: string;
      payloadSha256: string;
      supportSha256: string;
    } | null;
  }): Promise<void>;
  createSeaConfig(main: string, output: string): Record<string, unknown>;
  directoryDigest(root: string): Promise<string>;
  prepareBridgeSupportTree(options: {
    stagingRoot: string;
    buildMode: "signed-release" | "unsigned-development";
    environment?: NodeJS.ProcessEnv;
    signNative?: (input: {
      nativePath: string;
      ownerRoot: string;
      signing: Record<string, string>;
    }) => Promise<{ nativePath: string; sha256: string }>;
  }): Promise<{
    supportRoot: string;
    nativePath: string;
    supportSha256: string;
  }>;
  stripPeSignature(executable: Buffer): Buffer;
}

interface BridgeSupportIntegrityModule {
  directoryDigest(root: string): Promise<string>;
}

interface PredecessorFixtureCleanupOperations {
  rm(root: string, options: {
    recursive: true;
    force: true;
    maxRetries: 0;
    retryDelay: 0;
  }): void;
  exists(root: string): boolean;
  now(): number;
  wait(durationMs: number): void;
}

const predecessorFixtureCleanupDeadlineMs = 30_000;
const predecessorFixtureCleanupWaitState = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const predecessorFixtureTransientCodes = new Set([
  "EPERM",
  "EBUSY",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

function predecessorFixtureCleanupError(suffix: string): Error {
  return new Error(`predecessor-fixture-cleanup-failed:${suffix}`);
}

function predecessorFixtureCleanupCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return null;
    }
    const code = (error as { code: unknown }).code;
    return typeof code === "string" &&
        predecessorFixtureTransientCodes.has(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

function waitForPredecessorFixtureCleanup(durationMs: number): void {
  Atomics.wait(predecessorFixtureCleanupWaitState, 0, 0, durationMs);
}

function cleanupPredecessorFixture(
  root: string,
  operations: PredecessorFixtureCleanupOperations,
): void {
  let previousNow = Number.NEGATIVE_INFINITY;
  const readNow = (): number => {
    let current: number;
    try {
      current = operations.now();
    } catch {
      throw predecessorFixtureCleanupError("other");
    }
    if (!Number.isFinite(current) || current < previousNow) {
      throw predecessorFixtureCleanupError("other");
    }
    previousNow = current;
    return current;
  };
  const startedAt = readNow();
  const deadline = startedAt + predecessorFixtureCleanupDeadlineMs;
  if (!Number.isFinite(deadline)) {
    throw predecessorFixtureCleanupError("other");
  }

  for (;;) {
    try {
      operations.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 0,
        retryDelay: 0,
      });
      break;
    } catch (error) {
      const code = predecessorFixtureCleanupCode(error);
      if (code === null) {
        throw predecessorFixtureCleanupError("other");
      }
      const current = readNow();
      if (current >= deadline) {
        throw predecessorFixtureCleanupError(code.toLowerCase());
      }
      const waitDuration = Math.min(100, deadline - current);
      try {
        operations.wait(waitDuration);
      } catch {
        throw predecessorFixtureCleanupError("other");
      }
      if (readNow() >= deadline) {
        throw predecessorFixtureCleanupError(code.toLowerCase());
      }
    }
  }

  let remains: boolean;
  try {
    remains = operations.exists(root);
  } catch {
    throw predecessorFixtureCleanupError("other");
  }
  if (remains) {
    throw predecessorFixtureCleanupError("remaining");
  }
}

interface BridgeDiagnosticExecutableProof {
  readonly executablePath: string;
  readonly ownerRoot: string;
  readonly state: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    nlink: number;
  }>;
  readonly sha256: string;
}

interface BridgeDiagnosticAuditModule {
  bridgeDiagnosticTokens: readonly [
    "identity",
    "predecessor",
    "identity",
    "predecessor",
    "identity",
  ];
  recordBridgeDiagnostic(input: {
    auditRoot?: string;
    auditPath?: string;
    executablePath: string;
    ownerRoot: string;
    token: "identity" | "predecessor";
  }): Promise<BridgeDiagnosticExecutableProof>;
  readBridgeDiagnosticAudit(input: {
    auditRoot: string;
    auditPath: string;
  }): Promise<string[]>;
  recheckBridgeDiagnosticExecutable(
    proof: BridgeDiagnosticExecutableProof,
  ): Promise<void>;
}

interface DesktopReleaseModule {
  readPackagedBridgeIdentity(
    path: string,
    options?: {
      ownerRoot: string;
      environment?: Record<string, string | undefined>;
    },
  ): Promise<{
    formatVersion: 1;
    releaseVersion: string;
    buildMode: "signed-release" | "unsigned-development";
    supportSha256: string;
  }>;
  readPackagedBridgePredecessor(
    path: string,
    options?: {
      ownerRoot: string;
      environment?: Record<string, string | undefined>;
    },
  ): Promise<null | Record<string, unknown>>;
}

const loadBridgeDiagnosticAudit = async (): Promise<BridgeDiagnosticAuditModule> =>
  import("../../scripts/bridge-diagnostic-audit.mjs?task-2-contract") as
    Promise<BridgeDiagnosticAuditModule>;

const createBridgeDiagnosticFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "intentarc-bridge-diagnostic-"));
  const ownerRoot = join(root, "owner");
  const auditRoot = join(root, "audit");
  mkdirSync(ownerRoot);
  mkdirSync(auditRoot);
  const executablePath = join(ownerRoot, "IntentArc Bridge.exe");
  const auditPath = join(auditRoot, "bridge-diagnostics.tokens");
  writeFileSync(executablePath, "ordinary-bridge-executable", "utf8");
  return {
    root,
    ownerRoot: realpathSync(ownerRoot),
    auditRoot: realpathSync(auditRoot),
    executablePath: realpathSync(executablePath),
    auditPath,
  };
};

const createBridgeDispatcherFixture = () => {
  const fixture = createBridgeDiagnosticFixture();
  const sourcePath = join(fixture.root, "BridgeDiagnosticFixture.cs");
  const modePath = join(fixture.ownerRoot, "mode.txt");
  writeFileSync(sourcePath, [
    "using System;",
    "using System.IO;",
    "public static class BridgeDiagnosticFixture {",
    "  public static int Main(string[] arguments) {",
    "    string modePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, \"mode.txt\");",
    "    string mode = File.Exists(modePath) ? File.ReadAllText(modePath).Trim() : \"success\";",
    "    if (mode == \"failure\") {",
    "      Console.Out.Write(\"stdout-sentinel credential-sentinel C:\\\\secret\\\\stdout\");",
    "      Console.Error.Write(\"stderr-sentinel credential-sentinel D:\\\\secret\\\\stderr\");",
    "      return 23;",
    "    }",
    "    if (arguments.Length != 1) { Console.Error.Write(\"unexpected argument count\"); return 19; }",
    "    if (arguments[0] == \"--bridge-identity\") {",
    "      if (mode == \"malformed-identity\") { Console.Out.Write(\"{\"); return 0; }",
    `      Console.Out.Write("{\\\"formatVersion\\\":1,\\\"releaseVersion\\\":\\\"0.1.0\\\",\\\"buildMode\\\":\\\"signed-release\\\",\\\"supportSha256\\\":\\\"${"a".repeat(64)}\\\"}");`,
    "      return 0;",
    "    }",
    "    if (arguments[0] == \"--bridge-authorized-predecessor\") {",
    "      if (mode == \"malformed-predecessor\") { Console.Out.Write(\"{\"); return 0; }",
    "      Console.Out.Write(\"null\");",
    "      return 0;",
    "    }",
    "    Console.Error.Write(\"unexpected argument\");",
    "    return 20;",
    "  }",
    "}",
  ].join("\n"), "utf8");
  const compilerPath = join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  execFileSync(compilerPath, [
    "/nologo",
    "/target:exe",
    `/out:${fixture.executablePath}`,
    sourcePath,
  ], { windowsHide: true, stdio: "pipe" });
  return { ...fixture, modePath };
};

const invalidAuditCases = [
  "missing-final-newline", "malformed-utf8", "wrong-token",
  "duplicate-token", "reordered-token", "sixth-token", "over-128-bytes",
  "partial-configuration", "wrong-leaf", "wrong-root", "path-escape",
  "root-link", "leaf-link", "multi-link-leaf", "unsupported-leaf",
] as const;

const invalidExecutableCases = [
  "wrong-leaf", "outside-owner", "owner-link", "executable-link",
  "multi-link-executable", "non-ordinary-executable", "byte-drift",
  "identity-drift", "timestamp-drift", "post-dispatch-replacement",
] as const;

const auditErrorMessage = "IntentArc bridge diagnostic audit failed.";
const driftErrorMessage =
  "IntentArc bridge diagnostic executable changed.";

const expectExactRejection = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(message);
};

const packageRoot = resolve(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

const createPeFixture = (machine: number): Buffer => {
  const executable = Buffer.alloc(256, 0);
  executable.write("MZ", 0, "ascii");
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write("PE\0\0", 0x80, "binary");
  executable.writeUInt16LE(machine, 0x84);
  return executable;
};

const createCanonicalNativeFixture = (root: string): string => {
  const nativePath = join(
    root,
    "node_modules",
    "better-sqlite3",
    "prebuilds",
    "win32-x64.node",
  );
  mkdirSync(dirname(nativePath), { recursive: true });
  writeFileSync(nativePath, createPeFixture(0x8664));
  return nativePath;
};

const createSupportTree = (
  parent: string,
  name: string,
  files: readonly string[],
): string => {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  for (const file of files) writeFileSync(join(root, file), file, "utf8");
  return root;
};

describe("bridge diagnostic audit contract", () => {
  it("records the exact ordered five-token audit and returns immutable executable proofs", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const fixture = createBridgeDiagnosticFixture();
    try {
      expect(audit.bridgeDiagnosticTokens).toEqual([
        "identity", "predecessor", "identity", "predecessor", "identity",
      ]);
      expect(Object.isFrozen(audit.bridgeDiagnosticTokens)).toBe(true);
      const executableState = statSync(fixture.executablePath);
      const expectedSha256 = createHash("sha256")
        .update(readFileSync(fixture.executablePath))
        .digest("hex");

      for (const token of [
        "identity", "predecessor", "identity", "predecessor", "identity",
      ] as const) {
        const proof = await audit.recordBridgeDiagnostic({
          auditRoot: fixture.auditRoot,
          auditPath: fixture.auditPath,
          executablePath: fixture.executablePath,
          ownerRoot: fixture.ownerRoot,
          token,
        });
        expect(proof).toEqual({
          executablePath: fixture.executablePath,
          ownerRoot: fixture.ownerRoot,
          state: {
            dev: executableState.dev,
            ino: executableState.ino,
            size: executableState.size,
            mtimeMs: executableState.mtimeMs,
            ctimeMs: executableState.ctimeMs,
            nlink: executableState.nlink,
          },
          sha256: expectedSha256,
        });
        expect(Object.keys(proof)).toEqual([
          "executablePath", "ownerRoot", "state", "sha256",
        ]);
        expect(Object.keys(proof.state)).toEqual([
          "dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink",
        ]);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof.state)).toBe(true);
        await audit.recheckBridgeDiagnosticExecutable(proof);
      }
      expect(await audit.readBridgeDiagnosticAudit({
        auditRoot: fixture.auditRoot,
        auditPath: fixture.auditPath,
      })).toEqual([
        "identity", "predecessor", "identity", "predecessor", "identity",
      ]);
      expect(readFileSync(fixture.auditPath, "utf8")).toBe(
        "identity\npredecessor\nidentity\npredecessor\nidentity\n",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(invalidAuditCases)(
    "rejects invalid audit fixture: %s",
    async (invalidCase) => {
      const audit = await loadBridgeDiagnosticAudit();
      const fixture = createBridgeDiagnosticFixture();
      let auditRoot = fixture.auditRoot;
      let auditPath = fixture.auditPath;
      try {
        switch (invalidCase) {
          case "missing-final-newline":
            writeFileSync(auditPath, "identity", "utf8");
            break;
          case "malformed-utf8":
            writeFileSync(auditPath, Buffer.from([0xc3, 0x28, 0x0a]));
            break;
          case "wrong-token":
            writeFileSync(auditPath, "unexpected\n", "utf8");
            break;
          case "duplicate-token":
            writeFileSync(auditPath, "identity\nidentity\n", "utf8");
            break;
          case "reordered-token":
            writeFileSync(auditPath, "predecessor\n", "utf8");
            break;
          case "sixth-token":
            writeFileSync(
              auditPath,
              "identity\npredecessor\nidentity\npredecessor\nidentity\n",
              "utf8",
            );
            break;
          case "over-128-bytes":
            writeFileSync(auditPath, Buffer.alloc(129, 0x61));
            break;
          case "partial-configuration": {
            await expectExactRejection(audit.recordBridgeDiagnostic({
              auditRoot: fixture.auditRoot,
              auditPath: undefined,
              executablePath: fixture.executablePath,
              ownerRoot: fixture.ownerRoot,
              token: "identity",
            }), auditErrorMessage);
            await expectExactRejection(audit.recordBridgeDiagnostic({
              auditRoot: undefined,
              auditPath: fixture.auditPath,
              executablePath: fixture.executablePath,
              ownerRoot: fixture.ownerRoot,
              token: "identity",
            }), auditErrorMessage);
            return;
          }
          case "wrong-leaf":
            auditPath = join(auditRoot, "wrong.tokens");
            break;
          case "wrong-root": {
            const unrelatedRoot = join(fixture.root, "unrelated-audit-root");
            mkdirSync(unrelatedRoot);
            auditRoot = realpathSync(unrelatedRoot);
            break;
          }
          case "path-escape":
            mkdirSync(join(auditRoot, "nested"));
            auditPath = `${auditRoot}${sep}nested${sep}..${sep}bridge-diagnostics.tokens`;
            break;
          case "root-link": {
            const targetRoot = join(fixture.root, "audit-target");
            const linkedRoot = join(fixture.root, "audit-link");
            mkdirSync(targetRoot);
            symlinkSync(targetRoot, linkedRoot, "junction");
            auditRoot = linkedRoot;
            auditPath = join(linkedRoot, "bridge-diagnostics.tokens");
            break;
          }
          case "leaf-link": {
            const target = join(auditRoot, "target-directory");
            mkdirSync(target);
            symlinkSync(target, auditPath, "junction");
            break;
          }
          case "multi-link-leaf":
            writeFileSync(auditPath, "", "utf8");
            linkSync(auditPath, join(auditRoot, "second-audit-link.tokens"));
            break;
          case "unsupported-leaf":
            mkdirSync(auditPath);
            break;
        }

        await expectExactRejection(audit.recordBridgeDiagnostic({
          auditRoot,
          auditPath,
          executablePath: fixture.executablePath,
          ownerRoot: fixture.ownerRoot,
          token: "identity",
        }), auditErrorMessage);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each(invalidExecutableCases)(
    "rejects invalid executable fixture: %s",
    async (invalidCase) => {
      const audit = await loadBridgeDiagnosticAudit();
      const fixture = createBridgeDiagnosticFixture();
      let ownerRoot = fixture.ownerRoot;
      let executablePath = fixture.executablePath;
      try {
        switch (invalidCase) {
          case "wrong-leaf": {
            executablePath = join(ownerRoot, "Wrong Bridge.exe");
            writeFileSync(executablePath, "ordinary-bridge-executable", "utf8");
            break;
          }
          case "outside-owner": {
            const outsideRoot = join(fixture.root, "outside-owner");
            mkdirSync(outsideRoot);
            executablePath = join(outsideRoot, "IntentArc Bridge.exe");
            writeFileSync(executablePath, "ordinary-bridge-executable", "utf8");
            executablePath = realpathSync(executablePath);
            break;
          }
          case "owner-link": {
            const actualOwner = join(fixture.root, "actual-owner");
            const linkedOwner = join(fixture.root, "linked-owner");
            mkdirSync(actualOwner);
            executablePath = join(actualOwner, "IntentArc Bridge.exe");
            writeFileSync(executablePath, "ordinary-bridge-executable", "utf8");
            executablePath = realpathSync(executablePath);
            symlinkSync(actualOwner, linkedOwner, "junction");
            ownerRoot = linkedOwner;
            break;
          }
          case "executable-link": {
            const targetRoot = join(ownerRoot, "target");
            mkdirSync(targetRoot);
            unlinkSync(executablePath);
            symlinkSync(targetRoot, executablePath, "junction");
            break;
          }
          case "multi-link-executable":
            linkSync(executablePath, join(ownerRoot, "second-bridge-link.exe"));
            break;
          case "non-ordinary-executable":
            unlinkSync(executablePath);
            mkdirSync(executablePath);
            break;
          case "byte-drift":
          case "identity-drift":
          case "timestamp-drift":
          case "post-dispatch-replacement": {
            const proof = await audit.recordBridgeDiagnostic({
              auditRoot: undefined,
              auditPath: undefined,
              executablePath,
              ownerRoot,
              token: "identity",
            });
            if (invalidCase === "byte-drift") {
              writeFileSync(executablePath, "changed--bridge-executable", "utf8");
            } else if (invalidCase === "identity-drift") {
              unlinkSync(executablePath);
              writeFileSync(executablePath, "ordinary-bridge-executable", "utf8");
            } else if (invalidCase === "timestamp-drift") {
              const changed = new Date(Date.now() + 60_000);
              utimesSync(executablePath, changed, changed);
            } else {
              const replacement = join(ownerRoot, "replacement.exe");
              const displaced = join(ownerRoot, "displaced.exe");
              writeFileSync(replacement, readFileSync(executablePath));
              renameSync(executablePath, displaced);
              renameSync(replacement, executablePath);
            }
            await expectExactRejection(
              audit.recheckBridgeDiagnosticExecutable(proof),
              driftErrorMessage,
            );
            return;
          }
        }

        await expectExactRejection(audit.recordBridgeDiagnostic({
          auditRoot: undefined,
          auditPath: undefined,
          executablePath,
          ownerRoot,
          token: "identity",
        }), auditErrorMessage);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("keeps executable proof and recheck active when accounting is disabled", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const fixture = createBridgeDiagnosticFixture();
    try {
      const proof = await audit.recordBridgeDiagnostic({
        auditRoot: undefined,
        auditPath: undefined,
        executablePath: fixture.executablePath,
        ownerRoot: fixture.ownerRoot,
        token: "identity",
      });
      expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(fixture.auditPath)).toBe(false);
      writeFileSync(fixture.executablePath, "disabled-accounting-drift", "utf8");
      await expectExactRejection(
        audit.recheckBridgeDiagnosticExecutable(proof),
        driftErrorMessage,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported token even when accounting is disabled", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const fixture = createBridgeDiagnosticFixture();
    try {
      await expectExactRejection(audit.recordBridgeDiagnostic({
        auditRoot: undefined,
        auditPath: undefined,
        executablePath: fixture.executablePath,
        ownerRoot: fixture.ownerRoot,
        token: "unsupported" as "identity",
      }), auditErrorMessage);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes malformed public calls to their exact fixed errors", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    await expectExactRejection(
      audit.recordBridgeDiagnostic(undefined as never),
      auditErrorMessage,
    );
    await expectExactRejection(
      audit.readBridgeDiagnosticAudit(undefined as never),
      auditErrorMessage,
    );
    await expectExactRejection(
      audit.recheckBridgeDiagnosticExecutable(undefined as never),
      driftErrorMessage,
    );
  });

  it("normalizes a throwing input getter without exposing its message", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const hostileInput = Object.defineProperty({
      auditRoot: undefined,
      auditPath: undefined,
      ownerRoot: "unused",
      token: "identity",
    }, "executablePath", {
      get: () => {
        throw new Error("secret getter suffix");
      },
    });
    await expectExactRejection(
      audit.recordBridgeDiagnostic(hostileInput as never),
      auditErrorMessage,
    );
  });

  it("normalizes a non-Error thrown getter even when its message collides", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const hostileInput = Object.defineProperty({
      auditRoot: undefined,
      auditPath: undefined,
      ownerRoot: "unused",
      token: "identity",
    }, "executablePath", {
      get: () => {
        throw { message: auditErrorMessage };
      },
    });
    await expectExactRejection(
      audit.recordBridgeDiagnostic(hostileInput as never),
      auditErrorMessage,
    );
  });

  it("retries an exclusive audit creation race through existing-file validation", async () => {
    const fixture = createBridgeDiagnosticFixture();
    let exclusiveCreationObserved = false;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (path: string, flags: number, mode?: number) => {
          if (path !== fixture.auditPath || !(flags & constants.O_CREAT)) {
            return actual.open(path, flags, mode);
          }
          if (!(flags & constants.O_EXCL)) {
            throw new Error("audit creation was not exclusive");
          }
          exclusiveCreationObserved = true;
          writeFileSync(fixture.auditPath, "", { mode: 0o600 });
          throw Object.assign(new Error("simulated creation race"), {
            code: "EEXIST",
          });
        },
      };
    });
    try {
      const audit = await import(
        "../../scripts/bridge-diagnostic-audit.mjs?task-2-creation-race"
      ) as BridgeDiagnosticAuditModule;
      await audit.recordBridgeDiagnostic({
        auditRoot: fixture.auditRoot,
        auditPath: fixture.auditPath,
        executablePath: fixture.executablePath,
        ownerRoot: fixture.ownerRoot,
        token: "identity",
      });
      expect(exclusiveCreationObserved).toBe(true);
      expect(readFileSync(fixture.auditPath, "utf8")).toBe("identity\n");
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects same-size audit corruption immediately after synchronized append", async () => {
    const fixture = createBridgeDiagnosticFixture();
    let corrupted = false;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (path: string, flags: number, mode?: number) => {
          const handle = await actual.open(path, flags, mode);
          if (path !== fixture.auditPath) return handle;
          return {
            stat: handle.stat.bind(handle),
            readFile: handle.readFile.bind(handle),
            read: handle.read.bind(handle),
            write: handle.write.bind(handle),
            close: handle.close.bind(handle),
            sync: async () => {
              await handle.sync();
              if (!corrupted) {
                corrupted = true;
                await actual.writeFile(fixture.auditPath, "intruder\n");
              }
            },
          } as unknown as typeof handle;
        },
      };
    });
    try {
      const audit = await import(
        "../../scripts/bridge-diagnostic-audit.mjs?task-2-post-write-corruption"
      ) as BridgeDiagnosticAuditModule;
      await expectExactRejection(audit.recordBridgeDiagnostic({
        auditRoot: fixture.auditRoot,
        auditPath: fixture.auditPath,
        executablePath: fixture.executablePath,
        ownerRoot: fixture.ownerRoot,
        token: "identity",
      }), auditErrorMessage);
      expect(corrupted).toBe(true);
      expect(readFileSync(fixture.auditPath, "utf8")).toBe("intruder\n");
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an ordinary-file-shaped symbolic-link state by its link flag", async () => {
    const fixture = createBridgeDiagnosticFixture();
    writeFileSync(fixture.auditPath, "", "utf8");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        lstat: async (path: string) => {
          const information = await actual.lstat(path);
          if (path !== fixture.auditPath) return information;
          return new Proxy(information, {
            get: (target, property, receiver) => {
              if (property === "isSymbolicLink") return () => true;
              if (property === "isFile") return () => true;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      };
    });
    try {
      const audit = await import(
        "../../scripts/bridge-diagnostic-audit.mjs?task-2-file-shaped-link"
      ) as BridgeDiagnosticAuditModule;
      await expectExactRejection(audit.recordBridgeDiagnostic({
        auditRoot: fixture.auditRoot,
        auditPath: fixture.auditPath,
        executablePath: fixture.executablePath,
        ownerRoot: fixture.ownerRoot,
        token: "identity",
      }), auditErrorMessage);
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an ordinary executable reached through a real ancestor junction", async () => {
    const audit = await loadBridgeDiagnosticAudit();
    const fixture = createBridgeDiagnosticFixture();
    try {
      const actualTree = join(fixture.root, "actual-tree");
      const actualOwner = join(actualTree, "owned");
      const linkedTree = join(fixture.root, "linked-tree");
      mkdirSync(actualOwner, { recursive: true });
      const actualExecutable = join(actualOwner, "IntentArc Bridge.exe");
      writeFileSync(actualExecutable, "ordinary-bridge-executable", "utf8");
      symlinkSync(actualTree, linkedTree, "junction");

      await expectExactRejection(audit.recordBridgeDiagnostic({
        auditRoot: undefined,
        auditPath: undefined,
        executablePath: join(linkedTree, "owned", "IntentArc Bridge.exe"),
        ownerRoot: realpathSync(actualOwner),
        token: "identity",
      }), auditErrorMessage);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")(
  "packaged bridge diagnostic dispatcher contract",
  () => {
    it("dispatches the two closed real-child arguments in audited order", async () => {
      // Catches either reader bypassing the dispatcher, selecting the wrong
      // child argument, or failing to forward the declared executable owner.
      const fixture = createBridgeDispatcherFixture();
      try {
        const release = await import(
          "../../scripts/desktop-release.mjs?task-3-real-child"
        ) as DesktopReleaseModule;
        const environment = {
          INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT: fixture.auditRoot,
          INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH: fixture.auditPath,
        };

        await expect(release.readPackagedBridgeIdentity(
          fixture.executablePath,
          { ownerRoot: fixture.ownerRoot, environment },
        )).resolves.toEqual({
          formatVersion: 1,
          releaseVersion: "0.1.0",
          buildMode: "signed-release",
          supportSha256: "a".repeat(64),
        });
        await expect(release.readPackagedBridgePredecessor(
          fixture.executablePath,
          { ownerRoot: fixture.ownerRoot, environment },
        )).resolves.toBeNull();
        expect(readFileSync(fixture.auditPath, "utf8")).toBe(
          "identity\npredecessor\n",
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("uses the exact bounded hidden non-shell child options", async () => {
      // Catches argument broadening, shell dispatch, a missing Windows hide,
      // or weakening either resource bound.
      const fixture = createBridgeDispatcherFixture();
      const calls: Array<{
        path: string;
        arguments: readonly string[];
        options: Record<string, unknown>;
      }> = [];
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        const capturedExecFile = () => {
          throw new Error("callback execution was not expected");
        };
        Object.defineProperty(capturedExecFile, promisify.custom, {
          value: async (
            path: string,
            arguments_: readonly string[],
            options: Record<string, unknown>,
          ) => {
            calls.push({ path, arguments: arguments_, options });
            return {
              stdout: JSON.stringify({
                formatVersion: 1,
                releaseVersion: "0.1.0",
                buildMode: "signed-release",
                supportSha256: "a".repeat(64),
              }),
              stderr: "",
            };
          },
        });
        return { ...actual, execFile: capturedExecFile };
      });
      try {
        const release = await import(
          "../../scripts/desktop-release.mjs?task-3-options"
        ) as DesktopReleaseModule;
        await release.readPackagedBridgeIdentity(fixture.executablePath, {
          ownerRoot: fixture.ownerRoot,
          environment: {},
        });

        expect(calls).toEqual([{
          path: fixture.executablePath,
          arguments: ["--bridge-identity"],
          options: {
            shell: false,
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 4096,
          },
        }]);
      } finally {
        vi.doUnmock("node:child_process");
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("surfaces only the fixed execution failure for a noisy real child", async () => {
      // Catches raw execFile errors leaking the command path, child output,
      // stderr, or credential-shaped environment values.
      const fixture = createBridgeDispatcherFixture();
      writeFileSync(fixture.modePath, "failure", "utf8");
      const environment = {
        INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT: fixture.auditRoot,
        INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH: fixture.auditPath,
        INTENTARC_TEST_CREDENTIAL: "credential-sentinel",
      };
      let capturedMessage = "";
      try {
        const release = await import(
          "../../scripts/desktop-release.mjs?task-3-noisy-failure"
        ) as DesktopReleaseModule;
        try {
          await release.readPackagedBridgeIdentity(fixture.executablePath, {
            ownerRoot: fixture.ownerRoot,
            environment,
          });
        } catch (error) {
          capturedMessage = (error as Error).message;
        }

        expect(capturedMessage).toBe(
          "IntentArc bridge diagnostic execution failed.",
        );
        expect(capturedMessage).not.toMatch(
          /credential-sentinel|stdout-sentinel|stderr-sentinel|[A-Z]:\\/i,
        );
        expect(readFileSync(fixture.auditPath, "utf8")).toBe("identity\n");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("gives executable drift precedence after a failed real child exits", async () => {
      // Catches early execution-error translation that skips the mandatory
      // post-child executable proof recheck.
      const fixture = createBridgeDispatcherFixture();
      writeFileSync(fixture.modePath, "failure", "utf8");
      let childCompleted = false;
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        const executeActual = promisify(actual.execFile);
        const postChildMutationExecFile = () => {
          throw new Error("callback execution was not expected");
        };
        Object.defineProperty(postChildMutationExecFile, promisify.custom, {
          value: async (
            path: string,
            arguments_: readonly string[],
            options: Record<string, unknown>,
          ) => {
            try {
              return await executeActual(path, arguments_, options);
            } catch (error) {
              childCompleted = true;
              const displaced = join(fixture.ownerRoot, "displaced.exe");
              const bytes = readFileSync(fixture.executablePath);
              renameSync(fixture.executablePath, displaced);
              writeFileSync(fixture.executablePath, bytes);
              throw error;
            }
          },
        });
        return { ...actual, execFile: postChildMutationExecFile };
      });
      try {
        const release = await import(
          "../../scripts/desktop-release.mjs?task-3-drift-precedence"
        ) as DesktopReleaseModule;
        await expect(release.readPackagedBridgeIdentity(
          fixture.executablePath,
          { ownerRoot: fixture.ownerRoot, environment: {} },
        )).rejects.toThrow(/^IntentArc bridge diagnostic executable changed\.$/);
        expect(childCompleted).toBe(true);
      } finally {
        vi.doUnmock("node:child_process");
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("keeps the two fixed parser errors outside the dispatcher", async () => {
      // Catches child success with malformed metadata being mislabeled as an
      // execution failure or accepted by a weakened parser.
      const identityFixture = createBridgeDispatcherFixture();
      const predecessorFixture = createBridgeDispatcherFixture();
      try {
        const release = await import(
          "../../scripts/desktop-release.mjs?task-3-parser-errors"
        ) as DesktopReleaseModule;
        writeFileSync(identityFixture.modePath, "malformed-identity", "utf8");
        await expect(release.readPackagedBridgeIdentity(
          identityFixture.executablePath,
          { ownerRoot: identityFixture.ownerRoot, environment: {} },
        )).rejects.toThrow(
          /^IntentArc release bridge identity is malformed\.$/,
        );
        writeFileSync(
          predecessorFixture.modePath,
          "malformed-predecessor",
          "utf8",
        );
        await expect(release.readPackagedBridgePredecessor(
          predecessorFixture.executablePath,
          { ownerRoot: predecessorFixture.ownerRoot, environment: {} },
        )).rejects.toThrow(
          /^IntentArc release bridge predecessor authorization is malformed\.$/,
        );
      } finally {
        rmSync(identityFixture.root, { recursive: true, force: true });
        rmSync(predecessorFixture.root, { recursive: true, force: true });
      }
    });
  },
);

describe("dedicated bridge package contract", () => {
  const expectClosedPredecessorCleanupFailure = (
    run: () => void,
    suffix: "ebusy" | "other" | "remaining",
    privateRoot: string,
  ): void => {
    let captured: unknown;

    try {
      run();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const cleanupError = captured as Error;
    expect(cleanupError.message).toBe(
      `predecessor-fixture-cleanup-failed:${suffix}`,
    );
    expect(String(cleanupError)).not.toContain(privateRoot);
    expect(cleanupError.stack ?? "").not.toContain(privateRoot);
    expect("cause" in cleanupError).toBe(false);
  };

  it("starts cleanup before waiting and uses the exact retry contract", () => {
    const calls: Array<{
      root: string;
      options: Record<string, unknown>;
    }> = [];
    const events: string[] = [];
    const times = [0, 0, 100];

    cleanupPredecessorFixture("private fixture root", {
      rm: (root, options) => {
        events.push("rm");
        calls.push({ root, options });
        if (calls.length === 1) {
          throw Object.assign(new Error("transient"), { code: "EPERM" });
        }
      },
      exists: () => {
        events.push("exists");
        return false;
      },
      now: () => {
        const value = times.shift() as number;
        events.push(`now:${value}`);
        return value;
      },
      wait: (durationMs) => events.push(`wait:${durationMs}`),
    });

    expect(calls).toEqual([
      {
        root: "private fixture root",
        options: {
          recursive: true,
          force: true,
          maxRetries: 0,
          retryDelay: 0,
        },
      },
      {
        root: "private fixture root",
        options: {
          recursive: true,
          force: true,
          maxRetries: 0,
          retryDelay: 0,
        },
      },
    ]);
    expect(events).toEqual([
      "now:0",
      "rm",
      "now:0",
      "wait:100",
      "now:100",
      "rm",
      "exists",
    ]);
  });

  it("rejects predecessor fixture cleanup when its owned root remains", () => {
    const privateRoot = "credential-shaped-private-fixture-root";

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => undefined,
        exists: () => true,
        now: () => 0,
        wait: () => undefined,
      }),
      "remaining",
      privateRoot,
    );
  });

  it.each([
    "EPERM",
    "EBUSY",
    "ENOTEMPTY",
    "EMFILE",
    "ENFILE",
  ])("retries the allowlisted %s cleanup failure", (code) => {
    let clock = 0;
    let attempts = 0;

    cleanupPredecessorFixture("private fixture root", {
      rm: () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transient"), { code });
        }
      },
      exists: () => false,
      now: () => clock,
      wait: (durationMs) => {
        clock += durationMs;
      },
    });

    expect(attempts).toBe(2);
    expect(clock).toBe(100);
  });

  it("uses the final short wait and starts no removal after its deadline", () => {
    const privateRoot = "credential-shaped-private-fixture-root";
    const times = [0, 29_850, 29_950, 29_950, 30_000];
    const waits: number[] = [];
    let attempts = 0;

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => {
          attempts += 1;
          if (attempts <= 2) {
            throw Object.assign(
              new Error(`EBUSY: cannot remove ${privateRoot}`),
              { code: "EBUSY" },
            );
          }
        },
        exists: () => false,
        now: () => times.shift() as number,
        wait: (durationMs) => waits.push(durationMs),
      }),
      "ebusy",
      privateRoot,
    );

    expect(waits).toEqual([100, 50]);
    expect(attempts).toBe(2);
  });

  it("does not retry a nonallowlisted cleanup failure", () => {
    const privateRoot = "credential-shaped-private-fixture-root";
    let attempts = 0;
    let waits = 0;

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => {
          attempts += 1;
          throw Object.assign(
            new Error(`EACCES: cannot remove ${privateRoot}`),
            { code: "EACCES" },
          );
        },
        exists: () => false,
        now: () => 0,
        wait: () => {
          waits += 1;
        },
      }),
      "other",
      privateRoot,
    );

    expect(attempts).toBe(1);
    expect(waits).toBe(0);
  });

  it("closes an initial clock failure before removal", () => {
    const privateRoot = "credential-shaped-private-fixture-root";
    let attempts = 0;

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => {
          attempts += 1;
        },
        exists: () => false,
        now: () => {
          throw new Error(`clock exposed ${privateRoot}`);
        },
        wait: () => undefined,
      }),
      "other",
      privateRoot,
    );

    expect(attempts).toBe(0);
  });

  it.each([
    { label: "non-finite", times: [Number.NaN] },
    { label: "regressing", times: [10, 9] },
  ])("closes a $label monotonic clock failure", ({ times }) => {
    const privateRoot = "credential-shaped-private-fixture-root";
    const readings = [...times];

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => {
          throw Object.assign(new Error("transient"), { code: "EPERM" });
        },
        exists: () => false,
        now: () => readings.shift() as number,
        wait: () => undefined,
      }),
      "other",
      privateRoot,
    );
  });

  it("closes a wait failure", () => {
    const privateRoot = "credential-shaped-private-fixture-root";

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => {
          throw Object.assign(new Error("transient"), { code: "EPERM" });
        },
        exists: () => false,
        now: () => 0,
        wait: () => {
          throw new Error(`wait exposed ${privateRoot}`);
        },
      }),
      "other",
      privateRoot,
    );
  });

  it("closes an existence-check failure", () => {
    const privateRoot = "credential-shaped-private-fixture-root";

    expectClosedPredecessorCleanupFailure(
      () => cleanupPredecessorFixture(privateRoot, {
        rm: () => undefined,
        exists: () => {
          throw new Error(`exists exposed ${privateRoot}`);
        },
        now: () => 0,
        wait: () => undefined,
      }),
      "other",
      privateRoot,
    );
  });

  it("computes one ordinal, creation-order-independent support digest", async () => {
    const integrity = await import(
      "../../scripts/bridge-support-integrity.mjs?task-1-red"
    ) as BridgeSupportIntegrityModule;
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-digest-"));
    try {
      const first = createSupportTree(parent, "first", ["z.bin", "a.bin"]);
      const second = createSupportTree(parent, "second", ["a.bin", "z.bin"]);

      expect(await integrity.directoryDigest(first))
        .toBe(await integrity.directoryDigest(second));
      expect(await integrity.directoryDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a support root link without following it", async () => {
    const integrity = await import(
      "../../scripts/bridge-support-integrity.mjs?task-1-root-link"
    ) as BridgeSupportIntegrityModule;
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-root-link-"));
    try {
      const target = createSupportTree(parent, "target", ["payload.bin"]);
      const linkedRoot = join(parent, "linked-root");
      await symlink(target, linkedRoot, "junction");

      await expect(integrity.directoryDigest(linkedRoot)).rejects.toThrow(
        "IntentArc bridge support payload cannot contain links.",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a nested support link without following it", async () => {
    const integrity = await import(
      "../../scripts/bridge-support-integrity.mjs?task-1-nested-link"
    ) as BridgeSupportIntegrityModule;
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-nested-link-"));
    try {
      const root = createSupportTree(parent, "root", ["payload.bin"]);
      const target = createSupportTree(parent, "target", ["outside.bin"]);
      await symlink(target, join(root, "linked-directory"), "junction");

      await expect(integrity.directoryDigest(root)).rejects.toThrow(
        "IntentArc bridge support payload cannot contain links.",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported support-tree entry", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-entry-"));
    const root = createSupportTree(parent, "root", ["unsupported-entry"]);
    const unsupportedEntry = join(root, "unsupported-entry");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        lstat: async (path: string) => {
          if (path !== unsupportedEntry) return actual.lstat(path);
          return {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false,
          };
        },
      };
    });
    try {
      const integrity = await import(
        "../../scripts/bridge-support-integrity.mjs?task-1-unsupported-entry"
      ) as BridgeSupportIntegrityModule;

      await expect(integrity.directoryDigest(root)).rejects.toThrow(
        "IntentArc bridge support payload contains an unsupported entry.",
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a support file that changes during its handle read", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-drift-"));
    const root = createSupportTree(parent, "root", ["changing.bin"]);
    const changingPath = join(root, "changing.bin");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (path: string, flags: number) => {
          const handle = await actual.open(path, flags);
          if (path !== changingPath) return handle;
          return {
            stat: handle.stat.bind(handle),
            read: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              const result = await handle.read(buffer, offset, length, position);
              await actual.writeFile(path, Buffer.concat([
                buffer.subarray(offset, offset + result.bytesRead),
                Buffer.from("changed-during-read"),
              ]));
              return result;
            },
            close: handle.close.bind(handle),
          };
        },
      };
    });
    try {
      const integrity = await import(
        "../../scripts/bridge-support-integrity.mjs?task-1-file-drift"
      ) as BridgeSupportIntegrityModule;

      await expect(integrity.directoryDigest(root)).rejects.toThrow(
        "IntentArc bridge support payload changed while being read.",
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a support file replaced immediately before it is opened", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-open-race-"));
    const root = createSupportTree(parent, "root", ["payload.bin"]);
    const payloadPath = join(root, "payload.bin");
    const displacedPath = join(parent, "displaced.bin");
    const replacementPath = join(parent, "replacement.bin");
    const openedReplacementPath = join(parent, "opened-replacement.bin");
    writeFileSync(replacementPath, "replacement", "utf8");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (path: string, flags: number) => {
          if (path === payloadPath) {
            renameSync(path, displacedPath);
            renameSync(replacementPath, path);
            const handle = await actual.open(path, flags);
            renameSync(path, openedReplacementPath);
            renameSync(displacedPath, path);
            return handle;
          }
          return actual.open(path, flags);
        },
      };
    });
    try {
      const integrity = await import(
        "../../scripts/bridge-support-integrity.mjs?support-open-race-red"
      ) as BridgeSupportIntegrityModule;

      await expect(integrity.directoryDigest(root)).rejects.toThrow(
        "IntentArc bridge support payload changed while being read.",
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a support directory replaced before recursive traversal", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intentarc-support-directory-race-"));
    const root = join(parent, "root");
    const nestedPath = createSupportTree(root, "nested", ["payload.bin"]);
    const displacedPath = join(parent, "displaced");
    const replacementPath = createSupportTree(parent, "replacement", ["outside.bin"]);
    let replaced = false;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        lstat: async (path: string) => {
          if (path === nestedPath && !replaced) {
            const information = await actual.lstat(path);
            replaced = true;
            renameSync(path, displacedPath);
            renameSync(replacementPath, path);
            return information;
          }
          return actual.lstat(path);
        },
      };
    });
    try {
      const integrity = await import(
        "../../scripts/bridge-support-integrity.mjs?support-directory-race-red"
      ) as BridgeSupportIntegrityModule;

      await expect(integrity.directoryDigest(root)).rejects.toThrow(
        "IntentArc bridge support payload changed while being read.",
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "a relative certificate path",
      environment: (root: string) => ({
        INTENTARC_WINDOWS_CERTIFICATE: "relative.pfx",
        INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-secret",
        INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
        WINDOWS_SIGNTOOL_PATH: join(root, "signtool.exe"),
      }),
      message: "certificate file must be absolute",
    },
    {
      label: "a malformed certificate thumbprint",
      environment: (root: string) => ({
        INTENTARC_WINDOWS_CERTIFICATE: join(root, "intentarc.pfx"),
        INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-secret",
        INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(39),
        WINDOWS_SIGNTOOL_PATH: join(root, "signtool.exe"),
      }),
      message: "exact 40-hex",
    },
  ])("rejects $label in bridge signing inputs", async ({
    environment,
    message,
  }) => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-signing-input-"));
    try {
      writeFileSync(join(root, "intentarc.pfx"), "certificate");
      writeFileSync(join(root, "signtool.exe"), "sign tool");
      const { resolveBridgeSigningInputs } = await import(
        "../../scripts/bridge-native-release.mjs"
      );

      await expect(resolveBridgeSigningInputs(environment(root)))
        .rejects.toThrow(message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "a candidate outside its owned root",
      message: "outside its owned root",
      candidate: (root: string, ownedRoot: string) => {
        const path = join(root, "outside.node");
        writeFileSync(path, createPeFixture(0x8664));
        return path;
      },
    },
    {
      label: "a multiply-linked candidate",
      message: "regular non-link file",
      candidate: (root: string, ownedRoot: string) => {
        const source = join(ownedRoot, "source.node");
        const linked = join(ownedRoot, "linked.node");
        writeFileSync(source, createPeFixture(0x8664));
        linkSync(source, linked);
        return linked;
      },
    },
    {
      label: "an x86 PE candidate",
      message: "win32-x64",
      candidate: (root: string, ownedRoot: string) => {
        const path = join(ownedRoot, "win32-x86.node");
        writeFileSync(path, createPeFixture(0x014c));
        return path;
      },
    },
  ])("rejects $label before native signing", async ({
    candidate,
    message,
  }) => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-owned-native-"));
    const ownedRoot = join(root, "owned");
    mkdirSync(ownedRoot);
    try {
      const { assertOwnedX64Pe } = await import(
        "../../scripts/bridge-native-release.mjs"
      );

      await expect(assertOwnedX64Pe(candidate(root, ownedRoot), ownedRoot))
        .rejects.toThrow(message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signs one owned x64 native file with SHA-256 before verifying its configured publisher", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-signing-"));
    const nativePath = createCanonicalNativeFixture(root);
    const signing = {
      certificateFile: join(root, "intentarc.pfx"),
      certificatePassword: "test-secret",
      certificateThumbprint: "A".repeat(40),
      signToolPath: join(root, "signtool.exe"),
    };
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };
      const signingCalls: unknown[] = [];
      const verifiedPaths: string[] = [];

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing,
        sign: async (input: unknown) => {
          signingCalls.push(input);
        },
        verifySignature: async (path: string) => {
          verifiedPaths.push(path);
        },
        readPublisher: async () => ({
          thumbprint: "a".repeat(40),
          subject: "CN=IntentArc",
        }),
      })).resolves.toEqual({
        nativePath,
        sha256: createHash("sha256")
          .update(readFileSync(nativePath))
          .digest("hex"),
      });
      expect(signingCalls).toEqual([{
        files: [nativePath],
        certificateFile: signing.certificateFile,
        certificatePassword: signing.certificatePassword,
        signToolPath: signing.signToolPath,
        hashes: ["sha256"],
      }]);
      expect(verifiedPaths).toEqual([nativePath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds native signer dependency failures without exposing their diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-sign-failure-"));
    const nativePath = createCanonicalNativeFixture(root);
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing: {
          certificateFile: join(root, "intentarc.pfx"),
          certificatePassword: "credential-sentinel",
          certificateThumbprint: "A".repeat(40),
          signToolPath: join(root, "signtool.exe"),
        },
        sign: async () => {
          throw new Error("dependency diagnostic credential-sentinel");
        },
      })).rejects.toThrow(/^IntentArc bridge native signing failed\.$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a contained x64 PE outside the canonical better-sqlite3 prebuild path", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-noncanonical-"));
    const nativePath = join(root, "sibling.node");
    writeFileSync(nativePath, createPeFixture(0x8664));
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing: {
          certificateFile: join(root, "intentarc.pfx"),
          certificatePassword: "test-secret",
          certificateThumbprint: "A".repeat(40),
          signToolPath: process.execPath,
        },
        sign: async () => undefined,
        verifySignature: async () => undefined,
        readPublisher: async () => ({
          thumbprint: "A".repeat(40),
          subject: "CN=IntentArc",
        }),
      })).rejects.toThrow(
        "IntentArc bridge native signing target must be the canonical better-sqlite3 win32-x64 prebuild.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses real windows-sign diagnostics while a PFX password is in scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-debug-"));
    const nativePath = createCanonicalNativeFixture(root);
    const password = "debug-password-sentinel";
    const require = createRequire(import.meta.url);
    const debugControl = require("debug") as {
      disable(): string;
      enable(namespaces: string): void;
      enabled(namespace: string): boolean;
    };
    const previousDebug = debugControl.disable();
    debugControl.enable("electron-windows-sign");
    const stderr = vi.spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing: {
          certificateFile: join(root, "intentarc.pfx"),
          certificatePassword: password,
          certificateThumbprint: "A".repeat(40),
          signToolPath: process.execPath,
        },
      })).rejects.toThrow(/^IntentArc bridge native signing failed\.$/);

      const emitted = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(emitted).not.toContain(password);
      expect(emitted).not.toMatch(/\/p\b/);
      expect(debugControl.enabled("electron-windows-sign")).toBe(true);
    } finally {
      stderr.mockRestore();
      debugControl.disable();
      debugControl.enable(previousDebug);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores and restores ambient windows-sign selectors at the real dependency boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-ambient-"));
    const nativePath = createCanonicalNativeFixture(root);
    const hookPath = join(root, "ambient-hook.cjs");
    const markerPath = join(root, "ambient-hook.executed");
    writeFileSync(hookPath, [
      'const { writeFileSync } = require("node:fs");',
      `module.exports = async () => writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
    ].join("\n"));
    const selectors = {
      WINDOWS_SIGN_HOOK_MODULE_PATH: hookPath,
      WINDOWS_SIGN_WITH_PARAMS: "/a /debug",
      WINDOWS_SIGN_DESCRIPTION: "ambient description",
      WINDOWS_SIGN_WEBSITE: "https://attacker.invalid",
    };
    const originals = Object.fromEntries(
      Object.keys(selectors).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, selectors);
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing: {
          certificateFile: join(root, "intentarc.pfx"),
          certificatePassword: "test-secret",
          certificateThumbprint: "A".repeat(40),
          signToolPath: process.execPath,
        },
        verifySignature: async () => undefined,
        readPublisher: async () => ({
          thumbprint: "A".repeat(40),
          subject: "CN=IntentArc",
        }),
      })).rejects.toThrow(/^IntentArc bridge native signing failed\.$/);
      expect(existsSync(markerPath)).toBe(false);
      expect(Object.fromEntries(
        Object.keys(selectors).map((key) => [key, process.env[key]]),
      )).toEqual(selectors);
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds malformed fulfilled publisher results during native signing", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-native-publisher-"));
    const nativePath = createCanonicalNativeFixture(root);
    try {
      const bridgeNative = await import(
        "../../scripts/bridge-native-release.mjs"
      ) as {
        signAndVerifyBridgeNative(input: Record<string, unknown>): Promise<{
          nativePath: string;
          sha256: string;
        }>;
      };

      await expect(bridgeNative.signAndVerifyBridgeNative({
        nativePath,
        ownerRoot: root,
        signing: {
          certificateFile: join(root, "intentarc.pfx"),
          certificatePassword: "test-secret",
          certificateThumbprint: "A".repeat(40),
          signToolPath: process.execPath,
        },
        sign: async () => undefined,
        verifySignature: async () => undefined,
        readPublisher: async () => ({
          thumbprint: null,
          subject: "CN=IntentArc",
        }),
      })).rejects.toThrow(
        /^IntentArc bridge native publisher verification failed\.$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the deterministic bridge toolchain and composes bridge builds into packaging", () => {
    expect(packageJson.devDependencies.esbuild).toBe("0.28.1");
    expect(packageJson.devDependencies.postject).toBe("1.0.0-alpha.6");
    expect(packageJson.scripts).toMatchObject({
      "bridge:build": "pnpm build:server && node scripts/build-bridge.mjs",
      "desktop:package":
        "pnpm build && pnpm bridge:build && pnpm desktop:resources && electron-forge package --platform win32 --arch x64",
      "desktop:make":
        "pnpm build && pnpm bridge:build && pnpm desktop:resources && node scripts/prepare-squirrel-vendor.mjs && electron-forge make --platform win32 --arch x64",
    });
  });

  it("uses the fixed Node runtime and SEA configuration", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;

    expect(bridgeBuild.BRIDGE_NODE_VERSION).toBe("24.11.0");
    expect(bridgeBuild.createSeaConfig("bridge.cjs", "bridge.blob")).toEqual({
      main: "bridge.cjs",
      output: "bridge.blob",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    });
  });

  it("copies the complete bridge payload as a packaged resource", () => {
    expect(forgeConfig.packagerConfig?.extraResource).toEqual([
      "dist/bridge",
      "dist/desktop-resources",
    ]);
  });

  it("retains only the target native prebuild in Forge package selection", () => {
    const sourcePrebuilds = readdirSync(resolve(
      "node_modules",
      "better-sqlite3",
      "prebuilds",
    ));
    const packagedAppPrebuilds = sourcePrebuilds.filter((name) =>
      !desktopPackageIgnore(resolve(
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        name,
      ))
    );

    expect(packagedAppPrebuilds).toEqual(["win32-x64.node"]);
  });

  it("digests the signed native bytes in the prepared bridge support tree", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-signed-support-"));
    const unsignedRoot = join(testRoot, "unsigned");
    const signedRoot = join(testRoot, "signed");
    const certificateFile = join(testRoot, "intentarc.pfx");
    const signToolPath = join(testRoot, "signtool.exe");
    writeFileSync(certificateFile, "certificate");
    writeFileSync(signToolPath, "sign tool");
    const signingEnvironment = {
      INTENTARC_WINDOWS_CERTIFICATE: certificateFile,
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-secret",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      WINDOWS_SIGNTOOL_PATH: signToolPath,
    };

    try {
      const unsigned = await bridgeBuild.prepareBridgeSupportTree({
        stagingRoot: unsignedRoot,
        buildMode: "unsigned-development",
      });
      const prepared = await bridgeBuild.prepareBridgeSupportTree({
        stagingRoot: signedRoot,
        buildMode: "signed-release",
        environment: signingEnvironment,
        signNative: async ({ nativePath }) => {
          const original = await readFile(nativePath);
          await writeFile(nativePath, Buffer.concat([
            original,
            Buffer.from("deterministic-test-signature"),
          ]));
          return {
            nativePath,
            sha256: createHash("sha256")
              .update(await readFile(nativePath))
              .digest("hex"),
          };
        },
      });

      expect(prepared.nativePath).toBe(join(
        signedRoot,
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        "win32-x64.node",
      ));
      expect(prepared.supportSha256).toBe(
        await bridgeBuild.directoryDigest(prepared.supportRoot),
      );
      expect(prepared.supportSha256).not.toBe(unsigned.supportSha256);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("prepares unsigned bridge support without resolving or invoking signing", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-unsigned-support-"));
    const inaccessibleEnvironment = new Proxy({}, {
      get() {
        throw new Error("unsigned builds must not read signing inputs");
      },
    }) as NodeJS.ProcessEnv;

    try {
      await expect(bridgeBuild.prepareBridgeSupportTree({
        stagingRoot: testRoot,
        buildMode: "unsigned-development",
        environment: inaccessibleEnvironment,
        signNative: async () => {
          throw new Error("unsigned builds must not invoke signing");
        },
      })).resolves.toMatchObject({
        supportRoot: join(testRoot, "node_modules", "better-sqlite3"),
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.11.0",
  )("cleans owned staging after signed preparation fails without touching foreign content", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-signed-cleanup-"));
    const buildParent = join(testRoot, "build");
    const foreignSentinel = join(buildParent, "foreign-sentinel.txt");
    const ownerSentinelContent = "IntentArc dedicated bridge build v1\n";
    const signingKeys = [
      "INTENTARC_WINDOWS_CERTIFICATE",
      "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
      "INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT",
      "WINDOWS_SIGNTOOL_PATH",
    ];
    const savedSigningEnvironment = Object.fromEntries(
      signingKeys.map((key) => [key, process.env[key]]),
    );
    mkdirSync(buildParent, { recursive: true });
    for (const sentinel of [
      ".intentarc-bridge-build-owner",
      ".intentarc-bridge-output-owner",
      ".intentarc-bridge-staging-owner",
    ]) {
      writeFileSync(join(buildParent, sentinel), ownerSentinelContent);
    }
    writeFileSync(foreignSentinel, "must-survive");
    for (const key of signingKeys) delete process.env[key];

    try {
      await expect(bridgeBuild.buildIntentArcBridge({
        buildParent,
        buildMode: "signed-release",
        authorizedPredecessor: null,
      })).rejects.toThrow(
        "IntentArc bridge signing certificate file is required.",
      );
      expect(existsSync(join(buildParent, ".intentarc-bridge-build")))
        .toBe(false);
      expect(readFileSync(foreignSentinel, "utf8")).toBe("must-survive");
    } finally {
      for (const [key, value] of Object.entries(savedSigningEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.11.0",
  )("retains only the target native prebuild in the built Windows bridge payload", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-native-payload-"));
    const buildParent = join(testRoot, "build");

    try {
      await bridgeBuild.buildIntentArcBridge({ buildParent });
      const bridgePrebuilds = readdirSync(join(
        buildParent,
        "bridge",
        "node_modules",
        "better-sqlite3",
        "prebuilds",
      ));

      expect(bridgePrebuilds).toEqual(["win32-x64.node"]);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("removes the copied Node runtime signature before SEA injection", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const executable = Buffer.alloc(384, 0);
    executable.write("MZ", 0, "ascii");
    executable.writeUInt32LE(0x80, 0x3c);
    executable.write("PE\u0000\u0000", 0x80, "binary");
    const optionalHeader = 0x80 + 24;
    executable.writeUInt16LE(0x20b, optionalHeader);
    const certificateDirectory = optionalHeader + 112 + (4 * 8);
    executable.writeUInt32LE(352, certificateDirectory);
    executable.writeUInt32LE(32, certificateDirectory + 4);
    executable.fill(0xab, 352);

    const unsigned = bridgeBuild.stripPeSignature(executable);

    expect(unsigned).toHaveLength(352);
    expect(unsigned.readUInt32LE(certificateDirectory)).toBe(0);
    expect(unsigned.readUInt32LE(certificateDirectory + 4)).toBe(0);
  });

  it.skipIf(
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.11.0",
  )("produces byte-identical executables without embedding private build paths", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-determinism-"));
    const firstParent = join(testRoot, "private-first-build-parent");
    const secondParent = join(testRoot, "private-second-build-parent");
    const firstOutput = join(firstParent, "bridge");
    const secondOutput = join(secondParent, "bridge");

    try {
      await bridgeBuild.buildIntentArcBridge({
        buildParent: firstParent,
      });
      await bridgeBuild.buildIntentArcBridge({
        buildParent: secondParent,
      });

      const first = readFileSync(join(firstOutput, "IntentArc Bridge.exe"));
      const second = readFileSync(join(secondOutput, "IntentArc Bridge.exe"));
      const sha256 = (value: Buffer): string =>
        createHash("sha256").update(value).digest("hex");

      expect(sha256(first)).toBe(sha256(second));
      expect(first.equals(second)).toBe(true);
      for (const privatePath of [
        testRoot,
        firstParent,
        secondParent,
        homedir(),
        tmpdir(),
      ]) {
        expect(first.includes(Buffer.from(privatePath, "utf8"))).toBe(false);
        expect(first.includes(Buffer.from(privatePath, "utf16le"))).toBe(false);
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.11.0",
  )("embeds an exact predecessor authorization in the candidate SEA", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-predecessor-build-"));
    const buildParent = join(testRoot, "candidate");
    const predecessor = {
      formatVersion: 1 as const,
      versionDirectory: "0.1.0-0123456789abcdef",
      releaseVersion: "0.1.0",
      buildMode: "unsigned-development" as const,
      executableSha256: "1".repeat(64),
      payloadSha256: "2".repeat(64),
      supportSha256: "3".repeat(64),
    };

    try {
      await bridgeBuild.buildIntentArcBridge({
        buildParent,
        releaseVersion: "0.2.0",
        buildMode: "unsigned-development",
        authorizedPredecessor: predecessor,
      });
      const output = execFileSync(
        join(buildParent, "bridge", "IntentArc Bridge.exe"),
        ["--bridge-authorized-predecessor"],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );

      expect(JSON.parse(output)).toEqual(predecessor);
    } finally {
      cleanupPredecessorFixture(testRoot, {
        rm: (root, options) => rmSync(root, options),
        exists: existsSync,
        now: () => performance.now(),
        wait: waitForPredecessorFixtureCleanup,
      });
    }
  }, 45_000);

  it.skipIf(
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.11.0",
  )("rejects unsafe or unowned cleanup targets before touching marker files", async () => {
    const bridgeBuild = await import(
      "../../scripts/build-bridge.mjs"
    ) as BuildBridgeModule;
    const testRoot = mkdtempSync(join(tmpdir(), "intentarc-cleanup-safety-"));
    const existingParent = join(testRoot, "existing-nonowned");
    const equalTarget = join(testRoot, "equal-target");
    const overlapOutput = join(testRoot, "overlap-output");
    const outsideOutput = join(testRoot, "outside-output");
    const safeParent = join(testRoot, "explicit-build-parent");
    const markerPaths = [
      join(existingParent, "bridge", "existing-output.marker"),
      join(
        existingParent,
        ".intentarc-bridge-build",
        "existing-staging.marker",
      ),
      join(equalTarget, "equal.marker"),
      join(overlapOutput, "overlap.marker"),
      join(outsideOutput, "outside.marker"),
    ];
    for (const markerPath of markerPaths) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, "must-survive", "utf8");
    }
    const packageMarkerPath = resolve(packageRoot, "package.json");
    const packageMarker = readFileSync(packageMarkerPath);

    const unsafeOptions = [
      {
        label: "filesystem root",
        options: { buildParent: parse(packageRoot).root },
      },
      {
        label: "repository root",
        options: { buildParent: packageRoot },
      },
      {
        label: "repository ancestor",
        options: { buildParent: dirname(packageRoot) },
      },
      {
        label: "existing non-owned directory",
        options: { buildParent: existingParent },
      },
      {
        label: "equal output and staging roots",
        options: {
          buildParent: safeParent,
          outputRoot: equalTarget,
          stagingRoot: equalTarget,
        },
      },
      {
        label: "overlapping output and staging roots",
        options: {
          buildParent: safeParent,
          outputRoot: overlapOutput,
          stagingRoot: join(overlapOutput, "staging"),
        },
      },
      {
        label: "output outside the allowed build parent",
        options: {
          buildParent: safeParent,
          outputRoot: outsideOutput,
          stagingRoot: join(safeParent, ".intentarc-bridge-build"),
        },
      },
    ];

    try {
      for (const { label, options } of unsafeOptions) {
        await expect(
          bridgeBuild.buildIntentArcBridge(options),
          label,
        ).rejects.toThrow(/build|cleanup|owned|safe|root/i);
        expect(readFileSync(packageMarkerPath)).toEqual(packageMarker);
        for (const markerPath of markerPaths) {
          expect(readFileSync(markerPath, "utf8")).toBe("must-survive");
        }
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("keeps the Electron entry graph independent from bridge, MCP, and settings modules", async () => {
    const bundle = await build({
      absWorkingDir: packageRoot,
      entryPoints: ["src/desktop/entry.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: ["electron"],
    });
    const inputs = Object.keys(bundle.metafile!.inputs)
      .map((input) => input.replaceAll("\\", "/"));

    expect(inputs.some((input) => input.includes("/bridge/"))).toBe(false);
    expect(inputs.some((input) => input.includes("/mcp/"))).toBe(false);
    expect(inputs.some((input) => input.endsWith("/desktop/settings.ts"))).toBe(false);
  });
});
