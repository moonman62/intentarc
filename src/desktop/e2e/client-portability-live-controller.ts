import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createApplication, type IntentArcApplication } from "../../app/create-application.js";
import type { ChangeSubmissionResult } from "../../core/change-service.js";
import type { ProjectSummary } from "../../core/intentarc-service.js";
import {
  getReleasedContextResultSchema,
  requestTaskContextResultSchema,
  type OutboundRelease,
  type ProjectRecord,
} from "../../domain/index.js";
import { createClaudeCodeAdapter } from "../adapters/claude-code.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { createCommandRunner } from "../adapters/command-runner.js";
import type {
  AiAdapterDetection,
  AiClientAdapter,
} from "../adapters/types.js";
import { createDesktopSettingsStore } from "../settings.js";
import {
  finalizeClientPortabilityCleanup,
  type PortabilityCleanupInput,
  type PortabilityCleanupResult,
} from "./client-portability-cleanup.js";
import {
  createClientPortabilitySupervisorSession,
  type ClientPortabilitySupervisorSession,
  type SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import {
  createWindowsSupervisorSettlementBackend,
  observeWindowsSupervisorIdentity,
} from "./client-portability-windows-settlement.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ClientKind = "codex" | "claude";
type CleanupStatus = "not_required" | "absent" | "failed";
type ImmutableProjectRecord = Readonly<ProjectRecord>;
export type ClientPortabilityOutcomeCategory =
  | "passed"
  | "client_not_ready"
  | "exact_name_collision_or_ambiguous"
  | "configuration_failure"
  | "bridge_or_journey_failure"
  | "teardown_failure"
  | "exact_name_cleanup_failure"
  | "root_cleanup_failure";

export interface ClientPortabilityRecoveryCommand {
  readonly client: ClientKind;
  readonly command: string;
}

export interface ClientPortabilityAcceptanceInput {
  readonly runId?: string;
  readonly archivePath?: string;
  readonly settingsRoot?: string;
  readonly bridgeExecutable?: string;
}

export interface ClientPortabilityJourneyResult {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly releaseIds: Readonly<Record<ClientKind, string>>;
  readonly requestIds: Readonly<Record<ClientKind, string>>;
  readonly evidenceId: string;
  readonly proposalId: string;
  readonly counts: {
    readonly releases: number;
    readonly auditEvents: number;
  };
}

export interface ClientPortabilityAcceptanceResult {
  readonly status: "PASS" | "BLOCKED";
  readonly outcomeCategory: ClientPortabilityOutcomeCategory;
  readonly recoveryCommands: readonly ClientPortabilityRecoveryCommand[];
  readonly runId: string;
  readonly clientVersions: Readonly<Record<ClientKind, string | null>>;
  readonly serverNames: Readonly<Record<ClientKind, string>>;
  readonly revisionBefore: number | null;
  readonly revisionAfter: number | null;
  readonly releaseIds: Readonly<Record<ClientKind, string | null>>;
  readonly requestIds: Readonly<Record<ClientKind, string | null>>;
  readonly evidenceId: string | null;
  readonly proposalId: string | null;
  readonly counts: {
    readonly releases: number;
    readonly auditEvents: number;
    readonly configurationFailures: number;
    readonly journeyFailures: number;
    readonly teardownFailures: number;
    readonly gracefulTeardownFailures: number;
    readonly forcedTeardownFailures: number;
    readonly settlementFailures: number;
    readonly workspaceFailures: number;
    readonly rootPreservationFailures: number;
    readonly cleanupFailures: number;
  };
  readonly resourcesSettled: boolean;
  readonly cleanup: Readonly<Record<ClientKind, CleanupStatus>>;
  readonly rootCleanup: PortabilityCleanupResult;
}

export interface ClientPortabilityWorkspace {
  readonly archive: unknown;
  readonly baselineEvidenceId: string;
  readonly expectedTask: ImmutableProjectRecord;
  readonly expectedVision: ImmutableProjectRecord;
  readonly expectedConstraint: ImmutableProjectRecord;
  readonly codexConnectionId: string;
  readonly claudeConnectionId: string;
  close(): Promise<void>;
}

interface CreateWorkspaceInput extends ClientPortabilityAcceptanceInput {
  readonly runId: string;
  readonly codexConnectionId: string;
  readonly claudeConnectionId: string;
}

interface CreateBridgeSessionInput extends ClientPortabilityAcceptanceInput {
  readonly client: ClientKind;
  readonly connectionId: string;
  readonly bridgeExecutable: string;
  readonly forceSettlementTimeoutMs: number;
}

interface RunSemanticJourneyInput {
  readonly archive: unknown;
  readonly baselineEvidenceId: string;
  readonly expectedTask: ImmutableProjectRecord;
  readonly expectedVision: ImmutableProjectRecord;
  readonly expectedConstraint: ImmutableProjectRecord;
  readonly codexSession: ClientPortabilitySupervisorSession;
  readonly claudeSession: ClientPortabilitySupervisorSession;
}

export interface ClientPortabilityAcceptanceDependencies {
  readonly uuid: () => string;
  readonly createAdapters: (input: {
    readonly codexServerName: string;
    readonly claudeServerName: string;
  }) => {
    readonly codex: AiClientAdapter;
    readonly claude: AiClientAdapter;
  };
  readonly createWorkspace: (
    input: CreateWorkspaceInput,
  ) => Promise<ClientPortabilityWorkspace>;
  readonly createBridgeSession: (
    input: CreateBridgeSessionInput,
  ) => ClientPortabilitySupervisorSession;
  readonly runSemanticJourney: (
    input: RunSemanticJourneyInput,
  ) => Promise<ClientPortabilityJourneyResult>;
  readonly resolveBridgeExecutable: () => string;
  readonly finalizeCleanup: (
    input: PortabilityCleanupInput,
  ) => Promise<PortabilityCleanupResult>;
  readonly now: () => number;
  readonly operationTimeoutMs: number;
  readonly teardownTimeoutMs: number;
  readonly forceTeardownTimeoutMs: number;
  readonly settlementTimeoutMs: number;
}

export interface ClientPortabilityEvidenceVerificationInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly codexProfileId: string;
  readonly claudeProfileId: string;
  readonly codexRequestId: string;
  readonly claudeRequestId: string;
  readonly proposalId: string;
  readonly baselineEvidenceId: string;
  readonly expectedTask: ImmutableProjectRecord;
  readonly expectedVision: ImmutableProjectRecord;
  readonly expectedConstraint: ImmutableProjectRecord;
  readonly evidence: {
    readonly id: string;
    readonly sourceKind: string;
    readonly sourceRef: string | null;
  };
  readonly relationship: {
    readonly fromRecordId: string;
    readonly toRecordId: string;
    readonly kind: string;
  };
  readonly packs: Readonly<Record<ClientKind, {
    readonly projectId: string;
    readonly taskId: string;
    readonly projectRevision: number;
    readonly task: { readonly record: ProjectRecord };
    readonly stableFrame: readonly {
      readonly record: ProjectRecord;
      readonly mandatory: boolean;
      readonly relevance: string;
      readonly relationshipKind: string | null;
    }[];
    readonly related: readonly {
      readonly record: { readonly id: string };
      readonly relationshipKind: string | null;
    }[];
  }>>;
  readonly releases: readonly {
    readonly requestId: string;
    readonly profileId: string;
    readonly projectRevision: number;
    readonly status: string;
  }[];
  readonly audits: readonly {
    readonly profileId?: string | null;
    readonly actorType?: string;
    readonly actionCategory: string;
    readonly targetId: string | null;
    readonly revisionBefore?: number | null;
    readonly revisionAfter?: number | null;
  }[];
}

