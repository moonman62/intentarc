import { describe, expect, it } from "vitest";
import {
  apiPath,
  apiErrorResponseSchema,
  connectedRecordDetailResponseSchema,
  connectedRepositoryDetailResponseSchema,
  coordinationAcceptDelegationBodySchema,
  coordinationCheckpointBodySchema,
  coordinationCheckpointResponseSchema,
  coordinationClaimBodySchema,
  coordinationCreateDelegationBodySchema,
  coordinationReadyQuerySchema,
  coordinationReadyResponseSchema,
  coordinationRenewBodySchema,
  coordinationRevokeDelegationBodySchema,
  coordinationStateQuerySchema,
  coordinationSubmissionBodySchema,
  coordinationSwitchBodySchema,
  coordinationTransitionBodySchema,
  createRelationshipBodySchema,
  documentContentResponseSchema,
  documentDetailResponseSchema,
  documentReadQuerySchema,
  documentRegistryQuerySchema,
  documentRegistryResponseSchema,
  ideaCaptureBodySchema,
  ideaCaptureResponseSchema,
  ideaDetailResponseSchema,
  ideaInboxPageResponseSchema,
  ideaInboxQuerySchema,
  mapQuerySchema,
  projectMapResponseSchema,
  projectDashboardResponseSchemaFor,
  relationshipMutationResponseSchema,
  removeRelationshipBodySchema,
  repositoryExplorerQuerySchema,
  repositoryExplorerResponseSchema,
  repositoryRefreshApplyBodySchema,
  repositoryRefreshDetachBodySchema,
  repositoryRefreshLocateBodySchema,
  repositoryRefreshStateResponseSchema,
  repositoryRefreshSelectionBodySchema,
  repositoryRefreshStreamEventSchema,
  updateHierarchyVocabularyBodySchema,
  updateHierarchyVocabularyResponseSchema,
} from "./contracts.js";

