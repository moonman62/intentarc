import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  InMemoryTransport,
  type InMemoryTransport as InMemoryTransportInstance,
} from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
  type IntentArcIdPrefix,
} from "../app/create-application.js";
import { createProgram } from "../cli/program.js";
import type {
  ChangeSubmissionResult,
} from "../core/change-service.js";
import type {
  IntentArcService,
  ProjectSummary,
} from "../core/intentarc-service.js";
import {
  GovernanceError,
  type AuditEvent,
  type ClientProfile,
  type ClientProfileSummary,
  type ProfileCredentials,
  type Project,
  type SubmitChangeSetInput,
} from "../domain/index.js";
import { runIntentArcMcp } from "../mcp/bin.js";
import { createIntentArcMcpServer } from "../mcp/server.js";
import { openDatabase } from "../storage/database.js";
import type {
  ChangeProposalSummary,
  ProposalDecisionResult,
} from "../storage/governance-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

type CapturedOutput = {
  write(chunk: string): boolean;
  text(): string;
};

type CreatedProfileOutput = {
  profile: ClientProfile;
  token: string;
};

type McpSession = {
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransportInstance;
  serverTransport: InMemoryTransportInstance;
};

const captureOutput = (): CapturedOutput => {
  let output = "";

  return {
    write(chunk) {
      output += chunk;
      return true;
    },
    text: () => output,
  };
};

const runCli = async <Result>(
  service: IntentArcService,
  arguments_: string[],
): Promise<Result> => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const program = createProgram({
    service,
    stdout,
    stderr,
    stdin: { isTTY: false },
    confirmationService: { confirm: async () => true },
  });

  await program.parseAsync(arguments_, { from: "user" });

  expect(stderr.text()).toBe("");
  return JSON.parse(stdout.text()) as Result;
};

