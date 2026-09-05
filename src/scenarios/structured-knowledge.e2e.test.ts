import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  openIntentArcApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import type {
  ProposedImportRecord,
  RepositoryImportManifest,
} from "../domain/index.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import { migrations } from "../storage/migrations.js";
import {
  createRepositoryObservationScanner,
} from "../repository/observation-scanner.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../test-support/repository-fixture.js";
import {
  captureRepositorySource as captureSource,
  withReadOnlyRepositorySource as expectReadOnly,
  withReadOnlyRepositorySourceAsync as expectReadOnlyAsync,
  type RepositorySourceSnapshot as SourceSnapshot,
} from "../test-support/repository-source-snapshot.js";

const currentSchemaVersion = migrations.at(-1)!.version;

const record = (
  key: string,
  kind: ProposedImportRecord["kind"],
  status: ProposedImportRecord["status"],
  title: string,
): ProposedImportRecord => ({
  key,
  kind,
  status,
  title,
  body: `${title} is governed local project intent.`,
  sourceKind: "agent",
  sourceRef: null,
  sourceRefs: [],
  curationReason: "Curated for the structured-knowledge scenario.",
});

const importProject = (
  application: IntentArcApplication,
  root: string,
  source = captureSource(root),
): string => {
  const manifest = expectReadOnly(root, source, () =>
    application.service.imports.scan({
      repositoryPath: root,
      canonicalSubpath: null,
    }) as RepositoryImportManifest);
  manifest.proposal.project.name = "Structured Knowledge Fixture";
  manifest.proposal.records.push(
    record("outcome.release", "outcome", "active", "Ship structured knowledge"),
    record("milestone.review", "milestone", "active", "Review repository facts"),
    record("task.refresh", "task", "active", "Refresh documentation safely"),
  );
  manifest.proposal.relationships.push(
    { fromKey: "outcome.release", toKey: "milestone.review", kind: "parent_of" },
    { fromKey: "milestone.review", toKey: "task.refresh", kind: "parent_of" },
  );
  const inspection = expectReadOnly(root, source, () =>
    application.service.imports.inspect(manifest));
  return expectReadOnly(root, source, () =>
    application.service.imports.apply({
      manifest,
      confirmedDigest: inspection.manifestDigest,
    }).projectId);
};

const fixtureRepository = (): RepositoryFixture => {
  const parentDirectory = resolve(
    "node_modules",
    ".cache",
    "intentarc-structured-knowledge",
  );
  mkdirSync(parentDirectory, { recursive: true });
  return createRepositoryFixture({
  "project.godot": [
    "; Engine configuration file.",
    "[application]",
    'config/name="Structured Knowledge Fixture"',
    "",
  ].join("\n"),
  "README.md": [
    "# Structured Knowledge Fixture",
    "",
    "Accepted repository documentation remains read only.",
    "",
  ].join("\n"),
  "docs/guide.md": "# Operator guide\n\nRefresh by review, never by watcher.\n",
  "src/index.ts": "export const fixture = true;\n",
  "tests/existing.test.ts": "export const existingTest = true;\n",
  }, { parentDirectory });
};

const startRefresh = (
  application: IntentArcApplication,
  projectId: string,
  signal = new AbortController().signal,
) => application.service.repositoryRefresh.start(projectId, {
  signal,
  onProgress: ({ processed, total }) => {
    expect(processed).toBeGreaterThanOrEqual(0);
    expect(processed).toBeLessThanOrEqual(total);
  },
});

