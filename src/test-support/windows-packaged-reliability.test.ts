import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as reliabilityEvidence from "../../scripts/windows-packaged-reliability-evidence.mjs";
import * as reliability from "../../scripts/windows-packaged-reliability.mjs";

type CommandOutcome = {
  readonly exitCode: number;
  readonly durationMs?: number;
  readonly timedOut?: boolean;
  readonly runnerError?: boolean;
  readonly closeUncertain?: boolean;
};

type Invocation = {
  readonly stage: "whole_suite" | "package" | "packaged_bridge";
  readonly command: string;
  readonly arguments: readonly string[];
  readonly shell: boolean;
  readonly resultFile?: string;
};

type WholeSuiteFailureIdentity = {
  readonly testFile: string;
  readonly assertion: string;
};

type WholeSuiteCounts = {
  readonly passed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failedTests: readonly WholeSuiteFailureIdentity[];
  readonly failuresTruncated: boolean;
};

type WholeSuiteReadInput = {
  readonly resultFile: string;
  readonly exitCode: number;
};

type PackagedBridgeReadInput = WholeSuiteReadInput & {
  readonly ordinal: number;
};

type SmokeProcess = EventEmitter & {
  readonly pid?: number;
  kill(): boolean;
};

type SmokeSpawn = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: "ignore";
    readonly detached?: boolean;
  },
) => SmokeProcess;

const temporaryRoots: { path: string; cleanupReady: boolean }[] = [];
const recordTemporaryRoot = (path: string) => {
  const record = { path, cleanupReady: true };
  temporaryRoots.push(record);
  return record;
};
const evidenceApi = reliabilityEvidence as unknown as {
  readWholeSuiteEvidence(input: {
    readonly repositoryRoot: string;
    readonly stateRoot: string;
    readonly resultFile: string;
    readonly exitCode: number;
  }): Promise<WholeSuiteCounts>;
};

const readSmokeEvidence = (input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly resultFile: string;
  readonly exitCode: number;
}) => evidenceApi.readWholeSuiteEvidence(input);

