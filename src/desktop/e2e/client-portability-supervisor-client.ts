import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES,
  applySupervisorProtocolFrame,
  createSupervisorFrameDecoder,
  encodeSupervisorFrame,
  type SupervisorFrame,
  type SupervisorProtocolState,
  type SupervisorRequestFrame,
  type SupervisorResponseFrame,
} from "./client-portability-supervisor-protocol.js";
import type { SupervisorConnectPayload } from "./client-portability-session-supervisor.js";
import {
  createWindowsSupervisorJobHostLaunch,
  parseWindowsSupervisorJobBootstrap,
  validateProductionSupervisorLaunchAuthority,
  type ProductionSupervisorLaunchAuthority,
} from "./client-portability-windows-job.js";

export interface SupervisorProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

export interface SupervisorSettlementResult {
  readonly status: "settled" | "blocked" | "unsupported";
  readonly category:
    | "none"
    | "identity"
    | "observation"
    | "termination"
    | "child_handle"
    | "platform";
  readonly retained: readonly SupervisorProcessIdentity[];
}

export interface SupervisorSettlementInput {
  readonly child: Readonly<{ readonly pid?: number }>;
  readonly roots: readonly SupervisorProcessIdentity[];
  readonly retainedIdentities: readonly SupervisorProcessIdentity[];
  readonly finalRetainedIdentities: Promise<readonly SupervisorProcessIdentity[]>;
  readonly rootIdentity: Promise<SupervisorProcessIdentity>;
  readonly childExitAndClose: Promise<void>;
  readonly deadline: number;
  readonly pendingRequestCount: number;
  readonly jobObjectOwned: boolean;
}

export interface SupervisorSettlementBackend {
  settle(input: SupervisorSettlementInput): Promise<SupervisorSettlementResult>;
}

export interface SupervisorIdentityObserver {
  (pid: number, deadline: number): Promise<SupervisorProcessIdentity | undefined>;
}

export interface SupervisorClientDependencies {
  readonly settlementBackend: SupervisorSettlementBackend;
  readonly observeSupervisorIdentity: SupervisorIdentityObserver;
}

export interface CreateSupervisorSessionInput {
  readonly repositoryRoot: string;
  readonly supervisorBundle: string;
  readonly clientKind: "codex" | "claude";
  readonly forceSettlementTimeoutMs: number;
  readonly dependencies: SupervisorClientDependencies;
  readonly windowsJobObject?: boolean;
  readonly launchAuthority?: Omit<
    ProductionSupervisorLaunchAuthority,
    "nodeExecutable" | "repositoryRoot" | "supervisorBundle"
  >;
}

export interface ClientPortabilitySupervisorSession {
  readonly identity: Promise<SupervisorProcessIdentity>;
  connect(input: SupervisorConnectPayload, deadline: number): Promise<void>;
  callTool<Result extends object>(
    name: string,
    arguments_: Record<string, unknown>,
    deadline: number,
  ): Promise<Result>;
  close(deadline: number): Promise<void>;
  settle(deadline: number): Promise<SupervisorSettlementResult>;
}

interface PendingRequest {
  readonly operation: "connect" | "callTool" | "close";
  readonly deadline: number;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  closeResponseReceived: boolean;
}

const STOPPED_MESSAGE = "Client portability supervisor stopped.";
const INVALID_LAUNCH_MESSAGE = "Client portability supervisor launch is invalid.";
const STDERR_CAP_BYTES = 64 * 1024;
const STDOUT_CAP_BYTES = CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES * 4;
const MAX_RETAINED_IDENTITIES = 256;
const nativePromiseThen = Promise.prototype.then;
const nativeReflectApply = Reflect.apply;
const helperLifecycleOwners = new WeakSet<object>();

export const registerSupervisorHelperLifecycleOwner = <Owner extends object>(
  owner: Owner,
): Owner => {
  helperLifecycleOwners.add(owner);
  return owner;
};

const stoppedError = (): Error => new Error(STOPPED_MESSAGE);

const frozenPromiseObservation = <Value>(
  trustedPromise: Promise<Value>,
): Promise<Value> => Object.freeze(nativeReflectApply(
  nativePromiseThen,
  trustedPromise,
  [(value: Value) => value],
) as Promise<Value>);

const initialProtocolState = (): SupervisorProtocolState => ({
  phase: "starting",
  pendingRequestIds: new Set(),
  seenRequestIds: new Set(),
  terminalSeen: false,
});

