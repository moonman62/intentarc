import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  WHOLE_SUITE_RESULT_FILENAME,
  isPackagedBridgeEvidenceCode,
  isWholeSuiteEvidenceCode,
  readPackagedBridgeEvidence,
  readWholeSuiteEvidence,
} from "./windows-packaged-reliability-evidence.mjs";

export const PACKAGED_TEST_STATE_DIRECTORY_ENV =
  "INTENTARC_PACKAGED_TEST_STATE_DIRECTORY";
export const PACKAGED_RELIABILITY_STATE_MARKER =
  ".intentarc-packaged-reliability-owner.json";

const resultSchema = "intentarc.windows-packaged-reliability/v3";
const stateSchema = "intentarc.packaged-reliability-state/v1";
const requestedRuns = 10;
const childDeadlineMs = 30 * 60 * 1_000;
const maximumDrainedBytes = 64 * 1_024;
const stateDirectoryPattern =
  /^intentarc-packaged-reliability-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commitPattern = /^[0-9a-f]{40}$/i;

const emptyEvidence = () => ({
  exitCode: -1,
  durationMs: 0,
  passed: 0,
  skipped: 0,
  failed: 0,
});

const emptyWholeSuiteEvidence = () => ({
  ...emptyEvidence(),
  failedTests: [],
  failuresTruncated: false,
});

const closedEvidence = (outcome, counts = undefined) => ({
  exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : -1,
  durationMs:
    typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs)
      ? Math.max(0, Math.round(outcome.durationMs))
      : 0,
  passed: counts?.passed ?? 0,
  skipped: counts?.skipped ?? 0,
  failed: counts?.failed ?? 0,
});

const closedFailure = (stage, code) => ({ stage, code });

const hasUncertainChildClose = (outcome) =>
  Boolean(outcome.runnerError || outcome.closeUncertain);

const isOrdinaryDirectory = async (path) => {
  const details = await lstat(path);
  return details.isDirectory() && !details.isSymbolicLink();
};

const isOrdinaryFile = async (path) => {
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
};

const isContained = (parent, child) => {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith("..\\") && !path.startsWith("../");
};

const canonicalEqual = (left, right) =>
  process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;

export const markerContentFor = (canonicalStateDirectory) =>
  `${JSON.stringify({
    schema: stateSchema,
    stateDirectory: canonicalStateDirectory,
  })}\n`;

export const createFixedCommands = (pnpm, stateRoot) => {
  const wholeSuiteResult = join(stateRoot, WHOLE_SUITE_RESULT_FILENAME);
  return {
    wholeSuite: {
      stage: "whole_suite",
      command: pnpm.command,
      arguments: [
        ...pnpm.arguments,
        "test",
        "--reporter=json",
        `--outputFile=${wholeSuiteResult}`,
      ],
      shell: false,
      resultFile: wholeSuiteResult,
    },
    package: {
      stage: "package",
      command: pnpm.command,
      arguments: [...pnpm.arguments, "desktop:package"],
      shell: false,
    },
    packagedBridge: (ordinal) => ({
      stage: "packaged_bridge",
      command: pnpm.command,
      arguments: [
        ...pnpm.arguments,
        "vitest",
        "run",
        "src/desktop/e2e/packaged-bridge.test.ts",
        "--maxWorkers=1",
        "--reporter=json",
        `--outputFile=${join(stateRoot, `packaged-bridge-${ordinal}.json`)}`,
      ],
      shell: false,
      resultFile: join(stateRoot, `packaged-bridge-${ordinal}.json`),
    }),
  };
};

const completedIterationCount = (iterations) => iterations.filter(
  (iteration) =>
    iteration.packagedBridge !== null &&
    iteration.package.exitCode === 0 &&
    iteration.packagedBridge.exitCode === 0 &&
    iteration.packagedBridge.failed === 0,
).length;

