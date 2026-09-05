import { appendFile, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileHandle } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WHOLE_SUITE_RESULT_MAXIMUM_BYTES,
  isOrdinal4FocusedEvidenceCode,
  isOrdinal4PrefixEvidenceCode,
  isPackagedBridgeEvidenceCode,
  isWholeSuiteEvidenceCode,
  ordinal4FocusedResultFilename,
  ordinal4PrefixResultFilename,
  readBoundedUtf8File,
  readOrdinal4FocusedEvidence,
  readOrdinal4PrefixEvidence,
  readPackagedBridgeEvidence,
  readWholeSuiteEvidence,
} from "../../scripts/windows-packaged-reliability-evidence.mjs";
import * as evidenceModuleSource from "../../scripts/windows-packaged-reliability-evidence.mjs";

type FocusedCategory =
  | "bridge_promotion_eperm_exhausted"
  | "protocol_verification_timeout"
  | "protocol_child_close_unproven"
  | "archive_lease_assertion_timeout"
  | "fixture_cleanup_failure"
  | "unknown";

type Ordinal4Fingerprint = {
  readonly schemaVersion: 1;
  readonly errorCode: string;
  readonly sourceBoundary: string;
  readonly phase: string;
  readonly completeness: "complete" | "truncated";
};

type FocusedReader = (
  input: {
    readonly repositoryRoot: string;
    readonly stateRoot: string;
    readonly resultFile: string;
    readonly exitCode: number;
    readonly attempt: number;
    readonly sourceCommit: string;
  },
  dependencies?: {
    readonly readBoundedUtf8File?: (
      handle: FileHandle,
      maximumBytes: number,
    ) => Promise<string>;
  },
) => Promise<{
  readonly outcome: "passed" | "failed";
  readonly category: FocusedCategory | null;
  readonly fingerprint?: Ordinal4Fingerprint;
  readonly retirementIdentity?: unknown;
}>;

type PrefixReader = (
  input: {
    readonly repositoryRoot: string;
    readonly stateRoot: string;
    readonly resultFile: string;
    readonly exitCode: number;
    readonly attempt: number;
    readonly sourceCommit: string;
  },
  dependencies?: Parameters<FocusedReader>[1],
) => Promise<{
  readonly outcome: "passed" | "failed";
  readonly category: FocusedCategory | "prefix_precondition_failed" | null;
  readonly fingerprint?: Ordinal4Fingerprint;
  readonly retirementIdentity?: unknown;
}>;

const evidenceModule = evidenceModuleSource as unknown as {
  readonly ORDINAL4_FOCUSED_SOURCE_COMMIT?: string;
  readonly matchesOrdinal4RetirementIdentity?: (
    token: unknown,
    identity: {
      readonly canonicalPath: string;
      readonly dev: string;
      readonly ino: string;
    },
  ) => boolean;
  readonly ORDINAL4_PREFIX_MAXIMUM_ATTEMPTS?: number;
};

type Fixture = {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly resultFile: string;
  readonly testFile: string;
  readonly bridgeTestFile: string;
};

const temporaryRoots: string[] = [];
let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-whole-suite-evidence-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const stateRoot = join(
    root,
    "intentarc-packaged-reliability-00000000-0000-4000-8000-000000000000",
  );
  const testFile = join(repositoryRoot, "src", "example.test.ts");
  const bridgeTestFile = join(repositoryRoot, "src", "desktop", "e2e", "packaged-bridge.test.ts");
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await mkdir(join(repositoryRoot, "src", "desktop", "e2e"), { recursive: true });
  await mkdir(stateRoot);
  await writeFile(testFile, "export {};\n");
  await writeFile(bridgeTestFile, "export {};\n");
  fixture = {
    root,
    repositoryRoot: await realpath(repositoryRoot),
    stateRoot: await realpath(stateRoot),
    resultFile: join(await realpath(stateRoot), "whole-suite.json"),
    testFile: await realpath(testFile),
    bridgeTestFile: await realpath(bridgeTestFile),
  };
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

const writeResult = (document: object): Promise<void> =>
  writeFile(fixture.resultFile, JSON.stringify(document));

const writeCorruptedUtf8 = async (
  document: object,
  marker: string,
  resultFile = fixture.resultFile,
): Promise<void> => {
  const source = Buffer.from(JSON.stringify(document));
  const markerBytes = Buffer.from(marker);
  const start = source.indexOf(markerBytes);
  if (start < 0) throw new Error("invalid UTF-8 fixture marker is missing");
  source[start] = 0xc3;
  source[start + 1] = 0x28;
  await writeFile(resultFile, source);
};

const readEvidence = (exitCode: number) => readWholeSuiteEvidence({
  repositoryRoot: fixture.repositoryRoot,
  stateRoot: fixture.stateRoot,
  resultFile: fixture.resultFile,
  exitCode,
});

const failedDocument = ({ name, fullName }: { name: string; fullName: string }) => ({
  success: false,
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numPendingTestSuites: 0,
  numTotalTests: 1,
  numPassedTests: 0,
  numFailedTests: 1,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{
    name,
    status: "failed",
    assertionResults: [{ status: "failed", fullName }],
  }],
});

const passingDocument = () => ({
  success: true,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 9,
  numPassedTests: 8,
  numFailedTests: 0,
  numPendingTests: 1,
  numTodoTests: 0,
  testResults: [],
});

const bridgeResultFile = (ordinal = 1) =>
  join(fixture.stateRoot, `packaged-bridge-${ordinal}.json`);

const writeBridgeResult = (document: object, ordinal = 1) =>
  writeFile(bridgeResultFile(ordinal), JSON.stringify(document));

const readBridgeEvidence = (exitCode: number, ordinal = 1) =>
  readPackagedBridgeEvidence({
    repositoryRoot: fixture.repositoryRoot,
    stateRoot: fixture.stateRoot,
    resultFile: bridgeResultFile(ordinal),
    exitCode,
    ordinal,
  });

const focusedSourceCommit = "737b5d07cc20633f57df1e2b83060b7b72667223";
const focusedTitle =
  "runs the stable installed bridge with Desktop closed and then holds concurrent archive leases";
const ordinal4ResultFile = (attempt = 1) =>
  join(fixture.stateRoot, `ordinal4-focused-${attempt}.json`);
const focusedAssertion = (
  status: "passed" | "failed",
  failureMessages: string[] = [],
) => ({
  ancestorTitles: ["packaged Windows x64 product"],
  fullName: `packaged Windows x64 product ${focusedTitle}`,
  status,
  title: focusedTitle,
  duration: 1,
  failureMessages,
});
const focusedAssertions = (
  status: "passed" | "failed",
  failureMessages: string[] = [],
) => Array.from({ length: 9 }, (_, ordinal) => ordinal === 4
  ? focusedAssertion(status, failureMessages)
  : {
    ancestorTitles: ["packaged Windows x64 product"],
    fullName: `packaged Windows x64 product skipped declaration ${ordinal}`,
    status: "skipped",
    title: `skipped declaration ${ordinal}`,
    failureMessages: [],
  });
