import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { promisify } from "node:util";
import {
  bridgeBuildIdentity,
  type BridgeBuildIdentity,
} from "../system/bridge-build-identity.js";
import { resolveWindowsPowerShellInvocation } from "../system/windows-powershell.js";
export type { BridgeBuildIdentity } from "../system/bridge-build-identity.js";

const executeFile = promisify(execFile);
const BRIDGE_EXECUTABLE_NAME = "IntentArc Bridge.exe";
const BRIDGE_POINTER_NAME = "current-version.json";
const BRIDGE_MANIFEST_NAME = "intentarc-bridge-release.json";
const BRIDGE_PENDING_NAME = "pending-launcher-update.json";
const BRIDGE_RECOVERY_NAME = "activation-recovery.json";
export const BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY =
  "INTENTARC_BRIDGE_ACTIVATION_TRANSACTION_OWNER";
const versionPattern = /^\d+\.\d+\.\d+$/;
const versionDirectoryPattern = /^\d+\.\d+\.\d+-[a-f0-9]{16}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const transactionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BridgePublisherIdentity {
  readonly thumbprint: string;
  readonly subject: string;
}

export interface BridgeAuthenticatedIdentity extends BridgeBuildIdentity {
  readonly publisher?: BridgePublisherIdentity;
}

export interface BridgeReleaseManifest extends BridgeBuildIdentity {
  readonly formatVersion: 1;
  readonly versionDirectory: string;
  readonly executableSha256: string;
  readonly payloadSha256: string;
  readonly publisher?: BridgePublisherIdentity;
}

export interface BridgePayloadVerification {
  readonly phase: "staged" | "active";
  readonly executablePath: string;
  readonly versionDirectory: string;
  readonly binaryRoot: string;
  readonly activationTransaction?: BridgeActivationTransaction;
}

export interface BridgeActivationTransaction {
  readonly transactionId: string;
  readonly phase: "active-verification";
}

export interface BridgePointer {
  readonly binaryRoot: string;
  readonly currentDirectory: string;
  readonly versionDirectory: string;
  readonly executablePath: string;
}

export interface StableLauncherReplacement {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly rollbackPath: string;
}

export interface InstallBridgeVersionInput {
  readonly binaryRoot: string;
  readonly payloadPath: string;
  readonly version: string;
  readonly verify: (
    input: BridgePayloadVerification,
  ) => Promise<BridgeAuthenticatedIdentity | void>;
  readonly replaceStableLauncher?: (
    input: StableLauncherReplacement,
  ) => Promise<void>;
  readonly inspectLauncherIdentity?: (
    executablePath: string,
  ) => Promise<BridgeAuthenticatedIdentity>;
  readonly inspectCandidatePredecessor?: (
    executablePath: string,
  ) => Promise<BridgeReleaseManifest | null>;
  readonly signal?: AbortSignal;
}

export interface InstallBridgeVersionResult extends BridgePointer {
  readonly removedVersionDirectories: readonly string[];
  readonly pendingLauncherUpdate: boolean;
}

export interface RepairBridgePointerInput {
  readonly binaryRoot: string;
  readonly versionDirectory: string;
  readonly verify: InstallBridgeVersionInput["verify"];
  readonly replaceStableLauncher?: InstallBridgeVersionInput["replaceStableLauncher"];
  readonly inspectLauncherIdentity?: InstallBridgeVersionInput["inspectLauncherIdentity"];
  readonly inspectCandidatePredecessor?: InstallBridgeVersionInput["inspectCandidatePredecessor"];
}

export interface RecoverBridgeActivationInput {
  readonly binaryRoot: string;
  readonly verify: InstallBridgeVersionInput["verify"];
  readonly replaceStableLauncher?: InstallBridgeVersionInput["replaceStableLauncher"];
  readonly inspectLauncherIdentity?: InstallBridgeVersionInput["inspectLauncherIdentity"];
  readonly inspectCandidatePredecessor?: InstallBridgeVersionInput["inspectCandidatePredecessor"];
}

export interface ResolveStableBridgeTargetOptions {
  readonly launcherIdentity?: BridgeBuildIdentity;
  readonly authenticateLauncher?: (
    executablePath: string,
  ) => Promise<BridgePublisherIdentity>;
  readonly authenticateTarget?: (
    executablePath: string,
  ) => Promise<BridgeAuthenticatedIdentity>;
}

export interface AuthenticatedBridgeLaunch {
  readonly targetPath: string;
  readonly executableSha256: string;
  readonly identity: BridgeAuthenticatedIdentity;
}

interface BridgeRoots {
  readonly binaryRoot: string;
  readonly bridgeRoot: string;
  readonly versionsRoot: string;
  readonly currentDirectory: string;
  readonly pointerPath: string;
  readonly pendingPath: string;
  readonly recoveryPath: string;
}

interface BridgeActivationRecovery extends BridgeActivationTransaction {
  readonly formatVersion: 2;
  readonly previous: BridgeReleaseManifest | null;
  readonly candidate: BridgeReleaseManifest;
  readonly rollbackFile: string;
}

const hasCode = (error: unknown, ...codes: string[]): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  codes.includes((error as NodeJS.ErrnoException).code ?? "");

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
};

const assertContained = (
  root: string,
  candidate: string,
  label: string,
): void => {
  const child = relative(root, candidate);
  if (
    child === "" ||
    (!isAbsolute(child) &&
      child !== ".." &&
      !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  ) {
    return;
  }
  throw new Error(
    `IntentArc bridge ${label} is outside the application binary root.`,
  );
};

const assertOrdinaryDirectory = async (
  path: string,
  label: string,
): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`IntentArc bridge ${label} must be an ordinary directory.`);
  }
};

