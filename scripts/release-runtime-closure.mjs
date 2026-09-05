import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

const schema = "intentarc.release-runtime-closure/v1";
const maximumEntries = 250_000;
const maximumBytes = 8_589_934_592;
const utf8 = new TextEncoder();

const fail = () => {
  throw new Error("runtime-closure-invalid");
};

const classifyAbsoluteTarget = (
  target,
  platformFlavor = process.platform === "win32" ? "win32" : "posix",
) => {
  const posixAbsolute = posix.isAbsolute(target);
  const windowsAbsolute = win32.isAbsolute(target);
  if (platformFlavor === "win32") {
    if (posixAbsolute) return "foreign";
    return windowsAbsolute ? "native" : "relative";
  }
  if (platformFlavor === "posix") {
    if (posixAbsolute) return "native";
    return windowsAbsolute ? "foreign" : "relative";
  }
  fail();
};

const isContained = (root, candidate) => {
  const value = relative(root, candidate);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
};

const relativeRecordPath = (root, candidate) => relative(root, candidate).split(sep).join("/");

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino &&
  left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const sha256File = (
  path,
  expectedBytes,
  remainingBytes,
  openStream = createReadStream,
) => new Promise((resolveHash, rejectHash) => {
  const algorithm = createHash("sha256");
  const stream = openStream(path);
  let bytes = 0;
  let settled = false;
  const rejectInvalid = () => {
    if (settled) return;
    settled = true;
    const error = new Error("runtime-closure-invalid");
    try {
      stream.destroy(error);
    } catch {
      // The closed error below remains authoritative even if an injected
      // stream's destroy implementation itself fails.
    }
    rejectHash(error);
  };
  stream.on("data", (chunk) => {
    if (settled) return;
    const chunkBytes = chunk.length;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0 ||
        chunkBytes > expectedBytes - bytes || chunkBytes > remainingBytes - bytes) {
      rejectInvalid();
      return;
    }
    bytes += chunk.length;
    algorithm.update(chunk);
  });
  stream.on("error", rejectInvalid);
  stream.on("end", () => {
    if (settled) return;
    if (bytes !== expectedBytes) {
      rejectInvalid();
      return;
    }
    settled = true;
    resolveHash({ sha256: algorithm.digest("hex"), bytes });
  });
});

const requireOrdinaryDirectory = async (path, stat) => {
  const info = await stat(path).catch(fail);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
};

const digestClosure = async (repositoryRoot, {
  lstat: stat = lstat,
  readdir: readDirectory = readdir,
  readlink: readLink = readlink,
  realpath: resolveRealpath = realpath,
  createReadStream: openStream = createReadStream,
  maximumEntries: entryLimit = maximumEntries,
  maximumBytes: byteLimit = maximumBytes,
} = {}) => {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) fail();
  if (!Number.isSafeInteger(entryLimit) || entryLimit < 0 || !Number.isSafeInteger(byteLimit) || byteLimit < 0) fail();
  const repository = resolve(repositoryRoot);
  await requireOrdinaryDirectory(repository, stat);
  const modules = resolve(repository, "node_modules");
  if (!isContained(repository, modules) || basename(modules) !== "node_modules") fail();
  await requireOrdinaryDirectory(modules, stat);
  const realModules = await resolveRealpath(modules).catch(fail);
  const records = [];
  const normalizedPaths = new Set();
  let entries = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const hashOrdinaryFile = async (path, before) => {
    const remainingBytes = byteLimit - totalBytes;
    const first = await sha256File(path, before.size, remainingBytes, openStream).catch(fail);
    const middle = await stat(path).catch(fail);
    if (!middle.isFile() || middle.isSymbolicLink() || !sameIdentity(before, middle) || first.bytes !== before.size) fail();
    const second = await sha256File(path, before.size, remainingBytes, openStream).catch(fail);
    const after = await stat(path).catch(fail);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(before, after) || second.bytes !== before.size || first.sha256 !== second.sha256) fail();
    return first.sha256;
  };

  const visit = async (directory) => {
    const beforeDirectory = await stat(directory).catch(fail);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) fail();
    const children = await readDirectory(directory, { withFileTypes: true }).catch(fail);
    const afterDirectory = await stat(directory).catch(fail);
    if (!afterDirectory.isDirectory() || afterDirectory.isSymbolicLink() || !sameIdentity(beforeDirectory, afterDirectory)) fail();
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (++entries > entryLimit) fail();
      const path = resolve(directory, child.name);
      if (!isContained(modules, path)) fail();
      const recordPath = relativeRecordPath(modules, path);
      if (normalizedPaths.has(recordPath)) fail();
      normalizedPaths.add(recordPath);
      const info = await stat(path).catch(fail);
      if (info.isSymbolicLink()) {
        const target = await readLink(path).catch(fail);
        if (target.length === 0) fail();
        const targetClass = classifyAbsoluteTarget(target);
        if (targetClass === "foreign") fail();
        const candidate = targetClass === "native" ? resolve(target) : resolve(directory, target);
        if (!isContained(modules, candidate)) fail();
        const resolvedTarget = await resolveRealpath(candidate).catch(fail);
        if (!isContained(realModules, resolvedTarget)) fail();
        const targetInfo = await stat(resolvedTarget).catch(fail);
        if (targetInfo.isSymbolicLink() || (!targetInfo.isFile() && !targetInfo.isDirectory())) fail();
        records.push(`link\0${recordPath}\0${relativeRecordPath(repository, candidate)}\n`);
        continue;
      }
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile()) fail();
      if (!Number.isSafeInteger(info.size) || info.size < 0 || totalBytes + info.size > byteLimit) fail();
      const fileHash = await hashOrdinaryFile(path, info);
      totalBytes += info.size;
      fileCount++;
      records.push(`file\0${recordPath}\0${info.size}\0${fileHash}\n`);
    }
  };

  await visit(modules);
  records.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const algorithm = createHash("sha256");
  for (const record of records) algorithm.update(utf8.encode(record));
  return { schema, sha256: algorithm.digest("hex"), fileCount, totalBytes };
};

const parseArguments = (argumentsVector) => {
  if (argumentsVector.length !== 3 || argumentsVector[0] !== "--repository-root" || argumentsVector[2] !== "--json") fail();
  return argumentsVector[1];
};

const main = async () => {
  try {
    const result = await digestClosure(parseArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stderr.write("runtime-closure-invalid\n");
    process.exitCode = 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { classifyAbsoluteTarget, digestClosure };
