import type { ForgeHookFn } from "@electron-forge/shared-types";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, normalize } from "node:path";
import {
  assertOwnedX64Pe,
  bridgeNativeRelativePath,
  directoryDigest,
  packagedBridgeNativeRelativePath,
  resolveBridgeSigningInputs,
  runBoundedWindowsSign,
  sha256File,
  verifyBridgeNativeArtifacts,
} from "./bridge-native-release.mjs";
import {
  readAuthenticodePublisher,
  verifyAuthenticodeSignature,
} from "./windows-authenticode.mjs";

export interface BridgeNativeSigningAdapterDependencies {
  sign(options: {
    files: string[];
    certificateFile: string;
    certificatePassword: string;
    signToolPath: string;
    hashes: ["sha256"];
  }): Promise<void>;
  verifyAuthenticodeSignature(path: string): Promise<void>;
  readAuthenticodePublisher(path: string): Promise<{
    thumbprint: string;
    subject: string;
  }>;
}

export interface BridgeNativeSigningAdapter {
  windowsSign: { hookFunction(fileToSign: string): Promise<void> };
  postPackage: ForgeHookFn<"postPackage">;
  postMake: ForgeHookFn<"postMake">;
}

interface CreateBridgeNativeSigningAdapterOptions {
  packageRoot: string;
  environment: Partial<Record<string, string | undefined>>;
  dependencies?: Partial<BridgeNativeSigningAdapterDependencies>;
}

interface PreservedCandidate {
  nativePath: string;
  packagedRoot: string;
}

const packageSigningFailure =
  "IntentArc Windows package signing did not complete safely.";
const fullNupkgCountFailure =
  "IntentArc Windows release requires exactly one full nupkg.";
const artifactVerificationFailure =
  "IntentArc Windows release artifacts could not be verified safely.";
const canonicalPackagedSuffix = packagedBridgeNativeRelativePath
  .replaceAll("\\", "/")
  .toLowerCase();
const safeArtifactErrors = new Set([
  "IntentArc bridge artifact verification requires an exact 40-hex publisher thumbprint.",
  "IntentArc bridge artifact extraction parent is unsafe.",
  "IntentArc full nupkg could not be inspected.",
  "IntentArc full nupkg is missing the canonical bridge native entry.",
  "IntentArc bridge native artifacts do not match.",
  "IntentArc bridge support artifacts do not match.",
  "IntentArc bridge native publisher verification failed.",
  "IntentArc bridge native publisher does not match the configured release publisher.",
  "IntentArc packaged bridge identity could not be verified.",
  "IntentArc packaged bridge support digest does not match its embedded identity.",
]);

export const defaultBridgeNativeSigningAdapterDependencies:
  BridgeNativeSigningAdapterDependencies = {
  sign: runBoundedWindowsSign,
  verifyAuthenticodeSignature,
  readAuthenticodePublisher,
};

const derivePackagedRoot = (candidatePath: string): string | undefined => {
  const normalizedCandidate = candidatePath.replaceAll("\\", "/");
  const suffix = `/${canonicalPackagedSuffix}`;
  if (!normalizedCandidate.toLowerCase().endsWith(suffix)) return undefined;
  const root = normalizedCandidate.slice(0, -suffix.length);
  return root ? normalize(root) : undefined;
};

const exactPublisher = async (
  nativePath: string,
  expectedThumbprint: string,
  dependencies: BridgeNativeSigningAdapterDependencies,
): Promise<void> => {
  await dependencies.verifyAuthenticodeSignature(nativePath);
  const publisher = await dependencies.readAuthenticodePublisher(nativePath);
  if (
    typeof publisher?.thumbprint !== "string" ||
    !/^[A-Fa-f0-9]{40}$/.test(publisher.thumbprint) ||
    typeof publisher.subject !== "string" ||
    publisher.subject.length === 0 ||
    publisher.thumbprint.toUpperCase() !== expectedThumbprint
  ) {
    throw new Error(packageSigningFailure);
  }
};

const safeArtifactError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : "";
  return new Error(
    safeArtifactErrors.has(message) ? message : artifactVerificationFailure,
  );
};

