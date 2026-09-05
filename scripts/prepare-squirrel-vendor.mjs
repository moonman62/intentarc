import {
  copyFile,
  cp,
  lstat,
  rm,
} from "node:fs/promises";
import { arch as hostArchitecture } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceRoot = join(
  packageRoot,
  "node_modules",
  "electron-winstaller",
  "vendor",
);
const defaultOutputRoot = join(packageRoot, "dist", "squirrel-vendor");
const supportedArchitectures = new Set(["x64", "arm64"]);

const assertRegularFile = async (path) => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Squirrel vendor input is missing or malformed.");
  }
};

export const prepareSquirrelVendor = async ({
  sourceRoot = defaultSourceRoot,
  outputRoot = defaultOutputRoot,
  architecture = hostArchitecture(),
} = {}) => {
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`Unsupported Squirrel host architecture: ${architecture}.`);
  }
  const executable = join(sourceRoot, `7z-${architecture}.exe`);
  const library = join(sourceRoot, `7z-${architecture}.dll`);
  await assertRegularFile(executable);
  await assertRegularFile(library);

  await rm(outputRoot, { recursive: true, force: true });
  await cp(sourceRoot, outputRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
  });
  await copyFile(executable, join(outputRoot, "7z.exe"));
  await copyFile(library, join(outputRoot, "7z.dll"));
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await prepareSquirrelVendor();
}
