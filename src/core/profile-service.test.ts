import { afterEach, describe, expect, it } from "vitest";
import { GovernanceError } from "../domain/index.js";
import { createProfileStore } from "../storage/profile-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createProfileService } from "./profile-service.js";

describe("profile service", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  it("returns a token once, persists only its hash, and authenticates after reopening", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(
      `INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-1", "IntentArc", 0, null, "2026-07-27T10:00:00.000Z", "2026-07-27T10:00:00.000Z");
    const ids = ["profile-1", "authority-1", "audit-1", "audit-touch"];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:01:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
      generateToken: () => "one-time-secret",
    });

    const created = service.createProfile({
      name: "Build agent",
      projectId: "project-1",
    });

    expect(created).toEqual({
      profile: expect.objectContaining({
        id: "profile-1",
        name: "Build agent",
        status: "enabled",
      }),
      token: "one-time-secret",
    });
    expect(JSON.stringify(service.listProfiles())).not.toContain("one-time-secret");
    expect(database.prepare(
      "SELECT token_hash FROM client_profiles WHERE id = ?",
    ).get("profile-1")).not.toEqual({ token_hash: "one-time-secret" });
    expect(service.listProfiles()[0]?.authorities[0]?.authority.mode).toBe("proposal");

    database.close();
    database = openDatabase(temporaryDatabase.path);
    const reopened = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:02:00.000Z",
      newId: () => "audit-reopened",
      generateToken: () => "unused",
    });

    expect(reopened.authenticate({
      profileId: "profile-1",
      token: "one-time-secret",
    })).toEqual({
      id: "profile-1",
      name: "Build agent",
      status: "enabled",
      credentialGeneration: "2026-07-27T10:01:00.000Z",
    });
  });

  it("defaults execution mode to safe and persists trusted independently of authority", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(
      `INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-1", "IntentArc", 0, null, "2026-07-27T10:00:00.000Z", "2026-07-27T10:00:00.000Z");
    const ids = ["profile-safe", "audit-safe", "profile-trusted", "authority-trusted", "audit-trusted"];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:01:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
      generateToken: () => "one-time-secret",
    });

    expect(service.createProfile({ name: "Safe agent" }).profile.executionMode).toBe("safe");
    expect(service.createProfile({
      name: "Trusted agent",
      projectId: "project-1",
      executionMode: "trusted",
    }).profile.executionMode).toBe("trusted");

    database.close();
    database = openDatabase(temporaryDatabase.path);
    const reopened = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:02:00.000Z",
      newId: () => "audit-reopened",
      generateToken: () => "unused",
    });
    const trusted = reopened.listProfiles().find(
      ({ profile }) => profile.id === "profile-trusted",
    )!;

    expect(trusted.profile.executionMode).toBe("trusted");
    expect(trusted.authorities[0]?.authority.mode).toBe("proposal");
  });

  it("distinguishes anonymous, partial, invalid, and disabled credentials safely", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const ids = ["profile-1", "audit-created", "audit-disabled"];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
      generateToken: () => "secret",
    });
    const created = service.createProfile({ name: "Build agent" });

    expect(service.authenticate(null)).toBeNull();
    expect(() => service.authenticate({ profileId: created.profile.id }))
      .toThrow(expect.objectContaining<Partial<GovernanceError>>({ code: "profile_required" }));
    expect(() => service.authenticate({ token: "secret" }))
      .toThrow(expect.objectContaining<Partial<GovernanceError>>({ code: "profile_required" }));
    expect(() => service.authenticate({}))
      .toThrow(expect.objectContaining<Partial<GovernanceError>>({ code: "profile_required" }));
    expect(() => service.authenticate({
      profileId: created.profile.id,
      token: "wrong",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "invalid_profile_credentials",
    }));
    expect(() => service.authenticate({
      profileId: "missing",
      token: "secret",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "invalid_profile_credentials",
    }));

    service.setEnabled(created.profile.id, false);
    expect(() => service.authenticate({
      profileId: created.profile.id,
      token: "wrong",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "invalid_profile_credentials",
    }));
    expect(() => service.authenticate({
      profileId: created.profile.id,
      token: "secret",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "profile_disabled",
    }));
  });

  it("invalidates the previous token immediately after rotation", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const tokens = ["old-secret", "new-secret"];
    const ids = ["profile-1", "audit-created", "audit-rotated"];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
      generateToken: () => tokens.shift() ?? "unexpected-token",
    });
    const created = service.createProfile({ name: "Build agent" });
    const oldPrincipal = service.authenticate({
      profileId: created.profile.id,
      token: "old-secret",
    })!;

    expect(service.rotateToken(created.profile.id)).toEqual({
      profileId: "profile-1",
      token: "new-secret",
    });
    expect(() => service.authenticate({
      profileId: created.profile.id,
      token: "old-secret",
    })).toThrow(expect.objectContaining<Partial<GovernanceError>>({
      code: "invalid_profile_credentials",
    }));
    expect(() => service.revalidatePrincipal(oldPrincipal)).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "invalid_profile_credentials",
      }),
    );
    const newPrincipal = service.authenticate({
      profileId: created.profile.id,
      token: "new-secret",
    })!;
    expect(newPrincipal.id).toBe("profile-1");
    expect(newPrincipal.credentialGeneration).not.toBe(
      oldPrincipal.credentialGeneration,
    );
  });

  it("revalidates an enabled principal against its current credential generation", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:00:00.000Z",
      newId: (prefix) => `${prefix}-1`,
      generateToken: () => "secret",
    });
    const created = service.createProfile({ name: "Build agent" });
    const principal = service.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const revalidate = (): unknown =>
      Reflect.apply(
        Reflect.get(service as object, "revalidatePrincipal") as () => unknown,
        service,
        [principal],
      );

    expect(() => revalidate()).not.toThrow();
    expect(revalidate()).toEqual(principal);
  });

  it("rejects a live principal after its profile is disabled", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let id = 0;
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:00:00.000Z",
      newId: (prefix) => `${prefix}-${++id}`,
      generateToken: () => "secret",
    });
    const created = service.createProfile({ name: "Build agent" });
    const principal = service.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;

    service.setEnabled(created.profile.id, false);

    expect(() => service.revalidatePrincipal(principal)).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "profile_disabled",
        message: "profile_disabled",
      }),
    );
  });

  it("rejects a live principal after rotation and accepts the new generation", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let currentTime = "2026-07-27T10:00:00.000Z";
    let id = 0;
    const tokens = ["old-secret", "new-secret"];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => currentTime,
      newId: (prefix) => `${prefix}-${++id}`,
      generateToken: () => tokens.shift() ?? "unexpected-token",
    });
    const created = service.createProfile({ name: "Build agent" });
    const oldPrincipal = service.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;

    currentTime = "2026-07-27T10:01:00.000Z";
    const rotated = service.rotateToken(created.profile.id);

    expect(() => service.revalidatePrincipal(oldPrincipal)).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "invalid_profile_credentials",
        message: "invalid_profile_credentials",
      }),
    );
    const currentPrincipal = service.authenticate({
      profileId: created.profile.id,
      token: rotated.token,
    })!;
    expect(service.revalidatePrincipal(currentPrincipal)).toEqual({
      ...oldPrincipal,
      credentialGeneration: currentTime,
    });
  });

  it("applies human authority and scope administration with project-specific audits", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.prepare(
      `INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-1", "IntentArc", 0, null, "2026-07-27T10:00:00.000Z", "2026-07-27T10:00:00.000Z");
    const ids = [
      "profile-1",
      "audit-created",
      "authority-1",
      "audit-authority",
      "scope-1",
      "audit-scope-added",
      "audit-scope-removed",
    ];
    const service = createProfileService({
      profileStore: createProfileStore(database),
      now: () => "2026-07-27T10:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
      generateToken: () => "secret",
    });
    const created = service.createProfile({ name: "Build agent" });
    const authority = service.setAuthority({
      profileId: created.profile.id,
      projectId: "project-1",
      mode: "scoped_direct",
    });
    const scope = service.addScope({
      authorityId: authority.id,
      operationType: "update_record",
      recordKind: "task",
      fromRecordKind: null,
      toRecordKind: null,
      relationshipKind: null,
    });

    service.removeScope(scope.id);

    expect(database.prepare(
      `SELECT action_category, project_id, actor_type, authority_mode,
              scope_decision, outcome
       FROM audit_events ORDER BY rowid`,
    ).all()).toEqual([
      {
        action_category: "profile_created",
        project_id: null,
        actor_type: "local_human",
        authority_mode: "human",
        scope_decision: "human_admin",
        outcome: "applied",
      },
      {
        action_category: "profile_authority_set",
        project_id: "project-1",
        actor_type: "local_human",
        authority_mode: "human",
        scope_decision: "human_admin",
        outcome: "applied",
      },
      {
        action_category: "profile_scope_added",
        project_id: "project-1",
        actor_type: "local_human",
        authority_mode: "human",
        scope_decision: "human_admin",
        outcome: "applied",
      },
      {
        action_category: "profile_scope_removed",
        project_id: "project-1",
        actor_type: "local_human",
        authority_mode: "human",
        scope_decision: "human_admin",
        outcome: "applied",
      },
    ]);
  });
});
