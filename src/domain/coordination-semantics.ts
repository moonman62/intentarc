import type {
  CoordinationEvent,
  TaskClaim,
  TaskCheckpoint,
  TaskDelegation,
  TaskSubmission,
} from "./coordination-model.js";

type CoordinationEventTransition = readonly [
  CoordinationEvent["priorState"],
  CoordinationEvent["resultingState"],
];

export const coordinationEventTransitions = {
  ready_evaluation: [[null, null]],
  claim: [[null, "active"]],
  renewal: [["active", "active"]],
  checkpoint: [["active", "active"]],
  pause: [["active", "paused"]],
  release: [["active", "released"], ["submitted", "released"]],
  switch: [["active", "active"]],
  expiry: [
    ["active", "expired"],
    ["offered", "expired"],
    ["accepted", "expired"],
    ["claimed", "expired"],
  ],
  delegation_offer: [[null, "offered"]],
  delegation_accept: [["offered", "accepted"]],
  delegation_revoke: [["offered", "revoked"], ["accepted", "revoked"]],
  submission: [["active", "submitted"]],
  conflict: [["active", "conflicted"]],
  reconciliation: [["submitted", "reconciled"]],
} as const satisfies Record<
  CoordinationEvent["category"],
  readonly CoordinationEventTransition[]
>;

export const hasExactCoordinationEventTransition = (
  category: CoordinationEvent["category"],
  priorState: string | null,
  resultingState: string | null,
): boolean => coordinationEventTransitions[category].some(
  ([expectedPrior, expectedResult]) =>
    priorState === expectedPrior && resultingState === expectedResult,
);

export const coordinationEventReferencesAreApplicable = (
  event: Pick<CoordinationEvent,
    "category" | "claimId" | "delegationId" | "checkpointId" |
    "submissionId" | "proposalId">,
): boolean => {
  const noCheckpointSubmissionProposal = event.checkpointId === null &&
    event.submissionId === null && event.proposalId === null;
  switch (event.category) {
    case "ready_evaluation":
      return event.claimId === null && event.delegationId === null &&
        noCheckpointSubmissionProposal;
    case "claim":
    case "pause":
    case "release":
    case "switch":
      return event.claimId !== null && noCheckpointSubmissionProposal;
    case "renewal":
      return event.claimId !== null && event.delegationId === null &&
        event.submissionId === null && event.proposalId === null;
    case "checkpoint":
      return event.claimId !== null && event.delegationId === null &&
        event.checkpointId !== null && event.submissionId === null &&
        event.proposalId === null;
    case "expiry":
      return (event.claimId !== null || event.delegationId !== null) &&
        noCheckpointSubmissionProposal;
    case "delegation_offer":
    case "delegation_accept":
    case "delegation_revoke":
      return event.claimId === null && event.delegationId !== null &&
        noCheckpointSubmissionProposal;
    case "submission":
    case "conflict":
    case "reconciliation":
      return event.claimId !== null && event.checkpointId !== null &&
        event.submissionId !== null && event.proposalId !== null;
  }
};

export const taskClaimLifecycleIsCoherent = (
  claim: Pick<TaskClaim,
    "state" | "acquiredAt" | "expiresAt" | "absoluteExpiresAt" | "endedAt">,
): boolean => {
  const acquiredAt = Date.parse(claim.acquiredAt);
  const expiresAt = Date.parse(claim.expiresAt);
  const absoluteExpiresAt = Date.parse(claim.absoluteExpiresAt);
  const endedAt = claim.endedAt === null ? null : Date.parse(claim.endedAt);
  return Number.isFinite(acquiredAt) && Number.isFinite(expiresAt) &&
    Number.isFinite(absoluteExpiresAt) && acquiredAt <= expiresAt &&
    expiresAt <= absoluteExpiresAt &&
    (claim.state === "active"
      ? endedAt === null
      : endedAt !== null && Number.isFinite(endedAt) && endedAt >= acquiredAt);
};