const ensureOrdinaryChildDirectory = async (
  parent: string,
  name: string,
  label: string,
): Promise<string> => {
  await assertOrdinaryDirectory(parent, `${label} parent`);
  const path = join(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await assertOrdinaryDirectory(parent, `${label} parent`);
  await assertOrdinaryDirectory(path, label);
  const canonicalParent = await realpath(parent);
  const canonicalPath = await realpath(path);
  if (dirname(canonicalPath).toLowerCase() !== canonicalParent.toLowerCase()) {
    throw new Error(`IntentArc bridge ${label} is outside its expected parent.`);
  }
  return canonicalPath;
};

const prepareRoots = async (binaryRoot: string): Promise<BridgeRoots> => {
  if (!isAbsolute(binaryRoot)) {
    throw new Error("IntentArc application binary root must be absolute.");
  }
  await mkdir(binaryRoot, { recursive: true });
  await assertOrdinaryDirectory(binaryRoot, "binary root");
  const canonicalBinaryRoot = await realpath(binaryRoot);
  const bridgeRoot = await ensureOrdinaryChildDirectory(
    canonicalBinaryRoot,
    "bridge",
    "root",
  );
  const versionsRoot = await ensureOrdinaryChildDirectory(
    bridgeRoot,
    "versions",
    "versions root",
  );
  assertContained(canonicalBinaryRoot, versionsRoot, "versions root");
  return {
    binaryRoot: canonicalBinaryRoot,
    bridgeRoot,
    versionsRoot,
    currentDirectory: join(bridgeRoot, "current"),
    pointerPath: join(bridgeRoot, BRIDGE_POINTER_NAME),
    pendingPath: join(bridgeRoot, BRIDGE_PENDING_NAME),
    recoveryPath: join(bridgeRoot, BRIDGE_RECOVERY_NAME),
  };
};

interface BridgeDirectoryPromotionPathInfo {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface BridgeDirectoryPromotionDependencies {
  readonly platform: NodeJS.Platform;
  readonly rename: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<BridgeDirectoryPromotionPathInfo>;
  readonly realpath: (path: string) => Promise<string>;
  readonly now: () => number;
  readonly wait: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface BridgeDirectoryPromotionInput {
  readonly bridgeRoot: string;
  readonly versionsRoot: string;
  readonly stagingDirectory: string;
  readonly versionDirectory: string;
  readonly baseline: BridgeDirectoryPromotionBaseline;
  readonly signal?: AbortSignal;
}

export interface BridgeDirectoryPromotionPathIdentity {
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface BridgeDirectoryPromotionBaseline {
  readonly bridgeRoot: BridgeDirectoryPromotionPathIdentity;
  readonly versionsRoot: BridgeDirectoryPromotionPathIdentity;
  readonly stagingDirectory: BridgeDirectoryPromotionPathIdentity;
}

const throwIfPromotionAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("IntentArc bridge promotion was aborted.");
  error.name = "AbortError";
  throw error;
};

const waitForPromotion = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => new Promise((resolve, reject) => {
  try {
    throwIfPromotionAborted(signal);
  } catch (error) {
    reject(error);
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  const onAbort = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      throwIfPromotionAborted(signal);
    } catch (error) {
      reject(error);
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
});

const defaultBridgeDirectoryPromotionDependencies:
  BridgeDirectoryPromotionDependencies = {
    platform: process.platform,
    rename,
    lstat: (path) => lstat(path, { bigint: true }),
    realpath,
    now: () => performance.now(),
    wait: waitForPromotion,
  };

const promotionPathEquals = (
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean => platform === "win32"
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

const inspectPromotionOrdinaryDirectory = async (
  path: string,
  label: string,
  dependencies: BridgeDirectoryPromotionDependencies,
): Promise<BridgeDirectoryPromotionPathInfo> => {
  const info = await dependencies.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `IntentArc bridge promotion ${label} must be an ordinary directory.`,
    );
  }
  return info;
};

const assertPromotionPathIdentity = (
  retained: BridgeDirectoryPromotionPathIdentity,
  observed: BridgeDirectoryPromotionPathInfo,
  canonicalPath: string,
  label: string,
  platform: NodeJS.Platform,
): void => {
  if (
    retained.dev !== observed.dev ||
    retained.ino !== observed.ino ||
    !promotionPathEquals(retained.canonicalPath, canonicalPath, platform)
  ) {
    throw new Error(
      `IntentArc bridge promotion ${label} identity changed.`,
    );
  }
};

const captureBridgeDirectoryPromotionPathIdentity = async (
  path: string,
  label: string,
): Promise<BridgeDirectoryPromotionPathIdentity> => {
  const info = await inspectPromotionOrdinaryDirectory(
    path,
    label,
    defaultBridgeDirectoryPromotionDependencies,
  );
  return {
    canonicalPath: await realpath(path),
    dev: info.dev,
    ino: info.ino,
  };
};

export const promoteBridgeStagingDirectory = async (
  input: BridgeDirectoryPromotionInput,
  dependencies: BridgeDirectoryPromotionDependencies =
    defaultBridgeDirectoryPromotionDependencies,
): Promise<void> => {
  const stagingName = basename(input.stagingDirectory);
  const versionName = basename(input.versionDirectory);
  if (
    !stagingName.startsWith(".staging-") ||
    !versionDirectoryPattern.test(versionName) ||
    !promotionPathEquals(
      dirname(input.stagingDirectory),
      input.bridgeRoot,
      dependencies.platform,
    ) ||
    !promotionPathEquals(
      dirname(input.versionsRoot),
      input.bridgeRoot,
      dependencies.platform,
    ) ||
    basename(input.versionsRoot).toLowerCase() !== "versions" ||
    !promotionPathEquals(
      dirname(input.versionDirectory),
      input.versionsRoot,
      dependencies.platform,
    )
  ) {
    throw new Error(
      "IntentArc bridge promotion paths are outside their expected roots.",
    );
  }

  const provePromotionPaths = async (): Promise<void> => {
    throwIfPromotionAborted(input.signal);
    const bridgeRootInfo = await inspectPromotionOrdinaryDirectory(
      input.bridgeRoot,
      "root",
      dependencies,
    );
    const canonicalBridgeRoot = await dependencies.realpath(input.bridgeRoot);
    assertPromotionPathIdentity(
      input.baseline.bridgeRoot,
      bridgeRootInfo,
      canonicalBridgeRoot,
      "root",
      dependencies.platform,
    );
    const versionsRootInfo = await inspectPromotionOrdinaryDirectory(
      input.versionsRoot,
      "versions root",
      dependencies,
    );
    const canonicalVersionsRoot = await dependencies.realpath(input.versionsRoot);
    assertPromotionPathIdentity(
      input.baseline.versionsRoot,
      versionsRootInfo,
      canonicalVersionsRoot,
      "versions root",
      dependencies.platform,
    );
    if (
      !promotionPathEquals(
        canonicalBridgeRoot,
        input.bridgeRoot,
        dependencies.platform,
      ) ||
      !promotionPathEquals(
        canonicalVersionsRoot,
        input.versionsRoot,
        dependencies.platform,
      ) ||
      !promotionPathEquals(
        dirname(canonicalVersionsRoot),
        canonicalBridgeRoot,
        dependencies.platform,
      )
    ) {
      throw new Error(
        "IntentArc bridge promotion root canonical identity changed.",
      );
    }

    const stagingInfo = await inspectPromotionOrdinaryDirectory(
      input.stagingDirectory,
      "staging source",
      dependencies,
    );
    const canonicalStaging = await dependencies.realpath(
      input.stagingDirectory,
    );
    assertPromotionPathIdentity(
      input.baseline.stagingDirectory,
      stagingInfo,
      canonicalStaging,
      "staging source",
      dependencies.platform,
    );
    if (
      !promotionPathEquals(
        dirname(canonicalStaging),
        canonicalBridgeRoot,
        dependencies.platform,
      ) ||
      basename(canonicalStaging) !== stagingName ||
      !promotionPathEquals(
        canonicalStaging,
        input.baseline.stagingDirectory.canonicalPath,
        dependencies.platform,
      )
    ) {
      throw new Error(
        "IntentArc bridge promotion staging canonical identity changed.",
      );
    }
    try {
      await dependencies.lstat(input.versionDirectory);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    throw new Error(
      "IntentArc bridge promotion destination already exists.",
    );
  };

  const waits = [25, 50, 100, 200, 400, 400, 400] as const;
  const deadline = dependencies.now() + 2_000;
  let firstError: unknown;
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    throwIfPromotionAborted(input.signal);
    await provePromotionPaths();
    throwIfPromotionAborted(input.signal);
    if (dependencies.now() >= deadline) {
      if (firstError !== undefined) throw firstError;
      throw new Error(
        "IntentArc bridge promotion deadline elapsed before rename.",
      );
    }
    try {
      await dependencies.rename(
        input.stagingDirectory,
        input.versionDirectory,
      );
      return;
    } catch (error) {
      if (
        dependencies.platform !== "win32" ||
        !hasCode(error, "EPERM")
      ) {
        throw error;
      }
      firstError ??= error;
      if (attempt === waits.length) throw firstError;
      throwIfPromotionAborted(input.signal);
      const remaining = deadline - dependencies.now();
      if (remaining <= 0) throw firstError;
      const wait = Math.min(waits[attempt]!, remaining);
      throwIfPromotionAborted(input.signal);
      await dependencies.wait(wait, input.signal);
      throwIfPromotionAborted(input.signal);
      if (dependencies.now() >= deadline) throw firstError;
    }
  }
  throw firstError;
};

const sortedEntries = async (
  root: string,
  directory = root,
  excludedNames: ReadonlySet<string> = new Set(),
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en")
  )) {
    if (directory === root && excludedNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(
        "IntentArc bridge payload cannot contain symbolic links or reparse points.",
      );
    }
    if (info.isDirectory()) {
      paths.push(...await sortedEntries(root, path, excludedNames));
    } else if (info.isFile()) {
      paths.push(path);
    } else {
      throw new Error(
        "IntentArc bridge payload contains an unsupported filesystem entry.",
      );
    }
  }
  return paths;
};

const treeDigest = async (
  root: string,
  excludedNames: ReadonlySet<string> = new Set(),
): Promise<string> => {
  await assertOrdinaryDirectory(root, "payload");
  const hash = createHash("sha256");
  const files = await sortedEntries(root, root, excludedNames);
  if (files.length === 0) {
    throw new Error("IntentArc bridge payload is empty.");
  }
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const fileDigest = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const supportDigest = async (versionDirectory: string): Promise<string> => {
  const supportRoot = join(
    versionDirectory,
    "node_modules",
    "better-sqlite3",
  );
  return treeDigest(supportRoot);
};

const copyPayload = async (
  source: string,
  destination: string,
): Promise<void> => {
  await mkdir(destination);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      throw new Error(
        "IntentArc bridge payload cannot contain symbolic links or reparse points.",
      );
    }
    if (info.isDirectory()) {
      await copyPayload(sourcePath, destinationPath);
    } else if (info.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(
        "IntentArc bridge payload contains an unsupported filesystem entry.",
      );
    }
  }
};