const consecutivePassCount = (iterations) => {
  let count = 0;
  for (const iteration of iterations) {
    if (
      iteration.packagedBridge === null ||
      iteration.package.exitCode !== 0 ||
      iteration.packagedBridge.exitCode !== 0 ||
      iteration.packagedBridge.failed !== 0
    ) break;
    count += 1;
  }
  return count;
};

const resultFor = ({ commit, architecture, status, wholeSuite, iterations, failure }) => ({
  schema: resultSchema,
  commit,
  platform: "win32",
  architecture,
  requestedRuns,
  completedRuns: completedIterationCount(iterations),
  consecutivePasses: consecutivePassCount(iterations),
  status,
  wholeSuite,
  iterations,
  failure,
});

/**
 * Orchestrates injected fixed commands. It deliberately returns only closed,
 * structured evidence; child output and thrown errors never cross this boundary.
 */
export const runWindowsPackagedReliability = async (input) => {
  const architecture = input.architecture ?? process.arch;
  const wholeSuite = emptyWholeSuiteEvidence();
  const iterations = [];
  const fail = (status, stage, code) => resultFor({
    commit: input.commit,
    architecture,
    status,
    wholeSuite,
    iterations,
    failure: closedFailure(stage, code),
  });
  if (input.platform !== "win32") return fail("blocked", "runner", "platform");
  if (!commitPattern.test(input.commit)) return fail("blocked", "runner", "commit");
  if (input.dirty) return fail("blocked", "runner", "dirty_tree");
  if (input.stateRootSafe === false) return fail("blocked", "runner", "state_root");
  if (input.cleanupSafe === false) return fail("blocked", "runner", "cleanup_uncertain");
  if (input.commitAfter !== undefined && input.commitAfter !== input.commit) {
    return fail("blocked", "runner", "changed_commit");
  }

  const commands = createFixedCommands(
    input.pnpm ?? { command: "pnpm", arguments: [] },
    input.stateRoot,
  );
  const run = async (command) => {
    try {
      if (
        input.getCurrentCommit !== undefined &&
        (await input.getCurrentCommit()) !== input.commit
      ) {
        return { exitCode: -1, changedCommit: true };
      }
      const outcome = await input.execute(command);
      if (
        input.getCurrentCommit !== undefined &&
        (await input.getCurrentCommit()) !== input.commit
      ) {
        return { ...outcome, changedCommit: true };
      }
      return outcome;
    } catch {
      return { exitCode: -1, durationMs: 0, runnerError: true };
    }
  };
  const wholeOutcome = await run(commands.wholeSuite);
  Object.assign(wholeSuite, closedEvidence(wholeOutcome));
  if (wholeOutcome.changedCommit) return fail("blocked", "runner", "changed_commit");
  if (hasUncertainChildClose(wholeOutcome)) return fail("blocked", "runner", "child");
  if (wholeOutcome.timedOut) return fail("fail", "whole_suite", "timeout");

  let wholeCounts;
  try {
    wholeCounts = await input.readWholeSuite({
      resultFile: commands.wholeSuite.resultFile,
      exitCode: wholeOutcome.exitCode,
    });
  } catch (error) {
    const code = isWholeSuiteEvidenceCode(error?.code)
      ? error.code
      : "whole_suite_evidence_malformed";
    return fail("fail", "whole_suite", code);
  }
  Object.assign(wholeSuite, closedEvidence(wholeOutcome, wholeCounts), {
    failedTests: wholeCounts.failedTests,
    failuresTruncated: wholeCounts.failuresTruncated,
  });
  if (wholeOutcome.exitCode !== 0 || wholeSuite.failed !== 0) {
    return fail("fail", "whole_suite", "exit_code");
  }

  for (let ordinal = 1; ordinal <= requestedRuns; ordinal += 1) {
    const packageOutcome = await run(commands.package);
    const packageEvidence = closedEvidence(packageOutcome);
    if (packageOutcome.changedCommit) return fail("blocked", "runner", "changed_commit");
    if (hasUncertainChildClose(packageOutcome)) return fail("blocked", "runner", "child");
    if (packageOutcome.timedOut) {
      iterations.push({ ordinal, package: packageEvidence, packagedBridge: null });
      return fail("fail", "package", "timeout");
    }
    if (packageOutcome.exitCode !== 0) {
      iterations.push({ ordinal, package: packageEvidence, packagedBridge: null });
      return fail("fail", "package", "exit_code");
    }

    const bridgeCommand = commands.packagedBridge(ordinal);
    const bridgeOutcome = await run(bridgeCommand);
    if (bridgeOutcome.changedCommit) return fail("blocked", "runner", "changed_commit");
    const emptyBridge = {
      ...closedEvidence(bridgeOutcome),
      failedTests: [],
      failuresTruncated: false,
    };
    if (hasUncertainChildClose(bridgeOutcome)) {
      iterations.push({ ordinal, package: packageEvidence, packagedBridge: emptyBridge });
      return fail("blocked", "runner", "child");
    }
    if (bridgeOutcome.timedOut) {
      iterations.push({ ordinal, package: packageEvidence, packagedBridge: emptyBridge });
      return fail("fail", "packaged_bridge", "timeout");
    }
    let bridgeCounts;
    try {
      bridgeCounts = await input.readPackagedBridge({
        resultFile: bridgeCommand.resultFile,
        exitCode: bridgeOutcome.exitCode,
        ordinal,
      });
    } catch (error) {
      iterations.push({ ordinal, package: packageEvidence, packagedBridge: emptyBridge });
      const code = isPackagedBridgeEvidenceCode(error?.code)
        ? error.code
        : "packaged_bridge_evidence_malformed";
      return fail("fail", "packaged_bridge", code);
    }
    const bridgeEvidence = {
      ...closedEvidence(bridgeOutcome, bridgeCounts),
      failedTests: bridgeCounts.failedTests,
      failuresTruncated: bridgeCounts.failuresTruncated,
    };
    iterations.push({ ordinal, package: packageEvidence, packagedBridge: bridgeEvidence });
    if (bridgeOutcome.exitCode !== 0 || bridgeEvidence.failed !== 0) {
      return fail("fail", "packaged_bridge", "exit_code");
    }
  }
  return resultFor({
    commit: input.commit,
    architecture,
    status: "pass",
    wholeSuite,
    iterations,
    failure: null,
  });
};

