import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { buildClientPortabilitySupervisor } from "../../../scripts/build-client-portability-supervisor.mjs";
import { createApplication } from "../../app/create-application.js";
import { createDesktopSettingsStore } from "../settings.js";
import { createClientPortabilitySupervisorSession } from "./client-portability-supervisor-client.js";
import {
  createWindowsSupervisorSettlementBackend,
  observeWindowsSupervisorIdentity,
} from "./client-portability-windows-settlement.js";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(".");
const supervisorBundle = resolve(
  "dist",
  "test-support",
  "client-portability-session-supervisor.mjs",
);
const bridgeExecutable = resolve("dist", "bridge", "IntentArc Bridge.exe");

beforeAll(async () => {
  await executeFile(process.execPath, [resolve("scripts", "build-bridge.mjs")], {
    cwd: repositoryRoot,
    windowsHide: true,
    timeout: 60_000,
  });
  await buildClientPortabilitySupervisor({ outputFile: supervisorBundle });
}, 90_000);

test.runIf(process.platform === "win32")(
  "connects the production supervisor bundle to the ordinary bridge in a private root",
  async () => {
    const runId = randomUUID();
    const acceptanceRoot = join(
      tmpdir(),
      `intentarc-client-portability-live-${runId}`,
    );
    const settingsRoot = join(acceptanceRoot, "Roaming", "IntentArc");
    const archivePath = join(acceptanceRoot, "intentarc.sqlite");
    const connectionId = `smoke-${randomUUID()}`;
    await mkdir(settingsRoot, { recursive: true });

    const application = createApplication({ databasePath: archivePath });
    const project = application.service.createProject({
      name: "Credential-free portability smoke",
    });
    const profile = application.service.profiles.createProfile({
      name: "Credential-free Safe profile",
      projectId: project.id,
      executionMode: "safe",
    });
    application.close();
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
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }],
    });

    const session = createClientPortabilitySupervisorSession({
      repositoryRoot,
      supervisorBundle,
      clientKind: "codex",
      forceSettlementTimeoutMs: 25_000,
      windowsJobObject: true,
      launchAuthority: {
        bridgeExecutable,
        settingsRoot,
        archivePath,
        acceptanceRoot,
      },
      dependencies: {
        settlementBackend: createWindowsSupervisorSettlementBackend(),
        observeSupervisorIdentity: observeWindowsSupervisorIdentity,
      },
    });
    let settled = false;
    try {
      await session.connect({ bridgeExecutable, connectionId, settingsRoot }, Date.now() + 25_000);
      const listed = await session.callTool<{
        readonly structuredContent?: { readonly projects?: readonly { readonly id?: string }[] };
      }>("list_projects", {}, Date.now() + 25_000);
      expect(listed.structuredContent?.projects).toContainEqual(
        expect.objectContaining({ id: project.id }),
      );
      const summary = await session.callTool<{
        readonly structuredContent?: { readonly project?: { readonly id?: string } };
      }>("get_project_summary", { projectId: project.id }, Date.now() + 25_000);
      expect(summary.structuredContent?.project?.id).toBe(project.id);
      await session.close(Date.now() + 25_000);
      const result = await session.settle(Date.now() + 25_000);
      expect(result).toMatchObject({ status: "settled", category: "none" });
      expect(result.retained.length).toBeGreaterThanOrEqual(2);
      settled = result.status === "settled";
    } catch (error) {
      const result = await session.settle(Date.now() + 25_000).catch(() => undefined);
      throw new Error(JSON.stringify({
        message: error instanceof Error ? error.message : "failed",
        settlement: result,
      }));
    } finally {
      const result = await session.settle(Date.now() + 25_000).catch(() => undefined);
      settled ||= result?.status === "settled";
      if (settled) await rm(acceptanceRoot, { recursive: true, force: false });
    }
    expect(dirname(settingsRoot)).toBe(join(acceptanceRoot, "Roaming"));
  },
  90_000,
);