const runSmokeProcess = (
  input: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
  },
  dependencies: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineMs?: number;
    readonly closeGraceMs?: number;
    readonly posixTermGraceMs?: number;
    readonly spawnChild?: SmokeSpawn;
    readonly spawnTermination?: SmokeSpawn;
    readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  } = {},
) => new Promise<number>((resolveChild, rejectChild) => {
  const platform = dependencies.platform ?? process.platform;
  const spawnChild = dependencies.spawnChild ?? (spawn as unknown as SmokeSpawn);
  const spawnTermination = dependencies.spawnTermination ?? (spawn as unknown as SmokeSpawn);
  const killProcessGroup = dependencies.killProcessGroup ?? (
    (pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)
  );
  const deadlineAt = Date.now() + (dependencies.deadlineMs ?? 30_000);
  const closeGraceMs = dependencies.closeGraceMs ?? 5_000;
  const posixTermGraceMs = Math.min(
    dependencies.posixTermGraceMs ?? 1_000,
    closeGraceMs,
  );
  let settled = false;
  let workloadClosed = false;
  let workloadExitCode = -1;
  let workloadError = false;
  let timedOut = false;
  let terminationStarted = false;
  let terminationComplete = false;
  let terminationFailed = false;
  let closeGraceElapsed = false;
  let deadline: NodeJS.Timeout | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const schedule = (action: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, delayMs);
    timers.add(timer);
    return timer;
  };
  const failure = (code: string, cleanupSafe: boolean) => Object.assign(
    new Error(code),
    { code, cleanupSafe },
  );
  const settle = (action: () => void) => {
    if (settled) return false;
    settled = true;
    if (deadline !== undefined) clearTimeout(deadline);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    action();
    return true;
  };
  const finishIfReady = () => {
    if (settled) return;
    if (!timedOut && !workloadError) {
      if (workloadClosed) settle(() => resolveChild(workloadExitCode));
      return;
    }
    if (closeGraceElapsed) {
      settle(() => rejectChild(failure("pnpm_smoke_close_uncertain", false)));
      return;
    }
    if (!workloadClosed || (terminationStarted && !terminationComplete)) return;
    if (terminationFailed) {
      settle(() => rejectChild(failure("pnpm_smoke_close_uncertain", false)));
      return;
    }
    settle(() => rejectChild(failure(
      timedOut ? "pnpm_smoke_timeout" : "pnpm_smoke_child_error",
      true,
    )));
  };
  const beginCloseGrace = () => {
    if ([...timers].some((timer) => timer === closeGrace)) return;
    closeGrace = schedule(() => {
      closeGraceElapsed = true;
      finishIfReady();
    }, closeGraceMs);
  };
  const completePosixTerminationWhenAbsent = (groupPid: number) => {
    try {
      killProcessGroup(groupPid, 0);
      schedule(() => completePosixTerminationWhenAbsent(groupPid), 25);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationFailed = true;
      terminationComplete = true;
      finishIfReady();
    }
  };
  const beginTermination = (child: SmokeProcess) => {
    if (terminationStarted) return;
    terminationStarted = true;
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      terminationFailed = true;
      terminationComplete = true;
      child.kill();
      finishIfReady();
      return;
    }
    const pid = child.pid!;
    if (platform === "win32") {
      let termination: SmokeProcess;
      try {
        termination = spawnTermination("taskkill", ["/PID", String(pid), "/T", "/F"], {
          cwd: input.cwd,
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        terminationFailed = true;
        terminationComplete = true;
        child.kill();
        finishIfReady();
        return;
      }
      termination.once("error", () => {
        terminationFailed = true;
      });
      termination.once("close", (code) => {
        terminationFailed ||= code !== 0;
        terminationComplete = true;
        finishIfReady();
      });
      return;
    }
    const groupPid = -pid;
    try {
      killProcessGroup(groupPid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        terminationComplete = true;
      } else {
        terminationFailed = true;
        terminationComplete = true;
      }
      finishIfReady();
      return;
    }
    schedule(() => {
      try {
        killProcessGroup(groupPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationFailed = true;
        terminationComplete = true;
        finishIfReady();
        return;
      }
      try {
        killProcessGroup(groupPid, "SIGKILL");
        completePosixTerminationWhenAbsent(groupPid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationFailed = true;
        terminationComplete = true;
        finishIfReady();
      }
    }, posixTermGraceMs);
  };
  let closeGrace: NodeJS.Timeout | undefined;
  let child: SmokeProcess;
  try {
    child = spawnChild(input.command, input.arguments, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      ...(platform === "win32" ? {} : { detached: true }),
    });
  } catch {
    settle(() => rejectChild(failure("pnpm_smoke_spawn_error", true)));
    return;
  }
  child.once("error", () => {
    workloadError = true;
    if (deadline !== undefined) clearTimeout(deadline);
    beginCloseGrace();
    if (Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) beginTermination(child);
    finishIfReady();
  });
  child.once("close", (code) => {
    workloadClosed = true;
    workloadExitCode = code ?? -1;
    finishIfReady();
  });
  deadline = setTimeout(() => {
    timedOut = true;
    beginCloseGrace();
    beginTermination(child);
    finishIfReady();
  }, Math.max(0, deadlineAt - Date.now()));
});

const testApi = reliability as unknown as {
  createFixedCommands(
    pnpm: { readonly command: string; readonly arguments: readonly string[] },
    stateRoot: string,
  ): {
    readonly wholeSuite: Invocation;
    readonly package: Invocation;
    readonly packagedBridge: (ordinal: number) => Invocation;
  };
  runWindowsPackagedReliability(input: {
    readonly platform: NodeJS.Platform;
    readonly architecture?: string;
    readonly commit: string;
    readonly dirty: boolean;
    readonly stateRoot: string;
    readonly stateRootSafe?: boolean;
    readonly cleanupSafe?: boolean;
    readonly getCurrentCommit?: () => Promise<string>;
    readonly readWholeSuite: (input: WholeSuiteReadInput) => Promise<WholeSuiteCounts>;
    readonly readPackagedBridge: (
      input: PackagedBridgeReadInput,
    ) => Promise<WholeSuiteCounts>;
    readonly execute: (invocation: Invocation) => Promise<CommandOutcome>;
  }): Promise<{
    readonly schema: string;
    readonly commit: string;
    readonly platform: "win32";
    readonly architecture: string;
    readonly requestedRuns: 10;
    readonly status: "pass" | "fail" | "blocked";
    readonly completedRuns: number;
    readonly consecutivePasses: number;
    readonly wholeSuite: {
      readonly exitCode: number;
      readonly durationMs: number;
      readonly passed: number;
      readonly skipped: number;
      readonly failed: number;
      readonly failedTests: readonly WholeSuiteFailureIdentity[];
      readonly failuresTruncated: boolean;
    };
    readonly iterations: readonly {
      readonly ordinal: number;
      readonly package: {
        readonly exitCode: number;
        readonly durationMs: number;
        readonly passed: number;
        readonly skipped: number;
        readonly failed: number;
      };
      readonly packagedBridge: null | {
        readonly exitCode: number;
        readonly durationMs: number;
        readonly passed: number;
        readonly skipped: number;
        readonly failed: number;
        readonly failedTests: readonly WholeSuiteFailureIdentity[];
        readonly failuresTruncated: boolean;
      };
    }[];
    readonly failure: { readonly stage: string; readonly code: string } | null;
  }>;
  createOwnedStateRoot(input: {
    readonly temporaryRoot: string;
    readonly uuid: string;
    readonly writeMarker: (path: string, content: string) => Promise<void>;
  }): Promise<unknown>;
  runGitCommand?: (
    arguments_: readonly string[],
    repositoryRoot: string,
    options: {
      readonly deadlineMs: number;
      readonly spawnChild: () => EventEmitter & { stdout: EventEmitter; kill: () => void };
    },
  ) => Promise<string>;
  runProduction(input?: {
    readonly platform?: NodeJS.Platform;
    readonly architecture?: string;
    readonly getRepositoryRoot?: () => Promise<string>;
    readonly runGit?: (arguments_: readonly string[], repositoryRoot: string) => Promise<string>;
    readonly createState?: () => Promise<{ stateRoot: string; temporaryRoot: string }>;
    readonly resolvePnpm?: () => Promise<{ command: string; arguments: readonly string[] }>;
    readonly readWholeSuiteEvidence?: (input: {
      readonly repositoryRoot: string;
      readonly stateRoot: string;
      readonly resultFile: string;
      readonly exitCode: number;
    }) => Promise<WholeSuiteCounts>;
    readonly readPackagedBridgeEvidence?: (input: {
      readonly repositoryRoot: string;
      readonly stateRoot: string;
      readonly resultFile: string;
      readonly exitCode: number;
      readonly ordinal: number;
    }) => Promise<WholeSuiteCounts>;
    readonly runChild?: (
      command: Invocation,
      repositoryRoot: string,
      stateRoot: string,
    ) => Promise<CommandOutcome>;
    readonly removeState?: (stateRoot: string, temporaryRoot: string) => Promise<void>;
  }): Promise<{
    readonly status: "pass" | "fail" | "blocked";
    readonly failure: { readonly stage: string; readonly code: string } | null;
  }>;
};

const stateRoot =
  "C:\\temp\\intentarc-packaged-reliability-00000000-0000-4000-8000-000000000000";
const passingWholeSuite = {
  passed: 3363,
  skipped: 14,
  failed: 0,
  failedTests: [],
  failuresTruncated: false,
} as const;
const passingPackagedBridge = {
  passed: 3,
  skipped: 1,
  failed: 0,
  failedTests: [],
  failuresTruncated: false,
} as const;

const runWith = async (outcomes: readonly CommandOutcome[], overrides = {}) => {
  const calls: Invocation[] = [];
  const readerInputs: WholeSuiteReadInput[] = [];
  const bridgeReaderInputs: PackagedBridgeReadInput[] = [];
  let outcomeIndex = 0;
  const result = await testApi.runWindowsPackagedReliability({
    platform: "win32",
    architecture: "x64",
    commit: "a".repeat(40),
    dirty: false,
    stateRoot,
    readWholeSuite: async (input) => {
      readerInputs.push(input);
      return passingWholeSuite;
    },
    readPackagedBridge: async (input) => {
      bridgeReaderInputs.push(input);
      return passingPackagedBridge;
    },
    execute: async (invocation) => {
      calls.push(invocation);
      const outcome = outcomes[outcomeIndex];
      outcomeIndex += 1;
      if (!outcome) throw new Error("unexpected command");
      return outcome;
    },
    ...overrides,
  });
  return { calls, readerInputs, bridgeReaderInputs, result, consumed: outcomeIndex };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0)
      .filter(({ cleanupReady }) => cleanupReady)
      .map(({ path }) => rm(path, { recursive: true, force: true })),
  );
});

