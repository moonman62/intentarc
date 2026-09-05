import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getReleasedContextResultSchema,
  requestTaskContextResultSchema,
  type OutboundInspection,
  type OutboundRelease,
} from "../domain/index.js";
import { migrations } from "../storage/migrations.js";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { ensurePackagedTestBuild } from "../test-support/packaged-test-build.js";

type ProcessResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type CreatedProfile = {
  readonly profile: { readonly id: string };
  readonly token: string;
};

type BackupSummary = {
  readonly manifest: {
    readonly reason: string;
    readonly schemaVersion: number;
    readonly storeId: string;
  };
  readonly bundlePath: string;
  readonly verificationStatus: string;
};

type McpChild = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
let cliExecutable: string;
let mcpExecutable: string;
const fixtureTimestamp = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;
const projectId = "project-outbound-scenario";
const taskId = "task-outbound-scenario";
const storeId = "store-outbound-schema-3";
const cleanTaskTitle = "Package the outbound safety proof";
const cleanTaskBody = "Prove the local release workflow with synthetic fixtures.";
const forcedValue = "synthetic-value-123456789";
const possibleValue = "owner@example.invalid";
const sensitiveTaskBody =
  `Use api_key=${forcedValue} for the synthetic fixture owned by ${possibleValue}`;
const sourceReference = "synthetic://provenance/outbound-context-canary";
const destinationEmail = "packaged-routing@example.invalid";
const destinationToken =
  "sk-proj-SyntheticPackagedDestinationToken0123456789";

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const runProcess = (
  command: string,
  arguments_: readonly string[],
  environment: Record<string, string> = inheritedEnvironment(),
): Promise<ProcessResult> =>
  new Promise((resolveProcess, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({ code, stdout, stderr });
    });
    child.stdin.end();
  });

const runCli = (
  databasePath: string,
  arguments_: readonly string[],
): Promise<ProcessResult> =>
  runProcess(process.execPath, [
    cliExecutable,
    "--db",
    databasePath,
    ...arguments_,
  ]);

const successfulJson = async <Result>(
  operation: Promise<ProcessResult>,
): Promise<Result> => {
  const result = await operation;
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as Result;
};

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const expectContentFree = (
  value: unknown,
  canaries: ReadonlySet<string>,
): void => {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
  }
};

