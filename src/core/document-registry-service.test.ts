import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RepositoryDocumentFormat,
  RepositoryDocumentKind,
  RepositoryObservationCandidate,
  RepositoryObservationInput,
} from "../domain/repository-index-model.js";
import type { RepositorySourceRole } from "../domain/import-model.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createProjectStore } from "../storage/project-store.js";
import { createRepositoryIndexStore } from "../storage/repository-index-store.js";
import { MAX_PREVIEW_FILE_BYTES } from "../repository/safe-file-reader.js";
import {
  createDocumentRegistryService,
  DocumentNotFoundError,
} from "./document-registry-service.js";

const createdAt = "2026-08-02T12:00:00.000Z";
const decidedAt = "2026-08-02T12:01:00.000Z";
const appliedAt = "2026-08-02T12:01:01.000Z";

const sha256 = (content: Buffer | string): string =>
  createHash("sha256").update(content).digest("hex");

interface DocumentFixture {
  readonly path: string;
  readonly content?: Buffer | string;
  readonly role: RepositorySourceRole;
  readonly documentKind: RepositoryDocumentKind | null;
  readonly documentFormat: RepositoryDocumentFormat;
  readonly contentEligible?: boolean;
}

const documents: readonly DocumentFixture[] = [
  {
    path: ".env",
    content: "TOKEN=blocked\n",
    role: "canonical_source",
    documentKind: "unlinked",
    documentFormat: "plain_text",
  },
  {
    path: "AGENTS.md",
    content: "# Agent instructions\n",
    role: "canonical_source",
    documentKind: "ai_instruction",
    documentFormat: "markdown",
  },
  {
    path: "assets/diagram.png",
    content: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]),
    role: "asset",
    documentKind: null,
    documentFormat: "image",
  },
  {
    path: "decisions/ADR-1.md",
    content: "# Decision\n",
    role: "supporting_document",
    documentKind: "decision_support",
    documentFormat: "markdown",
  },
  {
    path: "docs/archive.docx",
    content: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    role: "supporting_document",
    documentKind: null,
    documentFormat: "unsupported",
    contentEligible: false,
  },
  {
    path: "docs/architecture.pdf",
    content: Buffer.from("%PDF-1.7\naccepted preview\n"),
    role: "supporting_document",
    documentKind: "specification",
    documentFormat: "pdf",
  },
  {
    path: "docs/missing.md",
    role: "supporting_document",
    documentKind: "specification",
    documentFormat: "markdown",
  },
  {
    path: "docs/overview.md",
    content: "# Overview\n",
    role: "supporting_document",
    documentKind: "overview",
    documentFormat: "markdown",
  },
  {
    path: "docs/spec.md",
    content: "# Specification\n",
    role: "supporting_document",
    documentKind: "specification",
    documentFormat: "markdown",
  },
  {
    path: "operations/runbook.txt",
    content: "restart safely\n",
    role: "supporting_document",
    documentKind: "operational_guide",
    documentFormat: "plain_text",
  },
  {
    path: "tests/evidence.md",
    content: "# Passing evidence\n",
    role: "test",
    documentKind: "test_evidence",
    documentFormat: "markdown",
  },
];

const observationFor = (fixture: DocumentFixture): RepositoryObservationInput => {
  const content = fixture.content ?? "missing accepted content\n";
  return {
    path: fixture.path,
    kind: "file",
    sha256: sha256(content),
    byteSize: Buffer.byteLength(content),
    sourceStatus: "tracked",
    role: fixture.role,
    documentKind: fixture.documentKind,
    documentFormat: fixture.documentFormat,
    contentEligible: fixture.contentEligible ?? true,
    instructionClient: fixture.documentKind === "ai_instruction" ? "codex" : null,
    instructionScope: fixture.documentKind === "ai_instruction" ? "repository" : null,
  };
};

