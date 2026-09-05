import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../app/create-application.js";
import { desktopSettingsRoot } from "../desktop/paths.js";
import { createDesktopSettingsStore } from "../desktop/settings.js";
import { resolveWindowsPowerShellInvocation } from "../system/windows-powershell.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  delegateStableBridgeLaunch,
  launchAuthenticatedBridgeTarget,
  resolveOsRootedWindowsPowerShellPath,
  runIntentArcBridge,
  type DesktopMcpConnection,
} from "./entry.js";

const bridgeExecutable = resolve("dist", "bridge", "IntentArc Bridge.exe");
const executeFile = promisify(execFile);
const temporaryRoots: string[] = [];
const temporaryDatabases: TemporaryDatabase[] = [];
const childProcesses: ChildProcess[] = [];
const activationOwnerEnvironmentKey =
  "INTENTARC_BRIDGE_ACTIVATION_TRANSACTION_OWNER";
const activationTransaction = {
  transactionId: "22222222-2222-4222-8222-222222222222",
  phase: "active-verification" as const,
};

beforeAll(async () => {
  await executeFile(
    process.execPath,
    [resolve("scripts", "build-bridge.mjs")],
    {
      cwd: process.cwd(),
      windowsHide: true,
    },
  );
}, 30_000);

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const createBridgeFixture = (): {
  appData: string;
  connectionId: string;
  environment: Record<string, string>;
} => {
  const appData = mkdtempSync(join(tmpdir(), "intentarc-bridge-"));
  const database = createTemporaryDatabase();
  temporaryRoots.push(appData);
  temporaryDatabases.push(database);

  const application = createApplication({ databasePath: database.path });
  const created = application.service.profiles.createProfile({
    name: "Packaged bridge profile",
  });
  application.close();

  const connectionId = "packaged-connection";
  createDesktopSettingsStore(join(appData, "IntentArc")).write({
    schemaVersion: 2,
    archivePath: database.path,
    onboardingCompleted: true,
    connections: [{
      id: connectionId,
      kind: "managed",
      adapterId: "codex",
      profileId: created.profile.id,
      profileToken: created.token,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    }],
  });

  return {
    appData,
    connectionId,
    environment: {
      ...inheritedEnvironment(),
      APPDATA: appData,
    },
  };
};

const waitForChildExit = async (
  child: ChildProcess,
  timeoutMilliseconds = 5_000,
): Promise<number | null> => {
  if (child.exitCode !== null) return child.exitCode;

  let timer: NodeJS.Timeout | undefined;
  try {
    const exit = once(child, "close").then(([code]) => code as number | null);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("IntentArc bridge did not exit promptly."));
      }, timeoutMilliseconds);
    });
    return await Promise.race([exit, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

afterEach(() => {
  while (childProcesses.length > 0) {
    const child = childProcesses.pop()!;
    if (child.exitCode === null) child.kill();
  }
  while (temporaryDatabases.length > 0) {
    removeTemporaryDatabase(temporaryDatabases.pop()!);
  }
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("stable launcher activation ownership", () => {
  const authenticatedTarget = {
    targetPath: "C:\\IntentArc\\bridge\\versions\\0.2.0-target\\IntentArc Bridge.exe",
    executableSha256: "a".repeat(64),
    identity: {
      formatVersion: 1 as const,
      releaseVersion: "0.2.0",
      buildMode: "unsigned-development" as const,
      supportSha256: "b".repeat(64),
    },
  };

  it("lets an exact live transaction verification child delegate without recursive recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-owner-child-"));
    temporaryRoots.push(root);
    const stablePath = join(
      root,
      "bridge",
      "current",
      "IntentArc Bridge.exe",
    );
    let recoveries = 0;
    let launches = 0;

    await expect(delegateStableBridgeLaunch({
      executablePath: stablePath,
      environment: {
        [activationOwnerEnvironmentKey]: activationTransaction.transactionId,
      },
      readActivationTransaction: async () => activationTransaction,
      recoverActivation: async () => {
        recoveries += 1;
        return true;
      },
      verifyRecoveryProtocol: async () => {
        throw new Error("a verification child must not recurse");
      },
      authenticateTarget: async () => authenticatedTarget,
      launchTarget: async () => {
        launches += 1;
        return 0;
      },
      setExitCode: () => undefined,
    })).resolves.toBe(true);

    expect(recoveries).toBe(0);
    expect(launches).toBe(1);
  });

  it.each([
    { label: "missing", marker: undefined },
    { label: "mismatched", marker: "33333333-3333-4333-8333-333333333333" },
    { label: "malformed", marker: "not-a-transaction" },
  ])("runs one full active protocol recovery for a $label owner marker", async ({
    marker,
  }) => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-owner-recovery-"));
    temporaryRoots.push(root);
    const stablePath = join(
      root,
      "bridge",
      "current",
      "IntentArc Bridge.exe",
    );
    let recoveries = 0;
    let protocolChecks = 0;
    let launches = 0;

    await expect(delegateStableBridgeLaunch({
      executablePath: stablePath,
      environment: marker === undefined
        ? {}
        : { [activationOwnerEnvironmentKey]: marker },
      readActivationTransaction: async () => activationTransaction,
      recoverActivation: async (input) => {
        recoveries += 1;
        await input.verify({
          phase: "active",
          executablePath: stablePath,
          versionDirectory:
            "C:\\IntentArc\\bridge\\versions\\0.2.0-target",
          binaryRoot: root,
          activationTransaction,
        });
        return true;
      },
      verifyRecoveryProtocol: async (input) => {
        protocolChecks += 1;
        expect(input.activationTransaction).toEqual(activationTransaction);
        return authenticatedTarget.identity;
      },
      authenticateTarget: async () => authenticatedTarget,
      launchTarget: async () => {
        launches += 1;
        return 0;
      },
      setExitCode: () => undefined,
    })).resolves.toBe(true);

    expect(recoveries).toBe(1);
    expect(protocolChecks).toBe(1);
    expect(launches).toBe(1);
  });
});

