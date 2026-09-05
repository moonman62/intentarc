import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProjectNotFoundError } from "../domain/errors.js";
import type {
  RepositoryLink,
  RepositoryDocumentKind,
  RepositoryNodeObservation,
  RepositoryObservationCandidate,
  RepositoryRefreshReview,
  RepositorySnapshot,
  RepositorySource,
  RepositorySourceStatus,
} from "../domain/repository-index-model.js";
import type {
  ImportExclusionReason,
  RepositorySourceRole,
} from "../domain/import-model.js";
import {
  absoluteRepositoryRootSchema,
  normalizedRepositoryPathSchema,
  repositoryObservationCandidateSchema,
  repositoryRefreshReviewSchema,
  repositorySourceStatusSchema,
} from "../domain/repository-index-schemas.js";
import type { IntentArcDatabase } from "./database.js";
import {
  mapRepositoryLinkRow,
  mapRepositoryNodeObservationRow,
  mapRepositoryRefreshReviewRow,
  mapRepositorySnapshotRow,
  mapRepositorySourceRow,
  type RepositoryLinkRow,
  type RepositoryNodeObservationRow,
  type RepositoryRefreshReviewRow,
  type RepositorySnapshotRow,
  type RepositorySourceRow,
} from "./repository-index-mappers.js";

export type RepositoryIndexStoreIdPrefix =
  | "repository-source"
  | "repository-snapshot"
  | "repository-node"
  | "repository-link";

export interface EnsureRepositorySourceInput {
  readonly projectId: string;
  readonly root: string;
  readonly canonicalSubpath: string | null;
  readonly repositoryIdentity: string;
  readonly status: RepositorySourceStatus;
}

export interface CreateRepositoryCandidateInput {
  readonly projectId: string;
  readonly baseProjectRevision: number;
  readonly candidate: RepositoryObservationCandidate;
  readonly identityTransfers?: readonly RepositoryNodeIdentityTransfer[];
}

export interface RepositoryNodeIdentityTransfer {
  readonly nodeId: string;
  readonly previousPath: string;
  readonly currentPath: string;
}

export interface SaveRepositoryReviewSelectionInput {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly selectedOperationIds: string[];
}

export interface PromoteRepositoryCandidateInput {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly decidedAt: string;
  readonly appliedAt: string;
}

export interface RepositoryExplorerStoreFilter {
  readonly search?: string;
  readonly relevance?: "current_task";
  readonly changed?: boolean;
  readonly category?: "documentation" | "test";
  readonly documentKind?: RepositoryDocumentKind;
  readonly role?: RepositorySourceRole;
  readonly unlinked?: boolean;
  readonly contextIncluded?: boolean;
  readonly state?: "current" | "stale" | "unavailable" | "excluded";
  readonly exclusionReason?: ImportExclusionReason;
}

export interface RepositoryExplorerStoreCursor {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly nodeId: string;
}

export interface ListRepositoryExplorerChildrenInput {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly parentNodeId: string | null;
  readonly limit: number;
  readonly after?: RepositoryExplorerStoreCursor;
  readonly currentTaskId: string | null;
  readonly contextPackId: string | null;
  readonly filter: RepositoryExplorerStoreFilter;
}

export interface RepositoryExplorerStoreItem {
  readonly observation: RepositoryNodeObservation;
  readonly childCount: number;
  readonly changed: boolean;
  readonly linked: boolean;
  readonly currentTaskRelevant: boolean;
  readonly contextIncluded: boolean;
}

export interface RepositoryIndexStore {
  getSource(projectId: string): RepositorySource | null;
  ensureSource(input: EnsureRepositorySourceInput): RepositorySource;
  getSnapshot(snapshotId: string): RepositorySnapshot | null;
  getReview(snapshotId: string): RepositoryRefreshReview | null;
  getCurrentSnapshot(projectId: string): RepositorySnapshot | null;
  getPendingReview(projectId: string): RepositoryRefreshReview | null;
  getActionableReview(projectId: string): RepositoryRefreshReview | null;
  getObservation(snapshotId: string, nodeId: string): RepositoryNodeObservation | null;
  listObservations(snapshotId: string): RepositoryNodeObservation[];
  listLinks(projectId: string): RepositoryLink[];
  listExplorerChildren(
    input: ListRepositoryExplorerChildrenInput,
  ): RepositoryExplorerStoreItem[];
  createCandidate(input: CreateRepositoryCandidateInput): RepositoryRefreshReview;
  saveReviewSelection(input: SaveRepositoryReviewSelectionInput): RepositoryRefreshReview;
  promoteCandidate(input: PromoteRepositoryCandidateInput): RepositorySnapshot;
  conflictCandidate(snapshotId: string, decidedAt: string): RepositoryRefreshReview;
  cancelCandidate(snapshotId: string, decidedAt: string): RepositoryRefreshReview;
}

export interface RepositoryIndexStoreDependencies {
  readonly now?: () => string;
  readonly newId?: (prefix: RepositoryIndexStoreIdPrefix) => string;
}

