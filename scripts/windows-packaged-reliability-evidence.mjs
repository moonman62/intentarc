import {
  lstat as lstatFile,
  open as openFile,
  realpath as canonicalize,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const WHOLE_SUITE_RESULT_FILENAME = "whole-suite.json";
export const WHOLE_SUITE_RESULT_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
export const WHOLE_SUITE_FAILURE_LIMIT = 20;
export const ORDINAL4_FOCUSED_SOURCE_COMMIT =
  "737b5d07cc20633f57df1e2b83060b7b72667223";
export const ORDINAL4_FOCUSED_MAXIMUM_ATTEMPTS = 30;
export const ORDINAL4_PREFIX_MAXIMUM_ATTEMPTS = 20;

export const ordinal4FocusedResultFilename = (attempt) => {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt <= 0 ||
    attempt > ORDINAL4_FOCUSED_MAXIMUM_ATTEMPTS
  ) throw fail("ordinal4_evidence_unsafe");
  return `ordinal4-focused-${attempt}.json`;
};

export const ordinal4PrefixResultFilename = (attempt) => {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt <= 0 ||
    attempt > ORDINAL4_PREFIX_MAXIMUM_ATTEMPTS
  ) throw fail("ordinal4_prefix_evidence_unsafe");
  return `ordinal4-prefix-${attempt}.json`;
};

const fail = (code) => Object.assign(new Error(code), { code });

const profiles = {
  wholeSuite: {
    codes: {
      missing: "whole_suite_evidence_missing",
      unsafe: "whole_suite_evidence_unsafe",
      oversize: "whole_suite_evidence_oversize",
      malformed: "whole_suite_evidence_malformed",
      inconsistent: "whole_suite_evidence_inconsistent",
    },
    resultFilename: () => WHOLE_SUITE_RESULT_FILENAME,
  },
  packagedBridge: {
    codes: {
      missing: "packaged_bridge_evidence_missing",
      unsafe: "packaged_bridge_evidence_unsafe",
      oversize: "packaged_bridge_evidence_oversize",
      malformed: "packaged_bridge_evidence_malformed",
      inconsistent: "packaged_bridge_evidence_inconsistent",
    },
    resultFilename: (input) => {
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= 0) {
        throw fail("packaged_bridge_evidence_unsafe");
      }
      return `packaged-bridge-${input.ordinal}.json`;
    },
  },
  ordinal4Focused: {
    codes: {
      missing: "ordinal4_evidence_missing",
      unsafe: "ordinal4_evidence_unsafe",
      oversize: "ordinal4_evidence_oversize",
      malformed: "ordinal4_evidence_malformed",
      inconsistent: "ordinal4_evidence_inconsistent",
    },
    resultFilename: (input) => {
      if (
        input.sourceCommit !== ORDINAL4_FOCUSED_SOURCE_COMMIT ||
        ![0, 1].includes(input.exitCode)
      ) {
        throw fail("ordinal4_evidence_unsafe");
      }
      return ordinal4FocusedResultFilename(input.attempt);
    },
  },
  ordinal4Prefix: {
    codes: {
      missing: "ordinal4_prefix_evidence_missing",
      unsafe: "ordinal4_prefix_evidence_unsafe",
      oversize: "ordinal4_prefix_evidence_oversize",
      malformed: "ordinal4_prefix_evidence_malformed",
      inconsistent: "ordinal4_prefix_evidence_inconsistent",
    },
    resultFilename: (input) => {
      if (
        input.sourceCommit !== ORDINAL4_FOCUSED_SOURCE_COMMIT ||
        ![0, 1].includes(input.exitCode)
      ) {
        throw fail("ordinal4_prefix_evidence_unsafe");
      }
      return ordinal4PrefixResultFilename(input.attempt);
    },
  },
};

const evidenceCodeSet = (profile) => new Set(Object.values(profile.codes));
const wholeSuiteEvidenceCodes = evidenceCodeSet(profiles.wholeSuite);
const packagedBridgeEvidenceCodes = evidenceCodeSet(profiles.packagedBridge);
const ordinal4FocusedEvidenceCodes = evidenceCodeSet(profiles.ordinal4Focused);
const ordinal4PrefixEvidenceCodes = evidenceCodeSet(profiles.ordinal4Prefix);

export const isWholeSuiteEvidenceCode = (value) =>
  typeof value === "string" && wholeSuiteEvidenceCodes.has(value);

export const isPackagedBridgeEvidenceCode = (value) =>
  typeof value === "string" && packagedBridgeEvidenceCodes.has(value);

