import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConnectedRecordDetailResponse,
  ConnectedRepositoryDetailResponse,
  ProjectDashboardResponse,
  ProjectMapResponse,
} from "../../contracts.js";
import {
  connectedRecordDetailResponseSchema,
  projectDashboardResponseSchemaFor,
  projectMapResponseSchema,
} from "../../contracts.js";
import { apiRequest } from "../api.js";
import {
  ProjectHierarchyView,
  projectConnectorEndpointId,
} from "../components/project-hierarchy-view.js";
import type { CameraInsets } from "../components/project-map-camera.js";
import type { ProjectMapConnector } from "../components/project-map-connectors.js";
import type { HierarchyRecordSummary } from "../components/hierarchy-label.js";
import {
  ProjectMapInspector,
  type ProjectMapInspectorDetailState,
} from "../components/project-map-inspector.js";
import { useRepositorySelection } from "../components/repository-selection.js";
import {
  deriveProjectMapLocalView,
  normalizeProjectMapSnapshot,
  reconcileProjectMapRevisions,
  type ProjectMapSnapshot,
} from "./project-map-snapshot.js";

export interface ProjectMapProps {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly focusRecordId: string | null;
  readonly scopeRecordId: string | null;
  readonly onSelectProject: () => void;
  readonly onSelectRecord: (recordId: string, scopeRecordId: string | null) => void;
  readonly onClearSelection: (scopeRecordId: string | null) => void;
  readonly onFocusBranch: (recordId: string) => void;
  readonly onNavigateAttachment: (path: string) => void;
  readonly onShowWholeProject: (selectedRecordId: string | null) => void;
  readonly onDashboardRefetched?: (dashboard: ProjectDashboardResponse) => void;
}

type TopologyState =
  | { readonly status: "loading"; readonly requestKey: string; readonly stale?: ProjectMapSnapshot }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string; readonly stale?: ProjectMapSnapshot }
  | { readonly status: "ready"; readonly requestKey: string; readonly snapshot: ProjectMapSnapshot };

const ZERO_CAMERA_INSETS: CameraInsets = { top: 0, right: 0, bottom: 0, left: 0 };

type DetailState =
  | { readonly status: "idle" | "loading"; readonly requestKey: string }
  | { readonly status: "staged" | "ready"; readonly requestKey: string; readonly detail: ConnectedRecordDetailResponse }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string };

type NodeDetailState =
  | { readonly status: "idle" | "loading"; readonly requestKey: string }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string }
  | { readonly status: "ready"; readonly requestKey: string; readonly detail: ConnectedRepositoryDetailResponse };

interface ExpansionState {
  readonly key: string;
  readonly expandedIds: ReadonlySet<string>;
  readonly collapsedIds: ReadonlySet<string>;
}

interface ReconciliationGeneration {
  readonly id: number;
  readonly requestKey: string;
  fallbackTopology: ProjectMapSnapshot | null;
  topologyController: AbortController | null;
  detailController: AbortController | null;
  retryUsed: boolean;
  handledPair: string | null;
}

interface ReconciledTopologyAdoption {
  readonly snapshot: ProjectMapSnapshot;
  readonly reloadGeneration: number;
  readonly sourceProjectRevision: number;
}

interface DashboardSynchronization {
  readonly key: string;
  readonly projectId: string;
  readonly controller: AbortController;
}

