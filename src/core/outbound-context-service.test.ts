import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  neutralHierarchyVocabulary,
  outboundDestinationSnapshotSchema,
  taskContextPackSchema,
  type HierarchyVocabulary,
  type AuthenticatedProfile,
  type OutboundRequestSummary,
  type Project,
  type ProjectRecord,
} from "../domain/index.js";
import { formatBrowserChatExport } from "../context/browser-chat-export.js";
import { createOutboundSafetyEngine } from "../outbound/safety-engine.js";
import { createContextPackStore } from "../storage/context-pack-store.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import {
  createOutboundContextStore,
  type OutboundContextStore,
} from "../storage/outbound-context-store.js";
import { createOutboundDestinationStore } from "../storage/outbound-destination-store.js";
import { createProfileStore } from "../storage/profile-store.js";
import { createProjectStore, type ProjectStore } from "../storage/project-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createContextService } from "./context-service.js";
import { createDestinationService, type DestinationService } from "./destination-service.js";
import {
  createOutboundContextService,
  type OutboundContextService,
} from "./outbound-context-service.js";
import { createProfileService, type ProfileService } from "./profile-service.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const forcedValue = "sk-proj-SyntheticTokenValue0123456789";
const possibleValue = "owner@example.invalid";

type Harness = {
  database: IntentArcDatabase;
  service: OutboundContextService;
  profiles: ProfileService;
  destinations: DestinationService;
  projectStore: ProjectStore;
  contextPackStore: ReturnType<typeof createContextPackStore>;
  principal: AuthenticatedProfile;
  project: Project;
  task: ProjectRecord;
  failNextAudit(): void;
  createTask(body?: string): { project: Project; task: ProjectRecord };
};

let database: IntentArcDatabase | undefined;
let temporaryDatabase: TemporaryDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  temporaryDatabase = undefined;
});

const setup = (options: {
  taskBody?: string;
  taskSourceRef?: string;
  configureDestination?: boolean;
  hierarchyVocabulary?: HierarchyVocabulary;
} = {}): Harness => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  const counters: Record<string, number> = {};
  let collideNextAudit = false;
  const newId = (prefix: string): string => {
    if (prefix === "audit" && collideNextAudit) {
      collideNextAudit = false;
      return "audit-collision";
    }
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}-${counters[prefix]}`;
  };
  const projectStore = createProjectStore(database, {
    now: () => timestamp,
    newId,
  });
  const contextPackStore = createContextPackStore(database);
  const profileStore = createProfileStore(database);
  const profiles = createProfileService({
    profileStore,
    now: () => timestamp,
    newId,
    generateToken: () => "synthetic-profile-token",
  });
  const destinations = createDestinationService({
    destinationStore: createOutboundDestinationStore(database),
    profileStore,
    now: () => timestamp,
    newId,
  });
  const contextService = createContextService({
    projectStore,
    contextPackStore,
    now: () => timestamp,
    newId: () => newId("context"),
    estimateTokens: (text) => text.length,
  });
  const service = createOutboundContextService({
    contextService,
    contextPackStore,
    profileService: profiles,
    destinationService: destinations,
    outboundStore: createOutboundContextStore(database),
    safetyEngine: createOutboundSafetyEngine(),
    now: () => timestamp,
    newId,
  });
  const createdProfile = profiles.createProfile({ name: "Build agent" });
  const principal: AuthenticatedProfile = {
    id: createdProfile.profile.id,
    name: createdProfile.profile.name,
    status: "enabled",
    credentialGeneration: createdProfile.profile.tokenRotatedAt,
  };
  if (options.configureDestination !== false) {
    destinations.set({
      profileId: principal.id,
      clientLabel: "Claude Code laptop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: "Sonnet",
      accountBoundaryLabel: "personal subscription",
      dataBoundary: "remote",
    });
  }
  const createTask = (body = "Prepare the safe release.") => {
    const project = projectStore.createProject({
      name: `Project ${counters.project ?? 0}`,
      hierarchyVocabulary: options.hierarchyVocabulary,
    });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Release context",
      body,
      sourceKind: "human",
      sourceRef: options.taskSourceRef ?? null,
    });
    return { project, task };
  };
  const initial = createTask(options.taskBody);
  return {
    database,
    service,
    profiles,
    destinations,
    projectStore,
    contextPackStore,
    principal,
    ...initial,
    failNextAudit() {
      database!.prepare(`
        INSERT INTO audit_events (
          id, project_id, actor_type, profile_id, authority_mode, scope_decision,
          action_category, target_id, idempotency_key, revision_before,
          revision_after, outcome, reason, created_at
        ) VALUES (
          'audit-collision', NULL, 'local_human', NULL, 'human', 'human_admin',
          'existing', NULL, NULL, NULL, NULL, 'applied', NULL, ?
        )
      `).run(timestamp);
      collideNextAudit = true;
    },
    createTask,
  };
};

const request = (
  harness: Harness,
  idempotencyKey: string,
  target = { project: harness.project, task: harness.task },
): OutboundRequestSummary => harness.service.request(harness.principal, {
  projectId: target.project.id,
  taskId: target.task.id,
  budgetTokens: 4_000,
  idempotencyKey,
});

const rememberClean = (harness: Harness, idempotencyKey = "clean-first") => {
  const pending = request(harness, idempotencyKey);
  const release = harness.service.approve({
    requestId: pending.requestId,
    rememberClean: true,
    includeFindingIds: [],
  });
  return { pending, release };
};

const grantAuthority = (
  harness: Harness,
  profileId = harness.principal.id,
  projectId = harness.project.id,
): void => {
  harness.profiles.setAuthority({
    profileId,
    projectId,
    mode: "proposal",
  });
};

type TerminalContentionResult = {
  independentConnections: number;
  terminalBarrierArrivals: number;
  outcomes: Array<"success" | "outbound_request_conflict">;
  finalStatus: "released" | "denied";
  terminalAuditCategories: Array<
    "outbound_request_approved" | "outbound_request_denied"
  >;
  terminalAuditCount: number;
};

type TerminalAction = "approve" | "deny";

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type RunningContender = {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
  diagnostics(): string;
};

const contentionDatabasePath =
  process.env.INTENTARC_TEST_TERMINAL_CONTENTION_DB;
const contentionAction =
  process.env.INTENTARC_TEST_TERMINAL_CONTENTION_ACTION as
    | TerminalAction
    | undefined;
const contentionBarrierDirectory =
  process.env.INTENTARC_TEST_TERMINAL_CONTENTION_BARRIER;

const waitArray = new Int32Array(new SharedArrayBuffer(4));

const terminalBarrier = (
  action: TerminalAction,
  barrierDirectory: string,
): void => {
  writeFileSync(join(barrierDirectory, `ready-${action}`), String(process.pid), {
    flag: "wx",
  });
  const go = join(barrierDirectory, "go");
  const deadline = Date.now() + 15_000;
  while (!existsSync(go)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out at ${action} terminal barrier`);
    }
    Atomics.wait(waitArray, 0, 0, 10);
  }
};

