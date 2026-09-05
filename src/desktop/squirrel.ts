import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveWindowsPowerShellInvocation } from "../system/windows-powershell.js";
import {
  applyPendingBridgeUpdate,
  inspectBridgePayloadIdentity,
  inspectIntrinsicBridgeIdentity,
  installBridgeVersion,
  type InstallBridgeVersionInput,
} from "./bridge-install.js";
import type { BridgeProtocolVerifier } from "./bridge-protocol-verifier.js";

const executeFile = promisify(execFile);
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const SQUIRREL_LIFECYCLE_RECEIPT_NAME =
  ".intentarc-squirrel-lifecycle.json";
const SQUIRREL_LIFECYCLE_RECEIPT_OPT_IN =
  "INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT";
const recognizedEvents = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

type SquirrelLifecycleStage =
  | "entry-recognition"
  | "release-metadata"
  | "bridge-staging-copy"
  | "staged-signature-verification"
  | "staged-protocol-verification"
  | "staged-identity-inspection"
  | "activation-pointer-publication"
  | "active-signature-verification"
  | "active-protocol-verification"
  | "shortcut-operation"
  | "lifecycle";

type SquirrelLifecycleStageStatus =
  | "started"
  | "completed"
  | "skipped"
  | "failed";

interface SquirrelLifecycleStageEntry {
  readonly stage: SquirrelLifecycleStage;
  readonly status: SquirrelLifecycleStageStatus;
}

interface SquirrelLifecycleFailure {
  readonly category: string;
  readonly message: string;
}

interface SquirrelLifecycleDocument {
  readonly schemaVersion: 1;
  readonly event: string;
  readonly releaseVersion: string;
  status: "running" | "success" | "failure";
  readonly stages: SquirrelLifecycleStageEntry[];
  failure?: SquirrelLifecycleFailure;
}

interface SquirrelLifecycleRecorder {
  readonly record: (
    stage: SquirrelLifecycleStage,
    status: SquirrelLifecycleStageStatus,
  ) => Promise<void>;
  readonly succeed: () => Promise<void>;
  readonly fail: () => Promise<void>;
}

const boundedFailure = (
  stage: SquirrelLifecycleStage,
): SquirrelLifecycleFailure => ({
  category: stage,
  message: ({
    "entry-recognition": "Squirrel lifecycle entry recognition failed.",
    "release-metadata": "Squirrel release metadata validation failed.",
    "bridge-staging-copy": "Bridge staging or copy failed.",
    "staged-signature-verification":
      "Staged bridge signature verification failed.",
    "staged-protocol-verification":
      "Staged bridge protocol verification failed.",
    "staged-identity-inspection":
      "Staged bridge identity inspection failed.",
    "activation-pointer-publication":
      "Bridge activation or pointer publication failed.",
    "active-signature-verification":
      "Active bridge signature verification failed.",
    "active-protocol-verification":
      "Active bridge protocol verification failed.",
    "shortcut-operation": "Squirrel shortcut operation failed.",
    lifecycle: "Squirrel lifecycle operation failed.",
  } satisfies Record<SquirrelLifecycleStage, string>)[stage],
});

