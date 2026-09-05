import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  InMemoryTransport,
  type InMemoryTransport as InMemoryTransportInstance,
} from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  openIntentArcApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import type {
  IntentArcService,
  ProjectSummary,
} from "../core/intentarc-service.js";
import {
  type AuthenticatedProfile,
  CoordinationError,
  GovernanceError,
  ProjectNotFoundError,
  type OutboundRelease,
  type OutboundRequestSummary,
  type Project,
  type ProjectRecord,
  type RequestTaskContextInput,
  type SubmitChangeSetInput,
  type TaskContextPack,
} from "../domain/index.js";
import type { ChangeSubmissionResult } from "../core/change-service.js";
import { createLeaseManager } from "../durability/leases.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import { openDatabase } from "../storage/database.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { isMainModule } from "../system/main-module.js";
import { runIntentArcMcp } from "./bin.js";
import { createIntentArcMcpServer } from "./server.js";

const project: Project = {
  id: "project-1",
  name: "IntentArc",
  revision: 4,
  primaryRepositoryPath: "C:\\projects\\IntentArc",
  createdAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:03:00.000Z",
};

const taskRecord: ProjectRecord = {
  id: "record-task",
  projectId: project.id,
  kind: "task",
  status: "active",
  title: "Expose MCP context",
  body: "Publish the read-only portability boundary.",
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: "2026-07-26T12:01:00.000Z",
  updatedAt: "2026-07-26T12:01:00.000Z",
};

const summary: ProjectSummary = {
  project,
  recordsByKind: { vision: 1, task: 1, decision: 2 },
  activeTasks: [
    {
      id: taskRecord.id,
      title: taskRecord.title,
      status: taskRecord.status,
    },
  ],
};

const pack: TaskContextPack = {
  id: "context-1",
  projectId: project.id,
  taskId: taskRecord.id,
  projectRevision: project.revision,
  generatedAt: "2026-07-26T12:04:00.000Z",
  budgetTokens: 1_200,
  estimatedTokens: 48,
  hierarchyVocabulary: {
    preset: "neutral",
    outcome: "Goal",
    initiative: "Workstream",
    deliverable: "Result",
    milestone: "Checkpoint",
    task: "Action",
    nestedTask: "Step",
  },
  stableFrame: [],
  task: {
    record: taskRecord,
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  },
  related: [],
  omissions: [],
  sourceRevisions: [{ recordId: taskRecord.id, revision: taskRecord.revision }],
};

const outboundRequest: OutboundRequestSummary = {
  requestId: "outbound-request-1",
  profileId: "profile-authenticated",
  projectId: project.id,
  taskId: taskRecord.id,
  sourcePackId: pack.id,
  destination: {
    id: "destination-1",
    revision: 1,
    clientLabel: "Local MCP client",
    type: "ide_managed",
    providerLabel: "Synthetic provider",
    modelLabel: "Synthetic model",
    accountBoundaryLabel: "Synthetic account",
    dataBoundary: "remote",
  },
  status: "review_required",
  projectRevision: project.revision,
  budgetTokens: pack.budgetTokens,
  originalEstimatedTokens: pack.estimatedTokens,
  findingCounts: {
    total: 2,
    credential: 1,
    sensitive: 1,
    forcedRedact: 1,
    redactByDefault: 1,
    redacted: 0,
    includedOnce: 0,
  },
  detectorVersion: "detector-v1",
  safetyPolicyVersion: "policy-v1",
  releaseId: null,
  createdAt: "2026-07-27T12:05:00.000Z",
  decidedAt: null,
};

const outboundRelease: OutboundRelease = {
  releaseId: "outbound-release-1",
  requestId: outboundRequest.requestId,
  sourcePackId: pack.id,
  releasedAt: "2026-07-27T12:06:00.000Z",
  sha256: "a".repeat(64),
  disclosure: {
    destination: outboundRequest.destination,
    sourcePackId: pack.id,
    projectId: project.id,
    taskId: taskRecord.id,
    projectRevision: project.revision,
    sourceRecords: [{
      recordId: taskRecord.id,
      kind: taskRecord.kind,
      revision: taskRecord.revision,
      sourceKind: taskRecord.sourceKind,
      sourceRef: taskRecord.sourceRef,
    }],
    omissions: [],
    requestedBudgetTokens: pack.budgetTokens,
    originalEstimatedTokens: pack.estimatedTokens,
    releasedEstimatedTokens: pack.estimatedTokens,
    findingCounts: outboundRequest.findingCounts,
    detectorVersion: outboundRequest.detectorVersion,
    safetyPolicyVersion: outboundRequest.safetyPolicyVersion,
    releaseDigest: "a".repeat(64),
    releasedAt: "2026-07-27T12:06:00.000Z",
  },
  pack,
};

const authenticatedPrincipal: AuthenticatedProfile = {
  id: "profile-authenticated",
  name: "Authenticated agent",
  status: "enabled",
  credentialGeneration: "2026-07-27T12:00:00.000Z",
};

const submissionInput: SubmitChangeSetInput = {
  projectId: project.id,
  baseProjectRevision: project.revision,
  idempotencyKey: "mcp-change-1",
  rationale: "Exercise the authenticated MCP boundary.",
  sourceTaskId: null,
  predecessorProposalId: null,
  operations: [{
    operationId: "create-decision",
    type: "create_record",
    kind: "decision",
    status: "provisional",
    title: "Governed MCP decision",
    body: "Return the complete governed submission result.",
  }],
};

const coordinationTimestamp = "2026-08-15T08:00:00.000Z";
const coordinationReadiness = {
  task: { ...taskRecord, projectId: project.id },
  blockers: [],
  liveClaimId: null,
  liveDelegationId: null,
};
const coordinationClaim = {
  id: "claim-1",
  projectId: project.id,
  taskId: taskRecord.id,
  profileId: authenticatedPrincipal.id,
  delegationId: null,
  state: "active" as const,
  baseProjectRevision: project.revision,
  baseTaskRevision: taskRecord.revision,
  contextPackId: pack.id,
  acquiredAt: coordinationTimestamp,
  expiresAt: "2026-08-15T08:30:00.000Z",
  absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
  endedAt: null,
  latestCheckpointId: null,
};
const coordinationClaimEvent = {
  id: "event-claim-1",
  category: "claim" as const,
  projectId: coordinationClaim.projectId,
  taskId: coordinationClaim.taskId,
  profileId: coordinationClaim.profileId,
  claimId: coordinationClaim.id,
  delegationId: null,
  checkpointId: null,
  submissionId: null,
  proposalId: null,
  priorState: null,
  resultingState: "active",
  projectRevision: coordinationClaim.baseProjectRevision,
  taskRevision: coordinationClaim.baseTaskRevision,
  detail: null,
  createdAt: coordinationClaim.acquiredAt,
};
const coordinationCheckpointDocument = {
  summary: "Implemented the MCP coordination boundary.",
  completedWork: ["Added authenticated tools."],
  remainingWork: ["Run verification."],
  blockers: [],
  verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
  repositoryEvidence: null,
};
const coordinationCheckpoint = {
  ...coordinationCheckpointDocument,
  id: "checkpoint-1",
  claimId: coordinationClaim.id,
  sequence: 1,
  createdAt: coordinationTimestamp,
  projectRevision: project.revision,
  taskRevision: taskRecord.revision,
  contextPackId: pack.id,
};
const coordinationDelegation = {
  id: "delegation-1",
  projectId: project.id,
  taskId: taskRecord.id,
  parentProfileId: authenticatedPrincipal.id,
  childProfileId: "profile-child",
  state: "offered" as const,
  baseProjectRevision: project.revision,
  baseTaskRevision: taskRecord.revision,
  scope: { summary: "Implement Task 9.", constraints: [] },
  allowedOutputs: ["create_record", "update_record"],
  offeredAt: coordinationTimestamp,
  deadline: "2026-08-15T10:00:00.000Z",
  acceptedAt: null,
  endedAt: null,
  claimId: null,
};
const coordinationProposal = {
  id: "proposal-1",
  projectId: project.id,
  origin: { type: "profile" as const, profileId: authenticatedPrincipal.id },
  sourceTaskId: taskRecord.id,
  predecessorProposalId: null,
  baseProjectRevision: project.revision,
  state: "pending" as const,
  rationale: "Complete the coordinated task.",
  idempotencyKey: "coordination:submit-1",
  requestHash: "a".repeat(64),
  reviewReason: null,
  reviewerActor: null,
  createdAt: coordinationTimestamp,
  updatedAt: coordinationTimestamp,
  reviewedAt: null,
};
const coordinationSubmission = {
  id: "submission-1",
  claimId: coordinationClaim.id,
  checkpointId: coordinationCheckpoint.id,
  profileId: authenticatedPrincipal.id,
  projectId: project.id,
  taskId: taskRecord.id,
  baseProjectRevision: project.revision,
  baseTaskRevision: taskRecord.revision,
  contextPackId: pack.id,
  summary: "Task 9 is complete.",
  verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
  repositoryEvidence: null,
  proposalId: coordinationProposal.id,
  state: "submitted" as const,
  submittedAt: coordinationTimestamp,
  decidedAt: null,
};
const coordinationInputs = {
  listReadyTasks: {
    projectId: project.id,
    expectedProjectRevision: project.revision,
    cursor: null,
    limit: 20,
  },
  getCoordinationState: {
    projectId: project.id,
    taskId: taskRecord.id,
    expectedProjectRevision: project.revision,
  },
  claimTask: {
    projectId: project.id,
    taskId: taskRecord.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    contextBudgetTokens: 1_200,
    acceptedDelegationId: null,
    idempotencyKey: "claim-1",
  },
  renewClaim: {
    claimId: coordinationClaim.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    idempotencyKey: "renew-1",
  },
  checkpointClaim: {
    claimId: coordinationClaim.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    checkpoint: coordinationCheckpointDocument,
    idempotencyKey: "checkpoint-1",
  },
  transitionClaim: {
    claimId: coordinationClaim.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    action: "pause" as const,
    idempotencyKey: "transition-1",
  },
  switchTask: {
    currentClaimId: coordinationClaim.id,
    projectId: project.id,
    currentTaskId: taskRecord.id,
    expectedCurrentProjectRevision: project.revision,
    expectedCurrentTaskRevision: taskRecord.revision,
    checkpoint: coordinationCheckpointDocument,
    terminalAction: "pause" as const,
    nextTaskId: "record-next",
    expectedNextProjectRevision: project.revision,
    expectedNextTaskRevision: 1,
    nextContextBudgetTokens: 1_200,
    acceptedDelegationId: null,
    idempotencyKey: "switch-1",
  },
  createDelegation: {
    projectId: project.id,
    taskId: taskRecord.id,
    childProfileId: "profile-child",
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    scope: coordinationDelegation.scope,
    allowedOutputs: coordinationDelegation.allowedOutputs,
    deadline: coordinationDelegation.deadline,
    idempotencyKey: "delegate-1",
  },
  acceptDelegation: {
    delegationId: coordinationDelegation.id,
    projectId: project.id,
    taskId: taskRecord.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    idempotencyKey: "accept-1",
  },
  revokeDelegation: {
    delegationId: coordinationDelegation.id,
    projectId: project.id,
    taskId: taskRecord.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    idempotencyKey: "revoke-1",
  },
  submitTaskResult: {
    claimId: coordinationClaim.id,
    checkpointId: coordinationCheckpoint.id,
    expectedProjectRevision: project.revision,
    expectedTaskRevision: taskRecord.revision,
    submission: {
      summary: coordinationSubmission.summary,
      verificationEvidence: coordinationSubmission.verificationEvidence,
      repositoryEvidence: null,
      changes: {
        rationale: coordinationProposal.rationale,
        operations: [],
      },
    },
    idempotencyKey: "submit-1",
  },
};

