import type {
  BinaryCollection,
  ImportExclusion,
  ImportWarning,
  RepositoryImportSource,
} from "../domain/import-model.js";
import {
  REPOSITORY_RULESET_VERSION,
  REPOSITORY_SCANNER_VERSION,
} from "../domain/import-model.js";

export interface RepositoryDiscoveryInput {
  readonly root: string;
  readonly canonicalSubpath?: string | null;
}

export interface DiscoveredRepositoryIdentity {
  readonly root: string;
  readonly canonicalSubpath: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly fingerprint: string;
}

export interface RepositoryDiscoveryProjection {
  readonly sources: readonly RepositoryImportSource[];
  readonly binaryCollections: readonly BinaryCollection[];
  readonly warnings: readonly ImportWarning[];
  readonly exclusions: readonly ImportExclusion[];
}

export interface DiscoveredTextSource extends RepositoryImportSource {
  readonly text: string;
  readonly provisional: boolean;
}

export interface DiscoveredRepository {
  readonly scannerVersion: typeof REPOSITORY_SCANNER_VERSION;
  readonly rulesetVersion: typeof REPOSITORY_RULESET_VERSION;
  readonly repository: DiscoveredRepositoryIdentity;
  readonly discovery: RepositoryDiscoveryProjection;
  readonly selectedSources: readonly DiscoveredTextSource[];
}
