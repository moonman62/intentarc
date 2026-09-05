export interface CameraPoint {
  readonly x: number;
  readonly y: number;
}

export interface CameraSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraBounds extends CameraPoint, CameraSize {}

export interface ProjectMapCameraState {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface CameraInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ProjectMapPanAvailability {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
}

export interface ProjectMapCameraContinuity {
  readonly x: boolean;
  readonly y: boolean;
}

export interface ProjectMapCameraInputResult {
  readonly camera: ProjectMapCameraState;
  readonly continuity: ProjectMapCameraContinuity;
}

export const PROJECT_MAP_MIN_SCALE = 0.5;
export const PROJECT_MAP_MAX_SCALE = 1.5;
export const PROJECT_MAP_ZOOM_STEP = 0.1;
export const PROJECT_MAP_PAN_STEP = 40;
export const PROJECT_MAP_VISIBLE_GRIP = 48;
export const PROJECT_MAP_ROOT_TOP_INSET = 32;
export const PROJECT_MAP_FITTED_PAN_SLACK = 96;

const ZERO_CAMERA_INSETS: CameraInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function clampCameraScale(scale: number): number {
  return Math.min(PROJECT_MAP_MAX_SCALE, Math.max(PROJECT_MAP_MIN_SCALE, scale));
}

export function fitProjectCamera(
  viewport: CameraSize,
  content: CameraBounds,
  padding: number,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
): ProjectMapCameraState | null {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    content.width <= 0 ||
    content.height <= 0
  ) {
    return null;
  }

  const scale = clampCameraScale(
    Math.min(
      (viewport.width - insets.left - insets.right - 2 * padding) / content.width,
      (viewport.height - insets.top - insets.bottom - 2 * padding) / content.height,
    ),
  );

  const usableWidth = viewport.width - insets.left - insets.right;
  const usableHeight = viewport.height - insets.top - insets.bottom;
  const fittedY = content.height * scale <= usableHeight;

  return clampProjectCamera({
    scale,
    x: insets.left + usableWidth / 2 - (content.x + content.width / 2) * scale,
    y: fittedY
      ? insets.top + PROJECT_MAP_ROOT_TOP_INSET - content.y * scale
      : insets.top + usableHeight / 2 - (content.y + content.height / 2) * scale,
  }, viewport, content, insets);
}

export function initialProjectMapCamera(
  viewport: CameraSize,
  root: CameraBounds,
  insets: CameraInsets,
): ProjectMapCameraState {
  const usableWidth = viewport.width - insets.left - insets.right;
  return {
    scale: 1,
    x: insets.left + (usableWidth - root.width) / 2 - root.x,
    y: insets.top + PROJECT_MAP_ROOT_TOP_INSET - root.y,
  };
}

export function focusProjectMapRoot(
  current: ProjectMapCameraState,
  viewport: CameraSize,
  root: CameraBounds,
  insets: CameraInsets,
): ProjectMapCameraState {
  const usableWidth = viewport.width - insets.left - insets.right;
  return {
    scale: current.scale,
    x: insets.left + (usableWidth - root.width * current.scale) / 2 - root.x * current.scale,
    y: insets.top + PROJECT_MAP_ROOT_TOP_INSET - root.y * current.scale,
  };
}

export function zoomProjectCameraAt(
  camera: ProjectMapCameraState,
  nextScale: number,
  anchor: CameraPoint,
): ProjectMapCameraState {
  const scale = clampCameraScale(nextScale);
  const worldX = (anchor.x - camera.x) / camera.scale;
  const worldY = (anchor.y - camera.y) / camera.scale;

  return {
    scale,
    x: anchor.x - worldX * scale,
    y: anchor.y - worldY * scale,
  };
}

interface CameraAxisBounds {
  readonly minimum: number;
  readonly maximum: number;
}