const createContenderService = (
  databasePath: string,
  action: TerminalAction,
  barrierDirectory: string,
): {
  database: IntentArcDatabase;
  service: OutboundContextService;
} => {
  const contenderDatabase = openDatabase(databasePath);
  const newId = (prefix: string): string =>
    `${prefix}-${action}-contention`;
  const projectStore = createProjectStore(contenderDatabase, {
    now: () => timestamp,
    newId,
  });
  const contextPackStore = createContextPackStore(contenderDatabase);
  const profileStore = createProfileStore(contenderDatabase);
  const profileService = createProfileService({
    profileStore,
    now: () => timestamp,
    newId,
    generateToken: () => `synthetic-${action}-token`,
  });
  const destinationService = createDestinationService({
    destinationStore: createOutboundDestinationStore(contenderDatabase),
    profileStore,
    now: () => timestamp,
    newId,
  });
  const contextService = createContextService({
    projectStore,
    contextPackStore,
    now: () => timestamp,
    newId: () => newId("context"),
    estimateTokens: (text) => text.length,
  });
  const persistedStore = createOutboundContextStore(contenderDatabase);
  const awaitTerminalContention = (requestId: string): void => {
    if (persistedStore.getRequest(requestId)?.status !== "review_required") {
      throw new Error(`${action} did not observe the pending request`);
    }
    terminalBarrier(action, barrierDirectory);
  };
  const outboundStore: OutboundContextStore = {
    ...persistedStore,
    approve(command) {
      if (action === "approve") awaitTerminalContention(command.requestId);
      return persistedStore.approve(command);
    },
    deny(command) {
      if (action === "deny") awaitTerminalContention(command.requestId);
      return persistedStore.deny(command);
    },
  };
  return {
    database: contenderDatabase,
    service: createOutboundContextService({
      contextService,
      contextPackStore,
      profileService,
      destinationService,
      outboundStore,
      safetyEngine: createOutboundSafetyEngine(),
      now: () => timestamp,
      newId,
    }),
  };
};

if (
  contentionDatabasePath !== undefined &&
  contentionAction !== undefined &&
  contentionBarrierDirectory !== undefined
) {
  it("terminal transition contender", () => {
    const contender = createContenderService(
      contentionDatabasePath,
      contentionAction,
      contentionBarrierDirectory,
    );
    let outcome: "success" | "outbound_request_conflict";
    try {
      if (contentionAction === "approve") {
        contender.service.approve({
          requestId: "outbound-request-1",
          rememberClean: false,
          includeFindingIds: [],
        });
      } else {
        contender.service.deny("outbound-request-1");
      }
      outcome = "success";
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "outbound_request_conflict"
      ) {
        throw error;
      }
      outcome = "outbound_request_conflict";
    } finally {
      contender.database.close();
    }
    writeFileSync(
      join(contentionBarrierDirectory, `result-${contentionAction}.json`),
      JSON.stringify({ outcome }),
      { flag: "wx" },
    );
  });
}

