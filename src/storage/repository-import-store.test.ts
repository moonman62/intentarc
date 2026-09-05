import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryImportManifest } from "../domain/index.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { createRepositoryImportStore } from "./repository-import-store.js";

const timestamp = "2026-07-28T12:00:00.000Z";
const manifestDigest = "a".repeat(64);
const repositoryFingerprint = "b".repeat(64);

const manifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: timestamp,
  repository: {
    root: "C:/projects/example",
    canonicalSubpath: null,
    branch: "main",
    head: "c".repeat(40),
    fingerprint: repositoryFingerprint,
  },
  discovery: {
    sources: [
      {
        path: "README.md",
        status: "tracked",
        role: "supporting_document",
        byteSize: 10,
        sha256: "c".repeat(64),
        extraction: { title: "Example", headings: ["Example"] },
      },
      {
        path: "docs/plan.md",
        status: "tracked",
        role: "supporting_document",
        byteSize: 20,
        sha256: "d".repeat(64),
        extraction: { title: "Plan", headings: ["Plan"] },
      },
    ],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Imported project",
      primaryRepositoryPath: "C:/projects/example",
    },
    records: [
      {
        key: "vision",
        kind: "vision",
        status: "accepted",
        title: "Ship the project",
        body: "Preserve the repository intent.",
        sourceKind: "repository",
        sourceRef: "README.md",
        sourceRefs: ["README.md"],
        curationReason: null,
      },
      {
        key: "task",
        kind: "task",
        status: "active",
        title: "Implement onboarding",
        body: "Create the initial imported snapshot.",
        sourceKind: "repository",
        sourceRef: "docs/plan.md",
        sourceRefs: ["docs/plan.md"],
        curationReason: null,
      },
    ],
    relationships: [
      { fromKey: "task", toKey: "vision", kind: "implements" },
    ],
  },
});

const input = (
  value: RepositoryImportManifest = manifest(),
  digest = manifestDigest,
) => ({
  manifest: value,
  manifestDigest: digest,
  repositoryFingerprint,
});

const ids = () => {
  const values = {
    project: ["project-1"],
    record: ["record-vision", "record-task"],
    relationship: ["relationship-1"],
    audit: ["audit-1"],
  };

  return (prefix: keyof typeof values): string =>
    values[prefix].shift() ?? `unexpected-${prefix}`;
};

