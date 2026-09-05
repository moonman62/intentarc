import { z } from "zod";
import {
  isHierarchyRecordKind,
  type ChangeOperation,
  type ImportApplyResult,
  type ImportInspection,
  type OutboundInspection,
  type OutboundRelease,
  type OutboundRequestSummary,
  type ProposalState,
  type ProposalOrigin,
  type RepositoryImportManifest,
} from "../domain/index.js";
import type {
  DashboardHierarchyKind,
  ProjectDashboardView,
  ProjectHubView,
  TaskHandoffView,
} from "../core/project-view-service.js";
import {
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  checkpointResultSchema,
  claimTaskInputSchema,
  claimTaskResultSchema,
  coordinationStateSchema,
  createDelegationInputSchema,
  delegationResultSchema,
  opaqueCoordinationCursorSchema,
  readyTaskPageSchema,
  renewClaimInputSchema,
  renewClaimResultSchema,
  revokeDelegationInputSchema,
  submissionResultSchema,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  switchTaskResultSchema,
  transitionClaimInputSchema,
  transitionClaimResultSchema,
} from "../domain/coordination-schemas.js";
import {
  projectSchema,
  projectRecordSchema,
  hierarchyVocabularySchema,
  recordKindSchema,
  recordStatusSchema,
  relationshipKindSchema,
  sourceKindSchema,
} from "../domain/schemas.js";
import {
  documentRegistryEntrySchema,
  normalizedRepositoryPathSchema,
  repositoryDocumentFormatSchema,
  repositoryDocumentFreshnessSchema,
  repositoryDocumentKindSchema,
  repositoryLinkBasisSchema,
  repositoryLinkKindSchema,
  repositoryLinkSummarySchema,
  repositoryNodeKindSchema,
  repositoryScanProgressSchema,
  repositorySnapshotDiffSchema,
} from "../domain/repository-index-schemas.js";

export interface ProjectHubResponse {
  projects: ProjectHubView[];
}

export type HubProject = ProjectHubView;
export type ProjectDashboardResponse = ProjectDashboardView;
export type TaskHandoffResponse = TaskHandoffView;

const dashboardRecordSchema = projectRecordSchema.extend({
  body: z.string(),
});

const projectFocusPathSegmentSchema = projectRecordSchema.pick({
  id: true,
  projectId: true,
  kind: true,
  status: true,
  title: true,
});

const dashboardHierarchyKindSchema: z.ZodType<DashboardHierarchyKind> = z.enum([
  "outcome",
  "initiative",
  "deliverable",
  "milestone",
  "task",
]);

const dashboardHierarchyParentContextSchema = z.object({
  recordId: z.string().min(1).refine((value) => value === value.trim(), {
    message: "Dashboard hierarchy context record IDs must not contain surrounding whitespace",
  }),
  parentKind: dashboardHierarchyKindSchema.nullable(),
}).strict();

export const projectDashboardResponseSchema: z.ZodType<ProjectDashboardResponse> = z
  .object({
    project: projectSchema,
    hierarchyVocabulary: hierarchyVocabularySchema,
    hierarchyParentContexts: z.array(dashboardHierarchyParentContextSchema),
    recordsByKind: z.partialRecord(
      recordKindSchema,
      z.number().int().nonnegative(),
    ),
    currentOutcome: dashboardRecordSchema.nullable(),
    currentTask: dashboardRecordSchema.nullable(),
    currentFocusPath: z.array(projectFocusPathSegmentSchema),
    attention: dashboardRecordSchema.nullable(),
    pendingProposalCount: z.number().int().nonnegative(),
    recentRecords: z.array(dashboardRecordSchema),
  })
  .strict()
  .superRefine((dashboard, context) => {
    const records = [
      dashboard.currentOutcome,
      dashboard.currentTask,
      dashboard.attention,
      ...dashboard.recentRecords,
      ...dashboard.currentFocusPath,
    ].filter((record) => record !== null);
    for (const [index, record] of records.entries()) {
      if (record.projectId === dashboard.project.id) continue;
      context.addIssue({
        code: "custom",
        message: "Dashboard records must belong to the dashboard project",
        path: ["records", index, "projectId"],
      });
    }

    const hierarchyRecordIds = new Set(
      records
        .filter((record) => isHierarchyRecordKind(record.kind))
        .map((record) => record.id),
    );
    const contextRecordIds = new Set<string>();
    for (const [index, parentContext] of dashboard.hierarchyParentContexts.entries()) {
      if (contextRecordIds.has(parentContext.recordId)) {
        context.addIssue({
          code: "custom",
          message: "Dashboard hierarchy parent contexts must be unique",
          path: ["hierarchyParentContexts", index, "recordId"],
        });
      }
      contextRecordIds.add(parentContext.recordId);
      if (!hierarchyRecordIds.has(parentContext.recordId)) {
        context.addIssue({
          code: "custom",
          message: "Dashboard hierarchy parent contexts must identify projected hierarchy records",
          path: ["hierarchyParentContexts", index, "recordId"],
        });
      }
    }
    for (const recordId of hierarchyRecordIds) {
      if (contextRecordIds.has(recordId)) continue;
      context.addIssue({
        code: "custom",
        message: "Every projected hierarchy record requires parent context",
        path: ["hierarchyParentContexts"],
      });
    }
  });