const focusedDocument = (
  status: "passed" | "failed",
  failureMessages: string[] = [],
) => ({
  success: status === "passed",
  numTotalTestSuites: 2,
  numPassedTestSuites: status === "passed" ? 2 : 0,
  numFailedTestSuites: status === "failed" ? 2 : 0,
  numPendingTestSuites: 0,
  numTotalTests: 9,
  numPassedTests: status === "passed" ? 1 : 0,
  numFailedTests: status === "failed" ? 1 : 0,
  numPendingTests: 8,
  numTodoTests: 0,
  testResults: [{
    name: fixture.bridgeTestFile,
    status,
    assertionResults: focusedAssertions(status, failureMessages),
  }],
});
const writeFocusedResult = (
  status: "passed" | "failed",
  failureMessages: string[] = [],
  attempt = 1,
) => writeFile(
  ordinal4ResultFile(attempt),
  JSON.stringify(focusedDocument(status, failureMessages)),
);
const readFocusedEvidence = (
  exitCode: number,
  attempt = 1,
  sourceCommit = focusedSourceCommit,
  dependencies?: Parameters<FocusedReader>[1],
) => {
  return (readOrdinal4FocusedEvidence as FocusedReader)({
    repositoryRoot: fixture.repositoryRoot,
    stateRoot: fixture.stateRoot,
    resultFile: ordinal4ResultFile(attempt),
    exitCode,
    attempt,
    sourceCommit,
  }, dependencies);
};

const prefixTitles = [
  "contains the complete runtime and excludes build, SDD, and test-cache inputs",
  "selects and starts the bundled bridge before installer publication",
  "holds the authenticated packaged executable object through process creation",
  "runs full stable-path recovery after a crash following launcher publication",
  focusedTitle,
  "runs a reviewed structured-knowledge journey in the packaged Desktop",
  "retries one transient cleanup lock",
  "bounds persistent cleanup locks",
  "does not retry a nonclosed cleanup error",
] as const;
const prefixResultFile = (attempt = 1) =>
  join(fixture.stateRoot, `ordinal4-prefix-${attempt}.json`);
const prefixAssertion = (
  ordinal: number,
  status: "passed" | "failed" | "pending" | "skipped",
  failureMessages: string[] = [],
) => {
  const title = prefixTitles[ordinal]!;
  const ancestorTitles = ordinal <= 5 ? ["packaged Windows x64 product"] : [];
  return {
    ancestorTitles,
    fullName: ancestorTitles.length === 1
      ? `${ancestorTitles[0]} ${title}`
      : title,
    status,
    title,
    duration: status === "skipped" ? undefined : 1,
    failureMessages,
  };
};
const prefixDocument = (
  failedOrdinal: number | null = null,
  failureMessages: string[] = [],
) => {
  const passed = failedOrdinal === null ? 5 : failedOrdinal;
  const failed = failedOrdinal === null ? 0 : 1;
  return {
    success: failedOrdinal === null,
    numTotalTestSuites: 2,
    numPassedTestSuites: failedOrdinal === null ? 2 : 0,
    numFailedTestSuites: failedOrdinal === null ? 0 : 2,
    numPendingTestSuites: 0,
    numTotalTests: 9,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: 4,
    numTodoTests: 0,
    testResults: [{
      name: fixture.bridgeTestFile,
      status: failedOrdinal === null ? "passed" : "failed",
      assertionResults: Array.from({ length: 9 }, (_, ordinal) => {
        if (failedOrdinal === null) {
          return prefixAssertion(ordinal, ordinal <= 4 ? "passed" : "skipped");
        }
        if (ordinal < failedOrdinal) return prefixAssertion(ordinal, "passed");
        if (ordinal === failedOrdinal) {
          return prefixAssertion(ordinal, "failed", failureMessages);
        }
        return prefixAssertion(ordinal, ordinal <= 4 ? "pending" : "skipped");
      }),
    }],
  };
};
const writePrefixResult = (
  failedOrdinal: number | null = null,
  failureMessages: string[] = [],
  attempt = 1,
) => writeFile(
  prefixResultFile(attempt),
  JSON.stringify(prefixDocument(failedOrdinal, failureMessages)),
);
const readPrefixEvidence = (
  exitCode: number,
  attempt = 1,
  sourceCommit = focusedSourceCommit,
  dependencies?: Parameters<PrefixReader>[1],
) => (readOrdinal4PrefixEvidence as PrefixReader)({
  repositoryRoot: fixture.repositoryRoot,
  stateRoot: fixture.stateRoot,
  resultFile: prefixResultFile(attempt),
  exitCode,
  attempt,
  sourceCommit,
}, dependencies);

