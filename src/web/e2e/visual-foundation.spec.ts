import { expect, test, type Locator, type Page } from "@playwright/test";

const exchangeSession = async (
  page: Page,
): Promise<void> => {
  await page.goto("/?key=intentarc-e2e-session");
  await expect(page).toHaveURL("http://127.0.0.1:47862/");
  expect(new URL(page.url()).searchParams.has("key")).toBe(false);
  const sessionCookie = (await page.context().cookies()).find(
    ({ name }) => name === "intentarc_session",
  );
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    sameSite: "Strict",
    value: "intentarc-e2e-session",
  });
};

const preferVisualFoundationProject = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem("intentarc.activeProject", "project-1");
  });
};

const responsiveVisualCases = [
  {
    name: "wide",
    viewport: { width: 2560, height: 1440 },
  },
  {
    name: "laptop",
    viewport: { width: 1366, height: 768 },
  },
  {
    name: "narrow",
    viewport: { width: 390, height: 844 },
  },
] as const;

const storedThemes = [
  { name: "Archive Modern", value: "light" },
  { name: "Archive Night", value: "dark" },
] as const;

const setStoredTheme = async (
  page: Page,
  theme: (typeof storedThemes)[number]["value"],
): Promise<void> => {
  await page.addInitScript((storedTheme) => {
    localStorage.setItem("intentarc.theme", storedTheme);
  }, theme);
};