export const isOrdinal4FocusedEvidenceCode = (value) =>
  typeof value === "string" && ordinal4FocusedEvidenceCodes.has(value);

export const isOrdinal4PrefixEvidenceCode = (value) =>
  typeof value === "string" && ordinal4PrefixEvidenceCodes.has(value);

const canonicalEqual = (left, right) =>
  process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;

const containedRelativePath = (parent, child, unsafeCode) => {
  const value = relative(parent, child);
  if (
    value.length === 0 ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) throw fail(unsafeCode);
  return value.split(sep).join("/");
};

const sameFileIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const compareCodeUnits = (left, right) => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

const assertionIdentity = (ordinal) =>
  `assertion-${String(ordinal).padStart(6, "0")}`;

const closeHandle = async (handle, code) => {
  try {
    await handle.close();
  } catch {
    throw fail(code);
  }
};

const filesystemFor = (dependencies = {}) => ({
  lstat: dependencies.lstat ?? ((path) => lstatFile(path, { bigint: true })),
  open: dependencies.open ?? openFile,
  realpath: dependencies.realpath ?? canonicalize,
});

const openValidatedOrdinaryFile = async ({
  path,
  expectedCanonical,
  unsafeCode,
  filesystem,
}) => {
  let handle;
  try {
    const before = await filesystem.lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw fail(unsafeCode);
    const canonicalBefore = await filesystem.realpath(path);
    if (expectedCanonical && !canonicalEqual(canonicalBefore, expectedCanonical)) {
      throw fail(unsafeCode);
    }
    handle = await filesystem.open(path, "r");
    const opened = await handle.stat({ bigint: true });
    const after = await filesystem.lstat(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, after)
    ) throw fail(unsafeCode);
    const canonicalAfter = await filesystem.realpath(path);
    if (
      !canonicalEqual(canonicalBefore, canonicalAfter) ||
      (expectedCanonical && !canonicalEqual(canonicalAfter, expectedCanonical))
    ) throw fail(unsafeCode);
    return {
      canonicalPath: canonicalAfter,
      handle,
      identity: {
        dev: String(opened.dev),
        ino: String(opened.ino),
      },
    };
  } catch (error) {
    if (handle) await closeHandle(handle, unsafeCode);
    throw error;
  }
};