const validateStateRoot = async (stateRoot, canonicalTemporaryRoot) => {
  if (!isAbsolute(stateRoot) || !isContained(canonicalTemporaryRoot, stateRoot)) {
    throw new Error("unsafe_state_root");
  }
  if (!stateDirectoryPattern.test(basename(stateRoot))) {
    throw new Error("unsafe_state_root");
  }
  if (!(await isOrdinaryDirectory(stateRoot))) throw new Error("unsafe_state_root");
  const canonical = await realpath(stateRoot);
  if (!canonicalEqual(canonical, stateRoot) || !isContained(canonicalTemporaryRoot, canonical)) {
    throw new Error("unsafe_state_root");
  }
  const marker = join(canonical, PACKAGED_RELIABILITY_STATE_MARKER);
  if (!(await isOrdinaryFile(marker))) throw new Error("unsafe_state_root");
  if ((await readFile(marker, "utf8")) !== markerContentFor(canonical)) {
    throw new Error("unsafe_state_root");
  }
  return canonical;
};

export const createOwnedStateRoot = async ({
  temporaryRoot: configuredTemporaryRoot = tmpdir(),
  uuid = randomUUID(),
  writeMarker = (path, content) => writeFile(path, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  }),
} = {}) => {
  const temporaryRoot = await realpath(configuredTemporaryRoot);
  if (!(await isOrdinaryDirectory(temporaryRoot))) throw new Error("unsafe_temp");
  const stateRoot = join(temporaryRoot, `intentarc-packaged-reliability-${uuid}`);
  await mkdir(stateRoot, { recursive: false, mode: 0o700 });
  const canonical = await realpath(stateRoot);
  if (!canonicalEqual(canonical, stateRoot)) throw new Error("unsafe_state_root");
  await writeMarker(
    join(canonical, PACKAGED_RELIABILITY_STATE_MARKER),
    markerContentFor(canonical),
  );
  return { stateRoot: await validateStateRoot(canonical, temporaryRoot), temporaryRoot };
};

