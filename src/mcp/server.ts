import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  IntentArcService,
  ProjectSummary,
} from "../core/intentarc-service.js";
import type { ProjectConstrainedCoordinationService } from "../core/coordination-service.js";
import {
  acceptedDelegationResultMatches,
  CoordinationError,
  GovernanceError,
  CorruptStoredContextPackError,
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  changeOperationSchema,
  changeOutcomeSchema,
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  checkpointResultMatches,
  checkpointResultSchema,
  claimTaskInputSchema,
  claimTaskResultMatches,
  claimTaskResultSchema,
  coordinationStateInputSchema,
  coordinationStateMatches,
  coordinationStateSchema,
  createDelegationInputSchema,
  createdDelegationResultMatches,
  delegationResultSchema,
  listReadyTasksInputSchema,
  readyTaskPageSchema,
  readyTaskPageMatches,
  renewClaimInputSchema,
  renewClaimResultMatches,
  renewClaimResultSchema,
  revokeDelegationInputSchema,
  revokedDelegationResultMatches,
  submissionResultSchema,
  submissionResultMatches,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  switchTaskResultMatches,
  switchTaskResultSchema,
  transitionClaimInputSchema,
  transitionClaimResultMatches,
  transitionClaimResultSchema,
  proposalStateSchema,
  projectRecordSchema,
  projectSchema,
  recordRelationshipSchema,
  recordKindSchema,
  getReleasedContextResultSchema,
  outboundReleaseSchema,
  outboundRequestStatusSchema,
  outboundRequestSummarySchema,
  requestTaskContextInputSchema,
  requestTaskContextResultSchema,
  submitChangeSetInputSchema,
  type AuthenticatedProfile,
  type SubmitChangeSetInput,
} from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const nonDestructiveMutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const destructiveMutationAnnotations: ToolAnnotations = {
  ...nonDestructiveMutationAnnotations,
  destructiveHint: true,
};

const expiryProjectionAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const coordinationCapabilityLimit =
  "IntentArc does not launch agents or execute repository work.";

const transitionClaimMcpInputSchema = z.object({
  ...transitionClaimInputSchema.options[0].shape,
  action: z.enum(["pause", "release"]),
}).strict();

const identifierSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const replayedSchema = z.boolean();
const governanceErrorCodeSchema = z.enum([
  "profile_required",
  "invalid_profile_credentials",
  "profile_disabled",
  "project_authority_missing",
  "operation_denied",
  "validation_failed",
  "project_revision_conflict",
  "record_revision_conflict",
  "proposal_not_pending",
  "proposal_conflicted",
  "idempotency_conflict",
  "unsupported_operation",
  "internal_error",
]);

const listProjectsOutputSchema = z
  .object({ projects: z.array(projectSchema) })
  .strict();

const projectSummarySchema: z.ZodType<ProjectSummary> = z
  .object({
    project: projectSchema,
    recordsByKind: z.partialRecord(
      recordKindSchema,
      z.number().int().nonnegative(),
    ),
    activeTasks: z.array(
      projectRecordSchema.pick({
        id: true,
        title: true,
        status: true,
      }),
    ),
  })
  .strict();

const appliedOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      operationId: identifierSchema,
      type: z.literal("create_record"),
      record: projectRecordSchema,
    })
    .strict(),
  z
    .object({
      operationId: identifierSchema,
      type: z.literal("update_record"),
      record: projectRecordSchema,
    })
    .strict(),
  z
    .object({
      operationId: identifierSchema,
      type: z.literal("create_relationship"),
      relationship: recordRelationshipSchema,
    })
    .strict(),
  z
    .object({
      operationId: identifierSchema,
      type: z.literal("remove_relationship"),
      relationship: recordRelationshipSchema,
    })
    .strict(),
]);

const appliedSubmissionResultSchema = z
  .object({
    outcome: z.literal("applied"),
    changeId: identifierSchema,
    projectRevision: positiveIntegerSchema,
    operations: z.array(appliedOperationSchema),
    replayed: replayedSchema,
  })
  .strict();
