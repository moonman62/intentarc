#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { IntentArcService } from "../core/intentarc-service.js";
import type { ProfileCredentials } from "../domain/index.js";
import {
  createRepositoryImportTools,
  type ApplyRepositoryImportInput,
  type RepositoryImportTools,
} from "../core/repository-import-service.js";
import { importApplyResultSchema } from "../domain/import-schemas.js";
import {
  openIntentArcApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import {
  createDurabilityService,
  type DurabilityService,
} from "../durability/service.js";
import { DurabilityError } from "../durability/errors.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import { RepositoryImportError } from "../import/errors.js";
import { isMainModule } from "../system/main-module.js";
import {
  createProgram,
  formatDurabilityErrorForCli,
  formatOutboundSafetyErrorForCli,
  formatRepositoryImportErrorForCli,
  type CliOutput,
  type ConfirmationService,
} from "./program.js";

const confirmationService = {
  async confirm(message: string): Promise<boolean> {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    try {
      const answer = await terminal.question(`${message} [y/N] `);
      return /^(?:y|yes)$/i.test(answer.trim());
    } finally {
      terminal.close();
    }
  },
};

type GlobalArguments =
  | { commandArguments: string[]; databasePath: string }
  | { commandArguments: string[]; databasePath: undefined };

const hasInformationalFlag = (arguments_: readonly string[]): boolean =>
  arguments_.includes("--help") ||
  arguments_.includes("-h") ||
  arguments_.includes("--version") ||
  arguments_.includes("-V");

export type CliRoute =
  | "informational"
  | "durability"
  | "import_read"
  | "application";

export const classifyCommand = (
  arguments_: readonly string[],
): CliRoute => {
  if (hasInformationalFlag(arguments_)) {
    return "informational";
  }

  if (
    arguments_[0] === "project" &&
    arguments_[1] === "import" &&
    (arguments_[2] === "scan" || arguments_[2] === "inspect")
  ) {
    return "import_read";
  }

  return arguments_[0] === "integrity" || arguments_[0] === "backup"
    ? "durability"
    : "application";
};

const parseGlobalArguments = (arguments_: readonly string[]): GlobalArguments => {
  const commandArguments = [...arguments_];
  const dbIndex = commandArguments.findIndex(
    (argument) => argument === "--db" || argument.startsWith("--db="),
  );

  if (dbIndex === -1) {
    return { commandArguments, databasePath: undefined };
  }

  const dbArgument = commandArguments[dbIndex]!;
  const inlinePath = dbArgument.slice("--db=".length);
  const databasePath =
    dbArgument === "--db" ? commandArguments[dbIndex + 1] : inlinePath;

  if (!databasePath?.trim()) {
    return { commandArguments, databasePath: undefined };
  }

  commandArguments.splice(dbIndex, dbArgument === "--db" ? 2 : 1);

  return { commandArguments, databasePath: resolve(databasePath) };
};

const unavailableService = (): IntentArcService =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("A database is required to run this command.");
      },
    },
  ) as IntentArcService;

const unavailableDurabilityService = (): DurabilityService =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("A durability command is required.");
      },
    },
  ) as DurabilityService;

export interface RunCliDependencies {
  stdout?: CliOutput;
  stderr?: CliOutput;
  stdin?: { isTTY?: boolean };
  confirmationService?: ConfirmationService;
  createDurabilityService?: () => DurabilityService;
  createRepositoryImportTools?: () => RepositoryImportTools;
  openApplication?: typeof openIntentArcApplication;
  setExitCode?: (exitCode: number) => void;
  environment?: NodeJS.ProcessEnv;
}

const backupVerifyNeedsNoDatabase = (
  arguments_: readonly string[],
): boolean => arguments_[0] === "backup" && arguments_[1] === "verify";

const isImportApplyCommand = (
  arguments_: readonly string[],
): boolean =>
  arguments_[0] === "project" &&
  arguments_[1] === "import" &&
  arguments_[2] === "apply";

const writeJson = (stdout: CliOutput, value: unknown): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

type ProfileCredentialEnvironmentResult =
  | { valid: true; credentials: ProfileCredentials | null }
  | { valid: false };

