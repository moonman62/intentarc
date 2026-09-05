import { ProjectNotFoundError } from "../domain/errors.js";
import type {
  RepositoryRefreshReview,
  RepositoryObservationCandidate,
  RepositoryScanProgress,
  RepositorySnapshot,
  RepositorySnapshotDiff,
  RepositorySourceStatus,
} from "../domain/repository-index-model.js";
import type { ChangeOperation } from "../domain/index.js";
import type { GitStatusEntry } from "../import/git-repository.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  compareRepositoryObservations,
} from "../repository/observation-diff.js";
import {
  createRepositoryObservationScanner,
  type RepositoryObservationScanner,
} from "../repository/observation-scanner.js";
import type { GovernanceStore } from "../storage/governance-store.js";
import type {
  ProjectStore,
  RepositorySourceScanClaim,
} from "../storage/project-store.js";
import {
  RepositoryRefreshConflictError,
  RepositoryRefreshStateError,
  type RepositoryIndexStore,
  type RepositoryNodeIdentityTransfer,
} from "../storage/repository-index-store.js";

export interface RepositoryRefreshReviewView {
  readonly review: RepositoryRefreshReview;
  readonly snapshot: RepositorySnapshot;
  readonly diff: RepositorySnapshotDiff;
}

export interface RepositoryRefreshService {
  start(
    projectId: string,
    options: {
      signal: AbortSignal;
      onProgress(progress: RepositoryScanProgress): void;
    },
  ): Promise<RepositoryRefreshReviewView>;
  get(projectId: string): RepositoryRefreshReviewView | null;
  sourceStatus(projectId: string): RepositorySourceStatus | null;
  attach(
    projectId: string,
    input: {
      root: string;
      expectedProjectRevision: number;
      signal: AbortSignal;
      onProgress(progress: RepositoryScanProgress): void;
    },
  ): Promise<RepositoryRefreshReviewView>;
  updateSelection(input: {
    projectId: string;
    snapshotId: string;
    selectedOperationIds: string[];
  }): RepositoryRefreshReviewView;
  cancel(input: {
    projectId: string;
    snapshotId: string;
  }): RepositoryRefreshReviewView;
  apply(input: {
    projectId: string;
    snapshotId: string;
    expectedProjectRevision: number;
  }): Promise<RepositoryRefreshApplyResult>;
  retry(
    projectId: string,
    expectedProjectRevision: number,
    options: { signal: AbortSignal; onProgress(progress: RepositoryScanProgress): void },
  ): Promise<RepositoryRefreshReviewView>;
  locate(input: {
    projectId: string;
    root: string;
    expectedProjectRevision: number;
    signal: AbortSignal;
  }): Promise<{ projectRevision: number; requiresRefresh: true }>;
  detach(input: {
    projectId: string;
    expectedProjectRevision: number;
  }): { projectRevision: number; requiresRefresh: true };
}

export interface RepositoryRefreshApplyResult {
  readonly snapshotId: string;
  readonly projectRevision: number;
  readonly proposalId: string | null;
  readonly replayed: boolean;
}

export interface RepositoryRefreshServiceDependencies {
  readonly projectStore: Pick<
    ProjectStore,
    | "getProject"
    | "attachRepositorySource"
    | "locateRepositorySource"
    | "detachRepositorySource"
    | "markRepositorySourceUnavailable"
    | "reactivateRepositorySource"
  >;
  readonly store: Pick<
    RepositoryIndexStore,
    | "getSnapshot"
    | "getReview"
    | "getSource"
    | "getCurrentSnapshot"
    | "getPendingReview"
    | "getActionableReview"
    | "listObservations"
    | "createCandidate"
    | "saveReviewSelection"
    | "cancelCandidate"
    | "conflictCandidate"
    | "promoteCandidate"
  >;
  readonly proposalStore: Pick<
    GovernanceStore,
    "createRepositoryRefreshProposal" | "listProposals"
  >;
  readonly transaction: { run<Result>(operation: () => Result): Result };
  readonly scanner?: RepositoryObservationScanner;
  readonly compare?: typeof compareRepositoryObservations;
  readonly now?: () => string;
}

export class RepositoryRefreshUnavailableError extends Error {
  constructor(readonly projectId: string) {
    super("The project does not have an available primary repository.");
    this.name = "RepositoryRefreshUnavailableError";
  }
}

