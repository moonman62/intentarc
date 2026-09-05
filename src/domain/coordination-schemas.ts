import { z } from "zod";
import type {
  CheckpointDocument,
  CoordinationEvent,
  CoordinationState,
  DelegationScope,
  RepositoryEvidence,
  TaskCheckpoint,
  TaskClaim,
  TaskClaimState,
  TaskDelegation,
  TaskDelegationState,
  TaskSubmission,
  TaskSubmissionState,
  VerificationEvidence,
} from "./coordination-model.js";
import {
  changeOperationSchema,
  changeOperationTypeSchema,
  changeProposalSchema,
} from "./governance-schemas.js";
import { projectRecordSchema, taskContextPackSchema } from "./schemas.js";

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const identifierSchema = z.string().trim().min(1).max(200).refine(
  (value) => !controlCharacterPattern.test(value),
  "Text must not contain control characters",
);
const boundedTextSchema = z.string().trim().min(1).refine(
  (value) => !controlCharacterPattern.test(value),
  "Text must not contain control characters",
);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
export const coordinationTimestampSchema = z.iso.datetime();
const idempotencyKeySchema = identifierSchema.max(128);
// Two 200-code-unit identifiers can each require 1,200 JSON bytes in the
// worst case (escaped lone UTF-16 surrogates). Field names, a safe integer,
// punctuation, and the 64-byte filter hash keep the JSON below 2,656 bytes;
// base64url expansion stays below 3,542 characters. Keep finite headroom.
const maximumOpaqueCursorLength = 4_096;
const canonicalBase64UrlRoundTrips = (value: string): boolean => {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const decoded = atob(base64);
    const encoded = btoa(decoded)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    return encoded === value;
  } catch {
    return false;
  }
};
export const opaqueCoordinationCursorSchema = z.string()
  .min(1)
  .max(maximumOpaqueCursorLength)
  .regex(/^[A-Za-z0-9_-]+$/, "Cursor must use unpadded base64url")
  .refine(
    canonicalBase64UrlRoundTrips,
    "Cursor must use canonical base64url encoding",
  );

const sortedUnique = (values: string[]): boolean => values.every(
  (value, index) => index === 0 || values[index - 1]! < value,
);
const sortedUniqueTextArraySchema = boundedTextSchema.array().refine(sortedUnique, {
  message: "Values must be sorted and unique",
});
export const delegationAllowedOutputsSchema = changeOperationTypeSchema.array()
  .min(1)
  .refine(sortedUnique, { message: "Values must be sorted and unique" });
const utf8Encoder = new TextEncoder();
const withinCanonicalBytes = (limit: number) =>
  (value: unknown): boolean =>
    utf8Encoder.encode(JSON.stringify(value)).byteLength <= limit;

export const taskClaimStateSchema: z.ZodType<TaskClaimState> = z.enum([
  "active", "paused", "released", "submitted", "expired", "reconciled",
]);
export const taskDelegationStateSchema: z.ZodType<TaskDelegationState> = z.enum([
  "offered", "accepted", "revoked", "expired", "claimed", "completed",
]);
export const taskSubmissionStateSchema: z.ZodType<TaskSubmissionState> = z.enum([
  "submitted", "conflicted", "accepted", "rejected", "withdrawn",
]);

export const verificationEvidenceSchema: z.ZodType<VerificationEvidence> = z.object({
  tests: sortedUniqueTextArraySchema,
  artifacts: sortedUniqueTextArraySchema,
}).strict();

export const repositoryEvidenceSchema: z.ZodType<RepositoryEvidence> = z.object({
  branch: boundedTextSchema.nullable(),
  worktree: boundedTextSchema.nullable(),
  commits: sortedUniqueTextArraySchema,
  artifacts: sortedUniqueTextArraySchema,
}).strict();

