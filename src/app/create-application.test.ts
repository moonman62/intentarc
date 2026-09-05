import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryImportManifest } from "../domain/import-model.js";
import { computeImportManifestDigest } from "../import/canonical-manifest.js";
import {
  createApplication,
  createApplicationFromDatabase,
  openIntentArcApplication,
  type IntentArcIdPrefix,
  type IntentArcApplication,
} from "./create-application.js";
import { DurabilityError } from "../durability/errors.js";
import { createLeaseManager } from "../durability/leases.js";
import { openDatabase } from "../storage/database.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

const importManifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: "2026-07-28T12:00:00.000Z",
  repository: {
    root: "C:/projects/example",
    canonicalSubpath: null,
    branch: "main",
    head: "c".repeat(40),
    fingerprint: "d".repeat(64),
  },
  discovery: {
    sources: [{
      path: "README.md",
      status: "tracked",
      role: "canonical_source",
      byteSize: 32,
      sha256: "e".repeat(64),
      extraction: {
        title: "Imported application",
        headings: [],
      },
    }],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Imported application",
      primaryRepositoryPath: "C:/projects/example",
    },
    records: [{
      key: "vision",
      kind: "vision",
      status: "accepted",
      title: "Import through the application",
      body: "Persist one initial snapshot.",
      sourceKind: "repository",
      sourceRef: "README.md",
      sourceRefs: ["README.md"],
      curationReason: null,
    }],
    relationships: [],
  },
});