export class RepositoryRefreshSelectionError extends Error {
  constructor(readonly snapshotId: string) {
    super("Selected operation IDs must identify candidate semantic operations.");
    this.name = "RepositoryRefreshSelectionError";
  }
}

export class RepositoryRefreshInProgressError extends Error {
  constructor(readonly projectId: string) {
    super("A repository refresh is already in progress.");
    this.name = "RepositoryRefreshInProgressError";
  }
}

const gitEntriesFor = (
  evidence: readonly { originalPath: string; path: string }[] | undefined,
): GitStatusEntry[] => (evidence ?? []).map(({ originalPath, path }) => ({
  index: "R",
  worktree: " ",
  originalPath,
  path,
}));

export const createRepositoryRefreshService = ({
  projectStore,
  store,
  proposalStore,
  transaction,
  scanner = createRepositoryObservationScanner(),
  compare = compareRepositoryObservations,
  now = () => new Date().toISOString(),
}: RepositoryRefreshServiceDependencies): RepositoryRefreshService => {
  const viewFor = (review: RepositoryRefreshReview): RepositoryRefreshReviewView => {
    const snapshot = store.getSnapshot(review.snapshotId);
    if (!snapshot || snapshot.projectId !== review.projectId) {
      throw new RepositoryRefreshStateError(review.snapshotId);
    }
    const accepted = snapshot.baseSnapshotId === null
      ? []
      : store.listObservations(snapshot.baseSnapshotId);
    const candidate = store.listObservations(snapshot.id);
    return {
      review,
      snapshot,
      diff: compare(accepted, candidate, []),
    };
  };

  const pendingFor = (projectId: string): RepositoryRefreshReview | null =>
    store.getPendingReview(projectId);
  const actionableFor = (projectId: string): RepositoryRefreshReview | null =>
    store.getActionableReview(projectId);

  const sourceClaimFor = (
    expectedProjectRevision: number,
    source: NonNullable<ReturnType<typeof store.getSource>>,
  ): RepositorySourceScanClaim => ({
    id: source.id,
    projectId: source.projectId,
    root: source.root,
    canonicalSubpath: source.canonicalSubpath,
    repositoryIdentity: source.repositoryIdentity,
    status: source.status,
    currentSnapshotId: source.currentSnapshotId,
    expectedProjectRevision,
  });
  const sourceMatchesClaim = (
    source: ReturnType<typeof store.getSource>,
    claim: RepositorySourceScanClaim,
  ): boolean => source !== null &&
    source.id === claim.id &&
    source.projectId === claim.projectId &&
    source.root === claim.root &&
    source.canonicalSubpath === claim.canonicalSubpath &&
    source.repositoryIdentity === claim.repositoryIdentity &&
    source.status === claim.status &&
    source.currentSnapshotId === claim.currentSnapshotId;

  const inFlight = new Set<string>();
  const scanUnavailable = async (
    projectId: string,
    operation: () => Promise<RepositoryObservationCandidate>,
    claim: RepositorySourceScanClaim | null,
    persistUnavailable = true,
  ): Promise<RepositoryObservationCandidate> => {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof RepositoryImportError &&
        [
          "repository_not_found",
          "repository_root_invalid",
          "canonical_path_invalid",
        ].includes(error.code)
      ) {
        if (persistUnavailable && claim?.status === "available") {
          const outcome = projectStore.markRepositorySourceUnavailable(claim);
          if (outcome === "stale") {
            const currentSource = store.getSource(projectId);
            throw new RepositoryRefreshConflictError(
              projectId,
              "repository-source-unavailable",
              claim.currentSnapshotId,
              currentSource?.currentSnapshotId ?? null,
            );
          }
        }
        throw new RepositoryRefreshUnavailableError(projectId);
      }
      throw error;
    }
  };
  const conflict = (projectId: string, snapshotId: string): never => {
    const snapshot = store.getSnapshot(snapshotId);
    const source = store.getSource(projectId);
    throw new RepositoryRefreshConflictError(
      projectId,
      snapshotId,
      snapshot?.baseSnapshotId ?? null,
      source?.currentSnapshotId ?? null,
    );
  };
  const applyConflict = (projectId: string, snapshotId: string): never => {
    transaction.run(() => {
      const snapshot = store.getSnapshot(snapshotId);
      const review = store.getReview(snapshotId);
      if (
        snapshot?.projectId === projectId && snapshot.state === "candidate" &&
        review?.projectId === projectId && review.state === "pending"
      ) {
        store.conflictCandidate(snapshotId, now());
      }
    });
    return conflict(projectId, snapshotId);
  };

  const scanAndPersist = async (
    projectId: string,
    options: {
      signal: AbortSignal;
      onProgress(progress: RepositoryScanProgress): void;
    },
    expectedProjectRevision?: number,
  ): Promise<RepositoryRefreshReviewView> => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (
      expectedProjectRevision !== undefined &&
      project.revision !== expectedProjectRevision
    ) return conflict(projectId, "repository-refresh-retry");
    const sourceAtStart = store.getSource(projectId);
    const sourceClaim = sourceAtStart === null
      ? null
      : sourceClaimFor(project.revision, sourceAtStart);
    const pending = pendingFor(projectId);
    if (pending) return viewFor(pending);
    if (project.primaryRepositoryPath === null) {
      throw new RepositoryRefreshUnavailableError(projectId);
    }
    if (inFlight.has(projectId)) throw new RepositoryRefreshInProgressError(projectId);
    inFlight.add(projectId);
    try {
      options.signal.throwIfAborted();
      let processed = -1;
      const candidate = await scanUnavailable(projectId, () => scanner.scan({
          root: project.primaryRepositoryPath!,
          canonicalSubpath: sourceAtStart?.canonicalSubpath ?? null,
        }, {
          signal: options.signal,
          onProgress(progress) {
            if (
              progress.total < 0 || progress.processed < 0 ||
              progress.processed > progress.total || progress.processed < processed
            ) throw new Error("Invalid repository scan progress.");
            processed = progress.processed;
            options.onProgress(progress);
          },
        }), sourceClaim);
      options.signal.throwIfAborted();
      const currentProject = projectStore.getProject(projectId);
      if (
        !currentProject || currentProject.revision !== project.revision ||
        (expectedProjectRevision !== undefined &&
          currentProject.revision !== expectedProjectRevision)
      ) {
        return conflict(projectId, "repository-refresh-pending");
      }
      const baseSnapshot = store.getCurrentSnapshot(projectId);
      const accepted = baseSnapshot === null ? [] : store.listObservations(baseSnapshot.id);
      const comparison = compare(
        accepted,
        candidate.observations,
        gitEntriesFor(candidate.renameEvidence),
      );
      const identityTransfers: RepositoryNodeIdentityTransfer[] = comparison.groups
        .filter(({ kind }) => kind === "moved")
        .flatMap(({ entries }) => entries.map((entry) => ({
          nodeId: entry.previousNodeId!,
          previousPath: entry.previousPath!,
          currentPath: entry.currentPath!,
        })));
      options.signal.throwIfAborted();
      const review = transaction.run(() => {
        const transactionProject = projectStore.getProject(projectId);
        const transactionSource = store.getSource(projectId);
        if (
          !transactionProject || transactionProject.revision !== project.revision ||
          (sourceClaim === null
            ? transactionSource !== null
            : !sourceMatchesClaim(transactionSource, sourceClaim)) ||
          (sourceClaim !== null && (
            candidate.root !== sourceClaim.root ||
            candidate.canonicalSubpath !== sourceClaim.canonicalSubpath ||
            candidate.repositoryIdentity !== sourceClaim.repositoryIdentity
          ))
        ) return conflict(projectId, "repository-refresh-pending");
        if (
          sourceClaim?.status === "unavailable" &&
          !projectStore.reactivateRepositorySource(sourceClaim)
        ) return conflict(projectId, "repository-source-reactivate");
        return store.createCandidate({
          projectId,
          baseProjectRevision: project.revision,
          candidate,
          identityTransfers,
        });
      });
      return viewFor(review);
    } finally {
      inFlight.delete(projectId);
    }
  };

  const proposalFor = (projectId: string, snapshotId: string): { id: string } | null => {
    const summary = proposalStore.listProposals({ projectId }).find(
      ({ origin }) => origin.type === "repository_refresh" &&
        origin.repositorySnapshotId === snapshotId,
    );
    return summary ? { id: summary.id } : null;
  };

  return {
    async attach(projectId, input) {
      const project = projectStore.getProject(projectId);
      const sourceAtStart = store.getSource(projectId);
      if (
        !project || project.revision !== input.expectedProjectRevision ||
        (sourceAtStart !== null && sourceAtStart.status !== "detached")
      ) return conflict(projectId, "repository-source-attach");
      if (inFlight.has(projectId)) throw new RepositoryRefreshInProgressError(projectId);
      inFlight.add(projectId);
      try {
        input.signal.throwIfAborted();
        let processed = -1;
        const candidate = await scanUnavailable(projectId, () => scanner.scan({
          root: input.root,
          canonicalSubpath: sourceAtStart?.canonicalSubpath ?? null,
        }, {
          signal: input.signal,
          onProgress(progress) {
            if (
              progress.total < 0 || progress.processed < 0 ||
              progress.processed > progress.total || progress.processed < processed
            ) throw new Error("Invalid repository scan progress.");
            processed = progress.processed;
            input.onProgress(progress);
          },
        }), null, false);
        input.signal.throwIfAborted();
        await scanner.verify(candidate, input.signal);
        input.signal.throwIfAborted();
        const baseSnapshot = store.getCurrentSnapshot(projectId);
        const accepted = baseSnapshot === null ? [] : store.listObservations(baseSnapshot.id);
        const comparison = compare(
          accepted,
          candidate.observations,
          gitEntriesFor(candidate.renameEvidence),
        );
        const identityTransfers: RepositoryNodeIdentityTransfer[] = comparison.groups
          .filter(({ kind }) => kind === "moved")
          .flatMap(({ entries }) => entries.map((entry) => ({
            nodeId: entry.previousNodeId!,
            previousPath: entry.previousPath!,
            currentPath: entry.currentPath!,
          })));
        const review = transaction.run(() => {
          input.signal.throwIfAborted();
          const currentProject = projectStore.getProject(projectId);
          const currentSource = store.getSource(projectId);
          const sourceUnchanged = sourceAtStart === null
            ? currentSource === null
            : currentSource !== null &&
              currentSource.id === sourceAtStart.id &&
              currentSource.status === "detached" &&
              currentSource.root === sourceAtStart.root &&
              currentSource.canonicalSubpath === sourceAtStart.canonicalSubpath &&
              currentSource.repositoryIdentity === sourceAtStart.repositoryIdentity &&
              currentSource.currentSnapshotId === sourceAtStart.currentSnapshotId;
          if (
            !currentProject || currentProject.revision !== input.expectedProjectRevision ||
            !sourceUnchanged
          ) return conflict(projectId, "repository-source-attach");
          const pending = pendingFor(projectId);
          if (pending) store.cancelCandidate(pending.snapshotId, now());
          const updated = projectStore.attachRepositorySource({
            projectId,
            expectedProjectRevision: input.expectedProjectRevision,
            root: candidate.root,
            canonicalSubpath: candidate.canonicalSubpath,
            repositoryIdentity: candidate.repositoryIdentity,
          });
          return store.createCandidate({
            projectId,
            baseProjectRevision: updated.revision,
            candidate,
            identityTransfers,
          });
        });
        return viewFor(review);
      } finally {
        inFlight.delete(projectId);
      }
    },

    async start(projectId, options) {
      return scanAndPersist(projectId, options);
    },

    get(projectId) {
      const review = actionableFor(projectId);
      return review ? viewFor(review) : null;
    },

    sourceStatus(projectId) {
      return store.getSource(projectId)?.status ?? null;
    },

    updateSelection(input) {
      const pending = pendingFor(input.projectId);
      if (!pending || pending.snapshotId !== input.snapshotId) {
        throw new RepositoryRefreshStateError(input.snapshotId);
      }
      const view = viewFor(pending);
      const supported = new Set(
        view.diff.semanticOperations.map(({ operationId }) => operationId),
      );
      if (input.selectedOperationIds.some((operationId) => !supported.has(operationId))) {
        throw new RepositoryRefreshSelectionError(input.snapshotId);
      }
      return viewFor(store.saveReviewSelection(input));
    },

    cancel(input) {
      const review = actionableFor(input.projectId);
      if (!review || review.snapshotId !== input.snapshotId) {
        throw new RepositoryRefreshStateError(input.snapshotId);
      }
      return viewFor(store.cancelCandidate(input.snapshotId, now()));
    },

    async apply(input) {
      const existingSnapshot = store.getSnapshot(input.snapshotId);
      const existingReview = store.getReview(input.snapshotId);
      const replay =
        existingSnapshot?.projectId === input.projectId &&
        existingSnapshot.state === "accepted" && existingReview?.state === "applied" &&
        existingSnapshot.baseProjectRevision === input.expectedProjectRevision;
      const project = projectStore.getProject(input.projectId);
      const source = store.getSource(input.projectId);
      if (replay) {
        if (
          !project || project.revision !== input.expectedProjectRevision ||
          !source || source.status !== "available" ||
          project.primaryRepositoryPath === null ||
          source.id !== existingSnapshot.sourceId ||
          source.currentSnapshotId !== existingSnapshot.id
        ) return conflict(input.projectId, input.snapshotId);
        const scanned = await scanUnavailable(input.projectId, () => scanner.scan({
          root: source.root,
          canonicalSubpath: source.canonicalSubpath,
        }, {
          signal: new AbortController().signal,
          onProgress: () => undefined,
        }), sourceClaimFor(project.revision, source)).catch((error) => {
          if (error instanceof RepositoryRefreshUnavailableError) throw error;
          return conflict(input.projectId, input.snapshotId);
        });
        if (
          scanned.repositoryIdentity !== source.repositoryIdentity ||
          scanned.fingerprint !== existingSnapshot.fingerprint
        ) return conflict(input.projectId, input.snapshotId);
        await scanner.verify(scanned).catch(() =>
          conflict(input.projectId, input.snapshotId)
        );
        return transaction.run(() => {
          const currentSnapshot = store.getSnapshot(input.snapshotId);
          const currentReview = store.getReview(input.snapshotId);
          const currentProject = projectStore.getProject(input.projectId);
          const currentSource = store.getSource(input.projectId);
          if (
            !currentSnapshot || currentSnapshot.state !== "accepted" ||
            !currentReview || currentReview.state !== "applied" ||
            !currentProject || currentProject.revision !== input.expectedProjectRevision ||
            !currentSource || currentSource.status !== "available" ||
            currentSource.id !== currentSnapshot.sourceId ||
            currentSource.currentSnapshotId !== currentSnapshot.id ||
            currentSource.repositoryIdentity !== scanned.repositoryIdentity ||
            currentSnapshot.fingerprint !== scanned.fingerprint
          ) return conflict(input.projectId, input.snapshotId);
          const proposal = proposalFor(input.projectId, input.snapshotId);
          return {
            snapshotId: input.snapshotId,
            projectRevision: input.expectedProjectRevision,
            proposalId: proposal?.id ?? null,
            replayed: true,
          };
        });
      }
      const pending = pendingFor(input.projectId);
      if (
        !pending || pending.snapshotId !== input.snapshotId ||
        !existingSnapshot || existingSnapshot.state !== "candidate" ||
        !project || !source || source.status !== "available" ||
        project.primaryRepositoryPath === null ||
        project.revision !== input.expectedProjectRevision ||
        existingSnapshot.baseProjectRevision !== input.expectedProjectRevision ||
        source.currentSnapshotId !== existingSnapshot.baseSnapshotId
      ) return applyConflict(input.projectId, input.snapshotId);

      const scanned = await scanUnavailable(input.projectId, () => scanner.scan({
        root: source.root,
        canonicalSubpath: source.canonicalSubpath,
      }, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }), sourceClaimFor(project.revision, source)).catch((error) => {
        if (error instanceof RepositoryRefreshUnavailableError) throw error;
        return applyConflict(input.projectId, input.snapshotId);
      });
      if (
        scanned.repositoryIdentity !== source.repositoryIdentity ||
        scanned.fingerprint !== existingSnapshot.fingerprint
      ) return applyConflict(input.projectId, input.snapshotId);
      await scanner.verify(scanned).catch(() =>
        applyConflict(input.projectId, input.snapshotId)
      );

      const applied = transaction.run<RepositoryRefreshApplyResult | null>(() => {
        const snapshot = store.getSnapshot(input.snapshotId);
        const review = store.getReview(input.snapshotId);
        const currentProject = projectStore.getProject(input.projectId);
        const currentSource = store.getSource(input.projectId);
        if (
          !snapshot || snapshot.state !== "candidate" ||
          !review || review.state !== "pending" ||
          !currentProject || currentProject.revision !== input.expectedProjectRevision ||
          !currentSource || currentSource.status !== "available" ||
          currentSource.repositoryIdentity !== scanned.repositoryIdentity ||
          currentSource.currentSnapshotId !== snapshot.baseSnapshotId ||
          snapshot.fingerprint !== scanned.fingerprint
        ) {
          if (
            snapshot?.projectId === input.projectId && snapshot.state === "candidate" &&
            review?.projectId === input.projectId && review.state === "pending"
          ) store.conflictCandidate(input.snapshotId, now());
          return null;
        }
        const view = viewFor(review);
        const selected = new Set(review.selectedOperationIds);
        const operations: ChangeOperation[] = view.diff.semanticOperations.filter(
          ({ operationId }) => selected.has(operationId),
        );
        if (operations.length !== selected.size) {
          throw new RepositoryRefreshSelectionError(input.snapshotId);
        }
        const proposal = operations.length === 0 ? null :
          proposalStore.createRepositoryRefreshProposal({
            input: {
              projectId: input.projectId,
              repositorySnapshotId: input.snapshotId,
              baseProjectRevision: input.expectedProjectRevision,
              rationale: "Review repository-derived project meaning.",
              operations,
            },
            createdAt: now(),
          });
        store.promoteCandidate({
          projectId: input.projectId,
          snapshotId: input.snapshotId,
          decidedAt: now(),
          appliedAt: now(),
        });
        return {
          snapshotId: input.snapshotId,
          projectRevision: input.expectedProjectRevision,
          proposalId: proposal?.id ?? null,
          replayed: false,
        };
      });
      if (applied === null) return conflict(input.projectId, input.snapshotId);
      return applied;
    },

    retry(projectId, expectedProjectRevision, options) {
      return scanAndPersist(projectId, options, expectedProjectRevision);
    },

    async locate(input) {
      input.signal.throwIfAborted();
      const project = projectStore.getProject(input.projectId);
      const source = store.getSource(input.projectId);
      if (!project || !source || project.revision !== input.expectedProjectRevision) {
        return conflict(input.projectId, "repository-source-locate");
      }
      const observed = await scanUnavailable(input.projectId, () => scanner.scan({
        root: input.root,
        canonicalSubpath: source.canonicalSubpath,
      }, { signal: input.signal, onProgress: () => undefined }), null, false)
        .catch((error) => {
          if (error instanceof RepositoryRefreshUnavailableError) throw error;
          return conflict(input.projectId, "repository-source-locate");
        });
      input.signal.throwIfAborted();
      if (observed.repositoryIdentity !== source.repositoryIdentity) {
        return conflict(input.projectId, "repository-source-locate");
      }
      await scanner.verify(observed, input.signal).catch((error) => {
        input.signal.throwIfAborted();
        return conflict(input.projectId, "repository-source-locate");
      });
      input.signal.throwIfAborted();
      const updated = transaction.run(() => {
        input.signal.throwIfAborted();
        const currentProject = projectStore.getProject(input.projectId);
        const currentSource = store.getSource(input.projectId);
        if (
          !currentProject || currentProject.revision !== input.expectedProjectRevision ||
          !currentSource || currentSource.repositoryIdentity !== observed.repositoryIdentity
        ) return conflict(input.projectId, "repository-source-locate");
        const pending = pendingFor(input.projectId);
        if (pending) store.cancelCandidate(pending.snapshotId, now());
        return projectStore.locateRepositorySource({
          projectId: input.projectId,
          expectedProjectRevision: input.expectedProjectRevision,
          root: observed.root,
          repositoryIdentity: observed.repositoryIdentity,
        });
      });
      return { projectRevision: updated.revision, requiresRefresh: true };
    },

    detach(input) {
      return transaction.run(() => {
        const project = projectStore.getProject(input.projectId);
        const source = store.getSource(input.projectId);
        if (
          !project || !source || project.revision !== input.expectedProjectRevision ||
          source.status === "detached"
        ) return conflict(input.projectId, "repository-source-detach");
        const pending = pendingFor(input.projectId);
        if (pending) store.cancelCandidate(pending.snapshotId, now());
        const updated = projectStore.detachRepositorySource(input);
        return { projectRevision: updated.revision, requiresRefresh: true };
      });
    },
  };
};
