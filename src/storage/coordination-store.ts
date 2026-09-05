import { createHash, randomUUID } from "node:crypto";
import type { ChangeSubmissionResult } from "../core/change-service.js";
import {
  CoordinationError,
  coordinationIdempotencyOperations,
  checkpointDocumentSchema,
  coordinationTimestampSchema,
  createDelegationInputSchema,
  submissionDocumentSchema,
  submitChangeSetInputSchema,
  taskDelegationSchema,
  taskContextPackSchema,
  type AcceptDelegationInput,
  type CheckpointClaimInput,
  type CheckpointResult,
  type ClaimTaskInput,
  type ClaimTaskResult,
  type CoordinationEvent,
  type CoordinationState,
  type CoordinationStateInput,
  type CoordinationIdempotencyOperation,
  type CreateDelegationInput,
  type DelegationResult,
  type ListReadyTasksInput,
  type ProjectRecord,
  type ReadyTask,
  type ReadyTaskPage,
  type RenewClaimInput,
  type RenewClaimResult,
  type RevokeDelegationInput,
  type SubmissionResult,
  type SubmitChangeSetInput,
  type SubmitTaskResultInput,
  type SwitchTaskInput,
  type SwitchTaskResult,
  type TaskCheckpoint,
  type TaskClaim,
  type TaskContextPack,
  type TaskDelegation,
  type TaskSubmission,
  type TransitionClaimInput,
  type TransitionClaimResult,
} from "../domain/index.js";
import type { IntentArcDatabase } from "./database.js";
import { mapProjectRecordRow, type ProjectRecordRow } from "./row-mappers.js";
import { mapChangeProposalRow, type ChangeProposalRow } from "./governance-mappers.js";

interface AuthorizedCommand<Input, Ids> {
  profileId: string;
  credentialGeneration: string;
  requestHash: string;
  now: string;
  input: Input;
  ids: Ids;
}

export interface AuthorizedClaimCommand extends AuthorizedCommand<ClaimTaskInput, {
  claimId: string;
  eventId: string;
}> {}
export interface AuthorizedRenewCommand extends AuthorizedCommand<RenewClaimInput, {
  eventId: string;
}> {}
export interface AuthorizedCheckpointCommand extends AuthorizedCommand<CheckpointClaimInput, {
  checkpointId: string;
  checkpointEventId: string;
  renewalEventId: string;
}> {}
export interface AuthorizedTransitionCommand extends AuthorizedCommand<TransitionClaimInput, {
  eventId: string;
}> {}
export interface AuthorizedSwitchCommand extends AuthorizedCommand<SwitchTaskInput, {
  checkpointId: string;
  nextClaimId: string;
  checkpointEventId: string;
  transitionEventId: string;
  claimEventId: string;
}> {}
export interface AuthorizedDelegationCommand extends AuthorizedCommand<CreateDelegationInput, {
  delegationId: string;
  eventId: string;
}> {}
export interface AuthorizedAcceptDelegationCommand extends AuthorizedCommand<AcceptDelegationInput, {
  eventId: string;
}> {}
export interface AuthorizedRevokeDelegationCommand extends AuthorizedCommand<RevokeDelegationInput, {
  eventId: string;
}> {}
export interface AuthorizedSubmissionCommand extends AuthorizedCommand<SubmitTaskResultInput, {
  submissionId: string;
  eventId: string;
}> {}

export interface CoordinationStore {
  listReadyTasks(input: ListReadyTasksInput, profileId: string): ReadyTaskPage;
  getCoordinationState(input: CoordinationStateInput, profileId: string): CoordinationState;
  getOwnedClaimSnapshot(claimId: string, profileId: string): TaskClaim | null;
  getDelegationScope(
    delegationId: string,
    profileId: string,
  ): { projectId: string; taskId: string; role: "parent" | "child" } | null;
  getDelegationForActor(
    delegationId: string,
    profileId: string,
  ): { delegation: TaskDelegation; role: "parent" | "child" } | null;
  claim(input: AuthorizedClaimCommand, createContext: () => TaskContextPack): ClaimTaskResult;
  renew(input: AuthorizedRenewCommand): RenewClaimResult;
  checkpoint(input: AuthorizedCheckpointCommand): CheckpointResult;
  transition(input: AuthorizedTransitionCommand): TransitionClaimResult;
  switchTask(input: AuthorizedSwitchCommand, createContext: () => TaskContextPack): SwitchTaskResult;
  createDelegation(input: AuthorizedDelegationCommand): DelegationResult;
  acceptDelegation(input: AuthorizedAcceptDelegationCommand): DelegationResult;
  revokeDelegation(input: AuthorizedRevokeDelegationCommand): DelegationResult;
  submit(
    input: AuthorizedSubmissionCommand,
    createProposal: (input: SubmitChangeSetInput, forceConflict: boolean) => ChangeSubmissionResult,
  ): SubmissionResult;
}

export type CoordinationStoreTestFailpoint =
  | "context_creation"
  | "checkpoint_insert"
  | "old_claim_transition"
  | "new_claim_insert"
  | "proposal_creation";

export interface CoordinationStoreDependencies {
  now?: () => string;
  newId?: (prefix: "coordination-event") => string;
  testOnlyFailpoint?: (step: CoordinationStoreTestFailpoint) => void;
}

type ProjectRow = { id: string; revision: number };
type ClaimRow = {
  id: string; project_id: string; task_id: string; profile_id: string; delegation_id: string | null;
  state: TaskClaim["state"]; base_project_revision: number; base_task_revision: number;
  context_pack_id: string; acquired_at: string; expires_at: string; absolute_expires_at: string;
  ended_at: string | null; latest_checkpoint_id: string | null;
};
type DelegationRow = {
  id: string; project_id: string; task_id: string; parent_profile_id: string; child_profile_id: string;
  state: TaskDelegation["state"]; base_project_revision: number; base_task_revision: number;
  scope_json: string; allowed_outputs_json: string; offered_at: string; deadline: string;
  accepted_at: string | null; ended_at: string | null; claim_id: string | null;
};
type CheckpointRow = {
  id: string; claim_id: string; sequence: number; document_json: string; created_at: string;
  project_revision: number; task_revision: number; context_pack_id: string;
};
type SubmissionRow = {
  id: string; claim_id: string; checkpoint_id: string; profile_id: string; project_id: string;
  task_id: string; base_project_revision: number; base_task_revision: number; context_pack_id: string;
  document_json: string; proposal_id: string; state: TaskSubmission["state"];
  submitted_at: string; decided_at: string | null;
};
type EventRow = {
  id: string; category: CoordinationEvent["category"]; project_id: string; task_id: string;
  profile_id: string | null; claim_id: string | null; delegation_id: string | null;
  checkpoint_id: string | null; submission_id: string | null; proposal_id: string | null;
  prior_state: string | null; resulting_state: string | null; project_revision: number;
  task_revision: number; detail: string | null; created_at: string;
};
type CommittedCoordinationError = { readonly error: CoordinationError };

function fail(code: ConstructorParameters<typeof CoordinationError>[0]): never {
  throw new CoordinationError(code);
}
const addMinutes = (timestamp: string, minutes: number): string =>
  new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
