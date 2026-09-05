// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectMapResponse } from "../../contracts.js";
import type { HierarchyRecordSummary } from "./hierarchy-label.js";
import type { ProjectMapConnector } from "./project-map-connectors.js";
import {
  type HierarchyDisplayNode,
  ProjectHierarchyView,
} from "./project-hierarchy-view.js";
import { deriveProjectMapProjection } from "../screens/project-map-projection.js";

const baseStyles = readFileSync(
  resolve(process.cwd(), "src/web/client/styles/base.css"),
  "utf8",
);

const software: ProjectMapResponse["hierarchyVocabulary"] = {
  preset: "software",
  outcome: "Product outcome",
  initiative: "Epic",
  deliverable: "Feature",
  milestone: "Milestone",
  task: "Story or Task",
  nestedTask: "Subtask",
};

const record = (
  id: string,
  kind: HierarchyRecordSummary["kind"],
  title: string,
): HierarchyRecordSummary => ({
  id,
  kind,
  status: kind === "task" ? "active" : "accepted",
  title,
  revision: 1,
});

const rectangle = (
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect => ({
  bottom: top + height,
  height,
  left,
  right: left + width,
  top,
  width,
  x: left,
  y: top,
  toJSON: () => ({}),
});

const pathEndpoints = (path: SVGPathElement): readonly [number, number, number, number] => {
  const values = path.getAttribute("d")?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (values.length < 4) throw new Error("Connector path did not contain endpoints");
  return [values[0]!, values[1]!, values.at(-2)!, values.at(-1)!];
};

const cameraState = (viewport: HTMLElement) => ({
  scale: Number(viewport.dataset.cameraScale),
  x: Number(viewport.dataset.cameraX),
  y: Number(viewport.dataset.cameraY),
});

const nodes: readonly HierarchyDisplayNode[] = [
  { record: record("outcome-1", "outcome", "Keep work coherent"), parentId: null, depth: 0, childCount: 1, hiddenChildCount: 0, childrenExpanded: true },
  { record: record("initiative-1", "initiative", "Guide the project map"), parentId: "outcome-1", depth: 1, childCount: 2, hiddenChildCount: 0, childrenExpanded: true },
  { record: record("deliverable-1", "deliverable", "Semantic hierarchy"), parentId: "initiative-1", depth: 2, childCount: 1, hiddenChildCount: 0, childrenExpanded: true },
  { record: record("story-1", "task", "Select a record"), parentId: "deliverable-1", depth: 3, childCount: 1, hiddenChildCount: 0, childrenExpanded: true },
  { record: record("subtask-1", "task", "Preserve the selected ID"), parentId: "story-1", depth: 4, childCount: 0, hiddenChildCount: 0, childrenExpanded: false },
  { record: record("milestone-1", "milestone", "Ready for review"), parentId: "initiative-1", depth: 2, childCount: 0, hiddenChildCount: 0, childrenExpanded: false },
];

const connections: readonly ProjectMapConnector[] = [{
  id: "connection-1",
  fromRecordId: "deliverable-1",
  toRecordId: "milestone-1",
  label: "Depends on",
  style: "cross",
}];

let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
let capturedPointers = new Set<number>();
interface ResizeObserverProbe {
  readonly callback: ResizeObserverCallback;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
}
let resizeObservers: ResizeObserverProbe[] = [];

const flushAnimationFrames = () => {
  act(() => {
    const frames = [...animationFrames.values()];
    animationFrames.clear();
    for (const frame of frames) frame(0);
  });
};

const dispatchPointer = (
  target: EventTarget,
  type: string,
  init: PointerEventInit & { readonly pointerId: number; readonly pointerType: string },
) => {
  act(() => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  })));
};

const renderHierarchy = (
  overrides: Partial<React.ComponentProps<typeof ProjectHierarchyView>> = {},
) => {
  const onSelectProject = vi.fn();
  const onSelect = vi.fn();
  const onShowWholeProject = vi.fn();
  const onExpandedChange = vi.fn();
  const viewNodes = overrides.nodes ?? nodes;
  const view = render(
    <ProjectHierarchyView
      activeRootId="project:project-1"
      project={{ id: "project-1", name: "IntentArc" }}
      cameraFitRequestKey={0}
      focusRequestKey={0}
      occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
      cameraLayoutRevision="layout-a"
      vocabulary={software}
      nodes={viewNodes}
      connections={connections}
      selectedId="deliverable-1"
      showConnections
      scopeRecordId={null}
      onSelectProject={onSelectProject}
      onSelect={onSelect}
      onShowWholeProject={onShowWholeProject}
      scopePath={[]}
      onExpandedChange={onExpandedChange}
      {...overrides}
    />,
  );
  flushAnimationFrames();
  return { onExpandedChange, onSelect, onSelectProject, onShowWholeProject, ...view };
};

const layoutPosition = (item: HTMLElement) => ({
  height: Number(item.dataset.layoutHeight),
  width: Number(item.dataset.layoutWidth),
  x: Number(item.dataset.layoutX),
  y: Number(item.dataset.layoutY),
});

