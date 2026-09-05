// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  IdeaCaptureResponse,
  IdeaInboxItemDto,
  IdeaInboxPageResponse,
} from "../../contracts.js";
import {
  IdeaCaptureProvider,
  useIdeaCapture,
} from "../components/idea-capture.js";
import { IdeasScreen } from "./ideas.js";

const timestamp = "2026-08-08T12:00:00.000Z";

const ideaFixture = (
  id: string,
  title: string,
  context: IdeaInboxItemDto["context"] = [],
): IdeaInboxItemDto => ({
  id,
  projectId: "project-1",
  revision: 1,
  status: "provisional",
  title,
  bodyPreview: `${title} body preview`,
  sourceKind: "human",
  sourceRef: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  context,
});

const pageFixture = (
  overrides: Partial<IdeaInboxPageResponse> = {},
): IdeaInboxPageResponse => ({
  projectId: "project-1",
  projectRevision: 4,
  items: [],
  hasMore: false,
  nextCursor: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const captureProject = {
  id: "project-1",
  name: "IntentArc",
  revision: 4,
  context: [{
    id: "task-1",
    kind: "task" as const,
    title: "Current task",
  }],
};

const renderIdeas = (projectId = "project-1") => render(
  <IdeaCaptureProvider
    project={captureProject}
    onProjectRevision={() => undefined}
    refreshProject={async () => 4}
  >
    <IdeasScreen projectId={projectId} />
  </IdeaCaptureProvider>,
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IdeasScreen", () => {
  test("shows a project-bound loading state while the inbox request is pending", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    renderIdeas();

    expect(screen.getByRole("heading", { name: "Ideas" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Reading the idea inbox",
    );
    expect(screen.queryByText(
      "Keep captured thoughts in view without changing their source record.",
    )).toBeNull();
  });

  test("shows a recoverable error and retries the inbox request", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "IDEA_INBOX_UNAVAILABLE",
          message: "The idea inbox could not be read.",
          recoverable: true,
        },
      }, 503))
      .mockResolvedValueOnce(jsonResponse(pageFixture()));
    vi.stubGlobal("fetch", fetchStub);

    renderIdeas();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The idea inbox could not be read.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry ideas" }));

    expect(await screen.findByText("No ideas captured yet.")).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("opens the same capture drawer from the header and empty state", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(pageFixture())),
    );

    renderIdeas();

    expect(await screen.findByText("No ideas captured yet.")).toBeTruthy();
    const header = document.querySelector(".ideas-header") as HTMLElement;
    await user.click(within(header).getByRole("button", { name: "Capture idea" }));
    expect(screen.getByRole("dialog", { name: "Capture idea" })).toBeTruthy();
    await user.keyboard("{Escape}");

    const emptyState = screen.getByRole("status");
    await user.click(within(emptyState).getByRole("button", {
      name: "Capture idea",
    }));
    expect(screen.getByRole("dialog", { name: "Capture idea" })).toBeTruthy();
  });

  test("preserves server order and renders preview, status, time, and context", async () => {
    const currentTask = {
      id: "task-1",
      kind: "task" as const,
      title: "Verify deterministic encounter seeds",
      status: "active" as const,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(pageFixture({
      items: [
        ideaFixture("idea-new", "Newest idea", [currentTask]),
        ideaFixture("idea-old", "Older idea"),
      ],
    }))));

    renderIdeas();

    expect(await screen.findByRole("heading", { name: "Ideas" })).toBeTruthy();
    const list = await screen.findByRole("list", { name: "Idea inbox" });
    expect(within(list).getAllByRole("article").map((item) => item.textContent))
      .toEqual([
        expect.stringContaining("Newest idea"),
        expect.stringContaining("Older idea"),
      ]);
    expect(within(list).getByText("Newest idea body preview")).toBeTruthy();
    expect(within(list).getAllByText("Provisional")).toHaveLength(2);
    expect(within(list).getByText("Task")).toBeTruthy();
    expect(within(list).getAllByRole("time")[0]?.getAttribute("datetime"))
      .toBe(timestamp);
  });

  test("names an idea card from its title", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(pageFixture({
      items: [ideaFixture("idea-named", "Named idea")],
    }))));

    renderIdeas();

    expect(await screen.findByRole("article", { name: "Named idea" }))
      .toBeTruthy();
  });

  test("idea detail links navigate within the custom router", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(pageFixture({
      items: [ideaFixture("idea-1", "First idea")],
    })))));

    renderIdeas();

    const article = await screen.findByRole("article", { name: "First idea" });
    expect(article.getAttribute("role")).toBeNull();
    expect(within(article).getByRole("link", { name: "First idea" }).getAttribute("href"))
      .toBe("/projects/project-1/ideas/idea-1");
    expect(within(article).getByRole("link", { name: "View idea" }).getAttribute("href"))
      .toBe("/projects/project-1/ideas/idea-1");

    await user.click(within(article).getByRole("link", { name: "First idea" }));
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-1/ideas/idea-1");

    history.replaceState(null, "", "/projects/project-1/ideas");
    cleanup();
    renderIdeas();
    const secondArticle = await screen.findByRole("article", {
      name: "First idea",
    });
    await user.click(within(secondArticle).getByRole("link", {
      name: "View idea",
    }));
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-1/ideas/idea-1");
  });

  test("labels linked task context as Task without inferring currentness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(pageFixture({
      items: [ideaFixture("idea-context", "Contextual idea", [{
        id: "task-context",
        kind: "task",
        title: "Verify deterministic encounter seeds",
        status: "active",
      }])],
    }))));

    renderIdeas();

    const article = await screen.findByRole("article", {
      name: "Contextual idea",
    });
    expect(within(article).getByText("Task")).toBeTruthy();
    expect(within(article).getByText("Verify deterministic encounter seeds"))
      .toBeTruthy();
  });

  test("rejects a cross-project response without rendering its ideas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(pageFixture({
      projectId: "project-2",
      items: [{
        ...ideaFixture("foreign-idea", "Foreign idea"),
        projectId: "project-2",
      }],
    }))));

    renderIdeas();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "another project",
    );
    expect(screen.queryByText("Foreign idea")).toBeNull();
  });

  test("appends unique ideas from an opaque cursor and stops at the last page", async () => {
    let resolveNextPage: ((response: Response) => void) | undefined;
    const nextPage = new Promise<Response>((resolve) => {
      resolveNextPage = resolve;
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pageFixture({
        items: [
          ideaFixture("idea-new", "Newest idea"),
          ideaFixture("idea-old", "Older idea"),
        ],
        hasMore: true,
        nextCursor: "opaque+/=cursor",
      })))
      .mockReturnValueOnce(nextPage);
    vi.stubGlobal("fetch", fetchStub);

    renderIdeas();

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    loadMore.focus();
    fireEvent.click(loadMore);

    expect(loadMore.hasAttribute("disabled")).toBe(true);
    expect(fetchStub.mock.calls[1]?.[0]).toBe(
      "/api/projects/project-1/ideas?cursor=opaque%2B%2F%3Dcursor",
    );

    resolveNextPage?.(jsonResponse(pageFixture({
      items: [
        ideaFixture("idea-old", "Older idea"),
        ideaFixture("idea-oldest", "Oldest idea"),
      ],
    })));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Load more",
    })).toBeNull());
    const completedControl = screen.getByRole("button", {
      name: "All ideas loaded",
    });
    expect(document.activeElement).toBe(completedControl);
    expect(screen.getByRole("status").textContent).toContain(
      "1 more idea loaded. All ideas are loaded.",
    );
    expect(
      within(screen.getByRole("list", { name: "Idea inbox" }))
        .getAllByRole("article")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Newest idea"),
      expect.stringContaining("Older idea"),
      expect.stringContaining("Oldest idea"),
    ]);
  });

  test("refreshes an already-mounted inbox after capturing from its header", async () => {
    const capturedItem = ideaFixture(
      "idea-on-route",
      "Captured on ideas route",
    );
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pageFixture()))
      .mockResolvedValueOnce(jsonResponse({
        projectRevision: 5,
        item: capturedItem,
      } satisfies IdeaCaptureResponse))
      .mockResolvedValueOnce(jsonResponse(pageFixture({
        projectRevision: 5,
        items: [capturedItem],
      })));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderIdeas();
    await screen.findByText("No ideas captured yet.");

    const header = document.querySelector(".ideas-header") as HTMLElement;
    await user.click(within(header).getByRole("button", { name: "Capture idea" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Captured on ideas route",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(await screen.findByText("Captured on ideas route")).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  test("keeps a just-saved idea visible when the initial inbox refresh fails", async () => {
    const capturedItem = ideaFixture(
      "idea-captured",
      "Captured before inbox refresh",
      [{
        id: "task-1",
        kind: "task",
        title: "Current task",
        status: "active",
      }],
    );
    const captureResponse: IdeaCaptureResponse = {
      projectRevision: 5,
      item: capturedItem,
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(captureResponse))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "IDEA_INBOX_UNAVAILABLE",
          message: "The inbox refresh failed.",
          recoverable: true,
        },
      }, 503))
      .mockResolvedValueOnce(jsonResponse(pageFixture({
        projectRevision: 5,
        items: [capturedItem],
      })));
    vi.stubGlobal("fetch", fetchStub);

    function InboxAfterCapture() {
      const capture = useIdeaCapture();
      const [showIdeas, setShowIdeas] = useState(false);
      return (
        <>
          <button type="button" onClick={capture.open}>Start capture</button>
          <button type="button" onClick={() => setShowIdeas(true)}>Show ideas</button>
          <output data-testid="latest-capture">
            {capture.latestCapture?.item.id ?? ""}
          </output>
          {showIdeas ? <IdeasScreen projectId="project-1" /> : null}
        </>
      );
    }

    function CaptureFlow() {
      const [project, setProject] = useState(captureProject);
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={(projectId, revision) => {
            setProject((current) => current.id === projectId
              ? { ...current, revision }
              : current);
          }}
          refreshProject={async () => project.revision}
        >
          <InboxAfterCapture />
        </IdeaCaptureProvider>
      );
    }

    const user = userEvent.setup();
    render(<CaptureFlow />);
    await user.click(screen.getByRole("button", { name: "Start capture" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Captured before inbox refresh",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");
    await user.click(screen.getByRole("button", { name: "Close idea capture" }));
    await user.click(screen.getByRole("button", { name: "Show ideas" }));

    expect(await screen.findByText(
      "Idea saved. The inbox could not refresh yet.",
    )).toBeTruthy();
    expect(screen.getByText("Captured before inbox refresh")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry ideas" })).toBeTruthy();
    expect(screen.getByTestId("latest-capture").textContent).toBe(
      "idea-captured",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry ideas" }));
    await waitFor(() => {
      expect(screen.getByTestId("latest-capture").textContent).toBe("");
    });
    expect(screen.getByText("Captured before inbox refresh")).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  test("clears the latest capture when a pagination page contains its record", async () => {
    const capturedItem = ideaFixture(
      "idea-on-next-page",
      "Captured on the next page",
    );
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        projectRevision: 5,
        item: capturedItem,
      } satisfies IdeaCaptureResponse))
      .mockResolvedValueOnce(jsonResponse(pageFixture({
        projectRevision: 5,
        items: [ideaFixture("idea-newer", "Newer idea")],
        hasMore: true,
        nextCursor: "next-page",
      })))
      .mockResolvedValueOnce(jsonResponse(pageFixture({
        projectRevision: 5,
        items: [capturedItem],
      })));
    vi.stubGlobal("fetch", fetchStub);

    function InboxAfterCapture() {
      const capture = useIdeaCapture();
      const [showIdeas, setShowIdeas] = useState(false);
      return (
        <>
          <button type="button" onClick={capture.open}>Start capture</button>
          <button type="button" onClick={() => setShowIdeas(true)}>Show ideas</button>
          <output data-testid="latest-pagination-capture">
            {capture.latestCapture?.item.id ?? ""}
          </output>
          {showIdeas ? <IdeasScreen projectId="project-1" /> : null}
        </>
      );
    }

    function CaptureFlow() {
      const [project, setProject] = useState(captureProject);
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={(projectId, revision) => {
            setProject((current) => current.id === projectId
              ? { ...current, revision }
              : current);
          }}
          refreshProject={async () => project.revision}
        >
          <InboxAfterCapture />
        </IdeaCaptureProvider>
      );
    }

    const user = userEvent.setup();
    render(<CaptureFlow />);
    await user.click(screen.getByRole("button", { name: "Start capture" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Captured on the next page",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");
    await user.click(screen.getByRole("button", { name: "Close idea capture" }));
    await user.click(screen.getByRole("button", { name: "Show ideas" }));

    expect(await screen.findByText("Newer idea")).toBeTruthy();
    expect(screen.getByTestId("latest-pagination-capture").textContent).toBe(
      "idea-on-next-page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(screen.getByTestId("latest-pagination-capture").textContent)
        .toBe("");
    });
    expect(screen.getByText("Captured on the next page")).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });
});
