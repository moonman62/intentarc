import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectMapResponse } from "../../contracts.js";
import {
  type HierarchyRecordSummary,
  hierarchyLabel,
} from "./hierarchy-label.js";
import {
  type ProjectMapConnector,
  ProjectMapConnectors,
} from "./project-map-connectors.js";
import {
  type ProjectMapCameraInputs,
  ProjectMapCameraCanvas,
  useProjectMapCameraWorldRef,
} from "./project-map-camera-canvas.js";
import {
  layoutProjectMapTree,
  type ProjectMapTreeLayout,
} from "./project-map-tree-layout.js";

type HierarchyVocabulary = ProjectMapResponse["hierarchyVocabulary"];

export interface HierarchyDisplayNode {
  readonly record: HierarchyRecordSummary;
  readonly parentId: string | null;
  readonly depth: number;
  readonly childCount: number;
  readonly hiddenChildCount: number;
  readonly childrenExpanded: boolean;
}

export interface ProjectHierarchyViewProps extends ProjectMapCameraInputs {
  readonly cameraFitRequestKey: number;
  /**
   * Correctness-critical structural generation. Change it whenever hierarchy
   * membership, expansion, scope, or vocabulary can change measured geometry;
   * cosmetic rerenders must leave it stable so the camera does not jump.
   */
  readonly cameraLayoutRevision: number | string;
  readonly project: { readonly id: string; readonly name: string };
  readonly vocabulary: HierarchyVocabulary;
  readonly nodes: readonly HierarchyDisplayNode[];
  readonly selectedId: string | null;
  readonly scopeRecordId: string | null;
  readonly scopePath: readonly HierarchyRecordSummary[];
  readonly connections: readonly ProjectMapConnector[];
  readonly showConnections: boolean;
  readonly onSelectProject: () => void;
  readonly onSelect: (recordId: string) => void;
  readonly onShowWholeProject: () => void;
  readonly onExpandedChange: (recordId: string, expanded: boolean) => void;
}

interface LayoutItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly order: number;
}

interface MeasuredLayout extends ProjectMapTreeLayout {
  readonly revision: number;
}

const EMPTY_LAYOUT: MeasuredLayout = {
  positions: new Map(),
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  revision: 0,
};
const NARROW_QUERY = "(max-width: 759px)";
const LAYOUT_OPTIONS = { siblingGap: 24, subtreeGap: 40, levelGap: 72 };
const OUTLINE_INDENT_STEP = 16;
const OUTLINE_MAX_INDENT = 128;
const SELECTED_ANCESTOR_COLLAPSE_REASON =
  "Collapse is unavailable while this branch contains the selected item.";

export const projectConnectorEndpointId = (projectId: string): string =>
  `project:${projectId}`;

const sameMeasuredLayout = (
  current: MeasuredLayout,
  next: ProjectMapTreeLayout,
): boolean => {
  if (
    current.bounds.x !== next.bounds.x ||
    current.bounds.y !== next.bounds.y ||
    current.bounds.width !== next.bounds.width ||
    current.bounds.height !== next.bounds.height ||
    current.positions.size !== next.positions.size
  ) return false;
  for (const [id, position] of next.positions) {
    const existing = current.positions.get(id);
    if (
      existing === undefined ||
      existing.x !== position.x ||
      existing.y !== position.y ||
      existing.width !== position.width ||
      existing.height !== position.height ||
      existing.depth !== position.depth
    ) return false;
  }
  return true;
};

const measuredSize = (element: HTMLElement): { width: number; height: number } | null => {
  const bounds = element.getBoundingClientRect();
  const width = element.offsetWidth || bounds.width;
  const height = element.offsetHeight || bounds.height;
  return width > 0 && height > 0 ? { width, height } : null;
};

const useNarrowOutline = (): boolean => {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_QUERY).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return narrow;
};

