import { listPackage } from "@electron/asar";
import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import {
  existsSync,
} from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  chromium,
  expect as expectLocator,
  type Browser,
  type Page,
} from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../../app/create-application.js";
import { launchAuthenticatedBridgeTarget } from "../../bridge/entry.js";
import {
  applyPendingBridgeUpdate,
  installBridgeVersion,
  readBridgePointer,
} from "../bridge-install.js";
import {
  bridgeProtocolEnvironment,
  verifyBridgeProtocolCompatibility,
} from "../bridge-protocol-verifier.js";
import { desktopBridgeExecutablePath } from "../paths.js";
import { createDesktopSettingsStore } from "../settings.js";
import { createRepositoryFixture } from "../../test-support/repository-fixture.js";
import {
  assertRepositorySourceUnchanged,
  captureRepositorySource,
} from "../../test-support/repository-source-snapshot.js";
import { seedBrowserDatabase } from "../../web/test-support/e2e-fixture.js";

const executeFile = promisify(execFile);
const packagedRoot = resolve("out", "IntentArc-win32-x64");
const desktopExecutable = join(packagedRoot, "IntentArc.exe");
const resourcesRoot = join(packagedRoot, "resources");
const bridgePayload = join(resourcesRoot, "bridge");
const appAsar = join(resourcesRoot, "app.asar");
const temporaryRoots: string[] = [];
const fixtureCleanups: Array<() => void> = [];
const children: ChildProcess[] = [];
const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for packaged process state.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
};

const waitForExit = async (
  child: ChildProcess,
  timeoutMilliseconds = 10_000,
): Promise<number | null> => {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    once(child, "close").then(([code]) => code as number | null),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Packaged process did not exit promptly.")),
        timeoutMilliseconds,
      ).unref();
    }),
  ]);
};

const availableLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a loopback test port."));
        return;
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });

type TemporaryRootRemovalDependencies = {
  readonly remove?: typeof rm;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
};

const removeTemporaryRoot = async (
  root: string,
  dependencies: TemporaryRootRemovalDependencies = {},
): Promise<void> => {
  const remove = dependencies.remove ?? rm;
  const wait = dependencies.wait ?? ((milliseconds) =>
    new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const platform = dependencies.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (
        platform !== "win32" ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "") ||
        attempt >= 40
      ) {
        throw error;
      }
      await wait(100);
    }
  }
};

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop()!;
    if (child.exitCode === null) child.kill();
    await waitForExit(child).catch(() => undefined);
  }
  fixtureCleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  await Promise.all(
    temporaryRoots.splice(0).map(removeTemporaryRoot),
  );
});