const minIso = (left: string, right: string): string => left <= right ? left : right;
const canonicalTimestamp = (value: unknown): string => {
  try {
    const parsed = coordinationTimestampSchema.safeParse(value);
    if (!parsed.success) return fail("coordination_unavailable");
    return new Date(parsed.data).toISOString();
  } catch {
    return fail("coordination_unavailable");
  }
};
const withCanonicalNow = <Command extends { now: string }>(command: Command): Command => ({
  ...command,
  now: canonicalTimestamp(command.now),
});
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type ReadyTaskCursor = {
  projectId: string;
  projectRevision: number;
  filterHash: string;
  lastTaskId: string;
};
const encodeCursor = (cursor: ReadyTaskCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
const decodeCursor = (value: string): ReadyTaskCursor => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail("revision_conflict");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) fail("revision_conflict");
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("revision_conflict");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) fail("revision_conflict");
  const cursor = decoded as Record<string, unknown>;
  if (Object.keys(cursor).sort().join(",") !== "filterHash,lastTaskId,projectId,projectRevision" ||
    typeof cursor.projectId !== "string" || typeof cursor.projectRevision !== "number" ||
    typeof cursor.filterHash !== "string" || typeof cursor.lastTaskId !== "string") {
    fail("revision_conflict");
  }
  const parsed: ReadyTaskCursor = {
    projectId: cursor.projectId,
    projectRevision: cursor.projectRevision,
    filterHash: cursor.filterHash,
    lastTaskId: cursor.lastTaskId,
  };
  if (encodeCursor(parsed) !== value) fail("revision_conflict");
  return parsed;
};
const mapClaim = (row: ClaimRow): TaskClaim => ({
  id: row.id, projectId: row.project_id, taskId: row.task_id, profileId: row.profile_id,
  delegationId: row.delegation_id, state: row.state, baseProjectRevision: row.base_project_revision,
  baseTaskRevision: row.base_task_revision, contextPackId: row.context_pack_id,
  acquiredAt: row.acquired_at, expiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at,
  endedAt: row.ended_at, latestCheckpointId: row.latest_checkpoint_id,
});
const mapDelegation = (row: DelegationRow): TaskDelegation => ({
  id: row.id, projectId: row.project_id, taskId: row.task_id,
  parentProfileId: row.parent_profile_id, childProfileId: row.child_profile_id, state: row.state,
  baseProjectRevision: row.base_project_revision, baseTaskRevision: row.base_task_revision,
  scope: JSON.parse(row.scope_json), allowedOutputs: JSON.parse(row.allowed_outputs_json),
  offeredAt: row.offered_at, deadline: row.deadline, acceptedAt: row.accepted_at,
  endedAt: row.ended_at, claimId: row.claim_id,
});
const mapCheckpoint = (row: CheckpointRow): TaskCheckpoint => ({
  id: row.id, claimId: row.claim_id, sequence: row.sequence, ...JSON.parse(row.document_json),
  createdAt: row.created_at, projectRevision: row.project_revision, taskRevision: row.task_revision,
  contextPackId: row.context_pack_id,
});
const mapSubmission = (row: SubmissionRow): TaskSubmission => {
  const { changes: _changes, ...document } = JSON.parse(row.document_json) as {
    changes: unknown;
    summary: string;
    verificationEvidence: TaskSubmission["verificationEvidence"];
    repositoryEvidence: TaskSubmission["repositoryEvidence"];
  };
  return {
    id: row.id, claimId: row.claim_id, checkpointId: row.checkpoint_id, profileId: row.profile_id,
    projectId: row.project_id, taskId: row.task_id, baseProjectRevision: row.base_project_revision,
    baseTaskRevision: row.base_task_revision, contextPackId: row.context_pack_id,
    ...document, proposalId: row.proposal_id, state: row.state,
    submittedAt: row.submitted_at, decidedAt: row.decided_at,
  };
};
const mapEvent = (row: EventRow): CoordinationEvent => ({
  id: row.id, category: row.category, projectId: row.project_id, taskId: row.task_id,
  profileId: row.profile_id, claimId: row.claim_id, delegationId: row.delegation_id,
  checkpointId: row.checkpoint_id, submissionId: row.submission_id, proposalId: row.proposal_id,
  priorState: row.prior_state, resultingState: row.resulting_state,
  projectRevision: row.project_revision, taskRevision: row.task_revision,
  detail: row.detail, createdAt: row.created_at,
});