export const projectDashboardResponseSchemaFor = (
  projectId: string,
): z.ZodType<ProjectDashboardResponse> => projectDashboardResponseSchema.refine(
  (dashboard) => dashboard.project.id === projectId,
  {
    message: "Dashboard project must match the requested project",
    path: ["project", "id"],
  },
);

export interface ImportScanResponse {
  manifest: RepositoryImportManifest;
  inspection: ImportInspection;
}

export interface ImportApplyResponse {
  result: ImportApplyResult;
}

export interface ContextRequestResponse {
  request: OutboundRequestSummary;
  inspection: OutboundInspection | null;
  release: OutboundRelease | null;
}

export interface BrowserChatExport {
  readonly filename: string;
  readonly mediaType: "text/markdown;charset=utf-8";
  readonly text: string;
}

export interface ReleasedContextResponse {
  release: OutboundRelease;
  export: BrowserChatExport;
}

export interface SanitizedProfileResponse {
  profiles: Array<{
    profileId: string;
    name: string;
    status: "enabled" | "disabled";
    executionMode: "safe" | "trusted" | "custom";
    projectIds: string[];
    lastUsedAt: string | null;
    hasDestination: boolean;
  }>;
}

export interface ProjectProfileSetupResponse {
  profileId: string;
  token: string | null;
  tokenShownOnce: boolean;
}

export interface ProposalSummaryDto {
  id: string;
  projectId: string;
  origin: ProposalOrigin;
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

export interface ProposalDetailDto extends ProposalSummaryDto {
  operations: ChangeOperation[];
}

export interface ProposalListResponse {
  proposals: ProposalSummaryDto[];
}

export interface ProposalDetailResponse {
  proposal: ProposalDetailDto;
}

export type ProposalAcceptResponse =
  | {
      outcome: "applied";
      projectRevision: number;
      proposal: ProposalSummaryDto;
    }
  | {
      outcome: "conflicted";
      currentProjectRevision: number;
      explanation: string;
      proposal: ProposalSummaryDto;
    };

export interface ProposalRejectResponse {
  proposal: ProposalSummaryDto;
}

const identifierSchema = z.string().trim().min(1).max(512);
export const mapIdentifierSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const projectRevisionSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const expectedProjectRevisionSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const coordinationIdentifierSchema = z.string().trim().min(1).max(200).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Text must not contain control characters",
);
const coordinationQueryIntegerSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,15})$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const coordinationQueryLimitSchema = z.string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
  .transform(Number);

export const coordinationReadyQuerySchema = z.object({
  expectedProjectRevision: coordinationQueryIntegerSchema,
  cursor: opaqueCoordinationCursorSchema.optional(),
  limit: coordinationQueryLimitSchema,
}).strict();
export const coordinationStateQuerySchema = z.object({
  taskId: coordinationIdentifierSchema,
  expectedProjectRevision: coordinationQueryIntegerSchema,
}).strict();

export const coordinationClaimBodySchema = claimTaskInputSchema;
export const coordinationRenewBodySchema = renewClaimInputSchema;
export const coordinationCheckpointBodySchema = checkpointClaimInputSchema;
export const coordinationTransitionBodySchema = transitionClaimInputSchema;
export const coordinationSwitchBodySchema = switchTaskInputSchema;
export const coordinationCreateDelegationBodySchema = createDelegationInputSchema;
export const coordinationAcceptDelegationBodySchema = acceptDelegationInputSchema;
export const coordinationRevokeDelegationBodySchema = revokeDelegationInputSchema;
export const coordinationSubmissionBodySchema = submitTaskResultInputSchema;

export const coordinationReadyResponseSchema = readyTaskPageSchema;
export const coordinationStateResponseSchema = coordinationStateSchema;
export const coordinationClaimResponseSchema = claimTaskResultSchema;
export const coordinationRenewResponseSchema = renewClaimResultSchema;
export const coordinationCheckpointResponseSchema = checkpointResultSchema;
export const coordinationTransitionResponseSchema = transitionClaimResultSchema;
export const coordinationSwitchResponseSchema = switchTaskResultSchema;
export const coordinationDelegationResponseSchema = delegationResultSchema;
export const coordinationSubmissionResponseSchema = submissionResultSchema;

export type CoordinationReadyResponse = z.infer<typeof coordinationReadyResponseSchema>;
export type CoordinationStateResponse = z.infer<typeof coordinationStateResponseSchema>;
export type CoordinationClaimResponse = z.infer<typeof coordinationClaimResponseSchema>;
export type CoordinationRenewResponse = z.infer<typeof coordinationRenewResponseSchema>;
export type CoordinationCheckpointResponse = z.infer<typeof coordinationCheckpointResponseSchema>;
export type CoordinationTransitionResponse = z.infer<typeof coordinationTransitionResponseSchema>;
export type CoordinationSwitchResponse = z.infer<typeof coordinationSwitchResponseSchema>;
export type CoordinationDelegationResponse = z.infer<typeof coordinationDelegationResponseSchema>;
export type CoordinationSubmissionResponse = z.infer<typeof coordinationSubmissionResponseSchema>;
const ideaTextSchema = z.string().refine(
  (value) => {
    const normalized = value.replace(/\r\n?/g, "\n").trim();
    const length = Array.from(normalized).length;
    return length >= 1 && length <= 16_384;
  },
  "Idea text must contain between 1 and 16384 Unicode code points",
);
const ideaCursorSchema = z.string().min(1).max(8_192)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ideaCaptureBodySchema = z.object({
  expectedProjectRevision: expectedProjectRevisionSchema,
  captureRequestId: z.string().trim().min(1).max(128),
  text: ideaTextSchema,
  contextRecordIds: z.array(mapIdentifierSchema).max(100).optional(),
}).strict();

