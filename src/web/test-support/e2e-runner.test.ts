import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runOwnedE2eProcess } from "./e2e-runner.js";

const ownedDirectories = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => /^intentarc-e2e-[A-Za-z0-9]{6}$/.test(name))
    .sort();

describe("owned end-to-end process", () => {
  test("removes its exact database directory when the child fails", async () => {
    const before = ownedDirectories();
    const childScript = [
      'const { writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const directory = process.env.INTENTARC_E2E_DATABASE_DIRECTORY;",
      "if (!directory) throw new Error('missing owned directory');",
      "for (const name of ['intentarc.sqlite', 'intentarc.sqlite-shm', 'intentarc.sqlite-wal']) {",
      "  writeFileSync(join(directory, name), name);",
      "}",
      "process.exitCode = 7;",
    ].join("\n");

    const result = await runOwnedE2eProcess({
      command: process.execPath,
      args: ["-e", childScript],
      port: null,
    });

    expect(result.exitCode).toBe(7);
    expect(existsSync(result.databaseDirectory)).toBe(false);
    expect(ownedDirectories()).toEqual(before);
  });

  test.skipIf(process.platform !== "win32")(
    "owns and removes the structured repository after repeated Windows journeys",
    async () => {
      const cacheRoot = path.resolve(
        "node_modules",
        ".cache",
        "intentarc-structured-e2e",
      );
      const before = existsSync(cacheRoot) ? readdirSync(cacheRoot).sort() : [];

      for (let run = 0; run < 2; run += 1) {
        const result = await runOwnedE2eProcess({
          command: process.execPath,
          args: ["-e", "process.exitCode = 0"],
          port: null,
          structuredKnowledgeFixture: true,
        });
        expect(result.exitCode).toBe(0);
        expect(result.structuredRepositoryPath).toBeDefined();
        expect(existsSync(result.structuredRepositoryPath!)).toBe(false);
        expect(existsSync(result.databaseDirectory)).toBe(false);
      }

      expect(existsSync(cacheRoot) ? readdirSync(cacheRoot).sort() : [])
        .toEqual(before);
    },
    30_000,
  );

  test("fails and still cleans up when a structured journey mutates its source", async () => {
    let repositoryPath = "";
    await expect(runOwnedE2eProcess({
      command: process.execPath,
      args: ["-e", [
        'const { writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        "const root = process.env.INTENTARC_E2E_STRUCTURED_REPOSITORY;",
        "if (!root) throw new Error('missing structured repository');",
        "writeFileSync(join(root, 'README.md'), '# Mutated by child\\n');",
      ].join("\n")],
      port: null,
      structuredKnowledgeFixture: true,
      onStructuredRepositoryCreated(root) {
        repositoryPath = root;
      },
    })).rejects.toThrow("changed repository or Git state");
    expect(repositoryPath).not.toBe("");
    expect(existsSync(repositoryPath)).toBe(false);
  }, 30_000);
});
