import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runClientPortabilityAcceptance } from "./client-portability-live-controller.js";

const TEMPORARY_ROOT_PREFIX = "intentarc-client-portability-live-";
const liveEnabled =
  process.platform === "win32" &&
  process.env.INTENTARC_RUN_CLIENT_PORTABILITY_E2E === "1";

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
test.runIf(liveEnabled)(
  "accepts installed Codex-to-Claude portability through the production bridge",
  async () => {
    const runId = process.env.INTENTARC_CLIENT_PORTABILITY_RUN_ID;
    if (!runId) {
      throw new Error(
        "INTENTARC_CLIENT_PORTABILITY_RUN_ID is required for the live acceptance.",
      );
    }
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error("INTENTARC_CLIENT_PORTABILITY_RUN_ID must be a UUID.");
    }
    const normalizedRunId = runId.toLowerCase();
    const root = join(tmpdir(), `${TEMPORARY_ROOT_PREFIX}${normalizedRunId}`);
    await mkdir(root, { recursive: false });
    const settingsRoot = join(root, "Roaming", "IntentArc");
    const archivePath = join(root, "intentarc.sqlite");

    const result = await runClientPortabilityAcceptance({
      runId: normalizedRunId,
      settingsRoot,
      archivePath,
    });

    if (result.status === "BLOCKED") {
      throw new Error(JSON.stringify({
        outcomeCategory: result.outcomeCategory,
        recoveryCommands: result.recoveryCommands,
        rootCleanup: result.rootCleanup,
      }));
    }
    expect(result.status).toBe("PASS");
    expect(result.outcomeCategory).toBe("passed");
    expect(result.clientVersions.codex).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.clientVersions.claude).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.revisionBefore).toBe(5);
    expect(result.revisionAfter).toBe(6);
    expect(result.releaseIds.codex).not.toBe(result.releaseIds.claude);
    expect(result.requestIds.codex).not.toBe(result.requestIds.claude);
    expect(result.counts.releases).toBe(2);
    expect(result.counts.configurationFailures).toBe(0);
    expect(result.counts.journeyFailures).toBe(0);
    expect(result.counts.teardownFailures).toBe(0);
    expect(result.counts.gracefulTeardownFailures).toBe(0);
    expect(result.counts.forcedTeardownFailures).toBe(0);
    expect(result.counts.settlementFailures).toBe(0);
    expect(result.counts.workspaceFailures).toBe(0);
    expect(result.counts.rootPreservationFailures).toBe(0);
    expect(result.counts.cleanupFailures).toBe(0);
    expect(result.resourcesSettled).toBe(true);
    expect(result.cleanup).toEqual({ codex: "absent", claude: "absent" });
    expect(result.rootCleanup.status).toBe("removed");
  },
  0,
);
