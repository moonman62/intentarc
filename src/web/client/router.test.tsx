// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cancelDeferredNavigation,
  navigate,
  registerRouteBlocker,
  replaceRoute,
  resumeDeferredNavigation,
  useLocationRoute,
  useRoute,
} from "./router.js";

afterEach(cleanup);

beforeEach(() => {
  cancelDeferredNavigation();
  history.replaceState(null, "", "/");
});

const RouteProbe = () => <output>{useRoute()}</output>;
const LocationRouteProbe = () => <output>{useLocationRoute()}</output>;

test("navigate updates history and subscribed views", () => {
  render(<RouteProbe />);

  act(() => navigate("/projects/project-one"));

  expect(location.pathname).toBe("/projects/project-one");
  expect(screen.getByText("/projects/project-one")).toBeTruthy();
});

test("replaceRoute replaces the accepted entry without adding history or traversal", () => {
  history.replaceState({ sentinel: "replace-current" }, "", "/projects/project-one/work");
  render(<LocationRouteProbe />);
  const before = history.length;
  const historyGo = vi.spyOn(history, "go");
  const popstate = vi.fn();
  window.addEventListener("popstate", popstate);
  try {
    let replaced = false;
    act(() => {
      replaced = replaceRoute("/projects/project-one/work?taskId=task-ready");
    });
    expect(replaced).toBe(true);

    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-ready");
    expect(screen.getByText("/projects/project-one/work?taskId=task-ready")).toBeTruthy();
    expect(history.state).toMatchObject({ sentinel: "replace-current" });
    expect(history.length).toBe(before);
    expect(historyGo).not.toHaveBeenCalled();
    expect(popstate).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("popstate", popstate);
    historyGo.mockRestore();
  }
});

test("a deferred replacement leaves the accepted URL intact until explicit resume", () => {
  history.replaceState({ sentinel: "deferred-replace" }, "", "/projects/project-one/work?taskId=task-missing");
  render(<LocationRouteProbe />);
  const before = history.length;
  let settled = false;
  const dispose = registerRouteBlocker(() => settled ? "allow" : "defer");
  const historyGo = vi.spyOn(history, "go");
  try {
    expect(replaceRoute("/projects/project-one/work?taskId=task-ready")).toBe(false);
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-missing");
    expect(screen.getByText("/projects/project-one/work?taskId=task-missing")).toBeTruthy();
    expect(history.length).toBe(before);
    expect(historyGo).not.toHaveBeenCalled();

    settled = true;
    let resumeResult: ReturnType<typeof resumeDeferredNavigation> | null = null;
    act(() => {
      resumeResult = resumeDeferredNavigation();
    });
    expect(resumeResult).toBe("resumed");
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-ready");
    expect(screen.getByText("/projects/project-one/work?taskId=task-ready")).toBeTruthy();
    expect(history.state).toMatchObject({ sentinel: "deferred-replace" });
    expect(history.length).toBe(before);
    expect(historyGo).not.toHaveBeenCalled();
  } finally {
    dispose();
    historyGo.mockRestore();
  }
});

test("cancels a deferred replacement without changing the accepted entry", () => {
  history.replaceState(null, "", "/projects/project-one/work?taskId=task-missing");
  render(<LocationRouteProbe />);
  const blocker = vi.fn(() => "defer" as const);
  const dispose = registerRouteBlocker(blocker);
  const historyGo = vi.spyOn(history, "go");
  try {
    expect(replaceRoute("/projects/project-one/work?taskId=task-ready")).toBe(false);
    expect(blocker).toHaveBeenCalledWith(
      "/projects/project-one/work?taskId=task-ready",
    );
    expect(resumeDeferredNavigation()).toBe("queued");
    cancelDeferredNavigation();

    expect(resumeDeferredNavigation()).toBe("none");
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-missing");
    expect(screen.getByText("/projects/project-one/work?taskId=task-missing")).toBeTruthy();
    expect(historyGo).not.toHaveBeenCalled();
  } finally {
    dispose();
    historyGo.mockRestore();
  }
});

