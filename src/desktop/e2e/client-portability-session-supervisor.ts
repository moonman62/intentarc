import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  applySupervisorProtocolFrame,
  createSupervisorFrameDecoder,
  encodeSupervisorFrame,
  type SupervisorFrame,
  type SupervisorProtocolState,
  type SupervisorRequestFrame,
  type SupervisorTerminalFrame,
} from "./client-portability-supervisor-protocol.js";
import {
  observeWindowsJobMemberIdentity,
  validateProductionBridgeSessionPaths,
} from "./client-portability-windows-job.js";

export interface SupervisorConnectPayload {
  readonly bridgeExecutable: string;
  readonly connectionId: string;
  readonly settingsRoot: string;
}

export interface SupervisorCallToolPayload {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface SupervisorBridgeIdentity {
  readonly pid: number;
  readonly startTime: string;
}

export interface SupervisorSessionIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly jobName?: string;
}

export interface SupervisorOwnedSession {
  readonly bridgeIdentity: Promise<SupervisorBridgeIdentity | null>;
  connect(input: SupervisorConnectPayload): Promise<SupervisorBridgeIdentity | null>;
  callTool(input: SupervisorCallToolPayload): Promise<object>;
  close(): Promise<void>;
}

export interface SupervisorRuntimeDependencies {
  createSession(identity: SupervisorSessionIdentity): SupervisorOwnedSession;
  now(): number;
  exit(code: number): never;
}

export interface SupervisorProductionTransport {
  pid: number | null;
  readonly stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
}

export interface SupervisorProductionClient {
  connect(transport: SupervisorProductionTransport): Promise<void>;
  callTool(input: SupervisorCallToolPayload): Promise<object>;
  close(): Promise<void>;
}

export interface SupervisorProductionSessionDependencies {
  createTransport(input: {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
    readonly stderr: "pipe";
  }): SupervisorProductionTransport;
  createClient(input: { readonly name: string; readonly version: string }): SupervisorProductionClient;
  observeBridgeIdentity(
    pid: number,
    jobName: string | undefined,
  ): Promise<SupervisorBridgeIdentity | undefined>;
  validateLaunchPaths?(input: {
    readonly bridgeExecutable: string;
    readonly settingsRoot: string;
  }): void;
  delay(milliseconds: number): Promise<void>;
  now(): number;
}

type SupervisorFailureCategory = Extract<
  SupervisorTerminalFrame["payload"],
  { status: "failed" }
>["category"];
type SupervisorOutboundFrame = Exclude<SupervisorFrame, SupervisorRequestFrame>;
type WithoutCorrelation<T> = T extends SupervisorFrame
  ? Omit<T, "version" | "runId" | "sessionId" | "nonce">
  : never;