const connectMcp = async (
  service: IntentArcService,
  credentials: ProfileCredentials | null,
): Promise<McpSession> => {
  const principal = service.profiles.authenticate(credentials);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createIntentArcMcpServer(service, principal);
  const client = new Client({
    name: "intentarc-change-governance-scenario",
    version: "1.0.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    clientTransport,
    serverTransport,
  };
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

const readDatabase = <Result>(
  databasePath: string,
  read: (database: ReturnType<typeof openDatabase>) => Result,
): Result => {
  const database = openDatabase(databasePath);
  try {
    return read(database);
  } finally {
    database.close();
  }
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const readAllPersistedText = (
  databasePath: string,
): Array<{ table: string; column: string; value: string }> =>
  readDatabase(databasePath, (database) => {
    const values: Array<{ table: string; column: string; value: string }> = [];
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    for (const { name: table } of tables) {
      const columns = database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as Array<{ name: string; type: string }>;

      for (const { name: column, type } of columns) {
        if (!type.toUpperCase().includes("TEXT")) continue;

        const quotedColumn = quoteIdentifier(column);
        const rows = database
          .prepare(
            `SELECT ${quotedColumn} AS value
             FROM ${quoteIdentifier(table)}
             WHERE ${quotedColumn} IS NOT NULL`,
          )
          .all() as Array<{ value: unknown }>;
        for (const { value } of rows) {
          if (typeof value === "string") {
            values.push({ table, column, value });
          }
        }
      }
    }

    return values;
  });

const createIdFactory = (): ((prefix: IntentArcIdPrefix) => string) => {
  let sequence = 0;
  return (prefix) => `${prefix}-governance-${++sequence}`;
};

const createClock = (): (() => string) => {
  let timestamp = Date.parse("2026-07-27T10:00:00.000Z");
  return () => new Date(timestamp++).toISOString();
};

describe("IntentArc authoritative change governance", () => {
  let application: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;
  let mcpSession: McpSession | undefined;

  afterEach(async () => {
    await closeMcp(mcpSession);
    application?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("preserves one governed workflow across retries, authority modes, conflicts, restarts, and disablement", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const now = createClock();
    const newId = createIdFactory();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now,
      newId,
    });

    const project = await runCli<Project>(application.service, [
      "project",
      "create",
      "--name",
      "Authoritative change governance",
    ]);
    const createdProfile = await runCli<CreatedProfileOutput>(
      application.service,
      [
        "profile",
        "create",
        "--name",
        "Governed MCP client",
        "--project",
        project.id,
      ],
    );
    const credentials = {
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    };
    const tokenDigest = readDatabase(
      temporaryDatabase.path,
      (database) =>
        database
          .prepare("SELECT token_hash FROM client_profiles WHERE id = ?")
          .get(createdProfile.profile.id) as { token_hash: string },
    ).token_hash;

    expect(project.revision).toBe(0);
    expect(createdProfile.profile.status).toBe("enabled");
    expect(tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenDigest).not.toBe(createdProfile.token);

    mcpSession = await connectMcp(application.service, credentials);
    const initialTaskSubmission: SubmitChangeSetInput = {
      projectId: project.id,
      baseProjectRevision: 0,
      idempotencyKey: "scenario-create-task",
      rationale: "Create the task through proposal-default governance.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-task",
        type: "create_record",
        localRef: "governance-task",
        kind: "task",
        status: "active",
        title: "Prove authoritative governance",
        body: "Exercise proposal, scoped-direct, and full-direct authority.",
      }],
    };
    const concurrentInitialResults = await Promise.all([
      callTool<ChangeSubmissionResult>(
        mcpSession.client,
        "submit_change_set",
        initialTaskSubmission,
      ),
      callTool<ChangeSubmissionResult>(
        mcpSession.client,
        "submit_change_set",
        initialTaskSubmission,
      ),
    ]);
    const proposed = concurrentInitialResults.find(
      ({ replayed }) => !replayed,
    );
    const concurrentReplay = concurrentInitialResults.find(
      ({ replayed }) => replayed,
    );

    expect(proposed).toMatchObject({
      outcome: "proposed",
      state: "pending",
      replayed: false,
    });
    expect(concurrentReplay).toEqual({
      ...proposed,
      replayed: true,
    });
    expect(
      await runCli<ProjectSummary>(application.service, [
        "project",
        "summary",
        "--project",
        project.id,
      ]),
    ).toMatchObject({
      project: { revision: 0 },
      recordsByKind: {},
      activeTasks: [],
    });
    const proposalsBeforeAcceptance = await runCli<ChangeProposalSummary[]>(
      application.service,
      ["proposal", "list", "--project", project.id],
    );
    expect(proposalsBeforeAcceptance).toHaveLength(1);
    expect(proposalsBeforeAcceptance[0]).toMatchObject({
      id: proposed?.outcome === "proposed" ? proposed.proposalId : "",
      state: "pending",
    });

    const accepted = await runCli<ProposalDecisionResult>(
      application.service,
      [
        "proposal",
        "accept",
        "--proposal",
        proposalsBeforeAcceptance[0]!.id,
      ],
    );
    expect(accepted).toMatchObject({
      outcome: "applied",
      changeId: proposed?.changeId,
      proposalId: proposalsBeforeAcceptance[0]!.id,
      projectRevision: 1,
    });
    expect(accepted.operations).toHaveLength(1);
    const createdTaskOperation = accepted.operations[0]!;
    expect(createdTaskOperation).toMatchObject({
      operationId: "create-task",
      type: "create_record",
      record: {
        kind: "task",
        status: "active",
        revision: 1,
        sourceKind: "agent",
        sourceRef: createdProfile.profile.id,
      },
    });
    if (createdTaskOperation.type !== "create_record") {
      throw new Error("Accepted task creation returned the wrong operation");
    }
    const taskId = createdTaskOperation.record.id;

    const acceptedReplay = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      initialTaskSubmission,
    );
    expect(acceptedReplay).toMatchObject({
      outcome: "applied",
      changeId: accepted.changeId,
      projectRevision: 1,
      replayed: true,
      operations: [
        {
          operationId: "create-task",
          type: "create_record",
          record: { id: taskId, revision: 1 },
        },
      ],
    });
    expect(
      await runCli<ChangeProposalSummary[]>(application.service, [
        "proposal",
        "list",
        "--project",
        project.id,
      ]),
    ).toHaveLength(1);
    expect(
      (
        await runCli<ProjectSummary>(application.service, [
          "project",
          "summary",
          "--project",
          project.id,
        ])
      ).project.revision,
    ).toBe(1);

    await runCli(application.service, [
      "profile",
      "set-authority",
      "--profile",
      createdProfile.profile.id,
      "--project",
      project.id,
      "--mode",
      "scoped_direct",
    ]);
    await runCli(application.service, [
      "profile",
      "add-scope",
      "--profile",
      createdProfile.profile.id,
      "--project",
      project.id,
      "--operation",
      "update_record",
      "--record-kind",
      "task",
    ]);

    const scopedUpdateInput: SubmitChangeSetInput = {
      projectId: project.id,
      baseProjectRevision: 1,
      idempotencyKey: "scenario-scoped-update",
      rationale: "Update the task within its explicit direct-write scope.",
      sourceTaskId: taskId,
      predecessorProposalId: null,
      operations: [{
        operationId: "update-task-scoped",
        type: "update_record",
        recordId: taskId,
        expectedRecordRevision: 1,
        patch: { status: "blocked" },
      }],
    };
    const scopedUpdate = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      scopedUpdateInput,
    );
    expect(scopedUpdate).toMatchObject({
      outcome: "applied",
      projectRevision: 2,
      replayed: false,
      operations: [{
        operationId: "update-task-scoped",
        type: "update_record",
        record: { id: taskId, status: "blocked", revision: 2 },
      }],
    });

    const mixedInput: SubmitChangeSetInput = {
      projectId: project.id,
      baseProjectRevision: 2,
      idempotencyKey: "scenario-mixed-scope",
      rationale: "Keep an allowed task update atomic with an unallowed decision.",
      sourceTaskId: taskId,
      predecessorProposalId: null,
      operations: [
        {
          operationId: "update-task-mixed",
          type: "update_record",
          recordId: taskId,
          expectedRecordRevision: 2,
          patch: { status: "active" },
        },
        {
          operationId: "create-decision-mixed",
          type: "create_record",
          kind: "decision",
          status: "provisional",
          title: "Mixed scoped decision",
          body: "This decision must remain proposed with the task update.",
        },
      ],
    };
    const mixed = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      mixedInput,
    );
    expect(mixed).toMatchObject({
      outcome: "proposed",
      state: "pending",
      replayed: false,
    });
    if (mixed.outcome !== "proposed") {
      throw new Error("Mixed scoped submission did not create a proposal");
    }
    const mixedProposal = application.service.proposals.get(mixed.proposalId);
    expect(mixedProposal.operations).toEqual([
      {
        operationId: "update-task-mixed",
        type: "update_record",
        recordId: taskId,
        expectedRecordRevision: 2,
        patch: { status: "active" },
      },
      {
        operationId: "create-decision-mixed",
        type: "create_record",
        kind: "decision",
        status: "provisional",
        title: "Mixed scoped decision",
        body: "This decision must remain proposed with the task update.",
      },
    ]);
    expect(
      readDatabase(temporaryDatabase.path, (database) => ({
        project: database
          .prepare("SELECT revision FROM projects WHERE id = ?")
          .get(project.id),
        task: database
          .prepare(
            "SELECT status, revision FROM project_records WHERE id = ?",
          )
          .get(taskId),
        decisions: database
          .prepare(
            "SELECT COUNT(*) AS count FROM project_records WHERE project_id = ? AND kind = 'decision'",
          )
          .get(project.id),
      })),
    ).toEqual({
      project: { revision: 2 },
      task: { status: "blocked", revision: 2 },
      decisions: { count: 0 },
    });
    expect(
      await runCli<ChangeProposalSummary[]>(application.service, [
        "proposal",
        "list",
        "--project",
        project.id,
      ]),
    ).toHaveLength(2);

    await runCli(application.service, [
      "profile",
      "set-authority",
      "--profile",
      createdProfile.profile.id,
      "--project",
      project.id,
      "--mode",
      "full_direct",
    ]);
    const fullDirectInput: SubmitChangeSetInput = {
      projectId: project.id,
      baseProjectRevision: 2,
      idempotencyKey: "scenario-full-direct",
      rationale: "Apply an ordered create, link, and update atomically.",
      sourceTaskId: taskId,
      predecessorProposalId: null,
      operations: [
        {
          operationId: "create-decision-direct",
          type: "create_record",
          localRef: "direct-decision",
          kind: "decision",
          status: "accepted",
          title: "Use one governed transaction",
          body: "Create, link, and update at one semantic project revision.",
        },
        {
          operationId: "link-decision-direct",
          type: "create_relationship",
          from: { recordId: taskId },
          to: { localRef: "direct-decision" },
          kind: "decided_by",
        },
        {
          operationId: "update-task-direct",
          type: "update_record",
          recordId: taskId,
          expectedRecordRevision: 2,
          patch: {
            status: "active",
            title: "Governance workflow proven",
          },
        },
      ],
    };
    const fullDirect = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      fullDirectInput,
    );
    expect(fullDirect).toMatchObject({
      outcome: "applied",
      projectRevision: 3,
      replayed: false,
    });
    if (fullDirect.outcome !== "applied") {
      throw new Error("Full-direct submission was not applied");
    }
    expect(fullDirect.operations.map(({ type }) => type)).toEqual([
      "create_record",
      "create_relationship",
      "update_record",
    ]);
    const directDecisionOperation = fullDirect.operations[0]!;
    const directRelationshipOperation = fullDirect.operations[1]!;
    if (
      directDecisionOperation.type !== "create_record" ||
      directRelationshipOperation.type !== "create_relationship"
    ) {
      throw new Error("Full-direct operations returned in the wrong order");
    }
    expect(directRelationshipOperation.relationship).toMatchObject({
      fromRecordId: taskId,
      toRecordId: directDecisionOperation.record.id,
      kind: "decided_by",
    });
    expect(
      readDatabase(temporaryDatabase.path, (database) => ({
        project: database
          .prepare("SELECT revision FROM projects WHERE id = ?")
          .get(project.id),
        records: database
          .prepare(
            "SELECT kind, revision FROM project_records WHERE project_id = ? ORDER BY kind",
          )
          .all(project.id),
        relationships: database
          .prepare(
            "SELECT COUNT(*) AS count FROM record_relationships WHERE project_id = ?",
          )
          .get(project.id),
        snapshots: database
          .prepare(
            "SELECT record_id, revision FROM project_record_revisions ORDER BY record_id, revision",
          )
          .all(),
        snapshotCount: database
          .prepare(
            "SELECT COUNT(*) AS count FROM project_record_revisions",
          )
          .get(),
      })),
    ).toEqual({
      project: { revision: 3 },
      records: [
        { kind: "decision", revision: 1 },
        { kind: "task", revision: 3 },
      ],
      relationships: { count: 1 },
      snapshots: expect.arrayContaining([
        { record_id: directDecisionOperation.record.id, revision: 1 },
        { record_id: taskId, revision: 1 },
        { record_id: taskId, revision: 2 },
        { record_id: taskId, revision: 3 },
      ]),
      snapshotCount: { count: 4 },
    });

    await runCli(application.service, [
      "profile",
      "set-authority",
      "--profile",
      createdProfile.profile.id,
      "--project",
      project.id,
      "--mode",
      "proposal",
    ]);
    const staleInput: SubmitChangeSetInput = {
      projectId: project.id,
      baseProjectRevision: 3,
      idempotencyKey: "scenario-stale-proposal",
      rationale: "Apply only if the reviewed task base remains current.",
      sourceTaskId: taskId,
      predecessorProposalId: null,
      operations: [{
        operationId: "update-task-stale",
        type: "update_record",
        recordId: taskId,
        expectedRecordRevision: 3,
        patch: { title: "Stale proposal must not win" },
      }],
    };
    const staleSubmission = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      staleInput,
    );
    expect(staleSubmission).toMatchObject({
      outcome: "proposed",
      state: "pending",
      replayed: false,
    });
    if (staleSubmission.outcome !== "proposed") {
      throw new Error("Stale scenario setup did not create a pending proposal");
    }

    const humanUpdatedTask = await runCli<{
      id: string;
      title: string;
      body: string;
      revision: number;
    }>(application.service, [
      "record",
      "update",
      "--project",
      project.id,
      "--record",
      taskId,
      "--expected-revision",
      "3",
      "--body",
      "A human governed write advanced the project before review.",
    ]);
    expect(humanUpdatedTask).toMatchObject({
      id: taskId,
      title: "Governance workflow proven",
      revision: 4,
    });
    const staleAcceptance = await runCli<ProposalDecisionResult>(
      application.service,
      [
        "proposal",
        "accept",
        "--proposal",
        staleSubmission.proposalId,
      ],
    );
    expect(staleAcceptance).toEqual({
      outcome: "conflicted",
      changeId: staleSubmission.changeId,
      proposalId: staleSubmission.proposalId,
      currentProjectRevision: 4,
    });
    expect(
      await runCli(application.service, [
        "proposal",
        "show",
        "--proposal",
        staleSubmission.proposalId,
      ]),
    ).toMatchObject({
      state: "conflicted",
      operations: [{
        operationId: "update-task-stale",
        patch: { title: "Stale proposal must not win" },
      }],
    });
    expect(
      readDatabase(temporaryDatabase.path, (database) => ({
        project: database
          .prepare("SELECT revision FROM projects WHERE id = ?")
          .get(project.id),
        task: database
          .prepare(
            "SELECT title, body, revision FROM project_records WHERE id = ?",
          )
          .get(taskId),
      })),
    ).toEqual({
      project: { revision: 4 },
      task: {
        title: "Governance workflow proven",
        body: "A human governed write advanced the project before review.",
        revision: 4,
      },
    });

    await closeMcp(mcpSession);
    mcpSession = undefined;
    application.close();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now,
      newId,
    });
    mcpSession = await connectMcp(application.service, credentials);

    const profilesAfterRestart = await runCli<ClientProfileSummary[]>(
      application.service,
      ["profile", "list"],
    );
    expect(profilesAfterRestart).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({
          id: createdProfile.profile.id,
          status: "enabled",
        }),
        authorities: [
          expect.objectContaining({
            authority: expect.objectContaining({
              projectId: project.id,
              mode: "proposal",
            }),
            scopes: [
              expect.objectContaining({
                operationType: "update_record",
                recordKind: "task",
              }),
            ],
          }),
        ],
      }),
    ]);
    const proposalsAfterRestart = await runCli<ChangeProposalSummary[]>(
      application.service,
      ["proposal", "list", "--project", project.id],
    );
    expect(proposalsAfterRestart.map(({ state }) => state).sort()).toEqual([
      "accepted",
      "conflicted",
      "pending",
    ]);
    const auditAfterRestart = await runCli<AuditEvent[]>(
      application.service,
      ["audit", "list", "--project", project.id, "--limit", "500"],
    );
    expect(
      auditAfterRestart.map(({ actionCategory }) => actionCategory),
    ).toEqual(expect.arrayContaining([
      "project_created",
      "profile_created",
      "proposal_created",
      "proposal_accepted",
      "change_applied",
      "profile_authority_set",
      "profile_scope_added",
      "idempotent_replay",
      "proposal_conflicted",
    ]));
    const persistedReplay = await callTool<ChangeSubmissionResult>(
      mcpSession.client,
      "submit_change_set",
      initialTaskSubmission,
    );
    expect(persistedReplay).toMatchObject({
      outcome: "applied",
      changeId: accepted.changeId,
      projectRevision: 1,
      replayed: true,
      operations: [{
        operationId: "create-task",
        type: "create_record",
        record: { id: taskId, revision: 1 },
      }],
    });
    expect(
      (
        await runCli<ProjectSummary>(application.service, [
          "project",
          "summary",
          "--project",
          project.id,
        ])
      ).project.revision,
    ).toBe(4);
    const myChanges = await callTool<{ changes: object[] }>(
      mcpSession.client,
      "list_my_changes",
      { projectId: project.id },
    );
    const acceptedChange = await callTool<{ change: object }>(
      mcpSession.client,
      "get_my_change",
      { changeId: accepted.changeId },
    );
    expect(myChanges.changes).toHaveLength(5);
    expect(acceptedChange).toMatchObject({
      change: {
        changeId: accepted.changeId,
        outcome: "applied",
        state: "accepted",
        result: {
          outcome: "applied",
          proposalId: accepted.proposalId,
          projectRevision: 1,
        },
        proposal: { state: "accepted" },
      },
    });

    const persistedJson = readDatabase(
      temporaryDatabase.path,
      (database) => ({
        resultJson: database
          .prepare(
            "SELECT result_json FROM idempotency_results ORDER BY profile_id, project_id, idempotency_key",
          )
          .all(),
        auditRows: database
          .prepare(
            `SELECT project_id, actor_type, profile_id, authority_mode,
                    scope_decision, action_category, target_id, idempotency_key,
                    revision_before, revision_after, outcome, reason, created_at
             FROM audit_events ORDER BY rowid`,
          )
          .all(),
      }),
    );
    const publicReadJson = JSON.stringify({
      profilesAfterRestart,
      proposalsAfterRestart,
      auditAfterRestart,
      persistedReplay,
      myChanges,
      acceptedChange,
    });
    expect(JSON.stringify(persistedJson.resultJson)).not.toContain(
      createdProfile.token,
    );
    expect(JSON.stringify(persistedJson.auditRows)).not.toContain(
      createdProfile.token,
    );
    expect(publicReadJson).not.toContain(createdProfile.token);
    expect(
      readAllPersistedText(temporaryDatabase.path).filter(({ value }) =>
        value.includes(createdProfile.token),
      ),
    ).toEqual([]);

    await runCli(application.service, [
      "profile",
      "disable",
      "--profile",
      createdProfile.profile.id,
    ]);
    await closeMcp(mcpSession);
    mcpSession = undefined;
    application.close();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now,
      newId,
    });

    let disabledAuthenticationError: unknown;
    try {
      application.service.profiles.authenticate(credentials);
    } catch (error) {
      disabledAuthenticationError = error;
    }
    expect(disabledAuthenticationError).toBeInstanceOf(GovernanceError);
    expect(disabledAuthenticationError).toMatchObject({
      code: "profile_disabled",
    });
    expect(String(disabledAuthenticationError)).not.toContain(createdProfile.token);
    if (disabledAuthenticationError instanceof Error) {
      expect(disabledAuthenticationError.message).not.toContain(
        createdProfile.token,
      );
    }

    let disabledStartupDiagnostics = "";
    let disabledStartupExitCode: number | undefined;
    await runIntentArcMcp({
      environment: {
        INTENTARC_DB_PATH: temporaryDatabase.path,
        INTENTARC_PROFILE_ID: createdProfile.profile.id,
        INTENTARC_PROFILE_TOKEN: createdProfile.token,
      },
      stderr: {
        write(message) {
          disabledStartupDiagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode(code) {
        disabledStartupExitCode = code;
      },
    });
    expect(disabledStartupExitCode).toBe(1);
    expect(disabledStartupDiagnostics).toBe("profile_disabled\n");
    expect(disabledStartupDiagnostics).not.toContain(createdProfile.token);

    mcpSession = await connectMcp(application.service, null);
    const anonymousTools = await mcpSession.client.listTools();
    expect(anonymousTools.tools.map(({ name }) => name)).toEqual([
      "list_projects",
      "get_project_summary",
    ]);
    expect(
      await callTool<{ projects: Project[] }>(
        mcpSession.client,
        "list_projects",
        {},
      ),
    ).toMatchObject({
      projects: [{ id: project.id, revision: 4 }],
    });
    expect(
      await callTool<ProjectSummary>(
        mcpSession.client,
        "get_project_summary",
        { projectId: project.id },
      ),
    ).toMatchObject({
      project: { id: project.id, revision: 4 },
      recordsByKind: { task: 1, decision: 1 },
    });
  });
});