const assertRegularFile = async (path: string, label: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`IntentArc bridge ${label} is missing or malformed.`);
  }
};

const assertVersionDirectory = async (
  roots: BridgeRoots,
  versionDirectory: string,
): Promise<string> => {
  if (!isAbsolute(versionDirectory)) {
    throw new Error("IntentArc bridge version directory must be absolute.");
  }
  await assertOrdinaryDirectory(versionDirectory, "version directory");
  const canonical = await realpath(versionDirectory);
  assertContained(roots.binaryRoot, canonical, "version directory");
  assertContained(roots.versionsRoot, canonical, "version directory");
  if (
    dirname(canonical).toLowerCase() !== roots.versionsRoot.toLowerCase() ||
    !versionDirectoryPattern.test(basename(canonical))
  ) {
    throw new Error(
      "IntentArc bridge version directory is outside the versions root.",
    );
  }
  await assertRegularFile(
    join(canonical, BRIDGE_EXECUTABLE_NAME),
    "executable",
  );
  return canonical;
};

const pointerFor = (
  roots: BridgeRoots,
  versionDirectory: string,
): BridgePointer => ({
  binaryRoot: roots.binaryRoot,
  currentDirectory: roots.currentDirectory,
  versionDirectory,
  executablePath: join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME),
});

const isPublisher = (value: unknown): value is BridgePublisherIdentity =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "subject,thumbprint" &&
  typeof (value as Record<string, unknown>).thumbprint === "string" &&
  /^[A-Fa-f0-9]{4,128}$/.test(
    (value as { thumbprint: string }).thumbprint,
  ) &&
  typeof (value as Record<string, unknown>).subject === "string" &&
  (value as { subject: string }).subject.length > 0 &&
  (value as { subject: string }).subject.length <= 1024;

const parseManifestValue = (
  value: unknown,
  label: "manifest" | "pointer",
): BridgeReleaseManifest => {
  const keys = [
    "buildMode",
    "executableSha256",
    "formatVersion",
    "payloadSha256",
    "releaseVersion",
    "supportSha256",
    "versionDirectory",
    ...(typeof value === "object" &&
        value !== null &&
        "publisher" in value
      ? ["publisher"]
      : []),
  ].sort().join(",");
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys ||
    (value as Record<string, unknown>).formatVersion !== 1 ||
    typeof (value as Record<string, unknown>).versionDirectory !== "string" ||
    !versionDirectoryPattern.test(
      (value as { versionDirectory: string }).versionDirectory,
    ) ||
    typeof (value as Record<string, unknown>).releaseVersion !== "string" ||
    !versionPattern.test((value as { releaseVersion: string }).releaseVersion) ||
    !["signed-release", "unsigned-development"].includes(
      String((value as Record<string, unknown>).buildMode),
    ) ||
    typeof (value as Record<string, unknown>).executableSha256 !== "string" ||
    !sha256Pattern.test(
      (value as { executableSha256: string }).executableSha256,
    ) ||
    typeof (value as Record<string, unknown>).payloadSha256 !== "string" ||
    !sha256Pattern.test((value as { payloadSha256: string }).payloadSha256) ||
    typeof (value as Record<string, unknown>).supportSha256 !== "string" ||
    !sha256Pattern.test((value as { supportSha256: string }).supportSha256) ||
    ("publisher" in value && !isPublisher(value.publisher))
  ) {
    throw new Error(`IntentArc bridge current ${label} is malformed.`);
  }
  return value as BridgeReleaseManifest;
};

const parseDocument = (
  source: string,
  label: "manifest" | "pointer",
): BridgeReleaseManifest => {
  if (Buffer.byteLength(source, "utf8") > 4096) {
    throw new Error(`IntentArc bridge current ${label} is malformed.`);
  }
  try {
    return parseManifestValue(JSON.parse(source), label);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("IntentArc bridge current")
    ) {
      throw error;
    }
    throw new Error(`IntentArc bridge current ${label} is malformed.`);
  }
};

const serializeDocument = (manifest: BridgeReleaseManifest): string =>
  `${JSON.stringify(manifest)}\n`;

const parseRecoveryDocument = (source: string): BridgeActivationRecovery => {
  if (Buffer.byteLength(source, "utf8") > 16 * 1024) {
    throw new Error("IntentArc bridge activation recovery is malformed.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("IntentArc bridge activation recovery is malformed.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "candidate,formatVersion,phase,previous,rollbackFile,transactionId" ||
    (value as Record<string, unknown>).formatVersion !== 2 ||
    (value as Record<string, unknown>).phase !== "active-verification" ||
    typeof (value as Record<string, unknown>).transactionId !== "string" ||
    !transactionIdPattern.test(
      (value as { transactionId: string }).transactionId,
    ) ||
    typeof (value as Record<string, unknown>).rollbackFile !== "string" ||
    !/^\.launcher-rollback-[0-9a-f-]+\.exe$/i.test(
      (value as { rollbackFile: string }).rollbackFile,
    )
  ) {
    throw new Error("IntentArc bridge activation recovery is malformed.");
  }
  try {
    const recovery = value as {
      candidate: unknown;
      previous: unknown;
      rollbackFile: string;
      transactionId: string;
    };
    return {
      formatVersion: 2,
      transactionId: recovery.transactionId,
      phase: "active-verification",
      candidate: parseManifestValue(recovery.candidate, "manifest"),
      previous: recovery.previous === null
        ? null
        : parseManifestValue(recovery.previous, "manifest"),
      rollbackFile: recovery.rollbackFile,
    };
  } catch {
    throw new Error("IntentArc bridge activation recovery is malformed.");
  }
};

const readInstalledManifest = async (
  roots: BridgeRoots,
  versionDirectory: string,
): Promise<BridgeReleaseManifest> => {
  const manifestPath = join(versionDirectory, BRIDGE_MANIFEST_NAME);
  await assertRegularFile(manifestPath, "release manifest");
  const manifest = parseDocument(
    await readFile(manifestPath, "utf8"),
    "manifest",
  );
  if (manifest.versionDirectory !== basename(versionDirectory)) {
    throw new Error(
      "IntentArc bridge pointer and release manifest do not identify the same version.",
    );
  }
  const executablePath = join(versionDirectory, BRIDGE_EXECUTABLE_NAME);
  if (await fileDigest(executablePath) !== manifest.executableSha256) {
    throw new Error("IntentArc bridge executable digest does not match its manifest.");
  }
  if (
    await treeDigest(
      versionDirectory,
      new Set([BRIDGE_MANIFEST_NAME]),
    ) !== manifest.payloadSha256
  ) {
    throw new Error("IntentArc bridge payload digest does not match its manifest.");
  }
  if (await supportDigest(versionDirectory) !== manifest.supportSha256) {
    throw new Error("IntentArc bridge support digest does not match its manifest.");
  }
  return manifest;
};

const assertStableLauncher = async (roots: BridgeRoots): Promise<void> => {
  await assertOrdinaryDirectory(
    roots.currentDirectory,
    "stable launcher directory",
  );
  await assertRegularFile(
    join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME),
    "stable launcher",
  );
};

const readPointerWithRoots = async (
  roots: BridgeRoots,
): Promise<BridgePointer & { readonly manifest: BridgeReleaseManifest }> => {
  await assertStableLauncher(roots);
  await assertRegularFile(roots.pointerPath, "current pointer");
  const pointerManifest = parseDocument(
    await readFile(roots.pointerPath, "utf8"),
    "pointer",
  );
  await assertOrdinaryDirectory(roots.bridgeRoot, "root");
  const versionDirectory = await assertVersionDirectory(
    roots,
    join(roots.versionsRoot, pointerManifest.versionDirectory),
  );
  const installedManifest = await readInstalledManifest(
    roots,
    versionDirectory,
  );
  if (
    serializeDocument(pointerManifest) !== serializeDocument(installedManifest)
  ) {
    throw new Error(
      "IntentArc bridge pointer and release manifest metadata do not match.",
    );
  }
  return {
    ...pointerFor(roots, versionDirectory),
    manifest: installedManifest,
  };
};