export const ideaInboxQuerySchema = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .transform(Number)
    .optional(),
  cursor: ideaCursorSchema.optional(),
}).strict();

export const ideaContextSummarySchema = z.object({
  id: mapIdentifierSchema,
  kind: z.enum(["task", "component"]),
  title: z.string().min(1),
  status: recordStatusSchema,
}).strict();

export const ideaInboxItemSchema = z.object({
  id: mapIdentifierSchema,
  projectId: mapIdentifierSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: recordStatusSchema,
  title: z.string().min(1),
  bodyPreview: z.string().min(1),
  sourceKind: sourceKindSchema,
  sourceRef: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  context: z.array(ideaContextSummarySchema).max(100),
}).strict();

const ideaBodySchema = z.string().min(1);

export const ideaDetailResponseSchema = z.object({
  id: mapIdentifierSchema,
  projectId: mapIdentifierSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: recordStatusSchema,
  title: z.string().min(1),
  body: ideaBodySchema,
  sourceKind: sourceKindSchema,
  sourceRef: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  context: z.array(ideaContextSummarySchema).max(100),
}).strict();

export const ideaCaptureResponseSchema = z.object({
  projectRevision: projectRevisionSchema,
  item: ideaInboxItemSchema,
}).strict();

export const ideaInboxPageResponseSchema = z.object({
  projectId: mapIdentifierSchema,
  projectRevision: projectRevisionSchema,
  items: z.array(ideaInboxItemSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: ideaCursorSchema.nullable(),
}).strict();

export type IdeaContextSummaryDto = z.infer<typeof ideaContextSummarySchema>;
export type IdeaInboxItemDto = z.infer<typeof ideaInboxItemSchema>;
export type IdeaDetailResponse = z.infer<typeof ideaDetailResponseSchema>;
export type IdeaCaptureResponse = z.infer<typeof ideaCaptureResponseSchema>;
export type IdeaInboxPageResponse = z.infer<
  typeof ideaInboxPageResponseSchema
>;
const absoluteLocalPathSchema = z.string().trim().min(1).max(32_767).refine(
  (value) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|\/)/.test(value),
  "An absolute local path is required",
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const repositorySourceRoleSchema = z.enum([
  "canonical_source",
  "supporting_document",
  "test",
  "tool",
  "asset",
  "archived_source",
]);
const documentFacetSchema = <Schema extends z.ZodType<string>>(
  value: Schema,
) => z.object({
  value,
  count: z.number().int().nonnegative(),
}).strict();

export const documentRegistryQuerySchema = z.object({
  locationPrefix: normalizedRepositoryPathSchema.optional(),
  role: repositorySourceRoleSchema.optional(),
  format: repositoryDocumentFormatSchema.optional(),
  linkedRecordId: identifierSchema.optional(),
  relevance: z.literal("current_task").optional(),
  freshness: repositoryDocumentFreshnessSchema.optional(),
  linkBasis: repositoryLinkBasisSchema.optional(),
  unlinked: z.enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
}).strict();

export const documentReadQuerySchema = z.object({
  expectedSnapshotId: identifierSchema,
}).strict();

export const documentRegistryResponseSchema = z.object({
  projectId: z.string().trim().min(1).max(512),
  snapshotId: z.string().trim().min(1).max(512).nullable(),
  documents: z.array(documentRegistryEntrySchema),
  facets: z.object({
    documentKinds: z.array(documentFacetSchema(repositoryDocumentKindSchema)),
    formats: z.array(documentFacetSchema(repositoryDocumentFormatSchema)),
    roles: z.array(documentFacetSchema(repositorySourceRoleSchema)),
    freshness: z.array(documentFacetSchema(repositoryDocumentFreshnessSchema)),
  }).strict(),
}).strict().superRefine((response, context) => {
  if (response.snapshotId === null && response.documents.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["snapshotId"],
      message: "A populated document registry requires an accepted snapshot",
    });
  }
  response.documents.forEach((document, index) => {
    if (document.projectId !== response.projectId) {
      context.addIssue({
        code: "custom",
        path: ["documents", index, "projectId"],
        message: "Document project must match the registry project",
      });
    }
    if (document.snapshotId !== response.snapshotId) {
      context.addIssue({
        code: "custom",
        path: ["documents", index, "snapshotId"],
        message: "Document snapshot must match the registry snapshot",
      });
    }
  });
});

