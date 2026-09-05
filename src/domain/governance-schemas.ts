import { z } from "zod";
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
  ProposalOperationRow,
  ProposalOrigin,
  ProposalState,
  RecordReference,
  StoredClientProfile,
  SubmitChangeSetInput,
} from "./governance-model.js";
import type { RecordStatus } from "./model.js";
import {
  recordKindSchema,
  recordStatusSchema,
  relationshipKindSchema,
} from "./schemas.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
export const credentialHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const profileStatusSchema: z.ZodType<ProfileStatus> = z.enum([
  "enabled",
  "disabled",
]);

export const clientExecutionModeSchema: z.ZodType<ClientExecutionMode> = z.enum([
  "safe",
  "trusted",
  "custom",
]);

export const authorityModeSchema: z.ZodType<AuthorityMode> = z.enum([
  "proposal",
  "scoped_direct",
  "full_direct",
]);

export const changeOperationTypeSchema: z.ZodType<ChangeOperationType> = z.enum([
  "create_record",
  "update_record",
  "create_relationship",
  "remove_relationship",
]);

export const proposalStateSchema: z.ZodType<ProposalState> = z.enum([
  "pending",
  "accepted",
  "rejected",
  "conflicted",
  "withdrawn",
]);

export const proposalOriginSchema: z.ZodType<ProposalOrigin> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("profile"),
      profileId: nonEmptyStringSchema,
    }).strict(),
    z.object({
      type: z.literal("repository_refresh"),
      repositorySnapshotId: nonEmptyStringSchema,
    }).strict(),
  ]);

export const changeOutcomeSchema: z.ZodType<ChangeOutcome> = z.enum([
  "applied",
  "proposed",
  "conflicted",
  "rejected",
]);

export const recordReferenceSchema: z.ZodType<RecordReference> = z.union([
  z.object({ recordId: nonEmptyStringSchema }).strict(),
  z.object({ localRef: nonEmptyStringSchema }).strict(),
]);

const createRecordOperationSchema = z
  .object({
    operationId: nonEmptyStringSchema,
    type: z.literal("create_record"),
    localRef: nonEmptyStringSchema.optional(),
    kind: recordKindSchema,
    status: recordStatusSchema,
    title: nonEmptyStringSchema,
    body: nonEmptyStringSchema,
  })
  .strict();

const updateRecordOperationSchema = z
  .object({
    operationId: nonEmptyStringSchema,
    type: z.literal("update_record"),
    recordId: nonEmptyStringSchema,
    expectedRecordRevision: positiveIntegerSchema,
    patch: z
      .object({
        title: nonEmptyStringSchema.optional(),
        body: nonEmptyStringSchema.optional(),
        status: recordStatusSchema.optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, {
        message: "Update patches must include at least one field",
      }),
  })
  .strict();

const createRelationshipOperationSchema = z
  .object({
    operationId: nonEmptyStringSchema,
    type: z.literal("create_relationship"),
    from: recordReferenceSchema,
    to: recordReferenceSchema,
    kind: relationshipKindSchema,
  })
  .strict();

const removeRelationshipOperationSchema = z
  .object({
    operationId: nonEmptyStringSchema,
    type: z.literal("remove_relationship"),
    relationshipId: nonEmptyStringSchema,
  })
  .strict();

export const changeOperationSchema = z.discriminatedUnion(
  "type",
  [
    createRecordOperationSchema,
    updateRecordOperationSchema,
    createRelationshipOperationSchema,
    removeRelationshipOperationSchema,
  ],
);

const referenceIdentity = (reference: RecordReference): string =>
  "recordId" in reference ? `record:${reference.recordId}` : `local:${reference.localRef}`;

export const changeOperationsSchema = z
  .array(changeOperationSchema)
  .min(1)
  .superRefine((operations, context) => {
    const operationIds = new Set<string>();
    const localReferences = new Set<string>();
    const updateRecordTargets = new Set<string>();

    operations.forEach((operation, index) => {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "operationId values must be unique",
          path: [index, "operationId"],
        });
      }
      operationIds.add(operation.operationId);

      if (operation.type === "update_record") {
        if (updateRecordTargets.has(operation.recordId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "update_record targets must be unique",
            path: [index, "recordId"],
          });
        }
        updateRecordTargets.add(operation.recordId);
      }

      if (operation.type === "create_record" && operation.localRef) {
        if (localReferences.has(operation.localRef)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "localRef values must be unique",
            path: [index, "localRef"],
          });
        }
        localReferences.add(operation.localRef);
      }

      if (operation.type === "create_relationship") {
        const references = [operation.from, operation.to];
        for (const [referenceIndex, reference] of references.entries()) {
          if ("localRef" in reference && !localReferences.has(reference.localRef)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "localRef must refer to an earlier create_record operation",
              path: [index, referenceIndex === 0 ? "from" : "to", "localRef"],
            });
          }
        }
        if (referenceIdentity(operation.from) === referenceIdentity(operation.to)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Relationships must link different records",
            path: [index, "to"],
          });
        }
      }
    });
  });