const createSchemaThreeFixture = (databasePath: string): void => {
  const database = createVersionedDatabaseFixture(databasePath, 2);
  const task = {
    id: taskId,
    projectId,
    kind: "task",
    status: "active",
    title: cleanTaskTitle,
    body: cleanTaskBody,
    sourceKind: "human",
    sourceRef: sourceReference,
    revision: 1,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
  };

  try {
    database.transaction(() => {
      database.exec(migrations.find(({ version }) => version === 3)!.sql);
      database.prepare(`
        INSERT INTO store_metadata (singleton, store_id, created_at)
        VALUES (1, ?, ?)
      `).run(storeId, fixtureTimestamp);
      database.prepare(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        "Outbound safety scenario",
        1,
        null,
        fixtureTimestamp,
        fixtureTimestamp,
      );
      database.prepare(`
        INSERT INTO project_records (
          id, project_id, kind, status, title, body, source_kind,
          source_ref, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.projectId,
        task.kind,
        task.status,
        task.title,
        task.body,
        task.sourceKind,
        task.sourceRef,
        task.revision,
        task.createdAt,
        task.updatedAt,
      );
      database.prepare(`
        INSERT INTO project_record_revisions (
          record_id, revision, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(task.id, task.revision, JSON.stringify(task), fixtureTimestamp);
      database.pragma("user_version = 3");
    })();
  } finally {
    database.close();
  }
};

const readDatabase = <Result>(
  databasePath: string,
  operation: (database: Database.Database) => Result,
): Result => {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
};

const openMcpChild = async (
  databasePath: string,
  credentials?: CreatedProfile,
): Promise<McpChild> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpExecutable],
    cwd: repositoryRoot,
    env: {
      ...inheritedEnvironment(),
      INTENTARC_DB_PATH: databasePath,
      ...(credentials === undefined
        ? {}
        : {
          INTENTARC_PROFILE_ID: credentials.profile.id,
          INTENTARC_PROFILE_TOKEN: credentials.token,
        }),
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "intentarc-outbound-safety-scenario",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
};

const closeMcpChild = async (
  child: McpChild | undefined,
): Promise<void> => {
  if (!child) return;
  await Promise.allSettled([
    child.client.close(),
    child.transport.close(),
  ]);
};

describe("packaged outbound context safety", () => {
  const temporaries: TemporaryDatabase[] = [];
  let mcpChild: McpChild | undefined;

  beforeAll(async () => {
    const build = await ensurePackagedTestBuild(repositoryRoot);
    cliExecutable = resolve(build.outputDirectory, "cli/bin.js");
    mcpExecutable = resolve(build.outputDirectory, "mcp/bin.js");
  }, 30_000);

  afterEach(async () => {
    await closeMcpChild(mcpChild);
    mcpChild = undefined;
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const candidate = createTemporaryDatabase();
    temporaries.push(candidate);
    return candidate;
  };

  it("migrates, reviews, releases, redacts, invalidates, and audits only through packaged boundaries", async () => {
    const candidate = temporary();
    createSchemaThreeFixture(candidate.path);
    expect(
      readDatabase(candidate.path, (database) =>
        database.pragma("user_version", { simple: true })),
    ).toBe(3);

    const credentials = await successfulJson<CreatedProfile>(
      runCli(candidate.path, [
        "profile",
        "create",
        "--name",
        "Synthetic packaged client",
        "--project",
        projectId,
      ]),
    );
    const contextCanaries = new Set([
      cleanTaskTitle,
      cleanTaskBody,
      sensitiveTaskBody,
      forcedValue,
      possibleValue,
      sourceReference,
      destinationEmail,
      destinationToken,
      credentials.token,
    ]);
    expect(
      readDatabase(candidate.path, (database) =>
        database.pragma("user_version", { simple: true })),
    ).toBe(currentSchemaVersion);

    const automaticBackups = await successfulJson<BackupSummary[]>(
      runCli(candidate.path, ["backup", "list"]),
    );
    expect(automaticBackups).toHaveLength(1);
    expect(automaticBackups[0]).toMatchObject({
      manifest: {
        reason: "pre-migration",
        schemaVersion: 3,
        storeId,
      },
      verificationStatus: "not_checked",
    });
    const preMigrationSnapshotPath = join(
      automaticBackups[0]!.bundlePath,
      "database.sqlite",
    );
    const preMigrationDigest = sha256(preMigrationSnapshotPath);
    expect(
      await successfulJson<{
        verificationStatus: string;
        integrity: { passed: boolean; schemaVersion: number };
      }>(
        runProcess(process.execPath, [
          cliExecutable,
          "backup",
          "verify",
          "--backup",
          automaticBackups[0]!.bundlePath,
        ]),
      ),
    ).toMatchObject({
      verificationStatus: "verified",
      integrity: { passed: true, schemaVersion: 3 },
    });

    const destination = await successfulJson<{
      id: string;
      revision: number;
    }>(
      runCli(candidate.path, [
        "profile",
        "destination",
        "set",
        "--profile",
        credentials.profile.id,
        "--client-label",
        "Synthetic Codex desktop",
        "--type",
        "ide_managed",
        "--provider",
        "Synthetic provider",
        "--model",
        "Synthetic model",
        "--account-boundary",
        "Synthetic account",
        "--data-boundary",
        "remote",
      ]),
    );
    expect(destination.revision).toBe(1);

    mcpChild = await openMcpChild(candidate.path);
    expect(
      (await mcpChild.client.listTools()).tools.map(({ name }) => name),
    ).toEqual(["list_projects", "get_project_summary"]);
    await closeMcpChild(mcpChild);
    mcpChild = await openMcpChild(candidate.path, credentials);

    const firstRequest = await mcpChild.client.callTool({
      name: "request_task_context",
      arguments: {
        projectId,
        taskId,
        budgetTokens: 4000,
        idempotencyKey: "packaged-clean-first",
      },
    });
    expect(firstRequest.isError).not.toBe(true);
    const firstSummary = requestTaskContextResultSchema.parse(
      firstRequest.structuredContent,
    );
    expect(firstSummary).toMatchObject({
      status: "review_required",
      findingCounts: { total: 0 },
    });
    expectContentFree(firstRequest, contextCanaries);

    const pendingRetrieval = await mcpChild.client.callTool({
      name: "get_released_context",
      arguments: { requestId: firstSummary.requestId },
    });
    expect(pendingRetrieval.isError).not.toBe(true);
    const pendingState = getReleasedContextResultSchema.parse(
      pendingRetrieval.structuredContent,
    );
    expect(pendingState).toMatchObject({
      status: "review_required",
    });
    expectContentFree(pendingRetrieval, contextCanaries);

    const cleanInspection = await successfulJson<OutboundInspection>(
      runCli(candidate.path, [
        "context",
        "outbound",
        "inspect",
        "--request",
        firstSummary.requestId,
      ]),
    );
    expect(cleanInspection).toMatchObject({
      request: {
        requestId: firstSummary.requestId,
        destination: { revision: 1 },
      },
      findings: [],
      redactedPreview: {
        task: { record: { title: cleanTaskTitle, body: cleanTaskBody } },
      },
    });

    const firstApproved = await successfulJson<OutboundRelease>(
      runCli(candidate.path, [
        "context",
        "outbound",
        "approve",
        "--request",
        firstSummary.requestId,
        "--remember-clean",
      ]),
    );
    expect(firstApproved).toMatchObject({
      requestId: firstSummary.requestId,
      sourcePackId: firstSummary.sourcePackId,
      disclosure: {
        destination: { revision: 1 },
        findingCounts: { total: 0, includedOnce: 0 },
      },
      pack: {
        id: firstSummary.sourcePackId,
        task: { record: { title: cleanTaskTitle, body: cleanTaskBody } },
      },
    });

    const firstReleased = await mcpChild.client.callTool({
      name: "get_released_context",
      arguments: { requestId: firstSummary.requestId },
    });
    expect(firstReleased.structuredContent).toEqual({
      status: "released",
      release: firstApproved,
    });

    const automaticRequest = await mcpChild.client.callTool({
      name: "request_task_context",
      arguments: {
        projectId,
        taskId,
        budgetTokens: 4000,
        idempotencyKey: "packaged-clean-automatic",
      },
    });
    expect(automaticRequest.isError).not.toBe(true);
    const automaticSummary = requestTaskContextResultSchema.parse(
      automaticRequest.structuredContent,
    );
    expect(automaticSummary).toMatchObject({
      status: "released",
      destination: { id: destination.id, revision: 1 },
      findingCounts: { total: 0 },
      releaseId: expect.any(String),
    });
    expectContentFree(automaticRequest, contextCanaries);

    await successfulJson(
      runCli(candidate.path, [
        "record",
        "update",
        "--project",
        projectId,
        "--record",
        taskId,
        "--expected-revision",
        "1",
        "--body",
        sensitiveTaskBody,
      ]),
    );

    const findingRequestResult = await mcpChild.client.callTool({
      name: "request_task_context",
      arguments: {
        projectId,
        taskId,
        budgetTokens: 4000,
        idempotencyKey: "packaged-findings",
      },
    });
    expect(findingRequestResult.isError).not.toBe(true);
    const findingRequest = requestTaskContextResultSchema.parse(
      findingRequestResult.structuredContent,
    );
    expect(findingRequest).toMatchObject({
      status: "review_required",
      findingCounts: {
        total: 2,
        forcedRedact: 1,
        redactByDefault: 1,
      },
    });
    expectContentFree(findingRequestResult, contextCanaries);

    const maskedInspectionResult = await runCli(candidate.path, [
      "context",
      "outbound",
      "inspect",
      "--request",
      findingRequest.requestId,
    ]);
    expect(maskedInspectionResult).toMatchObject({ code: 0, stderr: "" });
    expect(maskedInspectionResult.stdout).not.toContain(forcedValue);
    expect(maskedInspectionResult.stdout).not.toContain(possibleValue);
    const maskedInspection =
      JSON.parse(maskedInspectionResult.stdout) as OutboundInspection;
    expect(maskedInspection.redactedPreview.task.record.body).toBe(
      "Use api_key=[REDACTED:HIGH_ENTROPY:1] for the synthetic fixture owned by [REDACTED:EMAIL:2]",
    );
    const forcedFinding = maskedInspection.findings.find(
      ({ requiredAction }) => requiredAction === "forced_redact",
    );
    const possibleFinding = maskedInspection.findings.find(
      ({ category }) => category === "email",
    );
    expect(forcedFinding).toBeDefined();
    expect(possibleFinding).toBeDefined();

    const rejectedForcedInclusion = await runCli(candidate.path, [
      "context",
      "outbound",
      "approve",
      "--request",
      findingRequest.requestId,
      "--include-finding",
      forcedFinding!.id,
    ]);
    expect(rejectedForcedInclusion.code).toBe(1);
    expect(rejectedForcedInclusion.stdout).toBe("");
    expect(rejectedForcedInclusion.stderr).toContain("outbound_safety_failed");
    expectContentFree(rejectedForcedInclusion, contextCanaries);

    const rawPackBeforeApproval = readDatabase(
      candidate.path,
      (database) =>
        (
          database.prepare(
            "SELECT content_json FROM context_packs WHERE id = ?",
          ).get(findingRequest.sourcePackId) as { content_json: string }
        ).content_json,
    );
    expect(rawPackBeforeApproval).toContain(forcedValue);
    expect(rawPackBeforeApproval).toContain(possibleValue);

    const findingsApproved = await successfulJson<OutboundRelease>(
      runCli(candidate.path, [
        "context",
        "outbound",
        "approve",
        "--request",
        findingRequest.requestId,
        "--include-finding",
        possibleFinding!.id,
      ]),
    );
    expect(findingsApproved.disclosure.findingCounts).toMatchObject({
      total: 2,
      forcedRedact: 1,
      redacted: 1,
      includedOnce: 1,
    });
    expect(findingsApproved.pack.task.record.body).toContain(possibleValue);
    expect(findingsApproved.pack.task.record.body).not.toContain(forcedValue);
    expect(findingsApproved.pack.task.record.body).toContain(
      "[REDACTED:HIGH_ENTROPY:1]",
    );
    expect(
      readDatabase(
        candidate.path,
        (database) =>
          (
            database.prepare(
              "SELECT content_json FROM context_packs WHERE id = ?",
            ).get(findingRequest.sourcePackId) as { content_json: string }
          ).content_json,
      ),
    ).toBe(rawPackBeforeApproval);

    const findingsReleased = await mcpChild.client.callTool({
      name: "get_released_context",
      arguments: { requestId: findingRequest.requestId },
    });
    expect(findingsReleased.structuredContent).toEqual({
      status: "released",
      release: findingsApproved,
    });

    const revisedDestination = await successfulJson<{ revision: number }>(
      runCli(candidate.path, [
        "profile",
        "destination",
        "set",
        "--profile",
        credentials.profile.id,
        "--client-label",
        destinationEmail,
        "--type",
        "ide_managed",
        "--provider",
        "Synthetic provider",
        "--model",
        "Synthetic model",
        "--account-boundary",
        destinationToken,
        "--data-boundary",
        "remote",
      ]),
    );
    expect(revisedDestination.revision).toBe(2);

    const staleRetrieval = await mcpChild.client.callTool({
      name: "get_released_context",
      arguments: { requestId: firstSummary.requestId },
    });
    expect(staleRetrieval.isError).toBe(true);
    expect(staleRetrieval.content).toEqual([
      { type: "text", text: "outbound_destination_changed" },
    ]);
    expect(staleRetrieval.structuredContent).toBeUndefined();
    expectContentFree(staleRetrieval, contextCanaries);

    await successfulJson(
      runCli(candidate.path, [
        "record",
        "update",
        "--project",
        projectId,
        "--record",
        taskId,
        "--expected-revision",
        "2",
        "--body",
        cleanTaskBody,
      ]),
    );
    const revisedDestinationRequest = await mcpChild.client.callTool({
      name: "request_task_context",
      arguments: {
        projectId,
        taskId,
        budgetTokens: 4000,
        idempotencyKey: "packaged-clean-revised-destination",
      },
    });
    expect(revisedDestinationRequest.isError).not.toBe(true);
    const revisedDestinationSummary = requestTaskContextResultSchema.parse(
      revisedDestinationRequest.structuredContent,
    );
    expect(revisedDestinationSummary).toMatchObject({
      status: "review_required",
      destination: { revision: 2 },
      findingCounts: {
        total: 2,
        forcedRedact: 2,
      },
    });
    expectContentFree(revisedDestinationRequest, contextCanaries);

    const revisedPending = await mcpChild.client.callTool({
      name: "get_released_context",
      arguments: { requestId: revisedDestinationSummary.requestId },
    });
    expect(revisedPending.isError).not.toBe(true);
    expect(revisedPending.structuredContent).toMatchObject({
      status: "review_required",
      request: {
        destination: {
          clientLabel: "[REDACTED:DESTINATION]",
          accountBoundaryLabel: "[REDACTED:DESTINATION]",
        },
      },
    });
    expectContentFree(revisedPending, contextCanaries);

    const revisedInspection = await successfulJson<OutboundInspection>(
      runCli(candidate.path, [
        "context",
        "outbound",
        "inspect",
        "--request",
        revisedDestinationSummary.requestId,
      ]),
    );
    expect(revisedInspection.request.destination).toMatchObject({
      clientLabel: "[REDACTED:DESTINATION]",
      accountBoundaryLabel: "[REDACTED:DESTINATION]",
    });
    expect(
      revisedInspection.findings.map(({ path }) => path),
    ).toEqual([
      "/destination/accountBoundaryLabel",
      "/destination/clientLabel",
    ]);
    expectContentFree(revisedInspection.request, contextCanaries);

    const redirectedReveal = await runCli(candidate.path, [
      "context",
      "outbound",
      "reveal",
      "--request",
      revisedDestinationSummary.requestId,
      "--finding",
      revisedInspection.findings[0]!.id,
    ]);
    expect(redirectedReveal).toMatchObject({ code: 1, stdout: "" });
    expect(redirectedReveal.stderr).toContain(
      "outbound_reveal_requires_tty",
    );
    expectContentFree(redirectedReveal, contextCanaries);

    const revisedRelease = await successfulJson<OutboundRelease>(
      runCli(candidate.path, [
        "context",
        "outbound",
        "approve",
        "--request",
        revisedDestinationSummary.requestId,
      ]),
    );
    expect(revisedRelease.disclosure.destination).toMatchObject({
      clientLabel: "[REDACTED:DESTINATION]",
      accountBoundaryLabel: "[REDACTED:DESTINATION]",
    });
    expectContentFree(
      revisedRelease,
      new Set([destinationEmail, destinationToken]),
    );
    expect(
      readDatabase(candidate.path, (database) =>
        database.prepare(`
          SELECT client_label, account_boundary_label
          FROM outbound_destinations
          WHERE revision = 2
        `).get()),
    ).toEqual({
      client_label: destinationEmail,
      account_boundary_label: destinationToken,
    });

    const auditRows = readDatabase(candidate.path, (database) =>
      database.prepare("SELECT * FROM audit_events ORDER BY rowid").all());
    expectContentFree(auditRows, contextCanaries);
    expect(
      auditRows.map(
        (row) => (row as { action_category: string }).action_category,
      ),
    ).toEqual(expect.arrayContaining([
      "outbound_destination_set",
      "outbound_request_created",
      "outbound_scan_completed",
      "outbound_request_approved",
      "outbound_release_retrieved",
      "outbound_policy_enabled",
    ]));
    expect(
      auditRows.filter(
        (row) =>
          (row as { action_category: string }).action_category ===
            "outbound_scan_completed",
      ),
    ).toHaveLength(4);
    expect(
      auditRows.filter(
        (row) =>
          (row as { action_category: string }).action_category ===
            "outbound_policy_enabled",
      ),
    ).toHaveLength(1);

    expect(
      await successfulJson<{
        passed: boolean;
        schemaVersion: number;
        issues: unknown[];
      }>(runCli(candidate.path, ["integrity", "check"])),
    ).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      issues: [],
    });

    expect(sha256(preMigrationSnapshotPath)).toBe(preMigrationDigest);
  }, 30_000);
});