describe("readWholeSuiteEvidence", () => {
  // These tests kill default counts, absolute file paths, raw reporter-title leakage,
  // and omitted failed identities.
  it("reads consistent passing counts from the owned whole-suite result", async () => {
    await writeResult({
      success: true,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [],
    });

    await expect(readEvidence(0)).resolves.toEqual({
      passed: 2,
      skipped: 1,
      failed: 0,
      failedTests: [],
      failuresTruncated: false,
    });
  });

  it("emits only a relative file and a closed failed assertion ordinal", async () => {
    await writeResult(failedDocument({
      name: fixture.testFile,
      fullName: `suite rejects ${fixture.testFile} with FIXTURE_SECRET`,
    }));

    await expect(readEvidence(1)).resolves.toEqual({
      passed: 0,
      skipped: 0,
      failed: 1,
      failedTests: [{
        testFile: "src/example.test.ts",
        assertion: "assertion-000000",
      }],
      failuresTruncated: false,
    });
  });

  it("never emits reporter full-name payloads in failed identities", async () => {
    const secret = "C:\\fixtures\\FIXTURE_SECRET\\example.test.ts";
    await writeResult(failedDocument({ name: fixture.testFile, fullName: secret }));

    const evidence = await readEvidence(1);

    expect(evidence.failedTests).toEqual([{
      testFile: "src/example.test.ts",
      assertion: "assertion-000000",
    }]);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("uses the bounded handle reader with the exact production byte limit", async () => {
    await writeResult({
      success: true, numTotalTestSuites: 0, numPassedTestSuites: 0,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 0,
      numPassedTests: 0, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0, testResults: [],
    });
    const calls: { readonly handle: FileHandle; readonly maximumBytes: number }[] = [];

    await expect(readWholeSuiteEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: fixture.resultFile,
      exitCode: 0,
    }, {
      readBoundedUtf8File: async (handle: FileHandle, maximumBytes: number) => {
        calls.push({ handle, maximumBytes });
        return readBoundedUtf8File(handle, maximumBytes);
      },
    })).resolves.toMatchObject({ passed: 0, failed: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maximumBytes).toBe(WHOLE_SUITE_RESULT_MAXIMUM_BYTES);
    expect(typeof calls[0]?.handle.read).toBe("function");
  });

  it("returns the missing code when the fixed result child is absent", async () => {
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_missing",
    });
  });

  it("returns the oversize code before parsing the result", async () => {
    await writeFile(
      fixture.resultFile,
      Buffer.alloc(WHOLE_SUITE_RESULT_MAXIMUM_BYTES + 1, 0x20),
    );
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_oversize",
    });
  });

  it("rejects a real result file that grows after its initial stat and before bounded reading", async () => {
    await writeFile(fixture.resultFile, "[]");
    const before = await lstat(fixture.resultFile);
    const handle = await open(fixture.resultFile, "r");
    try {
      await appendFile(
        fixture.resultFile,
        Buffer.alloc(WHOLE_SUITE_RESULT_MAXIMUM_BYTES, 0x20),
      );
      await expect((await import("../../scripts/windows-packaged-reliability-evidence.mjs"))
        .readBoundedUtf8File(handle, WHOLE_SUITE_RESULT_MAXIMUM_BYTES))
        .rejects.toMatchObject({ code: "whole_suite_evidence_oversize" });
    } finally {
      await handle.close();
    }
    expect(before.size).toBe(2);
  });

  it("returns the inconsistent code when total-test arithmetic is wrong", async () => {
    await writeResult({
      success: true,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 4,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [],
    });
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_inconsistent",
    });
  });

  it("returns inconsistent when a successful exit reports failed tests", async () => {
    await writeResult({
      success: true,
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: fixture.testFile,
        status: "failed",
        assertionResults: [{ status: "failed", fullName: "fails" }],
      }],
    });
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_inconsistent",
    });
  });

  it("returns inconsistent when failed identities do not match the failed count", async () => {
    await writeResult({
      success: false,
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: fixture.testFile,
        status: "failed",
        assertionResults: [{ status: "passed", fullName: "passes" }],
      }],
    });
    await expect(readEvidence(1)).rejects.toMatchObject({
      code: "whole_suite_evidence_inconsistent",
    });
  });

  it("rejects a result child that is a directory", async () => {
    await mkdir(fixture.resultFile);
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_unsafe",
    });
  });

  it("rejects a result child that is a file symlink", async ({ skip }) => {
    const target = join(fixture.root, "linked-result.json");
    await writeFile(target, "{}");
    try {
      await symlink(target, fixture.resultFile, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        skip("Windows file-symlink creation requires an unavailable capability");
        return;
      }
      throw error;
    }
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_unsafe",
    });
  });

  it("rejects a relative result path", async () => {
    await writeResult({
      success: true, numTotalTestSuites: 0, numPassedTestSuites: 0,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 0,
      numPassedTests: 0, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0, testResults: [],
    });
    await expect(readWholeSuiteEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: "whole-suite.json",
      exitCode: 0,
    })).rejects.toMatchObject({ code: "whole_suite_evidence_unsafe" });
  });

  it("rejects a symlinked state-root alias", async ({ skip }) => {
    const alias = join(fixture.root, "state-alias");
    try {
      await symlink(fixture.stateRoot, alias, "junction");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        skip("Windows directory-symlink creation requires an unavailable capability");
        return;
      }
      throw error;
    }
    await expect(readWholeSuiteEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: alias,
      resultFile: join(alias, "whole-suite.json"),
      exitCode: 0,
    })).rejects.toMatchObject({ code: "whole_suite_evidence_unsafe" });
  });

  it("returns malformed for invalid JSON", async () => {
    await writeFile(fixture.resultFile, "{");
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_malformed",
    });
  });

  it("returns malformed for invalid UTF-8 in a selected failed assertion", async () => {
    await writeCorruptedUtf8(
      failedDocument({ name: fixture.testFile, fullName: "selected-title" }),
      "selected-title",
    );
    await expect(readEvidence(1)).rejects.toMatchObject({
      code: "whole_suite_evidence_malformed",
    });
  });

  it("returns malformed for invalid UTF-8 in an ignored reporter field", async () => {
    await writeCorruptedUtf8({
      success: true, numTotalTestSuites: 0, numPassedTestSuites: 0,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 0,
      numPassedTests: 0, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: fixture.testFile,
        status: "passed",
        assertionResults: [{ status: "passed", fullName: "ignored-title" }],
      }],
    }, "ignored-title");
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_malformed",
    });
  });

  it.each([-1, 1.5, "1"])("returns malformed for a non-natural count %j", async (count) => {
    await writeResult({
      success: true, numTotalTestSuites: 1, numPassedTestSuites: 1,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 1,
      numPassedTests: count, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0, testResults: [],
    });
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_malformed",
    });
  });

  it("returns inconsistent when suite totals disagree", async () => {
    await writeResult({
      success: true, numTotalTestSuites: 2, numPassedTestSuites: 1,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 1,
      numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0, testResults: [],
    });
    await expect(readEvidence(0)).rejects.toMatchObject({
      code: "whole_suite_evidence_inconsistent",
    });
  });

  it.each([
    "whole_suite_evidence_missing",
    "whole_suite_evidence_unsafe",
    "whole_suite_evidence_oversize",
    "whole_suite_evidence_malformed",
    "whole_suite_evidence_inconsistent",
  ])("recognizes the closed evidence code %s", (code) => {
    expect(isWholeSuiteEvidenceCode(code)).toBe(true);
  });

  it.each([undefined, null, 1, "whole_suite_evidence_unknown"])(
    "rejects a non-evidence code %j",
    (value) => {
      expect(isWholeSuiteEvidenceCode(value)).toBe(false);
    },
  );

  it.each([
    { exitCode: 0, success: false },
    { exitCode: 1, success: true },
  ])("returns inconsistent when success %j disagrees with the exit", async ({ exitCode, success }) => {
    await writeResult({
      success, numTotalTestSuites: 0, numPassedTestSuites: 0,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 0,
      numPassedTests: 0, numFailedTests: 0, numPendingTests: 0,
      numTodoTests: 0, testResults: [],
    });
    await expect(readEvidence(exitCode)).rejects.toMatchObject({
      code: "whole_suite_evidence_inconsistent",
    });
  });

  it("rejects a relative failed-file name", async () => {
    await writeResult(failedDocument({ name: "src/example.test.ts", fullName: "fails" }));
    await expect(readEvidence(1)).rejects.toMatchObject({
      code: "whole_suite_evidence_unsafe",
    });
  });

  it("rejects an ordinary failed file outside the repository", async () => {
    const outsideFile = join(fixture.root, "outside.test.ts");
    await writeFile(outsideFile, "export {};\n");
    await writeResult(failedDocument({ name: outsideFile, fullName: "fails" }));
    await expect(readEvidence(1)).rejects.toMatchObject({
      code: "whole_suite_evidence_unsafe",
    });
  });

  it("rejects a symlinked failed-test leaf", async ({ skip }) => {
    const target = join(fixture.repositoryRoot, "src", "target.test.ts");
    const linked = join(fixture.repositoryRoot, "src", "linked.test.ts");
    await writeFile(target, "export {};\n");
    try {
      await symlink(target, linked, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        skip("Windows file-symlink creation requires an unavailable capability");
        return;
      }
      throw error;
    }
    await writeResult(failedDocument({ name: linked, fullName: "fails" }));
    await expect(readEvidence(1)).rejects.toMatchObject({
      code: "whole_suite_evidence_unsafe",
    });
  });

  it("sorts failed files by code units before their assertion ordinals", async () => {
    const uppercase = join(fixture.repositoryRoot, "src", "Z.test.ts");
    const lowercase = join(fixture.repositoryRoot, "src", "a.test.ts");
    const nonAscii = join(fixture.repositoryRoot, "src", "ä.test.ts");
    await Promise.all([
      writeFile(uppercase, "export {};\n"),
      writeFile(lowercase, "export {};\n"),
      writeFile(nonAscii, "export {};\n"),
    ]);
    await writeResult({
      success: false, numTotalTestSuites: 3, numPassedTestSuites: 0,
      numFailedTestSuites: 3, numPendingTestSuites: 0, numTotalTests: 3,
      numPassedTests: 0, numFailedTests: 3, numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        { name: nonAscii, status: "failed", assertionResults: [{ status: "failed", fullName: "non-ascii" }] },
        { name: lowercase, status: "failed", assertionResults: [{ status: "failed", fullName: "lowercase" }] },
        { name: uppercase, status: "failed", assertionResults: [{ status: "failed", fullName: "uppercase" }] },
      ],
    });

    await expect(readEvidence(1)).resolves.toMatchObject({
      failedTests: [
        { testFile: "src/Z.test.ts", assertion: "assertion-000000" },
        { testFile: "src/a.test.ts", assertion: "assertion-000000" },
        { testFile: "src/ä.test.ts", assertion: "assertion-000000" },
      ],
    });
  });

  it("sorts and bounds closed failed assertion ordinals", async () => {
    const longAssertion = `${"a".repeat(299)}💥z`;
    const assertions = [
      "zulu", "yankee", "xray", "whiskey", "victor", "uniform", "tango",
      "sierra", "romeo", "quebec", "papa", "oscar", "november", "mike",
      "lima", "kilo", "juliet", "india", "hotel", "golf", longAssertion,
    ];
    await writeResult({
      success: false, numTotalTestSuites: 1, numPassedTestSuites: 0,
      numFailedTestSuites: 1, numPendingTestSuites: 0, numTotalTests: 21,
      numPassedTests: 0, numFailedTests: 21, numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: fixture.testFile,
        status: "failed",
        assertionResults: assertions.map((fullName) => ({ status: "failed", fullName })),
      }],
    });
    await expect(readEvidence(1)).resolves.toEqual({
      passed: 0,
      skipped: 0,
      failed: 21,
      failedTests: [
        { testFile: "src/example.test.ts", assertion: "assertion-000000" },
        { testFile: "src/example.test.ts", assertion: "assertion-000001" },
        { testFile: "src/example.test.ts", assertion: "assertion-000002" },
        { testFile: "src/example.test.ts", assertion: "assertion-000003" },
        { testFile: "src/example.test.ts", assertion: "assertion-000004" },
        { testFile: "src/example.test.ts", assertion: "assertion-000005" },
        { testFile: "src/example.test.ts", assertion: "assertion-000006" },
        { testFile: "src/example.test.ts", assertion: "assertion-000007" },
        { testFile: "src/example.test.ts", assertion: "assertion-000008" },
        { testFile: "src/example.test.ts", assertion: "assertion-000009" },
        { testFile: "src/example.test.ts", assertion: "assertion-000010" },
        { testFile: "src/example.test.ts", assertion: "assertion-000011" },
        { testFile: "src/example.test.ts", assertion: "assertion-000012" },
        { testFile: "src/example.test.ts", assertion: "assertion-000013" },
        { testFile: "src/example.test.ts", assertion: "assertion-000014" },
        { testFile: "src/example.test.ts", assertion: "assertion-000015" },
        { testFile: "src/example.test.ts", assertion: "assertion-000016" },
        { testFile: "src/example.test.ts", assertion: "assertion-000017" },
        { testFile: "src/example.test.ts", assertion: "assertion-000018" },
        { testFile: "src/example.test.ts", assertion: "assertion-000019" },
      ],
      failuresTruncated: true,
    });
  });
});

