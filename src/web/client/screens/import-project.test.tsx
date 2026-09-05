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
  ImportInspection,
  RepositoryImportManifest,
} from "../../../domain/index.js";
import type {
  ImportScanResponse,
  ProjectDashboardResponse,
  ProjectHubResponse,
} from "../../contracts.js";
import { App } from "../app.js";
import type { IntentArcDesktopApi } from "../desktop-api.js";
import { preferenceKeys } from "../preferences.js";
import { ImportProjectScreen } from "./import-project.js";

const digest = "a".repeat(64);
const manifest = {
  privateRepositoryManifest: "component-memory-only",
} as unknown as RepositoryImportManifest;
const inspection: ImportInspection = {
  manifestDigest: digest,
  repository: {
    root: "C:/private/work/intentarc",
    canonicalSubpath: "app",
    branch: "main",
    head: "b".repeat(40),
    fingerprint: "c".repeat(64),
  },
  project: {
    name: "IntentArc",
    primaryRepositoryPath: "C:/private/work/intentarc",
  },
  counts: {
    recordsByKind: [
      { kind: "outcome", count: 1 },
      { kind: "task", count: 2 },
    ],
    recordsByStatus: [
      { status: "active", count: 2 },
      { status: "provisional", count: 1 },
    ],
    recordsBySourceKind: [{ sourceKind: "repository", count: 3 }],
  },
  stableFrame: [{
    key: "outcome.release",
    kind: "outcome",
    status: "active",
    title: "Keep import reviewable",
    sourceKind: "repository",
    sourceRef: "app/README.md",
  }],
  activeTasks: [{
    key: "task.import",
    kind: "task",
    status: "active",
    title: "Ship repository onboarding",
    sourceKind: "repository",
    sourceRef: "app/ROADMAP.md",
    directLinks: [{
      fromKey: "task.import",
      toKey: "outcome.release",
      kind: "serves",
    }],
  }],
  curatedOrProvisionalClaims: [{
    key: "decision.scan",
    kind: "decision",
    status: "provisional",
    title: "Treat the app subtree as canonical",
    sourceKind: "agent",
    curationReason: "Inferred from repository structure",
  }],
  sensitiveFindings: [{
    category: "email",
    severity: "sensitive",
    count: 2,
  }],
  warnings: [{ code: "working_tree_dirty", count: 1 }],
  exclusions: [{
    path: "app/.env",
    reason: "known_secret_path",
    count: 1,
  }],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const scanResponse = (): ImportScanResponse => ({ manifest, inspection });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.intentArcDesktop;
});

