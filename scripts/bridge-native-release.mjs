import { sign as windowsSign } from "@electron/windows-sign";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  isAbsolute,
  join,
  parse,
  relative,
} from "node:path";
import extractZip from "extract-zip";
import { directoryDigest } from "./bridge-support-integrity.mjs";
import { readPackagedBridgeIdentity } from "./desktop-release.mjs";
import {
  readAuthenticodePublisher,
  verifyAuthenticodeSignature,
} from "./windows-authenticode.mjs";

export { directoryDigest } from "./bridge-support-integrity.mjs";

const require = createRequire(import.meta.url);
const windowsSignRequire = createRequire(
  require.resolve("@electron/windows-sign"),
);
const windowsSignDebug = windowsSignRequire("debug");
let defaultWindowsSignActive = false;

const isAmbientWindowsSignInput = (key) =>
  /^(?:WINDOWS_(?:SIGN|CERTIFICATE_|TIMESTAMP_SERVER$)|INTENTARC_WINDOWS_CERTIFICATE(?:_|$))/i
    .test(key);

export const runBoundedWindowsSign = async (options) => {
  if (defaultWindowsSignActive) {
    throw new Error("IntentArc bridge native signing is already active.");
  }
  defaultWindowsSignActive = true;
  const savedEnvironment = Object.entries(process.env)
    .filter(([key]) => isAmbientWindowsSignInput(key));
  const previousDebug = windowsSignDebug.disable();
  windowsSignDebug.enable(
    previousDebug
      ? `${previousDebug},-electron-windows-sign`
      : "-electron-windows-sign",
  );
  for (const [key] of savedEnvironment) delete process.env[key];
  try {
    await windowsSign(options);
  } finally {
    for (const [key, value] of savedEnvironment) process.env[key] = value;
    windowsSignDebug.disable();
    windowsSignDebug.enable(previousDebug);
    defaultWindowsSignActive = false;
  }
};

export const bridgeNativeRelativePath = join(
  "node_modules",
  "better-sqlite3",
  "prebuilds",
  "win32-x64.node",
);
export const packagedBridgeNativeRelativePath = join(
  "resources",
  "bridge",
  bridgeNativeRelativePath,
);
export const fullNupkgBridgeNativePath = [
  "lib",
  "net45",
  "resources",
  "bridge",
  "node_modules",
  "better-sqlite3",
  "prebuilds",
  "win32-x64.node",
].join("/");

const signingFile = async (configuredPath, label) => {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error(`IntentArc bridge signing ${label} must be absolute.`);
  }
  let configuredInfo;
  let canonicalPath;
  try {
    configuredInfo = await lstat(configuredPath);
    canonicalPath = await realpath(configuredPath);
  } catch {
    throw new Error(`IntentArc bridge signing ${label} must be a file.`);
  }
  const canonicalInfo = await lstat(canonicalPath);
  if (
    configuredInfo.isSymbolicLink() ||
    !canonicalInfo.isFile() ||
    canonicalInfo.isSymbolicLink() ||
    canonicalInfo.nlink !== 1
  ) {
    throw new Error(
      `IntentArc bridge signing ${label} must be a regular non-link file.`,
    );
  }
  return canonicalPath;
};

export const resolveBridgeSigningInputs = async (environment) => {
  const certificate = environment.INTENTARC_WINDOWS_CERTIFICATE?.trim();
  const password = environment.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD;
  const thumbprint =
    environment.INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT?.trim().toUpperCase() ??
    "";
  const signTool = environment.WINDOWS_SIGNTOOL_PATH?.trim();
  if (!certificate) {
    throw new Error("IntentArc bridge signing certificate file is required.");
  }
  if (!password) {
    throw new Error("IntentArc bridge signing certificate password is required.");
  }
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
    throw new Error(
      "IntentArc bridge signing requires an exact 40-hex certificate thumbprint.",
    );
  }
  if (!signTool) {
    throw new Error("IntentArc bridge signing SignTool file is required.");
  }
  const certificateFile = await signingFile(certificate, "certificate file");
  const signToolPath = await signingFile(signTool, "SignTool file");
  return {
    certificateFile,
    certificatePassword: password,
    certificateThumbprint: thumbprint,
    signToolPath,
  };
};

