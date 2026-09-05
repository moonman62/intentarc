import { z } from "zod";
import type {
  BinaryCollection,
  ImportApplyResult,
  ImportExclusion,
  ImportExclusionReason,
  ImportInspectionActiveTaskSummary,
  ImportInspectionClaimSummary,
  ImportInspectionCounts,
  ImportInspection,
  ImportInspectionRecordKindCount,
  ImportInspectionRecordStatusCount,
  ImportInspectionRecordSummary,
  ImportInspectionRelationshipSummary,
  ImportInspectionSourceKindCount,
  ImportSensitiveFindingSummary,
  ImportWarning,
  ImportWarningCode,
  ProposedImportRecord,
  ProposedImportRelationship,
  RepositoryImportManifest,
  RepositoryImportSource,
  RepositorySourceRole,
  SensitiveContentFindingCategory,
  SensitiveContentFindingSeverity,
} from "./import-model.js";
import type { RecordKind, RecordStatus, RelationshipKind, SourceKind } from "./model.js";
import {
  MAX_REPOSITORY_REFERENCE_LENGTH,
  REPOSITORY_ROOT_REFERENCE,
} from "./import-model.js";
import {
  recordKindSchema,
  recordStatusSchema,
  relationshipKindSchema,
  sourceKindSchema,
} from "./schemas.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonEmptyStringSchema = z.string().min(1);
const canonicalNonEmptyStringSchema = z.string().min(1).refine(
  (value) => value === value.trim(),
  { message: "Value must use canonical surrounding whitespace" },
);
const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be blank",
});
const manifestLocalKeySchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const isNormalizedRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

const normalizedRelativePathSchema = z.string().refine(isNormalizedRelativePath, {
  message: "Path must be a normalized relative path",
});
const repositoryReferenceSchema = z.string()
  .max(MAX_REPOSITORY_REFERENCE_LENGTH)
  .refine(
    (value) =>
      value === REPOSITORY_ROOT_REFERENCE ||
      isNormalizedRelativePath(value),
    { message: "Repository reference must be normalized and bounded" },
  );
const absoluteRepositoryPathSchema = canonicalNonEmptyStringSchema.refine(
  (value) =>
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(value),
  { message: "Repository path must be absolute" },
);

const repositorySourceRoleSchema: z.ZodType<RepositorySourceRole> = z.enum([
  "canonical_source",
  "supporting_document",
  "test",
  "tool",
  "asset",
  "archived_source",
]);

const importWarningCodeSchema: z.ZodType<ImportWarningCode> = z.enum([
  "working_tree_dirty",
  "untracked_document",
  "multiple_worktrees",
  "handoff_drift",
  "large_binary_collection",
]);

const importExclusionReasonSchema: z.ZodType<ImportExclusionReason> = z.enum([
  "hard_exclusion",
  "ignored",
  "unsupported_text",
  "oversized_text",
  "link_not_followed",
  "untracked_not_eligible",
  "known_secret_path",
]);

const extractionSchema = z.object({
  title: z.string().nullable(),
  headings: z.array(z.string()),
}).strict();

export const repositoryImportSourceSchema: z.ZodType<RepositoryImportSource> = z.object({
  path: normalizedRelativePathSchema,
  status: z.enum(["tracked", "untracked"]),
  role: repositorySourceRoleSchema,
  byteSize: nonNegativeIntegerSchema,
  sha256: sha256Schema,
  extraction: extractionSchema,
}).strict();

export const binaryCollectionSchema: z.ZodType<BinaryCollection> = z.object({
  directory: z.union([z.literal(""), normalizedRelativePathSchema]),
  role: repositorySourceRoleSchema,
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  count: nonNegativeIntegerSchema,
  byteSize: nonNegativeIntegerSchema,
}).strict();

export const importWarningSchema: z.ZodType<ImportWarning> = z.object({
  code: importWarningCodeSchema,
  count: nonNegativeIntegerSchema,
}).strict();

export const importExclusionSchema: z.ZodType<ImportExclusion> = z.object({
  path: normalizedRelativePathSchema.nullable(),
  reason: importExclusionReasonSchema,
  count: nonNegativeIntegerSchema,
}).strict().superRefine((exclusion, context) => {
  if (exclusion.reason === "known_secret_path" && exclusion.path !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["path"],
      message: "Known secret exclusions must not retain a path",
    });
  }
});