describe("ImportProjectScreen", () => {
  test("leads with repository controls before its concise safety boundary", () => {
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    const repositoryPath = screen.getByRole("textbox", { name: "Repository path" });
    const scan = screen.getByRole("button", { name: "Scan repository" });
    // This note is retained because it states execution and apply authority boundaries,
    // not routine tutorial guidance.
    const safetyBoundary = screen.getByRole("note", { name: "Import safety" });

    expect(screen.queryByText(
      "IntentArc reads eligible repository evidence without running repository code. You will review every proposed baseline before it is applied.",
    )).toBeNull();
    expect(
      repositoryPath.compareDocumentPosition(scan) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      scan.compareDocumentPosition(safetyBoundary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(safetyBoundary.textContent).toContain("does not run repository code");
    expect(safetyBoundary.textContent).toContain("review");
  });

  test("fills the editable repository path from the desktop chooser", async () => {
    const chooseRepositoryDirectory = vi.fn(async () => "C:\\projects\\IntentArc");
    window.intentArcDesktop = {
      repository: { chooseRepositoryDirectory },
    } as IntentArcDesktopApi;
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Browse…" }));

    expect(chooseRepositoryDirectory).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Repository path") as HTMLInputElement).value)
      .toBe("C:\\projects\\IntentArc");
  });

  test("keeps the repository path when desktop browsing is cancelled", async () => {
    const chooseRepositoryDirectory = vi.fn(async () => null);
    window.intentArcDesktop = {
      repository: { chooseRepositoryDirectory },
    } as IntentArcDesktopApi;
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    const repositoryPath = screen.getByLabelText("Repository path");
    await user.type(repositoryPath, "C:/repositories/current");
    await user.click(screen.getByRole("button", { name: "Browse…" }));

    expect(chooseRepositoryDirectory).toHaveBeenCalledOnce();
    expect((repositoryPath as HTMLInputElement).value).toBe("C:/repositories/current");
  });

  test("keeps the repository path and offers manual recovery when desktop browsing fails", async () => {
    const chooseRepositoryDirectory = vi.fn(async () => {
      throw new Error("PRIVATE picker failure");
    });
    window.intentArcDesktop = {
      repository: { chooseRepositoryDirectory },
    } as IntentArcDesktopApi;
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    const repositoryPath = screen.getByLabelText("Repository path");
    await user.type(repositoryPath, "C:/repositories/current");
    await user.click(screen.getByRole("button", { name: "Browse…" }));

    expect(chooseRepositoryDirectory).toHaveBeenCalledOnce();
    expect((repositoryPath as HTMLInputElement).value).toBe("C:/repositories/current");
    expect((await screen.findByRole("alert")).textContent)
      .toContain("Browse could not open. Enter the repository path manually.");
    expect(screen.getByRole("alert").textContent).not.toContain("PRIVATE");
  });

  test("keeps the repository path editable in a browser-only build", async () => {
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
    const repositoryPath = screen.getByLabelText("Repository path");
    await user.type(repositoryPath, "C:/repositories/manual");
    expect((repositoryPath as HTMLInputElement).value).toBe("C:/repositories/manual");
  });

  test("places import summary and apply controls before closed technical details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(scanResponse())));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    const project = await screen.findByRole("heading", { name: "Project" });
    const repository = screen.getByRole("heading", { name: "Repository" });
    const records = screen.getByRole("heading", { name: "Detected records" });
    const warnings = screen.getByRole("heading", { name: "Warnings" });
    const apply = screen.getByRole("heading", { name: "Apply" });
    const technicalDetails = screen.getByText("Review technical details").closest("details");

    expect(technicalDetails).not.toBeNull();
    expect(technicalDetails?.hasAttribute("open")).toBe(false);
    for (const element of [project, repository, records, warnings, apply]) {
      expect(element.compareDocumentPosition(technicalDetails!) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
    expect(within(technicalDetails!).getByText("main")).toBeTruthy();
    expect(within(technicalDetails!).getByText("app/.env")).toBeTruthy();
    expect(within(technicalDetails!).getByText("Keep import reviewable")).toBeTruthy();
    expect(within(technicalDetails!).getByText(digest)).toBeTruthy();
    expect(within(technicalDetails!).getByText("c".repeat(64))).toBeTruthy();
  });

  test("focuses the review summary when a scan completes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(scanResponse())));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    expect(document.activeElement).toBe(
      await screen.findByRole("heading", { name: "Review scan summary" }),
    );
  });

  test("requires a repository path and announces scan progress", async () => {
    let resolveScan!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveScan = resolve;
    })));
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    const repositoryPath = screen.getByRole("textbox", {
      name: "Repository path",
    });
    expect(repositoryPath.hasAttribute("required")).toBe(true);
    fireEvent.change(repositoryPath, {
      target: { value: "C:/private/work/intentarc" },
    });
    fireEvent.submit(repositoryPath.closest("form")!);

    expect(screen.getByText("Scanning repository…").getAttribute("aria-live"))
      .toBe("polite");
    resolveScan(jsonResponse(scanResponse()));
    expect(await screen.findByText("Keep import reviewable")).toBeTruthy();
  });

  test("renders the complete inspection as non-link review ledger sections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(scanResponse()),
    ));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    expect(await screen.findByRole("heading", { name: "Repository identity" }))
      .toBeTruthy();
    expect(screen.getByText("C:/private/work/intentarc")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stable frame" })).toBeTruthy();
    expect(screen.getByText("Keep import reviewable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active tasks" })).toBeTruthy();
    expect(screen.getByText("Ship repository onboarding")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Warnings" })).toBeTruthy();
    expect(screen.getAllByText("working tree dirty")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Exclusions" })).toBeTruthy();
    expect(screen.getByText("app/.env")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sensitive findings" }))
      .toBeTruthy();
    expect(screen.getByText("2 email findings")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Provisional claims" }))
      .toBeTruthy();
    expect(screen.getByText("Treat the app subtree as canonical")).toBeTruthy();

    for (const sourcePath of ["app/README.md", "app/ROADMAP.md", "app/.env"]) {
      const path = screen.getByText(sourcePath);
      expect(path.closest("a")).toBeNull();
    }
    expect(document.querySelector('a[href^="file:"]')).toBeNull();
  });

  test("renders record counts and active-task relationship targets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(scanResponse()),
    ));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    const countsHeading = await screen.findByRole("heading", {
      name: "Baseline counts",
    });
    const counts = within(countsHeading.closest("section")!);
    expect(counts.getByText("1 outcome")).toBeTruthy();
    expect(counts.getByText("2 tasks")).toBeTruthy();
    expect(counts.getByText("2 active")).toBeTruthy();
    expect(counts.getByText("1 provisional")).toBeTruthy();
    expect(counts.getByText("3 repository")).toBeTruthy();

    const task = screen.getByText("Ship repository onboarding").closest("li")!;
    expect(within(task).getByText("serves")).toBeTruthy();
    expect(within(task).getByText("outcome.release")).toBeTruthy();
  });

  test("makes review and confirmation separate, discoverable steps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(scanResponse()),
    ));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    await screen.findByRole("heading", { name: "Repository identity" });
    const progress = screen.getByRole("list", { name: "Import progress" });
    expect(progress.querySelector('[aria-current="step"]')?.textContent)
      .toContain("Review inspection");
    expect(screen.queryByRole("checkbox", {
      name: "I reviewed this baseline",
    })).toBeNull();

    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));

    expect(progress.querySelector('[aria-current="step"]')?.textContent)
      .toContain("Confirm and apply");
    expect(screen.getByRole("checkbox", {
      name: "I reviewed this baseline",
    })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Apply imported baseline",
    }).hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", {
      name: "Back to inspection",
    }));
    expect(progress.querySelector('[aria-current="step"]')?.textContent)
      .toContain("Review inspection");
    expect(screen.queryByRole("checkbox", {
      name: "I reviewed this baseline",
    })).toBeNull();
  });

  test("invalidates a reviewed inspection when the selected source changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(scanResponse()),
    ));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    const repositoryPath = screen.getByRole("textbox", {
      name: "Repository path",
    });
    await user.type(repositoryPath, "C:/repositories/A");
    await user.click(screen.getByRole("button", { name: "Scan repository" }));
    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));
    await user.click(await screen.findByRole("checkbox", {
      name: "I reviewed this baseline",
    }));
    expect(screen.getByRole("heading", { name: "Apply this baseline" }))
      .toBeTruthy();

    fireEvent.change(repositoryPath, {
      target: { value: "C:/repositories/B" },
    });

    expect(screen.queryByText("Keep import reviewable")).toBeNull();
    expect(screen.queryByRole("checkbox", {
      name: "I reviewed this baseline",
    })).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Apply imported baseline",
    })).toBeNull();
    expect(screen.getByRole("button", { name: "Scan repository" }))
      .toBeTruthy();
  });

  test("invalidates a reviewed inspection when the canonical subpath changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(scanResponse()),
    ));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/repositories/A",
    );
    const canonicalSubpath = screen.getByRole("textbox", {
      name: "Canonical subpath optional",
    });
    await user.type(canonicalSubpath, "app-a");
    await user.click(screen.getByRole("button", { name: "Scan repository" }));
    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));
    await user.click(await screen.findByRole("checkbox", {
      name: "I reviewed this baseline",
    }));

    fireEvent.change(canonicalSubpath, { target: { value: "app-b" } });

    expect(screen.queryByText("Keep import reviewable")).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Apply imported baseline",
    })).toBeNull();
  });

  test("announces a safe scan failure and keeps retry available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "import_validation_failed",
        message: "PRIVATE C:/repositories/secret could not be opened",
        recoverable: true,
      },
    }, 400)));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/repositories/secret",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Repository inspection could not be completed.",
    );
    expect(alert.textContent).toContain(
      "Check the repository path and canonical subpath, then scan again.",
    );
    expect(alert.textContent).not.toContain("PRIVATE");
    expect(alert.textContent).not.toContain("C:/repositories/secret");
    expect(screen.getByRole("button", { name: "Scan repository" }))
      .toBeTruthy();
  });

  test("applies only after review using the exact digest and persists no manifest", async () => {
    const onProjectApplied = vi.fn().mockResolvedValue(undefined);
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse(scanResponse()))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          projectId: "project-imported",
          manifestDigest: digest,
          repositoryFingerprint: "c".repeat(64),
          revisionBefore: 0,
          revisionAfter: 1,
          replayed: false,
        },
      }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={onProjectApplied} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));
    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));
    const apply = await screen.findByRole("button", {
      name: "Apply imported baseline",
    });
    expect(apply.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed this baseline",
    }));
    expect(apply.hasAttribute("disabled")).toBe(false);
    await user.click(apply);

    await waitFor(() => expect(onProjectApplied).toHaveBeenCalledWith(
      "project-imported",
      expect.any(AbortSignal),
    ));
    const request = JSON.parse(fetchStub.mock.calls[1]![1]!.body as string);
    expect(request).toEqual({
      manifest,
      confirmedDigest: digest,
    });
    expect(JSON.stringify(localStorage)).not.toContain(digest);
    expect(JSON.stringify(sessionStorage)).not.toContain(digest);
    expect(location.href).not.toContain(digest);
  });

  test("preserves inspection and guides a rescan for the real import error contract", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(scanResponse()))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "import_rescan_required",
          message: "Repository changed after inspection.",
          recoverable: true,
        },
      }, 409)));
    const user = userEvent.setup();
    render(<ImportProjectScreen onProjectApplied={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "Repository path" }),
      "C:/private/work/intentarc",
    );
    await user.click(screen.getByRole("button", { name: "Scan repository" }));
    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));
    await user.click(await screen.findByRole("checkbox", {
      name: "I reviewed this baseline",
    }));
    await user.click(screen.getByRole("button", {
      name: "Apply imported baseline",
    }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Scan again to review the latest baseline.",
    );
    expect(screen.getByRole("heading", { name: "Apply this baseline" }))
      .toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Apply imported baseline",
    })).toBeTruthy();
  });

  test("ignores abort-insensitive stale scan and apply responses", async () => {
    let resolveFirstScan!: (response: Response) => void;
    let resolveApply!: (response: Response) => void;
    const fetchStub = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveFirstScan = resolve;
      }))
      .mockResolvedValueOnce(jsonResponse({
        manifest: { second: true },
        inspection: {
          ...inspection,
          project: { ...inspection.project, name: "Newer inspection" },
        },
      }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveApply = resolve;
      }));
    vi.stubGlobal("fetch", fetchStub);
    const onProjectApplied = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ImportProjectScreen onProjectApplied={onProjectApplied} />,
    );

    const path = screen.getByRole("textbox", { name: "Repository path" });
    await user.type(path, "C:/first");
    await user.click(screen.getByRole("button", { name: "Scan repository" }));
    fireEvent.change(path, { target: { value: "C:/second" } });
    fireEvent.submit(path.closest("form")!);
    expect(await screen.findByText("Newer inspection")).toBeTruthy();
    resolveFirstScan(jsonResponse(scanResponse()));
    await act(async () => await Promise.resolve());
    expect(screen.queryByText("IntentArc")).toBeNull();

    await user.click(screen.getByRole("button", {
      name: "Continue to confirmation",
    }));
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed this baseline",
    }));
    await user.click(screen.getByRole("button", {
      name: "Apply imported baseline",
    }));
    view.unmount();
    resolveApply(jsonResponse({
      result: {
        projectId: "late-project",
        manifestDigest: digest,
        repositoryFingerprint: "c".repeat(64),
        revisionBefore: 0,
        revisionAfter: 1,
        replayed: false,
      },
    }));
    await act(async () => await Promise.resolve());
    expect(onProjectApplied).not.toHaveBeenCalled();
  });
});

