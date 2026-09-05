import type {
  AuditEvent,
  AuthorityMode,
  ClientExecutionMode,
  ChangeOperation,
  ChangeOperationType,
  ChangeOutcome,
  ChangeProposal,
  ClientProfile,
  IdempotencyResultRow,
  ProfileProjectAuthority,
  ProfileScope,
  ProfileStatus,
  ProposalState,
  RecordKind,
  RelationshipKind,
  StoredClientProfile,
} from "../domain/index.js";
import { clientExecutionModeSchema } from "../domain/index.js";

export type ClientProfileRow = {
  id: string;
  name: string;
  status: ProfileStatus;
  execution_mode: string;
  token_hash: string;
  created_at: string;
  updated_at: string;
  token_rotated_at: string;
  last_used_at: string | null;
};

export type ProfileProjectAuthorityRow = {
  id: string;
  profile_id: string;
  project_id: string;
  mode: AuthorityMode;
  created_at: string;
  updated_at: string;
};

export type ProfileScopeRow = {
  id: string;
  authority_id: string;
  operation_type: ChangeOperationType;
  record_kind: RecordKind | null;
  from_record_kind: RecordKind | null;
  to_record_kind: RecordKind | null;
  relationship_kind: RelationshipKind | null;
  created_at: string;
};

export type AuditEventRow = {
  id: string;
  project_id: string | null;
  actor_type: AuditEvent["actorType"];
  profile_id: string | null;
  authority_mode: AuditEvent["authorityMode"];
  scope_decision: string | null;
  action_category: string;
  target_id: string | null;
  idempotency_key: string | null;
  revision_before: number | null;
  revision_after: number | null;
  outcome: string;
  reason: string | null;
  created_at: string;
};

export type ChangeProposalRow = {
  id: string;
  project_id: string;
  profile_id: string | null;
  source_task_id: string | null;
  predecessor_proposal_id: string | null;
  base_project_revision: number;
  state: ProposalState;
  rationale: string;
  idempotency_key: string | null;
  request_hash: string | null;
  review_reason: string | null;
  reviewer_actor: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  origin_type: "profile" | "repository_refresh";
  repository_snapshot_id: string | null;
};

export type ProposalOperationStorageRow = {
  proposal_id: string;
  position: number;
  operation_id: string;
  operation_type: ChangeOperation["type"];
  expected_record_revision: number | null;
  payload_json: string;
};

export type IdempotencyStorageRow = {
  profile_id: string;
  project_id: string;
  idempotency_key: string;
  change_id: string;
  request_hash: string;
  outcome: ChangeOutcome;
  result_json: string;
  created_at: string;
};

export type ProfileChangeStorageRow = IdempotencyStorageRow & {
  proposal_id: string | null;
  proposal_state: ProposalState | null;
};

export const mapStoredClientProfileRow = (
  row: ClientProfileRow,
): StoredClientProfile => ({
  ...mapClientProfileRow(row),
  tokenHash: row.token_hash,
});

export const mapClientProfileRow = (row: ClientProfileRow): ClientProfile => ({
  id: row.id,
  name: row.name,
  status: row.status,
  executionMode: clientExecutionModeSchema.parse(row.execution_mode),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  tokenRotatedAt: row.token_rotated_at,
  lastUsedAt: row.last_used_at,
});

export const mapProfileProjectAuthorityRow = (
  row: ProfileProjectAuthorityRow,
): ProfileProjectAuthority => ({
  id: row.id,
  profileId: row.profile_id,
  projectId: row.project_id,
  mode: row.mode,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapProfileScopeRow = (row: ProfileScopeRow): ProfileScope => ({
  id: row.id,
  authorityId: row.authority_id,
  operationType: row.operation_type,
  recordKind: row.record_kind,
  fromRecordKind: row.from_record_kind,
  toRecordKind: row.to_record_kind,
  relationshipKind: row.relationship_kind,
  createdAt: row.created_at,
});

export const mapAuditEventRow = (row: AuditEventRow): AuditEvent => ({
  id: row.id,
  projectId: row.project_id,
  actorType: row.actor_type,
  profileId: row.profile_id,
  authorityMode: row.authority_mode,
  scopeDecision: row.scope_decision,
  actionCategory: row.action_category,
  targetId: row.target_id,
  idempotencyKey: row.idempotency_key,
  revisionBefore: row.revision_before,
  revisionAfter: row.revision_after,
  outcome: row.outcome,
  reason: row.reason,
  createdAt: row.created_at,
});

export const mapChangeProposalRow = (
  row: ChangeProposalRow,
): ChangeProposal => ({
  id: row.id,
  projectId: row.project_id,
  origin: row.origin_type === "profile"
    ? { type: "profile", profileId: row.profile_id! }
    : {
        type: "repository_refresh",
        repositorySnapshotId: row.repository_snapshot_id!,
      },
  sourceTaskId: row.source_task_id,
  predecessorProposalId: row.predecessor_proposal_id,
  baseProjectRevision: row.base_project_revision,
  state: row.state,
  rationale: row.rationale,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  reviewReason: row.review_reason,
  reviewerActor: row.reviewer_actor,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reviewedAt: row.reviewed_at,
});

export const mapIdempotencyStorageRow = (
  row: IdempotencyStorageRow,
): IdempotencyResultRow => ({
  profileId: row.profile_id,
  projectId: row.project_id,
  idempotencyKey: row.idempotency_key,
  changeId: row.change_id,
  requestHash: row.request_hash,
  outcome: row.outcome,
  resultJson: row.result_json,
  createdAt: row.created_at,
});
