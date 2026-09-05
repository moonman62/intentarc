import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import { createProfileStore } from "./profile-store.js";
import {
  credentialMatches,
  hashCredential,
} from "../system/credential-hash.js";

describe("profile store", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  it("creates a profile, proposal authority, and human audit atomically without plaintext", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(
      `INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-1", "IntentArc", 0, null, "2026-07-27T10:00:00.000Z", "2026-07-27T10:00:00.000Z");
    const store = createProfileStore(database);

    const created = store.createProfile({
      profile: {
        id: "profile-1",
        name: "Build agent",
        status: "enabled",
        executionMode: "safe",
        tokenHash: "a".repeat(64),
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
        tokenRotatedAt: "2026-07-27T10:01:00.000Z",
        lastUsedAt: null,
      },
      authority: {
        id: "authority-1",
        profileId: "profile-1",
        projectId: "project-1",
        mode: "proposal",
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
      },
      audit: {
        id: "audit-1",
        projectId: "project-1",
        actionCategory: "profile_created",
        targetId: "profile-1",
        createdAt: "2026-07-27T10:01:00.000Z",
      },
    });

    expect(created).toEqual({
      profile: {
        id: "profile-1",
        name: "Build agent",
        status: "enabled",
        executionMode: "safe",
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
        tokenRotatedAt: "2026-07-27T10:01:00.000Z",
        lastUsedAt: null,
      },
      authority: expect.objectContaining({ id: "authority-1", mode: "proposal" }),
    });
    expect(JSON.stringify(created)).not.toContain("tokenHash");
    expect(
      database.prepare("SELECT token_hash FROM client_profiles").get(),
    ).toEqual({ token_hash: "a".repeat(64) });
    expect(database.prepare(
      `SELECT actor_type, authority_mode, scope_decision, action_category,
              outcome, project_id
       FROM audit_events`,
    ).get()).toEqual({
      actor_type: "local_human",
      authority_mode: "human",
      scope_decision: "human_admin",
      action_category: "profile_created",
      outcome: "applied",
      project_id: "project-1",
    });
  });

  it("loads one public profile without exposing its authentication digest", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(`
      INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at,
        token_rotated_at, last_used_at
      ) VALUES (?, ?, 'enabled', ?, ?, ?, ?, ?)
    `).run(
      "profile-public",
      "Public build agent",
      "f".repeat(64),
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:01:00.000Z",
      "2026-07-27T10:02:00.000Z",
      "2026-07-27T10:03:00.000Z",
    );
    const store = createProfileStore(database);

    expect(store.getProfile("profile-public")).toEqual({
      id: "profile-public",
      name: "Public build agent",
      status: "enabled",
      executionMode: "safe",
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-27T10:01:00.000Z",
      tokenRotatedAt: "2026-07-27T10:02:00.000Z",
      lastUsedAt: "2026-07-27T10:03:00.000Z",
    });
    expect(store.getProfile("profile-public")).not.toHaveProperty("tokenHash");
    expect(store.getProfile("missing-profile")).toBeNull();
  });

  it("sets execution mode with a local-human audit without changing authority", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const store = createProfileStore(database);
    store.createProfile({
      profile: {
        id: "profile-1",
        name: "Build agent",
        status: "enabled",
        executionMode: "safe",
        tokenHash: "a".repeat(64),
        createdAt: "2026-07-27T10:00:00.000Z",
        updatedAt: "2026-07-27T10:00:00.000Z",
        tokenRotatedAt: "2026-07-27T10:00:00.000Z",
        lastUsedAt: null,
      },
      authority: null,
      audit: {
        id: "audit-created",
        projectId: null,
        actionCategory: "profile_created",
        targetId: "profile-1",
        createdAt: "2026-07-27T10:00:00.000Z",
      },
    });

    expect(store.setExecutionMode({
      profileId: "profile-1",
      executionMode: "custom",
      timestamp: "2026-07-27T10:01:00.000Z",
      audit: {
        id: "audit-execution-mode",
        projectId: null,
        actionCategory: "profile_execution_mode_set",
        targetId: "profile-1",
        createdAt: "2026-07-27T10:01:00.000Z",
      },
    })).toMatchObject({
      executionMode: "custom",
      updatedAt: "2026-07-27T10:01:00.000Z",
    });
    expect(database.prepare(
      "SELECT action_category, actor_type, authority_mode FROM audit_events WHERE id = ?",
    ).get("audit-execution-mode")).toEqual({
      action_category: "profile_execution_mode_set",
      actor_type: "local_human",
      authority_mode: "human",
    });
  });

  it("does not add an audit when setting a missing profile execution mode fails", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const store = createProfileStore(database);

    expect(() => store.setExecutionMode({
      profileId: "missing-profile",
      executionMode: "trusted",
      timestamp: "2026-07-27T10:01:00.000Z",
      audit: {
        id: "audit-missing-profile",
        projectId: null,
        actionCategory: "profile_execution_mode_set",
        targetId: "missing-profile",
        createdAt: "2026-07-27T10:01:00.000Z",
      },
    })).toThrow("Profile not found: missing-profile");
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual({ count: 0 });
  });

  it.each([
    ["uppercase digest", "A".repeat(64)],
    ["non-hex value", "z".repeat(64)],
    ["64-character plaintext", "secret".padEnd(64, "!")],
  ])("rejects an invalid create %s before persisting any transaction state", (
    _case,
    tokenHash,
  ) => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(
      `INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-1", "IntentArc", 0, null, "2026-07-27T10:00:00.000Z", "2026-07-27T10:00:00.000Z");
    const store = createProfileStore(database);

    expect(() => store.createProfile({
      profile: {
        id: "profile-invalid",
        name: "Invalid profile",
        status: "enabled",
        executionMode: "safe",
        tokenHash,
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
        tokenRotatedAt: "2026-07-27T10:01:00.000Z",
        lastUsedAt: null,
      },
      authority: {
        id: "authority-invalid",
        profileId: "profile-invalid",
        projectId: "project-1",
        mode: "proposal",
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
      },
      audit: {
        id: "audit-invalid",
        projectId: "project-1",
        actionCategory: "profile_created",
        targetId: "profile-invalid",
        createdAt: "2026-07-27T10:01:00.000Z",
      },
    })).toThrow();

    expect(database.prepare(
      `SELECT
        (SELECT COUNT(*) FROM client_profiles) AS profiles,
        (SELECT COUNT(*) FROM profile_project_authorities) AS authorities,
        (SELECT COUNT(*) FROM audit_events) AS audits`,
    ).get()).toEqual({ profiles: 0, authorities: 0, audits: 0 });
  });

  it("rejects an invalid rotation before changing the old digest or adding an audit", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const oldHash = hashCredential("old-secret");
    database.prepare(
      `INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at,
        token_rotated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "profile-1",
      "Build agent",
      "enabled",
      oldHash,
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
      null,
    );
    const store = createProfileStore(database);

    expect(() => store.rotateToken({
      profileId: "profile-1",
      tokenHash: "x".repeat(64),
      timestamp: "2026-07-27T10:02:00.000Z",
      audit: {
        id: "audit-invalid",
        projectId: null,
        actionCategory: "profile_token_rotated",
        targetId: "profile-1",
        createdAt: "2026-07-27T10:02:00.000Z",
      },
    })).toThrow();

    const stored = store.findProfileForAuthentication("profile-1");
    expect(stored?.tokenHash).toBe(oldHash);
    expect(stored && credentialMatches("old-secret", stored.tokenHash)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual({ count: 0 });
  });

  it("validates scope shapes and keeps add/remove operations atomic with audit", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'IntentArc', 0, NULL,
        '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z'
      );
      INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at, token_rotated_at, last_used_at
      ) VALUES (
        'profile-1', 'Build agent', 'enabled',
        '${"b".repeat(64)}', '2026-07-27T10:00:00.000Z',
        '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z', NULL
      );
      INSERT INTO profile_project_authorities (
        id, profile_id, project_id, mode, created_at, updated_at
      ) VALUES (
        'authority-1', 'profile-1', 'project-1', 'scoped_direct',
        '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z'
      );
    `);
    const store = createProfileStore(database);

    expect(() => store.addScope({
      scope: {
        id: "scope-invalid",
        authorityId: "authority-1",
        operationType: "create_record",
        recordKind: "task",
        fromRecordKind: "component",
        toRecordKind: null,
        relationshipKind: null,
        createdAt: "2026-07-27T10:02:00.000Z",
      },
      audit: {
        id: "audit-invalid",
        projectId: "project-1",
        actionCategory: "profile_scope_added",
        targetId: "scope-invalid",
        createdAt: "2026-07-27T10:02:00.000Z",
      },
    })).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM profile_scopes").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual({ count: 0 });

    const scope = store.addScope({
      scope: {
        id: "scope-1",
        authorityId: "authority-1",
        operationType: "create_relationship",
        recordKind: null,
        fromRecordKind: "task",
        toRecordKind: null,
        relationshipKind: "depends_on",
        createdAt: "2026-07-27T10:03:00.000Z",
      },
      audit: {
        id: "audit-1",
        projectId: "project-1",
        actionCategory: "profile_scope_added",
        targetId: "scope-1",
        createdAt: "2026-07-27T10:03:00.000Z",
      },
    });
    expect(scope.id).toBe("scope-1");
    expect(store.listScopes("authority-1")).toEqual([scope]);

    store.removeScope({
      scopeId: "scope-1",
      audit: {
        id: "audit-2",
        projectId: "project-1",
        actionCategory: "profile_scope_removed",
        targetId: "scope-1",
        createdAt: "2026-07-27T10:04:00.000Z",
      },
    });
    expect(store.listScopes("authority-1")).toEqual([]);
    expect(database.prepare(
      "SELECT action_category FROM audit_events ORDER BY created_at",
    ).all()).toEqual([
      { action_category: "profile_scope_added" },
      { action_category: "profile_scope_removed" },
    ]);
  });

  it("upserts one authority per profile and project and returns its current scopes", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'IntentArc', 0, NULL,
        '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z'
      );
      INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at,
        token_rotated_at, last_used_at
      ) VALUES (
        'profile-1', 'Build agent', 'enabled', '${"c".repeat(64)}',
        '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z',
        '2026-07-27T10:00:00.000Z', NULL
      );
    `);
    const store = createProfileStore(database);
    const first = store.setAuthority({
      authority: {
        id: "authority-original",
        profileId: "profile-1",
        projectId: "project-1",
        mode: "proposal",
        createdAt: "2026-07-27T10:01:00.000Z",
        updatedAt: "2026-07-27T10:01:00.000Z",
      },
      audit: {
        id: "audit-1",
        projectId: "project-1",
        actionCategory: "profile_authority_set",
        targetId: "unused",
        createdAt: "2026-07-27T10:01:00.000Z",
      },
    });
    const updated = store.setAuthority({
      authority: {
        id: "authority-replacement",
        profileId: "profile-1",
        projectId: "project-1",
        mode: "full_direct",
        createdAt: "2026-07-27T10:02:00.000Z",
        updatedAt: "2026-07-27T10:02:00.000Z",
      },
      audit: {
        id: "audit-2",
        projectId: "project-1",
        actionCategory: "profile_authority_set",
        targetId: "unused",
        createdAt: "2026-07-27T10:02:00.000Z",
      },
    });

    expect(first.id).toBe("authority-original");
    expect(updated).toMatchObject({
      id: "authority-original",
      mode: "full_direct",
      createdAt: "2026-07-27T10:01:00.000Z",
      updatedAt: "2026-07-27T10:02:00.000Z",
    });
    expect(store.getAuthority("profile-1", "project-1")).toEqual({
      authority: updated,
      scopes: [],
    });
    expect(database.prepare(
      "SELECT target_id FROM audit_events ORDER BY created_at",
    ).all()).toEqual([
      { target_id: "authority-original" },
      { target_id: "authority-original" },
    ]);
  });
});