export const createCoordinationStore = (
  database: IntentArcDatabase,
  dependencies: CoordinationStoreDependencies = {},
): CoordinationStore => {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newId = dependencies.newId ?? (() => `coordination-event-${randomUUID()}`);
  const testOnlyFailpoint = dependencies.testOnlyFailpoint ?? (() => undefined);

  const project = database.prepare("SELECT id, revision FROM projects WHERE id = ?");
  const records = database.prepare(`SELECT * FROM project_records WHERE project_id = ? ORDER BY id COLLATE BINARY`);
  const record = database.prepare(`SELECT * FROM project_records WHERE project_id = ? AND id = ?`);
  const relationships = database.prepare(`SELECT from_record_id, to_record_id FROM record_relationships WHERE project_id = ? AND kind = 'depends_on'`);
  const claimsForProject = database.prepare(`SELECT * FROM task_claims WHERE project_id = ? AND state IN ('active', 'submitted')`);
  const liveDelegationsForProject = database.prepare(`SELECT * FROM task_delegations WHERE project_id = ? AND state IN ('offered', 'accepted', 'claimed')`);
  const claimById = database.prepare("SELECT * FROM task_claims WHERE id = ?");
  const delegationById = database.prepare("SELECT * FROM task_delegations WHERE id = ?");
  const checkpointById = database.prepare("SELECT * FROM task_checkpoints WHERE id = ?");
  const proposalById = database.prepare("SELECT * FROM change_proposals WHERE id = ?");
  const submissionByClaim = database.prepare("SELECT * FROM task_submissions WHERE claim_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1");
  const eventsForTask = database.prepare(`
    SELECT * FROM coordination_events
    WHERE project_id = ? AND task_id = ?
    ORDER BY created_at, rowid
  `);
  const idempotency = database.prepare(`
    SELECT request_hash, result_json FROM coordination_idempotency
    WHERE profile_id = ? AND project_id = ? AND operation = ? AND idempotency_key = ?
  `);
  const insertIdempotency = database.prepare(`
    INSERT INTO coordination_idempotency VALUES (@profileId, @projectId, @operation, @key, @requestHash, @resultJson, @createdAt)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO coordination_events (
      id, category, project_id, task_id, profile_id, claim_id, delegation_id, checkpoint_id,
      submission_id, proposal_id, prior_state, resulting_state, project_revision, task_revision,
      detail, created_at
    ) VALUES (
      @id, @category, @projectId, @taskId, @profileId, @claimId, @delegationId, @checkpointId,
      @submissionId, @proposalId, @priorState, @resultingState, @projectRevision, @taskRevision,
      @detail, @createdAt
    )
  `);

  const validateAuthority = (profileId: string, credentialGeneration: string, projectId: string): void => {
    const row = database.prepare(`
      SELECT p.status, p.token_rotated_at
      FROM client_profiles p
      JOIN profile_project_authorities a ON a.profile_id = p.id AND a.project_id = ?
      WHERE p.id = ?
    `).get(projectId, profileId) as { status: string; token_rotated_at: string } | undefined;
    if (!row || row.status !== "enabled" || row.token_rotated_at !== credentialGeneration) {
      fail("coordination_authority_denied");
    }
  };
  const validateProfileAuthority = (profileId: string, projectId: string): void => {
    const row = database.prepare(`
      SELECT 1
      FROM client_profiles p
      JOIN profile_project_authorities a ON a.profile_id = p.id AND a.project_id = ?
      WHERE p.id = ? AND p.status = 'enabled'
    `).get(projectId, profileId);
    if (!row) fail("coordination_authority_denied");
  };
  const validateReadAuthority = (profileId: string, projectId: string): void => {
    const row = database.prepare(`
      SELECT 1 FROM client_profiles p JOIN profile_project_authorities a ON a.profile_id = p.id
      WHERE p.id = ? AND p.status = 'enabled' AND a.project_id = ?
    `).get(profileId, projectId);
    if (!row) fail("coordination_authority_denied");
  };
  const validateHash = (requestHash: string): void => {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) fail("coordination_idempotency_conflict");
  };
  const replay = <Result>(command: AuthorizedCommand<{ idempotencyKey: string }, unknown>, projectId: string, operation: CoordinationIdempotencyOperation): Result | null => {
    validateHash(command.requestHash);
    const row = idempotency.get(command.profileId, projectId, operation, command.input.idempotencyKey) as
      | { request_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.request_hash !== command.requestHash) fail("coordination_idempotency_conflict");
    return JSON.parse(row.result_json) as Result;
  };
  const persist = (command: AuthorizedCommand<{ idempotencyKey: string }, unknown>, projectId: string, operation: CoordinationIdempotencyOperation, result: unknown): void => {
    insertIdempotency.run({
      profileId: command.profileId, projectId, operation, key: command.input.idempotencyKey,
      requestHash: command.requestHash, resultJson: JSON.stringify(result), createdAt: command.now,
    });
  };
  const event = (values: Partial<CoordinationEvent> & Pick<CoordinationEvent, "id" | "category" | "projectId" | "taskId" | "projectRevision" | "taskRevision" | "createdAt">): void => {
    insertEvent.run({
      profileId: null, claimId: null, delegationId: null, checkpointId: null, submissionId: null,
      proposalId: null, priorState: null, resultingState: null, detail: null, ...values,
    });
  };

  const terminalizeClaimedDelegation = (
    claim: ClaimRow,
    resultingState: "expired" | "revoked",
    timestamp: string,
  ): DelegationRow | undefined => {
    if (claim.delegation_id === null) return undefined;
    const delegation = delegationById.get(claim.delegation_id) as DelegationRow | undefined;
    if (!delegation || delegation.project_id !== claim.project_id ||
      delegation.task_id !== claim.task_id || delegation.child_profile_id !== claim.profile_id ||
      delegation.claim_id !== claim.id || delegation.state !== "claimed") {
      fail("delegation_conflict");
    }
    const updated = database.prepare(`
      UPDATE task_delegations SET state = ?, ended_at = ?
      WHERE id = ? AND state = 'claimed' AND claim_id = ?
    `).run(resultingState, timestamp, delegation.id, claim.id);
    if (updated.changes !== 1) fail("delegation_conflict");
    return delegation;
  };

  const expireClaim = (claim: ClaimRow, timestamp: string): void => {
    const updated = database.prepare(`
      UPDATE task_claims SET state = 'expired', ended_at = ?
      WHERE id = ? AND state = 'active'
    `).run(timestamp, claim.id);
    if (updated.changes !== 1) fail("claim_conflict");
    const delegation = terminalizeClaimedDelegation(claim, "expired", timestamp);
    event({
      id: newId("coordination-event"), category: "expiry", projectId: claim.project_id,
      taskId: claim.task_id, profileId: claim.profile_id, claimId: claim.id,
      delegationId: delegation?.id ?? null, priorState: "active", resultingState: "expired",
      projectRevision: claim.base_project_revision, taskRevision: claim.base_task_revision,
      createdAt: timestamp,
    });
  };

  const expireClaimAtDelegationDeadline = (
    claim: ClaimRow,
    timestamp: string,
  ): boolean => {
    if (claim.state !== "active" || claim.delegation_id === null) return false;
    const delegation = delegationById.get(claim.delegation_id) as DelegationRow | undefined;
    if (!delegation || delegation.project_id !== claim.project_id ||
      delegation.task_id !== claim.task_id || delegation.child_profile_id !== claim.profile_id ||
      delegation.claim_id !== claim.id || delegation.state !== "claimed") {
      fail("delegation_conflict");
    }
    if (delegation.deadline > timestamp) return false;
    expireClaim(claim, timestamp);
    return true;
  };

  const committedClaimExpired = (): CommittedCoordinationError => ({
    error: new CoordinationError("claim_expired"),
  });
  const unwrapCommitted = <Result>(result: Result | CommittedCoordinationError): Result => {
    if ("error" in (result as Result & Partial<CommittedCoordinationError>) &&
      (result as CommittedCoordinationError).error instanceof CoordinationError) {
      throw (result as CommittedCoordinationError).error;
    }
    return result as Result;
  };

  const expire = (projectId: string, timestamp: string): void => {
    timestamp = canonicalTimestamp(timestamp);
    const deadlineClaims = database.prepare(`
      SELECT claim.*
      FROM task_claims AS claim
      JOIN task_delegations AS delegation
        ON delegation.id = claim.delegation_id AND delegation.claim_id = claim.id
      WHERE claim.project_id = ? AND claim.state = 'active'
        AND delegation.state = 'claimed' AND delegation.deadline <= ?
      ORDER BY claim.id
    `).all(projectId, timestamp) as ClaimRow[];
    for (const row of deadlineClaims) expireClaimAtDelegationDeadline(row, timestamp);
    const elapsedClaims = database.prepare(`
      SELECT * FROM task_claims WHERE project_id = ? AND state = 'active' AND expires_at <= ? ORDER BY id
    `).all(projectId, timestamp) as ClaimRow[];
    for (const row of elapsedClaims) {
      expireClaim(row, timestamp);
    }
    const elapsedDelegations = database.prepare(`
      SELECT * FROM task_delegations AS delegation
      WHERE project_id = ? AND state IN ('offered', 'accepted', 'claimed')
        AND julianday(deadline) <= julianday(?)
        AND NOT (
          state = 'claimed' AND EXISTS (
            SELECT 1 FROM task_claims AS claim
            WHERE claim.id = delegation.claim_id AND claim.state = 'submitted'
          )
        )
      ORDER BY id
    `).all(projectId, timestamp) as DelegationRow[];
    for (const row of elapsedDelegations) {
      database.prepare(`UPDATE task_delegations SET state = 'expired', ended_at = ? WHERE id = ? AND state IN ('offered','accepted','claimed')`).run(timestamp, row.id);
      event({
        id: newId("coordination-event"), category: "expiry", projectId: row.project_id, taskId: row.task_id,
        profileId: row.child_profile_id, delegationId: row.id, priorState: row.state, resultingState: "expired",
        projectRevision: row.base_project_revision, taskRevision: row.base_task_revision, createdAt: timestamp,
      });
    }
  };

  const expireTask = (projectId: string, taskId: string, timestamp: string): void => {
    timestamp = canonicalTimestamp(timestamp);
    const deadlineClaims = database.prepare(`
      SELECT claim.*
      FROM task_claims AS claim
      JOIN task_delegations AS delegation
        ON delegation.id = claim.delegation_id AND delegation.claim_id = claim.id
      WHERE claim.project_id = ? AND claim.task_id = ? AND claim.state = 'active'
        AND delegation.state = 'claimed' AND delegation.deadline <= ?
      ORDER BY claim.id
    `).all(projectId, taskId, timestamp) as ClaimRow[];
    for (const row of deadlineClaims) expireClaimAtDelegationDeadline(row, timestamp);
    const elapsedClaims = database.prepare(`
      SELECT * FROM task_claims
      WHERE project_id = ? AND task_id = ? AND state = 'active' AND expires_at <= ?
      ORDER BY id
    `).all(projectId, taskId, timestamp) as ClaimRow[];
    for (const row of elapsedClaims) {
      expireClaim(row, timestamp);
    }
    const elapsedDelegations = database.prepare(`
      SELECT * FROM task_delegations AS delegation
      WHERE project_id = ? AND task_id = ?
        AND state IN ('offered', 'accepted', 'claimed')
        AND julianday(deadline) <= julianday(?)
        AND NOT (
          state = 'claimed' AND EXISTS (
            SELECT 1 FROM task_claims AS claim
            WHERE claim.id = delegation.claim_id AND claim.state = 'submitted'
          )
        )
      ORDER BY id
    `).all(projectId, taskId, timestamp) as DelegationRow[];
    for (const row of elapsedDelegations) {
      database.prepare(`
        UPDATE task_delegations SET state = 'expired', ended_at = ?
        WHERE id = ? AND state IN ('offered','accepted','claimed')
      `).run(timestamp, row.id);
      event({
        id: newId("coordination-event"), category: "expiry", projectId: row.project_id,
        taskId: row.task_id, profileId: row.child_profile_id, delegationId: row.id,
        priorState: row.state, resultingState: "expired", projectRevision: row.base_project_revision,
        taskRevision: row.base_task_revision, createdAt: timestamp,
      });
    }
  };

  const cycleMembers = (recordMap: Map<string, ProjectRecord>, dependenciesByTask: Map<string, string[]>): Set<string> => {
    const members = new Set<string>();
    const state = new Map<string, 0 | 1 | 2>();
    for (const start of [...recordMap.keys()].sort()) {
      if (state.get(start)) continue;
      const path: string[] = [];
      const position = new Map<string, number>();
      const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
      state.set(start, 1); path.push(start); position.set(start, 0);
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const children = dependenciesByTask.get(frame.id) ?? [];
        if (frame.next >= children.length) {
          state.set(frame.id, 2); position.delete(frame.id); path.pop(); stack.pop(); continue;
        }
        const child = children[frame.next++]!;
        if (!recordMap.has(child)) continue;
        if (state.get(child) === 1) {
          const from = position.get(child)!;
          for (let index = from; index < path.length; index += 1) members.add(path[index]!);
        } else if (!state.get(child)) {
          state.set(child, 1); position.set(child, path.length); path.push(child);
          stack.push({ id: child, next: 0 });
        }
      }
    }
    return members;
  };

  const readiness = (projectId: string, acceptedDelegationId: string | null = null): { revision: number; tasks: ReadyTask[] } => {
    const projectRow = project.get(projectId) as ProjectRow | undefined;
    if (!projectRow) fail("coordination_unavailable");
    const allRecords = (records.all(projectId) as ProjectRecordRow[]).map(mapProjectRecordRow);
    const recordMap = new Map(allRecords.map((item) => [item.id, item]));
    const dependenciesByTask = new Map<string, string[]>();
    for (const row of relationships.all(projectId) as Array<{ from_record_id: string; to_record_id: string }>) {
      const values = dependenciesByTask.get(row.from_record_id) ?? [];
      values.push(row.to_record_id); dependenciesByTask.set(row.from_record_id, values);
    }
    for (const values of dependenciesByTask.values()) values.sort();
    const cycles = cycleMembers(recordMap, dependenciesByTask);
    const claimMap = new Map((claimsForProject.all(projectId) as ClaimRow[]).map((item) => [item.task_id, item]));
    const delegationMap = new Map((liveDelegationsForProject.all(projectId) as DelegationRow[]).map((item) => [item.task_id, item]));
    const tasks = allRecords.filter((item) => item.kind === "task" && item.status === "active").map((task): ReadyTask => {
      const blockers: string[] = [];
      if (cycles.has(task.id)) blockers.push(`dependency_cycle:${task.id}`);
      for (const dependencyId of dependenciesByTask.get(task.id) ?? []) {
        const dependency = recordMap.get(dependencyId);
        if (!dependency) blockers.push(`dependency_missing:${dependencyId}`);
        else if (dependency.kind !== "task") blockers.push(`dependency_not_task:${dependencyId}`);
        else if (dependency.status !== "completed") blockers.push(`dependency_incomplete:${dependencyId}`);
      }
      const claim = claimMap.get(task.id);
      if (claim) blockers.push(`claim_${claim.state}:${claim.id}`);
      const delegation = delegationMap.get(task.id);
      if (delegation && delegation.id !== acceptedDelegationId) blockers.push(`delegation_live:${delegation.id}`);
      blockers.sort();
      return { task, blockers, liveClaimId: claim?.id ?? null, liveDelegationId: delegation?.id ?? null };
    });
    return { revision: projectRow.revision, tasks };
  };

  const readTransaction = database.transaction((input: ListReadyTasksInput, profileId: string): ReadyTaskPage => {
    validateReadAuthority(profileId, input.projectId);
    expire(input.projectId, now());
    const evaluated = readiness(input.projectId);
    if (evaluated.revision !== input.expectedProjectRevision) fail("revision_conflict");
    const filterHash = hash(JSON.stringify({ projectId: input.projectId, profileId, limit: input.limit }));
    let startIndex = 0;
    if (input.cursor) {
      const decoded = decodeCursor(input.cursor);
      if (decoded.projectId !== input.projectId || decoded.projectRevision !== evaluated.revision ||
        decoded.filterHash !== filterHash) fail("revision_conflict");
      const lastIndex = evaluated.tasks.findIndex(({ task }) => task.id === decoded.lastTaskId);
      if (lastIndex < 0) fail("revision_conflict");
      startIndex = lastIndex + 1;
    }
    const remaining = evaluated.tasks.slice(startIndex);
    const page = remaining.slice(0, input.limit);
    const nextCursor = remaining.length > input.limit
      ? encodeCursor({ projectId: input.projectId, projectRevision: evaluated.revision, filterHash, lastTaskId: page.at(-1)!.task.id })
      : null;
    return { tasks: page, nextCursor, projectRevision: evaluated.revision };
  });

  const claimTransaction = database.transaction((command: AuthorizedClaimCommand, createContext: () => TaskContextPack): ClaimTaskResult => {
    validateAuthority(command.profileId, command.credentialGeneration, command.input.projectId);
    const existing = replay<ClaimTaskResult>(command, command.input.projectId, coordinationIdempotencyOperations.claim);
    if (existing) return existing;
    expire(command.input.projectId, command.now);
    const evaluated = readiness(command.input.projectId, command.input.acceptedDelegationId);
    if (evaluated.revision !== command.input.expectedProjectRevision) fail("revision_conflict");
    const ready = evaluated.tasks.find(({ task }) => task.id === command.input.taskId);
    if (!ready || ready.task.revision !== command.input.expectedTaskRevision) {
      if (ready) fail("revision_conflict");
      fail("task_not_ready");
    }
    if (ready.liveClaimId) fail("claim_conflict");
    if (ready.blockers.length) {
      if (ready.blockers.some((value) => value.startsWith("delegation_live:"))) fail("delegation_conflict");
      fail("task_not_ready");
    }
    let delegation: DelegationRow | undefined;
    if (command.input.acceptedDelegationId) {
      delegation = delegationById.get(command.input.acceptedDelegationId) as DelegationRow | undefined;
      if (!delegation || delegation.project_id !== command.input.projectId || delegation.task_id !== command.input.taskId) fail("delegation_conflict");
      if (delegation.child_profile_id !== command.profileId) fail("coordination_authority_denied");
      validateProfileAuthority(delegation.parent_profile_id, delegation.project_id);
      if (delegation.state !== "accepted") fail(delegation.state === "expired" ? "delegation_expired" : delegation.state === "revoked" ? "delegation_revoked" : "delegation_conflict");
      if (canonicalTimestamp(delegation.deadline) <= command.now) fail("delegation_expired");
    }
    const context = taskContextPackSchema.parse(createContext());
    if (context.projectId !== command.input.projectId || context.taskId !== command.input.taskId ||
      context.projectRevision !== command.input.expectedProjectRevision || context.budgetTokens !== command.input.contextBudgetTokens) {
      fail("coordination_unavailable");
    }
    const storedContext = database.prepare("SELECT content_json FROM context_packs WHERE id = ?").get(context.id) as { content_json: string } | undefined;
    if (storedContext && storedContext.content_json !== JSON.stringify(context)) fail("coordination_unavailable");
    if (!storedContext) database.prepare(`INSERT INTO context_packs VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      context.id, context.projectId, context.taskId, context.projectRevision, context.budgetTokens,
      context.estimatedTokens, JSON.stringify(context), context.generatedAt,
    );
    const expiresAt = addMinutes(command.now, 30);
    const absoluteExpiresAt = addMinutes(command.now, 240);
    database.prepare(`
      INSERT INTO task_claims VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(command.ids.claimId, command.input.projectId, command.input.taskId, command.profileId,
      delegation?.id ?? null, command.input.expectedProjectRevision, command.input.expectedTaskRevision,
      context.id, command.now, expiresAt, absoluteExpiresAt);
    if (delegation) {
      const linked = database.prepare(`
        UPDATE task_delegations SET state = 'claimed', claim_id = ?
        WHERE id = ? AND state = 'accepted' AND child_profile_id = ?
          AND julianday(deadline) > julianday(?)
      `).run(command.ids.claimId, delegation.id, command.profileId, command.now);
      if (linked.changes !== 1) fail("delegation_conflict");
    }
    event({
      id: command.ids.eventId, category: "claim", projectId: command.input.projectId, taskId: command.input.taskId,
      profileId: command.profileId, claimId: command.ids.claimId, delegationId: delegation?.id ?? null,
      priorState: null, resultingState: "active", projectRevision: command.input.expectedProjectRevision,
      taskRevision: command.input.expectedTaskRevision, createdAt: command.now,
    });
    const result: ClaimTaskResult = {
      claim: mapClaim(claimById.get(command.ids.claimId) as ClaimRow), readiness: ready, contextPack: context,
    };
    persist(command, command.input.projectId, coordinationIdempotencyOperations.claim, result);
    return result;
  });

  const renewTransaction = database.transaction((command: AuthorizedRenewCommand): RenewClaimResult | CommittedCoordinationError => {
    const initial = claimById.get(command.input.claimId) as ClaimRow | undefined;
    if (!initial) fail("claim_conflict");
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    const existing = replay<RenewClaimResult>(command, initial.project_id, coordinationIdempotencyOperations.renew);
    if (existing) return existing;
    if (expireClaimAtDelegationDeadline(initial, command.now)) return committedClaimExpired();
    if (command.now >= initial.absolute_expires_at) fail("lease_horizon_reached");
    expire(initial.project_id, command.now);
    const current = claimById.get(command.input.claimId) as ClaimRow;
    if (current.profile_id !== command.profileId) fail("claim_conflict");
    if (current.state !== "active") fail(current.state === "expired" ? "claim_expired" : "claim_conflict");
    const currentProject = project.get(current.project_id) as ProjectRow | undefined;
    const currentTask = record.get(current.project_id, current.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask || currentProject.revision !== command.input.expectedProjectRevision || currentTask.revision !== command.input.expectedTaskRevision) fail("revision_conflict");
    const expiresAt = minIso(addMinutes(command.now, 30), current.absolute_expires_at);
    if (expiresAt <= command.now) fail("lease_horizon_reached");
    database.prepare("UPDATE task_claims SET expires_at = ? WHERE id = ? AND state = 'active'").run(expiresAt, current.id);
    event({
      id: command.ids.eventId, category: "renewal", projectId: current.project_id, taskId: current.task_id,
      profileId: command.profileId, claimId: current.id, priorState: "active", resultingState: "active",
      projectRevision: current.base_project_revision, taskRevision: current.base_task_revision, createdAt: command.now,
    });
    const result = { claim: mapClaim(claimById.get(current.id) as ClaimRow) };
    persist(command, current.project_id, coordinationIdempotencyOperations.renew, result);
    return result;
  });

  const transitionTransaction = database.transaction((command: AuthorizedTransitionCommand): TransitionClaimResult | CommittedCoordinationError => {
    const initial = claimById.get(command.input.claimId) as ClaimRow | undefined;
    if (!initial) fail("claim_conflict");
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    const operation = coordinationIdempotencyOperations.transition;
    const existing = replay<TransitionClaimResult>(command, initial.project_id, operation);
    if (existing) return existing;
    if (expireClaimAtDelegationDeadline(initial, command.now)) return committedClaimExpired();
    expire(initial.project_id, command.now);
    const current = claimById.get(command.input.claimId) as ClaimRow;
    if (current.profile_id !== command.profileId) fail("claim_conflict");
    const currentProject = project.get(current.project_id) as ProjectRow | undefined;
    const currentTask = record.get(current.project_id, current.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask || currentProject.revision !== command.input.expectedProjectRevision ||
      currentTask.revision !== command.input.expectedTaskRevision) fail("revision_conflict");
    if (current.state === "expired") fail("claim_expired");
    let allowed = current.state === "active";
    if (current.state === "submitted") {
      const submission = submissionByClaim.get(current.id) as SubmissionRow | undefined;
      allowed = command.input.action === "release" && !!submission &&
        ["conflicted", "rejected", "withdrawn"].includes(submission.state);
    }
    if (!allowed) fail("claim_conflict");
    const resultingState = command.input.action === "pause" ? "paused" : "released";
    let releasedDelegation: DelegationRow | undefined;
    if (current.delegation_id) {
      releasedDelegation = delegationById.get(current.delegation_id) as DelegationRow | undefined;
      if (!releasedDelegation || releasedDelegation.project_id !== current.project_id ||
        releasedDelegation.task_id !== current.task_id ||
        releasedDelegation.child_profile_id !== command.profileId ||
        releasedDelegation.claim_id !== current.id) fail("delegation_conflict");
      if (releasedDelegation.state === "claimed") {
        terminalizeClaimedDelegation(current, "revoked", command.now);
      } else if (!(current.state === "submitted" && resultingState === "released" &&
        releasedDelegation.state === "expired")) {
        fail("delegation_conflict");
      }
    }
    database.prepare("UPDATE task_claims SET state = ?, ended_at = ? WHERE id = ? AND state = ?")
      .run(resultingState, command.now, current.id, current.state);
    event({
      id: command.ids.eventId, category: command.input.action, projectId: current.project_id,
      taskId: current.task_id, profileId: command.profileId, claimId: current.id,
      delegationId: releasedDelegation?.id ?? null,
      priorState: current.state, resultingState, projectRevision: currentProject.revision,
      taskRevision: currentTask.revision, createdAt: command.now,
    });
    const result = { claim: mapClaim(claimById.get(current.id) as ClaimRow) };
    persist(command, current.project_id, operation, result);
    return result;
  });

  const checkpointTransaction = database.transaction((command: AuthorizedCheckpointCommand): CheckpointResult | CommittedCoordinationError => {
    const initial = claimById.get(command.input.claimId) as ClaimRow | undefined;
    if (!initial) fail("claim_conflict");
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    const existing = replay<CheckpointResult>(command, initial.project_id, coordinationIdempotencyOperations.checkpoint);
    if (existing) return existing;
    if (expireClaimAtDelegationDeadline(initial, command.now)) return committedClaimExpired();
    expire(initial.project_id, command.now);
    const current = claimById.get(command.input.claimId) as ClaimRow;
    if (current.profile_id !== command.profileId) fail("claim_conflict");
    if (current.state !== "active") fail(current.state === "expired" ? "claim_expired" : "claim_conflict");
    const currentProject = project.get(current.project_id) as ProjectRow | undefined;
    const currentTask = record.get(current.project_id, current.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask || currentProject.revision !== command.input.expectedProjectRevision ||
      currentTask.revision !== command.input.expectedTaskRevision) fail("revision_conflict");
    const parsedDocument = checkpointDocumentSchema.safeParse(command.input.checkpoint);
    if (!parsedDocument.success) fail("checkpoint_invalid");
    const documentJson = JSON.stringify(parsedDocument.data);
    if (Buffer.byteLength(documentJson, "utf8") > 65_536) fail("checkpoint_invalid");
    const sequenceRow = database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_checkpoints WHERE claim_id = ?
    `).get(current.id) as { sequence: number };
    database.prepare(`
      INSERT INTO task_checkpoints (
        id, claim_id, sequence, document_json, created_at, project_revision, task_revision, context_pack_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(command.ids.checkpointId, current.id, sequenceRow.sequence, documentJson, command.now,
      currentProject.revision, currentTask.revision, current.context_pack_id);
    const expiresAt = minIso(addMinutes(command.now, 30), current.absolute_expires_at);
    if (expiresAt <= command.now) fail("lease_horizon_reached");
    database.prepare(`
      UPDATE task_claims SET latest_checkpoint_id = ?, expires_at = ? WHERE id = ? AND state = 'active'
    `).run(command.ids.checkpointId, expiresAt, current.id);
    event({
      id: command.ids.checkpointEventId, category: "checkpoint", projectId: current.project_id,
      taskId: current.task_id, profileId: command.profileId, claimId: current.id,
      checkpointId: command.ids.checkpointId, priorState: "active", resultingState: "active",
      projectRevision: currentProject.revision, taskRevision: currentTask.revision, createdAt: command.now,
    });
    event({
      id: command.ids.renewalEventId, category: "renewal", projectId: current.project_id,
      taskId: current.task_id, profileId: command.profileId, claimId: current.id,
      checkpointId: command.ids.checkpointId, priorState: "active", resultingState: "active",
      projectRevision: currentProject.revision, taskRevision: currentTask.revision, createdAt: command.now,
    });
    const result = {
      claim: mapClaim(claimById.get(current.id) as ClaimRow),
      checkpoint: mapCheckpoint(checkpointById.get(command.ids.checkpointId) as CheckpointRow),
    };
    persist(command, current.project_id, coordinationIdempotencyOperations.checkpoint, result);
    return result;
  });

  const createDelegationTransaction = database.transaction((
    command: AuthorizedDelegationCommand,
  ): DelegationResult => {
    validateAuthority(command.profileId, command.credentialGeneration, command.input.projectId);
    const parsed = createDelegationInputSchema.safeParse(command.input);
    if (!parsed.success) fail("delegation_conflict");
    if (parsed.data.childProfileId === command.profileId) fail("delegation_conflict");
    validateProfileAuthority(parsed.data.childProfileId, parsed.data.projectId);
    const existing = replay<DelegationResult>(command, parsed.data.projectId, coordinationIdempotencyOperations.createDelegation);
    if (existing) return existing;
    const deadline = canonicalTimestamp(parsed.data.deadline);
    if (deadline <= command.now) fail("delegation_expired");
    expire(parsed.data.projectId, command.now);
    const currentProject = project.get(parsed.data.projectId) as ProjectRow | undefined;
    const currentTask = record.get(parsed.data.projectId, parsed.data.taskId) as ProjectRecordRow | undefined;
    if (!currentProject || currentProject.revision !== parsed.data.expectedProjectRevision ||
      !currentTask || currentTask.revision !== parsed.data.expectedTaskRevision) fail("revision_conflict");
    if (currentTask.kind !== "task" || currentTask.status !== "active") fail("task_not_ready");
    const evaluated = readiness(parsed.data.projectId);
    const ready = evaluated.tasks.find(({ task }) => task.id === parsed.data.taskId);
    if (!ready) fail("task_not_ready");
    if (ready.liveClaimId) fail("claim_conflict");
    if (ready.liveDelegationId) fail("delegation_conflict");
    if (ready.blockers.length) fail("task_not_ready");
    const delegation: TaskDelegation = {
      id: command.ids.delegationId,
      projectId: parsed.data.projectId,
      taskId: parsed.data.taskId,
      parentProfileId: command.profileId,
      childProfileId: parsed.data.childProfileId,
      state: "offered",
      baseProjectRevision: currentProject.revision,
      baseTaskRevision: currentTask.revision,
      scope: parsed.data.scope,
      allowedOutputs: parsed.data.allowedOutputs,
      offeredAt: command.now,
      deadline,
      acceptedAt: null,
      endedAt: null,
      claimId: null,
    };
    if (!taskDelegationSchema.safeParse(delegation).success ||
      Buffer.byteLength(JSON.stringify(delegation), "utf8") > 32_768) fail("delegation_conflict");
    database.prepare(`
      INSERT INTO task_delegations VALUES (?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      delegation.id, delegation.projectId, delegation.taskId, delegation.parentProfileId,
      delegation.childProfileId, delegation.baseProjectRevision, delegation.baseTaskRevision,
      JSON.stringify(delegation.scope), JSON.stringify(delegation.allowedOutputs),
      delegation.offeredAt, delegation.deadline,
    );
    event({
      id: command.ids.eventId, category: "delegation_offer", projectId: delegation.projectId,
      taskId: delegation.taskId, profileId: command.profileId, delegationId: delegation.id,
      priorState: null, resultingState: "offered", projectRevision: currentProject.revision,
      taskRevision: currentTask.revision, createdAt: command.now,
    });
    const result = { delegation: mapDelegation(delegationById.get(delegation.id) as DelegationRow) };
    persist(command, delegation.projectId, coordinationIdempotencyOperations.createDelegation, result);
    return result;
  });

  const acceptDelegationTransaction = database.transaction((
    command: AuthorizedAcceptDelegationCommand,
  ): DelegationResult => {
    const initial = delegationById.get(command.input.delegationId) as DelegationRow | undefined;
    if (!initial || initial.project_id !== command.input.projectId || initial.task_id !== command.input.taskId) {
      fail("delegation_conflict");
    }
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    if (initial.child_profile_id !== command.profileId) fail("coordination_authority_denied");
    validateProfileAuthority(initial.parent_profile_id, initial.project_id);
    const existing = replay<DelegationResult>(command, initial.project_id, coordinationIdempotencyOperations.acceptDelegation);
    if (existing) return existing;
    if (canonicalTimestamp(initial.deadline) <= command.now) fail("delegation_expired");
    if (initial.state !== "offered") {
      fail(initial.state === "revoked" ? "delegation_revoked" :
        initial.state === "expired" ? "delegation_expired" : "delegation_conflict");
    }
    const currentProject = project.get(initial.project_id) as ProjectRow | undefined;
    const currentTask = record.get(initial.project_id, initial.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask || currentProject.revision !== command.input.expectedProjectRevision ||
      currentTask.revision !== command.input.expectedTaskRevision) fail("revision_conflict");
    const updated = database.prepare(`
      UPDATE task_delegations SET state = 'accepted', accepted_at = ?
      WHERE id = ? AND state = 'offered' AND child_profile_id = ?
        AND julianday(deadline) > julianday(?)
    `).run(command.now, initial.id, command.profileId, command.now);
    if (updated.changes !== 1) fail("delegation_conflict");
    event({
      id: command.ids.eventId, category: "delegation_accept", projectId: initial.project_id,
      taskId: initial.task_id, profileId: command.profileId, delegationId: initial.id,
      priorState: "offered", resultingState: "accepted", projectRevision: currentProject.revision,
      taskRevision: currentTask.revision, createdAt: command.now,
    });
    const result = { delegation: mapDelegation(delegationById.get(initial.id) as DelegationRow) };
    persist(command, initial.project_id, coordinationIdempotencyOperations.acceptDelegation, result);
    return result;
  });

  const revokeDelegationTransaction = database.transaction((
    command: AuthorizedRevokeDelegationCommand,
  ): DelegationResult => {
    const initial = delegationById.get(command.input.delegationId) as DelegationRow | undefined;
    if (!initial || initial.project_id !== command.input.projectId || initial.task_id !== command.input.taskId) {
      fail("delegation_conflict");
    }
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    if (initial.parent_profile_id !== command.profileId) fail("coordination_authority_denied");
    const existing = replay<DelegationResult>(command, initial.project_id, coordinationIdempotencyOperations.revokeDelegation);
    if (existing) return existing;
    if (canonicalTimestamp(initial.deadline) <= command.now) fail("delegation_expired");
    if (initial.state !== "offered" && initial.state !== "accepted") {
      fail(initial.state === "revoked" ? "delegation_revoked" :
        initial.state === "expired" ? "delegation_expired" : "delegation_conflict");
    }
    const currentProject = project.get(initial.project_id) as ProjectRow | undefined;
    const currentTask = record.get(initial.project_id, initial.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask || currentProject.revision !== command.input.expectedProjectRevision ||
      currentTask.revision !== command.input.expectedTaskRevision) fail("revision_conflict");
    const updated = database.prepare(`
      UPDATE task_delegations SET state = 'revoked', ended_at = ?
      WHERE id = ? AND parent_profile_id = ? AND state IN ('offered', 'accepted')
        AND julianday(deadline) > julianday(?)
    `).run(command.now, initial.id, command.profileId, command.now);
    if (updated.changes !== 1) fail("delegation_conflict");
    event({
      id: command.ids.eventId, category: "delegation_revoke", projectId: initial.project_id,
      taskId: initial.task_id, profileId: command.profileId, delegationId: initial.id,
      priorState: initial.state, resultingState: "revoked", projectRevision: currentProject.revision,
      taskRevision: currentTask.revision, createdAt: command.now,
    });
    const result = { delegation: mapDelegation(delegationById.get(initial.id) as DelegationRow) };
    persist(command, initial.project_id, coordinationIdempotencyOperations.revokeDelegation, result);
    return result;
  });

  const switchTransaction = database.transaction((
    command: AuthorizedSwitchCommand,
    createContext: () => TaskContextPack,
  ): SwitchTaskResult | CommittedCoordinationError => {
    const initial = claimById.get(command.input.currentClaimId) as ClaimRow | undefined;
    if (!initial || initial.project_id !== command.input.projectId) fail("claim_conflict");
    validateAuthority(command.profileId, command.credentialGeneration, command.input.projectId);
    const existing = replay<SwitchTaskResult>(command, command.input.projectId, coordinationIdempotencyOperations.switch);
    if (existing) return existing;
    if (expireClaimAtDelegationDeadline(initial, command.now)) return committedClaimExpired();
    const current = claimById.get(command.input.currentClaimId) as ClaimRow;
    if (current.profile_id !== command.profileId || current.task_id !== command.input.currentTaskId) {
      fail("claim_conflict");
    }
    if (current.state !== "active") fail(current.state === "expired" ? "claim_expired" : "claim_conflict");
    if (current.expires_at <= command.now) fail("claim_expired");
    const currentProject = project.get(command.input.projectId) as ProjectRow | undefined;
    const currentTask = record.get(command.input.projectId, command.input.currentTaskId) as ProjectRecordRow | undefined;
    const nextTask = record.get(command.input.projectId, command.input.nextTaskId) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask ||
      currentProject.revision !== command.input.expectedCurrentProjectRevision ||
      currentProject.revision !== command.input.expectedNextProjectRevision ||
      currentTask.revision !== command.input.expectedCurrentTaskRevision) fail("revision_conflict");
    if (!nextTask || nextTask.kind !== "task" || nextTask.status !== "active") fail("task_not_ready");
    if (nextTask.revision !== command.input.expectedNextTaskRevision) fail("revision_conflict");
    const parsedDocument = checkpointDocumentSchema.safeParse(command.input.checkpoint);
    if (!parsedDocument.success) fail("checkpoint_invalid");
    const documentJson = JSON.stringify(parsedDocument.data);
    if (Buffer.byteLength(documentJson, "utf8") > 65_536) fail("checkpoint_invalid");
    let delegation: DelegationRow | undefined;
    if (command.input.acceptedDelegationId) {
      delegation = delegationById.get(command.input.acceptedDelegationId) as DelegationRow | undefined;
      if (!delegation || delegation.project_id !== command.input.projectId ||
        delegation.task_id !== command.input.nextTaskId) fail("delegation_conflict");
      if (delegation.child_profile_id !== command.profileId) fail("coordination_authority_denied");
      validateProfileAuthority(delegation.parent_profile_id, delegation.project_id);
      if (delegation.state !== "accepted") fail(delegation.state === "expired" ? "delegation_expired" :
        delegation.state === "revoked" ? "delegation_revoked" : "delegation_conflict");
      if (canonicalTimestamp(delegation.deadline) <= command.now) fail("delegation_expired");
    }
    expireTask(command.input.projectId, command.input.nextTaskId, command.now);
    const evaluated = readiness(command.input.projectId, command.input.acceptedDelegationId);
    const ready = evaluated.tasks.find(({ task }) => task.id === command.input.nextTaskId);
    if (!ready || ready.task.revision !== command.input.expectedNextTaskRevision) {
      if (ready) fail("revision_conflict");
      fail("task_not_ready");
    }
    if (ready.liveClaimId) fail("claim_conflict");
    if (ready.blockers.length) {
      if (ready.blockers.some((value) => value.startsWith("delegation_live:"))) fail("delegation_conflict");
      fail("task_not_ready");
    }
    const context = taskContextPackSchema.parse(createContext());
    if (context.projectId !== command.input.projectId || context.taskId !== command.input.nextTaskId ||
      context.projectRevision !== command.input.expectedNextProjectRevision ||
      context.budgetTokens !== command.input.nextContextBudgetTokens) fail("coordination_unavailable");
    const storedContext = database.prepare("SELECT content_json FROM context_packs WHERE id = ?").get(context.id) as
      | { content_json: string } | undefined;
    if (storedContext && storedContext.content_json !== JSON.stringify(context)) fail("coordination_unavailable");
    if (!storedContext) database.prepare(`INSERT INTO context_packs VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      context.id, context.projectId, context.taskId, context.projectRevision, context.budgetTokens,
      context.estimatedTokens, JSON.stringify(context), context.generatedAt,
    );
    testOnlyFailpoint("context_creation");
    const sequenceRow = database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_checkpoints WHERE claim_id = ?
    `).get(current.id) as { sequence: number };
    database.prepare(`
      INSERT INTO task_checkpoints (
        id, claim_id, sequence, document_json, created_at, project_revision, task_revision, context_pack_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(command.ids.checkpointId, current.id, sequenceRow.sequence, documentJson, command.now,
      currentProject.revision, currentTask.revision, current.context_pack_id);
    database.prepare("UPDATE task_claims SET latest_checkpoint_id = ? WHERE id = ? AND state = 'active'")
      .run(command.ids.checkpointId, current.id);
    event({
      id: command.ids.checkpointEventId, category: "checkpoint", projectId: current.project_id,
      taskId: current.task_id, profileId: command.profileId, claimId: current.id,
      checkpointId: command.ids.checkpointId, priorState: "active", resultingState: "active",
      projectRevision: currentProject.revision, taskRevision: currentTask.revision, createdAt: command.now,
    });
    testOnlyFailpoint("checkpoint_insert");
    const previousState = command.input.terminalAction === "pause" ? "paused" : "released";
    const releasedDelegation = terminalizeClaimedDelegation(current, "revoked", command.now);
    database.prepare("UPDATE task_claims SET state = ?, ended_at = ? WHERE id = ? AND state = 'active'")
      .run(previousState, command.now, current.id);
    event({
      id: command.ids.transitionEventId, category: command.input.terminalAction,
      projectId: current.project_id, taskId: current.task_id, profileId: command.profileId,
      claimId: current.id, delegationId: releasedDelegation?.id ?? null,
      priorState: "active", resultingState: previousState,
      projectRevision: currentProject.revision, taskRevision: currentTask.revision, createdAt: command.now,
    });
    testOnlyFailpoint("old_claim_transition");
    const expiresAt = addMinutes(command.now, 30);
    const absoluteExpiresAt = addMinutes(command.now, 240);
    database.prepare(`
      INSERT INTO task_claims VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(command.ids.nextClaimId, command.input.projectId, command.input.nextTaskId,
      command.profileId, delegation?.id ?? null, command.input.expectedNextProjectRevision,
      command.input.expectedNextTaskRevision, context.id, command.now, expiresAt, absoluteExpiresAt);
    if (delegation) {
      const linked = database.prepare(`
        UPDATE task_delegations SET state = 'claimed', claim_id = ?
        WHERE id = ? AND state = 'accepted' AND child_profile_id = ?
          AND julianday(deadline) > julianday(?)
      `).run(command.ids.nextClaimId, delegation.id, command.profileId, command.now);
      if (linked.changes !== 1) fail("delegation_conflict");
    }
    event({
      id: command.ids.claimEventId, category: "claim", projectId: command.input.projectId,
      taskId: command.input.nextTaskId, profileId: command.profileId, claimId: command.ids.nextClaimId,
      delegationId: delegation?.id ?? null, priorState: null, resultingState: "active",
      projectRevision: currentProject.revision, taskRevision: ready.task.revision, createdAt: command.now,
    });
    testOnlyFailpoint("new_claim_insert");
    const result: SwitchTaskResult = {
      previousClaim: mapClaim(claimById.get(current.id) as ClaimRow),
      nextClaim: mapClaim(claimById.get(command.ids.nextClaimId) as ClaimRow),
      checkpoint: mapCheckpoint(checkpointById.get(command.ids.checkpointId) as CheckpointRow),
      contextPack: context,
    };
    persist(command, command.input.projectId, coordinationIdempotencyOperations.switch, result);
    return result;
  });

  const submitTransaction = database.transaction((
    command: AuthorizedSubmissionCommand,
    createProposal: (input: SubmitChangeSetInput, forceConflict: boolean) => ChangeSubmissionResult,
  ): SubmissionResult | CommittedCoordinationError => {
    const initial = claimById.get(command.input.claimId) as ClaimRow | undefined;
    if (!initial) fail("claim_conflict");
    validateAuthority(command.profileId, command.credentialGeneration, initial.project_id);
    if (initial.profile_id !== command.profileId) fail("coordination_authority_denied");
    const existing = replay<SubmissionResult>(command, initial.project_id, coordinationIdempotencyOperations.submit);
    if (existing) return existing;
    if (expireClaimAtDelegationDeadline(initial, command.now)) return committedClaimExpired();
    if (initial.state !== "active") {
      fail(initial.state === "expired" ? "claim_expired" : "claim_conflict");
    }
    if (initial.expires_at <= command.now) fail("claim_expired");

    const currentProject = project.get(initial.project_id) as ProjectRow | undefined;
    const currentTask = record.get(initial.project_id, initial.task_id) as ProjectRecordRow | undefined;
    if (!currentProject || !currentTask ||
      initial.base_project_revision !== command.input.expectedProjectRevision ||
      initial.base_task_revision !== command.input.expectedTaskRevision) {
      fail("revision_conflict");
    }
    if (currentTask.kind !== "task") fail("submission_stale");

    const checkpoint = initial.latest_checkpoint_id
      ? checkpointById.get(initial.latest_checkpoint_id) as CheckpointRow | undefined
      : undefined;
    if (!checkpoint || initial.latest_checkpoint_id !== command.input.checkpointId ||
      checkpoint.id !== command.input.checkpointId || checkpoint.claim_id !== initial.id ||
      checkpoint.project_revision !== command.input.expectedProjectRevision ||
      checkpoint.task_revision !== command.input.expectedTaskRevision ||
      checkpoint.context_pack_id !== initial.context_pack_id) {
      fail("submission_stale");
    }
    const context = database.prepare(`
      SELECT project_id, task_id, project_revision FROM context_packs WHERE id = ?
    `).get(initial.context_pack_id) as
      | { project_id: string; task_id: string; project_revision: number }
      | undefined;
    if (!context || context.project_id !== initial.project_id || context.task_id !== initial.task_id ||
      context.project_revision !== initial.base_project_revision) fail("submission_stale");

    const parsedDocument = submissionDocumentSchema.safeParse(command.input.submission);
    if (!parsedDocument.success) fail("submission_invalid");
    const documentJson = JSON.stringify(parsedDocument.data);
    if (Buffer.byteLength(documentJson, "utf8") > 262_144) fail("submission_invalid");
    const workerOperations = parsedDocument.data.changes.operations as SubmitChangeSetInput["operations"];
    const operationIds = new Set<string>();
    for (const operation of workerOperations) {
      if (operationIds.has(operation.operationId)) fail("submission_invalid");
      operationIds.add(operation.operationId);
      if (operation.type === "update_record" && operation.patch.status === "completed") {
        fail("submission_invalid");
      }
    }

    const revisionDrift = currentProject.revision !== initial.base_project_revision ||
      currentTask.revision !== initial.base_task_revision || currentTask.status !== "active";
    const submissionKeyHash = hash(command.input.idempotencyKey);
    const proposalIdempotencyKey = `coordination-submission-${submissionKeyHash}${
      revisionDrift ? "-conflicted" : ""
    }`;
    const completionOperationId = `coordination-task-completion-${submissionKeyHash}`;
    if (operationIds.has(completionOperationId)) fail("submission_invalid");

    let delegation: DelegationRow | undefined;
    if (initial.delegation_id) {
      delegation = delegationById.get(initial.delegation_id) as DelegationRow | undefined;
      if (!delegation || delegation.project_id !== initial.project_id ||
        delegation.task_id !== initial.task_id || delegation.child_profile_id !== command.profileId ||
        delegation.claim_id !== initial.id || delegation.state !== "claimed") fail("delegation_conflict");
      if (canonicalTimestamp(delegation.deadline) <= command.now) fail("delegation_expired");
      const allowedOutputs = new Set<string>(JSON.parse(delegation.allowed_outputs_json) as string[]);
      if (workerOperations.some((operation) => !allowedOutputs.has(operation.type))) {
        fail("submission_invalid");
      }
    }

    const proposalInput: SubmitChangeSetInput = {
      projectId: initial.project_id,
      baseProjectRevision: initial.base_project_revision,
      idempotencyKey: proposalIdempotencyKey,
      rationale: parsedDocument.data.changes.rationale,
      sourceTaskId: initial.task_id,
      predecessorProposalId: null,
      operations: [
        ...workerOperations,
        {
          operationId: completionOperationId,
          type: "update_record",
          recordId: initial.task_id,
          expectedRecordRevision: initial.base_task_revision,
          patch: { status: "completed" },
        },
      ],
    };
    const parsedProposalInput = submitChangeSetInputSchema.safeParse(proposalInput);
    if (!parsedProposalInput.success) fail("submission_invalid");
    const proposalResult = createProposal(
      parsedProposalInput.data as SubmitChangeSetInput,
      revisionDrift,
    );
    if ((proposalResult.outcome !== "proposed" && proposalResult.outcome !== "conflicted") ||
      !("proposalId" in proposalResult)) fail("submission_invalid");
    const proposalRow = proposalById.get(proposalResult.proposalId) as ChangeProposalRow | undefined;
    if (!proposalRow || proposalRow.project_id !== initial.project_id ||
      proposalRow.profile_id !== command.profileId || proposalRow.source_task_id !== initial.task_id ||
      proposalRow.base_project_revision !== initial.base_project_revision ||
      proposalRow.idempotency_key !== proposalIdempotencyKey ||
      proposalRow.rationale !== parsedDocument.data.changes.rationale ||
      proposalRow.state !== (proposalResult.outcome === "proposed" ? "pending" : "conflicted")) {
      fail("submission_invalid");
    }
    testOnlyFailpoint("proposal_creation");

    const submissionState = proposalResult.outcome === "conflicted" ? "conflicted" : "submitted";
    database.prepare(`
      INSERT INTO task_submissions (
        id, claim_id, checkpoint_id, profile_id, project_id, task_id,
        base_project_revision, base_task_revision, context_pack_id, document_json,
        proposal_id, state, submitted_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.ids.submissionId, initial.id, checkpoint.id, command.profileId,
      initial.project_id, initial.task_id, initial.base_project_revision,
      initial.base_task_revision, initial.context_pack_id, documentJson, proposalRow.id,
      submissionState, command.now, submissionState === "conflicted" ? command.now : null,
    );
    const transitioned = database.prepare(`
      UPDATE task_claims SET state = 'submitted', ended_at = ? WHERE id = ? AND state = 'active'
    `).run(command.now, initial.id);
    if (transitioned.changes !== 1) fail("claim_conflict");
    event({
      id: command.ids.eventId,
      category: submissionState === "conflicted" ? "conflict" : "submission",
      projectId: initial.project_id,
      taskId: initial.task_id,
      profileId: command.profileId,
      claimId: initial.id,
      delegationId: delegation?.id ?? null,
      checkpointId: checkpoint.id,
      submissionId: command.ids.submissionId,
      proposalId: proposalRow.id,
      priorState: "active",
      resultingState: submissionState,
      projectRevision: initial.base_project_revision,
      taskRevision: initial.base_task_revision,
      createdAt: command.now,
    });
    const result: SubmissionResult = {
      claim: mapClaim(claimById.get(initial.id) as ClaimRow),
      submission: mapSubmission(submissionByClaim.get(initial.id) as SubmissionRow),
      proposal: mapChangeProposalRow(proposalRow),
    };
    persist(command, initial.project_id, coordinationIdempotencyOperations.submit, result);
    return result;
  });

  return {
    listReadyTasks(input, profileId) {
      return readTransaction.immediate(input, profileId);
    },
    getCoordinationState(input, profileId) {
      return database.transaction((): CoordinationState => {
        validateReadAuthority(profileId, input.projectId);
        expire(input.projectId, canonicalTimestamp(now()));
        const projectRow = project.get(input.projectId) as ProjectRow | undefined;
        if (!projectRow || projectRow.revision !== input.expectedProjectRevision) fail("revision_conflict");
        const taskRow = record.get(input.projectId, input.taskId) as ProjectRecordRow | undefined;
        if (!taskRow || taskRow.kind !== "task") fail("task_not_ready");
        const claimRow = database.prepare("SELECT * FROM task_claims WHERE project_id = ? AND task_id = ? ORDER BY acquired_at DESC, rowid DESC LIMIT 1").get(input.projectId, input.taskId) as ClaimRow | undefined;
        const delegationRow = database.prepare("SELECT * FROM task_delegations WHERE project_id = ? AND task_id = ? ORDER BY offered_at DESC, rowid DESC LIMIT 1").get(input.projectId, input.taskId) as DelegationRow | undefined;
        const checkpointRow = claimRow?.latest_checkpoint_id ? checkpointById.get(claimRow.latest_checkpoint_id) as CheckpointRow | undefined : undefined;
        const submissionRow = claimRow ? submissionByClaim.get(claimRow.id) as SubmissionRow | undefined : undefined;
        return {
          projectRevision: projectRow.revision,
          task: mapProjectRecordRow(taskRow), claim: claimRow ? mapClaim(claimRow) : null,
          delegation: delegationRow ? mapDelegation(delegationRow) : null,
          latestCheckpoint: checkpointRow ? mapCheckpoint(checkpointRow) : null,
          submission: submissionRow ? mapSubmission(submissionRow) : null,
          events: (eventsForTask.all(input.projectId, input.taskId) as EventRow[]).map(mapEvent),
        };
      }).immediate();
    },
    getOwnedClaimSnapshot(claimId, profileId) {
      const row = claimById.get(claimId) as ClaimRow | undefined;
      return row?.profile_id === profileId ? mapClaim(row) : null;
    },
    getDelegationScope(delegationId, profileId) {
      const row = database.prepare(`
        SELECT project_id, task_id,
          CASE WHEN parent_profile_id = ? THEN 'parent' ELSE 'child' END AS role
        FROM task_delegations
        WHERE id = ? AND (parent_profile_id = ? OR child_profile_id = ?)
      `).get(profileId, delegationId, profileId, profileId) as
        | { project_id: string; task_id: string; role: "parent" | "child" }
        | undefined;
      return row
        ? { projectId: row.project_id, taskId: row.task_id, role: row.role }
        : null;
    },
    getDelegationForActor(delegationId, profileId) {
      const row = delegationById.get(delegationId) as DelegationRow | undefined;
      if (!row || (row.parent_profile_id !== profileId && row.child_profile_id !== profileId)) {
        return null;
      }
      return {
        delegation: mapDelegation(row),
        role: row.parent_profile_id === profileId ? "parent" : "child",
      };
    },
    claim(command, createContext) {
      return claimTransaction.immediate(withCanonicalNow(command), createContext);
    },
    renew(command) { return unwrapCommitted(renewTransaction.immediate(withCanonicalNow(command))); },
    checkpoint(command) { return unwrapCommitted(checkpointTransaction.immediate(withCanonicalNow(command))); },
    transition(command) { return unwrapCommitted(transitionTransaction.immediate(withCanonicalNow(command))); },
    switchTask(command, createContext) {
      return unwrapCommitted(switchTransaction.immediate(withCanonicalNow(command), createContext));
    },
    createDelegation(command) {
      return createDelegationTransaction.immediate(withCanonicalNow(command));
    },
    acceptDelegation(command) {
      return acceptDelegationTransaction.immediate(withCanonicalNow(command));
    },
    revokeDelegation(command) {
      return revokeDelegationTransaction.immediate(withCanonicalNow(command));
    },
    submit(command, createProposal) {
      return unwrapCommitted(submitTransaction.immediate(withCanonicalNow(command), createProposal));
    },
  };
};