export const readBoundedUtf8File = async (
  handle,
  maximumBytes,
  oversizeCode = profiles.wholeSuite.codes.oversize,
) => {
  const chunks = [];
  let bytes = 0;
  let position = 0;
  while (bytes <= maximumBytes) {
    const remaining = maximumBytes + 1 - bytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    bytes += bytesRead;
    position += bytesRead;
    if (bytes > maximumBytes) throw fail(oversizeCode);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
};

const readValidatedDocument = async (input, profile, dependencies = {}) => {
  const codes = profile.codes;
  const profileCodes = evidenceCodeSet(profile);
  const filesystem = filesystemFor(dependencies);
  let canonicalRepository;
  let result;
  try {
    const resultFilename = profile.resultFilename(input);
    canonicalRepository = await filesystem.realpath(input.repositoryRoot);
    const canonicalState = await filesystem.realpath(input.stateRoot);
    const expected = join(canonicalState, resultFilename);
    if (
      !isAbsolute(input.stateRoot) ||
      !canonicalEqual(resolve(input.stateRoot), canonicalState) ||
      !isAbsolute(input.resultFile) ||
      !canonicalEqual(resolve(input.resultFile), expected)
    ) throw fail(codes.unsafe);
    result = await openValidatedOrdinaryFile({
      path: expected,
      expectedCanonical: expected,
      unsafeCode: codes.unsafe,
      filesystem,
    });
  } catch (error) {
    if (profileCodes.has(error?.code)) throw error;
    if (error?.code === "ENOENT") throw fail(codes.missing);
    throw fail(codes.unsafe);
  }

  let document;
  try {
    const readBounded = dependencies.readBoundedUtf8File ?? (
      (handle, maximumBytes) => readBoundedUtf8File(handle, maximumBytes, codes.oversize)
    );
    const source = await readBounded(result.handle, WHOLE_SUITE_RESULT_MAXIMUM_BYTES);
    document = JSON.parse(source);
  } catch (error) {
    if (profileCodes.has(error?.code)) throw error;
    if (error?.code === "ENOENT") throw fail(codes.missing);
    throw fail(codes.malformed);
  } finally {
    await closeHandle(result.handle, codes.malformed);
  }

  const countKeys = [
    "numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites",
    "numPendingTestSuites", "numTotalTests", "numPassedTests",
    "numFailedTests", "numPendingTests", "numTodoTests",
  ];
  if (
    !document || typeof document !== "object" ||
    typeof document.success !== "boolean" ||
    !Array.isArray(document.testResults) ||
    countKeys.some((key) => !Number.isSafeInteger(document[key]) || document[key] < 0)
  ) throw fail(codes.malformed);
  return {
    canonicalRepository,
    document,
    filesystem,
    profileCodes,
    resultIdentity: {
      canonicalPath: result.canonicalPath,
      dev: result.identity.dev,
      ino: result.identity.ino,
    },
  };
};

const projectEvidence = async (input, profile, dependencies) => {
  const codes = profile.codes;
  const { canonicalRepository, document, filesystem, profileCodes } =
    await readValidatedDocument(input, profile, dependencies);
  if (
    document.numTotalTestSuites !==
      document.numPassedTestSuites + document.numFailedTestSuites + document.numPendingTestSuites ||
    document.numTotalTests !==
      document.numPassedTests + document.numFailedTests + document.numPendingTests + document.numTodoTests ||
    document.success !== (input.exitCode === 0) ||
    (input.exitCode === 0 && document.numFailedTests !== 0)
  ) throw fail(codes.inconsistent);

  const identities = [];
  for (let resultOrdinal = 0; resultOrdinal < document.testResults.length; resultOrdinal += 1) {
    const result = document.testResults[resultOrdinal];
    if (!result || typeof result !== "object" || !Array.isArray(result.assertionResults)) {
      throw fail(codes.malformed);
    }
    const hasFailedAssertion = result.assertionResults.some(
      (assertion) => assertion?.status === "failed",
    );
    if (!hasFailedAssertion) continue;
    if (typeof result.name !== "string" || !isAbsolute(result.name)) {
      throw fail(codes.unsafe);
    }
    let resultFile;
    try {
      resultFile = await openValidatedOrdinaryFile({
        path: result.name,
        unsafeCode: codes.unsafe,
        filesystem,
      });
    } catch (error) {
      if (profileCodes.has(error?.code)) throw error;
      throw fail(codes.unsafe);
    }
    let testFile;
    try {
      testFile = containedRelativePath(
        canonicalRepository,
        resultFile.canonicalPath,
        codes.unsafe,
      );
    } finally {
      await closeHandle(resultFile.handle, codes.unsafe);
    }
    for (
      let assertionOrdinal = 0;
      assertionOrdinal < result.assertionResults.length;
      assertionOrdinal += 1
    ) {
      if (result.assertionResults[assertionOrdinal]?.status !== "failed") continue;
      identities.push({
        testFile,
        assertion: assertionIdentity(assertionOrdinal),
        resultOrdinal,
        assertionOrdinal,
      });
    }
  }
  identities.sort((left, right) =>
    compareCodeUnits(left.testFile, right.testFile) ||
    left.resultOrdinal - right.resultOrdinal ||
    left.assertionOrdinal - right.assertionOrdinal);
  if (identities.length !== document.numFailedTests) throw fail(codes.inconsistent);
  return {
    passed: document.numPassedTests,
    skipped: document.numPendingTests + document.numTodoTests,
    failed: document.numFailedTests,
    failedTests: identities.slice(0, WHOLE_SUITE_FAILURE_LIMIT).map(
      ({ testFile, assertion }) => ({ testFile, assertion }),
    ),
    failuresTruncated: identities.length > WHOLE_SUITE_FAILURE_LIMIT,
  };
};

export const readWholeSuiteEvidence = (input, dependencies) =>
  projectEvidence(input, profiles.wholeSuite, dependencies);

export const readPackagedBridgeEvidence = (input, dependencies) =>
  projectEvidence(input, profiles.packagedBridge, dependencies);

const ordinal4TestFile = "src/desktop/e2e/packaged-bridge.test.ts";
const ordinal4Title =
  "runs the stable installed bridge with Desktop closed and then holds concurrent archive leases";
const ordinal4Suite = "packaged Windows x64 product";
const ordinal4PrefixTitles = Object.freeze([
  "contains the complete runtime and excludes build, SDD, and test-cache inputs",
  "selects and starts the bundled bridge before installer publication",
  "holds the authenticated packaged executable object through process creation",
  "runs full stable-path recovery after a crash following launcher publication",
  ordinal4Title,
  "runs a reviewed structured-knowledge journey in the packaged Desktop",
  "retries one transient cleanup lock",
  "bounds persistent cleanup locks",
  "does not retry a nonclosed cleanup error",
]);

const protocolVerifierFile = "src/desktop/bridge-protocol-verifier.ts";
const bridgeInstallFile = "src/desktop/bridge-install.ts";

const parseStackFrame = (line, canonicalRepository) => {
  const match = line.match(
    /^\s*at\s+(?:(?:async\s+)?[^()\r\n]+\()?(.+):([1-9][0-9]*):([1-9][0-9]*)\)?\s*$/,
  );
  if (!match) return null;
  let path = match[1];
  const sourceLine = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(sourceLine) || !Number.isSafeInteger(column)) {
    return null;
  }
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }
  const normalizedRelative = path.split("\\").join("/");
  if (!isAbsolute(path)) {
    if (!normalizedRelative.startsWith("src/") && !normalizedRelative.startsWith("scripts/")) {
      return null;
    }
    return { file: normalizedRelative, line: sourceLine, column };
  }
  const canonicalCandidate = resolve(path);
  if (!canonicalEqual(canonicalCandidate, path)) return null;
  const relativeCandidate = relative(canonicalRepository, canonicalCandidate);
  if (
    relativeCandidate.length === 0 || relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)
  ) return null;
  const file = relativeCandidate.split(sep).join("/");
  if (!canonicalEqual(canonicalCandidate, join(canonicalRepository, file))) {
    return null;
  }
  return { file, line: sourceLine, column };
};

