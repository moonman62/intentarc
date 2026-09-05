import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import path from "node:path";
import { createRepositoryFixture } from "../../test-support/repository-fixture.js";

test("scans, reviews, and applies an existing repository baseline", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const cacheRoot = path.resolve("node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const repositoryParent = mkdtempSync(path.join(
    cacheRoot,
    "intentarc-web-e2e-",
  ));
  const repository = createRepositoryFixture({
    ".gitignore": "node_modules/\nbuild/\n",
    "README.md": [
      "# Browser import fixture",
      "",
      "A deterministic repository used by the IntentArc web import journey.",
      "",
    ].join("\n"),
    "game/project.godot": [
      "[application]",
      'config/name="Browser Import Fixture"',
      'run/main_scene="res://src/main.tscn"',
      "",
    ].join("\n"),
    "game/src/main.gd": [
      "class_name BrowserImportMain",
      "func start() -> void:",
      "\tpass",
      "",
    ].join("\n"),
    "game/tests/main_test.gd": [
      "func test_start() -> void:",
      "\tassert_true(true)",
      "",
    ].join("\n"),
  }, { parentDirectory: repositoryParent });

  try {
    await page.goto("/?key=intentarc-e2e-session");
    await expect(page).toHaveURL("http://127.0.0.1:47862/");
    await page.goto("/projects/import");

    await expect(page.getByRole("button", { name: "Browse…" })).toHaveCount(0);

    const canonicalSubpath = page.getByLabel("Canonical subpath");
    const scanRepository = page.getByRole("button", {
      name: "Scan repository",
    });
    const subpathBox = await canonicalSubpath.boundingBox();
    const scanBox = await scanRepository.boundingBox();
    expect(subpathBox).not.toBeNull();
    expect(scanBox).not.toBeNull();
    const overlaps = !(
      subpathBox!.x + subpathBox!.width <= scanBox!.x ||
      scanBox!.x + scanBox!.width <= subpathBox!.x ||
      subpathBox!.y + subpathBox!.height <= scanBox!.y ||
      scanBox!.y + scanBox!.height <= subpathBox!.y
    );
    expect(overlaps).toBe(false);

    const selectionScreenshot = testInfo.outputPath(
      "import-selection-expanded.png",
    );
    await page.screenshot({ path: selectionScreenshot, fullPage: true });
    await testInfo.attach("Import selection expanded", {
      path: selectionScreenshot,
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" }))
      .toHaveAttribute("data-sidebar-state", "collapsed");
    const collapsedSubpathBox = await canonicalSubpath.boundingBox();
    const collapsedScanBox = await scanRepository.boundingBox();
    expect(collapsedSubpathBox).not.toBeNull();
    expect(collapsedScanBox).not.toBeNull();
    const overlapsWhenCollapsed = !(
      collapsedSubpathBox!.x + collapsedSubpathBox!.width <=
        collapsedScanBox!.x ||
      collapsedScanBox!.x + collapsedScanBox!.width <=
        collapsedSubpathBox!.x ||
      collapsedSubpathBox!.y + collapsedSubpathBox!.height <=
        collapsedScanBox!.y ||
      collapsedScanBox!.y + collapsedScanBox!.height <=
        collapsedSubpathBox!.y
    );
    expect(overlapsWhenCollapsed).toBe(false);

    const collapsedScreenshot = testInfo.outputPath(
      "import-selection-collapsed.png",
    );
    await page.screenshot({ path: collapsedScreenshot, fullPage: true });
    await testInfo.attach("Import selection collapsed", {
      path: collapsedScreenshot,
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Expand navigation" }).click();

    await page.getByLabel("Repository path").fill(repository.root);
    await canonicalSubpath.fill("game");
    await scanRepository.click();

    await expect(page.getByRole("heading", { name: "Review scan summary" }))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Warnings" }))
      .toBeVisible();
    await expect(page.getByText("Browser Import Fixture", {
      exact: true,
    })).toBeVisible();

    const reviewScreenshot = testInfo.outputPath("import-review.png");
    await page.screenshot({ path: reviewScreenshot, fullPage: true });
    await testInfo.attach("Import review", {
      path: reviewScreenshot,
      contentType: "image/png",
    });

    const technicalDetails = page.locator("details.import-technical-details");
    await expect(technicalDetails).not.toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Stable frame" }))
      .toBeHidden();
    await technicalDetails.getByText("Review technical details").click();
    await expect(page.getByRole("heading", { name: "Stable frame" }))
      .toBeVisible();
    await technicalDetails.getByText("Review technical details").click();

    const continueToConfirmation = page.getByRole("button", {
      name: "Continue to confirmation",
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(continueToConfirmation).toBeInViewport();
    await continueToConfirmation.click();
    const confirmationScreenshot = testInfo.outputPath(
      "import-confirmation.png",
    );
    await page.screenshot({ path: confirmationScreenshot, fullPage: true });
    await testInfo.attach("Import confirmation", {
      path: confirmationScreenshot,
      contentType: "image/png",
    });
    await page.getByRole("checkbox", {
      name: "I reviewed this baseline",
    }).check();
    await page.getByRole("button", {
      name: "Apply imported baseline",
    }).click();

    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    const projectState = page.getByRole("region", { name: "Project state" });
    await expect(projectState.getByRole("heading", {
      name: "Browser Import Fixture",
    })).toBeVisible();
  } finally {
    repository.cleanup();
    rmdirSync(repositoryParent);
  }
});
