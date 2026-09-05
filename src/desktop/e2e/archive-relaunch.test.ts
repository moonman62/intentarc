import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_RELAUNCH_BUILD_WAIT_MS,
  ARCHIVE_RELAUNCH_OUTER_TIMEOUT_MS,
  runArchiveRelaunchPhase,
} from "../../test-support/archive-relaunch-runner.js";
import { ensurePackagedTestBuild } from "../../test-support/packaged-test-build.js";

type RelaunchPhaseResult = {
  readonly phase: "before-relaunch" | "replacement";
  readonly processId: number;
  readonly openedArchivePath: string;
  readonly selectedState?: {
    readonly archivePath: string;
    readonly onboardingCompleted: boolean;
    readonly restartRequired: boolean;
  };
  readonly completedState?: {
    readonly archivePath: string;
    readonly onboardingCompleted: boolean;
    readonly restartRequired: boolean;
  };
  readonly restartResult?: { readonly restarting: true };
  readonly lifecycleState?: {
    readonly archivePath: string;
    readonly onboardingCompleted: boolean;
    readonly restartRequired: boolean;
  };
  readonly selectedArchiveExists?: boolean;
  readonly relaunchCalls: number;
  readonly quitCalls: number;
  readonly closeOrder: readonly string[];
  readonly persistedArchivePath?: string | null;
};

type OwnedTemporaryRoot = {
  readonly path: string;
  cleanupSafe: boolean;
};

const temporaryRoots: OwnedTemporaryRoot[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.cleanupSafe) {
      throw new Error(
        "Archive relaunch child settlement is unproved; owned fixture was preserved.",
      );
    }
    await rm(root.path, { recursive: true, force: true });
  }
});

describe("desktop archive relaunch process handoff", () => {
  it("opens a persisted selected archive in a replacement emitted-main process", async () => {
    const repositoryRoot = await realpath(fileURLToPath(
      new URL("../../../", import.meta.url),
    ));
    const root = await mkdtemp(join(tmpdir(), "intentarc-relaunch-e2e-"));
    const ownedRoot: OwnedTemporaryRoot = { path: root, cleanupSafe: true };
    temporaryRoots.push(ownedRoot);
    const userDataPath = join(root, "user-data");
    const selectedArchivePath = join(root, "selected", "chosen.sqlite");
    await mkdir(userDataPath, { recursive: true });
    await mkdir(dirname(selectedArchivePath), { recursive: true });
    const build = await ensurePackagedTestBuild({
      repositoryRoot,
      waitTimeoutMs: ARCHIVE_RELAUNCH_BUILD_WAIT_MS,
    });
    const helperPath = join(
      build.outputDirectory,
      "test-support",
      "desktop-relaunch-process.js",
    );

    // Boundary: the Electron shell, native save dialog, and app.relaunch OS
    // primitive are fakes; this parent test starts the replacement process.
    // Emitted production desktop startup/shutdown, lifecycle IPC, atomic
    // settings persistence, application opening, and SQLite access stay real.
    const beforeRun = await runArchiveRelaunchPhase<RelaunchPhaseResult>({
      helperPath,
      phase: "before-relaunch",
      userDataPath,
      selectedArchivePath,
      cwd: build.packageRoot,
      onCleanupSafetyChange: (safe) => {
        ownedRoot.cleanupSafe = safe;
      },
    });
    const beforeRelaunch = beforeRun.value;

    expect(beforeRelaunch.phase).toBe("before-relaunch");
    expect(beforeRun.lifecycle).toMatchObject({
      phase: "before-relaunch",
      closed: true,
    });
    expect(beforeRelaunch.openedArchivePath).toBe(
      join(userDataPath, "intentarc.sqlite"),
    );
    expect(beforeRelaunch.selectedState).toEqual({
      archivePath: selectedArchivePath,
      onboardingCompleted: false,
      restartRequired: true,
    });
    expect(beforeRelaunch.completedState).toEqual({
      archivePath: selectedArchivePath,
      onboardingCompleted: true,
      restartRequired: true,
    });
    expect(beforeRelaunch.restartResult).toEqual({ restarting: true });
    expect(beforeRelaunch.relaunchCalls).toBe(1);
    expect(beforeRelaunch.quitCalls).toBe(1);
    expect(beforeRelaunch.closeOrder).toEqual([
      "window",
      "http",
      "application",
    ]);
    expect(beforeRelaunch.persistedArchivePath).toBe(selectedArchivePath);
    expect(JSON.parse(await readFile(
      join(userDataPath, "settings.json"),
      "utf8",
    ))).toMatchObject({
      archivePath: selectedArchivePath,
      onboardingCompleted: true,
    });

    const replacementRun = await runArchiveRelaunchPhase<RelaunchPhaseResult>({
      helperPath,
      phase: "replacement",
      userDataPath,
      selectedArchivePath,
      cwd: build.packageRoot,
      onCleanupSafetyChange: (safe) => {
        ownedRoot.cleanupSafe = safe;
      },
    });
    const replacement = replacementRun.value;

    expect(replacement.phase).toBe("replacement");
    expect(replacementRun.lifecycle).not.toBe(beforeRun.lifecycle);
    expect(replacementRun.lifecycle).toMatchObject({
      phase: "replacement",
      closed: true,
    });
    expect(replacement.openedArchivePath).toBe(selectedArchivePath);
    expect(replacement.lifecycleState).toEqual({
      archivePath: selectedArchivePath,
      onboardingCompleted: true,
      restartRequired: false,
    });
    expect(replacement.selectedArchiveExists).toBe(true);
    expect(replacement.relaunchCalls).toBe(0);
    expect(replacement.quitCalls).toBe(1);
    expect(replacement.closeOrder).toEqual([
      "window",
      "http",
      "application",
    ]);
  }, ARCHIVE_RELAUNCH_OUTER_TIMEOUT_MS);
});
