import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DocumentContentResponse,
  DocumentDetailResponse,
  DocumentPreviewResponse,
  DocumentRegistryResponse,
} from "../../contracts.js";
import { apiRequest } from "../api.js";
import type { DesktopDocumentsApi } from "../desktop-api.js";
import {
  boundedUnicodePreview,
} from "../components/record-preview.js";
import { SafeMarkdown } from "../components/safe-markdown.js";

interface DocumentationProps {
  readonly projectId: string;
  readonly selectedNodeId: string | null;
  readonly onSelectNode?: (nodeId: string | null) => void;
  readonly desktopDocuments?: DesktopDocumentsApi | null;
}

type RegistryState =
  | { readonly status: "loading"; readonly requestKey: string }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string }
  | { readonly status: "ready"; readonly requestKey: string; readonly response: DocumentRegistryResponse };

type DocumentState =
  | { readonly status: "idle" | "loading"; readonly requestKey: string }
  | { readonly status: "error"; readonly requestKey: string; readonly message: string }
  | {
      readonly status: "ready";
      readonly requestKey: string;
      readonly detail: DocumentDetailResponse;
      readonly content: DocumentContentResponse | null;
    };

type PreviewState =
  | { readonly status: "idle" | "loading"; readonly requestKey: string; readonly generation: number }
  | { readonly status: "error"; readonly requestKey: string; readonly generation: number; readonly message: string }
  | {
      readonly status: "ready";
      readonly requestKey: string;
      readonly generation: number;
      readonly objectUrl: string;
      readonly mediaType: string;
    };

interface DocumentationFilters {
  readonly locationPrefix: string;
  readonly role: string;
  readonly format: string;
  readonly linkedRecordId: string;
  readonly freshness: string;
  readonly linkBasis: string;
  readonly currentTask: boolean;
  readonly unlinked: boolean;
}

const emptyFilters: DocumentationFilters = {
  locationPrefix: "",
  role: "",
  format: "",
  linkedRecordId: "",
  freshness: "",
  linkBasis: "",
  currentTask: false,
  unlinked: false,
};

const roles = [
  "canonical_source",
  "supporting_document",
  "test",
  "tool",
  "asset",
  "archived_source",
] as const;
const formats = ["markdown", "plain_text", "image", "pdf", "unsupported"] as const;
const freshnessValues = ["current", "stale", "missing", "unavailable", "blocked"] as const;
const linkBases = ["accepted", "observed", "inferred", "conflicting"] as const;
const maximumDisplayPath = 160;
const maximumDisplayIdentifier = 96;
const maximumDisplayLabel = 120;
const maximumDocumentPreview = 4_000;

const connectionHeading = (basis: typeof linkBases[number]): string => {
  if (basis === "accepted") return "Accepted intent connections";
  if (basis === "observed") return "Observed repository evidence";
  return `${basis[0]!.toUpperCase()}${basis.slice(1)} connections`;
};

const endpoint = (projectId: string, suffix = ""): string =>
  `/api/projects/${encodeURIComponent(projectId)}/documents${suffix}`;

const readableLabel = (value: string): string => value.replaceAll("_", " ");

const errorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message !== "" ? reason.message : fallback;

const basename = (path: string): string => path.split("/").at(-1) ?? path;

const registryMatchesProject = (
  response: DocumentRegistryResponse,
  projectId: string,
): boolean => response.projectId === projectId && response.documents.every((document) =>
  document.projectId === projectId && document.snapshotId === response.snapshotId);

const unavailableMessage = (freshness: DocumentDetailResponse["document"]["freshness"]): string | null => {
  if (freshness === "stale") return "This document changed after the accepted refresh.";
  if (freshness === "missing") return "This accepted document is missing.";
  if (freshness === "unavailable") return "The repository is unavailable.";
  if (freshness === "blocked") return "Preview is blocked by repository safety rules.";
  return null;
};

