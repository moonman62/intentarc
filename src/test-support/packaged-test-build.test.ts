import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { transform } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePackagedGenerationPromotionPathIdentity,
  computePackagedTestBuildFingerprint,
  ensurePackagedTestBuild,
  ensurePackagedTestBuildWithDependenciesForTest,
  promotePackagedGeneration,
  type PackagedGenerationPromotionInput,
  type PackagedTestBuildOptions,
  type PackagedTestBuildResult,
} from "./packaged-test-build.js";

const packagedTestStateDirectoryEnv =
  "INTENTARC_PACKAGED_TEST_STATE_DIRECTORY";

type Fixture = {
  readonly root: string;
  readonly sourcePath: string;
  readonly stateDirectory: string;
  readonly counterPath: string;
  readonly outputPath: string;
  readonly failureFlagPath: string;
  readonly buildScriptPath: string;
};

type ChildResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type GenerationReader = {
  readonly ready: Promise<number>;
  readonly finish: () => Promise<ChildResult>;
};

const temporaryDirectories: string[] = [];

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-packaged-build-test-"));
  temporaryDirectories.push(root);

  const sourceDirectory = join(root, "src");
  const sourcePath = join(sourceDirectory, "input.ts");
  const stateDirectory = join(root, "build-state");
  const counterPath = join(root, "build-attempts.txt");
  const outputPath = join(root, "dist", "output.js");
  const failureFlagPath = join(root, "fail-build");
  const buildScriptPath = join(root, "fixture-build.mjs");

  await mkdir(sourceDirectory, { recursive: true });
  const dependencyDirectory = join(
    root,
    "node_modules",
    "fixture-dependency",
  );
  const compilerDirectory = join(root, "node_modules", "typescript", "bin");
  await mkdir(dependencyDirectory, { recursive: true });
  await mkdir(compilerDirectory, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "packaged-build-fixture",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts"] }),
  );
  await writeFile(sourcePath, "export const value = 1;\n");
  await writeFile(
    join(dependencyDirectory, "package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      type: "module",
      exports: "./index.js",
    }),
  );
  await writeFile(
    join(dependencyDirectory, "index.js"),
    'export const dependencyValue = "resolved-from-fixture-dependency";\n',
  );
  await writeFile(
    join(compilerDirectory, "tsc"),
    `
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = process.env.INTENTARC_PACKAGED_TEST_OUTPUT_DIRECTORY;
if (outputDirectory === undefined) throw new Error("missing output directory");
await appendFile(join(process.cwd(), "build-attempts.txt"), \`\${process.pid}\\n\`);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  join(outputDirectory, "output.js"),
  await readFile(join(process.cwd(), "src", "input.ts"), "utf8"),
);
`.trimStart(),
  );
  await writeFile(
    buildScriptPath,
    `
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const [counterPath, legacyOutputPath, failureFlagPath, sourcePath] =
  process.argv.slice(2);
const outputDirectory =
  process.env.INTENTARC_PACKAGED_TEST_OUTPUT_DIRECTORY ??
  dirname(legacyOutputPath);
const outputPath = join(outputDirectory, "output.js");
await appendFile(counterPath, \`\${process.pid}\\n\`);
await new Promise((resolveWait) => setTimeout(resolveWait, 200));

if (existsSync(failureFlagPath)) {
  process.stderr.write("synthetic compiler failure\\n");
  process.exitCode = 7;
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await readFile(sourcePath, "utf8"));
}
`.trimStart(),
  );

  return {
    root,
    sourcePath,
    stateDirectory,
    counterPath,
    outputPath,
    failureFlagPath,
    buildScriptPath,
  };
};

const createRunnerStateDirectory = async (): Promise<string> => {
  const temporaryRoot = await realpath(tmpdir());
  const stateDirectory = join(
    temporaryRoot,
    `intentarc-packaged-reliability-${randomUUID()}`,
  );
  temporaryDirectories.push(stateDirectory);
  await mkdir(stateDirectory);
  const canonicalStateDirectory = await realpath(stateDirectory);
  await writeFile(
    join(stateDirectory, ".intentarc-packaged-reliability-owner.json"),
    `${JSON.stringify({
      schema: "intentarc.packaged-reliability-state/v1",
      stateDirectory: canonicalStateDirectory,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return stateDirectory;
};

const withRunnerStateDirectory = async <T>(
  stateDirectory: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = process.env[packagedTestStateDirectoryEnv];
  process.env[packagedTestStateDirectoryEnv] = stateDirectory;
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env[packagedTestStateDirectoryEnv];
    } else {
      process.env[packagedTestStateDirectoryEnv] = previous;
    }
  }
};

const optionsFor = (fixture: Fixture): PackagedTestBuildOptions => ({
  repositoryRoot: fixture.root,
  stateDirectory: fixture.stateDirectory,
  buildCommand: {
    command: process.execPath,
    arguments: [
      fixture.buildScriptPath,
      fixture.counterPath,
      fixture.outputPath,
      fixture.failureFlagPath,
      fixture.sourcePath,
    ],
    cwd: fixture.root,
  },
  waitTimeoutMs: 5_000,
});

const createRunnableHelperModule = async (): Promise<string> => {
  const helperSourcePath = resolve(
    process.cwd(),
    "src/test-support/packaged-test-build.ts",
  );
  await readFile(helperSourcePath, "utf8");
  return helperSourcePath;
};

const runChildEnsurer = (
  helperModulePath: string,
  options: PackagedTestBuildOptions,
): Promise<ChildResult> =>
  new Promise((resolveChild, reject) => {
    const helperUrl = pathToFileURL(helperModulePath).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { ensurePackagedTestBuild } = await import(${JSON.stringify(helperUrl)});
const result = await ensurePackagedTestBuild(
  JSON.parse(process.env.INTENTARC_BUILD_OPTIONS),
);
process.stdout.write(JSON.stringify(result));`,
      ],
      {
        env: {
          ...process.env,
          INTENTARC_BUILD_OPTIONS: JSON.stringify(options),
        },
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveChild({ code, stdout, stderr });
    });
  });

const runGenerationReader = (outputDirectory: string): GenerationReader => {
  const moduleUrl = pathToFileURL(join(outputDirectory, "output.js")).href;
  let resolveReady: (value: number) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<number>((resolveValue, rejectValue) => {
    resolveReady = resolveValue;
    rejectReady = rejectValue;
  });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const first = await import(${JSON.stringify(`${moduleUrl}?phase=first`)});
process.stdout.write(\`ready:\${first.value}\\n\`);
await new Promise((resolveInput) => process.stdin.once("data", resolveInput));
const second = await import(${JSON.stringify(`${moduleUrl}?phase=second`)});
process.stdout.write(\`finished:\${second.value}\\n\`);`,
    ],
    { windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const match = /^ready:(\d+)\r?\n/.exec(stdout);
    if (match) resolveReady(Number(match[1]));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("error", (error) => {
    rejectReady(error);
  });
  const completed = new Promise<ChildResult>((resolveChild) => {
    child.once("close", (code) => {
      if (!stdout.startsWith("ready:")) {
        rejectReady(new Error(stderr || "generation reader exited before ready"));
      }
      resolveChild({ code, stdout, stderr });
    });
  });
  return {
    ready,
    finish: async () => {
      child.stdin.write("\n");
      child.stdin.end();
      return completed;
    },
  };
};

const runNodeModule = (modulePath: string): Promise<ChildResult> =>
  new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [modulePath], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveChild({ code, stdout, stderr });
    });
  });

