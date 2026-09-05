import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
  win32,
} from "node:path";
import { promisify } from "node:util";
import {
  assertWritablePreflightReceipt,
  trackedOnlyStatusScope,
} from "./desktop-release-preflight-contract.mjs";

const execFileAsync = promisify(execFile);
const maximumGitOutputBytes = 1024 * 1024;
const maximumStatusEntryCount = 1_000_000;
const ordinaryFilesError = "IntentArc preflight evidence requires ordinary files.";
const trackedPathError = "IntentArc preflight tracked path is invalid.";
const gitArgumentsError = "IntentArc preflight Git arguments are invalid.";
const gitCommandError = "IntentArc preflight Git command failed.";
const gitOutputError = "IntentArc preflight Git output is invalid.";
const gitStderrError = "IntentArc preflight Git stderr is invalid.";
const gitStatusScopeError = "IntentArc preflight Git status scope is invalid.";
const gitBindingError = "IntentArc preflight Git binding is invalid.";

const readOnlyGitArguments = Object.freeze([
  Object.freeze(["ls-files", "-z"]),
  Object.freeze(["diff", "--check"]),
  Object.freeze([
    "diff", "--exit-code", "--",
    "scripts/forge-bridge-native-signing.ts",
    "forge.config.ts",
    "scripts/bridge-support-integrity.mjs",
    "scripts/bridge-diagnostic-audit.mjs",
    "scripts/bridge-native-release.mjs",
    "scripts/desktop-release.mjs",
    "scripts/signed-artifact-bundle.mjs",
  ]),
  Object.freeze(["status", "--porcelain=v1", "-z", "--untracked-files=no"]),
]);

const gitArgumentKey = (arguments_) => arguments_.join("\0");
const readOnlyGitArgumentVectors = new Map(
  readOnlyGitArguments.map((arguments_) => [gitArgumentKey(arguments_), arguments_]),
);
const gitWarningPattern = /^(?:warning: in the working copy of '[^'\r\n]+', LF will be replaced by CRLF the next time Git touches it\r?\n)*$/;

const readBoundGit = async () => {
  const executable = process.env.INTENTARC_PREFLIGHT_GIT_EXECUTABLE;
  const expectedSha256 = process.env.INTENTARC_PREFLIGHT_GIT_SHA256;
  if (
    typeof executable !== "string" || !win32.isAbsolute(executable) ||
    win32.basename(executable).toLowerCase() !== "git.exe" ||
    typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) throw new Error(gitBindingError);
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(gitBindingError);
  const sha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  if (sha256 !== expectedSha256) throw new Error(gitBindingError);
  return Object.freeze({
    executable,
    expectedSha256,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    birthtimeMs: stat.birthtimeMs,
    mtimeMs: stat.mtimeMs,
  });
};

const sameBoundGit = async (before) => {
  const after = await readBoundGit();
  return after.executable === before.executable &&
    after.expectedSha256 === before.expectedSha256 &&
    after.dev === before.dev && after.ino === before.ino &&
    after.size === before.size && after.birthtimeMs === before.birthtimeMs &&
    after.mtimeMs === before.mtimeMs;
};

const executeGit = async (arguments_, { packageRoot }) => {
  const binding = await readBoundGit();
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
  };
  const result = await execFileAsync(
    binding.executable,
    [
      "--no-optional-locks", "-c", "core.fsmonitor=false",
      "-c", "core.quotePath=false", "-C", packageRoot,
      ...arguments_,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(environment).filter(([, value]) => typeof value === "string")),
      windowsHide: true,
      maxBuffer: maximumGitOutputBytes,
      shell: false,
    },
  );
  if (!await sameBoundGit(binding)) throw new Error(gitBindingError);
  return result;
};

const runPreflightGit = async ({
  packageRoot,
  arguments: arguments_,
  runGit = executeGit,
}) => {
  const hasStringArguments = Array.isArray(arguments_) &&
    arguments_.every((value) => typeof value === "string");
  const allowedArguments = hasStringArguments
    ? readOnlyGitArgumentVectors.get(gitArgumentKey(arguments_))
    : undefined;
  if (
    typeof packageRoot !== "string" ||
    !hasStringArguments ||
    !allowedArguments ||
    allowedArguments.length !== arguments_.length ||
    allowedArguments.some((value, index) => value !== arguments_[index])
  ) {
    throw new Error(gitArgumentsError);
  }

  let result;
  try {
    result = await runGit(Object.freeze([...arguments_]), { packageRoot });
  } catch {
    throw new Error(gitCommandError);
  }
  if (
    !result || typeof result !== "object" ||
    typeof result.stdout !== "string" || typeof result.stderr !== "string"
  ) {
    throw new Error(gitOutputError);
  }
  if (!gitWarningPattern.test(result.stderr)) throw new Error(gitStderrError);
  return result;
};

const assertRelativeLeafName = (relativeName) => {
  const segments = relativeName.split("/");
  if (
    relativeName.length === 0 ||
    relativeName.includes("\\") ||
    isAbsolute(relativeName) || posix.isAbsolute(relativeName) || win32.isAbsolute(relativeName) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(trackedPathError);
  }
};

