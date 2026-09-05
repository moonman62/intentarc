import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_RELAUNCH_BUILD_WAIT_MS,
  ARCHIVE_RELAUNCH_CLEANUP_MARGIN_MS,
  ARCHIVE_RELAUNCH_OUTER_TIMEOUT_MS,
  ARCHIVE_RELAUNCH_PHASE_DEADLINE_MS,
  ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS,
  ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS,
  runArchiveRelaunchPhase,
} from "./archive-relaunch-runner.js";

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killCalls = 0;

  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }
}

const argumentsFor = (phase: "before-relaunch" | "replacement") => ({
  helperPath: "C:\\emitted\\desktop-relaunch-process.js",
  phase,
  userDataPath: "C:\\owned\\user-data",
  selectedArchivePath: "C:\\owned\\chosen.sqlite",
  cwd: "C:\\emitted",
});

describe("archive relaunch child runner", () => {
  it("accepts sequential closed lifecycles even when the OS reuses the PID", async () => {
    const children = [new FakeChild(41), new FakeChild(41)];
    const cleanupStates: boolean[] = [];
    const run = async (phase: "before-relaunch" | "replacement", index: number) => {
      const promise = runArchiveRelaunchPhase<{ phase: string }>({
        ...argumentsFor(phase),
        spawnChild: () => children[index],
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      });
      children[index].stdout.emit("data", Buffer.from(JSON.stringify({ phase })));
      children[index].emit("exit", 0, null);
      children[index].emit("close", 0, null);
      return promise;
    };

    const before = await run("before-relaunch", 0);
    const replacement = await run("replacement", 1);

    expect(before.value.phase).toBe("before-relaunch");
    expect(replacement.value.phase).toBe("replacement");
    expect(before.lifecycle).not.toBe(replacement.lifecycle);
    expect(before.lifecycle).toMatchObject({
      phase: "before-relaunch",
      processId: 41,
      exitObserved: true,
      closeObserved: true,
      exitCode: 0,
      closeCode: 0,
      closed: true,
    });
    expect(replacement.lifecycle).toMatchObject({
      phase: "replacement",
      processId: 41,
      exitObserved: true,
      closeObserved: true,
      exitCode: 0,
      closeCode: 0,
      closed: true,
    });
    expect(cleanupStates).toEqual([false, true, false, true]);
  });

  it("waits for exact exit and close settlement before rejecting a timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(42);
      const cleanupStates: boolean[] = [];
      let rejection: unknown;
      const promise = runArchiveRelaunchPhase({
        ...argumentsFor("replacement"),
        spawnChild: () => child,
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      }).catch((error: unknown) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS);
      expect(child.killCalls).toBe(1);
      expect(rejection).toBeUndefined();
      expect(cleanupStates).toEqual([false]);

      child.emit("exit", null, "SIGTERM");
      expect(rejection).toBeUndefined();
      expect(cleanupStates).toEqual([false]);
      child.emit("close", null, "SIGTERM");
      await promise;

      expect(rejection).toMatchObject({
        code: "archive_relaunch_phase_timeout",
        lifecycle: {
          exitObserved: true,
          closeObserved: true,
          closed: true,
        },
      });
      expect(cleanupStates).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves cleanup ownership when timeout settlement remains unproved", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(43);
      const cleanupStates: boolean[] = [];
      let rejection: unknown;
      const promise = runArchiveRelaunchPhase({
        ...argumentsFor("replacement"),
        spawnChild: () => child,
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      }).catch((error: unknown) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(
        ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS +
          ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS,
      );
      await promise;

      expect(rejection).toMatchObject({
        code: "archive_relaunch_phase_settlement_unproved",
        lifecycle: {
          closeObserved: false,
          closed: false,
        },
      });
      expect(child.killCalls).toBe(1);
      expect(cleanupStates).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat close without exit as a proved child lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(44);
      const cleanupStates: boolean[] = [];
      let rejection: unknown;
      const promise = runArchiveRelaunchPhase({
        ...argumentsFor("replacement"),
        spawnChild: () => child,
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      }).catch((error: unknown) => {
        rejection = error;
      });

      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS);
      await promise;

      expect(rejection).toMatchObject({
        code: "archive_relaunch_phase_settlement_unproved",
        lifecycle: {
          exitObserved: false,
          closeObserved: true,
          closed: false,
        },
      });
      expect(child.killCalls).toBe(0);
      expect(cleanupStates).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles when exit completes an already observed close lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(45);
      const cleanupStates: boolean[] = [];
      const outcomePromise = runArchiveRelaunchPhase<{ phase: string }>({
        ...argumentsFor("replacement"),
        spawnChild: () => child,
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );

      child.stdout.emit("data", Buffer.from(JSON.stringify({
        phase: "replacement",
      })));
      child.emit("close", 0, null);
      child.emit("exit", 0, null);
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({
        value: { phase: "replacement" },
        lifecycle: {
          exitObserved: true,
          closeObserved: true,
          closed: true,
        },
      });
      expect(cleanupStates).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves cleanup when exit and close statuses do not match", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(46);
      const cleanupStates: boolean[] = [];
      let rejection: unknown;
      const promise = runArchiveRelaunchPhase({
        ...argumentsFor("replacement"),
        spawnChild: () => child,
        onCleanupSafetyChange: (safe) => cleanupStates.push(safe),
      }).catch((error: unknown) => {
        rejection = error;
      });

      child.emit("exit", 0, null);
      child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS);
      await promise;

      expect(rejection).toMatchObject({
        code: "archive_relaunch_phase_settlement_unproved",
        lifecycle: {
          exitObserved: true,
          closeObserved: true,
          exitCode: 0,
          closeCode: 1,
          closed: false,
        },
      });
      expect(cleanupStates).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the outer timeout strictly beyond all internal deadlines and cleanup", () => {
    expect(ARCHIVE_RELAUNCH_PHASE_DEADLINE_MS).toBe(
      ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS +
        ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS,
    );
    expect(ARCHIVE_RELAUNCH_OUTER_TIMEOUT_MS).toBeGreaterThan(
      ARCHIVE_RELAUNCH_BUILD_WAIT_MS +
        2 * ARCHIVE_RELAUNCH_PHASE_DEADLINE_MS +
        ARCHIVE_RELAUNCH_CLEANUP_MARGIN_MS,
    );
  });
});
