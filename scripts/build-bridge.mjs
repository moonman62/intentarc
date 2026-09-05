import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postject from "postject";
import {
  bridgeNativeRelativePath,
  directoryDigest,
  resolveBridgeSigningInputs,
  signAndVerifyBridgeNative,
} from "./bridge-native-release.mjs";

export { directoryDigest } from "./bridge-native-release.mjs";

export const BRIDGE_NODE_VERSION = "24.11.0";

const EXPECTED_PROCESS_VERSION = `v${BRIDGE_NODE_VERSION}`;
const BRIDGE_EXECUTABLE_NAME = "IntentArc Bridge.exe";
const NODE_SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BUILD_OWNER_SENTINEL = ".intentarc-bridge-build-owner";
const OUTPUT_OWNER_SENTINEL = ".intentarc-bridge-output-owner";
const STAGING_OWNER_SENTINEL = ".intentarc-bridge-staging-owner";
const OWNER_SENTINEL_CONTENT = "IntentArc dedicated bridge build v1\n";
const TARGET_NATIVE_PREBUILD = "win32-x64.node";
const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern = /^\d+\.\d+\.\d+$/;
const versionDirectoryPattern = /^\d+\.\d+\.\d+-[a-f0-9]{16}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export const createSeaConfig = (main, output) => ({
  main,
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: "none",
});

const compareVersions = (left, right) => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
};

const isPublisher = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "subject,thumbprint" &&
  typeof value.thumbprint === "string" &&
  /^[A-Fa-f0-9]{4,128}$/.test(value.thumbprint) &&
  typeof value.subject === "string" &&
  value.subject.length > 0 &&
  value.subject.length <= 1024;

export const parseAuthorizedPredecessor = (
  value,
  candidateBuildMode,
  candidateReleaseVersion,
) => {
  if (value === null) return null;
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
    value.formatVersion !== 1 ||
    typeof value.versionDirectory !== "string" ||
    !versionDirectoryPattern.test(value.versionDirectory) ||
    typeof value.releaseVersion !== "string" ||
    !versionPattern.test(value.releaseVersion) ||
    !value.versionDirectory.startsWith(`${value.releaseVersion}-`) ||
    value.buildMode !== candidateBuildMode ||
    typeof value.executableSha256 !== "string" ||
    !sha256Pattern.test(value.executableSha256) ||
    typeof value.payloadSha256 !== "string" ||
    !sha256Pattern.test(value.payloadSha256) ||
    typeof value.supportSha256 !== "string" ||
    !sha256Pattern.test(value.supportSha256) ||
    ("publisher" in value && !isPublisher(value.publisher)) ||
    (candidateBuildMode === "signed-release" && !isPublisher(value.publisher)) ||
    (candidateBuildMode === "unsigned-development" && "publisher" in value) ||
    compareVersions(value.releaseVersion, candidateReleaseVersion) >= 0
  ) {
    throw new Error(
      "IntentArc bridge predecessor authorization is malformed.",
    );
  }
  return value;
};

export const stripPeSignature = (executable) => {
  if (
    executable.length < 64 ||
    executable.toString("ascii", 0, 2) !== "MZ"
  ) {
    throw new Error("Node runtime is not a PE executable.");
  }

  const peOffset = executable.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  const optionalHeaderMagic = executable.readUInt16LE(optionalHeader);
  const dataDirectory = optionalHeader +
    (optionalHeaderMagic === 0x20b ? 112 : optionalHeaderMagic === 0x10b ? 96 : 0);
  if (dataDirectory === optionalHeader) {
    throw new Error("Node runtime has an unsupported PE optional header.");
  }

  const certificateDirectory = dataDirectory + (4 * 8);
  const certificateOffset = executable.readUInt32LE(certificateDirectory);
  const certificateSize = executable.readUInt32LE(certificateDirectory + 4);
  if (certificateOffset === 0 && certificateSize === 0) return executable;
  if (
    certificateOffset === 0 ||
    certificateSize === 0 ||
    certificateOffset + certificateSize > executable.length
  ) {
    throw new Error("Node runtime has a malformed PE signature directory.");
  }

  const unsigned = Buffer.from(executable);
  unsigned.writeUInt32LE(0, certificateDirectory);
  unsigned.writeUInt32LE(0, certificateDirectory + 4);
  return certificateOffset + certificateSize === unsigned.length
    ? unsigned.subarray(0, certificateOffset)
    : unsigned;
};