export const verifyClientPortabilityEvidence = (
  input: ClientPortabilityEvidenceVerificationInput,
): void => {
  if (input.revisionBefore !== 5 || input.revisionAfter !== 6) {
    throw new Error("Client portability must preserve the exact 5 to 6 revision journey.");
  }
  const recordsAreEqual = (
    actual: ProjectRecord,
    expected: ImmutableProjectRecord,
  ): boolean =>
    actual.id === expected.id &&
    actual.projectId === expected.projectId &&
    actual.kind === expected.kind &&
    actual.status === expected.status &&
    actual.title === expected.title &&
    actual.body === expected.body &&
    actual.sourceKind === expected.sourceKind &&
    actual.sourceRef === expected.sourceRef &&
    actual.revision === expected.revision &&
    actual.createdAt === expected.createdAt &&
    actual.updatedAt === expected.updatedAt;
  const verifyPack = (
    client: "Codex" | "Claude",
    pack: ClientPortabilityEvidenceVerificationInput["packs"][ClientKind],
    expectedRevision: number,
  ): void => {
    if (
      pack.projectId !== input.projectId ||
      pack.taskId !== input.taskId ||
      input.expectedTask.id !== input.taskId ||
      input.expectedTask.projectId !== input.projectId ||
      !recordsAreEqual(pack.task.record, input.expectedTask) ||
      pack.projectRevision !== expectedRevision
    ) {
      throw new Error(`${client} released pack identity is invalid.`);
    }
    const hasStableRecord = (expected: ImmutableProjectRecord): boolean =>
      pack.stableFrame.some((item) =>
        recordsAreEqual(item.record, expected) &&
        item.mandatory === true &&
        item.relevance === "stable_frame" &&
        item.relationshipKind === null
      );
    if (
      input.expectedVision.kind !== "vision" ||
      input.expectedVision.status !== "accepted" ||
      input.expectedVision.projectId !== input.projectId ||
      !hasStableRecord(input.expectedVision)
    ) {
      throw new Error(`${client} released pack is missing stable intent.`);
    }
    if (
      input.expectedConstraint.kind !== "constraint" ||
      input.expectedConstraint.status !== "accepted" ||
      input.expectedConstraint.projectId !== input.projectId ||
      !input.expectedConstraint.body.startsWith("MANDATORY:") ||
      !hasStableRecord(input.expectedConstraint)
    ) {
      throw new Error(`${client} released pack is missing mandatory constraint.`);
    }
    if (pack.stableFrame.length !== 2) {
      throw new Error(`${client} released pack stable frame is not exact.`);
    }
    const hasEvidence = (evidenceId: string): boolean =>
      pack.related.some(({ record, relationshipKind }) =>
        record.id === evidenceId && relationshipKind === "evidenced_by"
      );
    if (!hasEvidence(input.baselineEvidenceId)) {
      throw new Error(`${client} released pack is missing baseline evidence.`);
    }
    if (client === "Claude" && !hasEvidence(input.evidence.id)) {
      throw new Error("Claude released pack is missing accepted evidence.");
    }
  };
  verifyPack("Codex", input.packs.codex, input.revisionBefore);
  verifyPack("Claude", input.packs.claude, input.revisionAfter);

  const expectedReleases = [{
    requestId: input.codexRequestId,
    profileId: input.codexProfileId,
    projectRevision: input.revisionBefore,
    status: "released",
  }, {
    requestId: input.claudeRequestId,
    profileId: input.claudeProfileId,
    projectRevision: input.revisionAfter,
    status: "released",
  }];
  const hasExactRelease = (expected: (typeof expectedReleases)[number]) =>
    input.releases.some((release) =>
      release.requestId === expected.requestId &&
      release.profileId === expected.profileId &&
      release.projectRevision === expected.projectRevision &&
      release.status === expected.status
    );
  if (input.releases.length !== 2 || !expectedReleases.every(hasExactRelease)) {
    throw new Error("Client portability release history is incomplete.");
  }

  const retrievalCount = (profileId: string, requestId: string): number =>
    input.audits.filter((audit) =>
      audit.profileId === profileId &&
      audit.actionCategory === "outbound_release_retrieved" &&
      audit.targetId === requestId
    ).length;
  const acceptedAudit = input.audits.some((audit) =>
    audit.actorType === "local_human" &&
    audit.actionCategory === "proposal_accepted" &&
    audit.targetId === input.proposalId &&
    audit.revisionBefore === input.revisionBefore &&
    audit.revisionAfter === input.revisionAfter
  );
  if (
    retrievalCount(input.codexProfileId, input.codexRequestId) !== 2 ||
    retrievalCount(input.claudeProfileId, input.claudeRequestId) !== 1 ||
    !acceptedAudit
  ) {
    throw new Error("Client portability audit history is incomplete.");
  }
  if (
    input.evidence.sourceKind !== "agent" ||
    input.evidence.sourceRef !== input.codexProfileId
  ) {
    throw new Error("Client portability evidence attribution is invalid.");
  }
  if (
    input.relationship.fromRecordId !== input.evidence.id ||
    input.relationship.toRecordId !== input.taskId ||
    input.relationship.kind !== "evidenced_by"
  ) {
    throw new Error("Client portability evidence relationship is invalid.");
  }
};

