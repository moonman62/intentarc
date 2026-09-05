import { describe, expect, it } from "vitest";
import type {
  Project,
  ProjectRecord,
  RecordRelationship,
  RepositoryLink,
  RepositoryNodeObservation,
  RepositorySnapshot,
  RepositorySource,
} from "../domain/index.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import type { RepositoryIndexStore } from "../storage/repository-index-store.js";
import { createProjectMapService } from "./project-map-service.js";

const timestamp = "2026-08-03T10:00:00.000Z";
const project: Project = {
  id: "project-1",
  name: "IntentArc",
  revision: 12,
  primaryRepositoryPath: "C:\\private\\IntentArc",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const hierarchyVocabulary = {
  preset: "software" as const,
  outcome: "Product outcome",
  initiative: "Epic",
  deliverable: "Feature",
  milestone: "Milestone",
  task: "Story or Task",
  nestedTask: "Subtask",
};

const record = (
  id: string,
  kind: ProjectRecord["kind"],
  title: string,
  status: ProjectRecord["status"] = "active",
): ProjectRecord => ({
  id,
  projectId: project.id,
  kind,
  status,
  title,
  body: `${title} body`,
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const records = [
  record("outcome", "outcome", "Ship structured knowledge"),
  record("milestone", "milestone", "Outcome spine"),
  record("task-a", "task", "A completed task", "completed"),
  record("task-b", "task", "B active task"),
  record("orphan", "task", "Unparented task", "blocked"),
  record("evidence", "evidence", "Passing test evidence", "accepted"),
  record("decision", "decision", "Use explicit hierarchy", "accepted"),
  record("constraint", "constraint", "Stay local first", "accepted"),
  record("component", "component", "Map service", "active"),
  record("constraint-a", "constraint", "Same constraint", "accepted"),
  record("constraint-z", "constraint", "Same constraint", "accepted"),
  record("decision-a", "decision", "Same repository target", "accepted"),
  record("decision-z", "decision", "Same repository target", "accepted"),
];

const relationship = (
  id: string,
  fromRecordId: string,
  toRecordId: string,
  kind: RecordRelationship["kind"],
): RecordRelationship => ({
  id,
  projectId: project.id,
  fromRecordId,
  toRecordId,
  kind,
  createdAt: timestamp,
});

const relationships = [
  relationship("p1", "outcome", "milestone", "parent_of"),
  relationship("p2", "milestone", "task-a", "parent_of"),
  relationship("p3", "milestone", "task-b", "parent_of"),
  relationship("e1", "evidence", "task-a", "evidenced_by"),
  relationship("r1", "task-a", "decision", "decided_by"),
  relationship("r2", "decision", "constraint", "constrained_by"),
  relationship("r3", "constraint", "component", "related_to"),
  relationship("p4", "milestone", "decision", "parent_of"),
  relationship("z-edge-to-a", "task-b", "constraint-a", "related_to"),
  relationship("a-edge-to-z", "task-b", "constraint-z", "related_to"),
];

const snapshot: RepositorySnapshot = {
  id: "snapshot-1",
  sourceId: "source-1",
  projectId: project.id,
  state: "accepted",
  baseSnapshotId: null,
  baseProjectRevision: 11,
  branch: "main",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
  scannerVersion: "1",
  rulesetVersion: "1",
  warningCounts: {},
  exclusionCounts: { ignored: 3, known_secret_path: 2 },
  findingCounts: {},
  createdAt: timestamp,
  decidedAt: timestamp,
  appliedAt: timestamp,
};

const source: RepositorySource = {
  id: snapshot.sourceId,
  projectId: project.id,
  root: "C:\\private\\IntentArc",
  canonicalSubpath: null,
  repositoryIdentity: "git-common-dir:private-identity",
  status: "available",
  currentSnapshotId: snapshot.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const observations: RepositoryNodeObservation[] = [
  {
    snapshotId: snapshot.id,
    nodeId: "node-doc",
    parentNodeId: null,
    path: "docs/map.md",
    kind: "file",
    sha256: "c".repeat(64),
    byteSize: 128,
    sourceStatus: "tracked",
    role: "documentation",
    documentKind: "specification",
    documentFormat: "markdown",
    contentEligible: true,
    instructionClient: null,
    instructionScope: null,
  },
  {
    snapshotId: snapshot.id,
    nodeId: "node-test",
    parentNodeId: null,
    path: "src/map.test.ts",
    kind: "file",
    sha256: "d".repeat(64),
    byteSize: 256,
    sourceStatus: "tracked",
    role: "test",
    documentKind: null,
    documentFormat: null,
    contentEligible: false,
    instructionClient: null,
    instructionScope: null,
  },
];

const links: RepositoryLink[] = [
  {
    id: "link-accepted",
    projectId: project.id,
    snapshotId: snapshot.id,
    fromNodeId: "node-doc",
    toRecordId: "task-a",
    toNodeId: null,
    kind: "documents",
    basis: "accepted",
    createdAt: timestamp,
  },
  {
    id: "link-inferred",
    projectId: project.id,
    snapshotId: snapshot.id,
    fromNodeId: "node-test",
    toRecordId: "task-a",
    toNodeId: null,
    kind: "evidences",
    basis: "inferred",
    createdAt: timestamp,
  },
  {
    id: "link-node",
    projectId: project.id,
    snapshotId: snapshot.id,
    fromNodeId: "node-doc",
    toRecordId: null,
    toNodeId: "node-test",
    kind: "related_to",
    basis: "observed",
    createdAt: timestamp,
  },
  {
    id: "z-link-to-a",
    projectId: project.id,
    snapshotId: snapshot.id,
    fromNodeId: "node-doc",
    toRecordId: "decision-a",
    toNodeId: null,
    kind: "related_to",
    basis: "accepted",
    createdAt: timestamp,
  },
  {
    id: "a-link-to-z",
    projectId: project.id,
    snapshotId: snapshot.id,
    fromNodeId: "node-doc",
    toRecordId: "decision-z",
    toNodeId: null,
    kind: "related_to",
    basis: "accepted",
    createdAt: timestamp,
  },
];

const projectStore: ProjectReadStore = {
  withReadSnapshot: (read) => read(),
  listProjects: () => [project],
  getProject: (projectId) => projectId === project.id ? project : null,
  getHierarchyVocabulary: (projectId) => {
    if (projectId !== project.id) throw new Error("Project not found");
    return hierarchyVocabulary;
  },
  getRecord: (projectId, recordId) => projectId === project.id
    ? records.find((item) => item.id === recordId) ?? null
    : null,
  listRecords: (projectId) => projectId === project.id ? [...records] : [],
  listRelationships: (projectId) => projectId === project.id ? [...relationships] : [],
  listRelationshipsForRecord: (projectId, recordId) => projectId === project.id
    ? relationships.filter((item) => item.fromRecordId === recordId || item.toRecordId === recordId)
    : [],
};

const repositoryStore: Pick<
  RepositoryIndexStore,
  | "getSource"
  | "getCurrentSnapshot"
  | "getObservation"
  | "listObservations"
  | "listLinks"
  | "listExplorerChildren"
> = {
  getSource: (projectId) => projectId === project.id ? source : null,
  getCurrentSnapshot: (projectId) => projectId === project.id ? snapshot : null,
  getObservation: (snapshotId, nodeId) => snapshotId === snapshot.id
    ? observations.find((item) => item.nodeId === nodeId) ?? null
    : null,
  listObservations: (snapshotId) => snapshotId === snapshot.id ? [...observations] : [],
  listLinks: (projectId) => projectId === project.id ? [...links] : [],
  listExplorerChildren: () => [],
};

describe("project map service", () => {
  const service = createProjectMapService({ projectStore, repositoryStore });

  it("returns a deterministic authoritative hierarchy forest for Project selection", () => {
    const forestRecords = [
      record("outcome-a", "outcome", "Outcome A"),
      record("feature-a", "deliverable", "Feature A"),
      record("task-a", "task", "Task A"),
      record("task-deep", "task", "Task Deep"),
      record("feature-b", "deliverable", "Feature B"),
      record("task-b", "task", "Task B"),
      record("outcome-b", "outcome", "Outcome B"),
      record("task-unplaced", "task", "Task Unplaced"),
      record("decision-a", "decision", "Decision A", "accepted"),
    ];
    const forestRelationships = [
      relationship("parent-a-feature-a", "outcome-a", "feature-a", "parent_of"),
      relationship("parent-feature-a-task-a", "feature-a", "task-a", "parent_of"),
      relationship("parent-task-a-deep", "task-a", "task-deep", "parent_of"),
      relationship("parent-a-feature-b", "outcome-a", "feature-b", "parent_of"),
      relationship("parent-feature-b-task-b", "feature-b", "task-b", "parent_of"),
      relationship("unrelated", "task-b", "decision-a", "related_to"),
    ];
    const forestStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (projectId, recordId) => projectId === project.id
        ? forestRecords.find((item) => item.id === recordId) ?? null
        : null,
      listRecords: (projectId) => projectId === project.id ? forestRecords : [],
      listRelationships: (projectId) => projectId === project.id ? forestRelationships : [],
      listRelationshipsForRecord: (projectId, recordId) => projectId === project.id
        ? forestRelationships.filter((item) =>
          item.fromRecordId === recordId || item.toRecordId === recordId)
        : [],
    };
    const forestService = createProjectMapService({ projectStore: forestStore, repositoryStore });

    const projectView = forestService.getProjectMap(project.id);

    expect(projectView.selectedRecordId).toBeNull();
    expect(projectView.scopeRecordId).toBeNull();
    expect(projectView.selectedPath).toEqual([]);
    expect(projectView.hierarchyNodes.map(({ id }) => id)).toEqual([
      "outcome-a", "feature-a", "task-a", "task-deep",
      "feature-b", "task-b", "outcome-b", "task-unplaced",
    ]);
    expect(projectView.hierarchyNodes.map(({ id, parentId, childCount }) =>
      [id, parentId, childCount]
    )).toEqual([
      ["outcome-a", null, 2],
      ["feature-a", "outcome-a", 1],
      ["task-a", "feature-a", 1],
      ["task-deep", "task-a", 0],
      ["feature-b", "outcome-a", 1],
      ["task-b", "feature-b", 0],
      ["outcome-b", null, 0],
      ["task-unplaced", null, 0],
    ]);
    expect(projectView.hierarchyEdges.map(({ id }) => id)).toEqual([
      "parent-feature-a-task-a",
      "parent-feature-b-task-b",
      "parent-a-feature-a",
      "parent-a-feature-b",
      "parent-task-a-deep",
    ]);
    expect(projectView.unplacedRecordIds).toEqual(["task-unplaced"]);
    expect(projectView.hierarchyEdges.every(({ kind }) => kind === "parent_of")).toBe(true);
    expect(projectView.progress).toEqual({
      childStatuses: { active: 2 },
      childrenWithEvidence: 0,
      childCount: 2,
    });
  });

  it("validates hierarchy selection scope and rolls up selected immediate children", () => {
    const forestRecords = [
      record("outcome-a", "outcome", "Outcome A"),
      record("feature-a", "deliverable", "Feature A"),
      record("task-a", "task", "Task A"),
      record("task-deep", "task", "Task Deep"),
      record("feature-b", "deliverable", "Feature B"),
      record("task-b", "task", "Task B"),
      record("outcome-b", "outcome", "Outcome B"),
      record("task-unplaced", "task", "Task Unplaced"),
      record("decision-a", "decision", "Decision A", "accepted"),
      record("evidence-a", "evidence", "Evidence A", "accepted"),
    ];
    const forestRelationships = [
      relationship("parent-a-feature-a", "outcome-a", "feature-a", "parent_of"),
      relationship("parent-feature-a-task-a", "feature-a", "task-a", "parent_of"),
      relationship("parent-task-a-deep", "task-a", "task-deep", "parent_of"),
      relationship("parent-a-feature-b", "outcome-a", "feature-b", "parent_of"),
      relationship("parent-feature-b-task-b", "feature-b", "task-b", "parent_of"),
      relationship("unrelated", "task-b", "decision-a", "related_to"),
      relationship("evidence-deep", "evidence-a", "task-deep", "evidenced_by"),
    ];
    const forestStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (projectId, recordId) => projectId === project.id
        ? forestRecords.find((item) => item.id === recordId) ?? null
        : null,
      listRecords: (projectId) => projectId === project.id ? forestRecords : [],
      listRelationships: (projectId) => projectId === project.id ? forestRelationships : [],
      listRelationshipsForRecord: (projectId, recordId) => projectId === project.id
        ? forestRelationships.filter((item) =>
          item.fromRecordId === recordId || item.toRecordId === recordId)
        : [],
    };
    const forestService = createProjectMapService({ projectStore: forestStore, repositoryStore });

    const focused = forestService.getProjectMap(project.id, "task-deep", "feature-a");

    expect(focused.selectedRecordId).toBe("task-deep");
    expect(focused.scopeRecordId).toBe("feature-a");
    expect(focused.selectedPath.map(({ id }) => id)).toEqual([
      "outcome-a", "feature-a", "task-a", "task-deep",
    ]);
    expect(() => forestService.getProjectMap(project.id, "task-b", "feature-a"))
      .toThrowError(/scope/i);
    expect(() => forestService.getProjectMap(project.id, "decision-a"))
      .toThrowError(/hierarchy/i);
    expect(forestService.getProjectMap(project.id, "task-a").progress).toEqual({
      childStatuses: { active: 1 },
      childrenWithEvidence: 1,
      childCount: 1,
    });
  });

  it("rejects a hierarchy record with more than one parent", () => {
    const invalidRecords = [
      record("outcome-a", "outcome", "Outcome A"),
      record("outcome-b", "outcome", "Outcome B"),
      record("task-child", "task", "Task Child"),
    ];
    const invalidRelationships = [
      relationship("parent-a", "outcome-a", "task-child", "parent_of"),
      relationship("parent-b", "outcome-b", "task-child", "parent_of"),
    ];
    const invalidStore: ProjectReadStore = {
      ...projectStore,
      listRecords: () => invalidRecords,
      listRelationships: () => invalidRelationships,
    };
    const invalidService = createProjectMapService({
      projectStore: invalidStore,
      repositoryStore,
    });

    expect(() => invalidService.getProjectMap(project.id)).toThrowError(/one parent/i);
  });

  it("rejects a cyclic hierarchy before traversing a selected path", () => {
    const invalidRecords = [
      record("outcome-a", "outcome", "Outcome A"),
      record("task-a", "task", "Task A"),
    ];
    const invalidRelationships = [
      relationship("parent-a", "outcome-a", "task-a", "parent_of"),
      relationship("parent-b", "task-a", "outcome-a", "parent_of"),
    ];
    const invalidStore: ProjectReadStore = {
      ...projectStore,
      listRecords: () => invalidRecords,
      listRelationships: () => invalidRelationships,
    };
    const invalidService = createProjectMapService({
      projectStore: invalidStore,
      repositoryStore,
    });

    expect(() => invalidService.getProjectMap(project.id, "task-a")).toThrowError(/cycle/i);
  });

  it("accepts exactly 10,000 hierarchy records and reports a stable typed error above the bound", () => {
    const boundedRecords = Array.from({ length: 10_001 }, (_, index) =>
      record(`bounded-${index}`, "outcome", `Bounded ${index.toString().padStart(5, "0")}`)
    );
    const boundedStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (_projectId, recordId) =>
        boundedRecords.find((item) => item.id === recordId) ?? null,
      listRecords: () => boundedRecords.slice(0, 10_000),
      listRelationships: () => [],
      listRelationshipsForRecord: () => [],
    };
    const boundedService = createProjectMapService({
      projectStore: boundedStore,
      repositoryStore,
    });

    expect(boundedService.getProjectMap(project.id).hierarchyNodes).toHaveLength(10_000);

    boundedStore.listRecords = () => boundedRecords;
    try {
      boundedService.getProjectMap(project.id);
      expect.unreachable("the hierarchy bound should reject 10,001 records");
    } catch (error) {
      expect(error).toMatchObject({
        name: "GovernanceError",
        code: "project_map_limit_exceeded",
        message: "Project map supports at most 10,000 hierarchy records.",
      });
    }
  }, 30_000);

  it("indexes relationship evidence once for a broad active progress rollup", () => {
    const childCount = 1_000;
    const broadRecords = [
      record("broad-outcome", "outcome", "Broad outcome"),
      record("broad-evidence", "evidence", "Broad evidence", "accepted"),
      ...Array.from({ length: childCount }, (_, index) =>
        record(`broad-child-${index}`, "task", `Broad child ${index}`)
      ),
    ];
    const parentRelationships = Array.from({ length: childCount }, (_, index) =>
      relationship(`broad-parent-${index}`, "broad-outcome", `broad-child-${index}`, "parent_of")
    );
    let evidenceKindReads = 0;
    const unrelatedEvidenceRelationships = Array.from({ length: childCount }, (_, index) => {
      const item = relationship(
        `broad-evidence-${index}`,
        "broad-evidence",
        "broad-outcome",
        "evidenced_by",
      );
      Object.defineProperty(item, "kind", {
        enumerable: true,
        get() {
          evidenceKindReads += 1;
          if (evidenceKindReads > childCount * 2) {
            throw new Error("relationship evidence was scanned more than twice");
          }
          return "evidenced_by";
        },
      });
      return item;
    });
    const broadStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (_projectId, recordId) =>
        broadRecords.find((item) => item.id === recordId) ?? null,
      listRecords: () => broadRecords,
      listRelationships: () => [...parentRelationships, ...unrelatedEvidenceRelationships],
      listRelationshipsForRecord: () => [],
    };
    const broadService = createProjectMapService({ projectStore: broadStore, repositoryStore });

    expect(broadService.getProjectMap(project.id, "broad-outcome").progress).toEqual({
      childStatuses: { active: childCount },
      childrenWithEvidence: 0,
      childCount,
    });
    expect(evidenceKindReads).toBe(childCount * 2);
  });

  it("exposes only the authoritative project-map read model", () => {
    expect(Object.keys(service).sort()).toEqual([
      "getProjectMap",
      "getRecordDetail",
      "getRepositoryNodeDetail",
      "getRepositoryTree",
    ]);
  });

  it("builds an explicit arbitrary-depth selected path with child rollups and unplaced records", () => {
    const view = service.getProjectMap(project.id, "task-a");

    expect(view.projectName).toBe("IntentArc");
    expect(view.hierarchyVocabulary).toEqual(hierarchyVocabulary);
    expect(view.selectedRecordId).toBe("task-a");
    expect(view.selectedPath.map(({ id }) => id)).toEqual(["outcome", "milestone", "task-a"]);
    expect(view.hierarchyNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "task-b", title: "B active task", parentId: "milestone", childCount: 0 }),
    ]));
    expect(view.hierarchyEdges
      .filter(({ id }) => id === "p1" || id === "p2")
      .map(({ id, label }) => [id, label])).toEqual(expect.arrayContaining([
      ["p1", "parent of"],
      ["p2", "parent of"],
    ]));
    expect(view.unplacedRecordIds).toEqual(["orphan"]);
    expect(view.progress).toEqual({
      childStatuses: {},
      childrenWithEvidence: 0,
      childCount: 0,
    });
    expect(service.getProjectMap(project.id, "milestone").progress).toEqual({
      childStatuses: { active: 1, completed: 1 },
      childrenWithEvidence: 1,
      childCount: 2,
    });
    expect(service.getProjectMap(project.id, "milestone").hierarchyNodes
      .filter(({ parentId }) => parentId === "milestone")
      .map(({ id }) => id)).toEqual(["task-a", "task-b"]);
    expect(service.getRecordDetail(project.id, "milestone").relations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          edge: expect.objectContaining({ id: "p4", label: "parent of" }),
          record: expect.objectContaining({ id: "decision" }),
        }),
      ]));
  });

  it("traverses every governed hierarchy kind and returns every hierarchy node", () => {
    const hierarchyRecords = [
      record("outcome-five", "outcome", "Outcome"),
      record("initiative-five", "initiative", "Initiative"),
      record("deliverable-five", "deliverable", "Deliverable"),
      record("task-five", "task", "Task"),
      record("subtask-five", "task", "Subtask"),
    ];
    const hierarchyRelationships = [
      relationship("five-1", "outcome-five", "initiative-five", "parent_of"),
      relationship("five-2", "initiative-five", "deliverable-five", "parent_of"),
      relationship("five-3", "deliverable-five", "task-five", "parent_of"),
      relationship("five-4", "task-five", "subtask-five", "parent_of"),
    ];
    const hierarchyStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (_projectId, recordId) =>
        hierarchyRecords.find((item) => item.id === recordId) ?? null,
      listRecords: () => hierarchyRecords,
      listRelationships: () => hierarchyRelationships,
      listRelationshipsForRecord: (_projectId, recordId) =>
        hierarchyRelationships.filter((item) =>
          item.fromRecordId === recordId || item.toRecordId === recordId),
    };

    const view = createProjectMapService({
      projectStore: hierarchyStore,
      repositoryStore,
    }).getProjectMap(project.id, "subtask-five");

    expect(view.selectedPath.map(({ id }) => id)).toEqual([
      "outcome-five",
      "initiative-five",
      "deliverable-five",
      "task-five",
      "subtask-five",
    ]);
    expect(view.hierarchyNodes.map(({ id }) => id)).toEqual([
      "outcome-five",
      "initiative-five",
      "deliverable-five",
      "task-five",
      "subtask-five",
    ]);
  });

  it("requires an explicit hierarchy selection and never infers parents from paths or titles", () => {
    const projectMap = service.getProjectMap(project.id);

    expect(projectMap.selectedRecordId).toBeNull();
    expect(projectMap.hierarchyNodes.filter(({ kind, parentId }) =>
      kind === "outcome" && parentId === null).map(({ id }) => id)).toEqual(["outcome"]);
    expect(projectMap.unplacedRecordIds).toEqual(["orphan"]);
    expect(() => service.getProjectMap(project.id, "node-doc")).toThrowError(/hierarchy/i);
  });

  it("returns labelled two-level record relations and accepted-snapshot attachments grouped by basis", () => {
    const detail = service.getRecordDetail(project.id, "task-a");

    expect(detail.relations.map(({ depth, edge }) => [depth, edge.id, edge.label])).toEqual([
      [1, "r1", "decided by"],
      [1, "e1", "evidenced by"],
      [1, "p2", "parent of"],
      [2, "r2", "constrained by"],
    ]);
    expect(detail.attachmentsByBasis.accepted).toEqual([
      expect.objectContaining({ nodeId: "node-doc", path: "docs/map.md", linkId: "link-accepted" }),
    ]);
    expect(detail.attachmentsByBasis.inferred).toEqual([
      expect.objectContaining({ nodeId: "node-test", path: "src/map.test.ts", linkId: "link-inferred" }),
    ]);
  });

  it("returns sanitized repository-node detail without absolute roots or content", () => {
    const detail = service.getRepositoryNodeDetail(project.id, "node-doc");

    expect(detail.node).toEqual(expect.objectContaining({
      nodeId: "node-doc",
      path: "docs/map.md",
      kind: "file",
    }));
    expect(JSON.stringify(detail)).not.toContain("C:\\\\private");
    expect(JSON.stringify(detail)).not.toContain("body");
    expect(detail.linksByBasis.accepted[0]).toEqual(expect.objectContaining({
      linkId: "link-accepted",
      label: "documents",
      record: expect.objectContaining({ id: "task-a", title: "A completed task" }),
    }));
    expect(detail.linksByBasis.observed[0]).toEqual(expect.objectContaining({
      linkId: "link-node",
      label: "related to",
      node: expect.objectContaining({ nodeId: "node-test", path: "src/map.test.ts" }),
    }));
    expect(detail.linksByBasis.accepted
      .filter(({ kind }) => kind === "related_to")
      .map(({ record }) => record?.id)).toEqual(["decision-a", "decision-z"]);
  });

  it("rejects records, nodes, and projects outside the requested project", () => {
    expect(() => service.getProjectMap("project-other")).toThrow();
    expect(() => service.getRecordDetail(project.id, "missing")).toThrow();
    expect(() => service.getRepositoryNodeDetail(project.id, "missing")).toThrow();
  });

  it("builds an arbitrary-depth current path iteratively", () => {
    const depth = 1_500;
    const deepRecords = Array.from({ length: depth }, (_, index) =>
      record(`deep-${index}`, index === 0 ? "outcome" : "task", `Deep ${index}`)
    );
    const deepRelationships = Array.from({ length: depth - 1 }, (_, index) =>
      relationship(`deep-parent-${index}`, `deep-${index}`, `deep-${index + 1}`, "parent_of")
    );
    const deepStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (projectId, recordId) => projectId === project.id
        ? deepRecords.find((item) => item.id === recordId) ?? null
        : null,
      listRecords: (projectId) => projectId === project.id ? deepRecords : [],
      listRelationships: (projectId) => projectId === project.id ? deepRelationships : [],
      listRelationshipsForRecord: (projectId, recordId) => projectId === project.id
        ? deepRelationships.filter((item) => item.fromRecordId === recordId || item.toRecordId === recordId)
        : [],
    };
    const deepService = createProjectMapService({ projectStore: deepStore, repositoryStore });

    const view = deepService.getProjectMap(project.id, `deep-${depth - 1}`);

    expect(view.selectedPath).toHaveLength(depth);
    expect(view.hierarchyEdges).toHaveLength(depth - 1);
    expect(view.selectedPath[0]?.id).toBe("deep-0");
    expect(view.selectedPath.at(-1)?.id).toBe(`deep-${depth - 1}`);
  });

  it("returns every hierarchy record in the bounded authoritative map", () => {
    const distant = record("distant-child", "task", "Distant hierarchy child");
    const candidateStore: ProjectReadStore = {
      ...projectStore,
      getRecord: (projectId, recordId) => projectId === project.id
        ? [...records, distant].find((item) => item.id === recordId) ?? null
        : null,
      listRecords: (projectId) => projectId === project.id ? [...records, distant] : [],
      listRelationships: (projectId) => projectId === project.id
        ? [...relationships, relationship("p-distant", "task-b", distant.id, "parent_of")]
        : [],
    };

    const view = createProjectMapService({ projectStore: candidateStore, repositoryStore })
      .getProjectMap(project.id, "task-a");

    expect(view.hierarchyNodes.map(({ id }) => id)).toEqual([
      "outcome", "milestone", "task-a", "task-b", "distant-child", "orphan",
    ]);
  });

  it("returns a stable explicit empty map when a project has no hierarchy records", () => {
    const emptyStore: ProjectReadStore = {
      ...projectStore,
      getRecord: () => null,
      listRecords: () => [record("decision-only", "decision", "A decision", "accepted")],
      listRelationships: () => [],
      listRelationshipsForRecord: () => [],
    };
    const emptyService = createProjectMapService({ projectStore: emptyStore, repositoryStore });

    expect(emptyService.getProjectMap(project.id)).toEqual({
      projectId: project.id,
      projectName: project.name,
      projectRevision: project.revision,
      hierarchyVocabulary,
      selectedRecordId: null,
      scopeRecordId: null,
      selectedPath: [],
      hierarchyNodes: [],
      hierarchyEdges: [],
      unplacedRecordIds: [],
      progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
    });
  });

  it("sorts tied focused relations by related record ID rather than edge ID", () => {
    const detail = service.getRecordDetail(project.id, "task-b");

    expect(detail.relations
      .filter(({ depth, edge }) => depth === 1 && edge.kind === "related_to")
      .map(({ record }) => record.id)).toEqual(["constraint-a", "constraint-z"]);
  });

  it("pages accepted repository children with a request-bound stable cursor", () => {
    const directory = {
      ...observations[0]!,
      nodeId: "node-directory",
      path: "docs",
      kind: "directory" as const,
      sha256: null,
      byteSize: 0,
      sourceStatus: "derived" as const,
      documentKind: null,
      documentFormat: null,
      contentEligible: false,
    };
    const rootFile = { ...observations[1]!, nodeId: "node-root", path: "README.md" };
    const calls: unknown[] = [];
    const explorerRepositoryStore = {
      ...repositoryStore,
      getSource: () => source,
      listExplorerChildren: (input: { after?: { nodeId: string } }) => {
        calls.push(input);
        return input.after === undefined
          ? [
              { observation: directory, childCount: 1, changed: true, linked: true, currentTaskRelevant: true, contextIncluded: true },
              { observation: rootFile, childCount: 0, changed: false, linked: false, currentTaskRelevant: false, contextIncluded: false },
            ]
          : [];
      },
    };
    const explorer = createProjectMapService({
      projectStore,
      repositoryStore: explorerRepositoryStore as never,
      currentContextPackId: () => "context-1",
    });

    const first = explorer.getRepositoryTree({ projectId: project.id, pageSize: 1 });

    expect(first).toMatchObject({
      projectId: project.id,
      snapshotId: snapshot.id,
      parentNodeId: null,
      request: { pageSize: 1, parentNodeId: null, filter: {} },
      items: [{ nodeId: "node-directory", path: "docs", kind: "directory", changed: true }],
      hasMore: true,
      exclusions: [
        { reason: "ignored", count: 3 },
        { reason: "known_secret_path", count: 2 },
      ],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(calls[0]).toEqual(expect.objectContaining({
      currentTaskId: "task-b",
      contextPackId: "context-1",
    }));

    const second = explorer.getRepositoryTree({
      projectId: project.id,
      pageSize: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toEqual([]);
    expect(second.hasMore).toBe(false);

    expect(() => explorer.getRepositoryTree({
      projectId: project.id,
      pageSize: 2,
      cursor: first.nextCursor!,
    })).toThrow(/cursor/i);
    const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith("a") ? "b" : "a"}`;
    expect(() => explorer.getRepositoryTree({
      projectId: project.id,
      pageSize: 1,
      cursor: tampered,
    })).toThrow(/cursor/i);
  });

  it("combines Explorer filters from accepted links, records, packs, and refresh evidence", () => {
    const calls: unknown[] = [];
    const explorer = createProjectMapService({
      projectStore,
      repositoryStore: {
        ...repositoryStore,
        getSource: () => source,
        getObservation: (_snapshotId: string, nodeId: string) => nodeId === "node-directory"
          ? {
              ...observations[0]!,
              nodeId,
              path: "docs",
              kind: "directory",
              sha256: null,
              byteSize: 0,
              sourceStatus: "derived",
              documentKind: null,
              documentFormat: null,
              contentEligible: false,
            }
          : null,
        listExplorerChildren: (input: unknown) => {
          calls.push(input);
          return [];
        },
      } as never,
      currentContextPackId: () => "context-accepted",
    });

    const view = explorer.getRepositoryTree({
      projectId: project.id,
      parentNodeId: "node-directory",
      filter: {
        search: "guide",
        relevance: "current_task",
        changed: true,
        category: "documentation",
        documentKind: "specification",
        role: "supporting_document",
        unlinked: false,
        contextIncluded: true,
        state: "current",
      },
    });

    expect(calls).toEqual([expect.objectContaining({
      projectId: project.id,
      snapshotId: snapshot.id,
      parentNodeId: "node-directory",
      limit: 201,
      currentTaskId: "task-b",
      contextPackId: "context-accepted",
      filter: expect.objectContaining({ search: "guide", changed: true, category: "documentation" }),
    })]);
    expect(view.request).not.toHaveProperty("contextPackId");
    expect(view.items).toEqual([]);
  });

  it("rejects cursors when task, context, source, or project truth changes", () => {
    let liveProject = project;
    let liveSource = source;
    let liveRecords = [...records];
    let liveContextPackId = "context-1";
    const mutableProjectStore: ProjectReadStore = {
      ...projectStore,
      getProject: (projectId) => projectId === project.id ? liveProject : null,
      listRecords: (projectId) => projectId === project.id ? liveRecords : [],
    };
    const explorer = createProjectMapService({
      projectStore: mutableProjectStore,
      repositoryStore: {
        ...repositoryStore,
        getSource: () => liveSource,
        listExplorerChildren: ({ after }: { after?: unknown }) => after === undefined
          ? [
              { observation: observations[0]!, childCount: 0, changed: true, linked: true, currentTaskRelevant: true, contextIncluded: true },
              { observation: observations[1]!, childCount: 0, changed: false, linked: false, currentTaskRelevant: false, contextIncluded: false },
            ]
          : [],
      } as never,
      currentContextPackId: () => liveContextPackId,
    });
    const cursor = explorer.getRepositoryTree({ projectId: project.id, pageSize: 1 }).nextCursor!;
    const continuation = () => explorer.getRepositoryTree({
      projectId: project.id,
      pageSize: 1,
      cursor,
    });

    liveSource = { ...source, status: "unavailable" };
    expect(continuation).toThrow(/cursor/i);
    liveSource = source;
    liveProject = { ...project, revision: project.revision + 1 };
    expect(continuation).toThrow(/cursor/i);
    liveProject = project;
    liveRecords = liveRecords.map((item) => item.id === "task-b"
      ? { ...item, status: "completed" }
      : item);
    expect(continuation).toThrow(/cursor/i);
    liveRecords = [...records];
    liveContextPackId = "context-2";
    expect(continuation).toThrow(/cursor/i);
  });

  it("returns only sanitized exclusion aggregates and keeps pending candidates out of tree reads", () => {
    const explorer = createProjectMapService({
      projectStore,
      repositoryStore: {
        ...repositoryStore,
        getSource: () => source,
        listExplorerChildren: () => { throw new Error("excluded aggregate must not enumerate paths"); },
      } as never,
    });

    expect(explorer.getRepositoryTree({
      projectId: project.id,
      filter: { state: "excluded", exclusionReason: "known_secret_path" },
    })).toMatchObject({
      snapshotId: snapshot.id,
      items: [],
      hasMore: false,
      nextCursor: null,
      exclusions: [{ reason: "known_secret_path", count: 2 }],
    });
    expect(explorer.getRepositoryTree({
      projectId: project.id,
      filter: { state: "excluded", category: "documentation" },
    }).exclusions).toEqual([]);
  });
});