export const taskDelegationLifecycleIsCoherent = (
  delegation: Pick<TaskDelegation,
    "state" | "offeredAt" | "deadline" | "acceptedAt" | "endedAt" | "claimId">,
): boolean => {
  const offeredAt = Date.parse(delegation.offeredAt);
  const deadline = Date.parse(delegation.deadline);
  const acceptedAt = delegation.acceptedAt === null ? null : Date.parse(delegation.acceptedAt);
  const endedAt = delegation.endedAt === null ? null : Date.parse(delegation.endedAt);
  if (!Number.isFinite(offeredAt) || !Number.isFinite(deadline) || offeredAt >= deadline ||
    (acceptedAt !== null && (!Number.isFinite(acceptedAt) || acceptedAt < offeredAt ||
      acceptedAt >= deadline)) ||
    (endedAt !== null && (!Number.isFinite(endedAt) || endedAt < offeredAt ||
      (acceptedAt !== null && endedAt < acceptedAt)))) return false;
  const stateIsCoherent = (() => {
    switch (delegation.state) {
    case "offered":
      return delegation.acceptedAt === null && delegation.endedAt === null &&
        delegation.claimId === null;
    case "accepted":
      return delegation.acceptedAt !== null && delegation.endedAt === null &&
        delegation.claimId === null;
    case "claimed":
      return delegation.acceptedAt !== null && delegation.endedAt === null &&
        delegation.claimId !== null;
    case "revoked":
      return delegation.endedAt !== null;
    case "expired":
      return delegation.endedAt !== null;
    case "completed":
      return delegation.acceptedAt !== null && delegation.endedAt !== null &&
        delegation.claimId !== null;
    }
  })();
  return stateIsCoherent &&
    (delegation.claimId === null || delegation.acceptedAt !== null);
};

const countCategories = (
  events: readonly CoordinationEvent[],
  categories: readonly CoordinationEvent["category"][],
): number => events.filter(({ category }) => categories.includes(category)).length;

const sameInstant = (left: string | null, right: string | null): boolean => {
  if (left === null || right === null) return left === right;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
};