const assertBuildRuntime = () => {
  if (process.version !== EXPECTED_PROCESS_VERSION) {
    throw new Error(
      `IntentArc bridge requires Node ${BRIDGE_NODE_VERSION}; received ${process.version}.`,
    );
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      `IntentArc bridge requires win32-x64; received ${process.platform}-${process.arch}.`,
    );
  }
};

const pathExists = async (path) => {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};

const readOwnerSentinel = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};

const isAncestorOrEqual = (ancestor, candidate) => {
  const child = relative(ancestor, candidate);
  return child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(child));
};

const assertSafeBuildParent = (buildParent) => {
  if (dirname(buildParent) === buildParent) {
    throw new Error("IntentArc bridge build parent cannot be a filesystem root.");
  }
  if (isAncestorOrEqual(buildParent, packageRoot)) {
    throw new Error(
      "IntentArc bridge build parent cannot be the repository root or its ancestor.",
    );
  }
};

const assertDerivedCleanupTarget = (
  buildParent,
  target,
  expectedLeaf,
  label,
) => {
  if (
    target !== join(buildParent, expectedLeaf) ||
    !isAncestorOrEqual(buildParent, target) ||
    target === buildParent
  ) {
    throw new Error(
      `IntentArc bridge ${label} cleanup target is outside its safe build parent.`,
    );
  }
};

const ownerSentinelPaths = (buildParent) => ({
  build: join(buildParent, BUILD_OWNER_SENTINEL),
  output: join(buildParent, OUTPUT_OWNER_SENTINEL),
  staging: join(buildParent, STAGING_OWNER_SENTINEL),
});

const writeOwnerSentinels = async (sentinels) => {
  for (const path of Object.values(sentinels)) {
    await writeFile(path, OWNER_SENTINEL_CONTENT, {
      encoding: "utf8",
      flag: "wx",
    });
  }
};

const assertOwnerSentinel = async (path, label) => {
  if (await readOwnerSentinel(path) !== OWNER_SENTINEL_CONTENT) {
    throw new Error(
      `IntentArc bridge ${label} cleanup target is not helper-owned.`,
    );
  }
};

const ensureOwnedBuildParent = async (buildParent, trustedDefault) => {
  const sentinels = ownerSentinelPaths(buildParent);
  const parentInfo = await pathExists(buildParent);

  if (!parentInfo) {
    await mkdir(buildParent, { recursive: true });
    await writeOwnerSentinels(sentinels);
    return sentinels;
  }
  if (!parentInfo.isDirectory()) {
    throw new Error("IntentArc bridge build parent must be a directory.");
  }

  const sentinelContents = await Promise.all(
    Object.values(sentinels).map(readOwnerSentinel),
  );
  if (
    trustedDefault &&
    sentinelContents.every((content) => content === undefined)
  ) {
    await writeOwnerSentinels(sentinels);
    return sentinels;
  }
  if (
    sentinelContents.some((content) => content !== OWNER_SENTINEL_CONTENT)
  ) {
    throw new Error(
      "IntentArc bridge build parent is existing and not helper-owned.",
    );
  }
  return sentinels;
};

const removeOwnedTarget = async (target, sentinel, label) => {
  await assertOwnerSentinel(sentinel, label);
  await rm(target, { recursive: true, force: true });
};

const assertX64PeBinding = async (bindingPath) => {
  const binding = await readFile(bindingPath);
  if (binding.length < 64 || binding.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("better-sqlite3 win32-x64 binding is not a PE executable.");
  }
  const peOffset = binding.readUInt32LE(0x3c);
  const peSignature = binding.toString("binary", peOffset, peOffset + 4);
  const machine = binding.readUInt16LE(peOffset + 4);
  if (peSignature !== "PE\u0000\u0000" || machine !== 0x8664) {
    throw new Error("better-sqlite3 native binding architecture is not win32-x64.");
  }
};

