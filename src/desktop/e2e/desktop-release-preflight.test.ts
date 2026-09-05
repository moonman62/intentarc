import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPreflightReceipt,
  assertWritablePreflightReceipt,
  completePreflightReceipt,
  createInitialPreflightReceipt,
  failPreflightReceipt,
  parsePreflightArguments,
  preflightChecks,
  preparePreflightReceiptFailure,
  receiptPathForRun,
  sanitizePreflightEnvironment,
  withCheckState,
} from "../../../scripts/desktop-release-preflight-contract.mjs";
import {
  createPreflightSnapshot,
  runReadOnlyGitGates,
  writePreflightReceipt,
} from "../../../scripts/desktop-release-preflight-evidence.mjs";
import { runDesktopReleasePreflight } from
  "../../../scripts/desktop-release-preflight.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  };
});

const temporaryRoots: string[] = [];

const createTemporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-preflight-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const releaseKeys = [
  "INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR",
  "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_ROOT",
  "INTENTARC_BRIDGE_DIAGNOSTIC_AUDIT_PATH",
  "INTENTARC_INSTALLER_E2E_SETUP",
  "INTENTARC_RELEASE_BUILD",
  "INTENTARC_RELEASE_TEST_MARKER",
  "INTENTARC_RUN_INSTALLER_E2E",
  "INTENTARC_SIGNATURE_TARGET",
  "INTENTARC_UPDATE_FEED_URL",
  "INTENTARC_WINDOWS_CERTIFICATE",
  "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
  "INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT",
  "WINDOWS_SIGNTOOL_PATH",
] as const;

const sourceManifestSha256 = "a".repeat(64);
const packageJsonSha256 = "b".repeat(64);
const vendorIdentity = "c".repeat(64);

const createReceipt = () => createInitialPreflightReceipt({
  runId: "preflight-20260829-01",
  statusScope: "tracked-only",
  sourceManifestSha256,
  packageJsonSha256,
  vendorIdentity,
  outAbsent: true,
});

const invalidStatusScopeCases = [
  { name: "missing", present: false, value: undefined },
  { name: "null", present: true, value: null },
  { name: "all", present: true, value: "all" },
  { name: "normal", present: true, value: "normal" },
] as const;

const receiptWithInvalidStatusScope = (
  scopeCase: (typeof invalidStatusScopeCases)[number],
) => {
  const receipt = structuredClone(createReceipt());
  const git = receipt.git as unknown as Record<string, unknown>;
  if (scopeCase.present) git.statusScope = scopeCase.value;
  else delete git.statusScope;
  return receipt;
};

const historicalReceiptV1 = () => ({
  schemaVersion: 1,
  runId: "preflight-20260811-01",
  status: "running",
  failureCategory: null,
  checks: {
    "focused-tests": "pending",
    "server-typecheck": "pending",
    "web-typecheck": "pending",
    "adapter-strict": "pending",
  },
  git: {
    diffCheckPassed: null,
    productDiffClean: null,
    statusClean: null,
    statusEntryCount: null,
  },
  source: { before: sourceManifestSha256, after: null, unchanged: null },
  packageJson: { before: packageJsonSha256, after: null, unchanged: null },
  vendor: { before: vendorIdentity, after: null, unchanged: null },
  out: { absentBefore: true, absentAfter: null },
});

const historicalFailedReceiptV1 = () => ({
  ...historicalReceiptV1(),
  status: "failed",
  failureCategory: "focused-tests",
  checks: {
    ...historicalReceiptV1().checks,
    "focused-tests": "running",
  },
});

const completedReceipt = () => {
  let receipt = createReceipt();
  for (const check of preflightChecks) {
    receipt = withCheckState(receipt, check.id, "running");
    receipt = withCheckState(receipt, check.id, "passed");
  }
  return completePreflightReceipt(receipt, {
    sourceManifestSha256,
    packageJsonSha256,
    vendorIdentity,
    outAbsent: true,
    diffCheckPassed: true,
    productDiffClean: true,
    statusClean: true,
    statusEntryCount: 0,
  });
};

const runnerSnapshot = {
  source: { fileCount: 3, totalBytes: 28, sha256: sourceManifestSha256 },
  packageJsonSha256,
  vendor: { fileCount: 2, totalBytes: 11, sha256: vendorIdentity },
  outAbsent: true,
};

const cleanGitEvidence = {
  diffCheckPassed: true,
  productDiffClean: true,
  statusClean: true,
  statusEntryCount: 0,
};

const checkIdForArguments = (arguments_: readonly string[]) =>
  preflightChecks.find((check) =>
    check.arguments.length === arguments_.length &&
    check.arguments.every((value, index) => value === arguments_[index])
  )?.id;

const receiptEvent = (receipt: ReturnType<typeof createInitialPreflightReceipt>) => {
  if (receipt.status !== "running") return receipt.status;
  const active = preflightChecks.find((check) =>
    receipt.checks[check.id] === "running"
  );
  if (active) return `${active.id}:running`;
  const passed = [...preflightChecks].reverse().find((check) =>
    receipt.checks[check.id] === "passed"
  );
  return passed ? `${passed.id}:passed` : "initial";
};

