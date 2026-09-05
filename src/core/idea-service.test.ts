import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { GovernanceError, RecordNotFoundError } from "../domain/index.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { createProjectStore } from "../storage/project-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  createIdeaService,
  IdeaContextInvalidError,
  IdeaServiceUnavailableError,
  MAX_IDEA_CODE_POINTS,
  normalizeIdeaText,
  previewIdeaBody,
} from "./idea-service.js";

const timestamp = "2026-08-08T12:00:00.000Z";

let database: IntentArcDatabase | undefined;
let temporaryDatabase: TemporaryDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDatabase) {
    removeTemporaryDatabase(temporaryDatabase);
    temporaryDatabase = undefined;
  }
});

const createHarness = (options: { repeatedRelationshipId?: boolean } = {}) => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path, { now: () => timestamp });
  let projectSequence = 0;
  let governanceSequence = 0;
  const projectStore = createProjectStore(database, {
    now: () => timestamp,
    newId: (prefix) => `${prefix}-project-${projectSequence += 1}`,
  });
  const governanceStore = createGovernanceStore(database, {
    newId: (prefix) => {
      if (prefix === "relationship" && options.repeatedRelationshipId) {
        return "relationship-duplicate";
      }
      return `${prefix}-governance-${governanceSequence += 1}`;
    },
  });

  return {
    projectStore,
    governanceStore,
    service: createIdeaService({
      projectStore,
      governanceStore,
      now: () => timestamp,
    }),
  };
};

const createInboxHarness = () => {
  temporaryDatabase = createTemporaryDatabase();
  let currentTimestamp = "2026-08-08T09:00:00.000Z";
  database = openDatabase(temporaryDatabase.path, { now: () => currentTimestamp });
  let projectSequence = 0;
  let governanceSequence = 0;
  let recordSequence = 0;
  const recordIds = [
    "record-context-task",
    "record-context-component",
    "record-idea-old",
    "record-idea-a",
    "record-idea-z",
    "record-not-an-idea",
    "record-foreign-task",
    "record-foreign-idea",
  ];
  const projectStore = createProjectStore(database, {
    now: () => currentTimestamp,
    newId: (prefix) => {
      if (prefix === "record") {
        const id = recordIds[recordSequence] ?? `record-inbox-${recordSequence + 1}`;
        recordSequence += 1;
        return id;
      }
      return `${prefix}-inbox-${projectSequence += 1}`;
    },
  });
  const governanceStore = createGovernanceStore(database, {
    newId: (prefix) => `${prefix}-inbox-${governanceSequence += 1}`,
  });

  return {
    projectStore,
    governanceStore,
    at(value: string) {
      currentTimestamp = value;
    },
  };
};

const ideaState = (
  projectStore: ReturnType<typeof createProjectStore>,
  governanceStore: ReturnType<typeof createGovernanceStore>,
  projectId: string,
) => ({
  revision: projectStore.getProject(projectId)!.revision,
  ideaCount: projectStore.listRecords(projectId).filter(({ kind }) => kind === "idea").length,
  relationshipCount: projectStore.listRelationships(projectId).length,
  auditCount: governanceStore.listAuditEvents({ projectId, limit: 100 }).length,
});

describe("IdeaService text contract", () => {
  it("normalizes line endings and derives the first non-empty line", () => {
    expect(normalizeIdeaText("  \r\n  Keep manual refresh\rDetails stay reviewed.  "))
      .toEqual({
        title: "Keep manual refresh",
        body: "Keep manual refresh\nDetails stay reviewed.",
      });
  });

  it("truncates a title by Unicode code point without shortening the body", () => {
    const line = "💡".repeat(161);
    const normalized = normalizeIdeaText(`${line}\nFull detail`);
    expect(Array.from(normalized.title)).toHaveLength(160);
    expect(normalized.title.endsWith("…")).toBe(true);
    expect(normalized.body).toBe(`${line}\nFull detail`);
  });

  it.each(["", " \r\n ", "x".repeat(MAX_IDEA_CODE_POINTS + 1)])(
    "rejects invalid idea text %#",
    (text) => expect(() => normalizeIdeaText(text)).toThrow(),
  );

  it("creates a bounded body preview without splitting a Unicode code point", () => {
    const body = "a".repeat(279) + "💡tail";
    expect(Array.from(previewIdeaBody(body))).toHaveLength(280);
    expect(previewIdeaBody(body).endsWith("…")).toBe(true);
  });
});