const framesFor = (message, canonicalRepository) => message
  .split(/\r?\n/)
  .slice(1)
  .map((line) => parseStackFrame(line, canonicalRepository))
  .filter((frame) => frame !== null);

const hasFrame = (frames, file, lines) => frames.some((frame) =>
  frame.file === file && lines.includes(frame.line)
);
const hasFrameRange = (frames, file, start, end) => frames.some((frame) =>
  frame.file === file && frame.line >= start && frame.line <= end
);

const closedFilesystemCode = (firstLine) =>
  /^Error: (?:EACCES|EBUSY|ENOTEMPTY|EPERM):/.test(firstLine);

const ordinal4CategoryRules = (canonicalRepository) => [
  {
    category: "bridge_promotion_eperm_exhausted",
    matches: (message) => {
      const firstLine = message.split(/\r?\n/, 1)[0];
      return /^Error: EPERM: operation not permitted, rename(?:\s|$)/.test(firstLine) &&
        hasFrame(framesFor(message, canonicalRepository), bridgeInstallFile, [535]);
    },
  },
  {
    category: "protocol_verification_timeout",
    matches: (message) => {
      const frames = framesFor(message, canonicalRepository);
      return message.includes(
        "IntentArc bridge MCP protocol verification timed out.",
      ) && (
        hasFrame(frames, protocolVerifierFile, [363]) ||
        hasFrame(frames, ordinal4TestFile, [438, 580])
      );
    },
  },
  {
    category: "protocol_child_close_unproven",
    matches: (message) => {
      const frames = framesFor(message, canonicalRepository);
      const hasToken = [
        "IntentArc bridge MCP protocol child settlement timed out.",
        "IntentArc bridge MCP protocol process ownership is unavailable.",
      ].some((token) => message.includes(token));
      return hasToken && (
        hasFrame(frames, protocolVerifierFile, [141, 331]) ||
        hasFrame(frames, ordinal4TestFile, [438, 580])
      );
    },
  },
  {
    category: "archive_lease_assertion_timeout",
    matches: (message) => {
      const frames = framesFor(message, canonicalRepository);
      return message.includes("Timed out waiting for packaged process state.") && (
        hasFrame(frames, ordinal4TestFile, [620]) ||
        hasFrameRange(frames, ordinal4TestFile, 635, 655)
      );
    },
  },
  {
    category: "fixture_cleanup_failure",
    matches: (message) => {
      const frames = framesFor(message, canonicalRepository);
      const firstLine = message.split(/\r?\n/, 1)[0];
      return closedFilesystemCode(firstLine) &&
        hasFrameRange(frames, ordinal4TestFile, 117, 150) && (
          hasFrameRange(frames, ordinal4TestFile, 153, 162) ||
          hasFrame(frames, ordinal4TestFile, [691])
        );
    },
  },
];

