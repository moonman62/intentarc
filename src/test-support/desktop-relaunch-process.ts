import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  openIntentArcApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopIpcEvent,
  type DesktopIpcMain,
} from "../desktop/ipc.js";
import {
  runIntentArcDesktop,
  type DesktopAppFacade,
  type DesktopElectronFacade,
  type DesktopWindowFacade,
  type DesktopWindowOptions,
} from "../desktop/main.js";
import { createDesktopSettingsStore } from "../desktop/settings.js";
import type { StartWebServerOptions } from "../web/server/http-server.js";

type HarnessPhase = "before-relaunch" | "replacement";

class HarnessApp implements DesktopAppFacade {
  readonly isPackaged = true;
  readonly listeners = new Map<
    string,
    Array<(...args: never[]) => void>
  >();
  readonly quitPromise: Promise<void>;
  relaunchCalls = 0;
  quitCalls = 0;
  private resolveQuit!: () => void;

  constructor(private readonly userDataPath: string) {
    this.quitPromise = new Promise((resolveQuit) => {
      this.resolveQuit = resolveQuit;
    });
  }

  requestSingleInstanceLock(): boolean {
    return true;
  }

  setAppUserModelId(): void {}

  getPath(name: "userData"): string {
    if (name !== "userData") throw new Error("Unexpected app path request.");
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

  relaunch(): void {
    this.relaunchCalls += 1;
  }

  quit(): void {
    this.quitCalls += 1;
    this.resolveQuit();
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class HarnessWindow implements DesktopWindowFacade {
  destroyed = 0;
  readonly webContents = {
    mainFrame: { url: "" },
    setWindowOpenHandler: () => undefined,
    on: () => undefined,
  };

  constructor(private readonly closeOrder: string[]) {}

  async loadURL(url: string): Promise<void> {
    this.webContents.mainFrame.url = url;
  }

  isMinimized(): boolean {
    return false;
  }

  restore(): void {}

  focus(): void {}

  isDestroyed(): boolean {
    return this.destroyed > 0;
  }

  destroy(): void {
    this.destroyed += 1;
    this.closeOrder.push("window");
  }
}

const waitForQuit = async (app: HarnessApp): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.quitPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for desktop shutdown."));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const runPhase = async (
  phase: HarnessPhase,
  userDataPath: string,
  selectedArchivePath: string,
): Promise<Record<string, unknown>> => {
  const settings = createDesktopSettingsStore(userDataPath);
  const handlers = new Map<
    string,
    (event: DesktopIpcEvent, payload?: unknown) => Promise<unknown>
  >();
  const ipcMain: DesktopIpcMain = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const closeOrder: string[] = [];
  const app = new HarnessApp(userDataPath);
  const window = new HarnessWindow(closeOrder);
  const windowOptions: DesktopWindowOptions[] = [];
  const electron: DesktopElectronFacade = {
    app,
    ipcMain,
    showSaveDialog: async () => ({
      canceled: false,
      filePath: selectedArchivePath,
    }),
    createWindow(options) {
      windowOptions.push(options);
      return window;
    },
  };
  const openedArchivePaths: string[] = [];

  await runIntentArcDesktop({
    electron,
    squirrelStartup: false,
    preloadPath: resolve(userDataPath, "synthetic-preload.cjs"),
    bridgeExecutable: resolve(userDataPath, "synthetic-bridge.exe"),
    settingsStore: settings,
    openApplication: async (options): Promise<IntentArcApplication> => {
      openedArchivePaths.push(options.databasePath);
      const application = await openIntentArcApplication(options);
      return {
        service: application.service,
        close: () => {
          closeOrder.push("application");
          application.close();
        },
      };
    },
    startServer: async (_options: StartWebServerOptions) => ({
      origin: "http://127.0.0.1:49152",
      launchUrl: "http://127.0.0.1:49152/?key=synthetic-launch-key",
      close: async () => {
        closeOrder.push("http");
      },
    }),
  });

  if (windowOptions.length !== 1) {
    throw new Error("Desktop did not create exactly one window.");
  }
  const event: DesktopIpcEvent = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const invoke = async (channel: string): Promise<unknown> => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error(`Missing desktop IPC handler: ${channel}`);
    return listener(event);
  };

  if (phase === "before-relaunch") {
    const selectedState = await invoke(
      DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    );
    const completedState = await invoke(
      DESKTOP_IPC_CHANNELS.lifecycleCompleteOnboarding,
    );
    const restartResult = await invoke(
      DESKTOP_IPC_CHANNELS.lifecycleRestart,
    );
    await waitForQuit(app);
    return {
      phase,
      processId: process.pid,
      openedArchivePath: openedArchivePaths[0],
      selectedState,
      completedState,
      restartResult,
      relaunchCalls: app.relaunchCalls,
      quitCalls: app.quitCalls,
      closeOrder,
      persistedArchivePath: settings.read().archivePath,
    };
  }

  const lifecycleState = await invoke(
    DESKTOP_IPC_CHANNELS.lifecycleGetState,
  );
  app.emit("window-all-closed");
  await waitForQuit(app);
  const selectedArchiveExists = await stat(selectedArchivePath).then(
    () => true,
    () => false,
  );
  return {
    phase,
    processId: process.pid,
    openedArchivePath: openedArchivePaths[0],
    lifecycleState,
    selectedArchiveExists,
    relaunchCalls: app.relaunchCalls,
    quitCalls: app.quitCalls,
    closeOrder,
  };
};

const main = async (): Promise<void> => {
  const phase = process.argv[2];
  const userDataPath = process.argv[3];
  const selectedArchivePath = process.argv[4];
  if (
    (phase !== "before-relaunch" && phase !== "replacement") ||
    !userDataPath ||
    !selectedArchivePath
  ) {
    throw new Error("Expected phase, user-data path, and selected archive.");
  }
  const result = await runPhase(phase, userDataPath, selectedArchivePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message :
    String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