export const removeOwnedStateRoot = async (stateRoot, temporaryRoot) => {
  const canonical = await validateStateRoot(stateRoot, temporaryRoot);
  await rm(canonical, { recursive: true, force: false, maxRetries: 2 });
};

const resolvePnpmInvocation = async () => {
  const configured = process.env.npm_execpath?.trim();
  if (!configured || !isAbsolute(configured) || !(await isOrdinaryFile(configured))) {
    throw new Error("pnpm");
  }
  const cliPath = await realpath(configured);
  if (!(await isOrdinaryFile(cliPath))) throw new Error("pnpm");
  const entryName = basename(cliPath).toLowerCase();
  if (["pnpm.cjs", "pnpm.js", "pnpm.mjs"].includes(entryName)) {
    if (!isAbsolute(process.execPath) || !(await isOrdinaryFile(process.execPath))) {
      throw new Error("node");
    }
    const nodePath = await realpath(process.execPath);
    if (!(await isOrdinaryFile(nodePath))) throw new Error("node");
    return { command: nodePath, arguments: [cliPath] };
  }
  if (entryName !== "pnpm.exe") throw new Error("pnpm");
  return { command: cliPath, arguments: [] };
};

const runBoundedChild = (command, repositoryRoot, stateRoot) => new Promise((resolveChild) => {
  const startedAt = performance.now();
  let settled = false;
  let drained = 0;
  let exitCode = -1;
  let sawExit = false;
  let runnerError = false;
  let timedOut = false;
  let deadline;
  let closeGrace;
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    if (deadline !== undefined) clearTimeout(deadline);
    if (closeGrace !== undefined) clearTimeout(closeGrace);
    resolveChild({ ...outcome, durationMs: performance.now() - startedAt });
  };
  let child;
  try {
    child = spawn(command.command, command.arguments, {
      cwd: repositoryRoot,
      env: { ...process.env, [PACKAGED_TEST_STATE_DIRECTORY_ENV]: stateRoot },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    finish({ exitCode: -1, runnerError: true });
    return;
  }
  const drain = (chunk) => {
    drained = Math.min(maximumDrainedBytes, drained + Buffer.byteLength(chunk));
  };
  child.stdout?.on("data", drain);
  child.stderr?.on("data", drain);
  child.once("error", () => {
    runnerError = true;
    closeGrace ??= setTimeout(() => {
      finish({ exitCode: -1, runnerError: true, closeUncertain: true });
    }, 5_000);
  });
  child.once("exit", (code) => {
    sawExit = true;
    exitCode = code ?? -1;
  });
  child.once("close", (code) => {
    finish({
      exitCode: code ?? exitCode,
      timedOut,
      runnerError: runnerError || !sawExit,
      closeUncertain: !sawExit,
    });
  });
  deadline = setTimeout(() => {
    timedOut = true;
    child.kill();
    closeGrace = setTimeout(() => {
      finish({ exitCode: -1, timedOut: true, runnerError: true, closeUncertain: true });
    }, 5_000);
  }, childDeadlineMs);
});

const gitTimeoutError = () => Object.assign(new Error("git_timeout"), {
  code: "git_timeout",
  closeUncertain: true,
});

export const runGitCommand = (
  arguments_,
  repositoryRoot,
  { deadlineMs = childDeadlineMs, spawnChild = spawn } = {},
) => new Promise((resolveGit, rejectGit) => {
  let settled = false;
  let sawExit = false;
  let deadline;
  const finish = (action) => {
    if (settled) return;
    settled = true;
    if (deadline !== undefined) clearTimeout(deadline);
    action();
  };
  let child;
  try {
    child = spawnChild("git", arguments_, {
    cwd: repositoryRoot,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  } catch {
    rejectGit(gitTimeoutError());
    return;
  }
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-256); });
  child.once("error", () => finish(() => rejectGit(gitTimeoutError())));
  child.once("exit", () => { sawExit = true; });
  child.once("close", (code) => finish(() => {
    if (!sawExit || code !== 0) {
      rejectGit(Object.assign(new Error("git"), { code: "git", closeUncertain: !sawExit }));
      return;
    }
    resolveGit(output.trim());
  }));
  deadline = setTimeout(() => {
    child.kill();
    finish(() => rejectGit(gitTimeoutError()));
  }, deadlineMs);
});