const createRunnerFixture = () => {
  const events: string[] = [];
  const childOptions: Array<Record<string, unknown>> = [];
  const gitOptions: Array<Record<string, unknown>> = [];
  const receiptJson: string[] = [];
  let snapshotCalls = 0;
  let gitCalls = 0;
  const environment = Object.fromEntries([
    ...releaseKeys.map((key) => [key, `secret-for-${key}`]),
    ["PATH", "C:\\Windows\\System32"],
    ["npm_execpath", "C:\\pnpm\\pnpm.exe"],
    ["INTENTARC_SAFE_VALUE", "preserved"],
  ]);
  const options = {
    argv: ["--run-id", "unit-preflight-01", "--tracked-only"],
    environment,
    packageRoot: "C:\\package",
    resolveInvocation: async (_environment: NodeJS.ProcessEnv, arguments_: readonly string[]) => ({
      command: "pnpm-sentinel",
      arguments: [...arguments_],
    }),
    spawnInvocation: async (child: Record<string, unknown>) => {
      childOptions.push(child);
      events.push(`spawn:${checkIdForArguments(child.arguments as string[])}`);
    },
    createSnapshot: async () => {
      snapshotCalls += 1;
      events.push(`snapshot:${snapshotCalls === 1 ? "before" : "after"}`);
      return structuredClone(runnerSnapshot);
    },
    runGitGates: async (gitOption: Record<string, unknown>) => {
      gitOptions.push(gitOption);
      gitCalls += 1;
      events.push(`git:${gitCalls === 1 ? "before" : "after"}`);
      return { ...cleanGitEvidence };
    },
    writeReceipt: async (_path: string, receipt: ReturnType<typeof createInitialPreflightReceipt>) => {
      receiptJson.push(JSON.stringify(receipt));
      events.push(`receipt:${receiptEvent(receipt)}`);
    },
  };
  return { childOptions, environment, events, gitOptions, options, receiptJson };
};

describe("desktop release preflight runner", () => {
  it("persists every state and runs the fixed checks serially", async () => {
    const fixture = createRunnerFixture();

    const receipt = await runDesktopReleasePreflight(fixture.options);

    expect(fixture.events).toEqual([
      "snapshot:before",
      "receipt:initial",
      "git:before",
      "receipt:focused-tests:running",
      "spawn:focused-tests",
      "receipt:focused-tests:passed",
      "receipt:server-typecheck:running",
      "spawn:server-typecheck",
      "receipt:server-typecheck:passed",
      "receipt:web-typecheck:running",
      "spawn:web-typecheck",
      "receipt:web-typecheck:passed",
      "receipt:adapter-strict:running",
      "spawn:adapter-strict",
      "receipt:adapter-strict:passed",
      "git:after",
      "snapshot:after",
      "receipt:passed",
    ]);
    expect(receipt).toEqual({
      ...completedReceipt(),
      runId: "unit-preflight-01",
    });
    expect(fixture.gitOptions).toEqual([
      { packageRoot: "C:\\package", statusScope: "tracked-only" },
      { packageRoot: "C:\\package", statusScope: "tracked-only" },
    ]);
    expect(fixture.childOptions).toHaveLength(4);
    for (const child of fixture.childOptions) {
      expect(child).toMatchObject({
        cwd: "C:\\package",
        shell: false,
        windowsHide: true,
        stdio: "inherit",
      });
      expect(child.environment).toMatchObject({
        PATH: "C:\\Windows\\System32",
        npm_execpath: "C:\\pnpm\\pnpm.exe",
        INTENTARC_SAFE_VALUE: "preserved",
      });
      expect(child.environment).not.toBe(fixture.environment);
      for (const key of releaseKeys) {
        expect(child.environment).not.toHaveProperty(key);
      }
    }
  });

  it.each(preflightChecks)(
    "fails fast in the fixed $id category and starts no later child",
    async (failedCheck) => {
      const fixture = createRunnerFixture();
      fixture.options.spawnInvocation = async (child) => {
        fixture.childOptions.push(child);
        const checkId = checkIdForArguments(child.arguments as string[]);
        fixture.events.push(`spawn:${checkId}`);
        if (checkId === failedCheck.id) {
          throw new Error("secret C:\\private\\failure.txt --certificate-password hunter2");
        }
      };

      await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
        "secret C:\\private\\failure.txt --certificate-password hunter2",
      );

      expect(fixture.childOptions).toHaveLength(
        preflightChecks.findIndex((check) => check.id === failedCheck.id) + 1,
      );
      const failed = JSON.parse(fixture.receiptJson.at(-1) ?? "null");
      expect(failed).toMatchObject({
        status: "failed",
        failureCategory: failedCheck.id,
        checks: { [failedCheck.id]: "failed" },
      });
      assertPreflightReceipt(failed);
    },
  );

  it("attributes invocation resolution failure to the active check", async () => {
    const fixture = createRunnerFixture();
    fixture.options.resolveInvocation = async () => {
      throw new Error("secret resolver path C:\\private\\pnpm.exe");
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "secret resolver path C:\\private\\pnpm.exe",
    );

    expect(fixture.childOptions).toEqual([]);
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "focused-tests",
      checks: { "focused-tests": "failed" },
    });
  });

  it("records receipt-write when the initial durable receipt fails", async () => {
    const fixture = createRunnerFixture();
    let writes = 0;
    fixture.options.writeReceipt = async (_path, receipt) => {
      writes += 1;
      fixture.receiptJson.push(JSON.stringify(receipt));
      if (writes === 1) throw new Error("secret initial receipt write");
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "secret initial receipt write",
    );

    expect(fixture.childOptions).toEqual([]);
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "receipt-write",
    });
  });

  it("fails initial out evidence after its receipt and before any Git gate", async () => {
    const fixture = createRunnerFixture();
    fixture.options.createSnapshot = async () => {
      fixture.events.push("snapshot:before");
      return { ...structuredClone(runnerSnapshot), outAbsent: false };
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "IntentArc preflight initial evidence failed.",
    );

    expect(fixture.events).toEqual([
      "snapshot:before",
      "receipt:initial",
      "receipt:failed",
    ]);
    expect(fixture.childOptions).toEqual([]);
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "initial-evidence",
    });
  });

  it.each([
    ["Git after-check", "git-gates", (fixture: ReturnType<typeof createRunnerFixture>) => {
      let calls = 0;
      fixture.options.runGitGates = async () => {
        calls += 1;
        if (calls === 2) throw new Error("secret after Git failure");
        return { ...cleanGitEvidence };
      };
    }],
    ["snapshot after-check", "final-evidence", (fixture: ReturnType<typeof createRunnerFixture>) => {
      let calls = 0;
      fixture.options.createSnapshot = async () => {
        calls += 1;
        if (calls === 2) throw new Error("secret after snapshot failure");
        return structuredClone(runnerSnapshot);
      };
    }],
  ])("attributes %s failure to %s", async (_name, category, arrange) => {
    const fixture = createRunnerFixture();
    arrange(fixture);

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow("secret after");

    expect(fixture.childOptions).toHaveLength(4);
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: category,
    });
  });

  it("attributes dirty final Git evidence before taking the final snapshot", async () => {
    const fixture = createRunnerFixture();
    let calls = 0;
    fixture.options.runGitGates = async () => {
      calls += 1;
      fixture.events.push(`git:${calls === 1 ? "before" : "after"}`);
      return calls === 1
        ? { ...cleanGitEvidence }
        : { ...cleanGitEvidence, statusClean: false, statusEntryCount: 1 };
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "IntentArc preflight final Git evidence failed.",
    );

    expect(fixture.events.at(-2)).toBe("git:after");
    expect(fixture.events.at(-1)).toBe("receipt:failed");
    expect(fixture.events).not.toContain("snapshot:after");
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "git-gates",
    });
  });

  it("rejects changed final read-only state as final-evidence", async () => {
    const fixture = createRunnerFixture();
    let calls = 0;
    fixture.options.createSnapshot = async () => {
      calls += 1;
      return {
        ...structuredClone(runnerSnapshot),
        packageJsonSha256: calls === 1 ? packageJsonSha256 : "d".repeat(64),
      };
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "IntentArc preflight receipt is invalid.",
    );
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "final-evidence",
    });
  });

  it("replaces a failed final receipt write with a receipt-write failure", async () => {
    const fixture = createRunnerFixture();
    fixture.options.writeReceipt = async (_path, receipt) => {
      fixture.receiptJson.push(JSON.stringify(receipt));
      if (receipt.status === "passed") {
        throw new Error("secret final replacement path C:\\private\\receipt.json");
      }
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "secret final replacement path C:\\private\\receipt.json",
    );

    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "receipt-write",
    });
  });

  it.each([
    ["spawn error", { command: "Z:\\missing\\intentarc-child.exe", arguments: [] }],
    ["nonzero exit", { command: process.execPath, arguments: ["-e", "process.exit(23)"] }],
  ])("uses one fixed message for a child %s", async (_name, invocation) => {
    const fixture = createRunnerFixture();
    fixture.options.resolveInvocation = async () => invocation;
    delete (fixture.options as Partial<typeof fixture.options>).spawnInvocation;

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "IntentArc preflight child process failed.",
    );
    expect(JSON.parse(fixture.receiptJson.at(-1) ?? "null")).toMatchObject({
      status: "failed",
      failureCategory: "focused-tests",
    });
  });

  it("never writes child errors, paths, stacks, environment keys, or arguments", async () => {
    const fixture = createRunnerFixture();
    const secretError = new Error(
      "credential-sentinel C:\\Users\\private\\certificate.pfx argument-sentinel",
    );
    secretError.stack = "stack-sentinel C:\\Users\\private\\runner.mjs";
    fixture.options.spawnInvocation = async () => {
      throw secretError;
    };

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toBe(secretError);

    const allReceiptJson = fixture.receiptJson.join("\n");
    for (const secret of [
      secretError.message,
      "C:\\Users\\private\\certificate.pfx",
      "stack-sentinel",
      "INTENTARC_WINDOWS_CERTIFICATE_PASSWORD",
      "argument-sentinel",
      "--ignoreConfig",
    ]) {
      expect(allReceiptJson).not.toContain(secret);
    }
  });

  it("rejects the legacy command before evidence or execution", async () => {
    const fixture = createRunnerFixture();
    fixture.options.argv = ["--run-id", "unit-preflight-legacy-01"];

    await expect(runDesktopReleasePreflight(fixture.options)).rejects.toThrow(
      "IntentArc preflight arguments are invalid.",
    );
    expect(fixture.events).toEqual([]);
    expect(fixture.receiptJson).toEqual([]);
    expect(fixture.gitOptions).toEqual([]);
    expect(fixture.childOptions).toEqual([]);
  });

  it("contains none of the forbidden release or installer operations", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "desktop-release-preflight.mjs"),
      "utf8",
    );
    for (const forbidden of [
      "desktop:release", "desktop:make", "electron-forge", "SignTool",
      "New-SelfSignedCertificate", "Setup.exe", "--squirrel-install",
      "installBridgeVersion", "repository refresh",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

const recursiveKeys = (value: unknown, prefix = ""): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...recursiveKeys(child, path)];
  });
};

