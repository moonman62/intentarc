import { expect, test, type Locator, type Page } from "@playwright/test";
import { projectMapAdversarialFixture } from "../test-support/e2e-fixture.js";

const viewports = [
  { name: "wide", size: { width: 1440, height: 900 } },
  { name: "laptop", size: { width: 1024, height: 768 } },
  { name: "narrow", size: { width: 390, height: 844 } },
] as const;

const themes = [
  { name: "Archive Modern", value: "light" },
  { name: "Archive Night", value: "dark" },
] as const;

const adversarialTitle = `NarrowViewport${"UnbrokenHierarchyTitle".repeat(18)}`;
const adversarialProject = projectMapAdversarialFixture.project;
const adversarialRecords = projectMapAdversarialFixture.records;
const adversarialEvidenceTitle = projectMapAdversarialFixture.evidence.title;
const adversarialRelationshipId = projectMapAdversarialFixture.relationshipId;
const deepPath = projectMapAdversarialFixture.records;
const deepTask = deepPath.at(-2)!;
const deepSubtask = deepPath.at(-1)!;
const alternateBranch = projectMapAdversarialFixture.alternateBranch;
const alternateTask = alternateBranch.at(-1)!;

const parseComputedRgbAlpha = (stroke: string): number | null => {
  const match = /^(rgb|rgba)\((.*)\)$/i.exec(stroke.trim());
  if (match === null) return null;
  const body = match[2]?.trim() ?? "";
  const slashParts = body.split("/").map((part) => part.trim());
  if (slashParts.length > 2) return null;
  const components = slashParts[0]?.replaceAll(",", " ").trim().split(/\s+/) ?? [];
  let alphaToken = slashParts[1];
  if (alphaToken === undefined && components.length === 4) {
    alphaToken = components.pop();
  }
  if (components.length !== 3) return null;
  const validChannel = (channel: string): boolean => {
    const percentage = channel.endsWith("%");
    const value = Number.parseFloat(percentage ? channel.slice(0, -1) : channel);
    return Number.isFinite(value) && value >= 0 && value <= (percentage ? 100 : 255);
  };
  if (!components.every(validChannel)) return null;
  if (alphaToken === undefined) return 1;
  const percentage = alphaToken.endsWith("%");
  const alpha = Number.parseFloat(percentage ? alphaToken.slice(0, -1) : alphaToken);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > (percentage ? 100 : 1)) return null;
  return percentage ? alpha / 100 : alpha;
};

const parseComputedDashArray = (dashArray: string): readonly number[] | null => {
  const normalized = dashArray.trim().toLowerCase();
  if (normalized === "none") return [];
  if (normalized === "") return null;
  const values = normalized.split(/[\s,]+/).map((token) => {
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(?:px)?$/.exec(token);
    return match === null ? Number.NaN : Number(match[1]);
  });
  return values.every((value) => Number.isFinite(value) && value >= 0)
    ? values
    : null;
};

const assertConnectorPaint = async (
  path: Locator,
  expected: {
    readonly dashArray: readonly number[];
    readonly stroke?: string;
    readonly strokeWidth: number;
  },
): Promise<void> => {
  const paint = await path.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      dashArray: style.strokeDasharray,
      stroke: style.stroke,
      strokeWidth: Number.parseFloat(style.strokeWidth),
      vectorEffect: style.vectorEffect,
    };
  });
  const strokeAlpha = parseComputedRgbAlpha(paint.stroke);
  expect(strokeAlpha, `expected an rgb/rgba computed stroke, received ${paint.stroke}`)
    .not.toBeNull();
  expect(strokeAlpha).toBeGreaterThan(0);
  if (expected.stroke !== undefined) expect(paint.stroke).toBe(expected.stroke);
  expect(paint.strokeWidth).toBe(expected.strokeWidth);
  expect(parseComputedDashArray(paint.dashArray)).toEqual(expected.dashArray);
  expect(paint.vectorEffect).toBe("non-scaling-stroke");
};

const assertMinimumTargetSize = async (
  target: Locator,
  minimum = 44,
): Promise<void> => {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(minimum);
  expect(bounds!.height).toBeGreaterThanOrEqual(minimum);
};

const assertNoIntersection = async (first: Locator, second: Locator): Promise<void> => {
  const [firstBounds, secondBounds] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ]);
  expect(firstBounds).not.toBeNull();
  expect(secondBounds).not.toBeNull();
  const overlapWidth = Math.max(0, Math.min(
    firstBounds!.x + firstBounds!.width,
    secondBounds!.x + secondBounds!.width,
  ) - Math.max(firstBounds!.x, secondBounds!.x));
  const overlapHeight = Math.max(0, Math.min(
    firstBounds!.y + firstBounds!.height,
    secondBounds!.y + secondBounds!.height,
  ) - Math.max(firstBounds!.y, secondBounds!.y));
  expect(overlapWidth * overlapHeight).toBe(0);
};

const assertMoveMapOutsideCanvas = async (
  page: Page,
  minimumTargetSize: number,
): Promise<void> => {
  await expect(page.getByRole("group", { name: "Map pan controls" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Move map" });
  if (await trigger.isDisabled()) return;
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  const controls = page.getByRole("group", { name: "Move map directions" });
  await expect(controls).toBeVisible();
  const containment = await controls.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(containment.left).toBeGreaterThanOrEqual(0);
  expect(containment.right).toBeLessThanOrEqual(containment.viewportWidth);
  for (const direction of ["up", "left", "right", "down"] as const) {
    await assertMinimumTargetSize(
      controls.getByRole("button", { name: `Pan ${direction}` }),
      minimumTargetSize,
    );
  }
  await trigger.click();
};

const openMoveMapDirections = async (page: Page): Promise<Locator> => {
  const trigger = page.getByRole("button", { name: "Move map" });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const directions = page.getByRole("group", { name: "Move map directions" });
  await expect(directions).toBeVisible();
  return directions;
};

const assertFullyUsableInspectorControl = async (control: Locator): Promise<void> => {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const geometry = await control.evaluate((element) => {
    const body = element.closest<HTMLElement>(".project-map-inspector__body");
    const inspector = element.closest<HTMLElement>(".project-map-inspector");
    const header = inspector?.querySelector<HTMLElement>(".project-map-inspector__header") ?? null;
    if (body === null || inspector === null || header === null) return null;
    const bounds = element.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      bodyBottom: bodyBounds.bottom,
      bodyLeft: bodyBounds.left,
      bodyRight: bodyBounds.right,
      headerBottom: headerBounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.top).toBeGreaterThanOrEqual(geometry!.headerBottom - 1);
  expect(geometry!.bottom).toBeLessThanOrEqual(geometry!.bodyBottom + 1);
  expect(geometry!.left).toBeGreaterThanOrEqual(geometry!.bodyLeft - 1);
  expect(geometry!.right).toBeLessThanOrEqual(geometry!.bodyRight + 1);
};

const exchangeSession = async (page: Page): Promise<void> => {
  await page.goto("/?key=intentarc-e2e-session");
  await expect(page).toHaveURL("http://127.0.0.1:47862/");
};

const hasNoHorizontalOverflow = async (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth
  );

const breadcrumb = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Selected project path" });

const projectMapOverflowOffenders = (page: Page) =>
  page.locator(".project-map").evaluate((root) => {
    const viewportWidth = document.documentElement.clientWidth;
    return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
      .filter((element) => !element.classList.contains("sr-only"))
      .filter((element) => element.closest(".project-map-camera__viewport") === null)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          className: element.className,
          clientWidth: element.clientWidth,
          right: Math.round(bounds.right),
          scrollWidth: element.scrollWidth,
          tagName: element.tagName,
        };
      })
      .filter((element) => element.right > viewportWidth + 1)
      .slice(0, 12);
  });

const assertSelectedPath = async (
  page: Page,
  title: string,
  depth: number,
  recordId: string,
  expectedRouteRecordId: string | null = recordId,
): Promise<void> => {
  await expect.poll(() => new URL(page.url()).searchParams.get("focusRecordId"))
    .toBe(expectedRouteRecordId);
  const path = breadcrumb(page);
  await expect(path.getByRole("listitem")).toHaveCount(depth + 2);
  await expect(path.getByRole("listitem").last()).toHaveText(title);
  await expect(page.getByRole("complementary", { name: "Selected item details" })
    .getByRole("heading", { name: title, level: 2 })).toBeVisible();
  await expect(page.locator(`[role="treeitem"][data-record-id="${recordId}"]`))
    .toHaveAttribute("aria-current", "true");
  expect(await projectMapOverflowOffenders(page)).toEqual([]);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
};

const recordItem = (page: Page, recordId: string): Locator =>
  page.locator(`[role="treeitem"][data-record-id="${recordId}"]`);

const recordButton = (
  page: Page,
  record: { readonly id?: string; readonly label?: string; readonly title: string },
  fallbackLabel: string,
): Locator => record.id === undefined
  ? page.getByRole("treeitem", {
      name: `${record.label ?? fallbackLabel}: ${record.title}`,
      exact: true,
    })
  : recordItem(page, record.id);

const expectRouteState = async (
  page: Page,
  focusRecordId: string | null,
  scopeRecordId: string | null,
): Promise<void> => {
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      focusRecordId: url.searchParams.get("focusRecordId"),
      pathname: url.pathname,
      scopeRecordId: url.searchParams.get("scopeRecordId"),
    };
  }).toEqual({
    focusRecordId,
    pathname: `/projects/${encodeURIComponent(adversarialProject.id)}/map`,
    scopeRecordId,
  });
  await expect(page.getByRole("heading", { name: "Project map", level: 1 }))
    .toBeVisible();
};

const assertDeepAncestry = async (page: Page): Promise<void> => {
  const pathItems = breadcrumb(page).getByRole("listitem");
  await expect(pathItems).toHaveCount(deepPath.length + 1);
  await expect(pathItems.nth(0).getByRole("link", {
    name: `Project: ${adversarialProject.name}`,
    exact: true,
  })).toBeVisible();
  for (const [index, record] of deepPath.entries()) {
    const pathItem = pathItems.nth(index + 1);
    if (index === deepPath.length - 1) {
      await expect(pathItem.locator('[aria-current="page"]')).toHaveText(record.title);
      await expect(pathItem.getByRole("button", { name: record.title, exact: true }))
        .toHaveCount(0);
    } else {
      await expect(pathItem.getByRole("button", {
        name: record.title,
        exact: true,
      })).toBeVisible();
    }
    await expect(recordItem(page, record.id)).toHaveAttribute(
      "data-parent-id",
      index === 0 ? adversarialProject.id : deepPath[index - 1]!.id,
    );
  }
};

const assertFocusedScope = async (
  page: Page,
  selectedRecordId: string,
): Promise<void> => {
  const context = page.getByRole("navigation", { name: "Focused project context" });
  await expect(context).toContainText(`Project ${adversarialProject.name}`);
  await expect(context.getByRole("listitem")).toHaveCount(deepPath.length - 1);
  for (const [index, record] of deepPath.slice(0, -1).entries()) {
    await expect(context.getByRole("listitem").nth(index)).toHaveText(record.title);
  }
  const tree = page.getByRole("tree", {
    name: `${adversarialProject.name} hierarchy tree`,
  });
  const scopeRoot = tree.getByRole("treeitem").first();
  await expect(scopeRoot).toHaveAttribute("data-record-id", deepTask.id);
  await expect(scopeRoot).toHaveAttribute("aria-level", "1");
  await expect(scopeRoot).not.toHaveAttribute("data-parent-id");
  await expect(tree.locator(`[data-project-id="${adversarialProject.id}"]`)).toHaveCount(0);
  for (const ancestor of deepPath.slice(0, -2)) {
    await expect(tree.locator(`[data-record-id="${ancestor.id}"]`)).toHaveCount(0);
  }
  await expect(recordItem(page, selectedRecordId)).toHaveAttribute("aria-current", "true");
};

const revealPath = async (
  page: Page,
  path: readonly { readonly id: string; readonly label?: string; readonly title: string }[],
): Promise<void> => {
  await expect(page.locator("[data-camera-world]")).toHaveAttribute(
    "data-camera-fit-transition",
    "false",
  );
  for (let index = 0; index < path.length - 1; index += 1) {
    const parent = path[index]!;
    const child = path[index + 1]!;
    const childItem = recordItem(page, child.id);
    if (await childItem.isVisible()) continue;
    const parentItem = recordItem(page, parent.id);
    await parentItem.focus();
    await page.keyboard.press("ArrowRight");
    await expect(childItem).toBeVisible();
  }
};

