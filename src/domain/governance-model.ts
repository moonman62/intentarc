import type { z } from "zod";
import type {
  addScopeInputSchema,
  auditFilterSchema,
  createProfileInputSchema,
  createRepositoryRefreshProposalInputSchema,
  humanRecordUpdateInputSchema,
  proposalFilterSchema,
  setAuthorityInputSchema,
} from "./governance-schemas.js";
import type { RecordKind, RecordStatus, RelationshipKind } from "./model.js";

export type ProfileStatus = "enabled" | "disabled";
export type ClientExecutionMode = "safe" | "trusted" | "custom";
export type AuthorityMode = "proposal" | "scoped_direct" | "full_direct";
export type ChangeOperationType =
  | "create_record"
  | "update_record"
  | "create_relationship"
  | "remove_relationship";
export type ProposalState =
  | "pending"
  | "accepted"
  | "rejected"
  | "conflicted"
  | "withdrawn";
export type ChangeOutcome = "applied" | "proposed" | "conflicted" | "rejected";

export type ProposalOrigin =
  | { type: "profile"; profileId: string }
  | { type: "repository_refresh"; repositorySnapshotId: string };

export type RecordReference = { recordId: string } | { localRef: string };

export interface CreateRecordOperation {
  operationId: string;
  type: "create_record";
  localRef?: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  body: string;
}

export interface UpdateRecordOperation {
  operationId: string;
  type: "update_record";
  recordId: string;
  expectedRecordRevision: number;
  patch: {
    title?: string;
    body?: string;
    status?: RecordStatus;
  };
}

export interface CreateRelationshipOperation {
  operationId: string;
  type: "create_relationship";
  from: RecordReference;
  to: RecordReference;
  kind: RelationshipKind;
}

export interface RemoveRelationshipOperation {
  operationId: string;
  type: "remove_relationship";
  relationshipId: string;
}

export type ChangeOperation =
  | CreateRecordOperation
  | UpdateRecordOperation
  | CreateRelationshipOperation
  | RemoveRelationshipOperation;

export interface SubmitChangeSetInput {
  projectId: string;
  baseProjectRevision: number;
  idempotencyKey: string;
  rationale: string;
  sourceTaskId: string | null;
  predecessorProposalId: string | null;
  operations: ChangeOperation[];
}

export interface ClientProfile {
  id: string;
  name: string;
  status: ProfileStatus;
  executionMode: ClientExecutionMode;
  createdAt: string;
  updatedAt: string;
  tokenRotatedAt: string;
  lastUsedAt: string | null;
}

export interface StoredClientProfile extends ClientProfile {
  tokenHash: string;
}

export interface ProfileCredentials {
  profileId?: string;
  token?: string;
}

export interface AuthenticatedProfile {
  id: string;
  name: string;
  status: "enabled";
  credentialGeneration: string;
}

export interface ProfileProjectAuthority {
  id: string;
  profileId: string;
  projectId: string;
  mode: AuthorityMode;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileScope {
  id: string;
  authorityId: string;
  operationType: ChangeOperationType;
  recordKind: RecordKind | null;
  fromRecordKind: RecordKind | null;
  toRecordKind: RecordKind | null;
  relationshipKind: RelationshipKind | null;
  createdAt: string;
}

export interface AuthorityWithScopes {
  authority: ProfileProjectAuthority;
  scopes: ProfileScope[];
}

export interface ClientProfileSummary {
  profile: ClientProfile;
  authorities: AuthorityWithScopes[];
}

export interface ChangeProposal {
  id: string;
  projectId: string;
  origin: ProposalOrigin;
  sourceTaskId: string | null;
  predecessorProposalId: string | null;
  baseProjectRevision: number;
  state: ProposalState;
  rationale: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  reviewReason: string | null;
  reviewerActor: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface ProposalOperationRow {
  proposalId: string;
  position: number;
  operationId: string;
  operationType: ChangeOperationType;
  payloadJson: string;
  expectedRecordRevision: number | null;
}

export interface IdempotencyResultRow {
  profileId: string;
  projectId: string;
  idempotencyKey: string;
  changeId: string;
  requestHash: string;
  outcome: ChangeOutcome;
  resultJson: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  projectId: string | null;
  actorType: "local_human" | "profile";
  profileId: string | null;
  authorityMode: "human" | AuthorityMode | null;
  scopeDecision: string | null;
  actionCategory: string;
  targetId: string | null;
  idempotencyKey: string | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  outcome: string;
  reason: string | null;
  createdAt: string;
}

export interface CreateProfileInput extends z.infer<typeof createProfileInputSchema> {}
export interface SetAuthorityInput extends z.infer<typeof setAuthorityInputSchema> {}
export interface AddScopeInput extends z.infer<typeof addScopeInputSchema> {}
export interface ProposalFilter extends z.infer<typeof proposalFilterSchema> {}
export interface AuditFilter extends z.infer<typeof auditFilterSchema> {}
export interface HumanRecordUpdateInput
  extends z.infer<typeof humanRecordUpdateInputSchema> {}
export interface CreateRepositoryRefreshProposalInput
  extends z.infer<typeof createRepositoryRefreshProposalInputSchema> {}
