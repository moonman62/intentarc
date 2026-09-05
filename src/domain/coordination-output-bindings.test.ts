import { describe, expect, it } from "vitest";
import {
  acceptedDelegationResultMatches,
  checkpointResultMatches,
  claimTaskResultMatches,
  coordinationStateMatches,
  createdDelegationResultMatches,
  readyTaskPageMatches,
  renewClaimResultMatches,
  revokedDelegationResultMatches,
  submissionResultMatches,
  switchTaskResultMatches,
  transitionClaimResultMatches,
} from "./coordination-output-bindings.js";

const timestamp = "2026-08-15T08:00:00.000Z";
const projectId = "project-1";
const taskId = "task-1";
const nextTaskId = "task-2";
const profileId = "profile-1";
const verificationEvidence = { tests: ["pnpm test"], artifacts: ["report.json"] };
const repositoryEvidence = {
  branch: "codex/task",
  worktree: "C:/worktree",
  commits: ["abc123"],
  artifacts: ["diff.patch"],
};
const task = {
  id: taskId,
  projectId,
  kind: "task" as const,
  status: "active" as const,
  title: "Bound task",
  body: "Bind every visible coordination relation.",
  sourceKind: "human" as const,
  sourceRef: null,
  revision: 7,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const nextTask = { ...task, id: nextTaskId, title: "Next task", revision: 4 };
const stableRecord = {
  ...task,
  id: "vision-1",
  kind: "vision" as const,
  status: "accepted" as const,
  title: "Stable frame",
  revision: 2,
};
const relatedRecord = {
  ...task,
  id: "evidence-1",
  kind: "evidence" as const,
  status: "provisional" as const,
  title: "Related evidence",
  revision: 5,
};
const claim = {
  id: "claim-1",
  projectId,
  taskId,
  profileId,
  delegationId: null,
  state: "active" as const,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  contextPackId: "pack-1",
  acquiredAt: timestamp,
  expiresAt: "2026-08-15T08:30:00.000Z",
  absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
  endedAt: null,
  latestCheckpointId: null,
};
const claimSnapshot = { ...claim };
const readiness = {
  task,
  blockers: [],
  liveClaimId: null,
  liveDelegationId: null,
};
const contextPack = {
  id: "pack-1",
  projectId,
  taskId,
  projectRevision: 3,
  generatedAt: timestamp,
  budgetTokens: 4_096,
  estimatedTokens: 100,
  stableFrame: [{
    record: stableRecord,
    mandatory: true,
    relevance: "stable_frame" as const,
    relationshipKind: null,
  }],
  task: {
    record: { ...task },
    mandatory: true,
    relevance: "active_task" as const,
    relationshipKind: null,
  },
  related: [{
    record: relatedRecord,
    mandatory: false,
    relevance: "linked" as const,
    relationshipKind: "supports" as const,
  }],
  omissions: [{
    recordId: "omitted-1",
    kind: "evidence" as const,
    reason: "budget" as const,
    retrievalRef: `intentarc://projects/${projectId}/records/omitted-1`,
  }],
  sourceRevisions: [
    { recordId: relatedRecord.id, revision: relatedRecord.revision },
    { recordId: taskId, revision: 7 },
    { recordId: stableRecord.id, revision: stableRecord.revision },
  ].sort((left, right) => left.recordId.localeCompare(right.recordId)),
};
const checkpointDocument = {
  summary: "Exact checkpoint",
  completedWork: ["Bound output."],
  remainingWork: ["Review."],
  blockers: [],
  verificationEvidence,
  repositoryEvidence,
};
const checkpoint = {
  ...checkpointDocument,
  id: "checkpoint-1",
  claimId: claim.id,
  sequence: 1,
  createdAt: timestamp,
  projectRevision: 3,
  taskRevision: 7,
  contextPackId: claim.contextPackId,
};
const delegation = {
  id: "delegation-1",
  projectId,
  taskId,
  parentProfileId: profileId,
  childProfileId: "profile-child",
  state: "offered" as const,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  scope: { summary: "Bound work", constraints: ["Exact output"] },
  allowedOutputs: ["create_record", "update_record"] as Array<
    "create_record" | "update_record"
  >,
  offeredAt: timestamp,
  deadline: "2026-08-15T10:00:00.000Z",
  acceptedAt: null,
  endedAt: null,
  claimId: null,
};
const submissionDocument = {
  summary: "Exact submission",
  verificationEvidence,
  repositoryEvidence,
  changes: {
    rationale: "Apply the exact worker result.",
    operations: [{
      operationId: "create-evidence",
      type: "create_record" as const,
      kind: "evidence" as const,
      status: "provisional" as const,
      title: "Evidence",
      body: "Verified evidence.",
    }],
  },
};
const submission = {
  id: "submission-1",
  claimId: claim.id,
  checkpointId: checkpoint.id,
  profileId,
  projectId,
  taskId,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  contextPackId: claim.contextPackId,
  summary: submissionDocument.summary,
  verificationEvidence,
  repositoryEvidence,
  proposalId: "proposal-1",
  state: "submitted" as const,
  submittedAt: timestamp,
  decidedAt: null,
};
const proposal = {
  id: submission.proposalId,
  projectId,
  origin: { type: "profile" as const, profileId },
  sourceTaskId: taskId,
  predecessorProposalId: null,
  baseProjectRevision: 3,
  state: "pending" as const,
  rationale: submissionDocument.changes.rationale,
  idempotencyKey: "coordination-submission-hash",
  requestHash: "a".repeat(64),
  reviewReason: null,
  reviewerActor: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  reviewedAt: null,
};

type Mutation<Value> = readonly [label: string, mutate: (value: Value) => void];

const rejectsMutations = <Value>(
  base: Value,
  matches: (value: Value) => boolean,
  mutations: readonly Mutation<Value>[],
): void => {
  expect(matches(structuredClone(base)), "healthy production-shaped output").toBe(true);
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(base);
    mutate(changed);
    expect.soft(matches(changed), label).toBe(false);
  }
};