const buildAttempts = async (fixture: Fixture): Promise<string[]> =>
  (await readFile(fixture.counterPath, "utf8")).trim().split(/\r?\n/);

const completedMarkers = async (directory: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const markers: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      markers.push(...(await completedMarkers(path)));
    } else if (entry.name === "completed.json") {
      markers.push(path);
    }
  }
  return markers;
};

const nodeError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

type PackagedTestBuildInternalDependencies = Parameters<
  typeof ensurePackagedTestBuildWithDependenciesForTest
>[1];

type PackagedTestBuildPromotionDependencies =
  PackagedTestBuildInternalDependencies["promotion"];

const productionLikePromotionDependencies = (
  overrides: Partial<PackagedTestBuildPromotionDependencies> = {},
): PackagedTestBuildPromotionDependencies => ({
  platform: process.platform,
  rename,
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  now: () => performance.now(),
  wait: async (_milliseconds, signal) => signal?.throwIfAborted(),
  ...overrides,
});

const packagedTestBuildInternalDependencies = (
  overrides: {
    readonly promotion?: Partial<PackagedTestBuildPromotionDependencies>;
    readonly removeStagingDirectory?: (path: string) => Promise<void>;
  } = {},
): PackagedTestBuildInternalDependencies => ({
  promotion: productionLikePromotionDependencies(overrides.promotion),
  removeStagingDirectory:
    overrides.removeStagingDirectory ??
    ((path) => rm(path, { recursive: true, force: true })),
});

const buildTransactionIsLocked = (databasePath: string): boolean => {
  const observer = new Database(databasePath, { timeout: 0 });
  try {
    try {
      observer.exec("BEGIN IMMEDIATE");
      observer.exec("ROLLBACK");
      return false;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
      ) {
        return true;
      }
      throw error;
    }
  } finally {
    observer.close();
  }
};

type PackagedGenerationPromotionFixtureIdentity = {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

const promotionFixtureIdentity = (
  canonicalPath: string,
  dev: bigint,
  ino: bigint,
  overrides: Partial<PackagedGenerationPromotionFixtureIdentity> = {},
): PackagedGenerationPromotionFixtureIdentity => ({
  canonicalPath,
  dev,
  ino,
  isDirectory: true,
  isSymbolicLink: false,
  ...overrides,
});

const packagedGenerationPromotionHarness = (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly signal?: AbortSignal;
    readonly onWait?: () => void;
    readonly stagingCanonicalPath?: string;
  } = {},
) => {
  const generationsDirectory = "C:\\cache\\generations";
  const stagingDirectory = `${generationsDirectory}\\fingerprint.staging-fixture`;
  const generationDirectory = `${generationsDirectory}\\fingerprint`;
  const generationsIdentity = promotionFixtureIdentity(
    generationsDirectory,
    10n,
    20n,
  );
  const stagingIdentity = promotionFixtureIdentity(
    options.stagingCanonicalPath ?? stagingDirectory,
    10n,
    21n,
  );
  const identities = new Map([
    [generationsDirectory, generationsIdentity],
    [stagingDirectory, stagingIdentity],
  ]);
  const lstatErrors = new Map<string, Error>();
  const realpathErrors = new Map<string, Error>();
  let currentTime = 0;
  const waits: number[] = [];
  const completeRename = (
    overrides: Partial<PackagedGenerationPromotionFixtureIdentity> = {},
    removeSource = true,
  ) => {
    const source = identities.get(stagingDirectory);
    if (source === undefined) throw nodeError("ENOENT", "staging missing");
    if (removeSource) identities.delete(stagingDirectory);
    identities.set(
      generationDirectory,
      promotionFixtureIdentity(
        generationDirectory,
        source.dev,
        source.ino,
        { ...source, canonicalPath: generationDirectory, ...overrides },
      ),
    );
  };
  const rename = vi.fn(async (_source: string, _destination: string) => {
    completeRename();
  });
  const lstat = vi.fn(async (path: string) => {
    const failure = lstatErrors.get(path);
    if (failure !== undefined) throw failure;
    const identity = identities.get(path);
    if (identity === undefined) throw nodeError("ENOENT", "missing");
    return {
      dev: identity.dev,
      ino: identity.ino,
      isDirectory: () => identity.isDirectory,
      isSymbolicLink: () => identity.isSymbolicLink,
    };
  });
  const realpath = vi.fn(async (path: string) => {
    const failure = realpathErrors.get(path);
    if (failure !== undefined) throw failure;
    const identity = identities.get(path);
    if (identity === undefined) throw nodeError("ENOENT", "missing");
    return identity.canonicalPath;
  });
  const now = vi.fn(() => currentTime);
  const wait = vi.fn(async (milliseconds: number, _signal?: AbortSignal) => {
    waits.push(milliseconds);
    currentTime += milliseconds;
    options.onWait?.();
  });
  const isBuildTransactionActive = vi.fn(() => true);
  const verifyPromotedGeneration = vi.fn(async () => true);
  const baseline = {
    generationsDirectory: {
      canonicalPath: generationsIdentity.canonicalPath,
      dev: generationsIdentity.dev,
      ino: generationsIdentity.ino,
    },
    stagingDirectory: {
      canonicalPath: stagingIdentity.canonicalPath,
      dev: stagingIdentity.dev,
      ino: stagingIdentity.ino,
    },
  };
  const input: PackagedGenerationPromotionInput = {
    generationsDirectory,
    stagingDirectory,
    generationDirectory,
    baseline,
    isBuildTransactionActive,
    verifyPromotedGeneration,
    signal: options.signal,
  };

  return {
    input,
    dependencies: {
      platform: options.platform ?? "win32",
      rename,
      lstat,
      realpath,
      now,
      wait,
    },
    rename,
    lstat,
    realpath,
    identities,
    lstatErrors,
    realpathErrors,
    generationsDirectory,
    stagingDirectory,
    generationDirectory,
    baseline,
    completeRename,
    isBuildTransactionActive,
    verifyPromotedGeneration,
    now,
    waits,
    setTime: (milliseconds: number) => {
      currentTime = milliseconds;
    },
  };
};

type PackagedGenerationPromotionHarness = ReturnType<
  typeof packagedGenerationPromotionHarness
>;

const replacePackagedPromotionIdentity = (
  harness: PackagedGenerationPromotionHarness,
  path: string,
  overrides: Partial<PackagedGenerationPromotionFixtureIdentity>,
): void => {
  const identity = harness.identities.get(path);
  if (identity === undefined) throw new Error(`Missing promotion fixture ${path}`);
  harness.identities.set(path, { ...identity, ...overrides });
};