function cameraAxisBounds(
  usableStart: number,
  usableEnd: number,
  contentStart: number,
  contentLength: number,
  scale: number,
  visibleGrip: number,
  undersizedAlignment: "center" | "top",
): CameraAxisBounds {
  const viewportLength = usableEnd - usableStart;
  const transformedLength = contentLength * scale;
  if (transformedLength <= viewportLength) {
    const canonical = undersizedAlignment === "center"
      ? usableStart + viewportLength / 2 - (contentStart + contentLength / 2) * scale
      : usableStart + PROJECT_MAP_ROOT_TOP_INSET - contentStart * scale;
    const requiredVisible = Math.min(visibleGrip, transformedLength);
    const reachableMinimum = usableStart + requiredVisible -
      (contentStart + contentLength) * scale;
    const reachableMaximum = usableEnd - requiredVisible - contentStart * scale;
    return {
      minimum: Math.max(canonical - PROJECT_MAP_FITTED_PAN_SLACK, reachableMinimum),
      maximum: Math.min(canonical + PROJECT_MAP_FITTED_PAN_SLACK, reachableMaximum),
    };
  }

  return {
    minimum: usableStart + visibleGrip - (contentStart + contentLength) * scale,
    maximum: usableEnd - visibleGrip - contentStart * scale,
  };
}

function clampAxis(
  translation: number,
  usableStart: number,
  usableEnd: number,
  contentStart: number,
  contentLength: number,
  scale: number,
  visibleGrip: number,
  undersizedAlignment: "center" | "top",
): number {
  const { minimum, maximum } = cameraAxisBounds(
    usableStart,
    usableEnd,
    contentStart,
    contentLength,
    scale,
    visibleGrip,
    undersizedAlignment,
  );
  return Math.min(maximum, Math.max(minimum, translation));
}

export function clampProjectCamera(
  camera: ProjectMapCameraState,
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
  visibleGrip = PROJECT_MAP_VISIBLE_GRIP,
): ProjectMapCameraState {
  const scale = clampCameraScale(camera.scale);

  return {
    scale,
    x: clampAxis(
      camera.x,
      insets.left,
      viewport.width - insets.right,
      content.x,
      content.width,
      scale,
      visibleGrip,
      "center",
    ),
    y: clampAxis(
      camera.y,
      insets.top,
      viewport.height - insets.bottom,
      content.y,
      content.height,
      scale,
      visibleGrip,
      "top",
    ),
  };
}

export function clampProjectCameraReachability(
  camera: ProjectMapCameraState,
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
  visibleGrip = PROJECT_MAP_VISIBLE_GRIP,
): ProjectMapCameraState {
  return clampProjectCamera(camera, viewport, content, insets, visibleGrip);
}

function projectCameraAxisBounds(
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets,
  scale: number,
  visibleGrip: number,
  axis: "x" | "y",
): CameraAxisBounds {
  return axis === "x"
    ? cameraAxisBounds(
      insets.left,
      viewport.width - insets.right,
      content.x,
      content.width,
      scale,
      visibleGrip,
      "center",
    )
    : cameraAxisBounds(
      insets.top,
      viewport.height - insets.bottom,
      content.y,
      content.height,
      scale,
      visibleGrip,
      "top",
    );
}

export function projectMapCameraContinuity(
  camera: ProjectMapCameraState,
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
): ProjectMapCameraContinuity {
  const standard = clampProjectCamera(camera, viewport, content, insets);
  return {
    x: camera.x !== standard.x,
    y: camera.y !== standard.y,
  };
}

function clampContinuousAxis(
  current: number,
  candidate: number,
  continuity: boolean,
  bounds: CameraAxisBounds,
): { value: number; continuity: boolean } {
  if (!continuity) {
    return {
      value: Math.min(bounds.maximum, Math.max(bounds.minimum, candidate)),
      continuity: false,
    };
  }

  if (current > bounds.maximum) {
    const value = Math.min(current, Math.max(bounds.maximum, candidate));
    if (candidate <= bounds.maximum) {
      return { value, continuity: false };
    }
    return {
      value,
      continuity: true,
    };
  }

  if (current < bounds.minimum) {
    const value = Math.max(current, Math.min(bounds.minimum, candidate));
    if (candidate >= bounds.minimum) {
      return { value, continuity: false };
    }
    return {
      value,
      continuity: true,
    };
  }

  return {
    value: Math.min(bounds.maximum, Math.max(bounds.minimum, candidate)),
    continuity: false,
  };
}

