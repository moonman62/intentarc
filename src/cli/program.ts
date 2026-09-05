import { Command } from "commander";
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  acceptedDelegationResultMatches,
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  checkpointResultMatches,
  checkpointResultSchema,
  claimTaskInputSchema,
  claimTaskResultMatches,
  claimTaskResultSchema,
  changeOperationTypeSchema,
  coordinationStateInputSchema,
  coordinationStateMatches,
  coordinationStateSchema,
  createProjectInputSchema,
  createDelegationInputSchema,
  createdDelegationResultMatches,
  createProfileInputSchema,
  createRecordInputSchema,
  createRelationshipInputSchema,
  delegationResultSchema,
  humanRecordUpdateInputSchema,
  listReadyTasksInputSchema,
  proposalFilterSchema,
  readyTaskPageSchema,
  readyTaskPageMatches,
  recordKindSchema,
  relationshipKindSchema,
  renewClaimInputSchema,
  renewClaimResultMatches,
  renewClaimResultSchema,
  revokeDelegationInputSchema,
  revokedDelegationResultMatches,
  setAuthorityInputSchema,
  submissionResultSchema,
  submissionResultMatches,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  switchTaskResultMatches,
  switchTaskResultSchema,
  transitionClaimInputSchema,
  transitionClaimResultMatches,
  transitionClaimResultSchema,
  type AuthenticatedProfile,
  type ProfileCredentials,
  type TaskClaim,
  type TaskDelegation,
} from "../domain/index.js";
import {
  CoordinationError,
  GovernanceError,
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  RelationshipAlreadyExistsError,
} from "../domain/errors.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import type { ProjectConstrainedCoordinationService } from "../core/coordination-service.js";
import type {
  ApplyRepositoryImportInput,
  RepositoryImportTools,
} from "../core/repository-import-service.js";
import { DurabilityError } from "../durability/errors.js";
import type { DurabilityService } from "../durability/service.js";
import {
  OutboundSafetyError,
  outboundErrorCodes,
  outboundErrorDetailsSchemas,
  type OutboundErrorCode,
} from "../outbound/errors.js";
import {
  RepositoryImportError,
  repositoryImportErrorCodes,
  repositoryImportErrorDetailsSchemas,
  type RepositoryImportErrorCode,
} from "../import/errors.js";
import { formatVersion, packageVersion } from "../system/version.js";
import { registerOutboundCommands } from "./outbound-commands.js";
import {
  registerImportCommands,
  type ImportCommandFileSystem,
} from "./import-commands.js";
import type {
  assertDatabaseOutsideRepository,
  assertOutputOutsideRepository,
} from "../import/output-containment.js";

export interface CliOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface ConfirmationService {
  confirm(message: string): Promise<boolean>;
}

export interface CoordinationInputFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface CoordinationInputFileSystem {
  lstat(path: string): CoordinationInputFileStat;
  open(
    path: string,
    options: {
      readonly nonBlocking: boolean;
      readonly noFollow: boolean;
    },
  ): number;
  fstat(fileDescriptor: number): CoordinationInputFileStat;
  read(
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ): number;
  close(fileDescriptor: number): void;
}

const defaultCoordinationInputFileSystem: CoordinationInputFileSystem = {
  lstat: (path) => lstatSync(path),
  open: (path, options) => openSync(
    path,
    fileSystemConstants.O_RDONLY |
      (options.nonBlocking ? (fileSystemConstants.O_NONBLOCK ?? 0) : 0) |
      (options.noFollow ? (fileSystemConstants.O_NOFOLLOW ?? 0) : 0),
  ),
  fstat: (fileDescriptor) => fstatSync(fileDescriptor),
  read: (fileDescriptor, buffer, offset, length) =>
    readSync(fileDescriptor, buffer, offset, length, null),
  close: (fileDescriptor) => closeSync(fileDescriptor),
};

export interface CreateProgramOptions {
  service: IntentArcService;
  repositoryImportTools?: RepositoryImportTools;
  importFileSystem?: Partial<ImportCommandFileSystem>;
  importOutputContainment?: {
    readonly assertDatabaseOutsideRepository: typeof assertDatabaseOutsideRepository;
    readonly assertOutputOutsideRepository: typeof assertOutputOutsideRepository;
  };
  onPreparedImportApply?: (input: ApplyRepositoryImportInput) => void;
  durabilityService?: DurabilityService;
  databasePath?: string;
  stdout: CliOutput;
  stderr: CliOutput;
  stdin: { isTTY?: boolean };
  confirmationService: ConfirmationService;
  targetExists?: (path: string) => boolean;
  profileCredentials?: ProfileCredentials | null;
  coordinationInputFileSystem?: CoordinationInputFileSystem;
}

const targetExistsWithoutFollowingLinks = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;

const taskContextInputSchema = z
  .object({
    projectId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    budgetTokens: z.coerce.number().int().positive(),
  })
  .strict();