describe("desktop release preflight contract", () => {
  it("defines the fixed, immutable pnpm command matrix", () => {
    expect(preflightChecks).toEqual([
      {
        id: "focused-tests",
        arguments: [
          "vitest", "run",
          "src/desktop/e2e/installer-contract.test.ts",
          "src/bridge/package-contract.test.ts",
          "src/desktop/e2e/signed-artifact-bundle.test.ts",
          "src/desktop/e2e/signed-release-once.test.ts",
          "--reporter=dot",
          "--maxWorkers=1",
        ],
      },
      { id: "server-typecheck", arguments: ["typecheck:server"] },
      { id: "web-typecheck", arguments: ["typecheck:web"] },
      {
        id: "adapter-strict",
        arguments: [
          "exec", "tsc", "--ignoreConfig", "--noEmit", "--target", "ES2024",
          "--module", "NodeNext", "--moduleResolution", "NodeNext", "--allowJs",
          "--checkJs", "false", "--strict", "--skipLibCheck",
          "scripts/forge-bridge-native-signing.ts",
        ],
      },
    ]);
    expect(Object.isFrozen(preflightChecks)).toBe(true);
    for (const check of preflightChecks) {
      expect(Object.isFrozen(check)).toBe(true);
      expect(Object.isFrozen(check.arguments)).toBe(true);
    }
  });

  it("accepts only the exact tracked-only command with a lower-case bounded run ID", () => {
    expect(parsePreflightArguments([
      "--run-id", "preflight-20260829-01", "--tracked-only",
    ])).toEqual({
      runId: "preflight-20260829-01",
      statusScope: "tracked-only",
    });

    for (const invalidArguments of [
      [],
      ["--run-id", "preflight-20260829-01"],
      ["--tracked-only", "--run-id", "preflight-20260829-01"],
      ["--run-id", "preflight-20260829-01", "tracked-only"],
      ["--run-id", "preflight-20260829-01", "--tracked-only", "extra"],
      ["--run-id", "preflight-20260829-01", "--tracked-only", "--tracked-only"],
      ["--run-id", "preflight-20260829-01", "--git-scope", "tracked-only"],
      ["--run-id", "preflight-20260829-01", "--include-untracked"],
      ["--run-id"],
      ["--run-id", "preflight-20260829-01", "--run-id", "another-run"],
      ["--run-id", "Preflight-20260829-01", "--tracked-only"],
      ["--run-id", "C:\\temp\\preflight", "--tracked-only"],
      ["--run-id", ".preflight", "--tracked-only"],
      ["--run-id", "preflight/run", "--tracked-only"],
      ["--run-id", "preflight\\run", "--tracked-only"],
      ["--run-id", "-preflight", "--tracked-only"],
      ["--run-id", "preflight-", "--tracked-only"],
      ["--run-id", "a".repeat(65), "--tracked-only"],
    ]) {
      expect(() => parsePreflightArguments(invalidArguments)).toThrow(
        "IntentArc preflight arguments are invalid.",
      );
    }

    expect(receiptPathForRun("C:\\package", "preflight-20260811-01"))
      .toBe("C:\\package\\.superpowers\\preflight\\desktop-release\\preflight-20260811-01.json");

    for (const invalidRunId of [
      "../preflight", "preflight/run", "preflight\\run", "Preflight",
      ".preflight", "preflight-", "-preflight", "a".repeat(65),
    ]) {
      expect(() => receiptPathForRun("C:\\package", invalidRunId)).toThrow(
        "IntentArc preflight run ID is invalid.",
      );
    }
  });

  it.each(invalidStatusScopeCases)(
    "rejects $name scope during receipt creation",
    (scopeCase) => {
      const input: Record<string, unknown> = {
        runId: "preflight-20260829-01",
        statusScope: "tracked-only",
        sourceManifestSha256,
        packageJsonSha256,
        vendorIdentity,
        outAbsent: true,
      };
      if (scopeCase.present) input.statusScope = scopeCase.value;
      else delete input.statusScope;

      expect(() => createInitialPreflightReceipt(input as never)).toThrow(
        "IntentArc preflight receipt is invalid.",
      );
    },
  );

  it("removes all release controls while retaining ordinary process environment", () => {
    const environment = Object.fromEntries([
      ...releaseKeys.map((key) => [key, "secret-sentinel"]),
      ["PATH", "C:\\Windows\\System32"],
      ["SYSTEMROOT", "C:\\Windows"],
      ["npm_execpath", "C:\\pnpm\\pnpm.exe"],
      ["INTENTARC_SAFE_VALUE", "preserved"],
    ]);

    const sanitized = sanitizePreflightEnvironment(environment);
    for (const key of releaseKeys) expect(sanitized).not.toHaveProperty(key);
    expect(sanitized).toMatchObject({
      PATH: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      npm_execpath: "C:\\pnpm\\pnpm.exe",
      INTENTARC_SAFE_VALUE: "preserved",
    });
    expect(sanitized).not.toBe(environment);
  });

  it("sanitizes a Node ProcessEnv without discarding ordinary keys", () => {
    const environment = Object.assign(
      Object.create(Object.getPrototypeOf(process.env)),
      {
        PATH: "safe-path",
        SYSTEMROOT: "safe-system-root",
        npm_execpath: "C:\\safe\\pnpm.exe",
        INTENTARC_RELEASE_BUILD: "1",
        INTENTARC_WINDOWS_CERTIFICATE_PASSWORD: "secret-sentinel",
        WINDOWS_SIGNTOOL_PATH: "C:\\secret\\signtool.exe",
      },
    );

    expect(sanitizePreflightEnvironment(environment)).toEqual({
      PATH: "safe-path",
      SYSTEMROOT: "safe-system-root",
      npm_execpath: "C:\\safe\\pnpm.exe",
    });
  });

  it("records only the closed, successful receipt schema", () => {
    const receipt = completedReceipt();
    assertPreflightReceipt(receipt);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      runId: "preflight-20260829-01",
      status: "passed",
      failureCategory: null,
      checks: {
        "focused-tests": "passed",
        "server-typecheck": "passed",
        "web-typecheck": "passed",
        "adapter-strict": "passed",
      },
      git: {
        statusScope: "tracked-only",
        diffCheckPassed: true,
        productDiffClean: true,
        statusClean: true,
        statusEntryCount: 0,
      },
      source: { before: sourceManifestSha256, after: sourceManifestSha256, unchanged: true },
      packageJson: { before: packageJsonSha256, after: packageJsonSha256, unchanged: true },
      vendor: { before: vendorIdentity, after: vendorIdentity, unchanged: true },
      out: { absentBefore: true, absentAfter: true },
    });
    expect(recursiveKeys(receipt).sort()).toEqual([
      "checks", "checks.adapter-strict", "checks.focused-tests", "checks.server-typecheck",
      "checks.web-typecheck", "failureCategory", "git", "git.diffCheckPassed",
      "git.productDiffClean", "git.statusClean", "git.statusEntryCount", "git.statusScope", "out",
      "out.absentAfter", "out.absentBefore", "packageJson", "packageJson.after",
      "packageJson.before", "packageJson.unchanged", "runId", "schemaVersion", "source",
      "source.after", "source.before", "source.unchanged", "status", "vendor", "vendor.after",
      "vendor.before", "vendor.unchanged",
    ]);
  });

  it("rejects every extra field from a receipt at every depth", () => {
    const receipt = completedReceipt();
    const invalidReceipts = [
      { ...receipt, "secret-sentinel": "secret-sentinel" },
      { ...receipt, source: { ...receipt.source, path: "C:\\temp\\receipt.json" } },
      { ...receipt, git: { ...receipt.git, command: "desktop:release" } },
      { ...receipt, vendor: { ...receipt.vendor, certificatePassword: "secret-sentinel" } },
      { ...receipt, checks: { ...receipt.checks, argv: ["desktop:release"] } },
      { ...receipt, stdout: "secret-sentinel" },
      { ...receipt, stderr: "secret-sentinel" },
      { ...receipt, stack: "secret-sentinel" },
    ];
    for (const invalidReceipt of invalidReceipts) {
      expect(() => assertPreflightReceipt(invalidReceipt)).toThrow(
        "IntentArc preflight receipt is invalid.",
      );
    }
  });

  it("rejects malformed scalar values, enums, hashes, and incomplete passed evidence", () => {
    const receipt = completedReceipt();
    const invalidReceipts = [
      { ...receipt, schemaVersion: "1" },
      { ...receipt, status: "complete" },
      { ...receipt, failureCategory: "arbitrary-error" },
      { ...receipt, checks: { ...receipt.checks, "focused-tests": "complete" } },
      { ...receipt, source: { ...receipt.source, before: "A".repeat(64) } },
      { ...receipt, git: { ...receipt.git, statusEntryCount: -1 } },
      { ...receipt, git: { ...receipt.git, statusEntryCount: 1_000_001 } },
      { ...receipt, source: { ...receipt.source, after: null, unchanged: true } },
      { ...receipt, status: "passed", checks: { ...receipt.checks, "focused-tests": "failed" } },
    ];
    for (const invalidReceipt of invalidReceipts) {
      expect(() => assertPreflightReceipt(invalidReceipt)).toThrow(
        "IntentArc preflight receipt is invalid.",
      );
    }
  });

  it.each(invalidStatusScopeCases)(
    "rejects $name scope during v2 receipt validation",
    (scopeCase) => {
      const receipt = receiptWithInvalidStatusScope(scopeCase);
      expect(() => assertPreflightReceipt(receipt)).toThrow(
        "IntentArc preflight receipt is invalid.",
      );
      expect(() => assertWritablePreflightReceipt(receipt)).toThrow(
        "IntentArc preflight receipt is invalid.",
      );
    },
  );

  it("preserves closed failure categories without recording arbitrary errors", () => {
    const failed = failPreflightReceipt(createReceipt(), "focused-tests");
    expect(failed).toMatchObject({
      status: "failed",
      failureCategory: "focused-tests",
    });
    assertPreflightReceipt(failed);
  });

  it("accepts the audited legacy failed receipt with a running active check", () => {
    const active = withCheckState(createReceipt(), "focused-tests", "running");
    const legacy = failPreflightReceipt(active, "focused-tests");

    expect(legacy).toMatchObject({
      status: "failed",
      failureCategory: "focused-tests",
      checks: { "focused-tests": "running" },
    });
    expect(() => assertPreflightReceipt(legacy)).not.toThrow();
  });

  it("read-validates historical v1 receipts but rejects every mutation", () => {
    expect(() => assertPreflightReceipt(historicalReceiptV1())).not.toThrow();
    expect(() => assertPreflightReceipt(historicalFailedReceiptV1())).not.toThrow();
    expect(() => assertWritablePreflightReceipt(
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
    )).toThrow("IntentArc preflight receipt is invalid.");
    expect(() => withCheckState(
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
      "focused-tests",
      "running",
    )).toThrow("IntentArc preflight receipt is invalid.");
    expect(() => preparePreflightReceiptFailure(
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
      "initial-evidence",
    )).toThrow("IntentArc preflight receipt is invalid.");
    expect(() => failPreflightReceipt(
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
      "initial-evidence",
    )).toThrow("IntentArc preflight receipt is invalid.");
    expect(() => completePreflightReceipt(
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
      {
        sourceManifestSha256,
        packageJsonSha256,
        vendorIdentity,
        outAbsent: true,
        diffCheckPassed: true,
        productDiffClean: true,
        statusClean: true,
        statusEntryCount: 0,
      },
    )).toThrow("IntentArc preflight receipt is invalid.");
  });
});