const checkpointDocumentObjectSchema = z.object({
  summary: boundedTextSchema,
  completedWork: sortedUniqueTextArraySchema,
  remainingWork: sortedUniqueTextArraySchema,
  blockers: sortedUniqueTextArraySchema,
  verificationEvidence: verificationEvidenceSchema,
  repositoryEvidence: repositoryEvidenceSchema.nullable(),
}).strict();
export const checkpointDocumentSchema: z.ZodType<CheckpointDocument> = checkpointDocumentObjectSchema
  .refine(withinCanonicalBytes(65_536), "Checkpoint exceeds 64 KiB");

export const delegationScopeSchema: z.ZodType<DelegationScope> = z.object({
  summary: boundedTextSchema,
  constraints: sortedUniqueTextArraySchema,
}).strict().refine(withinCanonicalBytes(32_768), "Delegation scope exceeds 32 KiB");

export const submissionDocumentSchema = z.object({
  summary: boundedTextSchema,
  verificationEvidence: verificationEvidenceSchema,
  repositoryEvidence: repositoryEvidenceSchema.nullable(),
  changes: z.object({
    rationale: boundedTextSchema,
    operations: z.array(changeOperationSchema),
  }).strict(),
}).strict().refine(withinCanonicalBytes(262_144), "Submission exceeds 256 KiB");

export const taskClaimSchema: z.ZodType<TaskClaim> = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  profileId: identifierSchema,
  delegationId: identifierSchema.nullable(),
  state: taskClaimStateSchema,
  baseProjectRevision: nonNegativeIntegerSchema,
  baseTaskRevision: positiveIntegerSchema,
  contextPackId: identifierSchema,
  acquiredAt: coordinationTimestampSchema,
  expiresAt: coordinationTimestampSchema,
  absoluteExpiresAt: coordinationTimestampSchema,
  endedAt: coordinationTimestampSchema.nullable(),
  latestCheckpointId: identifierSchema.nullable(),
}).strict().superRefine((claim, context) => {
  const acquiredAt = Date.parse(claim.acquiredAt);
  const expiresAt = Date.parse(claim.expiresAt);
  const absoluteExpiresAt = Date.parse(claim.absoluteExpiresAt);

  if (absoluteExpiresAt !== acquiredAt + 4 * 60 * 60 * 1_000) {
    context.addIssue({
      code: "custom",
      path: ["absoluteExpiresAt"],
      message: "absoluteExpiresAt must be exactly four hours after acquiredAt",
    });
  }
  if (expiresAt <= acquiredAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after acquiredAt",
    });
  }
  if (expiresAt > absoluteExpiresAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must not be later than absoluteExpiresAt",
    });
  }
});

export const taskCheckpointSchema: z.ZodType<TaskCheckpoint> = checkpointDocumentObjectSchema.extend({
  id: identifierSchema,
  claimId: identifierSchema,
  sequence: positiveIntegerSchema,
  createdAt: coordinationTimestampSchema,
  projectRevision: nonNegativeIntegerSchema,
  taskRevision: positiveIntegerSchema,
  contextPackId: identifierSchema,
}).strict().superRefine((checkpoint, context) => {
  const document = {
    summary: checkpoint.summary,
    completedWork: checkpoint.completedWork,
    remainingWork: checkpoint.remainingWork,
    blockers: checkpoint.blockers,
    verificationEvidence: checkpoint.verificationEvidence,
    repositoryEvidence: checkpoint.repositoryEvidence,
  };
  if (!withinCanonicalBytes(65_536)(document)) {
    context.addIssue({ code: "custom", message: "Checkpoint exceeds 64 KiB" });
  }
  // The immutable record adds only bounded identifiers, revisions, sequence,
  // and a timestamp. Keep a finite 72 KiB transport/storage envelope without
  // charging that metadata against the canonical 64 KiB document contract.
  if (!withinCanonicalBytes(72 * 1_024)(checkpoint)) {
    context.addIssue({ code: "custom", message: "Checkpoint record exceeds 72 KiB" });
  }
});