const projectIdSchema = z.string().trim().min(1);
const identifierSchema = z.string().trim().min(1);
const optionalIdentifierSchema = identifierSchema.optional();
const reasonSchema = z.string().trim().min(1);
const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((path) => resolve(path));
const coordinationInputPathSchema = z.string().trim().min(1).refine(isAbsolute);
const canonicalUnsignedDecimalSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .transform((value) => Number(value));
const durabilityDatabaseSchema = z
  .object({ databasePath: absolutePathSchema })
  .strict();
const createBackupCliSchema = z
  .object({
    databasePath: absolutePathSchema,
    outputRoot: absolutePathSchema.optional(),
  })
  .strict();
const listBackupsCliSchema = z
  .object({
    databasePath: absolutePathSchema,
    root: absolutePathSchema.optional(),
  })
  .strict();
const verifyBackupCliSchema = z
  .object({ bundlePath: absolutePathSchema })
  .strict();
const restoreBackupCliSchema = z
  .object({
    targetDatabasePath: absolutePathSchema,
    bundlePath: absolutePathSchema,
    confirmed: z.boolean(),
    allowDifferentStore: z.boolean(),
  })
  .strict();
const auditListInputSchema = z
  .object({
    projectId: identifierSchema,
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
const profileCreateInputSchema = createProfileInputSchema
  .extend({ projectId: optionalIdentifierSchema })
  .strict();
const scopeCliInputSchema = z
  .object({
    operationType: changeOperationTypeSchema,
    recordKind: recordKindSchema.nullable(),
    fromRecordKind: recordKindSchema.nullable(),
    toRecordKind: recordKindSchema.nullable(),
    relationshipKind: relationshipKindSchema.nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    const isRecordOperation =
      input.operationType === "create_record" ||
      input.operationType === "update_record";

    if (
      isRecordOperation &&
      (input.fromRecordKind !== null ||
        input.toRecordKind !== null ||
        input.relationshipKind !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Record operation scopes may use only recordKind",
      });
    }
    if (!isRecordOperation && input.recordKind !== null) {
      context.addIssue({
        code: "custom",
        message: "Relationship operation scopes may not use recordKind",
      });
    }
  });

const writeJson = (stdout: CliOutput, value: unknown): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const writeProfileListJson = (stdout: CliOutput, value: unknown): void => {
  stdout.write(
    `${JSON.stringify(
      value,
      (key, nestedValue) =>
        key === "token" || key === "tokenHash" ? undefined : nestedValue,
      2,
    )}\n`,
  );
};

export const formatDurabilityErrorForCli = (
  error: DurabilityError,
): string => {
  const details = Object.keys(error.details).length === 0
    ? ""
    : ` Recovery details: ${JSON.stringify(error.details)}`;
  return `${error.code}: ${error.message}${details}`;
};

export const formatOutboundSafetyErrorForCli = (
  error: OutboundSafetyError,
): string | undefined => {
  if (!outboundErrorCodes.includes(error.code as OutboundErrorCode)) {
    return undefined;
  }
  const code = error.code as OutboundErrorCode;
  const detailsResult = outboundErrorDetailsSchemas[code].safeParse(
    error.details,
  );
  if (!detailsResult.success) {
    return undefined;
  }
  const canonical = new OutboundSafetyError(code, detailsResult.data as never);
  const details = Object.keys(detailsResult.data).length === 0
    ? ""
    : ` Details: ${JSON.stringify(detailsResult.data)}`;
  return `${canonical.code}: ${canonical.message}${details}`;
};

export const formatRepositoryImportErrorForCli = (
  error: RepositoryImportError,
): string | undefined => {
  if (
    !repositoryImportErrorCodes.includes(
      error.code as RepositoryImportErrorCode,
    )
  ) {
    return undefined;
  }
  const code = error.code as RepositoryImportErrorCode;
  const detailsResult = repositoryImportErrorDetailsSchemas[code].safeParse(
    error.details,
  );
  if (!detailsResult.success) {
    return undefined;
  }
  const canonical = new RepositoryImportError(
    code,
    detailsResult.data as never,
  );
  const details = Object.keys(detailsResult.data).length === 0
    ? ""
    : ` Details: ${JSON.stringify(detailsResult.data)}`;
  return `${canonical.code}: ${canonical.message}${details}`;
};

const domainErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof DurabilityError) {
    return formatDurabilityErrorForCli(error);
  }

  if (error instanceof OutboundSafetyError) {
    return formatOutboundSafetyErrorForCli(error);
  }

  if (error instanceof RepositoryImportError) {
    return formatRepositoryImportErrorForCli(error);
  }

  if (error instanceof CoordinationError) {
    return error.message;
  }

  if (
    error instanceof ProjectNotFoundError ||
    error instanceof RecordNotFoundError ||
    error instanceof InvalidTaskError ||
    error instanceof RelationshipAlreadyExistsError ||
    error instanceof GovernanceError
  ) {
    return error.message;
  }

  return undefined;
};

const invalidInput = (program: Command): never => {
  program.error("Invalid command input.", {
    code: "intentarc.invalid_input",
    exitCode: 2,
  });
  throw new Error("Commander error handler returned unexpectedly");
};

const serviceFailure = (program: Command, error: unknown): never => {
  if (error instanceof z.ZodError) {
    invalidInput(program);
  }
  program.error(domainErrorMessage(error) ?? "Command failed.", {
    code: "intentarc.command_failed",
    exitCode: 1,
  });
  throw new Error("Commander error handler returned unexpectedly");
};