for (const { name: viewportName, viewport } of responsiveVisualCases) {
  for (const { name: themeName, value: theme } of storedThemes) {
    test(`keeps the Overview and grouped navigation within the ${viewportName} ${themeName} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await setStoredTheme(page, theme);
      await preferVisualFoundationProject(page);
      await exchangeSession(page);
      await page.getByRole("link", {
        name: "Open IntentArc Visual Foundation",
      }).click();

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

      const stage = page.locator(".stage");
      const stageBox = await stage.boundingBox();
      expect(stageBox).not.toBeNull();
      if (viewport.width === 2560) {
        expect(stageBox!.width).toBeGreaterThan(1200);
        expect(stageBox!.width).toBeLessThanOrEqual(1620);
        expect(stageBox!.x).toBeGreaterThan(100);
        expect(viewport.width - stageBox!.x - stageBox!.width).toBeGreaterThan(100);
      } else {
        expect(stageBox!.x).toBeGreaterThanOrEqual(16);
        expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(viewport.width - 16);
      }

      const navigation = page.getByRole("navigation", { name: "Primary" });
      if (viewport.width < 760) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await expect(navigation).toHaveAttribute("data-drawer-state", "open");
      }
      await expect(navigation.getByRole("heading", { name: "Actions" }))
        .toBeVisible();
      await expect(navigation.getByRole("heading", { name: "Information" }))
        .toBeVisible();
      await expect(navigation.locator(".sidebar__nav-group > h2")).toHaveText([
        "Actions",
        "Information",
      ]);
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      )).toBe(true);
      if (viewport.width === 390) {
        const sectionTops = await page.locator(".project-overview > section")
          .evaluateAll((sections) => sections.map((section) =>
            (section as HTMLElement).getBoundingClientRect().top
          ));
        expect(sectionTops).toEqual([...sectionTops].sort((left, right) => left - right));
      }
    });
  }
}

const pressTab = async (page: Page, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
  }
};

const tabTo = async (
  page: Page,
  target: Locator,
  maximumTabs = 16,
): Promise<void> => {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard navigation did not reach the expected target.");
};

test("continues from the hub through the persisted Archive Overview", async ({
  page,
}, testInfo) => {
  await preferVisualFoundationProject(page);
  await exchangeSession(page);

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "IntentArc Visual Foundation",
  })).toBeVisible();
  await page.getByRole("link", {
    name: "Open IntentArc Visual Foundation",
  }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const attention = page.getByRole("region", {
    name: "Attention",
  });
  await expect(attention).toBeVisible();
  await expect(attention.getByText("Blocked", { exact: true })).toBeVisible();

  const lightScreenshot = testInfo.outputPath("visual-foundation-light.png");
  await page.screenshot({ path: lightScreenshot, fullPage: true });
  await testInfo.attach("Archive Modern", {
    path: lightScreenshot,
    contentType: "image/png",
  });

  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" }))
    .toHaveAttribute("data-sidebar-state", "collapsed");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary" }))
    .toHaveAttribute("data-sidebar-state", "collapsed");

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const darkScreenshot = testInfo.outputPath("visual-foundation-dark.png");
  await page.screenshot({ path: darkScreenshot, fullPage: true });
  await testInfo.attach("Archive Night", {
    path: darkScreenshot,
    contentType: "image/png",
  });

  const contextLink = page.getByRole("link", { name: "Current task" });
  await tabTo(page, contextLink);
  await expect(contextLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/handoff$/);
  await expect(page.getByRole("heading", {
    name: "Verify deterministic browser journeys",
  })).toBeVisible();
});

test("keeps the narrow navigation keyboard reachable and contained", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preferVisualFoundationProject(page);
  await exchangeSession(page);
  await page.getByRole("link", {
    name: "Open IntentArc Visual Foundation",
  }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.reload();
  const drawerTrigger = page.getByRole("button", { name: "Open navigation" });
  await page.keyboard.press("Tab");
  await expect(drawerTrigger).toBeFocused();
  await page.keyboard.press("Enter");

  const navigation = page.getByRole("navigation", { name: "Primary" });
  const closeButton = navigation.getByRole("button", {
    name: "Close navigation",
  });
  const themeButton = navigation.getByRole("button", {
    name: "Use dark theme",
  });
  await expect(navigation).toHaveAttribute("data-drawer-state", "open");
  await expect(page.getByRole("main")).toHaveAttribute("inert", "");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(themeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(navigation).toHaveAttribute("data-drawer-state", "closed");
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
  await expect(drawerTrigger).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(closeButton).toBeFocused();
  const contextLink = navigation.getByRole("link", { name: "Current task" });
  await tabTo(page, contextLink);
  await expect(contextLink).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/tasks\/[^/]+\/handoff$/);
  await expect(navigation).toHaveAttribute("data-drawer-state", "closed");
  await expect(drawerTrigger).toBeFocused();
  await expect(page.getByRole("heading", {
    name: "Verify deterministic browser journeys",
  })).toBeVisible();
});

const openDesktopAiConnections = async (page: Page): Promise<void> => {
  await exchangeSession(page);
  await page.goto("/settings/ai");
  await expect(page.getByRole("heading", { name: "Set up with AI" }))
    .toBeVisible();
};

const unexpectedProfileToken =
  "intentarc-e2e-unexpected-profile-token-7f9a6c31";

const desktopTest = test.extend<{ desktopPage: Page }>({
  desktopPage: async ({ page }, use) => {
    await page.addInitScript((adversarialToken) => {
      (window as typeof window & {
        __intentArcCatalogListCalls?: number;
      }).__intentArcCatalogListCalls = 0;
      const automatic = [
        {
          adapterId: "codex" as const,
          status: "not_connected" as const,
          availability: "setup_required" as const,
          availabilityReason: "cli_missing" as const,
          version: null,
          profileId: null,
        },
        {
          adapterId: "claude-code" as const,
          status: "not_connected" as const,
          availability: "not_detected" as const,
          availabilityReason: "not_installed" as const,
          version: null,
          profileId: null,
        },
      ];
      const manual: Array<{
        id: string;
        label: string;
        profileId: string;
        state: "setup_created";
        createdAt: string;
      }> = [];
      window.intentArcDesktop = {
        ai: {
          list: async () => {
            const fixtureWindow = window as typeof window & {
              __intentArcCatalogListCalls?: number;
            };
            fixtureWindow.__intentArcCatalogListCalls =
              (fixtureWindow.__intentArcCatalogListCalls ?? 0) + 1;
            return { automatic, manual };
          },
          createManual: async ({ label }) => {
            const setup = {
              id: "fixture-manual-connection",
              label,
              profileId: "fixture-safe-profile",
              state: "setup_created" as const,
              createdAt: "2026-08-01T12:00:00.000Z",
              command: "IntentArc Bridge.exe",
              args: [
                "--connection",
                "fixture-manual-connection",
              ] as const,
            };
            manual.push(setup);
            const response = {
              ...setup,
              profileToken: adversarialToken,
            };
            (window as typeof window & {
              __intentArcLastManualSetup?: Record<string, unknown>;
            }).__intentArcLastManualSetup = response;
            return response;
          },
          removeManual: async (id) => {
            const index = manual.findIndex((connection) =>
              connection.id === id
            );
            if (index >= 0) manual.splice(index, 1);
            return { id };
          },
          connect: async (adapterId) => ({
            adapterId,
            status: "connected" as const,
            profileId: "fixture-safe-profile",
            restartRequired: false,
          }),
          test: async (adapterId) => ({
            ...automatic.find((entry) => entry.adapterId === adapterId)!,
          }),
          remove: async (adapterId) => ({
            adapterId,
            status: "not_connected" as const,
            profileId: null,
          }),
          launchForProject: async ({ adapterId }) => ({
            adapterId,
            result: "manual_required" as const,
          }),
        },
        lifecycle: {
          getState: async () => ({
            archivePath: "C:\\IntentArc fixture\\intentarc.sqlite",
            onboardingCompleted: true,
            restartRequired: false,
          }),
          chooseArchive: async () => ({
            archivePath: "C:\\IntentArc fixture\\intentarc.sqlite",
            onboardingCompleted: true,
            restartRequired: false,
          }),
          completeOnboarding: async () => ({
            archivePath: "C:\\IntentArc fixture\\intentarc.sqlite",
            onboardingCompleted: true,
            restartRequired: false,
          }),
          restart: async () => ({ restarting: true as const }),
        },
        updates: {
          getStatus: async () => ({ state: "disabled" as const }),
          applyAndRestart: async () => ({ restarting: false }),
        },
      };
    }, unexpectedProfileToken);
    await use(page);
  },
});

desktopTest("shows the maintained Codex CLI guide when only Codex desktop is present", async ({
  desktopPage,
}) => {
  await openDesktopAiConnections(desktopPage);

  const codex = desktopPage.getByRole("article", { name: "Codex" });
  await expect(codex.getByText("Additional setup needed", { exact: true }))
    .toBeVisible();
  await codex.getByRole("button", { name: "How to connect Codex" }).click();
  await expect(codex.getByRole("heading", { name: "Finish setting up Codex" }))
    .toBeVisible();
  await expect(codex.getByText(/npm install -g @openai\/codex/)).toBeVisible();
  await expect(codex.getByText(/choose Check again/)).toBeVisible();
});

desktopTest("refreshes or exits through every no-ready-client recovery action", async ({
  desktopPage,
}) => {
  await openDesktopAiConnections(desktopPage);

  const recovery = desktopPage.getByRole("region", {
    name: "No automatic AI connection is ready",
  });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Check again" }))
    .toBeVisible();
  await expect(recovery.getByRole("button", { name: "Use another AI tool" }))
    .toBeVisible();
  await expect(recovery.getByRole("link", { name: "Continue without AI" }))
    .toBeVisible();
  await recovery.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => desktopPage.evaluate(() =>
    (window as typeof window & {
      __intentArcCatalogListCalls?: number;
    }).__intentArcCatalogListCalls ?? 0
  )).toBe(2);
  await expect(recovery).toBeVisible();
  await recovery.getByRole("link", { name: "Continue without AI" }).click();
  await expect(desktopPage).toHaveURL("http://127.0.0.1:47862/");
  await expect(desktopPage.getByRole("heading", { name: "Projects" }))
    .toBeVisible();
});

desktopTest("opens another AI tool setup from no-ready-client recovery", async ({
  desktopPage,
}) => {
  await openDesktopAiConnections(desktopPage);

  const recovery = desktopPage.getByRole("region", {
    name: "No automatic AI connection is ready",
  });
  await recovery.getByRole("button", { name: "Use another AI tool" }).click();
  await expect(desktopPage.getByRole("dialog", { name: "Use another AI tool" }))
    .toBeVisible();
});

desktopTest("creates generic MCP setup details without rendering a profile token", async ({
  desktopPage,
}) => {
  await openDesktopAiConnections(desktopPage);
  await desktopPage.getByRole("button", { name: "Use another AI tool" })
    .click();

  const dialog = desktopPage.getByRole("dialog", {
    name: "Use another AI tool",
  });
  await dialog.getByRole("textbox", { name: "AI client name" })
    .fill("Fixture MCP client");
  await dialog.getByRole("button", { name: "Set up an MCP client" }).click();

  await expect(dialog.getByRole("heading", { name: "Setup details created" }))
    .toBeVisible();
  const runtimeProfileToken = await desktopPage.evaluate(() => {
    const response = (window as typeof window & {
      __intentArcLastManualSetup?: Record<string, unknown>;
    }).__intentArcLastManualSetup;
    return response && Object.hasOwn(response, "profileToken")
      ? response.profileToken
      : null;
  });
  expect(runtimeProfileToken).toBe(unexpectedProfileToken);
  const commandField = dialog.getByRole("textbox", { name: "Command" });
  const argumentsField = dialog.getByRole("textbox", { name: "Arguments" });
  await expect(commandField).toHaveValue("IntentArc Bridge.exe");
  await expect(argumentsField).toHaveValue(
    "--connection fixture-manual-connection",
  );
  await expect(commandField).toHaveAttribute("readonly", "");
  await expect(argumentsField).toHaveAttribute("readonly", "");
  const visibleDialogText = await dialog.evaluate((element) =>
    (element as HTMLElement).innerText
  );
  expect(visibleDialogText).not.toContain(unexpectedProfileToken);
  const setupFieldValues = await dialog.locator("input").evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  );
  expect(setupFieldValues.join("\n")).not.toContain(unexpectedProfileToken);
  const serializedDom = await desktopPage.locator("html").evaluate((element) =>
    element.outerHTML
  );
  expect(serializedDom).not.toContain(unexpectedProfileToken);
  await expect(dialog).not.toContainText(unexpectedProfileToken);
  await expect(dialog).not.toContainText("INTENTARC_PROFILE_TOKEN");
});