describe("coordination output bindings", () => {
  it("binds ready and state reads to exact requested revisions and nested lineage", () => {
    const ready = { tasks: [readiness], nextCursor: null, projectRevision: 3 };
    rejectsMutations(ready, (output) => readyTaskPageMatches(output, {
      projectId,
      expectedProjectRevision: 3,
      cursor: null,
      limit: 2,
    }), [
      ["ready revision", (value) => { value.projectRevision = 4; }],
      ["ready task project", (value) => { value.tasks[0]!.task.projectId = "project-other"; }],
      ["ready task kind", (value) => { value.tasks[0]!.task.kind = "evidence"; }],
      ["ready task status", (value) => { value.tasks[0]!.task.status = "blocked"; }],
      ["ready unlinked claim blocker", (value) => {
        value.tasks[0]!.blockers = [`claim_active:${claim.id}`];
      }],
      ["ready unlinked delegation blocker", (value) => {
        value.tasks[0]!.blockers = [`delegation_live:${delegation.id}`];
      }],
      ["ready live claim", (value) => { value.tasks[0]!.liveClaimId = claim.id; }],
      ["ready live delegation", (value) => {
        value.tasks[0]!.liveDelegationId = delegation.id;
      }],
      ["ready over limit", (value) => {
        value.tasks.push({ ...readiness, task: { ...task, id: "task-2" } });
        value.tasks.push({ ...readiness, task: { ...task, id: "task-3" } });
      }],
      ["ready duplicate task", (value) => {
        value.tasks.push(structuredClone(value.tasks[0]!));
      }],
      ["ready short page cursor", (value) => { value.nextCursor = "opaque-next"; }],
    ]);
    expect(readyTaskPageMatches({
      tasks: [readiness, { ...readiness, task: { ...task, id: "task-2" } }],
      nextCursor: "opaque-current",
      projectRevision: 3,
    }, {
      projectId, expectedProjectRevision: 3, cursor: "opaque-current", limit: 2,
    })).toBe(false);

    const stateClaim = {
      ...claim,
      delegationId: delegation.id,
      state: "submitted" as const,
      endedAt: timestamp,
      latestCheckpointId: checkpoint.id,
    };
    const stateDelegation = {
      ...delegation,
      parentProfileId: "profile-parent",
      childProfileId: profileId,
      state: "claimed" as const,
      acceptedAt: timestamp,
      claimId: claim.id,
    };
    const stateEvent = (
      id: string,
      category: "claim" | "checkpoint" | "delegation_offer" | "delegation_accept",
    ) => ({
      id,
      category,
      projectId,
      taskId,
      profileId: category === "delegation_offer" ? stateDelegation.parentProfileId : profileId,
      claimId: category === "claim" || category === "checkpoint" ? claim.id : null,
      delegationId: category === "claim" || category.startsWith("delegation_")
        ? delegation.id
        : null,
      checkpointId: category === "checkpoint" ? checkpoint.id : null,
      submissionId: null,
      proposalId: null,
      priorState: category === "claim" || category === "delegation_offer" ? null :
        category === "checkpoint" ? "active" : "offered",
      resultingState: category === "claim" || category === "checkpoint" ? "active" :
        category === "delegation_offer" ? "offered" : "accepted",
      projectRevision: 3,
      taskRevision: 7,
      detail: null,
      createdAt: timestamp,
    });
    const state = {
      projectRevision: 3,
      task,
      claim: stateClaim,
      delegation: stateDelegation,
      latestCheckpoint: checkpoint,
      submission,
      events: [{
        id: "event-1", category: "submission" as const, projectId, taskId,
        profileId, claimId: claim.id, delegationId: delegation.id,
        checkpointId: checkpoint.id, submissionId: submission.id,
        proposalId: proposal.id, priorState: "active", resultingState: "submitted",
        projectRevision: 3, taskRevision: 7, detail: null, createdAt: timestamp,
      }, stateEvent("event-claim", "claim"),
      stateEvent("event-checkpoint", "checkpoint"),
      stateEvent("event-delegation-offer", "delegation_offer"),
      stateEvent("event-delegation-accept", "delegation_accept")],
    };
    rejectsMutations(state, (output) => coordinationStateMatches(output, {
      projectId,
      taskId,
      expectedProjectRevision: 3,
    }), [
      ["state revision", (value) => { value.projectRevision = 4; }],
      ["state task project", (value) => { value.task.projectId = "project-other"; }],
      ["state task", (value) => { value.task.id = "task-other"; }],
      ["state task kind", (value) => { value.task.kind = "evidence"; }],
      ["state claim project", (value) => { value.claim!.projectId = "project-other"; }],
      ["state claim task", (value) => { value.claim!.taskId = "task-other"; }],
      ["state delegation project", (value) => { value.delegation!.projectId = "project-other"; }],
      ["state delegation task", (value) => { value.delegation!.taskId = "task-other"; }],
      ["state active claim with end", (value) => { value.claim!.state = "active"; }],
      ["state delegation wrong claim", (value) => {
        value.delegation!.claimId = "claim-other";
      }],
      ["state claim wrong delegation", (value) => {
        value.claim!.delegationId = "delegation-other";
      }],
      ["state checkpoint claim", (value) => { value.latestCheckpoint!.claimId = "claim-other"; }],
      ["state checkpoint context", (value) => { value.latestCheckpoint!.contextPackId = "pack-other"; }],
      ["state claim latest checkpoint", (value) => { value.claim!.latestCheckpointId = "checkpoint-other"; }],
      ["state submission project", (value) => { value.submission!.projectId = "project-other"; }],
      ["state submission task", (value) => { value.submission!.taskId = "task-other"; }],
      ["state submission claim", (value) => { value.submission!.claimId = "claim-other"; }],
      ["state submission profile", (value) => { value.submission!.profileId = "profile-other"; }],
      ["state submission context", (value) => { value.submission!.contextPackId = "pack-other"; }],
      ["state submission checkpoint", (value) => { value.submission!.checkpointId = "checkpoint-other"; }],
      ["state submission proposal", (value) => { value.submission!.proposalId = "proposal-other"; }],
      ["state event project", (value) => { value.events[0]!.projectId = "project-other"; }],
      ["state event task", (value) => { value.events[0]!.taskId = "task-other"; }],
      ["state event transition", (value) => { value.events[0]!.priorState = "paused"; }],
      ["state event missing checkpoint", (value) => { value.events[0]!.checkpointId = null; }],
      ["state event prohibited delegation", (value) => {
        value.events[0]!.category = "checkpoint";
      }],
      ["state event impossible linked lifecycle", (value) => {
        value.events.push({
          ...value.events[0]!,
          id: "event-pause-impossible",
          category: "pause",
          checkpointId: null,
          submissionId: null,
          proposalId: null,
          priorState: "active",
          resultingState: "paused",
        });
      }],
      ["state missing selected claim origin", (value) => {
        value.events = value.events.filter((event) => event.category !== "claim");
      }],
      ["state duplicate selected claim origin", (value) => {
        value.events.push({ ...value.events[1]!, id: "event-claim-duplicate" });
      }],
      ["state empty history", (value) => { value.events = []; }],
      ["state claim lease before acquisition", (value) => {
        value.claim!.expiresAt = "2026-08-15T07:59:59.000Z";
      }],
      ["state claim lease beyond absolute horizon", (value) => {
        value.claim!.expiresAt = "2026-08-15T12:00:01.000Z";
      }],
      ["state claim terminal before acquisition", (value) => {
        value.claim!.endedAt = "2026-08-15T07:59:59.000Z";
      }],
      ["state delegation deadline before offer", (value) => {
        value.delegation!.deadline = "2026-08-15T07:59:59.000Z";
      }],
      ["state delegation acceptance before offer", (value) => {
        value.delegation!.acceptedAt = "2026-08-15T07:59:59.000Z";
      }],
      ["state delegation acceptance after deadline", (value) => {
        value.delegation!.acceptedAt = "2026-08-15T10:00:01.000Z";
      }],
      ["state delegation zero-width deadline", (value) => {
        value.delegation!.deadline = value.delegation!.offeredAt;
      }],
      ["state delegation accepted after linked claim acquisition", (value) => {
        value.delegation!.acceptedAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state claim origin event timestamp", (value) => {
        value.events[1]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state delegation offer event timestamp", (value) => {
        value.events[3]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state delegation accept event timestamp", (value) => {
        value.events[4]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state submission event timestamp", (value) => {
        value.events[0]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state checkpoint event timestamp", (value) => {
        value.events[2]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state checkpoint event project revision", (value) => {
        value.events[2]!.projectRevision = 4;
      }],
      ["state checkpoint event task revision", (value) => {
        value.events[2]!.taskRevision = 8;
      }],
      ["state checkpoint before claim acquisition", (value) => {
        value.latestCheckpoint!.createdAt = "2026-08-15T07:59:59.000Z";
        value.events[2]!.createdAt = "2026-08-15T07:59:59.000Z";
      }],
      ["state checkpoint after terminal claim", (value) => {
        value.latestCheckpoint!.createdAt = "2026-08-15T08:00:01.000Z";
        value.events[2]!.createdAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state submitted claim terminal timestamp", (value) => {
        value.claim!.endedAt = "2026-08-15T08:00:01.000Z";
      }],
      ["state submitted submission decision", (value) => {
        value.submission!.decidedAt = timestamp;
      }],
      ["state submitted with conflict event", (value) => {
        value.events[0]!.category = "conflict";
        value.events[0]!.resultingState = "conflicted";
      }],
    ]);

    const independentHistories = {
      ...state,
      claim: { ...claim, id: "claim-new", contextPackId: "pack-new" },
      latestCheckpoint: null,
      submission: null,
      delegation: {
        ...delegation,
        id: "delegation-old",
        offeredAt: "2026-08-15T07:00:00.000Z",
        deadline: "2026-08-15T07:30:00.000Z",
        state: "expired",
        claimId: null,
        endedAt: timestamp,
      },
      events: [{
        ...stateEvent("event-claim-new", "claim"),
        claimId: "claim-new",
        delegationId: null,
      }, {
        ...stateEvent("event-delegation-old-offer", "delegation_offer"),
        delegationId: "delegation-old",
        profileId,
        createdAt: "2026-08-15T07:00:00.000Z",
      }, {
        ...stateEvent("event-delegation-old-expiry", "delegation_offer"),
        category: "expiry",
        delegationId: "delegation-old",
        profileId: "profile-child",
        priorState: "offered",
        resultingState: "expired",
      }],
    };
    expect(coordinationStateMatches(independentHistories, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    expect(coordinationStateMatches({
      ...independentHistories,
      delegation: {
        ...independentHistories.delegation,
        endedAt: "2026-08-15T06:59:59.000Z",
      },
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    expect(coordinationStateMatches({
      ...independentHistories,
      delegation: {
        ...independentHistories.delegation,
        endedAt: "2026-08-15T07:29:59.000Z",
      },
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const preAcceptRevoked = {
      ...state,
      claim: null,
      latestCheckpoint: null,
      submission: null,
      delegation: {
        ...stateDelegation,
        state: "revoked" as const,
        acceptedAt: null,
        endedAt: timestamp,
        claimId: null,
      },
      events: [stateEvent("event-pre-revoke-offer", "delegation_offer"), {
        ...stateEvent("event-pre-revoke", "delegation_offer"),
        category: "delegation_revoke" as const,
        priorState: "offered",
        resultingState: "revoked",
      }],
    };
    expect(coordinationStateMatches(preAcceptRevoked, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);

    expect(coordinationStateMatches({
      ...state,
      claim: null,
      latestCheckpoint: null,
      submission: null,
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const completed = {
      ...state,
      claim: { ...state.claim, state: "reconciled" as const },
      submission: { ...state.submission, state: "accepted" as const, decidedAt: timestamp },
      delegation: {
        ...state.delegation,
        state: "completed" as const,
        endedAt: timestamp,
      },
      events: [...state.events, {
        ...state.events[0]!,
        id: "event-reconciliation",
        category: "reconciliation" as const,
        priorState: "submitted",
        resultingState: "reconciled",
      }],
    };
    expect(coordinationStateMatches(completed, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    expect(coordinationStateMatches({
      ...completed,
      claim: null,
      latestCheckpoint: null,
      submission: null,
    }, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(false);

    const linkedRevoked = {
      ...state,
      claim: {
        ...claim,
        delegationId: delegation.id,
        state: "paused" as const,
        endedAt: timestamp,
      },
      delegation: {
        ...stateDelegation,
        state: "revoked" as const,
        endedAt: timestamp,
      },
      latestCheckpoint: null,
      submission: null,
      events: [stateEvent("event-linked-claim", "claim"),
        stateEvent("event-linked-offer", "delegation_offer"),
        stateEvent("event-linked-accept", "delegation_accept"), {
          ...stateEvent("event-linked-pause", "claim"),
          category: "pause" as const,
          priorState: "active",
          resultingState: "paused",
        }],
    };
    expect(coordinationStateMatches(linkedRevoked, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    for (const endedAt of [stateDelegation.deadline, "2026-08-15T10:00:01.000Z"]) {
      expect(coordinationStateMatches({
        ...linkedRevoked,
        claim: { ...linkedRevoked.claim, endedAt },
        delegation: { ...linkedRevoked.delegation, endedAt },
        events: linkedRevoked.events.map((event) => event.id === "event-linked-pause"
          ? { ...event, createdAt: endedAt }
          : event),
      }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    }
    expect(coordinationStateMatches({
      ...linkedRevoked,
      delegation: { ...linkedRevoked.delegation, acceptedAt: null },
      events: linkedRevoked.events.filter((event) =>
        event.category !== "delegation_accept"),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    for (const acquiredAt of [
      stateDelegation.deadline,
      "2026-08-15T10:00:01.000Z",
    ]) {
      expect(coordinationStateMatches({
        ...state,
        claim: {
          ...claim,
          delegationId: delegation.id,
          acquiredAt,
          expiresAt: "2026-08-15T10:30:00.000Z",
          absoluteExpiresAt: "2026-08-15T14:00:00.000Z",
        },
        delegation: stateDelegation,
        latestCheckpoint: null,
        submission: null,
        events: [stateEvent("event-deadline-claim", "claim"),
          stateEvent("event-deadline-offer", "delegation_offer"),
          stateEvent("event-deadline-accept", "delegation_accept")].map((event) =>
          event.category === "claim" ? { ...event, createdAt: acquiredAt } : event),
      }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    }
    expect(coordinationStateMatches({
      ...linkedRevoked,
      events: linkedRevoked.events.map((event) => event.id === "event-linked-pause"
        ? { ...event, createdAt: "2026-08-15T08:00:01.000Z" }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const activeCheckpoint = {
      ...state,
      claim: { ...claim, latestCheckpointId: checkpoint.id },
      delegation: null,
      latestCheckpoint: {
        ...checkpoint,
        createdAt: "2026-08-15T08:20:00.000Z",
      },
      submission: null,
      events: [{ ...stateEvent("event-active-checkpoint-claim", "claim"),
        delegationId: null }, {
        ...stateEvent("event-active-checkpoint", "checkpoint"),
        createdAt: "2026-08-15T08:20:00.000Z",
      }],
    };
    expect(coordinationStateMatches(activeCheckpoint, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    for (const createdAt of [
      claim.expiresAt,
      claim.absoluteExpiresAt,
      "2026-08-15T08:30:01.000Z",
      "2026-08-15T12:00:01.000Z",
    ]) {
      expect(coordinationStateMatches({
        ...activeCheckpoint,
        latestCheckpoint: { ...activeCheckpoint.latestCheckpoint, createdAt },
        events: activeCheckpoint.events.map((event) => event.category === "checkpoint"
          ? { ...event, createdAt }
          : event),
      }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    }

    expect(coordinationStateMatches({
      ...state,
      claim: null,
      latestCheckpoint: null,
      submission: null,
      delegation: {
        ...stateDelegation,
        state: "accepted" as const,
        acceptedAt: stateDelegation.deadline,
        claimId: null,
      },
      events: [stateEvent("event-equal-deadline-offer", "delegation_offer"), {
        ...stateEvent("event-equal-deadline-accept", "delegation_accept"),
        createdAt: stateDelegation.deadline,
      }],
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const independentLinkedHistories = {
      ...state,
      claim: { ...claim, id: "claim-new", contextPackId: "pack-new" },
      latestCheckpoint: null,
      submission: null,
      delegation: {
        ...stateDelegation,
        id: "delegation-old-linked",
        state: "expired" as const,
        offeredAt: "2026-08-15T07:00:00.000Z",
        acceptedAt: "2026-08-15T07:30:00.000Z",
        deadline: "2026-08-15T08:30:00.000Z",
        endedAt: "2026-08-15T08:30:00.000Z",
        claimId: "claim-old",
      },
      events: [{
        ...stateEvent("event-independent-new-claim", "claim"),
        claimId: "claim-new",
        delegationId: null,
      }, {
        ...stateEvent("event-independent-old-offer", "delegation_offer"),
        delegationId: "delegation-old-linked",
        createdAt: "2026-08-15T07:00:00.000Z",
      }, {
        ...stateEvent("event-independent-old-accept", "delegation_accept"),
        delegationId: "delegation-old-linked",
        createdAt: "2026-08-15T07:30:00.000Z",
      }, {
        ...stateEvent("event-independent-old-claim", "claim"),
        claimId: "claim-old",
        delegationId: "delegation-old-linked",
      }, {
        ...stateEvent("event-independent-old-expiry", "claim"),
        category: "expiry" as const,
        claimId: "claim-old",
        delegationId: "delegation-old-linked",
        priorState: "active",
        resultingState: "expired",
        createdAt: "2026-08-15T08:30:00.000Z",
      }],
    };
    expect(coordinationStateMatches(independentLinkedHistories, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    const independentSubmittedHold = {
      ...independentLinkedHistories,
      delegation: {
        ...independentLinkedHistories.delegation,
        state: "revoked" as const,
        endedAt: "2026-08-15T09:00:00.000Z",
      },
      events: independentLinkedHistories.events.map((event) =>
        event.id === "event-independent-old-expiry"
          ? {
              ...event,
              id: "event-independent-old-release",
              category: "release" as const,
              priorState: "submitted",
              resultingState: "released",
              createdAt: "2026-08-15T09:00:00.000Z",
            }
          : event).concat({
            ...state.events[0]!,
            id: "event-independent-old-submission",
            claimId: "claim-old",
            delegationId: "delegation-old-linked",
            submissionId: "submission-old",
            proposalId: "proposal-old",
            createdAt: "2026-08-15T08:15:00.000Z",
          }),
    };
    expect(coordinationStateMatches(independentSubmittedHold, {
      projectId, taskId, expectedProjectRevision: 3,
    }), "a complete older submitted hold remains visible beside the newer claim").toBe(true);
    expect(coordinationStateMatches({
      ...independentSubmittedHold,
      events: independentSubmittedHold.events.filter((event) =>
        event.id !== "event-independent-old-submission"),
    }, { projectId, taskId, expectedProjectRevision: 3 }),
    "an independent submitted release still requires its historical submission origin")
      .toBe(false);
    for (const createdAt of [
      independentSubmittedHold.delegation.deadline,
      "2026-08-15T08:30:01.000Z",
    ]) {
      expect(coordinationStateMatches({
        ...independentSubmittedHold,
        events: independentSubmittedHold.events.map((event) =>
          event.id === "event-independent-old-submission"
            ? { ...event, createdAt }
            : event),
      }, { projectId, taskId, expectedProjectRevision: 3 }),
      "the historical submission origin must be strictly before its delegation deadline")
        .toBe(false);
    }
    expect(coordinationStateMatches({
      ...independentSubmittedHold,
      events: independentSubmittedHold.events.concat({
        ...independentSubmittedHold.events.find((event) =>
          event.id === "event-independent-old-submission")!,
        id: "event-independent-old-submission-duplicate",
        submissionId: "submission-old-duplicate",
        proposalId: "proposal-old-duplicate",
      }),
    }, { projectId, taskId, expectedProjectRevision: 3 }),
    "the historical submission origin is unique").toBe(false);
    expect(coordinationStateMatches({
      ...independentLinkedHistories,
      delegation: {
        ...independentLinkedHistories.delegation,
        acceptedAt: "2026-08-15T08:00:01.000Z",
      },
      events: independentLinkedHistories.events.map((event) =>
        event.id === "event-independent-old-accept"
          ? { ...event, createdAt: "2026-08-15T08:00:01.000Z" }
          : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    expect(coordinationStateMatches({
      ...linkedRevoked,
      events: linkedRevoked.events.map((event) => event.id === "event-linked-pause"
        ? {
            ...event,
            category: "delegation_revoke" as const,
            claimId: null,
            priorState: "accepted",
            resultingState: "revoked",
          }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const linkedExpired = {
      ...linkedRevoked,
      claim: {
        ...linkedRevoked.claim,
        state: "expired" as const,
        endedAt: "2026-08-15T08:30:00.000Z",
      },
      delegation: {
        ...linkedRevoked.delegation,
        state: "expired" as const,
        offeredAt: "2026-08-15T07:00:00.000Z",
        acceptedAt: "2026-08-15T07:30:00.000Z",
        deadline: "2026-08-15T08:30:00.000Z",
        endedAt: "2026-08-15T08:30:00.000Z",
      },
      events: linkedRevoked.events.map((event) => event.id === "event-linked-offer"
        ? { ...event, createdAt: "2026-08-15T07:00:00.000Z" }
        : event.id === "event-linked-accept"
        ? { ...event, createdAt: "2026-08-15T07:30:00.000Z" }
        : event.id === "event-linked-pause" ? {
            ...event,
            category: "expiry" as const,
            priorState: "active",
            resultingState: "expired",
            createdAt: "2026-08-15T08:30:00.000Z",
          }
        : event),
    };
    expect(coordinationStateMatches(linkedExpired, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    const shorterLeaseExpiry = {
      ...linkedExpired,
      claim: {
        ...linkedExpired.claim,
        expiresAt: "2026-08-15T08:15:00.000Z",
        endedAt: "2026-08-15T08:16:00.000Z",
      },
      delegation: {
        ...linkedExpired.delegation,
        deadline: "2026-08-15T10:00:00.000Z",
        endedAt: "2026-08-15T08:16:00.000Z",
      },
      events: linkedExpired.events.map((event) => event.category === "expiry"
        ? { ...event, createdAt: "2026-08-15T08:16:00.000Z" }
        : event),
    };
    expect(coordinationStateMatches(shorterLeaseExpiry, {
      projectId, taskId, expectedProjectRevision: 3,
    }), "the shorter active claim lease may expire its delegation before its deadline")
      .toBe(true);
    expect(coordinationStateMatches({
      ...shorterLeaseExpiry,
      claim: { ...shorterLeaseExpiry.claim, endedAt: "2026-08-15T08:14:59.000Z" },
      delegation: {
        ...shorterLeaseExpiry.delegation,
        endedAt: "2026-08-15T08:14:59.000Z",
      },
      events: shorterLeaseExpiry.events.map((event) => event.category === "expiry"
        ? { ...event, createdAt: "2026-08-15T08:14:59.000Z" }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 }),
    "linked expiry cannot precede both the claim lease and delegation deadline").toBe(false);
    expect(coordinationStateMatches({
      ...linkedExpired,
      events: linkedExpired.events.map((event) => event.id === "event-linked-pause"
        ? { ...event, claimId: null }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const conflictedAtSubmission = {
      ...state,
      submission: { ...submission, state: "conflicted" as const, decidedAt: timestamp },
      events: state.events.map((event, index) => index === 0
        ? { ...event, category: "conflict" as const, resultingState: "conflicted" }
        : event),
    };
    expect(coordinationStateMatches(conflictedAtSubmission, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    expect(coordinationStateMatches({
      ...conflictedAtSubmission,
      submission: {
        ...conflictedAtSubmission.submission,
        decidedAt: "2026-08-15T08:00:01.000Z",
      },
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    expect(coordinationStateMatches({
      ...state,
      submission: {
        ...submission,
        state: "conflicted" as const,
        decidedAt: "2026-08-15T08:05:00.000Z",
      },
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(true);

    for (const terminalState of ["rejected", "withdrawn"] as const) {
      const decided = {
        ...state,
        submission: {
          ...submission,
          state: terminalState,
          decidedAt: "2026-08-15T08:05:00.000Z",
        },
      };
      expect(coordinationStateMatches(decided, {
        projectId, taskId, expectedProjectRevision: 3,
      })).toBe(true);
      expect(coordinationStateMatches({
        ...decided,
        submission: { ...decided.submission, decidedAt: null },
      }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
      expect(coordinationStateMatches({
        ...decided,
        events: decided.events.map((event, index) => index === 0
          ? { ...event, category: "conflict" as const, resultingState: "conflicted" }
          : event),
      }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    }

    const directRelease = {
      ...state,
      claim: { ...claim, state: "released" as const, endedAt: "2026-08-15T08:05:00.000Z" },
      delegation: null,
      latestCheckpoint: null,
      submission: null,
      events: [stateEvent("event-direct-release-claim", "claim"), {
        ...stateEvent("event-direct-release", "claim"),
        category: "release" as const,
        delegationId: null,
        priorState: "active",
        resultingState: "released",
        createdAt: "2026-08-15T08:05:00.000Z",
      }],
    };
    expect(coordinationStateMatches(directRelease, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    for (const endedAt of [claim.expiresAt, claim.absoluteExpiresAt]) {
      expect(coordinationStateMatches({
        ...directRelease,
        claim: { ...directRelease.claim, endedAt },
        events: directRelease.events.map((event) => event.category === "release"
          ? { ...event, createdAt: endedAt }
          : event),
      }, { projectId, taskId, expectedProjectRevision: 3 }),
      "an active-path release must occur before both claim horizons").toBe(false);
    }
    expect(coordinationStateMatches({
      ...directRelease,
      events: directRelease.events.map((event) => event.category === "release"
        ? { ...event, priorState: "submitted" }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const postDecisionRelease = {
      ...state,
      claim: { ...state.claim, state: "released" as const,
        endedAt: "2026-08-15T08:06:00.000Z" },
      delegation: null,
      submission: { ...state.submission, state: "rejected" as const,
        decidedAt: "2026-08-15T08:05:00.000Z" },
      events: [...state.events.filter((event) =>
        !event.category.startsWith("delegation_")), {
        ...stateEvent("event-post-decision-release", "claim"),
        category: "release" as const,
        delegationId: null,
        priorState: "submitted",
        resultingState: "released",
        createdAt: "2026-08-15T08:06:00.000Z",
      }],
    };
    expect(coordinationStateMatches(postDecisionRelease, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);
    expect(coordinationStateMatches({
      ...postDecisionRelease,
      events: postDecisionRelease.events.map((event) => event.category === "release"
        ? { ...event, priorState: "active" }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const submittedHoldReleaseAfterDeadline = {
      ...postDecisionRelease,
      claim: {
        ...postDecisionRelease.claim,
        delegationId: delegation.id,
        endedAt: "2026-08-15T10:06:00.000Z",
      },
      delegation: {
        ...stateDelegation,
        state: "revoked" as const,
        deadline: "2026-08-15T10:00:00.000Z",
        endedAt: "2026-08-15T10:06:00.000Z",
      },
      events: [
        ...postDecisionRelease.events.map((event) => event.category === "claim"
          ? { ...event, delegationId: delegation.id }
          : event.category === "release"
          ? { ...event, delegationId: delegation.id, createdAt: "2026-08-15T10:06:00.000Z" }
          : event.category === "submission"
          ? { ...event, delegationId: delegation.id }
          : event),
        stateEvent("event-hold-release-offer", "delegation_offer"),
        stateEvent("event-hold-release-accept", "delegation_accept"),
      ],
    };
    expect(coordinationStateMatches(submittedHoldReleaseAfterDeadline, {
      projectId, taskId, expectedProjectRevision: 3,
    }), "a decided submitted hold may be explicitly released after its lease and deadline")
      .toBe(true);
    expect(coordinationStateMatches({
      ...postDecisionRelease,
      claim: { ...postDecisionRelease.claim, endedAt: "2026-08-15T08:04:00.000Z" },
      events: postDecisionRelease.events.map((event) =>
        event.id === "event-post-decision-release"
          ? { ...event, createdAt: "2026-08-15T08:04:00.000Z" }
          : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);

    const completedAfterDeadline = {
      ...completed,
      claim: { ...completed.claim, endedAt: "2026-08-15T09:00:00.000Z" },
      submission: {
        ...completed.submission,
        decidedAt: "2026-08-15T09:00:00.000Z",
      },
      delegation: {
        ...completed.delegation,
        offeredAt: "2026-08-15T07:00:00.000Z",
        acceptedAt: "2026-08-15T07:30:00.000Z",
        deadline: "2026-08-15T08:30:00.000Z",
        endedAt: "2026-08-15T09:00:00.000Z",
      },
      events: completed.events.map((event) =>
        event.category === "delegation_offer"
          ? { ...event, createdAt: "2026-08-15T07:00:00.000Z" }
          : event.category === "delegation_accept"
          ? { ...event, createdAt: "2026-08-15T07:30:00.000Z" }
          : event.category === "reconciliation"
          ? { ...event, createdAt: "2026-08-15T09:00:00.000Z" }
          : event),
    };
    expect(coordinationStateMatches(completedAfterDeadline, {
      projectId, taskId, expectedProjectRevision: 3,
    })).toBe(true);

    const completionWithLateSubmission = {
      ...completedAfterDeadline,
      claim: {
        ...completedAfterDeadline.claim,
        expiresAt: "2026-08-15T10:30:00.000Z",
      },
      submission: {
        ...completedAfterDeadline.submission,
        submittedAt: "2026-08-15T08:30:00.000Z",
      },
      events: completedAfterDeadline.events.map((event) =>
        event.category === "submission"
          ? { ...event, createdAt: "2026-08-15T08:30:00.000Z" }
          : event),
    };
    expect(coordinationStateMatches(completionWithLateSubmission, {
      projectId, taskId, expectedProjectRevision: 3,
    }), "a fabricated submission at the delegation deadline cannot justify late completion")
      .toBe(false);
    expect(coordinationStateMatches({
      ...completionWithLateSubmission,
      submission: {
        ...completionWithLateSubmission.submission,
        submittedAt: "2026-08-15T08:30:01.000Z",
      },
      events: completionWithLateSubmission.events.map((event) =>
        event.category === "submission"
          ? { ...event, createdAt: "2026-08-15T08:30:01.000Z" }
          : event),
    }, { projectId, taskId, expectedProjectRevision: 3 }),
    "a fabricated submission after the delegation deadline cannot justify late completion")
      .toBe(false);

    for (const [submittedAt, expiresAt, absoluteExpiresAt] of [
      ["2026-08-15T08:30:00.000Z", claim.expiresAt, claim.absoluteExpiresAt],
      ["2026-08-15T08:30:01.000Z", claim.expiresAt, claim.absoluteExpiresAt],
      ["2026-08-15T12:00:00.000Z", claim.absoluteExpiresAt, claim.absoluteExpiresAt],
      ["2026-08-15T12:00:01.000Z", claim.absoluteExpiresAt, claim.absoluteExpiresAt],
    ] as const) {
      const boundarySubmission = {
        ...state,
        claim: {
          ...state.claim,
          expiresAt,
          absoluteExpiresAt,
          endedAt: submittedAt,
        },
        submission: { ...state.submission, submittedAt },
        events: state.events.map((event) => event.category === "submission"
          ? { ...event, createdAt: submittedAt }
          : event),
      };
      expect(coordinationStateMatches(boundarySubmission, {
        projectId, taskId, expectedProjectRevision: 3,
      }), "submission must be strictly before each claim horizon").toBe(false);
    }

    expect(coordinationStateMatches({
      ...completed,
      submission: { ...completed.submission, decidedAt: "2026-08-15T08:00:01.000Z" },
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
    expect(coordinationStateMatches({
      ...completed,
      events: completed.events.map((event) => event.id === "event-reconciliation"
        ? { ...event, createdAt: "2026-08-15T08:00:01.000Z" }
        : event),
    }, { projectId, taskId, expectedProjectRevision: 3 })).toBe(false);
  });

  it("binds claim and claim-scoped operations to exact scope, state, revisions, and documents", () => {
    const claimInput = {
      projectId, taskId, expectedProjectRevision: 3, expectedTaskRevision: 7,
      contextBudgetTokens: 4_096, acceptedDelegationId: null,
      idempotencyKey: "claim-input",
    };
    const claimed = { claim, readiness, contextPack };
    rejectsMutations(claimed, (output) => claimTaskResultMatches(output, claimInput, profileId), [
      ["claim state", (value) => { value.claim.state = "paused"; }],
      ["claim project", (value) => { value.claim.projectId = "project-other"; }],
      ["claim task", (value) => { value.claim.taskId = "task-other"; }],
      ["claim owner", (value) => { value.claim.profileId = "profile-other"; }],
      ["claim base project revision", (value) => { value.claim.baseProjectRevision = 4; }],
      ["claim base task revision", (value) => { value.claim.baseTaskRevision = 8; }],
      ["claim delegation", (value) => { value.claim.delegationId = "delegation-other"; }],
      ["claim ended timestamp", (value) => { value.claim.endedAt = timestamp; }],
      ["claim latest checkpoint", (value) => { value.claim.latestCheckpointId = checkpoint.id; }],
      ["claim readiness project", (value) => { value.readiness.task.projectId = "project-other"; }],
      ["claim readiness task", (value) => { value.readiness.task.id = "task-other"; }],
      ["claim readiness blockers", (value) => { value.readiness.blockers = ["claim_active:x"]; }],
      ["claim readiness live claim", (value) => { value.readiness.liveClaimId = "claim-other"; }],
      ["claim readiness delegation", (value) => { value.readiness.liveDelegationId = delegation.id; }],
      ["claim readiness task revision", (value) => { value.readiness.task.revision = 8; }],
      ["claim readiness task kind", (value) => { value.readiness.task.kind = "evidence"; }],
      ["claim readiness task status", (value) => { value.readiness.task.status = "blocked"; }],
      ["claim context project", (value) => { value.contextPack.projectId = "project-other"; }],
      ["claim context task", (value) => { value.contextPack.taskId = "task-other"; }],
      ["claim context project revision", (value) => { value.contextPack.projectRevision = 4; }],
      ["claim context budget", (value) => { value.contextPack.budgetTokens = 1; }],
      ["claim context mandatory", (value) => { value.contextPack.task.mandatory = false; }],
      ["claim context relevance", (value) => { value.contextPack.task.relevance = "linked"; }],
      ["claim context relationship", (value) => { value.contextPack.task.relationshipKind = "supports"; }],
      ["claim context record project", (value) => { value.contextPack.task.record.projectId = "project-other"; }],
      ["claim context record task", (value) => { value.contextPack.task.record.id = "task-other"; }],
      ["claim context task revision", (value) => { value.contextPack.task.record.revision = 8; }],
      ["claim context task bytes", (value) => { value.contextPack.task.record.title = "Other"; }],
      ["claim source revision", (value) => {
        value.contextPack.sourceRevisions.find(({ recordId }) => recordId === taskId)!.revision = 8;
      }],
      ["claim source task", (value) => {
        value.contextPack.sourceRevisions.find(({ recordId }) => recordId === taskId)!.recordId = "task-other";
      }],
      ["claim duplicate source", (value) => {
        value.contextPack.sourceRevisions.push({ recordId: taskId, revision: 7 });
      }],
      ["claim stable record project", (value) => {
        value.contextPack.stableFrame[0]!.record.projectId = "project-other";
      }],
      ["claim stable mandatory", (value) => { value.contextPack.stableFrame[0]!.mandatory = false; }],
      ["claim stable relevance", (value) => {
        value.contextPack.stableFrame[0]!.relevance = "linked";
      }],
      ["claim stable relationship", (value) => {
        value.contextPack.stableFrame[0]!.relationshipKind = "supports";
      }],
      ["claim stable source revision", (value) => {
        value.contextPack.sourceRevisions.find(({ recordId }) => recordId === stableRecord.id)!
          .revision = 3;
      }],
      ["claim related record project", (value) => {
        value.contextPack.related[0]!.record.projectId = "project-other";
      }],
      ["claim related mandatory", (value) => { value.contextPack.related[0]!.mandatory = true; }],
      ["claim related relevance", (value) => {
        value.contextPack.related[0]!.relevance = "stable_frame";
      }],
      ["claim related relationship", (value) => {
        value.contextPack.related[0]!.relationshipKind = null;
      }],
      ["claim omission retrieval scope", (value) => {
        value.contextPack.omissions[0]!.retrievalRef =
          "intentarc://projects/project-other/records/omitted-1";
      }],
      ["claim context ID", (value) => { value.contextPack.id = "pack-other"; }],
    ]);

    const renewInput = {
      claimId: claim.id, expectedProjectRevision: 3, expectedTaskRevision: 7,
      idempotencyKey: "renew-input",
    };
    rejectsMutations({ claim }, (output) =>
      renewClaimResultMatches(output, renewInput, profileId, claimSnapshot), [
      ["renew claim ID", (value) => { value.claim.id = "claim-other"; }],
      ["renew project", (value) => { value.claim.projectId = "project-other"; }],
      ["renew task", (value) => { value.claim.taskId = "task-other"; }],
      ["renew owner", (value) => { value.claim.profileId = "profile-other"; }],
      ["renew state", (value) => { value.claim.state = "paused"; }],
      ["renew ended timestamp", (value) => { value.claim.endedAt = timestamp; }],
      ["renew future project revision", (value) => { value.claim.baseProjectRevision = 4; }],
      ["renew future task revision", (value) => { value.claim.baseTaskRevision = 8; }],
      ["renew paired lower revisions", (value) => {
        value.claim.baseProjectRevision = 2; value.claim.baseTaskRevision = 6;
      }],
      ["renew context", (value) => { value.claim.contextPackId = "pack-other"; }],
      ["renew delegation", (value) => { value.claim.delegationId = delegation.id; }],
      ["renew acquired", (value) => { value.claim.acquiredAt = "2026-08-15T07:00:00.000Z"; }],
      ["renew absolute", (value) => {
        value.claim.absoluteExpiresAt = "2026-08-15T11:00:00.000Z";
      }],
    ]);
    const historicalSnapshot = {
      ...claimSnapshot,
      baseProjectRevision: 2,
      baseTaskRevision: 6,
    };
    expect(renewClaimResultMatches(
      { claim: historicalSnapshot },
      renewInput,
      profileId,
      historicalSnapshot,
    )).toBe(true);

    const checkpointInput = {
      claimId: claim.id, expectedProjectRevision: 3, expectedTaskRevision: 7,
      checkpoint: checkpointDocument, idempotencyKey: "checkpoint-input",
    };
    const checkpointed = {
      claim: { ...claim, latestCheckpointId: checkpoint.id },
      checkpoint,
    };
    rejectsMutations(checkpointed, (output) =>
      checkpointResultMatches(output, checkpointInput, profileId, claimSnapshot), [
      ["checkpoint claim ID", (value) => { value.claim.id = "claim-other"; }],
      ["checkpoint project", (value) => { value.claim.projectId = "project-other"; }],
      ["checkpoint task", (value) => { value.claim.taskId = "task-other"; }],
      ["checkpoint owner", (value) => { value.claim.profileId = "profile-other"; }],
      ["checkpoint claim state", (value) => { value.claim.state = "paused"; }],
      ["checkpoint claim end", (value) => { value.claim.endedAt = timestamp; }],
      ["checkpoint future claim project", (value) => { value.claim.baseProjectRevision = 4; }],
      ["checkpoint future claim task", (value) => { value.claim.baseTaskRevision = 8; }],
      ["checkpoint paired lower revisions", (value) => {
        value.claim.baseProjectRevision = 2; value.claim.baseTaskRevision = 6;
      }],
      ["checkpoint paired claim context", (value) => {
        value.claim.contextPackId = "pack-other";
        value.checkpoint.contextPackId = "pack-other";
      }],
      ["checkpoint claim delegation", (value) => { value.claim.delegationId = delegation.id; }],
      ["checkpoint claim acquired", (value) => {
        value.claim.acquiredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["checkpoint claim absolute", (value) => {
        value.claim.absoluteExpiresAt = "2026-08-15T11:00:00.000Z";
      }],
      ["checkpoint row claim", (value) => { value.checkpoint.claimId = "claim-other"; }],
      ["checkpoint latest link", (value) => { value.claim.latestCheckpointId = "checkpoint-other"; }],
      ["checkpoint summary", (value) => { value.checkpoint.summary = "Other"; }],
      ["checkpoint completed work", (value) => { value.checkpoint.completedWork = []; }],
      ["checkpoint remaining work", (value) => { value.checkpoint.remainingWork = []; }],
      ["checkpoint blockers", (value) => { value.checkpoint.blockers = ["blocked"]; }],
      ["checkpoint verification", (value) => { value.checkpoint.verificationEvidence.tests = []; }],
      ["checkpoint repository", (value) => { value.checkpoint.repositoryEvidence!.commits = []; }],
      ["checkpoint project revision", (value) => { value.checkpoint.projectRevision = 4; }],
      ["checkpoint task revision", (value) => { value.checkpoint.taskRevision = 8; }],
      ["checkpoint context", (value) => { value.checkpoint.contextPackId = "pack-other"; }],
    ]);

    const transitionInput = {
      claimId: claim.id, expectedProjectRevision: 3, expectedTaskRevision: 7,
      action: "pause" as const, idempotencyKey: "transition-input",
    };
    const transitioned = { claim: { ...claim, state: "paused" as const, endedAt: timestamp } };
    rejectsMutations(transitioned, (output) =>
      transitionClaimResultMatches(output, transitionInput, profileId, claimSnapshot), [
      ["transition claim ID", (value) => { value.claim.id = "claim-other"; }],
      ["transition project", (value) => { value.claim.projectId = "project-other"; }],
      ["transition task", (value) => { value.claim.taskId = "task-other"; }],
      ["transition owner", (value) => { value.claim.profileId = "profile-other"; }],
      ["transition state", (value) => { value.claim.state = "released"; }],
      ["transition missing end", (value) => { value.claim.endedAt = null; }],
      ["transition future project revision", (value) => { value.claim.baseProjectRevision = 4; }],
      ["transition future task revision", (value) => { value.claim.baseTaskRevision = 8; }],
      ["transition paired lower revisions", (value) => {
        value.claim.baseProjectRevision = 2; value.claim.baseTaskRevision = 6;
      }],
      ["transition context", (value) => { value.claim.contextPackId = "pack-other"; }],
      ["transition delegation", (value) => { value.claim.delegationId = delegation.id; }],
      ["transition acquired", (value) => {
        value.claim.acquiredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["transition absolute", (value) => {
        value.claim.absoluteExpiresAt = "2026-08-15T11:00:00.000Z";
      }],
    ]);
  });

  it("binds switch output to both exact tasks, checkpoint document, and next context", () => {
    const input = {
      currentClaimId: claim.id, projectId, currentTaskId: taskId,
      expectedCurrentProjectRevision: 3, expectedCurrentTaskRevision: 7,
      checkpoint: checkpointDocument, terminalAction: "pause" as const,
      nextTaskId, expectedNextProjectRevision: 3, expectedNextTaskRevision: 4,
      nextContextBudgetTokens: 4_096, acceptedDelegationId: null,
      idempotencyKey: "switch-input",
    };
    const nextContext = {
      ...contextPack,
      id: "pack-2",
      taskId: nextTaskId,
      task: { ...contextPack.task, record: nextTask },
      sourceRevisions: [
        { recordId: relatedRecord.id, revision: relatedRecord.revision },
        { recordId: nextTaskId, revision: 4 },
        { recordId: stableRecord.id, revision: stableRecord.revision },
      ].sort((left, right) => left.recordId.localeCompare(right.recordId)),
    };
    const switched = {
      previousClaim: {
        ...claim, state: "paused" as const, endedAt: timestamp,
        latestCheckpointId: checkpoint.id,
      },
      nextClaim: {
        ...claim, id: "claim-2", taskId: nextTaskId, baseTaskRevision: 4,
        contextPackId: nextContext.id,
      },
      checkpoint,
      contextPack: nextContext,
    };
    rejectsMutations(switched, (output) =>
      switchTaskResultMatches(output, input, profileId, claimSnapshot), [
      ["switch previous ID", (value) => { value.previousClaim.id = "claim-other"; }],
      ["switch previous project", (value) => { value.previousClaim.projectId = "project-other"; }],
      ["switch previous task", (value) => { value.previousClaim.taskId = "task-other"; }],
      ["switch previous owner", (value) => { value.previousClaim.profileId = "profile-other"; }],
      ["switch previous state", (value) => { value.previousClaim.state = "released"; }],
      ["switch previous end", (value) => { value.previousClaim.endedAt = null; }],
      ["switch previous paired lower revisions", (value) => {
        value.previousClaim.baseProjectRevision = 2;
        value.previousClaim.baseTaskRevision = 6;
      }],
      ["switch paired previous context", (value) => {
        value.previousClaim.contextPackId = "pack-other";
        value.checkpoint.contextPackId = "pack-other";
      }],
      ["switch previous delegation", (value) => {
        value.previousClaim.delegationId = delegation.id;
      }],
      ["switch previous acquired", (value) => {
        value.previousClaim.acquiredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["switch previous absolute", (value) => {
        value.previousClaim.absoluteExpiresAt = "2026-08-15T11:00:00.000Z";
      }],
      ["switch latest checkpoint", (value) => { value.previousClaim.latestCheckpointId = "checkpoint-other"; }],
      ["switch checkpoint claim", (value) => { value.checkpoint.claimId = "claim-other"; }],
      ["switch checkpoint context", (value) => { value.checkpoint.contextPackId = "pack-other"; }],
      ["switch checkpoint summary", (value) => { value.checkpoint.summary = "Other"; }],
      ["switch checkpoint completed", (value) => { value.checkpoint.completedWork = []; }],
      ["switch checkpoint remaining", (value) => { value.checkpoint.remainingWork = []; }],
      ["switch checkpoint blockers", (value) => { value.checkpoint.blockers = ["blocked"]; }],
      ["switch checkpoint verification", (value) => { value.checkpoint.verificationEvidence.tests = []; }],
      ["switch checkpoint repository", (value) => { value.checkpoint.repositoryEvidence!.commits = []; }],
      ["switch checkpoint project revision", (value) => { value.checkpoint.projectRevision = 4; }],
      ["switch checkpoint task revision", (value) => { value.checkpoint.taskRevision = 8; }],
      ["switch next project", (value) => { value.nextClaim.projectId = "project-other"; }],
      ["switch next task", (value) => { value.nextClaim.taskId = "task-other"; }],
      ["switch next owner", (value) => { value.nextClaim.profileId = "profile-other"; }],
      ["switch next delegation", (value) => { value.nextClaim.delegationId = delegation.id; }],
      ["switch next state", (value) => { value.nextClaim.state = "paused"; }],
      ["switch next end", (value) => { value.nextClaim.endedAt = timestamp; }],
      ["switch next latest checkpoint", (value) => { value.nextClaim.latestCheckpointId = checkpoint.id; }],
      ["switch next base project revision", (value) => { value.nextClaim.baseProjectRevision = 4; }],
      ["switch next base task revision", (value) => { value.nextClaim.baseTaskRevision = 5; }],
      ["switch context project revision", (value) => { value.contextPack.projectRevision = 4; }],
      ["switch context budget", (value) => { value.contextPack.budgetTokens = 1; }],
      ["switch context project", (value) => { value.contextPack.projectId = "project-other"; }],
      ["switch context task", (value) => { value.contextPack.taskId = "task-other"; }],
      ["switch context mandatory", (value) => { value.contextPack.task.mandatory = false; }],
      ["switch context record project", (value) => { value.contextPack.task.record.projectId = "project-other"; }],
      ["switch context record task", (value) => { value.contextPack.task.record.id = "task-other"; }],
      ["switch context task revision", (value) => { value.contextPack.task.record.revision = 5; }],
      ["switch context source revision", (value) => {
        value.contextPack.sourceRevisions.find(({ recordId }) => recordId === nextTaskId)!
          .revision = 5;
      }],
      ["switch context source task", (value) => {
        value.contextPack.sourceRevisions.find(({ recordId }) => recordId === nextTaskId)!
          .recordId = "task-other";
      }],
      ["switch context ID", (value) => { value.contextPack.id = "pack-other"; }],
    ]);
  });

  it("binds delegation operations to exact immutable input and requested action states", () => {
    const createInput = {
      projectId, taskId, childProfileId: delegation.childProfileId,
      expectedProjectRevision: 3, expectedTaskRevision: 7,
      scope: delegation.scope, allowedOutputs: [...delegation.allowedOutputs],
      deadline: "2026-08-15T10:00Z", idempotencyKey: "delegate-input",
    };
    rejectsMutations({ delegation }, (output) =>
      createdDelegationResultMatches(output, createInput, profileId), [
      ["create project", (value) => { value.delegation.projectId = "project-other"; }],
      ["create task", (value) => { value.delegation.taskId = "task-other"; }],
      ["create parent", (value) => { value.delegation.parentProfileId = "profile-other"; }],
      ["create child", (value) => { value.delegation.childProfileId = "profile-other"; }],
      ["create state", (value) => { value.delegation.state = "accepted"; }],
      ["create base project revision", (value) => { value.delegation.baseProjectRevision = 4; }],
      ["create base task revision", (value) => { value.delegation.baseTaskRevision = 8; }],
      ["create accepted timestamp", (value) => { value.delegation.acceptedAt = timestamp; }],
      ["create end timestamp", (value) => { value.delegation.endedAt = timestamp; }],
      ["create claim link", (value) => { value.delegation.claimId = claim.id; }],
      ["create deadline", (value) => { value.delegation.deadline = "2026-08-15T11:00:00.000Z"; }],
      ["create scope", (value) => { value.delegation.scope.constraints = []; }],
      ["create allowed outputs", (value) => { value.delegation.allowedOutputs = ["update_record"]; }],
    ]);

    const acceptInput = {
      delegationId: delegation.id, projectId, taskId,
      expectedProjectRevision: 3, expectedTaskRevision: 7,
      idempotencyKey: "accept-input",
    };
    const accepted = {
      delegation: {
        ...delegation, state: "accepted" as const, childProfileId: profileId,
        acceptedAt: timestamp,
      },
    };
    const offeredToActor = { ...delegation, childProfileId: profileId };
    rejectsMutations(accepted, (output) =>
      acceptedDelegationResultMatches(output, acceptInput, profileId, offeredToActor), [
      ["accept ID", (value) => { value.delegation.id = "delegation-other"; }],
      ["accept project", (value) => { value.delegation.projectId = "project-other"; }],
      ["accept task", (value) => { value.delegation.taskId = "task-other"; }],
      ["accept child", (value) => { value.delegation.childProfileId = "profile-other"; }],
      ["accept parent", (value) => { value.delegation.parentProfileId = "profile-other"; }],
      ["accept base project", (value) => { value.delegation.baseProjectRevision = 4; }],
      ["accept base task", (value) => { value.delegation.baseTaskRevision = 8; }],
      ["accept deadline", (value) => { value.delegation.deadline = "2026-08-15T11:00:00.000Z"; }],
      ["accept offered timestamp", (value) => {
        value.delegation.offeredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["accept scope", (value) => { value.delegation.scope.constraints = []; }],
      ["accept allowed outputs", (value) => { value.delegation.allowedOutputs = ["update_record"]; }],
      ["accept state", (value) => { value.delegation.state = "offered"; }],
      ["accept missing timestamp", (value) => { value.delegation.acceptedAt = null; }],
      ["accept end timestamp", (value) => { value.delegation.endedAt = timestamp; }],
      ["accept claim link", (value) => { value.delegation.claimId = claim.id; }],
    ]);
    expect(acceptedDelegationResultMatches(
      accepted,
      acceptInput,
      profileId,
      accepted.delegation,
    )).toBe(true);

    const revokeInput = { ...acceptInput, idempotencyKey: "revoke-input" };
    const revoked = {
      delegation: {
        ...delegation, state: "revoked" as const, parentProfileId: profileId,
        endedAt: timestamp,
      },
    };
    rejectsMutations(revoked, (output) =>
      revokedDelegationResultMatches(output, revokeInput, profileId, delegation), [
      ["revoke ID", (value) => { value.delegation.id = "delegation-other"; }],
      ["revoke project", (value) => { value.delegation.projectId = "project-other"; }],
      ["revoke task", (value) => { value.delegation.taskId = "task-other"; }],
      ["revoke parent", (value) => { value.delegation.parentProfileId = "profile-other"; }],
      ["revoke child", (value) => { value.delegation.childProfileId = "profile-other"; }],
      ["revoke base project", (value) => { value.delegation.baseProjectRevision = 4; }],
      ["revoke base task", (value) => { value.delegation.baseTaskRevision = 8; }],
      ["revoke deadline", (value) => { value.delegation.deadline = "2026-08-15T11:00:00.000Z"; }],
      ["revoke offered timestamp", (value) => {
        value.delegation.offeredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["revoke accepted timestamp", (value) => { value.delegation.acceptedAt = timestamp; }],
      ["revoke scope", (value) => { value.delegation.scope.constraints = []; }],
      ["revoke allowed outputs", (value) => { value.delegation.allowedOutputs = ["update_record"]; }],
      ["revoke state", (value) => { value.delegation.state = "offered"; }],
      ["revoke missing end", (value) => { value.delegation.endedAt = null; }],
      ["revoke claim link", (value) => { value.delegation.claimId = claim.id; }],
    ]);
    expect(revokedDelegationResultMatches(
      revoked,
      revokeInput,
      profileId,
      revoked.delegation,
    )).toBe(true);
  });

  it("binds normal and conflicted submissions to exact visible source evidence and state tuples", () => {
    const input = {
      claimId: claim.id, checkpointId: checkpoint.id,
      expectedProjectRevision: 3, expectedTaskRevision: 7,
      submission: submissionDocument, idempotencyKey: "submit-input",
    };
    const submitted = {
      claim: {
        ...claim, state: "submitted" as const, endedAt: timestamp,
        latestCheckpointId: checkpoint.id,
      },
      submission,
      proposal,
    };
    const matches = (output: typeof submitted) =>
      submissionResultMatches(output, input, profileId, claimSnapshot);
    rejectsMutations(submitted, matches, [
      ["submit claim ID", (value) => { value.claim.id = "claim-other"; }],
      ["submit claim project", (value) => { value.claim.projectId = "project-other"; }],
      ["submit claim task", (value) => { value.claim.taskId = "task-other"; }],
      ["submit claim owner", (value) => { value.claim.profileId = "profile-other"; }],
      ["submit claim state", (value) => { value.claim.state = "active"; }],
      ["submit claim end", (value) => { value.claim.endedAt = null; }],
      ["submit claim base project", (value) => { value.claim.baseProjectRevision = 4; }],
      ["submit claim base task", (value) => { value.claim.baseTaskRevision = 8; }],
      ["submit claim checkpoint", (value) => { value.claim.latestCheckpointId = "checkpoint-other"; }],
      ["submit paired lower revisions", (value) => {
        value.claim.baseProjectRevision = 2; value.claim.baseTaskRevision = 6;
      }],
      ["submit paired claim context", (value) => {
        value.claim.contextPackId = "pack-other";
        value.submission.contextPackId = "pack-other";
      }],
      ["submit claim delegation", (value) => { value.claim.delegationId = delegation.id; }],
      ["submit claim acquired", (value) => {
        value.claim.acquiredAt = "2026-08-15T07:00:00.000Z";
      }],
      ["submit claim absolute", (value) => {
        value.claim.absoluteExpiresAt = "2026-08-15T11:00:00.000Z";
      }],
      ["submit base project", (value) => { value.submission.baseProjectRevision = 4; }],
      ["submit base task", (value) => { value.submission.baseTaskRevision = 8; }],
      ["submit project", (value) => { value.submission.projectId = "project-other"; }],
      ["submit task", (value) => { value.submission.taskId = "task-other"; }],
      ["submit claim link", (value) => { value.submission.claimId = "claim-other"; }],
      ["submit owner", (value) => { value.submission.profileId = "profile-other"; }],
      ["submit checkpoint", (value) => { value.submission.checkpointId = "checkpoint-other"; }],
      ["submit context", (value) => { value.submission.contextPackId = "pack-other"; }],
      ["submit summary", (value) => { value.submission.summary = "Other"; }],
      ["submit verification", (value) => { value.submission.verificationEvidence.tests = []; }],
      ["submit repository", (value) => { value.submission.repositoryEvidence!.commits = []; }],
      ["submit state tuple", (value) => { value.submission.state = "conflicted"; }],
      ["submit decided timestamp", (value) => { value.submission.decidedAt = timestamp; }],
      ["submit proposal link", (value) => { value.submission.proposalId = "proposal-other"; }],
      ["proposal ID", (value) => { value.proposal.id = "proposal-other"; }],
      ["proposal project", (value) => { value.proposal.projectId = "project-other"; }],
      ["proposal state tuple", (value) => { value.proposal.state = "conflicted"; }],
      ["proposal base project", (value) => { value.proposal.baseProjectRevision = 4; }],
      ["proposal rationale", (value) => { value.proposal.rationale = "Other"; }],
      ["proposal source task", (value) => { value.proposal.sourceTaskId = "task-other"; }],
      ["proposal predecessor", (value) => { value.proposal.predecessorProposalId = "proposal-old"; }],
      ["proposal origin type", (value) => { value.proposal.origin = { type: "repository", repositorySnapshotId: "snapshot" }; }],
      ["proposal origin profile", (value) => { value.proposal.origin.profileId = "profile-other"; }],
      ["proposal reviewer", (value) => { value.proposal.reviewerActor = "reviewer"; }],
      ["proposal reviewed timestamp", (value) => { value.proposal.reviewedAt = timestamp; }],
      ["proposal review reason", (value) => { value.proposal.reviewReason = "reason"; }],
    ]);

    const conflicted = structuredClone(submitted) as any;
    conflicted.submission.state = "conflicted";
    conflicted.submission.decidedAt = timestamp;
    conflicted.proposal.state = "conflicted";
    expect(submissionResultMatches(conflicted, input, profileId, claimSnapshot)).toBe(true);
  });
});
