import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

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

test("ideas persist without changing current work or repository truth", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") remoteRequests.push(request.url());
  });

  await control(request, "/prepare-ideas-boundary");
  await exchangeSession(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/projects/project-1");
  await expect(page.getByRole("region", { name: "Project state" })
    .getByRole("heading", { name: "IntentArc Visual Foundation" }))
    .toBeVisible();
  await expect(page.getByRole("navigation", { name: "Current focus path" })
    .getByRole("link", { name: /Verify deterministic browser journeys/ }))
    .toBeVisible();
  await expect(page.getByRole("link", {
    name: "Open outcome Reach a trustworthy visual foundation",
  })).toBeVisible();

  await page.getByRole("link", { name: "Ideas" }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/ideas$/);
  await expect(page.getByText(
    "Keep captured thoughts in view without changing their source record.",
  )).toHaveCount(0);
  const trigger = page.locator("header.ideas-header")
    .getByRole("button", { name: "Capture idea" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Capture idea" });
  const desktopDrawer = await dialog.boundingBox();
  expect(desktopDrawer).not.toBeNull();
  expect(desktopDrawer!.x + desktopDrawer!.width).toBe(1280);
  expect(desktopDrawer!.y).toBe(0);
  expect(desktopDrawer!.height).toBe(900);
  expect(desktopDrawer!.width).toBeGreaterThan(0);
  expect(desktopDrawer!.width).toBeLessThan(1280);
  await expect(dialog.getByRole("button", { name: "Save idea" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByLabel("Idea", { exact: true })).toBeFocused();
  await dialog.getByLabel("Idea", { exact: true }).fill(
    "Keep a local idea inbox\nDo not change the active task.",
  );
  await dialog.getByRole("button", { name: "Save idea" }).click();
  await expect(dialog.getByRole("status"))
    .toHaveText("Idea saved. Current work is unchanged.");
  await dialog.getByRole("button", { name: "View ideas" }).click();

  await expect(page).toHaveURL(/\/projects\/project-1\/ideas$/);
  await expect(page.getByRole("article", { name: "Keep a local idea inbox" }))
    .toContainText("Task");
  await expect(page.getByRole("article", { name: "Keep a local idea inbox" }))
    .toContainText("Verify deterministic browser journeys");

  const firstIdea = page.getByRole("article", { name: "Keep a local idea inbox" });
  await firstIdea.getByRole("link", { name: "View idea" }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/ideas\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Keep a local idea inbox" }))
    .toBeVisible();
  await expect(page.getByText(
    "Keep a local idea inbox\nDo not change the active task.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText("web:idea-capture")).toBeVisible();
  for (const name of ["Edit", "Delete", "Evaluate", "Promote", "Schedule"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: "Keep a local idea inbox" }))
    .toBeVisible();
  await expect(page.getByText(
    "Keep a local idea inbox\nDo not change the active task.",
    { exact: true },
  )).toBeVisible();
  await page.getByRole("link", {
    name: /Verify deterministic browser journeys/,
  }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/map\?focusRecordId=[^&]+$/);
  await expect(page.getByRole("heading", {
    name: "Verify deterministic browser journeys",
  })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Keep a local idea inbox" }))
    .toBeVisible();
  await page.goBack();
  await expect(page.getByRole("article", { name: "Keep a local idea inbox" }))
    .toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("main").getByRole("button", { name: "Capture idea" }).click();
  const narrowDialog = page.getByRole("dialog", { name: "Capture idea" });
  const narrowSheet = await narrowDialog.boundingBox();
  expect(narrowSheet).not.toBeNull();
  expect(narrowSheet!.x).toBeGreaterThanOrEqual(0);
  expect(narrowSheet!.y).toBeGreaterThanOrEqual(0);
  expect(narrowSheet!.x + narrowSheet!.width).toBeLessThanOrEqual(390);
  expect(narrowSheet!.y + narrowSheet!.height).toBeLessThanOrEqual(844);
  await expect(narrowDialog.getByLabel("Idea", { exact: true })).toBeVisible();
  await expect(narrowDialog.getByRole("button", { name: "Save idea" })).toBeVisible();
  await expect(narrowDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  const unbrokenIdea = "N".repeat(400);
  await narrowDialog.getByLabel("Idea", { exact: true }).fill(
    unbrokenIdea,
  );
  expect(await narrowDialog.evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);
  const narrowClose = await narrowDialog.getByRole("button", {
    name: "Close idea capture",
  }).boundingBox();
  expect(narrowClose).not.toBeNull();
  expect(narrowClose!.x + narrowClose!.width).toBeLessThanOrEqual(390);
  await narrowDialog.getByRole("button", { name: "Save idea" }).click();
  await expect(narrowDialog.getByRole("status"))
    .toHaveText("Idea saved. Current work is unchanged.");
  await narrowDialog.getByRole("button", { name: "View ideas" }).click();
  const longIdeaCard = page.getByRole("article").filter({
    hasText: unbrokenIdea.slice(0, 40),
  });
  await expect(longIdeaCard).toBeVisible();
  await longIdeaCard.getByRole("link", { name: "View idea" }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/ideas\/[^/]+$/);
  await expect(page.getByText(unbrokenIdea, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await control(request, "/restart");
  await exchangeSession(page);
  await page.goto("/projects/project-1/ideas");
  await expect(page.getByRole("article", { name: "Keep a local idea inbox" }))
    .toBeVisible();
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("link", {
    name: "Open outcome Reach a trustworthy visual foundation",
  })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Current focus path" })
    .getByRole("link", { name: /Verify deterministic browser journeys/ }))
    .toBeVisible();
  await control(request, "/finalize-ideas");
  expect(remoteRequests).toEqual([]);
});
