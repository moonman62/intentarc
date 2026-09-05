import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { structuredKnowledgeAdversarialFixture } from "../test-support/e2e-fixture.js";

const CONTROL_ORIGIN = "http://127.0.0.1:47863";

const control = async (
  request: APIRequestContext,
  route: string,
): Promise<void> => {
  const response = await request.post(`${CONTROL_ORIGIN}${route}`, {
    headers: { "x-intentarc-e2e-control": "intentarc-e2e-control" },
  });
  expect(response.ok(), await response.text()).toBe(true);
};

const exchangeSession = async (page: Page): Promise<void> => {
  await page.goto("/?key=intentarc-e2e-session");
  await expect(page).toHaveURL("http://127.0.0.1:47862/");
};

const expectNoHorizontalOverflow = async (
  page: Page,
  selectors: readonly string[],
): Promise<void> => {
  await expect.poll(() => page.evaluate((boundedSelectors) => {
    if (document.documentElement.scrollWidth > window.innerWidth + 1) return false;
    return boundedSelectors.every((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element !== null && element.scrollWidth <= element.clientWidth + 1;
    });
  }, selectors)).toBe(true);
};

test("keeps the unfiltered mobile documentation registry contained while the selected preview remains reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await exchangeSession(page);
  await page.goto("/projects/project-2/documentation");

  const registry = page.locator(".documentation-list");
  const preview = page.getByRole("region", { name: "Document preview" });
  const readme = registry.getByRole("button", { name: /README\.md/ });
  await expect(registry.getByRole("button")).toHaveCount(99);
  await readme.click();

  await expect(page).toHaveURL(/\/projects\/project-2\/documentation\/[^/]+$/);
  await expect(readme).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("This is the accepted document body.")).toBeVisible();
  await expect(preview).toBeVisible();
  expect(await registry.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.scrollHeight > element.clientHeight &&
      ["auto", "scroll"].includes(style.overflowY);
  })).toBe(true);
  const previewBounds = await preview.boundingBox();
  const previewHeading = preview.getByRole("heading", { name: "Document preview" });
  const previewHeadingBounds = await previewHeading.boundingBox();
  expect(previewBounds).not.toBeNull();
  expect(previewBounds!.y).toBeLessThanOrEqual(844);
  expect(previewBounds!.y + previewBounds!.height).toBeGreaterThanOrEqual(0);
  expect(previewHeadingBounds).not.toBeNull();
  expect(previewHeadingBounds!.y).toBeGreaterThanOrEqual(0);
  expect(previewHeadingBounds!.y + previewHeadingBounds!.height).toBeLessThanOrEqual(828);

  const secondDocument = registry.getByRole("button").nth(1);
  const lastDocument = registry.getByRole("button").last();
  await readme.focus();
  await page.keyboard.press("ArrowDown");
  await expect(secondDocument).toBeFocused();
  await page.keyboard.press("End");
  await expect(lastDocument).toBeFocused();
  await expect.poll(() => registry.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await expectNoHorizontalOverflow(page, [
    ".documentation-surface",
    ".documentation-layout",
    ".documentation-registry",
    ".documentation-preview",
  ]);
});