export const documentDetailResponseSchema = z.object({
  document: documentRegistryEntrySchema,
  linksByBasis: z.object({
    accepted: z.array(repositoryLinkSummarySchema),
    observed: z.array(repositoryLinkSummarySchema),
    inferred: z.array(repositoryLinkSummarySchema),
    conflicting: z.array(repositoryLinkSummarySchema),
  }).strict(),
  nativeCapability: z.enum([
    "renderable",
    "previewable",
    "unsupported",
    "blocked",
  ]),
  externalOpenEligible: z.boolean(),
  externalOpenAvailable: z.literal(false),
}).strict();

export const documentContentResponseSchema = z.object({
  format: z.enum(["markdown", "plain_text"]),
  text: z.string(),
  sha256: sha256Schema,
}).strict();

export type DocumentRegistryResponse = z.infer<
  typeof documentRegistryResponseSchema
>;
export type DocumentDetailResponse = z.infer<
  typeof documentDetailResponseSchema
>;
export type DocumentContentResponse = z.infer<
  typeof documentContentResponseSchema
>;
// The preview route is an allow-listed binary Fetch response, never JSON.
export type DocumentPreviewResponse = Response;
export const repositoryRefreshStartBodySchema = z.object({}).strict();
export const repositoryRefreshSelectionBodySchema = z.object({
  projectId: identifierSchema,
  snapshotId: identifierSchema,
  selectedOperationIds: z.array(identifierSchema).max(10_000)
    .refine((values) => new Set(values).size === values.length),
}).strict();
export const repositoryRefreshApplyBodySchema = z.object({
  projectId: identifierSchema,
  snapshotId: identifierSchema,
  expectedProjectRevision: projectRevisionSchema,
}).strict();
export const repositoryRefreshCancelBodySchema = z.object({
  projectId: identifierSchema,
  snapshotId: identifierSchema,
  confirmed: z.literal(true),
}).strict();
export const repositoryRefreshRetryBodySchema = z.object({
  expectedProjectRevision: projectRevisionSchema,
}).strict();
export const repositoryRefreshLocateBodySchema = z.object({
  root: absoluteLocalPathSchema,
  expectedProjectRevision: projectRevisionSchema,
}).strict();
export const repositoryRefreshAttachBodySchema = repositoryRefreshLocateBodySchema;
export const repositoryRefreshDetachBodySchema = z.object({
  confirmed: z.literal(true),
  expectedProjectRevision: projectRevisionSchema,
}).strict();

export const repositoryRefreshReviewDtoSchema = z.object({
  projectId: identifierSchema,
  snapshotId: identifierSchema,
  state: z.enum(["pending", "applied", "cancelled", "conflicted"]),
  selectedOperationIds: z.array(identifierSchema),
  baseProjectRevision: projectRevisionSchema,
  warningCounts: z.record(z.string(), z.number().int().nonnegative()),
  exclusionCounts: z.record(z.string(), z.number().int().nonnegative()),
  findingCounts: z.record(z.string(), z.number().int().nonnegative()),
  diff: repositorySnapshotDiffSchema,
}).strict();

export const repositoryRefreshStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), progress: repositoryScanProgressSchema }).strict(),
  z.object({ type: z.literal("review"), review: repositoryRefreshReviewDtoSchema }).strict(),
]);
export const repositoryRefreshResponseSchema = z.object({
  review: repositoryRefreshReviewDtoSchema.nullable(),
}).strict();
export const repositoryRefreshStateResponseSchema = repositoryRefreshResponseSchema.extend({
  sourceStatus: z.enum(["available", "unavailable", "detached"])
    .nullable(),
}).strict();
export const repositoryRefreshApplyResponseSchema = z.object({
  snapshotId: identifierSchema,
  projectRevision: projectRevisionSchema,
  proposalId: identifierSchema.nullable(),
  replayed: z.boolean(),
}).strict();
export const repositorySourceRecoveryResponseSchema = z.object({
  projectRevision: projectRevisionSchema,
  requiresRefresh: z.literal(true),
}).strict();
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean(),
  }).strict(),
}).strict();

export const mapQuerySchema = z.object({
  focusRecordId: mapIdentifierSchema.optional(),
  scopeRecordId: mapIdentifierSchema.optional(),
}).strict().superRefine((query, context) => {
  if (query.scopeRecordId !== undefined && query.focusRecordId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["scopeRecordId"],
      message: "A map scope requires a focused record.",
    });
  }
});

export const createRelationshipBodySchema = z.object({
  fromRecordId: mapIdentifierSchema,
  toRecordId: mapIdentifierSchema,
  kind: relationshipKindSchema,
  expectedProjectRevision: expectedProjectRevisionSchema,
}).strict();

export const removeRelationshipBodySchema = z.object({
  expectedProjectRevision: expectedProjectRevisionSchema,
}).strict();

const neutralHierarchyVocabularySchema = z.object({
  preset: z.literal("neutral"),
  outcome: z.literal("Outcome"),
  initiative: z.literal("Initiative"),
  deliverable: z.literal("Deliverable"),
  milestone: z.literal("Milestone"),
  task: z.literal("Work item"),
  nestedTask: z.literal("Subtask"),
}).strict();

