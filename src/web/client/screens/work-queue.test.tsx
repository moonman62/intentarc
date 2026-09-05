// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CoordinationReadyResponse,
  CoordinationStateResponse,
} from "../../contracts.js";
import {
  cancelDeferredNavigation,
  navigate,
  registerRouteBlocker,
  resumeDeferredNavigation,
} from "../router.js";
import { WorkQueue } from "./work-queue.js";

const timestamp = "2026-08-20T10:00:00.000Z";
const credentials = {
  profileId: "profile-worker",
  token: "work-queue-secret-must-not-leak",
};

const task = (id: string, title: string, revision = 2) => ({
  id,
  projectId: "project-one",
  kind: "task" as const,
  status: "active" as const,
  title,
  body: `${title} body`,
  sourceKind: "human" as const,
  sourceRef: null,
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const ready: CoordinationReadyResponse = {
  projectRevision: 7,
  nextCursor: null,
  tasks: [
    {
      task: task("task-ready", "Implement ready work"),
      blockers: [],
      liveClaimId: null,
      liveDelegationId: null,
    },
    {
      task: task("task-blocked", "Wait for dependency"),
      blockers: ["dependency_incomplete:task-foundation"],
      liveClaimId: null,
      liveDelegationId: null,
    },
    {
      task: task("task-next", "Continue ready work"),
      blockers: [],
      liveClaimId: null,
      liveDelegationId: null,
    },
  ],
};

const activeClaim = {
  id: "claim-one",
  projectId: "project-one",
  taskId: "task-ready",
  profileId: credentials.profileId,
  delegationId: null,
  state: "active" as const,
  baseProjectRevision: 7,
  baseTaskRevision: 2,
  contextPackId: "context-one",
  acquiredAt: "2026-08-20T17:00:00.000Z",
  expiresAt: "2026-08-20T20:00:00.000Z",
  absoluteExpiresAt: "2026-08-20T21:00:00.000Z",
  endedAt: null,
  latestCheckpointId: "checkpoint-one",
};

const checkpoint = {
  id: "checkpoint-one",
  claimId: activeClaim.id,
  sequence: 1,
  createdAt: "2026-08-20T09:55:00.000Z",
  summary: "API boundary completed",
  completedWork: ["Added the strict client boundary"],
  remainingWork: ["Run browser verification"],
  blockers: [],
  verificationEvidence: {
    tests: ["component tests pass"],
    artifacts: [],
  },
  repositoryEvidence: null,
  projectRevision: 7,
  taskRevision: 2,
  contextPackId: "context-one",
};

const state = (
  overrides: Partial<CoordinationStateResponse> = {},
): CoordinationStateResponse => ({
  projectRevision: 7,
  task: task("task-ready", "Implement ready work"),
  claim: activeClaim,
  delegation: {
    id: "delegation-one",
    projectId: "project-one",
    taskId: "task-ready",
    parentProfileId: "profile-parent",
    childProfileId: credentials.profileId,
    state: "claimed",
    baseProjectRevision: 7,
    baseTaskRevision: 2,
    scope: {
      summary: "Only implement the browser queue",
      constraints: ["Do not change server contracts"],
    },
    allowedOutputs: ["create_record", "update_record"],
    offeredAt: "2026-08-20T09:40:00.000Z",
    deadline: "2026-08-20T12:00:00.000Z",
    acceptedAt: "2026-08-20T09:42:00.000Z",
    endedAt: null,
    claimId: activeClaim.id,
  },
  latestCheckpoint: checkpoint,
  submission: null,
  events: [],
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) => new Response(
  JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json" } },
);

const installQueue = (
  coordinationState: CoordinationStateResponse = state(),
): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/coordination/ready?")) {
      return Promise.resolve(jsonResponse(ready));
    }
    if (path.includes("/coordination/state?")) {
      return Promise.resolve(jsonResponse(coordinationState));
    }
    return Promise.resolve(jsonResponse({ claim: activeClaim }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const signIn = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByText("Advanced access"));
  await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
  await user.type(screen.getByLabelText("Profile token"), credentials.token);
  await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
  await screen.findByRole("heading", { name: "Ready now" });
  return user;
};

const openAdvancedAccess = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText("Advanced access"));
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/projects/project-one/work");
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "stable-attempt") });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkQueue", () => {
  test("offers owner project context and project-enabled profile identities before authentication", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== "/api/profiles") {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      return Promise.resolve(jsonResponse({
        profiles: [{
          profileId: "profile-worker",
          name: "Build agent",
          status: "enabled",
          executionMode: "safe",
          projectIds: ["project-one"],
          lastUsedAt: timestamp,
          hasDestination: true,
        }, {
          profileId: "profile-worker-two",
          name: "Build agent",
          status: "enabled",
          executionMode: "safe",
          projectIds: ["project-one"],
          lastUsedAt: null,
          hasDestination: true,
        }, {
          profileId: "profile-foreign",
          name: "Other project agent",
          status: "enabled",
          executionMode: "trusted",
          projectIds: ["project-two"],
          lastUsedAt: null,
          hasDestination: true,
        }, {
          profileId: "profile-disabled",
          name: "Disabled project agent",
          status: "disabled",
          executionMode: "safe",
          projectIds: ["project-one"],
          lastUsedAt: null,
          hasDestination: false,
        }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <WorkQueue
        projectId="project-one"
        projectRevision={7}
        desktopAiAvailable
        ownerSummary={{
          projectName: "IntentArc",
          taskCount: 3,
          currentTask: {
            title: "Implement ready work",
            status: "active",
          },
        }}
      />,
    );

    const ownerSummary = screen.getByRole("region", { name: "Project work" });
    expect(ownerSummary.textContent).toContain("IntentArc");
    expect(ownerSummary.textContent).toContain("3 tasks");
    expect(ownerSummary.textContent).toContain("Implement ready work");
    const authenticate = await screen.findByRole("button", {
      name: "Authenticate as Build agent (profile-worker)",
    });
    expect(screen.getByText("profile-worker")).toBeTruthy();
    expect(screen.getByText("profile-worker-two")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Authenticate as Build agent (profile-worker-two)",
    })).toBeTruthy();
    expect(screen.queryByText("Other project agent")).toBeNull();
    expect(screen.queryByText("Disabled project agent")).toBeNull();
    expect(screen.getAllByText("Safe mode · Project access")).toHaveLength(2);
    expect(screen.getByText(
      "An existing configured profile cannot be authenticated here without its separately held token.",
    )).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.queryByLabelText("Profile token")).toBeNull();

    const user = userEvent.setup();
    await user.click(authenticate);

    expect(container.querySelector("details")?.open).toBe(true);
    expect((screen.getByLabelText("Profile ID") as HTMLInputElement).value)
      .toBe("profile-worker");
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    const profileRequest = fetchMock.mock.calls.find(([input]) => String(input) === "/api/profiles");
    expect(new Headers(profileRequest?.[1]?.headers).has("Authorization")).toBe(false);
  });

  test("introduces the desktop queue with a closed Advanced access form", async () => {
    const { container } = render(
      <WorkQueue
        projectId="project-one"
        projectRevision={7}
        desktopAiAvailable
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: "Agent Work Queue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up AI connection" }).getAttribute("href"))
      .toBe("/settings/ai");
    const advancedAccess = container.querySelector("details");
    expect(advancedAccess?.open).toBe(false);
    expect(screen.queryByLabelText("Profile token")).toBeNull();

    await user.click(screen.getByText("Advanced access"));

    expect(screen.getByLabelText("Profile ID")).toBeTruthy();
    const token = screen.getByLabelText("Profile token") as HTMLInputElement;
    await user.type(token, credentials.token);
    await user.click(screen.getByText("Advanced access"));
    expect(screen.queryByLabelText("Profile token")).toBeNull();
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test("explains unavailable desktop AI setup while keeping Advanced access usable", async () => {
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();

    expect(screen.getByText("AI setup is unavailable in this browser session.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up AI connection" })).toBeNull();
    await user.click(screen.getByText("Advanced access"));
    expect(screen.getByLabelText("Profile ID")).toBeTruthy();
  });

  test("keeps profile credentials in memory and clears them after failed authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "invalid_profile_credentials",
        message: "Invalid profile credentials",
        recoverable: false,
      },
    }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { unmount } = render(
      <WorkQueue projectId="project-one" projectRevision={7} />,
    );

    await user.click(screen.getByText("Advanced access"));
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Invalid profile credentials",
    );
    expect((screen.getByLabelText("Profile ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(credentials.token);
    expect(location.href).not.toContain(credentials.token);
    expect(JSON.stringify(localStorage)).not.toContain(credentials.token);
    expect(JSON.stringify(sessionStorage)).not.toContain(credentials.token);
    unmount();
  });

  test("clears in-memory credentials when authentication fails after sign-in", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        return Promise.resolve(jsonResponse(ready));
      }
      if (path.includes("taskId=task-ready")) {
        return Promise.resolve(jsonResponse(state()));
      }
      return Promise.resolve(jsonResponse({
        error: {
          code: "invalid_profile_credentials",
          message: "Invalid profile credentials",
          recoverable: false,
        },
      }, 401));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();

    await user.click(screen.getByRole("button", { name: /Wait for dependency/ }));

    expect(await screen.findByRole("form", { name: "Profile credentials" }))
      .toBeTruthy();
    expect((screen.getByLabelText("Profile ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test("groups ready and dependency-blocked work with text status and accessible landmarks", async () => {
    installQueue();
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.getByRole("region", { name: "Ready now" }).textContent)
      .toContain("Implement ready work");
    const blocked = screen.getByRole("region", {
      name: "Blocked by dependencies",
    });
    expect(blocked.textContent).toContain("Wait for dependency");
    expect(blocked.textContent).toContain(
      "Dependency task-foundation is not completed.",
    );
    expect(blocked.textContent).not.toContain("dependency_incomplete:");
    expect(screen.getAllByText("Ready", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Blocked", { exact: true })).toBeTruthy();
    expect(document.querySelector("canvas, svg[aria-label*='chart']")).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toContain(
      "productivity score",
    );
  });

  test("separates dependency, live-claim, delegation, and other coordination blockers", async () => {
    const groupedReady: CoordinationReadyResponse = {
      ...ready,
      tasks: [
        ready.tasks[0]!,
        ready.tasks[1]!,
        {
          task: task("task-claimed", "Claim-owned work"),
          blockers: ["claim_active:claim-two"],
          liveClaimId: "claim-two",
          liveDelegationId: null,
        },
        {
          task: task("task-delegated", "Delegated work"),
          blockers: ["delegation_live:delegation-two"],
          liveClaimId: null,
          liveDelegationId: "delegation-two",
        },
        {
          task: task("task-other", "Other blocked work"),
          blockers: ["policy_hold:manual"],
          liveClaimId: null,
          liveDelegationId: null,
        },
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return Promise.resolve(jsonResponse(
        path.includes("/coordination/ready?") ? groupedReady : state(),
      ));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.getByRole("region", { name: "Blocked by dependencies" }).textContent)
      .toContain("Wait for dependency");
    expect(screen.getByRole("region", { name: "Blocked by active claims" }).textContent)
      .toContain("Claim-owned work");
    expect(screen.getByRole("region", { name: "Blocked by delegations" }).textContent)
      .toContain("Delegated work");
    expect(screen.getByRole("region", { name: "Other coordination blockers" }).textContent)
      .toContain("Other blocked work");
  });

  test("shows ownership, lease countdown, checkpoint, delegation scope, and submission state", async () => {
    vi.useFakeTimers({ now: new Date(timestamp), shouldAdvanceTime: true });
    installQueue(state({
      claim: {
        ...activeClaim,
        acquiredAt: "2026-08-20T09:45:00.000Z",
        expiresAt: "2026-08-20T10:20:00.000Z",
        absoluteExpiresAt: "2026-08-20T13:45:00.000Z",
      },
      submission: {
        id: "submission-one",
        claimId: activeClaim.id,
        checkpointId: checkpoint.id,
        profileId: credentials.profileId,
        projectId: "project-one",
        taskId: "task-ready",
        baseProjectRevision: 7,
        baseTaskRevision: 2,
        contextPackId: "context-one",
        summary: "Ready for governed review",
        verificationEvidence: { tests: ["component tests pass"], artifacts: [] },
        repositoryEvidence: null,
        proposalId: "proposal-one",
        state: "submitted",
        submittedAt: timestamp,
        decidedAt: null,
      },
    }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    const details = screen.getByRole("region", { name: "Selected work" });
    expect(details.textContent).toContain("Owned by profile-worker");
    expect(details.textContent).toContain("20 minutes remaining");
    expect(details.textContent).toContain("API boundary completed");
    expect(details.textContent).toContain("Only implement the browser queue");
    expect(details.textContent).toContain("Do not change server contracts");
    expect(details.textContent).toContain("State: claimed");
    expect(details.textContent).toContain("Allowed outputs: create_record, update_record");
    expect(details.textContent).toContain("Submitted · awaiting proposal review");
    expect(screen.getByRole("link", { name: "Review proposal" }).getAttribute("href"))
      .toBe("/projects/project-one/proposals");
  });

  test("labels terminal claim history without presenting it as current ownership or a live lease", async () => {
    installQueue(state({
      claim: {
        ...activeClaim,
        state: "released",
        endedAt: timestamp,
      },
      delegation: null,
    }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    const details = screen.getByRole("region", { name: "Selected work" });
    expect(within(details).getByText("No active owner")).toBeTruthy();
    expect(within(details).getByText("No active lease")).toBeTruthy();
    expect(details.textContent).toContain("Released claim by profile-worker");
    expect(details.textContent).not.toContain("Owned by profile-worker");
  });

  test("clears a generic load failure and requires fresh credentials to retry", async () => {
    let resolveReady!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveReady = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect(screen.getByRole("status").textContent).toContain("Loading work queue");

    resolveReady(jsonResponse({ ...ready, tasks: [] }));
    expect(await screen.findByRole("heading", { name: "No coordinated work" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(ready))
      .mockResolvedValueOnce(jsonResponse(state()));
    await user.click(screen.getByRole("button", { name: "Refresh work queue" }));
    expect(await screen.findByRole("heading", { name: "Ready now" })).toBeTruthy();

    cleanup();
    const replacementToken = "replacement-work-queue-token";
    const failure = vi.fn()
      .mockRejectedValueOnce(new Error(credentials.token))
      .mockResolvedValueOnce(jsonResponse(ready))
      .mockResolvedValueOnce(jsonResponse(state()));
    vi.stubGlobal("fetch", failure);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const retryUser = userEvent.setup();
    await openAdvancedAccess(retryUser);
    await retryUser.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await retryUser.type(screen.getByLabelText("Profile token"), credentials.token);
    await retryUser.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the Work Queue",
    );
    expect(screen.getByRole("form", { name: "Profile credentials" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((screen.getByLabelText("Profile ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(credentials.token);
    expect(failure).toHaveBeenCalledTimes(1);
    await retryUser.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await retryUser.type(screen.getByLabelText("Profile token"), replacementToken);
    await retryUser.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect(await screen.findByRole("heading", { name: "Ready now" })).toBeTruthy();
    const retryHeaders = new Headers(failure.mock.calls[1]?.[1]?.headers);
    expect(retryHeaders.get("Authorization")).toBe(`Bearer ${replacementToken}`);
    expect(retryHeaders.get("Authorization")).not.toContain(credentials.token);
  });

  test("clears credentials after an invalid ready response instead of retrying its token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        projectRevision: 7,
        tasks: "invalid",
        nextCursor: null,
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    expect(await screen.findByRole("form", { name: "Profile credentials" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((screen.getByLabelText("Profile ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test("recovers a stale project revision before retrying coordination", async () => {
    const paths: string[] = [];
    const conflict = jsonResponse({
      error: {
        code: "revision_conflict",
        message: "The project revision changed. Refresh and try again.",
        recoverable: true,
      },
    }, 409);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.includes("expectedProjectRevision=7")) {
        return Promise.resolve(conflict.clone());
      }
      if (path === "/api/projects") {
        return Promise.resolve(jsonResponse({
          projects: [{
            project: {
              id: "project-one",
              name: "Project One",
              revision: 8,
              primaryRepositoryPath: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            recordsByKind: { task: 2 },
            currentOutcome: null,
            currentTask: task("task-ready", "Implement ready work"),
            attention: null,
            pendingProposalCount: 0,
          }],
        }));
      }
      if (path.includes("expectedProjectRevision=8") && path.includes("/ready?")) {
        return Promise.resolve(jsonResponse({ ...ready, projectRevision: 8 }));
      }
      if (path.includes("expectedProjectRevision=8") && path.includes("/state?")) {
        return Promise.resolve(jsonResponse(state()));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Recovery reuses the current in-memory profile session. Sign out to discard it.",
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    await user.click(await screen.findByRole("button", {
      name: "Recover current project revision",
    }));

    expect(await screen.findByRole("heading", { name: "Ready now" })).toBeTruthy();
    expect(paths.some((path) => path.includes("expectedProjectRevision=8"))).toBe(true);
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test.each([
    ["Claim task", "Claim Implement ready work"],
    ["Renew claim", "Renew claim for Implement ready work"],
    ["Add checkpoint", "Checkpoint Implement ready work"],
    ["Pause claim", "Pause Implement ready work"],
    ["Release claim", "Release Implement ready work"],
    ["Switch task", "Switch from Implement ready work"],
    ["Delegate task", "Delegate Implement ready work"],
    ["Submit result", "Submit Implement ready work"],
  ])("opens the %s dialog", async (buttonName, dialogName) => {
    const coordinationState = buttonName === "Claim task"
      ? state({ claim: null, latestCheckpoint: null, delegation: null })
      : buttonName === "Delegate task"
        ? state({ claim: null, latestCheckpoint: null, delegation: null })
        : state();
    installQueue(coordinationState);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: buttonName }));
    expect(screen.getByRole("dialog", { name: dialogName })).toBeTruthy();
  });

  test("offers only the closed governance operation vocabulary for delegation", async () => {
    installQueue(state({ claim: null, latestCheckpoint: null, delegation: null }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Delegate task" }));

    const dialog = screen.getByRole("dialog", { name: "Delegate Implement ready work" });
    expect(within(dialog).getAllByRole("checkbox").map((checkbox) =>
      (checkbox as HTMLInputElement).value
    )).toEqual([
      "create_record",
      "create_relationship",
      "remove_relationship",
      "update_record",
    ]);
    expect(within(dialog).queryByRole("textbox", { name: "Allowed outputs" })).toBeNull();
  });

  test("offers accept and revoke dialogs only to the matching delegation identity", async () => {
    const offered = state({
      claim: null,
      latestCheckpoint: null,
      delegation: {
        ...state().delegation!,
        state: "offered",
        claimId: null,
        acceptedAt: null,
      },
    });
    installQueue(offered);
    render(
      <WorkQueue projectId="project-one" projectRevision={7} />,
    );
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Accept delegation" }));
    expect(screen.getByRole("dialog", { name: "Accept delegation for Implement ready work" }))
      .toBeTruthy();
    await user.keyboard("{Escape}");

    cleanup();
    installQueue(state({
      claim: null,
      latestCheckpoint: null,
      delegation: {
        ...offered.delegation!,
        parentProfileId: credentials.profileId,
        childProfileId: "profile-child",
      },
    }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const parentUser = await signIn();
    await parentUser.click(screen.getByRole("button", { name: "Revoke delegation" }));
    expect(screen.getByRole("dialog", { name: "Revoke delegation for Implement ready work" }))
      .toBeTruthy();
  });

  test("allows an accepted child to claim after the parent claim was released", async () => {
    installQueue(state({
      claim: {
        ...activeClaim,
        profileId: "profile-parent",
        state: "released",
        endedAt: timestamp,
      },
      latestCheckpoint: null,
      delegation: {
        ...state().delegation!,
        state: "accepted",
        claimId: null,
        acceptedAt: timestamp,
      },
    }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.getByRole("button", { name: "Claim task" })).toBeTruthy();
  });

  test("does not offer delegation while a live claim owns the task", async () => {
    installQueue(state({ delegation: null }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.queryByRole("button", { name: "Delegate task" })).toBeNull();
  });

  test("offers only ready tasks as atomic switch destinations", async () => {
    installQueue(state({ delegation: null }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Switch task" }));
    const dialog = screen.getByRole("dialog", { name: /Switch from/ });

    expect(within(dialog).getByRole("option", { name: "Continue ready work" }))
      .toBeTruthy();
    expect(within(dialog).queryByRole("option", { name: "Wait for dependency" }))
      .toBeNull();
  });

  test("hides atomic switch when there is no ready destination", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        return Promise.resolve(jsonResponse({ ...ready, tasks: [ready.tasks[0]!] }));
      }
      return Promise.resolve(jsonResponse(state({ delegation: null })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.queryByRole("button", { name: "Switch task" })).toBeNull();
  });

  test("does not offer claim or delegation while dependencies block the task", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        return Promise.resolve(jsonResponse(ready));
      }
      if (path.includes("taskId=task-blocked")) {
        return Promise.resolve(jsonResponse(state({
          task: task("task-blocked", "Wait for dependency"),
          claim: null,
          latestCheckpoint: null,
          delegation: null,
        })));
      }
      return Promise.resolve(jsonResponse(state()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: /Wait for dependency/ }));
    await screen.findByRole("heading", { name: "Wait for dependency" });

    expect(screen.queryByRole("button", { name: "Claim task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delegate task" })).toBeNull();
  });

  test("aborts selected-task work on sign out and ignores its late response", async () => {
    const signedOutToken = "sign-out-secret-must-not-leak";
    let resolveBlocked!: (response: Response) => void;
    let blockedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      if (path.includes("taskId=task-ready")) return Promise.resolve(jsonResponse(state()));
      blockedSignal = init?.signal ?? null;
      return new Promise<Response>((resolve) => {
        resolveBlocked = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), signedOutToken);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
    await screen.findByRole("heading", { name: "Ready now" });
    await user.click(screen.getByRole("button", { name: /Wait for dependency/ }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(blockedSignal?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain(signedOutToken);
    expect(location.href).not.toContain(signedOutToken);
    expect(JSON.stringify(localStorage)).not.toContain(signedOutToken);
    expect(JSON.stringify(sessionStorage)).not.toContain(signedOutToken);
    resolveBlocked(jsonResponse(state({
      task: task("task-blocked", "Wait for dependency"),
      claim: null,
      delegation: null,
      latestCheckpoint: null,
    })));
    await Promise.resolve();
    expect(screen.queryByRole("form", { name: "Profile credentials" })).toBeNull();
  });

  test("prevents a stale task response from overwriting a newer selection", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      if (path.includes("taskId=task-ready")) return Promise.resolve(jsonResponse(state()));
      if (path.includes("taskId=task-blocked")) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(jsonResponse(state({
        task: task("task-next", "Continue ready work"),
        claim: null,
        delegation: null,
        latestCheckpoint: null,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: /Wait for dependency/ }));
    await user.click(screen.getByRole("button", { name: /Continue ready work/ }));
    expect(await screen.findByRole("heading", { name: "Continue ready work" }))
      .toBeTruthy();

    await act(async () => resolveFirst(jsonResponse(state({
      task: task("task-blocked", "Wait for dependency"),
      claim: null,
      delegation: null,
      latestCheckpoint: null,
    }))));
    await waitFor(() => expect(screen.getByRole("heading", {
      name: "Continue ready work",
    })).toBeTruthy());
  });

  test("does not reconcile an aborted mutation after the route identity changes", async () => {
    let mutationSignal: AbortSignal | null = null;
    const paths: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      if (path.includes("/coordination/state?")) return Promise.resolve(jsonResponse(state()));
      mutationSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        mutationSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <WorkQueue projectId="project-one" projectRevision={7} />,
    );
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Renew claim" }));
    await user.click(screen.getByRole("button", { name: "Confirm renewal" }));
    await waitFor(() => expect(mutationSignal).not.toBeNull());
    const callsBeforeExit = paths.length;

    rerender(<WorkQueue projectId="project-two" projectRevision={1} />);
    await waitFor(() => expect(mutationSignal?.aborted).toBe(true));
    await Promise.resolve();

    expect(paths).toHaveLength(callsBeforeExit);
    expect(screen.queryByRole("form", { name: "Profile credentials" })).toBeNull();
  });

  test("clears credentials and skips reconciliation after mutation authentication failure", async () => {
    let readyReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyReads += 1;
        return Promise.resolve(jsonResponse(ready));
      }
      if (path.includes("/coordination/state?")) return Promise.resolve(jsonResponse(state()));
      return Promise.resolve(jsonResponse({
        error: {
          code: "invalid_profile_credentials",
          message: "Invalid profile credentials",
          recoverable: false,
        },
      }, 401));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Renew claim" }));
    await user.click(screen.getByRole("button", { name: "Confirm renewal" }));

    expect(await screen.findByRole("form", { name: "Profile credentials" }))
      .toBeTruthy();
    expect(readyReads).toBe(1);
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test("traps keyboard focus, closes with Escape, and restores the action trigger", async () => {
    installQueue();
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    const trigger = screen.getByRole("button", { name: "Release claim" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "Release Implement ready work",
    });
    const close = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", {
      name: "Confirm release",
    });
    expect(document.activeElement).toBe(close);
    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("replays the exact serialized mutation before reporting an ambiguous failure", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return jsonResponse(ready);
      if (path.includes("/coordination/state?")) {
        stateReads += 1;
        return jsonResponse(state());
      }
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      if (requests.length === 1) throw new Error("connection ended");
      if (requests.length === 2) return jsonResponse({ claim: { invalid: true } });
      return jsonResponse({ claim: activeClaim });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Renew claim" }));
    await user.click(screen.getByRole("button", { name: "Confirm renewal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be confirmed");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(stateReads).toBe(1);
    await user.click(screen.getByRole("button", { name: "Confirm renewal" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[0]!.body.idempotencyKey).toBe("work-queue-stable-attempt");
    expect(requests[2]).toEqual(requests[0]);
    expect(stateReads).toBeGreaterThan(1);
  });

  test("loads every ready-task page under the same project revision", async () => {
    const readyPaths: string[] = [];
    const firstPage = {
      ...ready,
      tasks: ready.tasks.slice(0, 2),
      nextCursor: "YQ",
    };
    const secondPage = {
      ...ready,
      tasks: ready.tasks.slice(2),
      nextCursor: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyPaths.push(path);
        return Promise.resolve(jsonResponse(path.includes("cursor=YQ")
          ? secondPage
          : firstPage));
      }
      return Promise.resolve(jsonResponse(state()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(screen.getByRole("button", { name: /Continue ready work/ })).toBeTruthy();
    expect(readyPaths).toHaveLength(2);
    expect(readyPaths[1]).toContain("cursor=YQ");
    expect(readyPaths.every((path) => path.includes("expectedProjectRevision=7")))
      .toBe(true);
  });

  test("accepts exactly 10,000 unique ready tasks across exactly 100 pages", async () => {
    let readyReads = 0;
    let resolveStateRequested!: () => void;
    const stateRequested = new Promise<void>((resolve) => {
      resolveStateRequested = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyReads += 1;
        const tasks = Array.from({ length: 100 }, (_, index) => ({
          task: task(`task-cap-${readyReads}-${index}`, `Cap task ${readyReads}-${index}`),
          blockers: [],
          liveClaimId: null,
          liveDelegationId: null,
        }));
        return Promise.resolve(jsonResponse({
          ...ready,
          tasks,
          nextCursor: readyReads === 100
            ? null
            : btoa(`cap-page-${readyReads}`).replace(/=+$/u, ""),
        }));
      }
      resolveStateRequested();
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    await stateRequested;

    expect(readyReads).toBe(100);
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
  });

  test("rejects 10,001 ready tasks and requires fresh authentication", async () => {
    let readyReads = 0;
    let recovered = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyReads += 1;
        if (recovered) return Promise.resolve(jsonResponse(ready));
        const page = readyReads;
        const count = page === 100 ? 101 : 100;
        return Promise.resolve(jsonResponse({
          ...ready,
          tasks: Array.from({ length: count }, (_, index) => ({
            task: task(`task-over-${page}-${index}`, `Over task ${page}-${index}`),
            blockers: [],
            liveClaimId: null,
            liveDelegationId: null,
          })),
          nextCursor: page === 100
            ? null
            : btoa(`over-page-${page}`).replace(/=+$/u, ""),
        }));
      }
      return Promise.resolve(jsonResponse(state()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the Work Queue.",
    );
    expect(readyReads).toBe(100);
    expect(screen.getByRole("form", { name: "Profile credentials" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    recovered = true;
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), "new-pagination-token");
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect(await screen.findByRole("heading", { name: "Ready now" })).toBeTruthy();
    expect(readyReads).toBe(101);
  });

  test("bounds endless unique ready-task cursors and requires fresh authentication", async () => {
    let readyReads = 0;
    let recovered = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyReads += 1;
        if (!recovered) {
          return Promise.resolve(jsonResponse({
            ...ready,
            tasks: [],
            nextCursor: btoa(`page-${readyReads}`).replace(/=+$/u, ""),
          }));
        }
        return Promise.resolve(jsonResponse(ready));
      }
      return Promise.resolve(jsonResponse(state()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the Work Queue.",
    );
    expect(readyReads).toBe(100);
    expect(screen.getByRole("form", { name: "Profile credentials" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((screen.getByLabelText("Profile token") as HTMLInputElement).value).toBe("");
    recovered = true;
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), "new-cursor-token");
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));
    expect(await screen.findByRole("heading", { name: "Ready now" })).toBeTruthy();
  });

  test("writes a canonical encoded task selection URL and follows route selection changes", async () => {
    const selectedPaths: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      selectedPaths.push(path);
      const selected = path.includes("taskId=task-next")
        ? state({ task: task("task-next", "Continue ready work"), claim: null, delegation: null })
        : state();
      return Promise.resolve(jsonResponse(selected));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-ready" />,
    );
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: /Continue ready work/ }));
    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-next");
    expect(await screen.findByRole("heading", { name: "Continue ready work" })).toBeTruthy();

    rerender(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-next" />,
    );
    rerender(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-ready" />,
    );
    expect(await screen.findByRole("heading", { name: "Implement ready work" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Profile credentials" })).toBeNull();
    expect(selectedPaths.some((path) => path.includes("taskId=task-ready"))).toBe(true);
  });

  test.each([
    ["an omitted task", null, "/projects/project-one/work"],
    ["an absent task", "task-missing", "/projects/project-one/work?taskId=task-missing"],
  ])("replaces %s with the canonical fallback task URL", async (_label, initialTaskId, path) => {
    history.replaceState(history.state, "", path);
    const historyLength = history.length;
    installQueue();
    render(
      <WorkQueue
        projectId="project-one"
        projectRevision={7}
        initialTaskId={initialTaskId}
      />,
    );

    await signIn();

    expect(`${location.pathname}${location.search}`)
      .toBe("/projects/project-one/work?taskId=task-ready");
    expect(history.length).toBe(historyLength);
    expect(screen.getByRole("heading", { name: "Implement ready work" })).toBeTruthy();
  });

  test("defers fallback URL replacement through the router without clearing credentials", async () => {
    history.replaceState(
      null,
      "",
      "/projects/project-one/work?taskId=task-missing",
    );
    act(() => {
      navigate("/projects/project-one/work?taskId=task-missing");
    });
    let settled = false;
    const dispose = registerRouteBlocker(() => settled ? "allow" : "defer");
    const historyGo = vi.spyOn(history, "go");
    try {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/coordination/ready?")) {
          return Promise.resolve(jsonResponse(ready));
        }
        if (path.includes("taskId=task-next")) {
          return Promise.resolve(jsonResponse(state({
            task: task("task-next", "Continue ready work"),
            claim: null,
            latestCheckpoint: null,
            delegation: null,
          })));
        }
        return Promise.resolve(jsonResponse(state()));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(
        <WorkQueue
          projectId="project-one"
          projectRevision={7}
          initialTaskId="task-missing"
        />,
      );
      const user = await signIn();

      expect(`${location.pathname}${location.search}`)
        .toBe("/projects/project-one/work?taskId=task-missing");
      expect(screen.getByRole("heading", { name: "Implement ready work" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
      expect(historyGo).not.toHaveBeenCalled();

      settled = true;
      expect(resumeDeferredNavigation()).toBe("resumed");
      expect(`${location.pathname}${location.search}`)
        .toBe("/projects/project-one/work?taskId=task-ready");
      expect(historyGo).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /Continue ready work/ }));
      expect(await screen.findByRole("heading", { name: "Continue ready work" })).toBeTruthy();
      expect(screen.queryByRole("form", { name: "Profile credentials" })).toBeNull();
    } finally {
      dispose();
      cancelDeferredNavigation();
      historyGo.mockRestore();
    }
  });

  test("uses the latest route task after signed-out history changes", async () => {
    const selectedPaths: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      selectedPaths.push(path);
      const selected = path.includes("taskId=task-ready")
        ? state()
        : state({
            task: task("task-next", "Continue ready work"),
            claim: null,
            latestCheckpoint: null,
            delegation: null,
          });
      return Promise.resolve(jsonResponse(selected));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-next" />,
    );

    const firstUser = await signIn();
    expect(await screen.findByRole("heading", { name: "Continue ready work" })).toBeTruthy();
    await firstUser.click(screen.getByRole("button", { name: "Sign out" }));

    rerender(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-ready" />,
    );
    await signIn();

    expect(await screen.findByRole("heading", { name: "Implement ready work" })).toBeTruthy();
    expect(selectedPaths.at(-1)).toContain("taskId=task-ready");
  });

  test("lets a route selection supersede the initial queue load", async () => {
    let resolveReady!: () => void;
    const readyRequest = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const selectedPaths: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        return readyRequest.then(() => jsonResponse(ready));
      }
      selectedPaths.push(path);
      const selected = path.includes("taskId=task-next")
        ? state({
            task: task("task-next", "Continue ready work"),
            claim: null,
            latestCheckpoint: null,
            delegation: null,
          })
        : state();
      return Promise.resolve(jsonResponse(selected));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-ready" />,
    );
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    rerender(
      <WorkQueue projectId="project-one" projectRevision={7} initialTaskId="task-next" />,
    );
    resolveReady();

    expect(await screen.findByRole("heading", { name: "Continue ready work" })).toBeTruthy();
    expect(selectedPaths.at(-1)).toContain("taskId=task-next");
  });

  test("a newer task selection aborts and supersedes an in-flight queue refresh", async () => {
    const expired = state({
      claim: {
        ...activeClaim,
        acquiredAt: "2026-08-20T09:00:00.000Z",
        expiresAt: "2026-08-20T10:00:00.000Z",
        absoluteExpiresAt: "2026-08-20T13:00:00.000Z",
      },
    });
    let readyReads = 0;
    let refreshSignal: AbortSignal | null = null;
    let resolveRefresh!: (response: Response) => void;
    const refreshRequest = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        readyReads += 1;
        if (readyReads === 1) return Promise.resolve(jsonResponse(ready));
        refreshSignal = init?.signal ?? null;
        return refreshRequest;
      }
      const selected = path.includes("taskId=task-next")
        ? state({
            task: task("task-next", "Continue ready work"),
            claim: null,
            latestCheckpoint: null,
            delegation: null,
          })
        : expired;
      return Promise.resolve(jsonResponse(selected));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();

    await user.click(screen.getByRole("button", { name: "Refresh expired claim" }));
    await user.click(screen.getByRole("button", { name: /Continue ready work/ }));
    expect(await screen.findByRole("heading", { name: "Continue ready work" })).toBeTruthy();
    expect(refreshSignal?.aborted).toBe(true);

    resolveRefresh(jsonResponse(ready));
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "Continue ready work" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Implement ready work" })).toBeNull();
  });

  test("bounds concurrent accepted-delegation state reads", async () => {
    const tasks = Array.from({ length: 9 }, (_, index) => {
      const id = `task-delegated-${index}`;
      return {
        task: task(id, `Delegated task ${index}`),
        blockers: [`delegation_live:delegation-${index}`],
        liveClaimId: null,
        liveDelegationId: `delegation-${index}`,
      };
    });
    const delegatedReady: CoordinationReadyResponse = {
      projectRevision: 7,
      nextCursor: null,
      tasks,
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return jsonResponse(delegatedReady);
      const taskId = new URL(path, "http://intentarc.test").searchParams.get("taskId")!;
      const index = Number(taskId.slice("task-delegated-".length));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => window.setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse(state({
        task: task(taskId, `Delegated task ${index}`),
        claim: null,
        latestCheckpoint: null,
        delegation: {
          ...state().delegation!,
          id: `delegation-${index}`,
          taskId,
          state: "accepted",
          claimId: null,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    await signIn();

    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  test("aborts and settles the whole bounded delegation load before reporting authentication failure", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => {
      const id = `task-delegated-${index}`;
      return {
        task: task(id, `Delegated task ${index}`),
        blockers: [`delegation_live:delegation-${index}`],
        liveClaimId: null,
        liveDelegationId: `delegation-${index}`,
      };
    });
    const delegatedReady: CoordinationReadyResponse = {
      projectRevision: 7,
      nextCursor: null,
      tasks,
    };
    const startedTaskIds: string[] = [];
    const sharedSignals: AbortSignal[] = [];
    const settleDeferred: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) {
        return Promise.resolve(jsonResponse(delegatedReady));
      }
      const taskId = new URL(path, "http://intentarc.test").searchParams.get("taskId")!;
      startedTaskIds.push(taskId);
      sharedSignals.push(init?.signal as AbortSignal);
      if (taskId === "task-delegated-0") {
        return Promise.resolve(jsonResponse({
          error: {
            code: "invalid_profile_credentials",
            message: "Invalid profile credentials",
            recoverable: false,
          },
        }, 401));
      }
      if (Number(taskId.slice("task-delegated-".length)) < 4) {
        return new Promise<Response>((resolve) => settleDeferred.push(resolve));
      }
      return Promise.resolve(jsonResponse(state({
        task: task(taskId, taskId),
        claim: null,
        latestCheckpoint: null,
        delegation: null,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = userEvent.setup();
    await openAdvancedAccess(user);
    await user.type(screen.getByLabelText("Profile ID"), credentials.profileId);
    await user.type(screen.getByLabelText("Profile token"), credentials.token);
    await user.click(screen.getByRole("button", { name: "Open Work Queue" }));

    await waitFor(() => expect(sharedSignals).toHaveLength(4));
    const abortedBeforeSettlement = sharedSignals.every((signal) => signal.aborted);
    const loadingBeforeSettlement = screen.queryByText("Loading work queue…") !== null;

    await act(async () => {
      for (const resolve of settleDeferred) {
        resolve(jsonResponse(state({ delegation: null })));
      }
    });
    expect(await screen.findByRole("form", { name: "Profile credentials" })).toBeTruthy();

    expect(new Set(sharedSignals).size).toBe(1);
    expect(abortedBeforeSettlement).toBe(true);
    expect(loadingBeforeSettlement).toBe(true);
    expect(startedTaskIds).toEqual([
      "task-delegated-0",
      "task-delegated-1",
      "task-delegated-2",
      "task-delegated-3",
    ]);
    expect(document.body.textContent).not.toContain(credentials.token);
  });

  test("clears stale parent evidence when an exact child claim overlays state", async () => {
    const childClaim = {
      ...activeClaim,
      id: "claim-child",
      contextPackId: "context-child",
      latestCheckpointId: null,
    };
    const childState = state({
      claim: childClaim,
      latestCheckpoint: null,
      delegation: null,
      submission: null,
    });
    const staleParentState = state({
      claim: {
        ...activeClaim,
        id: "claim-parent",
        profileId: "profile-parent",
      },
      delegation: {
        ...state().delegation!,
        claimId: "claim-parent",
      },
      submission: {
        id: "submission-parent",
        claimId: "claim-parent",
        checkpointId: checkpoint.id,
        profileId: "profile-parent",
        projectId: "project-one",
        taskId: "task-ready",
        baseProjectRevision: 7,
        baseTaskRevision: 2,
        contextPackId: "context-one",
        summary: "Parent submission",
        verificationEvidence: { tests: [], artifacts: [] },
        repositoryEvidence: null,
        proposalId: "proposal-parent",
        state: "submitted",
        submittedAt: timestamp,
        decidedAt: null,
      },
    });
    let stateReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      if (path.includes("/coordination/state?")) {
        stateReads += 1;
        return Promise.resolve(jsonResponse(stateReads === 1 ? childState : staleParentState));
      }
      return Promise.resolve(jsonResponse({ claim: childClaim }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();

    await user.click(screen.getByRole("button", { name: "Renew claim" }));
    await user.click(screen.getByRole("button", { name: "Confirm renewal" }));
    await screen.findByText("Renew claim completed. Coordination state refreshed.");

    expect(screen.getByText("No checkpoint recorded.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Delegation scope" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Submission" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit result" })).toBeNull();
  });

  test("includes an accepted delegated target in switch with its exact delegation ID", async () => {
    const delegatedQueue: CoordinationReadyResponse = {
      ...ready,
      tasks: ready.tasks.map((item) => item.task.id === "task-next"
        ? {
            ...item,
            blockers: ["delegation_live:delegation-next"],
            liveDelegationId: "delegation-next",
          }
        : item),
    };
    const mutationBodies: Record<string, unknown>[] = [];
    const acceptedTarget = state({
      task: task("task-next", "Continue ready work"),
      claim: null,
      latestCheckpoint: null,
      delegation: {
        ...state().delegation!,
        id: "delegation-next",
        state: "accepted",
        claimId: null,
      },
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(delegatedQueue));
      if (path.includes("taskId=task-next")) return Promise.resolve(jsonResponse(acceptedTarget));
      if (path.includes("/coordination/state?")) return Promise.resolve(jsonResponse(state({ delegation: null })));
      mutationBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({
        previousClaim: { ...activeClaim, state: "released", endedAt: timestamp },
        nextClaim: { ...activeClaim, id: "claim-next", taskId: "task-next", delegationId: "delegation-next" },
        checkpoint,
        contextPack: {
          id: "context-next",
          projectId: "project-one",
          taskId: "task-next",
          projectRevision: 7,
          taskRevision: 2,
          budgetTokens: 4096,
          sections: [],
          createdAt: timestamp,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Switch task" }));
    const dialog = screen.getByRole("dialog", { name: /Switch from/ });
    await user.selectOptions(within(dialog).getByLabelText("Next task"), "task-next");
    await user.type(within(dialog).getByLabelText("Summary"), "Switch evidence");
    await user.click(within(dialog).getByRole("button", { name: "Confirm switch" }));

    await waitFor(() => expect(mutationBodies.length).toBeGreaterThan(0));
    expect(mutationBodies[0]!.acceptedDelegationId).toBe("delegation-next");
  });

  test("requires explicit confirmation for release, revoke, switch, and submit", async () => {
    installQueue();
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    for (const [open, confirm] of [
      ["Release claim", "Confirm release"],
      ["Switch task", "Confirm switch"],
      ["Submit result", "Confirm submission"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: open }));
      expect(screen.getByRole("button", { name: confirm })).toBeTruthy();
      await user.keyboard("{Escape}");
    }
  });

  test("offers explicit release recovery for an owned conflicted submission", async () => {
    installQueue(state({
      claim: {
        ...activeClaim,
        id: "claim-historical-parent",
        profileId: "profile-parent",
        state: "released",
        endedAt: timestamp,
      },
      submission: {
        id: "submission-conflicted",
        claimId: "claim-child-submission",
        checkpointId: checkpoint.id,
        profileId: credentials.profileId,
        projectId: "project-one",
        taskId: "task-ready",
        baseProjectRevision: 7,
        baseTaskRevision: 2,
        contextPackId: "context-one",
        summary: "Stale result",
        verificationEvidence: { tests: [], artifacts: [] },
        repositoryEvidence: null,
        proposalId: "proposal-conflicted",
        state: "conflicted",
        submittedAt: timestamp,
        decidedAt: timestamp,
      },
    }));
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();

    const release = screen.getByRole("button", { name: "Release claim" });
    await user.click(release);
    expect(screen.getByRole("button", { name: "Confirm release" })).toBeTruthy();
  });

  test("expires claim actions on a bounded timer and offers explicit recovery", async () => {
    vi.useFakeTimers({ now: new Date(timestamp), shouldAdvanceTime: true });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    installQueue(state({
      claim: {
        ...activeClaim,
        acquiredAt: "2026-08-20T09:45:00.000Z",
        expiresAt: "2026-08-20T10:00:02.000Z",
        absoluteExpiresAt: "2026-08-20T13:45:00.000Z",
      },
    }));
    const { unmount } = render(
      <WorkQueue projectId="project-one" projectRevision={7} />,
    );
    await signIn();
    expect(screen.getByRole("button", { name: "Renew claim" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_100));

    expect(screen.queryByRole("button", { name: "Renew claim" })).toBeNull();
    expect(screen.getByText("Lease expired · refresh to recover")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh expired claim" })).toBeTruthy();
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  test.each(["expired", "revoked"] as const)(
    "shows %s delegation state, allowed outputs, and recovery",
    async (delegationState) => {
      installQueue(state({
        claim: null,
        delegation: {
          ...state().delegation!,
          state: delegationState,
          endedAt: timestamp,
          claimId: null,
        },
      }));
      render(<WorkQueue projectId="project-one" projectRevision={7} />);
      await signIn();

      const details = screen.getByRole("region", { name: "Selected work" });
      expect(details.textContent).toContain(`State: ${delegationState}`);
      expect(details.textContent).toContain("Allowed outputs: create_record, update_record");
      expect(details.textContent).toContain(`This delegation is ${delegationState}`);
      expect(screen.getByRole("button", { name: "Refresh coordination" })).toBeTruthy();
    },
  );

  test("focuses the stable success status when the successful action is no longer eligible", async () => {
    const releasedClaim = {
      ...activeClaim,
      state: "released" as const,
      endedAt: timestamp,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/coordination/ready?")) return Promise.resolve(jsonResponse(ready));
      if (path.includes("/coordination/state?")) {
        return Promise.resolve(jsonResponse(state()));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ claim: releasedClaim }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkQueue projectId="project-one" projectRevision={7} />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: "Release claim" }));
    await user.click(screen.getByRole("button", { name: "Confirm release" }));

    const status = await screen.findByRole("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status.textContent).toContain("Release claim completed");
    expect(screen.queryByRole("button", { name: "Release claim" })).toBeNull();
  });
});