const temporaryDatabase = (): { path: string; cleanup(): void } => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc-structured-knowledge-"));
  return {
    path: join(directory, "intentarc.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

const runSourceCli = (arguments_: readonly string[]) => {
  const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(process.execPath, [tsxCli, resolve("src", "cli", "bin.ts"), ...arguments_], {
    cwd: resolve("."),
    encoding: "utf8",
    windowsHide: true,
  });
};

describe("structured knowledge service journey", () => {
  const cleanups: Array<() => void> = [];
  const applications: IntentArcApplication[] = [];

  const track = (application: IntentArcApplication): IntentArcApplication => {
    applications.push(application);
    return application;
  };

  afterEach(() => {
    applications.splice(0).reverse().forEach((application) => application.close());
    cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  });

  it("imports, indexes, renders, refreshes, resumes a semantic proposal, and preserves Git", async () => {
    const repository = fixtureRepository();
    const database = temporaryDatabase();
    cleanups.push(repository.cleanup, database.cleanup);
    let application = track(createApplication({ databasePath: database.path }));
    const importedSource = captureSource(repository.root);
    const projectId = expectReadOnly(repository.root, importedSource, () =>
      importProject(application, repository.root));
    const revision = expectReadOnly(repository.root, importedSource, () =>
      application.service.getProjectSummary(projectId)).project.revision;

    const initialReview = await expectReadOnlyAsync(repository.root, importedSource, () =>
      startRefresh(application, projectId));
    expect(initialReview.diff.groups.map(({ kind }) => kind)).toContain("added");
    const initialApply = await expectReadOnlyAsync(repository.root, importedSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: initialReview.snapshot.id,
        expectedProjectRevision: revision,
      }));
    expect(initialApply).toMatchObject({ proposalId: null, replayed: false });

    const acceptedReadme = expectReadOnly(repository.root, importedSource, () =>
      application.service.documents.list(projectId, {}))
      .documents.find(({ path }) => path === "README.md");
    expect(acceptedReadme).toBeDefined();
    expect(expectReadOnly(repository.root, importedSource, () =>
      application.service.documents.read(
        projectId,
        acceptedReadme!.nodeId,
        acceptedReadme!.snapshotId,
      )))
      .toMatchObject({
        status: "renderable",
        text: expect.stringContaining("Accepted repository documentation"),
      });

    repository.write("README.md", "# Structured Knowledge Fixture\n\nChanged after acceptance.\n");
    const changedSource = captureSource(repository.root);
    expect(expectReadOnly(repository.root, changedSource, () =>
      application.service.documents.read(
        projectId,
        acceptedReadme!.nodeId,
        acceptedReadme!.snapshotId,
      )))
      .toEqual({ status: "stale" });
    const changedReview = await expectReadOnlyAsync(repository.root, changedSource, () =>
      startRefresh(application, projectId));
    expect(changedReview.diff.groups.find(({ kind }) => kind === "changed")?.entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ currentPath: "README.md" }),
      ]));
    await expectReadOnlyAsync(repository.root, changedSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: changedReview.snapshot.id,
        expectedProjectRevision: revision,
      }));

    repository.write(
      "tests/release-evidence.md",
      "# Release evidence\n\nThe structured knowledge journey passed review.\n",
    );
    repository.runGit(["add", "tests/release-evidence.md"]);
    const evidenceSource = captureSource(repository.root);
    const proposalReview = await expectReadOnlyAsync(repository.root, evidenceSource, () =>
      startRefresh(application, projectId));
    expect(proposalReview.diff.semanticOperations).toHaveLength(1);
    const selected = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.repositoryRefresh.updateSelection({
        projectId,
        snapshotId: proposalReview.snapshot.id,
        selectedOperationIds: [proposalReview.diff.semanticOperations[0]!.operationId],
      }));
    expect(selected.review.selectedOperationIds).toHaveLength(1);
    application.close();

    application = track(await openIntentArcApplication({ databasePath: database.path }));
    const resumed = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.repositoryRefresh.get(projectId));
    expect(resumed?.review.snapshotId).toBe(proposalReview.snapshot.id);
    const applied = await expectReadOnlyAsync(repository.root, evidenceSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: proposalReview.snapshot.id,
        expectedProjectRevision: revision,
      }));
    expect(applied.proposalId).not.toBeNull();
    const acceptedProposal = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.proposals.accept(applied.proposalId!));
    expect(acceptedProposal.outcome).toBe("applied");
    expect(expectReadOnly(repository.root, evidenceSource, () =>
      application.service.proposals.get(applied.proposalId!)).state).toBe("accepted");
    const summary = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.getProjectSummary(projectId));
    expect(acceptedProposal.outcome).toBe("applied");
    const evidence = acceptedProposal.outcome === "applied"
      ? acceptedProposal.operations.find((operation) =>
          operation.type === "create_record" &&
          operation.record.kind === "evidence" &&
          operation.record.title.includes("release-evidence.md"))
      : undefined;
    expect(evidence).toBeDefined();
    const task = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.views.getDashboard(projectId)).currentTask!;
    const projectMap = expectReadOnly(repository.root, evidenceSource, () =>
      application.service.projectMap.getProjectMap(projectId, task.id));
    expect(projectMap.selectedPath.slice(0, -1).map(({ kind }) => kind))
      .toEqual(["outcome", "milestone"]);
    expect(summary.project.revision).toBe(revision + 1);
    expect(captureSource(repository.root)).toEqual(evidenceSource);
    application.close();

    expect(createIntegrityChecker().checkPath(database.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      issues: [],
    });
    const backup = expectReadOnly(repository.root, evidenceSource, () =>
      runSourceCli(["--db", database.path, "backup", "create"]));
    expect({ status: backup.status, stderr: backup.stderr }).toEqual({ status: 0, stderr: "" });
    const backupSummary = JSON.parse(backup.stdout) as { bundlePath: string };
    const verification = expectReadOnly(repository.root, evidenceSource, () =>
      runSourceCli(["backup", "verify", "--backup", backupSummary.bundlePath]));
    expect({ status: verification.status, stderr: verification.stderr }).toEqual({ status: 0, stderr: "" });
    const restored = temporaryDatabase();
    cleanups.push(restored.cleanup);
    const restore = expectReadOnly(repository.root, evidenceSource, () =>
      runSourceCli([
        "--db",
        restored.path,
        "backup",
        "restore",
        "--backup",
        backupSummary.bundlePath,
        "--yes",
      ]));
    expect({ status: restore.status, stderr: restore.stderr }).toEqual({ status: 0, stderr: "" });
    expect(createIntegrityChecker().checkPath(restored.path, "full")).toMatchObject({
      passed: true,
      schemaVersion: currentSchemaVersion,
      issues: [],
    });
  }, 30_000);

  it("cancels without a partial candidate and keeps ambiguous same-hash renames as remove plus add", async () => {
    const repository = fixtureRepository();
    const database = temporaryDatabase();
    cleanups.push(repository.cleanup, database.cleanup);
    const realScanner = createRepositoryObservationScanner();
    const controller = new AbortController();
    const application = track(createApplication({
      databasePath: database.path,
      repositoryRefreshDependencies: {
        scanner: {
          scan: (input, options) => realScanner.scan(input, {
            ...options,
            onProgress(progress) {
              options.onProgress(progress);
              controller.abort();
            },
          }),
          verify: (candidate, signal) => realScanner.verify(candidate, signal),
        },
      },
    }));
    const pristineSource = captureSource(repository.root);
    const projectId = importProject(application, repository.root, pristineSource);
    await expect(expectReadOnlyAsync(repository.root, pristineSource, () =>
      startRefresh(application, projectId, controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(expectReadOnly(repository.root, pristineSource, () =>
      application.service.repositoryRefresh.get(projectId))).toBeNull();
    application.close();

    const normal = track(createApplication({ databasePath: database.path }));
    const revision = expectReadOnly(repository.root, pristineSource, () =>
      normal.service.getProjectSummary(projectId)).project.revision;
    const initial = await expectReadOnlyAsync(repository.root, pristineSource, () =>
      startRefresh(normal, projectId));
    await expectReadOnlyAsync(repository.root, pristineSource, () =>
      normal.service.repositoryRefresh.apply({
        projectId,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: revision,
      }));
    const sameBytes = readFileSync(resolve(repository.root, "docs/guide.md"));
    rmSync(resolve(repository.root, "docs/guide.md"));
    repository.write("docs/copied-guide.md", sameBytes);
    const ambiguousSource = captureSource(repository.root);
    const review = await expectReadOnlyAsync(repository.root, ambiguousSource, () =>
      startRefresh(normal, projectId));
    expect(review.diff.groups.find(({ kind }) => kind === "removed")?.entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ previousPath: "docs/guide.md" })]));
    expect(review.diff.groups.find(({ kind }) => kind === "added")?.entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ currentPath: "docs/copied-guide.md" })]));
    expect(review.diff.groups.find(({ kind }) => kind === "moved")).toBeUndefined();
    expectReadOnly(repository.root, ambiguousSource, () =>
      normal.service.repositoryRefresh.cancel({
        projectId,
        snapshotId: review.snapshot.id,
      }));
    expect(expectReadOnly(repository.root, ambiguousSource, () =>
      normal.service.repositoryRefresh.get(projectId))).toBeNull();
    expect(captureSource(repository.root)).toEqual(ambiguousSource);
    normal.close();
  }, 30_000);

  it("reactivates the same accepted source when its missing root is restored and Retry is explicit", async () => {
    const repository = fixtureRepository();
    const database = temporaryDatabase();
    cleanups.push(database.cleanup);
    let rootForCleanup = repository.root;
    cleanups.push(() => {
      if (rootForCleanup !== repository.root && existsSync(rootForCleanup)) {
        renameSync(rootForCleanup, repository.root);
      }
      repository.cleanup();
    });
    const application = track(createApplication({ databasePath: database.path }));
    const pristineSource = captureSource(repository.root);
    const projectId = importProject(application, repository.root, pristineSource);
    const revision = expectReadOnly(repository.root, pristineSource, () =>
      application.service.getProjectSummary(projectId)).project.revision;
    const initial = await expectReadOnlyAsync(repository.root, pristineSource, () =>
      startRefresh(application, projectId));
    await expectReadOnlyAsync(repository.root, pristineSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: revision,
      }));

    const parkedRoot = `${repository.root} temporarily missing`;
    renameSync(repository.root, parkedRoot);
    rootForCleanup = parkedRoot;
    const parkedSource = captureSource(parkedRoot);
    await expect(expectReadOnlyAsync(parkedRoot, parkedSource, () =>
      application.service.repositoryRefresh.retry(
        projectId,
        revision,
        { signal: new AbortController().signal, onProgress: () => undefined },
      ))).rejects.toMatchObject({ name: "RepositoryRefreshUnavailableError" });
    expect(expectReadOnly(parkedRoot, parkedSource, () =>
      application.service.projectMap.getRepositoryTree({ projectId }))).toMatchObject({
        snapshotId: initial.snapshot.id,
        sourceStatus: "unavailable",
      });

    renameSync(parkedRoot, repository.root);
    rootForCleanup = repository.root;
    const restoredSource = captureSource(repository.root);
    const recovered = await expectReadOnlyAsync(repository.root, restoredSource, () =>
      application.service.repositoryRefresh.retry(
        projectId,
        revision,
        { signal: new AbortController().signal, onProgress: () => undefined },
      ));
    expect(recovered.review.state).toBe("pending");
    expect(expectReadOnly(repository.root, restoredSource, () =>
      application.service.projectMap.getRepositoryTree({ projectId }))).toMatchObject({
        snapshotId: initial.snapshot.id,
        sourceStatus: "available",
      });
    expect(expectReadOnly(repository.root, restoredSource, () =>
      application.service.getProjectSummary(projectId)).project.revision).toBe(revision);
    expectReadOnly(repository.root, restoredSource, () =>
      application.service.repositoryRefresh.cancel({
        projectId,
        snapshotId: recovered.snapshot.id,
      }));
    expect(captureSource(repository.root)).toEqual(pristineSource);
    application.close();
  }, 30_000);

  it("retains conflicts, retries an unavailable source, locates the same repository, and detaches deliberately", async () => {
    const repository = fixtureRepository();
    const database = temporaryDatabase();
    cleanups.push(database.cleanup);
    let rootForCleanup = repository.root;
    cleanups.push(() => {
      if (rootForCleanup !== repository.root && existsSync(rootForCleanup)) {
        renameSync(rootForCleanup, repository.root);
      }
      repository.cleanup();
    });
    let application = track(createApplication({ databasePath: database.path }));
    const pristineSource = captureSource(repository.root);
    const projectId = importProject(application, repository.root, pristineSource);
    let revision = expectReadOnly(repository.root, pristineSource, () =>
      application.service.getProjectSummary(projectId)).project.revision;
    const initial = await expectReadOnlyAsync(repository.root, pristineSource, () =>
      startRefresh(application, projectId));
    await expectReadOnlyAsync(repository.root, pristineSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: revision,
      }));

    repository.write("README.md", "# Drifted after candidate\n");
    const candidateSource = captureSource(repository.root);
    const candidate = await expectReadOnlyAsync(repository.root, candidateSource, () =>
      startRefresh(application, projectId));
    repository.write("README.md", "# Drifted again before apply\n");
    const driftedSource = captureSource(repository.root);
    await expect(expectReadOnlyAsync(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: candidate.snapshot.id,
        expectedProjectRevision: revision,
      }))).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    application.close();
    application = track(await openIntentArcApplication({ databasePath: database.path }));
    expect(expectReadOnly(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.get(projectId))?.review.state).toBe("conflicted");
    expectReadOnly(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.cancel({
        projectId,
        snapshotId: candidate.snapshot.id,
      }));

    const revisionCandidate = await expectReadOnlyAsync(
      repository.root,
      driftedSource,
      () => startRefresh(application, projectId),
    );
    expectReadOnly(repository.root, driftedSource, () =>
      application.service.createRecord({
        projectId,
        kind: "decision",
        status: "accepted",
        title: "Keep refreshes reviewed",
        body: "Repository observations never silently become project intent.",
        sourceKind: "human",
        sourceRef: null,
      }));
    await expect(expectReadOnlyAsync(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: revisionCandidate.snapshot.id,
        expectedProjectRevision: revision,
      }))).rejects.toMatchObject({ name: "RepositoryRefreshConflictError" });
    expect(expectReadOnly(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.get(projectId))?.review.state).toBe("conflicted");
    expectReadOnly(repository.root, driftedSource, () =>
      application.service.repositoryRefresh.cancel({
        projectId,
        snapshotId: revisionCandidate.snapshot.id,
      }));
    revision += 1;

    const movedRoot = `${repository.root} relocated`;
    renameSync(repository.root, movedRoot);
    rootForCleanup = movedRoot;
    const relocatedSource = captureSource(movedRoot);
    await expect(expectReadOnlyAsync(movedRoot, relocatedSource, () =>
      application.service.repositoryRefresh.retry(
        projectId,
        revision,
        { signal: new AbortController().signal, onProgress: () => undefined },
      ))).rejects.toMatchObject({ name: "RepositoryRefreshUnavailableError" });
    const unavailableBeforeRestart = expectReadOnly(movedRoot, relocatedSource, () =>
      application.service.projectMap.getRepositoryTree({
        projectId,
        filter: { state: "unavailable" },
      }));
    expect(unavailableBeforeRestart.sourceStatus).toBe("unavailable");
    expect(unavailableBeforeRestart.snapshotId).toBe(initial.snapshot.id);
    expect(unavailableBeforeRestart.items.length).toBeGreaterThan(0);
    expect(unavailableBeforeRestart.items.every(({ state }) => state === "unavailable")).toBe(true);

    application.close();
    application = track(await openIntentArcApplication({ databasePath: database.path }));
    const unavailableAfterRestart = expectReadOnly(movedRoot, relocatedSource, () =>
      application.service.projectMap.getRepositoryTree({
        projectId,
        filter: { state: "unavailable" },
      }));
    expect(unavailableAfterRestart).toMatchObject({
      snapshotId: initial.snapshot.id,
      sourceStatus: "unavailable",
    });
    expect(unavailableAfterRestart.items.length).toBeGreaterThan(0);
    const located = await expectReadOnlyAsync(movedRoot, relocatedSource, () =>
      application.service.repositoryRefresh.locate({
        projectId,
        root: movedRoot,
        expectedProjectRevision: revision,
        signal: new AbortController().signal,
      }));
    expect(located).toEqual({ projectRevision: revision + 1, requiresRefresh: true });
    revision += 1;
    expect(expectReadOnly(movedRoot, relocatedSource, () =>
      application.service.projectMap.getRepositoryTree({ projectId })).sourceStatus)
      .toBe("available");
    const retry = await expectReadOnlyAsync(movedRoot, relocatedSource, () =>
      application.service.repositoryRefresh.retry(
        projectId,
        revision,
        { signal: new AbortController().signal, onProgress: () => undefined },
      ));
    await expectReadOnlyAsync(movedRoot, relocatedSource, () =>
      application.service.repositoryRefresh.apply({
        projectId,
        snapshotId: retry.snapshot.id,
        expectedProjectRevision: revision,
      }));
    const detached = expectReadOnly(movedRoot, relocatedSource, () =>
      application.service.repositoryRefresh.detach({
        projectId,
        expectedProjectRevision: revision,
      }));
    expect(detached).toEqual({ projectRevision: revision + 1, requiresRefresh: true });
    expect(expectReadOnly(movedRoot, relocatedSource, () =>
      application.service.documents.list(projectId, {})).documents)
      .toEqual(expect.arrayContaining([expect.objectContaining({ freshness: "unavailable" })]));
    expect(captureSource(movedRoot)).toEqual(relocatedSource);
    application.close();
  }, 30_000);
});
