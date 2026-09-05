import { z } from "zod";
import { GovernanceError } from "./errors.js";
import { projectRecordSchema, recordRelationshipSchema } from "./schemas.js";

const nonEmptyString = z.string().trim().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

export const proposalSubmissionResultSchema = z.union([
  z.object({
    outcome: z.literal("proposed"), changeId: nonEmptyString,
    proposalId: nonEmptyString, state: z.literal("pending"), replayed: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("conflicted"), changeId: nonEmptyString,
    proposalId: nonEmptyString, state: z.literal("conflicted"),
    currentProjectRevision: nonNegativeInteger, replayed: z.boolean(),
  }).strict(),
]);

const appliedOperationResultSchema = z.discriminatedUnion("type", [
  z.object({ operationId: nonEmptyString, type: z.literal("create_record"), record: projectRecordSchema }).strict(),
  z.object({ operationId: nonEmptyString, type: z.literal("update_record"), record: projectRecordSchema }).strict(),
  z.object({ operationId: nonEmptyString, type: z.literal("create_relationship"), relationship: recordRelationshipSchema }).strict(),
  z.object({ operationId: nonEmptyString, type: z.literal("remove_relationship"), relationship: recordRelationshipSchema }).strict(),
]);

export const appliedDirectResultSchema = z.object({
  outcome: z.literal("applied"), changeId: nonEmptyString, projectId: nonEmptyString,
  revisionBefore: nonNegativeInteger, revisionAfter: nonNegativeInteger,
  operations: z.array(appliedOperationResultSchema), replayed: z.boolean(),
}).strict();

export const appliedProposalResultSchema = z.object({
  outcome: z.literal("applied"), changeId: nonEmptyString, proposalId: nonEmptyString,
  projectRevision: nonNegativeInteger, operations: z.array(appliedOperationResultSchema),
  replayed: z.boolean(),
}).strict();

export const storedProposalRejectionResultSchema = z.object({
  outcome: z.literal("rejected"), changeId: nonEmptyString,
  code: z.literal("operation_denied"), reason: nonEmptyString, replayed: z.literal(false),
}).strict();

export const submissionRejectionResultSchema = z.object({
  outcome: z.literal("rejected"), changeId: nonEmptyString,
  code: z.literal("project_authority_missing"),
  reason: z.literal("project_authority_missing"), replayed: z.boolean(),
}).strict();

export const directConflictResultSchema = z.object({
  outcome: z.literal("conflicted"), changeId: nonEmptyString,
  code: z.enum(["project_revision_conflict", "record_revision_conflict"]),
  currentProjectRevision: nonNegativeInteger,
  expectedProjectRevision: nonNegativeInteger.optional(), recordId: nonEmptyString.optional(),
  expectedRecordRevision: positiveInteger.optional(), actualRecordRevision: nonNegativeInteger.optional(),
  replayed: z.boolean(),
}).strict();

export const storedSubmissionResultSchema = z.union([
  proposalSubmissionResultSchema,
  appliedProposalResultSchema,
  appliedDirectResultSchema,
  directConflictResultSchema,
  storedProposalRejectionResultSchema,
  submissionRejectionResultSchema,
]);

export type StoredSubmissionResult = z.infer<typeof storedSubmissionResultSchema>;

export const parseStoredSubmissionResult = (
  resultJson: string,
): StoredSubmissionResult => {
  try {
    const parsed = storedSubmissionResultSchema.safeParse(JSON.parse(resultJson));
    if (parsed.success) return parsed.data;
  } catch {
    // A stored result is untrusted persistence data.
  }
  throw new GovernanceError("internal_error", "Stored change result is corrupt");
};
