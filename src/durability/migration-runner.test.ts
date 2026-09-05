import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  createVersionedDatabaseFixture,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { neutralHierarchyVocabulary } from "../domain/index.js";
import { migrations } from "../storage/migrations.js";
import { createProjectStore } from "../storage/project-store.js";
import { createIntegrityChecker } from "./integrity.js";
import { runMigrations } from "./migration-runner.js";

const now = "2026-07-27T12:00:00.000Z";
const currentSchemaVersion = migrations.at(-1)!.version;

describe("atomic migration runner", () => {
  const temporaries: TemporaryDatabase[] = [];
  const connections: Database.Database[] = [];

  afterEach(() => {
    connections.splice(0).forEach((database) => {
      if (database.open) database.close();
    });
    temporaries.splice(0).forEach(removeTemporaryDatabase);
  });

  const temporary = (): TemporaryDatabase => {
    const value = createTemporaryDatabase();
    temporaries.push(value);
    return value;
  };

  it("initializes every pending schema and metadata row before one full pre-commit check", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    let validatedVersion: number | undefined;

    runMigrations({
      database,
      currentVersion: 0,
      storeId: "store-initial",
      now,
      validateBeforeCommit(connection) {
        validatedVersion = connection.pragma("user_version", {
          simple: true,
        }) as number;
        expect(
          createIntegrityChecker({ now: () => now })
            .checkConnection(connection, "full"),
        ).toMatchObject({
          passed: true,
          schemaVersion: currentSchemaVersion,
          storeId: "store-initial",
        });
      },
    });

    expect(validatedVersion).toBe(currentSchemaVersion);
    expect(database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(
      database.prepare(
        "SELECT singleton, store_id, created_at FROM store_metadata",
      ).all(),
    ).toEqual([{
      singleton: 1,
      store_id: "store-initial",
      created_at: now,
    }]);
    expect(
      database.pragma("table_info(outbound_policies)")
        .map((column: { name: string }) => column.name),
    ).toContain("detector_version");
    expect(database.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name IN (
        'repository_import_receipts',
        'repository_import_receipts_no_update',
        'repository_import_receipts_no_delete'
      )
      ORDER BY type, name
    `).all()).toEqual([
      { type: "table", name: "repository_import_receipts" },
      { type: "trigger", name: "repository_import_receipts_no_delete" },
      { type: "trigger", name: "repository_import_receipts_no_update" },
    ]);
    expect(database.pragma("table_info(repository_import_receipts)")
      .map((column: { name: string }) => column.name)).toEqual([
      "manifest_digest",
      "project_id",
      "repository_fingerprint",
      "scanner_version",
      "ruleset_version",
      "manifest_version",
      "record_count",
      "relationship_count",
      "initial_snapshot_digest",
      "initial_snapshot_json",
      "created_at",
    ]);
    expect(database.pragma("table_info(client_profiles)")
      .map((column: { name: string }) => column.name)).toContain("execution_mode");
    expect(database.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name IN (
        'repository_sources',
        'repository_snapshots',
        'repository_nodes',
        'repository_node_observations',
        'repository_links',
        'repository_refresh_reviews',
        'idx_repository_snapshots_source_created_at',
        'idx_repository_nodes_source_kind',
        'idx_repository_node_observations_snapshot_path',
        'idx_repository_node_observations_node',
        'idx_repository_links_snapshot_from',
        'idx_repository_links_record_target',
        'idx_repository_links_node_target',
        'idx_repository_refresh_reviews_source_state',
        'idx_repository_refresh_reviews_pending_source'
      )
      ORDER BY type, name
    `).all()).toEqual([
      { type: "index", name: "idx_repository_links_node_target" },
      { type: "index", name: "idx_repository_links_record_target" },
      { type: "index", name: "idx_repository_links_snapshot_from" },
      { type: "index", name: "idx_repository_node_observations_node" },
      { type: "index", name: "idx_repository_node_observations_snapshot_path" },
      { type: "index", name: "idx_repository_nodes_source_kind" },
      { type: "index", name: "idx_repository_refresh_reviews_pending_source" },
      { type: "index", name: "idx_repository_refresh_reviews_source_state" },
      { type: "index", name: "idx_repository_snapshots_source_created_at" },
      { type: "table", name: "repository_links" },
      { type: "table", name: "repository_node_observations" },
      { type: "table", name: "repository_nodes" },
      { type: "table", name: "repository_refresh_reviews" },
      { type: "table", name: "repository_snapshots" },
      { type: "table", name: "repository_sources" },
    ]);
  });

  it("migrates a version-ten project to neutral vocabulary without rewriting records or relationships", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    for (const migration of migrations.filter(({ version }) => version <= 10)) {
      database.exec(migration.sql);
      migration.initialize?.(database, { storeId: "store-schema-ten", now });
    }
    database.pragma("user_version = 10");
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-10', 'Existing project', 7, 'C:/existing', '${now}', '${now}'
      );
      INSERT INTO project_records (
        id, project_id, kind, status, title, body, source_kind, source_ref,
        revision, created_at, updated_at
      ) VALUES (
        'record-10', 'project-10', 'task', 'active', 'Existing task',
        'Keep the exact existing record.', 'human', 'legacy://task', 4,
        '${now}', '${now}'
      );
      INSERT INTO project_records (
        id, project_id, kind, status, title, body, source_kind, source_ref,
        revision, created_at, updated_at
      ) VALUES (
        'record-parent-10', 'project-10', 'milestone', 'accepted', 'Existing milestone',
        'Keep the parent intact.', 'human', NULL, 3, '${now}', '${now}'
      );
      INSERT INTO record_relationships (
        id, project_id, from_record_id, to_record_id, kind, created_at
      ) VALUES (
        'relationship-10', 'project-10', 'record-parent-10', 'record-10', 'parent_of', '${now}'
      );
    `);
    const originalRecord = {
      id: "record-10",
      projectId: "project-10",
      kind: "task" as const,
      status: "active" as const,
      title: "Existing task",
      body: "Keep the exact existing record.",
      sourceKind: "human" as const,
      sourceRef: "legacy://task",
      revision: 4,
      createdAt: now,
      updatedAt: now,
    };
    const originalRelationships = [{
      id: "relationship-10",
      projectId: "project-10",
      fromRecordId: "record-parent-10",
      toRecordId: "record-10",
      kind: "parent_of" as const,
      createdAt: now,
    }];

    runMigrations({
      database,
      currentVersion: 10,
      storeId: "store-schema-ten",
      now,
      validateBeforeCommit() {},
    });
    const store = createProjectStore(database, {
      now: () => now,
      newId: () => "unused-id",
    });

    expect(database.pragma("user_version", { simple: true })).toBe(11);
    expect(store.getHierarchyVocabulary("project-10"))
      .toEqual(neutralHierarchyVocabulary);
    expect(store.getRecord("project-10", "record-10")).toEqual(originalRecord);
    expect(store.listRelationships("project-10")).toEqual(originalRelationships);
  });

  it("migrates schema four without changing existing project or outbound rows", () => {
    const candidate = temporary();
    const database = createVersionedDatabaseFixture(candidate.path, 4);
    connections.push(database);
    database.exec(`
      INSERT INTO store_metadata VALUES (
        1, 'store-schema-four', '${now}'
      );
      INSERT INTO projects VALUES (
        'project-1', 'Existing project', 1, '/projects/existing', '${now}', '${now}'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Existing client', 'enabled',
        '${"a".repeat(64)}', '${now}', '${now}', '${now}', NULL
      );
      INSERT INTO outbound_destinations VALUES (
        'destination-1', 1, 'profile-1', 'Existing destination',
        'local_model', 'Local provider', 'Model', NULL, 'local', 'enabled', 1,
        '${now}', '${now}'
      );
    `);
    const projectBefore = database.prepare(
      `SELECT id, name, revision, primary_repository_path, created_at, updated_at
       FROM projects WHERE id = 'project-1'`,
    ).get();
    const outboundBefore = database.prepare(
      "SELECT * FROM outbound_destinations WHERE destination_id = 'destination-1'",
    ).get();

    runMigrations({
      database,
      currentVersion: 4,
      storeId: "store-schema-four",
      now,
      validateBeforeCommit(connection) {
        expect(
          createIntegrityChecker({ now: () => now })
            .checkConnection(connection, "full").passed,
        ).toBe(true);
      },
    });

    expect(database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(
      database.prepare(`
        SELECT id, name, revision, primary_repository_path, created_at, updated_at
        FROM projects WHERE id = 'project-1'
      `).get(),
    ).toEqual(projectBefore);
    expect(database.prepare(`
      SELECT * FROM outbound_destinations WHERE destination_id = 'destination-1'
    `).get()).toEqual(outboundBefore);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM repository_import_receipts",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT execution_mode FROM client_profiles WHERE id = 'profile-1'",
    ).get()).toEqual({ execution_mode: "safe" });
  });

  it("migrates a schema-five profile to safe execution mode", () => {
    const candidate = temporary();
    const database = createVersionedDatabaseFixture(candidate.path, 5);
    connections.push(database);
    database.exec(`
      INSERT INTO store_metadata VALUES (1, 'store-schema-five', '${now}');
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Existing client', 'enabled',
        '${"a".repeat(64)}', '${now}', '${now}', '${now}', NULL
      );
    `);

    runMigrations({
      database,
      currentVersion: 5,
      storeId: "store-schema-five",
      now,
      validateBeforeCommit(connection) {
        expect(
          createIntegrityChecker({ now: () => now })
            .checkConnection(connection, "full").passed,
        ).toBe(true);
      },
    });

    expect(database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(database.prepare(
      "SELECT execution_mode FROM client_profiles WHERE id = 'profile-1'",
    ).get()).toEqual({ execution_mode: "safe" });
  });

  it("preserves a schema-three source reference longer than 200 characters", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    const legacySourceReference = `legacy://${"s".repeat(512)}`;
    for (const migration of migrations.filter(({ version }) => version <= 3)) {
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-legacy-source-reference",
        now,
      });
    }
    database.pragma("user_version = 3");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Project', 1, NULL, '${now}', '${now}'
      );
      INSERT INTO project_records VALUES (
        'task-1', 'project-1', 'task', 'active', 'Task', 'Body',
        'human', '${legacySourceReference}', 1, '${now}', '${now}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions VALUES ('task-1', 1, ?, ?)
    `).run(JSON.stringify({
      id: "task-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Task",
      body: "Body",
      sourceKind: "human",
      sourceRef: legacySourceReference,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }), now);

    runMigrations({
      database,
      currentVersion: 3,
      storeId: "store-legacy-source-reference",
      now,
      validateBeforeCommit(connection) {
        const report = createIntegrityChecker({ now: () => now })
          .checkConnection(connection, "full");
        if (!report.passed) {
          throw new Error(JSON.stringify(report.issues));
        }
      },
    });

    expect(database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(database.prepare(`
      SELECT source_ref FROM project_records WHERE id = 'task-1'
    `).get()).toEqual({ source_ref: legacySourceReference });
  });

  it("migrates schema six exactly and rejects a cross-project repository link", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    for (const migration of migrations) {
      if (migration.version > 6) break;
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-schema-six",
        now,
      });
    }
    database.pragma("user_version = 6");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Existing project', 1, '/projects/existing', '${now}', '${now}'
      );
      INSERT INTO projects VALUES (
        'project-2', 'Other project', 1, NULL, '${now}', '${now}'
      );
      INSERT INTO project_records VALUES (
        'record-2', 'project-2', 'decision', 'accepted', 'Other decision',
        'Other project record', 'human', NULL, 1, '${now}', '${now}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions VALUES ('record-2', 1, ?, ?)
    `).run(JSON.stringify({
      id: "record-2",
      projectId: "project-2",
      kind: "decision",
      status: "accepted",
      title: "Other decision",
      body: "Other project record",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }), now);
    const projectBefore = database.prepare(
      `SELECT id, name, revision, primary_repository_path, created_at, updated_at
       FROM projects ORDER BY id`,
    ).all();
    const recordsBefore = database.prepare(
      "SELECT * FROM project_records ORDER BY id",
    ).all();

    runMigrations({
      database,
      currentVersion: 6,
      storeId: "store-schema-six",
      now,
      validateBeforeCommit(connection) {
        expect(createIntegrityChecker({ now: () => now })
          .checkConnection(connection, "full")).toMatchObject({
            passed: true,
            schemaVersion: currentSchemaVersion,
            storeId: "store-schema-six",
          });
      },
    });

    expect(database.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
    expect(database.prepare(`
      SELECT id, name, revision, primary_repository_path, created_at, updated_at
      FROM projects ORDER BY id
    `).all())
      .toEqual(projectBefore);
    expect(database.prepare("SELECT * FROM project_records ORDER BY id").all())
      .toEqual(recordsBefore);

    database.pragma("foreign_keys = ON");
    database.exec(`
      INSERT INTO repository_sources VALUES (
        'source-1', 'project-1', 'C:/projects/existing', NULL,
        'repository-1', 'available', NULL, '${now}', '${now}'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-1', 'source-1', 'project-1', 'accepted', NULL, 1,
        'main', '${"a".repeat(40)}', '${"b".repeat(64)}', '1', '1',
        '{}', '{}', '{}', '${now}', '${now}', '${now}'
      );
      UPDATE repository_sources SET current_snapshot_id = 'snapshot-1'
      WHERE id = 'source-1';
      INSERT INTO repository_nodes VALUES (
        'node-1', 'source-1', 'file', '${now}'
      );
      INSERT INTO repository_node_observations VALUES (
        'snapshot-1', 'node-1', 'source-1', NULL, 'README.md', 'file',
        '${"c".repeat(64)}', 42, 'tracked', 'canonical_source',
        'overview', 'markdown', 1, NULL, NULL
      );
    `);

    expect(() => database.exec(`
      INSERT INTO repository_links VALUES (
        'link-cross-project', 'project-1', 'snapshot-1', 'source-1',
        'node-1', 'record-2', NULL, 'documents', 'observed', '${now}'
      )
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("migrates every schema-seven proposal field and ordered operation exactly to profile origin", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    for (const migration of migrations.filter(({ version }) => version <= 7)) {
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-schema-seven",
        now,
      });
    }
    database.pragma("user_version = 7");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Existing project', 3, NULL, '${now}', '${now}'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Existing client', 'enabled', '${"a".repeat(64)}',
        '${now}', '${now}', '${now}', NULL, 'safe'
      );
      INSERT INTO change_proposals VALUES (
        'proposal-1', 'project-1', 'profile-1', NULL, NULL, 2,
        'conflicted', 'Preserve rationale', 'existing-key',
        'existing-request-hash', 'Revision changed', 'local_human',
        '2026-07-27T10:00:00.000Z', '2026-07-27T11:00:00.000Z',
        '2026-07-27T11:00:00.000Z'
      );
      INSERT INTO proposal_operations VALUES (
        'proposal-1', 0, 'operation-first', 'create_record', NULL,
        '{"operationId":"operation-first","type":"create_record","kind":"task","status":"provisional","title":"First","body":"First body"}'
      );
      INSERT INTO proposal_operations VALUES (
        'proposal-1', 1, 'operation-second', 'update_record', 4,
        '{"operationId":"operation-second","type":"update_record","recordId":"record-1","expectedRecordRevision":4,"patch":{"title":"Second"}}'
      );
    `);
    const proposalBefore = database.prepare(
      "SELECT * FROM change_proposals WHERE id = 'proposal-1'",
    ).get() as Record<string, unknown>;
    const operationsBefore = database.prepare(
      "SELECT * FROM proposal_operations WHERE proposal_id = 'proposal-1' ORDER BY position",
    ).all();

    runMigrations({
      database,
      currentVersion: 7,
      storeId: "store-schema-seven",
      now,
      validateBeforeCommit(connection) {
        expect(connection.pragma("user_version", { simple: true })).toBe(currentSchemaVersion);
      },
    });

    expect(database.prepare(
      "SELECT * FROM change_proposals WHERE id = 'proposal-1'",
    ).get()).toEqual({
      ...proposalBefore,
      origin_type: "profile",
      repository_snapshot_id: null,
    });
    expect(database.prepare(
      "SELECT * FROM proposal_operations WHERE proposal_id = 'proposal-1' ORDER BY position",
    ).all()).toEqual(operationsBefore);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_change_proposals_profile_idempotency',
        'idx_change_proposals_repository_snapshot'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "idx_change_proposals_profile_idempotency" },
      { name: "idx_change_proposals_repository_snapshot" },
    ]);
  });

  it("migrates schema eight to schema nine and validates the replay table before commit", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    for (const migration of migrations.filter(({ version }) => version <= 8)) {
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-schema-eight",
        now,
      });
    }
    database.pragma("user_version = 8");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-schema-eight', 'Schema eight project', 1, NULL,
        '${now}', '${now}'
      );
    `);

    runMigrations({
      database,
      currentVersion: 8,
      storeId: "store-schema-eight",
      now,
      validateBeforeCommit(connection) {
        expect(createIntegrityChecker({ now: () => now })
          .checkConnection(connection, "full")).toMatchObject({
            passed: true,
            schemaVersion: currentSchemaVersion,
            storeId: "store-schema-eight",
          });
      },
    });

    expect(database.pragma("user_version", { simple: true }))
      .toBe(currentSchemaVersion);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'human_change_idempotency_results'
    `).get()).toEqual({ name: "human_change_idempotency_results" });
    expect(database.prepare(
      "SELECT name FROM projects WHERE id = 'project-schema-eight'",
    ).get()).toEqual({ name: "Schema eight project" });
  });

  it("rolls back the schema-seven proposal rebuild and data when schema-eight validation rejects", () => {
    const candidate = temporary();
    const database = new Database(candidate.path);
    connections.push(database);
    for (const migration of migrations.filter(({ version }) => version <= 7)) {
      database.exec(migration.sql);
      migration.initialize?.(database, {
        storeId: "store-schema-seven-rollback",
        now,
      });
    }
    database.pragma("user_version = 7");
    database.exec(`
      INSERT INTO projects VALUES (
        'project-1', 'Existing project', 1, NULL, '${now}', '${now}'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Existing client', 'enabled', '${"a".repeat(64)}',
        '${now}', '${now}', '${now}', NULL, 'safe'
      );
      INSERT INTO change_proposals VALUES (
        'proposal-1', 'project-1', 'profile-1', NULL, NULL, 1,
        'pending', 'Preserve me', 'existing-key', 'request-hash',
        NULL, NULL, '${now}', '${now}', NULL
      );
    `);
    const proposalBefore = database.prepare("SELECT * FROM change_proposals").all();

    expect(() => runMigrations({
      database,
      currentVersion: 7,
      storeId: "store-schema-seven-rollback",
      now,
      validateBeforeCommit() {
        throw new Error("reject latest schema");
      },
    })).toThrow("reject latest schema");

    expect(database.pragma("user_version", { simple: true })).toBe(7);
    expect(database.pragma("table_info(change_proposals)")
      .map((column: { name: string }) => column.name))
      .not.toContain("origin_type");
    expect(database.prepare("SELECT * FROM change_proposals").all())
      .toEqual(proposalBefore);
  });

  it("rolls back every pending migration and user_version when a later migration fails", () => {
    const candidate = temporary();
    const database = createVersionedDatabaseFixture(candidate.path, 1);
    connections.push(database);
    database.exec(`
      CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `);

    expect(() => runMigrations({
      database,
      currentVersion: 1,
      storeId: "store-failure",
      now,
      validateBeforeCommit() {
        throw new Error("validation must not run");
      },
    })).toThrow();

    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(
      database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'client_profiles'",
      ).get(),
    ).toBeUndefined();
  });

  it("rolls back the schema and user_version when the full pre-commit check rejects", () => {
    const candidate = temporary();
    const database = createVersionedDatabaseFixture(candidate.path, 2);
    connections.push(database);
    let validationCalls = 0;

    expect(() => runMigrations({
      database,
      currentVersion: 2,
      storeId: "store-rejected",
      now,
      validateBeforeCommit(connection) {
        validationCalls += 1;
        expect(
          createIntegrityChecker({ now: () => now })
            .checkConnection(connection, "full").passed,
        ).toBe(true);
        throw new Error("injected full-check rejection");
      },
    })).toThrow("injected full-check rejection");

    expect(validationCalls).toBe(1);
    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(
      database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_metadata'",
      ).get(),
    ).toBeUndefined();
  });
});
