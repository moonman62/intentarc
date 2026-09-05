import { createHash } from "node:crypto";
import { repositoryImportManifestSchema } from "../domain/import-schemas.js";
import type {
  ImportWarning,
  ProposedImportRecord,
  RepositoryImportManifest,
  RepositoryImportSource,
} from "../domain/import-model.js";
import { IMPORT_MANIFEST_VERSION } from "../domain/import-model.js";
import { classifyRepository } from "./classifiers.js";
import type {
  DiscoveredRepository,
  DiscoveredTextSource,
} from "./discovery-model.js";
import { normalizeManifestSafety } from "./manifest-safety.js";

export interface GenerateImportManifestOptions {
  readonly createdAt?: string;
}

const copySource = (source: RepositoryImportSource): RepositoryImportSource => ({
  ...source,
  extraction: {
    ...source.extraction,
    headings: [...source.extraction.headings],
  },
});

const repositoryBasename = (root: string): string => {
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const manifestKeySuffix = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const slug = normalized.toLowerCase()
    .replace(/\.[^.\/]+$/u, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const pathDigest = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${slug || "source"}-${pathDigest}`;
};

const isRecognizedEvidence = (
  source: DiscoveredTextSource,
  canonicalSubpath: string | null,
): boolean => {
  const normalized = source.path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const projectPath = canonicalSubpath === null
    ? "project.godot"
    : `${canonicalSubpath.replaceAll("\\", "/")}/project.godot`;
  if (normalized === projectPath) return true;
  if (/^readme(?:\.|$)/i.test(basename)) return true;
  if (source.role !== "supporting_document") return false;
  return /(?:^|[/_-])(?:handoff|spec|specs)(?:[/_.-]|$)/i.test(normalized);
};

const evidenceTitle = (path: string): string => {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
  if (basename === "project.godot") return "Godot project configuration";
  if (/^readme(?:\.|$)/i.test(basename)) return `Repository README: ${path}`;
  if (/handoff/i.test(path)) return `Repository handoff: ${path}`;
  return `Repository specification: ${path}`;
};

const evidenceRecords = (
  discovery: DiscoveredRepository,
): ProposedImportRecord[] =>
  discovery.selectedSources
    .filter((source) => isRecognizedEvidence(source, discovery.repository.canonicalSubpath))
    .map((source) => ({
      key: `evidence.${manifestKeySuffix(source.path)}`,
      kind: "evidence" as const,
      status: source.provisional ? "provisional" as const : "accepted" as const,
      title: evidenceTitle(source.path),
      body: `Selected repository evidence (${source.role}).`,
      sourceKind: "repository" as const,
      sourceRef: source.path,
      sourceRefs: [source.path],
      curationReason: null,
    }));

const componentRecords = (
  discovery: DiscoveredRepository,
): ProposedImportRecord[] =>
  classifyRepository(discovery).components.map((component) => ({
    key: component.key,
    kind: "component",
    status: component.status,
    title: component.title,
    body: component.status === "archived"
      ? "Noncanonical repository source retained as archived prototype evidence."
      : "Canonical repository component identified from directory roles.",
    sourceKind: "repository",
    sourceRef: component.sourceRefs[0] ?? null,
    sourceRefs: [...component.sourceRefs],
    curationReason: null,
  }));

const warningTitle = (warning: ImportWarning): string => {
  switch (warning.code) {
    case "working_tree_dirty":
      return "Working tree has local changes";
    case "untracked_document":
      return "Repository has selected untracked documents";
    case "multiple_worktrees":
      return "Repository has multiple linked worktrees";
    case "handoff_drift":
      return "Handoff evidence may have drifted";
    case "large_binary_collection":
      return "Repository has a large binary collection";
  }
};

const warningRiskRecords = (
  warnings: readonly ImportWarning[],
): ProposedImportRecord[] =>
  warnings.map((warning) => ({
    key: `risk.${warning.code.replaceAll("_", "-")}`,
    kind: "risk",
    status: "provisional",
    title: warningTitle(warning),
    body: `Scanner reported ${warning.count} occurrence(s) of ${warning.code}.`,
    sourceKind: "import",
    sourceRef: null,
    sourceRefs: [],
    curationReason: `Synthesized from repository warning ${warning.code}.`,
  }));

export const generateImportManifest = (
  discovery: DiscoveredRepository,
  options: GenerateImportManifestOptions = {},
): RepositoryImportManifest => {
  const classification = classifyRepository(discovery);
  const projectName = classification.godot?.projectName?.trim() ||
    repositoryBasename(discovery.repository.root);
  const records: ProposedImportRecord[] = [
    ...evidenceRecords(discovery),
    ...componentRecords(discovery),
    ...warningRiskRecords(discovery.discovery.warnings),
  ];

  const manifest = repositoryImportManifestSchema.parse({
    manifestVersion: IMPORT_MANIFEST_VERSION,
    scannerVersion: discovery.scannerVersion,
    rulesetVersion: discovery.rulesetVersion,
    createdAt: options.createdAt ?? new Date().toISOString(),
    repository: { ...discovery.repository },
    discovery: {
      sources: discovery.discovery.sources.map(copySource),
      binaryCollections: discovery.discovery.binaryCollections.map((collection) => ({
        ...collection,
        extensions: [...collection.extensions],
      })),
      warnings: discovery.discovery.warnings.map((warning) => ({ ...warning })),
      exclusions: discovery.discovery.exclusions.map((exclusion) => ({ ...exclusion })),
    },
    proposal: {
      project: {
        name: projectName,
        primaryRepositoryPath: discovery.repository.root,
      },
      records,
      relationships: [],
    },
  });
  return normalizeManifestSafety(manifest).manifest;
};
