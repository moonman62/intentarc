import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const defaultRootFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
] as const;
const defaultWaitTimeoutMs = 25_000;
const databaseContentionSliceMs = 100;
const stateCheckIntervalMs = 250;
const packagedReliabilityMarker = ".intentarc-packaged-reliability-owner.json";
const packagedReliabilityStatePattern =
  /^intentarc-packaged-reliability-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PACKAGED_TEST_STATE_DIRECTORY_ENV =
  "INTENTARC_PACKAGED_TEST_STATE_DIRECTORY";

export type PackagedTestBuildCommand = {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
};

export type PackagedTestBuildFingerprintOptions = {
  readonly repositoryRoot: string;
  readonly sourceDirectory?: string;
  readonly rootFiles?: readonly string[];
};

export type PackagedTestBuildOptions = PackagedTestBuildFingerprintOptions & {
  readonly stateDirectory?: string;
  readonly buildCommand?: PackagedTestBuildCommand;
  readonly waitTimeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type PackagedTestBuildResult = {
  readonly built: boolean;
  readonly fingerprint: string;
  readonly packageRoot: string;
  readonly outputDirectory: string;
};

type BuildMarker = {
  readonly fingerprint: string;
};

type GenerationPaths = {
  readonly packageRoot: string;
  readonly outputDirectory: string;
  readonly marker: string;
};

interface PackagedGenerationPromotionPathInfo {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface PackagedGenerationPromotionDependencies {
  readonly platform: NodeJS.Platform;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<PackagedGenerationPromotionPathInfo>;
  readonly realpath: (path: string) => Promise<string>;
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface PackagedGenerationPromotionPathIdentity {
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface PackagedGenerationPromotionBaseline {
  readonly generationsDirectory: PackagedGenerationPromotionPathIdentity;
  readonly stagingDirectory: PackagedGenerationPromotionPathIdentity;
}

export interface PackagedGenerationPromotionInput {
  readonly generationsDirectory: string;
  readonly stagingDirectory: string;
  readonly generationDirectory: string;
  readonly baseline: PackagedGenerationPromotionBaseline;
  readonly isBuildTransactionActive: () => boolean;
  readonly verifyPromotedGeneration: () => Promise<boolean>;
  readonly signal?: AbortSignal;
}

type StatePaths = {
  readonly directory: string;
  readonly database: string;
  readonly generations: string;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error;

const hasCode = (error: unknown, code: string): boolean =>
  isNodeError(error) && error.code === code;

const isMissing = (error: unknown): boolean =>
  isNodeError(error) && error.code === "ENOENT";

const packagedGenerationPromotionWaits = [
  25,
  50,
  100,
  200,
  400,
  400,
  400,
] as const;
const packagedGenerationPromotionDeadlineMs = 2_000;

const waitForPackagedGenerationPromotion = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(signal.reason);
      return;
    }

    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectWait(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const defaultPackagedGenerationPromotionDependencies: PackagedGenerationPromotionDependencies =
  {
    platform: process.platform,
    rename,
    lstat: (path) => lstat(path, { bigint: true }),
    realpath,
    now: () => performance.now(),
    wait: waitForPackagedGenerationPromotion,
  };

interface PackagedTestBuildInternalDependencies {
  readonly promotion: PackagedGenerationPromotionDependencies;
  readonly removeStagingDirectory: (path: string) => Promise<void>;
}

const defaultPackagedTestBuildInternalDependencies:
  PackagedTestBuildInternalDependencies = {
    promotion: defaultPackagedGenerationPromotionDependencies,
    removeStagingDirectory: (path) => rm(path, { recursive: true, force: true }),
  };

const packagedGenerationPromotionCanonicalEqual = (
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean =>
  platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

const capturePackagedGenerationPromotionPathIdentityWith = async (
  path: string,
  label: string,
  dependencies: Pick<
    PackagedGenerationPromotionDependencies,
    "lstat" | "realpath"
  >,
): Promise<PackagedGenerationPromotionPathIdentity> => {
  let details: PackagedGenerationPromotionPathInfo;
  try {
    details = await dependencies.lstat(path);
  } catch (error) {
    throw new Error(`Packaged generation ${label} could not be inspected.`, {
      cause: error,
    });
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(
      `Packaged generation ${label} is not an ordinary directory.`,
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = await dependencies.realpath(path);
  } catch (error) {
    throw new Error(
      `Packaged generation ${label} canonical path could not be resolved.`,
      { cause: error },
    );
  }
  return {
    canonicalPath,
    dev: details.dev,
    ino: details.ino,
  };
};

export const capturePackagedGenerationPromotionPathIdentity = async (
  path: string,
  label: string,
): Promise<PackagedGenerationPromotionPathIdentity> =>
  capturePackagedGenerationPromotionPathIdentityWith(
    path,
    label,
    defaultPackagedGenerationPromotionDependencies,
  );

const provePackagedGenerationPromotionIdentity = (
  actual: PackagedGenerationPromotionPathIdentity,
  expected: PackagedGenerationPromotionPathIdentity,
  label: string,
  platform: NodeJS.Platform,
): void => {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    !packagedGenerationPromotionCanonicalEqual(
      actual.canonicalPath,
      expected.canonicalPath,
      platform,
    )
  ) {
    throw new Error(`Packaged generation ${label} identity changed.`);
  }
};

const isExactPackagedGenerationPromotionDirectChild = (
  parent: string,
  child: string,
  platform: NodeJS.Platform,
): boolean => {
  const childBasename = basename(child);
  return (
    childBasename.length > 0 &&
    childBasename !== "." &&
    childBasename !== ".." &&
    packagedGenerationPromotionCanonicalEqual(
      join(parent, childBasename),
      child,
      platform,
    )
  );
};

const expectedPackagedGenerationPromotionDestination = (
  input: PackagedGenerationPromotionInput,
): string =>
  join(
    input.baseline.generationsDirectory.canonicalPath,
    basename(input.generationDirectory),
  );

const provePackagedGenerationPromotionDestinationAbsent = async (
  destination: string,
  dependencies: Pick<PackagedGenerationPromotionDependencies, "lstat">,
): Promise<void> => {
  try {
    await dependencies.lstat(destination);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw new Error(
      "Packaged generation promotion destination absence is ambiguous.",
      { cause: error },
    );
  }
  throw new Error("Packaged generation promotion destination already exists.");
};

const provePackagedGenerationPromotion = async (
  input: PackagedGenerationPromotionInput,
  dependencies: PackagedGenerationPromotionDependencies,
): Promise<void> => {
  if (!input.isBuildTransactionActive()) {
    throw new Error(
      "Packaged generation promotion requires an active build transaction.",
    );
  }

  const generationsDirectory =
    await capturePackagedGenerationPromotionPathIdentityWith(
      input.generationsDirectory,
      "parent",
      dependencies,
    );
  provePackagedGenerationPromotionIdentity(
    generationsDirectory,
    input.baseline.generationsDirectory,
    "parent",
    dependencies.platform,
  );

  const stagingDirectory =
    await capturePackagedGenerationPromotionPathIdentityWith(
      input.stagingDirectory,
      "staging directory",
      dependencies,
    );
  provePackagedGenerationPromotionIdentity(
    stagingDirectory,
    input.baseline.stagingDirectory,
    "staging directory",
    dependencies.platform,
  );

  const expectedStagingDirectory = join(
    input.baseline.generationsDirectory.canonicalPath,
    basename(input.stagingDirectory),
  );
  if (
    !packagedGenerationPromotionCanonicalEqual(
      input.generationsDirectory,
      input.baseline.generationsDirectory.canonicalPath,
      dependencies.platform,
    ) ||
    !isExactPackagedGenerationPromotionDirectChild(
      input.baseline.generationsDirectory.canonicalPath,
      input.stagingDirectory,
      dependencies.platform,
    ) ||
    !packagedGenerationPromotionCanonicalEqual(
      input.baseline.stagingDirectory.canonicalPath,
      expectedStagingDirectory,
      dependencies.platform,
    )
  ) {
    throw new Error(
      "Packaged generation staging directory containment changed.",
    );
  }

  const expectedDestination =
    expectedPackagedGenerationPromotionDestination(input);
  if (
    !isExactPackagedGenerationPromotionDirectChild(
      input.baseline.generationsDirectory.canonicalPath,
      input.generationDirectory,
      dependencies.platform,
    ) ||
    !packagedGenerationPromotionCanonicalEqual(
      input.generationDirectory,
      expectedDestination,
      dependencies.platform,
    )
  ) {
    throw new Error(
      "Packaged generation promotion destination is not an exact direct child.",
    );
  }
  await provePackagedGenerationPromotionDestinationAbsent(
    input.generationDirectory,
    dependencies,
  );
};

const provePromotedPackagedGeneration = async (
  input: PackagedGenerationPromotionInput,
  dependencies: PackagedGenerationPromotionDependencies,
): Promise<void> => {
  let sourceIsMissing = false;
  try {
    await dependencies.lstat(input.stagingDirectory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      sourceIsMissing = true;
    } else {
      throw new Error(
        "Packaged generation promotion source absence is ambiguous.",
        { cause: error },
      );
    }
  }
  if (!sourceIsMissing) {
    throw new Error(
      "Packaged generation promotion source persisted after rename.",
    );
  }

  const destination =
    await capturePackagedGenerationPromotionPathIdentityWith(
      input.generationDirectory,
      "promoted destination",
      dependencies,
    );
  if (
    destination.dev !== input.baseline.stagingDirectory.dev ||
    destination.ino !== input.baseline.stagingDirectory.ino
  ) {
    throw new Error(
      "Promoted packaged generation did not preserve staging identity.",
    );
  }
  const expectedDestination =
    expectedPackagedGenerationPromotionDestination(input);
  if (
    !isExactPackagedGenerationPromotionDirectChild(
      input.baseline.generationsDirectory.canonicalPath,
      expectedDestination,
      dependencies.platform,
    ) ||
    !packagedGenerationPromotionCanonicalEqual(
      destination.canonicalPath,
      expectedDestination,
      dependencies.platform,
    )
  ) {
    throw new Error(
      "Promoted packaged generation canonical destination changed.",
    );
  }
};

const throwIfPackagedGenerationPromotionAborted = (
  signal?: AbortSignal,
): void => signal?.throwIfAborted();

export const promotePackagedGeneration = async (
  input: PackagedGenerationPromotionInput,
  dependencies: PackagedGenerationPromotionDependencies =
    defaultPackagedGenerationPromotionDependencies,
): Promise<void> => {
  const deadline = dependencies.now() + packagedGenerationPromotionDeadlineMs;
  let firstError: unknown;

  for (
    let attempt = 0;
    attempt <= packagedGenerationPromotionWaits.length;
    attempt += 1
  ) {
    throwIfPackagedGenerationPromotionAborted(input.signal);
    await provePackagedGenerationPromotion(input, dependencies);
    throwIfPackagedGenerationPromotionAborted(input.signal);
    if (dependencies.now() >= deadline) {
      if (firstError !== undefined) throw firstError;
      throw new Error(
        "Packaged generation promotion deadline elapsed before rename.",
      );
    }
    try {
      await dependencies.rename(
        input.stagingDirectory,
        input.generationDirectory,
      );
    } catch (error) {
      if (dependencies.platform !== "win32" || !hasCode(error, "EPERM")) {
        throw error;
      }
      firstError ??= error;
      if (attempt === packagedGenerationPromotionWaits.length) throw firstError;
      const remaining = deadline - dependencies.now();
      if (remaining <= 0) throw firstError;
      await dependencies.wait(
        Math.min(packagedGenerationPromotionWaits[attempt]!, remaining),
        input.signal,
      );
      throwIfPackagedGenerationPromotionAborted(input.signal);
      if (dependencies.now() >= deadline) throw firstError;
      continue;
    }
    await provePromotedPackagedGeneration(input, dependencies);
    if (!(await input.verifyPromotedGeneration())) {
      throw new Error(
        "Promoted packaged generation failed completeness verification.",
      );
    }
    return;
  }
  throw firstError;
};

const isContainedDirectory = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return (
    path.length > 0 &&
    path !== ".." &&
    !path.startsWith("..\\") &&
    !path.startsWith("../")
  );
};

const canonicalEqual = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;

const runnerMarkerContent = (canonicalStateDirectory: string): string =>
  `${JSON.stringify({
    schema: "intentarc.packaged-reliability-state/v1",
    stateDirectory: canonicalStateDirectory,
  })}\n`;

const validateRunnerStateDirectory = async (
  configuredDirectory: string,
): Promise<string> => {
  if (!isAbsolute(configuredDirectory)) {
    throw new Error("Packaged reliability state directory must be absolute.");
  }
  const configuredDetails = await lstat(configuredDirectory);
  if (!configuredDetails.isDirectory() || configuredDetails.isSymbolicLink()) {
    throw new Error("Packaged reliability state directory is not ordinary.");
  }
  const temporaryRoot = await realpath(tmpdir());
  const canonicalStateDirectory = await realpath(configuredDirectory);
  if (
    !canonicalEqual(configuredDirectory, canonicalStateDirectory) ||
    !isContainedDirectory(temporaryRoot, canonicalStateDirectory) ||
    !packagedReliabilityStatePattern.test(basename(canonicalStateDirectory))
  ) {
    throw new Error("Packaged reliability state directory is unsafe.");
  }
  const marker = join(canonicalStateDirectory, packagedReliabilityMarker);
  const markerDetails = await lstat(marker);
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink()) {
    throw new Error("Packaged reliability state marker is not ordinary.");
  }
  if ((await readFile(marker, "utf8")) !== runnerMarkerContent(canonicalStateDirectory)) {
    throw new Error("Packaged reliability state marker does not match its root.");
  }
  return canonicalStateDirectory;
};

const stableCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeRelativePath = (path: string): string =>
  path.replaceAll("\\", "/");

const listFiles = async (directory: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    stableCompare(left.name, right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
};

const existingRootFiles = async (
  repositoryRoot: string,
  rootFiles: readonly string[],
): Promise<string[]> => {
  const paths: string[] = [];
  for (const rootFile of rootFiles) {
    const path = resolve(repositoryRoot, rootFile);
    try {
      if ((await stat(path)).isFile()) paths.push(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return paths;
};

export const computePackagedTestBuildFingerprint = async ({
  repositoryRoot,
  sourceDirectory = "src",
  rootFiles = defaultRootFiles,
}: PackagedTestBuildFingerprintOptions): Promise<string> => {
  const canonicalRoot = await realpath(repositoryRoot);
  const sourcePath = isAbsolute(sourceDirectory)
    ? sourceDirectory
    : resolve(canonicalRoot, sourceDirectory);
  const files = [
    ...(await listFiles(sourcePath)),
    ...(await existingRootFiles(canonicalRoot, rootFiles)),
  ]
    .filter((path, index, allPaths) => allPaths.indexOf(path) === index)
    .sort((left, right) =>
      stableCompare(
        normalizeRelativePath(relative(canonicalRoot, left)),
        normalizeRelativePath(relative(canonicalRoot, right)),
      ),
    );

  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(normalizeRelativePath(relative(canonicalRoot, path)));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const statePathsFor = async (
  repositoryRoot: string,
  stateDirectory?: string,
): Promise<StatePaths> => {
  const canonicalRoot = await realpath(repositoryRoot);
  const rootKey = createHash("sha256")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 24);
  const directory =
    stateDirectory === undefined
      ? join(
          canonicalRoot,
          "node_modules",
          ".cache",
          "intentarc-packaged-test-build",
          rootKey,
        )
      : isAbsolute(stateDirectory)
        ? stateDirectory
        : resolve(canonicalRoot, stateDirectory);
  return {
    directory,
    database: join(directory, "coordination.sqlite"),
    generations: join(directory, "generations"),
  };
};

const generationPathsFor = (
  generationsDirectory: string,
  fingerprint: string,
): GenerationPaths => {
  const packageRoot = join(generationsDirectory, fingerprint);
  return {
    packageRoot,
    outputDirectory: join(packageRoot, "dist"),
    marker: join(packageRoot, "completed.json"),
  };
};

const dependencyTargetFor = async (
  repositoryRoot: string,
  generationsDirectory: string,
): Promise<string | undefined> => {
  const canonicalRoot = await realpath(repositoryRoot);
  const dependencyDirectory = join(canonicalRoot, "node_modules");
  if (isContainedDirectory(dependencyDirectory, generationsDirectory)) {
    return undefined;
  }

  const details = await lstat(dependencyDirectory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Repository node_modules directory is not ordinary.");
  }
  return realpath(dependencyDirectory);
};

const readTextIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const generationIsComplete = async (
  generation: GenerationPaths,
  fingerprint: string,
  dependencyTarget?: string,
): Promise<boolean> => {
  const markerSource = await readTextIfPresent(generation.marker);
  if (markerSource === undefined) return false;
  try {
    const marker = JSON.parse(markerSource) as Partial<BuildMarker>;
    if (
      marker.fingerprint !== fingerprint ||
      !(await stat(generation.outputDirectory)).isDirectory()
    ) {
      return false;
    }
    if (dependencyTarget === undefined) return true;
    const dependencyBridge = join(generation.packageRoot, "node_modules");
    return (
      (await lstat(dependencyBridge)).isSymbolicLink() &&
      canonicalEqual(await realpath(dependencyBridge), dependencyTarget)
    );
  } catch {
    return false;
  }
};

const waitForStateChange = async (
  directory: string,
  maximumWaitMs: number,
): Promise<void> =>
  new Promise((resolveWait) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolveWait();
    };
    const timer = setTimeout(finish, maximumWaitMs);
    try {
      watcher = watch(directory, { persistent: false }, finish);
    } catch {
      // The bounded timer polls again when a filesystem watch is unavailable.
    }
  });

const isDatabaseBusy = (error: unknown): boolean =>
  isNodeError(error) &&
  (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");

const acquireBuildTransaction = (database: Database.Database): boolean => {
  try {
    database.exec("BEGIN IMMEDIATE");
    return true;
  } catch (error) {
    if (isDatabaseBusy(error)) return false;
    throw error;
  }
};

const runBuildCommand = async (
  command: PackagedTestBuildCommand,
  outputDirectory: string,
): Promise<void> =>
  new Promise((resolveBuild, reject) => {
    const child = spawn(command.command, command.arguments, {
      cwd: command.cwd,
      env: {
        ...process.env,
        INTENTARC_PACKAGED_TEST_OUTPUT_DIRECTORY: outputDirectory,
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(
        new Error(`Packaged test build could not start: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      const output = [stderr.trim(), stdout.trim()]
        .filter((value) => value.length > 0)
        .join("\n");
      const status =
        code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      reject(
        new Error(
          `Packaged test build failed with ${status}${output ? `:\n${output}` : ""}`,
        ),
      );
    });
  });

const removeInvalidGeneration = async (
  generation: GenerationPaths,
): Promise<void> => {
  try {
    await stat(generation.packageRoot);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const quarantinedPath = `${generation.packageRoot}.invalid-${randomUUID()}`;
  await rename(generation.packageRoot, quarantinedPath);
  await rm(quarantinedPath, { recursive: true, force: true });
};

const buildGeneration = async (
  options: PackagedTestBuildOptions,
  statePaths: StatePaths,
  fingerprint: string,
  dependencyTarget: string | undefined,
  database: Database.Database,
  generationsIdentity: PackagedGenerationPromotionPathIdentity,
  dependencies: PackagedTestBuildInternalDependencies,
): Promise<GenerationPaths> => {
  void statePaths;
  const canonicalGenerationsDirectory = generationsIdentity.canonicalPath;
  const generation = generationPathsFor(
    canonicalGenerationsDirectory,
    fingerprint,
  );
  await removeInvalidGeneration(generation);

  const stagingRoot = join(
    canonicalGenerationsDirectory,
    `${fingerprint}.staging-${randomUUID()}`,
  );
  const stagingOutput = join(stagingRoot, "dist");
  await mkdir(stagingRoot);
  try {
    const buildCommand = options.buildCommand ?? {
      command: process.execPath,
      arguments: [
        join(
          options.repositoryRoot,
          "node_modules",
          "typescript",
          "bin",
          "tsc",
        ),
        "-p",
        "tsconfig.json",
        "--outDir",
        stagingOutput,
      ],
      cwd: options.repositoryRoot,
    };
    await runBuildCommand(buildCommand, stagingOutput);
    if (!(await stat(stagingOutput)).isDirectory()) {
      throw new Error(
        "Packaged test build completed without producing its output directory",
      );
    }

    const completedFingerprint =
      await computePackagedTestBuildFingerprint(options);
    if (completedFingerprint !== fingerprint) {
      throw new Error(
        "Packaged test sources changed while the shared build was running",
      );
    }

    await copyFile(
      join(options.repositoryRoot, "package.json"),
      join(stagingRoot, "package.json"),
    );
    if (dependencyTarget !== undefined) {
      await symlink(
        dependencyTarget,
        join(stagingRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await writeFile(
      join(stagingRoot, "completed.json"),
      JSON.stringify({ fingerprint } satisfies BuildMarker),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const stagingIdentity =
      await capturePackagedGenerationPromotionPathIdentityWith(
        stagingRoot,
        "staging directory",
        dependencies.promotion,
      );
    await promotePackagedGeneration(
      {
        generationsDirectory: canonicalGenerationsDirectory,
        stagingDirectory: stagingRoot,
        generationDirectory: generation.packageRoot,
        baseline: {
          generationsDirectory: generationsIdentity,
          stagingDirectory: stagingIdentity,
        },
        isBuildTransactionActive: () => database.inTransaction,
        verifyPromotedGeneration: () =>
          generationIsComplete(generation, fingerprint, dependencyTarget),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      dependencies.promotion,
    );
    return generation;
  } catch (error) {
    await dependencies.removeStagingDirectory(stagingRoot);
    throw error;
  }
};

const normalizedOptions = (
  input: string | PackagedTestBuildOptions,
): PackagedTestBuildOptions =>
  typeof input === "string" ? { repositoryRoot: input } : input;

const ensurePackagedTestBuildInternal = async (
  input: string | PackagedTestBuildOptions,
  dependencies: PackagedTestBuildInternalDependencies,
): Promise<PackagedTestBuildResult> => {
  const options = normalizedOptions(input);
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const environmentStateDirectory =
    typeof input === "string"
      ? process.env[PACKAGED_TEST_STATE_DIRECTORY_ENV]
      : undefined;
  const runnerStateDirectory = environmentStateDirectory === undefined
    ? undefined
    : await validateRunnerStateDirectory(environmentStateDirectory);
  const statePaths = await statePathsFor(
    options.repositoryRoot,
    runnerStateDirectory ?? options.stateDirectory,
  );
  await mkdir(statePaths.generations, { recursive: true });
  const generationsDetails = await lstat(statePaths.generations);
  if (!generationsDetails.isDirectory() || generationsDetails.isSymbolicLink()) {
    throw new Error("Packaged test generations directory is not ordinary.");
  }
  const generationsIdentity =
    await capturePackagedGenerationPromotionPathIdentityWith(
      statePaths.generations,
      "parent",
      dependencies.promotion,
    );
  const canonicalGenerationsDirectory = generationsIdentity.canonicalPath;
  const dependencyTarget = await dependencyTargetFor(
    options.repositoryRoot,
    canonicalGenerationsDirectory,
  );
  const deadline = performance.now() + waitTimeoutMs;

  while (true) {
    const fingerprint = await computePackagedTestBuildFingerprint(options);
    const generation = generationPathsFor(
      canonicalGenerationsDirectory,
      fingerprint,
    );
    if (
      await generationIsComplete(generation, fingerprint, dependencyTarget)
    ) {
      return { built: false, fingerprint, ...generation };
    }

    const database = new Database(statePaths.database, {
      timeout: databaseContentionSliceMs,
    });
    try {
      if (!acquireBuildTransaction(database)) {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          throw new Error(
            `Timed out waiting ${waitTimeoutMs}ms for the shared packaged test build`,
          );
        }
        await waitForStateChange(
          statePaths.directory,
          Math.min(stateCheckIntervalMs, remainingMs),
        );
        continue;
      }

      try {
        const lockedFingerprint =
          await computePackagedTestBuildFingerprint(options);
        const lockedGeneration = generationPathsFor(
          canonicalGenerationsDirectory,
          lockedFingerprint,
        );
        if (
          await generationIsComplete(
            lockedGeneration,
            lockedFingerprint,
            dependencyTarget,
          )
        ) {
          database.exec("COMMIT");
          return {
            built: false,
            fingerprint: lockedFingerprint,
            ...lockedGeneration,
          };
        }

        const completedGeneration = await buildGeneration(
          options,
          statePaths,
          lockedFingerprint,
          dependencyTarget,
          database,
          generationsIdentity,
          dependencies,
        );
        database.exec("COMMIT");
        return {
          built: true,
          fingerprint: lockedFingerprint,
          ...completedGeneration,
        };
      } catch (error) {
        if (database.inTransaction) database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }
};

export const ensurePackagedTestBuildWithDependenciesForTest = (
  input: string | PackagedTestBuildOptions,
  dependencies: PackagedTestBuildInternalDependencies,
): Promise<PackagedTestBuildResult> =>
  ensurePackagedTestBuildInternal(input, dependencies);

export const ensurePackagedTestBuild = (
  input: string | PackagedTestBuildOptions,
): Promise<PackagedTestBuildResult> =>
  ensurePackagedTestBuildInternal(
    input,
    defaultPackagedTestBuildInternalDependencies,
  );
