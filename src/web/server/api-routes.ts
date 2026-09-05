import { z } from "zod";
import type { IntentArcApplication } from "../../app/create-application.js";
import { formatBrowserChatExport } from "../../context/browser-chat-export.js";
import {
  acceptedDelegationResultMatches,
  checkpointResultMatches,
  claimTaskResultMatches,
  coordinationStateMatches,
  createdDelegationResultMatches,
  GovernanceError,
  proposalStateSchema,
  readyTaskPageMatches,
  renewClaimResultMatches,
  revokedDelegationResultMatches,
  submissionResultMatches,
  switchTaskResultMatches,
  transitionClaimResultMatches,
  type ImportExclusionReason,
} from "../../domain/index.js";
import {
  IdeaContextInvalidError,
  IdeaServiceUnavailableError,
} from "../../core/idea-service.js";
import { OutboundSafetyError } from "../../outbound/errors.js";
import { RepositoryImportError } from "../../import/errors.js";
import {
  DocumentNotFoundError,
  type DocumentRegistryFilter,
} from "../../core/document-registry-service.js";
import { MAX_PREVIEW_FILE_BYTES } from "../../repository/safe-file-reader.js";
import type {
  ProposalDetailDto,
  ProposalSummaryDto,
} from "../contracts.js";
import type { RepositoryExplorerFilter } from "../../core/project-map-service.js";
import {
  coordinationAcceptDelegationBodySchema,
  coordinationCheckpointBodySchema,
  coordinationCheckpointResponseSchema,
  coordinationClaimBodySchema,
  coordinationClaimResponseSchema,
  coordinationCreateDelegationBodySchema,
  coordinationDelegationResponseSchema,
  coordinationReadyQuerySchema,
  coordinationReadyResponseSchema,
  coordinationRenewBodySchema,
  coordinationRenewResponseSchema,
  coordinationRevokeDelegationBodySchema,
  coordinationStateQuerySchema,
  coordinationStateResponseSchema,
  coordinationSubmissionBodySchema,
  coordinationSubmissionResponseSchema,
  coordinationSwitchBodySchema,
  coordinationSwitchResponseSchema,
  coordinationTransitionBodySchema,
  coordinationTransitionResponseSchema,
  connectedRecordDetailResponseSchema,
  connectedRepositoryDetailResponseSchema,
  createRelationshipBodySchema,
  documentContentResponseSchema,
  documentDetailResponseSchema,
  documentReadQuerySchema,
  documentRegistryQuerySchema,
  documentRegistryResponseSchema,
  ideaCaptureBodySchema,
  ideaCaptureResponseSchema,
  ideaDetailResponseSchema,
  ideaInboxPageResponseSchema,
  ideaInboxQuerySchema,
  mapIdentifierSchema,
  mapQuerySchema,
  projectMapResponseSchema,
  projectDashboardResponseSchemaFor,
  relationshipMutationResponseSchema,
  removeRelationshipBodySchema,
  repositoryExplorerQuerySchema,
  repositoryExplorerResponseSchema,
  repositoryRefreshApplyBodySchema,
  repositoryRefreshAttachBodySchema,
  repositoryRefreshApplyResponseSchema,
  repositoryRefreshCancelBodySchema,
  repositoryRefreshDetachBodySchema,
  repositoryRefreshLocateBodySchema,
  repositoryRefreshResponseSchema,
  repositoryRefreshStateResponseSchema,
  repositoryRefreshRetryBodySchema,
  repositoryRefreshSelectionBodySchema,
  repositoryRefreshStartBodySchema,
  repositoryRefreshStreamEventSchema,
  repositorySourceRecoveryResponseSchema,
  updateHierarchyVocabularyBodySchema,
  updateHierarchyVocabularyResponseSchema,
} from "../contracts.js";
import type {
  ProjectConstrainedCoordinationService,
} from "../../core/coordination-service.js";
import type { ApiRoute } from "./router.js";
import {
  ApiBinaryResponse,
  ApiJsonResponse,
  ApiNdjsonResponse,
  ApiRouteError,
} from "./router.js";
import { ImportApiError } from "./import-api-error.js";
import {
  repositoryRefreshAsyncBoundary,
  repositoryRefreshBoundary,
} from "./repository-refresh-api-error.js";

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  primaryRepositoryPath: z.string().trim().min(1).nullable(),
}).strict();

export const requestContextBodySchema = z.object({
  profileId: z.string().trim().min(1),
  budgetTokens: z.number().int().min(1_000).max(200_000),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();

export const revealContextBodySchema = z.object({
  findingId: z.string().trim().min(1),
}).strict();

export const approveContextBodySchema = z.object({
  rememberClean: z.boolean(),
  includeFindingIds: z.array(z.string().min(1)),
}).strict();

export const destinationBodySchema = z.object({
  clientLabel: z.string().trim().min(1).max(200),
  type: z.enum([
    "local_model",
    "direct_provider",
    "gateway",
    "ide_managed",
    "unknown",
  ]),
  providerLabel: z.string().trim().min(1).max(200),
  modelLabel: z.string().trim().min(1).max(200).nullable(),
  accountBoundaryLabel: z.string().trim().min(1).max(200).nullable(),
  dataBoundary: z.enum(["local", "remote", "mixed", "unknown"]),
}).strict();

export const projectProfileBodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("existing"),
    profileId: z.string().trim().min(1),
    executionMode: z.enum(["safe", "trusted", "custom"]),
    destination: destinationBodySchema.nullable(),
  }).strict(),
  z.object({
    source: z.literal("new"),
    name: z.string().trim().min(1).max(200),
    executionMode: z.enum(["safe", "trusted"]),
    destination: destinationBodySchema,
  }).strict(),
]);

export const rejectProposalBodySchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const proposalListQuerySchema = z.object({
  state: proposalStateSchema.optional(),
}).strict();

