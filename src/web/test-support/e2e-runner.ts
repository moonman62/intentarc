import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertRepositorySourceUnchanged,
  captureRepositorySource,
  type RepositorySourceSnapshot,
} from "../../test-support/repository-source-snapshot.js";
import {
  createStructuredBrowserRepository,
  seedBrowserDatabase,
} from "./e2e-fixture.js";

const DATABASE_DIRECTORY_ENV = "INTENTARC_E2E_DATABASE_DIRECTORY";
const OWNER_ENV = "INTENTARC_E2E_OWNER";
const OWNER_MARKER = ".intentarc-e2e-owner";
const OWNED_DIRECTORY_PATTERN = /^intentarc-e2e-[A-Za-z0-9]{6}$/;
const STRUCTURED_REPOSITORY_ENV = "INTENTARC_E2E_STRUCTURED_REPOSITORY";
const STRUCTURED_REPOSITORY_PATTERN = /^intentarc repository fixture [A-Za-z0-9]{6}$/;
const STRUCTURED_SNAPSHOT_FILE = "structured-repository-snapshot.json";

type OwnedDirectory = {
  readonly directory: string;
  readonly owner: string;
};

type RunOwnedE2eProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly port: number | null;
  readonly stdio?: "inherit" | "pipe";
  readonly structuredKnowledgeFixture?: boolean;
  readonly onStructuredRepositoryCreated?: (root: string) => void;
};

export type OwnedE2eProcessResult = {
  readonly databaseDirectory: string;
  readonly exitCode: number;
  readonly structuredRepositoryPath?: string;
};

const createOwnedDirectory = (): OwnedDirectory => {
  const directory = mkdtempSync(path.join(tmpdir(), "intentarc-e2e-"));
  const owner = randomUUID();
  writeFileSync(path.join(directory, OWNER_MARKER), owner, {
    encoding: "utf8",
    flag: "wx",
  });
  return { directory, owner };
};

const verifiedOwnedDirectory = (
  directory: string,
  owner: string,
): string => {
  const resolvedTempRoot = realpathSync.native(tmpdir());
  const resolvedDirectory = realpathSync.native(directory);
  const stats = lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    path.dirname(resolvedDirectory) !== resolvedTempRoot ||
    !OWNED_DIRECTORY_PATTERN.test(path.basename(resolvedDirectory))
  ) {
    throw new Error("Refusing to use an unverified end-to-end directory.");
  }
  const recordedOwner = readFileSync(
    path.join(resolvedDirectory, OWNER_MARKER),
    "utf8",
  );
  if (recordedOwner !== owner) {
    throw new Error(
      "Refusing to remove an end-to-end directory with a mismatched ownership marker.",
    );
  }
  return resolvedDirectory;
};

const removeOwnedDirectory = ({ directory, owner }: OwnedDirectory): void => {
  if (!existsSync(directory)) return;
  rmSync(verifiedOwnedDirectory(directory, owner), {
    recursive: true,
    force: false,
  });
};

const isPortOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });

