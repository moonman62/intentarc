// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApplication } from "../../../app/create-application.js";
import type {
  OutboundInspection,
  OutboundRelease,
  OutboundRequestSummary,
  ProjectRecord,
  TaskContextPack,
} from "../../../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
} from "../../../test-support/database.js";
import type {
  ConnectedRecordDetailResponse,
  ContextRequestResponse,
  ProjectMapResponse,
  ReleasedContextResponse,
  TaskHandoffResponse,
} from "../../contracts.js";
import { RepositorySelectionProvider } from "../components/repository-selection.js";
import {
  HandoffDesk,
  selectHandoffProfile,
} from "./handoff-desk.js";
import { ProjectMap } from "./project-map.js";
import { downloadBrowserChatExport } from "../browser-download.js";

vi.mock("../browser-download.js", () => ({
  downloadBrowserChatExport: vi.fn(),
}));

const timestamp = "2026-07-29T12:00:00.000Z";
const sha = "a".repeat(64);

const record = (
  id: string,
  kind: ProjectRecord["kind"],
  title: string,
  body: string,
): ProjectRecord => ({
  id,
  projectId: "project-1",
  kind,
  status: kind === "decision" ? "accepted" : "active",
  title,
  body,
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const task = record(
  "task-1",
  "task",
  "Ship the review desk",
  "Review every outbound finding, then copy the released Markdown.",
);
const relatedTask = record(
  "task-2",
  "task",
  "Review the delivery",
  "Review the delivery before release.",
);
const outcome = record(
  "outcome-1",
  "outcome",
  "Safe cross-client continuity",
  "Move intent without moving secrets.",
);
const decision = record(
  "decision-1",
  "decision",
  "Keep authority separate",
  "Execution mode never changes knowledge authority.",
);
const evidence = record(
  "evidence-1",
  "evidence",
  "Outbound safety scenario",
  "The safety scenario remains green.",
);

const profile = ({
  profileId,
  name,
  executionMode,
  knowledgeAuthorityMode,
  lastUsedAt,
  destination = {
    clientLabel: "Codex desktop",
    providerLabel: "OpenAI",
    modelLabel: "GPT-5",
    dataBoundary: "remote" as const,
  },
}: {
  profileId: string;
  name: string;
  executionMode: "safe" | "trusted" | "custom";
  knowledgeAuthorityMode: "proposal" | "scoped_direct" | "full_direct";
  lastUsedAt: string | null;
  destination?: TaskHandoffResponse["profiles"][number]["destination"];
}): TaskHandoffResponse["profiles"][number] => ({
  profileId,
  name,
  executionMode,
  knowledgeAuthorityMode,
  lastUsedAt,
  destination,
});

const handoff = (
  profiles: TaskHandoffResponse["profiles"],
): TaskHandoffResponse => ({
  project: {
    id: "project-1",
    name: "IntentArc",
    revision: 4,
    primaryRepositoryPath: "C:\\projects\\intentarc",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  task,
  currentOutcome: outcome,
  relatedRecords: [decision, evidence],
  profiles,
});

const selectedProfile = profile({
  profileId: "profile-safe",
  name: "Safe Codex",
  executionMode: "safe",
  knowledgeAuthorityMode: "scoped_direct",
  lastUsedAt: timestamp,
});

const pack: TaskContextPack = {
  id: "context-1",
  projectId: "project-1",
  taskId: task.id,
  projectRevision: 4,
  generatedAt: timestamp,
  budgetTokens: 16_000,
  estimatedTokens: 1_100,
  stableFrame: [{
    record: outcome,
    mandatory: true,
    relevance: "stable_frame",
    relationshipKind: null,
  }],
  task: {
    record: {
      ...task,
      body:
        "Never expose [REDACTED:credential]. Contact " +
        "[REDACTED:sensitive].",
    },
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  },
  related: [{
    record: decision,
    mandatory: false,
    relevance: "linked",
    relationshipKind: "decided_by",
  }],
  omissions: [{
    recordId: evidence.id,
    kind: "evidence",
    reason: "budget",
    retrievalRef: "intentarc://records/evidence-1",
  }],
  sourceRevisions: [
    { recordId: outcome.id, revision: 1 },
    { recordId: task.id, revision: 1 },
    { recordId: decision.id, revision: 1 },
  ],
};

const request: OutboundRequestSummary = {
  requestId: "request-1",
  profileId: selectedProfile.profileId,
  projectId: "project-1",
  taskId: task.id,
  sourcePackId: pack.id,
  destination: {
    id: "destination-1",
    revision: 1,
    clientLabel: "Codex desktop",
    type: "ide_managed",
    providerLabel: "OpenAI",
    modelLabel: "GPT-5",
    accountBoundaryLabel: "work",
    dataBoundary: "remote",
  },
  status: "review_required",
  projectRevision: 4,
  budgetTokens: 16_000,
  originalEstimatedTokens: 1_240,
  findingCounts: {
    total: 2,
    credential: 1,
    sensitive: 1,
    forcedRedact: 1,
    redactByDefault: 1,
    redacted: 0,
    includedOnce: 0,
  },
  detectorVersion: "1",
  safetyPolicyVersion: "1",
  releaseId: null,
  createdAt: timestamp,
  decidedAt: null,
};

const inspection: OutboundInspection = {
  request,
  findings: [{
    id: "finding-forced",
    ordinal: 0,
    detectorId: "credential",
    detectorVersion: "1",
    category: "api_token",
    confidence: "high",
    severity: "credential",
    path: "/task/record/body",
    start: 13,
    end: 55,
    findingKey: "forced-key",
    requiredAction: "forced_redact",
    decision: null,
  }, {
    id: "finding-email",
    ordinal: 1,
    detectorId: "email",
    detectorVersion: "1",
    category: "email",
    confidence: "possible",
    severity: "sensitive",
    path: "/task/record/body",
    start: 65,
    end: 93,
    findingKey: "email-key",
    requiredAction: "redact_by_default",
    decision: null,
  }],
  redactedPreview: pack,
  prospectiveReleaseDigest: sha,
};

const preparedResponse: ContextRequestResponse = {
  request,
  inspection,
  release: null,
};

const release: OutboundRelease = {
  releaseId: "release-1",
  requestId: request.requestId,
  sourcePackId: pack.id,
  releasedAt: timestamp,
  sha256: sha,
  disclosure: {
    destination: request.destination,
    sourcePackId: pack.id,
    projectId: "project-1",
    taskId: task.id,
    projectRevision: 4,
    sourceRecords: [
      {
        recordId: outcome.id,
        kind: "outcome",
        revision: 1,
        sourceKind: "human",
        sourceRef: null,
      },
      {
        recordId: task.id,
        kind: "task",
        revision: 1,
        sourceKind: "human",
        sourceRef: null,
      },
    ],
    omissions: pack.omissions,
    requestedBudgetTokens: 16_000,
    originalEstimatedTokens: 1_240,
    releasedEstimatedTokens: 1_100,
    findingCounts: {
      ...request.findingCounts,
      redacted: 1,
      includedOnce: 1,
    },
    detectorVersion: "1",
    safetyPolicyVersion: "1",
    releaseDigest: sha,
    releasedAt: timestamp,
  },
  pack: {
    ...pack,
    task: {
      ...pack.task,
      record: {
        ...pack.task.record,
        body:
          "Never expose [REDACTED:credential]. Contact " +
          "review.owner@example.invalid.",
      },
    },
  },
};

const releasedResponse: ReleasedContextResponse = {
  release,
  export: {
    filename: "intentarc-browser-chat-release-1.md",
    mediaType: "text/markdown;charset=utf-8",
    text:
      "# IntentArc browser-chat export\n\n" +
      "Never expose [REDACTED:credential]. Contact " +
      "review.owner@example.invalid.",
  },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(downloadBrowserChatExport).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HandoffDesk", () => {
  test("uses the preferred project profile while displaying execution and authority separately", async () => {
    const newer = profile({
      profileId: "profile-newer",
      name: "Recent Trusted",
      executionMode: "trusted",
      knowledgeAuthorityMode: "proposal",
      lastUsedAt: "2026-07-29T13:00:00.000Z",
    });
    const preferred = profile({
      profileId: "profile-preferred",
      name: "Preferred Custom",
      executionMode: "custom",
      knowledgeAuthorityMode: "full_direct",
      lastUsedAt: "2026-07-28T12:00:00.000Z",
      destination: {
        clientLabel: "Local gateway",
        providerLabel: "Team gateway",
        modelLabel: null,
        dataBoundary: "mixed",
      },
    });
    localStorage.setItem(
      "intentarc.preferredProfile.project-1",
      preferred.profileId,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(handoff([newer, preferred]))),
    );

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);

    expect(await screen.findByRole("heading", {
      name: "Ship the review desk",
    })).toBeTruthy();
    expect(screen.getByRole("radio", {
      name: /Preferred Custom/,
    }).hasAttribute("checked")).toBe(true);
    expect(screen.getByText("Custom execution")).toBeTruthy();
    expect(screen.getByText("Full direct")).toBeTruthy();
    expect(screen.getByText("Team gateway")).toBeTruthy();
    expect(screen.getByText("Mixed boundary")).toBeTruthy();
    expect(screen.queryByText("Global unconfigured profile")).toBeNull();
  });

  test("falls back to the most recently used project profile", () => {
    const recent = profile({
      profileId: "recent",
      name: "Recent",
      executionMode: "safe",
      knowledgeAuthorityMode: "proposal",
      lastUsedAt: "2026-07-29T13:00:00.000Z",
    });
    const older = profile({
      profileId: "older",
      name: "Older",
      executionMode: "trusted",
      knowledgeAuthorityMode: "proposal",
      lastUsedAt: "2026-07-28T13:00:00.000Z",
    });

    expect(selectHandoffProfile([older, recent], "missing")?.profileId).toBe(
      "recent",
    );
  });

  test("explains copy is unavailable and can enable an existing global destination", async () => {
    const user = userEvent.setup();
    const enabled = profile({
      profileId: "profile-global",
      name: "Global destination",
      executionMode: "safe",
      knowledgeAuthorityMode: "proposal",
      lastUsedAt: null,
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([])))
      .mockResolvedValueOnce(jsonResponse({
        profiles: [{
          profileId: enabled.profileId,
          name: enabled.name,
          status: "enabled",
          executionMode: enabled.executionMode,
          projectIds: [],
          lastUsedAt: null,
          hasDestination: true,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        profileId: enabled.profileId,
        token: null,
        tokenShownOnce: false,
      }))
      .mockResolvedValueOnce(jsonResponse(handoff([enabled])));
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);

    expect(await screen.findByText(
      "Copy is unavailable until this project has a destination.",
    )).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Add another destination" }),
    );
    await user.click(await screen.findByRole("radio", {
      name: /Global destination/,
    }));
    await user.click(
      screen.getByRole("button", { name: "Enable selected profile" }),
    );

    expect(await screen.findByRole("radio", {
      name: /Global destination/,
    })).toBeTruthy();
    expect(fetchStub.mock.calls.some(([path, init]) =>
      path === "/api/projects/project-1/profiles" &&
      (init as RequestInit | undefined)?.method === "POST"
    )).toBe(true);
  });

  test("reviews findings, keeps forced findings redacted, and copies only the approved release", async () => {
    const user = userEvent.setup();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(releasedResponse));
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);

    expect(await screen.findByRole("heading", {
      name: "Ship the review desk",
    })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Objective" }))
      .toBeTruthy();
    expect(screen.getAllByText("Safe cross-client continuity")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Completion criteria" }))
      .toBeTruthy();
    expect(screen.getByText("Keep authority separate")).toBeTruthy();
    expect(screen.getByText("Outbound safety scenario")).toBeTruthy();
    expect(screen.getByText("Scoped direct")).toBeTruthy();
    expect(screen.getByText("Remote boundary")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Prepare for Codex desktop",
    })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: /open|launch/i,
    })).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Download Markdown",
    })).toBeNull();

    await user.click(screen.getByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    const forced = await screen.findByRole("listitem", {
      name: "Finding API token at /task/record/body",
    });
    const optional = screen.getByRole("listitem", {
      name: "Finding Email at /task/record/body",
    });
    expect(within(forced).getByText("Always redacted")).toBeTruthy();
    expect(within(forced).queryByRole("checkbox")).toBeNull();
    const includeOnce = within(optional).getByRole("checkbox", {
      name: "Include once",
    }) as HTMLInputElement;
    expect(includeOnce.checked).toBe(false);
    expect(screen.getByText("evidence-1")).toBeTruthy();

    await user.click(includeOnce);
    await user.click(screen.getByRole("button", {
      name: "Approve and release",
    }));
    const [, approveInit] = fetchStub.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(approveInit.body))).toEqual({
      rememberClean: false,
      includeFindingIds: ["finding-email"],
    });

    const copyButton = await screen.findByRole("button", {
      name: "Copy task context",
    });
    // This note is retained because it states the destination-control boundary,
    // not routine instructions for copying and pasting.
    expect(screen.getByRole("note", { name: "Destination control" }).textContent)
      .toBe("IntentArc does not open or control the destination.");
    await user.click(copyButton);
    expect(copy).toHaveBeenCalledWith(releasedResponse.export.text);
    expect((await screen.findByRole("status")).textContent).toContain(
      "Task context copied",
    );
    await user.click(screen.getByRole("button", {
      name: "Download Markdown",
    }));
    expect(downloadBrowserChatExport).toHaveBeenCalledWith(
      releasedResponse.export,
    );
  });

