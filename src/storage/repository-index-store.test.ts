import { afterEach, describe, expect, it } from "vitest";
import type {
  RepositoryObservationCandidate,
  RepositoryObservationInput,
} from "../domain/repository-index-model.js";
import type { TaskContextPack } from "../domain/model.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { createContextPackStore } from "./context-pack-store.js";
import { createProjectStore, type ProjectStore } from "./project-store.js";
import {
  createRepositoryIndexStore,
  RepositoryRefreshConflictError,
  RepositorySourceConflictError,
  type RepositoryIndexStore,
  type RepositoryIndexStoreIdPrefix,
} from "./repository-index-store.js";

const createdAt = "2026-08-02T10:00:00.000Z";
const decidedAt = "2026-08-02T11:00:00.000Z";
const appliedAt = "2026-08-02T11:00:01.000Z";

const directory = (path: string): RepositoryObservationInput => ({
  path,
  kind: "directory",
  sha256: null,
  byteSize: 0,
  sourceStatus: "derived",
  role: "supporting_document",
  documentKind: null,
  documentFormat: null,
  contentEligible: false,
  instructionClient: null,
  instructionScope: null,
});

const markdown = (
  path: string,
  hashCharacter: string,
): RepositoryObservationInput => ({
  path,
  kind: "file",
  sha256: hashCharacter.repeat(64),
  byteSize: 42,
  sourceStatus: "tracked",
  role: "supporting_document",
  documentKind: "specification",
  documentFormat: "markdown",
  contentEligible: true,
  instructionClient: null,
  instructionScope: null,
});

const candidate = (
  overrides: Partial<RepositoryObservationCandidate> = {},
): RepositoryObservationCandidate => ({
  root: "C:/projects/example",
  canonicalSubpath: null,
  repositoryIdentity: "git:example",
  branch: "main",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
  scannerVersion: "scanner-1",
  rulesetVersion: "rules-1",
  warnings: [{ code: "working_tree_dirty", count: 2 }],
  exclusions: [
    { path: null, reason: "known_secret_path", count: 1 },
    { path: "vendor", reason: "ignored", count: 3 },
  ],
  findingCounts: { stale: 1 },
  observations: [
    markdown("z-last.md", "c"),
    markdown("docs/guide.md", "d"),
    directory("docs"),
  ],
  links: [],
  ...overrides,
});

const createCounterIds = () => {
  const counts = new Map<string, number>();
  return (prefix: string): string => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
};