describe("IdeaService capture", () => {
  it.each(["", "   ", "x".repeat(129)])(
    "rejects an invalid capture request ID",
    (captureRequestId) => {
      const { projectStore, service } = createHarness();
      const project = projectStore.createProject({ name: "Ideas" });

      expect(() => service.capture({
        projectId: project.id,
        expectedProjectRevision: project.revision,
        captureRequestId,
        text: "Capture safely",
      })).toThrow();
    },
  );

  it("hashes normalized semantic capture input and passes its fixed replay descriptor", () => {
    const { governanceStore, projectStore } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Current work",
      body: "Keep it stable.",
      sourceKind: "human",
      sourceRef: null,
    });
    let command: Parameters<typeof governanceStore.applyHumanChange>[0] | undefined;
    const service = createIdeaService({
      projectStore,
      governanceStore: {
        applyHumanChange(input) {
          command = input;
          return governanceStore.applyHumanChange(input);
        },
      },
      now: () => timestamp,
    });

    const revision = projectStore.getProject(project.id)!.revision;
    service.capture({
      projectId: project.id,
      expectedProjectRevision: revision,
      captureRequestId: "capture-request-1",
      text: "  Keep replay deterministic\r\nDetails stay local.  ",
      contextRecordIds: [task.id, task.id],
    });

    expect(command?.idempotency).toMatchObject({
      operationScope: "idea_capture",
      key: "capture-request-1",
      requestHash: createHash("sha256").update(JSON.stringify({
        v: 1,
        projectId: project.id,
        expectedProjectRevision: revision,
        body: "Keep replay deterministic\nDetails stay local.",
        contextRecordIds: [task.id],
      })).digest("hex"),
    });
  });

  it("replays a lost capture response without another idea or revision", () => {
    const { governanceStore, projectStore, service } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const input = {
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Keep the committed response.",
    };

    const first = service.capture(input);
    const replay = service.capture(input);

    expect(replay).toEqual(first);
    expect(ideaState(projectStore, governanceStore, project.id)).toMatchObject({
      revision: project.revision + 1,
      ideaCount: 1,
    });
  });

  it("replays the original context after a supported task update", () => {
    const { governanceStore, projectStore, service } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const originalTitle = `Original task title ${"x".repeat(512)}`;
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: originalTitle,
      body: "Capture this original context.",
      sourceKind: "human",
      sourceRef: null,
    });
    const input = {
      projectId: project.id,
      expectedProjectRevision: projectStore.getProject(project.id)!.revision,
      captureRequestId: "capture-request-1",
      text: "Replay context exactly.",
      contextRecordIds: [task.id],
    };
    const first = service.capture(input);
    governanceStore.applyHumanChange({
      projectId: project.id,
      expectedProjectRevision: first.projectRevision,
      rationale: "Rename the current task after capture.",
      operations: [{
        operationId: "rename-task",
        type: "update_record",
        recordId: task.id,
        expectedRecordRevision: task.revision,
        patch: {
          title: "Updated task title",
          status: "completed",
        },
      }],
      completedAt: timestamp,
    });

    expect(service.capture(input)).toEqual(first);
  });

  it.each([
    {
      label: "created idea owned by another project",
      createdProjectId: "project-other",
      replayPayload: [],
    },
    {
      label: "context without project ownership",
      createdProjectId: "project-1",
      replayPayload: [{
        id: "task-replay",
        kind: "task",
        title: "Replay task",
        status: "active",
      }],
    },
  ])("rejects replayed $label", ({ createdProjectId, replayPayload }) => {
    const { projectStore } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const service = createIdeaService({
      projectStore,
      governanceStore: {
        applyHumanChange: () => ({
          outcome: "applied",
          projectId: project.id,
          revisionBefore: 0,
          revisionAfter: 1,
          operations: [{
            operationId: "capture-idea",
            type: "create_record",
            record: {
              id: "idea-replay",
              projectId: createdProjectId === "project-1"
                ? project.id
                : createdProjectId,
              kind: "idea",
              status: "provisional",
              title: "Replay ownership",
              body: "Replay ownership",
              sourceKind: "human",
              sourceRef: "web:idea-capture",
              revision: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          }],
          replayPayloadJson: JSON.stringify(replayPayload),
        }),
      },
      now: () => timestamp,
    });

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-ownership",
      text: "Reject cross-project replay data.",
    })).toThrowError(expect.objectContaining({ code: "internal_error" }));
  });

  it("surfaces an idempotency conflict for changed semantics under one request ID", () => {
    const { projectStore, service } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const input = {
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Original semantic input.",
    };
    service.capture(input);

    expect(() => service.capture({ ...input, text: "Changed semantic input." }))
      .toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it.each([
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "SQLITE_LOCKED_SHAREDCACHE",
    "SQLITE_READONLY",
    "SQLITE_READONLY_DBMOVED",
    "SQLITE_FULL",
    "SQLITE_CANTOPEN",
    "SQLITE_PROTOCOL",
    "SQLITE_IOERR",
    "SQLITE_IOERR_READ",
  ])("maps allowed SQLite operational error %s to service unavailable", (code) => {
    const { projectStore } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const service = createIdeaService({
      projectStore: {
        ...projectStore,
        withReadSnapshot() {
          throw Object.assign(new Error("SQLite unavailable"), { code });
        },
      },
      governanceStore: { applyHumanChange: () => { throw new Error("unreached"); } },
      now: () => timestamp,
    });

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Unavailable storage.",
    })).toThrow(IdeaServiceUnavailableError);
  });

  it.each([
    "SQLITE_CONSTRAINT",
    "SQLITE_LOCKEDNESS",
    "SQLITE_READONLYISH",
    "SQLITE_IOERROR",
  ])("does not translate unapproved SQLite code %s", (code) => {
    const { projectStore } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const unexpected = Object.assign(new Error("SQLite programming failure"), { code });
    const service = createIdeaService({
      projectStore: {
        ...projectStore,
        withReadSnapshot() { throw unexpected; },
      },
      governanceStore: { applyHumanChange: () => { throw new Error("unreached"); } },
      now: () => timestamp,
    });

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-negative-code",
      text: "Do not translate programming failures.",
    })).toThrow(unexpected);
  });

  it("does not translate arbitrary dependency failures", () => {
    const { projectStore } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const unexpected = new Error("unexpected");
    const service = createIdeaService({
      projectStore: {
        ...projectStore,
        withReadSnapshot() { throw unexpected; },
      },
      governanceStore: { applyHumanChange: () => { throw new Error("unreached"); } },
      now: () => timestamp,
    });

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Unexpected storage.",
    })).toThrow(unexpected);
  });

  it("creates one provisional idea and its context in one human revision", () => {
    const { governanceStore, projectStore, service } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Current task",
      body: "Keep the current work unchanged.",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = projectStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "accepted",
      title: "Idea intake",
      body: "Capture context explicitly.",
      sourceKind: "human",
      sourceRef: null,
    });
    const before = projectStore.getProject(project.id)!;
    const auditCount = governanceStore.listAuditEvents({ projectId: project.id }).length;

    const result = service.capture({
      projectId: project.id,
      expectedProjectRevision: before.revision,
      captureRequestId: "capture-request-1",
      text: "Preserve small thoughts\nDo not reprioritize work.",
      contextRecordIds: [task.id, component.id, task.id],
    });

    expect(result).toMatchObject({
      projectRevision: before.revision + 1,
      item: {
        status: "provisional",
        title: "Preserve small thoughts",
        sourceKind: "human",
        sourceRef: "web:idea-capture",
        context: [{ id: task.id }, { id: component.id }],
      },
    });
    expect(projectStore.listRelationships(project.id)).toEqual([
      expect.objectContaining({
        fromRecordId: result.item.id,
        toRecordId: task.id,
        kind: "related_to",
      }),
      expect.objectContaining({
        fromRecordId: result.item.id,
        toRecordId: component.id,
        kind: "related_to",
      }),
    ]);
    const auditEvents = governanceStore.listAuditEvents({ projectId: project.id, limit: 100 });
    expect(auditEvents).toHaveLength(auditCount + 1);
    expect(auditEvents.find(({ reason }) => reason === "Capture project idea"))
      .toMatchObject({
        actorType: "local_human",
        authorityMode: "human",
        actionCategory: "change_applied",
        reason: "Capture project idea",
      });
  });

  it.each(["missing", "cross-project", "wrong-kind"] as const)(
    "rejects %s context without partial state",
    (scenario) => {
      const { governanceStore, projectStore, service } = createHarness();
      const project = projectStore.createProject({ name: "Ideas" });
      let contextRecordIds: string[];

      if (scenario === "missing") {
        contextRecordIds = ["record-missing"];
      } else if (scenario === "cross-project") {
        const other = projectStore.createProject({ name: "Other" });
        const foreignTask = projectStore.createRecord({
          projectId: other.id,
          kind: "task",
          status: "active",
          title: "Foreign task",
          body: "This task belongs to another project.",
          sourceKind: "human",
          sourceRef: null,
        });
        contextRecordIds = [foreignTask.id];
      } else {
        const decision = projectStore.createRecord({
          projectId: project.id,
          kind: "decision",
          status: "accepted",
          title: "Not idea context",
          body: "Only tasks and components provide idea context.",
          sourceKind: "human",
          sourceRef: null,
        });
        contextRecordIds = [decision.id];
      }

      const before = ideaState(projectStore, governanceStore, project.id);
      expect(() => service.capture({
        projectId: project.id,
        expectedProjectRevision: before.revision,
        captureRequestId: "capture-request-1",
        text: "Keep this atomic",
        contextRecordIds,
      })).toThrow(IdeaContextInvalidError);
      expect(ideaState(projectStore, governanceStore, project.id)).toEqual(before);
    },
  );

  it("rejects a stale revision without partial state", () => {
    const { governanceStore, projectStore, service } = createHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const before = ideaState(projectStore, governanceStore, project.id);

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: before.revision + 1,
      captureRequestId: "capture-request-1",
      text: "Do not write stale ideas",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "project_revision_conflict",
    }));
    expect(ideaState(projectStore, governanceStore, project.id)).toEqual(before);
  });

  it("rolls back capture when a second prepared link reuses a relationship ID", () => {
    const { governanceStore, projectStore, service } = createHarness({
      repeatedRelationshipId: true,
    });
    const project = projectStore.createProject({ name: "Ideas" });
    const first = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "First context",
      body: "A real relationship will be prepared first.",
      sourceKind: "human",
      sourceRef: null,
    });
    const second = projectStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "accepted",
      title: "Second context",
      body: "The duplicate ID fails on the second prepared link.",
      sourceKind: "human",
      sourceRef: null,
    });
    const before = ideaState(projectStore, governanceStore, project.id);

    expect(() => service.capture({
      projectId: project.id,
      expectedProjectRevision: before.revision,
      captureRequestId: "capture-request-1",
      text: "Rollback every write",
      contextRecordIds: [first.id, second.id],
    })).toThrow();
    expect(ideaState(projectStore, governanceStore, project.id)).toEqual(before);
  });
});