describe("web contracts", () => {
  it("keeps dashboard vocabulary and embedded records project-bound", () => {
    const timestamp = "2026-08-24T12:00:00.000Z";
    const record = {
      id: "task-1",
      projectId: "project-1",
      kind: "task" as const,
      status: "active" as const,
      title: "Verify dashboard binding",
      body: "Keep the full dashboard response strict.",
      sourceKind: "human" as const,
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const evidence = {
      ...record,
      id: "evidence-1",
      kind: "evidence" as const,
      title: "Dashboard contract proof",
    };
    const dashboard = {
      project: {
        id: "project-1",
        name: "Bound dashboard",
        revision: 3,
        primaryRepositoryPath: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      hierarchyVocabulary: {
        preset: "simple" as const,
        outcome: "Goal",
        initiative: "Stream",
        deliverable: "Result",
        milestone: "Checkpoint",
        task: "Action",
        nestedTask: "Step",
      },
      hierarchyParentContexts: [{ recordId: record.id, parentKind: null }],
      recordsByKind: { task: 1 },
      currentOutcome: null,
      currentTask: record,
      currentFocusPath: [{
        id: record.id,
        projectId: record.projectId,
        kind: record.kind,
        status: record.status,
        title: record.title,
      }],
      attention: record,
      pendingProposalCount: 0,
      recentRecords: [record, evidence],
    };

    expect(projectDashboardResponseSchemaFor("project-1").parse(dashboard))
      .toEqual(dashboard);
    expect(() => projectDashboardResponseSchemaFor("project-2").parse(dashboard))
      .toThrow();
    expect(() => projectDashboardResponseSchemaFor("project-1").parse({
      ...dashboard,
      currentTask: { ...record, projectId: "project-2" },
    })).toThrow();
    expect(() => projectDashboardResponseSchemaFor("project-1").parse({
      ...dashboard,
      hierarchyVocabulary: { ...dashboard.hierarchyVocabulary, task: "" },
    })).toThrow();
    for (const hierarchyParentContexts of [
      [],
      [
        { recordId: record.id, parentKind: null },
        { recordId: record.id, parentKind: null },
      ],
      [{ recordId: "unknown-record", parentKind: null }],
      [{ recordId: record.id, parentKind: "evidence" }],
      [{ recordId: "", parentKind: null }],
    ]) {
      expect(() => projectDashboardResponseSchemaFor("project-1").parse({
        ...dashboard,
        hierarchyParentContexts,
      })).toThrow();
    }
  });

  it("requires an explicit repository source status in refresh state", () => {
    expect(() => repositoryRefreshStateResponseSchema.parse({ review: null })).toThrow();
    expect(repositoryRefreshStateResponseSchema.parse({
      review: null,
      sourceStatus: null,
    })).toEqual({ review: null, sourceStatus: null });
  });
  it("keeps idea capture, paging, and response DTOs strict and bounded", () => {
    const ideaItemFixture = {
      id: "idea-1",
      projectId: "project-1",
      revision: 1,
      status: "provisional" as const,
      title: "Keep the idea",
      bodyPreview: "Keep the idea",
      sourceKind: "human" as const,
      sourceRef: "web:idea-capture",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      context: [{
        id: "task-1",
        kind: "task" as const,
        title: "Current task",
        status: "active" as const,
      }],
    };
    const ideaDetailFixture = {
      id: "idea-1",
      projectId: "project-1",
      revision: 1,
      status: "provisional" as const,
      title: "Keep the idea",
      body: "Keep the idea\nPreserve the full body.",
      sourceKind: "human" as const,
      sourceRef: "web:idea-capture",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      context: ideaItemFixture.context,
    };

    expect(ideaCaptureBodySchema.parse({
      expectedProjectRevision: 4,
      captureRequestId: "capture-request-1",
      text: "Keep the idea",
      contextRecordIds: ["task-1", "component-1"],
    })).toMatchObject({ expectedProjectRevision: 4 });
    expect(ideaInboxQuerySchema.parse({ limit: "100", cursor: "YWJj" }))
      .toEqual({ limit: 100, cursor: "YWJj" });
    expect(ideaCaptureResponseSchema.parse({
      projectRevision: 5,
      item: ideaItemFixture,
    })).toEqual({ projectRevision: 5, item: ideaItemFixture });
    expect(ideaInboxPageResponseSchema.parse({
      projectId: "project-1",
      projectRevision: 5,
      items: [ideaItemFixture],
      hasMore: false,
      nextCursor: null,
    })).toMatchObject({ items: [ideaItemFixture], nextCursor: null });
    expect(ideaDetailResponseSchema.parse(ideaDetailFixture))
      .toEqual(ideaDetailFixture);

    for (const invalid of [
      { expectedProjectRevision: 4, text: "Keep", extra: true },
      { expectedProjectRevision: 4, text: "Keep" },
      { expectedProjectRevision: 4, captureRequestId: "   ", text: "Keep" },
      { expectedProjectRevision: 4, captureRequestId: "x".repeat(129), text: "Keep" },
      {
        expectedProjectRevision: 4,
        captureRequestId: "capture-request-1",
        text: "Keep",
        contextRecordIds: Array.from({ length: 101 }, (_, index) => `task-${index}`),
      },
      {
        expectedProjectRevision: 4,
        captureRequestId: "capture-request-1",
        text: "Keep",
        contextRecordIds: ["x".repeat(513)],
      },
      { expectedProjectRevision: Number.MAX_SAFE_INTEGER, text: "Keep" },
      { expectedProjectRevision: 4, text: "😀".repeat(16_385) },
    ]) expect(() => ideaCaptureBodySchema.parse(invalid)).toThrow();

    for (const invalid of [
      { limit: "0" },
      { limit: "101" },
      { limit: "01" },
      { limit: "1", extra: "private" },
      { cursor: "a".repeat(8_193) },
      { cursor: "not+base64url" },
    ]) expect(() => ideaInboxQuerySchema.parse(invalid)).toThrow();

    for (const unsafe of [
      {
        projectRevision: 5,
        item: ideaItemFixture,
        repositoryRoot: "C:/private/repository",
      },
      {
        projectRevision: 5,
        item: { ...ideaItemFixture, auditActor: "private-user" },
      },
      {
        projectRevision: 5,
        item: {
          ...ideaItemFixture,
          context: [{ ...ideaItemFixture.context[0], repositoryRoot: "C:/private" }],
        },
      },
      {
        projectId: "project-1",
        projectRevision: 5,
        items: [ideaItemFixture],
        hasMore: false,
        nextCursor: null,
        records: [{ title: "Unrelated full record" }],
      },
    ]) {
      const schema = "items" in unsafe
        ? ideaInboxPageResponseSchema
        : ideaCaptureResponseSchema;
      expect(() => schema.parse(unsafe)).toThrow();
    }
    for (const unsafe of [
      { ...ideaDetailFixture, bodyPreview: "preview" },
      { ...ideaDetailFixture, repositoryRoot: "C:/private" },
      { ...ideaDetailFixture, auditActor: "private-user" },
    ]) expect(() => ideaDetailResponseSchema.parse(unsafe)).toThrow();
  });

  it("encodes path segments and validates safe API errors", () => {
    expect(apiPath("projects", "project/one", "dashboard"))
      .toBe("/api/projects/project%2Fone/dashboard");
    expect(apiErrorResponseSchema.parse({
      error: {
        code: "project_not_found",
        message: "Project not found",
        recoverable: true,
      },
    })).toEqual({
      error: {
        code: "project_not_found",
        message: "Project not found",
        recoverable: true,
      },
    });
  });

  it("keeps documentation filters and responses closed at the web boundary", () => {
    expect(documentRegistryQuerySchema.parse({
      locationPrefix: "docs",
      role: "supporting_document",
      format: "markdown",
      linkedRecordId: "record-1",
      relevance: "current_task",
      freshness: "current",
      linkBasis: "accepted",
      unlinked: "false",
    })).toMatchObject({ unlinked: false });
    expect(() => documentRegistryQuerySchema.parse({ future: "private" }))
      .toThrow();
    expect(() => documentRegistryQuerySchema.parse({
      format: "html",
    })).toThrow();
    expect(documentReadQuerySchema.parse({ expectedSnapshotId: "snapshot-1" }))
      .toEqual({ expectedSnapshotId: "snapshot-1" });
    for (const invalid of [
      {},
      { expectedSnapshotId: "" },
      { expectedSnapshotId: "x".repeat(513) },
      { expectedSnapshotId: "snapshot-1", future: "private" },
    ]) expect(() => documentReadQuerySchema.parse(invalid)).toThrow();

    const document = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      nodeId: "node-1",
      path: "docs/overview.md",
      documentKind: "overview" as const,
      documentFormat: "markdown" as const,
      role: "supporting_document" as const,
      freshness: "current" as const,
      contentEligible: true,
      instructionClient: null,
      instructionScope: null,
      links: [],
    };
    const facets = {
      documentKinds: [{ value: "overview" as const, count: 1 }],
      formats: [{ value: "markdown" as const, count: 1 }],
      roles: [{ value: "supporting_document" as const, count: 1 }],
      freshness: [{ value: "current" as const, count: 1 }],
    };

    expect(documentRegistryResponseSchema.parse({
      projectId: "project-1",
      snapshotId: "snapshot-1",
      documents: [document],
      facets,
    })).toEqual({ projectId: "project-1", snapshotId: "snapshot-1", documents: [document], facets });
    expect(() => documentRegistryResponseSchema.parse({
      projectId: "project-1",
      snapshotId: "snapshot-1",
      documents: [{ ...document, projectId: "project-2" }],
      facets,
    })).toThrow();
    expect(() => documentRegistryResponseSchema.parse({
      projectId: "project-1",
      snapshotId: "snapshot-1",
      documents: [{ ...document, snapshotId: "snapshot-2" }],
      facets,
    })).toThrow();
    expect(documentDetailResponseSchema.parse({
      document,
      linksByBasis: {
        accepted: [],
        observed: [],
        inferred: [],
        conflicting: [],
      },
      nativeCapability: "renderable",
      externalOpenEligible: true,
      externalOpenAvailable: false,
    })).toMatchObject({ externalOpenAvailable: false });
    expect(documentContentResponseSchema.parse({
      format: "markdown",
      text: "# Accepted",
      sha256: "a".repeat(64),
    })).toEqual({
      format: "markdown",
      text: "# Accepted",
      sha256: "a".repeat(64),
    });
    expect(() => documentContentResponseSchema.parse({
      format: "markdown",
      text: "# Accepted",
      sha256: "a".repeat(64),
      root: "C:\\private\\repository",
    })).toThrow();
  });

  it("keeps refresh mutations and streamed review events strict and path-safe", () => {
    expect(repositoryRefreshSelectionBodySchema.parse({
      projectId: "project-1",
      snapshotId: "snapshot-1",
      selectedOperationIds: ["operation-1"],
    })).toMatchObject({ selectedOperationIds: ["operation-1"] });
    expect(repositoryRefreshApplyBodySchema.parse({
      projectId: "project-1",
      snapshotId: "snapshot-1",
      expectedProjectRevision: 3,
    })).toMatchObject({ expectedProjectRevision: 3 });
    expect(repositoryRefreshLocateBodySchema.parse({
      root: "C:/selected/repository",
      expectedProjectRevision: 3,
    })).toMatchObject({ root: "C:/selected/repository" });
    expect(repositoryRefreshDetachBodySchema.parse({
      confirmed: true,
      expectedProjectRevision: 3,
    })).toMatchObject({ confirmed: true });
    for (const invalid of [
      { projectId: "project-1", snapshotId: "snapshot-1", selectedOperationIds: [], extra: true },
      { projectId: "project-1", snapshotId: "snapshot-1", expectedProjectRevision: -1 },
      { root: "relative/repository", expectedProjectRevision: 3 },
      { confirmed: false, expectedProjectRevision: 3 },
    ]) {
      expect(() => repositoryRefreshSelectionBodySchema.parse(invalid) ||
        repositoryRefreshApplyBodySchema.parse(invalid) ||
        repositoryRefreshLocateBodySchema.parse(invalid) ||
        repositoryRefreshDetachBodySchema.parse(invalid)).toThrow();
    }

    expect(repositoryRefreshStreamEventSchema.parse({
      type: "progress",
      progress: { phase: "hashing", processed: 2, total: 4 },
    })).toMatchObject({ type: "progress" });
    const review = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      state: "pending" as const,
      selectedOperationIds: [],
      baseProjectRevision: 3,
      warningCounts: {},
      exclusionCounts: { ignored: 2 },
      findingCounts: {},
      diff: { groups: [], semanticOperations: [] },
    };
    expect(repositoryRefreshStreamEventSchema.parse({ type: "review", review }))
      .toEqual({ type: "review", review });
    expect(() => repositoryRefreshStreamEventSchema.parse({
      type: "review",
      review: { ...review, root: "C:/private/repository", fingerprint: "a".repeat(64) },
    })).toThrow();
  });

  it("keeps map queries and authoritative relationship mutations exact", () => {
    expect(mapQuerySchema.parse({ focusRecordId: "record-1", scopeRecordId: "record-0" })).toEqual({
      focusRecordId: "record-1",
      scopeRecordId: "record-0",
    });
    expect(createRelationshipBodySchema.parse({
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      expectedProjectRevision: 7,
    })).toEqual({
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      expectedProjectRevision: 7,
    });
    expect(removeRelationshipBodySchema.parse({
      expectedProjectRevision: 8,
    })).toEqual({ expectedProjectRevision: 8 });
    expect(createRelationshipBodySchema.parse({
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      expectedProjectRevision: Number.MAX_SAFE_INTEGER - 1,
    })).toMatchObject({ expectedProjectRevision: Number.MAX_SAFE_INTEGER - 1 });

    for (const query of [
      { focusRecordId: ["record-1", "record-2"] },
      { scopeRecordId: ["record-1", "record-2"] },
      { scopeRecordId: "record-1" },
      { focusRecordId: "x".repeat(513) },
      { scopeRecordId: "" },
      { focusRecordId: "record-1", future: "private" },
    ]) expect(() => mapQuerySchema.parse(query)).toThrow();

    for (const body of [
      {
        fromRecordId: "outcome-1",
        toRecordId: "task-1",
        kind: "parent_of",
      },
      {
        fromRecordId: "outcome-1",
        toRecordId: "task-1",
        kind: "parent_of",
        expectedProjectRevision: 7,
        x: 120,
      },
      {
        fromRecordId: "outcome-1",
        toRecordId: "task-1",
        kind: "custom-label",
        expectedProjectRevision: 7,
      },
      {
        fromRecordId: "C:/private/repository",
        toRecordId: "task-1",
        kind: "related_to",
        expectedProjectRevision: 7,
      },
      {
        fromRecordId: "outcome-1",
        toRecordId: "task-1",
        kind: "parent_of",
        expectedProjectRevision: Number.MAX_SAFE_INTEGER,
      },
    ]) expect(() => createRelationshipBodySchema.parse(body)).toThrow();
    expect(() => removeRelationshipBodySchema.parse({
      expectedProjectRevision: 8,
      relationshipId: "relationship-1",
    })).toThrow();
    expect(() => removeRelationshipBodySchema.parse({
      expectedProjectRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow();
  });

  it("accepts only exact canonical hierarchy preset updates", () => {
    const software = {
      preset: "software" as const,
      outcome: "Product outcome",
      initiative: "Epic",
      deliverable: "Feature",
      milestone: "Milestone",
      task: "Story or Task",
      nestedTask: "Subtask",
    };
    const body = { expectedProjectRevision: 7, vocabulary: software };

    expect(updateHierarchyVocabularyBodySchema.parse(body)).toEqual(body);
    expect(updateHierarchyVocabularyResponseSchema.parse({
      projectRevision: 8,
      hierarchyVocabulary: software,
    })).toEqual({ projectRevision: 8, hierarchyVocabulary: software });

    for (const invalid of [
      { ...body, future: true },
      { ...body, expectedProjectRevision: Number.MAX_SAFE_INTEGER },
      { ...body, vocabulary: { ...software, task: "Custom task" } },
      { ...body, vocabulary: { ...software, preset: "neutral" } },
      { ...body, vocabulary: { ...software, future: "private" } },
    ]) expect(() => updateHierarchyVocabularyBodySchema.parse(invalid)).toThrow();
  });

  it("validates closed map responses and accepts unplaced hierarchy roots with descendants", () => {
    const record = {
      id: "task-1",
      projectId: "project-1",
      kind: "task" as const,
      status: "active" as const,
      title: "Ship focused maps",
      body: "Expose only the reviewed authority model.",
      sourceKind: "human" as const,
      sourceRef: null,
      revision: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    const summary = {
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      revision: record.revision,
    };
    const outcome = {
      id: "outcome-1",
      kind: "outcome" as const,
      status: "active" as const,
      title: "Keep the hierarchy authoritative",
      revision: 1,
    };
    const edge = {
      id: "relationship-1",
      kind: "parent_of" as const,
      label: "parent of",
      fromRecordId: outcome.id,
      fromLabel: outcome.title,
      toRecordId: summary.id,
      toLabel: summary.title,
    };
    const map = {
      projectId: "project-1",
      projectName: "IntentArc",
      projectRevision: 4,
      hierarchyVocabulary: {
        preset: "neutral" as const,
        outcome: "Outcome",
        initiative: "Initiative",
        deliverable: "Deliverable",
        milestone: "Milestone",
        task: "Work item",
        nestedTask: "Subtask",
      },
      selectedRecordId: summary.id,
      scopeRecordId: outcome.id,
      selectedPath: [outcome, summary],
      hierarchyNodes: [
        { ...outcome, parentId: null, childCount: 1 },
        { ...summary, parentId: outcome.id, childCount: 0 },
      ],
      hierarchyEdges: [edge],
      unplacedRecordIds: [],
      progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
    };
    expect(projectMapResponseSchema.parse(map)).toEqual(map);
    expect(() => projectMapResponseSchema.parse({
      ...map,
      hierarchyNodes: Array.from({ length: 10_001 }, () => ({
        ...summary,
        parentId: null,
        childCount: 0,
      })),
    })).toThrow();
    const alternateParent = {
      id: "milestone-1",
      kind: "milestone" as const,
      status: "active" as const,
      title: "Alternate parent",
      revision: 1,
      parentId: null,
      childCount: 0,
    };
    const rootTask = {
      ...summary,
      id: "task-unplaced-root",
      title: "Unplaced root",
      parentId: null,
      childCount: 0,
    };
    const secondChild = {
      ...summary,
      id: "task-2",
      title: "Second child",
      parentId: outcome.id,
      childCount: 0,
    };
    const invalidCases = [
      {
        ...map,
        hierarchyNodes: [...map.hierarchyNodes, {
          ...rootTask,
          id: "decision-root",
          kind: "decision" as const,
        }],
        unplacedRecordIds: ["decision-root"],
      },
      { ...map, hierarchyNodes: [...map.hierarchyNodes, rootTask] },
      {
        ...map,
        hierarchyNodes: [...map.hierarchyNodes, rootTask],
        unplacedRecordIds: [rootTask.id, rootTask.id],
      },
      { ...map, unplacedRecordIds: [outcome.id] },
      { ...map, selectedPath: [outcome, { ...summary, title: "Spoofed breadcrumb" }] },
      {
        ...map,
        hierarchyNodes: [{ ...map.hierarchyNodes[0]!, childCount: 0 }, map.hierarchyNodes[1]!],
      },
      { ...map, hierarchyEdges: [{ ...edge, label: "spoofed hierarchy label" }] },
      { ...map, hierarchyEdges: [{ ...edge, fromLabel: "Spoofed parent label" }] },
      {
        ...map,
        hierarchyNodes: [{ ...map.hierarchyNodes[0]!, childCount: 2 }, map.hierarchyNodes[1]!, secondChild],
        hierarchyEdges: [...map.hierarchyEdges, {
          ...edge,
          toRecordId: secondChild.id,
          toLabel: secondChild.title,
        }],
      },
      { ...map, hierarchyEdges: [{ ...edge, toRecordId: "missing-record" }] },
      { ...map, hierarchyNodes: [...map.hierarchyNodes, { ...map.hierarchyNodes[1]!, childCount: 0 }] },
      {
        ...map,
        hierarchyNodes: [...map.hierarchyNodes, alternateParent],
        hierarchyEdges: [...map.hierarchyEdges, {
          ...edge,
          id: "relationship-2",
          fromRecordId: alternateParent.id,
          fromLabel: alternateParent.title,
        }],
      },
      { ...map, hierarchyNodes: [map.hierarchyNodes[0]!, { ...map.hierarchyNodes[1]!, parentId: alternateParent.id }] },
      { ...map, unplacedRecordIds: [summary.id] },
      { ...map, selectedPath: [outcome] },
      { ...map, scopeRecordId: alternateParent.id },
      {
        ...map,
        selectedRecordId: null,
        scopeRecordId: null,
        selectedPath: [],
        hierarchyNodes: [
          { ...map.hierarchyNodes[0]!, parentId: summary.id },
          map.hierarchyNodes[1]!,
        ],
        hierarchyEdges: [...map.hierarchyEdges, {
          ...edge,
          id: "relationship-cycle",
          fromRecordId: summary.id,
          fromLabel: summary.title,
          toRecordId: outcome.id,
          toLabel: outcome.title,
        }],
      },
    ];
    for (const body of invalidCases) {
      expect(projectMapResponseSchema.safeParse(body).success).toBe(false);
    }
    const unplacedInitiative = {
      id: "initiative-unplaced",
      kind: "initiative" as const,
      status: "active" as const,
      title: "Unplaced initiative",
      revision: 1,
      parentId: null,
      childCount: 1,
    };
    const unplacedTask = {
      id: "task-unplaced",
      kind: "task" as const,
      status: "active" as const,
      title: "Task beneath an unplaced initiative",
      revision: 1,
      parentId: unplacedInitiative.id,
      childCount: 0,
    };
    const unplacedSubtree = {
      ...map,
      hierarchyNodes: [...map.hierarchyNodes, unplacedInitiative, unplacedTask],
      hierarchyEdges: [...map.hierarchyEdges, {
        id: "relationship-unplaced",
        kind: "parent_of" as const,
        label: "parent of",
        fromRecordId: unplacedInitiative.id,
        fromLabel: unplacedInitiative.title,
        toRecordId: unplacedTask.id,
        toLabel: unplacedTask.title,
      }],
      unplacedRecordIds: [unplacedInitiative.id],
    };
    expect(projectMapResponseSchema.parse(unplacedSubtree)).toEqual(unplacedSubtree);
    expect(projectMapResponseSchema.safeParse({
      ...map,
      selectedRecordId: null,
      scopeRecordId: null,
      selectedPath: [outcome],
    }).success).toBe(false);

    const attachment = {
      linkId: "repository-link-1",
      nodeId: "repository-node-1",
      path: "docs/overview.md",
      nodeKind: "file" as const,
      linkKind: "documents" as const,
      linkLabel: "documents",
      basis: "accepted" as const,
      documentKind: "overview" as const,
      documentFormat: "markdown" as const,
      role: "supporting_document" as const,
    };
    const recordDetail = {
      projectId: "project-1",
      projectRevision: 4,
      record,
      relations: [],
      attachmentsByBasis: {
        accepted: [attachment], observed: [], inferred: [], conflicting: [],
      },
    };
    expect(connectedRecordDetailResponseSchema.parse(recordDetail)).toEqual(recordDetail);
    expect(() => connectedRecordDetailResponseSchema.parse({
      ...recordDetail,
      root: "C:/private/repository",
    })).toThrow();
    expect(() => connectedRecordDetailResponseSchema.parse({
      ...recordDetail,
      attachmentsByBasis: {
        ...recordDetail.attachmentsByBasis,
        accepted: [{ ...attachment, path: "C:/private/repository/docs/overview.md" }],
      },
    })).toThrow();
    expect(() => connectedRecordDetailResponseSchema.parse({
      ...recordDetail,
      record: { ...record, projectId: "project-other" },
    })).toThrow();
    expect(() => connectedRecordDetailResponseSchema.parse({
      ...recordDetail,
      attachmentsByBasis: {
        ...recordDetail.attachmentsByBasis,
        accepted: [{ ...attachment, basis: "observed" }],
      },
    })).toThrow();

    const repositoryDetail = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      node: {
        nodeId: "repository-node-1",
        parentNodeId: null,
        path: "docs/overview.md",
        kind: "file" as const,
        role: "supporting_document" as const,
        documentKind: "overview" as const,
        documentFormat: "markdown" as const,
        contentEligible: true,
      },
      linksByBasis: {
        accepted: [], observed: [], inferred: [], conflicting: [],
      },
    };
    expect(connectedRepositoryDetailResponseSchema.parse(repositoryDetail))
      .toEqual(repositoryDetail);
    expect(() => connectedRepositoryDetailResponseSchema.parse({
      ...repositoryDetail,
      repositoryRoot: "C:/private/repository",
    })).toThrow();
    expect(() => connectedRepositoryDetailResponseSchema.parse({
      ...repositoryDetail,
      linksByBasis: {
        ...repositoryDetail.linksByBasis,
        accepted: [{
          linkId: "repository-link-1",
          kind: "documents",
          label: "documents",
          basis: "observed",
          record: summary,
          node: null,
        }],
      },
    })).toThrow();

    const relationship = {
      id: "relationship-1",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of" as const,
      createdAt: "2026-08-03T00:00:00.000Z",
    };
    expect(relationshipMutationResponseSchema.parse({
      projectRevision: 5,
      relationship,
    })).toEqual({ projectRevision: 5, relationship });
    expect(() => relationshipMutationResponseSchema.parse({
      projectRevision: 5,
      relationship,
      sql: "DELETE FROM record_relationships",
    })).toThrow();
  });

  it("keeps Repository Explorer queries and request-bound responses strict and sanitized", () => {
    expect(repositoryExplorerQuerySchema.parse({
      parentNodeId: "repository-node-docs",
      pageSize: "1000",
      search: "guide",
      relevance: "current_task",
      changed: "true",
      category: "documentation",
      documentKind: "specification",
      role: "supporting_document",
      unlinked: "false",
      contextIncluded: "true",
      state: "current",
      cursor: "opaque.cursor",
    })).toMatchObject({ pageSize: 1_000, search: "guide", changed: true, unlinked: false });
    for (const query of [
      { pageSize: "1001" },
      { pageSize: "0" },
      { pageSize: "01" },
      { changed: "yes" },
      { search: " " },
      { search: "guide\u0000private" },
      { unknown: "private" },
      { state: "current", exclusionReason: "ignored" },
      { parentNodeId: "C:/private/repository" },
    ]) expect(() => repositoryExplorerQuerySchema.parse(query)).toThrow();

    const response = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      parentNodeId: null,
      sourceStatus: "available" as const,
      request: {
        parentNodeId: null,
        pageSize: 200,
        filter: { category: "documentation" as const },
      },
      items: [{
        nodeId: "repository-node-docs",
        parentNodeId: null,
        path: "docs",
        kind: "directory" as const,
        role: "supporting_document" as const,
        documentKind: null,
        documentFormat: null,
        sourceStatus: "derived" as const,
        state: "current" as const,
        contentEligible: false,
        childCount: 2,
        changed: true,
        linked: true,
        currentTaskRelevant: true,
        contextIncluded: false,
      }],
      exclusions: [{ reason: "ignored" as const, count: 3 }],
      hasMore: false,
      nextCursor: null,
    };
    expect(repositoryExplorerResponseSchema.parse(response)).toEqual(response);
    for (const unsafe of [
      { ...response, root: "C:/private/repository" },
      { ...response, items: [{ ...response.items[0], path: "C:/private/repository/docs" }] },
      { ...response, request: { ...response.request, parentNodeId: "node-foreign" } },
      { ...response, request: { ...response.request, contextPackId: "context-private" } },
      { ...response, items: [{ ...response.items[0], parentNodeId: "node-foreign" }] },
    ]) expect(() => repositoryExplorerResponseSchema.parse(unsafe)).toThrow();
  });

  it("adapts strict bounded coordination query strings to public service inputs", () => {
    expect(coordinationReadyQuerySchema.parse({
      expectedProjectRevision: "7", cursor: "YWJj", limit: "20",
    })).toEqual({ expectedProjectRevision: 7, cursor: "YWJj", limit: 20 });
    expect(coordinationStateQuerySchema.parse({
      taskId: "task-1", expectedProjectRevision: "7",
    })).toEqual({ taskId: "task-1", expectedProjectRevision: 7 });
    for (const query of [
      { expectedProjectRevision: "07", limit: "20" },
      { expectedProjectRevision: "7", limit: "0" },
      { expectedProjectRevision: "7", limit: "101" },
      { expectedProjectRevision: "7", limit: "20", future: "private" },
      { expectedProjectRevision: ["7", "8"], limit: "20" },
    ]) expect(() => coordinationReadyQuerySchema.parse(query)).toThrow();
    expect(() => coordinationStateQuerySchema.parse({
      taskId: "task-1", expectedProjectRevision: "7", future: "private",
    })).toThrow();
  });

  it("keeps every coordination mutation body closed and preserves domain byte limits", () => {
    const checkpoint = {
      summary: "Checkpoint", completedWork: ["Implemented route."],
      remainingWork: ["Verify route."], blockers: [],
      verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
      repositoryEvidence: null,
    };
    const bodies = [
      [coordinationClaimBodySchema, { projectId: "project-1", taskId: "task-1", expectedProjectRevision: 7, expectedTaskRevision: 1, contextBudgetTokens: 1_000, acceptedDelegationId: null, idempotencyKey: "claim-1" }],
      [coordinationRenewBodySchema, { claimId: "claim-1", expectedProjectRevision: 7, expectedTaskRevision: 1, idempotencyKey: "renew-1" }],
      [coordinationCheckpointBodySchema, { claimId: "claim-1", expectedProjectRevision: 7, expectedTaskRevision: 1, checkpoint, idempotencyKey: "checkpoint-1" }],
      [coordinationTransitionBodySchema, { claimId: "claim-1", expectedProjectRevision: 7, expectedTaskRevision: 1, action: "pause", idempotencyKey: "pause-1" }],
      [coordinationSwitchBodySchema, { currentClaimId: "claim-1", projectId: "project-1", currentTaskId: "task-1", expectedCurrentProjectRevision: 7, expectedCurrentTaskRevision: 1, checkpoint, terminalAction: "release", nextTaskId: "task-2", expectedNextProjectRevision: 7, expectedNextTaskRevision: 1, nextContextBudgetTokens: 1_000, acceptedDelegationId: null, idempotencyKey: "switch-1" }],
      [coordinationCreateDelegationBodySchema, { projectId: "project-1", taskId: "task-1", childProfileId: "profile-2", expectedProjectRevision: 7, expectedTaskRevision: 1, scope: { summary: "Bounded work", constraints: [] }, allowedOutputs: ["update_record"], deadline: "2026-08-16T13:00:00.000Z", idempotencyKey: "delegate-1" }],
      [coordinationAcceptDelegationBodySchema, { delegationId: "delegation-1", projectId: "project-1", taskId: "task-1", expectedProjectRevision: 7, expectedTaskRevision: 1, idempotencyKey: "accept-1" }],
      [coordinationRevokeDelegationBodySchema, { delegationId: "delegation-1", projectId: "project-1", taskId: "task-1", expectedProjectRevision: 7, expectedTaskRevision: 1, idempotencyKey: "revoke-1" }],
      [coordinationSubmissionBodySchema, { claimId: "claim-1", checkpointId: "checkpoint-1", expectedProjectRevision: 7, expectedTaskRevision: 1, submission: { summary: "Submit bounded work.", verificationEvidence: { tests: ["pnpm test"], artifacts: [] }, repositoryEvidence: null, changes: { rationale: "Complete the task.", operations: [] } }, idempotencyKey: "submit-1" }],
    ] as const;
    for (const [schema, body] of bodies) {
      expect(schema.parse(body)).toEqual(body);
      expect(() => schema.parse({ ...body, future: "private" })).toThrow();
    }
    expect(() => coordinationCheckpointBodySchema.parse({
      ...bodies[2]![1], checkpoint: { ...checkpoint, summary: "x".repeat(65_537) },
    })).toThrow();
    expect(() => coordinationSubmissionBodySchema.parse({
      ...bodies[8]![1], submission: { ...bodies[8]![1].submission, summary: "x".repeat(262_145) },
    })).toThrow();

    const emptyMaximumCheckpoint = { ...checkpoint, summary: "" };
    const maximumCheckpoint = {
      ...emptyMaximumCheckpoint,
      summary: "x".repeat(
        65_536 - new TextEncoder().encode(JSON.stringify(emptyMaximumCheckpoint)).byteLength,
      ),
    };
    const claim = {
      id: "claim-1", projectId: "project-1", taskId: "task-1",
      profileId: "profile-1", delegationId: null, state: "active" as const,
      baseProjectRevision: 7, baseTaskRevision: 1, contextPackId: "pack-1",
      acquiredAt: "2026-08-15T08:00:00.000Z",
      expiresAt: "2026-08-15T08:30:00.000Z",
      absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
      endedAt: null, latestCheckpointId: "checkpoint-maximum",
    };
    expect(coordinationCheckpointResponseSchema.parse({
      claim,
      checkpoint: {
        ...maximumCheckpoint,
        id: "checkpoint-maximum", claimId: claim.id, sequence: 1,
        createdAt: "2026-08-15T08:10:00.000Z", projectRevision: 7,
        taskRevision: 1, contextPackId: claim.contextPackId,
      },
    }).checkpoint.summary).toHaveLength(maximumCheckpoint.summary.length);
  });

  it("rejects unchecked fields from coordination response DTOs", () => {
    expect(coordinationReadyResponseSchema.parse({
      tasks: [], nextCursor: null, projectRevision: 7,
    })).toEqual({ tasks: [], nextCursor: null, projectRevision: 7 });
    expect(() => coordinationReadyResponseSchema.parse({
      tasks: [], nextCursor: null, projectRevision: 7, token: "private-token",
    })).toThrow();
  });
});