describe("readPackagedBridgeEvidence", () => {
  it("reads consistent passing counts from the exact ordinal child", async () => {
    await writeBridgeResult(passingDocument());

    await expect(readBridgeEvidence(0)).resolves.toEqual({
      passed: 8,
      skipped: 1,
      failed: 0,
      failedTests: [],
      failuresTruncated: false,
    });
  });

  it("emits only a repository-relative file and synthetic failed assertion ordinal", async () => {
    const secret = `private title ${fixture.bridgeTestFile} FIXTURE_SECRET`;
    await writeBridgeResult(failedDocument({
      name: fixture.bridgeTestFile,
      fullName: secret,
    }));

    const evidence = await readBridgeEvidence(1);

    expect(evidence).toEqual({
      passed: 0,
      skipped: 0,
      failed: 1,
      failedTests: [{
        testFile: "src/desktop/e2e/packaged-bridge.test.ts",
        assertion: "assertion-000000",
      }],
      failuresTruncated: false,
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("caps packaged-bridge identities at twenty and reports truncation", async () => {
    await writeBridgeResult({
      success: false,
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 21,
      numPassedTests: 0,
      numFailedTests: 21,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: fixture.bridgeTestFile,
        status: "failed",
        assertionResults: Array.from({ length: 21 }, (_, ordinal) => ({
          status: "failed",
          fullName: `private failure ${ordinal}`,
        })),
      }],
    });

    const evidence = await readBridgeEvidence(1);

    expect(evidence.failedTests).toHaveLength(20);
    expect(evidence.failedTests.at(0)).toEqual({
      testFile: "src/desktop/e2e/packaged-bridge.test.ts",
      assertion: "assertion-000000",
    });
    expect(evidence.failedTests.at(-1)).toEqual({
      testFile: "src/desktop/e2e/packaged-bridge.test.ts",
      assertion: "assertion-000019",
    });
    expect(evidence.failuresTruncated).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("private failure");
  });

  it("uses the exact eight MiB bounded handle reader", async () => {
    await writeBridgeResult(passingDocument());
    const calls: { readonly handle: FileHandle; readonly maximumBytes: number }[] = [];

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: bridgeResultFile(),
      exitCode: 0,
      ordinal: 1,
    }, {
      readBoundedUtf8File: async (handle: FileHandle, maximumBytes: number) => {
        calls.push({ handle, maximumBytes });
        return readBoundedUtf8File(handle, maximumBytes);
      },
    })).resolves.toMatchObject({ passed: 8, failed: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maximumBytes).toBe(WHOLE_SUITE_RESULT_MAXIMUM_BYTES);
    expect(typeof calls[0]?.handle.read).toBe("function");
  });

  it("reads the opened handle even if the result path is replaced after validation", async () => {
    await writeBridgeResult(passingDocument());

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: bridgeResultFile(),
      exitCode: 0,
      ordinal: 1,
    }, {
      readBoundedUtf8File: async (handle: FileHandle, maximumBytes: number) => {
        await rm(bridgeResultFile());
        await writeFile(bridgeResultFile(), "private replacement payload");
        return readBoundedUtf8File(handle, maximumBytes);
      },
    })).resolves.toMatchObject({ passed: 8, failed: 0 });
  });

  it("rejects a file identity swap across lstat, open, fstat, and lstat", async () => {
    await writeBridgeResult(passingDocument());
    const outside = join(fixture.root, "different.json");
    await writeFile(outside, JSON.stringify(passingDocument()));
    const differentIdentity = await lstat(outside);
    let resultStats = 0;

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: bridgeResultFile(),
      exitCode: 0,
      ordinal: 1,
    }, {
      lstat: async (path: string) => {
        if (path === bridgeResultFile() && resultStats++ === 0) return differentIdentity;
        return lstat(path);
      },
    })).rejects.toMatchObject({ code: "packaged_bridge_evidence_unsafe" });
  });

  it("returns the missing code when the exact ordinal child is absent", async () => {
    await expect(readBridgeEvidence(0)).rejects.toMatchObject({
      code: "packaged_bridge_evidence_missing",
    });
  });

  it("returns the oversize code before parsing more than eight MiB", async () => {
    await writeFile(
      bridgeResultFile(),
      Buffer.alloc(WHOLE_SUITE_RESULT_MAXIMUM_BYTES + 1, 0x20),
    );
    await expect(readBridgeEvidence(0)).rejects.toMatchObject({
      code: "packaged_bridge_evidence_oversize",
    });
  });

  it("returns malformed for invalid UTF-8 in an ignored reporter field", async () => {
    await writeCorruptedUtf8({
      ...passingDocument(),
      testResults: [{
        name: fixture.bridgeTestFile,
        status: "passed",
        assertionResults: [{ status: "passed", fullName: "ignored-title" }],
      }],
    }, "ignored-title", bridgeResultFile());

    await expect(readBridgeEvidence(0)).rejects.toMatchObject({
      code: "packaged_bridge_evidence_malformed",
    });
  });

  it.each([
    { exitCode: 0, success: false },
    { exitCode: 1, success: true },
  ])("returns inconsistent when success $success disagrees with exit $exitCode", async ({ exitCode, success }) => {
    await writeBridgeResult({
      ...passingDocument(),
      success,
    });

    await expect(readBridgeEvidence(exitCode)).rejects.toMatchObject({
      code: "packaged_bridge_evidence_inconsistent",
    });
  });

  it("returns inconsistent when result arithmetic is invalid", async () => {
    await writeBridgeResult({
      ...passingDocument(),
      numTotalTests: 10,
    });

    await expect(readBridgeEvidence(0)).rejects.toMatchObject({
      code: "packaged_bridge_evidence_inconsistent",
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-positive-safe-integer ordinal %s",
    async (ordinal) => {
      await writeBridgeResult(passingDocument());
      await expect(readPackagedBridgeEvidence({
        repositoryRoot: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
        resultFile: bridgeResultFile(),
        exitCode: 0,
        ordinal,
      })).rejects.toMatchObject({ code: "packaged_bridge_evidence_unsafe" });
    },
  );

  it("rejects a filename selected by the caller instead of the exact ordinal child", async () => {
    const selected = join(fixture.stateRoot, "caller-selected.json");
    await writeFile(selected, JSON.stringify(passingDocument()));

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: selected,
      exitCode: 0,
      ordinal: 1,
    })).rejects.toMatchObject({ code: "packaged_bridge_evidence_unsafe" });
  });

  it("rejects an ordinal that does not match the exact child filename", async () => {
    await writeBridgeResult(passingDocument(), 1);

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: bridgeResultFile(1),
      exitCode: 0,
      ordinal: 2,
    })).rejects.toMatchObject({ code: "packaged_bridge_evidence_unsafe" });
  });

  it("rejects a result path that escapes the canonical state root", async () => {
    const escaped = join(fixture.root, "packaged-bridge-1.json");
    await writeFile(escaped, JSON.stringify(passingDocument()));

    await expect(readPackagedBridgeEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: escaped,
      exitCode: 0,
      ordinal: 1,
    })).rejects.toMatchObject({ code: "packaged_bridge_evidence_unsafe" });
  });

  it.each([
    "packaged_bridge_evidence_missing",
    "packaged_bridge_evidence_unsafe",
    "packaged_bridge_evidence_oversize",
    "packaged_bridge_evidence_malformed",
    "packaged_bridge_evidence_inconsistent",
  ])("recognizes the closed packaged-bridge evidence code %s", (code) => {
    expect(isPackagedBridgeEvidenceCode(code)).toBe(true);
  });

  it.each([undefined, null, 1, "packaged_bridge_evidence_unknown", "whole_suite_evidence_malformed"])(
    "rejects a non-packaged-bridge evidence code %j",
    (value) => {
      expect(isPackagedBridgeEvidenceCode(value)).toBe(false);
    },
  );
});

