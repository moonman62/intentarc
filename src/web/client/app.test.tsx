// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isHierarchyRecordKind,
  type ProjectRecord,
} from "../../domain/index.js";
import type {
  HubProject,
  IdeaCaptureResponse,
  IdeaDetailResponse,
  IdeaInboxPageResponse,
  ImportScanResponse,
  ProjectMapResponse,
  ProposalDetailDto,
  ProposalSummaryDto,
  ProjectDashboardResponse,
  TaskHandoffResponse,
} from "../contracts.js";
import { App } from "./app.js";
import type { IntentArcDesktopApi } from "./desktop-api.js";
import { preferenceKeys } from "./preferences.js";
import { projectMapPath } from "./project-map-route.js";
import { navigate } from "./router.js";

const neutralHierarchyVocabulary = {
  preset: "neutral",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.intentArcDesktop;
});

test("routes the project Agent Work Queue and offers a Handoff Desk recovery link", async () => {
  history.replaceState(null, "", "/projects/project-one/work");
  const project = projectFixture("project-one", {
    currentTask: taskFixture("project-one"),
  });
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/projects") {
      return Promise.resolve(new Response(JSON.stringify({ projects: [project] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Agent Work Queue" }))
    .toBeTruthy();
  expect(screen.getByText("AI setup is unavailable in this browser session.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Set up AI connection" })).toBeNull();

  act(() => navigate("/projects/project-one/tasks/task-one/handoff"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects/project-one/tasks/task-one/handoff",
    expect.anything(),
  ));
  expect(screen.getByRole("link", { name: "Recover in Work Queue" }).getAttribute("href"))
    .toBe("/projects/project-one/work?taskId=task-one");
});

test("links the desktop Agent Work Queue entry to AI setup", async () => {
  history.replaceState(null, "", "/projects/project-one/work");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    projects: [projectFixture("project-one", { currentTask: taskFixture("project-one") })],
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  window.intentArcDesktop = desktopApi();
  const user = userEvent.setup();

  render(<App />);

  const setup = await screen.findByRole("link", { name: "Set up AI connection" });
  expect(setup.getAttribute("href")).toBe("/settings/ai");
  await user.click(setup);
  expect(await screen.findByRole("heading", { name: "Set up with AI" })).toBeTruthy();
});

test.each([
  "/projects/project-one/work?taskId=one&taskId=two",
  "/projects/project-one/work?taskId=%E0%A4%A",
  "/projects/project-one/work?other=value",
])("rejects a non-canonical Work Queue selection URL: %s", async (url) => {
  history.replaceState(null, "", url);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    projects: [projectFixture("project-one")],
  }), { status: 200, headers: { "Content-Type": "application/json" } })));

  render(<App />);

  expect(await screen.findByText("The Work Queue route is invalid.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Agent Work Queue" })).toBeNull();
});

test("shows explicit Work Queue project loading, error, retry, and not-found states", async () => {
  history.replaceState(null, "", "/projects/project-one/work");
  let rejectLoad!: (reason: unknown) => void;
  const fetchMock = vi.fn().mockImplementation(() => new Promise((_, reject) => {
    rejectLoad = reject;
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("status").textContent).toContain("Loading project");
  rejectLoad(new Error("offline"));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load project");
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    projects: [projectFixture("project-one")],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { name: "Agent Work Queue" })).toBeTruthy();

  cleanup();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ projects: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Project not found" })).toBeTruthy();
});

