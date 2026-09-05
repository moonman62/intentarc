import type { ProjectMapResponse } from "../../contracts.js";
import {
  deriveProjectMapProjection,
  type HierarchyDisplayNode,
} from "./project-map-projection.js";

type MapNode = ProjectMapResponse["hierarchyNodes"][number];

export interface ProjectMapSnapshot {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRevision: number;
  readonly vocabulary: ProjectMapResponse["hierarchyVocabulary"];
  readonly nodes: readonly MapNode[];
  readonly edges: readonly ProjectMapResponse["hierarchyEdges"][number][];
  readonly unplacedRecordIds: ReadonlySet<string>;
  readonly unplacedIds: ReadonlySet<string>;
  readonly projectProgress: ProjectMapResponse["progress"];
  readonly nodesById: ReadonlyMap<string, MapNode>;
  readonly childrenByParent: ReadonlyMap<string | null, readonly string[]>;
}

export interface ProjectMapLocalView {
  readonly selectedId: string | null;
  readonly scopeId: string | null;
  readonly selectedPath: readonly MapNode[];
  readonly projectedNodes: readonly HierarchyDisplayNode[];
  readonly unplaced: readonly MapNode[];
}

export type ProjectMapRevisionReconciliation =
  | { readonly kind: "matched"; readonly revision: number }
  | { readonly kind: "retry-topology"; readonly expectedRevision: number }
  | { readonly kind: "retry-detail"; readonly expectedRevision: number }
  | { readonly kind: "failed" };

const invalidForest = (): Error => new Error("Invalid project map forest");

export function normalizeProjectMapSnapshot(response: ProjectMapResponse): ProjectMapSnapshot {
  if (
    response.selectedRecordId !== null ||
    response.scopeRecordId !== null ||
    response.selectedPath.length !== 0
  ) throw new Error("Project Map topology must be selection-neutral.");

  const nodesById = new Map(response.hierarchyNodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string | null, string[]>();
  for (const node of response.hierarchyNodes) {
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  }
  const unplacedIds = new Set<string>();
  const unplacedStack = [...response.unplacedRecordIds];
  while (unplacedStack.length > 0) {
    const id = unplacedStack.pop()!;
    if (unplacedIds.has(id)) continue;
    unplacedIds.add(id);
    for (const childId of childrenByParent.get(id) ?? []) unplacedStack.push(childId);
  }
  return {
    projectId: response.projectId,
    projectName: response.projectName,
    projectRevision: response.projectRevision,
    vocabulary: response.hierarchyVocabulary,
    nodes: response.hierarchyNodes,
    edges: response.hierarchyEdges,
    unplacedRecordIds: new Set(response.unplacedRecordIds),
    unplacedIds,
    projectProgress: response.progress,
    nodesById,
    childrenByParent,
  };
}

const localSelectedPath = (
  snapshot: ProjectMapSnapshot,
  selectedId: string | null,
): readonly MapNode[] => {
  if (selectedId === null) return [];
  const path: MapNode[] = [];
  const seen = new Set<string>();
  let cursor = snapshot.nodesById.get(selectedId);
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) throw invalidForest();
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId === null ? undefined : snapshot.nodesById.get(cursor.parentId);
  }
  if (path.length === 0 || path.at(-1)?.parentId !== null) throw invalidForest();
  return path.reverse();
};

export function deriveProjectMapLocalView(input: {
  readonly snapshot: ProjectMapSnapshot;
  readonly selectedId: string | null;
  readonly scopeId: string | null;
  readonly visibleDepth: number;
  readonly expandedIds: ReadonlySet<string>;
  readonly collapsedIds: ReadonlySet<string>;
}): ProjectMapLocalView {
  const selectedPath = localSelectedPath(input.snapshot, input.selectedId);
  const projection = deriveProjectMapProjection({
    nodes: input.snapshot.nodes,
    unplacedRecordIds: input.snapshot.unplacedRecordIds,
    selectedId: input.selectedId,
    selectedPath,
    scopeId: input.scopeId,
    visibleDepth: input.visibleDepth,
    expandedIds: input.expandedIds,
    collapsedIds: input.collapsedIds,
  });
  return {
    selectedId: input.selectedId,
    scopeId: input.scopeId,
    selectedPath,
    projectedNodes: projection.nodes,
    unplaced: projection.unplaced,
  };
}

export function reconcileProjectMapRevisions(input: {
  readonly topologyRevision: number;
  readonly detailRevision: number;
  readonly retryUsed: boolean;
}): ProjectMapRevisionReconciliation {
  if (input.topologyRevision === input.detailRevision) {
    return { kind: "matched", revision: input.topologyRevision };
  }
  if (input.retryUsed) return { kind: "failed" };
  return input.topologyRevision < input.detailRevision
    ? { kind: "retry-topology", expectedRevision: input.detailRevision }
    : { kind: "retry-detail", expectedRevision: input.topologyRevision };
}
