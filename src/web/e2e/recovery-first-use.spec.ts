import { expect, test, type Page } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import { createRepositoryFixture } from "../../test-support/repository-fixture.js";

const exchangeSession = async (page: Page): Promise<void> => {
  await page.goto("/?key=intentarc-e2e-session");
  await expect(page).toHaveURL("http://127.0.0.1:47862/");
};

const installRepositoryPickerBridge = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    type PickerResult =
      | { readonly kind: "cancel" }
      | { readonly kind: "error" }
      | { readonly kind: "path"; readonly path: string };
    const browser = window as typeof window & {
      __intentArcPickerResults?: PickerResult[];
      intentArcDesktop?: unknown;
    };
    browser.__intentArcPickerResults = [];
    browser.intentArcDesktop = {
      ai: {
        list: async () => ({ automatic: [], manual: [] }),
        connect: async () => { throw new Error("Not used by repository recovery"); },
        createManual: async () => { throw new Error("Not used by repository recovery"); },
        test: async () => { throw new Error("Not used by repository recovery"); },
        remove: async () => { throw new Error("Not used by repository recovery"); },
        removeManual: async () => { throw new Error("Not used by repository recovery"); },
        launchForProject: async () => { throw new Error("Not used by repository recovery"); },
      },
      lifecycle: {
        getState: async () => ({
          archivePath: "C:\\IntentArc\\intentarc.sqlite",
          onboardingCompleted: true,
          restartRequired: false,
        }),
        chooseArchive: async () => { throw new Error("Not used by repository recovery"); },
        completeOnboarding: async () => { throw new Error("Not used by repository recovery"); },
        restart: async () => { throw new Error("Not used by repository recovery"); },
      },
      updates: {
        getStatus: async () => ({ state: "disabled" }),
        applyAndRestart: async () => { throw new Error("Not used by repository recovery"); },
      },
      documents: {
        externalOpenAvailable: true,
        openRepositoryFile: async () => { throw new Error("Not used by repository recovery"); },
        openExternalHttps: async () => { throw new Error("Not used by repository recovery"); },
      },
      repository: {
        chooseRepositoryDirectory: async () => {
          const result = browser.__intentArcPickerResults?.shift() ?? {
            kind: "cancel" as const,
          };
          if (result.kind === "error") throw new Error("Native picker unavailable");
          return result.kind === "path" ? result.path : null;
        },
      },
    };
  });
};

const queuePickerResult = async (
  page: Page,
  result:
    | { readonly kind: "cancel" }
    | { readonly kind: "error" }
    | { readonly kind: "path"; readonly path: string },
): Promise<void> => {
  await page.evaluate((next) => {
    const browser = window as typeof window & {
      __intentArcPickerResults?: typeof next[];
    };
    browser.__intentArcPickerResults ??= [];
    browser.__intentArcPickerResults.push(next);
  }, result);
};

