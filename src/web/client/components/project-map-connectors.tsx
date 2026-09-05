import {
  type JSX,
  memo,
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from "react";
import { readProjectMapRenderedCamera } from "./project-map-rendered-camera.js";

export interface ProjectMapConnector {
  readonly id: string;
  readonly fromRecordId: string;
  readonly toRecordId: string;
  readonly label: string;
  readonly style: "primary" | "cross";
}

interface ConnectorPath {
  readonly crossPath: string;
  readonly id: string;
  readonly primaryPath: string;
}

interface ConnectorLayout {
  readonly height: number;
  readonly paths: readonly ConnectorPath[];
  readonly width: number;
}

const coordinate = (value: number): number => Math.round(value * 100) / 100;

const sameLayout = (
  left: ConnectorLayout | null,
  right: ConnectorLayout,
): boolean => left !== null && (
  left.width === right.width &&
  left.height === right.height &&
  left.paths.length === right.paths.length &&
  left.paths.every((path, index) => {
    const candidate = right.paths[index];
    return candidate !== undefined &&
      path.id === candidate.id &&
      path.crossPath === candidate.crossPath &&
      path.primaryPath === candidate.primaryPath;
  })
);

export const ProjectMapConnectors = memo(function ProjectMapConnectors({
  containerRef,
  connectors,
  visibleRecordIds,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly connectors: readonly ProjectMapConnector[];
  readonly visibleRecordIds: ReadonlySet<string>;
}): JSX.Element | null {
  const [layout, setLayout] = useState<ConnectorLayout | null>(null);
  const connectorsById = useMemo(
    () => new Map(connectors.map((connector) => [connector.id, connector])),
    [connectors],
  );
  const connectorGeometrySignature = useMemo(() => JSON.stringify(connectors.map((connector) => [
    connector.id,
    connector.fromRecordId,
    connector.toRecordId,
  ])), [connectors]);
  const visibilitySignature = useMemo(
    () => JSON.stringify([...visibleRecordIds].sort()),
    [visibleRecordIds],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      setLayout(null);
      return;
    }

    const cardsByRecordId = new Map<string, HTMLElement>();
    for (const card of container.querySelectorAll<HTMLElement>("[data-connector-record-id]")) {
      const recordId = card.dataset.connectorRecordId;
      if (recordId !== undefined && !cardsByRecordId.has(recordId)) {
        cardsByRecordId.set(recordId, card);
      }
    }
    const endpointCards = new Set<HTMLElement>();
    for (const connector of connectors) {
      if (
        !visibleRecordIds.has(connector.fromRecordId) ||
        !visibleRecordIds.has(connector.toRecordId)
      ) continue;
      const from = cardsByRecordId.get(connector.fromRecordId) ?? null;
      const to = cardsByRecordId.get(connector.toRecordId) ?? null;
      if (from !== null) endpointCards.add(from);
      if (to !== null) endpointCards.add(to);
    }

    const measure = () => {
      const containerBounds = container.getBoundingClientRect();
      const renderedScale = readProjectMapRenderedCamera(container)?.scale ?? 1;
      let width = containerBounds.width / renderedScale;
      let height = containerBounds.height / renderedScale;
      const paths: ConnectorPath[] = [];

      if (width > 0 && height > 0) {
        for (const connector of connectors) {
          if (
            !visibleRecordIds.has(connector.fromRecordId) ||
            !visibleRecordIds.has(connector.toRecordId)
          ) continue;
          const from = cardsByRecordId.get(connector.fromRecordId) ?? null;
          const to = cardsByRecordId.get(connector.toRecordId) ?? null;
          if (from === null || to === null) continue;
          const fromBounds = from.getBoundingClientRect();
          const toBounds = to.getBoundingClientRect();
          if (
            fromBounds.width <= 0 || fromBounds.height <= 0 ||
            toBounds.width <= 0 || toBounds.height <= 0
          ) continue;

          const fromRect = {
            height: fromBounds.height / renderedScale,
            left: (fromBounds.left - containerBounds.left) / renderedScale,
            top: (fromBounds.top - containerBounds.top) / renderedScale,
            width: fromBounds.width / renderedScale,
          };
          const toRect = {
            height: toBounds.height / renderedScale,
            left: (toBounds.left - containerBounds.left) / renderedScale,
            top: (toBounds.top - containerBounds.top) / renderedScale,
            width: toBounds.width / renderedScale,
          };
          width = Math.max(width, fromRect.left + fromRect.width, toRect.left + toRect.width);
          height = Math.max(height, fromRect.top + fromRect.height, toRect.top + toRect.height);
          const fromCenterX = fromRect.left + fromRect.width / 2;
          const fromCenterY = fromRect.top + fromRect.height / 2;
          const toCenterX = toRect.left + toRect.width / 2;
          const toCenterY = toRect.top + toRect.height / 2;
          const primaryStartX = coordinate(fromCenterX);
          const primaryStartY = coordinate(fromRect.top + fromRect.height);
          const primaryEndX = coordinate(toCenterX);
          const primaryEndY = coordinate(toRect.top);
          const primaryMiddleY = coordinate((primaryStartY + primaryEndY) / 2);
          const horizontal = Math.abs(toCenterX - fromCenterX) >= Math.abs(toCenterY - fromCenterY);
          const startX = coordinate(horizontal
            ? (toCenterX >= fromCenterX ? fromRect.left + fromRect.width : fromRect.left)
            : fromCenterX);
          const startY = coordinate(horizontal
            ? fromCenterY
            : (toCenterY >= fromCenterY ? fromRect.top + fromRect.height : fromRect.top));
          const endX = coordinate(horizontal
            ? (toCenterX >= fromCenterX ? toRect.left : toRect.left + toRect.width)
            : toCenterX);
          const endY = coordinate(horizontal
            ? toCenterY
            : (toCenterY >= fromCenterY ? toRect.top : toRect.top + toRect.height));
          const middle = coordinate(horizontal
            ? (startX + endX) / 2
            : (startY + endY) / 2);
          paths.push({
            crossPath: horizontal
              ? `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`
              : `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`,
            id: connector.id,
            primaryPath: [
              `M ${primaryStartX} ${primaryStartY}`,
              `V ${primaryMiddleY}`,
              `H ${primaryEndX}`,
              `V ${primaryEndY}`,
            ].join(" "),
          });
        }
      }

      const nextLayout = {
        height: coordinate(height),
        paths,
        width: coordinate(width),
      };
      setLayout((current) => sameLayout(current, nextLayout) ? current : nextLayout);
    };

    measure();
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const card of endpointCards) observer.observe(card);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [connectorGeometrySignature, containerRef, visibilitySignature]);

  if (layout === null || layout.paths.length === 0) return null;
  return (
    <svg
      aria-hidden="true"
      className="project-map-connectors"
      focusable="false"
      height={layout.height}
      style={{ pointerEvents: "none" }}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      {layout.paths.flatMap((path) => {
        const connector = connectorsById.get(path.id);
        return connector === undefined ? [] : [(
          <path
            className={`project-map-connectors__path project-map-connectors__path--${connector.style}`}
            d={connector.style === "primary" ? path.primaryPath : path.crossPath}
            data-connector-id={connector.id}
            data-connector-label={connector.label}
            data-connector-style={connector.style}
            key={connector.id}
            style={connector.style === "primary"
              ? {
                  stroke: "var(--ia-border-strong)",
                  strokeWidth: 1.75,
                  vectorEffect: "non-scaling-stroke",
                }
              : {
                  stroke: "var(--ia-text-muted)",
                  strokeDasharray: "6 6",
                  strokeWidth: 1.5,
                  vectorEffect: "non-scaling-stroke",
                }}
          />
        )];
      })}
    </svg>
  );
});
