import type { ChangeOperation } from "./governance-model.js";
import type {
  ImportExclusion,
  ImportWarning,
  RepositorySourceRole,
} from "./import-model.js";

export type RepositorySourceStatus = "available" | "unavailable" | "detached";
export type RepositorySnapshotState = "candidate" | "accepted" | "discarded";
export type RepositoryNodeKind = "directory" | "file";
export type RepositoryDocumentKind =
  | "overview"
  | "specification"
  | "decision_support"
  | "operational_guide"
  | "test_evidence"
  | "ai_instruction"
  | "unlinked";
export type RepositoryDocumentFormat =
  | "markdown"
  | "plain_text"
  | "image"
  | "pdf"
  | "unsupported";
export type RepositoryLinkBasis = "accepted" | "observed" | "inferred" | "conflicting";
export type RepositoryLinkKind = "documents" | "implements" | "evidences" | "related_to";
export type RepositoryDiffKind = "added" | "changed" | "moved" | "removed" | "unchanged" | "excluded" | "conflicted";
export type RepositoryObservationSourceStatus = "tracked" | "untracked" | "derived";
export type RepositoryScanPhase = "discovering" | "hashing" | "classifying" | "finalizing";
export type RepositoryRefreshReviewState = "pending" | "applied" | "cancelled" | "conflicted";
export type RepositoryDocumentFreshness = "current" | "stale" | "missing" | "unavailable" | "blocked";

export interface RepositorySource {
  id: string;
  projectId: string;
  root: string;
  canonicalSubpath: string | null;
  repositoryIdentity: string;
  status: RepositorySourceStatus;
  currentSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepositorySnapshot {
  id: string;
  sourceId: string;
  projectId: string;
  state: RepositorySnapshotState;
  baseSnapshotId: string | null;
  baseProjectRevision: number;
  branch: string | null;
  head: string | null;
  fingerprint: string;
  scannerVersion: string;
  rulesetVersion: string;
  warningCounts: Record<string, number>;
  exclusionCounts: Record<string, number>;
  findingCounts: Record<string, number>;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface RepositoryNode {
  id: string;
  sourceId: string;
  kind: RepositoryNodeKind;
  createdAt: string;
}

export interface RepositoryObservationInput {
  path: string;
  kind: RepositoryNodeKind;
  sha256: string | null;
  byteSize: number;
  sourceStatus: RepositoryObservationSourceStatus;
  role: RepositorySourceRole;
  documentKind: RepositoryDocumentKind | null;
  documentFormat: RepositoryDocumentFormat | null;
  contentEligible: boolean;
  instructionClient: string | null;
  instructionScope: string | null;
}

export interface RepositoryNodeObservation extends RepositoryObservationInput {
  snapshotId: string;
  nodeId: string;
  parentNodeId: string | null;
}

export interface RepositoryLink {
  id: string;
  projectId: string;
  snapshotId: string;
  fromNodeId: string;
  toRecordId: string | null;
  toNodeId: string | null;
  kind: RepositoryLinkKind;
  basis: RepositoryLinkBasis;
  createdAt: string;
}

export interface RepositoryLinkInput {
  fromPath: string;
  toRecordId: string | null;
  toPath: string | null;
  kind: RepositoryLinkKind;
  basis: RepositoryLinkBasis;
}

export interface RepositoryObservationCandidate {
  root: string;
  canonicalSubpath: string | null;
  repositoryIdentity: string;
  branch: string | null;
  head: string | null;
  fingerprint: string;
  scannerVersion: string;
  rulesetVersion: string;
  warnings: ImportWarning[];
  exclusions: ImportExclusion[];
  findingCounts: Record<string, number>;
  /** Sanitized transient evidence used to establish move identity before persistence. */
  renameEvidence?: RepositoryRenameEvidence[] | undefined;
  observations: RepositoryObservationInput[];
  links: RepositoryLinkInput[];
}

export interface RepositoryRenameEvidence {
  originalPath: string;
  path: string;
}

export interface RepositoryDiffEntry {
  operationId: string;
  kind: RepositoryDiffKind;
  previousNodeId: string | null;
  currentNodeId: string | null;
  previousPath: string | null;
  currentPath: string | null;
}

export interface RepositoryDiffGroup {
  kind: RepositoryDiffKind;
  entries: RepositoryDiffEntry[];
}

export interface RepositorySnapshotDiff {
  groups: RepositoryDiffGroup[];
  semanticOperations: ChangeOperation[];
}

export interface RepositoryScanProgress {
  phase: RepositoryScanPhase;
  processed: number;
  total: number;
}

export interface RepositoryRefreshReview {
  projectId: string;
  sourceId: string;
  snapshotId: string;
  state: RepositoryRefreshReviewState;
  selectedOperationIds: string[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface RepositoryLinkSummary {
  kind: RepositoryLinkKind;
  basis: RepositoryLinkBasis;
  toRecordId: string | null;
  toNodeId: string | null;
}

export interface DocumentRegistryEntry {
  projectId: string;
  snapshotId: string;
  nodeId: string;
  path: string;
  documentKind: RepositoryDocumentKind;
  documentFormat: RepositoryDocumentFormat;
  role: RepositorySourceRole;
  freshness: RepositoryDocumentFreshness;
  contentEligible: boolean;
  instructionClient: string | null;
  instructionScope: string | null;
  links: RepositoryLinkSummary[];
}
