import type { CoordinationErrorCode } from "./coordination-model.js";

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(readonly recordId: string) {
    super(`Record not found: ${recordId}`);
    this.name = "RecordNotFoundError";
  }
}

export class RelationshipAlreadyExistsError extends Error {
  constructor(
    readonly fromRecordId: string,
    readonly toRecordId: string,
    readonly kind: string,
  ) {
    super(
      `Relationship already exists: ${fromRecordId} -> ${toRecordId} (${kind})`,
    );
    this.name = "RelationshipAlreadyExistsError";
  }
}

export class InvalidTaskError extends Error {
  constructor(readonly recordId: string) {
    super(`Record is not a task: ${recordId}`);
    this.name = "InvalidTaskError";
  }
}

export class CorruptStoredContextPackError extends Error {
  constructor(readonly packId: string) {
    super(`Stored context pack is corrupt: ${packId}`);
    this.name = "CorruptStoredContextPackError";
  }
}

export type GovernanceErrorCode =
  | "profile_required"
  | "invalid_profile_credentials"
  | "profile_disabled"
  | "project_authority_missing"
  | "operation_denied"
  | "validation_failed"
  | "project_map_limit_exceeded"
  | "project_revision_conflict"
  | "record_revision_conflict"
  | "proposal_not_pending"
  | "proposal_conflicted"
  | "idempotency_conflict"
  | "unsupported_operation"
  | "internal_error";

export class GovernanceError extends Error {
  constructor(
    readonly code: GovernanceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

const coordinationErrorMessages: Readonly<Record<CoordinationErrorCode, string>> = {
  task_not_ready: "Task is not ready for coordination.",
  claim_conflict: "Task claim conflicts with current coordination state.",
  claim_expired: "Task claim has expired.",
  lease_horizon_reached: "Task claim lease horizon has been reached.",
  revision_conflict: "Coordination revision no longer matches current state.",
  delegation_conflict: "Task delegation conflicts with current coordination state.",
  delegation_expired: "Task delegation has expired.",
  delegation_revoked: "Task delegation has been revoked.",
  checkpoint_invalid: "Task checkpoint is invalid.",
  submission_stale: "Task submission is stale.",
  submission_invalid: "Task submission is invalid.",
  coordination_authority_denied: "Coordination authority is denied.",
  coordination_idempotency_conflict: "Coordination idempotency key conflicts with an existing request.",
  coordination_unavailable: "Coordination is unavailable.",
};

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;

  constructor(code: unknown) {
    const stableCode = typeof code === "string" && Object.prototype.hasOwnProperty.call(
      coordinationErrorMessages,
      code,
    )
      ? code as CoordinationErrorCode
      : "coordination_unavailable";
    super(coordinationErrorMessages[stableCode]);
    this.code = stableCode;
    this.name = "CoordinationError";
  }
}
