export interface ProjectMapTreeLayoutNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly order: number;
  readonly width: number;
  readonly height: number;
}

export interface ProjectMapTreePosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface ProjectMapTreeLayout {
  readonly positions: ReadonlyMap<string, ProjectMapTreePosition>;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ProjectMapTreeLayoutOptions {
  readonly siblingGap: number;
  readonly subtreeGap: number;
  readonly levelGap: number;
}

interface IndexedNode {
  readonly node: ProjectMapTreeLayoutNode;
  readonly inputIndex: number;
  readonly children: IndexedNode[];
}

interface UnnormalizedPosition extends ProjectMapTreePosition {}

const assertFiniteNonNegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
};

const assertFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
};

const sortChildren = (children: IndexedNode[]): void => {
  children.sort((left, right) => {
    if (left.node.order < right.node.order) return -1;
    if (left.node.order > right.node.order) return 1;
    return left.inputIndex - right.inputIndex;
  });
};

const widthWithChildren = (
  node: IndexedNode,
  subtreeWidths: ReadonlyMap<string, number>,
  siblingGap: number,
): number => {
  if (node.children.length === 0) return node.node.width;
  const childrenWidth = node.children.reduce(
    (sum, child) => sum + subtreeWidths.get(child.node.id)!,
    siblingGap * (node.children.length - 1),
  );
  return Math.max(node.node.width, childrenWidth);
};