describe("readOrdinal4FocusedEvidence", () => {
  it("reads a passing exact declaration result without retaining reporter fields", async () => {
    await writeFocusedResult("passed");

    await expect(readFocusedEvidence(0)).resolves.toEqual({
      outcome: "passed",
      category: null,
    });
  });

  it("pins the immutable source contract separately from an execution commit", () => {
    expect(evidenceModule.ORDINAL4_FOCUSED_SOURCE_COMMIT).toBe(focusedSourceCommit);
    expect(ordinal4FocusedResultFilename(30)).toBe("ordinal4-focused-30.json");
    expect(() => ordinal4FocusedResultFilename(31)).toThrowError(
      expect.objectContaining({ code: "ordinal4_evidence_unsafe" }),
    );
  });

  it.each([
    {
      category: "bridge_promotion_eperm_exhausted",
      failure: () => [
        "Error: EPERM: operation not permitted, rename 'private-source' -> 'private-target'",
        `    at promoteBridgeStagingDirectory (${join(fixture.repositoryRoot, "src", "desktop", "bridge-install.ts")}:535:7)`,
      ].join("\n"),
    },
    {
      category: "protocol_verification_timeout",
      failure: () => [
        "Error: IntentArc bridge MCP protocol verification timed out.",
        "    at Timeout._onTimeout (src/desktop/bridge-protocol-verifier.ts:363:17)",
      ].join("\n"),
    },
    {
      category: "protocol_verification_timeout",
      failure: () => [
        "Error: Bridge staged protocol verification failed: IntentArc bridge MCP protocol verification timed out.",
        `    at verify (${pathToFileURL(join(fixture.repositoryRoot, "src", "desktop", "e2e", "packaged-bridge.test.ts")).href}:438:17)`,
      ].join("\n"),
    },
    {
      category: "protocol_child_close_unproven",
      failure: () => [
        "Error: Bridge active protocol verification failed: IntentArc bridge MCP protocol child settlement timed out.",
        "    at verify (src/desktop/e2e/packaged-bridge.test.ts:580:17)",
      ].join("\n"),
    },
    {
      category: "protocol_child_close_unproven",
      failure: () => [
        "Error: IntentArc bridge MCP protocol process ownership is unavailable.",
        "    at verify (src/desktop/bridge-protocol-verifier.ts:331:13)",
      ].join("\n"),
    },
    {
      category: "archive_lease_assertion_timeout",
      failure: () => [
        "Error: Timed out waiting for packaged process state.",
        "    at waitFor (src/desktop/e2e/packaged-bridge.test.ts:82:13)",
        "    at src/desktop/e2e/packaged-bridge.test.ts:620:5",
      ].join("\n"),
    },
    {
      category: "fixture_cleanup_failure",
      failure: () => [
        "Error: EBUSY: resource busy or locked, rmdir 'private-fixture'",
        "    at removeTemporaryRoot (src/desktop/e2e/packaged-bridge.test.ts:135:7)",
        "    at src/desktop/e2e/packaged-bridge.test.ts:161:43",
      ].join("\n"),
    },
    {
      category: "fixture_cleanup_failure",
      failure: () => [
        "Error: EPERM: operation not permitted, rmdir 'private-fixture'",
        "    at removeTemporaryRoot (src/desktop/e2e/packaged-bridge.test.ts:146:7)",
        "    at src/desktop/e2e/packaged-bridge.test.ts:691:5",
      ].join("\n"),
    },
  ] as const)("classifies only the pinned $category signature", async ({ category, failure }) => {
    await writeFocusedResult("failed", [failure()]);

    const evidence = await readFocusedEvidence(1);

    expect(evidence).toEqual({ outcome: "failed", category });
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(JSON.stringify(evidence)).not.toContain("packaged-bridge.test.ts");
  });

  it.each([
    {
      name: "promotion has only a lookalike suffix path",
      failure: () => [
        "Error: EPERM: operation not permitted, rename 'a' -> 'b'",
        `    at promote (${join(fixture.root, "lookalike", "src", "desktop", "bridge-install.ts")}:535:7)`,
      ].join("\n"),
    },
    {
      name: "promotion token says renamed instead of rename",
      failure: () => [
        "Error: EPERM: operation not permitted, renamed 'a' -> 'b'",
        "    at promote (src/desktop/bridge-install.ts:535:7)",
      ].join("\n"),
    },
    {
      name: "boundary appears as embedded text with column zero",
      failure: () => "Error: IntentArc bridge MCP protocol verification timed out. diagnostic=src/desktop/e2e/packaged-bridge.test.ts:438:0",
    },
    {
      name: "archive timeout has only the shared helper frame",
      failure: () => [
        "Error: Timed out waiting for packaged process state.",
        "    at waitFor (src/desktop/e2e/packaged-bridge.test.ts:82:13)",
      ].join("\n"),
    },
    {
      name: "archive timeout has an adjacent non-lease callsite",
      failure: () => [
        "Error: Timed out waiting for packaged process state.",
        "    at waitFor (src/desktop/e2e/packaged-bridge.test.ts:82:13)",
        "    at src/desktop/e2e/packaged-bridge.test.ts:619:5",
      ].join("\n"),
    },
    {
      name: "cleanup has only the helper frame",
      failure: () => [
        "Error: EBUSY: resource busy or locked, rmdir 'fixture'",
        "    at removeTemporaryRoot (src/desktop/e2e/packaged-bridge.test.ts:135:7)",
      ].join("\n"),
    },
  ])("returns unknown when $name", async ({ failure }) => {
    await writeFocusedResult("failed", [failure()]);
    await expect(readFocusedEvidence(1)).resolves.toMatchObject({
      outcome: "failed",
      category: "unknown",
      fingerprint: {
        schemaVersion: 1,
        completeness: "complete",
      },
    });
  });

  it("returns unknown when distinct closed signatures conflict", async () => {
    await writeFocusedResult("failed", [
      [
        "Error: EPERM: operation not permitted, rename 'a' -> 'b'",
        "    at promoteBridgeStagingDirectory (src/desktop/bridge-install.ts:535:7)",
      ].join("\n"),
      [
        "Error: Timed out waiting for packaged process state.",
        "    at waitFor (src/desktop/e2e/packaged-bridge.test.ts:82:13)",
        "    at src/desktop/e2e/packaged-bridge.test.ts:640:7",
      ].join("\n"),
    ]);

    await expect(readFocusedEvidence(1)).resolves.toMatchObject({
      outcome: "failed",
      category: "unknown",
      fingerprint: {
        schemaVersion: 1,
        completeness: "complete",
      },
    });
  });

  it("requires the exact immutable source commit before opening the document", async () => {
    await writeFocusedResult("passed");

    await expect(readFocusedEvidence(0, 1, "0".repeat(40))).rejects.toMatchObject({
      code: "ordinal4_evidence_unsafe",
    });
  });

  it("rejects a caller-selected result child", async () => {
    await writeFile(
      join(fixture.stateRoot, "caller-selected.json"),
      JSON.stringify(focusedDocument("passed")),
    );
    await expect(readOrdinal4FocusedEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: join(fixture.stateRoot, "caller-selected.json"),
      exitCode: 0,
      attempt: 1,
      sourceCommit: focusedSourceCommit,
    })).rejects.toMatchObject({ code: "ordinal4_evidence_unsafe" });
  });

  it("rejects a document that is not exactly one selected test and assertion", async () => {
    await writeFile(ordinal4ResultFile(), JSON.stringify({
      ...focusedDocument("passed"),
      numTotalTests: 10,
      numPassedTests: 2,
    }));

    await expect(readFocusedEvidence(0)).rejects.toMatchObject({
      code: "ordinal4_evidence_inconsistent",
    });
  });

  it("uses the existing validated eight MiB handle reader boundary", async () => {
    await writeFocusedResult("passed");
    const calls: { readonly handle: FileHandle; readonly maximumBytes: number }[] = [];

    await expect(readFocusedEvidence(0, 1, focusedSourceCommit, {
      readBoundedUtf8File: async (handle, maximumBytes) => {
        calls.push({ handle, maximumBytes });
        return readBoundedUtf8File(handle, maximumBytes);
      },
    })).resolves.toEqual({ outcome: "passed", category: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maximumBytes).toBe(WHOLE_SUITE_RESULT_MAXIMUM_BYTES);
  });

  it.each([-1, 2, 1.5])("rejects exit code %s outside the exact 0/1 contract", async (exitCode) => {
    await writeFocusedResult("failed", ["private failure"]);
    await expect(readFocusedEvidence(exitCode)).rejects.toMatchObject({
      code: "ordinal4_evidence_unsafe",
    });
  });

  it("returns a non-serialized identity for the exact opened raw result", async () => {
    await writeFocusedResult("passed");
    const evidence = await readFocusedEvidence(0);
    const rawIdentity = await lstat(ordinal4ResultFile(), { bigint: true });
    const token = evidence.retirementIdentity as Record<PropertyKey, unknown>;
    const exactIdentity = {
      canonicalPath: await realpath(ordinal4ResultFile()),
      dev: String(rawIdentity.dev),
      ino: String(rawIdentity.ino),
    };

    expect(evidenceModule.matchesOrdinal4RetirementIdentity).toBeTypeOf("function");
    expect(token).toBeDefined();
    expect(Object.getPrototypeOf(token)).toBe(null);
    expect(token.constructor).toBeUndefined();
    expect(Object.isFrozen(token)).toBe(true);
    expect(evidenceModule.matchesOrdinal4RetirementIdentity!(
      token,
      exactIdentity,
    )).toBe(true);
    expect(evidenceModule.matchesOrdinal4RetirementIdentity!(
      Object.freeze({}), exactIdentity,
    )).toBe(false);
    expect(evidenceModule.matchesOrdinal4RetirementIdentity!(
      Object.freeze(Object.create(null)), exactIdentity,
    )).toBe(false);
    expect(Object.keys(evidence)).toEqual(["outcome", "category"]);
    expect(JSON.stringify(evidence)).toBe('{"outcome":"passed","category":null}');
    expect(JSON.stringify(token)).toBeUndefined();
  });

  it.each([
    "ordinal4_evidence_missing",
    "ordinal4_evidence_unsafe",
    "ordinal4_evidence_oversize",
    "ordinal4_evidence_malformed",
    "ordinal4_evidence_inconsistent",
  ])("recognizes the closed focused evidence code %s", (code) => {
    expect(isOrdinal4FocusedEvidenceCode(code)).toBe(true);
  });

  it.each([undefined, null, 1, "ordinal4_evidence_unknown", "packaged_bridge_evidence_unsafe"])(
    "rejects a non-focused evidence code %j",
    (value) => {
      expect(isOrdinal4FocusedEvidenceCode(value)).toBe(false);
    },
  );
});

