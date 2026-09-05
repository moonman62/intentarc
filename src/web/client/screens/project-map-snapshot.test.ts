import { describe, expect, it } from "vitest";
import type { ProjectMapResponse } from "../../contracts.js";
import {
  deriveProjectMapLocalView,
  normalizeProjectMapSnapshot,
  reconcileProjectMapRevisions,
} from "./project-map-snapshot.js";

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

const wholeProjectResponse = (hierarchyNodes: Node[]): ProjectMapResponse => ({
  projectId: "project-1",
  projectName: "Project",
  projectRevision: 7,
  hierarchyVocabulary: {
    preset: "neutral",
    outcome: "Outcome",
    initiative: "Initiative",
    deliverable: "Deliverable",
    milestone: "Milestone",
    task: "Work item",
    nestedTask: "Subtask",
  },
  selectedRecordId: null,
  scopeRecordId: null,
  selectedPath: [],
  hierarchyNodes,
  hierarchyEdges: [],
  unplacedRecordIds: ["unplaced-1"],
  progress: { childStatuses: { completed: 1 }, childrenWithEvidence: 1, childCount: 2 },
});

const hierarchy = [
  node("outcome-1", "outcome", null, 1),
  node("feature-1", "deliverable", "outcome-1", 2),
  node("task-1", "task", "feature-1", 0),
  node("task-2", "task", "feature-1", 1),
  node("deep-task", "task", "task-2", 0),
  node("outcome-2", "outcome", null, 1),
  node("other-task", "task", "outcome-2", 0),
  node("unplaced-1", "task", null, 1),
  node("unplaced-child", "task", "unplaced-1", 0),
];

describe("project map snapshots", () => {
  it("rejects a topology response that contains server selection state", () => {
    const response = wholeProjectResponse(hierarchy);
    const taskOne = hierarchy[2]!;

    expect(() => normalizeProjectMapSnapshot({
      ...response,
      selectedRecordId: "task-1",
      selectedPath: [taskOne],
    })).toThrow("selection-neutral");
  });

  it("indexes the neutral topology and retains the authoritative project progress", () => {
    const response = wholeProjectResponse(hierarchy);
    const snapshot = normalizeProjectMapSnapshot(response);

    expect(snapshot.nodesById.get("feature-1")).toBe(hierarchy[1]);
    expect(snapshot.childrenByParent.get("feature-1")).toEqual(["task-1", "task-2"]);
    expect(snapshot.projectProgress).toBe(response.progress);
  });

  it("derives a local selected path without changing an already visible projection", () => {
    const snapshot = normalizeProjectMapSnapshot(wholeProjectResponse(hierarchy));
    const unselected = deriveProjectMapLocalView({
      snapshot,
      selectedId: null,
      scopeId: null,
      visibleDepth: 2,
      expandedIds: new Set(),
      collapsedIds: new Set(),
    });
    const selected = deriveProjectMapLocalView({
      snapshot,
      selectedId: "task-2",
      scopeId: null,
      visibleDepth: 2,
      expandedIds: new Set(),
      collapsedIds: new Set(),
    });

    expect(selected.selectedPath.map(({ id }) => id)).toEqual([
      "outcome-1", "feature-1", "task-2",
    ]);
    expect(selected.projectedNodes.map(({ record }) => record.id)).toEqual(
      unselected.projectedNodes.map(({ record }) => record.id),
    );
  });

  it("reveals a hidden selected path without expanding unrelated branches", () => {
    const snapshot = normalizeProjectMapSnapshot(wholeProjectResponse(hierarchy));
    const view = deriveProjectMapLocalView({
      snapshot,
      selectedId: "deep-task",
      scopeId: null,
      visibleDepth: 1,
      expandedIds: new Set(),
      collapsedIds: new Set(),
    });

    expect(view.projectedNodes.map(({ record }) => record.id)).toEqual([
      "outcome-1", "feature-1", "task-1", "task-2", "deep-task", "outcome-2", "other-task",
    ]);
  });

  it("keeps a hidden selected path inside its local scope", () => {
    const snapshot = normalizeProjectMapSnapshot(wholeProjectResponse(hierarchy));
    const view = deriveProjectMapLocalView({
      snapshot,
      selectedId: "deep-task",
      scopeId: "feature-1",
      visibleDepth: 0,
      expandedIds: new Set(),
      collapsedIds: new Set(),
    });

    expect(view.projectedNodes.map(({ record }) => record.id)).toEqual([
      "feature-1", "task-1", "task-2", "deep-task",
    ]);
    expect(view.projectedNodes[0]).toMatchObject({ parentId: null, depth: 0 });
  });

  it("rejects missing, unplaced, and out-of-scope local selection", () => {
    const snapshot = normalizeProjectMapSnapshot(wholeProjectResponse(hierarchy));
    const input = {
      snapshot,
      visibleDepth: 2,
      expandedIds: new Set<string>(),
      collapsedIds: new Set<string>(),
    };

    expect(() => deriveProjectMapLocalView({ ...input, selectedId: "missing", scopeId: null }))
      .toThrow("Invalid project map forest");
    expect(() => deriveProjectMapLocalView({ ...input, selectedId: "unplaced-1", scopeId: null }))
      .toThrow("Invalid project map forest");
    expect(() => deriveProjectMapLocalView({ ...input, selectedId: "other-task", scopeId: "feature-1" }))
      .toThrow("Invalid project map forest");
  });

  it("rejects a missing or unplaced scope and preserves unplaced work separately", () => {
    const snapshot = normalizeProjectMapSnapshot(wholeProjectResponse(hierarchy));
    const input = {
      snapshot,
      selectedId: null,
      visibleDepth: 2,
      expandedIds: new Set<string>(),
      collapsedIds: new Set<string>(),
    };

    expect(() => deriveProjectMapLocalView({ ...input, scopeId: "missing" }))
      .toThrow("Invalid project map forest");
    expect(() => deriveProjectMapLocalView({ ...input, scopeId: "unplaced-1" }))
      .toThrow("Invalid project map forest");
    expect(deriveProjectMapLocalView({ ...input, scopeId: null }).unplaced.map(({ id }) => id))
      .toEqual(["unplaced-1", "unplaced-child"]);
  });

  it("rejects a cyclic topology before deriving local state", () => {
    const cyclic = wholeProjectResponse([
      node("outcome-1", "outcome", "task-1", 1),
      node("task-1", "task", "outcome-1", 1),
    ]);
    cyclic.unplacedRecordIds = [];

    expect(() => deriveProjectMapLocalView({
      snapshot: normalizeProjectMapSnapshot(cyclic),
      selectedId: null,
      scopeId: null,
      visibleDepth: 2,
      expandedIds: new Set(),
      collapsedIds: new Set(),
    })).toThrow("Invalid project map forest");
  });

  it.each([
    [{ topologyRevision: 8, detailRevision: 8, retryUsed: false }, { kind: "matched", revision: 8 }],
    [{ topologyRevision: 7, detailRevision: 8, retryUsed: false }, { kind: "retry-topology", expectedRevision: 8 }],
    [{ topologyRevision: 9, detailRevision: 8, retryUsed: false }, { kind: "retry-detail", expectedRevision: 9 }],
    [{ topologyRevision: 9, detailRevision: 8, retryUsed: true }, { kind: "failed" }],
  ] as const)("reconciles topology and detail revisions %#", (input, expected) => {
    expect(reconcileProjectMapRevisions(input)).toEqual(expected);
  });
});