function ProjectHierarchyCameraContents({
  children,
  connectors,
  layoutRevision,
  visibleRecordIds,
}: {
  readonly children: ReactNode;
  readonly connectors: readonly ProjectMapConnector[];
  readonly layoutRevision: number;
  readonly visibleRecordIds: ReadonlySet<string>;
}) {
  const worldRef = useProjectMapCameraWorldRef();
  return (
    <>
      {children}
      <ProjectMapConnectors
        connectors={connectors}
        containerRef={worldRef}
        key={layoutRevision}
        visibleRecordIds={visibleRecordIds}
      />
    </>
  );
}

const selectedPath = (
  selectedId: string | null,
  nodesById: ReadonlyMap<string, HierarchyDisplayNode>,
): ReadonlySet<string> => {
  const path = new Set<string>();
  let currentId = selectedId;
  while (currentId !== null && !path.has(currentId)) {
    const current = nodesById.get(currentId);
    if (current === undefined) break;
    path.add(currentId);
    currentId = current.parentId;
  }
  return path;
};

export function ProjectHierarchyView({
  activeRootId,
  cameraFitRequestKey,
  cameraLayoutRevision,
  focusRequestKey,
  occlusionInsets,
  revealRecordId,
  project,
  vocabulary,
  nodes,
  connections,
  selectedId,
  scopeRecordId,
  showConnections,
  onSelectProject,
  onSelect,
  onShowWholeProject,
  scopePath,
  onExpandedChange,
}: ProjectHierarchyViewProps) {
  const selectedAncestorCollapseReasonId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [measuredLayout, setMeasuredLayout] = useState<MeasuredLayout>(EMPTY_LAYOUT);
  const isNarrowOutline = useNarrowOutline();
  const projectRef = useRef<HTMLLIElement>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const layoutRefs = useRef(new Map<string, HTMLLIElement>());
  const layoutGenerationRef = useRef(0);
  const typeaheadRef = useRef({ at: 0, value: "" });
  const wholeProject = scopeRecordId === null;
  const projectEndpointId = projectConnectorEndpointId(project.id);
  const structuralNodesRef = useRef(nodes);
  structuralNodesRef.current = nodes;
  let expansionStateSignature = "";
  for (const node of nodes) expansionStateSignature += node.childrenExpanded ? "1" : "0";
  const {
    childrenByParent,
    nodesById,
    primaryTargetIds,
    renderedIds,
    renderedIndexById,
    renderedNodes,
    visibleConnectorRecordIds,
    primaryConnectors,
  } = useMemo(() => {
    const structuralNodes = structuralNodesRef.current;
    const nextNodesById = new Map(structuralNodes.map((node) => [node.record.id, node]));
    const visibleIds = new Set(structuralNodes.map((node) => node.record.id));
    const nextChildrenByParent = new Map<string | null, HierarchyDisplayNode[]>();
    for (const node of structuralNodes) {
      const parentId = node.parentId !== null && visibleIds.has(node.parentId)
        ? node.parentId
        : null;
      const children = nextChildrenByParent.get(parentId) ?? [];
      children.push(node);
      nextChildrenByParent.set(parentId, children);
    }

    const nextRenderedNodes: HierarchyDisplayNode[] = [];
    const traversal = [...(nextChildrenByParent.get(null) ?? [])].reverse();
    while (traversal.length > 0) {
      const node = traversal.pop()!;
      nextRenderedNodes.push(node);
      const children = nextChildrenByParent.get(node.record.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        traversal.push(children[index]!);
      }
    }
    const nextRenderedIds = new Set(nextRenderedNodes.map((node) => node.record.id));
    const nextRenderedIndexById = new Map(
      nextRenderedNodes.map((node, index) => [node.record.id, index]),
    );
    const labelForNode = (node: HierarchyDisplayNode): string => {
      const parent = node.parentId === null
        ? null
        : nextNodesById.get(node.parentId) ?? null;
      return hierarchyLabel(node.record, parent?.record ?? null, vocabulary);
    };
    const primaryConnectors = nextRenderedNodes.flatMap((node): ProjectMapConnector[] => {
      const parent = node.parentId === null
        ? null
        : nextNodesById.get(node.parentId) ?? null;
      const fromRecordId = node.parentId === null
        ? (wholeProject ? projectEndpointId : null)
        : (nextRenderedIds.has(node.parentId) ? node.parentId : null);
      return fromRecordId === null ? [] : [{
        id: `primary:${fromRecordId}:${node.record.id}`,
        fromRecordId,
        toRecordId: node.record.id,
        label: `Primary hierarchy connection from ${parent === null
          ? `Project ${project.name}`
          : `${labelForNode(parent)} ${parent.record.title}`} to ${labelForNode(node)} ${node.record.title}`,
        style: "primary",
      }];
    });
    const nextVisibleConnectorRecordIds = new Set(nextRenderedIds);
    if (wholeProject) nextVisibleConnectorRecordIds.add(projectEndpointId);
    return {
      childrenByParent: nextChildrenByParent,
      nodesById: nextNodesById,
      primaryTargetIds: new Set(primaryConnectors.map((connector) => connector.toRecordId)),
      renderedIds: nextRenderedIds,
      renderedIndexById: nextRenderedIndexById,
      renderedNodes: nextRenderedNodes,
      visibleConnectorRecordIds: nextVisibleConnectorRecordIds,
      primaryConnectors,
    };
  }, [cameraLayoutRevision, expansionStateSignature, project.name, projectEndpointId, vocabulary, wholeProject]);

  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const connectionSignature = connections
    .map((connection) => `${connection.id}:${connection.fromRecordId}:${connection.toRecordId}:${connection.style}`)
    .join("|");
  const visibleConnectors = useMemo(() => [
    ...primaryConnectors,
    ...(showConnections ? connectionsRef.current : []),
  ], [connectionSignature, primaryConnectors, showConnections]);

  const layoutItems = useMemo((): readonly LayoutItem[] => [
    ...(wholeProject ? [{ id: projectEndpointId, parentId: null, order: 0 }] : []),
    ...renderedNodes.map((node, index) => ({
      id: node.record.id,
      parentId: node.parentId !== null && renderedIds.has(node.parentId)
        ? node.parentId
        : (wholeProject ? projectEndpointId : null),
      order: index + (wholeProject ? 1 : 0),
    })),
  ], [projectEndpointId, renderedIds, renderedNodes, wholeProject]);
  const layoutSignature = useMemo(() => layoutItems
    .map((item) => `${item.id}:${item.parentId ?? "root"}:${item.order}`)
    .join("|"), [layoutItems]);
  const layoutItemsRef = useRef(layoutItems);
  layoutItemsRef.current = layoutItems;

  useLayoutEffect(() => {
    const generation = ++layoutGenerationRef.current;
    if (isNarrowOutline) return;
    const generationItems = layoutItemsRef.current;
    const measure = () => {
      if (layoutGenerationRef.current !== generation) return;
      const measuredNodes = [];
      for (const item of generationItems) {
        const element = layoutRefs.current.get(item.id);
        if (element === undefined) return;
        const size = measuredSize(element);
        if (size === null) return;
        measuredNodes.push({ ...item, ...size });
      }
      const next = layoutProjectMapTree(measuredNodes, LAYOUT_OPTIONS);
      if (layoutGenerationRef.current !== generation) return;
      setMeasuredLayout((current) => sameMeasuredLayout(current, next)
        ? current
        : { ...next, revision: current.revision + 1 });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        if (layoutGenerationRef.current === generation) layoutGenerationRef.current += 1;
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    for (const item of generationItems) {
      const element = layoutRefs.current.get(item.id);
      if (element !== undefined) observer.observe(element);
    }
    return () => {
      if (layoutGenerationRef.current === generation) layoutGenerationRef.current += 1;
      observer.disconnect();
    };
  }, [isNarrowOutline, layoutSignature]);

  const retainedPath = selectedPath(selectedId, nodesById);
  const collapseProtected = (node: HierarchyDisplayNode): boolean => (
    selectedId !== null && node.record.id !== selectedId && retainedPath.has(node.record.id)
  );
  const childrenExpanded = (node: HierarchyDisplayNode): boolean => (
    collapseProtected(node)
      ? (childrenByParent.get(node.record.id)?.length ?? 0) > 0
      : node.childrenExpanded
  );
  const defaultTabStopId = wholeProject ? null : renderedNodes[0]?.record.id ?? null;
  const tabStopId = activeId !== null && renderedIds.has(activeId) ? activeId : defaultTabStopId;

  const labelFor = (node: HierarchyDisplayNode): string => {
    const parent = node.parentId === null ? null : nodesById.get(node.parentId) ?? null;
    return hierarchyLabel(node.record, parent?.record ?? null, vocabulary);
  };

  const focusItem = (recordId: string | null) => {
    setActiveId(recordId);
    if (recordId === null) projectRef.current?.focus();
    else itemRefs.current.get(recordId)?.focus();
  };

  const focusTypeaheadMatch = (
    event: KeyboardEvent<HTMLLIElement>,
    currentId: string | null,
  ): boolean => {
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return false;
    const key = event.key.toLocaleLowerCase();
    if (key === " ") return false;
    const now = Date.now();
    const previous = typeaheadRef.current;
    const value = now - previous.at > 500 || previous.value === key
      ? key
      : `${previous.value}${key}`;
    typeaheadRef.current = { at: now, value };
    const choices = [
      ...(wholeProject ? [{ id: null, title: project.name }] : []),
      ...renderedNodes.map((node) => ({ id: node.record.id, title: node.record.title })),
    ];
    const currentIndex = choices.findIndex((choice) => choice.id === currentId);
    for (let offset = 1; offset <= choices.length; offset += 1) {
      const choice = choices[(currentIndex + offset + choices.length) % choices.length]!;
      if (choice.title.toLocaleLowerCase().startsWith(value)) {
        event.preventDefault();
        focusItem(choice.id);
        return true;
      }
    }
    return false;
  };

  const handleProjectKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectProject();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      const first = renderedNodes[0];
      if (first === undefined) return;
      event.preventDefault();
      focusItem(first.record.id);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusItem(null);
      return;
    }
    if (event.key === "End" && renderedNodes.length > 0) {
      event.preventDefault();
      focusItem(renderedNodes.at(-1)!.record.id);
      return;
    }
    focusTypeaheadMatch(event, null);
  };

  const handleKey = (event: KeyboardEvent<HTMLLIElement>, node: HierarchyDisplayNode) => {
    if (event.target !== event.currentTarget) return;
    const index = renderedIndexById.get(node.record.id);
    if (index === undefined) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(node.record.id);
      return;
    }
    if (event.key === "ArrowRight") {
      const children = childrenByParent.get(node.record.id) ?? [];
      if (node.childCount + node.hiddenChildCount === 0) return;
      event.preventDefault();
      if (!childrenExpanded(node)) onExpandedChange(node.record.id, true);
      else if (children.length > 0) focusItem(children[0]!.record.id);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (childrenExpanded(node) && !collapseProtected(node)) {
        event.preventDefault();
        onExpandedChange(node.record.id, false);
      } else if (node.parentId === null && wholeProject) {
        event.preventDefault();
        focusItem(null);
      } else if (node.parentId !== null && renderedIds.has(node.parentId)) {
        event.preventDefault();
        focusItem(node.parentId);
      }
      return;
    }
    let nextIndex = index;
    if (event.key === "ArrowDown") nextIndex = Math.min(renderedNodes.length - 1, index + 1);
    else if (event.key === "ArrowUp" && index === 0) {
      event.preventDefault();
      if (wholeProject) focusItem(null);
      return;
    } else if (event.key === "ArrowUp") nextIndex = index - 1;
    else if (event.key === "Home") {
      event.preventDefault();
      focusItem(wholeProject ? null : (renderedNodes[0]?.record.id ?? null));
      return;
    } else if (event.key === "End") nextIndex = renderedNodes.length - 1;
    else {
      focusTypeaheadMatch(event, node.record.id);
      return;
    }
    event.preventDefault();
    focusItem(renderedNodes[nextIndex]!.record.id);
  };

  const positionStyle = (id: string, visualDepth: number): CSSProperties => {
    const position = measuredLayout.positions.get(id);
    const outlineIndent = Math.min(visualDepth * OUTLINE_INDENT_STEP, OUTLINE_MAX_INDENT);
    return {
      "--project-hierarchy-depth": visualDepth,
      "--project-hierarchy-outline-indent": `${outlineIndent}px`,
      marginInlineStart: isNarrowOutline ? `${outlineIndent}px` : undefined,
      transform: !isNarrowOutline && position !== undefined
        ? `translate(${position.x}px, ${position.y}px)`
        : undefined,
      width: isNarrowOutline ? `calc(100% - ${outlineIndent}px)` : undefined,
    } as CSSProperties;
  };
  const treeStyle = isNarrowOutline
    ? { width: "100%" }
    : measuredLayout.positions.size > 0
      ? { height: measuredLayout.bounds.height, width: measuredLayout.bounds.width }
      : undefined;

  return (
    <section
      aria-label={`${project.name} project hierarchy`}
      className="project-hierarchy"
      data-scope-record-id={scopeRecordId ?? undefined}
      role="region"
    >
      {selectedId !== null ? (
        <p className="sr-only" id={selectedAncestorCollapseReasonId}>
          {SELECTED_ANCESTOR_COLLAPSE_REASON}
        </p>
      ) : null}
      {wholeProject ? (
        <p className="project-hierarchy__scope-context">
          <span>Scope</span>
          Whole Project
        </p>
      ) : (
        <nav aria-label="Focused project context" className="project-hierarchy__scope-context">
          <span>Scope</span>
          <strong>Project {project.name}</strong>
          <ol>{scopePath.map((record) => <li key={record.id}>{record.title}</li>)}</ol>
          <button onClick={onShowWholeProject} type="button">Show whole project</button>
        </nav>
      )}
      <section aria-label={`${project.name} project map canvas`} role="region">
        <ProjectMapCameraCanvas
          activeRootId={activeRootId}
          ariaLabel={`${project.name} project map canvas`}
          fitRequestKey={cameraFitRequestKey}
          focusRequestKey={focusRequestKey}
          layoutRevision={`${cameraLayoutRevision}:${measuredLayout.revision}`}
          measuredLayoutRevision={measuredLayout.revision}
          occlusionInsets={occlusionInsets}
          projectId={project.id}
          revealRecordId={revealRecordId}
          scopeRecordId={scopeRecordId}
          structuralLayoutRevision={cameraLayoutRevision}
        >
          <ProjectHierarchyCameraContents
            connectors={visibleConnectors}
            layoutRevision={measuredLayout.revision}
            visibleRecordIds={visibleConnectorRecordIds}
          >
            <ul
              aria-label={`${project.name} hierarchy tree`}
              className="project-hierarchy__root-list"
              data-layout-mode={isNarrowOutline ? "outline" : "top-down"}
              data-layout-revision={measuredLayout.revision}
              role="tree"
              style={treeStyle}
            >
              {wholeProject ? (() => {
                const position = measuredLayout.positions.get(projectEndpointId);
                return (
                  <li
                    aria-level={1}
                    aria-current={selectedId === null ? "true" : undefined}
                    aria-selected={selectedId === null}
                    aria-expanded={renderedNodes.length > 0 ? true : undefined}
                    aria-label={`Project: ${project.name} (${project.id})`}
                    className="project-hierarchy__project-root"
                    data-connector-record-id={projectEndpointId}
                    data-depth={-1}
                    data-layout-height={position?.height}
                    data-layout-width={position?.width}
                    data-layout-x={position?.x}
                    data-layout-y={position?.y}
                    data-project-id={project.id}
                    onClick={onSelectProject}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActiveId(null);
                    }}
                    onKeyDown={handleProjectKey}
                    ref={(element) => {
                      projectRef.current = element;
                      if (element) layoutRefs.current.set(projectEndpointId, element);
                      else layoutRefs.current.delete(projectEndpointId);
                    }}
                    role="treeitem"
                    style={positionStyle(projectEndpointId, 0)}
                    tabIndex={tabStopId === null ? 0 : -1}
                  >
                    <div className="project-hierarchy__project-card">
                      <span className="project-hierarchy__project-kind">Project</span>
                      <strong className="project-hierarchy__project-name">{project.name}</strong>
                      <span className="project-hierarchy__project-id">{project.id}</span>
                    </div>
                  </li>
                );
              })() : null}
              {renderedNodes.map((node) => {
                const label = labelFor(node);
                const nodeDescription = `${label} ${node.record.title}`;
                const parent = node.parentId === null ? null : nodesById.get(node.parentId) ?? null;
                const parentDescription = parent === null
                  ? `Project ${project.name}`
                  : `${labelFor(parent)} ${parent.record.title}`;
                const hasChildren = node.childCount + node.hiddenChildCount > 0;
                const protectedFromCollapse = collapseProtected(node);
                const expanded = childrenExpanded(node);
                const visualDepth = Math.min(node.depth + (wholeProject ? 1 : 0), 8);
                const position = measuredLayout.positions.get(node.record.id);
                return (
                  <li
                    aria-current={node.record.id === selectedId ? "true" : undefined}
                    aria-selected={node.record.id === selectedId}
                    aria-expanded={hasChildren ? expanded : undefined}
                    aria-label={`${label}: ${node.record.title}`}
                    aria-level={node.depth + (wholeProject ? 2 : 1)}
                    className="project-hierarchy__node"
                    data-connector-record-id={node.record.id}
                    data-depth={node.depth}
                    data-layout-height={position?.height}
                    data-layout-width={position?.width}
                    data-layout-x={position?.x}
                    data-layout-y={position?.y}
                    data-parent-id={node.parentId ?? (wholeProject ? project.id : undefined)}
                    data-record-id={node.record.id}
                    data-retained-path={retainedPath.has(node.record.id) ? "true" : undefined}
                    data-visual-depth={visualDepth}
                    key={node.record.id}
                    onClick={(event) => {
                      if (
                        event.defaultPrevented ||
                        (event.target as Element).closest("[data-expansion-control]") !== null
                      ) return;
                      onSelect(node.record.id);
                    }}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActiveId(node.record.id);
                    }}
                    onKeyDown={(event) => handleKey(event, node)}
                    ref={(element) => {
                      if (element) {
                        itemRefs.current.set(node.record.id, element);
                        layoutRefs.current.set(node.record.id, element);
                      } else {
                        itemRefs.current.delete(node.record.id);
                        layoutRefs.current.delete(node.record.id);
                      }
                    }}
                    role="treeitem"
                    style={positionStyle(node.record.id, visualDepth)}
                    tabIndex={node.record.id === tabStopId ? 0 : -1}
                  >
                    {primaryTargetIds.has(node.record.id) ? (
                      <span
                        aria-label={`Primary hierarchy connection from ${parentDescription} to ${nodeDescription}`}
                        className="sr-only"
                        role="img"
                      />
                    ) : null}
                    <div className="project-hierarchy__node-row project-map__record-line">
                      <span className="project-hierarchy__node-copy">
                        <span className="project-hierarchy__node-kind">{label}</span>
                        <strong className="project-hierarchy__node-title">{node.record.title}</strong>
                        <span className="project-hierarchy__node-status">{node.record.status}</span>
                      </span>
                      {hasChildren ? (
                        <button
                          aria-describedby={protectedFromCollapse
                            ? selectedAncestorCollapseReasonId
                            : undefined}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${node.record.title}`}
                          aria-expanded={expanded}
                          className="project-hierarchy__collapse"
                          data-expansion-control
                          disabled={protectedFromCollapse}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (protectedFromCollapse) return;
                            onExpandedChange(node.record.id, !expanded);
                          }}
                          tabIndex={-1}
                          title={protectedFromCollapse
                            ? SELECTED_ANCESTOR_COLLAPSE_REASON
                            : undefined}
                          type="button"
                        >
                          {expanded ? "Collapse" : "Expand"}
                        </button>
                      ) : null}
                      {node.hiddenChildCount > 0 ? (
                        <span className="project-hierarchy__hidden-count">
                          {node.hiddenChildCount} hidden {node.hiddenChildCount === 1 ? "item" : "items"}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </ProjectHierarchyCameraContents>
        </ProjectMapCameraCanvas>
      </section>
    </section>
  );
}