test("competing navigation cannot replace the first deferred replacement", () => {
  history.replaceState(null, "", "/projects/project-one/work?taskId=task-missing");
  render(<LocationRouteProbe />);
  let settled = false;
  const blocker = vi.fn(() => settled ? "allow" as const : "defer" as const);
  const dispose = registerRouteBlocker(blocker);
  try {
    expect(replaceRoute("/projects/project-one/work?taskId=task-ready")).toBe(false);
    expect(navigate("/projects/project-two")).toBe(false);
    expect(replaceRoute("/projects/project-one/work?taskId=task-next")).toBe(false);
    expect(blocker).toHaveBeenCalledTimes(1);

    settled = true;
    expect(resumeDeferredNavigation()).toBe("resumed");
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-ready");
  } finally {
    dispose();
  }
});

test("disposing the blocker lets the exact deferred replacement resume", () => {
  history.replaceState(null, "", "/projects/project-one/work?taskId=task-missing");
  render(<LocationRouteProbe />);
  const dispose = registerRouteBlocker(() => "defer");

  expect(replaceRoute("/projects/project-one/work?taskId=task-ready")).toBe(false);
  dispose();

  let resumeResult: ReturnType<typeof resumeDeferredNavigation> | null = null;
  act(() => {
    resumeResult = resumeDeferredNavigation();
  });
  expect(resumeResult).toBe("resumed");
  expect(`${location.pathname}${location.search}`)
    .toBe("/projects/project-one/work?taskId=task-ready");
  expect(screen.getByText("/projects/project-one/work?taskId=task-ready")).toBeTruthy();
});

test("a blocker can explicitly reject a previously deferred replacement", () => {
  history.replaceState(null, "", "/projects/project-one/work?taskId=task-missing");
  render(<LocationRouteProbe />);
  let decision: "defer" | "block" = "defer";
  const dispose = registerRouteBlocker(() => decision);
  try {
    expect(replaceRoute("/projects/project-one/work?taskId=task-ready")).toBe(false);
    decision = "block";

    expect(resumeDeferredNavigation()).toBe("blocked");
    expect(resumeDeferredNavigation()).toBe("none");
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-missing");
  } finally {
    dispose();
  }
});