describe("readOrdinal4PrefixEvidence", () => {
  it("pins a fixed twenty-attempt prefix result contract", () => {
    expect(evidenceModule.ORDINAL4_PREFIX_MAXIMUM_ATTEMPTS).toBe(20);
    expect(ordinal4PrefixResultFilename(20)).toBe("ordinal4-prefix-20.json");
    expect(() => ordinal4PrefixResultFilename(21)).toThrowError(
      expect.objectContaining({ code: "ordinal4_prefix_evidence_unsafe" }),
    );
  });

  it("accepts only the exact five-pass four-skip prefix", async () => {
    await writePrefixResult();

    const evidence = await readPrefixEvidence(0);

    expect(evidence).toEqual({ outcome: "passed", category: null });
    expect(Object.keys(evidence)).toEqual(["outcome", "category"]);
    expect(JSON.stringify(evidence)).toBe('{"outcome":"passed","category":null}');
  });

  it.each([0, 1, 2, 3])(
    "normalizes declaration %s as a generic prefix precondition failure",
    async (failedOrdinal) => {
      const secret = `private precondition failure ${failedOrdinal}`;
      await writePrefixResult(failedOrdinal, [secret]);

      const evidence = await readPrefixEvidence(1);

      expect(evidence).toEqual({
        outcome: "failed",
        category: "prefix_precondition_failed",
      });
      expect(JSON.stringify(evidence)).not.toContain(secret);
    },
  );

  it("classifies the fifth declaration only after four exact passes", async () => {
    const secret = "private promotion paths";
    await writePrefixResult(4, [[
      `Error: EPERM: operation not permitted, rename '${secret}' -> 'target'`,
      "    at promoteBridgeStagingDirectory (src/desktop/bridge-install.ts:535:7)",
    ].join("\n")]);

    const evidence = await readPrefixEvidence(1);

    expect(evidence).toEqual({
      outcome: "failed",
      category: "bridge_promotion_eperm_exhausted",
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it.each([
    {
      name: "a passed declaration appears after the failed declaration",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[3]!.status = "passed";
      },
    },
    {
      name: "the fifth declaration runs after an earlier failure",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[4]!.status = "passed";
      },
    },
    {
      name: "a later declaration runs",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[5]!.status = "passed";
      },
    },
  ])("rejects an inconsistent bail shape when $name", async ({ mutate }) => {
    const document = prefixDocument(2, ["failure"]);
    mutate(document);
    await writeFile(prefixResultFile(), JSON.stringify(document));

    await expect(readPrefixEvidence(1)).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_inconsistent",
    });
  });

  it.each([
    {
      name: "a title changes",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[0]!.title = "lookalike";
      },
    },
    {
      name: "an ancestor changes",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[6]!.ancestorTitles = ["lookalike"];
      },
    },
    {
      name: "a full name changes",
      mutate: (document: ReturnType<typeof prefixDocument>) => {
        document.testResults[0]!.assertionResults[4]!.fullName = "lookalike";
      },
    },
  ])("rejects malformed declaration identity when $name", async ({ mutate }) => {
    const document = prefixDocument();
    mutate(document);
    await writeFile(prefixResultFile(), JSON.stringify(document));

    await expect(readPrefixEvidence(0)).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_malformed",
    });
  });

  it("rejects a second failure instead of accepting an arbitrary reporter shape", async () => {
    const document = prefixDocument(2, ["first"]);
    document.testResults[0]!.assertionResults[3] = prefixAssertion(3, "failed", ["second"]);
    document.numFailedTests = 2;

    await writeFile(prefixResultFile(), JSON.stringify(document));
    await expect(readPrefixEvidence(1)).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_inconsistent",
    });
  });

  it("uses the shared bounded reader and opaque retirement identity", async () => {
    await writePrefixResult();
    const calls: number[] = [];

    const evidence = await readPrefixEvidence(0, 1, focusedSourceCommit, {
      readBoundedUtf8File: async (handle, maximumBytes) => {
        calls.push(maximumBytes);
        return readBoundedUtf8File(handle, maximumBytes);
      },
    });
    const details = await lstat(prefixResultFile(), { bigint: true });
    const identity = {
      canonicalPath: await realpath(prefixResultFile()),
      dev: String(details.dev),
      ino: String(details.ino),
    };

    expect(calls).toEqual([WHOLE_SUITE_RESULT_MAXIMUM_BYTES]);
    expect(evidenceModule.matchesOrdinal4RetirementIdentity!(
      evidence.retirementIdentity,
      identity,
    )).toBe(true);
    expect(JSON.stringify(evidence.retirementIdentity)).toBeUndefined();
  });

  it("requires the exact source pin, result child, file, and exit code", async () => {
    await writePrefixResult();
    await expect(readPrefixEvidence(0, 1, "0".repeat(40))).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_unsafe",
    });
    await expect(readOrdinal4PrefixEvidence({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      resultFile: ordinal4ResultFile(),
      exitCode: 0,
      attempt: 1,
      sourceCommit: focusedSourceCommit,
    })).rejects.toMatchObject({ code: "ordinal4_prefix_evidence_unsafe" });
    await expect(readPrefixEvidence(2)).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_unsafe",
    });

    const outside = join(fixture.root, "packaged-bridge.test.ts");
    await writeFile(outside, "export {};\n");
    await writeFile(prefixResultFile(), JSON.stringify({
      ...prefixDocument(),
      testResults: [{
        ...prefixDocument().testResults[0],
        name: outside,
      }],
    }));
    await expect(readPrefixEvidence(0)).rejects.toMatchObject({
      code: "ordinal4_prefix_evidence_unsafe",
    });
  });

  it.each([
    "ordinal4_prefix_evidence_missing",
    "ordinal4_prefix_evidence_unsafe",
    "ordinal4_prefix_evidence_oversize",
    "ordinal4_prefix_evidence_malformed",
    "ordinal4_prefix_evidence_inconsistent",
  ])("recognizes the closed prefix evidence code %s", (code) => {
    expect(isOrdinal4PrefixEvidenceCode(code)).toBe(true);
  });

  it.each([undefined, null, 1, "ordinal4_prefix_evidence_unknown", "ordinal4_evidence_unsafe"])(
    "rejects a non-prefix evidence code %j",
    (value) => {
      expect(isOrdinal4PrefixEvidenceCode(value)).toBe(false);
    },
  );
});

