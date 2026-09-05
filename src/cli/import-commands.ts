import type { Command } from "commander";
import {
  closeSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { IntentArcService } from "../core/intentarc-service.js";
import type {
  ApplyRepositoryImportInput,
  RepositoryImportTools,
} from "../core/repository-import-service.js";
import {
  importApplyResultSchema,
  importInspectionSchema,
} from "../domain/import-schemas.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  assertDatabaseOutsideRepository,
  assertOutputOutsideRepository,
} from "../import/output-containment.js";
import type { CliOutput, ConfirmationService } from "./program.js";

export const MAX_IMPORT_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface ImportCommandFileSystem {
  readonly openForRead: (path: string) => number;
  readonly read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    byteLength: number,
  ) => number;
  readonly close: (descriptor: number) => void;
  readonly allocate: (byteLength: number) => Buffer;
  readonly writeExclusive: (path: string, content: string) => void;
}

export interface RegisterImportCommandsOptions {
  readonly projectCommand: Command;
  readonly service: IntentArcService;
  readonly repositoryImportTools: RepositoryImportTools | undefined;
  readonly stdout: CliOutput;
  readonly stdin: { isTTY?: boolean };
  readonly confirmationService: ConfirmationService;
  readonly databasePath?: string;
  readonly fileSystem?: Partial<ImportCommandFileSystem>;
  readonly outputContainment?: {
    readonly assertDatabaseOutsideRepository: typeof assertDatabaseOutsideRepository;
    readonly assertOutputOutsideRepository: typeof assertOutputOutsideRepository;
  };
  readonly onPreparedApply?: (input: ApplyRepositoryImportInput) => void;
  readonly invalidInput: () => never;
  readonly fail: (error: unknown) => never;
}

const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((path) => resolve(path));
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scanInputSchema = z.object({
  repositoryPath: absolutePathSchema,
  canonicalSubpath: z.string().trim().min(1).max(4096).nullable(),
  manifestPath: absolutePathSchema,
}).strict();
const manifestPathInputSchema = z.object({
  manifestPath: absolutePathSchema,
}).strict();

const writeJson = (stdout: CliOutput, value: unknown): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const defaultFileSystem: ImportCommandFileSystem = {
  openForRead: (path) => openSync(path, "r"),
  read: (descriptor, buffer, offset, byteLength) =>
    readSync(descriptor, buffer, offset, byteLength, null),
  close: (descriptor) => closeSync(descriptor),
  allocate: (byteLength) => Buffer.allocUnsafe(byteLength),
  writeExclusive: (path, content) => {
    writeFileSync(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  },
};

const resolveFileSystem = (
  overrides: Partial<ImportCommandFileSystem> = {},
): ImportCommandFileSystem => ({ ...defaultFileSystem, ...overrides });

const safePath = (path: string): string => path.replaceAll("\\", "/");

const invalidManifest = (): RepositoryImportError<"manifest_invalid"> =>
  new RepositoryImportError("manifest_invalid", {});

const importFailed = (): RepositoryImportError<"import_failed"> =>
  new RepositoryImportError("import_failed", {});

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export const readImportManifest = (
  path: string,
  fileSystemOverrides: Partial<ImportCommandFileSystem> = {},
): unknown => {
  const fileSystem = resolveFileSystem(fileSystemOverrides);
  try {
    const descriptor = fileSystem.openForRead(path);
    try {
      let bytesRead = 0;
      const bytes = fileSystem.allocate(MAX_IMPORT_MANIFEST_BYTES + 1);
      if (bytes.byteLength !== MAX_IMPORT_MANIFEST_BYTES + 1) {
        throw invalidManifest();
      }
      while (bytesRead < bytes.byteLength) {
        const count = fileSystem.read(
          descriptor,
          bytes,
          bytesRead,
          bytes.byteLength - bytesRead,
        );
        if (
          !Number.isInteger(count) ||
          count < 0 ||
          count > bytes.byteLength - bytesRead
        ) {
          throw invalidManifest();
        }
        if (count === 0) break;
        bytesRead += count;
      }

      if (bytesRead > MAX_IMPORT_MANIFEST_BYTES) {
        throw invalidManifest();
      }

      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      );
      return JSON.parse(json) as unknown;
    } finally {
      fileSystem.close(descriptor);
    }
  } catch (error) {
    if (error instanceof RepositoryImportError) throw error;
    throw invalidManifest();
  }
};

const strictInspection = (
  tools: RepositoryImportTools,
  manifest: unknown,
) => {
  try {
    return importInspectionSchema.parse(tools.inspect(manifest));
  } catch (error) {
    if (error instanceof RepositoryImportError) throw error;
    throw invalidManifest();
  }
};

const requireTools = (
  tools: RepositoryImportTools | undefined,
): RepositoryImportTools => {
  if (tools === undefined) throw importFailed();
  return tools;
};

