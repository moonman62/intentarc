import {
  createHash,
} from "node:crypto";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delegateStableBridgeLaunch,
} from "../bridge/entry.js";
import {
  applyPendingBridgeUpdate,
  installBridgeVersion,
  promoteBridgeStagingDirectory,
  readBridgePointer,
  readAuthenticodePublisher,
  recoverBridgeActivation,
  repairBridgePointer,
  resolveStableBridgeTarget,
  type BridgeBuildIdentity,
  type BridgePayloadVerification,
  type BridgeReleaseManifest,
} from "./bridge-install.js";

const temporaryRoots: string[] = [];
const selectorEnvironmentKeys = new Set([
  "comspec",
  "path",
  "systemroot",
]);
const selectorEnvironments = [
  {
    label: "hostile",
    environment: {
      SystemRoot: "C:\\attacker-system-root",
      SYSTEMROOT: "D:\\attacker-system-root",
      PATH: "C:\\attacker-bin",
      ComSpec: "C:\\attacker-cmd.exe",
    },
  },
  {
    label: "empty",
    environment: {
      SystemRoot: "",
      SYSTEMROOT: "",
      PATH: "",
      ComSpec: "",
    },
  },
] as const;
const activationOwnerEnvironmentKey =
  "INTENTARC_BRIDGE_ACTIVATION_TRANSACTION_OWNER";
const testTransactionId = "11111111-1111-4111-8111-111111111111";

const createFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `intentarc-bridge-${label}-`));
  temporaryRoots.push(root);
  const binaryRoot = join(root, "IntentArc");
  const payloadPath = join(root, "payload");
  await mkdir(join(payloadPath, "node_modules", "better-sqlite3", "prebuilds"), {
    recursive: true,
  });
  await writeFile(join(payloadPath, "IntentArc Bridge.exe"), "bridge-v1");
  await writeFile(
    join(
      payloadPath,
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      "win32-x64.node",
    ),
    "native-v1",
  );
  return { root, binaryRoot, payloadPath };
};

const isWithin = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !resolve(child).startsWith(".."));
};

const fixtureSupportDigest = (native = "native-v1"): string =>
  createHash("sha256")
    .update("prebuilds/win32-x64.node")
    .update("\0")
    .update(native)
    .update("\0")
    .digest("hex");

const developmentIdentity = (
  releaseVersion: string,
) => async () => ({
  formatVersion: 1 as const,
  releaseVersion,
  buildMode: "unsigned-development" as const,
  supportSha256: fixtureSupportDigest(),
});

const developmentIdentityFromFile = async (path: string) => ({
  formatVersion: 1 as const,
  releaseVersion: (await readFile(path, "utf8")).includes("v3")
    ? "0.3.0"
    : (await readFile(path, "utf8")).includes("v2")
    ? "0.2.0"
    : "0.1.0",
  buildMode: "unsigned-development" as const,
  supportSha256: fixtureSupportDigest(),
});

const readVersionManifest = async (
  versionDirectory: string,
): Promise<BridgeReleaseManifest> =>
  JSON.parse(await readFile(
    join(versionDirectory, "intentarc-bridge-release.json"),
    "utf8",
  )) as BridgeReleaseManifest;

const candidatePredecessorInspector = (
  predecessors: Readonly<Record<string, BridgeReleaseManifest>>,
) => async (path: string): Promise<BridgeReleaseManifest | null> => {
  const executable = await readFile(path, "utf8");
  return predecessors[executable] ?? null;
};

const withSelectorEnvironment = async <T>(
  environment: Readonly<Record<string, string>>,
  action: () => Promise<T>,
): Promise<T> => {
  const original = Object.entries(process.env).filter(([key]) =>
    selectorEnvironmentKeys.has(key.toLowerCase())
  );
  const removeSelectors = (): void => {
    for (const key of Object.keys(process.env)) {
      if (selectorEnvironmentKeys.has(key.toLowerCase())) {
        delete process.env[key];
      }
    }
  };
  removeSelectors();
  Object.assign(process.env, environment);
  try {
    return await action();
  } finally {
    removeSelectors();
    for (const [key, value] of original) process.env[key] = value;
  }
};

