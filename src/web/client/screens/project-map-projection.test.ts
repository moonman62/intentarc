import { describe, expect, it } from "vitest";
import type { ProjectMapResponse } from "../../contracts.js";
import { deriveProjectMapProjection } from "./project-map-projection.js";

type Node = ProjectMapResponse["hierarchyNodes"][number];

const node = (
  id: string,
  kind: Node["kind"],
  parentId: string | null,
  childCount: number,
): Node => ({
  id,
  kind,
  status: "active",
  title: id,
  revision: 1,
  parentId,
  childCount,
});

const mapFor = (
  hierarchyNodes: Node[],
  selectedRecordId: string | null = null,
  scopeRecordId: string | null = null,
  unplacedRecordIds: string[] = [],
): ProjectMapResponse => {
  const nodesById = new Map(hierarchyNodes.map((item) => [item.id, item]));
  const selectedPath: ProjectMapResponse["selectedPath"] = [];
  let cursor = selectedRecordId === null ? null : nodesById.get(selectedRecordId) ?? null;
  while (cursor !== null) {
    selectedPath.unshift({
      id: cursor.id,
      kind: cursor.kind,
      status: cursor.status,
      title: cursor.title,
      revision: cursor.revision,
    });
    cursor = cursor.parentId === null ? null : nodesById.get(cursor.parentId) ?? null;
  }
  return ({
  projectId: "project-1",
  projectName: "Project",
  projectRevision: 1,
  hierarchyVocabulary: {
    preset: "neutral",
    outcome: "Outcome",
    initiative: "Initiative",
    deliverable: "Deliverable",
    milestone: "Milestone",
    task: "Work item",
    nestedTask: "Subtask",
  },
  selectedRecordId,
  scopeRecordId,
  selectedPath,
  hierarchyNodes,
  hierarchyEdges: hierarchyNodes
    .filter(({ parentId }) => parentId !== null)
    .map((child) => {
      const parent = hierarchyNodes.find(({ id }) => id === child.parentId)!;
      return {
        id: `edge-${parent.id}-${child.id}`,
        kind: "parent_of" as const,
        label: "parent of",
        fromRecordId: parent.id,
        fromLabel: parent.title,
        toRecordId: child.id,
        toLabel: child.title,
      };
    }),
  unplacedRecordIds,
  progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
  });
};

const projectionFor = (
  hierarchyNodes: Node[],
  selectedRecordId: string | null = null,
  scopeRecordId: string | null = null,
  unplacedRecordIds: string[] = [],
) => {
  const map = mapFor(hierarchyNodes, selectedRecordId, scopeRecordId, unplacedRecordIds);
  const nodesById = new Map(map.hierarchyNodes.map((record) => [record.id, record]));
  return {
    nodes: map.hierarchyNodes,
    unplacedRecordIds: new Set(map.unplacedRecordIds),
    selectedId: selectedRecordId,
    selectedPath: map.selectedPath.map(({ id }) => nodesById.get(id)!),
    scopeId: scopeRecordId,
  };
};

