import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { DesktopConnectionService } from "./connections/service.js";
import {
  DESKTOP_IPC_CHANNELS,
  registerDesktopIpcHandlers,
  type DesktopIpcMain,
} from "./ipc.js";
import type {
  DesktopSettings,
  DesktopSettingsStore,
} from "./settings.js";
import type { DesktopUpdateService } from "./updates.js";

const preloadHarness = {
  exposedName: "",
  exposedValue: undefined as unknown,
  invocations: [] as Array<{ channel: string; payload?: unknown }>,
};
const preloadElectron = {
  contextBridge: {
    exposeInMainWorld(name: string, value: unknown) {
      preloadHarness.exposedName = name;
      preloadHarness.exposedValue = value;
    },
  },
  ipcRenderer: {
    invoke(channel: string, payload?: unknown) {
      preloadHarness.invocations.push(
        payload === undefined ? { channel } : { channel, payload },
      );
      return Promise.resolve({ channel });
    },
  },
};

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;

const trustedMainFrame = {
  url: "http://127.0.0.1:49152/projects",
};
const trustedWebContents = {
  mainFrame: trustedMainFrame,
};
const trustedRenderer = {
  webContents: trustedWebContents,
  mainFrame: trustedMainFrame,
  origin: "http://127.0.0.1:49152",
};
const trustedEvent = {
  sender: trustedWebContents,
  senderFrame: trustedMainFrame,
};
const requestRelaunch = (): boolean => true;

const createIpcMain = () => {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain: DesktopIpcMain = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return { ipcMain, handlers };
};

const createSettings = (
  archivePath: string | null = null,
): DesktopSettingsStore & {
  value(): DesktopSettings;
} => {
  let settings: DesktopSettings = {
    schemaVersion: 2,
    archivePath,
    onboardingCompleted: false,
    connections: [{
      id: "connection-1",
      kind: "managed",
      adapterId: "codex",
      profileId: "profile-1",
      profileToken: "profile-token",
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    }],
  };
  return {
    read: () => structuredClone(settings),
    write: (next) => {
      settings = structuredClone(next);
    },
    value: () => structuredClone(settings),
  };
};

const createConnections = (): DesktopConnectionService => ({
  list: vi.fn(async () => ({
    automatic: [{
      adapterId: "codex",
      status: "connected",
      availability: "ready",
      availabilityReason: "connector_ready",
      version: "1.2.3",
      profileId: "profile-1",
    }],
    manual: [{
      id: "manual-connection",
      label: "Local MCP",
      profileId: "profile-manual",
      state: "setup_created",
      createdAt: "2026-07-30T12:00:00.000Z",
    }],
  })),
  createManual: vi.fn(async ({ label }) => ({
    id: "manual-connection",
    label,
    profileId: "profile-manual",
    state: "setup_created",
    createdAt: "2026-07-30T12:00:00.000Z",
    command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
    args: ["--connection", "manual-connection"],
  })),
  removeManual: vi.fn(async (id) => ({ id })),
  connect: vi.fn(async () => ({
    adapterId: "codex",
    status: "connected",
    profileId: "profile-1",
    restartRequired: true,
  })),
  test: vi.fn(async () => ({
    adapterId: "codex",
    status: "connected",
    availability: "ready",
    availabilityReason: "connector_ready",
    version: "1.2.3",
    profileId: "profile-1",
  })),
  remove: vi.fn(async () => ({
    adapterId: "codex",
    status: "not_connected",
    profileId: "profile-1",
  })),
  launchForProject: vi.fn(async () => ({
    adapterId: "codex",
    result: "manual_required",
  })),
});

const createUpdates = (): DesktopUpdateService => ({
  getStatus: vi.fn(() => ({
    state: "downloaded",
    version: "IntentArc 0.2.0",
  })),
  applyAndRestart: vi.fn(() => true),
  dispose: vi.fn(),
});