const assertKeyboardTraversal = async (
  page: Page,
  projectItem: Locator,
  finalVisibleRecordId: string,
): Promise<void> => {
  await projectItem.focus();
  await page.keyboard.press("ArrowDown");
  const firstRenderedRecord = recordItem(
    page,
    projectMapAdversarialFixture.secondOutcome.id,
  );
  await expect(firstRenderedRecord).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(projectItem).toBeFocused();
  await page.keyboard.press("End");
  await expect(recordItem(page, finalVisibleRecordId)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(projectItem).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(firstRenderedRecord).toBeFocused();

  const deepRoot = recordItem(page, deepPath[0]!.id);
  await deepRoot.focus();
  await expect(deepRoot).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(deepRoot).toBeFocused();
  await expect(deepRoot).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(projectItem).toBeFocused();

  await deepRoot.focus();
  await page.keyboard.press("ArrowRight");
  await expect(deepRoot).toBeFocused();
  await expect(deepRoot).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(recordItem(page, alternateBranch[0]!.id)).toBeFocused();
  await page.keyboard.press("Enter");
  await expectRouteState(page, alternateBranch[0]!.id, null);
  await expect(recordItem(page, alternateBranch[0]!.id))
    .toHaveAttribute("aria-current", "true");
  await projectItem.focus();
  await expect(projectItem).toBeFocused();
  await page.keyboard.press("Enter");
  await expectRouteState(page, null, null);
  await expect(projectItem).toHaveAttribute("aria-current", "true");
};

const assertConnectorIntersectsCards = async (
  page: Page,
): Promise<void> => {
  const path = page.locator(
    `path[data-connector-id="${projectMapAdversarialFixture.dependencyRelationshipId}"]`,
  );
  await expect(path).toHaveCount(1);
  await expect(page.locator("svg.project-map-connectors")).toBeVisible();
  await expect.poll(() => path.evaluate((element, endpoints) => {
    const source = document.querySelector<HTMLElement>(
      `[data-connector-record-id="${endpoints.sourceRecordId}"]`,
    );
    const target = document.querySelector<HTMLElement>(
      `[data-connector-record-id="${endpoints.targetRecordId}"]`,
    );
    const matrix = element.getScreenCTM();
    if (matrix === null || source === null || target === null) return false;
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const first = element.getPointAtLength(0).matrixTransform(matrix);
    const last = element.getPointAtLength(element.getTotalLength()).matrixTransform(matrix);
    const intersectsEdge = (point: DOMPoint, bounds: DOMRect) => {
      const onVerticalEdge = (
        Math.min(Math.abs(point.x - bounds.left), Math.abs(point.x - bounds.right)) <= 2 &&
        point.y >= bounds.top - 2 && point.y <= bounds.bottom + 2
      );
      const onHorizontalEdge = (
        Math.min(Math.abs(point.y - bounds.top), Math.abs(point.y - bounds.bottom)) <= 2 &&
        point.x >= bounds.left - 2 && point.x <= bounds.right + 2
      );
      return onVerticalEdge || onHorizontalEdge;
    };
    return (
      intersectsEdge(first, sourceBounds) && intersectsEdge(last, targetBounds)
    ) || (
      intersectsEdge(first, targetBounds) && intersectsEdge(last, sourceBounds)
    );
  }, {
    sourceRecordId: alternateTask.id,
    targetRecordId: deepTask.id,
  })).toBe(true);
};

interface CameraSnapshot {
  readonly centerWorldX: number;
  readonly centerWorldY: number;
  readonly height: number;
  readonly scale: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const cameraSnapshot = async (camera: Locator): Promise<CameraSnapshot> =>
  camera.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const scale = Number(node.getAttribute("data-camera-scale"));
    const x = Number(node.getAttribute("data-camera-x"));
    const y = Number(node.getAttribute("data-camera-y"));
    return {
      centerWorldX: (bounds.width / 2 - x) / scale,
      centerWorldY: (bounds.height / 2 - y) / scale,
      height: bounds.height,
      scale,
      width: bounds.width,
      x,
      y,
    };
  });

const settledCameraSnapshot = async (camera: Locator): Promise<CameraSnapshot> =>
  camera.evaluate(async (node) => {
    const read = (): CameraSnapshot => {
      const bounds = node.getBoundingClientRect();
      const scale = Number(node.getAttribute("data-camera-scale"));
      const x = Number(node.getAttribute("data-camera-x"));
      const y = Number(node.getAttribute("data-camera-y"));
      return {
        centerWorldX: (bounds.width / 2 - x) / scale,
        centerWorldY: (bounds.height / 2 - y) / scale,
        height: bounds.height,
        scale,
        width: bounds.width,
        x,
        y,
      };
    };
    const same = (left: CameraSnapshot, right: CameraSnapshot): boolean => (
      left.width === right.width &&
      left.height === right.height &&
      left.scale === right.scale &&
      left.x === right.x &&
      left.y === right.y
    );
    let previous = read();
    let stableSamples = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = read();
      stableSamples = same(previous, current) ? stableSamples + 1 : 0;
      previous = current;
      if (stableSamples >= 2) return current;
    }
    throw new Error("Project map camera did not settle within eight animation frames.");
  });

const assertScopedRootPlacement = async (
  page: Page,
  recordId: string,
  expectedScale: number,
): Promise<void> => {
  const camera = page.locator(".project-map-camera__viewport");
  const root = page.locator(`[data-connector-record-id="${recordId}"]`);
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "false");
  const cameraState = await settledCameraSnapshot(camera);
  expect(cameraState.scale).toBe(expectedScale);
  const [cameraBounds, rootBounds, inspectorBounds] = await Promise.all([
    camera.boundingBox(),
    root.boundingBox(),
    inspector.boundingBox(),
  ]);
  expect(cameraBounds).not.toBeNull();
  expect(rootBounds).not.toBeNull();
  expect(inspectorBounds).not.toBeNull();
  const usableRight = Math.min(
    cameraBounds!.x + cameraBounds!.width,
    inspectorBounds!.x,
  );
  expect(Math.abs(
    cameraBounds!.x + (usableRight - cameraBounds!.x) / 2 -
    (rootBounds!.x + rootBounds!.width / 2),
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(rootBounds!.y - cameraBounds!.y - 32)).toBeLessThanOrEqual(1);
};

const setToolbarScale = async (page: Page, targetPercent: number): Promise<void> => {
  const output = page.getByRole("status", { name: "Map zoom" });
  await expect(page.locator("[data-camera-world]")).toHaveAttribute(
    "data-camera-fit-transition",
    "false",
  );
  await expect(output).toHaveText(/^\d+%$/);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const currentPercent = Number.parseInt((await output.textContent()) ?? "", 10);
    if (currentPercent === targetPercent) return;
    const zoomControl = page.getByRole("button", {
      name: currentPercent < targetPercent ? "Zoom in" : "Zoom out",
    });
    await expect(zoomControl).toBeEnabled();
    await zoomControl.click();
  }
  await expect(output).toHaveText(`${targetPercent}%`);
};

const primaryProjectConnector = (page: Page): Locator => page.locator(
  `path[data-connector-id="primary:project:${adversarialProject.id}:${deepPath[0]!.id}"]`,
);

const assertConnectorEdges = async (
  path: Locator,
  sourceRecordId: string,
  targetRecordId: string,
): Promise<void> => {
  await expect(path).toHaveCount(1);
  await expect.poll(() => path.evaluate((element, endpoints) => {
    const source = document.querySelector<HTMLElement>(
      `[data-connector-record-id="${endpoints.sourceRecordId}"]`,
    );
    const target = document.querySelector<HTMLElement>(
      `[data-connector-record-id="${endpoints.targetRecordId}"]`,
    );
    const matrix = element.getScreenCTM();
    if (source === null || target === null || matrix === null) {
      return { intersects: false, reason: "missing endpoint or screen matrix" };
    }
    const start = element.getPointAtLength(0).matrixTransform(matrix);
    const end = element.getPointAtLength(element.getTotalLength()).matrixTransform(matrix);
    const intersectsEdge = (point: DOMPoint, bounds: DOMRect): boolean => (
      (
        Math.min(Math.abs(point.x - bounds.left), Math.abs(point.x - bounds.right)) <= 2 &&
        point.y >= bounds.top - 2 && point.y <= bounds.bottom + 2
      ) || (
        Math.min(Math.abs(point.y - bounds.top), Math.abs(point.y - bounds.bottom)) <= 2 &&
        point.x >= bounds.left - 2 && point.x <= bounds.right + 2
      )
    );
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const svgBounds = element.ownerSVGElement?.getBoundingClientRect() ?? null;
    const worldBounds = document.querySelector<HTMLElement>("[data-camera-world]")
      ?.getBoundingClientRect() ?? null;
    const intersects = (
      intersectsEdge(start, sourceBounds) && intersectsEdge(end, targetBounds)
    ) || (
      intersectsEdge(start, targetBounds) && intersectsEdge(end, sourceBounds)
    );
    return {
      end: { x: end.x, y: end.y },
      intersects,
      matrix: { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f },
      path: element.getAttribute("d"),
      source: {
        bottom: sourceBounds.bottom,
        left: sourceBounds.left,
        right: sourceBounds.right,
        top: sourceBounds.top,
      },
      start: { x: start.x, y: start.y },
      svg: svgBounds === null ? null : {
        height: svgBounds.height,
        left: svgBounds.left,
        top: svgBounds.top,
        width: svgBounds.width,
      },
      target: {
        bottom: targetBounds.bottom,
        left: targetBounds.left,
        right: targetBounds.right,
        top: targetBounds.top,
      },
      world: worldBounds === null ? null : {
        height: worldBounds.height,
        left: worldBounds.left,
        top: worldBounds.top,
        width: worldBounds.width,
      },
    };
  }, { sourceRecordId, targetRecordId })).toMatchObject({ intersects: true });
};

const assertTopDownCardGeometry = async (page: Page): Promise<void> => {
  const cards = await page.locator("[data-connector-record-id]").evaluateAll((nodes) =>
    nodes.map((node) => {
      const bounds = node.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        id: node.getAttribute("data-connector-record-id"),
        left: bounds.left,
        parentId: node.getAttribute("data-parent-id"),
        right: bounds.right,
        top: bounds.top,
      };
    }).filter((node) => node.right > node.left && node.bottom > node.top));
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const card of cards) {
    if (card.parentId === null) continue;
    const parentId = card.parentId === adversarialProject.id
      ? `project:${adversarialProject.id}`
      : card.parentId;
    const parent = byId.get(parentId);
    if (parent !== undefined) expect(card.top).toBeGreaterThanOrEqual(parent.bottom - 1);
  }
  for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
      const left = cards[leftIndex]!;
      const right = cards[rightIndex]!;
      const overlaps = left.left < right.right - 1 && left.right > right.left + 1 &&
        left.top < right.bottom - 1 && left.bottom > right.top + 1;
      expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false);
    }
  }
};

const assertProjectCameraShell = async (
  page: Page,
  viewport: { readonly width: number; readonly height: number },
  theme: "light" | "dark",
): Promise<void> => {
  const layout = page.locator(".project-map__layout");
  const cameraRegion = page.getByRole("region", {
    name: `${adversarialProject.name} project map canvas`,
  });
  const cameraViewport = page.locator(".project-map-camera__viewport");
  await expect(layout).not.toHaveClass(/project-map__layout--with-detail/);
  await expect(page.getByRole("group", { name: "Map controls" })).toBeVisible();
  for (const controlName of ["Zoom out", "Zoom in", "Fit project"] as const) {
    await expect(page.getByRole("button", { name: controlName })).toBeVisible();
  }
  await expect(page.getByRole("status", { name: "Map zoom" })).toBeVisible();
  await assertMoveMapOutsideCanvas(page, viewport.width < 760 ? 44 : 40);
  const [cameraBounds, layoutBounds] = await Promise.all([
    cameraRegion.boundingBox(),
    layout.boundingBox(),
  ]);
  expect(cameraBounds).not.toBeNull();
  expect(layoutBounds).not.toBeNull();
  expect(cameraBounds!.width).toBeGreaterThanOrEqual(layoutBounds!.width - 1);
  const expectedHeight = viewport.width < 760
    ? Math.min(680, Math.max(420, viewport.height * 0.62))
    : Math.min(820, Math.max(480, viewport.height * 0.68));
  expect(await cameraViewport.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(expectedHeight, 0);
  await expect(page.getByRole("status", { name: "Map zoom" })).toHaveText("100%");
  const root = page.locator(
    `[data-connector-record-id="project:${adversarialProject.id}"]`,
  );
  await expect.poll(async () => {
    const [viewportBounds, rootBounds] = await Promise.all([
      cameraViewport.boundingBox(),
      root.boundingBox(),
    ]);
    if (viewportBounds === null || rootBounds === null) return Number.POSITIVE_INFINITY;
    return Math.abs(rootBounds.y - viewportBounds.y - 32);
  }).toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const [viewportBounds, rootBounds] = await Promise.all([
      cameraViewport.boundingBox(),
      root.boundingBox(),
    ]);
    if (viewportBounds === null || rootBounds === null) return Number.POSITIVE_INFINITY;
    return Math.abs(
      rootBounds.x + rootBounds.width / 2 -
      (viewportBounds.x + viewportBounds.width / 2),
    );
  }).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);

  const primaryPath = page.locator("path[data-connector-style='primary']").first();
  await expect(primaryPath).toHaveCount(1);
  await assertConnectorPaint(primaryPath, {
    dashArray: [],
    stroke: theme === "light" ? "rgb(143, 136, 123)" : "rgb(116, 128, 120)",
    strokeWidth: 1.75,
  });
};

