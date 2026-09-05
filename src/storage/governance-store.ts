import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GovernanceError,
  ProjectNotFoundError,
  RelationshipAlreadyExistsError,
  auditFilterSchema,
  changeProposalSchema,
  changeOperationSchema,
  createRepositoryRefreshProposalInputSchema,
  idempotencyResultRowSchema,
  isRecordStatusTransitionAllowed,
  proposalFilterSchema,
  submitChangeSetInputSchema,
  appliedDirectResultSchema,
  appliedProposalResultSchema,
  directConflictResultSchema,
  parseStoredSubmissionResult as parseStoredSubmissionResultValue,
  proposalSubmissionResultSchema,
  storedProposalRejectionResultSchema,
  submissionRejectionResultSchema,
  type AuditEvent,
  type AuditFilter,
  type AuthorityMode,
  type ChangeOperation,
  type ChangeOutcome,
  type ChangeProposal,
  type CreateRecordOperation,
  type CreateRepositoryRefreshProposalInput,
  type CreateRelationshipOperation,
  type IdempotencyResultRow,
  type ProjectRecord,
  type ProposalFilter,
  type ProposalState,
  type RecordReference,
  type RecordRelationship,
  type RemoveRelationshipOperation,
  type SourceKind,
  type SubmitChangeSetInput,
  type UpdateRecordOperation,
} from "../domain/index.js";
import type { OperationFacts } from "../core/authorization-policy.js";
import type { IntentArcDatabase } from "./database.js";
import {
  ideaCaptureIdempotencySchema,
  parseStoredHumanChangeReplay,
} from "./human-change-replay.js";
import {
  mapAuditEventRow,
  mapChangeProposalRow,
  mapIdempotencyStorageRow as mapIdempotencyRowFields,
  type AuditEventRow,
  type ChangeProposalRow,
  type IdempotencyStorageRow,
  type ProfileChangeStorageRow,
  type ProposalOperationStorageRow,
} from "./governance-mappers.js";
import { validateParentHierarchy } from "./project-store.js";
import {
  mapProjectRecordRow,
  mapRecordRelationshipRow,
  type ProjectRecordRow,
  type RecordRelationshipRow,
} from "./row-mappers.js";

export type AuditActor =
  | { type: "local_human" }
  | { type: "profile"; profileId: string };

export type PreparedCreateRecordOperation = CreateRecordOperation & {
  sourceKind: SourceKind;
  sourceRef: string | null;
};

export type PreparedUpdateRecordOperation = UpdateRecordOperation;
export type PreparedCreateRelationshipOperation = CreateRelationshipOperation;
export type PreparedRemoveRelationshipOperation = RemoveRelationshipOperation;

export type PreparedChangeOperation =
  | PreparedCreateRecordOperation
  | PreparedUpdateRecordOperation
  | PreparedCreateRelationshipOperation
  | PreparedRemoveRelationshipOperation;

export interface PreparedChangeSet {
  changeId: string;
  projectId: string;
  idempotencyKey: string | null;
  rationale: string;
  sourceTaskId: string | null;
  operations: PreparedChangeOperation[];
}

export interface ApplyPreparedChangeSetCommand {
  actor: AuditActor;
  authorityMode: AuthorityMode | "human";
  scopeDecision: string;
  changeSet: PreparedChangeSet;
  expectedProjectRevision: number;
  auditEventId: string;
  completedAt: string;
}

export type AppliedOperationResult =
  | {
      operationId: string;
      type: "create_record";
      record: ProjectRecord;
    }
  | {
      operationId: string;
      type: "update_record";
      record: ProjectRecord;
    }
  | {
      operationId: string;
      type: "create_relationship";
      relationship: RecordRelationship;
    }
  | {
      operationId: string;
      type: "remove_relationship";
      relationship: RecordRelationship;
    };

export interface AppliedChangeSetResult {
  outcome: "applied";
  projectId: string;
  revisionBefore: number;
  revisionAfter: number;
  operations: AppliedOperationResult[];
  replayPayloadJson?: string;
}

export interface ChangeSetFacts {
  projectRevision: number;
  operations: OperationFacts[];
}

export interface IdempotencyLookup {
  profileId: string;
  projectId: string;
  idempotencyKey: string;
}

export interface ResolveSubmissionIdempotencyCommand {
  profileId: string;
  credentialGeneration: string;
  input: SubmitChangeSetInput;
  resolvedAt: string;
  forceConflict?: boolean;
}

export interface CreateProposalCommand {
  profileId: string;
  credentialGeneration: string;
  authorityMode: AuthorityMode;
  scopeDecision: string;
  input: SubmitChangeSetInput;
  submittedAt: string;
  /** Internal coordination evidence path: preserve a task-revision conflict even when the project revision is unchanged. */
  forceConflict?: boolean;
}

export interface CreateRepositoryRefreshProposalCommand {
  input: CreateRepositoryRefreshProposalInput;
  createdAt: string;
}

export interface ApplyDirectCommand {
  profileId: string;
  credentialGeneration: string;
  authorityMode: "scoped_direct" | "full_direct";
  scopeDecision: string;
  input: SubmitChangeSetInput;
  completedAt: string;
}

export interface ApplyHumanChangeCommand {
  projectId: string;
  expectedProjectRevision?: number;
  rationale: string;
  operations: PreparedChangeOperation[];
  completedAt: string;
  idempotency?: {
    operationScope: string;
    key: string;
    requestHash: string;
    replayPayloadJson?: string;
  };
}

export interface AcceptProposalCommand {
  proposalId: string;
  reason: string | null;
  reviewedAt: string;
}

export interface RejectProposalCommand {
  proposalId: string;
  reason: string;
  reviewedAt: string;
}

export interface WithdrawProposalCommand {
  proposalId: string;
  reason: string;
  reviewedAt: string;
}

export interface RecordSubmissionRejectionCommand {
  profileId: string;
  credentialGeneration: string;
  input: SubmitChangeSetInput;
  rejectedAt: string;
}

export type SubmissionRejectionResult = {
  outcome: "rejected";
  changeId: string;
  code: "project_authority_missing";
  reason: "project_authority_missing";
  replayed: boolean;
};

export type ProposalSubmissionResult =
  | {
      outcome: "proposed";
      changeId: string;
      proposalId: string;
      state: "pending";
      replayed: boolean;
    }
  | {
      outcome: "conflicted";
      changeId: string;
      proposalId: string;
      state: "conflicted";
      currentProjectRevision: number;
      replayed: boolean;
    };

export type IdempotencyConflictResult = {
  outcome: "rejected";
  changeId: string;
  code: "idempotency_conflict";
  reason: string;
  replayed: false;
};

export type DirectConflictResult = {
  outcome: "conflicted";
  changeId: string;
  code: "project_revision_conflict" | "record_revision_conflict";
  currentProjectRevision: number;
  expectedProjectRevision?: number;
  recordId?: string;
  expectedRecordRevision?: number;
  actualRecordRevision?: number;
  replayed: boolean;
};

export type AppliedDirectResult = AppliedChangeSetResult & {
  changeId: string;
  replayed: boolean;
};

export type AppliedProposalResult = {
  outcome: "applied";
  changeId: string;
  proposalId: string;
  projectRevision: number;
  operations: AppliedOperationResult[];
  replayed: boolean;
};

export type StoredProposalRejectionResult = {
  outcome: "rejected";
  changeId: string;
  code: "operation_denied";
  reason: string;
  replayed: false;
};

export type ProposalRejectionResult = Omit<
  StoredProposalRejectionResult,
  "replayed"
> & {
  replayed: boolean;
};

export type ProposalDecisionResult =
  | {
      outcome: "applied";
      changeId: string;
      proposalId: string;
      projectRevision: number;
      operations: AppliedOperationResult[];
    }
  | {
      outcome: "conflicted";
      changeId: string;
      proposalId: string;
      currentProjectRevision: number;
    };

export type StoredDirectSubmissionResult =
  | AppliedDirectResult
  | DirectConflictResult;

export type StoredSubmissionResult =
  | ProposalSubmissionResult
  | StoredDirectSubmissionResult
  | AppliedProposalResult
  | StoredProposalRejectionResult
  | SubmissionRejectionResult;

export type SubmissionResult =
  | StoredSubmissionResult
  | ProposalRejectionResult
  | IdempotencyConflictResult;

export type DirectSubmissionResult = SubmissionResult;

export interface StoredIdempotencyResult
  extends Omit<IdempotencyResultRow, "resultJson"> {
  result: StoredSubmissionResult;
}

export interface ChangeProposalSummary {
  id: string;
  projectId: string;
  origin: ChangeProposal["origin"];
  sourceTaskId: string | null;
  predecessorProposalId: string | null;
  baseProjectRevision: number;
  state: ProposalState;
  rationale: string;
  idempotencyKey: string | null;
  reviewReason: string | null;
  reviewerActor: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface ChangeProposalDetail extends ChangeProposal {
  operations: ChangeOperation[];
}

export interface ProfileChangeFilter {
  profileId: string;
  projectId?: string;
  outcome?: ChangeOutcome;
}

export interface ProfileChangeSummary {
  changeId: string;
  profileId: string;
  projectId: string;
  outcome: ChangeOutcome;
  proposalId: string | null;
  state: ProposalState | null;
  createdAt: string;
}

export interface ProfileChangeDetail extends ProfileChangeSummary {
  idempotencyKey: string;
  result: StoredSubmissionResult;
  proposal?: ChangeProposalDetail;
}

export type AuditQueryFilter = AuditFilter & { limit?: number };

export interface GovernanceStore {
  inspectChangeSet(
    projectId: string,
    operations: ChangeOperation[],
  ): ChangeSetFacts;
  getIdempotencyResult(
    key: IdempotencyLookup,
  ): StoredIdempotencyResult | null;
  resolveSubmissionIdempotency(
    command: ResolveSubmissionIdempotencyCommand,
  ): SubmissionResult | null;
  createProposal(
    command: CreateProposalCommand,
  ): SubmissionResult;
  createRepositoryRefreshProposal(
    command: CreateRepositoryRefreshProposalCommand,
  ): ChangeProposalDetail;
  acceptProposal(command: AcceptProposalCommand): ProposalDecisionResult;
  rejectProposal(command: RejectProposalCommand): ChangeProposalDetail;
  withdrawProposal(command: WithdrawProposalCommand): ChangeProposalDetail;
  applyDirect(command: ApplyDirectCommand): SubmissionResult;
  applyHumanChange(
    command: ApplyHumanChangeCommand,
  ): AppliedChangeSetResult;
  recordSubmissionRejection(
    command: RecordSubmissionRejectionCommand,
  ): SubmissionResult;
  listProfileChanges(filter: ProfileChangeFilter): ProfileChangeSummary[];
  getProfileChange(
    profileId: string,
    changeId: string,
  ): ProfileChangeDetail | null;
  getProposal(proposalId: string): ChangeProposalDetail | null;
  listProposals(filter: ProposalFilter): ChangeProposalSummary[];
  listAuditEvents(filter: AuditQueryFilter): AuditEvent[];
  applyPreparedChangeSet(
    command: ApplyPreparedChangeSetCommand,
  ): AppliedChangeSetResult;
}

export interface GovernanceStoreDependencies {
  newId: (
    prefix:
      | "record"
      | "relationship"
      | "change"
      | "proposal"
      | "audit",
  ) => string;
}

type ProjectRevisionRow = {
  id: string;
  revision: number;
};

type ProfileSecurityRow = {
  status: "enabled" | "disabled";
  token_rotated_at: string;
};

type PlannedOperation =
  | {
      type: "create_record";
      operationId: string;
      record: ProjectRecord;
    }
  | {
      type: "update_record";
      operationId: string;
      expectedRecordRevision: number;
      record: ProjectRecord;
    }
  | {
      type: "create_relationship";
      operationId: string;
      relationship: RecordRelationship;
    }
  | {
      type: "remove_relationship";
      operationId: string;
      relationship: RecordRelationship;
    };

const validationFailure = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): GovernanceError => new GovernanceError("validation_failed", message, details);