const bases = ["accepted", "observed", "inferred", "conflicting"] as const;
const emptyIds: ReadonlySet<string> = new Set();
const projectEndpoint = (projectId: string, suffix: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
const detailCacheKey = (projectId: string, recordId: string, revision: number): string => (
  JSON.stringify([projectId, recordId, revision])
);
const readable = (value: string): string => value
  .replaceAll("_", " ")
  .replace(/^./, (letter) => letter.toUpperCase());
const errorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message !== "" ? reason.message : fallback;

export function defaultProjectMapVisibleDepth(viewportWidth: number): 1 | 2 {
  return viewportWidth < 760 ? 1 : 2;
}

const isHierarchyKind = (kind: string): boolean => (
  kind === "outcome" ||
  kind === "initiative" ||
  kind === "deliverable" ||
  kind === "milestone" ||
  kind === "task"
);

const isHierarchyRecord = (
  record: ProjectMapResponse["hierarchyNodes"][number],
): record is ProjectMapResponse["hierarchyNodes"][number] & HierarchyRecordSummary => (
  isHierarchyKind(record.kind)
);

const loadTopology = async (
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectMapSnapshot> => {
  const parsed = projectMapResponseSchema.safeParse(await apiRequest<unknown>(
    projectEndpoint(projectId, "/map"),
    { signal },
  ));
  if (!parsed.success) throw new Error("The project map response could not be validated.");
  if (parsed.data.projectId !== projectId) {
    throw new Error("The project map was not bound to the requested project.");
  }
  if (!parsed.data.hierarchyNodes.every(isHierarchyRecord)) {
    throw new Error("The project map response could not be validated.");
  }
  const snapshot = normalizeProjectMapSnapshot(parsed.data);
  deriveProjectMapLocalView({
    snapshot,
    selectedId: null,
    scopeId: null,
    visibleDepth: 0,
    expandedIds: emptyIds,
    collapsedIds: emptyIds,
  });
  return snapshot;
};

const loadDetail = async (
  projectId: string,
  recordId: string,
  signal: AbortSignal,
): Promise<ConnectedRecordDetailResponse> => {
  const parsed = connectedRecordDetailResponseSchema.safeParse(await apiRequest<unknown>(
    projectEndpoint(projectId, `/records/${encodeURIComponent(recordId)}/connected-detail`),
    { signal },
  ));
  if (!parsed.success) throw new Error("Connected detail could not be validated.");
  const detail = parsed.data;
  if (
    detail.projectId !== projectId ||
    detail.record.projectId !== projectId ||
    detail.record.id !== recordId
  ) throw new Error("Connected detail did not match the selected record.");
  return detail;
};

const progressRollup = (snapshot: ProjectMapSnapshot): string => {
  const parts = Object.entries(snapshot.projectProgress.childStatuses)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([status, count]) => `${count} ${readable(status).toLowerCase()} child${count === 1 ? "" : "ren"}`);
  const count = snapshot.projectProgress.childCount;
  const evidence = snapshot.projectProgress.childrenWithEvidence;
  return `Project progress: ${parts.length === 0 ? "No child status" : parts.join(", ")}; ${evidence} of ${count} ${count === 1 ? "child has" : "children have"} evidence.`;
};

const isWithinScope = (
  snapshot: ProjectMapSnapshot,
  recordId: string,
  scopeRecordId: string | null,
): boolean => {
  if (scopeRecordId === null) return true;
  let cursor = snapshot.nodesById.get(recordId);
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor.id)) {
    if (cursor.id === scopeRecordId) return true;
    seen.add(cursor.id);
    cursor = cursor.parentId === null ? undefined : snapshot.nodesById.get(cursor.parentId);
  }
  return false;
};

const ancestorIds = (snapshot: ProjectMapSnapshot, recordId: string): readonly string[] => {
  const ids: string[] = [];
  let cursor = snapshot.nodesById.get(recordId);
  const seen = new Set<string>();
  while (cursor !== undefined && cursor.parentId !== null && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ids.push(cursor.parentId);
    cursor = snapshot.nodesById.get(cursor.parentId);
  }
  return ids;
};

const abortReconciliationGeneration = (generation: ReconciliationGeneration | null): void => {
  generation?.topologyController?.abort();
  generation?.detailController?.abort();
};

