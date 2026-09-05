import type {
  AcceptDelegationInput,
  CheckpointClaimInput,
  CheckpointResult,
  ClaimTaskInput,
  ClaimTaskResult,
  CoordinationState,
  CoordinationStateInput,
  CreateDelegationInput,
  DelegationResult,
  ListReadyTasksInput,
  ReadyTaskPage,
  RenewClaimInput,
  RenewClaimResult,
  RevokeDelegationInput,
  SubmissionResult,
  SubmitTaskResultInput,
  SwitchTaskInput,
  SwitchTaskResult,
  TaskClaim,
  TaskDelegation,
  TransitionClaimInput,
  TransitionClaimResult,
} from "./coordination-model.js";
import {
  coordinationEventReferencesAreApplicable,
  hasExactCoordinationEventTransition,
  selectedCheckpointHistoryIsCoherent,
  selectedClaimHistoryIsCoherent,
  selectedDelegationHistoryIsCoherent,
  selectedSubmissionHistoryIsCoherent,
  taskClaimLifecycleIsCoherent,
  taskDelegationLifecycleIsCoherent,
} from "./coordination-semantics.js";

const exactJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const claimMatches = (
  claim: { id: string; projectId: string; taskId: string; profileId: string },
  expected: { claimId?: string; projectId?: string; taskId?: string; profileId: string },
): boolean =>
  (expected.claimId === undefined || claim.id === expected.claimId) &&
  (expected.projectId === undefined || claim.projectId === expected.projectId) &&
  (expected.taskId === undefined || claim.taskId === expected.taskId) &&
  claim.profileId === expected.profileId;

const activeClaimSemanticsMatch = (
  claim: { state: string; endedAt: string | null },
): boolean => claim.state === "active" && claim.endedAt === null;

const terminalClaimState = (action: "pause" | "release"): "paused" | "released" =>
  action === "pause" ? "paused" : "released";

const checkpointDocumentMatches = (
  checkpoint: CheckpointResult["checkpoint"],
  document: CheckpointClaimInput["checkpoint"],
): boolean => exactJson({
  summary: checkpoint.summary,
  completedWork: checkpoint.completedWork,
  remainingWork: checkpoint.remainingWork,
  blockers: checkpoint.blockers,
  verificationEvidence: checkpoint.verificationEvidence,
  repositoryEvidence: checkpoint.repositoryEvidence,
}, document);

const contextMatches = (
  context: ClaimTaskResult["contextPack"],
  expected: {
    projectId: string;
    taskId: string;
    projectRevision: number;
    taskRevision: number;
    budgetTokens: number;
  },
): boolean => {
  const includedItems = [...context.stableFrame, context.task, ...context.related];
  const expectedSourceRevisions = includedItems
    .map(({ record }) => ({ recordId: record.id, revision: record.revision }))
    .sort((left, right) => left.recordId < right.recordId ? -1 :
      left.recordId > right.recordId ? 1 : 0);
  const includedIds = new Set(includedItems.map(({ record }) => record.id));
  const omissionIds = new Set(context.omissions.map(({ recordId }) => recordId));

  return context.projectId === expected.projectId &&
    context.taskId === expected.taskId &&
    context.projectRevision === expected.projectRevision &&
    context.budgetTokens === expected.budgetTokens &&
    context.task.mandatory && context.task.relevance === "active_task" &&
    context.task.relationshipKind === null &&
    context.task.record.projectId === expected.projectId &&
    context.task.record.id === expected.taskId &&
    context.task.record.revision === expected.taskRevision &&
    context.stableFrame.every(({ record, mandatory, relevance, relationshipKind }) =>
      record.projectId === expected.projectId && mandatory &&
      relevance === "stable_frame" && relationshipKind === null) &&
    context.related.every(({ record, mandatory, relevance, relationshipKind }) =>
      record.projectId === expected.projectId && !mandatory &&
      relevance === "linked" && relationshipKind !== null) &&
    includedIds.size === includedItems.length &&
    omissionIds.size === context.omissions.length &&
    context.omissions.every(({ recordId, retrievalRef }) =>
      !includedIds.has(recordId) &&
      retrievalRef === `intentarc://projects/${expected.projectId}/records/${recordId}`) &&
    exactJson(context.sourceRevisions, expectedSourceRevisions);
};

const canonicalTimestamp = (value: string): string | null => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const timestampsMatch = (left: string, right: string): boolean => {
  const canonicalLeft = canonicalTimestamp(left);
  return canonicalLeft !== null && canonicalLeft === canonicalTimestamp(right);
};

