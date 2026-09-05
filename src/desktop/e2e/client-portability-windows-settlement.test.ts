import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  SupervisorProcessIdentity,
  SupervisorSettlementInput,
  SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import {
  observeWindowsSupervisorIdentity,
  probeWindowsProcessIdentity,
  registerWindowsHelperLifecycleOwner,
  runBoundedWindowsCommand,
  terminateWindowsProcessIdentity,
  settleWindowsSupervisorProcesses,
  type WindowsIdentityObservationDependencies,
  type WindowsIdentityProbeResult,
  type WindowsProcessRow,
  type WindowsSettlementDependencies,
  type WindowsTerminationResult,
} from "./client-portability-windows-settlement.js";

interface FakeCommandChild extends EventEmitter {
  readonly pid?: number;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  kill(): boolean;
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

const root = Object.freeze({ pid: 41, startTime: "100" });
const row = (
  pid: number,
  startTime: string,
  parentPid: number,
): WindowsProcessRow => ({ pid, startTime, parentPid });

const settlementInput = (
  options: {
    readonly roots?: readonly SupervisorProcessIdentity[];
    readonly retainedIdentities?: readonly SupervisorProcessIdentity[];
    readonly rootIdentity?: Promise<SupervisorProcessIdentity>;
    readonly childExitAndClose?: Promise<void>;
    readonly finalRetainedIdentities?: Promise<readonly SupervisorProcessIdentity[]>;
    readonly childPid?: number;
    readonly timeoutMs?: number;
    readonly jobObjectOwned?: boolean;
  } = {},
): SupervisorSettlementInput => Object.freeze({
  child: Object.freeze({ pid: options.childPid ?? root.pid }),
  roots: options.roots ?? [root],
  retainedIdentities: options.retainedIdentities ?? [],
  rootIdentity: options.rootIdentity ?? Promise.resolve(root),
  childExitAndClose: options.childExitAndClose ?? Promise.resolve(),
  finalRetainedIdentities: options.finalRetainedIdentities ?? Promise.resolve(
    options.retainedIdentities ?? [],
  ),
  deadline: Date.now() + (options.timeoutMs ?? 1_000),
  pendingRequestCount: 0,
  jobObjectOwned: options.jobObjectOwned ?? true,
});

interface InertFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pids: number[];
  readonly identityObservations: Promise<SupervisorProcessIdentity | undefined>[];
  readonly exitAndClose: Promise<void>;
  readonly sawExitAndClose: () => boolean;
}

let inertFixtureRoot: string | undefined;
let inertSupervisorPath: string | undefined;
const activeInertFixtures = new Set<InertFixture>();