const projectRevisionConflict = (
  projectId: string,
  expectedRevision: number,
  actualRevision: number,
): GovernanceError =>
  new GovernanceError(
    "project_revision_conflict",
    `Project revision conflict for ${projectId}: expected ${expectedRevision}, actual ${actualRevision}`,
    { projectId, expectedRevision, actualRevision },
  );

const recordRevisionConflict = (
  recordId: string,
  expectedRevision: number,
  actualRevision: number,
): GovernanceError =>
  new GovernanceError(
    "record_revision_conflict",
    `Record revision conflict for ${recordId}: expected ${expectedRevision}, actual ${actualRevision}`,
    { recordId, expectedRevision, actualRevision },
  );

const sourceKinds: readonly SourceKind[] = [
  "human",
  "repository",
  "agent",
  "import",
];

const validatePreparedOperation = (
  operation: PreparedChangeOperation,
): PreparedChangeOperation => {
  if (operation.type === "create_record") {
    const {
      sourceKind,
      sourceRef,
      ...validatedCreateOperation
    } = operation;
    const parsed = changeOperationSchema.safeParse(validatedCreateOperation);
    if (!parsed.success) {
      throw validationFailure("Invalid prepared create_record operation", {
        operationId: operation.operationId,
        issues: parsed.error.issues,
      });
    }
    if (!sourceKinds.includes(sourceKind)) {
      throw validationFailure("Invalid record source kind", {
        operationId: operation.operationId,
        sourceKind,
      });
    }
    if (
      sourceRef !== null &&
      (typeof sourceRef !== "string" || sourceRef.trim().length === 0)
    ) {
      throw validationFailure("Invalid record source reference", {
        operationId: operation.operationId,
      });
    }
    return {
      ...(parsed.data as CreateRecordOperation),
      sourceKind,
      sourceRef: sourceRef === null ? null : sourceRef.trim(),
    };
  }

  const parsed = changeOperationSchema.safeParse(operation);
  if (!parsed.success) {
    throw validationFailure(`Invalid prepared ${operation.type} operation`, {
      operationId: operation.operationId,
      issues: parsed.error.issues,
    });
  }
  return parsed.data as PreparedChangeOperation;
};

const relationshipIdentity = (
  fromRecordId: string,
  toRecordId: string,
  kind: string,
): string => `${fromRecordId}\u0000${toRecordId}\u0000${kind}`;

type SqliteError = Error & { code?: string };

const isDuplicateRelationshipConstraint = (error: unknown): boolean =>
  error instanceof Error &&
  (error as SqliteError).code === "SQLITE_CONSTRAINT_UNIQUE" &&
  error.message.includes(
    "record_relationships.from_record_id, record_relationships.to_record_id, record_relationships.kind",
  );

const nonEmptyString = z.string().trim().min(1);

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const idempotencyConflictResultSchema = z
  .object({
    outcome: z.literal("rejected"),
    changeId: nonEmptyString,
    code: z.literal("idempotency_conflict"),
    reason: nonEmptyString,
    replayed: z.literal(false),
  })
  .strict();


const idempotencyConflictReason =
  "The idempotency key was already used for a different request";

const parseStoredSubmissionResult = (
  resultJson: string,
): StoredSubmissionResult => parseStoredSubmissionResultValue(resultJson) as StoredSubmissionResult;

const normalizedRequestHash = (
  input: SubmitChangeSetInput,
  forceConflict = false,
): string => {
  const normalized = JSON.stringify({
    projectId: input.projectId,
    baseProjectRevision: input.baseProjectRevision,
    rationale: input.rationale,
    sourceTaskId: input.sourceTaskId,
    predecessorProposalId: input.predecessorProposalId,
    operations: input.operations,
    ...(forceConflict ? { coordinationForceConflict: true } : {}),
  });
  return createHash("sha256").update(normalized).digest("hex");
};

const mapProposalRow = (row: ChangeProposalRow): ChangeProposal => {
  const parsed = changeProposalSchema.safeParse(mapChangeProposalRow(row));
  if (!parsed.success) {
    throw new GovernanceError(
      "internal_error",
      "Stored proposal metadata is corrupt",
    );
  }
  return parsed.data;
};

const proposalSummary = (
  proposal: ChangeProposal,
): ChangeProposalSummary => ({
  id: proposal.id,
  projectId: proposal.projectId,
  origin: proposal.origin,
  sourceTaskId: proposal.sourceTaskId,
  predecessorProposalId: proposal.predecessorProposalId,
  baseProjectRevision: proposal.baseProjectRevision,
  state: proposal.state,
  rationale: proposal.rationale,
  idempotencyKey: proposal.idempotencyKey,
  reviewReason: proposal.reviewReason,
  reviewerActor: proposal.reviewerActor,
  createdAt: proposal.createdAt,
  updatedAt: proposal.updatedAt,
  reviewedAt: proposal.reviewedAt,
});

const mapIdempotencyStorageRow = (
  row: IdempotencyStorageRow,
): StoredIdempotencyResult => {
  const parsed = idempotencyResultRowSchema.safeParse(
    mapIdempotencyRowFields(row),
  );
  if (!parsed.success) {
    throw new GovernanceError(
      "internal_error",
      "Stored idempotency result metadata is corrupt",
    );
  }
  const validated = parsed.data;
  const result = parseStoredSubmissionResult(validated.resultJson);
  if (
    result.changeId !== validated.changeId ||
    result.outcome !== validated.outcome ||
    result.replayed !== false
  ) {
    throw new GovernanceError(
      "internal_error",
      "Stored idempotency result is inconsistent",
    );
  }
  return {
    profileId: validated.profileId,
    projectId: validated.projectId,
    idempotencyKey: validated.idempotencyKey,
    changeId: validated.changeId,
    requestHash: validated.requestHash,
    outcome: validated.outcome,
    result,
    createdAt: validated.createdAt,
  };
};