export const selectedClaimHistoryIsCoherent = (
  claim: Pick<TaskClaim,
    "id" | "delegationId" | "state" | "acquiredAt" | "expiresAt" |
    "absoluteExpiresAt" | "endedAt">,
  submission: Pick<TaskSubmission, "state" | "submittedAt" | "decidedAt"> | null,
  events: readonly CoordinationEvent[],
): boolean => {
  const claimEvents = events.filter(({ claimId }) => claimId === claim.id);
  const initialSubmissionCount = countCategories(claimEvents, ["submission", "conflict"]);
  const reconciliationCount = countCategories(claimEvents, ["reconciliation"]);
  const terminalCounts = {
    paused: countCategories(claimEvents, ["pause"]),
    released: countCategories(claimEvents, ["release"]),
    expired: countCategories(claimEvents, ["expiry"]),
  } as const;
  const originEvents = claimEvents.filter(({ category }) => category === "claim");
  if (originEvents.length !== 1 ||
    !sameInstant(originEvents[0]!.createdAt, claim.acquiredAt)) return false;
  if (["active", "submitted", "reconciled"].includes(claim.state)) {
    if (terminalCounts.paused + terminalCounts.released + terminalCounts.expired !== 0) {
      return false;
    }
  } else if ((claim.state !== "paused" && claim.state !== "released" &&
    claim.state !== "expired") || terminalCounts[claim.state] !== 1 ||
    Object.entries(terminalCounts).some(([state, count]) =>
      state !== claim.state && count !== 0)) {
    return false;
  }
  switch (claim.state) {
    case "submitted":
    case "reconciled":
      if (submission === null || initialSubmissionCount !== 1) return false;
      break;
    case "released":
      if (initialSubmissionCount !== (submission === null ? 0 : 1) ||
        (submission !== null && !["conflicted", "rejected", "withdrawn"]
          .includes(submission.state))) return false;
      break;
    default:
      if (submission !== null || initialSubmissionCount !== 0) return false;
  }
  const terminalEvents = (() => {
    switch (claim.state) {
      case "paused":
        return claimEvents.filter(({ category }) => category === "pause");
      case "released":
        return claimEvents.filter(({ category }) => category === "release");
      case "expired":
        return claimEvents.filter(({ category }) => category === "expiry");
      case "submitted":
        return claimEvents.filter(({ category }) =>
          category === "submission" || category === "conflict");
      case "reconciled":
        return claimEvents.filter(({ category }) => category === "reconciliation");
      case "active":
        return [];
    }
  })();
  if (claim.state !== "active" && (terminalEvents.length !== 1 ||
    !sameInstant(terminalEvents[0]!.createdAt, claim.endedAt))) return false;
  if (claim.state === "released" && submission !== null &&
    (claim.endedAt === null || Date.parse(claim.endedAt) < Date.parse(submission.submittedAt) ||
      submission.decidedAt === null ||
      Date.parse(claim.endedAt) < Date.parse(submission.decidedAt))) return false;
  if (claim.state === "released" && terminalEvents[0]!.priorState !==
    (submission === null ? "active" : "submitted")) return false;
  const expiresAt = Date.parse(claim.expiresAt);
  const absoluteExpiresAt = Date.parse(claim.absoluteExpiresAt);
  const endedAt = claim.endedAt === null ? null : Date.parse(claim.endedAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(absoluteExpiresAt)) return false;
  if (submission !== null) {
    const submittedAt = Date.parse(submission.submittedAt);
    if (!Number.isFinite(submittedAt) || submittedAt >= expiresAt ||
      submittedAt >= absoluteExpiresAt) return false;
  }
  if ((claim.state === "paused" || (claim.state === "released" && submission === null)) &&
    (endedAt === null || endedAt >= expiresAt || endedAt >= absoluteExpiresAt)) return false;
  if (claim.state === "expired" && claim.delegationId === null &&
    (endedAt === null || endedAt < expiresAt)) return false;
  return claim.state === "reconciled"
    ? submission?.state === "accepted" && reconciliationCount === 1
    : reconciliationCount === 0;
};

