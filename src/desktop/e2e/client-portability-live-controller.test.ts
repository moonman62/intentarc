import { describe, expect, it } from "vitest";
import type { PortabilityCleanupInput, PortabilityCleanupResult } from "./client-portability-cleanup.js";
import type {
  ClientPortabilitySupervisorSession,
  SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import type {
  AiAdapterDetection,
  AiClientAdapter,
  AiConnectionAttempt,
  AiConnectionStatus,
} from "../adapters/types.js";
import {
  runClientPortabilityAcceptance,
  verifyClientPortabilityEvidence,
  type ClientPortabilityAcceptanceDependencies,
  type ClientPortabilityJourneyResult,
  type ClientPortabilityWorkspace,
} from "./client-portability-live-controller.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const CODEX_NAME = `intentarc-acceptance-codex-${RUN_ID}`;
const CLAUDE_NAME = `intentarc-acceptance-claude-${RUN_ID}`;
const TASK_SNAPSHOT = {
  id: "task-1",
  projectId: "project-1",
  kind: "task",
  status: "active",
  title: "Switch supported clients",
  body: "Prove governed context survives a supported client switch.",
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
} as const;
const VISION_SNAPSHOT = {
  ...TASK_SNAPSHOT,
  id: "vision-1",
  kind: "vision",
  status: "accepted",
  title: "Stable portability intent",
  body: "Preserve governed project intent.",
} as const;
const CONSTRAINT_SNAPSHOT = {
  ...TASK_SNAPSHOT,
  id: "constraint-1",
  kind: "constraint",
  status: "accepted",
  title: "Mandatory portability constraint",
  body: "MANDATORY: retain governed task context.",
} as const;

type FailurePoint =
  | "codex-detect"
  | "codex-collision"
  | "codex-disabled-collision"
  | "codex-disabled-leftover"
  | "codex-detect-after-cleanup"
  | "preflight-inspect"
  | "codex-apply"
  | "claude-prepare"
  | "claude-apply"
  | "journey"
  | "session-close"
  | "session-close-never"
  | "session-force-close"
  | "session-force-close-never"
  | "session-settlement"
  | "workspace-close"
  | "workspace-settlement"
  | "claude-remove"
  | "codex-remove"
  | "claude-inspect";

const detection = (version: string): AiAdapterDetection => ({
  availability: "ready",
  reason: "connector_ready",
  version,
});

const journeyResult: ClientPortabilityJourneyResult = {
  revisionBefore: 5,
  revisionAfter: 6,
  releaseIds: {
    codex: "release-codex",
    claude: "release-claude",
  },
  requestIds: {
    codex: "request-codex",
    claude: "request-claude",
  },
  evidenceId: "evidence-1",
  proposalId: "proposal-1",
  counts: {
    releases: 2,
    auditEvents: 4,
  },
};

const createHarness = (failures: readonly FailurePoint[] = []) => {
  const events: string[] = [];
  const mutationNames: string[] = [];
  const workspace: ClientPortabilityWorkspace = {
    archive: {},
    baselineEvidenceId: "evidence-baseline",
    expectedTask: TASK_SNAPSHOT,
    expectedVision: VISION_SNAPSHOT,
    expectedConstraint: CONSTRAINT_SNAPSHOT,
    codexConnectionId: `intentarc-acceptance-codex-connection-${RUN_ID}`,
    claudeConnectionId: `intentarc-acceptance-claude-connection-${RUN_ID}`,
    close: async () => {
      events.push("workspace:close");
      if (failures.includes("workspace-close")) {
        throw new Error("workspace close failed");
      }
    },
  };

  const adapter = (
    client: "codex" | "claude",
    serverName: string,
  ): AiClientAdapter => {
    let inspected = 0;
    let detected = 0;
    const attempt: AiConnectionAttempt = {
      apply: async () => {
        events.push(`${client}:apply`);
        mutationNames.push(serverName);
        if (client === "codex" && failures.includes("codex-apply")) {
          throw new Error(
            "first-client add failed C:\\private\\settings profileToken=secret-token",
          );
        }
        if (client === "claude" && failures.includes("claude-apply")) {
          throw new Error("second-client add failed");
        }
        return { restartRequired: true };
      },
      rollback: async () => undefined,
    };
    return {
      id: client === "codex" ? "codex" : "claude-code",
      detect: async () => {
        detected += 1;
        events.push(`${client}:detect:${detected}`);
        if (
          client === "codex" &&
          (failures.includes("codex-detect") ||
            (detected === 2 && failures.includes("codex-detect-after-cleanup")))
        ) {
          return {
            availability: "not_detected",
            reason: "not_installed",
            version: null,
          };
        }
        return detection(client === "codex" ? "0.146.0" : "2.1.207");
      },
      inspect: async (): Promise<AiConnectionStatus> => {
        inspected += 1;
        events.push(`${client}:inspect:${inspected}`);
        if (
          client === "codex" && inspected === 1 &&
          failures.includes("preflight-inspect")
        ) {
          throw new Error("ambiguous exact-name inspection");
        }
        if (
          client === "codex" &&
          inspected === 1 &&
          (failures.includes("codex-collision") ||
            failures.includes("codex-disabled-collision"))
        ) {
          return failures.includes("codex-disabled-collision")
            ? "unknown"
            : "connected";
        }
        if (
          client === "codex" &&
          inspected === 2 &&
          failures.includes("codex-disabled-leftover")
        ) {
          return "unknown";
        }
        if (
          client === "claude" &&
          inspected === 2 &&
          failures.includes("claude-inspect")
        ) {
          throw new Error("post-cleanup inspection failed");
        }
        return "not_connected";
      },
      prepareConnection: async (input) => {
        events.push(`${client}:prepare:${input.connectionId}`);
        mutationNames.push(serverName);
        if (client === "claude" && failures.includes("claude-prepare")) {
          throw new Error("second-client prepare failed");
        }
        return attempt;
      },
      connect: async () => ({ restartRequired: true }),
      remove: async () => {
        events.push(`${client}:remove`);
        mutationNames.push(serverName);
        if (failures.includes(`${client}-remove` as FailurePoint)) {
          throw new Error(`${client} remove failed`);
        }
      },
      launch: async () => {
        throw new Error("launch must never be called");
      },
    };
  };

  const dependencies: Pick<
    ClientPortabilityAcceptanceDependencies,
    | "uuid"
    | "createAdapters"
    | "createWorkspace"
    | "resolveBridgeExecutable"
    | "teardownTimeoutMs"
    | "forceTeardownTimeoutMs"
    | "settlementTimeoutMs"
  > = {
    uuid: () => {
      events.push("uuid");
      return RUN_ID;
    },
    createAdapters: ({ codexServerName, claudeServerName }) => {
      events.push(`adapters:${codexServerName}:${claudeServerName}`);
      return {
        codex: adapter("codex", codexServerName),
        claude: adapter("claude", claudeServerName),
      };
    },
    createWorkspace: async (input) => {
      events.push(`workspace:create:${input.runId}`);
      return workspace;
    },
    resolveBridgeExecutable: () => "C:\\IntentArc\\IntentArc Bridge.exe",
    teardownTimeoutMs: 10,
    forceTeardownTimeoutMs: 10,
    settlementTimeoutMs: 10,
  };

  return { dependencies, events, mutationNames };
};

const run = (dependencies: ClientPortabilityAcceptanceDependencies) =>
  runClientPortabilityAcceptance({}, dependencies);

describe("live client portability controller", () => {
  const supervisorSettlement = (
    status: SupervisorSettlementResult["status"] = "settled",
    category: SupervisorSettlementResult["category"] = "none",
    retained: SupervisorSettlementResult["retained"] = [],
  ): SupervisorSettlementResult => Object.freeze({ status, category, retained });

  const createSupervisorHarness = (options: {
    readonly failures?: readonly FailurePoint[];
    readonly connectFailure?: "codex" | "claude";
    readonly closeFailure?: "codex" | "claude";
    readonly closeHangsUntilInternalTimeout?: "codex" | "claude";
    readonly settlements?: Partial<Record<"codex" | "claude", SupervisorSettlementResult>>;
    readonly workspaceCloseFailure?: boolean;
    readonly cleanupResult?: PortabilityCleanupResult;
  } = {}) => {
    const { dependencies: oldDependencies, events, mutationNames } = createHarness(
      options.failures,
    );
    const created = new Map<"codex" | "claude", ClientPortabilitySupervisorSession>();
    const cleanupInputs: PortabilityCleanupInput[] = [];
    const deadlines: Array<{
      readonly client: "codex" | "claude";
      readonly operation: "connect" | "close" | "settle";
      readonly value: number;
    }> = [];
    const pendingRequests: Record<"codex" | "claude", Set<string>> = {
      codex: new Set(),
      claude: new Set(),
    };
    const pendingCountsAtSettlement: Array<{
      readonly client: "codex" | "claude";
      readonly count: number;
    }> = [];
    const sessions = Object.fromEntries((["codex", "claude"] as const).map((client) => {
      const session: ClientPortabilitySupervisorSession = {
        identity: Promise.resolve({ pid: client === "codex" ? 101 : 102, startTime: "1000" }),
        connect: async (_input, deadline) => {
          deadlines.push({ client, operation: "connect", value: deadline });
          events.push(`${client}:connect`);
          pendingRequests[client].add("connect");
          try {
            if (created.size !== 2) {
              throw new Error("both supervisors must be owned before connect");
            }
            if (options.connectFailure === client) throw new Error("connect failed");
          } finally {
            pendingRequests[client].delete("connect");
          }
        },
        callTool: async <Result extends object>() => ({} as Result),
        close: async (deadline) => {
          deadlines.push({ client, operation: "close", value: deadline });
          events.push(`${client}:close`);
          pendingRequests[client].add("close");
          if (options.closeHangsUntilInternalTimeout === client) {
            await new Promise<void>((_resolve, reject) => {
              setTimeout(() => {
                events.push(`${client}:close-timeout-drain`);
                pendingRequests[client].clear();
                reject(new Error("close timed out"));
              }, 1);
            });
          }
          pendingRequests[client].delete("close");
          if (options.closeFailure === client) throw new Error("close failed");
        },
        settle: async (deadline) => {
          deadlines.push({ client, operation: "settle", value: deadline });
          events.push(`${client}:settle`);
          pendingRequests[client].clear();
          pendingCountsAtSettlement.push({ client, count: pendingRequests[client].size });
          return options.settlements?.[client] ?? supervisorSettlement();
        },
      };
      return [client, session];
    })) as Record<"codex" | "claude", ClientPortabilitySupervisorSession>;
    const cleanupResult = options.cleanupResult ?? {
      status: "removed" as const,
      removedEntries: 3,
    };
    const dependencies = {
      ...oldDependencies,
      now: () => 1_000,
      createWorkspace: async (input: Parameters<typeof oldDependencies.createWorkspace>[0]) => {
        const workspace = await oldDependencies.createWorkspace(input);
        return {
          ...workspace,
          close: async () => {
            events.push("workspace:close");
            if (options.workspaceCloseFailure) throw new Error("workspace close failed");
          },
        };
      },
      createBridgeSession: (input: { readonly client: "codex" | "claude" }) => {
        events.push(`session:create:${input.client}`);
        const session = sessions[input.client];
        created.set(input.client, session);
        return session;
      },
      runSemanticJourney: async (input: {
        readonly codexSession: ClientPortabilitySupervisorSession;
        readonly claudeSession: ClientPortabilitySupervisorSession;
      }) => {
        events.push("journey");
        expect(input.codexSession).toBe(sessions.codex);
        expect(input.claudeSession).toBe(sessions.claude);
        if (options.failures?.includes("journey")) throw new Error("journey failed");
        return journeyResult;
      },
      finalizeCleanup: async (input: PortabilityCleanupInput) => {
        events.push("root:finalize");
        cleanupInputs.push(input);
        return options.cleanupResult ?? (input.configurationAbsent
          ? cleanupResult
          : {
              status: "preserved" as const,
              category: "configuration" as const,
              receiptPath: null,
              recoveryCommand: null,
            });
      },
      operationTimeoutMs: 50,
    } as unknown as ClientPortabilityAcceptanceDependencies;
    return {
      dependencies,
      events,
      mutationNames,
      cleanupInputs,
      sessions,
      deadlines,
      pendingCountsAtSettlement,
    };
  };

  it("owns both supervisor sessions synchronously before either connection starts", async () => {
    const { dependencies, events } = createSupervisorHarness();

    const result = await run(dependencies);

    expect(result.status).toBe("PASS");
    expect(events.indexOf("session:create:claude")).toBeLessThan(events.indexOf("codex:connect"));
    expect(events.indexOf("codex:connect")).toBeLessThan(events.indexOf("journey"));
    expect(events.indexOf("claude:connect")).toBeLessThan(events.indexOf("journey"));
  });

  it("passes absolute operation-specific deadlines to every owned supervisor", async () => {
    const { dependencies, deadlines } = createSupervisorHarness();

    await run(dependencies);

    expect(deadlines).toEqual(expect.arrayContaining([
      { client: "codex", operation: "connect", value: 1_050 },
      { client: "claude", operation: "connect", value: 1_050 },
      { client: "codex", operation: "close", value: 1_010 },
      { client: "claude", operation: "close", value: 1_010 },
      { client: "codex", operation: "settle", value: 1_010 },
      { client: "claude", operation: "settle", value: 1_010 },
    ]));
  });

  it("settles both owned supervisors and the workspace after one connection fails", async () => {
    const { dependencies, events } = createSupervisorHarness({ connectFailure: "codex" });

    const result = await run(dependencies);

    expect(result.status).toBe("BLOCKED");
    expect(events).toEqual(expect.arrayContaining([
      "codex:settle",
      "claude:settle",
      "workspace:close",
      "root:finalize",
    ]));
  });

  it("does not let one hanging supervisor skip settlement of the peer or workspace", async () => {
    const blocked = supervisorSettlement("blocked", "child_handle", [{ pid: 201, startTime: "2000" }]);
    const { dependencies, events, pendingCountsAtSettlement } = createSupervisorHarness({
      closeHangsUntilInternalTimeout: "codex",
      settlements: { codex: blocked },
    });

    const result = await run(dependencies);

    expect(result.resourcesSettled).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      "codex:settle",
      "claude:settle",
      "workspace:close",
      "root:finalize",
    ]));
    expect(events).toContain("codex:close-timeout-drain");
    expect(pendingCountsAtSettlement).toEqual(expect.arrayContaining([
      { client: "codex", count: 0 },
      { client: "claude", count: 0 },
    ]));
  });

  it("passes exact retained descendants and drained ownership into cleanup", async () => {
    const descendants = Object.freeze([
      Object.freeze({ pid: 301, startTime: "3000" }),
      Object.freeze({ pid: 302, startTime: "3001" }),
    ]);
    const blocked = supervisorSettlement("blocked", "child_handle", descendants);
    const { dependencies, cleanupInputs } = createSupervisorHarness({
      closeFailure: "codex",
      settlements: { codex: blocked },
      cleanupResult: {
        status: "preserved",
        category: "settlement",
        receiptPath: "C:\\Temp\\receipt.json",
        recoveryCommand:
          'pnpm desktop:test:client-portability:cleanup -- --receipt "C:\\Temp\\receipt.json"',
      },
    });

    const result = await run(dependencies);

    expect(cleanupInputs).toHaveLength(1);
    expect(cleanupInputs[0]).toMatchObject({ requestsDrained: true, workspaceClosed: true });
    expect(cleanupInputs[0]!.sessions[0]).toBe(blocked);
    expect(cleanupInputs[0]!.sessions[0]!.retained).toBe(descendants);
    expect(result.rootCleanup).toEqual({
      status: "preserved",
      category: "settlement",
      receiptPath: "C:\\Temp\\receipt.json",
      recoveryCommand:
        'pnpm desktop:test:client-portability:cleanup -- --receipt "C:\\Temp\\receipt.json"',
    });
  });

  it("forwards non-actionable preservation without inventing a recovery command", async () => {
    const { dependencies } = createSupervisorHarness({
      cleanupResult: {
        status: "preserved",
        category: "root",
        receiptPath: null,
        recoveryCommand: null,
      },
    });

    const result = await run(dependencies);

    expect(result.rootCleanup).toEqual({
      status: "preserved",
      category: "root",
      receiptPath: null,
      recoveryCommand: null,
    });
    expect(result.resourcesSettled).toBe(false);
    expect(result.counts.rootPreservationFailures).toBe(1);
  });

  it("reports destructive uncertainty separately from safe preservation", async () => {
    const { dependencies } = createSupervisorHarness({
      cleanupResult: {
        status: "cleanup_failed",
        category: "root",
        residuePath: null,
        removedEntries: null,
      },
    });

    const result = await run(dependencies);

    expect(result.rootCleanup).toEqual({
      status: "cleanup_failed",
      category: "root",
      residuePath: null,
      removedEntries: null,
    });
    expect(result.resourcesSettled).toBe(false);
    expect(result.counts.rootPreservationFailures).toBe(1);
  });

  it("stops before configuration mutation when a supported client is unavailable", async () => {
    const { dependencies, mutationNames, events } = createSupervisorHarness({
      failures: ["codex-detect"],
    });

    const result = await run(dependencies);

    expect(result).toMatchObject({
      status: "BLOCKED",
      outcomeCategory: "client_not_ready",
      resourcesSettled: false,
      rootCleanup: {
        status: "preserved",
        receiptPath: null,
        recoveryCommand: null,
      },
    });
    expect(mutationNames).toEqual([]);
    expect(events).not.toContain("session:create:codex");
  });

  it("cleans both exact names after a configuration failure without disclosing errors", async () => {
    const { dependencies, events } = createSupervisorHarness({
      failures: ["claude-apply"],
    });

    const result = await run(dependencies);

    expect(result.outcomeCategory).toBe("configuration_failure");
    expect(result.counts.configurationFailures).toBe(1);
    expect(events).toEqual(expect.arrayContaining(["claude:remove", "codex:remove"]));
    expect(JSON.stringify(result)).not.toMatch(/secret-token|profileToken|C:\\private/i);
  });

  it("keeps journey and exact-name cleanup failures independently visible", async () => {
    const { dependencies } = createSupervisorHarness({
      failures: ["journey", "claude-remove"],
    });

    const result = await run(dependencies);

    expect(result.counts).toMatchObject({ journeyFailures: 1, cleanupFailures: 1 });
    expect(result.outcomeCategory).toBe("exact_name_cleanup_failure");
    expect(result.recoveryCommands).toEqual([{
      client: "claude",
      command: `claude mcp remove --scope user ${CLAUDE_NAME}`,
    }]);
    expect(result.rootCleanup).toMatchObject({
      status: "preserved",
      category: "configuration",
      receiptPath: null,
      recoveryCommand: null,
    });
  });

  it("records workspace closure failure separately and preserves the root", async () => {
    const { dependencies, cleanupInputs } = createSupervisorHarness({
      workspaceCloseFailure: true,
      cleanupResult: {
        status: "preserved",
        category: "workspace",
        receiptPath: null,
        recoveryCommand: null,
      },
    });

    const result = await run(dependencies);

    expect(result.counts).toMatchObject({ workspaceFailures: 1, rootPreservationFailures: 1 });
    expect(result.resourcesSettled).toBe(false);
    expect(cleanupInputs[0]!.workspaceClosed).toBe(false);
  });

  it("rejects an operator-supplied non-UUID before any dependency runs", async () => {
    const { dependencies, events } = createSupervisorHarness();

    await expect(runClientPortabilityAcceptance(
      { runId: "../../intentarc" },
      dependencies,
    )).rejects.toThrow("Client portability run ID must be a UUID.");
    expect(events).toEqual([]);
  });

  it("rejects incomplete profile-owned release and evidence history", () => {
    const expectedTask = TASK_SNAPSHOT;
    const expectedVision = VISION_SNAPSHOT;
    const expectedConstraint = CONSTRAINT_SNAPSHOT;
    const valid = {
      projectId: "project-1",
      taskId: "task-1",
      revisionBefore: 5,
      revisionAfter: 6,
      codexProfileId: "profile-codex",
      claudeProfileId: "profile-claude",
      codexRequestId: "request-codex",
      claudeRequestId: "request-claude",
      proposalId: "proposal-1",
      baselineEvidenceId: "evidence-baseline",
      expectedTask,
      expectedVision,
      expectedConstraint,
      evidence: {
        id: "evidence-1",
        sourceKind: "agent",
        sourceRef: "profile-codex",
      },
      relationship: {
        fromRecordId: "evidence-1",
        toRecordId: "task-1",
        kind: "evidenced_by",
      },
      packs: {
        codex: {
          projectId: "project-1",
          taskId: "task-1",
          projectRevision: 5,
          task: { record: expectedTask },
          stableFrame: [{
            record: expectedVision,
            mandatory: true,
            relevance: "stable_frame",
            relationshipKind: null,
          }, {
            record: expectedConstraint,
            mandatory: true,
            relevance: "stable_frame",
            relationshipKind: null,
          }],
          related: [{
            record: { id: "evidence-baseline" },
            relationshipKind: "evidenced_by",
          }],
        },
        claude: {
          projectId: "project-1",
          taskId: "task-1",
          projectRevision: 6,
          task: { record: expectedTask },
          stableFrame: [{
            record: expectedVision,
            mandatory: true,
            relevance: "stable_frame",
            relationshipKind: null,
          }, {
            record: expectedConstraint,
            mandatory: true,
            relevance: "stable_frame",
            relationshipKind: null,
          }],
          related: [{
            record: { id: "evidence-baseline" },
            relationshipKind: "evidenced_by",
          }, {
            record: { id: "evidence-1" },
            relationshipKind: "evidenced_by",
          }],
        },
      },
      releases: [{
        requestId: "request-codex",
        profileId: "profile-codex",
        projectRevision: 5,
        status: "released",
      }, {
        requestId: "request-claude",
        profileId: "profile-claude",
        projectRevision: 6,
        status: "released",
      }],
      audits: [{
        profileId: "profile-codex",
        actionCategory: "outbound_release_retrieved",
        targetId: "request-codex",
      }, {
        profileId: "profile-codex",
        actionCategory: "outbound_release_retrieved",
        targetId: "request-codex",
      }, {
        profileId: "profile-claude",
        actionCategory: "outbound_release_retrieved",
        targetId: "request-claude",
      }, {
        profileId: null,
        actorType: "local_human",
        actionCategory: "proposal_accepted",
        targetId: "proposal-1",
        revisionBefore: 5,
        revisionAfter: 6,
      }],
    } as const;

    expect(() => verifyClientPortabilityEvidence(valid)).not.toThrow();
    for (const [client, changedTask] of [
      ["codex", { ...expectedTask, title: "A valid but changed task title" }],
      ["claude", { ...expectedTask, body: "A valid but changed task body." }],
      ["codex", { ...expectedTask, revision: 2 }],
    ] as const) {
      expect(() => verifyClientPortabilityEvidence({
        ...valid,
        packs: {
          ...valid.packs,
          [client]: {
            ...valid.packs[client],
            task: { record: changedTask },
          },
        },
      })).toThrow(`${client === "codex" ? "Codex" : "Claude"} released pack`);
    }
    for (const [client, changedVision] of [
      ["codex", { ...expectedVision, title: "A valid but changed vision" }],
      ["claude", { ...expectedVision, body: "A valid but changed intent." }],
      ["codex", { ...expectedVision, revision: 2 }],
    ] as const) {
      expect(() => verifyClientPortabilityEvidence({
        ...valid,
        packs: {
          ...valid.packs,
          [client]: {
            ...valid.packs[client],
            stableFrame: valid.packs[client].stableFrame.map((item) =>
              item.record.id === expectedVision.id
                ? { ...item, record: changedVision }
                : item
            ),
          },
        },
      })).toThrow("stable intent");
    }
    for (const [client, changedConstraint] of [
      ["codex", { ...expectedConstraint, title: "A valid but changed constraint" }],
      ["claude", { ...expectedConstraint, body: "MANDATORY: changed detail." }],
      ["codex", { ...expectedConstraint, revision: 2 }],
      ["claude", { ...expectedConstraint, status: "active" }],
    ] as const) {
      expect(() => verifyClientPortabilityEvidence({
        ...valid,
        packs: {
          ...valid.packs,
          [client]: {
            ...valid.packs[client],
            stableFrame: valid.packs[client].stableFrame.map((item) =>
              item.record.id === expectedConstraint.id
                ? { ...item, record: changedConstraint }
                : item
            ),
          },
        },
      })).toThrow("mandatory constraint");
    }
    const coherentFourToFive = {
      ...valid,
      revisionBefore: 4,
      revisionAfter: 5,
      packs: {
        codex: { ...valid.packs.codex, projectRevision: 4 },
        claude: { ...valid.packs.claude, projectRevision: 5 },
      },
      releases: [
        { ...valid.releases[0], projectRevision: 4 },
        { ...valid.releases[1], projectRevision: 5 },
      ],
      audits: valid.audits.map((audit) =>
        audit.actionCategory === "proposal_accepted"
          ? { ...audit, revisionBefore: 4, revisionAfter: 5 }
          : audit
      ),
    } as const;
    expect(() => verifyClientPortabilityEvidence(coherentFourToFive)).toThrow(
      "5 to 6",
    );
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      releases: valid.releases.slice(0, 1),
    })).toThrow("release history");
    for (const releases of [{
      ...valid.releases[0],
      profileId: "profile-claude",
    }, {
      ...valid.releases[0],
      projectRevision: 4,
    }, {
      ...valid.releases[0],
      status: "approved",
    }].map((changedCodexRelease) => [
      changedCodexRelease,
      valid.releases[1],
    ] as const)) {
      expect(() => verifyClientPortabilityEvidence({
        ...valid,
        releases,
      })).toThrow("release history");
    }
    for (const claudeRelease of [{
      ...valid.releases[1],
      profileId: "profile-codex",
    }, {
      ...valid.releases[1],
      projectRevision: 3,
    }, {
      ...valid.releases[1],
      status: "approved",
    }]) {
      expect(() => verifyClientPortabilityEvidence({
        ...valid,
        releases: [valid.releases[0], claudeRelease],
      })).toThrow("release history");
    }
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      audits: valid.audits.filter(({ profileId }) => profileId !== "profile-claude"),
    })).toThrow("audit history");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      audits: valid.audits.slice(1),
    })).toThrow("audit history");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      audits: valid.audits.map((audit) =>
        audit.actionCategory === "proposal_accepted"
          ? { ...audit, revisionAfter: 5 }
          : audit
      ),
    })).toThrow("audit history");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      evidence: { ...valid.evidence, sourceRef: "profile-claude" },
    })).toThrow("evidence attribution");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      evidence: { ...valid.evidence, sourceKind: "human" },
    })).toThrow("evidence attribution");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      relationship: { ...valid.relationship, toRecordId: "other-task" },
    })).toThrow("evidence relationship");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      relationship: { ...valid.relationship, fromRecordId: "other-evidence" },
    })).toThrow("evidence relationship");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      relationship: { ...valid.relationship, kind: "depends_on" },
    })).toThrow("evidence relationship");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: { ...valid.packs.codex, projectId: "other-project" },
      },
    })).toThrow("Codex released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: { ...valid.packs.claude, taskId: "other-task" },
      },
    })).toThrow("Claude released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: {
          ...valid.packs.codex,
          task: { record: { ...expectedTask, id: "other-task" } },
        },
      },
    })).toThrow("Codex released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: { ...valid.packs.claude, projectId: "other-project" },
      },
    })).toThrow("Claude released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: { ...valid.packs.codex, projectRevision: 6 },
      },
    })).toThrow("Codex released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: { ...valid.packs.claude, projectRevision: 5 },
      },
    })).toThrow("Claude released pack");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: { ...valid.packs.codex, related: [] },
      },
    })).toThrow("baseline evidence");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: {
          ...valid.packs.claude,
          related: valid.packs.claude.related.slice(1),
        },
      },
    })).toThrow("baseline evidence");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: {
          ...valid.packs.claude,
          related: valid.packs.claude.related.slice(0, 1),
        },
      },
    })).toThrow("accepted evidence");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: { ...valid.packs.codex, stableFrame: valid.packs.codex.stableFrame.slice(1) },
      },
    })).toThrow("stable intent");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: {
          ...valid.packs.claude,
          stableFrame: valid.packs.claude.stableFrame.slice(0, 1),
        },
      },
    })).toThrow("mandatory constraint");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: {
          ...valid.packs.claude,
          stableFrame: valid.packs.claude.stableFrame.map((item) =>
            item.record.id === "constraint-1"
              ? { ...item, mandatory: false }
              : item
          ),
        },
      },
    })).toThrow("mandatory constraint");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        codex: {
          ...valid.packs.codex,
          stableFrame: valid.packs.codex.stableFrame.map((item) =>
            item.record.id === "vision-1"
              ? { ...item, record: { ...item.record, body: "" } }
              : item
          ),
        },
      },
    })).toThrow("stable intent");
    expect(() => verifyClientPortabilityEvidence({
      ...valid,
      packs: {
        ...valid.packs,
        claude: {
          ...valid.packs.claude,
          stableFrame: valid.packs.claude.stableFrame.map((item) =>
            item.record.id === "constraint-1"
              ? { ...item, record: { ...item.record, body: "Optional guidance." } }
              : item
          ),
        },
      },
    })).toThrow("mandatory constraint");
  });
});