const classifyOrdinal4Failure = (failureMessages, canonicalRepository) => {
  const categories = new Set();
  for (const rule of ordinal4CategoryRules(canonicalRepository)) {
    if (failureMessages.some((message) => rule.matches(message))) {
      categories.add(rule.category);
    }
  }
  return categories.size === 1 ? [...categories][0] : "unknown";
};

const ordinal4FingerprintLimits = Object.freeze({
  messages: 8,
  lines: 256,
  frames: 64,
  headers: 16,
  lineCharacters: 4_096,
});
const ordinal4FingerprintErrorCodes = new Set([
  "EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ENOENT", "EEXIST",
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE",
]);
const ordinal4StaticErrorWrappers = Object.freeze([
  "Bridge active launcher health failed:",
  "Bridge staged protocol verification failed:",
  "Bridge active protocol verification failed:",
  "Packaged Desktop exited with",
  "Timed out waiting for packaged process state.",
]);

const createOrdinal4Fingerprint = ({
  errorCode,
  sourceBoundary,
  phase,
  completeness,
}) => Object.freeze({
  schemaVersion: 1,
  errorCode,
  sourceBoundary,
  phase,
  completeness,
});

const truncatedOrdinal4Fingerprint = () => createOrdinal4Fingerprint({
  errorCode: "unknown",
  sourceBoundary: "unknown",
  phase: "unknown",
  completeness: "truncated",
});

const fingerprintErrorPayload = (line) => {
  const nested = line.match(/^Caused by: Error:\s+(.+)$/);
  if (nested) return nested[1];
  const direct = line.match(/^Error:\s+(.+)$/);
  if (direct) return direct[1];
  const wrapper = ordinal4StaticErrorWrappers.find((prefix) =>
    line === prefix || line.startsWith(`${prefix} `)
  );
  return wrapper ? line : null;
};

const codesFromFingerprintPayload = (payload) => new Set(
  [...payload.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)]
    .map((match) => match[0])
    .filter((code) => ordinal4FingerprintErrorCodes.has(code)),
);

const fingerprintFrameCandidate = (line) =>
  /^\s*(?:at(?:\s|$)|❯(?:\s|$))/.test(line);

const fingerprintFrameLocation = (line) => {
  const vitest = line.match(/^\s*❯\s+(.+):([1-9][0-9]*):([1-9][0-9]*)\s*$/);
  if (vitest) return vitest.slice(1);
  const named = line.match(
    /^\s*at\s+(?:async\s+)?[^()\r\n]+\s+\((.+):([1-9][0-9]*):([1-9][0-9]*)\)\s*$/,
  );
  if (named) return named.slice(1);
  const anonymous = line.match(
    /^\s*at\s+(?:async\s+)?(.+):([1-9][0-9]*):([1-9][0-9]*)\s*$/,
  );
  return anonymous ? anonymous.slice(1) : null;
};

const parseFingerprintFrame = (line, canonicalRepository) => {
  const location = fingerprintFrameLocation(line);
  if (!location) return null;
  let [path, sourceLineText, columnText] = location;
  const sourceLine = Number(sourceLineText);
  const column = Number(columnText);
  if (!Number.isSafeInteger(sourceLine) || !Number.isSafeInteger(column)) return null;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }

  let canonicalCandidate;
  if (isAbsolute(path)) {
    canonicalCandidate = resolve(path);
    if (!canonicalEqual(canonicalCandidate, path)) return null;
  } else {
    const normalized = path.split("\\").join("/");
    if (
      (!normalized.startsWith("src/") && !normalized.startsWith("scripts/")) ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ) return null;
    canonicalCandidate = resolve(canonicalRepository, ...normalized.split("/"));
  }
  const relativeCandidate = relative(canonicalRepository, canonicalCandidate);
  if (
    relativeCandidate.length === 0 || relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)
  ) return null;
  const file = relativeCandidate.split(sep).join("/");
  if (!canonicalEqual(canonicalCandidate, join(canonicalRepository, file))) return null;
  return { file, line: sourceLine, column };
};

const normalizeClosedObservations = (observations) =>
  observations.size === 0
    ? "unknown"
    : observations.size === 1 ? [...observations][0] : "conflict";

const sourceBoundaryForFrame = (frame) => {
  if (frame.file === bridgeInstallFile) {
    return frame.line >= 396 && frame.line <= 560
      ? "bridge_activation_promotion"
      : "bridge_install_other";
  }
  if (frame.file === protocolVerifierFile) return "bridge_protocol_verifier";
  if (frame.file === "scripts/build-bridge.mjs") return "bridge_payload_build";
  if (frame.file === ordinal4TestFile) {
    if (
      (frame.line >= 117 && frame.line <= 162) ||
      (frame.line >= 691 && frame.line <= 694)
    ) return "packaged_fixture_cleanup";
    return null;
  }
  return "other_repository";
};

