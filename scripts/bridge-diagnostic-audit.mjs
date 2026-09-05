import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, basename, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const bridgeDiagnosticTokens = Object.freeze([
  "identity", "predecessor", "identity", "predecessor", "identity",
]);
const auditLeaf = "bridge-diagnostics.tokens";
const maximumAuditBytes = 128;
const auditFailure = () =>
  new Error("IntentArc bridge diagnostic audit failed.");
const driftFailure = () =>
  new Error("IntentArc bridge diagnostic executable changed.");

const executableLeaf = "IntentArc Bridge.exe";
const executableStateFields = Object.freeze([
  "dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink",
]);

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const sameState = (left, right) =>
  executableStateFields.every((field) => left[field] === right[field]);

const isContained = (root, candidate) => {
  const nested = relative(root, candidate);
  return nested !== "" && nested !== ".." &&
    !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
};

const requireAbsoluteCanonicalDirectory = async (path, failure) => {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw failure();
  }
  const requested = await lstat(path);
  if (requested.isSymbolicLink() || !requested.isDirectory()) throw failure();
  const canonical = await realpath(path);
  if (canonical !== path) throw failure();
  const opened = await lstat(canonical);
  if (opened.isSymbolicLink() || !opened.isDirectory() ||
      !sameIdentity(requested, opened)) throw failure();
  return { canonical, identity: opened };
};

const captureState = (information) => Object.freeze({
  dev: information.dev,
  ino: information.ino,
  size: information.size,
  mtimeMs: information.mtimeMs,
  ctimeMs: information.ctimeMs,
  nlink: information.nlink,
});

