import { afterEach, describe, expect, it } from "vitest";
import { GovernanceError } from "../domain/index.js";
import { createProfileService } from "./profile-service.js";
import { createDestinationService } from "./destination-service.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createOutboundDestinationStore } from "../storage/outbound-destination-store.js";
import { createProfileStore } from "../storage/profile-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

const timestamp = "2026-07-27T10:00:00.000Z";

const input = {
  profileId: "profile-1",
  clientLabel: "Claude Code laptop",
  type: "ide_managed" as const,
  providerLabel: "Anthropic",
  modelLabel: null,
  accountBoundaryLabel: "personal subscription",
  dataBoundary: "remote" as const,
};

describe("destination service", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  const createService = () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const profileStore = createProfileStore(database);
    const ids = ["profile-1", "audit-profile", "destination-1", "audit-destination-1", "audit-destination-2", "audit-profile-disabled", "audit-destination-3"];
    const newId = () => ids.shift() ?? "unexpected-id";
    const profiles = createProfileService({
      profileStore,
      now: () => timestamp,
      newId,
      generateToken: () => "test-token",
    });
    profiles.createProfile({ name: "Build agent" });

    return {
      service: createDestinationService({
        destinationStore: createOutboundDestinationStore(database),
        profileStore,
        now: () => timestamp,
        newId,
      }),
      profiles,
    };
  };

  const destinationRows = () => database!.prepare(`
    SELECT destination_id, revision, status, is_current
    FROM outbound_destinations
    ORDER BY revision
  `).all();

  const outboundAuditRows = () => database!.prepare(`
    SELECT action_category, target_id, reason
    FROM audit_events
    WHERE action_category LIKE 'outbound_destination_%'
    ORDER BY rowid
  `).all();

  it("creates a destination only for an existing profile and audits safe metadata", () => {
    const { service } = createService();

    const destination = service.set(input);

    expect(destination).toMatchObject({
      id: "destination-1",
      revision: 1,
      status: "enabled",
      current: true,
    });
    expect(outboundAuditRows()).toEqual([{
      action_category: "outbound_destination_set",
      target_id: destination.id,
      reason: "destination_revision:1",
    }]);
    expect(JSON.stringify(outboundAuditRows())).not.toContain("Anthropic");
    expect(JSON.stringify(outboundAuditRows())).not.toContain("personal subscription");
  });

  it("uses a canonical error and writes nothing for a missing profile", () => {
    const { service } = createService();

    expect(() => service.set({ ...input, profileId: "missing" })).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "validation_failed" }),
    );
    expect(destinationRows()).toEqual([]);
    expect(outboundAuditRows()).toEqual([]);
  });

  it("advances the stable destination identity when a descriptor changes", () => {
    const { service } = createService();
    const first = service.set(input);

    const revised = service.set({ ...input, modelLabel: "Sonnet" });

    expect(revised).toMatchObject({
      id: first.id,
      revision: 2,
      modelLabel: "Sonnet",
      current: true,
    });
    expect(destinationRows()).toEqual([
      { destination_id: first.id, revision: 1, status: "enabled", is_current: 0 },
      { destination_id: first.id, revision: 2, status: "enabled", is_current: 1 },
    ]);
  });

  it("rejects malformed labels before any profile-scoped state changes", () => {
    const { service } = createService();

    expect(() => service.set({ ...input, clientLabel: "unsafe\nlabel" })).toThrow();

    expect(destinationRows()).toEqual([]);
    expect(outboundAuditRows()).toEqual([]);
  });

  it("rejects a disabled profile for set but retains and disables its existing destination", () => {
    const { service, profiles } = createService();
    service.set(input);
    profiles.setEnabled(input.profileId, false);

    expect(() => service.set(input)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "profile_disabled" }),
    );
    expect(service.disable(input.profileId)).toMatchObject({
      revision: 2,
      status: "disabled",
      current: true,
    });
  });

  it("persists the current destination across a reopened database", () => {
    const { service } = createService();
    service.set(input);

    database!.close();
    database = openDatabase(temporaryDatabase!.path);
    const reopened = createDestinationService({
      destinationStore: createOutboundDestinationStore(database),
      profileStore: createProfileStore(database),
      now: () => timestamp,
      newId: () => "unused",
    });

    expect(reopened.getCurrent(input.profileId)).toMatchObject({
      id: "destination-1",
      revision: 1,
      status: "enabled",
    });
  });
});
