import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  clampProjectCameraInput,
  clampProjectCamera,
  clampProjectCameraReachability,
  fitProjectCamera,
  focusProjectMapRoot,
  initialProjectMapCamera,
  PROJECT_MAP_MAX_SCALE,
  PROJECT_MAP_MIN_SCALE,
  PROJECT_MAP_PAN_STEP,
  PROJECT_MAP_ZOOM_STEP,
  projectMapCameraContinuity,
  projectMapPanAvailability,
  recenterProjectCamera,
  type CameraBounds,
  type CameraInsets,
  type CameraSize,
  type ProjectMapCameraState,
  type ProjectMapCameraContinuity,
  zoomProjectCameraAt,
} from "./project-map-camera.js";
import { readProjectMapRenderedCamera } from "./project-map-rendered-camera.js";

export interface ProjectMapCameraInputs {
  readonly activeRootId: string;
  readonly focusRequestKey: number;
  readonly scopeRecordId: string | null;
  readonly occlusionInsets: CameraInsets;
  readonly revealRecordId?: string | null | undefined;
}

export interface ProjectMapCameraCanvasProps extends ProjectMapCameraInputs {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly fitRequestKey: number;
  readonly layoutRevision: number | string;
  readonly measuredLayoutRevision: number | string;
  readonly projectId: string;
  readonly structuralLayoutRevision: number | string;
}

export interface ProjectMapCameraContextValue {
  readonly camera: ProjectMapCameraState;
  readonly worldRef: RefObject<HTMLDivElement | null>;
}

type MeasureReason =
  | "initial"
  | "initial-layout-replay"
  | "fit-request"
  | "focus-request"
  | "insets"
  | "layout"
  | "reveal-request"
  | "window-resize";
type CameraPoint = { x: number; y: number };

interface ObservedLayoutExtents {
  readonly viewport: CameraSize;
  readonly world: CameraSize;
}

interface ActivePointer {
  readonly activationBoundary: Element;
  captured: boolean;
  current: CameraPoint;
  dragging: boolean;
  mode: "primary" | "space" | "middle" | "touch";
  pointerType: string;
  start: CameraPoint;
}

interface PendingFocusLayoutReplay {
  readonly activeRootId: string;
  readonly focusRequestKey: number;
  readonly measuredLayoutRevision: number | string;
  readonly projectId: string;
  readonly revealRecordId: string | null;
  readonly scopeRecordId: string | null;
  readonly structuralLayoutRevision: number | string;
}

interface PendingInitialLayoutReplay {
  readonly activeRootId: string;
  readonly focusRequestKey: number;
  readonly measuredLayoutRevision: number | string;
  readonly projectId: string;
  readonly revealRecordId: string | null;
  readonly scopeRecordId: string | null;
  readonly structuralLayoutRevision: number | string;
}

interface PendingInitialScopedInsets {
  readonly projectId: string;
  readonly revealRecordId: string;
  readonly scopeRecordId: string;
}

const initialCamera: ProjectMapCameraState = { scale: 1, x: 0, y: 0 };
const CAMERA_DRAG_THRESHOLD = 4;
const CAMERA_ACTIVATION_SUPPRESSION_MS = 100;
const CAMERA_CONTENT_BOUNDS_SELECTOR = [
  "[data-connector-record-id]",
  "path[data-connector-id]",
].join(",");
const CAMERA_BLOCKING_SELECTOR = [
  "button", "a", "input", "select", "textarea", "summary",
  "[role='treeitem']", "[role='dialog']", "[contenteditable='true']",
  "[data-camera-interactive]",
].join(",");
const CAMERA_MIDDLE_BLOCKING_SELECTOR = [
  "button:not([data-expansion-control])", "a", "input", "select", "textarea", "summary",
  "[role='dialog']", "[contenteditable='true']", "[data-camera-interactive-control]",
].join(",");
const CAMERA_ACTIVATION_BOUNDARY_SELECTOR = [
  "button", "a", "input", "select", "textarea", "summary",
  "[role='treeitem']", "[role='dialog']", "[contenteditable='true']",
  "[data-camera-interactive]", "[data-camera-interactive-control]",
].join(",");
const ProjectMapCameraContext = createContext<ProjectMapCameraContextValue | null>(null);
const ProjectMapCameraWorldContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
const measurePriority: Record<MeasureReason, number> = {
  "fit-request": 2,
  "focus-request": 3,
  initial: 2,
  "initial-layout-replay": 3,
  insets: 1,
  layout: 1,
  "reveal-request": 3,
  "window-resize": 2,
};

const paddingFor = (width: number): number => width >= 760 ? 40 : 24;
const mediaMatches = (query: string): boolean => (
  typeof window.matchMedia === "function" && window.matchMedia(query).matches
);

const sizeChanged = (left: CameraSize, right: CameraSize): boolean => (
  left.width !== right.width || left.height !== right.height
);

const layoutExtentsChanged = (
  left: ObservedLayoutExtents,
  right: ObservedLayoutExtents,
): boolean => sizeChanged(left.viewport, right.viewport) || sizeChanged(left.world, right.world);

const observedLayoutExtents = (
  viewport: HTMLDivElement,
  world: HTMLDivElement,
): ObservedLayoutExtents => ({
  viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
  world: { width: world.scrollWidth, height: world.scrollHeight },
});

const sameCamera = (left: ProjectMapCameraState, right: ProjectMapCameraState): boolean => (
  left.scale === right.scale && left.x === right.x && left.y === right.y
);

const cameraTransform = (camera: ProjectMapCameraState): string =>
  `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`;

const canStartCameraGesture = (target: EventTarget | null): target is Element =>
  target instanceof Element && (
    target.matches(".project-map-camera__viewport") ||
    target.closest("[data-camera-pan-surface]") !== null
  ) &&
  target.closest(CAMERA_BLOCKING_SELECTOR) === null;

const cameraActivationBoundary = (target: Element): Element =>
  target.closest(CAMERA_ACTIVATION_BOUNDARY_SELECTOR) ?? target;

const distanceBetween = (left: CameraPoint, right: CameraPoint): number =>
  Math.hypot(right.x - left.x, right.y - left.y);

const midpointBetween = (left: CameraPoint, right: CameraPoint): CameraPoint => ({
  x: (left.x + right.x) / 2,
  y: (left.y + right.y) / 2,
});

const boundsWithinWorld = (
  world: HTMLDivElement,
  element: Element,
  renderedScale: number,
): CameraBounds | null => {
  const worldBounds = world.getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  const width = bounds.width / renderedScale;
  const height = bounds.height / renderedScale;
  if (width <= 0 || height <= 0) return null;
  return {
    x: (bounds.left - worldBounds.left) / renderedScale,
    y: (bounds.top - worldBounds.top) / renderedScale,
    width,
    height,
  };
};