const isContained = (ownerRoot, candidate) => {
  const child = relative(ownerRoot, candidate);
  return child !== "" && !isAbsolute(child) && !/^\.\.(?:[\\/]|$)/.test(child);
};

const assertOwnedRegularFile = async (candidatePath, ownerRoot) => {
  let requestedInfo;
  let canonicalRoot;
  let canonicalPath;
  try {
    requestedInfo = await lstat(candidatePath);
    canonicalRoot = await realpath(ownerRoot);
    canonicalPath = await realpath(candidatePath);
  } catch {
    throw new Error("IntentArc bridge native must be a regular non-link file.");
  }
  if (!isContained(canonicalRoot, canonicalPath)) {
    throw new Error("IntentArc bridge native is outside its owned root.");
  }
  const canonicalInfo = await lstat(canonicalPath);
  if (
    requestedInfo.isSymbolicLink() ||
    !canonicalInfo.isFile() ||
    canonicalInfo.isSymbolicLink() ||
    canonicalInfo.nlink !== 1
  ) {
    throw new Error("IntentArc bridge native must be a regular non-link file.");
  }
  return canonicalPath;
};

export const assertOwnedX64Pe = async (candidatePath, ownerRoot) => {
  const canonicalPath = await assertOwnedRegularFile(candidatePath, ownerRoot);
  const executable = await readFile(canonicalPath);
  if (executable.length < 0x40 || executable.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("IntentArc bridge native must be a win32-x64 PE file.");
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (
    peOffset > executable.length - 6 ||
    executable.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\0\0" ||
    executable.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error("IntentArc bridge native must be a win32-x64 PE file.");
  }
  return canonicalPath;
};

export const sha256File = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex");

export const signAndVerifyBridgeNative = async ({
  nativePath,
  ownerRoot,
  signing,
  sign = runBoundedWindowsSign,
  verifySignature = verifyAuthenticodeSignature,
  readPublisher = readAuthenticodePublisher,
}) => {
  const ownedNativePath = await assertOwnedX64Pe(nativePath, ownerRoot);
  const ownedNativeRelativePath = relative(
    await realpath(ownerRoot),
    ownedNativePath,
  );
  if (ownedNativeRelativePath !== bridgeNativeRelativePath) {
    throw new Error(
      "IntentArc bridge native signing target must be the canonical better-sqlite3 win32-x64 prebuild.",
    );
  }
  try {
    await sign({
      files: [ownedNativePath],
      certificateFile: signing.certificateFile,
      certificatePassword: signing.certificatePassword,
      signToolPath: signing.signToolPath,
      hashes: ["sha256"],
    });
  } catch {
    throw new Error("IntentArc bridge native signing failed.");
  }
  try {
    await verifySignature(ownedNativePath);
  } catch {
    throw new Error("IntentArc bridge native signature verification failed.");
  }
  let publisherThumbprint;
  try {
    const publisher = await readPublisher(ownedNativePath);
    if (
      typeof publisher?.thumbprint !== "string" ||
      !/^[A-Fa-f0-9]{40}$/.test(publisher.thumbprint) ||
      typeof publisher.subject !== "string" ||
      publisher.subject.length === 0
    ) {
      throw new Error("malformed publisher");
    }
    publisherThumbprint = publisher.thumbprint.toUpperCase();
  } catch {
    throw new Error("IntentArc bridge native publisher verification failed.");
  }
  if (
    publisherThumbprint !== signing.certificateThumbprint
  ) {
    throw new Error(
      "IntentArc bridge native publisher does not match the configured release publisher.",
    );
  }
  return {
    nativePath: ownedNativePath,
    sha256: await sha256File(ownedNativePath),
  };
};

export const verifyBridgeNativeArtifacts = async ({
  distBridgeRoot,
  packagedRoot,
  fullNupkgPath,
  extractionParent,
  expectedThumbprint,
  verifyEmbeddedIdentity = true,
  readBridgeIdentity = readPackagedBridgeIdentity,
  readPublisher = readAuthenticodePublisher,
  environment = process.env,
}) => {
  const normalizedThumbprint = expectedThumbprint?.trim().toUpperCase() ?? "";
  if (!/^[A-F0-9]{40}$/.test(normalizedThumbprint)) {
    throw new Error(
      "IntentArc bridge artifact verification requires an exact 40-hex publisher thumbprint.",
    );
  }
  const extractionParentInfo = await lstat(extractionParent);
  const canonicalExtractionParent = await realpath(extractionParent);
  if (
    extractionParentInfo.isSymbolicLink() ||
    !extractionParentInfo.isDirectory() ||
    canonicalExtractionParent === parse(canonicalExtractionParent).root
  ) {
    throw new Error("IntentArc bridge artifact extraction parent is unsafe.");
  }
  const extractionRoot = await mkdtemp(
    join(canonicalExtractionParent, "intentarc-bridge-native-"),
  );
  const distNativePath = join(distBridgeRoot, bridgeNativeRelativePath);
  const packagedNativePath = join(
    packagedRoot,
    packagedBridgeNativeRelativePath,
  );
  const extractedNativePath = join(
    extractionRoot,
    ...fullNupkgBridgeNativePath.split("/"),
  );
  try {
    try {
      await extractZip(fullNupkgPath, { dir: extractionRoot });
    } catch {
      throw new Error("IntentArc full nupkg could not be inspected.");
    }
    try {
      await assertOwnedRegularFile(extractedNativePath, extractionRoot);
    } catch {
      throw new Error(
        "IntentArc full nupkg is missing the canonical bridge native entry.",
      );
    }
    const [distSha256, packagedSha256, nupkgSha256] = await Promise.all([
      sha256File(distNativePath),
      sha256File(packagedNativePath),
      sha256File(extractedNativePath),
    ]);
    if (distSha256 !== packagedSha256 || distSha256 !== nupkgSha256) {
      throw new Error("IntentArc bridge native artifacts do not match.");
    }
    let publisherThumbprints;
    try {
      const publishers = await Promise.all([
        readPublisher(distNativePath),
        readPublisher(packagedNativePath),
        readPublisher(extractedNativePath),
      ]);
      publisherThumbprints = publishers.map((publisher) => {
        if (
          typeof publisher?.thumbprint !== "string" ||
          !/^[A-Fa-f0-9]{40}$/.test(publisher.thumbprint) ||
          typeof publisher.subject !== "string" ||
          publisher.subject.length === 0
        ) {
          throw new Error("malformed publisher");
        }
        return publisher.thumbprint.toUpperCase();
      });
    } catch {
      throw new Error("IntentArc bridge native publisher verification failed.");
    }
    if (publisherThumbprints.some((thumbprint) =>
      thumbprint !== normalizedThumbprint
    )) {
      throw new Error(
        "IntentArc bridge native publisher does not match the configured release publisher.",
      );
    }
    const [distSupportSha256, packagedSupportSha256] = await Promise.all([
      directoryDigest(join(
        distBridgeRoot,
        "node_modules",
        "better-sqlite3",
      )),
      directoryDigest(join(
        packagedRoot,
        "resources",
        "bridge",
        "node_modules",
        "better-sqlite3",
      )),
    ]);
    if (distSupportSha256 !== packagedSupportSha256) {
      throw new Error("IntentArc bridge support artifacts do not match.");
    }
    if (verifyEmbeddedIdentity) {
      const identityPath = join(
        packagedRoot,
        "resources",
        "bridge",
        "IntentArc Bridge.exe",
      );
      let identity;
      try {
        identity = await readBridgeIdentity(identityPath, {
          ownerRoot: packagedRoot,
          environment,
        });
      } catch {
        throw new Error(
          "IntentArc packaged bridge identity could not be verified.",
        );
      }
      if (
        identity.formatVersion !== 1 ||
        identity.buildMode !== "signed-release" ||
        identity.supportSha256 !== packagedSupportSha256
      ) {
        throw new Error(
          "IntentArc packaged bridge support digest does not match its embedded identity.",
        );
      }
    }
    return {
      nativeSha256: distSha256,
      supportSha256: packagedSupportSha256,
      publisherThumbprint: normalizedThumbprint,
      distNativePath,
      packagedNativePath,
      nupkgEntry: fullNupkgBridgeNativePath,
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
};
