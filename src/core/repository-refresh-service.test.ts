import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNotFoundError } from "../domain/errors.js";
import type {
  RepositoryObservationCandidate,
  RepositoryObservationInput,
} from "../domain/repository-index-model.js";
import {
  RepositoryObservationDriftError,
  type RepositoryObservationScanner,
} from "../repository/observation-scanner.js";
import { RepositoryImportError } from "../import/errors.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createProjectStore, type ProjectStore } from "../storage/project-store.js";
import { createGovernanceStore, type GovernanceStore } from "../storage/governance-store.js";
import {
  createRepositoryIndexStore,
  type RepositoryIndexStore,
} from "../storage/repository-index-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  createRepositoryRefreshService,
  RepositoryRefreshUnavailableError,
} from "./repository-refresh-service.js";

const timestamp = "2026-08-02T12:00:00.000Z";

const markdown = (path: string, hash: string): RepositoryObservationInput => ({
  path,
  kind: "file",
  sha256: hash.repeat(64),
  byteSize: 24,
  sourceStatus: "tracked",
  role: "supporting_document",
  documentKind: "specification",
  documentFormat: "markdown",
  contentEligible: true,
  instructionClient: null,
  instructionScope: null,
});

const candidate = (
  observations: RepositoryObservationInput[],
  overrides: Partial<RepositoryObservationCandidate> = {},
): RepositoryObservationCandidate => ({
  root: "C:/projects/example",
  canonicalSubpath: null,
  repositoryIdentity: "git:example",
  branch: "main",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
  scannerVersion: "scanner-1",
  rulesetVersion: "rules-1",
  warnings: [{ code: "working_tree_dirty", count: 2 }],
  exclusions: [
    { path: null, reason: "known_secret_path", count: 2 },
    { path: "vendor", reason: "ignored", count: 3 },
    { path: "generated", reason: "ignored", count: 4 },
  ],
  findingCounts: {},
  observations,
  links: [],
  ...overrides,
});

const createIds = () => {
  const counts = new Map<string, number>();
  return (prefix: string): string => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
};

