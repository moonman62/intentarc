import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConnectedRepositoryDetailResponse,
  RepositoryExplorerResponse,
} from "../../contracts.js";
import { apiRequest } from "../api.js";
import { useRepositorySelection } from "../components/repository-selection.js";
import { boundedUnicodePreview } from "../components/record-preview.js";

type ExplorerNode = RepositoryExplorerResponse["items"][number];
type RepositoryFilter = RepositoryExplorerResponse["request"]["filter"];

interface BranchState {
  readonly status: "loading" | "ready" | "error";
  readonly items: readonly ExplorerNode[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly message?: string;
  readonly loadingMore?: boolean;
  readonly responseExclusions?: RepositoryExplorerResponse["exclusions"];
  readonly sourceStatus?: RepositoryExplorerResponse["sourceStatus"];
  readonly snapshotId?: RepositoryExplorerResponse["snapshotId"];
}

interface AcceptedSnapshotState {
  readonly projectId: string;
  readonly snapshotId: string | null;
}

interface VisibleNode {
  readonly node: ExplorerNode;
  readonly depth: number;
  readonly posInSet: number;
  readonly setSize: number;
  readonly ancestorNodeIds: readonly string[];
}

interface WindowedNode extends VisibleNode {
  readonly visibleIndex: number;
}

interface ExplorerFilters {
  readonly search: string;
  readonly relevance: boolean;
  readonly changed: boolean;
  readonly category: string;
  readonly documentKind: string;
  readonly role: string;
  readonly unlinked: boolean;
  readonly contextIncluded: boolean;
  readonly state: string;
  readonly exclusionReason: string;
}

type DetailState =
  | { readonly status: "idle" | "loading"; readonly requestKey: string }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string }
  | { readonly status: "ready"; readonly requestKey: string; readonly detail: ConnectedRepositoryDetailResponse };

export interface RepositoryExplorerProps {
  readonly projectId: string;
  readonly selectedNodeId: string | null;
  readonly onSelectNode?: (nodeId: string | null) => void;
}

const pageSize = 200;
const maximumDomNodes = 80;
const rootKey = "root";
const emptyFilters: ExplorerFilters = {
  search: "",
  relevance: false,
  changed: false,
  category: "",
  documentKind: "",
  role: "",
  unlinked: false,
  contextIncluded: false,
  state: "",
  exclusionReason: "",
};
const documentKinds = [
  "overview", "specification", "decision_support", "operational_guide",
  "test_evidence", "ai_instruction", "unlinked",
] as const;
const roles = [
  "canonical_source", "supporting_document", "test", "tool", "asset",
  "archived_source",
] as const;
const exclusionReasons = [
  "hard_exclusion", "ignored", "unsupported_text", "oversized_text",
  "link_not_followed", "untracked_not_eligible", "known_secret_path",
] as const;
const connectionBases = ["accepted", "observed", "inferred", "conflicting"] as const;
const maximumDisplayPath = 160;
const maximumDisplayIdentifier = 96;
const maximumDisplayLabel = 120;

const connectionHeading = (basis: typeof connectionBases[number]): string => {
  if (basis === "accepted") return "Accepted intent connections";
  if (basis === "observed") return "Observed repository evidence";
  return `${basis[0]!.toUpperCase()}${basis.slice(1)} connections`;
};

const readable = (value: string): string => value.replaceAll("_", " ");

const message = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message !== "" ? reason.message : fallback;

