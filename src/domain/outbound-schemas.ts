import { z } from "zod";
import type {
  GetReleasedContextResult,
  OutboundDataBoundary,
  OutboundDestination,
  OutboundDestinationSnapshot,
  OutboundDestinationType,
  OutboundDisclosure,
  OutboundFinding,
  OutboundFindingAction,
  OutboundFindingCounts,
  OutboundFindingDecision,
  OutboundInspection,
  OutboundRelease,
  OutboundRequestStatus,
  OutboundRequestSummary,
  RequestTaskContextInput,
} from "./outbound-model.js";
import {
  contextOmissionSchema,
  recordKindSchema,
  sourceReferenceSchema,
  sourceKindSchema,
  taskContextPackSchema,
} from "./schemas.js";

const identifierSchema = z.string().trim().min(1).max(200);
const labelSchema = z.string().trim().min(1).max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const timestampSchema = z.iso.datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fieldPathSchema = z.string().regex(/^\/(?:[^/~]|~0|~1)+(?:\/(?:[^/~]|~0|~1)+)*$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const outboundDestinationTypeSchema: z.ZodType<OutboundDestinationType> = z.enum([
  "local_model",
  "direct_provider",
  "gateway",
  "ide_managed",
  "unknown",
]);

export const outboundDataBoundarySchema: z.ZodType<OutboundDataBoundary> = z.enum([
  "local",
  "remote",
  "mixed",
  "unknown",
]);

export const outboundRequestStatusSchema: z.ZodType<OutboundRequestStatus> = z.enum([
  "review_required",
  "released",
  "denied",
]);

export const outboundFindingActionSchema: z.ZodType<OutboundFindingAction> = z.enum([
  "forced_redact",
  "redact_by_default",
]);

export const outboundFindingDecisionSchema: z.ZodType<OutboundFindingDecision> = z.enum([
  "redact",
  "include_once",
]);

export const outboundDestinationSchema: z.ZodType<OutboundDestination> = z.object({
  id: identifierSchema,
  profileId: identifierSchema,
  revision: positiveIntegerSchema,
  clientLabel: labelSchema,
  type: outboundDestinationTypeSchema,
  providerLabel: labelSchema,
  modelLabel: labelSchema.nullable(),
  accountBoundaryLabel: labelSchema.nullable(),
  dataBoundary: outboundDataBoundarySchema,
  status: z.enum(["enabled", "disabled"]),
  current: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const outboundDestinationSnapshotSchema: z.ZodType<OutboundDestinationSnapshot> = z.object({
  id: identifierSchema,
  revision: positiveIntegerSchema,
  clientLabel: labelSchema,
  type: outboundDestinationTypeSchema,
  providerLabel: labelSchema,
  modelLabel: labelSchema.nullable(),
  accountBoundaryLabel: labelSchema.nullable(),
  dataBoundary: outboundDataBoundarySchema,
}).strict();

export const outboundFindingSchema: z.ZodType<OutboundFinding> = z.object({
  id: identifierSchema,
  ordinal: nonNegativeIntegerSchema,
  detectorId: identifierSchema,
  detectorVersion: identifierSchema,
  category: z.enum([
    "private_key",
    "api_token",
    "authorization",
    "credential_uri",
    "secret_assignment",
    "high_entropy",
    "email",
    "phone",
    "network_address",
    "local_user_path",
  ]),
  confidence: z.enum(["high", "possible"]),
  severity: z.enum(["credential", "sensitive"]),
  path: fieldPathSchema,
  start: nonNegativeIntegerSchema,
  end: nonNegativeIntegerSchema,
  findingKey: identifierSchema,
  requiredAction: outboundFindingActionSchema,
  decision: outboundFindingDecisionSchema.nullable(),
}).strict().superRefine((finding, context) => {
  if (finding.end <= finding.start) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "Finding range must be non-empty",
    });
  }
  if (finding.requiredAction === "forced_redact" && finding.decision === "include_once") {
    context.addIssue({
      code: "custom",
      path: ["decision"],
      message: "Forced findings cannot be included",
    });
  }
});

