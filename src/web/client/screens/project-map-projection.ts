import type { ProjectMapResponse } from "../../contracts.js";

export interface HierarchyDisplayNode {
  readonly record: ProjectMapResponse["hierarchyNodes"][number];
  readonly parentId: string | null;
  readonly depth: number;
  readonly childCount: number;
  readonly hiddenChildCount: number;
  readonly childrenExpanded: boolean;
}

export interface ProjectMapProjection {
  readonly nodes: readonly HierarchyDisplayNode[];
  readonly visibleIds: ReadonlySet<string>;
  readonly unplaced: readonly ProjectMapResponse["hierarchyNodes"][number][];
}

type MapNode = ProjectMapResponse["hierarchyNodes"][number];

interface LocalProjectionInput {
  readonly nodes: readonly MapNode[];
  readonly unplacedRecordIds: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly selectedPath: readonly MapNode[];
  readonly scopeId: string | null;
  readonly visibleDepth: number;
  readonly expandedIds: ReadonlySet<string>;
  readonly collapsedIds?: ReadonlySet<string>;
}

const invalidForest = (): Error => new Error("Invalid project map forest");

/**
 * Derive the bounded client projection without mutating or recursively walking
 * the authoritative forest. Local selection only reveals ancestry for a
 * cold/deep route that is not already visible in the bounded projection.
 */
