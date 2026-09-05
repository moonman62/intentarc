import {
  existsSync,
  linkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { basename, join } from "node:path";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { DurabilityError } from "../durability/errors.js";
import { migrations } from "./migrations.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

const coordinationObjects = [
  ["table", "task_claims"],
  ["table", "task_checkpoints"],
  ["table", "task_delegations"],
  ["table", "task_submissions"],
  ["table", "coordination_events"],
  ["table", "coordination_idempotency"],
  ["index", "idx_task_claims_one_active"],
  ["index", "idx_task_claims_one_submitted"],
  ["index", "idx_task_delegations_one_live"],
  ["trigger", "task_checkpoints_no_update"],
  ["trigger", "task_checkpoints_no_delete"],
  ["trigger", "task_submissions_immutable_fields"],
  ["trigger", "task_submissions_no_delete"],
  ["trigger", "coordination_events_no_update"],
  ["trigger", "coordination_events_no_delete"],
  ["trigger", "coordination_proposal_state_sync"],
] as const;

describe("openDatabase", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("creates schema eleven with durable coordination history, deterministic lineage, SQLite safeguards, and no backup", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, {
      now: () => "2026-07-27T09:30:00.000Z",
      storeId: "store-deterministic",
    });

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("user_version", { simple: true })).toBe(11);

    const schemaObjects = database
      .prepare(`
        SELECT type, name
        FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger')
        ORDER BY type, name
      `)
      .all()
      .map((row) => {
        const object = row as { type: string; name: string };
        return [object.type, object.name];
      });

    expect(schemaObjects).toEqual(
      expect.arrayContaining([
        ["table", "context_packs"],
        ["table", "outbound_destinations"],
        ["table", "outbound_policies"],
        ["table", "outbound_requests"],
        ["table", "outbound_findings"],
        ["table", "outbound_releases"],
        ["table", "human_change_idempotency_results"],
        ["index", "idx_outbound_destinations_current_profile"],
        ["index", "idx_outbound_requests_profile_created_at"],
        ["trigger", "outbound_releases_no_update"],
        ["trigger", "outbound_releases_no_delete"],
        ...coordinationObjects,
      ]),
    );
    expect(database.prepare("PRAGMA foreign_key_list(task_claims)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "project_records", from: "task_id", to: "id" }),
        expect.objectContaining({ table: "project_records", from: "project_id", to: "project_id" }),
        expect.objectContaining({ table: "client_profiles", from: "profile_id", to: "id" }),
        expect.objectContaining({ table: "context_packs", from: "context_pack_id", to: "id" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(task_checkpoints)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "task_claims", from: "claim_id", to: "id" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(task_delegations)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "client_profiles", from: "parent_profile_id", to: "id" }),
        expect.objectContaining({ table: "client_profiles", from: "child_profile_id", to: "id" }),
        expect.objectContaining({ table: "task_claims", from: "claim_id", to: "id", on_delete: "RESTRICT" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(task_submissions)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "task_claims", from: "claim_id", to: "id" }),
        expect.objectContaining({ table: "task_checkpoints", from: "checkpoint_id", to: "id" }),
        expect.objectContaining({ table: "change_proposals", from: "proposal_id", to: "id" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(coordination_events)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "projects", from: "project_id", to: "id" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(coordination_idempotency)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "profile_project_authorities", from: "profile_id", to: "profile_id" }),
        expect.objectContaining({ table: "profile_project_authorities", from: "project_id", to: "project_id" }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_list(human_change_idempotency_results)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "projects", from: "project_id", to: "id" }),
      ]));
    expect(database.prepare("PRAGMA table_info(human_change_idempotency_results)").all()
      .filter((column) => (column as { pk: number }).pk > 0)
      .map((column) => (column as { name: string; pk: number }).name))
      .toEqual(["project_id", "operation_scope", "idempotency_key"]);
    expect(
      database.prepare(
        "SELECT singleton, store_id, created_at FROM store_metadata",
      ).get(),
    ).toEqual({
      singleton: 1,
      store_id: "store-deterministic",
      created_at: "2026-07-27T09:30:00.000Z",
    });
    expect(existsSync(`${temporaryDatabase.path}.backups`)).toBe(false);

    database
      .prepare(
        `INSERT INTO audit_events (
          id, project_id, actor_type, action_category, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("audit-1", "project-1", "system", "migration", "success", "2026-07-27T00:00:00.000Z");

    expect(() =>
      database
        .prepare("UPDATE audit_events SET outcome = ? WHERE id = ?")
        .run("failed", "audit-1"),
    ).toThrow("audit events are append-only");
    expect(() =>
      database.prepare("DELETE FROM audit_events WHERE id = ?").run("audit-1"),
    ).toThrow("audit events are append-only");

    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'Project', 1, NULL,
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO client_profiles VALUES (
        'profile-1', 'Profile', 'enabled', '${"a".repeat(64)}',
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:00:00.000Z', NULL, 'safe'
      );
      INSERT INTO project_records VALUES (
        'task-1', 'project-1', 'task', 'active', 'Task', 'Body',
        'human', NULL, 1,
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO context_packs VALUES (
        'pack-1', 'project-1', 'task-1', 1, 1, 1, '{}',
        '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO outbound_destinations VALUES (
        'destination-1', 1, 'profile-1', 'Client', 'ide_managed',
        'Provider', NULL, NULL, 'remote', 'enabled', 1,
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO outbound_requests VALUES (
        'request-1', 'profile-1', 'project-1', 'task-1', 'pack-1',
        'key-1', '${"b".repeat(64)}', 'destination-1', 1, '{}',
        '1', '1', '${"c".repeat(64)}', 'released', '{}',
        'actor', 'approved', 'release-1',
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO outbound_releases VALUES (
        'release-1', 'request-1', 'pack-1', '{}', '{}',
        '${"d".repeat(64)}', '2026-07-27T00:00:00.000Z'
      );
    `);
    expect(() =>
      database!.prepare(
        "UPDATE outbound_releases SET sha256 = ? WHERE id = ?",
      ).run("e".repeat(64), "release-1"),
    ).toThrow("outbound releases are immutable");
    expect(() =>
      database!.prepare(
        "DELETE FROM outbound_releases WHERE id = ?",
      ).run("release-1"),
    ).toThrow("outbound releases are immutable");

    database.exec(`
      INSERT INTO profile_project_authorities VALUES (
        'authority-1', 'profile-1', 'project-1', 'proposal',
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
      INSERT INTO task_claims (
        id, project_id, task_id, profile_id, delegation_id, state,
        base_project_revision, base_task_revision, context_pack_id,
        acquired_at, expires_at, absolute_expires_at, ended_at,
        latest_checkpoint_id
      ) VALUES (
        'claim-1', 'project-1', 'task-1', 'profile-1', NULL, 'submitted',
        1, 1, 'pack-1', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:30:00.000Z', '2026-07-27T04:00:00.000Z',
        '2026-07-27T00:10:00.000Z', 'checkpoint-1'
      );
      INSERT INTO task_checkpoints VALUES (
        'checkpoint-1', 'claim-1', 1, '{}',
        '2026-07-27T00:10:00.000Z', 1, 1, 'pack-1'
      );
      INSERT INTO change_proposals VALUES (
        'proposal-1', 'project-1', 'profile-1', 'task-1', NULL, 1,
        'pending', 'Complete task', 'proposal-key', '${"f".repeat(64)}',
        NULL, NULL, '2026-07-27T00:10:00.000Z',
        '2026-07-27T00:10:00.000Z', NULL, 'profile', NULL
      );
      INSERT INTO task_submissions VALUES (
        'submission-1', 'claim-1', 'checkpoint-1', 'profile-1',
        'project-1', 'task-1', 1, 1, 'pack-1', '{}', 'proposal-1',
        'submitted', '2026-07-27T00:10:00.000Z', NULL
      );
      INSERT INTO coordination_events VALUES (
        'event-1', 'submission', 'project-1', 'task-1', 'profile-1',
        'claim-1', NULL, 'checkpoint-1', 'submission-1', 'proposal-1',
        'active', 'submitted', 1, 1, NULL,
        '2026-07-27T00:10:00.000Z'
      );
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-2', 'Other project', 1, NULL,
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
    `);

    expect(() => database!.prepare(`
      INSERT INTO task_claims VALUES (
        'claim-cross-project', 'project-2', 'task-1', 'profile-1', NULL,
        'active', 1, 1, 'pack-1', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:30:00.000Z', '2026-07-27T04:00:00.000Z', NULL, NULL
      )
    `).run()).toThrow("FOREIGN KEY constraint failed");

    database.prepare(`
      INSERT INTO task_claims VALUES (
        'claim-active', 'project-1', 'task-1', 'profile-1', NULL,
        'active', 1, 1, 'pack-1', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:30:00.000Z', '2026-07-27T04:00:00.000Z', NULL, NULL
      )
    `).run();
    expect(() => database!.prepare(`
      INSERT INTO task_claims VALUES (
        'claim-active-duplicate', 'project-1', 'task-1', 'profile-1', NULL,
        'active', 1, 1, 'pack-1', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:30:00.000Z', '2026-07-27T04:00:00.000Z', NULL, NULL
      )
    `).run()).toThrow("UNIQUE constraint failed: task_claims.task_id");
    expect(() => database!.prepare(`
      INSERT INTO task_claims VALUES (
        'claim-submitted-duplicate', 'project-1', 'task-1', 'profile-1', NULL,
        'submitted', 1, 1, 'pack-1', '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:30:00.000Z', '2026-07-27T04:00:00.000Z', NULL, NULL
      )
    `).run()).toThrow("UNIQUE constraint failed: task_claims.task_id");

    database.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-1', 'project-1', 'task-1', 'profile-1', 'profile-1',
        'claimed', 1, 1, '{"summary":"Scope","constraints":[]}', '["code"]',
        '2026-07-27T00:00:00.000Z', '2026-07-27T01:00:00.000Z',
        '2026-07-27T00:05:00.000Z', NULL, 'claim-1'
      )
    `).run();
    database.prepare("UPDATE task_claims SET delegation_id = 'delegation-1' WHERE id = 'claim-1'").run();
    database.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-unrelated', 'project-1', 'task-1', 'profile-1', 'profile-1',
        'revoked', 1, 1, '{"summary":"Other","constraints":[]}', '["code"]',
        '2026-07-27T00:00:00.000Z', '2026-07-27T01:00:00.000Z',
        NULL, '2026-07-27T00:06:00.000Z', NULL
      )
    `).run();
    expect(() => database!.prepare(`
      UPDATE task_delegations SET claim_id = 'claim-missing'
      WHERE id = 'delegation-1'
    `).run()).toThrow("FOREIGN KEY constraint failed");
    expect(() => database!.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-2', 'project-1', 'task-1', 'profile-1', 'profile-1',
        'accepted', 1, 1, '{"summary":"Scope","constraints":[]}', '["code"]',
        '2026-07-27T00:00:00.000Z', '2026-07-27T01:00:00.000Z',
        '2026-07-27T00:10:00.000Z', NULL, NULL
      )
    `).run()).toThrow("UNIQUE constraint failed: task_delegations.task_id");

    expect(() => database!.prepare(
      "UPDATE task_checkpoints SET sequence = 2 WHERE id = 'checkpoint-1'",
    ).run()).toThrow("task checkpoints are append-only");
    expect(() => database!.prepare(
      "DELETE FROM task_checkpoints WHERE id = 'checkpoint-1'",
    ).run()).toThrow("task checkpoints are append-only");
    expect(() => database!.prepare(
      "UPDATE task_submissions SET document_json = '{\"changed\":true}' WHERE id = 'submission-1'",
    ).run()).toThrow("task submission payload is immutable");
    expect(() => database!.prepare(
      "DELETE FROM task_submissions WHERE id = 'submission-1'",
    ).run()).toThrow("task submissions are durable");
    expect(() => database!.prepare(
      "UPDATE coordination_events SET detail = 'changed' WHERE id = 'event-1'",
    ).run()).toThrow("coordination events are append-only");
    expect(() => database!.prepare(
      "DELETE FROM coordination_events WHERE id = 'event-1'",
    ).run()).toThrow("coordination events are append-only");

    database.prepare(`
      UPDATE change_proposals
      SET state = 'accepted', updated_at = '2026-07-27T01:00:00.000Z'
      WHERE id = 'proposal-1'
    `).run();
    expect(database.prepare(`
      SELECT state, decided_at FROM task_submissions WHERE id = 'submission-1'
    `).get()).toEqual({
      state: "accepted",
      decided_at: "2026-07-27T01:00:00.000Z",
    });
    expect(database.prepare(`
      SELECT state, ended_at FROM task_claims WHERE id = 'claim-1'
    `).get()).toEqual({
      state: "reconciled",
      ended_at: "2026-07-27T01:00:00.000Z",
    });
    expect(database.prepare(`
      SELECT id, state, ended_at FROM task_delegations ORDER BY id
    `).all()).toEqual([
      {
        id: "delegation-1",
        state: "completed",
        ended_at: "2026-07-27T01:00:00.000Z",
      },
      {
        id: "delegation-unrelated",
        state: "revoked",
        ended_at: "2026-07-27T00:06:00.000Z",
      },
    ]);

    database.close();
    database = openDatabase(temporaryDatabase.path);

    expect(database.pragma("user_version", { simple: true })).toBe(11);
  });

  it.each([1, 2] as const)(
    "refuses an existing supported-old version-%s database instead of migrating it",
    (version) => {
      temporaryDatabase = createTemporaryDatabase();
      const oldDatabase = new Database(temporaryDatabase.path);

      for (const migration of migrations) {
        if (migration.version > version) break;
        oldDatabase.exec(migration.sql);
      }
      oldDatabase.pragma(`user_version = ${version}`);
      oldDatabase.close();

      expect(() => openDatabase(temporaryDatabase!.path)).toThrowError(
        expect.objectContaining<Partial<DurabilityError>>({
          code: "unsupported_schema",
        }),
      );
      const unchanged = new Database(temporaryDatabase!.path);
      expect(unchanged.pragma("user_version", { simple: true })).toBe(version);
      unchanged.close();
    },
  );

  it("refuses a future schema version", () => {
    temporaryDatabase = createTemporaryDatabase();
    const future = new Database(temporaryDatabase.path);
    future.pragma(`user_version = ${migrations.at(-1)!.version + 1}`);
    future.close();

    expect(() => openDatabase(temporaryDatabase!.path)).toThrowError(
      expect.objectContaining<Partial<DurabilityError>>({
        code: "unsupported_schema",
      }),
    );
  });

  it("opens an existing database through its canonical directory identity", () => {
    temporaryDatabase = createTemporaryDatabase();
    openDatabase(temporaryDatabase.path, {
      now: () => "2026-07-27T09:30:00.000Z",
      storeId: "store-canonical",
    }).close();
    const aliasDirectory = join(temporaryDatabase.directory, "parent-alias");
    symlinkSync(
      temporaryDatabase.directory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    database = openDatabase(
      join(aliasDirectory, basename(temporaryDatabase.path)),
    );

    expect(database.name).toBe(realpathSync(temporaryDatabase.path));
  });

  it("rejects a hard-linked primary database before SQLite access", () => {
    temporaryDatabase = createTemporaryDatabase();
    openDatabase(temporaryDatabase.path, {
      now: () => "2026-07-27T09:30:00.000Z",
      storeId: "store-hard-link",
    }).close();
    const aliasPath = join(
      temporaryDatabase.directory,
      "hard-linked.sqlite",
    );
    linkSync(temporaryDatabase.path, aliasPath);

    let unexpectedDatabase: IntentArcDatabase | undefined;
    let thrown: unknown;
    try {
      unexpectedDatabase = openDatabase(aliasPath);
    } catch (error) {
      thrown = error;
    } finally {
      unexpectedDatabase?.close();
    }

    expect(thrown).toEqual(
      expect.objectContaining<Partial<DurabilityError>>({
        code: "maintenance_conflict",
      }),
    );
  });
});