test("structured knowledge stays reviewed across documentation, refresh, map, and explorer", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") remoteRequests.push(request.url());
  });

  await exchangeSession(page);
  await page.goto("/projects/project-2/documentation");
  await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
  const documentationSearch = page.getByRole("searchbox", { name: "Search documentation" });
  await expect(documentationSearch).toBeVisible();
  expect(await documentationSearch.evaluate((search) => Boolean(
    search.compareDocumentPosition(document.querySelector(".documentation-layout")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ))).toBe(true);
  await expect(page.getByRole("combobox", { name: "Role" })).toHaveCount(0);
  await documentationSearch.fill(structuredKnowledgeAdversarialFixture.documentPath);
  await page.getByRole("button", { name: /^adversarial-/ }).click();
  await expect(page.getByRole("heading", { name: "Bounded accepted document" })).toBeVisible();
  await expect(page.getByText(structuredKnowledgeAdversarialFixture.omittedContentTail))
    .toHaveCount(0);
  await expectNoHorizontalOverflow(page, [
    ".documentation-surface",
    ".documentation-layout",
    ".documentation-registry",
    ".documentation-preview",
  ]);
  await documentationSearch.fill("");
  await page.getByText("Advanced filters").click();
  await expect(page.getByRole("combobox", { name: "Role" })).toBeVisible();
  await page.getByRole("button", { name: /README\.md/ }).click();
  await expect(page.getByText("This is the accepted document body.")).toBeVisible();

  await control(request, "/prepare-document-change");
  await page.reload();
  await page.getByRole("button", { name: /README\.md/ }).click();
  await expect(page.getByText(/changed after the accepted refresh/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Document preview" })).toBeVisible();

  await page.getByRole("link", { name: "Review repository refresh" }).click();
  await expect(page.getByRole("heading", { name: "Repository refresh" })).toBeVisible();
  await page.getByRole("button", { name: "Scan repository" }).click();
  await expect(page.getByRole("heading", { name: "Scanning repository" })).toBeVisible();
  await expect(page.locator(".repository-refresh__progress").getByRole("status"))
    .toContainText(
    /Discovering|Hashing|Classifying|Finalizing/,
  );
  await page.getByRole("button", { name: "Cancel scan" }).click();
  await expect(page.getByRole("status")).toContainText("Scan cancelled");

  await control(request, "/restart");
  await exchangeSession(page);
  await page.goto("/projects/project-2/repository/refresh");
  await page.getByRole("button", { name: "Scan repository" }).click();
  await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Scan complete" }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Repository facts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposed project meaning" })).toBeVisible();
  await expect(page.getByText("No project meaning was inferred from this refresh."))
    .toBeVisible();
  await page.getByRole("button", { name: "Accept repository refresh" }).click();
  await expect(page.getByRole("heading", { name: "Refresh outcome" })).toBeVisible();

  await control(request, "/prepare-semantic-change");
  await page.reload();
  await page.getByRole("button", { name: "Scan repository" }).click();
  await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Scan complete" }))
    .toBeVisible();
  const proposal = page.getByRole("list", { name: "Semantic proposals" })
    .getByRole("checkbox");
  await expect(proposal).toHaveCount(1);
  await proposal.click();
  await expect(proposal).toBeChecked();
  await expect(page.getByRole("button", {
    name: "Accept refresh and create proposal",
  })).toBeVisible();

  await control(request, "/restart");
  await exchangeSession(page);
  await page.goto("/projects/project-2/repository/refresh");
  await expect(page.getByRole("heading", { name: "Repository facts" })).toBeVisible();
  await expect(page.getByText("Resumed pending review", { exact: true }))
    .toBeVisible();
  await expect(proposal).toBeChecked();
  await page.getByRole("button", {
    name: "Accept refresh and create proposal",
  }).click();
  await expect(page.getByRole("heading", { name: "Refresh outcome" })).toBeVisible();

  await page.getByRole("link", { name: "Proposals" }).click();
  await expect(page.getByRole("heading", { name: "Proposals" })).toBeVisible();
  await expect(page.getByText(
    "Repository test evidence: tests/release-evidence.md",
    { exact: true },
  )).toBeVisible();

  await page.getByRole("link", { name: "Map" }).click();
  await expect(page.getByRole("heading", { name: "Project map" })).toBeVisible();
  const hierarchy = page.getByRole("tree", {
    name: "Structured Knowledge Browser Fixture hierarchy tree",
  });
  await expect(hierarchy).toBeVisible();
  const mapViewport = page.locator(".project-map-camera__viewport");
  const projectRoot = hierarchy.getByRole("treeitem").first();
  await expect.poll(async () => {
    const [viewportBounds, rootBounds, viewportClientTop] = await Promise.all([
      mapViewport.boundingBox(),
      projectRoot.boundingBox(),
      mapViewport.evaluate((element) => element.clientTop),
    ]);
    if (viewportBounds === null || rootBounds === null) return null;
    return Math.round(
      (rootBounds.y - viewportBounds.y - viewportClientTop) * 1_000,
    ) / 1_000;
  }).toBe(32);
  await expect.poll(async () => {
    const [viewportBounds, rootBounds] = await Promise.all([
      mapViewport.boundingBox(),
      projectRoot.boundingBox(),
    ]);
    if (viewportBounds === null || rootBounds === null) return null;
    const viewportCenter = viewportBounds.x + viewportBounds.width / 2;
    const rootCenter = rootBounds.x + rootBounds.width / 2;
    return Math.abs(rootCenter - viewportCenter);
  }).toBeLessThanOrEqual(0.1);
  await hierarchy.getByRole("treeitem").first().focus();
  await page.keyboard.press("End");
  await expect(hierarchy.getByRole("treeitem").last()).toBeFocused();
  await expect(hierarchy.getByRole("treeitem").first())
    .toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(hierarchy.getByRole("treeitem").last())
    .toHaveAttribute("aria-current", "true");
  const inspector = page.getByRole("complementary", { name: "Selected item details" });
  await expect(inspector).toBeVisible();
  for (const name of [
    "Edit hierarchy",
    "Set parent",
    "Remove parent",
    "Place work",
    "Visual project map",
  ]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Focus here:/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Project vocabulary" })).toHaveCount(0);

  await inspector.getByRole("button", { name: "Focus branch" }).click();
  await expect(page.getByRole("navigation", { name: "Focused project context" }))
    .toContainText("Review repository facts");
  await expect(hierarchy).toHaveAttribute("data-layout-mode", "top-down");
  await expect(hierarchy).not.toContainText("Review repository facts");
  const scopedRoot = hierarchy.getByRole("treeitem", {
    name: /Refresh documentation safely/,
  });
  await expect(scopedRoot).toHaveAttribute("aria-level", "1");
  await expect(scopedRoot).not.toHaveAttribute("data-parent-id");
  await expect(hierarchy.getByRole("treeitem").first())
    .toHaveAttribute("aria-label", /Refresh documentation safely/);

  await page.getByRole("link", { name: "Repository" }).click();
  await expect(page.getByRole("heading", { name: "Repository Explorer" })).toBeVisible();
  const repositorySearch = page.getByRole("searchbox", { name: "Search repository" });
  const repositoryTree = page.getByRole("tree", { name: "Repository files" });
  await expect(repositoryTree).toBeVisible();
  await expect(repositorySearch).toBeVisible();
  expect(await repositorySearch.evaluate((search) => Boolean(
    search.compareDocumentPosition(document.querySelector('[role="tree"]')!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ))).toBe(true);
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveCount(0);
  await repositorySearch.fill("README");
  await expect(repositoryTree.getByRole("treeitem", { name: /README\.md/ })).toBeVisible();
  await repositorySearch.fill("");
  await page.getByText("Advanced filters").click();
  await page.getByRole("combobox", { name: "Category" }).selectOption("documentation");
  await repositorySearch.fill("adversarial-");
  const adversarialRepositoryNode = repositoryTree.getByRole("treeitem")
    .filter({ hasText: "adversarial-" });
  await expect(adversarialRepositoryNode).toBeVisible();
  await adversarialRepositoryNode.click();
  await expect(page.getByRole("link", { name: /in Documentation$/ }))
    .toHaveAttribute("href", new RegExp(structuredKnowledgeAdversarialFixture.repositoryIdentityToken));
  await expectNoHorizontalOverflow(page, [
    ".repository-explorer",
    ".repository-explorer__tree",
    ".repository-explorer__detail",
  ]);
  await repositorySearch.fill("");
  const firstRepositoryNode = repositoryTree.getByRole("treeitem").first();
  await firstRepositoryNode.focus();
  await page.keyboard.press("ArrowDown");
  await expect(repositoryTree.getByRole("treeitem").nth(1)).toBeFocused();

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [
    ".repository-explorer",
    ".repository-explorer__tree",
    ".repository-explorer__detail",
  ]);
  const narrowRepositorySearch = page.getByRole("searchbox", { name: "Search repository" });
  expect(await narrowRepositorySearch.evaluate((search) => Boolean(
    search.compareDocumentPosition(document.querySelector('[role="tree"]')!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ))).toBe(true);
  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  await openNavigation.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Primary" }))
    .toHaveAttribute("data-drawer-state", "open");
  await page.keyboard.press("Escape");
  await expect(openNavigation).toBeFocused();

  await page.goto("/projects/project-2/documentation");
  const narrowDocumentationSearch = page.getByRole("searchbox", {
    name: "Search documentation",
  });
  await expect(page.getByRole("combobox", { name: "Role" })).toHaveCount(0);
  expect(await narrowDocumentationSearch.evaluate((search) => Boolean(
    search.compareDocumentPosition(document.querySelector(".documentation-layout")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ))).toBe(true);
  await narrowDocumentationSearch.fill(structuredKnowledgeAdversarialFixture.documentPath);
  await page.getByRole("button", { name: /^adversarial-/ }).click();
  await expect(page.getByRole("heading", { name: "Bounded accepted document" })).toBeVisible();
  await expect(page.getByText(structuredKnowledgeAdversarialFixture.omittedContentTail))
    .toHaveCount(0);
  await expectNoHorizontalOverflow(page, [
    ".documentation-surface",
    ".documentation-layout",
    ".documentation-registry",
    ".documentation-preview",
  ]);

  const screenshot = testInfo.outputPath("structured-knowledge-narrow.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("Structured knowledge narrow viewport", {
    path: screenshot,
    contentType: "image/png",
  });
  await control(request, "/finalize");
  expect(remoteRequests).toEqual([]);
});
