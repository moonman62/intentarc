import { basename, dirname } from "node:path";
import { isMainModule } from "../system/main-module.js";

export interface RunDesktopEntryOptions {
  argv?: readonly string[];
  handleInstallerStartup?: (
    argv: readonly string[],
  ) => Promise<boolean>;
  runDesktop?: () => Promise<void>;
  resumePendingUpdate?: () => Promise<void>;
}

const runDesktopApplication = async (): Promise<void> => {
  const mainModulePath = "./main.js";
  const desktopModule = await import(mainModulePath) as {
    runIntentArcDesktop?: () => Promise<void>;
  };
  if (!desktopModule.runIntentArcDesktop) {
    throw new Error("IntentArc desktop application is unavailable.");
  }
  await desktopModule.runIntentArcDesktop();
};

const handleInstallerStartup = async (
  argv: readonly string[],
): Promise<boolean> => {
  if (!/^--squirrel-(install|updated|uninstall|obsolete)$/.test(argv[0] ?? "")) {
    return false;
  }
  const [{ app }, { handleSquirrelEvent }] = await Promise.all([
    import("electron"),
    import("./squirrel.js"),
  ]);
  return handleSquirrelEvent({
    argv,
    version: app.getVersion(),
    quit: () => app.quit(),
  });
};

const resumePendingUpdate = async (): Promise<void> => {
  if (process.platform !== "win32") return;
  const applicationDirectory = dirname(process.execPath);
  if (!/^app-.+$/i.test(basename(applicationDirectory))) return;
  const squirrelModulePath = "./squirrel.js";
  const squirrel = await import(squirrelModulePath) as {
    resumePendingBridgeUpdate?: (input: {
      binaryRoot: string;
      resourcesPath: string;
    }) => Promise<boolean>;
  };
  if (!squirrel.resumePendingBridgeUpdate) {
    throw new Error("IntentArc pending bridge updater is unavailable.");
  }
  await squirrel.resumePendingBridgeUpdate({
    binaryRoot: dirname(applicationDirectory),
    resourcesPath: process.resourcesPath,
  });
};

export const runDesktopEntry = async ({
  argv = process.argv.slice(1),
  handleInstallerStartup: handleInstaller = handleInstallerStartup,
  runDesktop = runDesktopApplication,
  resumePendingUpdate: resumePending = resumePendingUpdate,
}: RunDesktopEntryOptions = {}): Promise<void> => {
  if (await handleInstaller(argv)) return;
  await resumePending();
  await runDesktop();
};

if (process.versions.electron || isMainModule(process.argv[1], import.meta.url)) {
  void runDesktopEntry().catch(() => {
    process.stderr.write("IntentArc desktop startup failed.\n");
    process.exitCode = 1;
  });
}