const profileRequired = (program: Command): never => {
  program.error("Profile credentials are required.", {
    code: "intentarc.profile_required",
    exitCode: 1,
  });
  throw new Error("Commander error handler returned unexpectedly");
};

const readCoordinationInput = <Input>(
  program: Command,
  inputPath: string,
  maximumBytes: number,
  schema: z.ZodType<Input>,
  fileSystem: CoordinationInputFileSystem,
): Input => {
  const parsedPath = coordinationInputPathSchema.safeParse(inputPath);
  if (!parsedPath.success) invalidInput(program);

  let document: unknown;
  let fileDescriptor: number | undefined;
  let failed = false;
  try {
    const pathBefore = fileSystem.lstat(parsedPath.data!);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new Error("Invalid input type");
    }

    fileDescriptor = fileSystem.open(parsedPath.data!, {
      nonBlocking: true,
      noFollow: true,
    });
    const handleBefore = fileSystem.fstat(fileDescriptor);
    const sameSnapshot = (
      left: CoordinationInputFileStat,
      right: CoordinationInputFileStat,
    ): boolean =>
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs;
    if (!handleBefore.isFile() || !sameSnapshot(pathBefore, handleBefore)) {
      throw new Error("Input changed before read");
    }

    const bytes = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const count = fileSystem.read(
        fileDescriptor,
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
      );
      if (count === 0) break;
      if (count < 0 || count > bytes.byteLength - bytesRead) {
        throw new Error("Invalid read result");
      }
      bytesRead += count;
    }

    const handleAfter = fileSystem.fstat(fileDescriptor);
    const pathAfter = fileSystem.lstat(parsedPath.data!);
    if (
      bytesRead > maximumBytes ||
      bytesRead !== handleAfter.size ||
      !handleAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameSnapshot(handleBefore, handleAfter) ||
      !sameSnapshot(handleAfter, pathAfter)
    ) {
      throw new Error("Input changed during read");
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    document = JSON.parse(text);
  } catch {
    failed = true;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        fileSystem.close(fileDescriptor);
      } catch {
        failed = true;
      }
    }
  }

  if (failed) invalidInput(program);

  const parsed = schema.safeParse(document);
  if (!parsed.success) invalidInput(program);
  return parsed.data!;
};

const parsePublicCoordinationResult = <Result>(
  schema: z.ZodType<Result>,
  value: unknown,
): Result => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid coordination service result");
  }
  return parsed.data!;
};