describe("repository import store", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
    temporaryDatabase = undefined;
  });

  const setup = (newId = ids()) => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, {
      now: () => timestamp,
      storeId: "store-import",
    });
    return {
      database,
      store: createRepositoryImportStore(database, {
        now: () => timestamp,
        newId,
      }),
    };
  };

  const expectImportedStateEmpty = (db: IntentArcDatabase): void => {
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM project_records) AS records,
        (SELECT COUNT(*) FROM project_record_revisions) AS revisions,
        (SELECT COUNT(*) FROM record_relationships) AS relationships,
        (SELECT COUNT(*) FROM repository_import_receipts) AS receipts,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({
      projects: 0,
      records: 0,
      revisions: 0,
      relationships: 0,
      receipts: 0,
      audits: 0,
    });
  };

  it("atomically persists a revision-one project, exact record snapshots, relationships, receipt, and audit", () => {
    const { database: db, store } = setup();

    expect(store.findByDigest(manifestDigest)).toBeNull();
    expect(store.applyInitialSnapshot(input())).toEqual({
      projectId: "project-1",
      manifestDigest,
      repositoryFingerprint,
      revisionBefore: 0,
      revisionAfter: 1,
      replayed: false,
    });

    expect(db.prepare("SELECT * FROM projects").all()).toEqual([{
      id: "project-1",
      name: "Imported project",
      revision: 1,
      primary_repository_path: "C:/projects/example",
      hierarchy_vocabulary_json:
        '{"preset":"neutral","outcome":"Outcome","initiative":"Initiative","deliverable":"Deliverable","milestone":"Milestone","task":"Work item","nestedTask":"Subtask"}',
      created_at: timestamp,
      updated_at: timestamp,
    }]);
    expect(db.prepare(`
      SELECT id, project_id, revision FROM project_records ORDER BY id
    `).all()).toEqual([
      { id: "record-task", project_id: "project-1", revision: 1 },
      { id: "record-vision", project_id: "project-1", revision: 1 },
    ]);

    const snapshots = db.prepare(`
      SELECT record_id, revision, snapshot_json, created_at
      FROM project_record_revisions
      ORDER BY record_id
    `).all() as {
      record_id: string;
      revision: number;
      snapshot_json: string;
      created_at: string;
    }[];
    expect(snapshots.map((row) => ({
      ...row,
      snapshot_json: JSON.parse(row.snapshot_json),
    }))).toEqual([
      {
        record_id: "record-task",
        revision: 1,
        snapshot_json: {
          id: "record-task",
          projectId: "project-1",
          kind: "task",
          status: "active",
          title: "Implement onboarding",
          body: "Create the initial imported snapshot.",
          sourceKind: "repository",
          sourceRef: "docs/plan.md",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        created_at: timestamp,
      },
      {
        record_id: "record-vision",
        revision: 1,
        snapshot_json: {
          id: "record-vision",
          projectId: "project-1",
          kind: "vision",
          status: "accepted",
          title: "Ship the project",
          body: "Preserve the repository intent.",
          sourceKind: "repository",
          sourceRef: "README.md",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        created_at: timestamp,
      },
    ]);
    expect(db.prepare(`
      SELECT id, project_id, from_record_id, to_record_id, kind, created_at
      FROM record_relationships
    `).all()).toEqual([{
      id: "relationship-1",
      project_id: "project-1",
      from_record_id: "record-task",
      to_record_id: "record-vision",
      kind: "implements",
      created_at: timestamp,
    }]);
    expect(db.prepare("SELECT * FROM repository_import_receipts").all()).toEqual([{
      manifest_digest: manifestDigest,
      project_id: "project-1",
      repository_fingerprint: repositoryFingerprint,
      scanner_version: "1",
      ruleset_version: "1",
      manifest_version: 1,
      record_count: 2,
      relationship_count: 1,
      initial_snapshot_digest:
        "01e724d1ed655e26acfc6031cce3b77635825bb4a683944968e97d26997032bf",
      initial_snapshot_json:
        "{\"version\":1,\"projectId\":\"project-1\",\"recordIds\":[\"record-task\",\"record-vision\"],\"relationships\":[{\"id\":\"relationship-1\",\"fromRecordId\":\"record-task\",\"toRecordId\":\"record-vision\",\"kind\":\"implements\"}]}",
      created_at: timestamp,
    }]);
    expect(db.prepare(`
      SELECT
        project_id, actor_type, profile_id, authority_mode, scope_decision,
        action_category, target_id, idempotency_key, revision_before,
        revision_after, outcome, reason, created_at
      FROM audit_events
    `).all()).toEqual([{
      project_id: "project-1",
      actor_type: "local_human",
      profile_id: null,
      authority_mode: "human",
      scope_decision: "human_import",
      action_category: "repository_import_applied",
      target_id: "project-1",
      idempotency_key: null,
      revision_before: 0,
      revision_after: 1,
      outcome: "applied",
      reason: null,
      created_at: timestamp,
    }]);
    expect(
      createIntegrityChecker({ now: () => timestamp })
        .checkConnection(db, "full"),
    ).toMatchObject({ passed: true, issues: [] });
  });

  it("rejects noncanonical persisted record content before any SQL write", () => {
    const { database: db, store } = setup();
    const candidate = manifest();
    candidate.proposal.records[0]!.body = " \n\t ";

    expect(() => store.applyInitialSnapshot(input(candidate))).toThrowError(
      RepositoryImportError,
    );
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM project_records) AS records,
        (SELECT COUNT(*) FROM repository_import_receipts) AS receipts
    `).get()).toEqual({ projects: 0, records: 0, receipts: 0 });
  });

  it("replays a receipt without allocating IDs or writing a second audit", () => {
    let allocations = 0;
    const nextId = ids();
    const { database: db, store } = setup((prefix) => {
      allocations += 1;
      return nextId(prefix);
    });
    const first = store.applyInitialSnapshot(input());
    const allocationCountAfterApply = allocations;

    expect(store.findByDigest(manifestDigest)).toEqual({
      ...first,
      replayed: true,
    });
    expect(store.applyInitialSnapshot(input())).toEqual({
      ...first,
      replayed: true,
    });
    expect(allocations).toBe(allocationCountAfterApply);
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
      count: 1,
    });
  });

  it.each([
    ["a non-hierarchy endpoint", (candidate: RepositoryImportManifest) => {
      candidate.proposal.relationships = [
        { fromKey: "task", toKey: "vision", kind: "parent_of" },
      ];
    }],
    ["multiple parents for one child", (candidate: RepositoryImportManifest) => {
      candidate.proposal.records = [
        {
          key: "parent-a", kind: "outcome", status: "active", title: "Parent A",
          body: "First parent.", sourceKind: "repository", sourceRef: "README.md",
          sourceRefs: ["README.md"], curationReason: null,
        },
        {
          key: "parent-b", kind: "initiative", status: "active", title: "Parent B",
          body: "Second parent.", sourceKind: "repository", sourceRef: "README.md",
          sourceRefs: ["README.md"], curationReason: null,
        },
        {
          key: "child", kind: "task", status: "active", title: "Child",
          body: "Shared child.", sourceKind: "repository", sourceRef: "docs/plan.md",
          sourceRefs: ["docs/plan.md"], curationReason: null,
        },
      ];
      candidate.proposal.relationships = [
        { fromKey: "parent-a", toKey: "child", kind: "parent_of" },
        { fromKey: "parent-b", toKey: "child", kind: "parent_of" },
      ];
    }],
    ["a directed cycle", (candidate: RepositoryImportManifest) => {
      candidate.proposal.records = [
        {
          key: "node-a", kind: "initiative", status: "active", title: "Node A",
          body: "First cycle node.", sourceKind: "repository", sourceRef: "README.md",
          sourceRefs: ["README.md"], curationReason: null,
        },
        {
          key: "node-b", kind: "deliverable", status: "active", title: "Node B",
          body: "Second cycle node.", sourceKind: "repository", sourceRef: "docs/plan.md",
          sourceRefs: ["docs/plan.md"], curationReason: null,
        },
      ];
      candidate.proposal.relationships = [
        { fromKey: "node-a", toKey: "node-b", kind: "parent_of" },
        { fromKey: "node-b", toKey: "node-a", kind: "parent_of" },
      ];
    }],
  ])("rejects %s before any import state is written", (_label, mutate) => {
    let sequence = 0;
    const { database: db, store } = setup(
      (prefix) => `${prefix}-${sequence += 1}`,
    );
    const candidate = manifest();
    mutate(candidate);

    expect(() => store.applyInitialSnapshot(input(candidate))).toThrowError(
      expect.objectContaining({ code: "import_failed" }),
    );
    expectImportedStateEmpty(db);
  });

  it("persists and deterministically replays a valid imported hierarchy", () => {
    let sequence = 0;
    const { database: db, store } = setup(
      (prefix) => `${prefix}-${sequence += 1}`,
    );
    const candidate = manifest();
    candidate.proposal.records = [
      {
        key: "outcome", kind: "outcome", status: "active", title: "Outcome",
        body: "Top-level outcome.", sourceKind: "repository", sourceRef: "README.md",
        sourceRefs: ["README.md"], curationReason: null,
      },
      {
        key: "task", kind: "task", status: "active", title: "Task",
        body: "Leaf work item.", sourceKind: "repository", sourceRef: "docs/plan.md",
        sourceRefs: ["docs/plan.md"], curationReason: null,
      },
    ];
    candidate.proposal.relationships = [
      { fromKey: "outcome", toKey: "task", kind: "parent_of" },
    ];

    const applied = store.applyInitialSnapshot(input(candidate));
    expect(applied).toEqual({
      projectId: "project-1",
      manifestDigest,
      repositoryFingerprint,
      revisionBefore: 0,
      revisionAfter: 1,
      replayed: false,
    });
    expect(store.applyInitialSnapshot(input(candidate))).toEqual({
      ...applied,
      replayed: true,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM record_relationships").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM repository_import_receipts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
    expect(createIntegrityChecker({ now: () => timestamp }).checkConnection(db, "full"))
      .toMatchObject({ passed: true, issues: [] });
  });

  it("refuses to persist an import into a database inside its source repository", () => {
    temporaryDatabase = createTemporaryDatabase();
    const candidate = manifest();
    candidate.repository.root = temporaryDatabase.directory.replaceAll("\\", "/");
    candidate.proposal.project.primaryRepositoryPath = candidate.repository.root;
    database = openDatabase(temporaryDatabase.path, {
      now: () => timestamp,
      storeId: "store-contained-import",
    });
    const store = createRepositoryImportStore(database, {
      now: () => timestamp,
      newId: ids(),
    });

    expect(() => store.applyInitialSnapshot(input(candidate))).toThrowError(
      expect.objectContaining({ code: "path_escape" }),
    );
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM repository_import_receipts) AS receipts,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ projects: 0, receipts: 0, audits: 0 });
  });

  it("cannot attach a second digest to an already imported project", () => {
    const generatedIds = {
      project: ["project-1", "project-1"],
      record: [
        "record-vision-1",
        "record-task-1",
        "record-vision-2",
        "record-task-2",
      ],
      relationship: ["relationship-1", "relationship-2"],
      audit: ["audit-1", "audit-2"],
    };
    const { database: db, store } = setup(
      (prefix) => generatedIds[prefix].shift() ?? `unexpected-${prefix}`,
    );
    store.applyInitialSnapshot(input());

    expect(() => store.applyInitialSnapshot(input(manifest(), "d".repeat(64))))
      .toThrowError(expect.objectContaining({
        code: "import_conflict",
        details: { count: 1 },
      }));
    expect(db.prepare(`
      SELECT manifest_digest, project_id FROM repository_import_receipts
    `).all()).toEqual([{
      manifest_digest: manifestDigest,
      project_id: "project-1",
    }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
  });

  it.each([
    ["duplicate relationship", (value: RepositoryImportManifest) => {
      value.proposal.relationships.push(
        { fromKey: "task", toKey: "vision", kind: "implements" },
      );
    }, null],
    ["invalid relationship local key", (value: RepositoryImportManifest) => {
      value.proposal.relationships[0] = {
        fromKey: "missing",
        toKey: "vision",
        kind: "implements",
      };
    }, null],
    ["record insert failure", () => {}, "project_records"],
    ["receipt insert failure", () => {}, "repository_import_receipts"],
    ["audit insert failure", () => {}, "audit_events"],
  ])("rolls back every imported table after %s", (_name, mutate, failingTable) => {
    const { database: db, store } = setup();
    const candidate = manifest();
    mutate(candidate);
    if (failingTable !== null) {
      db.exec(`
        CREATE TEMP TRIGGER fail_import
        BEFORE INSERT ON ${failingTable}
        BEGIN
          SELECT RAISE(ABORT, 'injected storage failure');
        END
      `);
    }

    expect(() => store.applyInitialSnapshot(input(candidate))).toThrowError(
      RepositoryImportError,
    );
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM project_records) AS records,
        (SELECT COUNT(*) FROM project_record_revisions) AS revisions,
        (SELECT COUNT(*) FROM record_relationships) AS relationships,
        (SELECT COUNT(*) FROM repository_import_receipts) AS receipts,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({
      projects: 0,
      records: 0,
      revisions: 0,
      relationships: 0,
      receipts: 0,
      audits: 0,
    });
  });
});
