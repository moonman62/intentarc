import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateApplicationOptions, IntentArcApplication } from "../app/create-application.js";
import { openIntentArcApplication } from "../app/create-application.js";
import {
  startWebServer,
  type RunningWebServer,
  type StartWebServerOptions,
} from "../web/server/http-server.js";
import {
  defaultArchivePath,
  desktopBridgeExecutablePath,
} from "./paths.js";
import { createAiAdapterRegistry } from "./adapters/registry.js";
import {
  createDesktopConnectionService,
  type BridgeHealthChecker,
} from "./connections/service.js";
import {
  registerDesktopIpcHandlers,
  type DesktopIpcFrame,
  type DesktopIpcMain,
  type DesktopIpcWebContents,
} from "./ipc.js";
import {
  createDesktopSettingsStore,
  type DesktopSettingsStore,
} from "./settings.js";
import {
  createDesktopUpdateService,
  type CreateDesktopUpdateServiceOptions,
  type DesktopAutoUpdater,
  type DesktopUpdateService,
} from "./updates.js";

export const WINDOWS_APP_USER_MODEL_ID = "com.squirrel.IntentArc.IntentArc";
export const DESKTOP_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export interface PreventableEvent {
  preventDefault(): void;
}

export interface DesktopAppFacade {
  readonly isPackaged: boolean;
  requestSingleInstanceLock(): boolean;
  setAppUserModelId(id: string): void;
  getPath(name: "userData"): string;
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
  relaunch(): void;
  quit(): void;
}

export interface DesktopWindowOptions {
  width: number;
  height: number;
  webPreferences: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    preload: string;
  };
}