export const proposedImportRecordSchema: z.ZodType<ProposedImportRecord> = z.object({
  key: manifestLocalKeySchema,
  kind: recordKindSchema,
  status: recordStatusSchema,
  title: canonicalNonEmptyStringSchema,
  body: canonicalNonEmptyStringSchema,
  sourceKind: z.enum(["repository", "agent", "import"]),
  sourceRef: repositoryReferenceSchema.nullable(),
  sourceRefs: z.array(repositoryReferenceSchema).refine(
    (sourceRefs) => new Set(sourceRefs).size === sourceRefs.length,
    { message: "Source references must be unique" },
  ),
  curationReason: canonicalNonEmptyStringSchema.max(4_096).nullable(),
}).strict().superRefine((record, context) => {
  if (
    (record.sourceRefs.length === 0 && record.sourceRef !== null) ||
    (record.sourceRefs.length > 0 &&
      record.sourceRef !== record.sourceRefs[0])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRef"],
      message: "Primary source reference must be the first source reference",
    });
  }
  if (
    record.sourceKind === "repository" &&
    (
      record.sourceRefs.length === 0 ||
      record.sourceRef === null ||
      record.curationReason !== null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceKind"],
      message: "Repository records require direct evidence only",
    });
  }
  if (
    record.sourceKind !== "repository" &&
    record.curationReason === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["curationReason"],
      message: "Curated records require a curation reason",
    });
  }
  if (
    record.sourceRef === null &&
    record.sourceRefs.length === 0 &&
    record.curationReason === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["curationReason"],
      message: "Records require source references or a curation reason",
    });
  }
});

export const proposedImportRelationshipSchema: z.ZodType<ProposedImportRelationship> = z.object({
  fromKey: manifestLocalKeySchema,
  toKey: manifestLocalKeySchema,
  kind: relationshipKindSchema,
}).strict();

const repositorySchema = z.object({
  root: absoluteRepositoryPathSchema,
  canonicalSubpath: normalizedRelativePathSchema.nullable(),
  branch: canonicalNonEmptyStringSchema.nullable(),
  head: gitHeadSchema,
  fingerprint: sha256Schema,
}).strict();

const discoverySchema = z.object({
  sources: z.array(repositoryImportSourceSchema),
  binaryCollections: z.array(binaryCollectionSchema),
  warnings: z.array(importWarningSchema),
  exclusions: z.array(importExclusionSchema),
}).strict();

const proposalSchema = z.object({
  project: z.object({
    name: canonicalNonEmptyStringSchema,
    primaryRepositoryPath: absoluteRepositoryPathSchema,
  }).strict(),
  records: z.array(proposedImportRecordSchema),
  relationships: z.array(proposedImportRelationshipSchema),
}).strict();

export const repositoryImportManifestSchema: z.ZodType<RepositoryImportManifest> = z.object({
  manifestVersion: z.literal(1),
  scannerVersion: z.literal("1"),
  rulesetVersion: z.literal("1"),
  createdAt: z.iso.datetime(),
  repository: repositorySchema,
  discovery: discoverySchema,
  proposal: proposalSchema,
}).strict().superRefine((manifest, context) => {
  if (
    manifest.proposal.project.primaryRepositoryPath !==
      manifest.repository.root
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal", "project", "primaryRepositoryPath"],
      message: "Primary repository path must match the discovered root",
    });
  }

  const approvedRepositoryReferences = new Set([
    ...manifest.discovery.sources.map(({ path }) => path),
    ...manifest.discovery.binaryCollections.map(({ directory }) =>
      directory === "" ? REPOSITORY_ROOT_REFERENCE : directory
    ),
  ]);
  const recordKeys = new Set<string>();
  manifest.proposal.records.forEach((record, index) => {
    if (recordKeys.has(record.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal", "records", index, "key"],
        message: "Record keys must be unique",
      });
    }
    recordKeys.add(record.key);
    record.sourceRefs.forEach((sourceRef, sourceIndex) => {
      if (!approvedRepositoryReferences.has(sourceRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "proposal",
            "records",
            index,
            "sourceRefs",
            sourceIndex,
          ],
          message: "Source reference must match discovered repository evidence",
        });
      }
    });
  });

  const relationshipTuples = new Set<string>();
  manifest.proposal.relationships.forEach((relationship, index) => {
    const tuple = `${relationship.fromKey}\u0000${relationship.toKey}\u0000${relationship.kind}`;
    if (relationshipTuples.has(tuple)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal", "relationships", index],
        message: "Relationship tuples must be unique",
      });
    }
    relationshipTuples.add(tuple);

    if (!recordKeys.has(relationship.fromKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal", "relationships", index, "fromKey"],
        message: "Relationship fromKey must reference a proposed record",
      });
    }
    if (!recordKeys.has(relationship.toKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal", "relationships", index, "toKey"],
        message: "Relationship toKey must reference a proposed record",
      });
    }
    if (relationship.fromKey === relationship.toKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal", "relationships", index, "toKey"],
        message: "Relationships must link different records",
      });
    }
  });
});