const startContender = (
  action: TerminalAction,
  databasePath: string,
  barrierDirectory: string,
): RunningContender => {
  const vitestExecutable = join(
    process.cwd(),
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  const environment = {
    ...process.env,
    INTENTARC_TEST_TERMINAL_CONTENTION_DB: databasePath,
    INTENTARC_TEST_TERMINAL_CONTENTION_ACTION: action,
    INTENTARC_TEST_TERMINAL_CONTENTION_BARRIER: barrierDirectory,
  };
  const child = spawn(process.execPath, [
    vitestExecutable,
    "run",
    "src/core/outbound-context-service.test.ts",
    "-t",
    "terminal transition contender",
    "--maxWorkers=1",
  ], {
    cwd: process.cwd(),
    env: environment,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completed = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return {
    child,
    completed,
    diagnostics: () => `${stdout}\n${stderr}`,
  };
};

const waitForTerminalArrivals = async (
  barrierDirectory: string,
  contenders: readonly RunningContender[],
): Promise<void> => {
  const ready = [
    join(barrierDirectory, "ready-approve"),
    join(barrierDirectory, "ready-deny"),
  ];
  const deadline = Date.now() + 15_000;
  while (!ready.every(existsSync)) {
    const exited = contenders.find(({ child }) => child.exitCode !== null);
    if (exited) {
      throw new Error(`Contender exited before barrier:\n${exited.diagnostics()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for terminal contenders");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const runTerminalTransitionContention = async (
  harness: Harness,
  requestId: string,
): Promise<TerminalContentionResult> => {
  harness.database.close();
  if (database === harness.database) database = undefined;
  const barrierDirectory = temporaryDatabase!.directory;
  const contenders = (["approve", "deny"] as const).map((action) =>
    startContender(action, temporaryDatabase!.path, barrierDirectory)
  );
  try {
    await waitForTerminalArrivals(barrierDirectory, contenders);
    writeFileSync(join(barrierDirectory, "go"), "go", { flag: "wx" });
    const processResults = await Promise.all(
      contenders.map(({ completed }) => completed),
    );
    for (const result of processResults) {
      if (result.code !== 0) {
        throw new Error(
          `Terminal contender failed:\n${result.stdout}\n${result.stderr}`,
        );
      }
    }
  } finally {
    for (const { child } of contenders) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.allSettled(
      contenders.map(({ completed }) => completed),
    );
  }

  const outcomes = (["approve", "deny"] as const).map((action) =>
    (JSON.parse(readFileSync(
      join(barrierDirectory, `result-${action}.json`),
      "utf8",
    )) as { outcome: "success" | "outbound_request_conflict" }).outcome
  ).sort();
  const inspectionDatabase = openDatabase(temporaryDatabase!.path);
  try {
    const requestRow = inspectionDatabase.prepare(`
      SELECT status FROM outbound_requests WHERE id = ?
    `).get(requestId) as { status: "released" | "denied" };
    const terminalAudits = inspectionDatabase.prepare(`
      SELECT action_category
      FROM audit_events
      WHERE target_id = ?
        AND action_category IN (
          'outbound_request_approved',
          'outbound_request_denied'
        )
      ORDER BY id
    `).all(requestId) as Array<{
      action_category:
        | "outbound_request_approved"
        | "outbound_request_denied";
    }>;
    const contenderProcessIds = (["approve", "deny"] as const).map((action) =>
      readFileSync(join(barrierDirectory, `ready-${action}`), "utf8")
    );
    return {
      independentConnections: new Set(contenderProcessIds).size,
      terminalBarrierArrivals: (["approve", "deny"] as const).filter(
        (action) => existsSync(join(barrierDirectory, `ready-${action}`)),
      ).length,
      outcomes,
      finalStatus: requestRow.status,
      terminalAuditCategories: terminalAudits.map(
        ({ action_category }) => action_category,
      ),
      terminalAuditCount: terminalAudits.length,
    };
  } finally {
    inspectionDatabase.close();
  }
};

describe("OutboundContextService request and policy", () => {
  it("prepares an outbound request as a local human for an authorized profile", () => {
    const harness = setup();
    grantAuthority(harness);

    const requested = harness.service.requestAsLocalHuman(
      harness.principal.id,
      {
        projectId: harness.project.id,
        taskId: harness.task.id,
        budgetTokens: 4_000,
        idempotencyKey: "web-handoff-1",
      },
    );

    expect(requested.profileId).toBe(harness.principal.id);
    expect(harness.database.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events
      WHERE target_id = ?
      ORDER BY id
    `).all(requested.requestId)).toEqual([
      {
        actor_type: "local_human",
        profile_id: null,
        action_category: "outbound_request_created",
      },
      {
        actor_type: "local_human",
        profile_id: null,
        action_category: "outbound_scan_completed",
      },
    ]);
  });

  it.each(["missing", "disabled"] as const)(
    "rejects a %s destination profile for local-human preparation",
    (state) => {
      const harness = setup();
      grantAuthority(harness);
      if (state === "disabled") {
        harness.profiles.setEnabled(harness.principal.id, false);
      }

      expect(() => harness.service.requestAsLocalHuman(
        state === "missing" ? "profile-missing" : harness.principal.id,
        {
          projectId: harness.project.id,
          taskId: harness.task.id,
          budgetTokens: 4_000,
          idempotencyKey: `web-${state}`,
        },
      )).toThrowError(expect.objectContaining({
        code: "validation_failed",
        message: "Profile is not enabled for this project",
      }));
      expect(harness.database.prepare(
        "SELECT COUNT(*) AS count FROM context_packs",
      ).get()).toEqual({ count: 0 });
    },
  );

  it("requires project authority for local-human preparation", () => {
    const harness = setup();

    expect(() => harness.service.requestAsLocalHuman(
      harness.principal.id,
      {
        projectId: harness.project.id,
        taskId: harness.task.id,
        budgetTokens: 4_000,
        idempotencyKey: "web-without-authority",
      },
    )).toThrowError(expect.objectContaining({
      code: "validation_failed",
      message: "Profile is not enabled for this project",
    }));
  });

  it("keeps local-human idempotency scoped to the destination profile", () => {
    const harness = setup();
    grantAuthority(harness);
    const other = harness.profiles.createProfile({ name: "Other agent" }).profile;
    harness.profiles.setAuthority({
      profileId: other.id,
      projectId: harness.project.id,
      mode: "proposal",
    });
    harness.destinations.set({
      profileId: other.id,
      clientLabel: "Other destination",
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic boundary",
      dataBoundary: "remote",
    });
    const input = {
      projectId: harness.project.id,
      taskId: harness.task.id,
      budgetTokens: 4_000,
      idempotencyKey: "shared-web-key",
    };

    const first = harness.service.requestAsLocalHuman(
      harness.principal.id,
      input,
    );
    const replay = harness.service.requestAsLocalHuman(
      harness.principal.id,
      input,
    );
    const otherRequest = harness.service.requestAsLocalHuman(other.id, input);

    expect(replay).toEqual(first);
    expect(otherRequest).toMatchObject({
      profileId: other.id,
      projectId: harness.project.id,
    });
    expect(otherRequest.requestId).not.toBe(first.requestId);
  });

  it("retrieves automatic releases locally without changing authenticated retrieval audits", () => {
    const harness = setup();
    grantAuthority(harness);
    rememberClean(harness);
    const automatic = harness.service.requestAsLocalHuman(
      harness.principal.id,
      {
        projectId: harness.project.id,
        taskId: harness.task.id,
        budgetTokens: 4_000,
        idempotencyKey: "web-automatic",
      },
    );

    const localResult = harness.service.getReleasedAsLocalHuman(
      harness.principal.id,
      automatic.requestId,
    );

    expect(localResult).toMatchObject({
      status: "released",
      release: { requestId: automatic.requestId },
    });
    expect(harness.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action_category = 'outbound_release_retrieved'
        AND target_id = ?
    `).get(automatic.requestId)).toEqual({ count: 0 });

    expect(harness.service.getReleased(
      harness.principal,
      automatic.requestId,
    )).toEqual(localResult);
    expect(harness.database.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events
      WHERE action_category = 'outbound_release_retrieved'
        AND target_id = ?
    `).get(automatic.requestId)).toEqual({
      actor_type: "profile",
      profile_id: harness.principal.id,
      action_category: "outbound_release_retrieved",
    });
  });

  it("requires an enabled current destination before generating a raw pack", () => {
    const harness = setup({ configureDestination: false });

    expect(() => request(harness, "no-destination")).toThrowError(
      expect.objectContaining({
        code: "outbound_destination_required",
        details: { profileId: harness.principal.id },
      }),
    );
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM context_packs",
    ).get()).toEqual({ count: 0 });
  });

  it("revalidates a disabled profile before generating a raw pack", () => {
    const harness = setup();
    harness.profiles.setEnabled(harness.principal.id, false);

    expect(() => request(harness, "disabled-profile")).toThrowError(
      expect.objectContaining({ code: "profile_disabled" }),
    );
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM context_packs",
    ).get()).toEqual({ count: 0 });
  });

  it("requires review for first clean use and persists a remembered exact-scope policy", () => {
    const harness = setup();

    const { pending, release } = rememberClean(harness);

    expect(pending).toMatchObject({
      status: "review_required",
      findingCounts: { total: 0, includedOnce: 0 },
      releaseId: null,
    });
    expect(release).toMatchObject({
      requestId: pending.requestId,
      disclosure: { findingCounts: { total: 0, includedOnce: 0 } },
    });
    expect(harness.database.prepare(`
      SELECT profile_id, project_id, destination_revision,
             safety_policy_version, mode
      FROM outbound_policies
    `).get()).toEqual({
      profile_id: harness.principal.id,
      project_id: harness.project.id,
      destination_revision: 1,
      safety_policy_version: "1",
      mode: "auto_release_clean",
    });
  });

  it("auto-releases a later clean request only while its exact policy remains enabled", () => {
    const harness = setup();
    rememberClean(harness);

    const automatic = request(harness, "clean-automatic");
    harness.service.disablePolicy(harness.principal.id, harness.project.id);
    const manualAgain = request(harness, "clean-after-disable");

    expect(automatic).toMatchObject({
      status: "released",
      findingCounts: { total: 0 },
      releaseId: "outbound-release-2",
    });
    expect(manualAgain).toMatchObject({
      status: "review_required",
      releaseId: null,
    });
  });

  it("does not apply a clean policy to another project", () => {
    const harness = setup();
    rememberClean(harness);
    const other = harness.createTask();

    expect(request(harness, "other-project", other)).toMatchObject({
      projectId: other.project.id,
      status: "review_required",
    });
  });

  it("does not apply a clean policy after a destination revision change", () => {
    const harness = setup();
    rememberClean(harness);
    harness.destinations.set({
      profileId: harness.principal.id,
      clientLabel: "Claude Code desktop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: "Opus",
      accountBoundaryLabel: "team subscription",
      dataBoundary: "remote",
    });

    expect(request(harness, "new-destination-revision")).toMatchObject({
      status: "review_required",
      destination: { revision: 2 },
    });
  });

  it("does not apply a policy stored under another safety version", () => {
    const harness = setup();
    rememberClean(harness);
    harness.database.prepare(`
      UPDATE outbound_policies SET safety_policy_version = 'old-version'
    `).run();

    expect(request(harness, "new-safety-version")).toMatchObject({
      status: "review_required",
      safetyPolicyVersion: "1",
    });
  });

  it("does not apply remembered authority stored under another detector version", () => {
    const harness = setup();
    rememberClean(harness);
    const columns = harness.database.pragma(
      "table_info(outbound_policies)",
    ) as Array<{ name: string }>;

    expect(columns.map(({ name }) => name)).toContain("detector_version");
    if (!columns.some(({ name }) => name === "detector_version")) return;
    harness.database.prepare(`
      UPDATE outbound_policies SET detector_version = 'old-version'
    `).run();

    expect(request(harness, "new-detector-version")).toMatchObject({
      status: "review_required",
      detectorVersion: "1",
    });
  });

  it("routes every finding to review even when a clean policy exists", () => {
    const harness = setup();
    rememberClean(harness);
    const sensitive = harness.createTask(`Contact ${possibleValue}.`);

    expect(request(harness, "finding-bypasses-policy", sensitive)).toMatchObject({
      status: "review_required",
      findingCounts: {
        total: 1,
        redactByDefault: 1,
        includedOnce: 0,
      },
    });
  });

  it("pauses for destination findings and keeps AI-facing metadata masked", () => {
    const harness = setup();
    const destinationToken = "sk-proj-SyntheticDestinationToken0123456789";
    const destinationEmail = "destination.owner@example.invalid";
    harness.destinations.set({
      profileId: harness.principal.id,
      clientLabel: `Client ${destinationToken}`,
      type: "ide_managed",
      providerLabel: `Provider ${destinationEmail}`,
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic boundary",
      dataBoundary: "remote",
    });

    const pending = request(harness, "destination-findings");
    const inspection = harness.service.inspect(pending.requestId);
    const renderedPending = JSON.stringify(pending);
    const renderedInspection = JSON.stringify(inspection);
    const emailFinding = inspection.findings.find(
      ({ path }) => path === "/destination/providerLabel",
    );

    expect(pending).toMatchObject({
      status: "review_required",
      findingCounts: { total: 2 },
    });
    expect(renderedPending).not.toContain(destinationToken);
    expect(renderedPending).not.toContain(destinationEmail);
    expect(renderedInspection).not.toContain(destinationToken);
    expect(renderedInspection).not.toContain(destinationEmail);
    expect(inspection.findings.map(({ path }) => path)).toEqual([
      "/destination/clientLabel",
      "/destination/providerLabel",
    ]);
    expect(emailFinding).toBeDefined();
    expect(harness.service.reveal(
      pending.requestId,
      emailFinding!.id,
    ).value).toBe(destinationEmail);

    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    expect(JSON.stringify(release.disclosure)).not.toContain(destinationToken);
    expect(JSON.stringify(release.disclosure)).not.toContain(destinationEmail);
    expect(JSON.stringify(harness.database.prepare(`
      SELECT * FROM outbound_destinations ORDER BY revision
    `).all())).toContain(destinationEmail);
  });

  it("replays matching idempotency before generating another raw pack", () => {
    const harness = setup();
    const first = request(harness, "same-request");
    const packCountBefore = harness.database.prepare(
      "SELECT COUNT(*) AS count FROM context_packs",
    ).get();

    expect(request(harness, "same-request")).toEqual(first);
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM context_packs",
    ).get()).toEqual(packCountBefore);
  });

  it("rejects an idempotency input mismatch before generating another raw pack", () => {
    const harness = setup();
    const first = request(harness, "mismatched-request");

    expect(() => harness.service.request(harness.principal, {
      projectId: harness.project.id,
      taskId: harness.task.id,
      budgetTokens: 3_999,
      idempotencyKey: "mismatched-request",
    })).toThrowError(expect.objectContaining({
      code: "outbound_request_conflict",
      details: { requestId: first.requestId },
    }));
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM context_packs",
    ).get()).toEqual({ count: 1 });
  });

  it("never copies raw idempotency keys into complete append-only audit rows", () => {
    const harness = setup();
    const privateIdempotencyKey =
      "sk-proj-SyntheticAuditToken0123456789|C:\\Synthetic\\private\\value";
    const pending = request(harness, privateIdempotencyKey);
    harness.service.deny(pending.requestId);

    const serializedAudits = JSON.stringify(harness.database.prepare(`
      SELECT * FROM audit_events ORDER BY created_at, id
    `).all());
    expect(serializedAudits).not.toContain(privateIdempotencyKey);
    expect(serializedAudits).not.toContain(
      "sk-proj-SyntheticAuditToken0123456789",
    );
    expect(serializedAudits).not.toContain("C:\\Synthetic\\private\\value");
  });

  it("commits privacy-safe scan and remembered-policy audit events with their state", () => {
    const harness = setup();
    const { pending } = rememberClean(harness, "audited-clean-policy");
    const events = harness.database.prepare(`
      SELECT action_category, target_id, idempotency_key, reason
      FROM audit_events
      WHERE target_id = ?
      ORDER BY id
    `).all(pending.requestId);

    expect(events).toEqual([
      {
        action_category: "outbound_request_created",
        target_id: pending.requestId,
        idempotency_key: null,
        reason: "request_status:review_required",
      },
      {
        action_category: "outbound_scan_completed",
        target_id: pending.requestId,
        idempotency_key: null,
        reason:
          "scan_completed:total:0;credential:0;sensitive:0;" +
          "forced_redact:0;redact_by_default:0;detector_version:1;" +
          "safety_policy_version:1;destination_revision:1",
      },
      {
        action_category: "outbound_request_approved",
        target_id: pending.requestId,
        idempotency_key: null,
        reason: "approved",
      },
      {
        action_category: "outbound_policy_enabled",
        target_id: pending.requestId,
        idempotency_key: null,
        reason:
          "policy_enabled:detector_version:1;safety_policy_version:1;" +
          "destination_revision:1",
      },
    ]);
  });

  it("never mutates the immutable raw pack while scanning and releasing", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "raw-unchanged");
    const before = harness.contextPackStore.get(pending.sourcePackId);
    const findingId = harness.service.inspect(pending.requestId).findings[0]!.id;

    harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [findingId],
    });

    expect(harness.contextPackStore.get(pending.sourcePackId)).toEqual(before);
  });
});