const ordinal4PhaseForFrame = (frame) => {
  if (frame.file !== ordinal4TestFile) return null;
  const ranges = [
    [393, 402, "fixture_setup"],
    [405, 447, "initial_install"],
    [449, 481, "executable_lock"],
    [483, 533, "archive_connection"],
    [535, 570, "update_build"],
    [571, 616, "update_install"],
    [618, 665, "archive_leases"],
    [667, 689, "pending_update"],
    [117, 162, "fixture_cleanup"],
    [691, 694, "fixture_cleanup"],
  ];
  const range = ranges.find(([start, end]) => frame.line >= start && frame.line <= end);
  return range?.[2] ?? null;
};

const syscallBoundariesFor = (payload) => {
  const boundaries = new Set();
  if (/(?:^|[\s,:])rename(?=[\s,]|$)/.test(payload)) {
    boundaries.add("filesystem_rename");
  }
  if (/(?:^|[\s,:])(?:rm|rmdir|unlink)(?=[\s,]|$)/.test(payload)) {
    boundaries.add("filesystem_remove");
  }
  if (/(?:^|[\s,:])(?:spawn|execFile)(?=[\s,]|$)/.test(payload)) {
    boundaries.add("child_process");
  }
  return boundaries;
};

const fingerprintOrdinal4Failure = (failureMessages, canonicalRepository) => {
  if (failureMessages.length > ordinal4FingerprintLimits.messages) {
    return truncatedOrdinal4Fingerprint();
  }
  const lines = failureMessages.flatMap((message) => message.split(/\r\n|\n|\r/));
  if (
    lines.length > ordinal4FingerprintLimits.lines ||
    lines.some((line) => line.length > ordinal4FingerprintLimits.lineCharacters)
  ) return truncatedOrdinal4Fingerprint();

  const frameLines = lines.filter(fingerprintFrameCandidate);
  const errorPayloads = lines.map(fingerprintErrorPayload).filter((value) => value !== null);
  if (
    frameLines.length > ordinal4FingerprintLimits.frames ||
    errorPayloads.length > ordinal4FingerprintLimits.headers
  ) return truncatedOrdinal4Fingerprint();

  const errorCodes = new Set();
  const syscallBoundaries = new Set();
  for (const payload of new Set(errorPayloads)) {
    for (const code of codesFromFingerprintPayload(payload)) errorCodes.add(code);
    for (const boundary of syscallBoundariesFor(payload)) syscallBoundaries.add(boundary);
  }

  const framesByIdentity = new Map();
  for (const line of frameLines) {
    const frame = parseFingerprintFrame(line, canonicalRepository);
    if (frame) framesByIdentity.set(`${frame.file}:${frame.line}:${frame.column}`, frame);
  }
  const frames = [...framesByIdentity.values()];
  const repositoryBoundaries = new Set(
    frames.map(sourceBoundaryForFrame).filter((value) => value !== null),
  );
  const ordinal4Callsite = frames.some((frame) =>
    frame.file === ordinal4TestFile && ordinal4PhaseForFrame(frame) !== null
  );
  const sourceBoundary = repositoryBoundaries.size > 0
    ? normalizeClosedObservations(repositoryBoundaries)
    : syscallBoundaries.size > 0
      ? normalizeClosedObservations(syscallBoundaries)
      : ordinal4Callsite ? "ordinal4_declaration" : "unknown";

  const phases = new Set(frames.map(ordinal4PhaseForFrame).filter((value) => value !== null));
  if (phases.size === 0) {
    const installObserved = repositoryBoundaries.has("bridge_activation_promotion") ||
      repositoryBoundaries.has("bridge_install_other");
    const protocolObserved = repositoryBoundaries.has("bridge_protocol_verifier");
    if (installObserved) phases.add("install_unattributed");
    if (protocolObserved) phases.add("protocol_unattributed");
  }

  return createOrdinal4Fingerprint({
    errorCode: normalizeClosedObservations(errorCodes),
    sourceBoundary,
    phase: normalizeClosedObservations(phases),
    completeness: "complete",
  });
};