export function clampProjectCameraInput(
  current: ProjectMapCameraState,
  candidate: ProjectMapCameraState,
  continuity: ProjectMapCameraContinuity,
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
  mode: "pan" | "zoom" = "pan",
): ProjectMapCameraInputResult {
  const scale = clampCameraScale(candidate.scale);
  const boundsX = projectCameraAxisBounds(
    viewport,
    content,
    insets,
    scale,
    PROJECT_MAP_VISIBLE_GRIP,
    "x",
  );
  const boundsY = projectCameraAxisBounds(
    viewport,
    content,
    insets,
    scale,
    PROJECT_MAP_VISIBLE_GRIP,
    "y",
  );
  const standard = clampProjectCamera(candidate, viewport, content, insets);

  if (mode === "zoom") {
    return {
      camera: {
        scale,
        x: continuity.x ? candidate.x : standard.x,
        y: continuity.y ? candidate.y : standard.y,
      },
      continuity: {
        x: continuity.x && candidate.x !== standard.x,
        y: continuity.y && candidate.y !== standard.y,
      },
    };
  }

  const x = clampContinuousAxis(current.x, candidate.x, continuity.x, boundsX);
  const y = clampContinuousAxis(current.y, candidate.y, continuity.y, boundsY);
  return {
    camera: { scale, x: x.value, y: y.value },
    continuity: { x: x.continuity, y: y.continuity },
  };
}

export function projectMapPanAvailability(
  camera: ProjectMapCameraState,
  viewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets,
  continuity: ProjectMapCameraContinuity = { x: false, y: false },
): ProjectMapPanAvailability {
  const clamped = clampProjectCameraInput(
    camera,
    camera,
    continuity,
    viewport,
    content,
    insets,
  ).camera;
  const left = clampProjectCameraInput(
    camera,
    { ...camera, x: camera.x + 1 },
    continuity,
    viewport,
    content,
    insets,
  ).camera;
  const right = clampProjectCameraInput(
    camera,
    { ...camera, x: camera.x - 1 },
    continuity,
    viewport,
    content,
    insets,
  ).camera;
  const up = clampProjectCameraInput(
    camera,
    { ...camera, y: camera.y + 1 },
    continuity,
    viewport,
    content,
    insets,
  ).camera;
  const down = clampProjectCameraInput(
    camera,
    { ...camera, y: camera.y - 1 },
    continuity,
    viewport,
    content,
    insets,
  ).camera;
  return {
    left: left.x !== clamped.x,
    right: right.x !== clamped.x,
    up: up.y !== clamped.y,
    down: down.y !== clamped.y,
  };
}

export function recenterProjectCamera(
  camera: ProjectMapCameraState,
  previousViewport: CameraSize,
  nextViewport: CameraSize,
  content: CameraBounds,
  insets: CameraInsets = ZERO_CAMERA_INSETS,
): ProjectMapCameraState {
  const previousCenterX = insets.left + (
    previousViewport.width - insets.left - insets.right
  ) / 2;
  const previousCenterY = insets.top + (
    previousViewport.height - insets.top - insets.bottom
  ) / 2;
  const nextCenterX = insets.left + (nextViewport.width - insets.left - insets.right) / 2;
  const nextCenterY = insets.top + (nextViewport.height - insets.top - insets.bottom) / 2;
  const worldCenterX = (previousCenterX - camera.x) / camera.scale;
  const worldCenterY = (previousCenterY - camera.y) / camera.scale;

  return clampProjectCamera(
    {
      scale: camera.scale,
      x: nextCenterX - worldCenterX * camera.scale,
      y: nextCenterY - worldCenterY * camera.scale,
    },
    nextViewport,
    content,
    insets,
  );
}
