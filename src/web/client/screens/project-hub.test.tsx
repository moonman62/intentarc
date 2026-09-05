// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectRecord } from "../../../domain/index.js";
import type { HubProject } from "../../contracts.js";
import { App } from "../app.js";
import { preferenceKeys } from "../preferences.js";
import { ProjectHub, selectActiveProject } from "./project-hub.js";

const timestamp = "2026-07-29T12:00:00.000Z";

const recordFixture = (
  id: string,
  title: string,
  status: ProjectRecord["status"] = "active",
): ProjectRecord => ({
  id,
  projectId: "example-game",
  kind: "task",
  status,
  title,
  body: "",
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const projectFixture = ({
  id,
  name,
  updatedAt = timestamp,
  task = null,
  attention = null,
  pendingProposalCount = 0,
}: {
  id: string;
  name: string;
  updatedAt?: string;
  task?: ProjectRecord | null;
  attention?: ProjectRecord | null;
  pendingProposalCount?: number;
}): HubProject => ({
  project: {
    id,
    name,
    revision: 3,
    primaryRepositoryPath: `C:\\projects\\${id}`,
    createdAt: timestamp,
    updatedAt,
  },
  recordsByKind: {},
  currentOutcome: null,
  currentTask: task,
  attention,
  pendingProposalCount,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const installProjectsResponse = (projects: HubProject[]) => {
  const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ projects }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectHub", () => {
  test("offers concise creation and import actions when the archive is empty", async () => {
    installProjectsResponse([]);

    render(<ProjectHub />);

    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start new" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import Project" })).toBeTruthy();
    expect(screen.queryByText(/Continue where the intent is clear/i)).toBeNull();
    expect(screen.queryByText(/return to the work that matters/i)).toBeNull();
  });

  test("shows the preferred project first with traceable state and one Open action", async () => {
    const exampleGame = projectFixture({
      id: "example-game",
      name: "Example Game",
      updatedAt: "2026-07-28T12:00:00.000Z",
      task: recordFixture(
        "verify-seeds",
        "Verify deterministic encounter seeds",
      ),
    });
    const newer = projectFixture({
      id: "newer",
      name: "Newer project",
      updatedAt: "2026-07-29T13:00:00.000Z",
    });
    localStorage.setItem(preferenceKeys.activeProject, "example-game");
    installProjectsResponse([newer, exampleGame]);

    render(<ProjectHub />);

    expect(await screen.findByRole("heading", {
      name: "Projects",
    })).toBeTruthy();
    const projects = screen.getByRole("list", { name: "Projects" });
    const [preferredRow] = within(projects).getAllByRole("listitem");
    expect(preferredRow?.textContent).toContain("Example Game");
    expect(preferredRow?.textContent).toContain("Verify deterministic encounter seeds");
    expect(preferredRow?.textContent).toContain(
      "Last activity: Jul 28, 2026",
    );
    expect(within(preferredRow!).getByText("Jul 28, 2026").tagName).toBe(
      "TIME",
    );
    expect(
      within(preferredRow!).getByText("Jul 28, 2026").getAttribute("dateTime"),
    ).toBe("2026-07-28T12:00:00.000Z");
    const openPreferredProject = within(preferredRow!).getByRole("link", {
      name: "Open Example Game",
    });
    expect(openPreferredProject).toBeTruthy();
    expect(openPreferredProject.getAttribute("aria-current")).toBeNull();
    expect(within(preferredRow!).getAllByRole("link")).toHaveLength(1);
    expect(preferredRow?.textContent).not.toContain("proposal");
    expect(preferredRow?.textContent).not.toContain("Repository");
  });

  test("uses the project name for its accessible Open action", async () => {
    installProjectsResponse([
      projectFixture({ id: "intentarc", name: "IntentArc" }),
    ]);

    render(<ProjectHub />);

    expect(await screen.findByRole("link", {
      name: "Open IntentArc",
    })).toBeTruthy();
  });

  test("falls back to the most recently updated project for a stale preference", async () => {
    localStorage.setItem(preferenceKeys.activeProject, "missing");
    installProjectsResponse([
      projectFixture({
        id: "older",
        name: "Older",
        updatedAt: "2026-07-27T12:00:00.000Z",
      }),
      projectFixture({
        id: "newest",
        name: "Newest",
        updatedAt: "2026-07-29T12:00:00.000Z",
      }),
    ]);

    render(<ProjectHub />);

    expect(
      await screen.findByRole("link", { name: "Open Newest" }),
    ).toBeTruthy();
  });

  test("selects deterministically when project update times match", () => {
    const beta = projectFixture({ id: "beta", name: "Beta" });
    const alpha = projectFixture({ id: "alpha", name: "Alpha" });

    expect(selectActiveProject([beta, alpha], null)?.project.id).toBe("alpha");
  });

  test("stores the active project before continuing to its implemented home", async () => {
    const user = userEvent.setup();
    installProjectsResponse([
      projectFixture({ id: "example/game", name: "Example Game" }),
    ]);

    render(<ProjectHub />);
    await user.click(
      await screen.findByRole("link", { name: "Open Example Game" }),
    );

    expect(localStorage.getItem(preferenceKeys.activeProject)).toBe(
      "example/game",
    );
    expect(location.pathname).toBe("/projects/example%2Fgame");
  });

  test("names attention as status without a derived project score", async () => {
    installProjectsResponse([
      projectFixture({
        id: "example-game",
        name: "Example Game",
        attention: recordFixture(
          "verify-seeds",
          "Verify deterministic encounter seeds",
          "blocked",
        ),
        pendingProposalCount: 2,
      }),
    ]);

    render(<ProjectHub />);

    expect(await screen.findByText(
      "Needs attention: Verify deterministic encounter seeds",
    )).toBeTruthy();
    expect(screen.queryByText("2 proposals awaiting review")).toBeNull();
    expect(screen.queryByText(/health/i)).toBeNull();
  });

  test("validates a project name and posts the optional repository path", async () => {
    const user = userEvent.setup();
    const createdProject = projectFixture({
      id: "new-project",
      name: "New project",
    }).project;
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [] }))
      .mockResolvedValueOnce(jsonResponse({ project: createdProject }));
    vi.stubGlobal("fetch", fetchStub);

    render(<ProjectHub />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    const name = screen.getByRole("textbox", { name: "Project name" });
    expect(document.activeElement).toBe(name);

    await user.type(name, "   ");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a project name",
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);

    await user.clear(name);
    await user.type(name, "  New project  ");
    await user.type(
      screen.getByRole("textbox", { name: "Repository path (optional)" }),
      "  C:\\projects\\new-project  ",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    const [, postInit] = fetchStub.mock.calls[1] as [string, RequestInit];
    expect(fetchStub.mock.calls[1]?.[0]).toBe("/api/projects");
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(String(postInit.body))).toEqual({
      name: "New project",
      primaryRepositoryPath: "C:\\projects\\new-project",
    });
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBe(
      "new-project",
    );
    expect(location.pathname).toBe("/projects/new-project");
  });

  test("returns focus to the exact empty-state trigger when the dialog closes", async () => {
    const user = userEvent.setup();
    installProjectsResponse([]);

    render(<ProjectHub />);
    const trigger = await screen.findByRole("button", { name: "Start new" });
    screen.getByRole("link", { name: "Import Project" }).focus();
    fireEvent.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("returns focus to the exact populated-state trigger when the dialog closes", async () => {
    const user = userEvent.setup();
    installProjectsResponse([
      projectFixture({ id: "active", name: "Active project" }),
    ]);

    render(<ProjectHub />);
    const trigger = await screen.findByRole("button", { name: "Start new" });
    screen.getByRole("link", { name: "Open Active project" }).focus();
    fireEvent.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("keeps keyboard focus inside the creation dialog", async () => {
    const user = userEvent.setup();
    installProjectsResponse([]);

    render(<ProjectHub />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    const dialog = screen.getByRole("dialog");
    within(dialog).getByRole("button", { name: "Create project" }).focus();
    await user.tab();

    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", {
        name: "Close new project dialog",
      }),
    );
  });

  test("does not dismiss the dialog while project creation is pending", async () => {
    const user = userEvent.setup();
    const createdProject = projectFixture({
      id: "pending-project",
      name: "Pending project",
    }).project;
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [] }))
      .mockReturnValueOnce(postResponse));

    render(<ProjectHub />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "Pending project",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeTruthy();
    resolvePost(jsonResponse({ project: createdProject }));
    await waitFor(() =>
      expect(location.pathname).toBe("/projects/pending-project")
    );
  });

  test("keeps the application shell available while a failed fetch can retry", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new Error("Archive connection lost"))
      .mockResolvedValueOnce(jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Archive connection lost",
    );
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "No projects yet" }),
    ).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("submits null when the optional repository path is blank", async () => {
    const user = userEvent.setup();
    const createdProject = projectFixture({
      id: "notes",
      name: "Notes",
    }).project;
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [] }))
      .mockResolvedValueOnce(jsonResponse({ project: createdProject }));
    vi.stubGlobal("fetch", fetchStub);

    render(<ProjectHub />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "Notes",
    );
    fireEvent.submit(screen.getByRole("form", { name: "Start new project" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    const body = String(
      (fetchStub.mock.calls[1]?.[1] as RequestInit | undefined)?.body,
    );
    expect(JSON.parse(body)).toEqual({
      name: "Notes",
      primaryRepositoryPath: null,
    });
  });
});