describe("createApplication", () => {
  let temporaryDatabase: TemporaryDatabase | undefined;
  let application: IntentArcApplication | undefined;

  afterEach(() => {
    application?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("wires all operations through one service with injected IDs and clock", () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<IntentArcIdPrefix, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-26T12:00:00.000Z",
      newId: (prefix) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    });

    const project = application.service.createProject({ name: "IntentArc" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Ship adapters",
      body: "Use a single application service.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "One facade",
      body: "Adapters share one boundary.",
      sourceKind: "human",
      sourceRef: null,
    });
    const relationship = application.service.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
      expectedProjectRevision: 2,
    });
    const context = application.service.getTaskContext({
      projectId: project.id,
      taskId: task.id,
      budgetTokens: 1_000,
    });

    expect(project).toMatchObject({
      id: "project-1",
      createdAt: "2026-07-26T12:00:00.000Z",
    });
    expect(task).toMatchObject({ id: "record-1" });
    expect(decision).toMatchObject({ id: "record-2" });
    expect(relationship).toMatchObject({ id: "relationship-1" });
    expect(context).toMatchObject({ id: "context-1" });

    application.close();
  });

  it("composes the visual dashboard read model through the application service", () => {
    temporaryDatabase = createTemporaryDatabase();
    const counters: Partial<Record<string, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-29T12:00:00.000Z",
      newId: (prefix) =>
        `${prefix}-${counters[prefix] = (counters[prefix] ?? 0) + 1}`,
    });
    const project = application.service.createProject({ name: "IntentArc" });
    application.service.createRecord({
      projectId: project.id,
      kind: "outcome",
      status: "active",
      title: "Ship the visual foundation",
      body: "Give the browser a deterministic project view.",
      sourceKind: "human",
      sourceRef: null,
    });
    application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Build the project hub",
      body: "Compose the project read model.",
      sourceKind: "human",
      sourceRef: null,
    });

    expect(application.service.views.getDashboard(project.id)).toMatchObject({
      project: { id: project.id, name: "IntentArc" },
      currentOutcome: { title: "Ship the visual foundation" },
      currentTask: { title: "Build the project hub" },
    });
  });

  it("wires the private repository index into the read-only document registry", () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });
    const project = application.service.createProject({ name: "Documentation" });

    expect(application.service.documents.list(project.id, {})).toEqual({
      projectId: project.id,
      snapshotId: null,
      documents: [],
      facets: { documentKinds: [], formats: [], roles: [], freshness: [] },
    });
    expect(application.service).not.toHaveProperty("repositoryIndexStore");
  });

  it("wires captured ideas through the application facade across restarts", () => {
    temporaryDatabase = createTemporaryDatabase();
    const databasePath = temporaryDatabase.path;
    application = createApplication({ databasePath });
    const project = application.service.createProject({ name: "Ideas" });

    const captured = application.service.ideas.capture({
      projectId: project.id,
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Persist the idea",
      contextRecordIds: [],
    });
    expect(captured.item.title).toBe("Persist the idea");
    application.close();

    application = createApplication({ databasePath });
    expect(application.service.ideas.listInbox({ projectId: project.id }).items)
      .toEqual([expect.objectContaining({ title: "Persist the idea" })]);
  });

  it("wires injected repository import tools to one persistent import service", () => {
    temporaryDatabase = createTemporaryDatabase();
    const candidate = importManifest();
    const discovery = { marker: "local discovery" };
    const allocated: Partial<Record<string, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-28T12:00:00.000Z",
      newId: (prefix) =>
        `${prefix}-${allocated[prefix] = (allocated[prefix] ?? 0) + 1}`,
      repositoryImportDependencies: {
        scanner: () => discovery as never,
        generator: (input) => {
          expect(input).toBe(discovery);
          return candidate;
        },
        driftVerifier: (manifest) => {
          expect(manifest.repository).toEqual(candidate.repository);
        },
      },
    });

    expect(application.service.imports.scan({
      repositoryPath: "C:/projects/example",
      canonicalSubpath: null,
    })).toBe(candidate);
    const inspection = application.service.imports.inspect(candidate);
    expect(inspection).not.toHaveProperty("normalizedManifest");
    expect(application.service.imports.apply({
      manifest: candidate,
      confirmedDigest: computeImportManifestDigest(candidate),
    })).toMatchObject({
      projectId: "project-1",
      revisionBefore: 0,
      revisionAfter: 1,
      replayed: false,
    });
    expect(application.service.imports.apply({
      manifest: candidate,
      confirmedDigest: computeImportManifestDigest(candidate),
    })).toMatchObject({
      projectId: "project-1",
      replayed: true,
    });
    expect(application.service.listProjects()).toEqual([
      expect.objectContaining({
        id: "project-1",
        name: "Imported application",
        revision: 1,
      }),
    ]);
  });

  it("closes the database only once when close is called repeatedly", () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });

    expect(() => application.close()).not.toThrow();
    expect(() => application.close()).not.toThrow();
  });

  it("builds application wiring from a prepared database and closes only the supplied owner once", () => {
    temporaryDatabase = createTemporaryDatabase();
    const database = openDatabase(temporaryDatabase.path, {
      storeId: "store-prepared",
    });
    let closeCalls = 0;
    application = createApplicationFromDatabase({
      database,
      closeDatabase() {
        closeCalls += 1;
        database.close();
      },
    });

    expect(application.service.createProject({ name: "Prepared" })).toMatchObject({
      name: "Prepared",
    });
    application.close();
    application.close();

    expect(closeCalls).toBe(1);
  });

  it("does not retry ownership cleanup when the supplied close callback throws", () => {
    temporaryDatabase = createTemporaryDatabase();
    const database = openDatabase(temporaryDatabase.path, {
      storeId: "store-close-failure",
    });
    let closeCalls = 0;
    application = createApplicationFromDatabase({
      database,
      closeDatabase() {
        closeCalls += 1;
        throw new Error("injected close failure");
      },
    });

    expect(() => application!.close()).toThrow("injected close failure");
    expect(() => application!.close()).not.toThrow();
    expect(closeCalls).toBe(1);

    application = undefined;
    database.close();
  });

  it("opens production applications with active access held until idempotent close", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const leaseManager = createLeaseManager();
    application = await openIntentArcApplication({
      databasePath: temporaryDatabase.path,
    });

    expect(() =>
      leaseManager.acquireMaintenance(temporaryDatabase!.path),
    ).toThrow(DurabilityError);

    application.close();
    application.close();
    const maintenance = leaseManager.acquireMaintenance(temporaryDatabase.path);
    maintenance.release();
  });

  it("generates prefixed UUIDs and ISO timestamps when dependencies are not supplied", () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });
    const project = application.service.createProject({ name: "IntentArc" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Check defaults",
      body: "Verify generated values.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Use defaults",
      body: "Exercise relationship IDs.",
      sourceKind: "human",
      sourceRef: null,
    });
    const relationship = application.service.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
      expectedProjectRevision: 2,
    });
    const context = application.service.getTaskContext({
      projectId: project.id,
      taskId: task.id,
      budgetTokens: 1_000,
    });

    expect(project.id).toMatch(/^project-[0-9a-f-]{36}$/);
    expect(task.id).toMatch(/^record-[0-9a-f-]{36}$/);
    expect(relationship.id).toMatch(/^relationship-[0-9a-f-]{36}$/);
    expect(context.id).toMatch(/^context-[0-9a-f-]{36}$/);
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    application.close();
  });

  it("authenticates a securely generated profile token after an application restart while anonymous reads remain available", () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    const options = {
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T12:00:00.000Z",
      newId: (prefix: Parameters<
        NonNullable<Parameters<typeof createApplication>[0]["newId"]>
      >[0]) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    };
    application = createApplication(options);
    const project = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Persistent agent",
      projectId: project.id,
    });

    application.close();
    application = createApplication(options);

    expect(application.service.listProjects()).toEqual([
      expect.objectContaining({ id: project.id }),
    ]);
    expect(application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })).toEqual({
      id: created.profile.id,
      name: "Persistent agent",
      status: "enabled",
      credentialGeneration: created.profile.tokenRotatedAt,
    });
  });

  it("composes authenticated coordination reads and expires persisted claims on the next read after reopen", () => {
    temporaryDatabase = createTemporaryDatabase();
    let currentTime = "2026-08-15T12:00:00.000Z";
    const idSequences: Partial<Record<IntentArcIdPrefix, number>> = {};
    const options = {
      databasePath: temporaryDatabase.path,
      now: () => currentTime,
      newId: (prefix: IntentArcIdPrefix) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    };
    application = createApplication(options);
    const project = application.service.createProject({ name: "Coordination" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Compose coordination",
      body: "Use the shared application database.",
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Coordination worker",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;

    expect(application.service.coordination.listReadyTasks({
      projectId: project.id,
      expectedProjectRevision: 1,
      cursor: null,
      limit: 20,
    }, principal)).toMatchObject({
      projectRevision: 1,
      tasks: [{
        task: { id: task.id, revision: 1 },
        blockers: [],
        liveClaimId: null,
        liveDelegationId: null,
      }],
      nextCursor: null,
    });
    const claimed = application.service.coordination.claimTask({
      projectId: project.id,
      taskId: task.id,
      expectedProjectRevision: 1,
      expectedTaskRevision: 1,
      contextBudgetTokens: 1_000,
      acceptedDelegationId: null,
      idempotencyKey: "application-coordination-claim",
    }, principal);
    expect(claimed.claim).toMatchObject({
      id: "claim-1",
      state: "active",
      taskId: task.id,
    });
    expect(claimed.contextPack.id).toBe("context-1");

    application.close();
    currentTime = "2026-08-15T12:10:00.000Z";
    application = createApplication(options);
    expect(application.service.coordination.getCoordinationState({
      projectId: project.id,
      taskId: task.id,
      expectedProjectRevision: 1,
    }, principal)).toMatchObject({
      claim: { id: "claim-1", state: "active" },
      events: [{ id: "coordination-event-1", category: "claim" }],
    });

    application.close();
    currentTime = "2026-08-15T12:31:00.000Z";
    application = createApplication(options);
    expect(application.service.coordination.getCoordinationState({
      projectId: project.id,
      taskId: task.id,
      expectedProjectRevision: 1,
    }, principal)).toMatchObject({
      claim: { id: "claim-1", state: "expired" },
      events: [
        { id: "coordination-event-1", category: "claim" },
        { id: "coordination-event-2", category: "expiry" },
      ],
    });
  });

  it("wires and persists profile-scoped destinations across application restarts", () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    const options = {
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T12:00:00.000Z",
      newId: (prefix: Parameters<
        NonNullable<Parameters<typeof createApplication>[0]["newId"]>
      >[0]) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    };
    application = createApplication(options);
    const profile = application.service.profiles.createProfile({
      name: "Build agent",
    });
    const destination = application.service.destinations.set({
      profileId: profile.profile.id,
      clientLabel: "Claude Code laptop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: null,
      accountBoundaryLabel: "personal subscription",
      dataBoundary: "remote",
    });

    application.close();
    application = createApplication(options);

    expect(application.service.destinations.getCurrent(profile.profile.id)).toEqual(
      expect.objectContaining({
        id: destination.id,
        revision: 1,
        status: "enabled",
      }),
    );
  });

  it("wires outbound requests with the required application ID prefixes", () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T12:00:00.000Z",
      newId: (prefix) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    });
    const project = application.service.createProject({ name: "IntentArc" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Gate context",
      body: "Release only after review.",
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Build agent",
    });
    const principal = {
      id: created.profile.id,
      name: created.profile.name,
      status: "enabled" as const,
      credentialGeneration: created.profile.tokenRotatedAt,
    };
    application.service.destinations.set({
      profileId: principal.id,
      clientLabel: "Claude Code laptop",
      type: "ide_managed",
      providerLabel: "Anthropic",
      modelLabel: null,
      accountBoundaryLabel: "personal subscription",
      dataBoundary: "remote",
    });

    const pending = application.service.outbound.request(principal, {
      projectId: project.id,
      taskId: task.id,
      budgetTokens: 1_000,
      idempotencyKey: "application-outbound",
    });
    const release = application.service.outbound.approve({
      requestId: pending.requestId,
      rememberClean: false,
      includeFindingIds: [],
    });

    expect(pending).toMatchObject({
      requestId: "outbound-request-1",
      sourcePackId: "context-1",
      status: "review_required",
    });
    expect(release).toMatchObject({
      releaseId: "outbound-release-1",
      requestId: pending.requestId,
    });
  });

  it("persists governed submissions, owner history, proposals, and audit events across restarts", () => {
    temporaryDatabase = createTemporaryDatabase();
    const idSequences: Partial<Record<string, number>> = {};
    const options = {
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T13:00:00.000Z",
      newId: (prefix: Parameters<
        NonNullable<Parameters<typeof createApplication>[0]["newId"]>
      >[0]) =>
        `${prefix}-${idSequences[prefix] = (idSequences[prefix] ?? 0) + 1}`,
    };
    application = createApplication(options);
    const project = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Proposal agent",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const submitted = application.service.submitChangeSet(principal, {
      projectId: project.id,
      baseProjectRevision: 0,
      idempotencyKey: "persistent-proposal",
      rationale: "Keep this proposal after restart.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-decision",
        type: "create_record",
        kind: "decision",
        status: "provisional",
        title: "Persistent proposal",
        body: "Application composition shares one database.",
      }],
    });
    expect(submitted).toMatchObject({
      outcome: "proposed",
      changeId: "change-1",
      proposalId: "proposal-1",
    });

    application.close();
    application = createApplication(options);

    expect(
      application.service.listMyChanges(created.profile.id, project.id),
    ).toEqual([
      expect.objectContaining({
        changeId: "change-1",
        outcome: "proposed",
        proposalId: "proposal-1",
      }),
    ]);
    expect(
      application.service.getMyChange(created.profile.id, "change-1"),
    ).toMatchObject({
      idempotencyKey: "persistent-proposal",
      proposal: { id: "proposal-1", state: "pending" },
    });
    expect(application.service.proposals.get("proposal-1")).toMatchObject({
      id: "proposal-1",
      state: "pending",
    });
    expect(application.service.listAuditEvents({
      projectId: project.id,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionCategory: "project_created",
        actorType: "local_human",
      }),
      expect.objectContaining({
        actionCategory: "profile_created",
        actorType: "local_human",
      }),
      expect.objectContaining({
        actionCategory: "proposal_created",
        actorType: "profile",
        profileId: created.profile.id,
      }),
    ]));
  });
});