export const readBridgePointer = async (
  input: { readonly binaryRoot: string },
): Promise<BridgePointer> =>
  readPointerWithRoots(await prepareRoots(input.binaryRoot));

const compareVersions = (left: string, right: string): number => {
  if (!versionPattern.test(left) || !versionPattern.test(right)) {
    throw new Error("IntentArc bridge release version is malformed.");
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) {
      return leftParts[index]! - rightParts[index]!;
    }
  }
  return 0;
};

export const readAuthenticodePublisher = async (
  path: string,
): Promise<BridgePublisherIdentity> => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('INTENTARC_SIGNATURE_TARGET', 'Process')",
    "$signature = Get-AuthenticodeSignature -LiteralPath $target",
    "if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { exit 2 }",
    "[Console]::Out.WriteLine($signature.SignerCertificate.Thumbprint)",
    "[Console]::Out.WriteLine($signature.SignerCertificate.Subject)",
  ].join("; ");
  const powerShell = resolveWindowsPowerShellInvocation(process.env);
  let stdout: string;
  try {
    ({ stdout } = await executeFile(powerShell.executablePath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      env: {
        ...powerShell.environment,
        INTENTARC_SIGNATURE_TARGET: path,
      },
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new Error("IntentArc bridge requires a valid Authenticode signature.");
  }
  const [thumbprint, ...subjectParts] = stdout.trim().split(/\r?\n/);
  const publisher = {
    thumbprint: thumbprint ?? "",
    subject: subjectParts.join("\n"),
  };
  if (!isPublisher(publisher)) {
    throw new Error("IntentArc bridge Authenticode publisher is malformed.");
  }
  return publisher;
};

export const readEmbeddedBridgeIdentity = async (
  executablePath: string,
): Promise<BridgeBuildIdentity> => {
  let stdout: string;
  try {
    ({ stdout } = await executeFile(executablePath, ["--bridge-identity"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
      env: process.env,
    }));
  } catch {
    throw new Error("IntentArc bridge embedded release identity is unavailable.");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("IntentArc bridge embedded release identity is malformed.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "buildMode,formatVersion,releaseVersion,supportSha256" ||
    (value as Record<string, unknown>).formatVersion !== 1 ||
    typeof (value as Record<string, unknown>).releaseVersion !== "string" ||
    !versionPattern.test((value as { releaseVersion: string }).releaseVersion) ||
    !["signed-release", "unsigned-development"].includes(
      String((value as Record<string, unknown>).buildMode),
    ) ||
    typeof (value as Record<string, unknown>).supportSha256 !== "string" ||
    !sha256Pattern.test((value as { supportSha256: string }).supportSha256)
  ) {
    throw new Error("IntentArc bridge embedded release identity is malformed.");
  }
  return value as BridgeBuildIdentity;
};

export const readEmbeddedBridgeAuthorizedPredecessor = async (
  executablePath: string,
): Promise<BridgeReleaseManifest | null> => {
  let stdout: string;
  try {
    ({ stdout } = await executeFile(
      executablePath,
      ["--bridge-authorized-predecessor"],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4096,
        env: process.env,
      },
    ));
  } catch {
    throw new Error(
      "IntentArc bridge embedded predecessor authorization is unavailable.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      "IntentArc bridge embedded predecessor authorization is malformed.",
    );
  }
  if (value === null) return null;
  try {
    return parseManifestValue(value, "manifest");
  } catch {
    throw new Error(
      "IntentArc bridge embedded predecessor authorization is malformed.",
    );
  }
};

const samePublisher = (
  left: BridgePublisherIdentity,
  right: BridgePublisherIdentity,
): boolean =>
  left.thumbprint.toUpperCase() === right.thumbprint.toUpperCase() &&
  left.subject === right.subject;

export const inspectIntrinsicBridgeIdentity = async (
  executablePath: string,
): Promise<BridgeAuthenticatedIdentity> => {
  const identity = await readEmbeddedBridgeIdentity(executablePath);
  if (identity.buildMode === "signed-release") {
    return {
      ...identity,
      publisher: await readAuthenticodePublisher(executablePath),
    };
  }
  return identity;
};

const identityMatchesManifest = (
  identity: BridgeAuthenticatedIdentity,
  manifest: BridgeReleaseManifest,
): boolean =>
  identity.releaseVersion === manifest.releaseVersion &&
  identity.buildMode === manifest.buildMode &&
  identity.supportSha256 === manifest.supportSha256 &&
  (
    identity.buildMode === "signed-release"
      ? identity.publisher !== undefined &&
        manifest.publisher !== undefined &&
        samePublisher(identity.publisher, manifest.publisher)
      : identity.publisher === undefined && manifest.publisher === undefined
  );

const assertIdentityMatchesManifest = (
  identity: BridgeAuthenticatedIdentity,
  manifest: BridgeReleaseManifest,
  label: string,
): void => {
  if (!identityMatchesManifest(identity, manifest)) {
    throw new Error(
      `IntentArc bridge ${label} identity does not match authenticated release metadata.`,
    );
  }
};

const assertAuthorizedSuccessor = (
  current: BridgeAuthenticatedIdentity,
  candidate: BridgeReleaseManifest,
): void => {
  if (candidate.buildMode !== current.buildMode) {
    throw new Error(
      "IntentArc bridge update cannot change authenticated release mode.",
    );
  }
  if (
    current.buildMode === "signed-release" &&
    (
      !current.publisher ||
      !candidate.publisher ||
      !samePublisher(current.publisher, candidate.publisher)
    )
  ) {
    throw new Error(
      "IntentArc bridge update publisher does not match the trusted installed launcher.",
    );
  }
};

export const authenticateStableBridgeTarget = async (
  executablePath = process.execPath,
  options: ResolveStableBridgeTargetOptions = {},
): Promise<AuthenticatedBridgeLaunch | undefined> => {
  if (
    !isAbsolute(executablePath) ||
    basename(executablePath).toLowerCase() !==
      BRIDGE_EXECUTABLE_NAME.toLowerCase()
  ) {
    return undefined;
  }
  const currentDirectory = dirname(executablePath);
  const bridgeRoot = dirname(currentDirectory);
  if (
    basename(currentDirectory).toLowerCase() !== "current" ||
    basename(bridgeRoot).toLowerCase() !== "bridge"
  ) {
    return undefined;
  }
  const selected = await readPointerWithRoots(
    await prepareRoots(dirname(bridgeRoot)),
  );
  if (selected.currentDirectory.toLowerCase() !== currentDirectory.toLowerCase()) {
    throw new Error("IntentArc bridge stable launcher path is malformed.");
  }

  const launcherIdentity = options.launcherIdentity ?? bridgeBuildIdentity;
  const targetPath = join(
    selected.versionDirectory,
    BRIDGE_EXECUTABLE_NAME,
  );
  const authenticateLauncher =
    options.authenticateLauncher ?? readAuthenticodePublisher;
  const authenticateTarget = options.authenticateTarget ?? (async (path) => {
    const publisher = launcherIdentity.buildMode === "signed-release"
      ? await readAuthenticodePublisher(path)
      : undefined;
    return {
      ...await readEmbeddedBridgeIdentity(path),
      ...(publisher === undefined ? {} : { publisher }),
    };
  });

  const launcherPublisher =
    launcherIdentity.buildMode === "signed-release"
      ? await authenticateLauncher(executablePath)
      : undefined;
  const targetIdentity = await authenticateTarget(targetPath);
  if (
    compareVersions(
      targetIdentity.releaseVersion,
      launcherIdentity.releaseVersion,
    ) < 0
  ) {
    throw new Error("IntentArc bridge refused an authenticated release downgrade.");
  }
  if (
    targetIdentity.buildMode !== launcherIdentity.buildMode ||
    selected.manifest.buildMode !== launcherIdentity.buildMode
  ) {
    throw new Error(
      "IntentArc bridge signed-release and unsigned-development modes cannot be mixed.",
    );
  }
  if (
    targetIdentity.releaseVersion !== selected.manifest.releaseVersion ||
    targetIdentity.supportSha256 !== selected.manifest.supportSha256
  ) {
    throw new Error(
      "IntentArc bridge embedded identity does not match installed metadata.",
    );
  }
  if (launcherIdentity.buildMode === "signed-release") {
    if (
      !launcherPublisher ||
      !targetIdentity.publisher ||
      !selected.manifest.publisher ||
      !samePublisher(launcherPublisher, targetIdentity.publisher) ||
      !samePublisher(launcherPublisher, selected.manifest.publisher)
    ) {
      throw new Error(
        "IntentArc bridge target publisher does not match the trusted signed launcher.",
      );
    }
  } else if (selected.manifest.publisher || targetIdentity.publisher) {
    throw new Error(
      "IntentArc unsigned development bridge metadata is inconsistent.",
    );
  }
  return {
    targetPath,
    executableSha256: selected.manifest.executableSha256,
    identity: targetIdentity,
  };
};

export const resolveStableBridgeTarget = async (
  executablePath = process.execPath,
  options: ResolveStableBridgeTargetOptions = {},
): Promise<string | undefined> =>
  (await authenticateStableBridgeTarget(executablePath, options))?.targetPath;

export const inspectBridgePayloadIdentity = async ({
  executablePath,
  requireSignatures,
}: {
  readonly executablePath: string;
  readonly requireSignatures: boolean;
}): Promise<BridgeAuthenticatedIdentity> => {
  const identity = await inspectIntrinsicBridgeIdentity(executablePath);
  const intrinsicallySigned = identity.buildMode === "signed-release";
  if (requireSignatures !== intrinsicallySigned) {
    throw new Error(
      "IntentArc release metadata does not agree with the bridge's intrinsic signed-release mode.",
    );
  }
  return identity;
};

const defaultReplaceStableLauncher = async ({
  sourcePath,
  destinationPath,
  rollbackPath,
}: StableLauncherReplacement): Promise<void> => {
  if (!(await exists(destinationPath))) {
    await rename(sourcePath, destinationPath);
    return;
  }
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$source = [Environment]::GetEnvironmentVariable('INTENTARC_REPLACE_SOURCE', 'Process')",
      "$destination = [Environment]::GetEnvironmentVariable('INTENTARC_REPLACE_DESTINATION', 'Process')",
      "$rollback = [Environment]::GetEnvironmentVariable('INTENTARC_REPLACE_ROLLBACK', 'Process')",
      "[System.IO.File]::Replace($source, $destination, $rollback, $true)",
    ].join("; ");
    const powerShell = resolveWindowsPowerShellInvocation(process.env);
    try {
      await executeFile(powerShell.executablePath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ], {
        env: {
          ...powerShell.environment,
          INTENTARC_REPLACE_SOURCE: sourcePath,
          INTENTARC_REPLACE_DESTINATION: destinationPath,
          INTENTARC_REPLACE_ROLLBACK: rollbackPath,
        },
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
    } catch (cause) {
      throw Object.assign(
        new Error("IntentArc stable launcher is locked by an active process.", {
          cause,
        }),
        { code: "EBUSY" },
      );
    }
    return;
  }
  await copyFile(destinationPath, rollbackPath);
  await rename(sourcePath, destinationPath);
};