const createFixture = (label: string) => {
  const cacheRoot = path.resolve("node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const parent = mkdtempSync(path.join(cacheRoot, `intentarc-${label}-e2e-`));
  const repository = createRepositoryFixture({
    "README.md": `# ${label}\n\nRecovery browser evidence.\n`,
    "src/index.ts": "export const recoveryEvidence = true;\n",
  }, { parentDirectory: parent });
  return { parent, repository };
};

const registeredRepositoryPath = async (
  page: Page,
  projectId: string,
): Promise<string | null> => {
  const response = await page.request.get("/api/projects");
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as {
    projects: Array<{
      project: { id: string; primaryRepositoryPath: string | null };
    }>;
  };
  const project = body.projects.find(({ project }) => project.id === projectId)?.project;
  expect(project).toBeDefined();
  return project!.primaryRepositoryPath;
};

const normalizedPath = (value: string | null): string | null =>
  value?.replaceAll("\\", "/") ?? null;

test("desktop Browse preserves manual input on cancel or failure and opens summary-first review on success", async ({
  page,
}) => {
  const fixture = createFixture("Browse recovery");
  try {
    await installRepositoryPickerBridge(page);
    await exchangeSession(page);
    await page.goto("/projects/import");

    const repositoryPath = page.getByLabel("Repository path");
    const browse = page.getByRole("button", { name: "Browse…" });
    await repositoryPath.fill("C:\\safe\\manual-entry");

    await queuePickerResult(page, { kind: "cancel" });
    await browse.click();
    await expect(repositoryPath).toHaveValue("C:\\safe\\manual-entry");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await queuePickerResult(page, { kind: "error" });
    await browse.click();
    await expect(repositoryPath).toHaveValue("C:\\safe\\manual-entry");
    await expect(page.getByRole("alert")).toHaveText(
      "Browse could not open. Enter the repository path manually.",
    );

    await queuePickerResult(page, { kind: "path", path: fixture.repository.root });
    await browse.click();
    await expect(repositoryPath).toHaveValue(fixture.repository.root);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Scan repository" }).click();

    await expect(page.getByRole("heading", { name: "Review scan summary" }))
      .toBeVisible();
    const technicalDetails = page.locator("details.import-technical-details");
    await expect(technicalDetails).not.toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Stable frame" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Continue to confirmation" }))
      .toBeVisible();
  } finally {
    fixture.repository.cleanup();
    rmdirSync(fixture.parent);
  }
});

test("repository recovery keeps the registered source safe through cancel and mismatch before locating the moved repository", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = createFixture("Repository locate");
  const mismatch = createFixture("Repository mismatch");
  const movedRoot = `${fixture.repository.root} moved`;
  let moved = false;
  try {
    await installRepositoryPickerBridge(page);
    await exchangeSession(page);

    const scanResponse = await page.request.post("/api/imports/scan", {
      headers: { origin: "http://127.0.0.1:47862" },
      data: {
        repositoryPath: fixture.repository.root,
        canonicalSubpath: null,
      },
    });
    expect(scanResponse.ok(), await scanResponse.text()).toBe(true);
    const scanned = await scanResponse.json() as {
      manifest: unknown;
      inspection: { manifestDigest: string };
    };
    const applyResponse = await page.request.post("/api/imports/apply", {
      headers: { origin: "http://127.0.0.1:47862" },
      data: {
        manifest: scanned.manifest,
        confirmedDigest: scanned.inspection.manifestDigest,
      },
    });
    expect(applyResponse.ok(), await applyResponse.text()).toBe(true);
    const applied = await applyResponse.json() as {
      result: { projectId: string };
    };
    const projectId = applied.result.projectId;

    await page.goto(`/projects/${encodeURIComponent(projectId)}/repository/refresh`);
    await page.getByRole("button", { name: "Scan repository" }).click();
    await expect(page.getByRole("heading", { name: "Repository facts" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Accept repository refresh" }).click();
    await expect(page.getByRole("heading", { name: "Refresh outcome" }))
      .toBeVisible();

    renameSync(fixture.repository.root, movedRoot);
    moved = true;

    await page.reload();
    await page.getByRole("button", { name: "Scan repository" }).click();
    await expect(page.getByRole("heading", { name: "Repository unavailable" }))
      .toBeVisible();
    await expect(page.getByText(
      "Accepted indexed metadata remains available in IntentArc while the source is recovered.",
    )).toBeVisible();

    await page.goto(`/projects/${encodeURIComponent(projectId)}/repository`);
    await expect(page.getByText("Accepted index · repository unavailable"))
      .toBeVisible();
    await expect(page.getByRole("treeitem", { name: /unavailable/ }).first())
      .toBeVisible();
    await page.goto(`/projects/${encodeURIComponent(projectId)}/repository/refresh`);
    await expect(page.getByRole("heading", { name: "Repository unavailable" }))
      .toBeVisible();

    const locate = page.getByRole("button", { name: "Locate repository" });
    await queuePickerResult(page, { kind: "cancel" });
    await locate.click();
    await expect(page.getByRole("heading", { name: "Repository unavailable" }))
      .toBeVisible();
    expect(normalizedPath(await registeredRepositoryPath(page, projectId)))
      .toBe(normalizedPath(fixture.repository.root));

    await queuePickerResult(page, { kind: "path", path: mismatch.repository.root });
    await locate.click();
    await expect(page.getByRole("alert")).toHaveText(
      "The selected folder is not the registered repository. Nothing changed.",
    );
    await expect(page.getByRole("heading", { name: "Repository unavailable" }))
      .toBeVisible();
    expect(normalizedPath(await registeredRepositoryPath(page, projectId)))
      .toBe(normalizedPath(fixture.repository.root));

    await queuePickerResult(page, { kind: "path", path: movedRoot });
    await locate.click();
    await expect(page.getByRole("status")).toHaveText(
      "Repository location verified. Retry to review current evidence.",
    );
    expect(normalizedPath(await registeredRepositoryPath(page, projectId)))
      .toBe(normalizedPath(movedRoot));
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Repository facts" }))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Proposed project meaning" }))
      .toBeVisible();
  } finally {
    if (moved) renameSync(movedRoot, fixture.repository.root);
    fixture.repository.cleanup();
    mismatch.repository.cleanup();
    rmdirSync(fixture.parent);
    rmdirSync(mismatch.parent);
  }
});

