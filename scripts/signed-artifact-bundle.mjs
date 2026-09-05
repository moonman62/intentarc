import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";
import { bridgeDiagnosticTokens, readBridgeDiagnosticAudit } from "./bridge-diagnostic-audit.mjs";
import { verifyBridgeNativeArtifacts } from "./bridge-native-release.mjs";
import { verifyReleaseExecutables } from "./desktop-release.mjs";
import { openSignedArtifactSession } from "./signed-artifact-bundle-coordinator.mjs";

const manifestKeys = ["bundleId", "files", "publisher", "schemaVersion", "source", "verification"];
const publisherInputKeys = ["bytes", "expectedSha256", "expectedSubject", "expectedThumbprint"];
const sourceKeys = ["commit", "packageVersion", "verifierSha256"];
const publisherKeys = ["cerSha256", "subject", "thumbprint"];
const fileKeys = ["bytes", "path", "sha256"];
const verificationKeys = ["bridgeNative", "bundleClosure", "releaseExecutables"];
const allowedSquirrelExtensions = new Set([".exe", ".nupkg"]);
const MAX_FILE_ROWS = 64;
const MAX_AGGREGATE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PUBLISHER_BYTES = 64 * 1024;

const manifestError = () => new Error("IntentArc signed artifact manifest is invalid.");
const publisherError = () => new Error("IntentArc signed artifact publisher is invalid.");
const resultError = () => new Error("IntentArc signed artifact result is invalid.");
const commandError = () => new Error("IntentArc signed artifact command is invalid.");
const sessionError = () => new Error("IntentArc signed artifact session failed.");
const sessionCleanupError = () => new Error("IntentArc signed artifact session and cleanup failed.");
const verificationError = (category) => new Error(`IntentArc signed artifact verification failed: ${category}.`);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);