const proposedSubmissionResultSchema = z
  .object({
    outcome: z.literal("proposed"),
    changeId: identifierSchema,
    proposalId: identifierSchema,
    state: z.literal("pending"),
    replayed: replayedSchema,
  })
  .strict();
const conflictedSubmissionResultSchema = z
  .object({
    outcome: z.literal("conflicted"),
    changeId: identifierSchema,
    proposalId: identifierSchema.optional(),
    currentProjectRevision: nonNegativeIntegerSchema,
    replayed: replayedSchema,
  })
  .strict();
const rejectedSubmissionResultSchema = z
  .object({
    outcome: z.literal("rejected"),
    changeId: identifierSchema.optional(),
    code: governanceErrorCodeSchema,
    reason: identifierSchema,
    replayed: replayedSchema,
  })
  .strict();
const changeSubmissionResultUnionSchema = z.discriminatedUnion("outcome", [
  appliedSubmissionResultSchema,
  proposedSubmissionResultSchema,
  conflictedSubmissionResultSchema,
  rejectedSubmissionResultSchema,
]);
const changeSubmissionResultSchema = z
  .object({
    outcome: z.enum(["applied", "proposed", "conflicted", "rejected"]),
    changeId: identifierSchema.optional(),
    projectRevision: positiveIntegerSchema.optional(),
    operations: z.array(appliedOperationSchema).optional(),
    replayed: replayedSchema,
    proposalId: identifierSchema.optional(),
    state: z.literal("pending").optional(),
    currentProjectRevision: nonNegativeIntegerSchema.optional(),
    code: governanceErrorCodeSchema.optional(),
    reason: identifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = changeSubmissionResultUnionSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid governed change submission result",
      });
    }
  });

const storedAppliedDirectResultSchema = z
  .object({
    outcome: z.literal("applied"),
    changeId: identifierSchema,
    projectId: identifierSchema,
    revisionBefore: nonNegativeIntegerSchema,
    revisionAfter: positiveIntegerSchema,
    operations: z.array(appliedOperationSchema),
    replayed: replayedSchema,
  })
  .strict();
const storedAppliedProposalResultSchema = z
  .object({
    outcome: z.literal("applied"),
    changeId: identifierSchema,
    proposalId: identifierSchema,
    projectRevision: positiveIntegerSchema,
    operations: z.array(appliedOperationSchema),
    replayed: replayedSchema,
  })
  .strict();
const storedProposalResultSchema = proposedSubmissionResultSchema;
const storedProposalConflictResultSchema = z
  .object({
    outcome: z.literal("conflicted"),
    changeId: identifierSchema,
    proposalId: identifierSchema,
    state: z.literal("conflicted"),
    currentProjectRevision: nonNegativeIntegerSchema,
    replayed: replayedSchema,
  })
  .strict();
const storedDirectConflictResultSchema = z
  .object({
    outcome: z.literal("conflicted"),
    changeId: identifierSchema,
    code: z.enum([
      "project_revision_conflict",
      "record_revision_conflict",
    ]),
    currentProjectRevision: nonNegativeIntegerSchema,
    expectedProjectRevision: nonNegativeIntegerSchema.optional(),
    recordId: identifierSchema.optional(),
    expectedRecordRevision: positiveIntegerSchema.optional(),
    actualRecordRevision: positiveIntegerSchema.optional(),
    replayed: replayedSchema,
  })
  .strict();
const storedProposalRejectionResultSchema = z
  .object({
    outcome: z.literal("rejected"),
    changeId: identifierSchema,
    code: z.literal("operation_denied"),
    reason: identifierSchema,
    replayed: replayedSchema,
  })
  .strict();
const storedAuthorityRejectionResultSchema = z
  .object({
    outcome: z.literal("rejected"),
    changeId: identifierSchema,
    code: z.literal("project_authority_missing"),
    reason: z.literal("project_authority_missing"),
    replayed: z.literal(false),
  })
  .strict();
const storedSubmissionResultSchema = z.union([
  storedAppliedDirectResultSchema,
  storedAppliedProposalResultSchema,
  storedProposalResultSchema,
  storedProposalConflictResultSchema,
  storedDirectConflictResultSchema,
  storedProposalRejectionResultSchema,
  storedAuthorityRejectionResultSchema,
]);