describe.skipIf(
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  !existsSync(desktopExecutable),
)("packaged Windows x64 product", () => {
  it("contains the complete runtime and excludes build, SDD, and test-cache inputs", async () => {
    const entries = listPackage(appAsar, { isPack: false })
      .map((entry) => entry.replaceAll("\\", "/"));

    expect(entries).toContain("/dist/desktop/entry.js");
    expect(
      entries.includes("/dist/desktop/preload.cjs") ||
      existsSync(join(
        resourcesRoot,
        "app.asar.unpacked",
        "dist",
        "desktop",
        "preload.cjs",
      )),
    ).toBe(true);
    expect(entries).toContain("/dist/storage/migrations.js");
    expect(entries).toContain("/dist/repository/safe-file-reader.js");
    expect(entries).toContain("/dist/repository/observation-scanner.js");
    expect(entries).toContain("/dist/repository/observation-diff.js");
    expect(entries).toContain("/dist/web-client/index.html");
    expect(entries.some((entry) =>
      entry.startsWith("/dist/web-client/assets/")
    )).toBe(true);
    expect(entries.some((entry) => entry.startsWith("/.superpowers/")))
      .toBe(false);
    expect(entries.some((entry) => entry.includes("/node_modules/.cache/")))
      .toBe(false);
    expect(entries.some((entry) => entry.startsWith("/src/"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".map"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".d.ts"))).toBe(false);
    expect(entries.some((entry) =>
      /\.(?:d\.)?(?:cts|mts|ts|tsx)$/i.test(entry)
    )).toBe(false);
    expect(entries.some((entry) => entry.includes(".intentarc-") &&
      entry.includes("-owner"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("/dist/test-support/")))
      .toBe(false);
    expect(entries.some((entry) =>
      entry.startsWith("/dist/web/test-support/")
    )).toBe(false);
    expect(entries.some((entry) => entry.startsWith("/node_modules/.pnpm/")))
      .toBe(false);
    expect(entries.some((entry) =>
      entry.startsWith("/node_modules/@electron-forge/")
    )).toBe(false);
    expect(entries.some((entry) =>
      entry.startsWith("/node_modules/@playwright/")
    )).toBe(false);
    expect(entries.some((entry) =>
      /\/node_modules\/(?:.+\/)?(?:__tests__|tests?|src)\//i.test(entry)
    )).toBe(false);

    for (const path of [
      desktopExecutable,
      join(bridgePayload, "IntentArc Bridge.exe"),
      join(
        bridgePayload,
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        "win32-x64.node",
      ),
      join(bridgePayload, "node_modules", "better-sqlite3", "LICENSE"),
      join(resourcesRoot, "desktop-resources", "intentarc-release.json"),
      join(resourcesRoot, "desktop-resources", "THIRD-PARTY-NOTICES.json"),
      join(resourcesRoot, "desktop-resources", "desktop-application.md"),
      join(packagedRoot, "LICENSE"),
      join(packagedRoot, "LICENSES.chromium.html"),
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(JSON.parse(await readFile(
      join(resourcesRoot, "desktop-resources", "intentarc-release.json"),
      "utf8",
    ))).toMatchObject({
      platform: "win32",
      arch: "x64",
      requireSignatures: false,
    });
    const notices = JSON.parse(await readFile(
      join(
        resourcesRoot,
        "desktop-resources",
        "THIRD-PARTY-NOTICES.json",
      ),
      "utf8",
    )) as {
      dependencies: Array<{ packageDirectory: string }>;
    };
    for (const { packageDirectory } of notices.dependencies) {
      expect(
        entries,
        `notice without packaged dependency: ${packageDirectory}`,
      ).toContain(`/${packageDirectory}/package.json`);
    }
  });

  it("selects and starts the bundled bridge before installer publication", async () => {
    const selectedBridge = desktopBridgeExecutablePath({
      packaged: true,
      platform: "win32",
      execPath: desktopExecutable,
      resourcesPath: resourcesRoot,
    });

    expect(selectedBridge).toBe(join(
      bridgePayload,
      "IntentArc Bridge.exe",
    ));
    await expect(executeFile(selectedBridge, ["--health-check"], {
      env: inheritedEnvironment(),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })).resolves.toEqual({ stdout: "", stderr: "" });
  }, 20_000);

  it("holds the authenticated packaged executable object through process creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-held-launch-"));
    temporaryRoots.push(root);
    const targetRoot = join(root, "bridge");
    await cp(bridgePayload, targetRoot, { recursive: true });
    const targetPath = join(targetRoot, "IntentArc Bridge.exe");
    const { stdout } = await executeFile(targetPath, ["--bridge-identity"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    });
    const identity = JSON.parse(stdout) as {
      formatVersion: 1;
      releaseVersion: string;
      buildMode: "unsigned-development";
      supportSha256: string;
    };
    const launched = launchAuthenticatedBridgeTarget({
      targetPath,
      executableSha256: sha256(await readFile(targetPath)),
      identity,
    }, ["--health-check"], {
      ...inheritedEnvironment(),
      SystemRoot: join(root, "attacker-system-root"),
      SYSTEMROOT: "",
      PATH: join(root, "attacker-path"),
      ComSpec: join(root, "attacker-cmd.exe"),
      INTENTARC_TEST_HELD_LAUNCH_DELAY_MS: "2000",
    });

    await waitFor(async () => {
      try {
        const writable = await open(targetPath, "r+");
        await writable.close();
        return false;
      } catch (error) {
        return typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["EACCES", "EPERM", "EBUSY"].includes(
            String((error as NodeJS.ErrnoException).code),
          );
      }
    }, 5_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    await expect(rename(
      targetPath,
      `${targetPath}.attacker-parked`,
    )).rejects.toMatchObject({
      code: expect.stringMatching(/EACCES|EPERM|EBUSY/),
    });
    await expect(launched).resolves.toBe(0);
  }, 15_000);

  it("runs full stable-path recovery after a crash following launcher publication", async () => {
    const root = await mkdtemp(join(
      tmpdir(),
      "intentarc-packaged-crash-recovery-",
    ));
    temporaryRoots.push(root);
    const binaryRoot = join(root, "Local", "IntentArc");
    const activeVerificationStarted = Promise.withResolvers<void>();
    const simulatedProcessCrash = Promise.withResolvers<void>();

    void installBridgeVersion({
      binaryRoot,
      payloadPath: bridgePayload,
      version: "0.1.0",
      verify: async (input) => {
        if (input.phase === "staged") {
          await verifyBridgeProtocolCompatibility(input);
          return;
        }
        activeVerificationStarted.resolve();
        await simulatedProcessCrash.promise;
      },
    });
    await activeVerificationStarted.promise;

    const recoveryPath = join(
      binaryRoot,
      "bridge",
      "activation-recovery.json",
    );
    const stablePath = join(
      binaryRoot,
      "bridge",
      "current",
      "IntentArc Bridge.exe",
    );
    expect(existsSync(recoveryPath)).toBe(true);

    await expect(executeFile(stablePath, ["--health-check"], {
      env: inheritedEnvironment(),
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    })).resolves.toEqual({ stdout: "", stderr: "" });

    expect(existsSync(recoveryPath)).toBe(false);
    expect((await readdir(join(binaryRoot, "bridge"))).some((entry) =>
      entry.startsWith(".completed-activation-")
    )).toBe(true);
  }, 30_000);

  it("runs the stable installed bridge with Desktop closed and then holds concurrent archive leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-packaged-product-"));
    temporaryRoots.push(root);
    const binaryRoot = join(root, "Local", "IntentArc");
    const appData = join(root, "Roaming");
    const settingsRoot = join(appData, "IntentArc");
    const archivePath = join(root, "Data", "intentarc.sqlite");
    const backupRoot = `${archivePath}.backups`;
    await mkdir(join(root, "Data"), { recursive: true });
    await mkdir(backupRoot);
    await writeFile(join(backupRoot, "preserved.txt"), "preserve-backups");

    const verificationPhases: string[] = [];
    const installed = await installBridgeVersion({
      binaryRoot,
      payloadPath: bridgePayload,
      version: "0.1.0",
      verify: async (input) => {
        verificationPhases.push(input.phase);
        if (input.phase === "active") {
          try {
            await executeFile(input.executablePath, ["--health-check"], {
              env: bridgeProtocolEnvironment(
                inheritedEnvironment(),
                appData,
                input.activationTransaction,
              ),
              windowsHide: true,
              timeout: 15_000,
              maxBuffer: 64 * 1024,
            });
          } catch (error) {
            const diagnostic =
              typeof error === "object" && error !== null &&
                "stderr" in error
                ? String(error.stderr)
                : "";
            throw new Error(
              `Bridge active launcher health failed: ${diagnostic}`,
              { cause: error },
            );
          }
        }
        try {
          await verifyBridgeProtocolCompatibility(input);
        } catch (error) {
          throw new Error(
            `Bridge ${input.phase} protocol verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      },
    });
    expect(verificationPhases).toEqual(["staged", "active"]);

    const heldLaunch = spawn(
      installed.executablePath,
      ["--health-check"],
      {
        env: inheritedEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(heldLaunch);
    const targetExecutable = join(
      installed.versionDirectory,
      "IntentArc Bridge.exe",
    );
    await waitFor(async () => {
      try {
        const writable = await open(targetExecutable, "r+");
        await writable.close();
        return false;
      } catch (error) {
        return typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["EACCES", "EPERM", "EBUSY"].includes(
            String((error as NodeJS.ErrnoException).code),
          );
      }
    }, 5_000);
    await expect(rm(targetExecutable)).rejects.toMatchObject({
      code: expect.stringMatching(/EACCES|EPERM|EBUSY/),
    });
    await expect(waitForExit(heldLaunch)).resolves.toBe(0);
    children.splice(children.indexOf(heldLaunch), 1);

    const application = createApplication({ databasePath: archivePath });
    const profile = application.service.profiles.createProfile({
      name: "Packaged desktop and bridge",
    });
    application.close();
    const connectionId = "packaged-desktop-connection";
    createDesktopSettingsStore(settingsRoot).write({
      schemaVersion: 2,
      archivePath,
      onboardingCompleted: true,
      connections: [{
        id: connectionId,
        kind: "managed",
        adapterId: "codex",
        profileId: profile.profile.id,
        profileToken: profile.token,
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });
    const environment = {
      ...inheritedEnvironment(),
      APPDATA: appData,
      LOCALAPPDATA: join(root, "Local"),
    };
    delete environment.INTENTARC_UPDATE_FEED_URL;

    const transport = new StdioClientTransport({
      command: installed.executablePath,
      args: ["--connection", connectionId],
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({
      name: "IntentArc packaged product test",
      version: "1.0.0",
    });
    let bridgeDiagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      bridgeDiagnostics += chunk.toString();
    });
    await client.connect(transport);
    const bridgeProcess = (transport as unknown as {
      _process?: ChildProcess;
    })._process;
    expect(bridgeProcess).toBeDefined();
    children.push(bridgeProcess!);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(bridgeDiagnostics).toBe("");
    expect(existsSync(join(binaryRoot, "bridge", "active-references")))
      .toBe(false);

    verificationPhases.length = 0;
    const bridgeBuild = await import(
      "../../../scripts/build-bridge.mjs"
    ) as {
      buildIntentArcBridge(options: {
        buildParent: string;
        releaseVersion: string;
        buildMode: "unsigned-development";
        authorizedPredecessor: {
          formatVersion: 1;
          versionDirectory: string;
          releaseVersion: string;
          buildMode: "unsigned-development";
          executableSha256: string;
          payloadSha256: string;
          supportSha256: string;
        };
      }): Promise<void>;
    };
    const updateBuildParent = join(root, "bridge-v2-build");
    const authorizedPredecessor = JSON.parse(await readFile(
      join(installed.versionDirectory, "intentarc-bridge-release.json"),
      "utf8",
    ));
    await bridgeBuild.buildIntentArcBridge({
      buildParent: updateBuildParent,
      releaseVersion: "0.2.0",
      buildMode: "unsigned-development",
      authorizedPredecessor,
    });
    const updatePayload = join(updateBuildParent, "bridge");
    expect(sha256(await readFile(
      join(updatePayload, "IntentArc Bridge.exe"),
    ))).not.toBe(sha256(await readFile(
      join(bridgePayload, "IntentArc Bridge.exe"),
    )));
    const switching = installBridgeVersion({
      binaryRoot,
      payloadPath: updatePayload,
      version: "0.2.0",
      verify: async (input) => {
        verificationPhases.push(input.phase);
        try {
          await verifyBridgeProtocolCompatibility(input);
        } catch (error) {
          throw new Error(
            `Bridge ${input.phase} protocol verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      },
    });
    const launchProbes = Promise.all(
      Array.from({ length: 8 }, () =>
        executeFile(installed.executablePath, ["--health-check"], {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        })
      ),
    );
    const updated = await switching;
    await expect(launchProbes).resolves.toEqual(
      Array.from({ length: 8 }, () => ({ stdout: "", stderr: "" })),
    );
    expect(verificationPhases).toEqual(["staged", "active"]);
    expect(await readFile(installed.executablePath)).not.toHaveLength(0);
    expect(await readFile(join(
      installed.versionDirectory,
      "IntentArc Bridge.exe",
    ))).not.toHaveLength(0);
    expect(updated.versionDirectory).not.toBe(installed.versionDirectory);
    expect(existsSync(installed.versionDirectory)).toBe(true);
    if (updated.pendingLauncherUpdate) {
      expect((await readBridgePointer({ binaryRoot })).versionDirectory)
        .toBe(installed.versionDirectory);
    } else {
      expect((await readBridgePointer({ binaryRoot })).versionDirectory)
        .toBe(updated.versionDirectory);
    }

    const activeLeaseRoot = `${archivePath}.intentarc-lock`;
    const activeLeases = join(activeLeaseRoot, "active");
    await waitFor(async () => (await readdir(activeLeases)).length === 1);
    const desktop = spawn(
      desktopExecutable,
      [`--user-data-dir=${settingsRoot}`],
      {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let desktopDiagnostics = "";
    desktop.stderr?.on("data", (chunk) => {
      desktopDiagnostics += chunk.toString();
    });
    children.push(desktop);
    await waitFor(async () => {
      if (desktop.exitCode !== null) {
        throw new Error(
          `Packaged Desktop exited with ${desktop.exitCode}: ${desktopDiagnostics}`,
        );
      }
      return (await readdir(activeLeases)).length >= 2;
    }, 15_000).catch(async (error: unknown) => {
      const leaseEntries = await readdir(activeLeases);
      const leases = await Promise.all(
        leaseEntries.map((entry) =>
          readFile(join(activeLeases, entry), "utf8")
        ),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `stderr=${JSON.stringify(desktopDiagnostics)} ` +
          `leases=${JSON.stringify(leases)} ` +
          `bridgePid=${bridgeProcess!.pid} desktopPid=${desktop.pid}`,
      );
    });
    expect((await readdir(activeLeases)).length).toBeGreaterThanOrEqual(2);

    desktop.kill();
    await waitForExit(desktop);
    children.splice(children.indexOf(desktop), 1);
    const bridgeExit = waitForExit(bridgeProcess!);
    await client.close();
    await expect(bridgeExit).resolves.toBe(0);
    children.splice(children.indexOf(bridgeProcess!), 1);
    expect(bridgeDiagnostics).toBe("");

    if (updated.pendingLauncherUpdate) {
      const resumed = await applyPendingBridgeUpdate({
        binaryRoot,
        verify: async (input) => {
          await verifyBridgeProtocolCompatibility(input);
        },
      });
      expect(resumed?.pendingLauncherUpdate).toBe(false);
    }
    expect((await readBridgePointer({ binaryRoot })).versionDirectory)
      .toBe(updated.versionDirectory);
    expect(sha256(await readFile(installed.executablePath))).toBe(sha256(await readFile(
      join(updatePayload, "IntentArc Bridge.exe"),
    )));
    await expect(executeFile(
      installed.executablePath,
      ["--health-check"],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    )).resolves.toEqual({ stdout: "", stderr: "" });

    await removeTemporaryRoot(binaryRoot);
    expect(await readFile(archivePath)).not.toHaveLength(0);
    expect(await readFile(join(backupRoot, "preserved.txt"), "utf8"))
      .toBe("preserve-backups");
  }, 60_000);

  it("runs a reviewed structured-knowledge journey in the packaged Desktop", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-packaged-structured-"));
    temporaryRoots.push(root);
    const repositoryParent = resolve(
      "node_modules",
      ".cache",
      "intentarc-packaged-structured-e2e",
    );
    const dataRoot = join(root, "Data");
    const appData = join(root, "Roaming");
    const settingsRoot = join(appData, "IntentArc");
    const archivePath = join(dataRoot, "intentarc.sqlite");
    await mkdir(repositoryParent, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    const repository = createRepositoryFixture({
      "project.godot": [
        "; Engine configuration file.",
        "[application]",
        'config/name="Packaged Structured Knowledge"',
        "",
      ].join("\n"),
      "README.md": "# Packaged knowledge\n\nAccepted in the packaged journey.\n",
      "docs/guide.md": "# Guide\n\nReview repository changes.\n",
      "src/index.ts": "export const packagedJourney = true;\n",
    }, { parentDirectory: repositoryParent });
    fixtureCleanups.push(repository.cleanup);
    await seedBrowserDatabase(archivePath, repository);
    let expectedSource = captureRepositorySource(repository.root);

    createDesktopSettingsStore(settingsRoot).write({
      schemaVersion: 2,
      archivePath,
      onboardingCompleted: true,
      connections: [],
    });
    const environment = {
      ...inheritedEnvironment(),
      APPDATA: appData,
      LOCALAPPDATA: join(root, "Local"),
    };
    delete environment.INTENTARC_UPDATE_FEED_URL;
    const debugPort = await availableLoopbackPort();

    const launch = async (): Promise<{
      readonly browser: Browser;
      readonly page: Page;
      readonly child: ChildProcess;
      readonly close: () => Promise<void>;
    }> => {
      const child = spawn(desktopExecutable, [
        `--user-data-dir=${settingsRoot}`,
        `--remote-debugging-port=${debugPort}`,
      ], {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(child);
      let diagnostics = "";
      child.stderr?.on("data", (chunk) => {
        diagnostics += chunk.toString();
      });
      const endpoint = `http://127.0.0.1:${debugPort}`;
      await waitFor(async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `Packaged structured Desktop exited with ${child.exitCode}: ${diagnostics}`,
          );
        }
        try {
          return (await fetch(`${endpoint}/json/version`)).ok;
        } catch {
          return false;
        }
      }, 15_000);
      const browser = await chromium.connectOverCDP(endpoint);
      await waitFor(() => (browser.contexts()[0]?.pages().length ?? 0) > 0);
      const page = browser.contexts()[0]!.pages()[0]!;
      await page.waitForLoadState("domcontentloaded");
      return {
        browser,
        page,
        child,
        async close() {
          await page.close().catch(() => undefined);
          const exit = waitForExit(child);
          await browser.close().catch(() => undefined);
          await expect(exit).resolves.toBe(0);
          const index = children.indexOf(child);
          if (index !== -1) children.splice(index, 1);
          expect(diagnostics).not.toContain("ERR_");
        },
      };
    };

    let desktop = await launch();
    let origin = new URL(desktop.page.url()).origin;
    await desktop.page.goto(`${origin}/projects/project-2/documentation`);
    await desktop.page.getByRole("button", { name: /README\.md/ }).click();
    await expectLocator(desktop.page.getByText("Accepted in the packaged journey."))
      .toBeVisible();
    assertRepositorySourceUnchanged(repository.root, expectedSource);

    repository.write(
      "README.md",
      "# Packaged knowledge\n\nChanged for reviewed package refresh.\n",
    );
    expectedSource = captureRepositorySource(repository.root);
    await desktop.page.getByRole("link", { name: "Review repository refresh" }).click();
    await desktop.page.getByRole("button", { name: "Scan repository" }).click();
    await expectLocator(desktop.page.getByText("Scan complete", { exact: true }))
      .toBeVisible();
    await desktop.page.getByRole("button", { name: "Accept repository refresh" }).click();
    await expectLocator(desktop.page.getByRole("heading", { name: "Refresh outcome" }))
      .toBeVisible();
    assertRepositorySourceUnchanged(repository.root, expectedSource);

    repository.write(
      "tests/release-evidence.md",
      "# Release evidence\n\nPackaged review remains governed.\n",
    );
    repository.runGit(["add", "tests/release-evidence.md"]);
    expectedSource = captureRepositorySource(repository.root);
    await desktop.page.goto(`${origin}/projects/project-2/repository/refresh`);
    await desktop.page.getByRole("button", { name: "Scan repository" }).click();
    await expectLocator(desktop.page.getByText("Scan complete", { exact: true }))
      .toBeVisible();
    const proposal = desktop.page.getByRole("list", { name: "Semantic proposals" })
      .getByRole("checkbox");
    await proposal.click();
    await expectLocator(proposal).toBeChecked();
    assertRepositorySourceUnchanged(repository.root, expectedSource);

    await desktop.close();
    desktop = await launch();
    origin = new URL(desktop.page.url()).origin;
    await desktop.page.goto(`${origin}/projects/project-2/repository/refresh`);
    await expectLocator(desktop.page.getByText("Resumed pending review", { exact: true }))
      .toBeVisible();
    const resumedProposal = desktop.page
      .getByRole("list", { name: "Semantic proposals" })
      .getByRole("checkbox");
    await expectLocator(resumedProposal).toBeChecked();
    await desktop.page.getByRole("button", {
      name: "Accept refresh and create proposal",
    }).click();
    await expectLocator(desktop.page.getByRole("heading", { name: "Refresh outcome" }))
      .toBeVisible();
    assertRepositorySourceUnchanged(repository.root, expectedSource);
    await desktop.close();
  }, 90_000);
});

it("retries one transient cleanup lock", async () => {
  const cleanupLock = Object.assign(new Error("transient cleanup lock"), {
    code: "EBUSY",
  });
  let removeCalls = 0;
  const waits: number[] = [];

  await removeTemporaryRoot("temporary-root", {
    remove: async () => {
      removeCalls += 1;
      if (removeCalls === 1) throw cleanupLock;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    platform: "win32",
  });

  expect(removeCalls).toBe(2);
  expect(waits).toEqual([100]);
});

it("bounds persistent cleanup locks", async () => {
  const cleanupLock = Object.assign(new Error("persistent cleanup lock"), {
    code: "EBUSY",
  });
  let removeCalls = 0;
  const waits: number[] = [];

  await expect(removeTemporaryRoot("temporary-root", {
    remove: async () => {
      removeCalls += 1;
      throw cleanupLock;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    platform: "win32",
  })).rejects.toBe(cleanupLock);

  expect(removeCalls).toBe(41);
  expect(waits).toEqual(Array.from({ length: 40 }, () => 100));
});

it("does not retry a nonclosed cleanup error", async () => {
  const accessError = Object.assign(new Error("cleanup access denied"), {
    code: "EACCES",
  });
  let removeCalls = 0;
  const waits: number[] = [];

  await expect(removeTemporaryRoot("temporary-root", {
    remove: async () => {
      removeCalls += 1;
      throw accessError;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    platform: "win32",
  })).rejects.toBe(accessError);

  expect(removeCalls).toBe(1);
  expect(waits).toEqual([]);
});