const softwareHierarchyVocabularySchema = z.object({
  preset: z.literal("software"),
  outcome: z.literal("Product outcome"),
  initiative: z.literal("Epic"),
  deliverable: z.literal("Feature"),
  milestone: z.literal("Milestone"),
  task: z.literal("Story or Task"),
  nestedTask: z.literal("Subtask"),
}).strict();

const simpleHierarchyVocabularySchema = z.object({
  preset: z.literal("simple"),
  outcome: z.literal("Outcome"),
  initiative: z.literal("Initiative"),
  deliverable: z.literal("Deliverable"),
  milestone: z.literal("Milestone"),
  task: z.literal("Task"),
  nestedTask: z.literal("Subtask"),
}).strict();

const canonicalHierarchyVocabularySchema = z.union([
  neutralHierarchyVocabularySchema,
  softwareHierarchyVocabularySchema,
  simpleHierarchyVocabularySchema,
]);

export const updateHierarchyVocabularyBodySchema = z.object({
  expectedProjectRevision: expectedProjectRevisionSchema,
  vocabulary: canonicalHierarchyVocabularySchema,
}).strict();

export const updateHierarchyVocabularyResponseSchema = z.object({
  projectRevision: projectRevisionSchema,
  hierarchyVocabulary: hierarchyVocabularySchema,
}).strict();

const mapRecordSummarySchema = z.object({
  id: mapIdentifierSchema,
  kind: recordKindSchema,
  status: recordStatusSchema,
  title: z.string().min(1),
  revision: z.number().int().positive(),
}).strict();

const projectMapHierarchySummarySchema = mapRecordSummarySchema.extend({
  kind: z.enum(["outcome", "initiative", "deliverable", "milestone", "task"]),
}).strict();

const labeledRecordEdgeSchema = z.object({
  id: mapIdentifierSchema,
  kind: relationshipKindSchema,
  label: z.string().min(1),
  fromRecordId: mapIdentifierSchema,
  fromLabel: z.string().min(1),
  toRecordId: mapIdentifierSchema,
  toLabel: z.string().min(1),
}).strict();

const outcomeProgressSchema = z.object({
  childStatuses: z.object({
    provisional: z.number().int().nonnegative().optional(),
    accepted: z.number().int().nonnegative().optional(),
    active: z.number().int().nonnegative().optional(),
    blocked: z.number().int().nonnegative().optional(),
    completed: z.number().int().nonnegative().optional(),
    rejected: z.number().int().nonnegative().optional(),
    superseded: z.number().int().nonnegative().optional(),
    archived: z.number().int().nonnegative().optional(),
  }).strict(),
  childrenWithEvidence: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
}).strict();

export const projectMapHierarchyNodeSchema = projectMapHierarchySummarySchema.extend({
  parentId: mapIdentifierSchema.nullable(),
  childCount: z.number().int().nonnegative(),
}).strict();

