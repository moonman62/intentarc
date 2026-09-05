import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRepositoryFixture } from "./repository-fixture.js";

describe("repository fixture cleanup", () => {
  it.runIf(process.platform === "win32")(
    "retries while a child releases its working-directory handle",
    async () => {
      const fixture = createRepositoryFixture({
        "README.md": "# cleanup retry\n",
      });
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write('ready'); setTimeout(() => {}, 250);",
        ],
        {
          cwd: fixture.root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const exitPromise = once(child, "exit");
      await once(child.stdout!, "data");

      try {
        expect(() => fixture.cleanup()).not.toThrow();
      } finally {
        if (child.exitCode === null) child.kill();
        await exitPromise;
        rmSync(fixture.root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
      }
    },
  );
});
