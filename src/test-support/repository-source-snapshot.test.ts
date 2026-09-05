import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryFixture } from "./repository-fixture.js";
import {
  assertRepositorySourceUnchanged,
  captureRepositorySource,
  withReadOnlyRepositorySource,
  withReadOnlyRepositorySourceAsync,
} from "./repository-source-snapshot.js";

describe("repository source snapshots", () => {
  it("detects content changes to a nonignored untracked file", () => {
    const fixture = createRepositoryFixture({ "README.md": "# Stable\n" });
    try {
      fixture.write("notes/untracked-evidence.md", "before\n");
      const before = captureRepositorySource(fixture.root);

      fixture.write("notes/untracked-evidence.md", "after\n");

      expect(() => assertRepositorySourceUnchanged(fixture.root, before))
        .toThrow("Repository or Git state changed during a read-only operation");
    } finally {
      fixture.cleanup();
    }
  });

  it("checks the source in finally when a synchronous product call rejects", () => {
    const fixture = createRepositoryFixture({ "README.md": "# Stable\n" });
    try {
      const before = captureRepositorySource(fixture.root);
      expect(() => withReadOnlyRepositorySource(fixture.root, before, () => {
        rmSync(resolve(fixture.root, "README.md"));
        throw new Error("product rejected");
      })).toThrow("Repository or Git state changed during a read-only operation");
    } finally {
      fixture.cleanup();
    }
  });

  it("checks the source in finally when an asynchronous product call rejects", async () => {
    const fixture = createRepositoryFixture({ "README.md": "# Stable\n" });
    try {
      const before = captureRepositorySource(fixture.root);
      await expect(withReadOnlyRepositorySourceAsync(fixture.root, before, async () => {
        fixture.write("README.md", "# Mutated\n");
        throw new Error("product rejected");
      })).rejects.toThrow("Repository or Git state changed during a read-only operation");
    } finally {
      fixture.cleanup();
    }
  });
});