const timestamp = "2026-07-29T12:00:00.000Z";

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const projectFixture = (
  id = "project-one",
  {
    name = "Project One",
    currentTask = null,
  }: {
    name?: string;
    currentTask?: ProjectRecord | null;
  } = {},
): HubProject => ({
  project: {
    id,
    name,
    revision: 3,
    primaryRepositoryPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  recordsByKind: {},
  currentOutcome: null,
  currentTask,
  attention: null,
  pendingProposalCount: 2,
});

const taskFixture = (projectId: string): ProjectRecord => ({
  id: "task-one",
  projectId,
  kind: "task",
  status: "active",
  title: "Carry the verified context",
  body: "",
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const dashboardFixture = (
  project: HubProject,
): ProjectDashboardResponse => ({
  ...project,
  hierarchyVocabulary: neutralHierarchyVocabulary,
  hierarchyParentContexts: [...new Map(
    [project.currentOutcome, project.currentTask, project.attention]
      .filter((record): record is ProjectRecord => record !== null)
      .filter((record) => isHierarchyRecordKind(record.kind))
      .map((record) => [record.id, { recordId: record.id, parentKind: null }]),
  ).values()] as ProjectDashboardResponse["hierarchyParentContexts"],
  currentFocusPath: project.currentTask
    ? [{
        id: project.currentTask.id,
        projectId: project.currentTask.projectId,
        kind: project.currentTask.kind,
        status: project.currentTask.status,
        title: project.currentTask.title,
      }]
    : project.currentOutcome
      ? [{
          id: project.currentOutcome.id,
          projectId: project.currentOutcome.projectId,
          kind: project.currentOutcome.kind,
          status: project.currentOutcome.status,
          title: project.currentOutcome.title,
        }]
      : [],
  recentRecords: project.currentTask ? [project.currentTask] : [],
});

const routeMapNodes: ProjectMapResponse["hierarchyNodes"] = [
  { id: "outcome-one", kind: "outcome", status: "active", title: "Project outcome", revision: 1, parentId: null, childCount: 1 },
  { id: "feature-a", kind: "deliverable", status: "active", title: "Focused feature", revision: 1, parentId: "outcome-one", childCount: 2 },
  { id: "task-a", kind: "task", status: "active", title: "Selected descendant", revision: 1, parentId: "feature-a", childCount: 0 },
  { id: "task-b", kind: "task", status: "active", title: "Sibling task", revision: 1, parentId: "feature-a", childCount: 0 },
];

const routeMapFixture = (
  selectedRecordId: string | null,
  scopeRecordId: string | null,
): ProjectMapResponse => {
  const selectedIndex = selectedRecordId === null
    ? -1
    : routeMapNodes.findIndex(({ id }) => id === selectedRecordId);
  const selectedPath = selectedIndex < 0
    ? []
    : selectedRecordId === "outcome-one"
      ? routeMapNodes.slice(0, 1)
      : selectedRecordId === "feature-a"
        ? routeMapNodes.slice(0, 2)
        : routeMapNodes.filter(({ id }) => (
            id === "outcome-one" || id === "feature-a" || id === selectedRecordId
          ));
  return {
    projectId: "project-one",
    projectName: "Project One",
    projectRevision: 3,
    hierarchyVocabulary: neutralHierarchyVocabulary,
    selectedRecordId,
    scopeRecordId,
    selectedPath: selectedPath.map(({ id, kind, status, title, revision }) => ({ id, kind, status, title, revision })),
    hierarchyNodes: routeMapNodes,
    hierarchyEdges: [
      { id: "edge-outcome-feature", kind: "parent_of", label: "parent of", fromRecordId: "outcome-one", fromLabel: "Project outcome", toRecordId: "feature-a", toLabel: "Focused feature" },
      { id: "edge-feature-task-a", kind: "parent_of", label: "parent of", fromRecordId: "feature-a", fromLabel: "Focused feature", toRecordId: "task-a", toLabel: "Selected descendant" },
      { id: "edge-feature-task-b", kind: "parent_of", label: "parent of", fromRecordId: "feature-a", fromLabel: "Focused feature", toRecordId: "task-b", toLabel: "Sibling task" },
    ],
    unplacedRecordIds: [],
    progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
  };
};

const installRouteMapResponses = (): ReturnType<typeof vi.fn> => {
  const fetchStub = vi.fn((request: string | URL | Request) => {
    const path = typeof request === "string" ? request : request.toString();
    if (path === "/api/projects") {
      return Promise.resolve(new Response(JSON.stringify({ projects: [projectFixture()] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    if (path.startsWith("/api/projects/project-one/map")) {
      return Promise.resolve(new Response(JSON.stringify(routeMapFixture(null, null)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    const detailMatch = /^\/api\/projects\/project-one\/records\/([^/]+)\/connected-detail$/.exec(path);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      const summary = routeMapNodes.find((node) => node.id === id)!;
      return Promise.resolve(new Response(JSON.stringify({
        projectId: "project-one",
        projectRevision: 3,
        record: {
          ...taskFixture("project-one"),
          id,
          kind: summary.kind,
          title: summary.title,
          body: "Route map detail body.",
        },
        relations: [],
        attachmentsByBasis: {
          accepted: [{
            linkId: "attachment-readme",
            nodeId: "node-readme",
            path: "README.md",
            nodeKind: "file",
            linkKind: "documents",
            linkLabel: "Documents",
            basis: "accepted",
            documentKind: "overview",
            documentFormat: "markdown",
            role: "supporting_document",
          }],
          observed: [], inferred: [], conflicting: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (path.startsWith("/api/projects/project-one/repository/nodes/node-readme/connected-detail")) {
      return Promise.resolve(new Response(JSON.stringify({
        projectId: "project-one",
        snapshotId: "snapshot-one",
        node: {
          nodeId: "node-readme", parentNodeId: null, path: "README.md", kind: "file",
          role: "supporting_document", documentKind: "overview", documentFormat: "markdown",
          contentEligible: true,
        },
        linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (path.startsWith("/api/projects/project-one/repository")) {
      return Promise.resolve(new Response(JSON.stringify({
        projectId: "project-one", snapshotId: "snapshot-one", parentNodeId: null,
        sourceStatus: "available",
        request: { parentNodeId: null, pageSize: 200, filter: {} },
        items: [{
          nodeId: "node-readme", parentNodeId: null, path: "README.md", kind: "file",
          role: "supporting_document", documentKind: "overview", documentFormat: "markdown",
          sourceStatus: "tracked", state: "current", contentEligible: true, childCount: 0,
          changed: false, linked: true, currentTaskRelevant: true, contextIncluded: true,
        }],
        exclusions: [], hasMore: false, nextCursor: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

const ideasFixture = (
  projectId = "project-1",
  title = "Route-bound idea",
): IdeaInboxPageResponse => ({
  projectId,
  projectRevision: 3,
  items: [{
    id: "idea-one",
    projectId,
    revision: 1,
    status: "provisional",
    title,
    bodyPreview: `${title} preview`,
    sourceKind: "human",
    sourceRef: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    context: [],
  }],
  hasMore: false,
  nextCursor: null,
});

const ideaDetailFixture = (
  overrides: Partial<IdeaDetailResponse> = {},
): IdeaDetailResponse => ({
  id: "idea-one",
  projectId: "project-one",
  revision: 1,
  status: "provisional",
  title: "Route-bound idea detail",
  body: "The complete route-bound idea.",
  sourceKind: "human",
  sourceRef: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  context: [{
    id: "task-one",
    kind: "task",
    title: "Focused task",
    status: "active",
  }],
  ...overrides,
});

const captureFixture = (
  projectId: string,
  projectRevision: number,
  id: string,
  title: string,
  context: IdeaCaptureResponse["item"]["context"] = [],
): IdeaCaptureResponse => ({
  projectRevision,
  item: {
    id,
    projectId,
    revision: 1,
    status: "provisional",
    title,
    bodyPreview: title,
    sourceKind: "human",
    sourceRef: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    context,
  },
});

const importScanFixture = (name: string): ImportScanResponse => ({
  manifest: { opaque: name } as never,
  inspection: {
    manifestDigest: "a".repeat(64),
    repository: {
      root: `C:/projects/${name}`,
      canonicalSubpath: null,
      branch: "main",
      head: "b".repeat(40),
      fingerprint: "c".repeat(64),
    },
    project: {
      name,
      primaryRepositoryPath: `C:/projects/${name}`,
    },
    counts: {
      recordsByKind: [],
      recordsByStatus: [],
      recordsBySourceKind: [],
    },
    stableFrame: [],
    activeTasks: [],
    curatedOrProvisionalClaims: [],
    sensitiveFindings: [],
    warnings: [],
    exclusions: [],
  },
});

const importApplyFixture = (projectId: string, replayed = false) => ({
  result: {
    projectId,
    manifestDigest: "a".repeat(64),
    repositoryFingerprint: "c".repeat(64),
    revisionBefore: 0,
    revisionAfter: 1,
    replayed,
  },
});

const reviewAndApplyImport = async (repositoryPath: string): Promise<void> => {
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Repository path" }),
    repositoryPath,
  );
  await user.click(screen.getByRole("button", { name: "Scan repository" }));
  await user.click(await screen.findByRole("button", {
    name: "Continue to confirmation",
  }));
  await user.click(await screen.findByRole("checkbox", {
    name: "I reviewed this baseline",
  }));
  await user.click(screen.getByRole("button", {
    name: "Apply imported baseline",
  }));
};

const installProjectsResponse = (projects: HubProject[]): void => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ projects }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
};

const desktopApi = (
  overrides: {
    lifecycle?: Partial<IntentArcDesktopApi["lifecycle"]>;
    ai?: Partial<IntentArcDesktopApi["ai"]>;
    repository?: Partial<IntentArcDesktopApi["repository"]>;
  } = {},
): IntentArcDesktopApi => ({
  lifecycle: {
    getState: async () => ({
      archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
      onboardingCompleted: true,
      restartRequired: false,
    }),
    chooseArchive: async () => ({
      archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
      onboardingCompleted: true,
      restartRequired: false,
    }),
    completeOnboarding: async () => ({
      archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
      onboardingCompleted: true,
      restartRequired: false,
    }),
    ...overrides.lifecycle,
  },
  ai: {
    list: async () => ({
      automatic: [{
        adapterId: "codex",
        status: "not_connected",
        availability: "ready",
        availabilityReason: "connector_ready",
        version: "1.2.3",
        profileId: null,
      }],
    }),
    connect: async (adapterId) => ({
      adapterId,
      status: "connected",
      profileId: "profile-one",
      restartRequired: false,
    }),
    test: async (adapterId) => ({
      adapterId,
      status: "connected",
      availability: "ready",
      availabilityReason: "connector_ready",
      version: "1.2.3",
      profileId: "profile-one",
    }),
    remove: async (adapterId) => ({
      adapterId,
      status: "not_connected",
      profileId: "profile-one",
    }),
    launchForProject: async ({ adapterId }) => ({
      adapterId,
      result: "manual_required",
    }),
    ...overrides.ai,
  },
  updates: {
    getStatus: async () => ({ state: "disabled" }),
    applyAndRestart: async () => ({ restarting: false }),
  },
  documents: {
    externalOpenAvailable: true,
    openRepositoryFile: async () => ({ opened: true }),
    openExternalHttps: async () => ({ opened: true }),
  },
  repository: {
    chooseRepositoryDirectory: async () => null,
    ...overrides.repository,
  },
});

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  delete window.intentArcDesktop;
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

describe("App routing and project resolution", () => {
  test("settlement on the first deferred Back target keeps React on the accepted project until exact traversal resumes", async () => {
    const targetPath = "/projects/project-two/archive";
    const acceptedPath = "/projects/project-one/archive";
    history.replaceState(
      { sentinel: "target-project" },
      "",
      targetPath,
    );
    navigate(acceptedPath);
    history.replaceState(
      { ...history.state, sentinel: "accepted-project" },
      "",
      acceptedPath,
    );
    const projects = [
      projectFixture("project-one"),
      projectFixture("project-two", { name: "Project Two" }),
    ];
    let resolveCapture!: (response: Response) => void;
    const fetchStub = vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        return Promise.resolve(new Response(JSON.stringify({ projects }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (path === "/api/projects/project-one/ideas") {
        if (init?.method !== "POST") {
          return Promise.resolve(new Response(JSON.stringify(ideasFixture("project-one")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return new Promise<Response>((resolve) => {
          resolveCapture = resolve;
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Project One" });
    await user.click(screen.getByRole("link", { name: "Ideas" }));
    await screen.findByRole("heading", { name: "Ideas" });
    await user.click(screen.getByRole("button", { name: "Capture idea" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Keep the accepted project bound during restoration.",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await waitFor(() => expect(resolveCapture).toBeTypeOf("function"));

    const targetVisits: string[] = [];
    const settleOnFirstTarget = () => {
      if (location.pathname !== targetPath) return;
      targetVisits.push(location.pathname);
      if (targetVisits.length !== 1) return;
      resolveCapture(new Response(JSON.stringify(captureFixture(
        "project-one",
        4,
        "idea-race",
        "Accepted route snapshot",
      )), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));
    };
    window.addEventListener("popstate", settleOnFirstTarget);
    const beforeLength = history.length;

    try {
      act(() => history.go(-2));
      await waitFor(() => expect(targetVisits).toHaveLength(2));
      expect(location.pathname).toBe(targetPath);
      expect(history.state).toMatchObject({ sentinel: "target-project" });
      expect(history.length).toBe(beforeLength);

      act(() => history.forward());
      await waitFor(() => expect(location.pathname).toBe(acceptedPath));
      expect(history.state).toMatchObject({ sentinel: "accepted-project" });
    } finally {
      window.removeEventListener("popstate", settleOnFirstTarget);
    }
  });

  test("reconciles capture revisions and binds the next capture to current project state", async () => {
    history.replaceState(null, "", "/projects/project-one/ideas");
    const project = {
      ...projectFixture("project-one", {
        currentTask: taskFixture("project-one"),
      }),
      recordsByKind: { idea: 2 },
    };
    let captureCount = 0;
    const fetchStub = vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        return Promise.resolve(new Response(JSON.stringify({ projects: [project] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (path === "/api/projects/project-one/ideas") {
        if (init?.method !== "POST") {
          return Promise.resolve(new Response(JSON.stringify(ideasFixture("project-one")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        captureCount += 1;
        return Promise.resolve(new Response(JSON.stringify(captureFixture(
          "project-one",
          3 + captureCount,
          `idea-${captureCount}`,
          `Captured idea ${captureCount}`,
        )), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Ideas" });
    await user.click(screen.getByRole("button", { name: "Capture idea" }));
    await user.type(screen.getByRole("textbox", { name: "Idea" }), "First idea");
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    await user.click(screen.getByRole("button", { name: "Capture another" }));
    await user.type(screen.getByRole("textbox", { name: "Idea" }), "Second idea");
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await screen.findByText("Idea saved. Current work is unchanged.");

    const captureCalls = fetchStub.mock.calls.filter(([, requestInit]) =>
      (requestInit as RequestInit | undefined)?.method === "POST"
    );
    expect(captureCalls).toHaveLength(2);
    expect(JSON.parse(String((captureCalls[0]![1] as RequestInit).body)))
      .toMatchObject({
        expectedProjectRevision: 3,
        text: "First idea",
        contextRecordIds: ["task-one"],
      });
    expect(JSON.parse(String((captureCalls[1]![1] as RequestInit).body)))
      .toMatchObject({
        expectedProjectRevision: 4,
        text: "Second idea",
        contextRecordIds: ["task-one"],
      });
  });

  test("refreshes authoritative project revision and context before explicit conflict retry", async () => {
    history.replaceState(null, "", "/projects/project-one/ideas");
    const initialProject = projectFixture("project-one", {
      currentTask: taskFixture("project-one"),
    });
    const refreshedTask = {
      ...taskFixture("project-one"),
      id: "task-refreshed",
      title: "Refreshed current task",
    };
    const refreshedProject: HubProject = {
      ...initialProject,
      project: { ...initialProject.project, revision: 8 },
      recordsByKind: { idea: 6 },
      currentTask: refreshedTask,
    };
    let projectReadCount = 0;
    let captureCount = 0;
    const fetchStub = vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        projectReadCount += 1;
        const projects = projectReadCount === 1
          ? [initialProject]
          : [refreshedProject];
        return Promise.resolve(new Response(JSON.stringify({ projects }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (path === "/api/projects/project-one/ideas") {
        if (init?.method !== "POST") {
          return Promise.resolve(new Response(JSON.stringify(ideasFixture("project-one")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        captureCount += 1;
        if (captureCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            error: {
              code: "project_revision_conflict",
              message: "The project changed.",
              recoverable: true,
            },
          }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(captureFixture(
          "project-one",
          9,
          "idea-retried",
          "Captured after refresh",
          [{
            id: "task-refreshed",
            kind: "task",
            title: "Refreshed current task",
            status: "active",
          }],
        )), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Ideas" });
    await user.click(screen.getByRole("button", { name: "Capture idea" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Keep this through conflict",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getAllByText("Refreshed current task").length).toBeGreaterThan(0);
    expect(projectReadCount).toBe(2);
    expect(captureCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Idea saved. Current work is unchanged.");
    const captureCalls = fetchStub.mock.calls.filter(([, requestInit]) =>
      (requestInit as RequestInit | undefined)?.method === "POST"
    );
    expect(JSON.parse(String((captureCalls[1]![1] as RequestInit).body)))
      .toMatchObject({
        expectedProjectRevision: 8,
        text: "Keep this through conflict",
        contextRecordIds: ["task-refreshed"],
      });
  });

  test("aborts an authoritative idea refresh when the application unmounts", async () => {
    history.replaceState(null, "", "/projects/project-one/ideas");
    const project = projectFixture("project-one", {
      currentTask: taskFixture("project-one"),
    });
    let projectReadCount = 0;
    let refreshSignal: AbortSignal | null = null;
    const fetchStub = vi.fn((
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        projectReadCount += 1;
        if (projectReadCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            projects: [project],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        refreshSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }
      if (path === "/api/projects/project-one/ideas") {
        if (init?.method !== "POST") {
          return Promise.resolve(new Response(JSON.stringify(ideasFixture("project-one")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          error: {
            code: "project_revision_conflict",
            message: "The project changed.",
            recoverable: true,
          },
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByRole("heading", { name: "Ideas" });
    await user.click(screen.getByRole("button", { name: "Capture idea" }));
    await user.type(
      screen.getByRole("textbox", { name: "Idea" }),
      "Pending authoritative refresh",
    );
    await user.click(screen.getByRole("button", { name: "Save idea" }));
    await waitFor(() => expect(refreshSignal).not.toBeNull());

    unmount();

    expect(refreshSignal?.aborted).toBe(true);
  });

  test("routes an active project's Ideas inbox instead of Project Home", async () => {
    history.replaceState(null, "", "/projects/project-1/ideas");
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      const body = path === "/api/projects"
        ? { projects: [projectFixture("project-1")] }
        : path === "/api/projects/project-1/ideas"
          ? ideasFixture()
          : null;
      if (body === null) throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ideas" })).toBeTruthy();
    expect(await screen.findByText("Route-bound idea")).toBeTruthy();
    expect(screen.queryByRole("heading", {
      name: "Keep the outcome in reach.",
    })).toBeNull();
  });

  test("routes an idea detail and follows related context into the focused map", async () => {
    history.replaceState(null, "", "/projects/project-one/ideas/idea-one");
    const map = {
      projectId: "project-one",
      projectName: "Project One",
      projectRevision: 3,
      hierarchyVocabulary: neutralHierarchyVocabulary,
      selectedRecordId: null,
      scopeRecordId: null,
      selectedPath: [],
      hierarchyNodes: [
        { id: "outcome-one", kind: "outcome", status: "active", title: "Project outcome", revision: 1, parentId: null, childCount: 1 },
        { id: "task-one", kind: "task", status: "active", title: "Focused task", revision: 1, parentId: "outcome-one", childCount: 0 },
      ],
      hierarchyEdges: [{
        id: "edge-outcome-task",
        kind: "parent_of",
        label: "parent of",
        fromRecordId: "outcome-one",
        fromLabel: "Project outcome",
        toRecordId: "task-one",
        toLabel: "Focused task",
      }],
      unplacedRecordIds: [],
      progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
    };
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      const body = path === "/api/projects"
        ? { projects: [projectFixture()] }
        : path === "/api/projects/project-one/ideas/idea-one"
          ? ideaDetailFixture()
          : path === "/api/projects/project-one/map"
            ? map
            : path.endsWith("/connected-detail")
              ? {
                  projectId: "project-one",
                  projectRevision: 3,
                  record: taskFixture("project-one"),
                  relations: [],
                  attachmentsByBasis: {
                    accepted: [], observed: [], inferred: [], conflicting: [],
                  },
                }
              : null;
      if (body === null) throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Route-bound idea detail",
    })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: /Task · Focused task/ }));
    await waitFor(() => expect(fetchStub.mock.calls.some(([path]) =>
      path === "/api/projects/project-one/map"
    )).toBe(true));
    expect(fetchStub.mock.calls.some(([path]) => String(path).includes("/map?"))).toBe(false);
    expect(fetchStub.mock.calls.some(([path]) => (
      path === "/api/projects/project-one/records/task-one/connected-detail"
    ))).toBe(true);
  });

  test("shows a neutral unavailable surface for malformed detail encoding", async () => {
    history.replaceState(null, "", "/projects/project-one/ideas/%E0%A4%A");
    installProjectsResponse([projectFixture()]);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Idea unavailable" }))
      .toBeTruthy();
    expect(screen.getByRole("link", { name: "Project One project switcher" }))
      .toBeTruthy();
  });

  test("shows a neutral unavailable surface for malformed detail project encoding", async () => {
    history.replaceState(null, "", "/projects/%E0%A4%A/ideas/idea-one");
    installProjectsResponse([projectFixture()]);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Idea unavailable" }))
      .toBeTruthy();
    expect(screen.queryByText("The project route is invalid.")).toBeNull();
  });

  test("keeps an Ideas route in active loading while project resolution is pending", async () => {
    history.replaceState(null, "", "/projects/project-1/ideas");
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);

    expect((await screen.findByRole("status")).textContent).toContain(
      "Loading project",
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("renders a retryable project-load error before mounting an Ideas route", async () => {
    history.replaceState(null, "", "/projects/project-1/ideas");
    let projectReads = 0;
    let ideaReads = 0;
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        projectReads += 1;
        if (projectReads === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            error: {
              code: "service_unavailable",
              message: "Project archive unavailable.",
              recoverable: true,
            },
          }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          projects: [projectFixture("project-1")],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (path === "/api/projects/project-1/ideas") {
        ideaReads += 1;
        return Promise.resolve(new Response(JSON.stringify(ideasFixture()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Project archive unavailable.",
    );
    expect(ideaReads).toBe(0);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Ideas" })).toBeTruthy();
    expect(await screen.findByText("Route-bound idea")).toBeTruthy();
    expect(projectReads).toBe(2);
    expect(ideaReads).toBe(1);
  });

  test("renders stable not-found state without requesting Ideas for a missing project", async () => {
    history.replaceState(null, "", "/projects/project-missing/ideas");
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        return Promise.resolve(new Response(JSON.stringify({
          projects: [projectFixture("project-other")],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Project not found" }))
      .toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ideas" })).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("keeps capture unavailable after a malformed project route finishes loading", async () => {
    history.replaceState(null, "", "/projects/%E0%A4%A/ideas");
    localStorage.setItem(preferenceKeys.activeProject, "project-other");
    installProjectsResponse([projectFixture("project-other", {
      name: "Foreign Project",
    })]);

    render(<App />);

    expect((await screen.findByRole("status")).textContent).toContain(
      "project route is invalid",
    );
    expect(screen.queryByRole("heading", { name: "Ideas" })).toBeNull();
    expect(screen.queryByText("Foreign Project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Capture idea" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Overview" })).toBeNull();
  });

  test("rejects a cross-project Ideas response at the application route", async () => {
    history.replaceState(null, "", "/projects/project-1/ideas");
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      const body = path === "/api/projects"
        ? { projects: [projectFixture("project-1")] }
        : path === "/api/projects/project-1/ideas"
          ? ideasFixture("project-2", "Foreign route idea")
          : null;
      if (body === null) throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "another project",
    );
    expect(screen.queryByText("Foreign route idea")).toBeNull();
  });

  test("routes URL-selected repository nodes and restores selection on route events", async () => {
    history.replaceState(null, "", "/projects/project-one/repository?nodeId=file-readme");
    const explorerPage = {
      projectId: "project-one", snapshotId: "snapshot-one", parentNodeId: null,
      sourceStatus: "available", request: { parentNodeId: null, pageSize: 200, filter: {} },
      items: [{
        nodeId: "file-readme", parentNodeId: null, path: "README.md", kind: "file",
        role: "supporting_document", documentKind: "overview", documentFormat: "markdown",
        sourceStatus: "tracked", state: "current", contentEligible: true, childCount: 0,
        changed: false, linked: false, currentTaskRelevant: false, contextIncluded: false,
      }],
      exclusions: [], hasMore: false, nextCursor: null,
    };
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") return Promise.resolve(new Response(JSON.stringify({ projects: [projectFixture()] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (path.endsWith("/connected-detail")) return Promise.resolve(new Response(JSON.stringify({
        projectId: "project-one", snapshotId: "snapshot-one",
        node: { nodeId: "file-readme", parentNodeId: null, path: "README.md", kind: "file", role: "supporting_document", documentKind: "overview", documentFormat: "markdown", contentEligible: true },
        linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify(explorerPage), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Repository Explorer" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "README.md", level: 3 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Repository" }).getAttribute("aria-current")).toBe("page");

    act(() => {
      history.pushState(null, "", "/projects/project-one/repository");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Selected repository node" })).toBeNull());

    act(() => {
      history.pushState(null, "", "/projects/project-one/repository?nodeId=file-readme");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("heading", { name: "README.md", level: 3 })).toBeTruthy();
  });
  test("restores Project selection and scoped record selection through map history", async () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-a&scopeRecordId=feature-a");
    installRouteMapResponses();
    render(<App />);

    expect((await screen.findByTestId("project-map")).getAttribute("data-route-state"))
      .toBe(JSON.stringify({ focusRecordId: "task-a", scopeRecordId: "feature-a" }));

    act(() => navigate("/projects/project-one/map"));
    await waitFor(() => expect(screen.getByTestId("project-map").getAttribute("data-route-state"))
      .toBe(JSON.stringify({ focusRecordId: null, scopeRecordId: null })));

    act(() => history.back());
    await waitFor(() => expect(screen.getByTestId("project-map").getAttribute("data-route-state"))
      .toBe(JSON.stringify({ focusRecordId: "task-a", scopeRecordId: "feature-a" })));

    act(() => history.forward());
    await waitFor(() => expect(screen.getByTestId("project-map").getAttribute("data-route-state"))
      .toBe(JSON.stringify({ focusRecordId: null, scopeRecordId: null })));

    act(() => navigate(projectMapPath("project-one", {
      focusRecordId: null,
      scopeRecordId: "feature-a",
    })));
    expect(screen.getByTestId("project-map").getAttribute("data-route-state"))
      .toBe(JSON.stringify({ focusRecordId: null, scopeRecordId: "feature-a" }));
  });

  test.each([
    "/projects/project-one/map?focusRecordId=task-a&focusRecordId=task-b",
    "/projects/project-one/map?focusRecordId=task-a&scopeRecordId=feature-a&scopeRecordId=outcome-one",
    "/projects/project-one/map?focusRecordId=",
    "/projects/project-one/map?focusRecordId=task-a&scopeRecordId=",
    "/projects/project-one/map?focusRecordId=%E0%A4%A",
  ])("rejects an invalid Project map selection URL: %s", async (url) => {
    history.replaceState(null, "", url);
    installProjectsResponse([projectFixture()]);

    render(<App />);

    expect(await screen.findByText("The Project map route is invalid.")).toBeTruthy();
    expect(screen.queryByTestId("project-map")).toBeNull();
  });

  test("emits canonical map URLs for selection, Focus branch, whole Project scope, and Project selection", async () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-a&scopeRecordId=feature-a");
    installRouteMapResponses();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByTestId("project-map");
    await user.click(await screen.findByRole("treeitem", { name: "Work item: Sibling task" }));
    expect(`${location.pathname}${location.search}`).toBe(
      "/projects/project-one/map?focusRecordId=task-b&scopeRecordId=feature-a",
    );

    await user.click(await screen.findByRole("button", { name: "Focus branch" }));
    expect(`${location.pathname}${location.search}`).toBe(
      "/projects/project-one/map?focusRecordId=task-b&scopeRecordId=task-b",
    );

    await user.click(await screen.findByRole("button", { name: "Show whole project" }));
    expect(`${location.pathname}${location.search}`).toBe(
      "/projects/project-one/map?focusRecordId=task-b",
    );

    await user.click(await screen.findByRole("link", { name: "Project: Project One" }));
    expect(`${location.pathname}${location.search}`).toBe("/projects/project-one/map");
  });

  test("routes a Map attachment through the application router", async () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-a");
    installRouteMapResponses();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("tree");
    const inspector = await screen.findByRole("complementary", {
      name: "Selected item details",
    });
    await user.click(await within(inspector).findByRole("link", { name: "Repository" }));

    expect(`${location.pathname}${location.search}`).toBe(
      "/projects/project-one/repository?nodeId=node-readme",
    );
    expect(await screen.findByRole("heading", { name: "Repository Explorer" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "README.md", level: 3 })).toBeTruthy();
  });

  test("carries authoritative Map revision sync across a same-project selection change", async () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-a");
    const projectSeven = {
      ...projectFixture(),
      project: { ...projectFixture().project, revision: 7 },
    };
    const projectEight = {
      ...projectSeven,
      project: { ...projectSeven.project, revision: 8 },
    };
    const topologyRetry = deferred<Response>();
    const dashboardRefresh = deferred<Response>();
    let topologyCalls = 0;
    let dashboardCalls = 0;
    const detailCalls = new Map<string, number>();
    let topologyRetrySignal: AbortSignal | null = null;
    let dashboardSignal: AbortSignal | null = null;
    const fetchStub = vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path === "/api/projects") {
        return Promise.resolve(new Response(JSON.stringify({ projects: [projectSeven] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (path === "/api/projects/project-one/map") {
        topologyCalls += 1;
        if (topologyCalls === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ...routeMapFixture(null, null),
            projectRevision: 7,
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        if (topologyCalls === 2) {
          topologyRetrySignal = init?.signal ?? null;
          return topologyRetry.promise;
        }
        return Promise.resolve(new Response(JSON.stringify({
          ...routeMapFixture(null, null),
          projectRevision: 8,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const detailMatch = /^\/api\/projects\/project-one\/records\/(task-a|task-b)\/connected-detail$/.exec(path);
      if (detailMatch) {
        const recordId = detailMatch[1]!;
        detailCalls.set(recordId, (detailCalls.get(recordId) ?? 0) + 1);
        return Promise.resolve(new Response(JSON.stringify({
          projectId: "project-one",
          projectRevision: 8,
          record: {
            ...taskFixture("project-one"),
            id: recordId,
            title: recordId === "task-a" ? "Selected descendant" : "Sibling task",
            body: recordId === "task-a"
              ? "Revision eight detail."
              : "Revision eight sibling detail.",
          },
          relations: [],
          attachmentsByBasis: {
            accepted: [], observed: [], inferred: [], conflicting: [],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (path === "/api/projects/project-one/dashboard") {
        dashboardCalls += 1;
        dashboardSignal = init?.signal ?? null;
        return dashboardRefresh.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(topologyCalls).toBe(2));
    expect(dashboardCalls).toBe(0);
    expect(screen.getByRole("treeitem", { name: "Work item: Selected descendant" })).toBeTruthy();

    topologyRetry.resolve(new Response(JSON.stringify({
      ...routeMapFixture(null, null),
      projectRevision: 8,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("Revision eight detail.")).toBeTruthy();
    await waitFor(() => expect(dashboardCalls).toBe(1));
    expect(topologyRetrySignal?.aborted).toBe(false);

    await user.click(screen.getByRole("treeitem", { name: "Work item: Sibling task" }));
    expect(await screen.findByText("Revision eight sibling detail.")).toBeTruthy();
    expect(dashboardSignal?.aborted).toBe(false);

    await act(async () => {
      dashboardRefresh.resolve(new Response(JSON.stringify(dashboardFixture(projectEight)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      await dashboardRefresh.promise;
    });
    await user.click(screen.getByRole("treeitem", { name: "Work item: Selected descendant" }));
    expect(await screen.findByText("Revision eight detail.")).toBeTruthy();
    expect(topologyCalls).toBe(2);
    expect(detailCalls.get("task-a")).toBe(1);
    expect(detailCalls.get("task-b")).toBe(1);

    act(() => navigate("/projects/project-one/revision-proof"));
    const revisionLabel = await screen.findByText("Revision");
    expect(revisionLabel.nextElementSibling?.textContent).toBe("8");
  });

  test("closes Map detail while preserving the focused branch scope", async () => {
    history.replaceState(null, "", "/projects/project-one/map?focusRecordId=task-a&scopeRecordId=feature-a");
    installRouteMapResponses();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("tree");
    await user.click(screen.getByRole("button", { name: "Close details" }));

    await waitFor(() => expect(`${location.pathname}${location.search}`).toBe(
      "/projects/project-one/map?scopeRecordId=feature-a",
    ));
  });
  test("routes a repository refresh with the current project revision and desktop capability", async () => {
    history.replaceState(null, "", "/projects/project-one/repository/refresh");
    const project = projectFixture();
    const chooseRepositoryDirectory = vi.fn(async () => "C:\\moved\\Project One");
    window.intentArcDesktop = desktopApi({ repository: { chooseRepositoryDirectory } });
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      return Promise.resolve(new Response(JSON.stringify(path === "/api/projects"
        ? { projects: [project] }
        : { review: null, sourceStatus: "available" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Repository refresh" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Scan repository" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Documentation" }).getAttribute("aria-current"))
      .toBeNull();
  });

  test("routes an active project to its documentation registry", async () => {
    history.replaceState(null, "", "/projects/project-one/documentation");
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      return Promise.resolve(path === "/api/projects"
        ? new Response(JSON.stringify({ projects: [projectFixture()] }), {
            status: 200, headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({
            projectId: "project-one",
            snapshotId: null,
            documents: [], facets: { documentKinds: [], formats: [], roles: [], freshness: [] },
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Documentation" })).toBeTruthy();
    expect(screen.getByText("No repository documentation matches these filters.")).toBeTruthy();
  });

  test("gates the archive hub on first-run location confirmation", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchStub);
    window.intentArcDesktop = desktopApi({
      lifecycle: {
        getState: async () => ({
          archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
          onboardingCompleted: false,
          restartRequired: false,
        }),
        completeOnboarding: async () => ({
          archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
          onboardingCompleted: true,
          restartRequired: false,
        }),
      },
    });

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Choose where your archive lives",
    })).toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", {
      name: "Use this archive",
    }));

    expect(await screen.findByRole("heading", {
      name: "No projects yet",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start new" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import Project" })).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("routes desktop settings to Set up with AI and adds it to continuity navigation", async () => {
    history.replaceState(null, "", "/settings/ai");
    installProjectsResponse([]);
    window.intentArcDesktop = desktopApi();

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Set up with AI",
    })).toBeTruthy();
    expect(await screen.findByRole("article", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "AI Connections",
    }).getAttribute("aria-current")).toBe("page");
  });

  test("does not expose desktop AI navigation in the browser build", async () => {
    installProjectsResponse([]);

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "No projects yet",
    })).toBeTruthy();
    expect(screen.queryByRole("link", {
      name: "AI Connections",
    })).toBeNull();
  });

  test("routes a task handoff URL to the reviewed Handoff Desk", async () => {
    history.replaceState(
      null,
      "",
      "/projects/project-one/tasks/task-one/handoff",
    );
    const task = {
      ...taskFixture("project-one"),
      body: "Copy only after the outbound review is approved.",
    };
    const hubProject = projectFixture("project-one", { currentTask: task });
    const handoff: TaskHandoffResponse = {
      project: hubProject.project,
      task,
      currentOutcome: null,
      relatedRecords: [],
      profiles: [],
    };
    const fetchStub = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        new Response(JSON.stringify(
          path.endsWith("/handoff")
            ? handoff
            : { projects: [hubProject] },
        ), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    );
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Completion criteria",
    })).toBeTruthy();
    expect(screen.getByText(
      "Copy only after the outbound review is approved.",
    )).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledWith(
      "/api/projects/project-one/tasks/task-one/handoff",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  test("loads the guided home and derives current-task navigation from its dashboard", async () => {
    history.replaceState(null, "", "/projects/project-one");
    const task = taskFixture("project-one");
    const hubProject = projectFixture("project-one", {
      currentTask: task,
    });
    const currentOutcome: ProjectRecord = {
      ...task,
      id: "outcome-one",
      kind: "outcome",
      title: "Reach a stable combat loop",
    };
    const dashboard: ProjectDashboardResponse = {
      ...hubProject,
      hierarchyVocabulary: neutralHierarchyVocabulary,
      hierarchyParentContexts: [
        { recordId: currentOutcome.id, parentKind: null },
        { recordId: task.id, parentKind: "outcome" },
      ],
      currentOutcome,
      currentFocusPath: [currentOutcome, task].map((record) => ({
        id: record.id,
        projectId: record.projectId,
        kind: record.kind,
        status: record.status,
        title: record.title,
      })),
      recentRecords: [task],
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        new Response(JSON.stringify(
          path.endsWith("/dashboard")
            ? dashboard
            : { projects: [hubProject] },
        ), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    ));

    render(<App />);

    expect(
      await screen.findByRole("link", {
        name: "Outcome: Reach a stable combat loop (outcome-one)",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Current Task" }).getAttribute("href"),
    ).toBe("/projects/project-one/tasks/task-one/handoff");
  });

  test("does not trust a hub task ID when the loaded dashboard has no current task", async () => {
    history.replaceState(null, "", "/projects/project-one");
    const staleTask = taskFixture("project-one");
    const hubProject = projectFixture("project-one", {
      currentTask: staleTask,
    });
    const dashboard: ProjectDashboardResponse = {
      ...hubProject,
      hierarchyVocabulary: neutralHierarchyVocabulary,
      hierarchyParentContexts: [],
      currentTask: null,
      currentFocusPath: [],
      recentRecords: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        new Response(JSON.stringify(
          path.endsWith("/dashboard")
            ? dashboard
            : { projects: [hubProject] },
        ), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    ));

    render(<App />);

    expect(await screen.findByText("No Work item in focus")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Current Task" })).toBeNull();
  });

  test("removes a same-project task link while a re-entry dashboard load fails", async () => {
    history.replaceState(null, "", "/projects/project-one");
    const task = taskFixture("project-one");
    const hubProject = projectFixture("project-one", {
      currentTask: task,
    });
    let resolveReentry!: (response: Response) => void;
    const reentryResponse = new Promise<Response>((resolve) => {
      resolveReentry = resolve;
    });
    let dashboardRequestCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (!path.endsWith("/dashboard")) {
        return Promise.resolve(new Response(
          JSON.stringify({ projects: [hubProject] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }
      dashboardRequestCount += 1;
      return dashboardRequestCount === 1
        ? Promise.resolve(new Response(
            JSON.stringify(dashboardFixture(hubProject)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ))
        : reentryResponse;
    }));

    render(<App />);

    expect(await screen.findByRole("link", { name: "Current Task" }))
      .toBeTruthy();
    act(() => navigate("/"));
    await screen.findByRole("heading", {
      name: "Projects",
    });
    act(() => navigate("/projects/project-one"));

    expect(screen.queryByRole("link", { name: "Current Task" })).toBeNull();

    resolveReentry(new Response(JSON.stringify({
      error: {
        code: "DASHBOARD_UNAVAILABLE",
        message: "The refreshed dashboard could not be read.",
        recoverable: true,
      },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The refreshed dashboard could not be read.",
    );
    expect(screen.queryByRole("link", { name: "Current Task" })).toBeNull();
  });

  test("keeps a newer dashboard task after an older re-entry completes", async () => {
    history.replaceState(null, "", "/projects/project-one");
    const firstTask = taskFixture("project-one");
    const newerTask = {
      ...firstTask,
      id: "task-three",
      title: "Use the newest dashboard task",
    };
    const hubProject = projectFixture("project-one", {
      currentTask: firstTask,
    });
    let resolveOlderReentry!: (response: Response) => void;
    const olderReentry = new Promise<Response>((resolve) => {
      resolveOlderReentry = resolve;
    });
    let resolveNewerReentry!: (response: Response) => void;
    const newerReentry = new Promise<Response>((resolve) => {
      resolveNewerReentry = resolve;
    });
    let dashboardRequestCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (!path.endsWith("/dashboard")) {
        return Promise.resolve(new Response(
          JSON.stringify({ projects: [hubProject] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }
      dashboardRequestCount += 1;
      if (dashboardRequestCount === 1) {
        return Promise.resolve(new Response(
          JSON.stringify(dashboardFixture(hubProject)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }
      return dashboardRequestCount === 2 ? olderReentry : newerReentry;
    }));

    render(<App />);

    expect(await screen.findByRole("link", { name: "Current Task" }))
      .toBeTruthy();
    act(() => navigate("/"));
    await screen.findByRole("heading", {
      name: "Projects",
    });
    act(() => navigate("/projects/project-one"));
    await screen.findByText("Reading the project path…");
    act(() => navigate("/"));
    await screen.findByRole("heading", {
      name: "Projects",
    });
    act(() => navigate("/projects/project-one"));

    resolveNewerReentry(new Response(JSON.stringify(dashboardFixture({
      ...hubProject,
      currentTask: newerTask,
    })), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    expect(
      (await screen.findByRole("link", { name: "Current Task" })).getAttribute(
        "href",
      ),
    ).toBe("/projects/project-one/tasks/task-three/handoff");

    resolveOlderReentry(new Response(JSON.stringify({
      error: {
        code: "STALE_DASHBOARD_FAILURE",
        message: "An older dashboard request failed.",
        recoverable: true,
      },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    await act(async () => await Promise.resolve());

    expect(
      screen.getByRole("link", { name: "Current Task" }).getAttribute("href"),
    ).toBe("/projects/project-one/tasks/task-three/handoff");
  });

  test("renders the project index and current navigation with a query string", async () => {
    history.replaceState(null, "", "/projects?view=recent");
    installProjectsResponse([]);

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Projects",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "IntentArc projects" }))
      .toBeTruthy();
  });

  test("recognizes a proposal pathname when a query string is present", async () => {
    history.replaceState(
      null,
      "",
      "/projects/project-one/proposals?filter=pending",
    );
    const proposal: ProposalSummaryDto = {
      id: "proposal-app",
      projectId: "project-one",
      origin: { type: "profile", profileId: "profile-safe" },
      sourceTaskId: null,
      predecessorProposalId: null,
      baseProjectRevision: 3,
      state: "pending",
      rationale: "Review this proposal through the project shell.",
      idempotencyKey: "proposal-app-key",
      reviewReason: null,
      reviewerActor: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewedAt: null,
    };
    const proposalDetail: ProposalDetailDto = {
      ...proposal,
      operations: [{
        operationId: "create-evidence",
        type: "create_record",
        kind: "evidence",
        status: "provisional",
        title: "Shell proposal evidence",
        body: "The proposal screen stays inside project navigation.",
      }],
    };
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      const body = path === "/api/projects"
        ? { projects: [projectFixture()] }
        : path.includes("/proposals?state=pending")
          ? { proposals: [proposal] }
          : path === "/api/proposals/proposal-app"
            ? { proposal: proposalDetail }
            : null;
      if (body === null) throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Review proposed knowledge" }),
    ).toBeTruthy();
    expect(await screen.findByText("Shell proposal evidence")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Proposals" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
  });

  test("removes project destinations after loaded data proves a saved ID is stale", async () => {
    localStorage.setItem(preferenceKeys.activeProject, "missing-project");
    installProjectsResponse([]);

    render(<App />);

    await screen.findByRole("heading", { name: "No projects yet" });
    await waitFor(() => {
    expect(screen.queryByRole("link", { name: "Overview" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Proposals" })).toBeNull();
    });
  });

  test("preserves the active project preference when opening import", async () => {
    localStorage.setItem(preferenceKeys.activeProject, "project-one");
    installProjectsResponse([projectFixture()]);

    render(<App />);

    await screen.findByRole("heading", {
      name: "Projects",
    });
    fireEvent.click(screen.getAllByRole("link", { name: "Import Project" })[0]!);

    await waitFor(() => expect(location.pathname).toBe("/projects/import"));
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBe(
      "project-one",
    );
  });

  test("uses the desktop repository chooser from the import route", async () => {
    history.replaceState(null, "", "/projects/import");
    const chooseRepositoryDirectory = vi.fn(async () => "C:\\projects\\IntentArc");
    window.intentArcDesktop = desktopApi({ repository: { chooseRepositoryDirectory } });
    installProjectsResponse([]);
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Browse…" }));

    expect(chooseRepositoryDirectory).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Repository path") as HTMLInputElement).value)
      .toBe("C:\\projects\\IntentArc");
  });

  test("keeps the import route header concise before repository selection", async () => {
    history.replaceState(null, "", "/projects/import");
    installProjectsResponse([]);

    render(<App />);

    const title = await screen.findByRole("heading", { name: "Import project" });
    const routeHeader = title.closest(".stage__header");
    expect(routeHeader).not.toBeNull();
    expect(within(routeHeader!).queryByText(
      "Inspect repository evidence, review the proposed baseline, then bring it into the continuity archive.",
    )).toBeNull();
    expect(screen.getByRole("textbox", { name: "Repository path" })).toBeTruthy();
  });

  test("refreshes authoritative state before navigating from import", async () => {
    const user = userEvent.setup();
    history.replaceState(null, "", "/projects/import");
    const importedView = projectFixture("imported", { name: "Imported" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importScanFixture("Imported")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importApplyFixture("imported")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [importedView] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(dashboardFixture(importedView)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));

    render(<App />);
    await screen.findByRole("heading", { name: "Import project" });
    await reviewAndApplyImport("C:/projects/Imported");

    const importedState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(importedState).getByRole("heading", { name: "Imported" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBe("imported");
    await user.click(screen.getByRole("link", { name: "Imported project switcher" }));
    expect(
      await screen.findByRole("link", { name: "Open Imported" }),
    ).toBeTruthy();
  });

  test("refreshes authoritative state before navigating from hub creation", async () => {
    const user = userEvent.setup();
    const createdView = projectFixture("created", {
      name: "Created project",
      currentTask: taskFixture("created"),
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ project: createdView.project }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [createdView] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(dashboardFixture(createdView)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "Created project",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    const createdState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(createdState).getByRole("heading", { name: "Created project" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Current Task" })).toBeTruthy();
    await user.click(screen.getByRole("link", {
      name: "Created project project switcher",
    }));
    expect(
      await screen.findByRole("link", { name: "Open Created project" }),
    ).toBeTruthy();
  });

  test("does not let an older project load overwrite a created project", async () => {
    const user = userEvent.setup();
    history.replaceState(null, "", "/projects/import");
    const importedView = projectFixture("race-safe", { name: "Race safe" });
    let resolveInitialLoad!: (response: Response) => void;
    const initialLoad = new Promise<Response>((resolve) => {
      resolveInitialLoad = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(initialLoad)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importScanFixture("Race safe")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importApplyFixture("race-safe")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [importedView] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(dashboardFixture(importedView)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));

    render(<App />);
    await screen.findByRole("heading", { name: "Import project" });
    await reviewAndApplyImport("C:/projects/Race-safe");
    const raceSafeState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(raceSafeState).getByRole("heading", { name: "Race safe" })).toBeTruthy();

    resolveInitialLoad(new Response(JSON.stringify({ projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await act(async () => await Promise.resolve());

    const resolvedRaceSafeState = screen.getByRole("region", {
      name: "Project state",
    });
    expect(
      within(resolvedRaceSafeState).getByRole("heading", { name: "Race safe" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Race safe project switcher" }));
    expect(
      await screen.findByRole("link", { name: "Open Race safe" }),
    ).toBeTruthy();
  });

  test("retries reconciliation without posting a duplicate project", async () => {
    history.replaceState(null, "", "/projects/import");
    const importedView = projectFixture("single-post", { name: "Single post" });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importScanFixture("Single post")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importApplyFixture("single-post")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: {
            code: "ARCHIVE_REFRESH_FAILED",
            message: "Could not refresh the archive.",
            recoverable: true,
          },
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importApplyFixture("single-post", true)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [importedView] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(dashboardFixture(importedView)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    await screen.findByRole("heading", { name: "Import project" });
    await reviewAndApplyImport("C:/projects/Single-post");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not refresh the archive.",
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Apply imported baseline",
    }));

    const singlePostState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(singlePostState).getByRole("heading", { name: "Single post" })).toBeTruthy();
    const applyCalls = fetchStub.mock.calls.filter(([path]) =>
      path === "/api/imports/apply"
    );
    expect(applyCalls).toHaveLength(2);
  });

  test("keeps a hub reconciliation retry after closing and reopening", async () => {
    const user = userEvent.setup();
    const createdView = projectFixture("reopen-safe", { name: "Reopen safe" });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ project: createdView.project }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: {
            code: "ARCHIVE_REFRESH_FAILED",
            message: "Could not refresh the archive.",
            recoverable: true,
          },
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [createdView] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(dashboardFixture(createdView)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchStub);

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "Reopen safe",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not refresh the archive.",
    );
    await user.click(
      screen.getAllByRole("button", {
        name: "Close new project dialog",
      })[1]!,
    );
    await user.click(screen.getByRole("button", { name: "Start new" }));
    expect(
      screen.getByRole("textbox", { name: "Project name" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(
      screen.getByText(/it will not be created again/).textContent,
    ).toContain("Reopen safe was created");
    await user.click(
      screen.getByRole("button", { name: "Retry opening project" }),
    );

    const reopenSafeState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(reopenSafeState).getByRole("heading", { name: "Reopen safe" })).toBeTruthy();
    const postCalls = fetchStub.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "POST"
    );
    expect(postCalls).toHaveLength(1);
  });

  test("ignores a hub creation response after navigation unmounts it", async () => {
    const user = userEvent.setup();
    const createdView = projectFixture("late-hub", { name: "Late hub" });
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(postResponse));

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start new" }));
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "Late hub",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));
    act(() => navigate("/projects/import"));
    resolvePost(new Response(
      JSON.stringify({ project: createdView.project }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await act(async () => await Promise.resolve());

    expect(location.pathname).toBe("/projects/import");
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBeNull();
  });

  test("ignores an import response after navigation unmounts it", async () => {
    const user = userEvent.setup();
    history.replaceState(null, "", "/projects/import");
    const importedView = projectFixture("late-import", { name: "Late import" });
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(importScanFixture("Late import")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(postResponse));

    render(<App />);
    await screen.findByRole("heading", { name: "Import project" });
    await reviewAndApplyImport("C:/projects/Late-import");
    act(() => navigate("/"));
    resolvePost(new Response(
      JSON.stringify(importApplyFixture(importedView.project.id)),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await act(async () => await Promise.resolve());

    expect(location.pathname).toBe("/");
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBeNull();
  });
});