describe("repository refresh service", () => {
  let temporary: TemporaryDatabase | undefined;
  let database: IntentArcDatabase | undefined;
  let projects: ProjectStore | undefined;
  let index: RepositoryIndexStore | undefined;
  let governance: GovernanceStore | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporary) removeTemporaryDatabase(temporary);
    temporary = undefined;
  });

  const setup = () => {
    temporary = createTemporaryDatabase();
    database = openDatabase(temporary.path, { now: () => timestamp });
    const ids = createIds();
    projects = createProjectStore(database, { now: () => timestamp, newId: ids });
    index = createRepositoryIndexStore(database, { now: () => timestamp, newId: ids });
    governance = createGovernanceStore(database, { newId: ids });
    return { ids };
  };

  const scannerReturning = (value: RepositoryObservationCandidate) => ({
    scan: vi.fn(async () => value),
    verify: vi.fn(async () => undefined),
  }) satisfies RepositoryObservationScanner;

  const serviceWith = (scanner: RepositoryObservationScanner) =>
    createRepositoryRefreshService({
      projectStore: projects!,
      store: index!,
      proposalStore: governance!,
      transaction: {
        run: <Result>(operation: () => Result): Result =>
          database!.transaction(operation).immediate(),
      },
      scanner,
      now: () => timestamp,
    });

  const captureAttachAuthority = (projectId: string) => ({
    project: database!.prepare("SELECT * FROM projects WHERE id = ?").get(projectId),
    source: database!.prepare(
      "SELECT * FROM repository_sources WHERE project_id = ?",
    ).get(projectId),
    records: database!.prepare(
      "SELECT * FROM project_records WHERE project_id = ? ORDER BY rowid",
    ).all(projectId),
    audits: database!.prepare(
      "SELECT * FROM audit_events WHERE project_id = ? ORDER BY rowid",
    ).all(projectId),
    snapshots: database!.prepare(
      "SELECT * FROM repository_snapshots WHERE project_id = ? ORDER BY rowid",
    ).all(projectId),
    reviews: database!.prepare(
      "SELECT * FROM repository_refresh_reviews WHERE project_id = ? ORDER BY rowid",
    ).all(projectId),
    observations: database!.prepare(
      "SELECT repository_node_observations.* " +
      "FROM repository_node_observations " +
      "JOIN repository_snapshots " +
      "ON repository_snapshots.id = repository_node_observations.snapshot_id " +
      "WHERE repository_snapshots.project_id = ? " +
      "ORDER BY repository_node_observations.rowid",
    ).all(projectId),
  });

  it("rejects missing projects and projects without a primary repository before scanning", async () => {
    setup();
    const scanner = scannerReturning(candidate([]));
    const service = serviceWith(scanner);
    const signal = new AbortController().signal;

    await expect(service.start("missing", { signal, onProgress: () => undefined }))
      .rejects.toEqual(new ProjectNotFoundError("missing"));
    const project = projects!.createProject({ name: "No repository" });
    await expect(service.start(project.id, { signal, onProgress: () => undefined }))
      .rejects.toBeInstanceOf(RepositoryRefreshUnavailableError);
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it("attaches scanned evidence to the requested project and returns its first review", async () => {
    setup();
    const project = projects!.createProject({ name: "Attach target" });
    const observed = candidate([markdown("README.md", "a")], {
      root: "C:/verified/repository",
      repositoryIdentity: "git:verified",
    });
    const scanner = scannerReturning(observed);
    const service = serviceWith(scanner);

    const view = await service.attach(project.id, {
      root: observed.root,
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(view.review.projectId).toBe(project.id);
    expect(view.snapshot.baseProjectRevision).toBe(1);
    expect(projects!.getProject(project.id)).toMatchObject({
      id: project.id,
      revision: 1,
      primaryRepositoryPath: observed.root,
    });
    expect(index!.getSource(project.id)).toMatchObject({
      projectId: project.id,
      root: observed.root,
      repositoryIdentity: observed.repositoryIdentity,
      status: "available",
    });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(scanner.verify).toHaveBeenCalledWith(observed, expect.any(AbortSignal));

    await expect(service.attach(project.id, {
      root: "C:/other/repository",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
  });

  it("leaves the target project unmodified when attach scanning is cancelled", async () => {
    setup();
    const project = projects!.createProject({ name: "Cancelled attach" });
    const started = Promise.withResolvers<void>();
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async (_input, { signal }) => {
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      verify: vi.fn(async () => undefined),
    };
    const controller = new AbortController();
    const pending = serviceWith(scanner).attach(project.id, {
      root: "C:/cancelled/repository",
      expectedProjectRevision: 0,
      signal: controller.signal,
      onProgress: () => undefined,
    });
    await started.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(projects!.getProject(project.id)).toEqual(project);
    expect(index!.getSource(project.id)).toBeNull();
    expect(scanner.verify).not.toHaveBeenCalled();
  });

  it("rolls back the complete attach transaction when candidate persistence throws late", async () => {
    setup();
    const project = projects!.createProject({ name: "Rollback attach" });
    const before = captureAttachAuthority(project.id);
    const observedInside = Promise.withResolvers<ReturnType<typeof captureAttachAuthority>>();
    const createCandidate = vi.fn((
      input: Parameters<RepositoryIndexStore["createCandidate"]>[0],
    ) => {
      index!.createCandidate(input);
      observedInside.resolve(captureAttachAuthority(project.id));
      throw new Error("injected late candidate persistence failure");
    });
    const service = createRepositoryRefreshService({
      projectStore: projects!,
      store: { ...index!, createCandidate },
      proposalStore: governance!,
      transaction: {
        run: <Result>(operation: () => Result): Result =>
          database!.transaction(operation).immediate(),
      },
      scanner: scannerReturning(candidate([markdown("README.md", "a")], {
        root: "C:/verified/rollback",
        repositoryIdentity: "git:rollback",
      })),
      now: () => timestamp,
    });

    await expect(service.attach(project.id, {
      root: "C:/verified/rollback",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toThrow("injected late candidate persistence failure");

    const inside = await observedInside.promise;
    expect(inside.project).toMatchObject({
      revision: 1,
      primary_repository_path: "C:/verified/rollback",
    });
    expect(inside.source).toMatchObject({
      project_id: project.id,
      root: "C:/verified/rollback",
      repository_identity: "git:rollback",
      status: "available",
      current_snapshot_id: null,
    });
    expect(inside.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action_category: "repository_source_attached" }),
    ]));
    expect(inside.snapshots).toHaveLength(1);
    expect(inside.reviews).toHaveLength(1);
    expect(inside.observations.length).toBeGreaterThan(0);
    expect(createCandidate).toHaveBeenCalledTimes(1);
    expect(captureAttachAuthority(project.id)).toEqual(before);
  });

  it("rejects project revision drift after attach verification without attach writes", async () => {
    setup();
    const project = projects!.createProject({ name: "Project drift attach" });
    let stateAfterDrift: ReturnType<typeof captureAttachAuthority> | undefined;
    const scanner: RepositoryObservationScanner = {
      ...scannerReturning(candidate([markdown("README.md", "b")], {
        root: "C:/verified/project-drift",
        repositoryIdentity: "git:project-drift",
      })),
      verify: vi.fn(async () => {
        projects!.createRecord({
          projectId: project.id,
          kind: "task",
          status: "active",
          title: "Concurrent revision drift",
          body: "Advance the revision after scan verification.",
          sourceKind: "human",
          sourceRef: null,
        });
        stateAfterDrift = captureAttachAuthority(project.id);
      }),
    };

    await expect(serviceWith(scanner).attach(project.id, {
      root: "C:/verified/project-drift",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({
      name: "RepositoryRefreshConflictError",
      projectId: project.id,
      snapshotId: "repository-source-attach",
    });
    expect(stateAfterDrift).toBeDefined();
    expect(captureAttachAuthority(project.id)).toEqual(stateAfterDrift);
    expect(stateAfterDrift!.project).toMatchObject({
      revision: 1,
      primary_repository_path: null,
    });
    expect(stateAfterDrift!.source).toBeUndefined();
    expect(stateAfterDrift!.snapshots).toEqual([]);
    expect(stateAfterDrift!.reviews).toEqual([]);
    expect(stateAfterDrift!.audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action_category: "repository_source_attached" }),
    ]));
  });

  it("rejects source registration drift after attach verification without overwriting it", async () => {
    setup();
    const project = projects!.createProject({ name: "Source drift attach" });
    let stateAfterDrift: ReturnType<typeof captureAttachAuthority> | undefined;
    const scanner: RepositoryObservationScanner = {
      ...scannerReturning(candidate([markdown("README.md", "c")], {
        root: "C:/verified/source-drift",
        repositoryIdentity: "git:selected",
      })),
      verify: vi.fn(async () => {
        index!.ensureSource({
          projectId: project.id,
          root: "C:/concurrent/repository",
          canonicalSubpath: null,
          repositoryIdentity: "git:concurrent",
          status: "available",
        });
        stateAfterDrift = captureAttachAuthority(project.id);
      }),
    };

    await expect(serviceWith(scanner).attach(project.id, {
      root: "C:/verified/source-drift",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({
      name: "RepositoryRefreshConflictError",
      snapshotId: "repository-source-attach",
    });
    expect(stateAfterDrift).toBeDefined();
    expect(captureAttachAuthority(project.id)).toEqual(stateAfterDrift);
    expect(stateAfterDrift!.project).toMatchObject({
      revision: 0,
      primary_repository_path: null,
    });
    expect(stateAfterDrift!.source).toMatchObject({
      root: "C:/concurrent/repository",
      repository_identity: "git:concurrent",
      status: "available",
      current_snapshot_id: null,
    });
    expect(stateAfterDrift!.snapshots).toEqual([]);
    expect(stateAfterDrift!.reviews).toEqual([]);
    expect(stateAfterDrift!.audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action_category: "repository_source_attached" }),
    ]));
  });

  it("rejects current snapshot drift after attach verification without overwriting it", async () => {
    setup();
    const project = projects!.createProject({
      name: "Snapshot drift attach",
      primaryRepositoryPath: "C:/registered/repository",
    });
    const original = candidate([markdown("README.md", "d")], {
      root: "C:/registered/repository",
      repositoryIdentity: "git:registered",
      fingerprint: "1".repeat(64),
    });
    const baseline = serviceWith(scannerReturning(original));
    const first = await baseline.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await baseline.apply({
      projectId: project.id,
      snapshotId: first.snapshot.id,
      expectedProjectRevision: 0,
    });
    projects!.detachRepositorySource({
      projectId: project.id,
      expectedProjectRevision: 0,
    });
    const sourceAtStart = index!.getSource(project.id)!;
    expect(sourceAtStart).toMatchObject({
      status: "detached",
      currentSnapshotId: first.snapshot.id,
    });

    let stateAfterDrift: ReturnType<typeof captureAttachAuthority> | undefined;
    let driftSnapshotId = "";
    const replacement = candidate([markdown("README.md", "e")], {
      root: "C:/replacement/repository",
      repositoryIdentity: "git:replacement",
      fingerprint: "3".repeat(64),
    });
    const scanner: RepositoryObservationScanner = {
      ...scannerReturning(replacement),
      verify: vi.fn(async () => {
        database!.prepare(
          "UPDATE repository_sources SET status = 'available' WHERE project_id = ?",
        ).run(project.id);
        const drift = index!.createCandidate({
          projectId: project.id,
          baseProjectRevision: 1,
          candidate: candidate([markdown("README.md", "f")], {
            root: "C:/registered/repository",
            repositoryIdentity: "git:registered",
            fingerprint: "2".repeat(64),
          }),
        });
        index!.promoteCandidate({
          projectId: project.id,
          snapshotId: drift.snapshotId,
          decidedAt: timestamp,
          appliedAt: timestamp,
        });
        database!.prepare(
          "UPDATE repository_sources SET status = 'detached' WHERE project_id = ?",
        ).run(project.id);
        driftSnapshotId = drift.snapshotId;
        stateAfterDrift = captureAttachAuthority(project.id);
      }),
    };

    await expect(serviceWith(scanner).attach(project.id, {
      root: replacement.root,
      expectedProjectRevision: 1,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({
      name: "RepositoryRefreshConflictError",
      snapshotId: "repository-source-attach",
    });
    expect(stateAfterDrift).toBeDefined();
    expect(captureAttachAuthority(project.id)).toEqual(stateAfterDrift);
    expect(stateAfterDrift!.project).toMatchObject({
      revision: 1,
      primary_repository_path: null,
    });
    expect(stateAfterDrift!.source).toMatchObject({
      root: "C:/registered/repository",
      repository_identity: "git:registered",
      status: "detached",
      current_snapshot_id: driftSnapshotId,
    });
    expect(driftSnapshotId).not.toBe(first.snapshot.id);
    expect(stateAfterDrift!.audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action_category: "repository_source_attached" }),
    ]));
  });

  it("normalizes an inaccessible registered root to repository unavailable without exposing its path", async () => {
    setup();
    const project = projects!.createProject({
      name: "Missing repository",
      primaryRepositoryPath: "C:/private/missing-repository",
    });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async () => {
        throw new RepositoryImportError("repository_not_found", {
          path: "C:/private/missing-repository",
        });
      }),
      verify: vi.fn(async () => undefined),
    };

    await expect(serviceWith(scanner).start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toEqual(expect.objectContaining({
      name: "RepositoryRefreshUnavailableError",
      message: expect.not.stringContaining("C:/private"),
    }));
  });

  it.each(["start", "retry", "apply"] as const)(
    "persists an unavailable registered source during %s without changing accepted authority",
    async (operation) => {
      setup();
      const project = projects!.createProject({
        name: "Missing repository",
        primaryRepositoryPath: "C:/private/missing-repository",
      });
      const available = serviceWith(scannerReturning(candidate([
        markdown("README.md", "c"),
      ], { root: "C:/private/missing-repository" })));
      const initial = await available.start(project.id, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      await available.apply({
        projectId: project.id,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: 0,
      });
      const pending = operation === "apply"
        ? await available.start(project.id, {
            signal: new AbortController().signal,
            onProgress: () => undefined,
          })
        : null;
      const scanner: RepositoryObservationScanner = {
        scan: vi.fn(async () => {
          throw new RepositoryImportError("repository_not_found", {
            path: "C:/private/missing-repository",
          });
        }),
        verify: vi.fn(async () => undefined),
      };
      const unavailable = serviceWith(scanner);
      const attempt = operation === "start"
        ? unavailable.start(project.id, {
            signal: new AbortController().signal,
            onProgress: () => undefined,
          })
        : operation === "retry"
          ? unavailable.retry(project.id, 0, {
              signal: new AbortController().signal,
              onProgress: () => undefined,
            })
          : unavailable.apply({
              projectId: project.id,
              snapshotId: pending!.snapshot.id,
              expectedProjectRevision: 0,
            });

      await expect(attempt).rejects.toBeInstanceOf(RepositoryRefreshUnavailableError);
      expect(projects!.getProject(project.id)).toEqual(project);
      expect(index!.getSource(project.id)).toMatchObject({
        status: "unavailable",
        currentSnapshotId: initial.snapshot.id,
      });
      expect(unavailable.sourceStatus(project.id)).toBe("unavailable");
      expect(unavailable.sourceStatus("missing-project")).toBeNull();
      expect(index!.getCurrentSnapshot(project.id)?.id).toBe(initial.snapshot.id);
      if (pending) expect(index!.getReview(pending.snapshot.id)?.state).toBe("pending");
      expect(database!.prepare(`
        SELECT action_category, revision_before, revision_after
        FROM audit_events
        WHERE action_category = 'repository_source_unavailable'
      `).all()).toEqual([{
        action_category: "repository_source_unavailable",
        revision_before: 0,
        revision_after: 0,
      }]);
    },
  );

  it("does not mark the registered source unavailable when a proposed locate root is inaccessible", async () => {
    setup();
    const project = projects!.createProject({
      name: "Locate repository",
      primaryRepositoryPath: "C:/projects/example",
    });
    const available = serviceWith(scannerReturning(candidate([])));
    const pending = await available.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    available.cancel({ projectId: project.id, snapshotId: pending.snapshot.id });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async () => {
        throw new RepositoryImportError("repository_not_found", {
          path: "C:/wrong/location",
        });
      }),
      verify: vi.fn(async () => undefined),
    };

    await expect(serviceWith(scanner).locate({
      projectId: project.id,
      root: "C:/wrong/location",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RepositoryRefreshUnavailableError);
    expect(index!.getSource(project.id)?.status).toBe("available");
    expect(database!.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action_category = 'repository_source_unavailable'
    `).get()).toEqual({ count: 0 });
  });

  it("reactivates the exact unavailable source on Retry after explicitly cancelling a failed-apply candidate", async () => {
    setup();
    const project = projects!.createProject({
      name: "Recovered repository",
      primaryRepositoryPath: "C:/projects/example",
    });
    const observed = candidate([markdown("README.md", "c")]);
    const available = serviceWith(scannerReturning(observed));
    const initial = await available.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await available.apply({
      projectId: project.id,
      snapshotId: initial.snapshot.id,
      expectedProjectRevision: 0,
    });
    const sourceBefore = index!.getSource(project.id)!;
    const pending = await available.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const missing = serviceWith({
      scan: vi.fn(async () => {
        throw new RepositoryImportError("repository_not_found", { path: "repository" });
      }),
      verify: vi.fn(async () => undefined),
    });
    await expect(missing.apply({
      projectId: project.id,
      snapshotId: pending.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toBeInstanceOf(RepositoryRefreshUnavailableError);
    expect(index!.getSource(project.id)?.status).toBe("unavailable");
    expect(index!.getReview(pending.snapshot.id)?.state).toBe("pending");

    expect(missing.cancel({
      projectId: project.id,
      snapshotId: pending.snapshot.id,
    }).review.state).toBe("cancelled");
    const recovered = await serviceWith(scannerReturning({
      ...observed,
      fingerprint: "f".repeat(64),
    })).retry(project.id, 0, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(recovered.review.state).toBe("pending");
    expect(index!.getSource(project.id)).toMatchObject({
      id: sourceBefore.id,
      status: "available",
      currentSnapshotId: initial.snapshot.id,
    });
    expect(index!.getCurrentSnapshot(project.id)?.id).toBe(initial.snapshot.id);
    expect(projects!.getProject(project.id)).toEqual(project);
  });

  it("does not let a delayed missing-root failure degrade a concurrently relocated same-identity source", async () => {
    setup();
    const project = projects!.createProject({
      name: "Relocated repository",
      primaryRepositoryPath: "C:/projects/example",
    });
    const observed = candidate([]);
    const available = serviceWith(scannerReturning(observed));
    const initial = await available.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await available.apply({
      projectId: project.id,
      snapshotId: initial.snapshot.id,
      expectedProjectRevision: 0,
    });
    let rejectDelayed!: (reason: unknown) => void;
    const delayed = new Promise<RepositoryObservationCandidate>((_resolve, reject) => {
      rejectDelayed = reject;
    });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async ({ root }) => root === "C:/projects/example"
        ? delayed
        : { ...observed, root: "C:/mounted/example" }),
      verify: vi.fn(async () => undefined),
    };
    const recovery = serviceWith(scanner);
    const retry = recovery.retry(project.id, 0, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
    await expect(recovery.locate({
      projectId: project.id,
      root: "C:/mounted/example",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({ projectRevision: 1, requiresRefresh: true });
    rejectDelayed(new RepositoryImportError("repository_not_found", { path: "repository" }));

    await expect(retry).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getSource(project.id)).toMatchObject({
      root: "C:/mounted/example",
      status: "available",
      currentSnapshotId: initial.snapshot.id,
    });
    expect(database!.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action_category = 'repository_source_unavailable'
    `).get()).toEqual({ count: 0 });
  });

  it("persists only a completed scan, records the project revision, and returns aggregate-safe review facts", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    projects!.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Refresh",
      body: "Observe the repository.",
      sourceKind: "human",
      sourceRef: null,
    });
    const scanner = scannerReturning(candidate([markdown("README.md", "c")]));
    const service = serviceWith(scanner);

    const view = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(view.review.state).toBe("pending");
    expect(view.snapshot).toMatchObject({
      baseProjectRevision: 1,
      warningCounts: { working_tree_dirty: 2 },
      exclusionCounts: { ignored: 7, known_secret_path: 2 },
    });
    expect(view.diff.groups).toMatchObject([{
      kind: "added",
      entries: [{ currentPath: "README.md" }],
    }]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("C:/projects/example");
    expect(serialized).not.toContain("vendor");
    expect(serialized).not.toContain("generated");
    expect(scanner.scan).toHaveBeenCalledOnce();
  });

  it("persists no partial candidate when the user aborts an in-flight scan", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async (_input, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }),
      verify: vi.fn(async () => undefined),
    };
    const service = serviceWith(scanner);
    const controller = new AbortController();
    const pending = service.start(project.id, {
      signal: controller.signal,
      onProgress: () => undefined,
    });

    controller.abort(new DOMException("Cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(index!.getPendingReview(project.id)).toBeNull();
    expect(index!.getSource(project.id)).toBeNull();
  });

  it("reuses and reconstructs one pending review after restart without rescanning", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const firstScanner = scannerReturning(candidate([markdown("README.md", "c")]));
    const first = serviceWith(firstScanner);
    const created = await first.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const restartScanner = scannerReturning(candidate([]));
    const restarted = serviceWith(restartScanner);

    expect(restarted.get(project.id)).toEqual(created);
    await expect(restarted.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).resolves.toEqual(created);
    expect(restartScanner.scan).not.toHaveBeenCalled();
  });

  it("persists only supported selections and cancellation leaves accepted state and project revision unchanged", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const service = serviceWith(scannerReturning(candidate([markdown("README.md", "c")])));
    const view = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(() => service.updateSelection({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      selectedOperationIds: [view.diff.groups[0]!.entries[0]!.operationId],
    })).toThrowError(/semantic operation/i);
    expect(service.updateSelection({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      selectedOperationIds: [],
    }).review.selectedOperationIds).toEqual([]);

    const cancelled = service.cancel({
      projectId: project.id,
      snapshotId: view.snapshot.id,
    });
    expect(cancelled.review.state).toBe("cancelled");
    expect(cancelled.snapshot.state).toBe("discarded");
    expect(index!.getCurrentSnapshot(project.id)).toBeNull();
    expect(projects!.getProject(project.id)!.revision).toBe(0);
    expect(service.get(project.id)).toBeNull();
  });

  it("transfers exact Git-proven move identity and reconstructs the same move and operation ID after restart", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const initial = candidate([markdown("docs/old.md", "d")], {
      fingerprint: "1".repeat(64),
    });
    const initialReview = index!.createCandidate({
      projectId: project.id,
      baseProjectRevision: 0,
      candidate: initial,
    });
    index!.promoteCandidate({
      projectId: project.id,
      snapshotId: initialReview.snapshotId,
      decidedAt: timestamp,
      appliedAt: timestamp,
    });
    const moved = candidate([markdown("docs/new.md", "d")], {
      fingerprint: "2".repeat(64),
      renameEvidence: [{ originalPath: "docs/old.md", path: "docs/new.md" }],
    });
    const first = serviceWith(scannerReturning(moved));

    const created = await first.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const move = created.diff.groups[0]!.entries[0]!;
    expect(created.diff.groups.map(({ kind }) => kind)).toEqual(["moved"]);
    expect(move).toMatchObject({
      previousNodeId: expect.any(String),
      currentNodeId: expect.any(String),
      previousPath: "docs/old.md",
      currentPath: "docs/new.md",
    });
    expect(move.currentNodeId).toBe(move.previousNodeId);

    const reconstructed = serviceWith(scannerReturning(candidate([]))).get(project.id)!;
    expect(reconstructed.diff).toEqual(created.diff);
    expect(reconstructed.diff.groups[0]!.entries[0]!.operationId).toBe(move.operationId);
  });

  it("applies an index-only refresh atomically without changing project revision or creating a proposal", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const observed = candidate([markdown("README.md", "c")]);
    const service = serviceWith(scannerReturning(observed));
    const view = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    const result = await service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    });

    expect(result).toEqual({
      snapshotId: view.snapshot.id,
      projectRevision: 0,
      proposalId: null,
      replayed: false,
    });
    expect(index!.getCurrentSnapshot(project.id)?.id).toBe(view.snapshot.id);
    expect(index!.getReview(view.snapshot.id)?.state).toBe("applied");
    expect(projects!.getProject(project.id)?.revision).toBe(0);
    expect(governance!.listProposals({ projectId: project.id })).toEqual([]);

    await expect(service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).resolves.toEqual({
      snapshotId: view.snapshot.id,
      projectRevision: 0,
      proposalId: null,
      replayed: true,
    });
    await expect(service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 99,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
  });

  it("rejects replay after the project revision or accepted snapshot pointer advances", async () => {
    setup();
    const project = projects!.createProject({
      name: "Replay authority",
      primaryRepositoryPath: "C:/projects/example",
    });
    const firstCandidate = candidate([markdown("README.md", "c")], {
      fingerprint: "1".repeat(64),
    });
    const firstService = serviceWith(scannerReturning(firstCandidate));
    const first = await firstService.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await firstService.apply({
      projectId: project.id,
      snapshotId: first.snapshot.id,
      expectedProjectRevision: 0,
    });
    const secondCandidate = candidate([markdown("README.md", "d")], {
      fingerprint: "2".repeat(64),
    });
    const secondService = serviceWith(scannerReturning(secondCandidate));
    const second = await secondService.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await secondService.apply({
      projectId: project.id,
      snapshotId: second.snapshot.id,
      expectedProjectRevision: 0,
    });

    await expect(firstService.apply({
      projectId: project.id,
      snapshotId: first.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getCurrentSnapshot(project.id)?.id).toBe(second.snapshot.id);
    expect(governance!.listProposals({ projectId: project.id })).toEqual([]);

    projects!.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Advance authority",
      body: "Make the accepted replay revision stale.",
      sourceKind: "human",
      sourceRef: null,
    });
    await expect(secondService.apply({
      projectId: project.id,
      snapshotId: second.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
  });

  it("rejects replay when the source registration or current repository evidence drifts", async () => {
    setup();
    const project = projects!.createProject({
      name: "Replay source",
      primaryRepositoryPath: "C:/projects/example",
    });
    const accepted = candidate([markdown("README.md", "c")], {
      fingerprint: "1".repeat(64),
    });
    const service = serviceWith(scannerReturning(accepted));
    const view = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    });

    database!.prepare(`
      UPDATE repository_sources
      SET status = 'unavailable', repository_identity = 'git:changed'
      WHERE project_id = ?
    `).run(project.id);
    await expect(service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });

    database!.prepare(`
      UPDATE repository_sources
      SET status = 'available', repository_identity = 'git:example'
      WHERE project_id = ?
    `).run(project.id);
    const drifted = serviceWith(scannerReturning({
      ...accepted,
      fingerprint: "f".repeat(64),
    }));
    await expect(drifted.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(governance!.listProposals({ projectId: project.id })).toEqual([]);
  });

  it("creates one repository proposal and rolls it back when candidate promotion fails", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const operation = {
      operationId: "semantic-task",
      type: "create_record" as const,
      localRef: "semantic-task",
      kind: "task" as const,
      status: "provisional" as const,
      title: "Review repository meaning",
      body: "Confirm the repository-derived task.",
    };
    const compare = () => ({ groups: [], semanticOperations: [operation] });
    const scanner = scannerReturning(candidate([]));
    const normal = createRepositoryRefreshService({
      projectStore: projects!,
      store: index!,
      proposalStore: governance!,
      transaction: {
        run: <Result>(action: () => Result): Result =>
          database!.transaction(action).immediate(),
      },
      scanner,
      compare,
      now: () => timestamp,
    });
    const view = await normal.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    normal.updateSelection({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      selectedOperationIds: [operation.operationId],
    });
    const failing = createRepositoryRefreshService({
      projectStore: projects!,
      store: {
        ...index!,
        promoteCandidate: () => {
          throw new Error("late promotion failure");
        },
      },
      proposalStore: governance!,
      transaction: {
        run: <Result>(action: () => Result): Result =>
          database!.transaction(action).immediate(),
      },
      scanner,
      compare,
      now: () => timestamp,
    });

    await expect(failing.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toThrow("late promotion failure");
    expect(governance!.listProposals({ projectId: project.id })).toEqual([]);
    expect(index!.getSnapshot(view.snapshot.id)?.state).toBe("candidate");
    expect(index!.getReview(view.snapshot.id)?.state).toBe("pending");

    const applied = await normal.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    });
    expect(applied.proposalId).toEqual(expect.any(String));
    expect(governance!.listProposals({ projectId: project.id })).toHaveLength(1);
    await expect(normal.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).resolves.toMatchObject({ proposalId: applied.proposalId, replayed: true });
    expect(governance!.listProposals({ projectId: project.id })).toHaveLength(1);
  });

  it("retains a visible conflicted review when project revision or repository evidence is stale", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const observed = candidate([markdown("README.md", "c")]);
    const scanner = scannerReturning(observed);
    const service = serviceWith(scanner);
    const view = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    projects!.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Concurrent change",
      body: "Advance the project revision.",
      sourceKind: "human",
      sourceRef: null,
    });

    await expect(service.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getReview(view.snapshot.id)?.state).toBe("conflicted");
    expect(index!.getCurrentSnapshot(project.id)).toBeNull();

    const drifted = serviceWith(scannerReturning({
      ...observed,
      fingerprint: "f".repeat(64),
    }));
    await expect(drifted.apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 1,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getReview(view.snapshot.id)?.state).toBe("conflicted");
  });

  it("revalidates the completed candidate immediately before the apply transaction", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const observed = candidate([markdown("README.md", "c")]);
    const first = serviceWith(scannerReturning(observed));
    const view = await first.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async () => observed),
      verify: vi.fn(async () => {
        throw new RepositoryObservationDriftError("content_hash");
      }),
    };

    await expect(serviceWith(scanner).apply({
      projectId: project.id,
      snapshotId: view.snapshot.id,
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(scanner.verify).toHaveBeenCalledOnce();
    expect(index!.getReview(view.snapshot.id)?.state).toBe("conflicted");
    expect(index!.getCurrentSnapshot(project.id)).toBeNull();
  });

  it.each(["source", "project", "fingerprint", "verify"] as const)(
    "persists a matching pending review as conflicted on %s apply drift and recovers with a fresh candidate",
    async (drift) => {
      setup();
      const project = projects!.createProject({
        name: "Apply conflict",
        primaryRepositoryPath: "C:/projects/example",
      });
      const baseline = candidate([markdown("README.md", "c")], {
        fingerprint: "1".repeat(64),
      });
      const baselineService = serviceWith(scannerReturning(baseline));
      const initial = await baselineService.start(project.id, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      await baselineService.apply({
        projectId: project.id,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: 0,
      });
      const observed = candidate([markdown("README.md", "d")], {
        fingerprint: "2".repeat(64),
      });
      const pendingService = serviceWith(scannerReturning(observed));
      const pending = await pendingService.start(project.id, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      if (drift === "source") {
        database!.prepare(`
          UPDATE repository_sources SET repository_identity = 'git:changed'
          WHERE project_id = ?
        `).run(project.id);
      }
      if (drift === "project") {
        projects!.createRecord({
          projectId: project.id,
          kind: "task",
          status: "active",
          title: "Concurrent authority",
          body: "Advance the project revision before apply.",
          sourceKind: "human",
          sourceRef: null,
        });
      }
      const applyScanner: RepositoryObservationScanner = {
        scan: vi.fn(async () => drift === "fingerprint"
          ? { ...observed, fingerprint: "f".repeat(64) }
          : observed),
        verify: vi.fn(async () => {
          if (drift === "verify") throw new RepositoryObservationDriftError("content_hash");
        }),
      };
      const applying = serviceWith(applyScanner);

      await expect(applying.apply({
        projectId: project.id,
        snapshotId: pending.snapshot.id,
        expectedProjectRevision: 0,
      })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
      expect(index!.getReview(pending.snapshot.id)?.state).toBe("conflicted");
      expect(index!.getCurrentSnapshot(project.id)?.id).toBe(initial.snapshot.id);
      expect(serviceWith(scannerReturning(observed)).get(project.id)?.review.state)
        .toBe("conflicted");

      if (drift === "source") {
        database!.prepare(`
          UPDATE repository_sources SET repository_identity = 'git:example'
          WHERE project_id = ?
        `).run(project.id);
      }
      expect(applying.cancel({
        projectId: project.id,
        snapshotId: pending.snapshot.id,
      }).review.state).toBe("cancelled");
      const freshObserved = { ...observed, fingerprint: "3".repeat(64) };
      const fresh = await serviceWith(scannerReturning(freshObserved)).start(project.id, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      expect(fresh.review.state).toBe("pending");
      expect(index!.getCurrentSnapshot(project.id)?.id).toBe(initial.snapshot.id);
    },
  );

  it("does not conflict an unrelated pending review for a pseudo or foreign apply target", async () => {
    setup();
    const project = projects!.createProject({
      name: "Unrelated apply",
      primaryRepositoryPath: "C:/projects/example",
    });
    const service = serviceWith(scannerReturning(candidate([])));
    const pending = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    await expect(service.apply({
      projectId: project.id,
      snapshotId: "repository-refresh-retry",
      expectedProjectRevision: 0,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getReview(pending.snapshot.id)?.state).toBe("pending");
  });

  it("binds retry to the expected revision at scan start and before candidate persistence", async () => {
    setup();
    const project = projects!.createProject({
      name: "Retry revision",
      primaryRepositoryPath: "C:/projects/example",
    });
    projects!.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Existing revision",
      body: "Retry must reject revision zero.",
      sourceKind: "human",
      sourceRef: null,
    });
    const neverScan = scannerReturning(candidate([]));
    await expect(serviceWith(neverScan).retry(
      project.id,
      0,
      { signal: new AbortController().signal, onProgress: () => undefined },
    )).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(neverScan.scan).not.toHaveBeenCalled();

    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async () => {
        projects!.createRecord({
          projectId: project.id,
          kind: "task",
          status: "active",
          title: "Concurrent retry change",
          body: "Advance while repository evidence is being scanned.",
          sourceKind: "human",
          sourceRef: null,
        });
        return candidate([]);
      }),
      verify: vi.fn(async () => undefined),
    };
    await expect(serviceWith(scanner).retry(
      project.id,
      1,
      { signal: new AbortController().signal, onProgress: () => undefined },
    )).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(index!.getPendingReview(project.id)).toBeNull();
    expect(index!.getSource(project.id)).toBeNull();
  });

  it("locates only the same stable repository and detaches atomically without losing accepted provenance", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const initial = candidate([markdown("README.md", "c")]);
    const initialService = serviceWith(scannerReturning(initial));
    const first = await initialService.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await initialService.apply({
      projectId: project.id,
      snapshotId: first.snapshot.id,
      expectedProjectRevision: 0,
    });

    const relocated = candidate([markdown("README.md", "c")], {
      root: "C:/mounted/example",
    });
    const recovery = serviceWith(scannerReturning(relocated));
    await expect(recovery.locate({
      projectId: project.id,
      root: "C:/mounted/example",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({ projectRevision: 1, requiresRefresh: true });
    expect(projects!.getProject(project.id)?.primaryRepositoryPath)
      .toBe("C:/mounted/example");
    expect(index!.getSource(project.id)).toMatchObject({
      root: "C:/mounted/example",
      repositoryIdentity: "git:example",
      currentSnapshotId: first.snapshot.id,
    });

    const pending = await recovery.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(recovery.detach({
      projectId: project.id,
      expectedProjectRevision: 1,
    })).toEqual({ projectRevision: 2, requiresRefresh: true });
    expect(index!.getReview(pending.snapshot.id)?.state).toBe("cancelled");
    expect(index!.getSnapshot(pending.snapshot.id)?.state).toBe("discarded");
    expect(index!.getCurrentSnapshot(project.id)?.id).toBe(first.snapshot.id);
    expect(index!.getSource(project.id)?.status).toBe("detached");
    expect(projects!.getProject(project.id)?.primaryRepositoryPath).toBeNull();
  });

  it("rejects locating a different repository identity without changing registered paths", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const service = serviceWith(scannerReturning(candidate([])));
    const pending = await service.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    service.cancel({ projectId: project.id, snapshotId: pending.snapshot.id });
    const replacement = serviceWith(scannerReturning(candidate([], {
      root: "C:/other/repository",
      repositoryIdentity: "git:different",
    })));

    await expect(replacement.locate({
      projectId: project.id,
      root: "C:/other/repository",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(projects!.getProject(project.id)).toMatchObject({
      revision: 0,
      primaryRepositoryPath: "C:/projects/example",
    });
    expect(index!.getSource(project.id)?.root).toBe("C:/projects/example");
  });

  it("discards a pre-location candidate so recovery always requires a fresh scan", async () => {
    setup();
    const project = projects!.createProject({
      name: "Example",
      primaryRepositoryPath: "C:/projects/example",
    });
    const initial = serviceWith(scannerReturning(candidate([])));
    const pending = await initial.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const recovery = serviceWith(scannerReturning(candidate([], {
      root: "C:/mounted/example",
    })));

    await recovery.locate({
      projectId: project.id,
      root: "C:/mounted/example",
      expectedProjectRevision: 0,
      signal: new AbortController().signal,
    });

    expect(index!.getReview(pending.snapshot.id)?.state).toBe("cancelled");
    expect(index!.getSnapshot(pending.snapshot.id)?.state).toBe("discarded");
    expect(recovery.get(project.id)).toBeNull();
  });

  it("honors a late locate abort after verification without changing database state", async () => {
    setup();
    const project = projects!.createProject({
      name: "Abort locate",
      primaryRepositoryPath: "C:/projects/example",
    });
    const initial = serviceWith(scannerReturning(candidate([])));
    const pending = await initial.start(project.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    initial.cancel({ projectId: project.id, snapshotId: pending.snapshot.id });
    const controller = new AbortController();
    const relocated = candidate([], { root: "C:/mounted/example" });
    const scanner: RepositoryObservationScanner = {
      scan: vi.fn(async () => relocated),
      verify: vi.fn(async () => {
        controller.abort(new DOMException("Disconnected", "AbortError"));
      }),
    };
    const before = {
      audits: database!.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
      snapshots: database!.prepare("SELECT COUNT(*) AS count FROM repository_snapshots").get(),
    };

    await expect(serviceWith(scanner).locate({
      projectId: project.id,
      root: relocated.root,
      expectedProjectRevision: 0,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(projects!.getProject(project.id)).toMatchObject({
      revision: 0,
      primaryRepositoryPath: "C:/projects/example",
    });
    expect(index!.getSource(project.id)).toMatchObject({
      root: "C:/projects/example",
      status: "available",
      repositoryIdentity: "git:example",
    });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM audit_events").get())
      .toEqual(before.audits);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM repository_snapshots").get())
      .toEqual(before.snapshots);
  });
});