export interface DesktopWindowFacade {
  readonly webContents: DesktopIpcWebContents & {
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(
      event: "will-navigate" | "will-redirect",
      listener: (event: PreventableEvent, url: string) => void,
    ): void;
  };
  loadURL(url: string): Promise<void>;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface DesktopElectronFacade {
  readonly app: DesktopAppFacade;
  autoUpdater?: DesktopAutoUpdater;
  ipcMain?: DesktopIpcMain;
  openPath?(absolutePath: string): Promise<string>;
  openExternal?(url: string): Promise<void>;
  showSaveDialog?(options: {
    title: string;
    defaultPath: string;
    buttonLabel: string;
    filters: Array<{ name: string; extensions: string[] }>;
    properties: Array<"createDirectory" | "showOverwriteConfirmation">;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog?(options: {
    title: string;
    buttonLabel: string;
    properties: Array<"openDirectory">;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  createWindow(options: DesktopWindowOptions): DesktopWindowFacade;
}

export interface RunIntentArcDesktopOptions {
  electron?: DesktopElectronFacade;
  squirrelStartup?: boolean;
  preloadPath?: string;
  settingsStore?: DesktopSettingsStore;
  openApplication?: (
    options: CreateApplicationOptions,
  ) => Promise<IntentArcApplication>;
  startServer?: (
    options: StartWebServerOptions,
  ) => Promise<RunningWebServer>;
  bridgeExecutable?: string;
  resourcesPath?: string;
  bridgeHealth?: BridgeHealthChecker;
  environment?: Partial<Record<string, string | undefined>>;
  argv?: readonly string[];
  scheduleUpdateCheck?: CreateDesktopUpdateServiceOptions["schedule"];
}

const defaultPreloadPath = fileURLToPath(
  new URL("./preload.cjs", import.meta.url),
);

const loadElectron = async (): Promise<DesktopElectronFacade> => {
  const electron = await import("electron");
  return {
    app: electron.app as unknown as DesktopAppFacade,
    autoUpdater: electron.autoUpdater as unknown as DesktopAutoUpdater,
    ipcMain: electron.ipcMain as unknown as DesktopIpcMain,
    openPath: (absolutePath) => electron.shell.openPath(absolutePath),
    openExternal: (url) => electron.shell.openExternal(url),
    showSaveDialog: (options) => electron.dialog.showSaveDialog(options),
    showOpenDialog: (options) => electron.dialog.showOpenDialog(options),
    createWindow: (options) =>
      new electron.BrowserWindow(options) as unknown as DesktopWindowFacade,
  };
};

const isNavigationAllowed = (target: string, origin: string): boolean => {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
};

export const runIntentArcDesktop = async (
  options: RunIntentArcDesktopOptions = {},
): Promise<void> => {
  const electron = options.electron ?? await loadElectron();
  const { app } = electron;

  if (options.squirrelStartup ?? false) {
    app.quit();
    return;
  }

  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let application: IntentArcApplication | undefined;
  let server: RunningWebServer | undefined;
  let mainWindow: DesktopWindowFacade | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let quitPromise: Promise<void> | undefined;
  let disposeIpc: (() => void) | undefined;
  let updateService: DesktopUpdateService | undefined;
  let allowQuit = false;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      let shutdownError: unknown;
      const disposeDesktopIpc = disposeIpc;
      disposeIpc = undefined;
      if (disposeDesktopIpc) {
        try {
          disposeDesktopIpc();
        } catch (error) {
          shutdownError = error;
        }
      }
      const updates = updateService;
      updateService = undefined;
      if (updates) {
        try {
          updates.dispose();
        } catch (error) {
          shutdownError ??= error;
        }
      }
      const window = mainWindow;
      mainWindow = undefined;
      if (window && !window.isDestroyed()) {
        try {
          window.destroy();
        } catch (error) {
          shutdownError = error;
        }
      }

      const runningServer = server;
      server = undefined;
      if (runningServer) {
        try {
          await runningServer.close();
        } catch (error) {
          shutdownError ??= error;
        }
      }

      const runningApplication = application;
      application = undefined;
      if (runningApplication) {
        try {
          runningApplication.close();
        } catch (error) {
          shutdownError ??= error;
        }
      }

      if (shutdownError) throw shutdownError;
    });
    return shutdownPromise;
  };

  const quitAfterShutdown = (): Promise<void> => {
    quitPromise ??= Promise.resolve().then(async () => {
      try {
        await shutdown();
      } finally {
        allowQuit = true;
        app.quit();
      }
    });
    return quitPromise;
  };

  let relaunchScheduled = false;
  const requestRelaunch = (): boolean => {
    if (relaunchScheduled) return true;
    try {
      app.relaunch();
    } catch {
      return false;
    }
    relaunchScheduled = true;
    setImmediate(() => {
      void quitAfterShutdown().catch(() => undefined);
    });
    return true;
  };

  app.on("second-instance", () => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => {
    void quitAfterShutdown().catch(() => undefined);
  });
  app.on("before-quit", ((event: PreventableEvent) => {
    if (allowQuit) return;
    event.preventDefault();
    void quitAfterShutdown().catch(() => undefined);
  }) as (...args: never[]) => void);

  try {
    await app.whenReady();
    if (electron.autoUpdater) {
      updateService = createDesktopUpdateService({
        autoUpdater: electron.autoUpdater,
        feedUrl: options.environment?.INTENTARC_UPDATE_FEED_URL ??
          process.env.INTENTARC_UPDATE_FEED_URL,
        packaged: app.isPackaged,
        platform: process.platform,
        argv: options.argv ?? process.argv.slice(1),
        ...(options.scheduleUpdateCheck === undefined
          ? {}
          : { schedule: options.scheduleUpdateCheck }),
      });
    }
    const userDataPath = app.getPath("userData");
    const settingsStore = options.settingsStore ??
      createDesktopSettingsStore(userDataPath);
    const settings = settingsStore.read();
    const archivePath = settings.archivePath ?? defaultArchivePath(userDataPath);
    application = await (
      options.openApplication ?? openIntentArcApplication
    )({
      databasePath: archivePath,
    });
    server = await (options.startServer ?? startWebServer)({
      application,
      port: 0,
      ...(app.isPackaged
        ? { contentSecurityPolicy: DESKTOP_CONTENT_SECURITY_POLICY }
        : {}),
    });

    const allowedOrigin = server.origin;
    mainWindow = electron.createWindow({
      width: 1_280,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: options.preloadPath ?? defaultPreloadPath,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const denyExternalNavigation = (
      event: PreventableEvent,
      target: string,
    ): void => {
      if (!isNavigationAllowed(target, allowedOrigin)) event.preventDefault();
    };
    mainWindow.webContents.on("will-navigate", denyExternalNavigation);
    mainWindow.webContents.on("will-redirect", denyExternalNavigation);
    if (electron.ipcMain) {
      const bridgeExecutable = options.bridgeExecutable ??
        desktopBridgeExecutablePath({
          packaged: app.isPackaged,
          platform: process.platform,
          execPath: process.execPath,
          resourcesPath: options.resourcesPath ??
            (process as NodeJS.Process & { resourcesPath?: string })
              .resourcesPath ?? dirname(process.execPath),
        });
      const connections = createDesktopConnectionService({
        profiles: application.service.profiles,
        settings: settingsStore,
        adapters: createAiAdapterRegistry(),
        bridgeExecutable,
        ...(options.bridgeHealth === undefined
          ? {}
          : { health: options.bridgeHealth }),
      });
      const trustedMainFrame: DesktopIpcFrame =
        mainWindow.webContents.mainFrame;
      disposeIpc = registerDesktopIpcHandlers({
        ipcMain: electron.ipcMain,
        connections,
        documents: application.service.documents,
        ...(electron.openPath === undefined ? {} : { openPath: electron.openPath }),
        ...(electron.openExternal === undefined
          ? {}
          : { openExternal: electron.openExternal }),
        ...(updateService === undefined ? {} : { updates: updateService }),
        settings: settingsStore,
        defaultArchivePath: defaultArchivePath(userDataPath),
        activeArchivePath: archivePath,
        trustedRenderer: {
          webContents: mainWindow.webContents,
          mainFrame: trustedMainFrame,
          origin: allowedOrigin,
        },
        requestRelaunch,
        selectArchivePath: async () => {
          if (!electron.showSaveDialog) return null;
          const current = settingsStore.read();
          const selection = await electron.showSaveDialog({
            title: "Choose IntentArc archive",
            defaultPath:
              current.archivePath ?? defaultArchivePath(userDataPath),
            buttonLabel: "Use archive",
            filters: [{
              name: "IntentArc archive",
              extensions: ["sqlite"],
            }],
            properties: ["createDirectory", "showOverwriteConfirmation"],
          });
          return selection.canceled ? null : selection.filePath ?? null;
        },
        selectRepositoryDirectory: async () => {
          if (!electron.showOpenDialog) return null;
          const selection = await electron.showOpenDialog({
            title: "Locate repository",
            buttonLabel: "Use repository",
            properties: ["openDirectory"],
          });
          return selection.canceled ? null : selection.filePaths[0] ?? null;
        },
      });
    }
    await mainWindow.loadURL(server.launchUrl);
  } catch (startupError) {
    try {
      await quitAfterShutdown();
    } catch {
      // Preserve the startup failure after making a best effort to dispose.
    }
    throw startupError;
  }
};