export function Documentation({
  projectId,
  selectedNodeId,
  onSelectNode,
  desktopDocuments = null,
}: DocumentationProps) {
  const [filters, setFilters] = useState<DocumentationFilters>(emptyFilters);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [registryState, setRegistryState] = useState<RegistryState>({ status: "loading", requestKey: "" });
  const [documentState, setDocumentState] = useState<DocumentState>({ status: "idle", requestKey: "" });
  const [previewState, setPreviewState] = useState<PreviewState>({
    status: "idle",
    requestKey: "",
    generation: 0,
  });
  const previewControllerRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewGenerationRef = useRef(0);
  const documentButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const previousSelectedNodeRef = useRef<string | null>(selectedNodeId);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    const add = (key: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed !== "") params.set(key, trimmed);
    };
    add("locationPrefix", filters.locationPrefix);
    add("role", filters.role);
    add("format", filters.format);
    add("linkedRecordId", filters.linkedRecordId);
    add("freshness", filters.freshness);
    add("linkBasis", filters.linkBasis);
    if (filters.currentTask) params.set("relevance", "current_task");
    if (filters.unlinked) params.set("unlinked", "true");
    const serialized = params.toString();
    return serialized === "" ? "" : `?${serialized}`;
  }, [filters]);
  const registryRequestKey = JSON.stringify([projectId, query, reloadGeneration]);
  const registryBindingKey = registryState.requestKey !== registryRequestKey
    ? "loading"
    : registryState.status === "ready"
      ? `ready:${registryState.response.snapshotId ?? "none"}`
      : registryState.status;
  const documentRequestKey = JSON.stringify([
    projectId,
    selectedNodeId,
    registryRequestKey,
    registryBindingKey,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = registryRequestKey;
    setRegistryState({ status: "loading", requestKey });
    apiRequest<DocumentRegistryResponse>(`${endpoint(projectId)}${query}`, {
      signal: controller.signal,
    }).then(
      (response) => {
        if (controller.signal.aborted) return;
        if (!registryMatchesProject(response, projectId)) {
          setRegistryState({
            status: "error",
            requestKey,
            message: "Documentation response did not match this project.",
          });
          return;
        }
        setRegistryState({ status: "ready", requestKey, response });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setRegistryState({
            status: "error",
            requestKey,
            message: errorMessage(reason, "Could not load repository documentation."),
          });
        }
      },
    );
    return () => controller.abort();
  }, [projectId, query, registryRequestKey, reloadGeneration]);

  const revokePreview = useCallback(() => {
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    previewGenerationRef.current += 1;
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    revokePreview();
    setPreviewState({
      status: "idle",
      requestKey: documentRequestKey,
      generation: previewGenerationRef.current,
    });
  }, [documentRequestKey, revokePreview]);

  useEffect(() => {
    const requestKey = documentRequestKey;
    if (selectedNodeId === null) {
      setDocumentState({ status: "idle", requestKey });
      return;
    }
    if (registryState.requestKey !== registryRequestKey || registryState.status !== "ready") {
      setDocumentState({ status: "loading", requestKey });
      return;
    }
    if (registryState.response.snapshotId === null) {
      setDocumentState({
        status: "error",
        requestKey,
        message: "Document detail did not match the accepted project snapshot.",
      });
      return;
    }
    const acceptedSnapshotId = registryState.response.snapshotId;
    const controller = new AbortController();
    setDocumentState({ status: "loading", requestKey });
    const suffix = `/${encodeURIComponent(selectedNodeId)}`;
    const load = async () => {
      try {
        const detail = await apiRequest<DocumentDetailResponse>(endpoint(projectId, suffix), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (
          detail.document.projectId !== projectId ||
          detail.document.snapshotId !== acceptedSnapshotId ||
          detail.document.nodeId !== selectedNodeId
        ) {
          setDocumentState({
            status: "error",
            requestKey,
            message: "Document detail did not match the accepted project snapshot.",
          });
          return;
        }
        if (detail.document.freshness !== "current" || detail.nativeCapability !== "renderable") {
          setDocumentState({ status: "ready", requestKey, detail, content: null });
          return;
        }
        const content = await apiRequest<DocumentContentResponse>(endpoint(
          projectId,
          `${suffix}/content?expectedSnapshotId=${encodeURIComponent(acceptedSnapshotId)}`,
        ), {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setDocumentState({ status: "ready", requestKey, detail, content });
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setDocumentState({
            status: "error",
            requestKey,
            message: errorMessage(reason, "Could not load the accepted document."),
          });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [documentRequestKey, projectId, registryRequestKey, registryState, selectedNodeId]);

  useEffect(() => () => revokePreview(), [revokePreview]);

  useEffect(() => {
    const previous = previousSelectedNodeRef.current;
    previousSelectedNodeRef.current = selectedNodeId;
    if (previous !== null && selectedNodeId === null) {
      requestAnimationFrame(() => documentButtonsRef.current.get(previous)?.focus());
    }
  }, [registryState, selectedNodeId]);

  const updateTextFilter = (key: keyof DocumentationFilters) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setFilters((current) => ({ ...current, [key]: event.target.value }));
    };

  const updateBooleanFilter = (key: "currentTask" | "unlinked") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setFilters((current) => ({ ...current, [key]: event.target.checked }));
    };

  const selectDocument = (nodeId: string) => onSelectNode?.(nodeId);

  const handleDocumentKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    documents: DocumentRegistryResponse["documents"],
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectDocument(documents[index]!.nodeId);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? documents.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + documents.length) % documents.length;
    documentButtonsRef.current.get(documents[nextIndex]!.nodeId)?.focus();
  };

  const loadPreview = async (detail: DocumentDetailResponse) => {
    if (detail.nativeCapability !== "previewable" || detail.document.freshness !== "current") return;
    revokePreview();
    const controller = new AbortController();
    previewControllerRef.current = controller;
    const generation = previewGenerationRef.current;
    const requestKey = documentRequestKey;
    setPreviewState({ status: "loading", requestKey, generation });
    try {
      const response: DocumentPreviewResponse = await fetch(endpoint(
        projectId,
        `/${encodeURIComponent(detail.document.nodeId)}/preview?expectedSnapshotId=${encodeURIComponent(detail.document.snapshotId)}`,
      ), {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      if (!response.ok) throw new Error("The accepted preview could not be loaded.");
      const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const validMedia = detail.document.documentFormat === "pdf"
        ? mediaType === "application/pdf"
        : ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon"].includes(mediaType);
      if (!validMedia) throw new Error("The accepted preview format did not match the document.");
      const blob = await response.blob();
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      const objectUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted || generation !== previewGenerationRef.current) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      previewUrlRef.current = objectUrl;
      setPreviewState({
        status: "ready",
        requestKey,
        generation,
        objectUrl,
        mediaType,
      });
    } catch (reason) {
      if (!controller.signal.aborted && generation === previewGenerationRef.current) {
        setPreviewState({
          status: "error",
          requestKey,
          generation,
          message: errorMessage(reason, "The accepted preview could not be loaded."),
        });
      }
    }
  };

  const currentRegistryState: RegistryState = registryState.requestKey === registryRequestKey
    ? registryState
    : { status: "loading", requestKey: registryRequestKey };
  const currentDocumentState: DocumentState = documentState.requestKey === documentRequestKey
    ? documentState
    : {
        status: selectedNodeId === null ? "idle" : "loading",
        requestKey: documentRequestKey,
      };
  const currentPreviewState: PreviewState =
    previewState.requestKey === documentRequestKey &&
      previewState.generation === previewGenerationRef.current
      ? previewState
      : {
          status: "idle",
          requestKey: documentRequestKey,
          generation: previewGenerationRef.current,
        };
  const documents = currentRegistryState.status === "ready"
    ? currentRegistryState.response.documents
    : [];
  const selectedDetail = currentDocumentState.status === "ready"
    ? currentDocumentState.detail
    : null;
  const selectedContent = currentDocumentState.status === "ready"
    ? currentDocumentState.content
    : null;
  const selectedName = selectedDetail === null
    ? "document"
    : boundedUnicodePreview(basename(selectedDetail.document.path), maximumDisplayPath);
  const selectedDisplayPath = selectedDetail === null
    ? ""
    : boundedUnicodePreview(selectedDetail.document.path, maximumDisplayPath);
  const selectedContentPreview = selectedContent === null
    ? null
    : boundedUnicodePreview(selectedContent.text, maximumDocumentPreview);
  const selectedContentShortened = selectedContent !== null &&
    Array.from(selectedContent.text).length > maximumDocumentPreview;
  const staleMessage = selectedDetail === null ? null : unavailableMessage(selectedDetail.document.freshness);
  const canOpenExternally = selectedDetail?.externalOpenEligible === true && desktopDocuments !== null;

  return (
    <div className="documentation-surface">
      <div className="stage__header">
        <div>
          <p className="stage__eyebrow">Repository · accepted knowledge</p>
          <h1>Documentation</h1>
        </div>
        <a
          className="button-link"
          href={`/projects/${encodeURIComponent(projectId)}/repository/refresh`}
        >
          Review repository refresh
        </a>
      </div>

      <section className="documentation-search" aria-label="Documentation search">
        <label>Search documentation<input type="search" aria-label="Search documentation" value={filters.locationPrefix} onChange={updateTextFilter("locationPrefix")} /></label>
      </section>

      <div className="documentation-layout">
        <section className="documentation-registry" aria-labelledby="documentation-registry-heading">
          <h2 id="documentation-registry-heading">Repository documents</h2>
          {currentRegistryState.status === "loading" ? <p role="status">Loading documentation…</p> : null}
          {currentRegistryState.status === "error" ? (
            <div role="alert"><p>{currentRegistryState.message}</p><button type="button" onClick={() => setReloadGeneration((value) => value + 1)}>Try again</button></div>
          ) : null}
          {currentRegistryState.status === "ready" && documents.length === 0 ? <p>No repository documentation matches these filters.</p> : null}
          {documents.length > 0 ? (
            <ul className="documentation-list" aria-label="Repository documents">
              {documents.map((document, index) => (
                <li key={document.nodeId}>
                  <button
                    ref={(element) => {
                      if (element === null) documentButtonsRef.current.delete(document.nodeId);
                      else documentButtonsRef.current.set(document.nodeId, element);
                    }}
                    type="button"
                    className="documentation-list__item"
                    aria-pressed={selectedNodeId === document.nodeId}
                    onClick={() => selectDocument(document.nodeId)}
                    onKeyDown={(event) => handleDocumentKey(event, index, documents)}
                  >
                    <span>{boundedUnicodePreview(document.path, maximumDisplayPath)}</span>
                    <span>{readableLabel(document.documentKind)} · {readableLabel(document.documentFormat)} · {document.freshness}</span>
                    {document.documentKind === "ai_instruction" ? <span>
                      {boundedUnicodePreview(document.instructionClient!, maximumDisplayLabel)} · {boundedUnicodePreview(document.instructionScope!, maximumDisplayLabel)}
                    </span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="documentation-preview" aria-labelledby="documentation-preview-heading">
          <div className="documentation-preview__header">
            <h2 id="documentation-preview-heading">Document preview</h2>
            {selectedNodeId !== null && onSelectNode !== undefined ? <button type="button" onClick={() => onSelectNode(null)}>Close preview</button> : null}
          </div>
          {selectedNodeId === null ? <p>Select a document to inspect its accepted observation.</p> : null}
          {currentDocumentState.status === "loading" ? <p role="status">Loading accepted document…</p> : null}
          {currentDocumentState.status === "error" ? <p role="alert">{currentDocumentState.message}</p> : null}
          {selectedDetail !== null ? (
            <>
              <dl className="documentation-metadata">
                <div><dt>Document</dt><dd>{selectedDisplayPath}</dd></div>
                <div><dt>Format</dt><dd>{readableLabel(selectedDetail.document.documentFormat)}</dd></div>
                <div><dt>State</dt><dd>{selectedDetail.document.freshness}</dd></div>
              </dl>
              <nav className="repository-context-path" aria-label="Document project path">
                <ol>
                  <li>Project {boundedUnicodePreview(projectId, maximumDisplayIdentifier)}</li>
                  <li>Repository</li>
                  {selectedDisplayPath.split("/").map((segment, index) => (
                    <li key={`${segment}-${index}`}>{segment}</li>
                  ))}
                </ol>
              </nav>
              <div className="documentation-connections">
                {linkBases.map((basis) => {
                  const links = selectedDetail.linksByBasis[basis];
                  if (links.length === 0) return null;
                  return <section key={basis}>
                    <h3>{connectionHeading(basis)}</h3>
                    <ul>{links.map((link, index) => (
                      <li key={`${link.kind}-${link.toRecordId ?? link.toNodeId}-${index}`}>
                        {link.toRecordId !== null ? (
                          <a href={`/projects/${encodeURIComponent(projectId)}/map?focusRecordId=${encodeURIComponent(link.toRecordId)}`}>
                            Open record {boundedUnicodePreview(link.toRecordId, maximumDisplayIdentifier)} in Map
                          </a>
                        ) : (
                          <a href={`/projects/${encodeURIComponent(projectId)}/repository?nodeId=${encodeURIComponent(link.toNodeId!)}`}>
                            Open repository node {boundedUnicodePreview(link.toNodeId!, maximumDisplayIdentifier)}
                          </a>
                        )}
                        <span> · {boundedUnicodePreview(readableLabel(link.kind), maximumDisplayLabel)}</span>
                      </li>
                    ))}</ul>
                  </section>;
                })}
              </div>
              {canOpenExternally ? (
                <button type="button" onClick={() => {
                  void desktopDocuments.openRepositoryFile(projectId, selectedDetail.document.nodeId).catch(() => undefined);
                }}>Open externally</button>
              ) : null}
              {selectedDetail.externalOpenEligible && desktopDocuments === null ? (
                <p className="documentation-external-unavailable">
                  External opening is available in the desktop app.
                </p>
              ) : null}
              {staleMessage !== null ? (
                <div className="documentation-state"><p>{staleMessage}</p><a href={`/projects/${encodeURIComponent(projectId)}/repository/refresh`}>Refresh repository</a></div>
              ) : null}
              {staleMessage === null && selectedDetail.nativeCapability === "unsupported" ? <p>IntentArc cannot preview this format.</p> : null}
              {selectedContentShortened ? <p>Preview shortened.</p> : null}
              {staleMessage === null && selectedDetail.nativeCapability === "renderable" && selectedContentPreview !== null ? (
                selectedContent?.format === "markdown"
                  ? <SafeMarkdown
                      source={selectedContentPreview}
                      {...(desktopDocuments === null ? {} : {
                        onOpenExternalHttps: (url: string) => desktopDocuments.openExternalHttps(url).then(() => undefined),
                      })}
                    />
                  : <pre className="documentation-plain-text"><code>{selectedContentPreview}</code></pre>
              ) : null}
              {staleMessage === null && selectedDetail.nativeCapability === "previewable" ? (
                <div className="documentation-native-preview">
                  {currentPreviewState.status === "idle" ? <button type="button" onClick={() => void loadPreview(selectedDetail)}>
                    Preview {selectedDetail.document.documentFormat === "pdf" ? "PDF" : "image"}
                  </button> : null}
                  {currentPreviewState.status === "loading" ? <p role="status">Loading contained preview…</p> : null}
                  {currentPreviewState.status === "error" ? <p role="alert">{currentPreviewState.message}</p> : null}
                  {currentPreviewState.status === "ready" && selectedDetail.document.documentFormat === "image" ? (
                    <img src={currentPreviewState.objectUrl} alt={selectedName} />
                  ) : null}
                  {currentPreviewState.status === "ready" && selectedDetail.document.documentFormat === "pdf" ? (
                    <iframe src={currentPreviewState.objectUrl} title={`Preview of ${selectedName}`} sandbox="" />
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      </div>

      <details
        className="documentation-filters"
        onToggle={(event) => setAdvancedFiltersOpen(event.currentTarget.open)}
      >
        <summary>Advanced filters</summary>
        {advancedFiltersOpen ? <div className="documentation-filters__content">
          <label>Role<select aria-label="Role" value={filters.role} onChange={updateTextFilter("role")}>
            <option value="">All roles</option>{roles.map((role) => <option key={role} value={role}>{readableLabel(role)}</option>)}
          </select></label>
          <label>Format<select aria-label="Format" value={filters.format} onChange={updateTextFilter("format")}>
            <option value="">All formats</option>{formats.map((format) => <option key={format} value={format}>{readableLabel(format)}</option>)}
          </select></label>
          <label>Linked record ID<input aria-label="Linked record ID" value={filters.linkedRecordId} onChange={updateTextFilter("linkedRecordId")} /></label>
          <label>Freshness<select aria-label="Freshness" value={filters.freshness} onChange={updateTextFilter("freshness")}>
            <option value="">Any freshness</option>{freshnessValues.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label>Link basis<select aria-label="Link basis" value={filters.linkBasis} onChange={updateTextFilter("linkBasis")}>
            <option value="">Any link basis</option>{linkBases.map((basis) => <option key={basis} value={basis}>{basis}</option>)}
          </select></label>
          <label className="documentation-filter-check"><input type="checkbox" checked={filters.currentTask} onChange={updateBooleanFilter("currentTask")} />Current task only</label>
          <label className="documentation-filter-check"><input type="checkbox" checked={filters.unlinked} onChange={updateBooleanFilter("unlinked")} />Unlinked only</label>
        </div> : null}
      </details>
    </div>
  );
}
