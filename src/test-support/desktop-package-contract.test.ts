import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop package contract", () => {
  it("pins Electron and exposes Windows x64 package commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.main).toBe("dist/desktop/entry.js");
    expect(pkg.devDependencies.electron).toBe("43.2.0");
    expect(pkg.dependencies["electron-squirrel-startup"]).toBeUndefined();
    expect(pkg.scripts["desktop:make"]).toBe(
      "pnpm build && pnpm bridge:build && pnpm desktop:resources && node scripts/prepare-squirrel-vendor.mjs && electron-forge make --platform win32 --arch x64",
    );
    expect(pkg.scripts["desktop:release"]).toBe(
      "node scripts/desktop-release.mjs",
    );
    expect(pkg.scripts["desktop:release:preflight"]).toBe(
      "node scripts/desktop-release-preflight.mjs",
    );
  });
});
