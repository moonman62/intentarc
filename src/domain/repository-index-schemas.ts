import { z } from "zod";
import type {
  DocumentRegistryEntry,
  RepositoryDiffEntry,
  RepositoryDiffGroup,
  RepositoryDiffKind,
  RepositoryDocumentFormat,
  RepositoryDocumentFreshness,
  RepositoryDocumentKind,
  RepositoryLink,
  RepositoryLinkBasis,
  RepositoryLinkInput,
  RepositoryLinkKind,
  RepositoryLinkSummary,
  RepositoryNode,
  RepositoryNodeKind,
  RepositoryNodeObservation,
  RepositoryObservationCandidate,
  RepositoryObservationInput,
  RepositoryObservationSourceStatus,
  RepositoryRefreshReview,
  RepositoryRefreshReviewState,
  RepositoryScanPhase,
  RepositoryScanProgress,
  RepositorySnapshot,
  RepositorySnapshotDiff,
  RepositorySnapshotState,
  RepositorySource,
  RepositorySourceStatus,
} from "./repository-index-model.js";
import type { ChangeOperation } from "./governance-model.js";
import type { RepositorySourceRole } from "./import-model.js";
import { changeOperationSchema } from "./governance-schemas.js";
import { importExclusionSchema, importWarningSchema } from "./import-schemas.js";

const canonicalNonEmptyStringSchema = z.string().min(1).refine(
  (value) => value === value.trim(),
  { message: "Value must use canonical surrounding whitespace" },
);
const nonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable();
const timestampSchema = z.iso.datetime();
const countMapSchema = z.record(
  canonicalNonEmptyStringSchema,
  nonNegativeIntegerSchema,
);

const isNormalizedRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );

export const normalizedRepositoryPathSchema = z.string().refine(
  isNormalizedRelativePath,
  { message: "Path must be a normalized relative path" },
);

export const absoluteRepositoryRootSchema = canonicalNonEmptyStringSchema.refine(
  (value) =>
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(value),
  { message: "Repository root must be absolute" },
);

export const repositorySourceStatusSchema: z.ZodType<RepositorySourceStatus> = z.enum([
  "available",
  "unavailable",
  "detached",
]);
export const repositorySnapshotStateSchema: z.ZodType<RepositorySnapshotState> = z.enum([
  "candidate",
  "accepted",
  "discarded",
]);
export const repositoryNodeKindSchema: z.ZodType<RepositoryNodeKind> = z.enum([
  "directory",
  "file",
]);
export const repositoryDocumentKindSchema: z.ZodType<RepositoryDocumentKind> = z.enum([
  "overview",
  "specification",
  "decision_support",
  "operational_guide",
  "test_evidence",
  "ai_instruction",
  "unlinked",
]);
export const repositoryDocumentFormatSchema: z.ZodType<RepositoryDocumentFormat> = z.enum([
  "markdown",
  "plain_text",
  "image",
  "pdf",
  "unsupported",
]);
export const repositoryLinkBasisSchema: z.ZodType<RepositoryLinkBasis> = z.enum([
  "accepted",
  "observed",
  "inferred",
  "conflicting",
]);
export const repositoryLinkKindSchema: z.ZodType<RepositoryLinkKind> = z.enum([
  "documents",
  "implements",
  "evidences",
  "related_to",
]);
export const repositoryDiffKindSchema: z.ZodType<RepositoryDiffKind> = z.enum([
  "added",
  "changed",
  "moved",
  "removed",
  "unchanged",
  "excluded",
  "conflicted",
]);
export const repositoryObservationSourceStatusSchema: z.ZodType<RepositoryObservationSourceStatus> = z.enum([
  "tracked",
  "untracked",
  "derived",
]);
export const repositoryScanPhaseSchema: z.ZodType<RepositoryScanPhase> = z.enum([
  "discovering",
  "hashing",
  "classifying",
  "finalizing",
]);
export const repositoryRefreshReviewStateSchema: z.ZodType<RepositoryRefreshReviewState> = z.enum([
  "pending",
  "applied",
  "cancelled",
  "conflicted",
]);
export const repositoryDocumentFreshnessSchema: z.ZodType<RepositoryDocumentFreshness> = z.enum([
  "current",
  "stale",
  "missing",
  "unavailable",
  "blocked",
]);

