// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectRecord } from "../../../domain/index.js";
import type { ProjectDashboardResponse } from "../../contracts.js";
import { ProjectHome } from "./project-home.js";

const timestamp = "2026-07-29T12:00:00.000Z";

const neutralVocabulary: ProjectDashboardResponse["hierarchyVocabulary"] = {
  preset: "neutral",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
};

const recordFixture = (
  id: string,
  kind: ProjectRecord["kind"],
  title: string,
  status: ProjectRecord["status"] = "active",
  body = "",
): ProjectRecord => ({
  id,
  projectId: "example-game",
  kind,
  status,
  title,
  body,
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const outcome = recordFixture(
  "outcome-one",
  "outcome",
  "Reach a stable combat loop",
  "active",
  "Encounters should replay consistently before balance work begins.",
);
const task = recordFixture(
  "task-one",
  "task",
  "Verify deterministic encounter seeds",
  "active",
  "Run the same encounter seed across supported clients.",
);
const evidence = recordFixture(
  "evidence-one",
  "evidence",
  "Cross-client replay log",
  "accepted",
);

const pathSegment = ({
  id,
  projectId,
  kind,
  status,
  title,
}: ProjectRecord): ProjectDashboardResponse["currentFocusPath"][number] => ({
  id,
  projectId,
  kind,
  status,
  title,
});

const dashboardFixture = (
  overrides: Partial<ProjectDashboardResponse> = {},
): ProjectDashboardResponse => {
  const dashboard = {
    project: {
      id: "example-game",
      name: "Example Game",
      revision: 7,
      primaryRepositoryPath: "C:\\projects\\example-game",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    recordsByKind: { outcome: 1, task: 1, evidence: 1 },
    hierarchyVocabulary: neutralVocabulary,
    currentOutcome: outcome,
    currentTask: task,
    currentFocusPath: [pathSegment(outcome), pathSegment(task)],
    attention: null,
    pendingProposalCount: 1,
    recentRecords: [task, evidence],
    ...overrides,
  };
  if (overrides.hierarchyParentContexts) {
    return { ...dashboard, hierarchyParentContexts: overrides.hierarchyParentContexts };
  }
  const hierarchyKinds = new Set(["outcome", "initiative", "deliverable", "milestone", "task"]);
  const pathParentKinds = new Map(
    dashboard.currentFocusPath.slice(1).map((record, index) => [
      record.id,
      dashboard.currentFocusPath[index]!.kind,
    ]),
  );
  const projected = [
    dashboard.currentOutcome,
    dashboard.currentTask,
    dashboard.attention,
    ...dashboard.recentRecords,
    ...dashboard.currentFocusPath,
  ].filter((record) => record !== null && hierarchyKinds.has(record.kind));
  return {
    ...dashboard,
    hierarchyParentContexts: [...new Map(projected.map((record) => [record.id, {
      recordId: record.id,
      parentKind: pathParentKinds.get(record.id) ?? null,
    }])).values()] as ProjectDashboardResponse["hierarchyParentContexts"],
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  history.replaceState(null, "", "/projects/example-game");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectHome", () => {
  test.each([
    {
      name: "a foreign dashboard project",
      response: () => {
        const dashboard = dashboardFixture();
        const foreignRecord = <RecordType extends { projectId: string }>(
          record: RecordType,
        ): RecordType => ({ ...record, projectId: "foreign-project" });
        return {
          ...dashboard,
          project: {
            ...dashboard.project,
            id: "foreign-project",
            name: "foreign-dashboard-token",
          },
          currentOutcome: dashboard.currentOutcome
            ? foreignRecord(dashboard.currentOutcome)
            : null,
          currentTask: dashboard.currentTask
            ? foreignRecord(dashboard.currentTask)
            : null,
          attention: dashboard.attention
            ? foreignRecord(dashboard.attention)
            : null,
          recentRecords: dashboard.recentRecords.map(foreignRecord),
          currentFocusPath: dashboard.currentFocusPath.map(foreignRecord),
        };
      },
    },
    {
      name: "a foreign current outcome",
      response: () => ({
        ...dashboardFixture(),
        currentOutcome: {
          ...outcome,
          id: "foreign-outcome",
          projectId: "foreign-project",
          title: "foreign-dashboard-token",
        },
      }),
    },
    {
      name: "a foreign current task",
      response: () => ({
        ...dashboardFixture(),
        currentTask: {
          ...task,
          id: "foreign-task",
          projectId: "foreign-project",
          title: "foreign-dashboard-token",
        },
      }),
    },
    {
      name: "a foreign attention record",
      response: () => ({
        ...dashboardFixture(),
        attention: {
          ...evidence,
          id: "foreign-attention",
          projectId: "foreign-project",
          title: "foreign-dashboard-token",
        },
      }),
    },
    {
      name: "a foreign recent record",
      response: () => ({
        ...dashboardFixture(),
        recentRecords: [{
          ...evidence,
          id: "foreign-recent",
          projectId: "foreign-project",
          title: "foreign-dashboard-token",
        }],
      }),
    },
    {
      name: "a foreign focus-path record",
      response: () => ({
        ...dashboardFixture(),
        currentFocusPath: [{
          id: "foreign-path",
          projectId: "foreign-project",
          kind: "task" as const,
          status: "active" as const,
          title: "foreign-dashboard-token",
        }],
      }),
    },
    {
      name: "a malformed hierarchy vocabulary",
      response: () => ({
        ...dashboardFixture(),
        hierarchyVocabulary: {
          ...neutralVocabulary,
          task: "",
        },
      }),
    },
    {
      name: "duplicate hierarchy parent contexts",
      response: () => ({
        ...dashboardFixture(),
        hierarchyParentContexts: [
          { recordId: outcome.id, parentKind: null },
          { recordId: task.id, parentKind: "outcome" },
          { recordId: task.id, parentKind: "outcome" },
        ],
      }),
    },
    {
      name: "a hierarchy parent context for a non-hierarchy record",
      response: () => ({
        ...dashboardFixture(),
        hierarchyParentContexts: [
          { recordId: outcome.id, parentKind: null },
          { recordId: task.id, parentKind: "outcome" },
          { recordId: evidence.id, parentKind: null },
        ],
      }),
    },
    {
      name: "an unknown hierarchy parent context",
      response: () => ({
        ...dashboardFixture(),
        hierarchyParentContexts: [
          { recordId: outcome.id, parentKind: null },
          { recordId: task.id, parentKind: "outcome" },
          { recordId: "unknown-record", parentKind: null },
        ],
      }),
    },
    {
      name: "a malformed hierarchy parent kind",
      response: () => ({
        ...dashboardFixture(),
        hierarchyParentContexts: [
          { recordId: outcome.id, parentKind: null },
          { recordId: task.id, parentKind: "evidence" },
        ],
      }),
    },
  ])("fails closed when the response contains $name", async ({ response }) => {
    const onDashboardLoad = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(response())),
    );

    render(
      <ProjectHome
        projectId="example-game"
        onDashboardLoad={onDashboardLoad}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not validate this project dashboard.",
    );
    expect(onDashboardLoad.mock.calls.map(([event]) => event.status))
      .toEqual(["loading", "error"]);
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(document.body.innerHTML).not.toContain("foreign-dashboard-token");
  });

  test("fails closed when the response omits the focus path", async () => {
    const { currentFocusPath: _missingPath, ...malformed } = dashboardFixture();
    const onDashboardLoad = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(malformed)),
    );

    render(
      <ProjectHome
        projectId="example-game"
        onDashboardLoad={onDashboardLoad}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not validate this project dashboard.",
    );
    expect(onDashboardLoad.mock.calls.map(([event]) => event.status))
      .toEqual(["loading", "error"]);
  });

  test("presents the dashboard as a concise overview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture())),
    );

    render(<ProjectHome projectId="example-game" />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Project state" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Current focus" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Attention" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recent changes" })).toBeTruthy();
    expect(screen.queryByText("Keep the outcome in reach.")).toBeNull();
    expect(screen.queryByText(/Move from intent to the next task/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Example Game" })).toBeTruthy();
    expect(screen.queryByText("Revision 7")).toBeNull();
    expect(screen.getByRole("link", {
      name: "Outcome: Reach a stable combat loop (outcome-one)",
    })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Current focus" })).getByRole(
        "link",
        { name: "Open Work item: Verify deterministic encounter seeds" },
      ),
    ).toBeTruthy();
    expect(screen.getByText("1 pending proposal")).toBeTruthy();
  });

  test("links every authoritative focus path identity to its project Map record", async () => {
    const initiative = recordFixture(
      "initiative-one",
      "initiative",
      "Make replay verification legible",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
        currentFocusPath: [outcome, initiative, task].map(pathSegment),
      }))),
    );

    render(<ProjectHome projectId="example-game" />);

    const path = await screen.findByRole("navigation", {
      name: "Current focus path",
    });
    expect(within(path).getByRole("link", {
      name: "Project: Example Game (example-game)",
    }).getAttribute("href")).toBe("/projects/example-game/map");
    expect(within(path).getByRole("link", {
      name: "Outcome: Reach a stable combat loop (outcome-one)",
    }).getAttribute("href")).toBe(
      "/projects/example-game/map?focusRecordId=outcome-one",
    );
    expect(within(path).getByRole("link", {
      name: "Initiative: Make replay verification legible (initiative-one)",
    }).getAttribute("href")).toBe(
      "/projects/example-game/map?focusRecordId=initiative-one",
    );
    expect(within(path).getByRole("link", {
      name: "Work item: Verify deterministic encounter seeds (task-one)",
    }).getAttribute("href")).toBe(
      "/projects/example-game/map?focusRecordId=task-one",
    );
  });

  test.each([
    {
      name: "Software",
      vocabulary: {
        preset: "software" as const,
        outcome: "Product outcome",
        initiative: "Epic",
        deliverable: "Feature",
        milestone: "Milestone",
        task: "Story or Task",
        nestedTask: "Subtask",
      },
      expected: ["Product outcome", "Epic", "Feature", "Story or Task", "Subtask"],
    },
    {
      name: "custom Simple",
      vocabulary: {
        preset: "simple" as const,
        outcome: "Goal",
        initiative: "Stream",
        deliverable: "Result",
        milestone: "Checkpoint",
        task: "Action",
        nestedTask: "Step",
      },
      expected: ["Goal", "Stream", "Result", "Action", "Step"],
    },
  ])("uses $name hierarchy labels for paths and hierarchy records", async ({ vocabulary, expected }) => {
    const initiative = recordFixture("initiative-one", "initiative", "Guide delivery");
    const deliverable = recordFixture("deliverable-one", "deliverable", "Readable overview");
    const currentTask = recordFixture("task-current", "task", "Verify the experience");
    const nestedTask = recordFixture("task-child", "task", "Check unrelated details", "blocked");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
      hierarchyVocabulary: vocabulary,
      hierarchyParentContexts: [
        { recordId: outcome.id, parentKind: null },
        { recordId: initiative.id, parentKind: "outcome" },
        { recordId: deliverable.id, parentKind: "initiative" },
        { recordId: currentTask.id, parentKind: "deliverable" },
        { recordId: nestedTask.id, parentKind: "task" },
      ],
      currentTask,
      currentFocusPath: [outcome, initiative, deliverable, currentTask].map(pathSegment),
      attention: nestedTask,
      recentRecords: [nestedTask],
    }))));

    render(<ProjectHome projectId="example-game" />);

    const path = await screen.findByRole("navigation", { name: "Current focus path" });
    for (const label of expected.slice(0, -1)) {
      expect(within(path).getByText(label)).toBeTruthy();
    }
    expect(within(screen.getByRole("region", { name: "Attention" })).getByRole(
      "link",
      { name: `Open ${expected.at(-1)} Check unrelated details` },
    )).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Recent changes" }))
      .getByText(expected.at(-1)!)).toBeTruthy();
    expect(screen.getByText(`Current ${expected.at(-2)}`)).toBeTruthy();
    expect(screen.getByRole("link", {
      name: `Open ${expected.at(-2)}: Verify the experience`,
    }).textContent).toContain(`Open ${expected.at(-2)}`);
  });

  test.each([
    {
      name: "Software",
      vocabulary: {
        preset: "software" as const,
        outcome: "Product outcome",
        initiative: "Epic",
        deliverable: "Feature",
        milestone: "Milestone",
        task: "Story or Task",
        nestedTask: "Subtask",
      },
    },
    {
      name: "custom Simple",
      vocabulary: {
        preset: "simple" as const,
        outcome: "Goal",
        initiative: "Stream",
        deliverable: "Result",
        milestone: "Checkpoint",
        task: "Action",
        nestedTask: "Step",
      },
    },
  ])("uses $name vocabulary when outcome and current work are absent", async ({ vocabulary }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
      hierarchyVocabulary: vocabulary,
      currentOutcome: null,
      currentTask: null,
      currentFocusPath: [],
      attention: null,
      pendingProposalCount: 0,
      recentRecords: [evidence],
    }))));

    render(<ProjectHome projectId="example-game" />);

    expect(await screen.findByText(`${vocabulary.outcome} not established`)).toBeTruthy();
    expect(screen.getByText(`No ${vocabulary.task} in focus`)).toBeTruthy();
  });

  test("shows only metrics and records with truthful project-bound destinations", async () => {
    const risk = recordFixture(
      "risk-one",
      "risk",
      "Replay drift on older clients",
      "blocked",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
        attention: risk,
        recentRecords: [task, evidence],
      }))),
    );

    render(<ProjectHome projectId="example-game" />);

    const projectState = await screen.findByRole("region", {
      name: "Project state",
    });
    expect(within(projectState).queryByText("Evidence")).toBeNull();
    expect(within(projectState).queryByText("3")).toBeNull();
    expect(screen.getByRole("link", { name: "1 pending proposal" })
      .getAttribute("href")).toBe("/projects/example-game/proposals");
    expect(screen.getByRole("link", {
      name: "Open risk Replay drift on older clients",
    }).getAttribute("href")).toBe(
      "/projects/example-game/map?focusRecordId=risk-one",
    );
    expect(within(screen.getByRole("list", { name: "Recent changes" }))
      .getByRole("link", {
        name: "Open Work item Verify deterministic encounter seeds",
      }).getAttribute("href")).toBe(
      "/projects/example-game/tasks/task-one/handoff",
    );
    expect(screen.getByRole("link", {
      name: "Open evidence Cross-client replay log",
    }).getAttribute("href")).toBe(
      "/projects/example-game/map?focusRecordId=evidence-one",
    );
  });

  test("collapses optional attention and recent changes without dashboard data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
        currentTask: null,
        attention: null,
        pendingProposalCount: 0,
        recentRecords: [],
      }))),
    );

    render(<ProjectHome projectId="example-game" />);

    expect(await screen.findByRole("region", { name: "Current focus" })).toBeTruthy();
    expect(screen.getByText("No Work item in focus")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Attention" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Recent changes" })).toBeNull();
  });

  test("makes the missing active outcome explicit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(dashboardFixture({ currentOutcome: null })),
      ),
    );

    render(<ProjectHome projectId="example-game" />);

    expect(await screen.findByText("Outcome not established")).toBeTruthy();
  });

  test("does not render a dead Handoff Desk link without a current task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(dashboardFixture({ currentTask: null })),
      ),
    );

    render(<ProjectHome projectId="example-game" />);

    expect(await screen.findByText("No Work item in focus")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Current focus" }))
        .queryByRole("link", { name: /Open Work item:/i }),
    ).toBeNull();
  });

  test("names a blocked current task in words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(dashboardFixture({
          currentTask: { ...task, status: "blocked" },
        })),
      ),
    );

    render(<ProjectHome projectId="example-game" />);

    const currentTask = await screen.findByRole("region", {
      name: "Current focus",
    });
    expect(within(currentTask).getByText("Blocked")).toBeTruthy();
  });

  test("shows kind and status text for recent record changes", async () => {
    const risk = recordFixture(
      "risk-one",
      "risk",
      "Replay drift on older clients",
      "blocked",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(dashboardFixture({ recentRecords: [risk, evidence] })),
      ),
    );

    render(<ProjectHome projectId="example-game" />);

    const recentChanges = await screen.findByRole("list", {
      name: "Recent changes",
    });
    expect(within(recentChanges).getByText("Risk")).toBeTruthy();
    expect(within(recentChanges).getByText("Blocked")).toBeTruthy();
    expect(within(recentChanges).getByText("Evidence")).toBeTruthy();
    expect(within(recentChanges).getByText("Accepted")).toBeTruthy();
  });

  test("marks unbroken dashboard values with the overview wrapping contract", async () => {
    const titleToken = "unbroken-dashboard-title-".repeat(24);
    const outcomeBodyToken = "unbroken-outcome-body-".repeat(24);
    const taskBodyToken = "unbroken-task-body-".repeat(24);
    const attentionBodyToken = "unbroken-attention-body-".repeat(24);
    const attention = recordFixture(
      "attention-one",
      "risk",
      titleToken,
      "blocked",
      attentionBodyToken,
    );
    const recent = recordFixture("recent-one", "evidence", titleToken, "accepted");
    const wrappedOutcome = {
      ...outcome,
      title: titleToken,
      body: outcomeBodyToken,
    };
    const wrappedTask = { ...task, title: titleToken, body: taskBodyToken };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
        project: { ...dashboardFixture().project, name: titleToken },
        currentOutcome: wrappedOutcome,
        currentTask: wrappedTask,
        currentFocusPath: [wrappedOutcome, wrappedTask].map(pathSegment),
        attention,
        recentRecords: [recent],
      }))),
    );

    render(<ProjectHome projectId="example-game" />);

    await screen.findByRole("region", { name: "Current focus" });
    const projectState = screen.getByRole("region", { name: "Project state" });
    const currentFocus = screen.getByRole("region", { name: "Current focus" });
    const recentTitle = within(
      screen.getByRole("list", { name: "Recent changes" }),
    ).getByRole("link", { name: `Open evidence ${titleToken}` })
      .closest("strong")!;
    const values = [
      within(projectState).getByRole("heading", { name: titleToken }),
      within(currentFocus).getByRole("link", {
        name: `Project: ${titleToken} (example-game)`,
      }).querySelector("strong")!,
      within(currentFocus).getByRole("link", {
        name: `Outcome: ${titleToken} (outcome-one)`,
      }).querySelector("strong")!,
      within(currentFocus).getByRole("heading", { name: titleToken, level: 3 }),
      within(currentFocus).getByText((content) =>
        content.startsWith("unbroken-task-body-")
      ),
      within(screen.getByRole("region", { name: "Attention" })).getByRole(
        "link",
        { name: `Open risk ${titleToken}` },
      ).closest("h2")!,
      within(screen.getByRole("region", { name: "Attention" })).getByText(
        (content) => content.startsWith("unbroken-attention-body-"),
      ),
      recentTitle,
    ];

    for (const value of values) {
      expect(value.classList.contains("project-overview__wrap")).toBe(true);
    }
  });

  test("bounds current-task and attention bodies before rendering", async () => {
    const taskBody = `task-preview-start ${"x".repeat(700)} task-private-end`;
    const attentionBody = `attention-preview-start ${"y".repeat(700)} attention-private-end`;
    const attention = recordFixture(
      "attention-one",
      "risk",
      "Bound the attention preview",
      "blocked",
      attentionBody,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(dashboardFixture({
        currentTask: { ...task, body: taskBody },
        attention,
      }))),
    );

    render(<ProjectHome projectId="example-game" />);

    const currentFocus = await screen.findByRole("region", {
      name: "Current focus",
    });
    const renderedTaskBody = within(currentFocus).getByText(/task-preview-start/)
      .textContent!;
    const renderedAttentionBody = within(screen.getByRole("region", {
      name: "Attention",
    })).getByText(/attention-preview-start/).textContent!;
    expect(renderedTaskBody.length).toBeLessThanOrEqual(421);
    expect(renderedTaskBody.endsWith("…")).toBe(true);
    expect(renderedTaskBody).not.toContain("task-private-end");
    expect(renderedAttentionBody.length).toBeLessThanOrEqual(421);
    expect(renderedAttentionBody.endsWith("…")).toBe(true);
    expect(renderedAttentionBody).not.toContain("attention-private-end");
  });

  test("retries a recoverable dashboard error", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "DASHBOARD_UNAVAILABLE",
          message: "The project dashboard could not be read.",
          recoverable: true,
        },
      }, 503))
      .mockResolvedValueOnce(jsonResponse(dashboardFixture()));
    vi.stubGlobal("fetch", fetchStub);

    render(<ProjectHome projectId="example-game" />);

    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("The project dashboard could not be read.");
    expect(screen.getByRole("heading", {
      name: "Could not load the project dashboard",
    })).toBeTruthy();
    expect(screen.queryByText(/guided path/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry dashboard" }));

    expect(
      await screen.findByRole("link", {
        name: "Outcome: Reach a stable combat loop (outcome-one)",
      }),
    ).toBeTruthy();
  });
});
