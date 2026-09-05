import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { spawnedChildren, spawnOverrides } = vi.hoisted(() => ({
  spawnedChildren: [] as ChildProcessWithoutNullStreams[],
  spawnOverrides: [] as Array<(
    command: string,
    args: readonly string[],
  ) => ChildProcessWithoutNullStreams>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...arguments_: unknown[]) => {
      const override = spawnOverrides.shift();
      const child = override === undefined
        ? Reflect.apply(actual.spawn, actual, arguments_) as ChildProcessWithoutNullStreams
        : override(arguments_[0] as string, arguments_[1] as readonly string[]);
      spawnedChildren.push(child);
      return child;
    },
  };
});

import {
  createClientPortabilitySupervisorSession,
  registerSupervisorHelperLifecycleOwner,
  type ClientPortabilitySupervisorSession,
  type SupervisorProcessIdentity,
  type SupervisorSettlementBackend,
  type SupervisorSettlementInput,
  type SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import {
  createWindowsSupervisorSettlementBackend,
  observeWindowsSupervisorIdentity,
} from "./client-portability-windows-settlement.js";

type FixtureMode =
  | "connect-fail-after-child"
  | "connect-hang"
  | "call-hang"
  | "close-hang"
  | "close-success"
  | "stubborn-hang"
  | "late-identity-at-abort"
  | "malformed-frame"
  | "truncated-frame"
  | "excess-stdout"
  | "excess-stderr"
  | "abrupt-exit";

const fixtureModes: readonly FixtureMode[] = [
  "connect-fail-after-child",
  "connect-hang",
  "call-hang",
  "close-hang",
  "malformed-frame",
  "truncated-frame",
  "excess-stdout",
  "excess-stderr",
  "abrupt-exit",
];
const builtFixtureModes: readonly FixtureMode[] = [
  ...fixtureModes,
  "close-success",
  "stubborn-hang",
  "late-identity-at-abort",
];
const repositoryRoot = resolve(".");
const connectInput = {
  bridgeExecutable: resolve("inert-bridge.exe"),
  connectionId: "fixture-connection",
  settingsRoot: resolve("fixture-settings"),
};
const stoppedMessage = "Client portability supervisor stopped.";
const forceSettlementTimeoutMs = 400;

interface SettlementCall {
  readonly child: ChildProcessWithoutNullStreams;
  readonly calledAt: number;
  readonly deadline: number;
  readonly pendingRequestCount: number;
  readonly roots: readonly SupervisorProcessIdentity[];
  readonly retainedIdentities: readonly SupervisorProcessIdentity[];
  readonly childExitAndClose: Promise<void>;
  readonly finalRetainedIdentities: Promise<readonly SupervisorProcessIdentity[]>;
  readonly rootIdentity: Promise<SupervisorProcessIdentity>;
}

interface OpenFixture {
  readonly session: ClientPortabilitySupervisorSession;
  readonly settlementCalls: SettlementCall[];
  readonly observedPids: number[];
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolveDeferred!: (value: Value) => void;
  const promise = new Promise<Value>((resolveValue) => {
    resolveDeferred = resolveValue;
  });
  return { promise, resolve: resolveDeferred };
};

let fixtureRoot: string;
const fixtureBundles = new Map<FixtureMode, string>();
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const activeSessions = new Set<ClientPortabilitySupervisorSession>();

const waitForChild = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null && child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolveChild) => child.once("close", () => resolveChild())),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("Fixture child did not close.")),
      3_000,
    )),
  ]);
};

const realChildForSettlement = (
  input: SupervisorSettlementInput,
): ChildProcessWithoutNullStreams => {
  const child = [...spawnedChildren].reverse().find((candidate) => candidate.pid === input.child.pid);
  if (child === undefined) throw new Error("Fixture child is unavailable.");
  return child;
};

const buildFixture = async (mode: FixtureMode): Promise<string> => {
  const outputFile = join(fixtureRoot, `${mode}.mjs`);
  await build({
    entryPoints: [resolve("src/desktop/e2e/fixtures/client-portability-supervisor-fixture.ts")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    define: {
      __INTENTARC_SUPERVISOR_FIXTURE_MODE__: JSON.stringify(mode),
    },
  });
  return outputFile;
};

const createSettlementBackend = (
  calls: SettlementCall[],
  delayBeforeTerminationMs = 0,
): SupervisorSettlementBackend => ({
  settle: async (input: SupervisorSettlementInput): Promise<SupervisorSettlementResult> => {
    const child = realChildForSettlement(input);
    activeChildren.add(child);
    const roots = [...input.roots];
    calls.push({
      child,
      calledAt: Date.now(),
      deadline: input.deadline,
      pendingRequestCount: input.pendingRequestCount,
      roots,
      retainedIdentities: [...input.retainedIdentities],
      childExitAndClose: input.childExitAndClose,
      finalRetainedIdentities: input.finalRetainedIdentities,
      rootIdentity: input.rootIdentity,
    });
    if (delayBeforeTerminationMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayBeforeTerminationMs));
    }
    if (child.exitCode === null && !child.killed) child.kill();
    await input.childExitAndClose;
    activeChildren.delete(child);
    if (roots.length === 0) {
      return { status: "blocked", category: "identity", retained: [] };
    }
    return {
      status: "settled",
      category: "none",
      retained: [...roots, ...input.retainedIdentities],
    };
  },
});

const openFixture = (
  mode: FixtureMode,
  options: { readonly delayBeforeTerminationMs?: number } = {},
): OpenFixture => {
  const settlementCalls: SettlementCall[] = [];
  const observedPids: number[] = [];
  const session = createClientPortabilitySupervisorSession({
    repositoryRoot,
    supervisorBundle: fixtureBundles.get(mode)!,
    clientKind: "codex",
    forceSettlementTimeoutMs,
    dependencies: {
      observeSupervisorIdentity: async (pid) => {
        observedPids.push(pid);
        return { pid, startTime: `${pid}000` };
      },
      settlementBackend: createSettlementBackend(
        settlementCalls,
        options.delayBeforeTerminationMs,
      ),
    },
  });
  activeSessions.add(session);
  return { session, settlementCalls, observedPids };
};