const waitForPortToClose = async (
  port: number,
  timeoutMilliseconds = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (await isPortOpen(port)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `End-to-end server port ${port} remained open after Playwright exited.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const runChild = (
  options: RunOwnedE2eProcessOptions,
  environment: NodeJS.ProcessEnv,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      env: environment,
      shell: false,
      stdio: options.stdio ?? "pipe",
      windowsHide: true,
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const removeSignalHandlers = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("close", (code) => {
      removeSignalHandlers();
      resolve(code ?? 1);
    });
  });

export const ownedE2eDatabaseFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): { readonly directory: string; readonly path: string } => {
  const directory = environment[DATABASE_DIRECTORY_ENV];
  const owner = environment[OWNER_ENV];
  if (!directory || !owner) {
    throw new Error(
      "The end-to-end server must be started by the owned Playwright runner.",
    );
  }
  const verifiedDirectory = verifiedOwnedDirectory(directory, owner);
  return {
    directory: verifiedDirectory,
    path: path.join(verifiedDirectory, "intentarc.sqlite"),
  };
};

export const ownedE2eStructuredRepositoryFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly root: string;
  readonly snapshotPath: string;
} => {
  const root = environment[STRUCTURED_REPOSITORY_ENV];
  if (!root) throw new Error("The structured E2E repository was not provided by the runner.");
  const cacheRoot = realpathSync.native(path.resolve(
    "node_modules",
    ".cache",
    "intentarc-structured-e2e",
  ));
  const resolvedRoot = realpathSync.native(root);
  const stats = lstatSync(resolvedRoot);
  if (
    !path.isAbsolute(root) ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    path.dirname(resolvedRoot) !== cacheRoot ||
    !STRUCTURED_REPOSITORY_PATTERN.test(path.basename(resolvedRoot))
  ) {
    throw new Error("Refusing an unverified structured E2E repository.");
  }
  const { directory } = ownedE2eDatabaseFromEnvironment(environment);
  const snapshotPath = path.join(directory, STRUCTURED_SNAPSHOT_FILE);
  return {
    root: resolvedRoot,
    snapshotPath,
  };
};

export const runOwnedE2eProcess = async (
  options: RunOwnedE2eProcessOptions,
): Promise<OwnedE2eProcessResult> => {
  const ownedDirectory = createOwnedDirectory();
  let structuredRepository: ReturnType<typeof createStructuredBrowserRepository> | null = null;
  let structuredRepositoryPath: string | undefined;
  let exitCode = 1;
  try {
    structuredRepository = options.structuredKnowledgeFixture
      ? createStructuredBrowserRepository()
      : null;
    structuredRepositoryPath = structuredRepository?.root;
    if (structuredRepository) {
      options.onStructuredRepositoryCreated?.(structuredRepository.root);
      await seedBrowserDatabase(
        path.join(ownedDirectory.directory, "intentarc.sqlite"),
        structuredRepository,
      );
      writeFileSync(
        path.join(ownedDirectory.directory, STRUCTURED_SNAPSHOT_FILE),
        JSON.stringify(captureRepositorySource(structuredRepository.root)),
        { encoding: "utf8", flag: "wx" },
      );
    }
    exitCode = await runChild(options, {
      ...process.env,
      [DATABASE_DIRECTORY_ENV]: ownedDirectory.directory,
      [OWNER_ENV]: ownedDirectory.owner,
      ...(structuredRepository
        ? { [STRUCTURED_REPOSITORY_ENV]: structuredRepository.root }
        : {}),
    });
    if (options.port !== null) {
      await waitForPortToClose(options.port);
    }
    if (structuredRepository) {
      const expected = JSON.parse(readFileSync(
        path.join(ownedDirectory.directory, STRUCTURED_SNAPSHOT_FILE),
        "utf8",
      )) as RepositorySourceSnapshot;
      try {
        assertRepositorySourceUnchanged(structuredRepository.root, expected);
      } catch (error) {
        throw new Error(
          "Structured end-to-end execution changed repository or Git state.",
          { cause: error },
        );
      }
    }
  } finally {
    try {
      structuredRepository?.cleanup();
    } finally {
      removeOwnedDirectory(ownedDirectory);
    }
  }
  return {
    databaseDirectory: ownedDirectory.directory,
    exitCode,
    ...(structuredRepositoryPath ? { structuredRepositoryPath } : {}),
  };
};

const isEntrypoint = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const result = await runOwnedE2eProcess({
    command: process.execPath,
    args: [
      path.resolve("node_modules", "@playwright", "test", "cli.js"),
      "test",
      ...process.argv.slice(2),
    ],
    port: 47_862,
    stdio: "inherit",
    structuredKnowledgeFixture: true,
  }).catch((error: unknown) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : "End-to-end runner failed"
      }\n`,
    );
    return { exitCode: 1 };
  });
  process.exitCode = result.exitCode;
}
