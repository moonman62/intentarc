import { useSyncExternalStore } from "react";

const routeChangeEvent = "intentarc:route-change";

export type RouteBlockerDecision = "allow" | "block" | "defer";
export type RouteBlocker = (nextPath: string) => RouteBlockerDecision;
export type ResumeDeferredNavigationResult =
  | "none"
  | "queued"
  | "resumed"
  | "blocked";

type DeferredNavigation =
  | { kind: "push"; path: string }
  | { kind: "replace"; path: string }
  | { kind: "traverse"; path: string; targetIndex: number };

let routeBlocker: RouteBlocker | null = null;
let acceptedLocationRoute: string | null = null;
let acceptedHistoryIndex: number | null = null;
let currentHistoryIndex: number | null = null;
let restoringHistoryIndex: number | null = null;
let deferredNavigation: DeferredNavigation | null = null;
let resumeRequested = false;
let allowedTraversalIndex: number | null = null;
let popstateInstalled = false;
const historyIndexKey = "__intentarcHistoryIndex";

export const registerRouteBlocker = (blocker: RouteBlocker): (() => void) => {
  if (routeBlocker !== null) {
    throw new Error("A route blocker is already registered");
  }
  routeBlocker = blocker;
  return () => {
    if (routeBlocker === blocker) routeBlocker = null;
  };
};

const getRawLocationRoute = (): string =>
  `${window.location.pathname}${window.location.search}`;
const getAcceptedLocationRoute = (): string =>
  historyIndexFrom(window.history.state) === null
    ? getRawLocationRoute()
    : acceptedLocationRoute ?? getRawLocationRoute();
const getAcceptedRoute = (): string => {
  const locationRoute = getAcceptedLocationRoute();
  const searchIndex = locationRoute.indexOf("?");
  return searchIndex === -1
    ? locationRoute
    : locationRoute.slice(0, searchIndex);
};
const routeDecision = (path: string): RouteBlockerDecision =>
  routeBlocker?.(path) ?? "allow";

const historyIndexFrom = (state: unknown): number | null => {
  if (typeof state !== "object" || state === null) return null;
  const index = (state as Record<string, unknown>)[historyIndexKey];
  return typeof index === "number" && Number.isSafeInteger(index)
    ? index
    : null;
};

const stateWithHistoryIndex = (state: unknown, index: number): object => ({
  ...(typeof state === "object" && state !== null ? state : {}),
  [historyIndexKey]: index,
});

const ensureCurrentHistoryEntry = (): void => {
  const existingIndex = historyIndexFrom(window.history.state);
  if (existingIndex !== null) {
    currentHistoryIndex = existingIndex;
    if (acceptedHistoryIndex === null) {
      acceptedHistoryIndex = existingIndex;
      acceptedLocationRoute = getRawLocationRoute();
    }
    return;
  }
  const index = 0;
  window.history.replaceState(
    stateWithHistoryIndex(window.history.state, index),
    "",
    getRawLocationRoute(),
  );
  currentHistoryIndex = index;
  acceptedHistoryIndex = index;
  acceptedLocationRoute = getRawLocationRoute();
  restoringHistoryIndex = null;
  allowedTraversalIndex = null;
};

const acceptTraversal = (path: string, index: number): void => {
  acceptedLocationRoute = path;
  acceptedHistoryIndex = index;
  window.dispatchEvent(new Event(routeChangeEvent));
};

const pushAcceptedRoute = (path: string): void => {
  const nextIndex = (currentHistoryIndex ?? 0) + 1;
  window.history.pushState(
    stateWithHistoryIndex(null, nextIndex),
    "",
    path,
  );
  currentHistoryIndex = nextIndex;
  acceptTraversal(path, nextIndex);
};

const replaceAcceptedRoute = (path: string): void => {
  const index = currentHistoryIndex ?? acceptedHistoryIndex ?? 0;
  window.history.replaceState(
    stateWithHistoryIndex(window.history.state, index),
    "",
    path,
  );
  currentHistoryIndex = index;
  acceptTraversal(path, index);
};

const restoreAcceptedEntry = (nextIndex: number): void => {
  if (
    acceptedHistoryIndex === null ||
    acceptedHistoryIndex === nextIndex
  ) return;
  restoringHistoryIndex = acceptedHistoryIndex;
  window.history.go(acceptedHistoryIndex - nextIndex);
};