const assertSelectedInspectorLayout = async (
  page: Page,
  viewportWidth: number,
): Promise<void> => {
  const camera = page.locator(".project-map-camera__viewport");
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  const [cameraBounds, inspectorBounds] = await Promise.all([
    camera.boundingBox(),
    inspector.boundingBox(),
  ]);
  expect(cameraBounds).not.toBeNull();
  expect(inspectorBounds).not.toBeNull();
  await assertMoveMapOutsideCanvas(page, viewportWidth < 760 ? 44 : 40);
  if (viewportWidth >= 760) {
    expect(inspectorBounds!.width).toBeGreaterThanOrEqual(360);
    expect(inspectorBounds!.width).toBeLessThanOrEqual(420);
    expect(Math.abs(
      cameraBounds!.x + cameraBounds!.width -
      (inspectorBounds!.x + inspectorBounds!.width) - 12,
    )).toBeLessThanOrEqual(1);
    expect(inspectorBounds!.y).toBeGreaterThanOrEqual(cameraBounds!.y);
  } else {
    expect(Math.abs(inspectorBounds!.x - cameraBounds!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(inspectorBounds!.width - cameraBounds!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(
      inspectorBounds!.y + inspectorBounds!.height -
      (cameraBounds!.y + cameraBounds!.height),
    )).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
};

test("drags a fitted whole-project camera and discloses contained Move map directions", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);
  const visibleParent = recordItem(page, deepPath[0]!.id);
  const collapse = visibleParent.getByRole("button", {
    name: `Collapse ${deepPath[0]!.title}`,
  });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(visibleParent).toHaveAttribute("aria-expanded", "false");
  await visibleParent.getByRole("button", {
    name: `Expand ${deepPath[0]!.title}`,
  }).click();
  await expect(visibleParent).toHaveAttribute("aria-expanded", "true");
  await setToolbarScale(page, 150);

  await expect(page.getByRole("group", { name: "Map pan controls" })).toHaveCount(0);
  const moveMap = page.getByRole("button", { name: "Move map" });
  await expect(moveMap).toHaveAttribute("aria-expanded", "false");
  await moveMap.click();
  const controls = page.getByRole("group", { name: "Move map directions" });
  await expect(controls).toBeVisible();
  const [left, up, down, right] = await Promise.all([
    controls.getByRole("button", { name: "Pan left" }).boundingBox(),
    controls.getByRole("button", { name: "Pan up" }).boundingBox(),
    controls.getByRole("button", { name: "Pan down" }).boundingBox(),
    controls.getByRole("button", { name: "Pan right" }).boundingBox(),
  ]);
  expect(left).not.toBeNull();
  expect(up).not.toBeNull();
  expect(down).not.toBeNull();
  expect(right).not.toBeNull();
  expect(up!.y).toBeLessThan(left!.y);
  expect(down!.y).toBeGreaterThan(left!.y);
  expect(left!.x).toBeLessThan(up!.x);
  expect(right!.x).toBeGreaterThan(up!.x);

  const expectedTabOrder = ["Pan up", "Pan left", "Pan right", "Pan down"];
  expect(await controls.getByRole("button").evaluateAll((buttons) => (
    buttons.map((button) => button.getAttribute("aria-label"))
  ))).toEqual(expectedTabOrder);

  await moveMap.click();
  await page.getByRole("button", { name: "Fit project" }).click();
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "false");
  const camera = page.locator(".project-map-camera__viewport");
  const canonical = await settledCameraSnapshot(camera);
  const fittedDirections = await openMoveMapDirections(page);
  const dragDirection = (await Promise.all([
    { axis: "x" as const, delta: 80, name: "Pan left" },
    { axis: "x" as const, delta: -80, name: "Pan right" },
    { axis: "y" as const, delta: 80, name: "Pan up" },
    { axis: "y" as const, delta: -80, name: "Pan down" },
  ].map(async (candidate) => ({
    ...candidate,
    enabled: await fittedDirections.getByRole("button", { name: candidate.name }).isEnabled(),
  })))).find((candidate) => candidate.enabled);
  expect(dragDirection).toBeDefined();
  await moveMap.click();
  const panSurface = page.locator("[data-camera-pan-surface]");
  const surfaceBounds = await panSurface.boundingBox();
  expect(surfaceBounds).not.toBeNull();
  const dragX = surfaceBounds!.x + surfaceBounds!.width / 2;
  const dragY = surfaceBounds!.y + surfaceBounds!.height / 2;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(
    dragX + (dragDirection!.axis === "x" ? dragDirection!.delta : 0),
    dragY + (dragDirection!.axis === "y" ? dragDirection!.delta : 0),
    { steps: 4 },
  );
  await page.mouse.up();
  const dragged = await cameraSnapshot(camera);
  expect(dragged[dragDirection!.axis] - canonical[dragDirection!.axis])
    .toBe(dragDirection!.delta);
  await page.getByRole("button", { name: "Fit project" }).click();
  expect(await settledCameraSnapshot(camera)).toEqual(canonical);

  await moveMap.click();

  for (const direction of ["up", "left", "right", "down"] as const) {
    const button = controls.getByRole("button", { name: `Pan ${direction}` });
    if (await button.isEnabled()) {
      const before = await cameraSnapshot(camera);
      await button.click();
      const after = await cameraSnapshot(camera);
      const axis = direction === "left" || direction === "right" ? "x" : "y";
      expect(after[axis]).not.toBe(before[axis]);
    } else {
      await expect(button).toBeDisabled();
    }
  }

  await setToolbarScale(page, 50);
  const overview = page.getByText("Overview limited to 50%", { exact: true });
  await expect(overview).toBeVisible();
  await assertNoIntersection(await openMoveMapDirections(page), overview);

  await visibleParent.click();
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(inspector).toHaveAttribute("data-layout", "wide");
  await expect(inspector).toHaveAttribute("aria-busy", "false");
  await expect(overview).toBeVisible();
  await assertNoIntersection(await openMoveMapDirections(page), overview);
  await assertNoIntersection(inspector, overview);
  const [inspectorBounds, overviewBounds] = await Promise.all([
    inspector.boundingBox(),
    overview.boundingBox(),
  ]);
  expect(inspectorBounds).not.toBeNull();
  expect(overviewBounds).not.toBeNull();
  expect(overviewBounds!.x + overviewBounds!.width)
    .toBeLessThanOrEqual(inspectorBounds!.x);
});

test("Escape from a Move map direction closes only the disclosure and preserves selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);
  await revealPath(page, deepPath);
  const selected = recordItem(page, deepTask.id);
  await selected.click();
  await expectRouteState(page, deepTask.id, null);
  await expect(page.getByRole("complementary", { name: "Selected item details" })).toBeVisible();

  const moveMap = page.getByRole("button", { name: "Move map" });
  await moveMap.click();
  const camera = page.locator(".project-map-camera__viewport");
  const beforeEscape = await cameraSnapshot(camera);
  const enabledPan = page.getByRole("group", { name: "Move map directions" })
    .locator("button:not([disabled])").first();
  await expect(enabledPan).toBeEnabled();
  await enabledPan.focus();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("group", { name: "Move map directions" })).toHaveCount(0);
  await expect(moveMap).toBeFocused();
  await expectRouteState(page, deepTask.id, null);
  await expect(page.getByRole("complementary", { name: "Selected item details" })).toBeVisible();
  expect(await cameraSnapshot(camera)).toEqual(beforeEscape);
});

test("keeps Move map directions inside the unobscured camera beside wide and bottom-sheet inspectors", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 780, height: 844 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);
  await revealPath(page, deepPath);
  await recordItem(page, deepTask.id).click();
  await expectRouteState(page, deepTask.id, null);

  const assertPanelUsable = async (layout: "narrow" | "wide") => {
    const inspector = page.getByRole("complementary", { name: "Selected item details" });
    await expect(inspector).toHaveAttribute("data-layout", layout);
    const directions = await openMoveMapDirections(page);
    const geometry = await Promise.all([
      page.locator(".project-map-camera__control-deck").boundingBox(),
      page.locator(".project-map-camera__viewport").boundingBox(),
      inspector.boundingBox(),
      directions.boundingBox(),
    ]);
    const [deck, camera, inspectorBounds, panel] = geometry;
    expect(deck).not.toBeNull();
    expect(camera).not.toBeNull();
    expect(inspectorBounds).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(deck!.x);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(deck!.x + deck!.width);
    const overlapWidth = Math.max(0, Math.min(
      panel!.x + panel!.width,
      inspectorBounds!.x + inspectorBounds!.width,
    ) - Math.max(panel!.x, inspectorBounds!.x));
    const overlapHeight = Math.max(0, Math.min(
      panel!.y + panel!.height,
      inspectorBounds!.y + inspectorBounds!.height,
    ) - Math.max(panel!.y, inspectorBounds!.y));
    expect(overlapWidth * overlapHeight).toBe(0);
    if (layout === "narrow") {
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(inspectorBounds!.y);
    }
    for (const button of await directions.getByRole("button").all()) {
      const hit = await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return target === element || element.contains(target);
      });
      expect(hit).toBe(true);
      await button.focus();
      await expect(button).toBeFocused();
    }
    await page.getByRole("button", { name: "Move map" }).click();
  };

  await assertPanelUsable("wide");
  await page.setViewportSize({ width: 390, height: 600 });
  await assertPanelUsable("narrow");
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
});

test("repositions the open Move map directions when a wide inspector deck resizes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);
  await revealPath(page, deepPath);
  await recordItem(page, deepTask.id).click();
  await expectRouteState(page, deepTask.id, null);

  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(inspector).toHaveAttribute("data-layout", "wide");
  const moveMap = page.getByRole("button", { name: "Move map" });
  const directions = await openMoveMapDirections(page);
  const camera = page.locator(".project-map-camera__viewport");

  const assertOpenPanelUsable = async () => {
    await expect(moveMap).toHaveAttribute("aria-expanded", "true");
    const [deck, inspectorBounds, panel] = await Promise.all([
      page.locator(".project-map-camera__control-deck").boundingBox(),
      inspector.boundingBox(),
      directions.boundingBox(),
    ]);
    expect(deck).not.toBeNull();
    expect(inspectorBounds).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(deck!.x);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(deck!.x + deck!.width);
    const overlapWidth = Math.max(0, Math.min(
      panel!.x + panel!.width,
      inspectorBounds!.x + inspectorBounds!.width,
    ) - Math.max(panel!.x, inspectorBounds!.x));
    const overlapHeight = Math.max(0, Math.min(
      panel!.y + panel!.height,
      inspectorBounds!.y + inspectorBounds!.height,
    ) - Math.max(panel!.y, inspectorBounds!.y));
    expect(overlapWidth * overlapHeight).toBe(0);

    const enabledDirections = directions.locator("button:not([disabled])");
    expect(await enabledDirections.count()).toBeGreaterThan(0);
    for (const button of await enabledDirections.all()) {
      expect(await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return target === element || element.contains(target);
      })).toBe(true);
      await button.click({ trial: true });
    }
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  };

  await assertOpenPanelUsable();
  await page.setViewportSize({ width: 780, height: 844 });
  await expect(inspector).toHaveAttribute("data-layout", "wide");
  await assertOpenPanelUsable();
  const beforePan = await cameraSnapshot(camera);
  await directions.locator("button:not([disabled])").first().click();
  expect(await cameraSnapshot(camera)).not.toEqual(beforePan);

  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(inspector).toHaveAttribute("data-layout", "wide");
  await assertOpenPanelUsable();
});

test("preserves inspector continuity through toolbar, wheel, and pinch zoom anchors", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?scopeRecordId=${encodeURIComponent(deepSubtask.id)}`,
  );
  await expectRouteState(page, null, deepSubtask.id);
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  const camera = page.locator(".project-map-camera__viewport");
  const fit = page.getByRole("button", { name: "Fit branch" });
  if (await fit.isEnabled()) await fit.click();
  const beforeInspector = await settledCameraSnapshot(camera);

  await page.getByRole("treeitem").click();
  await expectRouteState(page, deepSubtask.id, deepSubtask.id);
  await expect(page.getByRole("complementary", { name: "Selected item details" }))
    .toHaveAttribute("aria-busy", "false");
  const continuityCamera = await settledCameraSnapshot(camera);
  expect(continuityCamera.scale).toBe(beforeInspector.scale);
  expect(continuityCamera.x).toBe(beforeInspector.x);
  expect(continuityCamera.y).toBe(beforeInspector.y);

  const anchoredExpectation = (
    before: Awaited<ReturnType<typeof cameraSnapshot>>,
    nextScale: number,
    oldAnchor: { readonly x: number; readonly y: number },
    newAnchor = oldAnchor,
  ) => {
    const worldX = (oldAnchor.x - before.x) / before.scale;
    const worldY = (oldAnchor.y - before.y) / before.scale;
    return {
      scale: nextScale,
      x: newAnchor.x - worldX * nextScale,
      y: newAnchor.y - worldY * nextScale,
    };
  };
  const expectAnchored = (
    actual: Awaited<ReturnType<typeof cameraSnapshot>>,
    expected: { readonly scale: number; readonly x: number; readonly y: number },
  ) => {
    expect(actual.scale).toBeCloseTo(expected.scale, 5);
    expect(Math.abs(actual.x - expected.x)).toBeLessThan(0.1);
    expect(Math.abs(actual.y - expected.y)).toBeLessThan(0.1);
  };

  const toolbarBefore = await cameraSnapshot(camera);
  const toolbarAnchor = await camera.evaluate((element) => ({
    x: element.clientWidth / 2,
    y: element.clientHeight / 2,
  }));
  await page.getByRole("button", { name: "Zoom out" }).click();
  const toolbarAfter = await cameraSnapshot(camera);
  expectAnchored(
    toolbarAfter,
    anchoredExpectation(toolbarBefore, toolbarBefore.scale - 0.1, toolbarAnchor),
  );

  const wheelBefore = toolbarAfter;
  const wheelAnchor = { x: 320, y: 240 };
  const cameraBounds = await camera.boundingBox();
  expect(cameraBounds).not.toBeNull();
  await camera.evaluate((element, point) => {
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      deltaY: -100,
    }));
  }, {
    x: cameraBounds!.x + wheelAnchor.x,
    y: cameraBounds!.y + wheelAnchor.y,
  });
  const wheelAfter = await cameraSnapshot(camera);
  expectAnchored(
    wheelAfter,
    anchoredExpectation(wheelBefore, wheelBefore.scale + 0.1, wheelAnchor),
  );
  await expectRouteState(page, deepSubtask.id, deepSubtask.id);

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const pinchBefore = wheelAfter;
  const pinchPoints = await camera.locator("[data-camera-pan-surface]").evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    const inspectorBounds = document
      .querySelector<HTMLElement>(".project-map-inspector")
      ?.getBoundingClientRect();
    const unobscuredRight = Math.min(bounds.right, inspectorBounds?.left ?? bounds.right) - 20;

    for (let y = bounds.top + 40; y <= bounds.bottom - 40; y += 20) {
      for (let x = bounds.left + 40; x + 160 <= unobscuredRight; x += 20) {
        if (
          document.elementFromPoint(x, y) === surface
          && document.elementFromPoint(x + 160, y) === surface
        ) {
          return {
            first: { x, y },
            second: { x: x + 160, y },
          };
        }
      }
    }
    return null;
  });
  expect(pinchPoints).not.toBeNull();
  const start = [
    { id: 1, ...pinchPoints!.first },
    { id: 2, ...pinchPoints!.second },
  ];
  const movedSecond = { ...start[1]!, x: start[1]!.x - 50 };
  const oldMidpoint = {
    x: (start[0]!.x + start[1]!.x) / 2 - cameraBounds!.x,
    y: (start[0]!.y + start[1]!.y) / 2 - cameraBounds!.y,
  };
  const newMidpoint = {
    x: (start[0]!.x + movedSecond.x) / 2 - cameraBounds!.x,
    y: (start[0]!.y + movedSecond.y) / 2 - cameraBounds!.y,
  };
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: start });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [start[0]!, movedSecond],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const pinchAfter = await cameraSnapshot(camera);
  expectAnchored(
    pinchAfter,
    anchoredExpectation(
      pinchBefore,
      pinchBefore.scale * 110 / 160,
      oldMidpoint,
      newMidpoint,
    ),
  );
  await client.detach();
  await expectRouteState(page, deepSubtask.id, deepSubtask.id);
});

test("keeps mobile hierarchy action labels on one line", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  const visibleParent = recordItem(page, deepPath[0]!.id);
  const assertUnwrappedAction = async (label: "Collapse" | "Expand") => {
    const action = visibleParent.getByRole("button", {
      name: `${label} ${deepPath[0]!.title}`,
    });
    await expect(action).toBeVisible();
    await assertMinimumTargetSize(action);
    expect(await action.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lineTops = new Set(Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top)));
      return {
        containsText: element.scrollWidth <= element.clientWidth + 1,
        lineCount: lineTops.size,
      };
    })).toEqual({ containsText: true, lineCount: 1 });
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
    return action;
  };

  const collapse = await assertUnwrappedAction("Collapse");
  await collapse.click();
  await expect(visibleParent).toHaveAttribute("aria-expanded", "false");
  await assertUnwrappedAction("Expand");
});

test("dismisses a cold inspector once while topology verification is pending", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);

  let releaseTopology!: () => void;
  const topologyGate = new Promise<void>((resolve) => { releaseTopology = resolve; });
  await page.route(`**/api/projects/${adversarialProject.id}/map`, async (route) => {
    await topologyGate;
    await route.continue();
  });

  try {
    await page.goto(
      `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(deepSubtask.id)}`,
    );
    const coldInspector = page.getByRole("complementary", { name: "Selected item details" });
    await expect(coldInspector).toHaveAttribute("aria-busy", "true");
    await expect(coldInspector.getByRole("heading", {
      name: "Loading selected item…",
    })).toBeVisible();
    await coldInspector.getByRole("button", { name: "Close details" }).click();
    await expectRouteState(page, null, null);
    await expect(coldInspector).toHaveCount(0);

    releaseTopology();
    await expect(page.getByRole("tree", {
      name: `${adversarialProject.name} hierarchy tree`,
    })).toBeVisible();
    await expect(coldInspector).toHaveCount(0);
  } finally {
    releaseTopology();
  }
});

test("places a warm focused branch at the camera contract without fitting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(deepTask.id)}`,
  );
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(inspector).toHaveAttribute("aria-busy", "false");
  await setToolbarScale(page, 130);
  const scaleBeforeFocus = (await settledCameraSnapshot(
    page.locator(".project-map-camera__viewport"),
  )).scale;
  const focusRequestBefore = Number(await page.locator(".project-map-camera__viewport")
    .getAttribute("data-camera-focus-request-key"));
  const focusBranch = inspector.getByRole("button", { name: "Focus branch" });
  await assertFullyUsableInspectorControl(focusBranch);
  await focusBranch.click();
  await expectRouteState(page, deepTask.id, deepTask.id);
  await expect.poll(async () => Number(await page.locator(".project-map-camera__viewport")
    .getAttribute("data-camera-focus-request-key"))).toBe(focusRequestBefore + 1);
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "true");
  await assertScopedRootPlacement(page, deepTask.id, scaleBeforeFocus);
});