const immutableDelegationMatches = (
  output: TaskDelegation,
  expected: TaskDelegation,
): boolean => output.id === expected.id && output.projectId === expected.projectId &&
  output.taskId === expected.taskId &&
  output.parentProfileId === expected.parentProfileId &&
  output.childProfileId === expected.childProfileId &&
  output.baseProjectRevision === expected.baseProjectRevision &&
  output.baseTaskRevision === expected.baseTaskRevision &&
  exactJson(output.scope, expected.scope) &&
  exactJson(output.allowedOutputs, expected.allowedOutputs) &&
  timestampsMatch(output.offeredAt, expected.offeredAt) &&
  timestampsMatch(output.deadline, expected.deadline);

const immutableClaimMatches = (output: TaskClaim, expected: TaskClaim): boolean =>
  output.id === expected.id && output.projectId === expected.projectId &&
  output.taskId === expected.taskId && output.profileId === expected.profileId &&
  output.delegationId === expected.delegationId &&
  output.baseProjectRevision === expected.baseProjectRevision &&
  output.baseTaskRevision === expected.baseTaskRevision &&
  output.contextPackId === expected.contextPackId &&
  timestampsMatch(output.acquiredAt, expected.acquiredAt) &&
  timestampsMatch(output.absoluteExpiresAt, expected.absoluteExpiresAt);

export const readyTaskPageMatches = (
  output: ReadyTaskPage,
  input: Pick<ListReadyTasksInput,
    "projectId" | "expectedProjectRevision" | "cursor" | "limit">,
): boolean => output.projectRevision === input.expectedProjectRevision &&
  output.tasks.length <= input.limit &&
  new Set(output.tasks.map(({ task }) => task.id)).size === output.tasks.length &&
  (output.nextCursor === null || (output.tasks.length === input.limit &&
    output.nextCursor !== input.cursor)) &&
  output.tasks.every(({ task, blockers, liveClaimId, liveDelegationId }) =>
    task.projectId === input.projectId && task.kind === "task" && task.status === "active" &&
    (liveClaimId === null
      ? !blockers.some((blocker) => blocker.startsWith("claim_"))
      : blockers.some((blocker) => blocker.startsWith("claim_") && blocker.endsWith(`:${liveClaimId}`))) &&
    (liveDelegationId === null
      ? !blockers.some((blocker) => blocker.startsWith("delegation_live:"))
      : blockers.includes(`delegation_live:${liveDelegationId}`)));

