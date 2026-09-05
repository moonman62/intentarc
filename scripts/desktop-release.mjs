import { execFile, spawn } from "node:child_process";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  readAuthenticodePublisher,
  verifyAuthenticodeSignature,
} from "./windows-authenticode.mjs";
import {
  createPnpmLifecycleInvocation,
  resolvePnpmLifecycleInvocation,
} from "./pnpm-lifecycle.mjs";
import { directoryDigest } from "./bridge-support-integrity.mjs";
import {
  recordBridgeDiagnostic,
  recheckBridgeDiagnosticExecutable,
} from "./bridge-diagnostic-audit.mjs";

export {
  readAuthenticodePublisher,
  verifyAuthenticodeSignature,
};

const executeFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseMakeArguments = Object.freeze(["desktop:make"]);
const diagnosticDefinitions = Object.freeze({
  identity: Object.freeze({ arguments: ["--bridge-identity"] }),
  predecessor: Object.freeze({
    arguments: ["--bridge-authorized-predecessor"],
  }),
});

const runPackagedBridgeDiagnostic = async ({
  path,
  token,
  ownerRoot,
  environment,
}) => {
  const definition = diagnosticDefinitions[token];
  if (!definition) {
    throw new Error("IntentArc bridge diagnostic audit failed.");
  }
  const proof = await recordBridgeDiagnostic({
    auditRoot: environment.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT,
    auditPath: environment.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH,
    executablePath: path,
    ownerRoot,
    token,
  });
  let result;
  let executionFailed = false;
  try {
    result = await executeFile(path, definition.arguments, {
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    });
  } catch {
    executionFailed = true;
  }
  await recheckBridgeDiagnosticExecutable(proof);
  if (executionFailed) {
    throw new Error("IntentArc bridge diagnostic execution failed.");
  }
  return result;
};

export const assertReleaseSigningEnvironment = (environment) => {
  if (
    !environment.INTENTARC_WINDOWS_CERTIFICATE?.trim() ||
    !environment.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD
  ) {
    throw new Error(
      "Release signing requires INTENTARC_WINDOWS_CERTIFICATE and INTENTARC_WINDOWS_CERTIFICATE_PASSWORD.",
    );
  }
  if (
    !/^[0-9a-f]{40}$/i.test(
      environment.INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT?.trim() ?? "",
    )
  ) {
    throw new Error(
      "Release signing requires an exact 40-hex SHA-1 certificate thumbprint.",
    );
  }
  if (!environment.INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR?.trim()) {
    throw new Error(
      "Release signing requires explicit bridge predecessor authorization.",
    );
  }
};

export const readPackagedBridgeIdentity = async (
  path,
  { ownerRoot, environment = process.env } = {},
) => {
  const { stdout } = await runPackagedBridgeDiagnostic({
    path,
    token: "identity",
    ownerRoot,
    environment,
  });
  let identity;
  try {
    identity = JSON.parse(stdout);
  } catch {
    throw new Error("IntentArc release bridge identity is malformed.");
  }
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    identity.formatVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(identity.releaseVersion) ||
    !/^[a-f0-9]{64}$/.test(identity.supportSha256) ||
    !["signed-release", "unsigned-development"].includes(identity.buildMode)
  ) {
    throw new Error("IntentArc release bridge identity is malformed.");
  }
  return identity;
};