const hasExactKeys = (value, expected) => {
  if (!isObject(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
};

const hasDenseArrayShape = (value) => {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor?.enumerable !== false || !Object.hasOwn(lengthDescriptor, "value")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
};

const isNfcText = (value, maximum = 512) => typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && value === value.normalize("NFC")
  && !/[\u0000-\u001f\u007f]/.test(value);
const isSubject = (value) => typeof value === "string"
  && value.length > 0
  && value.length <= 512
  && value === value.normalize("NFC")
  && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);

const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isThumbprint = (value) => typeof value === "string" && /^[0-9A-F]{40}$/.test(value);
const isCommit = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isPackageVersion = (value) => typeof value === "string"
  && value.length <= 128
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
const isBundleId = (value) => typeof value === "string"
  && value.length <= 128
  && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

const isSafePath = (value) => {
  if (!isNfcText(value, 1024) || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const squirrelDirectory = "out/make/squirrel.windows/x64/";
const setupPath = `${squirrelDirectory}IntentArc Setup.exe`;
const releasesPath = `${squirrelDirectory}RELEASES`;
const allowedPayloadDirectories = [
  "dist/bridge/",
  "out/IntentArc-win32-x64/",
  squirrelDirectory,
];

const isAllowedPayloadPath = (value) =>
  allowedPayloadDirectories.filter((directory) => value.startsWith(directory)).length === 1;

const validateSquirrelPolicy = (files) => {
  const squirrelFiles = files.filter((file) => file.path.startsWith(squirrelDirectory));
  const setupFiles = squirrelFiles.filter((file) => file.path === setupPath);
  const setupLikeFiles = squirrelFiles.filter((file) => /^out\/make\/squirrel\.windows\/x64\/[^/]+ Setup\.exe$/.test(file.path));
  const releaseFiles = squirrelFiles.filter((file) => file.path === releasesPath);
  const fullPackages = squirrelFiles.filter((file) => /^out\/make\/squirrel\.windows\/x64\/[^/]+-full\.nupkg$/.test(file.path));
  if (setupFiles.length !== 1 || setupLikeFiles.length !== 1 || releaseFiles.length !== 1 || fullPackages.length !== 1) return false;

  return squirrelFiles.every((file) => {
    if (file.path === releasesPath || file.path === setupPath || fullPackages.includes(file)) return true;
    const extension = file.path.slice(file.path.lastIndexOf("."));
    return !file.path.slice(squirrelDirectory.length).includes("/") && allowedSquirrelExtensions.has(extension);
  });
};

const validatePublisherShape = (publisher) => hasExactKeys(publisher, publisherKeys)
  && isSha256(publisher.cerSha256)
  && isSubject(publisher.subject)
  && isThumbprint(publisher.thumbprint);

export const validateSignedArtifactManifest = (document) => {
  try {
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_MANIFEST_BYTES) throw manifestError();
    if (!hasExactKeys(document, manifestKeys) || document.schemaVersion !== 1 || !isBundleId(document.bundleId)) throw manifestError();
    if (!hasExactKeys(document.source, sourceKeys)
      || !isCommit(document.source.commit)
      || !isSha256(document.source.verifierSha256)
      || !isPackageVersion(document.source.packageVersion)) throw manifestError();
    if (!validatePublisherShape(document.publisher)) throw manifestError();
    if (!hasExactKeys(document.verification, verificationKeys)
      || document.verification.releaseExecutables !== true
      || document.verification.bridgeNative !== true
      || document.verification.bundleClosure !== true) throw manifestError();
    if (!hasDenseArrayShape(document.files) || document.files.length === 0 || document.files.length > MAX_FILE_ROWS) throw manifestError();

    let totalBytes = 0;
    let previousPath = "";
    for (const file of document.files) {
      if (!hasExactKeys(file, fileKeys)
        || !isSafePath(file.path)
        || !isAllowedPayloadPath(file.path)
        || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0
        || !isSha256(file.sha256)
        || file.path === "bundle.json"
        || file.path === "publisher.cer"
        || file.path.endsWith("/bundle.json")
        || file.path.endsWith("/publisher.cer")
        || (previousPath !== "" && previousPath >= file.path)) throw manifestError();
      totalBytes += file.bytes;
      if (totalBytes > MAX_AGGREGATE_BYTES) throw manifestError();
      previousPath = file.path;
    }
    if (!validateSquirrelPolicy(document.files)) throw manifestError();
    return document;
  } catch {
    throw manifestError();
  }
};

export const validatePublisherBytes = (input) => {
  try {
    if (!hasExactKeys(input, publisherInputKeys)) throw publisherError();
    const { bytes, expectedSha256, expectedSubject, expectedThumbprint } = input;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PUBLISHER_BYTES
      || !isSha256(expectedSha256) || !isSubject(expectedSubject) || !isThumbprint(expectedThumbprint)) throw publisherError();
    const certificate = new X509Certificate(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const subject = certificate.subject.normalize("NFC");
    const thumbprint = certificate.fingerprint.replaceAll(":", "");
    if (sha256 !== expectedSha256 || subject !== expectedSubject || thumbprint !== expectedThumbprint) throw publisherError();
  } catch {
    throw publisherError();
  }
};

const resultKeys = [
  "bridgeDiagnosticInvocationCount",
  "bridgeNativeVerified",
  "bundleClosureVerified",
  "bundleId",
  "fileCount",
  "packageVersion",
  "publisher",
  "releaseExecutablesVerified",
  "schemaVersion",
  "sourceCommit",
  "totalBytes",
  "verifierSha256",
];

export const validateSignedArtifactResult = (document) => {
  try {
    if (!hasExactKeys(document, resultKeys)
      || document.schemaVersion !== 1
      || !Number.isSafeInteger(document.bridgeDiagnosticInvocationCount)
      || ![0, 5].includes(document.bridgeDiagnosticInvocationCount)
      || !isBundleId(document.bundleId)
      || !isCommit(document.sourceCommit)
      || !isSha256(document.verifierSha256)
      || !isPackageVersion(document.packageVersion)
      || !Number.isSafeInteger(document.fileCount)
      || document.fileCount < 1
      || document.fileCount > MAX_FILE_ROWS
      || !Number.isSafeInteger(document.totalBytes)
      || document.totalBytes < 0
      || document.totalBytes > MAX_AGGREGATE_BYTES
      || !validatePublisherShape(document.publisher)
      || document.releaseExecutablesVerified !== true
      || document.bridgeNativeVerified !== true
      || document.bundleClosureVerified !== true) throw resultError();
    return document;
  } catch {
    throw resultError();
  }
};

export const parseSignedArtifactArguments = (argumentsList) => {
  try {
    if (!hasDenseArrayShape(argumentsList)) throw commandError();
    if (argumentsList.length === 3
      && argumentsList[0] === "validate-manifest"
      && argumentsList[1] === "--document"
      && typeof argumentsList[2] === "string"
      && isAbsolute(argumentsList[2])) {
      return { command: "validate-manifest", documentPath: argumentsList[2] };
    }
    if (argumentsList.length === 5
      && argumentsList[0] === "verify"
      && argumentsList[1] === "--bundle"
      && typeof argumentsList[2] === "string"
      && isAbsolute(argumentsList[2])
      && argumentsList[3] === "--expected-thumbprint"
      && isThumbprint(argumentsList[4])) {
      return { bundleRoot: argumentsList[2], command: "verify", expectedPublisherThumbprint: argumentsList[4] };
    }
    throw commandError();
  } catch {
    throw commandError();
  }
};

const isCoordinatorRow = (row) => hasExactKeys(row, fileKeys)
  && isSafePath(row.path)
  && Number.isSafeInteger(row.bytes)
  && row.bytes >= 0
  && isSha256(row.sha256);

export const openSignedArtifactBundle = async (input) => {
  let session;
  try {
    if (!hasExactKeys(input, ["bundleRoot"]) || typeof input.bundleRoot !== "string") throw sessionError();
    const { bundleRoot } = input;
    session = await openSignedArtifactSession({ bundleRoot });
    const manifestBytes = await session.readManifest();
    if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > MAX_MANIFEST_BYTES) throw sessionError();
    const manifest = validateSignedArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
    const opened = await session.openExpected(manifest);
    if (!hasExactKeys(opened, ["publisherBytes", "rows"])
      || !Buffer.isBuffer(opened.publisherBytes)
      || !hasDenseArrayShape(opened.rows)
      || opened.rows.length !== manifest.files.length
      || !opened.rows.every(isCoordinatorRow)) throw sessionError();
    for (let index = 0; index < opened.rows.length; index += 1) {
      const row = opened.rows[index];
      const expected = manifest.files[index];
      if (row.path !== expected.path || row.bytes !== expected.bytes || row.sha256 !== expected.sha256) throw sessionError();
    }
    const rows = Object.freeze(opened.rows.map((row) => Object.freeze({ path: row.path, bytes: row.bytes, sha256: row.sha256 })));
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await session.close();
    };
    return Object.freeze({
      manifestBytes: Buffer.from(manifestBytes),
      publisherBytes: Buffer.from(opened.publisherBytes),
      rows,
      settle: async () => {
        try { await session.settle(); }
        catch {
          try { await close(); }
          catch { throw sessionCleanupError(); }
          throw sessionError();
        }
      },
      close,
    });
  } catch {
    if (session) {
      try { await session.close(); }
      catch { throw sessionCleanupError(); }
    }
    throw sessionError();
  }
};