const assertOrdinaryParentDirectories = async (root, relativeName) => {
  const segments = relativeName.split("/");
  let absoluteDirectory = root;
  for (const segment of segments.slice(0, -1)) {
    absoluteDirectory = join(absoluteDirectory, segment);
    const metadata = await lstat(absoluteDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(ordinaryFilesError);
    }
  }
};

const updateLeaf = async (hash, root, relativeName) => {
  await assertOrdinaryParentDirectories(root, relativeName);
  const absolutePath = join(root, ...relativeName.split("/"));
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(ordinaryFilesError);
  }
  const nameBytes = Buffer.from(relativeName, "utf8");
  hash.update(`${nameBytes.length}\0`);
  hash.update(nameBytes);
  hash.update(`\0${metadata.size}\0`);
  hash.update(await readFile(absolutePath));
  return metadata.size;
};

const identityForLeaves = async (root, relativeNames) => {
  const sortedNames = [...relativeNames].sort();
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const relativeName of sortedNames) {
    totalBytes += await updateLeaf(hash, root, relativeName);
  }
  return {
    fileCount: sortedNames.length,
    totalBytes,
    sha256: hash.digest("hex"),
  };
};

const trackedLeafNames = (stdout) => {
  if (stdout === "") return [];
  if (!stdout.endsWith("\0")) throw new Error(gitOutputError);
  const names = stdout.slice(0, -1).split("\0");
  for (const name of names) assertRelativeLeafName(name);
  if (new Set(names).size !== names.length) throw new Error(gitOutputError);
  return names;
};

const collectOrdinaryLeaves = async (root) => {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(ordinaryFilesError);
  }
  const leaves = [];
  const visit = async (absoluteDirectory, relativeDirectory = "") => {
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      const relativeName = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = join(absoluteDirectory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error(ordinaryFilesError);
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativeName);
      } else if (metadata.isFile()) {
        leaves.push(relativeName);
      } else {
        throw new Error(ordinaryFilesError);
      }
    }
  };
  await visit(root);
  return leaves;
};

const hashOrdinaryFile = async (path) => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(ordinaryFilesError);
  }
  return createHash("sha256").update(await readFile(path)).digest("hex");
};

export const createPreflightSnapshot = async ({ packageRoot, runGit } = {}) => {
  const tracked = await runPreflightGit({
    packageRoot,
    arguments: readOnlyGitArguments[0],
    runGit,
  });
  const source = await identityForLeaves(packageRoot, trackedLeafNames(tracked.stdout));
  const packageJsonSha256 = await hashOrdinaryFile(join(packageRoot, "package.json"));
  const vendorRoot = resolve(packageRoot, "dist", "squirrel-vendor");
  let vendorLeaves;
  try {
    vendorLeaves = await collectOrdinaryLeaves(vendorRoot);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.code !== "ENOENT" ||
      error.path !== vendorRoot
    ) {
      throw error;
    }
    vendorLeaves = [];
  }
  const vendor = await identityForLeaves(
    vendorRoot,
    vendorLeaves,
  );
  return {
    source,
    packageJsonSha256,
    vendor,
    outAbsent: existsSync(join(packageRoot, "out")) === false,
  };
};

const countStatusEntries = (stdout) => {
  if (stdout === "") return 0;
  if (!stdout.endsWith("\0")) throw new Error(gitOutputError);
  const fields = stdout.slice(0, -1).split("\0");
  let count = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") throw new Error(gitOutputError);
    count += 1;
    if (count > maximumStatusEntryCount) throw new Error(gitOutputError);
    if (/[RC]/.test(record.slice(0, 2))) {
      index += 1;
      if (index >= fields.length || fields[index].length === 0) {
        throw new Error(gitOutputError);
      }
    }
  }
  return count;
};

export const runReadOnlyGitGates = async ({ packageRoot, statusScope, runGit } = {}) => {
  if (statusScope !== trackedOnlyStatusScope) {
    throw new Error(gitStatusScopeError);
  }
  await runPreflightGit({
    packageRoot,
    arguments: readOnlyGitArguments[1],
    runGit,
  });
  await runPreflightGit({
    packageRoot,
    arguments: readOnlyGitArguments[2],
    runGit,
  });
  const status = await runPreflightGit({
    packageRoot,
    arguments: readOnlyGitArguments[3],
    runGit,
  });
  const statusEntryCount = countStatusEntries(status.stdout);
  return {
    diffCheckPassed: true,
    productDiffClean: true,
    statusClean: statusEntryCount === 0,
    statusEntryCount,
  };
};

const gitGatewayTestSymbol = Symbol.for(
  "intentarc.desktop-release-preflight.git-gateway-test",
);
Object.defineProperty(runReadOnlyGitGates, gitGatewayTestSymbol, {
  value: async (options) => {
    await runPreflightGit(options);
  },
  enumerable: false,
  writable: false,
  configurable: false,
});

export const writePreflightReceipt = async (receiptPath, receipt) => {
  assertWritablePreflightReceipt(receipt);
  const parent = dirname(receiptPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = join(
    parent,
    `.${basename(receiptPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, receiptPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};
