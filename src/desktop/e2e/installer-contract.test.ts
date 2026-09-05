import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createForgeConfig,
  desktopPackageIgnore,
} from "../../../forge.config.js";
import {
  createBridgeNativeSigningAdapter,
  defaultBridgeNativeSigningAdapterDependencies,
} from "../../../scripts/forge-bridge-native-signing.js";
import { runBoundedWindowsSign } from
  "../../../scripts/bridge-native-release.mjs";
import {
  handleSquirrelEvent,
  verifyAuthenticodeSignature as verifyInstalledBridgeSignature,
  type SquirrelBridgeInstaller,
} from "../squirrel.js";
import {
  type DesktopElectronFacade,
  type DesktopWindowOptions,
  type RunIntentArcDesktopOptions,
} from "../main.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const selectorEnvironmentKeys = new Set([
  "comspec",
  "path",
  "systemroot",
]);
const selectorEnvironments = [
  {
    label: "hostile",
    environment: {
      SystemRoot: "C:\\attacker-system-root",
      SYSTEMROOT: "D:\\attacker-system-root",
      PATH: "C:\\attacker-bin",
      ComSpec: "C:\\attacker-cmd.exe",
    },
  },
  {
    label: "empty",
    environment: {
      SystemRoot: "",
      SYSTEMROOT: "",
      PATH: "",
      ComSpec: "",
    },
  },
] as const;
const squirrelLifecycleReceiptName = ".intentarc-squirrel-lifecycle.json";
const canonicalBridgeNativeNupkg = Buffer.from(
  "UEsDBBQAAAAIAMN9C123HYjACwAAAAYAAABPAAAAbGliL25ldDQ1L3Jlc291cmNlcy9icmlkZ2Uvbm9kZV9tb2R1bGVzL2JldHRlci1zcWxpdGUzL3ByZWJ1aWxkcy93aW4zMi14NjQubm9kZQEGAPn/bmF0aXZlUEsBAhQAFAAAAAgAw30LXbcdiMALAAAABgAAAE8AAAAAAAAAAAAAAAAAAAAAAGxpYi9uZXQ0NS9yZXNvdXJjZXMvYnJpZGdlL25vZGVfbW9kdWxlcy9iZXR0ZXItc3FsaXRlMy9wcmVidWlsZHMvd2luMzIteDY0Lm5vZGVQSwUGAAAAAAEAAQB9AAAAeAAAAAAA",
  "base64",
);
const missingBridgeNativeNupkg = Buffer.from(
  "UEsDBBQAAAAIAMN9C123HYjACwAAAAYAAAAlAAAAbGliL25ldDQ1L3Jlc291cmNlcy9icmlkZ2Uvd3Jvbmcubm9kZQEGAPn/bmF0aXZlUEsBAhQAFAAAAAgAw30LXbcdiMALAAAABgAAACUAAAAAAAAAAAAAAAAAAAAAAGxpYi9uZXQ0NS9yZXNvdXJjZXMvYnJpZGdlL3dyb25nLm5vZGVQSwUGAAAAAAEAAQBTAAAATgAAAAAA",
  "base64",
);

const createX64PeFixture = (marker = 0): Buffer => {
  const executable = Buffer.alloc(256, marker);
  executable.write("MZ", 0, "ascii");
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write("PE\0\0", 0x80, "binary");
  executable.writeUInt16LE(0x8664, 0x84);
  return executable;
};

const crc32 = (contents: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const createStoredZipEntry = (name: string, contents: Buffer): Buffer => {
  const encodedName = Buffer.from(name, "utf8");
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(contents.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(encodedName.length, 26);
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(contents.length, 20);
  centralHeader.writeUInt32LE(contents.length, 24);
  centralHeader.writeUInt16LE(encodedName.length, 28);
  const localEntry = Buffer.concat([localHeader, encodedName, contents]);
  const centralEntry = Buffer.concat([centralHeader, encodedName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralEntry.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, end]);
};

const createForgeSigningAdapterFixture = async (
  label: string,
  { throwOnProductExecution = false } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), `intentarc-forge-signing-${label}-`));
  temporaryRoots.push(root);
  const packageRoot = join(root, "repository");
  const packagedRoot = join(packageRoot, "out", "IntentArc-win32-x64");
  const distBridgeRoot = join(packageRoot, "dist", "bridge");
  const nativeRelativeParts = [
    "node_modules",
    "better-sqlite3",
    "prebuilds",
    "win32-x64.node",
  ];
  const distNative = join(distBridgeRoot, ...nativeRelativeParts);
  const distSupportRoot = join(
    distBridgeRoot,
    "node_modules",
    "better-sqlite3",
  );
  const canonicalNative = join(
    packagedRoot,
    "resources",
    "bridge",
    ...nativeRelativeParts,
  );
  const packagedSupportRoot = join(
    packagedRoot,
    "resources",
    "bridge",
    "node_modules",
    "better-sqlite3",
  );
  const decoyNative = join(
    packagedRoot,
    "resources",
    "decoy",
    "win32-x64.node",
  );
  const certificateFile = join(root, "release-certificate.pfx");
  const signToolPath = join(root, "signtool.exe");
  const nativeContents = createX64PeFixture();
  await mkdir(dirname(distNative), { recursive: true });
  await mkdir(dirname(canonicalNative), { recursive: true });
  await mkdir(dirname(decoyNative), { recursive: true });
  await writeFile(distNative, nativeContents);
  await writeFile(canonicalNative, nativeContents);
  await writeFile(decoyNative, createX64PeFixture(1));
  await writeFile(
    join(packagedRoot, "resources", "bridge", "IntentArc Bridge.exe"),
    "bridge",
  );
  await writeFile(certificateFile, "certificate");
  await writeFile(signToolPath, "sign tool");
  const supportSha256 = createHash("sha256")
    .update("prebuilds/win32-x64.node")
    .update("\0")
    .update(nativeContents)
    .update("\0")
    .digest("hex");
  const controls = {
    publisherThumbprint: "A".repeat(40),
    embeddedSupportSha256: supportSha256,
    failSigning: false,
    identityChecks: 0,
    signatureValid: true,
    signatureVerificationCalls: [] as string[],
  };
  const delegatedFiles: string[] = [];
  const productExecutions = {
    readBridgeIdentity: vi.fn(async () => {
      if (throwOnProductExecution) {
        throw new Error("Forge must not execute the bridge");
      }
      controls.identityChecks += 1;
      return {
        formatVersion: 1 as const,
        releaseVersion: "0.1.0",
        buildMode: "signed-release" as const,
        supportSha256: controls.embeddedSupportSha256,
      };
    }),
    readBridgePredecessor: vi.fn(async () => {
      throw new Error("Forge must not execute the bridge");
    }),
  };
  const dependencies = {
    sign: async ({ files }: { files: string[] }) => {
      delegatedFiles.push(...files);
      if (controls.failSigning) throw new Error("sensitive signer failure");
    },
    verifyAuthenticodeSignature: async (path: string) => {
      controls.signatureVerificationCalls.push(path);
      if (!controls.signatureValid) {
        throw new Error("invalid fixture signature");
      }
    },
    readAuthenticodePublisher: async () => ({
      thumbprint: controls.publisherThumbprint,
      subject: "CN=IntentArc",
    }),
    ...productExecutions,
  };
  const adapter = createBridgeNativeSigningAdapter({
    packageRoot,
    environment: {
      INTENTARC_WINDOWS_CERTIFICATE: certificateFile,
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "fixture-secret",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      WINDOWS_SIGNTOOL_PATH: signToolPath,
    },
    dependencies,
  });
  return {
    root,
    packageRoot,
    packagedRoot,
    distSupportRoot,
    packagedSupportRoot,
    distNative,
    canonicalNative,
    decoyNative,
    nativeContents,
    controls,
    delegatedFiles,
    productExecutions,
    adapter,
  };
};

const createBridgeNativeVerifierFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `intentarc-native-${label}-`));
  temporaryRoots.push(root);
  const distBridgeRoot = join(root, "dist", "bridge");
  const packagedRoot = join(root, "packaged");
  const extractionParent = join(root, "extractions");
  const fullNupkgPath = join(root, "IntentArc-full.nupkg");
  const distSupportRoot = join(
    distBridgeRoot,
    "node_modules",
    "better-sqlite3",
  );
  const packagedSupportRoot = join(
    packagedRoot,
    "resources",
    "bridge",
    "node_modules",
    "better-sqlite3",
  );
  const nativeParts = ["prebuilds", "win32-x64.node"];
  await mkdir(join(distSupportRoot, "prebuilds"), { recursive: true });
  await mkdir(join(packagedSupportRoot, "prebuilds"), { recursive: true });
  await mkdir(extractionParent);
  await writeFile(join(distSupportRoot, ...nativeParts), "native");
  await writeFile(join(packagedSupportRoot, ...nativeParts), "native");
  await writeFile(fullNupkgPath, canonicalBridgeNativeNupkg);
  const expectedThumbprint = "A".repeat(40);
  const bridgeNative = await import(
    "../../../scripts/bridge-native-release.mjs"
  ) as {
    verifyBridgeNativeArtifacts(input: {
      distBridgeRoot: string;
      packagedRoot: string;
      fullNupkgPath: string;
      extractionParent: string;
      expectedThumbprint: string;
      verifyEmbeddedIdentity?: boolean;
      environment?: Record<string, string | undefined>;
      readBridgeIdentity?(path: string, context?: {
        ownerRoot: string;
        environment: Record<string, string | undefined>;
      }): Promise<{
        formatVersion: 1;
        releaseVersion: string;
        buildMode: "signed-release";
        supportSha256: string;
      }>;
      readPublisher(path: string): Promise<{
        thumbprint: string;
        subject: string;
      }>;
    }): Promise<{ supportSha256: string }>;
  };
  return {
    verify: bridgeNative.verifyBridgeNativeArtifacts,
    input: {
      distBridgeRoot,
      packagedRoot,
      fullNupkgPath,
      extractionParent,
      expectedThumbprint,
      readPublisher: async () => ({
        thumbprint: expectedThumbprint,
        subject: "CN=IntentArc",
      }),
    },
    distSupportRoot,
    packagedSupportRoot,
    packagedRoot,
    supportSha256: createHash("sha256")
      .update("prebuilds/win32-x64.node")
      .update("\0")
      .update("native")
      .update("\0")
      .digest("hex"),
  };
};

const createPackagedHookFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `intentarc-hook-${label}-`));
  temporaryRoots.push(root);
  const binaryRoot = join(root, "IntentArc");
  const applicationDirectory = join(binaryRoot, "app-0.0.9");
  const resourcesPath = join(applicationDirectory, "resources");
  const bridgePayload = join(resourcesPath, "bridge");
  const nativeDirectory = join(
    bridgePayload,
    "node_modules",
    "better-sqlite3",
    "prebuilds",
  );
  await mkdir(nativeDirectory, { recursive: true });
  await mkdir(join(resourcesPath, "desktop-resources"), { recursive: true });
  await writeFile(join(applicationDirectory, "IntentArc.exe"), "desktop");
  await writeFile(join(bridgePayload, "IntentArc Bridge.exe"), "bridge");
  await writeFile(join(nativeDirectory, "win32-x64.node"), "native");
  await writeFile(
    join(resourcesPath, "desktop-resources", "intentarc-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      requireSignatures: false,
    }),
  );
  const supportSha256 = createHash("sha256")
    .update("prebuilds/win32-x64.node")
    .update("\0")
    .update("native")
    .update("\0")
    .digest("hex");
  return {
    root,
    binaryRoot,
    execPath: join(applicationDirectory, "IntentArc.exe"),
    resourcesPath,
    receiptPath: join(binaryRoot, squirrelLifecycleReceiptName),
    inspectBridgeIdentity: async () => ({
      formatVersion: 1 as const,
      releaseVersion: "0.0.9",
      buildMode: "unsigned-development" as const,
      supportSha256,
    }),
  };
};