export function layoutProjectMapTree(
  nodes: readonly ProjectMapTreeLayoutNode[],
  options: ProjectMapTreeLayoutOptions,
): ProjectMapTreeLayout {
  assertFiniteNonNegative(options.siblingGap, "siblingGap");
  assertFiniteNonNegative(options.subtreeGap, "subtreeGap");
  assertFiniteNonNegative(options.levelGap, "levelGap");

  if (nodes.length === 0) {
    return {
      positions: new Map(),
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  const indexedById = new Map<string, IndexedNode>();
  for (const [inputIndex, node] of nodes.entries()) {
    assertFinite(node.order, `order for ${node.id}`);
    assertFiniteNonNegative(node.width, `width for ${node.id}`);
    assertFiniteNonNegative(node.height, `height for ${node.id}`);
    if (indexedById.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    indexedById.set(node.id, { node, inputIndex, children: [] });
  }

  const roots: IndexedNode[] = [];
  for (const indexedNode of indexedById.values()) {
    if (indexedNode.node.parentId === null) {
      roots.push(indexedNode);
      continue;
    }
    const parent = indexedById.get(indexedNode.node.parentId);
    if (parent === undefined) {
      throw new Error(
        `missing parent ${indexedNode.node.parentId} for node ${indexedNode.node.id}`,
      );
    }
    parent.children.push(indexedNode);
  }
  sortChildren(roots);
  for (const indexedNode of indexedById.values()) sortChildren(indexedNode.children);

  const depthById = new Map<string, number>();
  for (const start of indexedById.values()) {
    if (depthById.has(start.node.id)) continue;
    const path: IndexedNode[] = [];
    const pathIndexById = new Map<string, number>();
    let current: IndexedNode | undefined = start;
    let baseDepth = 0;
    while (current !== undefined && !depthById.has(current.node.id)) {
      const existingPathIndex = pathIndexById.get(current.node.id);
      if (existingPathIndex !== undefined) {
        throw new Error(`cycle detected at node ${current.node.id}`);
      }
      pathIndexById.set(current.node.id, path.length);
      path.push(current);
      if (current.node.parentId === null) break;
      current = indexedById.get(current.node.parentId);
    }
    if (current !== undefined && depthById.has(current.node.id)) {
      baseDepth = depthById.get(current.node.id)! + 1;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depthById.set(path[index]!.node.id, baseDepth + path.length - 1 - index);
    }
  }

  const postorder: IndexedNode[] = [];
  const postorderStack: Array<{ readonly node: IndexedNode; readonly expanded: boolean }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    postorderStack.push({ node: roots[index]!, expanded: false });
  }
  while (postorderStack.length > 0) {
    const frame = postorderStack.pop()!;
    if (frame.expanded) {
      postorder.push(frame.node);
      continue;
    }
    postorderStack.push({ node: frame.node, expanded: true });
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      postorderStack.push({ node: frame.node.children[index]!, expanded: false });
    }
  }

  const subtreeWidths = new Map<string, number>();
  for (const node of postorder) {
    subtreeWidths.set(node.node.id, widthWithChildren(node, subtreeWidths, options.siblingGap));
  }

  const rowHeightByDepth = new Map<number, number>();
  let maxDepth = 0;
  for (const indexedNode of indexedById.values()) {
    const depth = depthById.get(indexedNode.node.id)!;
    maxDepth = Math.max(maxDepth, depth);
    rowHeightByDepth.set(
      depth,
      Math.max(rowHeightByDepth.get(depth) ?? 0, indexedNode.node.height),
    );
  }
  const rowTopByDepth = new Map<number, number>([[0, 0]]);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    rowTopByDepth.set(
      depth,
      rowTopByDepth.get(depth - 1)! + rowHeightByDepth.get(depth - 1)! + options.levelGap,
    );
  }

  const unnormalizedPositions = new Map<string, UnnormalizedPosition>();
  const preorderStack: Array<{ readonly node: IndexedNode; readonly bandStart: number }> = [];
  const rootFrames: Array<{ readonly node: IndexedNode; readonly bandStart: number }> = [];
  let nextRootStart = 0;
  for (const root of roots) {
    rootFrames.push({ node: root, bandStart: nextRootStart });
    nextRootStart += subtreeWidths.get(root.node.id)! + options.subtreeGap;
  }
  for (let index = rootFrames.length - 1; index >= 0; index -= 1) {
    preorderStack.push(rootFrames[index]!);
  }
  while (preorderStack.length > 0) {
    const frame = preorderStack.pop()!;
    const node = frame.node;
    const bandStart = frame.bandStart;
    const subtreeWidth = subtreeWidths.get(node.node.id)!;
    const childrenWidth = node.children.length === 0
      ? 0
      : node.children.reduce(
        (sum, child) => sum + subtreeWidths.get(child.node.id)!,
        options.siblingGap * (node.children.length - 1),
      );
    const childBandStart = bandStart + (subtreeWidth - childrenWidth) / 2;
    const depth = depthById.get(node.node.id)!;
    unnormalizedPositions.set(node.node.id, {
      x: bandStart + (subtreeWidth - node.node.width) / 2,
      y: rowTopByDepth.get(depth)!,
      width: node.node.width,
      height: node.node.height,
      depth,
    });

    let nextChildStart = childBandStart;
    const childFrames: Array<{ readonly node: IndexedNode; readonly bandStart: number }> = [];
    for (const child of node.children) {
      childFrames.push({ node: child, bandStart: nextChildStart });
      nextChildStart += subtreeWidths.get(child.node.id)! + options.siblingGap;
    }
    for (let index = childFrames.length - 1; index >= 0; index -= 1) {
      preorderStack.push(childFrames[index]!);
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  for (const position of unnormalizedPositions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxRight = Math.max(maxRight, position.x + position.width);
    maxBottom = Math.max(maxBottom, position.y + position.height);
  }
  const xOffset = minX < 0 ? -minX : 0;
  const yOffset = minY < 0 ? -minY : 0;
  const positions = new Map<string, ProjectMapTreePosition>();
  for (const [id, position] of unnormalizedPositions) {
    positions.set(id, { ...position, x: position.x + xOffset, y: position.y + yOffset });
  }

  return {
    positions,
    bounds: {
      x: 0,
      y: 0,
      width: maxRight + xOffset,
      height: maxBottom + yOffset,
    },
  };
}
