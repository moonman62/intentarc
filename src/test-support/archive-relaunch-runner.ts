import { spawn } from "node:child_process";

export const ARCHIVE_RELAUNCH_BUILD_WAIT_MS = 60_000;
export const ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS = 15_000;
export const ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS = 5_000;
export const ARCHIVE_RELAUNCH_PHASE_DEADLINE_MS =
  ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS +
  ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS;
export const ARCHIVE_RELAUNCH_CLEANUP_MARGIN_MS = 5_000;
export const ARCHIVE_RELAUNCH_OUTER_TIMEOUT_MS = 110_000;

export type ArchiveRelaunchPhase = "before-relaunch" | "replacement";

type ChildStream = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
};

export type ArchiveRelaunchChild = {
  readonly pid?: number | undefined;
  readonly stdout: ChildStream;
  readonly stderr: ChildStream;
  once(
    event: "error",
    listener: (error: Error) => void,
  ): unknown;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(): boolean;
};

export type ArchiveRelaunchChildLifecycle = {
  readonly phase: ArchiveRelaunchPhase;
  readonly processId: number;
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly exitCode: number | null;
  readonly closeCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly closeSignal: NodeJS.Signals | null;
  readonly closed: boolean;
};

export class ArchiveRelaunchPhaseError extends Error {
  constructor(
    readonly code:
      | "archive_relaunch_phase_failed"
      | "archive_relaunch_phase_invalid_json"
      | "archive_relaunch_phase_spawn_error"
      | "archive_relaunch_phase_timeout"
      | "archive_relaunch_phase_settlement_unproved",
    message: string,
    readonly lifecycle: ArchiveRelaunchChildLifecycle,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArchiveRelaunchPhaseError";
  }
}

export type RunArchiveRelaunchPhaseOptions = {
  readonly helperPath: string;
  readonly phase: ArchiveRelaunchPhase;
  readonly userDataPath: string;
  readonly selectedArchivePath: string;
  readonly cwd: string;
  readonly spawnChild?: () => ArchiveRelaunchChild;
  readonly executionTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly onCleanupSafetyChange?: (safe: boolean) => void;
};

export type ArchiveRelaunchPhaseOutput<Value> = {
  readonly value: Value;
  readonly lifecycle: ArchiveRelaunchChildLifecycle & { readonly closed: true };
};

const lifecycleFor = (
  phase: ArchiveRelaunchPhase,
  child: ArchiveRelaunchChild,
  state: {
    exitObserved: boolean;
    closeObserved: boolean;
    exitCode: number | null;
    closeCode: number | null;
    exitSignal: NodeJS.Signals | null;
    closeSignal: NodeJS.Signals | null;
  },
): ArchiveRelaunchChildLifecycle => {
  const closed = state.exitObserved && state.closeObserved &&
    state.exitCode === state.closeCode &&
    state.exitSignal === state.closeSignal;
  return Object.freeze({
    phase,
    processId: Number.isInteger(child.pid) ? child.pid as number : -1,
    ...state,
    closed,
  });
};

export const runArchiveRelaunchPhase = async <Value>({
  helperPath,
  phase,
  userDataPath,
  selectedArchivePath,
  cwd,
  spawnChild,
  executionTimeoutMs = ARCHIVE_RELAUNCH_PHASE_EXECUTION_MS,
  settlementTimeoutMs = ARCHIVE_RELAUNCH_PHASE_SETTLEMENT_MS,
  onCleanupSafetyChange = () => undefined,
}: RunArchiveRelaunchPhaseOptions): Promise<ArchiveRelaunchPhaseOutput<Value>> =>
  new Promise((resolvePhase, rejectPhase) => {
    let child: ArchiveRelaunchChild;
    try {
      child = spawnChild?.() ?? spawn(
        process.execPath,
        [helperPath, phase, userDataPath, selectedArchivePath],
        { cwd, windowsHide: true },
      );
    } catch (error) {
      const lifecycle = Object.freeze({
        phase,
        processId: -1,
        exitObserved: false,
        closeObserved: false,
        exitCode: null,
        closeCode: null,
        exitSignal: null,
        closeSignal: null,
        closed: false,
      });
      rejectPhase(new ArchiveRelaunchPhaseError(
        "archive_relaunch_phase_spawn_error",
        `Desktop ${phase} process could not start.`,
        lifecycle,
        { cause: error },
      ));
      return;
    }

    onCleanupSafetyChange(false);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    const state = {
      exitObserved: false,
      closeObserved: false,
      exitCode: null as number | null,
      closeCode: null as number | null,
      exitSignal: null as NodeJS.Signals | null,
      closeSignal: null as NodeJS.Signals | null,
    };
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;

    const rejectUnprovedSettlement = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(executionTimer);
      rejectPhase(new ArchiveRelaunchPhaseError(
        "archive_relaunch_phase_settlement_unproved",
        `Desktop ${phase} process settlement was not proved.`,
        lifecycleFor(phase, child, state),
        spawnError ? { cause: spawnError } : undefined,
      ));
    };
    const beginSettlementDeadline = (): void => {
      if (settlementTimer) return;
      settlementTimer = setTimeout(
        rejectUnprovedSettlement,
        settlementTimeoutMs,
      );
    };
    const executionTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill();
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
      }
      beginSettlementDeadline();
    }, executionTimeoutMs);

    const settleClosedLifecycle = (): boolean => {
      if (settled) return true;
      const lifecycle = lifecycleFor(phase, child, state);
      if (!lifecycle.closed) return false;
      settled = true;
      clearTimeout(executionTimer);
      clearTimeout(settlementTimer);
      onCleanupSafetyChange(true);
      if (timedOut) {
        rejectPhase(new ArchiveRelaunchPhaseError(
          "archive_relaunch_phase_timeout",
          `Desktop ${phase} process timed out after child settlement.`,
          lifecycle,
        ));
        return true;
      }
      if (spawnError) {
        rejectPhase(new ArchiveRelaunchPhaseError(
          "archive_relaunch_phase_spawn_error",
          `Desktop ${phase} process failed to start cleanly.`,
          lifecycle,
          { cause: spawnError },
        ));
        return true;
      }
      if (lifecycle.closeCode !== 0) {
        rejectPhase(new ArchiveRelaunchPhaseError(
          "archive_relaunch_phase_failed",
          `Desktop ${phase} process failed (${lifecycle.closeCode ?? lifecycle.closeSignal}): ${stderr}`,
          lifecycle,
        ));
        return true;
      }
      try {
        resolvePhase({
          value: JSON.parse(stdout.trim()) as Value,
          lifecycle: lifecycle as ArchiveRelaunchChildLifecycle & { closed: true },
        });
      } catch (error) {
        rejectPhase(new ArchiveRelaunchPhaseError(
          "archive_relaunch_phase_invalid_json",
          `Desktop ${phase} process returned invalid JSON: ${stdout}`,
          lifecycle,
          { cause: error },
        ));
      }
      return true;
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      spawnError = error;
      beginSettlementDeadline();
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      state.exitObserved = true;
      state.exitCode = code;
      state.exitSignal = signal;
      if (state.closeObserved) settleClosedLifecycle();
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      state.closeObserved = true;
      state.closeCode = code;
      state.closeSignal = signal;
      if (!settleClosedLifecycle()) {
        beginSettlementDeadline();
      }
    });
  });
