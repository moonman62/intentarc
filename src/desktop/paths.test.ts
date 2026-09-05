import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultArchivePath,
  desktopBridgeExecutablePath,
  desktopSettingsRoot,
  stableBridgeExecutablePath,
  stableLauncherPath,
} from "./paths.js";

describe("defaultArchivePath", () => {
  it("places the default archive under the desktop data root", () => {
    expect(defaultArchivePath("C:\\Users\\me\\AppData\\Roaming\\IntentArc")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming\\IntentArc", "intentarc.sqlite"),
    );
  });
});

describe("stableLauncherPath", () => {
  it("uses the unversioned Squirrel launcher for packaged Windows builds", () => {
    expect(stableLauncherPath({
      packaged: true,
      platform: "win32",
      execPath: "C:\\Users\\me\\AppData\\Local\\IntentArc\\app-0.1.0\\IntentArc.exe",
    })).toBe("C:\\Users\\me\\AppData\\Local\\IntentArc\\IntentArc.exe");
  });

  it("keeps packaged Windows executables outside Squirrel version directories", () => {
    expect(stableLauncherPath({
      packaged: true,
      platform: "win32",
      execPath: "C:\\repo\\out\\IntentArc-win32-x64\\IntentArc.exe",
    })).toBe("C:\\repo\\out\\IntentArc-win32-x64\\IntentArc.exe");
  });

  it("keeps the supplied executable path outside packaged Windows", () => {
    expect(stableLauncherPath({
      packaged: false,
      platform: "win32",
      execPath: "C:\\workspace\\IntentArc.exe",
    })).toBe("C:\\workspace\\IntentArc.exe");
  });
});

describe("desktopSettingsRoot", () => {
  it("uses the private roaming application-data root on Windows", () => {
    expect(desktopSettingsRoot({
      platform: "win32",
      environment: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\me",
    })).toBe("C:\\Users\\me\\AppData\\Roaming\\IntentArc");
  });

  it("uses native application-support and configuration roots", () => {
    expect(desktopSettingsRoot({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/me",
    })).toBe("/Users/me/Library/Application Support/IntentArc");
    expect(desktopSettingsRoot({
      platform: "linux",
      environment: { XDG_CONFIG_HOME: "/home/me/.xdg-config" },
      homeDirectory: "/home/me",
    })).toBe("/home/me/.xdg-config/IntentArc");
    expect(desktopSettingsRoot({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/me",
    })).toBe("/home/me/.config/IntentArc");
  });

  it.each([
    {
      platform: "win32" as const,
      environment: {},
      homeDirectory: "C:\\Users\\me",
    },
    {
      platform: "darwin" as const,
      environment: {},
      homeDirectory: "",
    },
    {
      platform: "linux" as const,
      environment: {},
      homeDirectory: "",
    },
  ])("rejects missing native roots on $platform", (input) => {
    expect(() => desktopSettingsRoot(input)).toThrow(/settings root/i);
  });

  it.each([
    {
      label: "Windows APPDATA",
      input: {
        platform: "win32" as const,
        environment: { APPDATA: "relative-roaming" },
        homeDirectory: "C:\\Users\\me",
      },
    },
    {
      label: "macOS home",
      input: {
        platform: "darwin" as const,
        environment: {},
        homeDirectory: "relative-home",
      },
    },
    {
      label: "Linux XDG config",
      input: {
        platform: "linux" as const,
        environment: { XDG_CONFIG_HOME: "relative-config" },
        homeDirectory: "/home/me",
      },
    },
    {
      label: "Linux home fallback",
      input: {
        platform: "linux" as const,
        environment: {},
        homeDirectory: "relative-home",
      },
    },
  ])("rejects a relative $label root", ({ input }) => {
    expect(() => desktopSettingsRoot(input)).toThrow(/absolute|settings root/i);
  });
});

describe("stableBridgeExecutablePath", () => {
  it("targets the stable current bridge directory", () => {
    expect(stableBridgeExecutablePath(
      "C:\\Users\\me\\AppData\\Local\\IntentArc",
    )).toBe(
      "C:\\Users\\me\\AppData\\Local\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
    );
  });
});

describe("desktopBridgeExecutablePath", () => {
  it("uses the packaged resource bridge for a raw Forge Windows package", () => {
    expect(desktopBridgeExecutablePath({
      packaged: true,
      platform: "win32",
      execPath: "C:\\repo\\out\\IntentArc-win32-x64\\IntentArc.exe",
      resourcesPath: "C:\\repo\\out\\IntentArc-win32-x64\\resources",
    })).toBe(
      "C:\\repo\\out\\IntentArc-win32-x64\\resources\\bridge\\IntentArc Bridge.exe",
    );
  });

  it("keeps the stable published bridge for an installed Squirrel app", () => {
    expect(desktopBridgeExecutablePath({
      packaged: true,
      platform: "win32",
      execPath: "C:\\Users\\me\\AppData\\Local\\IntentArc\\app-0.1.0\\IntentArc.exe",
      resourcesPath: "C:\\Users\\me\\AppData\\Local\\IntentArc\\app-0.1.0\\resources",
    })).toBe(
      "C:\\Users\\me\\AppData\\Local\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
    );
  });

  it("preserves the development bridge location outside packaged builds", () => {
    expect(desktopBridgeExecutablePath({
      packaged: false,
      platform: "win32",
      execPath: "C:\\workspace\\electron.exe",
      resourcesPath: "C:\\workspace\\node_modules\\electron\\dist\\resources",
    })).toBe(
      "C:\\workspace\\bridge\\current\\IntentArc Bridge.exe",
    );
  });
});