const profileChangeSummarySchema = z
  .object({
    changeId: identifierSchema,
    profileId: identifierSchema,
    projectId: identifierSchema,
    outcome: changeOutcomeSchema,
    proposalId: identifierSchema.nullable(),
    state: proposalStateSchema.nullable(),
    createdAt: identifierSchema,
  })
  .strict();
const changeProposalDetailSchema = z
  .object({
    id: identifierSchema,
    projectId: identifierSchema,
    origin: z.object({
      type: z.literal("profile"),
      profileId: identifierSchema,
    }).strict(),
    sourceTaskId: identifierSchema.nullable(),
    predecessorProposalId: identifierSchema.nullable(),
    baseProjectRevision: nonNegativeIntegerSchema,
    state: proposalStateSchema,
    rationale: identifierSchema,
    idempotencyKey: identifierSchema.max(128),
    requestHash: identifierSchema,
    reviewReason: identifierSchema.nullable(),
    reviewerActor: identifierSchema.nullable(),
    createdAt: identifierSchema,
    updatedAt: identifierSchema,
    reviewedAt: identifierSchema.nullable(),
    operations: z.array(changeOperationSchema),
  })
  .strict();
const profileChangeDetailSchema = profileChangeSummarySchema
  .extend({
    idempotencyKey: identifierSchema,
    result: storedSubmissionResultSchema,
    proposal: changeProposalDetailSchema.optional(),
  })
  .strict();
const listMyChangesOutputSchema = z
  .object({
    changes: z.array(profileChangeSummarySchema),
  })
  .strict();
const getMyChangeOutputSchema = z
  .object({
    change: profileChangeDetailSchema,
  })
  .strict();
const releasedContextOutputSchema = z
  .object({
    status: outboundRequestStatusSchema,
    release: outboundReleaseSchema.optional(),
    request: outboundRequestSummarySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!getReleasedContextResultSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "Invalid released context result",
      });
    }
  })
  // MCP SDK 1.29 only publishes root object schemas. Keep the object adapter
  // exact for clients by expressing the Task 1 discriminated union in JSON
  // Schema metadata while superRefine enforces the same union at runtime.
  .meta({
    oneOf: [
      {
        properties: { status: { const: "released" } },
        required: ["status", "release"],
        not: { required: ["request"] },
      },
      {
        properties: { status: { const: "review_required" } },
        required: ["status", "request"],
        not: { required: ["release"] },
      },
      {
        properties: { status: { const: "denied" } },
        required: ["status", "request"],
        not: { required: ["release"] },
      },
    ],
  });

const jsonResult = (value: object): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const anonymousFailureText = "IntentArc request failed.";
const authenticatedFailureText = "internal_error";

const safeDomainErrorMessage = (error: unknown): string | undefined => {
  try {
    if (error instanceof CoordinationError) {
      return new CoordinationError(error.code).code;
    }
  } catch {
    return "coordination_unavailable";
  }
  if (error instanceof OutboundSafetyError) {
    return error.code;
  }
  if (error instanceof GovernanceError) {
    return error.code === "internal_error" ? undefined : error.message;
  }
  if (
    error instanceof ProjectNotFoundError ||
    error instanceof RecordNotFoundError ||
    error instanceof InvalidTaskError ||
    error instanceof CorruptStoredContextPackError
  ) {
    return error.message;
  }
  return undefined;
};

const errorResult = (
  error: unknown,
  fallbackText: string,
): CallToolResult => ({
  content: [
    {
      type: "text",
      text: safeDomainErrorMessage(error) ?? fallbackText,
    },
  ],
  isError: true,
});

const invoke = <Output extends object>(
  outputSchema: z.ZodType<Output>,
  operation: () => unknown,
  fallbackText: string,
): CallToolResult => {
  try {
    return jsonResult(outputSchema.parse(operation()));
  } catch (error) {
    return errorResult(error, fallbackText);
  }
};

const invokeAnonymous = <Output extends object>(
  outputSchema: z.ZodType<Output>,
  operation: () => unknown,
): CallToolResult => invoke(outputSchema, operation, anonymousFailureText);