const ensurePopstateGuard = (): void => {
  ensureCurrentHistoryEntry();
  if (popstateInstalled) return;
  popstateInstalled = true;
  window.addEventListener("popstate", (event) => {
    const nextPath = getRawLocationRoute();
    let nextIndex = historyIndexFrom(event.state);
    if (nextIndex === null) {
      nextIndex = (currentHistoryIndex ?? 0) + 1;
      window.history.replaceState(
        stateWithHistoryIndex(event.state, nextIndex),
        "",
        nextPath,
      );
    }
    currentHistoryIndex = nextIndex;
    if (
      allowedTraversalIndex !== null &&
      nextIndex === allowedTraversalIndex &&
      deferredNavigation?.kind === "traverse" &&
      deferredNavigation.targetIndex === nextIndex &&
      deferredNavigation.path === nextPath
    ) {
      allowedTraversalIndex = null;
      deferredNavigation = null;
      resumeRequested = false;
      acceptTraversal(nextPath, nextIndex);
      return;
    }
    if (restoringHistoryIndex !== null) {
      if (nextIndex === restoringHistoryIndex) {
        restoringHistoryIndex = null;
        if (resumeRequested) {
          queueMicrotask(() => {
            if (resumeRequested) resumeDeferredNavigation();
          });
        }
      } else {
        window.history.go(restoringHistoryIndex - nextIndex);
      }
      return;
    }
    if (deferredNavigation !== null) {
      restoreAcceptedEntry(nextIndex);
      return;
    }
    const decision = routeDecision(nextPath);
    if (decision !== "allow") {
      if (
        decision === "defer" &&
        deferredNavigation === null
      ) {
        deferredNavigation = {
          kind: "traverse",
          path: nextPath,
          targetIndex: nextIndex,
        };
      }
      restoreAcceptedEntry(nextIndex);
      return;
    }
    acceptTraversal(nextPath, nextIndex);
  });
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  ensurePopstateGuard();
  window.addEventListener(routeChangeEvent, onStoreChange);
  return () => {
    window.removeEventListener(routeChangeEvent, onStoreChange);
  };
};

export function navigate(path: string): boolean {
  ensurePopstateGuard();
  const currentPath = getRawLocationRoute();
  if (restoringHistoryIndex !== null) return false;
  if (deferredNavigation !== null) return false;
  if (path === currentPath) return true;
  const decision = routeDecision(path);
  if (decision === "defer") {
    if (deferredNavigation === null) {
      deferredNavigation = { kind: "push", path };
    }
    return false;
  }
  if (decision === "block") return false;
  pushAcceptedRoute(path);
  return true;
}

export function replaceRoute(path: string): boolean {
  ensurePopstateGuard();
  const currentPath = getRawLocationRoute();
  if (restoringHistoryIndex !== null) return false;
  if (deferredNavigation !== null) return false;
  if (path === currentPath) return true;
  const decision = routeDecision(path);
  if (decision === "defer") {
    deferredNavigation = { kind: "replace", path };
    return false;
  }
  if (decision === "block") return false;
  replaceAcceptedRoute(path);
  return true;
}

export function resumeDeferredNavigation(): ResumeDeferredNavigationResult {
  ensurePopstateGuard();
  if (deferredNavigation === null) return "none";
  if (restoringHistoryIndex !== null) {
    resumeRequested = true;
    return "queued";
  }
  const decision = routeDecision(deferredNavigation.path);
  if (decision === "defer") {
    resumeRequested = true;
    return "queued";
  }
  if (decision === "block") {
    deferredNavigation = null;
    resumeRequested = false;
    return "blocked";
  }
  const navigation = deferredNavigation;
  resumeRequested = false;
  if (navigation.kind === "push") {
    deferredNavigation = null;
    pushAcceptedRoute(navigation.path);
    return "resumed";
  }
  if (navigation.kind === "replace") {
    deferredNavigation = null;
    replaceAcceptedRoute(navigation.path);
    return "resumed";
  }
  if (acceptedHistoryIndex === null) {
    deferredNavigation = null;
    return "blocked";
  }
  allowedTraversalIndex = navigation.targetIndex;
  window.history.go(navigation.targetIndex - acceptedHistoryIndex);
  return "resumed";
}

export function cancelDeferredNavigation(): void {
  if (allowedTraversalIndex !== null) {
    allowedTraversalIndex = null;
    if (acceptedHistoryIndex !== null) {
      restoringHistoryIndex = acceptedHistoryIndex;
    }
  }
  deferredNavigation = null;
  resumeRequested = false;
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, getAcceptedRoute, () => "/");
}

export function useLocationRoute(): string {
  return useSyncExternalStore(
    subscribe,
    getAcceptedLocationRoute,
    () => "/",
  );
}