const coordinationOutputs = {
  listReadyTasks: {
    tasks: [coordinationReadiness],
    nextCursor: null,
    projectRevision: project.revision,
  },
  getCoordinationState: {
    projectRevision: project.revision,
    task: taskRecord,
    claim: coordinationClaim,
    delegation: null,
    latestCheckpoint: null,
    submission: null,
    events: [coordinationClaimEvent],
  },
  claimTask: {
    claim: coordinationClaim,
    readiness: coordinationReadiness,
    contextPack: pack,
  },
  renewClaim: { claim: coordinationClaim },
  checkpointClaim: {
    claim: { ...coordinationClaim, latestCheckpointId: coordinationCheckpoint.id },
    checkpoint: coordinationCheckpoint,
  },
  transitionClaim: {
    claim: { ...coordinationClaim, state: "paused" as const, endedAt: coordinationTimestamp },
  },
  switchTask: {
    previousClaim: {
      ...coordinationClaim,
      state: "paused" as const,
      endedAt: coordinationTimestamp,
      latestCheckpointId: coordinationCheckpoint.id,
    },
    nextClaim: {
      ...coordinationClaim,
      id: "claim-2",
      taskId: "record-next",
      baseTaskRevision: 1,
      contextPackId: "context-2",
    },
    checkpoint: coordinationCheckpoint,
    contextPack: {
      ...pack,
      id: "context-2",
      taskId: "record-next",
      task: {
        ...pack.task,
        record: { ...pack.task.record, id: "record-next", revision: 1 },
      },
      sourceRevisions: [{ recordId: "record-next", revision: 1 }],
    },
  },
  createDelegation: { delegation: coordinationDelegation },
  acceptDelegation: {
    delegation: {
      ...coordinationDelegation,
      childProfileId: authenticatedPrincipal.id,
      state: "accepted" as const,
      acceptedAt: coordinationTimestamp,
    },
  },
  revokeDelegation: {
    delegation: { ...coordinationDelegation, state: "revoked" as const, endedAt: coordinationTimestamp },
  },
  submitTaskResult: {
    claim: {
      ...coordinationClaim, state: "submitted" as const, endedAt: coordinationTimestamp,
      latestCheckpointId: coordinationCheckpoint.id,
    },
    submission: coordinationSubmission,
    proposal: coordinationProposal,
  },
};

const coordinationToolCases = [
  {
    name: "list_ready_tasks",
    method: "listReadyTasks",
    input: coordinationInputs.listReadyTasks,
    output: coordinationOutputs.listReadyTasks,
    readOnly: false,
    destructive: false,
  },
  {
    name: "get_coordination_state",
    method: "getCoordinationState",
    input: coordinationInputs.getCoordinationState,
    output: coordinationOutputs.getCoordinationState,
    readOnly: false,
    destructive: false,
  },
  {
    name: "claim_task",
    method: "claimTask",
    input: coordinationInputs.claimTask,
    output: coordinationOutputs.claimTask,
    readOnly: false,
    destructive: false,
  },
  {
    name: "renew_task_claim",
    method: "renewClaim",
    input: coordinationInputs.renewClaim,
    output: coordinationOutputs.renewClaim,
    readOnly: false,
    destructive: false,
  },
  {
    name: "checkpoint_task",
    method: "checkpointClaim",
    input: coordinationInputs.checkpointClaim,
    output: coordinationOutputs.checkpointClaim,
    readOnly: false,
    destructive: false,
  },
  {
    name: "transition_task_claim",
    method: "transitionClaim",
    input: coordinationInputs.transitionClaim,
    output: coordinationOutputs.transitionClaim,
    readOnly: false,
    destructive: true,
  },
  {
    name: "switch_task",
    method: "switchTask",
    input: coordinationInputs.switchTask,
    output: coordinationOutputs.switchTask,
    readOnly: false,
    destructive: true,
  },
  {
    name: "delegate_task",
    method: "createDelegation",
    input: coordinationInputs.createDelegation,
    output: coordinationOutputs.createDelegation,
    readOnly: false,
    destructive: false,
  },
  {
    name: "accept_task_delegation",
    method: "acceptDelegation",
    input: coordinationInputs.acceptDelegation,
    output: coordinationOutputs.acceptDelegation,
    readOnly: false,
    destructive: false,
  },
  {
    name: "revoke_task_delegation",
    method: "revokeDelegation",
    input: coordinationInputs.revokeDelegation,
    output: coordinationOutputs.revokeDelegation,
    readOnly: false,
    destructive: true,
  },
  {
    name: "submit_task_result",
    method: "submitTaskResult",
    input: coordinationInputs.submitTaskResult,
    output: coordinationOutputs.submitTaskResult,
    readOnly: false,
    destructive: true,
  },
] as const;

const schemaValidUnboundCoordinationOutput = (method: string): unknown => {
  switch (method) {
    case "listReadyTasks":
      return { ...coordinationOutputs.listReadyTasks, tasks: [{
        ...coordinationReadiness,
        task: { ...coordinationReadiness.task, projectId: "project-private-foreign" },
      }] };
    case "getCoordinationState":
      return { ...coordinationOutputs.getCoordinationState,
        task: { ...taskRecord, id: "task-private-foreign" } };
    case "claimTask":
      return { ...coordinationOutputs.claimTask,
        claim: { ...coordinationClaim, profileId: "profile-private-foreign" } };
    case "renewClaim":
      return { claim: { ...coordinationClaim, taskId: "task-private-foreign" } };
    case "checkpointClaim":
      return { ...coordinationOutputs.checkpointClaim,
        claim: { ...coordinationOutputs.checkpointClaim.claim,
          taskId: "task-private-foreign" },
        checkpoint: coordinationCheckpoint };
    case "transitionClaim":
      return { claim: { ...coordinationOutputs.transitionClaim.claim,
        taskId: "task-private-foreign" } };
    case "switchTask":
      return { ...coordinationOutputs.switchTask,
        contextPack: { ...coordinationOutputs.switchTask.contextPack,
          taskId: "task-private-foreign" } };
    case "createDelegation":
      return { delegation: { ...coordinationOutputs.createDelegation.delegation,
        parentProfileId: "profile-private-foreign" } };
    case "acceptDelegation":
      return { delegation: { ...coordinationOutputs.acceptDelegation.delegation,
        id: "delegation-private-foreign" } };
    case "revokeDelegation":
      return { delegation: { ...coordinationOutputs.revokeDelegation.delegation,
        id: "delegation-private-foreign" } };
    case "submitTaskResult":
      return { ...coordinationOutputs.submitTaskResult,
        claim: { ...coordinationOutputs.submitTaskResult.claim,
          taskId: "task-private-foreign" },
        submission: { ...coordinationOutputs.submitTaskResult.submission,
          taskId: "task-private-foreign" },
        proposal: { ...coordinationOutputs.submitTaskResult.proposal,
          sourceTaskId: "task-private-foreign" } };
    default:
      throw new Error(`Unknown coordination method: ${method}`);
  }
};

const coordinationToolNames = coordinationToolCases.map(({ name }) => name);

type ServiceCalls = {
  listProjects: number;
  projectSummaryIds: string[];
  taskContextInputs: Array<{
    projectId: string;
    taskId: string;
    budgetTokens: number;
  }>;
  submissions: Array<{
    principal: AuthenticatedProfile;
    input: SubmitChangeSetInput;
  }>;
  changeLists: Array<{ profileId: string; projectId: string }>;
  changeReads: Array<{ profileId: string; changeId: string }>;
  principalRevalidations: AuthenticatedProfile[];
  outboundRequests: Array<{
    principal: AuthenticatedProfile;
    input: RequestTaskContextInput;
  }>;
  releasedContextReads: Array<{
    principal: AuthenticatedProfile;
    requestId: string;
  }>;
  coordination: Array<{
    method: keyof typeof coordinationInputs;
    input: unknown;
    principal: AuthenticatedProfile;
  }>;
  coordinationOrder: string[];
};

const createFakeService = (
  calls: ServiceCalls,
  overrides: Partial<IntentArcService> = {},
): IntentArcService => ({
  createProject: () => {
    throw new Error("Unexpected mutation");
  },
  listProjects: () => {
    calls.listProjects += 1;
    return [project];
  },
  getProjectSummary: (projectId) => {
    calls.projectSummaryIds.push(projectId);
    return summary;
  },
  createRecord: () => {
    throw new Error("Unexpected mutation");
  },
  createRelationship: () => {
    throw new Error("Unexpected mutation");
  },
  updateRecord: () => {
    throw new Error("Unexpected mutation");
  },
  getTaskContext: (input) => {
    calls.taskContextInputs.push(input);
    return pack;
  },
  destinations: {
    getCurrent: () => null,
    set: () => {
      throw new Error("Unexpected destination administration");
    },
    disable: () => {
      throw new Error("Unexpected destination administration");
    },
  },
  outbound: {
    request: (principal, input) => {
      calls.outboundRequests.push({ principal, input });
      return outboundRequest;
    },
    getReleased: (principal, requestId) => {
      calls.releasedContextReads.push({ principal, requestId });
      return {
        status: "review_required",
        request: outboundRequest,
      };
    },
    list: () => {
      throw new Error("Unexpected outbound administration");
    },
    inspect: () => {
      throw new Error("Unexpected outbound administration");
    },
    reveal: () => {
      throw new Error("Unexpected outbound reveal");
    },
    approve: () => {
      throw new Error("Unexpected outbound administration");
    },
    deny: () => {
      throw new Error("Unexpected outbound administration");
    },
    disablePolicy: () => {
      throw new Error("Unexpected outbound administration");
    },
  },
  profiles: {
    createProfile: () => {
      throw new Error("Unexpected profile administration");
    },
    listProfiles: () => [],
    authenticate: () => null,
    revalidatePrincipal: (principal) => {
      calls.principalRevalidations.push(principal);
      calls.coordinationOrder.push("revalidatePrincipal");
      return principal;
    },
    setAuthority: () => {
      throw new Error("Unexpected profile administration");
    },
    addScope: () => {
      throw new Error("Unexpected profile administration");
    },
    removeScope: () => {
      throw new Error("Unexpected profile administration");
    },
    rotateToken: () => {
      throw new Error("Unexpected profile administration");
    },
    setEnabled: () => {
      throw new Error("Unexpected profile administration");
    },
  },
  proposals: {
    list: () => [],
    get: () => {
      throw new Error("Unexpected proposal administration");
    },
    accept: () => {
      throw new Error("Unexpected proposal administration");
    },
    reject: () => {
      throw new Error("Unexpected proposal administration");
    },
    withdraw: () => {
      throw new Error("Unexpected proposal administration");
    },
  },
  coordination: {
    resolveOwnedClaimSnapshot: () => coordinationClaim,
    resolveAuthorizedDelegation: (_input, _principal, requiredRole) =>
      requiredRole === "child"
        ? { ...coordinationDelegation, childProfileId: authenticatedPrincipal.id }
        : coordinationDelegation,
    listReadyTasks: (input, principal) => {
      calls.coordination.push({ method: "listReadyTasks", input, principal });
      calls.coordinationOrder.push("listReadyTasks");
      return coordinationOutputs.listReadyTasks;
    },
    getCoordinationState: (input, principal) => {
      calls.coordination.push({ method: "getCoordinationState", input, principal });
      calls.coordinationOrder.push("getCoordinationState");
      return coordinationOutputs.getCoordinationState;
    },
    claimTask: (input, principal) => {
      calls.coordination.push({ method: "claimTask", input, principal });
      calls.coordinationOrder.push("claimTask");
      return coordinationOutputs.claimTask;
    },
    renewClaim: (input, principal) => {
      calls.coordination.push({ method: "renewClaim", input, principal });
      calls.coordinationOrder.push("renewClaim");
      return coordinationOutputs.renewClaim;
    },
    checkpointClaim: (input, principal) => {
      calls.coordination.push({ method: "checkpointClaim", input, principal });
      calls.coordinationOrder.push("checkpointClaim");
      return coordinationOutputs.checkpointClaim;
    },
    transitionClaim: (input, principal) => {
      calls.coordination.push({ method: "transitionClaim", input, principal });
      calls.coordinationOrder.push("transitionClaim");
      return coordinationOutputs.transitionClaim;
    },
    switchTask: (input, principal) => {
      calls.coordination.push({ method: "switchTask", input, principal });
      calls.coordinationOrder.push("switchTask");
      return coordinationOutputs.switchTask;
    },
    createDelegation: (input, principal) => {
      calls.coordination.push({ method: "createDelegation", input, principal });
      calls.coordinationOrder.push("createDelegation");
      return coordinationOutputs.createDelegation;
    },
    acceptDelegation: (input, principal) => {
      calls.coordination.push({ method: "acceptDelegation", input, principal });
      calls.coordinationOrder.push("acceptDelegation");
      return coordinationOutputs.acceptDelegation;
    },
    revokeDelegation: (input, principal) => {
      calls.coordination.push({ method: "revokeDelegation", input, principal });
      calls.coordinationOrder.push("revokeDelegation");
      return coordinationOutputs.revokeDelegation;
    },
    submitTaskResult: (input, principal) => {
      calls.coordination.push({ method: "submitTaskResult", input, principal });
      calls.coordinationOrder.push("submitTaskResult");
      return coordinationOutputs.submitTaskResult;
    },
  },
  submitChangeSet: (principal, input) => {
    calls.submissions.push({ principal, input });
    return {
      outcome: "rejected",
      code: "project_authority_missing",
      reason: "project_authority_missing",
      replayed: false,
    };
  },
  listMyChanges: (profileId, projectId) => {
    calls.changeLists.push({ profileId, projectId });
    return [];
  },
  getMyChange: (profileId, changeId) => {
    calls.changeReads.push({ profileId, changeId });
    throw new GovernanceError("validation_failed", "Change not found");
  },
  listAuditEvents: () => [],
  ...overrides,
});