const recoveryRecord = (
  previous: BridgeReleaseManifest | null,
  candidate: BridgeReleaseManifest,
  rollbackFile: string,
) => ({
  formatVersion: 2,
  transactionId: testTransactionId,
  phase: "active-verification",
  previous,
  candidate,
  rollbackFile,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("versioned bridge installation", () => {
  it("does not promote a staging payload while staged verification is parked", async () => {
    const fixture = await createFixture("parked-staged-verifier");
    const releaseVerification = deferred();
    let stagedVerificationStarted!: () => void;
    const stagedVerification = new Promise<void>((resolve) => {
      stagedVerificationStarted = resolve;
    });
    const installing = installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async ({ phase }) => {
        if (phase === "staged") {
          stagedVerificationStarted();
          await releaseVerification.promise;
        }
      },
    });

    await stagedVerification;
    const versionsRoot = join(fixture.binaryRoot, "bridge", "versions");
    expect(await readdir(versionsRoot)).toEqual([]);

    releaseVerification.resolve();
    await installing;
    expect(await readdir(versionsRoot)).toHaveLength(1);
  });

  it("rejects a same-path staging replacement performed by staged verification", async () => {
    const fixture = await createFixture("staged-verifier-replacement");
    const versionsRoot = join(fixture.binaryRoot, "bridge", "versions");

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async ({ phase, versionDirectory }) => {
        if (phase !== "staged") return;
        const parked = join(dirname(versionDirectory), ".parked-original");
        await rename(versionDirectory, parked);
        await cp(parked, versionDirectory, { recursive: true });
      },
    })).rejects.toThrow(/staging source identity changed/i);

    expect(await readdir(versionsRoot)).toEqual([]);
  });

  it("verifies a staged immutable payload before atomically switching a stable launcher", async () => {
    const fixture = await createFixture("stage");
    const phases: Array<{
      phase: BridgePayloadVerification["phase"];
      executablePath: string;
      currentExists: boolean;
    }> = [];

    const installed = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async (input) => {
        phases.push({
          phase: input.phase,
          executablePath: input.executablePath,
          currentExists: await lstat(
            join(fixture.binaryRoot, "bridge", "current"),
          ).then(() => true, () => false),
        });
        expect(await readFile(input.executablePath, "utf8")).toBe("bridge-v1");
      },
    });

    expect(phases.map(({ phase }) => phase)).toEqual(["staged", "active"]);
    expect(phases[0]?.currentExists).toBe(false);
    expect((await lstat(installed.currentDirectory)).isDirectory()).toBe(true);
    expect((await lstat(installed.currentDirectory)).isSymbolicLink()).toBe(false);
    expect(isWithin(
      await realpath(fixture.binaryRoot),
      await realpath(installed.currentDirectory),
    )).toBe(true);
    expect(installed.executablePath).toBe(
      join(installed.currentDirectory, "IntentArc Bridge.exe"),
    );
    expect(installed.versionDirectory).toMatch(
      /[\\/]bridge[\\/]versions[\\/]0\.1\.0-[a-f0-9]{16}$/,
    );
    expect(await readFile(installed.executablePath, "utf8")).toBe("bridge-v1");
  });

  it("keeps the launcher and pointer continuously readable during a switch and rolls back on active rejection", async () => {
    const fixture = await createFixture("rollback");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");

    let beginActiveVerification!: () => void;
    const activeVerificationStarted = new Promise<void>((resolve) => {
      beginActiveVerification = resolve;
    });
    let rejectActiveVerification!: () => void;
    const releaseActiveVerification = new Promise<void>((resolve) => {
      rejectActiveVerification = resolve;
    });
    const switching = installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async ({ phase, versionDirectory }) => {
        if (phase === "active" && versionDirectory !== first.versionDirectory) {
          beginActiveVerification();
          await releaseActiveVerification;
          throw new Error("synthetic health failure");
        }
      },
    });

    await activeVerificationStarted;
    const observed = await Promise.all(Array.from({ length: 50 }, async () => {
      const pointer = await readBridgePointer({ binaryRoot: fixture.binaryRoot });
      const launcherInfo = await lstat(pointer.executablePath);
      return {
        launcherIsFile: launcherInfo.isFile() && !launcherInfo.isSymbolicLink(),
        versionDirectory: pointer.versionDirectory,
      };
    }));
    expect(observed.every(({ launcherIsFile }) => launcherIsFile)).toBe(true);
    expect(observed.every(({ versionDirectory }) =>
      versionDirectory !== first.versionDirectory
    )).toBe(true);
    rejectActiveVerification();
    await expect(switching).rejects.toThrow("synthetic health failure");

    const current = await readBridgePointer({ binaryRoot: fixture.binaryRoot });
    expect(current.versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(current.executablePath, "utf8")).toBe("bridge-v1");
  });

  it("leaves one outer activation owner in charge until stable-path protocol verification succeeds", async () => {
    const fixture = await createFixture("activation-owner-success");
    await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    let protocolChecks = 0;
    let nestedRecoveries = 0;

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async (input) => {
        if (input.phase !== "active") return;
        const transaction = input.activationTransaction;
        const journal = JSON.parse(await readFile(recoveryPath, "utf8")) as {
          formatVersion: number;
          transactionId: string;
          phase: string;
        };
        expect(transaction).toEqual({
          transactionId: journal.transactionId,
          phase: journal.phase,
        });
        expect(journal).toMatchObject({
          formatVersion: 2,
          transactionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          phase: "active-verification",
        });

        await delegateStableBridgeLaunch({
          executablePath: input.executablePath,
          environment: {
            [activationOwnerEnvironmentKey]: transaction?.transactionId,
          },
          recoverActivation: async () => {
            nestedRecoveries += 1;
            throw new Error("the verification child must not own recovery");
          },
          authenticateTarget: async () => ({
            targetPath: join(input.versionDirectory, "IntentArc Bridge.exe"),
            executableSha256: "a".repeat(64),
            identity: {
              formatVersion: 1,
              releaseVersion: "0.2.0",
              buildMode: "unsigned-development",
              supportSha256: fixtureSupportDigest(),
            },
          }),
          launchTarget: async () => {
            protocolChecks += 1;
            expect(await lstat(recoveryPath).then(() => true, () => false))
              .toBe(true);
            return 0;
          },
          setExitCode: () => undefined,
        });
      },
    })).resolves.toMatchObject({ pendingLauncherUpdate: false });

    expect(protocolChecks).toBe(1);
    expect(nestedRecoveries).toBe(0);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
  });

  it("retains the live journal when candidate protocol verification and launcher rollback both fail", async () => {
    const fixture = await createFixture("activation-owner-failure");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    let replacements = 0;

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async (input) => {
        if (
          input.phase !== "active" ||
          input.versionDirectory === first.versionDirectory
        ) {
          return;
        }
        const journal = JSON.parse(await readFile(recoveryPath, "utf8")) as {
          transactionId: string;
        };
        await delegateStableBridgeLaunch({
          executablePath: input.executablePath,
          environment: {
            [activationOwnerEnvironmentKey]: input.activationTransaction
              ?.transactionId,
          },
          authenticateTarget: async () => ({
            targetPath: join(input.versionDirectory, "IntentArc Bridge.exe"),
            executableSha256: "b".repeat(64),
            identity: {
              formatVersion: 1,
              releaseVersion: "0.2.0",
              buildMode: "unsigned-development",
              supportSha256: fixtureSupportDigest(),
            },
          }),
          launchTarget: async () => {
            expect(input.activationTransaction?.transactionId).toBe(
              journal.transactionId,
            );
            throw new Error("candidate MCP protocol rejection");
          },
          setExitCode: () => undefined,
        });
      },
      replaceStableLauncher: async ({
        sourcePath,
        destinationPath,
        rollbackPath,
      }) => {
        replacements += 1;
        if (replacements > 1) {
          throw Object.assign(new Error("rollback still locked"), {
            code: "EPERM",
          });
        }
        await copyFile(destinationPath, rollbackPath);
        await copyFile(sourcePath, destinationPath);
      },
    })).rejects.toThrow(/activation|protocol|recovery|rollback/i);

    expect(replacements).toBe(2);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
  });

  it("updates the stable launcher with a distinct release and retains every installed version", async () => {
    const fixture = await createFixture("retention");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const second = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
    });

    expect(await readFile(second.executablePath, "utf8")).toBe("bridge-v2");
    expect(await lstat(first.versionDirectory).then(() => true, () => false))
      .toBe(true);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v3");
    const third = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.3.0",
      inspectLauncherIdentity: developmentIdentity("0.2.0"),
      verify: async () => undefined,
    });

    expect(third.removedVersionDirectories).toEqual([]);
    expect(await lstat(first.versionDirectory).then(() => true, () => false))
      .toBe(true);
    expect(await lstat(second.versionDirectory).then(() => true, () => false))
      .toBe(true);
    expect(await lstat(
      join(fixture.binaryRoot, "bridge", "active-references"),
    ).then(() => true, () => false)).toBe(false);
  });

  it.skipIf(process.platform !== "win32").each(selectorEnvironments)(
    "atomically replaces the stable launcher with a $label selector environment",
    async ({ label, environment }) => {
      const fixture = await createFixture(`replacement-${label}`);
      await installBridgeVersion({
        binaryRoot: fixture.binaryRoot,
        payloadPath: fixture.payloadPath,
        version: "0.1.0",
        verify: async () => undefined,
      });
      await writeFile(
        join(fixture.payloadPath, "IntentArc Bridge.exe"),
        "bridge-v2",
      );

      const installed = await withSelectorEnvironment(
        environment,
        () => installBridgeVersion({
          binaryRoot: fixture.binaryRoot,
          payloadPath: fixture.payloadPath,
          version: "0.2.0",
          inspectLauncherIdentity: developmentIdentityFromFile,
          verify: async () => undefined,
        }),
      );

      expect(installed.pendingLauncherUpdate).toBe(false);
      expect(await readFile(installed.executablePath, "utf8")).toBe("bridge-v2");
    },
  );

  it("keeps the previous public launcher and pointer when Windows locks replacement, then resumes at startup", async () => {
    const fixture = await createFixture("pending-launcher");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const locked = Object.assign(new Error("locked"), { code: "EPERM" });
    const pending = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
      replaceStableLauncher: async () => {
        throw locked;
      },
    });

    expect(pending.pendingLauncherUpdate).toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v1");

    const resumed = await applyPendingBridgeUpdate({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
    });
    expect(resumed?.pendingLauncherUpdate).toBe(false);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v2");
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(pending.versionDirectory);
  });

  it("authenticates pointer metadata, digest, release ordering, build mode, and publisher before delegation", async () => {
    const fixture = await createFixture("delegation-auth");
    const publisher = {
      thumbprint: "AA11",
      subject: "CN=IntentArc",
    };
    const installed = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
        publisher,
      }),
    });
    const signedLauncher: BridgeBuildIdentity = {
      formatVersion: 1,
      releaseVersion: "0.2.0",
      buildMode: "signed-release",
      supportSha256: "a".repeat(64),
    };

    await expect(resolveStableBridgeTarget(installed.executablePath, {
      launcherIdentity: signedLauncher,
      authenticateTarget: async () => ({
        ...signedLauncher,
        releaseVersion: "0.1.0",
        publisher,
      }),
      authenticateLauncher: async () => publisher,
    })).rejects.toThrow(/downgrade|version/i);

    await expect(resolveStableBridgeTarget(installed.executablePath, {
      launcherIdentity: {
        ...signedLauncher,
        releaseVersion: "0.1.0",
      },
      authenticateTarget: async () => ({
        ...signedLauncher,
        releaseVersion: "0.1.0",
        buildMode: "unsigned-development",
      }),
      authenticateLauncher: async () => publisher,
    })).rejects.toThrow(/unsigned|signed|mode/i);

    await expect(resolveStableBridgeTarget(installed.executablePath, {
      launcherIdentity: {
        ...signedLauncher,
        releaseVersion: "0.1.0",
        supportSha256: fixtureSupportDigest(),
      },
      authenticateTarget: async () => ({
        ...signedLauncher,
        releaseVersion: "0.1.0",
        supportSha256: fixtureSupportDigest(),
        publisher: {
          thumbprint: "BB22",
          subject: "CN=Attacker",
        },
      }),
      authenticateLauncher: async () => publisher,
    })).rejects.toThrow(/publisher|trusted/i);

    const targetExecutable = join(
      installed.versionDirectory,
      "IntentArc Bridge.exe",
    );
    await writeFile(targetExecutable, "attacker-replaced-executable");
    await expect(resolveStableBridgeTarget(installed.executablePath, {
      launcherIdentity: {
        ...signedLauncher,
        releaseVersion: "0.1.0",
      },
      authenticateTarget: async () => ({
        ...signedLauncher,
        releaseVersion: "0.1.0",
        publisher,
      }),
      authenticateLauncher: async () => publisher,
    })).rejects.toThrow(/digest|payload|manifest/i);
    await writeFile(targetExecutable, "bridge-v1");

    const pointerPath = join(
      fixture.binaryRoot,
      "bridge",
      "current-version.json",
    );
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      versionDirectory: string;
    };
    await writeFile(pointerPath, JSON.stringify({
      ...pointer,
      versionDirectory: "attacker-selected-version",
    }));
    await expect(resolveStableBridgeTarget(installed.executablePath, {
      launcherIdentity: {
        ...signedLauncher,
        releaseVersion: "0.1.0",
      },
      authenticateTarget: async () => ({
        ...signedLauncher,
        releaseVersion: "0.1.0",
        publisher,
      }),
      authenticateLauncher: async () => publisher,
    })).rejects.toThrow(/manifest|pointer|version/i);
  });

  it.skipIf(process.platform !== "win32").each(selectorEnvironments)(
    "authenticates an ordinary signed stable delegation with a $label selector environment",
    async ({ label, environment }) => {
      const fixture = await createFixture(`signed-delegation-${label}`);
      const systemPowerShell = await realpath(
        "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      await copyFile(
        systemPowerShell,
        join(fixture.payloadPath, "IntentArc Bridge.exe"),
      );
      const publisher = await readAuthenticodePublisher(systemPowerShell);
      const identity: BridgeBuildIdentity = {
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
      };
      const installed = await installBridgeVersion({
        binaryRoot: fixture.binaryRoot,
        payloadPath: fixture.payloadPath,
        version: "0.1.0",
        verify: async () => ({
          ...identity,
          publisher,
        }),
      });

      const launch = await withSelectorEnvironment(
        environment,
        () => resolveStableBridgeTarget(installed.executablePath, {
          launcherIdentity: identity,
          authenticateTarget: async (path) => ({
            ...identity,
            publisher: await readAuthenticodePublisher(path),
          }),
        }),
      );

      expect(launch).toBe(join(
        installed.versionDirectory,
        "IntentArc Bridge.exe",
      ));
    },
    30_000,
  );

  it("anchors update mode and publisher continuity to the authenticated installed launcher", async () => {
    const fixture = await createFixture("update-trust-continuity");
    const publisher = {
      thumbprint: "AA11",
      subject: "CN=IntentArc",
    };
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
        publisher,
      }),
    });
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
        publisher,
      }),
      verify: async () => ({
        formatVersion: 1,
        releaseVersion: "0.2.0",
        buildMode: "unsigned-development",
        supportSha256: fixtureSupportDigest(),
      }),
    })).rejects.toThrow(/mode|signed|continuity/i);

    await writeFile(
      join(fixture.payloadPath, "IntentArc Bridge.exe"),
      "bridge-v2-publisher",
    );
    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: async () => ({
        formatVersion: 1,
        releaseVersion: "0.1.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
        publisher,
      }),
      verify: async () => ({
        formatVersion: 1,
        releaseVersion: "0.2.0",
        buildMode: "signed-release",
        supportSha256: fixtureSupportDigest(),
        publisher: {
          thumbprint: "BB22",
          subject: "CN=Other Publisher",
        },
      }),
    })).rejects.toThrow(/publisher|continuity|trusted/i);

    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v1");
  });

  it("rejects a payload replaced between staged verification and active publication and restores v1", async () => {
    const fixture = await createFixture("staged-active-replacement");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    let replacements = 0;

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
      replaceStableLauncher: async ({
        sourcePath,
        destinationPath,
        rollbackPath,
      }) => {
        replacements += 1;
        await copyFile(destinationPath, rollbackPath);
        await copyFile(sourcePath, destinationPath);
        if (replacements === 1) {
          const pointer = await readBridgePointer({
            binaryRoot: fixture.binaryRoot,
          });
          await writeFile(
            join(pointer.versionDirectory, "IntentArc Bridge.exe"),
            "attacker-replaced-after-stage",
          );
        }
      },
    })).rejects.toThrow(/digest|changed|payload/i);

    expect(replacements).toBe(2);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v1");
  });

  it("recovers a crash after pointer publication from a journal flushed before publication", async () => {
    const fixture = await createFixture("crash-after-pointer");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const publication = Promise.withResolvers<void>();
    const processCrash = Promise.withResolvers<void>();

    void installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": previous,
      }),
      verify: async () => undefined,
      replaceStableLauncher: async () => {
        publication.resolve();
        await processCrash.promise;
      },
    });
    await publication.promise;

    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).not.toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v1");

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": previous,
      }),
      verify: async () => undefined,
    })).resolves.toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
  });

  it("completes a healthy candidate after a crash following launcher publication", async () => {
    const fixture = await createFixture("crash-after-launcher");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const publication = Promise.withResolvers<void>();
    const processCrash = Promise.withResolvers<void>();

    void installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": previous,
      }),
      verify: async () => undefined,
      replaceStableLauncher: async ({
        sourcePath,
        destinationPath,
        rollbackPath,
      }) => {
        await copyFile(destinationPath, rollbackPath);
        await copyFile(sourcePath, destinationPath);
        publication.resolve();
        await processCrash.promise;
      },
    });
    await publication.promise;

    const candidate = await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    });
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    expect(await readFile(candidate.executablePath, "utf8")).toBe("bridge-v2");
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": previous,
      }),
      verify: async () => undefined,
    })).resolves.toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(candidate.versionDirectory);
    expect(await readFile(candidate.executablePath, "utf8")).toBe("bridge-v2");
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
    expect((await readdir(join(fixture.binaryRoot, "bridge")))
      .some((entry) => entry.startsWith(".completed-activation-"))).toBe(true);
  });

  it("archives a forged stale journal without downgrading a healthy current pair", async () => {
    const fixture = await createFixture("forged-stale-recovery");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const firstManifest = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const second = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
    });
    const secondManifest = await readVersionManifest(second.versionDirectory);
    const rollbackFile = (await readdir(second.currentDirectory))
      .find((entry) => entry.startsWith(".launcher-rollback-"));
    expect(rollbackFile).toBeDefined();

    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v3");
    const third = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.3.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
    });
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    await writeFile(
      recoveryPath,
      `${JSON.stringify(recoveryRecord(
        firstManifest,
        secondManifest,
        rollbackFile!,
      ))}\n`,
    );

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": firstManifest,
        "bridge-v3": secondManifest,
      }),
      verify: async () => undefined,
    })).resolves.toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(third.versionDirectory);
    expect(await readFile(third.executablePath, "utf8")).toBe("bridge-v3");
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
  });

  it("retains a forged stale journal when a damaged pointer is paired with an unrelated later launcher", async () => {
    const fixture = await createFixture("forged-mixed-recovery");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const firstManifest = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const second = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
    });
    const secondManifest = await readVersionManifest(second.versionDirectory);
    const rollbackFile = (await readdir(second.currentDirectory))
      .find((entry) => entry.startsWith(".launcher-rollback-"));
    expect(rollbackFile).toBeDefined();

    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v3");
    await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.3.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
    });
    const bridgeRoot = join(fixture.binaryRoot, "bridge");
    const recoveryPath = join(bridgeRoot, "activation-recovery.json");
    await writeFile(
      join(bridgeRoot, "current-version.json"),
      `${JSON.stringify(secondManifest)}\n`,
    );
    await writeFile(
      recoveryPath,
      `${JSON.stringify(recoveryRecord(
        firstManifest,
        secondManifest,
        rollbackFile!,
      ))}\n`,
    );

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: candidatePredecessorInspector({
        "bridge-v2": firstManifest,
      }),
      verify: async () => undefined,
    })).rejects.toThrow(/launcher|transaction|recovery/i);
    expect(await readFile(
      join(bridgeRoot, "current", "IntentArc Bridge.exe"),
      "utf8",
    )).toBe("bridge-v3");
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
  });

  it("requires the candidate to embed the exact predecessor before rollback and retains the journal on rejection", async () => {
    const fixture = await createFixture("exact-predecessor-recovery");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    const publication = Promise.withResolvers<void>();
    const processCrash = Promise.withResolvers<void>();

    void installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      verify: async () => undefined,
      replaceStableLauncher: async () => {
        publication.resolve();
        await processCrash.promise;
      },
    });
    await publication.promise;
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => ({
        ...previous,
        executableSha256: "f".repeat(64),
      }),
      verify: async () => undefined,
    })).rejects.toThrow(/authorize|predecessor|rollback/i);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).not.toBe(first.versionDirectory);

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
    })).resolves.toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
  });

  it("persists deterministic recovery when launcher rollback replacement fails and completes it on restart", async () => {
    const fixture = await createFixture("rollback-recovery");
    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const previous = await readVersionManifest(first.versionDirectory);
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    let replacements = 0;

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async ({ phase, versionDirectory }) => {
        if (phase === "active" && versionDirectory !== first.versionDirectory) {
          throw new Error("active rejection");
        }
      },
      replaceStableLauncher: async ({
        sourcePath,
        destinationPath,
        rollbackPath,
      }) => {
        replacements += 1;
        if (replacements === 2) {
          throw Object.assign(new Error("rollback locked"), { code: "EPERM" });
        }
        await copyFile(destinationPath, rollbackPath);
        await copyFile(sourcePath, destinationPath);
      },
    })).rejects.toThrow(/activation|recovery|rollback/i);

    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    const recoveryPath = join(
      fixture.binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v2");

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
      replaceStableLauncher: async () => {
        throw Object.assign(new Error("still locked after restart"), {
          code: "EPERM",
        });
      },
    })).rejects.toThrow(/locked|restart/i);
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(true);
    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v2");

    await expect(recoverBridgeActivation({
      binaryRoot: fixture.binaryRoot,
      inspectLauncherIdentity: developmentIdentityFromFile,
      inspectCandidatePredecessor: async () => previous,
      verify: async () => undefined,
      replaceStableLauncher: async ({
        sourcePath,
        destinationPath,
        rollbackPath,
      }) => {
        await copyFile(destinationPath, rollbackPath);
        await copyFile(sourcePath, destinationPath);
      },
    })).resolves.toBe(true);

    expect((await readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).versionDirectory).toBe(first.versionDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe("bridge-v1");
    expect(await lstat(recoveryPath).then(() => true, () => false)).toBe(false);
    expect((await readdir(join(fixture.binaryRoot, "bridge")))
      .some((entry) => entry.startsWith(".recovered-activation-"))).toBe(true);
  });

  it("never follows an external or malformed pointer during repair", async () => {
    const fixture = await createFixture("traversal");
    const installed = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    const pointer = join(
      fixture.binaryRoot,
      "bridge",
      "current-version.json",
    );
    const external = join(fixture.root, "external");
    await cp(fixture.payloadPath, external, { recursive: true });
    await writeFile(pointer, JSON.stringify({
      formatVersion: 1,
      versionDirectory: relative(
        join(fixture.binaryRoot, "bridge", "versions"),
        external,
      ),
    }));

    await expect(readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).rejects.toThrow(/outside|pointer/i);
    await expect(repairBridgePointer({
      binaryRoot: fixture.binaryRoot,
      versionDirectory: external,
      verify: async () => undefined,
    })).rejects.toThrow(/outside|version/i);

    await writeFile(pointer, "{not-json");
    await expect(readBridgePointer({
      binaryRoot: fixture.binaryRoot,
    })).rejects.toThrow(/malformed|pointer/i);

    const repaired = await repairBridgePointer({
      binaryRoot: fixture.binaryRoot,
      versionDirectory: installed.versionDirectory,
      verify: async () => undefined,
    });
    expect(repaired.versionDirectory).toBe(installed.versionDirectory);
    expect((await lstat(repaired.currentDirectory)).isDirectory()).toBe(true);
  });

  it("rejects payload symlinks and version traversal before copying", async () => {
    const fixture = await createFixture("payload-safety");
    await symlink(
      join(fixture.root, "outside"),
      join(fixture.payloadPath, "unsafe-link"),
      "junction",
    );

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "../escape",
      verify: async () => undefined,
    })).rejects.toThrow(/version/i);
    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    })).rejects.toThrow(/symbolic|reparse|payload/i);
    expect(await lstat(join(fixture.root, "escape")).then(() => true, () => false))
      .toBe(false);
  });

  it("never creates active-reference state or automatically deletes through a swapped parent", async () => {
    const fixture = await createFixture("parent-swap");
    const external = join(fixture.root, "external");
    const sentinel = join(external, "sentinel.txt");
    await mkdir(external);
    await writeFile(sentinel, "preserve");
    await mkdir(join(fixture.binaryRoot, "bridge"), { recursive: true });
    await symlink(
      external,
      join(fixture.binaryRoot, "bridge", "active-references"),
      "junction",
    );

    const first = await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async () => undefined,
    });
    await writeFile(join(fixture.payloadPath, "IntentArc Bridge.exe"), "bridge-v2");
    await installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.2.0",
      inspectLauncherIdentity: developmentIdentity("0.1.0"),
      verify: async () => undefined,
    });

    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    expect(await lstat(first.versionDirectory).then(() => true, () => false))
      .toBe(true);
    expect(await lstat(
      join(fixture.binaryRoot, "bridge", "active-references"),
    ).then((info) => info.isSymbolicLink(), () => false)).toBe(true);
  });

  it("retains an abandoned staging payload instead of recursively deleting through a mutable parent", async () => {
    const fixture = await createFixture("retained-staging");

    await expect(installBridgeVersion({
      binaryRoot: fixture.binaryRoot,
      payloadPath: fixture.payloadPath,
      version: "0.1.0",
      verify: async ({ phase }) => {
        if (phase === "staged") throw new Error("synthetic rejection");
      },
    })).rejects.toThrow("synthetic rejection");

    const bridgeRoot = join(fixture.binaryRoot, "bridge");
    const retained = (await readdir(bridgeRoot))
      .filter((entry) => entry.startsWith(".staging-"));
    expect(retained).toHaveLength(1);
    expect(await readFile(
      join(bridgeRoot, retained[0]!, "IntentArc Bridge.exe"),
      "utf8",
    )).toBe("bridge-v1");
  });
});

