import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildClientPortabilitySupervisor } from "../../../scripts/build-client-portability-supervisor.mjs";
import {
  createProductionSupervisorOwnedSession,
  runClientPortabilitySessionSupervisor,
  type SupervisorBridgeIdentity,
  type SupervisorOwnedSession,
  type SupervisorRuntimeDependencies,
  type SupervisorSessionIdentity,
} from "./client-portability-session-supervisor.js";
import {
  CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES,
  createSupervisorFrameDecoder,
  encodeSupervisorFrame,
  type SupervisorFrame,
  type SupervisorRequestFrame,
} from "./client-portability-supervisor-protocol.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_ID = `codex-${RUN_ID}`;
const NONCE = "a".repeat(64);
const BRIDGE_IDENTITY: SupervisorBridgeIdentity = {
  pid: 4172,
  startTime: "1787371200123",
};

const request = (
  operation: SupervisorRequestFrame["operation"],
  number: number,
  payload: unknown,
): SupervisorRequestFrame => ({
  version: 1,
  kind: "request",
  runId: RUN_ID,
  sessionId: SESSION_ID,
  nonce: NONCE,
  requestId: `123e4567-e89b-42d3-a456-4266141740${number.toString().padStart(2, "0")}`,
  operation,
  payload,
});

const connectRequest = request("connect", 1, {
  bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
  connectionId: "connection-1",
  settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
});
const callToolRequest = request("callTool", 2, {
  name: "list_projects",
  arguments: {},
});
const closeRequest = request("close", 3, {});

const correlated = (frame: Omit<SupervisorFrame, "version" | "runId" | "sessionId" | "nonce">): SupervisorFrame => ({
  version: 1,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  nonce: NONCE,
  ...frame,
} as SupervisorFrame);

interface ExchangeResult {
  readonly frames: readonly SupervisorFrame[];
  readonly diagnostics: string;
  readonly closeCalls: number;
  readonly createdWith: readonly SupervisorSessionIdentity[];
}

const exchange = async (
  requests: readonly SupervisorRequestFrame[],
  session: SupervisorOwnedSession,
): Promise<ExchangeResult> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const decoder = createSupervisorFrameDecoder();
  const frames: SupervisorFrame[] = [];
  let diagnostics = "";
  let closeCalls = 0;
  const createdWith: SupervisorSessionIdentity[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8");
  });
  const wrappedSession: SupervisorOwnedSession = {
    bridgeIdentity: session.bridgeIdentity,
    connect: (input) => session.connect(input),
    callTool: (input) => session.callTool(input),
    close: async () => {
      closeCalls += 1;
      await session.close();
    },
  };
  const dependencies: SupervisorRuntimeDependencies = {
    createSession: (identity) => {
      createdWith.push(identity);
      return wrappedSession;
    },
    now: () => 1_787_371_200_123,
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const running = runClientPortabilitySessionSupervisor({
    stdin,
    stdout,
    stderr,
    dependencies,
  });
  for (const frame of requests) stdin.write(encodeSupervisorFrame(frame));
  stdin.end();
  await running;
  expect(decoder.end()).toEqual([]);
  return { frames, diagnostics, closeCalls, createdWith };
};

const recordingSession = (
  overrides: Partial<SupervisorOwnedSession> = {},
): SupervisorOwnedSession => ({
  bridgeIdentity: Promise.resolve(BRIDGE_IDENTITY),
  connect: async () => BRIDGE_IDENTITY,
  callTool: async () => ({ structuredContent: { projects: [] } }),
  close: async () => undefined,
  ...overrides,
});