const refineProjectMapResponse = (
  view: {
    hierarchyNodes: Array<z.infer<typeof projectMapHierarchyNodeSchema>>;
    hierarchyEdges: Array<z.infer<typeof labeledRecordEdgeSchema>>;
    unplacedRecordIds: string[];
    selectedRecordId: string | null;
    scopeRecordId: string | null;
    selectedPath: Array<z.infer<typeof projectMapHierarchySummarySchema>>;
  },
  context: z.RefinementCtx,
): void => {
  const nodesById = new Map<string, {
    node: z.infer<typeof projectMapHierarchyNodeSchema>;
    index: number;
  }>();
  const parentEdgeByChild = new Map<string, z.infer<typeof labeledRecordEdgeSchema>>();
  const childCountByParent = new Map<string, number>();
  const edgeIds = new Set<string>();

  view.hierarchyNodes.forEach((node, index) => {
    if (nodesById.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: ["hierarchyNodes", index, "id"],
        message: "Hierarchy nodes must have unique IDs.",
      });
      return;
    }
    nodesById.set(node.id, { node, index });
  });

  view.hierarchyEdges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "id"], message: "Map hierarchy edges must have unique IDs." });
    }
    edgeIds.add(edge.id);
    const parent = nodesById.get(edge.fromRecordId);
    const child = nodesById.get(edge.toRecordId);
    if (edge.kind !== "parent_of") {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "kind"], message: "Map hierarchy edges must use parent_of." });
    }
    if (edge.label !== "parent of") {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "label"], message: "Map hierarchy edge labels must match parent_of." });
    }
    if (parent === undefined) {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "fromRecordId"], message: "Map hierarchy edge parent must be a hierarchy node." });
    } else {
      childCountByParent.set(parent.node.id, (childCountByParent.get(parent.node.id) ?? 0) + 1);
      if (edge.fromLabel !== parent.node.title) {
        context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "fromLabel"], message: "Map hierarchy edge parent label must match its canonical node title." });
      }
    }
    if (child === undefined) {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "toRecordId"], message: "Map hierarchy edge child must be a hierarchy node." });
      return;
    }
    if (edge.toLabel !== child.node.title) {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "toLabel"], message: "Map hierarchy edge child label must match its canonical node title." });
    }
    if (parentEdgeByChild.has(child.node.id)) {
      context.addIssue({ code: "custom", path: ["hierarchyEdges", index, "toRecordId"], message: "A hierarchy node may have only one parent edge." });
    } else {
      parentEdgeByChild.set(child.node.id, edge);
    }
    if (child.node.parentId !== edge.fromRecordId) {
      context.addIssue({
        code: "custom",
        path: ["hierarchyNodes", child.index, "parentId"],
        message: "Hierarchy node parentId must match its parent edge.",
      });
    }
  });

  view.hierarchyNodes.forEach((node, index) => {
    if (node.parentId !== null && !parentEdgeByChild.has(node.id)) {
      context.addIssue({ code: "custom", path: ["hierarchyNodes", index, "parentId"], message: "Hierarchy node parentId must be backed by a parent edge." });
    }
    if (node.childCount !== (childCountByParent.get(node.id) ?? 0)) {
      context.addIssue({ code: "custom", path: ["hierarchyNodes", index, "childCount"], message: "Hierarchy node childCount must match its direct parent edges." });
    }
  });

  const checkedNodeIds = new Set<string>();
  for (const node of view.hierarchyNodes) {
    if (checkedNodeIds.has(node.id)) continue;
    const activeNodeIds = new Set<string>();
    let cursor: z.infer<typeof projectMapHierarchyNodeSchema> | undefined = node;
    while (cursor !== undefined && !checkedNodeIds.has(cursor.id)) {
      if (activeNodeIds.has(cursor.id)) {
        context.addIssue({
          code: "custom",
          path: ["hierarchyNodes", nodesById.get(cursor.id)?.index ?? 0, "parentId"],
          message: "Map hierarchy cannot contain a cycle.",
        });
        break;
      }
      activeNodeIds.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : nodesById.get(cursor.parentId)?.node;
    }
    for (const id of activeNodeIds) checkedNodeIds.add(id);
  }

  const expectedUnplacedIds = new Set(view.hierarchyNodes
    .filter((node) => node.parentId === null && node.kind !== "outcome")
    .map(({ id }) => id));
  const listedUnplacedIds = new Set<string>();
  view.unplacedRecordIds.forEach((recordId, index) => {
    if (listedUnplacedIds.has(recordId)) {
      context.addIssue({ code: "custom", path: ["unplacedRecordIds", index], message: "Unplaced record IDs must be unique." });
    }
    listedUnplacedIds.add(recordId);
    if (!expectedUnplacedIds.has(recordId)) {
      context.addIssue({ code: "custom", path: ["unplacedRecordIds", index], message: "Unplaced records must be parentless non-Outcome hierarchy roots." });
    }
  });
  for (const recordId of expectedUnplacedIds) {
    if (!listedUnplacedIds.has(recordId)) {
      context.addIssue({ code: "custom", path: ["unplacedRecordIds"], message: `Missing unplaced hierarchy root ${recordId}.` });
    }
  }

  const pathIds = new Set(view.selectedPath.map(({ id }) => id));
  if (view.selectedRecordId === null) {
    if (view.selectedPath.length > 0) {
      context.addIssue({ code: "custom", path: ["selectedPath"], message: "An unselected map cannot include a selected path." });
    }
    if (view.scopeRecordId !== null) {
      context.addIssue({ code: "custom", path: ["scopeRecordId"], message: "An unselected map cannot include a scope." });
    }
    return;
  }

  view.selectedPath.forEach((summary, index) => {
    const { id } = summary;
    const node = nodesById.get(id);
    if (node === undefined) {
      context.addIssue({ code: "custom", path: ["selectedPath", index, "id"], message: "Selected path records must be hierarchy nodes." });
      return;
    }
    if (
      summary.kind !== node.node.kind ||
      summary.status !== node.node.status ||
      summary.title !== node.node.title ||
      summary.revision !== node.node.revision
    ) {
      context.addIssue({ code: "custom", path: ["selectedPath", index], message: "Selected path summaries must match their canonical hierarchy nodes." });
    }
    if (index === 0 && node.node.parentId !== null) {
      context.addIssue({ code: "custom", path: ["selectedPath", index, "id"], message: "The selected path must start at a root." });
    }
    if (index > 0 && node.node.parentId !== view.selectedPath[index - 1]!.id) {
      context.addIssue({ code: "custom", path: ["selectedPath", index, "id"], message: "Selected path records must follow parent relationships." });
    }
  });
  if (view.selectedPath.at(-1)?.id !== view.selectedRecordId) {
    context.addIssue({ code: "custom", path: ["selectedRecordId"], message: "Selected path must end at the selected record." });
  }
  if (view.scopeRecordId !== null && !pathIds.has(view.scopeRecordId)) {
    context.addIssue({ code: "custom", path: ["scopeRecordId"], message: "Map scope must be part of the selected path." });
  }
};

export const projectMapResponseSchema = z.object({
  projectId: mapIdentifierSchema,
  projectName: z.string().min(1),
  projectRevision: projectRevisionSchema,
  hierarchyVocabulary: hierarchyVocabularySchema,
  selectedRecordId: mapIdentifierSchema.nullable(),
  scopeRecordId: mapIdentifierSchema.nullable(),
  selectedPath: z.array(projectMapHierarchySummarySchema).max(10_000),
  hierarchyNodes: z.array(projectMapHierarchyNodeSchema).max(10_000),
  hierarchyEdges: z.array(labeledRecordEdgeSchema).max(10_000),
  unplacedRecordIds: z.array(mapIdentifierSchema).max(10_000),
  progress: outcomeProgressSchema,
}).strict().superRefine(refineProjectMapResponse);

