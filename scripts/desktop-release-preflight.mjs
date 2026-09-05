import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completePreflightReceipt,
  createInitialPreflightReceipt,
  failPreflightReceipt,
  parsePreflightArguments,
  preflightChecks,
  preparePreflightReceiptFailure,
  receiptPathForRun,
  sanitizePreflightEnvironment,
  trackedOnlyStatusScope,
  withCheckState,
} from "./desktop-release-preflight-contract.mjs";
import {
  createPreflightSnapshot,
  runReadOnlyGitGates,
  writePreflightReceipt,
} from "./desktop-release-preflight-evidence.mjs";
import { resolvePnpmLifecycleInvocation } from "./pnpm-lifecycle.mjs";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const childProcessError = "IntentArc preflight child process failed.";

const spawnAndWait = ({
  command,
  arguments: arguments_,
  cwd,
  environment,
}) => new Promise((resolveChild, rejectChild) => {
  let child;
  try {
    child = spawn(command, arguments_, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
  } catch {
    rejectChild(new Error(childProcessError));
    return;
  }
  child.once("error", () => rejectChild(new Error(childProcessError)));
  child.once("close", (code, signal) => {
    if (code === 0 && signal === null) resolveChild();
    else rejectChild(new Error(childProcessError));
  });
});

const initialReceiptFromSnapshot = (runId, statusScope, snapshot) =>
  createInitialPreflightReceipt({
    runId,
    statusScope,
    sourceManifestSha256: snapshot.source.sha256,
    packageJsonSha256: snapshot.packageJsonSha256,
    vendorIdentity: snapshot.vendor.sha256,
    outAbsent: snapshot.outAbsent,
  });

const completionEvidence = (snapshot, git) => ({
  sourceManifestSha256: snapshot.source.sha256,
  packageJsonSha256: snapshot.packageJsonSha256,
  vendorIdentity: snapshot.vendor.sha256,
  outAbsent: snapshot.outAbsent,
  ...git,
});

const gitEvidencePassed = (git, statusScope) =>
  statusScope === trackedOnlyStatusScope &&
  git.diffCheckPassed === true &&
  git.productDiffClean === true &&
  git.statusClean === true &&
  git.statusEntryCount === 0;

export const runDesktopReleasePreflight = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  packageRoot = defaultPackageRoot,
  resolveInvocation = resolvePnpmLifecycleInvocation,
  spawnInvocation = spawnAndWait,
  createSnapshot = createPreflightSnapshot,
  runGitGates = runReadOnlyGitGates,
  writeReceipt = writePreflightReceipt,
} = {}) => {
  const { runId, statusScope } = parsePreflightArguments(argv);
  const receiptPath = receiptPathForRun(packageRoot, runId);
  const childEnvironment = sanitizePreflightEnvironment(environment);
  let receipt;
  let failureCategory = "initial-evidence";

  const persist = async (nextReceipt, nextCategory) => {
    failureCategory = "receipt-write";
    await writeReceipt(receiptPath, nextReceipt);
    receipt = nextReceipt;
    failureCategory = nextCategory;
  };

  try {
    const before = await createSnapshot({ packageRoot });
    receipt = initialReceiptFromSnapshot(runId, statusScope, before);
    await persist(receipt, "initial-evidence");

    if (!before.outAbsent) {
      throw new Error("IntentArc preflight initial evidence failed.");
    }
    failureCategory = "git-gates";
    const gitBefore = await runGitGates({ packageRoot, statusScope });
    if (!gitEvidencePassed(gitBefore, statusScope)) {
      throw new Error("IntentArc preflight initial evidence failed.");
    }
    for (const check of preflightChecks) {
      await persist(withCheckState(receipt, check.id, "running"), check.id);
      const invocation = await resolveInvocation(environment, check.arguments);
      await spawnInvocation({
        ...invocation,
        cwd: packageRoot,
        environment: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: "inherit",
      });
      await persist(withCheckState(receipt, check.id, "passed"), check.id);
    }
    failureCategory = "git-gates";
    const gitAfter = await runGitGates({ packageRoot, statusScope });
    if (!gitEvidencePassed(gitAfter, statusScope)) {
      throw new Error("IntentArc preflight final Git evidence failed.");
    }
    failureCategory = "final-evidence";
    const after = await createSnapshot({ packageRoot });
    const completed = completePreflightReceipt(
      receipt,
      completionEvidence(after, gitAfter),
    );
    await persist(completed, "final-evidence");
    return receipt;
  } catch (error) {
    if (receipt) {
      const prepared = preparePreflightReceiptFailure(receipt, failureCategory);
      const failed = failPreflightReceipt(prepared, failureCategory);
      try {
        await writeReceipt(receiptPath, failed);
      } catch {}
    }
    throw error;
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runDesktopReleasePreflight();
}