export const taskDelegationSchema: z.ZodType<TaskDelegation> = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  parentProfileId: identifierSchema,
  childProfileId: identifierSchema,
  state: taskDelegationStateSchema,
  baseProjectRevision: nonNegativeIntegerSchema,
  baseTaskRevision: positiveIntegerSchema,
  scope: delegationScopeSchema,
  allowedOutputs: delegationAllowedOutputsSchema,
  offeredAt: coordinationTimestampSchema,
  deadline: coordinationTimestampSchema,
  acceptedAt: coordinationTimestampSchema.nullable(),
  endedAt: coordinationTimestampSchema.nullable(),
  claimId: identifierSchema.nullable(),
}).strict().refine(withinCanonicalBytes(32_768), "Delegation exceeds 32 KiB");

export const taskSubmissionSchema: z.ZodType<TaskSubmission> = z.object({
  id: identifierSchema,
  claimId: identifierSchema,
  checkpointId: identifierSchema,
  profileId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  baseProjectRevision: nonNegativeIntegerSchema,
  baseTaskRevision: positiveIntegerSchema,
  contextPackId: identifierSchema,
  summary: boundedTextSchema,
  verificationEvidence: verificationEvidenceSchema,
  repositoryEvidence: repositoryEvidenceSchema.nullable(),
  proposalId: identifierSchema,
  state: taskSubmissionStateSchema,
  submittedAt: coordinationTimestampSchema,
  decidedAt: coordinationTimestampSchema.nullable(),
}).strict();

export const coordinationEventSchema: z.ZodType<CoordinationEvent> = z.object({
  id: identifierSchema,
  category: z.enum([
    "ready_evaluation", "claim", "renewal", "checkpoint", "pause", "release", "switch", "expiry",
    "delegation_offer", "delegation_accept", "delegation_revoke", "submission", "conflict", "reconciliation",
  ]),
  projectId: identifierSchema,
  taskId: identifierSchema,
  profileId: identifierSchema.nullable(),
  claimId: identifierSchema.nullable(),
  delegationId: identifierSchema.nullable(),
  checkpointId: identifierSchema.nullable(),
  submissionId: identifierSchema.nullable(),
  proposalId: identifierSchema.nullable(),
  priorState: boundedTextSchema.nullable(),
  resultingState: boundedTextSchema.nullable(),
  projectRevision: nonNegativeIntegerSchema,
  taskRevision: positiveIntegerSchema,
  detail: boundedTextSchema.nullable(),
  createdAt: coordinationTimestampSchema,
}).strict();

export const readyTaskSchema = z.object({
  task: projectRecordSchema,
  blockers: sortedUniqueTextArraySchema,
  liveClaimId: identifierSchema.nullable(),
  liveDelegationId: identifierSchema.nullable(),
}).strict();

export const readyTaskPageSchema = z.object({
  tasks: z.array(readyTaskSchema),
  nextCursor: opaqueCoordinationCursorSchema.nullable(),
  projectRevision: nonNegativeIntegerSchema,
}).strict();

export const coordinationStateSchema: z.ZodType<CoordinationState> = z.object({
  projectRevision: nonNegativeIntegerSchema,
  task: projectRecordSchema,
  claim: taskClaimSchema.nullable(),
  delegation: taskDelegationSchema.nullable(),
  latestCheckpoint: taskCheckpointSchema.nullable(),
  submission: taskSubmissionSchema.nullable(),
  events: z.array(coordinationEventSchema),
}).strict();

export const listReadyTasksInputSchema = z.object({
  projectId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  cursor: opaqueCoordinationCursorSchema.nullable(),
  limit: positiveIntegerSchema.max(100),
}).strict();

export const coordinationStateInputSchema = z.object({
  projectId: identifierSchema,
  taskId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
}).strict();

