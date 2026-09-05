import { expect, type Locator, type Page, test } from "@playwright/test";
import { createApplication } from "../../app/create-application.js";
import { ownedE2eDatabaseFromEnvironment } from "../test-support/e2e-runner.js";

interface BrowserProfile {
  name: string;
  profileId: string;
  token: string;
}

let projectId = "";
const originalTask = "Verify deterministic browser journeys";
const activatedTask = "Resolve fixture review warning";
const createdTask = "Coordinate delegated browser proof";

test.setTimeout(120_000);

const expectStableNoHorizontalOverflow = async (
  page: Page,
  requiredSamples = 5,
): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve())
    ));
  });
  let stableSamples = 0;
  const deadline = Date.now() + 5_000;
  while (stableSamples < requiredSamples && Date.now() < deadline) {
    const fits = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    );
    stableSamples = fits ? stableSamples + 1 : 0;
    if (stableSamples < requiredSamples) await page.waitForTimeout(50);
  }
  if (stableSamples === requiredSamples) return;
  const diagnostics = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return {
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: element.className,
            text: element.textContent?.trim().slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        })
        .filter(({ right, scrollWidth, clientWidth }) =>
          right > viewport + 1 || scrollWidth > clientWidth + 1
        )
        .slice(0, 12),
    };
  });
  throw new Error(
    `Expected ${requiredSamples} consecutive settled no-overflow samples: ${JSON.stringify(diagnostics)}`,
  );
};

test.beforeAll(() => {
  const application = createApplication({
    databasePath: ownedE2eDatabaseFromEnvironment().path,
    now: () => "2026-07-29T12:00:00.000Z",
  });
  try {
    const project = application.service.createProject({
      name: "Coordination Browser Fixture",
    });
    projectId = project.id;
    application.service.createRecord({
      projectId,
      kind: "outcome",
      status: "active",
      title: "Coordinate browser work without shared-state pollution",
      body: "Keep the browser coordination journey isolated from every other fixture.",
      sourceKind: "human",
      sourceRef: null,
    });
    for (const title of [originalTask, activatedTask]) {
      application.service.createRecord({
        projectId,
        kind: "task",
        status: "active",
        title,
        body: `${title} in the isolated coordination browser fixture.`,
        sourceKind: "human",
        sourceRef: null,
      });
    }
  } finally {
    application.close();
  }
});