const exerciseMode = async (
  mode: FixtureMode,
  session: ClientPortabilitySupervisorSession,
): Promise<{ readonly deadline: number; readonly request: Promise<unknown> }> => {
  if (mode === "call-hang" || mode === "close-hang") {
    await session.connect(connectInput, Date.now() + 3_000);
  }
  const deadline = Date.now() + (
    mode.endsWith("hang") || mode === "truncated-frame" ? 100 : 2_000
  );
  const request = mode === "call-hang"
    ? session.callTool("fixture_tool", {}, deadline)
    : mode === "close-hang"
      ? session.close(deadline)
      : session.connect(connectInput, deadline);
  return { deadline, request };
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "intentarc-parent-supervisor-"));
  await Promise.all(builtFixtureModes.map(async (mode) => {
    fixtureBundles.set(mode, await buildFixture(mode));
  }));
}, 30_000);

afterEach(async () => {
  await Promise.all([...activeSessions].map((session) =>
    session.settle(Date.now() + 2_000).catch(() => undefined)
  ));
  activeSessions.clear();
  const children = [...activeChildren];
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  await Promise.all(children.map((child) => waitForChild(child).catch(() => undefined)));
  activeChildren.clear();
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("parent client ownership with real inert supervisor fixtures", () => {
  it("drains a buffered late bridge identity into immutable final retained evidence", async () => {
    // Catches abort teardown removing stdout ownership before a detached bridge identity frame is drained.
    const backendStarted = deferred<SupervisorSettlementInput>();
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("late-identity-at-abort")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 2_000,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            backendStarted.resolve(input);
            await input.childExitAndClose;
            const finalRetained = await input.finalRetainedIdentities;
            activeChildren.delete(child);
            return {
              status: "settled",
              category: "none",
              retained: [...input.roots, ...finalRetained],
            };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.connect(connectInput, Date.now() + 3_000);

    await expect(session.callTool("trigger_abort", {}, Date.now() + 40)).rejects.toThrow(
      stoppedMessage,
    );
    const backendInput = await backendStarted.promise;
    const finalRetained = await backendInput.finalRetainedIdentities;
    const result = await session.settle(Date.now() + 3_000);

    expect(backendInput.retainedIdentities).toEqual([]);
    expect(Object.isFrozen(backendInput.finalRetainedIdentities)).toBe(true);
    expect(finalRetained).toHaveLength(1);
    expect(finalRetained[0]).toMatchObject({ pid: expect.any(Number), startTime: expect.any(String) });
    expect(result).toEqual({
      status: "settled",
      category: "none",
      retained: [...backendInput.roots, ...finalRetained],
    });
    activeSessions.delete(session);
  }, 10_000);

  it("preserves late retained evidence when the backend rejects immediately", async () => {
    // Catches an early blocked return omitting a correlated identity still draining from stdout.
    const childIndex = spawnedChildren.length;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("late-identity-at-abort")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 2_000,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: { settle: async () => { throw new Error("backend rejected"); } },
      },
    });
    activeSessions.add(session);
    const root = await session.identity;
    await session.connect(connectInput, Date.now() + 3_000);

    await expect(session.callTool("trigger_abort", {}, Date.now() + 40)).rejects.toThrow(
      stoppedMessage,
    );
    const result = await session.settle(Date.now() + 2_000);
    await waitForChild(spawnedChildren[childIndex]!);

    expect(result).toMatchObject({ status: "blocked", category: "observation" });
    expect(result.retained).toHaveLength(2);
    expect(result.retained).toContainEqual(root);
    expect(result.retained).toContainEqual({ pid: expect.any(Number), startTime: expect.any(String) });
    activeSessions.delete(session);
  });

  it("preserves a slow exact root when the backend rejects after stdout closes", async () => {
    // Catches a blocked result joining final stdout evidence but returning before root identity evidence.
    const childIndex = spawnedChildren.length;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("abrupt-exit")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 2_000,
      dependencies: {
        observeSupervisorIdentity: async (pid) => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
          return { pid, startTime: `${pid}000` };
        },
        settlementBackend: { settle: async () => { throw new Error("backend rejected"); } },
      },
    });
    activeSessions.add(session);
    const rootPromise = session.identity;

    await expect(session.connect(connectInput, Date.now() + 3_000)).rejects.toThrow(
      stoppedMessage,
    );
    const result = await session.settle(Date.now() + 2_000);
    const root = await rootPromise;
    await waitForChild(spawnedChildren[childIndex]!);

    expect(result).toEqual({ status: "blocked", category: "observation", retained: [root] });
    activeSessions.delete(session);
  });

  it("does not abandon a lifecycle-owned root observer during final cleanup", async () => {
    // Catches re-racing the private identity promise after registering its observer as helper-owned.
    const childIndex = spawnedChildren.length;
    let observerClosed = false;
    const observeSupervisorIdentity = registerSupervisorHelperLifecycleOwner(async (pid: number) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      observerClosed = true;
      return { pid, startTime: `${pid}000` };
    });
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 40,
      dependencies: {
        observeSupervisorIdentity,
        settlementBackend: { settle: async () => { throw new Error("backend rejected"); } },
      },
    });
    activeSessions.add(session);
    const rootPromise = session.identity;

    await expect(session.connect(connectInput, Date.now() + 10)).rejects.toThrow(
      stoppedMessage,
    );
    const result = await session.settle(Date.now() + 2_000);
    const observerClosedAtResult = observerClosed;
    const root = await rootPromise;
    const child = spawnedChildren[childIndex]!;
    if (child.exitCode === null && !child.killed) child.kill();
    await waitForChild(spawnedChildren[childIndex]!);

    expect(observerClosedAtResult).toBe(true);
    expect(result).toEqual({ status: "blocked", category: "observation", retained: [root] });
    activeSessions.delete(session);
  });

  it("does not abandon a lifecycle-owned backend at the operation deadline", async () => {
    // Catches the parent returning while the production backend still owns a closing PowerShell helper.
    const childIndex = spawnedChildren.length;
    let backendClosed = false;
    const settlementBackend = registerSupervisorHelperLifecycleOwner({
      settle: async (input: SupervisorSettlementInput): Promise<SupervisorSettlementResult> => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 70));
        backendClosed = true;
        return {
          status: "blocked",
          category: "observation",
          retained: [...input.roots, ...input.retainedIdentities],
        };
      },
    } satisfies SupervisorSettlementBackend);
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("abrupt-exit")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 40,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend,
      },
    });
    activeSessions.add(session);
    const root = await session.identity;

    await expect(session.connect(connectInput, Date.now() + 3_000)).rejects.toThrow(
      stoppedMessage,
    );
    const result = await session.settle(Date.now() + 2_000);
    await waitForChild(spawnedChildren[childIndex]!);

    expect(backendClosed).toBe(true);
    expect(result.retained).toContainEqual(root);
    activeSessions.delete(session);
  });

  it("does not trust a forged lifecycle-owned backend property", async () => {
    // Catches an arbitrary injected backend disabling the deadline by copying a public trust bit.
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("abrupt-exit")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 40,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          helperLifecycleOwned: true,
          settle: async () => new Promise<SupervisorSettlementResult>(() => undefined),
        } as SupervisorSettlementBackend,
      },
    });
    activeSessions.add(session);
    await session.identity;

    await expect(session.connect(connectInput, Date.now() + 3_000)).rejects.toThrow(
      stoppedMessage,
    );
    const outcome = await Promise.race([
      session.settle(Date.now() + 2_000),
      new Promise<"still-pending">((resolveTimeout) => setTimeout(
        () => resolveTimeout("still-pending"),
        250,
      )),
    ]);
    activeSessions.delete(session);

    expect(outcome).not.toBe("still-pending");
    expect(outcome).toMatchObject({ status: "blocked", category: "observation" });
  });

  it.runIf(process.platform === "win32")(
    "binds production identity to the exact job host instead of a PID-reused observer result",
    async () => {
      // Catches a PID-wide post-spawn observation enrolling and terminating a replacement process.
      const acceptanceRoot = join(
        fixtureRoot,
        "intentarc-client-portability-live-123e4567-e89b-42d3-a456-426614174000",
      );
      const settingsRoot = join(acceptanceRoot, "Roaming", "IntentArc");
      const archivePath = join(acceptanceRoot, "intentarc.sqlite");
      const bridgeExecutable = join(fixtureRoot, "IntentArc Bridge.exe");
      await mkdir(settingsRoot, { recursive: true });
      await Promise.all([
        writeFile(archivePath, "archive"),
        writeFile(bridgeExecutable, "bridge"),
      ]);
      const childIndex = spawnedChildren.length;
      const observedPids: number[] = [];
      const session = createClientPortabilitySupervisorSession({
        repositoryRoot: fixtureRoot,
        supervisorBundle: fixtureBundles.get("stubborn-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs: 15_000,
        windowsJobObject: true,
        launchAuthority: {
          bridgeExecutable,
          settingsRoot,
          archivePath,
          acceptanceRoot,
        },
        dependencies: {
          observeSupervisorIdentity: async (pid) => {
            observedPids.push(pid);
            return { pid, startTime: "1" };
          },
          settlementBackend: createWindowsSupervisorSettlementBackend(),
        },
      });
      activeSessions.add(session);
      const child = spawnedChildren[childIndex]!;
      const connecting = session.connect({
        ...connectInput,
        bridgeExecutable,
        settingsRoot,
      }, Date.now() + 3_000);

      const identity = await session.identity;
      await expect(connecting).rejects.toThrow(stoppedMessage);
      const result = await session.settle(Date.now() + 20_000);

      expect(result).toMatchObject({ status: "settled", category: "none" });
      expect(result.retained).toContainEqual(identity);
      expect(observedPids).toEqual([]);
      expect(identity.startTime).not.toBe("1");
      await expect(Promise.all(result.retained.map((retainedIdentity) =>
        observeWindowsSupervisorIdentity(retainedIdentity.pid, Date.now() + 5_000)
      ))).resolves.toEqual(result.retained.map(() => undefined));
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      activeSessions.delete(session);
    },
    30_000,
  );

  it.runIf(process.platform === "win32").each([
    "hung",
    "error",
    "exit-close",
    "malformed-bootstrap",
  ] as const)(
    "terminates and joins the exact job host when %s occurs before bootstrap",
    async (failureMode) => {
      // Catches pre-bootstrap identity rejection returning while the exact job-host handle remains live.
      const acceptanceRoot = join(fixtureRoot, `pre-bootstrap-${failureMode}`);
      const settingsRoot = join(acceptanceRoot, "Roaming", "IntentArc");
      const archivePath = join(acceptanceRoot, "intentarc.sqlite");
      const bridgeExecutable = join(fixtureRoot, `pre-bootstrap-${failureMode}.exe`);
      await mkdir(settingsRoot, { recursive: true });
      await Promise.all([
        writeFile(archivePath, "archive"),
        writeFile(bridgeExecutable, "bridge"),
      ]);
      const fakePid = 41_200 + spawnedChildren.length;
      const killStarted = deferred<void>();
      let killCalls = 0;
      let backendCalls = 0;
      let settlementReturned = false;
      let hostClosed = false;
      let closeHost!: () => void;
      let emitLateBootstrap!: () => void;
      let fakeChild!: ChildProcessWithoutNullStreams;
      spawnOverrides.push((_command, args) => {
        const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        fakeChild = child;
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let exited = false;
        const exit = (): void => {
          if (exited) return;
          exited = true;
          Object.defineProperty(child, "exitCode", { value: 1, configurable: true });
          child.emit("exit", 1, null);
        };
        closeHost = (): void => {
          if (hostClosed) return;
          hostClosed = true;
          exit();
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
          child.emit("close", 1, null);
        };
        Object.assign(child, {
          pid: fakePid,
          exitCode: null,
          killed: false,
          stdin,
          stdout,
          stderr,
          kill: () => {
            killCalls += 1;
            Object.defineProperty(child, "killed", { value: true, configurable: true });
            exit();
            stdin.destroy();
            stdout.destroy();
            stderr.destroy();
            killStarted.resolve(undefined);
            return true;
          },
        });
        const encoded = args.slice(-6);
        const decoded = encoded.map((value) => Buffer.from(value, "base64").toString("utf8"));
        const validLateBootstrap = `${JSON.stringify({
          schema: "intentarc.client-portability-job/v1",
          pid: fakePid,
          startTime: "638914932000000099",
          jobName: decoded[2],
          runId: decoded[3],
          sessionId: decoded[4],
          nonce: decoded[5],
        })}\n`;
        emitLateBootstrap = () => stdout.emit("data", Buffer.from(validLateBootstrap));
        queueMicrotask(() => {
          if (failureMode === "error") child.emit("error", new Error("host failed"));
          else if (failureMode === "exit-close") closeHost();
          else if (failureMode === "malformed-bootstrap") {
            stdout.emit("data", Buffer.from("not-a-bootstrap\n"));
          }
        });
        return child;
      });
      const session = createClientPortabilitySupervisorSession({
        repositoryRoot: fixtureRoot,
        supervisorBundle: fixtureBundles.get("stubborn-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs: 80,
        windowsJobObject: true,
        launchAuthority: {
          bridgeExecutable,
          settingsRoot,
          archivePath,
          acceptanceRoot,
        },
        dependencies: {
          observeSupervisorIdentity: observeWindowsSupervisorIdentity,
          settlementBackend: {
            settle: async () => {
              backendCalls += 1;
              return { status: "blocked", category: "identity", retained: [] };
            },
          },
        },
      });
      activeSessions.add(session);
      await Promise.resolve();
      const identityOutcomePromise = session.identity.then(() => "resolved", () => "rejected");
      const settlementPromise = session.settle(Date.now() + 250).then((result) => {
        settlementReturned = true;
        return result;
      });
      const killOutcome = await Promise.race([
        killStarted.promise.then(() => "called" as const),
        new Promise<"not-called">((resolveTimeout) => setTimeout(
          () => resolveTimeout("not-called"),
          150,
        )),
      ]);
      if (killOutcome === "called" && failureMode !== "exit-close") {
        const earlySettlement = await Promise.race([
          settlementPromise.then(() => "returned" as const),
          new Promise<"pending">((resolveTimeout) => setTimeout(
            () => resolveTimeout("pending"),
            20,
          )),
        ]);
        expect(earlySettlement).toBe("pending");
        expect(settlementReturned).toBe(false);
        emitLateBootstrap();
      }
      closeHost();
      const settlementOutcome = await Promise.race([
        settlementPromise,
        new Promise<"still-pending">((resolveTimeout) => setTimeout(
          () => resolveTimeout("still-pending"),
          250,
        )),
      ]);
      const identityOutcome = await identityOutcomePromise;
      let lateErrorThrown = false;
      try {
        fakeChild.emit("error", new Error("late host error one"));
        fakeChild.emit("error", new Error("late host error two"));
      } catch {
        lateErrorThrown = true;
      }
      activeSessions.delete(session);

      expect(killOutcome).toBe("called");
      expect(killCalls).toBe(1);
      expect(backendCalls).toBe(1);
      expect(hostClosed).toBe(true);
      expect(lateErrorThrown).toBe(false);
      expect(identityOutcome).toBe("rejected");
      expect(settlementOutcome).not.toBe("still-pending");
      expect(settlementOutcome).toMatchObject({
        status: "blocked",
        category: "identity",
        retained: [],
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "hard-bounds unconfirmed exact-handle termination without claiming cleanup",
    async () => {
      // Catches a kill=false/no-events seam returning identity-blocked as though handle cleanup completed.
      const acceptanceRoot = join(fixtureRoot, "pre-bootstrap-no-events");
      const settingsRoot = join(acceptanceRoot, "Roaming", "IntentArc");
      const archivePath = join(acceptanceRoot, "intentarc.sqlite");
      const bridgeExecutable = join(fixtureRoot, "pre-bootstrap-no-events.exe");
      await mkdir(settingsRoot, { recursive: true });
      await Promise.all([
        writeFile(archivePath, "archive"),
        writeFile(bridgeExecutable, "bridge"),
      ]);
      const fakePid = 41_300 + spawnedChildren.length;
      let killCalls = 0;
      let fakeChild!: ChildProcessWithoutNullStreams;
      spawnOverrides.push(() => {
        const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        fakeChild = child;
        Object.assign(child, {
          pid: fakePid,
          exitCode: null,
          killed: false,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            killCalls += 1;
            return false;
          },
        });
        return child;
      });
      const session = createClientPortabilitySupervisorSession({
        repositoryRoot: fixtureRoot,
        supervisorBundle: fixtureBundles.get("stubborn-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs: 60,
        windowsJobObject: true,
        launchAuthority: {
          bridgeExecutable,
          settingsRoot,
          archivePath,
          acceptanceRoot,
        },
        dependencies: {
          observeSupervisorIdentity: observeWindowsSupervisorIdentity,
          settlementBackend: {
            settle: async () => ({ status: "blocked", category: "identity", retained: [] }),
          },
        },
      });
      activeSessions.add(session);
      const identityOutcomePromise = session.identity.then(() => "resolved", () => "rejected");
      const startedAt = Date.now();
      const settlementOutcome = await Promise.race([
        session.settle(Date.now() + 60),
        new Promise<"still-pending">((resolveTimeout) => setTimeout(
          () => resolveTimeout("still-pending"),
          250,
        )),
      ]);
      const elapsed = Date.now() - startedAt;
      const identityOutcome = await identityOutcomePromise;
      let lateErrorThrown = false;
      try {
        fakeChild.emit("error", new Error("late unconfirmed host error one"));
        fakeChild.emit("error", new Error("late unconfirmed host error two"));
      } catch {
        lateErrorThrown = true;
      }
      Object.defineProperty(fakeChild, "exitCode", { value: 1, configurable: true });
      fakeChild.emit("exit", 1, null);
      fakeChild.stdin.destroy();
      fakeChild.stdout.destroy();
      fakeChild.stderr.destroy();
      fakeChild.emit("close", 1, null);
      activeSessions.delete(session);

      expect(killCalls).toBe(1);
      expect(elapsed).toBeLessThan(200);
      expect(identityOutcome).toBe("rejected");
      expect(settlementOutcome).toEqual({
        status: "blocked",
        category: "child_handle",
        retained: [],
      });
      expect(lateErrorThrown).toBe(false);
    },
  );

  it.each(fixtureModes)(
    "owns, drains, and settles the %s fixture without writable IPC residue",
    async (mode) => {
      // Catches losing child ownership before connect, leaving a timed-out request registered,
      // or handling a child/protocol failure outside the shared settlement path.
      const opened = openFixture(mode);

      expect(opened.session).toEqual(expect.objectContaining({
        identity: expect.any(Promise),
        connect: expect.any(Function),
        callTool: expect.any(Function),
        close: expect.any(Function),
        settle: expect.any(Function),
      }));
      expect(opened.session).not.toBeInstanceOf(Promise);

      const identity = await opened.session.identity;
      const { deadline, request } = await exerciseMode(mode, opened.session);

      await expect(request).rejects.toThrow(stoppedMessage);
      await expect(opened.session.settle(Date.now() + 2_000)).resolves.toMatchObject(
        mode === "malformed-frame" || mode === "truncated-frame" || mode === "excess-stdout"
          ? { status: "blocked", category: "observation" }
          : { status: "settled", category: "none" },
      );

      expect(opened.observedPids).toEqual([identity.pid]);
      expect(opened.settlementCalls).toHaveLength(1);
      const settlement = opened.settlementCalls[0]!;
      activeChildren.delete(settlement.child);
      expect(settlement.deadline).toBeGreaterThanOrEqual(
        settlement.calledAt + forceSettlementTimeoutMs - 25,
      );
      expect(settlement.deadline).toBeLessThanOrEqual(
        settlement.calledAt + forceSettlementTimeoutMs + 25,
      );
      expect(settlement.pendingRequestCount).toBe(0);
      expect(settlement.roots).toEqual([identity]);
      expect(settlement.retainedIdentities).toHaveLength(
        mode === "connect-fail-after-child" ? 1 : 0,
      );
      await expect(settlement.childExitAndClose).resolves.toBeUndefined();
      expect(settlement.child.stdin.destroyed).toBe(true);
      expect(settlement.child.stdout.destroyed).toBe(true);
      expect(settlement.child.stderr.destroyed).toBe(true);
    },
    10_000,
  );

  it("returns the owned session synchronously before a hanging connect can settle", async () => {
    // Catches the factory awaiting connect before returning ownership to the parent.
    const opened = openFixture("connect-hang");
    const sessionAtReturn = opened.session;
    const deadline = Date.now() + 100;
    const connecting = sessionAtReturn.connect(connectInput, deadline);

    expect(sessionAtReturn).not.toBeInstanceOf(Promise);
    await expect(sessionAtReturn.identity).resolves.toMatchObject({ pid: expect.any(Number) });
    await expect(connecting).rejects.toThrow(stoppedMessage);
    await sessionAtReturn.settle(Date.now() + 2_000);
  });

  it("does not resolve close until the correlated terminal receipt arrives", async () => {
    // Catches treating the close response as proof before the supervisor's terminal receipt.
    const opened = openFixture("close-success");
    await opened.session.connect(connectInput, Date.now() + 3_000);
    let closeSettled = false;
    const closing = opened.session.close(Date.now() + 2_000).finally(() => {
      closeSettled = true;
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(closeSettled).toBe(false);
    await expect(closing).resolves.toBeUndefined();
    await expect(opened.session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "settled",
      category: "none",
    });
  });

  it("rejects every concurrent call and reports an empty registry before one settlement", async () => {
    // Catches removing only the request whose deadline fired instead of draining every owner promise.
    const opened = openFixture("call-hang");
    await opened.session.connect(connectInput, Date.now() + 3_000);
    const deadline = Date.now() + 100;
    const first = opened.session.callTool("first", {}, deadline);
    const second = opened.session.callTool("second", {}, deadline + 1_000);

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: stoppedMessage }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: stoppedMessage }) }),
    ]);
    await opened.session.settle(Date.now() + 2_000);

    expect(opened.settlementCalls).toHaveLength(1);
    expect(opened.settlementCalls[0]!.pendingRequestCount).toBe(0);
  });

  it("aliases competing deadlines and explicit settle calls to one settlement promise", async () => {
    // Catches allocating a fresh backend settlement promise for each timed-out request or settle call.
    const opened = openFixture("call-hang", { delayBeforeTerminationMs: 150 });
    await opened.session.connect(connectInput, Date.now() + 3_000);
    const firstDeadline = Date.now() + 80;
    const first = opened.session.callTool("first", {}, firstDeadline);
    const second = opened.session.callTool("second", {}, firstDeadline + 500);
    await expect(first).rejects.toThrow(stoppedMessage);
    await expect(second).rejects.toThrow(stoppedMessage);

    const firstSettlement = opened.session.settle(Date.now() + 1_000);
    const secondSettlement = opened.session.settle(Date.now() + 2_000);
    expect(secondSettlement).toBe(firstSettlement);
    await expect(firstSettlement).resolves.toMatchObject({ status: "settled" });
    expect(opened.settlementCalls).toHaveLength(1);
    expect(opened.settlementCalls[0]!.deadline).toBeGreaterThan(firstDeadline);
  });

  it.each(["stdin", "stdout", "stderr"] as const)(
    "routes an isolated %s error through one owned settlement",
    async (streamName) => {
      // Catches an unhandled Node pipe error crashing the parent after a write or stream teardown.
      const backendStarted = deferred<SupervisorSettlementInput>();
      const releaseBackend = deferred<void>();
      let backendCalls = 0;
      const childIndex = spawnedChildren.length;
      const session = createClientPortabilitySupervisorSession({
        repositoryRoot,
        supervisorBundle: fixtureBundles.get("stubborn-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs,
        dependencies: {
          observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
          settlementBackend: {
            settle: async (input) => {
              backendCalls += 1;
              const child = realChildForSettlement(input);
              activeChildren.add(child);
              backendStarted.resolve(input);
              await releaseBackend.promise;
              if (child.exitCode === null && !child.killed) child.kill();
              await input.childExitAndClose;
              activeChildren.delete(child);
              return {
                status: "settled",
                category: "none",
                retained: [...input.roots, ...input.retainedIdentities],
              };
            },
          },
        },
      });
      activeSessions.add(session);
      await session.identity;
      const child = spawnedChildren[childIndex]!;
      const connecting = session.connect(connectInput, Date.now() + 2_000);
      let emissionFailure: unknown;

      try {
        child[streamName].emit("error", new Error("adversarial-pipe-error"));
      } catch (error) {
        emissionFailure = error;
      }

      await expect(connecting).rejects.toThrow(stoppedMessage);
      const backendInput = await backendStarted.promise;

      try {
        child[streamName].emit("error", new Error("adversarial-pipe-error"));
      } catch (error) {
        emissionFailure = error;
      } finally {
        releaseBackend.resolve();
      }

      await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject(
        streamName === "stdout"
          ? { status: "blocked", category: "observation" }
          : { status: "settled" },
      );
      expect(emissionFailure).toBeUndefined();
      expect(backendCalls).toBe(1);
    },
  );

  it("rejects forged settlement until exact child exit and close evidence reaches its bound", async () => {
    // Catches accepting a backend's settled claim while the owned supervisor is still alive.
    let backendInput: SupervisorSettlementInput | undefined;
    const childIndex = spawnedChildren.length;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("stubborn-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 150,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            backendInput = input;
            activeChildren.add(realChildForSettlement(input));
            return {
              status: "settled",
              category: "none",
              retained: [...input.roots, ...input.retainedIdentities],
            };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const child = spawnedChildren[childIndex]!;
    const startedAt = Date.now();
    const connecting = session.connect(connectInput, startedAt + 30);
    await expect(connecting).rejects.toThrow(stoppedMessage);
    const result = await session.settle(Date.now() + 2_000);
    const elapsed = Date.now() - startedAt;

    try {
      expect(result).toMatchObject({ status: "blocked", category: "child_handle" });
      expect(elapsed).toBeGreaterThanOrEqual(125);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
      if (backendInput !== undefined) {
        await backendInput.childExitAndClose;
        activeChildren.delete(child);
      }
    }
  });

  it("keeps private child exit and close evidence trusted when the backend tampers", async () => {
    // Catches exposing the parent's evidence Promise so a backend can forge its later `.then` call.
    let backendInput: SupervisorSettlementInput | undefined;
    let mutationFailed = false;
    const childIndex = spawnedChildren.length;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("stubborn-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 150,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            backendInput = input;
            activeChildren.add(realChildForSettlement(input));
            try {
              Object.defineProperty(input.childExitAndClose, "then", {
                configurable: true,
                value: (resolveForged: (value: void) => void) => {
                  resolveForged();
                  return Promise.resolve();
                },
              });
            } catch {
              mutationFailed = true;
            }
            return {
              status: "settled",
              category: "none",
              retained: [...input.roots, ...input.retainedIdentities],
            };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const child = spawnedChildren[childIndex]!;
    const connecting = session.connect(connectInput, Date.now() + 30);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    const result = await session.settle(Date.now() + 2_000);

    try {
      expect(mutationFailed).toBe(true);
      expect(backendInput).toBeDefined();
      expect(Object.isFrozen(backendInput!.childExitAndClose)).toBe(true);
      expect(result).toMatchObject({ status: "blocked", category: "child_handle" });
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
      if (backendInput !== undefined) {
        await waitForChild(child);
        activeChildren.delete(child);
      }
    }
  });

  it("snapshots an accessor-backed backend result before choosing child-handle proof", async () => {
    // Catches a status getter returning blocked for the branch and settled for later validation.
    let backendInput: SupervisorSettlementInput | undefined;
    let statusReads = 0;
    const childIndex = spawnedChildren.length;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("stubborn-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 150,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            backendInput = input;
            activeChildren.add(realChildForSettlement(input));
            return Object.defineProperties({}, {
              status: {
                enumerable: true,
                get: () => ++statusReads === 1 ? "blocked" : "settled",
              },
              category: { enumerable: true, value: "none" },
              retained: { enumerable: true, value: [...input.roots] },
            }) as SupervisorSettlementResult;
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const child = spawnedChildren[childIndex]!;
    const connecting = session.connect(connectInput, Date.now() + 30);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    const result = await session.settle(Date.now() + 2_000);

    try {
      expect(statusReads).toBe(1);
      expect(result).toMatchObject({ status: "blocked", category: "observation" });
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
      if (backendInput !== undefined) {
        await waitForChild(child);
        activeChildren.delete(child);
      }
    }
  });

  it("reads each nested backend identity primitive once into a bounded snapshot", async () => {
    // Catches validating accessor values and then spreading a different unchecked identity.
    let pidReads = 0;
    let startTimeReads = 0;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            const root = input.roots[0]!;
            const child = realChildForSettlement(input);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            const accessorIdentity = Object.defineProperties({}, {
              pid: { enumerable: true, get: () => { pidReads += 1; return root.pid; } },
              startTime: {
                enumerable: true,
                get: () => { startTimeReads += 1; return root.startTime; },
              },
            }) as SupervisorProcessIdentity;
            return { status: "settled", category: "none", retained: [accessorIdentity] };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const connecting = session.connect(connectInput, Date.now() + 50);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "settled",
      category: "none",
    });
    expect(pidReads).toBe(1);
    expect(startTimeReads).toBe(1);
  });

  it("keeps lifecycle emitters private from a backend that forges exit and close", async () => {
    // Catches exposing the real ChildProcess whose events resolve the parent's private evidence.
    const childIndex = spawnedChildren.length;
    let backendInput: SupervisorSettlementInput | undefined;
    let exposedLifecycleSurface = false;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("stubborn-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs: 150,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            backendInput = input;
            const exposed = input.child as unknown as {
              readonly emit?: (...arguments_: unknown[]) => void;
              readonly stdout?: { readonly emit?: (...arguments_: unknown[]) => void };
            };
            exposedLifecycleSurface = typeof exposed.emit === "function"
              || typeof exposed.stdout?.emit === "function";
            exposed.stdout?.emit?.("close");
            exposed.emit?.("exit", 0, null);
            exposed.emit?.("close", 0, null);
            return {
              status: "settled",
              category: "none",
              retained: [...input.roots],
            };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const realChild = spawnedChildren[childIndex]!;
    const connecting = session.connect(connectInput, Date.now() + 30);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    const result = await session.settle(Date.now() + 2_000);

    try {
      expect(backendInput).toBeDefined();
      expect(Object.isFrozen(backendInput!.child)).toBe(true);
      expect(exposedLifecycleSurface).toBe(false);
      expect(realChild.exitCode).toBeNull();
      expect(result).toMatchObject({ status: "blocked", category: "child_handle" });
    } finally {
      if (realChild.exitCode === null && !realChild.killed) realChild.kill();
      await waitForChild(realChild);
    }
  });

  it("invokes settlement before slow root observation with a fresh deadline and root promise", async () => {
    // Catches serializing backend invocation behind identity observation or reusing the request deadline.
    const observer = deferred<SupervisorProcessIdentity | undefined>();
    const backendStarted = deferred<{ readonly calledAt: number; readonly input: SupervisorSettlementInput }>();
    let observedPid = 0;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("stubborn-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => {
          observedPid = pid;
          return observer.promise;
        },
        settlementBackend: {
          settle: async (input) => {
            backendStarted.resolve({ calledAt: Date.now(), input });
            const root = await input.rootIdentity;
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            return { status: "settled", category: "none", retained: [root] };
          },
        },
      },
    });
    activeSessions.add(session);
    void session.identity.catch(() => undefined);
    const connecting = session.connect(connectInput, Date.now() + 30);
    await expect(connecting).rejects.toThrow(stoppedMessage);
    const outcome = await Promise.race([
      backendStarted.promise,
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 150)),
    ]);
    observer.resolve({ pid: observedPid, startTime: `${observedPid}000` });
    const result = await session.settle(Date.now() + 2_000);

    expect(outcome).not.toBe("timeout");
    if (outcome !== "timeout") {
      expect(outcome.input.rootIdentity).toBe(session.identity);
      expect(outcome.input.deadline).toBeGreaterThanOrEqual(
        outcome.calledAt + forceSettlementTimeoutMs - 25,
      );
      expect(outcome.input.deadline).toBeLessThanOrEqual(
        outcome.calledAt + forceSettlementTimeoutMs + 25,
      );
    }
    expect(result).toMatchObject({ status: "settled", category: "none" });
  });

  it("freezes backend inputs and validates against an independent exact identity snapshot", async () => {
    // Catches a backend deleting the real root and making validation trust its mutated alias.
    const mutationFailures: boolean[] = [];
    let expectedRoot: SupervisorProcessIdentity | undefined;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-fail-after-child")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => {
          expectedRoot = { pid, startTime: `${pid}000` };
          return expectedRoot;
        },
        settlementBackend: {
          settle: async (input) => {
            const root = input.roots[0]!;
            for (const mutate of [
              () => (input.roots as unknown as SupervisorProcessIdentity[]).splice(0),
              () => (input.retainedIdentities as unknown as SupervisorProcessIdentity[]).splice(0),
              () => { (root as { startTime: string }).startTime = "999"; },
              () => { (input as unknown as { roots: SupervisorProcessIdentity[] }).roots = []; },
            ]) {
              try {
                mutate();
                mutationFailures.push(false);
              } catch {
                mutationFailures.push(true);
              }
            }
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            return {
              status: "settled",
              category: "none",
              retained: [...input.roots, ...input.retainedIdentities],
            };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;

    await expect(session.connect(connectInput, Date.now() + 2_000)).rejects.toThrow(stoppedMessage);
    const result = await session.settle(Date.now() + 2_000);

    expect(mutationFailures).toEqual([true, true, true, true]);
    expect(result).toMatchObject({ status: "settled", category: "none" });
    expect(result.retained).toContainEqual(expectedRoot);
  });

  it("binds root validation to the spawn-time PID instead of backend-mutated child state", async () => {
    // Catches re-reading a mutable ChildProcess field after the untrusted backend returns.
    let mutationFailed = false;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            const root = await input.rootIdentity;
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            try {
              Object.defineProperty(input.child, "pid", {
                configurable: true,
                value: root.pid + 100_000,
              });
            } catch {
              mutationFailed = true;
            }
            return { status: "settled", category: "none", retained: [root] };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const connecting = session.connect(connectInput, Date.now() + 50);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "settled",
      category: "none",
    });
    expect(mutationFailed).toBe(true);
  });

  it.each(["reject", "throwing getter", "malformed"] as const)(
    "turns backend %s into bounded blocked observation without leaking its error",
    async (behavior) => {
      // Catches arbitrary backend exceptions or adversarial result inspection escaping settle.
      const secret = `backend-secret-${behavior}`;
      let root: SupervisorProcessIdentity | undefined;
      const session = createClientPortabilitySupervisorSession({
        repositoryRoot,
        supervisorBundle: fixtureBundles.get("connect-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs,
        dependencies: {
          observeSupervisorIdentity: async (pid) => {
            root = { pid, startTime: `${pid}000` };
            return root;
          },
          settlementBackend: {
            settle: async (input) => {
              const child = realChildForSettlement(input);
              activeChildren.add(child);
              if (child.exitCode === null && !child.killed) child.kill();
              await input.childExitAndClose;
              activeChildren.delete(child);
              if (behavior === "reject") throw new Error(secret);
              if (behavior === "throwing getter") {
                return Object.defineProperty({}, "status", {
                  enumerable: true,
                  get: () => { throw new Error(secret); },
                }) as never;
              }
              return undefined as never;
            },
          },
        },
      });
      activeSessions.add(session);
      await session.identity;
      const connecting = session.connect(connectInput, Date.now() + 50);

      await expect(connecting).rejects.toThrow(stoppedMessage);
      const result = await session.settle(Date.now() + 2_000);
      expect(result).toEqual({
        status: "blocked",
        category: "observation",
        retained: [root],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it("fails closed when exact supervisor identity observation is uncertain", async () => {
    // Catches fabricating a root identity or falling back to root-PID-only process handling.
    const settlementCalls: SettlementCall[] = [];
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async () => undefined,
        settlementBackend: createSettlementBackend(settlementCalls),
      },
    });
    activeSessions.add(session);
    const connecting = session.connect(connectInput, Date.now() + 2_000);

    await expect(session.identity).rejects.toThrow(stoppedMessage);
    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "blocked",
      category: "identity",
    });
    expect(settlementCalls).toHaveLength(1);
    expect(settlementCalls[0]!.roots).toEqual([]);
    expect(settlementCalls[0]!.retainedIdentities).toEqual([]);
  });

  it("converts a malformed settlement backend result into blocked observation", async () => {
    // Catches an undefined or structurally invalid backend resolution crossing as settlement proof.
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => ({ pid, startTime: `${pid}000` }),
        settlementBackend: {
          settle: async (input) => {
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            return undefined as never;
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const connecting = session.connect(connectInput, Date.now() + 100);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "blocked",
      category: "observation",
    });
  });

  it("overrides backend settlement success when no exact root identity exists", async () => {
    // Catches trusting handle-only termination as proof after root identity observation failed.
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async () => undefined,
        settlementBackend: {
          settle: async (input) => {
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            return { status: "settled", category: "none", retained: [] };
          },
        },
      },
    });
    activeSessions.add(session);
    const connecting = session.connect(connectInput, Date.now() + 2_000);

    await expect(session.identity).rejects.toThrow(stoppedMessage);
    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "blocked",
      category: "identity",
    });
  });

  it("blocks a settlement result that drops a known exact identity", async () => {
    // Catches accepting structurally valid settlement output that loses recovery evidence.
    let observedIdentity: SupervisorProcessIdentity | undefined;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => {
          observedIdentity = { pid, startTime: `${pid}000` };
          return observedIdentity;
        },
        settlementBackend: {
          settle: async (input) => {
            const child = realChildForSettlement(input);
            activeChildren.add(child);
            if (child.exitCode === null && !child.killed) child.kill();
            await input.childExitAndClose;
            activeChildren.delete(child);
            return { status: "settled", category: "none", retained: [] };
          },
        },
      },
    });
    activeSessions.add(session);
    await session.identity;
    const connecting = session.connect(connectInput, Date.now() + 100);

    await expect(connecting).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toEqual({
      status: "blocked",
      category: "observation",
      retained: [observedIdentity],
    });
  });

  it("rejects a relative supervisor bundle before spawning or observing a process", () => {
    // Catches allowing PATH/cwd resolution to choose the executable code the parent owns.
    const observedPids: number[] = [];
    expect(() => createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle: ".\\fixture.mjs",
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async (pid) => {
          observedPids.push(pid);
          return { pid, startTime: "1" };
        },
        settlementBackend: createSettlementBackend([]),
      },
    })).toThrow("Client portability supervisor launch is invalid.");
    expect(observedPids).toEqual([]);
  });

  it("completes child-handle settlement when spawn errors without an exit event", async () => {
    // Catches waiting forever for an exit event Node does not emit after an asynchronous spawn error.
    let backendCalled = 0;
    const session = createClientPortabilitySupervisorSession({
      repositoryRoot: join(fixtureRoot, "missing-repository-root"),
      supervisorBundle: fixtureBundles.get("connect-hang")!,
      clientKind: "codex",
      forceSettlementTimeoutMs,
      dependencies: {
        observeSupervisorIdentity: async () => undefined,
        settlementBackend: {
          settle: async (input) => {
            backendCalled += 1;
            await input.childExitAndClose;
            return { status: "blocked", category: "child_handle", retained: [] };
          },
        },
      },
    });
    activeSessions.add(session);

    await expect(session.identity).rejects.toThrow(stoppedMessage);
    await expect(session.settle(Date.now() + 2_000)).resolves.toMatchObject({
      status: "blocked",
      category: "identity",
    });
    expect(backendCalled).toBe(1);
  });

  it.each(["settlement backend", "identity observer"] as const)(
    "requires the injected %s before spawning",
    (missing) => {
      // Catches starting an owned child without the exact observation and settlement capabilities.
      const observedPids: number[] = [];
      expect(() => createClientPortabilitySupervisorSession({
        repositoryRoot,
        supervisorBundle: fixtureBundles.get("connect-hang")!,
        clientKind: "codex",
        forceSettlementTimeoutMs,
        dependencies: {
          observeSupervisorIdentity: missing === "identity observer"
            ? undefined!
            : async (pid) => {
              observedPids.push(pid);
              return { pid, startTime: "1" };
            },
          settlementBackend: missing === "settlement backend"
            ? undefined!
            : createSettlementBackend([]),
        },
      })).toThrow("Client portability supervisor launch is invalid.");
      expect(observedPids).toEqual([]);
    },
  );
});