const prepareApply = async ({
  manifestPath,
  confirmedDigest,
  databasePath,
  tools,
  fileSystem,
  stdout,
  confirmationService,
  outputContainment,
}: {
  readonly manifestPath: string;
  readonly confirmedDigest: string | undefined;
  readonly databasePath: string | undefined;
  readonly tools: RepositoryImportTools;
  readonly fileSystem: Partial<ImportCommandFileSystem>;
  readonly stdout: CliOutput;
  readonly confirmationService: ConfirmationService;
  readonly outputContainment: {
    readonly assertDatabaseOutsideRepository: typeof assertDatabaseOutsideRepository;
    readonly assertOutputOutsideRepository: typeof assertOutputOutsideRepository;
  };
}): Promise<ApplyRepositoryImportInput | null> => {
  const manifest = readImportManifest(manifestPath, fileSystem);
  const summary = strictInspection(tools, manifest);
  outputContainment.assertOutputOutsideRepository(
    summary.repository.root,
    manifestPath,
  );
  if (databasePath !== undefined) {
    outputContainment.assertDatabaseOutsideRepository(
      summary.repository.root,
      databasePath,
    );
  }

  if (confirmedDigest !== undefined) {
    if (confirmedDigest !== summary.manifestDigest) {
      throw new RepositoryImportError("manifest_digest_mismatch", {
        expectedDigest: summary.manifestDigest,
        actualDigest: confirmedDigest,
      });
    }
    return { manifest, confirmedDigest };
  }

  writeJson(stdout, summary);
  if (
    !(await confirmationService.confirm(
      `Apply import manifest ${summary.manifestDigest}?`,
    ))
  ) {
    writeJson(stdout, { cancelled: true });
    return null;
  }
  return { manifest, confirmedDigest: summary.manifestDigest };
};

export const registerImportCommands = ({
  projectCommand,
  service,
  repositoryImportTools,
  stdout,
  stdin,
  confirmationService,
  databasePath,
  fileSystem = {},
  outputContainment = {
    assertDatabaseOutsideRepository,
    assertOutputOutsideRepository,
  },
  onPreparedApply,
  invalidInput,
  fail,
}: RegisterImportCommandsOptions): void => {
  const importCommand = projectCommand
    .command("import")
    .description("Onboard an existing repository");

  importCommand
    .command("scan")
    .requiredOption("--repository <path>")
    .option("--canonical-subpath <path>")
    .requiredOption("--manifest <path>")
    .action((options: {
      repository: string;
      canonicalSubpath?: string;
      manifest: string;
    }) => {
      const input = scanInputSchema.safeParse({
        repositoryPath: options.repository,
        canonicalSubpath: options.canonicalSubpath ?? null,
        manifestPath: options.manifest,
      });
      if (!input.success) invalidInput();

      try {
        const candidate = requireTools(repositoryImportTools).scan({
          repositoryPath: input.data!.repositoryPath,
          canonicalSubpath: input.data!.canonicalSubpath,
        });
        outputContainment.assertOutputOutsideRepository(
          candidate.repository.root,
          input.data!.manifestPath,
        );
        try {
          resolveFileSystem(fileSystem).writeExclusive(
            input.data!.manifestPath,
            `${JSON.stringify(candidate, null, 2)}\n`,
          );
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            throw new RepositoryImportError("manifest_exists", {
              path: safePath(input.data!.manifestPath),
            });
          }
          throw importFailed();
        }
        writeJson(stdout, { manifestPath: input.data!.manifestPath });
      } catch (error) {
        fail(error);
      }
    });

  importCommand
    .command("inspect")
    .requiredOption("--manifest <path>")
    .action((options: { manifest: string }) => {
      const input = manifestPathInputSchema.safeParse({
        manifestPath: options.manifest,
      });
      if (!input.success) invalidInput();

      try {
        const candidate = readImportManifest(
          input.data!.manifestPath,
          fileSystem,
        );
        writeJson(
          stdout,
          strictInspection(requireTools(repositoryImportTools), candidate),
        );
      } catch (error) {
        fail(error);
      }
    });

  importCommand
    .command("apply")
    .requiredOption("--manifest <path>")
    .option("--confirm-digest <sha256>")
    .action(async (options: {
      manifest: string;
      confirmDigest?: string;
    }) => {
      const input = manifestPathInputSchema.safeParse({
        manifestPath: options.manifest,
      });
      const confirmedDigest = options.confirmDigest === undefined
        ? undefined
        : digestSchema.safeParse(options.confirmDigest);
      if (
        !input.success ||
        (confirmedDigest !== undefined && !confirmedDigest.success) ||
        (stdin.isTTY !== true && confirmedDigest === undefined)
      ) {
        invalidInput();
      }

      try {
        const prepared = await prepareApply({
          manifestPath: input.data!.manifestPath,
          confirmedDigest: confirmedDigest?.success
            ? confirmedDigest.data
            : undefined,
          databasePath,
          tools: requireTools(repositoryImportTools),
          fileSystem,
          stdout,
          confirmationService,
          outputContainment,
        });
        if (prepared === null) return;
        if (onPreparedApply !== undefined) {
          onPreparedApply(prepared);
          return;
        }

        writeJson(
          stdout,
          importApplyResultSchema.parse(service.imports.apply(prepared)),
        );
      } catch (error) {
        fail(error);
      }
    });
};