export const acceptProposalBodySchema = z.undefined();

export const importScanBodySchema = z.object({
  repositoryPath: z.string().trim().min(1).max(4_096),
  canonicalSubpath: z.string().trim().min(1).max(1_024).nullable(),
}).strict();

export const importApplyBodySchema = z.object({
  manifest: z.unknown(),
  confirmedDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const proposalListQuery = (url: URL): z.infer<
  typeof proposalListQuerySchema
> => {
  const input: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    const current = input[key];
    input[key] = current === undefined
      ? value
      : Array.isArray(current)
        ? [...current, value]
        : [current, value];
  }
  return proposalListQuerySchema.parse(input);
};

const queryObject = (url: URL): Record<string, unknown> => {
  const input: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    const current = input[key];
    input[key] = current === undefined
      ? value
      : Array.isArray(current)
        ? [...current, value]
        : [current, value];
  }
  return input;
};

const noQuerySchema = z.object({}).strict();
const mapRouteId = (
  match: RegExpExecArray,
  name: "projectId" | "recordId" | "nodeId" | "relationshipId" | "ideaId",
): string => mapIdentifierSchema.parse(decodeRouteParameter(match, name));

const ideaBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof IdeaServiceUnavailableError) {
      throw new ApiRouteError(
        503,
        "service_unavailable",
        "The idea service is temporarily unavailable. Retry the same submission.",
        true,
      );
    }
    if (error instanceof IdeaContextInvalidError) {
      throw new ApiRouteError(
        409,
        "idea_context_invalid",
        "The idea context changed. Refresh the project and try again.",
      );
    }
    if (
      error instanceof GovernanceError &&
      error.code === "validation_failed" &&
      error.message === "Idea inbox cursor is invalid"
    ) {
      throw new ApiRouteError(
        400,
        "invalid_request",
        "The request did not pass validation.",
      );
    }
    throw error;
  }
};

const mapBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GovernanceError) {
      if (error.code === "project_map_limit_exceeded") {
        throw new ApiRouteError(
          409,
          "project_map_limit_exceeded",
          "Project map supports at most 10,000 hierarchy records.",
        );
      }
      switch (error.message) {
        case "Hierarchy relationships cannot contain a cycle":
          throw new ApiRouteError(
            409,
            "hierarchy_cycle",
            "The requested hierarchy change conflicts with the current project map.",
          );
        case "A hierarchy record cannot have more than one parent":
          throw new ApiRouteError(
            409,
            "hierarchy_multiple_parents",
            "The requested hierarchy change conflicts with the current project map.",
          );
        case "Hierarchy parents must be outcomes, initiatives, deliverables, milestones, or tasks":
        case "Hierarchy relationships require outcomes, initiatives, deliverables, milestones, or tasks":
          throw new ApiRouteError(
            409,
            "hierarchy_parent_kind_invalid",
            "The requested hierarchy change conflicts with the current project map.",
          );
        case "A record cannot be its own parent":
          throw new ApiRouteError(
            409,
            "hierarchy_self_parent",
            "The requested hierarchy change conflicts with the current project map.",
          );
        case "Map selection must be a hierarchy record in the requested project":
        case "Map scope must be the selected hierarchy record or one of its ancestors":
          throw new ApiRouteError(
            400,
            "invalid_request",
            "The request did not pass validation.",
          );
        case "Repository node not found":
          throw new ApiRouteError(
            404,
            "not_found",
            "The requested resource was not found.",
          );
        default:
          if (
            error.code === "validation_failed" &&
            (error.message.includes("does not belong to project") ||
              error.message.includes("must remain inside one project"))
          ) {
            throw new ApiRouteError(
              404,
              "not_found",
              "The requested resource was not found.",
            );
          }
      }
    }
    throw error;
  }
};

const mapResponse = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiRouteError(
      500,
      "internal_error",
      "The request could not be completed.",
      false,
    );
  }
  return parsed.data;
};

const rejectUnboundMapResponse = (): never => {
  throw new ApiRouteError(
    500,
    "internal_error",
    "The request could not be completed.",
    false,
  );
};

const documentError = (
  result: { status: string },
): never => {
  switch (result.status) {
    case "stale":
      throw new ApiRouteError(
        409,
        "document_stale",
        "The accepted document changed. Review a repository refresh before reading it.",
      );
    case "missing":
      throw new ApiRouteError(
        404,
        "document_missing",
        "The accepted document is missing. Review a repository refresh to recover.",
      );
    case "unavailable":
      throw new ApiRouteError(
        409,
        "repository_unavailable",
        "The repository is unavailable. Restore or locate it before retrying.",
      );
    case "blocked":
      throw new ApiRouteError(
        403,
        "document_blocked",
        "Repository safety policy blocks this document.",
      );
    default:
      throw new ApiRouteError(
        415,
        "document_unsupported",
        "This document format is not supported for in-app reading.",
      );
  }
};

const documentBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DocumentNotFoundError) {
      throw new ApiRouteError(
        404,
        "document_not_found",
        "The requested accepted document was not found in this project.",
      );
    }
    throw error;
  }
};

const rejectRange = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): void => {
  if (headers.range !== undefined) {
    throw new ApiRouteError(
      416,
      "range_not_supported",
      "Partial document responses are not supported.",
    );
  }
};

const imageMediaTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
]);

const documentFilter = (
  parsed: z.infer<typeof documentRegistryQuerySchema>,
): DocumentRegistryFilter => ({
  ...(parsed.locationPrefix === undefined
    ? {}
    : { locationPrefix: parsed.locationPrefix }),
  ...(parsed.role === undefined ? {} : { role: parsed.role }),
  ...(parsed.format === undefined ? {} : { format: parsed.format }),
  ...(parsed.linkedRecordId === undefined
    ? {}
    : { linkedRecordId: parsed.linkedRecordId }),
  ...(parsed.relevance === undefined ? {} : { relevance: parsed.relevance }),
  ...(parsed.freshness === undefined ? {} : { freshness: parsed.freshness }),
  ...(parsed.linkBasis === undefined ? {} : { linkBasis: parsed.linkBasis }),
  ...(parsed.unlinked === undefined ? {} : { unlinked: parsed.unlinked }),
});

