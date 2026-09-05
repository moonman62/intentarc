import { join } from "node:path";

export const preflightCheckIds = Object.freeze([
  "focused-tests",
  "server-typecheck",
  "web-typecheck",
  "adapter-strict",
]);

export const checkStates = Object.freeze([
  "pending", "running", "passed", "failed",
]);

export const failureCategories = Object.freeze([
  "initial-evidence",
  "focused-tests",
  "server-typecheck",
  "web-typecheck",
  "adapter-strict",
  "git-gates",
  "final-evidence",
  "receipt-write",
]);

export const trackedOnlyStatusScope = "tracked-only";

const runIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const receiptError = "IntentArc preflight receipt is invalid.";
const argumentsError = "IntentArc preflight arguments are invalid.";
const releaseEnvironmentKeys = new Set([
  "INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR",
  "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT",
  "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH",
  "INTENTARC_INSTALLER_E2E_SETUP",
  "INTENTARC_RELEASE_BUILD",
  "INTENTARC_RELEASE_TEST_MARKER",
  "INTENTARC_RUN_INSTALLER_E2E",
  "INTENTARC_SIGNATURE_TARGET",
  "INTENTARC_UPDATE_FEED_URL",
  "INTENTARC_WINDOWS_CERTIFICATE",
  "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
  "INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT",
  "WINDOWS_SIGNTOOL_PATH",
]);

const freezeCheck = (id, arguments_) => Object.freeze({
  id,
  arguments: Object.freeze([...arguments_]),
});

export const preflightChecks = Object.freeze([
  freezeCheck("focused-tests", [
    "vitest", "run",
    "src/desktop/e2e/installer-contract.test.ts",
    "src/bridge/package-contract.test.ts",
    "src/desktop/e2e/signed-artifact-bundle.test.ts",
    "src/desktop/e2e/signed-release-once.test.ts",
    "--reporter=dot",
    "--maxWorkers=1",
  ]),
  freezeCheck("server-typecheck", ["typecheck:server"]),
  freezeCheck("web-typecheck", ["typecheck:web"]),
  freezeCheck("adapter-strict", [
    "exec", "tsc", "--ignoreConfig", "--noEmit", "--target", "ES2024",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--allowJs",
    "--checkJs", "false", "--strict", "--skipLibCheck",
    "scripts/forge-bridge-native-signing.ts",
  ]),
]);

const isObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isEnvironmentObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyKeys = (value, keys) => isObject(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

const isSha256 = (value) => typeof value === "string" && sha256Pattern.test(value);
const isBooleanOrNull = (value) => typeof value === "boolean" || value === null;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const invalidReceipt = () => {
  throw new Error(receiptError);
};

const copyReceipt = (receipt) => ({
  ...receipt,
  checks: { ...receipt.checks },
  git: { ...receipt.git },
  source: { ...receipt.source },
  packageJson: { ...receipt.packageJson },
  vendor: { ...receipt.vendor },
  out: { ...receipt.out },
});

const assertIdentity = (identity) => {
  if (
    !hasOnlyKeys(identity, ["before", "after", "unchanged"]) ||
    !isSha256(identity.before) ||
    !(identity.after === null || isSha256(identity.after)) ||
    !isBooleanOrNull(identity.unchanged) ||
    (identity.unchanged !== null && (identity.after === null || !identity.before)) ||
    (identity.unchanged === true && identity.before !== identity.after) ||
    (identity.unchanged === false && identity.before === identity.after)
  ) invalidReceipt();
};

const assertFinalInvariants = (receipt) => {
  if (
    !Object.values(receipt.checks).every((state) => state === "passed") ||
    receipt.git.diffCheckPassed !== true ||
    receipt.git.productDiffClean !== true ||
    receipt.git.statusClean !== true ||
    receipt.git.statusEntryCount !== 0 ||
    receipt.source.unchanged !== true ||
    receipt.packageJson.unchanged !== true ||
    receipt.vendor.unchanged !== true ||
    receipt.out.absentBefore !== true ||
    receipt.out.absentAfter !== true
  ) invalidReceipt();
};

const assertCompletionInput = (input, { partial = false } = {}) => {
  const keys = [
    "sourceManifestSha256",
    "packageJsonSha256",
    "vendorIdentity",
    "outAbsent",
    "diffCheckPassed",
    "productDiffClean",
    "statusClean",
    "statusEntryCount",
  ];
  if (!isObject(input) || Object.keys(input).some((key) => !keys.includes(key))) {
    invalidReceipt();
  }
  if (!partial && !hasOnlyKeys(input, keys)) invalidReceipt();
  const validators = {
    sourceManifestSha256: isSha256,
    packageJsonSha256: isSha256,
    vendorIdentity: isSha256,
    outAbsent: (value) => typeof value === "boolean",
    diffCheckPassed: (value) => typeof value === "boolean",
    productDiffClean: (value) => typeof value === "boolean",
    statusClean: (value) => typeof value === "boolean",
    statusEntryCount: (value) => Number.isInteger(value) && value >= 0 && value <= 1_000_000,
  };
  for (const [key, validator] of Object.entries(validators)) {
    if (hasOwn(input, key) && !validator(input[key])) invalidReceipt();
  }
};

const applyAfter = (receipt, after) => {
  if (after === undefined) return copyReceipt(receipt);
  assertCompletionInput(after, { partial: true });
  const updated = copyReceipt(receipt);
  if (hasOwn(after, "sourceManifestSha256")) {
    updated.source.after = after.sourceManifestSha256;
    updated.source.unchanged = updated.source.before === updated.source.after;
  }
  if (hasOwn(after, "packageJsonSha256")) {
    updated.packageJson.after = after.packageJsonSha256;
    updated.packageJson.unchanged = updated.packageJson.before === updated.packageJson.after;
  }
  if (hasOwn(after, "vendorIdentity")) {
    updated.vendor.after = after.vendorIdentity;
    updated.vendor.unchanged = updated.vendor.before === updated.vendor.after;
  }
  if (hasOwn(after, "outAbsent")) updated.out.absentAfter = after.outAbsent;
  if (hasOwn(after, "diffCheckPassed")) updated.git.diffCheckPassed = after.diffCheckPassed;
  if (hasOwn(after, "productDiffClean")) updated.git.productDiffClean = after.productDiffClean;
  if (hasOwn(after, "statusClean")) updated.git.statusClean = after.statusClean;
  if (hasOwn(after, "statusEntryCount")) updated.git.statusEntryCount = after.statusEntryCount;
  return updated;
};

export const receiptPathForRun = (packageRoot, runId) => {
  if (typeof packageRoot !== "string" || !runIdPattern.test(runId)) {
    throw new Error("IntentArc preflight run ID is invalid.");
  }
  return join(
    packageRoot,
    ".superpowers", "preflight", "desktop-release", `${runId}.json`,
  );
};

export const parsePreflightArguments = (argv) => {
  if (
    !Array.isArray(argv) || argv.length !== 3 ||
    argv[0] !== "--run-id" ||
    typeof argv[1] !== "string" || !runIdPattern.test(argv[1]) ||
    argv[2] !== "--tracked-only"
  ) throw new Error(argumentsError);
  return { runId: argv[1], statusScope: trackedOnlyStatusScope };
};

export const sanitizePreflightEnvironment = (environment) => {
  if (!isEnvironmentObject(environment)) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || releaseEnvironmentKeys.has(key.toUpperCase())) continue;
    Object.defineProperty(sanitized, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sanitized;
};

export const createInitialPreflightReceipt = (input) => {
  if (!hasOnlyKeys(input, [
    "runId", "statusScope", "sourceManifestSha256", "packageJsonSha256",
    "vendorIdentity", "outAbsent",
  ])) invalidReceipt();
  if (
    !runIdPattern.test(input.runId) ||
    input.statusScope !== trackedOnlyStatusScope ||
    !isSha256(input.sourceManifestSha256) ||
    !isSha256(input.packageJsonSha256) ||
    !isSha256(input.vendorIdentity) ||
    typeof input.outAbsent !== "boolean"
  ) invalidReceipt();
  const receipt = {
    schemaVersion: 2,
    runId: input.runId,
    status: "running",
    failureCategory: null,
    checks: Object.fromEntries(preflightCheckIds.map((id) => [id, "pending"])),
    git: {
      statusScope: trackedOnlyStatusScope,
      diffCheckPassed: null,
      productDiffClean: null,
      statusClean: null,
      statusEntryCount: null,
    },
    source: { before: input.sourceManifestSha256, after: null, unchanged: null },
    packageJson: { before: input.packageJsonSha256, after: null, unchanged: null },
    vendor: { before: input.vendorIdentity, after: null, unchanged: null },
    out: { absentBefore: input.outAbsent, absentAfter: null },
  };
  assertWritablePreflightReceipt(receipt);
  return receipt;
};

export const withCheckState = (receipt, checkId, state) => {
  assertWritablePreflightReceipt(receipt);
  if (
    receipt.status !== "running" || !preflightCheckIds.includes(checkId) ||
    !checkStates.includes(state)
  ) invalidReceipt();
  const current = receipt.checks[checkId];
  const transitionAllowed = (current === "pending" && state === "running") ||
    (current === "running" && (state === "passed" || state === "failed"));
  if (!transitionAllowed) invalidReceipt();
  const updated = copyReceipt(receipt);
  updated.checks[checkId] = state;
  assertWritablePreflightReceipt(updated);
  return updated;
};

export const completePreflightReceipt = (receipt, input) => {
  assertWritablePreflightReceipt(receipt);
  if (receipt.status !== "running") invalidReceipt();
  assertCompletionInput(input);
  const updated = applyAfter(receipt, input);
  updated.status = "passed";
  updated.failureCategory = null;
  assertWritablePreflightReceipt(updated);
  return updated;
};

export const preparePreflightReceiptFailure = (receipt, category) => {
  assertWritablePreflightReceipt(receipt);
  if (receipt.status !== "running" || !failureCategories.includes(category)) {
    invalidReceipt();
  }
  if (preflightCheckIds.includes(category) && receipt.checks[category] === "running") {
    return withCheckState(receipt, category, "failed");
  }
  const updated = copyReceipt(receipt);
  assertWritablePreflightReceipt(updated);
  return updated;
};

export const failPreflightReceipt = (receipt, category, after) => {
  assertWritablePreflightReceipt(receipt);
  if (receipt.status !== "running" || !failureCategories.includes(category)) invalidReceipt();
  const updated = applyAfter(receipt, after);
  updated.status = "failed";
  updated.failureCategory = category;
  assertWritablePreflightReceipt(updated);
  return updated;
};

const assertPreflightReceiptV1 = (receipt) => {
  if (
    !hasOnlyKeys(receipt, [
      "schemaVersion", "runId", "status", "failureCategory", "checks", "git", "source",
      "packageJson", "vendor", "out",
    ]) ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.runId !== "string" || !runIdPattern.test(receipt.runId) ||
    !["running", "passed", "failed"].includes(receipt.status) ||
    !(receipt.failureCategory === null || failureCategories.includes(receipt.failureCategory)) ||
    !hasOnlyKeys(receipt.checks, preflightCheckIds) ||
    !Object.values(receipt.checks).every((state) => checkStates.includes(state)) ||
    !hasOnlyKeys(receipt.git, [
      "diffCheckPassed", "productDiffClean", "statusClean", "statusEntryCount",
    ]) ||
    !isBooleanOrNull(receipt.git.diffCheckPassed) ||
    !isBooleanOrNull(receipt.git.productDiffClean) ||
    !isBooleanOrNull(receipt.git.statusClean) ||
    !(receipt.git.statusEntryCount === null || (
      Number.isInteger(receipt.git.statusEntryCount) &&
      receipt.git.statusEntryCount >= 0 && receipt.git.statusEntryCount <= 1_000_000
    )) ||
    !hasOnlyKeys(receipt.out, ["absentBefore", "absentAfter"]) ||
    typeof receipt.out.absentBefore !== "boolean" ||
    !isBooleanOrNull(receipt.out.absentAfter)
  ) invalidReceipt();
  assertIdentity(receipt.source);
  assertIdentity(receipt.packageJson);
  assertIdentity(receipt.vendor);
  if (
    (receipt.status === "running" && receipt.failureCategory !== null) ||
    (receipt.status === "passed" && receipt.failureCategory !== null) ||
    (receipt.status === "failed" && receipt.failureCategory === null)
  ) invalidReceipt();
  if (receipt.status === "passed") assertFinalInvariants(receipt);
};

const assertPreflightReceiptV2 = (receipt) => {
  if (
    !hasOnlyKeys(receipt, [
      "schemaVersion", "runId", "status", "failureCategory", "checks", "git", "source",
      "packageJson", "vendor", "out",
    ]) ||
    receipt.schemaVersion !== 2 ||
    typeof receipt.runId !== "string" || !runIdPattern.test(receipt.runId) ||
    !["running", "passed", "failed"].includes(receipt.status) ||
    !(receipt.failureCategory === null || failureCategories.includes(receipt.failureCategory)) ||
    !hasOnlyKeys(receipt.checks, preflightCheckIds) ||
    !Object.values(receipt.checks).every((state) => checkStates.includes(state)) ||
    !hasOnlyKeys(receipt.git, [
      "statusScope", "diffCheckPassed", "productDiffClean", "statusClean", "statusEntryCount",
    ]) ||
    receipt.git.statusScope !== trackedOnlyStatusScope ||
    !isBooleanOrNull(receipt.git.diffCheckPassed) ||
    !isBooleanOrNull(receipt.git.productDiffClean) ||
    !isBooleanOrNull(receipt.git.statusClean) ||
    !(receipt.git.statusEntryCount === null || (
      Number.isInteger(receipt.git.statusEntryCount) &&
      receipt.git.statusEntryCount >= 0 && receipt.git.statusEntryCount <= 1_000_000
    )) ||
    !hasOnlyKeys(receipt.out, ["absentBefore", "absentAfter"]) ||
    typeof receipt.out.absentBefore !== "boolean" ||
    !isBooleanOrNull(receipt.out.absentAfter)
  ) invalidReceipt();
  assertIdentity(receipt.source);
  assertIdentity(receipt.packageJson);
  assertIdentity(receipt.vendor);
  if (
    (receipt.status === "running" && receipt.failureCategory !== null) ||
    (receipt.status === "passed" && receipt.failureCategory !== null) ||
    (receipt.status === "failed" && receipt.failureCategory === null)
  ) invalidReceipt();
  if (receipt.status === "passed") assertFinalInvariants(receipt);
};

export const assertPreflightReceipt = (receipt) => {
  if (!isObject(receipt)) invalidReceipt();
  if (receipt.schemaVersion === 1) {
    assertPreflightReceiptV1(receipt);
    return;
  }
  if (receipt.schemaVersion === 2) {
    assertPreflightReceiptV2(receipt);
    return;
  }
  invalidReceipt();
};

export const assertWritablePreflightReceipt = (receipt) => {
  if (!isObject(receipt) || receipt.schemaVersion !== 2) invalidReceipt();
  assertPreflightReceiptV2(receipt);
};