describe("deriveProjectMapProjection", () => {
  const forest = [
    node("outcome-a", "outcome", null, 2),
    node("feature-a", "deliverable", "outcome-a", 1),
    node("task-deep-path", "task", "feature-a", 1),
    node("task-deep-child", "task", "task-deep-path", 0),
    node("feature-b", "deliverable", "outcome-a", 2),
    node("task-b-1", "task", "feature-b", 0),
    node("task-b-2", "task", "feature-b", 0),
    node("outcome-b", "outcome", null, 1),
    node("task-other", "task", "outcome-b", 0),
    node("task-unplaced", "task", null, 0),
  ];

  it("keeps existing visible-card selection projection-neutral", () => {
    const projection = deriveProjectMapProjection({
      ...projectionFor(forest, "task-deep-path", null, ["task-unplaced"]),
      visibleDepth: 2,
      expandedIds: new Set(),
    });

    expect(projection.visibleIds).toEqual(new Set([
      "outcome-a", "feature-a", "feature-b", "task-deep-path", "task-b-1", "task-b-2", "outcome-b", "task-other",
    ]));
    expect(projection.nodes.map(({ record }) => record.id)).toEqual([
      "outcome-a", "feature-a", "task-deep-path", "feature-b", "task-b-1", "task-b-2", "outcome-b", "task-other",
    ]);
    expect(projection.nodes.find(({ record }) => record.id === "task-deep-path")?.depth)
      .toBe(2);
    expect(projection.nodes.find(({ record }) => record.id === "feature-b")?.hiddenChildCount)
      .toBe(0);
    expect(projection.unplaced.map(({ id }) => id)).toEqual(["task-unplaced"]);
  });

  it("reveals an explicitly expanded branch without changing global depth", () => {
    const projection = deriveProjectMapProjection({
      ...projectionFor(forest, "task-deep-path", null, ["task-unplaced"]),
      visibleDepth: 2,
      expandedIds: new Set(["feature-b"]),
    });

    expect(projection.nodes.map(({ record }) => record.id)).toEqual([
      "outcome-a", "feature-a", "task-deep-path", "feature-b", "task-b-1", "task-b-2", "outcome-b", "task-other",
    ]);
    expect(projection.nodes.find(({ record }) => record.id === "feature-b")?.hiddenChildCount)
      .toBe(0);
  });

  it("keeps selected ancestors expanded when stale collapse state would contradict rendered descendants", () => {
    const deepForest = [
      node("outcome-a", "outcome", null, 1),
      node("feature-a", "deliverable", "outcome-a", 1),
      node("task-parent", "task", "feature-a", 2),
      node("task-selected", "task", "task-parent", 0),
      node("task-sibling", "task", "task-parent", 1),
      node("task-sibling-child", "task", "task-sibling", 0),
    ];

    const projection = deriveProjectMapProjection({
      ...projectionFor(deepForest, "task-selected"),
      visibleDepth: 1,
      expandedIds: new Set(),
      collapsedIds: new Set(["task-parent"]),
    });

    expect(projection.nodes.map(({ record }) => record.id)).toEqual([
      "outcome-a",
      "feature-a",
      "task-parent",
      "task-selected",
      "task-sibling",
    ]);
    expect(projection.nodes.find(({ record }) => record.id === "task-sibling")?.hiddenChildCount)
      .toBe(1);
    expect(projection.nodes.find(({ record }) => record.id === "task-parent")).toMatchObject({
      childCount: 2,
      childrenExpanded: true,
      hiddenChildCount: 0,
    });
  });

  it("makes projection the sole collapse authority for depth-eligible children and hidden counts", () => {
    const projection = deriveProjectMapProjection({
      ...projectionFor(forest),
      visibleDepth: 2,
      expandedIds: new Set(),
      collapsedIds: new Set(["feature-b"]),
    });

    expect(projection.visibleIds.has("task-b-1")).toBe(false);
    expect(projection.visibleIds.has("task-b-2")).toBe(false);
    expect(projection.nodes.find(({ record }) => record.id === "feature-b")).toMatchObject({
      childCount: 0,
      hiddenChildCount: 2,
    });
  });

  it("limits a focused branch to its context path and excludes unrelated descendants", () => {
    const projection = deriveProjectMapProjection({
      ...projectionFor(forest, "task-deep-path", "feature-a", ["task-unplaced"]),
      visibleDepth: 2,
      expandedIds: new Set(),
    });

    expect(projection.nodes.map(({ record }) => record.id)).toEqual([
      "feature-a", "task-deep-path", "task-deep-child",
    ]);
    expect(projection.nodes[0]).toMatchObject({ parentId: null, depth: 0 });
    expect(projection.unplaced.map(({ id }) => id)).toEqual(["task-unplaced"]);
  });

  it("rejects a malformed parent cycle before returning a partial tree", () => {
    const malformed = mapFor([
      node("outcome-a", "outcome", "task-a", 1),
      node("task-a", "task", "outcome-a", 1),
    ]);

    expect(() => deriveProjectMapProjection({
      ...projectionFor(malformed.hierarchyNodes),
      visibleDepth: 2,
      expandedIds: new Set(),
    })).toThrow("Invalid project map forest");
  });

  it("indexes a deep forest iteratively without recursive call-stack growth", () => {
    const hierarchyNodes: Node[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      hierarchyNodes.push(node(
        `task-${index}`,
        index === 0 ? "outcome" : "task",
        index === 0 ? null : `task-${index - 1}`,
        index === 9_999 ? 0 : 1,
      ));
    }

    const projection = deriveProjectMapProjection({
      ...projectionFor(hierarchyNodes),
      visibleDepth: 0,
      expandedIds: new Set(),
    });

    expect(projection.nodes.map(({ record }) => record.id)).toEqual(["task-0"]);
  });
});
