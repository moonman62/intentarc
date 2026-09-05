import { createHash } from "node:crypto";
import {
  repositoryImportManifestSchema,
} from "../domain/import-schemas.js";
import type {
  BinaryCollection,
  ImportExclusion,
  ImportWarning,
  ProposedImportRecord,
  ProposedImportRelationship,
  RepositoryImportManifest,
  RepositoryImportSource,
} from "../domain/import-model.js";

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortByStructuralKey = <Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): Value[] => [...values].sort((left, right) => compare(key(left), key(right)));

const normalizeSource = (source: RepositoryImportSource): RepositoryImportSource => ({
  ...source,
  extraction: {
    ...source.extraction,
    headings: [...source.extraction.headings],
  },
});

const sourceKey = (source: RepositoryImportSource): string => JSON.stringify(source);

const normalizeBinaryCollection = (collection: BinaryCollection): BinaryCollection => ({
  ...collection,
  extensions: sortByStructuralKey(collection.extensions, (extension) => extension),
});

const binaryCollectionKey = (collection: BinaryCollection): string => JSON.stringify(collection);

const warningKey = (warning: ImportWarning): string => JSON.stringify(warning);
const exclusionKey = (exclusion: ImportExclusion): string => JSON.stringify(exclusion);

const normalizeRecord = (record: ProposedImportRecord): ProposedImportRecord => ({
  ...record,
  sourceRefs: [...record.sourceRefs],
});

const recordKey = (record: ProposedImportRecord): string => record.key;
const relationshipKey = (relationship: ProposedImportRelationship): string =>
  `${relationship.fromKey}\u0000${relationship.toKey}\u0000${relationship.kind}`;

export const normalizeImportManifest = (
  input: RepositoryImportManifest,
): RepositoryImportManifest => {
  const manifest = repositoryImportManifestSchema.parse(input);

  return {
    ...manifest,
    repository: { ...manifest.repository },
    discovery: {
      ...manifest.discovery,
      sources: sortByStructuralKey(
        manifest.discovery.sources.map(normalizeSource),
        sourceKey,
      ),
      binaryCollections: sortByStructuralKey(
        manifest.discovery.binaryCollections.map(normalizeBinaryCollection),
        binaryCollectionKey,
      ),
      warnings: sortByStructuralKey(manifest.discovery.warnings, warningKey),
      exclusions: sortByStructuralKey(manifest.discovery.exclusions, exclusionKey),
    },
    proposal: {
      ...manifest.proposal,
      project: { ...manifest.proposal.project },
      records: sortByStructuralKey(manifest.proposal.records.map(normalizeRecord), recordKey),
      relationships: sortByStructuralKey(manifest.proposal.relationships, relationshipKey),
    },
  };
};

export const computeImportManifestDigest = (
  input: RepositoryImportManifest,
): string => {
  const normalized = normalizeImportManifest(input);
  const { createdAt: _createdAt, ...semantic } = normalized;
  return createHash("sha256")
    .update(JSON.stringify(semantic))
    .digest("hex");
};
