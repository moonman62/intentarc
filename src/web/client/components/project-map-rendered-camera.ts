import type { ProjectMapCameraState } from "./project-map-camera.js";

const CSS_NUMBER_SOURCE = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`;
const CSS_NUMBER_PATTERN = new RegExp(`^${CSS_NUMBER_SOURCE}$`);
const AUTHORED_CAMERA_TRANSFORM_PATTERN = new RegExp(
  `^translate3d\\((${CSS_NUMBER_SOURCE})px, (${CSS_NUMBER_SOURCE})px, 0\\) ` +
  `scale\\((${CSS_NUMBER_SOURCE})\\)$`,
);

export function readProjectMapRenderedCamera(
  world: HTMLElement,
): ProjectMapCameraState | null {
  const transform = getComputedStyle(world).transform;
  const match = transform.match(/^matrix(3d)?\((.+)\)$/);
  if (match === null) {
    const authoredMatch = transform.match(AUTHORED_CAMERA_TRANSFORM_PATTERN);
    if (authoredMatch === null) return null;
    const authoredCamera = {
      scale: Number(authoredMatch[3]),
      x: Number(authoredMatch[1]),
      y: Number(authoredMatch[2]),
    };
    return Number.isFinite(authoredCamera.scale) && authoredCamera.scale > 0 &&
      Number.isFinite(authoredCamera.x) && Number.isFinite(authoredCamera.y)
      ? authoredCamera
      : null;
  }
  const tokens = match[2]?.split(",").map((value) => value.trim()) ?? [];
  const isMatrix3d = match[1] === "3d";
  if (tokens.length !== (isMatrix3d ? 16 : 6) ||
    tokens.some((token) => !CSS_NUMBER_PATTERN.test(token))) {
    return null;
  }
  const values = tokens.map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const approximately = (value: number, expected: number): boolean =>
    Math.abs(value - expected) <= 1e-6;
  const scale = values[0]!;
  const hasExpectedAxes = isMatrix3d
    ? approximately(values[1]!, 0) && approximately(values[2]!, 0) &&
      approximately(values[3]!, 0) && approximately(values[4]!, 0) &&
      approximately(values[5]!, scale) && approximately(values[6]!, 0) &&
      approximately(values[7]!, 0) && approximately(values[8]!, 0) &&
      approximately(values[9]!, 0) && approximately(values[10]!, 1) &&
      approximately(values[11]!, 0) && approximately(values[14]!, 0) &&
      approximately(values[15]!, 1)
    : approximately(values[1]!, 0) && approximately(values[2]!, 0) &&
      approximately(values[3]!, scale);
  if (scale <= 0 || !hasExpectedAxes) return null;
  return {
    scale,
    x: values[isMatrix3d ? 12 : 4]!,
    y: values[isMatrix3d ? 13 : 5]!,
  };
}
