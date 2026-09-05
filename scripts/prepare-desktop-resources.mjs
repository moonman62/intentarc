import {
  copyFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopRuntimeManifest } from "./desktop-runtime-manifest.mjs";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const prepareDesktopResources = async ({
  packageRoot = defaultPackageRoot,
  outputRoot = join(packageRoot, "dist", "desktop-resources"),
  environment = process.env,
} = {}) => {
  const runtimeManifest = createDesktopRuntimeManifest(packageRoot);
  const dependencies = runtimeManifest.packages;

  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    join(outputRoot, "desktop-runtime-manifest.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outputRoot, "intentarc-release.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      requireSignatures: environment.INTENTARC_RELEASE_BUILD === "1",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outputRoot, "THIRD-PARTY-NOTICES.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      dependencies,
    }, null, 2)}\n`,
    "utf8",
  );
  await copyFile(
    join(packageRoot, "docs", "desktop-application.md"),
    join(outputRoot, "desktop-application.md"),
  );
  await copyFile(
    join(packageRoot, "README.md"),
    join(outputRoot, "README.md"),
  );
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await prepareDesktopResources();
}
