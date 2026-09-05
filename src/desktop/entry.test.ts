import { describe, expect, it } from "vitest";
import { runDesktopEntry } from "./entry.js";

describe("desktop executable entry", () => {
  it("handles installer arguments before importing or opening the desktop", async () => {
    let desktopStarts = 0;
    const installerArguments: readonly string[][] = [];

    await runDesktopEntry({
      argv: ["--squirrel-updated", "0.2.0"],
      handleInstallerStartup: async (argv) => {
        installerArguments.push(argv);
        return true;
      },
      runDesktop: async () => {
        desktopStarts += 1;
      },
    });

    expect(installerArguments).toEqual([["--squirrel-updated", "0.2.0"]]);
    expect(desktopStarts).toBe(0);
  });

  it("starts the desktop application", async () => {
    let desktopStarts = 0;

    await runDesktopEntry({
      argv: [],
      runDesktop: async () => {
        desktopStarts += 1;
      },
    });

    expect(desktopStarts).toBe(1);
  });

  it("does not recognize bridge connection arguments", async () => {
    let desktopStarts = 0;

    await runDesktopEntry({
      argv: ["--connection", "private-connection-id"],
      runDesktop: async () => {
        desktopStarts += 1;
      },
    });

    expect(desktopStarts).toBe(1);
  });
});
