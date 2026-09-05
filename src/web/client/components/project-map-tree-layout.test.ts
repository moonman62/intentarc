import { describe, expect, test } from "vitest";

import {
  layoutProjectMapTree,
  type ProjectMapTreeLayoutNode,
} from "./project-map-tree-layout.js";

const standardOptions = { siblingGap: 24, subtreeGap: 40, levelGap: 72 };

describe("layoutProjectMapTree", () => {
  test("places cards top-down with sibling separation and parent centering", () => {
    const layout = layoutProjectMapTree([
      { id: "project", parentId: null, order: 0, width: 260, height: 120 },
      { id: "a", parentId: "project", order: 1, width: 240, height: 100 },
      { id: "b", parentId: "project", order: 2, width: 280, height: 130 },
      { id: "a1", parentId: "a", order: 3, width: 220, height: 90 },
    ], standardOptions);

    const project = layout.positions.get("project")!;
    const a = layout.positions.get("a")!;
    const b = layout.positions.get("b")!;

    expect(a.y).toBeGreaterThanOrEqual(project.y + project.height + 72);
    expect(b.y).toBe(a.y);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x - 24);
    expect(project.x + project.width / 2).toBeCloseTo(
      (a.x + b.x + b.width) / 2,
    );
    expect(layout.positions.get("a1")).toEqual({
      x: 10,
      y: 394,
      width: 220,
      height: 90,
      depth: 2,
    });
  });

  test("uses the tallest card in each depth row for vertical spacing", () => {
    const layout = layoutProjectMapTree([
      { id: "root", parentId: null, order: 0, width: 100, height: 50 },
      { id: "short", parentId: "root", order: 1, width: 100, height: 40 },
      { id: "tall", parentId: "root", order: 2, width: 100, height: 120 },
      { id: "leaf", parentId: "short", order: 3, width: 80, height: 20 },
    ], { siblingGap: 20, subtreeGap: 30, levelGap: 10 });

    expect(layout.positions.get("short")).toEqual({
      x: 0,
      y: 60,
      width: 100,
      height: 40,
      depth: 1,
    });
    expect(layout.positions.get("tall")).toEqual({
      x: 120,
      y: 60,
      width: 100,
      height: 120,
      depth: 1,
    });
    expect(layout.positions.get("leaf")).toEqual({
      x: 10,
      y: 190,
      width: 80,
      height: 20,
      depth: 2,
    });
  });

  test("centers every parent over its nested child-subtree interval", () => {
    const layout = layoutProjectMapTree([
      { id: "root", parentId: null, order: 0, width: 100, height: 50 },
      { id: "left", parentId: "root", order: 1, width: 200, height: 50 },
      { id: "right", parentId: "root", order: 2, width: 100, height: 50 },
      { id: "left-leaf", parentId: "left", order: 3, width: 100, height: 50 },
      { id: "right-leaf", parentId: "right", order: 4, width: 300, height: 50 },
    ], { siblingGap: 20, subtreeGap: 30, levelGap: 50 });

    expect(layout.positions.get("root")).toEqual({
      x: 210,
      y: 0,
      width: 100,
      height: 50,
      depth: 0,
    });
    expect(layout.positions.get("left")).toEqual({
      x: 0,
      y: 100,
      width: 200,
      height: 50,
      depth: 1,
    });
    expect(layout.positions.get("right")).toEqual({
      x: 320,
      y: 100,
      width: 100,
      height: 50,
      depth: 1,
    });
    expect(layout.positions.get("left-leaf")).toEqual({
      x: 50,
      y: 200,
      width: 100,
      height: 50,
      depth: 2,
    });
    expect(layout.positions.get("right-leaf")).toEqual({
      x: 220,
      y: 200,
      width: 300,
      height: 50,
      depth: 2,
    });
  });

  test("keeps multiple roots in visible order under the virtual Project root", () => {
    const layout = layoutProjectMapTree([
      { id: "first", parentId: null, order: 10, width: 100, height: 40 },
      { id: "second", parentId: null, order: 20, width: 200, height: 60 },
      { id: "third", parentId: null, order: 30, width: 80, height: 30 },
    ], { siblingGap: 12, subtreeGap: 40, levelGap: 30 });

    expect(layout.positions.get("first")).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      depth: 0,
    });
    expect(layout.positions.get("second")).toEqual({
      x: 140,
      y: 0,
      width: 200,
      height: 60,
      depth: 0,
    });
    expect(layout.positions.get("third")).toEqual({
      x: 380,
      y: 0,
      width: 80,
      height: 30,
      depth: 0,
    });
  });

  test("uses explicit order instead of input array order", () => {
    const nodes: readonly ProjectMapTreeLayoutNode[] = [
      { id: "second", parentId: null, order: 2, width: 100, height: 40 },
      { id: "first", parentId: null, order: 1, width: 100, height: 40 },
    ];

    const layout = layoutProjectMapTree(nodes, {
      siblingGap: 20,
      subtreeGap: 30,
      levelGap: 10,
    });

    expect(layout.positions.get("first")?.x).toBe(0);
    expect(layout.positions.get("second")?.x).toBe(130);
  });

  test("rejects missing parents and cycles", () => {
    expect(() => layoutProjectMapTree([
      { id: "orphan", parentId: "missing", order: 0, width: 100, height: 40 },
    ], standardOptions)).toThrow("missing parent");

    expect(() => layoutProjectMapTree([
      { id: "a", parentId: "b", order: 0, width: 100, height: 40 },
      { id: "b", parentId: "a", order: 1, width: 100, height: 40 },
    ], standardOptions)).toThrow("cycle");
  });

  test("rejects duplicate IDs before one node can overwrite another", () => {
    expect(() => layoutProjectMapTree([
      { id: "duplicate", parentId: null, order: 0, width: 100, height: 40 },
      { id: "duplicate", parentId: null, order: 1, width: 120, height: 50 },
    ], standardOptions)).toThrow("duplicate node id: duplicate");
  });

  test.each([
    ["node order", [{ id: "root", parentId: null, order: Number.NaN, width: 100, height: 40 }], standardOptions],
    ["node width", [{ id: "root", parentId: null, order: 0, width: Number.POSITIVE_INFINITY, height: 40 }], standardOptions],
    ["node height", [{ id: "root", parentId: null, order: 0, width: 100, height: Number.NEGATIVE_INFINITY }], standardOptions],
    ["sibling gap", [{ id: "root", parentId: null, order: 0, width: 100, height: 40 }], { ...standardOptions, siblingGap: Number.NaN }],
    ["subtree gap", [{ id: "root", parentId: null, order: 0, width: 100, height: 40 }], { ...standardOptions, subtreeGap: Number.POSITIVE_INFINITY }],
    ["level gap", [{ id: "root", parentId: null, order: 0, width: 100, height: 40 }], { ...standardOptions, levelGap: Number.NEGATIVE_INFINITY }],
  ] as const)("rejects non-finite %s before calculating coordinates", (_label, nodes, options) => {
    expect(() => layoutProjectMapTree(nodes, options)).toThrow(/finite/);
  });

  test("returns empty positions and zero bounds for empty input", () => {
    expect(layoutProjectMapTree([], standardOptions)).toEqual({
      positions: new Map(),
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
  });

  test("lays out one thousand visible nodes without recursive traversal", () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `node-${index}`,
      parentId: index === 0 ? null : `node-${index - 1}`,
      order: index,
      width: 10,
      height: 10,
    }));
    const layout = layoutProjectMapTree(nodes, {
      siblingGap: 4,
      subtreeGap: 8,
      levelGap: 5,
    });

    expect(layout.positions.size).toBe(1_000);
    expect(layout.positions.get("node-999")).toEqual({
      x: 0,
      y: 14_985,
      width: 10,
      height: 10,
      depth: 999,
    });
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 10, height: 14_995 });
  });

  test("returns bounds containing every measured card", () => {
    const layout = layoutProjectMapTree([
      { id: "root", parentId: null, order: 0, width: 120, height: 80 },
      { id: "left", parentId: "root", order: 1, width: 240, height: 60 },
      { id: "right", parentId: "root", order: 2, width: 100, height: 90 },
      { id: "leaf", parentId: "left", order: 3, width: 300, height: 70 },
    ], { siblingGap: 16, subtreeGap: 24, levelGap: 32 });

    for (const position of layout.positions.values()) {
      expect(position.x).toBeGreaterThanOrEqual(layout.bounds.x);
      expect(position.y).toBeGreaterThanOrEqual(layout.bounds.y);
      expect(position.x + position.width).toBeLessThanOrEqual(
        layout.bounds.x + layout.bounds.width,
      );
      expect(position.y + position.height).toBeLessThanOrEqual(
        layout.bounds.y + layout.bounds.height,
      );
    }
  });
});