const copyNativePackage = async (stagingRoot) => {
  const packageJsonPath = require.resolve("better-sqlite3/package.json");
  const packageSource = dirname(packageJsonPath);
  const packageMetadata = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageMetadata.version !== "13.0.1") {
    throw new Error(
      `IntentArc bridge requires better-sqlite3 13.0.1; received ${packageMetadata.version}.`,
    );
  }

  const bindingPath = join(packageSource, "prebuilds", "win32-x64.node");
  await assertX64PeBinding(bindingPath);
  const prebuildsSource = join(packageSource, "prebuilds");

  const packageTarget = join(
    stagingRoot,
    "node_modules",
    "better-sqlite3",
  );
  await mkdir(dirname(packageTarget), { recursive: true });
  await cp(packageSource, packageTarget, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) => {
      const nativePrebuild = relative(prebuildsSource, source);
      if (nativePrebuild === "") return true;
      const outsidePrebuilds = isAbsolute(nativePrebuild) ||
        /^\.\.(?:[\\/]|$)/.test(nativePrebuild);
      return outsidePrebuilds || nativePrebuild === TARGET_NATIVE_PREBUILD;
    },
  });
  return join(stagingRoot, bridgeNativeRelativePath);
};

export const prepareBridgeSupportTree = async ({
  stagingRoot,
  buildMode,
  environment = process.env,
  signNative = signAndVerifyBridgeNative,
}) => {
  const nativePath = await copyNativePackage(stagingRoot);
  const supportRoot = join(stagingRoot, "node_modules", "better-sqlite3");
  if (buildMode === "signed-release") {
    const signing = await resolveBridgeSigningInputs(environment);
    await signNative({ nativePath, ownerRoot: stagingRoot, signing });
  }
  return {
    supportRoot,
    nativePath,
    supportSha256: await directoryDigest(supportRoot),
  };
};