const handoffMap = (): ProjectMapResponse => ({
  projectId: "project-1",
  projectName: "IntentArc",
  projectRevision: 4,
  hierarchyVocabulary: {
    preset: "neutral",
    outcome: "Outcome",
    initiative: "Initiative",
    deliverable: "Deliverable",
    milestone: "Milestone",
    task: "Work item",
    nestedTask: "Subtask",
  },
  selectedRecordId: null,
  scopeRecordId: null,
  selectedPath: [],
  hierarchyNodes: [
    { id: outcome.id, kind: outcome.kind, status: outcome.status, title: outcome.title, revision: outcome.revision, parentId: null, childCount: 1 },
    { id: task.id, kind: task.kind, status: task.status, title: task.title, revision: task.revision, parentId: outcome.id, childCount: 0 },
  ],
  hierarchyEdges: [{
    id: "parent-outcome-task",
    kind: "parent_of",
    label: "parent of",
    fromRecordId: outcome.id,
    fromLabel: outcome.title,
    toRecordId: task.id,
    toLabel: task.title,
  }],
  unplacedRecordIds: [],
  progress: { childStatuses: {}, childrenWithEvidence: 0, childCount: 0 },
});

const handoffTaskDetail = (): ConnectedRecordDetailResponse => ({
  projectId: "project-1",
  projectRevision: 4,
  record: task,
  relations: [{
    depth: 1,
    edge: {
      id: "task-evidence",
      kind: "evidenced_by",
      label: "Evidenced by",
      fromRecordId: task.id,
      fromLabel: task.title,
      toRecordId: evidence.id,
      toLabel: evidence.title,
    },
    record: { id: evidence.id, kind: evidence.kind, status: evidence.status, title: evidence.title, revision: evidence.revision },
  }],
  attachmentsByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
});

