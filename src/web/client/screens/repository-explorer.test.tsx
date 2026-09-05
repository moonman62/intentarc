// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectedRepositoryDetailResponse,
  RepositoryExplorerResponse,
} from "../../contracts.js";
import { RepositorySelectionProvider } from "../components/repository-selection.js";
import { useRepositorySelection } from "../components/repository-selection.js";
import { RepositoryExplorer } from "./repository-explorer.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const node = (
  nodeId: string,
  path: string,
  kind: "directory" | "file",
  parentNodeId: string | null = null,
  overrides: Partial<RepositoryExplorerResponse["items"][number]> = {},
): RepositoryExplorerResponse["items"][number] => ({
  nodeId,
  parentNodeId,
  path,
  kind,
  role: kind === "directory" ? "canonical_source" : "supporting_document",
  documentKind: kind === "file" ? "overview" : null,
  documentFormat: kind === "file" ? "markdown" : null,
  sourceStatus: "tracked",
  state: "current",
  contentEligible: kind === "file",
  childCount: kind === "directory" ? 1 : 0,
  changed: false,
  linked: kind === "file",
  currentTaskRelevant: false,
  contextIncluded: false,
  ...overrides,
});

const page = (
  items: RepositoryExplorerResponse["items"],
  overrides: Partial<RepositoryExplorerResponse> = {},
): RepositoryExplorerResponse => ({
  projectId: "project-one",
  snapshotId: "snapshot-one",
  parentNodeId: null,
  sourceStatus: "available",
  request: { parentNodeId: null, pageSize: 200, filter: {} },
  items,
  exclusions: [],
  hasMore: false,
  nextCursor: null,
  ...overrides,
});

const detail = (nodeId: string, path: string): ConnectedRepositoryDetailResponse => ({
  projectId: "project-one",
  snapshotId: "snapshot-one",
  node: {
    nodeId,
    parentNodeId: null,
    path,
    kind: "file",
    role: "supporting_document",
    documentKind: "overview",
    documentFormat: "markdown",
    contentEligible: true,
  },
  linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
});

const deepDirectoryName = (depth: number): RegExp => new RegExp(
  `Directory: deep/${String(depth).padStart(3, "0")}`,
);

const getDeepDirectory = (depth: number): HTMLElement => {
  const label = screen.getByText(`Directory: deep/${String(depth).padStart(3, "0")}`);
  const treeItem = label.closest<HTMLElement>("[role=treeitem]");
  if (treeItem === null) throw new Error(`Deep directory ${depth} is not rendered as a tree item.`);
  return treeItem;
};

const deepChainFetch = (maximumDepth: number) => vi.fn((request: string | URL | Request) => {
  const url = new URL(typeof request === "string" ? request : request.toString(), "https://intentarc.local");
  const parentNodeId = url.searchParams.get("parentNodeId");
  const depth = parentNodeId === null ? 0 : Number(parentNodeId.replace("directory-", "")) + 1;
  const items = depth > maximumDepth
    ? []
    : [node(
        `directory-${String(depth).padStart(3, "0")}`,
        `deep/${String(depth).padStart(3, "0")}`,
        "directory",
        parentNodeId,
        { childCount: depth < maximumDepth ? 1 : 0 },
      )];
  return Promise.resolve(json(page(items, {
    parentNodeId,
    request: { parentNodeId, pageSize: 200, filter: {} },
  })));
});

