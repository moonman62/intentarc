import { describe, expect, it, vi } from "vitest";
import { createProfileService } from "../../core/profile-service.js";
import { createProfileStore } from "../../storage/profile-store.js";
import { openDatabase } from "../../storage/database.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
} from "../../test-support/database.js";
import type { AiClientAdapter } from "../adapters/types.js";
import type {
  DesktopSettings,
  DesktopSettingsStore,
} from "../settings.js";
import {
  createBridgeHealthChecker,
  createBridgeHealthEnvironment,
  createDesktopConnectionService,
  type BridgeHealthChecker,
} from "./service.js";

const timestamp = "2026-07-30T12:00:00.000Z";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createSettingsStore = (): DesktopSettingsStore & {
  writes: DesktopSettings[];
} => {
  let settings: DesktopSettings = {
    schemaVersion: 2,
    archivePath: "C:\\data\\arc.sqlite",
    onboardingCompleted: false,
    connections: [],
  };
  const writes: DesktopSettings[] = [];
  return {
    writes,
    read: () => structuredClone(settings),
    write: (next) => {
      settings = structuredClone(next);
      writes.push(structuredClone(next));
    },
  };
};

const createAdapter = (
  id: AiClientAdapter["id"] = "codex",
): AiClientAdapter => {
  const connect = vi.fn(async () => ({ restartRequired: true }));
  return {
    id,
    detect: vi.fn(async () => ({
      availability: "ready",
      reason: "connector_ready",
      version: "1.2.3",
    })),
    inspect: vi.fn(async () => "connected"),
    prepareConnection: vi.fn(async (input) => ({
      apply: () => connect(input),
      rollback: vi.fn(async () => undefined),
    })),
    connect,
    remove: vi.fn(async () => undefined),
    launch: vi.fn(async () => "manual_required"),
  };
};

const createHarness = () => {
  const temporaryDatabase = createTemporaryDatabase();
  const database = openDatabase(temporaryDatabase.path);
  const ids = ["profile-1", "audit-1", "profile-2", "audit-2"];
  const profiles = createProfileService({
    profileStore: createProfileStore(database),
    now: () => timestamp,
    newId: () => ids.shift() ?? "unexpected-id",
    generateToken: () => "profile-token",
  });
  const settings = createSettingsStore();
  const adapter = createAdapter();
  const health: BridgeHealthChecker = {
    check: vi.fn(async () => undefined),
  };
  const service = createDesktopConnectionService({
    profiles,
    settings,
    adapters: new Map([[adapter.id, adapter]]),
    bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
    health,
    now: () => timestamp,
    newConnectionId: () => "connection-1",
  });

  return {
    close: () => {
      database.close();
      removeTemporaryDatabase(temporaryDatabase);
    },
    profiles,
    settings,
    adapter,
    health,
    service,
  };
};