const createSquirrelLifecycleRecorder = async ({
  binaryRoot,
  environment,
  event,
  version,
}: {
  readonly binaryRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly event: string;
  readonly version: string;
}): Promise<SquirrelLifecycleRecorder | undefined> => {
  if (environment[SQUIRREL_LIFECYCLE_RECEIPT_OPT_IN] !== "1") {
    return undefined;
  }
  const receiptPath = join(binaryRoot, SQUIRREL_LIFECYCLE_RECEIPT_NAME);
  const document: SquirrelLifecycleDocument = {
    schemaVersion: 1,
    event,
    releaseVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : "invalid",
    status: "running",
    stages: [],
  };
  let activeStage: SquirrelLifecycleStage = "entry-recognition";
  const persist = async (): Promise<void> => {
    const temporaryPath = join(
      binaryRoot,
      `.${SQUIRREL_LIFECYCLE_RECEIPT_NAME}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, receiptPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  };
  await persist();
  return {
    async record(stage, status) {
      activeStage = stage;
      document.stages.push({ stage, status });
      await persist();
    },
    async succeed() {
      activeStage = "lifecycle";
      document.stages.push({ stage: "lifecycle", status: "completed" });
      document.status = "success";
      delete document.failure;
      await persist();
    },
    async fail() {
      document.stages.push({ stage: "lifecycle", status: "failed" });
      document.status = "failure";
      document.failure = boundedFailure(activeStage);
      await persist();
    },
  };
};

export type SquirrelBridgeInstaller = (
  input: InstallBridgeVersionInput,
) => Promise<unknown>;

export interface HandleSquirrelEventOptions {
  readonly argv: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly resourcesPath?: string;
  readonly version: string;
  readonly installBridge?: SquirrelBridgeInstaller;
  readonly loadSignatureRequirement?: (
    resourcesPath: string,
  ) => Promise<boolean>;
  readonly verifyBridgeProtocol?: BridgeProtocolVerifier;
  readonly inspectBridgeIdentity?: typeof inspectBridgePayloadIdentity;
  readonly runUpdate?: (arguments_: readonly string[]) => Promise<void>;
  readonly quit: () => void;
}

const assertRegularFile = async (path: string, label: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`IntentArc packaged ${label} is missing or malformed.`);
  }
};

export const verifyAuthenticodeSignature = async (
  path: string,
): Promise<void> => {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('INTENTARC_SIGNATURE_TARGET', 'Process')",
    "$signature = Get-AuthenticodeSignature -LiteralPath $target",
    "if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {",
    "  [Console]::Error.WriteLine('INTENTARC_AUTHENTICODE_STATUS=' + $signature.Status)",
    "  exit 2",
    "}",
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
        INTENTARC_SIGNATURE_TARGET: path,
      },
      windowsHide: true,
      maxBuffer: MAX_DIAGNOSTIC_BYTES,
    });
  } catch (error) {
    const diagnostic = typeof error === "object" && error !== null &&
        "stderr" in error
      ? String(error.stderr)
      : "";
    const status =
      /INTENTARC_AUTHENTICODE_STATUS=([A-Za-z]+)/.exec(diagnostic)?.[1];
    throw new Error(
      status
        ? `Invalid Authenticode signature: ${status}.`
        : "IntentArc Authenticode verification could not verify a valid executable.",
    );
  }
};

const signatureRequirement = async (
  resourcesPath: string,
): Promise<boolean> => {
  const path = join(
    resourcesPath,
    "desktop-resources",
    "intentarc-release.json",
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("IntentArc release metadata is missing or malformed.");
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !==
      "arch,platform,requireSignatures,schemaVersion" ||
    (metadata as Record<string, unknown>).schemaVersion !== 1 ||
    (metadata as Record<string, unknown>).platform !== "win32" ||
    (metadata as Record<string, unknown>).arch !== "x64" ||
    typeof (metadata as Record<string, unknown>).requireSignatures !== "boolean"
  ) {
    throw new Error("IntentArc release metadata is missing or malformed.");
  }
  return (metadata as { requireSignatures: boolean }).requireSignatures;
};

const bridgeVerifier = (
  requireSignatures: boolean,
  verifyProtocol: BridgeProtocolVerifier,
  inspectIdentity = inspectBridgePayloadIdentity,
  recordLifecycle?: SquirrelLifecycleRecorder["record"],
): InstallBridgeVersionInput["verify"] =>
  async (input) => {
    const { executablePath, versionDirectory } = input;
    if (input.phase === "staged") {
      await recordLifecycle?.("bridge-staging-copy", "completed");
    } else {
      await recordLifecycle?.("activation-pointer-publication", "completed");
    }
    const nativeBinding = join(
      versionDirectory,
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      "win32-x64.node",
    );
    await assertRegularFile(executablePath, "bridge executable");
    await assertRegularFile(nativeBinding, "bridge native binding");
    const signatureStage = `${input.phase}-signature-verification` as const;
    if (requireSignatures) {
      await recordLifecycle?.(signatureStage, "started");
      await verifyAuthenticodeSignature(executablePath);
      await recordLifecycle?.(signatureStage, "completed");
    } else {
      await recordLifecycle?.(signatureStage, "skipped");
    }
    const protocolStage = `${input.phase}-protocol-verification` as const;
    await recordLifecycle?.(protocolStage, "started");
    await verifyProtocol(input);
    await recordLifecycle?.(protocolStage, "completed");
    if (input.phase === "staged") {
      await recordLifecycle?.("staged-identity-inspection", "started");
      const identity = await inspectIdentity({
        executablePath,
        requireSignatures,
      });
      await recordLifecycle?.("staged-identity-inspection", "completed");
      await recordLifecycle?.("activation-pointer-publication", "started");
      return identity;
    }
    return inspectIdentity({
      executablePath,
      requireSignatures,
    });
  };

export const resumePendingBridgeUpdate = async ({
  binaryRoot,
  resourcesPath,
  loadSignatureRequirement = signatureRequirement,
  verifyBridgeProtocol = verifyBridgeProtocolCompatibility,
  inspectBridgeIdentity = inspectBridgePayloadIdentity,
}: {
  readonly binaryRoot: string;
  readonly resourcesPath: string;
  readonly loadSignatureRequirement?: (
    resourcesPath: string,
  ) => Promise<boolean>;
  readonly verifyBridgeProtocol?: BridgeProtocolVerifier;
  readonly inspectBridgeIdentity?: typeof inspectBridgePayloadIdentity;
}): Promise<boolean> => {
  const requireSignatures = await loadSignatureRequirement(resourcesPath);
  const result = await applyPendingBridgeUpdate({
    binaryRoot,
    inspectLauncherIdentity: inspectIntrinsicBridgeIdentity,
    verify: bridgeVerifier(
      requireSignatures,
      verifyBridgeProtocol,
      inspectBridgeIdentity,
    ),
  });
  return result !== undefined && !result.pendingLauncherUpdate;
};

const verifyBridgeProtocolCompatibility = async (
  input: Parameters<BridgeProtocolVerifier>[0],
): Promise<void> => {
  const verifierModulePath = "./bridge-protocol-verifier.js";
  const verifier = await import(verifierModulePath) as {
    verifyBridgeProtocolCompatibility?: BridgeProtocolVerifier;
  };
  if (!verifier.verifyBridgeProtocolCompatibility) {
    throw new Error(
      "IntentArc bridge MCP protocol verifier is unavailable.",
    );
  }
  await verifier.verifyBridgeProtocolCompatibility(input);
};

const runSquirrelUpdate = (
  binaryRoot: string,
  arguments_: readonly string[],
): Promise<void> =>
  executeFile(join(binaryRoot, "Update.exe"), [...arguments_], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
  }).then(() => undefined);

export const handleSquirrelEvent = async ({
  argv,
  environment = process.env,
  platform = process.platform,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  version,
  installBridge = installBridgeVersion,
  loadSignatureRequirement = signatureRequirement,
  verifyBridgeProtocol = verifyBridgeProtocolCompatibility,
  inspectBridgeIdentity = inspectBridgePayloadIdentity,
  runUpdate,
  quit,
}: HandleSquirrelEventOptions): Promise<boolean> => {
  const event = argv[0];
  if (
    platform !== "win32" ||
    event === undefined ||
    !recognizedEvents.has(event)
  ) {
    return false;
  }

  const applicationDirectory = dirname(execPath);
  if (!/^app-.+$/i.test(basename(applicationDirectory))) {
    throw new Error("IntentArc Squirrel application directory is malformed.");
  }
  const binaryRoot = dirname(applicationDirectory);
  const executeUpdate = runUpdate ??
    ((arguments_) => runSquirrelUpdate(binaryRoot, arguments_));
  let lifecycle: SquirrelLifecycleRecorder | undefined;
  try {
    lifecycle = await createSquirrelLifecycleRecorder({
      binaryRoot,
      environment,
      event,
      version,
    });
    await lifecycle?.record("entry-recognition", "completed");
    if (event === "--squirrel-install" || event === "--squirrel-updated") {
      await lifecycle?.record("release-metadata", "started");
      const requireSignatures = await loadSignatureRequirement(resourcesPath);
      await lifecycle?.record("release-metadata", "completed");
      await lifecycle?.record("bridge-staging-copy", "started");
      await installBridge({
        binaryRoot,
        payloadPath: join(resourcesPath, "bridge"),
        version,
        inspectLauncherIdentity: inspectIntrinsicBridgeIdentity,
        verify: bridgeVerifier(
          requireSignatures,
          verifyBridgeProtocol,
          inspectBridgeIdentity,
          lifecycle?.record,
        ),
      });
      await lifecycle?.record("shortcut-operation", "started");
      await executeUpdate([`--createShortcut=${basename(execPath)}`]);
      await lifecycle?.record("shortcut-operation", "completed");
    } else if (event === "--squirrel-uninstall") {
      await lifecycle?.record("shortcut-operation", "started");
      await executeUpdate([`--removeShortcut=${basename(execPath)}`]);
      await lifecycle?.record("shortcut-operation", "completed");
    }
    await lifecycle?.succeed();
    return true;
  } catch (error) {
    await lifecycle?.fail().catch(() => undefined);
    throw error;
  } finally {
    quit();
  }
};
