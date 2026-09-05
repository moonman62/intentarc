export const SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS = 10_000;
const STANDARD_UPDATE_DELAY_MS = 10_000;

export type DesktopUpdateStatus =
  | { readonly state: "disabled" }
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available" }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "error" };

export interface DesktopAutoUpdater {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

export interface DesktopUpdateTimer {
  dispose(): void;
}

export interface DesktopUpdateService {
  getStatus(): DesktopUpdateStatus;
  applyAndRestart(): boolean;
  dispose(): void;
}

export interface CreateDesktopUpdateServiceOptions {
  readonly autoUpdater: DesktopAutoUpdater;
  readonly feedUrl: string | undefined;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  readonly schedule?: (
    operation: () => void,
    delayMilliseconds: number,
  ) => DesktopUpdateTimer;
}

const defaultSchedule = (
  operation: () => void,
  delayMilliseconds: number,
): DesktopUpdateTimer => {
  const timer = setTimeout(operation, delayMilliseconds);
  timer.unref();
  return { dispose: () => clearTimeout(timer) };
};

const validatedFeedUrl = (source: string): string => {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("IntentArc update feed URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    source.length > 2_048
  ) {
    throw new Error("IntentArc update feed must be credential-free HTTPS.");
  }
  return url.href.replace(/\/$/, "");
};

const publicVersion = (value: unknown): string => {
  if (typeof value !== "string") return "Update";
  const normalized = value.replace(/[\r\n\t]/g, " ").trim().slice(0, 128);
  return normalized || "Update";
};

export const createDesktopUpdateService = ({
  autoUpdater,
  feedUrl,
  packaged,
  platform,
  argv,
  schedule = defaultSchedule,
}: CreateDesktopUpdateServiceOptions): DesktopUpdateService => {
  const configuredFeedUrl = feedUrl?.trim();
  if (!packaged || platform !== "win32" || !configuredFeedUrl) {
    return {
      getStatus: () => ({ state: "disabled" }),
      applyAndRestart: () => false,
      dispose: () => undefined,
    };
  }

  const url = validatedFeedUrl(configuredFeedUrl);
  let status: DesktopUpdateStatus = { state: "idle" };
  let disposed = false;
  const listeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];
  const listen = (
    event: string,
    listener: (...args: unknown[]) => void,
  ): void => {
    listeners.push({ event, listener });
    autoUpdater.on(event, listener);
  };

  autoUpdater.setFeedURL({ url });
  listen("checking-for-update", () => {
    status = { state: "checking" };
  });
  listen("update-available", () => {
    status = { state: "available" };
  });
  listen("update-not-available", () => {
    status = { state: "idle" };
  });
  listen("update-downloaded", (_event, _notes, releaseName) => {
    status = {
      state: "downloaded",
      version: publicVersion(releaseName),
    };
  });
  listen("error", () => {
    status = { state: "error" };
  });

  const timer = schedule(() => {
    if (disposed) return;
    status = { state: "checking" };
    try {
      autoUpdater.checkForUpdates();
    } catch {
      status = { state: "error" };
    }
  }, argv.includes("--squirrel-firstrun")
    ? SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS
    : STANDARD_UPDATE_DELAY_MS);

  return {
    getStatus: () => status,
    applyAndRestart: () => {
      if (status.state !== "downloaded" || disposed) return false;
      autoUpdater.quitAndInstall();
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      timer.dispose();
      for (const { event, listener } of listeners) {
        autoUpdater.removeListener(event, listener);
      }
      listeners.length = 0;
    },
  };
};
