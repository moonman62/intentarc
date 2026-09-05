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
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DesktopRepositoryApi } from "../desktop-api.js";
import { RepositoryRefresh } from "./repository-refresh.js";

const json = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json" } },
);

const apiError = (code: string, message: string): Response => json({
  error: { code, message, recoverable: true },
}, 409);

const refreshState = (
  review: unknown,
  sourceStatus: "available" | "unavailable" | "detached" | null = "available",
): Response => json({ review, sourceStatus });

const diffKinds = [
  "added",
  "changed",
  "moved",
  "removed",
  "unchanged",
  "excluded",
  "conflicted",
] as const;

const reviewFixture = ({
  snapshotId = "snapshot-one",
  state = "pending",
  selectedOperationIds = [],
  semanticOperations = [{
    operationId: "semantic-task",
    type: "create_record",
    localRef: "semantic-task",
    kind: "task",
    status: "provisional",
    title: "Document the refresh flow",
    body: "Proposed from repository evidence.",
  }],
  warningCounts = { working_tree_dirty: 2 },
  exclusionCounts = { ignored: 1 },
}: {
  snapshotId?: string;
  state?: "pending" | "applied" | "cancelled" | "conflicted";
  selectedOperationIds?: string[];
  semanticOperations?: Array<Record<string, unknown>>;
  warningCounts?: Record<string, number>;
  exclusionCounts?: Record<string, number>;
} = {}) => ({
  projectId: "project-one",
  snapshotId,
  state,
  selectedOperationIds,
  baseProjectRevision: 3,
  warningCounts,
  exclusionCounts,
  findingCounts: { instruction: 1 },
  diff: {
    groups: diffKinds.map((kind, index) => ({
      kind,
      entries: [{
        operationId: kind === "conflicted" ? "semantic-conflict" : `fact-${kind}`,
        kind,
        previousNodeId: index === 0 ? null : `previous-${kind}`,
        currentNodeId: kind === "removed" ? null : `current-${kind}`,
        previousPath: index === 0 ? null : `before/${kind}.md`,
        currentPath: kind === "removed" ? null : `after/${kind}.md`,
      }],
    })),
    semanticOperations,
  },
});

const ndjson = (
  values: unknown[],
  {
    chunks,
    trailingNewline = true,
  }: { chunks?: number[]; trailingNewline?: boolean } = {},
): Response => {
  const encoded = new TextEncoder().encode(
    values.map((value) => JSON.stringify(value)).join("\n") +
      (trailingNewline ? "\n" : ""),
  );
  const sizes = chunks ?? [encoded.byteLength];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const size of sizes) {
        if (offset >= encoded.byteLength) break;
        controller.enqueue(encoded.slice(offset, offset + size));
        offset += size;
      }
      if (offset < encoded.byteLength) controller.enqueue(encoded.slice(offset));
      controller.close();
    },
  }), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
};