type GitResult = { stdout: string; stderr: string };
type FakeGitRunner = (arguments_: readonly string[]) => Promise<GitResult>;
type GitGatewayTest = (options: {
  packageRoot: string;
  arguments: readonly string[];
  runGit: FakeGitRunner;
}) => Promise<void>;

const gitGatewayTestSymbol = Symbol.for(
  "intentarc.desktop-release-preflight.git-gateway-test",
);

const readOnlyGitVectors = [
  ["ls-files", "-z"],
  ["diff", "--check"],
  [
    "diff", "--exit-code", "--",
    "scripts/forge-bridge-native-signing.ts",
    "forge.config.ts",
    "scripts/bridge-support-integrity.mjs",
    "scripts/bridge-diagnostic-audit.mjs",
    "scripts/bridge-native-release.mjs",
    "scripts/desktop-release.mjs",
    "scripts/signed-artifact-bundle.mjs",
  ],
  ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
] as const;

const isReadOnlyGitStatusVector = (arguments_: readonly string[]) =>
  arguments_.length === readOnlyGitVectors[3].length
  && arguments_.every((argument, index) => argument === readOnlyGitVectors[3][index]);

const createEvidenceFixture = async () => {
  const packageRoot = await createTemporaryRoot();
  await mkdir(join(packageRoot, "src", "nested"), { recursive: true });
  await mkdir(join(packageRoot, "dist", "squirrel-vendor", "nested"), {
    recursive: true,
  });
  await writeFile(join(packageRoot, "package.json"), "{\"name\":\"fixture\"}\n");
  await writeFile(join(packageRoot, "src", "alpha.txt"), "alpha");
  await writeFile(
    join(packageRoot, "src", "nested", "beta.bin"),
    Buffer.from([0, 1, 2, 255]),
  );
  await writeFile(
    join(packageRoot, "dist", "squirrel-vendor", "vendor-a.txt"),
    "vendor-a",
  );
  await writeFile(
    join(packageRoot, "dist", "squirrel-vendor", "nested", "vendor-b.bin"),
    Buffer.from([3, 4, 5]),
  );

  let trackedNames = [
    "src/nested/beta.bin",
    "package.json",
    "src/alpha.txt",
  ];
  const calls: string[][] = [];
  const runGit: FakeGitRunner = async (arguments_) => {
    calls.push([...arguments_]);
    return {
      stdout: arguments_.join("\0") === "ls-files\0-z"
        ? `${trackedNames.join("\0")}\0`
        : "",
      stderr: "",
    };
  };

  return {
    calls,
    packageRoot,
    runGit,
    setTrackedNames(names: string[]) {
      trackedNames = [...names];
    },
  };
};

