import type { RecordKind, RecordStatus, RelationshipKind, SourceKind } from "./model.js";
import type { OutboundFinding } from "./outbound-model.js";

export const IMPORT_MANIFEST_VERSION = 1 as const;
export const REPOSITORY_SCANNER_VERSION = "1";
export const REPOSITORY_RULESET_VERSION = "1";
export const REPOSITORY_ROOT_REFERENCE = "." as const;
export const MAX_REPOSITORY_REFERENCE_LENGTH = 1_024;

export type RepositorySourceRole =
  | "canonical_source"
  | "supporting_document"
  | "test"
  | "tool"
  | "asset"
  | "archived_source";

export type ImportWarningCode =
  | "working_tree_dirty"
  | "untracked_document"
  | "multiple_worktrees"
  | "handoff_drift"
  | "large_binary_collection";

export type ImportExclusionReason =
  | "hard_exclusion"
  | "ignored"
  | "unsupported_text"
  | "oversized_text"
  | "link_not_followed"
  | "untracked_not_eligible"
  | "known_secret_path";

export interface RepositoryImportSource {
  path: string;
  status: "tracked" | "untracked";
  role: RepositorySourceRole;
  byteSize: number;
  sha256: string;
  extraction: {
    title: string | null;
    headings: string[];
  };
}

export interface BinaryCollection {
  directory: string;
  role: RepositorySourceRole;
  extensions: string[];
  count: number;
  byteSize: number;
}

export interface ImportWarning {
  code: ImportWarningCode;
  count: number;
}

export interface ImportExclusion {
  path: string | null;
  reason: ImportExclusionReason;
  count: number;
}

export interface ProposedImportRecord {
  key: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  body: string;
  sourceKind: Exclude<SourceKind, "human">;
  sourceRef: string | null;
  sourceRefs: string[];
  curationReason: string | null;
}

export interface ProposedImportRelationship {
  fromKey: string;
  toKey: string;
  kind: RelationshipKind;
}

export interface ImportInspectionRecordKindCount {
  kind: RecordKind;
  count: number;
}

export interface ImportInspectionRecordStatusCount {
  status: RecordStatus;
  count: number;
}

export interface ImportInspectionSourceKindCount {
  sourceKind: SourceKind;
  count: number;
}

export interface ImportInspectionCounts {
  recordsByKind: ImportInspectionRecordKindCount[];
  recordsByStatus: ImportInspectionRecordStatusCount[];
  recordsBySourceKind: ImportInspectionSourceKindCount[];
}

export interface ImportInspectionRecordSummary {
  key: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
}

export interface ImportInspectionRelationshipSummary {
  fromKey: string;
  toKey: string;
  kind: RelationshipKind;
}

export interface ImportInspectionActiveTaskSummary extends ImportInspectionRecordSummary {
  kind: "task";
  status: "active";
  directLinks: ImportInspectionRelationshipSummary[];
}

export interface ImportInspectionClaimSummary {
  key: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  sourceKind: SourceKind;
  curationReason: string | null;
}

export type SensitiveContentFindingCategory = OutboundFinding["category"];
export type SensitiveContentFindingSeverity = OutboundFinding["severity"];

export interface ImportSensitiveFindingSummary {
  category: SensitiveContentFindingCategory;
  severity: SensitiveContentFindingSeverity;
  count: number;
}

export interface RepositoryImportManifest {
  manifestVersion: typeof IMPORT_MANIFEST_VERSION;
  scannerVersion: typeof REPOSITORY_SCANNER_VERSION;
  rulesetVersion: typeof REPOSITORY_RULESET_VERSION;
  createdAt: string;
  repository: {
    root: string;
    canonicalSubpath: string | null;
    branch: string | null;
    head: string | null;
    fingerprint: string;
  };
  discovery: {
    sources: RepositoryImportSource[];
    binaryCollections: BinaryCollection[];
    warnings: ImportWarning[];
    exclusions: ImportExclusion[];
  };
  proposal: {
    project: {
      name: string;
      primaryRepositoryPath: string;
    };
    records: ProposedImportRecord[];
    relationships: ProposedImportRelationship[];
  };
}

export interface ImportInspection {
  manifestDigest: string;
  repository: RepositoryImportManifest["repository"];
  project: RepositoryImportManifest["proposal"]["project"];
  counts: ImportInspectionCounts;
  stableFrame: ImportInspectionRecordSummary[];
  activeTasks: ImportInspectionActiveTaskSummary[];
  curatedOrProvisionalClaims: ImportInspectionClaimSummary[];
  sensitiveFindings: ImportSensitiveFindingSummary[];
  warnings: ImportWarning[];
  exclusions: ImportExclusion[];
}

export interface ImportApplyResult {
  projectId: string;
  manifestDigest: string;
  repositoryFingerprint: string;
  revisionBefore: number;
  revisionAfter: number;
  replayed: boolean;
}
