import type { z } from "zod";
import type {
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  claimTaskInputSchema,
  coordinationStateInputSchema,
  createDelegationInputSchema,
  listReadyTasksInputSchema,
  renewClaimInputSchema,
  revokeDelegationInputSchema,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  transitionClaimInputSchema,
} from "./coordination-schemas.js";
import type {
  ChangeOperationType,
  ChangeProposal,
  SubmitChangeSetInput,
} from "./governance-model.js";
import type { ProjectRecord, TaskContextPack } from "./model.js";

export type TaskClaimState =
  | "active" | "paused" | "released" | "submitted" | "expired" | "reconciled";
export type TaskDelegationState =
  | "offered" | "accepted" | "revoked" | "expired" | "claimed" | "completed";
export type TaskSubmissionState =
  | "submitted" | "conflicted" | "accepted" | "rejected" | "withdrawn";
export const coordinationIdempotencyOperations = {
  claim: "claim",
  renew: "renew",
  checkpoint: "checkpoint",
  transition: "transition",
  switch: "switch",
  createDelegation: "create_delegation",
  acceptDelegation: "accept_delegation",
  revokeDelegation: "revoke_delegation",
  submit: "submit",
} as const;
export type CoordinationIdempotencyOperation =
  typeof coordinationIdempotencyOperations[keyof typeof coordinationIdempotencyOperations];
export type CoordinationErrorCode =
  | "task_not_ready" | "claim_conflict" | "claim_expired"
  | "lease_horizon_reached" | "revision_conflict"
  | "delegation_conflict" | "delegation_expired" | "delegation_revoked"
  | "checkpoint_invalid" | "submission_stale"
  | "submission_invalid" | "coordination_authority_denied"
  | "coordination_idempotency_conflict" | "coordination_unavailable";

export interface VerificationEvidence {
  tests: string[];
  artifacts: string[];
}

export interface RepositoryEvidence {
  branch: string | null;
  worktree: string | null;
  commits: string[];
  artifacts: string[];
}

export interface CheckpointDocument {
  summary: string;
  completedWork: string[];
  remainingWork: string[];
  blockers: string[];
  verificationEvidence: VerificationEvidence;
  repositoryEvidence: RepositoryEvidence | null;
}

export interface DelegationScope {
  summary: string;
  constraints: string[];
}

export interface SubmissionDocument {
  summary: string;
  verificationEvidence: VerificationEvidence;
  repositoryEvidence: RepositoryEvidence | null;
  changes: Pick<SubmitChangeSetInput, "rationale" | "operations">;
}

export interface TaskClaim {
  id: string;
  projectId: string;
  taskId: string;
  profileId: string;
  delegationId: string | null;
  state: TaskClaimState;
  baseProjectRevision: number;
  baseTaskRevision: number;
  contextPackId: string;
  acquiredAt: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  endedAt: string | null;
  latestCheckpointId: string | null;
}

export interface TaskCheckpoint extends CheckpointDocument {
  id: string;
  claimId: string;
  sequence: number;
  createdAt: string;
  projectRevision: number;
  taskRevision: number;
  contextPackId: string;
}

export interface TaskDelegation {
  id: string;
  projectId: string;
  taskId: string;
  parentProfileId: string;
  childProfileId: string;
  state: TaskDelegationState;
  baseProjectRevision: number;
  baseTaskRevision: number;
  scope: DelegationScope;
  allowedOutputs: ChangeOperationType[];
  offeredAt: string;
  deadline: string;
  acceptedAt: string | null;
  endedAt: string | null;
  claimId: string | null;
}

export interface TaskSubmission extends Omit<SubmissionDocument, "changes"> {
  id: string;
  claimId: string;
  checkpointId: string;
  profileId: string;
  projectId: string;
  taskId: string;
  baseProjectRevision: number;
  baseTaskRevision: number;
  contextPackId: string;
  proposalId: string;
  state: TaskSubmissionState;
  submittedAt: string;
  decidedAt: string | null;
}

