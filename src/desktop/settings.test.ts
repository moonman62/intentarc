import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopSettingsStore,
  type DesktopConnection,
} from "./settings.js";

const settingsReadRace = vi.hoisted(() => ({
  enabled: false,
  replaced: false,
  settingsPath: "",
  replacementPath: "",
  simulatePostOpenSymlink: false,
  lstatCalls: 0,
  growAfterFstat: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...arguments_: Parameters<typeof actual.lstatSync>) => {
      const metadata = actual.lstatSync(...arguments_);
      if (
        settingsReadRace.simulatePostOpenSymlink &&
        arguments_[0] === settingsReadRace.settingsPath
      ) {
        settingsReadRace.lstatCalls += 1;
        if (settingsReadRace.lstatCalls === 2) {
          return Object.assign(Object.create(metadata), {
            isSymbolicLink: () => true,
          }) as typeof metadata;
        }
      }
      if (
        settingsReadRace.enabled &&
        !settingsReadRace.replaced &&
        arguments_[0] === settingsReadRace.settingsPath
      ) {
        settingsReadRace.replaced = true;
        actual.renameSync(settingsReadRace.replacementPath, settingsReadRace.settingsPath);
      }
      return metadata;
    },
    fstatSync: (...arguments_: Parameters<typeof actual.fstatSync>) => {
      const metadata = actual.fstatSync(...arguments_);
      if (settingsReadRace.growAfterFstat) {
        actual.appendFileSync(
          settingsReadRace.settingsPath,
          " ".repeat(1024 * 1024),
        );
      }
      return metadata;
    },
  };
});

const temporaryRoots: string[] = [];

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "intentarc-desktop-settings-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

const connection: DesktopConnection = {
  id: "connection-1",
  kind: "managed",
  adapterId: "codex",
  profileId: "profile-1",
  profileToken: "secret",
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
};