describe("DesktopConnectionService", () => {
  it("creates a reviewed manual MCP setup with a Safe profile and private token custody", async () => {
    const harness = createHarness();

    const result = await harness.service.createManual({
      label: "My MCP client",
    });

    expect(result).toEqual({
      id: "connection-1",
      label: "My MCP client",
      profileId: "profile-1",
      state: "setup_created",
      createdAt: timestamp,
      command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      args: ["--connection", "connection-1"],
    });
    expect(JSON.stringify(result)).not.toContain("profile-token");
    expect(harness.settings.read().connections).toEqual([{
      id: "connection-1",
      kind: "manual-mcp",
      label: "My MCP client",
      profileId: "profile-1",
      profileToken: "profile-token",
      createdAt: timestamp,
      updatedAt: timestamp,
    }]);
    expect(harness.profiles.listProfiles()[0]?.profile).toMatchObject({
      id: "profile-1",
      name: "My MCP client",
      status: "enabled",
      executionMode: "safe",
    });
    expect(harness.health.check).toHaveBeenCalledWith({
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      profileId: "profile-1",
    });

    harness.close();
  });

  it("lists credential- and command-free manual connection summaries", async () => {
    const harness = createHarness();
    await harness.service.createManual({ label: "My MCP client" });

    const catalog = await harness.service.list();

    expect(catalog.manual).toEqual([{
      id: "connection-1",
      label: "My MCP client",
      profileId: "profile-1",
      state: "setup_created",
      createdAt: timestamp,
    }]);
    expect(JSON.stringify(catalog.manual)).not.toContain("profile-token");
    expect(JSON.stringify(catalog.manual)).not.toContain("command");
    expect(JSON.stringify(catalog.manual)).not.toContain("IntentArc Bridge");

    harness.close();
  });

  it("revokes the new manual profile and removes its exact record when health checking fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.health.check).mockRejectedValueOnce(
      new Error("manual bridge rejected its profile"),
    );

    await expect(
      harness.service.createManual({ label: "My MCP client" }),
    ).rejects.toThrow("manual bridge rejected its profile");

    expect(harness.settings.read().connections).toEqual([]);
    expect(harness.profiles.listProfiles()[0]?.profile).toMatchObject({
      id: "profile-1",
      status: "disabled",
      executionMode: "safe",
    });

    harness.close();
  });

  it("preserves unrelated settings while rolling back a failed manual health check", async () => {
    const harness = createHarness();
    const pendingHealth = deferred<void>();
    vi.mocked(harness.health.check).mockReturnValueOnce(pendingHealth.promise);

    const creating = harness.service.createManual({ label: "My MCP client" });
    await vi.waitFor(() =>
      expect(harness.settings.read().connections).toHaveLength(1)
    );
    const duringCreate = harness.settings.read();
    const unrelated: DesktopSettings["connections"][number] = {
      id: "connection-claude",
      kind: "managed",
      adapterId: "claude-code",
      profileId: "profile-claude",
      profileToken: "claude-token",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    harness.settings.write({
      ...duringCreate,
      onboardingCompleted: true,
      connections: [...duringCreate.connections, unrelated],
    });
    pendingHealth.reject(new Error("manual bridge health failed"));

    await expect(creating).rejects.toThrow("manual bridge health failed");
    expect(harness.settings.read()).toEqual({
      ...duringCreate,
      onboardingCompleted: true,
      connections: [unrelated],
    });

    harness.close();
  });

  it("revokes a manual profile when persisting its connection fails", async () => {
    const harness = createHarness();
    vi.spyOn(harness.settings, "write").mockImplementationOnce(() => {
      throw new Error("settings unavailable");
    });

    await expect(
      harness.service.createManual({ label: "My MCP client" }),
    ).rejects.toThrow("settings unavailable");

    expect(harness.settings.read().connections).toEqual([]);
    expect(harness.profiles.listProfiles()[0]?.profile).toMatchObject({
      id: "profile-1",
      status: "disabled",
      executionMode: "safe",
    });
    expect(harness.health.check).not.toHaveBeenCalled();

    harness.close();
  });

  it("revokes a manual profile before removing only its matching settings record", async () => {
    const harness = createHarness();
    await harness.service.createManual({ label: "My MCP client" });
    const manual = harness.settings.read().connections[0]!;
    const managed: DesktopSettings["connections"][number] = {
      id: "connection-codex",
      kind: "managed",
      adapterId: "codex",
      profileId: "profile-codex",
      profileToken: "codex-token",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    harness.settings.write({
      ...harness.settings.read(),
      connections: [manual, managed],
    });
    const originalWrite = harness.settings.write;
    vi.spyOn(harness.settings, "write").mockImplementationOnce((next) => {
      expect(harness.profiles.listProfiles()[0]?.profile.status).toBe(
        "disabled",
      );
      originalWrite(next);
    });

    const result = await harness.service.removeManual("connection-1");

    expect(result).toEqual({ id: "connection-1" });
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("disabled");
    expect(harness.settings.read().connections).toEqual([managed]);

    harness.close();
  });

  it("rejects removal of an unknown manual connection without changing settings", async () => {
    const harness = createHarness();

    await expect(
      harness.service.removeManual("connection-missing"),
    ).rejects.toThrow("Unknown manual MCP connection.");

    expect(harness.settings.writes).toEqual([]);
    expect(harness.profiles.listProfiles()).toEqual([]);

    harness.close();
  });

  it("creates one Safe profile, privately stores its token, and health-checks the configured bridge", async () => {
    const harness = createHarness();

    const result = await harness.service.connect("codex");

    expect(result).toEqual({
      adapterId: "codex",
      status: "connected",
      profileId: "profile-1",
      restartRequired: true,
    });
    expect(JSON.stringify(result)).not.toContain("profile-token");
    expect(harness.settings.read().connections).toEqual([{
      id: "connection-1",
      kind: "managed",
      adapterId: "codex",
      profileId: "profile-1",
      profileToken: "profile-token",
      createdAt: timestamp,
      updatedAt: timestamp,
    }]);
    expect(harness.profiles.listProfiles()[0]?.profile).toMatchObject({
      id: "profile-1",
      name: "Codex",
      status: "enabled",
      executionMode: "safe",
    });
    expect(harness.adapter.connect).toHaveBeenCalledOnce();
    expect(harness.adapter.connect).toHaveBeenCalledWith({
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    });
    expect(harness.health.check).toHaveBeenCalledWith({
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      profileId: "profile-1",
    });

    harness.close();
  });

  it("health-checks the private bridge before mutating client configuration", async () => {
    const harness = createHarness();
    let bridgeHealthy = false;
    vi.mocked(harness.health.check).mockImplementationOnce(async () => {
      bridgeHealthy = true;
    });
    vi.mocked(harness.adapter.connect).mockImplementationOnce(async () => {
      expect(bridgeHealthy).toBe(true);
      return { restartRequired: true };
    });

    await harness.service.connect("codex");

    harness.close();
  });

  it("does not roll back an independent adapter entry that appears while bridge preflight fails", async () => {
    const harness = createHarness();
    let adapterState = "missing";
    const rollback = vi.fn(async () => {
      adapterState = "missing";
    });
    vi.mocked(harness.adapter.prepareConnection).mockResolvedValueOnce({
      apply: vi.fn(async () => {
        adapterState = "intentarc";
        return { restartRequired: true };
      }),
      rollback,
    });
    vi.mocked(harness.health.check).mockImplementationOnce(async () => {
      adapterState = "independent";
      throw new Error("bridge preflight failed");
    });

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(adapterState).toBe("independent");
    expect(rollback).not.toHaveBeenCalled();
    expect(harness.adapter.connect).not.toHaveBeenCalled();

    harness.close();
  });

  it("rolls back the exact adapter snapshot when apply mutates and then fails", async () => {
    const harness = createHarness();
    let adapterState = {
      enabled: false,
      bridgeExecutable: "C:\\Old\\IntentArc Bridge.exe",
      connectionId: "old-connection",
    };
    const snapshot = structuredClone(adapterState);
    const rollback = vi.fn(async () => {
      adapterState = structuredClone(snapshot);
    });
    vi.mocked(harness.adapter.prepareConnection).mockResolvedValueOnce({
      apply: vi.fn(async () => {
        adapterState = {
          enabled: true,
          bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
          connectionId: "connection-1",
        };
        throw new Error("client command failed after mutation");
      }),
      rollback,
    });

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(adapterState).toEqual(snapshot);
    expect(rollback).toHaveBeenCalledOnce();
    expect(harness.adapter.remove).not.toHaveBeenCalled();

    harness.close();
  });

  it("replays an existing connection without creating or rotating credentials", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    const writesAfterFirstConnect = harness.settings.writes.length;

    const replay = await harness.service.connect("codex");

    expect(replay).toEqual({
      adapterId: "codex",
      status: "connected",
      profileId: "profile-1",
      restartRequired: true,
    });
    expect(harness.profiles.listProfiles()).toHaveLength(1);
    expect(harness.settings.read().connections).toHaveLength(1);
    expect(harness.settings.read().connections[0]?.profileToken).toBe(
      "profile-token",
    );
    expect(harness.settings.writes).toHaveLength(writesAfterFirstConnect);

    harness.close();
  });

  it("rolls back a provisional setting and disables its audited profile when client configuration fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.adapter.inspect).mockResolvedValue("not_connected");
    vi.mocked(harness.adapter.connect).mockRejectedValueOnce(
      new Error("configuration failed with private command"),
    );

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(harness.settings.read().connections).toEqual([]);
    expect(harness.profiles.listProfiles()[0]?.profile).toMatchObject({
      id: "profile-1",
      status: "disabled",
      executionMode: "safe",
    });
    expect(harness.adapter.remove).not.toHaveBeenCalled();
    expect(harness.health.check).toHaveBeenCalledOnce();

    harness.close();
  });

  it("preserves a pre-existing owned adapter entry when connect rejects before mutation", async () => {
    const harness = createHarness();
    vi.mocked(harness.adapter.inspect).mockResolvedValue("connected");
    vi.mocked(harness.adapter.connect).mockRejectedValueOnce(
      new Error("existing owned vector differs"),
    );

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(harness.adapter.remove).not.toHaveBeenCalled();
    expect(harness.settings.read().connections).toEqual([]);
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("disabled");

    harness.close();
  });

  it("restores a replaced stale connection record without reverting unrelated settings", async () => {
    const harness = createHarness();
    const staleConnection: DesktopSettings["connections"][number] = {
      id: "connection-old",
      kind: "managed",
      adapterId: "codex",
      profileId: "profile-from-other-archive",
      profileToken: "old-private-token",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    };
    harness.settings.write({
      ...harness.settings.read(),
      connections: [staleConnection],
    });
    vi.mocked(harness.adapter.inspect).mockResolvedValue("connected");
    vi.mocked(harness.adapter.connect).mockRejectedValueOnce(
      new Error("owned client entry differs"),
    );

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(harness.settings.writes.at(-2)?.connections.map(({ id }) => id))
      .toEqual(["connection-1"]);
    expect(harness.settings.read().connections).toEqual([staleConnection]);
    expect(harness.adapter.remove).not.toHaveBeenCalled();

    harness.close();
  });

  it("rolls back only an adapter entry introduced by a failed connection attempt", async () => {
    const harness = createHarness();
    const rollback = vi.fn(async () => undefined);
    vi.mocked(harness.adapter.prepareConnection).mockResolvedValueOnce({
      apply: vi.fn(async () => {
        throw new Error("client verification failed after mutation");
      }),
      rollback,
    });

    await expect(harness.service.connect("codex")).rejects.toThrow();

    expect(rollback).toHaveBeenCalledOnce();
    expect(harness.adapter.remove).not.toHaveBeenCalled();
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("disabled");

    harness.close();
  });

  it("removes only its exact provisional setting while preserving later lifecycle and connection changes", async () => {
    const harness = createHarness();
    const pendingConnect = deferred<{ restartRequired: boolean }>();
    vi.mocked(harness.adapter.inspect).mockResolvedValue("not_connected");
    vi.mocked(harness.adapter.connect).mockReturnValueOnce(
      pendingConnect.promise,
    );

    const connection = harness.service.connect("codex");
    await vi.waitFor(() =>
      expect(harness.settings.read().connections).toHaveLength(1)
    );
    const duringConnect = harness.settings.read();
    harness.settings.write({
      ...duringConnect,
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: true,
      connections: [
        ...duringConnect.connections,
        {
          id: "connection-claude",
          kind: "managed",
          adapterId: "claude-code",
          profileId: "profile-claude",
          profileToken: "claude-token",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    pendingConnect.reject(new Error("configuration failed"));

    await expect(connection).rejects.toThrow();
    expect(harness.settings.read()).toEqual({
      schemaVersion: 2,
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: true,
      connections: [{
        id: "connection-claude",
        kind: "managed",
        adapterId: "claude-code",
        profileId: "profile-claude",
        profileToken: "claude-token",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    });

    harness.close();
  });

  it("tests the configured adapter and authenticated bridge without exposing custody data", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");

    const result = await harness.service.test("codex");

    expect(result).toEqual({
      adapterId: "codex",
      status: "connected",
      availability: "ready",
      availabilityReason: "connector_ready",
      version: "1.2.3",
      profileId: "profile-1",
    });
    expect(JSON.stringify(result)).not.toContain("profile-token");
    expect(harness.health.check).toHaveBeenCalledTimes(2);

    harness.close();
  });

  it("removes only the adapter entry and disables the profile while retaining private audit custody", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");

    const result = await harness.service.remove("codex");

    expect(result).toEqual({
      adapterId: "codex",
      status: "not_connected",
      profileId: "profile-1",
    });
    expect(harness.adapter.remove).toHaveBeenCalledOnce();
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("disabled");
    expect(harness.settings.read().connections[0]).toMatchObject({
      adapterId: "codex",
      profileId: "profile-1",
      profileToken: "profile-token",
    });

    harness.close();
  });

  it("revokes the profile before attempting external adapter removal", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    vi.mocked(harness.adapter.remove).mockImplementationOnce(async () => {
      expect(harness.profiles.listProfiles()[0]?.profile.status).toBe(
        "disabled",
      );
      throw new Error("client configuration is locked");
    });

    await expect(harness.service.remove("codex")).rejects.toThrow();

    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("disabled");
    expect(harness.settings.read().connections).toHaveLength(1);

    harness.close();
  });

  it("does not touch external configuration when profile revocation fails", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    vi.mocked(harness.adapter.remove).mockClear();
    vi.spyOn(harness.profiles, "setEnabled").mockImplementationOnce(() => {
      throw new Error("profile store unavailable");
    });

    await expect(harness.service.remove("codex")).rejects.toThrow();

    expect(harness.adapter.remove).not.toHaveBeenCalled();
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("enabled");

    harness.close();
  });

  it("reconnects a disabled retained profile before checking its authenticated bridge", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    await harness.service.remove("codex");
    vi.mocked(harness.health.check).mockImplementationOnce(async () => {
      expect(
        harness.profiles.listProfiles()[0]?.profile.status,
      ).toBe("enabled");
    });

    const result = await harness.service.connect("codex");

    expect(result.profileId).toBe("profile-1");
    expect(harness.profiles.listProfiles()).toHaveLength(1);
    expect(harness.profiles.listProfiles()[0]?.profile.status).toBe("enabled");
    expect(harness.settings.read().connections).toHaveLength(1);

    harness.close();
  });

  it("lists ready and undetected clients without inspecting a non-ready connector", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    const unavailable = createAdapter("claude-code");
    vi.mocked(unavailable.detect).mockResolvedValue({
      availability: "not_detected",
      reason: "not_installed",
      version: null,
    });
    const service = createDesktopConnectionService({
      profiles: harness.profiles,
      settings: harness.settings,
      adapters: new Map([
        [harness.adapter.id, harness.adapter],
        [unavailable.id, unavailable],
      ]),
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      health: harness.health,
      now: () => timestamp,
      newConnectionId: () => "unused",
    });

    const result = await service.list();

    expect(result).toEqual({
      automatic: [
        {
          adapterId: "codex",
          status: "connected",
          availability: "ready",
          availabilityReason: "connector_ready",
          version: "1.2.3",
          profileId: "profile-1",
        },
        {
          adapterId: "claude-code",
          status: "not_connected",
          availability: "not_detected",
          availabilityReason: "not_installed",
          version: null,
          profileId: null,
        },
      ],
      manual: [],
    });
    expect(unavailable.inspect).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("profile-token");
    expect(JSON.stringify(result)).not.toContain("C:\\Tools");

    harness.close();
  });

  it("isolates adapter detection failures while preserving the remaining catalog", async () => {
    const harness = createHarness();
    const failing = createAdapter("claude-code");
    vi.mocked(harness.adapter.inspect).mockResolvedValue("not_connected");
    vi.mocked(failing.detect).mockRejectedValue(
      new Error("private adapter probe details"),
    );
    const service = createDesktopConnectionService({
      profiles: harness.profiles,
      settings: harness.settings,
      adapters: new Map([
        [harness.adapter.id, harness.adapter],
        [failing.id, failing],
      ]),
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      health: harness.health,
    });

    const catalog = await service.list();

    expect(catalog.automatic[0]).toMatchObject({
      availability: "ready",
      availabilityReason: "connector_ready",
      status: "not_connected",
    });
    expect(catalog.automatic[1]).toMatchObject({
      availability: "setup_required",
      availabilityReason: "probe_failed",
      status: "not_connected",
    });
    expect(failing.inspect).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).not.toContain("private adapter probe details");

    harness.close();
  });

  it("isolates a Codex inspection failure while preserving its owned profile, manual setups, and a healthy peer", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    harness.settings.write({
      ...harness.settings.read(),
      connections: [
        ...harness.settings.read().connections,
        {
          id: "manual-one",
          kind: "manual-mcp",
          label: "Local editor",
          profileId: "profile-manual",
          profileToken: "manual-private-token",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    vi.mocked(harness.adapter.inspect).mockRejectedValue(
      new Error("private Codex inspection details"),
    );
    const peer = createAdapter("claude-code");
    vi.mocked(peer.inspect).mockResolvedValue("not_connected");
    const service = createDesktopConnectionService({
      profiles: harness.profiles,
      settings: harness.settings,
      adapters: new Map([
        [harness.adapter.id, harness.adapter],
        [peer.id, peer],
      ]),
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      health: harness.health,
    });

    const catalog = await service.list();

    expect(catalog.automatic).toEqual([
      {
        adapterId: "codex",
        status: "unknown",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: "profile-1",
      },
      {
        adapterId: "claude-code",
        status: "not_connected",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: null,
      },
    ]);
    expect(catalog.manual).toEqual([{
      id: "manual-one",
      label: "Local editor",
      profileId: "profile-manual",
      state: "setup_created",
      createdAt: timestamp,
    }]);
    expect(JSON.stringify(catalog)).not.toMatch(
      /private Codex inspection details|manual-private-token/,
    );

    harness.close();
  });

  it("isolates an unowned Claude Code inspection failure as unknown while preserving Codex", async () => {
    const harness = createHarness();
    vi.mocked(harness.adapter.inspect).mockResolvedValue("not_connected");
    const failing = createAdapter("claude-code");
    vi.mocked(failing.inspect).mockRejectedValue(
      new Error("private Claude inspection details"),
    );
    const service = createDesktopConnectionService({
      profiles: harness.profiles,
      settings: harness.settings,
      adapters: new Map([
        [harness.adapter.id, harness.adapter],
        [failing.id, failing],
      ]),
      bridgeExecutable: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      health: harness.health,
    });

    const catalog = await service.list();

    expect(catalog.automatic).toEqual([
      {
        adapterId: "codex",
        status: "not_connected",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: null,
      },
      {
        adapterId: "claude-code",
        status: "unknown",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: null,
      },
    ]);
    expect(JSON.stringify(catalog)).not.toContain(
      "private Claude inspection details",
    );

    harness.close();
  });

  it("retains a failed bridge health result across catalog lists until an explicit retest succeeds", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    vi.mocked(harness.health.check).mockRejectedValueOnce(
      new Error("bridge health failed"),
    );

    await expect(harness.service.test("codex")).rejects.toThrow(
      "bridge health failed",
    );

    expect((await harness.service.list()).automatic[0]).toMatchObject({
      adapterId: "codex",
      status: "unknown",
      profileId: "profile-1",
    });
    await expect(harness.service.test("codex")).resolves.toMatchObject({
      adapterId: "codex",
      status: "connected",
      profileId: "profile-1",
    });
    expect((await harness.service.list()).automatic[0]).toMatchObject({
      adapterId: "codex",
      status: "connected",
      profileId: "profile-1",
    });

    harness.close();
  });

  it("reports an existing profile as unknown when its connector is not ready", async () => {
    const harness = createHarness();
    await harness.service.connect("codex");
    vi.mocked(harness.adapter.inspect).mockClear();
    vi.mocked(harness.adapter.detect).mockResolvedValue({
      availability: "setup_required",
      reason: "access_blocked",
      version: null,
    });

    const catalog = await harness.service.list();

    expect(catalog.automatic[0]).toEqual({
      adapterId: "codex",
      status: "unknown",
      availability: "setup_required",
      availabilityReason: "access_blocked",
      version: null,
      profileId: "profile-1",
    });
    expect(harness.adapter.inspect).not.toHaveBeenCalled();

    harness.close();
  });
});