export const outboundFindingCountsSchema: z.ZodType<OutboundFindingCounts> = z.object({
  total: nonNegativeIntegerSchema,
  credential: nonNegativeIntegerSchema,
  sensitive: nonNegativeIntegerSchema,
  forcedRedact: nonNegativeIntegerSchema,
  redactByDefault: nonNegativeIntegerSchema,
  redacted: nonNegativeIntegerSchema,
  includedOnce: nonNegativeIntegerSchema,
}).strict();

export const outboundDisclosureSchema: z.ZodType<OutboundDisclosure> = z.object({
  destination: outboundDestinationSnapshotSchema,
  sourcePackId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  projectRevision: nonNegativeIntegerSchema,
  sourceRecords: z.array(z.object({
    recordId: identifierSchema,
    kind: recordKindSchema,
    revision: positiveIntegerSchema,
    sourceKind: sourceKindSchema,
    sourceRef: sourceReferenceSchema.nullable(),
  }).strict()),
  omissions: z.array(contextOmissionSchema),
  requestedBudgetTokens: positiveIntegerSchema,
  originalEstimatedTokens: nonNegativeIntegerSchema,
  releasedEstimatedTokens: nonNegativeIntegerSchema,
  findingCounts: outboundFindingCountsSchema,
  detectorVersion: identifierSchema,
  safetyPolicyVersion: identifierSchema,
  releaseDigest: sha256Schema,
  releasedAt: timestampSchema,
}).strict();

export const outboundReleaseSchema: z.ZodType<OutboundRelease> = z.object({
  releaseId: identifierSchema,
  requestId: identifierSchema,
  sourcePackId: identifierSchema,
  releasedAt: timestampSchema,
  sha256: sha256Schema,
  disclosure: outboundDisclosureSchema,
  pack: taskContextPackSchema,
}).strict();

export const outboundRequestSummarySchema: z.ZodType<OutboundRequestSummary> = z.object({
  requestId: identifierSchema,
  profileId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  sourcePackId: identifierSchema,
  destination: outboundDestinationSnapshotSchema,
  status: outboundRequestStatusSchema,
  projectRevision: nonNegativeIntegerSchema,
  budgetTokens: positiveIntegerSchema,
  originalEstimatedTokens: nonNegativeIntegerSchema,
  findingCounts: outboundFindingCountsSchema,
  detectorVersion: identifierSchema,
  safetyPolicyVersion: identifierSchema,
  releaseId: identifierSchema.nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
}).strict();

export const outboundInspectionSchema: z.ZodType<OutboundInspection> = z.object({
  request: outboundRequestSummarySchema,
  findings: z.array(outboundFindingSchema),
  redactedPreview: taskContextPackSchema,
  prospectiveReleaseDigest: sha256Schema,
}).strict();

export const requestTaskContextInputSchema: z.ZodType<RequestTaskContextInput> = z.object({
  projectId: identifierSchema,
  taskId: identifierSchema,
  budgetTokens: positiveIntegerSchema,
  idempotencyKey: identifierSchema.max(128),
}).strict();

export const requestTaskContextResultSchema = outboundRequestSummarySchema;

export const getReleasedContextResultSchema: z.ZodType<GetReleasedContextResult> = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("released"), release: outboundReleaseSchema }).strict(),
    z.object({ status: z.literal("review_required"), request: outboundRequestSummarySchema }).strict(),
    z.object({ status: z.literal("denied"), request: outboundRequestSummarySchema }).strict(),
  ],
);

export const setOutboundDestinationInputSchema = z.object({
  profileId: identifierSchema,
  clientLabel: labelSchema,
  type: outboundDestinationTypeSchema,
  providerLabel: labelSchema,
  modelLabel: labelSchema.nullable(),
  accountBoundaryLabel: labelSchema.nullable(),
  dataBoundary: outboundDataBoundarySchema,
}).strict();

export const approveOutboundRequestInputSchema = z.object({
  requestId: identifierSchema,
  rememberClean: z.boolean(),
  includeFindingIds: z.array(identifierSchema).max(200).refine(
    (findingIds) => new Set(findingIds).size === findingIds.length,
    { message: "Finding inclusions must be unique" },
  ),
}).strict();

export const outboundRequestFilterSchema = z.object({
  profileId: identifierSchema.optional(),
  projectId: identifierSchema.optional(),
  status: outboundRequestStatusSchema.optional(),
}).strict();