const temporaryReceiptLeaves = async (receiptPath: string) => {
  const prefix = `.${basename(receiptPath)}.`;
  return (await readdir(dirname(receiptPath)))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
};

describe.sequential("desktop release preflight evidence", () => {
  it("hashes tracked source and the vendor tree deterministically", async () => {
    const fixture = await createEvidenceFixture();
    const first = await createPreflightSnapshot(fixture);
    const repeated = await createPreflightSnapshot(fixture);

    expect(first).toEqual({
      source: {
        fileCount: 3,
        totalBytes: 28,
        sha256: "5a0d609bf838745b6ec0ea775f9fda940784b864ab58035933bfd93be8557456",
      },
      packageJsonSha256:
        "ccf6ffa6e72543dd4b555dab955bb3cff514cb6b50d3ded3d36a67e017ddf736",
      vendor: {
        fileCount: 2,
        totalBytes: 11,
        sha256: "4ae8457a2db90eb858cd81c5ed3c5220b7e3df226d3efb0c251f8bc3d6117dea",
      },
      outAbsent: true,
    });
    expect(repeated).toEqual(first);
    expect(fixture.calls).toEqual([
      ["ls-files", "-z"],
      ["ls-files", "-z"],
    ]);
  });

  it("uses the empty vendor identity when the exact vendor root is absent", async () => {
    const fixture = await createEvidenceFixture();
    const vendorRoot = join(fixture.packageRoot, "dist", "squirrel-vendor");
    await rm(vendorRoot, { recursive: true, force: true });

    await expect(createPreflightSnapshot(fixture)).resolves.toMatchObject({
      vendor: {
        fileCount: 0,
        totalBytes: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
    await expect(lstat(vendorRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-directory vendor root", async () => {
    const fixture = await createEvidenceFixture();
    const vendorRoot = join(fixture.packageRoot, "dist", "squirrel-vendor");
    await rm(vendorRoot, { recursive: true, force: true });
    await writeFile(vendorRoot, "not-a-directory");

    await expect(createPreflightSnapshot(fixture)).rejects.toThrow(
      "IntentArc preflight evidence requires ordinary files.",
    );
  });

  it("changes both tree identities for content, leaf-name, and membership changes", async () => {
    const fixture = await createEvidenceFixture();
    const initial = await createPreflightSnapshot(fixture);

    await writeFile(join(fixture.packageRoot, "src", "alpha.txt"), "alphb");
    await writeFile(
      join(fixture.packageRoot, "dist", "squirrel-vendor", "vendor-a.txt"),
      "vendor-b",
    );
    const changedBytes = await createPreflightSnapshot(fixture);
    expect(changedBytes.source).toMatchObject({ fileCount: 3, totalBytes: 28 });
    expect(changedBytes.vendor).toMatchObject({ fileCount: 2, totalBytes: 11 });
    expect(changedBytes.source.sha256).not.toBe(initial.source.sha256);
    expect(changedBytes.vendor.sha256).not.toBe(initial.vendor.sha256);

    await rename(
      join(fixture.packageRoot, "src", "alpha.txt"),
      join(fixture.packageRoot, "src", "omega.txt"),
    );
    await rename(
      join(fixture.packageRoot, "dist", "squirrel-vendor", "vendor-a.txt"),
      join(fixture.packageRoot, "dist", "squirrel-vendor", "vendor-z.txt"),
    );
    fixture.setTrackedNames([
      "src/nested/beta.bin",
      "package.json",
      "src/omega.txt",
    ]);
    const renamedLeaves = await createPreflightSnapshot(fixture);
    expect(renamedLeaves.source).toMatchObject({ fileCount: 3, totalBytes: 28 });
    expect(renamedLeaves.vendor).toMatchObject({ fileCount: 2, totalBytes: 11 });
    expect(renamedLeaves.source.sha256).not.toBe(changedBytes.source.sha256);
    expect(renamedLeaves.vendor.sha256).not.toBe(changedBytes.vendor.sha256);

    await writeFile(join(fixture.packageRoot, "src", "new.txt"), "new");
    await writeFile(
      join(fixture.packageRoot, "dist", "squirrel-vendor", "new.txt"),
      "new",
    );
    fixture.setTrackedNames([
      "src/new.txt",
      "src/nested/beta.bin",
      "package.json",
      "src/omega.txt",
    ]);
    const addedLeaves = await createPreflightSnapshot(fixture);
    expect(addedLeaves.source).toMatchObject({ fileCount: 4, totalBytes: 31 });
    expect(addedLeaves.vendor).toMatchObject({ fileCount: 3, totalBytes: 14 });
    expect(addedLeaves.source.sha256).not.toBe(renamedLeaves.source.sha256);
    expect(addedLeaves.vendor.sha256).not.toBe(renamedLeaves.vendor.sha256);
  });

  it("rejects symbolic links from tracked source and vendor evidence when supported", async () => {
    const fixture = await createEvidenceFixture();
    const sourceLink = join(fixture.packageRoot, "src", "linked.txt");
    try {
      await symlink(
        join(fixture.packageRoot, "src", "alpha.txt"),
        sourceLink,
        "file",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    fixture.setTrackedNames([
      "package.json",
      "src/alpha.txt",
      "src/linked.txt",
      "src/nested/beta.bin",
    ]);
    await expect(createPreflightSnapshot(fixture)).rejects.toThrow(
      "IntentArc preflight evidence requires ordinary files.",
    );

    await rm(sourceLink);
    const vendorLink = join(
      fixture.packageRoot,
      "dist",
      "squirrel-vendor",
      "linked.txt",
    );
    await symlink(
      join(fixture.packageRoot, "dist", "squirrel-vendor", "vendor-a.txt"),
      vendorLink,
      "file",
    );
    fixture.setTrackedNames([
      "package.json",
      "src/alpha.txt",
      "src/nested/beta.bin",
    ]);
    await expect(createPreflightSnapshot(fixture)).rejects.toThrow(
      "IntentArc preflight evidence requires ordinary files.",
    );
  });

  it("rejects an intermediate directory link without reading its outside sentinel", async () => {
    const fixture = await createEvidenceFixture();
    const outsideRoot = await createTemporaryRoot();
    const sentinelPath = join(outsideRoot, "outside-sentinel.txt");
    await writeFile(sentinelPath, "outside-sentinel");
    const linkedDirectory = join(fixture.packageRoot, "linked-directory");
    try {
      await symlink(
        outsideRoot,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    fixture.setTrackedNames([
      "linked-directory/outside-sentinel.txt",
      "package.json",
      "src/alpha.txt",
      "src/nested/beta.bin",
    ]);
    vi.mocked(readFile).mockClear();

    let snapshotError: unknown;
    try {
      await createPreflightSnapshot(fixture);
    } catch (error) {
      snapshotError = error;
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(snapshotError).toBeInstanceOf(Error);
    expect((snapshotError as Error).message).toBe(
      "IntentArc preflight evidence requires ordinary files.",
    );
  });

  it("rejects absolute and escaping tracked names", async () => {
    const fixture = await createEvidenceFixture();
    for (const relativeName of [
      "../escape.txt",
      "/absolute.txt",
      "C:/absolute.txt",
      "src\\escape.txt",
    ]) {
      await expect(createPreflightSnapshot({
        packageRoot: fixture.packageRoot,
        runGit: async () => ({ stdout: `${relativeName}\0`, stderr: "" }),
      })).rejects.toThrow("IntentArc preflight tracked path is invalid.");
    }
  });

  it("exports only the three sanitized evidence interfaces", async () => {
    const evidenceModule = await import(
      "../../../scripts/desktop-release-preflight-evidence.mjs"
    );
    expect(Object.keys(evidenceModule).sort()).toEqual([
      "createPreflightSnapshot",
      "runReadOnlyGitGates",
      "writePreflightReceipt",
    ]);

    const fixture = await createEvidenceFixture();
    const snapshot = await evidenceModule.createPreflightSnapshot(fixture);
    const git = await evidenceModule.runReadOnlyGitGates({
      packageRoot: fixture.packageRoot,
      statusScope: "tracked-only",
      runGit: async (arguments_: readonly string[]) => ({
        stdout: isReadOnlyGitStatusVector(arguments_)
          ? "?? raw-status-sentinel.txt\0"
          : "",
        stderr: "warning: in the working copy of 'raw-warning-sentinel.txt', LF will be replaced by CRLF the next time Git touches it\n",
      }),
    });
    const returnedEvidence = JSON.stringify({ snapshot, git });
    expect(returnedEvidence).not.toContain("src/alpha.txt");
    expect(returnedEvidence).not.toContain("raw-status-sentinel.txt");
    expect(returnedEvidence).not.toContain("raw-warning-sentinel.txt");
  });

  it("contains no all-untracked runtime preflight vector", async () => {
    for (const relativePath of [
      "scripts/desktop-release-preflight-contract.mjs",
      "scripts/desktop-release-preflight-evidence.mjs",
      "scripts/desktop-release-preflight.mjs",
    ]) {
      const source = await readFile(join(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("--untracked-files=all");
    }
  });

  it("accepts only the four exact Git vectors before executor invocation", async () => {
    const testGateway = (
      runReadOnlyGitGates as unknown as Record<symbol, GitGatewayTest>
    )[gitGatewayTestSymbol];
    expect(testGateway).toBeTypeOf("function");

    for (const arguments_ of readOnlyGitVectors) {
      let executions = 0;
      const result = await testGateway({
        packageRoot: "C:\\package",
        arguments: arguments_,
        runGit: async () => {
          executions += 1;
          return { stdout: "raw-path-sentinel", stderr: "" };
        },
      });
      expect(result).toBeUndefined();
      expect(executions).toBe(1);
    }

    for (const arguments_ of [
      ["fetch"],
      ["pull"],
      ["checkout", "main"],
      ["reset", "--hard"],
      ["update-index", "--refresh"],
      ["write-tree"],
      ["refresh"],
      ["ls-files\0-z"],
      ["ls-files", "-z", "--cached"],
      ["diff", "--check", "--exit-code"],
      ["status", "-z", "--porcelain=v1", "--untracked-files=all"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      ["status", "--porcelain=v1", "-z"],
      ["status", "-z", "--porcelain=v1", "--untracked-files=no"],
    ]) {
      let executions = 0;
      await expect(testGateway({
        packageRoot: "C:\\package",
        arguments: arguments_,
        runGit: async () => {
          executions += 1;
          return { stdout: "", stderr: "" };
        },
      })).rejects.toThrow("IntentArc preflight Git arguments are invalid.");
      expect(executions).toBe(0);
    }
  });

  it.each([undefined, null, "all", "normal"])(
    "rejects Git status scope %s before executor invocation",
    async (statusScope) => {
      let executions = 0;
      await expect(runReadOnlyGitGates({
        packageRoot: "C:\\package",
        statusScope,
        runGit: async () => {
          executions += 1;
          return { stdout: "", stderr: "" };
        },
      })).rejects.toThrow("IntentArc preflight Git status scope is invalid.");
      expect(executions).toBe(0);
    },
  );

  it("returns only bounded Git booleans and counts", async () => {
    const calls: string[][] = [];
    const evidence = await runReadOnlyGitGates({
      packageRoot: "C:\\package",
      statusScope: "tracked-only",
      runGit: async (arguments_: readonly string[]) => {
        calls.push([...arguments_]);
        return {
          stdout: isReadOnlyGitStatusVector(arguments_)
            ? "?? first.txt\0 M second.txt\0"
            : "",
          stderr: "warning: in the working copy of 'tracked.txt', LF will be replaced by CRLF the next time Git touches it\n",
        };
      },
    });
    expect(evidence).toEqual({
      diffCheckPassed: true,
      productDiffClean: true,
      statusClean: false,
      statusEntryCount: 2,
    });
    expect(calls).toEqual(readOnlyGitVectors.slice(1));
    expect(recursiveKeys(evidence).sort()).toEqual([
      "diffCheckPassed",
      "productDiffClean",
      "statusClean",
      "statusEntryCount",
    ]);
  });

  it("counts porcelain rename and copy records once", async () => {
    const evidence = await runReadOnlyGitGates({
      packageRoot: "C:\\package",
      statusScope: "tracked-only",
      runGit: async (arguments_: readonly string[]) => ({
        stdout: isReadOnlyGitStatusVector(arguments_)
          ? "R  renamed.txt\0original.txt\0C  copied.txt\0source.txt\0?? added.txt\0"
          : "",
        stderr: "",
      }),
    });
    expect(evidence).toEqual({
      diffCheckPassed: true,
      productDiffClean: true,
      statusClean: false,
      statusEntryCount: 3,
    });
  });

  it("rejects incomplete warnings and every other Git stderr without exposing it", async () => {
    for (const stderr of [
      "warning: in the working copy of 'tracked.txt', LF will be replaced by CRLF the next time Git touches it",
      "warning: unrelated warning\n",
      "secret-sentinel\n",
    ]) {
      let executions = 0;
      const operation = runReadOnlyGitGates({
        packageRoot: "C:\\package",
        statusScope: "tracked-only",
        runGit: async () => {
          executions += 1;
          return { stdout: "", stderr };
        },
      });
      await expect(operation).rejects.toThrow(
        "IntentArc preflight Git stderr is invalid.",
      );
      await expect(operation).rejects.not.toThrow(stderr.trim());
      expect(executions).toBe(1);
    }
  });

  it("atomically replaces a receipt with only the new validated JSON", async () => {
    const root = await createTemporaryRoot();
    const receiptPath = join(root, "receipts", "preflight.json");
    const oldReceipt = createReceipt();
    const newReceipt = failPreflightReceipt(createReceipt(), "initial-evidence");
    await mkdir(join(root, "receipts"), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(oldReceipt)}\n`);

    await writePreflightReceipt(receiptPath, newReceipt);

    expect(await readFile(receiptPath, "utf8")).toBe(
      `${JSON.stringify(newReceipt, null, 2)}\n`,
    );
    expect(await temporaryReceiptLeaves(receiptPath)).toEqual([]);
  });

  it("rejects a historical v1 receipt before any write or rename", async () => {
    const root = await createTemporaryRoot();
    const receiptPath = join(root, "receipts", "historical-v1.json");
    vi.mocked(writeFile).mockClear();
    vi.mocked(rename).mockClear();

    await expect(writePreflightReceipt(
      receiptPath,
      historicalReceiptV1() as ReturnType<typeof createInitialPreflightReceipt>,
    )).rejects.toThrow("IntentArc preflight receipt is invalid.");
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(invalidStatusScopeCases)(
    "rejects a v2 receipt with $name scope before any write or rename",
    async (scopeCase) => {
      const root = await createTemporaryRoot();
      const receiptPath = join(root, "receipts", `invalid-${scopeCase.name}.json`);
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();

      await expect(writePreflightReceipt(
        receiptPath,
        receiptWithInvalidStatusScope(scopeCase),
      )).rejects.toThrow("IntentArc preflight receipt is invalid.");
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    },
  );

  it("preserves the old receipt and removes its temp leaf after write failure", async () => {
    const root = await createTemporaryRoot();
    const receiptPath = join(root, "receipts", "preflight.json");
    const oldReceipt = createReceipt();
    const oldJson = `${JSON.stringify(oldReceipt, null, 2)}\n`;
    await mkdir(join(root, "receipts"), { recursive: true });
    await writeFile(receiptPath, oldJson);
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("secret write failure"));

    await expect(writePreflightReceipt(
      receiptPath,
      failPreflightReceipt(createReceipt(), "receipt-write"),
    )).rejects.toThrow("secret write failure");

    const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
    assertPreflightReceipt(persisted);
    expect(await readFile(receiptPath, "utf8")).toBe(oldJson);
    expect(await temporaryReceiptLeaves(receiptPath)).toEqual([]);
  });

  it("preserves the old receipt and removes its temp leaf after rename failure", async () => {
    const root = await createTemporaryRoot();
    const receiptPath = join(root, "receipts", "preflight.json");
    const oldReceipt = createReceipt();
    const oldJson = `${JSON.stringify(oldReceipt, null, 2)}\n`;
    await mkdir(join(root, "receipts"), { recursive: true });
    await writeFile(receiptPath, oldJson);
    vi.mocked(rename).mockRejectedValueOnce(new Error("secret rename failure"));

    await expect(writePreflightReceipt(
      receiptPath,
      failPreflightReceipt(createReceipt(), "receipt-write"),
    )).rejects.toThrow("secret rename failure");

    const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
    assertPreflightReceipt(persisted);
    expect(await readFile(receiptPath, "utf8")).toBe(oldJson);
    expect(await temporaryReceiptLeaves(receiptPath)).toEqual([]);
  });
});