export const coordinationStateMatches = (
  output: CoordinationState,
  input: Pick<CoordinationStateInput, "projectId" | "taskId" | "expectedProjectRevision">,
): boolean => {
  const claimAndDelegationAreLinked = output.claim !== null && output.delegation !== null &&
    (output.claim.delegationId === output.delegation.id ||
      output.delegation.claimId === output.claim.id ||
      output.delegation.state === "claimed" || output.delegation.state === "completed");
  const linkedTupleIsCoherent = !claimAndDelegationAreLinked ||
    (output.claim!.delegationId === output.delegation!.id &&
      output.delegation!.claimId === output.claim!.id &&
      output.claim!.profileId === output.delegation!.childProfileId &&
      (output.delegation!.state !== "completed" || output.claim!.state === "reconciled"));
  const requiredSelectedClaimIsPresent = output.delegation === null ||
    (output.delegation.state !== "claimed" && output.delegation.state !== "completed") ||
    (output.claim !== null && output.claim.id === output.delegation.claimId &&
      output.claim.delegationId === output.delegation.id);
  const checkpointIsCoherent = output.claim === null
    ? output.latestCheckpoint === null
    : output.claim.latestCheckpointId === (output.latestCheckpoint?.id ?? null) &&
      (output.latestCheckpoint === null || (
        output.latestCheckpoint.claimId === output.claim.id &&
        output.latestCheckpoint.contextPackId === output.claim.contextPackId));
  const submissionIsCoherent = (() => {
    if (output.claim === null) return output.submission === null;
    const linked = output.submission === null || (output.latestCheckpoint !== null &&
      output.submission.projectId === input.projectId &&
      output.submission.taskId === input.taskId &&
      output.submission.claimId === output.claim.id &&
      output.submission.profileId === output.claim.profileId &&
      output.submission.contextPackId === output.claim.contextPackId &&
      output.submission.checkpointId === output.latestCheckpoint.id &&
      output.events.some((event) => event.submissionId === output.submission!.id &&
        event.proposalId === output.submission!.proposalId));
    if (!linked) return false;
    switch (output.claim.state) {
      case "submitted":
        return output.submission !== null && [
          "submitted", "conflicted", "rejected", "withdrawn",
        ].includes(output.submission.state);
      case "reconciled":
        return output.submission?.state === "accepted";
      case "released":
        return output.submission === null || ["conflicted", "rejected", "withdrawn"]
          .includes(output.submission.state);
      default:
        return output.submission === null;
    }
  })();
  const eventsAreCoherent = output.events.every((event) => {
    if (event.projectId !== input.projectId || event.taskId !== input.taskId ||
      !hasExactCoordinationEventTransition(
        event.category,
        event.priorState,
        event.resultingState,
      ) || !coordinationEventReferencesAreApplicable(event)) return false;
    if (event.profileId === null && event.category !== "ready_evaluation") return false;
    if (event.category === "ready_evaluation" && event.profileId !== null) return false;
    if (output.claim !== null && event.claimId === output.claim.id &&
      event.profileId !== output.claim.profileId) return false;
    if (output.claim !== null && event.claimId === output.claim.id) {
      const requiredClaimState = {
        pause: "paused",
        release: "released",
        expiry: "expired",
        reconciliation: "reconciled",
      } as const;
      if (event.category in requiredClaimState &&
        output.claim.state !== requiredClaimState[
          event.category as keyof typeof requiredClaimState
        ]) return false;
    }
    if (output.latestCheckpoint !== null && event.checkpointId === output.latestCheckpoint.id &&
      event.claimId !== output.claim?.id) return false;
    if (output.submission !== null && (event.submissionId === output.submission.id ||
      event.proposalId === output.submission.proposalId) &&
      (event.claimId !== output.claim?.id ||
        event.checkpointId !== output.latestCheckpoint?.id ||
        event.submissionId !== output.submission.id ||
        event.proposalId !== output.submission.proposalId)) return false;
    if (output.delegation !== null && event.delegationId === output.delegation.id &&
      event.claimId !== null && event.claimId !== output.delegation.claimId) return false;
    if (output.delegation !== null && event.delegationId === output.delegation.id) {
      if (event.claimId === null) {
        const expectedActor = event.category === "delegation_offer" ||
          event.category === "delegation_revoke"
          ? output.delegation.parentProfileId
          : output.delegation.childProfileId;
        if (event.profileId !== expectedActor) return false;
      }
      if (event.category === "delegation_revoke" && output.delegation.state !== "revoked") {
        return false;
      }
      if (event.category === "expiry" && event.claimId === null &&
        output.delegation.state !== "expired") return false;
    }
    if (output.submission !== null && event.submissionId === output.submission.id) {
      if (event.category === "conflict" && output.submission.state !== "conflicted") {
        return false;
      }
      if (event.category === "reconciliation" && output.submission.state !== "accepted") {
        return false;
      }
    }
    return true;
  });
  const selectedHistoryIsCoherent =
    (output.claim === null || selectedClaimHistoryIsCoherent(
      output.claim,
      output.submission,
      output.events,
    )) &&
    (output.delegation === null || selectedDelegationHistoryIsCoherent(
      output.delegation,
      output.events,
      output.claim?.id === output.delegation.claimId ? output.claim : null,
      output.claim?.id === output.delegation.claimId ? output.submission : null,
    )) &&
    (output.latestCheckpoint === null || (output.claim !== null &&
      selectedCheckpointHistoryIsCoherent(
        output.latestCheckpoint,
        output.claim,
        output.events,
      ))) &&
    (output.submission === null || selectedSubmissionHistoryIsCoherent(
      output.submission,
      output.events,
    ));

  return output.projectRevision === input.expectedProjectRevision &&
  output.task.projectId === input.projectId && output.task.id === input.taskId &&
  output.task.kind === "task" &&
  (output.claim === null || (output.claim.projectId === input.projectId &&
    output.claim.taskId === input.taskId && taskClaimLifecycleIsCoherent(output.claim))) &&
  (output.delegation === null || (output.delegation.projectId === input.projectId &&
    output.delegation.taskId === input.taskId &&
    taskDelegationLifecycleIsCoherent(output.delegation))) &&
  linkedTupleIsCoherent && requiredSelectedClaimIsPresent && checkpointIsCoherent &&
  submissionIsCoherent &&
  eventsAreCoherent && selectedHistoryIsCoherent;
};