describe("desktop IPC", () => {
  it("registers only the reviewed AI and lifecycle methods and returns credential-free results", async () => {
    const ipc = createIpcMain();
    const settings = createSettings();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    expect([...ipc.handlers.keys()].sort()).toEqual([
      "intentarc:ai:connect",
      "intentarc:ai:create-manual",
      "intentarc:ai:launch-for-project",
      "intentarc:ai:list",
      "intentarc:ai:remove",
      "intentarc:ai:remove-manual",
      "intentarc:ai:test",
      "intentarc:documents:open-external-https",
      "intentarc:documents:open-repository-file",
      "intentarc:lifecycle:choose-archive",
      "intentarc:lifecycle:complete-onboarding",
      "intentarc:lifecycle:get-state",
      "intentarc:lifecycle:restart",
      "intentarc:repository:choose-directory",
      "intentarc:updates:apply-and-restart",
      "intentarc:updates:get-status",
    ]);
    const list = await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiList)!(
      trustedEvent,
    );
    const connected = await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiConnect)!(
      trustedEvent,
      "codex",
    );
    const state = await ipc.handlers.get(DESKTOP_IPC_CHANNELS.lifecycleGetState)!(
      trustedEvent,
    );

    expect(list).toEqual({
      automatic: [{
        adapterId: "codex",
        status: "connected",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: "profile-1",
      }],
      manual: [{
        id: "manual-connection",
        label: "Local MCP",
        profileId: "profile-manual",
        state: "setup_created",
        createdAt: "2026-07-30T12:00:00.000Z",
      }],
    });
    expect(connected).toEqual(await connections.connect("codex"));
    expect(state).toEqual({
      archivePath: "C:\\IntentArc\\intentarc.sqlite",
      onboardingCompleted: false,
      restartRequired: false,
    });
    expect(JSON.stringify({ list, connected, state })).not.toContain(
      "profile-token",
    );
    expect(JSON.stringify(list)).not.toContain("command");
  });

  it("normalizes a safe Unicode manual label and returns setup details only from explicit creation", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const created = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.aiCreateManual,
    )!(trustedEvent, {
      label: "  Editor \u{1f469}\u200d\u{1f4bb}  ",
    });

    expect(connections.createManual).toHaveBeenCalledWith({
      label: "Editor \u{1f469}\u200d\u{1f4bb}",
    });
    expect(created).toEqual({
      id: "manual-connection",
      label: "Editor \u{1f469}\u200d\u{1f4bb}",
      profileId: "profile-manual",
      state: "setup_created",
      createdAt: "2026-07-30T12:00:00.000Z",
      command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
      args: ["--connection", "manual-connection"],
    });
    expect(JSON.stringify(created)).not.toContain("profileToken");
  });

  it.each([
    { name: "empty", payload: { label: "" } },
    { name: "whitespace", payload: { label: "   " } },
    { name: "control", payload: { label: "line\nbreak" } },
    { name: "format control", payload: { label: "right\u202eto-left" } },
    { name: "standalone ZWJ", payload: { label: "\u200d" } },
    { name: "embedded text ZWJ", payload: { label: "A\u200dB" } },
    {
      name: "dangling emoji ZWJ",
      payload: { label: "Editor \u{1f469}\u200d" },
    },
    { name: "line separator", payload: { label: "line\u2028break" } },
    { name: "blank glyph", payload: { label: "\u2800" } },
    { name: "invisible-only", payload: { label: "\ufe0f" } },
    {
      name: "over 80 graphemes",
      payload: { label: "\u{1f469}\u200d\u{1f4bb}".repeat(81) },
    },
    { name: "unknown field", payload: { label: "Local MCP", token: "secret" } },
  ])("rejects a manual label with $name content", async ({ payload }) => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    await expect(
      ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiCreateManual)!(
        trustedEvent,
        payload,
      ),
    ).rejects.toThrow("Invalid desktop request.");
    expect(connections.createManual).not.toHaveBeenCalled();
  });

  it("accepts an 80-grapheme manual label at the persistence boundary", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });
    const label = "\u{1f469}\u200d\u{1f4bb}".repeat(80);

    await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiCreateManual)!(
      trustedEvent,
      { label },
    );

    expect(connections.createManual).toHaveBeenCalledWith({ label });
  });

  it.each(["", "   ", "x".repeat(513), { id: "manual-connection" }])(
    "rejects an unbounded or non-opaque manual connection id",
    async (id) => {
      const ipc = createIpcMain();
      const connections = createConnections();
      registerDesktopIpcHandlers({
        ipcMain: ipc.ipcMain,
        connections,
        settings: createSettings(),
        defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        trustedRenderer,
        selectArchivePath: async () => null,
        requestRelaunch,
      });

      await expect(
        ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiRemoveManual)!(
          trustedEvent,
          id,
        ),
      ).rejects.toThrow("Invalid desktop request.");
      expect(connections.removeManual).not.toHaveBeenCalled();
    },
  );

  it("removes a manual connection by its normalized opaque id", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const removed = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.aiRemoveManual,
    )!(trustedEvent, "  manual-connection  ");

    expect(connections.removeManual).toHaveBeenCalledWith("manual-connection");
    expect(removed).toEqual({ id: "manual-connection" });
  });

  it("rejects profile tokens or mismatched args in explicit manual setup output", async () => {
    const invalidOutputs = [
      {
        id: "manual-connection",
        label: "Local MCP",
        profileId: "profile-manual",
        state: "setup_created",
        createdAt: "2026-07-30T12:00:00.000Z",
        command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
        args: ["--connection", "manual-connection"],
        profileToken: "must-not-cross-ipc",
      },
      {
        id: "manual-connection",
        label: "Local MCP",
        profileId: "profile-manual",
        state: "setup_created",
        createdAt: "2026-07-30T12:00:00.000Z",
        command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
        args: ["--connection", "different-connection"],
      },
    ];

    for (const output of invalidOutputs) {
      const ipc = createIpcMain();
      const connections = createConnections();
      vi.mocked(connections.createManual).mockResolvedValueOnce(output as never);
      registerDesktopIpcHandlers({
        ipcMain: ipc.ipcMain,
        connections,
        settings: createSettings(),
        defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        trustedRenderer,
        selectArchivePath: async () => null,
        requestRelaunch,
      });

      await expect(
        ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiCreateManual)!(
          trustedEvent,
          { label: "Local MCP" },
        ),
      ).rejects.toThrow("Desktop operation failed.");
    }
  });

  it("schedules a relaunch only for a completed onboarding with a changed archive", async () => {
    const ipc = createIpcMain();
    const settings = createSettings("C:\\Data\\chosen.sqlite");
    settings.write({ ...settings.read(), onboardingCompleted: true });
    const requestRelaunch = vi.fn(() => true);
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\active.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const restartHandler = ipc.handlers.get("intentarc:lifecycle:restart")!;
    await expect(restartHandler(trustedEvent)).resolves.toEqual({
      restarting: true,
    });
    expect(requestRelaunch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: false,
      activeArchivePath: "C:\\Data\\active.sqlite",
    },
    {
      archivePath: "C:\\Data\\active.sqlite",
      onboardingCompleted: true,
      activeArchivePath: "C:\\Data\\active.sqlite",
    },
  ])(
    "refuses relaunch when lifecycle state is not restartable",
    async ({ archivePath, onboardingCompleted, activeArchivePath }) => {
      const ipc = createIpcMain();
      const settings = createSettings(archivePath);
      settings.write({ ...settings.read(), onboardingCompleted });
      const requestRelaunch = vi.fn(() => true);
      registerDesktopIpcHandlers({
        ipcMain: ipc.ipcMain,
        connections: createConnections(),
        settings,
        defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        activeArchivePath,
        trustedRenderer,
        selectArchivePath: async () => null,
        requestRelaunch,
      });

      const restartHandler = ipc.handlers.get("intentarc:lifecycle:restart")!;
      await expect(restartHandler(trustedEvent)).rejects.toThrow(
        "Desktop operation failed.",
      );
      expect(requestRelaunch).not.toHaveBeenCalled();
    },
  );

  it("reports update state without feed details and applies only through the explicit restart channel", async () => {
    const ipc = createIpcMain();
    const updates = createUpdates();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      updates,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const status = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.updatesGetStatus,
    )!(trustedEvent);
    const applied = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.updatesApplyAndRestart,
    )!(trustedEvent);

    expect(status).toEqual({
      state: "downloaded",
      version: "IntentArc 0.2.0",
    });
    expect(applied).toEqual({ restarting: true });
    expect(JSON.stringify({ status, applied })).not.toMatch(
      /feed|url|token|credential|password/i,
    );
    expect(updates.applyAndRestart).toHaveBeenCalledOnce();
  });

  it("rejects malformed requests in the main process without echoing credential-bearing input", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const malicious = {
      adapterId: "codex",
      token: "do-not-echo",
      command: "raw private command",
      url: "https://secret.invalid/?credential=do-not-echo",
    };
    let failure: unknown;
    try {
      await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiConnect)!(
        trustedEvent,
        malicious,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain("do-not-echo");
    expect(String(failure)).toBe("Error: Invalid desktop request.");
    expect(connections.connect).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing service responses instead of filtering them into IPC", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    vi.mocked(connections.connect).mockResolvedValueOnce({
      adapterId: "codex",
      status: "connected",
      profileId: "profile-1",
      restartRequired: true,
      profileToken: "must-not-cross-ipc",
    } as never);
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    let failure: unknown;
    try {
      await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiConnect)!(
        trustedEvent,
        "codex",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain("must-not-cross-ipc");
    expect(String(failure)).toBe("Error: Desktop operation failed.");
  });

  it("rejects non-catalog AI list output without serializing raw probe details", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    vi.mocked(connections.list).mockResolvedValueOnce({
      automatic: [{
        adapterId: "codex",
        status: "not_connected",
        availability: "setup_required",
        availabilityReason: "probe_failed",
        version: null,
        profileId: null,
        error: "private adapter probe details",
      }],
    } as never);
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    let failure: unknown;
    try {
      await ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiList)!(trustedEvent);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: Desktop operation failed.");
    expect(JSON.stringify(failure)).not.toContain("private adapter probe details");
  });

  it("chooses an archive through the privileged selector and completes onboarding without exposing settings connections", async () => {
    const ipc = createIpcMain();
    const settings = createSettings();
    const selectArchivePath = vi.fn(async () => "C:\\Data\\chosen.sqlite");
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath,
      requestRelaunch,
    });

    const selected = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    )!(trustedEvent);
    const completed = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleCompleteOnboarding,
    )!(trustedEvent);

    expect(selectArchivePath).toHaveBeenCalledOnce();
    expect(selected).toEqual({
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: false,
      restartRequired: true,
    });
    expect(completed).toEqual({
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: true,
      restartRequired: true,
    });
    expect(settings.value()).toMatchObject({
      archivePath: "C:\\Data\\chosen.sqlite",
      onboardingCompleted: true,
    });
    expect(JSON.stringify({ selected, completed })).not.toContain(
      "connections",
    );
  });

  it("persists the effective default archive when onboarding completes without another selection", async () => {
    const ipc = createIpcMain();
    const settings = createSettings();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleCompleteOnboarding,
    )!(trustedEvent);

    expect(settings.value()).toMatchObject({
      archivePath: "C:\\IntentArc\\intentarc.sqlite",
      onboardingCompleted: true,
    });
  });

  it("re-resolves a node ID through the document service immediately before opening it", async () => {
    const ipc = createIpcMain();
    const calls: string[] = [];
    const documents = {
      resolveExternalOpen: vi.fn(() => {
        calls.push("resolve");
        return {
          status: "openable" as const,
          absolutePath: "C:\\projects\\IntentArc\\docs\\overview.md",
        };
      }),
    };
    const openPath = vi.fn(async () => {
      calls.push("open");
      return "";
    });
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      documents,
      openPath,
      openExternal: vi.fn(async () => undefined),
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const result = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.documentsOpenRepositoryFile,
    )!(trustedEvent, { projectId: "project-1", nodeId: "node-1" });

    expect(result).toEqual({ opened: true });
    expect(documents.resolveExternalOpen).toHaveBeenCalledWith(
      "project-1",
      "node-1",
    );
    expect(openPath).toHaveBeenCalledWith(
      "C:\\projects\\IntentArc\\docs\\overview.md",
    );
    expect(calls).toEqual(["resolve", "open"]);
  });

  it("rejects untrusted, path-shaped, stale, and blocked repository-open requests", async () => {
    const statuses = ["stale", "missing", "unavailable", "blocked"] as const;
    for (const status of statuses) {
      const ipc = createIpcMain();
      const openPath = vi.fn(async () => "");
      const documents = {
        resolveExternalOpen: vi.fn(() => ({ status })),
      };
      registerDesktopIpcHandlers({
        ipcMain: ipc.ipcMain,
        connections: createConnections(),
        documents,
        openPath,
        openExternal: vi.fn(async () => undefined),
        settings: createSettings(),
        defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
        trustedRenderer,
        selectArchivePath: async () => null,
        requestRelaunch,
      });
      const operation = ipc.handlers.get(
        DESKTOP_IPC_CHANNELS.documentsOpenRepositoryFile,
      )!;

      await expect(operation(trustedEvent, {
        projectId: "project-1",
        nodeId: "node-1",
      })).rejects.toThrow("Desktop operation failed.");
      await expect(operation(trustedEvent, {
        projectId: "project-1",
        nodeId: "node-1",
        path: "C:\\private\\repository\\secret.md",
      })).rejects.toThrow("Invalid desktop request.");
      await expect(operation({
        sender: trustedWebContents,
        senderFrame: { url: "https://attacker.invalid" },
      }, {
        projectId: "project-1",
        nodeId: "node-1",
      })).rejects.toThrow("Unauthorized desktop request.");
      expect(openPath).not.toHaveBeenCalled();
    }
  });

  it("opens only explicit unambiguous credential-free HTTPS URLs from the trusted frame", async () => {
    const ipc = createIpcMain();
    const openExternal = vi.fn(async () => undefined);
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      documents: {
        resolveExternalOpen: () => ({ status: "blocked" as const }),
      },
      openPath: vi.fn(async () => ""),
      openExternal,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });
    const operation = ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.documentsOpenExternalHttps,
    )!;

    await expect(operation(
      trustedEvent,
      "https://example.com/reference?q=reviewed#section",
    )).resolves.toEqual({ opened: true });
    expect(openExternal).toHaveBeenCalledWith(
      "https://example.com/reference?q=reviewed#section",
    );

    for (const unsafe of [
      "http://example.com",
      "javascript:alert(1)",
      "https:example.com",
      "https:///example.com",
      "https://user:secret@example.com",
      "https://example.com\\@attacker.invalid",
      " https://example.com",
      "//example.com",
    ]) {
      await expect(operation(trustedEvent, unsafe)).rejects.toThrow(
        "Invalid desktop request.",
      );
    }
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("validates a project launch as one strict absolute-path request", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    const result = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.aiLaunchForProject,
    )!(trustedEvent, {
      adapterId: "codex",
      repositoryPath: "C:\\projects\\IntentArc",
      request: {
        action: "project_setup",
        runId: "run-1",
      },
    });

    expect(connections.launchForProject).toHaveBeenCalledWith({
      adapterId: "codex",
      repositoryPath: "C:\\projects\\IntentArc",
      request: {
        action: "project_setup",
        runId: "run-1",
      },
    });
    expect(result).toEqual({
      adapterId: "codex",
      result: "manual_required",
    });
  });

  it("rejects unrelated senders and same-origin subframes before privileged work", async () => {
    const ipc = createIpcMain();
    const connections = createConnections();
    const selectArchivePath = vi.fn(async () => "C:\\Data\\chosen.sqlite");
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections,
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath,
      requestRelaunch,
    });

    await expect(
      ipc.handlers.get(DESKTOP_IPC_CHANNELS.aiRemove)!({
        sender: { mainFrame: trustedMainFrame },
        senderFrame: trustedMainFrame,
      }, "codex"),
    ).rejects.toThrow("Unauthorized desktop request.");
    await expect(
      ipc.handlers.get(DESKTOP_IPC_CHANNELS.lifecycleChooseArchive)!({
        sender: trustedWebContents,
        senderFrame: {
          url: "http://127.0.0.1:49152/embedded",
        },
      }),
    ).rejects.toThrow("Unauthorized desktop request.");

    expect(connections.remove).not.toHaveBeenCalled();
    expect(selectArchivePath).not.toHaveBeenCalled();
  });

  it("returns repository directory choices only to the trusted main frame", async () => {
    const ipc = createIpcMain();
    const selectRepositoryDirectory = vi.fn(async () => "C:\\projects\\IntentArc");
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings: createSettings(),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      trustedRenderer,
      selectArchivePath: async () => null,
      selectRepositoryDirectory,
      requestRelaunch,
    });
    const choose = ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.repositoryChooseDirectory,
    )!;

    await expect(choose(trustedEvent)).resolves.toBe("C:\\projects\\IntentArc");
    await expect(choose({
      sender: trustedWebContents,
      senderFrame: { url: "http://127.0.0.1:49152/embedded" },
    })).rejects.toThrow("Unauthorized desktop request.");
    expect(selectRepositoryDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "same configured Windows path",
      configured: "C:\\Data\\Arc.sqlite",
      active: "C:\\Data\\Arc.sqlite",
      selected: "c:\\data\\arc.sqlite",
      canceled: false,
      restartRequired: false,
    },
    {
      label: "same effective default",
      configured: null,
      active: "C:\\IntentArc\\intentarc.sqlite",
      selected: "C:\\IntentArc\\intentarc.sqlite",
      canceled: false,
      restartRequired: false,
    },
    {
      label: "different archive",
      configured: "C:\\Data\\old.sqlite",
      active: "C:\\Data\\old.sqlite",
      selected: "C:\\Data\\new.sqlite",
      canceled: false,
      restartRequired: true,
    },
    {
      label: "cancelled selection",
      configured: "C:\\Data\\old.sqlite",
      active: "C:\\Data\\old.sqlite",
      selected: null,
      canceled: true,
      restartRequired: false,
    },
  ])("reports restart accurately for $label", async ({
    configured,
    active,
    selected,
    restartRequired,
  }) => {
    const ipc = createIpcMain();
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings: createSettings(configured),
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: active,
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath: async () => selected,
      requestRelaunch,
    });

    const result = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    )!(trustedEvent);

    expect(result).toMatchObject({ restartRequired });
  });

  it("keeps a changed archive restart-required when a second picker is cancelled", async () => {
    const ipc = createIpcMain();
    const settings = createSettings("C:\\Data\\active.sqlite");
    const selectArchivePath = vi.fn()
      .mockResolvedValueOnce("C:\\Data\\selected.sqlite")
      .mockResolvedValueOnce(null);
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\active.sqlite",
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath,
      requestRelaunch,
    });

    const choose = ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    )!;
    expect(await choose(trustedEvent)).toMatchObject({
      archivePath: "C:\\Data\\selected.sqlite",
      restartRequired: true,
    });
    expect(await choose(trustedEvent)).toMatchObject({
      archivePath: "C:\\Data\\selected.sqlite",
      restartRequired: true,
    });
  });

  it("reports a changed configured archive to a remounted renderer", async () => {
    const ipc = createIpcMain();
    const settings = createSettings("C:\\Data\\active.sqlite");
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\active.sqlite",
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath: async () => "C:\\Data\\selected.sqlite",
      requestRelaunch,
    });

    await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    )!(trustedEvent);
    const remountedState = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleGetState,
    )!(trustedEvent);

    expect(remountedState).toEqual({
      archivePath: "C:\\Data\\selected.sqlite",
      onboardingCompleted: false,
      restartRequired: true,
    });
  });

  it("does not require restart when selection returns to the active archive", async () => {
    const ipc = createIpcMain();
    const settings = createSettings("C:\\Data\\selected.sqlite");
    registerDesktopIpcHandlers({
      ipcMain: ipc.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\active.sqlite",
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath: async () => "c:\\data\\ACTIVE.sqlite",
      requestRelaunch,
    });

    const selected = await ipc.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    )!(trustedEvent);

    expect(selected).toEqual({
      archivePath: "c:\\data\\ACTIVE.sqlite",
      onboardingCompleted: false,
      restartRequired: false,
    });
  });

  it("clears restart-required after the configured archive becomes active on reopen", async () => {
    const settings = createSettings("C:\\Data\\selected.sqlite");
    const beforeReopen = createIpcMain();
    registerDesktopIpcHandlers({
      ipcMain: beforeReopen.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\active.sqlite",
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });
    const afterReopen = createIpcMain();
    registerDesktopIpcHandlers({
      ipcMain: afterReopen.ipcMain,
      connections: createConnections(),
      settings,
      defaultArchivePath: "C:\\IntentArc\\intentarc.sqlite",
      activeArchivePath: "C:\\Data\\selected.sqlite",
      pathPlatform: "win32",
      trustedRenderer,
      selectArchivePath: async () => null,
      requestRelaunch,
    });

    expect(await beforeReopen.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleGetState,
    )!(trustedEvent)).toMatchObject({ restartRequired: true });
    expect(await afterReopen.handlers.get(
      DESKTOP_IPC_CHANNELS.lifecycleGetState,
    )!(trustedEvent)).toMatchObject({ restartRequired: false });
  });
});

