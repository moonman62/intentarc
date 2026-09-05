// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentDetailResponse, DocumentRegistryResponse } from "../../contracts.js";
import type { DesktopDocumentsApi } from "../desktop-api.js";
import { Documentation } from "./documentation.js";

const documentEntry = (
  nodeId: string,
  path: string,
  overrides: Partial<DocumentRegistryResponse["documents"][number]> = {},
): DocumentRegistryResponse["documents"][number] => ({
  projectId: "project-one",
  snapshotId: "snapshot-one",
  nodeId,
  path,
  documentKind: "overview",
  documentFormat: "markdown",
  role: "supporting_document",
  freshness: "current",
  contentEligible: true,
  instructionClient: null,
  instructionScope: null,
  links: [],
  ...overrides,
});

const registry = (documents: DocumentRegistryResponse["documents"]): DocumentRegistryResponse => ({
  projectId: documents[0]?.projectId ?? "project-one",
  snapshotId: documents[0]?.snapshotId ?? "snapshot-one",
  documents,
  facets: {
    documentKinds: [{ value: "overview", count: 1 }],
    formats: [{ value: "markdown", count: 1 }],
    roles: [{ value: "supporting_document", count: 1 }],
    freshness: [{ value: "current", count: 1 }],
  },
});

const detail = (
  document: DocumentRegistryResponse["documents"][number],
  overrides: Partial<DocumentDetailResponse> = {},
): DocumentDetailResponse => ({
  document,
  linksByBasis: { accepted: [], observed: [], inferred: [], conflicting: [] },
  nativeCapability: document.documentFormat === "markdown" || document.documentFormat === "plain_text"
    ? "renderable"
    : document.documentFormat === "image" || document.documentFormat === "pdf"
      ? "previewable"
      : "unsupported",
  externalOpenEligible: true,
  externalOpenAvailable: false,
  ...overrides,
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const desktopDocuments = (): DesktopDocumentsApi => ({
  externalOpenAvailable: true,
  openRepositoryFile: vi.fn(async () => ({ opened: true as const })),
  openExternalHttps: vi.fn(async () => ({ opened: true as const })),
});

interface LayoutSnapshot {
  readonly text: string;
  readonly imageCount: number;
  readonly externalOpenCount: number;
  readonly revokedObjectUrlCount: number;
}

function DocumentationLayoutProbe({
  projectId,
  selectedNodeId,
  desktop,
  onLayout,
}: {
  readonly projectId: string;
  readonly selectedNodeId: string | null;
  readonly desktop?: DesktopDocumentsApi;
  readonly onLayout: (snapshot: LayoutSnapshot) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current!;
    onLayout({
      text: root.textContent ?? "",
      imageCount: root.querySelectorAll("img, iframe").length,
      externalOpenCount: [...root.querySelectorAll("button")].filter(
        (button) => button.textContent === "Open externally",
      ).length,
      revokedObjectUrlCount: vi.mocked(URL.revokeObjectURL).mock.calls.length,
    });
  }, [onLayout, projectId, selectedNodeId]);
  return (
    <div ref={rootRef}>
      <Documentation
        projectId={projectId}
        selectedNodeId={selectedNodeId}
        {...(desktop === undefined ? {} : { desktopDocuments: desktop })}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:intentarc-preview"),
    revokeObjectURL: vi.fn(),
  });
});