export const claimTaskResultMatches = (
  output: ClaimTaskResult,
  input: ClaimTaskInput,
  profileId: string,
): boolean =>
  claimMatches(output.claim, { projectId: input.projectId, taskId: input.taskId, profileId }) &&
  activeClaimSemanticsMatch(output.claim) && output.claim.latestCheckpointId === null &&
  output.claim.baseProjectRevision === input.expectedProjectRevision &&
  output.claim.baseTaskRevision === input.expectedTaskRevision &&
  output.claim.delegationId === input.acceptedDelegationId &&
  output.readiness.task.projectId === input.projectId &&
  output.readiness.task.id === input.taskId &&
  output.readiness.task.revision === input.expectedTaskRevision &&
  output.readiness.task.kind === "task" && output.readiness.task.status === "active" &&
  output.readiness.blockers.length === 0 && output.readiness.liveClaimId === null &&
  output.readiness.liveDelegationId === input.acceptedDelegationId &&
  contextMatches(output.contextPack, {
    projectId: input.projectId,
    taskId: input.taskId,
    projectRevision: input.expectedProjectRevision,
    taskRevision: input.expectedTaskRevision,
    budgetTokens: input.contextBudgetTokens,
  }) &&
  output.contextPack.id === output.claim.contextPackId &&
  exactJson(output.contextPack.task.record, output.readiness.task);

export const renewClaimResultMatches = (
  output: RenewClaimResult,
  input: RenewClaimInput,
  profileId: string,
  expected: TaskClaim,
): boolean => claimMatches(output.claim, {
  claimId: input.claimId,
  projectId: expected.projectId,
  taskId: expected.taskId,
  profileId,
}) && immutableClaimMatches(output.claim, expected) && activeClaimSemanticsMatch(output.claim);

export const checkpointResultMatches = (
  output: CheckpointResult,
  input: CheckpointClaimInput,
  profileId: string,
  expected: TaskClaim,
): boolean => claimMatches(output.claim, {
  claimId: input.claimId,
  projectId: expected.projectId,
  taskId: expected.taskId,
  profileId,
}) &&
  immutableClaimMatches(output.claim, expected) && activeClaimSemanticsMatch(output.claim) &&
  output.checkpoint.claimId === input.claimId &&
  output.claim.latestCheckpointId === output.checkpoint.id &&
  output.checkpoint.contextPackId === output.claim.contextPackId &&
  checkpointDocumentMatches(output.checkpoint, input.checkpoint) &&
  output.checkpoint.projectRevision === input.expectedProjectRevision &&
  output.checkpoint.taskRevision === input.expectedTaskRevision;

export const transitionClaimResultMatches = (
  output: TransitionClaimResult,
  input: TransitionClaimInput,
  profileId: string,
  expected: TaskClaim,
): boolean => claimMatches(output.claim, {
  claimId: input.claimId,
  projectId: expected.projectId,
  taskId: expected.taskId,
  profileId,
}) && immutableClaimMatches(output.claim, expected) &&
  output.claim.state === terminalClaimState(input.action) && output.claim.endedAt !== null;

export const switchTaskResultMatches = (
  output: SwitchTaskResult,
  input: SwitchTaskInput,
  profileId: string,
  expectedPrevious: TaskClaim,
): boolean =>
  claimMatches(output.previousClaim, {
    claimId: input.currentClaimId,
    projectId: input.projectId,
    taskId: input.currentTaskId,
    profileId,
  }) && immutableClaimMatches(output.previousClaim, expectedPrevious) &&
  output.previousClaim.latestCheckpointId === output.checkpoint.id &&
  output.previousClaim.state === terminalClaimState(input.terminalAction) &&
  output.previousClaim.endedAt !== null &&
  output.checkpoint.claimId === output.previousClaim.id &&
  output.checkpoint.contextPackId === output.previousClaim.contextPackId &&
  checkpointDocumentMatches(output.checkpoint, input.checkpoint) &&
  output.checkpoint.projectRevision === input.expectedCurrentProjectRevision &&
  output.checkpoint.taskRevision === input.expectedCurrentTaskRevision &&
  claimMatches(output.nextClaim, {
    projectId: input.projectId,
    taskId: input.nextTaskId,
    profileId,
  }) && output.nextClaim.delegationId === input.acceptedDelegationId &&
  activeClaimSemanticsMatch(output.nextClaim) && output.nextClaim.latestCheckpointId === null &&
  output.nextClaim.baseProjectRevision === input.expectedNextProjectRevision &&
  output.nextClaim.baseTaskRevision === input.expectedNextTaskRevision &&
  contextMatches(output.contextPack, {
    projectId: input.projectId,
    taskId: input.nextTaskId,
    projectRevision: input.expectedNextProjectRevision,
    taskRevision: input.expectedNextTaskRevision,
    budgetTokens: input.nextContextBudgetTokens,
  }) &&
  output.contextPack.id === output.nextClaim.contextPackId &&
  output.contextPack.task.record.id === input.nextTaskId;