test("Attach keeps a no-source project bound through cancel, failure, and first review", async ({
  page,
}) => {
  const fixture = createFixture("Project bound attach");
  try {
    await installRepositoryPickerBridge(page);
    await exchangeSession(page);
    const createResponse = await page.request.post("/api/projects", {
      headers: { origin: "http://127.0.0.1:47862" },
      data: {
        name: "Project-bound attach fixture",
        primaryRepositoryPath: null,
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
    const created = await createResponse.json() as { project: { id: string } };
    const projectId = created.project.id;
    const refreshPath = `/projects/${encodeURIComponent(projectId)}/repository/refresh`;

    await page.goto(`/projects/${encodeURIComponent(projectId)}/repository`);
    await expect(page.getByRole("heading", { name: "Repository unavailable" }))
      .toBeVisible();
    await expect(page.getByText("This project does not have an attached repository."))
      .toBeVisible();
    const attachLink = page.getByRole("link", { name: "Attach repository" });
    await expect(attachLink).toHaveAttribute("href", refreshPath);
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByRole("tree")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Common repository filters" }))
      .toHaveCount(0);

    await attachLink.click();
    await expect(page).toHaveURL(`http://127.0.0.1:47862${refreshPath}`);
    const repositoryPath = page.getByLabel("Repository folder");
    const browse = page.getByRole("button", { name: "Browse" });
    await repositoryPath.fill("C:\\missing\\repository");

    await queuePickerResult(page, { kind: "cancel" });
    await browse.click();
    await expect(repositoryPath).toHaveValue("C:\\missing\\repository");
    expect(await registeredRepositoryPath(page, projectId)).toBeNull();

    await queuePickerResult(page, { kind: "error" });
    await browse.click();
    await expect(repositoryPath).toHaveValue("C:\\missing\\repository");
    await expect(page.getByRole("alert")).toHaveText("Native picker unavailable");
    expect(await registeredRepositoryPath(page, projectId)).toBeNull();

    await page.getByRole("button", { name: "Attach and review" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(repositoryPath).toHaveValue("C:\\missing\\repository");
    await expect(page).toHaveURL(`http://127.0.0.1:47862${refreshPath}`);
    expect(await registeredRepositoryPath(page, projectId)).toBeNull();

    await queuePickerResult(page, { kind: "path", path: fixture.repository.root });
    await browse.click();
    await expect(repositoryPath).toHaveValue(fixture.repository.root);
    await page.getByRole("button", { name: "Attach and review" }).click();

    await expect(page.getByRole("heading", { name: "Repository facts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proposed project meaning" })).toBeVisible();
    await expect(page).toHaveURL(`http://127.0.0.1:47862${refreshPath}`);
    expect(normalizedPath(await registeredRepositoryPath(page, projectId)))
      .toBe(normalizedPath(fixture.repository.root));
  } finally {
    fixture.repository.cleanup();
    rmdirSync(fixture.parent);
  }
});

test("Work Queue keeps project authority visible and forgets credentials after failure, sign-out, and project switch", async ({
  page,
}) => {
  await exchangeSession(page);
  const createProject = async (name: string): Promise<string> => {
    const response = await page.request.post("/api/projects", {
      headers: { origin: "http://127.0.0.1:47862" },
      data: { name, primaryRepositoryPath: null },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json() as { project: { id: string } };
    return body.project.id;
  };
  const workProjectId = await createProject("Recovery Work Queue Fixture");
  const switchProjectId = await createProject("Recovery Switch Fixture");
  const profileResponse = await page.request.post(
    `/api/projects/${encodeURIComponent(workProjectId)}/profiles`,
    {
      headers: { origin: "http://127.0.0.1:47862" },
      data: {
        source: "new",
        name: "Recovery boundary agent",
        executionMode: "safe",
        destination: {
          clientLabel: "Recovery browser",
          type: "ide_managed",
          providerLabel: "Playwright",
          modelLabel: null,
          accountBoundaryLabel: "Owned recovery fixture",
          dataBoundary: "local",
        },
      },
    },
  );
  expect(profileResponse.ok(), await profileResponse.text()).toBe(true);
  const profile = await profileResponse.json() as {
    profileId: string;
    token: string;
  };
  const invalidToken = "intentarc-invalid-browser-secret";

  await page.goto(`/projects/${encodeURIComponent(workProjectId)}/work`);
  await expect(page.getByRole("region", { name: "Project work" }))
    .toContainText("Recovery Work Queue Fixture");
  await expect(page.getByRole("button", {
    name: `Authenticate as Recovery boundary agent (${profile.profileId})`,
  })).toBeVisible();
  await expect(page.getByText(
    "An existing configured profile cannot be authenticated here without its separately held token.",
  )).toBeVisible();
  await expect(page.locator("details.work-signin")).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("Profile token")).toHaveCount(0);

  await page.getByRole("button", {
    name: `Authenticate as Recovery boundary agent (${profile.profileId})`,
  }).click();
  await page.getByLabel("Profile token").fill(invalidToken);
  await page.getByRole("button", { name: "Open Work Queue" }).click();
  await expect(page.getByRole("alert")).toContainText("Profile credentials are invalid.");
  await expect(page.getByLabel("Profile ID")).toHaveValue("");
  await expect(page.getByLabel("Profile token")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(invalidToken);
  expect(await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
    url: location.href,
  }))).not.toContain(invalidToken);

  await page.getByLabel("Profile ID").fill(profile.profileId);
  await page.getByLabel("Profile token").fill(profile.token);
  await page.getByRole("button", { name: "Open Work Queue" }).click();
  await expect(page.getByRole("heading", { name: "No coordinated work" }))
    .toBeVisible();
  await expect(page.locator("body")).not.toContainText(profile.token);
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByLabel("Profile token")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(profile.token);
  expect(await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
    url: location.href,
  }))).not.toContain(profile.token);

  await page.getByText("Advanced access").click();
  await page.getByLabel("Profile ID").fill(profile.profileId);
  await page.getByLabel("Profile token").fill(profile.token);
  await page.goto(`/projects/${encodeURIComponent(switchProjectId)}/work`);
  await expect(page.getByRole("region", { name: "Project work" }))
    .toContainText("Recovery Switch Fixture");
  await expect(page.getByLabel("Profile token")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(profile.token);
  expect(await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
    url: location.href,
  }))).not.toContain(profile.token);

  await page.goto(`/projects/${encodeURIComponent(workProjectId)}/work`);
  await expect(page.locator("details.work-signin")).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("Profile token")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(profile.token);
});