const publishPointer = async (
  roots: BridgeRoots,
  manifest: BridgeReleaseManifest,
): Promise<void> => {
  const nextPointer = join(
    roots.bridgeRoot,
    `.current-version-${randomUUID()}.tmp`,
  );
  await writeFile(nextPointer, serializeDocument(manifest), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await assertOrdinaryDirectory(roots.bridgeRoot, "root");
  await rename(nextPointer, roots.pointerPath);
};

const writePending = async (
  roots: BridgeRoots,
  manifest: BridgeReleaseManifest,
): Promise<void> => {
  if (await exists(roots.pendingPath)) {
    await rename(
      roots.pendingPath,
      join(roots.bridgeRoot, `.superseded-pending-${randomUUID()}.json`),
    );
  }
  const next = join(roots.bridgeRoot, `.pending-${randomUUID()}.tmp`);
  await writeFile(next, serializeDocument(manifest), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(next, roots.pendingPath);
};

const archivePendingThrough = async (
  roots: BridgeRoots,
  releaseVersion: string,
): Promise<void> => {
  if (!(await exists(roots.pendingPath))) return;
  await assertRegularFile(roots.pendingPath, "pending launcher update");
  const pending = parseDocument(
    await readFile(roots.pendingPath, "utf8"),
    "pointer",
  );
  if (compareVersions(pending.releaseVersion, releaseVersion) > 0) return;
  await rename(
    roots.pendingPath,
    join(roots.bridgeRoot, `.superseded-pending-${randomUUID()}.json`),
  );
};

const writeRecovery = async (
  roots: BridgeRoots,
  recovery: BridgeActivationRecovery,
): Promise<void> => {
  let recoveryFile;
  try {
    recoveryFile = await open(roots.recoveryPath, "wx", 0o600);
    await recoveryFile.writeFile(`${JSON.stringify(recovery)}\n`, "utf8");
    await recoveryFile.sync();
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new Error(
        "IntentArc bridge has an unfinished activation recovery.",
      );
    }
    throw error;
  } finally {
    await recoveryFile?.close();
  }
};

const sameRecovery = (
  left: BridgeActivationRecovery,
  right: BridgeActivationRecovery,
): boolean =>
  left.transactionId === right.transactionId &&
  left.phase === right.phase &&
  left.rollbackFile === right.rollbackFile &&
  ((left.previous === null && right.previous === null) ||
    (left.previous !== null &&
      right.previous !== null &&
      serializeDocument(left.previous) === serializeDocument(right.previous))) &&
  serializeDocument(left.candidate) === serializeDocument(right.candidate);

const archiveRecovery = async (
  roots: BridgeRoots,
  recovery: BridgeActivationRecovery,
  label: "recovered" | "completed",
): Promise<void> => {
  if (!(await exists(roots.recoveryPath))) {
    throw new Error(
      "IntentArc bridge activation transaction owner lost its live journal.",
    );
  }
  await assertRegularFile(roots.recoveryPath, "activation recovery");
  const live = parseRecoveryDocument(
    await readFile(roots.recoveryPath, "utf8"),
  );
  if (!sameRecovery(live, recovery)) {
    throw new Error(
      "IntentArc bridge activation transaction owner no longer matches the live journal.",
    );
  }
  await rename(
    roots.recoveryPath,
    join(roots.bridgeRoot, `.${label}-activation-${randomUUID()}.json`),
  );
};

const readRecovery = async (
  roots: BridgeRoots,
): Promise<BridgeActivationRecovery | undefined> => {
  if (!(await exists(roots.recoveryPath))) return undefined;
  await assertRegularFile(roots.recoveryPath, "activation recovery");
  return parseRecoveryDocument(await readFile(roots.recoveryPath, "utf8"));
};

export const readBridgeActivationTransaction = async ({
  binaryRoot,
}: {
  readonly binaryRoot: string;
}): Promise<BridgeActivationTransaction | undefined> => {
  const recovery = await readRecovery(await prepareRoots(binaryRoot));
  return recovery === undefined
    ? undefined
    : {
      transactionId: recovery.transactionId,
      phase: recovery.phase,
    };
};

const createManifest = async (
  versionDirectory: string,
  version: string,
  authenticated: BridgeAuthenticatedIdentity | void,
): Promise<BridgeReleaseManifest> => {
  const payloadSha256 = await treeDigest(
    versionDirectory,
    new Set([BRIDGE_MANIFEST_NAME]),
  );
  const executableSha256 = await fileDigest(
    join(versionDirectory, BRIDGE_EXECUTABLE_NAME),
  );
  const supportSha256 = await supportDigest(versionDirectory);
  const identity: BridgeAuthenticatedIdentity = authenticated ?? {
    formatVersion: 1,
    releaseVersion: version,
    buildMode: "unsigned-development",
    supportSha256,
  };
  if (
    identity.formatVersion !== 1 ||
    identity.releaseVersion !== version ||
    identity.supportSha256 !== supportSha256 ||
    (identity.buildMode === "signed-release" && !identity.publisher) ||
    (identity.buildMode === "unsigned-development" && identity.publisher)
  ) {
    throw new Error(
      "IntentArc bridge verified identity does not match the staged payload.",
    );
  }
  return {
    formatVersion: 1,
    versionDirectory: basename(versionDirectory),
    releaseVersion: identity.releaseVersion,
    buildMode: identity.buildMode,
    executableSha256,
    payloadSha256,
    supportSha256,
    ...(identity.publisher === undefined ? {} : {
      publisher: identity.publisher,
    }),
  };
};

const prepareStableDirectory = async (roots: BridgeRoots): Promise<void> => {
  if (!(await exists(roots.currentDirectory))) {
    await ensureOrdinaryChildDirectory(
      roots.bridgeRoot,
      "current",
      "stable launcher directory",
    );
  }
  await assertOrdinaryDirectory(
    roots.currentDirectory,
    "stable launcher directory",
  );
};

const verifyRelease = async (
  roots: BridgeRoots,
  versionDirectory: string,
  expected: BridgeReleaseManifest,
): Promise<void> => {
  const actual = await readInstalledManifest(roots, versionDirectory);
  if (serializeDocument(actual) !== serializeDocument(expected)) {
    throw new Error("IntentArc bridge release changed after staged verification.");
  }
};

const sameManifest = (
  left: BridgeReleaseManifest,
  right: BridgeReleaseManifest,
): boolean => serializeDocument(left) === serializeDocument(right);

const activationTransactionFor = (
  recovery: BridgeActivationRecovery,
): BridgeActivationTransaction => ({
  transactionId: recovery.transactionId,
  phase: recovery.phase,
});

const inspectManifestExecutable = async (
  executablePath: string,
  manifest: BridgeReleaseManifest,
  inspectLauncherIdentity: NonNullable<
    InstallBridgeVersionInput["inspectLauncherIdentity"]
  >,
  label: string,
): Promise<BridgeAuthenticatedIdentity> => {
  await assertRegularFile(executablePath, label);
  if (await fileDigest(executablePath) !== manifest.executableSha256) {
    throw new Error(
      `IntentArc bridge ${label} digest does not match authenticated release metadata.`,
    );
  }
  const identity = await inspectLauncherIdentity(executablePath);
  assertIdentityMatchesManifest(identity, manifest, label);
  return identity;
};

const inspectPublishedPublicPair = async (
  roots: BridgeRoots,
  expected: BridgeReleaseManifest,
  inspectLauncherIdentity?: NonNullable<
    InstallBridgeVersionInput["inspectLauncherIdentity"]
  >,
): Promise<BridgePointer & { readonly manifest: BridgeReleaseManifest }> => {
  const stablePath = join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME);
  const inspectStableLauncher = async (): Promise<void> => {
    if (inspectLauncherIdentity) {
      await inspectManifestExecutable(
        stablePath,
        expected,
        inspectLauncherIdentity,
        "public launcher",
      );
      return;
    }
    await assertRegularFile(stablePath, "public launcher");
    if (await fileDigest(stablePath) !== expected.executableSha256) {
      throw new Error(
        "IntentArc bridge public launcher digest changed during active verification.",
      );
    }
  };
  const selected = await readPointerWithRoots(roots);
  if (!sameManifest(selected.manifest, expected)) {
    throw new Error(
      "IntentArc bridge public pointer changed during active verification.",
    );
  }
  await inspectStableLauncher();
  const confirmed = await readPointerWithRoots(roots);
  if (!sameManifest(confirmed.manifest, expected)) {
    throw new Error(
      "IntentArc bridge public pointer changed during active verification.",
    );
  }
  await inspectStableLauncher();
  return confirmed;
};

