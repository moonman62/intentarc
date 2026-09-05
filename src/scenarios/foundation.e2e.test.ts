import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
  type IntentArcIdPrefix,
} from "../app/create-application.js";
import { createProgram } from "../cli/program.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import {
  getReleasedContextResultSchema,
  requestTaskContextResultSchema,
  type AuthenticatedProfile,
  type Project,
  type ProjectRecord,
  type TaskContextPack,
} from "../domain/index.js";
import { createIntentArcMcpServer } from "../mcp/server.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

type CapturedOutput = {
  readonly write: (chunk: string) => boolean;
  text(): string;
};

const captureOutput = (): CapturedOutput => {
  let output = "";

  return {
    write: (chunk) => {
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

const requestTaskContext = async (
  service: IntentArcService,
  principal: AuthenticatedProfile,
  projectId: string,
  taskId: string,
  budgetTokens: number,
  idempotencyKey: string,
): Promise<TaskContextPack> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createIntentArcMcpServer(service, principal);
  const client = new Client({
    name: "intentarc-foundation-scenario",
    version: "1.0.0",
  });

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const requested = await client.callTool({
      name: "request_task_context",
      arguments: {
        projectId,
        taskId,
        budgetTokens,
        idempotencyKey,
      },
    });

    expect(requested.isError).not.toBe(true);
    const review = requestTaskContextResultSchema.parse(
      requested.structuredContent,
    );
    expect(review.status).toBe("review_required");
    service.outbound.approve({
      requestId: review.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });
    const retrieved = await client.callTool({
      name: "get_released_context",
      arguments: { requestId: review.requestId },
    });
    expect(retrieved.isError, JSON.stringify(retrieved)).not.toBe(true);
    const released = getReleasedContextResultSchema.parse(
      retrieved.structuredContent,
    );
    if (released.status !== "released") {
      throw new Error("Expected released context");
    }
    return released.release.pack;
  } finally {
    await client.close();
    await server.close();
    await clientTransport.close();
    await serverTransport.close();
  }
};

const createLiteralIdFactory = (
  configuredIds: Partial<Record<IntentArcIdPrefix, string[]>>,
): ((prefix: IntentArcIdPrefix) => string) => {
  const remainingIds = Object.fromEntries(
    Object.entries(configuredIds).map(([prefix, ids]) => [prefix, [...ids]]),
  ) as Partial<Record<IntentArcIdPrefix, string[]>>;

  return (prefix) => {
    const id = remainingIds[prefix]?.shift();

    if (!id) {
      throw new Error(`No scenario ID configured for ${prefix}`);
    }

    return id;
  };
};

const withoutPackIdentity = ({
  id: _id,
  generatedAt: _generatedAt,
  ...pack
}: TaskContextPack): Omit<TaskContextPack, "id" | "generatedAt"> => pack;

describe("IntentArc foundation vertical slice", () => {
  let application: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    application?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("preserves CLI-authored project context across MCP reads and application restart", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-26T10:00:00.000Z",
      newId: createLiteralIdFactory({
        project: ["project-foundation"],
        record: [
          "record-01-vision",
          "record-02-outcome",
          "record-03-constraint",
          "record-04-non-goal",
          "record-05-task",
          "record-06-decision",
          "record-07-unrelated-idea",
        ],
        relationship: ["relationship-task-decision"],
        context: ["context-before-reopen"],
        profile: ["profile-foundation"],
        destination: ["destination-foundation"],
        "outbound-request": ["outbound-request-before-reopen"],
        "outbound-release": ["outbound-release-before-reopen"],
        change: [
          "change-record-01",
          "change-record-02",
          "change-record-03",
          "change-record-04",
          "change-record-05",
          "change-record-06",
          "change-record-07",
          "change-relationship-01",
        ],
        audit: [
          "audit-project",
          "audit-record-01",
          "audit-record-02",
          "audit-record-03",
          "audit-record-04",
          "audit-record-05",
          "audit-record-06",
          "audit-record-07",
          "audit-relationship-01",
          "audit-profile",
          "audit-destination",
          "audit-outbound-request-before-reopen",
          "audit-outbound-scan-before-reopen",
          "audit-outbound-approval-before-reopen",
          "audit-outbound-retrieval-before-reopen",
        ],
      }),
    });

    const project = await runCli<Project>(application.service, [
      "project",
      "create",
      "--name",
      "IntentArc foundation",
      "--repo",
      "C:/projects/intentarc",
    ]);
    expect(project).toEqual({
      id: "project-foundation",
      name: "IntentArc foundation",
      revision: 0,
      primaryRepositoryPath: "C:/projects/intentarc",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T10:00:00.000Z",
    });

    const recordInputs = [
      [
        "vision",
        "accepted",
        "Preserve project intent",
        "Keep durable project knowledge across AI clients.",
      ],
      [
        "outcome",
        "accepted",
        "Focused task context",
        "Give each task bounded authoritative context.",
      ],
      [
        "constraint",
        "accepted",
        "Local authority",
        "Keep the SQLite project core authoritative.",
      ],
      [
        "non_goal",
        "accepted",
        "No provider execution",
        "Do not call model-provider APIs.",
      ],
      [
        "task",
        "active",
        "Prove the foundation",
        "Exercise the CLI-to-MCP workflow through SQLite.",
      ],
      [
        "decision",
        "accepted",
        "Use explicit links",
        "Relate task context through stored relationships.",
      ],
      [
        "idea",
        "accepted",
        "Add a dashboard",
        "Explore a visual interface outside this foundation slice.",
      ],
    ] as const;
    const records: ProjectRecord[] = [];

    for (const [kind, status, title, body] of recordInputs) {
      records.push(
        await runCli<ProjectRecord>(application.service, [
          "record",
          "add",
          "--project",
          "project-foundation",
          "--kind",
          kind!,
          "--status",
          status!,
          "--title",
          title!,
          "--body",
          body!,
          "--source-kind",
          "human",
          "--source-ref",
          "foundation-scenario",
        ]),
      );
    }

    expect(records.map(({ id }) => id)).toEqual([
      "record-01-vision",
      "record-02-outcome",
      "record-03-constraint",
      "record-04-non-goal",
      "record-05-task",
      "record-06-decision",
      "record-07-unrelated-idea",
    ]);

    await runCli(application.service, [
      "record",
      "link",
      "--project",
      "project-foundation",
      "--from",
      "record-05-task",
      "--to",
      "record-06-decision",
      "--kind",
      "decided_by",
      "--expected-revision",
      "7",
    ]);

    const profile = application.service.profiles.createProfile({
      name: "Foundation MCP profile",
    });
    const credentials = {
      profileId: profile.profile.id,
      token: profile.token,
    };
    const principal = application.service.profiles.authenticate(credentials)!;
    application.service.destinations.set({
      profileId: principal.id,
      clientLabel: "Foundation desktop",
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "Synthetic account",
      dataBoundary: "remote",
    });
    const beforeReopen = await requestTaskContext(
      application.service,
      principal,
      "project-foundation",
      "record-05-task",
      1_000,
      "foundation-before-reopen",
    );

    expect(beforeReopen.id).toBe("context-before-reopen");
    expect(beforeReopen.generatedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(
      beforeReopen.stableFrame.map(({ record }) => ({
        id: record.id,
        kind: record.kind,
      })),
    ).toEqual([
      { id: "record-01-vision", kind: "vision" },
      { id: "record-02-outcome", kind: "outcome" },
      { id: "record-03-constraint", kind: "constraint" },
      { id: "record-04-non-goal", kind: "non_goal" },
    ]);
    expect(beforeReopen.task.record.id).toBe("record-05-task");
    expect(
      beforeReopen.related.map(({ record, relationshipKind }) => ({
        id: record.id,
        relationshipKind,
      })),
    ).toEqual([
      {
        id: "record-06-decision",
        relationshipKind: "decided_by",
      },
    ]);
    expect(
      [
        ...beforeReopen.stableFrame,
        beforeReopen.task,
        ...beforeReopen.related,
      ].map(({ record }) => record.id),
    ).not.toContain("record-07-unrelated-idea");
    expect(beforeReopen.sourceRevisions).toEqual([
      { recordId: "record-01-vision", revision: 1 },
      { recordId: "record-02-outcome", revision: 1 },
      { recordId: "record-03-constraint", revision: 1 },
      { recordId: "record-04-non-goal", revision: 1 },
      { recordId: "record-05-task", revision: 1 },
      { recordId: "record-06-decision", revision: 1 },
    ]);
    expect(beforeReopen.omissions).toEqual([]);

    application.close();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-26T11:00:00.000Z",
      newId: createLiteralIdFactory({
        context: ["context-after-reopen"],
        "outbound-request": ["outbound-request-after-reopen"],
        "outbound-release": ["outbound-release-after-reopen"],
        audit: [
          "audit-outbound-request-after-reopen",
          "audit-outbound-scan-after-reopen",
          "audit-outbound-approval-after-reopen",
          "audit-outbound-retrieval-after-reopen",
        ],
      }),
    });

    const afterReopen = await requestTaskContext(
      application.service,
      application.service.profiles.authenticate(credentials)!,
      "project-foundation",
      "record-05-task",
      1_000,
      "foundation-after-reopen",
    );

    expect(afterReopen.id).toBe("context-after-reopen");
    expect(afterReopen.generatedAt).toBe("2026-07-26T11:00:00.000Z");
    expect(afterReopen.id).not.toBe(beforeReopen.id);
    expect(afterReopen.generatedAt).not.toBe(beforeReopen.generatedAt);
    expect(withoutPackIdentity(afterReopen)).toEqual(
      withoutPackIdentity(beforeReopen),
    );
    expect(afterReopen.sourceRevisions).toEqual([
      { recordId: "record-01-vision", revision: 1 },
      { recordId: "record-02-outcome", revision: 1 },
      { recordId: "record-03-constraint", revision: 1 },
      { recordId: "record-04-non-goal", revision: 1 },
      { recordId: "record-05-task", revision: 1 },
      { recordId: "record-06-decision", revision: 1 },
    ]);
    expect(afterReopen.omissions).toEqual([]);
  });
});