const proposalSummaryDto = (
  proposal: ProposalSummaryDto,
): ProposalSummaryDto => ({
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

const proposalDetailDto = (
  proposal: ProposalSummaryDto & {
    operations: ProposalDetailDto["operations"];
  },
): ProposalDetailDto => ({
  ...proposalSummaryDto(proposal),
  operations: proposal.operations,
});

const decodeRouteParameter = (
  match: RegExpExecArray,
  name: string,
): string => {
  try {
    return decodeURIComponent(match.groups![name]!);
  } catch {
    throw new ApiRouteError(
      400,
      "invalid_request",
      "The request path is not valid.",
    );
  }
};

const refreshRouteIdentifierSchema = z.string().trim().min(1).max(512);

const repositoryRefreshRouteId = (
  match: RegExpExecArray,
  name: "projectId" | "snapshotId",
): string => refreshRouteIdentifierSchema.parse(decodeRouteParameter(match, name));

const validationFailure = (message: string): GovernanceError =>
  new GovernanceError("validation_failed", message);

const outboundBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OutboundSafetyError) {
      throw validationFailure("The outbound safety policy rejected the request");
    }
    throw error;
  }
};

const importBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RepositoryImportError) {
      const rescanRequired =
        error.code === "source_drift" ||
        error.code === "manifest_invalid" ||
        error.code === "manifest_digest_mismatch";
      throw new ImportApiError(
        rescanRequired
          ? "import_rescan_required"
          : "import_validation_failed",
      );
    }
    throw error;
  }
};

const publicExclusionReasons = [
  "hard_exclusion",
  "ignored",
  "unsupported_text",
  "oversized_text",
  "link_not_followed",
  "untracked_not_eligible",
  "known_secret_path",
] as const satisfies readonly ImportExclusionReason[];

const sanitizedExclusionCounts = (
  counts: Readonly<Record<string, number>>,
): Record<string, number> => Object.fromEntries(
  publicExclusionReasons.flatMap((reason) => {
    const count = counts[reason] ?? 0;
    return count > 0 ? [[reason, count] as const] : [];
  }),
);

const repositoryRefreshDto = (
  view: ReturnType<IntentArcApplication["service"]["repositoryRefresh"]["get"]> extends infer View
    ? Exclude<View, null>
    : never,
) => repositoryRefreshResponseSchema.shape.review.unwrap().parse({
  projectId: view.review.projectId,
  snapshotId: view.review.snapshotId,
  state: view.review.state,
  selectedOperationIds: view.review.selectedOperationIds,
  baseProjectRevision: view.snapshot.baseProjectRevision,
  warningCounts: view.snapshot.warningCounts,
  exclusionCounts: sanitizedExclusionCounts(view.snapshot.exclusionCounts),
  findingCounts: view.snapshot.findingCounts,
  diff: view.diff,
});

const requireMatchingRefreshIds = (
  pathProjectId: string,
  pathSnapshotId: string,
  body: { projectId: string; snapshotId: string },
): void => {
  if (body.projectId !== pathProjectId || body.snapshotId !== pathSnapshotId) {
    throw new ApiRouteError(400, "invalid_request", "The request did not pass validation.");
  }
};

const refreshStream = (
  operation: (
    signal: AbortSignal,
    onProgress: (progress: import("../../domain/repository-index-model.js").RepositoryScanProgress) => void,
  ) => Promise<Exclude<ReturnType<IntentArcApplication["service"]["repositoryRefresh"]["get"]>, null>>,
): ApiNdjsonResponse => new ApiNdjsonResponse(async ({ signal, write }) => {
  let pendingWrites = Promise.resolve();
  let pendingWriteError: unknown;
  let view: Exclude<ReturnType<IntentArcApplication["service"]["repositoryRefresh"]["get"]>, null>;
  try {
    view = await repositoryRefreshAsyncBoundary(() => operation(signal, (progress) => {
      const event = repositoryRefreshStreamEventSchema.parse({ type: "progress", progress });
      pendingWrites = pendingWrites.then(async () => {
        if (pendingWriteError !== undefined) return;
        try {
          await write(event);
        } catch (error) {
          pendingWriteError = error;
        }
      });
    }));
  } catch (error) {
    await pendingWrites;
    throw error;
  }
  await pendingWrites;
  if (pendingWriteError !== undefined) throw pendingWriteError;
  await write(repositoryRefreshStreamEventSchema.parse({
    type: "review",
    review: repositoryRefreshDto(view),
  }));
});

const coordinationRouteIdentifierSchema = z.string().trim().min(1).max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const coordinationProfileIdSchema = coordinationRouteIdentifierSchema
  .refine((value) => value === value.trim() && !value.includes(","));
const coordinationTokenSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

const coordinationCredentialError = (
  code: "profile_required" | "invalid_profile_credentials" | "profile_disabled",
): ApiRouteError => new ApiRouteError(
  code === "profile_disabled" ? 403 : 401,
  code,
  code === "profile_required"
    ? "Complete profile credentials are required."
    : code === "profile_disabled"
      ? "Profile is disabled."
      : "Profile credentials are invalid.",
);

const rawHeader = (
  rawHeaders: readonly string[],
  name: string,
): string | null => {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) throw coordinationCredentialError("invalid_profile_credentials");
  return values[0] ?? null;
};

