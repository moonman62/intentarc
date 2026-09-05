import { describe, expect, test } from "vitest";

import {
  clampCameraScale,
  clampProjectCamera,
  clampProjectCameraReachability,
  clampProjectCameraInput,
  fitProjectCamera,
  focusProjectMapRoot,
  initialProjectMapCamera,
  projectMapPanAvailability,
  projectMapCameraContinuity,
  recenterProjectCamera,
  zoomProjectCameraAt,
} from "./project-map-camera.js";

describe("project map camera math", () => {
  test("starts at 100% with the active root centered and exactly 32px below usable top", () => {
    expect(initialProjectMapCamera(
      { width: 1000, height: 700 },
      { x: 0, y: 0, width: 260, height: 120 },
      { top: 0, right: 0, bottom: 0, left: 0 },
    )).toEqual({ scale: 1, x: 370, y: 32 });

    expect(initialProjectMapCamera(
      { width: 1000, height: 700 },
      { x: 200, y: 80, width: 260, height: 120 },
      { top: 24, right: 300, bottom: 12, left: 20 },
    )).toEqual({ scale: 1, x: 30, y: -24 });
  });

  test("focuses a warm branch at the exact root coordinates without changing scale", () => {
    expect(focusProjectMapRoot(
      { scale: 1.3, x: -400, y: -300 },
      { width: 1000, height: 700 },
      { x: 240, y: 180, width: 260, height: 120 },
      { top: 24, right: 300, bottom: 12, left: 20 },
    )).toEqual({ scale: 1.3, x: -121, y: -178 });
  });

  test("gives undersized axes 96px of fitted slack while retaining the canonical position", () => {
    expect(clampProjectCamera(
      { scale: 1, x: 160, y: 6 },
      { width: 1000, height: 700 },
      { x: 100, y: 50, width: 200, height: 200 },
      { top: 24, right: 300, bottom: 12, left: 20 },
    )).toEqual({ scale: 1, x: 160, y: 6 });
    expect(clampProjectCamera(
      { scale: 1, x: -999, y: 999 },
      { width: 1000, height: 700 },
      { x: 100, y: 50, width: 200, height: 200 },
      { top: 24, right: 300, bottom: 12, left: 20 },
    )).toEqual({ scale: 1, x: 64, y: 102 });
  });

  test("realigns both undersized axes after a structural layout change", () => {
    expect(clampProjectCameraReachability(
      { scale: 0.5, x: -1052, y: -752 },
      { width: 1000, height: 700 },
      { x: 200, y: 80, width: 260, height: 120 },
      { top: 24, right: 300, bottom: 12, left: 20 },
    )).toEqual({ scale: 0.5, x: 99, y: -28 });
  });

  test("realigns an undersized axis while minimally clamping an oversized axis", () => {
    expect(clampProjectCameraReachability(
      { scale: 0.5, x: -1052, y: -1000 },
      { width: 1000, height: 700 },
      { x: 200, y: 80, width: 260, height: 1600 },
    )).toEqual({ scale: 0.5, x: 239, y: -792 });

    expect(clampProjectCameraReachability(
      { scale: 0.5, x: 335, y: -500 },
      { width: 1000, height: 700 },
      { x: 200, y: 80, width: 260, height: 1600 },
    )).toEqual({ scale: 0.5, x: 335, y: -500 });
  });

  test("preserves the usable-center world point on resize and only clamps when required", () => {
    const camera = { scale: 1, x: 900, y: 800 };
    const insets = { top: 20, right: 100, bottom: 40, left: 20 };
    const resized = recenterProjectCamera(
      camera,
      { width: 1000, height: 700 },
      { width: 800, height: 600 },
      { x: 0, y: 0, width: 1600, height: 1000 },
      insets,
    );

    expect(resized).toEqual({ scale: 1, x: 652, y: 512 });
  });

  test("reports each available pan direction from the exact inset-aware bounds", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 1600, height: 1000 };
    const insets = { top: 20, right: 300, bottom: 40, left: 20 };

    expect(projectMapPanAvailability(
      { scale: 1, x: 652, y: 612 }, viewport, content, insets,
    )).toEqual({ left: false, right: true, up: false, down: true });
    expect(projectMapPanAvailability(
      { scale: 1, x: -1532, y: -932 }, viewport, content, insets,
    )).toEqual({ left: true, right: false, up: true, down: false });
    expect(projectMapPanAvailability(
      { scale: 1, x: 160, y: 32 },
      viewport,
      { x: 0, y: 20, width: 400, height: 300 },
      insets,
    )).toEqual({ left: true, right: true, up: true, down: true });
  });

  test.each([
    [0.2, 0.5],
    [1.25, 1.25],
    [2, 1.5],
  ])("clamps camera scale %s to %s", (scale, expected) => {
    expect(clampCameraScale(scale)).toBe(expected);
  });

  test("fits desktop content with horizontal centering and the undersized top inset", () => {
    const fitted = fitProjectCamera(
      { width: 1000, height: 700 },
      { x: 100, y: 50, width: 1600, height: 800 },
      40,
    );
    expect(fitted).toMatchObject({ scale: 0.575, x: -17.5 });
    expect(fitted?.y).toBeCloseTo(3.25);
  });

  test("uses the 24px mobile fit padding", () => {
    expect(
      fitProjectCamera(
        { width: 360, height: 640 },
        { x: 0, y: 0, width: 500, height: 500 },
        24,
      ),
    ).toEqual({ scale: 0.624, x: 24, y: 32 });
  });

  test.each([
    [{ width: 0, height: 700 }, { x: 0, y: 0, width: 100, height: 100 }],
    [{ width: 1000, height: 0 }, { x: 0, y: 0, width: 100, height: 100 }],
    [{ width: 1000, height: 700 }, { x: 0, y: 0, width: 0, height: 100 }],
    [{ width: 1000, height: 700 }, { x: 0, y: 0, width: 100, height: 0 }],
  ])("returns null for zero viewport or content dimensions", (viewport, content) => {
    expect(fitProjectCamera(viewport, content, 40)).toBeNull();
  });

  test("clamps fitted-slack and reachability extrema for undersized content", () => {
    expect(
      clampProjectCamera(
        { scale: 1, x: -999, y: 999 },
        { width: 1000, height: 700 },
        { x: 100, y: 50, width: 200, height: 200 },
      ),
    ).toEqual({ scale: 1, x: 204, y: 78 });
  });

  test("intersects fitted slack with tiny-content reachability at 50 percent", () => {
    const camera = clampProjectCamera(
      { scale: 0.5, x: 0, y: -999 },
      { width: 360, height: 640 },
      { x: 0, y: 0, width: 285, height: 79 },
    );
    expect(camera.y).toBe(0);
    expect(camera.y + 79 * camera.scale).toBeGreaterThanOrEqual(79 * camera.scale);
  });

  test("reports fitted directions and disables only a reached slack bound", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 100, y: 50, width: 200, height: 200 };
    expect(projectMapPanAvailability(
      { scale: 1, x: 300, y: -18 }, viewport, content, { top: 0, right: 0, bottom: 0, left: 0 },
    )).toEqual({ left: true, right: true, up: true, down: true });
    expect(projectMapPanAvailability(
      { scale: 1, x: 396, y: 78 }, viewport, content, { top: 0, right: 0, bottom: 0, left: 0 },
    )).toEqual({ left: false, right: true, up: false, down: true });
  });

  test("clamps transformed lengths exactly equal to usable lengths within fitted bounds", () => {
    expect(clampProjectCamera(
      { scale: 1, x: -999, y: 999 },
      { width: 500, height: 400 },
      { x: 0, y: 0, width: 500, height: 400 },
    )).toEqual({ scale: 1, x: -96, y: 128 });
  });

  test("clamps fitted and oversized axes independently", () => {
    expect(clampProjectCamera(
      { scale: 1, x: -999, y: 999 },
      { width: 500, height: 400 },
      { x: 10, y: 20, width: 100, height: 500 },
    )).toEqual({ scale: 1, x: 94, y: 332 });
  });

  test("clamps an undersized-to-oversized input immediately and keeps the next pan pixel continuous", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 700, height: 200 };
    const current = { scale: 1, x: 246, y: 32 };
    const oversized = clampProjectCameraInput(
      current,
      { scale: 1.5, x: 999, y: 32 },
      { x: false, y: false },
      viewport,
      content,
      undefined,
      "zoom",
    );

    expect(oversized.camera).toEqual({ scale: 1.5, x: 952, y: 32 });
    expect(clampProjectCameraInput(
      oversized.camera,
      { ...oversized.camera, x: 951 },
      oversized.continuity,
      viewport,
      content,
    ).camera.x).toBe(951);
  });

  test("clamps an oversized-to-undersized input immediately and keeps the next pan pixel continuous", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 700, height: 200 };
    const current = { scale: 1.5, x: 952, y: 32 };
    const undersized = clampProjectCameraInput(
      current,
      { scale: 1, x: 999, y: 32 },
      { x: false, y: false },
      viewport,
      content,
      undefined,
      "zoom",
    );

    expect(undersized.camera).toEqual({ scale: 1, x: 246, y: 32 });
    expect(clampProjectCameraInput(
      undersized.camera,
      { ...undersized.camera, x: 245 },
      undersized.continuity,
      viewport,
      content,
    ).camera.x).toBe(245);
  });

  test("ratchets an inset-preserved camera toward standard bounds without a pan snap", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 400, height: 300 };
    const insets = { top: 0, right: 420, bottom: 0, left: 0 };
    const current = { scale: 1, x: 300, y: 32 };
    const continuity = projectMapCameraContinuity(current, viewport, content, insets);

    expect(continuity).toEqual({ x: true, y: false });
    expect(clampProjectCameraInput(
      current, { ...current, x: 340 }, continuity, viewport, content, insets,
    )).toEqual({ camera: current, continuity });
    expect(clampProjectCameraInput(
      current, { ...current, x: 260 }, continuity, viewport, content, insets,
    )).toEqual({
      camera: { ...current, x: 260 },
      continuity: { x: true, y: false },
    });
  });

  test("clears continuity when a pan candidate enters the standard bound", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 400, height: 300 };
    const insets = { top: 0, right: 420, bottom: 0, left: 0 };
    const current = { scale: 1, x: 300, y: 32 };

    expect(clampProjectCameraInput(
      current, { ...current, x: 186 }, { x: true, y: false }, viewport, content, insets,
    )).toEqual({
      camera: { ...current, x: 186 },
      continuity: { x: false, y: false },
    });
  });

  test("preserves an anchored zoom candidate and rebases inspector continuity", () => {
    const viewport = { width: 1000, height: 700 };
    const content = { x: 0, y: 0, width: 400, height: 300 };
    const insets = { top: 0, right: 420, bottom: 0, left: 0 };
    const current = { scale: 1, x: 300, y: 32 };
    const candidate = zoomProjectCameraAt(current, 1.1, { x: 500, y: 350 });
    const result = clampProjectCameraInput(
      current,
      candidate,
      { x: true, y: false },
      viewport,
      content,
      insets,
      "zoom",
    );

    expect(result.camera).toEqual(candidate);
    expect(result.continuity.x).toBe(true);
  });

  test.each([
    [{ scale: 1, x: -9999, y: -9999 }, { scale: 1, x: -1652, y: -802 }],
    [{ scale: 1, x: 9999, y: 9999 }, { scale: 1, x: 852, y: 602 }],
  ])("retains a 48px reachable grip at larger-content extremes", (camera, expected) => {
    expect(
      clampProjectCamera(
        camera,
        { width: 1000, height: 700 },
        { x: 100, y: 50, width: 1600, height: 800 },
      ),
    ).toEqual(expected);
  });

  test("zooms around the supplied screen anchor", () => {
    const anchor = { x: 300, y: 200 };
    const zoomed = zoomProjectCameraAt({ scale: 1, x: 40, y: 20 }, 1.5, anchor);

    expect((anchor.x - zoomed.x) / zoomed.scale).toBeCloseTo(260);
    expect((anchor.y - zoomed.y) / zoomed.scale).toBeCloseTo(180);
  });

  test("preserves the old center world point when the viewport narrows", () => {
    const previousViewport = { width: 1000, height: 700 };
    const nextViewport = { width: 620, height: 700 };
    const camera = { scale: 1, x: -200, y: 100 };
    const content = { x: -100, y: -100, width: 1600, height: 1000 };
    const recentered = recenterProjectCamera(camera, previousViewport, nextViewport, content);

    expect((previousViewport.width / 2 - camera.x) / camera.scale).toBeCloseTo(
      (nextViewport.width / 2 - recentered.x) / recentered.scale,
    );
    expect((previousViewport.height / 2 - camera.y) / camera.scale).toBeCloseTo(
      (nextViewport.height / 2 - recentered.y) / recentered.scale,
    );
  });
});