describe("Documentation", () => {
  test("offers an explicit repository refresh from accepted documentation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(registry([]))));
    render(<Documentation projectId="project-one" selectedNodeId={null} />);

    expect((await screen.findByRole("link", { name: "Review repository refresh" }))
      .getAttribute("href")).toBe("/projects/project-one/repository/refresh");
    expect(screen.queryByText("Read the last accepted repository observation without changing repository files."))
      .toBeNull();
  });

  test("rejects a registry that is foreign to the route or mixes accepted snapshots", async () => {
    const entry = documentEntry("node-readme", "README.md");
    const foreign = registry([{ ...entry, projectId: "project-two" }]);
    const mixed = registry([entry, { ...entry, nodeId: "node-guide", snapshotId: "snapshot-two" }]);

    for (const response of [foreign, mixed]) {
      cleanup();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(response)));
      render(<Documentation projectId="project-one" selectedNodeId={null} />);

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Documentation response did not match this project",
      );
      expect(screen.queryByRole("button", { name: /README\.md/ })).toBeNull();
    }
  });

  test.each([
    ["foreign project", { projectId: "project-two" }],
    ["foreign snapshot", { snapshotId: "snapshot-two" }],
    ["foreign node", { nodeId: "node-other" }],
  ])("fails closed for a %s document detail before reading content", async (_name, mismatch) => {
    const entry = documentEntry("node-readme", "README.md");
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = String(request);
      if (path.endsWith("/documents")) return Promise.resolve(json(registry([entry])));
      if (path.endsWith("/documents/node-readme")) {
        return Promise.resolve(json(detail({ ...entry, ...mismatch })));
      }
      return Promise.resolve(json({
        format: "markdown",
        text: "FOREIGN-CONTENT-SENTINEL",
        sha256: "a".repeat(64),
      }));
    });
    vi.stubGlobal("fetch", fetchStub);
    render(<Documentation projectId="project-one" selectedNodeId="node-readme" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Document detail did not match the accepted project snapshot",
    );
    expect(screen.queryByText("FOREIGN-CONTENT-SENTINEL")).toBeNull();
    expect(fetchStub.mock.calls.some(([request]) => String(request).endsWith("/content"))).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Document project path" })).toBeNull();
  });

  test("keeps search and the document preview outside closed advanced filters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(registry([]))));
    render(<Documentation projectId="project-one" selectedNodeId={null} />);

    await screen.findByText("No repository documentation matches these filters.");
    const advanced = screen.getByText("Advanced filters").closest("details");
    const registryRegion = screen.getByRole("region", { name: "Repository documents" });
    const preview = screen.getByRole("region", { name: "Document preview" });
    expect(advanced).not.toBeNull();
    expect(advanced?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("searchbox", { name: "Search documentation" }).closest("details")).toBeNull();
    expect(screen.getByRole("region", { name: "Document preview" }).closest("details")).toBeNull();
    expect(registryRegion.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(advanced!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();

    await userEvent.setup().click(screen.getByText("Advanced filters"));
    expect(screen.getByRole("combobox", { name: "Role" }).closest("details")).toBe(advanced);
  });

  test("shows loading, retryable failure, and empty registry states", async () => {
    let rejectLoad!: (reason: Error) => void;
    const pending = new Promise<Response>((_resolve, reject) => { rejectLoad = reject; });
    const fetchStub = vi.fn().mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetchStub);
    const { rerender } = render(<Documentation projectId="project-one" selectedNodeId={null} />);

    expect(screen.getByText("Loading documentation…")).toBeTruthy();
    rejectLoad(new Error("Archive unavailable"));
    expect((await screen.findByRole("alert")).textContent).toContain("Archive unavailable");

    fetchStub.mockResolvedValueOnce(json(registry([])));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No repository documentation matches these filters.")).toBeTruthy();

    rerender(<Documentation projectId="another-project" selectedNodeId={null} />);
    expect(screen.getByText("Loading documentation…")).toBeTruthy();
  });

  test("sends all approved filters while keeping them in local controls", async () => {
    const fetchStub = vi.fn().mockResolvedValue(json(registry([])));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    render(<Documentation projectId="project-one" selectedNodeId={null} />);
    await screen.findByText("No repository documentation matches these filters.");

    await user.type(screen.getByRole("searchbox", { name: "Search documentation" }), "docs");
    await user.click(screen.getByText("Advanced filters"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "supporting_document");
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "markdown");
    await user.type(screen.getByRole("textbox", { name: "Linked record ID" }), "task-one");
    await user.selectOptions(screen.getByRole("combobox", { name: "Freshness" }), "stale");
    await user.selectOptions(screen.getByRole("combobox", { name: "Link basis" }), "accepted");
    await user.click(screen.getByRole("checkbox", { name: "Current task only" }));
    await user.click(screen.getByRole("checkbox", { name: "Unlinked only" }));

    await waitFor(() => {
      const request = String(fetchStub.mock.calls.at(-1)?.[0]);
      for (const part of [
        "locationPrefix=docs", "role=supporting_document", "format=markdown",
        "linkedRecordId=task-one", "freshness=stale", "linkBasis=accepted",
        "relevance=current_task", "unlinked=true",
      ]) expect(request).toContain(part);
    });
  });

  test("lists instruction labels and supports keyboard selection by node ID", async () => {
    const readme = documentEntry("node-readme", "README.md");
    const instruction = documentEntry("node-agent", "AGENTS.md", {
      documentKind: "ai_instruction", instructionClient: "Codex", instructionScope: "repository",
    });
    const onSelectNode = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(registry([readme, instruction]))));
    render(<Documentation projectId="project-one" selectedNodeId={null} onSelectNode={onSelectNode} />);

    const list = await screen.findByRole("list", { name: "Repository documents" });
    expect(within(list).getByText("Codex · repository")).toBeTruthy();
    const items = within(list).getAllByRole("button");
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith("node-agent");
  });

  test("renders accepted text only for a current renderable document", async () => {
    const entry = documentEntry("node-readme", "README.md");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(json({ format: "markdown", text: "# Accepted\n\nSafe body.", sha256: "a".repeat(64) })));
    render(<Documentation projectId="project-one" selectedNodeId="node-readme" />);

    expect(await screen.findByRole("heading", { name: "Accepted" })).toBeTruthy();
    expect(screen.getByText("Safe body.")).toBeTruthy();
  });

  test("keeps an oversized accepted body tail out of layout and offers truthful desktop access", async () => {
    const entry = documentEntry("node-long", "docs/long.md");
    const body = `# Visible\n\n${"😀UnbrokenAcceptedContent".repeat(260)}TAIL-CONTENT-SENTINEL`;
    const desktop = desktopDocuments();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(json({ format: "markdown", text: body, sha256: "e".repeat(64) })));
    const { container } = render(
      <Documentation projectId="project-one" selectedNodeId="node-long" desktopDocuments={desktop} />,
    );

    expect(await screen.findByRole("heading", { name: "Visible" })).toBeTruthy();
    expect(container.textContent).not.toContain("TAIL-CONTENT-SENTINEL");
    expect(container.innerHTML).not.toContain(body);
    expect(screen.getByText("Preview shortened.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open externally" })).toBeTruthy();
  });

  test("situates a document in its project path and renders every authoritative connection basis", async () => {
    const entry = documentEntry("node-guide", "docs/guides/ship.md");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry, {
        linksByBasis: {
          accepted: [{ kind: "documents", basis: "accepted", toRecordId: "task-ship", toNodeId: null }],
          observed: [{ kind: "references", basis: "observed", toRecordId: null, toNodeId: "node-readme" }],
          inferred: [{ kind: "supports", basis: "inferred", toRecordId: "outcome-release", toNodeId: null }],
          conflicting: [{ kind: "contradicts", basis: "conflicting", toRecordId: null, toNodeId: "node-old-guide" }],
        },
      })))
      .mockResolvedValueOnce(json({
        format: "markdown",
        text: "# Ship",
        sha256: "f".repeat(64),
      })));
    render(<Documentation projectId="project-one" selectedNodeId="node-guide" />);

    expect((await screen.findByRole("navigation", { name: "Document project path" })).textContent)
      .toBe("Project project-oneRepositorydocsguidesship.md");
    expect(screen.getByRole("heading", { name: "Accepted intent connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Observed repository evidence" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inferred connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conflicting connections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open record task-ship in Map" }).getAttribute("href"))
      .toBe("/projects/project-one/map?focusRecordId=task-ship");
    expect(screen.getByRole("link", { name: "Open repository node node-readme" }).getAttribute("href"))
      .toBe("/projects/project-one/repository?nodeId=node-readme");
    expect(screen.getByRole("link", { name: "Open record task-ship in Map" }).parentElement?.textContent)
      .toContain("documents");
    expect(screen.getByRole("link", { name: "Open repository node node-readme" }).parentElement?.textContent)
      .toContain("references");
  });

  test("renders accepted plain text literally", async () => {
    const entry = documentEntry("node-notes", "notes.txt", { documentFormat: "plain_text" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(json({
        format: "plain_text",
        text: "<script>not markup</script>",
        sha256: "b".repeat(64),
      })));
    const { container } = render(
      <Documentation projectId="project-one" selectedNodeId="node-notes" />,
    );

    expect(await screen.findByText("<script>not markup</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  test.each([
    ["stale", "This document changed after the accepted refresh."],
    ["missing", "This accepted document is missing."],
    ["unavailable", "The repository is unavailable."],
    ["blocked", "Preview is blocked by repository safety rules."],
  ] as const)("suppresses content for %s documents", async (freshness, message) => {
    const entry = documentEntry(`node-${freshness}`, `${freshness}.md`, { freshness });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry, {
        nativeCapability: freshness === "blocked" ? "blocked" : "renderable",
      })));
    vi.stubGlobal("fetch", fetchStub);
    render(<Documentation projectId="project-one" selectedNodeId={entry.nodeId} />);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Refresh repository" }).getAttribute("href")).toBe(
      "/projects/project-one/repository/refresh",
    );
    expect(fetchStub.mock.calls.some(([url]) => String(url).endsWith("/content"))).toBe(false);
  });

  test("labels unsupported content and offers node-ID-only external opening", async () => {
    const entry = documentEntry("node-binary", "archive.bin", { documentFormat: "unsupported" });
    const desktop = desktopDocuments();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry, { nativeCapability: "unsupported" }))));
    render(<Documentation projectId="project-one" selectedNodeId="node-binary" desktopDocuments={desktop} />);

    expect(await screen.findByText("IntentArc cannot preview this format.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open externally" }));
    expect(desktop.openRepositoryFile).toHaveBeenCalledWith("project-one", "node-binary");
  });

  test("explains when external opening is unavailable outside desktop", async () => {
    const entry = documentEntry("node-binary", "archive.bin", { documentFormat: "unsupported" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry, { nativeCapability: "unsupported" }))));
    render(<Documentation projectId="project-one" selectedNodeId="node-binary" />);

    expect(await screen.findByText("External opening is available in the desktop app.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open externally" })).toBeNull();
  });

  test("previews image bytes only after an explicit action and revokes the object URL", async () => {
    const entry = documentEntry("node-image", "docs/diagram.png", { documentFormat: "image" });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }));
    vi.stubGlobal("fetch", fetchStub);
    const { unmount } = render(<Documentation projectId="project-one" selectedNodeId="node-image" />);

    expect(await screen.findByRole("button", { name: "Preview image" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Preview image" }));
    expect((await screen.findByRole("img", { name: "diagram.png" })).getAttribute("src")).toBe("blob:intentarc-preview");
    expect(fetchStub.mock.calls.at(-1)?.[0]).toBe(
      "/api/projects/project-one/documents/node-image/preview?expectedSnapshotId=snapshot-one",
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:intentarc-preview");
  });

  test("uses a sandboxed PDF frame and retains an external fallback", async () => {
    const entry = documentEntry("node-pdf", "docs/guide.pdf", { documentFormat: "pdf" });
    const desktop = desktopDocuments();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "Content-Type": "application/pdf" },
      })));
    render(<Documentation projectId="project-one" selectedNodeId="node-pdf" desktopDocuments={desktop} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Preview PDF" }));
    const frame = await screen.findByTitle("Preview of guide.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(screen.getByRole("button", { name: "Open externally" })).toBeTruthy();
  });

  test("aborts requests on navigation and ignores a late preview response", async () => {
    const entry = documentEntry("node-image", "diagram.png", { documentFormat: "image" });
    let resolvePreview!: (response: Response) => void;
    const preview = new Promise<Response>((resolve) => { resolvePreview = resolve; });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockReturnValueOnce(preview)
      .mockResolvedValueOnce(json(registry([])));
    vi.stubGlobal("fetch", fetchStub);
    const { rerender } = render(<Documentation projectId="project-one" selectedNodeId="node-image" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Preview image" }));
    const signal = (fetchStub.mock.calls[2]?.[1] as RequestInit).signal as AbortSignal;

    rerender(<Documentation projectId="project-two" selectedNodeId={null} />);
    expect(signal.aborted).toBe(true);
    resolvePreview(new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png" },
    }));
    await act(async () => await Promise.resolve());
    expect(screen.queryByRole("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test("renders neither text nor binary data when accepted snapshot A races to B", async () => {
    const imageA = documentEntry("node-image", "diagram.png", { documentFormat: "image" });
    const imageB = { ...imageA, snapshotId: "snapshot-two" };
    let acceptedSnapshot: "a" | "b" = "a";
    const fetchStub = vi.fn((request: string | URL | Request) => {
      const path = String(request);
      if (path.includes("locationPrefix=")) {
        acceptedSnapshot = "b";
        return Promise.resolve(json(registry([imageB])));
      }
      if (path.endsWith("/documents")) return Promise.resolve(json(registry([imageA])));
      if (path.endsWith("/node-image")) {
        return Promise.resolve(json(detail(acceptedSnapshot === "a" ? imageA : imageB)));
      }
      if (path.includes("/preview?expectedSnapshotId=snapshot-one")) {
        return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        }));
      }
      return Promise.resolve(json({
        error: { code: "document_stale", message: "Accepted snapshot changed.", recoverable: true },
      }, 409));
    });
    vi.stubGlobal("fetch", fetchStub);
    render(<Documentation projectId="project-one" selectedNodeId="node-image" />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Preview image" }));
    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documentation" }), {
      target: { value: "diagram.png" },
    });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:intentarc-preview"));
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Preview image" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls.at(-1)?.[0]).toBe(
      "/api/projects/project-one/documents/node-image/preview?expectedSnapshotId=snapshot-two",
    );
  });

  test("does not render text when an accepted content request for snapshot A reaches B", async () => {
    const entry = documentEntry("node-readme", "README.md");
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry)))
      .mockResolvedValueOnce(json({
        error: { code: "document_stale", message: "Accepted snapshot changed.", recoverable: true },
      }, 409));
    vi.stubGlobal("fetch", fetchStub);
    render(<Documentation projectId="project-one" selectedNodeId="node-readme" />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Snapshot B" })).toBeNull();
    expect(fetchStub.mock.calls.at(-1)?.[0]).toBe(
      "/api/projects/project-one/documents/node-readme/content?expectedSnapshotId=snapshot-one",
    );
  });

  test("preserves literal governed-detail wording in structured document paths", async () => {
    const phrase = "Retrieve this governed detail separately.";
    const entry = documentEntry("node-literal", `${phrase} ${phrase}.md`, {
      freshness: "blocked",
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([entry])))
      .mockResolvedValueOnce(json(detail(entry, { nativeCapability: "blocked" }))));
    render(<Documentation projectId="project-one" selectedNodeId="node-literal" />);

    await screen.findByRole("navigation", { name: "Document project path" });
    expect(screen.getByRole("button", { name: new RegExp(`^${phrase} ${phrase}`) }))
      .toBeTruthy();
    expect(screen.getByText(`${phrase} ${phrase}.md`, { selector: "dd" })).toBeTruthy();
  });

  test("suppresses accepted text synchronously when selecting a blocked node", async () => {
    const current = documentEntry("node-current", "current.md");
    const blocked = documentEntry("node-blocked", "blocked.md", { freshness: "blocked" });
    const never = new Promise<Response>(() => undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([current, blocked])))
      .mockResolvedValueOnce(json(detail(current)))
      .mockResolvedValueOnce(json({
        format: "markdown",
        text: "# Accepted secret\n\nOld project text.",
        sha256: "c".repeat(64),
      }))
      .mockReturnValue(never));
    const snapshots: LayoutSnapshot[] = [];
    const onLayout = (snapshot: LayoutSnapshot) => snapshots.push(snapshot);
    const { rerender } = render(
      <DocumentationLayoutProbe
        projectId="project-one"
        selectedNodeId="node-current"
        onLayout={onLayout}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Accepted secret" })).toBeTruthy();

    rerender(
      <DocumentationLayoutProbe
        projectId="project-one"
        selectedNodeId="node-blocked"
        onLayout={onLayout}
      />,
    );

    expect(snapshots.at(-1)?.text).not.toContain("Accepted secret");
    expect(snapshots.at(-1)?.text).not.toContain("Old project text.");
    expect(snapshots.at(-1)?.externalOpenCount).toBe(0);
  });

  test("suppresses old media and actions synchronously across projects", async () => {
    const image = documentEntry("node-image", "diagram.png", { documentFormat: "image" });
    const desktop = desktopDocuments();
    const never = new Promise<Response>(() => undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(registry([image])))
      .mockResolvedValueOnce(json(detail(image)))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }))
      .mockReturnValue(never));
    const snapshots: LayoutSnapshot[] = [];
    const onLayout = (snapshot: LayoutSnapshot) => snapshots.push(snapshot);
    const { rerender } = render(
      <DocumentationLayoutProbe
        projectId="project-one"
        selectedNodeId="node-image"
        desktop={desktop}
        onLayout={onLayout}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Preview image" }));
    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeTruthy();

    rerender(
      <DocumentationLayoutProbe
        projectId="project-two"
        selectedNodeId="node-other"
        desktop={desktop}
        onLayout={onLayout}
      />,
    );

    expect(snapshots.at(-1)).toMatchObject({
      imageCount: 0,
      externalOpenCount: 0,
      revokedObjectUrlCount: 1,
    });
    expect(snapshots.at(-1)?.text).not.toContain("diagram.png");
  });

  test("restores focus to the selected document after closing its detail", async () => {
    const entry = documentEntry("node-readme", "README.md");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(registry([entry]))));
    const { rerender } = render(<Documentation projectId="project-one" selectedNodeId="node-readme" />);
    await screen.findByRole("list", { name: "Repository documents" });

    rerender(<Documentation projectId="project-one" selectedNodeId={null} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /README.md/ })));
  });
});