export const createProgram = ({
  service,
  repositoryImportTools,
  importFileSystem,
  importOutputContainment,
  onPreparedImportApply,
  durabilityService,
  databasePath,
  stdout,
  stderr,
  stdin,
  confirmationService,
  targetExists = targetExistsWithoutFollowingLinks,
  profileCredentials = null,
  coordinationInputFileSystem = defaultCoordinationInputFileSystem,
}: CreateProgramOptions): Command => {
  const program = new Command();
  const coordinationCommandRequested = (): boolean => {
    const rawArguments = (program as Command & { rawArgs?: string[] }).rawArgs ?? program.args;
    return rawArguments.find((argument: string) =>
      program.commands.some((command) => command.name() === argument)
    ) === "coordination";
  };

  const confirmMutation = async (message: string): Promise<boolean> => {
    if (!stdin.isTTY) return true;
    if (await confirmationService.confirm(message)) return true;
    writeJson(stdout, { cancelled: true });
    return false;
  };

  const coordinationPrincipal = (): AuthenticatedProfile => {
    let authenticated: AuthenticatedProfile | null = null;
    try {
      authenticated = service.profiles.authenticate(profileCredentials);
    } catch (error) {
      return serviceFailure(program, error);
    }
    if (!authenticated) return profileRequired(program);
    try {
      return service.profiles.revalidatePrincipal(authenticated);
    } catch (error) {
      return serviceFailure(program, error);
    }
  };

  program
    .name("intentarc")
    .description("IntentArc JSON command-line interface")
    .version(formatVersion(packageVersion))
    .configureOutput({
      writeOut: (message) => stdout.write(message),
      writeErr: (message) => stderr.write(message),
      outputError: (message, write) => write(
        message.startsWith("error:") && coordinationCommandRequested()
          ? "Invalid command input.\n"
          : message,
      ),
    })
    .exitOverride((error) => {
      if (error.code.startsWith("commander.") && error.exitCode !== 0) {
        error.exitCode = 2;
      }

      throw error;
    });

  const project = program.command("project").description("Manage projects");

  registerImportCommands({
    projectCommand: project,
    service,
    repositoryImportTools,
    stdout,
    stdin,
    confirmationService,
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(importFileSystem === undefined
      ? {}
      : { fileSystem: importFileSystem }),
    ...(importOutputContainment === undefined
      ? {}
      : { outputContainment: importOutputContainment }),
    ...(onPreparedImportApply === undefined
      ? {}
      : { onPreparedApply: onPreparedImportApply }),
    invalidInput: () => invalidInput(program),
    fail: (error) => serviceFailure(program, error),
  });

  project
    .command("create")
    .requiredOption("--name <name>")
    .option("--repo <path>")
    .action((options: { name: string; repo?: string }) => {
      const input = createProjectInputSchema.safeParse({
        name: options.name,
        ...(options.repo === undefined
          ? {}
          : { primaryRepositoryPath: options.repo }),
      });

      if (!input.success) {
        invalidInput(program);
      }

      try {
        writeJson(stdout, service.createProject(input.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  project.command("list").action(() => {
    try {
      writeJson(stdout, service.listProjects());
    } catch (error) {
      serviceFailure(program, error);
    }
  });

  project
    .command("summary")
    .requiredOption("--project <projectId>")
    .action((options: { project: string }) => {
      const projectId = projectIdSchema.safeParse(options.project);

      if (!projectId.success) {
        invalidInput(program);
      }

      try {
        writeJson(stdout, service.getProjectSummary(projectId.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  const record = program.command("record").description("Manage records");

  record
    .command("add")
    .requiredOption("--project <projectId>")
    .requiredOption("--kind <kind>")
    .requiredOption("--status <status>")
    .requiredOption("--title <title>")
    .requiredOption("--body <body>")
    .option("--source-kind <kind>", "Source kind", "human")
    .option("--source-ref <reference>")
    .action(
      (options: {
        project: string;
        kind: string;
        status: string;
        title: string;
        body: string;
        sourceKind: string;
        sourceRef?: string;
      }) => {
        const input = createRecordInputSchema.safeParse({
          projectId: options.project,
          kind: options.kind,
          status: options.status,
          title: options.title,
          body: options.body,
          sourceKind: options.sourceKind,
          sourceRef: options.sourceRef ?? null,
        });

        if (!input.success) {
          invalidInput(program);
        }

        try {
          writeJson(stdout, service.createRecord(input.data!));
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  record
    .command("link")
    .requiredOption("--project <projectId>")
    .requiredOption("--from <recordId>")
    .requiredOption("--to <recordId>")
    .requiredOption("--kind <kind>")
    .requiredOption("--expected-revision <revision>")
    .action(
      (options: {
        project: string;
        from: string;
        to: string;
        kind: string;
        expectedRevision: string;
      }) => {
        const input = createRelationshipInputSchema.safeParse({
          projectId: options.project,
          fromRecordId: options.from,
          toRecordId: options.to,
          kind: options.kind,
        });
        const revision = z.coerce.number().int().nonnegative().safeParse(
          options.expectedRevision,
        );

        if (!input.success || !revision.success) {
          invalidInput(program);
        }

        try {
          writeJson(stdout, service.createRelationship({
            ...input.data!,
            expectedProjectRevision: revision.data!,
          }));
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  record
    .command("update")
    .requiredOption("--project <projectId>")
    .requiredOption("--record <recordId>")
    .requiredOption("--expected-revision <revision>")
    .option("--title <title>")
    .option("--body <body>")
    .option("--status <status>")
    .action(
      (options: {
        project: string;
        record: string;
        expectedRevision: string;
        title?: string;
        body?: string;
        status?: string;
      }) => {
        const input = humanRecordUpdateInputSchema.safeParse({
          projectId: options.project,
          recordId: options.record,
          expectedRecordRevision: Number(options.expectedRevision),
          patch: {
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.body === undefined ? {} : { body: options.body }),
            ...(options.status === undefined ? {} : { status: options.status }),
          },
        });

        if (!input.success) {
          invalidInput(program);
        }

        try {
          writeJson(stdout, service.updateRecord(input.data!));
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  const profile = program.command("profile").description("Manage client profiles");

  profile
    .command("create")
    .requiredOption("--name <name>")
    .option("--project <projectId>")
    .action((options: { name: string; project?: string }) => {
      const input = profileCreateInputSchema.safeParse({
        name: options.name,
        ...(options.project === undefined
          ? {}
          : { projectId: options.project }),
      });

      if (!input.success) {
        invalidInput(program);
      }

      try {
        const createdProfile = input.data!;
        writeJson(
          stdout,
          service.profiles.createProfile(
            createdProfile.projectId === undefined
              ? { name: createdProfile.name }
              : {
                  name: createdProfile.name,
                  projectId: createdProfile.projectId,
                },
          ),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  profile.command("list").action(() => {
    try {
      writeProfileListJson(stdout, service.profiles.listProfiles());
    } catch (error) {
      serviceFailure(program, error);
    }
  });

  profile
    .command("set-authority")
    .requiredOption("--profile <profileId>")
    .requiredOption("--project <projectId>")
    .requiredOption("--mode <mode>")
    .action(
      async (options: {
        profile: string;
        project: string;
        mode: string;
      }) => {
        const input = setAuthorityInputSchema.safeParse({
          profileId: options.profile,
          projectId: options.project,
          mode: options.mode,
        });

        if (!input.success) {
          invalidInput(program);
        }

        try {
          if (!(await confirmMutation("Set profile authority?"))) return;
          writeJson(stdout, service.profiles.setAuthority(input.data!));
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  profile
    .command("add-scope")
    .requiredOption("--profile <profileId>")
    .requiredOption("--project <projectId>")
    .requiredOption("--operation <type>")
    .option("--record-kind <kind>")
    .option("--from-record-kind <kind>")
    .option("--to-record-kind <kind>")
    .option("--relationship-kind <kind>")
    .action(
      async (options: {
        profile: string;
        project: string;
        operation: string;
        recordKind?: string;
        fromRecordKind?: string;
        toRecordKind?: string;
        relationshipKind?: string;
      }) => {
        const profileId = identifierSchema.safeParse(options.profile);
        const projectId = identifierSchema.safeParse(options.project);
        const scope = scopeCliInputSchema.safeParse({
          operationType: options.operation,
          recordKind: options.recordKind ?? null,
          fromRecordKind: options.fromRecordKind ?? null,
          toRecordKind: options.toRecordKind ?? null,
          relationshipKind: options.relationshipKind ?? null,
        });

        if (!profileId.success || !projectId.success || !scope.success) {
          invalidInput(program);
        }

        try {
          if (!(await confirmMutation("Add profile scope?"))) return;
          const authority = service.profiles
            .listProfiles()
            .find(({ profile: listedProfile }) =>
              listedProfile.id === profileId.data,
            )
            ?.authorities.find(
              ({ authority: listedAuthority }) =>
                listedAuthority.projectId === projectId.data,
            )?.authority;

          if (!authority) {
            throw new GovernanceError(
              "project_authority_missing",
              "Project authority is missing",
            );
          }

          writeJson(
            stdout,
            service.profiles.addScope({
              ...scope.data!,
              authorityId: authority.id,
            }),
          );
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  profile
    .command("remove-scope")
    .requiredOption("--scope <scopeId>")
    .action(async (options: { scope: string }) => {
      const scopeId = identifierSchema.safeParse(options.scope);
      if (!scopeId.success) {
        invalidInput(program);
      }

      try {
        if (!(await confirmMutation("Remove profile scope?"))) return;
        service.profiles.removeScope(scopeId.data!);
        writeJson(stdout, { removed: true, scopeId: scopeId.data! });
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  profile
    .command("rotate-token")
    .requiredOption("--profile <profileId>")
    .action(async (options: { profile: string }) => {
      const profileId = identifierSchema.safeParse(options.profile);
      if (!profileId.success) {
        invalidInput(program);
      }

      try {
        if (!(await confirmMutation("Rotate profile token?"))) return;
        writeJson(stdout, service.profiles.rotateToken(profileId.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  for (const [commandName, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    profile
      .command(commandName)
      .requiredOption("--profile <profileId>")
      .action(async (options: { profile: string }) => {
        const profileId = identifierSchema.safeParse(options.profile);
        if (!profileId.success) {
          invalidInput(program);
        }

        try {
          if (
            !(await confirmMutation(
              `${enabled ? "Enable" : "Disable"} profile?`,
            ))
          ) {
            return;
          }
          writeJson(
            stdout,
            service.profiles.setEnabled(profileId.data!, enabled),
          );
        } catch (error) {
          serviceFailure(program, error);
        }
      });
  }

  const proposal = program.command("proposal").description("Review proposals");

  proposal
    .command("list")
    .requiredOption("--project <projectId>")
    .option("--state <state>")
    .action((options: { project: string; state?: string }) => {
      const input = proposalFilterSchema.safeParse({
        projectId: options.project,
        ...(options.state === undefined ? {} : { state: options.state }),
      });
      if (!input.success) {
        invalidInput(program);
      }

      try {
        writeJson(stdout, service.proposals.list(input.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  proposal
    .command("show")
    .requiredOption("--proposal <proposalId>")
    .action((options: { proposal: string }) => {
      const proposalId = identifierSchema.safeParse(options.proposal);
      if (!proposalId.success) {
        invalidInput(program);
      }

      try {
        writeJson(stdout, service.proposals.get(proposalId.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  proposal
    .command("accept")
    .requiredOption("--proposal <proposalId>")
    .action(async (options: { proposal: string }) => {
      const proposalId = identifierSchema.safeParse(options.proposal);
      if (!proposalId.success) {
        invalidInput(program);
      }

      try {
        if (!(await confirmMutation("Accept proposal?"))) return;
        writeJson(stdout, service.proposals.accept(proposalId.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  proposal
    .command("reject")
    .requiredOption("--proposal <proposalId>")
    .requiredOption("--reason <text>")
    .action(
      async (options: { proposal: string; reason: string }) => {
        const proposalId = identifierSchema.safeParse(options.proposal);
        const reason = reasonSchema.safeParse(options.reason);
        if (!proposalId.success || !reason.success) {
          invalidInput(program);
        }

        try {
          if (!(await confirmMutation("Reject proposal?"))) return;
          writeJson(
            stdout,
            service.proposals.reject({
              proposalId: proposalId.data!,
              reason: reason.data!,
            }),
          );
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  proposal
    .command("withdraw")
    .requiredOption("--proposal <proposalId>")
    .requiredOption("--reason <text>")
    .action((options: { proposal: string; reason: string }) => {
      const proposalId = identifierSchema.safeParse(options.proposal);
      const reason = reasonSchema.safeParse(options.reason);
      if (!proposalId.success || !reason.success) {
        invalidInput(program);
      }

      try {
        writeJson(
          stdout,
          service.proposals.withdraw({
            proposalId: proposalId.data!,
            reason: reason.data!,
          }),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  const audit = program.command("audit").description("Inspect audit events");

  audit
    .command("list")
    .requiredOption("--project <projectId>")
    .option("--limit <count>")
    .action((options: { project: string; limit?: string }) => {
      const input = auditListInputSchema.safeParse({
        projectId: options.project,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      if (!input.success) {
        invalidInput(program);
      }

      try {
        writeJson(
          stdout,
          service.listAuditEvents(
            input.data!.limit === undefined
              ? { projectId: input.data!.projectId }
              : {
                  projectId: input.data!.projectId,
                  limit: input.data!.limit,
                },
          ),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  const context = program.command("context").description("Build task context");

  context
    .command("get")
    .requiredOption("--project <projectId>")
    .requiredOption("--task <recordId>")
    .option("--budget <tokens>", "Token budget", "4000")
    // Trusted local-human administrative access; this is not an MCP release path.
    .action((options: { project: string; task: string; budget: string }) => {
      const input = taskContextInputSchema.safeParse({
        projectId: options.project,
        taskId: options.task,
        budgetTokens: options.budget,
      });

      if (!input.success) {
        invalidInput(program);
      }

      try {
        writeJson(stdout, service.getTaskContext(input.data!));
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  registerOutboundCommands({
    profileCommand: profile,
    contextCommand: context,
    service,
    stdout,
    stderr,
    stdin,
    fail: (error) => serviceFailure(program, error),
  });

  const coordination = program
    .command("coordination")
    .description("Coordinate authenticated task work")
    .configureOutput({
      outputError: (_message, write) => write("Invalid command input.\n"),
    });

  coordination
    .command("ready")
    .requiredOption("--project <projectId>")
    .requiredOption("--expected-project-revision <revision>")
    .option("--cursor <cursor>")
    .option("--limit <count>", "Maximum tasks", "20")
    .action((options: {
      project: string;
      expectedProjectRevision: string;
      cursor?: string;
      limit: string;
    }) => {
      const input = listReadyTasksInputSchema.safeParse({
        projectId: options.project,
        expectedProjectRevision: canonicalUnsignedDecimalSchema.safeParse(
          options.expectedProjectRevision,
        ).data,
        cursor: options.cursor ?? null,
        limit: canonicalUnsignedDecimalSchema.safeParse(options.limit).data,
      });
      if (!input.success) invalidInput(program);
      const principal = coordinationPrincipal();
      try {
        const result = service.coordination.listReadyTasks(input.data!, principal);
        const output = parsePublicCoordinationResult(readyTaskPageSchema, result);
        if (!readyTaskPageMatches(output, input.data!)) {
          throw new Error("Invalid coordination service result");
        }
        writeJson(stdout, output);
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  coordination
    .command("state")
    .requiredOption("--project <projectId>")
    .requiredOption("--task <taskId>")
    .requiredOption("--expected-project-revision <revision>")
    .action((options: {
      project: string;
      task: string;
      expectedProjectRevision: string;
    }) => {
      const input = coordinationStateInputSchema.safeParse({
        projectId: options.project,
        taskId: options.task,
        expectedProjectRevision: canonicalUnsignedDecimalSchema.safeParse(
          options.expectedProjectRevision,
        ).data,
      });
      if (!input.success) invalidInput(program);
      const principal = coordinationPrincipal();
      try {
        const result = service.coordination.getCoordinationState(input.data!, principal);
        const output = parsePublicCoordinationResult(coordinationStateSchema, result);
        if (!coordinationStateMatches(output, input.data!)) {
          throw new Error("Invalid coordination service result");
        }
        writeJson(stdout, output);
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  const registerCoordinationDocumentCommand = <Input, Result, Expected = undefined>({
    name,
    maximumBytes,
    inputSchema,
    resultSchema,
    invoke,
    matches,
    resolveExpectedBinding,
    confirmationMessage,
  }: {
    name: string;
    maximumBytes: number;
    inputSchema: z.ZodType<Input>;
    resultSchema: z.ZodType<Result>;
    invoke: (
      input: Input,
      principal: AuthenticatedProfile,
      expectedBinding?: Expected,
    ) => Result;
    matches: (
      output: Result,
      input: Input,
      principal: AuthenticatedProfile,
      expectedBinding?: Expected,
    ) => boolean;
    resolveExpectedBinding?: (
      input: Input,
      principal: AuthenticatedProfile,
    ) => Expected;
    confirmationMessage?: (input: Input) => string | undefined;
  }): void => {
    coordination
      .command(name)
      .requiredOption("--input <jsonPath>")
      .action(async (options: { input: string }) => {
        const input = readCoordinationInput(
          program,
          options.input,
          maximumBytes,
          inputSchema,
          coordinationInputFileSystem,
        );
        const principal = coordinationPrincipal();
        const message = confirmationMessage?.(input);
        if (message !== undefined && !(await confirmMutation(message))) return;
        try {
          const expectedBinding = resolveExpectedBinding?.(input, principal);
          const result = invoke(input, principal, expectedBinding);
          const output = parsePublicCoordinationResult(resultSchema, result);
          if (!matches(output, input, principal, expectedBinding)) {
            throw new Error("Invalid coordination service result");
          }
          writeJson(stdout, output);
        } catch (error) {
          serviceFailure(program, error);
        }
      });
  };

  const smallDocumentBytes = 16 * 1_024;
  const delegationDocumentBytes = 40 * 1_024;
  const checkpointDocumentBytes = 72 * 1_024;
  const submissionDocumentBytes = 272 * 1_024;
  const constrainedCoordination = service.coordination as ProjectConstrainedCoordinationService;
  const ownedClaimSnapshot = (
    input: { claimId: string },
    principal: AuthenticatedProfile,
  ): TaskClaim => constrainedCoordination.resolveOwnedClaimSnapshot(input.claimId, principal);
  const authorizedDelegation = (
    input: { delegationId: string; projectId: string; taskId: string },
    principal: AuthenticatedProfile,
    requiredRole: "parent" | "child",
  ): TaskDelegation => constrainedCoordination.resolveAuthorizedDelegation(
    input,
    principal,
    requiredRole,
  );

  registerCoordinationDocumentCommand({
    name: "claim",
    maximumBytes: smallDocumentBytes,
    inputSchema: claimTaskInputSchema,
    resultSchema: claimTaskResultSchema,
    invoke: (input, principal) => service.coordination.claimTask(input, principal),
    matches: (output, input, principal) => claimTaskResultMatches(output, input, principal.id),
  });
  registerCoordinationDocumentCommand({
    name: "renew",
    maximumBytes: smallDocumentBytes,
    inputSchema: renewClaimInputSchema,
    resultSchema: renewClaimResultSchema,
    resolveExpectedBinding: ownedClaimSnapshot,
    invoke: (input, principal, expectedClaimScope) => constrainedCoordination.renewClaim(
      input,
      principal,
      { expectedProjectId: expectedClaimScope!.projectId },
    ),
    matches: (output, input, principal, expectedClaimScope) =>
      renewClaimResultMatches(output, input, principal.id, expectedClaimScope!),
  });
  registerCoordinationDocumentCommand({
    name: "checkpoint",
    maximumBytes: checkpointDocumentBytes,
    inputSchema: checkpointClaimInputSchema,
    resultSchema: checkpointResultSchema,
    resolveExpectedBinding: ownedClaimSnapshot,
    invoke: (input, principal, expectedClaimScope) => constrainedCoordination.checkpointClaim(
      input,
      principal,
      { expectedProjectId: expectedClaimScope!.projectId },
    ),
    matches: (output, input, principal, expectedClaimScope) =>
      checkpointResultMatches(output, input, principal.id, expectedClaimScope!),
  });
  registerCoordinationDocumentCommand({
    name: "transition",
    maximumBytes: smallDocumentBytes,
    inputSchema: transitionClaimInputSchema,
    resultSchema: transitionClaimResultSchema,
    resolveExpectedBinding: ownedClaimSnapshot,
    invoke: (input, principal, expectedClaimScope) => constrainedCoordination.transitionClaim(
      input,
      principal,
      { expectedProjectId: expectedClaimScope!.projectId },
    ),
    matches: (output, input, principal, expectedClaimScope) =>
      transitionClaimResultMatches(output, input, principal.id, expectedClaimScope!),
    confirmationMessage: (input) => input.action === "release"
      ? "Release task claim?"
      : undefined,
  });
  registerCoordinationDocumentCommand({
    name: "switch",
    maximumBytes: checkpointDocumentBytes,
    inputSchema: switchTaskInputSchema,
    resultSchema: switchTaskResultSchema,
    resolveExpectedBinding: (input, principal) =>
      constrainedCoordination.resolveOwnedClaimSnapshot(input.currentClaimId, principal),
    invoke: (input, principal) => service.coordination.switchTask(input, principal),
    matches: (output, input, principal, expected) =>
      switchTaskResultMatches(output, input, principal.id, expected!),
    confirmationMessage: () => "Switch task?",
  });
  registerCoordinationDocumentCommand({
    name: "delegate",
    maximumBytes: delegationDocumentBytes,
    inputSchema: createDelegationInputSchema,
    resultSchema: delegationResultSchema,
    invoke: (input, principal) => service.coordination.createDelegation(input, principal),
    matches: (output, input, principal) => createdDelegationResultMatches(output, input, principal.id),
  });
  registerCoordinationDocumentCommand({
    name: "accept-delegation",
    maximumBytes: smallDocumentBytes,
    inputSchema: acceptDelegationInputSchema,
    resultSchema: delegationResultSchema,
    resolveExpectedBinding: (input, principal) =>
      authorizedDelegation(input, principal, "child"),
    invoke: (input, principal) => service.coordination.acceptDelegation(input, principal),
    matches: (output, input, principal, expected) =>
      acceptedDelegationResultMatches(output, input, principal.id, expected!),
  });
  registerCoordinationDocumentCommand({
    name: "revoke-delegation",
    maximumBytes: smallDocumentBytes,
    inputSchema: revokeDelegationInputSchema,
    resultSchema: delegationResultSchema,
    resolveExpectedBinding: (input, principal) =>
      authorizedDelegation(input, principal, "parent"),
    invoke: (input, principal) => service.coordination.revokeDelegation(input, principal),
    matches: (output, input, principal, expected) =>
      revokedDelegationResultMatches(output, input, principal.id, expected!),
    confirmationMessage: () => "Revoke task delegation?",
  });
  registerCoordinationDocumentCommand({
    name: "submit",
    maximumBytes: submissionDocumentBytes,
    inputSchema: submitTaskResultInputSchema,
    resultSchema: submissionResultSchema,
    resolveExpectedBinding: ownedClaimSnapshot,
    invoke: (input, principal, expectedClaimScope) => constrainedCoordination.submitTaskResult(
      input,
      principal,
      { expectedProjectId: expectedClaimScope!.projectId },
    ),
    matches: (output, input, principal, expectedClaimScope) =>
      submissionResultMatches(output, input, principal.id, expectedClaimScope!),
    confirmationMessage: () => "Submit final task result?",
  });

  const integrity = program
    .command("integrity")
    .description("Inspect store integrity");

  integrity.command("check").action(async () => {
    const durability = durabilityService ?? invalidInput(program);
    const input = durabilityDatabaseSchema.safeParse({ databasePath });
    if (!input.success) {
      invalidInput(program);
    }
    try {
      writeJson(
        stdout,
        await durability.checkIntegrity(input.data!.databasePath),
      );
    } catch (error) {
      serviceFailure(program, error);
    }
  });

  const backup = program.command("backup").description("Manage backup bundles");

  backup
    .command("create")
    .option("--output <directory>")
    .action(async (options: { output?: string }) => {
      const durability = durabilityService ?? invalidInput(program);
      const input = createBackupCliSchema.safeParse({
        databasePath,
        ...(options.output === undefined
          ? {}
          : { outputRoot: options.output }),
      });
      if (!input.success) {
        invalidInput(program);
      }
      try {
        writeJson(
          stdout,
          await durability.createBackup({
            databasePath: input.data!.databasePath,
            reason: "manual",
            ...(input.data!.outputRoot === undefined
              ? {}
              : { outputRoot: input.data!.outputRoot }),
          }),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  backup
    .command("list")
    .option("--root <directory>")
    .action(async (options: { root?: string }) => {
      const durability = durabilityService ?? invalidInput(program);
      const input = listBackupsCliSchema.safeParse({
        databasePath,
        ...(options.root === undefined ? {} : { root: options.root }),
      });
      if (!input.success) {
        invalidInput(program);
      }
      try {
        writeJson(
          stdout,
          input.data!.root === undefined
            ? await durability.listBackups(input.data!.databasePath)
            : await durability.listBackups(
                input.data!.databasePath,
                input.data!.root,
              ),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  backup
    .command("verify")
    .requiredOption("--backup <bundle>")
    .action(async (options: { backup: string }) => {
      const durability = durabilityService ?? invalidInput(program);
      const input = verifyBackupCliSchema.safeParse({
        bundlePath: options.backup,
      });
      if (!input.success) {
        invalidInput(program);
      }
      try {
        writeJson(
          stdout,
          await durability.verifyBackup(input.data!.bundlePath),
        );
      } catch (error) {
        serviceFailure(program, error);
      }
    });

  backup
    .command("restore")
    .requiredOption("--backup <bundle>")
    .option("--yes")
    .option("--allow-different-store")
    .action(
      async (options: {
        backup: string;
        yes?: boolean;
        allowDifferentStore?: boolean;
      }) => {
        const durability = durabilityService ?? invalidInput(program);
        const targetDatabasePath = databasePath;
        const yes = options.yes === true;
        const allowDifferentStore = options.allowDifferentStore === true;
        const basicInput = restoreBackupCliSchema.safeParse({
          targetDatabasePath,
          bundlePath: options.backup,
          confirmed: yes,
          allowDifferentStore,
        });
        if (!basicInput.success) {
          invalidInput(program);
        }
        try {
          if (!stdin.isTTY && !yes) {
            throw new DurabilityError("confirmation_required");
          }

          let confirmed = yes;
          const targetArtifactsExist =
            !confirmed &&
            [
              basicInput.data!.targetDatabasePath,
              `${basicInput.data!.targetDatabasePath}-wal`,
              `${basicInput.data!.targetDatabasePath}-shm`,
            ]
              .map((path) => targetExists(path))
              .some(Boolean);
          if (targetArtifactsExist) {
            confirmed = await confirmationService.confirm(
              "Restore over the existing store?",
            );
            if (!confirmed) {
              writeJson(stdout, { cancelled: true });
              return;
            }
          }

          const input = restoreBackupCliSchema.parse({
            ...basicInput.data!,
            confirmed,
          });
          writeJson(stdout, await durability.restoreBackup(input));
        } catch (error) {
          serviceFailure(program, error);
        }
      },
    );

  return program;
};