const runBoundary = async (category, operation) => {
  try { return await operation(); }
  catch { throw verificationError(category); }
};

const removeExtractionParent = async (extractionParent, canonicalTemporaryRoot) => {
  const basename = parse(extractionParent).base;
  if (parse(extractionParent).dir !== canonicalTemporaryRoot
    || resolve(extractionParent) !== extractionParent
    || !/^intentarc-signed-artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename)) {
    throw verificationError("cleanup");
  }
  const information = await lstat(extractionParent);
  if (!information.isDirectory() || information.isSymbolicLink()
    || await realpath(extractionParent) !== extractionParent) throw verificationError("cleanup");
  await rm(extractionParent, { recursive: true, force: false });
};

export async function validateSignedArtifactBundle(input) {
  let session;
  let extractionParent;
  let canonicalTemporaryRoot;
  let primaryError;
  let result;
  try {
    if (arguments.length !== 1
      || utilTypes.isProxy(input)
      || !hasExactKeys(input, ["bundleRoot", "expectedPublisherThumbprint"])) throw verificationError("arguments");
    const bundleRoot = Object.getOwnPropertyDescriptor(input, "bundleRoot").value;
    const expectedPublisherThumbprint = Object.getOwnPropertyDescriptor(input, "expectedPublisherThumbprint").value;
    if (typeof bundleRoot !== "string"
      || !isAbsolute(bundleRoot)
      || !isThumbprint(expectedPublisherThumbprint)) throw verificationError("arguments");

    session = await runBoundary("topology", () => openSignedArtifactSession({ bundleRoot }));
    const manifestBytes = await runBoundary("manifest", () => session.readManifest());
    const manifest = await runBoundary("manifest", async () => {
      if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > MAX_MANIFEST_BYTES) throw manifestError();
      return validateSignedArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
    });
    if (manifest.publisher.thumbprint !== expectedPublisherThumbprint) throw verificationError("publisher");

    const opened = await runBoundary("topology", () => session.openExpected(manifest));
    await runBoundary("topology", async () => {
      if (!hasExactKeys(opened, ["publisherBytes", "rows"])
        || !Buffer.isBuffer(opened.publisherBytes)
        || !hasDenseArrayShape(opened.rows)
        || opened.rows.length !== manifest.files.length
        || !opened.rows.every(isCoordinatorRow)) throw sessionError();
    });
    await runBoundary("publisher", () => validatePublisherBytes({
      bytes: opened.publisherBytes,
      expectedSha256: manifest.publisher.cerSha256,
      expectedSubject: manifest.publisher.subject,
      expectedThumbprint: expectedPublisherThumbprint,
    }));
    await runBoundary("topology", async () => {
      for (let index = 0; index < opened.rows.length; index += 1) {
        const row = opened.rows[index];
        const expected = manifest.files[index];
        if (row.path !== expected.path || row.bytes !== expected.bytes || row.sha256 !== expected.sha256) throw sessionError();
      }
    });
    const auditRoot = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT;
    const auditPath = process.env.INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH;
    const auditDisabled = auditRoot === undefined && auditPath === undefined;
    if ((auditRoot === undefined) !== (auditPath === undefined)) {
      throw verificationError("bridge-diagnostic-audit");
    }
    await runBoundary("release-executables", () => verifyReleaseExecutables({
      outputRoot: join(bundleRoot, "out"),
      environment: process.env,
    }));
    const fullNupkg = manifest.files.find((file) => /^out\/make\/squirrel\.windows\/x64\/[^/]+-full\.nupkg$/.test(file.path));
    canonicalTemporaryRoot = await runBoundary("bridge-native", () => realpath(tmpdir()));
    const extractionCandidate = join(canonicalTemporaryRoot, `intentarc-signed-artifact-${randomUUID()}`);
    await runBoundary("bridge-native", () => mkdir(extractionCandidate));
    extractionParent = extractionCandidate;
    await runBoundary("bridge-native", () => verifyBridgeNativeArtifacts({
      distBridgeRoot: join(bundleRoot, "dist", "bridge"),
      packagedRoot: join(bundleRoot, "out", "IntentArc-win32-x64"),
      fullNupkgPath: join(bundleRoot, ...fullNupkg.path.split("/")),
      extractionParent,
      expectedThumbprint: expectedPublisherThumbprint,
      environment: process.env,
    }));
    let bridgeDiagnosticInvocationCount = 0;
    if (!auditDisabled) {
      const tokens = await runBoundary("bridge-diagnostic-audit", () =>
        readBridgeDiagnosticAudit({ auditRoot, auditPath }));
      if (tokens.length !== bridgeDiagnosticTokens.length ||
          tokens.some((token, index) => token !== bridgeDiagnosticTokens[index])) {
        throw verificationError("bridge-diagnostic-audit");
      }
      bridgeDiagnosticInvocationCount = 5;
    }
    await runBoundary("settlement", () => session.settle());

    result = validateSignedArtifactResult({
      schemaVersion: manifest.schemaVersion,
      bundleId: manifest.bundleId,
      sourceCommit: manifest.source.commit,
      verifierSha256: manifest.source.verifierSha256,
      packageVersion: manifest.source.packageVersion,
      fileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
      publisher: {
        cerSha256: manifest.publisher.cerSha256,
        subject: manifest.publisher.subject,
        thumbprint: manifest.publisher.thumbprint,
      },
      releaseExecutablesVerified: true,
      bridgeNativeVerified: true,
      bundleClosureVerified: true,
      bridgeDiagnosticInvocationCount,
    });
  } catch (error) {
    primaryError = error instanceof Error && /^IntentArc signed artifact verification failed: (arguments|manifest|publisher|topology|release-executables|bridge-native|bridge-diagnostic-audit|settlement|cleanup)\.$/.test(error.message)
      ? error
      : verificationError("arguments");
  } finally {
    let cleanupFailed = false;
    if (extractionParent) {
      try { await removeExtractionParent(extractionParent, canonicalTemporaryRoot); }
      catch { cleanupFailed = true; }
    }
    if (session) {
      try { await session.close(); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) primaryError = verificationError("cleanup");
  }
  if (primaryError) throw primaryError;
  return result;
}

const hasSameFileIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

const readStandaloneManifest = async (documentPath) => {
  try {
    const initialPathInformation = await lstat(documentPath);
    if (!initialPathInformation.isFile() || initialPathInformation.isSymbolicLink()) throw manifestError();
    const handle = await open(documentPath, "r");
    try {
      const information = await handle.stat();
      const openedPathInformation = await lstat(documentPath);
      if (!information.isFile()
        || information.isSymbolicLink()
        || !openedPathInformation.isFile()
        || openedPathInformation.isSymbolicLink()
        || !hasSameFileIdentity(initialPathInformation, information)
        || !hasSameFileIdentity(information, openedPathInformation)
        || !Number.isSafeInteger(information.size)
        || information.size < 0) throw manifestError();
      if (information.size > MAX_MANIFEST_BYTES) throw manifestError();
      const capacity = Math.min(information.size + 1, MAX_MANIFEST_BYTES + 1);
      const bytes = Buffer.allocUnsafe(capacity);
      let offset = 0;
      while (offset < capacity) {
        const { bytesRead } = await handle.read(bytes, offset, capacity - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const finalInformation = await handle.stat();
      const finalPathInformation = await lstat(documentPath);
      if (offset !== information.size
        || finalInformation.size !== information.size
        || !finalInformation.isFile()
        || finalInformation.isSymbolicLink()
        || !finalPathInformation.isFile()
        || finalPathInformation.isSymbolicLink()
        || !hasSameFileIdentity(information, finalInformation)
        || !hasSameFileIdentity(finalInformation, finalPathInformation)) throw manifestError();
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch {
    throw manifestError();
  }
};

const runSignedArtifactCli = async (argumentsList) => {
  try {
    let parsed;
    try { parsed = parseSignedArtifactArguments(argumentsList); }
    catch { throw verificationError("arguments"); }
    let result;
    if (parsed.command === "validate-manifest") {
      result = await runBoundary("manifest", async () => {
        const bytes = await readStandaloneManifest(parsed.documentPath);
        return validateSignedArtifactManifest(JSON.parse(bytes.toString("utf8")));
      });
    } else {
      result = await validateSignedArtifactBundle({
        bundleRoot: parsed.bundleRoot,
        expectedPublisherThumbprint: parsed.expectedPublisherThumbprint,
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const match = error instanceof Error
      ? /^IntentArc signed artifact verification failed: (arguments|manifest|publisher|topology|release-executables|bridge-native|bridge-diagnostic-audit|settlement|cleanup)\.$/.exec(error.message)
      : null;
    const category = match?.[1] ?? "arguments";
    process.stderr.write(`IntentArc signed artifact verification failed: ${category}.\n`);
    process.exitCode = category === "bridge-diagnostic-audit" ? 2 : 1;
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runSignedArtifactCli(process.argv.slice(2));
}