describe("repository index store", () => {
  let database: IntentArcDatabase | undefined;
  let projectStore: ProjectStore | undefined;
  let store: RepositoryIndexStore | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    projectStore = undefined;
    store = undefined;
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
    temporaryDatabase = undefined;
  });

  const setup = () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, {
      now: () => createdAt,
      storeId: "store-repository-index",
    });
    const projectIds = createCounterIds();
    projectStore = createProjectStore(database, {
      now: () => createdAt,
      newId: (prefix) => projectIds(prefix),
    });
    const repositoryIds = createCounterIds();
    store = createRepositoryIndexStore(database, {
      now: () => createdAt,
      newId: (prefix: RepositoryIndexStoreIdPrefix) => repositoryIds(prefix),
    });
    return {
      database,
      projectStore,
      store,
    };
  };

  const createProject = (name = "Example") => {
    const project = projectStore!.createProject({ name });
    return project;
  };

  const ensureSource = (projectId: string) =>
    store!.ensureSource({
      projectId,
      root: "C:/projects/example",
      canonicalSubpath: null,
      repositoryIdentity: "git:example",
      status: "available",
    });

  const createCandidate = (
    projectId: string,
    value: RepositoryObservationCandidate = candidate(),
  ) => store!.createCandidate({
    projectId,
    baseProjectRevision: projectStore!.getProject(projectId)!.revision,
    candidate: value,
  });

  it("creates one strictly idempotent source and rejects identity, location, or status drift", () => {
    setup();
    const project = createProject();

    const first = ensureSource(project.id);
    const replay = ensureSource(project.id);

    expect(replay).toEqual(first);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_sources").get())
      .toEqual({ count: 1 });
    expect(() => store!.ensureSource({
      projectId: project.id,
      root: "C:/projects/elsewhere",
      canonicalSubpath: null,
      repositoryIdentity: "git:example",
      status: "available",
    })).toThrow(RepositorySourceConflictError);
    expect(() => store!.ensureSource({
      projectId: project.id,
      root: "C:/projects/example",
      canonicalSubpath: null,
      repositoryIdentity: "git:other",
      status: "available",
    })).toThrow(RepositorySourceConflictError);
    expect(() => store!.ensureSource({
      projectId: project.id,
      root: "C:/projects/example",
      canonicalSubpath: null,
      repositoryIdentity: "git:example",
      status: "detached",
    })).toThrow(RepositorySourceConflictError);
    expect(store!.getSource(project.id)).toEqual(first);
  });

  it("atomically persists a candidate, derived counts, ordinal observations, parents, and both link target forms", () => {
    setup();
    const project = createProject();
    const record = projectStore!.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Repository decision",
      body: "The guide documents this decision.",
      sourceKind: "human",
      sourceRef: null,
    });
    const value = candidate({
      links: [
        {
          fromPath: "z-last.md",
          toRecordId: null,
          toPath: "docs/guide.md",
          kind: "related_to",
          basis: "observed",
        },
        {
          fromPath: "docs/guide.md",
          toRecordId: record.id,
          toPath: null,
          kind: "documents",
          basis: "accepted",
        },
      ],
    });

    const review = createCandidate(project.id, value);

    expect(review).toEqual({
      projectId: project.id,
      sourceId: "repository-source-1",
      snapshotId: "repository-snapshot-1",
      state: "pending",
      selectedOperationIds: [],
      createdAt,
      updatedAt: createdAt,
      decidedAt: null,
    });
    expect(store!.getSnapshot(review.snapshotId)).toMatchObject({
      sourceId: review.sourceId,
      projectId: project.id,
      state: "candidate",
      baseSnapshotId: null,
      baseProjectRevision: 1,
      warningCounts: { working_tree_dirty: 2 },
      exclusionCounts: { ignored: 3, known_secret_path: 1 },
      findingCounts: { stale: 1 },
    });
    const observations = store!.listObservations(review.snapshotId);
    expect(observations.map(({ path }) => path)).toEqual([
      "docs",
      "docs/guide.md",
      "z-last.md",
    ]);
    const directoryNode = observations.find(({ path }) => path === "docs")!;
    expect(observations.find(({ path }) => path === "docs/guide.md"))
      .toMatchObject({ parentNodeId: directoryNode.nodeId });
    expect(store!.listLinks(project.id)).toEqual([
      expect.objectContaining({
        id: "repository-link-1",
        toRecordId: null,
        toNodeId: observations.find(({ path }) => path === "docs/guide.md")!.nodeId,
      }),
      expect.objectContaining({
        id: "repository-link-2",
        toRecordId: record.id,
        toNodeId: null,
      }),
    ]);
    expect(database!.prepare(`
      SELECT DISTINCT source_id FROM repository_node_observations
    `).all()).toEqual([{ source_id: review.sourceId }]);
    expect(database!.prepare(`
      SELECT DISTINCT source_id FROM repository_links
    `).all()).toEqual([{ source_id: review.sourceId }]);
    expect(projectStore!.getProject(project.id)!.revision).toBe(1);
  });

  it("re-reads a pending candidate after a database restart", () => {
    setup();
    const project = createProject();
    const review = createCandidate(project.id);
    const path = temporaryDatabase!.path;

    database!.close();
    database = openDatabase(path, { storeId: "store-repository-index-restart" });
    store = createRepositoryIndexStore(database);

    expect(store.getPendingReview(project.id)).toEqual(review);
    expect(store.getSnapshot(review.snapshotId)).toMatchObject({
      id: review.snapshotId,
      fingerprint: "b".repeat(64),
    });
    expect(store.listObservations(review.snapshotId).map(({ path: itemPath }) => itemPath))
      .toEqual(["docs", "docs/guide.md", "z-last.md"]);
  });

  it("persists a unique review selection and enforces project and lifecycle ownership", () => {
    setup();
    const project = createProject();
    const otherProject = createProject("Other");
    const review = createCandidate(project.id);

    expect(store!.saveReviewSelection({
      projectId: project.id,
      snapshotId: review.snapshotId,
      selectedOperationIds: ["operation-b", "operation-a"],
    })).toMatchObject({
      selectedOperationIds: ["operation-b", "operation-a"],
    });
    expect(() => store!.saveReviewSelection({
      projectId: project.id,
      snapshotId: review.snapshotId,
      selectedOperationIds: ["operation-a", "operation-a"],
    })).toThrow();
    expect(() => store!.saveReviewSelection({
      projectId: otherProject.id,
      snapshotId: review.snapshotId,
      selectedOperationIds: [],
    })).toThrow();

    store!.cancelCandidate(review.snapshotId, decidedAt);
    expect(() => store!.saveReviewSelection({
      projectId: project.id,
      snapshotId: review.snapshotId,
      selectedOperationIds: [],
    })).toThrow();
  });

  it("promotes current candidates without changing authoritative project state or prior accepted snapshots", () => {
    setup();
    const project = createProject();
    const firstReview = createCandidate(project.id);

    const first = store!.promoteCandidate({
      projectId: project.id,
      snapshotId: firstReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const secondReview = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
      observations: [markdown("README.md", "f")],
    }));
    const second = store!.promoteCandidate({
      projectId: project.id,
      snapshotId: secondReview.snapshotId,
      decidedAt: "2026-08-02T12:00:00.000Z",
      appliedAt: "2026-08-02T12:00:01.000Z",
    });

    expect(first).toMatchObject({ state: "accepted", baseSnapshotId: null });
    expect(second).toMatchObject({
      state: "accepted",
      baseSnapshotId: first.id,
    });
    expect(store!.getCurrentSnapshot(project.id)).toEqual(second);
    expect(store!.getSnapshot(first.id)).toEqual(first);
    expect(store!.listObservations(first.id)).toHaveLength(3);
    expect(store!.getPendingReview(project.id)).toBeNull();
    expect(projectStore!.getProject(project.id)).toMatchObject({ revision: 0 });
  });

  it("queries only bounded accepted Explorer children with deterministic filters and cursors", () => {
    setup();
    const project = createProject();
    const task = projectStore!.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Explore the repository",
      body: "Use accepted links only.",
      sourceKind: "human",
      sourceRef: null,
    });
    const contextPack: TaskContextPack = {
      id: "context-pack-large",
      projectId: project.id,
      taskId: task.id,
      projectRevision: projectStore!.getProject(project.id)!.revision,
      generatedAt: createdAt,
      budgetTokens: 200_000,
      estimatedTokens: 100,
      stableFrame: [],
      task: {
        record: task,
        mandatory: true,
        relevance: "active_task",
        relationshipKind: null,
      },
      related: [],
      omissions: [],
      sourceRevisions: Array.from({ length: 32_767 }, (_, index) => ({
        recordId: index === 32_766 ? task.id : `synthetic-record-${index}`,
        revision: 1,
      })),
    };
    createContextPackStore(database!).save(contextPack);
    const base = createCandidate(project.id, candidate({
      observations: [
        directory("docs"),
        markdown("docs/guide.md", "a"),
        directory("src"),
        { ...markdown("src/map.test.ts", "b"), role: "test", documentKind: null, documentFormat: null, contentEligible: false },
        markdown("README.md", "c"),
      ],
      links: [{
        fromPath: "docs/guide.md",
        toRecordId: task.id,
        toPath: null,
        kind: "documents",
        basis: "accepted",
      }],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: base.snapshotId,
      decidedAt,
      appliedAt,
    });
    const current = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
      observations: [
        directory("docs"),
        markdown("docs/guide.md", "d"),
        directory("src"),
        { ...markdown("src/map.test.ts", "b"), role: "test", documentKind: null, documentFormat: null, contentEligible: false },
        markdown("README.md", "c"),
      ],
      links: [{
        fromPath: "docs/guide.md",
        toRecordId: task.id,
        toPath: null,
        kind: "documents",
        basis: "accepted",
      }],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: current.snapshotId,
      decidedAt: "2026-08-02T12:00:00.000Z",
      appliedAt: "2026-08-02T12:00:01.000Z",
    });

    const first = store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 2,
      currentTaskId: task.id,
      contextPackId: contextPack.id,
      filter: { changed: true, relevance: "current_task", contextIncluded: true },
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      observation: { path: "docs", kind: "directory" },
      changed: true,
      linked: true,
      currentTaskRelevant: true,
      contextIncluded: true,
    });

    const ordered = store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 3,
      currentTaskId: null,
      contextPackId: null,
      filter: {},
    });
    expect(ordered.map(({ observation }) => [observation.kind, observation.path])).toEqual([
      ["directory", "docs"],
      ["directory", "src"],
      ["file", "README.md"],
    ]);
    expect(store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 10,
      currentTaskId: null,
      contextPackId: null,
      filter: { search: "GUIDE" },
    }).map(({ observation }) => observation.path)).toEqual(["docs"]);
    const docs = ordered.find(({ observation }) => observation.path === "docs")!.observation;
    expect(store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: docs.nodeId,
      limit: 10,
      currentTaskId: null,
      contextPackId: null,
      filter: { search: "guide" },
    }).map(({ observation }) => observation.path)).toEqual(["docs/guide.md"]);
    const after = ordered[1]!.observation;
    expect(store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 2,
      after: { kind: after.kind, path: after.path, nodeId: after.nodeId },
      currentTaskId: null,
      contextPackId: null,
      filter: {},
    }).map(({ observation }) => observation.path)).toEqual(["README.md"]);

    database!.prepare(`
      UPDATE repository_sources SET status = 'detached' WHERE project_id = ?
    `).run(project.id);
    expect(store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 10,
      currentTaskId: null,
      contextPackId: null,
      filter: { state: "stale" },
    })).toHaveLength(3);
    expect(store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 10,
      currentTaskId: null,
      contextPackId: null,
      filter: { state: "unavailable" },
    })).toEqual([]);
  });

  it("marks a surviving directory changed when its only accepted delta is a removed descendant", () => {
    setup();
    const project = createProject();
    const base = createCandidate(project.id, candidate({
      observations: [
        directory("docs"),
        markdown("docs/kept.md", "a"),
        markdown("docs/removed.md", "b"),
      ],
      links: [],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: base.snapshotId,
      decidedAt,
      appliedAt,
    });
    const current = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
      observations: [directory("docs"), markdown("docs/kept.md", "a")],
      links: [],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: current.snapshotId,
      decidedAt: "2026-08-02T12:00:00.000Z",
      appliedAt: "2026-08-02T12:00:01.000Z",
    });

    const changed = store!.listExplorerChildren({
      projectId: project.id,
      snapshotId: current.snapshotId,
      parentNodeId: null,
      limit: 10,
      currentTaskId: null,
      contextPackId: null,
      filter: { changed: true },
    });

    expect(changed).toEqual([
      expect.objectContaining({
        observation: expect.objectContaining({ path: "docs", kind: "directory" }),
        changed: true,
      }),
    ]);
  });

  it("reuses a base node only for a one-to-one identity transfer backed by exact rename evidence", () => {
    setup();
    const project = createProject();
    const baseReview = createCandidate(project.id, candidate({
      observations: [markdown("docs/old.md", "a")],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: baseReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const baseNodeId = store!.listObservations(baseReview.snapshotId)[0]!.nodeId;
    const movedCandidate = candidate({
      fingerprint: "e".repeat(64),
      observations: [markdown("docs/new.md", "a")],
      renameEvidence: [{ originalPath: "docs/old.md", path: "docs/new.md" }],
    });

    const movedReview = store!.createCandidate({
      projectId: project.id,
      baseProjectRevision: 0,
      candidate: movedCandidate,
      identityTransfers: [{
        nodeId: baseNodeId,
        previousPath: "docs/old.md",
        currentPath: "docs/new.md",
      }],
    });

    expect(store!.listObservations(movedReview.snapshotId)[0]).toMatchObject({
      nodeId: baseNodeId,
      path: "docs/new.md",
    });
  });

  it("rejects unproven, kind-changing, or non-bijective identity transfers atomically", () => {
    setup();
    const project = createProject();
    const baseReview = createCandidate(project.id, candidate({
      observations: [markdown("old-a.md", "a"), markdown("old-b.md", "b")],
    }));
    store!.promoteCandidate({
      projectId: project.id,
      snapshotId: baseReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const [nodeA, nodeB] = store!.listObservations(baseReview.snapshotId);

    const invalid = [
      {
        observations: [markdown("new-a.md", "a")],
        renameEvidence: [],
        identityTransfers: [
          { nodeId: nodeA!.nodeId, previousPath: "old-a.md", currentPath: "new-a.md" },
        ],
      },
      {
        observations: [directory("new-a.md")],
        renameEvidence: [{ originalPath: "old-a.md", path: "new-a.md" }],
        identityTransfers: [
          { nodeId: nodeA!.nodeId, previousPath: "old-a.md", currentPath: "new-a.md" },
        ],
      },
      {
        observations: [markdown("new-a.md", "a")],
        renameEvidence: [
          { originalPath: "old-a.md", path: "new-a.md" },
          { originalPath: "old-b.md", path: "new-a.md" },
        ],
        identityTransfers: [
          { nodeId: nodeA!.nodeId, previousPath: "old-a.md", currentPath: "new-a.md" },
          { nodeId: nodeB!.nodeId, previousPath: "old-b.md", currentPath: "new-a.md" },
        ],
      },
    ];
    for (const { observations, renameEvidence, identityTransfers } of invalid) {
      expect(() => store!.createCandidate({
        projectId: project.id,
        baseProjectRevision: 0,
        candidate: candidate({
          fingerprint: "f".repeat(64),
          observations,
          renameEvidence,
        }),
        identityTransfers,
      })).toThrow();
    }
    expect(database!.prepare(
      "SELECT COUNT(*) AS count FROM repository_snapshots WHERE state = 'candidate'",
    ).get()).toEqual({ count: 0 });
  });

  it("cancels a candidate while preserving the accepted snapshot", () => {
    setup();
    const project = createProject();
    const acceptedReview = createCandidate(project.id);
    const accepted = store!.promoteCandidate({
      projectId: project.id,
      snapshotId: acceptedReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const pending = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
    }));

    expect(store!.cancelCandidate(pending.snapshotId, decidedAt)).toEqual({
      ...pending,
      state: "cancelled",
      updatedAt: decidedAt,
      decidedAt,
    });
    expect(store!.getSnapshot(pending.snapshotId)).toMatchObject({
      state: "discarded",
      decidedAt,
      appliedAt: null,
    });
    expect(store!.getCurrentSnapshot(project.id)).toEqual(accepted);
    expect(store!.getPendingReview(project.id)).toBeNull();
  });

  it("conflicts only the exact candidate and lets cancellation plus a fresh candidate supersede it", () => {
    setup();
    const project = createProject();
    const acceptedReview = createCandidate(project.id);
    const accepted = store!.promoteCandidate({
      projectId: project.id,
      snapshotId: acceptedReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const pending = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
    }));

    expect(store!.conflictCandidate(pending.snapshotId, decidedAt)).toEqual({
      ...pending,
      state: "conflicted",
      updatedAt: decidedAt,
      decidedAt,
    });
    expect(store!.getSnapshot(pending.snapshotId)).toMatchObject({
      state: "candidate",
      decidedAt: null,
      appliedAt: null,
    });
    expect(store!.getCurrentSnapshot(project.id)).toEqual(accepted);
    expect(store!.getPendingReview(project.id)).toBeNull();
    expect(store!.getActionableReview(project.id)?.state).toBe("conflicted");

    expect(() => store!.conflictCandidate("unrelated-snapshot", decidedAt))
      .toThrowError(/not pending/i);
    expect(store!.getReview(pending.snapshotId)?.state).toBe("conflicted");

    expect(store!.cancelCandidate(pending.snapshotId, decidedAt).state).toBe("cancelled");
    const fresh = createCandidate(project.id, candidate({ fingerprint: "f".repeat(64) }));
    expect(store!.getActionableReview(project.id)).toEqual(fresh);
    expect(store!.getCurrentSnapshot(project.id)).toEqual(accepted);
  });

  it("rejects a stale base with a safe typed conflict and no state mutation", () => {
    setup();
    const project = createProject();
    const baseReview = createCandidate(project.id);
    const base = store!.promoteCandidate({
      projectId: project.id,
      snapshotId: baseReview.snapshotId,
      decidedAt,
      appliedAt,
    });
    const staleReview = createCandidate(project.id, candidate({
      fingerprint: "e".repeat(64),
    }));
    const source = store!.getSource(project.id)!;
    database!.prepare(`
      INSERT INTO repository_snapshots (
        id, source_id, project_id, state, base_snapshot_id,
        base_project_revision, branch, head, fingerprint, scanner_version,
        ruleset_version, warning_counts_json, exclusion_counts_json,
        finding_counts_json, created_at, decided_at, applied_at
      ) VALUES (
        @id, @sourceId, @projectId, 'accepted', @baseSnapshotId,
        0, NULL, NULL, @fingerprint, 'scanner-1',
        'rules-1', '{}', '{}', '{}', @createdAt, @decidedAt, @appliedAt
      )
    `).run({
      id: "concurrent-snapshot",
      sourceId: source.id,
      projectId: project.id,
      baseSnapshotId: base.id,
      fingerprint: "f".repeat(64),
      createdAt,
      decidedAt,
      appliedAt,
    });
    database!.prepare(`
      UPDATE repository_sources
      SET current_snapshot_id = 'concurrent-snapshot'
      WHERE id = ?
    `).run(source.id);

    let conflict: unknown;
    try {
      store!.promoteCandidate({
        projectId: project.id,
        snapshotId: staleReview.snapshotId,
        decidedAt,
        appliedAt,
      });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(RepositoryRefreshConflictError);
    expect(conflict).toMatchObject({
      projectId: project.id,
      snapshotId: staleReview.snapshotId,
      expectedBaseSnapshotId: base.id,
      currentSnapshotId: "concurrent-snapshot",
    });
    expect(conflict).not.toHaveProperty("root");
    expect(store!.getSnapshot(staleReview.snapshotId)).toMatchObject({
      state: "candidate",
      decidedAt: null,
      appliedAt: null,
    });
    expect(store!.getPendingReview(project.id)).toEqual(staleReview);
    expect(store!.getCurrentSnapshot(project.id)).toMatchObject({
      id: "concurrent-snapshot",
    });
  });

  it("rejects duplicate paths and invalid conditional targets before writing", () => {
    setup();
    const project = createProject();
    const duplicate = markdown("README.md", "c");

    expect(() => createCandidate(project.id, candidate({
      observations: [duplicate, { ...duplicate }],
    }))).toThrow();
    expect(() => createCandidate(project.id, candidate({
      observations: [duplicate],
      links: [{
        fromPath: "README.md",
        toRecordId: null,
        toPath: null,
        kind: "related_to",
        basis: "observed",
      }],
    }))).toThrow();
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_snapshots").get())
      .toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_sources").get())
      .toEqual({ count: 0 });
  });

  it("rolls back cross-project record links and rejects cross-project decisions", () => {
    setup();
    const project = createProject();
    const otherProject = createProject("Other");
    const otherRecord = projectStore!.createRecord({
      projectId: otherProject.id,
      kind: "decision",
      status: "accepted",
      title: "Other project",
      body: "This record cannot be linked across project boundaries.",
      sourceKind: "human",
      sourceRef: null,
    });
    const invalidCandidate = candidate({
      links: [{
        fromPath: "docs/guide.md",
        toRecordId: otherRecord.id,
        toPath: null,
        kind: "documents",
        basis: "accepted",
      }],
    });

    expect(() => createCandidate(project.id, invalidCandidate)).toThrow();
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_snapshots").get())
      .toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_sources").get())
      .toEqual({ count: 0 });

    const review = createCandidate(project.id);
    expect(() => store!.promoteCandidate({
      projectId: otherProject.id,
      snapshotId: review.snapshotId,
      decidedAt,
      appliedAt,
    })).toThrow();
    expect(store!.getSnapshot(review.snapshotId)).toMatchObject({ state: "candidate" });
  });
});
