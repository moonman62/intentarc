import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ConnectedRecordDetailResponse } from "../../contracts.js";
import type { HierarchyRecordSummary } from "./hierarchy-label.js";
import type { CameraInsets } from "./project-map-camera.js";
import { boundedPreview } from "./record-preview.js";

export type ProjectMapInspectorDetailState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string; readonly onRetry: () => void }
  | { readonly status: "ready"; readonly detail: ConnectedRecordDetailResponse };

export interface ProjectMapInspectorProps {
  readonly routeRecordId: string;
  readonly selected: HierarchyRecordSummary | null;
  readonly detailState: ProjectMapInspectorDetailState;
  readonly scopeRecordId: string | null;
  readonly onClose: () => void;
  readonly onFocusBranch: (recordId: string) => void;
  readonly onNavigateAttachment: (path: string) => void;
  readonly onSelectRelated: (recordId: string) => void;
  readonly onOcclusionInsetsChange: (insets: CameraInsets) => void;
  readonly relationshipError?: string | null;
}

const zeroInsets: CameraInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const narrowInspectorQuery = "(max-width: 759px)";
const readable = (value: string): string => value
  .replaceAll("_", " ")
  .replace(/^./, (letter) => letter.toUpperCase());
const isHierarchyKind = (kind: string): boolean => (
  kind === "outcome" ||
  kind === "initiative" ||
  kind === "deliverable" ||
  kind === "milestone" ||
  kind === "task"
);

const currentNarrowLayout = (): boolean => (
  typeof window.matchMedia === "function" && window.matchMedia(narrowInspectorQuery).matches
);

const sameInsets = (left: CameraInsets, right: CameraInsets): boolean => (
  left.top === right.top &&
  left.right === right.right &&
  left.bottom === right.bottom &&
  left.left === right.left
);

const recordSelector = (attribute: string, recordId: string): string => (
  `[${attribute}="${recordId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`
);