function HandoffToMapJourney() {
  const [focusRecordId, setFocusRecordId] = useState<string | null>(null);
  if (focusRecordId !== null) {
    return (
      <RepositorySelectionProvider>
        <ProjectMap
          projectId="project-1"
          focusRecordId={focusRecordId}
          scopeRecordId={null}
          onSelectProject={() => setFocusRecordId(null)}
          onSelectRecord={(recordId) => setFocusRecordId(recordId)}
          onFocusBranch={setFocusRecordId}
          onNavigateAttachment={vi.fn()}
          onShowWholeProject={setFocusRecordId}
        />
      </RepositorySelectionProvider>
    );
  }
  return (
    <div onClick={(event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>("a");
      if (!link) return;
      const requested = new URL(link.href).searchParams.get("focusRecordId");
      if (requested === null) return;
      event.preventDefault();
      setFocusRecordId(requested);
    }}>
      <HandoffDesk projectId="project-1" taskId="task-1" />
    </div>
  );
}

  test("puts the enabled task-context action third in the handoff reading order", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse));
    vi.stubGlobal("fetch", fetchStub);

    const { container } = render(
      <HandoffDesk projectId="project-1" taskId="task-1" />,
    );

    await screen.findByRole("heading", { name: "Ship the review desk" });
    expect(screen.queryByText(
      "Prepare a portable task record, review every safety decision, then copy the released context to the client you control.",
    )).toBeNull();

    const ledgerRegions = Array.from(container.querySelector(".handoff-ledger")!.children);
    expect(ledgerRegions.map((region) =>
      region.querySelector("h2, summary")?.textContent
    )).toEqual([
      "Objective",
      "Completion criteria",
      "Prepare task context",
      "Blockers and exclusions",
      "Relevant records",
      "Technical details",
    ]);

    const primaryAction = within(ledgerRegions[2] as HTMLElement).getByRole(
      "button",
      { name: "Prepare for Codex desktop" },
    );
    expect((primaryAction as HTMLButtonElement).disabled).toBe(false);
    await user.click(primaryAction);
    expect(await screen.findByRole("heading", { name: "Outbound review" }))
      .toBeTruthy();
    expect(fetchStub).toHaveBeenLastCalledWith(
      "/api/projects/project-1/tasks/task-1/context-requests",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("puts a bounded record summary after the task-context action", async () => {
    const governedDetail = `PRIVATE-HANDOFF-BODY-SENTINEL ${"governed detail ".repeat(80)}`;
    const boundedDetail = `${governedDetail.slice(0, 420).trimEnd()}…`;
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({
      ...handoff([selectedProfile]),
      relatedRecords: [{ ...evidence, body: governedDetail }],
    }));
    vi.stubGlobal("fetch", fetchStub);

    const { container } = render(
      <HandoffDesk projectId="project-1" taskId="task-1" />,
    );

    await screen.findByRole("heading", { name: "Ship the review desk" });

    expect(screen.getByText("Technical details").closest("details")?.tagName)
      .toBe("DETAILS");
    expect(screen.getByRole("link", { name: "Open related task" }).getAttribute("href"))
      .toBe("/projects/project-1/map?focusRecordId=task-1");
    expect(document.body.textContent!.length).toBeLessThan(1_500);
    expect(container.innerHTML).toContain(boundedDetail);
    expect(container.innerHTML).not.toContain(governedDetail);
  });

  test("routes non-hierarchy previews through the Handoff task and hierarchy previews to themselves", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ...handoff([selectedProfile]),
      relatedRecords: [evidence, decision, relatedTask],
    })));

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await screen.findByRole("heading", { name: "Ship the review desk" });

    const relatedTaskLinks = screen.getAllByRole("link", { name: "Open related task" });
    expect(relatedTaskLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/project-1/map?focusRecordId=task-1",
      "/projects/project-1/map?focusRecordId=task-1",
    ]);
    const hierarchyLink = screen.getByRole("link", { name: "Open record" });
    expect(hierarchyLink.getAttribute("href"))
      .toBe("/projects/project-1/map?focusRecordId=task-2");
  });

  test("follows a non-hierarchy Handoff record into project-bound connected Map detail", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/api/projects/project-1/tasks/task-1/handoff")) {
        return Promise.resolve(jsonResponse(handoff([selectedProfile])));
      }
      if (path.endsWith("/api/projects/project-1/map")) {
        return Promise.resolve(jsonResponse(handoffMap()));
      }
      if (path.endsWith("/api/projects/project-1/records/task-1/connected-detail")) {
        return Promise.resolve(jsonResponse(handoffTaskDetail()));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(<HandoffToMapJourney />);
    await screen.findByRole("heading", { name: "Ship the review desk" });
    const evidenceLink = screen.getAllByRole("link", { name: "Open related task" })
      .find((link) => link.closest("article")?.textContent?.includes("Outbound safety scenario"));
    expect(evidenceLink).toBeTruthy();
    await user.click(evidenceLink!);

    expect(await screen.findByRole("treeitem", { name: "Work item: Ship the review desk" })).toBeTruthy();
    const detail = screen.getByRole("complementary", { name: "Selected item details" });
    expect(within(detail).getByRole("heading", { name: "Ship the review desk" })).toBeTruthy();
    expect(within(detail).getByRole("region", { name: "Direct cross-links" }).textContent)
      .toContain("Evidenced by · Outbound safety scenario · Active");
    expect(within(detail).queryByRole("heading", { name: "Outbound safety scenario" })).toBeNull();
    const selectedPath = within(screen.getByRole("navigation", { name: "Selected project path" }));
    expect(selectedPath.queryByText("Outbound safety scenario")).toBeNull();
    expect(selectedPath.getByRole("button", { name: "Safe cross-client continuity" })).toBeTruthy();
  });

  test("keeps a prepared context-pack identifier inside technical details", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse));
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);

    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await screen.findByRole("heading", { name: "Outbound review" });

    const technicalDetails = screen.getByText("Technical details").closest("details");
    expect(technicalDetails).toBeTruthy();
    expect(within(technicalDetails!).getByText("Context pack ID")).toBeTruthy();
    expect(within(technicalDetails!).getByText("context-1")).toBeTruthy();
  });

  test("keeps Markdown download available when copying the released context fails", async () => {
    const user = userEvent.setup();
    const copy = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(releasedResponse)));

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Approve and release",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Copy task context",
    }));

    expect(await screen.findByText(
      "Task context could not be copied. Select the released text manually.",
    )).toBeTruthy();
    expect(screen.queryByText("Task context could not be downloaded. Try again."))
      .toBeNull();
    await user.click(screen.getByRole("button", {
      name: "Download Markdown",
    }));
    expect(downloadBrowserChatExport).toHaveBeenCalledWith(
      releasedResponse.export,
    );
  });

  test("keeps copying available when downloading the released context fails", async () => {
    const user = userEvent.setup();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    vi.mocked(downloadBrowserChatExport).mockImplementation(() => {
      throw new Error("download blocked");
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(releasedResponse)));

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Approve and release",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Download Markdown",
    }));

    expect(await screen.findByText(
      "Task context could not be downloaded. Try again.",
    )).toBeTruthy();
    expect(screen.queryByText(
      "Task context could not be copied. Select the released text manually.",
    )).toBeNull();
    await user.click(screen.getByRole("button", {
      name: "Copy task context",
    }));
    expect(copy).toHaveBeenCalledWith(releasedResponse.export.text);
  });

  test("clears copy and download recovery messages when returning to the task brief", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) },
    });
    vi.mocked(downloadBrowserChatExport).mockImplementation(() => {
      throw new Error("download blocked");
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(releasedResponse)));

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Approve and release",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Copy task context",
    }));
    await user.click(screen.getByRole("button", {
      name: "Download Markdown",
    }));
    expect(await screen.findByText(
      "Task context could not be copied. Select the released text manually.",
    )).toBeTruthy();
    expect(screen.getByText("Task context could not be downloaded. Try again."))
      .toBeTruthy();

    await user.click(screen.getByRole("button", {
      name: "Return to task brief",
    }));

    expect(screen.queryByText(
      "Task context could not be copied. Select the released text manually.",
    )).toBeNull();
    expect(screen.queryByText("Task context could not be downloaded. Try again."))
      .toBeNull();
  });

  test("freezes include-once decisions for the entire approval request", async () => {
    const user = userEvent.setup();
    let resolveApproval: ((response: Response) => void) | undefined;
    const pendingApproval = new Promise<Response>((resolve) => {
      resolveApproval = resolve;
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockReturnValueOnce(pendingApproval);
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    const includeOnce = await screen.findByRole("checkbox", {
      name: "Include once",
    }) as HTMLInputElement;
    await user.click(includeOnce);
    await user.click(screen.getByRole("button", {
      name: "Approve and release",
    }));

    expect(includeOnce.disabled).toBe(true);
    await user.click(includeOnce);
    expect(includeOnce.checked).toBe(true);

    await act(async () => {
      resolveApproval?.(jsonResponse(releasedResponse));
      await pendingApproval;
    });
    expect(await screen.findByRole("button", {
      name: "Copy task context",
    })).toBeTruthy();
  });

  test("freezes the clean-release decision for the entire approval request", async () => {
    const user = userEvent.setup();
    let resolveApproval: ((response: Response) => void) | undefined;
    const pendingApproval = new Promise<Response>((resolve) => {
      resolveApproval = resolve;
    });
    const cleanInspection: OutboundInspection = {
      ...inspection,
      request: {
        ...request,
        findingCounts: {
          total: 0,
          credential: 0,
          sensitive: 0,
          forcedRedact: 0,
          redactByDefault: 0,
          redacted: 0,
          includedOnce: 0,
        },
      },
      findings: [],
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse({
        request: cleanInspection.request,
        inspection: cleanInspection,
        release: null,
      }))
      .mockReturnValueOnce(pendingApproval);
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    const rememberClean = await screen.findByRole("checkbox", {
      name: /Remember clean releases/,
    }) as HTMLInputElement;
    await user.click(rememberClean);
    await user.click(screen.getByRole("button", {
      name: "Approve and release",
    }));

    expect(rememberClean.disabled).toBe(true);
    await user.click(rememberClean);
    expect(rememberClean.checked).toBe(true);

    await act(async () => {
      resolveApproval?.(jsonResponse(releasedResponse));
      await pendingApproval;
    });
  });

  test("recovers a released context after the approval response is lost", async () => {
    const user = userEvent.setup();
    let rejectApproval: ((reason: Error) => void) | undefined;
    let resolveReleased: ((response: Response) => void) | undefined;
    const lostApproval = new Promise<Response>((_resolve, reject) => {
      rejectApproval = reject;
    });
    const pendingReleased = new Promise<Response>((resolve) => {
      resolveReleased = resolve;
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockReturnValueOnce(lostApproval)
      .mockReturnValueOnce(pendingReleased);
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    const includeOnce = await screen.findByRole("checkbox", {
      name: "Include once",
    }) as HTMLInputElement;
    await user.click(includeOnce);
    await user.click(screen.getByRole("button", {
      name: "Approve and release",
    }));
    expect(includeOnce.disabled).toBe(true);

    await act(async () => {
      rejectApproval?.(new TypeError("approval response lost"));
      await expect(lostApproval).rejects.toThrow("approval response lost");
    });
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(4));
    expect(fetchStub.mock.calls[3]?.[0]).toBe(
      "/api/context-requests/request-1/released",
    );
    expect(includeOnce.disabled).toBe(true);

    await act(async () => {
      resolveReleased?.(jsonResponse(releasedResponse));
      await pendingReleased;
    });

    expect(await screen.findByRole("button", {
      name: "Copy task context",
    })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("denial returns to the task brief and never requests deletion", async () => {
    const user = userEvent.setup();
    const denied = {
      ...request,
      status: "denied" as const,
      decidedAt: timestamp,
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(denied));
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Deny release",
    }));

    expect(await screen.findByRole("heading", { name: "Completion criteria" }))
      .toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Outbound review" })).toBeNull();
    expect(fetchStub.mock.calls.some(([, init]) =>
      (init as RequestInit | undefined)?.method === "DELETE"
    )).toBe(false);
  });

  test("blocks preparation and opens destination repair when an authorized profile has no destination", async () => {
    const withoutDestination = profile({
      profileId: "profile-no-destination",
      name: "Migrated authorized profile",
      executionMode: "custom",
      knowledgeAuthorityMode: "proposal",
      lastUsedAt: null,
      destination: null,
    });
    const repairedProfile = {
      ...withoutDestination,
      destination: {
        clientLabel: "Codex repaired",
        providerLabel: "OpenAI",
        modelLabel: null,
        dataBoundary: "local" as const,
      },
    };
    let repaired = false;
    const fetchStub = vi.fn((path: string, init?: RequestInit) => {
      if (path.includes("/handoff")) {
        return Promise.resolve(jsonResponse(handoff([
          repaired ? repairedProfile : withoutDestination,
        ])));
      }
      if (path === "/api/profiles") {
        return Promise.resolve(jsonResponse({
          profiles: [{
            profileId: withoutDestination.profileId,
            name: withoutDestination.name,
            status: "enabled",
            executionMode: withoutDestination.executionMode,
            projectIds: ["project-1"],
            lastUsedAt: null,
            hasDestination: false,
          }],
        }));
      }
      if (path === "/api/projects/project-1/profiles") {
        expect(init?.method).toBe("POST");
        repaired = true;
        return Promise.resolve(jsonResponse({
          profileId: withoutDestination.profileId,
          token: null,
          tokenShownOnce: false,
        }));
      }
      if (path.includes("/context-requests")) {
        return Promise.resolve(jsonResponse({
          ...preparedResponse,
          request: {
            ...preparedResponse.request,
            profileId: withoutDestination.profileId,
            destination: {
              ...preparedResponse.request.destination,
              clientLabel: "Codex repaired",
            },
          },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);

    const unavailable = await screen.findByRole("button", {
      name: "Destination required before preparation",
    });
    expect(unavailable.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(
      /Preparation is unavailable until this authorized profile has an enabled destination/,
    )).toBeTruthy();
    await user.click(screen.getByRole("button", {
      name: "Repair destination",
    }));

    const setup = await screen.findByRole("dialog");
    expect(within(setup).getByRole("radio", {
      name: /Migrated authorized profile/,
    })).toBeTruthy();
    await user.type(
      within(setup).getByRole("textbox", { name: "Client label" }),
      "Codex repaired",
    );
    await user.type(
      within(setup).getByRole("textbox", { name: "Provider label" }),
      "OpenAI",
    );
    await user.click(within(setup).getByRole("button", {
      name: "Repair selected profile",
    }));

    const prepare = await screen.findByRole("button", {
      name: "Prepare for Codex repaired",
    });
    await user.click(prepare);

    expect(await screen.findByRole("heading", {
      name: "Outbound review",
    })).toBeTruthy();
    expect(fetchStub.mock.calls.filter(([path, init]) =>
      String(path).includes("/context-requests") &&
      (init as RequestInit | undefined)?.method === "POST"
    )).toHaveLength(1);
  });

  test("does not present a disabled destination as available to the reviewer", async () => {
    const temporaryDatabase = createTemporaryDatabase();
    const application = createApplication({
      databasePath: temporaryDatabase.path,
    });
    try {
      const project = application.service.createProject({
        name: "Retired destination project",
      });
      const currentTask = application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title: "Review retired destination",
        body: "Do not send context to a retired client.",
        sourceKind: "human",
        sourceRef: null,
      });
      const created = application.service.profiles.createProfile({
        name: "Configured profile",
        projectId: project.id,
      });
      application.service.destinations.set({
        profileId: created.profile.id,
        clientLabel: "Retired client",
        type: "ide_managed",
        providerLabel: "Retired provider",
        modelLabel: null,
        accountBoundaryLabel: null,
        dataBoundary: "remote",
      });
      application.service.destinations.disable(created.profile.id);
      const realHandoff = application.service.views.getTaskHandoff(
        project.id,
        currentTask.id,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(realHandoff)),
      );

      render(
        <HandoffDesk projectId={project.id} taskId={currentTask.id} />,
      );

      const unavailable = await screen.findByRole("button", {
        name: "Destination required before preparation",
      });
      expect(unavailable.hasAttribute("disabled")).toBe(true);
      expect(screen.getAllByText("Not declared").length).toBeGreaterThan(0);
      expect(screen.queryByText("Retired provider")).toBeNull();
      expect(screen.queryByRole("button", {
        name: "Prepare for Retired client",
      })).toBeNull();
    } finally {
      cleanup();
      application.close();
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  test("closes destination setup immediately when the task route changes", async () => {
    const user = userEvent.setup();
    const nextTask = {
      ...task,
      id: "task-2",
      title: "Second task",
    };
    const fetchStub = vi.fn((path: string) => {
      if (path.endsWith("/tasks/task-1/handoff")) {
        return Promise.resolve(jsonResponse(handoff([selectedProfile])));
      }
      if (path.endsWith("/tasks/task-2/handoff")) {
        return Promise.resolve(jsonResponse({
          ...handoff([selectedProfile]),
          task: nextTask,
        }));
      }
      if (path === "/api/profiles") {
        return Promise.resolve(jsonResponse({ profiles: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const { rerender } = render(
      <HandoffDesk projectId="project-1" taskId="task-1" />,
    );
    await user.click(await screen.findByRole("button", {
      name: "Add another destination",
    }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    rerender(<HandoffDesk projectId="project-1" taskId="task-2" />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("heading", {
      name: "Second task",
    })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("reuses a prepare idempotency key after response loss and rotates it after denial", async () => {
    const user = userEvent.setup();
    let rejectFirstPreparation: ((reason: Error) => void) | undefined;
    const lostFirstPreparation = new Promise<Response>((_resolve, reject) => {
      rejectFirstPreparation = reject;
    });
    const denied = {
      ...request,
      status: "denied" as const,
      decidedAt: timestamp,
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(handoff([selectedProfile])))
      .mockReturnValueOnce(lostFirstPreparation)
      .mockResolvedValueOnce(jsonResponse(preparedResponse))
      .mockResolvedValueOnce(jsonResponse(denied))
      .mockResolvedValueOnce(jsonResponse(preparedResponse));
    vi.stubGlobal("fetch", fetchStub);

    render(<HandoffDesk projectId="project-1" taskId="task-1" />);
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    await act(async () => {
      rejectFirstPreparation?.(new TypeError("response lost"));
      await expect(lostFirstPreparation).rejects.toThrow("response lost");
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "response lost",
    );
    const firstBody = JSON.parse(String(
      (fetchStub.mock.calls[1]?.[1] as RequestInit).body,
    )) as { idempotencyKey: string };

    await user.click(screen.getByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    expect(await screen.findByRole("heading", {
      name: "Outbound review",
    })).toBeTruthy();
    const retryBody = JSON.parse(String(
      (fetchStub.mock.calls[2]?.[1] as RequestInit).body,
    )) as { idempotencyKey: string };
    expect(retryBody.idempotencyKey).toBe(firstBody.idempotencyKey);

    await user.click(screen.getByRole("button", { name: "Deny release" }));
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));
    const nextAttemptBody = JSON.parse(String(
      (fetchStub.mock.calls[4]?.[1] as RequestInit).body,
    )) as { idempotencyKey: string };
    expect(nextAttemptBody.idempotencyKey).not.toBe(firstBody.idempotencyKey);
  });

  test("ignores a preparation response from a task that is no longer current", async () => {
    const user = userEvent.setup();
    let resolvePreparation:
      | ((response: Response) => void)
      | undefined;
    const pendingPreparation = new Promise<Response>((resolve) => {
      resolvePreparation = resolve;
    });
    const nextTask = {
      ...task,
      id: "task-2",
      title: "Review the next task",
    };
    const fetchStub = vi.fn((path: string) => {
      if (path.endsWith("/tasks/task-1/handoff")) {
        return Promise.resolve(jsonResponse(handoff([selectedProfile])));
      }
      if (path.endsWith("/tasks/task-2/handoff")) {
        return Promise.resolve(jsonResponse({
          ...handoff([selectedProfile]),
          task: nextTask,
        }));
      }
      if (path.endsWith("/tasks/task-1/context-requests")) {
        return pendingPreparation;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const { rerender } = render(
      <HandoffDesk projectId="project-1" taskId="task-1" />,
    );
    await user.click(await screen.findByRole("button", {
      name: "Prepare for Codex desktop",
    }));

    rerender(<HandoffDesk projectId="project-1" taskId="task-2" />);
    expect(await screen.findByRole("heading", {
      name: "Review the next task",
    })).toBeTruthy();

    await act(async () => {
      resolvePreparation?.(jsonResponse(preparedResponse));
      await pendingPreparation;
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { name: "Outbound review" }))
      .toBeNull();
    expect(screen.getByRole("button", {
      name: "Prepare for Codex desktop",
    })).toBeTruthy();
  });
});