const inspectHealthyPublicPair = async (
  roots: BridgeRoots,
  recovery: BridgeActivationRecovery,
  verify: InstallBridgeVersionInput["verify"],
  inspectLauncherIdentity: NonNullable<
    InstallBridgeVersionInput["inspectLauncherIdentity"]
  >,
): Promise<
  | (BridgePointer & { readonly manifest: BridgeReleaseManifest })
  | undefined
> => {
  try {
    const selected = await readPointerWithRoots(roots);
    const stablePath = join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME);
    await inspectPublishedPublicPair(
      roots,
      selected.manifest,
      inspectLauncherIdentity,
    );
    const authenticated = await verify({
      phase: "active",
      executablePath: stablePath,
      versionDirectory: selected.versionDirectory,
      binaryRoot: roots.binaryRoot,
      activationTransaction: activationTransactionFor(recovery),
    });
    if (authenticated) {
      assertIdentityMatchesManifest(
        authenticated,
        selected.manifest,
        "public launcher",
      );
    }
    return await inspectPublishedPublicPair(
      roots,
      selected.manifest,
      inspectLauncherIdentity,
    );
  } catch {
    return undefined;
  }
};

const assertExactPredecessorAuthorization = async (
  candidateExecutable: string,
  previous: BridgeReleaseManifest,
  inspectCandidatePredecessor: NonNullable<
    InstallBridgeVersionInput["inspectCandidatePredecessor"]
  >,
): Promise<void> => {
  const authorized = await inspectCandidatePredecessor(candidateExecutable);
  if (!authorized || !sameManifest(authorized, previous)) {
    throw new Error(
      "IntentArc candidate does not authorize this exact recovery predecessor.",
    );
  }
};

type ActivationResolution = "candidate" | "previous" | "other";