describe("IdeaService inbox", () => {
  it("uses a default limit of 25 ideas", () => {
    const { governanceStore, projectStore } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const service = createIdeaService({
      projectStore,
      governanceStore,
      now: () => timestamp,
    });

    for (let index = 0; index < 26; index += 1) {
      projectStore.createRecord({
        projectId: project.id,
        kind: "idea",
        status: "provisional",
        title: `Idea ${index + 1}`,
        body: "The default page must retain one extra record.",
        sourceKind: "human",
        sourceRef: "test",
      });
    }

    const page = service.listInbox({ projectId: project.id });

    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("returns a project-bound deterministic idea page with same-project context", () => {
    const { governanceStore, projectStore, at } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Task context",
      body: "A task in this project.",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = projectStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "accepted",
      title: "Component context",
      body: "A component in this project.",
      sourceKind: "human",
      sourceRef: null,
    });
    at("2026-08-08T10:00:00.000Z");
    const old = projectStore.createRecord({
      projectId: project.id,
      kind: "idea",
      status: "provisional",
      title: "Old idea",
      body: "The earliest idea.",
      sourceKind: "human",
      sourceRef: "test",
    });
    at("2026-08-08T12:00:00.000Z");
    const ideaA = projectStore.createRecord({
      projectId: project.id,
      kind: "idea",
      status: "provisional",
      title: "A idea",
      body: "Tied timestamps use descending IDs.",
      sourceKind: "human",
      sourceRef: "test",
    });
    const ideaZ = projectStore.createRecord({
      projectId: project.id,
      kind: "idea",
      status: "provisional",
      title: "Z idea",
      body: "Tied timestamps use descending IDs.",
      sourceKind: "human",
      sourceRef: "test",
    });
    at("2026-08-08T13:00:00.000Z");
    projectStore.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Do not display this",
      body: "Inbox records only ideas.",
      sourceKind: "human",
      sourceRef: null,
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: ideaZ.id,
      toRecordId: task.id,
      kind: "related_to",
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: ideaA.id,
      toRecordId: component.id,
      kind: "related_to",
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: old.id,
      toRecordId: task.id,
      kind: "related_to",
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: old.id,
      toRecordId: component.id,
      kind: "related_to",
    });
    const foreign = projectStore.createProject({ name: "Foreign" });
    const foreignTask = projectStore.createRecord({
      projectId: foreign.id,
      kind: "task",
      status: "active",
      title: "Foreign context",
      body: "This task is not in the inbox project.",
      sourceKind: "human",
      sourceRef: null,
    });
    projectStore.createRecord({
      projectId: foreign.id,
      kind: "idea",
      status: "provisional",
      title: "Foreign idea",
      body: "This idea is outside the requested project.",
      sourceKind: "human",
      sourceRef: "test",
    });
    const realListRelationships = projectStore.listRelationships.bind(projectStore);
    const service = createIdeaService({
      projectStore: {
        ...projectStore,
        listRelationships(projectId) {
          return [...realListRelationships(projectId), {
            id: "relationship-foreign",
            projectId,
            fromRecordId: ideaZ.id,
            toRecordId: foreignTask.id,
            kind: "related_to" as const,
            createdAt: "2026-08-08T13:00:00.000Z",
          }];
        },
      },
      governanceStore,
      now: () => "2026-08-08T13:00:00.000Z",
    });

    const first = service.listInbox({ projectId: project.id, limit: 2 });

    expect(first).toMatchObject({
      projectId: project.id,
      projectRevision: projectStore.getProject(project.id)!.revision,
      items: [
        { id: "record-idea-z", context: [{ kind: "task" }] },
        { id: "record-idea-a", context: [{ kind: "component" }] },
      ],
      hasMore: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items.map(({ id }) => id)).toEqual(["record-idea-z", "record-idea-a"]);

    const second = service.listInbox({
      projectId: project.id,
      limit: 2,
      cursor: first.nextCursor!,
    });

    expect(second.items.map(({ id }) => id)).toEqual(["record-idea-old"]);
    expect(second.items[0]!.context.map(({ kind }) => kind)).toEqual(["component", "task"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("rejects invalid project-bound inbox cursors and out-of-range limits", () => {
    const { governanceStore, projectStore } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const otherProject = projectStore.createProject({ name: "Other" });
    const service = createIdeaService({
      projectStore,
      governanceStore,
      now: () => timestamp,
    });
    const cursor = Buffer.from(JSON.stringify({
      v: 1,
      projectId: otherProject.id,
      createdAt: timestamp,
      id: "record-idea-a",
    }), "utf8").toString("base64url");
    const cursorWithUnknownField = Buffer.from(JSON.stringify({
      v: 1,
      projectId: project.id,
      createdAt: timestamp,
      id: "record-idea-a",
      extra: true,
    }), "utf8").toString("base64url");

    for (const invalidCursor of [cursor, "not-base64", `${cursor}=`, cursorWithUnknownField]) {
      expect(() => service.listInbox({ projectId: project.id, cursor: invalidCursor }))
        .toThrow(expect.objectContaining<Partial<GovernanceError>>({
          code: "validation_failed",
          message: "Idea inbox cursor is invalid",
        }));
    }
    expect(() => service.listInbox({ projectId: project.id, limit: 0 })).toThrow();
    expect(() => service.listInbox({ projectId: project.id, limit: 101 })).toThrow();
  });
});

describe("IdeaService detail", () => {
  it("returns the current full idea and deterministic same-project context", () => {
    const { governanceStore, projectStore } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const task = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Verify detail",
      body: "Task body",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = projectStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "accepted",
      title: "Ideas",
      body: "Component body",
      sourceKind: "human",
      sourceRef: null,
    });
    projectStore.createRecord({
      projectId: project.id,
      kind: "evidence",
      status: "accepted",
      title: "Detail evidence",
      body: "Evidence is not idea context.",
      sourceKind: "human",
      sourceRef: null,
    });
    projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Unrelated task",
      body: "This task has no idea relationship.",
      sourceKind: "human",
      sourceRef: null,
    });
    const idea = projectStore.createRecord({
      projectId: project.id,
      kind: "idea",
      status: "provisional",
      title: "Inspect the complete idea",
      body: `First line\n${"x".repeat(320)}`,
      sourceKind: "human",
      sourceRef: "web:idea-capture",
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: idea.id,
      toRecordId: task.id,
      kind: "related_to",
    });
    projectStore.createRelationship({
      projectId: project.id,
      fromRecordId: idea.id,
      toRecordId: component.id,
      kind: "related_to",
    });
    const foreign = projectStore.createProject({ name: "Foreign" });
    projectStore.createRecord({
      projectId: foreign.id,
      kind: "idea",
      status: "provisional",
      title: "Foreign idea",
      body: "This idea must not affect local detail.",
      sourceKind: "human",
      sourceRef: null,
    });

    const service = createIdeaService({ projectStore, governanceStore, now: () => timestamp });
    const detail = service.getDetail({ projectId: project.id, ideaId: idea.id });

    expect(detail).toMatchObject({
      id: idea.id,
      projectId: project.id,
      revision: idea.revision,
      status: "provisional",
      title: "Inspect the complete idea",
      body: `First line\n${"x".repeat(320)}`,
      sourceKind: "human",
      sourceRef: "web:idea-capture",
      createdAt: idea.createdAt,
      updatedAt: idea.updatedAt,
      context: [
        { id: component.id, kind: "component" },
        { id: task.id, kind: "task" },
      ],
    });
    expect(detail).not.toHaveProperty("bodyPreview");
  });

  it("deduplicates and hides non-qualifying context while reading one snapshot", () => {
    const { governanceStore, projectStore } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const idea = projectStore.createRecord({
      projectId: project.id, kind: "idea", status: "provisional", title: "Local idea",
      body: "Read local records only.", sourceKind: "human", sourceRef: null,
    });
    const task = projectStore.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Local task",
      body: "Visible context.", sourceKind: "human", sourceRef: null,
    });
    const decision = projectStore.createRecord({
      projectId: project.id, kind: "decision", status: "accepted", title: "Private decision",
      body: "Not a context kind.", sourceKind: "human", sourceRef: null,
    });
    const foreign = projectStore.createProject({ name: "Foreign" });
    const foreignTask = projectStore.createRecord({
      projectId: foreign.id, kind: "task", status: "active", title: "Foreign task",
      body: "Must not disclose.", sourceKind: "human", sourceRef: null,
    });
    projectStore.createRelationship({
      projectId: project.id, fromRecordId: idea.id, toRecordId: task.id, kind: "related_to",
    });
    const realGetProject = projectStore.getProject.bind(projectStore);
    const realListRecords = projectStore.listRecords.bind(projectStore);
    const realListRelationships = projectStore.listRelationships.bind(projectStore);
    let inSnapshot = false;
    const reads: string[] = [];
    const service = createIdeaService({
      projectStore: {
        ...projectStore,
        withReadSnapshot(read) {
          reads.push("snapshot");
          inSnapshot = true;
          try { return projectStore.withReadSnapshot(read); } finally { inSnapshot = false; }
        },
        getProject(projectId) {
          expect(inSnapshot).toBe(true);
          reads.push("project");
          return realGetProject(projectId);
        },
        listRecords(projectId) {
          expect(inSnapshot).toBe(true);
          reads.push("records");
          return realListRecords(projectId);
        },
        listRelationships(projectId) {
          expect(inSnapshot).toBe(true);
          reads.push("relationships");
          return [...realListRelationships(projectId),
            { id: "relationship-duplicate", projectId, fromRecordId: idea.id, toRecordId: task.id, kind: "related_to" as const, createdAt: timestamp },
            { id: "relationship-missing", projectId, fromRecordId: idea.id, toRecordId: "missing", kind: "related_to" as const, createdAt: timestamp },
            { id: "relationship-decision", projectId, fromRecordId: idea.id, toRecordId: decision.id, kind: "related_to" as const, createdAt: timestamp },
            { id: "relationship-foreign", projectId, fromRecordId: idea.id, toRecordId: foreignTask.id, kind: "related_to" as const, createdAt: timestamp },
          ];
        },
      }, governanceStore, now: () => timestamp,
    });

    expect(service.getDetail({ projectId: project.id, ideaId: idea.id }).context)
      .toEqual([{ id: task.id, kind: "task", title: "Local task", status: "active" }]);
    expect(reads).toEqual(["snapshot", "project", "records", "relationships"]);
  });

  it("does not disclose missing, wrong-kind, or foreign ideas", () => {
    const { governanceStore, projectStore } = createInboxHarness();
    const project = projectStore.createProject({ name: "Ideas" });
    const decision = projectStore.createRecord({
      projectId: project.id, kind: "decision", status: "accepted", title: "Decision",
      body: "Not an idea.", sourceKind: "human", sourceRef: null,
    });
    const foreign = projectStore.createProject({ name: "Foreign" });
    const foreignIdea = projectStore.createRecord({
      projectId: foreign.id, kind: "idea", status: "provisional", title: "Foreign idea",
      body: "Not visible.", sourceKind: "human", sourceRef: null,
    });
    const service = createIdeaService({ projectStore, governanceStore, now: () => timestamp });

    for (const ideaId of ["missing", decision.id, foreignIdea.id]) {
      expect(() => service.getDetail({ projectId: project.id, ideaId }))
        .toThrow(new RecordNotFoundError(ideaId));
    }
  });

  it.each(["getProject", "listRecords", "listRelationships"] as const)(
    "maps available SQLite errors from %s and rethrows private failures",
    (method) => {
      const { governanceStore, projectStore } = createInboxHarness();
      const project = projectStore.createProject({ name: "Ideas" });
      const idea = projectStore.createRecord({
        projectId: project.id, kind: "idea", status: "provisional", title: "Idea",
        body: "Read errors.", sourceKind: "human", sourceRef: null,
      });
      for (const failure of [
        Object.assign(new Error("SQLite unavailable"), { code: "SQLITE_BUSY" }),
        new Error("private"),
      ]) {
        const service = createIdeaService({
          projectStore: {
            ...projectStore,
            [method]() { throw failure; },
          }, governanceStore, now: () => timestamp,
        });
        const expected = "code" in failure ? IdeaServiceUnavailableError : failure;
        expect(() => service.getDetail({ projectId: project.id, ideaId: idea.id })).toThrow(expected);
      }
    },
  );
});