export const readProfileCredentialEnvironment = (
  environment: NodeJS.ProcessEnv,
): ProfileCredentialEnvironmentResult => {
  const hasProfileId = environment.INTENTARC_PROFILE_ID !== undefined;
  const hasProfileToken = environment.INTENTARC_PROFILE_TOKEN !== undefined;
  if (hasProfileId !== hasProfileToken) return { valid: false };
  if (!hasProfileId) return { valid: true, credentials: null };

  const profileId = environment.INTENTARC_PROFILE_ID!.trim();
  const token = environment.INTENTARC_PROFILE_TOKEN!.trim();
  return profileId && token
    ? { valid: true, credentials: { profileId, token } }
    : { valid: false };
};

export const runCli = async (
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: RunCliDependencies = {},
): Promise<void> => {
  const globalArguments = parseGlobalArguments(arguments_);
  const route = classifyCommand(globalArguments.commandArguments);
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const environment = dependencies.environment ?? process.env;
  const confirmer = dependencies.confirmationService ?? confirmationService;
  const makeDurabilityService =
    dependencies.createDurabilityService ?? createDurabilityService;
  const makeRepositoryImportTools =
    dependencies.createRepositoryImportTools ?? createRepositoryImportTools;
  const openApplication =
    dependencies.openApplication ?? openIntentArcApplication;
  const setExitCode =
    dependencies.setExitCode ?? ((exitCode: number) => {
      process.exitCode = exitCode;
    });
  let application: IntentArcApplication | undefined;

  try {
    const profileEnvironment = readProfileCredentialEnvironment(environment);
    if (!profileEnvironment.valid) {
      stderr.write("Invalid command input.\n");
      setExitCode(2);
      return;
    }
    const profileCredentials = profileEnvironment.credentials;
    const databaseRequired =
      route === "application" ||
      (route === "durability" &&
        !backupVerifyNeedsNoDatabase(globalArguments.commandArguments));
    if (!globalArguments.databasePath && databaseRequired) {
      stderr.write("Invalid command input.\n");
      setExitCode(2);
      return;
    }

    if (isImportApplyCommand(globalArguments.commandArguments)) {
      let prepared: ApplyRepositoryImportInput | undefined;
      const preflightProgram = createProgram({
        service: unavailableService(),
        repositoryImportTools: makeRepositoryImportTools(),
        databasePath: globalArguments.databasePath!,
        stdout,
        stderr,
        stdin,
        confirmationService: confirmer,
        onPreparedImportApply: (input) => {
          prepared = input;
        },
        profileCredentials,
      });
      await preflightProgram.parseAsync(
        globalArguments.commandArguments,
        { from: "user" },
      );
      if (prepared === undefined) return;

      application = await openApplication({
        databasePath: globalArguments.databasePath!,
      });
      writeJson(
        stdout,
        importApplyResultSchema.parse(
          application.service.imports.apply(prepared),
        ),
      );
      return;
    }

    let service = unavailableService();
    let durabilityService = unavailableDurabilityService();
    let repositoryImportTools: RepositoryImportTools | undefined;
    if (route === "application") {
      application = await openApplication({
        databasePath: globalArguments.databasePath!,
      });
      service = application.service;
      repositoryImportTools = service.imports;
    } else if (route === "durability") {
      durabilityService = makeDurabilityService();
    } else if (route === "import_read") {
      repositoryImportTools = makeRepositoryImportTools();
    }

    const program = createProgram({
      service,
      ...(repositoryImportTools === undefined
        ? {}
        : { repositoryImportTools }),
      durabilityService,
      ...(globalArguments.databasePath === undefined
        ? {}
        : { databasePath: globalArguments.databasePath }),
      stdout,
      stderr,
      stdin,
      confirmationService: confirmer,
      profileCredentials,
    });

    await program.parseAsync(globalArguments.commandArguments, { from: "user" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "exitCode" in error) {
      const exitCode = error.exitCode;

      setExitCode(typeof exitCode === "number" ? exitCode : 1);
      return;
    }

    stderr.write(
      error instanceof DurabilityError
        ? `${formatDurabilityErrorForCli(error)}\n`
        : error instanceof OutboundSafetyError
          ? `${formatOutboundSafetyErrorForCli(error) ?? "Command failed."}\n`
        : error instanceof RepositoryImportError
          ? `${formatRepositoryImportErrorForCli(error) ?? "Command failed."}\n`
        : "Command failed.\n",
    );
    setExitCode(1);
  } finally {
    application?.close();
  }
};

if (isMainModule(process.argv[1], import.meta.url)) {
  void runCli();
}