const repositorySourceRoleSchema: z.ZodType<RepositorySourceRole> = z.enum([
  "canonical_source",
  "supporting_document",
  "test",
  "tool",
  "asset",
  "archived_source",
]);

export const repositorySourceSchema: z.ZodType<RepositorySource> = z.object({
  id: canonicalNonEmptyStringSchema,
  projectId: canonicalNonEmptyStringSchema,
  root: absoluteRepositoryRootSchema,
  canonicalSubpath: normalizedRepositoryPathSchema.nullable(),
  repositoryIdentity: canonicalNonEmptyStringSchema,
  status: repositorySourceStatusSchema,
  currentSnapshotId: canonicalNonEmptyStringSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const repositorySnapshotSchema: z.ZodType<RepositorySnapshot> = z.object({
  id: canonicalNonEmptyStringSchema,
  sourceId: canonicalNonEmptyStringSchema,
  projectId: canonicalNonEmptyStringSchema,
  state: repositorySnapshotStateSchema,
  baseSnapshotId: canonicalNonEmptyStringSchema.nullable(),
  baseProjectRevision: nonNegativeIntegerSchema,
  branch: canonicalNonEmptyStringSchema.nullable(),
  head: gitHeadSchema,
  fingerprint: sha256Schema,
  scannerVersion: canonicalNonEmptyStringSchema,
  rulesetVersion: canonicalNonEmptyStringSchema,
  warningCounts: countMapSchema,
  exclusionCounts: countMapSchema,
  findingCounts: countMapSchema,
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  appliedAt: timestampSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  const validLifecycle =
    (snapshot.state === "candidate" && snapshot.decidedAt === null && snapshot.appliedAt === null) ||
    (snapshot.state === "accepted" && snapshot.decidedAt !== null && snapshot.appliedAt !== null) ||
    (snapshot.state === "discarded" && snapshot.decidedAt !== null && snapshot.appliedAt === null);
  if (!validLifecycle) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "Snapshot timestamps must match its lifecycle state",
    });
  }
});

export const repositoryNodeSchema: z.ZodType<RepositoryNode> = z.object({
  id: canonicalNonEmptyStringSchema,
  sourceId: canonicalNonEmptyStringSchema,
  kind: repositoryNodeKindSchema,
  createdAt: timestampSchema,
}).strict();

const observationShape = {
  path: normalizedRepositoryPathSchema,
  kind: repositoryNodeKindSchema,
  sha256: sha256Schema.nullable(),
  byteSize: nonNegativeIntegerSchema,
  sourceStatus: repositoryObservationSourceStatusSchema,
  role: repositorySourceRoleSchema,
  documentKind: repositoryDocumentKindSchema.nullable(),
  documentFormat: repositoryDocumentFormatSchema.nullable(),
  contentEligible: z.boolean(),
  instructionClient: canonicalNonEmptyStringSchema.nullable(),
  instructionScope: canonicalNonEmptyStringSchema.nullable(),
} as const;

const addObservationIssues = (
  observation: RepositoryObservationInput,
  context: z.RefinementCtx,
): void => {
  if (observation.kind === "file" && observation.sha256 === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sha256"],
      message: "File observations require a SHA-256 hash",
    });
  }
  if (observation.kind === "directory" && observation.sha256 !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sha256"],
      message: "Directory observations cannot have a content hash",
    });
  }
  if (observation.kind === "directory" && (
    observation.byteSize !== 0 ||
    observation.sourceStatus !== "derived" ||
    observation.documentKind !== null ||
    observation.documentFormat !== null ||
    observation.contentEligible
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "Directory observations contain derived metadata only",
    });
  }
  const isInstruction = observation.documentKind === "ai_instruction";
  if (isInstruction !== (
    observation.instructionClient !== null && observation.instructionScope !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["instructionClient"],
      message: "AI instruction labels apply only to AI instruction documents",
    });
  }
  if (observation.documentKind !== null && observation.documentFormat === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["documentFormat"],
      message: "Classified documents require a document format",
    });
  }
};