const branchKey = (parentNodeId: string | null): string =>
  parentNodeId === null ? rootKey : `node:${parentNodeId}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareNodes = (left: ExplorerNode, right: ExplorerNode): number =>
  (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
  compareStrings(left.path, right.path) ||
  compareStrings(left.nodeId, right.nodeId);

const mergeNodes = (
  current: readonly ExplorerNode[],
  incoming: readonly ExplorerNode[],
): readonly ExplorerNode[] => {
  const byId = new Map(current.map((entry) => [entry.nodeId, entry]));
  for (const entry of incoming) byId.set(entry.nodeId, entry);
  return [...byId.values()].sort(compareNodes);
};

const branchMetadata = (branch: BranchState | undefined) => ({
  ...(branch?.responseExclusions === undefined
    ? {}
    : { responseExclusions: branch.responseExclusions }),
  ...(branch?.sourceStatus === undefined ? {} : { sourceStatus: branch.sourceStatus }),
  ...(branch?.snapshotId === undefined ? {} : { snapshotId: branch.snapshotId }),
});

const canonicalFilter = (filter: RepositoryFilter): string => JSON.stringify({
  ...(filter.search === undefined ? {} : { search: filter.search }),
  ...(filter.relevance === undefined ? {} : { relevance: filter.relevance }),
  ...(filter.changed === undefined ? {} : { changed: filter.changed }),
  ...(filter.category === undefined ? {} : { category: filter.category }),
  ...(filter.documentKind === undefined ? {} : { documentKind: filter.documentKind }),
  ...(filter.role === undefined ? {} : { role: filter.role }),
  ...(filter.unlinked === undefined ? {} : { unlinked: filter.unlinked }),
  ...(filter.contextIncluded === undefined ? {} : { contextIncluded: filter.contextIncluded }),
  ...(filter.state === undefined ? {} : { state: filter.state }),
  ...(filter.exclusionReason === undefined ? {} : { exclusionReason: filter.exclusionReason }),
});

const treeQuery = (
  projectId: string,
  parentNodeId: string | null,
  cursor: string | null,
  filterQuery: string,
): string => {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  for (const [key, value] of new URLSearchParams(filterQuery)) query.set(key, value);
  if (parentNodeId !== null) query.set("parentNodeId", parentNodeId);
  if (cursor !== null) query.set("cursor", cursor);
  return `/api/projects/${encodeURIComponent(projectId)}/repository/tree?${query}`;
};

export function RepositoryExplorer({
  projectId,
  selectedNodeId,
  onSelectNode,
}: RepositoryExplorerProps) {
  const selection = useRepositorySelection();
  const [branches, setBranches] = useState<ReadonlyMap<string, BranchState>>(
    () => new Map([[rootKey, {
      status: "loading",
      items: [],
      hasMore: false,
      nextCursor: null,
    }]]),
  );
  const [filters, setFilters] = useState<ExplorerFilters>(emptyFilters);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle", requestKey: "" });
  const [detailReload, setDetailReload] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [acceptedSnapshot, setAcceptedSnapshot] = useState<AcceptedSnapshotState | null>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const treeItemsRef = useRef(new Map<string, HTMLElement>());
  const requestedFilter = useMemo<RepositoryFilter>(() => ({
    ...(filters.search.trim() !== "" ? { search: filters.search.trim() } : {}),
    ...(filters.relevance ? { relevance: "current_task" } : {}),
    ...(filters.changed ? { changed: true } : {}),
    ...(filters.category !== "" ? { category: filters.category as RepositoryFilter["category"] } : {}),
    ...(filters.documentKind !== "" ? { documentKind: filters.documentKind as RepositoryFilter["documentKind"] } : {}),
    ...(filters.role !== "" ? { role: filters.role as RepositoryFilter["role"] } : {}),
    ...(filters.unlinked ? { unlinked: true } : {}),
    ...(filters.contextIncluded ? { contextIncluded: true } : {}),
    ...(filters.state !== "" ? { state: filters.state as RepositoryFilter["state"] } : {}),
    ...(filters.state === "excluded" && filters.exclusionReason !== ""
      ? { exclusionReason: filters.exclusionReason as RepositoryFilter["exclusionReason"] }
      : {}),
  }), [filters]);
  const requestedFilterKey = useMemo(() => canonicalFilter(requestedFilter), [requestedFilter]);
  const filterQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(requestedFilter)) query.set(key, String(value));
    return query.toString();
  }, [requestedFilter]);
  const treeRequestKey = JSON.stringify([projectId, filterQuery]);
  const [branchesRequestKey, setBranchesRequestKey] = useState(treeRequestKey);
  const detailRequestKey = JSON.stringify([
    projectId,
    selectedNodeId,
    filterQuery,
    detailReload,
  ]);

  useEffect(() => {
    if (selectedNodeId === null) selection.clearSelection();
    else selection.selectRepositoryNode(selectedNodeId);
  }, [selectedNodeId, selection.clearSelection, selection.selectRepositoryNode]);

  useEffect(() => {
    const requestKey = detailRequestKey;
    if (selectedNodeId === null) {
      setDetailState({ status: "idle", requestKey });
      return;
    }
    const controller = new AbortController();
    setDetailState({ status: "loading", requestKey });
    apiRequest<ConnectedRepositoryDetailResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/repository/nodes/${encodeURIComponent(selectedNodeId)}/connected-detail`,
      { signal: controller.signal },
    ).then(
      (detail) => {
        if (controller.signal.aborted) return;
        if (detail.projectId !== projectId || detail.node.nodeId !== selectedNodeId) {
          setDetailState({
            status: "error",
            requestKey,
            message: "Repository detail did not match the selected node.",
          });
          return;
        }
        setDetailState({ status: "ready", requestKey, detail });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setDetailState({
            status: "error",
            requestKey,
            message: message(reason, "Could not load repository connections."),
          });
        }
      },
    );
    return () => controller.abort();
  }, [detailRequestKey, projectId, selectedNodeId]);

  const loadBranch = useCallback((
    parentNodeId: string | null,
    cursor: string | null = null,
  ) => {
    const key = branchKey(parentNodeId);
    if (controllersRef.current.has(key)) return;
    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    setBranches((current) => {
      const next = new Map(current);
      const branch = current.get(key);
      next.set(key, cursor === null
        ? { status: "loading", items: [], hasMore: false, nextCursor: null }
        : {
            status: "ready",
            items: branch?.items ?? [],
            hasMore: branch?.hasMore ?? false,
            nextCursor: branch?.nextCursor ?? cursor,
            loadingMore: true,
            ...branchMetadata(branch),
          });
      return next;
    });
    apiRequest<RepositoryExplorerResponse>(
      treeQuery(projectId, parentNodeId, cursor, filterQuery),
      { signal: controller.signal },
    ).then(
      (response) => {
        if (controller.signal.aborted) return;
        const validationMessage = canonicalFilter(response.request.filter) !== requestedFilterKey
          ? "Repository page did not match the requested filters."
          : (
          response.projectId !== projectId ||
          response.parentNodeId !== parentNodeId ||
          response.request.parentNodeId !== parentNodeId ||
          response.request.pageSize !== pageSize ||
          response.items.some((item) =>
            item.parentNodeId !== parentNodeId || item.nodeId === parentNodeId)
          )
            ? "Repository page did not match the requested branch."
            : null;
        if (validationMessage !== null) {
          setBranches((current) => {
            const next = new Map(current);
            const previous = current.get(key);
            next.set(key, cursor === null
              ? {
                  status: "error",
                  items: [],
                  hasMore: false,
                  nextCursor: null,
                  message: validationMessage,
                }
              : {
                  status: "ready",
                  items: previous?.items ?? [],
                  hasMore: true,
                  nextCursor: cursor,
                  message: validationMessage,
                  ...branchMetadata(previous),
                });
            return next;
          });
          return;
        }
        setBranches((current) => {
          const next = new Map(current);
          const previous = current.get(key);
          const displayedRoot = current.get(rootKey);
          if (
            (parentNodeId !== null || cursor !== null) &&
            (
              displayedRoot?.status !== "ready" ||
              displayedRoot.snapshotId !== response.snapshotId ||
              displayedRoot.sourceStatus !== response.sourceStatus
            )
          ) {
            next.set(key, cursor === null
              ? {
                  status: "error",
                  items: [],
                  hasMore: false,
                  nextCursor: null,
                  message: "Repository branch no longer matches the displayed accepted index.",
                }
              : {
                  status: "ready",
                  items: previous?.items ?? [],
                  hasMore: true,
                  nextCursor: cursor,
                  message: "Repository branch no longer matches the displayed accepted index.",
                  ...branchMetadata(previous),
                });
            return next;
          }
          next.set(key, {
            status: "ready",
            items: mergeNodes(cursor === null ? [] : previous?.items ?? [], response.items),
            hasMore: response.hasMore,
            nextCursor: response.nextCursor,
            responseExclusions: response.exclusions,
            sourceStatus: response.sourceStatus,
            snapshotId: response.snapshotId,
          });
          return next;
        });
        if (parentNodeId === null && cursor === null) {
          setAcceptedSnapshot({ projectId, snapshotId: response.snapshotId });
        }
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setBranches((current) => {
          const next = new Map(current);
          const previous = current.get(key);
          next.set(key, cursor === null
            ? {
                status: "error",
                items: [],
                hasMore: false,
                nextCursor: null,
                message: message(reason, "Could not load repository files."),
              }
            : {
                status: "ready",
                items: previous?.items ?? [],
                hasMore: true,
                nextCursor: cursor,
                message: message(reason, "Could not load repository files."),
                ...branchMetadata(previous),
              });
          return next;
        });
      },
    ).finally(() => {
      if (controllersRef.current.get(key) === controller) {
        controllersRef.current.delete(key);
      }
    });
  }, [filterQuery, projectId, requestedFilterKey]);

  useEffect(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    setExpanded(new Set());
    setActiveNodeId(null);
    setBranchesRequestKey(treeRequestKey);
    setBranches(new Map([[rootKey, {
      status: "loading",
      items: [],
      hasMore: false,
      nextCursor: null,
    }]]));
    loadBranch(null);
    return () => {
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    };
  }, [loadBranch, treeRequestKey]);

  const currentBranches = useMemo<ReadonlyMap<string, BranchState>>(() => (
    branchesRequestKey === treeRequestKey
      ? branches
      : new Map([[rootKey, {
          status: "loading",
          items: [],
          hasMore: false,
          nextCursor: null,
        }]])
  ), [branches, branchesRequestKey, treeRequestKey]);

  const visibleNodes = useMemo(() => {
    const result: VisibleNode[] = [];
    const visited = new Set<string>();
    const append = (
      parentNodeId: string | null,
      depth: number,
      ancestorNodeIds: readonly string[],
    ) => {
      const branch = currentBranches.get(branchKey(parentNodeId));
      if (branch?.status !== "ready" && branch?.status !== "error") return;
      for (const [siblingIndex, node] of branch.items.entries()) {
        if (visited.has(node.nodeId)) continue;
        visited.add(node.nodeId);
        result.push({
          node,
          depth,
          posInSet: siblingIndex + 1,
          setSize: branch.items.length,
          ancestorNodeIds,
        });
        if (node.kind === "directory" && expanded.has(node.nodeId)) {
          append(node.nodeId, depth + 1, [...ancestorNodeIds, node.nodeId]);
        }
      }
    };
    append(null, 1, []);
    return result;
  }, [currentBranches, expanded]);

  useEffect(() => {
    if (visibleNodes.length === 0) {
      setActiveNodeId(null);
      return;
    }
    if (!visibleNodes.some(({ node }) => node.nodeId === activeNodeId)) {
      setActiveNodeId(visibleNodes[0]!.node.nodeId);
    }
  }, [activeNodeId, visibleNodes]);

  const toggleDirectory = (node: ExplorerNode) => {
    if (node.kind !== "directory") return;
    if (expanded.has(node.nodeId)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(node.nodeId);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(node.nodeId));
    if (!currentBranches.has(branchKey(node.nodeId))) loadBranch(node.nodeId);
  };

  const focusNode = (nodeId: string) => {
    setActiveNodeId(nodeId);
    const mountedItem = treeItemsRef.current.get(nodeId);
    if (mountedItem !== undefined) {
      mountedItem.focus();
      return;
    }
    requestAnimationFrame(() => treeItemsRef.current.get(nodeId)?.focus());
  };

  const handleTreeKey = (
    event: KeyboardEvent<HTMLElement>,
    entry: VisibleNode,
    index: number,
  ) => {
    const { node } = entry;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNode?.(node.nodeId);
      return;
    }
    if (event.key === "ArrowRight" && node.kind === "directory") {
      event.preventDefault();
      if (!expanded.has(node.nodeId)) toggleDirectory(node);
      else {
        const child = visibleNodes[index + 1];
        if (child?.depth === entry.depth + 1) focusNode(child.node.nodeId);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (node.kind === "directory" && expanded.has(node.nodeId)) {
        event.preventDefault();
        toggleDirectory(node);
        return;
      }
      if (node.parentNodeId !== null) {
        event.preventDefault();
        focusNode(node.parentNodeId);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleNodes.length - 1
        : Math.max(0, Math.min(
            visibleNodes.length - 1,
            index + (event.key === "ArrowDown" ? 1 : -1),
          ));
    focusNode(visibleNodes[nextIndex]!.node.nodeId);
  };

  const root = currentBranches.get(rootKey);
  const loadedCount = [...currentBranches.values()].reduce(
    (count, branch) => count + branch.items.length,
    0,
  );
  const activeVisibleIndex = Math.max(0, visibleNodes.findIndex(({ node }) => node.nodeId === activeNodeId));
  const visibleIndexByNodeId = new Map(
    visibleNodes.map(({ node }, visibleIndex) => [node.nodeId, visibleIndex]),
  );
  const activeEntry = visibleNodes[activeVisibleIndex];
  const immediateChildIndex = activeEntry !== undefined &&
      visibleNodes[activeVisibleIndex + 1]?.depth === activeEntry.depth + 1
    ? activeVisibleIndex + 1
    : null;
  const reservedNonAncestorCount = 1 + (immediateChildIndex === null ? 0 : 1);
  const ancestorIndexes = (activeEntry?.ancestorNodeIds ?? [])
    .map((nodeId) => visibleIndexByNodeId.get(nodeId))
    .filter((visibleIndex): visibleIndex is number => visibleIndex !== undefined)
    .slice(-(maximumDomNodes - reservedNonAncestorCount));
  const windowIndexes = new Set<number>([
    ...ancestorIndexes,
    ...(activeEntry === undefined ? [] : [activeVisibleIndex]),
  ]);
  if (immediateChildIndex !== null) windowIndexes.add(immediateChildIndex);
  for (let distance = 1; windowIndexes.size < maximumDomNodes; distance += 1) {
    const before = activeVisibleIndex - distance;
    const after = activeVisibleIndex + distance;
    if (before < 0 && after >= visibleNodes.length) break;
    if (before >= 0) windowIndexes.add(before);
    if (windowIndexes.size < maximumDomNodes && after < visibleNodes.length) {
      windowIndexes.add(after);
    }
  }
  const windowedNodes: readonly WindowedNode[] = [...windowIndexes]
    .sort((left, right) => left - right)
    .map((visibleIndex) => ({ ...visibleNodes[visibleIndex]!, visibleIndex }));
  const hasFilters = filterQuery !== "";
  const acceptedSnapshotAvailable = acceptedSnapshot?.projectId === projectId &&
    acceptedSnapshot.snapshotId !== null;
  const recovery = root?.status === "ready" && root.snapshotId === null
    ? root.sourceStatus === "unavailable"
      ? {
          action: "Locate repository",
          href: `/projects/${encodeURIComponent(projectId)}/repository/refresh`,
          message: "The registered repository cannot be reached.",
        }
      : root.sourceStatus === "detached" || root.sourceStatus === null
        ? {
            action: "Attach repository",
            href: `/projects/${encodeURIComponent(projectId)}/repository/refresh`,
            message: "This project does not have an attached repository.",
          }
        : {
            action: "Review repository refresh",
            href: `/projects/${encodeURIComponent(projectId)}/repository/refresh`,
            message: "No repository observation has been accepted yet.",
          }
    : null;
  const currentDetailState: DetailState = detailState.requestKey === detailRequestKey
    ? detailState
    : { status: selectedNodeId === null ? "idle" : "loading", requestKey: detailRequestKey };
  const displayDetailState: DetailState = selectedNodeId !== null && root?.status !== "ready"
    ? root?.status === "error"
      ? {
          status: "error",
          requestKey: detailRequestKey,
          message: "The accepted repository index must load before node actions are available.",
        }
      : { status: "loading", requestKey: detailRequestKey }
    : currentDetailState.status === "ready" &&
        (root?.snapshotId === null || root?.snapshotId !== currentDetailState.detail.snapshotId)
      ? {
          status: "error",
          requestKey: detailRequestKey,
          message: "Selected node metadata no longer matches the accepted index.",
        }
      : currentDetailState;
  const updateSelect = (key: "category" | "documentKind" | "role" | "state" | "exclusionReason") =>
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      setFilters((current) => ({
        ...current,
        [key]: value,
        ...(key === "state" && value !== "excluded" ? { exclusionReason: "" } : {}),
      }));
    };
  const updateCheck = (key: "relevance" | "changed" | "unlinked" | "contextIncluded") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setFilters((current) => ({ ...current, [key]: event.target.checked }));
    };
  const updateSearch = (event: ChangeEvent<HTMLInputElement>) => {
    setFilters((current) => ({ ...current, search: event.target.value }));
  };

  return (
    <div className="repository-explorer">
      <div className="stage__header">
        <div>
          <p className="stage__eyebrow">Repository · accepted index</p>
          <h1>Repository Explorer</h1>
        </div>
      </div>

      {acceptedSnapshotAvailable ? (
        <section className="repository-explorer__search" aria-label="Repository search">
          <label>Search repository<input type="search" aria-label="Search repository" value={filters.search} onChange={updateSearch} /></label>
        </section>
      ) : null}

      {root?.status === "loading" ? <p role="status">Loading repository index…</p> : null}
      {root?.status === "error" ? (
        <div role="alert"><p>{root.message}</p><button type="button" onClick={() => loadBranch(null)}>Try again</button></div>
      ) : null}
      {recovery !== null ? (
        <section className="repository-explorer__recovery" aria-labelledby="repository-unavailable-heading">
          <h2 id="repository-unavailable-heading">Repository unavailable</h2>
          <p>{recovery.message}</p>
          <a className="secondary-action" href={recovery.href}>{recovery.action}</a>
        </section>
      ) : null}
      {acceptedSnapshotAvailable && root?.items.length === 0 ? (
        <>
          {root?.responseExclusions?.map(({ reason, count }) => <p key={reason}>{count} {readable(reason)} entries are excluded.</p>)}
          <p>{hasFilters
              ? "No repository nodes match these filters."
              : "No accepted repository nodes are available."}</p>
        </>
      ) : null}
      {acceptedSnapshotAvailable && root?.responseExclusions !== undefined ? (
        <p className="repository-explorer__source-status">
          Accepted index · repository {root?.sourceStatus ?? "unavailable"}
        </p>
      ) : null}
      {visibleNodes.length > 0 ? (
        <>
          <p aria-live="polite">Showing {windowedNodes.length} of {loadedCount} loaded nodes.</p>
          <ul role="tree" aria-label="Repository files" className="repository-explorer__tree">
            {windowedNodes.map((entry) => {
              const { node, depth, posInSet, setSize, visibleIndex: index } = entry;
              const branch = currentBranches.get(branchKey(node.nodeId));
              const displayPath = boundedUnicodePreview(node.path, maximumDisplayPath);
              return (
                <li role="none" key={node.nodeId} className="repository-explorer__row" style={{ "--tree-depth": depth } as CSSProperties}>
                  <button
                    ref={(element) => {
                      if (element === null) treeItemsRef.current.delete(node.nodeId);
                      else treeItemsRef.current.set(node.nodeId, element);
                    }}
                    type="button"
                    role="treeitem"
                    aria-level={depth}
                    aria-posinset={posInSet}
                    aria-setsize={setSize}
                    aria-selected={selectedNodeId === node.nodeId}
                    {...(node.kind === "directory" ? { "aria-expanded": expanded.has(node.nodeId) } : {})}
                    tabIndex={activeNodeId === node.nodeId ? 0 : -1}
                    onFocus={() => setActiveNodeId(node.nodeId)}
                    onClick={() => {
                      onSelectNode?.(node.nodeId);
                      if (node.kind === "directory") toggleDirectory(node);
                    }}
                    onKeyDown={(event) => handleTreeKey(event, entry, index)}
                  >
                    <span>{node.kind === "directory" ? "Directory" : "File"}: {displayPath}</span>
                    <span>
                      {readable(node.state)} · {readable(node.role)} · {readable(node.sourceStatus)}
                      {node.changed ? " · changed" : ""}
                      {node.linked ? " · linked" : " · unlinked"}
                      {node.currentTaskRelevant ? " · current task" : ""}
                      {node.contextIncluded ? " · current context" : ""}
                    </span>
                  </button>
                  {node.kind === "directory" && expanded.has(node.nodeId) && branch?.status === "loading"
                    ? <p role="status">Loading {displayPath}…</p>
                    : null}
                  {node.kind === "directory" && expanded.has(node.nodeId) && branch?.message !== undefined
                    ? <div role="alert"><p>{branch.message}</p><button type="button" onClick={() => loadBranch(node.nodeId, branch.nextCursor)}>Try loading {displayPath} again</button></div>
                    : null}
                  {node.kind === "directory" && expanded.has(node.nodeId) && branch?.status === "ready" && branch.message === undefined && branch.hasMore && branch.nextCursor !== null
                    ? <button type="button" disabled={branch.loadingMore} onClick={() => loadBranch(node.nodeId, branch.nextCursor)}>Load more in {displayPath}</button>
                    : null}
                  {node.kind === "directory" && expanded.has(node.nodeId) && branch?.status === "ready" && branch.items.length === 0 && !branch.hasMore
                    ? <p role="status">{displayPath} is empty in this accepted view.</p>
                    : null}
                </li>
              );
            })}
          </ul>
          {root?.status === "ready" && root.message !== undefined ? (
            <div role="alert">
              <p>{root.message}</p>
              <button type="button" disabled={root.loadingMore} onClick={() => loadBranch(null, root.nextCursor)}>
                Try loading more roots again
              </button>
            </div>
          ) : null}
          {root?.status === "ready" && root.message === undefined && root.hasMore && root.nextCursor !== null ? (
            <button type="button" disabled={root.loadingMore} onClick={() => loadBranch(null, root.nextCursor)}>
              Load more repository roots
            </button>
          ) : null}
        </>
      ) : null}

      {acceptedSnapshotAvailable ? (
        <>
          <form className="repository-explorer__filters repository-explorer__filters--common" aria-label="Common repository filters" onSubmit={(event) => event.preventDefault()}>
            <label><input type="checkbox" checked={filters.relevance} onChange={updateCheck("relevance")} />Current task only</label>
            <label><input type="checkbox" checked={filters.changed} onChange={updateCheck("changed")} />Changed in latest refresh</label>
            <button type="button" disabled={!hasFilters} onClick={() => setFilters(emptyFilters)}>Clear filters</button>
          </form>
          <details
            className="repository-explorer__advanced"
            onToggle={(event) => setAdvancedFiltersOpen(event.currentTarget.open)}
          >
            <summary>Advanced filters</summary>
            {advancedFiltersOpen ? (
              <form className="repository-explorer__filters" aria-label="Advanced repository filters" onSubmit={(event) => event.preventDefault()}>
                <label>Category<select aria-label="Category" value={filters.category} onChange={updateSelect("category")}>
                  <option value="">Any category</option><option value="documentation">Documentation</option><option value="test">Tests</option>
                </select></label>
                <label>Document kind<select aria-label="Document kind" value={filters.documentKind} onChange={updateSelect("documentKind")}>
                  <option value="">Any document kind</option>{documentKinds.map((kind) => <option key={kind} value={kind}>{readable(kind)}</option>)}
                </select></label>
                <label>Role<select aria-label="Role" value={filters.role} onChange={updateSelect("role")}>
                  <option value="">Any role</option>{roles.map((role) => <option key={role} value={role}>{readable(role)}</option>)}
                </select></label>
                <label><input type="checkbox" checked={filters.unlinked} onChange={updateCheck("unlinked")} />Unlinked only</label>
                <label><input type="checkbox" checked={filters.contextIncluded} onChange={updateCheck("contextIncluded")} />Included in current context</label>
                <label>State<select aria-label="State" value={filters.state} onChange={updateSelect("state")}>
                  <option value="">Any state</option><option value="current">Current</option><option value="stale">Stale</option><option value="unavailable">Unavailable</option><option value="excluded">Excluded</option>
                </select></label>
                <label>Exclusion reason<select aria-label="Exclusion reason" value={filters.exclusionReason} disabled={filters.state !== "excluded"} onChange={updateSelect("exclusionReason")}>
                  <option value="">Any reason</option>{exclusionReasons.map((reason) => <option key={reason} value={reason}>{readable(reason)}</option>)}
                </select></label>
              </form>
            ) : null}
          </details>
        </>
      ) : null}

      {selectedNodeId !== null ? (
        <section className="repository-explorer__detail" aria-label="Selected repository node">
          <div><h2>Selected node</h2><button type="button" onClick={() => onSelectNode?.(null)}>Close selection</button></div>
          {displayDetailState.status === "loading" ? <p role="status">Loading repository connections…</p> : null}
          {displayDetailState.status === "error" ? (
            <div role="alert"><p>{displayDetailState.message}</p><button type="button" onClick={() => setDetailReload((value) => value + 1)}>Try again</button></div>
          ) : null}
          {displayDetailState.status === "ready" ? (
            <div>
              <h3>{boundedUnicodePreview(displayDetailState.detail.node.path, maximumDisplayPath)}</h3>
              <nav className="repository-context-path" aria-label="Repository project path">
                <ol>
                  <li>Project {boundedUnicodePreview(projectId, maximumDisplayIdentifier)}</li>
                  <li>Repository</li>
                  {boundedUnicodePreview(displayDetailState.detail.node.path, maximumDisplayPath).split("/").map((segment, index) => (
                    <li key={`${segment}-${index}`}>{segment}</li>
                  ))}
                </ol>
              </nav>
              <dl>
                <div><dt>Kind</dt><dd>{readable(displayDetailState.detail.node.kind)}</dd></div>
                <div><dt>Role</dt><dd>{readable(displayDetailState.detail.node.role)}</dd></div>
                <div><dt>Content</dt><dd>{displayDetailState.detail.node.contentEligible ? "Eligible after explicit open" : "Metadata only"}</dd></div>
              </dl>
              {displayDetailState.detail.node.documentKind !== null ? (
                <a href={`/projects/${encodeURIComponent(projectId)}/documentation/${encodeURIComponent(displayDetailState.detail.node.nodeId)}`}>
                  Open {boundedUnicodePreview(displayDetailState.detail.node.path, maximumDisplayPath)} in Documentation
                </a>
              ) : null}
              {connectionBases.map((basis) => {
                const links = displayDetailState.detail.linksByBasis[basis];
                if (links.length === 0) return null;
                return (
                  <section className="repository-connections" key={basis}>
                    <h4>{connectionHeading(basis)}</h4>
                    <ul>{links.map((link) => (
                      <li key={link.linkId}>
                        {link.record !== null ? (
                          <a href={`/projects/${encodeURIComponent(projectId)}/map?focusRecordId=${encodeURIComponent(link.record.id)}`}>
                            Focus {boundedUnicodePreview(link.record.title, maximumDisplayLabel)} in Map
                          </a>
                        ) : (
                          <a href={`/projects/${encodeURIComponent(projectId)}/repository?nodeId=${encodeURIComponent(link.node.nodeId)}`}>
                            Open {boundedUnicodePreview(link.node.path, maximumDisplayPath)} in Repository
                          </a>
                        )}
                        <span> · {boundedUnicodePreview(link.label, maximumDisplayLabel)}</span>
                      </li>
                    ))}</ul>
                  </section>
                );
              })}
              {connectionBases.every((basis) => displayDetailState.detail.linksByBasis[basis].length === 0)
                ? <p>No project or repository connections.</p>
                : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
