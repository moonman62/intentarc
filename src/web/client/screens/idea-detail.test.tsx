// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { IdeaDetailResponse } from "../../contracts.js";
import { IdeaDetailScreen } from "./idea-detail.js";

const timestamp = "2026-08-08T12:00:00.000Z";

const detailFixture = (
  overrides: Partial<IdeaDetailResponse> = {},
): IdeaDetailResponse => ({
  id: "idea-1",
  projectId: "project-1",
  revision: 1,
  status: "provisional",
  title: "Inspect the complete idea",
  body: "First line\nSecond line",
  sourceKind: "human",
  sourceRef: "web:idea-capture",
  createdAt: timestamp,
  updatedAt: timestamp,
  context: [{
    id: "task-1",
    kind: "task",
    title: "Verify detail",
    status: "active",
  }],
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IdeaDetailScreen", () => {
  test("renders the complete read-only idea and focused context link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(detailFixture())));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect(await screen.findByRole("heading", {
      name: "Inspect the complete idea",
    })).toBeTruthy();
    expect(screen.getByText((_, element) =>
      element?.classList.contains("idea-detail__body") &&
      element.textContent === "First line\nSecond line"
    )).toBeTruthy();
    expect(document.querySelector(".idea-detail__body")?.textContent)
      .toBe("First line\nSecond line");
    expect(screen.getByText("web:idea-capture")).toBeTruthy();
    expect(screen.getByText("Revision 1")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Task · Verify detail/ }).getAttribute("href"))
      .toBe("/projects/project-1/map?focusRecordId=task-1");
  });

  test("renders empty context and omits a null source reference", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(detailFixture({
      context: [],
      sourceRef: null,
    }))));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect(await screen.findByText("No task or component context was linked."))
      .toBeTruthy();
    expect(screen.queryByText("Source reference")).toBeNull();
  });

  test("rejects a detail response that does not match the route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(detailFixture({
      id: "idea-other",
    }))));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "another idea",
    );
  });

  test("shows a neutral missing state for a 404", async () => {
    history.replaceState(null, "", "/projects/project-1/ideas/idea-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "IDEA_NOT_FOUND",
        message: "No matching idea exists.",
        recoverable: false,
      },
    }, 404)));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect(await screen.findByRole("heading", { name: "Idea not found" }))
      .toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back to Ideas" });
    expect(backLink.getAttribute("href")).toBe("/projects/project-1/ideas");
    fireEvent.click(backLink);
    expect(window.location.pathname).toBe("/projects/project-1/ideas");
  });

  test.each([
    {
      label: "missing fields",
      payload: (() => {
        const { body: _body, ...missingBody } = detailFixture();
        return missingBody;
      })(),
    },
    {
      label: "invalid fields",
      payload: { ...detailFixture(), sourceKind: "web" },
    },
    {
      label: "extra private fields",
      payload: {
        ...detailFixture(),
        repositoryRoot: "C:/private/repository",
      },
    },
  ])("rejects contract-invalid detail payloads with $label", async ({ payload }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not read this idea.");
    expect(screen.queryByRole("button", { name: "Retry idea" })).toBeNull();
    expect(screen.queryByText("C:/private/repository")).toBeNull();
  });

  test("offers retry only for recoverable detail errors", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "IDEA_UNAVAILABLE",
          message: "The idea service is unavailable.",
          recoverable: true,
        },
      }, 503))
      .mockResolvedValueOnce(jsonResponse(detailFixture()));
    vi.stubGlobal("fetch", fetchStub);

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The idea service is unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry idea" }));
    expect(await screen.findByRole("heading", {
      name: "Inspect the complete idea",
    })).toBeTruthy();
  });

  test("sanitizes unexpected detail failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private transport detail")));

    render(<IdeaDetailScreen projectId="project-1" ideaId="idea-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read this idea.",
    );
    expect(screen.queryByText("private transport detail")).toBeNull();
  });

  test("ignores an aborted stale request after the route changes", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(jsonResponse(detailFixture({
        id: "idea-2",
        title: "Second idea",
      }))));

    const view = render(
      <IdeaDetailScreen projectId="project-1" ideaId="idea-1" />,
    );
    view.rerender(<IdeaDetailScreen projectId="project-1" ideaId="idea-2" />);

    expect(await screen.findByRole("heading", { name: "Second idea" }))
      .toBeTruthy();
    resolveFirst(jsonResponse(detailFixture({ title: "First request title" })));
    await Promise.resolve();

    expect(screen.queryByRole("heading", { name: "First request title" }))
      .toBeNull();
  });
});