test("keeps signed-out Work Queue header copy together", async ({ page }) => {
  await page.goto("/?key=intentarc-e2e-session");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/projects/${projectId}/work`);

  const header = page.locator(".work-queue-signin .work-queue__header");
  const eyebrow = header.locator(".stage__eyebrow");
  const heading = header.getByRole("heading", { name: "Agent Work Queue", level: 1 });
  const lede = header.locator(".stage__lede");
  const [eyebrowBox, headingBox, ledeBox] = await Promise.all([
    eyebrow.boundingBox(),
    heading.boundingBox(),
    lede.boundingBox(),
  ]);
  expect(eyebrowBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(ledeBox).not.toBeNull();
  expect(headingBox!.x).toBe(eyebrowBox!.x);
  expect(ledeBox!.x).toBe(eyebrowBox!.x);
  expect(eyebrowBox!.y + eyebrowBox!.height).toBeLessThanOrEqual(headingBox!.y);
  expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(ledeBox!.y);

  await page.setViewportSize({ width: 390, height: 844 });
  const [mobileEyebrowBox, mobileHeadingBox, mobileLedeBox] = await Promise.all([
    eyebrow.boundingBox(),
    heading.boundingBox(),
    lede.boundingBox(),
  ]);
  expect(mobileEyebrowBox).not.toBeNull();
  expect(mobileHeadingBox).not.toBeNull();
  expect(mobileLedeBox).not.toBeNull();
  expect(mobileEyebrowBox!.y + mobileEyebrowBox!.height)
    .toBeLessThanOrEqual(mobileHeadingBox!.y);
  expect(mobileHeadingBox!.y + mobileHeadingBox!.height)
    .toBeLessThanOrEqual(mobileLedeBox!.y);
  await expectStableNoHorizontalOverflow(page);
});

const createProfile = async (page: Page, name: string): Promise<BrowserProfile> =>
  page.evaluate(async ({ projectId: selectedProjectId, name: profileName }) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "new",
        name: profileName,
        executionMode: "safe",
        destination: {
          clientLabel: profileName,
          type: "ide_managed",
          providerLabel: "Playwright",
          modelLabel: null,
          accountBoundaryLabel: "Owned browser fixture",
          dataBoundary: "local",
        },
      }),
    });
    if (!response.ok) throw new Error("Could not create the browser fixture profile.");
    const body = await response.json() as {
      profileId: string;
      token: string | null;
      tokenShownOnce: boolean;
    };
    if (!body.tokenShownOnce || body.token === null) {
      throw new Error("The browser fixture credential was not returned once.");
    }
    return { name: profileName, profileId: body.profileId, token: body.token };
  }, { projectId, name });

const signIn = async (page: Page, profile: BrowserProfile): Promise<void> => {
  await activateWithKeyboard(page, page.getByRole("button", {
    name: `Authenticate as ${profile.name} (${profile.profileId})`,
  }));
  const profileId = page.getByLabel("Profile ID");
  await expect(profileId).toHaveValue(profile.profileId);
  await profileId.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.insertText(profile.token);
  await page.keyboard.press("Enter");
  const recovery = page.getByRole("button", {
    name: "Recover current project revision",
  });
  await Promise.race([
    page.getByRole("heading", { name: "Ready now" }).waitFor(),
    recovery.waitFor(),
  ]);
  if (await recovery.isVisible().catch(() => false)) {
    await recovery.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByRole("heading", { name: "Ready now" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(profile.token);
};

const taskButton = (page: Page, title: string): Locator =>
  page.getByRole("navigation", { name: "Work Queue tasks" })
    .getByRole("button", { name: new RegExp(title) });

const activateWithKeyboard = async (
  page: Page,
  control: Locator,
  key: "Enter" | "Space" = "Enter",
): Promise<void> => {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press(key);
};

const selectOptionWithKeyboard = async (
  page: Page,
  select: Locator,
  option: { label: string } | { value: string },
): Promise<void> => {
  const optionIndex = await select.locator("option").evaluateAll((options, target) =>
    options.findIndex((candidate) =>
      "label" in target
        ? candidate.textContent?.trim() === target.label
        : (candidate as HTMLOptionElement).value === target.value
    ), option);
  if (optionIndex < 0) throw new Error("The requested keyboard select option is unavailable.");
  await select.focus();
  await expect(select).toBeFocused();
  await page.keyboard.press("Home");
  for (let index = 0; index < optionIndex; index += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Tab");
};

const selectTask = async (page: Page, title: string): Promise<void> => {
  await activateWithKeyboard(page, taskButton(page, title), "Space");
  await expect(page.getByRole("region", { name: "Selected work" })
    .getByRole("heading", { name: title })).toBeVisible();
};

const fillCheckpoint = async (
  dialog: Locator,
  summary: string,
): Promise<void> => {
  await dialog.getByLabel("Summary").fill(summary);
  await dialog.getByLabel("Completed work").fill("Browser action completed");
  await dialog.getByLabel("Remaining work").fill("Review governed proposal");
  await dialog.getByLabel("Tests").fill("Playwright keyboard journey");
};

const addCheckpoint = async (page: Page, summary: string): Promise<void> => {
  await activateWithKeyboard(page, page.getByRole("button", { name: "Add checkpoint" }));
  const dialog = page.getByRole("dialog", { name: /Checkpoint/ });
  await fillCheckpoint(dialog, summary);
  await activateWithKeyboard(
    page,
    dialog.getByRole("button", { name: "Save checkpoint" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Add checkpoint completed");
};

const claimSelectedTask = async (page: Page): Promise<void> => {
  const claim = page.getByRole("button", { name: "Claim task" });
  await claim.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /Claim/ });
  const confirm = dialog.getByRole("button", { name: "Confirm claim" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  const status = page.getByRole("status");
  await expect(status).toContainText("Claim task completed");
  await expect(status).toBeFocused();
};

const submitSelectedTask = async (
  page: Page,
  summary: string,
  rationale: string,
  operations: unknown[] = [],
): Promise<void> => {
  await activateWithKeyboard(page, page.getByRole("button", { name: "Submit result" }));
  const dialog = page.getByRole("dialog", { name: /Submit/ });
  await dialog.getByLabel("Result summary").fill(summary);
  await dialog.getByLabel("Tests").fill("Playwright keyboard journey");
  await dialog.getByLabel("Change rationale").fill(rationale);
  await dialog.getByLabel("Additional operations (JSON array)").fill(
    JSON.stringify(operations),
  );
  await activateWithKeyboard(
    page,
    dialog.getByRole("button", { name: "Confirm submission" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Submit result completed");
};

const reviewProposal = async (
  page: Page,
  rationale: string,
  expected: "accepted" | "conflicted",
): Promise<void> => {
  await activateWithKeyboard(page, page.getByRole("button", {
    name: `Review proposal ${rationale}`,
  }));
  await expect(page.getByRole("heading", { name: rationale, level: 2 })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole("button", { name: "Accept proposal" }));
  await activateWithKeyboard(
    page,
    page.getByRole("button", { name: "Confirm accept" }),
    "Space",
  );
  if (expected === "accepted") {
    await expect(page.getByRole("status")).toContainText("Review recorded");
  } else {
    await expect(page.getByRole("alert")).toContainText("Proposal conflicted");
  }
};

test("coordinates two profiles through switch, delegation, submission, and stale recovery", async ({
  page,
}) => {
  let pointerActivations = 0;
  await page.exposeFunction("__recordCoordinationPointer", () => {
    pointerActivations += 1;
  });
  await page.addInitScript(() => {
    window.addEventListener("pointerdown", () => {
      void (window as Window & {
        __recordCoordinationPointer: () => Promise<void>;
      }).__recordCoordinationPointer();
    }, { capture: true });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-07-29T12:00:00.000Z") });
  await page.goto("/?key=intentarc-e2e-session");
  const parent = await createProfile(page, "Coordination Parent");
  const child = await createProfile(page, "Coordination Child");

  await page.goto(`/projects/${projectId}/work`);
  await expect(page.locator("details")).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("Profile token")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Project work" }))
    .toContainText("Coordination Browser Fixture");
  await expect(page.getByRole("button", {
    name: `Authenticate as Coordination Parent (${parent.profileId})`,
  }))
    .toBeVisible();
  await expect(page.getByRole("button", {
    name: `Authenticate as Coordination Child (${child.profileId})`,
  }))
    .toBeVisible();
  await expect(page.getByText(
    "An existing configured profile cannot be authenticated here without its separately held token.",
  )).toBeVisible();
  await signIn(page, parent);
  await selectTask(page, originalTask);
  expect(pointerActivations).toBe(0);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "200%";
  });
  await expect(page.getByRole("navigation", { name: "Work Queue tasks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected work" })).toBeVisible();
  await expectStableNoHorizontalOverflow(page);
  const motionDuration = await page.locator(".work-list button").first().evaluate((element) =>
    Math.max(
      Number.parseFloat(getComputedStyle(element).animationDuration) || 0,
      Number.parseFloat(getComputedStyle(element).transitionDuration) || 0,
    )
  );
  expect(motionDuration).toBeLessThanOrEqual(0.01);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "100%";
  });
  await claimSelectedTask(page);
  await addCheckpoint(page, "Bootstrap coordinated browser work");
  await submitSelectedTask(
    page,
    "Create ready work for the two-profile journey",
    "Bootstrap coordinated browser work",
    [
      {
        operationId: "create-delegated-browser-task",
        type: "create_record",
        localRef: "delegated-browser-task",
        kind: "task",
        status: "active",
        title: createdTask,
        body: "Exercise an independent claimed submission in the browser.",
      },
    ],
  );
  await activateWithKeyboard(page, page.getByRole("link", { name: "Review proposal" }));
  await reviewProposal(page, "Bootstrap coordinated browser work", "accepted");

  await activateWithKeyboard(page, page.getByRole("link", { name: "Work Queue" }));
  await signIn(page, parent);
  await selectTask(page, activatedTask);
  await claimSelectedTask(page);
  await addCheckpoint(page, "Parent checkpoint before switch");
  await activateWithKeyboard(page, page.getByRole("button", { name: "Switch task" }));
  const switchDialog = page.getByRole("dialog", { name: /Switch from/ });
  await fillCheckpoint(switchDialog, "Atomic switch checkpoint");
  await selectOptionWithKeyboard(
    page,
    switchDialog.getByLabel("Next task"),
    { label: createdTask },
  );
  await selectOptionWithKeyboard(
    page,
    switchDialog.getByLabel("Current claim outcome"),
    { value: "release" },
  );
  await activateWithKeyboard(
    page,
    switchDialog.getByRole("button", { name: "Confirm switch" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Switch task completed");

  await selectTask(page, activatedTask);
  await activateWithKeyboard(page, page.getByRole("button", { name: "Delegate task" }));
  const delegateDialog = page.getByRole("dialog", { name: /Delegate/ });
  await delegateDialog.getByLabel("Child profile ID").fill(child.profileId);
  await delegateDialog.getByLabel("Delegation scope").fill(
    "Submit only the browser verification result",
  );
  await delegateDialog.getByLabel("Constraints").fill("Do not change unrelated records");
  await activateWithKeyboard(
    page,
    delegateDialog.getByRole("checkbox", { name: "Update records (update_record)" }),
    "Space",
  );
  await delegateDialog.getByLabel("Deadline").fill("2026-07-29T15:00");
  await activateWithKeyboard(
    page,
    delegateDialog.getByRole("button", { name: "Offer delegation" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Delegate task completed");

  await activateWithKeyboard(page, page.getByRole("button", { name: "Sign out" }));
  await signIn(page, child);
  await selectTask(page, activatedTask);
  await activateWithKeyboard(page, page.getByRole("button", { name: "Accept delegation" }));
  await activateWithKeyboard(
    page,
    page.getByRole("dialog", { name: /Accept delegation/ })
      .getByRole("button", { name: "Confirm acceptance" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Accept delegation completed");
  await claimSelectedTask(page);
  await addCheckpoint(page, "Child independently verified delegated work");
  await submitSelectedTask(
    page,
    "Child work is ready for review",
    "Child browser submission",
  );

  await activateWithKeyboard(page, page.getByRole("button", { name: "Sign out" }));
  await signIn(page, parent);
  await selectTask(page, createdTask);
  await addCheckpoint(page, "Parent independently verified switched work");
  await submitSelectedTask(
    page,
    "Parent work is ready for review",
    "Parent browser submission",
  );
  await activateWithKeyboard(page, page.getByRole("link", { name: "Review proposal" }));
  await reviewProposal(page, "Parent browser submission", "accepted");
  await reviewProposal(page, "Child browser submission", "conflicted");

  await activateWithKeyboard(page, page.getByRole("link", { name: "Work Queue" }));
  await signIn(page, child);
  await selectTask(page, activatedTask);
  await expect(page.getByRole("region", { name: "Selected work" }))
    .toContainText("conflicted · proposal reconciliation recorded");
  await activateWithKeyboard(page, page.getByRole("button", { name: "Release claim" }));
  await activateWithKeyboard(
    page,
    page.getByRole("dialog", { name: /Release/ })
      .getByRole("button", { name: "Confirm release" }),
    "Space",
  );
  await expect(page.getByRole("status")).toContainText("Release claim completed");
  expect(pointerActivations).toBe(0);
});