export const repositoryObservationInputSchema: z.ZodType<RepositoryObservationInput> = z.object(
  observationShape,
).strict().superRefine(addObservationIssues);

export const repositoryNodeObservationSchema: z.ZodType<RepositoryNodeObservation> = z.object({
  snapshotId: canonicalNonEmptyStringSchema,
  nodeId: canonicalNonEmptyStringSchema,
  parentNodeId: canonicalNonEmptyStringSchema.nullable(),
  ...observationShape,
}).strict().superRefine(addObservationIssues);

const addExactlyOneTargetIssue = (
  target: { toRecordId: string | null; toNodeId: string | null },
  context: z.RefinementCtx,
): void => {
  if ((target.toRecordId === null) === (target.toNodeId === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toRecordId"],
      message: "Repository links require exactly one target",
    });
  }
};

export const repositoryLinkSchema: z.ZodType<RepositoryLink> = z.object({
  id: canonicalNonEmptyStringSchema,
  projectId: canonicalNonEmptyStringSchema,
  snapshotId: canonicalNonEmptyStringSchema,
  fromNodeId: canonicalNonEmptyStringSchema,
  toRecordId: canonicalNonEmptyStringSchema.nullable(),
  toNodeId: canonicalNonEmptyStringSchema.nullable(),
  kind: repositoryLinkKindSchema,
  basis: repositoryLinkBasisSchema,
  createdAt: timestampSchema,
}).strict().superRefine(addExactlyOneTargetIssue);

export const repositoryLinkInputSchema: z.ZodType<RepositoryLinkInput> = z.object({
  fromPath: normalizedRepositoryPathSchema,
  toRecordId: canonicalNonEmptyStringSchema.nullable(),
  toPath: normalizedRepositoryPathSchema.nullable(),
  kind: repositoryLinkKindSchema,
  basis: repositoryLinkBasisSchema,
}).strict().superRefine((link, context) => {
  if ((link.toRecordId === null) === (link.toPath === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toRecordId"],
      message: "Repository link inputs require exactly one target",
    });
  }
});

export const repositoryObservationCandidateSchema: z.ZodType<RepositoryObservationCandidate> = z.object({
  root: absoluteRepositoryRootSchema,
  canonicalSubpath: normalizedRepositoryPathSchema.nullable(),
  repositoryIdentity: canonicalNonEmptyStringSchema,
  branch: canonicalNonEmptyStringSchema.nullable(),
  head: gitHeadSchema,
  fingerprint: sha256Schema,
  scannerVersion: canonicalNonEmptyStringSchema,
  rulesetVersion: canonicalNonEmptyStringSchema,
  warnings: z.array(importWarningSchema),
  exclusions: z.array(importExclusionSchema),
  findingCounts: countMapSchema,
  renameEvidence: z.array(z.object({
    originalPath: normalizedRepositoryPathSchema,
    path: normalizedRepositoryPathSchema,
  }).strict()).optional(),
  observations: z.array(repositoryObservationInputSchema),
  links: z.array(repositoryLinkInputSchema),
}).strict().superRefine((candidate, context) => {
  const paths = new Set<string>();
  candidate.observations.forEach((observation, index) => {
    if (paths.has(observation.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observations", index, "path"],
        message: "Candidate observation paths must be unique",
      });
    }
    paths.add(observation.path);
  });
  candidate.links.forEach((link, index) => {
    if (!paths.has(link.fromPath) || (link.toPath !== null && !paths.has(link.toPath))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["links", index],
        message: "Candidate links must reference candidate observation paths",
      });
    }
  });
});

export const repositoryDiffEntrySchema: z.ZodType<RepositoryDiffEntry> = z.object({
  operationId: canonicalNonEmptyStringSchema,
  kind: repositoryDiffKindSchema,
  previousNodeId: canonicalNonEmptyStringSchema.nullable(),
  currentNodeId: canonicalNonEmptyStringSchema.nullable(),
  previousPath: normalizedRepositoryPathSchema.nullable(),
  currentPath: normalizedRepositoryPathSchema.nullable(),
}).strict().superRefine((entry, context) => {
  if (entry.previousPath === null && entry.currentPath === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currentPath"],
      message: "Diff entries require a prior or current path",
    });
  }
});