export const selectedDelegationHistoryIsCoherent = (
  delegation: Pick<TaskDelegation,
    "id" | "state" | "offeredAt" | "deadline" | "acceptedAt" | "endedAt" | "claimId">,
  events: readonly CoordinationEvent[],
  linkedClaim: Pick<TaskClaim,
    "id" | "state" | "acquiredAt" | "expiresAt" | "absoluteExpiresAt" | "endedAt"> | null = null,
  linkedSubmission: Pick<TaskSubmission, "state" | "submittedAt" | "decidedAt"> | null = null,
): boolean => {
  const delegationEvents = events.filter(({ delegationId }) => delegationId === delegation.id);
  const offerEvents = delegationEvents.filter(({ category }) => category === "delegation_offer");
  if (offerEvents.length !== 1 ||
    !sameInstant(offerEvents[0]!.createdAt, delegation.offeredAt)) return false;
  const acceptEvents = delegationEvents.filter(({ category }) => category === "delegation_accept");
  if (acceptEvents.length !== (delegation.acceptedAt === null ? 0 : 1) ||
    (delegation.acceptedAt !== null &&
      !sameInstant(acceptEvents[0]!.createdAt, delegation.acceptedAt))) return false;
  const terminalEvents = (() => {
    switch (delegation.state) {
      case "revoked":
        return delegation.claimId === null
          ? delegationEvents.filter((event) => event.category === "delegation_revoke" &&
              event.claimId === null)
          : delegationEvents.filter((event) =>
              (event.category === "pause" || event.category === "release") &&
              event.claimId === delegation.claimId);
      case "expired":
        return delegationEvents.filter((event) => event.category === "expiry" &&
          event.claimId === delegation.claimId);
      case "completed":
        return delegationEvents.filter((event) => event.category === "reconciliation" &&
          event.claimId === delegation.claimId);
      default:
        return [];
    }
  })();
  const allTerminalEvents = delegationEvents.filter(({ category }) => [
    "delegation_revoke", "pause", "release", "expiry", "reconciliation",
  ].includes(category));
  if (["revoked", "expired", "completed"].includes(delegation.state)
    ? terminalEvents.length !== 1 || allTerminalEvents.length !== 1 ||
      !sameInstant(terminalEvents[0]!.createdAt, delegation.endedAt)
    : allTerminalEvents.length !== 0) return false;
  const claimEvents = delegationEvents.filter(({ category }) => category === "claim");
  if (delegation.claimId !== null && delegation.acceptedAt !== null &&
    claimEvents.length === 1) {
    const linkedAcquiredAt = linkedClaim?.id === delegation.claimId
      ? linkedClaim.acquiredAt
      : claimEvents[0]!.createdAt;
    const linkedAcquiredTime = Date.parse(linkedAcquiredAt);
    if (Date.parse(delegation.acceptedAt) > linkedAcquiredTime ||
      linkedAcquiredTime >= Date.parse(delegation.deadline)) return false;
  }
  const deadline = Date.parse(delegation.deadline);
  const terminalEvent = terminalEvents[0];
  const terminalTime = delegation.endedAt === null ? null : Date.parse(delegation.endedAt);
  if (delegation.claimId === null) {
    if (delegation.state === "expired" &&
      (terminalTime === null || terminalTime < deadline)) return false;
    if (delegation.state === "revoked" &&
      (terminalTime === null || terminalTime >= deadline)) return false;
  } else if (terminalEvent !== undefined) {
    if (delegation.state === "expired" && linkedClaim !== null) {
      const expiryBoundary = Math.min(Date.parse(linkedClaim.expiresAt), deadline);
      if (linkedClaim.state !== "expired" || terminalTime === null ||
        terminalTime < expiryBoundary ||
        !sameInstant(linkedClaim.endedAt, delegation.endedAt)) return false;
    }
    if (delegation.state === "revoked" && terminalEvent.priorState === "active") {
      if (terminalTime === null || terminalTime >= deadline ||
        (linkedClaim !== null && (terminalTime >= Date.parse(linkedClaim.expiresAt) ||
          terminalTime >= Date.parse(linkedClaim.absoluteExpiresAt)))) return false;
    }
    if (delegation.state === "revoked" && terminalEvent.priorState === "submitted") {
      const historicalSubmissionEvents = delegationEvents.filter((event) =>
        (event.category === "submission" || event.category === "conflict") &&
        event.claimId === delegation.claimId);
      const historicalSubmissionEvent = historicalSubmissionEvents[0];
      const claimOriginTime = Date.parse(claimEvents[0]?.createdAt ?? "");
      const submittedAt = Date.parse(historicalSubmissionEvent?.createdAt ?? "");
      if (terminalEvent.category !== "release" || historicalSubmissionEvents.length !== 1 ||
        historicalSubmissionEvent?.submissionId === null ||
        historicalSubmissionEvent?.submissionId === undefined ||
        !Number.isFinite(claimOriginTime) || !Number.isFinite(submittedAt) ||
        submittedAt < claimOriginTime || submittedAt >= deadline || terminalTime === null ||
        terminalTime < submittedAt) return false;
      if (linkedClaim !== null &&
        (linkedClaim.state !== "released" || linkedSubmission === null ||
          !["conflicted", "rejected", "withdrawn"].includes(linkedSubmission.state) ||
          linkedSubmission.decidedAt === null ||
          terminalTime < Date.parse(linkedSubmission.submittedAt) ||
          terminalTime < Date.parse(linkedSubmission.decidedAt))) return false;
    }
  }
  if (linkedSubmission !== null) {
    const submittedAt = Date.parse(linkedSubmission.submittedAt);
    if (!Number.isFinite(submittedAt) || submittedAt >= deadline ||
      (linkedClaim !== null && (submittedAt >= Date.parse(linkedClaim.expiresAt) ||
        submittedAt >= Date.parse(linkedClaim.absoluteExpiresAt)))) return false;
  }
  if (delegation.state === "completed" &&
    (linkedClaim?.state !== "reconciled" || linkedSubmission?.state !== "accepted")) return false;
  return delegation.claimId === null
    ? claimEvents.length === 0
    : claimEvents.length === 1 && claimEvents[0]!.claimId === delegation.claimId;
};