test("popstate updates subscribed views", () => {
  render(<RouteProbe />);

  act(() => {
    history.pushState(null, "", "/projects");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  expect(screen.getByText("/projects")).toBeTruthy();
});

test("exposes pathname-only route semantics when a query is present", () => {
  history.replaceState(null, "", "/projects?sort=recent");

  render(<RouteProbe />);

  expect(screen.getByText("/projects")).toBeTruthy();
});

test("a denied programmatic navigation leaves history and subscribers unchanged", () => {
  render(<RouteProbe />);
  const dispose = registerRouteBlocker(() => "block");

  let navigationAccepted = true;
  act(() => {
    navigationAccepted = navigate("/projects/project-1/ideas");
  });
  expect(navigationAccepted).toBe(false);
  expect(location.pathname).toBe("/");
  expect(screen.getByText("/")).toBeTruthy();

  dispose();

  act(() => {
    navigationAccepted = navigate("/projects/project-1/ideas");
  });
  expect(navigationAccepted).toBe(true);
  expect(location.pathname).toBe("/projects/project-1/ideas");
  expect(screen.getByText("/projects/project-1/ideas")).toBeTruthy();
});

test("a second route blocker cannot replace the active blocker", () => {
  const firstBlocker = vi.fn(() => "block" as const);
  const dispose = registerRouteBlocker(firstBlocker);

  expect(() => registerRouteBlocker(() => "allow")).toThrow(
    "A route blocker is already registered",
  );
  expect(navigate("/projects/project-1/ideas")).toBe(false);
  expect(firstBlocker).toHaveBeenCalledWith("/projects/project-1/ideas");

  dispose();
});

test("a denied Back traversal preserves the forward stack and entry state", async () => {
  history.replaceState({ sentinel: "root" }, "", "/");
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    navigate("/projects/project-2");
    navigate("/projects/project-3");
  });
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  const historyLength = history.length;
  const routeChange = vi.fn();
  window.addEventListener("intentarc:route-change", routeChange);
  const blocker = vi.fn(() => "block" as const);
  const dispose = registerRouteBlocker(blocker);

  act(() => history.back());

  await waitFor(() => expect(blocker).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  expect(screen.getByText("/projects/project-2")).toBeTruthy();
  expect(history.length).toBe(historyLength);
  expect(routeChange).not.toHaveBeenCalled();

  dispose();
  act(() => history.forward());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-3"));
  act(() => history.go(-3));
  await waitFor(() => expect(location.pathname).toBe("/"));
  expect(history.state).toMatchObject({ sentinel: "root" });
  window.removeEventListener("intentarc:route-change", routeChange);
});

test("a denied Forward traversal restores the accepted entry without replacing its state", async () => {
  history.replaceState({ sentinel: "accepted" }, "", "/");
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    navigate("/projects/project-2");
  });
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  history.replaceState({ ...history.state, sentinel: "middle" }, "", location.href);
  const historyLength = history.length;
  const blocker = vi.fn(() => "block" as const);
  const dispose = registerRouteBlocker(blocker);

  act(() => history.forward());

  await waitFor(() => expect(blocker).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  expect(history.state).toMatchObject({ sentinel: "middle" });
  expect(history.length).toBe(historyLength);
  dispose();
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/"));
  expect(history.state).toMatchObject({ sentinel: "accepted" });
});

test("resumes the first deferred programmatic navigation as one push", () => {
  history.pushState(null, "", "/programmatic-start");
  history.replaceState(null, "", "/");
  render(<RouteProbe />);
  let settled = false;
  const dispose = registerRouteBlocker(() => settled ? "allow" : "defer");
  const before = history.length;

  expect(navigate("/projects/project-1/ideas")).toBe(false);
  expect(navigate("/projects/project-2")).toBe(false);
  settled = true;

  expect(resumeDeferredNavigation()).toBe("resumed");
  expect(location.pathname).toBe("/projects/project-1/ideas");
  expect(history.length).toBe(before + 1);
  dispose();
});

test.each([
  {
    direction: "Back",
    acceptedPath: "/projects/project-2",
    acceptedSentinel: "accepted-back",
    targetPath: "/projects/project-1",
    targetSentinel: "target-back",
    traverse: () => history.back(),
    opposite: () => history.forward(),
  },
  {
    direction: "Forward",
    acceptedPath: "/projects/project-1",
    acceptedSentinel: "accepted-forward",
    targetPath: "/projects/project-2",
    targetSentinel: "target-forward",
    traverse: () => history.forward(),
    opposite: () => history.back(),
  },
] as const)(
  "queues settlement during $direction restoration and resumes the exact target entry",
  async ({
    direction,
    acceptedPath,
    acceptedSentinel,
    targetPath,
    targetSentinel,
    traverse,
    opposite,
  }) => {
    render(<RouteProbe />);
    act(() => {
      navigate("/projects/project-1");
      history.replaceState(
        { ...history.state, sentinel: direction === "Back" ? targetSentinel : acceptedSentinel },
        "",
        location.href,
      );
      navigate("/projects/project-2");
      history.replaceState(
        { ...history.state, sentinel: direction === "Back" ? acceptedSentinel : targetSentinel },
        "",
        location.href,
      );
    });
    if (direction === "Forward") {
      act(() => history.back());
      await waitFor(() => expect(location.pathname).toBe(acceptedPath));
    }
    const before = history.length;
    let settled = false;
    let resumeResult: ReturnType<typeof resumeDeferredNavigation> | null = null;
    const blocker = vi.fn(() => {
      if (settled) return "allow" as const;
      queueMicrotask(() => {
        settled = true;
        resumeResult = resumeDeferredNavigation();
      });
      return "defer" as const;
    });
    const dispose = registerRouteBlocker(blocker);

    act(traverse);
    await waitFor(() => expect(blocker).toHaveBeenCalledWith(targetPath));
    await waitFor(() => expect(resumeResult).toBe("queued"));

    await waitFor(() => expect(location.pathname).toBe(targetPath));
    expect(history.state).toMatchObject({ sentinel: targetSentinel });
    expect(history.length).toBe(before);

    dispose();
    act(opposite);
    await waitFor(() => expect(location.pathname).toBe(acceptedPath));
    expect(history.state).toMatchObject({ sentinel: acceptedSentinel });
  },
);