test("places a cold scoped route at 100 percent and the camera root contract", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(deepTask.id)}&scopeRecordId=${encodeURIComponent(deepTask.id)}`,
  );
  await expectRouteState(page, deepTask.id, deepTask.id);
  await expect(page.getByRole("complementary", { name: "Selected item details" }))
    .toHaveAttribute("aria-busy", "false");
  await assertScopedRootPlacement(page, deepTask.id, 1);
});

test("keeps a scope-only route passive when ordinary selection opens the inspector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?scopeRecordId=${encodeURIComponent(deepTask.id)}`,
  );
  await expectRouteState(page, null, deepTask.id);
  await expect(page.getByRole("complementary", { name: "Selected item details" }))
    .toHaveCount(0);
  const camera = page.locator(".project-map-camera__viewport");
  const beforeSelection = await settledCameraSnapshot(camera);

  await recordItem(page, deepTask.id).click();
  await expectRouteState(page, deepTask.id, deepTask.id);
  await expect(page.getByRole("complementary", { name: "Selected item details" }))
    .toHaveAttribute("aria-busy", "false");
  const afterSelection = await settledCameraSnapshot(camera);

  expect(afterSelection.scale).toBe(beforeSelection.scale);
  expect(afterSelection.x).toBe(beforeSelection.x);
  expect(afterSelection.y).toBe(beforeSelection.y);
});

for (const { name: themeName, value: theme } of themes) {
  test(`keeps narrow Map controls and the long-title inspector usable in ${themeName}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.addInitScript(({ projectId, storedTheme }) => {
      localStorage.setItem("intentarc.activeProject", projectId);
      localStorage.setItem("intentarc.theme", storedTheme);
    }, { projectId: adversarialProject.id, storedTheme: theme });
    await exchangeSession(page);
    await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);
    await revealPath(page, deepPath);
    await revealPath(page, alternateBranch);
    const camera = page.locator(".project-map-camera__viewport");
    await settledCameraSnapshot(camera);
    await page.getByRole("button", { name: "Fit project" }).click();
    await expect(page.locator("[data-camera-world]"))
      .toHaveAttribute("data-camera-fit-transition", "false");
    await settledCameraSnapshot(camera);

    const toolbar = page.getByRole("group", { name: "Map controls" });
    for (const targetPercent of [50, 100, 150] as const) {
      await setToolbarScale(page, targetPercent);
      for (const button of await toolbar.getByRole("button").all()) {
        await assertMinimumTargetSize(button);
      }
      const moveMap = page.getByRole("button", { name: "Move map" });
      await moveMap.click();
      const panControls = page.getByRole("group", { name: "Move map directions" });
      for (const button of await panControls.getByRole("button").all()) {
        await assertMinimumTargetSize(button);
      }
      if (targetPercent === 50) {
        await assertNoIntersection(
          panControls,
          page.getByText("Overview limited to 50%", { exact: true }),
        );
      }
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await moveMap.click();
    }

    await page.goto(
      `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(deepSubtask.id)}`,
    );
    const inspector = page.getByRole("complementary", { name: "Selected item details" });
    const header = inspector.locator(".project-map-inspector__header");
    await expect(inspector).toHaveAttribute("data-layout", "narrow");
    await expect(inspector).toHaveAttribute("aria-busy", "false");
    const focusBranch = inspector.getByRole("button", { name: "Focus branch" });
    const relationshipControl = inspector.getByRole("button", {
      name: `Show related ${adversarialEvidenceTitle}`,
    });
    const attachmentLink = inspector.getByRole("region", { name: "Accepted attachments" })
      .getByRole("link", { name: "Repository" });
    for (const targetPercent of [50, 100, 150] as const) {
      await setToolbarScale(page, targetPercent);
      for (const control of [focusBranch, relationshipControl, attachmentLink]) {
        await assertFullyUsableInspectorControl(control);
        await assertMinimumTargetSize(control);
      }
    }

    await expect(header.getByRole("heading", { name: deepSubtask.title })).toBeVisible();
    const expandedContainment = await header.evaluate((element) => {
      const parent = element.getBoundingClientRect();
      return Array.from(element.children).every((child) => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 &&
          bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1;
      });
    });
    expect(expandedContainment).toBe(true);
    for (const name of ["Collapse details", "Close details"] as const) {
      await assertMinimumTargetSize(inspector.getByRole("button", { name }));
    }

    await inspector.getByRole("button", { name: "Collapse details" }).click();
    await expect(inspector).toHaveAttribute("data-collapsed", "true");
    expect(Math.abs((await inspector.boundingBox())!.height - 56)).toBeLessThanOrEqual(1);
    expect(Math.abs((await header.boundingBox())!.height - 56)).toBeLessThanOrEqual(1);
    for (const name of ["Expand details", "Close details"] as const) {
      await assertMinimumTargetSize(inspector.getByRole("button", { name }));
    }
    expect(await header.evaluate((element) => {
      const parent = element.getBoundingClientRect();
      return Array.from(element.children).every((child) => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 &&
          bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1;
      });
    })).toBe(true);
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  });
}

for (const { name: viewportName, size: viewport } of viewports) {
  for (const { name: themeName, value: theme } of themes) {
    test(`preserves the whole-Project journey at ${viewportName} ${themeName}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const remoteRequests: string[] = [];
      let mapRequestCount = 0;
      let detailRequestCount = 0;
      let mainFrameNavigationCount = 0;
      let releaseDetail!: () => void;
      const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          mainFrameNavigationCount += 1;
        }
        if (url.pathname === `/api/projects/${adversarialProject.id}/map`) {
          mapRequestCount += 1;
        }
        if (url.hostname !== "127.0.0.1") {
          remoteRequests.push(request.url());
        }
      });
      await page.setViewportSize(viewport);
      await page.addInitScript(({ projectId, storedTheme }) => {
        const loadKey = "intentarc.e2e.mapDocumentLoads";
        sessionStorage.setItem(loadKey, String(Number(sessionStorage.getItem(loadKey) ?? "0") + 1));
        localStorage.setItem("intentarc.activeProject", projectId);
        localStorage.setItem("intentarc.theme", storedTheme);
      }, { projectId: adversarialProject.id, storedTheme: theme });
      await exchangeSession(page);
      await page.goto(
        `/projects/${encodeURIComponent(adversarialProject.id)}/map`,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "Project map" })).toBeVisible();
      const tree = page.getByRole("tree", {
        name: `${adversarialProject.name} hierarchy tree`,
      });
      await expect(tree).toBeVisible();
      await assertProjectCameraShell(page, viewport, theme);
      await assertTopDownCardGeometry(page);
      const projectItem = tree.locator(
        `[role="treeitem"][data-project-id="${adversarialProject.id}"]`,
      );
      await expect(projectItem).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".project-hierarchy__scope-context"))
        .toContainText("Whole Project");
      await expect(recordButton(page, deepPath[0], "Product outcome")).toBeVisible();
      await expect(page.getByRole("treeitem", {
        name: `Product outcome: ${projectMapAdversarialFixture.secondOutcome.title}`,
        exact: true,
      })).toBeVisible();
      await expect(tree.locator(
        `[role="treeitem"][data-parent-id="${adversarialProject.id}"]`,
      )).toHaveCount(2);

      const alternateSummaryId = viewport.width < 760
        ? alternateBranch[0]!.id
        : alternateBranch[1]!.id;
      await expect(recordItem(page, alternateSummaryId).getByText("1 hidden item", {
        exact: true,
      })).toBeVisible();

      const map = page.getByTestId("project-map");
      const depthCutoffRecord = viewport.width < 760 ? deepPath[1]! : deepPath[2]!;
      await expect(recordItem(page, depthCutoffRecord.id)).toBeVisible();
      await expect(map.getByRole("button", { name: /Show (less detail|one more level)/ }))
        .toHaveCount(0);
      await expect(map.getByRole("button", {
        name: /Edit hierarchy|Set parent|Remove parent|Place work|Visual project map/,
      })).toHaveCount(0);
      await expect(map.getByRole("combobox", { name: "Project vocabulary" })).toHaveCount(0);
      await assertKeyboardTraversal(page, projectItem, depthCutoffRecord.id);

      await revealPath(page, deepPath);
      await page.route("**/api/projects/**/records/**/connected-detail", async (route) => {
        detailRequestCount += 1;
        await detailGate;
        await route.continue();
      });
      const cameraBeforeSelection = page.locator(".project-map-camera__viewport");
      const canvasWidthBeforeSelection = (await cameraBeforeSelection.boundingBox())!.width;
      const renderedIdsBeforeSelection = await page.locator(
        "[role='treeitem'][data-record-id]",
      ).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-record-id")));
      const mapRequestsBeforeSelection = mapRequestCount;
      const navigationEntriesBeforeSelection = await page.evaluate(() => (
        performance.getEntriesByType("navigation").length
      ));
      const documentLoadsBeforeSelection = await page.evaluate(() => Number(
        sessionStorage.getItem("intentarc.e2e.mapDocumentLoads"),
      ));
      const mainFrameNavigationsBeforeSelection = mainFrameNavigationCount;
      await recordButton(page, deepSubtask, "Subtask").click();
      await expectRouteState(page, deepSubtask.id, null);
      await expect(recordItem(page, deepSubtask.id)).toHaveAttribute("aria-selected", "true");
      const immediateInspector = page.getByRole("complementary", {
        name: "Selected item details",
      });
      await expect(immediateInspector).toBeVisible();
      await expect(immediateInspector).toHaveAttribute("aria-busy", "true");
      expect(mapRequestCount).toBe(mapRequestsBeforeSelection);
      expect(detailRequestCount).toBe(1);
      expect(await page.evaluate(() => performance.getEntriesByType("navigation").length))
        .toBe(navigationEntriesBeforeSelection);
      expect(await page.evaluate(() => Number(
        sessionStorage.getItem("intentarc.e2e.mapDocumentLoads"),
      ))).toBe(documentLoadsBeforeSelection);
      expect(mainFrameNavigationCount).toBe(mainFrameNavigationsBeforeSelection);
      expect(Math.abs(
        (await cameraBeforeSelection.boundingBox())!.width - canvasWidthBeforeSelection,
      )).toBeLessThanOrEqual(1);
      expect(await page.locator("[role='treeitem'][data-record-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-record-id"))))
        .toEqual(renderedIdsBeforeSelection);
      releaseDetail();
      await expect(immediateInspector).toHaveAttribute("aria-busy", "false");
      await assertSelectedPath(page, deepSubtask.title, 4, deepSubtask.id);
      await assertSelectedInspectorLayout(page, viewport.width);
      await assertDeepAncestry(page);
      await expectRouteState(page, deepSubtask.id, null);
      for (const record of deepPath.slice(0, -1)) {
        await expect(recordItem(page, record.id)).toBeVisible();
      }
      await expect(recordItem(page, alternateBranch[0]!.id)).toBeVisible();
      await expect(recordButton(page, {
        title: projectMapAdversarialFixture.secondOutcome.title,
      }, "Product outcome")).toBeVisible();

      await revealPath(page, alternateBranch);
      await expect(recordButton(page, alternateTask, "Story or Task")).toBeVisible();
      await recordItem(page, alternateBranch[1]!.id).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(recordButton(page, alternateTask, "Story or Task")).toBeHidden();
      await page.keyboard.press("ArrowRight");
      await expect(recordButton(page, alternateTask, "Story or Task")).toBeVisible();

      await projectItem.focus();
      await page.keyboard.press("End");
      await expect(recordItem(page, deepSubtask.id)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(recordItem(page, deepTask.id)).toBeFocused();
      await page.keyboard.press("Enter");
      await expectRouteState(page, deepTask.id, null);
      await expect(recordItem(page, deepTask.id)).toHaveAttribute("aria-current", "true");
      await expect(recordItem(page, deepTask.id)).toBeFocused();
      const focusDeepTask = page.getByRole("complementary", {
        name: "Selected item details",
      }).getByRole("button", { name: "Focus branch" });
      await assertFullyUsableInspectorControl(focusDeepTask);
      await focusDeepTask.click();
      await expectRouteState(page, deepTask.id, deepTask.id);
      await assertFocusedScope(page, deepTask.id);
      await expect(recordButton(page, {
        title: projectMapAdversarialFixture.secondOutcome.title,
      }, "Product outcome")).toBeHidden();
      await recordItem(page, deepTask.id).focus();
      await page.keyboard.press("ArrowRight");
      await expect(recordItem(page, deepSubtask.id)).toBeFocused();
      await page.keyboard.press("Enter");
      await expectRouteState(page, deepSubtask.id, deepTask.id);
      await expect(recordItem(page, deepSubtask.id)).toHaveAttribute("aria-current", "true");
      await expect(recordItem(page, deepSubtask.id)).toBeFocused();
      await assertSelectedPath(page, deepSubtask.title, 4, deepSubtask.id);
      await assertFocusedScope(page, deepSubtask.id);

      const showWholeProject = page.getByRole("button", { name: "Show whole project" });
      await showWholeProject.click();
      await expectRouteState(page, deepSubtask.id, null);
      await expect(page.locator(".project-hierarchy__scope-context"))
        .toContainText("Whole Project");
      await expect(recordButton(page, {
        title: projectMapAdversarialFixture.secondOutcome.title,
      }, "Product outcome")).toBeVisible();

      for (const record of deepPath) {
        await expect(recordItem(page, record.id)).toBeVisible();
      }

      if (viewport.width < 760) {
        await page.getByRole("button", { name: "Close details" }).click();
        await expectRouteState(page, null, null);
      }
      await recordButton(page, deepTask, "Story or Task").click();
      await expectRouteState(page, deepTask.id, null);
      const directLinks = page.getByRole("region", { name: "Direct cross-links" });
      const dependency = directLinks.locator(
        `[data-relationship-id="${projectMapAdversarialFixture.dependencyRelationshipId}"]`,
      );
      await expect(dependency).toContainText(
        `${alternateTask.title} — depends on — ${deepTask.title}`,
      );
      const connector = page.locator(
        `path[data-connector-id="${projectMapAdversarialFixture.dependencyRelationshipId}"]`,
      );
      await expect(connector).toHaveAttribute("d", /\S/);
      if (viewportName === "wide") {
        for (const targetPercent of [50, 100, 150] as const) {
          await setToolbarScale(page, targetPercent);
          await assertConnectorPaint(
            page.locator("path[data-connector-style='primary']").first(),
            {
              dashArray: [],
              stroke: theme === "light" ? "rgb(143, 136, 123)" : "rgb(116, 128, 120)",
              strokeWidth: 1.75,
            },
          );
          await assertConnectorPaint(connector, {
            dashArray: [6, 6],
            stroke: theme === "light" ? "rgb(104, 112, 105)" : "rgb(174, 183, 177)",
            strokeWidth: 1.5,
          });
          await assertMinimumTargetSize(recordItem(page, deepTask.id), 24);
          await assertMinimumTargetSize(recordItem(page, deepPath[0]!.id).getByRole("button", {
            name: `Collapse ${deepPath[0]!.title}`,
          }), 24);
        }
      } else {
        await assertConnectorPaint(connector, {
          dashArray: [6, 6],
          stroke: theme === "light" ? "rgb(104, 112, 105)" : "rgb(174, 183, 177)",
          strokeWidth: 1.5,
        });
      }
      await assertConnectorIntersectsCards(page);
      await dependency.getByRole("button", {
        name: `Select related ${alternateTask.title}`,
      }).click();
      await expectRouteState(page, alternateTask.id, null);
      await page.goBack();
      await expectRouteState(page, deepTask.id, null);
      await page.goForward();
      await expectRouteState(page, alternateTask.id, null);

      await page.goBack();
      await expectRouteState(page, deepTask.id, null);
      if (viewport.width < 760) {
        await page.getByRole("button", { name: "Close details" }).click();
        await expectRouteState(page, null, null);
      }
      await recordButton(page, deepSubtask, "Subtask").click();
      const evidence = page.getByRole("region", { name: "Direct cross-links" }).locator(
        `[data-relationship-id="${adversarialRelationshipId}"]`,
      );
      await expect(evidence).toContainText(
        `evidenced by · ${adversarialEvidenceTitle} · Accepted`,
      );
      const selectedDetails = page.getByRole("complementary", { name: "Selected item details" });
      const showEvidence = selectedDetails.getByRole("button", {
        name: `Show related ${adversarialEvidenceTitle}`,
        exact: true,
      });
      await assertFullyUsableInspectorControl(showEvidence);
      await showEvidence.click();
      const relatedEvidence = selectedDetails.getByRole("group", {
        name: `Related item ${adversarialEvidenceTitle}`,
      });
      await expect(relatedEvidence).toBeVisible();
      const hideEvidence = selectedDetails.getByRole("button", {
        name: `Hide related ${adversarialEvidenceTitle}`,
        exact: true,
      });
      await expect(hideEvidence).toBeVisible();
      await hideEvidence.click();
      await expect(relatedEvidence).toHaveCount(0);
      const acceptedAttachments = selectedDetails.getByRole("region", { name: "Accepted attachments" });
      await expect(acceptedAttachments.getByRole("listitem")).toHaveCount(1);
      const attachment = acceptedAttachments.getByRole("listitem")
        .filter({ hasText: "README.md" });
      await expect(attachment).toContainText("Accepted basis · Documents");
      const documentationAction = attachment.getByRole("link", { name: "Documentation" });
      const repositoryAction = attachment.getByRole("link", { name: "Repository" });
      const documentationHref = await documentationAction.getAttribute("href");
      const repositoryHref = await repositoryAction.getAttribute("href");
      expect(documentationHref).toMatch(new RegExp(
        `^/projects/${encodeURIComponent(adversarialProject.id)}/documentation/[^/?]+$`,
      ));
      expect(repositoryHref).toMatch(new RegExp(
        `^/projects/${encodeURIComponent(adversarialProject.id)}/repository\\?nodeId=[^&]+$`,
      ));
      const documentationNodeId = decodeURIComponent(documentationHref!.split("/").at(-1)!);
      expect(new URL(repositoryHref!, "http://127.0.0.1:47862").searchParams.get("nodeId"))
        .toBe(documentationNodeId);

      const mainFrameNavigationsBeforeAttachments = mainFrameNavigationCount;
      const documentLoadsBeforeAttachments = await page.evaluate(() => Number(
        sessionStorage.getItem("intentarc.e2e.mapDocumentLoads"),
      ));
      await documentationAction.click();
      await expect(page).toHaveURL(`http://127.0.0.1:47862${documentationHref}`);
      expect(mainFrameNavigationCount).toBe(mainFrameNavigationsBeforeAttachments);
      expect(await page.evaluate(() => Number(
        sessionStorage.getItem("intentarc.e2e.mapDocumentLoads"),
      ))).toBe(documentLoadsBeforeAttachments);
      await expect(page.getByRole("heading", { name: "Documentation", level: 1 }))
        .toBeVisible();
      await expect(page.getByText(projectMapAdversarialFixture.acceptedAttachment.body))
        .toBeVisible();
      await page.goBack();
      await expectRouteState(page, deepSubtask.id, null);
      await page.getByRole("region", { name: "Accepted attachments" })
        .getByRole("listitem").filter({ hasText: "README.md" })
        .getByRole("link", { name: "Repository" }).click();
      await expect(page).toHaveURL(`http://127.0.0.1:47862${repositoryHref}`);
      expect(mainFrameNavigationCount).toBe(mainFrameNavigationsBeforeAttachments);
      expect(await page.evaluate(() => Number(
        sessionStorage.getItem("intentarc.e2e.mapDocumentLoads"),
      ))).toBe(documentLoadsBeforeAttachments);
      await expect(page.getByRole("heading", { name: "Repository Explorer", level: 1 }))
        .toBeVisible();
      await expect(page.getByRole("tree", { name: "Repository files" })
        .getByRole("treeitem", { name: /README\.md/ })).toHaveAttribute("aria-selected", "true");
      await page.goBack();
      await expectRouteState(page, deepSubtask.id, null);
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      expect(remoteRequests).toEqual([]);
    });
  }
}