type PackagedGenerationPromotionFunction = (
  input: PackagedGenerationPromotionInput,
  dependencies: PackagedGenerationPromotionHarness["dependencies"],
) => Promise<void>;

const loadPackagedPromotionMutant = async (
  name: string,
  mutate: (source: string) => string,
): Promise<PackagedGenerationPromotionFunction> => {
  const sourcePath = resolve("src", "test-support", "packaged-test-build.ts");
  const source = (await readFile(sourcePath, "utf8")).replaceAll("\r\n", "\n");
  const mutant = mutate(source);
  expect(mutant, `${name} mutation must change production source`).not.toBe(source);
  const directory = await mkdtemp(
    join(dirname(sourcePath), ".packaged-promotion-mutant-"),
  );
  temporaryDirectories.push(directory);
  const mutantPath = join(directory, "packaged-test-build-mutant.mjs");
  const output = await transform(mutant, {
    format: "esm",
    loader: "ts",
    sourcefile: sourcePath,
    target: "es2022",
  });
  await writeFile(mutantPath, output.code);
  const module = await import(
    /* @vite-ignore */
    `${pathToFileURL(mutantPath).href}?mutant=${encodeURIComponent(name)}-${randomUUID()}`
  ) as { promotePackagedGeneration?: PackagedGenerationPromotionFunction };
  if (typeof module.promotePackagedGeneration !== "function") {
    throw new Error(`${name} mutant did not export promotePackagedGeneration`);
  }
  return module.promotePackagedGeneration;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("packaged generation promotion settlement", () => {
  it("captures an ordinary packaged promotion directory identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-promotion-identity-"));
    temporaryDirectories.push(directory);
    const details = await lstat(directory, { bigint: true });

    await expect(
      capturePackagedGenerationPromotionPathIdentity(directory, "staging"),
    ).resolves.toEqual({
      canonicalPath: await realpath(directory),
      dev: details.dev,
      ino: details.ino,
    });
  });

  it("rejects a non-directory packaged promotion identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-promotion-file-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "not-a-directory");
    await writeFile(file, "fixture");

    await expect(
      capturePackagedGenerationPromotionPathIdentity(file, "staging"),
    ).rejects.toThrow();
  });

  it("rejects a reparse-backed packaged promotion identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentarc-promotion-reparse-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target");
    const alias = join(directory, "alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

    await expect(
      capturePackagedGenerationPromotionPathIdentity(alias, "staging"),
    ).rejects.toThrow();
  });

  it("rejects an inactive build transaction before promotion attempt zero", async () => {
    const harness = packagedGenerationPromotionHarness();
    harness.isBuildTransactionActive.mockReturnValue(false);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["dev", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { dev: 99n },
      );
    }],
    ["ino", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { ino: 99n },
      );
    }],
    ["canonical path", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { canonicalPath: "C:\\different\\generations" },
      );
    }],
  ])("rejects parent %s mismatch before promotion attempt zero", async (_field, mutate) => {
    const harness = packagedGenerationPromotionHarness();
    mutate(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["inaccessible", (harness: PackagedGenerationPromotionHarness) => {
      harness.lstatErrors.set(
        harness.generationsDirectory,
        nodeError("EACCES", "parent inaccessible"),
      );
    }],
    ["reparse-backed", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { isSymbolicLink: true },
      );
    }],
    ["non-directory", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { isDirectory: false },
      );
    }],
  ])("rejects a parent that is %s before promotion attempt zero", async (_state, mutate) => {
    const harness = packagedGenerationPromotionHarness();
    mutate(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["dev", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { dev: 99n },
      );
    }],
    ["ino", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { ino: 99n },
      );
    }],
    ["canonical path", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { canonicalPath: "C:\\different\\fingerprint.staging-fixture" },
      );
    }],
  ])("rejects staging %s mismatch before promotion attempt zero", async (_field, mutate) => {
    const harness = packagedGenerationPromotionHarness();
    mutate(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["inaccessible", (harness: PackagedGenerationPromotionHarness) => {
      harness.lstatErrors.set(
        harness.stagingDirectory,
        nodeError("EACCES", "staging inaccessible"),
      );
    }],
    ["reparse-backed", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { isSymbolicLink: true },
      );
    }],
    ["non-directory", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { isDirectory: false },
      );
    }],
  ])("rejects staging that is %s before promotion attempt zero", async (_state, mutate) => {
    const harness = packagedGenerationPromotionHarness();
    mutate(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it("rejects staging containment drift before promotion attempt zero", async () => {
    const harness = packagedGenerationPromotionHarness({
      stagingCanonicalPath:
        "C:\\cache\\other\\fingerprint.staging-fixture",
    });

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it("rejects a changed staging basename before promotion attempt zero", async () => {
    const harness = packagedGenerationPromotionHarness({
      stagingCanonicalPath: "C:\\cache\\generations\\different-staging",
    });

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["file", (harness: PackagedGenerationPromotionHarness) => {
      harness.identities.set(
        harness.generationDirectory,
        promotionFixtureIdentity(
          harness.generationDirectory,
          10n,
          30n,
          { isDirectory: false },
        ),
      );
    }],
    ["directory", (harness: PackagedGenerationPromotionHarness) => {
      harness.identities.set(
        harness.generationDirectory,
        promotionFixtureIdentity(harness.generationDirectory, 10n, 30n),
      );
    }],
    ["reparse point", (harness: PackagedGenerationPromotionHarness) => {
      harness.identities.set(
        harness.generationDirectory,
        promotionFixtureIdentity(
          harness.generationDirectory,
          10n,
          30n,
          { isSymbolicLink: true },
        ),
      );
    }],
    ["ambiguous state", (harness: PackagedGenerationPromotionHarness) => {
      harness.lstatErrors.set(
        harness.generationDirectory,
        nodeError("EACCES", "destination inaccessible"),
      );
    }],
  ])("rejects destination %s before promotion attempt zero", async (_state, mutate) => {
    const harness = packagedGenerationPromotionHarness();
    mutate(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it("compares packaged promotion identities case-insensitively on Windows", async () => {
    const harness = packagedGenerationPromotionHarness();
    replacePackagedPromotionIdentity(
      harness,
      harness.generationsDirectory,
      { canonicalPath: "c:\\CACHE\\GENERATIONS" },
    );
    replacePackagedPromotionIdentity(
      harness,
      harness.stagingDirectory,
      { canonicalPath: "c:\\CACHE\\GENERATIONS\\FINGERPRINT.STAGING-FIXTURE" },
    );

    await promotePackagedGeneration(harness.input, harness.dependencies);

    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
  });

  it("compares packaged promotion identities case-sensitively off Windows", async () => {
    const harness = packagedGenerationPromotionHarness({ platform: "linux" });
    replacePackagedPromotionIdentity(
      harness,
      harness.generationsDirectory,
      { canonicalPath: "c:\\cache\\generations" },
    );

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["transaction loss", (harness: PackagedGenerationPromotionHarness) => {
      harness.isBuildTransactionActive.mockReturnValue(false);
    }],
    ["parent identity drift", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.generationsDirectory,
        { ino: 99n },
      );
    }],
    ["staging identity drift", (harness: PackagedGenerationPromotionHarness) => {
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { dev: 99n },
      );
    }],
    ["staging containment drift", (harness: PackagedGenerationPromotionHarness) => {
      const driftedPath = "C:\\cache\\other\\fingerprint.staging-fixture";
      replacePackagedPromotionIdentity(
        harness,
        harness.stagingDirectory,
        { canonicalPath: driftedPath },
      );
      harness.baseline.stagingDirectory.canonicalPath = driftedPath;
    }],
    ["inaccessible parent", (harness: PackagedGenerationPromotionHarness) => {
      harness.lstatErrors.set(
        harness.generationsDirectory,
        nodeError("EACCES", "parent became inaccessible"),
      );
    }],
    ["inaccessible staging", (harness: PackagedGenerationPromotionHarness) => {
      harness.lstatErrors.set(
        harness.stagingDirectory,
        nodeError("EACCES", "staging became inaccessible"),
      );
    }],
    ["destination appearance", (harness: PackagedGenerationPromotionHarness) => {
      harness.identities.set(
        harness.generationDirectory,
        promotionFixtureIdentity(harness.generationDirectory, 10n, 30n),
      );
    }],
  ])("stops after one rename when retry proof detects %s", async (_state, mutate) => {
    let harness!: PackagedGenerationPromotionHarness;
    harness = packagedGenerationPromotionHarness({
      onWait: () => mutate(harness),
    });
    harness.rename.mockRejectedValueOnce(nodeError("EPERM", "first"));

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([25]);
  });

  it.each([
    ["source persistence", (harness: PackagedGenerationPromotionHarness) => {
      harness.rename.mockImplementationOnce(async () => {
        harness.completeRename({}, false);
      });
    }],
    ["destination identity mismatch", (harness: PackagedGenerationPromotionHarness) => {
      harness.rename.mockImplementationOnce(async () => {
        harness.completeRename({ ino: 99n });
      });
    }],
    ["destination canonical-path mismatch", (harness: PackagedGenerationPromotionHarness) => {
      harness.rename.mockImplementationOnce(async () => {
        harness.completeRename({ canonicalPath: "C:\\different\\fingerprint" });
      });
    }],
  ])("does not retry after post-rename %s", async (_state, arrangeRename) => {
    const harness = packagedGenerationPromotionHarness();
    arrangeRename(harness);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow();
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(0);
  });

  it("does not retry when post-rename completion verification returns false", async () => {
    const harness = packagedGenerationPromotionHarness();
    harness.verifyPromotedGeneration.mockResolvedValue(false);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toThrow(/completeness/i);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
  });

  it("does not retry an EPERM from post-rename completion verification", async () => {
    const harness = packagedGenerationPromotionHarness();
    const verificationError = nodeError("EPERM", "verification failed");
    harness.verifyPromotedGeneration.mockRejectedValue(verificationError);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(verificationError);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
  });

  it("retries one transient Windows EPERM after exactly 25 ms", async () => {
    const harness = packagedGenerationPromotionHarness();
    const first = nodeError("EPERM", "first");
    harness.rename.mockRejectedValueOnce(first);

    await promotePackagedGeneration(harness.input, harness.dependencies);

    expect(harness.rename).toHaveBeenCalledTimes(2);
    expect(harness.waits).toEqual([25]);
    expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["linux", "EPERM"],
    ["darwin", "EPERM"],
    ["win32", "EACCES"],
    ["win32", "EBUSY"],
    ["win32", "ENOENT"],
    ["win32", "EEXIST"],
    ["win32", "ENOTEMPTY"],
  ] as const)("does not retry %s %s", async (platform, code) => {
    const harness = packagedGenerationPromotionHarness({ platform });
    const first = nodeError(code, "first");
    harness.rename.mockRejectedValue(first);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(first);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
  });

  it("does not retry a Windows error without a code", async () => {
    const harness = packagedGenerationPromotionHarness();
    const first = new Error("uncoded");
    harness.rename.mockRejectedValue(first);

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(first);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
  });

  it("uses the complete bounded wait sequence and preserves the first EPERM", async () => {
    const harness = packagedGenerationPromotionHarness();
    const first = nodeError("EPERM", "first");
    harness.rename
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(nodeError("EPERM", "second"))
      .mockRejectedValueOnce(nodeError("EPERM", "third"))
      .mockRejectedValueOnce(nodeError("EPERM", "fourth"))
      .mockRejectedValueOnce(nodeError("EPERM", "fifth"))
      .mockRejectedValueOnce(nodeError("EPERM", "sixth"))
      .mockRejectedValueOnce(nodeError("EPERM", "seventh"))
      .mockRejectedValueOnce(nodeError("EPERM", "eighth"));

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(first);
    expect(harness.rename).toHaveBeenCalledTimes(8);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400, 400, 400]);
  });

  it("can succeed on the eighth promotion attempt", async () => {
    const harness = packagedGenerationPromotionHarness();
    for (let attempt = 1; attempt < 8; attempt += 1) {
      harness.rename.mockRejectedValueOnce(
        nodeError("EPERM", `attempt ${attempt}`),
      );
    }

    await promotePackagedGeneration(harness.input, harness.dependencies);

    expect(harness.rename).toHaveBeenCalledTimes(8);
    expect(harness.waits).toEqual([25, 50, 100, 200, 400, 400, 400]);
  });

  it("does not wait when the promotion deadline expires after an attempt", async () => {
    const harness = packagedGenerationPromotionHarness();
    const first = nodeError("EPERM", "first");
    harness.rename.mockImplementationOnce(async () => {
      harness.setTime(2_000);
      throw first;
    });

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(first);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
  });

  it("does not make another promotion attempt when the deadline expires during a wait", async () => {
    const harness = packagedGenerationPromotionHarness();
    const first = nodeError("EPERM", "first");
    harness.rename.mockRejectedValueOnce(first);
    harness.dependencies.wait.mockImplementationOnce(async (milliseconds) => {
      harness.waits.push(milliseconds);
      harness.setTime(2_000);
    });

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(first);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([25]);
  });

  it("does not attempt promotion when already cancelled", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled before promotion");
    controller.abort(cancellation);
    const harness = packagedGenerationPromotionHarness({
      signal: controller.signal,
    });

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(cancellation);
    expect(harness.rename).toHaveBeenCalledTimes(0);
    expect(harness.waits).toEqual([]);
  });

  it("does not make another promotion attempt when cancelled during the first wait", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled during promotion wait");
    const harness = packagedGenerationPromotionHarness({
      signal: controller.signal,
      onWait: () => controller.abort(cancellation),
    });
    harness.rename.mockRejectedValueOnce(nodeError("EPERM", "first"));

    await expect(
      promotePackagedGeneration(harness.input, harness.dependencies),
    ).rejects.toBe(cancellation);
    expect(harness.rename).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([25]);
  });

  it.each([
    [
      "Windows retry eligibility",
      (source: string) => source.replace(
        'dependencies.platform !== "win32"',
        "false",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness({ platform: "linux" });
        const first = nodeError("EPERM", "first");
        harness.rename.mockRejectedValueOnce(first);
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toBe(first);
        expect(harness.rename).toHaveBeenCalledTimes(1);
        expect(harness.waits).toEqual([]);
      },
    ],
    [
      "exact EPERM eligibility",
      (source: string) => source.replace(
        '!hasCode(error, "EPERM")',
        "false",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        const first = nodeError("EACCES", "first");
        harness.rename.mockRejectedValueOnce(first);
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toBe(first);
        expect(harness.rename).toHaveBeenCalledTimes(1);
        expect(harness.waits).toEqual([]);
      },
    ],
    [
      "first EPERM preservation",
      (source: string) => source.replace(
        "      firstError ??= error;",
        "      firstError = error;",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        const first = nodeError("EPERM", "first");
        harness.rename
          .mockRejectedValueOnce(first)
          .mockRejectedValueOnce(nodeError("EPERM", "second"))
          .mockRejectedValueOnce(nodeError("EPERM", "third"))
          .mockRejectedValueOnce(nodeError("EPERM", "fourth"))
          .mockRejectedValueOnce(nodeError("EPERM", "fifth"))
          .mockRejectedValueOnce(nodeError("EPERM", "sixth"))
          .mockRejectedValueOnce(nodeError("EPERM", "seventh"))
          .mockRejectedValueOnce(nodeError("EPERM", "eighth"));
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toBe(first);
      },
    ],
    [
      "active transaction proof",
      (source: string) => source.replace(
        "  if (!input.isBuildTransactionActive()) {",
        "  if (false) {",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        harness.isBuildTransactionActive.mockReturnValue(false);
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow();
        expect(harness.rename).toHaveBeenCalledTimes(0);
      },
    ],
    [
      "parent identity comparison",
      (source: string) => source.replace(
        `  provePackagedGenerationPromotionIdentity(
    generationsDirectory,
    input.baseline.generationsDirectory,
    "parent",
    dependencies.platform,
  );
`,
        "",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        replacePackagedPromotionIdentity(
          harness,
          harness.generationsDirectory,
          { ino: 99n },
        );
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow();
        expect(harness.rename).toHaveBeenCalledTimes(0);
      },
    ],
    [
      "staging identity comparison",
      (source: string) => source.replace(
        `  provePackagedGenerationPromotionIdentity(
    stagingDirectory,
    input.baseline.stagingDirectory,
    "staging directory",
    dependencies.platform,
  );
`,
        "",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        replacePackagedPromotionIdentity(
          harness,
          harness.stagingDirectory,
          { dev: 99n },
        );
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow();
        expect(harness.rename).toHaveBeenCalledTimes(0);
      },
    ],
    [
      "exact destination ENOENT",
      (source: string) => source.replace(
        '    if (hasCode(error, "ENOENT")) return;',
        "    if (true) return;",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        harness.lstatErrors.set(
          harness.generationDirectory,
          nodeError("EACCES", "destination ambiguous"),
        );
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow();
        expect(harness.rename).toHaveBeenCalledTimes(0);
      },
    ],
    [
      "2,000 ms deadline",
      (source: string) => source.replace(
        "const packagedGenerationPromotionDeadlineMs = 2_000;",
        "const packagedGenerationPromotionDeadlineMs = 20_000;",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        const first = nodeError("EPERM", "first");
        harness.rename.mockImplementationOnce(async () => {
          harness.setTime(2_000);
          throw first;
        });
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toBe(first);
        expect(harness.rename).toHaveBeenCalledTimes(1);
        expect(harness.waits).toEqual([]);
      },
    ],
    [
      "abort checks",
      (source: string) => source.replace(
        "): void => signal?.throwIfAborted();",
        "): void => { void signal; };",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const controller = new AbortController();
        const cancellation = new Error("cancelled before promotion");
        controller.abort(cancellation);
        const harness = packagedGenerationPromotionHarness({
          signal: controller.signal,
        });
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toBe(cancellation);
        expect(harness.rename).toHaveBeenCalledTimes(0);
      },
    ],
    [
      "post-rename source and destination proof",
      (source: string) => source.replace(
        "    await provePromotedPackagedGeneration(input, dependencies);\n",
        "",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        harness.rename.mockImplementationOnce(async () => {
          harness.completeRename({}, false);
        });
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow();
        expect(harness.rename).toHaveBeenCalledTimes(1);
      },
    ],
    [
      "completion callback invocation",
      (source: string) => source.replace(
        "    if (!(await input.verifyPromotedGeneration())) {",
        "    if (false && !(await input.verifyPromotedGeneration())) {",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        await promote(harness.input, harness.dependencies);
        expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
      },
    ],
    [
      "completion callback false rejection",
      (source: string) => source.replace(
        "    if (!(await input.verifyPromotedGeneration())) {",
        "    if (!(await input.verifyPromotedGeneration()) && false) {",
      ),
      async (promote: PackagedGenerationPromotionFunction) => {
        const harness = packagedGenerationPromotionHarness();
        harness.verifyPromotedGeneration.mockResolvedValue(false);
        await expect(
          promote(harness.input, harness.dependencies),
        ).rejects.toThrow(/completeness/i);
        expect(harness.rename).toHaveBeenCalledTimes(1);
        expect(harness.verifyPromotedGeneration).toHaveBeenCalledTimes(1);
      },
    ],
  ] as const)("kills packaged promotion mutants: %s", async (name, mutate, probe) => {
    const mutantPromotion = await loadPackagedPromotionMutant(name, mutate);
    let focusedFailure: unknown;
    try {
      await probe(mutantPromotion);
    } catch (error) {
      focusedFailure = error;
    }
    expect(
      focusedFailure,
      `${name} mutant survived its focused behavioral test`,
    ).toBeDefined();
  });
});

