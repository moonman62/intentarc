import {
  GovernanceError,
  createRecordInputSchema,
  createRelationshipInputSchema,
  humanRecordUpdateInputSchema,
  submitChangeSetInputSchema,
  type AuthenticatedProfile,
  type CreateRecordInput,
  type CreateRelationshipInput,
  type GovernanceErrorCode,
  type HumanRecordUpdateInput,
  type ProjectRecord,
  type RecordRelationship,
  type SubmitChangeSetInput,
  type UpdateRecordOperation,
} from "../domain/index.js";
import type { ProfileStore } from "../storage/profile-store.js";
import {
  type AppliedOperationResult,
  type GovernanceStore,
  type SubmissionRejectionResult,
  type SubmissionResult,
} from "../storage/governance-store.js";
import { authorize } from "./authorization-policy.js";

export type ChangeSubmissionResult =
  | {
      outcome: "applied";
      changeId: string;
      projectRevision: number;
      operations: AppliedOperationResult[];
      replayed: boolean;
    }
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
      proposalId?: string;
      currentProjectRevision: number;
      replayed: boolean;
    }
  | {
      outcome: "rejected";
      changeId?: string;
      code: GovernanceErrorCode;
      reason: string;
      replayed: boolean;
    };

export interface ChangeService {
  submitProfileChange(
    principal: AuthenticatedProfile,
    input: SubmitChangeSetInput,
  ): ChangeSubmissionResult;
  /** Internal governed-only route for coordination final results. */
  submitProfileProposal(
    principal: AuthenticatedProfile,
    input: SubmitChangeSetInput,
    options?: { forceConflict?: boolean },
  ): ChangeSubmissionResult;
  applyHumanRecord(input: CreateRecordInput): ProjectRecord;
  applyHumanRecordUpdate(input: HumanRecordUpdateInput): ProjectRecord;
  applyHumanRelationship(input: HumanRelationshipCreateInput): RecordRelationship;
  applyHumanRelationshipRemoval(input: HumanRelationshipRemovalInput): RecordRelationship;
}

export interface HumanRelationshipCreateInput extends CreateRelationshipInput {
  expectedProjectRevision: number;
}

export interface HumanRelationshipRemovalInput {
  projectId: string;
  relationshipId: string;
  expectedProjectRevision: number;
}

type ChangeProfileStore = Pick<
  ProfileStore,
  "getAuthority" | "revalidatePrincipal"
>;
type ChangeGovernanceStore = Pick<
  GovernanceStore,
  | "inspectChangeSet"
  | "resolveSubmissionIdempotency"
  | "createProposal"
  | "applyDirect"
  | "applyHumanChange"
  | "recordSubmissionRejection"
>;

export interface ChangeServiceDependencies {
  profileStore: ChangeProfileStore;
  governanceStore: ChangeGovernanceStore;
  now: () => string;
}

const mapSubmissionResult = (
  result: SubmissionResult | SubmissionRejectionResult,
): ChangeSubmissionResult => {
  switch (result.outcome) {
    case "applied":
      return {
        outcome: result.outcome,
        changeId: result.changeId,
        projectRevision:
          "projectRevision" in result
            ? result.projectRevision
            : result.revisionAfter,
        operations: result.operations,
        replayed: result.replayed,
      };
    case "proposed":
      return {
        outcome: result.outcome,
        changeId: result.changeId,
        proposalId: result.proposalId,
        state: result.state,
        replayed: result.replayed,
      };
    case "conflicted":
      return {
        outcome: result.outcome,
        changeId: result.changeId,
        ...("proposalId" in result
          ? { proposalId: result.proposalId }
          : {}),
        currentProjectRevision: result.currentProjectRevision,
        replayed: result.replayed,
      };
    case "rejected":
      return {
        outcome: result.outcome,
        ...("changeId" in result
          ? { changeId: result.changeId }
          : {}),
        code: result.code,
        reason: result.reason,
        replayed: result.replayed,
      };
  }
};

const unexpectedHumanResult = (): GovernanceError =>
  new GovernanceError(
    "internal_error",
    "Human change returned an unexpected operation result",
  );

const nonEmptyIdentifier = (value: string): string => {
  const parsed = value.trim();
  if (!parsed) {
    throw new GovernanceError("validation_failed", "Identifier must not be empty");
  }
  return parsed;
};

const expectedRevision = (value: number): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new GovernanceError(
      "validation_failed",
      "Expected project revision must be a non-negative integer",
    );
  }
  return value;
};