describe("client portability session supervisor", () => {
  it("serializes connect, tool, and graceful close receipts in lifecycle order", async () => {
    // Catches removing/reordering any externally visible lifecycle receipt.
    const result = await exchange(
      [connectRequest, callToolRequest, closeRequest],
      recordingSession(),
    );

    expect(result.frames).toEqual([
      correlated({ kind: "bridge_identity", payload: BRIDGE_IDENTITY }),
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "ready" },
      }),
      correlated({
        kind: "response",
        requestId: callToolRequest.requestId,
        payload: { structuredContent: { projects: [] } },
      }),
      correlated({
        kind: "response",
        requestId: closeRequest.requestId,
        payload: { status: "closed" },
      }),
      correlated({ kind: "terminal", payload: { status: "closed" } }),
    ]);
    expect(result.closeCalls).toBe(1);
    expect(result.createdWith).toEqual([{
      runId: RUN_ID,
      sessionId: SESSION_ID,
      nonce: NONCE,
    }]);
    expect(result.diagnostics).toBe("");
  });

  it("reports a known bridge identity before a bounded connection failure", async () => {
    // Catches discarding a spawned bridge identity when MCP initialization rejects.
    const secret = "credential-bearing-connect-error";
    const result = await exchange([connectRequest], recordingSession({
      connect: async () => Promise.reject({
        bridgeIdentity: BRIDGE_IDENTITY,
        source: new Error(secret),
      }),
    }));

    expect(result.frames).toEqual([
      correlated({ kind: "bridge_identity", payload: BRIDGE_IDENTITY }),
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "failed", category: "supervisor_startup" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_startup" },
      }),
    ]);
    expect(result.frames.filter(({ kind }) => kind === "bridge_identity")).toHaveLength(1);
    expect(result.closeCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("cancels a hanging connection when its input reaches EOF", async () => {
    // Catches awaiting MCP initialization forever after the parent disappears.
    const close = vi.fn(async () => undefined);
    const result = await exchange([connectRequest], recordingSession({
      bridgeIdentity: Promise.resolve(null),
      connect: async () => new Promise<SupervisorBridgeIdentity>(() => undefined),
      close,
    }));

    expect(result.frames).toEqual([
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "failed", category: "supervisor_startup" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_startup" },
      }),
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("emits an observed bridge identity before canceling a pending connect on EOF", async () => {
    // Catches losing a spawned process identity merely because MCP initialization never settled.
    const result = await exchange([connectRequest], recordingSession({
      bridgeIdentity: Promise.resolve(BRIDGE_IDENTITY),
      connect: async () => new Promise<SupervisorBridgeIdentity>(() => undefined),
      close: async () => undefined,
    }));

    expect(result.frames).toEqual([
      correlated({ kind: "bridge_identity", payload: BRIDGE_IDENTITY }),
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "failed", category: "supervisor_startup" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_startup" },
      }),
    ]);
    expect(result.frames.filter(({ kind }) => kind === "bridge_identity")).toHaveLength(1);
  });

  it("orders identity discovered during EOF cleanup before the failure response", async () => {
    // Catches close resolving null or serializing failure while identity observation is in flight.
    let resolveIdentity!: (identity: SupervisorBridgeIdentity) => void;
    const bridgeIdentity = new Promise<SupervisorBridgeIdentity>((resolveBridgeIdentity) => {
      resolveIdentity = resolveBridgeIdentity;
    });
    const result = await exchange([connectRequest], recordingSession({
      bridgeIdentity,
      connect: async () => new Promise<SupervisorBridgeIdentity>(() => undefined),
      close: async () => {
        resolveIdentity(BRIDGE_IDENTITY);
        await Promise.resolve();
      },
    }));

    expect(result.frames).toEqual([
      correlated({ kind: "bridge_identity", payload: BRIDGE_IDENTITY }),
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "failed", category: "supervisor_startup" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_startup" },
      }),
    ]);
  });

  it("maps an arbitrary tool failure to the journey category without raw data", async () => {
    // Catches serializing dependency errors or continuing after a failed journey step.
    const secret = "provider-response-secret";
    const result = await exchange(
      [connectRequest, callToolRequest],
      recordingSession({
        callTool: async () => Promise.reject(new Error(secret)),
      }),
    );

    expect(result.frames.slice(-2)).toEqual([
      correlated({
        kind: "response",
        requestId: callToolRequest.requestId,
        payload: { status: "failed", category: "journey" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "journey" },
      }),
    ]);
    expect(result.closeCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("maps a cyclic tool result to journey while request correlation remains pending", async () => {
    // Catches outbound encoding mutating correlation state before proving the result is serializable.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await exchange(
      [connectRequest, callToolRequest],
      recordingSession({ callTool: async () => cyclic }),
    );

    expect(result.frames.slice(-2)).toEqual([
      correlated({
        kind: "response",
        requestId: callToolRequest.requestId,
        payload: { status: "failed", category: "journey" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "journey" },
      }),
    ]);
    expect(result.frames.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
  });

  it("maps an oversized tool result to journey while request correlation remains pending", async () => {
    // Catches frame-ceiling rejection poisoning the output queue before bounded failure receipts.
    const result = await exchange(
      [connectRequest, callToolRequest],
      recordingSession({
        callTool: async () => ({
          structuredContent: {
            value: "x".repeat(CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES),
          },
        }),
      }),
    );

    expect(result.frames.slice(-2)).toEqual([
      correlated({
        kind: "response",
        requestId: callToolRequest.requestId,
        payload: { status: "failed", category: "journey" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "journey" },
      }),
    ]);
    expect(result.frames.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
  });

  it("maps close rejection once to graceful_close", async () => {
    // Catches treating a rejected close as successful or emitting two terminal frames.
    const secret = "raw-close-secret";
    const result = await exchange(
      [connectRequest, closeRequest],
      recordingSession({ close: async () => Promise.reject(new Error(secret)) }),
    );

    expect(result.frames.slice(-2)).toEqual([
      correlated({
        kind: "response",
        requestId: closeRequest.requestId,
        payload: { status: "failed", category: "graceful_close" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "graceful_close" },
      }),
    ]);
    expect(result.frames.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps diagnostics bounded when an injected error is much larger than 64 KiB", async () => {
    // Catches unbounded or raw dependency diagnostics escaping through stderr/output.
    const secret = "sensitive-environment-value";
    const result = await exchange([connectRequest], recordingSession({
      connect: async () => Promise.reject(new Error(secret.repeat(100_000))),
    }));

    expect(Buffer.byteLength(result.diagnostics)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.frames.at(-1)).toEqual(correlated({
      kind: "terminal",
      payload: { status: "failed", category: "supervisor_startup" },
    }));
  });

  it("rejects malformed operation payloads with a stable protocol category", async () => {
    // Catches accepting unknown connect keys or leaking schema diagnostics.
    const malformed = {
      ...connectRequest,
      payload: { ...connectRequest.payload as object, rawEnvironment: "secret" },
    };
    const result = await exchange([malformed], recordingSession());

    expect(result.frames).toEqual([
      correlated({
        kind: "response",
        requestId: connectRequest.requestId,
        payload: { status: "failed", category: "supervisor_protocol" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_protocol" },
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("rawEnvironment");
    expect(result.closeCalls).toBe(0);
    expect(result.createdWith).toEqual([]);
  });

  it("does not emit a second terminal event for a request after closing", async () => {
    // Catches processing buffered work after the close terminal receipt.
    const result = await exchange(
      [connectRequest, closeRequest, callToolRequest],
      recordingSession(),
    );

    expect(result.frames.filter(({ kind }) => kind === "terminal")).toEqual([
      correlated({ kind: "terminal", payload: { status: "closed" } }),
    ]);
    expect(result.frames.some((frame) =>
      frame.kind === "response" && frame.requestId === callToolRequest.requestId
    )).toBe(false);
  });

  it("does not create a session when the first request is not connect", async () => {
    // Catches allocating an MCP client or transport before Task 1 binds a valid session.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const createSession = vi.fn(() => recordingSession());
    let diagnostics = "";
    stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    const exited = new Error("exit");
    const running = runClientPortabilitySessionSupervisor({
      stdin,
      stdout,
      stderr,
      dependencies: {
        createSession,
        now: () => 1_787_371_200_123,
        exit: () => { throw exited; },
      },
    });
    stdin.end(encodeSupervisorFrame(request("callTool", 1, {
      name: "list_projects",
      arguments: {},
    })));

    await expect(running).rejects.toBe(exited);
    expect(createSession).not.toHaveBeenCalled();
    expect(diagnostics).toBe('{"status":"failed","category":"supervisor_protocol"}\n');
  });

  it("returns after its terminal receipt even while parent stdin remains open", async () => {
    // Catches a settled supervisor remaining blocked forever on an open parent pipe.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const running = runClientPortabilitySessionSupervisor({
      stdin,
      stdout,
      stderr,
      dependencies: {
        createSession: () => recordingSession(),
        now: () => 1_787_371_200_123,
        exit: (code) => { throw new Error(`unexpected exit ${code}`); },
      },
    });
    stdin.write(Buffer.concat([
      Buffer.from(encodeSupervisorFrame(connectRequest)),
      Buffer.from(encodeSupervisorFrame(closeRequest)),
    ]));
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        running.then(() => "returned" as const),
        new Promise<"timed_out">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timed_out"), 100);
        }),
      ]);
      expect(outcome).toBe("returned");
    } finally {
      if (timer) clearTimeout(timer);
      stdin.destroy();
      await running.catch(() => undefined);
    }
  });

  it("classifies EOF after ready as a protocol failure", async () => {
    // Catches presenting disappearance of the parent as a requested graceful close.
    const result = await exchange([connectRequest], recordingSession());

    expect(result.frames.at(-1)).toEqual(correlated({
      kind: "terminal",
      payload: { status: "failed", category: "supervisor_protocol" },
    }));
    expect(result.closeCalls).toBe(1);
  });

  it("does not inspect arbitrary failure getters outside the bounded operation category", async () => {
    // Catches a throwing getter bypassing the correlated journey failure receipt.
    const hostile = Object.defineProperty({}, "bridgeIdentity", {
      get: () => { throw new Error("hostile-error-getter-secret"); },
    });
    const result = await exchange(
      [connectRequest, callToolRequest],
      recordingSession({ callTool: async () => Promise.reject(hostile) }),
    );

    expect(result.frames.slice(-2)).toEqual([
      correlated({
        kind: "response",
        requestId: callToolRequest.requestId,
        payload: { status: "failed", category: "journey" },
      }),
      correlated({
        kind: "terminal",
        payload: { status: "failed", category: "journey" },
      }),
    ]);
  });

  it("rejects empty EOF without creating a session", async () => {
    // Catches accepting an absent first frame as successful supervisor completion.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const createSession = vi.fn(() => recordingSession());
    let diagnostics = "";
    stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
    const exited = new Error("exit");
    const running = runClientPortabilitySessionSupervisor({
      stdin,
      stdout,
      stderr,
      dependencies: {
        createSession,
        now: () => 1_787_371_200_123,
        exit: () => { throw exited; },
      },
    });
    stdin.end();

    await expect(running).rejects.toBe(exited);
    expect(createSession).not.toHaveBeenCalled();
    expect(diagnostics).toBe('{"status":"failed","category":"supervisor_protocol"}\n');
  });
});

describe("production supervisor-owned session", () => {
  const identity: SupervisorSessionIdentity = {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    nonce: NONCE,
  };

  it("binds one client and transport to the exact bridge launch contract", async () => {
    // Catches shell/path indirection, argument drift, broad environment inheritance, or wrong client kind.
    const stderr = new PassThrough();
    const transport = { pid: 5820 as number | null, stderr };
    const calls: unknown[] = [];
    let transportInput: unknown;
    let clientInput: unknown;
    let observedJobName: string | undefined;
    const jobName = `Local\\IntentArcPortability-${"1".repeat(64)}`;
    const client = {
      connect: async (input: unknown) => { calls.push(["connect", input]); },
      callTool: async (input: unknown) => {
        calls.push(["callTool", input]);
        return { structuredContent: { ok: true } };
      },
      close: async () => { calls.push(["close"]); },
    };
    const session = createProductionSupervisorOwnedSession({ ...identity, jobName }, {
      createTransport: (input) => {
        transportInput = input;
        return transport;
      },
      createClient: (input) => {
        clientInput = input;
        return client;
      },
      observeBridgeIdentity: async (pid, receivedJobName?: string) => {
        observedJobName = receivedJobName;
        return { pid, startTime: "638914932000000000" };
      },
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });

    await expect(session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    })).resolves.toEqual({ pid: 5820, startTime: "638914932000000000" });
    await expect(session.callTool({
      name: "list_projects",
      arguments: {},
    })).resolves.toEqual({ structuredContent: { ok: true } });
    await session.close();
    await session.close();

    expect(clientInput).toEqual({
      name: "IntentArc installed codex portability supervisor",
      version: "1.0.0",
    });
    expect(observedJobName).toBe(jobName);
    expect(transportInput).toEqual({
      command: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      args: ["--connection", "connection-1"],
      env: { APPDATA: "C:\\Users\\fixture\\AppData\\Roaming" },
      stderr: "pipe",
    });
    expect(calls).toEqual([
      ["connect", transport],
      ["callTool", { name: "list_projects", arguments: {} }],
      ["close"],
    ]);
  });

  it("rejects relative bridge and settings paths before creating a transport", async () => {
    // Catches letting the child resolve an executable or settings directory through ambient state.
    const createTransport = vi.fn(() => ({ pid: null, stderr: null }));
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport,
      createClient: () => ({
        connect: async () => undefined,
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async () => undefined,
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });

    await expect(session.connect({
      bridgeExecutable: ".\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: ".\\IntentArc",
    })).rejects.toBeDefined();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("never creates a second transport for a repeated connect call", async () => {
    // Catches misuse of the exported session factory violating single-transport ownership.
    const transport = { pid: 5012 as number | null, stderr: new PassThrough() };
    const createTransport = vi.fn(() => transport);
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport,
      createClient: () => ({
        connect: async () => undefined,
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async (pid) => ({ pid, startTime: "638914932000000004" }),
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    };

    await session.connect(input);
    await expect(session.connect(input)).rejects.toBeDefined();
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it("preserves bridge identity when client connection rejects", async () => {
    // Catches losing the only safe process handle during MCP handshake failure.
    const secret = "raw-sdk-connect-error";
    const transport = { pid: null as number | null, stderr: new PassThrough() };
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => transport,
      createClient: () => ({
        connect: async () => {
          transport.pid = 9032;
          await Promise.resolve();
          throw new Error(secret);
        },
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async (pid) => ({ pid, startTime: "638914932000000001" }),
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });

    const failure = await session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      bridgeIdentity: { pid: 9032, startTime: "638914932000000001" },
      diagnosticsBytes: 0,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("publishes bridge identity while client connection remains pending", async () => {
    // Catches coupling safe process identity observation to MCP handshake completion.
    const transport = { pid: 6044 as number | null, stderr: new PassThrough() };
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => transport,
      createClient: () => ({
        connect: async () => new Promise<void>(() => undefined),
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async (pid) => ({ pid, startTime: "638914932000000003" }),
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });
    void session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    });

    await expect(session.bridgeIdentity).resolves.toEqual({
      pid: 6044,
      startTime: "638914932000000003",
    });
    await session.close();
  });

  it("accepts an initialized job-owned bridge without enrolling an unproven PID", async () => {
    // Catches turning safe non-enrollment of a fast launcher PID into a connection failure.
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => ({ pid: 6046, stderr: new PassThrough() }),
      createClient: () => ({
        connect: async () => undefined,
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async () => undefined,
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });

    await expect(session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    })).resolves.toBeNull();
    await session.close();
    await expect(session.bridgeIdentity).resolves.toBeNull();
  });

  it("does not report ready before an in-flight exact job observation completes", async () => {
    // Catches graceful close racing ahead of the same-handle creation-time/job-membership check.
    let resolveObserved!: (identity: SupervisorBridgeIdentity) => void;
    const observed = new Promise<SupervisorBridgeIdentity>((resolveIdentity) => {
      resolveObserved = resolveIdentity;
    });
    const session = createProductionSupervisorOwnedSession({
      ...identity,
      jobName: `Local\\IntentArcPortability-${"2".repeat(64)}`,
    }, {
      createTransport: () => ({ pid: 6047, stderr: new PassThrough() }),
      createClient: () => ({
        connect: async () => undefined,
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async () => observed,
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });
    let ready = false;
    const connecting = session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    }).then((result) => {
      ready = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    resolveObserved({ pid: 6047, startTime: "638914932000000006" });
    await expect(connecting).resolves.toEqual({
      pid: 6047,
      startTime: "638914932000000006",
    });
    await session.close();
  });

  it("does not settle identity to null while a bounded observation is in flight", async () => {
    // Catches EOF cleanup discarding PID plus creation time already being observed.
    let resolveObserved!: (identity: SupervisorBridgeIdentity) => void;
    const observed = new Promise<SupervisorBridgeIdentity>((resolveIdentity) => {
      resolveObserved = resolveIdentity;
    });
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => ({ pid: 6045, stderr: new PassThrough() }),
      createClient: () => ({
        connect: async () => new Promise<void>(() => undefined),
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async () => observed,
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });
    void session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    });
    const closing = session.close();
    resolveObserved({ pid: 6045, startTime: "638914932000000005" });

    await closing;
    await expect(session.bridgeIdentity).resolves.toEqual({
      pid: 6045,
      startTime: "638914932000000005",
    });
  });

  it("publishes null exactly once when connection fails before a process identity exists", async () => {
    // Catches leaving the identity observation channel pending after identity becomes impossible.
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => ({ pid: null, stderr: new PassThrough() }),
      createClient: () => ({
        connect: async () => Promise.reject(new Error("no-process")),
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async () => undefined,
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });
    const connecting = session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    }).catch(() => undefined);

    await expect(session.bridgeIdentity).resolves.toBeNull();
    await connecting;
    await expect(session.bridgeIdentity).resolves.toBeNull();
  });

  it("caps diagnostics on a real connection failure without failing close for stderr alone", async () => {
    // Catches retaining unbounded child stderr, exposing it, or making its mere presence fatal.
    const secret = "bridge-stderr-secret";
    const stderr = new PassThrough();
    const transport = { pid: 7716 as number | null, stderr };
    const session = createProductionSupervisorOwnedSession(identity, {
      createTransport: () => transport,
      createClient: () => ({
        connect: async () => {
          stderr.write(Buffer.from(secret.repeat(10_000)));
          throw new Error("sdk-connect-failed");
        },
        callTool: async () => ({}),
        close: async () => undefined,
      }),
      observeBridgeIdentity: async (pid) => ({ pid, startTime: "638914932000000002" }),
      delay: async () => undefined,
      now: () => 1_787_371_200_123,
    });

    const failure = await session.connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      settingsRoot: "C:\\Users\\fixture\\AppData\\Roaming\\IntentArc",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ diagnosticsBytes: 64 * 1024 });
    expect(JSON.stringify(failure)).not.toContain(secret);
    await expect(session.close()).resolves.toBeUndefined();
  });
});

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runChild = (
  command: string,
  args: readonly string[],
  stdin = "",
): Promise<ChildResult> => new Promise((resolveChild, reject) => {
  const child = spawn(command, [...args], {
    cwd: resolve("."),
    env: { ...process.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.once("error", reject);
  child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  child.stdin.end(stdin);
});

describe("supervisor deterministic test-support bundle", () => {
  it("produces byte-identical bundles in two separate temporary roots", async () => {
    // Catches timestamps, source paths, sourcemaps, or other nondeterministic build content.
    const root = await mkdtemp(join(tmpdir(), "intentarc-supervisor-build-"));
    try {
      const first = join(root, "first", "supervisor.mjs");
      const second = join(root, "second", "supervisor.mjs");
      await buildClientPortabilitySupervisor({ outputFile: first });
      await buildClientPortabilitySupervisor({ outputFile: second });
      const [firstBytes, secondBytes] = await Promise.all([
        readFile(first),
        readFile(second),
      ]);

      expect(firstBytes.byteLength).toBeGreaterThan(0);
      expect(secondBytes.byteLength).toBe(firstBytes.byteLength);
      expect(createHash("sha256").update(secondBytes).digest("hex")).toBe(
        createHash("sha256").update(firstBytes).digest("hex"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps both source and bundle imports dormant", async () => {
    // Catches import-time supervisor startup, client creation, bridge spawn, or stream writes.
    const root = await mkdtemp(join(tmpdir(), "intentarc-supervisor-dormancy-"));
    try {
      const bundle = join(root, "supervisor.mjs");
      await buildClientPortabilitySupervisor({ outputFile: bundle });
      const sourceUrl = pathToFileURL(resolve(
        "src/desktop/e2e/client-portability-session-supervisor.ts",
      )).href;
      const bundleUrl = pathToFileURL(bundle).href;
      const [sourceImport, bundleImport] = await Promise.all([
        runChild(process.execPath, ["--import", "tsx", "--eval", `import(${JSON.stringify(sourceUrl)})`]),
        runChild(process.execPath, ["--eval", `import(${JSON.stringify(bundleUrl)})`]),
      ]);

      expect(sourceImport).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(bundleImport).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects direct bundle execution outside the validated Job Object host", async () => {
    // Catches bypassing the launch-time ownership boundary with a direct Node invocation.
    const root = await mkdtemp(join(tmpdir(), "intentarc-supervisor-direct-"));
    try {
      const bundle = join(root, "supervisor.mjs");
      await buildClientPortabilitySupervisor({ outputFile: bundle });
      const results = await Promise.all([
        runChild(process.execPath, [bundle], "not-json\n"),
        runChild(process.execPath, [bundle], ""),
      ]);

      for (const result of results) {
        expect(result).toEqual({
          code: 1,
          stdout: "",
          stderr: '{"status":"failed","category":"supervisor_startup"}\n',
        });
        expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints one closed metrics object in direct build-script mode", async () => {
    // Catches raw esbuild logs or accidental fields entering deterministic build output.
    const root = await mkdtemp(join(tmpdir(), "intentarc-supervisor-cli-"));
    try {
      const output = join(root, "supervisor.mjs");
      const result = await runChild(process.execPath, [
        resolve("scripts/build-client-portability-supervisor.mjs"),
        output,
      ]);
      const lines = result.stdout.trimEnd().split("\n");
      const metrics = JSON.parse(lines[0]!) as object;

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(lines).toHaveLength(1);
      expect(Object.keys(metrics)).toEqual(["status", "output", "bytes"]);
      expect(metrics).toEqual({
        status: "closed",
        output,
        bytes: (await readFile(output)).byteLength,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports build failure without raw esbuild output", async () => {
    // Catches stack traces or esbuild diagnostics escaping direct build-script mode.
    const root = await mkdtemp(join(tmpdir(), "intentarc-supervisor-cli-failure-"));
    try {
      const result = await runChild(process.execPath, [
        resolve("scripts/build-client-portability-supervisor.mjs"),
        root,
      ]);
      const lines = result.stdout.trimEnd().split("\n");
      const metrics = JSON.parse(lines[0]!) as object;

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(lines).toHaveLength(1);
      expect(Object.keys(metrics)).toEqual(["status", "output", "bytes"]);
      expect(metrics).toEqual({ status: "failed", output: root, bytes: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
