// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ConnectedRecordDetailResponse } from "../../contracts.js";
import {
  ProjectMapInspector,
  type ProjectMapInspectorDetailState,
} from "./project-map-inspector.js";

const timestamp = "2026-08-03T10:00:00.000Z";
const selected = {
  id: "task-one",
  kind: "task" as const,
  status: "active" as const,
  title: "Ship accessible map",
  revision: 1,
};
const detail: ConnectedRecordDetailResponse = {
  projectId: "project-one",
  projectRevision: 7,
  record: {
    ...selected,
    projectId: "project-one",
    body: "Keep hierarchy and evidence readable.",
    sourceKind: "human",
    sourceRef: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  relations: [{
    depth: 1,
    edge: {
      id: "relation-one",
      kind: "depends_on",
      label: "Depends on",
      fromRecordId: "task-one",
      fromLabel: "Ship accessible map",
      toRecordId: "task-two",
      toLabel: "Verify responsive sheet",
    },
    record: {
      id: "task-two",
      kind: "task",
      status: "planned",
      title: "Verify responsive sheet",
      revision: 1,
    },
  }],
  attachmentsByBasis: {
    accepted: [{
      linkId: "attachment-one",
      nodeId: "node-one",
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
};

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

let narrow = false;
let narrowExpandedTop = 336;
let wideInspectorLeft = 600;
let resizeCallback: ResizeObserverCallback | null = null;

const renderInspector = (
  detailState: ProjectMapInspectorDetailState,
  overrides: Partial<React.ComponentProps<typeof ProjectMapInspector>> = {},
) => {
  const onClose = vi.fn();
  const onFocusBranch = vi.fn();
  const onNavigateAttachment = vi.fn();
  const onSelectRelated = vi.fn();
  const onOcclusionInsetsChange = vi.fn();
  const view = render(
    <div className="project-map__canvas-shell">
      <div className="project-map-camera__viewport" />
      <ProjectMapInspector
        detailState={detailState}
        onClose={onClose}
        onFocusBranch={onFocusBranch}
        onNavigateAttachment={onNavigateAttachment}
        onOcclusionInsetsChange={onOcclusionInsetsChange}
        onSelectRelated={onSelectRelated}
        routeRecordId="task-one"
        scopeRecordId={null}
        selected={selected}
        {...overrides}
      />
      <button type="button">After inspector</button>
    </div>,
  );
  return {
    onClose,
    onFocusBranch,
    onNavigateAttachment,
    onOcclusionInsetsChange,
    onSelectRelated,
    ...view,
  };
};

beforeEach(() => {
  narrow = false;
  narrowExpandedTop = 336;
  wideInspectorLeft = 600;
  resizeCallback = null;
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: narrow,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("ResizeObserver", class ResizeObserverStub implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.classList.contains("project-map-camera__viewport")) return rectangle(0, 0, 1000, 700);
    if (this.classList.contains("project-map-inspector")) {
      if (!narrow) return rectangle(wideInspectorLeft, 20, 1000 - wideInspectorLeft, 660);
      if (this.dataset.collapsed === "true") return rectangle(0, 644, 1000, 56);
      return rectangle(0, narrowExpandedTop, 1000, 700 - narrowExpandedTop);
    }
    return rectangle(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProjectMapInspector", () => {
  test("renders a cold loading shell immediately with only the route identity", () => {
    renderInspector({ status: "loading" }, { selected: null, routeRecordId: "cold-route-id" });

    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    expect(inspector.getAttribute("aria-busy")).toBe("true");
    expect(within(inspector).getByRole("heading", { name: "Loading selected item…" })).toBeTruthy();
    expect(within(inspector).getByText("cold-route-id")).toBeTruthy();
    expect(within(inspector).queryByText(/Work item|Active/)).toBeNull();
    expect(within(inspector).getByRole("status").textContent).toBe("Loading selected item…");
  });

  test("reports bounded loading and error states with an exact Retry action", async () => {
    const retry = vi.fn();
    const view = renderInspector({ status: "loading" });
    expect(screen.getByRole("heading", { name: "Ship accessible map" })).toBeTruthy();
    expect(screen.getByRole("status").textContent)
      .toBe("Loading Ship accessible map details…");

    view.rerender(
      <div className="project-map__canvas-shell">
        <div className="project-map-camera__viewport" />
        <ProjectMapInspector
          detailState={{ status: "error", message: "Detail unavailable.", onRetry: retry }}
          onClose={view.onClose}
          onFocusBranch={view.onFocusBranch}
          onNavigateAttachment={view.onNavigateAttachment}
          onOcclusionInsetsChange={view.onOcclusionInsetsChange}
          onSelectRelated={view.onSelectRelated}
          routeRecordId="task-one"
          scopeRecordId={null}
          selected={selected}
        />
      </div>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Detail unavailable.");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("routes ordinary attachment clicks through the app while preserving native modified clicks", () => {
    const view = renderInspector({ status: "ready", detail });
    const repository = screen.getByRole("link", { name: "Repository" });
    const documentation = screen.getByRole("link", { name: "Documentation" });

    const primaryClick = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    expect(repository.dispatchEvent(primaryClick)).toBe(false);
    expect(primaryClick.defaultPrevented).toBe(true);
    expect(view.onNavigateAttachment).toHaveBeenCalledWith(
      "/projects/project-one/repository?nodeId=node-one",
    );

    const documentationPrimaryClick = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    expect(documentation.dispatchEvent(documentationPrimaryClick)).toBe(false);
    expect(view.onNavigateAttachment).toHaveBeenLastCalledWith(
      "/projects/project-one/documentation/node-one",
    );

    view.onNavigateAttachment.mockClear();
    documentation.setAttribute("target", "_blank");
    const newTabClick = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    expect(documentation.dispatchEvent(newTabClick)).toBe(true);
    expect(newTabClick.defaultPrevented).toBe(false);
    expect(view.onNavigateAttachment).not.toHaveBeenCalled();

    const modifiedClick = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      ctrlKey: true,
    });
    expect(documentation.dispatchEvent(modifiedClick)).toBe(true);
    expect(modifiedClick.defaultPrevented).toBe(false);
    expect(view.onNavigateAttachment).not.toHaveBeenCalled();

    const nonPrimaryClick = new MouseEvent("click", {
      bubbles: true,
      button: 1,
      cancelable: true,
    });
    expect(documentation.dispatchEvent(nonPrimaryClick)).toBe(true);
    expect(nonPrimaryClick.defaultPrevented).toBe(false);
    expect(view.onNavigateAttachment).not.toHaveBeenCalled();
  });

  test("renders ready detail without a same-route Open link and dispatches contextual actions", async () => {
    const user = userEvent.setup();
    const view = renderInspector({ status: "ready", detail });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });

    expect(within(inspector).getByText("Keep hierarchy and evidence readable.")).toBeTruthy();
    expect(within(inspector).queryByRole("link", { name: "Open" })).toBeNull();
    await user.click(within(inspector).getByRole("button", { name: "Focus branch" }));
    await user.click(within(inspector).getByRole("button", { name: "Select related Verify responsive sheet" }));
    expect(view.onFocusBranch).toHaveBeenCalledWith("task-one");
    expect(view.onSelectRelated).toHaveBeenCalledWith("task-two");
  });

  test("measures wide right-edge occlusion without taking a layout column", () => {
    const view = renderInspector({ status: "ready", detail });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });

    expect(inspector.dataset.layout).toBe("wide");
    expect(inspector.parentElement?.classList.contains("project-map__canvas-shell")).toBe(true);
    expect(view.onOcclusionInsetsChange).toHaveBeenLastCalledWith({
      top: 0, right: 400, bottom: 0, left: 0,
    });
  });

  test("remeasures wide occlusion when Focus branch changes the scope in place", () => {
    const view = renderInspector({ status: "ready", detail });
    view.onOcclusionInsetsChange.mockClear();
    wideInspectorLeft = 520;

    view.rerender(
      <div className="project-map__canvas-shell">
        <div className="project-map-camera__viewport" />
        <ProjectMapInspector
          detailState={{ status: "ready", detail }}
          onClose={view.onClose}
          onFocusBranch={view.onFocusBranch}
          onNavigateAttachment={view.onNavigateAttachment}
          onOcclusionInsetsChange={view.onOcclusionInsetsChange}
          onSelectRelated={view.onSelectRelated}
          routeRecordId="task-one"
          scopeRecordId="task-one"
          selected={selected}
        />
      </div>,
    );

    expect(view.onOcclusionInsetsChange).toHaveBeenLastCalledWith({
      top: 0, right: 480, bottom: 0, left: 0,
    });
  });

  test("republishes mounted occlusion after StrictMode replays layout effects", () => {
    const onOcclusionInsetsChange = vi.fn();
    render(
      <StrictMode>
        <div className="project-map__canvas-shell">
          <div className="project-map-camera__viewport" />
          <ProjectMapInspector
            detailState={{ status: "ready", detail }}
            onClose={vi.fn()}
            onFocusBranch={vi.fn()}
            onNavigateAttachment={vi.fn()}
            onOcclusionInsetsChange={onOcclusionInsetsChange}
            onSelectRelated={vi.fn()}
            routeRecordId="task-one"
            scopeRecordId={null}
            selected={selected}
          />
        </div>
      </StrictMode>,
    );

    expect(onOcclusionInsetsChange).toHaveBeenLastCalledWith({
      top: 0, right: 400, bottom: 0, left: 0,
    });
    expect(onOcclusionInsetsChange).toHaveBeenCalledTimes(3);
  });

  test("bounds the narrow sheet, scrolls its body, keeps controls sticky, and collapses to 56px", async () => {
    narrow = true;
    const user = userEvent.setup();
    const view = renderInspector({ status: "ready", detail });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    const body = within(inspector).getByRole("region", { name: "Selected item detail content" });
    const collapse = within(inspector).getByRole("button", { name: "Collapse details" });

    expect(inspector.dataset.layout).toBe("narrow");
    expect(inspector.style.getPropertyValue("--project-map-inspector-camera-height")).toBe("700px");
    expect(body.classList.contains("project-map-inspector__body")).toBe(true);
    expect(within(inspector).getByTestId("project-map-inspector-header").classList
      .contains("project-map-inspector__header")).toBe(true);
    expect(364).toBeLessThanOrEqual(700 * 0.6);
    expect(view.onOcclusionInsetsChange).toHaveBeenLastCalledWith({
      top: 0, right: 0, bottom: 364, left: 0,
    });

    await user.click(collapse);
    expect(inspector.dataset.collapsed).toBe("true");
    expect(document.activeElement).toBe(collapse);
    expect(body.hidden).toBe(true);
    expect(view.onOcclusionInsetsChange).toHaveBeenLastCalledWith({
      top: 0, right: 0, bottom: 56, left: 0,
    });
  });

  test("Close and Escape dismiss once while Tab and outside wheel remain untrapped", async () => {
    narrow = true;
    const user = userEvent.setup();
    const view = renderInspector({ status: "ready", detail });
    const inspector = screen.getByRole("complementary", { name: "Selected item details" });
    const close = within(inspector).getByRole("button", { name: "Close details" });

    close.focus();
    const afterInspector = screen.getByRole("button", { name: "After inspector" });
    for (let step = 0; step < 8 && document.activeElement !== afterInspector; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(afterInspector);
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    afterInspector.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);

    fireEvent.keyDown(inspector, { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledTimes(1);
    await user.click(close);
    expect(view.onClose).toHaveBeenCalledTimes(2);
  });

  test("remeasures when the observed sheet geometry changes", () => {
    narrow = true;
    const view = renderInspector({ status: "ready", detail });
    view.onOcclusionInsetsChange.mockClear();
    narrowExpandedTop = 360;
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(view.onOcclusionInsetsChange).toHaveBeenCalledWith({
      top: 0, right: 0, bottom: 340, left: 0,
    });
  });
});
