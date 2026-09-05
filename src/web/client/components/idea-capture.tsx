import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { IdeaCaptureResponse } from "../../contracts.js";
import { apiPath } from "../../contracts.js";
import { ApiError, apiRequest } from "../api.js";
import {
  cancelDeferredNavigation,
  navigate,
  registerRouteBlocker,
  resumeDeferredNavigation,
} from "../router.js";

export interface IdeaCaptureProject {
  id: string;
  name: string;
  revision: number;
  context: Array<{
    id: string;
    kind: "task" | "component";
    title: string;
  }>;
}

export interface IdeaCaptureProviderProps {
  project: IdeaCaptureProject | null;
  onProjectRevision(projectId: string, revision: number): void;
  refreshProject(projectId: string): Promise<number>;
  createCaptureRequestId?(): string;
  children: ReactNode;
}

export interface IdeaCaptureContextValue {
  available: boolean;
  latestCapture: {
    projectId: string;
    item: IdeaCaptureResponse["item"];
  } | null;
  open(): void;
  clearLatestCapture(projectId: string, recordId: string): void;
}

type CaptureMode = "closed" | "editing" | "submitting" | "saved";
type CaptureError = {
  kind:
    | "retry"
    | "conflict-retry"
    | "context-retry"
    | "context-invalid"
    | "context-refreshing"
    | "revision-refreshing";
  message: string;
};

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  projectId: string;
}

interface CaptureAttempt {
  projectId: string;
  captureRequestId: string;
  expectedProjectRevision: number;
  body: string;
}

const confirmationCopy = "Discard this unsaved idea?";
const maximumIdeaLength = 16_384;

const unavailableContext: IdeaCaptureContextValue = {
  available: false,
  latestCapture: null,
  open: () => undefined,
  clearLatestCapture: () => undefined,
};

const IdeaCaptureContext = createContext<IdeaCaptureContextValue>(
  unavailableContext,
);

export const useIdeaCapture = (): IdeaCaptureContextValue =>
  useContext(IdeaCaptureContext);

const ideaLength = (draft: string): number =>
  Array.from(draft.replace(/\r\n?/g, "\n").trim()).length;

const normalizedDraft = (draft: string): string =>
  draft.replace(/\r\n?/g, "\n").trim();