const writeInertFixture = async (): Promise<void> => {
  inertFixtureRoot = await mkdtemp(join(tmpdir(), "intentarc-windows-settlement-"));
  const grandchildPath = join(inertFixtureRoot, "grandchild.mjs");
  const childPath = join(inertFixtureRoot, "child.mjs");
  inertSupervisorPath = join(inertFixtureRoot, "supervisor.mjs");
  await writeFile(grandchildPath, [
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (value) => { if (value.includes('close')) process.exit(0); });",
    "process.stdin.resume();",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), "utf8");
  await writeFile(childPath, [
    "import { spawn } from 'node:child_process';",
    `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });`,
    "grandchild.once('spawn', () => process.stdout.write(`${JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid })}\\n`));",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (value) => { if (value.includes('close')) grandchild.stdin.write('close\\n'); });",
    "process.stdin.resume();",
    "grandchild.once('close', () => process.exit(0));",
  ].join("\n"), "utf8");
  await writeFile(inertSupervisorPath, [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });`,
    "child.stdout.once('data', (chunk) => process.stdout.write(chunk));",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (value) => { if (value.includes('close')) child.stdin.write('close\\n'); });",
    "process.stdin.resume();",
    "child.once('close', () => process.exit(0));",
  ].join("\n"), "utf8");
};

const readFixturePids = (
  child: ChildProcessWithoutNullStreams,
): Promise<readonly number[]> => new Promise((resolvePids, rejectPids) => {
  let buffered = "";
  const timer = setTimeout(() => rejectPids(new Error("Inert fixture did not report PIDs.")), 5_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    clearTimeout(timer);
    try {
      const parsed = JSON.parse(buffered.slice(0, newline)) as {
        readonly childPid: number;
        readonly grandchildPid: number;
      };
      resolvePids([child.pid!, parsed.childPid, parsed.grandchildPid]);
    } catch (error) {
      rejectPids(error);
    }
  });
});

const spawnInertFixture = async (): Promise<InertFixture> => {
  const child = spawn(process.execPath, [inertSupervisorPath!], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sawExit = false;
  let sawClose = false;
  let resolveExitAndClose!: () => void;
  const exitAndClose = new Promise<void>((resolveEvidence) => {
    resolveExitAndClose = resolveEvidence;
  });
  const finish = (): void => {
    if (sawExit && sawClose) resolveExitAndClose();
  };
  child.once("exit", () => {
    sawExit = true;
    finish();
  });
  child.once("close", () => {
    sawClose = true;
    finish();
  });
  const fixture: InertFixture = {
    child,
    pids: child.pid === undefined ? [] : [child.pid],
    identityObservations: child.pid === undefined
      ? []
      : [observeWindowsSupervisorIdentity(child.pid, Date.now() + 10_000)],
    exitAndClose,
    sawExitAndClose: () => sawExit && sawClose,
  };
  activeInertFixtures.add(fixture);
  const reportedPids = await readFixturePids(child);
  fixture.pids.splice(0, fixture.pids.length, ...reportedPids);
  for (const pid of reportedPids.slice(1)) {
    fixture.identityObservations.push(
      observeWindowsSupervisorIdentity(pid, Date.now() + 10_000),
    );
  }
  return fixture;
};

const observeExactIdentities = async (
  pids: readonly number[],
): Promise<readonly SupervisorProcessIdentity[]> => {
  const deadline = Date.now() + 10_000;
  const identities = await Promise.all(pids.map((pid) =>
    observeWindowsSupervisorIdentity(pid, deadline)
  ));
  expect(identities).not.toContain(undefined);
  return identities as readonly SupervisorProcessIdentity[];
};

const expectExactAbsence = async (pids: readonly number[]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  await expect(Promise.all(pids.map((pid) =>
    observeWindowsSupervisorIdentity(pid, deadline)
  ))).resolves.toEqual(pids.map(() => undefined));
};

const isExactOriginalAbsence = (status: WindowsIdentityProbeResult["status"]): boolean =>
  status === "absent" || status === "identity_mismatch";

const provesFailClosedIdentityReplacement = (
  result: SupervisorSettlementResult,
  probes: readonly WindowsIdentityProbeResult[],
): boolean => result.status === "blocked"
  && result.category === "identity"
  && probes.every(({ status }) => status === "present" || isExactOriginalAbsence(status))
  && probes.some(({ status }) => isExactOriginalAbsence(status));

const provesEveryOriginalAbsent = (
  probes: readonly WindowsIdentityProbeResult[],
): boolean => probes.every(({ status }) => isExactOriginalAbsence(status));

const cleanupTrackedInertFixtures = async (): Promise<void> => {
  for (const fixture of activeInertFixtures) {
    if (!fixture.sawExitAndClose()) {
      try {
        fixture.child.stdin.end();
      } catch {
        // Exact handle-bound settlement below remains the only forced cleanup.
      }
      await Promise.race([
        fixture.exitAndClose,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 250)),
      ]);
    }
    const identities = (await Promise.all(fixture.identityObservations))
      .filter((identity): identity is SupervisorProcessIdentity => identity !== undefined);
    const rootIdentity = identities.find((identity) => identity.pid === fixture.pids[0]);
    if (rootIdentity !== undefined) {
      const retained = identities.filter((identity) => identity.pid !== rootIdentity.pid);
      await settleWindowsSupervisorProcesses(settlementInput({
        childPid: rootIdentity.pid,
        roots: [rootIdentity],
        retainedIdentities: retained,
        finalRetainedIdentities: Promise.resolve(retained),
        rootIdentity: Promise.resolve(rootIdentity),
        childExitAndClose: fixture.exitAndClose,
        timeoutMs: 10_000,
      }));
    }
    await Promise.race([
      fixture.exitAndClose,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
    ]);
  }
  activeInertFixtures.clear();
};

describe.skipIf(process.platform !== "win32")(
  "real inert Windows trees (skipped off Windows: requires System32 CIM and handle termination)",
  () => {
    beforeAll(writeInertFixture);
    afterEach(cleanupTrackedInertFixtures);
    afterAll(async () => {
      if (inertFixtureRoot !== undefined) {
        await rm(inertFixtureRoot, { recursive: true, force: true });
      }
    });

    it("refuses a creation-time mismatch inside the handle-bound termination helper", async () => {
      // Catches validating outside the helper and redirecting termination after numeric PID reuse.
      const target = spawn(process.execPath, [
        "-e",
        "setTimeout(() => process.exit(0), 15000); setInterval(() => undefined, 1000)",
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let sawExit = false;
      let sawClose = false;
      let resolveExitAndClose!: () => void;
      const exitAndClose = new Promise<void>((resolveEvidence) => {
        resolveExitAndClose = resolveEvidence;
      });
      const finish = (): void => {
        if (sawExit && sawClose) resolveExitAndClose();
      };
      target.once("exit", () => {
        sawExit = true;
        finish();
      });
      target.once("close", () => {
        sawClose = true;
        finish();
      });
      const identityPromise = observeWindowsSupervisorIdentity(target.pid!, Date.now() + 10_000);
      const identity = await identityPromise;
      expect(identity).toBeDefined();
      try {
        const mismatch = await terminateWindowsProcessIdentity({
          pid: identity!.pid,
          startTime: `${BigInt(identity!.startTime) + 1n}`,
        }, Date.now() + 10_000);

        expect(mismatch).toEqual({ status: "identity_mismatch" });
        await expect(observeWindowsSupervisorIdentity(
          identity!.pid,
          Date.now() + 5_000,
        )).resolves.toEqual(identity);

        await expect(terminateWindowsProcessIdentity(
          identity!,
          Date.now() + 10_000,
        )).resolves.toEqual({ status: "terminated" });
        await expect(exitAndClose).resolves.toBeUndefined();
        await expectExactAbsence([identity!.pid]);
      } finally {
        if (!sawExit && identity !== undefined) {
          await terminateWindowsProcessIdentity(identity, Date.now() + 10_000);
          await Promise.race([
            exitAndClose,
            new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
          ]);
        }
      }
    }, 30_000);

    it("proves live, reused, and terminated states inside the handle-bound absence probe", async () => {
      // Catches using CIM omission or a PID-only query as exact final retained-identity proof.
      const target = spawn(process.execPath, [
        "-e",
        "setInterval(() => undefined, 1000)",
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let sawExit = false;
      let sawClose = false;
      let resolveExitAndClose!: () => void;
      const exitAndClose = new Promise<void>((resolveEvidence) => {
        resolveExitAndClose = resolveEvidence;
      });
      const finish = (): void => {
        if (sawExit && sawClose) resolveExitAndClose();
      };
      target.once("exit", () => {
        sawExit = true;
        finish();
      });
      target.once("close", () => {
        sawClose = true;
        finish();
      });
      const identity = await observeWindowsSupervisorIdentity(
        target.pid!,
        Date.now() + 10_000,
      );
      expect(identity).toBeDefined();

      try {
        await expect(probeWindowsProcessIdentity(
          identity!,
          Date.now() + 10_000,
        )).resolves.toEqual({ status: "present" });
        await expect(probeWindowsProcessIdentity({
          pid: identity!.pid,
          startTime: `${BigInt(identity!.startTime) + 1n}`,
        }, Date.now() + 10_000)).resolves.toEqual({ status: "identity_mismatch" });
        await expect(observeWindowsSupervisorIdentity(
          identity!.pid,
          Date.now() + 10_000,
        )).resolves.toEqual(identity);

        await expect(terminateWindowsProcessIdentity(
          identity!,
          Date.now() + 10_000,
        )).resolves.toEqual({ status: "terminated" });
        await expect(exitAndClose).resolves.toBeUndefined();
        await expect(probeWindowsProcessIdentity(
          identity!,
          Date.now() + 10_000,
        )).resolves.toEqual({ status: "absent" });
      } finally {
        if (!sawExit && identity !== undefined) {
          await terminateWindowsProcessIdentity(identity, Date.now() + 10_000);
          await Promise.race([
            exitAndClose,
            new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
          ]);
        }
      }
    }, 30_000);

    it("ignores mutable environment aliases when resolving the OS System32 boundary", async () => {
      // Catches spawning an attacker-controlled fake SystemRoot PowerShell as an observation helper.
      const fakeRoot = await mkdtemp(join(tmpdir(), "intentarc-fake-system-root-"));
      const fakePowerShell = join(
        fakeRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      await mkdir(join(fakeRoot, "System32", "WindowsPowerShell", "v1.0"), {
        recursive: true,
      });
      await writeFile(fakePowerShell, "not an executable", "utf8");
      const originalSystemRoot = process.env.SystemRoot;
      const originalWindir = process.env.WINDIR;
      process.env.SystemRoot = fakeRoot;
      process.env.WINDIR = fakeRoot;

      try {
        await expect(observeWindowsSupervisorIdentity(
          process.pid,
          Date.now() + 10_000,
        )).resolves.toMatchObject({ pid: process.pid, startTime: expect.any(String) });
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        if (originalWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = originalWindir;
        await rm(fakeRoot, { recursive: true, force: true });
      }
    }, 20_000);

    it("registers an inert fixture for exact cleanup synchronously at spawn", async () => {
      // Catches async PID reporting failing before the root child and original identity observation are tracked.
      const spawning = spawnInertFixture();

      expect(activeInertFixtures.size).toBe(1);
      const fixture = await spawning;
      fixture.child.stdin.write("close\n");
      await fixture.exitAndClose;
      await expectExactAbsence(fixture.pids);
      activeInertFixtures.delete(fixture);
    }, 20_000);

    it("cleans exact descendants even after the fixture root handle closed", async () => {
      // Catches cleanup treating root exit+close as proof that its separately retained descendants exited.
      const fixture = await spawnInertFixture();
      const detached = spawn(process.execPath, [
        "-e",
        "setInterval(() => undefined, 1000)",
      ], {
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const detachedExitAndClose = new Promise<void>((resolveEvidence) => {
        let sawExit = false;
        let sawClose = false;
        const finish = (): void => {
          if (sawExit && sawClose) resolveEvidence();
        };
        detached.once("exit", () => { sawExit = true; finish(); });
        detached.once("close", () => { sawClose = true; finish(); });
      });
      fixture.pids.push(detached.pid!);
      fixture.identityObservations.push(observeWindowsSupervisorIdentity(
        detached.pid!,
        Date.now() + 10_000,
      ));
      const identities = await Promise.all(fixture.identityObservations);
      expect(identities).not.toContain(undefined);
      const exactIdentities = identities as readonly SupervisorProcessIdentity[];

      try {
        await expect(terminateWindowsProcessIdentity(
          exactIdentities[0]!,
          Date.now() + 10_000,
        )).resolves.toEqual({ status: "terminated" });
        await expect(fixture.exitAndClose).resolves.toBeUndefined();

        await cleanupTrackedInertFixtures();

        await expectExactAbsence(fixture.pids);
      } finally {
        for (const identity of exactIdentities) {
          await terminateWindowsProcessIdentity(identity, Date.now() + 10_000);
        }
        await Promise.race([
          detachedExitAndClose,
          new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ]);
      }
    }, 30_000);

    it("proves a gracefully closed supervisor, child, and grandchild absent without open handles", async () => {
      // Catches requiring a termination receipt after all exact identities exited gracefully.
      const fixture = await spawnInertFixture();
      const identities = await observeExactIdentities(fixture.pids);

      fixture.child.stdin.write("close\n");
      await fixture.exitAndClose;
      const result = await settleWindowsSupervisorProcesses(settlementInput({
        childPid: fixture.child.pid!,
        roots: [identities[0]!],
        retainedIdentities: identities.slice(1),
        rootIdentity: Promise.resolve(identities[0]!),
        childExitAndClose: fixture.exitAndClose,
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "settled", category: "none" });
      expect(fixture.sawExitAndClose()).toBe(true);
      expect(fixture.child.stdin.destroyed).toBe(true);
      expect(fixture.child.stdout.destroyed).toBe(true);
      expect(fixture.child.stderr.destroyed).toBe(true);
      const postSettlementProbes = await Promise.all(identities.map((identity) =>
        probeWindowsProcessIdentity(identity, Date.now() + 10_000)
      ));
      expect(provesEveryOriginalAbsent(postSettlementProbes)).toBe(true);
      activeInertFixtures.delete(fixture);
    }, 30_000);

    it("forces an exact supervisor tree and retains every discovered descendant", async () => {
      // Catches trusting root termination without preserving and post-checking child identities.
      const fixture = await spawnInertFixture();
      const identities = await observeExactIdentities(fixture.pids);

      const result = await settleWindowsSupervisorProcesses(settlementInput({
        childPid: fixture.child.pid!,
        roots: [identities[0]!],
        rootIdentity: Promise.resolve(identities[0]!),
        childExitAndClose: fixture.exitAndClose,
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "settled", category: "none" });
      expect(result.retained).toEqual(expect.arrayContaining([...identities]));
      await expect(fixture.exitAndClose).resolves.toBeUndefined();
      expect(fixture.sawExitAndClose()).toBe(true);
      expect(fixture.child.stdin.destroyed).toBe(true);
      expect(fixture.child.stdout.destroyed).toBe(true);
      expect(fixture.child.stderr.destroyed).toBe(true);
      await expectExactAbsence(fixture.pids);
      activeInertFixtures.delete(fixture);
    }, 30_000);

    it("settles, or fails closed on exact identity replacement, while cleaning a detached process and supervisor tree", async () => {
      // Catches assuming root /t coverage includes a retained process outside the current parent graph,
      // while allowing the production boundary to refuse a replacement PID without terminating it.
      const fixture = await spawnInertFixture();
      const treeIdentities = await observeExactIdentities(fixture.pids);
      const detached = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let detachedExited = false;
      let detachedClosed = false;
      let resolveDetachedExitAndClose!: () => void;
      const detachedExitAndClose = new Promise<void>((resolveEvidence) => {
        resolveDetachedExitAndClose = resolveEvidence;
      });
      const finishDetached = (): void => {
        if (detachedExited && detachedClosed) resolveDetachedExitAndClose();
      };
      detached.once("exit", () => {
        detachedExited = true;
        finishDetached();
      });
      detached.once("close", () => {
        detachedClosed = true;
        finishDetached();
      });
      const detachedIdentityObservation = observeWindowsSupervisorIdentity(
        detached.pid!,
        Date.now() + 10_000,
      );
      const detachedFixture: InertFixture = {
        child: detached,
        pids: [detached.pid!],
        identityObservations: [detachedIdentityObservation],
        exitAndClose: detachedExitAndClose,
        sawExitAndClose: () => detachedExited && detachedClosed,
      };
      activeInertFixtures.add(detachedFixture);
      const detachedIdentity = await detachedIdentityObservation;
      expect(detachedIdentity).toBeDefined();
      const originalIdentities = [...treeIdentities, detachedIdentity!] as const;

      const input = settlementInput({
        childPid: fixture.child.pid!,
        roots: [treeIdentities[0]!],
        retainedIdentities: [detachedIdentity!, ...treeIdentities.slice(1)],
        rootIdentity: Promise.resolve(treeIdentities[0]!),
        childExitAndClose: fixture.exitAndClose,
        timeoutMs: 15_000,
      });
      expect(input.retainedIdentities).toContainEqual(detachedIdentity!);
      const result = await settleWindowsSupervisorProcesses(input);

      if (result.status === "settled") {
        expect(result).toMatchObject({ status: "settled", category: "none" });
        expect(result.retained).toContainEqual(detachedIdentity!);
      } else {
        const preCleanupProbes = await Promise.all(originalIdentities.map((identity) =>
          probeWindowsProcessIdentity(identity, Date.now() + 10_000)
        ));
        expect(provesFailClosedIdentityReplacement(result, preCleanupProbes)).toBe(true);
        await cleanupTrackedInertFixtures();
      }

      await expect(detachedExitAndClose).resolves.toBeUndefined();
      expect(detachedClosed).toBe(true);
      expect(fixture.sawExitAndClose()).toBe(true);
      expect(fixture.child.stdin.destroyed).toBe(true);
      expect(fixture.child.stdout.destroyed).toBe(true);
      expect(fixture.child.stderr.destroyed).toBe(true);
      expect(detached.stdin.destroyed).toBe(true);
      expect(detached.stdout.destroyed).toBe(true);
      expect(detached.stderr.destroyed).toBe(true);
      const postCleanupProbes = await Promise.all(originalIdentities.map((identity) =>
        probeWindowsProcessIdentity(identity, Date.now() + 10_000)
      ));
      expect(provesEveryOriginalAbsent(postCleanupProbes)).toBe(true);
      activeInertFixtures.delete(fixture);
      activeInertFixtures.delete(detachedFixture);
    }, 30_000);
  },
);

it.skipIf(process.platform === "win32")(
  "records the explicit off-Windows reason for skipping real inert tree termination",
  () => {
    expect(process.platform).not.toBe("win32");
  },
);

const graphHarness = (
  snapshots: readonly (readonly WindowsProcessRow[])[],
  options: {
    readonly terminate?: (pid: number, deadline: number) => Promise<boolean>;
    readonly probe?: (
      identity: SupervisorProcessIdentity,
      deadline: number,
    ) => Promise<WindowsIdentityProbeResult>;
    readonly platform?: NodeJS.Platform;
    readonly pollIntervalMs?: number;
    readonly onObserve?: (count: number) => void;
  } = {},
): {
  readonly dependencies: WindowsSettlementDependencies;
  readonly terminatedPids: number[];
  readonly probedIdentities: SupervisorProcessIdentity[];
  readonly observationCount: () => number;
} => {
  let observationIndex = 0;
  const terminatedPids: number[] = [];
  const probedIdentities: SupervisorProcessIdentity[] = [];
  return {
    dependencies: {
      platform: options.platform ?? "win32",
      pollIntervalMs: options.pollIntervalMs ?? 1,
      observeProcessTree: async () => {
        const snapshot = snapshots[Math.min(observationIndex, snapshots.length - 1)] ?? [];
        observationIndex += 1;
        options.onObserve?.(observationIndex);
        return snapshot;
      },
      terminateProcessTree: async (identity, deadline) => {
        terminatedPids.push(identity.pid);
        const terminated = await (options.terminate?.(identity.pid, deadline) ?? true);
        return {
          status: terminated ? "terminated" : "failed",
        } satisfies WindowsTerminationResult;
      },
      probeProcessIdentity: async (identity, deadline) => {
        probedIdentities.push(identity);
        return options.probe?.(identity, deadline) ?? { status: "absent" };
      },
    },
    terminatedPids,
    probedIdentities,
    observationCount: () => observationIndex,
  };
};

describe("bounded Windows helper ownership", () => {
  it("settles an async spawn failure after close when no helper process existed", async () => {
    // Catches requiring an impossible exit event after ChildProcess reports ENOENT before creating a PID.
    let sawClose = false;
    const child = new EventEmitter() as FakeCommandChild;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
    });
    const running = runBoundedWindowsCommand(
      "C:\\Windows\\System32\\missing-helper.exe",
      [],
      Date.now() + 1_000,
      1_024,
      {
        spawnCommand: () => child,
        cleanupReserveMs: 20,
      },
    );
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    setTimeout(() => {
      sawClose = true;
      child.emit("close", -1);
    }, 5);

    await expect(running).rejects.toThrow("Windows helper failed.");
    expect(sawClose).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it.each(["deadline", "output cap"] as const)(
    "waits for helper exit and close and destroys pipes after %s failure",
    async (failure) => {
      // Catches returning a blocked settlement while a killed PowerShell helper or pipe still outlives it.
      let sawExit = false;
      let sawClose = false;
      let killed = false;
      const child = new EventEmitter() as FakeCommandChild;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          killed = true;
          setTimeout(() => {
            sawExit = true;
            child.emit("exit", null, "SIGTERM");
            sawClose = true;
            child.emit("close", null, "SIGTERM");
          }, 5);
          return true;
        },
      });
      const running = runBoundedWindowsCommand(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile"],
        Date.now() + (failure === "deadline" ? 40 : 1_000),
        failure === "output cap" ? 4 : 1_024,
        {
          spawnCommand: () => child,
          cleanupReserveMs: 20,
        },
      );
      if (failure === "output cap") child.stdout.write(Buffer.alloc(5));

      await expect(running).rejects.toThrow("Windows helper failed.");
      expect(killed).toBe(true);
      expect(sawExit).toBe(true);
      expect(sawClose).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    },
  );

  it("waits for exit and close before the hard deadline after a failed kill", async () => {
    // Catches settling on kill or exit alone without relying on host timer latency.
    vi.useFakeTimers({ now: 1_000 });
    try {
      let sawExit = false;
      let sawClose = false;
      let killCalls = 0;
      let completions = 0;
      const child = new EventEmitter() as FakeCommandChild;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          killCalls += 1;
          setTimeout(() => {
            sawExit = true;
            child.emit("exit", null, "SIGTERM");
          }, 5);
          setTimeout(() => {
            sawClose = true;
            child.emit("close", null, "SIGTERM");
          }, 8);
          return false;
        },
      });
      const running = runBoundedWindowsCommand(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile"],
        Date.now() + 40,
        1_024,
        {
          spawnCommand: () => child,
          cleanupReserveMs: 20,
        },
      ).then(
        () => {
          completions += 1;
          return "resolved" as const;
        },
        () => {
          completions += 1;
          return "rejected" as const;
        },
      );

      await vi.advanceTimersByTimeAsync(19);
      expect(killCalls).toBe(0);
      expect(completions).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(killCalls).toBe(1);
      expect(completions).toBe(0);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      await vi.advanceTimersByTimeAsync(5);
      expect(sawExit).toBe(true);
      expect(sawClose).toBe(false);
      expect(completions).toBe(0);

      await vi.advanceTimersByTimeAsync(3);
      await expect(running).resolves.toBe("rejected");
      expect(sawClose).toBe(true);
      expect(completions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(12);
      expect(completions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-completes after the cleanup bound when kill yields no lifecycle events", async () => {
    // Catches a failed helper kill leaving every public settlement waiter pending forever.
    vi.useFakeTimers({ now: 2_000 });
    try {
      let killCalls = 0;
      let completions = 0;
      const child = new EventEmitter() as FakeCommandChild;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          killCalls += 1;
          return false;
        },
      });
      const outcome = runBoundedWindowsCommand(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile"],
        Date.now() + 40,
        1_024,
        { spawnCommand: () => child, cleanupReserveMs: 20 },
      ).then(
        () => {
          completions += 1;
          return "resolved" as const;
        },
        () => {
          completions += 1;
          return "rejected" as const;
        },
      );

      await vi.advanceTimersByTimeAsync(19);
      expect(killCalls).toBe(0);
      expect(completions).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(killCalls).toBe(1);
      expect(completions).toBe(0);

      await vi.advanceTimersByTimeAsync(19);
      expect(completions).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe("rejected");
      expect(completions).toBe(1);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns a late child error after hard completion without mutating the result", async () => {
    // Catches detaching the sole EventEmitter error listener while the bounded child can still emit.
    const child = new EventEmitter() as FakeCommandChild;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
    });
    let completions = 0;
    const running = runBoundedWindowsCommand(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile"],
      Date.now() + 40,
      1_024,
      { spawnCommand: () => child, cleanupReserveMs: 20 },
    ).then(
      (value) => {
        completions += 1;
        return value;
      },
      (error: unknown) => {
        completions += 1;
        throw error;
      },
    );

    await expect(running).rejects.toThrow("Windows helper failed.");
    expect(completions).toBe(1);
    expect(() => child.emit("error", new Error("late helper error"))).not.toThrow();
    await Promise.resolve();
    expect(completions).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
});

describe("production identity snapshot validation", () => {
  it("does not abandon lifecycle-owned observation cleanup at the operation deadline", async () => {
    // Catches an outer deadline race returning while the owned helper is still closing.
    let helperClosed = false;
    const observed = await observeWindowsSupervisorIdentity(
      root.pid,
      Date.now() + 40,
      registerWindowsHelperLifecycleOwner({
        platform: "win32",
        observeProcessTree: async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 70));
          helperClosed = true;
          return [row(root.pid, root.startTime, 0)];
        },
      } satisfies WindowsIdentityObservationDependencies),
    );

    expect(helperClosed).toBe(true);
    expect(observed).toEqual(root);
  });

  it("does not trust a forged lifecycle-owned observation property", async () => {
    // Catches arbitrary injected observation code disabling the shared deadline with a copied trust bit.
    const observation = observeWindowsSupervisorIdentity(
      root.pid,
      Date.now() + 40,
      {
        platform: "win32",
        helperLifecycleOwned: true,
        observeProcessTree: async () => new Promise<readonly WindowsProcessRow[]>(() => undefined),
      } as WindowsIdentityObservationDependencies & { readonly helperLifecycleOwned: true },
    );

    await expect(Promise.race([
      observation,
      new Promise<"still-pending">((resolveTimeout) => setTimeout(
        () => resolveTimeout("still-pending"),
        250,
      )),
    ])).resolves.toBeUndefined();
  });

  it("rejects a matching identity when any other positive PID row is duplicated", async () => {
    // Catches the production observer selecting one valid row from an otherwise ambiguous CIM snapshot.
    const observed = await observeWindowsSupervisorIdentity(
      process.pid,
      Date.now() + 1_000,
      {
        platform: "win32",
        observeProcessTree: async () => [
          row(process.pid, "100", 0),
          row(99, "200", 0),
          row(99, "200", 0),
        ],
      },
    );

    expect(observed).toBeUndefined();
  });
});

describe("retained-identity Windows settlement", () => {
  it("refuses polling-only settlement when launch-time Job Object ownership is absent", async () => {
    // Catches an exited intermediary hiding a late orphan from every later PID snapshot.
    const harness = graphHarness([
      [row(41, "100", 0), row(100, "150", 41)],
      [row(41, "100", 0), row(100, "150", 41)],
      [row(200, "200", 1)],
      [row(200, "200", 1)],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      jobObjectOwned: false,
    }), harness.dependencies);

    expect(result).toEqual({
      status: "blocked",
      category: "identity",
      retained: [root],
    });
    expect(harness.terminatedPids).toEqual([]);
  });
  it("does not abandon lifecycle-owned termination cleanup at the operation deadline", async () => {
    // Catches settlement returning at the shared deadline before its PowerShell helper closes.
    let helperClosed = false;
    let observations = 0;
    const dependencies = registerWindowsHelperLifecycleOwner({
      platform: "win32",
      pollIntervalMs: 1,
      observeProcessTree: async () => {
        observations += 1;
        return [row(root.pid, root.startTime, 0)];
      },
      terminateProcessTree: async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 70));
        helperClosed = true;
        return { status: "terminated" as const };
      },
      probeProcessIdentity: async () => ({ status: "absent" }),
    } satisfies WindowsSettlementDependencies);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      timeoutMs: 40,
    }), dependencies);

    expect(helperClosed).toBe(true);
    expect(result).toMatchObject({ status: "blocked", category: "termination" });
    expect(observations).toBeGreaterThanOrEqual(2);
  });

  it.each(["immediate concurrent", "later polling"] as const)(
    "joins lifecycle-owned termination cleanup after %s observation failure",
    async (failurePhase) => {
      // Catches an active observation error returning while the exact termination helper still owns a handle.
      const termination = deferred<WindowsTerminationResult>();
      let helperClosed = false;
      let observationCount = 0;
      const dependencies = registerWindowsHelperLifecycleOwner({
        platform: "win32",
        pollIntervalMs: 1,
        observeProcessTree: async () => {
          observationCount += 1;
          if (
            (failurePhase === "immediate concurrent" && observationCount === 3)
            || (failurePhase === "later polling" && observationCount === 4)
          ) throw new Error("active observation failed");
          return [row(root.pid, root.startTime, 0)];
        },
        terminateProcessTree: async () => termination.promise,
        probeProcessIdentity: async () => ({ status: "absent" }),
      } satisfies WindowsSettlementDependencies);
      setTimeout(() => {
        helperClosed = true;
        termination.resolve({ status: "terminated" });
      }, 70);

      const result = await settleWindowsSupervisorProcesses(
        settlementInput({ timeoutMs: 500 }),
        dependencies,
      );
      const closedAtResult = helperClosed;
      await termination.promise;

      expect(result).toEqual({
        status: "blocked",
        category: "observation",
        retained: [root],
      });
      expect(closedAtResult).toBe(true);
      expect(observationCount).toBe(failurePhase === "immediate concurrent" ? 3 : 4);
    },
  );

  it("rejects a root promise identity that does not match the spawned child or seeded root", async () => {
    // Catches adding a second exact root from a mismatched promise and terminating outside child ownership.
    const harness = graphHarness([[row(41, "100", 0), row(42, "200", 0)]]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      rootIdentity: Promise.resolve({ pid: 42, startTime: "200" }),
      childPid: 41,
    }), harness.dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "identity" });
    expect(harness.observationCount()).toBe(0);
    expect(harness.terminatedPids).toEqual([]);
  });

  it("rejects a root promise that does not match the spawned child without a seeded root", async () => {
    // Catches an empty trigger snapshot enrolling the wrong root identity for the retained child handle.
    const harness = graphHarness([[row(42, "200", 0)], [], []]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      roots: [],
      rootIdentity: Promise.resolve({ pid: 42, startTime: "200" }),
      childPid: 41,
    }), harness.dependencies);

    expect(result).toEqual({ status: "blocked", category: "identity", retained: [] });
    expect(harness.observationCount()).toBe(0);
    expect(harness.terminatedPids).toEqual([]);
  });

  it("uses native promise observation when rootIdentity has a forged own then", async () => {
    // Catches a caller rebinding the public identity Promise to enroll and kill an unrelated exact PID.
    const realRootPromise = Promise.resolve(root);
    Object.defineProperty(realRootPromise, "then", {
      configurable: true,
      value: (resolveForged: (identity: SupervisorProcessIdentity) => void) => {
        resolveForged({ pid: 99, startTime: "999" });
      },
    });
    let observations = 0;
    const terminatedPids: number[] = [];
    const dependencies: WindowsSettlementDependencies = {
      platform: "win32",
      pollIntervalMs: 1,
      observeProcessTree: async () => {
        observations += 1;
        if (!terminatedPids.includes(41)) {
          return [row(41, "100", 0), row(99, "999", 0)];
        }
        return terminatedPids.includes(99) ? [] : [row(99, "999", 0)];
      },
      terminateProcessTree: async (identity) => {
        terminatedPids.push(identity.pid);
        return { status: "terminated" };
      },
      probeProcessIdentity: async () => ({ status: "absent" }),
    };

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      rootIdentity: realRootPromise,
    }), dependencies);

    expect(result).toEqual({ status: "settled", category: "none", retained: [root] });
    expect(terminatedPids).toEqual([41]);
  });

  it("uses the already-started root identity when the trigger snapshot had no roots", async () => {
    // Catches treating an empty frozen roots snapshot as permanent identity absence.
    const observedRoot = deferred<SupervisorProcessIdentity>();
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [],
      [],
    ]);
    setTimeout(() => observedRoot.resolve(root), 5);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      roots: [],
      rootIdentity: observedRoot.promise,
    }), harness.dependencies);

    expect(result).toEqual({ status: "settled", category: "none", retained: [root] });
    expect(harness.terminatedPids).toEqual([41]);
  });

  it("bounds unresolved root identity evidence without observing or terminating", async () => {
    // Catches waiting beyond settlement's absolute deadline or falling back to PID-only roots.
    const harness = graphHarness([[]]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      roots: [],
      rootIdentity: new Promise<SupervisorProcessIdentity>(() => undefined),
      timeoutMs: 40,
    }), harness.dependencies);

    expect(result).toEqual({ status: "blocked", category: "identity", retained: [] });
    expect(harness.observationCount()).toBe(0);
    expect(harness.terminatedPids).toEqual([]);
  });

  it("terminates a pre-recorded detached child and proves both identities absent", async () => {
    // Catches rebuilding ownership only from the live root graph and losing an already reported bridge.
    const detached = { pid: 42, startTime: "101" };
    const harness = graphHarness([
      [row(41, "100", 0), row(42, "101", 0)],
      [row(41, "100", 0), row(42, "101", 0)],
      [row(42, "101", 0)],
      [row(42, "101", 0)],
      [row(42, "101", 0)],
      [],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      retainedIdentities: [detached],
    }), harness.dependencies);

    expect(result).toEqual({
      status: "settled",
      category: "none",
      retained: [root, detached],
    });
    expect(harness.terminatedPids).toEqual([41, 42]);
    expect(harness.probedIdentities).toEqual([root, detached]);
  });

  it("incorporates final reported identities and settles a late detached child", async () => {
    // Catches final bridge evidence arriving after initial roots were terminated and being omitted from proof.
    const lateDetached = { pid: 42, startTime: "101" };
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [],
      [row(42, "101", 0)],
      [row(42, "101", 0)],
      [],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      finalRetainedIdentities: Promise.resolve([lateDetached]),
    }), harness.dependencies);

    expect(result).toEqual({
      status: "settled",
      category: "none",
      retained: [root, lateDetached],
    });
    expect(harness.terminatedPids).toEqual([41, 42]);
  });

  it("retains and terminates a child first observed while exact termination is active", async () => {
    // Catches treating the pre-termination snapshot as a closed world.
    const releaseTermination = deferred<boolean>();
    let terminationCalls = 0;
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [row(41, "100", 0), row(42, "101", 41)],
      [row(42, "101", 0)],
      [row(42, "101", 0)],
      [],
      [],
    ], {
      terminate: async () => {
        terminationCalls += 1;
        if (terminationCalls === 1) return releaseTermination.promise;
        return true;
      },
      pollIntervalMs: 5,
      onObserve: (count) => {
        if (count === 3) releaseTermination.resolve(true);
      },
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({
      status: "settled",
      category: "none",
      retained: [root, { pid: 42, startTime: "101" }],
    });
    expect(harness.terminatedPids).toEqual([41, 42]);
  });

  it("takes one immediate active snapshot before a fast termination completion", async () => {
    // Catches letting an already-resolved termination skip the only snapshot that still shows a late child parented.
    let observations = 0;
    let terminationCompleted = false;
    const terminatedPids: number[] = [];
    const events: string[] = [];
    const dependencies: WindowsSettlementDependencies = {
      platform: "win32",
      pollIntervalMs: 1,
      observeProcessTree: async () => {
        observations += 1;
        events.push(`observe:${observations}`);
        if (observations === 2) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
          events.push("observe:2:complete");
        }
        if (observations === 1) return [row(41, "100", 0)];
        if (!terminationCompleted) {
          return [row(41, "100", 0), row(42, "101", 41)];
        }
        return terminatedPids.includes(42) ? [] : [row(42, "101", 0)];
      },
      terminateProcessTree: async (identity) => {
        events.push(`terminate:${identity.pid}`);
        terminatedPids.push(identity.pid);
        queueMicrotask(() => {
          terminationCompleted = true;
        });
        return { status: "terminated" };
      },
      probeProcessIdentity: async () => ({ status: "absent" }),
    };

    const result = await settleWindowsSupervisorProcesses(settlementInput(), dependencies);

    expect(result).toMatchObject({ status: "settled", category: "none" });
    expect(result.retained).toContainEqual({ pid: 42, startTime: "101" });
    expect(terminatedPids).toEqual([41, 42]);
    expect(events.indexOf("observe:2:complete")).toBeLessThan(events.indexOf("terminate:41"));
  });

  it("does not terminate a replacement when identity changes inside the termination seam", async () => {
    // Catches a numeric PID-only dependency killing a replacement created after the outer snapshot.
    const replacement = { pid: 41, startTime: "999" };
    const terminated: SupervisorProcessIdentity[] = [];
    const dependencies: WindowsSettlementDependencies = {
      platform: "win32",
      pollIntervalMs: 1,
      observeProcessTree: async () => [row(41, "100", 0)],
      terminateProcessTree: async (recorded) => {
        if (recorded.startTime !== replacement.startTime) {
          return { status: "identity_mismatch" };
        }
        terminated.push(replacement);
        return { status: "terminated" };
      },
      probeProcessIdentity: async () => ({ status: "absent" }),
    };

    const result = await settleWindowsSupervisorProcesses(settlementInput(), dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "identity" });
    expect(terminated).toEqual([]);
  });

  it("keeps a discovered child after it is reparented", async () => {
    // Catches dropping descendants whose current parent no longer appears in the retained graph.
    const releaseTermination = deferred<boolean>();
    let terminationCalls = 0;
    const harness = graphHarness([
      [row(41, "100", 0), row(42, "101", 41)],
      [row(41, "100", 0), row(42, "101", 0)],
      [row(41, "100", 0), row(42, "101", 0)],
      [row(42, "101", 0)],
      [row(42, "101", 0)],
      [],
      [],
    ], {
      terminate: async () => {
        terminationCalls += 1;
        if (terminationCalls === 1) return releaseTermination.promise;
        return true;
      },
      pollIntervalMs: 5,
      onObserve: (count) => {
        if (count === 3) releaseTermination.resolve(true);
      },
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "settled", category: "none" });
    expect(result.retained).toContainEqual({ pid: 42, startTime: "101" });
    expect(harness.terminatedPids).toEqual([41, 42]);
  });

  it("discovers an out-of-order descendant chain to a fixed point", async () => {
    // Catches a single forward scan missing a grandchild listed before its parent.
    const harness = graphHarness([
      [
        row(43, "102", 42),
        row(41, "100", 0),
        row(42, "101", 41),
      ],
      [
        row(43, "102", 42),
        row(41, "100", 0),
        row(42, "101", 41),
      ],
      [],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({
      status: "settled",
      category: "none",
      retained: [
        root,
        { pid: 42, startTime: "101" },
        { pid: 43, startTime: "102" },
      ],
    });
    expect(harness.terminatedPids).toEqual([41]);
  });

  it("blocks new lineage through a recorded parent absent from the same snapshot", async () => {
    // Catches stale PPID reuse enrolling and killing a child of a later unrelated process.
    const harness = graphHarness([[
      row(42, "101", 41),
    ]]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "blocked", category: "observation" });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks duplicate positive PID rows before termination", async () => {
    // Catches accepting an ambiguous CIM snapshot whose row order chooses an identity.
    const harness = graphHarness([[
      row(41, "100", 0),
      row(41, "100", 0),
    ]]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "blocked", category: "observation" });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks a malformed non-row entry instead of silently omitting it", async () => {
    // Catches treating malformed CIM payload members as absent processes.
    const harness = graphHarness([[
      row(41, "100", 0),
      null as unknown as WindowsProcessRow,
    ]]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "blocked", category: "observation" });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks retained PID reuse before any terminate call", async () => {
    // Catches replacing the recorded child 42/101 with the current PID 42/999 and killing a stranger.
    const harness = graphHarness([[
      row(41, "100", 0),
      row(42, "999", 41),
    ]]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      retainedIdentities: [{ pid: 42, startTime: "101" }],
    }), harness.dependencies);

    expect(result).toEqual({
      status: "blocked",
      category: "identity",
      retained: [root, { pid: 42, startTime: "101" }],
    });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks a 4,097-row observation before termination", async () => {
    // Catches an unbounded CIM result exhausting settlement memory or scan time.
    const oversized = Array.from({ length: 4_097 }, (_, index) =>
      row(index + 1, `${index + 1}`, 0)
    );
    oversized[40] = row(41, "100", 0);
    const harness = graphHarness([oversized]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "blocked", category: "observation" });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks 257 retained identities before observation or termination", async () => {
    // Catches allowing bridge evidence to grow beyond the retained-identity bound.
    const retained = Array.from({ length: 257 }, (_, index) => ({
      pid: index + 100,
      startTime: `${index + 1}`,
    }));
    const harness = graphHarness([[]]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      retainedIdentities: retained,
    }), harness.dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "identity" });
    expect(harness.observationCount()).toBe(0);
    expect(harness.terminatedPids).toEqual([]);
  });

  it("blocks 257 final retained identities before enrolling them", async () => {
    // Catches the late immutable evidence channel bypassing the retained-identity cap.
    const finalRetained = Array.from({ length: 257 }, (_, index) => ({
      pid: index + 100,
      startTime: `${index + 1}`,
    }));
    const harness = graphHarness([[], []]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      finalRetainedIdentities: Promise.resolve(finalRetained),
    }), harness.dependencies);

    expect(result).toEqual({ status: "blocked", category: "identity", retained: [root] });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("keeps the aggregate retained set capped across trigger and final evidence", async () => {
    // Catches separately capped trigger/final arrays combining into more than 256 retained identities.
    const initiallyRetained = { pid: 90, startTime: "90" };
    const finalRetained = Array.from({ length: 256 }, (_, index) => ({
      pid: index + 100,
      startTime: `${index + 1}`,
    }));
    const harness = graphHarness([
      [row(41, "100", 0), row(90, "90", 0)],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      retainedIdentities: [initiallyRetained],
      finalRetainedIdentities: Promise.resolve(finalRetained),
    }), harness.dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "identity" });
    expect(result.retained).toHaveLength(2);
    expect(result.retained).toEqual([root, initiallyRetained]);
  });

  it("bounds an exact termination call that never settles", async () => {
    // Catches waiting past the shared absolute deadline for exact termination status.
    const harness = graphHarness([[row(41, "100", 0)]], {
      terminate: async () => new Promise<boolean>(() => undefined),
      pollIntervalMs: 5,
    });
    const startedAt = Date.now();

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      timeoutMs: 60,
    }), harness.dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "termination" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.terminatedPids).toEqual([41]);
  });

  it("categorizes an active observation that consumes the deadline as termination", async () => {
    // Catches returning observation uncertainty after an in-flight termination owns the shared deadline.
    let observations = 0;
    const dependencies: WindowsSettlementDependencies = {
      platform: "win32",
      pollIntervalMs: 1,
      observeProcessTree: async () => {
        observations += 1;
        if (observations <= 2) return [row(41, "100", 0)];
        return new Promise<readonly WindowsProcessRow[]>(() => undefined);
      },
      terminateProcessTree: async () => new Promise<WindowsTerminationResult>(() => undefined),
      probeProcessIdentity: async () => ({ status: "absent" }),
    };

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      timeoutMs: 60,
    }), dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "termination" });
  });

  it("blocks partial termination even when exact termination was started", async () => {
    // Catches treating a non-success exact termination completion as proof.
    const harness = graphHarness([[row(41, "100", 0)]], {
      terminate: async () => false,
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "blocked", category: "termination" });
    expect(harness.terminatedPids).toEqual([41]);
  });

  it("retains a new detached child observed during termination", async () => {
    // Catches retaining only descendants that remain parented when termination completes.
    const releaseTermination = deferred<boolean>();
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [row(41, "100", 0), row(44, "104", 41)],
      [row(44, "104", 0)],
      [row(44, "104", 0)],
      [],
      [],
    ], {
      terminate: async (pid) => pid === 41 ? releaseTermination.promise : true,
      pollIntervalMs: 5,
      onObserve: (count) => {
        if (count === 3) releaseTermination.resolve(true);
      },
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result.retained).toContainEqual({ pid: 44, startTime: "104" });
    expect(result).toMatchObject({ status: "settled", category: "none" });
    expect(harness.terminatedPids).toEqual([41, 44]);
  });

  it("blocks when a retained identity survives the fresh final observation", async () => {
    // Catches using helper exit status or a stale absence snapshot as final proof.
    const harness = graphHarness([
      [row(41, "100", 0)],
      [],
      [row(41, "100", 0)],
    ]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({
      status: "blocked",
      category: "termination",
      retained: [root],
    });
  });

  it("blocks multiple CIM omissions when the exact retained identity is still present", async () => {
    // Catches any fixed number of incomplete CIM snapshots being accepted as exact process absence.
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [],
      [],
      [],
      [],
    ], {
      probe: async () => ({ status: "present" }),
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({
      status: "blocked",
      category: "termination",
      retained: [root],
    });
    expect(harness.probedIdentities).toEqual([root]);
  });

  it.each([
    ["absent", { status: "settled", category: "none" }],
    ["identity_mismatch", { status: "settled", category: "none" }],
    ["unavailable", { status: "blocked", category: "observation" }],
    ["failed", { status: "blocked", category: "observation" }],
  ] as const)(
    "handles exact absence probe status %s without broadening termination",
    async (probeStatus, expected) => {
      // Catches treating PID reuse or exact-observation uncertainty as a live original or proven absence.
      const harness = graphHarness([[], [], [], []], {
        probe: async () => ({ status: probeStatus }),
      });

      const result = await settleWindowsSupervisorProcesses(
        settlementInput(),
        harness.dependencies,
      );

      expect(result).toMatchObject(expected);
      expect(harness.probedIdentities).toEqual([root]);
      expect(harness.terminatedPids).toEqual([]);
    },
  );

  it("counts a PID reused at final proof as the original exact identity absent", async () => {
    // Catches final CIM validation blocking or enrolling a replacement instead of deferring to the handle probe.
    const harness = graphHarness([
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [row(41, "100", 0)],
      [],
      [],
      [row(41, "999", 0)],
    ], {
      probe: async () => ({ status: "identity_mismatch" }),
    });

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({ status: "settled", category: "none", retained: [root] });
    expect(harness.probedIdentities).toEqual([root]);
    expect(harness.terminatedPids).toEqual([41]);
  });

  it.each(["malformed", "rejected"] as const)(
    "fails closed when exact absence probe evidence is %s",
    async (failure) => {
      // Catches malformed or rejected probe evidence being silently converted to absence.
      const harness = graphHarness([[], [], [], []], {
        probe: failure === "rejected"
          ? async () => { throw new Error("probe failed"); }
          : async () => undefined as never,
      });

      const result = await settleWindowsSupervisorProcesses(
        settlementInput(),
        harness.dependencies,
      );

      expect(result).toEqual({
        status: "blocked",
        category: "observation",
        retained: [root],
      });
    },
  );

  it("bounds an unregistered exact absence probe that never settles", async () => {
    // Catches arbitrary injected probe code inheriting unbounded production helper ownership.
    const harness = graphHarness([[], [], [], []], {
      probe: async () => new Promise(() => undefined),
    });
    const startedAt = Date.now();

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      timeoutMs: 60,
    }), harness.dependencies);

    expect(result).toEqual({
      status: "blocked",
      category: "observation",
      retained: [root],
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.each([
    ["before deadline", 500, { status: "settled", category: "none" }],
    ["after deadline", 40, { status: "blocked", category: "observation" }],
  ] as const)(
    "joins a lifecycle-owned exact absence probe that closes %s",
    async (_phase, timeoutMs, expected) => {
      // Catches abandoning the production probe helper or trusting exact evidence after its deadline.
      const probe = deferred<WindowsIdentityProbeResult>();
      let helperClosed = false;
      const harness = graphHarness([[], [], [], []], {
        probe: async () => probe.promise,
      });
      const dependencies = registerWindowsHelperLifecycleOwner(harness.dependencies);
      setTimeout(() => {
        helperClosed = true;
        probe.resolve({ status: "absent" });
      }, 70);

      const result = await settleWindowsSupervisorProcesses(
        settlementInput({ timeoutMs }),
        dependencies,
      );
      const closedAtResult = helperClosed;

      expect(result).toMatchObject(expected);
      expect(closedAtResult).toBe(true);
    },
  );

  it("requires child exit and close even after snapshots prove absence", async () => {
    // Catches treating process absence as equivalent to the parent's exact child-handle evidence.
    const missingClose = new Promise<void>(() => undefined);
    const harness = graphHarness([
      [row(41, "100", 0)],
      [],
    ]);

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      childExitAndClose: missingClose,
      timeoutMs: 60,
    }), harness.dependencies);

    expect(result).toMatchObject({ status: "blocked", category: "child_handle" });
  });

  it("settles a gracefully exited exact tree without invoking termination", async () => {
    // Catches requiring helper status when fresh observations prove every retained identity absent.
    const harness = graphHarness([[], []]);

    const result = await settleWindowsSupervisorProcesses(
      settlementInput(),
      harness.dependencies,
    );

    expect(result).toEqual({ status: "settled", category: "none", retained: [root] });
    expect(harness.terminatedPids).toEqual([]);
  });

  it("returns unsupported off Windows without awaiting evidence or touching process boundaries", async () => {
    // Catches platform fallback starting observation or termination on a non-Windows host.
    const harness = graphHarness([], {
      platform: "linux",
      terminate: async () => {
        throw new Error("must not terminate");
      },
    });

    const result = await settleWindowsSupervisorProcesses(settlementInput({
      rootIdentity: new Promise<SupervisorProcessIdentity>(() => undefined),
      childExitAndClose: new Promise<void>(() => undefined),
      timeoutMs: 10,
    }), {
      ...harness.dependencies,
      observeProcessTree: async () => {
        throw new Error("must not observe");
      },
    });

    expect(result).toEqual({ status: "unsupported", category: "platform", retained: [] });
    expect(harness.terminatedPids).toEqual([]);
  });
});

describe("real Windows identity-race evidence classification", () => {
  it.each([
    [
      { status: "blocked", category: "identity", retained: [] },
      [{ status: "absent" }],
      true,
    ],
    [
      { status: "blocked", category: "identity", retained: [] },
      [{ status: "present" }, { status: "identity_mismatch" }],
      true,
    ],
    [
      { status: "blocked", category: "termination", retained: [] },
      [{ status: "absent" }],
      false,
    ],
    [
      { status: "settled", category: "none", retained: [] },
      [{ status: "absent" }],
      false,
    ],
    [
      { status: "blocked", category: "identity", retained: [] },
      [{ status: "present" }],
      false,
    ],
    [
      { status: "blocked", category: "identity", retained: [] },
      [{ status: "unavailable" }, { status: "absent" }],
      false,
    ],
    [
      { status: "blocked", category: "identity", retained: [] },
      [{ status: "failed" }, { status: "identity_mismatch" }],
      false,
    ],
  ] as const)(
    "classifies fail-closed result and probe set %# without treating uncertainty as replacement proof",
    (result, probes, expected) => {
      expect(provesFailClosedIdentityReplacement(result, probes)).toBe(expected);
    },
  );

  it.each([
    [[{ status: "absent" }], true],
    [[{ status: "identity_mismatch" }, { status: "absent" }], true],
    [[{ status: "present" }], false],
    [[{ status: "unavailable" }], false],
    [[{ status: "failed" }], false],
  ] as const)(
    "requires every post-cleanup identity probe to prove original absence %#",
    (probes, expected) => {
      expect(provesEveryOriginalAbsent(probes)).toBe(expected);
    },
  );
});