export const createGovernanceStore = (
  database: IntentArcDatabase,
  dependencies: GovernanceStoreDependencies,
): GovernanceStore => {
  const selectProjectRevision = database.prepare(
    "SELECT id, revision FROM projects WHERE id = ?",
  );
  const selectProfileSecurity = database.prepare(`
    SELECT status, token_rotated_at
    FROM client_profiles
    WHERE id = ?
  `);
  const selectRecordById = database.prepare(
    `SELECT
       id, project_id, kind, status, title, body, source_kind, source_ref,
       revision, created_at, updated_at
     FROM project_records
     WHERE id = ?`,
  );
  const selectRelationshipById = database.prepare(
    `SELECT
       id, project_id, from_record_id, to_record_id, kind, created_at
     FROM record_relationships
     WHERE id = ?`,
  );
  const selectRelationshipByIdentity = database.prepare(
    `SELECT
       id, project_id, from_record_id, to_record_id, kind, created_at
     FROM record_relationships
     WHERE from_record_id = @fromRecordId
       AND to_record_id = @toRecordId
      AND kind = @kind`,
  );
  const selectRecordsByProject = database.prepare(`
    SELECT id, project_id, kind, status, title, body, source_kind, source_ref,
           revision, created_at, updated_at
    FROM project_records
    WHERE project_id = ?
  `);
  const selectRelationshipsByProject = database.prepare(`
    SELECT id, project_id, from_record_id, to_record_id, kind, created_at
    FROM record_relationships
    WHERE project_id = ?
  `);
  const selectRecordId = database.prepare(
    "SELECT id FROM project_records WHERE id = ?",
  );
  const selectRelationshipId = database.prepare(
    "SELECT id FROM record_relationships WHERE id = ?",
  );
  const insertRecord = database.prepare(`
    INSERT INTO project_records (
      id, project_id, kind, status, title, body, source_kind, source_ref,
      revision, created_at, updated_at
    ) VALUES (
      @id, @projectId, @kind, @status, @title, @body, @sourceKind, @sourceRef,
      @revision, @createdAt, @updatedAt
    )
  `);
  const updateRecord = database.prepare(`
    UPDATE project_records
    SET title = @title,
        body = @body,
        status = @status,
        revision = @revision,
        updated_at = @updatedAt
    WHERE id = @id
      AND project_id = @projectId
      AND revision = @expectedRecordRevision
  `);
  const insertRecordRevision = database.prepare(`
    INSERT INTO project_record_revisions (
      record_id, revision, snapshot_json, created_at
    ) VALUES (
      @recordId, @revision, @snapshotJson, @createdAt
    )
  `);
  const insertRelationship = database.prepare(`
    INSERT INTO record_relationships (
      id, project_id, from_record_id, to_record_id, kind, created_at
    ) VALUES (
      @id, @projectId, @fromRecordId, @toRecordId, @kind, @createdAt
    )
  `);
  const deleteRelationship = database.prepare(`
    DELETE FROM record_relationships
    WHERE id = @id AND project_id = @projectId
  `);
  const incrementProjectRevision = database.prepare(`
    UPDATE projects
    SET revision = revision + 1, updated_at = @updatedAt
    WHERE id = @projectId AND revision = @expectedProjectRevision
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, @actorType, @profileId, @authorityMode, @scopeDecision,
      'change_applied', @targetId, @idempotencyKey, @revisionBefore,
      @revisionAfter, 'applied', @reason, @createdAt
    )
  `);
  const proposalColumns = `
    id, project_id, profile_id, source_task_id, predecessor_proposal_id,
    base_project_revision, state, rationale, idempotency_key, request_hash,
    review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
    origin_type, repository_snapshot_id
  `;
  const selectProposalById = database.prepare(`
    SELECT ${proposalColumns}
    FROM change_proposals
    WHERE id = ?
  `);
  const selectProposals = database.prepare(`
    SELECT ${proposalColumns}
    FROM change_proposals
    ORDER BY created_at DESC, id DESC
  `);
  const selectProposalOperations = database.prepare(`
    SELECT
      proposal_id, position, operation_id, operation_type,
      expected_record_revision, payload_json
    FROM proposal_operations
    WHERE proposal_id = ?
    ORDER BY position
  `);
  const selectRepositorySnapshotForProposal = database.prepare(`
    SELECT id, project_id, state
    FROM repository_snapshots
    WHERE id = ?
  `);
  const insertProposal = database.prepare(`
    INSERT INTO change_proposals (
      id, project_id, profile_id, source_task_id, predecessor_proposal_id,
      base_project_revision, state, rationale, idempotency_key, request_hash,
      review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
      origin_type, repository_snapshot_id
    ) VALUES (
      @id, @projectId, @profileId, @sourceTaskId, @predecessorProposalId,
      @baseProjectRevision, @state, @rationale, @idempotencyKey, @requestHash,
      NULL, NULL, @createdAt, @updatedAt, NULL,
      @originType, @repositorySnapshotId
    )
  `);
  const insertProposalOperation = database.prepare(`
    INSERT INTO proposal_operations (
      proposal_id, position, operation_id, operation_type,
      expected_record_revision, payload_json
    ) VALUES (
      @proposalId, @position, @operationId, @operationType,
      @expectedRecordRevision, @payloadJson
    )
  `);
  const decidePendingProposal = database.prepare(`
    UPDATE change_proposals
    SET state = @state,
        review_reason = @reviewReason,
        reviewer_actor = 'local_human',
        updated_at = @reviewedAt,
        reviewed_at = @reviewedAt
    WHERE id = @proposalId
      AND state = 'pending'
  `);
  const selectCoordinationReconciliation = database.prepare(`
    SELECT
      submission.id AS submission_id,
      submission.profile_id,
      submission.project_id,
      submission.task_id,
      submission.checkpoint_id,
      submission.claim_id,
      claim.delegation_id,
      record.revision AS task_revision
    FROM task_submissions AS submission
    JOIN task_claims AS claim ON claim.id = submission.claim_id
    JOIN project_records AS record
      ON record.id = submission.task_id
      AND record.project_id = submission.project_id
    WHERE submission.proposal_id = ?
  `);
  const insertCoordinationReconciliation = database.prepare(`
    INSERT INTO coordination_events (
      id, category, project_id, task_id, profile_id, claim_id,
      delegation_id, checkpoint_id, submission_id, proposal_id,
      prior_state, resulting_state, project_revision, task_revision,
      detail, created_at
    ) VALUES (
      @id, 'reconciliation', @projectId, @taskId, @profileId, @claimId,
      @delegationId, @checkpointId, @submissionId, @proposalId,
      'submitted', 'reconciled', @projectRevision, @taskRevision,
      'Governed proposal accepted.', @createdAt
    )
  `);
  const selectIdempotencyResult = database.prepare(`
    SELECT
      profile_id, project_id, idempotency_key, change_id, request_hash,
      outcome, result_json, created_at
    FROM idempotency_results
    WHERE profile_id = @profileId
      AND project_id = @projectId
      AND idempotency_key = @idempotencyKey
  `);
  const insertIdempotencyResult = database.prepare(`
    INSERT INTO idempotency_results (
      profile_id, project_id, idempotency_key, change_id, request_hash,
      outcome, result_json, created_at
    ) VALUES (
      @profileId, @projectId, @idempotencyKey, @changeId, @requestHash,
      @outcome, @resultJson, @createdAt
    )
  `);
  const updateIdempotencyResult = database.prepare(`
    UPDATE idempotency_results
    SET outcome = @outcome,
        result_json = @resultJson
    WHERE profile_id = @profileId
      AND project_id = @projectId
      AND idempotency_key = @idempotencyKey
      AND change_id = @changeId
  `);
  const selectHumanChangeIdempotencyMetadata = database.prepare(`
    SELECT operation_scope, idempotency_key
    FROM human_change_idempotency_results
    WHERE project_id = @projectId
    ORDER BY operation_scope, idempotency_key
  `);
  const selectHumanChangeIdempotencyResult = database.prepare(`
    SELECT
      project_id, operation_scope, idempotency_key, request_hash, result_json
    FROM human_change_idempotency_results
    WHERE project_id = @projectId
      AND operation_scope = @operationScope
      AND idempotency_key = @key
  `);
  const insertHumanChangeIdempotencyResult = database.prepare(`
    INSERT INTO human_change_idempotency_results (
      project_id, operation_scope, idempotency_key, request_hash, result_json,
      created_at
    ) VALUES (
      @projectId, @operationScope, @key, @requestHash, @resultJson,
      @createdAt
    )
  `);
  const insertGovernanceAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'profile', @profileId, @authorityMode, @scopeDecision,
      @actionCategory, @targetId, @idempotencyKey, @revisionBefore,
      @revisionAfter, @outcome, @reason, @createdAt
    )
  `);
  const insertProposalReviewAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_review',
      @actionCategory, @targetId, @idempotencyKey, @revisionBefore,
      @revisionAfter, @outcome, @reason, @createdAt
    )
  `);
  const selectProfileChanges = database.prepare(`
    SELECT
      i.profile_id, i.project_id, i.idempotency_key, i.change_id,
      i.request_hash, i.outcome, i.result_json, i.created_at,
      p.id AS proposal_id, p.state AS proposal_state
    FROM idempotency_results i
    LEFT JOIN change_proposals p
      ON p.profile_id = i.profile_id
     AND p.project_id = i.project_id
     AND p.idempotency_key = i.idempotency_key
     AND p.origin_type = 'profile'
    WHERE i.profile_id = @profileId
      AND (@projectId IS NULL OR i.project_id = @projectId)
      AND (@outcome IS NULL OR i.outcome = @outcome)
    ORDER BY i.created_at DESC, i.change_id DESC
  `);
  const selectProfileChange = database.prepare(`
    SELECT
      i.profile_id, i.project_id, i.idempotency_key, i.change_id,
      i.request_hash, i.outcome, i.result_json, i.created_at,
      p.id AS proposal_id, p.state AS proposal_state
    FROM idempotency_results i
    LEFT JOIN change_proposals p
      ON p.profile_id = i.profile_id
     AND p.project_id = i.project_id
     AND p.idempotency_key = i.idempotency_key
     AND p.origin_type = 'profile'
    WHERE i.profile_id = ?
      AND i.change_id = ?
  `);

  const applyPreparedChangeSetBody = (
    command: ApplyPreparedChangeSetCommand,
  ): AppliedChangeSetResult => {
      const {
        actor,
        authorityMode,
        scopeDecision,
        changeSet,
        expectedProjectRevision,
        auditEventId,
        completedAt,
      } = command;
      const projectRow = selectProjectRevision.get(
        changeSet.projectId,
      ) as ProjectRevisionRow | undefined;

      if (!projectRow) {
        throw new ProjectNotFoundError(changeSet.projectId);
      }
      if (projectRow.revision !== expectedProjectRevision) {
        throw projectRevisionConflict(
          changeSet.projectId,
          expectedProjectRevision,
          projectRow.revision,
        );
      }
      if (changeSet.operations.length === 0) {
        throw validationFailure("Prepared change sets require at least one operation", {
          changeId: changeSet.changeId,
        });
      }

      const operationIds = new Set<string>();
      const updatedRecordTargets = new Set<string>();
      const localRecords = new Map<string, ProjectRecord>();
      const existingRecords = new Map<string, ProjectRecord>();
      const plannedRecordIds = new Set<string>();
      const plannedRelationshipIds = new Set<string>();
      const activePlannedRelationships = new Map<string, RecordRelationship>();
      const removedRelationshipIds = new Set<string>();
      const plannedOperations: PlannedOperation[] = [];

      const existingRecord = (recordId: string): ProjectRecord => {
        const cached = existingRecords.get(recordId);
        if (cached) return cached;

        const row = selectRecordById.get(recordId) as
          | ProjectRecordRow
          | undefined;
        if (!row || row.project_id !== changeSet.projectId) {
          throw validationFailure(
            `Record does not belong to project ${changeSet.projectId}: ${recordId}`,
            { projectId: changeSet.projectId, recordId },
          );
        }
        const record = mapProjectRecordRow(row);
        existingRecords.set(recordId, record);
        return record;
      };

      const resolveReference = (
        reference: RecordReference,
        operationId: string,
      ): ProjectRecord => {
        if ("localRef" in reference) {
          const record = localRecords.get(reference.localRef);
          if (!record) {
            throw validationFailure(
              `Unknown or forward local reference: ${reference.localRef}`,
              { operationId, localRef: reference.localRef },
            );
          }
          return record;
        }

        return existingRecord(reference.recordId);
      };

      for (const preparedOperation of changeSet.operations) {
        const operation = validatePreparedOperation(preparedOperation);
        if (operationIds.has(operation.operationId)) {
          throw validationFailure("operationId values must be unique", {
            operationId: operation.operationId,
          });
        }
        operationIds.add(operation.operationId);

        switch (operation.type) {
          case "create_record": {
            if (operation.localRef && localRecords.has(operation.localRef)) {
              throw validationFailure("localRef values must be unique", {
                operationId: operation.operationId,
                localRef: operation.localRef,
              });
            }
            const recordId = dependencies.newId("record");
            if (
              plannedRecordIds.has(recordId) ||
              selectRecordId.get(recordId) !== undefined
            ) {
              throw validationFailure(`Generated record ID already exists: ${recordId}`, {
                operationId: operation.operationId,
                recordId,
              });
            }
            const record: ProjectRecord = {
              id: recordId,
              projectId: changeSet.projectId,
              kind: operation.kind,
              status: operation.status,
              title: operation.title,
              body: operation.body,
              sourceKind: operation.sourceKind,
              sourceRef: operation.sourceRef,
              revision: 1,
              createdAt: completedAt,
              updatedAt: completedAt,
            };
            plannedRecordIds.add(recordId);
            if (operation.localRef) {
              localRecords.set(operation.localRef, record);
            }
            plannedOperations.push({
              type: operation.type,
              operationId: operation.operationId,
              record,
            });
            break;
          }

          case "update_record": {
            if (updatedRecordTargets.has(operation.recordId)) {
              throw validationFailure(
                "update_record targets must be unique",
                { recordId: operation.recordId },
              );
            }
            updatedRecordTargets.add(operation.recordId);
            const currentRecord = existingRecord(operation.recordId);
            if (currentRecord.revision !== operation.expectedRecordRevision) {
              throw recordRevisionConflict(
                operation.recordId,
                operation.expectedRecordRevision,
                currentRecord.revision,
              );
            }
            const nextStatus = operation.patch.status ?? currentRecord.status;
            if (
              !isRecordStatusTransitionAllowed(currentRecord.status, nextStatus)
            ) {
              throw validationFailure(
                `Invalid record status transition: ${currentRecord.status} -> ${nextStatus}`,
                {
                  operationId: operation.operationId,
                  recordId: operation.recordId,
                  fromStatus: currentRecord.status,
                  toStatus: nextStatus,
                },
              );
            }
            const record: ProjectRecord = {
              ...currentRecord,
              title: operation.patch.title ?? currentRecord.title,
              body: operation.patch.body ?? currentRecord.body,
              status: nextStatus,
              revision: currentRecord.revision + 1,
              updatedAt: completedAt,
            };
            existingRecords.set(record.id, record);
            plannedOperations.push({
              type: operation.type,
              operationId: operation.operationId,
              expectedRecordRevision: currentRecord.revision,
              record,
            });
            break;
          }

          case "create_relationship": {
            const fromRecord = resolveReference(
              operation.from,
              operation.operationId,
            );
            const toRecord = resolveReference(
              operation.to,
              operation.operationId,
            );
            if (fromRecord.id === toRecord.id) {
              throw validationFailure("Relationships must link different records", {
                operationId: operation.operationId,
                recordId: fromRecord.id,
              });
            }
            const identity = relationshipIdentity(
              fromRecord.id,
              toRecord.id,
              operation.kind,
            );
            const storedDuplicate = selectRelationshipByIdentity.get({
              fromRecordId: fromRecord.id,
              toRecordId: toRecord.id,
              kind: operation.kind,
            }) as RecordRelationshipRow | undefined;
            const activeStoredDuplicate =
              storedDuplicate &&
              !removedRelationshipIds.has(storedDuplicate.id);
            if (
              activeStoredDuplicate ||
              activePlannedRelationships.has(identity)
            ) {
              throw new RelationshipAlreadyExistsError(
                fromRecord.id,
                toRecord.id,
                operation.kind,
              );
            }
            const relationshipId = dependencies.newId("relationship");
            if (
              plannedRelationshipIds.has(relationshipId) ||
              selectRelationshipId.get(relationshipId) !== undefined
            ) {
              throw validationFailure(
                `Generated relationship ID already exists: ${relationshipId}`,
                {
                  operationId: operation.operationId,
                  relationshipId,
                },
              );
            }
            const relationship: RecordRelationship = {
              id: relationshipId,
              projectId: changeSet.projectId,
              fromRecordId: fromRecord.id,
              toRecordId: toRecord.id,
              kind: operation.kind,
              createdAt: completedAt,
            };
            plannedRelationshipIds.add(relationshipId);
            activePlannedRelationships.set(identity, relationship);
            plannedOperations.push({
              type: operation.type,
              operationId: operation.operationId,
              relationship,
            });
            break;
          }

          case "remove_relationship": {
            let relationship: RecordRelationship | undefined;
            for (const planned of activePlannedRelationships.values()) {
              if (planned.id === operation.relationshipId) {
                relationship = planned;
                break;
              }
            }
            if (!relationship) {
              const row = selectRelationshipById.get(
                operation.relationshipId,
              ) as RecordRelationshipRow | undefined;
              if (row) relationship = mapRecordRelationshipRow(row);
            }
            if (
              !relationship ||
              relationship.projectId !== changeSet.projectId ||
              removedRelationshipIds.has(relationship.id)
            ) {
              throw validationFailure(
                `Relationship does not belong to project ${changeSet.projectId}: ${operation.relationshipId}`,
                {
                  projectId: changeSet.projectId,
                  relationshipId: operation.relationshipId,
                },
              );
            }
            removedRelationshipIds.add(relationship.id);
            activePlannedRelationships.delete(
              relationshipIdentity(
                relationship.fromRecordId,
                relationship.toRecordId,
                relationship.kind,
              ),
            );
            plannedOperations.push({
              type: operation.type,
              operationId: operation.operationId,
              relationship,
            });
            break;
          }
        }
      }

      const finalRecords = new Map(
        (selectRecordsByProject.all(changeSet.projectId) as ProjectRecordRow[])
          .map(mapProjectRecordRow)
          .map((record) => [record.id, record] as const),
      );
      for (const planned of plannedOperations) {
        if (planned.type === "create_record" || planned.type === "update_record") {
          finalRecords.set(planned.record.id, planned.record);
        }
      }
      const finalRelationships = (
        selectRelationshipsByProject.all(changeSet.projectId) as RecordRelationshipRow[]
      )
        .map(mapRecordRelationshipRow)
        .filter((relationship) => !removedRelationshipIds.has(relationship.id));
      finalRelationships.push(...activePlannedRelationships.values());
      validateParentHierarchy(
        changeSet.projectId,
        [...finalRecords.values()],
        finalRelationships,
      );

      const appliedOperations: AppliedOperationResult[] = [];
      for (const planned of plannedOperations) {
        switch (planned.type) {
          case "create_record":
            insertRecord.run(planned.record);
            insertRecordRevision.run({
              recordId: planned.record.id,
              revision: planned.record.revision,
              snapshotJson: JSON.stringify(planned.record),
              createdAt: completedAt,
            });
            appliedOperations.push({
              operationId: planned.operationId,
              type: planned.type,
              record: planned.record,
            });
            break;

          case "update_record": {
            const updateResult = updateRecord.run({
              ...planned.record,
              expectedRecordRevision: planned.expectedRecordRevision,
            });
            if (updateResult.changes !== 1) {
              const row = selectRecordById.get(planned.record.id) as
                | ProjectRecordRow
                | undefined;
              throw recordRevisionConflict(
                planned.record.id,
                planned.expectedRecordRevision,
                row?.revision ?? -1,
              );
            }
            insertRecordRevision.run({
              recordId: planned.record.id,
              revision: planned.record.revision,
              snapshotJson: JSON.stringify(planned.record),
              createdAt: completedAt,
            });
            appliedOperations.push({
              operationId: planned.operationId,
              type: planned.type,
              record: planned.record,
            });
            break;
          }

          case "create_relationship":
            try {
              insertRelationship.run(planned.relationship);
            } catch (error) {
              if (isDuplicateRelationshipConstraint(error)) {
                throw new RelationshipAlreadyExistsError(
                  planned.relationship.fromRecordId,
                  planned.relationship.toRecordId,
                  planned.relationship.kind,
                );
              }
              throw error;
            }
            appliedOperations.push({
              operationId: planned.operationId,
              type: planned.type,
              relationship: planned.relationship,
            });
            break;

          case "remove_relationship": {
            const deleteResult = deleteRelationship.run(planned.relationship);
            if (deleteResult.changes !== 1) {
              throw validationFailure(
                `Relationship disappeared during change application: ${planned.relationship.id}`,
                { relationshipId: planned.relationship.id },
              );
            }
            appliedOperations.push({
              operationId: planned.operationId,
              type: planned.type,
              relationship: planned.relationship,
            });
            break;
          }
        }
      }

      const revisionAfter = expectedProjectRevision + 1;
      const projectUpdate = incrementProjectRevision.run({
        projectId: changeSet.projectId,
        expectedProjectRevision,
        updatedAt: completedAt,
      });
      if (projectUpdate.changes !== 1) {
        const row = selectProjectRevision.get(changeSet.projectId) as
          | ProjectRevisionRow
          | undefined;
        throw projectRevisionConflict(
          changeSet.projectId,
          expectedProjectRevision,
          row?.revision ?? -1,
        );
      }

      insertAudit.run({
        id: auditEventId,
        projectId: changeSet.projectId,
        actorType: actor.type,
        profileId: actor.type === "profile" ? actor.profileId : null,
        authorityMode,
        scopeDecision,
        targetId: changeSet.changeId,
        idempotencyKey: changeSet.idempotencyKey,
        revisionBefore: expectedProjectRevision,
        revisionAfter,
        reason: changeSet.rationale,
        createdAt: completedAt,
      });

    return {
      outcome: "applied",
      projectId: changeSet.projectId,
      revisionBefore: expectedProjectRevision,
      revisionAfter,
      operations: appliedOperations,
    };
  };
  const applyTransaction = database.transaction(
    applyPreparedChangeSetBody,
  );

  const idempotencyResult = (
    key: IdempotencyLookup,
  ): StoredIdempotencyResult | null => {
    const parsedKey = {
      profileId: nonEmptyString.parse(key.profileId),
      projectId: nonEmptyString.parse(key.projectId),
      idempotencyKey: nonEmptyString.max(128).parse(key.idempotencyKey),
    };
    const row = selectIdempotencyResult.get(parsedKey) as
      | IdempotencyStorageRow
      | undefined;
    return row ? mapIdempotencyStorageRow(row) : null;
  };

  const proposalOperations = (proposalId: string): ChangeOperation[] =>
    (selectProposalOperations.all(proposalId) as ProposalOperationStorageRow[])
      .map((row) => {
        let rawOperation: unknown;
        try {
          rawOperation = JSON.parse(row.payload_json);
        } catch {
          throw new GovernanceError(
            "internal_error",
            `Stored proposal operation is corrupt: ${proposalId}`,
          );
        }
        const parsed = changeOperationSchema.safeParse(rawOperation);
        if (!parsed.success) {
          throw new GovernanceError(
            "internal_error",
            `Stored proposal operation is corrupt: ${proposalId}`,
          );
        }
        const operation = parsed.data as ChangeOperation;
        const expectedRecordRevision =
          operation.type === "update_record"
            ? operation.expectedRecordRevision
            : null;
        if (
          row.operation_id !== operation.operationId ||
          row.operation_type !== operation.type ||
          row.expected_record_revision !== expectedRecordRevision
        ) {
          throw new GovernanceError(
            "internal_error",
            `Stored proposal operation metadata is corrupt: ${proposalId}`,
          );
        }
        return operation;
      });

  const proposalDetail = (
    proposalId: string,
  ): ChangeProposalDetail | null => {
    const parsedProposalId = nonEmptyString.parse(proposalId);
    const row = selectProposalById.get(parsedProposalId) as
      | ChangeProposalRow
      | undefined;
    if (!row) return null;
    return {
      ...mapProposalRow(row),
      operations: proposalOperations(row.id),
    };
  };

  const projectRevisionOrThrow = (projectId: string): ProjectRevisionRow => {
    const row = selectProjectRevision.get(projectId) as
      | ProjectRevisionRow
      | undefined;
    if (!row) throw new ProjectNotFoundError(projectId);
    return row;
  };

  const validatePrincipalSecurity = (
    profileId: string,
    credentialGeneration: string,
  ): void => {
    const row = selectProfileSecurity.get(profileId) as
      | ProfileSecurityRow
      | undefined;
    if (!row || row.token_rotated_at !== credentialGeneration) {
      throw new GovernanceError(
        "invalid_profile_credentials",
        "invalid_profile_credentials",
      );
    }
    if (row.status === "disabled") {
      throw new GovernanceError("profile_disabled", "profile_disabled");
    }
  };

  const proposalNotPending = (
    proposalId: string,
    state: ProposalState,
  ): GovernanceError =>
    new GovernanceError(
      "proposal_not_pending",
      "Only pending proposals can be reviewed",
      { proposalId, state },
    );

  const pendingProposalContext = (
    rawProposalId: string,
  ): {
    proposal: ChangeProposalDetail;
    stored: StoredIdempotencyResult | null;
  } => {
    const proposalId = nonEmptyString.parse(rawProposalId);
    const proposal = proposalDetail(proposalId);
    if (!proposal) {
      throw validationFailure("Proposal not found", { proposalId });
    }
    if (proposal.state !== "pending") {
      throw proposalNotPending(proposal.id, proposal.state);
    }
    let stored: StoredIdempotencyResult | null = null;
    if (proposal.origin.type === "profile") {
      stored = idempotencyResult({
        profileId: proposal.origin.profileId,
        projectId: proposal.projectId,
        idempotencyKey: proposal.idempotencyKey!,
      });
      if (
        !stored ||
        stored.requestHash !== proposal.requestHash ||
        stored.result.outcome !== "proposed" ||
        stored.result.proposalId !== proposal.id ||
        stored.result.state !== "pending"
      ) {
        throw new GovernanceError(
          "internal_error",
          "Stored proposal idempotency result is inconsistent",
        );
      }
    }
    return { proposal, stored };
  };

  const updateOriginalIdempotencyResult = (
    proposal: ChangeProposal,
    stored: StoredIdempotencyResult,
    result: StoredSubmissionResult,
  ): void => {
    if (proposal.origin.type !== "profile" || proposal.idempotencyKey === null) {
      throw new GovernanceError(
        "internal_error",
        "Repository refresh proposals do not have idempotency results",
      );
    }
    const updated = updateIdempotencyResult.run({
      profileId: proposal.origin.profileId,
      projectId: proposal.projectId,
      idempotencyKey: proposal.idempotencyKey,
      changeId: stored.changeId,
      outcome: result.outcome,
      resultJson: JSON.stringify(result),
    });
    if (updated.changes !== 1) {
      throw new GovernanceError(
        "internal_error",
        "Stored proposal idempotency result disappeared during review",
      );
    }
  };

  const appendProposalReviewAudit = (input: {
    proposal: ChangeProposal;
    actionCategory: string;
    outcome: string;
    reason: string | null;
    revisionBefore: number;
    revisionAfter: number;
    reviewedAt: string;
  }): void => {
    insertProposalReviewAudit.run({
      id: dependencies.newId("audit"),
      projectId: input.proposal.projectId,
      actionCategory: input.actionCategory,
      targetId: input.proposal.id,
      idempotencyKey: input.proposal.idempotencyKey,
      revisionBefore: input.revisionBefore,
      revisionAfter: input.revisionAfter,
      outcome: input.outcome,
      reason: input.reason,
      createdAt: input.reviewedAt,
    });
  };

  const decideProposal = (
    proposal: ChangeProposal,
    state: Exclude<ProposalState, "pending">,
    reviewReason: string | null,
    reviewedAt: string,
  ): void => {
    const updated = decidePendingProposal.run({
      proposalId: proposal.id,
      state,
      reviewReason,
      reviewedAt,
    });
    if (updated.changes !== 1) {
      const current = proposalDetail(proposal.id);
      if (!current) {
        throw validationFailure("Proposal not found", {
          proposalId: proposal.id,
        });
      }
      throw proposalNotPending(current.id, current.state);
    }
  };

  const proposalConflictReason =
    "Proposal revisions changed before human acceptance";

  const appendCoordinationReconciliation = (
    proposalId: string,
    projectRevision: number,
    createdAt: string,
  ): void => {
    const row = selectCoordinationReconciliation.get(proposalId) as {
      submission_id: string;
      profile_id: string;
      project_id: string;
      task_id: string;
      checkpoint_id: string;
      claim_id: string;
      delegation_id: string | null;
      task_revision: number;
    } | undefined;
    if (!row) return;
    insertCoordinationReconciliation.run({
      id: `coordination-event-${createHash("sha256").update(proposalId).digest("hex")}`,
      projectId: row.project_id,
      taskId: row.task_id,
      profileId: row.profile_id,
      claimId: row.claim_id,
      delegationId: row.delegation_id,
      checkpointId: row.checkpoint_id,
      submissionId: row.submission_id,
      proposalId,
      projectRevision,
      taskRevision: row.task_revision,
      createdAt,
    });
  };

  const createRepositoryRefreshProposalTransaction = database.transaction(
    (
      command: CreateRepositoryRefreshProposalCommand,
      input: CreateRepositoryRefreshProposalInput,
    ): ChangeProposalDetail => {
      const createdAt = nonEmptyString.parse(command.createdAt);
      const project = projectRevisionOrThrow(input.projectId);
      const snapshot = selectRepositorySnapshotForProposal.get(
        input.repositorySnapshotId,
      ) as {
        id: string;
        project_id: string;
        state: "candidate" | "accepted" | "discarded";
      } | undefined;
      if (
        !snapshot ||
        snapshot.project_id !== input.projectId ||
        snapshot.state !== "candidate"
      ) {
        throw validationFailure(
          "repositorySnapshotId must identify a candidate snapshot in the target project",
          {
            projectId: input.projectId,
            repositorySnapshotId: input.repositorySnapshotId,
          },
        );
      }

      const proposalId = dependencies.newId("proposal");
      const state = input.baseProjectRevision === project.revision
        ? "pending"
        : "conflicted";
      insertProposal.run({
        id: proposalId,
        projectId: input.projectId,
        profileId: null,
        sourceTaskId: null,
        predecessorProposalId: null,
        baseProjectRevision: input.baseProjectRevision,
        state,
        rationale: input.rationale,
        idempotencyKey: null,
        requestHash: null,
        createdAt,
        updatedAt: createdAt,
        originType: "repository_refresh",
        repositorySnapshotId: input.repositorySnapshotId,
      });
      input.operations.forEach((operation, position) => {
        insertProposalOperation.run({
          proposalId,
          position,
          operationId: operation.operationId,
          operationType: operation.type,
          expectedRecordRevision: operation.type === "update_record"
            ? operation.expectedRecordRevision
            : null,
          payloadJson: JSON.stringify(operation),
        });
      });
      const proposal = proposalDetail(proposalId)!;
      appendProposalReviewAudit({
        proposal,
        actionCategory: "proposal_created",
        outcome: state === "pending" ? "proposed" : "conflicted",
        reason: input.rationale,
        revisionBefore: project.revision,
        revisionAfter: project.revision,
        reviewedAt: createdAt,
      });
      return proposal;
    },
  );
  const acceptProposalTransaction = database.transaction(
    (command: AcceptProposalCommand): ProposalDecisionResult => {
      const reviewedAt = nonEmptyString.parse(command.reviewedAt);
      const reason = z.union([nonEmptyString, z.null()]).parse(command.reason);
      const { proposal, stored } = pendingProposalContext(command.proposalId);
      const project = projectRevisionOrThrow(proposal.projectId);
      const changeId = stored?.changeId ?? proposal.id;

      const commitConflict = (): ProposalDecisionResult => {
        decideProposal(
          proposal,
          "conflicted",
          proposalConflictReason,
          reviewedAt,
        );
        const conflict: ProposalSubmissionResult = {
          outcome: "conflicted",
          changeId,
          proposalId: proposal.id,
          state: "conflicted",
          currentProjectRevision: projectRevisionOrThrow(proposal.projectId)
            .revision,
          replayed: false,
        };
        proposalSubmissionResultSchema.parse(conflict);
        if (stored) updateOriginalIdempotencyResult(proposal, stored, conflict);
        appendProposalReviewAudit({
          proposal,
          actionCategory: "proposal_conflicted",
          outcome: conflict.outcome,
          reason: proposalConflictReason,
          revisionBefore: conflict.currentProjectRevision,
          revisionAfter: conflict.currentProjectRevision,
          reviewedAt,
        });
        return {
          outcome: conflict.outcome,
          changeId: conflict.changeId,
          proposalId: conflict.proposalId,
          currentProjectRevision: conflict.currentProjectRevision,
        };
      };

      if (project.revision !== proposal.baseProjectRevision) {
        return commitConflict();
      }

      const preparedOperations: PreparedChangeOperation[] =
        proposal.operations.map((operation) =>
          operation.type === "create_record"
            ? {
                ...operation,
                sourceKind: proposal.origin.type === "profile"
                  ? "agent"
                  : "repository",
                sourceRef: proposal.origin.type === "profile"
                  ? proposal.origin.profileId
                  : proposal.origin.repositorySnapshotId,
              }
            : operation,
        );
      let applied: AppliedChangeSetResult;
      try {
        applied = applyPreparedChangeSetBody({
          actor: { type: "local_human" },
          authorityMode: "human",
          scopeDecision: "human_review",
          changeSet: {
            changeId,
            projectId: proposal.projectId,
            idempotencyKey: proposal.idempotencyKey,
            rationale: proposal.rationale,
            sourceTaskId: proposal.sourceTaskId,
            operations: preparedOperations,
          },
          expectedProjectRevision: proposal.baseProjectRevision,
          auditEventId: dependencies.newId("audit"),
          completedAt: reviewedAt,
        });
      } catch (error) {
        if (
          error instanceof GovernanceError &&
          (error.code === "project_revision_conflict" ||
            error.code === "record_revision_conflict")
        ) {
          return commitConflict();
        }
        throw error;
      }

      decideProposal(proposal, "accepted", reason, reviewedAt);
      appendCoordinationReconciliation(
        proposal.id,
        applied.revisionAfter,
        reviewedAt,
      );
      const storedResult: AppliedProposalResult = {
        outcome: "applied",
        changeId,
        proposalId: proposal.id,
        projectRevision: applied.revisionAfter,
        operations: applied.operations,
        replayed: false,
      };
      appliedProposalResultSchema.parse(storedResult);
      if (stored) updateOriginalIdempotencyResult(proposal, stored, storedResult);
      appendProposalReviewAudit({
        proposal,
        actionCategory: "proposal_accepted",
        outcome: "applied",
        reason,
        revisionBefore: applied.revisionBefore,
        revisionAfter: applied.revisionAfter,
        reviewedAt,
      });
      return {
        outcome: "applied",
        changeId,
        proposalId: proposal.id,
        projectRevision: applied.revisionAfter,
        operations: applied.operations,
      };
    },
  );

  const rejectProposalTransaction = database.transaction(
    (command: RejectProposalCommand): ChangeProposalDetail => {
      const reason = nonEmptyString.parse(command.reason);
      const reviewedAt = nonEmptyString.parse(command.reviewedAt);
      const { proposal, stored } = pendingProposalContext(command.proposalId);
      const project = projectRevisionOrThrow(proposal.projectId);
      decideProposal(proposal, "rejected", reason, reviewedAt);
      const result: StoredProposalRejectionResult = {
        outcome: "rejected",
        changeId: stored?.changeId ?? proposal.id,
        code: "operation_denied",
        reason,
        replayed: false,
      };
      storedProposalRejectionResultSchema.parse(result);
      if (stored) updateOriginalIdempotencyResult(proposal, stored, result);
      appendProposalReviewAudit({
        proposal,
        actionCategory: "proposal_rejected",
        outcome: result.outcome,
        reason,
        revisionBefore: project.revision,
        revisionAfter: project.revision,
        reviewedAt,
      });
      return proposalDetail(proposal.id)!;
    },
  );

  const withdrawProposalTransaction = database.transaction(
    (command: WithdrawProposalCommand): ChangeProposalDetail => {
      const reason = nonEmptyString.parse(command.reason);
      const reviewedAt = nonEmptyString.parse(command.reviewedAt);
      const { proposal } = pendingProposalContext(command.proposalId);
      const project = projectRevisionOrThrow(proposal.projectId);
      decideProposal(proposal, "withdrawn", reason, reviewedAt);
      appendProposalReviewAudit({
        proposal,
        actionCategory: "proposal_withdrawn",
        outcome: "withdrawn",
        reason,
        revisionBefore: project.revision,
        revisionAfter: project.revision,
        reviewedAt,
      });
      return proposalDetail(proposal.id)!;
    },
  );

  const applyHumanChangeTransaction = database.transaction(
    (command: ApplyHumanChangeCommand): AppliedChangeSetResult => {
      const projectId = nonEmptyString.parse(command.projectId);
      const rationale = nonEmptyString.parse(command.rationale);
      const completedAt = nonEmptyString.parse(command.completedAt);
      const idempotency = command.idempotency === undefined
        ? undefined
        : ideaCaptureIdempotencySchema.parse(command.idempotency);
      if (idempotency) {
        const matchingRows = (selectHumanChangeIdempotencyMetadata.all({
          projectId,
        }) as {
          operation_scope: string;
          idempotency_key: string;
        }[]).filter((row) =>
          row.operation_scope.trim() === idempotency.operationScope &&
          row.idempotency_key.trim() === idempotency.key
        );
        if (matchingRows.length > 1) {
          throw new GovernanceError(
            "internal_error",
            "Stored human change idempotency metadata is ambiguous",
          );
        }
        const matchingMetadata = matchingRows[0];
        if (matchingMetadata) {
          try {
            const existing = selectHumanChangeIdempotencyResult.get({
              projectId,
              operationScope: matchingMetadata.operation_scope,
              key: matchingMetadata.idempotency_key,
            }) as {
              project_id: string;
              operation_scope: string;
              idempotency_key: string;
              request_hash: string;
              result_json: string;
            } | undefined;
            if (existing === undefined) {
              throw new Error("Stored human change idempotency result is missing");
            }
            const stored = parseStoredHumanChangeReplay({
              projectId: existing.project_id,
              operationScope: existing.operation_scope,
              idempotencyKey: existing.idempotency_key,
              requestHash: existing.request_hash,
              resultJson: existing.result_json,
            }).result;
            if (existing.request_hash !== idempotency.requestHash) {
              throw new GovernanceError(
                "idempotency_conflict",
                "Idempotency key conflicts with a different request.",
              );
            }
            return stored;
          } catch (error) {
            if (error instanceof GovernanceError) throw error;
            throw new GovernanceError(
              "internal_error",
              "Stored human change idempotency result is corrupt",
            );
          }
        }
      }
      const project = projectRevisionOrThrow(projectId);
      const expectedProjectRevision = command.expectedProjectRevision === undefined
        ? project.revision
        : z.number().int().nonnegative().parse(command.expectedProjectRevision);
      const changeId = dependencies.newId("change");
      const auditEventId = dependencies.newId("audit");

      const appliedBase = applyPreparedChangeSetBody({
        actor: { type: "local_human" },
        authorityMode: "human",
        scopeDecision: "human_admin",
        changeSet: {
          changeId,
          projectId,
          idempotencyKey: null,
          rationale,
          sourceTaskId: null,
          operations: command.operations,
        },
        expectedProjectRevision,
        auditEventId,
        completedAt,
      });
      const replayPayloadJson = idempotency?.replayPayloadJson;
      const applied: AppliedChangeSetResult = replayPayloadJson === undefined
        ? appliedBase
        : { ...appliedBase, replayPayloadJson };
      if (idempotency) {
        const resultJson = JSON.stringify(applied);
        try {
          parseStoredHumanChangeReplay({
            projectId,
            operationScope: idempotency.operationScope,
            idempotencyKey: idempotency.key,
            requestHash: idempotency.requestHash,
            resultJson,
          });
        } catch {
          throw new GovernanceError(
            "internal_error",
            "Generated human change idempotency result is invalid",
          );
        }
        insertHumanChangeIdempotencyResult.run({
          projectId,
          operationScope: idempotency.operationScope,
          key: idempotency.key,
          requestHash: idempotency.requestHash,
          resultJson,
          createdAt: completedAt,
        });
      }
      return applied;
    },
  );

  const recordSubmissionRejectionTransaction = database.transaction(
    (
      command: RecordSubmissionRejectionCommand,
      input: SubmitChangeSetInput,
    ): SubmissionResult => {
      const profileId = nonEmptyString.parse(command.profileId);
      const credentialGeneration = nonEmptyString.parse(
        command.credentialGeneration,
      );
      const rejectedAt = nonEmptyString.parse(command.rejectedAt);
      validatePrincipalSecurity(profileId, credentialGeneration);
      const requestHash = normalizedRequestHash(input);
      const earlyContext: SubmissionAuditContext = {
        profileId,
        authorityMode: null,
        scopeDecision: "authority_missing",
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        createdAt: rejectedAt,
        revision: null,
      };
      const existing = idempotencyResult({
        profileId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      });
      const handled = existingSubmissionResult(
        existing,
        requestHash,
        earlyContext,
      );
      if (handled) return handled;

      const project = projectRevisionOrThrow(input.projectId);
      const changeId = dependencies.newId("change");
      const result: SubmissionRejectionResult = {
        outcome: "rejected",
        changeId,
        code: "project_authority_missing",
        reason: "project_authority_missing",
        replayed: false,
      };
      submissionRejectionResultSchema.parse(result);
      const auditContext: SubmissionAuditContext = {
        ...earlyContext,
        revision: project.revision,
      };
      persistIdempotencyResult(auditContext, requestHash, result);
      appendSubmissionAudit(auditContext, {
        actionCategory: "submission_rejected",
        targetId: changeId,
        outcome: result.outcome,
        reason: result.reason,
      });
      return result;
    },
  );

  const validateSubmissionProvenance = (
    profileId: string,
    input: SubmitChangeSetInput,
  ): void => {
    if (input.sourceTaskId !== null) {
      const taskRow = selectRecordById.get(input.sourceTaskId) as
        | ProjectRecordRow
        | undefined;
      if (
        !taskRow ||
        taskRow.project_id !== input.projectId ||
        taskRow.kind !== "task"
      ) {
        throw validationFailure(
          "sourceTaskId must identify a task in the target project",
          {
            projectId: input.projectId,
            sourceTaskId: input.sourceTaskId,
          },
        );
      }
    }
    if (input.predecessorProposalId !== null) {
      const predecessor = selectProposalById.get(
        input.predecessorProposalId,
      ) as ChangeProposalRow | undefined;
      if (
        !predecessor ||
        predecessor.profile_id !== profileId ||
        predecessor.project_id !== input.projectId ||
        predecessor.state !== "conflicted"
      ) {
        throw validationFailure(
          "predecessorProposalId must identify a conflicted proposal from the same profile and project",
          {
            projectId: input.projectId,
            predecessorProposalId: input.predecessorProposalId,
          },
        );
      }
    }
  };

  type SubmissionAuditContext = {
    profileId: string;
    authorityMode: AuthorityMode | null;
    scopeDecision: string;
    projectId: string;
    idempotencyKey: string;
    createdAt: string;
    revision: number | null;
  };

  const appendSubmissionAudit = (
    context: SubmissionAuditContext,
    values: {
      actionCategory: string;
      targetId: string;
      outcome: string;
      reason: string | null;
      revisionAfter?: number;
      auditId?: string;
    },
  ): void => {
    insertGovernanceAudit.run({
      id: values.auditId ?? dependencies.newId("audit"),
      projectId: context.projectId,
      profileId: context.profileId,
      authorityMode: context.authorityMode,
      scopeDecision: context.scopeDecision,
      actionCategory: values.actionCategory,
      targetId: values.targetId,
      idempotencyKey: context.idempotencyKey,
      revisionBefore: context.revision,
      revisionAfter: values.revisionAfter ?? context.revision,
      outcome: values.outcome,
      reason: values.reason,
      createdAt: context.createdAt,
    });
  };

  const existingSubmissionResult = (
    existing: StoredIdempotencyResult | null,
    requestHash: string,
    auditContext: SubmissionAuditContext,
  ): SubmissionResult | null => {
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      const conflict: IdempotencyConflictResult = {
        outcome: "rejected",
        changeId: existing.changeId,
        code: "idempotency_conflict",
        reason: idempotencyConflictReason,
        replayed: false,
      };
      idempotencyConflictResultSchema.parse(conflict);
      appendSubmissionAudit(auditContext, {
        actionCategory: "idempotency_conflict",
        targetId: existing.changeId,
        outcome: conflict.outcome,
        reason: conflict.reason,
      });
      return conflict;
    }

    appendSubmissionAudit(auditContext, {
      actionCategory: "idempotent_replay",
      targetId: existing.changeId,
      outcome: existing.outcome,
      reason: null,
    });
    return {
      ...existing.result,
      replayed: true,
    } as SubmissionResult;
  };

  const persistIdempotencyResult = (
    context: SubmissionAuditContext,
    requestHash: string,
    result: StoredSubmissionResult,
  ): void => {
    insertIdempotencyResult.run({
      profileId: context.profileId,
      projectId: context.projectId,
      idempotencyKey: context.idempotencyKey,
      changeId: result.changeId,
      requestHash,
      outcome: result.outcome,
      resultJson: JSON.stringify(result),
      createdAt: context.createdAt,
    });
  };

  const resolveSubmissionIdempotencyTransaction = database.transaction(
    (
      command: ResolveSubmissionIdempotencyCommand,
      input: SubmitChangeSetInput,
    ): SubmissionResult | null => {
      const profileId = nonEmptyString.parse(command.profileId);
      const credentialGeneration = nonEmptyString.parse(
        command.credentialGeneration,
      );
      const resolvedAt = nonEmptyString.parse(command.resolvedAt);
      validatePrincipalSecurity(profileId, credentialGeneration);
      const requestHash = normalizedRequestHash(input, command.forceConflict === true);
      const existing = idempotencyResult({
        profileId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      });
      return existingSubmissionResult(existing, requestHash, {
        profileId,
        authorityMode: null,
        scopeDecision: "idempotency",
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        createdAt: resolvedAt,
        revision: null,
      });
    },
  );

  const createProposalTransaction = database.transaction(
    (
      command: CreateProposalCommand,
      input: SubmitChangeSetInput,
    ): SubmissionResult => {
      const profileId = nonEmptyString.parse(command.profileId);
      const credentialGeneration = nonEmptyString.parse(
        command.credentialGeneration,
      );
      const scopeDecision = nonEmptyString.parse(command.scopeDecision);
      const submittedAt = nonEmptyString.parse(command.submittedAt);
      validatePrincipalSecurity(profileId, credentialGeneration);
      const requestHash = normalizedRequestHash(input, command.forceConflict === true);
      const earlyContext: SubmissionAuditContext = {
        profileId,
        authorityMode: command.authorityMode,
        scopeDecision,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        createdAt: submittedAt,
        revision: null,
      };
      const existing = idempotencyResult({
        profileId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      });
      const handled = existingSubmissionResult(
        existing,
        requestHash,
        earlyContext,
      );
      if (handled) return handled;

      const project = projectRevisionOrThrow(input.projectId);
      validateSubmissionProvenance(profileId, input);
      const auditContext: SubmissionAuditContext = {
        ...earlyContext,
        revision: project.revision,
      };
      const changeId = dependencies.newId("change");
      const proposalId = dependencies.newId("proposal");
      const auditId = dependencies.newId("audit");
      const stale = command.forceConflict === true ||
        input.baseProjectRevision !== project.revision;
      const state = stale ? "conflicted" : "pending";
      insertProposal.run({
        id: proposalId,
        projectId: input.projectId,
        profileId,
        sourceTaskId: input.sourceTaskId,
        predecessorProposalId: input.predecessorProposalId,
        baseProjectRevision: input.baseProjectRevision,
        state,
        rationale: input.rationale,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: submittedAt,
        updatedAt: submittedAt,
        originType: "profile",
        repositorySnapshotId: null,
      });
      input.operations.forEach((operation, position) => {
        insertProposalOperation.run({
          proposalId,
          position,
          operationId: operation.operationId,
          operationType: operation.type,
          expectedRecordRevision:
            operation.type === "update_record"
              ? operation.expectedRecordRevision
              : null,
          payloadJson: JSON.stringify(operation),
        });
      });

      const result: ProposalSubmissionResult = stale
        ? {
            outcome: "conflicted",
            changeId,
            proposalId,
            state: "conflicted",
            currentProjectRevision: project.revision,
            replayed: false,
          }
        : {
            outcome: "proposed",
            changeId,
            proposalId,
            state: "pending",
            replayed: false,
          };
      proposalSubmissionResultSchema.parse(result);
      persistIdempotencyResult(auditContext, requestHash, result);
      appendSubmissionAudit(auditContext, {
        actionCategory: "proposal_created",
        targetId: changeId,
        outcome: result.outcome,
        reason: input.rationale,
        auditId,
      });
      return result;
    },
  );

  const directConflictFromError = (
    error: GovernanceError,
    changeId: string,
    currentProjectRevision: number,
  ): DirectConflictResult | null => {
    if (error.code === "project_revision_conflict") {
      return {
        outcome: "conflicted",
        changeId,
        code: error.code,
        currentProjectRevision,
        ...(typeof error.details.expectedRevision === "number"
          ? { expectedProjectRevision: error.details.expectedRevision }
          : {}),
        replayed: false,
      };
    }
    if (error.code === "record_revision_conflict") {
      return {
        outcome: "conflicted",
        changeId,
        code: error.code,
        currentProjectRevision,
        ...(typeof error.details.recordId === "string"
          ? { recordId: error.details.recordId }
          : {}),
        ...(typeof error.details.expectedRevision === "number"
          ? { expectedRecordRevision: error.details.expectedRevision }
          : {}),
        ...(typeof error.details.actualRevision === "number" &&
        error.details.actualRevision >= 0
          ? { actualRecordRevision: error.details.actualRevision }
          : {}),
        replayed: false,
      };
    }
    return null;
  };

  const applyDirectTransaction = database.transaction(
    (
      command: ApplyDirectCommand,
      input: SubmitChangeSetInput,
    ): SubmissionResult => {
      const profileId = nonEmptyString.parse(command.profileId);
      const credentialGeneration = nonEmptyString.parse(
        command.credentialGeneration,
      );
      const scopeDecision = nonEmptyString.parse(command.scopeDecision);
      const completedAt = nonEmptyString.parse(command.completedAt);
      validatePrincipalSecurity(profileId, credentialGeneration);
      const requestHash = normalizedRequestHash(input);
      const earlyContext: SubmissionAuditContext = {
        profileId,
        authorityMode: command.authorityMode,
        scopeDecision,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        createdAt: completedAt,
        revision: null,
      };
      const existing = idempotencyResult({
        profileId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      });
      const handled = existingSubmissionResult(
        existing,
        requestHash,
        earlyContext,
      );
      if (handled) return handled;

      const project = projectRevisionOrThrow(input.projectId);
      validateSubmissionProvenance(profileId, input);
      const auditContext: SubmissionAuditContext = {
        ...earlyContext,
        revision: project.revision,
      };
      const changeId = dependencies.newId("change");
      const auditId = dependencies.newId("audit");
      if (input.baseProjectRevision !== project.revision) {
        const conflict: DirectConflictResult = {
          outcome: "conflicted",
          changeId,
          code: "project_revision_conflict",
          currentProjectRevision: project.revision,
          expectedProjectRevision: input.baseProjectRevision,
          replayed: false,
        };
        directConflictResultSchema.parse(conflict);
        persistIdempotencyResult(auditContext, requestHash, conflict);
        appendSubmissionAudit(auditContext, {
          actionCategory: "change_conflicted",
          targetId: changeId,
          outcome: conflict.outcome,
          reason: "Project revision changed before direct application",
          auditId,
        });
        return conflict;
      }

      const preparedOperations: PreparedChangeOperation[] =
        input.operations.map((operation) =>
          operation.type === "create_record"
            ? {
                ...operation,
                sourceKind: "agent",
                sourceRef: profileId,
              }
            : operation,
        );
      let applied: AppliedChangeSetResult;
      try {
        applied = applyPreparedChangeSetBody({
          actor: { type: "profile", profileId },
          authorityMode: command.authorityMode,
          scopeDecision,
          changeSet: {
            changeId,
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
            rationale: input.rationale,
            sourceTaskId: input.sourceTaskId,
            operations: preparedOperations,
          },
          expectedProjectRevision: input.baseProjectRevision,
          auditEventId: auditId,
          completedAt,
        });
      } catch (error) {
        if (!(error instanceof GovernanceError)) throw error;
        const conflict = directConflictFromError(
          error,
          changeId,
          project.revision,
        );
        if (!conflict) throw error;
        directConflictResultSchema.parse(conflict);
        persistIdempotencyResult(auditContext, requestHash, conflict);
        appendSubmissionAudit(auditContext, {
          actionCategory: "change_conflicted",
          targetId: changeId,
          outcome: conflict.outcome,
          reason:
            conflict.code === "record_revision_conflict"
              ? "Record revision changed before direct application"
              : "Project revision changed before direct application",
          auditId,
        });
        return conflict;
      }

      const result: AppliedDirectResult = {
        ...applied,
        changeId,
        replayed: false,
      };
      appliedDirectResultSchema.parse(result);
      persistIdempotencyResult(auditContext, requestHash, result);
      return result;
    },
  );

  const inspectOperations = (
    projectId: string,
    operations: ChangeOperation[],
  ): ChangeSetFacts => {
    const parsedProjectId = nonEmptyString.parse(projectId);
    const project = projectRevisionOrThrow(parsedProjectId);
    const operationIds = new Set<string>();
    const localKinds = new Map<string, ProjectRecord["kind"]>();
    const recordKind = (recordId: string): ProjectRecord["kind"] => {
      const row = selectRecordById.get(recordId) as
        | ProjectRecordRow
        | undefined;
      if (!row || row.project_id !== parsedProjectId) {
        throw validationFailure(
          `Record does not belong to project ${parsedProjectId}: ${recordId}`,
          { projectId: parsedProjectId, recordId },
        );
      }
      return row.kind;
    };
    const referenceKind = (
      reference: RecordReference,
      operationId: string,
    ): ProjectRecord["kind"] => {
      if ("recordId" in reference) return recordKind(reference.recordId);
      const kind = localKinds.get(reference.localRef);
      if (!kind) {
        throw validationFailure(
          `Unknown or forward local reference: ${reference.localRef}`,
          { operationId, localRef: reference.localRef },
        );
      }
      return kind;
    };

    const facts: OperationFacts[] = [];
    for (const rawOperation of operations) {
      const parsed = changeOperationSchema.safeParse(rawOperation);
      if (!parsed.success) {
        throw validationFailure("Invalid change operation", {
          issues: parsed.error.issues,
        });
      }
      const operation = parsed.data as ChangeOperation;
      if (operationIds.has(operation.operationId)) {
        throw validationFailure("operationId values must be unique", {
          operationId: operation.operationId,
        });
      }
      operationIds.add(operation.operationId);
      switch (operation.type) {
        case "create_record":
          if (
            operation.localRef &&
            localKinds.has(operation.localRef)
          ) {
            throw validationFailure("localRef values must be unique", {
              localRef: operation.localRef,
            });
          }
          if (operation.localRef) {
            localKinds.set(operation.localRef, operation.kind);
          }
          facts.push({
            operationId: operation.operationId,
            operationType: operation.type,
            recordKind: operation.kind,
            fromRecordKind: null,
            toRecordKind: null,
            relationshipKind: null,
          });
          break;
        case "update_record":
          facts.push({
            operationId: operation.operationId,
            operationType: operation.type,
            recordKind: recordKind(operation.recordId),
            fromRecordKind: null,
            toRecordKind: null,
            relationshipKind: null,
          });
          break;
        case "create_relationship":
          facts.push({
            operationId: operation.operationId,
            operationType: operation.type,
            recordKind: null,
            fromRecordKind: referenceKind(
              operation.from,
              operation.operationId,
            ),
            toRecordKind: referenceKind(
              operation.to,
              operation.operationId,
            ),
            relationshipKind: operation.kind,
          });
          break;
        case "remove_relationship": {
          const relationshipRow = selectRelationshipById.get(
            operation.relationshipId,
          ) as RecordRelationshipRow | undefined;
          if (
            !relationshipRow ||
            relationshipRow.project_id !== parsedProjectId
          ) {
            throw validationFailure(
              `Relationship does not belong to project ${parsedProjectId}: ${operation.relationshipId}`,
              {
                projectId: parsedProjectId,
                relationshipId: operation.relationshipId,
              },
            );
          }
          facts.push({
            operationId: operation.operationId,
            operationType: operation.type,
            recordKind: null,
            fromRecordKind: recordKind(relationshipRow.from_record_id),
            toRecordKind: recordKind(relationshipRow.to_record_id),
            relationshipKind: relationshipRow.kind,
          });
          break;
        }
      }
    }
    return { projectRevision: project.revision, operations: facts };
  };

  type ValidatedProfileChange = {
    stored: StoredIdempotencyResult;
    summary: ProfileChangeSummary;
    proposal: ChangeProposal | null;
  };

  const validatedProfileChange = (
    row: ProfileChangeStorageRow,
  ): ValidatedProfileChange => {
    const stored = mapIdempotencyStorageRow(row);
    let proposal: ChangeProposal | null = null;
    if (row.proposal_id !== null) {
      const proposalRow = selectProposalById.get(row.proposal_id) as
        | ChangeProposalRow
        | undefined;
      if (!proposalRow) {
        throw new GovernanceError(
          "internal_error",
          "Stored profile change proposal metadata is corrupt",
        );
      }
      proposal = mapProposalRow(proposalRow);
      if (
        proposal.origin.type !== "profile" ||
        proposal.origin.profileId !== stored.profileId ||
        proposal.projectId !== stored.projectId ||
        proposal.idempotencyKey !== stored.idempotencyKey ||
        proposal.state !== row.proposal_state
      ) {
        throw new GovernanceError(
          "internal_error",
          "Stored profile change proposal metadata is inconsistent",
        );
      }
    } else if (row.proposal_state !== null) {
      throw new GovernanceError(
        "internal_error",
        "Stored profile change proposal metadata is inconsistent",
      );
    }

    return {
      stored,
      proposal,
      summary: {
        changeId: stored.changeId,
        profileId: stored.profileId,
        projectId: stored.projectId,
        outcome: stored.outcome,
        proposalId: proposal?.id ?? null,
        state: proposal?.state ?? null,
        createdAt: stored.createdAt,
      },
    };
  };

  const auditEvents = (filter: AuditQueryFilter): AuditEvent[] => {
    const { limit: requestedLimit, ...rawFilter } = filter;
    const parsed = auditFilterSchema.parse(rawFilter);
    const clauses: string[] = [];
    const parameters: Record<string, unknown> = {};
    const addNullableFilter = (
      field: string,
      parameter: string,
      value: string | null | undefined,
      supplied: boolean,
    ): void => {
      if (!supplied) return;
      if (value === null) {
        clauses.push(`${field} IS NULL`);
      } else {
        clauses.push(`${field} = @${parameter}`);
        parameters[parameter] = value;
      }
    };
    addNullableFilter(
      "project_id",
      "projectId",
      parsed.projectId,
      Object.hasOwn(parsed, "projectId"),
    );
    addNullableFilter(
      "profile_id",
      "profileId",
      parsed.profileId,
      Object.hasOwn(parsed, "profileId"),
    );
    addNullableFilter(
      "target_id",
      "targetId",
      parsed.targetId,
      Object.hasOwn(parsed, "targetId"),
    );
    addNullableFilter(
      "idempotency_key",
      "idempotencyKey",
      parsed.idempotencyKey,
      Object.hasOwn(parsed, "idempotencyKey"),
    );
    for (const [field, parameter, value] of [
      ["actor_type", "actorType", parsed.actorType],
      ["action_category", "actionCategory", parsed.actionCategory],
      ["outcome", "outcome", parsed.outcome],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${field} = @${parameter}`);
        parameters[parameter] = value;
      }
    }
    const numericLimit =
      typeof requestedLimit === "number" &&
      Number.isFinite(requestedLimit)
        ? Math.trunc(requestedLimit)
        : 100;
    parameters.limit = Math.min(500, Math.max(1, numericLimit));
    const where =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = database
      .prepare(
        `SELECT
           id, project_id, actor_type, profile_id, authority_mode,
           scope_decision, action_category, target_id, idempotency_key,
           revision_before, revision_after, outcome, reason, created_at
         FROM audit_events
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT @limit`,
      )
      .all(parameters) as AuditEventRow[];
    return rows.map(mapAuditEventRow);
  };

  return {
    inspectChangeSet(
      projectId: string,
      operations: ChangeOperation[],
    ): ChangeSetFacts {
      return inspectOperations(projectId, operations);
    },

    getIdempotencyResult(
      key: IdempotencyLookup,
    ): StoredIdempotencyResult | null {
      return idempotencyResult(key);
    },

    resolveSubmissionIdempotency(
      command: ResolveSubmissionIdempotencyCommand,
    ): SubmissionResult | null {
      const input = submitChangeSetInputSchema.parse(
        command.input,
      ) as SubmitChangeSetInput;
      return resolveSubmissionIdempotencyTransaction.immediate(command, input);
    },

    createProposal(
      command: CreateProposalCommand,
    ): SubmissionResult {
      const input = submitChangeSetInputSchema.parse(
        command.input,
      ) as SubmitChangeSetInput;
      return createProposalTransaction.immediate(command, input);
    },

    createRepositoryRefreshProposal(
      command: CreateRepositoryRefreshProposalCommand,
    ): ChangeProposalDetail {
      const input = createRepositoryRefreshProposalInputSchema.parse(
        command.input,
      ) as CreateRepositoryRefreshProposalInput;
      return createRepositoryRefreshProposalTransaction.immediate(
        command,
        input,
      );
    },

    acceptProposal(
      command: AcceptProposalCommand,
    ): ProposalDecisionResult {
      return acceptProposalTransaction.immediate(command);
    },

    rejectProposal(
      command: RejectProposalCommand,
    ): ChangeProposalDetail {
      return rejectProposalTransaction.immediate(command);
    },

    withdrawProposal(
      command: WithdrawProposalCommand,
    ): ChangeProposalDetail {
      return withdrawProposalTransaction.immediate(command);
    },

    applyDirect(command: ApplyDirectCommand): SubmissionResult {
      const input = submitChangeSetInputSchema.parse(
        command.input,
      ) as SubmitChangeSetInput;
      return applyDirectTransaction.immediate(command, input);
    },

    applyHumanChange(
      command: ApplyHumanChangeCommand,
    ): AppliedChangeSetResult {
      return applyHumanChangeTransaction.immediate(command);
    },

    recordSubmissionRejection(
      command: RecordSubmissionRejectionCommand,
    ): SubmissionResult {
      const input = submitChangeSetInputSchema.parse(
        command.input,
      ) as SubmitChangeSetInput;
      return recordSubmissionRejectionTransaction.immediate(command, input);
    },

    listProfileChanges(
      filter: ProfileChangeFilter,
    ): ProfileChangeSummary[] {
      const parsed = z
        .object({
          profileId: nonEmptyString,
          projectId: nonEmptyString.optional(),
          outcome: z
            .enum(["applied", "proposed", "conflicted", "rejected"])
            .optional(),
        })
        .strict()
        .parse(filter);
      return (
        selectProfileChanges.all({
          profileId: parsed.profileId,
          projectId: parsed.projectId ?? null,
          outcome: parsed.outcome ?? null,
        }) as ProfileChangeStorageRow[]
      ).map((row) => validatedProfileChange(row).summary);
    },

    getProfileChange(
      profileId: string,
      changeId: string,
    ): ProfileChangeDetail | null {
      const parsedProfileId = nonEmptyString.parse(profileId);
      const parsedChangeId = nonEmptyString.parse(changeId);
      const row = selectProfileChange.get(
        parsedProfileId,
        parsedChangeId,
      ) as ProfileChangeStorageRow | undefined;
      if (!row) return null;
      const validated = validatedProfileChange(row);
      const proposal = validated.proposal
        ? proposalDetail(validated.proposal.id)
        : null;
      if (validated.proposal && !proposal) {
        throw new GovernanceError(
          "internal_error",
          "Stored profile change proposal detail is corrupt",
        );
      }
      return {
        ...validated.summary,
        idempotencyKey: validated.stored.idempotencyKey,
        result: validated.stored.result,
        ...(proposal ? { proposal } : {}),
      };
    },

    getProposal(proposalId: string): ChangeProposalDetail | null {
      return proposalDetail(proposalId);
    },

    listProposals(filter: ProposalFilter): ChangeProposalSummary[] {
      const parsed = proposalFilterSchema.parse(filter);
      return (selectProposals.all() as ChangeProposalRow[])
        .map(mapProposalRow)
        .filter((proposal) =>
          (parsed.projectId === undefined ||
            proposal.projectId === parsed.projectId) &&
          (parsed.profileId === undefined ||
            (proposal.origin.type === "profile" &&
              proposal.origin.profileId === parsed.profileId)) &&
          (parsed.state === undefined ||
            proposal.state === parsed.state) &&
          (!Object.hasOwn(parsed, "sourceTaskId") ||
            proposal.sourceTaskId === parsed.sourceTaskId),
        )
        .map(proposalSummary);
    },

    listAuditEvents(filter: AuditQueryFilter): AuditEvent[] {
      return auditEvents(filter);
    },

    applyPreparedChangeSet(command): AppliedChangeSetResult {
      return applyTransaction.immediate(command);
    },
  };
};
