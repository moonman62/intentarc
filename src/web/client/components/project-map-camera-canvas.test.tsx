// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProjectMapCameraCanvas } from "./project-map-camera-canvas.js";

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

let viewport = { width: 1000, height: 700 };
let content = { x: 100, y: 50, width: 1600, height: 800 };
let contentBoundsByRecordId = new Map<string, typeof content>();
let connectorPathBounds: typeof content | null = null;
let renderedWorldCamera: { scale: number; x: number; y: number } | null = null;
let renderWorldAsMatrix3d = false;
let renderedWorldTransformOverride: string | null = null;
let worldFloor: { width: number; height: number } | null = null;
let resizeObservers: ResizeObserverProbe[] = [];
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
let animationFrameCancellationCanRace = false;
let capturedPointers = new Set<number>();
let setPointerCapture: ReturnType<typeof vi.fn>;
let releasePointerCapture: ReturnType<typeof vi.fn>;

interface ResizeObserverProbe {
  readonly callback: ResizeObserverCallback;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
}

function flushAnimationFrames() {
  act(() => {
    const frames = [...animationFrames.values()];
    animationFrames.clear();
    for (const frame of frames) frame(0);
  });
}

function triggerResizeObservers() {
  act(() => {
    for (const observer of resizeObservers) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
  });
  flushAnimationFrames();
}

function cameraState(viewportElement: HTMLElement) {
  return {
    scale: Number(viewportElement.dataset.cameraScale),
    x: Number(viewportElement.dataset.cameraX),
    y: Number(viewportElement.dataset.cameraY),
  };
}

function worldPointAt(viewportElement: HTMLElement, point: { readonly x: number; readonly y: number }) {
  const camera = cameraState(viewportElement);
  return {
    x: (point.x - camera.x) / camera.scale,
    y: (point.y - camera.y) / camera.scale,
  };
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: PointerEventInit & { readonly pointerId: number; readonly pointerType: string },
) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

function dispatchKey(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
  act(() => target.dispatchEvent(event));
  return event;
}

function Harness({
  activeRootId = "project-a",
  children = (
    <article data-camera-content data-connector-record-id="project-a">
      Project hierarchy
    </article>
  ),
  fitRequestKey = 0,
  focusRequestKey = 0,
  layoutRevision = "layout-a",
  measuredLayoutRevision = layoutRevision,
  occlusionInsets = { top: 0, right: 0, bottom: 0, left: 0 },
  projectId = "project-a",
  revealRecordId = null,
  scopeRecordId = null,
  structuralLayoutRevision = "structure-a",
}: {
  readonly activeRootId?: string;
  readonly children?: ReactNode;
  readonly fitRequestKey?: number;
  readonly focusRequestKey?: number;
  readonly layoutRevision?: string;
  readonly measuredLayoutRevision?: number | string;
  readonly occlusionInsets?: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly projectId?: string;
  readonly revealRecordId?: string | null;
  readonly scopeRecordId?: string | null;
  readonly structuralLayoutRevision?: number | string;
}) {
  return (
    <ProjectMapCameraCanvas
      activeRootId={activeRootId}
      ariaLabel="Project map"
      fitRequestKey={fitRequestKey}
      focusRequestKey={focusRequestKey}
      layoutRevision={layoutRevision}
      measuredLayoutRevision={measuredLayoutRevision}
      occlusionInsets={occlusionInsets}
      projectId={projectId}
      revealRecordId={revealRecordId}
      scopeRecordId={scopeRecordId}
      structuralLayoutRevision={structuralLayoutRevision}
    >
      {children}
    </ProjectMapCameraCanvas>
  );
}