export const createdDelegationResultMatches = (
  output: DelegationResult,
  input: CreateDelegationInput,
  profileId: string,
): boolean => output.delegation.projectId === input.projectId &&
  output.delegation.taskId === input.taskId &&
  output.delegation.parentProfileId === profileId &&
  output.delegation.childProfileId === input.childProfileId &&
  output.delegation.state === "offered" &&
  output.delegation.baseProjectRevision === input.expectedProjectRevision &&
  output.delegation.baseTaskRevision === input.expectedTaskRevision &&
  output.delegation.acceptedAt === null && output.delegation.endedAt === null &&
  output.delegation.claimId === null &&
  timestampsMatch(output.delegation.deadline, input.deadline) &&
  exactJson(output.delegation.scope, input.scope) &&
  exactJson(output.delegation.allowedOutputs, input.allowedOutputs);

export const acceptedDelegationResultMatches = (
  output: DelegationResult,
  input: AcceptDelegationInput,
  profileId: string,
  expected: TaskDelegation,
): boolean => output.delegation.projectId === input.projectId &&
  output.delegation.taskId === input.taskId && output.delegation.id === input.delegationId &&
  output.delegation.childProfileId === profileId && output.delegation.state === "accepted" &&
  output.delegation.acceptedAt !== null && output.delegation.endedAt === null &&
  output.delegation.claimId === null && immutableDelegationMatches(output.delegation, expected) &&
  ((expected.state === "offered" && expected.acceptedAt === null &&
    expected.endedAt === null && expected.claimId === null) ||
    (expected.state === "accepted" && expected.acceptedAt === output.delegation.acceptedAt &&
      expected.endedAt === null && expected.claimId === null));

export const revokedDelegationResultMatches = (
  output: DelegationResult,
  input: RevokeDelegationInput,
  profileId: string,
  expected: TaskDelegation,
): boolean => output.delegation.projectId === input.projectId &&
  output.delegation.taskId === input.taskId && output.delegation.id === input.delegationId &&
  output.delegation.parentProfileId === profileId && output.delegation.state === "revoked" &&
  output.delegation.endedAt !== null && output.delegation.claimId === null &&
  immutableDelegationMatches(output.delegation, expected) &&
  output.delegation.acceptedAt === expected.acceptedAt &&
  (((expected.state === "offered" || expected.state === "accepted") &&
    expected.endedAt === null && expected.claimId === null) ||
    (expected.state === "revoked" && expected.endedAt === output.delegation.endedAt &&
      expected.claimId === null));

export const submissionResultMatches = (
  output: SubmissionResult,
  input: SubmitTaskResultInput,
  profileId: string,
  expected: TaskClaim,
): boolean => claimMatches(output.claim, {
  claimId: input.claimId,
  projectId: expected.projectId,
  taskId: expected.taskId,
  profileId,
}) && immutableClaimMatches(output.claim, expected) &&
  output.claim.state === "submitted" && output.claim.endedAt !== null &&
  output.claim.baseProjectRevision === input.expectedProjectRevision &&
  output.claim.baseTaskRevision === input.expectedTaskRevision &&
  output.claim.latestCheckpointId === input.checkpointId &&
  output.submission.baseProjectRevision === input.expectedProjectRevision &&
  output.submission.baseTaskRevision === input.expectedTaskRevision &&
  output.submission.projectId === output.claim.projectId &&
  output.submission.taskId === output.claim.taskId &&
  output.submission.claimId === input.claimId && output.submission.profileId === profileId &&
  output.submission.checkpointId === input.checkpointId &&
  output.submission.contextPackId === output.claim.contextPackId &&
  output.submission.summary === input.submission.summary &&
  exactJson(output.submission.verificationEvidence, input.submission.verificationEvidence) &&
  exactJson(output.submission.repositoryEvidence, input.submission.repositoryEvidence) &&
  output.submission.proposalId === output.proposal.id &&
  output.proposal.projectId === output.claim.projectId &&
  output.proposal.sourceTaskId === output.claim.taskId &&
  output.proposal.baseProjectRevision === input.expectedProjectRevision &&
  output.proposal.predecessorProposalId === null &&
  output.proposal.rationale === input.submission.changes.rationale &&
  output.proposal.origin.type === "profile" && output.proposal.origin.profileId === profileId &&
  output.proposal.reviewerActor === null && output.proposal.reviewedAt === null &&
  output.proposal.reviewReason === null &&
  ((output.submission.state === "submitted" && output.submission.decidedAt === null &&
    output.proposal.state === "pending") ||
    (output.submission.state === "conflicted" && output.submission.decidedAt !== null &&
      output.proposal.state === "conflicted"));
