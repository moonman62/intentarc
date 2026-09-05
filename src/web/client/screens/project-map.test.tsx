// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectedRecordDetailResponse,
  ProjectDashboardResponse,
  ProjectMapResponse,
} from "../../contracts.js";
import { RepositorySelectionProvider } from "../components/repository-selection.js";
import { ProjectMap, defaultProjectMapVisibleDepth } from "./project-map.js";

const baseStyles = readFileSync(resolve(process.cwd(), "src/web/client/styles/base.css"), "utf8");
const timestamp = "2026-08-03T10:00:00.000Z";
const neutralVocabulary: ProjectMapResponse["hierarchyVocabulary"] = {
  preset: "neutral",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
};
const record = (
  id: string,
  title: string,
  kind: ProjectMapResponse["hierarchyNodes"][number]["kind"] = "task",
) => ({
  id,
  kind,
  status: kind === "task" ? "active" as const : "accepted" as const,
  title,
  revision: 1,
});
const edge = (
  id: string,
  fromRecordId: string,
  fromLabel: string,
  toRecordId: string,
  toLabel: string,
) => ({
  id,
  kind: "parent_of" as const,
  label: "parent of",
  fromRecordId,
  fromLabel,
  toRecordId,
  toLabel,
});

const rectangle = (left: number, top: number, width: number, height: number): DOMRect => ({
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

const cameraState = (viewportElement: HTMLElement) => ({
  scale: Number(viewportElement.dataset.cameraScale),
  x: Number(viewportElement.dataset.cameraX),
  y: Number(viewportElement.dataset.cameraY),
});

const installCameraMeasurementHarness = ({
  connectorWorldBounds = false,
  inspectorBounds = rectangle(0, 0, 0, 0),
  simulateLegacyDetailColumn = false,
}: {
  readonly connectorWorldBounds?: boolean;
  readonly inspectorBounds?: DOMRect;
  readonly simulateLegacyDetailColumn?: boolean;
} = {}) => {
  const viewport = { width: 800, height: 700 };
  const content = { x: 100, y: 50, width: 1_600, height: 800 };
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrame = 1;
  let contentBoundsScans = 0;

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame;
    nextAnimationFrame += 1;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));
  vi.stubGlobal("ResizeObserver", class ResizeObserverStub implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
  });
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    if (!this.classList.contains("project-map-camera__viewport")) return 0;
    return simulateLegacyDetailColumn && this.closest(".project-map__layout--with-detail") !== null
      ? 590
      : viewport.width;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
    return this.classList.contains("project-map-camera__viewport") ? viewport.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? content.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? content.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.classList.contains("project-map-camera__viewport")) {
      const width = simulateLegacyDetailColumn && this.closest(".project-map__layout--with-detail") !== null
        ? 590
        : viewport.width;
      return rectangle(0, 0, width, viewport.height);
    }
    if (this.classList.contains("project-map-inspector")) return inspectorBounds;
    const world = this.hasAttribute("data-camera-world")
      ? this
      : this.closest<HTMLElement>("[data-camera-world]");
    if (world?.hasAttribute("data-camera-world")) {
      const transform = world.style.transform.match(
        /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/,
      );
      const x = Number(transform?.[1] ?? 0);
      const y = Number(transform?.[2] ?? 0);
      const scale = Number(transform?.[3] ?? 1);
      if (this.hasAttribute("data-camera-world")) return connectorWorldBounds
        ? rectangle(x, y, content.width * scale, content.height * scale)
        : rectangle(x, y, 0, 0);
      if (this.hasAttribute("data-connector-record-id") || this.matches("[role='tree']")) {
        return rectangle(
          x + content.x * scale,
          y + content.y * scale,
          content.width * scale,
          content.height * scale,
        );
      }
    }
    return rectangle(0, 0, 0, 0);
  });
  const querySelectorAll = Element.prototype.querySelectorAll;
  vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (selectors: string) {
    if (
      this instanceof HTMLElement &&
      this.hasAttribute("data-camera-world") &&
      selectors === "[data-connector-record-id],path[data-connector-id]"
    ) contentBoundsScans += 1;
    return querySelectorAll.call(this, selectors);
  });

  return {
    contentBoundsScans: () => contentBoundsScans,
    flushAnimationFrames() {
      act(() => {
        let batches = 0;
        while (animationFrames.size > 0) {
          if (batches >= 100) throw new Error("Camera measurement harness did not settle.");
          batches += 1;
          const frames = [...animationFrames.values()];
          animationFrames.clear();
          for (const frame of frames) frame(0);
        }
      });
    },
    resetContentBoundsScans() {
      contentBoundsScans = 0;
    },
  };
};

const mapFixture = (revision = 7): ProjectMapResponse => ({
  projectId: "project-one",
  projectName: "Project One",
  projectRevision: revision,
  hierarchyVocabulary: neutralVocabulary,
  selectedRecordId: null,
  scopeRecordId: null,
  selectedPath: [],
  hierarchyNodes: [
    { ...record("outcome-one", "Preserve project intent", "outcome"), parentId: null, childCount: 1 },
    { ...record("milestone-one", "Structured knowledge", "milestone"), parentId: "outcome-one", childCount: 2 },
    { ...record("task-one", "Ship accessible map"), parentId: "milestone-one", childCount: 1 },
    { ...record("task-child", "Verify keyboard path"), parentId: "task-one", childCount: 0 },
    { ...record("task-sibling", "Repository explorer"), parentId: "milestone-one", childCount: 1 },
    { ...record("task-hidden", "Hidden relationship target"), parentId: "task-sibling", childCount: 0 },
    { ...record("task-orphan", "Unplaced follow-up"), parentId: null, childCount: 0 },
  ],
  hierarchyEdges: [
    edge("rel-outcome-milestone", "outcome-one", "Preserve project intent", "milestone-one", "Structured knowledge"),
    edge("rel-milestone-task", "milestone-one", "Structured knowledge", "task-one", "Ship accessible map"),
    edge("rel-task-child", "task-one", "Ship accessible map", "task-child", "Verify keyboard path"),
    edge("rel-sibling", "milestone-one", "Structured knowledge", "task-sibling", "Repository explorer"),
    edge("rel-hidden-target", "task-sibling", "Repository explorer", "task-hidden", "Hidden relationship target"),
  ],
  unplacedRecordIds: ["task-orphan"],
  progress: { childStatuses: { active: 1 }, childrenWithEvidence: 1, childCount: 1 },
});