const candidateFor = (
  root: string,
  observations: readonly RepositoryObservationInput[],
  links: RepositoryObservationCandidate["links"] = [],
  fingerprint = "a".repeat(64),
): RepositoryObservationCandidate => ({
  root: root.replaceAll("\\", "/"),
  canonicalSubpath: null,
  repositoryIdentity: "git:document-registry-fixture",
  branch: "main",
  head: "b".repeat(40),
  fingerprint,
  scannerVersion: "1",
  rulesetVersion: "1",
  warnings: [],
  exclusions: [],
  findingCounts: {},
  observations: [...observations],
  links: [...links],
});

describe("document registry service", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;
  let root: string | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
    if (root) rmSync(root, { recursive: true, force: true });
    database = undefined;
    temporaryDatabase = undefined;
    root = undefined;
  });

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "intentarc documents "));
    for (const fixture of documents) {
      if (fixture.content === undefined) continue;
      const absolutePath = join(root, ...fixture.path.split("/"));
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, fixture.content);
    }
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, { now: () => createdAt });
    let id = 0;
    const newId = (prefix: string): string => `${prefix}-${++id}`;
    const projectStore = createProjectStore(database, {
      now: () => createdAt,
      newId,
    });
    const store = createRepositoryIndexStore(database, {
      now: () => createdAt,
      newId,
    });
    const project = projectStore.createProject({ name: "Documents" });
    const currentTask = projectStore.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Current task",
      body: "Use the accepted documentation.",
      sourceKind: "human",
      sourceRef: null,
    });
    const component = projectStore.createRecord({
      projectId: project.id,
      kind: "component",
      status: "accepted",
      title: "Registry component",
      body: "The documentation registry.",
      sourceKind: "human",
      sourceRef: null,
    });
    const review = store.createCandidate({
      projectId: project.id,
      baseProjectRevision: projectStore.getProject(project.id)!.revision,
      candidate: candidateFor(
        root,
        documents.map(observationFor),
        [
          {
            fromPath: "docs/spec.md",
            toRecordId: currentTask.id,
            toPath: null,
            kind: "documents",
            basis: "accepted",
          },
          {
            fromPath: "docs/spec.md",
            toRecordId: component.id,
            toPath: null,
            kind: "implements",
            basis: "inferred",
          },
          {
            fromPath: "decisions/ADR-1.md",
            toRecordId: component.id,
            toPath: null,
            kind: "documents",
            basis: "conflicting",
          },
        ],
      ),
    });
    store.promoteCandidate({
      projectId: project.id,
      snapshotId: review.snapshotId,
      decidedAt,
      appliedAt,
    });
    const nodeId = (path: string): string =>
      store.listObservations(review.snapshotId)
        .find((observation) => observation.path === path)!.nodeId;
    return {
      project,
      currentTask,
      component,
      projectStore,
      store,
      snapshotId: review.snapshotId,
      nodeId,
      service: createDocumentRegistryService({ projectStore, store }),
    };
  };

  const setupSingleDocument = (fixture: DocumentFixture) => {
    root = mkdtempSync(join(tmpdir(), "intentarc single document "));
    const absolutePath = join(root, ...fixture.path.split("/"));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, fixture.content!);
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, { now: () => createdAt });
    let id = 0;
    const newId = (prefix: string): string => `${prefix}-${++id}`;
    const projectStore = createProjectStore(database, {
      now: () => createdAt,
      newId,
    });
    const store = createRepositoryIndexStore(database, {
      now: () => createdAt,
      newId,
    });
    const project = projectStore.createProject({ name: "One document" });
    const review = store.createCandidate({
      projectId: project.id,
      baseProjectRevision: project.revision,
      candidate: candidateFor(root, [observationFor(fixture)]),
    });
    store.promoteCandidate({
      projectId: project.id,
      snapshotId: review.snapshotId,
      decidedAt,
      appliedAt,
    });
    return {
      project,
      snapshotId: review.snapshotId,
      nodeId: store.listObservations(review.snapshotId)[0]!.nodeId,
      service: createDocumentRegistryService({ projectStore, store }),
    };
  };

  it("lists accepted documents in ordinal order with deterministic facets and every approved filter", () => {
    const { service, project, currentTask, component } = setup();
    const all = service.list(project.id, {});

    expect(all.projectId).toBe(project.id);
    expect(all.snapshotId).toBe(all.documents[0]!.snapshotId);
    expect(service.list(project.id, { locationPrefix: "not-present" }).snapshotId)
      .toBe(all.snapshotId);
    expect(all.documents.map(({ path }) => path)).toEqual([
      ".env",
      "AGENTS.md",
      "assets/diagram.png",
      "decisions/ADR-1.md",
      "docs/architecture.pdf",
      "docs/archive.docx",
      "docs/missing.md",
      "docs/overview.md",
      "docs/spec.md",
      "operations/runbook.txt",
      "tests/evidence.md",
    ]);
    expect(all.facets.documentKinds).toEqual([
      { value: "ai_instruction", count: 1 },
      { value: "decision_support", count: 1 },
      { value: "operational_guide", count: 1 },
      { value: "overview", count: 1 },
      { value: "specification", count: 3 },
      { value: "test_evidence", count: 1 },
      { value: "unlinked", count: 3 },
    ]);
    expect(all.facets.formats).toEqual([
      { value: "image", count: 1 },
      { value: "markdown", count: 6 },
      { value: "pdf", count: 1 },
      { value: "plain_text", count: 2 },
      { value: "unsupported", count: 1 },
    ]);
    expect(all.facets.roles).toEqual([
      { value: "asset", count: 1 },
      { value: "canonical_source", count: 2 },
      { value: "supporting_document", count: 7 },
      { value: "test", count: 1 },
    ]);
    expect(all.facets.freshness).toEqual([
      { value: "blocked", count: 1 },
      { value: "current", count: 9 },
      { value: "missing", count: 1 },
    ]);

    expect(service.list(project.id, { locationPrefix: "docs" }).documents)
      .toHaveLength(5);
    expect(service.list(project.id, { role: "test" }).documents.map(({ path }) => path))
      .toEqual(["tests/evidence.md"]);
    expect(service.list(project.id, { format: "pdf" }).documents.map(({ path }) => path))
      .toEqual(["docs/architecture.pdf"]);
    expect(service.list(project.id, { linkedRecordId: component.id }).documents.map(({ path }) => path))
      .toEqual(["decisions/ADR-1.md", "docs/spec.md"]);
    expect(service.list(project.id, { relevance: "current_task" }).documents.map(({ path }) => path))
      .toEqual(["docs/spec.md"]);
    expect(service.list(project.id, { freshness: "missing" }).documents.map(({ path }) => path))
      .toEqual(["docs/missing.md"]);
    expect(service.list(project.id, { linkBasis: "inferred" }).documents.map(({ path }) => path))
      .toEqual(["docs/spec.md"]);
    expect(service.list(project.id, { unlinked: true }).documents.map(({ path }) => path))
      .toEqual([
        ".env",
        "AGENTS.md",
        "assets/diagram.png",
        "docs/architecture.pdf",
        "docs/archive.docx",
        "docs/missing.md",
        "docs/overview.md",
        "operations/runbook.txt",
        "tests/evidence.md",
      ]);
    expect(currentTask.id).not.toBe(component.id);
    expect(JSON.stringify(all)).not.toContain(root!.replaceAll("\\", "/"));
  });

  it("returns grouped detail links and explicit native/external-open capabilities", () => {
    const { service, project, nodeId, component, currentTask } = setup();

    expect(service.get(project.id, nodeId("docs/spec.md"))).toEqual({
      document: expect.objectContaining({
        path: "docs/spec.md",
        freshness: "current",
      }),
      linksByBasis: {
        accepted: [expect.objectContaining({ toRecordId: currentTask.id })],
        conflicting: [],
        inferred: [expect.objectContaining({ toRecordId: component.id })],
        observed: [],
      },
      nativeCapability: "renderable",
      externalOpenEligible: true,
    });
    expect(service.get(project.id, nodeId("docs/archive.docx"))).toMatchObject({
      nativeCapability: "unsupported",
      externalOpenEligible: true,
    });
    expect(service.get(project.id, nodeId(".env"))).toMatchObject({
      nativeCapability: "blocked",
      externalOpenEligible: false,
    });
    expect(() => service.get(project.id, "missing-node"))
      .toThrow(new DocumentNotFoundError("missing-node"));
  });

  it("reads bounded accepted Markdown and text while returning capabilities for preview and unsupported files", () => {
    const { service, project, nodeId, snapshotId } = setup();

    expect(service.read(project.id, nodeId("docs/overview.md"), snapshotId)).toEqual({
      status: "renderable",
      format: "markdown",
      text: "# Overview\n",
      sha256: sha256("# Overview\n"),
    });
    expect(service.read(project.id, nodeId("operations/runbook.txt"), snapshotId)).toMatchObject({
      status: "renderable",
      format: "plain_text",
      text: "restart safely\n",
    });
    expect(service.read(project.id, nodeId("assets/diagram.png"), snapshotId)).toEqual({
      status: "previewable",
      format: "image",
      sha256: sha256(documents[2]!.content!),
    });
    expect(service.read(project.id, nodeId("docs/archive.docx"), snapshotId)).toEqual({
      status: "unsupported",
      format: "unsupported",
    });
    expect(service.read(project.id, nodeId(".env"), snapshotId)).toEqual({ status: "blocked" });
    expect(service.read(project.id, nodeId("docs/missing.md"), snapshotId)).toEqual({ status: "missing" });
  });

  it("revalidates an accepted node before resolving its absolute external-open target", () => {
    const { service, project, nodeId } = setup();
    const externalOpen = service as typeof service & {
      resolveExternalOpen(projectId: string, nodeId: string):
        | { status: "openable"; absolutePath: string }
        | { status: "stale" | "missing" | "unavailable" | "blocked" };
    };
    const overview = nodeId("docs/overview.md");

    expect(externalOpen.resolveExternalOpen(project.id, overview)).toEqual({
      status: "openable",
      absolutePath: join(root!, "docs", "overview.md"),
    });

    writeFileSync(join(root!, "docs", "overview.md"), "# Changed before open\n");
    expect(externalOpen.resolveExternalOpen(project.id, overview))
      .toEqual({ status: "stale" });
    expect(externalOpen.resolveExternalOpen(project.id, nodeId(".env")))
      .toEqual({ status: "blocked" });
  });

  it("returns only exact allow-listed image and PDF previews after accepted size and hash checks", () => {
    const { service, project, nodeId, snapshotId } = setup();

    expect(service.readPreview(project.id, nodeId("assets/diagram.png"), snapshotId)).toEqual({
      status: "previewable",
      format: "image",
      mediaType: "image/png",
      bytes: documents[2]!.content,
      sha256: sha256(documents[2]!.content!),
    });
    expect(service.readPreview(project.id, nodeId("docs/architecture.pdf"), snapshotId)).toEqual({
      status: "previewable",
      format: "pdf",
      mediaType: "application/pdf",
      bytes: documents[5]!.content,
      sha256: sha256(documents[5]!.content!),
    });
    expect(service.readPreview(project.id, nodeId("docs/overview.md"), snapshotId))
      .toEqual({ status: "unsupported" });
  });

  it("rejects an accepted image observation whose bytes do not match an allow-listed image media type", () => {
    const { service, project, nodeId, snapshotId } = setupSingleDocument({
      path: "docs/disguised.png",
      content: Buffer.from("not-an-image"),
      role: "supporting_document",
      documentKind: "unlinked",
      documentFormat: "image",
    });

    expect(service.readPreview(project.id, nodeId, snapshotId)).toEqual({ status: "stale" });
  });

  it("rejects an oversized accepted preview without returning or allocating its body", () => {
    const { service, project, nodeId, snapshotId } = setupSingleDocument({
      path: "docs/oversized.pdf",
      content: Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1, 0x25),
      role: "supporting_document",
      documentKind: "unlinked",
      documentFormat: "pdf",
    });

    expect(service.readPreview(project.id, nodeId, snapshotId)).toEqual({ status: "unsupported" });
  });

  it("reads only the current accepted snapshot and never treats a matching pending candidate as accepted", () => {
    const { service, project, projectStore, store, nodeId, snapshotId } = setup();
    writeFileSync(join(root!, "docs", "overview.md"), "# Pending\n");
    store.createCandidate({
      projectId: project.id,
      baseProjectRevision: projectStore.getProject(project.id)!.revision,
      candidate: candidateFor(
        root!,
        [{
          ...observationFor(documents[7]!),
          sha256: sha256("# Pending\n"),
          byteSize: Buffer.byteLength("# Pending\n"),
        }],
        [],
        "c".repeat(64),
      ),
    });

    expect(service.get(project.id, nodeId("docs/overview.md")).document)
      .toMatchObject({ snapshotId: expect.any(String), freshness: "stale" });
    expect(service.read(project.id, nodeId("docs/overview.md"), snapshotId))
      .toEqual({ status: "stale" });
  });

  it("fails closed when text or preview reads race from accepted snapshot A to B", () => {
    const { service, project, projectStore, store, snapshotId } = setup();
    const secondReview = store.createCandidate({
      projectId: project.id,
      baseProjectRevision: projectStore.getProject(project.id)!.revision,
      candidate: candidateFor(root!, documents.map(observationFor), [], "d".repeat(64)),
    });
    store.promoteCandidate({
      projectId: project.id,
      snapshotId: secondReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const acceptedB = service.list(project.id, {});
    const textNodeB = acceptedB.documents.find(({ path }) => path === "docs/overview.md")!;
    const imageNodeB = acceptedB.documents.find(({ path }) => path === "assets/diagram.png")!;

    expect(acceptedB.snapshotId).not.toBe(snapshotId);
    expect(service.read(project.id, textNodeB.nodeId, snapshotId))
      .toEqual({ status: "stale" });
    expect(service.readPreview(project.id, imageNodeB.nodeId, snapshotId))
      .toEqual({ status: "stale" });
    expect(service.read(project.id, textNodeB.nodeId, acceptedB.snapshotId!))
      .toMatchObject({ status: "renderable", text: "# Overview\n" });
    expect(service.readPreview(project.id, imageNodeB.nodeId, acceptedB.snapshotId!))
      .toMatchObject({ status: "previewable", mediaType: "image/png" });
  });

  it.each([
    ["text", "docs/overview.md"],
    ["preview", "assets/diagram.png"],
  ] as const)("rechecks the accepted snapshot after a %s file read", (kind, path) => {
    const { project, projectStore, store, snapshotId, nodeId } = setup();
    const secondReview = store.createCandidate({
      projectId: project.id,
      baseProjectRevision: projectStore.getProject(project.id)!.revision,
      candidate: candidateFor(root!, documents.map(observationFor), [], "e".repeat(64)),
    });
    let targetOpenCount = 0;
    let promoted = false;
    const racing = createDocumentRegistryService({
      projectStore,
      store,
      readerDependencies: {
        openFileForRead: (absolutePath, flags) => {
          if (absolutePath === join(root!, ...path.split("/"))) targetOpenCount += 1;
          return openSync(absolutePath, flags);
        },
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          const count = readSync(descriptor, buffer, offset, length, position);
          if (!promoted && targetOpenCount === 3) {
            promoted = true;
            store.promoteCandidate({
              projectId: project.id,
              snapshotId: secondReview.snapshotId,
              decidedAt,
              appliedAt,
            });
          }
          return count;
        },
      },
    });

    const result = kind === "text"
      ? racing.read(project.id, nodeId(path), snapshotId)
      : racing.readPreview(project.id, nodeId(path), snapshotId);

    expect(promoted).toBe(true);
    expect(result).toEqual({ status: "stale" });
  });

  it("fails closed on hash drift, source loss, and descriptor replacement races without leaking roots or bytes", () => {
    const { service, project, nodeId, projectStore, store, snapshotId } = setup();
    const overview = nodeId("docs/overview.md");
    writeFileSync(join(root!, "docs", "overview.md"), "# Changed!\n");

    expect(service.get(project.id, overview).document.freshness).toBe("stale");
    expect(service.read(project.id, overview, snapshotId)).toEqual({ status: "stale" });
    expect(JSON.stringify(service.read(project.id, overview, snapshotId))).not.toContain(root!);

    rmSync(root!, { recursive: true, force: true });
    expect(service.read(project.id, overview, snapshotId)).toEqual({ status: "unavailable" });

    mkdirSync(join(root!, "docs"), { recursive: true });
    writeFileSync(join(root!, "docs", "overview.md"), "# Overview\n");
    let replaced = false;
    const racing = createDocumentRegistryService({
      projectStore,
      store,
      readerDependencies: {
        readFileChunk: (descriptor, buffer, offset, length, position) => {
          const count = readSync(descriptor, buffer, offset, length, position);
          if (!replaced) {
            replaced = true;
            const original = join(root!, "docs", "overview.md");
            renameSync(original, join(root!, "docs", "before-race.md"));
            writeFileSync(original, "OUTSIDE-ACCEPTED-CANARY\n");
          }
          return count;
        },
      },
    });
    const result = racing.read(project.id, overview, snapshotId);
    expect(result).toEqual({ status: "stale" });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("does not touch a source that the repository index marks unavailable", () => {
    const { service, project, nodeId, snapshotId } = setup();
    database!.prepare(
      "UPDATE repository_sources SET status = 'unavailable' WHERE project_id = ?",
    ).run(project.id);

    expect(service.read(project.id, nodeId("docs/overview.md"), snapshotId))
      .toEqual({ status: "unavailable" });
  });

  it("blocks a counterfeit accepted observation beneath a hard-excluded directory", () => {
    const { service, project, nodeId, snapshotId } = setupSingleDocument({
      path: ".git/private.md",
      content: "DO-NOT-READ\n",
      role: "supporting_document",
      documentKind: "unlinked",
      documentFormat: "markdown",
    });

    expect(service.read(project.id, nodeId, snapshotId)).toEqual({ status: "blocked" });
  });

  it("treats a counterfeit accepted Markdown observation with NUL bytes as stale", () => {
    const { service, project, nodeId, snapshotId } = setupSingleDocument({
      path: "docs/counterfeit.md",
      content: Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62]),
      role: "supporting_document",
      documentKind: "specification",
      documentFormat: "markdown",
    });

    expect(service.read(project.id, nodeId, snapshotId)).toEqual({ status: "stale" });
  });

  it("treats a counterfeit accepted text observation with invalid UTF-8 as stale", () => {
    const { service, project, nodeId, snapshotId } = setupSingleDocument({
      path: "docs/counterfeit.txt",
      content: Buffer.from([0xc3, 0x28]),
      role: "supporting_document",
      documentKind: "operational_guide",
      documentFormat: "plain_text",
    });

    expect(service.read(project.id, nodeId, snapshotId)).toEqual({ status: "stale" });
  });

  it("does not persist document bodies while listing or reading", () => {
    const { service, project, nodeId, snapshotId } = setup();
    service.list(project.id, {});
    service.read(project.id, nodeId("docs/overview.md"), snapshotId);

    const columns = database!.prepare(
      "PRAGMA table_info(repository_node_observations)",
    ).all() as { name: string }[];
    expect(columns.map(({ name }) => name)).not.toContain("content");
    expect(JSON.stringify(database!.prepare(
      "SELECT * FROM repository_node_observations",
    ).all())).not.toContain("# Overview");
  });
});