export const selectedCheckpointHistoryIsCoherent = (
  checkpoint: Pick<TaskCheckpoint,
    "id" | "claimId" | "createdAt" | "projectRevision" | "taskRevision" | "contextPackId">,
  claim: Pick<TaskClaim,
    "id" | "contextPackId" | "acquiredAt" | "expiresAt" | "absoluteExpiresAt" | "endedAt">,
  events: readonly CoordinationEvent[],
): boolean => {
  const checkpointEvents = events.filter((event) =>
    event.category === "checkpoint" && event.checkpointId === checkpoint.id);
  if (checkpointEvents.length !== 1) return false;
  const event = checkpointEvents[0]!;
  const createdAt = Date.parse(checkpoint.createdAt);
  return checkpoint.claimId === claim.id && checkpoint.contextPackId === claim.contextPackId &&
    event.claimId === claim.id && event.projectRevision === checkpoint.projectRevision &&
    event.taskRevision === checkpoint.taskRevision &&
    sameInstant(event.createdAt, checkpoint.createdAt) &&
    Number.isFinite(createdAt) && createdAt >= Date.parse(claim.acquiredAt) &&
    createdAt < Date.parse(claim.expiresAt) &&
    createdAt < Date.parse(claim.absoluteExpiresAt) &&
    (claim.endedAt === null || createdAt <= Date.parse(claim.endedAt));
};

export const selectedSubmissionHistoryIsCoherent = (
  submission: Pick<TaskSubmission, "id" | "state" | "submittedAt" | "decidedAt">,
  events: readonly CoordinationEvent[],
  authoritativeDecisionAt: string | null = null,
): boolean => {
  const submissionEvents = events.filter(({ submissionId }) => submissionId === submission.id);
  const initialEvents = submissionEvents.filter(({ category }) =>
    category === "submission" || category === "conflict");
  const reconciliationEvents = submissionEvents.filter(({ category }) =>
    category === "reconciliation");
  if (initialEvents.length !== 1 ||
    !sameInstant(initialEvents[0]!.createdAt, submission.submittedAt)) return false;
  const decisionIsPresentAndOrdered = submission.decidedAt !== null &&
    Date.parse(submission.decidedAt) >= Date.parse(submission.submittedAt) &&
    (authoritativeDecisionAt === null ||
      sameInstant(submission.decidedAt, authoritativeDecisionAt));
  switch (submission.state) {
    case "submitted":
      return initialEvents[0]!.category === "submission" &&
        submission.decidedAt === null && reconciliationEvents.length === 0;
    case "conflicted":
      return decisionIsPresentAndOrdered && reconciliationEvents.length === 0 &&
        (initialEvents[0]!.category === "submission" ||
          (initialEvents[0]!.category === "conflict" &&
            sameInstant(submission.decidedAt, initialEvents[0]!.createdAt)));
    case "accepted":
      return initialEvents[0]!.category === "submission" && decisionIsPresentAndOrdered &&
        reconciliationEvents.length === 1 &&
        sameInstant(submission.decidedAt, reconciliationEvents[0]!.createdAt);
    case "rejected":
    case "withdrawn":
      return initialEvents[0]!.category === "submission" && decisionIsPresentAndOrdered &&
        reconciliationEvents.length === 0;
  }
};