describe("OutboundContextService review and retrieval", () => {
  it("redacts and reveals sensitive hierarchy labels through the governed release path", () => {
    const labelSecrets = {
      outcome: "outcome.owner@example.invalid",
      initiative: "initiative.owner@example.invalid",
      deliverable: "AKIA1234567890ABCDEF",
      milestone: "milestone.owner@example.invalid",
      task: "task.owner@example.invalid",
      nestedTask: "AKIAFEDCBA0987654321",
    };
    const harness = setup({
      hierarchyVocabulary: {
        ...neutralHierarchyVocabulary,
        ...labelSecrets,
      },
    });
    const pending = request(harness, "hierarchy-label-redaction");

    const inspection = harness.service.inspect(pending.requestId);
    expect(inspection.findings.map(({ path }) => path)).toEqual([
      "/hierarchyVocabulary/deliverable",
      "/hierarchyVocabulary/initiative",
      "/hierarchyVocabulary/milestone",
      "/hierarchyVocabulary/nestedTask",
      "/hierarchyVocabulary/outcome",
      "/hierarchyVocabulary/task",
    ]);
    const serializedPreview = JSON.stringify(inspection.redactedPreview);
    for (const secret of Object.values(labelSecrets)) {
      expect(serializedPreview).not.toContain(secret);
    }
    expect(inspection.redactedPreview.hierarchyVocabulary?.preset).toBe(
      "neutral",
    );
    const initiativeFinding = inspection.findings.find(
      ({ path }) => path === "/hierarchyVocabulary/initiative",
    )!;
    const deliverableFinding = inspection.findings.find(
      ({ path }) => path === "/hierarchyVocabulary/deliverable",
    )!;
    expect(harness.service.reveal(
      pending.requestId,
      initiativeFinding.id,
    ).value).toBe(labelSecrets.initiative);
    expect(harness.service.reveal(
      pending.requestId,
      deliverableFinding.id,
    ).value).toBe(labelSecrets.deliverable);

    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    const serializedRelease = JSON.stringify(release);
    const browserChat = formatBrowserChatExport(release).text;
    for (const secret of Object.values(labelSecrets)) {
      expect(serializedRelease).not.toContain(secret);
      expect(browserChat).not.toContain(secret);
    }
    const vocabularyLine = browserChat.split("\n").find((line) =>
      line.startsWith("Hierarchy vocabulary (JSON): ")
    );
    expect(vocabularyLine).toBeDefined();
    const renderedVocabulary = JSON.parse(vocabularyLine!.slice(
      "Hierarchy vocabulary (JSON): ".length,
    )) as Record<string, string>;
    expect(renderedVocabulary.preset).toBe("neutral");
    expect(Object.keys(renderedVocabulary)).toEqual([
      "preset",
      "outcome",
      "initiative",
      "deliverable",
      "milestone",
      "task",
      "nestedTask",
    ]);
    for (const role of Object.keys(labelSecrets)) {
      expect(renderedVocabulary[role]).toMatch(/^\[REDACTED:/);
    }
  });

  it("inspects and approves a legacy source reference longer than 200 characters exactly", () => {
    const legacySourceReference = `legacy://${"s".repeat(512)}`;
    const harness = setup({ taskSourceRef: legacySourceReference });
    const pending = request(harness, "legacy-source-reference");

    const inspection = harness.service.inspect(pending.requestId);
    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });

    expect(inspection.redactedPreview.task.record.sourceRef).toBe(
      legacySourceReference,
    );
    expect(release.pack.task.record.sourceRef).toBe(legacySourceReference);
    expect(release.disclosure.sourceRecords[0]?.sourceRef).toBe(
      legacySourceReference,
    );
  });

  it("inspects and approves a genuinely historical missing-vocabulary request", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "historical-missing-vocabulary");
    const requestRow = harness.database.prepare(`
      SELECT source_pack_id, destination_snapshot_json
      FROM outbound_requests
      WHERE id = ?
    `).get(pending.requestId) as {
      source_pack_id: string;
      destination_snapshot_json: string;
    };
    const storedPackRow = harness.database.prepare(`
      SELECT content_json
      FROM context_packs
      WHERE id = ?
    `).get(requestRow.source_pack_id) as { content_json: string };
    const currentPack = taskContextPackSchema.parse(
      JSON.parse(storedPackRow.content_json),
    );
    const {
      hierarchyVocabulary: _legacyMissingVocabulary,
      ...legacyPack
    } = currentPack;
    const destination = outboundDestinationSnapshotSchema.parse(
      JSON.parse(requestRow.destination_snapshot_json),
    );
    const historicalScan = createOutboundSafetyEngine().scanStoredPack(
      legacyPack,
      destination,
      { hierarchyVocabularyPresent: false },
    );
    const finding = historicalScan.findings[0]!;
    harness.database.transaction(() => {
      harness.database.prepare(`
        UPDATE context_packs
        SET content_json = ?
        WHERE id = ?
      `).run(JSON.stringify(legacyPack), requestRow.source_pack_id);
      harness.database.prepare(`
        UPDATE outbound_requests
        SET candidate_digest = ?
        WHERE id = ?
      `).run(historicalScan.candidateDigest, pending.requestId);
      harness.database.prepare(`
        UPDATE outbound_findings
        SET id = ?, detector_id = ?, detector_version = ?, category = ?,
            confidence = ?, severity = ?, field_path = ?, start_offset = ?,
            end_offset = ?, finding_key = ?, required_action = ?
        WHERE request_id = ? AND ordinal = 0
      `).run(
        finding.id,
        finding.detectorId,
        finding.detectorVersion,
        finding.category,
        finding.confidence,
        finding.severity,
        finding.path,
        finding.start,
        finding.end,
        finding.findingKey,
        finding.requiredAction,
        pending.requestId,
      );
    }).immediate();

    const inspection = harness.service.inspect(pending.requestId);
    expect(inspection.findings.map(({ id }) => id)).toEqual([finding.id]);
    expect(Object.hasOwn(
      inspection.redactedPreview,
      "hierarchyVocabulary",
    )).toBe(false);
    expect(harness.service.reveal(pending.requestId, finding.id).value).toBe(
      possibleValue,
    );

    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    expect(Object.hasOwn(release.pack, "hierarchyVocabulary")).toBe(false);
    expect(release.pack.task.record.body).not.toContain(possibleValue);
  });

  it("masks every matched value during inspection and reveals only one verified span", () => {
    const harness = setup({
      taskBody: `${forcedValue} belongs to ${possibleValue}.`,
    });
    const pending = request(harness, "inspect");

    const inspection = harness.service.inspect(pending.requestId);
    const renderedPreview = JSON.stringify(inspection.redactedPreview);
    const emailFinding = inspection.findings.find(
      ({ requiredAction }) => requiredAction === "redact_by_default",
    )!;

    expect(renderedPreview).not.toContain(forcedValue);
    expect(renderedPreview).not.toContain(possibleValue);
    expect(renderedPreview).toContain("[REDACTED:");
    expect(harness.service.reveal(pending.requestId, emailFinding.id)).toEqual({
      requestId: pending.requestId,
      findingId: emailFinding.id,
      value: possibleValue,
    });
  });

  it("fails reveal closed when the stored candidate digest no longer verifies", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "reveal-corrupt");
    const findingId = harness.service.inspect(pending.requestId).findings[0]!.id;
    harness.database.prepare(`
      UPDATE outbound_requests SET candidate_digest = ? WHERE id = ?
    `).run("f".repeat(64), pending.requestId);

    expect(() => harness.service.reveal(pending.requestId, findingId))
      .toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
  });

  it("rejects forced finding inclusion and leaves the request pending", () => {
    const harness = setup({ taskBody: forcedValue });
    const pending = request(harness, "forced");
    const finding = harness.service.inspect(pending.requestId).findings[0]!;

    expect(() => harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [finding.id],
    })).toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
    expect(harness.service.list({ status: "review_required" })).toEqual([
      expect.objectContaining({ requestId: pending.requestId }),
    ]);
  });

  it("discloses a possible finding included for this release exactly once", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "include-once");
    const finding = harness.service.inspect(pending.requestId).findings[0]!;

    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [finding.id],
    });

    expect(JSON.stringify(release.pack)).toContain(possibleValue);
    expect(release.disclosure.findingCounts).toMatchObject({
      total: 1,
      redacted: 0,
      includedOnce: 1,
    });
  });

  it("rejects remembered policy for a request that has any finding", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "finding-policy");

    expect(() => harness.service.approve({
      requestId: pending.requestId,
      rememberClean: true,
      includeFindingIds: [],
    })).toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM outbound_policies",
    ).get()).toEqual({ count: 0 });
  });

  it("permits one terminal transition when separate connections contend at the CAS boundary", async () => {
    const harness = setup();
    const pending = request(harness, "terminal-race");
    const result = await runTerminalTransitionContention(
      harness,
      pending.requestId,
    );
    const expectedAuditCategory = {
      released: "outbound_request_approved",
      denied: "outbound_request_denied",
    } as const;

    expect(result).toEqual({
      independentConnections: 2,
      terminalBarrierArrivals: 2,
      outcomes: ["outbound_request_conflict", "success"],
      finalStatus: result.finalStatus,
      terminalAuditCategories: [expectedAuditCategory[result.finalStatus]],
      terminalAuditCount: 1,
    });
  }, 15_000);

  it("returns typed pending and denied retrieval states without a pack", () => {
    const harness = setup();
    const pending = request(harness, "pending");
    const pendingResult = harness.service.getReleased(
      harness.principal,
      pending.requestId,
    );
    harness.service.deny(pending.requestId);
    const deniedResult = harness.service.getReleased(
      harness.principal,
      pending.requestId,
    );

    expect(pendingResult).toEqual({
      status: "review_required",
      request: expect.objectContaining({ requestId: pending.requestId }),
    });
    expect(deniedResult).toEqual({
      status: "denied",
      request: expect.objectContaining({ requestId: pending.requestId }),
    });
    expect(JSON.stringify([pendingResult, deniedResult])).not.toContain('"pack"');
  });

  it("validates the current destination snapshot for pending and denied retrievals", () => {
    const harness = setup();
    const pending = request(harness, "pending-stale-destination");
    harness.destinations.set({
      profileId: harness.principal.id,
      clientLabel: "Second destination revision",
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic boundary",
      dataBoundary: "remote",
    });

    expect(() => harness.service.getReleased(
      harness.principal,
      pending.requestId,
    )).toThrowError(expect.objectContaining({
      code: "outbound_destination_changed",
    }));

    const denied = request(harness, "denied-stale-destination");
    harness.service.deny(denied.requestId);
    harness.destinations.set({
      profileId: harness.principal.id,
      clientLabel: "Third destination revision",
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic boundary",
      dataBoundary: "remote",
    });

    expect(() => harness.service.getReleased(
      harness.principal,
      denied.requestId,
    )).toThrowError(expect.objectContaining({
      code: "outbound_destination_changed",
    }));
  });

  it("retrieves exact stored release JSON instead of rebuilding current project state", () => {
    const harness = setup();
    const { pending, release } = rememberClean(harness, "immutable-release");
    harness.projectStore.createRecord({
      projectId: harness.project.id,
      kind: "decision",
      status: "accepted",
      title: "Newer decision",
      body: "This did not exist when the release was built.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(harness.service.getReleased(
      harness.principal,
      pending.requestId,
    )).toEqual({ status: "released", release });
  });

  it("blocks retrieval after the destination revision changes", () => {
    const harness = setup();
    const { pending } = rememberClean(harness, "stale-destination");
    harness.destinations.set({
      profileId: harness.principal.id,
      clientLabel: "Claude Code desktop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: "Opus",
      accountBoundaryLabel: "team subscription",
      dataBoundary: "remote",
    });

    expect(() => harness.service.getReleased(
      harness.principal,
      pending.requestId,
    )).toThrowError(expect.objectContaining({
      code: "outbound_destination_changed",
      details: {
        requestId: pending.requestId,
        expectedRevision: 1,
        currentRevision: 2,
      },
    }));
  });

  it.each(["digest", "json"] as const)(
    "fails closed on stored release %s corruption",
    (corruption) => {
      const harness = setup();
      const { pending } = rememberClean(harness, `corrupt-${corruption}`);
      harness.database.exec(`
        DROP TRIGGER outbound_releases_no_update;
        DROP TRIGGER outbound_releases_no_delete;
      `);
      if (corruption === "digest") {
        harness.database.prepare(`
          UPDATE outbound_releases SET sha256 = ? WHERE request_id = ?
        `).run("f".repeat(64), pending.requestId);
      } else {
        harness.database.prepare(`
          UPDATE outbound_releases SET content_json = '{}' WHERE request_id = ?
        `).run(pending.requestId);
      }

      expect(() => harness.service.getReleased(
        harness.principal,
        pending.requestId,
      )).toThrowError(expect.objectContaining({
        code: "outbound_release_invalid",
        details: { requestId: pending.requestId },
      }));
    },
  );

  it("prevents another authenticated profile from retrieving the release", () => {
    const harness = setup();
    const { pending } = rememberClean(harness, "owned-release");
    const other = harness.profiles.createProfile({ name: "Other agent" }).profile;
    const otherPrincipal: AuthenticatedProfile = {
      id: other.id,
      name: other.name,
      status: "enabled",
      credentialGeneration: other.tokenRotatedAt,
    };

    expect(() => harness.service.getReleased(otherPrincipal, pending.requestId))
      .toThrowError(expect.objectContaining({
        code: "outbound_release_invalid",
        details: { requestId: pending.requestId },
      }));
  });

  it("commits a privacy-safe retrieval audit before returning content", () => {
    const harness = setup({ taskBody: `Contact ${possibleValue}.` });
    const pending = request(harness, "audited-release");
    const release = harness.service.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });

    expect(harness.service.getReleased(
      harness.principal,
      pending.requestId,
    )).toEqual({ status: "released", release });
    expect(harness.database.prepare(`
      SELECT action_category, target_id
      FROM audit_events
      WHERE action_category = 'outbound_release_retrieved'
    `).get()).toEqual({
      action_category: "outbound_release_retrieved",
      target_id: pending.requestId,
    });
    expect(JSON.stringify(harness.database.prepare(`
      SELECT * FROM audit_events ORDER BY created_at, id
    `).all())).not.toContain(possibleValue);
  });

  it("does not disclose release content when retrieval audit persistence fails", () => {
    const harness = setup();
    const { pending } = rememberClean(harness, "audit-failure");
    harness.failNextAudit();

    let returned = false;
    const retrieve = () => {
      const result = harness.service.getReleased(
        harness.principal,
        pending.requestId,
      );
      returned = true;
      return result;
    };

    expect(retrieve).toThrowError(
      expect.objectContaining({ code: "outbound_safety_failed" }),
    );
    expect(returned).toBe(false);
  });
});
