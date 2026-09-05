// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { IdeaCaptureResponse } from "../../contracts.js";
import {
  cancelDeferredNavigation,
  navigate,
  resumeDeferredNavigation,
} from "../router.js";
import {
  type IdeaCaptureProject,
  IdeaCaptureProvider,
  useIdeaCapture,
} from "./idea-capture.js";

const projectFixture: IdeaCaptureProject = {
  id: "project-1",
  name: "IntentArc",
  revision: 4,
  context: [{
    id: "task-1",
    kind: "task",
    title: "Current task",
  }],
};

const captureFixture = (projectRevision = 5): IdeaCaptureResponse => ({
  projectRevision,
  item: {
    id: "idea-1",
    projectId: "project-1",
    revision: 1,
    status: "provisional",
    title: "Keep the capture path lightweight",
    bodyPreview: "Keep the capture path lightweight",
    sourceKind: "manual",
    sourceRef: null,
    createdAt: "2026-08-08T10:00:00.000Z",
    updatedAt: "2026-08-08T10:00:00.000Z",
    context: [{
      id: "task-1",
      kind: "task",
      title: "Current task",
      status: "active",
    }],
  },
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface HarnessProps {
  initialProject?: IdeaCaptureProject | null;
  onProjectRevision?: ReturnType<typeof vi.fn>;
  refreshProject?: ReturnType<typeof vi.fn>;
  createCaptureRequestId?: () => string;
  children?: ReactNode;
}

function CaptureControls({ children }: { children?: ReactNode }) {
  const capture = useIdeaCapture();
  return (
    <div data-testid="application">
      {capture.available
        ? <button type="button" onClick={capture.open}>Open capture</button>
        : null}
      {children}
    </div>
  );
}

function Harness({
  initialProject = projectFixture,
  onProjectRevision = vi.fn(),
  refreshProject = vi.fn(async () => 5),
  createCaptureRequestId = () => "capture-request-1",
  children,
}: HarnessProps) {
  const [project, setProject] = useState(initialProject);
  return (
    <IdeaCaptureProvider
      project={project}
      onProjectRevision={(projectId, revision) => {
        onProjectRevision(projectId, revision);
        setProject((current) => current?.id === projectId
          ? { ...current, revision }
          : current);
      }}
      refreshProject={async (projectId) => {
        const revision = await refreshProject(projectId) as number;
        setProject((current) => current?.id === projectId
          ? { ...current, revision }
          : current);
        return revision;
      }}
      createCaptureRequestId={createCaptureRequestId}
    >
      <CaptureControls>{children}</CaptureControls>
    </IdeaCaptureProvider>
  );
}

const openCapture = async (): Promise<HTMLTextAreaElement> => {
  await userEvent.click(screen.getByRole("button", { name: "Open capture" }));
  return screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement;
};

const saveDraft = async (draft = "Keep the capture path lightweight") => {
  const textbox = await openCapture();
  await userEvent.type(textbox, draft);
  await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
};

const traversalCases = [
  {
    direction: "Back",
    traverse: () => history.back(),
    opposite: () => history.forward(),
  },
  {
    direction: "Forward",
    traverse: () => history.forward(),
    opposite: () => history.back(),
  },
] as const;

const prepareDeferredTraversal = async (direction: "Back" | "Forward") => {
  const acceptedPath = "/projects/project-1";
  const acceptedSentinel = `accepted-${direction.toLowerCase()}`;
  const targetPath = "/projects/project-outside";
  const targetSentinel = `target-${direction.toLowerCase()}`;
  if (direction === "Back") {
    navigate(targetPath);
    history.replaceState(
      { ...history.state, sentinel: targetSentinel },
      "",
      location.href,
    );
    navigate(acceptedPath);
    history.replaceState(
      { ...history.state, sentinel: acceptedSentinel },
      "",
      location.href,
    );
  } else {
    navigate(acceptedPath);
    history.replaceState(
      { ...history.state, sentinel: acceptedSentinel },
      "",
      location.href,
    );
    navigate(targetPath);
    history.replaceState(
      { ...history.state, sentinel: targetSentinel },
      "",
      location.href,
    );
    history.back();
    await waitFor(() => expect(location.pathname).toBe(acceptedPath));
  }
  return { acceptedPath, acceptedSentinel, targetPath, targetSentinel };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  cancelDeferredNavigation();
  history.pushState(null, "", "/__idea-capture-test-start");
  history.replaceState(null, "", "/");
});

describe("IdeaCaptureProvider", () => {
  test("does not expose capture or project context without an active project", () => {
    render(<Harness initialProject={null} />);

    expect(screen.queryByRole("button", { name: "Open capture" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Current task")).toBeNull();
  });

  test("focuses the idea field when opened", async () => {
    render(<Harness />);

    const textbox = await openCapture();

    expect(document.activeElement).toBe(textbox);
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe(
      "idea-capture-title",
    );
  });

  test("loops Tab and Shift+Tab at the drawer boundaries", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open capture" }));
    await user.type(screen.getByRole("textbox", { name: "Idea" }), "Focusable idea");
    const close = screen.getByRole("button", { name: "Close idea capture" });
    const save = screen.getByRole("button", { name: "Save idea" });

    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);

    await user.tab();
    expect(document.activeElement).toBe(close);
  });

  test("Escape closes and restores focus while idle", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open capture" });
    await user.click(trigger);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("Escape is ignored while a save is submitting", async () => {
    let resolveSave!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));
    const user = userEvent.setup();
    render(<Harness />);
    const textbox = await openCapture();
    await user.type(textbox, "Still submitting");
    await user.click(screen.getByRole("button", { name: "Save idea" }));

    const guardedClose = screen.getByRole("button", {
      name: "Close idea capture",
    });
    expect(guardedClose.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(guardedClose);
    await user.tab();
    expect(document.activeElement).toBe(guardedClose);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(guardedClose);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveSave(response(captureFixture()));
    expect(await screen.findByText(
      "Idea saved. Current work is unchanged.",
    )).toBeTruthy();
  });

  test.each(traversalCases)(
    "settlement during the first deferred $direction popstate resumes the exact entry",
    async ({ direction, traverse, opposite }) => {
      const {
        acceptedPath,
        acceptedSentinel,
        targetPath,
        targetSentinel,
      } = await prepareDeferredTraversal(direction);
      let resolveSave!: (value: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
        resolveSave = resolve;
      })));
      const confirm = vi.fn(() => true);
      vi.stubGlobal("confirm", confirm);
      const onProjectRevision = vi.fn();
      const visitedPaths: string[] = [];
      let settled = false;
      const settleOnFirstTarget = () => {
        visitedPaths.push(location.pathname);
        if (location.pathname !== targetPath || settled) return;
        settled = true;
        resolveSave(response(captureFixture()));
      };
      window.addEventListener("popstate", settleOnFirstTarget);
      render(<Harness onProjectRevision={onProjectRevision} />);
      await saveDraft("Finish this authoritative capture before leaving.");
      expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
      const beforeLength = history.length;

      act(traverse);
      await waitFor(() => {
        expect(onProjectRevision).toHaveBeenCalledWith("project-1", 5);
        expect(visitedPaths.filter((path) => path === targetPath)).toHaveLength(2);
      });
      expect(location.pathname).toBe(targetPath);
      expect(history.state).toMatchObject({ sentinel: targetSentinel });
      expect(history.length).toBe(beforeLength);
      expect(confirm).not.toHaveBeenCalled();
      window.removeEventListener("popstate", settleOnFirstTarget);

      act(opposite);
      await waitFor(() => expect(location.pathname).toBe(acceptedPath));
      expect(history.state).toMatchObject({ sentinel: acceptedSentinel });
    },
  );

  test.each(traversalCases.flatMap((traversal) => [
    { ...traversal, discard: "accepts" as const, confirmResult: true },
    { ...traversal, discard: "declines" as const, confirmResult: false },
  ]))(
    "a deferred $direction HTTP 503 $discard discard only after restoration",
    async ({ direction, traverse, opposite, discard, confirmResult }) => {
      const {
        acceptedPath,
        acceptedSentinel,
        targetPath,
        targetSentinel,
      } = await prepareDeferredTraversal(direction);
      let resolveSave!: (value: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
        resolveSave = resolve;
      })));
      let confirmPath: string | null = null;
      let confirmState: unknown = null;
      const confirm = vi.fn(() => {
        confirmPath = location.pathname;
        confirmState = history.state;
        return confirmResult;
      });
      vi.stubGlobal("confirm", confirm);
      const visitedPaths: string[] = [];
      let settled = false;
      const settleOnFirstTarget = () => {
        visitedPaths.push(location.pathname);
        if (location.pathname !== targetPath || settled) return;
        settled = true;
        resolveSave(response({
          error: {
            code: "service_unavailable",
            message: "Retry the same submission.",
            recoverable: true,
          },
        }, 503));
      };
      window.addEventListener("popstate", settleOnFirstTarget);
      render(<Harness />);
      const draft = `Preserve the ${direction} 503 draft.`;
      await saveDraft(draft);
      const beforeLength = history.length;

      act(traverse);
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(
        "Discard this unsaved idea?",
      ));
      expect(confirmPath).toBe(acceptedPath);
      expect(confirmState).toMatchObject({ sentinel: acceptedSentinel });
      expect(history.length).toBe(beforeLength);

      if (discard === "accepts") {
        await waitFor(() => {
          expect(visitedPaths.filter((path) => path === targetPath)).toHaveLength(2);
        });
        expect(location.pathname).toBe(targetPath);
        expect(history.state).toMatchObject({ sentinel: targetSentinel });
        expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
          .toBe("");
        window.removeEventListener("popstate", settleOnFirstTarget);
        act(opposite);
        await waitFor(() => expect(location.pathname).toBe(acceptedPath));
        expect(history.state).toMatchObject({ sentinel: acceptedSentinel });
      } else {
        expect(location.pathname).toBe(acceptedPath);
        expect(history.state).toMatchObject({ sentinel: acceptedSentinel });
        expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
          .toBe(draft);
        expect(resumeDeferredNavigation()).toBe("none");
        window.removeEventListener("popstate", settleOnFirstTarget);
      }
    },
  );

  test("successful settlement resumes deferred programmatic navigation as one push", async () => {
    navigate("/projects/project-1");
    let resolveSave!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<Harness />);
    await saveDraft("One push after settlement.");
    const beforeLength = history.length;

    expect(navigate("/projects/project-outside")).toBe(false);
    resolveSave(response(captureFixture()));

    await waitFor(() => expect(location.pathname).toBe("/projects/project-outside"));
    expect(history.length).toBe(beforeLength + 1);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("a project change cancels deferred navigation before later settlement can leak", async () => {
    navigate("/projects/project-1");
    let resolveSave!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));
    let replaceProject!: (project: IdeaCaptureProject) => void;

    function ProjectChangeHarness() {
      const [project, setProject] = useState(projectFixture);
      replaceProject = setProject;
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={() => undefined}
          refreshProject={async () => project.revision}
        >
          <CaptureControls />
        </IdeaCaptureProvider>
      );
    }

    render(<ProjectChangeHarness />);
    await saveDraft("Cancel this deferred route on project change.");
    expect(navigate("/projects/project-outside")).toBe(false);

    act(() => replaceProject({
      id: "project-2",
      name: "Second project",
      revision: 1,
      context: [],
    }));
    expect(resumeDeferredNavigation()).toBe("none");
    expect(location.pathname).toBe("/projects/project-1");

    resolveSave(response(captureFixture()));
    await act(async () => await Promise.resolve());
    expect(location.pathname).toBe("/projects/project-1");
  });

  test("provider unmount cancels deferred navigation before a later router resume", async () => {
    navigate("/projects/project-1");
    let resolveSave!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));
    const rendered = render(<Harness />);
    await saveDraft("Cancel this deferred route on unmount.");
    expect(navigate("/projects/project-outside")).toBe(false);

    rendered.unmount();
    expect(resumeDeferredNavigation()).toBe("none");
    expect(location.pathname).toBe("/projects/project-1");

    resolveSave(response(captureFixture()));
    await act(async () => await Promise.resolve());
    expect(location.pathname).toBe("/projects/project-1");
  });

  test("blocks empty and oversized ideas before making a request", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    render(<Harness />);
    const textbox = await openCapture();

    const save = screen.getByRole("button", { name: "Save idea" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(textbox.closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter an idea before saving.",
    );

    fireEvent.change(textbox, { target: { value: "x".repeat(16_385) } });
    expect((screen.getByRole("button", {
      name: "Save idea",
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("enables submission only for a normalized draft within the supported length", async () => {
    render(<Harness />);
    const textbox = await openCapture();
    const save = screen.getByRole("button", { name: "Save idea" }) as HTMLButtonElement;

    expect(save.disabled).toBe(true);
    fireEvent.change(textbox, { target: { value: "  \n  " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(textbox, { target: { value: "x".repeat(16_385) } });
    expect(save.disabled).toBe(true);
    fireEvent.change(textbox, { target: { value: "  Save this idea.  " } });
    expect(save.disabled).toBe(false);
  });

  test("posts the project revision, request identity, full draft, and current task context", async () => {
    const fetchStub = vi.fn(() => Promise.resolve(response(captureFixture())));
    vi.stubGlobal("fetch", fetchStub);
    const onProjectRevision = vi.fn();
    render(<Harness onProjectRevision={onProjectRevision} />);

    await saveDraft("A precise draft");
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [path, init] = fetchStub.mock.calls[0]!;
    expect(path).toBe("/api/projects/project-1/ideas");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      expectedProjectRevision: 4,
      captureRequestId: "capture-request-1",
      text: "A precise draft",
      contextRecordIds: ["task-1"],
    });
    expect(onProjectRevision).toHaveBeenCalledWith("project-1", 5);
  });

  test("moves focus to the saved-state actions after a successful request", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(captureFixture()))));
    render(<Harness />);

    await saveDraft();
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Capture another" }),
    );
  });

  test("coalesces duplicate Save clicks into one request", async () => {
    let resolveSave!: (value: Response) => void;
    const fetchStub = vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    }));
    vi.stubGlobal("fetch", fetchStub);
    render(<Harness />);
    const textbox = await openCapture();
    fireEvent.change(textbox, { target: { value: "One request" } });
    const save = screen.getByRole("button", { name: "Save idea" });

    fireEvent.click(save);
    fireEvent.click(save);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    resolveSave(response(captureFixture()));
    expect(await screen.findByText(
      "Idea saved. Current work is unchanged.",
    )).toBeTruthy();
  });

  test("Capture another clears the draft but retains project context", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(captureFixture()))));
    render(<Harness />);
    await saveDraft();
    await screen.findByText("Idea saved. Current work is unchanged.");

    await userEvent.click(screen.getByRole("button", { name: "Capture another" }));

    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe("");
    expect(screen.getByText("Current task")).toBeTruthy();
  });

  test("rotates request IDs after success and Capture another", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response(captureFixture()))
      .mockResolvedValueOnce(response(captureFixture(6)));
    vi.stubGlobal("fetch", fetchStub);
    const ids = ["capture-request-1", "capture-request-2", "capture-request-3"];
    render(<Harness createCaptureRequestId={() => ids.shift() ?? "unexpected-id"} />);

    await saveDraft("First idea");
    await screen.findByText("Idea saved. Current work is unchanged.");
    await userEvent.click(screen.getByRole("button", { name: "Capture another" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Idea" }), "Second idea");
    await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(JSON.parse(String((fetchStub.mock.calls[0]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-3" });
  });

  test("View ideas navigates only after the successful revision callback", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(captureFixture()))));
    const onProjectRevision = vi.fn(() => {
      expect(location.pathname).toBe("/");
    });
    render(<Harness onProjectRevision={onProjectRevision} />);
    await saveDraft();
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(onProjectRevision).toHaveBeenCalledWith("project-1", 5);
    expect(location.pathname).toBe("/");
    await userEvent.click(screen.getByRole("button", { name: "View ideas" }));
    expect(location.pathname).toBe("/projects/project-1/ideas");
  });

  test("a service failure preserves the full draft for an explicit retry", async () => {
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(captureFixture()));
    vi.stubGlobal("fetch", fetchStub);
    render(<Harness />);
    const draft = "  Keep all of this draft intact.  ";
    await saveDraft(draft);

    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe(draft);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retry" }).classList)
      .toContain("idea-capture-action--primary");
    expect(screen.getByRole("button", { name: "Cancel" }).classList)
      .toContain("idea-capture-action--secondary");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(
      "Idea saved. Current work is unchanged.",
    )).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchStub.mock.calls[0]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
  });

  test.each([
    ["transport response loss", () => Promise.reject(new TypeError("response lost"))],
    ["service unavailability", () => Promise.resolve(response({
      error: {
        code: "service_unavailable",
        message: "Retry the same submission.",
        recoverable: true,
      },
    }, 503))],
    ["internal service failure", () => Promise.resolve(response({
      error: {
        code: "internal_error",
        message: "The response could not be completed.",
        recoverable: false,
      },
    }, 500))],
  ])("retries the exact attempted POST after ambiguous %s and an intervening project update", async (
    _label,
    failFirst,
  ) => {
    const fetchStub = vi.fn()
      .mockImplementationOnce(failFirst)
      .mockResolvedValueOnce(response(captureFixture(5)));
    vi.stubGlobal("fetch", fetchStub);
    const revisionSpy = vi.fn();
    let updateProject!: (project: IdeaCaptureProject) => void;

    function UpdatedProjectHarness() {
      const [project, setProject] = useState(projectFixture);
      updateProject = setProject;
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={revisionSpy}
          refreshProject={async () => project.revision}
          createCaptureRequestId={() => "capture-request-1"}
        >
          <CaptureControls />
        </IdeaCaptureProvider>
      );
    }

    render(<UpdatedProjectHarness />);
    await saveDraft("Replay the exact attempted payload.");
    await screen.findByRole("alert");
    act(() => updateProject({
      ...projectFixture,
      revision: 8,
      context: [{
        id: "task-refreshed",
        kind: "task",
        title: "Intervening project context",
      }],
    }));

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    const bodies = fetchStub.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body))
    );
    expect(bodies[0]).toEqual({
      expectedProjectRevision: 4,
      captureRequestId: "capture-request-1",
      text: "Replay the exact attempted payload.",
      contextRecordIds: ["task-1"],
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(revisionSpy).toHaveBeenCalledWith("project-1", 5);
  });

  test("keeps the same request ID across an explicit HTTP 503 retry", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response({
        error: {
          code: "service_unavailable",
          message: "Retry the same submission.",
          recoverable: true,
        },
      }, 503))
      .mockResolvedValueOnce(response(captureFixture()));
    vi.stubGlobal("fetch", fetchStub);
    render(<Harness />);

    await saveDraft("Retry a 503 without duplicating.");
    await screen.findByRole("alert");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(JSON.parse(String((fetchStub.mock.calls[0]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
  });

  test("a revision conflict refreshes authoritative state and waits for Retry", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response({
        error: {
          code: "project_revision_conflict",
          message: "Project changed.",
          recoverable: true,
        },
      }, 409))
      .mockResolvedValueOnce(response(captureFixture(6)));
    vi.stubGlobal("fetch", fetchStub);
    const refreshProject = vi.fn(async () => 5);
    render(<Harness refreshProject={refreshProject} />);
    await saveDraft("Conflict-safe draft");

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save idea" })).toBeNull();
    expect(refreshProject).toHaveBeenCalledWith("project-1");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe("Conflict-safe draft");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(
      "Idea saved. Current work is unchanged.",
    )).toBeTruthy();
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ expectedProjectRevision: 5, captureRequestId: "capture-request-1" });
  });

  test("invalid context requires a user refresh and then an explicit retry", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response({
        error: {
          code: "idea_context_invalid",
          message: "The context changed.",
          recoverable: true,
        },
      }, 409))
      .mockResolvedValueOnce(response(captureFixture(6)));
    vi.stubGlobal("fetch", fetchStub);
    const refreshProject = vi.fn(async () => 5);
    render(<Harness refreshProject={refreshProject} />);
    await saveDraft("Context-safe draft");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The project context changed.",
    );
    expect(screen.getByRole("button", { name: "Refresh context" }).classList)
      .toContain("idea-capture-action--primary");
    expect(screen.getByRole("button", { name: "Cancel" }).classList)
      .toContain("idea-capture-action--secondary");
    expect(screen.queryByRole("button", { name: "Save idea" })).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe("Context-safe draft");

    fireEvent.change(screen.getByRole("textbox", { name: "Idea" }), {
      target: { value: "Edited context-safe draft" },
    });
    expect(screen.getByRole("button", { name: "Refresh context" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save idea" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Refresh context" }));
    expect(refreshProject).toHaveBeenCalledWith("project-1");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save idea" })).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(
      "Idea saved. Current work is unchanged.",
    )).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
  });

  test("a normalized non-empty draft guards only navigation out of its project", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<Harness />);
    const textbox = await openCapture();
    fireEvent.change(textbox, { target: { value: "Unsaved idea" } });

    await waitFor(() => {
      expect(navigate("/projects/project-1/ideas")).toBe(true);
    });
    expect(location.pathname).toBe("/projects/project-1/ideas");
    expect(navigate("/projects/project-2")).toBe(false);
    expect(window.confirm).toHaveBeenCalledWith("Discard this unsaved idea?");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);

    fireEvent.change(textbox, { target: { value: "" } });
    await waitFor(() => {
      expect(navigate("/projects/project-2")).toBe(true);
    });
  });

  test("treats a malformed programmatic project destination as outside the active project", async () => {
    navigate("/projects/project-1");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness />);
    const textbox = await openCapture();
    fireEvent.change(textbox, { target: { value: "Keep this malformed-route draft." } });

    let navigated: boolean | undefined;
    expect(() => {
      navigated = navigate("/projects/%E0%A4%A/ideas");
    }).not.toThrow();

    expect(navigated).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard this unsaved idea?");
    expect(location.pathname).toBe("/projects/project-1");
    expect(textbox.value).toBe("Keep this malformed-route draft.");
  });

  test("restores the accepted entry when malformed Back navigation is declined", async () => {
    const malformedTarget = "/projects/%E0%A4%A/ideas";
    const acceptedPath = "/projects/project-1";
    navigate(malformedTarget);
    history.replaceState(
      { ...history.state, sentinel: "malformed-target" },
      "",
      location.href,
    );
    navigate(acceptedPath);
    history.replaceState(
      { ...history.state, sentinel: "accepted-project" },
      "",
      location.href,
    );
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness />);
    const textbox = await openCapture();
    fireEvent.change(textbox, { target: { value: "Restore this draft safely." } });
    const beforeLength = history.length;

    act(() => history.back());

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith("Discard this unsaved idea?");
    });
    await waitFor(() => expect(location.pathname).toBe(acceptedPath));
    expect(history.state).toMatchObject({ sentinel: "accepted-project" });
    expect(history.length).toBe(beforeLength);
    expect(textbox.value).toBe("Restore this draft safely.");
  });

  test("declining discard preserves and accepting discard rotates the request ID", async () => {
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(captureFixture()));
    vi.stubGlobal("fetch", fetchStub);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const ids = ["capture-request-1", "capture-request-2"];
    render(<Harness createCaptureRequestId={() => ids.shift() ?? "unexpected-id"} />);

    await saveDraft("Keep this when discard is declined.");
    await screen.findByRole("alert");
    expect(navigate("/projects/project-2")).toBe(false);
    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe("Keep this when discard is declined.");

    confirm.mockReturnValue(true);
    expect(navigate("/projects/project-2")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Idea" }) as HTMLTextAreaElement).value)
      .toBe("");
    await userEvent.type(screen.getByRole("textbox", { name: "Idea" }), "New draft after discard.");
    await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-2" });
  });

  test("rotates the request identity after a semantic edit following a failed submission", async () => {
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(captureFixture()));
    vi.stubGlobal("fetch", fetchStub);
    const ids = ["capture-request-1", "capture-request-2", "capture-request-3"];
    render(<Harness createCaptureRequestId={() => ids.shift() ?? "unexpected-id"} />);
    await saveDraft("Original semantic draft");
    await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("textbox", { name: "Idea" }), {
      target: { value: "Changed semantic draft" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Idea" }), {
      target: { value: "Changed semantic draft again" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    expect(JSON.parse(String((fetchStub.mock.calls[0]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-1" });
    expect(JSON.parse(String((fetchStub.mock.calls[1]![1] as RequestInit).body)))
      .toMatchObject({ captureRequestId: "capture-request-3" });
  });

  test("keeps whitespace-only drafts unguarded and exposes required busy form semantics", async () => {
    let resolveSave!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));
    render(<Harness />);
    const textbox = await openCapture();
    expect(textbox.required).toBe(true);
    expect(textbox.getAttribute("aria-required")).toBe("true");
    fireEvent.change(textbox, { target: { value: "  \n  " } });
    expect(navigate("/projects/project-2")).toBe(true);
    fireEvent.change(textbox, { target: { value: "Real draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    resolveSave(response(captureFixture()));
  });

  test("makes the application subtree inert only while the drawer is open", async () => {
    render(<Harness />);
    const application = screen.getByTestId("application").parentElement!;
    expect(application.hasAttribute("inert")).toBe(false);

    await openCapture();
    expect(application.hasAttribute("inert")).toBe(true);
    expect(application.contains(screen.getByRole("dialog"))).toBe(false);

    await userEvent.keyboard("{Escape}");
    expect(application.hasAttribute("inert")).toBe(false);
  });

  test("never commits an open drawer under a replacement project and restores its opener", async () => {
    const replacementProject: IdeaCaptureProject = {
      id: "project-2",
      name: "Second project",
      revision: 7,
      context: [{
        id: "task-2",
        kind: "task",
        title: "Second project task",
      }],
    };
    const committedDialogText: Array<string | null> = [];
    let replaceProject!: (project: IdeaCaptureProject | null) => void;

    function ProjectCommitProbe({ projectId }: { projectId: string | null }) {
      useLayoutEffect(() => {
        if (projectId !== replacementProject.id) return;
        committedDialogText.push(
          document.querySelector<HTMLElement>('[role="dialog"]')?.textContent ?? null,
        );
      }, [projectId]);
      return null;
    }

    function TransitionHarness() {
      const [project, setProject] = useState<IdeaCaptureProject | null>(projectFixture);
      replaceProject = setProject;
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={() => undefined}
          refreshProject={async () => project?.revision ?? 0}
        >
          <CaptureControls>
            <ProjectCommitProbe projectId={project?.id ?? null} />
          </CaptureControls>
        </IdeaCaptureProvider>
      );
    }

    render(<TransitionHarness />);
    const opener = screen.getByRole("button", { name: "Open capture" });
    const textbox = await openCapture();
    fireEvent.change(textbox, { target: { value: "Owned by project one" } });

    act(() => replaceProject(replacementProject));

    expect(committedDialogText).toEqual([null]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("focuses the stable application fallback when a project transition removes the opener", async () => {
    let replaceProject!: (project: IdeaCaptureProject | null) => void;

    function TransitionHarness() {
      const [project, setProject] = useState<IdeaCaptureProject | null>(projectFixture);
      replaceProject = setProject;
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={() => undefined}
          refreshProject={async () => project?.revision ?? 0}
        >
          <CaptureControls />
        </IdeaCaptureProvider>
      );
    }

    render(<TransitionHarness />);
    const application = screen.getByTestId("application").parentElement!;
    await openCapture();

    act(() => replaceProject(null));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(application);
  });

  test("aborts an obsolete project request without applying its response", async () => {
    let resolveSave!: (value: Response) => void;
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_path: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveSave = resolve;
      });
    }));
    const revisionSpy = vi.fn();

    function SwitchingHarness() {
      const [project, setProject] = useState(projectFixture);
      return (
        <IdeaCaptureProvider
          project={project}
          onProjectRevision={revisionSpy}
          refreshProject={async () => project.revision}
        >
          <CaptureControls>
            <button
              type="button"
              onClick={() => setProject({
                id: "project-2",
                name: "Second project",
                revision: 7,
                context: [],
              })}
            >
              Switch project
            </button>
          </CaptureControls>
        </IdeaCaptureProvider>
      );
    }

    render(<SwitchingHarness />);
    const textbox = await openCapture();
    await userEvent.type(textbox, "Bound to project one");
    await userEvent.click(screen.getByRole("button", { name: "Save idea" }));
    await userEvent.click(screen.getByRole("button", { name: "Switch project" }));

    expect(capturedSignal?.aborted).toBe(true);
    await act(async () => {
      resolveSave(response(captureFixture()));
      await Promise.resolve();
    });
    expect(revisionSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Idea saved. Current work is unchanged.")).toBeNull();
  });
});
