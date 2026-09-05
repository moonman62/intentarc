import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  InMemoryTransport,
  type InMemoryTransport as InMemoryTransportInstance,
} from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import type { ChangeSubmissionResult } from "../core/change-service.js";
import type {
  IntentArcService,
  ProjectSummary,
} from "../core/intentarc-service.js";
import {
  getReleasedContextResultSchema,
  requestTaskContextResultSchema,
  type OutboundRelease,
  type ProfileCredentials,
} from "../domain/index.js";
import { createIntentArcMcpServer } from "../mcp/server.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

type McpSession = {
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransportInstance;
  serverTransport: InMemoryTransportInstance;
};

const connectMcp = async (
  service: IntentArcService,
  credentials: ProfileCredentials,
  clientName: string,
): Promise<McpSession> => {
  const principal = service.profiles.authenticate(credentials);
  if (!principal) throw new Error("Expected an authenticated Safe profile");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createIntentArcMcpServer(service, principal);
  const client = new Client({ name: clientName, version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server, clientTransport, serverTransport };
};

const closeMcp = async (session: McpSession | undefined): Promise<void> => {
  if (!session) return;
  await Promise.allSettled([
    session.client.close(),
    session.server.close(),
    session.clientTransport.close(),
    session.serverTransport.close(),
  ]);
};

const callTool = async <Result extends object>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Result> => {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Result;
};

describe("one-archive client portability", () => {
  let application: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;
  let codexSession: McpSession | undefined;
  let claudeSession: McpSession | undefined;

  afterEach(async () => {
    await Promise.allSettled([closeMcp(codexSession), closeMcp(claudeSession)]);
    application?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  it("preserves task evidence and immutable profile-owned releases across a client switch", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });

    const project = application.service.createProject({
      name: "Hermetic client portability",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Switch supported clients",
      body: "Prove that governed context survives a supported client switch.",
      sourceKind: "human",
      sourceRef: null,
    });
    const baselineEvidence = application.service.createRecord({
      projectId: project.id,
      kind: "evidence",
      status: "accepted",
      title: "Archive continuity baseline",
      body: "The temporary archive begins with retained evidence.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: baselineEvidence.id,
      toRecordId: task.id,
      kind: "evidenced_by",
      expectedProjectRevision: 2,
    });
    const stableVision = application.service.createRecord({
      projectId: project.id,
      kind: "vision",
      status: "accepted",
      title: "Stable portability intent",
      body: "Preserve governed project intent across supported clients.",
      sourceKind: "human",
      sourceRef: null,
    });
    const mandatoryConstraint = application.service.createRecord({
      projectId: project.id,
      kind: "constraint",
      status: "accepted",
      title: "Mandatory portability constraint",
      body: "MANDATORY: retain governed task context and release ownership.",
      sourceKind: "human",
      sourceRef: null,
    });
    const expectedTask = Object.freeze({ ...task });
    const expectedVision = Object.freeze({ ...stableVision });
    const expectedConstraint = Object.freeze({ ...mandatoryConstraint });
    const fixtureRevision = application.service
      .getProjectSummary(project.id).project.revision;
    expect(fixtureRevision).toBe(5);

    const codexCredentials = application.service.profiles.createProfile({
      name: "Codex Safe",
      projectId: project.id,
      executionMode: "safe",
    });
    const claudeCredentials = application.service.profiles.createProfile({
      name: "Claude Safe",
      projectId: project.id,
      executionMode: "safe",
    });
    application.service.destinations.set({
      profileId: codexCredentials.profile.id,
      clientLabel: "Codex Safe destination",
      type: "ide_managed",
      providerLabel: "Codex",
      modelLabel: "Codex model",
      accountBoundaryLabel: "Codex account",
      dataBoundary: "remote",
    });
    application.service.destinations.set({
      profileId: claudeCredentials.profile.id,
      clientLabel: "Claude Safe destination",
      type: "ide_managed",
      providerLabel: "Claude",
      modelLabel: "Claude model",
      accountBoundaryLabel: "Claude account",
      dataBoundary: "remote",
    });

    codexSession = await connectMcp(
      application.service,
      {
        profileId: codexCredentials.profile.id,
        token: codexCredentials.token,
      },
      "intentarc-codex-portability-session",
    );
    claudeSession = await connectMcp(
      application.service,
      {
        profileId: claudeCredentials.profile.id,
        token: claudeCredentials.token,
      },
      "intentarc-claude-portability-session",
    );

    expect(codexCredentials.profile).toMatchObject({
      name: "Codex Safe",
      executionMode: "safe",
    });
    expect(claudeCredentials.profile).toMatchObject({
      name: "Claude Safe",
      executionMode: "safe",
    });
    expect(claudeCredentials.profile.id).not.toBe(codexCredentials.profile.id);
    expect(claudeSession.client).not.toBe(codexSession.client);
    expect(claudeSession.server).not.toBe(codexSession.server);
    expect(temporaryDatabase.path).toBeDefined();

    const before = await callTool<ProjectSummary>(
      codexSession.client,
      "get_project_summary",
      { projectId: project.id },
    );
    expect(before).toMatchObject({
      project: { id: project.id, revision: 5 },
      recordsByKind: {
        task: 1,
        evidence: 1,
        vision: 1,
        constraint: 1,
      },
      activeTasks: [{
        id: expectedTask.id,
        title: expectedTask.title,
        status: expectedTask.status,
      }],
    });

    const requested = requestTaskContextResultSchema.parse(
      await callTool(
        codexSession.client,
        "request_task_context",
        {
          projectId: project.id,
          taskId: task.id,
          budgetTokens: 4000,
          idempotencyKey: "codex-portability-release",
        },
      ),
    );
    expect(requested).toMatchObject({
      profileId: codexCredentials.profile.id,
      projectId: project.id,
      taskId: task.id,
      projectRevision: 5,
      status: "review_required",
    });

    const submitted = await callTool<ChangeSubmissionResult>(
      codexSession.client,
      "submit_change_set",
      {
        projectId: project.id,
        sourceTaskId: task.id,
        baseProjectRevision: before.project.revision,
        idempotencyKey: "codex-portability-evidence",
        rationale: "Attach client-A portability evidence to the active task.",
        operations: [{
          operationId: "create-portability-evidence",
          type: "create_record",
          localRef: "portability-evidence",
          kind: "evidence",
          status: "accepted",
          title: "Client A portability evidence",
          body:
            "Codex attached governed evidence for the supported client switch.",
        }, {
          operationId: "link-portability-evidence",
          type: "create_relationship",
          from: { localRef: "portability-evidence" },
          to: { recordId: task.id },
          kind: "evidenced_by",
        }],
      },
    );
    expect(submitted).toMatchObject({
      outcome: "proposed",
      state: "pending",
      replayed: false,
    });
    if (submitted.outcome !== "proposed") {
      throw new Error("Codex evidence submission did not create a proposal");
    }

    const codexApproved = application.service.outbound.approve({
      requestId: requested.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    const codexReleased = getReleasedContextResultSchema.parse(
      await callTool(
        codexSession.client,
        "get_released_context",
        { requestId: requested.requestId },
      ),
    );
    if (codexReleased.status !== "released") {
      throw new Error("Codex release was not retrievable");
    }
    const codexRelease: OutboundRelease = codexReleased.release;
    expect(codexRelease).toEqual(codexApproved);
    expect(codexRelease.pack).toMatchObject({
      projectId: project.id,
      taskId: task.id,
      projectRevision: 5,
      related: [
        expect.objectContaining({
          record: expect.objectContaining({ id: baselineEvidence.id }),
          relationshipKind: "evidenced_by",
        }),
      ],
    });
    expect(codexRelease.pack.task.record).toEqual(expectedTask);
    expect(codexRelease.pack.stableFrame).toEqual([
      {
        record: expectedVision,
        mandatory: true,
        relevance: "stable_frame",
        relationshipKind: null,
      },
      {
        record: expectedConstraint,
        mandatory: true,
        relevance: "stable_frame",
        relationshipKind: null,
      },
    ]);

    const crossProfileRead = await claudeSession.client.callTool({
      name: "get_released_context",
      arguments: { requestId: requested.requestId },
    });
    expect(crossProfileRead).toEqual({
      isError: true,
      content: [{ type: "text", text: "outbound_release_invalid" }],
    });

    const accepted = application.service.proposals.accept(
      submitted.proposalId,
    );
    expect(accepted).toMatchObject({
      outcome: "applied",
      changeId: submitted.changeId,
      proposalId: submitted.proposalId,
      projectRevision: 6,
    });
    if (accepted.outcome !== "applied") {
      throw new Error("Local human did not apply the Codex evidence proposal");
    }
    const evidenceOperation = accepted.operations.find(
      (operation) =>
        operation.operationId === "create-portability-evidence" &&
        operation.type === "create_record",
    );
    const relationshipOperation = accepted.operations.find(
      (operation) =>
        operation.operationId === "link-portability-evidence" &&
        operation.type === "create_relationship",
    );
    if (
      !evidenceOperation ||
      evidenceOperation.type !== "create_record" ||
      !relationshipOperation ||
      relationshipOperation.type !== "create_relationship"
    ) {
      throw new Error("Accepted proposal did not return linked evidence");
    }
    const evidenceId = evidenceOperation.record.id;
    expect(evidenceOperation.record).toMatchObject({
      id: evidenceId,
      projectId: project.id,
      kind: "evidence",
      sourceKind: "agent",
      sourceRef: codexCredentials.profile.id,
    });
    expect(relationshipOperation.relationship).toMatchObject({
      projectId: project.id,
      fromRecordId: evidenceId,
      toRecordId: task.id,
      kind: "evidenced_by",
    });

    const after = await callTool<ProjectSummary>(
      claudeSession.client,
      "get_project_summary",
      { projectId: project.id },
    );
    expect(after.project.revision).toBe(6);
    expect(after).toMatchObject({
      project: { id: project.id },
      recordsByKind: {
        task: 1,
        evidence: 2,
        vision: 1,
        constraint: 1,
      },
      activeTasks: [{
        id: expectedTask.id,
        title: expectedTask.title,
        status: expectedTask.status,
      }],
    });

    const claudeRequested = requestTaskContextResultSchema.parse(
      await callTool(
        claudeSession.client,
        "request_task_context",
        {
          projectId: project.id,
          taskId: task.id,
          budgetTokens: 4000,
          idempotencyKey: "claude-portability-release",
        },
      ),
    );
    expect(claudeRequested).toMatchObject({
      profileId: claudeCredentials.profile.id,
      projectId: project.id,
      taskId: task.id,
      projectRevision: 6,
      status: "review_required",
    });

    const claudeApproved = application.service.outbound.approve({
      requestId: claudeRequested.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    const claudeReleased = getReleasedContextResultSchema.parse(
      await callTool(
        claudeSession.client,
        "get_released_context",
        { requestId: claudeRequested.requestId },
      ),
    );
    if (claudeReleased.status !== "released") {
      throw new Error("Claude release was not retrievable");
    }
    const claudeRelease = claudeReleased.release;
    expect(claudeRelease).toEqual(claudeApproved);
    expect(claudeRelease.releaseId).not.toBe(codexRelease.releaseId);
    expect(claudeRelease.pack.projectRevision).toBe(6);
    expect(claudeRelease.pack.task.record).toEqual(expectedTask);
    expect(claudeRelease.pack.stableFrame).toEqual([
      {
        record: expectedVision,
        mandatory: true,
        relevance: "stable_frame",
        relationshipKind: null,
      },
      {
        record: expectedConstraint,
        mandatory: true,
        relevance: "stable_frame",
        relationshipKind: null,
      },
    ]);
    expect(claudeRelease.pack.related).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record: expect.objectContaining({
          id: evidenceId,
          kind: "evidence",
        }),
        relationshipKind: "evidenced_by",
      }),
    ]));

    const codexReleasedAgain = getReleasedContextResultSchema.parse(
      await callTool(
        codexSession.client,
        "get_released_context",
        { requestId: requested.requestId },
      ),
    );
    if (codexReleasedAgain.status !== "released") {
      throw new Error("Codex immutable release was not retained");
    }
    expect(codexReleasedAgain.release).toEqual(codexRelease);

    expect(application.service.outbound.list({})).toContainEqual(
      expect.objectContaining({
        requestId: requested.requestId,
        profileId: codexCredentials.profile.id,
        projectRevision: 5,
        status: "released",
      }),
    );
    expect(application.service.outbound.list({})).toContainEqual(
      expect.objectContaining({
        requestId: claudeRequested.requestId,
        profileId: claudeCredentials.profile.id,
        projectRevision: 6,
        status: "released",
      }),
    );
    const audit = application.service.listAuditEvents({
      projectId: project.id,
      limit: 100,
    });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: codexCredentials.profile.id,
        actionCategory: "outbound_release_retrieved",
        targetId: requested.requestId,
      }),
      expect.objectContaining({
        profileId: claudeCredentials.profile.id,
        actionCategory: "outbound_release_retrieved",
        targetId: claudeRequested.requestId,
      }),
      expect.objectContaining({
        actorType: "local_human",
        actionCategory: "proposal_accepted",
        targetId: submitted.proposalId,
        revisionBefore: 5,
        revisionAfter: 6,
      }),
    ]));
    expect(
      audit.filter(
        ({ actionCategory, targetId }) =>
          actionCategory === "outbound_release_retrieved" &&
          targetId === requested.requestId,
      ),
    ).toHaveLength(2);
  });
});
