import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { assertWebBundleBudget } from "../../../scripts/web-bundle-budget.mjs";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

type BudgetCommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const makeOutputDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "intentarc-web-bundle-budget-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runBudgetCommand = async (workspace: string): Promise<BudgetCommandResult> => {
  const scriptsDirectory = join(workspace, "scripts");
  await mkdir(scriptsDirectory, { recursive: true });
  await copyFile(
    resolve("scripts", "web-bundle-budget.mjs"),
    join(scriptsDirectory, "web-bundle-budget.mjs"),
  );

  return execFileAsync(
    process.execPath,
    [join(scriptsDirectory, "web-bundle-budget.mjs")],
    { cwd: workspace },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => {
      const failure = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      return {
        code: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    },
  );
};

const stdoutLines = (stdout: string): string[] => stdout.trim().split(/\r?\n/);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("web bundle budget", () => {
  test("rejects a JavaScript chunk one byte over the 500 KiB boundary", async () => {
    const outputDirectory = await makeOutputDirectory();
    await writeFile(join(outputDirectory, "over-budget.js"), Buffer.alloc(512_001));

    await expect(assertWebBundleBudget({ outputDirectory })).rejects.toThrow(
      "IntentArc web chunk budget exceeded.",
    );
  });

  test("prints metrics before the command fails an over-budget build", async () => {
    const workspace = await makeOutputDirectory();
    const outputDirectory = join(workspace, "dist", "web-client");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "over-budget.js"), Buffer.alloc(512_001));

    const failure = await runBudgetCommand(workspace);

    expect(failure.code).toBe(1);
    expect(stdoutLines(failure.stdout)).toEqual([
      JSON.stringify({
        status: "fail",
        category: "budget-exceeded",
        largestChunk: "over-budget.js",
        largestChunkBytes: 512_001,
        chunks: [{ file: "over-budget.js", bytes: 512_001 }],
      }),
    ]);
    expect(failure.stderr).toBe("IntentArc web chunk budget exceeded.\n");
  });

  test("prints one closed metrics line when the command passes", async () => {
    const workspace = await makeOutputDirectory();
    const outputDirectory = join(workspace, "dist", "web-client");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "at-budget.js"), Buffer.alloc(512_000));

    const result = await runBudgetCommand(workspace);

    expect(result.code).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual([
      JSON.stringify({
        status: "pass",
        category: null,
        largestChunk: "at-budget.js",
        largestChunkBytes: 512_000,
        chunks: [{ file: "at-budget.js", bytes: 512_000 }],
      }),
    ]);
    expect(result.stderr).toBe("");
  });

  test.each([
    {
      label: "missing root",
      category: "output-unavailable",
      diagnostic: "IntentArc web bundle output is unavailable.\n",
      arrange: async (_workspace: string, _outputDirectory: string) => {},
    },
    {
      label: "root read failure",
      category: "output-unavailable",
      diagnostic: "IntentArc web bundle output is unavailable.\n",
      arrange: async (_workspace: string, outputDirectory: string) => {
        await mkdir(join(outputDirectory, ".."), { recursive: true });
        await writeFile(outputDirectory, "not a directory");
      },
    },
    {
      label: "no JavaScript chunks",
      category: "no-javascript-chunks",
      diagnostic: "IntentArc web bundle output contains no JavaScript chunks.\n",
      arrange: async (_workspace: string, outputDirectory: string) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "styles.css"), "body {}");
      },
    },
    {
      label: "root linked outside",
      category: "unsupported-entry",
      diagnostic: "IntentArc web bundle output contains an unsupported entry.\n",
      arrange: async (workspace: string, outputDirectory: string) => {
        const externalDirectory = join(workspace, "external-output");
        await mkdir(join(outputDirectory, ".."), { recursive: true });
        await mkdir(externalDirectory);
        await writeFile(join(externalDirectory, "outside.js"), Buffer.alloc(10));
        await symlink(
          externalDirectory,
          outputDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    },
    {
      label: "ancestor linked outside",
      category: "unsupported-entry",
      diagnostic: "IntentArc web bundle output contains an unsupported entry.\n",
      arrange: async (workspace: string, _outputDirectory: string) => {
        const externalDirectory = join(workspace, "external-dist");
        await mkdir(join(externalDirectory, "web-client"), { recursive: true });
        await writeFile(
          join(externalDirectory, "web-client", "outside.js"),
          Buffer.alloc(10),
        );
        await symlink(
          externalDirectory,
          join(workspace, "dist"),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    },
  ])("prints one closed failure line for $label", async ({
    arrange,
    category,
    diagnostic,
  }) => {
    const workspace = await makeOutputDirectory();
    const outputDirectory = join(workspace, "dist", "web-client");
    await arrange(workspace, outputDirectory);

    const result = await runBudgetCommand(workspace);

    expect(result.code).toBe(1);
    expect(stdoutLines(result.stdout)).toEqual([
      JSON.stringify({
        status: "fail",
        category,
        largestChunk: null,
        largestChunkBytes: null,
        chunks: [],
      }),
    ]);
    expect(result.stdout).not.toContain(workspace);
    expect(result.stderr).toBe(diagnostic);
    expect(result.stderr).not.toContain(workspace);
  });

  test("accepts a JavaScript chunk at the 500 KiB boundary", async () => {
    const outputDirectory = await makeOutputDirectory();
    await writeFile(join(outputDirectory, "at-budget.js"), Buffer.alloc(512_000));

    await expect(assertWebBundleBudget({ outputDirectory })).resolves.toEqual({
      largestChunk: "at-budget.js",
      largestChunkBytes: 512_000,
      chunks: [{ file: "at-budget.js", bytes: 512_000 }],
    });
  });

  test("measures only emitted JavaScript chunks", async () => {
    const outputDirectory = await makeOutputDirectory();
    await mkdir(join(outputDirectory, "assets"));
    await writeFile(join(outputDirectory, "assets", "application.js"), Buffer.alloc(100));
    await writeFile(join(outputDirectory, "assets", "application.js.map"), Buffer.alloc(600_000));
    await writeFile(join(outputDirectory, "assets", "application.css"), Buffer.alloc(600_000));
    await writeFile(join(outputDirectory, "assets", "logo.svg"), Buffer.alloc(600_000));

    await expect(assertWebBundleBudget({ outputDirectory })).resolves.toEqual({
      largestChunk: "application.js",
      largestChunkBytes: 100,
      chunks: [{ file: "application.js", bytes: 100 }],
    });
  });

  test.each([
    ["missing", async () => join(await makeOutputDirectory(), "missing")],
    ["not a directory", async () => {
      const outputDirectory = await makeOutputDirectory();
      const file = join(outputDirectory, "output-file");
      await writeFile(file, "not a directory");
      return file;
    }],
  ])("fails closed when the output is %s", async (_label, arrangeOutput) => {
    const outputDirectory = await arrangeOutput();

    await expect(assertWebBundleBudget({ outputDirectory })).rejects.toThrow(
      "IntentArc web bundle output is unavailable.",
    );
  });

  test("returns deterministic basename-only chunk metrics", async () => {
    const outputDirectory = await makeOutputDirectory();
    await mkdir(join(outputDirectory, "assets"));
    await writeFile(join(outputDirectory, "assets", "z-runtime.js"), Buffer.alloc(20));
    await writeFile(join(outputDirectory, "assets", "a-client.js"), Buffer.alloc(30));

    const result = await assertWebBundleBudget({ outputDirectory });

    expect(result).toEqual({
      largestChunk: "a-client.js",
      largestChunkBytes: 30,
      chunks: [
        { file: "a-client.js", bytes: 30 },
        { file: "z-runtime.js", bytes: 20 },
      ],
    });
    expect(result.chunks.every(({ file }) => file === basename(file))).toBe(true);
  });

  test("orders duplicate basenames deterministically by size", async () => {
    const outputDirectory = await makeOutputDirectory();
    await mkdir(join(outputDirectory, "z-chunks"));
    await mkdir(join(outputDirectory, "a-chunks"));
    await writeFile(join(outputDirectory, "z-chunks", "shared.js"), Buffer.alloc(10));
    await writeFile(join(outputDirectory, "a-chunks", "shared.js"), Buffer.alloc(20));

    const result = await assertWebBundleBudget({ outputDirectory });

    expect(result.chunks).toEqual([
      { file: "shared.js", bytes: 10 },
      { file: "shared.js", bytes: 20 },
    ]);
  });

  test("fails closed instead of skipping a linked output directory", async () => {
    const fixtureRoot = await makeOutputDirectory();
    const outputDirectory = join(fixtureRoot, "output");
    const linkedDirectory = join(fixtureRoot, "linked-chunks");
    await mkdir(outputDirectory);
    await mkdir(linkedDirectory);
    await writeFile(join(outputDirectory, "small.js"), Buffer.alloc(10));
    await writeFile(join(linkedDirectory, "over-budget.js"), Buffer.alloc(512_001));
    await symlink(
      linkedDirectory,
      join(outputDirectory, "linked-output"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(assertWebBundleBudget({ outputDirectory })).rejects.toThrow(
      "IntentArc web bundle output contains an unsupported entry.",
    );
  });

  test("rejects an output root that is itself linked outside", async () => {
    const fixtureRoot = await makeOutputDirectory();
    const externalDirectory = join(fixtureRoot, "external-output");
    const outputDirectory = join(fixtureRoot, "linked-root");
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, "outside.js"), Buffer.alloc(10));
    await symlink(
      externalDirectory,
      outputDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(assertWebBundleBudget({ outputDirectory })).rejects.toThrow(
      "IntentArc web bundle output contains an unsupported entry.",
    );
  });

  test("rejects an output root beneath a linked ancestor", async () => {
    const fixtureRoot = await makeOutputDirectory();
    const externalDirectory = join(fixtureRoot, "external-dist");
    const outputDirectory = join(fixtureRoot, "dist", "web-client");
    await mkdir(join(externalDirectory, "web-client"), { recursive: true });
    await writeFile(
      join(externalDirectory, "web-client", "outside.js"),
      Buffer.alloc(10),
    );
    await symlink(
      externalDirectory,
      join(fixtureRoot, "dist"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(assertWebBundleBudget({
      outputDirectory,
      trustedRoot: fixtureRoot,
    })).rejects.toThrow(
      "IntentArc web bundle output contains an unsupported entry.",
    );
  });

  test("allows a trusted root reached through a platform-owned link", async () => {
    const fixtureRoot = await makeOutputDirectory();
    const physicalPrefix = join(fixtureRoot, "physical-prefix");
    const linkedPrefix = join(fixtureRoot, "platform-prefix");
    const trustedRoot = join(linkedPrefix, "workspace");
    const outputDirectory = join(trustedRoot, "dist", "web-client");
    await mkdir(
      join(physicalPrefix, "workspace", "dist", "web-client"),
      { recursive: true },
    );
    await writeFile(
      join(physicalPrefix, "workspace", "dist", "web-client", "client.js"),
      Buffer.alloc(10),
    );
    await symlink(
      physicalPrefix,
      linkedPrefix,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(assertWebBundleBudget({
      outputDirectory,
      trustedRoot,
    })).resolves.toEqual({
      largestChunk: "client.js",
      largestChunkBytes: 10,
      chunks: [{ file: "client.js", bytes: 10 }],
    });
  });

  test("rejects an output path outside its trusted root", async () => {
    const fixtureRoot = await makeOutputDirectory();
    const trustedRoot = join(fixtureRoot, "workspace");
    const outputDirectory = join(fixtureRoot, "outside-output");
    await mkdir(trustedRoot);
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "outside.js"), Buffer.alloc(10));

    await expect(assertWebBundleBudget({
      outputDirectory,
      trustedRoot,
    })).rejects.toThrow(
      "IntentArc web bundle output contains an unsupported entry.",
    );
  });
});
