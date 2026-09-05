import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentNotFoundError,
  type DocumentRegistryService,
} from "../../core/document-registry-service.js";
import { RepositoryRefreshUnavailableError } from "../../core/repository-refresh-service.js";
import { IdeaServiceUnavailableError } from "../../core/idea-service.js";
import {
  createApplication,
  type IntentArcApplication,
} from "../../app/create-application.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../../test-support/database.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../../test-support/repository-fixture.js";
import { createApplicationRoutes } from "./api-routes.js";
import { ApiNdjsonResponse, ApiRouteError, createApiHandler } from "./router.js";
import type { ReleasedContextResponse } from "../contracts.js";

const installLateDestinationFailure = (databasePath: string): void => {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TRIGGER fail_project_profile_destination
      BEFORE INSERT ON outbound_destinations
      BEGIN
        SELECT RAISE(ABORT, 'forced late destination failure');
      END
    `);
  } finally {
    database.close();
  }
};

const readProfileSetupCounts = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM client_profiles) AS profiles,
        (SELECT COUNT(*) FROM profile_project_authorities) AS authorities,
        (SELECT COUNT(*) FROM outbound_destinations) AS destinations,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get() as {
      profiles: number;
      authorities: number;
      destinations: number;
      audits: number;
    };
  } finally {
    database.close();
  }
};

describe("application API routes", () => {
  let temporaryDatabase: TemporaryDatabase;
  let application: IntentArcApplication;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  const repositoryFixtures: RepositoryFixture[] = [];
  const sendRawHttpRequest = async (headers: readonly string[]): Promise<{
    status: number;
    body: string;
  }> => {
    const address = server.address() as AddressInfo;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      socket.once("end", () => resolve(received));
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.end(`${headers.join("\r\n")}\r\n\r\n`);
      });
    });
    const separator = response.indexOf("\r\n\r\n");
    const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
    return { status, body: response.slice(separator + 4) };
  };
  const documentEntry = {
    projectId: "project-1",
    snapshotId: "repository-snapshot-1",
    nodeId: "repository-node-1",
    path: "docs/overview.md",
    documentKind: "overview" as const,
    documentFormat: "markdown" as const,
    role: "supporting_document" as const,
    freshness: "current" as const,
    contentEligible: true,
    instructionClient: null,
    instructionScope: null,
    links: [],
  };

  const installDocumentService = (
    overrides: Partial<DocumentRegistryService> = {},
  ): DocumentRegistryService => {
    const service: DocumentRegistryService = {
      list: () => ({
        projectId: "project-1",
        snapshotId: "repository-snapshot-1",
        documents: [documentEntry],
        facets: {
          documentKinds: [{ value: "overview", count: 1 }],
          formats: [{ value: "markdown", count: 1 }],
          roles: [{ value: "supporting_document", count: 1 }],
          freshness: [{ value: "current", count: 1 }],
        },
      }),
      get: () => ({
        document: documentEntry,
        linksByBasis: {
          accepted: [],
          observed: [],
          inferred: [],
          conflicting: [],
        },
        nativeCapability: "renderable",
        externalOpenEligible: true,
      }),
      read: () => ({
        status: "renderable",
        format: "markdown",
        text: "# Accepted overview",
        sha256: "a".repeat(64),
      }),
      readPreview: () => ({ status: "unsupported" }),
      resolveExternalOpen: () => ({ status: "blocked" }),
      ...overrides,
    };
    Object.assign(application.service, { documents: service });
    return service;
  };

  beforeEach(async () => {
    temporaryDatabase = createTemporaryDatabase();
    const ids: Record<string, number> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-29T12:00:00.000Z",
      newId: (prefix) => `${prefix}-${ids[prefix] = (ids[prefix] ?? 0) + 1}`,
    });
    server = createServer(
      createApiHandler(createApplicationRoutes(application)),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    application.close();
    while (repositoryFixtures.length > 0) {
      repositoryFixtures.pop()!.cleanup();
    }
    removeTemporaryDatabase(temporaryDatabase);
  });

  it("captures and pages a strict provisional idea without exposing private project data", async () => {
    const project = application.service.createProject({
      name: "Idea project",
      primaryRepositoryPath: "C:/private/repository",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Current task",
      body: "Provide context.",
      sourceKind: "human",
      sourceRef: null,
    });
    const foreignProject = application.service.createProject({ name: "Foreign" });
    application.service.createRecord({
      projectId: foreignProject.id,
      kind: "task",
      status: "active",
      title: "Foreign title must stay private",
      body: "Private foreign body.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Local decision",
      body: "Not valid idea context.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.ideas.capture({
      projectId: project.id,
      expectedProjectRevision: 2,
      captureRequestId: "capture-request-old",
      text: "Older idea",
    });

    const created = await fetch(`${origin}/api/projects/${project.id}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedProjectRevision: 3,
        captureRequestId: "capture-request-new",
        text: "Keep the new idea",
        contextRecordIds: [task.id, task.id],
      }),
    });
    const createdText = await created.text();

    expect(created.status).toBe(201);
    expect(JSON.parse(createdText)).toEqual({
      projectRevision: 4,
      item: {
        id: "record-5",
        projectId: project.id,
        revision: 1,
        status: "provisional",
        title: "Keep the new idea",
        bodyPreview: "Keep the new idea",
        sourceKind: "human",
        sourceRef: "web:idea-capture",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        context: [{
          id: task.id,
          kind: "task",
          title: "Current task",
          status: "active",
        }],
      },
    });
    const database = new Database(temporaryDatabase.path, { readonly: true });
    try {
      expect(database.prepare(`
        SELECT COUNT(*) AS count
        FROM record_relationships
        WHERE from_record_id = ? AND to_record_id = ?
      `).get("record-5", task.id)).toEqual({ count: 1 });
    } finally {
      database.close();
    }

    const listed = await fetch(
      `${origin}/api/projects/${project.id}/ideas?limit=1`,
    );
    const listedText = await listed.text();
    const page = JSON.parse(listedText) as {
      projectId: string;
      projectRevision: number;
      items: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(listed.status).toBe(200);
    expect(page).toMatchObject({
      projectId: project.id,
      projectRevision: 4,
      items: [{ id: "record-5" }],
      hasMore: true,
    });
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.nextCursor!.length).toBeLessThanOrEqual(8_192);

    for (const text of [createdText, listedText]) {
      expect(text).not.toContain(temporaryDatabase.path);
      expect(text).not.toContain("C:/private/repository");
      expect(text).not.toContain("Foreign title must stay private");
    }
  });

  it("rejects stale idea capture without creating an idea", async () => {
    const project = application.service.createProject({ name: "Ideas" });
    const response = await fetch(`${origin}/api/projects/${project.id}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedProjectRevision: 1,
        captureRequestId: "capture-request-stale",
        text: "Stale idea",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "project_revision_conflict" },
    });
    const listed = await fetch(`${origin}/api/projects/${project.id}/ideas`);
    expect(await listed.json()).toMatchObject({ items: [] });
  });

  it("returns the full authoritative idea detail with its permitted context", async () => {
    const project = application.service.createProject({
      name: "Idea detail",
      primaryRepositoryPath: "C:/private/repository",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Keep detail context",
      body: "The context record is allowed in the detail response.",
      sourceKind: "human",
      sourceRef: null,
    });
    const fullBody = `Keep the full idea\n${Array.from(
      { length: 24 },
      () => "authoritative detail",
    ).join(" ")}`;
    const captured = application.service.ideas.capture({
      projectId: project.id,
      expectedProjectRevision: application.service.getProjectSummary(project.id)
        .project.revision,
      captureRequestId: "detail-capture-request",
      text: fullBody,
      contextRecordIds: [task.id],
    });

    const detail = await fetch(
      `${origin}/api/projects/${encodeURIComponent(project.id)}/ideas/${encodeURIComponent(captured.item.id)}`,
    );
    const text = await detail.text();

    expect(detail.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      id: captured.item.id,
      projectId: project.id,
      body: fullBody,
      sourceKind: "human",
      sourceRef: "web:idea-capture",
      context: [{ id: task.id, kind: "task" }],
    });
    expect(text).not.toContain(temporaryDatabase.path);
    expect(text).not.toContain("C:/private/repository");
  });

  it("sanitizes contract-invalid idea detail service responses as internal failures", async () => {
    const project = application.service.createProject({ name: "Idea detail" });
    vi.spyOn(application.service.ideas, "getDetail").mockReturnValue({
      id: "idea-private",
      projectId: project.id,
      revision: 1,
      status: "provisional",
      title: "Invalid detail",
      body: "This response must not cross the API boundary.",
      sourceKind: "human",
      sourceRef: null,
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      context: [],
      repositoryRoot: "C:/private/repository",
    } as never);

    const response = await fetch(
      `${origin}/api/projects/${project.id}/ideas/idea-private`,
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        recoverable: false,
      },
    });
    expect(text).not.toContain("repositoryRoot");
    expect(text).not.toContain("C:/private/repository");
  });

  it("maps unavailable, unknown, and indistinguishable missing idea details safely", async () => {
    const project = application.service.createProject({ name: "Idea detail" });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Not an idea",
      body: "A decision must not be disclosed as an idea.",
      sourceKind: "human",
      sourceRef: null,
    });
    const foreignProject = application.service.createProject({ name: "Foreign" });
    const foreignIdea = application.service.ideas.capture({
      projectId: foreignProject.id,
      expectedProjectRevision: foreignProject.revision,
      captureRequestId: "foreign-detail-capture-request",
      text: "Foreign idea",
    }).item;

    for (const ideaId of ["missing", decision.id, foreignIdea.id]) {
      const response = await fetch(
        `${origin}/api/projects/${project.id}/ideas/${ideaId}`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
          recoverable: true,
        },
      });
    }

    const unavailable = vi.spyOn(application.service.ideas, "getDetail")
      .mockImplementation(() => {
        throw new IdeaServiceUnavailableError();
      });
    const unavailableResponse = await fetch(
      `${origin}/api/projects/${project.id}/ideas/missing`,
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toMatchObject({
      error: { code: "service_unavailable", recoverable: true },
    });

    unavailable.mockImplementation(() => {
      throw new Error("private unexpected failure");
    });
    const unknownResponse = await fetch(
      `${origin}/api/projects/${project.id}/ideas/missing`,
    );
    const unknownText = await unknownResponse.text();
    expect(unknownResponse.status).toBe(500);
    expect(JSON.parse(unknownText)).toMatchObject({
      error: { code: "internal_error", recoverable: false },
    });
    expect(unknownText).not.toContain("private unexpected failure");
  });

  it("keeps idea detail GET-only without invoking idea operations", async () => {
    const project = application.service.createProject({ name: "Idea detail" });
    const capture = vi.spyOn(application.service.ideas, "capture");
    const getDetail = vi.spyOn(application.service.ideas, "getDetail");

    const response = await fetch(
      `${origin}/api/projects/${project.id}/ideas/idea-1`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(capture).not.toHaveBeenCalled();
    expect(getDetail).not.toHaveBeenCalled();
  });

  it("maps only idea-service availability failures to sanitized recoverable 503 responses", async () => {
    const project = application.service.createProject({ name: "Ideas" });
    vi.spyOn(application.service.ideas, "listInbox").mockImplementation(() => {
      throw new IdeaServiceUnavailableError();
    });
    const inbox = await fetch(`${origin}/api/projects/${project.id}/ideas`);
    expect(inbox.status).toBe(503);
    expect(await inbox.json()).toMatchObject({
      error: { code: "service_unavailable", recoverable: true },
    });

    vi.restoreAllMocks();
    vi.spyOn(application.service.ideas, "capture").mockImplementation(() => {
      throw new IdeaServiceUnavailableError();
    });
    const capture = await fetch(`${origin}/api/projects/${project.id}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedProjectRevision: project.revision,
        captureRequestId: "capture-request-1",
        text: "Retry safely.",
      }),
    });
    expect(capture.status).toBe(503);
    expect(await capture.json()).toMatchObject({
      error: { code: "service_unavailable", recoverable: true },
    });

    vi.restoreAllMocks();
    vi.spyOn(application.service.ideas, "listInbox").mockImplementation(() => {
      throw new Error("private unexpected failure");
    });
    const unexpected = await fetch(`${origin}/api/projects/${project.id}/ideas`);
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toMatchObject({
      error: { code: "internal_error", recoverable: false },
    });
  });

  it("replays the same capture POST without another project revision", async () => {
    const project = application.service.createProject({ name: "Ideas" });
    const body = {
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Replay the response after a lost connection.",
    };
    const request = () => fetch(`${origin}/api/projects/${project.id}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const first = await request();
    const firstBody = await first.json();
    const replay = await request();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(application.service.getProjectSummary(project.id).project.revision)
      .toBe(project.revision + 1);
  });

  it("maps every invalid idea context to the same sanitized conflict", async () => {
    const project = application.service.createProject({
      name: "Ideas",
      primaryRepositoryPath: "C:/private/repository",
    });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Wrong context kind",
      body: "Decisions cannot be linked on intake.",
      sourceKind: "human",
      sourceRef: null,
    });
    const foreignProject = application.service.createProject({ name: "Foreign" });
    const foreignTask = application.service.createRecord({
      projectId: foreignProject.id,
      kind: "task",
      status: "active",
      title: "Foreign title must stay private",
      body: "Private foreign body.",
      sourceKind: "human",
      sourceRef: null,
    });

    for (const contextRecordId of ["record-missing", decision.id, foreignTask.id]) {
      const response = await fetch(`${origin}/api/projects/${project.id}/ideas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedProjectRevision: 1,
          captureRequestId: `capture-request-${contextRecordId}`,
          text: "Invalid context",
          contextRecordIds: [contextRecordId],
        }),
      });
      const text = await response.text();
      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "idea_context_invalid",
          message: "The idea context changed. Refresh the project and try again.",
          recoverable: true,
        },
      });
      expect(text).not.toContain(temporaryDatabase.path);
      expect(text).not.toContain("C:/private/repository");
      expect(text).not.toContain("Foreign title must stay private");
    }
    const listed = await fetch(`${origin}/api/projects/${project.id}/ideas`);
    expect(await listed.json()).toMatchObject({ items: [] });
  });

  it("rejects malformed idea requests and keeps generic record creation absent", async () => {
    const project = application.service.createProject({ name: "Ideas" });
    for (const url of [
      `${origin}/api/projects/${project.id}/ideas?limit=0`,
      `${origin}/api/projects/${project.id}/ideas?cursor=not+base64url`,
      `${origin}/api/projects/${project.id}/ideas?cursor=YWJj`,
      `${origin}/api/projects/${project.id}/ideas?limit=1&limit=2`,
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    const invalidBody = await fetch(`${origin}/api/projects/${project.id}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedProjectRevision: project.revision,
        text: "Invalid extra field",
        repositoryRoot: "C:/private/repository",
      }),
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const genericRecordPost = await fetch(
      `${origin}/api/projects/${project.id}/records`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "idea", title: "Too broad" }),
      },
    );
    expect(genericRecordPost.status).toBe(404);
  });

  it("exposes accepted documents through strict node-only JSON routes", async () => {
    installDocumentService();
    const base = `${origin}/api/projects/project-1/documents`;

    const list = await fetch(`${base}?format=markdown&unlinked=false`);
    const detail = await fetch(`${base}/repository-node-1`);
    const content = await fetch(
      `${base}/repository-node-1/content?expectedSnapshotId=repository-snapshot-1`,
    );

    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      projectId: "project-1",
      snapshotId: "repository-snapshot-1",
      documents: [{ nodeId: "repository-node-1", path: "docs/overview.md" }],
    });
    expect(await detail.json()).toMatchObject({
      document: { nodeId: "repository-node-1" },
      externalOpenAvailable: false,
    });
    const serializedContent = await content.text();
    expect(JSON.parse(serializedContent)).toEqual({
      format: "markdown",
      text: "# Accepted overview",
      sha256: "a".repeat(64),
    });
    expect(content.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(content.headers.get("content-length")).toBe(
      String(Buffer.byteLength(serializedContent)),
    );
    for (const response of [list, detail, content]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
      );
      expect(response.headers.get("content-disposition")).toBeNull();
    }
  });

  it("exposes strict focused maps and keeps record and node details project-isolated", async () => {
    const project = application.service.createProject({ name: "Focused map" });
    const outcome = application.service.createRecord({
      projectId: project.id,
      kind: "outcome",
      status: "active",
      title: "Structured knowledge",
      body: "Keep the hierarchy authoritative.",
      sourceKind: "human",
      sourceRef: null,
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Expose focused maps",
      body: "Return bounded connected detail.",
      sourceKind: "human",
      sourceRef: null,
    });
    const feature = application.service.createRecord({
      projectId: project.id,
      kind: "deliverable",
      status: "active",
      title: "Map contract",
      body: "Bind the whole-project forest to its route.",
      sourceKind: "human",
      sourceRef: null,
    });
    const outsideScope = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Sibling task",
      body: "This task is not on the selected path.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: outcome.id,
      toRecordId: feature.id,
      kind: "parent_of",
      expectedProjectRevision: 4,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: feature.id,
      toRecordId: task.id,
      kind: "parent_of",
      expectedProjectRevision: 5,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: outcome.id,
      toRecordId: outsideScope.id,
      kind: "parent_of",
      expectedProjectRevision: 6,
    });
    const otherProject = application.service.createProject({ name: "Other" });
    const otherRecord = application.service.createRecord({
      projectId: otherProject.id,
      kind: "task",
      status: "active",
      title: "Private other task",
      body: "Must not cross the project boundary.",
      sourceKind: "human",
      sourceRef: null,
    });

    const mapSpy = vi.spyOn(application.service.projectMap, "getProjectMap");
    const map = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${task.id}&scopeRecordId=${feature.id}`,
    );
    expect(map.status).toBe(200);
    expect(await map.json()).toMatchObject({
      projectId: project.id,
      projectRevision: 7,
      selectedRecordId: task.id,
      scopeRecordId: feature.id,
      selectedPath: [{ id: outcome.id }, { id: feature.id }, { id: task.id }],
    });
    expect(mapSpy).toHaveBeenCalledWith(project.id, task.id, feature.id);
    mapSpy.mockRestore();

    for (const suffix of [
      `?focusRecordId=${task.id}&focusRecordId=${outcome.id}`,
      `?focusRecordId=${task.id}&scopeRecordId=${feature.id}&scopeRecordId=${outcome.id}`,
      `?scopeRecordId=${feature.id}`,
      "?future=private",
      `?focusRecordId=${"x".repeat(513)}`,
    ]) {
      const invalid = await fetch(`${origin}/api/projects/${project.id}/map${suffix}`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }

    const detail = await fetch(
      `${origin}/api/projects/${project.id}/records/${task.id}/connected-detail`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      projectId: project.id,
      projectRevision: 7,
      record: { id: task.id, projectId: project.id },
    });
    const crossProject = await fetch(
      `${origin}/api/projects/${project.id}/records/${otherRecord.id}/connected-detail`,
    );
    expect(crossProject.status).toBe(404);
    expect(await crossProject.json()).toEqual({
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
        recoverable: true,
      },
    });
    const crossProjectFocus = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${otherRecord.id}`,
    );
    expect(crossProjectFocus.status).toBe(400);
    expect(await crossProjectFocus.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "The request did not pass validation.",
        recoverable: true,
      },
    });
    const crossProjectScope = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${task.id}&scopeRecordId=${otherRecord.id}`,
    );
    expect(crossProjectScope.status).toBe(400);
    expect(await crossProjectScope.json()).toMatchObject({ error: { code: "invalid_request" } });
    const invalidScope = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${task.id}&scopeRecordId=${outsideScope.id}`,
    );
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toMatchObject({ error: { code: "invalid_request" } });
    const crossProjectNode = await fetch(
      `${origin}/api/projects/${project.id}/repository/nodes/repository-node-other/connected-detail`,
    );
    expect(crossProjectNode.status).toBe(404);
    expect(JSON.stringify(await crossProjectNode.json())).not.toContain("repository");

    for (const malformedPath of [
      `/api/projects/${"x".repeat(513)}/map`,
      `/api/projects/${project.id}/records/${"x".repeat(513)}/connected-detail`,
      `/api/projects/${project.id}/repository/nodes/${"x".repeat(513)}/connected-detail`,
      `/api/projects/${project.id}/records/%E0%A4%A/connected-detail`,
    ]) {
      const malformed = await fetch(`${origin}${malformedPath}`);
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("rejects document registries and details that escape their route identity", async () => {
    const foreignEntry = { ...documentEntry, projectId: "project-2" };
    installDocumentService({
      list: () => ({
        projectId: "project-2",
        snapshotId: foreignEntry.snapshotId,
        documents: [foreignEntry],
        facets: { documentKinds: [], formats: [], roles: [], freshness: [] },
      }),
      get: () => ({
        document: foreignEntry,
        linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
        nativeCapability: "renderable",
        externalOpenEligible: true,
      }),
    });
    const base = `${origin}/api/projects/project-1/documents`;

    expect((await fetch(base)).status).toBe(500);
    expect((await fetch(`${base}/repository-node-1`)).status).toBe(500);
  });

  it("fails closed when content and preview requests race from accepted snapshot A to B", async () => {
    let acceptedSnapshotId = "repository-snapshot-a";
    const observedExpectedSnapshots: string[] = [];
    installDocumentService({
      get: () => ({
        document: { ...documentEntry, snapshotId: acceptedSnapshotId },
        linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
        nativeCapability: "renderable",
        externalOpenEligible: true,
      }),
      read: (_projectId, _nodeId, expectedSnapshotId) => {
        observedExpectedSnapshots.push(expectedSnapshotId);
        return expectedSnapshotId === acceptedSnapshotId
          ? { status: "renderable", format: "markdown", text: "# Snapshot B", sha256: "a".repeat(64) }
          : { status: "stale" };
      },
      readPreview: (_projectId, _nodeId, expectedSnapshotId) => {
        observedExpectedSnapshots.push(expectedSnapshotId);
        return expectedSnapshotId === acceptedSnapshotId
          ? {
              status: "previewable",
              format: "image",
              mediaType: "image/png",
              bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
              sha256: "b".repeat(64),
            }
          : { status: "stale" };
      },
    });
    acceptedSnapshotId = "repository-snapshot-b";
    const base = `${origin}/api/projects/project-1/documents/repository-node-1`;

    expect((await fetch(`${base}/content?expectedSnapshotId=repository-snapshot-a`)).status)
      .toBe(409);
    expect((await fetch(`${base}/preview?expectedSnapshotId=repository-snapshot-a`)).status)
      .toBe(409);
    expect((await fetch(`${base}/content?expectedSnapshotId=repository-snapshot-b`)).status)
      .toBe(200);
    expect((await fetch(`${base}/preview?expectedSnapshotId=repository-snapshot-b`)).status)
      .toBe(200);
    expect(observedExpectedSnapshots).toEqual([
      "repository-snapshot-b",
      "repository-snapshot-b",
    ]);
  });

  it("updates only canonical hierarchy presets at the exact project revision", async () => {
    const project = application.service.createProject({ name: "Vocabulary project" });
    const software = {
      preset: "software",
      outcome: "Product outcome",
      initiative: "Epic",
      deliverable: "Feature",
      milestone: "Milestone",
      task: "Story or Task",
      nestedTask: "Subtask",
    };
    const simple = {
      preset: "simple",
      outcome: "Outcome",
      initiative: "Initiative",
      deliverable: "Deliverable",
      milestone: "Milestone",
      task: "Task",
      nestedTask: "Subtask",
    };
    const mapBefore = await fetch(`${origin}/api/projects/${project.id}/map`);
    expect(await mapBefore.json()).toMatchObject({
      projectId: project.id,
      projectName: "Vocabulary project",
      projectRevision: 0,
      hierarchyVocabulary: { preset: "neutral", task: "Work item" },
    });

    const updated = await fetch(
      `${origin}/api/projects/${project.id}/hierarchy-vocabulary`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedProjectRevision: 0, vocabulary: software }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      projectRevision: 1,
      hierarchyVocabulary: software,
    });

    const readState = () => {
      const connection = new Database(temporaryDatabase.path, { readonly: true });
      try {
        return {
          project: connection.prepare(
            "SELECT revision, hierarchy_vocabulary_json FROM projects WHERE id = ?",
          ).get(project.id),
          records: connection.prepare(
            "SELECT COUNT(*) AS count FROM project_records WHERE project_id = ?",
          ).get(project.id),
          relationships: connection.prepare(
            "SELECT COUNT(*) AS count FROM record_relationships WHERE project_id = ?",
          ).get(project.id),
          audits: connection.prepare(
            "SELECT action_category, revision_before, revision_after FROM audit_events WHERE project_id = ? ORDER BY rowid",
          ).all(project.id),
          proposals: connection.prepare(
            "SELECT COUNT(*) AS count FROM change_proposals WHERE project_id = ?",
          ).get(project.id),
        };
      } finally {
        connection.close();
      }
    };
    const authoritativeState = readState();

    const stale = await fetch(
      `${origin}/api/projects/${project.id}/hierarchy-vocabulary`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedProjectRevision: 0, vocabulary: simple }),
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "project_revision_conflict" },
    });

    for (const invalidVocabulary of [
      { ...software, task: "Custom task" },
      { ...software, preset: "neutral" },
      { ...software, future: "private" },
    ]) {
      const invalid = await fetch(
        `${origin}/api/projects/${project.id}/hierarchy-vocabulary`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedProjectRevision: 1,
            vocabulary: invalidVocabulary,
          }),
        },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(readState()).toEqual(authoritativeState);
  });

  it("exposes a strict request-bound Repository Explorer tree without private paths", async () => {
    const project = application.service.createProject({ name: "Explorer API" });
    const valid = {
      projectId: project.id,
      snapshotId: "repository-snapshot-1",
      parentNodeId: null,
      sourceStatus: "available" as const,
      request: {
        parentNodeId: null,
        pageSize: 2,
        filter: { category: "documentation" as const, changed: true },
      },
      items: [{
        nodeId: "repository-node-docs",
        parentNodeId: null,
        path: "docs",
        kind: "directory" as const,
        role: "supporting_document" as const,
        documentKind: null,
        documentFormat: null,
        sourceStatus: "derived" as const,
        state: "current" as const,
        contentEligible: false,
        childCount: 3,
        changed: true,
        linked: true,
        currentTaskRelevant: false,
        contextIncluded: false,
      }],
      exclusions: [{ reason: "ignored" as const, count: 2 }],
      hasMore: false,
      nextCursor: null,
    };
    const spy = vi.spyOn(application.service.projectMap, "getRepositoryTree")
      .mockReturnValue(valid);

    const response = await fetch(
      `${origin}/api/projects/${project.id}/repository/tree?pageSize=2&category=documentation&changed=true`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(valid);
    expect(spy).toHaveBeenCalledWith({
      projectId: project.id,
      pageSize: 2,
      filter: { category: "documentation", changed: true },
    });

    for (const suffix of [
      "?pageSize=1001",
      "?pageSize=2&pageSize=3",
      "?future=private",
      "?state=current&exclusionReason=ignored",
      `?parentNodeId=${encodeURIComponent("C:/private/repository")}`,
    ]) {
      const invalid = await fetch(
        `${origin}/api/projects/${project.id}/repository/tree${suffix}`,
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }

    for (const spoofed of [
      { ...valid, projectId: "project-foreign" },
      { ...valid, parentNodeId: "repository-node-foreign", request: { ...valid.request, parentNodeId: "repository-node-foreign" } },
      { ...valid, request: { ...valid.request, pageSize: 3 } },
      { ...valid, request: { ...valid.request, filter: {} } },
      { ...valid, request: { ...valid.request, contextPackId: "context-private" } },
      { ...valid, root: "C:/private/repository" },
    ]) {
      spy.mockReturnValue(spoofed as never);
      const rejected = await fetch(
        `${origin}/api/projects/${project.id}/repository/tree?pageSize=2&category=documentation&changed=true`,
      );
      expect(rejected.status).toBe(500);
      const text = await rejected.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
      expect(text).not.toContain("private");
      expect(text).not.toContain("project-foreign");
    }
  });

  it("closes invalid map-service responses without exposing repository or store details", async () => {
    const project = application.service.createProject({ name: "Closed map response" });
    const valid = application.service.projectMap.getProjectMap(project.id);
    vi.spyOn(application.service.projectMap, "getProjectMap").mockReturnValue({
      ...valid,
      root: "C:/private/repository",
      sql: "SELECT * FROM repository_nodes",
    } as never);

    const response = await fetch(`${origin}/api/projects/${project.id}/map`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        recoverable: false,
      },
    });
    expect(text).not.toContain("private");
    expect(text).not.toContain("repository_nodes");
    expect(text).not.toContain("api-routes.test");
  });

  it("returns a stable explicit bounded-data error for 10,001 hierarchy records", async () => {
    const project = application.service.createProject({ name: "Bounded map response" });
    const connection = new Database(temporaryDatabase.path);
    try {
      const insert = connection.prepare(`
        INSERT INTO project_records (
          id, project_id, kind, status, title, body, source_kind, source_ref,
          revision, created_at, updated_at
        ) VALUES (?, ?, 'outcome', 'active', ?, 'Bounded body', 'human', NULL, 1, ?, ?)
      `);
      const timestamp = "2026-08-25T00:00:00.000Z";
      connection.transaction(() => {
        for (let index = 0; index < 10_001; index += 1) {
          insert.run(
            `bounded-api-${index}`,
            project.id,
            `Bounded API ${index.toString().padStart(5, "0")}`,
            timestamp,
            timestamp,
          );
        }
      })();
    } finally {
      connection.close();
    }

    const response = await fetch(`${origin}/api/projects/${project.id}/map`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "project_map_limit_exceeded",
        message: "Project map supports at most 10,000 hierarchy records.",
        recoverable: true,
      },
    });
  });

  it("binds well-formed map and connected-detail DTOs to the requested resources", async () => {
    const project = application.service.createProject({ name: "Bound map responses" });
    const record = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Requested record",
      body: "Only this record may satisfy the route.",
      sourceKind: "human",
      sourceRef: null,
    });
    const validMap = application.service.projectMap.getProjectMap(project.id, record.id);
    const validRecord = application.service.projectMap.getRecordDetail(project.id, record.id);

    const mapSpy = vi.spyOn(application.service.projectMap, "getProjectMap")
      .mockReturnValue({ ...validMap, projectId: "project-foreign" });
    const foreignMap = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${record.id}`,
    );
    expect(foreignMap.status).toBe(500);
    expect(await foreignMap.json()).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        recoverable: false,
      },
    });
    mapSpy.mockRestore();

    const sameProjectFocusSpy = vi.spyOn(
      application.service.projectMap,
      "getProjectMap",
    );
    sameProjectFocusSpy.mockReturnValue({
      ...validMap,
      selectedRecordId: null,
      selectedPath: [],
    });
    const mismatchedFocus = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${record.id}`,
    );
    expect(mismatchedFocus.status).toBe(500);
    expect(await mismatchedFocus.json()).toMatchObject({ error: { code: "internal_error" } });
    sameProjectFocusSpy.mockRestore();

    const recordSpy = vi.spyOn(application.service.projectMap, "getRecordDetail");
    recordSpy.mockReturnValue({
      ...validRecord,
      projectId: "project-foreign",
      record: { ...validRecord.record, projectId: "project-foreign" },
    });
    const foreignRecord = await fetch(
      `${origin}/api/projects/${project.id}/records/${record.id}/connected-detail`,
    );
    expect(foreignRecord.status).toBe(500);
    expect(JSON.stringify(await foreignRecord.json())).not.toContain("project-foreign");

    recordSpy.mockReturnValue({
      ...validRecord,
      record: { ...validRecord.record, id: "record-foreign" },
    });
    const wrongRecord = await fetch(
      `${origin}/api/projects/${project.id}/records/${record.id}/connected-detail`,
    );
    expect(wrongRecord.status).toBe(500);
    expect(JSON.stringify(await wrongRecord.json())).not.toContain("record-foreign");
    recordSpy.mockRestore();

    const repositorySpy = vi.spyOn(
      application.service.projectMap,
      "getRepositoryNodeDetail",
    );
    const repositoryDetail = {
      projectId: project.id,
      snapshotId: "repository-snapshot-1",
      node: {
        nodeId: "repository-node-foreign",
        parentNodeId: null,
        path: "docs/overview.md",
        kind: "file" as const,
        role: "supporting_document" as const,
        documentKind: "overview" as const,
        documentFormat: "markdown" as const,
        contentEligible: true,
      },
      linksByBasis: {
        accepted: [], observed: [], inferred: [], conflicting: [],
      },
    };
    repositorySpy.mockReturnValue(repositoryDetail);
    const wrongNode = await fetch(
      `${origin}/api/projects/${project.id}/repository/nodes/repository-node-1/connected-detail`,
    );
    expect(wrongNode.status).toBe(500);
    expect(JSON.stringify(await wrongNode.json())).not.toContain("repository-node-foreign");

    repositorySpy.mockReturnValue({ ...repositoryDetail, projectId: "project-foreign" });
    const foreignNodeProject = await fetch(
      `${origin}/api/projects/${project.id}/repository/nodes/repository-node-1/connected-detail`,
    );
    expect(foreignNodeProject.status).toBe(500);
    expect(JSON.stringify(await foreignNodeProject.json())).not.toContain("project-foreign");
  });

  it("rejects a map selection outside the hierarchy", async () => {
    const project = application.service.createProject({ name: "Non-spine map focus" });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Non-spine decision",
      body: "A valid focus resource outside the hierarchy.",
      sourceKind: "human",
      sourceRef: null,
    });

    const response = await fetch(
      `${origin}/api/projects/${project.id}/map?focusRecordId=${decision.id}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "The request did not pass validation.",
        recoverable: true,
      },
    });
  });

  it("binds curation DTOs and revisions to the exact create and remove requests", async () => {
    const project = application.service.createProject({ name: "Bound curation responses" });
    const outcome = application.service.createRecord({
      projectId: project.id,
      kind: "outcome",
      status: "active",
      title: "Outcome",
      body: "Requested relationship source.",
      sourceKind: "human",
      sourceRef: null,
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Task",
      body: "Requested relationship target.",
      sourceKind: "human",
      sourceRef: null,
    });
    const other = application.service.createRecord({
      projectId: project.id,
      kind: "milestone",
      status: "active",
      title: "Other",
      body: "A valid but unrequested endpoint.",
      sourceKind: "human",
      sourceRef: null,
    });
    const expectedProjectRevision = 3;
    const summary = application.service.getProjectSummary(project.id);
    const summarySpy = vi.spyOn(application.service, "getProjectSummary")
      .mockReturnValue({
        ...summary,
        project: { ...summary.project, revision: expectedProjectRevision + 1 },
      });
    const relationship = {
      id: "relationship-reviewed",
      projectId: project.id,
      fromRecordId: outcome.id,
      toRecordId: task.id,
      kind: "parent_of" as const,
      createdAt: "2026-08-03T00:00:00.000Z",
    };
    const createSpy = vi.spyOn(application.service, "createRelationship");
    const createCases = [
      { ...relationship, projectId: "project-foreign" },
      { ...relationship, fromRecordId: other.id },
      { ...relationship, toRecordId: other.id },
      { ...relationship, kind: "related_to" as const },
    ];
    for (const returnedRelationship of createCases) {
      createSpy.mockReturnValue(returnedRelationship);
      const response = await fetch(
        `${origin}/api/projects/${project.id}/relationships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromRecordId: outcome.id,
            toRecordId: task.id,
            kind: "parent_of",
            expectedProjectRevision,
          }),
        },
      );
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
      expect(text).not.toContain(returnedRelationship.projectId === project.id
        ? "relationship-reviewed"
        : "project-foreign");
    }

    createSpy.mockReturnValue(relationship);
    for (const revision of [expectedProjectRevision, expectedProjectRevision + 2]) {
      summarySpy.mockReturnValue({
        ...summary,
        project: { ...summary.project, revision },
      });
      const response = await fetch(
        `${origin}/api/projects/${project.id}/relationships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromRecordId: outcome.id,
            toRecordId: task.id,
            kind: "parent_of",
            expectedProjectRevision,
          }),
        },
      );
      expect(response.status).toBe(500);
    }

    const removeSpy = vi.spyOn(application.service, "removeRelationship");
    summarySpy.mockReturnValue({
      ...summary,
      project: { ...summary.project, revision: expectedProjectRevision + 1 },
    });
    for (const returnedRelationship of [
      { ...relationship, projectId: "project-foreign" },
      { ...relationship, id: "relationship-foreign" },
    ]) {
      removeSpy.mockReturnValue(returnedRelationship);
      const response = await fetch(
        `${origin}/api/projects/${project.id}/relationships/${relationship.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedProjectRevision }),
        },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    }

    removeSpy.mockReturnValue(relationship);
    for (const revision of [expectedProjectRevision, expectedProjectRevision + 2]) {
      summarySpy.mockReturnValue({
        ...summary,
        project: { ...summary.project, revision },
      });
      const response = await fetch(
        `${origin}/api/projects/${project.id}/relationships/${relationship.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedProjectRevision }),
        },
      );
      expect(response.status).toBe(500);
    }
  });

  it("creates and removes authoritative relationships at exact project revisions", async () => {
    const project = application.service.createProject({ name: "Curated map" });
    const outcome = application.service.createRecord({
      projectId: project.id,
      kind: "outcome",
      status: "active",
      title: "Outcome",
      body: "Authoritative parent.",
      sourceKind: "human",
      sourceRef: null,
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Task",
      body: "Authoritative child.",
      sourceKind: "human",
      sourceRef: null,
    });
    const createSpy = vi.spyOn(application.service, "createRelationship");

    const rejectedLayout = await fetch(
      `${origin}/api/projects/${project.id}/relationships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromRecordId: outcome.id,
          toRecordId: task.id,
          kind: "parent_of",
          expectedProjectRevision: 2,
          x: 120,
          label: "private edge",
        }),
      },
    );
    expect(rejectedLayout.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();

    const created = await fetch(
      `${origin}/api/projects/${project.id}/relationships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromRecordId: outcome.id,
          toRecordId: task.id,
          kind: "parent_of",
          expectedProjectRevision: 2,
        }),
      },
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json() as {
      projectRevision: number;
      relationship: { id: string; projectId: string };
    };
    expect(createdBody).toMatchObject({
      projectRevision: 3,
      relationship: {
        projectId: project.id,
        fromRecordId: outcome.id,
        toRecordId: task.id,
        kind: "parent_of",
      },
    });
    expect(createSpy).toHaveBeenLastCalledWith({
      projectId: project.id,
      fromRecordId: outcome.id,
      toRecordId: task.id,
      kind: "parent_of",
      expectedProjectRevision: 2,
    });

    const staleCreate = await fetch(
      `${origin}/api/projects/${project.id}/relationships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromRecordId: task.id,
          toRecordId: outcome.id,
          kind: "parent_of",
          expectedProjectRevision: 2,
        }),
      },
    );
    expect(staleCreate.status).toBe(409);
    expect(await staleCreate.json()).toMatchObject({
      error: { code: "project_revision_conflict" },
    });

    const ordinarySelfLink = await fetch(
      `${origin}/api/projects/${project.id}/relationships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromRecordId: task.id,
          toRecordId: task.id,
          kind: "related_to",
          expectedProjectRevision: 3,
        }),
      },
    );
    expect(ordinarySelfLink.status).toBe(400);
    expect(await ordinarySelfLink.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const removeSpy = vi.spyOn(application.service, "removeRelationship");
    const removed = await fetch(
      `${origin}/api/projects/${project.id}/relationships/${createdBody.relationship.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedProjectRevision: 3 }),
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      projectRevision: 4,
      relationship: expect.objectContaining({
        id: createdBody.relationship.id,
        projectId: project.id,
      }),
    });
    expect(removeSpy).toHaveBeenCalledWith({
      projectId: project.id,
      relationshipId: createdBody.relationship.id,
      expectedProjectRevision: 3,
    });
  });

  it("maps hierarchy curation failures to stable closed API errors", async () => {
    const project = application.service.createProject({ name: "Hierarchy errors" });
    const outcome = application.service.createRecord({
      projectId: project.id,
      kind: "outcome",
      status: "active",
      title: "Outcome",
      body: "Root.",
      sourceKind: "human",
      sourceRef: null,
    });
    const milestone = application.service.createRecord({
      projectId: project.id,
      kind: "milestone",
      status: "active",
      title: "Milestone",
      body: "Middle.",
      sourceKind: "human",
      sourceRef: null,
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Task",
      body: "Leaf.",
      sourceKind: "human",
      sourceRef: null,
    });
    const evidence = application.service.createRecord({
      projectId: project.id,
      kind: "evidence",
      status: "accepted",
      title: "Evidence",
      body: "Cannot parent hierarchy.",
      sourceKind: "human",
      sourceRef: null,
    });
    const cycleParent = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Cycle parent",
      body: "A valid task root for cycle testing.",
      sourceKind: "human",
      sourceRef: null,
    });
    const cycleChild = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Cycle child",
      body: "A valid nested task for cycle testing.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: outcome.id,
      toRecordId: milestone.id,
      kind: "parent_of",
      expectedProjectRevision: 6,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: milestone.id,
      toRecordId: task.id,
      kind: "parent_of",
      expectedProjectRevision: 7,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: cycleParent.id,
      toRecordId: cycleChild.id,
      kind: "parent_of",
      expectedProjectRevision: 8,
    });
    const otherProject = application.service.createProject({ name: "Isolated" });
    const otherTask = application.service.createRecord({
      projectId: otherProject.id,
      kind: "task",
      status: "active",
      title: "Other task",
      body: "Must remain private to its project.",
      sourceKind: "human",
      sourceRef: null,
    });

    const crossProject = await fetch(
      `${origin}/api/projects/${project.id}/relationships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromRecordId: outcome.id,
          toRecordId: otherTask.id,
          kind: "related_to",
          expectedProjectRevision: 9,
        }),
      },
    );
    expect(crossProject.status).toBe(404);
    expect(await crossProject.json()).toEqual({
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
        recoverable: true,
      },
    });

    const cases = [
      {
        fromRecordId: cycleChild.id,
        toRecordId: cycleParent.id,
        expectedProjectRevision: 9,
        code: "hierarchy_cycle",
      },
      {
        fromRecordId: outcome.id,
        toRecordId: task.id,
        expectedProjectRevision: 9,
        code: "hierarchy_multiple_parents",
      },
      {
        fromRecordId: evidence.id,
        toRecordId: task.id,
        expectedProjectRevision: 9,
        code: "hierarchy_parent_kind_invalid",
      },
    ];
    for (const entry of cases) {
      const response = await fetch(
        `${origin}/api/projects/${project.id}/relationships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromRecordId: entry.fromRecordId,
            toRecordId: entry.toRecordId,
            kind: "parent_of",
            expectedProjectRevision: entry.expectedProjectRevision,
          }),
        },
      );
      expect(response.status, entry.code).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: entry.code,
          message: "The requested hierarchy change conflicts with the current project map.",
          recoverable: true,
        },
      });
    }
    expect(application.service.getProjectSummary(project.id).project.revision).toBe(9);
  });

  it("streams one reviewed refresh and enforces strict ID-only refresh mutations", async () => {
    const view = {
      review: {
        projectId: "project-1",
        sourceId: "repository-source-1",
        snapshotId: "repository-snapshot-1",
        state: "pending" as const,
        selectedOperationIds: [],
        createdAt: "2026-08-02T12:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z",
        decidedAt: null,
      },
      snapshot: {
        id: "repository-snapshot-1",
        sourceId: "repository-source-1",
        projectId: "project-1",
        state: "candidate" as const,
        baseSnapshotId: null,
        baseProjectRevision: 0,
        branch: "main",
        head: "a".repeat(40),
        fingerprint: "b".repeat(64),
        scannerVersion: "scanner-1",
        rulesetVersion: "rules-1",
        warningCounts: {},
        exclusionCounts: {
          ignored: 2,
          known_secret_path: 1,
          "C:/private/.env": 9,
        },
        findingCounts: {},
        createdAt: "2026-08-02T12:00:00.000Z",
        decidedAt: null,
        appliedAt: null,
      },
      diff: {
        groups: [{
          kind: "added" as const,
          entries: [{
            operationId: "repository-diff-1",
            kind: "added" as const,
            previousNodeId: null,
            currentNodeId: "repository-node-1",
            previousPath: null,
            currentPath: "docs/overview.md",
          }],
        }],
        semanticOperations: [],
      },
    };
    const refresh = {
      attach: vi.fn(async (_projectId, { onProgress }) => {
        onProgress({ phase: "discovering", processed: 0, total: 1 });
        return view;
      }),
      start: vi.fn(async (_projectId, { onProgress }) => {
        onProgress({ phase: "discovering", processed: 0, total: 2 });
        onProgress({ phase: "finalizing", processed: 2, total: 2 });
        return view;
      }),
      get: vi.fn(() => view),
      sourceStatus: vi.fn(() => "unavailable" as const),
      updateSelection: vi.fn(() => view),
      cancel: vi.fn(() => ({
        ...view,
        review: { ...view.review, state: "cancelled" as const },
      })),
      apply: vi.fn(async () => ({
        snapshotId: "repository-snapshot-1",
        projectRevision: 0,
        proposalId: null,
        replayed: false,
      })),
      retry: vi.fn(async () => view),
      locate: vi.fn(async () => ({ projectRevision: 1, requiresRefresh: true as const })),
      detach: vi.fn(() => ({ projectRevision: 1, requiresRefresh: true as const })),
    };
    Object.assign(application.service, { repositoryRefresh: refresh });
    const base = `${origin}/api/projects/project-1/repository-refresh`;

    const resumed = await fetch(base);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      review: { snapshotId: "repository-snapshot-1" },
      sourceStatus: "unavailable",
    });

    const started = await fetch(`${origin}/api/projects/project-1/repository-refreshes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(started.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    const events = (await started.text()).trim().split("\n").map(JSON.parse);
    expect(events.map(({ type }) => type)).toEqual(["progress", "progress", "review"]);
    expect(events.at(-1)).toMatchObject({
      review: {
        snapshotId: "repository-snapshot-1",
        exclusionCounts: { ignored: 2, known_secret_path: 1 },
        diff: view.diff,
      },
    });
    expect(JSON.stringify(events)).not.toContain("repository-source-1");
    expect(JSON.stringify(events)).not.toContain(".env");
    expect(JSON.stringify(events)).not.toMatch(/[a-f0-9]{64}/);
    expect(JSON.stringify(events)).not.toContain("fingerprint");

    const attached = await fetch(
      `${origin}/api/projects/project-1/repository-source/attach`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: "C:/selected/repository",
          expectedProjectRevision: 0,
        }),
      },
    );
    expect(attached.status).toBe(200);
    expect((await attached.text()).trim().split("\n").map(JSON.parse))
      .toMatchObject([
        { type: "progress", progress: { phase: "discovering" } },
        { type: "review", review: { projectId: "project-1" } },
      ]);
    expect(refresh.attach).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        root: "C:/selected/repository",
        expectedProjectRevision: 0,
        signal: expect.any(AbortSignal),
      }),
    );

    const mismatch = await fetch(`${base}/repository-snapshot-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "other-project",
        snapshotId: "repository-snapshot-1",
        selectedOperationIds: [],
      }),
    });
    expect(mismatch.status).toBe(400);
    expect(refresh.updateSelection).not.toHaveBeenCalled();

    const apply = await fetch(`${base}/repository-snapshot-1/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        snapshotId: "repository-snapshot-1",
        expectedProjectRevision: 0,
      }),
    });
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ proposalId: null, replayed: false });

    const invalidDetach = await fetch(`${origin}/api/projects/project-1/repository-source/detach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: false, expectedProjectRevision: 0 }),
    });
    expect(invalidDetach.status).toBe(400);
    expect(refresh.detach).not.toHaveBeenCalled();

    const wrongContentType = await fetch(
      `${origin}/api/projects/project-1/repository-refreshes`,
      { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" },
    );
    expect(wrongContentType.status).toBe(415);
    expect(refresh.start).toHaveBeenCalledTimes(1);
  });

  it("aborts one in-flight refresh when the NDJSON client disconnects", async () => {
    let scannerSignal: AbortSignal | undefined;
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    Object.assign(application.service, {
      repositoryRefresh: {
        ...application.service.repositoryRefresh,
        start: vi.fn(async (_projectId, { signal, onProgress }) => {
          scannerSignal = signal;
          onProgress({ phase: "discovering", processed: 0, total: 1 });
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              observedAbort();
              reject(signal.reason);
            }, { once: true });
          });
        }),
      },
    });
    const controller = new AbortController();
    const response = await fetch(
      `${origin}/api/projects/project-1/repository-refreshes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    controller.abort();
    const didAbort = await Promise.race([
      aborted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(didAbort).toBe(true);
    expect(scannerSignal?.aborted).toBe(true);
  });

  it("drains queued progress writes before propagating a cancelled refresh", async () => {
    const cancelled = new DOMException("Client disconnected", "AbortError");
    Object.assign(application.service, {
      repositoryRefresh: {
        ...application.service.repositoryRefresh,
        start: vi.fn(async (_projectId, { onProgress }) => {
          onProgress({ phase: "discovering", processed: 0, total: 1 });
          throw cancelled;
        }),
      },
    });
    const route = createApplicationRoutes(application).find(({ pattern }) =>
      pattern.test("/api/projects/project-1/repository-refreshes")
    )!;
    route.pattern.lastIndex = 0;
    const result = route.handle({
      match: route.pattern.exec("/api/projects/project-1/repository-refreshes")!,
      body: {},
      url: new URL(`${origin}/api/projects/project-1/repository-refreshes`),
      headers: {},
      signal: new AbortController().signal,
    });
    expect(result).toBeInstanceOf(ApiNdjsonResponse);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    let settled = false;
    const running = (result as ApiNdjsonResponse).run({
      signal: new AbortController().signal,
      write: async () => {
        writeStarted.resolve();
        await releaseWrite.promise;
      },
    }).finally(() => {
      settled = true;
    });
    await writeStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseWrite.resolve();
    await expect(running).rejects.toBe(cancelled);
  });

  it("returns a sanitized JSON error when a refresh fails before streaming begins", async () => {
    Object.assign(application.service, {
      repositoryRefresh: {
        ...application.service.repositoryRefresh,
        start: vi.fn(async () => {
          throw new RepositoryRefreshUnavailableError(
            "C:/private/repository/project-1",
          );
        }),
      },
    });

    const response = await fetch(
      `${origin}/api/projects/project-1/repository-refreshes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const text = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "repository_unavailable" },
    });
    expect(text).not.toContain("C:/private/repository");
    expect(text).not.toContain("stack");
  });

  it("defers retry revision validation until the stream actually starts", async () => {
    const project = application.service.createProject({
      name: "Deferred retry",
      primaryRepositoryPath: "C:/projects/example",
    });
    const retry = vi.fn(async (_projectId: string, expectedRevision: number) => {
      if (application.service.getProjectSummary(project.id).project.revision !== expectedRevision) {
        throw new Error("stale deferred revision");
      }
      throw new Error("unexpected retry success");
    });
    Object.assign(application.service, {
      repositoryRefresh: { ...application.service.repositoryRefresh, retry },
    });
    const url = new URL(
      `${origin}/api/projects/${project.id}/repository-source/retry`,
    );
    const route = createApplicationRoutes(application).find(({ method, pattern }) => {
      pattern.lastIndex = 0;
      return method === "POST" && pattern.test(url.pathname);
    })!;
    route.pattern.lastIndex = 0;
    const match = route.pattern.exec(url.pathname)!;
    const deferred = route.handle({
      match,
      body: { expectedProjectRevision: 0 },
      url,
      headers: {},
      signal: new AbortController().signal,
    });
    expect(deferred).toBeInstanceOf(ApiNdjsonResponse);
    expect(retry).not.toHaveBeenCalled();
    application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Advance before stream",
      body: "Invalidate the deferred retry revision.",
      sourceKind: "human",
      sourceRef: null,
    });

    await expect((deferred as ApiNdjsonResponse).run({
      signal: new AbortController().signal,
      write: async () => undefined,
    })).rejects.toThrow("stale deferred revision");
    expect(retry).toHaveBeenCalledWith(
      project.id,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts locate through the request lifecycle signal on disconnect", async () => {
    let started!: () => void;
    const locateStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let locateSignal: AbortSignal | undefined;
    const locate = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      locateSignal = signal;
      started();
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      return { projectRevision: 1, requiresRefresh: true as const };
    });
    Object.assign(application.service, {
      repositoryRefresh: { ...application.service.repositoryRefresh, locate },
    });
    const controller = new AbortController();
    const pending = fetch(
      `${origin}/api/projects/project-1/repository-source/locate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: "C:/selected/repository",
          expectedProjectRevision: 0,
        }),
        signal: controller.signal,
      },
    );
    await locateStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locateSignal?.aborted).toBe(true);
  });

  it("rejects oversized refresh project and snapshot path identifiers", async () => {
    const refresh = {
      ...application.service.repositoryRefresh,
      start: vi.fn(),
      get: vi.fn(),
      attach: vi.fn(),
      retry: vi.fn(),
      locate: vi.fn(),
      detach: vi.fn(),
    };
    Object.assign(application.service, { repositoryRefresh: refresh });
    const oversized = "x".repeat(513);
    const requests: Array<[string, RequestInit | undefined]> = [
      [`${origin}/api/projects/${oversized}/repository-refreshes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }],
      [`${origin}/api/projects/${oversized}/repository-refresh`, undefined],
      [`${origin}/api/projects/${oversized}/repository-source/attach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: "C:/selected/repository",
          expectedProjectRevision: 0,
        }),
      }],
      [`${origin}/api/projects/${oversized}/repository-source/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedProjectRevision: 0 }),
      }],
      [`${origin}/api/projects/${oversized}/repository-source/locate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: "C:/selected/repository",
          expectedProjectRevision: 0,
        }),
      }],
      [`${origin}/api/projects/${oversized}/repository-source/detach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true, expectedProjectRevision: 0 }),
      }],
      [`${origin}/api/projects/project-1/repository-refresh/${oversized}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-1",
          snapshotId: oversized,
          expectedProjectRevision: 0,
        }),
      }],
    ];
    for (const [url, init] of requests) {
      expect((await fetch(url, init)).status, url).toBe(400);
    }
    for (const operation of [
      refresh.start,
      refresh.get,
      refresh.attach,
      refresh.retry,
      refresh.locate,
      refresh.detach,
    ]) expect(operation).not.toHaveBeenCalled();
  });

  it("serves only revalidated allow-listed preview bytes with exact headers", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    installDocumentService({
      readPreview: () => ({
        status: "previewable",
        format: "image",
        mediaType: "image/png",
        bytes: png,
        sha256: "b".repeat(64),
      }),
    });

    const response = await fetch(
      `${origin}/api/projects/project-1/documents/repository-node-1/preview?expectedSnapshotId=repository-snapshot-1`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("rejects unsafe document requests with closed root-free recoverable errors", async () => {
    const privateRoot = "C:\\private\\customer-repository";
    installDocumentService({
      get: (_projectId, nodeId) => {
        if (nodeId === "cross-project-node") {
          throw new DocumentNotFoundError(`${nodeId}:${privateRoot}`);
        }
        return {
          document: { ...documentEntry, nodeId },
          linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
          nativeCapability: "renderable",
          externalOpenEligible: true,
        };
      },
      read: (_projectId, nodeId) => nodeId === "stale-node"
        ? { status: "stale" }
        : nodeId === "missing-node"
          ? { status: "missing" }
        : nodeId === "unavailable-node"
          ? { status: "unavailable" }
          : nodeId === "blocked-node"
            ? { status: "blocked" }
            : { status: "unsupported", format: "unsupported" },
      readPreview: () => ({ status: "stale" }),
    });
    const base = `${origin}/api/projects/project-1/documents`;

    const cases: Array<[string, RequestInit | undefined, number, string]> = [
      [`${base}?futureFilter=${encodeURIComponent(privateRoot)}`, undefined, 400, "invalid_request"],
      [`${base}?format=html`, undefined, 400, "invalid_request"],
      [`${base}/cross-project-node`, undefined, 404, "document_not_found"],
      [`${base}/repository-node-1/content`, undefined, 400, "invalid_request"],
      [`${base}/repository-node-1/preview`, undefined, 400, "invalid_request"],
      [`${base}/stale-node/content?expectedSnapshotId=repository-snapshot-1`, undefined, 409, "document_stale"],
      [`${base}/missing-node/content?expectedSnapshotId=repository-snapshot-1`, undefined, 404, "document_missing"],
      [`${base}/unavailable-node/content?expectedSnapshotId=repository-snapshot-1`, undefined, 409, "repository_unavailable"],
      [`${base}/blocked-node/content?expectedSnapshotId=repository-snapshot-1`, undefined, 403, "document_blocked"],
      [`${base}/unsupported-node/content?expectedSnapshotId=repository-snapshot-1`, undefined, 415, "document_unsupported"],
      [`${base}/repository-node-1/preview`, { headers: { range: "bytes=0-1" } }, 416, "range_not_supported"],
      [`${base}/repository-node-1/preview?download=1`, undefined, 400, "invalid_request"],
      [`${base}/repository-node-1`, { method: "POST" }, 404, "not_found"],
    ];

    for (const [url, init, status, code] of cases) {
      const response = await fetch(url, init);
      const text = await response.text();
      expect(response.status, url).toBe(status);
      expect(JSON.parse(text)).toMatchObject({
        error: { code, recoverable: true },
      });
      expect(text).not.toContain(privateRoot);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
      );
    }
  });

  it("rejects preview media that does not match its reviewed format", async () => {
    installDocumentService({
      readPreview: () => ({
        status: "previewable",
        format: "pdf",
        mediaType: "image/png",
        bytes: Uint8Array.of(1, 2, 3),
        sha256: "c".repeat(64),
      }),
    });

    const response = await fetch(
      `${origin}/api/projects/project-1/documents/repository-node-1/preview?expectedSnapshotId=repository-snapshot-1`,
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "document_media_mismatch", recoverable: true },
    });
  });

  it("lists project hub views through the application view service", async () => {
    application.service.createProject({ name: "Visual foundation" });

    const response = await fetch(`${origin}/api/projects`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projects: [{
        project: {
          id: "project-1",
          name: "Visual foundation",
        },
        pendingProposalCount: 0,
      }],
    });
  });

  it("creates a project after translating a null repository path to omission", async () => {
    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "  Local web  ",
        primaryRepositoryPath: null,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project: {
        id: "project-1",
        name: "Local web",
        primaryRepositoryPath: null,
      },
    });
    expect(application.service.listProjects()).toHaveLength(1);
  });

  it("returns safe validation errors for invalid create-project input", async () => {
    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "",
        primaryRepositoryPath: "relative/private.sqlite",
        token: "must-not-be-returned",
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('"code":"invalid_request"');
    expect(body).not.toContain("relative/private.sqlite");
    expect(body).not.toContain("must-not-be-returned");
  });

  it("returns decoded project dashboard and task handoff views", async () => {
    const project = application.service.createProject({ name: "Route params" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Serve handoff",
      body: "Use decoded path parameters.",
      sourceKind: "human",
      sourceRef: null,
    });

    const dashboardResponse = await fetch(
      `${origin}/api/projects/${encodeURIComponent(project.id)}/dashboard`,
    );
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.json()).toMatchObject({
      project: { id: project.id },
      currentTask: { id: task.id },
      hierarchyVocabulary: { preset: "neutral", task: "Work item" },
      hierarchyParentContexts: [{ recordId: task.id, parentKind: null }],
    });

    const handoffResponse = await fetch(
      `${origin}/api/projects/${encodeURIComponent(project.id)}` +
      `/tasks/${encodeURIComponent(task.id)}/handoff`,
    );
    expect(handoffResponse.status).toBe(200);
    expect(await handoffResponse.json()).toMatchObject({
      project: { id: project.id },
      task: { id: task.id },
      profiles: [],
    });
  });

  it("fails closed when the dashboard service returns an unbound or malformed response", () => {
    const project = application.service.createProject({ name: "Strict dashboard" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Keep dashboard data bound",
      body: "Reject invalid service output at the route boundary.",
      sourceKind: "human",
      sourceRef: null,
    });
    const evidence = application.service.createRecord({
      projectId: project.id,
      kind: "evidence",
      status: "accepted",
      title: "Strict dashboard proof",
      body: "Keep non-hierarchy records out of hierarchy context.",
      sourceKind: "human",
      sourceRef: null,
    });
    const valid = application.service.views.getDashboard(project.id);
    const url = new URL(`${origin}/api/projects/${project.id}/dashboard`);
    const route = createApplicationRoutes(application).find(({ method, pattern }) => {
      pattern.lastIndex = 0;
      return method === "GET" && pattern.test(url.pathname);
    })!;
    const invoke = (response: unknown) => {
      Object.assign(application.service.views, {
        getDashboard: () => response,
      });
      route.pattern.lastIndex = 0;
      return route.handle({
        match: route.pattern.exec(url.pathname)!,
        body: null,
        url,
        headers: {},
        signal: new AbortController().signal,
      });
    };

    for (const unsafe of [
      { ...valid, project: { ...valid.project, id: "foreign-project" } },
      { ...valid, currentTask: { ...task, projectId: "foreign-project" } },
      { ...valid, recentRecords: [{ ...task, projectId: "foreign-project" }] },
      { ...valid, currentFocusPath: [{ ...valid.currentFocusPath[0], projectId: "foreign-project" }] },
      { ...valid, hierarchyVocabulary: { ...valid.hierarchyVocabulary, nestedTask: "" } },
      { ...valid, hierarchyParentContexts: [] },
      { ...valid, hierarchyParentContexts: [...valid.hierarchyParentContexts, ...valid.hierarchyParentContexts] },
      { ...valid, hierarchyParentContexts: [...valid.hierarchyParentContexts, { recordId: "unknown-record", parentKind: null }] },
      { ...valid, hierarchyParentContexts: [...valid.hierarchyParentContexts, { recordId: evidence.id, parentKind: null }] },
      { ...valid, hierarchyParentContexts: valid.hierarchyParentContexts.map((entry) => ({ ...entry, parentKind: "evidence" })) },
    ]) {
      expect(() => invoke(unsafe)).toThrow(ApiRouteError);
    }
  });

  it("lists and reads proposal DTOs without exposing stored request hashes", async () => {
    const project = application.service.createProject({
      name: "Governed review",
    });
    const createdProfile = application.service.profiles.createProfile({
      name: "Safe foundation",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const submission = application.service.submitChangeSet(principal, {
      projectId: project.id,
      baseProjectRevision: project.revision,
      idempotencyKey: "route-proposal",
      rationale: "Add a governed task after human review.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-review-task",
        type: "create_record",
        localRef: "review-task",
        kind: "task",
        status: "provisional",
        title: "Review proposal routes",
        body: "Keep the stored request hash beyond the browser boundary.",
      }],
    });
    if (submission.outcome !== "proposed") {
      throw new Error("Proposal route fixture was not proposed");
    }

    const listResponse = await fetch(
      `${origin}/api/projects/${encodeURIComponent(project.id)}` +
      "/proposals?state=pending",
    );
    const listText = await listResponse.text();

    expect(listResponse.status).toBe(200);
    expect(JSON.parse(listText)).toEqual({
      proposals: [{
        id: submission.proposalId,
        projectId: project.id,
        origin: {
          type: "profile",
          profileId: createdProfile.profile.id,
        },
        sourceTaskId: null,
        predecessorProposalId: null,
        baseProjectRevision: 0,
        state: "pending",
        rationale: "Add a governed task after human review.",
        idempotencyKey: "route-proposal",
        reviewReason: null,
        reviewerActor: null,
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        reviewedAt: null,
      }],
    });
    expect(listText).not.toContain("requestHash");

    const detailResponse = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(submission.proposalId)}`,
    );
    const detailText = await detailResponse.text();

    expect(detailResponse.status).toBe(200);
    expect(JSON.parse(detailText)).toMatchObject({
      proposal: {
        id: submission.proposalId,
        state: "pending",
        operations: [{
          operationId: "create-review-task",
          type: "create_record",
          localRef: "review-task",
          kind: "task",
          status: "provisional",
          title: "Review proposal routes",
          body: "Keep the stored request hash beyond the browser boundary.",
        }],
      },
    });
    expect(detailText).not.toContain("requestHash");
  });

  it("rejects duplicate and unknown proposal list query parameters", async () => {
    const project = application.service.createProject({
      name: "Strict proposal query",
    });

    for (const query of [
      "state=pending&state=accepted",
      "state=pending&futureFilter=unreviewed",
    ]) {
      const response = await fetch(
        `${origin}/api/projects/${encodeURIComponent(project.id)}` +
        `/proposals?${query}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The request did not pass validation.",
          recoverable: true,
        },
      });
    }
  });

  it("rejects an accept request body without deciding the proposal", async () => {
    const project = application.service.createProject({
      name: "Bodyless proposal acceptance",
    });
    const createdProfile = application.service.profiles.createProfile({
      name: "Strict reviewer",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const submission = application.service.submitChangeSet(principal, {
      projectId: project.id,
      baseProjectRevision: project.revision,
      idempotencyKey: "strict-accept-body",
      rationale: "Only a bodyless acceptance may decide this proposal.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-bodyless-task",
        type: "create_record",
        kind: "task",
        status: "provisional",
        title: "Bodyless acceptance",
        body: "Unexpected request fields must not be ignored.",
      }],
    });
    if (submission.outcome !== "proposed") {
      throw new Error("Proposal route fixture was not proposed");
    }

    const response = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(submission.proposalId)}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(application.service.proposals.get(submission.proposalId).state).toBe(
      "pending",
    );
    expect(application.service.getProjectSummary(project.id).project.revision)
      .toBe(0);
  });

  it("accepts and rejects pending proposals with strict review input", async () => {
    const project = application.service.createProject({
      name: "Proposal decisions",
    });
    const createdProfile = application.service.profiles.createProfile({
      name: "Governed client",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const propose = (idempotencyKey: string, title: string) => {
      const result = application.service.submitChangeSet(principal, {
        projectId: project.id,
        baseProjectRevision:
          application.service.getProjectSummary(project.id).project.revision,
        idempotencyKey,
        rationale: `Review ${title}.`,
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: `create-${idempotencyKey}`,
          type: "create_record" as const,
          kind: "task" as const,
          status: "provisional" as const,
          title,
          body: "A human makes the governance decision.",
        }],
      });
      if (result.outcome !== "proposed") {
        throw new Error("Proposal route fixture was not proposed");
      }
      return result.proposalId;
    };
    const acceptedProposalId = propose("accept-route", "Accepted route");

    const acceptedResponse = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(acceptedProposalId)}/accept`,
      { method: "POST" },
    );

    expect(acceptedResponse.status).toBe(200);
    expect(await acceptedResponse.json()).toMatchObject({
      outcome: "applied",
      projectRevision: 1,
      proposal: {
        id: acceptedProposalId,
        state: "accepted",
      },
    });

    const rejectedProposalId = propose("reject-route", "Rejected route");
    const invalidResponse = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(rejectedProposalId)}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: " ", extra: "not allowed" }),
      },
    );
    expect(invalidResponse.status).toBe(400);

    const rejectedResponse = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(rejectedProposalId)}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "  Superseded by a clearer task.  " }),
      },
    );

    expect(rejectedResponse.status).toBe(200);
    expect(await rejectedResponse.json()).toMatchObject({
      proposal: {
        id: rejectedProposalId,
        state: "rejected",
        reviewReason: "Superseded by a clearer task.",
      },
    });
  });

  it("reports stale acceptance safely and leaves project knowledge unchanged", async () => {
    const project = application.service.createProject({
      name: "Stale proposal",
    });
    const createdProfile = application.service.profiles.createProfile({
      name: "Safe client",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const submission = application.service.submitChangeSet(principal, {
      projectId: project.id,
      baseProjectRevision: project.revision,
      idempotencyKey: "stale-route",
      rationale: "This proposal must not overwrite newer knowledge.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-stale-task",
        type: "create_record",
        kind: "task",
        status: "provisional",
        title: "Stale task",
        body: "This record must not be created.",
      }],
    });
    if (submission.outcome !== "proposed") {
      throw new Error("Proposal route fixture was not proposed");
    }
    application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Newer human decision",
      body: "Advance the project before accepting the stale proposal.",
      sourceKind: "human",
      sourceRef: null,
    });
    const summaryBefore = application.service.getProjectSummary(project.id);

    const response = await fetch(
      `${origin}/api/proposals/${encodeURIComponent(submission.proposalId)}/accept`,
      { method: "POST" },
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({
      outcome: "conflicted",
      currentProjectRevision: summaryBefore.project.revision,
      explanation: "Project knowledge was unchanged because this proposal was based on an older revision.",
      proposal: {
        id: submission.proposalId,
        state: "conflicted",
      },
    });
    expect(responseText).not.toContain("requestHash");
    expect(application.service.getProjectSummary(project.id)).toEqual(
      summaryBefore,
    );
  });

  it("prepares context only for a project-enabled profile without exposing finding values", async () => {
    const project = application.service.createProject({ name: "Safe routes" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Prepare guarded context",
      body:
        "Keep sk-proj-SyntheticRouteToken0123456789 private and contact " +
        "route.owner@example.invalid only when approved.",
      sourceKind: "human",
      sourceRef: null,
    });
    const globalProfile = application.service.profiles.createProfile({
      name: "Global only",
    }).profile;
    application.service.destinations.set({
      profileId: globalProfile.id,
      clientLabel: "Codex",
      type: "ide_managed",
      providerLabel: "OpenAI",
      modelLabel: "GPT-5",
      accountBoundaryLabel: "work",
      dataBoundary: "remote",
    });

    const disabledForProject = await fetch(
      `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: globalProfile.id,
          budgetTokens: 4_000,
          idempotencyKey: "not-project-enabled",
        }),
      },
    );
    expect(disabledForProject.status).toBe(400);

    application.service.profiles.setAuthority({
      profileId: globalProfile.id,
      projectId: project.id,
      mode: "proposal",
    });
    const response = await fetch(
      `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: globalProfile.id,
          budgetTokens: 4_000,
          idempotencyKey: "safe-route-request",
        }),
      },
    );
    const rendered = await response.text();
    const body = JSON.parse(rendered) as {
      request: { requestId: string; status: string };
      inspection: {
        findings: Array<{ requiredAction: string }>;
      };
      release: null;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      request: { status: "review_required" },
      inspection: {
        findings: expect.arrayContaining([
          expect.objectContaining({ requiredAction: "forced_redact" }),
          expect.objectContaining({ requiredAction: "redact_by_default" }),
        ]),
      },
      release: null,
    });
    expect(rendered).not.toContain("sk-proj-SyntheticRouteToken0123456789");
    expect(rendered).not.toContain("route.owner@example.invalid");

    const inspection = await fetch(
      `${origin}/api/context-requests/${body.request.requestId}/inspection`,
    );
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({
      request: { requestId: body.request.requestId },
      findings: body.inspection.findings,
    });
  });

  it("keeps reveal explicit, rejects forced inclusion, and returns browser-chat context", async () => {
    const project = application.service.createProject({ name: "Review routes" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Review outbound context",
      body:
        "Never expose sk-proj-SyntheticForcedToken0123456789. Contact " +
        "review.owner@example.invalid when explicitly included.",
      sourceKind: "human",
      sourceRef: null,
    });
    const omitted = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "active",
      title: "Omitted review detail",
      body: "Keep this linked detail out of the bounded release. " + "x".repeat(20_000),
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRelationship({
      projectId: project.id,
      fromRecordId: omitted.id,
      toRecordId: task.id,
      kind: "related_to",
      expectedProjectRevision: 2,
    });
    const profile = application.service.profiles.createProfile({
      name: "Review profile",
      projectId: project.id,
    }).profile;
    application.service.destinations.set({
      profileId: profile.id,
      clientLabel: "Local review desk",
      type: "local_model",
      providerLabel: "On-device",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "local",
    });
    const requestResponse = await fetch(
      `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: profile.id,
          budgetTokens: 4_000,
          idempotencyKey: "review-route-request",
        }),
      },
    );
    const prepared = await requestResponse.json() as {
      request: { requestId: string };
      inspection: {
        findings: Array<{
          id: string;
          requiredAction: "forced_redact" | "redact_by_default";
        }>;
      };
    };
    const forced = prepared.inspection.findings.find(
      ({ requiredAction }) => requiredAction === "forced_redact",
    )!;
    const optional = prepared.inspection.findings.find(
      ({ requiredAction }) => requiredAction === "redact_by_default",
    )!;

    const reveal = await fetch(
      `${origin}/api/context-requests/${prepared.request.requestId}/reveal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findingId: optional.id }),
      },
    );
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("cache-control")).toBe("no-store");
    expect(await reveal.json()).toEqual({
      requestId: prepared.request.requestId,
      findingId: optional.id,
      value: "review.owner@example.invalid",
    });

    const forcedApproval = await fetch(
      `${origin}/api/context-requests/${prepared.request.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rememberClean: false,
          includeFindingIds: [forced.id],
        }),
      },
    );
    expect(forcedApproval.status).toBe(400);

    const approval = await fetch(
      `${origin}/api/context-requests/${prepared.request.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rememberClean: false,
          includeFindingIds: [optional.id],
        }),
      },
    );
    const approved = await approval.json() as ReleasedContextResponse;

    expect(approval.status).toBe(200);
    expect(approved).toMatchObject({
      release: {
        requestId: prepared.request.requestId,
        disclosure: {
          findingCounts: { redacted: 1, includedOnce: 1 },
        },
      },
    });
    expect(approved).not.toHaveProperty("portableText");
    expect(approved.export).toMatchObject({
      filename: `intentarc-browser-chat-${approved.release.releaseId}.md`,
      mediaType: "text/markdown;charset=utf-8",
    });
    expect(approved.export?.text).toContain("# IntentArc browser-chat export");
    expect(approved.export?.text).toContain("review.owner@example.invalid");
    expect(approved.export?.text).not.toContain(
      "sk-proj-SyntheticForcedToken0123456789",
    );
    expect(approved.export?.text).toContain(
      `Release digest: \`${approved.release.disclosure.releaseDigest}\``,
    );
    expect(approved.export?.text).toContain(
      `Original estimated tokens: ${approved.release.disclosure.originalEstimatedTokens}`,
    );
    expect(approved.release.disclosure.omissions).toHaveLength(1);
    expect(approved.export?.text).toContain(
      `retrieve with \`${approved.release.disclosure.omissions[0]!.retrievalRef}\``,
    );

    const released = await fetch(
      `${origin}/api/context-requests/${prepared.request.requestId}/released`,
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual(approved);
  });

  it("denies a pending request while retaining its terminal request record", async () => {
    const project = application.service.createProject({ name: "Deny route" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Decline this handoff",
      body: "Keep the review record.",
      sourceKind: "human",
      sourceRef: null,
    });
    const profile = application.service.profiles.createProfile({
      name: "Deny profile",
      projectId: project.id,
    }).profile;
    application.service.destinations.set({
      profileId: profile.id,
      clientLabel: "Review target",
      type: "unknown",
      providerLabel: "Undeclared",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "unknown",
    });
    const preparedResponse = await fetch(
      `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: profile.id,
          budgetTokens: 4_000,
          idempotencyKey: "deny-route-request",
        }),
      },
    );
    const prepared = await preparedResponse.json() as {
      request: { requestId: string };
    };

    const denial = await fetch(
      `${origin}/api/context-requests/${prepared.request.requestId}/deny`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(denial.status).toBe(200);
    expect(await denial.json()).toMatchObject({
      requestId: prepared.request.requestId,
      status: "denied",
    });
    expect(application.service.outbound.list({})).toContainEqual(
      expect.objectContaining({
        requestId: prepared.request.requestId,
        status: "denied",
      }),
    );
  });

  it("repairs project-authorized destinationless and disabled-destination profiles before preparation", async () => {
    const project = application.service.createProject({
      name: "Destination repair",
    });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Prepare after repair",
      body: "Carry this safe task context to the configured client.",
      sourceKind: "human",
      sourceRef: null,
    });
    const cliProfile = application.service.profiles.createProfile({
      name: "CLI authorized profile",
      projectId: project.id,
      executionMode: "custom",
    }).profile;
    const migratedProfile = application.service.profiles.createProfile({
      name: "Migrated authorized profile",
      projectId: project.id,
      executionMode: "safe",
    }).profile;
    application.service.destinations.set({
      profileId: migratedProfile.id,
      clientLabel: "Retired migrated client",
      type: "gateway",
      providerLabel: "Retired provider",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "remote",
    });
    application.service.destinations.disable(migratedProfile.id);

    const initialHandoff = await fetch(
      `${origin}/api/projects/${project.id}/tasks/${task.id}/handoff`,
    );
    const initialProfiles = (await initialHandoff.json() as {
      profiles: Array<{
        profileId: string;
        destination: null | { clientLabel: string };
      }>;
    }).profiles;
    expect(initialProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: cliProfile.id,
        destination: null,
      }),
      expect.objectContaining({
        profileId: migratedProfile.id,
        destination: null,
      }),
    ]));
    expect(JSON.stringify(initialProfiles)).not.toContain(
      "Retired migrated client",
    );

    for (const [index, configuredProfile] of [
      cliProfile,
      migratedProfile,
    ].entries()) {
      const unavailable = await fetch(
        `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileId: configuredProfile.id,
            budgetTokens: 4_000,
            idempotencyKey: `before-repair-${index}`,
          }),
        },
      );
      expect(unavailable.status).toBe(400);

      const repair = await fetch(
        `${origin}/api/projects/${project.id}/profiles`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "existing",
            profileId: configuredProfile.id,
            executionMode: configuredProfile.executionMode,
            destination: {
              clientLabel: `Repaired client ${index}`,
              type: "ide_managed",
              providerLabel: "Configured provider",
              modelLabel: null,
              accountBoundaryLabel: null,
              dataBoundary: "local",
            },
          }),
        },
      );
      expect(repair.status).toBe(200);

      const prepared = await fetch(
        `${origin}/api/projects/${project.id}/tasks/${task.id}/context-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileId: configuredProfile.id,
            budgetTokens: 4_000,
            idempotencyKey: `after-repair-${index}`,
          }),
        },
      );
      expect(prepared.status).toBe(200);
      expect(await prepared.json()).toMatchObject({
        request: {
          profileId: configuredProfile.id,
          status: expect.stringMatching(/^(released|review_required)$/),
          destination: { clientLabel: `Repaired client ${index}` },
        },
      });
    }
  });

  it("lists profiles through a credential-free sanitized contract", async () => {
    const project = application.service.createProject({ name: "Profile list" });
    const created = application.service.profiles.createProfile({
      name: "Sanitized profile",
      projectId: project.id,
      executionMode: "custom",
    });
    application.service.destinations.set({
      profileId: created.profile.id,
      clientLabel: "Configured client",
      type: "gateway",
      providerLabel: "Private gateway",
      modelLabel: null,
      accountBoundaryLabel: "team",
      dataBoundary: "mixed",
    });

    const response = await fetch(`${origin}/api/profiles`);
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(rendered)).toEqual({
      profiles: [{
        profileId: created.profile.id,
        name: "Sanitized profile",
        status: "enabled",
        executionMode: "custom",
        projectIds: [project.id],
        lastUsedAt: null,
        hasDestination: true,
      }],
    });
    expect(rendered).not.toContain(created.token);
    expect(rendered).not.toContain("tokenHash");
    expect(rendered).not.toContain("authorities");
  });

  it("enables an existing destination while preserving established knowledge authority", async () => {
    const project = application.service.createProject({ name: "Existing setup" });
    const existing = application.service.profiles.createProfile({
      name: "Existing client",
      projectId: project.id,
      executionMode: "safe",
    }).profile;
    application.service.profiles.setAuthority({
      profileId: existing.id,
      projectId: project.id,
      mode: "full_direct",
    });
    application.service.destinations.set({
      profileId: existing.id,
      clientLabel: "Existing destination",
      type: "ide_managed",
      providerLabel: "Existing provider",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "remote",
    });

    const response = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "existing",
          profileId: existing.id,
          executionMode: "trusted",
          destination: null,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profileId: existing.id,
      token: null,
      tokenShownOnce: false,
    });
    const summary = application.service.profiles.listProfiles().find(
      ({ profile }) => profile.id === existing.id,
    )!;
    expect(summary.profile.executionMode).toBe("trusted");
    expect(summary.authorities.find(
      ({ authority }) => authority.projectId === project.id,
    )?.authority.mode).toBe("full_direct");
  });

  it("does not report or reuse a disabled current destination", async () => {
    const project = application.service.createProject({
      name: "Disabled destination setup",
    });
    const existing = application.service.profiles.createProfile({
      name: "Disabled destination client",
    }).profile;
    application.service.destinations.set({
      profileId: existing.id,
      clientLabel: "Retired destination",
      type: "ide_managed",
      providerLabel: "Retired provider",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "remote",
    });
    application.service.destinations.disable(existing.id);

    const profilesResponse = await fetch(`${origin}/api/profiles`);
    const profiles = await profilesResponse.json() as {
      profiles: Array<{ profileId: string; hasDestination: boolean }>;
    };
    expect(profiles.profiles.find(
      ({ profileId }) => profileId === existing.id,
    )?.hasDestination).toBe(false);

    const setupResponse = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "existing",
          profileId: existing.id,
          executionMode: "safe",
          destination: null,
        }),
      },
    );

    expect(setupResponse.status).toBe(400);
  });

  it("rolls back a new profile and token when its late destination write fails", async () => {
    const project = application.service.createProject({
      name: "Atomic new setup",
    });
    installLateDestinationFailure(temporaryDatabase.path);
    const before = readProfileSetupCounts(temporaryDatabase.path);

    const response = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "new",
          name: "Must roll back",
          executionMode: "trusted",
          destination: {
            clientLabel: "Failing destination",
            type: "direct_provider",
            providerLabel: "Failing provider",
            modelLabel: null,
            accountBoundaryLabel: null,
            dataBoundary: "remote",
          },
        }),
      },
    );

    expect(response.status).toBe(500);
    expect(readProfileSetupCounts(temporaryDatabase.path)).toEqual(before);
    expect(application.service.profiles.listProfiles().some(
      ({ profile }) => profile.name === "Must roll back",
    )).toBe(false);
  });

  it("rolls back existing profile mode and authority when destination setup fails", async () => {
    const project = application.service.createProject({
      name: "Atomic existing setup",
    });
    const existing = application.service.profiles.createProfile({
      name: "Existing atomic profile",
      executionMode: "safe",
    }).profile;
    installLateDestinationFailure(temporaryDatabase.path);
    const before = readProfileSetupCounts(temporaryDatabase.path);

    const response = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "existing",
          profileId: existing.id,
          executionMode: "trusted",
          destination: {
            clientLabel: "Failing existing destination",
            type: "gateway",
            providerLabel: "Failing gateway",
            modelLabel: null,
            accountBoundaryLabel: null,
            dataBoundary: "mixed",
          },
        }),
      },
    );

    expect(response.status).toBe(500);
    expect(readProfileSetupCounts(temporaryDatabase.path)).toEqual(before);
    const summary = application.service.profiles.listProfiles().find(
      ({ profile }) => profile.id === existing.id,
    )!;
    expect(summary.profile.executionMode).toBe("safe");
    expect(summary.authorities).toEqual([]);
    expect(application.service.destinations.getCurrent(existing.id)).toBeNull();
  });

  it("rejects destinationless existing setup and creates a no-store one-time profile credential", async () => {
    const project = application.service.createProject({ name: "New setup" });
    const destinationless = application.service.profiles.createProfile({
      name: "Destinationless",
    }).profile;

    const invalid = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "existing",
          profileId: destinationless.id,
          executionMode: "safe",
          destination: null,
        }),
      },
    );
    expect(invalid.status).toBe(400);

    const response = await fetch(
      `${origin}/api/projects/${project.id}/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "new",
          name: "New trusted client",
          executionMode: "trusted",
          destination: {
            clientLabel: "New client",
            type: "direct_provider",
            providerLabel: "Provider",
            modelLabel: "Model",
            accountBoundaryLabel: "personal",
            dataBoundary: "remote",
          },
        }),
      },
    );
    const created = await response.json() as {
      profileId: string;
      token: string;
      tokenShownOnce: boolean;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(created.token).toEqual(expect.any(String));
    expect(created.token.length).toBeGreaterThan(10);
    expect(created.tokenShownOnce).toBe(true);
    const summary = application.service.profiles.listProfiles().find(
      ({ profile }) => profile.id === created.profileId,
    )!;
    expect(summary.profile.executionMode).toBe("trusted");
    expect(summary.authorities).toEqual([
      expect.objectContaining({
        authority: expect.objectContaining({
          projectId: project.id,
          mode: "proposal",
        }),
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain(created.token);
  });

  it("scans, inspects, applies, and replays a repository without executing its code", async () => {
    const fixture = createRepositoryFixture({
      "README.md": [
        "# Route import",
        "",
        "## Current task",
        "Keep repository import reviewable.",
      ].join("\n"),
      "game/project.godot": "[application]\nconfig/name=\"Route import\"\n",
      "game/src/main.gd": "extends Node\n",
      "package.json": JSON.stringify({
        scripts: {
          prepare: "node -e \"require('node:fs').writeFileSync('EXECUTED', 'no')\"",
        },
      }),
    }, { parentDirectory: process.cwd() });
    repositoryFixtures.push(fixture);

    const scanResponse = await fetch(`${origin}/api/imports/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryPath: fixture.root,
        canonicalSubpath: "game",
      }),
    });
    const scan = await scanResponse.json() as {
      manifest: unknown;
      inspection: { manifestDigest: string; repository: { root: string } };
    };

    expect(scanResponse.status).toBe(200);
    expect(scanResponse.headers.get("cache-control")).toBe("no-store");
    expect(scan.inspection).toMatchObject({
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository: { root: fixture.root.replaceAll("\\", "/") },
    });
    expect(scan).toHaveProperty("manifest");
    expect(existsSync(join(fixture.root, "EXECUTED"))).toBe(false);

    const apply = async () => {
      const response = await fetch(`${origin}/api/imports/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest: scan.manifest,
          confirmedDigest: scan.inspection.manifestDigest,
        }),
      });
      return {
        response,
        body: await response.json() as {
          result: { projectId: string; replayed: boolean };
        },
      };
    };

    const first = await apply();
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    expect(first.body.result).toMatchObject({
      projectId: "project-1",
      replayed: false,
    });
    expect(existsSync(join(fixture.root, "EXECUTED"))).toBe(false);

    const replay = await apply();
    expect(replay.response.status).toBe(200);
    expect(replay.body.result).toMatchObject({
      projectId: "project-1",
      replayed: true,
    });
  });

  it("requires exact import inputs and safely rejects repository drift", async () => {
    const fixture = createRepositoryFixture({
      "README.md": "# Drift route\n\nOriginal repository evidence.",
      "game/project.godot": "[application]\nconfig/name=\"Drift route\"\n",
      "game/src/main.gd": "extends Node\n",
    }, { parentDirectory: process.cwd() });
    repositoryFixtures.push(fixture);

    const missingPath = await fetch(`${origin}/api/imports/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryPath: " ",
        canonicalSubpath: null,
      }),
    });
    expect(missingPath.status).toBe(400);

    const missingRepositoryPath = `${fixture.root}-missing`;
    const missingRepository = await fetch(`${origin}/api/imports/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryPath: missingRepositoryPath,
        canonicalSubpath: null,
      }),
    });
    const missingRepositoryText = await missingRepository.text();
    expect(missingRepository.status).toBe(400);
    expect(missingRepositoryText).toContain(
      '"code":"import_validation_failed"',
    );
    expect(missingRepositoryText).not.toContain(missingRepositoryPath);

    const scan = await (await fetch(`${origin}/api/imports/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryPath: fixture.root,
        canonicalSubpath: "game",
      }),
    })).json() as {
      manifest: unknown;
      inspection: { manifestDigest: string };
    };

    const inexactDigest = await fetch(`${origin}/api/imports/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: scan.manifest,
        confirmedDigest: scan.inspection.manifestDigest.toUpperCase(),
      }),
    });
    expect(inexactDigest.status).toBe(400);

    const invalidManifest = await fetch(`${origin}/api/imports/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          repositoryPath: fixture.root,
          recordBody: "PRIVATE MANIFEST BODY",
        },
        confirmedDigest: "a".repeat(64),
      }),
    });
    const invalidManifestText = await invalidManifest.text();
    expect(invalidManifest.status).toBe(409);
    expect(invalidManifestText).toContain(
      '"code":"import_rescan_required"',
    );
    expect(invalidManifestText).not.toContain(fixture.root);
    expect(invalidManifestText).not.toContain("PRIVATE MANIFEST BODY");

    fixture.write(
      "game/project.godot",
      "[application]\nconfig/name=\"Changed drift route\"\n",
    );
    const drift = await fetch(`${origin}/api/imports/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: scan.manifest,
        confirmedDigest: scan.inspection.manifestDigest,
      }),
    });
    const driftText = await drift.text();

    expect(drift.status).toBe(409);
    expect(driftText).toContain('"code":"import_rescan_required"');
    expect(driftText).not.toContain(fixture.root);
    expect(driftText).not.toContain("Changed repository evidence");
    expect(application.service.listProjects()).toHaveLength(0);
  });

  it("registers exactly the eleven project-scoped coordination routes", () => {
    const routes = createApplicationRoutes(application)
      .filter((route) => route.pattern.source.includes("coordination"))
      .map((route) => `${route.method} ${route.pattern.source}`);

    expect(routes).toEqual([
      "GET ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/ready$",
      "GET ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/state$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/claims$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/claims\\/(?<claimId>[^/]+)\\/renew$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/claims\\/(?<claimId>[^/]+)\\/checkpoints$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/claims\\/(?<claimId>[^/]+)\\/transition$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/switch$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/delegations$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/delegations\\/(?<delegationId>[^/]+)\\/accept$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/delegations\\/(?<delegationId>[^/]+)\\/revoke$",
      "POST ^\\/api\\/projects\\/(?<projectId>[^/]+)\\/coordination\\/claims\\/(?<claimId>[^/]+)\\/submissions$",
    ]);
  });

  it("requires exact non-disclosing coordination credentials and project authority", async () => {
    const project = application.service.createProject({ name: "Credential route" });
    application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Coordinate",
      body: "Exercise credential extraction.", sourceKind: "human", sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Route worker", projectId: project.id,
    });
    const path = `/api/projects/${project.id}/coordination/ready?expectedProjectRevision=1&limit=20`;
    const validHeaders = {
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const valid = await fetch(`${origin}${path}`, { headers: validHeaders });
    expect(valid.status).toBe(200);

    const attempts: Array<[HeadersInit | undefined, number, string]> = [
      [undefined, 401, "profile_required"],
      [{ "X-IntentArc-Profile-Id": created.profile.id }, 401, "profile_required"],
      [{ Authorization: `Bearer ${created.token}` }, 401, "profile_required"],
      [{ ...validHeaders, Authorization: `Basic ${created.token}` }, 401, "invalid_profile_credentials"],
      [{ ...validHeaders, Authorization: `bearer ${created.token}` }, 401, "invalid_profile_credentials"],
      [{ ...validHeaders, Authorization: `Bearer  ${created.token}` }, 401, "invalid_profile_credentials"],
      [{ ...validHeaders, Authorization: "Bearer wrong-token" }, 401, "invalid_profile_credentials"],
    ];
    for (const [headers, status, code] of attempts) {
      const response = await fetch(`${origin}${path}`, { headers });
      const text = await response.text();
      expect(response.status).toBe(status);
      expect(text).toContain(`"code":"${code}"`);
      expect(text).not.toContain(created.token);
      expect(text).not.toContain(created.profile.id);
    }

    for (const label of ["profile", "authorization"] as const) {
      const duplicate = new Headers(validHeaders);
      duplicate.append(
        label === "profile" ? "X-IntentArc-Profile-Id" : "Authorization",
        label === "profile" ? created.profile.id : `Bearer ${created.token}`,
      );
      const result = await fetch(`${origin}${path}`, { headers: duplicate });
      const response = { status: result.status, text: await result.text() };
      expect(response.status, label).toBe(401);
      expect(response.text).toContain('"code":"invalid_profile_credentials"');
      expect(response.text).not.toContain(created.token);
      expect(response.text).not.toContain(created.profile.id);
    }

    for (const duplicateName of [
      "X-IntentArc-Profile-Id",
      "Authorization",
    ] as const) {
      const rawHeaders = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1`,
        `X-IntentArc-Profile-Id: ${created.profile.id}`,
        ...(duplicateName === "X-IntentArc-Profile-Id"
          ? [`X-IntentArc-Profile-Id: ${created.profile.id}`]
          : []),
        `Authorization: Bearer ${created.token}`,
        ...(duplicateName === "Authorization"
          ? [`Authorization: Bearer ${created.token}`]
          : []),
        "Connection: close",
      ];
      const response = await sendRawHttpRequest(rawHeaders);
      expect(response.status, duplicateName).toBe(401);
      expect(response.body).toContain('"code":"invalid_profile_credentials"');
      expect(response.body).not.toContain(created.token);
      expect(response.body).not.toContain(created.profile.id);
    }

    application.service.profiles.setEnabled(created.profile.id, false);
    const disabled = await fetch(`${origin}${path}`, { headers: validHeaders });
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ error: { code: "profile_disabled" } });

    const foreignProject = application.service.createProject({ name: "Foreign route" });
    const foreignProfile = application.service.profiles.createProfile({
      name: "Foreign worker", projectId: foreignProject.id,
    });
    const denied = await fetch(`${origin}${path}`, { headers: {
      "X-IntentArc-Profile-Id": foreignProfile.profile.id,
      Authorization: `Bearer ${foreignProfile.token}`,
    } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "coordination_authority_denied" },
    });

    const ordinary = await fetch(`${origin}/api/projects`, {
      headers: { Authorization: "not-a-bearer-value" },
    });
    expect(ordinary.status).toBe(200);
  });

  it("executes all eleven coordination routes through the real public DTO boundary", async () => {
    const project = application.service.createProject({ name: "Route journey" });
    const tasks = ["Pause", "Switch from", "Switch to", "Delegate", "Revoke"].map(
      (title) => application.service.createRecord({
        projectId: project.id, kind: "task", status: "active", title,
        body: `${title} through the web route.`, sourceKind: "human", sourceRef: null,
      }),
    );
    const revision = tasks.length;
    const parent = application.service.profiles.createProfile({
      name: "Web parent", projectId: project.id,
    });
    const child = application.service.profiles.createProfile({
      name: "Web child", projectId: project.id,
    });
    for (const profileId of [parent.profile.id, child.profile.id]) {
      application.service.profiles.setAuthority({
        profileId, projectId: project.id, mode: "full_direct",
      });
    }
    const credentials = (profile: typeof parent) => ({
      "X-IntentArc-Profile-Id": profile.profile.id,
      Authorization: `Bearer ${profile.token}`,
    });
    const call = async (
      profile: typeof parent,
      path: string,
      body?: unknown,
    ): Promise<Record<string, any>> => {
      const response = await fetch(`${origin}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          ...credentials(profile),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      });
      const output = await response.json() as Record<string, any>;
      expect(response.status, `${path}: ${JSON.stringify(output)}`).toBe(200);
      return output;
    };
    const checkpoint = (summary: string) => ({
      summary, completedWork: ["Exercised the web route."],
      remainingWork: ["Reconcile the task."], blockers: [],
      verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
      repositoryEvidence: null,
    });

    const ready = await call(
      parent,
      `/api/projects/${project.id}/coordination/ready?expectedProjectRevision=${revision}&limit=20`,
    );
    expect(ready.tasks).toHaveLength(5);
    const state = await call(
      parent,
      `/api/projects/${project.id}/coordination/state?taskId=${tasks[0]!.id}&expectedProjectRevision=${revision}`,
    );
    expect(state).toMatchObject({ task: { id: tasks[0]!.id }, claim: null });

    const claimInput = (taskId: string, key: string, acceptedDelegationId: string | null = null) => ({
      projectId: project.id, taskId, expectedProjectRevision: revision,
      expectedTaskRevision: 1, contextBudgetTokens: 1_200,
      acceptedDelegationId, idempotencyKey: key,
    });
    const pausedClaim = await call(
      parent,
      `/api/projects/${project.id}/coordination/claims`,
      claimInput(tasks[0]!.id, "web-claim-pause"),
    );
    const pausedClaimId = pausedClaim.claim.id as string;
    await call(parent, `/api/projects/${project.id}/coordination/claims/${pausedClaimId}/renew`, {
      claimId: pausedClaimId, expectedProjectRevision: revision,
      expectedTaskRevision: 1, idempotencyKey: "web-renew",
    });
    await call(parent, `/api/projects/${project.id}/coordination/claims/${pausedClaimId}/checkpoints`, {
      claimId: pausedClaimId, expectedProjectRevision: revision,
      expectedTaskRevision: 1, checkpoint: checkpoint("Before pause"),
      idempotencyKey: "web-checkpoint-pause",
    });
    await call(parent, `/api/projects/${project.id}/coordination/claims/${pausedClaimId}/transition`, {
      claimId: pausedClaimId, expectedProjectRevision: revision,
      expectedTaskRevision: 1, action: "pause", idempotencyKey: "web-pause",
    });

    const switching = await call(
      parent,
      `/api/projects/${project.id}/coordination/claims`,
      claimInput(tasks[1]!.id, "web-claim-switch"),
    );
    await call(parent, `/api/projects/${project.id}/coordination/switch`, {
      currentClaimId: switching.claim.id, projectId: project.id,
      currentTaskId: tasks[1]!.id, expectedCurrentProjectRevision: revision,
      expectedCurrentTaskRevision: 1, checkpoint: checkpoint("Before switch"),
      terminalAction: "release", nextTaskId: tasks[2]!.id,
      expectedNextProjectRevision: revision, expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 1_200, acceptedDelegationId: null,
      idempotencyKey: "web-switch",
    });

    const equivalentDeadlineInput = {
      projectId: project.id, taskId: tasks[3]!.id, childProfileId: child.profile.id,
      expectedProjectRevision: revision, expectedTaskRevision: 1,
      scope: { summary: "Implement delegated route work.", constraints: [] },
      allowedOutputs: ["create_record", "update_record"],
      deadline: "2026-07-29T13:00Z", idempotencyKey: "web-delegate",
    };
    const offered = await call(
      parent,
      `/api/projects/${project.id}/coordination/delegations`,
      equivalentDeadlineInput,
    );
    expect(offered.delegation.deadline).toBe("2026-07-29T13:00:00.000Z");
    expect(await call(
      parent,
      `/api/projects/${project.id}/coordination/delegations`,
      equivalentDeadlineInput,
    )).toEqual(offered);
    const delegationId = offered.delegation.id as string;
    await call(child, `/api/projects/${project.id}/coordination/delegations/${delegationId}/accept`, {
      delegationId, projectId: project.id, taskId: tasks[3]!.id,
      expectedProjectRevision: revision, expectedTaskRevision: 1,
      idempotencyKey: "web-accept",
    });
    const delegatedClaim = await call(
      child,
      `/api/projects/${project.id}/coordination/claims`,
      claimInput(tasks[3]!.id, "web-delegated-claim", delegationId),
    );
    const delegatedClaimId = delegatedClaim.claim.id as string;
    const delegatedCheckpoint = await call(
      child,
      `/api/projects/${project.id}/coordination/claims/${delegatedClaimId}/checkpoints`,
      {
        claimId: delegatedClaimId, expectedProjectRevision: revision,
        expectedTaskRevision: 1, checkpoint: checkpoint("Before submission"),
        idempotencyKey: "web-checkpoint-submit",
      },
    );
    const submitted = await call(
      child,
      `/api/projects/${project.id}/coordination/claims/${delegatedClaimId}/submissions`,
      {
        claimId: delegatedClaimId,
        checkpointId: delegatedCheckpoint.checkpoint.id,
        expectedProjectRevision: revision, expectedTaskRevision: 1,
        submission: {
          summary: "Complete delegated route work.",
          verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
          repositoryEvidence: null,
          changes: { rationale: "Complete the delegated task.", operations: [] },
        },
        idempotencyKey: "web-submit",
      },
    );
    expect(submitted).toMatchObject({
      claim: { state: "submitted" }, submission: { state: "submitted" },
      proposal: { state: "pending" },
    });

    const revocable = await call(parent, `/api/projects/${project.id}/coordination/delegations`, {
      projectId: project.id, taskId: tasks[4]!.id, childProfileId: child.profile.id,
      expectedProjectRevision: revision, expectedTaskRevision: 1,
      scope: { summary: "Revoke this route delegation.", constraints: [] },
      allowedOutputs: ["update_record"], deadline: "2026-07-29T13:00:00.000Z",
      idempotencyKey: "web-delegate-revoke",
    });
    const revokeId = revocable.delegation.id as string;
    const revoked = await call(
      parent,
      `/api/projects/${project.id}/coordination/delegations/${revokeId}/revoke`,
      {
        delegationId: revokeId, projectId: project.id, taskId: tasks[4]!.id,
        expectedProjectRevision: revision, expectedTaskRevision: 1,
        idempotencyKey: "web-revoke",
      },
    );
    expect(revoked).toMatchObject({ delegation: { state: "revoked" } });
  });

  it("rejects unknown coordination inputs and oversized bodies before service invocation", async () => {
    const project = application.service.createProject({ name: "Strict route" });
    const created = application.service.profiles.createProfile({
      name: "Strict worker", projectId: project.id,
    });
    const headers = {
      "content-type": "application/json",
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const service = application.service.coordination;
    const methods = [
      "claimTask", "renewClaim", "checkpointClaim", "transitionClaim", "switchTask",
      "createDelegation", "acceptDelegation", "revokeDelegation", "submitTaskResult",
    ] as const;
    const spies = methods.map((method) => vi.spyOn(service, method));
    const requests = [
      ["GET", `/api/projects/${project.id}/coordination/ready?expectedProjectRevision=0&limit=20&future=private`],
      ["GET", `/api/projects/${project.id}/coordination/state?taskId=task-1&expectedProjectRevision=0&future=private`],
      ["POST", `/api/projects/${project.id}/coordination/claims`],
      ["POST", `/api/projects/${project.id}/coordination/claims/claim-1/renew`],
      ["POST", `/api/projects/${project.id}/coordination/claims/claim-1/checkpoints`],
      ["POST", `/api/projects/${project.id}/coordination/claims/claim-1/transition`],
      ["POST", `/api/projects/${project.id}/coordination/switch`],
      ["POST", `/api/projects/${project.id}/coordination/delegations`],
      ["POST", `/api/projects/${project.id}/coordination/delegations/delegation-1/accept`],
      ["POST", `/api/projects/${project.id}/coordination/delegations/delegation-1/revoke`],
      ["POST", `/api/projects/${project.id}/coordination/claims/claim-1/submissions`],
    ] as const;
    for (const [method, path] of requests) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify({ future: "private" }) } : {}),
      });
      expect(response.status, path).toBe(400);
    }
    const invalidDeadline = await fetch(
      `${origin}/api/projects/${project.id}/coordination/delegations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: project.id,
          taskId: "task-1",
          childProfileId: "profile-child",
          expectedProjectRevision: 0,
          expectedTaskRevision: 1,
          scope: { summary: "Invalid deadline", constraints: [] },
          allowedOutputs: ["update_record"],
          deadline: "not-a-timestamp",
          idempotencyKey: "invalid-deadline",
        }),
      },
    );
    expect(invalidDeadline.status).toBe(400);
    const oversized = await fetch(`${origin}/api/projects/${project.id}/coordination/claims`, {
      method: "POST", headers, body: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });
    expect(oversized.status).toBe(413);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects every mismatched coordination path and body identifier before service invocation", async () => {
    const project = application.service.createProject({ name: "Identifier route" });
    const created = application.service.profiles.createProfile({
      name: "Identifier worker", projectId: project.id,
    });
    const headers = {
      "content-type": "application/json",
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const checkpoint = {
      summary: "Mismatch", completedWork: [], remainingWork: [], blockers: [],
      verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null,
    };
    const cases = [
      [`/api/projects/${project.id}/coordination/claims`, { projectId: "project-other", taskId: "task-1", expectedProjectRevision: 0, expectedTaskRevision: 1, contextBudgetTokens: 1_000, acceptedDelegationId: null, idempotencyKey: "mismatch-claim" }],
      [`/api/projects/${project.id}/coordination/claims/claim-path/renew`, { claimId: "claim-body", expectedProjectRevision: 0, expectedTaskRevision: 1, idempotencyKey: "mismatch-renew" }],
      [`/api/projects/${project.id}/coordination/claims/claim-path/checkpoints`, { claimId: "claim-body", expectedProjectRevision: 0, expectedTaskRevision: 1, checkpoint, idempotencyKey: "mismatch-checkpoint" }],
      [`/api/projects/${project.id}/coordination/claims/claim-path/transition`, { claimId: "claim-body", expectedProjectRevision: 0, expectedTaskRevision: 1, action: "pause", idempotencyKey: "mismatch-transition" }],
      [`/api/projects/${project.id}/coordination/switch`, { currentClaimId: "claim-1", projectId: "project-other", currentTaskId: "task-1", expectedCurrentProjectRevision: 0, expectedCurrentTaskRevision: 1, checkpoint, terminalAction: "release", nextTaskId: "task-2", expectedNextProjectRevision: 0, expectedNextTaskRevision: 1, nextContextBudgetTokens: 1_000, acceptedDelegationId: null, idempotencyKey: "mismatch-switch" }],
      [`/api/projects/${project.id}/coordination/delegations`, { projectId: "project-other", taskId: "task-1", childProfileId: "profile-child", expectedProjectRevision: 0, expectedTaskRevision: 1, scope: { summary: "Mismatch", constraints: [] }, allowedOutputs: ["update_record"], deadline: "2026-07-29T13:00:00.000Z", idempotencyKey: "mismatch-delegation" }],
      [`/api/projects/${project.id}/coordination/delegations/delegation-path/accept`, { delegationId: "delegation-body", projectId: project.id, taskId: "task-1", expectedProjectRevision: 0, expectedTaskRevision: 1, idempotencyKey: "mismatch-accept" }],
      [`/api/projects/${project.id}/coordination/delegations/delegation-path/revoke`, { delegationId: "delegation-body", projectId: project.id, taskId: "task-1", expectedProjectRevision: 0, expectedTaskRevision: 1, idempotencyKey: "mismatch-revoke" }],
      [`/api/projects/${project.id}/coordination/claims/claim-path/submissions`, { claimId: "claim-body", checkpointId: "checkpoint-1", expectedProjectRevision: 0, expectedTaskRevision: 1, submission: { summary: "Mismatch", verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null, changes: { rationale: "Reject mismatch.", operations: [] } }, idempotencyKey: "mismatch-submit" }],
    ] as const;
    const service = application.service.coordination;
    const spies = [
      vi.spyOn(service, "claimTask"), vi.spyOn(service, "renewClaim"),
      vi.spyOn(service, "checkpointClaim"), vi.spyOn(service, "transitionClaim"),
      vi.spyOn(service, "switchTask"), vi.spyOn(service, "createDelegation"),
      vi.spyOn(service, "acceptDelegation"), vi.spyOn(service, "revokeDelegation"),
      vi.spyOn(service, "submitTaskResult"),
    ];
    for (const [path, body] of cases) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a cross-project nested coordination DTO without disclosure", async () => {
    const project = application.service.createProject({ name: "DTO route" });
    const task = application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "DTO task",
      body: "Keep nested output scoped.", sourceKind: "human", sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "DTO worker", projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id, token: created.token,
    })!;
    const claimed = application.service.coordination.claimTask({
      projectId: project.id, taskId: task.id, expectedProjectRevision: 1,
      expectedTaskRevision: 1, contextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "dto-claim",
    }, principal);
    vi.spyOn(application.service.coordination, "getCoordinationState")
      .mockReturnValue({
        task,
        claim: { ...claimed.claim, projectId: "project-private" },
        delegation: null,
        latestCheckpoint: null,
        submission: null,
        events: [],
      });

    const response = await fetch(
      `${origin}/api/projects/${project.id}/coordination/state?taskId=${task.id}&expectedProjectRevision=1`,
      { headers: {
        "X-IntentArc-Profile-Id": created.profile.id,
        Authorization: `Bearer ${created.token}`,
      } },
    );
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("project-private");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
  });

  it("binds ready revisions and every claim-scoped output to the route project and request revisions", async () => {
    const project = application.service.createProject({ name: "Bound output route" });
    const task = application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Bound output",
      body: "Reject valid-shaped foreign output.", sourceKind: "human", sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Bound output worker", projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id, token: created.token,
    })!;
    const claimed = application.service.coordination.claimTask({
      projectId: project.id, taskId: task.id, expectedProjectRevision: 1,
      expectedTaskRevision: 1, contextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "bound-output-claim",
    }, principal);
    const checkpointInput = {
      claimId: claimed.claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1,
      checkpoint: {
        summary: "Bound output checkpoint", completedWork: [], remainingWork: [], blockers: [],
        verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null,
      },
      idempotencyKey: "bound-output-checkpoint",
    };
    const saved = application.service.coordination.checkpointClaim(checkpointInput, principal);
    const submitInput = {
      claimId: claimed.claim.id, checkpointId: saved.checkpoint.id,
      expectedProjectRevision: 1, expectedTaskRevision: 1,
      submission: {
        summary: "Bound output submission",
        verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null,
        changes: { rationale: "Keep output bound.", operations: [] },
      },
      idempotencyKey: "bound-output-submit",
    };
    const submitted = application.service.coordination.submitTaskResult(submitInput, principal);
    const foreignTaskId = "task-private-foreign";
    const foreignClaim = { ...claimed.claim, taskId: foreignTaskId };
    vi.spyOn(application.service.coordination, "listReadyTasks").mockReturnValue({
      tasks: [], nextCursor: null, projectRevision: 2,
    });
    vi.spyOn(application.service.coordination, "renewClaim")
      .mockReturnValue({ claim: foreignClaim });
    vi.spyOn(application.service.coordination, "checkpointClaim")
      .mockReturnValueOnce({
        claim: { ...foreignClaim, latestCheckpointId: saved.checkpoint.id },
        checkpoint: saved.checkpoint,
      })
      .mockReturnValueOnce({
        claim: { ...claimed.claim, latestCheckpointId: saved.checkpoint.id },
        checkpoint: { ...saved.checkpoint, projectRevision: 2, taskRevision: 2 },
      });
    vi.spyOn(application.service.coordination, "transitionClaim")
      .mockReturnValue({
        claim: { ...foreignClaim, state: "paused", endedAt: "2026-08-15T08:10:00.000Z" },
      });
    vi.spyOn(application.service.coordination, "submitTaskResult")
      .mockReturnValueOnce({
        claim: { ...submitted.claim, taskId: foreignTaskId },
        submission: { ...submitted.submission, taskId: foreignTaskId },
        proposal: { ...submitted.proposal, sourceTaskId: foreignTaskId },
      })
      .mockReturnValueOnce({
        ...submitted,
        submission: { ...submitted.submission, baseProjectRevision: 2, baseTaskRevision: 2 },
        proposal: { ...submitted.proposal, baseProjectRevision: 2 },
      });
    const headers = {
      "content-type": "application/json",
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const cases: Array<[string, RequestInit | undefined]> = [
      [`/api/projects/${project.id}/coordination/ready?expectedProjectRevision=1&limit=20`, { headers }],
      [`/api/projects/${project.id}/coordination/claims/${claimed.claim.id}/renew`, {
        method: "POST", headers, body: JSON.stringify({
          claimId: claimed.claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1,
          idempotencyKey: "bound-output-renew-route",
        }),
      }],
      ...[1, 2].map(() => [`/api/projects/${project.id}/coordination/claims/${claimed.claim.id}/checkpoints`, {
        method: "POST", headers, body: JSON.stringify({
          ...checkpointInput, idempotencyKey: `bound-output-checkpoint-route-${crypto.randomUUID()}`,
        }),
      }] as [string, RequestInit]),
      [`/api/projects/${project.id}/coordination/claims/${claimed.claim.id}/transition`, {
        method: "POST", headers, body: JSON.stringify({
          claimId: claimed.claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1,
          action: "pause", idempotencyKey: "bound-output-transition-route",
        }),
      }],
      ...[1, 2].map(() => [`/api/projects/${project.id}/coordination/claims/${claimed.claim.id}/submissions`, {
        method: "POST", headers, body: JSON.stringify({
          ...submitInput, idempotencyKey: `bound-output-submit-route-${crypto.randomUUID()}`,
        }),
      }] as [string, RequestInit]),
    ];
    for (const [path, init] of cases) {
      const response = await fetch(`${origin}${path}`, init);
      const text = await response.text();
      expect(response.status, path).toBe(500);
      expect(text).not.toContain(foreignTaskId);
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
    }
  });

  it("rejects duplicate, short-page, and repeated ready pagination output", async () => {
    const project = application.service.createProject({ name: "Bound ready pages" });
    const task = application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Ready page",
      body: "Keep page lineage bounded.", sourceKind: "human", sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Ready page worker", projectId: project.id,
    });
    const cursor = Buffer.from(JSON.stringify({ page: "private-ready-page" }), "utf8")
      .toString("base64url");
    const ready = { task, blockers: [], liveClaimId: null, liveDelegationId: null };
    vi.spyOn(application.service.coordination, "listReadyTasks")
      .mockReturnValueOnce({ tasks: [ready, ready], nextCursor: null, projectRevision: 1 })
      .mockReturnValueOnce({ tasks: [ready], nextCursor: cursor, projectRevision: 1 })
      .mockReturnValueOnce({ tasks: [ready], nextCursor: cursor, projectRevision: 1 });
    const headers = {
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const queries = [
      "expectedProjectRevision=1&limit=2",
      "expectedProjectRevision=1&limit=2",
      `expectedProjectRevision=1&limit=1&cursor=${encodeURIComponent(cursor)}`,
    ];
    for (const query of queries) {
      const response = await fetch(
        `${origin}/api/projects/${project.id}/coordination/ready?${query}`,
        { headers },
      );
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
      expect(text).not.toContain("private-ready-page");
    }
  });

  it("returns independently latest claims and delegations from valid real histories", async () => {
    const project = application.service.createProject({ name: "Independent state" });
    const tasks = ["Later direct claim", "Later delegation"].map((title) =>
      application.service.createRecord({
        projectId: project.id, kind: "task", status: "active", title,
        body: `${title} must remain observable.`, sourceKind: "human", sourceRef: null,
      })
    );
    const parent = application.service.profiles.createProfile({
      name: "State parent", projectId: project.id,
    });
    const child = application.service.profiles.createProfile({
      name: "State child", projectId: project.id,
    });
    for (const profileId of [parent.profile.id, child.profile.id]) {
      application.service.profiles.setAuthority({
        profileId, projectId: project.id, mode: "full_direct",
      });
    }
    const parentPrincipal = application.service.profiles.authenticate({
      profileId: parent.profile.id, token: parent.token,
    })!;
    const childPrincipal = application.service.profiles.authenticate({
      profileId: child.profile.id, token: child.token,
    })!;
    const checkpoint = {
      summary: "Historical delegated work", completedWork: ["Prepared result."],
      remainingWork: ["Release after review."], blockers: [],
      verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
      repositoryEvidence: null,
    };
    const createHistoricalDelegatedClaim = (taskId: string, suffix: string) => {
      const offered = application.service.coordination.createDelegation({
        projectId: project.id, taskId, childProfileId: child.profile.id,
        expectedProjectRevision: 2, expectedTaskRevision: 1,
        scope: { summary: "Historical delegated work.", constraints: [] },
        allowedOutputs: ["update_record"], deadline: "2026-07-29T13:00:00.000Z",
        idempotencyKey: `state-offer-${suffix}`,
      }, parentPrincipal);
      application.service.coordination.acceptDelegation({
        delegationId: offered.delegation.id, projectId: project.id, taskId,
        expectedProjectRevision: 2, expectedTaskRevision: 1,
        idempotencyKey: `state-accept-${suffix}`,
      }, childPrincipal);
      const claimed = application.service.coordination.claimTask({
        projectId: project.id, taskId, expectedProjectRevision: 2,
        expectedTaskRevision: 1, contextBudgetTokens: 1_000,
        acceptedDelegationId: offered.delegation.id,
        idempotencyKey: `state-claim-${suffix}`,
      }, childPrincipal);
      const saved = application.service.coordination.checkpointClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 2,
        expectedTaskRevision: 1, checkpoint,
        idempotencyKey: `state-checkpoint-${suffix}`,
      }, childPrincipal);
      const submitted = application.service.coordination.submitTaskResult({
        claimId: claimed.claim.id, checkpointId: saved.checkpoint.id,
        expectedProjectRevision: 2, expectedTaskRevision: 1,
        submission: {
          summary: "Historical delegated result.",
          verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
          repositoryEvidence: null,
          changes: { rationale: "Review historical work.", operations: [] },
        },
        idempotencyKey: `state-submit-${suffix}`,
      }, childPrincipal);
      application.service.proposals.reject({
        proposalId: submitted.proposal.id,
        reason: "Keep the task available for later coordination.",
      });
      application.service.coordination.transitionClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 2,
        expectedTaskRevision: 1, action: "release",
        idempotencyKey: `state-release-${suffix}`,
      }, childPrincipal);
      return { claimId: claimed.claim.id, delegationId: offered.delegation.id };
    };

    const directHistory = createHistoricalDelegatedClaim(tasks[0]!.id, "direct");
    const latestDirect = application.service.coordination.claimTask({
      projectId: project.id, taskId: tasks[0]!.id, expectedProjectRevision: 2,
      expectedTaskRevision: 1, contextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "state-latest-direct",
    }, parentPrincipal);

    const delegationHistory = createHistoricalDelegatedClaim(tasks[1]!.id, "delegation");
    const latestOffer = application.service.coordination.createDelegation({
      projectId: project.id, taskId: tasks[1]!.id, childProfileId: child.profile.id,
      expectedProjectRevision: 2, expectedTaskRevision: 1,
      scope: { summary: "Later independent offer.", constraints: [] },
      allowedOutputs: ["update_record"], deadline: "2026-07-29T13:00:00.000Z",
      idempotencyKey: "state-latest-offer",
    }, parentPrincipal);
    const headers = {
      "X-IntentArc-Profile-Id": parent.profile.id,
      Authorization: `Bearer ${parent.token}`,
    };
    for (const expected of [
      {
        taskId: tasks[0]!.id, claimId: latestDirect.claim.id,
        claimDelegationId: null, delegationId: directHistory.delegationId,
        delegationClaimId: directHistory.claimId,
      },
      {
        taskId: tasks[1]!.id, claimId: delegationHistory.claimId,
        claimDelegationId: delegationHistory.delegationId,
        delegationId: latestOffer.delegation.id, delegationClaimId: null,
      },
    ]) {
      const response = await fetch(
        `${origin}/api/projects/${project.id}/coordination/state?taskId=${expected.taskId}&expectedProjectRevision=2`,
        { headers },
      );
      const output = await response.json() as Record<string, any>;
      expect.soft(response.status, JSON.stringify(output)).toBe(200);
      if (response.status === 200) {
        expect(output).toMatchObject({
          claim: { id: expected.claimId, delegationId: expected.claimDelegationId },
          delegation: { id: expected.delegationId, claimId: expected.delegationClaimId },
        });
      }
    }
  });

  it("rejects schema-valid mismatched claim, switch, and submission relations without disclosure", async () => {
    const project = application.service.createProject({ name: "Nested relations" });
    const tasks = ["Current", "Next"].map((title) => application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title,
      body: `${title} nested relation.`, sourceKind: "human", sourceRef: null,
    }));
    const created = application.service.profiles.createProfile({
      name: "Nested worker", projectId: project.id,
    });
    application.service.profiles.setAuthority({
      profileId: created.profile.id, projectId: project.id, mode: "full_direct",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id, token: created.token,
    })!;
    const checkpoint = {
      summary: "Nested relation", completedWork: ["Prepared result."],
      remainingWork: ["Submit result."], blockers: [],
      verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
      repositoryEvidence: null,
    };
    const claimed = application.service.coordination.claimTask({
      projectId: project.id, taskId: tasks[0]!.id, expectedProjectRevision: 2,
      expectedTaskRevision: 1, contextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "nested-claim",
    }, principal);
    const switchInput = {
      currentClaimId: claimed.claim.id, projectId: project.id,
      currentTaskId: tasks[0]!.id, expectedCurrentProjectRevision: 2,
      expectedCurrentTaskRevision: 1, checkpoint, terminalAction: "release" as const,
      nextTaskId: tasks[1]!.id, expectedNextProjectRevision: 2,
      expectedNextTaskRevision: 1, nextContextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "nested-switch",
    };
    const switched = application.service.coordination.switchTask(switchInput, principal);
    const saved = application.service.coordination.checkpointClaim({
      claimId: switched.nextClaim.id, expectedProjectRevision: 2,
      expectedTaskRevision: 1, checkpoint, idempotencyKey: "nested-checkpoint",
    }, principal);
    const submitInput = {
      claimId: switched.nextClaim.id, checkpointId: saved.checkpoint.id,
      expectedProjectRevision: 2, expectedTaskRevision: 1,
      submission: {
        summary: "Nested submission",
        verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Complete nested submission.", operations: [] },
      },
      idempotencyKey: "nested-submit",
    };
    const submitted = application.service.coordination.submitTaskResult(submitInput, principal);
    vi.spyOn(application.service.coordination, "claimTask").mockReturnValue({
      ...claimed,
      claim: { ...claimed.claim, delegationId: "delegation-private" },
    });
    const switchVariants = [
      { ...switched, checkpoint: { ...switched.checkpoint, claimId: "claim-private" } },
      { ...switched, nextClaim: { ...switched.nextClaim, delegationId: "delegation-private" } },
    ];
    vi.spyOn(application.service.coordination, "switchTask")
      .mockImplementation(() => switchVariants.shift()!);
    const submissionVariants = [
      { ...submitted, proposal: { ...submitted.proposal, projectId: "project-private" } },
      { ...submitted, proposal: { ...submitted.proposal, sourceTaskId: "task-private" } },
      { ...submitted, proposal: { ...submitted.proposal, id: "proposal-private" } },
      { ...submitted, proposal: { ...submitted.proposal, origin: { type: "profile" as const, profileId: "profile-private" } } },
      { ...submitted, submission: { ...submitted.submission, taskId: "task-private" } },
      { ...submitted, submission: { ...submitted.submission, checkpointId: "checkpoint-private" } },
      { ...submitted, submission: { ...submitted.submission, profileId: "profile-private" } },
      { ...submitted, submission: { ...submitted.submission, contextPackId: "context-private" } },
    ];
    vi.spyOn(application.service.coordination, "submitTaskResult")
      .mockImplementation(() => submissionVariants.shift()!);
    const headers = {
      "content-type": "application/json",
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    const rejectionResults: Array<{ path: string; status: number; text: string }> = [];
    const rejectWithoutDisclosure = async (path: string, body: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const text = await response.text();
      rejectionResults.push({ path, status: response.status, text });
    };

    await rejectWithoutDisclosure(
      `/api/projects/${project.id}/coordination/claims`,
      {
        projectId: project.id, taskId: tasks[0]!.id, expectedProjectRevision: 2,
        expectedTaskRevision: 1, contextBudgetTokens: 1_000,
        acceptedDelegationId: "delegation-accepted", idempotencyKey: "nested-claim-route",
      },
    );
    await rejectWithoutDisclosure(
      `/api/projects/${project.id}/coordination/switch`,
      switchInput,
    );
    await rejectWithoutDisclosure(
      `/api/projects/${project.id}/coordination/switch`,
      { ...switchInput, acceptedDelegationId: "delegation-accepted" },
    );
    while (submissionVariants.length > 0) {
      await rejectWithoutDisclosure(
        `/api/projects/${project.id}/coordination/claims/${submitInput.claimId}/submissions`,
        submitInput,
      );
    }
    for (const result of rejectionResults) {
      expect.soft(result.status, result.path).toBe(500);
      if (result.status === 500) {
        expect(JSON.parse(result.text)).toMatchObject({ error: { code: "internal_error" } });
      }
      expect.soft(result.text, result.path).not.toMatch(/private/i);
    }
  });

  it("binds every claim-scoped coordination mutation to the route project before store mutation", async () => {
    const project = application.service.createProject({ name: "Claim project" });
    const task = application.service.createRecord({
      projectId: project.id, kind: "task", status: "active", title: "Claimed task",
      body: "Keep claim mutations project-bound.", sourceKind: "human", sourceRef: null,
    });
    const foreign = application.service.createProject({ name: "Wrong route project" });
    const created = application.service.profiles.createProfile({
      name: "Claim owner", projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id, token: created.token,
    })!;
    const claim = application.service.coordination.claimTask({
      projectId: project.id, taskId: task.id, expectedProjectRevision: 1,
      expectedTaskRevision: 1, contextBudgetTokens: 1_000,
      acceptedDelegationId: null, idempotencyKey: "route-claim",
    }, principal).claim;
    const checkpoint = {
      summary: "Wrong route", completedWork: [], remainingWork: [], blockers: [],
      verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null,
    };
    const bodies = [
      [`renew`, { claimId: claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1, idempotencyKey: "wrong-renew" }],
      [`checkpoints`, { claimId: claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1, checkpoint, idempotencyKey: "wrong-checkpoint" }],
      [`transition`, { claimId: claim.id, expectedProjectRevision: 1, expectedTaskRevision: 1, action: "pause", idempotencyKey: "wrong-transition" }],
      [`submissions`, { claimId: claim.id, checkpointId: "checkpoint-never-read", expectedProjectRevision: 1, expectedTaskRevision: 1, submission: { summary: "Wrong project", verificationEvidence: { tests: [], artifacts: [] }, repositoryEvidence: null, changes: { rationale: "Must reject.", operations: [] } }, idempotencyKey: "wrong-submit" }],
    ] as const;
    const counts = () => {
      const database = new Database(temporaryDatabase.path, { readonly: true });
      try {
        return database.prepare(`SELECT
          (SELECT COUNT(*) FROM task_claims) AS claims,
          (SELECT COUNT(*) FROM task_checkpoints) AS checkpoints,
          (SELECT COUNT(*) FROM task_submissions) AS submissions,
          (SELECT COUNT(*) FROM coordination_events) AS events,
          (SELECT COUNT(*) FROM coordination_idempotency) AS replays`).get();
      } finally { database.close(); }
    };
    const before = counts();
    const headers = {
      "content-type": "application/json",
      "X-IntentArc-Profile-Id": created.profile.id,
      Authorization: `Bearer ${created.token}`,
    };
    for (const [suffix, body] of bodies) {
      const response = await fetch(
        `${origin}/api/projects/${foreign.id}/coordination/claims/${claim.id}/${suffix}`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      expect(response.status, suffix).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "coordination_authority_denied" },
      });
      expect(counts()).toEqual(before);
    }
  });
});