const projectOrdinal4Failure = (failureMessages, canonicalRepository) => {
  const category = classifyOrdinal4Failure(failureMessages, canonicalRepository);
  return category === "unknown"
    ? {
        outcome: "failed",
        category,
        fingerprint: fingerprintOrdinal4Failure(failureMessages, canonicalRepository),
      }
    : { outcome: "failed", category };
};

const ordinal4RetirementIdentities = new WeakMap();
const createOrdinal4RetirementIdentity = (identity) => {
  const token = Object.create(null);
  Object.defineProperty(token, "toJSON", {
    value: () => undefined,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  ordinal4RetirementIdentities.set(token, Object.freeze({ ...identity }));
  return Object.freeze(token);
};

export const matchesOrdinal4RetirementIdentity = (token, identity) => {
  if ((typeof token !== "object" && typeof token !== "function") || token === null || !identity) {
    return false;
  }
  const retained = ordinal4RetirementIdentities.get(token);
  return retained !== undefined &&
    canonicalEqual(retained.canonicalPath, identity.canonicalPath) &&
    retained.dev === identity.dev && retained.ino === identity.ino;
};

const withRetirementIdentity = (projection, resultIdentity) => {
  Object.defineProperty(projection, "retirementIdentity", {
    value: createOrdinal4RetirementIdentity(resultIdentity),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return projection;
};

export const readOrdinal4FocusedEvidence = async (input, dependencies) => {
  const profile = profiles.ordinal4Focused;
  const codes = profile.codes;
  const {
    canonicalRepository,
    document,
    filesystem,
    profileCodes,
    resultIdentity,
  } = await readValidatedDocument(input, profile, dependencies);

  const expectedPassing = input.exitCode === 0;
  if (
    document.numTotalTestSuites !== 2 ||
    document.numPassedTestSuites !== (expectedPassing ? 2 : 0) ||
    document.numFailedTestSuites !== (expectedPassing ? 0 : 2) ||
    document.numPendingTestSuites !== 0 ||
    document.numTotalTests !== 9 ||
    document.numPassedTests !== (expectedPassing ? 1 : 0) ||
    document.numFailedTests !== (expectedPassing ? 0 : 1) ||
    document.numPendingTests !== 8 ||
    document.numTodoTests !== 0 ||
    document.success !== expectedPassing ||
    document.testResults.length !== 1
  ) throw fail(codes.inconsistent);

  const result = document.testResults[0];
  if (
    !result ||
    typeof result !== "object" ||
    result.status !== (expectedPassing ? "passed" : "failed") ||
    typeof result.name !== "string" ||
    !isAbsolute(result.name) ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length !== 9 ||
    result.assertionResults.some((assertion, ordinal) =>
      ordinal !== 4 && assertion?.status !== "skipped"
    )
  ) throw fail(codes.malformed);

  let resultFile;
  try {
    resultFile = await openValidatedOrdinaryFile({
      path: result.name,
      unsafeCode: codes.unsafe,
      filesystem,
    });
  } catch (error) {
    if (profileCodes.has(error?.code)) throw error;
    throw fail(codes.unsafe);
  }
  try {
    if (
      containedRelativePath(
        canonicalRepository,
        resultFile.canonicalPath,
        codes.unsafe,
      ) !== ordinal4TestFile
    ) throw fail(codes.unsafe);
  } finally {
    await closeHandle(resultFile.handle, codes.unsafe);
  }

  const assertion = result.assertionResults[4];
  if (
    !assertion ||
    typeof assertion !== "object" ||
    assertion.status !== (expectedPassing ? "passed" : "failed") ||
    assertion.title !== ordinal4Title ||
    assertion.fullName !== `${ordinal4Suite} ${ordinal4Title}` ||
    !Array.isArray(assertion.ancestorTitles) ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== ordinal4Suite ||
    !Array.isArray(assertion.failureMessages) ||
    assertion.failureMessages.some((message) => typeof message !== "string") ||
    (expectedPassing && assertion.failureMessages.length !== 0) ||
    (!expectedPassing && assertion.failureMessages.length === 0)
  ) throw fail(codes.malformed);

  if (expectedPassing) {
    return withRetirementIdentity(
      { outcome: "passed", category: null },
      resultIdentity,
    );
  }
  return withRetirementIdentity(
    projectOrdinal4Failure(assertion.failureMessages, canonicalRepository),
    resultIdentity,
  );
};

export const readOrdinal4PrefixEvidence = async (input, dependencies) => {
  const profile = profiles.ordinal4Prefix;
  const codes = profile.codes;
  const {
    canonicalRepository,
    document,
    filesystem,
    profileCodes,
    resultIdentity,
  } = await readValidatedDocument(input, profile, dependencies);

  const expectedPassing = input.exitCode === 0;
  if (
    document.numTotalTestSuites !== 2 ||
    document.numPassedTestSuites !== (expectedPassing ? 2 : 0) ||
    document.numFailedTestSuites !== (expectedPassing ? 0 : 2) ||
    document.numPendingTestSuites !== 0 ||
    document.numTotalTests !== 9 ||
    document.numTodoTests !== 0 ||
    document.success !== expectedPassing ||
    document.testResults.length !== 1
  ) throw fail(codes.inconsistent);

  const result = document.testResults[0];
  if (
    !result ||
    typeof result !== "object" ||
    result.status !== (expectedPassing ? "passed" : "failed") ||
    typeof result.name !== "string" ||
    !isAbsolute(result.name) ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length !== ordinal4PrefixTitles.length
  ) throw fail(codes.malformed);

  let resultFile;
  try {
    resultFile = await openValidatedOrdinaryFile({
      path: result.name,
      unsafeCode: codes.unsafe,
      filesystem,
    });
  } catch (error) {
    if (profileCodes.has(error?.code)) throw error;
    throw fail(codes.unsafe);
  }
  try {
    if (
      containedRelativePath(
        canonicalRepository,
        resultFile.canonicalPath,
        codes.unsafe,
      ) !== ordinal4TestFile
    ) throw fail(codes.unsafe);
  } finally {
    await closeHandle(resultFile.handle, codes.unsafe);
  }

  for (let ordinal = 0; ordinal < ordinal4PrefixTitles.length; ordinal += 1) {
    const assertion = result.assertionResults[ordinal];
    const title = ordinal4PrefixTitles[ordinal];
    const expectedAncestors = ordinal <= 5 ? [ordinal4Suite] : [];
    const expectedFullName = expectedAncestors.length === 1
      ? `${ordinal4Suite} ${title}`
      : title;
    if (
      !assertion ||
      typeof assertion !== "object" ||
      assertion.title !== title ||
      assertion.fullName !== expectedFullName ||
      !Array.isArray(assertion.ancestorTitles) ||
      assertion.ancestorTitles.length !== expectedAncestors.length ||
      assertion.ancestorTitles.some((ancestor, index) =>
        ancestor !== expectedAncestors[index]
      ) ||
      !Array.isArray(assertion.failureMessages) ||
      assertion.failureMessages.some((message) => typeof message !== "string")
    ) throw fail(codes.malformed);
  }

  let failedOrdinal = null;
  if (!expectedPassing) {
    const failedOrdinals = result.assertionResults.flatMap((assertion, ordinal) =>
      assertion.status === "failed" ? [ordinal] : []
    );
    if (failedOrdinals.length !== 1 || failedOrdinals[0] > 4) {
      throw fail(codes.inconsistent);
    }
    failedOrdinal = failedOrdinals[0];
  }

  const expectedPassed = expectedPassing ? 5 : failedOrdinal;
  const expectedFailed = expectedPassing ? 0 : 1;
  if (
    document.numPassedTests !== expectedPassed ||
    document.numFailedTests !== expectedFailed ||
    document.numPendingTests !== 4
  ) throw fail(codes.inconsistent);

  for (let ordinal = 0; ordinal < ordinal4PrefixTitles.length; ordinal += 1) {
    const assertion = result.assertionResults[ordinal];
    const expectedStatus = expectedPassing
      ? (ordinal <= 4 ? "passed" : "skipped")
      : (ordinal < failedOrdinal
          ? "passed"
          : ordinal === failedOrdinal
            ? "failed"
            : ordinal <= 4 ? "pending" : "skipped");
    if (
      assertion.status !== expectedStatus ||
      (expectedStatus === "failed"
        ? assertion.failureMessages.length === 0
        : assertion.failureMessages.length !== 0)
    ) throw fail(codes.inconsistent);
  }

  if (expectedPassing) {
    return withRetirementIdentity(
      { outcome: "passed", category: null },
      resultIdentity,
    );
  }
  if (failedOrdinal === 4) {
    return withRetirementIdentity(
      projectOrdinal4Failure(
        result.assertionResults[4].failureMessages,
        canonicalRepository,
      ),
      resultIdentity,
    );
  }
  return withRetirementIdentity(
    { outcome: "failed", category: "prefix_precondition_failed" },
    resultIdentity,
  );
};