const mapFixtureWithUnplacedChild = (): ProjectMapResponse => {
  const fixture = mapFixture();
  return {
    ...fixture,
    hierarchyNodes: [
      ...fixture.hierarchyNodes.map((node) => node.id === "task-orphan"
        ? { ...node, childCount: 1 }
        : node),
      {
        ...record("task-orphan-child", "Unplaced child"),
        parentId: "task-orphan",
        childCount: 0,
      },
    ],
    hierarchyEdges: [
      ...fixture.hierarchyEdges,
      edge(
        "rel-orphan-child",
        "task-orphan",
        "Unplaced follow-up",
        "task-orphan-child",
        "Unplaced child",
      ),
    ],
  };
};

const detailFixture = (
  recordId = "task-one",
  revision = 7,
): ConnectedRecordDetailResponse => ({
  projectId: "project-one",
  projectRevision: revision,
  record: {
    id: recordId,
    projectId: "project-one",
    kind: "task",
    status: "active",
    title: recordId === "task-sibling" ? "Repository explorer" : "Ship accessible map",
    body: recordId === "task-sibling"
      ? "Keep repository context close."
      : "Keep hierarchy and evidence readable.",
    sourceKind: "human",
    sourceRef: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  relations: [{
    depth: 1,
    edge: {
      id: "rel-evidence",
      kind: "evidenced_by",
      label: "Evidenced by",
      fromRecordId: recordId,
      fromLabel: "Ship accessible map",
      toRecordId: "evidence-one",
      toLabel: "Keyboard review",
    },
    record: { id: "evidence-one", kind: "evidence", status: "accepted", title: "Keyboard review", revision: 1 },
  }],
  attachmentsByBasis: {
    accepted: [{
      linkId: "link-readme",
      nodeId: "node-readme",
      path: "docs/map.md",
      nodeKind: "file",
      linkKind: "documents",
      linkLabel: "Documents",
      basis: "accepted",
      documentKind: "specification",
      documentFormat: "markdown",
      role: "supporting_document",
    }],
    observed: [],
    inferred: [],
    conflicting: [],
  },
});

const relation = (
  id: string,
  targetId: string,
  title: string,
): ConnectedRecordDetailResponse["relations"][number] => ({
  depth: 1,
  edge: {
    id,
    kind: "depends_on",
    label: "Depends on",
    fromRecordId: "task-one",
    fromLabel: "Ship accessible map",
    toRecordId: targetId,
    toLabel: title,
  },
  record: record(targetId, title),
});

const relationFrom = (
  sourceId: string,
  sourceTitle: string,
  id: string,
  targetId: string,
  title: string,
): ConnectedRecordDetailResponse["relations"][number] => {
  const direct = relation(id, targetId, title);
  return {
    ...direct,
    edge: {
      ...direct.edge,
      fromRecordId: sourceId,
      fromLabel: sourceTitle,
    },
  };
};

const relationshipDetail = (revision = 7): ConnectedRecordDetailResponse => ({
  ...detailFixture("task-one", revision),
  relations: [
    relation("rel-visible", "task-sibling", "Repository explorer"),
    relation("rel-hidden", "task-hidden", "Hidden relationship target"),
    relation("rel-unplaced", "task-orphan", "Unplaced follow-up"),
    relation("rel-missing", "task-missing", "Missing target"),
  ],
});

const dashboardFixture = (revision: number): ProjectDashboardResponse => ({
  project: {
    id: "project-one",
    name: "Project One",
    revision,
    primaryRepositoryPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  hierarchyVocabulary: neutralVocabulary,
  hierarchyParentContexts: [],
  recordsByKind: { task: 2 },
  currentOutcome: null,
  currentTask: null,
  attention: null,
  pendingProposalCount: 0,
  currentFocusPath: [],
  recentRecords: [],
});

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
}));

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const renderMap = (overrides: Partial<React.ComponentProps<typeof ProjectMap>> = {}) => {
  const onSelectProject = vi.fn();
  const onSelectRecord = vi.fn();
  const onClearSelection = vi.fn();
  const onFocusBranch = vi.fn();
  const onNavigateAttachment = vi.fn();
  const onShowWholeProject = vi.fn();
  const onDashboardRefetched = vi.fn();
  const props: React.ComponentProps<typeof ProjectMap> = {
    projectId: "project-one",
    projectRevision: 7,
    focusRecordId: "task-one",
    scopeRecordId: null,
    onSelectProject,
    onSelectRecord,
    onClearSelection,
    onFocusBranch,
    onNavigateAttachment,
    onShowWholeProject,
    onDashboardRefetched,
    ...overrides,
  };
  const view = render(
    <RepositorySelectionProvider><ProjectMap {...props} /></RepositorySelectionProvider>,
  );
  const rerenderMap = (next: Partial<React.ComponentProps<typeof ProjectMap>>) => {
    Object.assign(props, next);
    view.rerender(
      <RepositorySelectionProvider><ProjectMap {...props} /></RepositorySelectionProvider>,
    );
  };
  return {
    onSelectProject,
    onSelectRecord,
    onClearSelection,
    onFocusBranch,
    onNavigateAttachment,
    onShowWholeProject,
    onDashboardRefetched,
    rerenderMap,
    ...view,
  };
};