export const submitChangeSetInputSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    baseProjectRevision: nonNegativeIntegerSchema,
    idempotencyKey: nonEmptyStringSchema.min(1).max(128),
    rationale: nonEmptyStringSchema,
    sourceTaskId: nonEmptyStringSchema.nullish().transform((value) => value ?? null),
    predecessorProposalId: nonEmptyStringSchema.nullish().transform((value) => value ?? null),
    operations: changeOperationsSchema,
  })
  .strict();

export const createRepositoryRefreshProposalInputSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    repositorySnapshotId: nonEmptyStringSchema,
    baseProjectRevision: nonNegativeIntegerSchema,
    rationale: nonEmptyStringSchema,
    operations: changeOperationsSchema,
  })
  .strict();

export const humanRecordUpdateInputSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    recordId: nonEmptyStringSchema,
    expectedRecordRevision: positiveIntegerSchema,
    patch: z
      .object({
        title: nonEmptyStringSchema.optional(),
        body: nonEmptyStringSchema.optional(),
        status: recordStatusSchema.optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, {
        message: "Human record update patches must include at least one field",
      }),
  })
  .strict();

export const isRecordStatusTransitionAllowed = (
  from: RecordStatus,
  to: RecordStatus,
): boolean => {
  if (from === to) return true;
  if (from === "archived") return false;
  if (from === "rejected" || from === "superseded") return to === "archived";
  return true;
};

const clientProfileObjectSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    status: profileStatusSchema,
    executionMode: clientExecutionModeSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    tokenRotatedAt: nonEmptyStringSchema,
    lastUsedAt: nonEmptyStringSchema.nullable(),
  })
  .strict();

export const clientProfileSchema: z.ZodType<ClientProfile> = clientProfileObjectSchema;

export const storedClientProfileSchema: z.ZodType<StoredClientProfile> = clientProfileObjectSchema
  .extend({ tokenHash: credentialHashSchema })
  .strict();

export const profileProjectAuthoritySchema: z.ZodType<ProfileProjectAuthority> = z
  .object({
    id: nonEmptyStringSchema,
    profileId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    mode: authorityModeSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  })
  .strict();

export const profileScopeSchema: z.ZodType<ProfileScope> = z
  .object({
    id: nonEmptyStringSchema,
    authorityId: nonEmptyStringSchema,
    operationType: changeOperationTypeSchema,
    recordKind: recordKindSchema.nullable(),
    fromRecordKind: recordKindSchema.nullable(),
    toRecordKind: recordKindSchema.nullable(),
    relationshipKind: relationshipKindSchema.nullable(),
    createdAt: nonEmptyStringSchema,
  })
  .strict();