export class RepositorySourceConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly sourceId: string,
  ) {
    super(`Repository source conflicts with its registration: ${sourceId}`);
    this.name = "RepositorySourceConflictError";
  }
}

export class RepositoryRefreshConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly snapshotId: string,
    readonly expectedBaseSnapshotId: string | null,
    readonly currentSnapshotId: string | null,
  ) {
    super(`Repository refresh base is stale: ${snapshotId}`);
    this.name = "RepositoryRefreshConflictError";
  }
}

export class RepositoryRefreshStateError extends Error {
  constructor(readonly snapshotId: string) {
    super(`Repository refresh is not pending: ${snapshotId}`);
    this.name = "RepositoryRefreshStateError";
  }
}

const canonicalIdentifierSchema = z.string().min(1).refine(
  (value) => value === value.trim(),
  { message: "Identifier must use canonical surrounding whitespace" },
);
const timestampSchema = z.iso.datetime();
const nonNegativeIntegerSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);

const ensureRepositorySourceInputSchema = z.object({
  projectId: canonicalIdentifierSchema,
  root: absoluteRepositoryRootSchema,
  canonicalSubpath: normalizedRepositoryPathSchema.nullable(),
  repositoryIdentity: canonicalIdentifierSchema,
  status: repositorySourceStatusSchema,
}).strict();

const createRepositoryCandidateInputSchema = z.object({
  projectId: canonicalIdentifierSchema,
  baseProjectRevision: nonNegativeIntegerSchema,
  candidate: repositoryObservationCandidateSchema,
  identityTransfers: z.array(z.object({
    nodeId: canonicalIdentifierSchema,
    previousPath: normalizedRepositoryPathSchema,
    currentPath: normalizedRepositoryPathSchema,
  }).strict()).optional().default([]),
}).strict();

const saveRepositoryReviewSelectionInputSchema = z.object({
  projectId: canonicalIdentifierSchema,
  snapshotId: canonicalIdentifierSchema,
  selectedOperationIds: z.array(canonicalIdentifierSchema).refine(
    (values) => new Set(values).size === values.length,
    { message: "Selected operation identifiers must be unique" },
  ),
}).strict();

const promoteRepositoryCandidateInputSchema = z.object({
  projectId: canonicalIdentifierSchema,
  snapshotId: canonicalIdentifierSchema,
  decidedAt: timestampSchema,
  appliedAt: timestampSchema,
}).strict();

const ordinalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeCounts = (
  entries: readonly { key: string; count: number }[],
): Record<string, number> => Object.fromEntries(
  [...entries]
    .sort((left, right) => ordinalCompare(left.key, right.key))
    .reduce<{ key: string; count: number }[]>((counts, entry) => {
      const existing = counts.find(({ key }) => key === entry.key);
      if (existing) existing.count += entry.count;
      else counts.push({ ...entry });
      return counts;
    }, [])
    .map(({ key, count }) => [key, count]),
);

const normalizeCountRecord = (
  counts: Readonly<Record<string, number>>,
): Record<string, number> => Object.fromEntries(
  Object.entries(counts).sort(([left], [right]) => ordinalCompare(left, right)),
);