export function deriveProjectMapProjection(
  local: LocalProjectionInput,
): ProjectMapProjection {
  const nodesById = new Map<string, MapNode>();
  const childrenByParent = new Map<string | null, MapNode[]>();

  for (const record of local.nodes) {
    if (nodesById.has(record.id) || !Number.isSafeInteger(record.childCount) || record.childCount < 0) {
      throw invalidForest();
    }
    nodesById.set(record.id, record);
    const children = childrenByParent.get(record.parentId) ?? [];
    children.push(record);
    childrenByParent.set(record.parentId, children);
  }

  for (const record of local.nodes) {
    if (record.parentId !== null && !nodesById.has(record.parentId)) throw invalidForest();
    if ((childrenByParent.get(record.id)?.length ?? 0) !== record.childCount) throw invalidForest();
  }

  const visitState = new Map<string, 0 | 1 | 2>();
  for (const record of local.nodes) {
    if (visitState.get(record.id) === 2) continue;
    const path: string[] = [];
    let cursor: string | null = record.id;
    while (cursor !== null) {
      const state = visitState.get(cursor);
      if (state === 1) throw invalidForest();
      if (state === 2) break;
      const current = nodesById.get(cursor);
      if (current === undefined) throw invalidForest();
      visitState.set(cursor, 1);
      path.push(cursor);
      cursor = current.parentId;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) visitState.set(path[index]!, 2);
  }

  const unplacedRoots = new Set<string>();
  for (const id of local.unplacedRecordIds) {
    if (unplacedRoots.has(id)) throw invalidForest();
    const record = nodesById.get(id);
    if (record === undefined || record.parentId !== null) throw invalidForest();
    unplacedRoots.add(id);
  }

  const unplacedIds = new Set<string>();
  const unplacedStack = [...unplacedRoots];
  while (unplacedStack.length > 0) {
    const id = unplacedStack.pop()!;
    if (unplacedIds.has(id)) continue;
    unplacedIds.add(id);
    for (const child of childrenByParent.get(id) ?? []) unplacedStack.push(child.id);
  }

  const selectedPathIds = new Set<string>();
  if (local.selectedId === null) {
    if (local.selectedPath.length > 0) throw invalidForest();
  } else {
    if (local.selectedPath.length === 0 || local.selectedPath.at(-1)?.id !== local.selectedId) {
      throw invalidForest();
    }
    let previousId: string | null = null;
    for (const summary of local.selectedPath) {
      const record = nodesById.get(summary.id);
      if (record === undefined || record !== summary || unplacedIds.has(summary.id)) throw invalidForest();
      if (selectedPathIds.has(summary.id) || record.parentId !== previousId) throw invalidForest();
      selectedPathIds.add(summary.id);
      previousId = summary.id;
    }
  }

  const scopeIds = new Set<string>();
  if (local.scopeId !== null) {
    if (!nodesById.has(local.scopeId) || unplacedIds.has(local.scopeId)) throw invalidForest();
    if (local.selectedId !== null && !selectedPathIds.has(local.scopeId)) throw invalidForest();
    const scopeStack = [local.scopeId];
    while (scopeStack.length > 0) {
      const id = scopeStack.pop()!;
      if (scopeIds.has(id) || unplacedIds.has(id)) continue;
      scopeIds.add(id);
      for (const child of childrenByParent.get(id) ?? []) scopeStack.push(child.id);
    }
  }

  const maxDepth = Number.isFinite(local.visibleDepth)
    ? Math.max(0, Math.floor(local.visibleDepth))
    : 0;
  const allowedByScope = (id: string): boolean => local.scopeId === null || scopeIds.has(id);
  const selectedAncestorIds = new Set(selectedPathIds);
  if (local.selectedId !== null) selectedAncestorIds.delete(local.selectedId);
  const isEffectivelyCollapsed = (id: string): boolean => (
    (local.collapsedIds?.has(id) ?? false) && !selectedAncestorIds.has(id)
  );
  const displayRoots = local.scopeId === null
    ? childrenByParent.get(null) ?? []
    : [nodesById.get(local.scopeId)!];
  const depthById = new Map<string, number>();
  const visibleIds = new Set<string>();
  const traversal: Array<{ readonly record: MapNode; readonly depth: number }> = [];

  for (let index = displayRoots.length - 1; index >= 0; index -= 1) {
    const root = displayRoots[index]!;
    if (unplacedIds.has(root.id)) continue;
    visibleIds.add(root.id);
    depthById.set(root.id, 0);
    traversal.push({ record: root, depth: 0 });
  }

  while (traversal.length > 0) {
    const frame = traversal.pop()!;
    const children = childrenByParent.get(frame.record.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (unplacedIds.has(child.id) || !allowedByScope(child.id)) continue;
      const childDepth = frame.depth + 1;
      depthById.set(child.id, childDepth);
      const parentCollapsed = isEffectivelyCollapsed(frame.record.id);
      const visible = !parentCollapsed && (
        local.expandedIds.has(frame.record.id) || childDepth <= maxDepth
      );
      if (!visible) continue;
      visibleIds.add(child.id);
      traversal.push({ record: child, depth: childDepth });
    }
  }

  if (local.selectedId !== null && !visibleIds.has(local.selectedId)) {
    const revealedPath = local.scopeId === null
      ? local.selectedPath
      : local.selectedPath.filter(({ id }) => scopeIds.has(id));
    for (const selected of revealedPath) {
      visibleIds.add(selected.id);
      const parent = selected.parentId === null ? null : nodesById.get(selected.parentId);
      if (parent === undefined) throw invalidForest();
      depthById.set(selected.id, selected.id === local.scopeId || parent === null
        ? 0
        : (depthById.get(parent.id) ?? 0) + 1);
    }
    for (const selected of revealedPath) {
      if (isEffectivelyCollapsed(selected.id)) continue;
      for (const child of childrenByParent.get(selected.id) ?? []) {
        if (unplacedIds.has(child.id) || !allowedByScope(child.id)) continue;
        visibleIds.add(child.id);
        depthById.set(child.id, (depthById.get(selected.id) ?? 0) + 1);
      }
    }
  }

  const nodes: HierarchyDisplayNode[] = [];
  for (const record of local.nodes) {
    if (!visibleIds.has(record.id)) continue;
    const visibleChildCount = (childrenByParent.get(record.id) ?? [])
      .reduce((count, child) => count + (visibleIds.has(child.id) ? 1 : 0), 0);
    nodes.push({
      record,
      parentId: record.id === local.scopeId ? null : record.parentId,
      depth: depthById.get(record.id)!,
      childCount: visibleChildCount,
      hiddenChildCount: record.childCount - visibleChildCount,
      childrenExpanded: visibleChildCount > 0 && !isEffectivelyCollapsed(record.id),
    });
  }

  return {
    nodes,
    visibleIds,
    unplaced: local.nodes.filter(({ id }) => unplacedIds.has(id)),
  };
}