test("keeps the Task 7 inspector overlaid and bounded without moving the camera", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(deepSubtask.id)}`,
  );

  const camera = page.locator(".project-map-camera__viewport");
  await expect(camera).toBeVisible();
  await page.getByRole("complementary", { name: "Selected item details" })
    .getByRole("button", { name: "Focus branch" }).click();
  await expectRouteState(page, deepSubtask.id, deepSubtask.id);
  await page.getByRole("button", { name: "Close details" }).click();
  await expectRouteState(page, null, deepSubtask.id);
  await page.setViewportSize({ width: 760, height: 1000 });

  const fit = page.getByRole("button", { name: "Fit branch" });
  if (await fit.isEnabled()) await fit.click();
  await expect(camera).toHaveAttribute("data-camera-pannable", "true");
  const beforeSelection = await page.evaluate(() => {
    const cameraElement = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const shell = document.querySelector<HTMLElement>(".project-map__canvas-shell")!;
    const cameraBounds = cameraElement.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return {
      cameraHeight: cameraBounds.height,
      cameraTopInShell: cameraBounds.top - shellBounds.top,
      cameraWidth: cameraBounds.width,
      shellHeight: shellBounds.height,
    };
  });

  const selected = deepSubtask;
  await recordItem(page, selected.id).click();
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-layout", "wide");
  await expect(inspector.getByRole("heading", { name: selected.title, level: 2 })).toBeVisible();
  await expect(camera).toHaveAttribute("data-camera-pannable", "true");

  const wideGeometry = await page.evaluate(() => {
    const cameraElement = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const inspectorElement = document.querySelector<HTMLElement>(".project-map-inspector")!;
    const cameraBounds = cameraElement.getBoundingClientRect();
    const inspectorBounds = inspectorElement.getBoundingClientRect();
    return {
      camera: {
        height: cameraBounds.height,
        top: cameraBounds.top,
        topInShell: cameraBounds.top - document.querySelector<HTMLElement>(
          ".project-map__canvas-shell",
        )!.getBoundingClientRect().top,
        width: cameraBounds.width,
      },
      inspector: {
        position: getComputedStyle(inspectorElement).position,
        top: inspectorBounds.top,
        width: inspectorBounds.width,
      },
      shellHeight: document.querySelector<HTMLElement>(
        ".project-map__canvas-shell",
      )!.getBoundingClientRect().height,
    };
  });
  expect(Math.abs(wideGeometry.camera.width - beforeSelection.cameraWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(wideGeometry.camera.height - beforeSelection.cameraHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(wideGeometry.camera.topInShell - beforeSelection.cameraTopInShell))
    .toBeLessThanOrEqual(1);
  expect(Math.abs(wideGeometry.shellHeight - beforeSelection.shellHeight)).toBeLessThanOrEqual(1);
  expect(wideGeometry.inspector.position).toBe("absolute");
  expect(Math.abs(wideGeometry.inspector.width - 360)).toBeLessThanOrEqual(1);
  expect(Math.abs(wideGeometry.inspector.top - wideGeometry.camera.top - 12)).toBeLessThanOrEqual(1);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  await inspector.getByRole("button", { name: "Close details" }).click();
  await expectRouteState(page, null, selected.id);
  await page.setViewportSize({ width: 390, height: 600 });
  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  await expect(closeNavigation).toBeHidden();
  await recordItem(page, selected.id).focus();
  await page.keyboard.press("Enter");
  await expectRouteState(page, selected.id, selected.id);
  await expect(inspector).toHaveAttribute("data-layout", "narrow");
  const expanded = await page.evaluate(() => {
    const cameraElement = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const inspectorElement = document.querySelector<HTMLElement>(".project-map-inspector")!;
    const header = inspectorElement.querySelector<HTMLElement>(".project-map-inspector__header")!;
    const body = inspectorElement.querySelector<HTMLElement>(".project-map-inspector__body")!;
    const cameraBounds = cameraElement.getBoundingClientRect();
    const inspectorBounds = inspectorElement.getBoundingClientRect();
    const overlap = Math.max(0, cameraBounds.bottom - Math.max(cameraBounds.top, inspectorBounds.top));
    return {
      bodyClientHeight: body.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyScrollHeight: body.scrollHeight,
      cameraHeight: cameraBounds.height,
      headerPosition: getComputedStyle(header).position,
      headerTop: header.getBoundingClientRect().top,
      inspectorHeight: inspectorBounds.height,
      unobscured: cameraBounds.height - overlap,
    };
  });
  expect(Math.abs(expanded.cameraHeight - 420)).toBeLessThanOrEqual(1);
  expect(expanded.inspectorHeight).toBeLessThanOrEqual(252 + 1);
  expect(expanded.unobscured).toBeGreaterThanOrEqual(expanded.cameraHeight * 0.4 - 1);
  expect(expanded.bodyOverflowY).toBe("auto");
  expect(expanded.bodyScrollHeight).toBeGreaterThan(expanded.bodyClientHeight);
  expect(expanded.headerPosition).toBe("sticky");
  await inspector.locator(".project-map-inspector__body").evaluate((body) => {
    body.scrollTop = body.scrollHeight;
  });
  expect(await inspector.locator(".project-map-inspector__header").evaluate(
    (header) => header.getBoundingClientRect().top,
  )).toBe(expanded.headerTop);

  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.dataset.e2eInspectorScrollSpacer = "true";
    spacer.style.height = "1000px";
    document.body.append(spacer);
    window.scrollTo(0, 0);
  });
  const headingBounds = await page.getByRole("heading", { name: "Project map", level: 1 })
    .boundingBox();
  expect(headingBounds).not.toBeNull();
  await page.mouse.move(headingBounds!.x + 8, headingBounds!.y + 8);
  await page.mouse.wheel(0, 360);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.evaluate(() => {
    document.querySelector("[data-e2e-inspector-scroll-spacer]")?.remove();
    window.scrollTo(0, 0);
  });

  await inspector.getByRole("button", { name: "Close details" }).focus();
  for (let index = 0; index < 24; index += 1) {
    if (!await inspector.evaluate((element) => element.contains(document.activeElement))) break;
    await page.keyboard.press("Tab");
  }
  expect(await inspector.evaluate((element) => element.contains(document.activeElement))).toBe(false);

  await inspector.getByRole("button", { name: "Collapse details" }).focus();
  await page.keyboard.press("Escape");
  await expectRouteState(page, null, selected.id);
  await expect(inspector).toHaveCount(0);
  await expect(recordItem(page, selected.id)).toBeFocused();
  await expect(recordItem(page, selected.id)).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(inspector).toHaveAttribute("data-layout", "narrow");

  await inspector.getByRole("button", { name: "Collapse details" }).focus();
  await page.keyboard.press("Enter");
  await expect(inspector).toHaveAttribute("data-collapsed", "true");
  expect(Math.abs((await inspector.boundingBox())!.height - 56)).toBeLessThanOrEqual(1);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  await page.setViewportSize({ width: 760, height: 1000 });
  await page.getByRole("button", { name: "Show whole project" }).click();
  await expectRouteState(page, selected.id, null);
  await inspector.getByRole("button", { name: "Close details" }).focus();
  await page.keyboard.press("Enter");
  await expectRouteState(page, null, null);
  const zoomOutput = page.getByRole("status", { name: "Map zoom" });
  await expect(zoomOutput).toHaveText("50%");
  const overview = page.getByText("Overview limited to 50%", { exact: true });
  await expect(overview).toBeVisible();
  const overviewHit = await overview.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    return {
      ownsHit: element.contains(document.elementFromPoint(x, y)),
      pointerEvents: getComputedStyle(element).pointerEvents,
      x,
      y,
    };
  });
  expect(overviewHit.pointerEvents).toBe("none");
  expect(overviewHit.ownsHit).toBe(false);
  const moveMap = page.getByRole("button", { name: "Move map" });
  expect(await moveMap.evaluate(
    (element) => getComputedStyle(element).pointerEvents,
  )).toBe("auto");

  const instructionHit = await page.locator(".project-map-camera__instructions").evaluate((element) => {
    const panSurface = document.querySelector<HTMLElement>("[data-camera-pan-surface]")!;
    const bounds = element.getBoundingClientRect();
    for (let y = bounds.top + 2; y < bounds.bottom - 2; y += 3) {
      for (let x = bounds.left + 2; x < bounds.right - 2; x += 3) {
        if (document.elementFromPoint(x, y) === panSurface) {
          return { pointerEvents: getComputedStyle(element).pointerEvents, x, y };
        }
      }
    }
    return { pointerEvents: getComputedStyle(element).pointerEvents, x: null, y: null };
  });
  expect(instructionHit.pointerEvents).toBe("none");
  expect(instructionHit.x).not.toBeNull();
  expect(instructionHit.y).not.toBeNull();
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "false");
  const dragCandidates = [
    { deltaX: 36, deltaY: 0, name: "Pan left" },
    { deltaX: -36, deltaY: 0, name: "Pan right" },
    { deltaX: 0, deltaY: 24, name: "Pan up" },
    { deltaX: 0, deltaY: -24, name: "Pan down" },
  ] as const;
  await moveMap.click();
  const dragCandidate = (await Promise.all(dragCandidates.map(async (candidate) => ({
    ...candidate,
    enabled: await page.getByRole("button", { name: candidate.name }).isEnabled(),
  })))).find(({ enabled }) => enabled);
  expect(dragCandidate).toBeDefined();
  const beforeOverlayDrag = await cameraSnapshot(camera);
  await page.mouse.move(instructionHit.x!, instructionHit.y!);
  await page.mouse.down();
  await page.mouse.move(
    instructionHit.x! + dragCandidate!.deltaX,
    instructionHit.y! + dragCandidate!.deltaY,
  );
  await page.mouse.up();
  const afterOverlayDrag = await cameraSnapshot(camera);
  expect(Math.abs(afterOverlayDrag.x - beforeOverlayDrag.x) +
    Math.abs(afterOverlayDrag.y - beforeOverlayDrag.y)).toBeGreaterThan(0);
});

test("operates the bounded camera without stealing Map interactions", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  const camera = page.locator(".project-map-camera__viewport");
  const zoomOutput = page.getByRole("status", { name: "Map zoom" });
  await expect(camera).toBeVisible();
  await expect(zoomOutput).toHaveText(/\d+%/);

  for (const targetPercent of [50, 100, 150] as const) {
    await setToolbarScale(page, targetPercent);
    await expect(zoomOutput).toHaveText(`${targetPercent}%`);
    await assertConnectorEdges(
      primaryProjectConnector(page),
      `project:${adversarialProject.id}`,
      deepPath[0]!.id,
    );
  }
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  await setToolbarScale(page, 50);
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();

  await setToolbarScale(page, 100);
  const cameraBounds = await camera.boundingBox();
  expect(cameraBounds).not.toBeNull();
  const wheelAnchor = {
    clientX: cameraBounds!.x + cameraBounds!.width * 0.72,
    clientY: cameraBounds!.y + cameraBounds!.height * 0.68,
  };
  const beforeWheel = await cameraSnapshot(camera);
  const beforeWheelWorld = {
    x: (wheelAnchor.clientX - cameraBounds!.x - beforeWheel.x) / beforeWheel.scale,
    y: (wheelAnchor.clientY - cameraBounds!.y - beforeWheel.y) / beforeWheel.scale,
  };
  await page.mouse.move(wheelAnchor.clientX, wheelAnchor.clientY);
  const pageScrollBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, -100);
  const afterWheel = await settledCameraSnapshot(camera);
  expect(afterWheel.scale).toBeCloseTo(beforeWheel.scale + 0.1, 5);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBeforeWheel);
  expect(Math.abs(
    (wheelAnchor.clientX - cameraBounds!.x - afterWheel.x) / afterWheel.scale -
    beforeWheelWorld.x,
  )).toBeLessThan(0.5);
  expect(Math.abs(
    (wheelAnchor.clientY - cameraBounds!.y - afterWheel.y) / afterWheel.scale -
    beforeWheelWorld.y,
  )).toBeLessThan(0.5);

  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.dataset.e2eScrollSpacer = "true";
    spacer.style.height = "1200px";
    document.body.append(spacer);
    window.scrollTo(0, 0);
  });
  await setToolbarScale(page, 150);
  const atMaximum = await cameraSnapshot(camera);
  await page.mouse.move(
    cameraBounds!.x + cameraBounds!.width / 2,
    cameraBounds!.y + cameraBounds!.height / 2,
  );
  await page.mouse.wheel(0, -420);
  expect((await cameraSnapshot(camera)).scale).toBe(atMaximum.scale);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const heading = await page.getByRole("heading", { name: "Unplaced work", level: 2 }).boundingBox();
  expect(heading).not.toBeNull();
  const beforeOutsideWheel = await cameraSnapshot(camera);
  await page.mouse.move(heading!.x + 8, heading!.y + 8);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await cameraSnapshot(camera)).toEqual(beforeOutsideWheel);
  await page.evaluate(() => {
    document.querySelector("[data-e2e-scroll-spacer]")?.remove();
    window.scrollTo(0, 0);
  });

  await setToolbarScale(page, 100);
  const targetCard = recordItem(page, deepPath[0]!.id);
  const expandedBefore = await targetCard.getAttribute("aria-expanded");
  const routeBefore = new URL(page.url()).search;
  const beforeCardWheel = await cameraSnapshot(camera);
  await targetCard.hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, -100);
  expect((await settledCameraSnapshot(camera)).scale).toBeGreaterThan(beforeCardWheel.scale);
  expect(new URL(page.url()).search).toBe(routeBefore);
  expect(await targetCard.getAttribute("aria-expanded")).toBe(expandedBefore);

  await setToolbarScale(page, 150);
  const emptyPoint = await camera.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const blockingSelector = [
      "button", "a", "input", "select", "textarea", "summary",
      "[role='treeitem']", "[role='dialog']", "[contenteditable='true']",
      "[data-camera-interactive]",
    ].join(",");
    for (const yRatio of [0.9, 0.75, 0.55, 0.35]) {
      for (const xRatio of [0.95, 0.8, 0.65, 0.5, 0.35]) {
        const x = bounds.left + bounds.width * xRatio;
        const y = bounds.top + bounds.height * yRatio;
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(blockingSelector) === null) {
          return { x, y };
        }
      }
    }
    return null;
  });
  expect(emptyPoint).not.toBeNull();
  const panSurface = camera.locator("[data-camera-pan-surface]");
  await expect(panSurface).toHaveCSS("cursor", "grab");
  const beforeDrag = await cameraSnapshot(camera);
  await page.mouse.move(emptyPoint!.x, emptyPoint!.y);
  await page.mouse.down();
  await page.mouse.move(emptyPoint!.x + 90, emptyPoint!.y + 35, { steps: 5 });
  await expect(camera).toHaveAttribute("data-camera-dragging", "true");
  await expect(panSurface).toHaveCSS("cursor", "grabbing");
  await page.mouse.up();
  await expect(camera).toHaveAttribute("data-camera-dragging", "false");
  await expect(panSurface).toHaveCSS("cursor", "grab");
  const afterDrag = await cameraSnapshot(camera);
  expect(Math.abs(afterDrag.x - beforeDrag.x) + Math.abs(afterDrag.y - beforeDrag.y))
    .toBeGreaterThan(0);

  const gestureFitProject = page.getByRole("button", { name: "Fit project" });
  if (await gestureFitProject.isEnabled()) await gestureFitProject.click();

  const visibleCardPoint = async () => camera.evaluate((node) => {
    const viewport = node.getBoundingClientRect();
    const blocked = "button:not([data-expansion-control]),a,input,select,textarea,summary,[role='dialog'],[contenteditable='true'],[data-camera-interactive-control]";
    for (const card of node.querySelectorAll<HTMLElement>("[role='treeitem']")) {
      const bounds = card.getBoundingClientRect();
      const left = Math.max(viewport.left, bounds.left) + 4;
      const right = Math.min(viewport.right, bounds.right) - 4;
      const top = Math.max(viewport.top, bounds.top) + 4;
      const bottom = Math.min(viewport.bottom, bounds.bottom) - 4;
      if (left >= right || top >= bottom) continue;
      for (const yRatio of [0.2, 0.4, 0.6, 0.8]) {
        for (const xRatio of [0.5, 0.25, 0.75]) {
          const x = left + (right - left) * xRatio;
          const y = top + (bottom - top) * yRatio;
          const hit = document.elementFromPoint(x, y);
          if (hit !== null && card.contains(hit) && hit.closest(blocked) === null) {
            return { x, y };
          }
        }
      }
    }
    return null;
  });
  const ownedDragDelta = async (): Promise<{ dx: number; dy: number }> => {
    const directions = await openMoveMapDirections(page);
    if (await directions.getByRole("button", { name: "Pan right" }).isEnabled()) {
      return { dx: -72, dy: 0 };
    }
    if (await directions.getByRole("button", { name: "Pan left" }).isEnabled()) {
      return { dx: 72, dy: 0 };
    }
    if (await directions.getByRole("button", { name: "Pan down" }).isEnabled()) {
      return { dx: 0, dy: -72 };
    }
    return { dx: 0, dy: 72 };
  };

  const spacePoint = await visibleCardPoint();
  expect(spacePoint).not.toBeNull();
  await camera.focus();
  await page.keyboard.down("Space");
  await expect(camera).toHaveAttribute("data-camera-space-pan-armed", "true");
  const beforeSpaceDrag = await settledCameraSnapshot(camera);
  const spaceDelta = await ownedDragDelta();
  await camera.focus();
  await page.mouse.move(spacePoint!.x, spacePoint!.y);
  await page.mouse.down();
  await page.mouse.move(
    spacePoint!.x + spaceDelta.dx,
    spacePoint!.y + spaceDelta.dy,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.keyboard.up("Space");
  const afterSpaceDrag = await cameraSnapshot(camera);
  expect(Math.abs(afterSpaceDrag.x - beforeSpaceDrag.x) +
    Math.abs(afterSpaceDrag.y - beforeSpaceDrag.y)).toBeGreaterThan(0);
  await expectRouteState(page, null, null);
  await expect(camera).toBeFocused();
  await expect(camera).toHaveAttribute("data-camera-space-pan-armed", "false");

  await page.evaluate(() => {
    const state = [] as Array<{ defaultPrevented: boolean; targetRecordId: string | null }>;
    (window as typeof window & { __mapAuxClicks: typeof state }).__mapAuxClicks = state;
    window.addEventListener("auxclick", (event) => {
      setTimeout(() => state.push({
        defaultPrevented: event.defaultPrevented,
        targetRecordId: event.target instanceof Element
          ? event.target.closest("[data-record-id]")?.getAttribute("data-record-id") ?? null
          : null,
      }), 0);
    }, true);
  });
  const middlePoint = await visibleCardPoint();
  expect(middlePoint).not.toBeNull();
  const beforeMiddleDrag = await settledCameraSnapshot(camera);
  const middleDelta = { dx: -spaceDelta.dx, dy: -spaceDelta.dy };
  await page.mouse.move(middlePoint!.x, middlePoint!.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(
    middlePoint!.x + middleDelta.dx,
    middlePoint!.y + middleDelta.dy,
    { steps: 5 },
  );
  await expect(camera).toHaveAttribute("data-camera-dragging", "true");
  const duringMiddleDrag = await cameraSnapshot(camera);
  expect(Math.abs(duringMiddleDrag.x - beforeMiddleDrag.x) +
    Math.abs(duringMiddleDrag.y - beforeMiddleDrag.y)).toBeGreaterThan(0);
  await page.mouse.up({ button: "middle" });
  const afterMiddleDrag = await cameraSnapshot(camera);
  expect(Math.abs(afterMiddleDrag.x - beforeMiddleDrag.x) +
    Math.abs(afterMiddleDrag.y - beforeMiddleDrag.y)).toBeGreaterThan(0);
  await expectRouteState(page, null, null);
  await expect(camera).toBeFocused();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & {
      __mapAuxClicks: Array<{ defaultPrevented: boolean; targetRecordId: string | null }>;
    }).__mapAuxClicks
  ))).toEqual([expect.objectContaining({ defaultPrevented: true })]);

  const fitProject = page.getByRole("button", { name: "Fit project" });
  if (await fitProject.isEnabled()) await fitProject.click();
  await expect(page.locator("[data-camera-world]")).toHaveAttribute(
    "data-camera-fit-transition",
    "false",
  );
  const visibleRecordId = deepPath[0]!.id;
  const visibleRecordButton = page.locator(
    `[role="treeitem"][data-record-id="${visibleRecordId}"]`,
  );
  await expect(visibleRecordButton).toBeInViewport();
  const renderedIdsBeforeSelection = await page.locator(
    "[role='treeitem'][data-record-id]",
  ).evaluateAll((items) => items.map((item) => item.getAttribute("data-record-id")));
  const beforeSelection = await cameraSnapshot(camera);
  await visibleRecordButton.click();
  await expectRouteState(page, visibleRecordId, null);
  await expect(page.getByRole("complementary", { name: "Selected item details" })).toBeVisible();
  await expect(page.locator("[data-camera-world]")).toHaveAttribute(
    "data-camera-fit-transition",
    "false",
  );
  const afterSelection = await settledCameraSnapshot(camera);
  const renderedIdsAfterSelection = await page.locator(
    "[role='treeitem'][data-record-id]",
  ).evaluateAll((items) => items.map((item) => item.getAttribute("data-record-id")));
  expect(renderedIdsAfterSelection).toEqual(renderedIdsBeforeSelection);
  // 0.1 world unit is at most 0.15 rendered pixel at the 150% zoom clamp.
  const cameraCenterTolerance = 0.1;
  expect(Math.max(
    Math.abs(afterSelection.centerWorldX - beforeSelection.centerWorldX),
    Math.abs(afterSelection.centerWorldY - beforeSelection.centerWorldY),
  )).toBeLessThanOrEqual(cameraCenterTolerance);
  expect(afterSelection.scale).toBe(beforeSelection.scale);
  for (const blockedKey of ["+", "-", "F", "ArrowRight"] as const) {
    const beforeBlockedKey = await cameraSnapshot(camera);
    await visibleRecordButton.focus();
    await page.keyboard.press(blockedKey);
    expect(await cameraSnapshot(camera)).toEqual(beforeBlockedKey);
  }

  await setToolbarScale(page, 100);
  await camera.focus();
  await page.keyboard.press("-");
  await expect(zoomOutput).toHaveText("90%");
  await page.keyboard.press("+");
  await expect(zoomOutput).toHaveText("100%");
  const arrowDirections = await openMoveMapDirections(page);
  const arrowPan = await Promise.all([
    ["left", "ArrowLeft", "x"],
    ["right", "ArrowRight", "x"],
    ["up", "ArrowUp", "y"],
    ["down", "ArrowDown", "y"],
  ].map(async ([direction, key, axis]) => ({
    axis,
    enabled: await arrowDirections.getByRole("button", { name: `Pan ${direction}` }).isEnabled(),
    key,
  }))).then((candidates) => candidates.find((candidate) => candidate.enabled));
  expect(arrowPan).toBeDefined();
  await camera.focus();
  const beforeArrow = await cameraSnapshot(camera);
  await page.keyboard.press(arrowPan!.key);
  const afterArrow = await cameraSnapshot(camera);
  expect(afterArrow[arrowPan!.axis as "x" | "y"])
    .not.toBe(beforeArrow[arrowPan!.axis as "x" | "y"]);
  await page.keyboard.press("F");
  await expect.poll(async () => (await cameraSnapshot(camera)).scale)
    .not.toBe(afterArrow.scale);

  await breadcrumb(page).getByRole("link", {
    name: `Project: ${adversarialProject.name}`,
    exact: true,
  }).click();
  await expectRouteState(page, null, null);

  const hierarchyTree = page.getByRole("tree", {
    name: `${adversarialProject.name} hierarchy tree`,
  });
  const beforeCollapseCamera = await cameraSnapshot(camera);
  const beforeCollapseLayoutRevision = await hierarchyTree.getAttribute("data-layout-revision");
  await page.getByRole("button", {
    name: `Collapse ${deepPath[0]!.title}`,
    exact: true,
  }).click();
  await expect.poll(() => hierarchyTree.getAttribute("data-layout-revision"))
    .not.toBe(beforeCollapseLayoutRevision);
  const collapsedCamera = await settledCameraSnapshot(camera);
  expect(collapsedCamera.scale).toBe(beforeCollapseCamera.scale);
  await expect(camera).toHaveAttribute("data-camera-pannable", "true");
  const [collapsedCameraBounds, collapsedProjectBounds] = await Promise.all([
    camera.boundingBox(),
    hierarchyTree.locator(`[data-project-id="${adversarialProject.id}"]`).boundingBox(),
  ]);
  expect(collapsedCameraBounds).not.toBeNull();
  expect(collapsedProjectBounds).not.toBeNull();
  expect(Math.abs(
    collapsedCameraBounds!.x + collapsedCameraBounds!.width / 2 -
    (collapsedProjectBounds!.x + collapsedProjectBounds!.width / 2),
  )).toBeLessThanOrEqual(96);
  expect(Math.abs(
    collapsedProjectBounds!.y - collapsedCameraBounds!.y - 32,
  )).toBeLessThanOrEqual(96);
  const beforeExpandLayoutRevision = await hierarchyTree.getAttribute("data-layout-revision");
  await page.getByRole("button", {
    name: `Expand ${deepPath[0]!.title}`,
    exact: true,
  }).click();
  await expect.poll(() => hierarchyTree.getAttribute("data-layout-revision"))
    .not.toBe(beforeExpandLayoutRevision);
  const expandedCamera = await settledCameraSnapshot(camera);
  expect(expandedCamera.scale).toBe(collapsedCamera.scale);
  const expandedProjectBounds = await hierarchyTree
    .locator(`[data-project-id="${adversarialProject.id}"]`).boundingBox();
  expect(expandedProjectBounds).not.toBeNull();
  expect(Math.abs(expandedProjectBounds!.x - collapsedProjectBounds!.x))
    .toBeLessThanOrEqual(96);
  expect(Math.abs(expandedProjectBounds!.y - collapsedProjectBounds!.y))
    .toBeLessThanOrEqual(96);

  await revealPath(page, deepPath);
  await recordButton(page, deepTask, "Story or Task").click();
  const beforeFocusScale = (await cameraSnapshot(camera)).scale;
  await page.getByRole("button", {
    name: "Focus branch",
  }).click();
  await expectRouteState(page, deepTask.id, deepTask.id);
  expect((await cameraSnapshot(camera)).scale).toBe(beforeFocusScale);

  await setToolbarScale(page, 150);
  const fitRequestBeforeWhole = Number(await camera.getAttribute("data-camera-fit-request-key"));
  await page.getByRole("button", { name: "Show whole project" }).click();
  await expectRouteState(page, deepTask.id, null);
  await expect.poll(async () => Number(
    await camera.getAttribute("data-camera-fit-request-key"),
  )).toBe(fitRequestBeforeWhole + 1);
  await expect.poll(async () => (await cameraSnapshot(camera)).scale).not.toBe(1.5);

  await setToolbarScale(page, 150);
  const beforeResize = await settledCameraSnapshot(camera);
  await page.setViewportSize({ width: 1366, height: 768 });
  const afterResize = await settledCameraSnapshot(camera);
  expect(afterResize.scale).toBe(beforeResize.scale);

  await revealPath(page, deepPath);
  await revealPath(page, alternateBranch);
  await recordButton(page, deepTask, "Story or Task").click();
  const directLinks = page.getByRole("region", { name: "Direct cross-links" });
  const dependency = directLinks.locator(
    `[data-relationship-id="${projectMapAdversarialFixture.dependencyRelationshipId}"]`,
  );
  await expect(dependency).toContainText(
    `${alternateTask.title} — depends on — ${deepTask.title}`,
  );
  const crossPath = page.locator(
    `path[data-connector-id="${projectMapAdversarialFixture.dependencyRelationshipId}"]`,
  );
  await expect(crossPath).toHaveCount(1);
  await assertConnectorPaint(crossPath, {
    dashArray: [6, 6],
    strokeWidth: 1.5,
  });
  await page.getByRole("button", { name: "Cross-links" }).click();
  await expect(crossPath).toHaveCount(0);
  await expect(page.locator("path[data-connector-style='primary']").first()).toHaveCount(1);
  await expect(dependency).toContainText(
    `${alternateTask.title} — depends on — ${deepTask.title}`,
  );
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
});

test("honors Chromium reduced-motion preference for camera fitting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  const world = page.locator("[data-camera-world]");
  await expect(world).toHaveCSS("transition-duration", "0s");
  await setToolbarScale(page, 150);
  await page.getByRole("button", { name: "Fit project" }).click();
  await expect(world).toHaveAttribute("data-camera-fit-transition", "false");
  await expect(world).toHaveCSS("transition-duration", "0s");
});

test("bounds missing relationship targets and reveals hidden, out-of-scope, and unplaced targets", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.route(`**/api/projects/${adversarialProject.id}/records/${deepTask.id}/connected-detail`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {
      relations: Array<{
        depth: number;
        edge: Record<string, unknown>;
        record: Record<string, unknown>;
      }>;
    };
    const template = payload.relations.find((relation) => (
      relation.depth === 1 && relation.edge.kind !== "parent_of" && relation.record.kind === "task"
    ));
    if (template === undefined) throw new Error("Missing hierarchy relationship template.");
    const missingTitle = "Missing verified Map target";
    payload.relations.push({
      ...template,
      edge: {
        ...template.edge,
        id: "relationship-e2e-missing-target",
        toRecordId: "record-e2e-missing-target",
        toLabel: missingTitle,
      },
      record: {
        ...template.record,
        id: "record-e2e-missing-target",
        title: missingTitle,
      },
    });
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  await revealPath(page, deepPath);
  await expect(recordItem(page, alternateTask.id)).toBeHidden();
  await recordItem(page, deepTask.id).click();
  let inspector = page.getByRole("complementary", { name: "Selected item details" });
  await inspector.getByRole("button", { name: "Select related Missing verified Map target" }).click();
  await expect(inspector.getByRole("alert"))
    .toContainText("not present in the verified project map");
  await inspector.getByRole("button", { name: `Select related ${alternateTask.title}` }).click();
  await expectRouteState(page, alternateTask.id, null);
  await expect(recordItem(page, alternateTask.id)).toBeVisible();
  await expect(recordItem(page, alternateTask.id)).toHaveAttribute("aria-current", "true");

  await page.goBack();
  await expectRouteState(page, deepTask.id, null);
  inspector = page.getByRole("complementary", { name: "Selected item details" });
  await inspector.getByRole("button", { name: "Focus branch" }).click();
  await expectRouteState(page, deepTask.id, deepTask.id);
  await inspector.getByRole("button", { name: `Select related ${alternateTask.title}` }).click();
  await expectRouteState(page, alternateTask.id, null);
  await expect(recordItem(page, alternateTask.id)).toHaveAttribute("aria-current", "true");

  await page.goBack();
  await expectRouteState(page, deepTask.id, deepTask.id);
  await page.getByRole("button", { name: "Show whole project" }).click();
  await expectRouteState(page, deepTask.id, null);
  inspector = page.getByRole("complementary", { name: "Selected item details" });
  await inspector.getByRole("button", {
    name: `Select related ${projectMapAdversarialFixture.unplacedTask.title}`,
  }).click();
  await expectRouteState(page, projectMapAdversarialFixture.unplacedTask.id, null);
  const unplacedTarget = page.locator(
    `[data-unplaced-record-id="${projectMapAdversarialFixture.unplacedTask.id}"]`,
  );
  await expect(unplacedTarget).toBeVisible();
  await expect(unplacedTarget).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Unplaced work" })).toBeVisible();
});

test("keeps mobile card swipes native while empty canvas touch pans and pinches", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  const camera = page.locator(".project-map-camera__viewport");
  const panSurface = camera.locator("[data-camera-pan-surface]");
  const cardButton = camera.locator(
    "[role='treeitem']",
  ).first();
  await expect(camera).toBeVisible();
  await expect(panSurface).toBeVisible();
  await expect(camera).toHaveCSS("touch-action", "auto");
  await expect(panSurface).toHaveCSS("touch-action", "none");
  await expect(cardButton).toHaveCSS("touch-action", "pan-y");
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.dataset.e2eTouchScrollSpacer = "true";
    spacer.style.height = "1400px";
    document.body.append(spacer);
    document.querySelector(".project-map-camera__viewport")?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -32);
  });

  const cardPoint = await camera.evaluate((node) => {
    const viewportBounds = node.getBoundingClientRect();
    const buttons = Array.from(node.querySelectorAll<HTMLElement>("[role='treeitem']"));
    for (const button of buttons) {
      const bounds = button.getBoundingClientRect();
      const left = Math.max(viewportBounds.left, bounds.left, 0) + 3;
      const right = Math.min(viewportBounds.right, bounds.right, window.innerWidth) - 3;
      const top = Math.max(viewportBounds.top, bounds.top, 170) + 3;
      const bottom = Math.min(viewportBounds.bottom, bounds.bottom, window.innerHeight - 80) - 3;
      if (left >= right || top >= bottom) continue;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && button.contains(hit)) return { x, y };
    }
    return null;
  });
  expect(cardPoint).not.toBeNull();

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  const dispatchTouch = async (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: readonly { readonly id: number; readonly x: number; readonly y: number }[],
  ) => client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point) => ({
      id: point.id,
      radiusX: 2,
      radiusY: 2,
      x: point.x,
      y: point.y,
    })),
  });
  const waitForScrollToSettle = async () => page.evaluate(() => new Promise<void>((resolve) => {
    let prior = window.scrollY;
    let stableFrames = 0;
    const observe = () => {
      const current = window.scrollY;
      stableFrames = Math.abs(current - prior) < 0.1 ? stableFrames + 1 : 0;
      prior = current;
      if (stableFrames >= 6) resolve();
      else window.requestAnimationFrame(observe);
    };
    window.requestAnimationFrame(observe);
  }));

  const scrollBeforeCardSwipe = await page.evaluate(() => window.scrollY);
  const cameraBeforeCardSwipe = await cameraSnapshot(camera);
  await dispatchTouch("touchStart", [{ id: 1, x: cardPoint!.x, y: cardPoint!.y }]);
  for (const offset of [35, 70, 105, 140]) {
    await dispatchTouch("touchMove", [{
      id: 1,
      x: cardPoint!.x,
      y: cardPoint!.y - offset,
    }]);
  }
  await dispatchTouch("touchEnd", []);
  await expect.poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(scrollBeforeCardSwipe);
  await waitForScrollToSettle();
  expect(await cameraSnapshot(camera)).toEqual(cameraBeforeCardSwipe);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => {
    document.querySelector(".project-map-camera__viewport")?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -32);
  });
  await waitForScrollToSettle();
  await setToolbarScale(page, 150);
  const emptyGesture = await panSurface.evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    const interactiveBounds = Array.from(document.querySelectorAll<HTMLElement>([
      "button", "a", "input", "select", "textarea", "summary",
      "[role='treeitem']", "[role='dialog']", "[contenteditable='true']",
      "[data-camera-interactive]",
    ].join(","))).map((element) => element.getBoundingClientRect());
    const left = Math.max(bounds.left, 0) + 8;
    const right = Math.min(bounds.right, window.innerWidth) - 8;
    const top = Math.max(bounds.top, 0) + 8;
    const bottom = Math.min(bounds.bottom, window.innerHeight) - 8;
    let best: { readonly margin: number; readonly x: number; readonly y: number } | null = null;
    for (let y = top; y <= bottom; y += 10) {
      for (let x = left; x <= right; x += 10) {
        if (document.elementFromPoint(x, y) === surface) {
          const nearestInteractive = interactiveBounds.reduce((nearest, rect) => {
            const dx = Math.max(rect.left - x, 0, x - rect.right);
            const dy = Math.max(rect.top - y, 0, y - rect.bottom);
            return Math.min(nearest, Math.hypot(dx, dy));
          }, Number.POSITIVE_INFINITY);
          const margin = Math.min(
            x - left,
            right - x,
            y - top,
            bottom - y,
            nearestInteractive,
          );
          if (best === null || margin > best.margin) best = { margin, x, y };
        }
      }
    }
    return best === null ? null : { margin: best.margin, start: { x: best.x, y: best.y } };
  });
  expect(emptyGesture).not.toBeNull();
  expect(emptyGesture!.margin).toBeGreaterThanOrEqual(24);
  const directions = await openMoveMapDirections(page);
  const panDelta = {
    x: await directions.getByRole("button", { name: "Pan left" }).isEnabled() ? 42 : -42,
    y: await directions.getByRole("button", { name: "Pan up" }).isEnabled() ? 24 : -24,
  };
  await page.getByRole("button", { name: "Move map" }).click();
  const panSurfaceBounds = await panSurface.boundingBox();
  expect(panSurfaceBounds).not.toBeNull();
  const touchPanEnd = {
    x: Math.max(
      panSurfaceBounds!.x + 2,
      Math.min(panSurfaceBounds!.x + panSurfaceBounds!.width - 2, emptyGesture!.start.x + panDelta.x),
    ),
    y: Math.max(
      panSurfaceBounds!.y + 2,
      Math.min(panSurfaceBounds!.y + panSurfaceBounds!.height - 2, emptyGesture!.start.y + panDelta.y),
    ),
  };
  const scrollBeforeCanvasPan = await page.evaluate(() => window.scrollY);
  const cameraBeforePan = await cameraSnapshot(camera);
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.hasAttribute("data-camera-pan-surface") ?? false
  ), emptyGesture!.start)).toBe(true);
  await dispatchTouch("touchStart", [{ id: 2, ...emptyGesture!.start }]);
  for (const progress of [0.25, 0.5, 0.75, 1]) {
    await dispatchTouch("touchMove", [{
      id: 2,
      x: emptyGesture!.start.x + (touchPanEnd.x - emptyGesture!.start.x) * progress,
      y: emptyGesture!.start.y + (touchPanEnd.y - emptyGesture!.start.y) * progress,
    }]);
  }
  await expect.poll(async () => {
    const current = await cameraSnapshot(camera);
    return Math.abs(current.x - cameraBeforePan.x) + Math.abs(current.y - cameraBeforePan.y);
  }).toBeGreaterThan(0);
  await dispatchTouch("touchEnd", []);
  const cameraAfterPan = await cameraSnapshot(camera);
  expect(Math.abs(cameraAfterPan.x - cameraBeforePan.x) + Math.abs(cameraAfterPan.y - cameraBeforePan.y))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeCanvasPan);

  await setToolbarScale(page, 100);
  const pinchPoints = await panSurface.evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    const candidates: { x: number; y: number }[] = [];
    const left = Math.max(bounds.left, 0) + 8;
    const right = Math.min(bounds.right, window.innerWidth) - 8;
    const top = Math.max(bounds.top, 0) + 8;
    const bottom = Math.min(bounds.bottom, window.innerHeight) - 8;
    for (let y = top; y <= bottom; y += 12) {
      for (let x = left; x <= right; x += 12) {
        if (document.elementFromPoint(x, y) === surface) candidates.push({ x, y });
      }
    }
    for (const first of candidates) {
      for (const second of candidates) {
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 48) continue;
        const unitX = dx / distance;
        const unitY = dy / distance;
        const end = [
          { x: first.x - unitX * 24, y: first.y - unitY * 24 },
          { x: second.x + unitX * 24, y: second.y + unitY * 24 },
        ];
        if (end.every((point) => (
          point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
        ))) {
          return { end, start: [first, second] };
        }
      }
    }
    return null;
  });
  expect(pinchPoints).not.toBeNull();
  const scaleBeforePinch = (await cameraSnapshot(camera)).scale;
  await dispatchTouch("touchStart", pinchPoints!.start.map((point, index) => ({
    id: 3 + index,
    ...point,
  })));
  await dispatchTouch("touchMove", pinchPoints!.end.map((point, index) => ({
    id: 3 + index,
    ...point,
  })));
  await dispatchTouch("touchEnd", []);
  expect((await cameraSnapshot(camera)).scale).toBeGreaterThan(scaleBeforePinch);

  await client.detach();
  await page.evaluate(() => document.querySelector("[data-e2e-touch-scroll-spacer]")?.remove());
});

test("fits a one-card focused scope, allows fitted movement, and restores canonical Fit", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  await page.goto(`/projects/${encodeURIComponent(adversarialProject.id)}/map`);

  await revealPath(page, deepPath);
  await recordButton(page, deepSubtask, "Subtask").click();
  await page.getByRole("button", {
    name: "Focus branch",
  }).click();
  await expectRouteState(page, deepSubtask.id, deepSubtask.id);

  const camera = page.locator(".project-map-camera__viewport");
  const scopedCard = page.locator(
    `[data-connector-record-id="${deepSubtask.id}"]`,
  );
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Fit branch" }).click();
  await expect(page.getByRole("status", { name: "Map zoom" })).toHaveText("150%");
  await expect(scopedCard).toBeInViewport();

  await expect(page.locator("[data-camera-world]")).toHaveAttribute(
    "data-camera-fit-transition",
    "false",
  );
  await camera.focus();
  const fitted = await settledCameraSnapshot(camera);
  const canonicalPlacement = await page.evaluate((recordId) => {
    const viewport = document.querySelector<HTMLElement>(".project-map-camera__viewport")!;
    const inspector = document.querySelector<HTMLElement>(".project-map-inspector")!;
    const card = [...document.querySelectorAll<HTMLElement>("[data-connector-record-id]")]
      .find((element) => element.dataset.connectorRecordId === recordId)!;
    const viewportBounds = viewport.getBoundingClientRect();
    const inspectorBounds = inspector.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    const unobscuredRight = Math.min(viewportBounds.right, inspectorBounds.left);
    return {
      horizontalCenterError: Math.abs(
        cardBounds.left + cardBounds.width / 2
        - (viewportBounds.left + unobscuredRight) / 2,
      ),
      topOffset: cardBounds.top - viewportBounds.top - viewport.clientTop,
    };
  }, deepSubtask.id);
  expect(canonicalPlacement.horizontalCenterError).toBeLessThanOrEqual(1);
  expect(canonicalPlacement.topOffset).toBeCloseTo(32, 0);
  const directions = await openMoveMapDirections(page);
  const enabled = directions.locator("button:not([disabled])").first();
  const label = await enabled.getAttribute("aria-label");
  await enabled.click();
  expect(await cameraSnapshot(camera)).not.toEqual(fitted);
  await page.getByRole("button", { name: "Fit branch" }).click();
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "false");
  expect(await settledCameraSnapshot(camera), `Fit did not restore after ${label}`).toEqual(fitted);

  await page.getByRole("button", { name: "Show whole project" }).click();
  await expectRouteState(page, deepSubtask.id, null);
  const showWholePlacement = await settledCameraSnapshot(camera);
  const wholeDirections = await openMoveMapDirections(page);
  const wholePan = wholeDirections.locator("button:not([disabled])").first();
  const wholePanLabel = await wholePan.getAttribute("aria-label");
  await wholePan.click();
  expect(await cameraSnapshot(camera)).not.toEqual(showWholePlacement);
  await page.getByRole("button", { name: "Fit project" }).click();
  await expect(page.locator("[data-camera-world]"))
    .toHaveAttribute("data-camera-fit-transition", "false");
  const restoredWholePlacement = await settledCameraSnapshot(camera);
  expect(restoredWholePlacement.scale, `Fit scale after ${wholePanLabel}`)
    .toBe(showWholePlacement.scale);
  expect(Math.abs(restoredWholePlacement.x - showWholePlacement.x)).toBeLessThan(0.01);
  expect(Math.abs(restoredWholePlacement.y - showWholePlacement.y)).toBeLessThan(0.01);
  expect(Math.abs(
    restoredWholePlacement.centerWorldX - showWholePlacement.centerWorldX,
  )).toBeLessThan(0.01);
  expect(Math.abs(
    restoredWholePlacement.centerWorldY - showWholePlacement.centerWorldY,
  )).toBeLessThan(0.01);
});

test("contains adversarial Project Map identity, vocabulary, relationships, IDs, and actions at 390px", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ projectId }) => {
    localStorage.setItem("intentarc.activeProject", projectId);
    localStorage.setItem("intentarc.theme", "light");
  }, { projectId: adversarialProject.id });
  await exchangeSession(page);
  const selectedRecord = adversarialRecords.at(-1)!;
  await page.goto(
    `/projects/${encodeURIComponent(adversarialProject.id)}/map?focusRecordId=${encodeURIComponent(selectedRecord.id)}`,
  );

  const projectRoot = page.getByRole("treeitem", {
    name: `Project: ${adversarialProject.name} (${adversarialProject.id})`,
  });
  await expect(projectRoot).toHaveAttribute("data-project-id", adversarialProject.id);
  await expect(projectRoot.getByText(adversarialProject.id, { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Project vocabulary" }))
    .toHaveCount(0);
  for (const record of adversarialRecords) {
    await expect(recordItem(page, record.id)).toBeVisible();
    await expect(recordItem(page, record.id)).toHaveAccessibleName(
      `${record.label}: ${record.title}`,
    );
  }
  const path = breadcrumb(page);
  await expect(path.getByRole("link", {
    name: `Project: ${adversarialProject.name}`,
    exact: true,
  })).toBeVisible();
  for (const record of adversarialRecords.slice(0, -1)) {
    await expect(path.getByRole("button", { name: record.title, exact: true })).toBeVisible();
  }
  await expect(path.locator('[aria-current="page"]')).toHaveText(selectedRecord.title);
  await expect(path.getByRole("button", { name: selectedRecord.title, exact: true }))
    .toHaveCount(0);

  const selectedDetails = page.getByRole("complementary", { name: "Selected item details" });
  await expect(selectedDetails.getByRole("heading", {
    name: selectedRecord.title,
    level: 2,
  })).toBeVisible();
  await expect(selectedDetails.getByText(new RegExp(
    `^${projectMapAdversarialFixture.selectedBody.slice(0, 80)}`,
  ))).toBeVisible();
  const relationshipMetadata = selectedDetails.locator(
    `[data-relationship-id="${adversarialRelationshipId}"]`,
  );
  await expect(relationshipMetadata).toContainText(
    `evidenced by · ${adversarialEvidenceTitle} · Accepted`,
  );
  await expect(selectedDetails.getByRole("link", { name: "Open" })).toHaveCount(0);
  await expect(selectedDetails.getByRole("button", {
    name: /Edit hierarchy|Set parent|Remove parent|Place work/,
  })).toHaveCount(0);

  expect(await projectMapOverflowOffenders(page)).toEqual([]);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  const selectedNode = page.locator(
    `[role="treeitem"][data-record-id="${selectedRecord.id}"]`,
  );
  for (const target of [
    projectRoot.locator(".project-hierarchy__project-card"),
    path,
    selectedNode.locator(".project-map__record-line"),
    selectedDetails,
    relationshipMetadata,
  ]) {
    expect(await target.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);
  }
});

for (const { name: themeName, value: theme } of themes) {
  test(`contains the adversarial mobile node with record-14 selected in ${themeName}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(({ storedTheme }) => {
      localStorage.setItem("intentarc.activeProject", "project-2");
      localStorage.setItem("intentarc.theme", storedTheme);
    }, { storedTheme: theme });
    await exchangeSession(page);
    await page.goto("/projects/project-2/map?focusRecordId=record-14");

    const title = page.getByText(adversarialTitle, { exact: true });
    const recordLine = title.locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' project-map__record-line ')][1]",
    );
    const selectedDetails = page.getByRole("complementary", {
      name: "Selected item details",
    });
    await expect(title).toHaveText(adversarialTitle);
    await expect(recordLine.getByRole("button", { name: /Focus here:/ })).toHaveCount(0);
    await expect(selectedDetails.getByRole("button", { name: "Focus branch" })).toBeVisible();
    await expect(selectedDetails).toBeVisible();
    await expect(selectedDetails.getByRole("heading", {
      name: "Confirm authoritative subtask",
      level: 2,
    })).toBeVisible();

    const [cardBounds, titleBounds, detailBounds] = await Promise.all([
      recordLine.boundingBox(),
      title.boundingBox(),
      selectedDetails.boundingBox(),
    ]);
    expect(cardBounds).not.toBeNull();
    expect(titleBounds).not.toBeNull();
    expect(detailBounds).not.toBeNull();
    expect(titleBounds!.y).toBeGreaterThanOrEqual(cardBounds!.y);
    expect(titleBounds!.y + titleBounds!.height)
      .toBeLessThanOrEqual(cardBounds!.y + cardBounds!.height);
    const cameraBounds = await page.locator(".project-map-camera__viewport").boundingBox();
    expect(cameraBounds).not.toBeNull();
    expect(Math.abs(detailBounds!.x - cameraBounds!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(detailBounds!.width - cameraBounds!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(
      detailBounds!.y + detailBounds!.height -
      (cameraBounds!.y + cameraBounds!.height),
    )).toBeLessThanOrEqual(1);
    expect(cameraBounds!.height - detailBounds!.height)
      .toBeGreaterThanOrEqual(cameraBounds!.height * 0.4 - 1);
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  });
}