const withSelectorEnvironment = async <T>(
  environment: Readonly<Record<string, string>>,
  action: () => Promise<T>,
): Promise<T> => {
  const original = Object.entries(process.env).filter(([key]) =>
    selectorEnvironmentKeys.has(key.toLowerCase())
  );
  const removeSelectors = (): void => {
    for (const key of Object.keys(process.env)) {
      if (selectorEnvironmentKeys.has(key.toLowerCase())) {
        delete process.env[key];
      }
    }
  };
  removeSelectors();
  Object.assign(process.env, environment);
  try {
    return await action();
  } finally {
    removeSelectors();
    for (const [key, value] of original) process.env[key] = value;
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Squirrel Windows lifecycle contract", () => {
  it("verifies byte, publisher, canonical nupkg entry, and support-digest continuity for the bridge native artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-native-artifacts-"));
    temporaryRoots.push(root);
    const distBridgeRoot = join(root, "dist", "bridge");
    const packagedRoot = join(root, "packaged");
    const extractionParent = join(root, "extractions");
    const fullNupkgPath = join(root, "IntentArc-full.nupkg");
    const missingNupkgPath = join(root, "IntentArc-missing-full.nupkg");
    const distNativePath = join(
      distBridgeRoot,
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      "win32-x64.node",
    );
    const packagedNativePath = join(
      packagedRoot,
      "resources",
      "bridge",
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      "win32-x64.node",
    );
    await mkdir(dirname(distNativePath), { recursive: true });
    await mkdir(dirname(packagedNativePath), { recursive: true });
    await mkdir(extractionParent);
    await writeFile(distNativePath, "native");
    await writeFile(packagedNativePath, "native");
    await writeFile(fullNupkgPath, canonicalBridgeNativeNupkg);
    await writeFile(missingNupkgPath, missingBridgeNativeNupkg);
    const supportSha256 = createHash("sha256")
      .update("prebuilds/win32-x64.node")
      .update("\0")
      .update("native")
      .update("\0")
      .digest("hex");
    const expectedThumbprint = "A".repeat(40);
    const bridgeNative = await import(
      "../../../scripts/bridge-native-release.mjs"
    ) as {
      verifyBridgeNativeArtifacts(input: {
        distBridgeRoot: string;
        packagedRoot: string;
        fullNupkgPath: string;
        extractionParent: string;
        expectedThumbprint: string;
        verifyEmbeddedIdentity?: boolean;
        environment?: Record<string, string | undefined>;
        readBridgeIdentity(path: string, context?: {
          ownerRoot: string;
          environment: Record<string, string | undefined>;
        }): Promise<{
          formatVersion: 1;
          releaseVersion: string;
          buildMode: "signed-release";
          supportSha256: string;
        }>;
        readPublisher(path: string): Promise<{
          thumbprint: string;
          subject: string;
        }>;
      }): Promise<{
        nativeSha256: string;
        supportSha256: string;
        publisherThumbprint: string;
        distNativePath: string;
        packagedNativePath: string;
        nupkgEntry: string;
      }>;
    };
    const environment = {
      INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT: join(root, "audit"),
      INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH: join(
        root,
        "audit",
        "bridge-diagnostics.tokens",
      ),
    };
    const identity = vi.fn(async () => ({
      formatVersion: 1 as const,
      releaseVersion: "0.1.0",
      buildMode: "signed-release" as const,
      supportSha256,
    }));
    const publisher = async () => ({
      thumbprint: expectedThumbprint,
      subject: "CN=IntentArc",
    });
    const input = {
      distBridgeRoot,
      packagedRoot,
      fullNupkgPath,
      extractionParent,
      expectedThumbprint,
      environment,
      readBridgeIdentity: identity,
      readPublisher: publisher,
    };

    await expect(bridgeNative.verifyBridgeNativeArtifacts(input)).resolves
      .toEqual({
        nativeSha256: createHash("sha256").update("native").digest("hex"),
        supportSha256,
        publisherThumbprint: expectedThumbprint,
        distNativePath,
        packagedNativePath,
        nupkgEntry:
          "lib/net45/resources/bridge/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      });
    expect(identity).toHaveBeenCalledWith(
      join(packagedRoot, "resources", "bridge", "IntentArc Bridge.exe"),
      { ownerRoot: packagedRoot, environment },
    );

    const disabledIdentity = vi.fn(async () => {
      throw new Error("disabled identity verification must not execute");
    });
    await expect(bridgeNative.verifyBridgeNativeArtifacts({
      ...input,
      verifyEmbeddedIdentity: false,
      readBridgeIdentity: disabledIdentity,
    })).resolves.toMatchObject({ supportSha256 });
    expect(disabledIdentity).not.toHaveBeenCalled();

    await writeFile(packagedNativePath, "drifted native");
    await expect(bridgeNative.verifyBridgeNativeArtifacts(input))
      .rejects.toThrow("IntentArc bridge native artifacts do not match.");
    await writeFile(packagedNativePath, "native");

    await expect(bridgeNative.verifyBridgeNativeArtifacts({
      ...input,
      readPublisher: async (path) => ({
        thumbprint: path === distNativePath ? "B".repeat(40) : expectedThumbprint,
        subject: "CN=IntentArc",
      }),
    })).rejects.toThrow(
      "IntentArc bridge native publisher does not match the configured release publisher.",
    );

    await expect(bridgeNative.verifyBridgeNativeArtifacts({
      ...input,
      readPublisher: async () => ({
        thumbprint: null,
        subject: "CN=IntentArc",
      }),
    })).rejects.toThrow(
      "IntentArc bridge native publisher verification failed.",
    );

    await expect(bridgeNative.verifyBridgeNativeArtifacts({
      ...input,
      fullNupkgPath: missingNupkgPath,
    })).rejects.toThrow(
      "IntentArc full nupkg is missing the canonical bridge native entry.",
    );

    await expect(bridgeNative.verifyBridgeNativeArtifacts({
      ...input,
      readBridgeIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: "b".repeat(64),
      }),
    })).rejects.toThrow(
      "IntentArc packaged bridge support digest does not match its embedded identity.",
    );
  });

  it.each(["dist", "packaged"] as const)(
    "native verifier rejects %s support drift without executing embedded identity",
    async (side) => {
      const fixture = await createBridgeNativeVerifierFixture(
        `${side}-support-drift`,
      );
      const supportRoot = side === "dist"
        ? fixture.distSupportRoot
        : fixture.packagedSupportRoot;
      await writeFile(join(supportRoot, "support-drift.txt"), "support drift");
      const readBridgeIdentity = vi.fn(async () => {
        throw new Error("disabled identity verification must not execute");
      });

      await expect(fixture.verify({
        ...fixture.input,
        verifyEmbeddedIdentity: false,
        readBridgeIdentity,
      })).rejects.toThrow(
        /^IntentArc bridge support artifacts do not match\.$/,
      );
      expect(readBridgeIdentity).not.toHaveBeenCalled();
    },
  );

  it("native verifier defaults enabled identity verification to process.env", async () => {
    const fixture = await createBridgeNativeVerifierFixture(
      "default-environment",
    );
    const readBridgeIdentity = vi.fn(async (
      _path: string,
      _context?: {
        ownerRoot: string;
        environment: Record<string, string | undefined>;
      },
    ) => ({
      formatVersion: 1 as const,
      releaseVersion: "0.1.0",
      buildMode: "signed-release" as const,
      supportSha256: fixture.supportSha256,
    }));

    await expect(fixture.verify({
      ...fixture.input,
      readBridgeIdentity,
    })).resolves.toMatchObject({ supportSha256: fixture.supportSha256 });
    expect(readBridgeIdentity).toHaveBeenCalledTimes(1);
    const context = readBridgeIdentity.mock.calls[0]?.[1];
    expect(context?.ownerRoot).toBe(fixture.packagedRoot);
    expect(context?.environment).toBe(process.env);
  });

  it("preserves only the verified canonical bridge native while delegating decoy native files", async () => {
    const fixture = await createForgeSigningAdapterFixture("routing");

    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    expect(fixture.delegatedFiles).not.toContain(fixture.canonicalNative);
    expect(fixture.controls.signatureVerificationCalls).toEqual([
      fixture.canonicalNative,
    ]);

    await fixture.adapter.windowsSign.hookFunction(fixture.decoyNative);
    expect(fixture.delegatedFiles).toContain(fixture.decoyNative);

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    })).resolves.toBeUndefined();
    expect(fixture.controls.signatureVerificationCalls).toEqual([
      fixture.canonicalNative,
      fixture.canonicalNative,
    ]);
  });

  it("performs every Forge phase without executing bridge metadata readers", async () => {
    const fixture = await createForgeSigningAdapterFixture(
      "zero-product-execution",
      { throwOnProductExecution: true },
    );
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    await fixture.adapter.windowsSign.hookFunction(fixture.decoyNative);
    await fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    });
    const fullNupkg = join(fixture.root, "IntentArc-full.nupkg");
    await writeFile(fullNupkg, createStoredZipEntry(
      "lib/net45/resources/bridge/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      fixture.nativeContents,
    ));
    const makeResults = [{
      artifacts: [fullNupkg],
      packageJSON: {},
      platform: "win32" as const,
      arch: "x64" as const,
    }];

    await expect(fixture.adapter.postMake({} as never, makeResults))
      .resolves.toBe(makeResults);
    expect(fixture.productExecutions.readBridgeIdentity)
      .not.toHaveBeenCalled();
    expect(fixture.productExecutions.readBridgePredecessor)
      .not.toHaveBeenCalled();
  });

  it("requires a Valid signature before preserving the canonical native", async () => {
    const fixture = await createForgeSigningAdapterFixture("invalid-signature");
    fixture.controls.signatureValid = false;

    await expect(fixture.adapter.windowsSign.hookFunction(
      fixture.canonicalNative,
    )).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
    expect(fixture.controls.signatureVerificationCalls).toEqual([
      fixture.canonicalNative,
    ]);
  });

  it("rechecks signature validity in postPackage after hook acceptance", async () => {
    const fixture = await createForgeSigningAdapterFixture(
      "post-package-invalid-signature",
    );
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    fixture.controls.signatureValid = false;

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    })).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
    expect(fixture.controls.signatureVerificationCalls).toEqual([
      fixture.canonicalNative,
      fixture.canonicalNative,
    ]);
  });

  it("delegates app package signing through the bounded Windows signer by default", () => {
    expect(defaultBridgeNativeSigningAdapterDependencies.sign)
      .toBe(runBoundedWindowsSign);
  });

  it("rejects a preserved native whose derived root is absent from Forge output paths", async () => {
    const fixture = await createForgeSigningAdapterFixture("wrong-root");
    const unrelatedOutput = join(fixture.root, "unrelated-output");
    await mkdir(unrelatedOutput);
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [unrelatedOutput],
    })).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
    expect(fixture.controls.identityChecks).toBe(0);
  });

  it("rejects a byte mismatch at the initial preservation hook", async () => {
    const fixture = await createForgeSigningAdapterFixture(
      "initial-byte-mismatch",
    );
    await writeFile(fixture.canonicalNative, createX64PeFixture(4));

    await expect(fixture.adapter.windowsSign.hookFunction(
      fixture.canonicalNative,
    )).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
    expect(fixture.controls.signatureVerificationCalls).toEqual([]);
  });

  it("rejects a publisher mismatch at the initial preservation hook", async () => {
    const fixture = await createForgeSigningAdapterFixture(
      "initial-publisher-mismatch",
    );
    fixture.controls.publisherThumbprint = "B".repeat(40);

    await expect(fixture.adapter.windowsSign.hookFunction(
      fixture.canonicalNative,
    )).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
    expect(fixture.controls.signatureVerificationCalls).toEqual([
      fixture.canonicalNative,
    ]);
  });

  it("rechecks native bytes in postPackage after hook acceptance", async () => {
    const fixture = await createForgeSigningAdapterFixture("byte-drift");
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    const driftedNative = createX64PeFixture(2);
    await writeFile(fixture.canonicalNative, driftedNative);
    fixture.controls.embeddedSupportSha256 = createHash("sha256")
      .update("prebuilds/win32-x64.node")
      .update("\0")
      .update(driftedNative)
      .update("\0")
      .digest("hex");

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    })).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
  });

  it("rechecks the native publisher in postPackage after hook acceptance", async () => {
    const fixture = await createForgeSigningAdapterFixture("publisher-drift");
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    fixture.controls.publisherThumbprint = "B".repeat(40);

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    })).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
  });

  it.each(["dist", "packaged"] as const)(
    "rejects %s better-sqlite3 support drift in postPackage",
    async (side) => {
      const fixture = await createForgeSigningAdapterFixture(
        `${side}-support-drift`,
      );
      await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
      const driftContents = "support drift";
      const supportRoot = side === "dist"
        ? fixture.distSupportRoot
        : fixture.packagedSupportRoot;
      await writeFile(join(supportRoot, "support-drift.txt"), driftContents);
      if (side === "packaged") {
        fixture.controls.embeddedSupportSha256 = createHash("sha256")
          .update("prebuilds/win32-x64.node")
          .update("\0")
          .update(fixture.nativeContents)
          .update("\0")
          .update("support-drift.txt")
          .update("\0")
          .update(driftContents)
          .update("\0")
          .digest("hex");
      }

      await expect(fixture.adapter.postPackage({} as never, {
        platform: "win32",
        arch: "x64",
        outputPaths: [fixture.packagedRoot],
      })).rejects.toThrow(
        /^IntentArc Windows package signing did not complete safely\.$/,
      );
    },
  );

  it("surfaces a delegated signing failure even when the packager swallows the hook rejection", async () => {
    const fixture = await createForgeSigningAdapterFixture("swallowed");
    fixture.controls.failSigning = true;
    await fixture.adapter.windowsSign.hookFunction(fixture.decoyNative)
      .catch(() => undefined);

    await expect(fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    })).rejects.toThrow(
      /^IntentArc Windows package signing did not complete safely\.$/,
    );
  });

  it.each([
    { label: "no", artifacts: [] },
    {
      label: "multiple",
      artifacts: ["IntentArc-full.nupkg", "IntentArc-copy-full.nupkg"],
    },
  ])("requires exactly one full nupkg when postMake receives $label candidates", async ({
    artifacts,
  }) => {
    const fixture = await createForgeSigningAdapterFixture(
      `nupkg-count-${artifacts.length}`,
    );
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    await fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    });
    const makeResults = [{
      artifacts: artifacts.map((artifact) => join(fixture.root, artifact)),
      packageJSON: {},
      platform: "win32" as const,
      arch: "x64" as const,
    }];

    await expect(fixture.adapter.postMake({} as never, makeResults))
      .rejects.toThrow(
        /^IntentArc Windows release requires exactly one full nupkg\.$/,
      );
  });

  it("returns unchanged make results after proving full-nupkg native preservation", async () => {
    const fixture = await createForgeSigningAdapterFixture("nupkg-success");
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    await fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    });
    const fullNupkg = join(fixture.root, "IntentArc-full.nupkg");
    await writeFile(fullNupkg, createStoredZipEntry(
      "lib/net45/resources/bridge/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      fixture.nativeContents,
    ));
    const makeResults = [{
      artifacts: [fullNupkg],
      packageJSON: {},
      platform: "win32" as const,
      arch: "x64" as const,
    }];

    await expect(fixture.adapter.postMake({} as never, makeResults))
      .resolves.toBe(makeResults);
    expect((await readdir(fixture.packageRoot)).filter((name) =>
      name.startsWith(".intentarc-forge-native-")
    )).toEqual([]);
  });

  it("rejects nupkg native drift and removes its extraction root", async () => {
    const fixture = await createForgeSigningAdapterFixture("nupkg-drift");
    await fixture.adapter.windowsSign.hookFunction(fixture.canonicalNative);
    await fixture.adapter.postPackage({} as never, {
      platform: "win32",
      arch: "x64",
      outputPaths: [fixture.packagedRoot],
    });
    const fullNupkg = join(fixture.root, "IntentArc-full.nupkg");
    await writeFile(fullNupkg, createStoredZipEntry(
      "lib/net45/resources/bridge/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      createX64PeFixture(3),
    ));
    const makeResults = [{
      artifacts: [fullNupkg],
      packageJSON: {},
      platform: "win32" as const,
      arch: "x64" as const,
    }];

    await expect(fixture.adapter.postMake({} as never, makeResults))
      .rejects.toThrow(/^IntentArc bridge native artifacts do not match\.$/);
    expect((await readdir(fixture.packageRoot)).filter((name) =>
      name.startsWith(".intentarc-forge-native-")
    )).toEqual([]);
  });

  it.each(["--squirrel-install", "--squirrel-updated"])(
    "installs and verifies the stable bridge before creating a shortcut for %s without opening UI",
    async (argument) => {
      const calls: string[] = [];
      const installBridge: SquirrelBridgeInstaller = vi.fn(async (input) => {
        calls.push(`bridge:${input.version}`);
        expect(input.binaryRoot).toBe("C:\\Users\\Ada\\AppData\\Local\\IntentArc");
        expect(input.payloadPath).toBe(
          "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\resources\\bridge",
        );
      });
      const runUpdate = vi.fn(async (args: readonly string[]) => {
        calls.push(`update:${args.join(" ")}`);
      });
      const quit = vi.fn(() => {
        calls.push("quit");
      });

      await expect(handleSquirrelEvent({
        argv: [argument],
        platform: "win32",
        execPath:
          "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\IntentArc.exe",
        resourcesPath:
          "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\resources",
        version: "0.2.0",
        installBridge,
        loadSignatureRequirement: async () => false,
        runUpdate,
        quit,
      })).resolves.toBe(true);

      expect(calls).toEqual([
        "bridge:0.2.0",
        "update:--createShortcut=IntentArc.exe",
        "quit",
      ]);
    },
  );

  it("requires MCP initialize and tool compatibility for both staged and active bridge phases", async () => {
    const root = await mkdtemp(join(
      tmpdir(),
      "intentarc-installer-protocol-",
    ));
    temporaryRoots.push(root);
    const staged = join(root, "staged");
    const active = join(root, "active");
    for (const directory of [staged, active]) {
      await mkdir(join(
        directory,
        "node_modules",
        "better-sqlite3",
        "prebuilds",
      ), { recursive: true });
      await writeFile(join(directory, "IntentArc Bridge.exe"), "bridge");
      await writeFile(join(
        directory,
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        "win32-x64.node",
      ), "native");
    }
    const protocolPhases: string[] = [];

    await handleSquirrelEvent({
      argv: ["--squirrel-updated"],
      platform: "win32",
      execPath:
        "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\IntentArc.exe",
      resourcesPath:
        "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\resources",
      version: "0.2.0",
      loadSignatureRequirement: async () => false,
      inspectBridgeIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.2.0",
        buildMode: "unsigned-development",
        supportSha256: "a".repeat(64),
      }),
      verifyBridgeProtocol: async ({ phase, executablePath }) => {
        protocolPhases.push(`${phase}:${executablePath}`);
      },
      installBridge: async (input) => {
        await input.verify({
          phase: "staged",
          executablePath: join(staged, "IntentArc Bridge.exe"),
          versionDirectory: staged,
          binaryRoot: root,
        });
        await input.verify({
          phase: "active",
          executablePath: join(active, "IntentArc Bridge.exe"),
          versionDirectory: active,
          binaryRoot: root,
        });
      },
      runUpdate: async () => undefined,
      quit: () => undefined,
    });

    expect(protocolPhases).toEqual([
      `staged:${join(staged, "IntentArc Bridge.exe")}`,
      `active:${join(active, "IntentArc Bridge.exe")}`,
    ]);
  });

  it("removes only the application shortcut on uninstall and preserves archive and backup roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-uninstall-contract-"));
    temporaryRoots.push(root);
    const archive = join(root, "archive.sqlite");
    const backup = `${archive}.backups`;
    await writeFile(archive, "archive");
    await writeFile(backup, "backup-root-sentinel");
    const installBridge = vi.fn();
    const runUpdate = vi.fn(async () => undefined);
    const quit = vi.fn();

    await expect(handleSquirrelEvent({
      argv: ["--squirrel-uninstall"],
      platform: "win32",
      execPath:
        "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\IntentArc.exe",
      resourcesPath:
        "C:\\Users\\Ada\\AppData\\Local\\IntentArc\\app-0.2.0\\resources",
      version: "0.2.0",
      installBridge,
      runUpdate,
      quit,
    })).resolves.toBe(true);

    expect(runUpdate).toHaveBeenCalledWith([
      "--removeShortcut=IntentArc.exe",
    ]);
    expect(installBridge).not.toHaveBeenCalled();
    expect(await readFile(archive, "utf8")).toBe("archive");
    expect(await readFile(backup, "utf8")).toBe("backup-root-sentinel");
    expect(quit).toHaveBeenCalledOnce();
  });
});

const createPnpmFallbackFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-pnpm-fallback-"));
  temporaryRoots.push(root);
  const shim = join(root, "bin", "pnpm");
  const target = join(
    root,
    "global",
    "v11",
    "fixture-installation",
    "node_modules",
    "@pnpm",
    "exe",
    "pnpm.exe",
  );
  await mkdir(dirname(shim), { recursive: true });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "pnpm", "utf8");
  await writeFile(
    shim,
    `#!/bin/sh\n# cmd-shim-target=${target.replaceAll("\\", "/")}\n`,
    "utf8",
  );
  return { root, shim, target };
};

type PnpmFallbackFileSystem = {
  lstat: (path: string) => Promise<Stats>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  readlink: (path: string) => Promise<string>;
  realpath: (path: string) => Promise<string>;
};

const resolvePnpm11Fallback = async (
  pnpmHome: string,
  fileSystem: PnpmFallbackFileSystem = { lstat, readFile, readlink, realpath },
) => {
  const unavailable = () => {
    throw new Error("The package-manager build command is unavailable.");
  };
  try {
    const configuredRoot = pnpmHome.trim();
    if (!configuredRoot || !isAbsolute(configuredRoot)) unavailable();
    const configuredRootInfo = await fileSystem.lstat(configuredRoot);
    if (!configuredRootInfo.isDirectory() || configuredRootInfo.isSymbolicLink()) {
      unavailable();
    }
    const root = await fileSystem.realpath(configuredRoot);
    const rootInfo = await fileSystem.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) unavailable();

    const bin = resolve(root, "bin");
    const binInfo = await fileSystem.lstat(bin);
    if (!binInfo.isDirectory() || binInfo.isSymbolicLink()) unavailable();
    const canonicalBin = await fileSystem.realpath(bin);
    if (relative(root, canonicalBin).split(sep).join("/").toLowerCase() !== "bin") {
      unavailable();
    }
    const expectedShim = resolve(canonicalBin, "pnpm");
    const shimInfo = await fileSystem.lstat(expectedShim);
    if (!shimInfo.isFile() || shimInfo.isSymbolicLink()) unavailable();
    const shim = await fileSystem.realpath(expectedShim);
    if (relative(root, shim).split(sep).join("/").toLowerCase() !== "bin/pnpm") {
      unavailable();
    }
    const matches = [...(await fileSystem.readFile(shim, "utf8"))
      .matchAll(/^# cmd-shim-target=([^\r\n]+)$/gmu)];
    if (matches.length !== 1) unavailable();
    const declaredTarget = matches[0]?.[1]?.trim();
    if (!declaredTarget || !isAbsolute(declaredTarget)) unavailable();
    const lexicalTarget = resolve(declaredTarget);
    const declaredRelative = relative(root, lexicalTarget);
    if (!declaredRelative || declaredRelative === ".." ||
        declaredRelative.startsWith(`..${sep}`) ||
        isAbsolute(declaredRelative)) {
      unavailable();
    }
    const declaredParts = declaredRelative.split(sep);
    if (declaredParts.length !== 7 ||
        declaredParts[0]?.toLowerCase() !== "global" ||
        !/^v\d+$/u.test(declaredParts[1] ?? "") ||
        !/^[a-z0-9][a-z0-9_-]*$/iu.test(declaredParts[2] ?? "") ||
        declaredParts[3]?.toLowerCase() !== "node_modules" ||
        declaredParts[4]?.toLowerCase() !== "@pnpm" ||
        declaredParts[5]?.toLowerCase() !== "exe" ||
        declaredParts[6]?.toLowerCase() !== "pnpm.exe") {
      unavailable();
    }
    let target = lexicalTarget;
    for (let index = 1; index < declaredParts.length; index += 1) {
      const lexicalPrefix = resolve(root, ...declaredParts.slice(0, index));
      const prefixInfo = await fileSystem.lstat(lexicalPrefix);
      if (prefixInfo.isSymbolicLink()) {
        if (index !== declaredParts.length - 1) unavailable();
        const linkTarget = await fileSystem.readlink(lexicalPrefix);
        if (!isAbsolute(linkTarget)) unavailable();
        const linkRelative = relative(root, resolve(linkTarget));
        if (!linkRelative || linkRelative === ".." ||
            linkRelative.startsWith(`..${sep}`) || isAbsolute(linkRelative)) {
          unavailable();
        }
        const linkParts = linkRelative.split(sep);
        const canonicalStorePrefix = linkParts.length === 10 &&
          linkParts[0]?.toLowerCase() === "store" &&
          /^v\d+$/u.test(linkParts[1] ?? "") &&
          linkParts[2]?.toLowerCase() === "links" &&
          linkParts[3]?.toLowerCase() === "@pnpm" &&
          linkParts[4]?.toLowerCase() === "exe" &&
          /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(linkParts[5] ?? "") &&
          /^[a-f0-9]{32,128}$/iu.test(linkParts[6] ?? "") &&
          linkParts[7]?.toLowerCase() === "node_modules" &&
          linkParts[8]?.toLowerCase() === "@pnpm" &&
          linkParts[9]?.toLowerCase() === "exe";
        if (!canonicalStorePrefix) unavailable();
        for (let linkIndex = 1; linkIndex <= linkParts.length; linkIndex += 1) {
          const directPrefix = resolve(root, ...linkParts.slice(0, linkIndex));
          const directInfo = await fileSystem.lstat(directPrefix);
          if (!directInfo.isDirectory() || directInfo.isSymbolicLink()) unavailable();
          const directCanonical = await fileSystem.realpath(directPrefix);
          const directRelative = relative(root, directCanonical);
          if (!directRelative || directRelative === ".." ||
              directRelative.startsWith(`..${sep}`) || isAbsolute(directRelative)) {
            unavailable();
          }
        }
        target = resolve(linkTarget, ...declaredParts.slice(index));
        break;
      }
      if (!prefixInfo.isDirectory()) unavailable();
      const canonicalPrefix = await fileSystem.realpath(lexicalPrefix);
      const canonicalRelative = relative(root, canonicalPrefix);
      if (!canonicalRelative || canonicalRelative === ".." ||
          canonicalRelative.startsWith(`..${sep}`) ||
          isAbsolute(canonicalRelative)) {
        unavailable();
      }
    }
    const targetLexicalRelative = relative(root, target);
    if (!targetLexicalRelative || targetLexicalRelative === ".." ||
        targetLexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(targetLexicalRelative)) {
      unavailable();
    }
    const targetDeclarationInfo = await fileSystem.lstat(target);
    if (!targetDeclarationInfo.isFile() ||
        targetDeclarationInfo.isSymbolicLink()) unavailable();
    const resolvedTarget = await fileSystem.realpath(target);
    const targetRelative = relative(root, resolvedTarget);
    if (!targetRelative || targetRelative === ".." ||
        targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      unavailable();
    }
    const parts = targetRelative.split(sep);
    const canonicalGlobalShape = parts.length === 7 &&
      parts[0]?.toLowerCase() === "global" &&
      /^v\d+$/u.test(parts[1] ?? "") &&
      /^[a-z0-9][a-z0-9_-]*$/iu.test(parts[2] ?? "") &&
      parts[3]?.toLowerCase() === "node_modules" &&
      parts[4]?.toLowerCase() === "@pnpm" &&
      parts[5]?.toLowerCase() === "exe" &&
      parts[6]?.toLowerCase() === "pnpm.exe";
    const canonicalStoreShape = parts.length === 11 &&
      parts[0]?.toLowerCase() === "store" &&
      /^v\d+$/u.test(parts[1] ?? "") &&
      parts[2]?.toLowerCase() === "links" &&
      parts[3]?.toLowerCase() === "@pnpm" &&
      parts[4]?.toLowerCase() === "exe" &&
      /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(parts[5] ?? "") &&
      /^[a-f0-9]{32,128}$/iu.test(parts[6] ?? "") &&
      parts[7]?.toLowerCase() === "node_modules" &&
      parts[8]?.toLowerCase() === "@pnpm" &&
      parts[9]?.toLowerCase() === "exe" &&
      parts[10]?.toLowerCase() === "pnpm.exe";
    if (!canonicalGlobalShape && !canonicalStoreShape) {
      unavailable();
    }
    const targetInfo = await fileSystem.lstat(resolvedTarget);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) unavailable();
    return resolvedTarget;
  } catch {
    unavailable();
  }
};