export const buildIntentArcBridge = async ({
  buildParent: requestedBuildParent,
  outputRoot: requestedOutputRoot,
  stagingRoot: requestedStagingRoot,
  releaseVersion: requestedReleaseVersion,
  buildMode: requestedBuildMode,
  authorizedPredecessor: requestedAuthorizedPredecessor,
} = {}) => {
  assertBuildRuntime();

  const distributionRoot = resolve(packageRoot, "dist");
  if (
    requestedOutputRoot !== undefined ||
    requestedStagingRoot !== undefined
  ) {
    throw new Error(
      "IntentArc bridge cleanup roots cannot be supplied directly; use a safe build parent.",
    );
  }
  const buildParent = resolve(requestedBuildParent ?? distributionRoot);
  assertSafeBuildParent(buildParent);

  const outputRoot = join(buildParent, "bridge");
  const stagingRoot = join(buildParent, ".intentarc-bridge-build");
  assertDerivedCleanupTarget(buildParent, outputRoot, "bridge", "output");
  assertDerivedCleanupTarget(
    buildParent,
    stagingRoot,
    ".intentarc-bridge-build",
    "staging",
  );

  const sentinels = await ensureOwnedBuildParent(
    buildParent,
    requestedBuildParent === undefined,
  );
  await removeOwnedTarget(stagingRoot, sentinels.staging, "staging");
  await mkdir(stagingRoot, { recursive: true });

  const bundleName = "bridge.cjs";
  const blobName = "bridge.blob";
  const bundlePath = join(stagingRoot, "bridge.cjs");
  const blobPath = join(stagingRoot, "bridge.blob");
  const configPath = join(stagingRoot, "sea-config.json");
  const executablePath = join(stagingRoot, BRIDGE_EXECUTABLE_NAME);
  try {
    const packageMetadata = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    const releaseVersion = requestedReleaseVersion ?? packageMetadata.version;
    const buildMode = requestedBuildMode ??
      (process.env.INTENTARC_RELEASE_BUILD === "1"
        ? "signed-release"
        : "unsigned-development");
    if (
      !/^\d+\.\d+\.\d+$/.test(releaseVersion) ||
      !["signed-release", "unsigned-development"].includes(buildMode)
    ) {
      throw new Error("IntentArc bridge build identity is invalid.");
    }
    let predecessorInput = requestedAuthorizedPredecessor;
    if (predecessorInput === undefined) {
      const configured = process.env.INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR;
      if (configured === undefined) {
        if (buildMode === "signed-release") {
          throw new Error(
            "IntentArc signed release requires explicit predecessor authorization.",
          );
        }
        predecessorInput = null;
      } else if (configured.trim().toLowerCase() === "none") {
        predecessorInput = null;
      } else {
        try {
          predecessorInput = JSON.parse(configured);
        } catch {
          throw new Error(
            "IntentArc bridge predecessor authorization is malformed.",
          );
        }
      }
    }
    const authorizedPredecessor = parseAuthorizedPredecessor(
      predecessorInput,
      buildMode,
      releaseVersion,
    );
    const { supportSha256 } = await prepareBridgeSupportTree({
      stagingRoot,
      buildMode,
    });
    await build({
      absWorkingDir: packageRoot,
      entryPoints: ["src/bridge/entry.ts"],
      outfile: bundlePath,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node24",
      external: ["better-sqlite3"],
      logLevel: "info",
      define: {
        "import.meta.url": JSON.stringify(
          "file:///C:/IntentArcBridge/entry.cjs",
        ),
      },
      plugins: [{
        name: "intentarc-bridge-version",
        setup(buildContext) {
          buildContext.onLoad(
            { filter: /[\\/]src[\\/]system[\\/]version\.ts$/ },
            () => ({
              loader: "ts",
              contents: [
                `export const packageVersion = ${JSON.stringify(releaseVersion)};`,
                "export const protocolVersion = 1;",
                "export function formatVersion(version: string): string {",
                "  return `intentarc ${version}`;",
                "}",
              ].join("\n"),
            }),
          );
          buildContext.onLoad(
            { filter: /[\\/]src[\\/]system[\\/]bridge-build-identity\.ts$/ },
            () => ({
              loader: "ts",
              contents:
                [
                  `export const bridgeBuildIdentity = ${JSON.stringify({
                    formatVersion: 1,
                    releaseVersion,
                    buildMode,
                    supportSha256,
                  })};`,
                  `export const bridgeAuthorizedPredecessor = ${
                    JSON.stringify(authorizedPredecessor)
                  };`,
                ].join("\n"),
            }),
          );
        },
      }],
      banner: {
        js: [
          "const { createRequire: __intentarcCreateRequire } = require(\"node:module\");",
          "require = __intentarcCreateRequire(process.execPath);",
        ].join("\n"),
      },
    });

    await writeFile(
      executablePath,
      stripPeSignature(await readFile(process.execPath)),
    );
    await writeFile(
      configPath,
      `${JSON.stringify(createSeaConfig(bundleName, blobName), null, 2)}\n`,
      "utf8",
    );
    await executeFile(process.execPath, [
      "--experimental-sea-config",
      configPath,
    ], {
      cwd: stagingRoot,
      windowsHide: true,
    });
    const blob = await readFile(blobPath);
    await postject.inject(
      executablePath,
      "NODE_SEA_BLOB",
      blob,
      { sentinelFuse: NODE_SEA_SENTINEL },
    );

    await rm(bundlePath, { force: true });
    await rm(blobPath, { force: true });
    await rm(configPath, { force: true });
    await removeOwnedTarget(outputRoot, sentinels.output, "output");
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    try {
      await removeOwnedTarget(stagingRoot, sentinels.staging, "staging");
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "IntentArc bridge build and owned staging cleanup failed.",
      );
    }
    throw error;
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await buildIntentArcBridge();
}
