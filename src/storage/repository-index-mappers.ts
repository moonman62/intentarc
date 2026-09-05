import type {
  RepositoryLinkBasis,
  RepositoryLinkKind,
  RepositoryNodeKind,
  RepositoryObservationSourceStatus,
  RepositoryRefreshReviewState,
  RepositorySnapshotState,
  RepositorySourceStatus,
} from "../domain/repository-index-model.js";
import {
  repositoryLinkSchema,
  repositoryNodeObservationSchema,
  repositoryRefreshReviewSchema,
  repositorySnapshotSchema,
  repositorySourceSchema,
} from "../domain/repository-index-schemas.js";
import type {
  RepositoryDocumentFormat,
  RepositoryDocumentKind,
  RepositoryLink,
  RepositoryNodeObservation,
  RepositoryRefreshReview,
  RepositorySnapshot,
  RepositorySource,
} from "../domain/repository-index-model.js";
import type { RepositorySourceRole } from "../domain/import-model.js";

export interface RepositorySourceRow {
  id: string;
  project_id: string;
  root: string;
  canonical_subpath: string | null;
  repository_identity: string;
  status: RepositorySourceStatus;
  current_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepositorySnapshotRow {
  id: string;
  source_id: string;
  project_id: string;
  state: RepositorySnapshotState;
  base_snapshot_id: string | null;
  base_project_revision: number;
  branch: string | null;
  head: string | null;
  fingerprint: string;
  scanner_version: string;
  ruleset_version: string;
  warning_counts_json: string;
  exclusion_counts_json: string;
  finding_counts_json: string;
  created_at: string;
  decided_at: string | null;
  applied_at: string | null;
}

export interface RepositoryNodeObservationRow {
  snapshot_id: string;
  node_id: string;
  source_id: string;
  parent_node_id: string | null;
  path: string;
  kind: RepositoryNodeKind;
  sha256: string | null;
  byte_size: number;
  source_status: RepositoryObservationSourceStatus;
  role: RepositorySourceRole;
  document_kind: RepositoryDocumentKind | null;
  document_format: RepositoryDocumentFormat | null;
  content_eligible: number;
  instruction_client: string | null;
  instruction_scope: string | null;
}

export interface RepositoryLinkRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  from_node_id: string;
  to_record_id: string | null;
  to_node_id: string | null;
  kind: RepositoryLinkKind;
  basis: RepositoryLinkBasis;
  created_at: string;
}

export interface RepositoryRefreshReviewRow {
  project_id: string;
  source_id: string;
  snapshot_id: string;
  state: RepositoryRefreshReviewState;
  selected_operation_ids_json: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

const parseStoredJson = (value: string): unknown => JSON.parse(value);

export const mapRepositorySourceRow = (
  row: RepositorySourceRow,
): RepositorySource => repositorySourceSchema.parse({
  id: row.id,
  projectId: row.project_id,
  root: row.root,
  canonicalSubpath: row.canonical_subpath,
  repositoryIdentity: row.repository_identity,
  status: row.status,
  currentSnapshotId: row.current_snapshot_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapRepositorySnapshotRow = (
  row: RepositorySnapshotRow,
): RepositorySnapshot => repositorySnapshotSchema.parse({
  id: row.id,
  sourceId: row.source_id,
  projectId: row.project_id,
  state: row.state,
  baseSnapshotId: row.base_snapshot_id,
  baseProjectRevision: row.base_project_revision,
  branch: row.branch,
  head: row.head,
  fingerprint: row.fingerprint,
  scannerVersion: row.scanner_version,
  rulesetVersion: row.ruleset_version,
  warningCounts: parseStoredJson(row.warning_counts_json),
  exclusionCounts: parseStoredJson(row.exclusion_counts_json),
  findingCounts: parseStoredJson(row.finding_counts_json),
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  appliedAt: row.applied_at,
});

export const mapRepositoryNodeObservationRow = (
  row: RepositoryNodeObservationRow,
): RepositoryNodeObservation => repositoryNodeObservationSchema.parse({
  snapshotId: row.snapshot_id,
  nodeId: row.node_id,
  parentNodeId: row.parent_node_id,
  path: row.path,
  kind: row.kind,
  sha256: row.sha256,
  byteSize: row.byte_size,
  sourceStatus: row.source_status,
  role: row.role,
  documentKind: row.document_kind,
  documentFormat: row.document_format,
  contentEligible: row.content_eligible === 1,
  instructionClient: row.instruction_client,
  instructionScope: row.instruction_scope,
});

export const mapRepositoryLinkRow = (
  row: RepositoryLinkRow,
): RepositoryLink => repositoryLinkSchema.parse({
  id: row.id,
  projectId: row.project_id,
  snapshotId: row.snapshot_id,
  fromNodeId: row.from_node_id,
  toRecordId: row.to_record_id,
  toNodeId: row.to_node_id,
  kind: row.kind,
  basis: row.basis,
  createdAt: row.created_at,
});

export const mapRepositoryRefreshReviewRow = (
  row: RepositoryRefreshReviewRow,
): RepositoryRefreshReview => repositoryRefreshReviewSchema.parse({
  projectId: row.project_id,
  sourceId: row.source_id,
  snapshotId: row.snapshot_id,
  state: row.state,
  selectedOperationIds: parseStoredJson(row.selected_operation_ids_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  decidedAt: row.decided_at,
});
