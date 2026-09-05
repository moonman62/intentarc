import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import {
  createOutboundDestinationStore,
  type SetDestinationCommand,
} from "./outbound-destination-store.js";

const timestamp = "2026-07-27T10:00:00.000Z";

const insertProfile = (
  database: IntentArcDatabase,
  profileId = "profile-1",
): void => {
  database.prepare(`
    INSERT INTO client_profiles (
      id, name, status, token_hash, created_at, updated_at,
      token_rotated_at, last_used_at
    ) VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL)
  `).run(
    profileId,
    "Build agent",
    "a".repeat(64),
    timestamp,
    timestamp,
    timestamp,
  );
};

const destinationCommand = (
  updatedAt = timestamp,
): SetDestinationCommand => ({
  destination: {
    id: "destination-1",
    profileId: "profile-1",
    clientLabel: "Claude Code laptop",
    type: "ide_managed",
    providerLabel: "Anthropic",
    modelLabel: null,
    accountBoundaryLabel: "personal subscription",
    dataBoundary: "remote",
    createdAt: updatedAt,
    updatedAt,
  },
  audit: {
    id: `audit-${updatedAt}`,
    createdAt: updatedAt,
  },
});

describe("outbound destination store", () => {
  let database: IntentArcDatabase | undefined;
  let concurrentDatabase: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    concurrentDatabase?.close();
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  const setup = (): IntentArcDatabase => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    insertProfile(database);
    return database;
  };

  it("creates the first strict current destination revision with its privacy-safe audit", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);

    expect(store.set(destinationCommand())).toEqual({
      id: "destination-1",
      profileId: "profile-1",
      revision: 1,
      clientLabel: "Claude Code laptop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: null,
      accountBoundaryLabel: "personal subscription",
      dataBoundary: "remote",
      status: "enabled",
      current: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(db.prepare(`
      SELECT project_id, actor_type, profile_id, authority_mode,
             scope_decision, action_category, target_id, idempotency_key,
             revision_before, revision_after, outcome, reason
      FROM audit_events
    `).get()).toEqual({
      project_id: null,
      actor_type: "local_human",
      profile_id: null,
      authority_mode: "human",
      scope_decision: "human_admin",
      action_category: "outbound_destination_set",
      target_id: "destination-1",
      idempotency_key: null,
      revision_before: null,
      revision_after: 1,
      outcome: "applied",
      reason: "destination_revision:1",
    });
  });

  it("rejects caller-controlled audit prose and rolls back the descriptor", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);

    expect(() => store.set({
      ...destinationCommand(),
      audit: {
        ...destinationCommand().audit,
        reason: "synthetic-secret-value",
      } as unknown as SetDestinationCommand["audit"],
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(JSON.stringify(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_destinations) AS destinations,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get())).not.toContain("synthetic-secret-value");
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_destinations) AS destinations,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ destinations: 0, audits: 0 });
  });

  it("atomically advances a stable destination and leaves exactly one current row", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);
    store.set(destinationCommand());
    db.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'IntentArc', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO outbound_policies (
        profile_id, project_id, destination_id, destination_revision,
        detector_version, safety_policy_version, mode, created_at, updated_at
      ) VALUES (
        'profile-1', 'project-1', 'destination-1', 1,
        '1', '1', 'auto_release_clean', '${timestamp}', '${timestamp}'
      );
    `);

    const second = store.set({
      ...destinationCommand("2026-07-27T10:01:00.000Z"),
      destination: {
        ...destinationCommand("2026-07-27T10:01:00.000Z").destination,
        modelLabel: "Sonnet",
      },
    });

    expect(second).toMatchObject({
      id: "destination-1",
      revision: 2,
      modelLabel: "Sonnet",
      current: true,
    });
    expect(db.prepare(`
      SELECT revision, is_current
      FROM outbound_destinations
      ORDER BY revision
    `).all()).toEqual([
      { revision: 1, is_current: 0 },
      { revision: 2, is_current: 1 },
    ]);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM outbound_policies",
    ).get()).toEqual({ count: 0 });
  });

  it("disables by copying the current descriptor into the next retained revision", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);
    store.set(destinationCommand());

    expect(store.disable({
      profileId: "profile-1",
      createdAt: "2026-07-27T10:02:00.000Z",
      updatedAt: "2026-07-27T10:02:00.000Z",
      audit: {
        id: "audit-disable",
        createdAt: "2026-07-27T10:02:00.000Z",
      },
    })).toMatchObject({
      id: "destination-1",
      revision: 2,
      status: "disabled",
      current: true,
      providerLabel: "Anthropic",
    });
    expect(store.getCurrent("profile-1")).toMatchObject({
      revision: 2,
      status: "disabled",
    });
  });

  it("normalizes an unknown profile failure and rolls back the audit", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);

    expect(() => store.set({
      ...destinationCommand(),
      destination: {
        ...destinationCommand().destination,
        id: "destination-missing",
        profileId: "missing-profile",
      },
      audit: {
        ...destinationCommand().audit,
        id: "audit-missing",
      },
    })).toThrowError(expect.objectContaining({
      name: "OutboundSafetyError",
      code: "outbound_safety_failed",
      details: {},
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_destinations) AS destinations,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ destinations: 0, audits: 0 });
  });

  it("serializes repeated writes from two connections without duplicate revisions", () => {
    const db = setup();
    concurrentDatabase = openDatabase(temporaryDatabase!.path);
    const firstStore = createOutboundDestinationStore(db);
    const secondStore = createOutboundDestinationStore(concurrentDatabase);

    firstStore.set(destinationCommand());
    secondStore.set(destinationCommand("2026-07-27T10:01:00.000Z"));

    expect(db.prepare(`
      SELECT revision, COUNT(*) AS count
      FROM outbound_destinations
      GROUP BY revision
      ORDER BY revision
    `).all()).toEqual([
      { revision: 1, count: 1 },
      { revision: 2, count: 1 },
    ]);
  });

  it("rolls back the descriptor revision when its audit cannot be inserted", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);
    store.set(destinationCommand());

    expect(() => store.set({
      ...destinationCommand("2026-07-27T10:03:00.000Z"),
      audit: {
        ...destinationCommand("2026-07-27T10:03:00.000Z").audit,
        id: `audit-${timestamp}`,
      },
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT revision, is_current
      FROM outbound_destinations
    `).all()).toEqual([{ revision: 1, is_current: 1 }]);
  });

  it("strict-parses stored rows and normalizes corrupt mapper state", () => {
    const db = setup();
    const store = createOutboundDestinationStore(db);
    store.set(destinationCommand());
    db.prepare(`
      UPDATE outbound_destinations SET updated_at = 'not-a-timestamp'
    `).run();

    expect(() => store.getCurrent("profile-1")).toThrowError(
      expect.objectContaining({
        name: "OutboundSafetyError",
        code: "outbound_safety_failed",
        details: {},
      }),
    );
  });
});