export function ProjectMapInspector({
  detailState,
  onClose,
  onFocusBranch,
  onNavigateAttachment,
  onOcclusionInsetsChange,
  onSelectRelated,
  routeRecordId,
  relationshipError = null,
  scopeRecordId,
  selected,
}: ProjectMapInspectorProps) {
  const inspectorRef = useRef<HTMLElement | null>(null);
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const previousInsetsRef = useRef<CameraInsets>(zeroInsets);
  const focusCollapseAfterRenderRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isNarrow, setIsNarrow] = useState(currentNarrowLayout);
  const [cameraHeight, setCameraHeight] = useState(0);
  const [cameraTop, setCameraTop] = useState(0);
  const [selectedIsUnplaced, setSelectedIsUnplaced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(narrowInspectorQuery);
    const onChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
      if (!event.matches) setCollapsed(false);
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useLayoutEffect(() => {
    if (!focusCollapseAfterRenderRef.current) return;
    focusCollapseAfterRenderRef.current = false;
    collapseRef.current?.focus();
  }, [collapsed]);

  useLayoutEffect(() => {
    setSelectedIsUnplaced(document.querySelector(
      recordSelector("data-unplaced-record-id", routeRecordId),
    ) !== null);
  }, [routeRecordId, selected]);

  useLayoutEffect(() => {
    const inspector = inspectorRef.current;
    const shell = inspector === null
      ? null
      : inspector.closest<HTMLElement>(".project-map__canvas-shell");
    const camera = shell?.querySelector<HTMLElement>(".project-map-camera__viewport") ?? null;
    if (inspector === null || shell === null || camera === null) return;

    const measure = () => {
      const cameraBounds = camera.getBoundingClientRect();
      const inspectorBounds = inspector.getBoundingClientRect();
      const shellBounds = shell.getBoundingClientRect();
      setCameraHeight((current) => current === cameraBounds.height ? current : cameraBounds.height);
      const nextCameraTop = Math.max(0, cameraBounds.top - shellBounds.top);
      setCameraTop((current) => current === nextCameraTop ? current : nextCameraTop);
      const overlapsHorizontally = inspectorBounds.right > cameraBounds.left &&
        inspectorBounds.left < cameraBounds.right;
      const overlapsVertically = inspectorBounds.bottom > cameraBounds.top &&
        inspectorBounds.top < cameraBounds.bottom;
      const nextInsets: CameraInsets = isNarrow
        ? {
            top: 0,
            right: 0,
            bottom: overlapsHorizontally && overlapsVertically
              ? Math.max(0, cameraBounds.bottom - Math.max(cameraBounds.top, inspectorBounds.top))
              : 0,
            left: 0,
          }
        : {
            top: 0,
            right: overlapsHorizontally && overlapsVertically
              ? Math.max(0, cameraBounds.right - Math.max(cameraBounds.left, inspectorBounds.left))
              : 0,
            bottom: 0,
            left: 0,
          };
      if (sameInsets(previousInsetsRef.current, nextInsets)) return;
      previousInsetsRef.current = nextInsets;
      onOcclusionInsetsChange(nextInsets);
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(inspector);
    observer.observe(camera);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [collapsed, isNarrow, onOcclusionInsetsChange, routeRecordId, scopeRecordId]);

  useLayoutEffect(() => () => {
    previousInsetsRef.current = zeroInsets;
    onOcclusionInsetsChange(zeroInsets);
  }, [onOcclusionInsetsChange]);

  const title = selected?.title ?? "Loading selected item…";
  const status = detailState.status === "loading"
    ? selected === null
      ? "Loading selected item…"
      : `Loading ${selected.title} details…`
    : detailState.status === "error"
      ? "Selected item details unavailable"
      : `${readable(detailState.detail.record.kind)} · ${readable(detailState.detail.record.status)}`;
  const style = {
    "--project-map-inspector-camera-height": `${cameraHeight}px`,
    "--project-map-inspector-camera-top": `${cameraTop}px`,
    "--project-map-inspector-sheet-max-height": `${cameraHeight * 0.6}px`,
  } as CSSProperties;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  return (
    <aside
      aria-busy={detailState.status === "loading"}
      aria-label="Selected item details"
      className="project-map-inspector project-map__detail"
      data-collapsed={isNarrow && collapsed}
      data-layout={isNarrow ? "narrow" : "wide"}
      onKeyDown={handleKeyDown}
      ref={inspectorRef}
      style={style}
    >
      <header className="project-map-inspector__header" data-testid="project-map-inspector-header">
        <div className="project-map-inspector__title">
          <h2>{title}</h2>
          {selected === null ? <code>{routeRecordId}</code> : null}
          {detailState.status === "loading" ? <span role="status">{status}</span> : <span>{status}</span>}
        </div>
        <div className="project-map-inspector__header-actions">
          {isNarrow ? (
            <button
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand details" : "Collapse details"}
              onClick={() => {
                focusCollapseAfterRenderRef.current = true;
                setCollapsed((current) => !current);
              }}
              ref={collapseRef}
              type="button"
            >
              {collapsed ? "Expand" : "Collapse"}
            </button>
          ) : null}
          <button aria-label="Close details" onClick={onClose} type="button">Close</button>
        </div>
      </header>
      <div
        aria-label="Selected item detail content"
        className="project-map-inspector__body"
        hidden={isNarrow && collapsed}
        role="region"
        tabIndex={0}
      >
        {detailState.status === "error" ? (
          <div role="alert">
            <p>{detailState.message}</p>
            <button onClick={detailState.onRetry} type="button">Retry</button>
          </div>
        ) : null}
        {relationshipError !== null ? <p role="alert">{relationshipError}</p> : null}
        {detailState.status === "ready" ? (
          <SelectedRecordDetail
            detail={detailState.detail}
            onNavigateAttachment={onNavigateAttachment}
            onSelectRelated={onSelectRelated}
            primaryParentLabel={selectedIsUnplaced
              ? "No accepted primary parent · Unplaced work"
              : primaryParentLabel(detailState.detail, scopeRecordId)}
          />
        ) : null}
        {selected !== null && !selectedIsUnplaced ? (
          <button onClick={() => onFocusBranch(selected.id)} type="button">Focus branch</button>
        ) : null}
      </div>
    </aside>
  );
}

const primaryParentLabel = (
  detail: ConnectedRecordDetailResponse,
  scopeRecordId: string | null,
): string => {
  const parent = detail.relations.find((relation) => (
    relation.depth === 1 &&
    relation.edge.kind === "parent_of" &&
    relation.edge.toRecordId === detail.record.id
  ));
  return parent?.record.title ?? (scopeRecordId === null ? "Project" : scopeRecordId);
};

function SelectedRecordDetail({
  detail,
  onNavigateAttachment,
  onSelectRelated,
  primaryParentLabel: parentLabel,
}: {
  readonly detail: ConnectedRecordDetailResponse;
  readonly onNavigateAttachment: (path: string) => void;
  readonly onSelectRelated: (recordId: string) => void;
  readonly primaryParentLabel: string;
}) {
  const directRelations = detail.relations.filter((relation) => (
    relation.depth === 1 && relation.edge.kind !== "parent_of"
  ));
  return (
    <div>
      <p>{readable(detail.record.kind)} · {readable(detail.record.status)}</p>
      {detail.record.body ? <p>{boundedPreview(detail.record.body)}</p> : null}
      <dl><div><dt>Primary parent</dt><dd>{parentLabel}</dd></div></dl>
      {directRelations.length > 0 ? (
        <section aria-label="Direct cross-links">
          <h3>Direct cross-links</h3>
          <ul>{directRelations.map((relation) => (
            <DirectRelation
              key={relation.edge.id}
              onSelectRelated={onSelectRelated}
              relation={relation}
            />
          ))}</ul>
        </section>
      ) : null}
      <RecordAttachments
        attachmentsByBasis={detail.attachmentsByBasis}
        onNavigate={onNavigateAttachment}
        projectId={detail.projectId}
      />
    </div>
  );
}

function DirectRelation({
  onSelectRelated,
  relation,
}: {
  readonly onSelectRelated: (recordId: string) => void;
  readonly relation: ConnectedRecordDetailResponse["relations"][number];
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const directionLabel = relation.edge.label.replace(/^./, (letter) => letter.toLocaleLowerCase());
  const selectable = isHierarchyKind(relation.record.kind);
  return (
    <li data-relationship-id={relation.edge.id}>
      <p className="project-map__relationship-ledger-line">
        {`${relation.edge.fromLabel} — ${directionLabel} — ${relation.edge.toLabel}`}
      </p>
      <p className="project-map__relationship-summary">
        {relation.edge.label} · {relation.record.title} · {readable(relation.record.status)}
      </p>
      {selectable ? (
        <button
          aria-label={`Select related ${relation.record.title}`}
          onClick={() => onSelectRelated(relation.record.id)}
          type="button"
        >
          Select
        </button>
      ) : (
        <>
          <button
            aria-expanded={detailOpen}
            aria-label={`${detailOpen ? "Hide" : "Show"} related ${relation.record.title}`}
            onClick={() => setDetailOpen((open) => !open)}
            type="button"
          >
            {detailOpen ? "Hide detail" : "Show detail"}
          </button>
          {detailOpen ? (
            <div aria-label={`Related item ${relation.record.title}`} className="project-map__related-detail" role="group">
              <strong>{relation.record.title}</strong>
              <p>{readable(relation.record.kind)} · {readable(relation.record.status)}</p>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

function RecordAttachments({
  attachmentsByBasis,
  onNavigate,
  projectId,
}: {
  readonly attachmentsByBasis: ConnectedRecordDetailResponse["attachmentsByBasis"];
  readonly onNavigate: (path: string) => void;
  readonly projectId: string;
}) {
  const attachments = attachmentsByBasis.accepted;
  if (attachments.length === 0) return null;
  return (
    <section aria-label="Record attachments" className="project-map__attachments">
      <h3>Attachments</h3>
      <section
        aria-label="Accepted attachments"
        className="project-map__attachment-group project-map__attachment-group--accepted"
      >
        <h4>Accepted attachments</h4>
        <ul>{attachments.map((attachment) => (
          <li data-attachment-link-id={attachment.linkId} key={attachment.linkId}>
            <strong className="project-map__attachment-path">{attachment.path}</strong>
            <p>Accepted basis · {readable(attachment.linkKind)}</p>
            <p>
              {readable(attachment.nodeKind)} · {readable(attachment.role)}
              {attachment.documentKind === null ? "" : ` · ${readable(attachment.documentKind)}`}
              {attachment.documentFormat === null ? "" : ` · ${readable(attachment.documentFormat)}`}
            </p>
            <div className="project-map__attachment-actions">
              <AttachmentLink
                href={`/projects/${encodeURIComponent(projectId)}/repository?nodeId=${encodeURIComponent(attachment.nodeId)}`}
                onNavigate={onNavigate}
              >
                Repository
              </AttachmentLink>
              {attachment.documentKind !== null || attachment.linkKind === "documents" ? (
                <AttachmentLink
                  href={`/projects/${encodeURIComponent(projectId)}/documentation/${encodeURIComponent(attachment.nodeId)}`}
                  onNavigate={onNavigate}
                >
                  Documentation
                </AttachmentLink>
              ) : null}
            </div>
          </li>
        ))}</ul>
      </section>
    </section>
  );
}

function AttachmentLink({
  children,
  href,
  onNavigate,
}: {
  readonly children: string;
  readonly href: string;
  readonly onNavigate: (path: string) => void;
}) {
  const followRoute = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (event.currentTarget.target !== "" && event.currentTarget.target !== "_self")
    ) return;
    event.preventDefault();
    onNavigate(href);
  };
  return <a href={href} onClick={followRoute}>{children}</a>;
}
