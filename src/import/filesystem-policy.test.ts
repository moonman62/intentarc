import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyFilesystemPath,
  inspectFileContent,
  isEligibleUntrackedText,
  isHardExcludedPath,
  isKnownSecretPath,
  resolveCanonicalSubpath,
  resolveContainedPath,
} from "./filesystem-policy.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `intentarc ${label} `));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const thrownBy = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
};

describe("repository filesystem containment", () => {
  it("accepts normalized children and rejects parent, absolute, drive-change, and prefix-confusion paths", () => {
    const root = temporaryDirectory("containment");
    mkdirSync(join(root, "godot"), { recursive: true });

    expect(resolveCanonicalSubpath(root, "godot")).toEqual({
      path: join(root, "godot"),
      subpath: "godot",
    });
    expect(thrownBy(() => resolveCanonicalSubpath(root, "../outside"))).toMatchObject({
      code: "canonical_path_invalid",
    });
    expect(thrownBy(() => resolveCanonicalSubpath(root, resolve(root, "godot")))).toMatchObject({
      code: "canonical_path_invalid",
    });
    expect(thrownBy(() => resolveCanonicalSubpath(root, "Z:\\other-drive"))).toMatchObject({
      code: "canonical_path_invalid",
    });
    expect(thrownBy(() => resolveContainedPath(root, `${root}-confused\\file.txt`))).toMatchObject({
      code: "path_escape",
    });
  });

  it("classifies an escaping junction without traversing its target", () => {
    const root = temporaryDirectory("links");
    const outside = temporaryDirectory("outside");
    writeFileSync(join(outside, "secret.txt"), "must not be read");
    symlinkSync(outside, join(root, "escaping-junction"), "junction");

    expect(classifyFilesystemPath(root, "escaping-junction")).toEqual({
      path: "escaping-junction",
      kind: "link",
    });
    expect(classifyFilesystemPath(root, "escaping-junction/secret.txt")).toEqual({
      path: "escaping-junction",
      kind: "link",
    });
  });

  it("classifies an escaping file symlink without traversing its target", (context) => {
    const root = temporaryDirectory("symlink");
    const outside = temporaryDirectory("outside-file");
    writeFileSync(join(outside, "secret.txt"), "must not be read");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "escaping-file"), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip("Windows file-symlink creation requires an unavailable privilege");
        return;
      }
      throw error;
    }

    expect(classifyFilesystemPath(root, "escaping-file")).toEqual({
      path: "escaping-file",
      kind: "link",
    });
  });
});

describe("repository file policy", () => {
  it("applies case-insensitive exact-segment exclusions and hides known secret basenames", () => {
    expect(isHardExcludedPath("src/node_modules/pkg/index.js")).toBe(true);
    expect(isHardExcludedPath("SRC/.GODOT/cache.bin")).toBe(true);
    expect(isHardExcludedPath("src/node_modules-old/index.js")).toBe(false);

    expect(isKnownSecretPath("config/.env.local")).toBe(true);
    expect(isKnownSecretPath("private/SERVICE-ACCOUNT.JSON")).toBe(true);
    expect(isKnownSecretPath("docs/credentials.json.example")).toBe(false);
  });

  it("limits eligible untracked text to recognized documentation and project files", () => {
    expect(isEligibleUntrackedText("README.local")).toBe(true);
    expect(isEligibleUntrackedText("docs/handoff/current.md")).toBe(true);
    expect(isEligibleUntrackedText("docs/notes.txt")).toBe(true);
    expect(isEligibleUntrackedText("godot/project.godot")).toBe(true);
    expect(isEligibleUntrackedText("godot/export_presets.cfg")).toBe(true);
    expect(isEligibleUntrackedText("archive/docs/notes.md")).toBe(false);
    expect(isEligibleUntrackedText("scripts/local.ps1")).toBe(false);
  });

  it("accepts bounded UTF-8 text and rejects oversized, NUL-containing, invalid UTF-8, and binary-extension data", () => {
    expect(inspectFileContent("README.md", Buffer.from("# Hello\n"))).toEqual({
      kind: "text",
      text: "# Hello\n",
    });
    expect(inspectFileContent("large.md", Buffer.alloc(1024 * 1024 + 1, 0x61))).toEqual({
      kind: "oversized",
    });
    expect(inspectFileContent("nul.txt", Buffer.from([0x61, 0x00, 0x62]))).toEqual({
      kind: "binary",
    });
    expect(inspectFileContent("invalid.txt", Buffer.from([0xc3, 0x28]))).toEqual({
      kind: "binary",
    });
    expect(inspectFileContent("assets/icon.png", Buffer.from("text-shaped bytes"))).toEqual({
      kind: "binary",
    });
  });
});