describe("closed Windows packaged reliability runner", () => {
  it("waits for workload and Windows tree-termination close before timeout cleanup", async () => {
    const workload = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: () => true,
    });
    const termination = Object.assign(new EventEmitter(), {
      pid: 4343,
      kill: () => true,
    });
    let terminationCall: {
      readonly command: string;
      readonly arguments: readonly string[];
      readonly options: Parameters<SmokeSpawn>[2];
    } | undefined;
    let settled = false;
    const completed = runSmokeProcess({
      command: "pnpm.exe",
      arguments: ["test"],
      cwd: "C:\\repo",
    }, {
      platform: "win32",
      deadlineMs: 1,
      closeGraceMs: 100,
      spawnChild: () => workload,
      spawnTermination: (command, arguments_, options) => {
        terminationCall = { command, arguments: arguments_, options };
        return termination;
      },
    }).then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );

    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(settled).toBe(false);
    expect(terminationCall).toEqual({
      command: "taskkill",
      arguments: ["/PID", "4242", "/T", "/F"],
      options: {
        cwd: "C:\\repo",
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    });
    workload.emit("close", null);
    await Promise.resolve();
    expect(settled).toBe(false);
    termination.emit("close", 0);
    await expect(completed).resolves.toMatchObject({
      error: { code: "pnpm_smoke_timeout", cleanupSafe: true },
    });
  });

  it("preserves cleanup ownership when a timed-out workload never closes", async () => {
    const workload = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: () => true,
    });
    const termination = Object.assign(new EventEmitter(), {
      pid: 4343,
      kill: () => true,
    });
    const completed = runSmokeProcess({
      command: "pnpm.exe",
      arguments: ["test"],
      cwd: "C:\\repo",
    }, {
      platform: "win32",
      deadlineMs: 1,
      closeGraceMs: 20,
      spawnChild: () => workload,
      spawnTermination: () => termination,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    termination.emit("close", 0);
    await expect(completed).resolves.toMatchObject({
      error: { code: "pnpm_smoke_close_uncertain", cleanupSafe: false },
    });
  });

  it("rejects permissively decoded reporter artifacts in the smoke evidence path", async () => {
    const canonicalTemporaryRoot = await realpath(tmpdir());
    const smokeRoot = await mkdtemp(join(canonicalTemporaryRoot, "intentarc-pnpm-reporter-"));
    recordTemporaryRoot(smokeRoot);
    const resultFile = join(smokeRoot, "whole-suite.json");
    const validPrefix = Buffer.from(JSON.stringify({
      success: true,
      numTotalTestSuites: 0,
      numPassedTestSuites: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [],
      note: "",
    }).slice(0, -2));
    await writeFile(resultFile, Buffer.concat([
      validPrefix,
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]));

    await expect(readSmokeEvidence({
      repositoryRoot: await realpath(fileURLToPath(new URL("../../", import.meta.url))),
      stateRoot: await realpath(smokeRoot),
      resultFile,
      exitCode: 0,
    })).rejects.toMatchObject({ code: "whole_suite_evidence_malformed" });
  });

  it("runs one whole suite and ten fixed package and bridge pairs", async () => {
    const outcomes = [
      { exitCode: 0, durationMs: 11 },
      ...Array.from({ length: 10 }, () => [
        { exitCode: 0 },
        { exitCode: 0 },
      ]).flat(),
    ];
    const { calls, readerInputs, bridgeReaderInputs, result } = await runWith(outcomes);

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      platform: "win32",
      architecture: "x64",
      requestedRuns: 10,
      status: "pass",
      completedRuns: 10,
      consecutivePasses: 10,
      failure: null,
    });
    expect(result.schema).toBe("intentarc.windows-packaged-reliability/v3");
    expect(result.wholeSuite).toEqual({
      exitCode: 0,
      durationMs: 11,
      passed: 3363,
      skipped: 14,
      failed: 0,
      failedTests: [],
      failuresTruncated: false,
    });
    expect(Object.keys(result).sort()).toEqual([
      "architecture",
      "commit",
      "completedRuns",
      "consecutivePasses",
      "failure",
      "iterations",
      "platform",
      "requestedRuns",
      "schema",
      "status",
      "wholeSuite",
    ]);
    expect(readerInputs).toEqual([{
      resultFile: join(stateRoot, "whole-suite.json"),
      exitCode: 0,
    }]);
    expect(bridgeReaderInputs).toEqual(Array.from({ length: 10 }, (_, index) => ({
      resultFile: join(stateRoot, `packaged-bridge-${index + 1}.json`),
      exitCode: 0,
      ordinal: index + 1,
    })));
    for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
      expect(result.iterations[ordinal - 1]).toEqual({
        ordinal,
        package: {
          exitCode: 0,
          durationMs: 0,
          passed: 0,
          skipped: 0,
          failed: 0,
        },
        packagedBridge: {
          exitCode: 0,
          durationMs: 0,
          passed: 3,
          skipped: 1,
          failed: 0,
          failedTests: [],
          failuresTruncated: false,
        },
      });
    }
    expect(calls).toHaveLength(21);
    expect(calls[0]).toEqual({
      stage: "whole_suite",
      command: "pnpm",
      arguments: [
        "test",
        "--reporter=json",
        `--outputFile=${join(stateRoot, "whole-suite.json")}`,
      ],
      shell: false,
      resultFile: join(stateRoot, "whole-suite.json"),
    });
    expect(calls.filter(({ stage }) => stage === "package")).toHaveLength(10);
    expect(calls.filter(({ stage }) => stage === "packaged_bridge")).toHaveLength(10);
    expect(calls.every(({ shell }) => shell === false)).toBe(true);
  });

  it("forwards whole-suite reporter options through the real pnpm package lifecycle", async () => {
    const canonicalTemporaryRoot = await realpath(tmpdir());
    const createdRoot = await mkdtemp(join(canonicalTemporaryRoot, "intentarc-pnpm-reporter-"));
    const rootRecord = recordTemporaryRoot(createdRoot);
    const rootDetails = await lstat(createdRoot);
    expect(rootDetails.isDirectory()).toBe(true);
    expect(rootDetails.isSymbolicLink()).toBe(false);
    const smokeRoot = await realpath(createdRoot);
    expect(dirname(smokeRoot).toLocaleLowerCase()).toBe(
      canonicalTemporaryRoot.toLocaleLowerCase(),
    );

    const canonicalOrdinaryFile = async (path: string | undefined, label: string) => {
      if (!path?.trim() || !isAbsolute(path)) throw new Error(`missing_${label}`);
      const configuredDetails = await lstat(path);
      if (!configuredDetails.isFile() || configuredDetails.isSymbolicLink()) {
        throw new Error(`unsafe_${label}`);
      }
      const canonical = await realpath(path);
      const canonicalDetails = await lstat(canonical);
      if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) {
        throw new Error(`unsafe_${label}`);
      }
      return canonical;
    };
    const pnpmPath = await canonicalOrdinaryFile(process.env.npm_execpath, "pnpm");
    const nodePath = await canonicalOrdinaryFile(process.execPath, "node");
    const pnpmEntryName = basename(pnpmPath).toLowerCase();
    const pnpm = ["pnpm.cjs", "pnpm.js", "pnpm.mjs"].includes(pnpmEntryName)
      ? { command: nodePath, arguments: [pnpmPath] }
      : pnpmEntryName === "pnpm.exe"
        ? { command: pnpmPath, arguments: [] }
        : (() => { throw new Error("unsupported_pnpm_launcher"); })();

    const command = testApi.createFixedCommands(pnpm, smokeRoot).wholeSuite;
    const testToken = command.arguments.indexOf("test");
    expect(testToken).toBeGreaterThanOrEqual(0);
    const focus = [
      "src/test-support/packaged-test-build.test.ts",
      "-t",
      "fingerprints sorted source and config contents instead of mtimes",
    ];
    const arguments_ = [
      ...command.arguments.slice(0, testToken + 1),
      ...focus,
      ...command.arguments.slice(testToken + 1),
    ];
    const repositoryRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    rootRecord.cleanupReady = false;
    let exitCode: number;
    try {
      exitCode = await runSmokeProcess({
        command: command.command,
        arguments: arguments_,
        cwd: repositoryRoot,
      });
      rootRecord.cleanupReady = true;
    } catch (error) {
      rootRecord.cleanupReady = (error as { cleanupSafe?: boolean }).cleanupSafe === true;
      throw error;
    }

    expect(exitCode).toBe(0);
    expect(command.shell).toBe(false);
    expect(command.resultFile).toBe(join(smokeRoot, "whole-suite.json"));
    const resultDetails = await lstat(command.resultFile!);
    expect(resultDetails.isFile()).toBe(true);
    expect(resultDetails.isSymbolicLink()).toBe(false);
    const counts = await readSmokeEvidence({
      repositoryRoot,
      stateRoot: smokeRoot,
      resultFile: command.resultFile!,
      exitCode: 0,
    });
    expect(counts.passed).toBeGreaterThanOrEqual(1);
    expect(counts.failed).toBe(0);
  });

  it("does not begin iterations after a whole-suite failure", async () => {
    const { calls, result } = await runWith([{ exitCode: 1 }]);

    expect(result).toMatchObject({
      status: "fail",
      completedRuns: 0,
      failure: { stage: "whole_suite" },
    });
    expect(calls).toHaveLength(1);
  });

  it("returns bounded whole-suite failure identities and starts zero iterations", async () => {
    let readerInput: WholeSuiteReadInput | undefined;
    const { calls, result } = await runWith(
      [{ exitCode: 1, durationMs: 19 }],
      {
        readWholeSuite: async (input: WholeSuiteReadInput) => {
          readerInput = input;
          return {
            passed: 3348,
            skipped: 14,
            failed: 1,
            failedTests: [{
              testFile: "src/desktop/example.test.ts",
              assertion: "example rejects invalid state",
            }],
            failuresTruncated: false,
          };
        },
      },
    );

    expect(result).toMatchObject({
      completedRuns: 0,
      consecutivePasses: 0,
      status: "fail",
      iterations: [],
      failure: { stage: "whole_suite", code: "exit_code" },
      wholeSuite: {
        exitCode: 1,
        passed: 3348,
        skipped: 14,
        failed: 1,
        failedTests: [{
          testFile: "src/desktop/example.test.ts",
          assertion: "example rejects invalid state",
        }],
      },
    });
    expect(readerInput).toEqual({
      resultFile: join(stateRoot, "whole-suite.json"),
      exitCode: 1,
    });
    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite"]);
  });

  it.each([
    "whole_suite_evidence_missing",
    "whole_suite_evidence_unsafe",
    "whole_suite_evidence_oversize",
    "whole_suite_evidence_malformed",
    "whole_suite_evidence_inconsistent",
  ])("fails before iteration 1 on %s", async (code) => {
    const { calls, result } = await runWith(
      [{ exitCode: 0 }],
      {
        readWholeSuite: async () => {
          throw Object.assign(new Error("must-not-cross-boundary"), { code });
        },
      },
    );

    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite"]);
    expect(result.iterations).toEqual([]);
    expect(result.failure).toEqual({ stage: "whole_suite", code });
  });

  it.each([
    ["timeout", { exitCode: -1, timedOut: true }, { stage: "whole_suite", code: "timeout" }],
    ["missing child exit/close", { exitCode: -1, runnerError: true }, { stage: "runner", code: "child" }],
  ])("decides %s before reading whole-suite evidence", async (_label, outcome, failure) => {
    let readerCalled = false;
    const { result } = await runWith([outcome], {
      readWholeSuite: async () => {
        readerCalled = true;
        return passingWholeSuite;
      },
    });

    expect(result.failure).toEqual(failure);
    expect(result.iterations).toEqual([]);
    expect(readerCalled).toBe(false);
  });

  it("fails closed on whole-suite close uncertainty before evidence or iteration", async () => {
    let readerCalled = false;
    const { calls, result } = await runWith([
      { exitCode: -1, closeUncertain: true },
    ], {
      readWholeSuite: async () => {
        readerCalled = true;
        return passingWholeSuite;
      },
    });

    expect(result.failure).toEqual({ stage: "runner", code: "child" });
    expect(result.iterations).toEqual([]);
    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite"]);
    expect(readerCalled).toBe(false);
  });

  it("does not run the bridge after a package failure", async () => {
    const { calls, result } = await runWith([
      { exitCode: 0 },
      { exitCode: 2 },
    ]);

    expect(result).toMatchObject({
      status: "fail",
      completedRuns: 0,
      failure: { stage: "package" },
    });
    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite", "package"]);
  });

  it("fails closed on package close uncertainty before the bridge", async () => {
    let bridgeReaderCalled = false;
    const { calls, result } = await runWith([
      { exitCode: 0 },
      { exitCode: -1, closeUncertain: true },
      { exitCode: 0 },
    ], {
      readPackagedBridge: async () => {
        bridgeReaderCalled = true;
        return passingPackagedBridge;
      },
    });

    expect(result.failure).toEqual({ stage: "runner", code: "child" });
    expect(result.iterations).toEqual([]);
    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite", "package"]);
    expect(bridgeReaderCalled).toBe(false);
  });

  it("stops after a bridge failure and never consumes later outcomes", async () => {
    const { calls, consumed, result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0 },
    ]);

    expect(result).toMatchObject({
      status: "fail",
      completedRuns: 0,
      consecutivePasses: 0,
      failure: { stage: "packaged_bridge" },
    });
    expect(calls.map(({ stage }) => stage)).toEqual([
      "whole_suite",
      "package",
      "packaged_bridge",
    ]);
    expect(consumed).toBe(3);
  });

  it("retains clean nonzero packaged-bridge evidence and stops before iteration 2", async () => {
    const readerInputs: PackagedBridgeReadInput[] = [];
    const failedTests = [{
      testFile: "src/desktop/e2e/packaged-bridge.test.ts",
      assertion: "assertion-000003",
    }];
    const { calls, consumed, result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1, durationMs: 27 },
      { exitCode: 0 },
      { exitCode: 0 },
    ], {
      readPackagedBridge: async (input: PackagedBridgeReadInput) => {
        readerInputs.push(input);
        return {
          passed: 8,
          skipped: 0,
          failed: 1,
          failedTests,
          failuresTruncated: false,
        };
      },
    });

    expect(result).toMatchObject({
      status: "fail",
      completedRuns: 0,
      consecutivePasses: 0,
      failure: { stage: "packaged_bridge", code: "exit_code" },
      iterations: [{
        ordinal: 1,
        packagedBridge: {
          exitCode: 1,
          durationMs: 27,
          passed: 8,
          skipped: 0,
          failed: 1,
          failedTests,
          failuresTruncated: false,
        },
      }],
    });
    expect(result.schema).toBe("intentarc.windows-packaged-reliability/v3");
    expect(readerInputs).toEqual([{
      resultFile: join(stateRoot, "packaged-bridge-1.json"),
      exitCode: 1,
      ordinal: 1,
    }]);
    expect(calls.map(({ stage }) => stage)).toEqual([
      "whole_suite",
      "package",
      "packaged_bridge",
    ]);
    expect(consumed).toBe(3);
  });

  it.each([
    "packaged_bridge_evidence_missing",
    "packaged_bridge_evidence_unsafe",
    "packaged_bridge_evidence_oversize",
    "packaged_bridge_evidence_malformed",
    "packaged_bridge_evidence_inconsistent",
  ])("returns the closed packaged-bridge evidence code %s", async (code) => {
    const secret = `private reader exception ${code}`;
    const { calls, result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1 },
    ], {
      readPackagedBridge: async () => {
        throw Object.assign(new Error(secret), {
          code,
          path: "C:\\private\\bridge.json",
        });
      },
    });

    expect(result.failure).toEqual({ stage: "packaged_bridge", code });
    expect(result.iterations).toHaveLength(1);
    expect(calls.map(({ stage }) => stage)).toEqual([
      "whole_suite",
      "package",
      "packaged_bridge",
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("C:\\private");
  });

  it("closes unknown packaged-bridge reader exceptions as malformed", async () => {
    const secret = "provider-private-bridge-reader-error";
    const { result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1 },
    ], {
      readPackagedBridge: async () => {
        throw Object.assign(new Error(secret), { code: secret });
      },
    });

    expect(result.failure).toEqual({
      stage: "packaged_bridge",
      code: "packaged_bridge_evidence_malformed",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ["timeout", { exitCode: -1, timedOut: true }, { stage: "packaged_bridge", code: "timeout" }],
    ["close uncertainty", { exitCode: -1, runnerError: true }, { stage: "runner", code: "child" }],
  ])("decides packaged-bridge %s before reading its artifact", async (_label, outcome, failure) => {
    let bridgeReaderCalled = false;
    const { result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      outcome,
    ], {
      readPackagedBridge: async () => {
        bridgeReaderCalled = true;
        return passingPackagedBridge;
      },
    });

    expect(result.failure).toEqual(failure);
    expect(result.iterations).toHaveLength(1);
    expect(bridgeReaderCalled).toBe(false);
  });

  it("fails closed on packaged-bridge close uncertainty before reading its artifact", async () => {
    let bridgeReaderCalled = false;
    const { calls, consumed, result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: -1, closeUncertain: true },
      { exitCode: 0 },
    ], {
      readPackagedBridge: async () => {
        bridgeReaderCalled = true;
        return passingPackagedBridge;
      },
    });

    expect(result.failure).toEqual({ stage: "runner", code: "child" });
    expect(result.iterations).toHaveLength(1);
    expect(calls.map(({ stage }) => stage)).toEqual([
      "whole_suite",
      "package",
      "packaged_bridge",
    ]);
    expect(consumed).toBe(3);
    expect(bridgeReaderCalled).toBe(false);
  });

  it("decides a changed commit after the bridge child before reading its artifact", async () => {
    let checks = 0;
    let bridgeReaderCalled = false;
    const { result } = await runWith([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1 },
    ], {
      getCurrentCommit: async () => {
        checks += 1;
        return checks === 6 ? "b".repeat(40) : "a".repeat(40);
      },
      readPackagedBridge: async () => {
        bridgeReaderCalled = true;
        return passingPackagedBridge;
      },
    });

    expect(result.failure).toEqual({ stage: "runner", code: "changed_commit" });
    expect(result.iterations).toEqual([]);
    expect(bridgeReaderCalled).toBe(false);
  });

  it.each([
    ["timeout", [{ exitCode: 0, timedOut: true }], {}],
    ["malformed packaged-bridge evidence", [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }], {
      readPackagedBridge: async () => {
        throw Object.assign(new Error("private detail"), {
          code: "packaged_bridge_evidence_malformed",
        });
      },
    }],
    ["wrong platform", [], { platform: "linux" as NodeJS.Platform }],
    ["dirty starting tree", [], { dirty: true }],
    ["unsafe temporary root", [], { stateRootSafe: false }],
    ["cleanup uncertainty", [{ exitCode: 0 }], { cleanupSafe: false }],
  ])("never passes with %s", async (_label, outcomes, overrides) => {
    const { result } = await runWith(outcomes, overrides);
    expect(result.status).not.toBe("pass");
    expect(result.failure).not.toBeNull();
  });

  it("lets runProduction cleanup uncertainty replace an evidence failure", async () => {
    let evidenceAttempted = false;
    let evidenceInput: {
      readonly repositoryRoot: string;
      readonly stateRoot: string;
      readonly resultFile: string;
      readonly exitCode: number;
    } | undefined;
    const commit = "a".repeat(40);

    const result = await testApi.runProduction({
      platform: "win32",
      architecture: "x64",
      getRepositoryRoot: async () => "C:\\repo",
      runGit: async (arguments_) => arguments_[0] === "rev-parse" ? commit : "",
      createState: async () => ({ stateRoot, temporaryRoot: "C:\\temp" }),
      resolvePnpm: async () => ({ command: "pnpm", arguments: [] }),
      readWholeSuiteEvidence: async (input) => {
        evidenceAttempted = true;
        evidenceInput = input;
        throw Object.assign(new Error("private evidence detail"), {
          code: "whole_suite_evidence_malformed",
        });
      },
      runChild: async () => ({ exitCode: 1, durationMs: 1 }),
      removeState: async () => {
        throw new Error("cleanup failed");
      },
    });

    expect(evidenceAttempted).toBe(true);
    expect(evidenceInput).toEqual({
      repositoryRoot: "C:\\repo",
      stateRoot,
      resultFile: join(stateRoot, "whole-suite.json"),
      exitCode: 1,
    });
    expect(result).toMatchObject({
      status: "blocked",
      failure: { stage: "runner", code: "cleanup_uncertain" },
    });
  });

  it("lets cleanup uncertainty replace a packaged-bridge evidence failure", async () => {
    const commit = "a".repeat(40);
    const outcomes = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1 },
    ];
    let outcome = 0;
    let bridgeEvidenceAttempted = false;

    const result = await testApi.runProduction({
      platform: "win32",
      architecture: "x64",
      getRepositoryRoot: async () => "C:\\repo",
      runGit: async (arguments_) => arguments_[0] === "rev-parse" ? commit : "",
      createState: async () => ({ stateRoot, temporaryRoot: "C:\\temp" }),
      resolvePnpm: async () => ({ command: "pnpm", arguments: [] }),
      readWholeSuiteEvidence: async () => passingWholeSuite,
      readPackagedBridgeEvidence: async () => {
        bridgeEvidenceAttempted = true;
        throw Object.assign(new Error("private bridge evidence"), {
          code: "packaged_bridge_evidence_inconsistent",
        });
      },
      runChild: async () => outcomes[outcome++] ?? { exitCode: -1, runnerError: true },
      removeState: async () => {
        throw new Error("cleanup failed");
      },
    });

    expect(bridgeEvidenceAttempted).toBe(true);
    expect(result).toMatchObject({
      status: "blocked",
      failure: { stage: "runner", code: "cleanup_uncertain" },
    });
  });

  it("preserves cleanup ownership after a child reports close uncertainty", async () => {
    const commit = "a".repeat(40);
    let readerCalled = false;
    let removeCalled = false;

    const result = await testApi.runProduction({
      platform: "win32",
      architecture: "x64",
      getRepositoryRoot: async () => "C:\\repo",
      runGit: async (arguments_) => arguments_[0] === "rev-parse" ? commit : "",
      createState: async () => ({ stateRoot, temporaryRoot: "C:\\temp" }),
      resolvePnpm: async () => ({ command: "pnpm", arguments: [] }),
      readWholeSuiteEvidence: async () => {
        readerCalled = true;
        return passingWholeSuite;
      },
      runChild: async () => ({ exitCode: -1, closeUncertain: true }),
      removeState: async () => {
        removeCalled = true;
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      failure: { stage: "runner", code: "cleanup_uncertain" },
    });
    expect(readerCalled).toBe(false);
    expect(removeCalled).toBe(false);
  });

  it("refuses a valid starting commit that changes before a workload child", async () => {
    let readerCalled = false;
    const { calls, result } = await runWith([], {
      getCurrentCommit: async () => "b".repeat(40),
      readWholeSuite: async () => {
        readerCalled = true;
        return passingWholeSuite;
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      failure: { stage: "runner", code: "changed_commit" },
    });
    expect(calls).toEqual([]);
    expect(readerCalled).toBe(false);
  });

  it("refuses a valid starting commit that changes after a workload child", async () => {
    let checks = 0;
    let readerCalled = false;
    const { calls, result } = await runWith([{ exitCode: 0 }], {
      getCurrentCommit: async () => {
        checks += 1;
        return checks === 1 ? "a".repeat(40) : "b".repeat(40);
      },
      readWholeSuite: async () => {
        readerCalled = true;
        return passingWholeSuite;
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      failure: { stage: "runner", code: "changed_commit" },
    });
    expect(calls.map(({ stage }) => stage)).toEqual(["whole_suite"]);
    expect(readerCalled).toBe(false);
  });

  it("does not remove a newly created root when marker validation fails", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "intentarc-reliability-root-"));
    recordTemporaryRoot(temporaryRoot);
    const uuid = "00000000-0000-4000-8000-000000000003";
    const stateRoot = join(temporaryRoot, `intentarc-packaged-reliability-${uuid}`);

    await expect(testApi.createOwnedStateRoot({
      temporaryRoot,
      uuid,
      writeMarker: async (path) => {
        await (await import("node:fs/promises")).writeFile(path, "wrong marker");
      },
    })).rejects.toThrow();
    await expect((await import("node:fs/promises")).stat(stateRoot)).resolves
      .toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("requires both Git exit and close evidence and enforces its deadline", async () => {
    expect(testApi.runGitCommand).toBeTypeOf("function");
    if (!testApi.runGitCommand) return;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      kill: () => undefined,
    });
    let settled = false;
    const completed = testApi.runGitCommand(["rev-parse", "HEAD"], "C:\\repo", {
      deadlineMs: 50,
      spawnChild: () => child,
    }).then((value) => {
      settled = true;
      return value;
    });
    child.stdout.emit("data", "a".repeat(40));
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 0);
    await expect(completed).resolves.toBe("a".repeat(40));

    const stalled = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      kill: () => undefined,
    });
    await expect(testApi.runGitCommand(["status", "--porcelain"], "C:\\repo", {
      deadlineMs: 1,
      spawnChild: () => stalled,
    })).rejects.toMatchObject({ code: "git_timeout", closeUncertain: true });
  });

  it("returns closed evidence without paths, environment values, output, or exception text", async () => {
    const secret = "top-secret-output-C:\\private\\whole-suite.json-ENV_TOKEN";
    const sensitiveCode = "provider_private_reader_code";
    const { result } = await runWith([
      { exitCode: 0 },
    ], {
      readWholeSuite: async () => {
        throw Object.assign(new Error(secret), {
          code: sensitiveCode,
          path: "C:\\private\\whole-suite.json",
          environment: "ENV_TOKEN",
        });
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.failure).toEqual({
      stage: "whole_suite",
      code: "whole_suite_evidence_malformed",
    });
    expect(serialized).not.toContain("C:\\temp");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("C:\\private");
    expect(serialized).not.toContain("ENV_TOKEN");
    expect(serialized).not.toContain(sensitiveCode);
    expect(serialized).not.toContain("unexpected command");
  });

  it("never copies a raw Vitest JSON payload from a child outcome into the result", async () => {
    const secret = "private-raw-vitest-json-payload";
    const outcome = { exitCode: 1, vitestJson: secret } as unknown as CommandOutcome;

    const { result } = await runWith([outcome]);

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.keys(result.wholeSuite).sort()).toEqual([
      "durationMs",
      "exitCode",
      "failed",
      "failedTests",
      "failuresTruncated",
      "passed",
      "skipped",
    ]);
  });
});