const activeRootBounds = (
  world: HTMLDivElement,
  renderedScale: number,
  activeRootId: string,
): CameraBounds | null => {
  const root = [...world.querySelectorAll("[data-connector-record-id]")]
    .find((element) => element.getAttribute("data-connector-record-id") === activeRootId);
  return root === undefined ? null : boundsWithinWorld(world, root, renderedScale);
};

const recordBounds = (
  world: HTMLDivElement,
  renderedScale: number,
  recordId: string,
): CameraBounds | null => {
  const record = [...world.querySelectorAll("[data-connector-record-id]")]
    .find((element) => element.getAttribute("data-connector-record-id") === recordId);
  return record === undefined ? null : boundsWithinWorld(world, record, renderedScale);
};

const revealFullyCoveredBounds = (
  camera: ProjectMapCameraState,
  viewport: CameraSize,
  bounds: CameraBounds,
  insets: CameraInsets,
): ProjectMapCameraState => {
  const safeLeft = insets.left;
  const safeRight = viewport.width - insets.right;
  const safeTop = insets.top;
  const safeBottom = viewport.height - insets.bottom;
  const left = camera.x + bounds.x * camera.scale;
  const right = left + bounds.width * camera.scale;
  const top = camera.y + bounds.y * camera.scale;
  const bottom = top + bounds.height * camera.scale;
  const fullyCovered = right <= safeLeft || left >= safeRight || bottom <= safeTop || top >= safeBottom;
  if (!fullyCovered) return camera;

  let x = camera.x;
  let y = camera.y;
  if (right <= safeLeft) x += safeLeft - left;
  else if (left >= safeRight) x += safeRight - right;
  if (bottom <= safeTop) y += safeTop - top;
  else if (top >= safeBottom) y += safeBottom - bottom;
  return { scale: camera.scale, x, y };
};