const promotionError = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

const promotionHarness = (platform: NodeJS.Platform = "win32") => {
  const bridgeRoot = "C:\\IntentArc\\bridge";
  const versionsRoot = join(bridgeRoot, "versions");
  const stagingDirectory = join(
    bridgeRoot,
    ".staging-0.1.0-11111111-1111-4111-8111-111111111111",
  );
  const versionDirectory = join(
    versionsRoot,
    "0.1.0-0123456789abcdef",
  );
  let now = 0;
  let destinationExists = false;
  const canonical = new Map<string, string>();
  const identities = new Map<string, { readonly dev: bigint; readonly ino: bigint }>();
  const identityFor = (path: string) => identities.get(path) ?? {
    dev: 1n,
    ino: path === bridgeRoot ? 1n : path === versionsRoot ? 2n : 3n,
  };
  const renamePath = vi.fn(async () => undefined);
  const waits: number[] = [];
  const dependencies = {
    platform,
    rename: renamePath,
    lstat: vi.fn(async (path: string) => {
      if (path === versionDirectory && !destinationExists) {
        throw promotionError("ENOENT");
      }
      return {
        ...identityFor(path),
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    }),
    realpath: vi.fn(async (path: string) => canonical.get(path) ?? path),
    now: () => now,
    wait: vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    }),
  };
  return {
    bridgeRoot,
    baseline: {
      bridgeRoot: { canonicalPath: bridgeRoot, dev: 1n, ino: 1n },
      versionsRoot: { canonicalPath: versionsRoot, dev: 1n, ino: 2n },
      stagingDirectory: { canonicalPath: stagingDirectory, dev: 1n, ino: 3n },
    },
    canonical,
    identities,
    dependencies,
    renamePath,
    setDestinationExists: (value: boolean) => {
      destinationExists = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    stagingDirectory,
    versionDirectory,
    versionsRoot,
    waits,
  };
};