beforeEach(() => {
  viewport = { width: 1000, height: 700 };
  content = { x: 100, y: 50, width: 1600, height: 800 };
  contentBoundsByRecordId = new Map();
  connectorPathBounds = null;
  renderedWorldCamera = null;
  renderWorldAsMatrix3d = false;
  renderedWorldTransformOverride = null;
  worldFloor = null;
  resizeObservers = [];
  animationFrames = new Map();
  nextAnimationFrame = 1;
  animationFrameCancellationCanRace = false;
  capturedPointers = new Set();
  setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
  releasePointerCapture = vi.fn((pointerId: number) => capturedPointers.delete(pointerId));
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: setPointerCapture,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: releasePointerCapture,
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
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    if (!animationFrameCancellationCanRace) animationFrames.delete(id);
  });
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
  const actualGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
    if (element.hasAttribute("data-camera-world") && renderedWorldTransformOverride !== null) {
      return { transform: renderedWorldTransformOverride } as CSSStyleDeclaration;
    }
    if (element.hasAttribute("data-camera-world") && renderedWorldCamera !== null) {
      return {
        transform: renderWorldAsMatrix3d
          ? `matrix3d(${renderedWorldCamera.scale}, 0, 0, 0, 0, ${renderedWorldCamera.scale}, 0, 0, 0, 0, 1, 0, ${renderedWorldCamera.x}, ${renderedWorldCamera.y}, 0, 1)`
          : `matrix(${renderedWorldCamera.scale}, 0, 0, ${renderedWorldCamera.scale}, ${renderedWorldCamera.x}, ${renderedWorldCamera.y})`,
      } as CSSStyleDeclaration;
    }
    return actualGetComputedStyle(element, pseudoElement);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return this.classList.contains("project-map-camera__viewport") ? viewport.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
    return this.classList.contains("project-map-camera__viewport") ? viewport.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? (worldFloor?.width ?? content.width) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
    return this.hasAttribute("data-camera-world") ? (worldFloor?.height ?? content.height) : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    const world = this.closest<HTMLElement>("[data-camera-world]");
    const transform = world?.style.transform.match(
      /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/,
    );
    const x = renderedWorldCamera?.x ?? Number(transform?.[1] ?? 0);
    const y = renderedWorldCamera?.y ?? Number(transform?.[2] ?? 0);
    const scale = renderedWorldCamera?.scale ?? Number(transform?.[3] ?? 1);
    if (this.matches("path[data-connector-id]") && connectorPathBounds !== null) {
      return rectangle(
        x + connectorPathBounds.x * scale,
        y + connectorPathBounds.y * scale,
        connectorPathBounds.width * scale,
        connectorPathBounds.height * scale,
      );
    }
    if (this.matches("svg.project-map-connectors") && worldFloor !== null) {
      return rectangle(x, y, worldFloor.width * scale, worldFloor.height * scale);
    }
    return rectangle(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.hasAttribute("data-camera-world")) {
      const transform = this.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/);
      return rectangle(
        renderedWorldCamera?.x ?? Number(transform?.[1] ?? 0),
        renderedWorldCamera?.y ?? Number(transform?.[2] ?? 0),
        0,
        0,
      );
    }
    if (this.hasAttribute("data-camera-content")) {
      const world = this.parentElement!;
      const transform = world.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/);
      const x = renderedWorldCamera?.x ?? Number(transform?.[1] ?? 0);
      const y = renderedWorldCamera?.y ?? Number(transform?.[2] ?? 0);
      const scale = renderedWorldCamera?.scale ?? Number(transform?.[3] ?? 1);
      const measuredContent = contentBoundsByRecordId.get(
        this.getAttribute("data-connector-record-id") ?? "",
      ) ?? content;
      return rectangle(
        x + measuredContent.x * scale,
        y + measuredContent.y * scale,
        measuredContent.width * scale,
        measuredContent.height * scale,
      );
    }
    return rectangle(0, 0, 0, 0);
  });
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProjectMapCameraCanvas", () => {
  test("starts cold whole-project and scoped roots at 100% with exact usable placement", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const insets = { top: 24, right: 300, bottom: 12, left: 20 };
    const whole = render(<Harness occlusionInsets={insets} />);
    flushAnimationFrames();
    expect(cameraState(whole.container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: 30, y: -24 });
    expect(screen.getByRole("button", { name: "Fit project" })).toBeTruthy();
    whole.unmount();

    cleanup();
    const scoped = render(
      <Harness
        activeRootId="branch-a"
        occlusionInsets={insets}
        projectId="project-b"
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(cameraState(scoped.container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: 30, y: -24 });
    expect(screen.getByRole("button", { name: "Fit branch" })).toBeTruthy();
  });

  test("replays cold selected scoped placement when the inspector safe area arrives", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const { container, rerender } = render(
      <Harness
        activeRootId="branch-a"
        projectId="project-b"
        revealRecordId="branch-a"
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 170, y: -48 });

    rerender(
      <Harness
        activeRootId="branch-a"
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
        projectId="project-b"
        revealRecordId="branch-a"
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 30, y: -24 });
  });

  test("keeps a scope-only camera passive when ordinary selection publishes inspector insets", () => {
    content = { x: 0, y: 0, width: 2200, height: 1200 };
    contentBoundsByRecordId.set("branch-a", { x: 0, y: 0, width: 100, height: 80 });
    contentBoundsByRecordId.set("selected", { x: 1500, y: 300, width: 100, height: 80 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="selected">Selected</article>
      </>
    );
    const { container, rerender } = render(
      <Harness activeRootId="branch-a" scopeRecordId="branch-a">{children}</Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 450, y: 32 });

    rerender(
      <Harness
        activeRootId="branch-a"
        occlusionInsets={{ top: 0, right: 300, bottom: 0, left: 0 }}
        revealRecordId="selected"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -900, y: 32 });
  });

  test("replays initial root placement once when authoritative layout settles without a time limit", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", { x: 240, y: 780, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(
      <Harness activeRootId="branch-a" layoutRevision="layout-provisional">
        {children}
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 130, y: -748 });

    act(() => vi.advanceTimersByTime(1_000));
    contentBoundsByRecordId.set("branch-a", { x: 640, y: 180, width: 260, height: 120 });
    rerender(
      <Harness activeRootId="branch-a" layoutRevision="layout-authoritative">
        {children}
      </Harness>,
    );
    flushAnimationFrames();

    const authoritativePlacement = { scale: 1, x: -270, y: -148 };
    expect(cameraState(viewportElement)).toEqual(authoritativePlacement);

    contentBoundsByRecordId.set("branch-a", { x: 900, y: 420, width: 260, height: 120 });
    rerender(
      <Harness activeRootId="branch-a" layoutRevision="layout-later">
        {children}
      </Harness>,
    );
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual(authoritativePlacement);
  });

  test("preserves camera when expansion replaces the initial structural generation", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", { x: 640, y: 180, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(
      <Harness
        activeRootId="branch-a"
        layoutRevision="structure-collapsed:1"
        measuredLayoutRevision={1}
        structuralLayoutRevision="structure-collapsed"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const authoritativeCamera = { scale: 1, x: -270, y: -148 };
    expect(cameraState(viewportElement)).toEqual(authoritativeCamera);

    contentBoundsByRecordId.set("branch-a", { x: 240, y: 780, width: 260, height: 120 });
    rerender(
      <Harness
        activeRootId="branch-a"
        layoutRevision="structure-expanded:2"
        measuredLayoutRevision={2}
        structuralLayoutRevision="structure-expanded"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual(authoritativeCamera);
  });

  test.each(["direct camera", "Fit", "resize"] as const)(
    "lets %s supersede pending initial layout placement",
    (supersedingAction) => {
      content = { x: 0, y: 0, width: 2200, height: 1600 };
      contentBoundsByRecordId.set("branch-child", {
        x: 0, y: 0, width: 2200, height: 1600,
      });
      contentBoundsByRecordId.set("branch-a", {
        x: 240, y: 780, width: 260, height: 120,
      });
      const children = (
        <>
          <article data-camera-content data-connector-record-id="branch-a">Branch</article>
          <article data-camera-content data-connector-record-id="branch-child">Child</article>
        </>
      );
      const { container, rerender } = render(
        <Harness activeRootId="branch-a" layoutRevision="layout-provisional">
          {children}
        </Harness>,
      );
      flushAnimationFrames();
      const viewportElement = container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!;

      if (supersedingAction === "direct camera") {
        act(() => screen.getByRole("button", { name: "Zoom in" }).click());
      } else if (supersedingAction === "Fit") {
        act(() => screen.getByRole("button", { name: "Fit project" }).click());
        flushAnimationFrames();
      } else {
        viewport = { width: 800, height: 600 };
        act(() => window.dispatchEvent(new Event("resize")));
        flushAnimationFrames();
      }
      const afterSupersedingAction = cameraState(viewportElement);
      if (supersedingAction === "direct camera") {
        expect(afterSupersedingAction.scale).toBeCloseTo(1.1);
      } else if (supersedingAction === "Fit") {
        expect(afterSupersedingAction).toEqual({ scale: 0.5, x: -50, y: -50 });
      } else {
        expect(afterSupersedingAction).toEqual({ scale: 1, x: 30, y: -798 });
      }

      contentBoundsByRecordId.set("branch-a", {
        x: 640, y: 180, width: 260, height: 120,
      });
      rerender(
        <Harness activeRootId="branch-a" layoutRevision="layout-authoritative">
          {children}
        </Harness>,
      );
      flushAnimationFrames();

      expect(cameraState(viewportElement)).toEqual(afterSupersedingAction);
    },
  );

  test("owns initial layout replay by the newest project generation", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-a", { x: 240, y: 780, width: 260, height: 120 });
    const { container, rerender } = render(
      <Harness activeRootId="branch-a" layoutRevision="project-a-provisional">
        <article data-camera-content data-connector-record-id="branch-a">Branch A</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;

    contentBoundsByRecordId = new Map([
      ["branch-b", { x: 100, y: 600, width: 200, height: 100 }],
    ]);
    rerender(
      <Harness
        activeRootId="branch-b"
        layoutRevision="project-b-provisional"
        projectId="project-b"
      >
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 300, y: -568 });

    contentBoundsByRecordId.set("branch-b", { x: 500, y: 200, width: 200, height: 100 });
    rerender(
      <Harness
        activeRootId="branch-b"
        layoutRevision="project-b-authoritative"
        projectId="project-b"
      >
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -100, y: -168 });
  });

  test("warm Focus branch preserves scale and uses the exact safe-area root placement", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    act(() => {
      screen.getByRole("button", { name: "Zoom in" }).click();
      screen.getByRole("button", { name: "Zoom in" }).click();
      screen.getByRole("button", { name: "Zoom in" }).click();
    });
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement).scale).toBeCloseTo(1.3);

    content = { x: 240, y: 180, width: 260, height: 120 };
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="layout-b"
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
      </Harness>,
    );
    flushAnimationFrames();

    const focused = cameraState(viewportElement);
    expect(focused.scale).toBeCloseTo(1.3);
    expect(focused.x).toBeCloseTo(-121);
    expect(focused.y).toBeCloseTo(-178);
  });

  test("replays a warm Focus placement when scoped layout measurement settles", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    act(() => {
      screen.getByRole("button", { name: "Zoom in" }).click();
      screen.getByRole("button", { name: "Zoom in" }).click();
      screen.getByRole("button", { name: "Zoom in" }).click();
    });
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement).scale).toBeCloseTo(1.3);

    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 780, width: 260, height: 120,
    });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-provisional"
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(cameraState(viewportElement).scale).toBeCloseTo(1.3);
    act(() => vi.advanceTimersByTime(1_000));
    expect(cameraState(viewportElement).scale).toBeCloseTo(1.3);

    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 180, width: 260, height: 120,
    });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-measured"
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </Harness>,
    );
    flushAnimationFrames();

    const focused = cameraState(viewportElement);
    expect(focused.scale).toBeCloseTo(1.3);
    expect(focused.x).toBeCloseTo(-121);
    expect(focused.y).toBeCloseTo(-178);

    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 420, width: 260, height: 120,
    });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-later-unrelated"
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
        scopeRecordId="branch-a"
      >
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual(focused);
  });

  test("preserves a settled Focus camera across a new structural layout generation", () => {
    // Production mutation caught: owning a pending Focus replay by only the
    // combined layout revision lets expansion/collapse masquerade as late
    // measurement settling and recenter an already-settled camera.
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 780, width: 260, height: 120,
    });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;

    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="structure-collapsed:7"
        measuredLayoutRevision={7}
        scopeRecordId="branch-a"
        structuralLayoutRevision="structure-collapsed"
      >{children}</Harness>,
    );
    flushAnimationFrames();
    const settledFocus = cameraState(viewportElement);

    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 180, width: 260, height: 120,
    });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="structure-expanded:8"
        measuredLayoutRevision={8}
        scopeRecordId="branch-a"
        structuralLayoutRevision="structure-expanded"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual(settledFocus);
  });

  test("cancels pending Focus replay after direct camera interaction", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 780, width: 260, height: 120,
    });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-provisional"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();
    act(() => screen.getByRole("button", { name: "Zoom in" }).click());
    const afterZoom = cameraState(viewportElement);

    contentBoundsByRecordId.set("branch-a", {
      x: 240, y: 180, width: 260, height: 120,
    });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-measured"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual(afterZoom);
  });

  test("cancels a stale Focus replay when scope is replaced without a new request", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-a", { x: 200, y: 400, width: 200, height: 100 });
    contentBoundsByRecordId.set("branch-b", { x: 900, y: 200, width: 200, height: 100 });
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch A</article>
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-a-provisional"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();
    const focusedA = cameraState(viewportElement);

    rerender(
      <Harness
        activeRootId="branch-b"
        focusRequestKey={1}
        layoutRevision="scope-b-measured"
        scopeRecordId="branch-b"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual(focusedA);
  });

  test("replaces a pending replay with the newest Focus request generation", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", { x: 200, y: 700, width: 200, height: 100 });
    contentBoundsByRecordId.set("branch-b", { x: 900, y: 800, width: 200, height: 100 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch A</article>
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;

    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-a-provisional"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();
    rerender(
      <Harness
        activeRootId="branch-b"
        focusRequestKey={2}
        layoutRevision="scope-b-provisional"
        scopeRecordId="branch-b"
      >{children}</Harness>,
    );
    flushAnimationFrames();
    act(() => vi.advanceTimersByTime(1_000));

    contentBoundsByRecordId.set("branch-b", { x: 900, y: 200, width: 200, height: 100 });
    rerender(
      <Harness
        activeRootId="branch-b"
        focusRequestKey={2}
        layoutRevision="scope-b-measured"
        scopeRecordId="branch-b"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -500, y: -168 });
  });

  test("executes toolbar Fit and cancels Focus replay behind its queued frame", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", { x: 240, y: 780, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(
      <Harness activeRootId="branch-a">{children}</Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;

    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-provisional"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    expect(animationFrames.size).toBeGreaterThan(0);
    const fitBranch = screen.getByRole("button", { name: "Fit branch" });
    expect(fitBranch.disabled).toBe(false);
    act(() => fitBranch.click());
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: -50, y: -50 });

    contentBoundsByRecordId.set("branch-a", { x: 240, y: 180, width: 260, height: 120 });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-measured"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: -50, y: -50 });
  });

  test("executes resize policy and cancels Focus replay behind its queued frame", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    contentBoundsByRecordId.set("branch-child", {
      x: 0, y: 0, width: 2200, height: 1600,
    });
    contentBoundsByRecordId.set("branch-a", { x: 240, y: 780, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="branch-a">Branch</article>
        <article data-camera-content data-connector-record-id="branch-child">Child</article>
      </>
    );
    const { container, rerender } = render(
      <Harness activeRootId="branch-a">{children}</Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;

    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-provisional"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    expect(animationFrames.size).toBeGreaterThan(0);
    viewport = { width: 800, height: 600 };
    act(() => window.dispatchEvent(new Event("resize")));
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 30, y: -798 });

    contentBoundsByRecordId.set("branch-a", { x: 240, y: 180, width: 260, height: 120 });
    rerender(
      <Harness
        activeRootId="branch-a"
        focusRequestKey={1}
        layoutRevision="scope-measured"
        scopeRecordId="branch-a"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 30, y: -798 });
  });

  test("shows truthful pan affordances, visible instructions, and limited-fit status", () => {
    content = { x: 0, y: 0, width: 4000, height: 3000 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(viewportElement.dataset.cameraPannable).toBe("true");
    expect(screen.queryByRole("group", { name: "Map pan controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move map" })).toBeTruthy();
    expect(screen.getByText(
      "Focused canvas — Pan: drag empty space, Space-drag, middle-drag, or arrow keys · Zoom: wheel/trackpad, pinch, Plus (+) or Equals (=) in, Minus (-) or Underscore (_) out · F fits.",
    )).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Fit project" }).click());
    flushAnimationFrames();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("50%");
    expect(screen.getByText("Overview limited to 50%")).toBeTruthy();

    for (let index = 0; index < 100; index += 1) {
      dispatchKey(viewportElement, "ArrowLeft");
      dispatchKey(viewportElement, "ArrowUp");
    }
    act(() => screen.getByRole("button", { name: "Move map" }).click());
    const directions = screen.getByRole("group", { name: "Move map directions" });
    expect(within(directions).getByRole("button", { name: "Pan left" }).hasAttribute("disabled")).toBe(true);
    expect(within(directions).getByRole("button", { name: "Pan up" }).hasAttribute("disabled")).toBe(true);
    expect(within(directions).getByRole("button", { name: "Pan right" }).hasAttribute("disabled")).toBe(false);
    expect(within(directions).getByRole("button", { name: "Pan down" }).hasAttribute("disabled")).toBe(false);

    for (let index = 0; index < 200; index += 1) {
      dispatchKey(viewportElement, "ArrowRight");
      dispatchKey(viewportElement, "ArrowDown");
    }
    expect(within(directions).getByRole("button", { name: "Pan right" }).hasAttribute("disabled")).toBe(true);
    expect(within(directions).getByRole("button", { name: "Pan down" }).hasAttribute("disabled")).toBe(true);
    expect(within(directions).getByRole("button", { name: "Pan left" }).hasAttribute("disabled")).toBe(false);
    expect(within(directions).getByRole("button", { name: "Pan up" }).hasAttribute("disabled")).toBe(false);
  });

  test("describes every focused-canvas keyboard control from aria-describedby", () => {
    content = { x: 0, y: 0, width: 4000, height: 3000 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const instructionsId = viewportElement.getAttribute("aria-describedby");

    expect(instructionsId).toBeTruthy();
    const describedText = document.getElementById(instructionsId!)?.textContent;
    expect(describedText).toContain("Plus (+) or Equals (=) in");
    expect(describedText).toContain("Minus (-) or Underscore (_) out");
    expect(describedText).toContain("F fits");
    expect(describedText).toContain("arrow keys");
  });

  test("drags fitted content and Fit restores its canonical transform", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 200, y: 80, width: 260, height: 120 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const camera = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const surface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const initial = cameraState(camera);

    expect(camera.dataset.cameraPannable).toBe("true");
    expect(screen.queryByRole("group", { name: "Map pan controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move map" })).toBeTruthy();

    dispatchPointer(surface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 301, pointerType: "mouse",
    });
    dispatchPointer(camera, "pointermove", {
      buttons: 1, clientX: 100, clientY: 180,
      pointerId: 301, pointerType: "mouse",
    });
    dispatchPointer(camera, "pointerup", {
      button: 0, buttons: 0, clientX: 100, clientY: 180,
      pointerId: 301, pointerType: "mouse",
    });
    expect(cameraState(camera).y - initial.y).toBe(80);

    act(() => screen.getByRole("button", { name: "Fit project" }).click());
    flushAnimationFrames();
    act(() => vi.advanceTimersByTime(140));
    const canonical = cameraState(camera);
    expect(canonical).toEqual({ scale: 1.5, x: 5, y: -88 });
    dispatchPointer(surface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 180,
      pointerId: 302, pointerType: "mouse",
    });
    dispatchPointer(camera, "pointermove", {
      buttons: 1, clientX: 100, clientY: 100,
      pointerId: 302, pointerType: "mouse",
    });
    dispatchPointer(camera, "pointerup", {
      button: 0, buttons: 0, clientX: 100, clientY: 100,
      pointerId: 302, pointerType: "mouse",
    });
    expect(cameraState(camera).y - canonical.y).toBe(-80);
    act(() => screen.getByRole("button", { name: "Fit project" }).click());
    flushAnimationFrames();
    expect(cameraState(camera)).toEqual({ scale: 1.5, x: 5, y: -88 });
  });

  test("discloses accessible Move map directions and dismisses outside without stealing action or focus", async () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const outsideAction = vi.fn();
    render(<><Harness /><button onClick={outsideAction}>Outside action</button></>);
    flushAnimationFrames();
    const trigger = screen.getByRole("button", { name: "Move map" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Move map directions" })).toBeNull();
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const directions = screen.getByRole("group", { name: "Move map directions" });
    expect(trigger.getAttribute("aria-controls")).toBe(directions.id);
    expect(within(directions).getAllByRole("button")).toHaveLength(4);

    const outside = screen.getByRole("button", { name: "Outside action" });
    await userEvent.click(outside);
    expect(outsideAction).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outside);
    expect(screen.queryByRole("group", { name: "Move map directions" })).toBeNull();
  });

  test("Escape closes Move map directions and restores focus to its trigger", async () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    render(<Harness />);
    flushAnimationFrames();
    const trigger = screen.getByRole("button", { name: "Move map" });
    await userEvent.click(trigger);
    const direction = within(screen.getByRole("group", { name: "Move map directions" }))
      .getByRole("button", { name: "Pan right" });
    direction.focus();

    const escape = dispatchKey(direction, "Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByRole("group", { name: "Move map directions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("adapts visible camera instructions for touch-only input", () => {
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
    } as MediaQueryList));
    render(<Harness />);
    flushAnimationFrames();

    expect(screen.getByText(
      "Focused canvas — Pan: drag or arrow keys · Zoom: pinch, Plus (+) or Equals (=) in, Minus (-) or Underscore (_) out · F fits.",
    )).toBeTruthy();
    expect(screen.queryByText(/Space-drag over the map/)).toBeNull();
  });

  test("keeps the fitted Move map trigger collapsed until requested", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(viewportElement.dataset.cameraPannable).toBe("true");
    expect(screen.queryByRole("group", { name: "Map pan controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move map" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("group", { name: "Move map directions" })).toBeNull();
  });

  test("keeps fitted card activation isolated from primary empty-space drag", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const onClick = vi.fn();
    const { container } = render(
      <Harness>
        <article
          data-camera-content
          data-connector-record-id="project-a"
          onClick={onClick}
          role="treeitem"
        >Card</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const card = screen.getByRole("treeitem");

    expect(viewportElement.dataset.cameraPannable).toBe("true");
    expect(screen.getByRole("button", { name: "Move map" }).hasAttribute("disabled")).toBe(false);
    expect(panSurface.style.touchAction).toBe("none");

    dispatchPointer(card, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 94, pointerType: "mouse",
    });
    dispatchPointer(card, "pointermove", {
      buttons: 1, clientX: 120, clientY: 100,
      pointerId: 94, pointerType: "mouse",
    });
    expect(setPointerCapture).not.toHaveBeenCalledWith(94);
    act(() => card.click());
    expect(onClick).toHaveBeenCalledOnce();

    dispatchPointer(panSurface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 95, pointerType: "mouse",
    });
    dispatchPointer(panSurface, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100,
      pointerId: 95, pointerType: "mouse",
    });
    expect(setPointerCapture).toHaveBeenCalledWith(95);
    expect(viewportElement.dataset.cameraDragging).toBe("true");
  });

  test("pans fitted content with one touch and reserves two touches for camera zoom", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const initial = cameraState(viewportElement);

    const oneTouchDown = dispatchPointer(panSurface, "pointerdown", {
      clientX: 200, clientY: 200, pointerId: 101, pointerType: "touch",
    });
    dispatchPointer(panSurface, "pointermove", {
      clientX: 220, clientY: 200, pointerId: 101, pointerType: "touch",
    });
    expect(oneTouchDown.defaultPrevented).toBe(false);
    expect(setPointerCapture).toHaveBeenCalledWith(101);
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    expect(cameraState(viewportElement).x).toBe(initial.x + 20);
    dispatchPointer(panSurface, "pointerup", {
      clientX: 220, clientY: 200, pointerId: 101, pointerType: "touch",
    });

    dispatchPointer(panSurface, "pointerdown", {
      clientX: 200, clientY: 200, pointerId: 102, pointerType: "touch",
    });
    dispatchPointer(panSurface, "pointerdown", {
      clientX: 400, clientY: 200, pointerId: 103, pointerType: "touch",
    });
    dispatchPointer(panSurface, "pointermove", {
      clientX: 500, clientY: 200, pointerId: 103, pointerType: "touch",
    });

    expect(setPointerCapture).toHaveBeenCalledWith(102);
    expect(setPointerCapture).toHaveBeenCalledWith(103);
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    expect(cameraState(viewportElement).scale).toBe(1.5);
    expect(panSurface.style.touchAction).toBe("none");
  });

  test("publishes changed layout truth when bounds change without changing camera coordinates", () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const children = (
      <article data-camera-content data-connector-record-id="project-a">
        Project hierarchy
      </article>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const fit = screen.getByRole("button", { name: "Fit project" });
    act(() => fit.click());
    flushAnimationFrames();
    const fittedCamera = cameraState(viewportElement);
    expect(fit.hasAttribute("disabled")).toBe(true);
    expect(viewportElement.dataset.cameraPannable).toBe("true");

    contentBoundsByRecordId.set("record-b", {
      x: -500,
      y: -300,
      width: 2000,
      height: 1400,
    });
    rerender(
      <Harness layoutRevision="layout-expanded">
        {children}
        <article data-camera-content data-connector-record-id="record-b">New branch</article>
      </Harness>,
    );

    expect(cameraState(viewportElement)).toEqual(fittedCamera);
    expect(viewportElement.dataset.cameraPannable).toBe("true");
    expect(screen.getByRole("button", { name: "Move map" })).toBeTruthy();
    expect(fit.hasAttribute("disabled")).toBe(false);
  });

  test("preserves raw transform while clamping an undersized layout into fitted reachability", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const children = (
      <article data-camera-content data-connector-record-id="project-a">
        Project hierarchy
      </article>
    );
    const { container, rerender } = render(
      <Harness
        layoutRevision="structure-expanded:1"
        measuredLayoutRevision={1}
        structuralLayoutRevision="structure-expanded"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    act(() => screen.getByRole("button", { name: "Fit project" }).click());
    flushAnimationFrames();
    const fittedCamera = { scale: 0.5, x: -50, y: -50 };
    expect(cameraState(viewportElement)).toEqual(fittedCamera);

    content = { x: 200, y: 80, width: 260, height: 120 };
    rerender(
      <Harness
        layoutRevision="structure-collapsed:2"
        measuredLayoutRevision={2}
        structuralLayoutRevision="structure-collapsed"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: 239, y: -50 });
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    dispatchPointer(panSurface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 303, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 128, clientY: 116,
      pointerId: 303, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointerup", {
      button: 0, buttons: 0, clientX: 128, clientY: 116,
      pointerId: 303, pointerType: "mouse",
    });
    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: 267, y: -34 });
  });

  test("minimally restores a reachability grip when structural layout removes all visible content", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const children = (
      <article data-camera-content data-connector-record-id="project-a">
        Project hierarchy
      </article>
    );
    const { container, rerender } = render(
      <Harness
        layoutRevision="structure-expanded:1"
        measuredLayoutRevision={1}
        structuralLayoutRevision="structure-expanded"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    act(() => screen.getByRole("button", { name: "Fit project" }).click());
    flushAnimationFrames();

    for (let index = 0; index < 100; index += 1) {
      dispatchKey(viewportElement, "ArrowRight");
      dispatchKey(viewportElement, "ArrowDown");
    }
    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: -1052, y: -752 });

    content = { x: 200, y: 80, width: 260, height: 120 };
    rerender(
      <Harness
        layoutRevision="structure-collapsed:2"
        measuredLayoutRevision={2}
        structuralLayoutRevision="structure-collapsed"
      >
        {children}
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: 239, y: -52 });
  });

  test("canvas-focused Space owns a below-threshold card candidate and suppresses activation", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const onClick = vi.fn();
    const onFocus = vi.fn();
    const { container } = render(
      <Harness>
        <article
          data-camera-content
          data-connector-record-id="project-a"
          onClick={onClick}
          onFocus={onFocus}
          role="treeitem"
          tabIndex={-1}
        >Card</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const card = screen.getByRole("treeitem");
    act(() => viewportElement.focus());
    expect(dispatchKey(viewportElement, " ").defaultPrevented).toBe(true);
    const down = dispatchPointer(card, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 91, pointerType: "mouse",
    });
    expect(down.defaultPrevented).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(91);
    dispatchPointer(card, "pointermove", {
      buttons: 1, clientX: 103, clientY: 100, pointerId: 91, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    dispatchPointer(card, "pointerup", {
      button: 0, buttons: 0, clientX: 103, clientY: 100,
      pointerId: 91, pointerType: "mouse",
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => card.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: " " })));
    expect(viewportElement.dataset.cameraSpacePanArmed).toBe("false");
  });

  test("Space on a focused tree item remains activation-owned and never arms camera pan", () => {
    const onKeyDown = vi.fn((event: ReactKeyboardEvent) => event.preventDefault());
    const { container } = render(
      <Harness>
        <article
          data-camera-content
          data-connector-record-id="project-a"
          onKeyDown={onKeyDown}
          role="treeitem"
          tabIndex={0}
        >Card</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const card = screen.getByRole("treeitem");
    act(() => card.focus());
    expect(dispatchKey(card, " ").defaultPrevented).toBe(true);
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(viewportElement.dataset.cameraSpacePanArmed).toBe("false");
  });

  test("middle drag owns card content without focus or activation", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const onClick = vi.fn();
    const { container } = render(
      <Harness>
        <article
          data-camera-content
          data-connector-record-id="project-a"
          onClick={onClick}
          role="treeitem"
          tabIndex={-1}
        >Card</article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const card = screen.getByRole("treeitem");
    const initial = cameraState(viewportElement);
    const down = dispatchPointer(card, "pointerdown", {
      button: 1, buttons: 4, clientX: 100, clientY: 100,
      pointerId: 92, pointerType: "mouse",
    });
    expect(down.defaultPrevented).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(92);
    dispatchPointer(card, "pointermove", {
      buttons: 4, clientX: 104, clientY: 104, pointerId: 92, pointerType: "mouse",
    });
    expect(cameraState(viewportElement)).toEqual({
      ...initial,
      x: initial.x + 4,
      y: initial.y + 4,
    });
    dispatchPointer(card, "pointerup", {
      button: 1, buttons: 0, clientX: 104, clientY: 104,
      pointerId: 92, pointerType: "mouse",
    });
    act(() => vi.advanceTimersByTime(16));
    const auxClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true });
    act(() => card.dispatchEvent(auxClick));
    expect(auxClick.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test.each([
    { button: 0, buttons: 1, mode: "Space-primary" },
    { button: 1, buttons: 4, mode: "middle" },
  ])("$mode drag owns an expansion control without activation", ({ button, buttons, mode }) => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const onClick = vi.fn();
    const onFocus = vi.fn();
    const { container } = render(
      <Harness>
        <article data-camera-content data-connector-record-id="project-a" role="treeitem">
          <button
            data-expansion-control
            onClick={onClick}
            onFocus={onFocus}
            type="button"
          >Expand branch</button>
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const expansion = screen.getByRole("button", { name: "Expand branch" });
    if (mode === "Space-primary") {
      act(() => viewportElement.focus());
      dispatchKey(viewportElement, " ");
    }

    const down = dispatchPointer(expansion, "pointerdown", {
      button,
      buttons,
      clientX: 100,
      clientY: 100,
      pointerId: 93,
      pointerType: "mouse",
    });
    expect(down.defaultPrevented).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(93);
    dispatchPointer(expansion, "pointermove", {
      buttons,
      clientX: 104,
      clientY: 100,
      pointerId: 93,
      pointerType: "mouse",
    });
    dispatchPointer(expansion, "pointerup", {
      button,
      buttons: 0,
      clientX: 104,
      clientY: 100,
      pointerId: 93,
      pointerType: "mouse",
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => expansion.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
  });

  test.each(["ancestor", "sibling"])(
    "suppresses a Space-owned click retargeted to the gesture activation %s",
    (retarget) => {
      content = { x: 0, y: 0, width: 2200, height: 1600 };
      const onClick = vi.fn();
      const { container } = render(
        <Harness>
          <article
            data-camera-content
            data-connector-record-id="project-a"
            onClick={onClick}
            role="treeitem"
          >
            <span data-gesture-source>Source</span>
            <span data-gesture-sibling>Sibling</span>
          </article>
        </Harness>,
      );
      flushAnimationFrames();
      const viewportElement = container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!;
      const card = screen.getByRole("treeitem");
      const source = container.querySelector<HTMLElement>("[data-gesture-source]")!;
      const sibling = container.querySelector<HTMLElement>("[data-gesture-sibling]")!;
      act(() => viewportElement.focus());
      dispatchKey(viewportElement, " ");
      dispatchPointer(source, "pointerdown", {
        button: 0, buttons: 1, clientX: 100, clientY: 100,
        pointerId: 97, pointerType: "mouse",
      });
      dispatchPointer(source, "pointerup", {
        button: 0, buttons: 0, clientX: 102, clientY: 100,
        pointerId: 97, pointerType: "mouse",
      });

      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => (retarget === "ancestor" ? card : sibling).dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
      expect(onClick).not.toHaveBeenCalled();
    },
  );

  test.each(["pointercancel", "lostpointercapture", "blur", "capture-failure"])(
    "clears Space-owned click suppression after %s so a keyboard click survives",
    (terminal) => {
      content = { x: 0, y: 0, width: 2200, height: 1600 };
      const onClick = vi.fn();
      const { container } = render(
        <Harness>
          <article data-camera-content data-connector-record-id="project-a" role="treeitem">
            <button data-expansion-control onClick={onClick} type="button">Expand branch</button>
          </article>
        </Harness>,
      );
      flushAnimationFrames();
      const viewportElement = container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!;
      const expansion = screen.getByRole("button", { name: "Expand branch" });
      act(() => viewportElement.focus());
      dispatchKey(viewportElement, " ");
      if (terminal === "capture-failure") {
        setPointerCapture.mockImplementationOnce(() => undefined);
      }
      dispatchPointer(expansion, "pointerdown", {
        button: 0, buttons: 1, clientX: 100, clientY: 100,
        pointerId: 98, pointerType: "mouse",
      });

      if (terminal === "pointercancel") {
        dispatchPointer(expansion, "pointercancel", {
          buttons: 0, pointerId: 98, pointerType: "mouse",
        });
      } else if (terminal === "lostpointercapture") {
        capturedPointers.delete(98);
        dispatchPointer(viewportElement, "lostpointercapture", {
          buttons: 0, pointerId: 98, pointerType: "mouse",
        });
      } else if (terminal === "blur") {
        act(() => window.dispatchEvent(new Event("blur")));
      }

      const keyboardClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 0,
      });
      act(() => expansion.dispatchEvent(keyboardClick));
      expect(keyboardClick.defaultPrevented).toBe(false);
      expect(onClick).toHaveBeenCalledOnce();
    },
  );

  test("discards Space-owned suppression on unmount before a later keyboard click", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const first = render(
      <Harness>
        <article data-camera-content data-connector-record-id="project-a" role="treeitem">
          <button data-expansion-control type="button">Expand branch</button>
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = first.container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    act(() => viewportElement.focus());
    dispatchKey(viewportElement, " ");
    dispatchPointer(screen.getByRole("button", { name: "Expand branch" }), "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 99, pointerType: "mouse",
    });
    first.unmount();

    const onClick = vi.fn();
    render(
      <Harness projectId="project-b">
        <article data-camera-content data-connector-record-id="project-b" role="treeitem">
          <button onClick={onClick} type="button">Expand branch</button>
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    act(() => screen.getByRole("button", { name: "Expand branch" }).click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("scans rendered card and path bounds only when the explicit layout revision changes", () => {
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    const querySelectorAll = vi.spyOn(world, "querySelectorAll");

    rerender(
      <Harness>
        <article data-camera-content data-connector-record-id="project-a">
          Style-only child rerender
        </article>
      </Harness>,
    );
    expect(querySelectorAll).not.toHaveBeenCalledWith(
      "[data-connector-record-id],path[data-connector-id]",
    );

    rerender(
      <Harness layoutRevision="layout-b">
        <article data-camera-content data-connector-record-id="project-a">
          Geometry-changing child rerender
        </article>
      </Harness>,
    );
    expect(querySelectorAll.mock.calls.filter(([selector]) => (
      selector === "[data-connector-record-id],path[data-connector-id]"
    ))).toHaveLength(1);
  });

  test("keeps the empty-canvas pan surface separate from interactive world content", () => {
    const { container } = render(
      <Harness>
        <article data-camera-content data-camera-interactive data-connector-record-id="record-a">
          Card
          <button type="button">Action</button>
        </article>
      </Harness>,
    );

    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]");
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    const card = container.querySelector<HTMLElement>("[data-camera-interactive]")!;

    expect(panSurface).not.toBeNull();
    if (panSurface === null) return;
    expect(panSurface.contains(card)).toBe(false);
    expect(world.contains(card)).toBe(true);
  });

  test("starts from the active card and clamps using connector paths instead of the world floor", () => {
    content = { x: 220, y: 160, width: 200, height: 120 };
    connectorPathBounds = { x: 200, y: 140, width: 240, height: 160 };
    worldFloor = { width: 1000, height: 700 };
    const { container } = render(
      <Harness activeRootId="record-a">
        <article data-camera-content data-connector-record-id="record-a">Only card</article>
        <svg className="project-map-connectors" height="700" width="1000">
          <path data-connector-id="primary:test" />
        </svg>
      </Harness>,
    );

    flushAnimationFrames();

    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 180, y: -128 });

    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
      dispatchKey(viewportElement, key);
    }
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 180, y: -128 });
  });

  test("measures rendered card and path bounds during a fit transition", () => {
    content = { x: 220, y: 160, width: 200, height: 120 };
    connectorPathBounds = { x: 200, y: 140, width: 240, height: 160 };
    renderedWorldCamera = { scale: 0.9, x: 0, y: 0 };
    worldFloor = { width: 1000, height: 700 };
    const { container } = render(
      <Harness activeRootId="record-a">
        <article data-camera-content data-connector-record-id="record-a">Only card</article>
        <svg className="project-map-connectors" height="700" width="1000">
          <path data-connector-id="primary:test" />
        </svg>
      </Harness>,
    );

    flushAnimationFrames();

    expect(cameraState(container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: 180, y: -128 });
  });

  test("interrupts a fit from the rendered camera before toolbar zoom", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };
    renderWorldAsMatrix3d = true;

    act(() => screen.getByRole("button", { name: "Zoom in" }).click());

    expect(cameraState(viewportElement)).toEqual({ scale: 0.9, x: -265, y: -178.75 });
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("interrupts a fit from the rendered camera before keyboard zoom", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };

    expect(dispatchKey(viewportElement, "+").defaultPrevented).toBe(true);

    expect(cameraState(viewportElement)).toEqual({ scale: 0.9, x: -265, y: -178.75 });
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("interrupts from the last verified rendered camera when computed transform is none", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };
    triggerResizeObservers();
    renderedWorldTransformOverride = "none";

    expect(dispatchKey(viewportElement, "ArrowRight").defaultPrevented).toBe(true);

    expect(cameraState(viewportElement)).toEqual({ scale: 0.8, x: -220, y: -120 });
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test.each([
    "matrix(0.8, 0, 0)",
    "matrix(NaN, 0, 0, NaN, NaN, NaN)",
    "matrix(0.6, 0, 0, 0.6, -100, -80, 1)",
    "matrix(0.8, 0.1, 0, 0.8, -180, -120)",
    "matrix(0.6junk, 0, 0, 0.6junk, -100, -80)",
    "matrix(1e, 0, 0, 1e, -100, -80)",
    "matrix(1..2, 0, 0, 1..2, -100, -80)",
    "matrix(0.6, 0, 0, 0.6, -100px, -80)",
    "matrix(0.6, 0, 0, 0.6, 1e999, -80)",
    "translate3d(-100px, -80px, 0) scale(0.6e+)",
  ])("interrupts from the last verified camera for invalid transform %s", (invalidTransform) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };
    triggerResizeObservers();
    renderedWorldTransformOverride = invalidTransform;

    act(() => screen.getByRole("button", { name: "Zoom in" }).click());

    expect(cameraState(viewportElement)).toEqual({ scale: 0.9, x: -265, y: -178.75 });
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test.each([
    "matrix(+.8, 0, 0, 8e-1, -1.8e2, -1.2e2)",
    "matrix3d(8e-1, 0, 0, 0, 0, +.8, 0, 0, 0, 0, 1, 0, -1.8e2, -1.2e2, 0, 1)",
    "translate3d(-1.8e2px, -1.2e2px, 0) scale(+.8)",
  ])("accepts complete signed decimal and exponent tokens in %s", (validTransform) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };
    renderedWorldTransformOverride = validTransform;

    act(() => screen.getByRole("button", { name: "Zoom in" }).click());

    expect(cameraState(viewportElement)).toEqual({ scale: 0.9, x: -265, y: -178.75 });
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("interrupts a fit from the rendered camera before keyboard pan", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };

    expect(dispatchKey(viewportElement, "ArrowRight").defaultPrevented).toBe(true);

    expect(cameraState(viewportElement)).toEqual({ scale: 0.8, x: -220, y: -120 });
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("interrupts a fit from the rendered camera when empty-canvas drag begins", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 31, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 31, pointerType: "mouse",
    });

    expect(cameraState(viewportElement)).toEqual({ scale: 0.8, x: -170, y: -120 });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("interrupts a fit from the rendered camera when pinch begins", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };

    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 200, clientY: 200, pointerId: 41, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 400, clientY: 200, pointerId: 42, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointermove", {
      clientX: 500, clientY: 200, pointerId: 42, pointerType: "touch",
    });

    expect(cameraState(viewportElement)).toEqual({ scale: 1.2, x: -370, y: -280 });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("interrupts a fit from the rendered camera before wheel zoom", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    renderedWorldCamera = { scale: 0.8, x: -180, y: -120 };
    const renderedAnchor = {
      x: (320 - renderedWorldCamera.x) / renderedWorldCamera.scale,
      y: (240 - renderedWorldCamera.y) / renderedWorldCamera.scale,
    };
    const wheel = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: 320, clientY: 240,
      deltaY: -100,
    });

    act(() => viewportElement.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(true);
    expect(cameraState(viewportElement)).toEqual({ scale: 0.9, x: -242.5, y: -165 });
    expect(worldPointAt(viewportElement, { x: 320, y: 240 })).toEqual(renderedAnchor);
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
  });

  test("suppresses initial, focus, explicit-fit, and resize transitions for reduced motion", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const { container, rerender } = render(<Harness />);
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;

    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);

    rerender(<Harness focusRequestKey={1} />);
    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);

    rerender(<Harness fitRequestKey={1} focusRequestKey={1} />);
    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event("resize"));
    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("clears fit timers on project change and unmount", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, rerender, unmount } = render(<Harness />);
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("true");
    expect(vi.getTimerCount()).toBe(1);

    rerender(<Harness projectId="project-b" />);
    expect(world.dataset.cameraFitTransition).toBe("false");
    expect(vi.getTimerCount()).toBe(0);
    flushAnimationFrames();
    expect(world.dataset.cameraFitTransition).toBe("true");
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("measures after StrictMode replays the initial lifecycle cleanup", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container } = render(<StrictMode><Harness /></StrictMode>);
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;

    expect(world.dataset.cameraFitTransition).toBe("false");

    flushAnimationFrames();

    expect(container.querySelector<HTMLElement>(".project-map-camera__viewport")?.dataset.cameraScale)
      .toBe("1");
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
    expect(world.dataset.cameraFitTransition).toBe("true");
    act(() => vi.advanceTimersByTime(139));
    expect(world.dataset.cameraFitTransition).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(world.dataset.cameraFitTransition).toBe("false");
  });

  test("preserves the initial root policy after a zero-size viewport becomes measurable", () => {
    viewport = { width: 0, height: 0 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);

    viewport = { width: 1000, height: 700 };
    triggerResizeObservers();

    expect(container.querySelector<HTMLElement>(".project-map-camera__viewport")?.dataset.cameraScale)
      .toBe("1");
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("100%");
  });

  test.each([
    { expectedPadding: 40, viewportWidth: 1000 },
    { expectedPadding: 24, viewportWidth: 759 },
  ])(
    "uses $expectedPadding pixels of fit padding for the first unmeasurable project at $viewportWidth pixels",
    ({ expectedPadding, viewportWidth }) => {
      viewport = { width: viewportWidth, height: 700 };
      content = { x: 0, y: 0, width: 0, height: 0 };
      const { container } = render(<Harness />);

      flushAnimationFrames();

      expect(cameraState(container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!)).toEqual({ scale: 1, x: expectedPadding, y: expectedPadding });
      expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);
    },
  );

  test("retries unmeasurable initial content after a React layout render without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    content = { x: 0, y: 0, width: 0, height: 0 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    expect(animationFrames.size).toBe(0);

    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 40, y: 40 });
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);

    content = { x: 100, y: 50, width: 1600, height: 800 };
    rerender(
      <Harness layoutRevision="layout-b">
        <article data-camera-content data-connector-record-id="project-a">
          Loaded project hierarchy
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(animationFrames.size).toBe(0);

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -400, y: -18 });
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
  });

  test("does not replace a later verified camera with the unmeasurable-content fallback", () => {
    content = { x: 0, y: 0, width: 0, height: 0 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();

    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: 40, y: 40 });

    content = { x: 100, y: 50, width: 1600, height: 800 };
    triggerResizeObservers();
    act(() => screen.getByRole("button", { name: "Zoom in" }).click());
    const verifiedCamera = cameraState(viewportElement);
    expect(verifiedCamera.scale).toBeCloseTo(1.1);
    expect(verifiedCamera.x).toBeCloseTo(-490);
    expect(verifiedCamera.y).toBeCloseTo(-54.8);

    content = { x: 0, y: 0, width: 0, height: 0 };
    rerender(
      <Harness>
        <article data-camera-content data-connector-record-id="project-a">
          Temporarily unavailable project hierarchy
        </article>
      </Harness>,
    );

    expect(cameraState(viewportElement)).toEqual(verifiedCamera);
  });

  test("places its first non-zero active root at 100% and enables truthful controls", () => {
    const { container } = render(<Harness />);

    expect(screen.getByRole("button", { name: "Zoom out" }).disabled).toBe(true);
    flushAnimationFrames();

    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    expect(viewportElement.dataset.cameraScale).toBe("1");
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("100%");
    expect(world.style.transform).toBe("translate3d(-400px, -18px, 0) scale(1)");
    expect(world.style.transformOrigin).toBe("0 0");
    expect(screen.getByRole("button", { name: "Zoom in" }).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
    expect(viewportElement.getAttribute("aria-describedby")).toBeTruthy();
  });

  test("clamps layout changes but only refits for an explicit fit request", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    content = { x: 0, y: 0, width: 200, height: 200 };
    rerender(
      <Harness>
        <article data-camera-content data-connector-record-id="project-a">
          Changed hierarchy
        </article>
      </Harness>,
    );
    triggerResizeObservers();

    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("110%");

    rerender(
      <Harness fitRequestKey={1}>
        <article data-camera-content data-connector-record-id="project-a">
          Changed hierarchy
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("150%");
    expect(container.querySelector("[data-camera-world]")?.dataset.cameraFitTransition).toBe("true");
  });

  test("window and observed viewport resize preserve scale and the center world point", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    flushAnimationFrames();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const priorCenter = (viewport.width / 2 - Number(viewportElement.dataset.cameraX)) /
      Number(viewportElement.dataset.cameraScale);

    viewport = { width: 800, height: 700 };
    triggerResizeObservers();
    const preservedCenter = (viewport.width / 2 - Number(viewportElement.dataset.cameraX)) /
      Number(viewportElement.dataset.cameraScale);
    expect(preservedCenter).toBeCloseTo(priorCenter);
    const resizedCamera = cameraState(viewportElement);
    dispatchKey(viewportElement, "ArrowRight");
    expect(cameraState(viewportElement).x).toBe(resizedCamera.x - 40);

    window.dispatchEvent(new Event("resize"));
    flushAnimationFrames();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("110%");
  });

  test("starts one fresh initial-root transition for a new project", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    act(() => vi.advanceTimersByTime(140));
    act(() => screen.getByRole("button", { name: "Zoom in" }).click());
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("110%");

    rerender(<Harness projectId="project-b" />);
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("110%");
    expect(world.dataset.cameraFitTransition).toBe("false");
    flushAnimationFrames();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("100%");
    expect(world.dataset.cameraFitTransition).toBe("true");
    act(() => vi.advanceTimersByTime(139));
    expect(world.dataset.cameraFitTransition).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(world.dataset.cameraFitTransition).toBe("false");
  });

  test("disables controls and starts one fit after switched-project content becomes measurable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", undefined);
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    act(() => vi.advanceTimersByTime(140));

    content = { x: 0, y: 0, width: 0, height: 0 };
    rerender(
      <Harness activeRootId="project-b" projectId="project-b">
        <article data-camera-content data-connector-record-id="project-b">
          Loading project hierarchy
        </article>
      </Harness>,
    );

    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);
    flushAnimationFrames();
    expect(cameraState(container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: 40, y: 40 });
    expect(vi.getTimerCount()).toBe(0);

    content = { x: 100, y: 50, width: 1600, height: 800 };
    rerender(
      <Harness activeRootId="project-b" layoutRevision="project-b-loaded" projectId="project-b">
        <article data-camera-content data-connector-record-id="project-b">
          Loaded project hierarchy
        </article>
      </Harness>,
    );
    flushAnimationFrames();

    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
    expect(container.querySelector("[data-camera-world]")?.getAttribute(
      "data-camera-fit-transition",
    )).toBe("true");
    expect(vi.getTimerCount()).toBe(1);
  });

  test("keeps an unverified switched-project fallback inert until its content is measurable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", undefined);
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    act(() => vi.advanceTimersByTime(140));

    content = { x: 0, y: 0, width: 0, height: 0 };
    rerender(
      <Harness activeRootId="project-b" projectId="project-b">
        <article data-camera-content data-connector-record-id="project-b">
          Loading project hierarchy
        </article>
      </Harness>,
    );
    flushAnimationFrames();

    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const fallback = { scale: 1, x: 40, y: 40 };
    const expectStableFallback = () => {
      expect(cameraState(viewportElement)).toEqual(fallback);
      expect(screen.getByRole("button", { name: "Zoom out" }).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Zoom in" }).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);
    };
    expectStableFallback();
    const fallbackInstructions = screen.getByText(
      "Focused canvas — Zoom: wheel/trackpad, pinch, Plus (+) or Equals (=) in, Minus (-) or Underscore (_) out · F fits · Arrow keys pan when available.",
    );
    expect(fallbackInstructions.textContent).not.toContain("Ctrl/⌘+wheel");
    expect(animationFrames.size).toBe(0);

    act(() => {
      screen.getByRole("button", { name: "Zoom out" }).click();
      screen.getByRole("button", { name: "Zoom in" }).click();
      screen.getByRole("button", { name: "Fit project" }).click();
    });
    expectStableFallback();

    for (const key of ["+", "-", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "F"]) {
      dispatchKey(viewportElement, key);
      if (key === "F") flushAnimationFrames();
      expectStableFallback();
    }
    expect(animationFrames.size).toBe(0);

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 51, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 140, clientY: 120, pointerId: 51, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointerup", {
      button: 0, clientX: 140, clientY: 120, pointerId: 51, pointerType: "mouse",
    });
    expectStableFallback();
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    expect(setPointerCapture).not.toHaveBeenCalled();

    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 200, clientY: 200, pointerId: 52, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 400, clientY: 200, pointerId: 53, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointermove", {
      clientX: 500, clientY: 220, pointerId: 53, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointerup", {
      clientX: 500, clientY: 220, pointerId: 53, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointerup", {
      clientX: 200, clientY: 200, pointerId: 52, pointerType: "touch",
    });
    expectStableFallback();
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    expect(setPointerCapture).not.toHaveBeenCalled();

    for (const wheelInit of [
      { deltaY: -100 },
      { ctrlKey: true, deltaY: -100 },
      { metaKey: true, deltaY: -100 },
      { deltaX: 80, deltaY: 0 },
    ] satisfies WheelEventInit[]) {
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: 320,
        clientY: 240,
        ...wheelInit,
      });
      act(() => viewportElement.dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(false);
      expectStableFallback();
    }

    content = { x: 100, y: 50, width: 1600, height: 800 };
    rerender(
      <Harness activeRootId="project-b" layoutRevision="project-b-loaded" projectId="project-b">
        <article data-camera-content data-connector-record-id="project-b">
          Loaded project hierarchy
        </article>
      </Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -400, y: -18 });
    expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
    expect(animationFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  test.each(["fit-request", "window-resize"] as const)(
    "discards a pending %s measurement when switching to a measurable project",
    (pendingReason) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("ResizeObserver", undefined);
      animationFrameCancellationCanRace = true;
      const { container, rerender } = render(<Harness />);
      flushAnimationFrames();
      act(() => vi.advanceTimersByTime(140));
      expect(animationFrames.size).toBe(0);

      let fitRequestKey = 0;
      if (pendingReason === "fit-request") {
        fitRequestKey = 1;
        rerender(<Harness fitRequestKey={fitRequestKey} />);
      } else {
        act(() => window.dispatchEvent(new Event("resize")));
      }
      expect(animationFrames.size).toBe(1);

      content = { x: 100, y: 50, width: 1600, height: 800 };
      rerender(
        <Harness activeRootId="project-b" fitRequestKey={fitRequestKey} projectId="project-b">
          <article data-camera-content data-connector-record-id="project-b">
            Project B hierarchy
          </article>
        </Harness>,
      );

      expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(true);
      expect(animationFrames.size).toBe(2);
      flushAnimationFrames();

      const viewportElement = container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!;
      expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -400, y: -18 });
      expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("100%");
      expect(screen.getByRole("button", { name: "Fit project" }).disabled).toBe(false);
      expect(container.querySelector("[data-camera-world]")?.getAttribute(
        "data-camera-fit-transition",
      )).toBe("true");
      expect(vi.getTimerCount()).toBe(1);
      expect(animationFrames.size).toBe(0);

      act(() => screen.getByRole("button", { name: "Zoom in" }).click());
      const afterZoom = cameraState(viewportElement);
      expect(afterZoom.scale).toBeCloseTo(1.1);
      expect(vi.getTimerCount()).toBe(0);

      dispatchKey(viewportElement, "ArrowRight");
      expect(cameraState(viewportElement).x).toBeLessThan(afterZoom.x);
      expect(animationFrames.size).toBe(0);
    },
  );

  test("uses the newest root when two same-project Focus requests queue before animation frame", () => {
    contentBoundsByRecordId.set("branch-a", { x: 100, y: 100, width: 200, height: 100 });
    contentBoundsByRecordId.set("branch-b", { x: 500, y: 250, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="project-a">Project</article>
        <article data-camera-content data-connector-record-id="branch-a">Branch A</article>
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();

    rerender(
      <Harness activeRootId="branch-a" focusRequestKey={1}>{children}</Harness>,
    );
    rerender(
      <Harness activeRootId="branch-b" focusRequestKey={2}>{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: -130, y: -218 });
  });

  test("uses newest root and occlusion inputs when a queued Focus survives a rerender", () => {
    contentBoundsByRecordId.set("branch-a", { x: 100, y: 100, width: 200, height: 100 });
    contentBoundsByRecordId.set("branch-b", { x: 500, y: 250, width: 260, height: 120 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="project-a">Project</article>
        <article data-camera-content data-connector-record-id="branch-a">Branch A</article>
        <article data-camera-content data-connector-record-id="branch-b">Branch B</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();

    rerender(
      <Harness activeRootId="branch-a" focusRequestKey={1}>{children}</Harness>,
    );
    rerender(
      <Harness
        activeRootId="branch-b"
        focusRequestKey={1}
        occlusionInsets={{ top: 24, right: 300, bottom: 12, left: 20 }}
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!)).toEqual({ scale: 1, x: -270, y: -194 });
  });

  test("keeps the transform passive when only occlusion insets change and uses them for the next Fit", async () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const world = container.querySelector<HTMLElement>("[data-camera-world]")!;
    for (let index = 0; index < 100; index += 1) {
      dispatchKey(viewportElement, "ArrowDown");
    }
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -600, y: -1552 });

    rerender(
      <Harness occlusionInsets={{ top: 400, right: 0, bottom: 0, left: 0 }} />,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -600, y: -1552 });
    expect(world.style.transform).toBe("translate3d(-600px, -1552px, 0) scale(1)");

    await userEvent.click(screen.getByRole("button", { name: "Fit project" }));
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: -50, y: 150 });
  });

  test("preserves inset continuity while pan and zoom inputs move without a deferred snap", async () => {
    content = { x: 200, y: 80, width: 260, height: 120 };
    const { container, rerender } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const surface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const beforeInsets = cameraState(viewportElement);

    rerender(<Harness occlusionInsets={{ top: 0, right: 420, bottom: 0, left: 0 }} />);
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual(beforeInsets);

    dispatchKey(viewportElement, "ArrowLeft");
    expect(cameraState(viewportElement)).toEqual(beforeInsets);
    dispatchKey(viewportElement, "ArrowRight");
    expect(cameraState(viewportElement).x).toBe(beforeInsets.x - 40);

    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    const centerWorld = worldPointAt(viewportElement, center);
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(worldPointAt(viewportElement, center)).toEqual(centerWorld);

    const wheelAnchor = { x: 320, y: 240 };
    const wheelWorld = worldPointAt(viewportElement, wheelAnchor);
    const wheel = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: wheelAnchor.x, clientY: wheelAnchor.y,
      deltaY: -100,
    });
    act(() => viewportElement.dispatchEvent(wheel));
    expect(cameraState(viewportElement).scale).toBeCloseTo(beforeInsets.scale + 0.2, 8);
    expect(worldPointAt(viewportElement, wheelAnchor)).toEqual(wheelWorld);

    const pinchAnchor = { x: 300, y: 220 };
    const pinchWorld = worldPointAt(viewportElement, pinchAnchor);
    dispatchPointer(surface, "pointerdown", {
      clientX: 250, clientY: 220, pointerId: 401, pointerType: "touch",
    });
    dispatchPointer(surface, "pointerdown", {
      clientX: 350, clientY: 220, pointerId: 402, pointerType: "touch",
    });
    dispatchPointer(viewportElement, "pointermove", {
      clientX: 370, clientY: 220, pointerId: 402, pointerType: "touch",
    });
    expect(worldPointAt(viewportElement, { x: 310, y: 220 }).x).toBe(pinchWorld.x);
  });

  test("reveals a fully covered selected card with the smallest translation and unchanged scale", () => {
    content = { x: 0, y: 0, width: 2200, height: 1200 };
    contentBoundsByRecordId.set("selected", { x: 1500, y: 300, width: 100, height: 80 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="project-a">Project</article>
        <article data-camera-content data-connector-record-id="selected">Selected</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -600, y: 32 });

    rerender(
      <Harness
        occlusionInsets={{ top: 0, right: 300, bottom: 0, left: 0 }}
        revealRecordId="selected"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -900, y: 32 });
  });

  test("does not move a partially visible selected card when inspector insets arrive", () => {
    content = { x: 0, y: 0, width: 2200, height: 1200 };
    contentBoundsByRecordId.set("selected", { x: 1250, y: 300, width: 100, height: 80 });
    const children = (
      <>
        <article data-camera-content data-connector-record-id="project-a">Project</article>
        <article data-camera-content data-connector-record-id="selected">Selected</article>
      </>
    );
    const { container, rerender } = render(<Harness>{children}</Harness>);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const before = cameraState(viewportElement);

    rerender(
      <Harness
        occlusionInsets={{ top: 0, right: 300, bottom: 0, left: 0 }}
        revealRecordId="selected"
      >{children}</Harness>,
    );
    flushAnimationFrames();

    expect(cameraState(viewportElement)).toEqual(before);
  });

  test("fits current bounds from the toolbar and reports zoom limits", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    flushAnimationFrames();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    for (let index = 0; index < 10; index += 1) await user.click(zoomIn);
    expect(zoomIn.disabled).toBe(true);

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    for (let index = 0; index < 10; index += 1) await user.click(zoomOut);
    expect(zoomOut.disabled).toBe(true);
    content = { x: 0, y: 0, width: 200, height: 200 };
    await user.click(screen.getByRole("button", { name: "Fit project" }));
    flushAnimationFrames();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("150%");
  });

  test("measures initial, explicit, and window-resize fits without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const user = userEvent.setup();
    render(<Harness />);
    flushAnimationFrames();
    await user.click(screen.getByRole("button", { name: "Fit project" }));
    flushAnimationFrames();
    window.dispatchEvent(new Event("resize"));
    expect(() => flushAnimationFrames()).not.toThrow();
    expect(screen.getByRole("status", { name: "Map zoom" }).textContent).toBe("58%");
  });

  test("throws a clear error when the camera context is consumed outside its provider", async () => {
    const { useProjectMapCamera } = await import("./project-map-camera-canvas.js");
    function OutsideConsumer() {
      useProjectMapCamera();
      return null;
    }
    expect(() => render(<OutsideConsumer />)).toThrow("ProjectMapCameraCanvas");
  });

  test.each([
    { label: "plain", modifiers: {} },
    { label: "Ctrl-modified", modifiers: { ctrlKey: true } },
    { label: "Cmd-modified", modifiers: { metaKey: true } },
  ])("zooms $label vertical wheel input toward the pointer", ({ modifiers }) => {
    content = { x: 0, y: 0, width: 1840, height: 1240 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const camera = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const anchor = { x: 320, y: 240 };
    const before = cameraState(camera);
    const beforeWorld = worldPointAt(camera, anchor);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: anchor.x,
      clientY: anchor.y,
      deltaY: -100,
      ...modifiers,
    });

    act(() => camera.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(true);
    expect(cameraState(camera).scale).toBeCloseTo(before.scale + 0.1, 8);
    expect(worldPointAt(camera, anchor)).toEqual(beforeWorld);
  });

  test("zooms out for positive wheel delta and ignores horizontal-only wheel input", () => {
    content = { x: 0, y: 0, width: 1840, height: 1240 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const camera = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const zoomIn = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: 320, clientY: 240, deltaY: -100,
    });
    act(() => camera.dispatchEvent(zoomIn));
    const beforeZoomOut = cameraState(camera);
    const zoomOut = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: 320, clientY: 240, deltaY: 100,
    });
    act(() => camera.dispatchEvent(zoomOut));
    expect(zoomOut.defaultPrevented).toBe(true);
    expect(cameraState(camera).scale).toBeCloseTo(beforeZoomOut.scale - 0.1, 8);

    const before = cameraState(camera);
    const horizontal = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaX: 120, deltaY: 0,
    });
    act(() => camera.dispatchEvent(horizontal));
    expect(horizontal.defaultPrevented).toBe(false);
    expect(cameraState(camera)).toEqual(before);
  });

  test("prevents outward wheel input at zoom limits without camera drift", async () => {
    content = { x: 0, y: 0, width: 1840, height: 1240 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const camera = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const setToolbarScale = async (targetPercent: 50 | 150) => {
      const output = screen.getByRole("status", { name: "Map zoom" });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const current = Number.parseInt(output.textContent ?? "", 10);
        if (current === targetPercent) return;
        await userEvent.click(screen.getByRole("button", {
          name: current < targetPercent ? "Zoom in" : "Zoom out",
        }));
      }
      expect(output.textContent).toBe(`${targetPercent}%`);
    };

    for (const limit of [
      { percent: 150, deltaY: -100 },
      { percent: 50, deltaY: 100 },
    ] as const) {
      await setToolbarScale(limit.percent);
      const before = cameraState(camera);
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: 320,
        clientY: 240,
        deltaY: limit.deltaY,
      });
      act(() => camera.dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(true);
      expect(cameraState(camera)).toEqual(before);
    }
  });

  test("starts empty-canvas dragging at four pixels and clears it on release, cancel, and blur", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const initial = cameraState(viewportElement);
    expect(viewportElement.dataset.cameraDragging).toBe("false");

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 103, clientY: 100, pointerId: 1, pointerType: "mouse",
    });
    expect(cameraState(viewportElement)).toEqual(initial);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(viewportElement.dataset.cameraDragging).toBe("false");

    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 104, clientY: 100, pointerId: 1, pointerType: "mouse",
    });
    expect(cameraState(viewportElement).x).toBe(initial.x + 4);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    expect(container.querySelector("[data-camera-world]")?.getAttribute("data-camera-fit-transition"))
      .toBe("false");
    dispatchPointer(viewportElement, "pointerup", {
      button: 0, clientX: 104, clientY: 100, pointerId: 1, pointerType: "mouse",
    });
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    const suppressedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => viewportElement.dispatchEvent(suppressedClick));
    expect(suppressedClick.defaultPrevented).toBe(true);

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 2, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 2, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    dispatchPointer(viewportElement, "pointercancel", {
      clientX: 110, clientY: 100, pointerId: 2, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    const afterCancel = cameraState(viewportElement);
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 150, clientY: 100, pointerId: 2, pointerType: "mouse",
    });
    expect(cameraState(viewportElement)).toEqual(afterCancel);

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 3, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 3, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    const afterBlur = cameraState(viewportElement);
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 150, clientY: 100, pointerId: 3, pointerType: "mouse",
    });
    expect(cameraState(viewportElement)).toEqual(afterBlur);
  });

  test.each(["pointerup", "pointercancel"])(
    "clears an uncaptured pointer candidate after a global %s",
    (endType) => {
      content = { x: 0, y: 0, width: 2200, height: 1600 };
      const { container } = render(<Harness />);
      flushAnimationFrames();
      const viewportElement = container.querySelector<HTMLElement>(
        ".project-map-camera__viewport",
      )!;
      const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
      const initial = cameraState(viewportElement);

      dispatchPointer(panSurface, "pointerdown", {
        button: 0, buttons: 1, clientX: 100, clientY: 100,
        pointerId: 51, pointerType: "mouse",
      });
      dispatchPointer(panSurface, "pointermove", {
        buttons: 1, clientX: 102, clientY: 100,
        pointerId: 51, pointerType: "mouse",
      });
      dispatchPointer(window, endType, {
        button: 0, buttons: 0, clientX: 30, clientY: 30,
        pointerId: 51, pointerType: "mouse",
      });
      dispatchPointer(panSurface, "pointermove", {
        buttons: 0, clientX: 120, clientY: 100,
        pointerId: 51, pointerType: "mouse",
      });

      expect(cameraState(viewportElement)).toEqual(initial);
      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(viewportElement.dataset.cameraDragging).toBe("false");
    },
  );

  test("discards an uncaptured mouse or pen candidate when its primary button is no longer down", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const initial = cameraState(viewportElement);

    for (const [index, pointerType] of ["mouse", "pen"].entries()) {
      dispatchPointer(panSurface, "pointerdown", {
        button: 0, buttons: 1, clientX: 100, clientY: 100,
        pointerId: 61 + index, pointerType,
      });
      dispatchPointer(panSurface, "pointermove", {
        buttons: 0, clientX: 120, clientY: 100,
        pointerId: 61 + index, pointerType,
      });
    }

    expect(cameraState(viewportElement)).toEqual(initial);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(viewportElement.dataset.cameraDragging).toBe("false");
  });

  test("ignores failed or inactive pointer capture without panning", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const initial = cameraState(viewportElement);

    setPointerCapture.mockImplementationOnce(() => undefined);
    dispatchPointer(panSurface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 71, pointerType: "mouse",
    });
    dispatchPointer(panSurface, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100,
      pointerId: 71, pointerType: "mouse",
    });

    setPointerCapture.mockImplementationOnce(() => {
      throw new DOMException("Pointer is inactive", "NotFoundError");
    });
    dispatchPointer(panSurface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 72, pointerType: "mouse",
    });
    expect(() => dispatchPointer(panSurface, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100,
      pointerId: 72, pointerType: "mouse",
    })).not.toThrow();

    expect(cameraState(viewportElement)).toEqual(initial);
    expect(viewportElement.dataset.cameraDragging).toBe("false");
  });

  test("clears a captured pointer even when releasing capture fails", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(
      ".project-map-camera__viewport",
    )!;
    const panSurface = container.querySelector<HTMLElement>("[data-camera-pan-surface]")!;

    dispatchPointer(panSurface, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
      pointerId: 81, pointerType: "mouse",
    });
    dispatchPointer(panSurface, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100,
      pointerId: 81, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    releasePointerCapture.mockImplementationOnce((pointerId: number) => {
      capturedPointers.delete(pointerId);
      throw new DOMException("Capture already lost", "NotFoundError");
    });

    expect(() => dispatchPointer(panSurface, "pointerup", {
      button: 0, buttons: 0, clientX: 110, clientY: 100,
      pointerId: 81, pointerType: "mouse",
    })).not.toThrow();
    expect(viewportElement.dataset.cameraDragging).toBe("false");
  });

  test("stops panning after unexpected pointer capture loss", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 4, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 4, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    const afterDrag = cameraState(viewportElement);

    dispatchPointer(viewportElement, "lostpointercapture", {
      clientX: 110, clientY: 100, pointerId: 4, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 150, clientY: 100, pointerId: 4, pointerType: "mouse",
    });

    expect(cameraState(viewportElement)).toEqual(afterDrag);
  });

  test("keeps pointer gestures and clicks isolated from cards, buttons, and tree items", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Harness>
        <article
          data-camera-content
          data-camera-interactive
          data-connector-record-id="record-a"
          onClick={onClick}
        >
          Card
          <button onClick={onClick} type="button">Action</button>
          <div onClick={onClick} role="treeitem" tabIndex={-1}>Tree item</div>
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const initial = cameraState(viewportElement);
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    const targets = [
      container.querySelector<HTMLElement>("[data-camera-interactive]")!,
      screen.getByRole("button", { name: "Action" }),
      screen.getByRole("treeitem"),
    ];

    targets.forEach((target, index) => {
      dispatchPointer(target, "pointerdown", {
        button: 0, buttons: 1, clientX: 100, clientY: 100,
        pointerId: index + 1, pointerType: "mouse",
      });
      dispatchPointer(target, "pointermove", {
        buttons: 1, clientX: 150, clientY: 140,
        pointerId: index + 1, pointerType: "mouse",
      });
      expect(viewportElement.dataset.cameraDragging).toBe("false");
      dispatchPointer(target, "pointerup", {
        button: 0, clientX: 150, clientY: 140,
        pointerId: index + 1, pointerType: "mouse",
      });
      act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    });

    expect(cameraState(viewportElement)).toEqual(initial);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(5);
  });

  test("pinches around the moving midpoint and continues panning with the remaining touch", () => {
    content = { x: 0, y: 0, width: 1840, height: 1240 };
    const { container } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;

    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 200, clientY: 200, pointerId: 11, pointerType: "touch",
    });
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    dispatchPointer(viewportElement, "pointerdown", {
      clientX: 400, clientY: 200, pointerId: 12, pointerType: "touch",
    });
    expect(setPointerCapture.mock.calls).toEqual([[11], [12]]);
    expect(viewportElement.dataset.cameraDragging).toBe("true");

    dispatchPointer(viewportElement, "pointermove", {
      clientX: 500, clientY: 200, pointerId: 12, pointerType: "touch",
    });
    expect(cameraState(viewportElement)).toEqual({ scale: 1.5, x: -730, y: -52 });

    dispatchPointer(viewportElement, "pointerup", {
      clientX: 500, clientY: 200, pointerId: 12, pointerType: "touch",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");
    dispatchPointer(viewportElement, "pointermove", {
      clientX: 220, clientY: 230, pointerId: 11, pointerType: "touch",
    });
    expect(cameraState(viewportElement)).toEqual({ scale: 1.5, x: -710, y: -22 });
    dispatchPointer(viewportElement, "pointerup", {
      clientX: 220, clientY: 230, pointerId: 11, pointerType: "touch",
    });
    expect(releasePointerCapture.mock.calls).toEqual([[12], [11]]);
    expect(viewportElement.dataset.cameraDragging).toBe("false");
  });

  test("clears captured dragging on project change and unmount", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container, rerender, unmount } = render(<Harness />);
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 21, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 21, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");

    rerender(<Harness projectId="project-b" />);
    expect(viewportElement.dataset.cameraDragging).toBe("false");
    expect(releasePointerCapture).toHaveBeenCalledWith(21);
    flushAnimationFrames();

    dispatchPointer(viewportElement, "pointerdown", {
      button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 22, pointerType: "mouse",
    });
    dispatchPointer(viewportElement, "pointermove", {
      buttons: 1, clientX: 110, clientY: 100, pointerId: 22, pointerType: "mouse",
    });
    expect(viewportElement.dataset.cameraDragging).toBe("true");

    unmount();
    expect(releasePointerCapture).toHaveBeenCalledWith(22);
    expect(capturedPointers.has(22)).toBe(false);
  });

  test("handles camera keys only from the viewport and clamps keyboard zoom and pan", () => {
    content = { x: 0, y: 0, width: 2200, height: 1600 };
    const { container } = render(
      <Harness activeRootId="record-a">
        <article data-camera-content data-camera-interactive data-connector-record-id="record-a">
          Card
          <button type="button">Action</button>
          <div role="treeitem" tabIndex={-1}>Tree item</div>
        </article>
      </Harness>,
    );
    flushAnimationFrames();
    const viewportElement = container.querySelector<HTMLElement>(".project-map-camera__viewport")!;

    for (const key of ["+", "=", "-", "_"]) {
      expect(dispatchKey(viewportElement, key).defaultPrevented).toBe(true);
    }
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -600, y: 32 });
    expect(dispatchKey(viewportElement, "ArrowRight").defaultPrevented).toBe(true);
    expect(dispatchKey(viewportElement, "ArrowDown").defaultPrevented).toBe(true);
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -640, y: -8 });
    expect(dispatchKey(viewportElement, "ArrowLeft").defaultPrevented).toBe(true);
    expect(dispatchKey(viewportElement, "ArrowUp").defaultPrevented).toBe(true);
    expect(cameraState(viewportElement)).toEqual({ scale: 1, x: -600, y: 32 });

    dispatchKey(viewportElement, "+");
    expect(dispatchKey(viewportElement, "F").defaultPrevented).toBe(true);
    flushAnimationFrames();
    expect(cameraState(viewportElement)).toEqual({ scale: 0.5, x: -50, y: -50 });
    expect(dispatchKey(viewportElement, "x").defaultPrevented).toBe(false);

    for (let index = 0; index < 20; index += 1) dispatchKey(viewportElement, "+");
    expect(cameraState(viewportElement).scale).toBe(1.5);
    for (let index = 0; index < 30; index += 1) dispatchKey(viewportElement, "-");
    expect(cameraState(viewportElement).scale).toBe(0.5);

    const beforeNestedKeys = cameraState(viewportElement);
    for (const target of [
      container.querySelector<HTMLElement>("[data-camera-interactive]")!,
      screen.getByRole("button", { name: "Action" }),
      screen.getByRole("treeitem"),
    ]) {
      for (const key of ["+", "=", "-", "_", "F", "ArrowRight"]) {
        expect(dispatchKey(target, key).defaultPrevented).toBe(false);
      }
    }
    expect(cameraState(viewportElement)).toEqual(beforeNestedKeys);
  });
});