export interface CoordinationEvent {
  id: string;
  category: "ready_evaluation" | "claim" | "renewal" | "checkpoint" | "pause" | "release"
    | "switch" | "expiry" | "delegation_offer" | "delegation_accept" | "delegation_revoke"
    | "submission" | "conflict" | "reconciliation";
  projectId: string;
  taskId: string;
  profileId: string | null;
  claimId: string | null;
  delegationId: string | null;
  checkpointId: string | null;
  submissionId: string | null;
  proposalId: string | null;
  priorState: string | null;
  resultingState: string | null;
  projectRevision: number;
  taskRevision: number;
  detail: string | null;
  createdAt: string;
}

export interface ReadyTask {
  task: ProjectRecord;
  blockers: string[];
  liveClaimId: string | null;
  liveDelegationId: string | null;
}

export interface ReadyTaskPage {
  tasks: ReadyTask[];
  nextCursor: string | null;
  projectRevision: number;
}

export interface CoordinationState {
  projectRevision: number;
  task: ProjectRecord;
  claim: TaskClaim | null;
  delegation: TaskDelegation | null;
  latestCheckpoint: TaskCheckpoint | null;
  submission: TaskSubmission | null;
  events: CoordinationEvent[];
}

export type ListReadyTasksInput = z.infer<typeof listReadyTasksInputSchema>;
export type CoordinationStateInput = z.infer<typeof coordinationStateInputSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;
export type RenewClaimInput = z.infer<typeof renewClaimInputSchema>;
export type CheckpointClaimInput = z.infer<typeof checkpointClaimInputSchema>;
export type TransitionClaimInput = z.infer<typeof transitionClaimInputSchema>;
export type SwitchTaskInput = z.infer<typeof switchTaskInputSchema>;
export type CreateDelegationInput = z.infer<typeof createDelegationInputSchema>;
export type AcceptDelegationInput = z.infer<typeof acceptDelegationInputSchema>;
export type RevokeDelegationInput = z.infer<typeof revokeDelegationInputSchema>;
export type SubmitTaskResultInput = z.infer<typeof submitTaskResultInputSchema>;

export interface ClaimTaskResult {
  claim: TaskClaim;
  readiness: ReadyTask;
  contextPack: TaskContextPack;
}

export interface RenewClaimResult { claim: TaskClaim; }
export interface CheckpointResult { claim: TaskClaim; checkpoint: TaskCheckpoint; }
export interface TransitionClaimResult { claim: TaskClaim; }
export interface SwitchTaskResult {
  previousClaim: TaskClaim;
  nextClaim: TaskClaim;
  checkpoint: TaskCheckpoint;
  contextPack: TaskContextPack;
}
export interface DelegationResult { delegation: TaskDelegation; }
export interface SubmissionResult {
  claim: TaskClaim;
  submission: TaskSubmission;
  proposal: ChangeProposal;
}

import type { AuthenticatedProfile } from "./governance-model.js";

export interface CoordinationService {
  listReadyTasks(input: ListReadyTasksInput, principal: AuthenticatedProfile): ReadyTaskPage;
  getCoordinationState(input: CoordinationStateInput, principal: AuthenticatedProfile): CoordinationState;
  claimTask(input: ClaimTaskInput, principal: AuthenticatedProfile): ClaimTaskResult;
  renewClaim(input: RenewClaimInput, principal: AuthenticatedProfile): RenewClaimResult;
  checkpointClaim(input: CheckpointClaimInput, principal: AuthenticatedProfile): CheckpointResult;
  transitionClaim(input: TransitionClaimInput, principal: AuthenticatedProfile): TransitionClaimResult;
  switchTask(input: SwitchTaskInput, principal: AuthenticatedProfile): SwitchTaskResult;
  createDelegation(input: CreateDelegationInput, principal: AuthenticatedProfile): DelegationResult;
  acceptDelegation(input: AcceptDelegationInput, principal: AuthenticatedProfile): DelegationResult;
  revokeDelegation(input: RevokeDelegationInput, principal: AuthenticatedProfile): DelegationResult;
  submitTaskResult(input: SubmitTaskResultInput, principal: AuthenticatedProfile): SubmissionResult;
}