beforeEach(() => {
  animationFrames = new Map();
  nextAnimationFrame = 1;
  capturedPointers = new Set();
  resizeObservers = [];
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: (pointerId: number) => capturedPointers.add(pointerId),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: (pointerId: number) => capturedPointers.delete(pointerId),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: (pointerId: number) => capturedPointers.has(pointerId),
  });
  vi.stubGlobal("PointerEvent", class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
    }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal("ResizeObserver", class ResizeObserverStub implements ResizeObserver {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return this.classList.contains("project-map-camera__viewport") ? 1000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
    return this.classList.contains("project-map-camera__viewport") ? 700 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? 800 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.classList.contains("project-map-camera__viewport")) return rectangle(0, 0, 1000, 700);
    if (this.hasAttribute("data-camera-world")) return rectangle(0, 0, 800, 600);
    if (this.matches("[role='tree']")) return rectangle(0, 0, 800, 600);
    const endpointId = this.getAttribute("data-connector-record-id");
    if (endpointId !== null) {
      const endpointIds = [
        "project:project-1",
        "outcome-1",
        "initiative-1",
        "deliverable-1",
        "story-1",
        "subtask-1",
        "milestone-1",
      ];
      const index = Math.max(0, endpointIds.indexOf(endpointId));
      return rectangle(20 + index * 90, 30 + index * 70, 200, 64);
    }
    return rectangle(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProjectHierarchyView", () => {
  test("forwards the active root, focus request, scope, and occlusion inputs unchanged", () => {
    renderHierarchy({
      activeRootId: "outcome-1",
      focusRequestKey: 7,
      occlusionInsets: { top: 24, right: 300, bottom: 12, left: 20 },
      scopeRecordId: "outcome-1",
      scopePath: [record("outcome-1", "outcome", "Keep work coherent")],
    });

    const viewport = document.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewport)).toEqual({ scale: 1, x: 150, y: -44 });
    expect(screen.getByRole("button", { name: "Fit branch" })).toBeTruthy();
  });

  test("makes the treeitem card the sole selection owner and keeps expansion separate", async () => {
    const user = userEvent.setup();
    const { onExpandedChange, onSelect } = renderHierarchy({ selectedId: "milestone-1" });
    const task = document.querySelector<HTMLElement>("[role='treeitem'][data-record-id='story-1']")!;
    const parent = document.querySelector<HTMLElement>("[role='treeitem'][data-record-id='deliverable-1']")!;

    expect(task.getAttribute("aria-selected")).toBe("false");
    expect(task.querySelector("button.project-hierarchy__node-button")).toBeNull();
    await user.click(within(task).getByText("Select a record"));
    expect(onSelect).toHaveBeenCalledWith("story-1");

    const expand = within(parent).getByRole("button", { name: "Collapse Semantic hierarchy" });
    expect(expand.getAttribute("tabindex")).toBe("-1");
    await user.click(expand);
    expect(onExpandedChange).toHaveBeenCalledWith("deliverable-1", false);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test("lays measured cards top-down without sibling overlap and keeps geometry selection-neutral", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("project-map-camera__viewport")) return rectangle(0, 0, 1000, 700);
      if (this.hasAttribute("data-camera-world")) return rectangle(0, 0, 1200, 900);
      if (this.matches("[role='tree']")) return rectangle(0, 0, 1200, 900);
      if (this.matches("[role='treeitem']")) {
        const id = this.dataset.recordId ?? this.dataset.projectId ?? "";
        const transform = this.style.transform.match(
          /^translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/,
        );
        return rectangle(
          Number(transform?.[1] ?? 0),
          Number(transform?.[2] ?? 0),
          id === "milestone-1" ? 280 : 240,
          id === "project-1" ? 88 : 72,
        );
      }
      return rectangle(0, 0, 0, 0);
    });
    const { rerender } = renderHierarchy({ selectedId: "deliverable-1" });
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const project = within(tree).getByRole("treeitem", { name: /Project: IntentArc/ });
    const outcome = tree.querySelector<HTMLElement>("[data-record-id='outcome-1']")!;
    const initiative = tree.querySelector<HTMLElement>("[data-record-id='initiative-1']")!;
    const deliverable = tree.querySelector<HTMLElement>("[data-record-id='deliverable-1']")!;
    const milestone = tree.querySelector<HTMLElement>("[data-record-id='milestone-1']")!;

    await waitFor(() => expect(Number(tree.dataset.layoutRevision)).toBeGreaterThan(0));
    const projectRect = project.getBoundingClientRect();
    const outcomeRect = outcome.getBoundingClientRect();
    const initiativeRect = initiative.getBoundingClientRect();
    const deliverableRect = deliverable.getBoundingClientRect();
    const milestoneRect = milestone.getBoundingClientRect();
    expect(outcomeRect.top).toBeGreaterThan(projectRect.bottom);
    expect(initiativeRect.top).toBeGreaterThan(outcomeRect.bottom);
    expect(deliverableRect.top).toBeGreaterThan(initiativeRect.bottom);
    expect(deliverableRect.right).toBeLessThanOrEqual(milestoneRect.left);
    expect(deliverableRect.left).toBeLessThan(milestoneRect.left);
    const primaryPath = await waitFor(() => {
      const path = document.querySelector<SVGPathElement>(
        "path[data-connector-id='primary:outcome-1:initiative-1']",
      );
      expect(path).toBeTruthy();
      return path!;
    });
    expect(pathEndpoints(primaryPath)).toEqual([
      outcomeRect.left + outcomeRect.width / 2,
      outcomeRect.bottom,
      initiativeRect.left + initiativeRect.width / 2,
      initiativeRect.top,
    ]);
    const transforms = within(tree).getAllByRole("treeitem").map((item) => item.style.transform);
    const revision = tree.dataset.layoutRevision;

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-a"
        vocabulary={software}
        nodes={nodes}
        connections={connections}
        selectedId="story-1"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );

    expect(within(tree).getAllByRole("treeitem").map((item) => item.style.transform))
      .toEqual(transforms);
    expect(tree.dataset.layoutRevision).toBe(revision);
  });

  test("keeps branch focus out of hierarchy cards", () => {
    renderHierarchy();

    expect(screen.queryByRole("button", { name: /Focus here:/ })).toBeNull();
  });
  test("keeps a thousand-card connector overlay idle during camera pan and zoom", async () => {
    const largeNodes: HierarchyDisplayNode[] = Array.from({ length: 1_000 }, (_, index) => ({
      record: record(`scale-${index}`, index === 0 ? "outcome" : "task", `Scale ${index}`),
      parentId: index === 0 ? null : `scale-${index - 1}`,
      depth: index,
      childCount: index === 999 ? 0 : 1,
      hiddenChildCount: 0,
      childrenExpanded: index !== 999,
    }));
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rects.mockImplementation(function () {
      if (this.classList.contains("project-map-camera__viewport")) {
        return rectangle(0, 0, 1000, 700);
      }
      if (this.hasAttribute("data-camera-world")) return rectangle(0, 0, 20_000, 4_000);
      const endpointId = this.getAttribute("data-connector-record-id");
      if (endpointId === "project:project-1") return rectangle(20, 20, 180, 64);
      if (endpointId?.startsWith("scale-") === true) {
        const index = Number(endpointId.slice("scale-".length));
        return rectangle(240 + index % 100 * 190, 20 + Math.floor(index / 100) * 360, 160, 64);
      }
      return rectangle(0, 0, 0, 0);
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const { container } = renderHierarchy({ connections: [], nodes: largeNodes });
    await waitFor(() => {
      expect(container.querySelectorAll("path[data-connector-style='primary']")).toHaveLength(1_000);
    });
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    const viewport = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const endpointQuery = vi.spyOn(world, "querySelectorAll");
    const initialSvg = container.querySelector("svg.project-map-connectors");
    const initialObserverCount = resizeObservers.length;
    const initialObservers = resizeObservers.filter((observer) => (
      observer.disconnect.mock.calls.length === 0
    ));
    rects.mockClear();
    stringify.mockClear();
    const expectConnectorWorkIdle = () => {
      expect(container.querySelector("svg.project-map-connectors")).toBe(initialSvg);
      expect(resizeObservers).toHaveLength(initialObserverCount);
      expect(initialObservers.every((observer) => !observer.disconnect.mock.calls.length))
        .toBe(true);
      expect(endpointQuery).not.toHaveBeenCalledWith("[data-connector-record-id]");
      expect(rects.mock.contexts.filter((element) => (
        element instanceof HTMLElement && element.hasAttribute("data-connector-record-id")
      ))).toHaveLength(0);
      expect(stringify.mock.calls.filter(([value]) => (
        Array.isArray(value) && value.length >= 1_000
      ))).toHaveLength(0);
    };

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    viewport.focus();
    await userEvent.keyboard("-{ArrowRight}");
    expectConnectorWorkIdle();
    act(() => viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 450,
      clientY: 300,
      ctrlKey: true,
      deltaY: -100,
    })));
    expectConnectorWorkIdle();
    const beforeDrag = cameraState(viewport);
    dispatchPointer(viewport, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 1, pointerType: "mouse",
    });
    dispatchPointer(viewport, "pointermove", {
      buttons: 1, clientX: 130, clientY: 120,
      pointerId: 1, pointerType: "mouse",
    });
    dispatchPointer(viewport, "pointerup", {
      button: 0, buttons: 0, clientX: 130, clientY: 120,
      pointerId: 1, pointerType: "mouse",
    });
    expect(cameraState(viewport)).toEqual({
      ...beforeDrag,
      x: beforeDrag.x + 30,
      y: beforeDrag.y + 20,
    });
    expectConnectorWorkIdle();
    const beforePinch = cameraState(viewport);
    dispatchPointer(viewport, "pointerdown", {
      button: 0, buttons: 1, clientX: 200, clientY: 200,
      pointerId: 2, pointerType: "touch",
    });
    dispatchPointer(viewport, "pointerdown", {
      button: 0, buttons: 1, clientX: 300, clientY: 200,
      pointerId: 3, pointerType: "touch",
    });
    dispatchPointer(viewport, "pointermove", {
      buttons: 1, clientX: 330, clientY: 220,
      pointerId: 3, pointerType: "touch",
    });
    expect(cameraState(viewport).scale).toBeGreaterThan(beforePinch.scale);
    dispatchPointer(viewport, "pointerup", {
      button: 0, buttons: 0, clientX: 200, clientY: 200,
      pointerId: 2, pointerType: "touch",
    });
    dispatchPointer(viewport, "pointerup", {
      button: 0, buttons: 0, clientX: 330, clientY: 220,
      pointerId: 3, pointerType: "touch",
    });
    expectConnectorWorkIdle();
  }, 30_000);

  test("reuses thousand-node hierarchy topology for selection and rebuilds once for revelation", () => {
    const largeNodes: HierarchyDisplayNode[] = Array.from({ length: 1_000 }, (_, index) => ({
      record: record(`stable-${index}`, index === 0 ? "outcome" : "task", `Stable ${index}`),
      parentId: index === 0 ? null : `stable-${index - 1}`,
      depth: index,
      childCount: index === 999 ? 0 : 1,
      hiddenChildCount: 0,
      childrenExpanded: index !== 999,
    }));
    const initialNodes = [...largeNodes];
    const initialMap = vi.spyOn(initialNodes, "map");
    const stringify = vi.spyOn(JSON, "stringify");
    const { rerender } = renderHierarchy({
      cameraLayoutRevision: "stable-layout",
      connections: [],
      nodes: initialNodes,
      selectedId: "stable-0",
    });
    const oneTopologyBuildMapCalls = initialMap.mock.calls.length;
    expect(oneTopologyBuildMapCalls).toBeGreaterThan(0);
    initialMap.mockClear();
    stringify.mockClear();
    const selectionNodes = largeNodes.map((node) => ({ ...node, record: { ...node.record } }));
    const selectionMap = vi.spyOn(selectionNodes, "map");

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="stable-layout"
        vocabulary={software}
        nodes={selectionNodes}
        connections={[]}
        selectedId="stable-999"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );

    expect(document.querySelector("[data-record-id='stable-999']")?.getAttribute("aria-selected"))
      .toBe("true");
    expect(selectionMap).not.toHaveBeenCalled();
    expect(stringify.mock.calls.filter(([value]) => Array.isArray(value) && value.length >= 1_000))
      .toHaveLength(0);

    const revealedNodes = [
      ...selectionNodes.map((node) => node.record.id === "stable-999"
        ? { ...node, childCount: 1 }
        : node),
      {
        record: record("stable-1000", "task", "Stable 1000"),
        parentId: "stable-999",
        depth: 1_000,
        childCount: 0,
        hiddenChildCount: 0,
        childrenExpanded: false,
      },
    ];
    const revelationMap = vi.spyOn(revealedNodes, "map");
    stringify.mockClear();
    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="revealed-layout"
        vocabulary={software}
        nodes={revealedNodes}
        connections={[]}
        selectedId="stable-999"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );

    expect(revelationMap).toHaveBeenCalledTimes(oneTopologyBuildMapCalls);
    expect(document.querySelector("[data-record-id='stable-1000']")).toBeTruthy();
    expect(stringify.mock.calls.some(([value]) => Array.isArray(value) && value.length >= 1_000))
      .toBe(true);
  }, 30_000);

  test("moves the roving focus without rescanning camera card or path bounds", async () => {
    const user = userEvent.setup();
    const { container } = renderHierarchy({ selectedId: null });
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    const querySelectorAll = vi.spyOn(world, "querySelectorAll");
    const projectItem = screen.getByRole("treeitem", {
      name: "Project: IntentArc (project-1)",
    });

    projectItem.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");

    expect(document.activeElement?.getAttribute("data-record-id")).toBe("initiative-1");
    expect(querySelectorAll).not.toHaveBeenCalledWith(
      "[data-connector-record-id],path[data-connector-id]",
    );
  });

  test("starts one roving tree at the selected Project root", async () => {
    const user = userEvent.setup();
    const { onSelectProject } = renderHierarchy({ selectedId: null });

    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const treeitems = within(tree).getAllByRole("treeitem");
    const projectItem = treeitems[0]!;
    expect(projectItem.getAttribute("data-project-id")).toBe("project-1");
    expect(projectItem.getAttribute("aria-current")).toBe("true");
    expect(treeitems.filter((item) => item.tabIndex === 0)).toEqual([projectItem]);
    expect(screen.getByText("Whole Project")).toBeTruthy();

    projectItem.focus();
    await user.keyboard("{Enter}");
    expect(onSelectProject).toHaveBeenCalledOnce();
  });

  test("makes the focused record the tree root below Project ancestry and restore context", async () => {
    const focusedNodes = nodes
      .filter(({ record }) => record.id !== "outcome-1" && record.id !== "subtask-1")
      .map((node) => ({
        ...node,
        depth: node.depth - 1,
        parentId: node.record.id === "initiative-1" ? null : node.parentId,
      }));
    const { onShowWholeProject } = renderHierarchy({
      nodes: focusedNodes,
      scopeRecordId: "initiative-1",
      scopePath: [
        record("outcome-1", "outcome", "Keep work coherent"),
        record("initiative-1", "initiative", "Guide the project map"),
      ],
    });

    const hierarchy = screen.getByRole("region", {
      name: "IntentArc project hierarchy",
    });
    const trees = within(hierarchy).getAllByRole("tree");
    expect(trees).toHaveLength(1);
    expect(within(trees[0]!).getAllByRole("treeitem").map((item) => (
      item.getAttribute("data-project-id") ?? item.getAttribute("data-record-id")
    ))).toEqual([
      "initiative-1",
      "deliverable-1",
      "story-1",
      "milestone-1",
    ]);

    const scopeRoot = within(trees[0]!).getAllByRole("treeitem")[0]!;
    expect(scopeRoot.getAttribute("aria-level")).toBe("1");
    expect(scopeRoot.getAttribute("data-depth")).toBe("0");
    expect(within(trees[0]!).queryByRole("treeitem", { name: /Project:/ })).toBeNull();
    expect(document.querySelector("[data-record-id='deliverable-1']")?.getAttribute("data-parent-id"))
      .toBe("initiative-1");
    const context = within(hierarchy).getByRole("navigation", { name: "Focused project context" });
    const world = hierarchy.querySelector<HTMLElement>("[data-camera-world]")!;
    expect(world.contains(context)).toBe(false);
    expect(world.contains(trees[0]!)).toBe(true);
    expect(context.textContent).toContain("Project IntentArc");
    expect(context.textContent).toContain("Keep work coherent");
    expect(context.textContent).toContain("Guide the project map");
    await userEvent.click(within(context).getByRole("button", { name: "Show whole project" }));
    expect(onShowWholeProject).toHaveBeenCalledOnce();
    await waitFor(() => {
      const primaryPaths = [...hierarchy.querySelectorAll<SVGPathElement>(
        "path[data-connector-style='primary']",
      )];
      expect(primaryPaths).toHaveLength(3);
      expect(primaryPaths.some((path) => path.dataset.connectorId?.endsWith(":initiative-1")))
        .toBe(false);
    });
  });

  test("moves Home to the focused scope root and makes it the roving tab stop", async () => {
    const user = userEvent.setup();
    renderHierarchy({
      nodes: [
        { ...nodes[1]!, parentId: null, depth: 0, childCount: 1 },
        { ...nodes[2]!, parentId: "initiative-1", depth: 1, childCount: 1 },
        { ...nodes[3]!, parentId: "deliverable-1", depth: 2, childCount: 0 },
      ],
      scopeRecordId: "initiative-1",
      scopePath: [
        record("outcome-1", "outcome", "Keep work coherent"),
        record("initiative-1", "initiative", "Guide the project map"),
      ],
    });
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const scopedRoot = tree.querySelector<HTMLElement>(
      "[role='treeitem'][data-record-id='initiative-1']",
    )!;
    const descendant = tree.querySelector<HTMLElement>(
      "[role='treeitem'][data-record-id='story-1']",
    )!;
    descendant.focus();

    await user.keyboard("{Home}");

    expect(document.activeElement).toBe(scopedRoot);
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0))
      .toEqual([scopedRoot]);
  });

  test("keeps whole-project Home anchored on Project", async () => {
    const user = userEvent.setup();
    renderHierarchy();
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const project = tree.querySelector<HTMLElement>(
      "[role='treeitem'][data-project-id='project-1']",
    )!;
    tree.querySelector<HTMLElement>("[role='treeitem'][data-record-id='story-1']")!.focus();

    await user.keyboard("{Home}");

    expect(document.activeElement).toBe(project);
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0))
      .toEqual([project]);
  });

  test("uses semantic depth-first keyboard order, cycles typeahead, and separates focus from selection", async () => {
    const user = userEvent.setup();
    renderHierarchy({ selectedId: "milestone-1" });
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const project = tree.querySelector<HTMLElement>("[data-project-id='project-1']")!;
    const deliverable = tree.querySelector<HTMLElement>("[data-record-id='deliverable-1']")!;
    const story = tree.querySelector<HTMLElement>("[data-record-id='story-1']")!;
    const subtask = tree.querySelector<HTMLElement>("[data-record-id='subtask-1']")!;
    const milestone = tree.querySelector<HTMLElement>("[data-record-id='milestone-1']")!;

    project.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(document.activeElement).toBe(deliverable);
    await user.keyboard("{End}{ArrowUp}");
    expect(document.activeElement).toBe(subtask);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(project);

    await user.keyboard("s");
    expect(document.activeElement).toBe(deliverable);
    await user.keyboard("s");
    expect(document.activeElement).toBe(story);
    expect(story.getAttribute("aria-selected")).toBe("false");
    expect(milestone.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).not.toBe(milestone);
  });

  test("keeps Space activation on a focused tree item without arming camera pan", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderHierarchy({ selectedId: "milestone-1" });
    const story = screen.getByRole("treeitem", { name: "Story or Task: Select a record" });
    const viewport = document.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    story.focus();

    await user.keyboard(" ");

    expect(onSelect).toHaveBeenCalledWith("story-1");
    expect(viewport.dataset.cameraSpacePanArmed).toBe("false");
  });

  test("keeps the controlled expansion affordance persistent across selection rerenders", () => {
    const { rerender } = renderHierarchy({ selectedId: "deliverable-1" });
    expect(screen.getByRole("button", { name: "Collapse Semantic hierarchy" })).toBeTruthy();

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-a"
        vocabulary={software}
        nodes={nodes}
        connections={connections}
        selectedId="story-1"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Collapse Semantic hierarchy" })).toBeTruthy();
  });

  test("uses one indented outline without page-width expansion below 760px", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      matches: query === "(max-width: 759px)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
    })));
    renderHierarchy();
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    const deep = tree.querySelector<HTMLElement>("[data-record-id='subtask-1']")!;

    expect(tree.dataset.layoutMode).toBe("outline");
    expect(tree.style.width).toBe("100%");
    expect(deep.style.transform).toBe("");
    expect(deep.getAttribute("data-visual-depth")).toBe("5");
    expect(Array.from(tree.children).every((child) => child.getAttribute("role") === "treeitem"))
      .toBe(true);
  });

  test("keeps Project, selection, and expansion as distinct actions", async () => {
    const user = userEvent.setup();
    const {
      onExpandedChange,
      onSelect,
      onSelectProject,
    } = renderHierarchy();

    await user.click(screen.getByRole("treeitem", { name: "Project: IntentArc (project-1)" }));
    expect(onSelectProject).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onExpandedChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("treeitem", {
      name: "Story or Task: Select a record",
    }));
    expect(onSelect).toHaveBeenCalledWith("story-1");
    expect(onSelect).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", {
      name: "Collapse Semantic hierarchy",
    }));
    expect(onExpandedChange).toHaveBeenCalledWith("deliverable-1", false);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test("renders one flat semantic Project-rooted tree with camera paths and explicit levels", async () => {
    renderHierarchy();

    const hierarchy = screen.getByRole("region", {
      name: "IntentArc project hierarchy",
    });
    const canvas = screen.getByRole("region", { name: "IntentArc project map canvas" });
    const viewport = within(canvas).getByLabelText("IntentArc project map canvas");
    expect(cameraState(viewport)).toEqual({ scale: 1, x: 380, y: 2 });
    const projectRoot = within(hierarchy).getByRole("treeitem", {
      name: "Project: IntentArc (project-1)",
    });
    expect(projectRoot.getAttribute("data-project-id")).toBe("project-1");
    expect(projectRoot.hasAttribute("data-record-id")).toBe(false);
    expect(within(projectRoot).queryByRole("button")).toBeNull();
    expect(projectRoot.dataset.connectorRecordId).toBe("project:project-1");

    expect(within(hierarchy).getByRole("treeitem", {
      name: "Product outcome: Keep work coherent",
    })).toBeTruthy();
    const initiativeItem = within(hierarchy).getByRole("treeitem", {
      name: "Epic: Guide the project map",
    });
    expect(initiativeItem.dataset.recordId).toBe("initiative-1");
    expect(within(hierarchy).getByRole("treeitem", {
      name: "Feature: Semantic hierarchy",
    })).toBeTruthy();
    expect(within(hierarchy).getByRole("treeitem", {
      name: "Story or Task: Select a record",
    })).toBeTruthy();
    expect(within(hierarchy).getByRole("treeitem", {
      name: "Subtask: Preserve the selected ID",
    })).toBeTruthy();

    const rootConnectorDescription = within(hierarchy).getByRole("img", {
      name: "Primary hierarchy connection from Project IntentArc to Product outcome Keep work coherent",
    });
    expect(rootConnectorDescription.classList).toContain("sr-only");
    expect(rootConnectorDescription.previousElementSibling).toBeNull();
    const nestedConnectorDescription = within(hierarchy).getByRole("img", {
      name: "Primary hierarchy connection from Epic Guide the project map to Feature Semantic hierarchy",
    });
    expect(nestedConnectorDescription.classList).toContain("sr-only");
    expect(nestedConnectorDescription.previousElementSibling).toBeNull();
    await waitFor(() => {
      const primaryPaths = [...hierarchy.querySelectorAll<SVGPathElement>(
        "path[data-connector-style='primary']",
      )];
      expect(primaryPaths).toHaveLength(nodes.length);
      expect(primaryPaths.every((path) => path.dataset.connectorStyle === "primary")).toBe(true);
      const rootPath = primaryPaths.find((path) => (
        path.dataset.connectorId === "primary:project:project-1:outcome-1"
      ))!;
      const [startX, startY] = pathEndpoints(rootPath);
      expect(rootPath.getAttribute("d")).toBe("M 120 94 V 97 H 210 V 100");
      expect(startX).toBe(120);
      expect(startY).toBe(94);
      expect(rootPath.style.stroke).toBe("var(--ia-border-strong)");
      expect(rootPath.style.strokeWidth).toBe("1.75");
      expect(rootPath.style.vectorEffect).toBe("non-scaling-stroke");
    });
    expect(document.querySelector("[data-record-id='deliverable-1']")?.getAttribute("data-depth"))
      .toBe("2");
    const tree = within(hierarchy).getByRole("tree");
    expect(Array.from(tree.children).every((child) => child.getAttribute("role") === "treeitem"))
      .toBe(true);
    expect(document.querySelector("[data-project-id='project-1']")?.getAttribute("aria-level"))
      .toBe("1");
    expect(document.querySelector("[data-record-id='deliverable-1']")?.getAttribute("aria-level"))
      .toBe("4");
  });

  test("keeps selection keyed by record ID and invokes onSelect with that exact ID", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderHierarchy();
    const treeitems = screen.getAllByRole("treeitem");

    expect(treeitems.filter((item) => item.getAttribute("aria-selected") === "true"))
      .toHaveLength(1);
    expect(screen.getByRole("treeitem", {
      name: "Feature: Semantic hierarchy",
    }).getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("treeitem", {
      name: "Story or Task: Select a record",
    }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("story-1");
  });

  test("keeps record-button drags as selection without moving the camera", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderHierarchy();
    const canvas = screen.getByRole("region", { name: "IntentArc project map canvas" });
    const viewport = within(canvas).getByLabelText("IntentArc project map canvas");
    const before = {
      scale: viewport.dataset.cameraScale,
      x: viewport.dataset.cameraX,
      y: viewport.dataset.cameraY,
    };
    const card = screen.getByRole("treeitem", { name: "Story or Task: Select a record" });

    await user.pointer([
      { coords: { clientX: 20, clientY: 20 }, keys: "[MouseLeft>]", target: card },
      { coords: { clientX: 80, clientY: 70 }, target: card },
      { keys: "[/MouseLeft]", target: card },
    ]);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("story-1");
    expect({
      scale: viewport.dataset.cameraScale,
      x: viewport.dataset.cameraX,
      y: viewport.dataset.cameraY,
    }).toEqual(before);
  });

  test("owns roving tree navigation while Arrow Left changes only controlled expansion", async () => {
    const user = userEvent.setup();
    const { onExpandedChange, onSelect } = renderHierarchy();
    const selected = document.querySelector<HTMLElement>("[role='treeitem'][data-record-id='deliverable-1']")!;
    selected.focus();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(document.querySelector("[role='treeitem'][data-record-id='story-1']"));
    await user.keyboard("{ArrowLeft}");
    expect(onExpandedChange).toHaveBeenCalledWith("story-1", false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.querySelector("[role='treeitem'][data-record-id='story-1']"));
  });

  test("moves Left from a collapsed top-level record to its Project parent", async () => {
    const user = userEvent.setup();
    renderHierarchy({
      nodes: [{ ...nodes[0]!, childCount: 0, hiddenChildCount: 1, childrenExpanded: false }],
      selectedId: null,
    });
    const outcome = document.querySelector<HTMLElement>(
      "[role='treeitem'][data-record-id='outcome-1']",
    )!;
    outcome.focus();

    await user.keyboard("{ArrowLeft}");

    expect(document.activeElement).toBe(document.querySelector(
      "[role='treeitem'][data-project-id='project-1']",
    ));
  });

  test("gives the camera and tree distinct tab stops without card-local branch actions", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before map</button>
        <ProjectHierarchyView
          activeRootId="project:project-1"
          project={{ id: "project-1", name: "IntentArc" }}
          cameraFitRequestKey={0}
          focusRequestKey={0}
          occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
          cameraLayoutRevision="layout-a"
          vocabulary={software}
          nodes={nodes}
          connections={connections}
          selectedId="deliverable-1"
          showConnections
          scopeRecordId={null}
          onSelectProject={() => undefined}
          onSelect={() => undefined}
          onShowWholeProject={() => undefined}
          scopePath={[]}
          onExpandedChange={() => undefined}
        />
        <button type="button">After map</button>
      </>,
    );

    screen.getByRole("button", { name: "Before map" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(within(
      screen.getByRole("region", { name: "IntentArc project map canvas" }),
    ).getByLabelText("IntentArc project map canvas"));
    await user.tab();
    const projectItem = document.querySelector<HTMLElement>(
      "[role='treeitem'][data-project-id='project-1']",
    )!;
    expect(document.activeElement).toBe(projectItem);
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0))
      .toEqual([projectItem]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After map" }));
  });

  test.each([
    { mode: "top-down", narrow: false },
    { mode: "outline", narrow: true },
  ])("renders one thousand visible cards iteratively in $mode mode", ({ mode, narrow }) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: narrow } as MediaQueryList);
    const deepNodes: HierarchyDisplayNode[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const id = `deep-${index}`;
      deepNodes.push({
        record: record(id, index === 0 ? "outcome" : "task", `Deep record ${index}`),
        parentId: index === 0 ? null : `deep-${index - 1}`,
        depth: index,
        childCount: index === 999 ? 0 : 1,
        hiddenChildCount: 0,
        childrenExpanded: index !== 999,
      });
    }

    const { container } = renderHierarchy({
      connections: [],
      nodes: deepNodes,
      selectedId: "deep-999",
    });

    const tree = container.querySelector<HTMLElement>("[role='tree']")!;
    const last = tree.querySelector<HTMLElement>("[data-record-id='deep-999']")!;
    expect(tree.querySelectorAll("[role='treeitem']")).toHaveLength(1_001);
    expect(Array.from(tree.children)).toHaveLength(1_001);
    expect(tree.dataset.layoutMode).toBe(mode);
    if (narrow) {
      expect(Number(tree.dataset.layoutRevision)).toBe(0);
      expect(last.style.transform).toBe("");
      expect(last.style.marginInlineStart).toBe("128px");
    } else {
      expect(Number(tree.dataset.layoutRevision)).toBeGreaterThan(0);
      expect(Number(last.dataset.layoutY)).toBeGreaterThan(0);
      expect(last.style.transform).toMatch(/^translate\(/);
    }
    expect(last.getAttribute("data-visual-depth"))
      .toBe("8");
  }, 30_000);

  test("indents each visible outline depth by 16px through depth eight at 390px", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
      return this.classList.contains("project-map-camera__viewport") || this.matches("[role='tree']")
        ? 390
        : 0;
    });
    const deepNodes: HierarchyDisplayNode[] = Array.from({ length: 9 }, (_, depth) => ({
      record: record(`outline-${depth}`, depth === 0 ? "outcome" : "task", `Outline ${depth}`),
      parentId: depth === 0 ? null : `outline-${depth - 1}`,
      depth,
      childCount: depth === 8 ? 0 : 1,
      hiddenChildCount: depth === 8 ? 1 : 0,
      childrenExpanded: depth !== 8,
    }));
    const { container } = renderHierarchy({
      connections: [],
      nodes: deepNodes,
      selectedId: "outline-8",
    });
    const tree = container.querySelector<HTMLElement>("[role='tree']")!;
    const outlineNodes = Array.from(
      tree.querySelectorAll<HTMLElement>("[data-record-id^='outline-']"),
    );
    const deepest = tree.querySelector<HTMLElement>("[data-record-id='outline-8']")!;
    const row = deepest.querySelector<HTMLElement>(".project-hierarchy__node-row")!;
    const copy = deepest.querySelector<HTMLElement>(".project-hierarchy__node-copy")!;
    const expansion = deepest.querySelector<HTMLButtonElement>(".project-hierarchy__collapse")!;
    const relevantStyles = document.createElement("style");
    relevantStyles.textContent = [
      baseStyles.match(/\.project-hierarchy__collapse\s*\{[^}]*\}/)?.[0],
      baseStyles.match(
        /\.project-hierarchy__root-list\[data-layout-mode="outline"\][\s\S]*?\.project-hierarchy__collapse\s*\{[^}]*\}/,
      )?.[0],
    ].filter(Boolean).join("\n");
    document.head.append(relevantStyles);
    const deepestStyle = getComputedStyle(deepest);
    const rules = Array.from(relevantStyles.sheet?.cssRules ?? []) as CSSStyleRule[];
    const ruleFor = (selectorSuffix: string) => rules.find((rule) => (
      rule.selectorText?.endsWith(selectorSuffix)
    ))!;
    const copyRule = ruleFor(" .project-hierarchy__node-copy");
    const rowRule = ruleFor(" .project-hierarchy__node-row");
    const outlineExpansionRule = ruleFor(" .project-hierarchy__collapse");
    const expansionRule = rules.find((rule) => (
      rule.selectorText === ".project-hierarchy__collapse"
    ))!;

    expect(tree.dataset.layoutMode).toBe("outline");
    expect(outlineNodes.map((node) => node.style.marginInlineStart)).toEqual([
      "16px",
      "32px",
      "48px",
      "64px",
      "80px",
      "96px",
      "112px",
      "128px",
      "128px",
    ]);
    expect(deepest.dataset.visualDepth).toBe("8");
    expect(deepestStyle.marginInlineStart).toBe("128px");
    expect(deepest.style.width).toBe("calc(100% - 128px)");
    expect(copyRule.style.minWidth).toBe("0px");
    expect(rowRule.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(outlineExpansionRule.style.width).toBe("auto");
    expect(outlineExpansionRule.style.whiteSpace).toBe("nowrap");
    expect(expansionRule.style.minWidth).toBe("48px");
    expect(expansionRule.style.minHeight).toBe("48px");
    expect(expansion.getAttribute("aria-label")).toBe("Expand Outline 8");
    expect(expansion.textContent).toBe("Expand");
    expect(copy.textContent).toContain("Outline 8");
    expect(row.contains(expansion)).toBe(true);

    const inlineOffset = Number.parseFloat(deepestStyle.marginInlineStart);
    const localWidth = 390 - inlineOffset;
    const requiredRowWidth = Math.max(
      Number.parseFloat(copyRule.style.minWidth),
      Number.parseFloat(expansionRule.style.minWidth),
    );
    const computedPageWidth = Math.max(390, inlineOffset + Math.max(localWidth, requiredRowWidth));
    expect(requiredRowWidth).toBeLessThanOrEqual(localWidth);
    expect(computedPageWidth).toBe(390);
    expect(inlineOffset - 8).toBeGreaterThanOrEqual(0);
    expect(baseStyles).toContain(
      '.project-hierarchy__node[data-visual-depth]:not([data-visual-depth="0"])::before',
    );
    expect(deepest.matches("[data-visual-depth]:not([data-visual-depth='0'])"))
      .toBe(true);
    relevantStyles.remove();
  });

  test("renders Expand for a cutoff summary with authoritative hidden children", () => {
    renderHierarchy({
      nodes: [{
        record: record("cutoff-1", "deliverable", "Cutoff branch"),
        parentId: null,
        depth: 0,
        childCount: 0,
        hiddenChildCount: 2,
        childrenExpanded: false,
      }],
      selectedId: "cutoff-1",
    });

    expect(screen.getByRole("button", {
      name: "Expand Cutoff branch",
    }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("2 hidden items")).toBeTruthy();
  });

  test("delegates pointer collapse and expansion only through onExpandedChange", async () => {
    const user = userEvent.setup();
    const { onExpandedChange, onSelect, rerender } = renderHierarchy({
      selectedId: "milestone-1",
    });

    await user.click(screen.getByRole("button", {
      name: "Collapse Semantic hierarchy",
    }));
    expect(onExpandedChange).toHaveBeenCalledWith("deliverable-1", false);
    expect(onSelect).not.toHaveBeenCalled();

    const collapsedNodes = nodes
      .filter(({ record }) => record.id !== "story-1" && record.id !== "subtask-1")
      .map((node) => node.record.id === "deliverable-1"
        ? { ...node, childCount: 0, hiddenChildCount: 1, childrenExpanded: false }
        : node);
    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-collapsed"
        vocabulary={software}
        nodes={collapsedNodes}
        connections={connections}
        selectedId="milestone-1"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={onSelect}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={onExpandedChange}
      />,
    );
    expect(screen.queryByRole("treeitem", { name: "Story or Task: Select a record" })).toBeNull();
    await user.click(screen.getByRole("button", {
      name: "Expand Semantic hierarchy",
    }));
    expect(onExpandedChange).toHaveBeenLastCalledWith("deliverable-1", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("disables selected-ancestor collapse with an accessible reason", async () => {
    const { onExpandedChange, onSelect } = renderHierarchy({
      selectedId: "subtask-1",
    });
    const ancestor = screen.getByRole("treeitem", {
      name: "Epic: Guide the project map",
    });
    const collapse = screen.getByRole("button", {
      name: "Collapse Guide the project map",
    }) as HTMLButtonElement;

    expect(ancestor.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.disabled).toBe(true);
    expect(document.getElementById(collapse.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Collapse is unavailable while this branch contains the selected item.");
    await userEvent.click(collapse);

    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector("[data-record-id='subtask-1']")?.getAttribute("aria-current"))
      .toBe("true");
  });

  test("keeps selected-ancestor ARIA expanded across a contradictory same-geometry rerender", () => {
    const { rerender } = renderHierarchy({
      cameraLayoutRevision: "stable-geometry",
      selectedId: "subtask-1",
    });
    const collapsedNodes = nodes.map((node) => node.record.id === "initiative-1"
      ? { ...node, childrenExpanded: false }
      : node);

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        cameraFitRequestKey={0}
        cameraLayoutRevision="stable-geometry"
        connections={connections}
        focusRequestKey={0}
        nodes={collapsedNodes}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        onExpandedChange={() => undefined}
        onSelect={() => undefined}
        onSelectProject={() => undefined}
        onShowWholeProject={() => undefined}
        project={{ id: "project-1", name: "IntentArc" }}
        scopePath={[]}
        scopeRecordId={null}
        selectedId="subtask-1"
        showConnections
        vocabulary={software}
      />,
    );

    expect(screen.getByRole("treeitem", {
      name: "Epic: Guide the project map",
    }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByRole("button", {
      name: "Collapse Guide the project map",
    }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("ignores stale selected-ancestor collapse and makes keyboard Left move to its parent", async () => {
    const hierarchyNodes: ProjectMapResponse["hierarchyNodes"] = [
      { ...record("outcome-1", "outcome", "Keep work coherent"), parentId: null, childCount: 1 },
      { ...record("initiative-1", "initiative", "Guide the project map"), parentId: "outcome-1", childCount: 2 },
      { ...record("deliverable-1", "deliverable", "Semantic hierarchy"), parentId: "initiative-1", childCount: 1 },
      { ...record("story-1", "task", "Select a record"), parentId: "deliverable-1", childCount: 1 },
      { ...record("subtask-1", "task", "Preserve the selected ID"), parentId: "story-1", childCount: 0 },
      { ...record("milestone-1", "milestone", "Ready for review"), parentId: "initiative-1", childCount: 0 },
    ];

    const onExpandedChange = vi.fn();
    function ControlledHierarchy() {
      const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
        new Set(["initiative-1"]),
      );
      const projection = deriveProjectMapProjection({
        nodes: hierarchyNodes,
        unplacedRecordIds: new Set(),
        selectedId: "subtask-1",
        selectedPath: hierarchyNodes.slice(0, 5),
        scopeId: null,
        visibleDepth: 8,
        expandedIds: new Set(),
        collapsedIds,
      });
      return (
        <ProjectHierarchyView
          activeRootId="project:project-1"
          cameraFitRequestKey={0}
          cameraLayoutRevision={projection.nodes.map(({ record }) => record.id).join("|")}
          connections={[]}
          focusRequestKey={0}
          nodes={projection.nodes}
          occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
          onExpandedChange={(recordId, expanded) => {
            onExpandedChange(recordId, expanded);
            setCollapsedIds((current) => {
              const next = new Set(current);
              if (expanded) next.delete(recordId);
              else next.add(recordId);
              return next;
            });
          }}
          onSelect={() => undefined}
          onSelectProject={() => undefined}
          onShowWholeProject={() => undefined}
          project={{ id: "project-1", name: "IntentArc" }}
          scopePath={[]}
          scopeRecordId={null}
          selectedId="subtask-1"
          showConnections
          vocabulary={software}
        />
      );
    }

    render(<ControlledHierarchy />);
    const collapse = screen.getByRole("button", {
      name: "Collapse Guide the project map",
    }) as HTMLButtonElement;

    expect(collapse.disabled).toBe(true);
    expect(screen.getByRole("treeitem", { name: "Milestone: Ready for review" })).toBeTruthy();
    expect(screen.getByRole("treeitem", {
      name: "Subtask: Preserve the selected ID",
    }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(collapse);
    expect(onExpandedChange).not.toHaveBeenCalled();

    const protectedAncestor = screen.getByRole("treeitem", {
      name: "Epic: Guide the project map",
    });
    protectedAncestor.focus();
    await userEvent.keyboard("{ArrowLeft}");

    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("treeitem", {
      name: "Product outcome: Keep work coherent",
    }));
    expect(screen.getByRole("treeitem", { name: "Milestone: Ready for review" })).toBeTruthy();
  });

  test("treats rerendered projection nodes as the sole visibility authority", async () => {
    const { onExpandedChange, onSelect, rerender } = renderHierarchy({
      selectedId: "milestone-1",
    });
    await userEvent.click(screen.getByRole("button", {
      name: "Collapse Semantic hierarchy",
    }));

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-a"
        vocabulary={software}
        nodes={nodes}
        connections={connections}
        selectedId="milestone-1"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={onSelect}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={onExpandedChange}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "Story or Task: Select a record" })).toBeTruthy();
  });

  test("retains selected ancestry and sibling orientation when controlled ancestors are collapsed", () => {
    renderHierarchy({ selectedId: "subtask-1" });

    expect(screen.getByRole("treeitem", {
      name: "Product outcome: Keep work coherent",
    })).toBeTruthy();
    expect(screen.getByRole("treeitem", {
      name: "Epic: Guide the project map",
    })).toBeTruthy();
    expect(screen.getByRole("treeitem", {
      name: "Feature: Semantic hierarchy",
    })).toBeTruthy();
    expect(screen.getByRole("treeitem", {
      name: "Story or Task: Select a record",
    })).toBeTruthy();
    expect(screen.getByRole("treeitem", {
      name: "Subtask: Preserve the selected ID",
    }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("treeitem", {
      name: "Milestone: Ready for review",
    })).toBeTruthy();
    expect(screen.queryByRole("treeitem", {
      name: "Story or Task: Unrelated deep context",
    })).toBeNull();
  });

  test("anchors decorative cross-links to rendered cards without replacing the tree", async () => {
    const { rerender } = renderHierarchy();

    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });
    await waitFor(() => expect(document.querySelector(
      "svg[aria-hidden='true'] path[data-connector-id='connection-1']",
    )).toBeTruthy());
    expect(document.querySelectorAll("path[data-connector-style='primary']")).toHaveLength(nodes.length);
    expect(document.querySelector("[data-connector-record-id='deliverable-1']")).toBeTruthy();
    expect(document.querySelector("[data-connector-record-id='milestone-1']")).toBeTruthy();

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-a"
        vocabulary={software}
        nodes={nodes}
        connections={connections}
        selectedId="deliverable-1"
        showConnections={false}
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("path[data-connector-id='connection-1']")).toBeNull();
      expect(document.querySelectorAll("path[data-connector-style='primary']"))
        .toHaveLength(nodes.length);
    });
    expect(screen.getByRole("tree", { name: "IntentArc hierarchy tree" })).toBe(tree);
  });

  test("omits primary paths when a rendered record has no visible parent endpoint", async () => {
    const orphan = {
      record: record("orphan-1", "task", "Unplaced record"),
      parentId: "missing-parent",
      depth: 0,
      childCount: 0,
      hiddenChildCount: 0,
      childrenExpanded: false,
    } satisfies HierarchyDisplayNode;
    renderHierarchy({ connections: [], nodes: [orphan], selectedId: "orphan-1" });

    await waitFor(() => {
      expect(document.querySelector("path[data-connector-style='primary']")).toBeNull();
    });
    expect(screen.queryByRole("img", { name: /Primary hierarchy connection/ })).toBeNull();
  });

  test("changes controlled visible nodes while retaining one semantic tree", () => {
    const { rerender } = renderHierarchy();
    const tree = screen.getByRole("tree", { name: "IntentArc hierarchy tree" });

    expect(screen.getByRole("treeitem", { name: "Subtask: Preserve the selected ID" })).toBeTruthy();

    rerender(
      <ProjectHierarchyView
        activeRootId="project:project-1"
        project={{ id: "project-1", name: "IntentArc" }}
        cameraFitRequestKey={0}
        focusRequestKey={0}
        occlusionInsets={{ top: 0, right: 0, bottom: 0, left: 0 }}
        cameraLayoutRevision="layout-without-subtask"
        vocabulary={software}
        nodes={nodes.filter((node) => node.record.id !== "subtask-1")}
        connections={connections}
        selectedId="deliverable-1"
        showConnections
        scopeRecordId={null}
        onSelectProject={() => undefined}
        onSelect={() => undefined}
        onShowWholeProject={() => undefined}
        scopePath={[]}
        onExpandedChange={() => undefined}
      />,
    );

    expect(screen.getByRole("tree", { name: "IntentArc hierarchy tree" })).toBe(tree);
    expect(screen.getByRole("treeitem", { name: "Product outcome: Keep work coherent" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Epic: Guide the project map" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Feature: Semantic hierarchy" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByRole("treeitem", { name: "Story or Task: Select a record" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Milestone: Ready for review" })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "Subtask: Preserve the selected ID" })).toBeNull();
  });

  test("renders hierarchy titles but excludes adversarial runtime body data from all markup", () => {
    const privateBody = "PRIVATE-BODY-9c683d4c";
    const adversarialNodes: readonly HierarchyDisplayNode[] = nodes.map((node) => (
      node.record.id === "deliverable-1"
        ? {
          ...node,
          record: {
            ...node.record,
            body: privateBody,
          } as HierarchyRecordSummary,
        }
        : node
    ));
    renderHierarchy({ nodes: adversarialNodes });

    const title = screen.getByText("Semantic hierarchy");
    expect(title.classList).toContain("project-hierarchy__node-title");
    const hierarchy = screen.getByRole("region", {
      name: "IntentArc project hierarchy",
    });
    expect(hierarchy.textContent).not.toContain(privateBody);
    expect(hierarchy.outerHTML).not.toContain(privateBody);
  });
});