export const createBridgeNativeSigningAdapter = ({
  packageRoot,
  environment,
  dependencies: dependencyOverrides,
}: CreateBridgeNativeSigningAdapterOptions): BridgeNativeSigningAdapter => {
  const dependencies = {
    ...defaultBridgeNativeSigningAdapterDependencies,
    ...dependencyOverrides,
  };
  let retainedFailure: "windows-signing" | undefined;
  let preservedCandidate: string | undefined;

  const getSigningInputs = () => resolveBridgeSigningInputs(environment);

  const verifyPreservedCandidate = async (
    candidatePath: string,
  ): Promise<PreservedCandidate> => {
    const derivedRoot = derivePackagedRoot(candidatePath);
    if (!derivedRoot) throw new Error(packageSigningFailure);
    const packagedRoot = await realpath(derivedRoot);
    const nativePath = await assertOwnedX64Pe(candidatePath, packagedRoot);
    const distBridgeRoot = await realpath(join(packageRoot, "dist", "bridge"));
    const distNativePath = await assertOwnedX64Pe(
      join(distBridgeRoot, bridgeNativeRelativePath),
      distBridgeRoot,
    );
    const [candidateSha256, distSha256] = await Promise.all([
      sha256File(nativePath),
      sha256File(distNativePath),
    ]);
    if (candidateSha256 !== distSha256) {
      throw new Error(packageSigningFailure);
    }
    const signing = await getSigningInputs();
    await exactPublisher(
      nativePath,
      signing.certificateThumbprint,
      dependencies,
    );
    return { nativePath, packagedRoot };
  };

  const verifyPackagedTree = async (
    candidatePath: string,
  ): Promise<PreservedCandidate> => {
    const preserved = await verifyPreservedCandidate(candidatePath);
    const [distSupportSha256, packagedSupportSha256] = await Promise.all([
      directoryDigest(join(
        packageRoot,
        "dist",
        "bridge",
        "node_modules",
        "better-sqlite3",
      )),
      directoryDigest(join(
        preserved.packagedRoot,
        "resources",
        "bridge",
        "node_modules",
        "better-sqlite3",
      )),
    ]);
    if (distSupportSha256 !== packagedSupportSha256) {
      throw new Error(packageSigningFailure);
    }
    return preserved;
  };

  const hookFunction = async (fileToSign: string): Promise<void> => {
    try {
      if (derivePackagedRoot(fileToSign)) {
        const verified = await verifyPreservedCandidate(fileToSign);
        if (
          preservedCandidate !== undefined &&
          preservedCandidate !== verified.nativePath
        ) {
          throw new Error(packageSigningFailure);
        }
        preservedCandidate = verified.nativePath;
        return;
      }
      const signing = await getSigningInputs();
      await dependencies.sign({
        files: [fileToSign],
        certificateFile: signing.certificateFile,
        certificatePassword: signing.certificatePassword,
        signToolPath: signing.signToolPath,
        hashes: ["sha256"],
      });
    } catch {
      retainedFailure = "windows-signing";
      throw new Error(packageSigningFailure);
    }
  };

  const postPackage: ForgeHookFn<"postPackage"> = async (
    _forgeConfig,
    packageResult,
  ) => {
    try {
      if (retainedFailure) throw new Error(packageSigningFailure);
      if (packageResult.platform !== "win32" || packageResult.arch !== "x64") {
        return;
      }
      if (!preservedCandidate) throw new Error(packageSigningFailure);
      const derivedRoot = derivePackagedRoot(preservedCandidate);
      if (!derivedRoot) throw new Error(packageSigningFailure);
      const packagedRoot = await realpath(derivedRoot);
      const outputPaths = await Promise.all(
        packageResult.outputPaths.map(async (outputPath) => {
          try {
            return await realpath(outputPath);
          } catch {
            return undefined;
          }
        }),
      );
      if (!outputPaths.includes(packagedRoot)) {
        throw new Error(packageSigningFailure);
      }
      await verifyPackagedTree(preservedCandidate);
    } catch {
      retainedFailure = "windows-signing";
      throw new Error(packageSigningFailure);
    }
  };

  const postMake: ForgeHookFn<"postMake"> = async (
    _forgeConfig,
    makeResults,
  ) => {
    if (retainedFailure || !preservedCandidate) {
      throw new Error(packageSigningFailure);
    }
    const fullNupkgPaths = makeResults.flatMap((result) =>
      result.artifacts.filter((artifact) => /-full\.nupkg$/i.test(artifact))
    );
    if (fullNupkgPaths.length !== 1) {
      retainedFailure = "windows-signing";
      throw new Error(fullNupkgCountFailure);
    }
    const preserved = await verifyPackagedTree(preservedCandidate).catch(() => {
      retainedFailure = "windows-signing";
      throw new Error(packageSigningFailure);
    });
    const signing = await getSigningInputs().catch(() => {
      retainedFailure = "windows-signing";
      throw new Error(packageSigningFailure);
    });
    let extractionRoot: string;
    try {
      extractionRoot = await mkdtemp(join(
        await realpath(packageRoot),
        ".intentarc-forge-native-",
      ));
    } catch {
      retainedFailure = "windows-signing";
      throw new Error(artifactVerificationFailure);
    }
    let verificationFailure: unknown;
    let cleanupFailed = false;
    try {
      await verifyBridgeNativeArtifacts({
        distBridgeRoot: join(packageRoot, "dist", "bridge"),
        packagedRoot: preserved.packagedRoot,
        fullNupkgPath: fullNupkgPaths[0]!,
        extractionParent: extractionRoot,
        expectedThumbprint: signing.certificateThumbprint,
        verifyEmbeddedIdentity: false,
        readPublisher: dependencies.readAuthenticodePublisher,
      });
    } catch (error) {
      verificationFailure = error;
    } finally {
      try {
        await rm(extractionRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      retainedFailure = "windows-signing";
      throw new Error(artifactVerificationFailure);
    }
    if (verificationFailure) {
      retainedFailure = "windows-signing";
      throw safeArtifactError(verificationFailure);
    }
    return makeResults;
  };

  return {
    windowsSign: { hookFunction },
    postPackage,
    postMake,
  };
};
