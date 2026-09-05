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
import type {
  ProposalAcceptResponse,
  ProposalDetailDto,
  ProposalDetailResponse,
  ProposalListResponse,
  ProposalSummaryDto,
} from "../../contracts.js";
import { ProposalsScreen } from "./proposals.js";

const timestamp = "2026-07-29T12:00:00.000Z";

const summary = (
  id: string,
  overrides: Partial<ProposalSummaryDto> = {},
): ProposalSummaryDto => ({
  id,
  projectId: "project-one",
  origin: { type: "profile", profileId: "profile-safe" },
  sourceTaskId: "task-source",
  predecessorProposalId: null,
  baseProjectRevision: 7,
  state: "pending",
  rationale: `Rationale for ${id}`,
  idempotencyKey: `key-${id}`,
  reviewReason: null,
  reviewerActor: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  reviewedAt: null,
  ...overrides,
});

const detail = (
  proposal: ProposalSummaryDto,
  overrides: Partial<ProposalDetailDto> = {},
): ProposalDetailDto => ({
  ...proposal,
  operations: [{
    operationId: "create-task",
    type: "create_record",
    localRef: "review-task",
    kind: "task",
    status: "provisional",
    title: "Review the governed change",
    body: "Keep the rationale and operation visible.",
  }, {
    operationId: "update-outcome",
    type: "update_record",
    recordId: "outcome-one",
    expectedRecordRevision: 3,
    patch: {
      title: "Updated outcome",
      status: "active",
    },
  }, {
    operationId: "link-task",
    type: "create_relationship",
    from: { localRef: "review-task" },
    to: { recordId: "outcome-one" },
    kind: "supports",
  }, {
    operationId: "remove-old-link",
    type: "remove_relationship",
    relationshipId: "relationship-old",
  }],
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  history.replaceState(null, "", "/projects/project-one/proposals");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProposalsScreen", () => {
  test("labels repository refresh origins without an empty profile identity", async () => {
    const refresh = summary("proposal-refresh", {
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "snapshot-candidate",
      },
      sourceTaskId: null,
      idempotencyKey: null,
      rationale: "Align intent with the reviewed repository.",
    });
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({ proposals: [refresh] }));
      }
      if (path === "/api/proposals/proposal-refresh") {
        return Promise.resolve(jsonResponse({ proposal: detail(refresh) }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(<ProposalsScreen projectId="project-one" />);

    expect(await screen.findByText("Repository refresh")).toBeTruthy();
    expect(screen.queryByText("snapshot-candidate")).toBeNull();
    expect(screen.queryByText("undefined")).toBeNull();
  });

  test("orders pending proposals newest-first by creation time then ID and renders semantic detail", async () => {
    const older = summary("proposal-old", {
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    const tiedA = summary("proposal-a", {
      rationale: "Clarify the evidence threshold.",
    });
    const tiedZ = summary("proposal-z", {
      rationale: "Create a reviewable task.",
    });
    const selectedDetail = detail(tiedZ);
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({
          proposals: [older, tiedA, tiedZ],
        } satisfies ProposalListResponse));
      }
      if (path === "/api/proposals/proposal-z") {
        return Promise.resolve(jsonResponse({
          proposal: selectedDetail,
        } satisfies ProposalDetailResponse));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(<ProposalsScreen projectId="project-one" />);

    const ledger = await screen.findByRole("list", {
      name: "Pending proposals",
    }, { timeout: 5_000 });
    expect(within(ledger).getAllByRole("button").map(
      (button) => button.textContent,
    )).toEqual([
      expect.stringContaining("Create a reviewable task."),
      expect.stringContaining("Clarify the evidence threshold."),
      expect.stringContaining("Rationale for proposal-old"),
    ]);
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Create a reviewable task.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("profile-safe")).toBeTruthy();
    expect(screen.getByText("Revision 7")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create record" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Update record" })).toBeTruthy();
    expect(screen.getByRole("heading", {
      name: "Create relationship",
    })).toBeTruthy();
    expect(screen.getByRole("heading", {
      name: "Remove relationship",
    })).toBeTruthy();
    expect(screen.getByText("Review the governed change")).toBeTruthy();
    expect(screen.getByText("Expected revision")).toBeTruthy();
    expect(screen.getAllByText("Local reference review-task")).toHaveLength(2);
    expect(screen.queryByText(/"operationId"/)).toBeNull();
  });

  test("requires explicit confirmation before accepting a proposal", async () => {
    const proposal = summary("proposal-accept");
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) }))
      .mockResolvedValueOnce(jsonResponse({
        outcome: "applied",
        projectRevision: 8,
        proposal: { ...proposal, state: "accepted" },
      } satisfies ProposalAcceptResponse));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);

    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    expect(screen.getByRole("heading", { name: "Confirm acceptance" }))
      .toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Accepted at project revision 8",
    );
    expect(fetchStub.mock.calls[2]?.[0]).toBe(
      "/api/proposals/proposal-accept/accept",
    );
  });

  test("requires a non-empty reason before rejecting a proposal", async () => {
    const proposal = summary("proposal-reject");
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) }))
      .mockResolvedValueOnce(jsonResponse({
        proposal: {
          ...proposal,
          state: "rejected",
          reviewReason: "The evidence is not current.",
        },
      }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);

    await user.click(await screen.findByRole("button", {
      name: "Reject proposal",
    }));
    const reject = screen.getByRole("button", { name: "Confirm rejection" });
    await user.click(reject);

    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a reason for rejecting this proposal.",
    );
    expect(fetchStub).toHaveBeenCalledTimes(2);

    await user.type(
      screen.getByRole("textbox", { name: "Reason for rejection" }),
      "The evidence is not current.",
    );
    await user.click(reject);

    expect((await screen.findByRole("status")).textContent).toContain(
      "Proposal rejected",
    );
    expect(JSON.parse(String(
      (fetchStub.mock.calls[2]?.[1] as RequestInit).body,
    ))).toEqual({ reason: "The evidence is not current." });
  });

  test("explains that conflicted acceptance left project knowledge unchanged", async () => {
    const proposal = summary("proposal-stale");
    const conflicted: ProposalAcceptResponse = {
      outcome: "conflicted",
      currentProjectRevision: 9,
      explanation:
        "Project knowledge was unchanged because this proposal was based on an older revision.",
      proposal: { ...proposal, state: "conflicted" },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) }))
      .mockResolvedValueOnce(jsonResponse(conflicted)));
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);

    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Project knowledge was unchanged because this proposal was based on an older revision.",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Current project revision: 9",
    );
  });

  test("links an empty review ledger back to project Home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ proposals: [] })),
    );

    render(<ProposalsScreen projectId="project one" />);

    const home = await screen.findByRole("link", { name: "Return to Home" });
    expect(home.getAttribute("href")).toBe("/projects/project%20one");
  });

  test("aborts old loads and ignores an action response after the selected detail changes", async () => {
    const first = summary("proposal-first", {
      rationale: "First proposal.",
    });
    const second = summary("proposal-second", {
      rationale: "Second proposal.",
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    let resolveAcceptance:
      | ((response: Response) => void)
      | undefined;
    const pendingAcceptance = new Promise<Response>((resolve) => {
      resolveAcceptance = resolve;
    });
    const signals: AbortSignal[] = [];
    const fetchStub = vi.fn((path: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({ proposals: [first, second] }));
      }
      if (path === "/api/proposals/proposal-first") {
        return Promise.resolve(jsonResponse({ proposal: detail(first) }));
      }
      if (path === "/api/proposals/proposal-second") {
        return Promise.resolve(jsonResponse({ proposal: detail(second) }));
      }
      if (path === "/api/proposals/proposal-first/accept") {
        return pendingAcceptance;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));
    await user.click(screen.getByRole("button", {
      name: /Review proposal Second proposal/,
    }));

    expect(await screen.findByRole("heading", { name: "Second proposal." }))
      .toBeTruthy();
    expect(signals.some((signal) => signal.aborted)).toBe(true);

    await act(async () => {
      resolveAcceptance?.(jsonResponse({
        outcome: "applied",
        projectRevision: 8,
        proposal: { ...first, state: "accepted" },
      } satisfies ProposalAcceptResponse));
      await pendingAcceptance;
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Second proposal." }))
      .toBeTruthy();
    expect(screen.queryByText("Accepted at project revision 8")).toBeNull();
  });

  test("rejects list and detail responses outside the current project and selection", async () => {
    const wrongProject = summary("proposal-wrong-project");
    const current = summary("proposal-current", {
      projectId: "project-two",
      rationale: "Current project proposal.",
    });
    const fetchStub = vi.fn((path: string) => {
      if (path.includes("/projects/project-two/proposals")) {
        return Promise.resolve(jsonResponse({
          proposals: [wrongProject],
        } satisfies ProposalListResponse));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const view = render(<ProposalsScreen projectId="project-two" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "did not match the current project",
    );
    expect(screen.queryByText(wrongProject.rationale)).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept proposal" })).toBeNull();

    fetchStub.mockImplementation((path: string) => {
      if (path.includes("/projects/project-two/proposals")) {
        return Promise.resolve(jsonResponse({
          proposals: [current],
        } satisfies ProposalListResponse));
      }
      if (path === "/api/proposals/proposal-current") {
        return Promise.resolve(jsonResponse({
          proposal: detail(summary("proposal-other", {
            projectId: "project-two",
            rationale: "Wrong proposal detail.",
          })),
        } satisfies ProposalDetailResponse));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    view.unmount();
    render(<ProposalsScreen projectId="project-two" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "did not match the selected proposal",
    );
    expect(screen.queryByText("Wrong proposal detail.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept proposal" })).toBeNull();
  });

  test("ignores deferred list and detail responses across project rerenders even when abort is ignored", async () => {
    const firstProject = summary("proposal-first-project");
    const secondProject = summary("proposal-second-project", {
      projectId: "project-two",
      rationale: "Second project proposal.",
    });
    let resolveFirstList!: (response: Response) => void;
    let resolveSecondDetail!: (response: Response) => void;
    const firstList = new Promise<Response>((resolve) => {
      resolveFirstList = resolve;
    });
    const secondDetail = new Promise<Response>((resolve) => {
      resolveSecondDetail = resolve;
    });
    const fetchStub = vi.fn((path: string) => {
      if (path.includes("/projects/project-one/proposals")) {
        return firstList;
      }
      if (path.includes("/projects/project-two/proposals")) {
        return Promise.resolve(jsonResponse({ proposals: [secondProject] }));
      }
      if (path === "/api/proposals/proposal-second-project") {
        return secondDetail;
      }
      if (path.includes("/projects/project-three/proposals")) {
        return Promise.resolve(jsonResponse({ proposals: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const view = render(<ProposalsScreen projectId="project-one" />);
    view.rerender(<ProposalsScreen projectId="project-two" />);

    await act(async () => {
      resolveFirstList(jsonResponse({ proposals: [firstProject] }));
      await firstList;
      await Promise.resolve();
    });
    expect(screen.queryByText(firstProject.rationale)).toBeNull();

    expect(await screen.findByText("Second project proposal.")).toBeTruthy();
    view.rerender(<ProposalsScreen projectId="project-three" />);

    await act(async () => {
      resolveSecondDetail(jsonResponse({
        proposal: detail(secondProject),
      }));
      await secondDetail;
      await Promise.resolve();
    });

    expect(screen.queryByText("Second project proposal.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept proposal" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Return to Home" }))
      .toBeTruthy();
  });

  test("keeps recoverable action failures retryable without reselecting", async () => {
    const proposal = summary("proposal-retry");
    let acceptAttempts = 0;
    const fetchStub = vi.fn((path: string) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({ proposals: [proposal] }));
      }
      if (path === "/api/proposals/proposal-retry") {
        return Promise.resolve(jsonResponse({ proposal: detail(proposal) }));
      }
      if (path === "/api/proposals/proposal-retry/accept") {
        acceptAttempts += 1;
        return Promise.resolve(acceptAttempts === 1
          ? jsonResponse({
              error: {
                code: "review_conflict_gateway_unavailable",
                message: "Review service unavailable.",
                recoverable: true,
              },
            }, 503)
          : jsonResponse({
              outcome: "applied",
              projectRevision: 8,
              proposal: { ...proposal, state: "accepted" },
            } satisfies ProposalAcceptResponse));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("Review service unavailable.");
    expect(error.textContent).not.toContain("Proposal conflicted");
    const retry = screen.getByRole("button", { name: "Confirm accept" });
    expect(document.activeElement).toBe(retry);

    await user.click(retry);

    const decision = await screen.findByRole("status");
    expect(decision.textContent).toContain(
      "Accepted at project revision 8",
    );
    await waitFor(() => expect(document.activeElement).toBe(decision));
    expect(acceptAttempts).toBe(2);
  });

  test("reconciles an accepted proposal after the commit response is lost without repeating the mutation", async () => {
    const proposal = summary("proposal-accepted-after-loss");
    let mutationCalls = 0;
    const fetchStub = vi.fn((path: string, init?: RequestInit) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({
          proposals: mutationCalls === 0 ? [proposal] : [],
        }));
      }
      if (path === `/api/proposals/${proposal.id}`) {
        const authoritative = mutationCalls === 0
          ? detail(proposal)
          : detail(proposal, {
              state: "accepted",
              reviewedAt: "2026-07-29T12:01:00.000Z",
              reviewerActor: "local_human",
            });
        return Promise.resolve(jsonResponse({ proposal: authoritative }));
      }
      if (path === `/api/proposals/${proposal.id}/accept`) {
        expect(init?.method).toBe("POST");
        mutationCalls += 1;
        return Promise.reject(new TypeError("Response stream lost"));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    const decision = await screen.findByRole("status");
    expect(decision.textContent).toContain("Proposal accepted");
    expect(screen.getByText("Accepted")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(decision));
    expect(mutationCalls).toBe(1);
    expect(screen.queryByRole("button", {
      name: new RegExp(proposal.rationale),
    })).toBeNull();
  });

  test("reconciles a rejected proposal after the commit response is lost without repeating the mutation", async () => {
    const proposal = summary("proposal-rejected-after-loss");
    let mutationCalls = 0;
    const fetchStub = vi.fn((path: string, init?: RequestInit) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({
          proposals: mutationCalls === 0 ? [proposal] : [],
        }));
      }
      if (path === `/api/proposals/${proposal.id}`) {
        const authoritative = mutationCalls === 0
          ? detail(proposal)
          : detail(proposal, {
              state: "rejected",
              reviewReason: "Evidence was incomplete.",
              reviewedAt: "2026-07-29T12:01:00.000Z",
              reviewerActor: "local_human",
            });
        return Promise.resolve(jsonResponse({ proposal: authoritative }));
      }
      if (path === `/api/proposals/${proposal.id}/reject`) {
        expect(init?.method).toBe("POST");
        mutationCalls += 1;
        return Promise.reject(new TypeError("Response stream lost"));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Reject proposal",
    }));
    await user.type(
      screen.getByRole("textbox", { name: "Reason for rejection" }),
      "Evidence was incomplete.",
    );
    await user.click(screen.getByRole("button", {
      name: "Confirm rejection",
    }));

    const decision = await screen.findByRole("status");
    expect(decision.textContent).toContain("Proposal rejected");
    expect(decision.textContent).not.toContain("knowledge was unchanged");
    expect(screen.getByText("Rejected")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(decision));
    expect(mutationCalls).toBe(1);
  });

  test("uses knowledge-unchanged conflict language only after authoritative reconciliation", async () => {
    const proposal = summary("proposal-api-conflict");
    let mutationCalls = 0;
    const fetchStub = vi.fn((path: string) => {
      if (path.includes("/proposals?state=pending")) {
        return Promise.resolve(jsonResponse({
          proposals: mutationCalls === 0 ? [proposal] : [],
        }));
      }
      if (path === `/api/proposals/${proposal.id}`) {
        return Promise.resolve(jsonResponse({
          proposal: detail(proposal, mutationCalls === 0
            ? {}
            : {
                state: "conflicted",
                reviewedAt: "2026-07-29T12:01:00.000Z",
                reviewerActor: "local_human",
              }),
        }));
      }
      if (path === `/api/proposals/${proposal.id}/accept`) {
        mutationCalls += 1;
        return Promise.resolve(jsonResponse({
          error: {
            code: "proposal_not_pending",
            message: "The request conflicts with the current state.",
            recoverable: true,
          },
        }, 409));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    const conflict = await screen.findByRole("alert");
    expect(conflict.textContent).toContain("Proposal conflicted");
    expect(conflict.textContent).toContain("Project knowledge was unchanged");
    expect(screen.getByText("Conflicted")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(conflict));
    expect(mutationCalls).toBe(1);
    expect(screen.queryByText("Review not recorded")).toBeNull();
  });

  test("ignores abort-insensitive reconciliation after a project rerender", async () => {
    const proposal = summary("proposal-stale-reconciliation");
    let mutationCalls = 0;
    let detailReads = 0;
    let resolveReconciledDetail!: (response: Response) => void;
    let resolveReconciledList!: (response: Response) => void;
    const reconciledDetail = new Promise<Response>((resolve) => {
      resolveReconciledDetail = resolve;
    });
    const reconciledList = new Promise<Response>((resolve) => {
      resolveReconciledList = resolve;
    });
    const fetchStub = vi.fn((path: string) => {
      if (path.includes("/projects/project-one/proposals")) {
        return mutationCalls === 0
          ? Promise.resolve(jsonResponse({ proposals: [proposal] }))
          : reconciledList;
      }
      if (path.includes("/projects/project-two/proposals")) {
        return Promise.resolve(jsonResponse({ proposals: [] }));
      }
      if (path === `/api/proposals/${proposal.id}`) {
        detailReads += 1;
        return detailReads === 1
          ? Promise.resolve(jsonResponse({ proposal: detail(proposal) }))
          : reconciledDetail;
      }
      if (path === `/api/proposals/${proposal.id}/accept`) {
        mutationCalls += 1;
        return Promise.reject(new TypeError("Response stream lost"));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    const view = render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(detailReads).toBe(2));

    view.rerender(<ProposalsScreen projectId="project-two" />);
    expect(await screen.findByRole("link", { name: "Return to Home" }))
      .toBeTruthy();

    await act(async () => {
      resolveReconciledDetail(jsonResponse({
        proposal: detail(proposal, { state: "accepted" }),
      }));
      resolveReconciledList(jsonResponse({ proposals: [] }));
      await Promise.all([reconciledDetail, reconciledList]);
      await Promise.resolve();
    });

    expect(screen.queryByText("Proposal accepted")).toBeNull();
    expect(screen.queryByText(proposal.rationale)).toBeNull();
    expect(mutationCalls).toBe(1);
  });

  test("aborts reconciliation and invalidates its generation when unmounted", async () => {
    const proposal = summary("proposal-unmounted-reconciliation");
    let mutationStarted = false;
    let detailReads = 0;
    let reconciliationSignal: AbortSignal | undefined;
    let resolveReconciledDetail!: (response: Response) => void;
    let resolveReconciledList!: (response: Response) => void;
    const reconciledDetail = new Promise<Response>((resolve) => {
      resolveReconciledDetail = resolve;
    });
    const reconciledList = new Promise<Response>((resolve) => {
      resolveReconciledList = resolve;
    });
    const fetchStub = vi.fn((path: string, init?: RequestInit) => {
      if (path.includes("/proposals?state=pending")) {
        return mutationStarted
          ? reconciledList
          : Promise.resolve(jsonResponse({ proposals: [proposal] }));
      }
      if (path === `/api/proposals/${proposal.id}`) {
        detailReads += 1;
        if (detailReads === 2) {
          reconciliationSignal = init?.signal ?? undefined;
          return reconciledDetail;
        }
        return Promise.resolve(jsonResponse({ proposal: detail(proposal) }));
      }
      if (path === `/api/proposals/${proposal.id}/accept`) {
        mutationStarted = true;
        return Promise.reject(new TypeError("Response stream lost"));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    const view = render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(reconciliationSignal).toBeDefined());

    view.unmount();
    expect(reconciliationSignal?.aborted).toBe(true);

    await act(async () => {
      resolveReconciledDetail(jsonResponse({
        proposal: detail(proposal, { state: "accepted" }),
      }));
      resolveReconciledList(jsonResponse({ proposals: [] }));
      await Promise.all([reconciledDetail, reconciledList]);
    });
  });

  test("rejects an action response for a different proposal or project", async () => {
    const proposal = summary("proposal-action-scope");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) }))
      .mockResolvedValueOnce(jsonResponse({
        outcome: "applied",
        projectRevision: 8,
        proposal: {
          ...proposal,
          id: "proposal-other",
          projectId: "project-other",
          state: "accepted",
        },
      } satisfies ProposalAcceptResponse)));
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);
    await user.click(await screen.findByRole("button", {
      name: "Accept proposal",
    }));
    await user.click(screen.getByRole("button", { name: "Confirm accept" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "did not match the reviewed proposal",
    );
    expect(screen.queryByText("Accepted at project revision 8")).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm accept" })).toBeTruthy();
  });

  test("moves focus into acceptance and restores it to the pointer trigger on cancel", async () => {
    const proposal = summary("proposal-accept-focus");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) })));

    render(<ProposalsScreen projectId="project-one" />);

    const trigger = await screen.findByRole("button", {
      name: "Accept proposal",
    });
    document.body.focus();
    fireEvent.click(trigger);
    const confirm = screen.getByRole("button", { name: "Confirm accept" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const restored = screen.getByRole("button", { name: "Accept proposal" });
    await waitFor(() => expect(document.activeElement).toBe(restored));
  });

  test("moves focus into rejection and restores it to the keyboard trigger on cancel", async () => {
    const proposal = summary("proposal-reject-keyboard-focus");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) })));
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);

    const trigger = await screen.findByRole("button", {
      name: "Reject proposal",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const reason = screen.getByRole("textbox", {
      name: "Reason for rejection",
    });
    await waitFor(() => expect(document.activeElement).toBe(reason));

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const restored = screen.getByRole("button", { name: "Reject proposal" });
    await waitFor(() => expect(document.activeElement).toBe(restored));
  });

  test("focuses the rejection field and exposes its invalid state", async () => {
    const proposal = summary("proposal-reject-focus");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ proposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: detail(proposal) })));
    const user = userEvent.setup();

    render(<ProposalsScreen projectId="project-one" />);

    const trigger = await screen.findByRole("button", {
      name: "Reject proposal",
    });
    document.body.focus();
    fireEvent.click(trigger);
    const reason = screen.getByRole("textbox", {
      name: "Reason for rejection",
    });
    await waitFor(() => expect(document.activeElement).toBe(reason));

    await user.click(screen.getByRole("button", {
      name: "Confirm rejection",
    }));

    await waitFor(() => expect(document.activeElement).toBe(reason));
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a reason for rejecting this proposal.",
    );
  });
});