describe("bridge health checking", () => {
  it("passes only the platform allowlist to an authenticated bridge transport", async () => {
    const transportInputs: unknown[] = [];
    const health = createBridgeHealthChecker({
      environment: {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows",
        INTENTARC_SENTINEL_SECRET: "must-not-reach-child",
      },
      platform: "win32",
      createTransport: (input: unknown) => {
        transportInputs.push(input);
        return { stderr: null };
      },
      createClient: () => ({
        connect: async () => undefined,
        listTools: async () => ({
          tools: [{ name: "submit_change_set" }],
        }),
        close: async () => undefined,
      }),
    });

    await health.check({
      bridgeExecutable: "C:\\IntentArc\\IntentArc Bridge.exe",
      connectionId: "connection-1",
      profileId: "profile-1",
    });

    expect(transportInputs).toEqual([{
      command: "C:\\IntentArc\\IntentArc Bridge.exe",
      args: ["--connection", "connection-1"],
      env: {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows",
      },
      stderr: "pipe",
    }]);
    expect(JSON.stringify(transportInputs)).not.toContain(
      "must-not-reach-child",
    );
    expect(createBridgeHealthEnvironment({
      HOME: "/home/me",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/me/.config",
      API_TOKEN: "must-not-reach-child",
    }, "linux")).toEqual({
      HOME: "/home/me",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/me/.config",
    });
    expect(createBridgeHealthEnvironment({
      HOME: "/Users/safe",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
      SECRET: "excluded",
    }, "darwin")).toEqual({
      HOME: "/Users/safe",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
    });
  });
});
