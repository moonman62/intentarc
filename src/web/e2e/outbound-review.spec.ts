import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("releases redacted context and rejects a proposal without changing the outcome", async ({
  context,
  page,
}) => {
  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: "http://127.0.0.1:47862" },
  );
  await page.addInitScript(() => {
    localStorage.setItem("intentarc.activeProject", "project-1");
    const clipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      (globalThis as typeof globalThis & {
        intentarcClipboardPayload?: string;
      }).intentarcClipboardPayload = text;
      return clipboard(text);
    };
  });
  await page.goto("/?key=intentarc-e2e-session");
  await expect(page).toHaveURL("http://127.0.0.1:47862/");

  await page.getByRole("link", {
    name: "Open IntentArc Visual Foundation",
  }).click();
  await page.getByRole("region", { name: "Current focus" }).getByRole(
    "link",
    { name: "Open Work item: Verify deterministic browser journeys" },
  ).click();

  const profile = page.getByRole("radio", { name: /Codex Safe/ });
  await expect(profile).toBeChecked();
  await expect(page.getByRole("button", { name: "Download Markdown" }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Prepare for Codex" }).click();

  await expect(page.getByRole("heading", {
    name: "Outbound review",
  })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Markdown" }))
    .toHaveCount(0);
  const reviewSummary = page.locator(".review-summary");
  await expect(reviewSummary.locator("div").filter({
    has: page.getByText("Findings", { exact: true }),
  }).locator("dd")).toHaveText("1");
  await expect(reviewSummary.locator("div").filter({
    has: page.getByText("Forced redactions", { exact: true }),
  }).locator("dd")).toHaveText("0");
  await expect(page.getByText("Include once", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve and release" }).click();
  await expect(page.getByRole("heading", {
    name: "Task context is ready",
  })).toBeVisible();
  await expect(page.locator(".release-ledger").locator("div").filter({
    has: page.getByText("Redacted", { exact: true }),
  }).locator("dd")).toHaveText("1");
  await page.getByRole("button", { name: "Copy task context" }).click();
  await expect(page.getByRole("status")).toHaveText("Task context copied");
  await expect.poll(
    () => page.evaluate(() => navigator.clipboard.readText()),
  ).toMatch(/^# IntentArc browser-chat export/);
  const clipboardText = await page.evaluate(() =>
    navigator.clipboard.readText()
  );
  const clipboardPayload = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      intentarcClipboardPayload?: string;
    }).intentarcClipboardPayload
  );
  expect(clipboardPayload).toMatch(/^# IntentArc browser-chat export/);
  expect(clipboardPayload).toMatch(/Release digest: `[a-f0-9]{64}`/);
  expect(clipboardPayload).toContain(
    "retrieve with `intentarc://projects/project-1/records/record-3`",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Markdown" }).click();
  const download = await downloadPromise;
  const releaseId = await page.locator(".release-ledger").locator("div")
    .filter({ has: page.getByText("Release", { exact: true }) })
    .locator("dd")
    .textContent();
  expect(download.suggestedFilename()).toBe(
    `intentarc-browser-chat-${releaseId}.md`,
  );
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(readFileSync(downloadedPath!)).toEqual(
    Buffer.from(clipboardPayload!, "utf8"),
  );
  expect(clipboardPayload).not.toContain("192.0.2.1");
  expect(clipboardText).not.toContain("192.0.2.1");

  await page.getByRole("link", { name: "Proposals" }).click();
  await page.getByRole("button", {
    name: "Review proposal Capture visual acceptance evidence",
  }).click();
  await page.getByRole("button", { name: "Reject proposal" }).click();
  await page.getByLabel("Reason for rejection").fill(
    "The principal journey already records the required evidence.",
  );
  await page.getByRole("button", { name: "Confirm rejection" }).click();
  await expect(page.getByRole("status")).toContainText("Review recorded");

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const dashboardResponse = await page.request.get(
    "/api/projects/project-1/dashboard",
  );
  expect(dashboardResponse.ok()).toBe(true);
  expect((await dashboardResponse.json()).currentOutcome).toMatchObject({
    id: "record-1",
    title: "Reach a trustworthy visual foundation",
  });
});