interface AcceptanceArchive {
  readonly application: IntentArcApplication;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedRevisionBefore: number;
}

const requirePath = (
  value: string | undefined,
  label: string,
): string => {
  if (!value || !isAbsolute(value)) {
    throw new Error(`Client portability ${label} must be an absolute path.`);
  }
  return value;
};

const createProductionWorkspace = async (
  input: CreateWorkspaceInput,
): Promise<ClientPortabilityWorkspace> => {
  const archivePath = requirePath(input.archivePath, "archive path");
  const settingsRoot = requirePath(input.settingsRoot, "settings root");
  const acceptanceRoot = dirname(archivePath);
  const expectedRootName = `intentarc-client-portability-live-${input.runId}`;
  if (basename(settingsRoot).toLowerCase() !== "intentarc") {
    throw new Error("Client portability settings root must end in IntentArc.");
  }
  const settingsRelative = relative(acceptanceRoot, settingsRoot);
  if (
    basename(acceptanceRoot) !== expectedRootName ||
    settingsRelative === "" || settingsRelative === ".." ||
    settingsRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(settingsRelative)
  ) {
    throw new Error("Client portability paths must use the exact UUID-owned root.");
  }

  const application = createApplication({ databasePath: archivePath });
  try {
    const project = application.service.createProject({
      name: "Installed client portability acceptance",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Switch supported installed clients",
      body: "Prove governed context survives an installed client switch.",
      sourceKind: "human",
      sourceRef: null,
    });
    const baselineEvidence = application.service.createRecord({
      projectId: project.id,
      kind: "evidence",
      status: "accepted",
      title: "Installed client portability baseline",
      body: "The acceptance archive begins with retained evidence.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: baselineEvidence.id,
      toRecordId: task.id,
      kind: "evidenced_by",
      expectedProjectRevision: 2,
    });
    const vision = application.service.createRecord({
      projectId: project.id,
      kind: "vision",
      status: "accepted",
      title: "Stable installed-client intent",
      body: "Preserve governed project intent across every supported client.",
      sourceKind: "human",
      sourceRef: null,
    });
    const constraint = application.service.createRecord({
      projectId: project.id,
      kind: "constraint",
      status: "accepted",
      title: "Mandatory portability constraint",
      body: "MANDATORY: retain governed task context and never bypass release ownership.",
      sourceKind: "human",
      sourceRef: null,
    });
    const expectedRevisionBefore = application.service
      .getProjectSummary(project.id).project.revision;
    const codexCredentials = application.service.profiles.createProfile({
      name: "Installed Codex Safe",
      projectId: project.id,
      executionMode: "safe",
    });
    const claudeCredentials = application.service.profiles.createProfile({
      name: "Installed Claude Safe",
      projectId: project.id,
      executionMode: "safe",
    });
    application.service.destinations.set({
      profileId: codexCredentials.profile.id,
      clientLabel: "Installed Codex destination",
      type: "ide_managed",
      providerLabel: "Codex",
      modelLabel: "No provider invoked",
      accountBoundaryLabel: "Acceptance only",
      dataBoundary: "remote",
    });
    application.service.destinations.set({
      profileId: claudeCredentials.profile.id,
      clientLabel: "Installed Claude destination",
      type: "ide_managed",
      providerLabel: "Claude",
      modelLabel: "No provider invoked",
      accountBoundaryLabel: "Acceptance only",
      dataBoundary: "remote",
    });
    const timestamp = "2026-08-21T00:00:00.000Z";
    createDesktopSettingsStore(settingsRoot).write({
      schemaVersion: 2,
      archivePath,
      onboardingCompleted: true,
      connections: [{
        id: input.codexConnectionId,
        kind: "managed",
        adapterId: "codex",
        profileId: codexCredentials.profile.id,
        profileToken: codexCredentials.token,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, {
        id: input.claudeConnectionId,
        kind: "managed",
        adapterId: "claude-code",
        profileId: claudeCredentials.profile.id,
        profileToken: claudeCredentials.token,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    });
    const archive: AcceptanceArchive = {
      application,
      projectId: project.id,
      taskId: task.id,
      expectedRevisionBefore,
    };
    let closed = false;
    const closeApplication = async (): Promise<void> => {
      if (closed) return;
      application.close();
      closed = true;
    };
    return {
      archive,
      baselineEvidenceId: baselineEvidence.id,
      expectedTask: Object.freeze({ ...task }),
      expectedVision: Object.freeze({ ...vision }),
      expectedConstraint: Object.freeze({ ...constraint }),
      codexConnectionId: input.codexConnectionId,
      claudeConnectionId: input.claudeConnectionId,
      close: closeApplication,
    };
  } catch (error) {
    application.close();
    throw error;
  }
};

const callTool = async <Result extends object>(
  session: ClientPortabilitySupervisorSession,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Result> => {
  const result = await session.callTool<{
    readonly isError?: boolean;
    readonly structuredContent?: object;
  }>(name, arguments_, Date.now() + 25_000);
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error(`Client portability MCP call failed: ${name}.`);
  }
  return result.structuredContent as Result;
};

const asAcceptanceArchive = (value: unknown): AcceptanceArchive => {
  if (
    typeof value !== "object" || value === null ||
    !("application" in value) || !("projectId" in value) ||
    !("taskId" in value) || !("expectedRevisionBefore" in value)
  ) {
    throw new Error("Client portability archive boundary is invalid.");
  }
  return value as AcceptanceArchive;
};

const runProductionSemanticJourney = async (
  input: RunSemanticJourneyInput,
): Promise<ClientPortabilityJourneyResult> => {
  const archive = asAcceptanceArchive(input.archive);
  const codex = input.codexSession;
  const claude = input.claudeSession;
  if (codex === claude) {
    throw new Error("Client portability requires independent bridge sessions.");
  }
  const { service } = archive.application;
  const before = await callTool<ProjectSummary>(codex, "get_project_summary", {
    projectId: archive.projectId,
  });
  if (
    archive.expectedRevisionBefore !== 5 ||
    before.project.revision !== archive.expectedRevisionBefore ||
    before.recordsByKind.task !== 1 ||
    before.recordsByKind.evidence !== 1 ||
    before.recordsByKind.vision !== 1 ||
    before.recordsByKind.constraint !== 1 ||
    before.activeTasks.length !== 1 ||
    before.activeTasks[0]?.id !== input.expectedTask.id ||
    before.activeTasks[0]?.title !== input.expectedTask.title ||
    before.activeTasks[0]?.status !== input.expectedTask.status
  ) {
    throw new Error("Client portability baseline revision is invalid.");
  }
  const requested = requestTaskContextResultSchema.parse(
    await callTool(codex, "request_task_context", {
      projectId: archive.projectId,
      taskId: archive.taskId,
      budgetTokens: 4000,
      idempotencyKey: "installed-codex-portability-release",
    }),
  );
  const submitted = await callTool<ChangeSubmissionResult>(
    codex,
    "submit_change_set",
    {
      projectId: archive.projectId,
      sourceTaskId: archive.taskId,
      baseProjectRevision: before.project.revision,
      idempotencyKey: "installed-codex-portability-evidence",
      rationale: "Attach installed client-A portability evidence.",
      operations: [{
        operationId: "create-installed-portability-evidence",
        type: "create_record",
        localRef: "installed-portability-evidence",
        kind: "evidence",
        status: "accepted",
        title: "Installed client A portability evidence",
        body: "Codex attached governed evidence for the installed client switch.",
      }, {
        operationId: "link-installed-portability-evidence",
        type: "create_relationship",
        from: { localRef: "installed-portability-evidence" },
        to: { recordId: archive.taskId },
        kind: "evidenced_by",
      }],
    },
  );
  if (submitted.outcome !== "proposed") {
    throw new Error("Client portability evidence proposal was not created.");
  }
  const codexApproved = service.outbound.approve({
    requestId: requested.requestId,
    rememberClean: false,
    includeFindingIds: [],
  });
  const codexReleased = getReleasedContextResultSchema.parse(
    await callTool(codex, "get_released_context", {
      requestId: requested.requestId,
    }),
  );
  if (
    codexReleased.status !== "released" ||
    JSON.stringify(codexReleased.release) !== JSON.stringify(codexApproved)
  ) {
    throw new Error("Codex profile-owned release is invalid.");
  }
  const codexRelease: OutboundRelease = codexReleased.release;

  const crossProfileRead = await claude.callTool<{
    readonly isError?: boolean;
    readonly structuredContent?: object;
    readonly content?: unknown;
  }>(
    "get_released_context",
    { requestId: requested.requestId },
    Date.now() + 25_000,
  );
  if (
    crossProfileRead.isError !== true ||
    crossProfileRead.structuredContent !== undefined ||
    JSON.stringify(crossProfileRead.content) !== JSON.stringify([
      { type: "text", text: "outbound_release_invalid" },
    ])
  ) {
    throw new Error("Cross-profile release ownership was not enforced.");
  }

  const accepted = service.proposals.accept(submitted.proposalId);
  if (
    accepted.outcome !== "applied" ||
    accepted.projectRevision !== 6
  ) {
    throw new Error("Client portability proposal was not accepted once.");
  }
  const evidenceOperation = accepted.operations.find(
    (operation) =>
      operation.operationId === "create-installed-portability-evidence" &&
      operation.type === "create_record",
  );
  const relationshipOperation = accepted.operations.find(
    (operation) =>
      operation.operationId === "link-installed-portability-evidence" &&
      operation.type === "create_relationship",
  );
  if (
    !evidenceOperation || evidenceOperation.type !== "create_record" ||
    !relationshipOperation || relationshipOperation.type !== "create_relationship"
  ) {
    throw new Error("Client portability evidence was not retained.");
  }

  const after = await callTool<ProjectSummary>(claude, "get_project_summary", {
    projectId: archive.projectId,
  });
  if (
    after.project.revision !== 6 ||
    after.recordsByKind.task !== 1 ||
    after.recordsByKind.evidence !== 2 ||
    after.recordsByKind.vision !== 1 ||
    after.recordsByKind.constraint !== 1 ||
    after.activeTasks.length !== 1 ||
    after.activeTasks[0]?.id !== input.expectedTask.id ||
    after.activeTasks[0]?.title !== input.expectedTask.title ||
    after.activeTasks[0]?.status !== input.expectedTask.status
  ) {
    throw new Error("Claude did not observe the accepted archive revision.");
  }
  const claudeRequested = requestTaskContextResultSchema.parse(
    await callTool(claude, "request_task_context", {
      projectId: archive.projectId,
      taskId: archive.taskId,
      budgetTokens: 4000,
      idempotencyKey: "installed-claude-portability-release",
    }),
  );
  const claudeApproved = service.outbound.approve({
    requestId: claudeRequested.requestId,
    rememberClean: false,
    includeFindingIds: [],
  });
  const claudeReleased = getReleasedContextResultSchema.parse(
    await callTool(claude, "get_released_context", {
      requestId: claudeRequested.requestId,
    }),
  );
  if (
    claudeReleased.status !== "released" ||
    JSON.stringify(claudeReleased.release) !== JSON.stringify(claudeApproved) ||
    claudeReleased.release.releaseId === codexRelease.releaseId ||
    claudeReleased.release.pack.projectRevision !== 6 ||
    !claudeReleased.release.pack.related.some(
      ({ record, relationshipKind }) =>
        record.id === evidenceOperation.record.id &&
        relationshipKind === "evidenced_by",
    )
  ) {
    throw new Error("Claude profile-owned release is invalid.");
  }

  const codexReleasedAgain = getReleasedContextResultSchema.parse(
    await callTool(codex, "get_released_context", {
      requestId: requested.requestId,
    }),
  );
  if (
    codexReleasedAgain.status !== "released" ||
    JSON.stringify(codexReleasedAgain.release) !== JSON.stringify(codexRelease)
  ) {
    throw new Error("Codex immutable release was not retained.");
  }
  const releases = service.outbound.list({});
  const audit = service.listAuditEvents({ projectId: archive.projectId, limit: 100 });
  verifyClientPortabilityEvidence({
    projectId: archive.projectId,
    taskId: archive.taskId,
    revisionBefore: before.project.revision,
    revisionAfter: after.project.revision,
    codexProfileId: requested.profileId,
    claudeProfileId: claudeRequested.profileId,
    codexRequestId: requested.requestId,
    claudeRequestId: claudeRequested.requestId,
    proposalId: submitted.proposalId,
    baselineEvidenceId: input.baselineEvidenceId,
    expectedTask: input.expectedTask,
    expectedVision: input.expectedVision,
    expectedConstraint: input.expectedConstraint,
    evidence: evidenceOperation.record,
    relationship: relationshipOperation.relationship,
    packs: {
      codex: codexRelease.pack,
      claude: claudeReleased.release.pack,
    },
    releases,
    audits: audit,
  });

  return {
    revisionBefore: before.project.revision,
    revisionAfter: after.project.revision,
    releaseIds: {
      codex: codexRelease.releaseId,
      claude: claudeReleased.release.releaseId,
    },
    requestIds: {
      codex: requested.requestId,
      claude: claudeRequested.requestId,
    },
    evidenceId: evidenceOperation.record.id,
    proposalId: submitted.proposalId,
    counts: {
      releases: releases.length,
      auditEvents: audit.length,
    },
  };
};

const createProductionBridgeSession = (
  input: CreateBridgeSessionInput,
): ClientPortabilitySupervisorSession => {
  const settingsRoot = requirePath(input.settingsRoot, "settings root");
  const bridgeExecutable = requirePath(input.bridgeExecutable, "bridge executable");
  const archivePath = requirePath(input.archivePath, "archive path");
  const acceptanceRoot = dirname(archivePath);
  return createClientPortabilitySupervisorSession({
    repositoryRoot: resolve("."),
    supervisorBundle: resolve(
      "dist",
      "test-support",
      "client-portability-session-supervisor.mjs",
    ),
    clientKind: input.client,
    forceSettlementTimeoutMs: input.forceSettlementTimeoutMs,
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
};

const productionDependencies: ClientPortabilityAcceptanceDependencies = {
  uuid: randomUUID,
  createAdapters: ({ codexServerName, claudeServerName }) => {
    const runner = createCommandRunner();
    return {
      codex: createCodexAdapter({ runner, serverName: codexServerName }),
      claude: createClaudeCodeAdapter({ runner, serverName: claudeServerName }),
    };
  },
  createWorkspace: createProductionWorkspace,
  createBridgeSession: createProductionBridgeSession,
  runSemanticJourney: runProductionSemanticJourney,
  resolveBridgeExecutable: () =>
    resolve("dist", "bridge", "IntentArc Bridge.exe"),
  finalizeCleanup: finalizeClientPortabilityCleanup,
  now: Date.now,
  operationTimeoutMs: 25_000,
  teardownTimeoutMs: 2_000,
  forceTeardownTimeoutMs: 25_000,
  settlementTimeoutMs: 5_000,
};

const validateRunId = (value: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("Client portability run ID must be a UUID.");
  }
  return value.toLowerCase();
};

const preservedRoot = (): PortabilityCleanupResult => Object.freeze({
  status: "preserved" as const,
  category: "root" as const,
  receiptPath: null,
  recoveryCommand: null,
});

const emptyResult = (
  runId: string,
  serverNames: Readonly<Record<ClientKind, string>>,
  outcomeCategory: Exclude<ClientPortabilityOutcomeCategory, "passed">,
  versions: Readonly<Record<ClientKind, string | null>> = {
    codex: null,
    claude: null,
  },
): ClientPortabilityAcceptanceResult => ({
  status: "BLOCKED",
  outcomeCategory,
  recoveryCommands: [],
  runId,
  clientVersions: versions,
  serverNames,
  revisionBefore: null,
  revisionAfter: null,
  releaseIds: { codex: null, claude: null },
  requestIds: { codex: null, claude: null },
  evidenceId: null,
  proposalId: null,
  counts: {
    releases: 0,
    auditEvents: 0,
    configurationFailures: 0,
    journeyFailures: 0,
    teardownFailures: 0,
    gracefulTeardownFailures: 0,
    forcedTeardownFailures: 0,
    settlementFailures: 0,
    workspaceFailures: 0,
    rootPreservationFailures: 1,
    cleanupFailures: 0,
  },
  resourcesSettled: false,
  cleanup: { codex: "not_required", claude: "not_required" },
  rootCleanup: preservedRoot(),
});

const isReady = (detection: AiAdapterDetection): boolean =>
  detection.availability === "ready" && detection.version !== null;

export const runClientPortabilityAcceptance = async (
  input: ClientPortabilityAcceptanceInput,
  dependencies: ClientPortabilityAcceptanceDependencies = productionDependencies,
): Promise<ClientPortabilityAcceptanceResult> => {
  const runId = validateRunId(input.runId ?? dependencies.uuid());
  const serverNames = {
    codex: `intentarc-acceptance-codex-${runId}`,
    claude: `intentarc-acceptance-claude-${runId}`,
  } as const;
  const connectionIds = {
    codex: `intentarc-acceptance-codex-connection-${runId}`,
    claude: `intentarc-acceptance-claude-connection-${runId}`,
  } as const;
  const adapters = dependencies.createAdapters({
    codexServerName: serverNames.codex,
    claudeServerName: serverNames.claude,
  });

  let detections: readonly [AiAdapterDetection, AiAdapterDetection];
  try {
    detections = await Promise.all([adapters.codex.detect(), adapters.claude.detect()]);
  } catch {
    return emptyResult(runId, serverNames, "client_not_ready");
  }
  const versions = { codex: detections[0].version, claude: detections[1].version };
  if (!detections.every(isReady)) {
    return emptyResult(runId, serverNames, "client_not_ready", versions);
  }
  try {
    const inspections = await Promise.all([adapters.codex.inspect(), adapters.claude.inspect()]);
    if (inspections.some((status) => status !== "not_connected")) {
      return emptyResult(
        runId,
        serverNames,
        "exact_name_collision_or_ambiguous",
        versions,
      );
    }
  } catch {
    return emptyResult(
      runId,
      serverNames,
      "exact_name_collision_or_ambiguous",
      versions,
    );
  }

  let mutationAttempted = false;
  let configurationSucceeded = false;
  let workspace: ClientPortabilityWorkspace | undefined;
  let codexSession: ClientPortabilitySupervisorSession | undefined;
  let claudeSession: ClientPortabilitySupervisorSession | undefined;
  let journey: ClientPortabilityJourneyResult | undefined;
  let configurationFailures = 0;
  let journeyFailures = 0;
  let gracefulTeardownFailures = 0;
  let forcedTeardownFailures = 0;
  let settlementFailures = 0;
  let workspaceFailures = 0;
  let cleanupFailures = 0;
  const cleanup: Record<ClientKind, CleanupStatus> = {
    codex: "not_required",
    claude: "not_required",
  };
  let bridgeExecutable = "";

  try {
    bridgeExecutable = input.bridgeExecutable ?? dependencies.resolveBridgeExecutable();
    const codexAttempt = await adapters.codex.prepareConnection({
      bridgeExecutable,
      connectionId: connectionIds.codex,
    });
    mutationAttempted = true;
    await codexAttempt.apply();
    const claudeAttempt = await adapters.claude.prepareConnection({
      bridgeExecutable,
      connectionId: connectionIds.claude,
    });
    await claudeAttempt.apply();
    configurationSucceeded = true;
  } catch {
    configurationFailures += 1;
  }

  if (configurationSucceeded) {
    try {
      workspace = await dependencies.createWorkspace({
        ...input,
        runId,
        codexConnectionId: connectionIds.codex,
        claudeConnectionId: connectionIds.claude,
      });
    } catch {
      journeyFailures += 1;
    }
    if (workspace !== undefined) {
      const sessionInputs = {
        codex: {
          ...input,
          client: "codex" as const,
          connectionId: workspace.codexConnectionId,
          bridgeExecutable,
          forceSettlementTimeoutMs: dependencies.forceTeardownTimeoutMs,
        },
        claude: {
          ...input,
          client: "claude" as const,
          connectionId: workspace.claudeConnectionId,
          bridgeExecutable,
          forceSettlementTimeoutMs: dependencies.forceTeardownTimeoutMs,
        },
      };
      try {
        codexSession = dependencies.createBridgeSession(sessionInputs.codex);
      } catch {
        journeyFailures += 1;
      }
      try {
        claudeSession = dependencies.createBridgeSession(sessionInputs.claude);
      } catch {
        journeyFailures += 1;
      }
      if (codexSession !== undefined && claudeSession !== undefined) {
        const settingsRoot = input.settingsRoot ?? resolve(
          `intentarc-client-portability-live-${runId}`,
          "Roaming",
          "IntentArc",
        );
        const connectDeadline = dependencies.now() + dependencies.operationTimeoutMs;
        const connectionOutcomes = await Promise.allSettled([
          Promise.resolve().then(() => codexSession!.connect({
            bridgeExecutable,
            connectionId: workspace!.codexConnectionId,
            settingsRoot,
          }, connectDeadline)),
          Promise.resolve().then(() => claudeSession!.connect({
            bridgeExecutable,
            connectionId: workspace!.claudeConnectionId,
            settingsRoot,
          }, connectDeadline)),
        ]);
        if (connectionOutcomes.some((outcome) => outcome.status === "rejected")) {
          journeyFailures += 1;
        } else {
          try {
            journey = await dependencies.runSemanticJourney({
              archive: workspace.archive,
              baselineEvidenceId: workspace.baselineEvidenceId,
              expectedTask: workspace.expectedTask,
              expectedVision: workspace.expectedVision,
              expectedConstraint: workspace.expectedConstraint,
              codexSession,
              claudeSession,
            });
          } catch {
            journeyFailures += 1;
          }
        }
      }
    }
  }

  const ownedSessions = [codexSession, claudeSession] as const;
  const closeDeadline = dependencies.now() + dependencies.teardownTimeoutMs;
  const closeOutcomes = await Promise.allSettled(ownedSessions.map((session) =>
    session === undefined
      ? Promise.resolve()
      : Promise.resolve().then(() => session.close(closeDeadline))
  ));
  gracefulTeardownFailures = closeOutcomes.filter((outcome, index) =>
    ownedSessions[index] !== undefined && outcome.status === "rejected"
  ).length;

  const settlementDeadline = dependencies.now() + dependencies.settlementTimeoutMs;
  const settlementOutcomes = await Promise.allSettled(ownedSessions.map((session) =>
    session === undefined
      ? Promise.resolve<SupervisorSettlementResult>(Object.freeze({
          status: "settled" as const,
          category: "none" as const,
          retained: Object.freeze([]),
        }))
      : Promise.resolve().then(() => session.settle(settlementDeadline))
  ));
  const sessions = settlementOutcomes.map((outcome): SupervisorSettlementResult =>
    outcome.status === "fulfilled"
      ? outcome.value
      : Object.freeze({
          status: "blocked" as const,
          category: "observation" as const,
          retained: Object.freeze([]),
        })
  );
  forcedTeardownFailures = settlementOutcomes.filter((outcome, index) =>
    ownedSessions[index] !== undefined && outcome.status === "rejected"
  ).length;
  settlementFailures = settlementOutcomes.filter((outcome, index) =>
    ownedSessions[index] !== undefined &&
    (outcome.status === "rejected" || outcome.value.status !== "settled")
  ).length;
  const requestsDrained = settlementOutcomes.every((outcome) => outcome.status === "fulfilled");

  let workspaceClosed = workspace === undefined;
  if (workspace !== undefined) {
    try {
      await workspace.close();
      workspaceClosed = true;
    } catch {
      workspaceFailures = 1;
      workspaceClosed = false;
    }
  }

  if (mutationAttempted) {
    for (const [client, adapter] of [
      ["claude", adapters.claude],
      ["codex", adapters.codex],
    ] as const) {
      try {
        await adapter.remove();
      } catch {
        cleanup[client] = "failed";
        cleanupFailures += 1;
      }
    }
    const postCleanupReady: Record<ClientKind, boolean> = { codex: false, claude: false };
    try {
      const postCleanupDetections = await Promise.all([
        adapters.codex.detect(),
        adapters.claude.detect(),
      ]);
      postCleanupReady.codex = isReady(postCleanupDetections[0]);
      postCleanupReady.claude = isReady(postCleanupDetections[1]);
    } catch {
      // Exact inspection still runs for both names below.
    }
    for (const [client, adapter] of [
      ["claude", adapters.claude],
      ["codex", adapters.codex],
    ] as const) {
      try {
        const status = await adapter.inspect();
        if (
          postCleanupReady[client] && status === "not_connected" && cleanup[client] !== "failed"
        ) {
          cleanup[client] = "absent";
        } else {
          if (cleanup[client] !== "failed") cleanupFailures += 1;
          cleanup[client] = "failed";
        }
      } catch {
        if (cleanup[client] !== "failed") cleanupFailures += 1;
        cleanup[client] = "failed";
      }
    }
  }
  const configurationAbsent = !mutationAttempted || (
    cleanup.codex === "absent" && cleanup.claude === "absent"
  );
  const root = input.archivePath === undefined
    ? resolve(`intentarc-client-portability-live-${runId}`)
    : dirname(input.archivePath);
  let rootCleanup: PortabilityCleanupResult;
  try {
    rootCleanup = await dependencies.finalizeCleanup({
      runId,
      root,
      temporaryParent: dirname(root),
      sessions,
      requestsDrained,
      workspaceClosed,
      configurationAbsent,
    });
  } catch {
    rootCleanup = preservedRoot();
  }
  const rootPreservationFailures = rootCleanup.status === "removed" ? 0 : 1;
  const resourcesSettled =
    sessions.every((session) => session.status === "settled") &&
    requestsDrained &&
    workspaceClosed &&
    configurationAbsent &&
    rootCleanup.status === "removed";
  const teardownFailures =
    gracefulTeardownFailures + forcedTeardownFailures + settlementFailures + workspaceFailures;
  const recoveryCommands: ClientPortabilityRecoveryCommand[] = [
    ...(cleanup.codex === "failed"
      ? [{ client: "codex" as const, command: `codex mcp remove ${serverNames.codex}` }]
      : []),
    ...(cleanup.claude === "failed"
      ? [{
          client: "claude" as const,
          command: `claude mcp remove --scope user ${serverNames.claude}`,
        }]
      : []),
  ];
  const passed =
    journey !== undefined &&
    configurationFailures === 0 &&
    journeyFailures === 0 &&
    teardownFailures === 0 &&
    cleanupFailures === 0 &&
    rootPreservationFailures === 0 &&
    resourcesSettled;
  const outcomeCategory: ClientPortabilityOutcomeCategory = passed
    ? "passed"
    : cleanupFailures > 0
      ? "exact_name_cleanup_failure"
      : rootCleanup.status !== "removed" && teardownFailures === 0
        ? "root_cleanup_failure"
        : teardownFailures > 0
          ? "teardown_failure"
          : journeyFailures > 0
            ? "bridge_or_journey_failure"
            : "configuration_failure";

  return {
    status: passed ? "PASS" : "BLOCKED",
    outcomeCategory,
    recoveryCommands,
    runId,
    clientVersions: versions,
    serverNames,
    revisionBefore: journey?.revisionBefore ?? null,
    revisionAfter: journey?.revisionAfter ?? null,
    releaseIds: journey?.releaseIds ?? { codex: null, claude: null },
    requestIds: journey?.requestIds ?? { codex: null, claude: null },
    evidenceId: journey?.evidenceId ?? null,
    proposalId: journey?.proposalId ?? null,
    counts: {
      releases: journey?.counts.releases ?? 0,
      auditEvents: journey?.counts.auditEvents ?? 0,
      configurationFailures,
      journeyFailures,
      teardownFailures,
      gracefulTeardownFailures,
      forcedTeardownFailures,
      settlementFailures,
      workspaceFailures,
      rootPreservationFailures,
      cleanupFailures,
    },
    resourcesSettled,
    cleanup,
    rootCleanup,
  };
};