const coordinationPrincipal = (
  application: IntentArcApplication,
  rawHeaders: readonly string[],
) => {
  const profileHeader = rawHeader(rawHeaders, "x-intentarc-profile-id");
  const authorization = rawHeader(rawHeaders, "authorization");
  if (profileHeader === null || authorization === null) {
    throw coordinationCredentialError("profile_required");
  }
  const profileId = coordinationProfileIdSchema.safeParse(profileHeader);
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  const token = bearer ? coordinationTokenSchema.safeParse(bearer[1]) : null;
  if (!profileId.success || !token?.success) {
    throw coordinationCredentialError("invalid_profile_credentials");
  }
  try {
    const principal = application.service.profiles.authenticate({
      profileId: profileId.data,
      token: token.data,
    });
    if (!principal) throw coordinationCredentialError("profile_required");
    return principal;
  } catch (error) {
    if (error instanceof GovernanceError) {
      if (error.code === "profile_disabled") {
        throw coordinationCredentialError("profile_disabled");
      }
      if (error.code === "profile_required" || error.code === "invalid_profile_credentials") {
        throw coordinationCredentialError(error.code);
      }
    }
    throw error;
  }
};

const coordinationRouteId = (
  match: RegExpExecArray,
  name: "projectId" | "claimId" | "delegationId",
): string => coordinationRouteIdentifierSchema.parse(decodeRouteParameter(match, name));

const requireCoordinationIds = (matches: boolean): void => {
  if (!matches) {
    throw new ApiRouteError(400, "invalid_request", "The request did not pass validation.");
  }
};

const coordinationResponse = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  matches: (output: Output) => boolean,
): Output => {
  const output = mapResponse(schema, value);
  if (!matches(output)) rejectUnboundMapResponse();
  return output;
};