const openNdjson = (lines: readonly string[]) => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join("\n")}\n`));
    },
    cancel,
  }), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
  return { cancel, response };
};

const streamEvents = (review = reviewFixture()) => [{
  type: "progress",
  progress: { phase: "discovering", processed: 1, total: 4 },
}, {
  type: "progress",
  progress: { phase: "hashing", processed: 3, total: 4 },
}, {
  type: "review",
  review,
}];

const renderRefresh = (overrides: {
  projectId?: string;
  projectRevision?: number;
  hasPrimaryRepository?: boolean;
  desktopRepository?: DesktopRepositoryApi | null;
} = {}) => render(
  <RepositoryRefresh
    projectId={overrides.projectId ?? "project-one"}
    projectRevision={overrides.projectRevision ?? 3}
    hasPrimaryRepository={overrides.hasPrimaryRepository ?? true}
    desktopRepository={overrides.desktopRepository ?? null}
  />,
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RepositoryRefresh", () => {
  test("attaches a browsed or manually entered repository to the current project", async () => {
    const desktop: DesktopRepositoryApi = {
      chooseRepositoryDirectory: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("C:\\verified\\repository"),
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json({ review: null, sourceStatus: null }))
      .mockResolvedValueOnce(ndjson(streamEvents(reviewFixture({ warningCounts: {} }))));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh({ desktopRepository: desktop, hasPrimaryRepository: false });

    const input = await screen.findByRole("textbox", { name: "Repository folder" });
    await user.type(input, "C:\\manual\\repository");
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect((input as HTMLInputElement).value).toBe("C:\\manual\\repository");
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect((input as HTMLInputElement).value).toBe("C:\\verified\\repository");
    await user.click(screen.getByRole("button", { name: "Attach and review" }));

    expect(await screen.findByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(fetchStub.mock.calls[1]?.[0]).toBe(
      "/api/projects/project-one/repository-source/attach",
    );
    expect(JSON.parse(String((fetchStub.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      root: "C:\\verified\\repository",
      expectedProjectRevision: 3,
    });
  });
  test("renders sanitized nonzero exclusion aggregates inside the stable excluded group", async () => {
    const review = reviewFixture({
      exclusionCounts: {
        ignored: 2,
        known_secret_path: 1,
        oversized_text: 0,
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refreshState(review)));

    renderRefresh();

    const facts = await screen.findByRole("region", { name: "Repository facts" });
    expect(within(facts).getAllByRole("heading", { level: 3 })).toHaveLength(7);
    const excluded = within(facts)
      .getByRole("heading", { name: "Excluded (3)" })
      .closest("section")!;
    expect(excluded.textContent).toContain("Ignored: 2");
    expect(excluded.textContent).toContain("Known secret path: 1");
    expect(excluded.textContent).not.toContain("Oversized text");
    expect(excluded.textContent).not.toContain(".env");
    expect(excluded.textContent).not.toMatch(/[a-f0-9]{64}/);
    expect(excluded.textContent).not.toContain("before/excluded.md");
    expect(excluded.textContent).not.toContain("after/excluded.md");
  });

  test("loads pending state before offering a scan and resumes without polling", async () => {
    const review = reviewFixture({ selectedOperationIds: ["semantic-task"] });
    const fetchStub = vi.fn().mockResolvedValue(refreshState(review));
    vi.stubGlobal("fetch", fetchStub);

    const { unmount } = renderRefresh();

    expect(screen.getByText("Loading repository refresh…")).toBeTruthy();
    expect(await screen.findByText("Resumed pending review")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Removed (1)" }).closest("section")?.textContent)
      .not.toContain("→");
    expect((screen.getByRole("checkbox", { name: /Document the refresh flow/ }) as HTMLInputElement).checked).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(
      "/api/projects/project-one/repository-refresh",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    unmount();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("rejects a pending review that belongs to another project", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      review: { ...reviewFixture(), projectId: "project-two" },
      sourceStatus: "available",
    })));
    renderRefresh();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The repository refresh did not match this project.",
    );
    expect(screen.queryByRole("heading", { name: "Repository facts" })).toBeNull();
  });

  test("streams bounded monotonic progress from split NDJSON chunks and flushes the final line", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(ndjson(streamEvents(), {
        chunks: [1, 2, 5, 3, 8, 13],
        trailingNewline: false,
      }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));

    const facts = await screen.findByRole("region", { name: "Repository facts" });
    for (const kind of diffKinds) {
      expect(within(facts).getByRole("heading", {
        name: new RegExp(`^${kind}`, "i"),
      })).toBeTruthy();
    }
    expect(screen.getByText(/working tree has 2 uncommitted changes/i)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("max")).toBe("100");
    expect(Number(screen.getByRole("progressbar").getAttribute("value"))).toBeGreaterThanOrEqual(0);
    expect(Number(screen.getByRole("progressbar").getAttribute("value"))).toBeLessThanOrEqual(100);
    expect(screen.getByText("Scan complete")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Proposed project meaning" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Document the refresh flow/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Accept repository refresh" })).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("aborts an in-flight scan, ignores late events, and returns focus to start", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal!: AbortSignal;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockImplementationOnce((_path: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return Promise.resolve(response);
      })
      .mockResolvedValueOnce(refreshState(null));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    const start = await screen.findByRole("button", { name: "Scan repository" });
    await user.click(start);
    await user.click(await screen.findByRole("button", { name: "Cancel scan" }));

    expect(requestSignal.aborted).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Scan repository" }),
    ));
    expect(screen.getByText("Scan cancelled. No accepted repository state changed."))
      .toBeTruthy();

    act(() => {
      try {
        streamController.enqueue(new TextEncoder().encode(
          `${JSON.stringify({ type: "review", review: reviewFixture() })}\n`,
        ));
        streamController.close();
      } catch {
        // A platform may cancel the reader when the request signal aborts.
      }
    });
    await act(async () => await Promise.resolve());
    expect(screen.queryByRole("heading", { name: "Repository facts" })).toBeNull();
  });

  test("resumes a candidate persisted before a cancelled stream delivered its final review", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
          type: "progress",
          progress: { phase: "finalizing", processed: 1, total: 1 },
        })}\n`));
      },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
    const review = reviewFixture();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(refreshState(review));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    await user.click(await screen.findByRole("button", { name: "Cancel scan" }));

    expect(await screen.findByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.getByText(
      "Scan cancelled. No accepted repository state changed. A saved candidate is ready to review.",
    )).toBeTruthy();
    expect(screen.queryByText(/No repository refresh was saved/)).toBeNull();
    expect(fetchStub.mock.calls[2]?.[0]).toBe(
      "/api/projects/project-one/repository-refresh",
    );
  });

  test("persists semantic selection and reconciles only the strict server response", async () => {
    const review = reviewFixture();
    let resolvePatch!: (response: Response) => void;
    const patch = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(review))
      .mockReturnValueOnce(patch);
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    const checkbox = await screen.findByRole("checkbox", { name: /Document the refresh flow/ });
    await user.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    const [path, init] = fetchStub.mock.calls[1]!;
    expect(path).toBe("/api/projects/project-one/repository-refresh/snapshot-one");
    expect(init).toMatchObject({ method: "PATCH", signal: expect.any(AbortSignal) });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      projectId: "project-one",
      snapshotId: "snapshot-one",
      selectedOperationIds: ["semantic-task"],
    });

    resolvePatch(json({ review: reviewFixture({ selectedOperationIds: ["semantic-task"] }) }));
    expect(await screen.findByRole("button", {
      name: "Accept refresh and create proposal",
    })).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  test("turns a selection revision conflict into a retained, non-applicable review", async () => {
    const review = reviewFixture();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(refreshState(review))
      .mockResolvedValueOnce(apiError(
        "repository_refresh_conflict",
        "Repository evidence or project state changed. Review a fresh scan.",
      )));
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("checkbox", { name: /Document the refresh flow/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/changed.*fresh scan/i);
    expect(screen.getByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: /Accept repository refresh|Accept refresh and create proposal/,
    })).toBeNull();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
    expect(screen.getByText("Conflicting proposal")).toBeTruthy();
  });

  test.each([
    [[], null, "Accept repository refresh", "Repository refresh accepted. Project meaning was unchanged."],
    [["semantic-task"], "proposal-one", "Accept refresh and create proposal", "Repository refresh accepted and proposal created."],
  ] as const)("distinguishes index-only and proposal outcomes", async (
    selectedOperationIds,
    proposalId,
    buttonName,
    outcome,
  ) => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(
        reviewFixture({ selectedOperationIds: [...selectedOperationIds] }),
      ))
      .mockResolvedValueOnce(json({
        snapshotId: "snapshot-one",
        projectRevision: 3,
        proposalId,
        replayed: false,
      }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    const apply = await screen.findByRole("button", { name: buttonName });
    await user.dblClick(apply);
    expect(await screen.findByText(outcome)).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const [path, init] = fetchStub.mock.calls[1]!;
    expect(path).toBe("/api/projects/project-one/repository-refresh/snapshot-one/apply");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      projectId: "project-one",
      snapshotId: "snapshot-one",
      expectedProjectRevision: 3,
    });
  });

  test("keeps a conflicted review visible, suppresses apply, and replaces it only on Scan again", async () => {
    const semanticOperations = [{
      operationId: "semantic-conflict",
      type: "update_record",
      recordId: "task-one",
      expectedRecordRevision: 1,
      patch: { title: "Conflicting title" },
    }];
    const review = reviewFixture({ selectedOperationIds: ["semantic-conflict"], semanticOperations });
    const fresh = reviewFixture({ snapshotId: "snapshot-two", semanticOperations: [] });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(review))
      .mockResolvedValueOnce(apiError(
        "repository_refresh_conflict",
        "Repository evidence or project state changed. Review a fresh scan.",
      ))
      .mockResolvedValueOnce(json({ review: { ...review, state: "cancelled" } }))
      .mockResolvedValueOnce(ndjson(streamEvents(fresh)));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    expect(await screen.findByText("Conflicting proposal")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Accept refresh and create proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed.*fresh scan/i);
    expect(screen.getByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: /Accept repository refresh|Accept refresh and create proposal/,
    })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByText("snapshot-two")).toBeTruthy();
    expect(fetchStub.mock.calls[2]?.[0]).toBe(
      "/api/projects/project-one/repository-refresh/snapshot-one/cancel",
    );
    expect(fetchStub.mock.calls[3]?.[0]).toBe(
      "/api/projects/project-one/repository-refreshes",
    );
  });

  test("resumes a persisted conflicted review after restart with apply disabled and Scan again enabled", async () => {
    const conflicted = reviewFixture({ state: "conflicted" });
    const fresh = reviewFixture({ snapshotId: "snapshot-two" });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(conflicted))
      .mockResolvedValueOnce(json({ review: { ...conflicted, state: "cancelled" } }))
      .mockResolvedValueOnce(ndjson(streamEvents(fresh)));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    expect((await screen.findByRole("alert")).textContent).toMatch(/changed.*fresh scan/i);
    expect(screen.queryByRole("button", {
      name: /Accept repository refresh|Accept refresh and create proposal/,
    })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByText("snapshot-two")).toBeTruthy();
    expect(fetchStub.mock.calls[1]?.[0]).toBe(
      "/api/projects/project-one/repository-refresh/snapshot-one/cancel",
    );
    expect(fetchStub.mock.calls[2]?.[0]).toBe(
      "/api/projects/project-one/repository-refreshes",
    );
  });

  test("requires explicit discard confirmation and returns focus to the refresh trigger", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(reviewFixture()))
      .mockResolvedValueOnce(json({ review: { ...reviewFixture(), state: "cancelled" } }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    const discard = await screen.findByRole("button", { name: "Discard candidate" });
    await user.click(discard);
    const dialog = screen.getByRole("dialog", { name: "Discard repository refresh?" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const keep = within(dialog).getByRole("button", { name: "Keep review" });
    const confirm = within(dialog).getByRole("button", { name: "Discard refresh" });
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.click(keep);
    expect(document.activeElement).toBe(discard);

    await user.click(discard);
    await user.click(screen.getByRole("button", { name: "Discard refresh" }));
    const start = await screen.findByRole("button", { name: "Scan repository" });
    await waitFor(() => expect(document.activeElement).toBe(start));
    expect(JSON.parse(String((fetchStub.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      projectId: "project-one",
      snapshotId: "snapshot-one",
      confirmed: true,
    });
  });

  test("returns focus to Discard candidate when discard fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(refreshState(reviewFixture()))
      .mockResolvedValueOnce(apiError("validation_failed", "Could not discard this candidate.")));
    const user = userEvent.setup();
    renderRefresh();

    const discard = await screen.findByRole("button", { name: "Discard candidate" });
    await user.click(discard);
    await user.click(screen.getByRole("button", { name: "Discard refresh" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not discard this candidate.",
    );
    await waitFor(() => expect(document.activeElement).toBe(discard));
  });

  test("leaves degraded recovery mode after a successful desktop locate and retry", async () => {
    const desktop: DesktopRepositoryApi = {
      chooseRepositoryDirectory: vi.fn(async () => "C:\\moved\\IntentArc"),
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."))
      .mockResolvedValueOnce(json({ projectRevision: 4, requiresRefresh: true }))
      .mockResolvedValueOnce(ndjson(streamEvents(reviewFixture({ warningCounts: {} }))));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh({ desktopRepository: desktop });

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
    expect(screen.getByText(/accepted indexed metadata remains available/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Locate repository" }));
    expect(desktop.chooseRepositoryDirectory).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchStub.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      root: "C:\\moved\\IntentArc",
      expectedProjectRevision: 3,
    });
    expect(await screen.findByText(/repository location verified/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Repository unavailable" })).toBeNull();
    expect(screen.getByText("Repository evidence is available for review.")).toBeTruthy();
    expect((screen.getByRole("checkbox", {
      name: /Document the refresh flow/,
    }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Accept repository refresh" })).toBeTruthy();
  });

  test("preserves persisted unavailable recovery when cancellation races the failed scan", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
          type: "progress",
          progress: { phase: "finalizing", processed: 1, total: 1 },
        })}\n`));
      },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json({ review: null, sourceStatus: "available" }))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(json({ review: null, sourceStatus: "unavailable" }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh({
      desktopRepository: { chooseRepositoryDirectory: vi.fn(async () => null) },
    });

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    await user.click(await screen.findByRole("button", { name: "Cancel scan" }));

    expect(await screen.findByRole("heading", { name: "Repository unavailable" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Locate repository" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scan repository" })).toBeNull();
  });

  test("restores persisted unavailable-source recovery after the screen remounts", async () => {
    const desktop: DesktopRepositoryApi = {
      chooseRepositoryDirectory: vi.fn(async () => null),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({
      review: null,
      sourceStatus: "unavailable",
    })));

    renderRefresh({ desktopRepository: desktop });

    expect(await screen.findByRole("heading", { name: "Repository unavailable" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Locate repository" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scan repository" })).toBeNull();
  });

  test("requires confirmation before detaching an unavailable repository", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."))
      .mockResolvedValueOnce(json({ projectRevision: 4, requiresRefresh: true }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    await user.click(screen.getByRole("button", { name: "Detach repository" }));
    expect(screen.getByRole("dialog", { name: "Detach repository?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm detach" }));
    expect(JSON.parse(String((fetchStub.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      confirmed: true,
      expectedProjectRevision: 3,
    });
    expect(await screen.findByText(/repository detached/i)).toBeTruthy();
  });

  test("explains that Locate requires desktop in standalone web", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    expect(await screen.findByText("Locate is available in the desktop app.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Locate repository" })).toBeNull();
  });

  test("treats a different located repository identity as a closed error", async () => {
    const desktop: DesktopRepositoryApi = {
      chooseRepositoryDirectory: vi.fn(async () => "C:\\other\\repository"),
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."))
      .mockResolvedValueOnce(apiError(
        "repository_refresh_conflict",
        "Repository evidence or project state changed. Review a fresh scan.",
      ));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh({ desktopRepository: desktop });

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    await user.click(await screen.findByRole("button", { name: "Locate repository" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The selected folder is not the registered repository. Nothing changed.",
    );
  });

  test("does not submit a located folder after the screen unmounts", async () => {
    let resolveChooser!: (root: string | null) => void;
    const desktop: DesktopRepositoryApi = {
      chooseRepositoryDirectory: vi.fn(() => new Promise((resolve) => {
        resolveChooser = resolve;
      })),
    };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    const { unmount } = renderRefresh({ desktopRepository: desktop });

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    await user.click(await screen.findByRole("button", { name: "Locate repository" }));
    unmount();
    resolveChooser("C:\\moved\\after-unmount");
    await act(async () => await Promise.resolve());

    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("keeps an unavailable apply review visible but suppresses repeat apply", async () => {
    const review = reviewFixture();
    const fresh = reviewFixture({ snapshotId: "snapshot-after-retry", warningCounts: {} });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(review))
      .mockResolvedValueOnce(apiError("repository_unavailable", "The registered repository is unavailable."))
      .mockResolvedValueOnce(json({ review: { ...review, state: "cancelled" } }))
      .mockResolvedValueOnce(ndjson(streamEvents(fresh)));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Accept repository refresh" }));
    expect(await screen.findByRole("heading", { name: "Repository unavailable" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Repository facts" })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: /Accept repository refresh|Accept refresh and create proposal/,
    })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("snapshot-after-retry")).toBeTruthy();
    expect(fetchStub.mock.calls[2]?.[0]).toBe(
      "/api/projects/project-one/repository-refresh/snapshot-one/cancel",
    );
    expect(fetchStub.mock.calls[3]?.[0]).toBe(
      "/api/projects/project-one/repository-source/retry",
    );
  });

  test("keeps operation keyboard focus inside the semantic list and toggles with Space", async () => {
    const review = reviewFixture({ semanticOperations: [{
      operationId: "semantic-first",
      type: "create_record",
      kind: "task",
      status: "provisional",
      title: "First meaning",
      body: "First",
    }, {
      operationId: "semantic-second",
      type: "create_record",
      kind: "decision",
      status: "active",
      title: "Second meaning",
      body: "Second",
    }] });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(refreshState(review))
      .mockResolvedValueOnce(json({ review: {
        ...review,
        selectedOperationIds: ["semantic-second"],
      } })));
    const user = userEvent.setup();
    const fetchStub = vi.mocked(fetch);
    renderRefresh();

    const first = await screen.findByRole("checkbox", { name: /First meaning/ });
    const second = screen.getByRole("checkbox", { name: /Second meaning/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    await user.keyboard("[Space]");
    expect(await screen.findByRole("button", { name: "Accept refresh and create proposal" })).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("clears old review objects and ignores actions after a project route change", async () => {
    let resolveOldPatch!: (response: Response) => void;
    const oldPatch = new Promise<Response>((resolve) => { resolveOldPatch = resolve; });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(refreshState(reviewFixture()))
      .mockReturnValueOnce(oldPatch)
      .mockResolvedValueOnce(refreshState(null));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    const { rerender } = renderRefresh();

    await user.click(await screen.findByRole("checkbox", { name: /Document the refresh flow/ }));
    const oldSignal = (fetchStub.mock.calls[1]?.[1] as RequestInit).signal as AbortSignal;
    rerender(
      <RepositoryRefresh
        projectId="project-two"
        projectRevision={7}
        desktopRepository={null}
      />,
    );
    expect(oldSignal.aborted).toBe(true);
    expect(screen.queryByText("Document the refresh flow")).toBeNull();
    resolveOldPatch(json({ review: reviewFixture({ selectedOperationIds: ["semantic-task"] }) }));
    expect(await screen.findByRole("button", { name: "Scan repository" })).toBeTruthy();
    expect(screen.queryByText("Document the refresh flow")).toBeNull();
  });

  test("shows retryable load and malformed-stream errors without inventing a review", async () => {
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new Error("Archive unavailable"))
      .mockResolvedValueOnce(refreshState(null))
      .mockResolvedValueOnce(new Response("{not-json}\n", {
        headers: { "Content-Type": "application/x-ndjson" },
      }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderRefresh();

    expect((await screen.findByRole("alert")).textContent).toContain("Archive unavailable");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(await screen.findByRole("button", { name: "Scan repository" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not read.*progress/i);
    expect(screen.queryByRole("heading", { name: "Repository facts" })).toBeNull();
  });

  test.each([
    ["malformed JSON", ["{not-json}"]],
    ["invalid event schema", [JSON.stringify({
      type: "progress",
      progress: { phase: "unknown", processed: 0, total: 1 },
    })]],
    ["duplicate final reviews", [
      JSON.stringify({ type: "review", review: reviewFixture() }),
      JSON.stringify({ type: "review", review: reviewFixture() }),
    ]],
    ["progress after the final review", [
      JSON.stringify({ type: "review", review: reviewFixture() }),
      JSON.stringify({
        type: "progress",
        progress: { phase: "finalizing", processed: 1, total: 1 },
      }),
    ]],
  ] as const)("cancels and releases a failed %s stream", async (_case, lines) => {
    const stream = openNdjson(lines);
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockImplementationOnce((_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve(stream.response);
      }));
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not read.*progress/i);
    expect(screen.queryByRole("heading", { name: "Repository facts" })).toBeNull();
    await waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(true);
    expect(stream.response.body?.locked).toBe(false);
  });

  test("cancels an unsupported streaming response before reporting its content type error", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not ndjson"));
      },
      cancel,
    }), { headers: { "Content-Type": "application/json" } });
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(refreshState(null))
      .mockImplementationOnce((_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve(response);
      }));
    const user = userEvent.setup();
    renderRefresh();

    await user.click(await screen.findByRole("button", { name: "Scan repository" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not read.*progress/i);
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
});
