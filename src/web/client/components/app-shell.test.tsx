// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "./app-shell.js";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (this.closest("[inert]")) return;
    nativeFocus.call(this, options);
  });
});

describe("AppShell", () => {
  test("organizes active project navigation into two ordered groups", () => {
    render(
      <AppShell activeProject={{
        id: "project-one",
        name: "IntentArc",
        currentTaskId: "task-one",
      }}>
        <p>Project stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Information" })).toBeTruthy();
    expect(
      Array.from(
        screen.getByRole("navigation").querySelectorAll(".nav-link"),
        (link) => link.textContent?.trim(),
      ),
    ).toEqual([
      "Work Queue",
      "Current Task",
      "Proposals",
      "Ideas",
      "Import Project",
      "Overview",
      "Map",
      "Documentation",
      "Repository",
    ]);
    expect(screen.getByRole("link", {
      name: "IntentArc project switcher",
    })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Preferences" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Capture idea" })).toBeNull();
  });

  test("persists the collapsed navigation preference", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Project stage</p></AppShell>);

    await user.click(
      screen.getByRole("button", { name: "Collapse navigation" }),
    );

    expect(
      screen.getByRole("navigation").getAttribute("data-sidebar-state"),
    ).toBe("collapsed");
    expect(localStorage.getItem("intentarc.sidebar")).toBe("collapsed");
  });

  test("offers project destinations only when a project is selected", () => {
    const { rerender } = render(
      <AppShell><p>Projects stage</p></AppShell>,
    );

    expect(screen.queryByRole("link", { name: "Project One project switcher" }))
      .toBeNull();
    expect(screen.queryByRole("link", { name: "Import Project" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ideas" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Proposals" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Documentation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Repository" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Map" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Work Queue" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Current Task" })).toBeNull();

    rerender(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Project stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href"))
      .toBe("/projects/project-one/ideas");
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Documentation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Repository" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Map" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Work Queue" }).getAttribute("href"))
      .toBe("/projects/project-one/work");
    expect(screen.queryByRole("link", { name: "Current Task" })).toBeNull();

    rerender(
      <AppShell
        activeProject={{
          id: "project-one",
          name: "Project One",
          currentTaskId: "task-one",
        }}
      >
        <p>Project stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Current Task" })).toBeTruthy();
  });

  test("closes the navigation drawer on Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Project stage</p>
      </AppShell>,
    );
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    await user.click(trigger);
    expect(
      screen.getByRole("navigation").getAttribute("data-drawer-state"),
    ).toBe("open");
    expect(screen.getByRole("main").hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close navigation" }),
    );

    await user.keyboard("{Escape}");

    expect(
      screen.getByRole("navigation").getAttribute("data-drawer-state"),
    ).toBe("closed");
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("main").hasAttribute("inert")).toBe(false);
  });

  test("contains forward and reverse Tab focus inside the open drawer", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Project stage</p></AppShell>);
    const navigation = screen.getByRole("navigation");
    const close = within(navigation).getByRole("button", {
      name: "Close navigation",
    });
    const theme = within(navigation).getByRole("button", {
      name: "Use dark theme",
    });

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(theme);

    await user.tab();
    expect(document.activeElement).toBe(close);
  });

  test("returns focus to the drawer trigger after selecting a destination", async () => {
    const user = userEvent.setup();
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Project stage</p>
      </AppShell>,
    );
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    await user.click(trigger);
    await user.click(
      within(screen.getByRole("navigation")).getByRole("link", {
        name: "Import Project",
      }),
    );

    expect(
      screen.getByRole("navigation").getAttribute("data-drawer-state"),
    ).toBe("closed");
    expect(document.activeElement).toBe(trigger);
  });

  test("opens the mobile drawer expanded when the saved desktop rail is collapsed", async () => {
    localStorage.setItem("intentarc.sidebar", "collapsed");
    const user = userEvent.setup();
    render(<AppShell><p>Project stage</p></AppShell>);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(
      screen.getByRole("navigation").getAttribute("data-sidebar-state"),
    ).toBe("expanded");
    expect(localStorage.getItem("intentarc.sidebar")).toBe("collapsed");
  });

  test("closes the mobile drawer when the viewport crosses to desktop", async () => {
    let mobile = true;
    let mobileChange: ((event: MediaQueryListEvent) => void) | undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(max-width: 759px)" ? mobile : false,
        media: query,
        onchange: null,
        addEventListener: (
          type: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => {
          if (query === "(max-width: 759px)" && type === "change") {
            mobileChange = listener;
          }
        },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const user = userEvent.setup();
    render(<AppShell><p>Project stage</p></AppShell>);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("main").hasAttribute("inert")).toBe(true);

    mobile = false;
    act(() => mobileChange?.({ matches: false } as MediaQueryListEvent));

    expect(
      screen.getByRole("navigation").getAttribute("data-drawer-state"),
    ).toBe("closed");
    expect(screen.getByRole("main").hasAttribute("inert")).toBe(false);
  });

  test("marks the project switcher current for the projects pathname", () => {
    history.replaceState(null, "", "/projects?sort=recent");

    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Projects stage</p>
      </AppShell>,
    );

    expect(
      screen.getByRole("link", { name: "Project One project switcher" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
  });

  test("keeps Documentation current while a document is selected", () => {
    history.replaceState(
      null,
      "",
      "/projects/project-one/documentation/node-readme",
    );
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Documentation stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Documentation" }).getAttribute(
      "aria-current",
    )).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).hasAttribute(
      "aria-current",
    )).toBe(false);
  });

  test("marks Ideas current for the active project's inbox", () => {
    history.replaceState(null, "", "/projects/project-one/ideas");
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Ideas stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute(
      "aria-current",
    )).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).hasAttribute(
      "aria-current",
    )).toBe(false);
  });

  test("keeps Map current while a focused record is encoded in the URL", () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-one");
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Map stage</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Map" }).getAttribute("aria-current")).toBe("page");
  });

  test("marks Work Queue current only on the project work route", () => {
    history.replaceState(null, "", "/projects/project-one/work");
    render(
      <AppShell activeProject={{
        id: "project-one",
        name: "Project One",
        currentTaskId: "task-one",
      }}>
        <p>Work Queue stage</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Work Queue" }).getAttribute(
      "aria-current",
    )).toBe("page");
    expect(screen.getByRole("link", { name: "Current Task" }).getAttribute(
      "aria-current",
    )).toBeNull();
  });

  test("keeps Repository current while a selected node is encoded in the URL", () => {
    history.replaceState(null, "", "/projects/project-one/repository?nodeId=node-readme");
    render(
      <AppShell activeProject={{ id: "project-one", name: "Project One" }}>
        <p>Repository stage</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Repository" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Documentation" }).getAttribute("aria-current")).toBeNull();
  });

  test("renders navigation without a decorative continuity trail", () => {
    history.replaceState(null, "", "/projects/import");

    render(<AppShell><p>Import stage</p></AppShell>);

    const navigation = screen.getByRole("navigation");
    expect(within(navigation).queryByText("Continuity archive")).toBeNull();
    expect(navigation.querySelector(".continuity-path")).toBeNull();
    expect(navigation.querySelector(".continuity-stages")).toBeNull();
    expect(navigation.querySelector(".nav-link__node")).toBeNull();
  });
});