const isExactIdentity = (
  value: SupervisorProcessIdentity | undefined,
  expectedPid?: number,
): value is SupervisorProcessIdentity => value !== undefined
  && Number.isInteger(value.pid)
  && value.pid > 0
  && (expectedPid === undefined || value.pid === expectedPid)
  && /^\d+$/.test(value.startTime);

const snapshotExactIdentity = (value: unknown): SupervisorProcessIdentity | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const pid = record.pid;
    const startTime = record.startTime;
    if (
      !Number.isSafeInteger(pid)
      || (pid as number) <= 0
      || typeof startTime !== "string"
      || !/^\d+$/.test(startTime)
    ) return undefined;
    return Object.freeze({ pid: pid as number, startTime });
  } catch {
    return undefined;
  }
};

const requireOrdinaryAbsoluteFile = (path: string): void => {
  try {
    if (
      !isAbsolute(path)
      || resolve(path) !== path
      || realpathSync.native(path) !== path
    ) throw new Error();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch {
    throw new Error(INVALID_LAUNCH_MESSAGE);
  }
};

const minimalSupervisorEnvironment = (): NodeJS.ProcessEnv => ({});

const exactStatusPayload = (payload: unknown, status: string): boolean => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.status === status;
};

const failedPayload = (payload: unknown): boolean => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.status === "failed"
    && typeof record.category === "string"
    && Object.keys(record).length === 2;
};

const blockedSettlement = (
  category: "identity" | "observation" | "child_handle",
  retained: readonly SupervisorProcessIdentity[],
): SupervisorSettlementResult => Object.freeze({
  status: "blocked" as const,
  category,
  retained: Object.freeze(retained.map((identity) => Object.freeze({ ...identity }))),
});

const validatedSettlementResult = (
  value: unknown,
  requiredIdentities: readonly SupervisorProcessIdentity[],
): SupervisorSettlementResult | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    const status = record.status;
    const category = record.category;
    const retainedValue = record.retained;
    const retainedLength = Array.isArray(retainedValue) ? retainedValue.length : -1;
    if (
      keys !== "category,retained,status"
      || !Array.isArray(retainedValue)
      || retainedLength > MAX_RETAINED_IDENTITIES + 1
    ) return undefined;
    const validCategory = category === "none"
      || category === "identity"
      || category === "observation"
      || category === "termination"
      || category === "child_handle"
      || category === "platform";
    if (
      (status !== "settled" && status !== "blocked" && status !== "unsupported")
      || !validCategory
      || (status === "settled" && category !== "none")
      || (status === "blocked" && category === "none")
      || (status === "unsupported" && category !== "platform")
    ) return undefined;
    const retained: SupervisorProcessIdentity[] = [];
    for (let index = 0; index < retainedLength; index += 1) {
      const exactIdentity = snapshotExactIdentity(retainedValue[index]);
      if (exactIdentity === undefined) return undefined;
      if (retained.some((existing) => existing.pid === exactIdentity.pid)) return undefined;
      retained.push(exactIdentity);
    }
    if (requiredIdentities.some((required) => !retained.some((candidate) =>
      candidate.pid === required.pid && candidate.startTime === required.startTime
    ))) return undefined;
    return Object.freeze({
      status,
      category,
      retained: Object.freeze(retained),
    }) as SupervisorSettlementResult;
  } catch {
    return undefined;
  }
};

type DeadlineOutcome<Value> =
  | { readonly kind: "resolved"; readonly value: Value }
  | { readonly kind: "rejected" }
  | { readonly kind: "deadline" };

const waitUntilDeadline = <Value>(
  promise: Promise<Value>,
  deadline: number,
): Promise<DeadlineOutcome<Value>> => new Promise((resolveOutcome) => {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (outcome: DeadlineOutcome<Value>): void => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveOutcome(outcome);
  };
  const armDeadline = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finish({ kind: "deadline" });
      return;
    }
    timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  nativeReflectApply(nativePromiseThen, promise, [
    (value) => finish({ kind: "resolved", value }),
    () => finish({ kind: "rejected" }),
  ]);
  armDeadline();
});