function contentBounds(
  world: HTMLDivElement,
  renderedScale: number,
): CameraBounds | null {
  const worldBounds = world.getBoundingClientRect();
  const renderedBounds = [...world.querySelectorAll(CAMERA_CONTENT_BOUNDS_SELECTOR)]
    .map((element) => element.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 || bounds.height > 0)
    .map((bounds) => ({
      bottom: (bounds.bottom - worldBounds.top) / renderedScale,
      left: (bounds.left - worldBounds.left) / renderedScale,
      right: (bounds.right - worldBounds.left) / renderedScale,
      top: (bounds.top - worldBounds.top) / renderedScale,
    }));
  if (renderedBounds.length === 0) return null;

  const x = Math.min(...renderedBounds.map((bounds) => bounds.left));
  const y = Math.min(...renderedBounds.map((bounds) => bounds.top));
  const right = Math.max(...renderedBounds.map((bounds) => bounds.right));
  const bottom = Math.max(...renderedBounds.map((bounds) => bounds.bottom));
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function useProjectMapCamera(): ProjectMapCameraContextValue {
  const value = useContext(ProjectMapCameraContext);
  if (value === null) {
    throw new Error("useProjectMapCamera must be used inside ProjectMapCameraCanvas.");
  }
  return value;
}

export function useProjectMapCameraWorldRef(): RefObject<HTMLDivElement | null> {
  const value = useContext(ProjectMapCameraWorldContext);
  if (value === null) {
    throw new Error("useProjectMapCameraWorldRef must be used inside ProjectMapCameraCanvas.");
  }
  return value;
}

export function ProjectMapCameraCanvas({
  activeRootId,
  ariaLabel,
  children,
  fitRequestKey,
  focusRequestKey,
  layoutRevision,
  measuredLayoutRevision,
  occlusionInsets,
  projectId,
  revealRecordId = null,
  scopeRecordId,
  structuralLayoutRevision,
}: ProjectMapCameraCanvasProps): JSX.Element {
  const instructionsId = useId();
  const moveMapId = useId();
  const controlDeckRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const moveMapTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moveMapPanelRef = useRef<HTMLDivElement | null>(null);
  const activePointersRef = useRef(new Map<number, ActivePointer>());
  const animationFrameRef = useRef<number | null>(null);
  const layoutObserverSuppressionFrameRef = useRef<number | null>(null);
  const suppressEquivalentLayoutObserverRef = useRef(false);
  const measurementGenerationRef = useRef(0);
  const scheduledReasonRef = useRef<MeasureReason | null>(null);
  const fitTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitTransitionRef = useRef(false);
  const initialFallbackProjectIdRef = useRef<string | null>(null);
  const initialFitProjectIdRef = useRef<string | null>(null);
  const pendingInitialLayoutReplayRef = useRef<PendingInitialLayoutReplay | null>(null);
  const pendingInitialScopedInsetsRef = useRef<PendingInitialScopedInsets | null>(null);
  const previousProjectIdRef = useRef(projectId);
  const previousFitRequestKeyRef = useRef(fitRequestKey);
  const previousFocusRequestKeyRef = useRef(focusRequestKey);
  const previousOcclusionInsetsRef = useRef(occlusionInsets);
  const cameraContinuityRef = useRef<ProjectMapCameraContinuity>({ x: false, y: false });
  const pendingInsetContinuityRef = useRef(false);
  const previousRevealRecordIdRef = useRef(revealRecordId);
  const previousViewportRef = useRef<CameraSize | null>(null);
  const previousObservedLayoutExtentsRef = useRef<ObservedLayoutExtents | null>(null);
  const latestContentRef = useRef<CameraBounds | null>(null);
  const cameraRef = useRef<ProjectMapCameraState>(initialCamera);
  const lastVerifiedRenderedCameraRef = useRef<ProjectMapCameraState>(initialCamera);
  const previousLayoutRevisionRef = useRef(layoutRevision);
  const pendingFocusLayoutReplayRef = useRef<PendingFocusLayoutReplay | null>(null);
  const [camera, setCamera] = useState<ProjectMapCameraState>(initialCamera);
  const [hasMeasurement, setHasMeasurement] = useState(false);
  const [, setMeasurementRevision] = useState(0);
  const [fitTransition, setFitTransition] = useState(false);
  const [cameraDragging, setCameraDragging] = useState(false);
  const [spacePanArmed, setSpacePanArmed] = useState(false);
  const [touchOnly, setTouchOnly] = useState(false);
  const [moveMapOpen, setMoveMapOpen] = useState(false);
  const [moveMapPanelAbove, setMoveMapPanelAbove] = useState(false);
  const [moveMapPanelRight, setMoveMapPanelRight] = useState(0);
  const spacePanArmedRef = useRef(false);
  const cameraPannableRef = useRef(false);
  const suppressedActivationBoundariesRef = useRef(new Map<number, Element>());
  const suppressionCleanupTimersRef = useRef(new Map<
    number,
    ReturnType<typeof setTimeout>
  >());

  const clearPendingPlacementReplays = useCallback(() => {
    pendingInitialLayoutReplayRef.current = null;
    pendingFocusLayoutReplayRef.current = null;
    pendingInitialScopedInsetsRef.current = null;
  }, []);

  const clearClickSuppression = useCallback((pointerId?: number) => {
    if (pointerId === undefined) {
      for (const timer of suppressionCleanupTimersRef.current.values()) clearTimeout(timer);
      suppressionCleanupTimersRef.current.clear();
      suppressedActivationBoundariesRef.current.clear();
      return;
    }
    const timer = suppressionCleanupTimersRef.current.get(pointerId);
    if (timer !== undefined) clearTimeout(timer);
    suppressionCleanupTimersRef.current.delete(pointerId);
    suppressedActivationBoundariesRef.current.delete(pointerId);
  }, []);

  const expireClickSuppression = useCallback((pointerId: number) => {
    if (!suppressedActivationBoundariesRef.current.has(pointerId)) return;
    // Chromium emits auxclick in a later task after middle-button pointerup.
    const timer = setTimeout(
      () => clearClickSuppression(pointerId),
      CAMERA_ACTIVATION_SUPPRESSION_MS,
    );
    suppressionCleanupTimersRef.current.set(pointerId, timer);
  }, [clearClickSuppression]);

  const verifiedRenderedCamera = useCallback((world: HTMLDivElement): ProjectMapCameraState => {
    const renderedCamera = readProjectMapRenderedCamera(world);
    if (renderedCamera !== null) {
      lastVerifiedRenderedCameraRef.current = renderedCamera;
      return renderedCamera;
    }
    return lastVerifiedRenderedCameraRef.current;
  }, []);

  useLayoutEffect(() => {
    if (!fitTransitionRef.current) lastVerifiedRenderedCameraRef.current = camera;
  }, [camera, fitTransition]);

  const clearFitTransition = useCallback(() => {
    if (fitTransitionTimerRef.current !== null) {
      clearTimeout(fitTransitionTimerRef.current);
      fitTransitionTimerRef.current = null;
    }
    fitTransitionRef.current = false;
    setFitTransition(false);
  }, []);

  const showFitTransition = useCallback(() => {
    clearFitTransition();
    if (mediaMatches("(prefers-reduced-motion: reduce)")) return;
    fitTransitionRef.current = true;
    setFitTransition(true);
    fitTransitionTimerRef.current = setTimeout(() => {
      fitTransitionTimerRef.current = null;
      fitTransitionRef.current = false;
      setFitTransition(false);
    }, 140);
  }, [clearFitTransition]);

  const interruptFitTransition = useCallback((): ProjectMapCameraState => {
    if (!fitTransitionRef.current) return cameraRef.current;
    const world = worldRef.current;
    const renderedCamera = world === null
      ? lastVerifiedRenderedCameraRef.current
      : verifiedRenderedCamera(world);
    clearFitTransition();
    if (world !== null) {
      world.dataset.cameraFitTransition = "false";
      world.style.transform = cameraTransform(renderedCamera);
    }
    cameraRef.current = renderedCamera;
    setCamera((current) => sameCamera(current, renderedCamera) ? current : renderedCamera);
    return renderedCamera;
  }, [clearFitTransition, verifiedRenderedCamera]);

  const applyDirectCamera = useCallback((
    update: (current: ProjectMapCameraState) => ProjectMapCameraState,
  ) => {
    if (initialFitProjectIdRef.current !== projectId) return;
    clearPendingPlacementReplays();
    const nextCamera = update(interruptFitTransition());
    cameraRef.current = nextCamera;
    setCamera((current) => sameCamera(current, nextCamera) ? current : nextCamera);
  }, [clearPendingPlacementReplays, interruptFitTransition, projectId]);

  const applyCameraInput = useCallback((
    update: (current: ProjectMapCameraState) => ProjectMapCameraState,
    mode: "pan" | "zoom" = "pan",
  ) => {
    const viewport = previousViewportRef.current;
    const content = latestContentRef.current;
    if (viewport === null || content === null) return;
    applyDirectCamera((current) => {
      const result = clampProjectCameraInput(
        current,
        update(current),
        cameraContinuityRef.current,
        viewport,
        content,
        occlusionInsets,
        mode,
      );
      cameraContinuityRef.current = result.continuity;
      return result.camera;
    });
  }, [
    applyDirectCamera,
    occlusionInsets.bottom,
    occlusionInsets.left,
    occlusionInsets.right,
    occlusionInsets.top,
  ]);

  const measure = useCallback((reason: MeasureReason) => {
    const viewportElement = viewportRef.current;
    const world = worldRef.current;
    if (viewportElement === null || world === null) return;
    const observedExtents = observedLayoutExtents(viewportElement, world);
    const viewport = observedExtents.viewport;
    if (viewport.width <= 0 || viewport.height <= 0) return;
    previousObservedLayoutExtentsRef.current = observedExtents;

    const needsInitialFit = initialFitProjectIdRef.current !== projectId;
    const renderedCamera = verifiedRenderedCamera(world);
    const content = contentBounds(world, renderedCamera.scale);
    if (content === null) {
      if (needsInitialFit && initialFallbackProjectIdRef.current !== projectId) {
        const padding = paddingFor(viewport.width);
        const fallbackCamera = { scale: 1, x: padding, y: padding };
        initialFallbackProjectIdRef.current = projectId;
        cameraRef.current = fallbackCamera;
        setCamera((current) => sameCamera(current, fallbackCamera) ? current : fallbackCamera);
      }
      return;
    }
    const root = activeRootBounds(world, renderedCamera.scale, activeRootId);
    if (root === null && needsInitialFit) return;

    const priorViewport = previousViewportRef.current;
    let nextCamera = cameraRef.current;
    if (reason === "fit-request" || reason === "window-resize") {
      clearPendingPlacementReplays();
    }
    if (needsInitialFit && root !== null) {
      nextCamera = initialProjectMapCamera(viewport, root, occlusionInsets);
      initialFitProjectIdRef.current = projectId;
      pendingInitialLayoutReplayRef.current = {
        activeRootId,
        focusRequestKey,
        measuredLayoutRevision,
        projectId,
        revealRecordId,
        scopeRecordId,
        structuralLayoutRevision,
      };
      pendingInitialScopedInsetsRef.current = scopeRecordId !== null &&
        revealRecordId !== null &&
        occlusionInsets.top === 0 &&
        occlusionInsets.right === 0 &&
        occlusionInsets.bottom === 0 &&
        occlusionInsets.left === 0
        ? { projectId, revealRecordId, scopeRecordId }
        : null;
      showFitTransition();
    } else if (reason === "initial-layout-replay" && root !== null) {
      nextCamera = initialProjectMapCamera(viewport, root, occlusionInsets);
      showFitTransition();
    } else if (reason === "focus-request" && root !== null) {
      nextCamera = focusProjectMapRoot(nextCamera, viewport, root, occlusionInsets);
      showFitTransition();
    } else if (reason === "fit-request") {
      nextCamera = fitProjectCamera(
        viewport, content, paddingFor(viewport.width), occlusionInsets,
      ) ?? nextCamera;
      showFitTransition();
    } else if (reason === "reveal-request" && revealRecordId !== null) {
      const selectedBounds = recordBounds(world, renderedCamera.scale, revealRecordId);
      if (selectedBounds !== null) {
        nextCamera = revealFullyCoveredBounds(nextCamera, viewport, selectedBounds, occlusionInsets);
        if (!sameCamera(cameraRef.current, nextCamera)) showFitTransition();
      }
    } else if (reason === "insets") {
      // Insets update camera truth without moving the current view.
    } else if (priorViewport !== null && sizeChanged(priorViewport, viewport)) {
      nextCamera = recenterProjectCamera(
        nextCamera, priorViewport, viewport, content, occlusionInsets,
      );
      showFitTransition();
    } else if (reason === "layout") {
      // Preserve the raw structural-layout transform, clamping only into the
      // fitted slack/reachability interval when an axis would become unreachable.
      nextCamera = clampProjectCameraReachability(
        nextCamera, viewport, content, occlusionInsets,
      );
    } else {
      nextCamera = clampProjectCamera(nextCamera, viewport, content, occlusionInsets);
    }

    if (pendingInsetContinuityRef.current && (
      reason === "insets" || reason === "reveal-request"
    )) {
      cameraContinuityRef.current = projectMapCameraContinuity(
        nextCamera, viewport, content, occlusionInsets,
      );
      pendingInsetContinuityRef.current = false;
    } else if (
      needsInitialFit ||
      reason === "initial-layout-replay" ||
      reason === "fit-request" ||
      reason === "focus-request" ||
      reason === "window-resize" ||
      reason === "layout"
    ) {
      cameraContinuityRef.current = { x: false, y: false };
      pendingInsetContinuityRef.current = false;
    }

    previousViewportRef.current = viewport;
    latestContentRef.current = content;
    cameraRef.current = nextCamera;
    setHasMeasurement(true);
    setMeasurementRevision((current) => current + 1);
    setCamera((current) => sameCamera(current, nextCamera) ? current : nextCamera);
  }, [
    activeRootId,
    clearPendingPlacementReplays,
    focusRequestKey,
    layoutRevision,
    measuredLayoutRevision,
    occlusionInsets.bottom,
    occlusionInsets.left,
    occlusionInsets.right,
    occlusionInsets.top,
    projectId,
    revealRecordId,
    scopeRecordId,
    showFitTransition,
    structuralLayoutRevision,
    verifiedRenderedCamera,
  ]);

  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  }, [measure]);

  const scheduleMeasurement = useCallback((reason: MeasureReason) => {
    if (reason === "fit-request" || reason === "window-resize") {
      clearPendingPlacementReplays();
    }
    const scheduledReason = scheduledReasonRef.current;
    const supersedesQueuedPlacement = (
      reason === "fit-request" || reason === "window-resize"
    ) && (
      scheduledReason === "focus-request" || scheduledReason === "reveal-request"
    );
    if (
      !supersedesQueuedPlacement &&
      animationFrameRef.current !== null &&
      scheduledReason !== null &&
      measurePriority[scheduledReason] >= measurePriority[reason]
    ) return;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    scheduledReasonRef.current = reason;
    const generation = measurementGenerationRef.current;
    const frameId = requestAnimationFrame(() => {
      if (
        measurementGenerationRef.current !== generation ||
        animationFrameRef.current !== frameId
      ) return;
      animationFrameRef.current = null;
      scheduledReasonRef.current = null;
      measureRef.current(reason);
    });
    animationFrameRef.current = frameId;
  }, [clearPendingPlacementReplays]);

  useLayoutEffect(() => {
    if (previousProjectIdRef.current === projectId) return;
    previousProjectIdRef.current = projectId;
    measurementGenerationRef.current += 1;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (layoutObserverSuppressionFrameRef.current !== null) {
      cancelAnimationFrame(layoutObserverSuppressionFrameRef.current);
    }
    animationFrameRef.current = null;
    layoutObserverSuppressionFrameRef.current = null;
    suppressEquivalentLayoutObserverRef.current = false;
    scheduledReasonRef.current = null;
    initialFallbackProjectIdRef.current = null;
    initialFitProjectIdRef.current = null;
    previousViewportRef.current = null;
    previousObservedLayoutExtentsRef.current = null;
    latestContentRef.current = null;
    pendingInitialScopedInsetsRef.current = null;
    pendingInitialLayoutReplayRef.current = null;
    pendingFocusLayoutReplayRef.current = null;
    cameraContinuityRef.current = { x: false, y: false };
    pendingInsetContinuityRef.current = false;
    setHasMeasurement(false);
    clearFitTransition();
    scheduleMeasurement("initial");
  }, [clearFitTransition, projectId, scheduleMeasurement]);

  useLayoutEffect(() => {
    if (previousFitRequestKeyRef.current === fitRequestKey) return;
    previousFitRequestKeyRef.current = fitRequestKey;
    scheduleMeasurement("fit-request");
  }, [fitRequestKey, scheduleMeasurement]);

  useEffect(() => {
    const pendingInitialLayout = pendingInitialLayoutReplayRef.current;
    if (pendingInitialLayout !== null && (
      pendingInitialLayout.activeRootId !== activeRootId ||
      pendingInitialLayout.focusRequestKey !== focusRequestKey ||
      pendingInitialLayout.projectId !== projectId ||
      pendingInitialLayout.revealRecordId !== revealRecordId ||
      pendingInitialLayout.scopeRecordId !== scopeRecordId
    )) pendingInitialLayoutReplayRef.current = null;
    const pendingFocus = pendingFocusLayoutReplayRef.current;
    if (pendingFocus !== null && (
      pendingFocus.activeRootId !== activeRootId ||
      pendingFocus.focusRequestKey !== focusRequestKey ||
      pendingFocus.projectId !== projectId ||
      pendingFocus.revealRecordId !== revealRecordId ||
      pendingFocus.scopeRecordId !== scopeRecordId
    )) pendingFocusLayoutReplayRef.current = null;
    const pendingInitialInsets = pendingInitialScopedInsetsRef.current;
    if (pendingInitialInsets !== null && (
      pendingInitialInsets.projectId !== projectId ||
      pendingInitialInsets.revealRecordId !== revealRecordId ||
      pendingInitialInsets.scopeRecordId !== scopeRecordId
    )) pendingInitialScopedInsetsRef.current = null;
  }, [activeRootId, focusRequestKey, projectId, revealRecordId, scopeRecordId]);

  useEffect(() => {
    if (previousFocusRequestKeyRef.current === focusRequestKey) return;
    previousFocusRequestKeyRef.current = focusRequestKey;
    pendingInitialLayoutReplayRef.current = null;
    pendingFocusLayoutReplayRef.current = {
      activeRootId,
      focusRequestKey,
      measuredLayoutRevision,
      projectId,
      revealRecordId,
      scopeRecordId,
      structuralLayoutRevision,
    };
    scheduleMeasurement("focus-request");
  }, [
    activeRootId,
    focusRequestKey,
    measuredLayoutRevision,
    projectId,
    revealRecordId,
    scheduleMeasurement,
    scopeRecordId,
    structuralLayoutRevision,
  ]);

  useEffect(() => {
    const previousInsets = previousOcclusionInsetsRef.current;
    previousOcclusionInsetsRef.current = occlusionInsets;
    if (
      previousInsets.top === occlusionInsets.top &&
      previousInsets.right === occlusionInsets.right &&
      previousInsets.bottom === occlusionInsets.bottom &&
      previousInsets.left === occlusionInsets.left
    ) return;
    const pendingInitialInsets = pendingInitialScopedInsetsRef.current;
    const replayInitialScopedPlacement = pendingInitialInsets !== null &&
      pendingInitialInsets.projectId === projectId &&
      pendingInitialInsets.revealRecordId === revealRecordId &&
      pendingInitialInsets.scopeRecordId === scopeRecordId && (
        occlusionInsets.top !== 0 ||
        occlusionInsets.right !== 0 ||
        occlusionInsets.bottom !== 0 ||
        occlusionInsets.left !== 0
      );
    if (replayInitialScopedPlacement) pendingInitialScopedInsetsRef.current = null;
    if (!replayInitialScopedPlacement) pendingInsetContinuityRef.current = true;
    scheduleMeasurement(
      replayInitialScopedPlacement
        ? "focus-request"
        : revealRecordId === null ? "insets" : "reveal-request",
    );
  }, [
    occlusionInsets.bottom,
    occlusionInsets.left,
    occlusionInsets.right,
    occlusionInsets.top,
    projectId,
    revealRecordId,
    scopeRecordId,
    scheduleMeasurement,
  ]);

  useEffect(() => {
    if (previousRevealRecordIdRef.current === revealRecordId) return;
    previousRevealRecordIdRef.current = revealRecordId;
    if (revealRecordId !== null) scheduleMeasurement("reveal-request");
  }, [revealRecordId, scheduleMeasurement]);

  useEffect(() => {
    const onWindowResize = () => scheduleMeasurement("window-resize");
    const onLayoutResize = () => {
      const viewportElement = viewportRef.current;
      const world = worldRef.current;
      if (viewportElement === null || world === null) return;
      const nextExtents = observedLayoutExtents(viewportElement, world);
      const previousExtents = previousObservedLayoutExtentsRef.current;
      if (suppressEquivalentLayoutObserverRef.current) {
        suppressEquivalentLayoutObserverRef.current = false;
        if (layoutObserverSuppressionFrameRef.current !== null) {
          cancelAnimationFrame(layoutObserverSuppressionFrameRef.current);
          layoutObserverSuppressionFrameRef.current = null;
        }
        if (previousExtents !== null && !layoutExtentsChanged(previousExtents, nextExtents)) return;
      }
      scheduleMeasurement("layout");
    };
    scheduleMeasurement("initial");
    window.addEventListener("resize", onWindowResize);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", onWindowResize);
      };
    }
    const observer = new ResizeObserver(onLayoutResize);
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    if (worldRef.current !== null) observer.observe(worldRef.current);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
    };
  }, [scheduleMeasurement]);

  useLayoutEffect(() => {
    if (previousLayoutRevisionRef.current === layoutRevision) return;
    previousLayoutRevisionRef.current = layoutRevision;
    if (initialFitProjectIdRef.current !== projectId) {
      scheduleMeasurement("initial");
      return;
    }
    const pendingInitial = pendingInitialLayoutReplayRef.current;
    const sameInitialGeneration = pendingInitial !== null &&
      pendingInitial.activeRootId === activeRootId &&
      pendingInitial.focusRequestKey === focusRequestKey &&
      pendingInitial.projectId === projectId &&
      pendingInitial.revealRecordId === revealRecordId &&
      pendingInitial.scopeRecordId === scopeRecordId &&
      pendingInitial.structuralLayoutRevision === structuralLayoutRevision;
    const initialLayoutChanged = sameInitialGeneration &&
      pendingInitial.measuredLayoutRevision !== measuredLayoutRevision;
    const replayInitial = sameInitialGeneration && initialLayoutChanged;
    const pendingFocus = pendingFocusLayoutReplayRef.current;
    const sameFocusGeneration = pendingFocus !== null &&
      pendingFocus.activeRootId === activeRootId &&
      pendingFocus.focusRequestKey === focusRequestKey &&
      pendingFocus.projectId === projectId &&
      pendingFocus.revealRecordId === revealRecordId &&
      pendingFocus.scopeRecordId === scopeRecordId &&
      pendingFocus.structuralLayoutRevision === structuralLayoutRevision;
    const focusLayoutChanged = sameFocusGeneration &&
      pendingFocus.measuredLayoutRevision !== measuredLayoutRevision;
    const replayFocus = sameFocusGeneration && focusLayoutChanged;
    measure(replayInitial
      ? "initial-layout-replay"
      : replayFocus ? "focus-request" : "layout");
    if (!sameInitialGeneration || initialLayoutChanged) {
      pendingInitialLayoutReplayRef.current = null;
    }
    if (!sameFocusGeneration || focusLayoutChanged) pendingFocusLayoutReplayRef.current = null;
    suppressEquivalentLayoutObserverRef.current = true;
    if (layoutObserverSuppressionFrameRef.current !== null) {
      cancelAnimationFrame(layoutObserverSuppressionFrameRef.current);
    }
    const generation = measurementGenerationRef.current;
    const frameId = requestAnimationFrame(() => {
      if (
        measurementGenerationRef.current !== generation ||
        layoutObserverSuppressionFrameRef.current !== frameId
      ) return;
      layoutObserverSuppressionFrameRef.current = null;
      suppressEquivalentLayoutObserverRef.current = false;
    });
    layoutObserverSuppressionFrameRef.current = frameId;
  }, [
    activeRootId,
    focusRequestKey,
    layoutRevision,
    measure,
    measuredLayoutRevision,
    projectId,
    revealRecordId,
    scheduleMeasurement,
    scopeRecordId,
    structuralLayoutRevision,
  ]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (layoutObserverSuppressionFrameRef.current !== null) {
      cancelAnimationFrame(layoutObserverSuppressionFrameRef.current);
    }
    animationFrameRef.current = null;
    layoutObserverSuppressionFrameRef.current = null;
    suppressEquivalentLayoutObserverRef.current = false;
    scheduledReasonRef.current = null;
    if (fitTransitionTimerRef.current !== null) clearTimeout(fitTransitionTimerRef.current);
  }, []);

  const clearActivePointers = useCallback(() => {
    const viewportElement = viewportRef.current;
    if (viewportElement !== null) {
      for (const [pointerId, pointer] of activePointersRef.current) {
        if (!pointer.captured) continue;
        try {
          if (viewportElement.hasPointerCapture(pointerId)) {
            viewportElement.releasePointerCapture(pointerId);
          }
        } catch {
          // Capture can disappear between the check and release.
        }
      }
    }
    activePointersRef.current.clear();
    clearClickSuppression();
    setCameraDragging(false);
  }, [clearClickSuppression]);

  useLayoutEffect(() => {
    window.addEventListener("blur", clearActivePointers);
    return () => {
      window.removeEventListener("blur", clearActivePointers);
      clearActivePointers();
    };
  }, [clearActivePointers]);

  useEffect(() => {
    clearActivePointers();
  }, [clearActivePointers, projectId]);

  const zoom = useCallback((direction: -1 | 1) => {
    const viewport = previousViewportRef.current;
    const content = latestContentRef.current;
    if (viewport === null || content === null) return;
    applyCameraInput((current) =>
      zoomProjectCameraAt(
        current,
        current.scale + direction * PROJECT_MAP_ZOOM_STEP,
        { x: viewport.width / 2, y: viewport.height / 2 },
      ), "zoom");
  }, [
    applyCameraInput,
  ]);

  const pointInViewport = useCallback((clientX: number, clientY: number): CameraPoint => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    return {
      x: clientX - (bounds?.left ?? 0),
      y: clientY - (bounds?.top ?? 0),
    };
  }, []);

  const removeActivePointer = useCallback((pointerId: number, clearSuppression = true) => {
    const pointer = activePointersRef.current.get(pointerId);
    if (pointer === undefined) {
      if (clearSuppression) clearClickSuppression(pointerId);
      return;
    }
    const wasPinching = [...activePointersRef.current.values()]
      .filter((activePointer) => activePointer.pointerType === "touch").length >= 2;
    activePointersRef.current.delete(pointerId);
    if (clearSuppression) clearClickSuppression(pointerId);
    setCameraDragging([...activePointersRef.current.values()].some((activePointer) => activePointer.dragging));
    if (wasPinching) {
      const remainingTouch = [...activePointersRef.current.values()]
        .find((activePointer) => activePointer.pointerType === "touch");
      if (remainingTouch !== undefined) remainingTouch.start = remainingTouch.current;
    }
  }, [clearClickSuppression]);

  const releaseCapturedPointer = useCallback((
    viewportElement: HTMLDivElement,
    pointerId: number,
  ) => {
    try {
      if (viewportElement.hasPointerCapture(pointerId)) {
        viewportElement.releasePointerCapture(pointerId);
      }
    } catch {
      // Capture can disappear between the check and release.
    }
  }, []);

  const capturePointer = useCallback((
    viewportElement: HTMLDivElement,
    pointerId: number,
    pointer: ActivePointer,
  ): boolean => {
    if (pointer.captured) return true;
    try {
      viewportElement.setPointerCapture(pointerId);
      if (!viewportElement.hasPointerCapture(pointerId)) {
        removeActivePointer(pointerId);
        return false;
      }
    } catch {
      removeActivePointer(pointerId);
      return false;
    }
    pointer.captured = true;
    return true;
  }, [removeActivePointer]);

  const startDragging = useCallback((pointer: ActivePointer) => {
    if (pointer.dragging) return;
    pointer.dragging = true;
    setCameraDragging(true);
    interruptFitTransition();
  }, [interruptFitTransition]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (initialFitProjectIdRef.current !== projectId) return;
    if (!(event.target instanceof Element)) return;
    const isMiddle = event.pointerType === "mouse" && event.button === 1;
    const isSpace = event.pointerType === "mouse" && event.button === 0 && spacePanArmedRef.current;
    const isTouch = event.pointerType === "touch";
    if (!cameraPannableRef.current && !isTouch) return;
    if (isMiddle || isSpace) {
      if (event.target.closest(CAMERA_MIDDLE_BLOCKING_SELECTOR) !== null) return;
    } else {
      if (!canStartCameraGesture(event.target)) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
    }
    if (activePointersRef.current.size === 0) clearClickSuppression();
    const point = pointInViewport(event.clientX, event.clientY);
    const pointer: ActivePointer = {
      activationBoundary: cameraActivationBoundary(event.target),
      captured: false,
      current: point,
      dragging: false,
      mode: isMiddle ? "middle" : isSpace ? "space" : isTouch ? "touch" : "primary",
      pointerType: event.pointerType,
      start: point,
    };
    activePointersRef.current.set(event.pointerId, pointer);
    if (isMiddle || isSpace) {
      event.preventDefault();
      suppressedActivationBoundariesRef.current.set(
        event.pointerId,
        pointer.activationBoundary,
      );
      if (!capturePointer(event.currentTarget, event.pointerId, pointer)) return;
    }
    const touches = [...activePointersRef.current.entries()]
      .filter(([, pointer]) => pointer.pointerType === "touch");
    if (touches.length === 2) {
      let capturedAll = true;
      for (const [pointerId, pointer] of touches) {
        capturedAll = capturePointer(event.currentTarget, pointerId, pointer) && capturedAll;
      }
      if (capturedAll) {
        for (const [, touch] of touches) touch.dragging = true;
        setCameraDragging(true);
        interruptFitTransition();
      }
      else clearActivePointers();
    }
  }, [
    capturePointer,
    clearActivePointers,
    clearClickSuppression,
    interruptFitTransition,
    pointInViewport,
    projectId,
  ]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (pointer === undefined) return;
    if (
      pointer.pointerType !== "touch" &&
      (event.buttons & (pointer.mode === "middle" ? 4 : 1)) === 0
    ) {
      if (pointer.captured) releaseCapturedPointer(event.currentTarget, event.pointerId);
      removeActivePointer(event.pointerId);
      return;
    }
    const priorPoint = pointer.current;
    const nextPoint = pointInViewport(event.clientX, event.clientY);
    pointer.current = nextPoint;

    const touches = [...activePointersRef.current.entries()]
      .filter(([, activePointer]) => activePointer.pointerType === "touch");
    if (touches.length >= 2) {
      const pinchTouches = touches.slice(0, 2);
      if (!pinchTouches.some(([pointerId]) => pointerId === event.pointerId)) return;
      const oldPoints = pinchTouches.map(([pointerId, activePointer]) =>
        pointerId === event.pointerId ? priorPoint : activePointer.current);
      const newPoints = pinchTouches.map(([, activePointer]) => activePointer.current);
      const oldDistance = distanceBetween(oldPoints[0]!, oldPoints[1]!);
      const newDistance = distanceBetween(newPoints[0]!, newPoints[1]!);
      if (oldDistance === 0 || newDistance === 0) return;
      const oldMidpoint = midpointBetween(oldPoints[0]!, oldPoints[1]!);
      const newMidpoint = midpointBetween(newPoints[0]!, newPoints[1]!);
      applyCameraInput((current) => {
        const zoomed = zoomProjectCameraAt(
          current,
          current.scale * newDistance / oldDistance,
          oldMidpoint,
        );
        return {
          ...zoomed,
          x: zoomed.x + newMidpoint.x - oldMidpoint.x,
          y: zoomed.y + newMidpoint.y - oldMidpoint.y,
        };
      }, "zoom");
      return;
    }

    if (pointer.pointerType === "touch" && !cameraPannableRef.current) return;

    if (!pointer.dragging) {
      if (distanceBetween(pointer.start, nextPoint) < CAMERA_DRAG_THRESHOLD) return;
      if (!capturePointer(event.currentTarget, event.pointerId, pointer)) return;
      if (pointer.mode === "primary") {
        suppressedActivationBoundariesRef.current.set(
          event.pointerId,
          pointer.activationBoundary,
        );
      }
      startDragging(pointer);
      applyCameraInput((current) => ({
        ...current,
        x: current.x + nextPoint.x - pointer.start.x,
        y: current.y + nextPoint.y - pointer.start.y,
      }));
      return;
    }

    applyCameraInput((current) => ({
      ...current,
      x: current.x + nextPoint.x - priorPoint.x,
      y: current.y + nextPoint.y - priorPoint.y,
    }));
  }, [
    capturePointer,
    applyCameraInput,
    pointInViewport,
    releaseCapturedPointer,
    removeActivePointer,
    startDragging,
  ]);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (pointer === undefined) return;
    removeActivePointer(event.pointerId, false);
    if (pointer.captured) releaseCapturedPointer(event.currentTarget, event.pointerId);
    expireClickSuppression(event.pointerId);
  }, [expireClickSuppression, releaseCapturedPointer, removeActivePointer]);

  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    removeActivePointer(event.pointerId);
  }, [removeActivePointer]);

  const handlePointerCancel = useCallback(() => clearActivePointers(), [clearActivePointers]);

  const suppressOwnedActivation = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const eventTarget = event.target;
    const suppressedEntry = [...suppressedActivationBoundariesRef.current]
      .find(([, boundary]) => (
        boundary === eventTarget ||
        boundary.contains(eventTarget) ||
        eventTarget.contains(boundary)
      ));
    if (suppressedEntry === undefined) return;
    clearClickSuppression(suppressedEntry[0]);
    event.preventDefault();
    event.stopPropagation();
  }, [clearClickSuppression]);

  useEffect(() => {
    const clearUncapturedPointer = (event: PointerEvent) => {
      const pointer = activePointersRef.current.get(event.pointerId);
      if (pointer !== undefined && !pointer.captured) removeActivePointer(event.pointerId);
    };
    window.addEventListener("pointerup", clearUncapturedPointer);
    window.addEventListener("pointercancel", clearUncapturedPointer);
    return () => {
      window.removeEventListener("pointerup", clearUncapturedPointer);
      window.removeEventListener("pointercancel", clearUncapturedPointer);
    };
  }, [removeActivePointer]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0) return;
    if (initialFitProjectIdRef.current !== projectId) return;
    const viewport = previousViewportRef.current;
    const content = latestContentRef.current;
    if (viewport === null || content === null) return;
    event.preventDefault();
    const anchor = pointInViewport(event.clientX, event.clientY);
    applyCameraInput((current) =>
      zoomProjectCameraAt(
        current,
        current.scale - event.deltaY * 0.001,
        anchor,
      ), "zoom");
  }, [
    applyCameraInput,
    pointInViewport,
    projectId,
  ]);

  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (viewportElement === null) return;
    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setTouchOnly(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const disarmSpacePan = () => {
      spacePanArmedRef.current = false;
      setSpacePanArmed(false);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") disarmSpacePan();
    };
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", disarmSpacePan);
    return () => {
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", disarmSpacePan);
    };
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case " ":
        if (document.activeElement !== event.currentTarget) return;
        if (!cameraPannableRef.current) return;
        event.preventDefault();
        spacePanArmedRef.current = true;
        setSpacePanArmed(true);
        return;
      case "+":
      case "=":
        event.preventDefault();
        zoom(1);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoom(-1);
        return;
      case "f":
      case "F":
        event.preventDefault();
        scheduleMeasurement("fit-request");
        return;
      case "ArrowLeft":
        event.preventDefault();
        applyCameraInput((current) => ({ ...current, x: current.x + PROJECT_MAP_PAN_STEP }));
        return;
      case "ArrowRight":
        event.preventDefault();
        applyCameraInput((current) => ({ ...current, x: current.x - PROJECT_MAP_PAN_STEP }));
        return;
      case "ArrowUp":
        event.preventDefault();
        applyCameraInput((current) => ({ ...current, y: current.y + PROJECT_MAP_PAN_STEP }));
        return;
      case "ArrowDown":
        event.preventDefault();
        applyCameraInput((current) => ({ ...current, y: current.y - PROJECT_MAP_PAN_STEP }));
    }
  }, [applyCameraInput, scheduleMeasurement, zoom]);

  const pan = useCallback((direction: "left" | "right" | "up" | "down") => {
    applyCameraInput((current) => {
      switch (direction) {
        case "left": return { ...current, x: current.x + PROJECT_MAP_PAN_STEP };
        case "right": return { ...current, x: current.x - PROJECT_MAP_PAN_STEP };
        case "up": return { ...current, y: current.y + PROJECT_MAP_PAN_STEP };
        case "down": return { ...current, y: current.y - PROJECT_MAP_PAN_STEP };
      }
    });
  }, [applyCameraInput]);

  const handleMoveMapKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setMoveMapOpen(false);
    moveMapTriggerRef.current?.focus();
  }, []);

  const contextValue = useMemo(() => ({ camera, worldRef }), [camera]);
  const controlsDisabled = !hasMeasurement;
  const canZoomOut = !controlsDisabled && camera.scale > PROJECT_MAP_MIN_SCALE;
  const canZoomIn = !controlsDisabled && camera.scale < PROJECT_MAP_MAX_SCALE;
  const measuredViewport = previousViewportRef.current;
  const measuredContent = latestContentRef.current;
  const panAvailability = !controlsDisabled && measuredViewport !== null && measuredContent !== null
    ? projectMapPanAvailability(
      camera,
      measuredViewport,
      measuredContent,
      occlusionInsets,
      cameraContinuityRef.current,
    )
    : { left: false, right: false, up: false, down: false };
  const cameraPannable = Object.values(panAvailability).some(Boolean);
  cameraPannableRef.current = cameraPannable;
  const fittedCamera = measuredViewport === null || measuredContent === null
    ? null
    : fitProjectCamera(
      measuredViewport,
      measuredContent,
      paddingFor(measuredViewport.width),
      occlusionInsets,
    );
  const fitDisabled = controlsDisabled || (fittedCamera !== null && sameCamera(camera, fittedCamera));
  const fitPadding = measuredViewport === null ? 0 : paddingFor(measuredViewport.width);
  const overviewLimited = camera.scale === PROJECT_MAP_MIN_SCALE &&
    measuredViewport !== null && measuredContent !== null && (
      measuredContent.width * PROJECT_MAP_MIN_SCALE >
        measuredViewport.width - occlusionInsets.left - occlusionInsets.right - fitPadding * 2 ||
      measuredContent.height * PROJECT_MAP_MIN_SCALE >
        measuredViewport.height - occlusionInsets.top - occlusionInsets.bottom - fitPadding * 2
    );
  const keyboardZoomInstructions = "Plus (+) or Equals (=) in, Minus (-) or Underscore (_) out";
  const instructions = cameraPannable
    ? touchOnly
      ? `Focused canvas — Pan: drag or arrow keys · Zoom: pinch, ${keyboardZoomInstructions} · F fits.`
      : `Focused canvas — Pan: drag empty space, Space-drag, middle-drag, or arrow keys · Zoom: wheel/trackpad, pinch, ${keyboardZoomInstructions} · F fits.`
    : touchOnly
      ? `Focused canvas — Zoom: pinch, ${keyboardZoomInstructions} · F fits · Arrow keys pan when available.`
      : `Focused canvas — Zoom: wheel/trackpad, pinch, ${keyboardZoomInstructions} · F fits · Arrow keys pan when available.`;

  useEffect(() => {
    if (cameraPannable) return;
    clearActivePointers();
    spacePanArmedRef.current = false;
    setSpacePanArmed(false);
    setMoveMapOpen(false);
  }, [cameraPannable, clearActivePointers]);

  useEffect(() => {
    setMoveMapOpen(false);
  }, [projectId, scopeRecordId]);

  useEffect(() => {
    if (!moveMapOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (moveMapTriggerRef.current?.contains(event.target) === true) return;
      if (moveMapPanelRef.current?.contains(event.target) === true) return;
      setMoveMapOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [moveMapOpen]);

  useLayoutEffect(() => {
    if (!moveMapOpen) return;
    const deck = controlDeckRef.current;
    const trigger = moveMapTriggerRef.current;
    const panel = moveMapPanelRef.current;
    if (deck === null || trigger === null || panel === null) return;
    const placePanel = () => {
      const deckBounds = deck.getBoundingClientRect();
      const triggerBounds = trigger.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      const maximumRight = Math.max(
        0,
        triggerBounds.right - deckBounds.left - panelBounds.width,
      );
      setMoveMapPanelAbove(occlusionInsets.right > maximumRight);
      setMoveMapPanelRight(Math.min(occlusionInsets.right, maximumRight));
    };
    placePanel();
    window.addEventListener("resize", placePanel);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", placePanel);
    }
    const observer = new ResizeObserver(placePanel);
    observer.observe(deck);
    observer.observe(trigger);
    return () => {
      window.removeEventListener("resize", placePanel);
      observer.disconnect();
    };
  }, [moveMapOpen, occlusionInsets.right]);

  return (
    <ProjectMapCameraContext.Provider value={contextValue}>
      <section className="project-map-camera" data-project-map-camera-shell>
        <div className="project-map-camera__control-deck" ref={controlDeckRef}>
          <div aria-label="Map controls" className="project-map-camera__toolbar" role="group">
            <button aria-label="Zoom out" disabled={!canZoomOut} onClick={() => zoom(-1)} type="button">−</button>
            <output aria-label="Map zoom" aria-live="off" role="status">
              {Math.round((camera.scale + Number.EPSILON) * 100)}%
            </output>
            <button aria-label="Zoom in" disabled={!canZoomIn} onClick={() => zoom(1)} type="button">+</button>
            <button
              disabled={fitDisabled}
              onClick={() => scheduleMeasurement("fit-request")}
              type="button"
            >
              {scopeRecordId === null ? "Fit project" : "Fit branch"}
            </button>
            <div className="project-map-camera__move-map">
              <button
                aria-controls={moveMapId}
                aria-expanded={moveMapOpen}
                disabled={!cameraPannable}
                onClick={() => setMoveMapOpen((open) => !open)}
                ref={moveMapTriggerRef}
                type="button"
              >
                Move map
              </button>
              {moveMapOpen ? (
                <div
                  aria-label="Move map directions"
                  className="project-map-camera__move-map-panel"
                  id={moveMapId}
                  onKeyDown={handleMoveMapKeyDown}
                  ref={moveMapPanelRef}
                  role="group"
                  style={{
                    bottom: moveMapPanelAbove ? "calc(100% + 8px)" : "auto",
                    right: moveMapPanelRight,
                    top: moveMapPanelAbove ? "auto" : undefined,
                  }}
                >
                  <button aria-label="Pan up" disabled={!panAvailability.up} onClick={() => pan("up")} type="button">↑</button>
                  <button aria-label="Pan left" disabled={!panAvailability.left} onClick={() => pan("left")} type="button">←</button>
                  <button aria-label="Pan right" disabled={!panAvailability.right} onClick={() => pan("right")} type="button">→</button>
                  <button aria-label="Pan down" disabled={!panAvailability.down} onClick={() => pan("down")} type="button">↓</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div
          aria-describedby={instructionsId}
          aria-label={ariaLabel}
          className="project-map-camera__viewport"
          data-camera-pannable={cameraPannable}
          data-camera-dragging={cameraDragging}
          data-camera-fit-request-key={fitRequestKey}
          data-camera-focus-request-key={focusRequestKey}
          data-camera-scale={camera.scale}
          data-camera-x={camera.x}
          data-camera-y={camera.y}
          data-camera-space-pan-armed={spacePanArmed}
          onAuxClickCapture={suppressOwnedActivation}
          onClickCapture={suppressOwnedActivation}
          onKeyDown={handleKeyDown}
          onLostPointerCapture={handleLostPointerCapture}
          onPointerCancel={handlePointerCancel}
          onPointerDownCapture={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          ref={viewportRef}
          tabIndex={0}
        >
          <div
            aria-hidden="true"
            data-camera-pan-surface
            style={{ touchAction: cameraPannable ? "none" : "pan-x pan-y" }}
          />
          {overviewLimited ? (
            <p
              className="project-map-camera__overview-status"
              style={{ right: occlusionInsets.right + 10 }}
            >
              Overview limited to 50%
            </p>
          ) : null}
          <p className="project-map-camera__instructions" id={instructionsId}>
            {instructions}
          </p>
          <div
            className="project-map-camera__world"
            data-camera-fit-transition={fitTransition}
            data-camera-world
            ref={worldRef}
            style={{
              transform: cameraTransform(camera),
              transformOrigin: "0 0",
            }}
          >
            <ProjectMapCameraWorldContext.Provider value={worldRef}>
              {children}
            </ProjectMapCameraWorldContext.Provider>
          </div>
        </div>
      </section>
    </ProjectMapCameraContext.Provider>
  );
}
