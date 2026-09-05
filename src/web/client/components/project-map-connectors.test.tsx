// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ProjectMapConnector,
  ProjectMapConnectors,
} from "./project-map-connectors.js";

const connector: ProjectMapConnector = {
  id: "connection-1",
  fromRecordId: "source-record",
  toRecordId: "target-record",
  label: "Depends on",
  style: "cross",
};

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

function Harness({
  cameraScale = 1,
  connectors = [connector],
  renderedTransform,
  visibleRecordIds = new Set(["source-record", "target-record"]),
}: {
  readonly cameraScale?: number;
  readonly connectors?: readonly ProjectMapConnector[];
  readonly renderedTransform?: string;
  readonly visibleRecordIds?: ReadonlySet<string>;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  return (
    <section
      data-connector-container
      ref={containerRef}
      style={{
        transform: renderedTransform ?? `translate3d(0px, 0px, 0) scale(${cameraScale})`,
      }}
    >
      <article data-connector-record-id="source-record">Source</article>
      <article data-connector-record-id="target-record">Target</article>
      <ProjectMapConnectors
        connectors={connectors}
        containerRef={containerRef}
        visibleRecordIds={visibleRecordIds}
      />
    </section>
  );
}

function ScaleHarness({
  cameraScale = 1,
  count,
}: {
  readonly cameraScale?: number;
  readonly count: number;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const cards = Array.from({ length: count }, (_, index) => `scale-${index}`);
  const connectors = cards.slice(1).map((id, index): ProjectMapConnector => ({
    id: `connector-${index}`,
    fromRecordId: cards[index]!,
    toRecordId: id,
    label: "Depends on",
    style: "cross",
  }));
  return (
    <section
      data-connector-container
      ref={containerRef}
      style={{ transform: `translate3d(0px, 0px, 0) scale(${cameraScale})` }}
    >
      {cards.map((id) => <article data-connector-record-id={id} key={id}>{id}</article>)}
      <ProjectMapConnectors
        connectors={connectors}
        containerRef={containerRef}
        visibleRecordIds={new Set(cards)}
      />
    </section>
  );
}

let resizeCallback: ResizeObserverCallback | null = null;
const observedElements = new Set<Element>();
interface ResizeObserverProbe {
  readonly callback: ResizeObserverCallback;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
}
const resizeObservers: ResizeObserverProbe[] = [];

beforeEach(() => {
  resizeCallback = null;
  observedElements.clear();
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", class ResizeObserverStub implements ResizeObserver {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeCallback = callback;
      resizeObservers.push(this);
    }

    disconnect = vi.fn();
    observe = vi.fn((element: Element) => observedElements.add(element));
    unobserve = vi.fn();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProjectMapConnectors", () => {
  test("keeps world geometry stable while the camera transform interpolates toward its target scale", async () => {
    const renderedScale = 0.9;
    const bounds = new Map<string, DOMRect>([
      ["container", rectangle(100, 50, 800 * renderedScale, 600 * renderedScale)],
      ["source-record", rectangle(
        100 + 40 * renderedScale,
        50 + 50 * renderedScale,
        200 * renderedScale,
        80 * renderedScale,
      )],
      ["target-record", rectangle(
        100 + 400 * renderedScale,
        50 + 200 * renderedScale,
        220 * renderedScale,
        100 * renderedScale,
      )],
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.hasAttribute("data-connector-container")
        ? "container"
        : this.getAttribute("data-connector-record-id") ?? "missing";
      return bounds.get(key) ?? rectangle(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
      return this.hasAttribute("data-connector-container") ? 1_440 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
      return this.hasAttribute("data-connector-container") ? 1_080 : 0;
    });

    const { container } = render(
      <Harness
        cameraScale={0.5}
        renderedTransform={`matrix(${renderedScale}, 0, 0, ${renderedScale}, 0, 0)`}
      />,
    );

    const svg = await waitFor(() => {
      const overlay = container.querySelector("svg");
      expect(overlay).toBeTruthy();
      return overlay!;
    });
    expect(svg.getAttribute("width")).toBe("800");
    expect(svg.getAttribute("height")).toBe("600");
    expect(pathEndpoints(svg.querySelector("path")!)).toEqual([240, 90, 400, 250]);
  });

  test.each([0.5, 1, 1.5])("draws truthful primary and cross paths in world units at scale %s", async (cameraScale) => {
    const bounds = new Map<string, DOMRect>([
      ["container", rectangle(100, 50, 800 * cameraScale, 600 * cameraScale)],
      ["source-record", rectangle(100 + 40 * cameraScale, 50 + 50 * cameraScale, 200 * cameraScale, 80 * cameraScale)],
      ["target-record", rectangle(100 + 400 * cameraScale, 50 + 200 * cameraScale, 220 * cameraScale, 100 * cameraScale)],
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.hasAttribute("data-connector-container")
        ? "container"
        : this.getAttribute("data-connector-record-id") ?? "missing";
      return bounds.get(key) ?? rectangle(0, 0, 0, 0);
    });

    const { container } = render(
      <Harness
        cameraScale={cameraScale}
        connectors={[
          { ...connector, id: "primary-connection", style: "primary" },
          connector,
        ]}
      />,
    );

    const svg = await waitFor(() => {
      const overlay = container.querySelector("svg");
      expect(overlay).toBeTruthy();
      return overlay!;
    });
    const primaryPath = svg.querySelector("[data-connector-id='primary-connection']")!;
    const crossPath = svg.querySelector("[data-connector-id='connection-1']")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.style.pointerEvents).toBe("none");
    expect(primaryPath.getAttribute("d")).toBe("M 140 130 V 165 H 510 V 200");
    expect(pathEndpoints(primaryPath)).toEqual([140, 130, 510, 200]);
    expect(primaryPath.dataset.connectorStyle).toBe("primary");
    expect(primaryPath.style.stroke).toBe("var(--ia-border-strong)");
    expect(primaryPath.style.strokeWidth).toBe("1.75");
    expect(primaryPath.style.vectorEffect).toBe("non-scaling-stroke");
    expect(crossPath.dataset.connectorStyle).toBe("cross");
    expect(crossPath.style.stroke).toBe("var(--ia-text-muted)");
    expect(crossPath.style.strokeDasharray).toBe("6 6");
    expect(crossPath.style.strokeWidth).toBe("1.5");
    expect(crossPath.style.vectorEffect).toBe("non-scaling-stroke");
    expect(container.querySelectorAll("svg.project-map-connectors")).toHaveLength(1);
    expect(observedElements).toEqual(new Set([
      container.querySelector("section"),
      container.querySelector("[data-connector-record-id='source-record']"),
      container.querySelector("[data-connector-record-id='target-record']"),
    ]));

    const initialPath = primaryPath.getAttribute("d");
    bounds.set("target-record", rectangle(100 + 520 * cameraScale, 50 + 310 * cameraScale, 220 * cameraScale, 100 * cameraScale));
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(primaryPath.getAttribute("d")).not.toBe(initialPath));
  });

  test("routes vertically separated cards through their nearest vertical edges", async () => {
    const bounds = new Map<string, DOMRect>([
      ["container", rectangle(0, 0, 800, 600)],
      ["source-record", rectangle(100, 80, 120, 60)],
      ["target-record", rectangle(180, 320, 120, 80)],
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.hasAttribute("data-connector-container")
        ? "container"
        : this.getAttribute("data-connector-record-id") ?? "missing";
      return bounds.get(key) ?? rectangle(0, 0, 0, 0);
    });

    const { container } = render(<Harness />);
    const path = await waitFor(() => {
      const candidate = container.querySelector("path");
      expect(candidate).toBeTruthy();
      return candidate!;
    });

    expect(pathEndpoints(path)).toEqual([160, 140, 240, 320]);
    expect(path.getAttribute("d")).toBe("M 160 140 C 160 230, 240 230, 240 320");
  });

  test("indexes one thousand cards once for linear connector endpoint lookup", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.hasAttribute("data-connector-container")) return rectangle(0, 0, 2_000, 2_000);
      const id = this.getAttribute("data-connector-record-id");
      const index = id === null ? -1 : Number(id.slice("scale-".length));
      return index < 0
        ? rectangle(0, 0, 0, 0)
        : rectangle(index % 100 * 18, Math.floor(index / 100) * 40, 16, 30);
    });
    const query = vi.spyOn(Element.prototype, "querySelectorAll");
    const { container } = render(<ScaleHarness count={1_000} />);

    await waitFor(() => expect(container.querySelectorAll("path")).toHaveLength(999));
    const endpointQueries = query.mock.calls.filter(([selector]) => (
      selector === "[data-connector-record-id]"
    ));
    expect(endpointQueries.length).toBeLessThanOrEqual(1);
  });

  test("omits paths whose endpoints are hidden or missing", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rectangle(0, 0, 600, 400),
    );
    const { container, rerender } = render(
      <Harness visibleRecordIds={new Set(["source-record"])} />,
    );

    expect(container.querySelector("path")).toBeNull();

    rerender(
      <Harness
        connectors={[{ ...connector, toRecordId: "missing-record" }]}
        visibleRecordIds={new Set(["source-record", "missing-record"])}
      />,
    );
    expect(container.querySelector("path")).toBeNull();
  });

  test("shrinks overlay dimensions after endpoint reflow without retaining stale scroll geometry", async () => {
    const bounds = new Map<string, DOMRect>([
      ["container", rectangle(0, 0, 600, 500)],
      ["source-record", rectangle(20, 20, 100, 60)],
      ["target-record", rectangle(760, 420, 140, 80)],
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.hasAttribute("data-connector-container")
        ? "container"
        : this.getAttribute("data-connector-record-id") ?? "missing";
      return bounds.get(key) ?? rectangle(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
      return this.hasAttribute("data-connector-container")
        ? bounds.get("container")!.width
        : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
      return this.hasAttribute("data-connector-container")
        ? bounds.get("container")!.height
        : 0;
    });
    const { container } = render(<Harness />);
    const svg = await waitFor(() => {
      const overlay = container.querySelector("svg");
      expect(overlay?.getAttribute("width")).toBe("900");
      expect(overlay?.getAttribute("height")).toBe("500");
      return overlay!;
    });
    const largePath = svg.querySelector("path")?.getAttribute("d");

    bounds.set("container", rectangle(0, 0, 300, 220));
    bounds.set("target-record", rectangle(170, 100, 100, 60));
    resizeObservers[0]!.callback([], resizeObservers[0] as unknown as ResizeObserver);

    await waitFor(() => {
      expect(svg.getAttribute("width")).toBe("300");
      expect(svg.getAttribute("height")).toBe("220");
      expect(svg.querySelector("path")?.getAttribute("d")).not.toBe(largePath);
    });
  });

  test("reuses identical signatures, removes hidden paths, and disconnects replaced observers", async () => {
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const bounds = new Map<string, DOMRect>([
      ["container", rectangle(0, 0, 600, 400)],
      ["source-record", rectangle(20, 20, 100, 60)],
      ["target-record", rectangle(300, 180, 120, 70)],
    ]);
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function () {
        const key = this.hasAttribute("data-connector-container")
          ? "container"
          : this.getAttribute("data-connector-record-id") ?? "missing";
        return bounds.get(key) ?? rectangle(0, 0, 0, 0);
      });
    const { container, rerender, unmount } = render(
      <Harness
        connectors={[{ ...connector }]}
        visibleRecordIds={new Set(["source-record", "target-record"])}
      />,
    );
    await waitFor(() => expect(container.querySelector("path")).toBeTruthy());
    expect(resizeObservers).toHaveLength(1);
    const initialMeasurementCount = measure.mock.calls.length;
    const initialObserver = resizeObservers[0]!;

    rerender(
      <Harness
        connectors={[{ ...connector }]}
        visibleRecordIds={new Set(["target-record", "source-record"])}
      />,
    );
    expect(resizeObservers).toHaveLength(1);
    expect(measure).toHaveBeenCalledTimes(initialMeasurementCount);
    expect(initialObserver.disconnect).not.toHaveBeenCalled();
    expect(container.querySelector("path")).toBeTruthy();

    rerender(
      <Harness
        connectors={[{ ...connector }]}
        visibleRecordIds={new Set(["source-record"])}
      />,
    );
    await waitFor(() => expect(container.querySelector("path")).toBeNull());
    expect(resizeObservers).toHaveLength(2);
    expect(initialObserver.disconnect).toHaveBeenCalledOnce();

    const replacementObserver = resizeObservers[1]!;
    unmount();
    expect(replacementObserver.disconnect).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  test("updates connector presentation metadata without rebuilding geometry", async () => {
    const query = vi.spyOn(Element.prototype, "querySelectorAll");
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.hasAttribute("data-connector-container")) return rectangle(0, 0, 600, 400);
      if (this.getAttribute("data-connector-record-id") === "source-record") {
        return rectangle(40, 40, 120, 60);
      }
      if (this.getAttribute("data-connector-record-id") === "target-record") {
        return rectangle(300, 180, 120, 60);
      }
      return rectangle(0, 0, 0, 0);
    });
    const { container, rerender } = render(<Harness />);
    await waitFor(() => expect(container.querySelector("path")).toBeTruthy());
    const initialObserver = resizeObservers[0]!;
    const initialMeasurementCount = measure.mock.calls.length;

    rerender(<Harness connectors={[{ ...connector, label: "Blocks", style: "primary" }]} />);

    await waitFor(() => {
      const path = container.querySelector("path")!;
      expect(path.dataset.connectorLabel).toBe("Blocks");
      expect(path.dataset.connectorStyle).toBe("primary");
      expect(path.classList).toContain("project-map-connectors__path--primary");
    });
    expect(resizeObservers).toHaveLength(1);
    expect(initialObserver.disconnect).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledTimes(initialMeasurementCount);

    const presentationPath = container.querySelector("path")!.getAttribute("d");
    query.mockClear();
    measure.mockClear();
    rerender(<Harness connectors={[{
      ...connector,
      fromRecordId: "target-record",
      toRecordId: "source-record",
      label: "Blocks",
      style: "primary",
    }]} />);

    await waitFor(() => {
      expect(container.querySelector("path")?.getAttribute("d")).not.toBe(presentationPath);
    });
    expect(resizeObservers).toHaveLength(2);
    expect(initialObserver.disconnect).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([selector]) => selector === "[data-connector-record-id]"))
      .toHaveLength(1);
    expect(measure.mock.contexts.filter((element) => (
      element instanceof HTMLElement && element.hasAttribute("data-connector-record-id")
    ))).toHaveLength(2);
  });
});