const inspectionRecordSummarySchema: z.ZodType<ImportInspectionRecordSummary> = z.object({
  key: manifestLocalKeySchema,
  kind: recordKindSchema,
  status: recordStatusSchema,
  title: nonEmptyStringSchema,
  sourceKind: sourceKindSchema,
  sourceRef: nonBlankStringSchema.nullable(),
}).strict();

const inspectionRelationshipSummarySchema: z.ZodType<ImportInspectionRelationshipSummary> = z.object({
  fromKey: manifestLocalKeySchema,
  toKey: manifestLocalKeySchema,
  kind: relationshipKindSchema,
}).strict();

const inspectionActiveTaskSummarySchema: z.ZodType<ImportInspectionActiveTaskSummary> = z.object({
  key: manifestLocalKeySchema,
  kind: z.literal("task"),
  status: z.literal("active"),
  title: nonEmptyStringSchema,
  sourceKind: sourceKindSchema,
  sourceRef: nonBlankStringSchema.nullable(),
  directLinks: z.array(inspectionRelationshipSummarySchema),
}).strict();

const inspectionClaimSummarySchema: z.ZodType<ImportInspectionClaimSummary> = z.object({
  key: manifestLocalKeySchema,
  kind: recordKindSchema,
  status: recordStatusSchema,
  title: nonEmptyStringSchema,
  sourceKind: sourceKindSchema,
  curationReason: nonBlankStringSchema.nullable(),
}).strict().superRefine((claim, context) => {
  if (claim.status !== "provisional" && claim.curationReason === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["curationReason"],
      message: "Claims must be provisional or include a curation reason",
    });
  }
});

const sensitiveContentFindingCategorySchema: z.ZodType<SensitiveContentFindingCategory> = z.enum([
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
]);

const sensitiveContentFindingSeveritySchema: z.ZodType<SensitiveContentFindingSeverity> = z.enum([
  "credential",
  "sensitive",
]);

const sensitiveFindingSummarySchema: z.ZodType<ImportSensitiveFindingSummary> = z.object({
  category: sensitiveContentFindingCategorySchema,
  severity: sensitiveContentFindingSeveritySchema,
  count: nonNegativeIntegerSchema,
}).strict();

const inspectionRecordKindCountSchema: z.ZodType<ImportInspectionRecordKindCount> = z.object({
  kind: recordKindSchema,
  count: nonNegativeIntegerSchema,
}).strict();

const inspectionRecordStatusCountSchema: z.ZodType<ImportInspectionRecordStatusCount> = z.object({
  status: recordStatusSchema,
  count: nonNegativeIntegerSchema,
}).strict();

const inspectionSourceKindCountSchema: z.ZodType<ImportInspectionSourceKindCount> = z.object({
  sourceKind: sourceKindSchema,
  count: nonNegativeIntegerSchema,
}).strict();

const inspectionCountsSchema: z.ZodType<ImportInspectionCounts> = z.object({
  recordsByKind: z.array(inspectionRecordKindCountSchema),
  recordsByStatus: z.array(inspectionRecordStatusCountSchema),
  recordsBySourceKind: z.array(inspectionSourceKindCountSchema),
}).strict();

export const importInspectionSchema: z.ZodType<ImportInspection> = z.object({
  manifestDigest: sha256Schema,
  repository: repositorySchema,
  project: proposalSchema.shape.project,
  counts: inspectionCountsSchema,
  stableFrame: z.array(inspectionRecordSummarySchema),
  activeTasks: z.array(inspectionActiveTaskSummarySchema),
  curatedOrProvisionalClaims: z.array(inspectionClaimSummarySchema),
  sensitiveFindings: z.array(sensitiveFindingSummarySchema),
  warnings: z.array(importWarningSchema),
  exclusions: z.array(importExclusionSchema),
}).strict();

export const importApplyResultSchema: z.ZodType<ImportApplyResult> = z.object({
  projectId: nonEmptyStringSchema,
  manifestDigest: sha256Schema,
  repositoryFingerprint: sha256Schema,
  revisionBefore: nonNegativeIntegerSchema,
  revisionAfter: nonNegativeIntegerSchema,
  replayed: z.boolean(),
}).strict();

export const importRecordKindSchema: z.ZodType<RecordKind> = recordKindSchema;
export const importRecordStatusSchema: z.ZodType<RecordStatus> = recordStatusSchema;
export const importSourceKindSchema: z.ZodType<SourceKind> = sourceKindSchema;
export const importRelationshipKindSchema: z.ZodType<RelationshipKind> = relationshipKindSchema;