export const changeProposalSchema: z.ZodType<ChangeProposal> = z
  .object({
    id: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    origin: proposalOriginSchema,
    sourceTaskId: nonEmptyStringSchema.nullable(),
    predecessorProposalId: nonEmptyStringSchema.nullable(),
    baseProjectRevision: nonNegativeIntegerSchema,
    state: proposalStateSchema,
    rationale: nonEmptyStringSchema,
    idempotencyKey: nonEmptyStringSchema.min(1).max(128).nullable(),
    requestHash: nonEmptyStringSchema.nullable(),
    reviewReason: nonEmptyStringSchema.nullable(),
    reviewerActor: nonEmptyStringSchema.nullable(),
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    reviewedAt: nonEmptyStringSchema.nullable(),
  })
  .strict()
  .superRefine((proposal, context) => {
    const profile = proposal.origin.type === "profile";
    if (profile !== (proposal.idempotencyKey !== null)) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "Only profile proposals have idempotency keys",
      });
    }
    if (profile !== (proposal.requestHash !== null)) {
      context.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "Only profile proposals have request hashes",
      });
    }
  });

export const proposalOperationRowSchema: z.ZodType<ProposalOperationRow> = z
  .object({
    proposalId: nonEmptyStringSchema,
    position: nonNegativeIntegerSchema,
    operationId: nonEmptyStringSchema,
    operationType: changeOperationTypeSchema,
    payloadJson: nonEmptyStringSchema,
    expectedRecordRevision: positiveIntegerSchema.nullable(),
  })
  .strict();

export const idempotencyResultRowSchema: z.ZodType<IdempotencyResultRow> = z
  .object({
    profileId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    idempotencyKey: nonEmptyStringSchema.min(1).max(128),
    changeId: nonEmptyStringSchema,
    requestHash: nonEmptyStringSchema,
    outcome: changeOutcomeSchema,
    resultJson: nonEmptyStringSchema,
    createdAt: nonEmptyStringSchema,
  })
  .strict();

export const auditEventSchema: z.ZodType<AuditEvent> = z
  .object({
    id: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.nullable(),
    actorType: z.enum(["local_human", "profile"]),
    profileId: nonEmptyStringSchema.nullable(),
    authorityMode: z.union([z.literal("human"), authorityModeSchema]).nullable(),
    scopeDecision: nonEmptyStringSchema.nullable(),
    actionCategory: nonEmptyStringSchema,
    targetId: nonEmptyStringSchema.nullable(),
    idempotencyKey: nonEmptyStringSchema.nullable(),
    revisionBefore: nonNegativeIntegerSchema.nullable(),
    revisionAfter: nonNegativeIntegerSchema.nullable(),
    outcome: nonEmptyStringSchema,
    reason: nonEmptyStringSchema.nullable(),
    createdAt: nonEmptyStringSchema,
  })
  .strict();

export const createProfileInputSchema = z.object({ name: nonEmptyStringSchema }).strict();

export const setAuthorityInputSchema = z
  .object({
    profileId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    mode: authorityModeSchema,
  })
  .strict();

export const addScopeInputSchema = z
  .object({
    authorityId: nonEmptyStringSchema,
    operationType: changeOperationTypeSchema,
    recordKind: recordKindSchema.nullable(),
    fromRecordKind: recordKindSchema.nullable(),
    toRecordKind: recordKindSchema.nullable(),
    relationshipKind: relationshipKindSchema.nullable(),
  })
  .strict();

export const proposalFilterSchema = z
  .object({
    projectId: nonEmptyStringSchema.optional(),
    profileId: nonEmptyStringSchema.optional(),
    state: proposalStateSchema.optional(),
    sourceTaskId: nonEmptyStringSchema.nullable().optional(),
  })
  .strict();

export const auditFilterSchema = z
  .object({
    projectId: nonEmptyStringSchema.nullable().optional(),
    profileId: nonEmptyStringSchema.nullable().optional(),
    actorType: z.enum(["local_human", "profile"]).optional(),
    actionCategory: nonEmptyStringSchema.optional(),
    targetId: nonEmptyStringSchema.nullable().optional(),
    idempotencyKey: nonEmptyStringSchema.nullable().optional(),
    outcome: nonEmptyStringSchema.optional(),
  })
  .strict();