describe("Windows package and signing contract", () => {
  it("resolves the pnpm 11 fallback only through its canonical installation shim", async () => {
    // Break caught: ambient PATH discovery or an unchecked shim target can
    // substitute a different package manager for the repository build fixture.
    const fixture = await createPnpmFallbackFixture();

    await expect(resolvePnpm11Fallback(fixture.root)).resolves.toBe(
      await realpath(fixture.target),
    );
  });

  it.each([
    ["malformed metadata", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      await writeFile(fixture.shim, "#!/bin/sh\n", "utf8");
    }],
    ["an outside target", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "intentarc-pnpm-outside-"));
      temporaryRoots.push(outsideRoot);
      const outside = join(outsideRoot, "pnpm.exe");
      await writeFile(outside, "outside", "utf8");
      await writeFile(fixture.shim, `# cmd-shim-target=${outside.replaceAll("\\", "/")}\n`, "utf8");
    }],
    ["an alternate in-tree target shape", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      const alternate = join(fixture.root, "bin", "pnpm.exe");
      await writeFile(alternate, "alternate", "utf8");
      await writeFile(fixture.shim, `# cmd-shim-target=${alternate.replaceAll("\\", "/")}\n`, "utf8");
    }],
    ["a wrong executable leaf", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      const wrongLeaf = join(dirname(fixture.target), "npm.exe");
      await writeFile(wrongLeaf, "alternate", "utf8");
      await writeFile(fixture.shim, `# cmd-shim-target=${wrongLeaf.replaceAll("\\", "/")}\n`, "utf8");
    }],
    ["a reparse shim", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      const replacement = join(fixture.root, "shim-reparse-target");
      await rm(fixture.shim);
      await mkdir(replacement);
      await symlink(replacement, fixture.shim, "junction");
    }],
    ["a reparse declared target", async (fixture: Awaited<ReturnType<typeof createPnpmFallbackFixture>>) => {
      const replacement = join(fixture.root, "target-reparse-source");
      await rm(fixture.target);
      await mkdir(replacement);
      await symlink(replacement, fixture.target, "junction");
    }],
  ])("rejects pnpm fallback %s", async (_name, mutate) => {
    const fixture = await createPnpmFallbackFixture();
    await mutate(fixture);

    await expect(resolvePnpm11Fallback(fixture.root)).rejects.toThrow(
      "The package-manager build command is unavailable.",
    );
  });

  it.each([
    ".intentarc.sqlite.backups",
    ".playwright-cli",
    "output",
  ])("rejects an escaped %s target before observing it", async (protectedLeaf) => {
    // Break caught: lexical escapes must be refused before any filesystem call
    // can disclose or otherwise interact with the declared outside target.
    const fixture = await createPnpmFallbackFixture();
    const escapedTarget = resolve(fixture.root, "..", protectedLeaf);
    await writeFile(
      fixture.shim,
      `# cmd-shim-target=${escapedTarget.replaceAll("\\", "/")}\n`,
      "utf8",
    );
    const observations: string[] = [];
    const observeTarget = (operation: string, path: string) => {
      if (resolve(path) === escapedTarget) {
        observations.push(operation);
        throw new Error("protected-target-observed");
      }
    };

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        observeTarget("lstat", path);
        return lstat(path);
      },
      readFile: async (path, encoding) => {
        observeTarget("read", path);
        return readFile(path, encoding);
      },
      readlink,
      realpath: async (path) => {
        observeTarget("realpath", path);
        return realpath(path);
      },
    })).rejects.toThrow("The package-manager build command is unavailable.");
    expect(observations).toEqual([]);
  });

  it.each([
    ".intentarc.sqlite.backups",
    ".playwright-cli",
    "output",
  ])("rejects a shim-bin reparse toward %s before touching the shim", async (protectedLeaf) => {
    // Break caught: resolving the fixed shim leaf before validating its bin
    // parent can traverse a junction outside the closed pnpm installation.
    const fixture = await createPnpmFallbackFixture();
    const bin = resolve(fixture.root, "bin");
    const protectedTarget = resolve(fixture.root, "..", protectedLeaf);
    const observations: string[] = [];
    const observeForbidden = (operation: string, path: string) => {
      if (resolve(path) === resolve(fixture.shim) ||
          resolve(path) === protectedTarget ||
          (resolve(path) === bin && operation !== "lstat")) {
        observations.push(operation);
        throw new Error("shim-target-observed");
      }
    };

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        observeForbidden("lstat", path);
        if (resolve(path) === bin) {
          return {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
          } as Stats;
        }
        return lstat(path);
      },
      readFile: async (path, encoding) => {
        observeForbidden("read", path);
        return readFile(path, encoding);
      },
      readlink: async (path) => {
        observeForbidden("readlink", path);
        if (resolve(path) === bin) return protectedTarget;
        return readlink(path);
      },
      realpath: async (path) => {
        observeForbidden("realpath", path);
        if (resolve(path) === bin) return protectedTarget;
        return realpath(path);
      },
    })).rejects.toThrow("The package-manager build command is unavailable.");
    expect(observations).toEqual([]);
  });

  it.each([
    ".intentarc.sqlite.backups",
    ".playwright-cli",
    "output",
  ])("rejects an intermediate reparse toward %s before observing its target", async (protectedLeaf) => {
    // Break caught: validating only the final declared node crosses an
    // intermediate junction before its destination has been contained.
    const fixture = await createPnpmFallbackFixture();
    const intermediate = dirname(fixture.target);
    const protectedTarget = resolve(fixture.root, "..", protectedLeaf);
    const observations: string[] = [];
    const observeProtected = (operation: string, path: string) => {
      if (resolve(path) === protectedTarget || resolve(path) === resolve(fixture.target)) {
        observations.push(operation);
        throw new Error("target-observed");
      }
    };

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        observeProtected("lstat", path);
        if (resolve(path) === intermediate) {
          return {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
          } as Stats;
        }
        return lstat(path);
      },
      readFile: async (path, encoding) => {
        observeProtected("read", path);
        return readFile(path, encoding);
      },
      readlink: async (path) => {
        if (resolve(path) === intermediate) return protectedTarget;
        return readlink(path);
      },
      realpath: async (path) => {
        observeProtected("realpath", path);
        if (resolve(path) === intermediate) return protectedTarget;
        return realpath(path);
      },
    })).rejects.toThrow("The package-manager build command is unavailable.");
    expect(observations).toEqual([]);
  });

  it.each([
    ".intentarc.sqlite.backups",
    ".playwright-cli",
    "output",
  ])("rejects a resolved %s target before observing it", async (protectedLeaf) => {
    // Break caught: the canonical target must be contained and shaped before
    // a stat/read/open is allowed against that resolved destination.
    const fixture = await createPnpmFallbackFixture();
    const protectedTarget = resolve(fixture.root, "..", protectedLeaf);
    const observations: string[] = [];
    const observeProtected = (operation: string, path: string) => {
      if (resolve(path) === protectedTarget) {
        observations.push(operation);
        throw new Error("target-observed");
      }
    };

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        observeProtected("lstat", path);
        return lstat(path);
      },
      readFile: async (path, encoding) => {
        observeProtected("read", path);
        return readFile(path, encoding);
      },
      readlink,
      realpath: async (path) => {
        observeProtected("realpath", path);
        if (resolve(path) === resolve(fixture.target)) return protectedTarget;
        return realpath(path);
      },
    })).rejects.toThrow("The package-manager build command is unavailable.");
    expect(observations).toEqual([]);
  });

  it("rejects a final reparse before canonical resolution", async () => {
    const fixture = await createPnpmFallbackFixture();

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        if (resolve(path) === resolve(fixture.target)) {
          return {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => true,
          } as Stats;
        }
        return lstat(path);
      },
      readFile,
      readlink,
      realpath,
    })).rejects.toThrow("The package-manager build command is unavailable.");
  });

  it.each([
    ".intentarc.sqlite.backups",
    ".playwright-cli",
    "output",
  ])("rejects a final reparse toward %s before resolving it", async (protectedLeaf) => {
    // Break caught: realpath on a final declared reparse crosses its target;
    // the ordinary-leaf check must happen first.
    const fixture = await createPnpmFallbackFixture();
    const declaredTarget = resolve(fixture.target);
    const protectedTarget = resolve(fixture.root, "..", protectedLeaf);
    const observations: string[] = [];
    const observeForbidden = (operation: string, path: string) => {
      if (resolve(path) === protectedTarget ||
          (resolve(path) === declaredTarget && operation !== "lstat")) {
        observations.push(operation);
        throw new Error("final-target-observed");
      }
    };

    await expect(resolvePnpm11Fallback(fixture.root, {
      lstat: async (path) => {
        observeForbidden("lstat", path);
        if (resolve(path) === declaredTarget) {
          return {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => true,
          } as Stats;
        }
        return lstat(path);
      },
      readFile: async (path, encoding) => {
        observeForbidden("read", path);
        return readFile(path, encoding);
      },
      readlink: async (path) => {
        observeForbidden("readlink", path);
        if (resolve(path) === declaredTarget) return protectedTarget;
        return readlink(path);
      },
      realpath: async (path) => {
        observeForbidden("realpath", path);
        if (resolve(path) === declaredTarget) return protectedTarget;
        return realpath(path);
      },
    })).rejects.toThrow("The package-manager build command is unavailable.");
    expect(observations).toEqual([]);
  });

  it("keeps the packaged renderer isolated while exposing restart and manual AI lifecycle calls", async () => {
    const invocations: Array<{ channel: string; payload?: unknown }> = [];
    let exposedName = "";
    let exposedValue: unknown;
    let packageManagerCli = process.env.npm_execpath?.trim();
    if (!packageManagerCli) {
      const pnpmHome = process.env.PNPM_HOME?.trim();
      if (pnpmHome) {
        packageManagerCli = await resolvePnpm11Fallback(pnpmHome);
      }
    }
    if (!packageManagerCli) {
      throw new Error("The package-manager build command is unavailable.");
    }
    const worktreeRoot = await realpath(fileURLToPath(
      new URL("../../../", import.meta.url),
    ));
    const emittedDesktopRoot = resolve(worktreeRoot, "dist", "desktop");
    const emittedPreloadPath = resolve(
      emittedDesktopRoot,
      "preload.cjs",
    );
    const emittedMainPath = resolve(emittedDesktopRoot, "main.js");
    const generatedDesktopFiles = [
      ["preload.cjs", emittedPreloadPath],
      ["main.js", emittedMainPath],
    ] as const;
    for (const [fileName, generatedPath] of generatedDesktopFiles) {
      expect(generatedPath).toBe(resolve(
        worktreeRoot,
        "dist",
        "desktop",
        fileName,
      ));
      expect(relative(worktreeRoot, generatedPath)).toBe(join(
        "dist",
        "desktop",
        fileName,
      ));
      expect(dirname(generatedPath)).toBe(emittedDesktopRoot);
      const generatedFileExists = await access(generatedPath).then(
        () => true,
        () => false,
      );
      if (generatedFileExists) {
        expect(await realpath(dirname(generatedPath))).toBe(
          emittedDesktopRoot,
        );
      }
      await rm(generatedPath, { force: true, recursive: false });
      await expect(access(generatedPath)).rejects.toThrow();
    }
    const packageManagerIsExecutable = extname(packageManagerCli).toLowerCase() ===
      ".exe";
    await execFileAsync(
      packageManagerIsExecutable ? packageManagerCli : process.execPath,
      packageManagerIsExecutable
        ? ["build:server"]
        : [packageManagerCli, "build:server"],
      { cwd: worktreeRoot },
    );
    for (const [, generatedPath] of generatedDesktopFiles) {
      await expect(access(generatedPath)).resolves.toBeUndefined();
    }
    expect(createForgeConfig({}).packagerConfig?.asar).toBe(true);
    expect(desktopPackageIgnore(emittedPreloadPath)).toBe(false);
    const emittedPreload = await readFile(emittedPreloadPath, "utf8");
    runInNewContext(emittedPreload, {
      exports: {},
      module: { exports: {} },
      require: (specifier: string) => {
        if (specifier !== "electron") {
          throw new Error(`Unexpected preload dependency: ${specifier}`);
        }
        return {
          contextBridge: {
            exposeInMainWorld(name: string, value: unknown) {
              exposedName = name;
              exposedValue = value;
            },
          },
          ipcRenderer: {
            invoke(channel: string, payload?: unknown) {
              invocations.push(
                payload === undefined ? { channel } : { channel, payload },
              );
              return Promise.resolve({ channel });
            },
          },
        };
      },
    });

    expect(exposedName).toBe("intentArcDesktop");
    const preload = exposedValue as {
      ai: {
        list(): Promise<unknown>;
        createManual(input: { label: string }): Promise<unknown>;
        removeManual(id: string): Promise<unknown>;
      };
      lifecycle: { restart(): Promise<unknown> };
    };
    await preload.ai.list();
    await preload.ai.createManual({ label: "Fixture MCP client" });
    await preload.ai.removeManual("fixture-manual-connection");
    await preload.lifecycle.restart();
    expect(invocations).toEqual([
      { channel: "intentarc:ai:list" },
      {
        channel: "intentarc:ai:create-manual",
        payload: { label: "Fixture MCP client" },
      },
      {
        channel: "intentarc:ai:remove-manual",
        payload: "fixture-manual-connection",
      },
      { channel: "intentarc:lifecycle:restart" },
    ]);

    const windowOptions: DesktopWindowOptions[] = [];
    const app = {
      isPackaged: true,
      requestSingleInstanceLock: () => true,
      setAppUserModelId: () => undefined,
      getPath: (_name: "userData") => "C:\\IntentArc-fixture",
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      relaunch: () => undefined,
      quit: () => undefined,
    };
    const webContents = {
      mainFrame: { url: "" },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    };
    const electron: DesktopElectronFacade = {
      app,
      createWindow(options) {
        windowOptions.push(options);
        return {
          webContents,
          loadURL: async (url: string) => {
            webContents.mainFrame.url = url;
          },
          isMinimized: () => false,
          restore: () => undefined,
          focus: () => undefined,
          isDestroyed: () => false,
          destroy: () => undefined,
        };
      },
    };
    const builtDesktop = await import(pathToFileURL(emittedMainPath).href) as {
      runIntentArcDesktop(
        options: RunIntentArcDesktopOptions,
      ): Promise<void>;
    };
    await builtDesktop.runIntentArcDesktop({
      electron,
      settingsStore: {
        read: () => ({
          schemaVersion: 2,
          archivePath: "C:\\data\\fixture.sqlite",
          onboardingCompleted: true,
          connections: [],
        }),
        write: () => undefined,
      },
      openApplication: async () => ({
        service: {} as never,
        close: () => undefined,
      }),
      startServer: async () => ({
        origin: "http://127.0.0.1:49152",
        launchUrl: "http://127.0.0.1:49152/?key=fixture-launch-key",
        close: async () => undefined,
      }),
    });
    expect(windowOptions).toHaveLength(1);
    expect(windowOptions[0]?.webPreferences.preload).toBe(
      emittedPreloadPath,
    );
    expect(windowOptions[0]?.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: emittedPreloadPath,
    });
  }, 30_000);

  it.skipIf(process.platform !== "win32").each(selectorEnvironments)(
    "uses OS-rooted PowerShell for Squirrel and release verification with a $label selector environment",
    async ({ environment }) => {
      const systemPowerShell = await realpath(
        "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      const release = await import(
        "../../../scripts/desktop-release.mjs"
      ) as {
        verifyAuthenticodeSignature(path: string): Promise<void>;
        readAuthenticodePublisher(path: string): Promise<{
          thumbprint: string;
          subject: string;
        }>;
      };

      const publisher = await withSelectorEnvironment(environment, async () => {
        await verifyInstalledBridgeSignature(systemPowerShell);
        await release.verifyAuthenticodeSignature(systemPowerShell);
        return release.readAuthenticodePublisher(systemPowerShell);
      });

      expect(publisher.thumbprint).toMatch(/^[A-Fa-f0-9]{4,128}$/);
      expect(publisher.subject.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "passes only OS roots and the signature target to Authenticode PowerShell",
    async () => {
      const calls: Array<{
        executablePath: string;
        arguments: string[];
        environment: Record<string, string | undefined>;
      }> = [];
      const fakeExecFile = (() => undefined) as unknown as typeof execFile;
      Object.defineProperty(fakeExecFile, promisify.custom, {
        value: async (
          executablePath: string,
          arguments_: string[],
          options: { env: Record<string, string | undefined> },
        ) => {
          calls.push({
            executablePath,
            arguments: arguments_,
            environment: options.env,
          });
          return { stdout: "Valid\n", stderr: "" };
        },
      });
      vi.doMock("node:child_process", () => ({ execFile: fakeExecFile }));
      vi.resetModules();
      const signingSecret = "authenticode-environment-sentinel";
      const originalSecret =
        process.env.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD;
      process.env.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD = signingSecret;
      try {
        const authenticode = await import(
          "../../../scripts/windows-authenticode.mjs"
        ) as {
          verifyAuthenticodeSignature(path: string): Promise<void>;
        };

        await authenticode.verifyAuthenticodeSignature(
          "C:\\release\\IntentArc Bridge.exe",
        );

        expect(calls).toHaveLength(1);
        expect(Object.keys(calls[0]!.environment).sort()).toEqual([
          "INTENTARC_SIGNATURE_TARGET",
          "SystemRoot",
          "WINDIR",
        ]);
        expect(calls[0]!.environment).not.toHaveProperty(
          "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
        );
        expect(calls[0]!.environment.INTENTARC_SIGNATURE_TARGET).toBe(
          "C:\\release\\IntentArc Bridge.exe",
        );
      } finally {
        if (originalSecret === undefined) {
          delete process.env.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD;
        } else {
          process.env.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD = originalSecret;
        }
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }
    },
  );

  it("packages only runtime inputs plus complete web, migration, bridge, native, and license resources", async () => {
    const config = createForgeConfig({});
    const squirrelMaker = config.makers[0] as unknown as {
      config?: { vendorDirectory?: string };
      prepareConfig(architecture: string): Promise<void>;
    };
    await squirrelMaker.prepareConfig("x64");
    expect(config.packagerConfig?.extraResource).toEqual([
      "dist/bridge",
      "dist/desktop-resources",
    ]);
    expect(squirrelMaker.config?.vendorDirectory).toBe(
      resolve("dist", "squirrel-vendor"),
    );
    expect(desktopPackageIgnore(resolve(".superpowers"))).toBe(true);
    expect(desktopPackageIgnore("/package.json")).toBe(false);
    expect(desktopPackageIgnore("/dist/desktop/entry.js")).toBe(false);
    expect(desktopPackageIgnore(resolve("node_modules", ".cache"))).toBe(true);
    expect(desktopPackageIgnore(resolve("out"))).toBe(true);
    expect(desktopPackageIgnore(resolve("dist", "web-client"))).toBe(false);
    expect(desktopPackageIgnore(resolve("dist", "squirrel-vendor"))).toBe(true);
    expect(desktopPackageIgnore(resolve("dist", "storage", "migrations.js")))
      .toBe(false);
    expect(desktopPackageIgnore(resolve("dist", "desktop", "entry.js")))
      .toBe(false);
    expect(desktopPackageIgnore(resolve("dist", "desktop", "entry.js.map")))
      .toBe(true);
    expect(desktopPackageIgnore(resolve("dist", "desktop", "entry.d.ts")))
      .toBe(true);
    expect(desktopPackageIgnore(resolve("dist", "test-support", "database.js")))
      .toBe(true);
    expect(desktopPackageIgnore(resolve(
      "dist",
      ".intentarc-bridge-build-owner",
    ))).toBe(true);
    expect(desktopPackageIgnore(resolve("node_modules", "zod", "index.js")))
      .toBe(false);
    expect(desktopPackageIgnore(resolve(
      "node_modules",
      "zod",
      "src",
      "index.ts",
    ))).toBe(true);
    expect(desktopPackageIgnore(resolve(
      "node_modules",
      "@electron-forge",
      "cli",
      "dist",
      "index.js",
    ))).toBe(true);
    expect(desktopPackageIgnore(resolve(
      "node_modules",
      "@playwright",
      "test",
      "index.js",
    ))).toBe(true);
    expect(desktopPackageIgnore(resolve("node_modules", ".pnpm", "lock.yaml")))
      .toBe(true);
  });

  it("keeps local makes free of signing hooks but wires the preservation adapter for releases", () => {
    const unsigned = createForgeConfig({});
    expect(unsigned.packagerConfig?.windowsSign).toBeUndefined();
    expect(unsigned.hooks?.postPackage).toBeUndefined();
    expect(unsigned.hooks?.postMake).toBeUndefined();
    expect(() => createForgeConfig({
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
    })).toThrow(/certificate.*password|signing/i);
    expect(() => createForgeConfig({
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "secret",
    })).toThrow(/certificate.*password|signing/i);

    const release = createForgeConfig({
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "secret",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    });
    expect(release.packagerConfig?.windowsSign).toEqual({
      hookFunction: expect.any(Function),
    });
    expect(release.hooks?.postPackage).toBeTypeOf("function");
    expect(release.hooks?.postMake).toBeTypeOf("function");
  });

  it("persists opt-in lifecycle stages around the real bridge filesystem activation before shortcut creation", async () => {
    // Catches replacing the real installBridgeVersion path with a mock or losing
    // the first stage boundary needed to distinguish copy, verification, and activation.
    const fixture = await createPackagedHookFixture("receipt-success");
    const protocolPhases: string[] = [];
    const shortcutCalls: string[][] = [];

    await expect(handleSquirrelEvent({
      argv: ["--squirrel-install", "ignored-squirrel-version"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {
        INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT: "1",
      },
      inspectBridgeIdentity: fixture.inspectBridgeIdentity,
      verifyBridgeProtocol: async ({ phase }) => {
        protocolPhases.push(phase);
      },
      runUpdate: async (arguments_) => {
        shortcutCalls.push([...arguments_]);
        expect(JSON.parse(await readFile(
          join(fixture.binaryRoot, "bridge", "current-version.json"),
          "utf8",
        ))).toMatchObject({ releaseVersion: "0.0.9" });
      },
      quit: () => undefined,
    })).resolves.toBe(true);

    const receipt = JSON.parse(await readFile(
      fixture.receiptPath,
      "utf8",
    )) as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual([
      "event",
      "releaseVersion",
      "schemaVersion",
      "stages",
      "status",
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      event: "--squirrel-install",
      releaseVersion: "0.0.9",
      status: "success",
    });
    expect(receipt.stages).toEqual([
      { stage: "entry-recognition", status: "completed" },
      { stage: "release-metadata", status: "started" },
      { stage: "release-metadata", status: "completed" },
      { stage: "bridge-staging-copy", status: "started" },
      { stage: "bridge-staging-copy", status: "completed" },
      { stage: "staged-signature-verification", status: "skipped" },
      { stage: "staged-protocol-verification", status: "started" },
      { stage: "staged-protocol-verification", status: "completed" },
      { stage: "staged-identity-inspection", status: "started" },
      { stage: "staged-identity-inspection", status: "completed" },
      { stage: "activation-pointer-publication", status: "started" },
      { stage: "activation-pointer-publication", status: "completed" },
      { stage: "active-signature-verification", status: "skipped" },
      { stage: "active-protocol-verification", status: "started" },
      { stage: "active-protocol-verification", status: "completed" },
      { stage: "shortcut-operation", status: "started" },
      { stage: "shortcut-operation", status: "completed" },
      { stage: "lifecycle", status: "completed" },
    ]);
    expect(protocolPhases).toEqual(["staged", "active"]);
    expect(shortcutCalls).toEqual([["--createShortcut=IntentArc.exe"]]);
    expect((await readdir(fixture.binaryRoot)).some((name) =>
      name.includes(`${squirrelLifecycleReceiptName}.`) && name.endsWith(".tmp")
    )).toBe(false);
  });

  it("does not start activation until staged identity inspection resolves", async () => {
    // Catches activation being attributed before the asynchronous staged
    // identity/publisher boundary has actually completed.
    const fixture = await createPackagedHookFixture("identity-pending");
    const identityStarted = Promise.withResolvers<void>();
    const releaseIdentity = Promise.withResolvers<Awaited<ReturnType<
      typeof fixture.inspectBridgeIdentity
    >>>();
    let inspections = 0;
    const handling = handleSquirrelEvent({
      argv: ["--squirrel-install"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {
        INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT: "1",
      },
      inspectBridgeIdentity: async () => {
        inspections += 1;
        if (inspections === 1) {
          identityStarted.resolve();
          return releaseIdentity.promise;
        }
        return fixture.inspectBridgeIdentity();
      },
      verifyBridgeProtocol: async () => undefined,
      runUpdate: async () => undefined,
      quit: () => undefined,
    });

    await identityStarted.promise;
    const pendingReceipt = JSON.parse(await readFile(
      fixture.receiptPath,
      "utf8",
    )) as { stages: Array<{ stage: string; status: string }> };
    expect(pendingReceipt.stages.at(-1)).toEqual({
      stage: "staged-identity-inspection",
      status: "started",
    });
    expect(pendingReceipt.stages.some(({ stage }) =>
      stage === "activation-pointer-publication"
    )).toBe(false);

    releaseIdentity.resolve(await fixture.inspectBridgeIdentity());
    await expect(handling).resolves.toBe(true);
  });

  it("attributes staged identity rejection without starting activation or masking the error", async () => {
    // Catches identity/publisher rejection being mislabeled as activation and
    // ensures the real rejection object and Squirrel quit behavior survive.
    const fixture = await createPackagedHookFixture("identity-rejection");
    const sensitiveSentinel = "synthetic-identity-detail-must-not-persist";
    const identityError = new Error(sensitiveSentinel);
    let quitCalls = 0;
    const handling = handleSquirrelEvent({
      argv: ["--squirrel-install", "synthetic-extra-argument"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {
        INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT: "1",
        INTENTARC_TEST_SENSITIVE: sensitiveSentinel,
      },
      inspectBridgeIdentity: async () => {
        throw identityError;
      },
      verifyBridgeProtocol: async () => undefined,
      runUpdate: async () => undefined,
      quit: () => {
        quitCalls += 1;
      },
    });

    await expect(handling).rejects.toBe(identityError);
    const receiptText = await readFile(fixture.receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as {
      failure: unknown;
      stages: Array<{ stage: string; status: string }>;
    };
    expect(receipt.failure).toEqual({
      category: "staged-identity-inspection",
      message: "Staged bridge identity inspection failed.",
    });
    expect(receipt.stages.some(({ stage }) =>
      stage === "activation-pointer-publication"
    )).toBe(false);
    expect(receiptText).not.toContain(sensitiveSentinel);
    expect(receiptText).not.toContain("synthetic-extra-argument");
    expect(receiptText).not.toContain(fixture.root);
    expect(receiptText).not.toContain("stack");
    expect(quitCalls).toBe(1);
  });

  it("fails the opted-in hook cleanly when its fixed receipt cannot be persisted", async () => {
    // Catches recorder persistence errors being masked, leaking temporary
    // receipt files, or allowing bridge activation/shortcut side effects.
    const fixture = await createPackagedHookFixture("receipt-persistence");
    await mkdir(fixture.receiptPath);
    let quitCalls = 0;
    let shortcutCalls = 0;

    await expect(handleSquirrelEvent({
      argv: ["--squirrel-install"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {
        INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT: "1",
      },
      inspectBridgeIdentity: fixture.inspectBridgeIdentity,
      verifyBridgeProtocol: async () => undefined,
      runUpdate: async () => {
        shortcutCalls += 1;
      },
      quit: () => {
        quitCalls += 1;
      },
    })).rejects.toBeDefined();

    expect(shortcutCalls).toBe(0);
    expect(quitCalls).toBe(1);
    await expect(access(join(
      fixture.binaryRoot,
      "bridge",
      "current-version.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.binaryRoot)).some((name) =>
      name.includes(`${squirrelLifecycleReceiptName}.`) && name.endsWith(".tmp")
    )).toBe(false);
  });

  it("records only a bounded failure while preserving the real packaged-hook rejection", async () => {
    // Catches swallowing a Squirrel hook failure or copying arbitrary verifier,
    // environment, path, or extra-argv content into the durable receipt.
    const fixture = await createPackagedHookFixture("receipt-failure");
    const sensitiveSentinel = "synthetic-sensitive-detail-must-not-persist";
    let quitCalls = 0;

    await expect(handleSquirrelEvent({
      argv: ["--squirrel-install", "synthetic-extra-argument"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {
        INTENTARC_SQUIRREL_LIFECYCLE_RECEIPT: "1",
        INTENTARC_TEST_SENSITIVE: sensitiveSentinel,
      },
      inspectBridgeIdentity: fixture.inspectBridgeIdentity,
      verifyBridgeProtocol: async ({ phase }) => {
        if (phase === "staged") {
          throw new Error(`Synthetic protocol failure: ${sensitiveSentinel}`);
        }
      },
      runUpdate: async () => undefined,
      quit: () => {
        quitCalls += 1;
      },
    })).rejects.toThrow("Synthetic protocol failure");

    const receiptText = await readFile(fixture.receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as {
      status: string;
      stages: unknown[];
      failure: unknown;
    };
    expect(Object.keys(receipt).sort()).toEqual([
      "event",
      "failure",
      "releaseVersion",
      "schemaVersion",
      "stages",
      "status",
    ]);
    expect(receipt.status).toBe("failure");
    expect(receipt.failure).toEqual({
      category: "staged-protocol-verification",
      message: "Staged bridge protocol verification failed.",
    });
    expect(receipt.stages.at(-1)).toEqual({
      stage: "lifecycle",
      status: "failed",
    });
    expect(receiptText).not.toContain(sensitiveSentinel);
    expect(receiptText).not.toContain("synthetic-extra-argument");
    expect(receiptText).not.toContain(fixture.root);
    expect(receiptText).not.toContain("INTENTARC_TEST_SENSITIVE");
    expect(receiptText).not.toContain("stack");
    expect(quitCalls).toBe(1);
  });

  it("leaves no lifecycle receipt when the packaged hook diagnostic is disabled", async () => {
    // Catches diagnostics becoming an always-on production side effect.
    const fixture = await createPackagedHookFixture("receipt-disabled");
    await handleSquirrelEvent({
      argv: ["--squirrel-install"],
      platform: "win32",
      execPath: fixture.execPath,
      resourcesPath: fixture.resourcesPath,
      version: "0.0.9",
      environment: {},
      inspectBridgeIdentity: fixture.inspectBridgeIdentity,
      verifyBridgeProtocol: async () => undefined,
      runUpdate: async () => undefined,
      quit: () => undefined,
    });
    await expect(access(fixture.receiptPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates an optional SignTool path without exposing it in Forge signing configuration", async () => {
    const signToolPath = await realpath(resolve(
      "node_modules",
      "@electron",
      "windows-sign",
      "vendor",
      "signtool.exe",
    ));
    const signingEnvironment = {
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      WINDOWS_SIGNTOOL_PATH: signToolPath,
    };
    const release = createForgeConfig(signingEnvironment);

    expect(release.packagerConfig?.windowsSign).toEqual({
      hookFunction: expect.any(Function),
    });
    expect(() => createForgeConfig({
      ...signingEnvironment,
      WINDOWS_SIGNTOOL_PATH: "relative\\signtool.exe",
    })).toThrow(/SignTool.*absolute/i);
    expect(() => createForgeConfig({
      ...signingEnvironment,
      WINDOWS_SIGNTOOL_PATH: resolve("missing-signtool.exe"),
    })).toThrow(/SignTool.*file/i);
  });

  it("uses only a normalized certificate thumbprint for configured Squirrel signing", async () => {
    const certificateThumbprint = "ab".repeat(20);
    const release = createForgeConfig({
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: ["test", process.pid].join("-"),
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: certificateThumbprint,
    });
    const squirrelMaker = release.makers[0] as unknown as {
      config?: {
        certificateFile?: string;
        certificatePassword?: string;
        signWithParams?: string;
        windowsSign?: object;
      };
      prepareConfig(architecture: string): Promise<void>;
    };
    await squirrelMaker.prepareConfig("x64");

    expect({
      hasCertificateFile: Boolean(squirrelMaker.config?.certificateFile),
      hasCertificatePassword: Boolean(
        squirrelMaker.config?.certificatePassword,
      ),
      signWithParams: squirrelMaker.config?.signWithParams,
      usesEmbeddedSigner: squirrelMaker.config?.windowsSign !== undefined,
    }).toEqual({
      hasCertificateFile: false,
      hasCertificatePassword: false,
      signWithParams:
        `/a /sha1 ${certificateThumbprint.toUpperCase()} /fd sha256`,
      usesEmbeddedSigner: false,
    });

    const unsigned = createForgeConfig({});
    const unsignedSquirrelMaker = unsigned.makers[0] as unknown as {
      config?: {
        certificateFile?: string;
        certificatePassword?: string;
        signWithParams?: string;
        windowsSign?: object;
      };
      prepareConfig(architecture: string): Promise<void>;
    };
    await unsignedSquirrelMaker.prepareConfig("x64");
    expect({
      hasCertificateFile: Boolean(
        unsignedSquirrelMaker.config?.certificateFile,
      ),
      hasCertificatePassword: Boolean(
        unsignedSquirrelMaker.config?.certificatePassword,
      ),
      hasSignWithParams: Boolean(
        unsignedSquirrelMaker.config?.signWithParams,
      ),
      usesEmbeddedSigner:
        unsignedSquirrelMaker.config?.windowsSign !== undefined,
    }).toEqual({
      hasCertificateFile: false,
      hasCertificatePassword: false,
      hasSignWithParams: false,
      usesEmbeddedSigner: false,
    });
  });

  it("rejects absent or malformed certificate thumbprints for signed releases", () => {
    const signingEnvironment = {
      INTENTARC_RELEASE_BUILD: "1",
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: ["test", process.pid].join("-"),
    };

    expect(() => createForgeConfig(signingEnvironment))
      .toThrow(/thumbprint/i);
    for (const certificateThumbprint of [
      "A".repeat(39),
      "A".repeat(41),
      `${"A".repeat(39)}G`,
      `${"A".repeat(20)} ${"B".repeat(20)}`,
    ]) {
      expect(() => createForgeConfig({
        ...signingEnvironment,
        INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: certificateThumbprint,
      })).toThrow(/thumbprint/i);
    }
  });

  it("exposes an unsigned x64 make and a separately gated release command", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve("package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["desktop:make"]).toBe(
      "pnpm build && pnpm bridge:build && pnpm desktop:resources && node scripts/prepare-squirrel-vendor.mjs && electron-forge make --platform win32 --arch x64",
    );
    expect(packageJson.scripts["desktop:release"]).toBe(
      "node scripts/desktop-release.mjs",
    );
  });

  it("prepares a host-compatible private Squirrel vendor directory without dependency install scripts", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "intentarc-squirrel-source-"),
    );
    const outputRoot = await mkdtemp(
      join(tmpdir(), "intentarc-squirrel-output-"),
    );
    temporaryRoots.push(sourceRoot, outputRoot);
    await writeFile(join(sourceRoot, "Squirrel.exe"), "squirrel");
    await writeFile(join(sourceRoot, "7z-x64.exe"), "7z-exe");
    await writeFile(join(sourceRoot, "7z-x64.dll"), "7z-dll");

    const squirrelTools = await import(
      "../../../scripts/prepare-squirrel-vendor.mjs"
    ) as {
      prepareSquirrelVendor(input: {
        sourceRoot: string;
        outputRoot: string;
        architecture: string;
      }): Promise<void>;
    };
    await squirrelTools.prepareSquirrelVendor({
      sourceRoot,
      outputRoot,
      architecture: "x64",
    });

    expect(await readFile(join(outputRoot, "Squirrel.exe"), "utf8"))
      .toBe("squirrel");
    expect(await readFile(join(outputRoot, "7z.exe"), "utf8")).toBe("7z-exe");
    expect(await readFile(join(outputRoot, "7z.dll"), "utf8")).toBe("7z-dll");
  });

  it("allows install scripts only for required native runtime and build binaries", async () => {
    const workspace = await readFile(resolve("pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("better-sqlite3: true");
    expect(workspace).toContain("esbuild: true");
    expect(workspace).toContain("electron-winstaller: false");
    const readme = await readFile(resolve("README.md"), "utf8");
    expect(readme).toContain("better-sqlite3");
    expect(readme).toContain("esbuild");
    expect(readme).not.toMatch(
      /build scripts only for [`']?better-sqlite3/i,
    );
  });

  it("prepares explicit release, support, and third-party license resources", async () => {
    const resources = await import(
      "../../../scripts/prepare-desktop-resources.mjs"
    ) as {
      prepareDesktopResources(input: {
        packageRoot: string;
        outputRoot: string;
        environment: Record<string, string | undefined>;
      }): Promise<void>;
    };
    const outputRoot = join(
      await mkdtemp(join(tmpdir(), "intentarc-desktop-resources-")),
      "resources",
    );
    temporaryRoots.push(resolve(outputRoot, ".."));

    await resources.prepareDesktopResources({
      packageRoot: resolve("."),
      outputRoot,
      environment: {},
    });

    expect(JSON.parse(await readFile(
      join(outputRoot, "intentarc-release.json"),
      "utf8",
    ))).toEqual({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      requireSignatures: false,
    });
    const notices = JSON.parse(await readFile(
      join(outputRoot, "THIRD-PARTY-NOTICES.json"),
      "utf8",
    )) as {
      dependencies: Array<{ name: string; version: string; license: string }>;
    };
    expect(notices.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "better-sqlite3",
        version: "13.0.1",
      }),
      expect.objectContaining({
        name: "@modelcontextprotocol/sdk",
      }),
      expect.objectContaining({
        name: "express",
      }),
    ]));
    expect(await readFile(
      join(outputRoot, "desktop-application.md"),
      "utf8",
    )).toContain("# IntentArc Desktop");
  });

  it("verifies setup and both packaged executables before a release can complete", async () => {
    const release = await import(
      "../../../scripts/desktop-release.mjs"
    ) as {
      assertReleaseSigningEnvironment(
        environment: Record<string, string | undefined>,
      ): void;
      verifyReleaseExecutables(input: {
        outputRoot: string;
        environment?: Record<string, string | undefined>;
        verifySignature(path: string): Promise<void>;
        inspectBridgeIdentity(path: string, context: {
          ownerRoot: string;
          environment: Record<string, string | undefined>;
        }): Promise<{
          formatVersion: 1;
          releaseVersion: string;
          buildMode: "signed-release" | "unsigned-development";
          supportSha256: string;
        }>;
        inspectBridgePredecessor(path: string, context: {
          ownerRoot: string;
          environment: Record<string, string | undefined>;
        }): Promise<{
          formatVersion: 1;
          versionDirectory: string;
          releaseVersion: string;
          buildMode: "signed-release";
          executableSha256: string;
          payloadSha256: string;
          supportSha256: string;
          publisher: {
            thumbprint: string;
            subject: string;
          };
        } | null>;
        readPublisher(path: string): Promise<{
          thumbprint: string;
          subject: string;
        }>;
        digestBridgeSupport(path: string): Promise<string>;
      }): Promise<readonly string[]>;
    };
    expect(() => release.assertReleaseSigningEnvironment({})).toThrow(
      /certificate.*password|signing/i,
    );
    expect(() => release.assertReleaseSigningEnvironment({
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
      INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
    })).toThrow(/thumbprint/i);
    expect(() => release.assertReleaseSigningEnvironment({
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: `${"A".repeat(39)}G`,
      INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
    })).toThrow(/thumbprint/i);
    expect(() => release.assertReleaseSigningEnvironment({
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "secret",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    })).toThrow(/predecessor|rollback|authorization/i);
    release.assertReleaseSigningEnvironment({
      INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
      INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "secret",
      INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "a".repeat(40),
      INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
    });
    const checked: string[] = [];
    const identityChecks: string[] = [];
    const identityContexts: Array<{
      ownerRoot: string;
      environment: Record<string, string | undefined>;
    }> = [];
    const predecessorContexts: Array<{
      ownerRoot: string;
      environment: Record<string, string | undefined>;
    }> = [];
    const publisherChecks: string[] = [];
    const supportChecks: string[] = [];
    const environment = {
      INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT: "C:\\audit",
      INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH:
        "C:\\audit\\bridge-diagnostics.tokens",
    };
    const verified = await release.verifyReleaseExecutables({
      outputRoot: "C:\\repo\\out",
      environment,
      verifySignature: async (path) => {
        checked.push(path);
      },
      inspectBridgeIdentity: async (path, context) => {
        identityChecks.push(path);
        identityContexts.push(context);
        return {
          formatVersion: 1,
          releaseVersion: "0.1.0",
          buildMode: "signed-release",
          supportSha256: "a".repeat(64),
        };
      },
      inspectBridgePredecessor: async (_path, context) => {
        predecessorContexts.push(context);
        return null;
      },
      readPublisher: async (path) => {
        publisherChecks.push(path);
        return {
          thumbprint: "AA11",
          subject: "CN=IntentArc",
        };
      },
      digestBridgeSupport: async (path) => {
        supportChecks.push(path);
        return "a".repeat(64);
      },
    });

    expect(checked).toEqual([
      "C:\\repo\\out\\IntentArc-win32-x64\\IntentArc.exe",
      "C:\\repo\\out\\IntentArc-win32-x64\\resources\\bridge\\IntentArc Bridge.exe",
      "C:\\repo\\out\\make\\squirrel.windows\\x64\\IntentArc Setup.exe",
    ]);
    expect(verified).toEqual(checked);
    expect(identityChecks).toEqual([
      "C:\\repo\\out\\IntentArc-win32-x64\\resources\\bridge\\IntentArc Bridge.exe",
    ]);
    expect(identityContexts).toEqual([{
      ownerRoot: "C:\\repo\\out",
      environment,
    }]);
    expect(predecessorContexts).toHaveLength(1);
    expect(predecessorContexts[0]).toBe(identityContexts[0]);
    expect(publisherChecks).toEqual(checked);
    expect(supportChecks).toEqual([
      "C:\\repo\\out\\IntentArc-win32-x64\\resources\\bridge\\node_modules\\better-sqlite3",
    ]);

    await expect(release.verifyReleaseExecutables({
      outputRoot: "C:\\repo\\out",
      verifySignature: async () => undefined,
      inspectBridgeIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "unsigned-development",
        supportSha256: "a".repeat(64),
      }),
      inspectBridgePredecessor: async () => null,
      readPublisher: async () => ({
        thumbprint: "AA11",
        subject: "CN=IntentArc",
      }),
      digestBridgeSupport: async () => "a".repeat(64),
    })).rejects.toThrow(/signed-release|embedded|mode/i);

    await expect(release.verifyReleaseExecutables({
      outputRoot: "C:\\repo\\out",
      verifySignature: async () => undefined,
      inspectBridgeIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.2.0",
        buildMode: "signed-release",
        supportSha256: "a".repeat(64),
      }),
      inspectBridgePredecessor: async () => ({
        formatVersion: 1,
        versionDirectory: "0.1.0-0123456789abcdef",
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        executableSha256: "1".repeat(64),
        payloadSha256: "2".repeat(64),
        supportSha256: "3".repeat(64),
        publisher: {
          thumbprint: "BB22",
          subject: "CN=Other Publisher",
        },
      }),
      readPublisher: async () => ({
        thumbprint: "AA11",
        subject: "CN=IntentArc",
      }),
      digestBridgeSupport: async () => "a".repeat(64),
    })).rejects.toThrow(/predecessor|publisher|authorization/i);

    await expect(release.verifyReleaseExecutables({
      outputRoot: "C:\\repo\\out",
      verifySignature: async () => undefined,
      inspectBridgeIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.2.0",
        buildMode: "signed-release",
        supportSha256: "a".repeat(64),
      }),
      inspectBridgePredecessor: async () => null,
      readPublisher: async () => ({
        thumbprint: "AA11",
        subject: "CN=IntentArc",
      }),
      digestBridgeSupport: async () => "b".repeat(64),
    })).rejects.toThrow(/support|digest|identity/i);
  });

  it("rejects unsupported pnpm JavaScript lookalikes before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-release-lookalike-"));
    temporaryRoots.push(root);
    const release = await import(
      "../../../scripts/desktop-release.mjs"
    ) as {
      runDesktopRelease(
        environment: Record<string, string | undefined>,
      ): Promise<void>;
    };

    for (const name of ["pnpm-helper.cjs", "pnpm-malicious.js", "pnpmx.mjs"]) {
      const cliPath = join(root, name);
      const markerPath = join(root, `${name}.executed`);
      await writeFile(cliPath, [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.env.INTENTARC_RELEASE_TEST_MARKER, 'executed');",
        "process.exitCode = 17;",
      ].join("\n"));

      await expect(release.runDesktopRelease({
        npm_execpath: cliPath,
        INTENTARC_RELEASE_TEST_MARKER: markerPath,
        INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
        INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
        INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
        INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
      })).rejects.toThrow(/unsupported/i);
      await expect(access(markerPath)).rejects.toThrow();
    }
  });

  it("resolves explicit pnpm lifecycle entry points without host-dependent execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-release-resolver-"));
    temporaryRoots.push(root);
    const unsupportedPath = join(root, "npm.cjs");
    await writeFile(unsupportedPath, "process.exitCode = 99;");
    const lifecycle = await import(
      "../../../scripts/pnpm-lifecycle.mjs"
    ) as {
      createPnpmLifecycleInvocation(
        cliPath: string,
        lifecycleArguments: readonly string[],
        runtime: { platform: NodeJS.Platform; nodeExecutable: string },
      ): { command: string; arguments: string[] };
      resolvePnpmLifecycleInvocation(
        environment: Record<string, string | undefined>,
        lifecycleArguments: readonly string[],
      ): Promise<{ command: string; arguments: string[] }>;
    };
    const release = await import(
      "../../../scripts/desktop-release.mjs"
    ) as {
      createPnpmInvocation?: (
        cliPath: string,
        runtime: { platform: NodeJS.Platform; nodeExecutable: string },
      ) => { command: string; arguments: string[] };
      resolvePnpmInvocation?: (
        environment: Record<string, string | undefined>,
      ) => Promise<{ command: string; arguments: string[] }>;
    };

    expect(release.createPnpmInvocation).toBeTypeOf("function");
    expect(release.resolvePnpmInvocation).toBeTypeOf("function");
    if (!release.createPnpmInvocation || !release.resolvePnpmInvocation) return;

    const nodeExecutable = "/runtime/node";
    expect(lifecycle.createPnpmLifecycleInvocation(
      "/runtime/pnpm.cjs",
      ["typecheck:server"],
      { platform: "linux", nodeExecutable },
    )).toEqual({
      command: nodeExecutable,
      arguments: ["/runtime/pnpm.cjs", "typecheck:server"],
    });
    expect(release.createPnpmInvocation("/runtime/pnpm.cjs", {
      platform: "linux",
      nodeExecutable,
    })).toEqual({
      command: nodeExecutable,
      arguments: ["/runtime/pnpm.cjs", "desktop:make"],
    });
    for (const name of ["pnpm.cjs", "pnpm.js", "pnpm.mjs"]) {
      expect(lifecycle.createPnpmLifecycleInvocation(`/runtime/${name}`, [
        "typecheck:server",
      ], {
        platform: "linux",
        nodeExecutable,
      })).toEqual({
        command: nodeExecutable,
        arguments: [`/runtime/${name}`, "typecheck:server"],
      });
    }
    expect(lifecycle.createPnpmLifecycleInvocation("/runtime/pnpm.exe", [
      "typecheck:server",
    ], {
      platform: "win32",
      nodeExecutable,
    })).toEqual({
      command: "/runtime/pnpm.exe",
      arguments: ["typecheck:server"],
    });
    expect(lifecycle.createPnpmLifecycleInvocation("/runtime/pnpm", [
      "typecheck:server",
    ], {
      platform: "linux",
      nodeExecutable,
    })).toEqual({
      command: "/runtime/pnpm",
      arguments: ["typecheck:server"],
    });

    for (const name of [
      "pnpm-helper.cjs",
      "pnpm-malicious.js",
      "pnpmx.mjs",
      "pnpx.cjs",
      "pnpm.cmd",
      "pnpm.ps1",
    ]) {
      expect(() => lifecycle.createPnpmLifecycleInvocation(`/runtime/${name}`, [
        "typecheck:server",
      ], {
        platform: "linux",
        nodeExecutable,
      })).toThrow(/unsupported/i);
    }
    expect(() => lifecycle.createPnpmLifecycleInvocation(
      "/runtime/pnpm.cjs",
      [],
      { platform: "linux", nodeExecutable },
    )).toThrow(/arguments are invalid/i);
    expect(() => lifecycle.createPnpmLifecycleInvocation(
      "/runtime/pnpm.cjs",
      [123] as unknown as string[],
      { platform: "linux", nodeExecutable },
    )).toThrow(/arguments are invalid/i);
    await expect(lifecycle.resolvePnpmLifecycleInvocation(
      { npm_execpath: "pnpm.cjs" },
      ["typecheck:server"],
    ))
      .rejects.toThrow(/absolute/i);
    await expect(lifecycle.resolvePnpmLifecycleInvocation({
      npm_execpath: join(root, "missing", "pnpm.cjs"),
    }, ["typecheck:server"])).rejects.toThrow();
    await expect(lifecycle.resolvePnpmLifecycleInvocation({
      npm_execpath: unsupportedPath,
    }, ["typecheck:server"])).rejects.toThrow(/unsupported/i);
    await expect(release.resolvePnpmInvocation({ npm_execpath: "pnpm.cjs" }))
      .rejects.toThrow(/absolute/i);
  });

  it.skipIf(process.platform !== "win32")(
    "runs release make through the validated lifecycle CLI without spawning a cmd shim",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "intentarc-release-cli-"));
      temporaryRoots.push(root);
      const cliPath = join(root, "pnpm.cjs");
      const markerPath = join(root, "invocation.json");
      await writeFile(cliPath, [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(",
        "  process.env.INTENTARC_RELEASE_TEST_MARKER,",
        "  JSON.stringify(process.argv.slice(2)),",
        ");",
      ].join("\n"));
      const release = await import(
        "../../../scripts/desktop-release.mjs"
      ) as {
        runDesktopRelease(
          environment: Record<string, string | undefined>,
        ): Promise<void>;
      };

      let releaseError: unknown;
      try {
        await release.runDesktopRelease({
          ...process.env,
          npm_execpath: cliPath,
          INTENTARC_RELEASE_TEST_MARKER: markerPath,
          INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
          INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
          INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
          INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
        });
      } catch (error) {
        releaseError = error;
      }

      expect(releaseError).not.toMatchObject({ code: "EINVAL" });
      expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual([
        "desktop:make",
      ]);
    },
    30_000,
  );

  it("explicitly disables shell execution for the release pnpm child", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-release-spawn-"));
    temporaryRoots.push(root);
    const cliPath = join(root, "pnpm.cjs");
    await writeFile(cliPath, "process.exitCode = 0;");
    const spawnCalls: Array<{
      command: string;
      arguments: readonly string[];
      options: Parameters<typeof spawn>[2];
    }> = [];
    const fakeSpawn = ((
      command: string,
      arguments_: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      spawnCalls.push({ command, arguments: arguments_, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 17, null));
      return child;
    }) as unknown as typeof spawn;
    vi.doMock("node:child_process", async () => ({
      ...await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      ),
      spawn: fakeSpawn,
    }));
    vi.resetModules();
    try {
      const release = await import(
        "../../../scripts/desktop-release.mjs"
      ) as {
        runDesktopRelease(
          environment: Record<string, string | undefined>,
        ): Promise<void>;
      };

      await expect(release.runDesktopRelease({
        npm_execpath: cliPath,
        INTENTARC_WINDOWS_CERTIFICATE: "C:\\release\\intentarc.pfx",
        INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
        INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
        INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR: "none",
      })).rejects.toThrow(/exited with code 17/i);

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.options).toMatchObject({
        shell: false,
        windowsHide: true,
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "binds Authenticode targets with spaces and distinguishes valid, unsigned, and malformed files",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "intentarc signature path with spaces-"),
      );
      temporaryRoots.push(root);
      const valid = join(root, "Valid Signed Binary.exe");
      const unsigned = join(root, "Unsigned Binary.exe");
      const malformed = join(root, "Malformed Binary.exe");
      const missing = join(root, "Missing Binary.exe");
      await copyFile(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        valid,
      );
      await copyFile(
        resolve(
          "node_modules",
          "electron-winstaller",
          "vendor",
          "Squirrel.exe",
        ),
        unsigned,
      );
      await writeFile(malformed, "not an executable");
      const release = await import(
        "../../../scripts/desktop-release.mjs"
      ) as {
        verifyAuthenticodeSignature(path: string): Promise<void>;
      };

      await expect(release.verifyAuthenticodeSignature(valid))
        .resolves.toBeUndefined();
      await expect(verifyInstalledBridgeSignature(valid))
        .resolves.toBeUndefined();
      await expect(release.verifyAuthenticodeSignature(unsigned))
        .rejects.toThrow(/NotSigned/);
      await expect(verifyInstalledBridgeSignature(unsigned))
        .rejects.toThrow(/NotSigned/);
      await expect(release.verifyAuthenticodeSignature(malformed))
        .rejects.toThrow(/UnknownError/);
      await expect(verifyInstalledBridgeSignature(malformed))
        .rejects.toThrow(/UnknownError/);
      await expect(release.verifyAuthenticodeSignature(missing))
        .rejects.toThrow(/malformed|verify/i);
      await expect(verifyInstalledBridgeSignature(missing))
        .rejects.toThrow(/malformed|verify/i);
    },
    30_000,
  );
});