export const repositoryDiffGroupSchema: z.ZodType<RepositoryDiffGroup> = z.object({
  kind: repositoryDiffKindSchema,
  entries: z.array(repositoryDiffEntrySchema),
}).strict().superRefine((group, context) => {
  group.entries.forEach((entry, index) => {
    if (entry.kind !== group.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "kind"],
        message: "Diff entry kind must match its group",
      });
    }
  });
});

export const repositorySnapshotDiffSchema: z.ZodType<RepositorySnapshotDiff> = z.object({
  groups: z.array(repositoryDiffGroupSchema),
  semanticOperations: z.array(changeOperationSchema) as z.ZodType<ChangeOperation[]>,
}).strict().superRefine((diff, context) => {
  const groupKinds = new Set<RepositoryDiffKind>();
  const operationIds = new Set<string>();
  diff.groups.forEach((group, groupIndex) => {
    if (groupKinds.has(group.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", groupIndex, "kind"],
        message: "Diff group kinds must be unique",
      });
    }
    groupKinds.add(group.kind);
    group.entries.forEach((entry, entryIndex) => {
      if (operationIds.has(entry.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", groupIndex, "entries", entryIndex, "operationId"],
          message: "Diff operation identifiers must be unique",
        });
      }
      operationIds.add(entry.operationId);
    });
  });
});

export const repositoryScanProgressSchema: z.ZodType<RepositoryScanProgress> = z.object({
  phase: repositoryScanPhaseSchema,
  processed: nonNegativeIntegerSchema,
  total: nonNegativeIntegerSchema,
}).strict().superRefine((progress, context) => {
  if (progress.processed > progress.total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["processed"],
      message: "Processed count cannot exceed total count",
    });
  }
});

export const repositoryRefreshReviewSchema: z.ZodType<RepositoryRefreshReview> = z.object({
  projectId: canonicalNonEmptyStringSchema,
  sourceId: canonicalNonEmptyStringSchema,
  snapshotId: canonicalNonEmptyStringSchema,
  state: repositoryRefreshReviewStateSchema,
  selectedOperationIds: z.array(canonicalNonEmptyStringSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
}).strict().superRefine((review, context) => {
  if (new Set(review.selectedOperationIds).size !== review.selectedOperationIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedOperationIds"],
      message: "Selected operation identifiers must be unique",
    });
  }
  if ((review.state === "pending") !== (review.decidedAt === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decidedAt"],
      message: "Review decision time must match its lifecycle state",
    });
  }
});

export const repositoryLinkSummarySchema: z.ZodType<RepositoryLinkSummary> = z.object({
  kind: repositoryLinkKindSchema,
  basis: repositoryLinkBasisSchema,
  toRecordId: canonicalNonEmptyStringSchema.nullable(),
  toNodeId: canonicalNonEmptyStringSchema.nullable(),
}).strict().superRefine(addExactlyOneTargetIssue);

export const documentRegistryEntrySchema: z.ZodType<DocumentRegistryEntry> = z.object({
  projectId: canonicalNonEmptyStringSchema,
  snapshotId: canonicalNonEmptyStringSchema,
  nodeId: canonicalNonEmptyStringSchema,
  path: normalizedRepositoryPathSchema,
  documentKind: repositoryDocumentKindSchema,
  documentFormat: repositoryDocumentFormatSchema,
  role: repositorySourceRoleSchema,
  freshness: repositoryDocumentFreshnessSchema,
  contentEligible: z.boolean(),
  instructionClient: canonicalNonEmptyStringSchema.nullable(),
  instructionScope: canonicalNonEmptyStringSchema.nullable(),
  links: z.array(repositoryLinkSummarySchema),
}).strict().superRefine((entry, context) => {
  const isInstruction = entry.documentKind === "ai_instruction";
  if (isInstruction !== (
    entry.instructionClient !== null && entry.instructionScope !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["instructionClient"],
      message: "AI instruction labels apply only to AI instruction documents",
    });
  }
});
