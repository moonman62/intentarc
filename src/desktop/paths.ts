import { basename, dirname, join, posix, win32 } from "node:path";

export interface StableLauncherPathInput {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
}

export interface DesktopBridgeExecutablePathInput
  extends StableLauncherPathInput {
  readonly resourcesPath: string;
}

export interface DesktopSettingsRootInput {
  readonly platform: NodeJS.Platform;
  readonly environment: Partial<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

export const defaultArchivePath = (root: string): string =>
  join(root, "intentarc.sqlite");

export const stableLauncherPath = (input: StableLauncherPathInput): string => {
  if (!input.packaged || input.platform !== "win32") return input.execPath;
  const versionDirectory = win32.basename(win32.dirname(input.execPath));
  if (!/^app-.+$/.test(versionDirectory)) return input.execPath;

  return win32.join(
    win32.dirname(win32.dirname(input.execPath)),
    win32.basename(input.execPath),
  );
};

const requiredSettingsRoot = (
  root: string | undefined,
  platform: NodeJS.Platform,
  isAbsolute: (path: string) => boolean,
): string => {
  const normalized = root?.trim();
  if (!normalized) {
    throw new Error(`IntentArc desktop settings root is unavailable on ${platform}.`);
  }
  if (!isAbsolute(normalized)) {
    throw new Error(`IntentArc desktop settings root must be absolute on ${platform}.`);
  }
  return normalized;
};

export const desktopSettingsRoot = (input: DesktopSettingsRootInput): string => {
  if (input.platform === "win32") {
    return win32.join(
      requiredSettingsRoot(
        input.environment.APPDATA,
        input.platform,
        win32.isAbsolute,
      ),
      "IntentArc",
    );
  }
  if (input.platform === "darwin") {
    return posix.join(
      requiredSettingsRoot(
        input.homeDirectory,
        input.platform,
        posix.isAbsolute,
      ),
      "Library",
      "Application Support",
      "IntentArc",
    );
  }
  if (input.platform === "linux") {
    const configuredRoot = input.environment.XDG_CONFIG_HOME?.trim();
    const configurationRoot = configuredRoot
      ? requiredSettingsRoot(
          configuredRoot,
          input.platform,
          posix.isAbsolute,
        )
      : posix.join(
          requiredSettingsRoot(
            input.homeDirectory,
            input.platform,
            posix.isAbsolute,
          ),
          ".config",
        );
    return posix.join(configurationRoot, "IntentArc");
  }
  throw new Error(`IntentArc desktop settings root is unsupported on ${input.platform}.`);
};

export const stableBridgeExecutablePath = (binaryRoot: string): string =>
  win32.join(
    binaryRoot,
    "bridge",
    "current",
    "IntentArc Bridge.exe",
  );

export const desktopBridgeExecutablePath = (
  input: DesktopBridgeExecutablePathInput,
): string => {
  const versionDirectory = input.platform === "win32"
    ? win32.basename(win32.dirname(input.execPath))
    : "";
  if (
    input.packaged &&
    input.platform === "win32" &&
    !/^app-.+$/.test(versionDirectory)
  ) {
    return win32.join(
      input.resourcesPath,
      "bridge",
      "IntentArc Bridge.exe",
    );
  }

  return stableBridgeExecutablePath(dirname(stableLauncherPath(input)));
};