const repositoryAttachmentSchema = z.object({
  linkId: mapIdentifierSchema,
  nodeId: mapIdentifierSchema,
  path: normalizedRepositoryPathSchema,
  nodeKind: repositoryNodeKindSchema,
  linkKind: repositoryLinkKindSchema,
  linkLabel: z.string().min(1),
  basis: repositoryLinkBasisSchema,
  documentKind: repositoryDocumentKindSchema.nullable(),
  documentFormat: repositoryDocumentFormatSchema.nullable(),
  role: repositorySourceRoleSchema,
}).strict();

const attachmentsByBasisSchema = z.object({
  accepted: z.array(repositoryAttachmentSchema),
  observed: z.array(repositoryAttachmentSchema),
  inferred: z.array(repositoryAttachmentSchema),
  conflicting: z.array(repositoryAttachmentSchema),
}).strict().superRefine((groups, context) => {
  for (const basis of ["accepted", "observed", "inferred", "conflicting"] as const) {
    groups[basis].forEach((attachment, index) => {
      if (attachment.basis !== basis) {
        context.addIssue({
          code: "custom",
          path: [basis, index, "basis"],
          message: "Attachment basis must match its response group",
        });
      }
    });
  }
});

export const connectedRecordDetailResponseSchema = z.object({
  projectId: mapIdentifierSchema,
  projectRevision: projectRevisionSchema,
  record: projectRecordSchema,
  relations: z.array(z.object({
    depth: z.union([z.literal(1), z.literal(2)]),
    edge: labeledRecordEdgeSchema,
    record: mapRecordSummarySchema,
  }).strict()),
  attachmentsByBasis: attachmentsByBasisSchema,
}).strict().superRefine((detail, context) => {
  if (detail.record.projectId !== detail.projectId) {
    context.addIssue({
      code: "custom",
      path: ["record", "projectId"],
      message: "Connected record must belong to the response project",
    });
  }
});

const sanitizedRepositoryNodeSchema = z.object({
  nodeId: mapIdentifierSchema,
  parentNodeId: mapIdentifierSchema.nullable(),
  path: normalizedRepositoryPathSchema,
  kind: repositoryNodeKindSchema,
  role: repositorySourceRoleSchema,
  documentKind: repositoryDocumentKindSchema.nullable(),
  documentFormat: repositoryDocumentFormatSchema.nullable(),
  contentEligible: z.boolean(),
}).strict();

const repositoryConnectionSchema = z.union([
  z.object({
    linkId: mapIdentifierSchema,
    kind: repositoryLinkKindSchema,
    label: z.string().min(1),
    basis: repositoryLinkBasisSchema,
    record: mapRecordSummarySchema,
    node: z.null(),
  }).strict(),
  z.object({
    linkId: mapIdentifierSchema,
    kind: repositoryLinkKindSchema,
    label: z.string().min(1),
    basis: repositoryLinkBasisSchema,
    record: z.null(),
    node: sanitizedRepositoryNodeSchema,
  }).strict(),
]);

export const connectedRepositoryDetailResponseSchema = z.object({
  projectId: mapIdentifierSchema,
  snapshotId: mapIdentifierSchema,
  node: sanitizedRepositoryNodeSchema,
  linksByBasis: z.object({
    accepted: z.array(repositoryConnectionSchema),
    observed: z.array(repositoryConnectionSchema),
    inferred: z.array(repositoryConnectionSchema),
    conflicting: z.array(repositoryConnectionSchema),
  }).strict(),
}).strict().superRefine((detail, context) => {
  for (const basis of ["accepted", "observed", "inferred", "conflicting"] as const) {
    detail.linksByBasis[basis].forEach((connection, index) => {
      if (connection.basis !== basis) {
        context.addIssue({
          code: "custom",
          path: ["linksByBasis", basis, index, "basis"],
          message: "Repository connection basis must match its response group",
        });
      }
    });
  }
});

const importExclusionReasonSchema = z.enum([
  "hard_exclusion",
  "ignored",
  "unsupported_text",
  "oversized_text",
  "link_not_followed",
  "untracked_not_eligible",
  "known_secret_path",
]);
const repositoryExplorerFilterSchema = z.object({
  search: z.string().trim().min(1).max(256)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  relevance: z.literal("current_task").optional(),
  changed: z.boolean().optional(),
  category: z.enum(["documentation", "test"]).optional(),
  documentKind: repositoryDocumentKindSchema.optional(),
  role: repositorySourceRoleSchema.optional(),
  unlinked: z.boolean().optional(),
  contextIncluded: z.boolean().optional(),
  state: z.enum(["current", "stale", "unavailable", "excluded"]).optional(),
  exclusionReason: importExclusionReasonSchema.optional(),
}).strict().superRefine((filter, context) => {
  if (filter.exclusionReason !== undefined && filter.state !== "excluded") {
    context.addIssue({
      code: "custom",
      path: ["exclusionReason"],
      message: "An exclusion reason requires the excluded state filter",
    });
  }
});
const queryBooleanSchema = z.enum(["true", "false"])
  .transform((value) => value === "true");