const recoverBridgeActivationWithRoots = async (
  roots: BridgeRoots,
  recovery: BridgeActivationRecovery,
  verify: InstallBridgeVersionInput["verify"],
  replaceStableLauncher: NonNullable<
    InstallBridgeVersionInput["replaceStableLauncher"]
  >,
  inspectLauncherIdentity: NonNullable<
    InstallBridgeVersionInput["inspectLauncherIdentity"]
  >,
  inspectCandidatePredecessor: NonNullable<
    InstallBridgeVersionInput["inspectCandidatePredecessor"]
  >,
): Promise<ActivationResolution> => {
  const healthy = await inspectHealthyPublicPair(
    roots,
    recovery,
    verify,
    inspectLauncherIdentity,
  );
  if (healthy) {
    const resolution = recovery.previous &&
        sameManifest(healthy.manifest, recovery.previous)
      ? "previous"
      : sameManifest(healthy.manifest, recovery.candidate)
      ? "candidate"
      : "other";
    await archiveRecovery(
      roots,
      recovery,
      resolution === "previous" ? "recovered" : "completed",
    );
    return resolution;
  }

  const candidateDirectory = await assertVersionDirectory(
    roots,
    join(roots.versionsRoot, recovery.candidate.versionDirectory),
  );
  const candidateVersionExecutable = join(
    candidateDirectory,
    BRIDGE_EXECUTABLE_NAME,
  );
  const stablePath = join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME);

  if (!recovery.previous) {
    await verifyRelease(roots, candidateDirectory, recovery.candidate);
    await inspectManifestExecutable(
      stablePath,
      recovery.candidate,
      inspectLauncherIdentity,
      "first-install candidate launcher",
    );
    await publishPointer(roots, recovery.candidate);
    const completed = await inspectHealthyPublicPair(
      roots,
      recovery,
      verify,
      inspectLauncherIdentity,
    );
    if (!completed || !sameManifest(completed.manifest, recovery.candidate)) {
      throw new Error(
        "IntentArc first-install activation requires installer repair.",
      );
    }
    await archiveRecovery(roots, recovery, "completed");
    return "candidate";
  }

  const previousDirectory = await assertVersionDirectory(
    roots,
    join(roots.versionsRoot, recovery.previous.versionDirectory),
  );
  await verifyRelease(roots, previousDirectory, recovery.previous);
  const previousIdentity = await inspectManifestExecutable(
    join(previousDirectory, BRIDGE_EXECUTABLE_NAME),
    recovery.previous,
    inspectLauncherIdentity,
    "recovery predecessor",
  );
  assertAuthorizedSuccessor(previousIdentity, recovery.candidate);

  let stableIsPrevious = false;
  let stableCandidateIdentity: BridgeAuthenticatedIdentity | undefined;
  try {
    await inspectManifestExecutable(
      stablePath,
      recovery.previous,
      inspectLauncherIdentity,
      "recovery predecessor launcher",
    );
    stableIsPrevious = true;
  } catch {
    try {
      stableCandidateIdentity = await inspectManifestExecutable(
        stablePath,
        recovery.candidate,
        inspectLauncherIdentity,
        "recovery candidate launcher",
      );
    } catch {
      stableCandidateIdentity = undefined;
    }
  }

  if (!stableIsPrevious && !stableCandidateIdentity) {
    throw new Error(
      "IntentArc public launcher does not match the recorded activation transaction.",
    );
  }

  const candidateAuthorizationExecutable = stableCandidateIdentity
    ? stablePath
    : candidateVersionExecutable;
  if (!stableCandidateIdentity) {
    await inspectManifestExecutable(
      candidateVersionExecutable,
      recovery.candidate,
      inspectLauncherIdentity,
      "recovery candidate",
    );
  }
  await assertExactPredecessorAuthorization(
    candidateAuthorizationExecutable,
    recovery.previous,
    inspectCandidatePredecessor,
  );
  await inspectManifestExecutable(
    candidateAuthorizationExecutable,
    recovery.candidate,
    inspectLauncherIdentity,
    stableCandidateIdentity
      ? "recovery candidate launcher"
      : "recovery candidate",
  );

  let launcherError: unknown;
  if (!stableIsPrevious) {
    const rollbackPath = join(
      roots.currentDirectory,
      recovery.rollbackFile,
    );
    try {
      await inspectManifestExecutable(
        rollbackPath,
        recovery.previous,
        inspectLauncherIdentity,
        "activation rollback launcher",
      );
      const retainedCandidate = join(
        roots.currentDirectory,
        `.recovery-candidate-${randomUUID()}.exe`,
      );
      await replaceStableLauncher({
        sourcePath: rollbackPath,
        destinationPath: stablePath,
        rollbackPath: retainedCandidate,
      });
    } catch (error) {
      launcherError = error;
    }
  }

  let pointerError: unknown;
  try {
    await publishPointer(roots, recovery.previous);
  } catch (error) {
    pointerError = error;
  }
  if (launcherError || pointerError) {
    throw new AggregateError(
      [launcherError, pointerError].filter((error) => error !== undefined),
      "IntentArc activation rollback requires restart recovery.",
    );
  }

  const restored = await inspectHealthyPublicPair(
    roots,
    recovery,
    verify,
    inspectLauncherIdentity,
  );
  if (!restored || !sameManifest(restored.manifest, recovery.previous)) {
    throw new Error(
      "IntentArc activation predecessor was not verified after recovery.",
    );
  }
  await archiveRecovery(roots, recovery, "recovered");
  return "previous";
};

const activateVersion = async (
  roots: BridgeRoots,
  versionDirectory: string,
  manifest: BridgeReleaseManifest,
  verify: InstallBridgeVersionInput["verify"],
  replaceStableLauncher =
    defaultReplaceStableLauncher,
  inspectLauncherIdentity =
    inspectIntrinsicBridgeIdentity,
  inspectCandidatePredecessor =
    readEmbeddedBridgeAuthorizedPredecessor,
): Promise<InstallBridgeVersionResult> => {
  const previous = await exists(roots.pointerPath)
    ? await readPointerWithRoots(roots)
    : undefined;
  if (
    previous &&
    compareVersions(
      manifest.releaseVersion,
      previous.manifest.releaseVersion,
    ) < 0
  ) {
    throw new Error("IntentArc bridge refused an installed release downgrade.");
  }
  await prepareStableDirectory(roots);
  const stablePath = join(roots.currentDirectory, BRIDGE_EXECUTABLE_NAME);
  if (previous) {
    if (await fileDigest(stablePath) !== previous.manifest.executableSha256) {
      throw new Error(
        "IntentArc installed launcher digest does not match its authenticated release.",
      );
    }
    const currentIdentity = await inspectLauncherIdentity(stablePath);
    assertIdentityMatchesManifest(
      currentIdentity,
      previous.manifest,
      "installed launcher",
    );
    assertAuthorizedSuccessor(currentIdentity, manifest);
  }
  const sourcePath = join(
    roots.currentDirectory,
    `.launcher-${randomUUID()}.tmp`,
  );
  const rollbackPath = join(
    roots.currentDirectory,
    `.launcher-rollback-${randomUUID()}.exe`,
  );
  await copyFile(join(versionDirectory, BRIDGE_EXECUTABLE_NAME), sourcePath);
  await assertRegularFile(sourcePath, "staged launcher");
  const recovery: BridgeActivationRecovery = {
    formatVersion: 2,
    transactionId: randomUUID(),
    phase: "active-verification",
    previous: previous?.manifest ?? null,
    candidate: manifest,
    rollbackFile: basename(rollbackPath),
  };
  await writeRecovery(roots, recovery);

  if (previous) {
    await publishPointer(roots, manifest);
  }
  try {
    await replaceStableLauncher({
      sourcePath,
      destinationPath: stablePath,
      rollbackPath,
    });
  } catch (error) {
    let pendingError: unknown;
    const locked = hasCode(error, "EACCES", "EPERM", "EBUSY");
    try {
      if (locked) await writePending(roots, manifest);
    } catch (writeError) {
      pendingError = writeError;
    }
    let resolution: ActivationResolution;
    try {
      resolution = await recoverBridgeActivationWithRoots(
        roots,
        recovery,
        verify,
        replaceStableLauncher,
        inspectLauncherIdentity,
        inspectCandidatePredecessor,
      );
    } catch (recoveryError) {
      throw new AggregateError(
        [error, pendingError, recoveryError].filter(
          (item) => item !== undefined,
        ),
        "IntentArc launcher replacement failed and requires startup recovery.",
      );
    }
    if (pendingError) {
      throw new AggregateError(
        [error, pendingError],
        "IntentArc pending launcher publication failed.",
      );
    }
    if (resolution === "candidate") {
      return {
        ...pointerFor(roots, versionDirectory),
        removedVersionDirectories: [],
        pendingLauncherUpdate: false,
      };
    }
    if (locked && resolution === "previous") {
      return {
        ...pointerFor(roots, versionDirectory),
        removedVersionDirectories: [],
        pendingLauncherUpdate: true,
      };
    }
    throw error;
  }
  if (!previous) await publishPointer(roots, manifest);

  try {
    await verifyRelease(roots, versionDirectory, manifest);
    const authenticated = await verify({
      phase: "active",
      executablePath: stablePath,
      versionDirectory,
      binaryRoot: roots.binaryRoot,
      activationTransaction: activationTransactionFor(recovery),
    });
    if (authenticated) {
      const activeIdentity = await createManifest(
        versionDirectory,
        manifest.releaseVersion,
        authenticated,
      );
      if (serializeDocument(activeIdentity) !== serializeDocument(manifest)) {
        throw new Error(
          "IntentArc bridge active identity changed after staged verification.",
        );
      }
    }
    await inspectPublishedPublicPair(
      roots,
      manifest,
    );
  } catch (error) {
    let resolution: ActivationResolution;
    try {
      resolution = await recoverBridgeActivationWithRoots(
        roots,
        recovery,
        verify,
        replaceStableLauncher,
        inspectLauncherIdentity,
        inspectCandidatePredecessor,
      );
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "IntentArc bridge activation failed and requires startup recovery.",
      );
    }
    if (resolution === "candidate") {
      return {
        ...pointerFor(roots, versionDirectory),
        removedVersionDirectories: [],
        pendingLauncherUpdate: false,
      };
    }
    throw error;
  }
  await archiveRecovery(roots, recovery, "completed");
  return {
    ...pointerFor(roots, versionDirectory),
    removedVersionDirectories: [],
    pendingLauncherUpdate: false,
  };
};