const connectPayloadSchema = z.strictObject({
  bridgeExecutable: z.string().min(1),
  connectionId: z.string().min(1),
  settingsRoot: z.string().min(1),
});
const callToolPayloadSchema = z.strictObject({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
const emptyPayloadSchema = z.strictObject({});
const SUPERVISOR_DIAGNOSTIC_CAP_BYTES = 64 * 1024;
const BRIDGE_IDENTITY_POLL_ATTEMPTS = 200;
const BRIDGE_IDENTITY_POLL_DELAY_MS = 10;

const initialState = (): SupervisorProtocolState => ({
  phase: "starting",
  pendingRequestIds: new Set(),
  seenRequestIds: new Set(),
  terminalSeen: false,
});

const validBridgeIdentity = (value: unknown): value is SupervisorBridgeIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SupervisorBridgeIdentity>;
  return Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0
    && typeof candidate.startTime === "string" && candidate.startTime.length > 0;
};

const bridgeIdentityFromFailure = (error: unknown): SupervisorBridgeIdentity | undefined => {
  try {
    if (typeof error !== "object" || error === null || !("bridgeIdentity" in error)) {
      return undefined;
    }
    const identity = (error as { bridgeIdentity?: unknown }).bridgeIdentity;
    return validBridgeIdentity(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
};

const writeBytes = async (
  output: NodeJS.WritableStream,
  bytes: Uint8Array,
): Promise<void> => {
  if (output.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
};

const stableDiagnostic = (category: SupervisorFailureCategory): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify({ status: "failed", category })}\n`);

const parseOperationPayload = (
  request: SupervisorRequestFrame,
): SupervisorConnectPayload | SupervisorCallToolPayload | Record<string, never> => {
  if (request.operation === "connect") {
    return connectPayloadSchema.parse(request.payload);
  }
  if (request.operation === "callTool") {
    return callToolPayloadSchema.parse(request.payload);
  }
  return emptyPayloadSchema.parse(request.payload) as Record<string, never>;
};

const productionSessionDependencies: SupervisorProductionSessionDependencies = {
  createTransport: (transportInput) => new StdioClientTransport(transportInput),
  createClient: (clientInput) => {
    const client = new Client(clientInput);
    return {
      connect: (transport) => client.connect(transport as StdioClientTransport),
      callTool: async (toolInput) => client.callTool(toolInput),
      close: () => client.close(),
    };
  },
  observeBridgeIdentity: (pid, jobName) => observeWindowsJobMemberIdentity(
    pid,
    jobName ?? "",
    Date.now() + 2_000,
  ),
  validateLaunchPaths: validateProductionBridgeSessionPaths,
  delay: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
  now: Date.now,
};

const boundedSessionFailure = (
  bridgeIdentity: SupervisorBridgeIdentity | undefined,
  diagnosticsBytes: number,
) => Object.freeze({
  ...(bridgeIdentity === undefined ? {} : { bridgeIdentity }),
  diagnosticsBytes,
});

export const createProductionSupervisorOwnedSession = (
  identity: SupervisorSessionIdentity,
  dependencies: SupervisorProductionSessionDependencies = productionSessionDependencies,
): SupervisorOwnedSession => {
  const clientKind = identity.sessionId.startsWith("codex-")
    ? "codex"
    : identity.sessionId.startsWith("claude-")
      ? "claude"
      : undefined;
  if (clientKind === undefined) throw new Error();
  const client = dependencies.createClient({
    name: `IntentArc installed ${clientKind} portability supervisor`,
    version: "1.0.0",
  });
  let transport: SupervisorProductionTransport | undefined;
  let bridgeIdentity: SupervisorBridgeIdentity | undefined;
  let diagnosticsBytes = 0;
  let closePromise: Promise<void> | undefined;
  let connectStarted = false;
  let identityPollingStopped = false;
  let activeIdentityObservation: Promise<SupervisorBridgeIdentity | undefined> | undefined;
  let identitySettled = false;
  let settleIdentity!: (value: SupervisorBridgeIdentity | null) => void;
  const identityPromise = new Promise<SupervisorBridgeIdentity | null>((resolveIdentity) => {
    settleIdentity = (value) => {
      if (identitySettled) return;
      identitySettled = true;
      resolveIdentity(value);
    };
  });

  const captureDiagnostics = (chunk: unknown): void => {
    if (diagnosticsBytes >= SUPERVISOR_DIAGNOSTIC_CAP_BYTES) return;
    const size = typeof chunk === "string"
      ? Buffer.byteLength(chunk)
      : chunk instanceof Uint8Array
        ? chunk.byteLength
        : 0;
    diagnosticsBytes += Math.min(
      size,
      SUPERVISOR_DIAGNOSTIC_CAP_BYTES - diagnosticsBytes,
    );
  };
  const pollBridgeIdentity = async (): Promise<SupervisorBridgeIdentity | undefined> => {
    for (let attempt = 0; attempt < BRIDGE_IDENTITY_POLL_ATTEMPTS; attempt += 1) {
      if (identityPollingStopped) return undefined;
      const pid = transport?.pid;
      if (pid !== null && pid !== undefined) {
        const observed = await dependencies.observeBridgeIdentity(
          pid,
          identity.jobName,
        ).catch(() => undefined);
        if (observed && observed.pid === pid && /^\d+$/.test(observed.startTime)) {
          bridgeIdentity = observed;
          settleIdentity(observed);
          return observed;
        }
      }
      await dependencies.delay(BRIDGE_IDENTITY_POLL_DELAY_MS);
    }
    return undefined;
  };

  return {
    bridgeIdentity: identityPromise,
    connect: async (connectInput) => {
      if (connectStarted) {
        throw boundedSessionFailure(bridgeIdentity, diagnosticsBytes);
      }
      connectStarted = true;
      if (
        !isAbsolute(connectInput.bridgeExecutable)
        || !isAbsolute(connectInput.settingsRoot)
      ) {
        settleIdentity(null);
        throw boundedSessionFailure(undefined, diagnosticsBytes);
      }
      try {
        dependencies.validateLaunchPaths?.(connectInput);
      } catch {
        settleIdentity(null);
        throw boundedSessionFailure(undefined, diagnosticsBytes);
      }
      const bridgeEnvironment: Record<string, string> = {
        APPDATA: dirname(connectInput.settingsRoot),
      };
      for (const name of dependencies.validateLaunchPaths === undefined ? [] : [
        "ComSpec",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMFILES",
        "SYSTEMDRIVE",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
      ] as const) {
        const value = process.env[name];
        if (value !== undefined) bridgeEnvironment[name] = value;
      }
      try {
        transport = dependencies.createTransport({
          command: connectInput.bridgeExecutable,
          args: ["--connection", connectInput.connectionId],
          env: bridgeEnvironment,
          stderr: "pipe",
        });
      } catch {
        settleIdentity(null);
        throw boundedSessionFailure(undefined, diagnosticsBytes);
      }
      transport.stderr?.on("data", captureDiagnostics);
      const connecting = Promise.resolve().then(() => client.connect(transport!));
      const observingIdentity = pollBridgeIdentity();
      activeIdentityObservation = observingIdentity;
      try {
        await connecting;
        bridgeIdentity ??= await observingIdentity;
        settleIdentity(bridgeIdentity ?? null);
        return bridgeIdentity ?? null;
      } catch {
        bridgeIdentity ??= await observingIdentity;
        settleIdentity(bridgeIdentity ?? null);
        throw boundedSessionFailure(bridgeIdentity, diagnosticsBytes);
      }
    },
    callTool: (toolInput) => client.callTool(toolInput),
    close: () => {
      closePromise ??= Promise.resolve().then(async () => {
        identityPollingStopped = true;
        let closeFailed = false;
        try {
          await client.close();
        } catch {
          closeFailed = true;
        }
        const observed = await activeIdentityObservation?.catch(() => undefined);
        bridgeIdentity ??= observed;
        settleIdentity(bridgeIdentity ?? null);
        if (closeFailed) {
          throw boundedSessionFailure(bridgeIdentity, diagnosticsBytes);
        }
      });
      return closePromise;
    },
  };
};

export const runClientPortabilitySessionSupervisor = async (input: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dependencies: SupervisorRuntimeDependencies;
}): Promise<void> => {
  const decoder = createSupervisorFrameDecoder();
  let state = initialState();
  let terminal = false;
  let session: SupervisorOwnedSession | undefined;
  let closePromise: Promise<void> | undefined;
  let outputQueue = Promise.resolve();
  let identityOutput = Promise.resolve();
  let identityValueObserved = false;
  let unboundEof = false;
  let eofReached = false;
  let resolveEof!: () => void;
  const eof = new Promise<void>((resolve) => {
    resolveEof = resolve;
  });
  const markEof = () => {
    if (eofReached) return;
    eofReached = true;
    resolveEof();
  };
  input.stdin.once("end", markEof);
  input.stdin.once("close", markEof);

  const requireSession = (): SupervisorOwnedSession => {
    if (session === undefined) throw new Error();
    return session;
  };
  const closeSession = (): Promise<void> => {
    closePromise ??= session === undefined
      ? Promise.resolve()
      : Promise.resolve().then(() => session!.close());
    return closePromise;
  };
  const emit = async (frame: SupervisorFrame): Promise<void> => {
    const encoded = encodeSupervisorFrame(frame);
    state = applySupervisorProtocolFrame(state, frame);
    outputQueue = outputQueue.then(() => writeBytes(input.stdout, encoded));
    await outputQueue;
  };
  const correlated = (
    request: SupervisorRequestFrame,
    frame: WithoutCorrelation<SupervisorOutboundFrame>,
  ): SupervisorOutboundFrame => ({
    version: 1,
    runId: request.runId,
    sessionId: request.sessionId,
    nonce: request.nonce,
    ...frame,
  } as SupervisorOutboundFrame);
  const failRequest = async (
    request: SupervisorRequestFrame,
    category: SupervisorFailureCategory,
    error?: unknown,
  ): Promise<void> => {
    let closeFailure: unknown;
    try {
      await closeSession();
    } catch (closeError) {
      closeFailure = closeError;
    }
    await Promise.resolve();
    if (identityValueObserved) await identityOutput;
    const identity = bridgeIdentityFromFailure(error)
      ?? bridgeIdentityFromFailure(closeFailure);
    if (identity && !state.bridgeIdentitySeen) {
      await emit(correlated(request, {
        kind: "bridge_identity",
        payload: identity,
      }));
    }
    await emit(correlated(request, {
      kind: "response",
      requestId: request.requestId,
      payload: { status: "failed", category },
    }));
    await emit(correlated(request, {
      kind: "terminal",
      payload: { status: "failed", category },
    }));
    terminal = true;
  };

  const handleRequest = async (request: SupervisorRequestFrame): Promise<void> => {
    if (terminal) return;
    try {
      state = applySupervisorProtocolFrame(state, request);
    } catch {
      if (state.runId === undefined || state.pendingRequestIds.size !== 0) throw new Error();
      await closeSession().catch(() => undefined);
      await emit(correlated(request, {
        kind: "terminal",
        payload: { status: "failed", category: "supervisor_protocol" },
      }));
      terminal = true;
      return;
    }

    let payload: ReturnType<typeof parseOperationPayload>;
    try {
      payload = parseOperationPayload(request);
    } catch (error) {
      await failRequest(request, "supervisor_protocol", error);
      return;
    }

    if (session === undefined) {
      if (request.operation !== "connect") throw new Error();
      try {
        session = input.dependencies.createSession({
          runId: request.runId,
          sessionId: request.sessionId,
          nonce: request.nonce,
        });
      } catch (error) {
        await failRequest(request, "supervisor_startup", error);
        return;
      }
    }

    if (request.operation === "connect") {
      let identityEmission = Promise.resolve();
      try {
        identityValueObserved = false;
        identityEmission = requireSession().bridgeIdentity.then(async (identity) => {
          identityValueObserved = true;
          if (identity && !terminal && !state.bridgeIdentitySeen) {
            await emit(correlated(request, {
              kind: "bridge_identity",
              payload: identity,
            }));
          }
        }).catch(() => undefined);
        identityOutput = identityEmission;
        const connection = Promise.resolve().then(() =>
          requireSession().connect(payload as SupervisorConnectPayload)
        );
        const outcome = await Promise.race([
          connection.then((identity) => ({ kind: "connected" as const, identity })),
          eof.then(() => ({ kind: "eof" as const })),
        ]);
        if (outcome.kind === "eof") {
          await failRequest(request, "supervisor_startup");
          return;
        }
        if (outcome.identity !== null && !validBridgeIdentity(outcome.identity)) throw new Error();
        await emit(correlated(request, {
          kind: "response",
          requestId: request.requestId,
          payload: { status: "ready" },
        }));
      } catch (error) {
        await failRequest(request, "supervisor_startup", error);
      }
      return;
    }

    if (request.operation === "callTool") {
      try {
        const result = await requireSession().callTool(payload as SupervisorCallToolPayload);
        await emit(correlated(request, {
          kind: "response",
          requestId: request.requestId,
          payload: result,
        }));
      } catch (error) {
        await failRequest(request, "journey", error);
      }
      return;
    }

    if (request.operation === "status") {
      await emit(correlated(request, {
        kind: "response",
        requestId: request.requestId,
        payload: { status: "ready" },
      }));
      return;
    }

    try {
      await closeSession();
      await emit(correlated(request, {
        kind: "response",
        requestId: request.requestId,
        payload: { status: "closed" },
      }));
      await emit(correlated(request, {
        kind: "terminal",
        payload: { status: "closed" },
      }));
      terminal = true;
    } catch (error) {
      await failRequest(request, "graceful_close", error);
    }
  };

  try {
    for await (const chunk of input.stdin) {
      for (const frame of decoder.push(chunk as Uint8Array)) {
        if (frame.kind !== "request") throw new Error();
        await handleRequest(frame);
        if (terminal) return;
      }
    }
    decoder.end();
    markEof();
    if (!terminal && state.runId === undefined) {
      unboundEof = true;
    } else if (!terminal && state.pendingRequestIds.size === 0) {
      await closeSession().catch(() => undefined);
      const requestIdentity = {
        version: 1 as const,
        runId: state.runId!,
        sessionId: state.sessionId!,
        nonce: state.nonce!,
        kind: "terminal" as const,
        payload: { status: "failed" as const, category: "supervisor_protocol" as const },
      };
      await emit(requestIdentity);
      terminal = true;
    }
  } catch {
    await closeSession().catch(() => undefined);
    if (!terminal && state.runId !== undefined && state.pendingRequestIds.size === 0) {
      await emit({
        version: 1,
        kind: "terminal",
        runId: state.runId,
        sessionId: state.sessionId!,
        nonce: state.nonce!,
        payload: { status: "failed", category: "supervisor_protocol" },
      });
      return;
    }
    await writeBytes(input.stderr, stableDiagnostic("supervisor_protocol"));
    input.dependencies.exit(1);
  } finally {
    input.stdin.removeListener("end", markEof);
    input.stdin.removeListener("close", markEof);
  }
  if (unboundEof) {
    await writeBytes(input.stderr, stableDiagnostic("supervisor_protocol"));
    input.dependencies.exit(1);
  }
};

const productionRuntimeDependencies = (jobName: string): SupervisorRuntimeDependencies => ({
  createSession: (identity) => createProductionSupervisorOwnedSession({ ...identity, jobName }),
  now: Date.now,
  exit: (code) => process.exit(code),
});

const isDirect = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirect) {
  const jobName = process.argv.length === 5
    && process.argv[2] === "--supervisor"
    && process.argv[3] === "--job-name"
    ? process.argv[4]
    : undefined;
  if (jobName === undefined) {
    await writeBytes(process.stderr, stableDiagnostic("supervisor_startup"));
    process.exitCode = 1;
  } else {
    await runClientPortabilitySessionSupervisor({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      dependencies: productionRuntimeDependencies(jobName),
    }).catch(async () => {
      await writeBytes(process.stderr, stableDiagnostic("supervisor_startup"));
      process.exitCode = 1;
    });
  }
}