test("cancelling a deferred traversal preserves the accepted entry and stack", async () => {
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    history.replaceState(
      { ...history.state, sentinel: "cancel-target" },
      "",
      location.href,
    );
    navigate("/projects/project-2");
    history.replaceState(
      { ...history.state, sentinel: "cancel-accepted" },
      "",
      location.href,
    );
  });
  const before = history.length;
  const blocker = vi.fn(() => "defer" as const);
  const dispose = registerRouteBlocker(blocker);

  act(() => history.back());
  await waitFor(() => expect(blocker).toHaveBeenCalledWith("/projects/project-1"));
  cancelDeferredNavigation();
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));

  expect(history.state).toMatchObject({ sentinel: "cancel-accepted" });
  expect(history.length).toBe(before);
  expect(resumeDeferredNavigation()).toBe("none");

  dispose();
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  expect(history.state).toMatchObject({ sentinel: "cancel-target" });
});

test("later Forward and push attempts cannot replace the first deferred Back target", async () => {
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    history.replaceState(
      { ...history.state, sentinel: "first-target" },
      "",
      location.href,
    );
    navigate("/projects/project-2");
    history.replaceState(
      { ...history.state, sentinel: "accepted" },
      "",
      location.href,
    );
    navigate("/projects/project-3");
    history.replaceState(
      { ...history.state, sentinel: "later-target" },
      "",
      location.href,
    );
  });
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  let settled = false;
  const blocker = vi.fn(() => settled ? "allow" as const : "defer" as const);
  const dispose = registerRouteBlocker(blocker);
  let sameTargetPushAccepted: boolean | null = null;
  const repeatVisibleTarget = () => {
    if (location.pathname !== "/projects/project-1") return;
    sameTargetPushAccepted = navigate("/projects/project-1");
  };
  window.addEventListener("popstate", repeatVisibleTarget);

  act(() => history.back());
  await waitFor(() => expect(blocker).toHaveBeenCalledWith("/projects/project-1"));
  expect(sameTargetPushAccepted).toBe(false);
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  expect(navigate("/projects/replacement-push")).toBe(false);
  const laterTraversalPaths: string[] = [];
  const recordLaterTraversal = () => laterTraversalPaths.push(location.pathname);
  window.addEventListener("popstate", recordLaterTraversal);
  act(() => history.forward());
  await waitFor(() => expect(laterTraversalPaths).toEqual([
    "/projects/project-3",
    "/projects/project-2",
  ]));
  expect(blocker).toHaveBeenCalledTimes(1);
  window.removeEventListener("popstate", recordLaterTraversal);

  settled = true;
  expect(resumeDeferredNavigation()).toBe("resumed");
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  expect(history.state).toMatchObject({ sentinel: "first-target" });
  window.removeEventListener("popstate", repeatVisibleTarget);
  dispose();
});