const explorerPageSizeSchema = z.string().regex(/^(?:[1-9][0-9]{0,2}|1000)$/)
  .transform(Number);

export const repositoryExplorerQuerySchema = z.object({
  parentNodeId: mapIdentifierSchema.optional(),
  pageSize: explorerPageSizeSchema.optional(),
  cursor: z.string().min(1).max(8_192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).optional(),
  search: z.string().trim().min(1).max(256)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  relevance: z.literal("current_task").optional(),
  changed: queryBooleanSchema.optional(),
  category: z.enum(["documentation", "test"]).optional(),
  documentKind: repositoryDocumentKindSchema.optional(),
  role: repositorySourceRoleSchema.optional(),
  unlinked: queryBooleanSchema.optional(),
  contextIncluded: queryBooleanSchema.optional(),
  state: z.enum(["current", "stale", "unavailable", "excluded"]).optional(),
  exclusionReason: importExclusionReasonSchema.optional(),
}).strict().superRefine((query, context) => {
  if (query.exclusionReason !== undefined && query.state !== "excluded") {
    context.addIssue({
      code: "custom",
      path: ["exclusionReason"],
      message: "An exclusion reason requires the excluded state filter",
    });
  }
});

const repositoryExplorerNodeSchema = z.object({
  nodeId: mapIdentifierSchema,
  parentNodeId: mapIdentifierSchema.nullable(),
  path: normalizedRepositoryPathSchema,
  kind: repositoryNodeKindSchema,
  role: repositorySourceRoleSchema,
  documentKind: repositoryDocumentKindSchema.nullable(),
  documentFormat: repositoryDocumentFormatSchema.nullable(),
  sourceStatus: z.enum(["tracked", "untracked", "derived"]),
  state: z.enum(["current", "stale", "unavailable"]),
  contentEligible: z.boolean(),
  childCount: z.number().int().nonnegative(),
  changed: z.boolean(),
  linked: z.boolean(),
  currentTaskRelevant: z.boolean(),
  contextIncluded: z.boolean(),
}).strict();

export const repositoryExplorerResponseSchema = z.object({
  projectId: mapIdentifierSchema,
  snapshotId: mapIdentifierSchema.nullable(),
  parentNodeId: mapIdentifierSchema.nullable(),
  sourceStatus: z.enum(["available", "unavailable", "detached"]).nullable(),
  request: z.object({
    parentNodeId: mapIdentifierSchema.nullable(),
    pageSize: z.number().int().min(1).max(1_000),
    filter: repositoryExplorerFilterSchema,
  }).strict(),
  items: z.array(repositoryExplorerNodeSchema).max(1_000),
  exclusions: z.array(z.object({
    reason: importExclusionReasonSchema,
    count: z.number().int().positive(),
  }).strict()).max(importExclusionReasonSchema.options.length),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(8_192).nullable(),
}).strict().superRefine((response, context) => {
  if (response.parentNodeId !== response.request.parentNodeId) {
    context.addIssue({ code: "custom", path: ["request", "parentNodeId"], message: "Explorer response parent must match its request" });
  }
  response.items.forEach((item, index) => {
    if (item.parentNodeId !== response.parentNodeId) {
      context.addIssue({ code: "custom", path: ["items", index, "parentNodeId"], message: "Explorer item must be a direct requested child" });
    }
  });
  if (response.hasMore !== (response.nextCursor !== null)) {
    context.addIssue({ code: "custom", path: ["nextCursor"], message: "Explorer pagination state is inconsistent" });
  }
  if (response.snapshotId === null && (response.items.length > 0 || response.exclusions.length > 0)) {
    context.addIssue({ code: "custom", path: ["snapshotId"], message: "Explorer items require an accepted snapshot" });
  }
});

export const relationshipMutationResponseSchema = z.object({
  projectRevision: projectRevisionSchema,
  relationship: z.object({
    id: mapIdentifierSchema,
    projectId: mapIdentifierSchema,
    fromRecordId: mapIdentifierSchema,
    toRecordId: mapIdentifierSchema,
    kind: relationshipKindSchema,
    createdAt: z.iso.datetime(),
  }).strict().refine(
    (relationship) => relationship.fromRecordId !== relationship.toRecordId,
    {
      path: ["toRecordId"],
      message: "Relationships must link different records",
    },
  ),
}).strict();

export type ProjectMapResponse = z.infer<typeof projectMapResponseSchema>;
export type ConnectedRecordDetailResponse = z.infer<
  typeof connectedRecordDetailResponseSchema
>;
export type ConnectedRepositoryDetailResponse = z.infer<
  typeof connectedRepositoryDetailResponseSchema
>;
export type RepositoryExplorerResponse = z.infer<typeof repositoryExplorerResponseSchema>;
export type RelationshipMutationResponse = z.infer<
  typeof relationshipMutationResponseSchema
>;

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const apiPath = (...segments: string[]): string =>
  `/api/${segments.map(encodeURIComponent).join("/")}`;