const invokeAuthenticated = <Output extends object>(
  outputSchema: z.ZodType<Output>,
  operation: () => unknown,
): CallToolResult => invoke(outputSchema, operation, authenticatedFailureText);

const boundCoordinationResult = <Output>(output: Output, matches: boolean): Output => {
  if (!matches) throw new Error("Invalid coordination service result");
  return output;
};

export const createIntentArcMcpServer = (
  service: IntentArcService,
  principal: AuthenticatedProfile | null = null,
): McpServer => {
  const server = new McpServer({
    name: "intentarc",
    version: "0.0.0",
  });
  const constrainedCoordination = service.coordination as ProjectConstrainedCoordinationService;

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List the authoritative IntentArc projects.",
      inputSchema: z.object({}).strict(),
      outputSchema: listProjectsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    () =>
      invokeAnonymous(listProjectsOutputSchema, () => ({
        projects: service.listProjects(),
      })),
  );

  server.registerTool(
    "get_project_summary",
    {
      title: "Get project summary",
      description:
        "Get an authoritative project with record counts and active tasks.",
      inputSchema: z.object({ projectId: identifierSchema }).strict(),
      outputSchema: projectSummarySchema,
      annotations: readOnlyAnnotations,
    },
    ({ projectId }) =>
      invokeAnonymous(
        projectSummarySchema,
        () => service.getProjectSummary(projectId),
      ),
  );

  if (principal) {
    server.registerTool(
      "submit_change_set",
      {
        title: "Submit governed change set",
        description:
          "Submit an idempotent governed change set as the authenticated profile.",
        inputSchema: submitChangeSetInputSchema,
        outputSchema: changeSubmissionResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) =>
        invokeAuthenticated(changeSubmissionResultSchema, () => {
          const currentPrincipal =
            service.profiles.revalidatePrincipal(principal);
          return service.submitChangeSet(
            currentPrincipal,
            submitChangeSetInputSchema.parse(input) as SubmitChangeSetInput,
          );
        }),
    );

    server.registerTool(
      "list_my_changes",
      {
        title: "List my changes",
        description:
          "List change submissions owned by the authenticated profile for a project.",
        inputSchema: z.object({ projectId: identifierSchema }).strict(),
        outputSchema: listMyChangesOutputSchema,
        annotations: readOnlyAnnotations,
      },
      ({ projectId }) =>
        invokeAuthenticated(listMyChangesOutputSchema, () => {
          const currentPrincipal =
            service.profiles.revalidatePrincipal(principal);
          return {
            changes: service.listMyChanges(currentPrincipal.id, projectId),
          };
        }),
    );

    server.registerTool(
      "get_my_change",
      {
        title: "Get my change",
        description:
          "Get one change submission owned by the authenticated profile.",
        inputSchema: z.object({ changeId: identifierSchema }).strict(),
        outputSchema: getMyChangeOutputSchema,
        annotations: readOnlyAnnotations,
      },
      ({ changeId }) =>
        invokeAuthenticated(getMyChangeOutputSchema, () => {
          const currentPrincipal =
            service.profiles.revalidatePrincipal(principal);
          return {
            change: service.getMyChange(currentPrincipal.id, changeId),
          };
        }),
    );

    server.registerTool(
      "request_task_context",
      {
        title: "Request task context",
        description:
          "Prepare and safety-check a task context for the configured destination.",
        inputSchema: requestTaskContextInputSchema,
        outputSchema: requestTaskContextResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) =>
        invokeAuthenticated(requestTaskContextResultSchema, () => {
          const current = service.profiles.revalidatePrincipal(principal);
          return service.outbound.request(
            current,
            requestTaskContextInputSchema.parse(input),
          );
        }),
    );

    server.registerTool(
      "get_released_context",
      {
        title: "Get released context",
        description:
          "Retrieve an immutable context artifact after outbound release.",
        inputSchema: z.object({ requestId: identifierSchema }).strict(),
        outputSchema: releasedContextOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      ({ requestId }) =>
        invokeAuthenticated(releasedContextOutputSchema, () => {
          const current = service.profiles.revalidatePrincipal(principal);
          return service.outbound.getReleased(current, requestId);
        }),
    );

    server.registerTool(
      "list_ready_tasks",
      {
        title: "List ready tasks",
        description:
          `List coordination-ready tasks for the authenticated profile. This read may persist elapsed claim or delegation expiry and append expiry events. ${coordinationCapabilityLimit}`,
        inputSchema: listReadyTasksInputSchema,
        outputSchema: readyTaskPageSchema,
        annotations: expiryProjectionAnnotations,
      },
      (input) =>
        invokeAuthenticated(readyTaskPageSchema, () => {
          const parsed = listReadyTasksInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const output = service.coordination.listReadyTasks(parsed, current);
          return boundCoordinationResult(output, readyTaskPageMatches(output, parsed));
        }),
    );

    server.registerTool(
      "get_coordination_state",
      {
        title: "Get coordination state",
        description:
          `Get authoritative coordination state for one task. This read may persist elapsed claim or delegation expiry and append expiry events. ${coordinationCapabilityLimit}`,
        inputSchema: coordinationStateInputSchema,
        outputSchema: coordinationStateSchema,
        annotations: expiryProjectionAnnotations,
      },
      (input) =>
        invokeAuthenticated(coordinationStateSchema, () => {
          const parsed = coordinationStateInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const output = service.coordination.getCoordinationState(parsed, current);
          return boundCoordinationResult(output, coordinationStateMatches(output, parsed));
        }),
    );

    server.registerTool(
      "claim_task",
      {
        title: "Claim task",
        description:
          `Claim one ready task for the authenticated profile. ${coordinationCapabilityLimit}`,
        inputSchema: claimTaskInputSchema,
        outputSchema: claimTaskResultSchema,
        annotations: nonDestructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(claimTaskResultSchema, () => {
          const parsed = claimTaskInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const output = service.coordination.claimTask(parsed, current);
          return boundCoordinationResult(output, claimTaskResultMatches(output, parsed, current.id));
        }),
    );

    server.registerTool(
      "renew_task_claim",
      {
        title: "Renew task claim",
        description:
          `Renew an owned active task claim. ${coordinationCapabilityLimit}`,
        inputSchema: renewClaimInputSchema,
        outputSchema: renewClaimResultSchema,
        annotations: nonDestructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(renewClaimResultSchema, () => {
          const parsed = renewClaimInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const snapshot = constrainedCoordination.resolveOwnedClaimSnapshot(parsed.claimId, current);
          const output = constrainedCoordination.renewClaim(
            parsed,
            current,
            { expectedProjectId: snapshot.projectId },
          );
          return boundCoordinationResult(
            output,
            renewClaimResultMatches(output, parsed, current.id, snapshot),
          );
        }),
    );

    server.registerTool(
      "checkpoint_task",
      {
        title: "Checkpoint task",
        description:
          `Append an immutable checkpoint to an owned task claim. ${coordinationCapabilityLimit}`,
        inputSchema: checkpointClaimInputSchema,
        outputSchema: checkpointResultSchema,
        annotations: nonDestructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(checkpointResultSchema, () => {
          const parsed = checkpointClaimInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const snapshot = constrainedCoordination.resolveOwnedClaimSnapshot(parsed.claimId, current);
          const output = constrainedCoordination.checkpointClaim(
            parsed,
            current,
            { expectedProjectId: snapshot.projectId },
          );
          return boundCoordinationResult(
            output,
            checkpointResultMatches(output, parsed, current.id, snapshot),
          );
        }),
    );

    server.registerTool(
      "transition_task_claim",
      {
        title: "Transition task claim",
        description:
          `Pause or release an owned task claim. ${coordinationCapabilityLimit}`,
        // MCP SDK 1.29 does not publish a closed root discriminated-union
        // schema. This object adapter reuses the authoritative branch fields;
        // the handler still parses the Task 1 discriminated union.
        inputSchema: transitionClaimMcpInputSchema,
        outputSchema: transitionClaimResultSchema,
        annotations: destructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(transitionClaimResultSchema, () => {
          const parsed = transitionClaimInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const snapshot = constrainedCoordination.resolveOwnedClaimSnapshot(parsed.claimId, current);
          const output = constrainedCoordination.transitionClaim(
            parsed,
            current,
            { expectedProjectId: snapshot.projectId },
          );
          return boundCoordinationResult(
            output,
            transitionClaimResultMatches(output, parsed, current.id, snapshot),
          );
        }),
    );

    server.registerTool(
      "switch_task",
      {
        title: "Switch task",
        description:
          `Atomically checkpoint the current claim and switch tasks. ${coordinationCapabilityLimit}`,
        inputSchema: switchTaskInputSchema,
        outputSchema: switchTaskResultSchema,
        annotations: destructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(switchTaskResultSchema, () => {
          const parsed = switchTaskInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const snapshot = constrainedCoordination.resolveOwnedClaimSnapshot(
            parsed.currentClaimId,
            current,
          );
          const output = service.coordination.switchTask(parsed, current);
          return boundCoordinationResult(
            output,
            switchTaskResultMatches(output, parsed, current.id, snapshot),
          );
        }),
    );

    server.registerTool(
      "delegate_task",
      {
        title: "Delegate task",
        description:
          `Offer a bounded task delegation to another profile. ${coordinationCapabilityLimit}`,
        inputSchema: createDelegationInputSchema,
        outputSchema: delegationResultSchema,
        annotations: nonDestructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(delegationResultSchema, () => {
          const parsed = createDelegationInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const output = service.coordination.createDelegation(parsed, current);
          return boundCoordinationResult(output, createdDelegationResultMatches(output, parsed, current.id));
        }),
    );

    server.registerTool(
      "accept_task_delegation",
      {
        title: "Accept task delegation",
        description:
          `Accept a bounded delegation as its authenticated child profile. ${coordinationCapabilityLimit}`,
        inputSchema: acceptDelegationInputSchema,
        outputSchema: delegationResultSchema,
        annotations: nonDestructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(delegationResultSchema, () => {
          const parsed = acceptDelegationInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const expected = constrainedCoordination.resolveAuthorizedDelegation(
            parsed,
            current,
            "child",
          );
          const output = service.coordination.acceptDelegation(parsed, current);
          return boundCoordinationResult(
            output,
            acceptedDelegationResultMatches(output, parsed, current.id, expected),
          );
        }),
    );

    server.registerTool(
      "revoke_task_delegation",
      {
        title: "Revoke task delegation",
        description:
          `Revoke an offered task delegation as its parent profile. ${coordinationCapabilityLimit}`,
        inputSchema: revokeDelegationInputSchema,
        outputSchema: delegationResultSchema,
        annotations: destructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(delegationResultSchema, () => {
          const parsed = revokeDelegationInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const expected = constrainedCoordination.resolveAuthorizedDelegation(
            parsed,
            current,
            "parent",
          );
          const output = service.coordination.revokeDelegation(parsed, current);
          return boundCoordinationResult(
            output,
            revokedDelegationResultMatches(output, parsed, current.id, expected),
          );
        }),
    );

    server.registerTool(
      "submit_task_result",
      {
        title: "Submit task result",
        description:
          `Submit an owned task result through governed reconciliation. ${coordinationCapabilityLimit}`,
        inputSchema: submitTaskResultInputSchema,
        outputSchema: submissionResultSchema,
        annotations: destructiveMutationAnnotations,
      },
      (input) =>
        invokeAuthenticated(submissionResultSchema, () => {
          const parsed = submitTaskResultInputSchema.parse(input);
          const current = service.profiles.revalidatePrincipal(principal);
          const snapshot = constrainedCoordination.resolveOwnedClaimSnapshot(parsed.claimId, current);
          const output = constrainedCoordination.submitTaskResult(
            parsed,
            current,
            { expectedProjectId: snapshot.projectId },
          );
          return boundCoordinationResult(
            output,
            submissionResultMatches(output, parsed, current.id, snapshot),
          );
        }),
    );
  }

  return server;
};