export const createApplicationRoutes = (
  application: IntentArcApplication,
): ApiRoute[] => {
  const coordination = application.service.coordination as ProjectConstrainedCoordinationService;
  return [{
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/ready$/,
  handle: ({ match, url, rawHeaders }) => {
    const projectId = coordinationRouteId(match, "projectId");
    const query = coordinationReadyQuerySchema.parse(queryObject(url));
    const principal = coordinationPrincipal(application, rawHeaders);
    return coordinationResponse(
      coordinationReadyResponseSchema,
      coordination.listReadyTasks({
        projectId,
        expectedProjectRevision: query.expectedProjectRevision,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }, principal),
      (output) => readyTaskPageMatches(output, {
        projectId,
        expectedProjectRevision: query.expectedProjectRevision,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/state$/,
  handle: ({ match, url, rawHeaders }) => {
    const projectId = coordinationRouteId(match, "projectId");
    const query = coordinationStateQuerySchema.parse(queryObject(url));
    const principal = coordinationPrincipal(application, rawHeaders);
    return coordinationResponse(
      coordinationStateResponseSchema,
      coordination.getCoordinationState({ projectId, ...query }, principal),
      (output) => coordinationStateMatches(output, { projectId, ...query }),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/claims$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationClaimBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    requireCoordinationIds(parsed.projectId === projectId);
    const principal = coordinationPrincipal(application, rawHeaders);
    return coordinationResponse(
      coordinationClaimResponseSchema,
      coordination.claimTask(parsed, principal),
      (output) => claimTaskResultMatches(output, parsed, principal.id),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/claims\/(?<claimId>[^/]+)\/renew$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationRenewBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const claimId = coordinationRouteId(match, "claimId");
    requireCoordinationIds(parsed.claimId === claimId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const snapshot = coordination.resolveOwnedClaimSnapshot(parsed.claimId, principal);
    return coordinationResponse(
      coordinationRenewResponseSchema,
      coordination.renewClaim(parsed, principal, { expectedProjectId: projectId }),
      (output) => renewClaimResultMatches(output, parsed, principal.id, snapshot),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/claims\/(?<claimId>[^/]+)\/checkpoints$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationCheckpointBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const claimId = coordinationRouteId(match, "claimId");
    requireCoordinationIds(parsed.claimId === claimId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const snapshot = coordination.resolveOwnedClaimSnapshot(parsed.claimId, principal);
    return coordinationResponse(
      coordinationCheckpointResponseSchema,
      coordination.checkpointClaim(parsed, principal, { expectedProjectId: projectId }),
      (output) => checkpointResultMatches(output, parsed, principal.id, snapshot),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/claims\/(?<claimId>[^/]+)\/transition$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationTransitionBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const claimId = coordinationRouteId(match, "claimId");
    requireCoordinationIds(parsed.claimId === claimId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const snapshot = coordination.resolveOwnedClaimSnapshot(parsed.claimId, principal);
    return coordinationResponse(
      coordinationTransitionResponseSchema,
      coordination.transitionClaim(parsed, principal, { expectedProjectId: projectId }),
      (output) => transitionClaimResultMatches(output, parsed, principal.id, snapshot),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/switch$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationSwitchBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    requireCoordinationIds(parsed.projectId === projectId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const snapshot = coordination.resolveOwnedClaimSnapshot(parsed.currentClaimId, principal);
    return coordinationResponse(
      coordinationSwitchResponseSchema,
      coordination.switchTask(parsed, principal),
      (output) => switchTaskResultMatches(output, parsed, principal.id, snapshot),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/delegations$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationCreateDelegationBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    requireCoordinationIds(parsed.projectId === projectId);
    const principal = coordinationPrincipal(application, rawHeaders);
    return coordinationResponse(
      coordinationDelegationResponseSchema,
      coordination.createDelegation(parsed, principal),
      (output) => createdDelegationResultMatches(output, parsed, principal.id),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/delegations\/(?<delegationId>[^/]+)\/accept$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationAcceptDelegationBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const delegationId = coordinationRouteId(match, "delegationId");
    requireCoordinationIds(parsed.projectId === projectId && parsed.delegationId === delegationId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const expected = coordination.resolveAuthorizedDelegation(parsed, principal, "child");
    return coordinationResponse(
      coordinationDelegationResponseSchema,
      coordination.acceptDelegation(parsed, principal),
      (output) => acceptedDelegationResultMatches(output, parsed, principal.id, expected),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/delegations\/(?<delegationId>[^/]+)\/revoke$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationRevokeDelegationBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const delegationId = coordinationRouteId(match, "delegationId");
    requireCoordinationIds(parsed.projectId === projectId && parsed.delegationId === delegationId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const expected = coordination.resolveAuthorizedDelegation(parsed, principal, "parent");
    return coordinationResponse(
      coordinationDelegationResponseSchema,
      coordination.revokeDelegation(parsed, principal),
      (output) => revokedDelegationResultMatches(output, parsed, principal.id, expected),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/coordination\/claims\/(?<claimId>[^/]+)\/submissions$/,
  handle: ({ match, body, rawHeaders }) => {
    const parsed = coordinationSubmissionBodySchema.parse(body);
    const projectId = coordinationRouteId(match, "projectId");
    const claimId = coordinationRouteId(match, "claimId");
    requireCoordinationIds(parsed.claimId === claimId);
    const principal = coordinationPrincipal(application, rawHeaders);
    const snapshot = coordination.resolveOwnedClaimSnapshot(parsed.claimId, principal);
    return coordinationResponse(
      coordinationSubmissionResponseSchema,
      coordination.submitTaskResult(parsed, principal, { expectedProjectId: projectId }),
      (output) => submissionResultMatches(output, parsed, principal.id, snapshot),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-refreshes$/,
  handle: ({ match, body }) => {
    repositoryRefreshStartBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    return refreshStream((signal, onProgress) =>
      application.service.repositoryRefresh.start(projectId, { signal, onProgress })
    );
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/ideas\/(?<ideaId>[^/]+)$/,
  handle: ({ match }) => {
    const projectId = mapRouteId(match, "projectId");
    const ideaId = mapRouteId(match, "ideaId");
    return mapResponse(ideaDetailResponseSchema, ideaBoundary(() =>
      application.service.ideas.getDetail({ projectId, ideaId })
    ));
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-refresh$/,
  handle: ({ match, url }) => {
    noQuerySchema.parse(queryObject(url));
    const projectId = repositoryRefreshRouteId(match, "projectId");
    const view = repositoryRefreshBoundary(() =>
      application.service.repositoryRefresh.get(projectId)
    );
    return repositoryRefreshStateResponseSchema.parse({
      review: view === null ? null : repositoryRefreshDto(view),
      sourceStatus: application.service.repositoryRefresh.sourceStatus(projectId),
    });
  },
}, {
  method: "PATCH",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-refresh\/(?<snapshotId>[^/]+)$/,
  handle: ({ match, body }) => {
    const parsed = repositoryRefreshSelectionBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    const snapshotId = repositoryRefreshRouteId(match, "snapshotId");
    requireMatchingRefreshIds(projectId, snapshotId, parsed);
    return repositoryRefreshResponseSchema.parse({
      review: repositoryRefreshDto(repositoryRefreshBoundary(() =>
        application.service.repositoryRefresh.updateSelection(parsed)
      )),
    });
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-refresh\/(?<snapshotId>[^/]+)\/apply$/,
  handle: async ({ match, body }) => {
    const parsed = repositoryRefreshApplyBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    const snapshotId = repositoryRefreshRouteId(match, "snapshotId");
    requireMatchingRefreshIds(projectId, snapshotId, parsed);
    return repositoryRefreshApplyResponseSchema.parse(
      await repositoryRefreshAsyncBoundary(() =>
        application.service.repositoryRefresh.apply(parsed)
      ),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-refresh\/(?<snapshotId>[^/]+)\/cancel$/,
  handle: ({ match, body }) => {
    const parsed = repositoryRefreshCancelBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    const snapshotId = repositoryRefreshRouteId(match, "snapshotId");
    requireMatchingRefreshIds(projectId, snapshotId, parsed);
    return repositoryRefreshResponseSchema.parse({
      review: repositoryRefreshDto(repositoryRefreshBoundary(() =>
        application.service.repositoryRefresh.cancel(parsed)
      )),
    });
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-source\/attach$/,
  handle: ({ match, body }) => {
    const parsed = repositoryRefreshAttachBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    return refreshStream((signal, onProgress) =>
      application.service.repositoryRefresh.attach(projectId, {
        ...parsed,
        signal,
        onProgress,
      })
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-source\/retry$/,
  handle: ({ match, body }) => {
    const parsed = repositoryRefreshRetryBodySchema.parse(body);
    const projectId = repositoryRefreshRouteId(match, "projectId");
    return refreshStream((signal, onProgress) =>
      application.service.repositoryRefresh.retry(
        projectId,
        parsed.expectedProjectRevision,
        { signal, onProgress },
      )
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-source\/locate$/,
  handle: async ({ match, body, signal }) => {
    const parsed = repositoryRefreshLocateBodySchema.parse(body);
    return repositorySourceRecoveryResponseSchema.parse(
      await repositoryRefreshAsyncBoundary(() =>
        application.service.repositoryRefresh.locate({
          projectId: repositoryRefreshRouteId(match, "projectId"),
          ...parsed,
          signal,
        })
      ),
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository-source\/detach$/,
  handle: ({ match, body }) => {
    const parsed = repositoryRefreshDetachBodySchema.parse(body);
    return repositorySourceRecoveryResponseSchema.parse(repositoryRefreshBoundary(() =>
      application.service.repositoryRefresh.detach({
        projectId: repositoryRefreshRouteId(match, "projectId"),
        expectedProjectRevision: parsed.expectedProjectRevision,
      })
    ));
  },
}, {
  method: "POST",
  pattern: /^\/api\/imports\/scan$/,
  handle: ({ body }) => {
    const parsed = importScanBodySchema.parse(body);
    const manifest = importBoundary(() =>
      application.service.imports.scan(parsed)
    );
    return {
      manifest,
      inspection: importBoundary(() =>
        application.service.imports.inspect(manifest)
      ),
    };
  },
}, {
  method: "POST",
  pattern: /^\/api\/imports\/apply$/,
  handle: ({ body }) => {
    const parsed = importApplyBodySchema.parse(body);
    return {
      result: importBoundary(() => application.service.imports.apply(parsed)),
    };
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects$/,
  handle: () => ({
    projects: application.service.views.listHubProjects(),
  }),
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/ideas$/,
  handle: ({ match, url }) => {
    const query = ideaInboxQuerySchema.parse(queryObject(url));
    return ideaInboxPageResponseSchema.parse(ideaBoundary(() =>
      application.service.ideas.listInbox({
        projectId: mapRouteId(match, "projectId"),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      })
    ));
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/ideas$/,
  handle: ({ match, body }) => {
    const input = ideaCaptureBodySchema.parse(body);
    const result = ideaBoundary(() => application.service.ideas.capture({
      projectId: mapRouteId(match, "projectId"),
      expectedProjectRevision: input.expectedProjectRevision,
      captureRequestId: input.captureRequestId,
      text: input.text,
      ...(input.contextRecordIds === undefined
        ? {}
        : { contextRecordIds: input.contextRecordIds }),
    }));
    return new ApiJsonResponse(201, ideaCaptureResponseSchema.parse(result));
  },
}, {
  method: "PUT",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/hierarchy-vocabulary$/,
  handle: ({ match, body }) => {
    const projectId = mapRouteId(match, "projectId");
    const parsed = updateHierarchyVocabularyBodySchema.parse(body);
    const response = mapResponse(
      updateHierarchyVocabularyResponseSchema,
      mapBoundary(() => application.service.updateHierarchyVocabulary({
        projectId,
        expectedProjectRevision: parsed.expectedProjectRevision,
        vocabulary: parsed.vocabulary,
      })),
    );
    if (
      response.projectRevision !== parsed.expectedProjectRevision + 1 ||
      JSON.stringify(response.hierarchyVocabulary) !== JSON.stringify(parsed.vocabulary)
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/map$/,
  handle: ({ match, url }) => {
    const parsed = mapQuerySchema.parse(queryObject(url));
    const projectId = mapRouteId(match, "projectId");
    const response = mapResponse(projectMapResponseSchema, mapBoundary(() =>
      application.service.projectMap.getProjectMap(
        projectId,
        parsed.focusRecordId,
        parsed.scopeRecordId,
      )
    ));
    if (
      response.projectId !== projectId ||
      response.selectedRecordId !== (parsed.focusRecordId ?? null) ||
      response.scopeRecordId !== (parsed.scopeRecordId ?? null)
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/records\/(?<recordId>[^/]+)\/connected-detail$/,
  handle: ({ match, url }) => {
    noQuerySchema.parse(queryObject(url));
    const projectId = mapRouteId(match, "projectId");
    const recordId = mapRouteId(match, "recordId");
    const response = mapResponse(connectedRecordDetailResponseSchema, mapBoundary(() =>
      application.service.projectMap.getRecordDetail(
        projectId,
        recordId,
      )
    ));
    if (
      response.projectId !== projectId ||
      response.record.id !== recordId
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository\/tree$/,
  handle: ({ match, url }) => {
    const parsed = repositoryExplorerQuerySchema.parse(queryObject(url));
    const projectId = mapRouteId(match, "projectId");
    const {
      parentNodeId,
      pageSize,
      cursor,
      ...rawFilter
    } = parsed;
    const filter = rawFilter as unknown as RepositoryExplorerFilter;
    const request = {
      projectId,
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
    };
    const response = mapResponse(repositoryExplorerResponseSchema, mapBoundary(() =>
      application.service.projectMap.getRepositoryTree(request)
    ));
    const expectedParentNodeId = parentNodeId ?? null;
    const expectedPageSize = pageSize ?? 200;
    if (
      response.projectId !== projectId ||
      response.parentNodeId !== expectedParentNodeId ||
      response.request.parentNodeId !== expectedParentNodeId ||
      response.request.pageSize !== expectedPageSize ||
      JSON.stringify(response.request.filter) !== JSON.stringify(filter)
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/repository\/nodes\/(?<nodeId>[^/]+)\/connected-detail$/,
  handle: ({ match, url }) => {
    noQuerySchema.parse(queryObject(url));
    const projectId = mapRouteId(match, "projectId");
    const nodeId = mapRouteId(match, "nodeId");
    const response = mapResponse(connectedRepositoryDetailResponseSchema, mapBoundary(() =>
      application.service.projectMap.getRepositoryNodeDetail(
        projectId,
        nodeId,
      )
    ));
    if (
      response.projectId !== projectId ||
      response.node.nodeId !== nodeId
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/relationships$/,
  handle: ({ match, body }) => {
    const parsed = createRelationshipBodySchema.parse(body);
    const projectId = mapRouteId(match, "projectId");
    if (
      parsed.kind === "parent_of" &&
      parsed.fromRecordId === parsed.toRecordId
    ) {
      throw new ApiRouteError(
        409,
        "hierarchy_self_parent",
        "The requested hierarchy change conflicts with the current project map.",
      );
    }
    const relationship = mapBoundary(() =>
      application.service.createRelationship({ projectId, ...parsed })
    );
    const response = mapResponse(relationshipMutationResponseSchema, {
      projectRevision: application.service.getProjectSummary(projectId).project.revision,
      relationship,
    });
    if (
      response.projectRevision !== parsed.expectedProjectRevision + 1 ||
      response.relationship.projectId !== projectId ||
      response.relationship.fromRecordId !== parsed.fromRecordId ||
      response.relationship.toRecordId !== parsed.toRecordId ||
      response.relationship.kind !== parsed.kind
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "DELETE",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/relationships\/(?<relationshipId>[^/]+)$/,
  handle: ({ match, body }) => {
    const parsed = removeRelationshipBodySchema.parse(body);
    const projectId = mapRouteId(match, "projectId");
    const relationshipId = mapRouteId(match, "relationshipId");
    const relationship = mapBoundary(() => application.service.removeRelationship({
      projectId,
      relationshipId,
      expectedProjectRevision: parsed.expectedProjectRevision,
    }));
    const response = mapResponse(relationshipMutationResponseSchema, {
      projectRevision: application.service.getProjectSummary(projectId).project.revision,
      relationship,
    });
    if (
      response.projectRevision !== parsed.expectedProjectRevision + 1 ||
      response.relationship.projectId !== projectId ||
      response.relationship.id !== relationshipId
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/documents$/,
  handle: ({ match, url, headers }) => {
    rejectRange(headers);
    const projectId = decodeRouteParameter(match, "projectId");
    const filter = documentFilter(
      documentRegistryQuerySchema.parse(queryObject(url)),
    );
    const response = documentRegistryResponseSchema.parse(documentBoundary(() =>
      application.service.documents.list(
        projectId,
        filter,
      )
    ));
    if (response.projectId !== projectId) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/documents\/(?<nodeId>[^/]+)$/,
  handle: ({ match, url, headers }) => {
    rejectRange(headers);
    noQuerySchema.parse(queryObject(url));
    const projectId = decodeRouteParameter(match, "projectId");
    const nodeId = decodeRouteParameter(match, "nodeId");
    const detail = documentBoundary(() => application.service.documents.get(
      projectId,
      nodeId,
    ));
    const response = documentDetailResponseSchema.parse({
      ...detail,
      externalOpenAvailable: false,
    });
    if (
      response.document.projectId !== projectId ||
      response.document.nodeId !== nodeId
    ) rejectUnboundMapResponse();
    return response;
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/documents\/(?<nodeId>[^/]+)\/content$/,
  handle: ({ match, url, headers }) => {
    rejectRange(headers);
    const { expectedSnapshotId } = documentReadQuerySchema.parse(queryObject(url));
    const projectId = decodeRouteParameter(match, "projectId");
    const nodeId = decodeRouteParameter(match, "nodeId");
    const detail = documentBoundary(() => application.service.documents.get(projectId, nodeId));
    if (
      detail.document.projectId !== projectId ||
      detail.document.nodeId !== nodeId
    ) rejectUnboundMapResponse();
    if (detail.document.snapshotId !== expectedSnapshotId) {
      return documentError({ status: "stale" });
    }
    const result = documentBoundary(() => application.service.documents.read(
      projectId,
      nodeId,
      expectedSnapshotId,
    ));
    if (result.status !== "renderable") return documentError(result);
    return documentContentResponseSchema.parse({
      format: result.format,
      text: result.text,
      sha256: result.sha256,
    });
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/documents\/(?<nodeId>[^/]+)\/preview$/,
  handle: ({ match, url, headers }) => {
    rejectRange(headers);
    const { expectedSnapshotId } = documentReadQuerySchema.parse(queryObject(url));
    const projectId = decodeRouteParameter(match, "projectId");
    const nodeId = decodeRouteParameter(match, "nodeId");
    const detail = documentBoundary(() => application.service.documents.get(projectId, nodeId));
    if (
      detail.document.projectId !== projectId ||
      detail.document.nodeId !== nodeId
    ) rejectUnboundMapResponse();
    if (detail.document.snapshotId !== expectedSnapshotId) {
      return documentError({ status: "stale" });
    }
    const result = documentBoundary(() =>
      application.service.documents.readPreview(
        projectId,
        nodeId,
        expectedSnapshotId,
      )
    );
    if (result.status !== "previewable") return documentError(result);
    const mediaMatches = result.format === "pdf"
      ? result.mediaType === "application/pdf"
      : imageMediaTypes.has(result.mediaType);
    if (!mediaMatches) {
      throw new ApiRouteError(
        415,
        "document_media_mismatch",
        "The document bytes do not match the accepted preview format.",
      );
    }
    if (result.bytes.byteLength > MAX_PREVIEW_FILE_BYTES) {
      throw new ApiRouteError(
        413,
        "document_preview_too_large",
        "The document preview exceeds the supported size limit.",
      );
    }
    return new ApiBinaryResponse(result.bytes, result.mediaType);
  },
}, {
  method: "POST",
  pattern: /^\/api\/projects$/,
  handle: ({ body }) => {
    const parsed = createProjectBodySchema.parse(body);
    return {
      project: application.service.createProject({
        name: parsed.name,
        ...(parsed.primaryRepositoryPath === null
          ? {}
          : { primaryRepositoryPath: parsed.primaryRepositoryPath }),
      }),
    };
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/dashboard$/,
  handle: ({ match }) => {
    const projectId = decodeRouteParameter(match, "projectId");
    return mapResponse(
      projectDashboardResponseSchemaFor(projectId),
      application.service.views.getDashboard(projectId),
    );
  },
}, {
  method: "GET",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/proposals$/,
  handle: ({ match, url }) => {
    const { state } = proposalListQuery(url);
    return {
      proposals: application.service.proposals.list({
        projectId: decodeRouteParameter(match, "projectId"),
        ...(state ? { state } : {}),
      }).map(proposalSummaryDto),
    };
  },
}, {
  method: "GET",
  pattern: /^\/api\/proposals\/(?<proposalId>[^/]+)$/,
  handle: ({ match }) => ({
    proposal: proposalDetailDto(application.service.proposals.get(
      decodeRouteParameter(match, "proposalId"),
    )),
  }),
}, {
  method: "POST",
  pattern: /^\/api\/proposals\/(?<proposalId>[^/]+)\/accept$/,
  handle: ({ match, body }) => {
    acceptProposalBodySchema.parse(body);
    const proposalId = decodeRouteParameter(match, "proposalId");
    const result = application.service.proposals.accept(proposalId);
    const proposal = proposalSummaryDto(
      application.service.proposals.get(proposalId),
    );
    return result.outcome === "applied"
      ? {
          outcome: result.outcome,
          projectRevision: result.projectRevision,
          proposal,
        }
      : {
          outcome: result.outcome,
          currentProjectRevision: result.currentProjectRevision,
          explanation:
            "Project knowledge was unchanged because this proposal was based on an older revision.",
          proposal,
        };
  },
}, {
  method: "POST",
  pattern: /^\/api\/proposals\/(?<proposalId>[^/]+)\/reject$/,
  handle: ({ match, body }) => {
    const parsed = rejectProposalBodySchema.parse(body);
    return {
      proposal: proposalSummaryDto(application.service.proposals.reject({
        proposalId: decodeRouteParameter(match, "proposalId"),
        reason: parsed.reason,
      })),
    };
  },
}, {
  method: "GET",
  pattern:
    /^\/api\/projects\/(?<projectId>[^/]+)\/tasks\/(?<taskId>[^/]+)\/handoff$/,
  handle: ({ match }) => application.service.views.getTaskHandoff(
    decodeURIComponent(match.groups!.projectId!),
    decodeURIComponent(match.groups!.taskId!),
  ),
}, {
  method: "POST",
  pattern:
    /^\/api\/projects\/(?<projectId>[^/]+)\/tasks\/(?<taskId>[^/]+)\/context-requests$/,
  handle: ({ match, body }) => {
    const parsed = requestContextBodySchema.parse(body);
    const request = outboundBoundary(() =>
      application.service.outbound.requestAsLocalHuman(
      parsed.profileId,
      {
        projectId: decodeRouteParameter(match, "projectId"),
        taskId: decodeRouteParameter(match, "taskId"),
        budgetTokens: parsed.budgetTokens,
        idempotencyKey: parsed.idempotencyKey,
      },
      ),
    );
    if (request.status === "review_required") {
      return {
        request,
        inspection: outboundBoundary(() =>
          application.service.outbound.inspect(request.requestId)
        ),
        release: null,
      };
    }
    if (request.status === "released") {
      const released = outboundBoundary(() =>
        application.service.outbound.getReleasedAsLocalHuman(
          parsed.profileId,
          request.requestId,
        )
      );
      if (released.status !== "released") {
        throw validationFailure("The context request is not released");
      }
      return {
        request,
        inspection: null,
        release: released.release,
      };
    }
    return { request, inspection: null, release: null };
  },
}, {
  method: "GET",
  pattern: /^\/api\/context-requests\/(?<requestId>[^/]+)\/inspection$/,
  handle: ({ match }) => outboundBoundary(() =>
    application.service.outbound.inspect(
      decodeRouteParameter(match, "requestId"),
    )
  ),
}, {
  method: "POST",
  pattern: /^\/api\/context-requests\/(?<requestId>[^/]+)\/reveal$/,
  handle: ({ match, body }) => {
    const parsed = revealContextBodySchema.parse(body);
    return outboundBoundary(() =>
      application.service.outbound.reveal(
        decodeRouteParameter(match, "requestId"),
        parsed.findingId,
      )
    );
  },
}, {
  method: "POST",
  pattern: /^\/api\/context-requests\/(?<requestId>[^/]+)\/approve$/,
  handle: ({ match, body }) => {
    const parsed = approveContextBodySchema.parse(body);
    const release = outboundBoundary(() =>
      application.service.outbound.approve({
        requestId: decodeRouteParameter(match, "requestId"),
        rememberClean: parsed.rememberClean,
        includeFindingIds: parsed.includeFindingIds,
      })
    );
    return {
      release,
      export: formatBrowserChatExport(release),
    };
  },
}, {
  method: "POST",
  pattern: /^\/api\/context-requests\/(?<requestId>[^/]+)\/deny$/,
  handle: ({ match }) => outboundBoundary(() =>
    application.service.outbound.deny(
      decodeRouteParameter(match, "requestId"),
    )
  ),
}, {
  method: "GET",
  pattern: /^\/api\/context-requests\/(?<requestId>[^/]+)\/released$/,
  handle: ({ match }) => {
    const requestId = decodeRouteParameter(match, "requestId");
    const request = application.service.outbound.list({}).find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!request) throw validationFailure("Context request not found");
    const released = outboundBoundary(() =>
      application.service.outbound.getReleasedAsLocalHuman(
        request.profileId,
        requestId,
      )
    );
    if (released.status !== "released") {
      throw validationFailure("The context request is not released");
    }
    return {
      release: released.release,
      export: formatBrowserChatExport(released.release),
    };
  },
}, {
  method: "GET",
  pattern: /^\/api\/profiles$/,
  handle: () => ({
    profiles: application.service.profiles.listProfiles().map((summary) => {
      const destination = application.service.destinations.getCurrent(
        summary.profile.id,
      );
      return {
        profileId: summary.profile.id,
        name: summary.profile.name,
        status: summary.profile.status,
        executionMode: summary.profile.executionMode,
        projectIds: summary.authorities.map(
          ({ authority }) => authority.projectId,
        ),
        lastUsedAt: summary.profile.lastUsedAt,
        hasDestination: destination?.status === "enabled",
      };
    }),
  }),
}, {
  method: "POST",
  pattern: /^\/api\/projects\/(?<projectId>[^/]+)\/profiles$/,
  handle: ({ match, body }) => {
    const projectId = decodeRouteParameter(match, "projectId");
    const parsed = projectProfileBodySchema.parse(body);
    return application.service.profileSetup.configure(projectId, parsed);
  },
}];
};