describe("runIntentArcBridge", () => {
  it("delegates a stable launcher before interpreting protocol arguments", async () => {
    let delegations = 0;
    let settingsReads = 0;
    let healthChecks = 0;

    await runIntentArcBridge({
      argv: ["--health-check"],
      delegateStableLaunch: async () => {
        delegations += 1;
        return true;
      },
      loadConnection: () => {
        settingsReads += 1;
        return undefined;
      },
      runHealthCheck: async () => {
        healthChecks += 1;
      },
    });

    expect(delegations).toBe(1);
    expect(settingsReads).toBe(0);
    expect(healthChecks).toBe(0);
  });

  it("runs an isolated native health check without loading settings or MCP", async () => {
    let settingsReads = 0;
    let mcpStarts = 0;
    let healthChecks = 0;

    await runIntentArcBridge({
      argv: ["--health-check"],
      loadConnection: () => {
        settingsReads += 1;
        return undefined;
      },
      runMcp: async () => {
        mcpStarts += 1;
      },
      runHealthCheck: async () => {
        healthChecks += 1;
      },
    });

    expect(healthChecks).toBe(1);
    expect(settingsReads).toBe(0);
    expect(mcpStarts).toBe(0);
  });

  it("starts MCP with the private connection selected by opaque identifier", async () => {
    let observed: DesktopMcpConnection | undefined;

    await runIntentArcBridge({
      argv: ["--connection", "connection-1"],
      loadConnection: () => ({
        databasePath: "C:\\data\\intentarc.sqlite",
        profileId: "profile-1",
        profileToken: "token",
      }),
      runMcp: async (input) => {
        observed = input;
      },
    });

    expect(observed).toMatchObject({
      databasePath: "C:\\data\\intentarc.sqlite",
      profileId: "profile-1",
    });
  });

  it("loads a manual MCP connection using only common credential fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "intentarc-manual-bridge-"));
    temporaryRoots.push(root);
    const environment = {
      APPDATA: root,
      XDG_CONFIG_HOME: root,
    };
    const settingsRoot = desktopSettingsRoot({
      platform: process.platform,
      environment,
      homeDirectory: root,
    });
    createDesktopSettingsStore(settingsRoot).write({
      schemaVersion: 2,
      archivePath: join(root, "intentarc.sqlite"),
      onboardingCompleted: true,
      connections: [{
        id: "manual-connection",
        kind: "manual-mcp",
        label: "Local MCP",
        profileId: "manual-profile",
        profileToken: "manual-token",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });
    let observed: DesktopMcpConnection | undefined;

    await runIntentArcBridge({
      argv: ["--connection", "manual-connection"],
      environment,
      homeDirectory: root,
      delegateStableLaunch: async () => false,
      runMcp: async (input) => {
        observed = { ...input };
      },
    });

    expect(observed).toEqual({
      databasePath: join(root, "intentarc.sqlite"),
      profileId: "manual-profile",
      profileToken: "manual-token",
    });
  });

  it("clears the loaded profile token as soon as MCP consumes credentials", async () => {
    const loadedConnection: DesktopMcpConnection = {
      databasePath: "C:\\data\\intentarc.sqlite",
      profileId: "profile-1",
      profileToken: "session-secret",
    };
    const mcpStarted = Promise.withResolvers<void>();
    const session = Promise.withResolvers<void>();
    let credentialsConsumed: (() => void) | undefined;

    const running = runIntentArcBridge({
      argv: ["--connection", "connection-1"],
      loadConnection: () => loadedConnection,
      runMcp: async (_connection, onCredentialsConsumed) => {
        credentialsConsumed = onCredentialsConsumed;
        mcpStarted.resolve();
        await session.promise;
      },
    });

    await mcpStarted.promise;
    expect(loadedConnection.profileToken).toBe("session-secret");

    credentialsConsumed!();
    expect(loadedConnection.profileToken).toBe("");

    session.resolve();
    await running;
  });

  it("does not create or delete filesystem process references during MCP lifecycle", async () => {
    let releaseOnShutdown: (() => Promise<void>) | undefined;

    await runIntentArcBridge({
      argv: ["--connection", "connection-1"],
      loadConnection: () => ({
        databasePath: "C:\\data\\intentarc.sqlite",
        profileId: "profile-1",
        profileToken: "session-secret",
      }),
      runMcp: async (_connection, _onCredentialsConsumed, onShutdown) => {
        releaseOnShutdown = onShutdown;
      },
    });

    expect(releaseOnShutdown).toBeTypeOf("function");
    await releaseOnShutdown!();
    await releaseOnShutdown!();
  });

  it("reports the embedded build identity without loading settings, native code, or MCP", async () => {
    let stdout = "";
    let delegations = 0;
    let settingsReads = 0;
    let healthChecks = 0;

    await runIntentArcBridge({
      argv: ["--bridge-identity"],
      delegateStableLaunch: async () => {
        delegations += 1;
        return true;
      },
      stdout: {
        write: (message) => {
          stdout += message;
        },
      },
      loadConnection: () => {
        settingsReads += 1;
        return undefined;
      },
      runHealthCheck: async () => {
        healthChecks += 1;
      },
    });

    expect(JSON.parse(stdout)).toMatchObject({
      formatVersion: 1,
      releaseVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      buildMode: "unsigned-development",
      supportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(delegations).toBe(0);
    expect(settingsReads).toBe(0);
    expect(healthChecks).toBe(0);
  });

  it.each([
    {
      label: "missing",
      argv: [],
      loadConnection: () => {
        throw new Error("settings must not be read");
      },
      secret: "",
    },
    {
      label: "duplicate",
      argv: ["--connection", "first", "--connection", "second"],
      loadConnection: () => {
        throw new Error("settings must not be read");
      },
      secret: "second",
    },
    {
      label: "unknown",
      argv: ["--connection", "private-connection-id"],
      loadConnection: () => undefined,
      secret: "private-connection-id",
    },
  ])("rejects $label connection arguments without exposing connection data", async ({
    argv,
    loadConnection,
    secret,
  }) => {
    let diagnostics = "";
    let exitCode: number | undefined;
    let mcpStarts = 0;

    await runIntentArcBridge({
      argv,
      loadConnection,
      runMcp: async () => {
        mcpStarts += 1;
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(mcpStarts).toBe(0);
    expect(exitCode).toBe(2);
    expect(diagnostics).toBe("Invalid IntentArc bridge launch arguments.\n");
    if (secret) expect(diagnostics).not.toContain(secret);
  });

  it("sanitizes connection-store failures", async () => {
    let diagnostics = "";
    let exitCode: number | undefined;

    await runIntentArcBridge({
      argv: ["--connection", "secret-connection"],
      loadConnection: () => {
        throw new Error("credential-bearing settings error");
      },
      runMcp: async () => {
        throw new Error("MCP must not start");
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(2);
    expect(diagnostics).toBe("Invalid IntentArc bridge launch arguments.\n");
    expect(diagnostics).not.toContain("secret-connection");
    expect(diagnostics).not.toContain("credential-bearing");
  });
});

describe.skipIf(process.platform !== "win32")("held-launch helper selection", () => {
  it("resolves PowerShell from the Windows object namespace without consulting caller environment", () => {
    const observed: string[] = [];
    const canonical = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    const resolved = resolveOsRootedWindowsPowerShellPath((path) => {
      observed.push(path);
      return canonical;
    });

    expect(observed).toEqual([
      "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    expect(resolved).toBe(canonical);
  });

  it("case-insensitively replaces every caller-controlled selector with OS-rooted values", () => {
    const canonical =
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const invocation = resolveWindowsPowerShellInvocation({
      sYsTeMrOoT: "C:\\attacker-one",
      SYSTEMROOT: "C:\\attacker-two",
      PaTh: "C:\\attacker-bin-one",
      PATH: "C:\\attacker-bin-two",
      cOmSpEc: "C:\\attacker-cmd-one.exe",
      ComSpec: "C:\\attacker-cmd-two.exe",
      PsMoDuLePaTh: "C:\\attacker-modules",
      WiNdIr: "C:\\attacker-windows",
      INTENTARC_PRESERVED: "preserved",
    }, () => canonical);

    expect(invocation).toEqual({
      executablePath: canonical,
      environment: {
        INTENTARC_PRESERVED: "preserved",
        SystemRoot: "D:\\Windows",
        WINDIR: "D:\\Windows",
      },
    });
  });

  it.each([
    {
      label: "hostile",
      environment: {
        SystemRoot: "C:\\attacker",
        SYSTEMROOT: "D:\\attacker",
        PATH: "C:\\attacker",
        ComSpec: "C:\\attacker\\cmd.exe",
      },
    },
    {
      label: "empty",
      environment: {
        SystemRoot: "",
        SYSTEMROOT: "",
        PATH: "",
        ComSpec: "",
      },
    },
  ])("launches the OS-rooted helper with a $label selector environment", async ({
    environment,
  }) => {
    const { stdout } = await executeFile(
      bridgeExecutable,
      ["--bridge-identity"],
      {
        windowsHide: true,
        maxBuffer: 4096,
      },
    );
    const identity = JSON.parse(stdout);

    await expect(launchAuthenticatedBridgeTarget({
      targetPath: bridgeExecutable,
      executableSha256: createHash("sha256")
        .update(readFileSync(bridgeExecutable))
        .digest("hex"),
      identity,
    }, ["--health-check"], environment)).resolves.toBe(0);
  });
});

describe.skipIf(process.platform !== "win32")("packaged IntentArc bridge", () => {
  it("initializes through the official SDK with the selected profile and exits when stdin closes", async () => {
    const fixture = createBridgeFixture();
    const transport = new StdioClientTransport({
      command: bridgeExecutable,
      args: ["--connection", fixture.connectionId],
      env: fixture.environment,
      stderr: "pipe",
    });
    const client = new Client({
      name: "IntentArc packaged bridge test",
      version: "1.0.0",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });

    await client.connect(transport);
    const child = (transport as unknown as {
      _process?: ChildProcess;
    })._process;
    expect(child).toBeDefined();
    childProcesses.push(child!);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toContain("submit_change_set");

    const exited = waitForChildExit(child!);
    await client.close();
    await expect(exited).resolves.toBe(0);
    expect(diagnostics).toBe("");
  }, 15_000);

  it("starts protocol stdout with a JSON object and exits zero after raw client stdin closes", async () => {
    const fixture = createBridgeFixture();
    const child = spawn(
      bridgeExecutable,
      ["--connection", fixture.connectionId],
      {
        env: fixture.environment,
        windowsHide: true,
      },
    );
    childProcesses.push(child);

    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "IntentArc raw bridge test",
          version: "1.0.0",
        },
      },
    })}\n`);

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolveResponse) => {
          const inspect = (): void => {
            const lines = stdout.toString("utf8").split(/\r?\n/);
            if (lines.some((line) => {
              if (!line) return false;
              const message = JSON.parse(line) as { id?: unknown; result?: unknown };
              return message.id === 1 && message.result !== undefined;
            })) {
              resolveResponse();
            }
          };
          child.stdout.on("data", inspect);
          inspect();
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `Bridge initialize timed out. stdout=${JSON.stringify(stdout.toString())} stderr=${JSON.stringify(stderr)}`,
            ));
          }, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    expect(stdout[0]).toBe("{".charCodeAt(0));
    expect(stderr).toBe("");

    const exited = waitForChildExit(child);
    child.stdin.end();
    await expect(exited).resolves.toBe(0);
  }, 15_000);

  it.each([
    { label: "malformed", argv: [] },
    { label: "unknown", argv: ["--connection", "unknown-secret-id"] },
  ])("rejects $label packaged launches with byte-clean stdout and sanitized stderr", async ({
    argv,
  }) => {
    const fixture = createBridgeFixture();
    const child = spawn(bridgeExecutable, argv, {
      env: fixture.environment,
      windowsHide: true,
    });
    childProcesses.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await expect(waitForChildExit(child)).resolves.toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("Invalid IntentArc bridge launch arguments.\n");
    expect(stderr).not.toContain("unknown-secret-id");
  }, 15_000);
});
