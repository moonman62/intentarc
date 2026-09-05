import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInstallerAcceptancePreflight,
  classifySquirrelUninstallResidue,
  createWindowsSpecialFoldersScript,
  createReadOnlyTreeManifest,
  parseQuietUninstallCommand,
} from "../../../scripts/squirrel-uninstall-acceptance.mjs";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("Squirrel uninstall acceptance boundaries", () => {
  it.skipIf(process.platform !== "win32")(
    "emits an executable Windows special-folder query",
    async () => {
      const powerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const { stdout } = await execFileAsync(powerShell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        createWindowsSpecialFoldersScript(),
      ], { windowsHide: true });

      expect(JSON.parse(stdout)).toMatchObject({
        localAppData: expect.stringMatching(/^[A-Za-z]:\\/),
        appData: expect.stringMatching(/^[A-Za-z]:\\/),
        desktop: expect.stringMatching(/^[A-Za-z]:\\/),
        programs: expect.stringMatching(/^[A-Za-z]:\\/),
      });
    },
  );

  it("accepts only Squirrel tombstone and self-deletion files", () => {
    expect(classifySquirrelUninstallResidue([])).toEqual({
      accepted: [],
      unexpected: [],
    });
    expect(classifySquirrelUninstallResidue([
      ".dead",
      "Update.exe",
      "app-0.1.0/",
      "app-0.1.0/squirrel.exe",
      "app-0.1.0\\v8_context_snapshot.bin",
    ])).toEqual({
      accepted: [
        ".dead",
        "Update.exe",
        "app-0.1.0/",
        "app-0.1.0/squirrel.exe",
        "app-0.1.0/v8_context_snapshot.bin",
      ],
      unexpected: [],
    });
  });

  it.each([
    "IntentArc.exe",
    "IntentArc Bridge.exe",
    "packages/",
    "packages/RELEASES",
    "app-0.1.0/IntentArc.exe",
    "app-0.1.0/resources/bridge/IntentArc Bridge.exe",
    "app-current/squirrel.exe",
    "app-0.1/squirrel.exe",
    "app-0.1.0/extra.bin",
    "other/app-0.1.0/squirrel.exe",
    "../Update.exe",
    "C:/Users/Ada/Update.exe",
  ])("rejects unexpected uninstall residue %s", (path) => {
    expect(classifySquirrelUninstallResidue([path])).toEqual({
      accepted: [],
      unexpected: [path.replaceAll("\\", "/")],
    });
  });

  it("allows the real installer journey only behind a clean explicit preflight", () => {
    expect(assertInstallerAcceptancePreflight({
      platform: "win32",
      optIn: "1",
      setupExists: true,
      installRootExists: false,
      uninstallRegistered: false,
      existingShortcuts: [],
    })).toBeUndefined();
  });

  it.each([
    {
      label: "non-Windows host",
      input: { platform: "linux", optIn: "1", setupExists: true },
    },
    {
      label: "missing explicit opt-in",
      input: { platform: "win32", optIn: undefined, setupExists: true },
    },
    {
      label: "missing setup artifact",
      input: { platform: "win32", optIn: "1", setupExists: false },
    },
    {
      label: "existing install root",
      input: {
        platform: "win32",
        optIn: "1",
        setupExists: true,
        installRootExists: true,
      },
    },
    {
      label: "existing uninstall registration",
      input: {
        platform: "win32",
        optIn: "1",
        setupExists: true,
        uninstallRegistered: true,
      },
    },
    {
      label: "existing shortcut",
      input: {
        platform: "win32",
        optIn: "1",
        setupExists: true,
        existingShortcuts: ["C:\\Users\\Ada\\Desktop\\IntentArc.lnk"],
      },
    },
  ])("refuses an unsafe installer preflight: $label", ({ input }) => {
    expect(() => assertInstallerAcceptancePreflight({
      installRootExists: false,
      uninstallRegistered: false,
      existingShortcuts: [],
      ...input,
    })).toThrow(/acceptance|installer|install|shortcut|Windows|opt-in/i);
  });

  it("parses only the exact registered quiet uninstall command", () => {
    const installRoot = "C:\\Users\\Ada Lovelace\\AppData\\Local\\IntentArc";
    const updater = `${installRoot}\\Update.exe`;

    expect(parseQuietUninstallCommand(
      `\"${updater}\" --uninstall -s`,
      installRoot,
    )).toEqual({
      executablePath: updater,
      arguments: ["--uninstall", "-s"],
    });
    expect(parseQuietUninstallCommand(
      `${updater} --uninstall -s`,
      installRoot,
    )).toEqual({
      executablePath: updater,
      arguments: ["--uninstall", "-s"],
    });
  });

  it.each([
    "C:\\attacker\\Update.exe --uninstall -s",
    "\"C:\\Users\\Ada Lovelace\\AppData\\Local\\IntentArc\\Update.exe\" --uninstall",
    "\"C:\\Users\\Ada Lovelace\\AppData\\Local\\IntentArc\\Update.exe\" -s --uninstall",
    "\"C:\\Users\\Ada Lovelace\\AppData\\Local\\IntentArc\\Update.exe\" --uninstall -s & calc.exe",
  ])("rejects an unsafe quiet uninstall registration: %s", (command) => {
    expect(() => parseQuietUninstallCommand(
      command,
      "C:\\Users\\Ada Lovelace\\AppData\\Local\\IntentArc",
    )).toThrow(/quiet uninstall|registration/i);
  });

  it("creates a stable, content-addressed manifest without following links", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentarc-user-data-manifest-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "backups"));
    await writeFile(join(root, "intentarc.sqlite"), "archive");
    await writeFile(join(root, "backups", "bundle.json"), "bundle");
    let linkCreated = false;
    try {
      await symlink(
        join(root, "intentarc.sqlite"),
        join(root, "archive-link"),
        "file",
      );
      linkCreated = true;
    } catch {
      // Windows developer-mode policy can forbid unprivileged symbolic links.
    }

    const first = await createReadOnlyTreeManifest(root);
    const second = await createReadOnlyTreeManifest(root);

    expect(second).toEqual(first);
    expect(first.map((entry) => entry.path)).toEqual([
      ...(linkCreated ? ["archive-link"] : []),
      "backups/bundle.json",
      "intentarc.sqlite",
    ]);
    expect(first.find((entry) => entry.path === "intentarc.sqlite")).toMatchObject({
      kind: "file",
      size: 7,
    });
    if (linkCreated) {
      expect(first.find((entry) => entry.path === "archive-link")).toMatchObject({
        kind: "symbolic-link",
      });
    }
  });
});