const treeItem = (recordId: string): HTMLElement => {
  const item = document.querySelector<HTMLElement>(`[role='treeitem'][data-record-id='${recordId}']`);
  if (!item) throw new Error(`Missing tree item ${recordId}`);
  return item;
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
    const path = typeof request === "string" ? request : request.toString();
    if (path.endsWith("/map")) return json(mapFixture());
    if (path.endsWith("/records/task-one/connected-detail")) return json(detailFixture());
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  cleanup();
  document.querySelector("[data-project-map-test-styles]")?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProjectMap", () => {
  test("renders the cold routed inspector before topology resolves", async () => {
    const topology = deferred<Response>();
    const detail = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return topology.promise;
      if (path.endsWith("/records/task-one/connected-detail")) return detail.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderMap();

    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    expect(within(inspector).getByRole("heading", { name: "Loading selected item…" })).toBeTruthy();
    expect(within(inspector).getByText("task-one")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  test("keeps the wide camera width when the inspector opens as an overlay", async () => {
    const camera = installCameraMeasurementHarness({
      inspectorBounds: rectangle(480, 0, 320, 700),
      simulateLegacyDetailColumn: true,
    });
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-sibling/connected-detail")) return pending.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap({ focusRecordId: null });
    await screen.findByRole("treeitem", { name: "Work item: Repository explorer" });
    camera.flushAnimationFrames();
    const viewport = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const before = viewport.getBoundingClientRect().width;

    view.rerenderMap({ focusRecordId: "task-sibling" });
    await screen.findByRole("complementary", { name: "Selected item details" });
    camera.flushAnimationFrames();

    expect(before).toBe(800);
    expect(viewport.getBoundingClientRect().width).toBeCloseTo(before, 0);
    expect(viewport.closest(".project-map__canvas-shell")).not.toBeNull();
  });

  test("owns zero camera occlusion and cold-starts the routed active branch at 100%", async () => {
    const camera = installCameraMeasurementHarness();
    renderMap({ focusRecordId: "task-one", scopeRecordId: "task-one" });
    await screen.findByRole("treeitem", { name: "Work item: Ship accessible map" });
    camera.flushAnimationFrames();

    const viewport = document.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewport)).toEqual({ scale: 1, x: -500, y: -18 });
    expect(screen.getByRole("button", { name: "Fit branch" })).toBeTruthy();
  });

  test("turns an inspector Focus branch route change into one preserve-scale camera request", async () => {
    const camera = installCameraMeasurementHarness();
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");
    camera.flushAnimationFrames();
    const viewport = document.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(cameraState(viewport).scale).toBeCloseTo(1.3);

    await user.click(screen.getByRole("button", { name: "Focus branch" }));
    expect(view.onFocusBranch).toHaveBeenCalledWith("task-one");
    view.rerenderMap({ scopeRecordId: "task-one" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fit branch" })).toBeTruthy());
    await waitFor(() => {
      camera.flushAnimationFrames();
      expect(cameraState(viewport).scale).toBeCloseTo(1.3);
      expect(cameraState(viewport).x).toBeCloseTo(-770);
      expect(cameraState(viewport).y).toBeCloseTo(-33);
    });
  });

  test("uses exact responsive first-render depth defaults", async () => {
    expect(defaultProjectMapVisibleDepth(1440)).toBe(2);
    expect(defaultProjectMapVisibleDepth(1024)).toBe(2);
    expect(defaultProjectMapVisibleDepth(390)).toBe(1);

    vi.stubGlobal("innerWidth", 390);
    const view = renderMap({ focusRecordId: null });
    const narrowTree = await screen.findByRole("tree");
    expect(Math.max(...within(narrowTree).getAllByRole("treeitem").map(
      (item) => Number(item.dataset.depth),
    ))).toBe(1);
    view.unmount();

    cleanup();
    vi.stubGlobal("innerWidth", 1440);
    renderMap({ focusRecordId: null });
    const wideTree = await screen.findByRole("tree");
    expect(Math.max(...within(wideTree).getAllByRole("treeitem").map(
      (item) => Number(item.dataset.depth),
    ))).toBe(2);
  });

  test("keeps topology selection-neutral and selects locally while detail is stalled", async () => {
    const camera = installCameraMeasurementHarness();
    const detail = deferred<Response>();
    const mapRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        mapRequests.push(path);
        return json(mapFixture());
      }
      if (path.endsWith("/records/task-sibling/connected-detail")) return detail.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap({ focusRecordId: null });
    await screen.findByRole("treeitem", { name: "Work item: Repository explorer" });
    await userEvent.click(screen.getByRole("button", { name: "Expand Ship accessible map" }));
    camera.flushAnimationFrames();
    const initialIds = screen.getAllByRole("treeitem").map((item) => (
      item.dataset.projectId ?? item.dataset.recordId
    ));
    const viewport = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const initialCamera = {
      fit: viewport.dataset.cameraFitRequestKey,
      scale: viewport.dataset.cameraScale,
      x: viewport.dataset.cameraX,
      y: viewport.dataset.cameraY,
    };
    const initialProgress = screen.getByText(/Project progress:/).textContent;
    const initialWorldTransform = document.querySelector<HTMLElement>("[data-camera-world]")!.style.transform;
    camera.resetContentBoundsScans();

    view.rerenderMap({ focusRecordId: "task-sibling" });
    camera.flushAnimationFrames();

    expect(treeItem("task-sibling").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("navigation", { name: "Selected project path" }).textContent)
      .toContain("Repository explorer");
    expect(screen.getByRole("complementary", { name: "Selected item details" })
      .getAttribute("aria-busy")).toBe("true");
    expect(within(screen.getByRole("complementary", { name: "Selected item details" }))
      .getByRole("status").textContent).toBe("Loading Repository explorer details…");
    expect(screen.getAllByRole("treeitem").map((item) => (
      item.dataset.projectId ?? item.dataset.recordId
    ))).toEqual(initialIds);
    expect(screen.getByRole("button", { name: "Collapse Ship accessible map" }))
      .toBeTruthy();
    expect(screen.getByText(/Project progress:/).textContent).toBe(initialProgress);
    expect({
      fit: viewport.dataset.cameraFitRequestKey,
      scale: viewport.dataset.cameraScale,
      x: viewport.dataset.cameraX,
      y: viewport.dataset.cameraY,
    }).toEqual(initialCamera);
    expect(document.querySelector<HTMLElement>("[data-camera-world]")!.style.transform)
      .toBe(initialWorldTransform);
    expect(camera.contentBoundsScans()).toBe(1);
    expect(mapRequests).toEqual(["/api/projects/project-one/map"]);
  });

  test("renders the selected breadcrumb as current text while ancestors remain navigable", async () => {
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");

    const path = screen.getByRole("navigation", { name: "Selected project path" });
    const current = within(path).getByText("Ship accessible map");
    expect(current.tagName).toBe("SPAN");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(within(path).queryByRole("button", { name: "Ship accessible map" })).toBeNull();

    await user.click(current);
    expect(view.onSelectRecord).not.toHaveBeenCalled();

    await user.click(within(path).getByRole("button", { name: "Structured knowledge" }));
    expect(view.onSelectRecord).toHaveBeenCalledWith("milestone-one", null);
  });

  test("renders Project as current text without a selection and as truthful SPA navigation with one", async () => {
    const user = userEvent.setup();
    const view = renderMap({ focusRecordId: null });
    const path = await screen.findByRole("navigation", { name: "Selected project path" });
    const currentProject = within(path).getByText("Project: Project One");

    expect(currentProject.tagName).toBe("SPAN");
    expect(currentProject.getAttribute("aria-current")).toBe("page");
    expect(within(path).queryByRole("link", { name: "Project: Project One" })).toBeNull();

    view.rerenderMap({ focusRecordId: "task-one" });
    const projectLink = within(path).getByRole("link", { name: "Project: Project One" });
    expect(projectLink.getAttribute("aria-current")).toBeNull();
    await user.click(projectLink);
    expect(view.onSelectProject).toHaveBeenCalledTimes(1);
  });

  test.each(["topology-first", "detail-first"] as const)(
    "stages cold %s resources until their identities reconcile",
    async (order) => {
      const topology = deferred<Response>();
      const detail = deferred<Response>();
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
        const path = typeof request === "string" ? request : request.toString();
        calls.push(path);
        if (path.endsWith("/map")) return topology.promise;
        if (path.endsWith("/records/task-one/connected-detail")) return detail.promise;
        throw new Error(`Unexpected request: ${path}`);
      }));
      renderMap();
      await waitFor(() => expect(calls).toEqual([
        "/api/projects/project-one/map",
        "/api/projects/project-one/records/task-one/connected-detail",
      ]));

      (order === "topology-first" ? topology : detail).resolve(new Response(JSON.stringify(
        order === "topology-first" ? mapFixture() : detailFixture(),
      ), { status: 200, headers: { "Content-Type": "application/json" } }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByText("Keep hierarchy and evidence readable.")).toBeNull();

      (order === "topology-first" ? detail : topology).resolve(new Response(JSON.stringify(
        order === "topology-first" ? detailFixture() : mapFixture(),
      ), { status: 200, headers: { "Content-Type": "application/json" } }));
      expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    },
  );

  test("suppresses stale A detail after selection changes to B without reloading topology", async () => {
    const detailA = deferred<Response>();
    let mapCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        mapCalls += 1;
        return json(mapFixture());
      }
      if (path.endsWith("/records/task-one/connected-detail")) return detailA.promise;
      if (path.endsWith("/records/task-sibling/connected-detail")) {
        return json(detailFixture("task-sibling"));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap();
    await screen.findByRole("treeitem", { name: "Work item: Repository explorer" });
    view.rerenderMap({ focusRecordId: "task-sibling" });
    expect(await screen.findByText("Keep repository context close.")).toBeTruthy();

    detailA.resolve(new Response(JSON.stringify(detailFixture()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Keep hierarchy and evidence readable.")).toBeNull();
    expect(mapCalls).toBe(1);
  });

  test("reuses revision-keyed ready detail when returning to a warm selection", async () => {
    const detailCalls = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      const recordId = path.includes("/records/task-sibling/") ? "task-sibling" : "task-one";
      detailCalls.set(recordId, (detailCalls.get(recordId) ?? 0) + 1);
      return json(detailFixture(recordId));
    }));
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");

    view.rerenderMap({ focusRecordId: "task-sibling" });
    await screen.findByText("Keep repository context close.");
    view.rerenderMap({ focusRecordId: "task-one" });
    expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();

    expect(detailCalls.get("task-one")).toBe(1);
    expect(detailCalls.get("task-sibling")).toBe(1);
  });

  test("does not reuse dashboard-revision cache after verified topology advances", async () => {
    let topologyCalls = 0;
    let taskOneDetailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        return json(mapFixture(topologyCalls === 1 ? 7 : 8));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        taskOneDetailCalls += 1;
        const revision = taskOneDetailCalls === 1 ? 7 : 8;
        const response = detailFixture("task-one", revision);
        return json({
          ...response,
          record: {
            ...response.record,
            body: revision === 7 ? "Cached revision seven." : "Verified revision eight.",
          },
        });
      }
      if (path.endsWith("/records/task-sibling/connected-detail")) {
        return json(detailFixture("task-sibling", 8));
      }
      if (path.endsWith("/dashboard")) return json(dashboardFixture(7));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap({ projectRevision: 7 });
    expect(await screen.findByText("Cached revision seven.")).toBeTruthy();

    view.rerenderMap({ focusRecordId: "task-sibling", projectRevision: 7 });
    expect(await screen.findByText("Keep repository context close.")).toBeTruthy();
    expect(topologyCalls).toBe(2);

    view.rerenderMap({ focusRecordId: "task-one", projectRevision: 7 });
    expect(screen.queryByText("Cached revision seven.")).toBeNull();
    expect(await screen.findByText("Verified revision eight.")).toBeTruthy();
    expect(taskOneDetailCalls).toBe(2);
  });

  test("reconciles warm detail after an explicit topology Retry advances the map", async () => {
    let topologyCalls = 0;
    let taskOneDetailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        if (topologyCalls === 2) return Promise.reject(new Error("temporary topology failure"));
        return json(mapFixture(topologyCalls === 1 ? 7 : 8));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        taskOneDetailCalls += 1;
        const revision = taskOneDetailCalls === 1 ? 7 : 8;
        const response = detailFixture("task-one", revision);
        return json({
          ...response,
          record: {
            ...response.record,
            body: revision === 7 ? "Cached revision seven." : "Reconciled revision eight.",
          },
        });
      }
      if (path.endsWith("/dashboard")) return json(dashboardFixture(8));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap();
    expect(await screen.findByText("Cached revision seven.")).toBeTruthy();

    view.rerenderMap({ scopeRecordId: "missing-scope" });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    await user.click(within(inspector).getByRole("button", { name: "Retry" }));
    const topologyError = await screen.findByText("temporary topology failure");
    view.rerenderMap({ scopeRecordId: null });
    await user.click(within(topologyError.closest("[role='alert']")!).getByRole("button", {
      name: "Retry map",
    }));

    expect(screen.queryByText("Cached revision seven.")).toBeNull();
    expect(await screen.findByText("Reconciled revision eight.")).toBeTruthy();
    expect(topologyCalls).toBe(3);
    expect(taskOneDetailCalls).toBe(2);
  });

  test("never consumes same-revision reconciliation adoption for an explicit Retry", async () => {
    let topologyCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        return json(mapFixture(topologyCalls === 1 ? 7 : 8));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        return json(detailFixture("task-one", 8));
      }
      if (path.endsWith("/dashboard")) return json(dashboardFixture(8));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap({ projectRevision: 8 });
    expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(topologyCalls).toBe(2);

    view.rerenderMap({ projectRevision: 8, scopeRecordId: "missing-scope" });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    await user.click(within(inspector).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(topologyCalls).toBe(3));
  });

  test.each(["project change", "unmount"] as const)(
    "aborts project-owned dashboard synchronization on %s",
    async (termination) => {
      let topologyCalls = 0;
      let dashboardSignal: AbortSignal | null = null;
      vi.stubGlobal("fetch", vi.fn((request: string | URL | Request, init?: RequestInit) => {
        const path = typeof request === "string" ? request : request.toString();
        if (path === "/api/projects/project-one/map") {
          topologyCalls += 1;
          return json(mapFixture(topologyCalls === 1 ? 7 : 8));
        }
        if (path === "/api/projects/project-one/records/task-one/connected-detail") {
          return json(detailFixture("task-one", 8));
        }
        if (path === "/api/projects/project-one/dashboard") {
          dashboardSignal = init?.signal ?? null;
          return new Promise<Response>(() => undefined);
        }
        if (path === "/api/projects/project-two/map") {
          return new Promise<Response>(() => undefined);
        }
        throw new Error(`Unexpected request: ${path}`);
      }));
      const view = renderMap();
      expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
      await waitFor(() => expect(dashboardSignal).not.toBeNull());

      if (termination === "project change") {
        view.rerenderMap({ projectId: "project-two", projectRevision: 1, focusRecordId: null });
      } else {
        view.unmount();
      }

      expect(dashboardSignal?.aborted).toBe(true);
    },
  );

  test("does not promote warm detail when the authoritative project revision advances", async () => {
    let topologyCalls = 0;
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        return json(mapFixture(topologyCalls === 1 ? 7 : 8));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        detailCalls += 1;
        const revision = detailCalls === 1 ? 7 : 8;
        const response = detailFixture("task-one", revision);
        return json({
          ...response,
          record: {
            ...response.record,
            body: revision === 7 ? "Warm revision seven." : "Authoritative revision eight.",
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap({ projectRevision: 7 });
    expect(await screen.findByText("Warm revision seven.")).toBeTruthy();

    view.rerenderMap({ projectRevision: 8 });
    expect(screen.queryByText("Warm revision seven.")).toBeNull();
    expect(await screen.findByText("Authoritative revision eight.")).toBeTruthy();
    expect(topologyCalls).toBe(2);
    expect(detailCalls).toBe(2);
  });

  test("retries only failed selected detail without reloading verified topology", async () => {
    let mapCalls = 0;
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        mapCalls += 1;
        return json(mapFixture());
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        detailCalls += 1;
        return detailCalls === 1
          ? Promise.reject(new Error("temporary detail failure"))
          : json(detailFixture());
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    renderMap();
    expect((await screen.findByRole("alert")).textContent).toContain("temporary detail failure");
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });

    await user.click(within(inspector).getByRole("button", { name: "Retry" }));
    expect(await within(inspector).findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(detailCalls).toBe(2);
    expect(mapCalls).toBe(1);
  });

  test.each([
    { name: "newer detail", firstTopology: 7, firstDetail: 8, topologyCalls: 2, detailCalls: 1 },
    { name: "newer topology", firstTopology: 8, firstDetail: 7, topologyCalls: 1, detailCalls: 2 },
  ])("retries only the older side once for $name with an unchanged dashboard", async ({
    firstTopology,
    firstDetail,
    topologyCalls: wantedTopologyCalls,
    detailCalls: wantedDetailCalls,
  }) => {
    let topologyCalls = 0;
    let detailCalls = 0;
    let dashboardCalls = 0;
    const onDashboardRefetched = vi.fn();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        return json(mapFixture(topologyCalls === 1 ? firstTopology : firstDetail));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        detailCalls += 1;
        return json(detailFixture("task-one", detailCalls === 1 ? firstDetail : firstTopology));
      }
      if (path.endsWith("/dashboard")) {
        dashboardCalls += 1;
        return json(dashboardFixture(7));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap({ onDashboardRefetched });

    expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(topologyCalls).toBe(wantedTopologyCalls);
    expect(detailCalls).toBe(wantedDetailCalls);
    expect(dashboardCalls).toBe(1);
    expect(onDashboardRefetched).toHaveBeenCalledWith(dashboardFixture(7));
  });

  test("fails closed after a second mismatch without looping or discarding topology", async () => {
    let topologyCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        if (topologyCalls === 1) return json(mapFixture(7));
        const retry = mapFixture(9);
        return json({
          ...retry,
          hierarchyNodes: [
            ...retry.hierarchyNodes,
            { ...record("task-unverified", "Unverified retry node"), parentId: null, childCount: 0 },
          ],
          unplacedRecordIds: [...retry.unplacedRecordIds, "task-unverified"],
        });
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        return json(detailFixture("task-one", 8));
      }
      if (path.endsWith("/dashboard")) return json(dashboardFixture(7));
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap();

    expect((await screen.findByRole("alert")).textContent)
      .toMatch(/could not be reconciled/i);
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    expect(within(inspector).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Work item: Ship accessible map" })).toBeTruthy();
    expect(screen.queryByText("Unverified retry node")).toBeNull();
    expect(topologyCalls).toBe(2);
  });

  test("aborts an older selection generation's topology retry when focus changes", async () => {
    const topologyRetry = deferred<Response>();
    let topologyCalls = 0;
    let topologyRetrySignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        if (topologyCalls === 1) return json(mapFixture(7));
        topologyRetrySignal = init?.signal ?? null;
        return topologyRetry.promise;
      }
      if (path.endsWith("/records/task-one/connected-detail")) return json(detailFixture("task-one", 8));
      if (path.endsWith("/records/task-sibling/connected-detail")) return json(detailFixture("task-sibling", 7));
      if (path.endsWith("/dashboard")) return json(dashboardFixture(7));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap();
    await waitFor(() => expect(topologyCalls).toBe(2));
    expect(topologyRetrySignal).not.toBeNull();

    view.rerenderMap({ focusRecordId: "task-sibling" });

    expect(topologyRetrySignal?.aborted).toBe(true);
    expect(await screen.findByText("Keep repository context close.")).toBeTruthy();
  });

  test("restores the last verified topology when a directional retry mismatches again", async () => {
    let topologyCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        topologyCalls += 1;
        return json(topologyCalls === 1
          ? mapFixture(7)
          : { ...mapFixture(9), projectName: "Unverified retry topology" });
      }
      if (path.endsWith("/records/task-one/connected-detail")) return json(detailFixture("task-one", 7));
      if (path.endsWith("/records/task-sibling/connected-detail")) return json(detailFixture("task-sibling", 8));
      if (path.endsWith("/dashboard")) return json(dashboardFixture(7));
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");

    view.rerenderMap({ focusRecordId: "task-sibling" });

    const inspector = await screen.findByRole("complementary", { name: "Selected item details" });
    expect((await within(inspector).findByRole("alert")).textContent)
      .toMatch(/could not be reconciled/i);
    expect(screen.getByRole("link", { name: "Project: Project One" })).toBeTruthy();
    expect(screen.queryByText("Unverified retry topology")).toBeNull();
    expect(topologyCalls).toBe(2);
  });

  test("reloads topology only for an authoritative revision change or explicit Retry", async () => {
    let mapCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        mapCalls += 1;
        return mapCalls === 2
          ? Promise.reject(new Error("temporary topology failure"))
          : json(mapFixture(mapCalls === 1 ? 7 : 8));
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        return json(detailFixture("task-one", mapCalls >= 2 ? 8 : 7));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");

    view.rerenderMap({ scopeRecordId: "milestone-one" });
    await screen.findByRole("button", { name: "Show whole project" });
    expect(mapCalls).toBe(1);

    view.rerenderMap({ projectRevision: 8 });
    expect((await screen.findByRole("alert")).textContent).toContain("temporary topology failure");
    expect(screen.getByRole("treeitem", { name: "Work item: Ship accessible map" })).toBeTruthy();
    expect(mapCalls).toBe(2);

    await userEvent.click(screen.getByRole("button", { name: "Retry map" }));
    await waitFor(() => expect(mapCalls).toBe(3));
  });

  test("validates selection-neutral topology and detail identities before exposing them", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        const fixture = mapFixture();
        return json({
          ...fixture,
          selectedRecordId: "task-one",
          selectedPath: fixture.hierarchyNodes
            .filter(({ id }) => id === "outcome-one" || id === "milestone-one" || id === "task-one")
            .map(({ id, kind, status, title, revision }) => ({ id, kind, status, title, revision })),
        });
      }
      if (path.endsWith("/records/task-one/connected-detail")) {
        return json({ ...detailFixture(), projectId: "project-other" });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap();

    expect((await screen.findAllByRole("alert")).some((alert) => (
      alert.textContent?.includes("Project Map topology must be selection-neutral")
    ))).toBe(true);
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryByText("Keep hierarchy and evidence readable.")).toBeNull();
  });

  test("rejects selected detail with the wrong project identity", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) {
        const detail = detailFixture();
        return json({
          ...detail,
          projectId: "project-other",
          record: { ...detail.record, projectId: "project-other" },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap();

    expect((await screen.findByRole("alert")).textContent)
      .toContain("Connected detail did not match the selected record");
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    expect(within(inspector).queryByText("Keep hierarchy and evidence readable.")).toBeNull();
  });

  test.each([
    { focusRecordId: "task-one", scopeRecordId: "task-sibling" },
    { focusRecordId: null, scopeRecordId: "scope-missing" },
  ])("keeps verified topology behind an invalid route scope: $scopeRecordId", async (route) => {
    renderMap(route);

    expect(await screen.findByRole("tree")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/scope/i);
    expect(screen.getByRole("treeitem", { name: "Work item: Ship accessible map" })).toBeTruthy();
  });

  test("keeps invalid focused-route recovery visible when verified topology is empty", async () => {
    let mapRequests = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) {
        mapRequests += 1;
        return json({
          ...mapFixture(),
          hierarchyNodes: [],
          hierarchyEdges: [],
          unplacedRecordIds: [],
        });
      }
      if (path.endsWith("/records/task-missing/connected-detail")) {
        return json(detailFixture("task-missing"));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap({ focusRecordId: "task-missing" });

    await screen.findByRole("heading", { name: "No project hierarchy yet" });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    expect(within(inspector).getByRole("alert").textContent).toContain(
      "not present in the verified project map",
    );
    await user.click(within(inspector).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mapRequests).toBe(2));
    await user.click(within(
      screen.getByRole("complementary", { name: "Selected item details" }),
    ).getByRole("button", { name: "Close details" }));
    expect(view.onClearSelection).toHaveBeenCalledWith(null);
  });

  test("keeps invalid scope recovery visible on an empty unselected Map", async () => {
    let mapRequests = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (!path.endsWith("/map")) throw new Error(`Unexpected request: ${path}`);
      mapRequests += 1;
      return json({
        ...mapFixture(),
        hierarchyNodes: [],
        hierarchyEdges: [],
        unplacedRecordIds: [],
      });
    }));
    const user = userEvent.setup();
    const view = renderMap({ focusRecordId: null, scopeRecordId: "scope-missing" });

    await screen.findByRole("heading", { name: "No project hierarchy yet" });
    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("scope is not present in the verified project map");
    expect(screen.queryByRole("complementary", { name: "Selected item details" })).toBeNull();
    await user.click(within(error).getByRole("button", { name: "Retry map" }));
    await waitFor(() => expect(mapRequests).toBe(2));
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Close route error" }));
    expect(view.onClearSelection).toHaveBeenCalledWith(null);
  });

  test("Escape from the camera dismisses once and restores the selected tree item after route commit", async () => {
    const view = renderMap();
    const selected = await screen.findByRole("treeitem", { name: "Work item: Ship accessible map" });
    const camera = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    camera.focus();

    fireEvent.keyDown(camera, { key: "Escape" });
    expect(view.onClearSelection).toHaveBeenCalledTimes(1);
    expect(view.onClearSelection).toHaveBeenCalledWith(null);
    view.rerenderMap({ focusRecordId: null });

    await waitFor(() => expect(document.activeElement).toBe(selected));
  });

  test("Escape from a Move map direction closes only the disclosure before the inspector", async () => {
    const camera = installCameraMeasurementHarness();
    const view = renderMap();
    await screen.findByRole("treeitem", { name: "Work item: Ship accessible map" });
    camera.flushAnimationFrames();
    const moveMap = screen.getByRole("button", { name: "Move map" });
    await userEvent.click(moveMap);
    const directions = screen.getByRole("group", { name: "Move map directions" });
    const pan = within(directions).getAllByRole("button").find((button) => !button.hasAttribute("disabled"));
    expect(pan).toBeTruthy();
    pan!.focus();

    const nestedEscape = fireEvent.keyDown(pan!, { key: "Escape" });
    expect(nestedEscape).toBe(false);
    expect(screen.queryByRole("group", { name: "Move map directions" })).toBeNull();
    expect(document.activeElement).toBe(moveMap);
    expect(screen.getByRole("complementary", { name: "Selected item details" })).toBeTruthy();
    expect(view.onClearSelection).not.toHaveBeenCalled();

    const shell = document.querySelector<HTMLElement>("[data-project-map-camera-shell]")!;
    fireEvent.keyDown(shell, { key: "Escape" });
    expect(view.onClearSelection).toHaveBeenCalledTimes(1);
    expect(view.onClearSelection).toHaveBeenCalledWith(null);
    view.rerenderMap({ focusRecordId: null });
  });

  test("Escape falls back to the camera when the routed selection has no rendered item", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-missing/connected-detail")) {
        const missing = detailFixture("task-missing");
        return json({ ...missing, record: { ...missing.record, title: "Missing route item" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const view = renderMap({ focusRecordId: "task-missing" });
    await screen.findByRole("tree");
    const camera = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    camera.focus();

    fireEvent.keyDown(camera, { key: "Escape" });
    expect(view.onClearSelection).toHaveBeenCalledTimes(1);
    view.rerenderMap({ focusRecordId: null });

    await waitFor(() => expect(document.activeElement).toBe(camera));
  });

  test("Close clears focus, preserves scope, and returns focus to the selected card", async () => {
    const user = userEvent.setup();
    const view = renderMap({ scopeRecordId: "milestone-one" });
    const selected = await screen.findByRole("treeitem", { name: "Work item: Ship accessible map" });
    selected.focus();

    await user.click(await screen.findByRole("button", { name: "Close details" }));

    expect(view.onClearSelection).toHaveBeenCalledWith("milestone-one");
    view.rerenderMap({ focusRecordId: null });
    await waitFor(() => expect(document.activeElement).toBe(selected));
  });

  test("Close returns focus to a selected unplaced item", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-orphan/connected-detail")) {
        const detail = detailFixture("task-orphan");
        return json({ ...detail, record: { ...detail.record, title: "Unplaced follow-up" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap({ focusRecordId: "task-orphan" });
    const selected = await screen.findByRole("button", { name: "Unplaced follow-up" });
    expect(screen.queryByRole("button", { name: "Focus branch" })).toBeNull();
    selected.focus();

    await user.click(await screen.findByRole("button", { name: "Close details" }));

    expect(view.onClearSelection).toHaveBeenCalledWith(null);
    view.rerenderMap({ focusRecordId: null });
    await waitFor(() => expect(document.activeElement).toBe(selected));
  });

  test("selects an unplaced child from Unplaced work without projecting it into the hierarchy", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixtureWithUnplacedChild());
      if (path.endsWith("/records/task-orphan-child/connected-detail")) {
        const detail = detailFixture("task-orphan-child");
        return json({ ...detail, record: { ...detail.record, title: "Unplaced child" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap({ focusRecordId: null });
    const unplaced = await screen.findByRole("region", { name: "Unplaced work" });

    await user.click(within(unplaced).getByRole("button", { name: "Unplaced child" }));
    expect(view.onSelectRecord).toHaveBeenCalledWith("task-orphan-child", null);
    view.rerenderMap({ focusRecordId: "task-orphan-child" });

    expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "Work item: Unplaced child" })).toBeNull();
  });

  test("opens a directly routed unplaced child in the read-only inspector", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixtureWithUnplacedChild());
      if (path.endsWith("/records/task-orphan-child/connected-detail")) {
        const detail = detailFixture("task-orphan-child");
        return json({ ...detail, record: { ...detail.record, title: "Unplaced child" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderMap({ focusRecordId: "task-orphan-child" });

    expect(await screen.findByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unplaced child" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.queryByRole("button", { name: "Focus branch" })).toBeNull();
  });

  test("keeps branch focus in the inspector and never on hierarchy cards", async () => {
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByText("Keep hierarchy and evidence readable.");

    expect(screen.queryByRole("button", { name: /Focus here:/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Focus branch" }));
    expect(view.onFocusBranch).toHaveBeenCalledWith("task-one");
  });

  test("navigates visible, hidden, and unplaced relationship targets and bounds missing targets", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return json(relationshipDetail());
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByRole("region", { name: "Direct cross-links" });

    await user.click(screen.getByRole("button", { name: "Select related Repository explorer" }));
    expect(view.onSelectRecord).toHaveBeenLastCalledWith("task-sibling", null);
    await user.click(screen.getByRole("button", { name: "Select related Missing target" }));
    expect(within(screen.getByRole("complementary", { name: "Selected item details" }))
      .getByRole("alert").textContent).toContain("not present in the verified project map");

    await user.click(screen.getByRole("button", { name: "Select related Hidden relationship target" }));
    expect(screen.getByRole("treeitem", { name: "Subtask: Hidden relationship target" })).toBeTruthy();
    expect(view.onSelectRecord).toHaveBeenLastCalledWith("task-hidden", null);

    await user.click(screen.getByRole("button", { name: "Select related Unplaced follow-up" }));
    expect(view.onSelectRecord).toHaveBeenLastCalledWith("task-orphan", null);
  });

  test("clears focused scope for an out-of-scope relationship target", async () => {
    const scopedDetail = {
      ...detailFixture(),
      relations: [relation("rel-outside", "task-sibling", "Repository explorer")],
    };
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return json(scopedDetail);
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap({ scopeRecordId: "task-one" });
    await screen.findByRole("button", { name: "Select related Repository explorer" });
    await user.click(screen.getByRole("button", { name: "Select related Repository explorer" }));
    expect(view.onSelectRecord).toHaveBeenCalledWith("task-sibling", null);
  });

  test("keeps non-hierarchy detail and only accepted canonical attachment destinations", async () => {
    const baseAttachment = detailFixture().attachmentsByBasis.accepted[0]!;
    const attachmentDetail: ConnectedRecordDetailResponse = {
      ...detailFixture(),
      attachmentsByBasis: {
        accepted: [baseAttachment],
        observed: [{
          ...baseAttachment,
          linkId: "link-observed",
          nodeId: "node-observed",
          path: "src/project-map.tsx",
          linkKind: "implements",
          linkLabel: "Implements",
          basis: "observed",
        }],
        inferred: [{
          ...baseAttachment,
          linkId: "link-inferred",
          nodeId: "node-inferred",
          path: "tests/project-map.test.tsx",
          linkKind: "evidences",
          linkLabel: "Evidences",
          basis: "inferred",
        }],
        conflicting: [{
          ...baseAttachment,
          linkId: "link-conflicting",
          nodeId: "node-conflicting",
          path: "docs/legacy-map.md",
          linkKind: "related_to",
          linkLabel: "Related to",
          basis: "conflicting",
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return json(attachmentDetail);
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    renderMap();
    await screen.findByRole("button", { name: "Show related Keyboard review" });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    await user.click(within(inspector).getByRole("button", { name: "Show related Keyboard review" }));
    expect(within(inspector).getByRole("group", { name: "Related item Keyboard review" })).toBeTruthy();

    const attachments = within(inspector).getByRole("region", { name: "Record attachments" });
    const expectedAttachments = [
      ["Accepted", "node-readme", "docs/map.md", "Documents"],
    ] as const;
    for (const [basis, nodeId, path, linkKind] of expectedAttachments) {
      const group = within(attachments).getByRole("region", { name: `${basis} attachments` });
      expect(within(group).getByText(path)).toBeTruthy();
      expect(within(group).getByText(`${basis} basis · ${linkKind}`)).toBeTruthy();
      expect(within(group).getByText("File · Supporting document · Specification · Markdown")).toBeTruthy();
      expect(within(group).getByRole("link", { name: "Repository" }).getAttribute("href"))
        .toBe(`/projects/project-one/repository?nodeId=${nodeId}`);
      expect(within(group).getByRole("link", { name: "Documentation" }).getAttribute("href"))
        .toBe(`/projects/project-one/documentation/${nodeId}`);
    }
    expect(within(attachments).queryByRole("region", { name: "Observed attachments" })).toBeNull();
    expect(within(attachments).queryByRole("region", { name: "Inferred attachments" })).toBeNull();
    expect(within(attachments).queryByRole("region", { name: "Conflicting attachments" })).toBeNull();
    expect(within(attachments).queryByText("src/project-map.tsx")).toBeNull();
    expect(within(attachments).queryByText("tests/project-map.test.tsx")).toBeNull();
    expect(within(attachments).queryByText("docs/legacy-map.md")).toBeNull();
  });

  test("shows Cross-links only for visible selected relationships and retains their project-session preference", async () => {
    const measurements = installCameraMeasurementHarness({ connectorWorldBounds: true });
    const pendingInitial = deferred<Response>();
    const pendingSibling = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("/projects/project-two/")) {
        if (path.endsWith("/map")) return json({
          ...mapFixture(1),
          projectId: "project-two",
          projectName: "Project Two",
        });
        if (path.endsWith("/records/task-one/connected-detail")) return json({
          ...relationshipDetail(1),
          projectId: "project-two",
          record: { ...relationshipDetail(1).record, projectId: "project-two" },
        });
      }
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return pendingInitial.promise;
      if (path.endsWith("/records/task-sibling/connected-detail")) return pendingSibling.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByRole("tree");
    measurements.flushAnimationFrames();
    const controlStyles = document.createElement("style");
    controlStyles.dataset.projectMapTestStyles = "true";
    controlStyles.textContent = baseStyles.match(/\.project-map__controls\s*\{[^}]*\}/)?.[0] ?? "";
    document.head.append(controlStyles);
    const reservedControlRow = document.querySelector<HTMLElement>(".project-map__controls");
    expect(reservedControlRow).toBeTruthy();
    expect(reservedControlRow!.parentElement?.classList.contains("stage__header")).toBe(true);
    expect(getComputedStyle(reservedControlRow!).minHeight).toBe("40px");
    expect(screen.queryByRole("button", { name: "Cross-links" })).toBeNull();
    pendingInitial.resolve(new Response(JSON.stringify(relationshipDetail()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const toggle = await screen.findByRole("button", { name: "Cross-links" });
    expect(document.querySelector(".project-map__controls")).toBe(reservedControlRow);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.querySelector(
      "path[data-connector-id='rel-visible'][data-connector-style='cross']",
    )).toBeTruthy());
    const primaryPathCount = document.querySelectorAll(
      "path[data-connector-style='primary']",
    ).length;
    expect(primaryPathCount).toBeGreaterThan(0);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("path[data-connector-id='rel-visible']")).toBeNull();
    expect(document.querySelectorAll("path[data-connector-style='primary']"))
      .toHaveLength(primaryPathCount);
    expect(within(screen.getByRole("region", { name: "Direct cross-links" }))
      .getByText("Depends on · Repository explorer · Active")).toBeTruthy();

    view.rerenderMap({ focusRecordId: "task-sibling" });
    expect(document.querySelector("path[data-connector-id='rel-visible']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cross-links" })).toBeNull();
    pendingSibling.resolve(new Response(JSON.stringify({
      ...detailFixture("task-sibling"),
      relations: [relation("rel-return", "task-one", "Ship accessible map")],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect((await screen.findByRole("button", { name: "Cross-links" })).getAttribute("aria-pressed"))
      .toBe("false");
    expect(document.querySelector("path[data-connector-id='rel-return']")).toBeNull();

    view.rerenderMap({
      projectId: "project-two",
      projectRevision: 1,
      focusRecordId: "task-one",
    });
    expect((await screen.findByRole("button", { name: "Cross-links" })).getAttribute("aria-pressed"))
      .toBe("true");
  });

  test("keeps Cross-links absent for verified non-visible relationships without losing the project preference", async () => {
    const measurements = installCameraMeasurementHarness({ connectorWorldBounds: true });
    const nonVisibleDetail: ConnectedRecordDetailResponse = {
      ...detailFixture("task-sibling"),
      relations: [
        relationFrom("task-sibling", "Repository explorer", "rel-hidden-only", "task-hidden", "Hidden relationship target"),
        relationFrom("task-sibling", "Repository explorer", "rel-unplaced-only", "task-orphan", "Unplaced follow-up"),
        relationFrom("task-sibling", "Repository explorer", "rel-missing-only", "task-missing", "Missing target"),
      ],
    };
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return json(relationshipDetail());
      if (path.endsWith("/records/task-sibling/connected-detail")) return json(nonVisibleDetail);
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup();
    const view = renderMap();
    await screen.findByRole("tree");
    measurements.flushAnimationFrames();
    const toggle = await screen.findByRole("button", { name: "Cross-links" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    view.rerenderMap({ focusRecordId: "task-sibling" });
    await screen.findByRole("button", { name: "Select related Hidden relationship target" });
    expect(screen.getByRole("region", { name: "Direct cross-links" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cross-links" })).toBeNull();
    expect(document.querySelector("path[data-connector-style='cross']")).toBeNull();

    view.rerenderMap({ focusRecordId: "task-one" });
    expect((await screen.findByRole("button", { name: "Cross-links" })).getAttribute("aria-pressed"))
      .toBe("false");
    expect(document.querySelector("path[data-connector-style='cross']")).toBeNull();
  });

  test("keeps unplaced work read-only and exposes no authoring or global-depth controls", async () => {
    const writeRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (init?.method && init.method !== "GET") writeRequests.push(`${init.method}:${path}`);
      if (path.endsWith("/map")) return json(mapFixture());
      if (path.endsWith("/records/task-one/connected-detail")) return json(detailFixture());
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap();
    const unplaced = await screen.findByRole("region", { name: "Unplaced work" });
    expect(within(unplaced).getByText("Unplaced follow-up")).toBeTruthy();

    for (const name of [
      "Visual project map",
      "Edit hierarchy",
      "Set parent",
      "Remove parent",
      "Place work",
      "Show one more level",
      "Show less detail",
    ]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Project vocabulary" })).toBeNull();
    expect(writeRequests).toEqual([]);
  });

  test("keeps an empty Map read-only without an authoring launch point", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/map")) return json({
        ...mapFixture(),
        hierarchyNodes: [],
        hierarchyEdges: [],
        unplacedRecordIds: [],
      });
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderMap({ focusRecordId: null });

    await screen.findByRole("heading", { name: "No project hierarchy yet" });
    expect(screen.queryByRole("button", { name: "Capture work to place" })).toBeNull();
  });
});