describe("createDesktopSettingsStore", () => {
  it("returns defaults then privately persists a complete settings document", () => {
    const root = createRoot();
    const store = createDesktopSettingsStore(root);

    expect(store.read()).toEqual({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [],
    });

    store.write({
      schemaVersion: 2,
      archivePath: join(root, "arc.sqlite"),
      onboardingCompleted: true,
      connections: [connection],
    });

    expect(store.read().connections[0]?.profileToken).toBe("secret");
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")))
      .toMatchObject({ schemaVersion: 2 });
    if (process.platform !== "win32") {
      expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates an exact schema-v1 managed connection to schema v2 in memory", () => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      archivePath: null,
      onboardingCompleted: true,
      connections: [{
        id: "legacy-connection",
        adapterId: "claude-code",
        profileId: "legacy-profile",
        profileToken: "legacy-token",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    }));

    expect(createDesktopSettingsStore(root).read()).toEqual({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: true,
      connections: [{
        id: "legacy-connection",
        kind: "managed",
        adapterId: "claude-code",
        profileId: "legacy-profile",
        profileToken: "legacy-token",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });
  });

  it("rejects unknown document keys before exposing persisted settings", () => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [],
      unexpected: true,
    }));

    expect(() => createDesktopSettingsStore(root).read()).toThrow(/settings/i);
  });

  it("rejects a settings file replaced after its safety check", () => {
    const root = createRoot();
    const settingsPath = join(root, "settings.json");
    const replacementPath = join(root, "replacement.json");
    const original = {
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [connection],
    };
    const replacement = {
      ...original,
      connections: [{ ...connection, profileToken: "attacker-controlled" }],
    };
    writeFileSync(settingsPath, JSON.stringify(original));
    writeFileSync(replacementPath, JSON.stringify(replacement));

    settingsReadRace.settingsPath = settingsPath;
    settingsReadRace.replacementPath = replacementPath;
    settingsReadRace.enabled = true;
    try {
      expect(() => createDesktopSettingsStore(root).read()).toThrow(/changed|settings/i);
    } finally {
      settingsReadRace.enabled = false;
      settingsReadRace.replaced = false;
    }
  });

  it("rejects settings data that grows beyond one MiB after its descriptor is checked", () => {
    const root = createRoot();
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [connection],
    }));

    settingsReadRace.settingsPath = settingsPath;
    settingsReadRace.growAfterFstat = true;
    try {
      expect(() => createDesktopSettingsStore(root).read()).toThrow(/large|size/i);
    } finally {
      settingsReadRace.growAfterFstat = false;
    }
  });

  it("rejects a symlink observed after opening the settings descriptor", () => {
    const root = createRoot();
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [connection],
    }));

    settingsReadRace.settingsPath = settingsPath;
    settingsReadRace.lstatCalls = 0;
    settingsReadRace.simulatePostOpenSymlink = true;
    try {
      expect(() => createDesktopSettingsStore(root).read()).toThrow(/symbolic|symlink/i);
    } finally {
      settingsReadRace.simulatePostOpenSymlink = false;
      settingsReadRace.lstatCalls = 0;
    }
  });

  it("rejects a write with duplicate connection ids", () => {
    const store = createDesktopSettingsStore(createRoot());

    expect(() => store.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [connection, { ...connection, profileId: "profile-2" }],
    })).toThrow(/duplicate/i);
  });

  it("rejects settings files larger than one MiB", () => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), "x".repeat(1024 * 1024 + 1));

    expect(() => createDesktopSettingsStore(root).read()).toThrow(/large|size/i);
  });

  it("does not persist a settings document larger than one MiB", () => {
    const root = createRoot();
    const store = createDesktopSettingsStore(root);

    expect(() => store.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{ ...connection, profileToken: "x".repeat(1024 * 1024) }],
    })).toThrow(/large|size/i);
    expect(() => lstatSync(join(root, "settings.json"))).toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a Windows-style relative archive path", () => {
    const store = createDesktopSettingsStore(createRoot());

    expect(() => store.write({
      schemaVersion: 2,
      archivePath: "C:\\data\\arc.sqlite",
      onboardingCompleted: false,
      connections: [],
    })).toThrow(/archive path/i);
  });

  it.each([
    {
      label: "unknown connection kind",
      connection: { ...connection, kind: "unknown" },
    },
    {
      label: "adapter on a manual connection",
      connection: {
        ...connection,
        kind: "manual-mcp",
        label: "Local MCP",
      },
    },
    {
      label: "label on a managed connection",
      connection: { ...connection, label: "Codex" },
    },
    {
      label: "unknown connection field",
      connection: { ...connection, unexpected: true },
    },
  ])("rejects $label", ({ connection: invalidConnection }) => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [invalidConnection],
    }));

    expect(() => createDesktopSettingsStore(root).read()).toThrow(/connection|settings/i);
  });

  it.each([
    "",
    "   ",
    "line\rbreak",
    "line\nbreak",
    "column\tbreak",
    "null\u0000byte",
    "next\u0085line",
    "line\u2028separator",
    "paragraph\u2029separator",
    "right-to-left\u202eoverride",
    "\u200b",
    "\u200d",
    "Editor \u200d",
    "Editor \u{1f469}\u200d",
    "A\u200dB",
    "\ufe0f",
    "x".repeat(81),
  ])("rejects the invalid manual label %j", (label) => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-connection",
        kind: "manual-mcp",
        label,
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    }));

    expect(() => createDesktopSettingsStore(root).read()).toThrow(/label|connection|settings/i);
  });

  it.each([
    { name: "Hangul choseong filler", label: "\u115f" },
    { name: "Hangul jungseong filler", label: "\u1160" },
    { name: "Braille pattern blank", label: "\u2800" },
    { name: "Hangul filler", label: "\u3164" },
    { name: "halfwidth Hangul filler", label: "\uffa0" },
  ])("rejects the standardized blank glyph $name", ({ label }) => {
    const root = createRoot();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-blank-glyph",
        kind: "manual-mcp",
        label,
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    }));

    expect(() => createDesktopSettingsStore(root).read()).toThrow(/label|connection|settings/i);
  });

  it("persists a visible emoji ZWJ grapheme in a manual label", () => {
    const store = createDesktopSettingsStore(createRoot());
    const label = "Editor \u{1f469}\u200d\u{1f4bb}";

    store.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-emoji-zwj",
        kind: "manual-mcp",
        label,
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });

    expect(store.read().connections[0]).toMatchObject({ label });
  });

  it.each([
    {
      sequence: "combining sequence",
      grapheme: "e\u0301",
    },
    {
      sequence: "emoji modifier sequence",
      grapheme: "👍🏽",
    },
    {
      sequence: "emoji ZWJ sequence",
      grapheme: "\u{1f469}\u200d\u{1f4bb}",
    },
  ])("counts each $sequence as one visible character", ({ grapheme }) => {
    const atLimit = createDesktopSettingsStore(createRoot());
    const labelAtLimit = grapheme.repeat(80);

    atLimit.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-at-limit",
        kind: "manual-mcp",
        label: labelAtLimit,
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });

    expect(atLimit.read().connections[0]).toMatchObject({ label: labelAtLimit });

    const overLimit = createDesktopSettingsStore(createRoot());
    expect(() => overLimit.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-over-limit",
        kind: "manual-mcp",
        label: grapheme.repeat(81),
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    })).toThrow(/label|connection|settings/i);
  });

  it("trims a valid manual label before exposing or persisting it", () => {
    const root = createRoot();
    const store = createDesktopSettingsStore(root);

    store.write({
      schemaVersion: 2,
      archivePath: null,
      onboardingCompleted: false,
      connections: [{
        id: "manual-connection",
        kind: "manual-mcp",
        label: "  Local MCP  ",
        profileId: "profile-1",
        profileToken: "secret",
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
    });

    expect(store.read().connections[0]).toMatchObject({
      kind: "manual-mcp",
      label: "Local MCP",
    });
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")))
      .toMatchObject({
        schemaVersion: 2,
        connections: [{ kind: "manual-mcp", label: "Local MCP" }],
      });
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic link at the settings path", () => {
    const root = createRoot();
    const target = join(root, "target.json");
    const settingsPath = join(root, "settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, settingsPath, "file");

    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(() => createDesktopSettingsStore(root).read()).toThrow(/symbolic|symlink/i);
  });
});