export function ProjectMap({
  projectId,
  projectRevision,
  focusRecordId,
  scopeRecordId,
  onSelectProject,
  onSelectRecord,
  onClearSelection,
  onFocusBranch,
  onNavigateAttachment,
  onShowWholeProject,
  onDashboardRefetched,
}: ProjectMapProps) {
  const selection = useRepositorySelection();
  const {
    clearSelection: clearRepositorySelection,
    nodeId: selectedRepositoryNodeId,
    selectRecord: selectRepositoryRecord,
  } = selection;
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [cameraFitRequestKey, setCameraFitRequestKey] = useState(0);
  const [cameraFocusRequestKey, setCameraFocusRequestKey] = useState(0);
  const [cameraFocusTargetId, setCameraFocusTargetId] = useState<string | null>(null);
  const [occlusionInsets, setOcclusionInsets] = useState<CameraInsets>(ZERO_CAMERA_INSETS);
  const [detailRetryGeneration, setDetailRetryGeneration] = useState(0);
  const [visibleDepth, setVisibleDepth] = useState<1 | 2>(() => (
    defaultProjectMapVisibleDepth(typeof window === "undefined" ? 1024 : window.innerWidth)
  ));
  const [topologyState, setTopologyState] = useState<TopologyState>({ status: "loading", requestKey: "" });
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle", requestKey: "" });
  const [nodeDetailState, setNodeDetailState] = useState<NodeDetailState>({ status: "idle", requestKey: "" });
  const [expansion, setExpansion] = useState<ExpansionState>({
    key: "",
    expandedIds: new Set(),
    collapsedIds: new Set(),
  });
  const [showConnections, setShowConnections] = useState(true);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const topologyControllerRef = useRef<AbortController | null>(null);
  const topologyRequestSerialRef = useRef(0);
  const selectionGenerationSerialRef = useRef(0);
  const reconciliationRef = useRef<ReconciliationGeneration | null>(null);
  const lastVerifiedSnapshotRef = useRef<ProjectMapSnapshot | null>(null);
  const reconciledTopologyAdoptionRef = useRef<ReconciledTopologyAdoption | null>(null);
  const dashboardSynchronizationRef = useRef<DashboardSynchronization | null>(null);
  const selectedButtonRef = useRef<HTMLElement | null>(null);
  const detailCacheRef = useRef(new Map<string, ConnectedRecordDetailResponse>());
  const pendingFocusRestoreRef = useRef(false);
  const fitWholeProjectPendingRef = useRef(false);

  const topologyRequestKey = JSON.stringify([projectId, projectRevision, reloadGeneration]);
  const selectionRequestKey = JSON.stringify([
    topologyRequestKey,
    focusRecordId,
    detailRetryGeneration,
  ]);

  useEffect(() => {
    const onResize = () => setVisibleDepth(defaultProjectMapVisibleDepth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => setShowConnections(true), [projectId]);

  useEffect(() => {
    const requestSerial = ++topologyRequestSerialRef.current;
    topologyControllerRef.current?.abort();
    const adoption = reconciledTopologyAdoptionRef.current;
    if (
      adoption?.snapshot.projectId === projectId &&
      adoption.snapshot.projectRevision === projectRevision &&
      adoption.sourceProjectRevision !== projectRevision &&
      adoption.reloadGeneration === reloadGeneration
    ) {
      reconciledTopologyAdoptionRef.current = null;
      lastVerifiedSnapshotRef.current = adoption.snapshot;
      setTopologyState({
        status: "ready",
        requestKey: topologyRequestKey,
        snapshot: adoption.snapshot,
      });
      return;
    }
    reconciledTopologyAdoptionRef.current = null;
    const controller = new AbortController();
    topologyControllerRef.current = controller;
    const stale = lastVerifiedSnapshotRef.current?.projectId === projectId
      ? lastVerifiedSnapshotRef.current
      : undefined;
    setTopologyState({ status: "loading", requestKey: topologyRequestKey, ...(stale ? { stale } : {}) });
    void loadTopology(projectId, controller.signal).then(
      (snapshot) => {
        if (controller.signal.aborted || requestSerial !== topologyRequestSerialRef.current) return;
        setTopologyState({ status: "ready", requestKey: topologyRequestKey, snapshot });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || requestSerial !== topologyRequestSerialRef.current) return;
        setTopologyState({
          status: "error",
          requestKey: topologyRequestKey,
          message: errorMessage(reason, "Could not load the project map."),
          ...(stale ? { stale } : {}),
        });
      },
    );
    return () => controller.abort();
  }, [projectId, topologyRequestKey]);

  useEffect(() => {
    abortReconciliationGeneration(reconciliationRef.current);
    const id = ++selectionGenerationSerialRef.current;
    const generation: ReconciliationGeneration = {
      id,
      requestKey: selectionRequestKey,
      fallbackTopology: null,
      topologyController: null,
      detailController: null,
      retryUsed: false,
      handledPair: null,
    };
    reconciliationRef.current = generation;
    setRelationshipError(null);
    clearRepositorySelection();
    if (focusRecordId === null) {
      setDetailState({ status: "idle", requestKey: selectionRequestKey });
      return;
    }
    const verifiedRevision = lastVerifiedSnapshotRef.current?.projectId === projectId
      ? lastVerifiedSnapshotRef.current.projectRevision
      : null;
    const cacheRevision = verifiedRevision === null || verifiedRevision === projectRevision
      ? projectRevision
      : null;
    const cachedDetail = cacheRevision === null
      ? undefined
      : detailCacheRef.current.get(detailCacheKey(projectId, focusRecordId, cacheRevision));
    if (cachedDetail !== undefined) {
      selectRepositoryRecord(focusRecordId);
      const cacheMatchesReadyTopology = (
        topologyState.status === "ready" &&
        topologyState.requestKey === topologyRequestKey &&
        topologyState.snapshot.projectRevision === cachedDetail.projectRevision
      );
      setDetailState({
        status: cacheMatchesReadyTopology ? "ready" : "staged",
        requestKey: selectionRequestKey,
        detail: cachedDetail,
      });
      return;
    }
    const controller = new AbortController();
    generation.detailController = controller;
    setDetailState({ status: "loading", requestKey: selectionRequestKey });
    void loadDetail(projectId, focusRecordId, controller.signal).then(
      (detail) => {
        if (controller.signal.aborted || reconciliationRef.current?.id !== id) return;
        setDetailState({ status: "staged", requestKey: selectionRequestKey, detail });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || reconciliationRef.current?.id !== id) return;
        setDetailState({
          status: "error",
          requestKey: selectionRequestKey,
          message: errorMessage(reason, "Could not load connected detail."),
        });
      },
    );
    return () => abortReconciliationGeneration(generation);
  }, [
    clearRepositorySelection,
    focusRecordId,
    projectId,
    projectRevision,
    selectionRequestKey,
  ]);

  const priorTopology = topologyState.status === "ready"
    ? topologyState.snapshot
    : topologyState.stale;
  const currentTopology = topologyState.requestKey === topologyRequestKey
    ? topologyState
    : {
        status: "loading",
        requestKey: topologyRequestKey,
        ...(priorTopology?.projectId === projectId ? { stale: priorTopology } : {}),
      } as TopologyState;
  const snapshot = currentTopology.status === "ready"
    ? currentTopology.snapshot
    : currentTopology.stale ?? null;
  const currentDetail = detailState.requestKey === selectionRequestKey
    ? detailState
    : { status: focusRecordId === null ? "idle" : "loading", requestKey: selectionRequestKey } as DetailState;

  useEffect(() => {
    if (focusRecordId === null && currentTopology.status === "ready") {
      lastVerifiedSnapshotRef.current = currentTopology.snapshot;
    }
  }, [currentTopology, focusRecordId]);

  const refreshDashboard = useCallback((revision: number) => {
    const key = JSON.stringify([projectId, revision]);
    const current = dashboardSynchronizationRef.current;
    if (current?.key === key && !current.controller.signal.aborted) return;
    current?.controller.abort();
    const controller = new AbortController();
    const synchronization: DashboardSynchronization = { key, projectId, controller };
    dashboardSynchronizationRef.current = synchronization;
    void apiRequest<unknown>(projectEndpoint(projectId, "/dashboard"), { signal: controller.signal }).then(
      (body) => {
        if (controller.signal.aborted || dashboardSynchronizationRef.current !== synchronization) return;
        const parsed = projectDashboardResponseSchemaFor(projectId).safeParse(body);
        if (parsed.success) onDashboardRefetched?.(parsed.data);
      },
      () => undefined,
    ).finally(() => {
      if (dashboardSynchronizationRef.current === synchronization) {
        dashboardSynchronizationRef.current = null;
      }
    });
  }, [onDashboardRefetched, projectId]);

  useEffect(() => () => {
    const synchronization = dashboardSynchronizationRef.current;
    if (synchronization?.projectId === projectId) {
      synchronization.controller.abort();
      dashboardSynchronizationRef.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    if (
      focusRecordId === null ||
      currentTopology.status !== "ready" ||
      currentDetail.status !== "staged"
    ) return;
    const generation = reconciliationRef.current;
    if (generation === null || generation.requestKey !== selectionRequestKey) return;
    const topology = currentTopology.snapshot;
    if (!topology.nodesById.has(focusRecordId)) {
      setDetailState({
        status: "error",
        requestKey: selectionRequestKey,
        message: "The selected record is not present in the verified project map.",
      });
      return;
    }
    if (scopeRecordId !== null && !topology.nodesById.has(scopeRecordId)) {
      setDetailState({
        status: "error",
        requestKey: selectionRequestKey,
        message: "The selected scope is not present in the verified project map.",
      });
      return;
    }
    if (scopeRecordId !== null && topology.unplacedIds.has(scopeRecordId)) {
      setDetailState({
        status: "error",
        requestKey: selectionRequestKey,
        message: "The selected scope is not a valid hierarchy branch.",
      });
      return;
    }
    if (
      scopeRecordId !== null &&
      !isWithinScope(topology, focusRecordId, scopeRecordId)
    ) {
      setDetailState({
        status: "error",
        requestKey: selectionRequestKey,
        message: "The selected scope does not contain the selected record.",
      });
      return;
    }
    const pair = `${topology.projectRevision}:${currentDetail.detail.projectRevision}:${generation.retryUsed}`;
    if (generation.handledPair === pair) return;
    generation.handledPair = pair;
    const result = reconcileProjectMapRevisions({
      topologyRevision: topology.projectRevision,
      detailRevision: currentDetail.detail.projectRevision,
      retryUsed: generation.retryUsed,
    });
    if (result.kind === "matched") {
      lastVerifiedSnapshotRef.current = topology;
      if (generation.retryUsed && topology.projectRevision !== projectRevision) {
        reconciledTopologyAdoptionRef.current = {
          snapshot: topology,
          reloadGeneration,
          sourceProjectRevision: projectRevision,
        };
      }
      selectRepositoryRecord(focusRecordId);
      detailCacheRef.current.set(
        detailCacheKey(projectId, focusRecordId, currentDetail.detail.projectRevision),
        currentDetail.detail,
      );
      setDetailState({ status: "ready", requestKey: selectionRequestKey, detail: currentDetail.detail });
      if (generation.retryUsed) refreshDashboard(topology.projectRevision);
      return;
    }
    if (result.kind === "failed") {
      const fallback = generation.fallbackTopology ?? lastVerifiedSnapshotRef.current;
      if (fallback?.projectId === projectId) {
        setTopologyState({ status: "ready", requestKey: topologyRequestKey, snapshot: fallback });
      }
      setDetailState({
        status: "error",
        requestKey: selectionRequestKey,
        message: "The selected item could not be reconciled with the project map.",
      });
      return;
    }

    generation.retryUsed = true;
    generation.handledPair = null;
    if (result.kind === "retry-topology") {
      generation.fallbackTopology ??= topology;
      generation.topologyController?.abort();
      const controller = new AbortController();
      generation.topologyController = controller;
      void loadTopology(projectId, controller.signal).then(
        (nextSnapshot) => {
          if (controller.signal.aborted || reconciliationRef.current?.id !== generation.id) return;
          setTopologyState({ status: "ready", requestKey: topologyRequestKey, snapshot: nextSnapshot });
        },
        (reason: unknown) => {
          if (controller.signal.aborted || reconciliationRef.current?.id !== generation.id) return;
          setDetailState({
            status: "error",
            requestKey: selectionRequestKey,
            message: errorMessage(reason, "The selected item could not be reconciled with the project map."),
          });
        },
      );
      return;
    }

    generation.detailController?.abort();
    const controller = new AbortController();
    generation.detailController = controller;
    setDetailState({ status: "loading", requestKey: selectionRequestKey });
    void loadDetail(projectId, focusRecordId, controller.signal).then(
      (nextDetail) => {
        if (controller.signal.aborted || reconciliationRef.current?.id !== generation.id) return;
        setDetailState({ status: "staged", requestKey: selectionRequestKey, detail: nextDetail });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || reconciliationRef.current?.id !== generation.id) return;
        setDetailState({
          status: "error",
          requestKey: selectionRequestKey,
          message: errorMessage(reason, "The selected item could not be reconciled with the project map."),
        });
      },
    );
  }, [
    currentDetail,
    currentTopology,
    focusRecordId,
    projectId,
    projectRevision,
    reloadGeneration,
    refreshDashboard,
    scopeRecordId,
    selectRepositoryRecord,
    selectionRequestKey,
    topologyRequestKey,
  ]);

  useEffect(() => () => {
    topologyControllerRef.current?.abort();
    abortReconciliationGeneration(reconciliationRef.current);
  }, []);

  useEffect(() => {
    fitWholeProjectPendingRef.current = false;
    setCameraFocusTargetId(null);
  }, [projectId]);

  useEffect(() => {
    if (!fitWholeProjectPendingRef.current || scopeRecordId !== null || currentTopology.status !== "ready") return;
    fitWholeProjectPendingRef.current = false;
    setCameraFitRequestKey((value) => value + 1);
  }, [currentTopology.status, scopeRecordId]);

  const expansionKey = snapshot === null
    ? ""
    : JSON.stringify([snapshot.projectId, snapshot.projectRevision]);
  const expandedIds = expansion.key === expansionKey ? expansion.expandedIds : emptyIds;
  const collapsedIds = expansion.key === expansionKey ? expansion.collapsedIds : emptyIds;
  const selectedId = focusRecordId !== null && snapshot?.nodesById.has(focusRecordId)
    ? focusRecordId
    : null;
  const scopeExists = scopeRecordId !== null && snapshot?.nodesById.has(scopeRecordId);
  const scopeCanProject = scopeExists && snapshot !== null && !snapshot.unplacedIds.has(scopeRecordId);
  const scopeContainsSelection = scopeCanProject && snapshot !== null && selectedId !== null
    ? isWithinScope(snapshot, selectedId, scopeRecordId)
    : true;
  const validScopeId = scopeCanProject && scopeContainsSelection ? scopeRecordId : null;
  const activeRootId = validScopeId ?? (
    snapshot === null ? projectId : projectConnectorEndpointId(snapshot.projectId)
  );

  useEffect(() => {
    if (cameraFocusTargetId === null || validScopeId !== cameraFocusTargetId) return;
    setCameraFocusTargetId(null);
    setCameraFocusRequestKey((value) => value + 1);
  }, [cameraFocusTargetId, validScopeId]);
  const projectedSelectedId = selectedId !== null && snapshot?.unplacedIds.has(selectedId)
    ? null
    : selectedId;
  const routeError = snapshot === null
    ? null
    : focusRecordId !== null && selectedId === null
      ? "The selected record is not present in the verified project map."
      : scopeRecordId !== null && !scopeExists
        ? "The selected scope is not present in the verified project map."
        : scopeRecordId !== null && !scopeCanProject
          ? "The selected scope is not a valid hierarchy branch."
        : !scopeContainsSelection
          ? "The selected scope does not contain the selected record."
          : null;
  const localView = useMemo(() => snapshot === null
    ? null
    : deriveProjectMapLocalView({
        snapshot,
        selectedId: projectedSelectedId,
        scopeId: validScopeId,
        visibleDepth,
        expandedIds,
        collapsedIds,
      }), [collapsedIds, expandedIds, projectedSelectedId, snapshot, validScopeId, visibleDepth]);
  const projectedNodes = useMemo(() => (localView?.projectedNodes ?? []).filter(
    (node): node is typeof node & { readonly record: HierarchyRecordSummary } => isHierarchyRecord(node.record),
  ), [localView?.projectedNodes]);
  const projectedIds = useMemo(
    () => new Set(projectedNodes.map((node) => node.record.id)),
    [projectedNodes],
  );
  const scopePath = useMemo(() => {
    if (snapshot === null || validScopeId === null) return [];
    return deriveProjectMapLocalView({
      snapshot,
      selectedId: validScopeId,
      scopeId: null,
      visibleDepth,
      expandedIds,
      collapsedIds,
    }).selectedPath.filter(isHierarchyRecord);
  }, [collapsedIds, expandedIds, snapshot, validScopeId, visibleDepth]);
  const geometryRevision = useMemo(() => JSON.stringify([
    snapshot?.projectId ?? projectId,
    snapshot?.projectRevision ?? null,
    validScopeId,
    projectedNodes.map((node) => [
      node.record.id,
      node.parentId,
      node.depth,
      node.childCount,
      node.hiddenChildCount,
    ]),
  ]), [projectId, projectedNodes, snapshot?.projectId, snapshot?.projectRevision, validScopeId]);

  const directRelations = routeError === null && currentDetail.status === "ready"
    ? currentDetail.detail.relations.filter((relation) => (
        relation.depth === 1 && relation.edge.kind !== "parent_of"
      ))
    : [];
  const connections: readonly ProjectMapConnector[] = useMemo(
    () => directRelations.flatMap((relation): ProjectMapConnector[] => (
      isHierarchyKind(relation.record.kind) &&
      projectedIds.has(relation.edge.fromRecordId) &&
      projectedIds.has(relation.edge.toRecordId)
        ? [{
            id: relation.edge.id,
            fromRecordId: relation.edge.fromRecordId,
            toRecordId: relation.edge.toRecordId,
            label: relation.edge.label,
            style: "cross",
          }]
        : []
    )),
    [directRelations, projectedIds],
  );

  const changeExpansion = (recordId: string, expanded: boolean) => {
    setExpansion((current) => {
      const nextExpanded = new Set(current.key === expansionKey ? current.expandedIds : []);
      const nextCollapsed = new Set(current.key === expansionKey ? current.collapsedIds : []);
      if (expanded) {
        nextExpanded.add(recordId);
        nextCollapsed.delete(recordId);
      } else {
        nextExpanded.delete(recordId);
        nextCollapsed.add(recordId);
      }
      return { key: expansionKey, expandedIds: nextExpanded, collapsedIds: nextCollapsed };
    });
  };

  const selectRelated = (recordId: string) => {
    if (snapshot === null) return;
    const target = snapshot.nodesById.get(recordId);
    if (target === undefined) {
      setRelationshipError("That related item is not present in the verified project map.");
      return;
    }
    const withinScope = isWithinScope(snapshot, recordId, validScopeId);
    if (!projectedIds.has(recordId) && withinScope && !snapshot.unplacedIds.has(recordId)) {
      setExpansion((current) => {
        const nextExpanded = new Set(current.key === expansionKey ? current.expandedIds : []);
        const nextCollapsed = new Set(current.key === expansionKey ? current.collapsedIds : []);
        for (const id of ancestorIds(snapshot, recordId)) {
          nextExpanded.add(id);
          nextCollapsed.delete(id);
        }
        return { key: expansionKey, expandedIds: nextExpanded, collapsedIds: nextCollapsed };
      });
    }
    onSelectRecord(recordId, withinScope ? validScopeId : null);
  };

  const closeInspector = () => {
    const recordId = focusRecordId;
    const treeButton = recordId === null
      ? null
      : [...document.querySelectorAll<HTMLElement>("[data-record-id]")].find(
          (element) => element.dataset.recordId === recordId,
        ) ?? null;
    const unplacedButton = recordId === null
      ? null
      : [...document.querySelectorAll<HTMLButtonElement>("[data-unplaced-record-id]")].find(
          (element) => element.dataset.unplacedRecordId === recordId,
        ) ?? null;
    selectedButtonRef.current = treeButton ?? unplacedButton;
    pendingFocusRestoreRef.current = true;
    onClearSelection(validScopeId);
  };

  useLayoutEffect(() => {
    if (focusRecordId !== null || !pendingFocusRestoreRef.current) return;
    pendingFocusRestoreRef.current = false;
    if (selectedButtonRef.current?.isConnected) selectedButtonRef.current.focus();
    else document.querySelector<HTMLElement>(".project-map-camera__viewport")?.focus();
    selectedButtonRef.current = null;
  }, [focusRecordId]);

  useEffect(() => {
    if (focusRecordId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-project-map-camera-shell]") === null) return;
      event.preventDefault();
      closeInspector();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const nodeRequestKey = JSON.stringify([projectId, selectedRepositoryNodeId]);
  useEffect(() => {
    if (selectedRepositoryNodeId === null) {
      setNodeDetailState({ status: "idle", requestKey: nodeRequestKey });
      return;
    }
    const nodeId = selectedRepositoryNodeId;
    const controller = new AbortController();
    setNodeDetailState({ status: "loading", requestKey: nodeRequestKey });
    void apiRequest<ConnectedRepositoryDetailResponse>(
      projectEndpoint(projectId, `/repository/nodes/${encodeURIComponent(nodeId)}/connected-detail`),
      { signal: controller.signal },
    ).then(
      (detail) => {
        if (controller.signal.aborted) return;
        if (detail.projectId !== projectId || detail.node.nodeId !== nodeId) {
          setNodeDetailState({
            status: "error",
            requestKey: nodeRequestKey,
            message: "Repository detail did not match the selected repository node.",
          });
          return;
        }
        setNodeDetailState({ status: "ready", requestKey: nodeRequestKey, detail });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setNodeDetailState({
          status: "error",
          requestKey: nodeRequestKey,
          message: errorMessage(reason, "Could not load repository connections."),
        });
      },
    );
    return () => controller.abort();
  }, [nodeRequestKey, projectId, selectedRepositoryNodeId]);
  const currentNodeState = nodeDetailState.requestKey === nodeRequestKey
    ? nodeDetailState
    : { status: selectedRepositoryNodeId === null ? "idle" : "loading", requestKey: nodeRequestKey } as NodeDetailState;

  const handleOcclusionInsetsChange = useCallback((next: CameraInsets) => {
    setOcclusionInsets((current) => (
      current.top === next.top &&
      current.right === next.right &&
      current.bottom === next.bottom &&
      current.left === next.left
        ? current
        : next
    ));
  }, []);
  const selectedSummary = selectedId === null || snapshot === null
    ? null
    : snapshot.nodesById.get(selectedId) ?? null;
  const inspectorDetailState: ProjectMapInspectorDetailState = routeError !== null
    ? {
        status: "error",
        message: routeError,
        onRetry: () => setReloadGeneration((value) => value + 1),
      }
    : currentDetail.status === "ready"
      ? { status: "ready", detail: currentDetail.detail }
      : currentDetail.status === "error"
        ? {
            status: "error",
            message: currentDetail.message,
            onRetry: () => setDetailRetryGeneration((value) => value + 1),
          }
        : { status: "loading" };
  const inspector = focusRecordId === null ? null : (
    <ProjectMapInspector
      detailState={inspectorDetailState}
      onClose={closeInspector}
      onFocusBranch={(recordId) => {
        setCameraFocusTargetId(recordId);
        onFocusBranch(recordId);
      }}
      onNavigateAttachment={onNavigateAttachment}
      onOcclusionInsetsChange={handleOcclusionInsetsChange}
      onSelectRelated={selectRelated}
      routeRecordId={focusRecordId}
      relationshipError={relationshipError}
      scopeRecordId={validScopeId}
      selected={selectedSummary}
    />
  );

  return (
    <div
      className="project-map"
      data-route-state={JSON.stringify({ focusRecordId, scopeRecordId })}
      data-testid="project-map"
      data-visible-depth={visibleDepth}
    >
      <div className="stage__header">
        <div><h1>Project map</h1></div>
        <div className="project-map__controls">
          {connections.length > 0 ? (
            <button
              aria-label="Cross-links"
              aria-pressed={showConnections}
              onClick={() => setShowConnections((value) => !value)}
              type="button"
            >
              Cross-links: {showConnections ? "shown" : "hidden"}
            </button>
          ) : null}
        </div>
      </div>

      {currentTopology.status === "loading" ? <p role="status">Loading project map…</p> : null}
      {currentTopology.status === "error" ? (
        <div role="alert">
          <p>{currentTopology.message}</p>
          {currentTopology.stale ? <p>The last verified project map remains visible.</p> : null}
          <button onClick={() => setReloadGeneration((value) => value + 1)} type="button">Retry map</button>
        </div>
      ) : null}
      {focusRecordId === null && routeError !== null && snapshot?.nodes.length !== 0
        ? <p role="alert">{routeError}</p>
        : null}
      {snapshot === null && focusRecordId !== null ? (
        <div className="project-map__canvas-shell project-map__canvas-shell--cold">
          {inspector}
        </div>
      ) : null}

      {snapshot !== null && localView !== null ? (
        <>
          <nav aria-label="Selected project path">
            <ol className="project-map__breadcrumbs">
              <li>
                {selectedId === null ? (
                  <span aria-current="page">Project: {snapshot.projectName}</span>
                ) : (
                  <a
                    href={`/projects/${encodeURIComponent(projectId)}/map`}
                    onClick={(event) => { event.preventDefault(); onSelectProject(); }}
                  >
                    Project: {snapshot.projectName}
                  </a>
                )}
              </li>
              {localView.selectedPath.map((record) => (
                <li key={record.id}>
                  {record.id === selectedId ? (
                    <span aria-current="page">{record.title}</span>
                  ) : (
                    <button onClick={() => selectRelated(record.id)} type="button">
                      {record.title}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          {snapshot.nodes.length === 0 ? (
            <div className="project-map__canvas-shell project-map__canvas-shell--cold">
              <section aria-labelledby="project-map-empty-heading" className="project-map__empty">
                <h2 id="project-map-empty-heading">No project hierarchy yet</h2>
                {focusRecordId === null && routeError !== null ? (
                  <div className="project-map__route-error" role="alert">
                    <p>{routeError}</p>
                    <div>
                      <button
                        onClick={() => setReloadGeneration((value) => value + 1)}
                        type="button"
                      >
                        Retry map
                      </button>
                      <button onClick={() => onClearSelection(null)} type="button">
                        Close route error
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
              {inspector}
            </div>
          ) : (
            <div className="project-map__layout">
              <div className="project-map__hierarchy">
                <div className="project-map__canvas-shell">
                  <ProjectHierarchyView
                    activeRootId={activeRootId}
                    cameraFitRequestKey={cameraFitRequestKey}
                    cameraLayoutRevision={geometryRevision}
                    connections={connections}
                    nodes={projectedNodes}
                    focusRequestKey={cameraFocusRequestKey}
                    occlusionInsets={occlusionInsets}
                    onSelect={(recordId) => onSelectRecord(recordId, validScopeId)}
                    onSelectProject={onSelectProject}
                    onExpandedChange={changeExpansion}
                    onShowWholeProject={() => {
                      fitWholeProjectPendingRef.current = true;
                      onShowWholeProject(selectedId);
                    }}
                    project={{ id: snapshot.projectId, name: snapshot.projectName }}
                    revealRecordId={projectedSelectedId}
                    scopeRecordId={validScopeId}
                    scopePath={scopePath}
                    selectedId={selectedId}
                    showConnections={showConnections}
                    vocabulary={snapshot.vocabulary}
                  />
                  {inspector}
                </div>
                <p className="project-map__rollup">{progressRollup(snapshot)}</p>
                {localView.unplaced.length > 0 ? (
                  <section aria-labelledby="project-map-unplaced-heading">
                    <h2 id="project-map-unplaced-heading">Unplaced work</h2>
                    <p>{localView.unplaced.length} {localView.unplaced.length === 1 ? "item" : "items"}</p>
                    <ul>
                      {localView.unplaced.map((record) => (
                        <li key={record.id}>
                          <button
                            aria-pressed={record.id === selectedId}
                            data-unplaced-record-id={record.id}
                            onClick={() => onSelectRecord(record.id, null)}
                            type="button"
                          >
                            {record.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>

            </div>
          )}
        </>
      ) : null}

      {selectedRepositoryNodeId !== null ? (
        <section aria-label="Repository selection" className="project-map__repository-detail">
          <h2>Repository connection</h2>
          {currentNodeState.status === "loading" ? <p role="status">Loading repository connection…</p> : null}
          {currentNodeState.status === "error" ? <p role="alert">{currentNodeState.message}</p> : null}
          {currentNodeState.status === "ready" ? <RepositoryDetail detail={currentNodeState.detail} /> : null}
          <button onClick={clearRepositorySelection} type="button">Close repository detail</button>
        </section>
      ) : null}
    </div>
  );
}

function RepositoryDetail({ detail }: { readonly detail: ConnectedRepositoryDetailResponse }) {
  return (
    <div>
      <p><strong>{detail.node.path}</strong></p>
      <p>{readable(detail.node.kind)} · {readable(detail.node.role)} · {detail.node.contentEligible ? "Content eligible" : "Metadata only"}</p>
      {bases.map((basis) => {
        const links = detail.linksByBasis[basis];
        return links.length === 0 ? null : (
          <section key={basis}>
            <h3>{readable(basis)} connections</h3>
            <ul>{links.map((link) => <li key={link.linkId}>{link.label} · {link.record?.title ?? link.node?.path}</li>)}</ul>
          </section>
        );
      })}
    </div>
  );
}