const waitForOwnedLifecycle = <Value>(
  promise: Promise<Value>,
): Promise<Exclude<DeadlineOutcome<Value>, { readonly kind: "deadline" }>> => new Promise((
  resolveOutcome,
) => {
  nativeReflectApply(nativePromiseThen, promise, [
    (value: Value) => resolveOutcome({ kind: "resolved", value }),
    () => resolveOutcome({ kind: "rejected" }),
  ]);
});

const ownsHelperLifecycle = (value: unknown): boolean => {
  if (!((typeof value === "object" && value !== null) || typeof value === "function")) return false;
  try { return helperLifecycleOwners.has(value as object); }
  catch { return false; }
};

const frozenIdentities = (
  identities: readonly SupervisorProcessIdentity[],
): readonly SupervisorProcessIdentity[] => Object.freeze(
  identities.map((identity) => Object.freeze({ ...identity })),
);

export const createClientPortabilitySupervisorSession = (
  input: CreateSupervisorSessionInput,
): ClientPortabilitySupervisorSession => {
  const nodeExecutable = process.execPath;
  if (
    typeof input?.dependencies?.observeSupervisorIdentity !== "function"
    || typeof input?.dependencies?.settlementBackend?.settle !== "function"
    || !isAbsolute(input.repositoryRoot)
    || resolve(input.repositoryRoot) !== input.repositoryRoot
    || (input.clientKind !== "codex" && input.clientKind !== "claude")
    || !Number.isSafeInteger(input.forceSettlementTimeoutMs)
    || input.forceSettlementTimeoutMs <= 0
  ) throw new Error(INVALID_LAUNCH_MESSAGE);
  requireOrdinaryAbsoluteFile(nodeExecutable);
  requireOrdinaryAbsoluteFile(input.supervisorBundle);
  const runId = randomUUID();
  const sessionId = `${input.clientKind}-${randomUUID()}`;
  const nonce = randomBytes(32).toString("hex");
  const productionAuthority = input.windowsJobObject === true
    ? validateProductionSupervisorLaunchAuthority({
      nodeExecutable,
      repositoryRoot: input.repositoryRoot,
      supervisorBundle: input.supervisorBundle,
      ...(input.launchAuthority ?? (() => { throw new Error(INVALID_LAUNCH_MESSAGE); })()),
    })
    : undefined;
  const jobLaunch = input.windowsJobObject === true
    ? createWindowsSupervisorJobHostLaunch({
      nodeExecutable,
      supervisorBundle: input.supervisorBundle,
      repositoryRoot: input.repositoryRoot,
      settingsRoot: productionAuthority!.settingsRoot,
      acceptanceRoot: productionAuthority!.acceptanceRoot,
      runId,
      sessionId,
      nonce,
    })
    : undefined;
  const child = jobLaunch === undefined
    ? spawn(nodeExecutable, [input.supervisorBundle, "--supervisor"], {
      cwd: input.repositoryRoot,
      env: minimalSupervisorEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    : spawn(jobLaunch.executable, [...jobLaunch.arguments], {
      ...jobLaunch.options,
      stdio: [...jobLaunch.options.stdio],
      env: { ...jobLaunch.options.env },
    });
  const spawnedPid = child.pid;
  const backendChild: SupervisorSettlementInput["child"] = Object.freeze(
    spawnedPid === undefined ? {} : { pid: spawnedPid },
  );
  const pendingRequests = new Map<string, PendingRequest>();
  const retainedIdentities: SupervisorProcessIdentity[] = [];
  let supervisorIdentity: SupervisorProcessIdentity | undefined;
  const decoder = createSupervisorFrameDecoder();
  let protocolState = initialProtocolState();
  let settlementPromise: Promise<SupervisorSettlementResult> | undefined;
  let stdoutBytes = 0;
  let bootstrapBytes = Buffer.alloc(0);
  let bootstrapPending = jobLaunch !== undefined;
  let stderrBytes = 0;
  let sawExit = false;
  let sawClose = false;
  let resolveExitAndClose!: () => void;
  const childExitAndClose = new Promise<void>((resolveChild) => {
    resolveExitAndClose = resolveChild;
  });
  const backendChildExitAndClose = frozenPromiseObservation(childExitAndClose);
  const finishExitAndClose = (): void => {
    if (sawExit && sawClose) resolveExitAndClose();
  };
  let resolveIdentity!: (identity: SupervisorProcessIdentity) => void;
  let rejectIdentity!: (error: Error) => void;
  let identitySettled = false;
  const identity = new Promise<SupervisorProcessIdentity>((resolveObserved, rejectObserved) => {
    resolveIdentity = resolveObserved;
    rejectIdentity = rejectObserved;
  });
  void identity.catch(() => undefined);
  const rejectObservedIdentity = (): void => {
    if (identitySettled) return;
    identitySettled = true;
    rejectIdentity(stoppedError());
  };
  const terminateAbandonedBootstrapHost = (): boolean => {
    if (!bootstrapPending) return false;
    bootstrapPending = false;
    bootstrapBytes = Buffer.alloc(0);
    rejectObservedIdentity();
    try {
      child.kill();
    } catch {
      // Settlement retains the exact child handle and fails closed if exit+close never arrive.
    }
    return true;
  };
  let resolveFinalRetainedIdentities!: (
    identities: readonly SupervisorProcessIdentity[],
  ) => void;
  let rejectFinalRetainedIdentities!: (error: Error) => void;
  let finalRetainedIdentitiesSettled = false;
  const finalRetainedIdentities = new Promise<readonly SupervisorProcessIdentity[]>((
    resolveFinal,
    rejectFinal,
  ) => {
    resolveFinalRetainedIdentities = resolveFinal;
    rejectFinalRetainedIdentities = rejectFinal;
  });
  void finalRetainedIdentities.catch(() => undefined);
  const backendFinalRetainedIdentities = frozenPromiseObservation(finalRetainedIdentities);
  void backendFinalRetainedIdentities.catch(() => undefined);
  const rejectFinalRetainedObservation = (): void => {
    if (finalRetainedIdentitiesSettled) return;
    finalRetainedIdentitiesSettled = true;
    rejectFinalRetainedIdentities(stoppedError());
  };
  const finishFinalRetainedObservation = (): void => {
    if (finalRetainedIdentitiesSettled) return;
    try {
      decoder.end();
      finalRetainedIdentitiesSettled = true;
      resolveFinalRetainedIdentities(frozenIdentities(retainedIdentities));
    } catch {
      rejectFinalRetainedObservation();
    }
  };

  const retainIdentity = (candidate: SupervisorProcessIdentity): void => {
    if (!isExactIdentity(candidate)) throw stoppedError();
    if (supervisorIdentity?.pid === candidate.pid) throw stoppedError();
    const existing = retainedIdentities.find((identity_) => identity_.pid === candidate.pid);
    if (existing !== undefined) {
      if (existing.startTime !== candidate.startTime) throw stoppedError();
      return;
    }
    if (retainedIdentities.length >= MAX_RETAINED_IDENTITIES) throw stoppedError();
    retainedIdentities.push(Object.freeze({ ...candidate }));
  };
  const rejectAndDeleteEveryPendingRequest = (): void => {
    const failure = stoppedError();
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.reject(failure);
    }
  };
  const beginIpcDrain = (): void => {
    child.stderr.removeListener("data", readStderr);
    try {
      child.stdin.end();
    } catch {
      // The shared drain is already active; a throwing stream cannot escape it.
    }
    for (const stream of [child.stdin, child.stderr]) {
      try {
        stream.destroy();
      } catch {
        // The settlement backend still owns the exact child handle.
      }
    }
  };
  const knownRequiredIdentities = (): readonly SupervisorProcessIdentity[] => frozenIdentities([
    ...(supervisorIdentity === undefined ? [] : [supervisorIdentity]),
    ...retainedIdentities,
  ]);
  const runSettlement = async (
    deadline: number,
    requiredAtTrigger: readonly SupervisorProcessIdentity[],
    backendInput: SupervisorSettlementInput,
    preBootstrapTerminationRequested: boolean,
  ): Promise<SupervisorSettlementResult> => {
    const rootOutcomePromise = ownsHelperLifecycle(input.dependencies.observeSupervisorIdentity)
      ? waitForOwnedLifecycle(identity)
      : waitUntilDeadline(identity, deadline);
    const finalRetainedOutcomePromise = waitUntilDeadline(finalRetainedIdentities, deadline);
    const preBootstrapChildOutcomePromise = preBootstrapTerminationRequested
      ? waitUntilDeadline(childExitAndClose, deadline)
      : undefined;
    const requiredWithRoot = (
      root: SupervisorProcessIdentity,
      finalRetained: readonly SupervisorProcessIdentity[],
    ): readonly SupervisorProcessIdentity[] => frozenIdentities([
      root,
      ...requiredAtTrigger.filter((candidate) => candidate.pid !== root.pid),
      ...finalRetained.filter((candidate) =>
        candidate.pid !== root.pid
        && !requiredAtTrigger.some((requiredIdentity) => requiredIdentity.pid === candidate.pid)
      ),
    ]);
    let backendPromise: Promise<SupervisorSettlementResult>;
    try {
      backendPromise = Promise.resolve(input.dependencies.settlementBackend.settle(backendInput));
    } catch {
      backendPromise = Promise.reject();
    }
    const backendOutcome = ownsHelperLifecycle(input.dependencies.settlementBackend)
      ? await waitForOwnedLifecycle(backendPromise)
      : await waitUntilDeadline(backendPromise, deadline);
    const preBootstrapChildOutcome = await preBootstrapChildOutcomePromise;
    if (
      preBootstrapChildOutcome !== undefined
      && preBootstrapChildOutcome.kind !== "resolved"
    ) {
      return blockedSettlement("child_handle", knownRequiredIdentities());
    }
    if (backendOutcome.kind !== "resolved") {
      await rootOutcomePromise;
      await finalRetainedOutcomePromise;
      return blockedSettlement("observation", knownRequiredIdentities());
    }

    const backendResult = validatedSettlementResult(backendOutcome.value, []);
    if (backendResult === undefined) {
      await rootOutcomePromise;
      await finalRetainedOutcomePromise;
      return blockedSettlement("observation", knownRequiredIdentities());
    }
    if (backendResult.status !== "settled") {
      const rootOutcome = await rootOutcomePromise;
      if (rootOutcome.kind !== "resolved" || !isExactIdentity(rootOutcome.value, spawnedPid)) {
        await finalRetainedOutcomePromise;
        return blockedSettlement("identity", knownRequiredIdentities());
      }
      const finalRetainedOutcome = await finalRetainedOutcomePromise;
      if (finalRetainedOutcome.kind !== "resolved") {
        return blockedSettlement("observation", knownRequiredIdentities());
      }
      const required = requiredWithRoot(rootOutcome.value, finalRetainedOutcome.value);
      return validatedSettlementResult(backendResult, required)
        ?? blockedSettlement("observation", required);
    }

    const rootOutcome = await rootOutcomePromise;
    if (rootOutcome.kind !== "resolved" || !isExactIdentity(rootOutcome.value, spawnedPid)) {
      await finalRetainedOutcomePromise;
      return blockedSettlement("identity", knownRequiredIdentities());
    }
    const exitAndCloseOutcome = await waitUntilDeadline(childExitAndClose, deadline);
    if (exitAndCloseOutcome.kind !== "resolved") {
      const finalRetainedOutcome = await finalRetainedOutcomePromise;
      return blockedSettlement(
        "child_handle",
        requiredWithRoot(
          rootOutcome.value,
          finalRetainedOutcome.kind === "resolved"
            ? finalRetainedOutcome.value
            : retainedIdentities,
        ),
      );
    }
    const finalRetainedOutcome = await finalRetainedOutcomePromise;
    if (finalRetainedOutcome.kind !== "resolved") {
      return blockedSettlement("observation", knownRequiredIdentities());
    }
    const required = requiredWithRoot(rootOutcome.value, finalRetainedOutcome.value);
    return validatedSettlementResult(backendResult, required)
      ?? blockedSettlement("observation", required);
  };
  const startSettlement = (deadline: number): Promise<SupervisorSettlementResult> => {
    if (settlementPromise !== undefined) return settlementPromise;
    let resolveSettlement!: (result: SupervisorSettlementResult) => void;
    let rejectSettlement!: (error: unknown) => void;
    const sharedSettlement = new Promise<SupervisorSettlementResult>((resolveShared, rejectShared) => {
      resolveSettlement = resolveShared;
      rejectSettlement = rejectShared;
    });
    settlementPromise = sharedSettlement;
    const preBootstrapTerminationRequested = terminateAbandonedBootstrapHost();
    rejectAndDeleteEveryPendingRequest();
    const roots = frozenIdentities(supervisorIdentity === undefined ? [] : [supervisorIdentity]);
    const retained = frozenIdentities(retainedIdentities);
    const requiredAtTrigger = frozenIdentities([...roots, ...retained]);
    const backendInput = Object.freeze({
      child: backendChild,
      roots,
      retainedIdentities: retained,
      finalRetainedIdentities: backendFinalRetainedIdentities,
      rootIdentity: identity,
      childExitAndClose: backendChildExitAndClose,
      deadline,
      pendingRequestCount: pendingRequests.size,
      jobObjectOwned: input.windowsJobObject === true,
    });
    const run = Promise.resolve().then(() =>
      runSettlement(
        deadline,
        requiredAtTrigger,
        backendInput,
        preBootstrapTerminationRequested,
      )
    );
    nativeReflectApply(nativePromiseThen, run, [resolveSettlement, rejectSettlement]);
    beginIpcDrain();
    return sharedSettlement;
  };
  const forceSettlement = (): Promise<SupervisorSettlementResult> => startSettlement(
    Date.now() + input.forceSettlementTimeoutMs,
  );
  const failClosed = (): void => {
    void forceSettlement().catch(() => undefined);
  };
  const completePending = (requestId: string, payload: unknown): void => {
    const pending = pendingRequests.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve(payload);
  };
  const handleResponse = (frame: SupervisorResponseFrame): void => {
    const pending = pendingRequests.get(frame.requestId);
    if (pending === undefined) throw stoppedError();
    if (failedPayload(frame.payload)) {
      clearTimeout(pending.timer);
      pendingRequests.delete(frame.requestId);
      pending.reject(stoppedError());
      void forceSettlement().catch(() => undefined);
      return;
    }
    if (pending.operation === "connect") {
      if (!exactStatusPayload(frame.payload, "ready")) throw stoppedError();
      void identity.then(
        () => completePending(frame.requestId, undefined),
        () => undefined,
      );
      return;
    }
    if (pending.operation === "close") {
      if (!exactStatusPayload(frame.payload, "closed")) throw stoppedError();
      pending.closeResponseReceived = true;
      return;
    }
    if (typeof frame.payload !== "object" || frame.payload === null) throw stoppedError();
    completePending(frame.requestId, frame.payload);
  };
  const handleFrame = (frame: SupervisorFrame): void => {
    if (frame.kind === "request") throw stoppedError();
    protocolState = applySupervisorProtocolFrame(protocolState, frame);
    if (settlementPromise !== undefined) {
      if (frame.kind === "bridge_identity") retainIdentity(frame.payload);
      return;
    }
    if (frame.kind === "response") {
      handleResponse(frame);
      return;
    }
    if (frame.kind === "bridge_identity") {
      retainIdentity(frame.payload);
      return;
    }
    if (frame.payload.status === "closed") {
      const closeRequest = [...pendingRequests].find(([, pending]) =>
        pending.operation === "close" && pending.closeResponseReceived
      );
      if (closeRequest === undefined) throw stoppedError();
      const [requestId] = closeRequest;
      completePending(requestId, undefined);
      void forceSettlement().catch(() => undefined);
      return;
    }
    void forceSettlement().catch(() => undefined);
  };
  function readStdout(chunk: Buffer): void {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > STDOUT_CAP_BYTES) {
      rejectFinalRetainedObservation();
      failClosed();
      return;
    }
    try {
      let protocolBytes = chunk;
      if (bootstrapPending) {
        bootstrapBytes = Buffer.concat([bootstrapBytes, chunk]);
        const newline = bootstrapBytes.indexOf(0x0a);
        if (newline < 0) return;
        const rawLine = bootstrapBytes.subarray(0, newline);
        const line = rawLine.at(-1) === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1).toString("utf8")
          : rawLine.toString("utf8");
        const observed = parseWindowsSupervisorJobBootstrap(line, {
          pid: spawnedPid!,
          jobName: jobLaunch!.jobName,
          runId,
          sessionId,
          nonce,
        });
        if (!isExactIdentity(observed, spawnedPid)) throw stoppedError();
        supervisorIdentity = Object.freeze({ ...observed });
        identitySettled = true;
        resolveIdentity(supervisorIdentity);
        bootstrapPending = false;
        protocolBytes = bootstrapBytes.subarray(newline + 1);
        bootstrapBytes = Buffer.alloc(0);
      }
      if (protocolBytes.length === 0) return;
      for (const frame of decoder.push(protocolBytes)) handleFrame(frame);
    } catch {
      rejectFinalRetainedObservation();
      failClosed();
    }
  }
  function readStderr(chunk: Buffer): void {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > STDERR_CAP_BYTES) failClosed();
  }

  const handleStreamError = (): void => failClosed();
  child.stdin.on("error", handleStreamError);
  child.stdout.on("error", () => {
    rejectFinalRetainedObservation();
    failClosed();
  });
  child.stderr.on("error", handleStreamError);
  child.stdout.on("data", readStdout);
  child.stdout.once("close", finishFinalRetainedObservation);
  child.stderr.on("data", readStderr);
  child.on("error", () => {
    if (child.pid === undefined) {
      sawExit = true;
      finishExitAndClose();
    }
    failClosed();
  });
  child.once("exit", () => {
    sawExit = true;
    finishExitAndClose();
    failClosed();
  });
  child.once("close", () => {
    sawClose = true;
    finishExitAndClose();
    failClosed();
  });

  if (!Number.isInteger(spawnedPid) || (spawnedPid ?? 0) <= 0) {
    rejectObservedIdentity();
    failClosed();
  } else if (jobLaunch === undefined) {
    const observationDeadline = Date.now() + input.forceSettlementTimeoutMs;
    let observation: Promise<SupervisorProcessIdentity | undefined>;
    try {
      observation = Promise.resolve(input.dependencies.observeSupervisorIdentity(
        spawnedPid!,
        observationDeadline,
      ));
    } catch {
      observation = Promise.reject();
    }
    const observationOutcome = ownsHelperLifecycle(input.dependencies.observeSupervisorIdentity)
      ? waitForOwnedLifecycle(observation)
      : waitUntilDeadline(observation, observationDeadline);
    void observationOutcome.then((outcome) => {
      if (outcome.kind !== "resolved" || !isExactIdentity(outcome.value, spawnedPid)) {
        rejectObservedIdentity();
        failClosed();
        return;
      }
      const observed = outcome.value;
      try {
        if (retainedIdentities.some((identity_) => identity_.pid === observed.pid)) {
          throw stoppedError();
        }
        supervisorIdentity = Object.freeze({ ...observed });
        if (!identitySettled) {
          identitySettled = true;
          resolveIdentity(supervisorIdentity);
        }
      } catch {
        rejectObservedIdentity();
        failClosed();
      }
    });
  }

  const sendRequest = <Result>(
    operation: PendingRequest["operation"],
    payload: unknown,
    deadline: number,
  ): Promise<Result> => {
    if (settlementPromise !== undefined) return Promise.reject(stoppedError());
    const requestId = randomUUID();
    const frame: SupervisorRequestFrame = {
      version: 1,
      kind: "request",
      runId,
      sessionId,
      nonce,
      requestId,
      operation,
      payload,
    };
    return new Promise<Result>((resolveRequest, rejectRequest) => {
      const delay = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
      const timer = setTimeout(() => {
        void forceSettlement().catch(() => undefined);
      }, delay);
      pendingRequests.set(requestId, {
        operation,
        deadline,
        resolve: resolveRequest as (payload: unknown) => void,
        reject: rejectRequest,
        timer,
        closeResponseReceived: false,
      });
      try {
        protocolState = applySupervisorProtocolFrame(protocolState, frame);
        const bytes = encodeSupervisorFrame(frame);
        child.stdin.write(bytes, (error) => {
          if (error) failClosed();
        });
      } catch {
        failClosed();
      }
    });
  };

  const session: ClientPortabilitySupervisorSession = {
    identity,
    connect: async (connectInput, deadline) => {
      if (
        productionAuthority !== undefined
        && (
          connectInput.bridgeExecutable !== productionAuthority.bridgeExecutable
          || connectInput.settingsRoot !== productionAuthority.settingsRoot
        )
      ) {
        failClosed();
        throw stoppedError();
      }
      const identityOutcome = await waitUntilDeadline(identity, deadline);
      if (identityOutcome.kind !== "resolved") {
        failClosed();
        throw stoppedError();
      }
      return sendRequest<void>("connect", connectInput, deadline);
    },
    callTool: <Result extends object>(
      name: string,
      arguments_: Record<string, unknown>,
      deadline: number,
    ) => sendRequest<Result>("callTool", { name, arguments: arguments_ }, deadline),
    close: (deadline) => sendRequest<void>("close", {}, deadline),
    settle: (deadline) => startSettlement(deadline),
  };
  return session;
};