export const readPackagedBridgePredecessor = async (
  path,
  { ownerRoot, environment = process.env } = {},
) => {
  const { stdout } = await runPackagedBridgeDiagnostic({
    path,
    token: "predecessor",
    ownerRoot,
    environment,
  });
  let predecessor;
  try {
    predecessor = JSON.parse(stdout);
  } catch {
    throw new Error(
      "IntentArc release bridge predecessor authorization is malformed.",
    );
  }
  if (predecessor === null) return null;
  const publisher = predecessor?.publisher;
  const expectedKeys = [
    "buildMode",
    "executableSha256",
    "formatVersion",
    "payloadSha256",
    "publisher",
    "releaseVersion",
    "supportSha256",
    "versionDirectory",
  ].sort().join(",");
  if (
    typeof predecessor !== "object" ||
    Array.isArray(predecessor) ||
    Object.keys(predecessor).sort().join(",") !== expectedKeys ||
    predecessor.formatVersion !== 1 ||
    typeof predecessor.releaseVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(predecessor.releaseVersion) ||
    predecessor.buildMode !== "signed-release" ||
    !new RegExp(
      `^${predecessor.releaseVersion.replaceAll(".", "\\.")}-[a-f0-9]{16}$`,
    ).test(predecessor.versionDirectory) ||
    !/^[a-f0-9]{64}$/.test(predecessor.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(predecessor.payloadSha256) ||
    !/^[a-f0-9]{64}$/.test(predecessor.supportSha256) ||
    typeof publisher !== "object" ||
    publisher === null ||
    Array.isArray(publisher) ||
    Object.keys(publisher).sort().join(",") !== "subject,thumbprint" ||
    typeof publisher.thumbprint !== "string" ||
    !/^[A-Fa-f0-9]{4,128}$/.test(publisher.thumbprint) ||
    typeof publisher.subject !== "string" ||
    publisher.subject.length === 0 ||
    publisher.subject.length > 1024
  ) {
    throw new Error(
      "IntentArc release bridge predecessor authorization is malformed.",
    );
  }
  return predecessor;
};

export const verifyReleaseExecutables = async ({
  outputRoot,
  environment = process.env,
  verifySignature = verifyAuthenticodeSignature,
  inspectBridgeIdentity = readPackagedBridgeIdentity,
  inspectBridgePredecessor = readPackagedBridgePredecessor,
  readPublisher = readAuthenticodePublisher,
  digestBridgeSupport = directoryDigest,
}) => {
  const paths = [
    join(outputRoot, "IntentArc-win32-x64", "IntentArc.exe"),
    join(
      outputRoot,
      "IntentArc-win32-x64",
      "resources",
      "bridge",
      "IntentArc Bridge.exe",
    ),
    join(
      outputRoot,
      "make",
      "squirrel.windows",
      "x64",
      "IntentArc Setup.exe",
    ),
  ];
  for (const path of paths) await verifySignature(path);
  const diagnosticContext = { ownerRoot: outputRoot, environment };
  const identity = await inspectBridgeIdentity(paths[1], diagnosticContext);
  if (identity.buildMode !== "signed-release") {
    throw new Error(
      "IntentArc public release bridge must embed signed-release mode.",
    );
  }
  const packagedSupportSha256 = await digestBridgeSupport(join(
    outputRoot,
    "IntentArc-win32-x64",
    "resources",
    "bridge",
    "node_modules",
    "better-sqlite3",
  ));
  if (identity.supportSha256 !== packagedSupportSha256) {
    throw new Error(
      "IntentArc packaged bridge support digest does not match its embedded identity.",
    );
  }
  const publishers = await Promise.all(paths.map(readPublisher));
  if (publishers.some((publisher) =>
    publisher.thumbprint.toUpperCase() !==
      publishers[0].thumbprint.toUpperCase() ||
    publisher.subject !== publishers[0].subject
  )) {
    throw new Error(
      "IntentArc release executables must share one authorized publisher.",
    );
  }
  const predecessor = await inspectBridgePredecessor(
    paths[1],
    diagnosticContext,
  );
  if (
    predecessor &&
    (
      predecessor.buildMode !== "signed-release" ||
      predecessor.publisher.thumbprint.toUpperCase() !==
        publishers[1].thumbprint.toUpperCase() ||
      predecessor.publisher.subject !== publishers[1].subject
    )
  ) {
    throw new Error(
      "IntentArc release predecessor authorization must preserve the signed publisher.",
    );
  }
  return paths;
};

export const createPnpmInvocation = (cliPath, runtime = {}) =>
  createPnpmLifecycleInvocation(cliPath, releaseMakeArguments, runtime);

export const resolvePnpmInvocation = (environment) =>
  resolvePnpmLifecycleInvocation(environment, releaseMakeArguments);

const runReleaseMake = async (environment) => {
  const invocation = await resolvePnpmInvocation(environment);
  return new Promise((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: packageRoot,
      env: {
        ...environment,
        INTENTARC_RELEASE_BUILD: "1",
      },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(
          code === null
            ? `IntentArc release make ended with signal ${signal ?? "unknown"}.`
            : `IntentArc release make exited with code ${code}.`,
        ));
      }
    });
  });
};

export const runDesktopRelease = async (environment = process.env) => {
  assertReleaseSigningEnvironment(environment);
  await runReleaseMake(environment);
  const outputRoot = join(packageRoot, "out");
  await verifyReleaseExecutables({ outputRoot, environment });
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runDesktopRelease();
}