const proveExecutable = async ({ executablePath, ownerRoot }, failure) => {
  let handle;
  try {
    const owner = await requireAbsoluteCanonicalDirectory(ownerRoot, failure);
    if (typeof executablePath !== "string" || !isAbsolute(executablePath) ||
        resolve(executablePath) !== executablePath ||
        basename(executablePath) !== executableLeaf) throw failure();

    const requested = await lstat(executablePath);
    if (requested.isSymbolicLink() || !requested.isFile() ||
        requested.nlink !== 1) throw failure();
    const canonicalExecutable = await realpath(executablePath);
    if (canonicalExecutable !== executablePath ||
        !isContained(owner.canonical, canonicalExecutable)) throw failure();
    const canonicalInformation = await lstat(canonicalExecutable);
    if (canonicalInformation.isSymbolicLink() ||
        !canonicalInformation.isFile() || canonicalInformation.nlink !== 1 ||
        !sameState(requested, canonicalInformation)) throw failure();

    handle = await open(
      executablePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 ||
        !sameState(canonicalInformation, before)) throw failure();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || !sameState(before, after)) {
      throw failure();
    }
    const finalRequested = await lstat(executablePath);
    const finalCanonical = await realpath(executablePath);
    if (finalCanonical !== canonicalExecutable ||
        finalRequested.isSymbolicLink() || !finalRequested.isFile() ||
        finalRequested.nlink !== 1 || !sameState(after, finalRequested)) {
      throw failure();
    }
    const finalOwner = await lstat(ownerRoot);
    if (finalOwner.isSymbolicLink() || !finalOwner.isDirectory() ||
        !sameIdentity(owner.identity, finalOwner) ||
        await realpath(ownerRoot) !== owner.canonical) throw failure();

    return Object.freeze({
      executablePath: canonicalExecutable,
      ownerRoot: owner.canonical,
      state: captureState(after),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    if (error?.message === failure().message) throw error;
    throw failure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const parseAudit = (bytes) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw auditFailure();
  }
  if (Buffer.byteLength(text, "utf8") !== bytes.length) throw auditFailure();
  if (text === "") return [];
  if (!text.endsWith("\n")) throw auditFailure();
  const tokens = text.slice(0, -1).split("\n");
  if (tokens.length > bridgeDiagnosticTokens.length ||
      tokens.some((token, index) => token !== bridgeDiagnosticTokens[index])) {
    throw auditFailure();
  }
  return tokens;
};

const requireAuditLocation = async ({ auditRoot, auditPath }) => {
  const root = await requireAbsoluteCanonicalDirectory(auditRoot, auditFailure);
  const expectedPath = join(root.canonical, auditLeaf);
  if (typeof auditPath !== "string" || !isAbsolute(auditPath) ||
      resolve(auditPath) !== auditPath || auditPath !== expectedPath ||
      !isContained(root.canonical, auditPath)) throw auditFailure();
  return { root, auditPath };
};

const validateOpenedAudit = async (location, handle, previous) => {
  try {
    const opened = await handle.stat();
    const requested = await lstat(location.auditPath);
    const canonical = await realpath(location.auditPath);
    if (!opened.isFile() || opened.nlink !== 1 ||
        requested.isSymbolicLink() || !requested.isFile() ||
        requested.nlink !== 1 || canonical !== location.auditPath ||
        !sameState(opened, requested) ||
        (previous !== undefined && !sameState(previous, opened))) {
      throw auditFailure();
    }
    return { handle, opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error?.message === auditFailure().message) throw error;
    throw auditFailure();
  }
};

const openExistingAudit = async (location, flags) => {
  const previous = await lstat(location.auditPath);
  if (previous.isSymbolicLink() || !previous.isFile() ||
      previous.nlink !== 1) throw auditFailure();
  const handle = await open(
    location.auditPath,
    flags | (constants.O_NOFOLLOW ?? 0),
  );
  return validateOpenedAudit(location, handle, previous);
};

const openAudit = async (location, flags) => {
  if (!(flags & constants.O_CREAT)) {
    return openExistingAudit(location, flags);
  }
  let handle;
  try {
    handle = await open(
      location.auditPath,
      flags | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return openExistingAudit(
      location,
      flags & ~constants.O_CREAT & ~constants.O_EXCL,
    );
  }
  return validateOpenedAudit(location, handle, undefined);
};

const verifyAuditHandle = async (location, handle, expectedState) => {
  const handleState = await handle.stat();
  const requested = await lstat(location.auditPath);
  if (!handleState.isFile() || handleState.nlink !== 1 ||
      requested.isSymbolicLink() || !requested.isFile() ||
      requested.nlink !== 1 || !sameState(handleState, requested) ||
      (expectedState !== undefined && !sameState(expectedState, handleState)) ||
      await realpath(location.auditPath) !== location.auditPath) {
    throw auditFailure();
  }
  const rootAfter = await lstat(location.root.canonical);
  if (rootAfter.isSymbolicLink() || !rootAfter.isDirectory() ||
      !sameIdentity(location.root.identity, rootAfter) ||
      await realpath(location.root.canonical) !== location.root.canonical) {
    throw auditFailure();
  }
  return handleState;
};

export const recordBridgeDiagnostic = async (input) => {
  let handle;
  try {
    const proof = await proveExecutable(input, auditFailure);
    if (!bridgeDiagnosticTokens.includes(input.token)) throw auditFailure();
    const hasRoot = input.auditRoot !== undefined;
    const hasPath = input.auditPath !== undefined;
    if (!hasRoot && !hasPath) return proof;
    if (!hasRoot || !hasPath) throw auditFailure();
    const location = await requireAuditLocation(input);
    const opened = await openAudit(
      location,
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND,
    );
    handle = opened.handle;
    if (opened.opened.size > maximumAuditBytes) throw auditFailure();
    const bytes = await handle.readFile();
    if (bytes.length !== opened.opened.size || bytes.length > maximumAuditBytes) {
      throw auditFailure();
    }
    await verifyAuditHandle(location, handle, opened.opened);
    const tokens = parseAudit(bytes);
    if (tokens.length >= bridgeDiagnosticTokens.length ||
        input.token !== bridgeDiagnosticTokens[tokens.length]) {
      throw auditFailure();
    }
    const appended = Buffer.from(`${input.token}\n`, "utf8");
    const expectedSize = bytes.length + appended.length;
    if (expectedSize > maximumAuditBytes) throw auditFailure();
    const result = await handle.write(appended, 0, appended.length, null);
    if (result.bytesWritten !== appended.length) throw auditFailure();
    await handle.sync();
    const finalState = await verifyAuditHandle(location, handle);
    if (finalState.size !== expectedSize || finalState.nlink !== 1 ||
        !sameIdentity(opened.opened, finalState)) throw auditFailure();
    const resultingBytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < resultingBytes.length) {
      const result = await handle.read(
        resultingBytes,
        offset,
        resultingBytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) throw auditFailure();
      offset += result.bytesRead;
    }
    await verifyAuditHandle(location, handle, finalState);
    const expectedBytes = Buffer.concat([bytes, appended]);
    if (!resultingBytes.equals(expectedBytes)) throw auditFailure();
    parseAudit(resultingBytes);
    return proof;
  } catch {
    throw auditFailure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const readBridgeDiagnosticAudit = async (input) => {
  let handle;
  try {
    const location = await requireAuditLocation(input);
    const opened = await openAudit(location, constants.O_RDONLY);
    handle = opened.handle;
    if (opened.opened.size > maximumAuditBytes) throw auditFailure();
    const bytes = await handle.readFile();
    if (bytes.length !== opened.opened.size || bytes.length > maximumAuditBytes) {
      throw auditFailure();
    }
    await verifyAuditHandle(location, handle, opened.opened);
    return parseAudit(bytes);
  } catch {
    throw auditFailure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const recheckBridgeDiagnosticExecutable = async (proof) => {
  try {
    if (proof === null || typeof proof !== "object" ||
        Object.keys(proof).length !== 4 ||
        proof.state === null || typeof proof.state !== "object" ||
        Object.keys(proof.state).length !== executableStateFields.length) {
      throw driftFailure();
    }
    const current = await proveExecutable({
      executablePath: proof.executablePath,
      ownerRoot: proof.ownerRoot,
    }, driftFailure);
    if (current.executablePath !== proof.executablePath ||
        current.ownerRoot !== proof.ownerRoot || current.sha256 !== proof.sha256 ||
        !sameState(current.state, proof.state)) throw driftFailure();
  } catch {
    throw driftFailure();
  }
};