describe("serialized promotion integration", () => {
  it("exposes the closed serialized promotion worker seam", async () => {
    const fixture = await createFixture();

    const result = await ensurePackagedTestBuildWithDependenciesForTest(
      optionsFor(fixture),
      packagedTestBuildInternalDependencies(),
    );

    expect(result.built).toBe(true);
  });

  it("captures serialized promotion staging identity only after the marker is complete", async () => {
    const fixture = await createFixture();
    let capturedIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
    let capturedFingerprint: string | undefined;

    const result = await ensurePackagedTestBuildWithDependenciesForTest(
      optionsFor(fixture),
      packagedTestBuildInternalDependencies({
        promotion: {
          lstat: async (path) => {
            const details = await lstat(path, { bigint: true });
            if (
              capturedIdentity === undefined &&
              basename(path).includes(".staging-")
            ) {
              const marker = JSON.parse(
                await readFile(join(path, "completed.json"), "utf8"),
              ) as { fingerprint?: string };
              capturedFingerprint = marker.fingerprint;
              capturedIdentity = { dev: details.dev, ino: details.ino };
            }
            return details;
          },
        },
      }),
    );
    const promotedIdentity = await lstat(result.packageRoot, { bigint: true });

    expect(capturedFingerprint).toBe(result.fingerprint);
    expect(capturedIdentity).toEqual({
      dev: promotedIdentity.dev,
      ino: promotedIdentity.ino,
    });
  });

  it("rebases serialized promotion paths canonically and never invokes the compiler twice for transient EPERM", async () => {
    const fixture = await createFixture();
    const externalStateDirectory = await mkdtemp(
      join(tmpdir(), "intentarc-packaged-canonical-state-"),
    );
    temporaryDirectories.push(externalStateDirectory);
    const stateAlias = join(fixture.root, "node_modules", "canonical-state-alias");
    await symlink(
      externalStateDirectory,
      stateAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const generationsDirectory = join(externalStateDirectory, "generations");
    await mkdir(generationsDirectory);
    const canonicalGenerationsDirectory = await realpath(generationsDirectory);
    const databasePath = join(externalStateDirectory, "coordination.sqlite");
    const attempts: Array<{ readonly source: string; readonly destination: string }> = [];
    const transactionStates: boolean[] = [];

    const result = await ensurePackagedTestBuildWithDependenciesForTest(
      { ...optionsFor(fixture), stateDirectory: stateAlias },
      packagedTestBuildInternalDependencies({
        promotion: {
          platform: "win32",
          rename: async (source, destination) => {
            attempts.push({ source, destination });
            transactionStates.push(buildTransactionIsLocked(databasePath));
            if (attempts.length === 1) {
              throw nodeError("EPERM", "transient settlement contention");
            }
            await rename(source, destination);
          },
        },
      }),
    );

    expect(transactionStates).toEqual([true, true]);
    expect(await buildAttempts(fixture)).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(({ source }) => dirname(source))).toEqual([
      canonicalGenerationsDirectory,
      canonicalGenerationsDirectory,
    ]);
    expect(attempts.map(({ destination }) => destination)).toEqual([
      join(canonicalGenerationsDirectory, result.fingerprint),
      join(canonicalGenerationsDirectory, result.fingerprint),
    ]);
    expect(result.packageRoot).toBe(
      join(canonicalGenerationsDirectory, result.fingerprint),
    );
    expect(buildTransactionIsLocked(databasePath)).toBe(false);
  });

  it("rejects serialized promotion destination appearance and preserves existing marker, destination, and parent during exact staging cleanup", async () => {
    const fixture = await createFixture();
    const generationsDirectory = join(fixture.stateDirectory, "generations");
    await mkdir(generationsDirectory, { recursive: true });
    const parentSentinel = join(generationsDirectory, "parent-sentinel.txt");
    await writeFile(parentSentinel, "parent remains\n");
    const cleanupPaths: string[] = [];
    let stagingDirectory = "";
    let generationDirectory = "";

    await expect(
      ensurePackagedTestBuildWithDependenciesForTest(
        optionsFor(fixture),
        packagedTestBuildInternalDependencies({
          promotion: {
            platform: "win32",
            rename: async (source, destination) => {
              stagingDirectory = source;
              generationDirectory = destination;
              await mkdir(join(destination, "dist"), { recursive: true });
              await writeFile(
                join(destination, "completed.json"),
                JSON.stringify({ fingerprint: basename(destination) }),
              );
              throw nodeError("EPERM", "destination appeared");
            },
          },
          removeStagingDirectory: async (path) => {
            cleanupPaths.push(path);
            await rm(path, { recursive: true, force: true });
          },
        }),
      ),
    ).rejects.toThrow(/destination already exists/i);

    expect(cleanupPaths).toEqual([stagingDirectory]);
    expect(dirname(stagingDirectory)).toBe(await realpath(generationsDirectory));
    expect(basename(stagingDirectory)).toMatch(
      /^[0-9a-f]{64}\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(lstat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(parentSentinel, "utf8")).toBe("parent remains\n");
    expect(
      JSON.parse(await readFile(join(generationDirectory, "completed.json"), "utf8")),
    ).toEqual({ fingerprint: basename(generationDirectory) });
  });

  it("keeps the serialized transaction active through failed post-promotion verification and rolls back afterward", async () => {
    const fixture = await createFixture();
    const databasePath = join(fixture.stateDirectory, "coordination.sqlite");
    let transactionActiveDuringCleanup: boolean | undefined;

    await expect(
      ensurePackagedTestBuildWithDependenciesForTest(
        optionsFor(fixture),
        packagedTestBuildInternalDependencies({
          promotion: {
            rename: async (source, destination) => {
              await rename(source, destination);
              await writeFile(join(destination, "completed.json"), "{}\n");
            },
          },
          removeStagingDirectory: async (path) => {
            transactionActiveDuringCleanup =
              buildTransactionIsLocked(databasePath);
            await rm(path, { recursive: true, force: true });
          },
        }),
      ),
    ).rejects.toThrow(/completeness verification/i);

    expect(transactionActiveDuringCleanup).toBe(true);
    expect(buildTransactionIsLocked(databasePath)).toBe(false);
  });

  it.each([
    ["destination identity mismatch", "identity"],
    ["missing external dependency bridge", "missing-bridge"],
    ["redirected external dependency bridge", "redirected-bridge"],
  ] as const)("rejects post-promotion %s", async (_label, mode) => {
    const fixture = await createFixture();
    const usesExternalState = mode !== "identity";
    const stateDirectory = usesExternalState
      ? await mkdtemp(join(tmpdir(), "intentarc-packaged-postcondition-state-"))
      : fixture.stateDirectory;
    if (usesExternalState) temporaryDirectories.push(stateDirectory);
    const redirectedTarget = join(fixture.root, "redirected-node-modules");
    if (mode === "redirected-bridge") await mkdir(redirectedTarget);

    await expect(
      ensurePackagedTestBuildWithDependenciesForTest(
        { ...optionsFor(fixture), stateDirectory },
        packagedTestBuildInternalDependencies({
          promotion: {
            rename: async (source, destination) => {
              await rename(source, destination);
              if (mode === "identity") {
                await rm(destination, { recursive: true, force: true });
                await mkdir(destination);
                return;
              }
              const dependencyBridge = join(destination, "node_modules");
              await unlink(dependencyBridge);
              if (mode === "redirected-bridge") {
                await symlink(
                  redirectedTarget,
                  dependencyBridge,
                  process.platform === "win32" ? "junction" : "dir",
                );
              }
            },
          },
        }),
      ),
    ).rejects.toThrow(
      mode === "identity" ? /preserve staging identity/i : /completeness/i,
    );

    expect(await buildAttempts(fixture)).toHaveLength(1);
  });

  it("aborts serialized promotion settlement with exact staging cleanup only", async () => {
    const fixture = await createFixture();
    const generationsDirectory = join(fixture.stateDirectory, "generations");
    await mkdir(generationsDirectory, { recursive: true });
    const parentSentinel = join(generationsDirectory, "parent-sentinel.txt");
    await writeFile(parentSentinel, "parent remains\n");
    const controller = new AbortController();
    const cancellation = new Error("cancel serialized settlement");
    const cleanupPaths: string[] = [];
    let stagingDirectory = "";

    await expect(
      ensurePackagedTestBuildWithDependenciesForTest(
        { ...optionsFor(fixture), signal: controller.signal },
        packagedTestBuildInternalDependencies({
          promotion: {
            platform: "win32",
            rename: async (source) => {
              stagingDirectory = source;
              throw nodeError("EPERM", "settlement still busy");
            },
            wait: async () => {
              controller.abort(cancellation);
            },
          },
          removeStagingDirectory: async (path) => {
            cleanupPaths.push(path);
            await rm(path, { recursive: true, force: true });
          },
        }),
      ),
    ).rejects.toBe(cancellation);

    const fingerprint = basename(stagingDirectory).slice(
      0,
      basename(stagingDirectory).indexOf(".staging-"),
    );
    expect(cleanupPaths).toEqual([stagingDirectory]);
    expect(dirname(stagingDirectory)).toBe(await realpath(generationsDirectory));
    expect(basename(stagingDirectory)).toMatch(
      /^[0-9a-f]{64}\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(lstat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(await realpath(generationsDirectory), fingerprint)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(parentSentinel, "utf8")).toBe("parent remains\n");
  });

  it("never returns serialized promotion success when exact staging cleanup fails", async () => {
    const fixture = await createFixture();
    const cleanupFailure = new Error("exact staging cleanup failed");
    let stagingDirectory = "";

    await expect(
      ensurePackagedTestBuildWithDependenciesForTest(
        optionsFor(fixture),
        packagedTestBuildInternalDependencies({
          promotion: {
            rename: async (source) => {
              stagingDirectory = source;
              throw nodeError("EACCES", "promotion denied");
            },
          },
          removeStagingDirectory: async (path) => {
            expect(path).toBe(stagingDirectory);
            throw cleanupFailure;
          },
        }),
      ),
    ).rejects.toBe(cleanupFailure);
  });
});

describe("packaged test build coordination", () => {

  it("resolves repository dependencies from an external generation", async () => {
    const fixture = await createFixture();
    const stateDirectory = await createRunnerStateDirectory();
    await writeFile(
      fixture.sourcePath,
      `import { dependencyValue } from "fixture-dependency";\nprocess.stdout.write(\`${"${dependencyValue}"}\\n\`);\n`,
    );

    const result = await withRunnerStateDirectory(stateDirectory, () =>
      ensurePackagedTestBuild(fixture.root),
    );
    const child = await runNodeModule(join(result.outputDirectory, "output.js"));

    expect(child).toEqual({
      code: 0,
      stdout: "resolved-from-fixture-dependency\n",
      stderr: "",
    });
  });

  it("does not add a dependency bridge to a repository-cache generation", async () => {
    const fixture = await createFixture();

    const result = await ensurePackagedTestBuild({
      ...optionsFor(fixture),
      stateDirectory: undefined,
    });

    await expect(lstat(join(result.packageRoot, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves dependencies when an internal alias points to an external generation root", async () => {
    const fixture = await createFixture();
    const externalStateDirectory = await mkdtemp(join(
      tmpdir(),
      "intentarc-packaged-external-state-",
    ));
    temporaryDirectories.push(externalStateDirectory);
    const stateAlias = join(fixture.root, "node_modules", "state-alias");
    await symlink(
      externalStateDirectory,
      stateAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      fixture.sourcePath,
      `import { dependencyValue } from "fixture-dependency";\nprocess.stdout.write(\`${"${dependencyValue}"}\\n\`);\n`,
    );

    const result = await ensurePackagedTestBuild({
      ...optionsFor(fixture),
      stateDirectory: stateAlias,
    });
    const child = await runNodeModule(join(result.outputDirectory, "output.js"));

    expect(child).toEqual({
      code: 0,
      stdout: "resolved-from-fixture-dependency\n",
      stderr: "",
    });
    const dependencyBridge = join(result.packageRoot, "node_modules");
    expect((await lstat(dependencyBridge)).isSymbolicLink()).toBe(true);
    expect(await realpath(dependencyBridge)).toBe(
      await realpath(join(fixture.root, "node_modules")),
    );
  });

  it("republishes an external generation whose dependency bridge was redirected", async () => {
    const fixture = await createFixture();
    const stateDirectory = await createRunnerStateDirectory();
    const first = await withRunnerStateDirectory(stateDirectory, () =>
      ensurePackagedTestBuild(fixture.root),
    );
    const dependencyBridge = join(first.packageRoot, "node_modules");
    const redirectedTarget = join(fixture.root, "redirected-node-modules");
    await mkdir(redirectedTarget);
    await unlink(dependencyBridge);
    await symlink(
      redirectedTarget,
      dependencyBridge,
      process.platform === "win32" ? "junction" : "dir",
    );

    const repaired = await withRunnerStateDirectory(stateDirectory, () =>
      ensurePackagedTestBuild(fixture.root),
    );

    expect(repaired).toMatchObject({
      built: true,
      packageRoot: first.packageRoot,
    });
    expect(await buildAttempts(fixture)).toHaveLength(2);
    expect((await lstat(dependencyBridge)).isSymbolicLink()).toBe(true);
    expect(await realpath(dependencyBridge)).toBe(
      await realpath(join(fixture.root, "node_modules")),
    );
  });

  it("removes external build state without changing the dependency target", async () => {
    const fixture = await createFixture();
    const stateDirectory = await createRunnerStateDirectory();
    const sentinel = join(fixture.root, "node_modules", "cleanup-sentinel.txt");
    await writeFile(sentinel, "dependency-target-is-unchanged\n");
    await withRunnerStateDirectory(stateDirectory, () =>
      ensurePackagedTestBuild(fixture.root),
    );

    await rm(stateDirectory, { recursive: true, force: true });

    expect(await readFile(sentinel, "utf8")).toBe(
      "dependency-target-is-unchanged\n",
    );
  });

  it("uses only a runner-owned temporary state root for string-form calls", async () => {
    const fixture = await createFixture();
    const temporaryRoot = await realpath(tmpdir());
    const stateDirectory = join(temporaryRoot, `intentarc-packaged-reliability-${randomUUID()}`);
    temporaryDirectories.push(stateDirectory);
    await mkdir(stateDirectory);
    const canonicalStateDirectory = await realpath(stateDirectory);
    await writeFile(
      join(stateDirectory, ".intentarc-packaged-reliability-owner.json"),
      `${JSON.stringify({
        schema: "intentarc.packaged-reliability-state/v1",
        stateDirectory: canonicalStateDirectory,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const fingerprint = await computePackagedTestBuildFingerprint({
      repositoryRoot: fixture.root,
    });
    const generation = join(stateDirectory, "generations", fingerprint);
    await mkdir(join(generation, "dist"), { recursive: true });
    await symlink(
      join(fixture.root, "node_modules"),
      join(generation, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(generation, "completed.json"),
      JSON.stringify({ fingerprint }),
    );

    const previous = process.env[packagedTestStateDirectoryEnv];
    process.env[packagedTestStateDirectoryEnv] = stateDirectory;
    try {
      const result = await ensurePackagedTestBuild(fixture.root);
      expect(result).toMatchObject({
        built: false,
        packageRoot: generation,
      });
    } finally {
      if (previous === undefined) {
        delete process.env[packagedTestStateDirectoryEnv];
      } else {
        process.env[packagedTestStateDirectoryEnv] = previous;
      }
    }
  });

  it.each([
    ["relative", "relative-state", false],
    ["repository-contained", "repository-state", false],
    ["missing-marker", "missing-marker", false],
    ["wrong-name", "not-intentarc-packaged-reliability", true],
  ])("rejects %s state roots before a build", async (_label, name, marker) => {
    const fixture = await createFixture();
    const temporaryRoot = await realpath(tmpdir());
    const stateDirectory = name === "repository-state"
      ? join(fixture.root, name)
      : join(
        temporaryRoot,
        name === "missing-marker"
          ? `intentarc-packaged-reliability-${randomUUID()}`
          : `${name}-${randomUUID()}`,
      );
    if (name !== "relative-state") await mkdir(stateDirectory);
    if (name !== "relative-state" && name !== "repository-state") {
      temporaryDirectories.push(stateDirectory);
    }
    if (marker) {
      const canonical = await realpath(stateDirectory);
      await writeFile(
        join(stateDirectory, ".intentarc-packaged-reliability-owner.json"),
        `${JSON.stringify({
          schema: "intentarc.packaged-reliability-state/v1",
          stateDirectory: canonical,
        })}\n`,
      );
    }
    const previous = process.env[packagedTestStateDirectoryEnv];
    process.env[packagedTestStateDirectoryEnv] =
      name === "relative-state" ? name : stateDirectory;
    try {
      await expect(ensurePackagedTestBuild(fixture.root)).rejects.toThrow();
      await expect(readFile(fixture.counterPath, "utf8")).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env[packagedTestStateDirectoryEnv];
      else process.env[packagedTestStateDirectoryEnv] = previous;
    }
  });

  it("rejects a symlinked runner state root before a build", async () => {
    const fixture = await createFixture();
    const temporaryRoot = await realpath(tmpdir());
    const target = await mkdtemp(join(temporaryRoot, "intentarc-target-"));
    const root = join(temporaryRoot, `intentarc-packaged-reliability-${randomUUID()}`);
    temporaryDirectories.push(target, root);
    await symlink(target, root, "junction");
    const previous = process.env[packagedTestStateDirectoryEnv];
    process.env[packagedTestStateDirectoryEnv] = root;
    try {
      await expect(ensurePackagedTestBuild(fixture.root)).rejects.toThrow();
      await expect(readFile(fixture.counterPath, "utf8")).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env[packagedTestStateDirectoryEnv];
      else process.env[packagedTestStateDirectoryEnv] = previous;
    }
  });

  it("fingerprints sorted source and config contents instead of mtimes", async () => {
    const fixture = await createFixture();
    const first = await computePackagedTestBuildFingerprint({
      repositoryRoot: fixture.root,
    });

    const future = new Date("2100-01-01T00:00:00.000Z");
    await utimes(fixture.sourcePath, future, future);
    const afterMtimeChange = await computePackagedTestBuildFingerprint({
      repositoryRoot: fixture.root,
    });

    await writeFile(fixture.sourcePath, "export const value = 2;\n");
    const afterContentChange = await computePackagedTestBuildFingerprint({
      repositoryRoot: fixture.root,
    });

    expect(afterMtimeChange).toBe(first);
    expect(afterContentChange).not.toBe(first);
  });

  it("allows one compiler after a stale claim attracts many concurrent waiters", async () => {
    const fixture = await createFixture();
    const helperModulePath = await createRunnableHelperModule();
    const options = {
      ...optionsFor(fixture),
      staleLockAfterMs: -1,
    };
    await mkdir(fixture.stateDirectory, { recursive: true });
    await writeFile(
      join(fixture.stateDirectory, "build.lock"),
      JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        startedAt: new Date(0).toISOString(),
      }),
    );

    const results = await Promise.all(
      Array.from({ length: 48 }, () =>
        runChildEnsurer(helperModulePath, options),
      ),
    );

    expect(
      results.filter(({ code, stderr }) => code !== 0 || stderr !== ""),
    ).toEqual([]);
    expect(await buildAttempts(fixture)).toHaveLength(1);
    const buildResults = results.map(({ stdout }) =>
      JSON.parse(stdout),
    ) as PackagedTestBuildResult[];
    expect(
      new Set(buildResults.map(({ outputDirectory }) => outputDirectory)).size,
    ).toBe(1);
    expect(
      buildResults.every(
        ({ packageRoot, outputDirectory }) =>
          typeof packageRoot === "string" &&
          typeof outputDirectory === "string" &&
          dirname(outputDirectory) === packageRoot,
      ),
    ).toBe(true);
  });

  it("does not publish a generation after a failed build", async () => {
    const fixture = await createFixture();
    const options = optionsFor(fixture);
    await writeFile(fixture.failureFlagPath, "");

    await expect(ensurePackagedTestBuild(options)).rejects.toThrow(
      /synthetic compiler failure/,
    );
    expect(await completedMarkers(fixture.stateDirectory)).toEqual([]);

    await unlink(fixture.failureFlagPath);
    const result = await ensurePackagedTestBuild(options);

    expect(await buildAttempts(fixture)).toHaveLength(2);
    expect(await completedMarkers(fixture.stateDirectory)).toEqual([
      join(result.packageRoot, "completed.json"),
    ]);
  });

  it("keeps a generation immutable while a later fingerprint builds", async () => {
    const fixture = await createFixture();
    const options = optionsFor(fixture);
    const first = await ensurePackagedTestBuild(options);
    const reader = runGenerationReader(first.outputDirectory);
    await expect(reader.ready).resolves.toBe(1);

    await writeFile(fixture.sourcePath, "export const value = 2;\n");
    const second = await ensurePackagedTestBuild(options);
    const readerResult = await reader.finish();

    expect(second.outputDirectory).not.toBe(first.outputDirectory);
    expect(
      await readFile(join(second.outputDirectory, "output.js"), "utf8"),
    ).toBe("export const value = 2;\n");
    expect(readerResult).toEqual({
      code: 0,
      stdout: "ready:1\nfinished:1\n",
      stderr: "",
    });
  });
});