describe("IntentArc MCP server", () => {
  const clientTransports: InMemoryTransportInstance[] = [];
  const serverTransports: InMemoryTransportInstance[] = [];
  const clients: Client[] = [];
  const servers: McpServer[] = [];
  let application: IntentArcApplication | undefined;
  let administrativeApplication: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(async () => {
    await Promise.allSettled(clientTransports.splice(0).map((value) => value.close()));
    await Promise.allSettled(serverTransports.splice(0).map((value) => value.close()));
    await Promise.allSettled(clients.splice(0).map((value) => value.close()));
    await Promise.allSettled(servers.splice(0).map((value) => value.close()));
    application?.close();
    application = undefined;
    administrativeApplication?.close();
    administrativeApplication = undefined;
    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
      temporaryDatabase = undefined;
    }
  });

  const connect = async (
    service: IntentArcService,
    principal: AuthenticatedProfile | null = null,
  ): Promise<Client> => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createIntentArcMcpServer(service, principal);
    const client = new Client({ name: "intentarc-test", version: "1.0.0" });
    clientTransports.push(clientTransport);
    serverTransports.push(serverTransport);
    clients.push(client);
    servers.push(server);

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return client;
  };

  const emptyCalls = (): ServiceCalls => ({
    listProjects: 0,
    projectSummaryIds: [],
    taskContextInputs: [],
    submissions: [],
    changeLists: [],
    changeReads: [],
    principalRevalidations: [],
    outboundRequests: [],
    releasedContextReads: [],
    coordination: [],
    coordinationOrder: [],
  });

  it("publishes only metadata tools to anonymous clients", async () => {
    const connectedClient = await connect(createFakeService(emptyCalls()));

    const result = await connectedClient.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      "list_projects",
      "get_project_summary",
    ]);
    expect(result.tools.map(({ name }) => name)).not.toContain(
      "get_task_context",
    );
    expect(result.tools.map(({ name }) => name)).not.toContain(
      "request_task_context",
    );
    expect(result.tools).toEqual(
      result.tools.map((tool) =>
        expect.objectContaining({
          name: tool.name,
          inputSchema: expect.objectContaining({ type: "object" }),
          outputSchema: expect.objectContaining({ type: "object" }),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        }),
      ),
    );
  });

  it("adds only governed, outbound, and coordination tools for an authenticated profile", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls()),
      authenticatedPrincipal,
    );

    const result = await connectedClient.listTools();
    const toolsByName = new Map(result.tools.map((tool) => [tool.name, tool]));

    expect([...toolsByName.keys()]).toEqual([
      "list_projects",
      "get_project_summary",
      "submit_change_set",
      "list_my_changes",
      "get_my_change",
      "request_task_context",
      "get_released_context",
      ...coordinationToolNames,
    ]);
    expect([...toolsByName.keys()]).not.toContain("get_task_context");
    for (const administrationTool of [
      "list_outbound_requests",
      "inspect_outbound_request",
      "reveal_outbound_finding",
      "approve_outbound_request",
      "deny_outbound_request",
    ]) {
      expect([...toolsByName.keys()]).not.toContain(administrationTool);
    }
    expect(toolsByName.get("submit_change_set")).toMatchObject({
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
      }),
      outputSchema: expect.objectContaining({ type: "object" }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    for (const name of ["list_my_changes", "get_my_change"]) {
      expect(toolsByName.get(name)).toMatchObject({
        inputSchema: expect.objectContaining({
          type: "object",
          additionalProperties: false,
        }),
        outputSchema: expect.objectContaining({ type: "object" }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    }
    expect(toolsByName.get("list_my_changes")?.inputSchema).toMatchObject({
      properties: { projectId: expect.any(Object) },
      required: ["projectId"],
    });
    expect(
      Object.keys(
        toolsByName.get("list_my_changes")?.inputSchema.properties ?? {},
      ),
    ).toEqual(["projectId"]);
    expect(toolsByName.get("get_my_change")?.inputSchema).toMatchObject({
      properties: { changeId: expect.any(Object) },
      required: ["changeId"],
    });
    expect(
      Object.keys(
        toolsByName.get("get_my_change")?.inputSchema.properties ?? {},
      ),
    ).toEqual(["changeId"]);
    expect(toolsByName.get("request_task_context")).toMatchObject({
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: [
          "projectId",
          "taskId",
          "budgetTokens",
          "idempotencyKey",
        ],
      }),
      outputSchema: expect.objectContaining({ type: "object" }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(
      Object.keys(
        toolsByName.get("request_task_context")?.inputSchema.properties ?? {},
      ),
    ).toEqual([
      "projectId",
      "taskId",
      "budgetTokens",
      "idempotencyKey",
    ]);
    expect(toolsByName.get("get_released_context")).toMatchObject({
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        properties: { requestId: expect.any(Object) },
        required: ["requestId"],
      }),
      outputSchema: expect.objectContaining({
        type: "object",
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
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(
      Object.keys(
        toolsByName.get("get_released_context")?.inputSchema.properties ?? {},
      ),
    ).toEqual(["requestId"]);
    const releasedOutputValidator = new AjvJsonSchemaValidator().getValidator(
      toolsByName.get("get_released_context")!.outputSchema!,
    );
    expect(releasedOutputValidator({
      status: "released",
      release: outboundRelease,
    }).valid).toBe(true);
    expect(releasedOutputValidator({
      status: "review_required",
      request: outboundRequest,
    }).valid).toBe(true);
    expect(releasedOutputValidator({ status: "released" }).valid).toBe(false);
    expect(releasedOutputValidator({
      status: "review_required",
      request: outboundRequest,
      release: outboundRelease,
    }).valid).toBe(false);
    expect(releasedOutputValidator({
      status: "denied",
      request: { ...outboundRequest, status: "denied" },
      release: outboundRelease,
    }).valid).toBe(false);
  });

  it("publishes exact strict coordination schemas, annotations, and capability descriptions", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls()),
      authenticatedPrincipal,
    );
    const tools = new Map(
      (await connectedClient.listTools()).tools.map((tool) => [tool.name, tool]),
    );

    expect(coordinationToolNames).toEqual([
      "list_ready_tasks",
      "get_coordination_state",
      "claim_task",
      "renew_task_claim",
      "checkpoint_task",
      "transition_task_claim",
      "switch_task",
      "delegate_task",
      "accept_task_delegation",
      "revoke_task_delegation",
      "submit_task_result",
    ]);
    for (const toolCase of coordinationToolCases) {
      const tool = tools.get(toolCase.name)!;
      expect(tool).toBeDefined();
      expect(tool.description).toContain(
        "IntentArc does not launch agents or execute repository work.",
      );
      expect(tool.annotations).toEqual({
        readOnlyHint: toolCase.readOnly,
        destructiveHint: toolCase.destructive,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(tool.outputSchema).toMatchObject({ type: "object" });

      const inputValidator = new AjvJsonSchemaValidator().getValidator(
        tool.inputSchema,
      );
      expect(inputValidator(toolCase.input).valid, toolCase.name).toBe(true);
      expect(
        inputValidator({ ...toolCase.input, privateExtra: true }).valid,
        toolCase.name,
      ).toBe(false);
      const outputValidator = new AjvJsonSchemaValidator().getValidator(
        tool.outputSchema!,
      );
      expect(outputValidator(toolCase.output).valid).toBe(true);
      expect(outputValidator({ ...toolCase.output, privateExtra: true }).valid).toBe(false);
    }
  });

  it("revalidates immediately before all eleven coordination operations and returns closed public output", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(
      createFakeService(calls),
      authenticatedPrincipal,
    );

    for (const toolCase of coordinationToolCases) {
      calls.coordinationOrder.length = 0;
      const result = await connectedClient.callTool({
        name: toolCase.name,
        arguments: toolCase.input,
      });

      expect(calls.coordinationOrder).toEqual([
        "revalidatePrincipal",
        toolCase.method,
      ]);
      expect(calls.coordination.at(-1)).toEqual({
        method: toolCase.method,
        input: toolCase.input,
        principal: authenticatedPrincipal,
      });
      expect(result.isError, toolCase.name).not.toBe(true);
      expect(result.structuredContent).toEqual(toolCase.output);
      expect(result.content).toEqual([{
        type: "text",
        text: JSON.stringify(toolCase.output, null, 2),
      }]);
    }
    expect(calls.principalRevalidations).toHaveLength(11);
    expect(calls.coordination).toHaveLength(11);
  });

  it("rejects schema-valid wrong-lineage output for all eleven coordination tools", async () => {
    for (const toolCase of coordinationToolCases) {
      const service = createFakeService(emptyCalls());
      Object.assign(service.coordination, {
        [toolCase.method]: () => schemaValidUnboundCoordinationOutput(toolCase.method),
      });
      const connectedClient = await connect(service, authenticatedPrincipal);

      const result = await connectedClient.callTool({
        name: toolCase.name,
        arguments: toolCase.input,
      });

      expect(result, toolCase.name).toEqual({
        isError: true,
        content: [{ type: "text", text: "internal_error" }],
      });
      expect(JSON.stringify(result)).not.toContain("private-foreign");
    }
  });

  it("rejects wrong output revisions for ready, checkpoint, and submission", async () => {
    const cases = [
      {
        name: "list_ready_tasks",
        input: coordinationInputs.listReadyTasks,
        method: "listReadyTasks",
        output: { ...coordinationOutputs.listReadyTasks, projectRevision: project.revision + 1 },
      },
      {
        name: "checkpoint_task",
        input: coordinationInputs.checkpointClaim,
        method: "checkpointClaim",
        output: {
          ...coordinationOutputs.checkpointClaim,
          checkpoint: {
            ...coordinationOutputs.checkpointClaim.checkpoint,
            projectRevision: project.revision + 1,
            taskRevision: taskRecord.revision + 1,
          },
        },
      },
      {
        name: "submit_task_result",
        input: coordinationInputs.submitTaskResult,
        method: "submitTaskResult",
        output: {
          ...coordinationOutputs.submitTaskResult,
          submission: {
            ...coordinationOutputs.submitTaskResult.submission,
            baseProjectRevision: project.revision + 1,
            baseTaskRevision: taskRecord.revision + 1,
          },
          proposal: {
            ...coordinationOutputs.submitTaskResult.proposal,
            baseProjectRevision: project.revision + 1,
          },
        },
      },
    ];
    for (const testCase of cases) {
      const service = createFakeService(emptyCalls());
      Object.assign(service.coordination, { [testCase.method]: () => testCase.output });
      const connectedClient = await connect(service, authenticatedPrincipal);
      expect(await connectedClient.callTool({
        name: testCase.name,
        arguments: testCase.input,
      })).toEqual({
        isError: true,
        content: [{ type: "text", text: "internal_error" }],
      });
    }
  });

  it("rejects duplicate, short-page, and repeated ready pagination output", async () => {
    const cursor = Buffer.from(JSON.stringify({ page: "private-ready-page" }), "utf8")
      .toString("base64url");
    const cases = [
      {
        input: { ...coordinationInputs.listReadyTasks, limit: 2 },
        output: {
          tasks: [coordinationReadiness, coordinationReadiness],
          nextCursor: null,
          projectRevision: project.revision,
        },
      },
      {
        input: { ...coordinationInputs.listReadyTasks, limit: 2 },
        output: {
          tasks: [coordinationReadiness],
          nextCursor: cursor,
          projectRevision: project.revision,
        },
      },
      {
        input: { ...coordinationInputs.listReadyTasks, limit: 1, cursor },
        output: {
          tasks: [coordinationReadiness],
          nextCursor: cursor,
          projectRevision: project.revision,
        },
      },
    ];
    for (const testCase of cases) {
      const service = createFakeService(emptyCalls());
      service.coordination.listReadyTasks = () => testCase.output;
      const client = await connect(service, authenticatedPrincipal);
      const result = await client.callTool({
        name: "list_ready_tasks",
        arguments: testCase.input,
      });
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "internal_error" }],
      });
      expect(JSON.stringify(result)).not.toContain("private-ready-page");
    }
  });

  it("round-trips an exact 64 KiB checkpoint document through MCP", async () => {
    const emptyMaximumCheckpoint = { ...coordinationCheckpointDocument, summary: "" };
    const maximumCheckpointDocument = {
      ...emptyMaximumCheckpoint,
      summary: "x".repeat(
        65_536 - Buffer.byteLength(JSON.stringify(emptyMaximumCheckpoint), "utf8"),
      ),
    };
    const service = createFakeService(emptyCalls());
    service.coordination.checkpointClaim = () => ({
      claim: {
        ...coordinationClaim,
        latestCheckpointId: coordinationCheckpoint.id,
      },
      checkpoint: { ...coordinationCheckpoint, ...maximumCheckpointDocument },
    });
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: "checkpoint_task",
      arguments: {
        ...coordinationInputs.checkpointClaim,
        checkpoint: maximumCheckpointDocument,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(maximumCheckpointDocument), "utf8")).toBe(65_536);
    expect((result.structuredContent!.checkpoint as { summary: string }).summary)
      .toHaveLength(maximumCheckpointDocument.summary.length);

    service.coordination.switchTask = () => ({
      ...coordinationOutputs.switchTask,
      checkpoint: { ...coordinationCheckpoint, ...maximumCheckpointDocument },
    });
    const switched = await connectedClient.callTool({
      name: "switch_task",
      arguments: {
        ...coordinationInputs.switchTask,
        checkpoint: maximumCheckpointDocument,
      },
    });
    expect(switched.isError).not.toBe(true);
    expect((switched.structuredContent!.checkpoint as { summary: string }).summary)
      .toHaveLength(maximumCheckpointDocument.summary.length);
  });

  it("accepts a valid equivalent delegation deadline spelling and returns its canonical instant", async () => {
    const service = createFakeService(emptyCalls());
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: "delegate_task",
      arguments: {
        ...coordinationInputs.createDelegation,
        deadline: "2026-08-15T10:00Z",
        idempotencyKey: "delegate-equivalent-deadline",
      },
    });

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent!.delegation as { deadline: string }).deadline)
      .toBe("2026-08-15T10:00:00.000Z");
  });

  it("fails closed on unchecked coordination output and exposes only stable coordination error codes", async () => {
    const privateValue = "C:\\private\\intentarc.sqlite token=coordination-secret";
    const uncheckedService = createFakeService(emptyCalls());
    uncheckedService.coordination.renewClaim = () => ({
      ...coordinationOutputs.renewClaim,
      privateStorageDetail: privateValue,
    }) as never;
    const uncheckedClient = await connect(
      uncheckedService,
      authenticatedPrincipal,
    );

    const unchecked = await uncheckedClient.callTool({
      name: "renew_task_claim",
      arguments: coordinationInputs.renewClaim,
    });

    expect(unchecked).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(unchecked)).not.toContain("privateStorageDetail");
    expect(JSON.stringify(unchecked)).not.toContain("coordination-secret");

    const unboundService = createFakeService(emptyCalls());
    unboundService.coordination.renewClaim = () => ({
      claim: { ...coordinationClaim, id: "claim-private-foreign" },
    });
    const unboundClient = await connect(unboundService, authenticatedPrincipal);
    const unbound = await unboundClient.callTool({
      name: "renew_task_claim",
      arguments: coordinationInputs.renewClaim,
    });
    expect(unbound).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(unbound)).not.toContain("claim-private-foreign");

    const rejectedService = createFakeService(emptyCalls());
    rejectedService.coordination.claimTask = () => {
      const error = new CoordinationError("claim_conflict");
      Object.assign(error, { privateStorageDetail: privateValue });
      throw error;
    };
    const rejectedClient = await connect(
      rejectedService,
      authenticatedPrincipal,
    );
    const rejected = await rejectedClient.callTool({
      name: "claim_task",
      arguments: coordinationInputs.claimTask,
    });

    expect(rejected).toEqual({
      isError: true,
      content: [{ type: "text", text: "claim_conflict" }],
    });
    expect(JSON.stringify(rejected)).not.toContain("coordination-secret");
    expect(JSON.stringify(rejected)).not.toContain("privateStorageDetail");
  });

  it.each(["writable code", "throwing code getter"] as const)(
    "reconstructs a %s through the closed coordination error-code set",
    async (variant) => {
      const privateValue = "C:\\private\\intentarc.sqlite token=coordination-secret";
      const service = createFakeService(emptyCalls());
      service.coordination.claimTask = () => {
        const error = new CoordinationError("claim_conflict");
        if (variant === "writable code") {
          Object.defineProperty(error, "code", {
            configurable: true,
            enumerable: true,
            value: privateValue,
            writable: true,
          });
        } else {
          Object.defineProperty(error, "code", {
            configurable: true,
            enumerable: true,
            get: () => {
              throw new Error(privateValue);
            },
          });
        }
        throw error;
      };
      const connectedClient = await connect(service, authenticatedPrincipal);

      const result = await connectedClient.callTool({
        name: "claim_task",
        arguments: coordinationInputs.claimTask,
      });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "coordination_unavailable" }],
      });
      expect(JSON.stringify(result)).not.toContain("coordination-secret");
      expect(JSON.stringify(result)).not.toContain("C:\\private");
    },
  );

  it("keeps nested coordination inputs closed and enforces cross-field refinements before service invocation", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(
      createFakeService(calls),
      authenticatedPrincipal,
    );

    const invalidCalls = [
      {
        name: "checkpoint_task",
        arguments: {
          ...coordinationInputs.checkpointClaim,
          checkpoint: {
            ...coordinationInputs.checkpointClaim.checkpoint,
            verificationEvidence: {
              ...coordinationInputs.checkpointClaim.checkpoint.verificationEvidence,
              privateExtra: "nested-secret-value",
            },
          },
        },
      },
      {
        name: "submit_task_result",
        arguments: {
          ...coordinationInputs.submitTaskResult,
          submission: {
            ...coordinationInputs.submitTaskResult.submission,
            changes: {
              ...coordinationInputs.submitTaskResult.submission.changes,
              privateExtra: "nested-secret-value",
            },
          },
        },
      },
      {
        name: "switch_task",
        arguments: {
          ...coordinationInputs.switchTask,
          expectedNextProjectRevision: project.revision + 1,
        },
      },
      {
        name: "submit_task_result",
        arguments: {
          ...coordinationInputs.submitTaskResult,
          submission: {
            ...coordinationInputs.submitTaskResult.submission,
            changes: {
              rationale: "The protocol owns task completion.",
              operations: [{
                operationId: "private-completion",
                type: "update_record",
                recordId: taskRecord.id,
                expectedRecordRevision: taskRecord.revision,
                patch: { status: "completed" },
              }],
            },
          },
        },
      },
    ] as const;

    for (const invalidCall of invalidCalls) {
      const result = await connectedClient.callTool(invalidCall);
      expect(result.isError, invalidCall.name).toBe(true);
      expect(JSON.stringify(result), invalidCall.name).not.toContain("nested-secret-value");
    }
    expect(calls.principalRevalidations).toEqual([]);
    expect(calls.coordination).toEqual([]);
  });

  it("accepts the strict release transition branch", async () => {
    const calls = emptyCalls();
    const service = createFakeService(calls);
    service.coordination.transitionClaim = (input, principal) => {
      calls.coordination.push({ method: "transitionClaim", input, principal });
      calls.coordinationOrder.push("transitionClaim");
      return {
        claim: {
          ...coordinationClaim,
          state: "released",
          endedAt: coordinationTimestamp,
        },
      };
    };
    const connectedClient = await connect(
      service,
      authenticatedPrincipal,
    );
    const releaseInput = {
      ...coordinationInputs.transitionClaim,
      action: "release" as const,
      idempotencyKey: "release-1",
    };

    const result = await connectedClient.callTool({
      name: "transition_task_claim",
      arguments: releaseInput,
    });

    expect(result.isError).not.toBe(true);
    expect(calls.coordination).toEqual([{
      method: "transitionClaim",
      input: releaseInput,
      principal: authenticatedPrincipal,
    }]);
  });

  it("executes all eleven coordination operations with a real application and exact idempotent replay", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => coordinationTimestamp,
      newId: (prefix) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    });
    const realProject = application.service.createProject({ name: "MCP coordination" });
    const tasks = ["Pause", "Switch from", "Switch to", "Delegate", "Revoke"].map(
      (title) => application!.service.createRecord({
        projectId: realProject.id,
        kind: "task",
        status: "active",
        title,
        body: `${title} through the authenticated MCP transport.`,
        sourceKind: "human",
        sourceRef: null,
      }),
    );
    const projectRevision = tasks.length;
    const parent = application.service.profiles.createProfile({
      name: "MCP parent",
      projectId: realProject.id,
    });
    const child = application.service.profiles.createProfile({
      name: "MCP child",
      projectId: realProject.id,
    });
    for (const profileId of [parent.profile.id, child.profile.id]) {
      application.service.profiles.setAuthority({
        profileId,
        projectId: realProject.id,
        mode: "full_direct",
      });
    }
    const parentPrincipal = application.service.profiles.authenticate({
      profileId: parent.profile.id,
      token: parent.token,
    })!;
    const childPrincipal = application.service.profiles.authenticate({
      profileId: child.profile.id,
      token: child.token,
    })!;
    const parentClient = await connect(application.service, parentPrincipal);
    const childClient = await connect(application.service, childPrincipal);
    const call = async (
      client: Client,
      name: string,
      arguments_: Record<string, unknown>,
    ) => {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent,
      );
      return result;
    };
    const replay = async (
      client: Client,
      name: string,
      arguments_: Record<string, unknown>,
    ) => {
      const first = await call(client, name, arguments_);
      const second = await call(client, name, arguments_);
      expect(second.structuredContent).toEqual(first.structuredContent);
      return first;
    };
    const checkpoint = (summary: string) => ({
      summary,
      completedWork: ["Completed transport operation."],
      remainingWork: ["Reconcile governed result."],
      blockers: [],
      verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
      repositoryEvidence: null,
    });

    const ready = await call(parentClient, "list_ready_tasks", {
      projectId: realProject.id,
      expectedProjectRevision: projectRevision,
      cursor: null,
      limit: 20,
    });
    expect(ready.structuredContent).toMatchObject({
      tasks: expect.arrayContaining(tasks.map((task) => expect.objectContaining({
        task: expect.objectContaining({ id: task.id }),
        blockers: [],
      }))),
      projectRevision,
    });
    expect((await call(parentClient, "get_coordination_state", {
      projectId: realProject.id,
      taskId: tasks[0]!.id,
      expectedProjectRevision: projectRevision,
    })).structuredContent).toMatchObject({
      task: { id: tasks[0]!.id },
      claim: null,
    });

    const firstClaimInput = {
      projectId: realProject.id,
      taskId: tasks[0]!.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      contextBudgetTokens: 1_200,
      acceptedDelegationId: null,
      idempotencyKey: "mcp-real-claim-1",
    };
    const firstClaim = await replay(parentClient, "claim_task", firstClaimInput);
    const firstClaimId = firstClaim.structuredContent!.claim as { id: string };
    const changedReplay = await parentClient.callTool({
      name: "claim_task",
      arguments: { ...firstClaimInput, contextBudgetTokens: 1_201 },
    });
    expect(changedReplay).toEqual({
      isError: true,
      content: [{ type: "text", text: "coordination_idempotency_conflict" }],
    });

    await replay(parentClient, "renew_task_claim", {
      claimId: firstClaimId.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      idempotencyKey: "mcp-real-renew-1",
    });
    const firstCheckpointInput = {
      claimId: firstClaimId.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      checkpoint: checkpoint("Checkpoint before pause."),
      idempotencyKey: "mcp-real-checkpoint-1",
    };
    await replay(parentClient, "checkpoint_task", firstCheckpointInput);
    expect(await parentClient.callTool({
      name: "checkpoint_task",
      arguments: {
        ...firstCheckpointInput,
        checkpoint: checkpoint("Changed checkpoint must not replay."),
      },
    })).toEqual({
      isError: true,
      content: [{ type: "text", text: "coordination_idempotency_conflict" }],
    });
    await replay(parentClient, "transition_task_claim", {
      claimId: firstClaimId.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      action: "pause",
      idempotencyKey: "mcp-real-pause-1",
    });

    const switchClaim = await call(parentClient, "claim_task", {
      projectId: realProject.id,
      taskId: tasks[1]!.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      contextBudgetTokens: 1_200,
      acceptedDelegationId: null,
      idempotencyKey: "mcp-real-claim-switch",
    });
    const switchClaimId = (switchClaim.structuredContent!.claim as { id: string }).id;
    await replay(parentClient, "switch_task", {
      currentClaimId: switchClaimId,
      projectId: realProject.id,
      currentTaskId: tasks[1]!.id,
      expectedCurrentProjectRevision: projectRevision,
      expectedCurrentTaskRevision: 1,
      checkpoint: checkpoint("Checkpoint before switch."),
      terminalAction: "pause",
      nextTaskId: tasks[2]!.id,
      expectedNextProjectRevision: projectRevision,
      expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 1_200,
      acceptedDelegationId: null,
      idempotencyKey: "mcp-real-switch-1",
    });

    const delegated = await replay(parentClient, "delegate_task", {
      projectId: realProject.id,
      taskId: tasks[3]!.id,
      childProfileId: child.profile.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      scope: { summary: "Complete the delegated MCP task.", constraints: [] },
      allowedOutputs: ["update_record"],
      deadline: "2026-08-15T10:00:00.000Z",
      idempotencyKey: "mcp-real-delegate-1",
    });
    const delegationId = (delegated.structuredContent!.delegation as { id: string }).id;
    await replay(childClient, "accept_task_delegation", {
      delegationId,
      projectId: realProject.id,
      taskId: tasks[3]!.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      idempotencyKey: "mcp-real-accept-1",
    });
    const childClaim = await replay(childClient, "claim_task", {
      projectId: realProject.id,
      taskId: tasks[3]!.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      contextBudgetTokens: 1_200,
      acceptedDelegationId: delegationId,
      idempotencyKey: "mcp-real-child-claim",
    });
    const childClaimId = (childClaim.structuredContent!.claim as { id: string }).id;
    const childCheckpoint = await replay(childClient, "checkpoint_task", {
      claimId: childClaimId,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      checkpoint: checkpoint("Delegated work complete."),
      idempotencyKey: "mcp-real-child-checkpoint",
    });
    const childCheckpointId = (
      childCheckpoint.structuredContent!.checkpoint as { id: string }
    ).id;
    await replay(childClient, "submit_task_result", {
      claimId: childClaimId,
      checkpointId: childCheckpointId,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      submission: {
        summary: "Delegated MCP task complete.",
        verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Complete the delegated task.", operations: [] },
      },
      idempotencyKey: "mcp-real-submit-1",
    });

    const revoked = await replay(parentClient, "delegate_task", {
      projectId: realProject.id,
      taskId: tasks[4]!.id,
      childProfileId: child.profile.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      scope: { summary: "Revoke this delegated task.", constraints: [] },
      allowedOutputs: ["update_record"],
      deadline: "2026-08-15T10:00:00.000Z",
      idempotencyKey: "mcp-real-delegate-revoke",
    });
    const revokedDelegationId = (
      revoked.structuredContent!.delegation as { id: string }
    ).id;
    await replay(parentClient, "revoke_task_delegation", {
      delegationId: revokedDelegationId,
      projectId: realProject.id,
      taskId: tasks[4]!.id,
      expectedProjectRevision: projectRevision,
      expectedTaskRevision: 1,
      idempotencyKey: "mcp-real-revoke-1",
    });
  });

  it("advertises next-read expiry honestly and mutates overdue state through both coordination reads", async () => {
    temporaryDatabase = createTemporaryDatabase();
    let currentTime = coordinationTimestamp;
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => currentTime,
    });
    const stateProject = application.service.createProject({ name: "State expiry" });
    const readyProject = application.service.createProject({ name: "Ready expiry" });
    const stateTask = application.service.createRecord({
      projectId: stateProject.id,
      kind: "task",
      status: "active",
      title: "Expire through state",
      body: "The next state read must expire this claim.",
      sourceKind: "human",
      sourceRef: null,
    });
    const readyTask = application.service.createRecord({
      projectId: readyProject.id,
      kind: "task",
      status: "active",
      title: "Expire through readiness",
      body: "The next ready read must expire this claim.",
      sourceKind: "human",
      sourceRef: null,
    });
    const profile = application.service.profiles.createProfile({
      name: "Expiry reader",
      projectId: stateProject.id,
    });
    for (const projectId of [stateProject.id, readyProject.id]) {
      application.service.profiles.setAuthority({
        profileId: profile.profile.id,
        projectId,
        mode: "full_direct",
      });
    }
    const principal = application.service.profiles.authenticate({
      profileId: profile.profile.id,
      token: profile.token,
    })!;
    const connectedClient = await connect(application.service, principal);
    for (const [projectId, taskId, idempotencyKey] of [
      [stateProject.id, stateTask.id, "state-expiry-claim"],
      [readyProject.id, readyTask.id, "ready-expiry-claim"],
    ] as const) {
      const claimed = await connectedClient.callTool({
        name: "claim_task",
        arguments: {
          projectId,
          taskId,
          expectedProjectRevision: 1,
          expectedTaskRevision: 1,
          contextBudgetTokens: 1_200,
          acceptedDelegationId: null,
          idempotencyKey,
        },
      });
      expect(claimed.isError).not.toBe(true);
    }
    currentTime = "2026-08-15T09:00:00.000Z";

    const state = await connectedClient.callTool({
      name: "get_coordination_state",
      arguments: {
        projectId: stateProject.id,
        taskId: stateTask.id,
        expectedProjectRevision: 1,
      },
    });
    expect(state.structuredContent).toMatchObject({
      claim: { state: "expired", endedAt: currentTime },
      events: expect.arrayContaining([expect.objectContaining({
        category: "expiry",
        resultingState: "expired",
      })]),
    });

    const ready = await connectedClient.callTool({
      name: "list_ready_tasks",
      arguments: {
        projectId: readyProject.id,
        expectedProjectRevision: 1,
        cursor: null,
        limit: 20,
      },
    });
    expect(ready.structuredContent).toMatchObject({
      tasks: [expect.objectContaining({
        task: expect.objectContaining({ id: readyTask.id }),
        liveClaimId: null,
      })],
    });

    const database = openDatabase(temporaryDatabase.path);
    try {
      expect(database.prepare(
        "SELECT state, ended_at FROM task_claims WHERE project_id = ?",
      ).get(readyProject.id)).toEqual({
        state: "expired",
        ended_at: currentTime,
      });
      expect(database.prepare(`
        SELECT category, resulting_state FROM coordination_events
        WHERE project_id = ? AND task_id = ? AND category = 'expiry'
      `).get(readyProject.id, readyTask.id)).toEqual({
        category: "expiry",
        resulting_state: "expired",
      });
    } finally {
      database.close();
    }

    const tools = new Map(
      (await connectedClient.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    for (const name of ["list_ready_tasks", "get_coordination_state"]) {
      expect(tools.get(name)?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tools.get(name)?.description).toContain(
        "may persist elapsed claim or delegation expiry and append expiry events",
      );
    }
  });

  it.each<{
    route: string;
    result: ChangeSubmissionResult;
  }>([
    {
      route: "proposal",
      result: {
        outcome: "proposed",
        changeId: "change-proposal",
        proposalId: "proposal-1",
        state: "pending",
        replayed: false,
      },
    },
    {
      route: "scoped direct",
      result: {
        outcome: "applied",
        changeId: "change-scoped",
        projectRevision: 5,
        operations: [],
        replayed: false,
      },
    },
    {
      route: "mixed scoped fallback",
      result: {
        outcome: "proposed",
        changeId: "change-mixed",
        proposalId: "proposal-mixed",
        state: "pending",
        replayed: false,
      },
    },
    {
      route: "full direct",
      result: {
        outcome: "applied",
        changeId: "change-full",
        projectRevision: 5,
        operations: [{
          operationId: "create-decision",
          type: "create_record",
          record: {
            ...taskRecord,
            id: "record-created",
            kind: "decision",
            status: "provisional",
            title: "Governed MCP decision",
            body: "Return the complete governed submission result.",
            sourceKind: "agent",
            sourceRef: authenticatedPrincipal.id,
          },
        }],
        replayed: false,
      },
    },
    {
      route: "stale submission",
      result: {
        outcome: "conflicted",
        changeId: "change-stale",
        currentProjectRevision: 6,
        replayed: false,
      },
    },
    {
      route: "idempotent replay",
      result: {
        outcome: "applied",
        changeId: "change-full",
        projectRevision: 5,
        operations: [],
        replayed: true,
      },
    },
    {
      route: "idempotency conflict",
      result: {
        outcome: "rejected",
        changeId: "change-full",
        code: "idempotency_conflict",
        reason: "Idempotency key was already used for a different request",
        replayed: false,
      },
    },
  ])("returns the validated $route submission result as matching structured content and text", async ({
    result: expected,
  }) => {
    const calls = emptyCalls();
    const connectedClient = await connect(
      createFakeService(calls, {
        submitChangeSet: () => expected,
      }),
      authenticatedPrincipal,
    );

    const result = await connectedClient.callTool({
      name: "submit_change_set",
      arguments: submissionInput,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify(result.structuredContent, null, 2),
    }]);
  });

  it("binds the authenticated principal when submitting a change set", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(
      createFakeService(calls),
      authenticatedPrincipal,
    );

    await connectedClient.callTool({
      name: "submit_change_set",
      arguments: submissionInput,
    });

    expect(calls.submissions).toEqual([{
      principal: authenticatedPrincipal,
      input: submissionInput,
    }]);
  });

  it("rejects unchecked submission output without disclosing invalid fields", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls(), {
        submitChangeSet: () => ({
          outcome: "proposed",
          changeId: "change-1",
          proposalId: "proposal-1",
          state: "pending",
          replayed: false,
          privateStorageDetail: "sqlite:///private/intentarc.db",
        }) as unknown as ChangeSubmissionResult,
      }),
      authenticatedPrincipal,
    );

    const result = await connectedClient.callTool({
      name: "submit_change_set",
      arguments: submissionInput,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("privateStorageDetail");
    expect(JSON.stringify(result)).not.toContain("sqlite");
  });

  it("does not disclose authenticated internal GovernanceError messages or details", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls(), {
        submitChangeSet: () => {
          throw new GovernanceError(
            "internal_error",
            "SQLITE_CORRUPT at C:\\private\\intentarc.db token=secret-value",
            {
              token: "secret-value",
              databasePath: "C:\\private\\intentarc.db",
            },
          );
        },
      }),
      authenticatedPrincipal,
    );

    const result = await connectedClient.callTool({
      name: "submit_change_set",
      arguments: submissionInput,
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("SQLITE_CORRUPT");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
  });

  it("revokes every live authenticated tool after another connection disables the profile", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T15:00:00.000Z",
    });
    const realProject = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Live profile",
      projectId: realProject.id,
    });
    application.service.profiles.setAuthority({
      profileId: created.profile.id,
      projectId: realProject.id,
      mode: "full_direct",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const connectedClient = await connect(application.service, principal);
    const initial = await connectedClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 0,
        idempotencyKey: "live-disable",
        rationale: "Create history before disabling the live profile.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "create-before-disable",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Disable sentinel",
          body: "This change must not remain accessible after disablement.",
        }],
      },
    });
    const changeId = initial.structuredContent!.changeId as string;

    administrativeApplication = createApplication({
      databasePath: temporaryDatabase.path,
    });
    administrativeApplication.service.profiles.setEnabled(
      created.profile.id,
      false,
    );

    const results = await Promise.all([
      connectedClient.callTool({
        name: "submit_change_set",
        arguments: {
          projectId: realProject.id,
          baseProjectRevision: 0,
          idempotencyKey: "live-disable",
          rationale: "Create history before disabling the live profile.",
          sourceTaskId: null,
          predecessorProposalId: null,
          operations: [{
            operationId: "create-before-disable",
            type: "create_record",
            kind: "decision",
            status: "provisional",
            title: "Disable sentinel",
            body: "This change must not remain accessible after disablement.",
          }],
        },
      }),
      connectedClient.callTool({
        name: "list_my_changes",
        arguments: { projectId: realProject.id },
      }),
      connectedClient.callTool({
        name: "get_my_change",
        arguments: { changeId },
      }),
      connectedClient.callTool({
        name: "request_task_context",
        arguments: {
          projectId: realProject.id,
          taskId: "disabled-task",
          budgetTokens: 1_000,
          idempotencyKey: "disabled-outbound-request",
        },
      }),
      connectedClient.callTool({
        name: "get_released_context",
        arguments: { requestId: "disabled-outbound-request" },
      }),
      ...coordinationToolCases.map((toolCase) => connectedClient.callTool({
        name: toolCase.name,
        arguments: toolCase.input,
      })),
    ]);

    expect(results).toEqual(Array.from({ length: 16 }, () => ({
      isError: true,
      content: [{ type: "text", text: "profile_disabled" }],
    })));
  });

  it("revokes a live principal after rotation while a newly authenticated principal works", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T15:00:00.000Z",
    });
    const realProject = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Rotating profile",
      projectId: realProject.id,
    });
    application.service.profiles.setAuthority({
      profileId: created.profile.id,
      projectId: realProject.id,
      mode: "full_direct",
    });
    const oldPrincipal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const oldClient = await connect(application.service, oldPrincipal);

    administrativeApplication = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T15:01:00.000Z",
    });
    const rotated = administrativeApplication.service.profiles.rotateToken(
      created.profile.id,
    );

    expect(await oldClient.callTool({
      name: "list_my_changes",
      arguments: { projectId: realProject.id },
    })).toEqual({
      isError: true,
      content: [{ type: "text", text: "invalid_profile_credentials" }],
    });
    expect(await oldClient.callTool({
      name: "list_ready_tasks",
      arguments: {
        projectId: realProject.id,
        expectedProjectRevision: 0,
        cursor: null,
        limit: 20,
      },
    })).toEqual({
      isError: true,
      content: [{ type: "text", text: "invalid_profile_credentials" }],
    });
    expect(await oldClient.callTool({
      name: "claim_task",
      arguments: {
        projectId: realProject.id,
        taskId: "rotated-task",
        expectedProjectRevision: 0,
        expectedTaskRevision: 1,
        contextBudgetTokens: 1_200,
        acceptedDelegationId: null,
        idempotencyKey: "rotated-coordination-claim",
      },
    })).toEqual({
      isError: true,
      content: [{ type: "text", text: "invalid_profile_credentials" }],
    });

    const currentPrincipal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: rotated.token,
    })!;
    const currentClient = await connect(
      application.service,
      currentPrincipal,
    );
    expect(await currentClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 0,
        idempotencyKey: "live-rotation",
        rationale: "Apply through the newly authenticated principal.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "create-after-rotation",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Rotation sentinel",
          body: "Only the current credential generation may apply this.",
        }],
      },
    })).toMatchObject({
      structuredContent: {
        outcome: "applied",
        replayed: false,
      },
    });
  });

  it("returns a stored missing-authority rejection through authenticated history", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T15:00:00.000Z",
    });
    const realProject = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Unauthorized profile",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const connectedClient = await connect(application.service, principal);
    const submitted = await connectedClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 0,
        idempotencyKey: "missing-authority-history",
        rationale: "Store this rejected submission.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "rejected-create",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Must not exist",
          body: "History must retain the authority rejection.",
        }],
      },
    });
    const changeId = submitted.structuredContent!.changeId as string;

    expect(await connectedClient.callTool({
      name: "get_my_change",
      arguments: { changeId },
    })).toMatchObject({
      structuredContent: {
        change: {
          changeId,
          outcome: "rejected",
          result: {
            outcome: "rejected",
            changeId,
            code: "project_authority_missing",
            reason: "project_authority_missing",
            replayed: false,
          },
        },
      },
    });
  });

  it("does not disclose mapper or storage messages for a corrupted stored change result", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
    });
    const realProject = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Corruption reader",
      projectId: realProject.id,
    });
    application.service.profiles.setAuthority({
      profileId: created.profile.id,
      projectId: realProject.id,
      mode: "full_direct",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const initialClient = await connect(application.service, principal);
    const submission = await initialClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 0,
        idempotencyKey: "corrupt-history-result",
        rationale: "Create history that will be corrupted.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "create-corrupt-decision",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Corruption sentinel",
          body: "The adapter must hide stored mapper errors.",
        }],
      },
    });
    const changeId = submission.structuredContent!.changeId as string;

    application.close();
    application = undefined;
    const database = openDatabase(temporaryDatabase.path);
    try {
      database
        .prepare(
          "UPDATE idempotency_results SET result_json = ? WHERE change_id = ?",
        )
        .run("not-json C:\\private\\intentarc.db token=secret-value", changeId);
    } finally {
      database.close();
    }

    application = createApplication({
      databasePath: temporaryDatabase.path,
    });
    const reopenedPrincipal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const reopenedClient = await connect(
      application.service,
      reopenedPrincipal,
    );
    const result = await reopenedClient.callTool({
      name: "get_my_change",
      arguments: { changeId },
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("Stored idempotency result");
    expect(JSON.stringify(result)).not.toContain("not-json");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
  });

  it("isolates applied and proposed history for two real authenticated profiles", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T15:00:00.000Z",
      newId: (prefix) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    });
    const realProject = application.service.createProject({ name: "IntentArc" });
    const directProfile = application.service.profiles.createProfile({
      name: "Direct agent",
      projectId: realProject.id,
    });
    application.service.profiles.setAuthority({
      profileId: directProfile.profile.id,
      projectId: realProject.id,
      mode: "full_direct",
    });
    const proposalProfile = application.service.profiles.createProfile({
      name: "Proposal agent",
      projectId: realProject.id,
    });
    const directPrincipal = application.service.profiles.authenticate({
      profileId: directProfile.profile.id,
      token: directProfile.token,
    })!;
    const proposalPrincipal = application.service.profiles.authenticate({
      profileId: proposalProfile.profile.id,
      token: proposalProfile.token,
    })!;
    const directClient = await connect(application.service, directPrincipal);
    const proposalClient = await connect(application.service, proposalPrincipal);

    const directSubmission = await directClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 0,
        idempotencyKey: "direct-profile-change",
        rationale: "Apply one direct decision.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "direct-decision",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Direct decision",
          body: "Owned only by the direct profile.",
        }],
      },
    });
    const proposalSubmission = await proposalClient.callTool({
      name: "submit_change_set",
      arguments: {
        projectId: realProject.id,
        baseProjectRevision: 1,
        idempotencyKey: "proposal-profile-change",
        rationale: "Propose one task.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "proposed-task",
          type: "create_record",
          kind: "task",
          status: "provisional",
          title: "Proposed task",
          body: "Owned only by the proposal profile.",
        }],
      },
    });
    expect(directSubmission.structuredContent).toMatchObject({
      outcome: "applied",
      replayed: false,
    });
    expect(proposalSubmission.structuredContent).toMatchObject({
      outcome: "proposed",
      replayed: false,
    });
    const directChangeId = directSubmission.structuredContent!.changeId as string;
    const proposalChangeId =
      proposalSubmission.structuredContent!.changeId as string;

    const directHistory = await directClient.callTool({
      name: "list_my_changes",
      arguments: { projectId: realProject.id },
    });
    const proposalHistory = await proposalClient.callTool({
      name: "list_my_changes",
      arguments: { projectId: realProject.id },
    });
    expect(directHistory.structuredContent).toEqual({
      changes: [expect.objectContaining({
        changeId: directChangeId,
        profileId: directPrincipal.id,
        outcome: "applied",
      })],
    });
    expect(proposalHistory.structuredContent).toEqual({
      changes: [expect.objectContaining({
        changeId: proposalChangeId,
        profileId: proposalPrincipal.id,
        outcome: "proposed",
      })],
    });
    expect(JSON.parse(
      (directHistory.content[0] as { text: string }).text,
    )).toEqual(directHistory.structuredContent);
    expect(JSON.parse(
      (proposalHistory.content[0] as { text: string }).text,
    )).toEqual(proposalHistory.structuredContent);

    const ownDetail = await proposalClient.callTool({
      name: "get_my_change",
      arguments: { changeId: proposalChangeId },
    });
    expect(ownDetail.structuredContent).toEqual({
      change: expect.objectContaining({
        changeId: proposalChangeId,
        profileId: proposalPrincipal.id,
        proposal: expect.objectContaining({
          origin: {
            type: "profile",
            profileId: proposalPrincipal.id,
          },
        }),
      }),
    });
    expect(JSON.parse(
      (ownDetail.content[0] as { text: string }).text,
    )).toEqual(ownDetail.structuredContent);

    const hiddenDetail = await proposalClient.callTool({
      name: "get_my_change",
      arguments: { changeId: directChangeId },
    });
    expect(hiddenDetail).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Change not found" }],
    });
    expect(JSON.stringify(hiddenDetail)).not.toContain(directChangeId);
    expect(JSON.stringify(hiddenDetail)).not.toContain(directPrincipal.id);
  });

  it("lists projects as both pretty JSON text and structured content", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(createFakeService(calls));

    const result = await connectedClient.callTool({
      name: "list_projects",
      arguments: {},
    });

    expect(calls.listProjects).toBe(1);
    expect(result.structuredContent).toEqual({ projects: [project] });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ projects: [project] }, null, 2),
      },
    ]);
  });

  it("gets the requested project summary as both pretty JSON text and structured content", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(createFakeService(calls));

    const result = await connectedClient.callTool({
      name: "get_project_summary",
      arguments: { projectId: "project-1" },
    });

    expect(calls.projectSummaryIds).toEqual(["project-1"]);
    expect(result.structuredContent).toEqual(summary);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(summary, null, 2) },
    ]);
  });

  it("revalidates the principal and returns content-free review metadata from request_task_context", async () => {
    const calls = emptyCalls();
    const connectedClient = await connect(
      createFakeService(calls),
      authenticatedPrincipal,
    );
    const input: RequestTaskContextInput = {
      projectId: "project-1",
      taskId: "record-task",
      budgetTokens: 1_200,
      idempotencyKey: "mcp-outbound-1",
    };

    const result = await connectedClient.callTool({
      name: "request_task_context",
      arguments: input,
    });

    expect(calls.principalRevalidations).toEqual([authenticatedPrincipal]);
    expect(calls.outboundRequests).toEqual([{
      principal: authenticatedPrincipal,
      input,
    }]);
    expect(calls.taskContextInputs).toEqual([]);
    expect(result.structuredContent).toEqual(outboundRequest);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(outboundRequest, null, 2) },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("review_required");
    expect(serialized).toContain('"findingCounts"');
    expect(serialized).not.toContain("synthetic-secret");
    expect(serialized).not.toContain(taskRecord.title);
    expect(serialized).not.toContain(taskRecord.body);
    expect(serialized).not.toMatch(/stack|cause|SELECT|C:\\|\/home\//);
  });

  it("fails closed when outbound request output contains unchecked context fields", async () => {
    const service = createFakeService(emptyCalls());
    service.outbound.request = () => ({
      ...outboundRequest,
      title: "synthetic-secret title",
      body: "synthetic-secret task body",
      sourceRef: "C:\\private\\source.md",
      findings: [{ value: "synthetic-secret finding" }],
    }) as unknown as OutboundRequestSummary;
    const connectedClient = await connect(
      service,
      authenticatedPrincipal,
    );

    const result = await connectedClient.callTool({
      name: "request_task_context",
      arguments: {
        projectId: "project-1",
        taskId: "record-task",
        budgetTokens: 1_200,
        idempotencyKey: "unchecked-output",
      },
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
  });

  it.each(["review_required", "denied"] as const)(
    "returns %s retrieval as a content-free structured success",
    async (status) => {
      const calls = emptyCalls();
      const service = createFakeService(calls);
      const request = {
        ...outboundRequest,
        status,
        decidedAt: status === "denied"
          ? "2026-07-27T12:06:00.000Z"
          : null,
      };
      service.outbound.getReleased = () => ({ status, request });
      const connectedClient = await connect(
        service,
        authenticatedPrincipal,
      );

      const result = await connectedClient.callTool({
        name: "get_released_context",
        arguments: { requestId: outboundRequest.requestId },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ status, request });
      expect(result.content).toEqual([{
        type: "text",
        text: JSON.stringify({ status, request }, null, 2),
      }]);
      expect(JSON.stringify(result)).not.toContain('"pack"');
      expect(JSON.stringify(result)).not.toContain('"release"');
    },
  );

  it("revalidates the principal and returns the exact released artifact", async () => {
    const calls = emptyCalls();
    const service = createFakeService(calls);
    service.outbound.getReleased = (principal, requestId) => {
      calls.releasedContextReads.push({ principal, requestId });
      return {
        status: "released",
        release: outboundRelease,
      };
    };
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: "get_released_context",
      arguments: { requestId: outboundRequest.requestId },
    });

    expect(calls.principalRevalidations).toEqual([authenticatedPrincipal]);
    expect(calls.releasedContextReads).toEqual([{
      principal: authenticatedPrincipal,
      requestId: outboundRequest.requestId,
    }]);
    expect(result.structuredContent).toEqual({
      status: "released",
      release: outboundRelease,
    });
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify(result.structuredContent, null, 2),
    }]);
  });

  it.each([
    {
      label: "released without an artifact",
      result: { status: "released" },
    },
    {
      label: "pending with an artifact",
      result: {
        status: "review_required",
        request: outboundRequest,
        release: outboundRelease,
      },
    },
    {
      label: "denied with an unchecked field",
      result: {
        status: "denied",
        request: { ...outboundRequest, status: "denied" },
        privateStorageDetail: "C:\\private\\outbound.sqlite",
      },
    },
  ])("rejects $label at the released-result adapter", async ({ result }) => {
    const service = createFakeService(emptyCalls());
    service.outbound.getReleased = () =>
      result as unknown as ReturnType<
        IntentArcService["outbound"]["getReleased"]
      >;
    const connectedClient = await connect(service, authenticatedPrincipal);

    const response = await connectedClient.callTool({
      name: "get_released_context",
      arguments: { requestId: outboundRequest.requestId },
    });

    expect(response).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(response)).not.toContain("privateStorageDetail");
    expect(JSON.stringify(response)).not.toContain("C:\\private");
  });

  it("discloses only the approved immutable release and audits every successful retrieval", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T16:00:00.000Z",
    });
    const realProject = application.service.createProject({
      name: "Outbound MCP",
    });
    const privateTitle = "Synthetic private task title";
    const privateBody = "synthetic-secret task body";
    const destinationEmail = "mcp-routing@example.invalid";
    const destinationToken =
      "sk-proj-SyntheticMcpDestinationToken0123456789";
    const realTask = application.service.createRecord({
      projectId: realProject.id,
      kind: "task",
      status: "active",
      title: privateTitle,
      body: privateBody,
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Outbound MCP profile",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    application.service.destinations.set({
      profileId: principal.id,
      clientLabel: destinationEmail,
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: destinationToken,
      dataBoundary: "remote",
    });
    const connectedClient = await connect(application.service, principal);

    const requested = await connectedClient.callTool({
      name: "request_task_context",
      arguments: {
        projectId: realProject.id,
        taskId: realTask.id,
        budgetTokens: 1_200,
        idempotencyKey: "real-mcp-outbound",
      },
    });
    const requestedJson = JSON.stringify(requested);

    expect(requested).toMatchObject({
      structuredContent: {
        status: "review_required",
        findingCounts: expect.objectContaining({
          total: 2,
          forcedRedact: 2,
        }),
      },
    });
    expect(requestedJson).not.toContain(privateTitle);
    expect(requestedJson).not.toContain(privateBody);
    expect(requestedJson).not.toContain(destinationEmail);
    expect(requestedJson).not.toContain(destinationToken);
    const requestId = requested.structuredContent!.requestId as string;
    const release = application.service.outbound.approve({
      requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    expect(release.disclosure.destination).toMatchObject({
      clientLabel: "[REDACTED:DESTINATION]",
      accountBoundaryLabel: "[REDACTED:DESTINATION]",
    });
    expect(JSON.stringify(release)).not.toContain(destinationEmail);
    expect(JSON.stringify(release)).not.toContain(destinationToken);

    const first = await connectedClient.callTool({
      name: "get_released_context",
      arguments: { requestId },
    });
    const second = await connectedClient.callTool({
      name: "get_released_context",
      arguments: { requestId },
    });

    expect(first.structuredContent).toEqual({
      status: "released",
      release,
    });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(
      application.service.listAuditEvents({
        actionCategory: "outbound_release_retrieved",
        targetId: requestId,
      }),
    ).toHaveLength(2);
  });

  it.each([
    {
      code: "outbound_release_invalid" as const,
      error: new OutboundSafetyError("outbound_release_invalid", {
        requestId: "private-request-id",
      }),
    },
    {
      code: "outbound_destination_changed" as const,
      error: new OutboundSafetyError("outbound_destination_changed", {
        requestId: "private-request-id",
        expectedRevision: 1,
        currentRevision: 2,
      }),
    },
  ])("maps $code to a canonical code-only retrieval failure", async ({
    code,
    error,
  }) => {
    const service = createFakeService(emptyCalls());
    service.outbound.getReleased = () => {
      throw error;
    };
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: "get_released_context",
      arguments: { requestId: outboundRequest.requestId },
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: code }],
    });
    expect(JSON.stringify(result)).not.toContain("private-request-id");
    expect(JSON.stringify(result)).not.toContain(error.message);
    expect(JSON.stringify(result)).not.toMatch(
      /expectedRevision|currentRevision|stack|cause/,
    );
  });

  it("maps outbound request failures to a canonical code without local recovery details", async () => {
    const service = createFakeService(emptyCalls());
    service.outbound.request = () => {
      throw new OutboundSafetyError("outbound_destination_required", {
        profileId: "private-profile-id",
      });
    };
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: "request_task_context",
      arguments: {
        projectId: "project-1",
        taskId: "record-task",
        budgetTokens: 1_200,
        idempotencyKey: "missing-destination",
      },
    });

    expect(result).toEqual({
      isError: true,
      content: [{
        type: "text",
        text: "outbound_destination_required",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("private-profile-id");
    expect(JSON.stringify(result)).not.toContain(
      "Outbound destination is required.",
    );
  });

  it.each([
    {
      tool: "request_task_context",
      configure: (service: IntentArcService) => {
        service.outbound.request = () => {
          throw new Error(
            "SQLITE_ERROR at C:\\private\\intentarc.sqlite token=secret",
          );
        };
      },
      arguments: {
        projectId: "project-1",
        taskId: "record-task",
        budgetTokens: 1_200,
        idempotencyKey: "unexpected-request",
      },
    },
    {
      tool: "get_released_context",
      configure: (service: IntentArcService) => {
        service.outbound.getReleased = () => {
          throw new Error(
            "SQLITE_ERROR at C:\\private\\intentarc.sqlite token=secret",
          );
        };
      },
      arguments: { requestId: outboundRequest.requestId },
    },
  ])("maps unexpected $tool failures to internal_error", async ({
    tool,
    configure,
    arguments: toolArguments,
  }) => {
    const service = createFakeService(emptyCalls());
    configure(service);
    const connectedClient = await connect(service, authenticatedPrincipal);

    const result = await connectedClient.callTool({
      name: tool,
      arguments: toolArguments,
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "internal_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("SQLITE_ERROR");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns known anonymous domain failures without implementation details", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls(), {
        getProjectSummary: () => {
          throw new ProjectNotFoundError("missing-project");
        },
      }),
    );

    const result = await connectedClient.callTool({
      name: "get_project_summary",
      arguments: { projectId: "missing-project" },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{
        type: "text",
        text: "Project not found: missing-project",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(JSON.stringify(result)).not.toContain("sqlite");
  });

  it("does not disclose unexpected anonymous implementation failures", async () => {
    const connectedClient = await connect(
      createFakeService(emptyCalls(), {
        listProjects: () => {
          throw new Error("SQLITE_ERROR at C:\\private\\intentarc.sqlite");
        },
      }),
    );

    const result = await connectedClient.callTool({
      name: "list_projects",
      arguments: {},
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "IntentArc request failed." }],
    });
    expect(JSON.stringify(result)).not.toContain("SQLITE_ERROR");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
  });
});

describe("IntentArc MCP stdio lifecycle", () => {
  const createRuntimeService = (): IntentArcService =>
    createFakeService({
      listProjects: 0,
      projectSummaryIds: [],
      taskContextInputs: [],
      submissions: [],
      changeLists: [],
      changeReads: [],
      principalRevalidations: [],
      outboundRequests: [],
      releasedContextReads: [],
      coordination: [],
      coordinationOrder: [],
    });

  it("retains a Node interpreter directive for the packaged executable", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./bin.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
  });

  it("recognizes the executable when argv reaches it through a filesystem link", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "intentarc-mcp-entry-"),
    );

    try {
      const targetDirectory = join(temporaryDirectory, "target");
      const targetFile = join(targetDirectory, "bin.js");
      const linkedDirectory = join(temporaryDirectory, "linked");
      const linkedFile = join(linkedDirectory, "bin.js");
      await mkdir(targetDirectory);
      await writeFile(targetFile, "");
      await symlink(
        targetDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(isMainModule(linkedFile, pathToFileURL(targetFile).href)).toBe(
        true,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("requires INTENTARC_DB_PATH before creating application resources", async () => {
    let diagnostics = "";
    let exitCode: number | undefined;
    let applicationCreations = 0;

    await runIntentArcMcp({
      environment: {},
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      openApplication: async () => {
        applicationCreations += 1;
        throw new Error("Application must not be created");
      },
    });

    expect(applicationCreations).toBe(0);
    expect(exitCode).toBe(1);
    expect(diagnostics).toBe("INTENTARC_DB_PATH is required.\n");
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "resolves the database path, creates one runtime, and closes it once on %s",
    async (signal) => {
      const signalSource = new EventEmitter();
      const [peerTransport, runtimeTransport] =
        InMemoryTransport.createLinkedPair();
      const service = createRuntimeService();
      const databasePaths: string[] = [];
      let applicationCloses = 0;
      let serverCreations = 0;
      let transportCreations = 0;

      try {
        await runIntentArcMcp({
          environment: { INTENTARC_DB_PATH: "data/intentarc.sqlite" },
          stderr: { write: () => undefined },
          signalSource,
          setExitCode: () => undefined,
          openApplication: async ({ databasePath }) => {
            databasePaths.push(databasePath);

            return {
              service,
              close: () => {
                applicationCloses += 1;
              },
            };
          },
          createServer: (applicationService) => {
            serverCreations += 1;
            return createIntentArcMcpServer(applicationService);
          },
          createTransport: () => {
            transportCreations += 1;
            return runtimeTransport;
          },
        });

        expect(databasePaths).toEqual([resolve("data/intentarc.sqlite")]);
        expect(serverCreations).toBe(1);
        expect(transportCreations).toBe(1);

        signalSource.emit(signal);
        await new Promise<void>((complete) => {
          setImmediate(complete);
        });
        signalSource.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");

        expect(applicationCloses).toBe(1);
      } finally {
        await peerTransport.close();
        await runtimeTransport.close();
      }
    },
  );

  it("waits for application preparation before constructing MCP resources", async () => {
    const temporaryDatabase = createTemporaryDatabase();
    const preparation = Promise.withResolvers<IntentArcApplication>();
    const [peerTransport, runtimeTransport] =
      InMemoryTransport.createLinkedPair();
    let applicationCloses = 0;
    let serverCreations = 0;
    let transportCreations = 0;
    const run = runIntentArcMcp({
      environment: { INTENTARC_DB_PATH: temporaryDatabase.path },
      stderr: { write: () => undefined },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: () => undefined,
      openApplication: () => preparation.promise,
      createServer: (service) => {
        serverCreations += 1;
        return createIntentArcMcpServer(service);
      },
      createTransport: () => {
        transportCreations += 1;
        return runtimeTransport;
      },
    });

    try {
      await new Promise<void>((complete) => setImmediate(complete));

      expect(serverCreations).toBe(0);
      expect(transportCreations).toBe(0);

      preparation.resolve({
        service: createRuntimeService(),
        close: () => {
          applicationCloses += 1;
        },
      });
      await run;

      expect(serverCreations).toBe(1);
      expect(transportCreations).toBe(1);

      await runtimeTransport.close();
      await new Promise<void>((complete) => setImmediate(complete));
      expect(applicationCloses).toBe(1);
    } finally {
      preparation.resolve({
        service: createRuntimeService(),
        close: () => undefined,
      });
      await run;
      await peerTransport.close();
      await runtimeTransport.close();
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it.each([
    {
      label: "stdin end",
      trigger: ({
        stdin,
      }: {
        signalSource: EventEmitter;
        stdin: EventEmitter;
      }) => {
        stdin.emit("end");
      },
    },
    {
      label: "stdin close",
      trigger: ({
        stdin,
      }: {
        signalSource: EventEmitter;
        stdin: EventEmitter;
      }) => {
        stdin.emit("close");
      },
    },
    {
      label: "SIGINT",
      trigger: ({
        signalSource,
      }: {
        signalSource: EventEmitter;
        stdin: EventEmitter;
      }) => {
        signalSource.emit("SIGINT");
      },
    },
    {
      label: "SIGTERM",
      trigger: ({
        signalSource,
      }: {
        signalSource: EventEmitter;
        stdin: EventEmitter;
      }) => {
        signalSource.emit("SIGTERM");
      },
    },
  ])("retains $label shutdown while application preparation is pending", async ({
    trigger,
  }) => {
    const preparation = Promise.withResolvers<IntentArcApplication>();
    const signalSource = new EventEmitter();
    const stdin = new EventEmitter();
    const [peerTransport, runtimeTransport] =
      InMemoryTransport.createLinkedPair();
    let applicationCloses = 0;
    let serverCreations = 0;
    let transportCreations = 0;
    let diagnostics = "";
    const run = runIntentArcMcp({
      environment: { INTENTARC_DB_PATH: "intentarc.sqlite" },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource,
      stdin,
      setExitCode: () => undefined,
      openApplication: () => preparation.promise,
      createServer: (service) => {
        serverCreations += 1;
        return createIntentArcMcpServer(service);
      },
      createTransport: () => {
        transportCreations += 1;
        return runtimeTransport;
      },
    });

    try {
      await new Promise<void>((complete) => setImmediate(complete));
      trigger({ signalSource, stdin });
      trigger({ signalSource, stdin });

      preparation.resolve({
        service: createRuntimeService(),
        close: () => {
          applicationCloses += 1;
        },
      });
      await run;

      signalSource.emit("SIGTERM");
      stdin.emit("end");
      stdin.emit("close");
      await new Promise<void>((complete) => setImmediate(complete));

      expect(applicationCloses).toBe(1);
      expect(serverCreations).toBe(0);
      expect(transportCreations).toBe(0);
      expect(diagnostics).toBe("");
    } finally {
      preparation.resolve({
        service: createRuntimeService(),
        close: () => undefined,
      });
      signalSource.emit("SIGTERM");
      await run;
      await peerTransport.close();
      await runtimeTransport.close();
    }
  });

  it("closes the application when the MCP transport closes", async () => {
    const signalSource = new EventEmitter();
    const [peerTransport, runtimeTransport] =
      InMemoryTransport.createLinkedPair();
    let applicationCloses = 0;

    try {
      await runIntentArcMcp({
        environment: { INTENTARC_DB_PATH: "intentarc.sqlite" },
        stderr: { write: () => undefined },
        signalSource,
        setExitCode: () => undefined,
        openApplication: async () => ({
          service: createRuntimeService(),
          close: () => {
            applicationCloses += 1;
          },
        }),
        createTransport: () => runtimeTransport,
      });

      await runtimeTransport.close();
      await new Promise<void>((complete) => {
        setImmediate(complete);
      });

      expect(applicationCloses).toBe(1);
    } finally {
      await peerTransport.close();
      await runtimeTransport.close();
    }
  });

  it("closes the application exactly once when a real stdin stream reaches EOF", async () => {
    const signalSource = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const temporaryDatabase = createTemporaryDatabase();
    const applicationClosed = Promise.withResolvers<void>();
    let actualApplication: IntentArcApplication | undefined;
    let applicationCloses = 0;
    let diagnostics = "";
    let protocolOutput = "";
    stdout.on("data", (chunk: Buffer) => {
      protocolOutput += chunk.toString();
    });

    try {
      const runtimeOptions = {
        environment: { INTENTARC_DB_PATH: temporaryDatabase.path },
        stderr: {
          write: (message: string) => {
            diagnostics += message;
          },
        },
        signalSource,
        stdin,
        setExitCode: () => undefined,
        openApplication: async ({ databasePath }: { databasePath: string }) => {
          actualApplication = await openIntentArcApplication({ databasePath });

          return {
            service: actualApplication.service,
            close: () => {
              applicationCloses += 1;
              actualApplication?.close();
              applicationClosed.resolve();
            },
          };
        },
        createTransport: () => new StdioServerTransport(stdin, stdout),
      };

      await runIntentArcMcp(runtimeOptions);

      const stdinClosed = once(stdin, "close");
      stdin.resume();
      stdin.end();
      await stdinClosed;
      await applicationClosed.promise;

      expect(applicationCloses).toBe(1);
      expect(diagnostics).toBe("");
      expect(protocolOutput).toBe("");

      const maintenance =
        createLeaseManager().acquireMaintenance(temporaryDatabase.path);
      maintenance.release();

      signalSource.emit("SIGINT");
      await new Promise<void>((complete) => {
        setImmediate(complete);
      });

      expect(applicationCloses).toBe(1);
    } finally {
      stdin.destroy();
      stdout.destroy();
      actualApplication?.close();
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("closes partially created resources and reports only to stderr on startup failure", async () => {
    const signalSource = new EventEmitter();
    let diagnostics = "";
    let exitCode: number | undefined;
    let applicationCloses = 0;
    let transportCloses = 0;
    const failingTransport: Transport = {
      start: async () => {
        throw new Error("sensitive startup detail");
      },
      send: async () => undefined,
      close: async () => {
        transportCloses += 1;
      },
    };

    await runIntentArcMcp({
      environment: { INTENTARC_DB_PATH: "intentarc.sqlite" },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource,
      setExitCode: (code) => {
        exitCode = code;
      },
      openApplication: async () => ({
        service: createRuntimeService(),
        close: () => {
          applicationCloses += 1;
        },
      }),
      createTransport: () => failingTransport,
    });

    expect(applicationCloses).toBe(1);
    expect(transportCloses).toBe(1);
    expect(exitCode).toBe(1);
    expect(diagnostics).toBe("IntentArc MCP failed to start.\n");
    expect(diagnostics).not.toContain("sensitive startup detail");
  });
});