export const claimTaskInputSchema = z.object({
  projectId: identifierSchema,
  taskId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  contextBudgetTokens: positiveIntegerSchema,
  acceptedDelegationId: identifierSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const renewClaimInputSchema = z.object({
  claimId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const checkpointClaimInputSchema = z.object({
  claimId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  checkpoint: checkpointDocumentSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const transitionClaimInputSchema = z.discriminatedUnion("action", [
  z.object({
    claimId: identifierSchema,
    expectedProjectRevision: nonNegativeIntegerSchema,
    expectedTaskRevision: positiveIntegerSchema,
    action: z.literal("pause"),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  z.object({
    claimId: identifierSchema,
    expectedProjectRevision: nonNegativeIntegerSchema,
    expectedTaskRevision: positiveIntegerSchema,
    action: z.literal("release"),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
]);

export const switchTaskInputSchema = z.object({
  currentClaimId: identifierSchema,
  projectId: identifierSchema,
  currentTaskId: identifierSchema,
  expectedCurrentProjectRevision: nonNegativeIntegerSchema,
  expectedCurrentTaskRevision: positiveIntegerSchema,
  checkpoint: checkpointDocumentSchema,
  terminalAction: z.enum(["pause", "release"]),
  nextTaskId: identifierSchema,
  expectedNextProjectRevision: nonNegativeIntegerSchema,
  expectedNextTaskRevision: positiveIntegerSchema,
  nextContextBudgetTokens: positiveIntegerSchema,
  acceptedDelegationId: identifierSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((input, context) => {
  if (input.expectedCurrentProjectRevision !== input.expectedNextProjectRevision) {
    context.addIssue({ code: "custom", path: ["expectedNextProjectRevision"], message: "Switch tasks must use the same project revision" });
  }
  if (input.currentTaskId === input.nextTaskId) {
    context.addIssue({ code: "custom", path: ["nextTaskId"], message: "Switch task must differ from the current task" });
  }
});

export const createDelegationInputSchema = z.object({
  projectId: identifierSchema,
  taskId: identifierSchema,
  childProfileId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  scope: delegationScopeSchema,
  allowedOutputs: delegationAllowedOutputsSchema,
  deadline: coordinationTimestampSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().refine(withinCanonicalBytes(32_768), "Delegation exceeds 32 KiB");

export const acceptDelegationInputSchema = z.object({
  delegationId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const revokeDelegationInputSchema = z.object({
  delegationId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const submitTaskResultInputSchema = z.object({
  claimId: identifierSchema,
  checkpointId: identifierSchema,
  expectedProjectRevision: nonNegativeIntegerSchema,
  expectedTaskRevision: positiveIntegerSchema,
  submission: submissionDocumentSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((input, context) => {
  input.submission.changes.operations.forEach((operation, index) => {
    if (operation.type === "update_record" && operation.patch.status === "completed") {
      context.addIssue({
        code: "custom",
        path: ["submission", "changes", "operations", index],
        message: "The protocol owns the claimed task completion operation",
      });
    }
  });
});

export const claimTaskResultSchema = z.object({
  claim: taskClaimSchema,
  readiness: readyTaskSchema,
  contextPack: taskContextPackSchema,
}).strict();
export const renewClaimResultSchema = z.object({ claim: taskClaimSchema }).strict();
export const checkpointResultSchema = z.object({
  claim: taskClaimSchema,
  checkpoint: taskCheckpointSchema,
}).strict();
export const transitionClaimResultSchema = z.object({ claim: taskClaimSchema }).strict();
export const switchTaskResultSchema = z.object({
  previousClaim: taskClaimSchema,
  nextClaim: taskClaimSchema,
  checkpoint: taskCheckpointSchema,
  contextPack: taskContextPackSchema,
}).strict();
export const delegationResultSchema = z.object({ delegation: taskDelegationSchema }).strict();
export const submissionResultSchema = z.object({
  claim: taskClaimSchema,
  submission: taskSubmissionSchema,
  proposal: changeProposalSchema,
}).strict();
