import {
  importInspectionSchema,
} from "../domain/import-schemas.js";
import type {
  ImportApplyResult,
  ImportInspection,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import type { DiscoveredRepository } from "../import/discovery-model.js";
import { RepositoryImportError } from "../import/errors.js";
import { generateImportManifest } from "../import/manifest-generator.js";
import {
  inspectImportManifest,
  normalizeManifestSafety,
  type SafeManifestResult,
} from "../import/manifest-safety.js";
import {
  discoverRepository,
  verifyRepositorySnapshot,
} from "../import/repository-scanner.js";
import type {
  RepositoryImportStore,
} from "../storage/repository-import-store.js";

export interface ScanRepositoryImportInput {
  readonly repositoryPath: string;
  readonly canonicalSubpath: string | null;
}

export interface ApplyRepositoryImportInput {
  readonly manifest: unknown;
  readonly confirmedDigest: string;
}

export interface RepositoryImportTools {
  scan(input: ScanRepositoryImportInput): RepositoryImportManifest;
  inspect(manifest: unknown): ImportInspection;
}

export interface RepositoryImportService extends RepositoryImportTools {
  apply(input: ApplyRepositoryImportInput): ImportApplyResult;
}

export interface RepositoryImportToolDependencies {
  readonly scanner?: (input: {
    readonly root: string;
    readonly canonicalSubpath: string | null;
  }) => DiscoveredRepository;
  readonly generator?: (
    discovery: DiscoveredRepository,
  ) => RepositoryImportManifest;
  readonly safetyNormalizer?: (
    manifest: RepositoryImportManifest,
  ) => SafeManifestResult;
  readonly inspector?: (
    manifest: RepositoryImportManifest,
  ) => ImportInspection;
}

export interface RepositoryImportServiceDependencies
  extends RepositoryImportToolDependencies {
  readonly store: RepositoryImportStore;
  readonly driftVerifier?: (manifest: RepositoryImportManifest) => void;
}

interface InternalImportInspection {
  readonly summary: ImportInspection;
  readonly normalizedManifest: RepositoryImportManifest;
}

interface InternalRepositoryImportTools extends RepositoryImportTools {
  inspectInternal(manifest: unknown): InternalImportInspection;
}

const importFailed = (): RepositoryImportError<"import_failed"> =>
  new RepositoryImportError("import_failed", {});

const normalizeManifestError = (error: unknown): RepositoryImportError => {
  if (error instanceof RepositoryImportError) return error;
  return new RepositoryImportError("manifest_invalid", {});
};

const normalizeDependencyError = (error: unknown): RepositoryImportError => {
  if (error instanceof RepositoryImportError) return error;
  return importFailed();
};

const createInternalRepositoryImportTools = (
  dependencies: RepositoryImportToolDependencies = {},
): InternalRepositoryImportTools => {
  const scanner = dependencies.scanner ?? discoverRepository;
  const generator = dependencies.generator ?? generateImportManifest;
  const safetyNormalizer =
    dependencies.safetyNormalizer ?? normalizeManifestSafety;
  const inspector = dependencies.inspector ?? inspectImportManifest;

  const inspectInternal = (input: unknown): InternalImportInspection => {
    try {
      const safe = safetyNormalizer(input as RepositoryImportManifest);
      const summary = importInspectionSchema.parse({
        ...inspector(input as RepositoryImportManifest),
        manifestDigest: safe.digest,
      });
      return {
        summary,
        normalizedManifest: safe.manifest,
      };
    } catch (error) {
      throw normalizeManifestError(error);
    }
  };

  return {
    scan(input): RepositoryImportManifest {
      try {
        return generator(scanner({
          root: input.repositoryPath,
          canonicalSubpath: input.canonicalSubpath,
        }));
      } catch (error) {
        throw normalizeDependencyError(error);
      }
    },

    inspect: (manifest) => inspectInternal(manifest).summary,

    inspectInternal,
  };
};

export const createRepositoryImportTools = (
  dependencies: RepositoryImportToolDependencies = {},
): RepositoryImportTools =>
  createInternalRepositoryImportTools(dependencies);

export const createRepositoryImportService = ({
  store,
  driftVerifier = verifyRepositorySnapshot,
  ...toolDependencies
}: RepositoryImportServiceDependencies): RepositoryImportService => {
  const tools = createInternalRepositoryImportTools(toolDependencies);

  return {
    scan: (input) => tools.scan(input),
    inspect: (manifest) => tools.inspect(manifest),

    apply(input): ImportApplyResult {
      const inspection = tools.inspectInternal(input.manifest);
      if (inspection.summary.manifestDigest !== input.confirmedDigest) {
        try {
          throw new RepositoryImportError("manifest_digest_mismatch", {
            expectedDigest: inspection.summary.manifestDigest,
            actualDigest: input.confirmedDigest,
          });
        } catch (error) {
          throw normalizeManifestError(error);
        }
      }

      let replay: ImportApplyResult | null;
      try {
        replay = store.findByDigest(inspection.summary.manifestDigest);
      } catch (error) {
        throw normalizeDependencyError(error);
      }
      if (replay !== null) return { ...replay, replayed: true };

      try {
        driftVerifier(inspection.normalizedManifest);
      } catch (error) {
        throw normalizeDependencyError(error);
      }

      try {
        return store.applyInitialSnapshot({
          manifest: inspection.normalizedManifest,
          manifestDigest: inspection.summary.manifestDigest,
          repositoryFingerprint:
            inspection.normalizedManifest.repository.fingerprint,
        });
      } catch (error) {
        throw normalizeDependencyError(error);
      }
    },
  };
};