describe("ordinal-4 unknown failure fingerprint", () => {
  const failedPrefix = async (failureMessages: string[]) => {
    await writePrefixResult(4, failureMessages);
    return readPrefixEvidence(1);
  };

  it("adds the exact deeply frozen fingerprint only to an unknown ordinal-4 failure", async () => {
    const secret = "private fingerprint payload";
    const evidence = await failedPrefix([[
      `Error: EACCES: ${secret}`,
      "    at async promoteBridgeStagingDirectory (src/desktop/bridge-install.ts:520:7)",
      "    at async src/desktop/e2e/packaged-bridge.test.ts:405:5",
    ].join("\n")]);

    expect(evidence).toEqual({
      outcome: "failed",
      category: "unknown",
      fingerprint: {
        schemaVersion: 1,
        errorCode: "EACCES",
        sourceBoundary: "bridge_activation_promotion",
        phase: "initial_install",
        completeness: "complete",
      },
    });
    expect(Object.keys(evidence)).toEqual(["outcome", "category", "fingerprint"]);
    expect(Object.isFrozen(evidence.fingerprint)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toContain("bridge-install.ts");
  });

  it("adds the same closed fingerprint to focused unknown evidence", async () => {
    await writeFocusedResult("failed", [[
      "Error: ECONNRESET: private socket detail",
      " ❯ src/desktop/e2e/packaged-bridge.test.ts:600:9",
    ].join("\n")]);

    await expect(readFocusedEvidence(1)).resolves.toEqual({
      outcome: "failed",
      category: "unknown",
      fingerprint: {
        schemaVersion: 1,
        errorCode: "ECONNRESET",
        sourceBoundary: "ordinal4_declaration",
        phase: "update_install",
        completeness: "complete",
      },
    });
  });

  it.each([
    "EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ENOENT", "EEXIST",
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE",
  ])("accepts allowlisted anchored direct error code %s", async (errorCode) => {
    const evidence = await failedPrefix([`Error: ${errorCode}: private detail`]);
    expect(evidence.fingerprint?.errorCode).toBe(errorCode);
  });

  it.each([
    {
      name: "nested cause header",
      message: "Wrapper\nCaused by: Error: EBUSY: private detail",
      errorCode: "EBUSY",
    },
    {
      name: "active launcher wrapper",
      message: "Error: Bridge active launcher health failed: spawn EPIPE private detail",
      errorCode: "EPIPE",
    },
    {
      name: "staged protocol wrapper",
      message: "Error: Bridge staged protocol verification failed: ECONNREFUSED private detail",
      errorCode: "ECONNREFUSED",
    },
    {
      name: "active protocol wrapper",
      message: "Error: Bridge active protocol verification failed: ETIMEDOUT private detail",
      errorCode: "ETIMEDOUT",
    },
  ])("accepts the exact anchored $name", async ({ message, errorCode }) => {
    const evidence = await failedPrefix([message]);
    expect(evidence.fingerprint?.errorCode).toBe(errorCode);
  });

  it("reads a trailing code from a direct header and a bare exact static wrapper", async () => {
    const direct = await failedPrefix(["Error: spawn private-child EPIPE"]);
    expect(direct.fingerprint?.errorCode).toBe("EPIPE");

    await writePrefixResult(4, [
      "Bridge active launcher health failed: ECONNRESET private detail",
    ]);
    const wrapped = await readPrefixEvidence(1);
    expect(wrapped.fingerprint?.errorCode).toBe("ECONNRESET");
  });

  it("conflicts when one anchored header contains two distinct allowlisted codes", async () => {
    const evidence = await failedPrefix([
      "Error: first EACCES then EBUSY private detail",
    ]);
    expect(evidence.fingerprint?.errorCode).toBe("conflict");
  });

  it("ignores embedded or unallowlisted code-shaped text and conflicts on two allowlisted codes", async () => {
    const embedded = await failedPrefix([
      "Diagnostic said Error: EPERM: but this is not an anchored header",
      "Error: EWHATEVER: private detail",
    ]);
    expect(embedded.fingerprint?.errorCode).toBe("unknown");

    await writePrefixResult(4, [
      "Error: EACCES: private one",
      "Caused by: Error: EBUSY: private two",
    ]);
    const conflict = await readPrefixEvidence(1);
    expect(conflict.fingerprint?.errorCode).toBe("conflict");
  });

  it.each([
    {
      sourceBoundary: "bridge_activation_promotion",
      line: "    at promoteBridgeStagingDirectory (src/desktop/bridge-install.ts:396:3)",
    },
    {
      sourceBoundary: "bridge_install_other",
      line: "    at installBridgeVersion (src/desktop/bridge-install.ts:700:3)",
    },
    {
      sourceBoundary: "bridge_protocol_verifier",
      line: "    at async verifyBridgeProtocolCompatibility (src/desktop/bridge-protocol-verifier.ts:200:3)",
    },
    {
      sourceBoundary: "bridge_payload_build",
      line: "    at buildIntentArcBridge (scripts/build-bridge.mjs:362:3)",
    },
    {
      sourceBoundary: "packaged_fixture_cleanup",
      line: " ❯ src/desktop/e2e/packaged-bridge.test.ts:135:7",
    },
    {
      sourceBoundary: "ordinal4_declaration",
      line: "    at src/desktop/e2e/packaged-bridge.test.ts:500:5",
    },
    {
      sourceBoundary: "other_repository",
      line: "    at createApplication (src/app/create-application.ts:80:5)",
    },
  ])("maps a strict frame to $sourceBoundary", async ({ sourceBoundary, line }) => {
    const evidence = await failedPrefix([["Error: EACCES: private", line].join("\n")]);
    expect(evidence.fingerprint?.sourceBoundary).toBe(sourceBoundary);
  });

  it.each([
    { message: "Error: EACCES: operation not permitted, rename 'a' -> 'b'", want: "filesystem_rename" },
    { message: "Error: EACCES: operation not permitted, rmdir 'a'", want: "filesystem_remove" },
    { message: "Error: EACCES: spawn child private", want: "child_process" },
  ])("maps an exact syscall to $want", async ({ message, want }) => {
    const evidence = await failedPrefix([message]);
    expect(evidence.fingerprint?.sourceBoundary).toBe(want);
  });

  it("uses repository-leaf precedence and conflicts only at the winning specificity", async () => {
    const precedence = await failedPrefix([[
      "Error: EACCES: operation not permitted, rename 'a' -> 'b'",
      "    at async verify (src/desktop/bridge-protocol-verifier.ts:200:3)",
      "    at src/desktop/e2e/packaged-bridge.test.ts:405:5",
    ].join("\n")]);
    expect(precedence.fingerprint?.sourceBoundary).toBe("bridge_protocol_verifier");

    await writePrefixResult(4, [[
      "Error: EACCES: private",
      "    at verify (src/desktop/bridge-protocol-verifier.ts:200:3)",
      "    at install (src/desktop/bridge-install.ts:700:3)",
    ].join("\n")]);
    const conflict = await readPrefixEvidence(1);
    expect(conflict.fingerprint?.sourceBoundary).toBe("conflict");
  });

  it("rejects a suffix-lookalike absolute frame outside the canonical repository", async () => {
    const lookalike = join(
      fixture.root,
      "lookalike",
      "src",
      "desktop",
      "bridge-protocol-verifier.ts",
    );
    const evidence = await failedPrefix([[
      "Error: EACCES: private",
      `    at verify (${lookalike}:200:3)`,
    ].join("\n")]);
    expect(evidence.fingerprint?.sourceBoundary).toBe("unknown");
  });

  it.each([
    { phase: "fixture_setup", line: 393 },
    { phase: "initial_install", line: 447 },
    { phase: "executable_lock", line: 449 },
    { phase: "archive_connection", line: 533 },
    { phase: "update_build", line: 535 },
    { phase: "update_install", line: 616 },
    { phase: "archive_leases", line: 618 },
    { phase: "pending_update", line: 689 },
    { phase: "fixture_cleanup", line: 117 },
    { phase: "fixture_cleanup", line: 694 },
  ])("maps pinned ordinal-4 line $line to $phase", async ({ phase, line }) => {
    const evidence = await failedPrefix([[
      "Error: EACCES: private",
      `    at src/desktop/e2e/packaged-bridge.test.ts:${line}:5`,
    ].join("\n")]);
    expect(evidence.fingerprint?.phase).toBe(phase);
  });

  it("uses unattributed fallbacks and conflicts on two distinct pinned phases", async () => {
    const install = await failedPrefix([[
      "Error: EACCES: private",
      "    at installBridgeVersion (src/desktop/bridge-install.ts:700:3)",
    ].join("\n")]);
    expect(install.fingerprint?.phase).toBe("install_unattributed");

    await writePrefixResult(4, [[
      "Error: EACCES: private",
      "    at verifyBridgeProtocolCompatibility (src/desktop/bridge-protocol-verifier.ts:200:3)",
    ].join("\n")]);
    const protocol = await readPrefixEvidence(1);
    expect(protocol.fingerprint?.phase).toBe("protocol_unattributed");

    await writePrefixResult(4, [[
      "Error: EACCES: private",
      "    at src/desktop/e2e/packaged-bridge.test.ts:405:5",
      "    at src/desktop/e2e/packaged-bridge.test.ts:620:5",
    ].join("\n")]);
    const conflict = await readPrefixEvidence(1);
    expect(conflict.fingerprint?.phase).toBe("conflict");
  });

  it("deduplicates repeated observations without exposing raw input", async () => {
    const message = [
      "Error: EACCES: private duplicate",
      "Caused by: Error: EACCES: private duplicate",
      "    at async verify (src/desktop/bridge-protocol-verifier.ts:200:3)",
      " ❯ src/desktop/bridge-protocol-verifier.ts:200:3",
    ].join("\n");
    const evidence = await failedPrefix([message, message]);
    expect(evidence.fingerprint).toEqual({
      schemaVersion: 1,
      errorCode: "EACCES",
      sourceBoundary: "bridge_protocol_verifier",
      phase: "protocol_unattributed",
      completeness: "complete",
    });
    expect(JSON.stringify(evidence)).not.toContain("private duplicate");
  });

  it.each([
    {
      name: "message cap",
      messages: Array.from({ length: 9 }, () => "Error: EACCES: private"),
    },
    {
      name: "logical line cap",
      messages: [Array.from({ length: 257 }, () => "private").join("\n")],
    },
    {
      name: "frame candidate cap",
      messages: [Array.from(
        { length: 65 },
        () => "    at src/desktop/e2e/packaged-bridge.test.ts:405:5",
      ).join("\n")],
    },
    {
      name: "error header cap",
      messages: [Array.from({ length: 17 }, () => "Error: EACCES: private").join("\n")],
    },
    {
      name: "line length cap",
      messages: [`Error: EACCES: ${"x".repeat(4097)}`],
    },
  ])("discards all partial observations when the $name is exceeded", async ({ messages }) => {
    const evidence = await failedPrefix(messages);
    expect(evidence.fingerprint).toEqual({
      schemaVersion: 1,
      errorCode: "unknown",
      sourceBoundary: "unknown",
      phase: "unknown",
      completeness: "truncated",
    });
  });
});