const focusDeepDirectory = async (targetDepth: number): Promise<HTMLElement> => {
  let current = await screen.findByRole("treeitem", { name: deepDirectoryName(0) });
  current.focus();
  for (let depth = 1; depth <= targetDepth; depth += 1) {
    fireEvent.keyDown(current, { key: "ArrowRight" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const next = getDeepDirectory(depth);
    next.focus();
    await act(async () => undefined);
    expect(getDeepDirectory(depth)).toBe(document.activeElement);
    current = getDeepDirectory(depth);
  }
  return current;
};

const renderExplorer = (overrides: Partial<React.ComponentProps<typeof RepositoryExplorer>> = {}) => {
  const onSelectNode = vi.fn();
  const view = render(
    <RepositorySelectionProvider>
      <RepositoryExplorer
        projectId="project-one"
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        {...overrides}
      />
    </RepositorySelectionProvider>,
  );
  return { ...view, onSelectNode };
};

function SelectionProbe() {
  const selection = useRepositorySelection();
  return <output aria-label="Shared repository node">{selection.nodeId ?? "none"}</output>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

describe("RepositoryExplorer", () => {
  test("puts search and repository results before common and closed advanced filters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([
      node("file-readme", "README.md", "file"),
    ]))));
    const user = userEvent.setup();
    renderExplorer();

    const tree = await screen.findByRole("tree", { name: "Repository files" });
    expect(screen.queryByText("Browse accepted repository metadata without reading or changing repository files."))
      .toBeNull();
    const search = screen.getByRole("searchbox", { name: "Search repository" });
    const common = screen.getByRole("form", { name: "Common repository filters" });
    const advanced = screen.getByText("Advanced filters").closest("details");
    expect(search.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tree.compareDocumentPosition(common) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(common.compareDocumentPosition(advanced!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Current task only" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();

    await user.click(screen.getByText("Advanced filters"));
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
  });

  test("fetches only roots initially, expands one directory, and paginates that branch", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("parentNodeId=directory-src") && path.includes("cursor=next-src")) {
        return Promise.resolve(json(page([
          node("file-app", "src/app.ts", "file", "directory-src"),
          node("file-utils", "src/utils.ts", "file", "directory-src"),
        ], {
          parentNodeId: "directory-src",
          request: { parentNodeId: "directory-src", pageSize: 200, filter: {} },
        })));
      }
      if (path.includes("parentNodeId=directory-src")) {
        return Promise.resolve(json(page([
          node("file-app", "src/app.ts", "file", "directory-src"),
        ], {
          parentNodeId: "directory-src",
          request: { parentNodeId: "directory-src", pageSize: 200, filter: {} },
          hasMore: true,
          nextCursor: "next-src",
        })));
      }
      expect(path).toBe("/api/projects/project-one/repository/tree?pageSize=200");
      return Promise.resolve(json(page([
        node("directory-src", "src", "directory"),
        node("file-readme", "README.md", "file"),
      ])));
    });
    vi.stubGlobal("fetch", fetchStub);

    renderExplorer();

    const sourceDirectory = await screen.findByRole("treeitem", { name: /src/ });
    expect(sourceDirectory).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("treeitem", { name: /src\/app\.ts/ })).toBeNull();

    sourceDirectory.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("treeitem", { name: /src\/app\.ts/ })).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Load more in src" }));
    expect(await screen.findByRole("treeitem", { name: /src\/utils\.ts/ })).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(within(screen.getByRole("tree", { name: "Repository files" })).getAllByRole("treeitem"))
      .toHaveLength(4);
    await waitFor(() => expect(screen.getByText("Showing 4 of 4 loaded nodes.")).toBeTruthy());
  });

  test("serializes every approved filter and synchronously invalidates old pages", async () => {
    let resolveFiltered!: (response: Response) => void;
    const filteredResponse = new Promise<Response>((resolve) => {
      resolveFiltered = resolve;
    });
    const requests: Array<{ path: string; signal?: AbortSignal }> = [];
    const fetchStub = vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request.toString();
      requests.push({ path, ...(init?.signal ? { signal: init.signal } : {}) });
      if (path.includes("exclusionReason=ignored")) return filteredResponse;
      if (path !== "/api/projects/project-one/repository/tree?pageSize=200") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(json(page([node("old-node", "old.md", "file")])));
    });
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderExplorer();
    expect(await screen.findByRole("treeitem", { name: /old\.md/ })).toBeTruthy();

    await user.type(screen.getByRole("searchbox", { name: "Search repository" }), "docs");
    await user.click(screen.getByRole("checkbox", { name: "Current task only" }));
    await user.click(screen.getByRole("checkbox", { name: "Changed in latest refresh" }));
    await user.click(screen.getByText("Advanced filters"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "documentation");
    await user.selectOptions(screen.getByRole("combobox", { name: "Document kind" }), "overview");
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "supporting_document");
    await user.click(screen.getByRole("checkbox", { name: "Unlinked only" }));
    await user.click(screen.getByRole("checkbox", { name: "Included in current context" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "State" }), "excluded");
    await user.selectOptions(screen.getByRole("combobox", { name: "Exclusion reason" }), "ignored");

    expect(screen.queryByRole("treeitem", { name: /old\.md/ })).toBeNull();
    const finalRequest = requests.at(-1)!;
    const query = new URL(finalRequest.path, "http://intentarc.local").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      pageSize: "200",
      search: "docs",
      relevance: "current_task",
      changed: "true",
      category: "documentation",
      documentKind: "overview",
      role: "supporting_document",
      unlinked: "true",
      contextIncluded: "true",
      state: "excluded",
      exclusionReason: "ignored",
    });
    expect(requests.slice(1, -1).some(({ signal }) => signal?.aborted)).toBe(true);

    resolveFiltered(json(page([], {
      exclusions: [{ reason: "ignored", count: 42 }],
      request: {
        parentNodeId: null,
        pageSize: 200,
        filter: {
          search: "docs",
          relevance: "current_task",
          changed: true,
          category: "documentation",
          documentKind: "overview",
          role: "supporting_document",
          unlinked: true,
          contextIncluded: true,
          state: "excluded",
          exclusionReason: "ignored",
        },
      },
    })));
    expect(await screen.findByText("42 ignored entries are excluded.")).toBeTruthy();
    expect(screen.getByText("No repository nodes match these filters.")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "current" } });
    await waitFor(() => {
      const nextQuery = new URL(requests.at(-1)!.path, "http://intentarc.local").searchParams;
      expect(nextQuery.has("exclusionReason")).toBe(false);
    });
  });

  test("restores URL selection, labels repository facts, and exposes only capability links", async () => {
    const selected = node("file-readme", "README.md", "file", null, {
      state: "stale",
      changed: true,
      linked: true,
      currentTaskRelevant: true,
      contextIncluded: true,
      sourceStatus: "untracked",
    });
    const connected: ConnectedRepositoryDetailResponse = {
      ...detail(selected.nodeId, selected.path),
      linksByBasis: {
        accepted: [{
          linkId: "link-task",
          kind: "documents",
          label: "Documents",
          basis: "accepted",
          record: { id: "task-one", kind: "task", status: "active", title: "Ship Explorer", revision: 4 },
          node: null,
        }],
        observed: [{
          linkId: "link-guide",
          kind: "references",
          label: "References",
          basis: "observed",
          record: null,
          node: {
            nodeId: "file-guide",
            parentNodeId: "directory-docs",
            path: "docs/guide.md",
            kind: "file",
            role: "supporting_document",
            documentKind: "operational_guide",
            documentFormat: "markdown",
            contentEligible: true,
          },
        }],
        inferred: [],
        conflicting: [],
      },
    };
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/repository/nodes/file-readme/connected-detail")) {
        return Promise.resolve(json(connected));
      }
      return Promise.resolve(json(page([selected], { sourceStatus: "detached" })));
    });
    vi.stubGlobal("fetch", fetchStub);

    render(
      <RepositorySelectionProvider>
        <RepositoryExplorer
          projectId="project-one"
          selectedNodeId="file-readme"
          onSelectNode={vi.fn()}
        />
        <SelectionProbe />
      </RepositorySelectionProvider>,
    );

    const item = await screen.findByRole("treeitem", { name: /README\.md/ });
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(item.textContent).toContain("stale");
    expect(item.textContent).toContain("changed");
    expect(item.textContent).toContain("current task");
    expect(item.textContent).toContain("current context");
    expect(item.textContent).toContain("untracked");
    expect(screen.getByText("Accepted index · repository detached")).toBeTruthy();
    expect(screen.getByLabelText("Shared repository node").textContent).toBe("file-readme");

    const documentation = await screen.findByRole("link", { name: "Open README.md in Documentation" });
    expect(documentation.getAttribute("href")).toBe("/projects/project-one/documentation/file-readme");
    const map = screen.getByRole("link", { name: "Focus Ship Explorer in Map" });
    expect(map.getAttribute("href")).toBe("/projects/project-one/map?focusRecordId=task-one");
    expect(screen.getByRole("navigation", { name: "Repository project path" }).textContent)
      .toBe("Project project-oneRepositoryREADME.md");
    expect(screen.getByRole("heading", { name: "Accepted intent connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Observed repository evidence" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open docs/guide.md in Repository" }).getAttribute("href"))
      .toBe("/projects/project-one/repository?nodeId=file-guide");
    expect(fetchStub.mock.calls.map(([request]) => String(request)).sort()).toEqual([
      "/api/projects/project-one/repository/nodes/file-readme/connected-detail",
      "/api/projects/project-one/repository/tree?pageSize=200",
    ].sort());
  });

  test("keeps a bounded DOM window around keyboard focus and repairs focus on collapse", async () => {
    const user = userEvent.setup();
    const roots = [
      node("directory-src", "src", "directory"),
      ...Array.from({ length: 139 }, (_, index) => node(
        `file-${String(index).padStart(3, "0")}`,
        `files/${String(index).padStart(3, "0")}.txt`,
        "file",
      )),
    ];
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      return Promise.resolve(json(path.includes("parentNodeId=directory-src")
        ? page([node("child-index", "src/index.ts", "file", "directory-src")], {
            parentNodeId: "directory-src",
            request: { parentNodeId: "directory-src", pageSize: 200, filter: {} },
          })
        : page(roots)));
    }));
    renderExplorer();

    const source = await screen.findByRole("treeitem", { name: /Directory: src/ });
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(80));
    expect(screen.getByText("Showing 80 of 140 loaded nodes.")).toBeTruthy();

    source.focus();
    await user.keyboard("{End}");
    const last = await screen.findByRole("treeitem", { name: /files\/138\.txt/ });
    expect(document.activeElement).toBe(last);
    expect(screen.queryByRole("treeitem", { name: /Directory: src/ })).toBeNull();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(80);

    await user.keyboard("{Home}");
    const restoredSource = await screen.findByRole("treeitem", { name: /Directory: src/ });
    expect(document.activeElement).toBe(restoredSource);
    await user.keyboard("{ArrowRight}");
    const child = await screen.findByRole("treeitem", { name: /src\/index\.ts/ });
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(child);
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(document.activeElement).toBe(restoredSource));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(restoredSource);
    expect(restoredSource.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /src\/index\.ts/ })).toBeNull();
  });

  test("retries an explicit load failure and explains an unavailable empty index without polling", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json({
          error: { code: "VALIDATION_FAILED", message: "Repository cursor is stale.", recoverable: true },
        }, 409));
      }
      return Promise.resolve(json(page([], {
        snapshotId: null,
        sourceStatus: "unavailable",
      })));
    }));
    renderExplorer();

    expect((await screen.findByRole("alert")).textContent).toContain("Repository cursor is stale.");
    expect(calls).toBe(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Repository unavailable" })).toBeTruthy();
    expect(screen.getByText("The registered repository cannot be reached.")).toBeTruthy();
    expect(calls).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
  });

  test("keeps adversarial path, identifier, title, and link-label tails out of rendered layout", async () => {
    const longPath = `docs/${"UnbrokenPath".repeat(20)}TAIL-PATH-SENTINEL.md`;
    const longId = `record-${"UnbrokenIdentifier".repeat(12)}TAIL-ID-SENTINEL`;
    const longTitle = `${"UnbrokenTitle".repeat(20)}TAIL-TITLE-SENTINEL`;
    const longLabel = `${"UnbrokenLabel".repeat(20)}TAIL-LABEL-SENTINEL`;
    const selected = node("file-long", longPath, "file");
    const connected: ConnectedRepositoryDetailResponse = {
      ...detail(selected.nodeId, selected.path),
      linksByBasis: {
        accepted: [{
          linkId: "link-long",
          kind: "documents",
          label: longLabel,
          basis: "accepted",
          record: { id: longId, kind: "task", status: "active", title: longTitle, revision: 1 },
          node: null,
        }],
        observed: [], inferred: [], conflicting: [],
      },
    };
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => Promise.resolve(json(
      String(request).endsWith("/connected-detail") ? connected : page([selected]),
    ))));
    const { container } = renderExplorer({ selectedNodeId: selected.nodeId });

    await screen.findByRole("region", { name: "Selected repository node" });
    expect(container.textContent).not.toContain("TAIL-PATH-SENTINEL");
    expect(container.textContent).not.toContain("TAIL-ID-SENTINEL");
    expect(container.textContent).not.toContain("TAIL-TITLE-SENTINEL");
    expect(container.textContent).not.toContain("TAIL-LABEL-SENTINEL");
    expect(container.innerHTML).not.toContain(longPath);
  });

  test("preserves literal governed-detail wording in structured repository metadata", async () => {
    const phrase = "Retrieve this governed detail separately.";
    const path = `${phrase} ${phrase}.md`;
    const selected = node("file-literal", path, "file");
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => Promise.resolve(json(
      String(request).endsWith("/connected-detail") ? detail(selected.nodeId, path) : page([selected]),
    ))));
    renderExplorer({ selectedNodeId: selected.nodeId });

    await screen.findByRole("region", { name: "Selected repository node" });
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(path);
    expect(screen.getByRole("treeitem").textContent).toContain(`${phrase} ${phrase}`);
  });

  test("shows recovery instead of repository controls before an accepted snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([], {
      snapshotId: null,
      sourceStatus: "unavailable",
    }))));
    renderExplorer();

    expect(await screen.findByRole("heading", { name: "Repository unavailable" })).toBeTruthy();
    const recovery = screen.getByRole("link", { name: "Locate repository" });
    expect(recovery.getAttribute("href")).toBe("/projects/project-one/repository/refresh");
    expect(screen.queryByRole("form", { name: "Repository filters" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Current task only" })).toBeNull();
  });

  test.each([
    ["detached", "Attach repository", "/projects/project-one/repository/refresh"],
    ["available", "Review repository refresh", "/projects/project-one/repository/refresh"],
  ] as const)("uses %s source state for the %s recovery action", async (sourceStatus, action, href) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([], {
      snapshotId: null,
      sourceStatus,
    }))));
    renderExplorer();

    expect(await screen.findByRole("heading", { name: "Repository unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: action }).getAttribute("href")).toBe(href);
  });

  test("keeps the tree and filters available when an accepted snapshot is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([
      node("file-readme", "README.md", "file"),
    ]))));
    renderExplorer();

    expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Common repository filters" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Current task only" })).toBeTruthy();
  });

  test("labels a persisted unavailable accepted index and filters its unavailable nodes", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      requests.push(path);
      const state = new URL(path, "https://intentarc.local").searchParams.get("state");
      return Promise.resolve(json(page([
        node("file-readme", "README.md", "file", null, { state: "unavailable" }),
      ], {
        sourceStatus: "unavailable",
        request: {
          parentNodeId: null,
          pageSize: 200,
          filter: state === "unavailable" ? { state: "unavailable" } : {},
        },
      })));
    }));
    const user = userEvent.setup();
    renderExplorer();

    expect(await screen.findByText("Accepted index · repository unavailable")).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /README\.md.*unavailable/i })).toBeTruthy();
    await user.click(screen.getByText("Advanced filters"));
    await user.selectOptions(screen.getByRole("combobox", { name: "State" }), "unavailable");
    await waitFor(() => expect(
      new URL(requests.at(-1)!, "https://intentarc.local").searchParams.get("state"),
    ).toBe("unavailable"));
    expect(screen.getByRole("treeitem", { name: /README\.md.*unavailable/i })).toBeTruthy();
  });

  test("rejects a page whose nodes are not bound to the requested parent", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(page([
      node("foreign-node", "foreign.md", "file", "another-parent"),
    ])))));
    renderExplorer();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository page did not match the requested branch.",
    );
    expect(screen.queryByRole("treeitem", { name: /foreign\.md/ })).toBeNull();
  });

  test("namespaces branch state and retains loaded children while a stale cursor is retried", async () => {
    const user = userEvent.setup();
    let continuationCalls = 0;
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (!path.includes("parentNodeId=__root__")) {
        return Promise.resolve(json(page([node("__root__", "collision-safe", "directory")])));
      }
      if (!path.includes("cursor=next-collision")) {
        return Promise.resolve(json(page([
          node("loaded-child", "collision-safe/loaded.ts", "file", "__root__"),
        ], {
          parentNodeId: "__root__",
          request: { parentNodeId: "__root__", pageSize: 200, filter: {} },
          hasMore: true,
          nextCursor: "next-collision",
        })));
      }
      continuationCalls += 1;
      if (continuationCalls === 1) {
        return Promise.resolve(json({
          error: { code: "VALIDATION_FAILED", message: "Repository Explorer cursor is stale", recoverable: true },
        }, 409));
      }
      return Promise.resolve(json(page([
        node("new-child", "collision-safe/new.ts", "file", "__root__"),
      ], {
        parentNodeId: "__root__",
        request: { parentNodeId: "__root__", pageSize: 200, filter: {} },
      })));
    }));
    renderExplorer();
    const directory = await screen.findByRole("treeitem", { name: /collision-safe/ });
    directory.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("treeitem", { name: /loaded\.ts/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more in collision-safe" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cursor is stale");
    expect(screen.getByRole("treeitem", { name: /loaded\.ts/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try loading collision-safe again" }));
    expect(screen.getByRole("treeitem", { name: /loaded\.ts/ })).toBeTruthy();
    expect(await screen.findByRole("treeitem", { name: /new\.ts/ })).toBeTruthy();
  });

  test("suppresses capability links when selected metadata is from another snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.endsWith("/connected-detail")) {
        return Promise.resolve(json({
          ...detail("file-readme", "README.md"),
          snapshotId: "different-snapshot",
        }));
      }
      return Promise.resolve(json(page([node("file-readme", "README.md", "file")])));
    }));
    renderExplorer({ selectedNodeId: "file-readme" });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Selected node metadata no longer matches the accepted index.",
    );
    expect(screen.queryByRole("link", { name: /Documentation/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Map/ })).toBeNull();
  });

  test("rejects child pages that drift from the displayed root snapshot", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("parentNodeId=directory-src")) {
        return Promise.resolve(json(page([
          node("foreign-child", "src/future.ts", "file", "directory-src"),
        ], {
          snapshotId: "snapshot-two",
          sourceStatus: "unavailable",
          parentNodeId: "directory-src",
          request: { parentNodeId: "directory-src", pageSize: 200, filter: {} },
        })));
      }
      return Promise.resolve(json(page([node("directory-src", "src", "directory")])));
    }));
    renderExplorer();
    const directory = await screen.findByRole("treeitem", { name: /Directory: src/ });
    directory.focus();
    await user.keyboard("{ArrowRight}");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository branch no longer matches the displayed accepted index.",
    );
    expect(screen.queryByRole("treeitem", { name: /future\.ts/ })).toBeNull();
  });

  test("rejects root pages whose echoed filters do not match the canonical request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("changed=true")) {
        return Promise.resolve(json(page([node("foreign-root", "foreign.md", "file")], {
          request: { parentNodeId: null, pageSize: 200, filter: {} },
        })));
      }
      return Promise.resolve(json(page([])));
    }));
    renderExplorer();
    await screen.findByText("No accepted repository nodes are available.");
    await user.click(screen.getByRole("checkbox", { name: "Changed in latest refresh" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository page did not match the requested filters.",
    );
    expect(screen.queryByRole("treeitem", { name: /foreign\.md/ })).toBeNull();
  });

  test("rejects child pages whose echoed filters do not match the canonical request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("parentNodeId=directory-src")) {
        return Promise.resolve(json(page([
          node("foreign-child", "src/foreign.ts", "file", "directory-src"),
        ], {
          parentNodeId: "directory-src",
          request: { parentNodeId: "directory-src", pageSize: 200, filter: { changed: true } },
        })));
      }
      return Promise.resolve(json(page([node("directory-src", "src", "directory")])));
    }));
    renderExplorer();
    const directory = await screen.findByRole("treeitem", { name: /Directory: src/ });
    directory.focus();
    await user.keyboard("{ArrowRight}");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository page did not match the requested filters.",
    );
    expect(screen.queryByRole("treeitem", { name: /foreign\.ts/ })).toBeNull();
  });

  test("rejects root continuations whose echoed filters do not match the canonical request", async () => {
    const user = userEvent.setup();
    const firstRoot = node("root-one", "one.md", "file");
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("cursor=next-roots")) {
        return Promise.resolve(json(page([node("foreign-root", "foreign.md", "file")], {
          request: { parentNodeId: null, pageSize: 200, filter: { changed: true } },
        })));
      }
      return Promise.resolve(json(page([firstRoot], { hasMore: true, nextCursor: "next-roots" })));
    }));
    renderExplorer();
    await screen.findByRole("treeitem", { name: /one\.md/ });
    await user.click(screen.getByRole("button", { name: "Load more repository roots" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository page did not match the requested filters.",
    );
    expect(screen.getByRole("treeitem", { name: /one\.md/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /foreign\.md/ })).toBeNull();
  });

  test("rejects root continuations that drift from the displayed accepted index", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (path.includes("cursor=next-roots")) {
        return Promise.resolve(json(page([node("future-root", "future.md", "file")], {
          snapshotId: "snapshot-two",
          sourceStatus: "detached",
        })));
      }
      return Promise.resolve(json(page([node("root-one", "one.md", "file")], {
        hasMore: true,
        nextCursor: "next-roots",
      })));
    }));
    renderExplorer();
    await screen.findByRole("treeitem", { name: /one\.md/ });
    await user.click(screen.getByRole("button", { name: "Load more repository roots" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository branch no longer matches the displayed accepted index.",
    );
    expect(screen.getByRole("treeitem", { name: /one\.md/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /future\.md/ })).toBeNull();
  });

  test("exposes full loaded sibling positions while virtualizing a large root branch", async () => {
    const user = userEvent.setup();
    const roots = Array.from({ length: 140 }, (_, index) => node(
      `root-${String(index).padStart(3, "0")}`,
      `root-${String(index).padStart(3, "0")}.txt`,
      "file",
    ));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(page(roots)))));
    renderExplorer();

    const first = await screen.findByRole("treeitem", { name: /root-000\.txt/ });
    expect(first.getAttribute("aria-posinset")).toBe("1");
    expect(first.getAttribute("aria-setsize")).toBe("140");
    first.focus();
    await user.keyboard("{End}");

    const last = await screen.findByRole("treeitem", { name: /root-139\.txt/ });
    expect(last.getAttribute("aria-posinset")).toBe("140");
    expect(last.getAttribute("aria-setsize")).toBe("140");
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(80);
  });

  test("keeps ancestor context in a bounded virtual slice of a large nested branch", async () => {
    const user = userEvent.setup();
    const children = Array.from({ length: 120 }, (_, index) => node(
      `child-${String(index).padStart(3, "0")}`,
      `src/child-${String(index).padStart(3, "0")}.ts`,
      "file",
      "directory-src",
    ));
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      return Promise.resolve(json(path.includes("parentNodeId=directory-src")
        ? page(children, {
            parentNodeId: "directory-src",
            request: { parentNodeId: "directory-src", pageSize: 200, filter: {} },
          })
        : page([node("directory-src", "src", "directory")])));
    }));
    renderExplorer();
    const directory = await screen.findByRole("treeitem", { name: /Directory: src/ });
    directory.focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("treeitem", { name: /child-000\.ts/ });
    await user.keyboard("{End}");

    const lastChild = await screen.findByRole("treeitem", { name: /child-119\.ts/ });
    expect(lastChild.getAttribute("aria-posinset")).toBe("120");
    expect(lastChild.getAttribute("aria-setsize")).toBe("120");
    expect(screen.getByRole("treeitem", { name: /Directory: src/ })).toBeTruthy();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(80);
  });

  test("keeps the nearest contiguous ancestor context around focus near depth 100", async () => {
    vi.stubGlobal("fetch", deepChainFetch(100));
    renderExplorer();

    const active = await focusDeepDirectory(100);
    const levels = screen.getAllByRole("treeitem").map((item) => Number(item.getAttribute("aria-level")));
    expect(levels).toEqual(Array.from({ length: 80 }, (_, index) => index + 22));
    expect(active.getAttribute("aria-level")).toBe("101");
    expect(document.activeElement).toBe(active);

    fireEvent.keyDown(active, { key: "ArrowLeft" });
    const parent = await screen.findByRole("treeitem", { name: deepDirectoryName(99) });
    await waitFor(() => expect(document.activeElement).toBe(parent));
  }, 30_000);

  test("keeps the active node rendered and keyboard-operable beyond depth 200", async () => {
    vi.stubGlobal("fetch", deepChainFetch(220));
    renderExplorer();

    const active = await focusDeepDirectory(220);
    expect(screen.getAllByRole("treeitem")).toHaveLength(80);
    expect(active.getAttribute("aria-level")).toBe("221");
    expect(document.activeElement).toBe(active);

    fireEvent.keyDown(active, { key: "ArrowLeft" });
    const parent = await screen.findByRole("treeitem", { name: deepDirectoryName(219) });
    await waitFor(() => expect(document.activeElement).toBe(parent));
    fireEvent.keyDown(parent, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("treeitem", { name: deepDirectoryName(220) }),
    ));
  }, 30_000);

  test("announces an expanded directory whose accepted branch is empty", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      return Promise.resolve(json(path.includes("parentNodeId=directory-empty")
        ? page([], {
            parentNodeId: "directory-empty",
            request: { parentNodeId: "directory-empty", pageSize: 200, filter: {} },
          })
        : page([node("directory-empty", "empty", "directory")])));
    }));
    renderExplorer();
    const directory = await screen.findByRole("treeitem", { name: /Directory: empty/ });
    directory.focus();
    await user.keyboard("{ArrowRight}");

    const emptyState = await screen.findByText("empty is empty in this accepted view.");
    expect(emptyState.getAttribute("role")).toBe("status");
  });

  test("paginates more than 200 roots and retains them across same-cursor retry", async () => {
    const user = userEvent.setup();
    const roots = Array.from({ length: 200 }, (_, index) => node(
      `root-${String(index).padStart(3, "0")}`,
      `root-${String(index).padStart(3, "0")}.txt`,
      "file",
    ));
    let continuationCalls = 0;
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request.toString();
      if (!path.includes("cursor=next-roots")) {
        return Promise.resolve(json(page(roots, { hasMore: true, nextCursor: "next-roots" })));
      }
      continuationCalls += 1;
      if (continuationCalls === 1) {
        return Promise.resolve(json({
          error: { code: "VALIDATION_FAILED", message: "Root cursor is stale.", recoverable: true },
        }, 409));
      }
      return Promise.resolve(json(page([
        roots[199]!,
        node("root-200", "root-200.txt", "file"),
      ])));
    });
    vi.stubGlobal("fetch", fetchStub);
    renderExplorer();

    expect(await screen.findByText("Showing 80 of 200 loaded nodes.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more repository roots" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Root cursor is stale.");
    expect(screen.getByText("Showing 80 of 200 loaded nodes.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try loading more roots again" }));
    expect(await screen.findByText("Showing 80 of 201 loaded nodes.")).toBeTruthy();
    expect(fetchStub.mock.calls.filter(([request]) => String(request).includes("cursor=next-roots")))
      .toHaveLength(2);
  });
});