export const runProduction = async (overrides = {}) => {
  const platform = overrides.platform ?? process.platform;
  const architecture = overrides.architecture ?? process.arch;
  const getRepositoryRoot = overrides.getRepositoryRoot ?? (() => realpath(process.cwd()));
  const runGit = overrides.runGit ?? runGitCommand;
  const createState = overrides.createState ?? createOwnedStateRoot;
  const resolvePnpm = overrides.resolvePnpm ?? resolvePnpmInvocation;
  const readWholeEvidence =
    overrides.readWholeSuiteEvidence ?? readWholeSuiteEvidence;
  const readBridgeEvidence =
    overrides.readPackagedBridgeEvidence ?? readPackagedBridgeEvidence;
  const runChild = overrides.runChild ?? runBoundedChild;
  const removeState = overrides.removeState ?? removeOwnedStateRoot;
  const repositoryRoot = await getRepositoryRoot();
  let commit = "0".repeat(40);
  let state;
  let cleanupSafe = true;
  let result;
  try {
    commit = await runGit(["rev-parse", "HEAD"], repositoryRoot);
    const dirty = (await runGit(["status", "--porcelain"], repositoryRoot)).length > 0;
    if (platform !== "win32" || dirty || !commitPattern.test(commit)) {
      result = await runWindowsPackagedReliability({
        platform,
        architecture,
        commit,
        dirty,
        stateRoot: "",
        stateRootSafe: false,
        execute: async () => ({ exitCode: -1 }),
      });
    } else {
      state = await createState();
      const pnpm = await resolvePnpm();
      result = await runWindowsPackagedReliability({
        platform,
        architecture,
        commit,
        dirty,
        stateRoot: state.stateRoot,
        pnpm,
        readWholeSuite: ({ resultFile, exitCode }) => readWholeEvidence({
          repositoryRoot,
          stateRoot: state.stateRoot,
          resultFile,
          exitCode,
        }),
        readPackagedBridge: ({ resultFile, exitCode, ordinal }) => readBridgeEvidence({
          repositoryRoot,
          stateRoot: state.stateRoot,
          resultFile,
          exitCode,
          ordinal,
        }),
        getCurrentCommit: async () => {
          try {
            return await runGit(["rev-parse", "HEAD"], repositoryRoot);
          } catch (error) {
            if (error?.closeUncertain) cleanupSafe = false;
            throw error;
          }
        },
        execute: async (command) => {
          const outcome = await runChild(command, repositoryRoot, state.stateRoot);
          if (outcome.closeUncertain) cleanupSafe = false;
          return outcome;
        },
      });
    }
  } catch {
    result = resultFor({
      commit,
      architecture,
      status: "blocked",
      wholeSuite: emptyWholeSuiteEvidence(),
      iterations: [],
      failure: closedFailure("runner", "runner"),
    });
  }
  if (state) {
    if (cleanupSafe) {
      try {
        await removeState(state.stateRoot, state.temporaryRoot);
      } catch {
        cleanupSafe = false;
      }
    }
  }
  if (!cleanupSafe) {
    return {
      ...result,
      status: "blocked",
      failure: closedFailure("runner", "cleanup_uncertain"),
    };
  }
  return result;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await runProduction();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "pass" ? 0 : 1;
}