describe("desktop preload", () => {
  it("exposes only reviewed credential-free calls over fixed IPC channels", async () => {
    preloadHarness.exposedName = "";
    preloadHarness.exposedValue = undefined;
    preloadHarness.invocations.length = 0;
    const source = readFileSync(
      new URL("./preload.cts", import.meta.url),
      "utf8",
    );
    const compiled = transformSync(source, {
      format: "cjs",
      loader: "ts",
      target: "es2024",
    }).code;
    runInNewContext(compiled, {
      exports: {},
      module: { exports: {} },
      require: (specifier: string) => {
        if (specifier === "electron") return preloadElectron;
        throw new Error("Unexpected preload dependency.");
      },
    });

    expect(preloadHarness.exposedName).toBe("intentArcDesktop");
    const exposed = preloadHarness.exposedValue as {
      ai: Record<string, (...args: unknown[]) => Promise<unknown>>;
      lifecycle: Record<string, (...args: unknown[]) => Promise<unknown>>;
      updates: Record<string, (...args: unknown[]) => Promise<unknown>>;
      documents: Record<string, ((...args: unknown[]) => Promise<unknown>) | boolean>;
      repository: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };
    expect(Object.keys(exposed)).toEqual(["ai", "lifecycle", "updates", "documents", "repository"]);
    expect(Object.keys(exposed.ai)).toEqual([
      "list",
      "connect",
      "test",
      "remove",
      "createManual",
      "removeManual",
      "launchForProject",
    ]);
    expect(Object.keys(exposed.lifecycle)).toEqual([
      "getState",
      "chooseArchive",
      "completeOnboarding",
      "restart",
    ]);
    expect(Object.keys(exposed.updates)).toEqual([
      "getStatus",
      "applyAndRestart",
    ]);
    expect(Object.keys(exposed.documents)).toEqual([
      "externalOpenAvailable",
      "openRepositoryFile",
      "openExternalHttps",
    ]);
    expect(exposed.documents.externalOpenAvailable).toBe(true);
    expect(Object.keys(exposed.repository)).toEqual(["chooseRepositoryDirectory"]);

    await exposed.ai.list!();
    await exposed.ai.connect!("codex");
    await exposed.ai.createManual!({ label: "Local MCP" });
    await exposed.ai.removeManual!("manual-connection");
    await exposed.ai.launchForProject!({
      adapterId: "codex",
      repositoryPath: "C:\\projects\\IntentArc",
    });
    await exposed.lifecycle.getState!();
    await exposed.lifecycle.restart!();
    await exposed.updates.getStatus!();
    await exposed.updates.applyAndRestart!();
    await (exposed.documents.openRepositoryFile as (...args: unknown[]) => Promise<unknown>)(
      "project-1",
      "node-1",
    );
    await (exposed.documents.openExternalHttps as (...args: unknown[]) => Promise<unknown>)(
      "https://example.com/docs",
    );
    await exposed.repository.chooseRepositoryDirectory!();

    expect(preloadHarness.invocations).toEqual([
      { channel: DESKTOP_IPC_CHANNELS.aiList },
      { channel: DESKTOP_IPC_CHANNELS.aiConnect, payload: "codex" },
      {
        channel: DESKTOP_IPC_CHANNELS.aiCreateManual,
        payload: { label: "Local MCP" },
      },
      {
        channel: DESKTOP_IPC_CHANNELS.aiRemoveManual,
        payload: "manual-connection",
      },
      {
        channel: DESKTOP_IPC_CHANNELS.aiLaunchForProject,
        payload: {
          adapterId: "codex",
          repositoryPath: "C:\\projects\\IntentArc",
        },
      },
      { channel: DESKTOP_IPC_CHANNELS.lifecycleGetState },
      { channel: "intentarc:lifecycle:restart" },
      { channel: DESKTOP_IPC_CHANNELS.updatesGetStatus },
      { channel: DESKTOP_IPC_CHANNELS.updatesApplyAndRestart },
      {
        channel: DESKTOP_IPC_CHANNELS.documentsOpenRepositoryFile,
        payload: { projectId: "project-1", nodeId: "node-1" },
      },
      {
        channel: DESKTOP_IPC_CHANNELS.documentsOpenExternalHttps,
        payload: "https://example.com/docs",
      },
      { channel: DESKTOP_IPC_CHANNELS.repositoryChooseDirectory },
    ]);
  });
});
