import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IntentArcApplication } from "../app/create-application.js";
import type {
  RunningWebServer,
  StartWebServerOptions,
} from "../web/server/http-server.js";
import {
  DESKTOP_CONTENT_SECURITY_POLICY,
  WINDOWS_APP_USER_MODEL_ID,
  runIntentArcDesktop,
  type DesktopAppFacade,
  type DesktopElectronFacade,
  type DesktopWindowFacade,
  type DesktopWindowOptions,
  type PreventableEvent,
} from "./main.js";
import { DESKTOP_IPC_CHANNELS } from "./ipc.js";
import type { DesktopSettings, DesktopSettingsStore } from "./settings.js";
import type { DesktopAutoUpdater } from "./updates.js";

class TestDesktopApp implements DesktopAppFacade {
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  readonly userDataPath = "C:\\Users\\me\\AppData\\Roaming\\IntentArc";
  isPackaged = true;
  singleInstanceLock = true;
  quitCalls = 0;
  relaunchCalls = 0;
  appUserModelIds: string[] = [];

  requestSingleInstanceLock(): boolean {
    return this.singleInstanceLock;
  }

  setAppUserModelId(id: string): void {
    this.appUserModelIds.push(id);
  }

  getPath(name: "userData"): string {
    expect(name).toBe("userData");
    return this.userDataPath;
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  quit(): void {
    this.quitCalls += 1;
  }

  relaunch(): void {
    this.relaunchCalls += 1;
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class TestDesktopWindow implements DesktopWindowFacade {
  loadedUrls: string[] = [];
  focused = 0;
  restored = 0;
  destroyed = 0;
  minimized = false;
  loadFailure: Error | undefined;
  windowOpenHandler: (() => { action: "deny" }) | undefined;
  navigationHandlers: Array<(event: PreventableEvent, url: string) => void> = [];

  constructor(private readonly onDestroy: () => void = () => undefined) {}

  readonly webContents = {
    mainFrame: {
      url: "",
    },
    setWindowOpenHandler: (handler: () => { action: "deny" }): void => {
      this.windowOpenHandler = handler;
    },
    on: (
      _event: "will-navigate" | "will-redirect",
      listener: (event: PreventableEvent, url: string) => void,
    ): void => {
      this.navigationHandlers.push(listener);
    },
  };

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.webContents.mainFrame.url = url;
    if (this.loadFailure) throw this.loadFailure;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.restored += 1;
    this.minimized = false;
  }

  focus(): void {
    this.focused += 1;
  }

  isDestroyed(): boolean {
    return this.destroyed > 0;
  }

  destroy(): void {
    this.destroyed += 1;
    this.onDestroy();
  }
}

class TestDesktopAutoUpdater implements DesktopAutoUpdater {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  feedUrls: string[] = [];
  checks = 0;
  installs = 0;

  setFeedURL({ url }: { url: string }): void {
    this.feedUrls.push(url);
  }

  checkForUpdates(): void {
    this.checks += 1;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(
        (candidate) => candidate !== listener,
      ),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const configuredSettingsStore = (
  archivePath: string | null = "C:\\data\\intentarc.sqlite",
  onboardingCompleted = false,
): DesktopSettingsStore => ({
  read: () => ({
    schemaVersion: 2,
    archivePath,
    onboardingCompleted,
    connections: [],
  }),
  write: () => undefined,
});

const createHarness = ({
  archivePath = "C:\\data\\intentarc.sqlite",
  packaged = true,
  loadFailure,
}: {
  archivePath?: string | null;
  packaged?: boolean;
  loadFailure?: Error;
} = {}) => {
  const app = new TestDesktopApp();
  app.isPackaged = packaged;
  const closeOrder: string[] = [];
  const window = new TestDesktopWindow(() => {
    closeOrder.push("window");
  });
  window.loadFailure = loadFailure;
  const windowOptions: DesktopWindowOptions[] = [];
  const electron: DesktopElectronFacade = {
    app,
    createWindow(options) {
      windowOptions.push(options);
      return window;
    },
  };
  const openedDatabasePaths: string[] = [];
  const startOptions: StartWebServerOptions[] = [];
  const application: IntentArcApplication = {
    service: {} as IntentArcApplication["service"],
    close: () => {
      closeOrder.push("application");
    },
  };
  const server: RunningWebServer = {
    origin: "http://127.0.0.1:49152",
    launchUrl: "http://127.0.0.1:49152/?key=ephemeral-key",
    close: async () => {
      closeOrder.push("http");
    },
  };

  return {
    app,
    window,
    windowOptions,
    openedDatabasePaths,
    startOptions,
    closeOrder,
    options: {
      electron,
      squirrelStartup: false,
      preloadPath: "C:\\package\\dist\\desktop\\preload.cjs",
      settingsStore: configuredSettingsStore(archivePath),
      openApplication: async ({ databasePath }: { databasePath: string }) => {
        openedDatabasePaths.push(databasePath);
        return application;
      },
      startServer: async (options: StartWebServerOptions) => {
        startOptions.push(options);
        return server;
      },
    },
  };
};

describe("IntentArc desktop lifecycle", () => {
  it("opens the configured archive in one secure authenticated window", async () => {
    const harness = createHarness();

    await runIntentArcDesktop(harness.options);

    expect(harness.app.appUserModelIds).toEqual([WINDOWS_APP_USER_MODEL_ID]);
    expect(harness.openedDatabasePaths).toEqual(["C:\\data\\intentarc.sqlite"]);
    expect(harness.startOptions).toHaveLength(1);
    expect(harness.startOptions[0]).toMatchObject({
      application: expect.any(Object),
      port: 0,
      contentSecurityPolicy: DESKTOP_CONTENT_SECURITY_POLICY,
    });
    expect(harness.windowOptions).toHaveLength(1);
    expect(harness.windowOptions[0]?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: "C:\\package\\dist\\desktop\\preload.cjs",
    });
    expect(harness.window.loadedUrls).toEqual([
      "http://127.0.0.1:49152/?key=ephemeral-key",
    ]);
    expect(harness.window.loadedUrls[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/\?key=/,
    );
  });

  it("uses the user-data archive path before one is configured", async () => {
    const harness = createHarness({ archivePath: null });

    await runIntentArcDesktop(harness.options);

    expect(harness.openedDatabasePaths).toEqual([
      join(harness.app.userDataPath, "intentarc.sqlite"),
    ]);
  });

  it("focuses the existing window for a second instance", async () => {
    const harness = createHarness();
    harness.window.minimized = true;
    await runIntentArcDesktop(harness.options);

    harness.app.emit("second-instance");

    expect(harness.windowOptions).toHaveLength(1);
    expect(harness.window.restored).toBe(1);
    expect(harness.window.focused).toBe(1);
  });

  it("denies new windows and navigation outside its exact loopback origin", async () => {
    const harness = createHarness();
    await runIntentArcDesktop(harness.options);

    expect(harness.window.windowOpenHandler?.()).toEqual({ action: "deny" });
    const sameOrigin = { preventDefault: vi.fn() };
    const external = { preventDefault: vi.fn() };
    for (const listener of harness.window.navigationHandlers) {
      listener(sameOrigin, "http://127.0.0.1:49152/projects");
      listener(external, "https://example.com/");
    }

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    expect(external.preventDefault).toHaveBeenCalledTimes(2);
  });

  it("registers the narrow desktop IPC boundary for the application lifetime", async () => {
    const harness = createHarness();
    const handlers = new Map<
      string,
      (event: unknown, payload?: unknown) => Promise<unknown>
    >();
    harness.options.electron.ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    };
    harness.options.electron.showSaveDialog = async () => ({
      canceled: true,
    });

    await runIntentArcDesktop(harness.options);

    expect([...handlers.keys()].sort()).toEqual(
      Object.values(DESKTOP_IPC_CHANNELS).sort(),
    );
    expect(
      await handlers.get(DESKTOP_IPC_CHANNELS.lifecycleGetState)!({
        sender: harness.window.webContents,
        senderFrame: harness.window.webContents.mainFrame,
      }),
    ).toEqual({
      archivePath: "C:\\data\\intentarc.sqlite",
      onboardingCompleted: false,
      restartRequired: false,
    });
    await expect(
      handlers.get(DESKTOP_IPC_CHANNELS.lifecycleGetState)!({
        sender: { mainFrame: harness.window.webContents.mainFrame },
        senderFrame: harness.window.webContents.mainFrame,
      }),
    ).rejects.toThrow("Unauthorized desktop request.");

    harness.app.emit("window-all-closed");
    await vi.waitFor(() => expect(handlers.size).toBe(0));
  });

  it("wires the opt-in updater to credential-free IPC and explicit restart", async () => {
    const harness = createHarness();
    const handlers = new Map<
      string,
      (event: unknown, payload?: unknown) => Promise<unknown>
    >();
    harness.options.electron.ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    };
    const autoUpdater = new TestDesktopAutoUpdater();
    harness.options.electron.autoUpdater = autoUpdater;
    let scheduled: (() => void) | undefined;

    await runIntentArcDesktop({
      ...harness.options,
      environment: {
        INTENTARC_UPDATE_FEED_URL:
          "https://updates.example.test/intentarc",
      },
      argv: ["--squirrel-firstrun"],
      scheduleUpdateCheck: (operation) => {
        scheduled = operation;
        return { dispose: () => undefined };
      },
    });

    const event = {
      sender: harness.window.webContents,
      senderFrame: harness.window.webContents.mainFrame,
    };
    expect(autoUpdater.feedUrls).toEqual([
      "https://updates.example.test/intentarc",
    ]);
    expect(await handlers.get(DESKTOP_IPC_CHANNELS.updatesGetStatus)!(event))
      .toEqual({ state: "idle" });
    scheduled!();
    expect(autoUpdater.checks).toBe(1);
    autoUpdater.emit(
      "update-downloaded",
      {},
      "private release notes",
      "IntentArc 0.2.0",
    );
    expect(await handlers.get(DESKTOP_IPC_CHANNELS.updatesGetStatus)!(event))
      .toEqual({ state: "downloaded", version: "IntentArc 0.2.0" });
    expect(await handlers.get(
      DESKTOP_IPC_CHANNELS.updatesApplyAndRestart,
    )!(event)).toEqual({ restarting: true });
    expect(autoUpdater.installs).toBe(1);
  });

  it("schedules one relaunch through the existing shutdown owner", async () => {
    const harness = createHarness({ archivePath: "C:\\data\\active.sqlite" });
    const handlers = new Map<
      string,
      (event: unknown, payload?: unknown) => Promise<unknown>
    >();
    let settings: DesktopSettings = {
      schemaVersion: 2,
      archivePath: "C:\\data\\active.sqlite",
      onboardingCompleted: true,
      connections: [],
    };
    harness.options.settingsStore = {
      read: () => structuredClone(settings),
      write: (next) => {
        settings = structuredClone(next);
      },
    };
    harness.options.electron.ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    };

    await runIntentArcDesktop(harness.options);
    settings = {
      ...settings,
      archivePath: "D:\\data\\selected.sqlite",
    };

    const restart = handlers.get(DESKTOP_IPC_CHANNELS.lifecycleRestart)!;
    const event = {
      sender: harness.window.webContents,
      senderFrame: harness.window.webContents.mainFrame,
    };
    const first = await restart(event);
    const second = await restart(event);

    expect(first).toEqual({ restarting: true });
    expect(second).toEqual({ restarting: true });
    await vi.waitFor(() => {
      expect(harness.app.relaunchCalls).toBe(1);
      expect(harness.closeOrder).toEqual(["window", "http", "application"]);
      expect(harness.app.quitCalls).toBe(1);
    });
  });

  it("rejects restart without scheduling shutdown when app relaunch throws", async () => {
    const harness = createHarness({ archivePath: "C:\\data\\active.sqlite" });
    const handlers = new Map<
      string,
      (event: unknown, payload?: unknown) => Promise<unknown>
    >();
    let settings: DesktopSettings = {
      schemaVersion: 2,
      archivePath: "C:\\data\\active.sqlite",
      onboardingCompleted: true,
      connections: [],
    };
    harness.options.settingsStore = {
      read: () => structuredClone(settings),
      write: (next) => {
        settings = structuredClone(next);
      },
    };
    harness.options.electron.ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    };

    await runIntentArcDesktop(harness.options);
    settings = {
      ...settings,
      archivePath: "D:\\data\\selected.sqlite",
    };
    vi.spyOn(harness.app, "relaunch").mockImplementation(() => {
      harness.app.relaunchCalls += 1;
      throw new Error("OS relaunch failed");
    });
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
    const restart = handlers.get(DESKTOP_IPC_CHANNELS.lifecycleRestart)!;
    const event = {
      sender: harness.window.webContents,
      senderFrame: harness.window.webContents.mainFrame,
    };

    await expect(restart(event)).rejects.toThrow("Desktop operation failed.");
    expect(harness.app.relaunchCalls).toBe(1);
    expect(setImmediateSpy).not.toHaveBeenCalled();
    expect(harness.window.destroyed).toBe(0);
    expect(harness.closeOrder).toEqual([]);
    expect(harness.app.quitCalls).toBe(0);
    expect(handlers.has(DESKTOP_IPC_CHANNELS.lifecycleRestart)).toBe(true);

    setImmediateSpy.mockRestore();
  });

  it("closes HTTP before the application when the desktop window closes", async () => {
    const harness = createHarness();
    await runIntentArcDesktop(harness.options);

    harness.app.emit("window-all-closed");

    await vi.waitFor(() => {
      expect(harness.closeOrder).toEqual(["window", "http", "application"]);
      expect(harness.app.quitCalls).toBe(1);
    });
  });

  it("disposes the window, HTTP server, and application after startup fails", async () => {
    const harness = createHarness({
      loadFailure: new Error("renderer failed"),
    });

    await expect(runIntentArcDesktop(harness.options)).rejects.toThrow(
      "renderer failed",
    );

    expect(harness.window.destroyed).toBe(1);
    expect(harness.closeOrder).toEqual(["window", "http", "application"]);
    expect(harness.app.quitCalls).toBe(1);
  });

  it("quits without opening resources for Squirrel or a secondary process", async () => {
    const squirrel = createHarness();
    await runIntentArcDesktop({
      ...squirrel.options,
      squirrelStartup: true,
    });

    expect(squirrel.app.quitCalls).toBe(1);
    expect(squirrel.openedDatabasePaths).toEqual([]);
    expect(squirrel.windowOptions).toEqual([]);

    const secondary = createHarness();
    secondary.app.singleInstanceLock = false;
    await runIntentArcDesktop(secondary.options);

    expect(secondary.app.quitCalls).toBe(1);
    expect(secondary.openedDatabasePaths).toEqual([]);
    expect(secondary.windowOptions).toEqual([]);
  });
});