const promoteWithHarness = (
  harness: ReturnType<typeof promotionHarness>,
  signal?: AbortSignal,
) => promoteBridgeStagingDirectory({
  bridgeRoot: harness.bridgeRoot,
  versionsRoot: harness.versionsRoot,
  stagingDirectory: harness.stagingDirectory,
  versionDirectory: harness.versionDirectory,
  baseline: harness.baseline,
  ...(signal === undefined ? {} : { signal }),
}, harness.dependencies);

describe("bridge staging promotion", () => {
  it("retries only Windows EPERM with the exact 25 and 50 ms waits", async () => {
    const harness = promotionHarness();
    harness.renamePath
      .mockRejectedValueOnce(promotionError("EPERM", "first"))
      .mockRejectedValueOnce(promotionError("EPERM", "second"));

    await promoteWithHarness(harness);

    expect(harness.renamePath).toHaveBeenCalledTimes(3);
    expect(harness.waits).toEqual([25, 50]);
  });

  it("continues after five Windows EPERMs and succeeds on attempt six", async () => {
    const harness = promotionHarness();
    harness.renamePath
      .mockRejectedValueOnce(promotionError("EPERM", "first"))
      .mockRejectedValueOnce(promotionError("EPERM", "second"))
      .mockRejectedValueOnce(promotionError("EPERM", "third"))
      .mockRejectedValueOnce(promotionError("EPERM", "fourth"))
      .mockRejectedValueOnce(promotionError("EPERM", "fifth"));

    await promoteWithHarness(harness);

    expect(harness.renamePath).toHaveBeenCalledTimes(6);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400]);
  });

  it("throws the exact first EPERM after eight attempts", async () => {
    const harness = promotionHarness();
    const first = promotionError("EPERM", "first");
    harness.renamePath
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(promotionError("EPERM", "second"))
      .mockRejectedValueOnce(promotionError("EPERM", "third"))
      .mockRejectedValueOnce(promotionError("EPERM", "fourth"))
      .mockRejectedValueOnce(promotionError("EPERM", "fifth"))
      .mockRejectedValueOnce(promotionError("EPERM", "sixth"))
      .mockRejectedValueOnce(promotionError("EPERM", "seventh"))
      .mockRejectedValueOnce(promotionError("EPERM", "eighth"));

    await expect(promoteWithHarness(harness)).rejects.toBe(first);
    expect(harness.renamePath).toHaveBeenCalledTimes(8);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400, 400, 400]);
  });

  it("does not rename at or after the 2,000 ms monotonic deadline", async () => {
    const harness = promotionHarness();
    const first = promotionError("EPERM", "first");
    harness.renamePath.mockRejectedValueOnce(first);
    harness.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      harness.waits.push(milliseconds);
      harness.setNow(2_000);
    });

    await expect(promoteWithHarness(harness)).rejects.toBe(first);
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([25]);
  });

  it("does not begin the first rename after proof exhausts the deadline", async () => {
    const harness = promotionHarness();
    harness.dependencies.realpath.mockImplementation(async (path) => {
      harness.setNow(2_000);
      return path;
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(/deadline/i);
    expect(harness.renamePath).not.toHaveBeenCalled();
  });

  it("clamps a wait to the remaining monotonic deadline budget", async () => {
    const harness = promotionHarness();
    const first = promotionError("EPERM", "first");
    harness.renamePath.mockImplementationOnce(async () => {
      harness.setNow(1_990);
      throw first;
    });

    await expect(promoteWithHarness(harness)).rejects.toBe(first);
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([10]);
  });

  it("honors abort during the extended 400 ms retry tail", async () => {
    const harness = promotionHarness();
    const abort = new AbortController();
    const reason = new Error("abort during extended retry tail");
    harness.renamePath
      .mockRejectedValueOnce(promotionError("EPERM", "first"))
      .mockRejectedValueOnce(promotionError("EPERM", "second"))
      .mockRejectedValueOnce(promotionError("EPERM", "third"))
      .mockRejectedValueOnce(promotionError("EPERM", "fourth"))
      .mockRejectedValueOnce(promotionError("EPERM", "fifth"));
    harness.dependencies.wait.mockImplementation(async (milliseconds) => {
      harness.waits.push(milliseconds);
      if (milliseconds === 400) abort.abort(reason);
    });

    await expect(promoteWithHarness(harness, abort.signal)).rejects.toBe(reason);
    expect(harness.renamePath).toHaveBeenCalledTimes(5);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400]);
  });

  it("revalidates staging identity before the extended sixth attempt", async () => {
    const harness = promotionHarness();
    harness.renamePath
      .mockRejectedValueOnce(promotionError("EPERM", "first"))
      .mockRejectedValueOnce(promotionError("EPERM", "second"))
      .mockRejectedValueOnce(promotionError("EPERM", "third"))
      .mockRejectedValueOnce(promotionError("EPERM", "fourth"))
      .mockRejectedValueOnce(promotionError("EPERM", "fifth"));
    harness.dependencies.wait.mockImplementation(async (milliseconds) => {
      harness.waits.push(milliseconds);
      if (milliseconds === 400) {
        harness.identities.set(
          harness.stagingDirectory,
          { dev: 9n, ino: 3n },
        );
      }
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(
      /staging source identity changed/i,
    );
    expect(harness.renamePath).toHaveBeenCalledTimes(5);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400]);
  });

  it("honors abort before the first proof and during a wait", async () => {
    const before = promotionHarness();
    const beforeAbort = new AbortController();
    const beforeReason = new Error("abort before");
    beforeAbort.abort(beforeReason);

    await expect(promoteWithHarness(before, beforeAbort.signal)).rejects
      .toBe(beforeReason);
    expect(before.renamePath).not.toHaveBeenCalled();

    const during = promotionHarness();
    const duringAbort = new AbortController();
    const duringReason = new Error("abort during wait");
    during.renamePath.mockRejectedValueOnce(promotionError("EPERM"));
    during.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      during.waits.push(milliseconds);
      duringAbort.abort(duringReason);
    });

    await expect(promoteWithHarness(during, duringAbort.signal)).rejects
      .toBe(duringReason);
    expect(during.renamePath).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["linux EPERM", "linux" as NodeJS.Platform, promotionError("EPERM")],
    ["Windows EBUSY", "win32" as NodeJS.Platform, promotionError("EBUSY")],
    ["Windows EACCES", "win32" as NodeJS.Platform, promotionError("EACCES")],
    ["Windows ENOTEMPTY", "win32" as NodeJS.Platform, promotionError("ENOTEMPTY")],
    ["Windows EEXIST", "win32" as NodeJS.Platform, promotionError("EEXIST")],
    ["Windows ENOENT", "win32" as NodeJS.Platform, promotionError("ENOENT")],
    ["Windows unknown", "win32" as NodeJS.Platform, new Error("unknown")],
  ])("fails %s on the first rename", async (_label, platform, error) => {
    const harness = promotionHarness(platform);
    harness.renamePath.mockRejectedValueOnce(error);

    await expect(promoteWithHarness(harness)).rejects.toBe(error);
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
  });

  it("fails immediately on a later different error", async () => {
    const harness = promotionHarness();
    const later = promotionError("EACCES", "later");
    harness.renamePath
      .mockRejectedValueOnce(promotionError("EPERM", "first"))
      .mockRejectedValueOnce(later);

    await expect(promoteWithHarness(harness)).rejects.toBe(later);
    expect(harness.renamePath).toHaveBeenCalledTimes(2);
    expect(harness.waits).toEqual([25]);
  });

  it("refuses promotion when the destination appears before retry", async () => {
    const harness = promotionHarness();
    harness.renamePath.mockRejectedValueOnce(promotionError("EPERM"));
    harness.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      harness.waits.push(milliseconds);
      harness.setDestinationExists(true);
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(
      /destination already exists/i,
    );
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bridge root", (harness: ReturnType<typeof promotionHarness>) => {
      harness.canonical.set(harness.bridgeRoot, `${harness.bridgeRoot}-changed`);
    }],
    ["versions root", (harness: ReturnType<typeof promotionHarness>) => {
      harness.canonical.set(harness.versionsRoot, `${harness.versionsRoot}-changed`);
    }],
    ["staging source", (harness: ReturnType<typeof promotionHarness>) => {
      harness.canonical.set(
        harness.stagingDirectory,
        `${harness.stagingDirectory}-changed`,
      );
    }],
  ])("refuses a changed %s identity before retry", async (_label, change) => {
    const harness = promotionHarness();
    harness.renamePath.mockRejectedValueOnce(promotionError("EPERM"));
    harness.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      harness.waits.push(milliseconds);
      change(harness);
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(/changed|canonical/i);
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bridge root", (harness: ReturnType<typeof promotionHarness>) => {
      harness.identities.set(harness.bridgeRoot, { dev: 9n, ino: 1n });
    }],
    ["versions root", (harness: ReturnType<typeof promotionHarness>) => {
      harness.identities.set(harness.versionsRoot, { dev: 9n, ino: 2n });
    }],
    ["staging source", (harness: ReturnType<typeof promotionHarness>) => {
      harness.identities.set(harness.stagingDirectory, { dev: 9n, ino: 3n });
    }],
  ])("refuses a same-path replacement of the %s", async (_label, change) => {
    const harness = promotionHarness();
    harness.renamePath.mockRejectedValueOnce(promotionError("EPERM"));
    harness.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      harness.waits.push(milliseconds);
      change(harness);
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(/identity changed/i);
    expect(harness.renamePath).toHaveBeenCalledTimes(1);
  });

  it("distinguishes large bigint staging identities before attempt zero", async () => {
    const harness = promotionHarness();
    harness.baseline.stagingDirectory = {
      canonicalPath: harness.stagingDirectory,
      dev: 1n,
      ino: 9_007_199_254_740_992n,
    };
    harness.identities.set(harness.stagingDirectory, {
      dev: 1n,
      ino: 9_007_199_254_740_993n,
    });

    await expect(promoteWithHarness(harness)).rejects.toThrow(
      /staging source identity changed/i,
    );
    expect(harness.renamePath).not.toHaveBeenCalled();
  });

  it("succeeds immediately with one rename and no wait", async () => {
    const harness = promotionHarness();

    await promoteWithHarness(harness);

    expect(harness.renamePath).toHaveBeenCalledTimes(1);
    expect(harness.renamePath).toHaveBeenCalledWith(
      harness.stagingDirectory,
      harness.versionDirectory,
    );
    expect(harness.waits).toEqual([]);
  });
});