export const createChangeService = ({
  profileStore,
  governanceStore,
  now,
}: ChangeServiceDependencies): ChangeService => {
  const submitProfile = (
    principal: AuthenticatedProfile,
    input: SubmitChangeSetInput,
    proposalOnly: boolean,
    forceConflict = false,
  ): ChangeSubmissionResult => {
    const parsed = submitChangeSetInputSchema.parse(
      input,
    ) as SubmitChangeSetInput;
    const currentPrincipal = profileStore.revalidatePrincipal(principal);
    const timestamp = now();
    const existing = governanceStore.resolveSubmissionIdempotency({
      profileId: currentPrincipal.id,
      credentialGeneration: currentPrincipal.credentialGeneration,
      input: parsed,
      resolvedAt: timestamp,
      ...(forceConflict ? { forceConflict: true } : {}),
    });
    if (existing) return mapSubmissionResult(existing);
    const assignment = profileStore.getAuthority(
      currentPrincipal.id,
      parsed.projectId,
    );
    if (!assignment) {
      return mapSubmissionResult(
        governanceStore.recordSubmissionRejection({
          profileId: currentPrincipal.id,
          credentialGeneration: currentPrincipal.credentialGeneration,
          input: parsed,
          rejectedAt: timestamp,
        }),
      );
    }

    const facts = governanceStore.inspectChangeSet(
      parsed.projectId,
      parsed.operations,
    );
    const decision = authorize({
      mode: assignment.authority.mode,
      scopes: assignment.scopes,
      operations: facts.operations,
    });
    if (decision.action === "deny") {
      return mapSubmissionResult(
        governanceStore.recordSubmissionRejection({
          profileId: currentPrincipal.id,
          credentialGeneration: currentPrincipal.credentialGeneration,
          input: parsed,
          rejectedAt: timestamp,
        }),
      );
    }
    if (proposalOnly || decision.action === "propose") {
      return mapSubmissionResult(
        governanceStore.createProposal({
          profileId: currentPrincipal.id,
          credentialGeneration: currentPrincipal.credentialGeneration,
          authorityMode: decision.mode,
          scopeDecision:
            proposalOnly && decision.action === "apply"
              ? "proposal_only"
              : decision.mode === "proposal"
              ? "proposal_mode"
              : "scope_fallback",
          input: parsed,
          submittedAt: timestamp,
          ...(forceConflict ? { forceConflict: true } : {}),
        }),
      );
    }

    return mapSubmissionResult(
      governanceStore.applyDirect({
        profileId: currentPrincipal.id,
        credentialGeneration: currentPrincipal.credentialGeneration,
        authorityMode: decision.mode,
        scopeDecision:
          decision.mode === "full_direct"
            ? "full_direct"
            : decision.matchedScopeIds.join(","),
        input: parsed,
        completedAt: timestamp,
      }),
    );
  };

  return {
    submitProfileChange(principal, input) {
      return submitProfile(principal, input, false);
    },

    submitProfileProposal(principal, input, options) {
      return submitProfile(principal, input, true, options?.forceConflict === true);
    },

  applyHumanRecord(input: CreateRecordInput): ProjectRecord {
    const parsed = createRecordInputSchema.parse(input);
    const result = governanceStore.applyHumanChange({
      projectId: parsed.projectId,
      rationale: "Create project record",
      operations: [{
        operationId: "human-create-record",
        type: "create_record",
        kind: parsed.kind,
        status: parsed.status,
        title: parsed.title,
        body: parsed.body,
        sourceKind: parsed.sourceKind,
        sourceRef: parsed.sourceRef,
      }],
      completedAt: now(),
    });
    const operation = result.operations[0];
    if (
      result.operations.length !== 1 ||
      operation?.type !== "create_record"
    ) {
      throw unexpectedHumanResult();
    }
    return operation.record;
  },

  applyHumanRecordUpdate(input: HumanRecordUpdateInput): ProjectRecord {
    const parsed = humanRecordUpdateInputSchema.parse(input);
    const patch: UpdateRecordOperation["patch"] = {};
    if (parsed.patch.title !== undefined) patch.title = parsed.patch.title;
    if (parsed.patch.body !== undefined) patch.body = parsed.patch.body;
    if (parsed.patch.status !== undefined) patch.status = parsed.patch.status;
    const result = governanceStore.applyHumanChange({
      projectId: parsed.projectId,
      rationale: "Update project record",
      operations: [{
        operationId: "human-update-record",
        type: "update_record",
        recordId: parsed.recordId,
        expectedRecordRevision: parsed.expectedRecordRevision,
        patch,
      }],
      completedAt: now(),
    });
    const operation = result.operations[0];
    if (
      result.operations.length !== 1 ||
      operation?.type !== "update_record"
    ) {
      throw unexpectedHumanResult();
    }
    return operation.record;
  },

  applyHumanRelationship(
    input: HumanRelationshipCreateInput,
  ): RecordRelationship {
    const { expectedProjectRevision, ...relationshipInput } = input;
    const parsed = createRelationshipInputSchema.parse(relationshipInput);
    const result = governanceStore.applyHumanChange({
      projectId: parsed.projectId,
      expectedProjectRevision: expectedRevision(expectedProjectRevision),
      rationale: "Create record relationship",
      operations: [{
        operationId: "human-create-relationship",
        type: "create_relationship",
        from: { recordId: parsed.fromRecordId },
        to: { recordId: parsed.toRecordId },
        kind: parsed.kind,
      }],
      completedAt: now(),
    });
    const operation = result.operations[0];
    if (
      result.operations.length !== 1 ||
      operation?.type !== "create_relationship"
    ) {
      throw unexpectedHumanResult();
    }
    return operation.relationship;
  },

  applyHumanRelationshipRemoval(input): RecordRelationship {
    const projectId = nonEmptyIdentifier(input.projectId);
    const relationshipId = nonEmptyIdentifier(input.relationshipId);
    const result = governanceStore.applyHumanChange({
      projectId,
      expectedProjectRevision: expectedRevision(input.expectedProjectRevision),
      rationale: "Remove record relationship",
      operations: [{
        operationId: "human-remove-relationship",
        type: "remove_relationship",
        relationshipId,
      }],
      completedAt: now(),
    });
    const operation = result.operations[0];
    if (
      result.operations.length !== 1 ||
      operation?.type !== "remove_relationship"
    ) {
      throw unexpectedHumanResult();
    }
    return operation.relationship;
  },
  };
};