const destinationProjectId = (path: string): string | null => {
  try {
    const pathname = new URL(path, window.location.origin).pathname;
    const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
};

const failureMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message.length > 0
    ? reason.message
    : fallback;

export function IdeaCaptureProvider({
  project,
  onProjectRevision,
  refreshProject,
  createCaptureRequestId = () => crypto.randomUUID(),
  children,
}: IdeaCaptureProviderProps) {
  const [mode, setMode] = useState<CaptureMode>("closed");
  const [drawerProjectId, setDrawerProjectId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<CaptureError | null>(null);
  const [latestCapture, setLatestCapture] = useState<{
    projectId: string;
    item: IdeaCaptureResponse["item"];
  } | null>(null);
  const applicationRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const savedActionRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef(false);
  const projectRef = useRef(project);
  const previousProjectIdRef = useRef(project?.id ?? null);
  const modeRef = useRef(mode);
  const actionGenerationRef = useRef(0);
  const requestRef = useRef<ActiveRequest | null>(null);
  const submittingRef = useRef(false);
  const requestIdFactoryRef = useRef(createCaptureRequestId);
  const captureRequestIdRef = useRef<string | null>(null);
  const captureAttemptRef = useRef<CaptureAttempt | null>(null);
  const requestIdInitializedRef = useRef(false);
  const submissionAttemptedRef = useRef(false);

  requestIdFactoryRef.current = createCaptureRequestId;
  if (!requestIdInitializedRef.current) {
    captureRequestIdRef.current = createCaptureRequestId();
    requestIdInitializedRef.current = true;
  }
  const rotateCaptureRequestId = useCallback(() => {
    captureRequestIdRef.current = requestIdFactoryRef.current();
    captureAttemptRef.current = null;
  }, []);

  projectRef.current = project;
  modeRef.current = mode;

  const activeProjectId = project?.id ?? null;
  const available = activeProjectId !== null;
  const isOpen = mode !== "closed" && drawerProjectId === activeProjectId;
  const hasUnsavedDraft = normalizedDraft(draft).length > 0 && mode !== "saved";
  const draftLength = ideaLength(draft);
  const draftCanSubmit = draftLength > 0 && draftLength <= maximumIdeaLength;
  const activeLatestCapture = latestCapture?.projectId === activeProjectId
    ? latestCapture
    : null;

  const dismissDrawer = useCallback(() => {
    returnFocusRef.current = true;
    setDrawerProjectId(null);
    setMode("closed");
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current === activeProjectId) return;
    previousProjectIdRef.current = activeProjectId;
    cancelDeferredNavigation();
    actionGenerationRef.current += 1;
    const activeRequest = requestRef.current;
    if (activeRequest && activeRequest.projectId !== activeProjectId) {
      activeRequest.controller.abort();
      requestRef.current = null;
    }
    submittingRef.current = false;
    if (modeRef.current !== "closed") dismissDrawer();
    setDraft("");
    rotateCaptureRequestId();
    submissionAttemptedRef.current = false;
    setError(null);
    setLatestCapture((current) => current?.projectId === activeProjectId
      ? current
      : null);
  }, [activeProjectId, dismissDrawer, rotateCaptureRequestId]);

  useEffect(() => () => {
    cancelDeferredNavigation();
    actionGenerationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    submittingRef.current = false;
  }, []);

  const close = useCallback(() => {
    if (modeRef.current === "submitting") return;
    dismissDrawer();
  }, [dismissDrawer]);

  const open = useCallback(() => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setDrawerProjectId(currentProject.id);
    setMode((current) => current === "saved" ? "saved" : "editing");
  }, []);

  const clearLatestCapture = useCallback((
    projectId: string,
    recordId: string,
  ) => {
    setLatestCapture((current) =>
      current?.projectId === projectId && current.item.id === recordId
        ? null
        : current
    );
  }, []);

  useEffect(() => {
    const application = applicationRef.current;
    if (!application) return;
    if (isOpen) application.setAttribute("inert", "");
    else application.removeAttribute("inert");
    return () => application.removeAttribute("inert");
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    if (!returnFocusRef.current) return;
    returnFocusRef.current = false;
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
    if (document.activeElement !== trigger) applicationRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (mode === "editing") textareaRef.current?.focus();
    else if (mode === "submitting") closeButtonRef.current?.focus();
    else if (mode === "saved") savedActionRef.current?.focus();
  }, [isOpen, mode]);

  useEffect(() => {
    if (!isOpen) return;
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (modeRef.current !== "submitting") close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [href]",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!dialog || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInside);
    return () => window.removeEventListener("keydown", keepFocusInside);
  }, [close, isOpen]);

  useEffect(() => {
    if (!hasUnsavedDraft) return;
    const disposeBlocker = registerRouteBlocker((nextPath) => {
      if (submittingRef.current) return "defer";
      if (destinationProjectId(nextPath) === activeProjectId) return "allow";
      if (!window.confirm(confirmationCopy)) return "block";
      flushSync(() => {
        setDraft("");
        setError(null);
        captureRequestIdRef.current = null;
        captureAttemptRef.current = null;
        submissionAttemptedRef.current = false;
      });
      return "allow";
    });
    const confirmUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = confirmationCopy;
      return confirmationCopy;
    };
    window.addEventListener("beforeunload", confirmUnload);
    return () => {
      disposeBlocker();
      window.removeEventListener("beforeunload", confirmUnload);
    };
  }, [activeProjectId, hasUnsavedDraft]);

  useEffect(() => {
    if (mode === "submitting") return;
    resumeDeferredNavigation();
  }, [mode]);

  const submit = useCallback(async () => {
    const boundProject = projectRef.current;
    if (!boundProject || submittingRef.current) return;
    const length = ideaLength(draft);
    if (length === 0) {
      setError({ kind: "retry", message: "Enter an idea before saving." });
      return;
    }
    if (length > maximumIdeaLength) {
      setError({
        kind: "retry",
        message: "Ideas can contain at most 16384 characters.",
      });
      return;
    }

    const generation = ++actionGenerationRef.current;
    const captureRequestId = captureRequestIdRef.current
      ?? requestIdFactoryRef.current();
    captureRequestIdRef.current = captureRequestId;
    submissionAttemptedRef.current = true;
    const retainedAttempt = captureAttemptRef.current;
    const attempt = retainedAttempt?.projectId === boundProject.id &&
        retainedAttempt.captureRequestId === captureRequestId
      ? retainedAttempt
      : {
          projectId: boundProject.id,
          captureRequestId,
          expectedProjectRevision: boundProject.revision,
          body: JSON.stringify({
            expectedProjectRevision: boundProject.revision,
            captureRequestId,
            text: draft,
            contextRecordIds: boundProject.context.map(({ id }) => id),
          }),
        };
    captureAttemptRef.current = attempt;
    const controller = new AbortController();
    const request: ActiveRequest = {
      controller,
      generation,
      projectId: boundProject.id,
    };
    requestRef.current = request;
    submittingRef.current = true;
    setMode("submitting");
    setError(null);

    const actionIsCurrent = () =>
      !controller.signal.aborted &&
      generation === actionGenerationRef.current &&
      projectRef.current?.id === boundProject.id;

    try {
      const capture = await apiRequest<IdeaCaptureResponse>(
        apiPath("projects", attempt.projectId, "ideas"),
        {
          method: "POST",
          signal: controller.signal,
          body: attempt.body,
        },
      );
      if (!actionIsCurrent()) return;
      if (
        capture.item.projectId !== boundProject.id ||
        capture.item.status !== "provisional" ||
        capture.projectRevision !== attempt.expectedProjectRevision + 1
      ) {
        throw new Error("The server returned an invalid idea capture response.");
      }
      setLatestCapture({ projectId: boundProject.id, item: capture.item });
      setDraft("");
      rotateCaptureRequestId();
      submissionAttemptedRef.current = false;
      onProjectRevision(boundProject.id, capture.projectRevision);
      setError(null);
      setMode("saved");
    } catch (reason: unknown) {
      if (!actionIsCurrent()) return;
      if (
        reason instanceof ApiError &&
        reason.code !== "service_unavailable" &&
        reason.code !== "internal_error"
      ) {
        captureAttemptRef.current = null;
      }
      if (reason instanceof ApiError && reason.code === "project_revision_conflict") {
        setError({
          kind: "revision-refreshing",
          message: "The project changed. Refreshing the latest project state…",
        });
        try {
          await refreshProject(boundProject.id);
          if (!actionIsCurrent()) return;
          setError({
            kind: "conflict-retry",
            message: "The project changed. Review the latest context, then retry.",
          });
        } catch (refreshReason: unknown) {
          if (!actionIsCurrent()) return;
          setError({
            kind: "retry",
            message: failureMessage(
              refreshReason,
              "The project changed and could not be refreshed. Retry when it is available.",
            ),
          });
        }
        setMode("editing");
      } else if (
        reason instanceof ApiError && reason.code === "idea_context_invalid"
      ) {
        setError({
          kind: "context-invalid",
          message: "The project context changed. Refresh context before retrying.",
        });
        setMode("editing");
      } else {
        setError({
          kind: "retry",
          message: failureMessage(reason, "The idea could not be saved."),
        });
        setMode("editing");
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      if (generation === actionGenerationRef.current) {
        submittingRef.current = false;
      }
    }
  }, [draft, onProjectRevision, refreshProject, rotateCaptureRequestId]);

  const refreshContext = useCallback(async () => {
    const boundProject = projectRef.current;
    if (!boundProject || error?.kind !== "context-invalid") return;
    const generation = actionGenerationRef.current;
    setError({
      kind: "context-refreshing",
      message: "Refreshing the current project context…",
    });
    try {
      await refreshProject(boundProject.id);
      if (
        generation !== actionGenerationRef.current ||
        projectRef.current?.id !== boundProject.id
      ) return;
      setError({
        kind: "context-retry",
        message: "Context refreshed. Review the current context, then retry.",
      });
    } catch (reason: unknown) {
      if (
        generation !== actionGenerationRef.current ||
        projectRef.current?.id !== boundProject.id
      ) return;
      setError({
        kind: "context-invalid",
        message: failureMessage(reason, "The project context could not be refreshed."),
      });
    }
  }, [error?.kind, refreshProject]);

  const captureAnother = useCallback(() => {
    setDraft("");
    setError(null);
    rotateCaptureRequestId();
    submissionAttemptedRef.current = false;
    setMode("editing");
  }, [rotateCaptureRequestId]);

  const viewIdeas = useCallback(() => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    if (navigate(`/projects/${encodeURIComponent(currentProject.id)}/ideas`)) {
      dismissDrawer();
    }
  }, [dismissDrawer]);

  const contextValue = useMemo<IdeaCaptureContextValue>(() => ({
    available,
    latestCapture: activeLatestCapture,
    open,
    clearLatestCapture,
  }), [activeLatestCapture, available, clearLatestCapture, open]);

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <IdeaCaptureContext.Provider value={contextValue}>
      <div ref={applicationRef} className="idea-capture-application" tabIndex={-1}>
        {children}
      </div>
      {isOpen && project
        ? (
          <section
            ref={dialogRef}
            className="idea-capture-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="idea-capture-title"
            aria-busy={mode === "submitting"}
          >
            <header className="idea-capture-drawer__header">
              <div>
                <p className="idea-capture-drawer__eyebrow">{project.name}</p>
                <h2 id="idea-capture-title">Capture idea</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="icon-button"
                aria-label="Close idea capture"
                aria-disabled={mode === "submitting"}
                onClick={close}
              >
                ×
              </button>
            </header>

            {mode === "saved"
              ? (
                <div className="idea-capture-drawer__body idea-capture-saved">
                  <p role="status">Idea saved. Current work is unchanged.</p>
                  <div className="idea-capture-actions">
                    <button
                      ref={savedActionRef}
                      type="button"
                      className="idea-capture-action--secondary"
                      onClick={captureAnother}
                    >
                      Capture another
                    </button>
                    <button
                      type="button"
                      className="idea-capture-action--primary"
                      onClick={viewIdeas}
                    >
                      View ideas
                    </button>
                  </div>
                </div>
              )
              : (
                <form className="idea-capture-drawer__body" onSubmit={submitForm} aria-busy={mode === "submitting"} noValidate>
                  <div className="field">
                    <label htmlFor="idea-capture-draft">Idea</label>
                    <textarea
                      ref={textareaRef}
                      id="idea-capture-draft"
                      rows={10}
                      value={draft}
                      required
                      aria-required="true"
                      disabled={mode === "submitting"}
                      aria-describedby="idea-capture-hint idea-capture-context"
                      onChange={(event) => {
                        const nextDraft = event.currentTarget.value;
                        if (
                          submissionAttemptedRef.current &&
                          normalizedDraft(nextDraft) !== normalizedDraft(draft)
                        ) {
                          rotateCaptureRequestId();
                        }
                        setDraft(nextDraft);
                        setError((current) =>
                          current?.kind === "context-invalid" ||
                            current?.kind === "context-refreshing" ||
                            current?.kind === "conflict-retry" ||
                            current?.kind === "context-retry"
                            ? current
                            : null
                        );
                      }}
                    />
                    <p id="idea-capture-hint" className="field__hint">
                      Save the thought without changing current work.
                    </p>
                  </div>

                  <section
                    id="idea-capture-context"
                    className="idea-capture-context"
                    aria-labelledby="idea-capture-context-title"
                  >
                    <h3 id="idea-capture-context-title">Current context</h3>
                    {project.context.length > 0
                      ? (
                        <ul>
                          {project.context.map((item) => (
                            <li key={item.id}>{item.title}</li>
                          ))}
                        </ul>
                      )
                      : <p>No current work context will be attached.</p>}
                  </section>

                  {error
                    ? <p className="idea-capture-message" role="alert">{error.message}</p>
                    : mode === "submitting"
                      ? <p className="idea-capture-message" role="status">Saving idea…</p>
                      : null}

                  <div className="idea-capture-actions">
                    {error?.kind === "context-invalid"
                      ? (
                        <button
                          type="button"
                          className="idea-capture-action--primary"
                          onClick={() => void refreshContext()}
                        >
                          Refresh context
                        </button>
                      )
                      : error?.kind === "context-refreshing"
                        ? (
                            <button
                              type="button"
                              className="idea-capture-action--primary"
                              disabled
                            >
                              Refreshing context…
                            </button>
                          )
                        : error?.kind === "retry" ||
                            error?.kind === "conflict-retry" ||
                            error?.kind === "context-retry"
                          ? (
                              <button
                                type="button"
                                className="idea-capture-action--primary"
                                disabled={!draftCanSubmit}
                                onClick={() => void submit()}
                              >
                                Retry
                              </button>
                            )
                          : null}
                    <button
                      type="button"
                      className="idea-capture-action--secondary"
                      disabled={mode === "submitting"}
                      onClick={close}
                    >
                      Cancel
                    </button>
                    {error === null
                      ? (
                          <button
                            type="submit"
                            className="idea-capture-action--primary"
                            disabled={mode === "submitting" || !draftCanSubmit}
                          >
                            {mode === "submitting" ? "Saving…" : "Save idea"}
                          </button>
                        )
                      : null}
                  </div>
                </form>
              )}
          </section>
        )
        : null}
    </IdeaCaptureContext.Provider>
  );
}