test("rejects later allowed push and traversal so a deferred Forward entry cannot be replaced", async () => {
  history.pushState(null, "", "/finding-one-start");
  history.replaceState(null, "", "/");
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    history.replaceState(
      { ...history.state, sentinel: "later-traversal" },
      "",
      location.href,
    );
    navigate("/projects/project-2");
    history.replaceState(
      { ...history.state, sentinel: "deferred-accepted" },
      "",
      location.href,
    );
    navigate("/projects/project-3");
    history.replaceState(
      { ...history.state, sentinel: "deferred-forward-target" },
      "",
      location.href,
    );
  });
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  const beforeLength = history.length;
  let settled = false;
  const blocker = vi.fn(() => settled ? "allow" as const : "defer" as const);
  const dispose = registerRouteBlocker(blocker);

  act(() => history.forward());
  await waitFor(() => expect(blocker).toHaveBeenCalledWith("/projects/project-3"));
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  expect(history.state).toMatchObject({ sentinel: "deferred-accepted" });
  settled = true;

  expect(navigate("/projects/replacement-push")).toBe(false);
  const laterPopstates: string[] = [];
  const recordLaterPopstate = () => laterPopstates.push(location.pathname);
  window.addEventListener("popstate", recordLaterPopstate);
  act(() => history.back());
  await waitFor(() => expect(laterPopstates).toEqual([
    "/projects/project-1",
    "/projects/project-2",
  ]));
  expect(location.pathname).toBe("/projects/project-2");
  expect(history.state).toMatchObject({ sentinel: "deferred-accepted" });
  expect(history.length).toBe(beforeLength);

  expect(resumeDeferredNavigation()).toBe("resumed");
  await waitFor(() => expect(location.pathname).toBe("/projects/project-3"));
  expect(history.state).toMatchObject({ sentinel: "deferred-forward-target" });
  expect(history.length).toBe(beforeLength);
  window.removeEventListener("popstate", recordLaterPopstate);

  dispose();
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  expect(history.state).toMatchObject({ sentinel: "deferred-accepted" });
});

test("cancelling an issued traversal restores the accepted entry without a route-change leak", async () => {
  history.pushState(null, "", "/finding-two-start");
  history.replaceState(null, "", "/");
  render(<RouteProbe />);
  act(() => {
    navigate("/projects/project-1");
    history.replaceState(
      { ...history.state, sentinel: "issued-accepted" },
      "",
      location.href,
    );
    navigate("/projects/project-2");
    history.replaceState(
      { ...history.state, sentinel: "issued-target" },
      "",
      location.href,
    );
  });
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  const beforeLength = history.length;
  let settled = false;
  const blocker = vi.fn(() => settled ? "allow" as const : "defer" as const);
  const dispose = registerRouteBlocker(blocker);

  act(() => history.forward());
  await waitFor(() => expect(blocker).toHaveBeenCalledWith("/projects/project-2"));
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  settled = true;
  const routeChange = vi.fn();
  const popstatePaths: string[] = [];
  const recordPopstate = () => popstatePaths.push(location.pathname);
  window.addEventListener("intentarc:route-change", routeChange);
  window.addEventListener("popstate", recordPopstate);

  expect(resumeDeferredNavigation()).toBe("resumed");
  cancelDeferredNavigation();
  expect(navigate("/projects/replacement-push")).toBe(false);
  await waitFor(() => expect(popstatePaths).toEqual([
    "/projects/project-2",
    "/projects/project-1",
  ]));

  expect(location.pathname).toBe("/projects/project-1");
  expect(history.state).toMatchObject({ sentinel: "issued-accepted" });
  expect(history.length).toBe(beforeLength);
  expect(routeChange).not.toHaveBeenCalled();
  expect(resumeDeferredNavigation()).toBe("none");
  window.removeEventListener("intentarc:route-change", routeChange);
  window.removeEventListener("popstate", recordPopstate);

  dispose();
  act(() => history.forward());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-2"));
  expect(history.state).toMatchObject({ sentinel: "issued-target" });
  expect(history.length).toBe(beforeLength);
  act(() => history.back());
  await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
  expect(history.state).toMatchObject({ sentinel: "issued-accepted" });
});
