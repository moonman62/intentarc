import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeNativeSigningAdapter } from
  "./scripts/forge-bridge-native-signing.js";
import { createDesktopRuntimeManifest } from "./scripts/desktop-runtime-manifest.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const squirrelVendorDirectory = join(
  packageRoot,
  "dist",
  "squirrel-vendor",
);
const runtimeManifest = createDesktopRuntimeManifest(packageRoot);
const runtimePackageDirectories = runtimeManifest.packages.map(
  ({ packageDirectory }: { packageDirectory: string }) =>
    packageDirectory.replaceAll("\\", "/"),
);
const betterSqlitePrebuildRoot =
  "node_modules/better-sqlite3/prebuilds";
const targetBetterSqlitePrebuild =
  `${betterSqlitePrebuildRoot}/win32-x64.node`;
const runtimeDistRoots = [
  "dist/app",
  "dist/context",
  "dist/core",
  "dist/desktop",
  "dist/domain",
  "dist/durability",
  "dist/import",
  "dist/outbound",
  "dist/repository",
  "dist/storage",
  "dist/system",
  "dist/web-client",
  "dist/web/contracts.js",
  "dist/web/server",
] as const;
const runtimeDistExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);
const excludedDependencyArtifact = (
  child: string,
): boolean =>
  /(?:^|\/)(?:__tests__|benchmarks?|coverage|examples?|source|src|tests?|testing)(?:\/|$)/i
    .test(child) ||
  /\.(?:cts|d\.ts|map|mts|ts|tsx)$/i.test(child);

const withinOrAncestorOf = (
  child: string,
  root: string,
): boolean =>
  child === root ||
  child.startsWith(`${root}/`) ||
  root.startsWith(`${child}/`);

const allowedDistPath = (child: string): boolean => {
  const runtimeRoot = runtimeDistRoots.find((root) =>
    withinOrAncestorOf(child, root)
  );
  if (!runtimeRoot) return false;
  if (
    child === "dist" ||
    runtimeRoot.startsWith(`${child}/`) ||
    child === runtimeRoot && extname(child) === "" ||
    existsSync(join(packageRoot, child)) &&
      statSync(join(packageRoot, child)).isDirectory()
  ) {
    return true;
  }
  return runtimeDistExtensions.has(extname(child).toLowerCase());
};

const allowedRuntimePackagePath = (child: string): boolean => {
  if (
    child === betterSqlitePrebuildRoot ||
    child.startsWith(`${betterSqlitePrebuildRoot}/`)
  ) {
    return withinOrAncestorOf(child, targetBetterSqlitePrebuild);
  }
  const runtimePackage = runtimePackageDirectories.find((root) =>
    withinOrAncestorOf(child, root)
  );
  if (!runtimePackage) return false;
  if (
    child === "node_modules" ||
    runtimePackage.startsWith(`${child}/`) ||
    child === runtimePackage
  ) {
    return true;
  }
  return !excludedDependencyArtifact(
    child.slice(runtimePackage.length + 1),
  );
};

export const desktopPackageIgnore = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const child = /^[A-Za-z]:\//.test(normalized)
    ? relative(packageRoot, path).replaceAll("\\", "/")
    : normalized.replace(/^\/+/, "");
  if (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith("../"))
  ) {
    if (child === "" || child === "package.json") return false;
    if (child === "dist" || child.startsWith("dist/")) {
      return !allowedDistPath(child);
    }
    if (child === "node_modules" || child.startsWith("node_modules/")) {
      return !allowedRuntimePackagePath(child);
    }
  }
  return true;
};

export const createForgeConfig = (
  environment: Partial<Record<string, string | undefined>>,
): ForgeConfig => {
  const releaseBuild = environment.INTENTARC_RELEASE_BUILD === "1";
  const certificateFile = environment.INTENTARC_WINDOWS_CERTIFICATE?.trim();
  const certificatePassword =
    environment.INTENTARC_WINDOWS_CERTIFICATE_PASSWORD;
  const configuredCertificateThumbprint =
    environment.INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
  const configuredSignToolPath = environment.WINDOWS_SIGNTOOL_PATH?.trim();

  if (releaseBuild && (!certificateFile || !certificatePassword)) {
    throw new Error(
      "Release signing requires INTENTARC_WINDOWS_CERTIFICATE and INTENTARC_WINDOWS_CERTIFICATE_PASSWORD.",
    );
  }

  if (
    releaseBuild &&
    !/^[0-9a-f]{40}$/i.test(configuredCertificateThumbprint ?? "")
  ) {
    throw new Error(
      "Release signing requires an exact 40-hex SHA-1 certificate thumbprint.",
    );
  }
  const certificateThumbprint = configuredCertificateThumbprint
    ?.toUpperCase();

  let signToolPath: string | undefined;
  if (releaseBuild && configuredSignToolPath) {
    if (!isAbsolute(configuredSignToolPath)) {
      throw new Error("Release SignTool path must be absolute.");
    }
    try {
      signToolPath = realpathSync(configuredSignToolPath);
      if (!statSync(signToolPath).isFile()) {
        throw new Error("not a regular file");
      }
    } catch {
      throw new Error("Release SignTool path must resolve to a file.");
    }
  }

  const signingAdapter = releaseBuild
    ? createBridgeNativeSigningAdapter({ packageRoot, environment })
    : undefined;

  return {
    packagerConfig: {
      asar: true,
      executableName: "IntentArc",
      platform: "win32",
      arch: "x64",
      ignore: desktopPackageIgnore,
      extraResource: ["dist/bridge", "dist/desktop-resources"],
      ...(signingAdapter
        ? {
            windowsSign: signingAdapter.windowsSign,
          }
        : {}),
    },
    makers: [
      new MakerSquirrel(
        {
          name: "IntentArc",
          setupExe: "IntentArc Setup.exe",
          vendorDirectory: squirrelVendorDirectory,
          ...(releaseBuild
            ? {
                signWithParams:
                  `/a /sha1 ${certificateThumbprint!} /fd sha256`,
              }
            : {}),
        },
        ["win32"],
      ),
    ],
    plugins: [
      new AutoUnpackNativesPlugin({}),
      new FusesPlugin({
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      }),
    ],
    ...(signingAdapter
      ? {
          hooks: {
            postPackage: signingAdapter.postPackage,
            postMake: signingAdapter.postMake,
          },
        }
      : {}),
  };
};

const config = createForgeConfig(process.env);

export default config;