export const recoverBridgeActivation = async ({
  binaryRoot,
  verify,
  replaceStableLauncher = defaultReplaceStableLauncher,
  inspectLauncherIdentity = inspectIntrinsicBridgeIdentity,
  inspectCandidatePredecessor = readEmbeddedBridgeAuthorizedPredecessor,
}: RecoverBridgeActivationInput): Promise<boolean> => {
  const roots = await prepareRoots(binaryRoot);
  const recovery = await readRecovery(roots);
  if (!recovery) return false;
  await recoverBridgeActivationWithRoots(
    roots,
    recovery,
    verify,
    replaceStableLauncher,
    inspectLauncherIdentity,
    inspectCandidatePredecessor,
  );
  return true;
};

export const installBridgeVersion = async (
  input: InstallBridgeVersionInput,
): Promise<InstallBridgeVersionResult> => {
  if (!versionPattern.test(input.version)) {
    throw new Error("IntentArc bridge version is invalid.");
  }
  if (!isAbsolute(input.payloadPath)) {
    throw new Error("IntentArc bridge payload path must be absolute.");
  }
  const roots = await prepareRoots(input.binaryRoot);
  const [bridgeRootPromotionIdentity, versionsRootPromotionIdentity] =
    await Promise.all([
      captureBridgeDirectoryPromotionPathIdentity(
        roots.bridgeRoot,
        "root",
      ),
      captureBridgeDirectoryPromotionPathIdentity(
        roots.versionsRoot,
        "versions root",
      ),
    ]);
  if (await exists(roots.recoveryPath)) {
    await recoverBridgeActivation({
      binaryRoot: roots.binaryRoot,
      verify: input.verify,
      replaceStableLauncher: input.replaceStableLauncher,
      inspectLauncherIdentity: input.inspectLauncherIdentity,
      inspectCandidatePredecessor: input.inspectCandidatePredecessor,
    });
  }
  const digest = await treeDigest(input.payloadPath);
  const versionDirectory = join(
    roots.versionsRoot,
    `${input.version}-${digest.slice(0, 16)}`,
  );
  assertContained(roots.binaryRoot, versionDirectory, "version directory");

  let manifest: BridgeReleaseManifest;
  if (!(await exists(versionDirectory))) {
    const stagingDirectory = join(
      roots.bridgeRoot,
      `.staging-${input.version}-${randomUUID()}`,
    );
    await copyPayload(input.payloadPath, stagingDirectory);
    const stagingPromotionIdentity =
      await captureBridgeDirectoryPromotionPathIdentity(
        stagingDirectory,
        "staging source",
      );
    const authenticated = await input.verify({
      phase: "staged",
      executablePath: join(stagingDirectory, BRIDGE_EXECUTABLE_NAME),
      versionDirectory: stagingDirectory,
      binaryRoot: roots.binaryRoot,
    });
    manifest = await createManifest(
      stagingDirectory,
      input.version,
      authenticated,
    );
    await writeFile(
      join(stagingDirectory, BRIDGE_MANIFEST_NAME),
      serializeDocument({
        ...manifest,
        versionDirectory: basename(versionDirectory),
      }),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    await promoteBridgeStagingDirectory({
      bridgeRoot: roots.bridgeRoot,
      versionsRoot: roots.versionsRoot,
      stagingDirectory,
      versionDirectory,
      baseline: {
        bridgeRoot: bridgeRootPromotionIdentity,
        versionsRoot: versionsRootPromotionIdentity,
        stagingDirectory: stagingPromotionIdentity,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    manifest = {
      ...manifest,
      versionDirectory: basename(versionDirectory),
    };
  } else {
    await assertVersionDirectory(roots, versionDirectory);
    manifest = await readInstalledManifest(roots, versionDirectory);
    const authenticated = await input.verify({
      phase: "staged",
      executablePath: join(versionDirectory, BRIDGE_EXECUTABLE_NAME),
      versionDirectory,
      binaryRoot: roots.binaryRoot,
    });
    if (authenticated) {
      const expected = await createManifest(
        versionDirectory,
        input.version,
        authenticated,
      );
      if (serializeDocument(expected) !== serializeDocument(manifest)) {
        throw new Error("IntentArc bridge existing release identity changed.");
      }
    }
  }

  await verifyRelease(roots, versionDirectory, manifest);
  const result = await activateVersion(
    roots,
    versionDirectory,
    manifest,
    input.verify,
    input.replaceStableLauncher,
    input.inspectLauncherIdentity,
    input.inspectCandidatePredecessor,
  );
  if (!result.pendingLauncherUpdate) {
    await archivePendingThrough(roots, manifest.releaseVersion);
  }
  return result;
};

export const applyPendingBridgeUpdate = async ({
  binaryRoot,
  verify,
  replaceStableLauncher,
  inspectLauncherIdentity,
  inspectCandidatePredecessor,
}: {
  readonly binaryRoot: string;
  readonly verify: InstallBridgeVersionInput["verify"];
  readonly replaceStableLauncher?: InstallBridgeVersionInput["replaceStableLauncher"];
  readonly inspectLauncherIdentity?: InstallBridgeVersionInput["inspectLauncherIdentity"];
  readonly inspectCandidatePredecessor?: InstallBridgeVersionInput["inspectCandidatePredecessor"];
}): Promise<InstallBridgeVersionResult | undefined> => {
  const roots = await prepareRoots(binaryRoot);
  if (await exists(roots.recoveryPath)) {
    await recoverBridgeActivation({
      binaryRoot: roots.binaryRoot,
      verify,
      replaceStableLauncher,
      inspectLauncherIdentity,
      inspectCandidatePredecessor,
    });
  }
  if (!(await exists(roots.pendingPath))) return undefined;
  await assertRegularFile(roots.pendingPath, "pending launcher update");
  const manifest = parseDocument(
    await readFile(roots.pendingPath, "utf8"),
    "pointer",
  );
  const versionDirectory = await assertVersionDirectory(
    roots,
    join(roots.versionsRoot, manifest.versionDirectory),
  );
  if (await exists(roots.pointerPath)) {
    const current = await readPointerWithRoots(roots);
    if (
      compareVersions(
        manifest.releaseVersion,
        current.manifest.releaseVersion,
      ) <= 0
    ) {
      await archivePendingThrough(
        roots,
        current.manifest.releaseVersion,
      );
      return undefined;
    }
  }
  await verifyRelease(roots, versionDirectory, manifest);
  const result = await activateVersion(
    roots,
    versionDirectory,
    manifest,
    verify,
    replaceStableLauncher,
    inspectLauncherIdentity,
    inspectCandidatePredecessor,
  );
  if (!result.pendingLauncherUpdate) {
    await rename(
      roots.pendingPath,
      join(roots.bridgeRoot, `.applied-pending-${randomUUID()}.json`),
    );
  }
  return result;
};

export const repairBridgePointer = async (
  input: RepairBridgePointerInput,
): Promise<BridgePointer> => {
  const roots = await prepareRoots(input.binaryRoot);
  if (await exists(roots.recoveryPath)) {
    await recoverBridgeActivation({
      binaryRoot: roots.binaryRoot,
      verify: input.verify,
      replaceStableLauncher: input.replaceStableLauncher,
      inspectLauncherIdentity: input.inspectLauncherIdentity,
      inspectCandidatePredecessor: input.inspectCandidatePredecessor,
    });
  }
  const versionDirectory = await assertVersionDirectory(
    roots,
    input.versionDirectory,
  );
  const manifest = await readInstalledManifest(roots, versionDirectory);
  if (await exists(roots.pointerPath)) {
    try {
      await readPointerWithRoots(roots);
    } catch {
      await assertRegularFile(roots.pointerPath, "current pointer");
      await rename(
        roots.pointerPath,
        join(roots.bridgeRoot, `.repaired-pointer-${randomUUID()}.json`),
      );
    }
  }
  await input.verify({
    phase: "staged",
    executablePath: join(versionDirectory, BRIDGE_EXECUTABLE_NAME),
    versionDirectory,
    binaryRoot: roots.binaryRoot,
  });
  const repaired = await activateVersion(
    roots,
    versionDirectory,
    manifest,
    input.verify,
    input.replaceStableLauncher,
    input.inspectLauncherIdentity,
    input.inspectCandidatePredecessor,
  );
  if (repaired.pendingLauncherUpdate) {
    throw new Error("IntentArc bridge repair is pending launcher replacement.");
  }
  return repaired;
};