test("App reconciles the authoritative hub before storing and navigating after apply", async () => {
  history.replaceState(null, "", "/projects/import");
  const importedHubProject = {
    project: {
      id: "project-imported",
      name: "IntentArc",
      revision: 1,
      primaryRepositoryPath: "C:/private/work/intentarc",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
    recordsByKind: {},
    currentOutcome: null,
    currentTask: null,
    attention: null,
    pendingProposalCount: 0,
  } satisfies ProjectHubResponse["projects"][number];
  const importedDashboard = {
    ...importedHubProject,
    hierarchyVocabulary: {
      preset: "neutral",
      outcome: "Outcome",
      initiative: "Initiative",
      deliverable: "Deliverable",
      milestone: "Milestone",
      task: "Work item",
      nestedTask: "Subtask",
    },
    hierarchyParentContexts: [],
    currentFocusPath: [],
    recentRecords: [],
  } satisfies ProjectDashboardResponse;
  const fetchStub = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ projects: [] }))
    .mockResolvedValueOnce(jsonResponse(scanResponse()))
    .mockResolvedValueOnce(jsonResponse({
      result: {
        projectId: "project-imported",
        manifestDigest: digest,
        repositoryFingerprint: "c".repeat(64),
        revisionBefore: 0,
        revisionAfter: 1,
        replayed: false,
      },
    }))
    .mockResolvedValueOnce(jsonResponse({ projects: [importedHubProject] }))
    .mockResolvedValueOnce(jsonResponse(importedDashboard));
  vi.stubGlobal("fetch", fetchStub);
  const user = userEvent.setup();

  render(<App />);
  await user.type(
    await screen.findByRole("textbox", { name: "Repository path" }),
    "C:/private/work/intentarc",
  );
  await user.click(screen.getByRole("button", { name: "Scan repository" }));
  await user.click(screen.getByRole("button", {
    name: "Continue to confirmation",
  }));
  await user.click(await screen.findByRole("checkbox", {
    name: "I reviewed this baseline",
  }));
  await user.click(screen.getByRole("button", {
    name: "Apply imported baseline",
  }));

  expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "IntentArc" })).toBeTruthy();
  await waitFor(() => {
    expect(localStorage.getItem(preferenceKeys.activeProject)).toBe(
      "project-imported",
    );
    expect(location.pathname).toBe("/projects/project-imported");
  });
  expect(fetchStub.mock.calls[3]?.[0]).toBe("/api/projects");
  expect(fetchStub.mock.calls[4]?.[0]).toBe(
    "/api/projects/project-imported/dashboard",
  );
});