export const createRepositoryIndexStore = (
  database: IntentArcDatabase,
  dependencies: RepositoryIndexStoreDependencies = {},
): RepositoryIndexStore => {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newId = dependencies.newId ??
    ((prefix: RepositoryIndexStoreIdPrefix) => `${prefix}-${randomUUID()}`);

  const sourceColumns = `
    id, project_id, root, canonical_subpath, repository_identity, status,
    current_snapshot_id, created_at, updated_at
  `;
  const snapshotColumns = `
    id, source_id, project_id, state, base_snapshot_id, base_project_revision,
    branch, head, fingerprint, scanner_version, ruleset_version,
    warning_counts_json, exclusion_counts_json, finding_counts_json,
    created_at, decided_at, applied_at
  `;
  const observationColumns = `
    snapshot_id, node_id, source_id, parent_node_id, path, kind, sha256, byte_size,
    source_status, role, document_kind, document_format, content_eligible,
    instruction_client, instruction_scope
  `;
  const linkColumns = `
    id, project_id, snapshot_id, from_node_id, to_record_id, to_node_id,
    kind, basis, created_at
  `;
  const reviewColumns = `
    project_id, source_id, snapshot_id, state,
    selected_operation_ids_json, created_at, updated_at, decided_at
  `;

  const selectProject = database.prepare(
    "SELECT id FROM projects WHERE id = ?",
  );
  const selectSourceByProject = database.prepare(`
    SELECT ${sourceColumns}
    FROM repository_sources
    WHERE project_id = ?
  `);
  const insertSource = database.prepare(`
    INSERT INTO repository_sources (
      id, project_id, root, canonical_subpath, repository_identity, status,
      current_snapshot_id, created_at, updated_at
    ) VALUES (
      @id, @projectId, @root, @canonicalSubpath, @repositoryIdentity, @status,
      NULL, @createdAt, @updatedAt
    )
  `);
  const selectSnapshotById = database.prepare(`
    SELECT ${snapshotColumns}
    FROM repository_snapshots
    WHERE id = ?
  `);
  const selectCurrentSnapshot = database.prepare(`
    SELECT
      snapshots.id AS id,
      snapshots.source_id AS source_id,
      snapshots.project_id AS project_id,
      snapshots.state AS state,
      snapshots.base_snapshot_id AS base_snapshot_id,
      snapshots.base_project_revision AS base_project_revision,
      snapshots.branch AS branch,
      snapshots.head AS head,
      snapshots.fingerprint AS fingerprint,
      snapshots.scanner_version AS scanner_version,
      snapshots.ruleset_version AS ruleset_version,
      snapshots.warning_counts_json AS warning_counts_json,
      snapshots.exclusion_counts_json AS exclusion_counts_json,
      snapshots.finding_counts_json AS finding_counts_json,
      snapshots.created_at AS created_at,
      snapshots.decided_at AS decided_at,
      snapshots.applied_at AS applied_at
    FROM repository_sources AS sources
    JOIN repository_snapshots AS snapshots
      ON snapshots.id = sources.current_snapshot_id
    WHERE sources.project_id = ?
  `);
  const selectReviewBySnapshot = database.prepare(`
    SELECT ${reviewColumns}
    FROM repository_refresh_reviews
    WHERE snapshot_id = ?
  `);
  const selectPendingReview = database.prepare(`
    SELECT ${reviewColumns}
    FROM repository_refresh_reviews
    WHERE project_id = ? AND state = 'pending'
    ORDER BY created_at COLLATE BINARY ASC, snapshot_id COLLATE BINARY ASC
    LIMIT 1
  `);
  const selectActionableReview = database.prepare(`
    SELECT ${reviewColumns}
    FROM repository_refresh_reviews
    WHERE project_id = ? AND state IN ('pending', 'conflicted')
    ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,
      created_at COLLATE BINARY DESC, snapshot_id COLLATE BINARY DESC
    LIMIT 1
  `);
  const selectObservations = database.prepare(`
    SELECT ${observationColumns}
    FROM repository_node_observations
    WHERE snapshot_id = ?
    ORDER BY path COLLATE BINARY ASC, node_id COLLATE BINARY ASC
  `);
  const selectObservation = database.prepare(`
    SELECT ${observationColumns}
    FROM repository_node_observations
    WHERE snapshot_id = ? AND node_id = ?
  `);
  const selectLinks = database.prepare(`
    SELECT ${linkColumns}
    FROM repository_links
    WHERE project_id = ?
    ORDER BY snapshot_id COLLATE BINARY ASC,
      from_node_id COLLATE BINARY ASC, id COLLATE BINARY ASC
  `);
  const selectBaseObservations = database.prepare(`
    SELECT ${observationColumns}
    FROM repository_node_observations
    WHERE snapshot_id = ?
  `);
  const insertSnapshot = database.prepare(`
    INSERT INTO repository_snapshots (
      id, source_id, project_id, state, base_snapshot_id,
      base_project_revision, branch, head, fingerprint, scanner_version,
      ruleset_version, warning_counts_json, exclusion_counts_json,
      finding_counts_json, created_at, decided_at, applied_at
    ) VALUES (
      @id, @sourceId, @projectId, 'candidate', @baseSnapshotId,
      @baseProjectRevision, @branch, @head, @fingerprint, @scannerVersion,
      @rulesetVersion, @warningCountsJson, @exclusionCountsJson,
      @findingCountsJson, @createdAt, NULL, NULL
    )
  `);
  const insertNode = database.prepare(`
    INSERT INTO repository_nodes (id, source_id, kind, created_at)
    VALUES (@id, @sourceId, @kind, @createdAt)
  `);
  const insertObservation = database.prepare(`
    INSERT INTO repository_node_observations (
      snapshot_id, node_id, source_id, parent_node_id, path, kind, sha256,
      byte_size, source_status, role, document_kind, document_format,
      content_eligible, instruction_client, instruction_scope
    ) VALUES (
      @snapshotId, @nodeId, @sourceId, @parentNodeId, @path, @kind, @sha256,
      @byteSize, @sourceStatus, @role, @documentKind, @documentFormat,
      @contentEligible, @instructionClient, @instructionScope
    )
  `);
  const insertLink = database.prepare(`
    INSERT INTO repository_links (
      id, project_id, snapshot_id, source_id, from_node_id, to_record_id,
      to_node_id, kind, basis, created_at
    ) VALUES (
      @id, @projectId, @snapshotId, @sourceId, @fromNodeId, @toRecordId,
      @toNodeId, @kind, @basis, @createdAt
    )
  `);
  const insertReview = database.prepare(`
    INSERT INTO repository_refresh_reviews (
      project_id, source_id, snapshot_id, state,
      selected_operation_ids_json, created_at, updated_at, decided_at
    ) VALUES (
      @projectId, @sourceId, @snapshotId, 'pending', '[]',
      @createdAt, @createdAt, NULL
    )
  `);
  const updateReviewSelection = database.prepare(`
    UPDATE repository_refresh_reviews
    SET selected_operation_ids_json = @selectedOperationIdsJson,
      updated_at = @updatedAt
    WHERE project_id = @projectId
      AND snapshot_id = @snapshotId
      AND state = 'pending'
  `);
  const acceptSnapshot = database.prepare(`
    UPDATE repository_snapshots
    SET state = 'accepted', decided_at = @decidedAt, applied_at = @appliedAt
    WHERE id = @snapshotId AND project_id = @projectId AND state = 'candidate'
  `);
  const setCurrentSnapshot = database.prepare(`
    UPDATE repository_sources
    SET current_snapshot_id = @snapshotId, updated_at = @appliedAt
    WHERE id = @sourceId AND project_id = @projectId
  `);
  const applyReview = database.prepare(`
    UPDATE repository_refresh_reviews
    SET state = 'applied', updated_at = @appliedAt, decided_at = @decidedAt
    WHERE snapshot_id = @snapshotId
      AND project_id = @projectId
      AND state = 'pending'
  `);
  const discardSnapshot = database.prepare(`
    UPDATE repository_snapshots
    SET state = 'discarded', decided_at = @decidedAt
    WHERE id = @snapshotId AND state = 'candidate'
  `);
  const cancelReview = database.prepare(`
    UPDATE repository_refresh_reviews
    SET state = 'cancelled', updated_at = @decidedAt, decided_at = @decidedAt
    WHERE snapshot_id = @snapshotId AND state IN ('pending', 'conflicted')
  `);
  const conflictReview = database.prepare(`
    UPDATE repository_refresh_reviews
    SET state = 'conflicted', updated_at = @decidedAt, decided_at = @decidedAt
    WHERE snapshot_id = @snapshotId AND state = 'pending'
  `);

  const getSource = (projectId: string): RepositorySource | null => {
    const row = selectSourceByProject.get(projectId) as
      | RepositorySourceRow
      | undefined;
    return row ? mapRepositorySourceRow(row) : null;
  };

  const getSnapshot = (snapshotId: string): RepositorySnapshot | null => {
    const row = selectSnapshotById.get(snapshotId) as
      | RepositorySnapshotRow
      | undefined;
    return row ? mapRepositorySnapshotRow(row) : null;
  };

  const getReview = (snapshotId: string): RepositoryRefreshReview | null => {
    const row = selectReviewBySnapshot.get(snapshotId) as
      | RepositoryRefreshReviewRow
      | undefined;
    return row ? mapRepositoryRefreshReviewRow(row) : null;
  };

  const ensureSourceInsideTransaction = (
    input: EnsureRepositorySourceInput,
  ): RepositorySource => {
    if (!selectProject.get(input.projectId)) {
      throw new ProjectNotFoundError(input.projectId);
    }
    const existing = getSource(input.projectId);
    if (existing) {
      if (
        existing.root !== input.root ||
        existing.canonicalSubpath !== input.canonicalSubpath ||
        existing.repositoryIdentity !== input.repositoryIdentity ||
        existing.status !== input.status
      ) {
        throw new RepositorySourceConflictError(input.projectId, existing.id);
      }
      return existing;
    }
    const timestamp = timestampSchema.parse(now());
    const sourceId = canonicalIdentifierSchema.parse(newId("repository-source"));
    insertSource.run({
      id: sourceId,
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const created = getSource(input.projectId);
    if (!created) throw new Error(`Created repository source could not be read: ${sourceId}`);
    return created;
  };

  const ensureSourceTransaction = database.transaction(
    (input: EnsureRepositorySourceInput) => ensureSourceInsideTransaction(input),
  );

  const createCandidateTransaction = database.transaction((
    input: z.infer<typeof createRepositoryCandidateInputSchema>,
  ): RepositoryRefreshReview => {
    const source = ensureSourceInsideTransaction({
      projectId: input.projectId,
      root: input.candidate.root,
      canonicalSubpath: input.candidate.canonicalSubpath,
      repositoryIdentity: input.candidate.repositoryIdentity,
      status: "available",
    });
    const pending = selectPendingReview.get(input.projectId) as
      | RepositoryRefreshReviewRow
      | undefined;
    if (pending) throw new RepositoryRefreshStateError(pending.snapshot_id);

    const timestamp = timestampSchema.parse(now());
    const snapshotId = canonicalIdentifierSchema.parse(newId("repository-snapshot"));
    insertSnapshot.run({
      id: snapshotId,
      sourceId: source.id,
      projectId: input.projectId,
      baseSnapshotId: source.currentSnapshotId,
      baseProjectRevision: input.baseProjectRevision,
      branch: input.candidate.branch,
      head: input.candidate.head,
      fingerprint: input.candidate.fingerprint,
      scannerVersion: input.candidate.scannerVersion,
      rulesetVersion: input.candidate.rulesetVersion,
      warningCountsJson: JSON.stringify(normalizeCounts(
        input.candidate.warnings.map(({ code, count }) => ({ key: code, count })),
      )),
      exclusionCountsJson: JSON.stringify(normalizeCounts(
        input.candidate.exclusions.map(({ reason, count }) => ({ key: reason, count })),
      )),
      findingCountsJson: JSON.stringify(normalizeCountRecord(
        input.candidate.findingCounts,
      )),
      createdAt: timestamp,
    });

    const baseRows = source.currentSnapshotId === null
      ? []
      : selectBaseObservations.all(source.currentSnapshotId) as RepositoryNodeObservationRow[];
    const reusableNodes = new Map(
      baseRows.map((row) => [row.path, row] as const),
    );
    const baseByNodeId = new Map(baseRows.map((row) => [row.node_id, row] as const));
    const candidateByPath = new Map(
      input.candidate.observations.map((observation) => [observation.path, observation] as const),
    );
    const evidence = new Set(
      (input.candidate.renameEvidence ?? []).map(
        ({ originalPath, path }) => `${originalPath}\0${path}`,
      ),
    );
    const transferNodes = new Set<string>();
    const transferPreviousPaths = new Set<string>();
    const transferCurrentPaths = new Set<string>();
    const transfersByCurrentPath = new Map<string, RepositoryNodeIdentityTransfer>();
    for (const transfer of input.identityTransfers) {
      const prior = baseByNodeId.get(transfer.nodeId);
      const current = candidateByPath.get(transfer.currentPath);
      const duplicate = transferNodes.has(transfer.nodeId) ||
        transferPreviousPaths.has(transfer.previousPath) ||
        transferCurrentPaths.has(transfer.currentPath);
      if (
        duplicate ||
        transfer.previousPath === transfer.currentPath ||
        !prior ||
        prior.source_id !== source.id ||
        prior.path !== transfer.previousPath ||
        !current ||
        current.kind !== prior.kind ||
        reusableNodes.has(transfer.currentPath) ||
        !evidence.has(`${transfer.previousPath}\0${transfer.currentPath}`)
      ) {
        throw new RepositoryRefreshStateError("invalid-identity-transfer");
      }
      transferNodes.add(transfer.nodeId);
      transferPreviousPaths.add(transfer.previousPath);
      transferCurrentPaths.add(transfer.currentPath);
      transfersByCurrentPath.set(transfer.currentPath, transfer);
    }
    const nodesByPath = new Map<string, { id: string; isNew: boolean }>();
    for (const observation of input.candidate.observations) {
      const reusable = reusableNodes.get(observation.path);
      const transferred = transfersByCurrentPath.get(observation.path);
      const reusableId = transferred?.nodeId ?? (
        reusable?.kind === observation.kind ? reusable.node_id : null
      );
      nodesByPath.set(observation.path, {
        id: reusableId ?? canonicalIdentifierSchema.parse(newId("repository-node")),
        isNew: reusableId === null,
      });
    }
    for (const observation of input.candidate.observations) {
      const node = nodesByPath.get(observation.path)!;
      if (node.isNew) {
        insertNode.run({
          id: node.id,
          sourceId: source.id,
          kind: observation.kind,
          createdAt: timestamp,
        });
      }
    }
    const orderedObservations = [...input.candidate.observations].sort(
      (left, right) => {
        const depth = left.path.split("/").length - right.path.split("/").length;
        return depth === 0 ? ordinalCompare(left.path, right.path) : depth;
      },
    );
    for (const observation of orderedObservations) {
      const lastSeparator = observation.path.lastIndexOf("/");
      const parentPath = lastSeparator === -1
        ? null
        : observation.path.slice(0, lastSeparator);
      insertObservation.run({
        snapshotId,
        nodeId: nodesByPath.get(observation.path)!.id,
        sourceId: source.id,
        parentNodeId: parentPath === null
          ? null
          : nodesByPath.get(parentPath)?.id ?? null,
        ...observation,
        contentEligible: observation.contentEligible ? 1 : 0,
      });
    }
    for (const link of input.candidate.links) {
      insertLink.run({
        id: canonicalIdentifierSchema.parse(newId("repository-link")),
        projectId: input.projectId,
        snapshotId,
        sourceId: source.id,
        fromNodeId: nodesByPath.get(link.fromPath)!.id,
        toRecordId: link.toRecordId,
        toNodeId: link.toPath === null ? null : nodesByPath.get(link.toPath)!.id,
        kind: link.kind,
        basis: link.basis,
        createdAt: timestamp,
      });
    }
    insertReview.run({
      projectId: input.projectId,
      sourceId: source.id,
      snapshotId,
      createdAt: timestamp,
    });
    const review = getReview(snapshotId);
    if (!review) throw new Error(`Created repository review could not be read: ${snapshotId}`);
    return review;
  });

  const saveSelectionTransaction = database.transaction((
    input: z.infer<typeof saveRepositoryReviewSelectionInputSchema>,
  ): RepositoryRefreshReview => {
    const updatedAt = timestampSchema.parse(now());
    const result = updateReviewSelection.run({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      selectedOperationIdsJson: JSON.stringify(input.selectedOperationIds),
      updatedAt,
    });
    if (result.changes !== 1) throw new RepositoryRefreshStateError(input.snapshotId);
    const review = getReview(input.snapshotId);
    if (!review) throw new RepositoryRefreshStateError(input.snapshotId);
    return repositoryRefreshReviewSchema.parse(review);
  });

  const promoteCandidateTransaction = database.transaction((
    input: z.infer<typeof promoteRepositoryCandidateInputSchema>,
  ): RepositorySnapshot => {
    const snapshot = getSnapshot(input.snapshotId);
    const review = getReview(input.snapshotId);
    const source = getSource(input.projectId);
    if (
      !snapshot || !review || !source ||
      snapshot.projectId !== input.projectId ||
      snapshot.sourceId !== source.id ||
      snapshot.state !== "candidate" ||
      review.projectId !== input.projectId ||
      review.state !== "pending"
    ) {
      throw new RepositoryRefreshStateError(input.snapshotId);
    }
    if (source.currentSnapshotId !== snapshot.baseSnapshotId) {
      throw new RepositoryRefreshConflictError(
        input.projectId,
        input.snapshotId,
        snapshot.baseSnapshotId,
        source.currentSnapshotId,
      );
    }
    if (acceptSnapshot.run(input).changes !== 1) {
      throw new RepositoryRefreshStateError(input.snapshotId);
    }
    if (setCurrentSnapshot.run({
      sourceId: source.id,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      appliedAt: input.appliedAt,
    }).changes !== 1) {
      throw new RepositoryRefreshStateError(input.snapshotId);
    }
    if (applyReview.run(input).changes !== 1) {
      throw new RepositoryRefreshStateError(input.snapshotId);
    }
    const accepted = getSnapshot(input.snapshotId);
    if (!accepted) throw new RepositoryRefreshStateError(input.snapshotId);
    return accepted;
  });

  const cancelCandidateTransaction = database.transaction((
    snapshotId: string,
    decided: string,
  ): RepositoryRefreshReview => {
    const snapshot = getSnapshot(snapshotId);
    const review = getReview(snapshotId);
    if (
      !snapshot || !review || snapshot.state !== "candidate" ||
      !["pending", "conflicted"].includes(review.state)
    ) {
      throw new RepositoryRefreshStateError(snapshotId);
    }
    if (discardSnapshot.run({ snapshotId, decidedAt: decided }).changes !== 1) {
      throw new RepositoryRefreshStateError(snapshotId);
    }
    if (cancelReview.run({ snapshotId, decidedAt: decided }).changes !== 1) {
      throw new RepositoryRefreshStateError(snapshotId);
    }
    const cancelled = getReview(snapshotId);
    if (!cancelled) throw new RepositoryRefreshStateError(snapshotId);
    return cancelled;
  });

  const conflictCandidateTransaction = database.transaction((
    snapshotId: string,
    decided: string,
  ): RepositoryRefreshReview => {
    const snapshot = getSnapshot(snapshotId);
    const review = getReview(snapshotId);
    if (!snapshot || !review || snapshot.state !== "candidate" || review.state !== "pending") {
      throw new RepositoryRefreshStateError(snapshotId);
    }
    if (conflictReview.run({ snapshotId, decidedAt: decided }).changes !== 1) {
      throw new RepositoryRefreshStateError(snapshotId);
    }
    const conflicted = getReview(snapshotId);
    if (!conflicted) throw new RepositoryRefreshStateError(snapshotId);
    return conflicted;
  });

  return {
    getSource,

    ensureSource(input: EnsureRepositorySourceInput): RepositorySource {
      const parsed = ensureRepositorySourceInputSchema.parse(input);
      return ensureSourceTransaction.immediate(parsed);
    },

    getSnapshot,

    getReview(snapshotId: string): RepositoryRefreshReview | null {
      return getReview(snapshotId);
    },

    getCurrentSnapshot(projectId: string): RepositorySnapshot | null {
      const row = selectCurrentSnapshot.get(projectId) as
        | RepositorySnapshotRow
        | undefined;
      return row ? mapRepositorySnapshotRow(row) : null;
    },

    getPendingReview(projectId: string): RepositoryRefreshReview | null {
      const row = selectPendingReview.get(projectId) as
        | RepositoryRefreshReviewRow
        | undefined;
      return row ? mapRepositoryRefreshReviewRow(row) : null;
    },

    getActionableReview(projectId: string): RepositoryRefreshReview | null {
      const row = selectActionableReview.get(projectId) as
        | RepositoryRefreshReviewRow
        | undefined;
      return row ? mapRepositoryRefreshReviewRow(row) : null;
    },

    getObservation(snapshotId: string, nodeId: string): RepositoryNodeObservation | null {
      const row = selectObservation.get(snapshotId, nodeId) as
        | RepositoryNodeObservationRow
        | undefined;
      return row ? mapRepositoryNodeObservationRow(row) : null;
    },

    listObservations(snapshotId: string): RepositoryNodeObservation[] {
      return (selectObservations.all(snapshotId) as RepositoryNodeObservationRow[])
        .map(mapRepositoryNodeObservationRow);
    },

    listLinks(projectId: string): RepositoryLink[] {
      return (selectLinks.all(projectId) as RepositoryLinkRow[])
        .map(mapRepositoryLinkRow);
    },

    listExplorerChildren(
      input: ListRepositoryExplorerChildrenInput,
    ): RepositoryExplorerStoreItem[] {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_001) {
        throw new RangeError("Repository Explorer query limit is outside its bounded range");
      }
      const parameters: Record<string, string | number | null> = {
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        parentNodeId: input.parentNodeId,
        limit: input.limit,
        currentTaskId: input.currentTaskId,
        contextPackId: input.contextPackId,
      };
      const recordLinkExists = (alias: string): string => `EXISTS (
        SELECT 1 FROM repository_links AS linked
        WHERE linked.snapshot_id = ${alias}.snapshot_id
          AND linked.from_node_id = ${alias}.node_id
          AND linked.to_record_id IS NOT NULL
      )`;
      const currentTaskExists = (alias: string): string => `EXISTS (
        SELECT 1 FROM repository_links AS task_link
        WHERE task_link.snapshot_id = ${alias}.snapshot_id
          AND task_link.from_node_id = ${alias}.node_id
          AND task_link.to_record_id = @currentTaskId
      )`;
      const contextExists = (alias: string): string => `(
        @contextPackId IS NOT NULL AND EXISTS (
          SELECT 1
          FROM repository_links AS context_link
          JOIN context_packs AS context_pack
            ON context_pack.id = @contextPackId
            AND context_pack.project_id = @projectId
          JOIN json_each(context_pack.content_json, '$.sourceRevisions') AS context_revision
          WHERE context_link.snapshot_id = ${alias}.snapshot_id
            AND context_link.from_node_id = ${alias}.node_id
            AND context_link.to_record_id IS NOT NULL
            AND json_extract(context_revision.value, '$.recordId') = context_link.to_record_id
        )
      )`;
      const changedExists = (alias: string): string => `NOT EXISTS (
        SELECT 1 FROM repository_node_observations AS previous
        WHERE previous.snapshot_id = snapshots.base_snapshot_id
          AND previous.node_id = ${alias}.node_id
          AND previous.path = ${alias}.path
          AND previous.kind = ${alias}.kind
          AND previous.sha256 IS ${alias}.sha256
          AND previous.byte_size = ${alias}.byte_size
          AND previous.source_status = ${alias}.source_status
          AND previous.role = ${alias}.role
          AND previous.document_kind IS ${alias}.document_kind
          AND previous.document_format IS ${alias}.document_format
          AND previous.content_eligible = ${alias}.content_eligible
          AND previous.instruction_client IS ${alias}.instruction_client
          AND previous.instruction_scope IS ${alias}.instruction_scope
      )`;
      const removedDescendantExists = (alias: string): string => `EXISTS (
        SELECT 1 FROM repository_node_observations AS previous_descendant
        WHERE previous_descendant.snapshot_id = snapshots.base_snapshot_id
          AND (previous_descendant.node_id = ${alias}.node_id
            OR substr(previous_descendant.path, 1, length(${alias}.path) + 1)
              = ${alias}.path || '/')
          AND NOT EXISTS (
            SELECT 1 FROM repository_node_observations AS current_descendant
            WHERE current_descendant.snapshot_id = ${alias}.snapshot_id
              AND current_descendant.node_id = previous_descendant.node_id
              AND (current_descendant.node_id = ${alias}.node_id
                OR substr(current_descendant.path, 1, length(${alias}.path) + 1)
                  = ${alias}.path || '/')
          )
      )`;
      const changedBranch = (alias: string): string =>
        `(${changedExists(alias)} OR ${removedDescendantExists(alias)})`;
      const predicates: string[] = [];
      const { filter } = input;
      if (filter.search !== undefined) {
        parameters.search = filter.search;
        predicates.push("instr(lower(candidate.path), lower(@search)) > 0");
      }
      if (filter.relevance === "current_task") predicates.push(currentTaskExists("candidate"));
      if (filter.changed !== undefined) {
        predicates.push(filter.changed
          ? changedBranch("candidate")
          : `NOT (${changedBranch("candidate")})`);
      }
      if (filter.category === "documentation") predicates.push("candidate.document_kind IS NOT NULL");
      if (filter.category === "test") {
        predicates.push("(candidate.role = 'test' OR candidate.document_kind = 'test_evidence')");
      }
      if (filter.documentKind !== undefined) {
        parameters.documentKind = filter.documentKind;
        predicates.push("candidate.document_kind = @documentKind");
      }
      if (filter.role !== undefined) {
        parameters.role = filter.role;
        predicates.push("candidate.role = @role");
      }
      if (filter.unlinked !== undefined) {
        predicates.push(filter.unlinked
          ? `NOT (${recordLinkExists("candidate")})`
          : recordLinkExists("candidate"));
      }
      if (filter.contextIncluded !== undefined) {
        predicates.push(filter.contextIncluded
          ? contextExists("candidate")
          : `NOT (${contextExists("candidate")})`);
      }
      if (filter.state === "stale") predicates.push("sources.status = 'detached'");
      if (filter.state === "current") predicates.push("sources.status = 'available'");
      if (filter.state === "unavailable") predicates.push("sources.status = 'unavailable'");

      const descendantPredicate = predicates.length === 0
        ? "1"
        : `EXISTS (
            SELECT 1 FROM repository_node_observations AS candidate
            WHERE candidate.snapshot_id = observations.snapshot_id
              AND (candidate.node_id = observations.node_id
                OR substr(candidate.path, 1, length(observations.path) + 1)
                  = observations.path || '/')
              AND ${predicates.join(" AND ")}
          )`;
      const branchFlag = (predicate: string): string => `EXISTS (
        SELECT 1 FROM repository_node_observations AS candidate
        WHERE candidate.snapshot_id = observations.snapshot_id
          AND (candidate.node_id = observations.node_id
            OR substr(candidate.path, 1, length(observations.path) + 1)
              = observations.path || '/')
          AND ${predicate}
      )`;
      const kindRank = "CASE observations.kind WHEN 'directory' THEN 0 ELSE 1 END";
      let afterPredicate = "1";
      if (input.after !== undefined) {
        parameters.afterKindRank = input.after.kind === "directory" ? 0 : 1;
        parameters.afterPath = input.after.path;
        parameters.afterNodeId = input.after.nodeId;
        afterPredicate = `(
          ${kindRank} > @afterKindRank OR
          (${kindRank} = @afterKindRank AND observations.path COLLATE BINARY > @afterPath) OR
          (${kindRank} = @afterKindRank AND observations.path = @afterPath
            AND observations.node_id COLLATE BINARY > @afterNodeId)
        )`;
      }
      const rows = database.prepare(`
        SELECT
          observations.snapshot_id, observations.node_id, observations.source_id,
          observations.parent_node_id, observations.path, observations.kind,
          observations.sha256, observations.byte_size, observations.source_status,
          observations.role, observations.document_kind, observations.document_format,
          observations.content_eligible, observations.instruction_client,
          observations.instruction_scope,
          (SELECT COUNT(*) FROM repository_node_observations AS children
            WHERE children.snapshot_id = observations.snapshot_id
              AND children.parent_node_id = observations.node_id) AS child_count,
          ${branchFlag(changedBranch("candidate"))} AS changed,
          ${branchFlag(recordLinkExists("candidate"))} AS linked,
          ${branchFlag(currentTaskExists("candidate"))} AS current_task_relevant,
          ${branchFlag(contextExists("candidate"))} AS context_included
        FROM repository_node_observations AS observations
        JOIN repository_snapshots AS snapshots
          ON snapshots.id = observations.snapshot_id
        JOIN repository_sources AS sources
          ON sources.id = snapshots.source_id
        WHERE observations.snapshot_id = @snapshotId
          AND snapshots.project_id = @projectId
          AND snapshots.state = 'accepted'
          AND sources.project_id = @projectId
          AND sources.current_snapshot_id = snapshots.id
          AND observations.parent_node_id IS @parentNodeId
          AND ${descendantPredicate}
          AND ${afterPredicate}
        ORDER BY ${kindRank}, observations.path COLLATE BINARY,
          observations.node_id COLLATE BINARY
        LIMIT @limit
      `).all(parameters) as Array<RepositoryNodeObservationRow & {
        child_count: number;
        changed: number;
        linked: number;
        current_task_relevant: number;
        context_included: number;
      }>;
      return rows.map((row) => ({
        observation: mapRepositoryNodeObservationRow(row),
        childCount: row.child_count,
        changed: row.changed === 1,
        linked: row.linked === 1,
        currentTaskRelevant: row.current_task_relevant === 1,
        contextIncluded: row.context_included === 1,
      }));
    },

    createCandidate(input: CreateRepositoryCandidateInput): RepositoryRefreshReview {
      const parsed = createRepositoryCandidateInputSchema.parse(input);
      return createCandidateTransaction.immediate(parsed);
    },

    saveReviewSelection(
      input: SaveRepositoryReviewSelectionInput,
    ): RepositoryRefreshReview {
      const parsed = saveRepositoryReviewSelectionInputSchema.parse(input);
      return saveSelectionTransaction.immediate(parsed);
    },

    promoteCandidate(input: PromoteRepositoryCandidateInput): RepositorySnapshot {
      const parsed = promoteRepositoryCandidateInputSchema.parse(input);
      return promoteCandidateTransaction.immediate(parsed);
    },

    conflictCandidate(snapshotId: string, decided: string): RepositoryRefreshReview {
      const parsedSnapshotId = canonicalIdentifierSchema.parse(snapshotId);
      const parsedDecidedAt = timestampSchema.parse(decided);
      return conflictCandidateTransaction.immediate(parsedSnapshotId, parsedDecidedAt);
    },

    cancelCandidate(snapshotId: string, decided: string): RepositoryRefreshReview {
      const parsedSnapshotId = canonicalIdentifierSchema.parse(snapshotId);
      const parsedDecidedAt = timestampSchema.parse(decided);
      return cancelCandidateTransaction.immediate(parsedSnapshotId, parsedDecidedAt);
    },
  };
};
