import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import {
  apiErrorResponseSchema,
  repositoryRefreshApplyResponseSchema,
  repositoryRefreshResponseSchema,
  repositoryRefreshStateResponseSchema,
  repositoryRefreshReviewDtoSchema,
  repositoryRefreshStreamEventSchema,
  repositorySourceRecoveryResponseSchema,
} from "../../contracts.js";
import type { ChangeOperation } from "../../../domain/index.js";
import { ApiError, apiRequest } from "../api.js";
import type { DesktopRepositoryApi } from "../desktop-api.js";

type RepositoryRefreshReviewDto = z.infer<
  typeof repositoryRefreshReviewDtoSchema
>;
type RepositoryRefreshStreamEvent = z.infer<
  typeof repositoryRefreshStreamEventSchema
>;
type RepositorySourceStatus = z.infer<
  typeof repositoryRefreshStateResponseSchema
>["sourceStatus"];

class RepositoryStreamError extends Error {
  constructor(cause: unknown) {
    super("Could not read repository scan progress.", { cause });
    this.name = "RepositoryStreamError";
  }
}

type RefreshSurfaceState =
  | { readonly projectId: string; readonly status: "loading" }
  | {
      readonly projectId: string;
      readonly status: "empty";
      readonly message: string | null;
    }
  | {
      readonly projectId: string;
      readonly status: "scanning";
      readonly progress: number;
      readonly detail: string;
    }
  | {
      readonly projectId: string;
      readonly status: "review";
      readonly review: RepositoryRefreshReviewDto;
      readonly resumed: boolean;
      readonly scanComplete: boolean;
    }
  | {
      readonly projectId: string;
      readonly status: "outcome";
      readonly message: string;
    }
  | {
      readonly projectId: string;
      readonly status: "error";
      readonly message: string;
    };

interface RecoveryState {
  readonly projectId: string;
  readonly visible: boolean;
  readonly message: string;
  readonly error: boolean;
}

interface ConflictState {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly message: string;
}

type DialogState =
  | { readonly kind: "discard"; readonly review: RepositoryRefreshReviewDto }
  | { readonly kind: "detach" }
  | null;

export interface RepositoryRefreshProps {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly hasPrimaryRepository?: boolean;
  readonly desktopRepository?: DesktopRepositoryApi | null;
}

const diffKinds = [
  "added",
  "changed",
  "moved",
  "removed",
  "unchanged",
  "excluded",
  "conflicted",
] as const;

const readable = (value: string): string =>
  value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());

const errorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message.trim().length > 0
    ? reason.message
    : fallback;

const operationSummary = (operation: ChangeOperation): string => {
  switch (operation.type) {
    case "create_record":
      return `${readable(operation.kind)}: ${operation.title}`;
    case "update_record":
      return `Update ${operation.patch.title ?? operation.recordId}`;
    case "create_relationship":
      return `Create ${readable(operation.kind)} relationship`;
    case "remove_relationship":
      return `Remove relationship ${operation.relationshipId}`;
  }
};

const jsonBody = (value: unknown): string => JSON.stringify(value);

const readJson = async <Schema extends z.ZodType>(
  schema: Schema,
  path: string,
  init: RequestInit,
): Promise<z.infer<Schema>> => schema.parse(
  await apiRequest<unknown>(path, init),
);

const responseError = async (response: Response): Promise<ApiError> => {
  const parsed = apiErrorResponseSchema.parse(await response.json());
  return new ApiError(
    parsed.error.code,
    parsed.error.message,
    parsed.error.recoverable,
    response.status,
  );
};

const consumeNdjson = async (
  response: Response,
  requestController: AbortController,
  onEvent: (event: RepositoryRefreshStreamEvent) => void,
): Promise<void> => {
  const { signal } = requestController;
  if (!response.ok) throw await responseError(response);
  if (!response.body) {
    const error = new RepositoryStreamError(
      new Error("Repository scan progress was unavailable."),
    );
    requestController.abort(error);
    throw error;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-ndjson")) {
    const error = new RepositoryStreamError(
      new Error("Repository scan response was not NDJSON."),
    );
    await response.body.cancel().catch(() => undefined);
    requestController.abort(error);
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const emitLines = (): void => {
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.length === 0) continue;
      onEvent(repositoryRefreshStreamEventSchema.parse(JSON.parse(line)));
    }
  };

  let completed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      emitLines();
    }
    buffered += decoder.decode();
    const remainder = buffered.trim();
    buffered = "";
    if (remainder.length > 0) {
      for (const line of remainder.split("\n")) {
        if (line.trim().length > 0) {
          onEvent(repositoryRefreshStreamEventSchema.parse(JSON.parse(line)));
        }
      }
    }
    completed = true;
  } catch (reason) {
    const requestWasAborted = signal.aborted;
    if (!requestWasAborted) requestController.abort(reason);
    if (!requestWasAborted) {
      throw new RepositoryStreamError(reason);
    }
    throw reason;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
};

const boundedProgress = (
  previous: number,
  processed: number,
  total: number,
): number => {
  const next = total === 0 ? 0 : Math.round((processed / total) * 96);
  return Math.max(previous, Math.min(96, next));
};

export function RepositoryRefresh({
  projectId,
  projectRevision,
  hasPrimaryRepository = true,
  desktopRepository = null,
}: RepositoryRefreshProps) {
  const projectKeyRef = useRef(projectId);
  projectKeyRef.current = projectId;
  const lifecycleGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionControllerRef = useRef<AbortController | null>(null);
  const actionBusyRef = useRef(false);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const dialogPrimaryRef = useRef<HTMLButtonElement>(null);
  const dialogSecondaryRef = useRef<HTMLButtonElement>(null);
  const operationRefs = useRef(new Map<string, HTMLInputElement>());
  const [state, setState] = useState<RefreshSurfaceState>({
    projectId,
    status: "loading",
  });
  const [revisionState, setRevisionState] = useState({
    projectId,
    revision: projectRevision,
  });
  const [recovery, setRecovery] = useState<RecoveryState>({
    projectId,
    visible: false,
    message: "",
    error: false,
  });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [focusStartGeneration, setFocusStartGeneration] = useState(0);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [sourceState, setSourceState] = useState<{
    projectId: string;
    status: RepositorySourceStatus;
  }>({ projectId, status: null });
  const [attachPathState, setAttachPathState] = useState({ projectId, path: "" });

  const currentRevision = revisionState.projectId === projectId
    ? revisionState.revision
    : projectRevision;
  const currentState: RefreshSurfaceState = state.projectId === projectId
    ? state
    : { projectId, status: "loading" };
  const currentRecovery = recovery.projectId === projectId
    ? recovery
    : { projectId, visible: false, message: "", error: false };
  const currentConflict = conflict?.projectId === projectId ? conflict : null;
  const currentSourceStatus = sourceState.projectId === projectId
    ? sourceState.status
    : null;
  const attachPath = attachPathState.projectId === projectId ? attachPathState.path : "";

  const isCurrentAction = useCallback((generation: number): boolean =>
    generation === actionGenerationRef.current && projectKeyRef.current === projectId,
  [projectId]);

  useEffect(() => {
    actionControllerRef.current?.abort();
    actionBusyRef.current = false;
    actionGenerationRef.current += 1;
    const generation = ++lifecycleGenerationRef.current;
    const controller = new AbortController();
    setState({ projectId, status: "loading" });
    setRevisionState({ projectId, revision: projectRevision });
    setRecovery({ projectId, visible: false, message: "", error: false });
    setConflict(null);
    setActionError(null);
    setActionStatus(null);
    setSelectionPending(false);
    setApplyPending(false);
    setDialog(null);
    setSourceState({ projectId, status: null });
    setAttachPathState({ projectId, path: "" });

    void readJson(
      repositoryRefreshStateResponseSchema,
      `/api/projects/${encodeURIComponent(projectId)}/repository-refresh`,
      { signal: controller.signal },
    ).then(({ review, sourceStatus }) => {
      if (
        controller.signal.aborted ||
        generation !== lifecycleGenerationRef.current ||
        projectKeyRef.current !== projectId
      ) return;
      if (review !== null && review.projectId !== projectId) {
        setState({
          projectId,
          status: "error",
          message: "The repository refresh did not match this project.",
        });
        return;
      }
      if (sourceStatus === "unavailable") {
        setRecovery({
          projectId,
          visible: true,
          message: "The registered repository is unavailable.",
          error: true,
        });
      }
      setSourceState({ projectId, status: sourceStatus });
      setState(review === null
        ? { projectId, status: "empty", message: null }
        : { projectId, status: "review", review, resumed: true, scanComplete: false });
    }, (reason: unknown) => {
      if (
        controller.signal.aborted ||
        generation !== lifecycleGenerationRef.current ||
        projectKeyRef.current !== projectId
      ) return;
      setState({
        projectId,
        status: "error",
        message: errorMessage(reason, "Could not load the repository refresh."),
      });
    });
    return () => {
      controller.abort();
      actionGenerationRef.current += 1;
      actionControllerRef.current?.abort();
      actionBusyRef.current = false;
    };
  }, [projectId, projectRevision, reloadGeneration]);

  useEffect(() => {
    if (focusStartGeneration > 0 && currentState.status === "empty") {
      startButtonRef.current?.focus();
    }
  }, [currentState.status, focusStartGeneration]);

  useEffect(() => {
    if (dialog !== null) dialogPrimaryRef.current?.focus();
  }, [dialog]);

  const beginAction = (): { controller: AbortController; generation: number } | null => {
    if (actionBusyRef.current) return null;
    actionBusyRef.current = true;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    return { controller, generation: ++actionGenerationRef.current };
  };

  const finishAction = (generation: number): void => {
    if (generation === actionGenerationRef.current) actionBusyRef.current = false;
  };

  const runStream = async (
    path: string,
    body: unknown,
    controller: AbortController,
    generation: number,
  ): Promise<RepositoryRefreshReviewDto | null> => {
    const reviews: RepositoryRefreshReviewDto[] = [];
    let progress = 0;
    setActionError(null);
    setActionStatus(null);
    setConflict(null);
    setState({
      projectId,
      status: "scanning",
      progress: 0,
      detail: "Starting repository scan…",
    });
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: jsonBody(body),
      signal: controller.signal,
    });
    await consumeNdjson(response, controller, (event) => {
      if (!isCurrentAction(generation) || controller.signal.aborted) return;
      if (event.type === "progress") {
        if (reviews.length > 0) {
          throw new Error("Repository scan progress followed the final review.");
        }
        progress = boundedProgress(
          progress,
          event.progress.processed,
          event.progress.total,
        );
        setState({
          projectId,
          status: "scanning",
          progress,
          detail: `${readable(event.progress.phase)}: ${event.progress.processed} of ${event.progress.total}`,
        });
      } else {
        if (reviews.length > 0) {
          throw new Error("Repository scan produced more than one final review.");
        }
        reviews.push(event.review);
      }
    });
    if (!isCurrentAction(generation) || controller.signal.aborted) return null;
    const review = reviews[0];
    if (review === undefined) {
      throw new Error("Repository scan did not produce a review.");
    }
    if (review.projectId !== projectId) {
      throw new Error("The repository refresh did not match this project.");
    }
    setState({
      projectId,
      status: "review",
      review,
      resumed: false,
      scanComplete: true,
    });
    return review;
  };

  const handleScanFailure = (reason: unknown): void => {
    if (reason instanceof ApiError && reason.code === "repository_unavailable") {
      setState({ projectId, status: "empty", message: null });
      setRecovery({
        projectId,
        visible: true,
        message: reason.message,
        error: true,
      });
      return;
    }
    setState({
      projectId,
      status: "error",
      message: errorMessage(reason, "Could not scan the repository."),
    });
  };

  const startScan = async (): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    try {
      await runStream(
        `/api/projects/${encodeURIComponent(projectId)}/repository-refreshes`,
        {},
        action.controller,
        action.generation,
      );
    } catch (reason) {
      if (
        isCurrentAction(action.generation) &&
        (!action.controller.signal.aborted || reason instanceof RepositoryStreamError)
      ) {
        handleScanFailure(reason);
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const reconcileCancelledScan = async (): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    setState({ projectId, status: "loading" });
    setActionStatus(null);
    try {
      const { review, sourceStatus } = await readJson(
        repositoryRefreshStateResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-refresh`,
        { signal: action.controller.signal },
      );
      if (!isCurrentAction(action.generation)) return;
      if (review !== null && review.projectId !== projectId) {
        throw new Error("The repository refresh did not match this project.");
      }
      setSourceState({ projectId, status: sourceStatus });
      setRecovery(sourceStatus === "unavailable"
        ? {
            projectId,
            visible: true,
            message: "The registered repository is unavailable.",
            error: true,
          }
        : { projectId, visible: false, message: "", error: false });
      if (review === null) {
        setState({
          projectId,
          status: "empty",
          message: "Scan cancelled. No accepted repository state changed.",
        });
        setFocusStartGeneration((value) => value + 1);
      } else {
        setState({
          projectId,
          status: "review",
          review,
          resumed: true,
          scanComplete: false,
        });
        setActionStatus(
          "Scan cancelled. No accepted repository state changed. A saved candidate is ready to review.",
        );
      }
    } catch (reason) {
      if (!action.controller.signal.aborted && isCurrentAction(action.generation)) {
        setState({
          projectId,
          status: "error",
          message: `Scan cancelled. No accepted repository state changed. ${errorMessage(
            reason,
            "Could not check for a saved candidate.",
          )}`,
        });
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const cancelScan = (): void => {
    if (currentState.status !== "scanning") return;
    actionGenerationRef.current += 1;
    actionControllerRef.current?.abort();
    actionBusyRef.current = false;
    void reconcileCancelledScan();
  };

  const updateSelection = async (
    review: RepositoryRefreshReviewDto,
    operationId: string,
  ): Promise<void> => {
    if (selectionPending || applyPending || actionBusyRef.current) return;
    const action = beginAction();
    if (!action) return;
    const selected = new Set(review.selectedOperationIds);
    if (selected.has(operationId)) selected.delete(operationId);
    else selected.add(operationId);
    setSelectionPending(true);
    setActionError(null);
    try {
      const result = await readJson(
        repositoryRefreshResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-refresh/${encodeURIComponent(review.snapshotId)}`,
        {
          method: "PATCH",
          body: jsonBody({
            projectId,
            snapshotId: review.snapshotId,
            selectedOperationIds: [...selected],
          }),
          signal: action.controller.signal,
        },
      );
      if (
        !isCurrentAction(action.generation) ||
        result.review === null ||
        result.review.projectId !== projectId ||
        result.review.snapshotId !== review.snapshotId
      ) return;
      setState({
        projectId,
        status: "review",
        review: result.review,
        resumed: currentState.status === "review" && currentState.resumed,
        scanComplete: currentState.status === "review" && currentState.scanComplete,
      });
    } catch (reason) {
      if (!action.controller.signal.aborted && isCurrentAction(action.generation)) {
        if (reason instanceof ApiError && reason.code === "repository_refresh_conflict") {
          setConflict({ projectId, snapshotId: review.snapshotId, message: reason.message });
        } else {
          setActionError(errorMessage(reason, "Could not save semantic selection."));
        }
      }
    } finally {
      if (isCurrentAction(action.generation)) setSelectionPending(false);
      finishAction(action.generation);
    }
  };

  const applyReview = async (review: RepositoryRefreshReviewDto): Promise<void> => {
    if (selectionPending || applyPending || actionBusyRef.current) return;
    const action = beginAction();
    if (!action) return;
    setApplyPending(true);
    setActionError(null);
    try {
      const result = await readJson(
        repositoryRefreshApplyResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-refresh/${encodeURIComponent(review.snapshotId)}/apply`,
        {
          method: "POST",
          body: jsonBody({
            projectId,
            snapshotId: review.snapshotId,
            expectedProjectRevision: review.baseProjectRevision,
          }),
          signal: action.controller.signal,
        },
      );
      if (
        !isCurrentAction(action.generation) ||
        result.snapshotId !== review.snapshotId
      ) return;
      setState({
        projectId,
        status: "outcome",
        message: result.proposalId === null
          ? "Repository refresh accepted. Project meaning was unchanged."
          : "Repository refresh accepted and proposal created.",
      });
      setRecovery({ projectId, visible: false, message: "", error: false });
    } catch (reason) {
      if (action.controller.signal.aborted || !isCurrentAction(action.generation)) return;
      if (reason instanceof ApiError && reason.code === "repository_refresh_conflict") {
        setConflict({ projectId, snapshotId: review.snapshotId, message: reason.message });
      } else if (reason instanceof ApiError && reason.code === "repository_unavailable") {
        setRecovery({ projectId, visible: true, message: reason.message, error: true });
      } else {
        setActionError(errorMessage(reason, "Could not accept the repository refresh."));
      }
    } finally {
      if (isCurrentAction(action.generation)) setApplyPending(false);
      finishAction(action.generation);
    }
  };

  const scanAgain = async (review: RepositoryRefreshReviewDto): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    setActionError(null);
    try {
      await readJson(
        repositoryRefreshResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-refresh/${encodeURIComponent(review.snapshotId)}/cancel`,
        {
          method: "POST",
          body: jsonBody({ projectId, snapshotId: review.snapshotId, confirmed: true }),
          signal: action.controller.signal,
        },
      );
      if (!isCurrentAction(action.generation)) return;
      await runStream(
        `/api/projects/${encodeURIComponent(projectId)}/repository-refreshes`,
        {},
        action.controller,
        action.generation,
      );
    } catch (reason) {
      if (
        isCurrentAction(action.generation) &&
        (!action.controller.signal.aborted || reason instanceof RepositoryStreamError)
      ) {
        handleScanFailure(reason);
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const discardCandidate = async (review: RepositoryRefreshReviewDto): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    setActionError(null);
    try {
      await readJson(
        repositoryRefreshResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-refresh/${encodeURIComponent(review.snapshotId)}/cancel`,
        {
          method: "POST",
          body: jsonBody({ projectId, snapshotId: review.snapshotId, confirmed: true }),
          signal: action.controller.signal,
        },
      );
      if (!isCurrentAction(action.generation)) return;
      setDialog(null);
      setConflict(null);
      setState({ projectId, status: "empty", message: "Repository refresh discarded." });
      setFocusStartGeneration((value) => value + 1);
    } catch (reason) {
      if (!action.controller.signal.aborted && isCurrentAction(action.generation)) {
        closeDialog();
        setActionError(errorMessage(reason, "Could not discard the repository refresh."));
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const retrySource = async (): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    try {
      if (currentState.status === "review") {
        const review = currentState.review;
        await readJson(
          repositoryRefreshResponseSchema,
          `/api/projects/${encodeURIComponent(projectId)}/repository-refresh/${encodeURIComponent(review.snapshotId)}/cancel`,
          {
            method: "POST",
            body: jsonBody({ projectId, snapshotId: review.snapshotId, confirmed: true }),
            signal: action.controller.signal,
          },
        );
        if (!isCurrentAction(action.generation)) return;
      }
      await runStream(
        `/api/projects/${encodeURIComponent(projectId)}/repository-source/retry`,
        { expectedProjectRevision: currentRevision },
        action.controller,
        action.generation,
      );
      if (isCurrentAction(action.generation)) {
        setRecovery({ projectId, visible: false, message: "", error: false });
        setActionStatus("Repository evidence is available for review.");
      }
    } catch (reason) {
      if (
        isCurrentAction(action.generation) &&
        (!action.controller.signal.aborted || reason instanceof RepositoryStreamError)
      ) {
        handleScanFailure(reason);
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const locateSource = async (): Promise<void> => {
    if (desktopRepository === null || actionBusyRef.current) return;
    const action = beginAction();
    if (!action) return;
    setActionError(null);
    try {
      const root = await desktopRepository.chooseRepositoryDirectory();
      if (!isCurrentAction(action.generation) || root === null) return;
      const result = await readJson(
        repositorySourceRecoveryResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-source/locate`,
        {
          method: "POST",
          body: jsonBody({ root, expectedProjectRevision: currentRevision }),
          signal: action.controller.signal,
        },
      );
      if (!isCurrentAction(action.generation)) return;
      setRevisionState({ projectId, revision: result.projectRevision });
      setSourceState({ projectId, status: "available" });
      setRecovery({
        projectId,
        visible: true,
        message: "Repository location verified. Retry to review current evidence.",
        error: false,
      });
    } catch (reason) {
      if (action.controller.signal.aborted || !isCurrentAction(action.generation)) return;
      const message = reason instanceof ApiError && reason.code === "repository_refresh_conflict"
        ? "The selected folder is not the registered repository. Nothing changed."
        : errorMessage(reason, "Could not locate the repository.");
      setRecovery({ projectId, visible: true, message, error: true });
    } finally {
      finishAction(action.generation);
    }
  };

  const browseAttachSource = async (): Promise<void> => {
    if (desktopRepository === null || actionBusyRef.current) return;
    setActionError(null);
    try {
      const root = await desktopRepository.chooseRepositoryDirectory();
      if (projectKeyRef.current === projectId && root !== null) {
        setAttachPathState({ projectId, path: root });
      }
    } catch (reason) {
      if (projectKeyRef.current === projectId) {
        setActionError(errorMessage(reason, "Could not browse for a repository."));
      }
    }
  };

  const attachSource = async (): Promise<void> => {
    const root = attachPath.trim();
    if (root.length === 0) {
      setActionError("Choose or enter a repository folder.");
      return;
    }
    const action = beginAction();
    if (!action) return;
    setActionError(null);
    try {
      const review = await runStream(
        `/api/projects/${encodeURIComponent(projectId)}/repository-source/attach`,
        { root, expectedProjectRevision: currentRevision },
        action.controller,
        action.generation,
      );
      if (review !== null && isCurrentAction(action.generation)) {
        setRevisionState({ projectId, revision: review.baseProjectRevision });
        setSourceState({ projectId, status: "available" });
        setRecovery({ projectId, visible: false, message: "", error: false });
      }
    } catch (reason) {
      if (
        isCurrentAction(action.generation) &&
        (!action.controller.signal.aborted || reason instanceof RepositoryStreamError)
      ) {
        setState({ projectId, status: "empty", message: null });
        setActionError(errorMessage(reason, "Could not attach this repository."));
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const detachSource = async (): Promise<void> => {
    const action = beginAction();
    if (!action) return;
    setActionError(null);
    try {
      const result = await readJson(
        repositorySourceRecoveryResponseSchema,
        `/api/projects/${encodeURIComponent(projectId)}/repository-source/detach`,
        {
          method: "POST",
          body: jsonBody({ confirmed: true, expectedProjectRevision: currentRevision }),
          signal: action.controller.signal,
        },
      );
      if (!isCurrentAction(action.generation)) return;
      setRevisionState({ projectId, revision: result.projectRevision });
      setSourceState({ projectId, status: "detached" });
      setDialog(null);
      setRecovery({ projectId, visible: false, message: "", error: false });
      setState({
        projectId,
        status: "outcome",
        message: "Repository detached. Accepted indexed metadata remains in the archive.",
      });
    } catch (reason) {
      if (!action.controller.signal.aborted && isCurrentAction(action.generation)) {
        setDialog(null);
        setRecovery({
          projectId,
          visible: true,
          message: errorMessage(reason, "Could not detach the repository."),
          error: true,
        });
      }
    } finally {
      finishAction(action.generation);
    }
  };

  const closeDialog = (): void => {
    const kind = dialog?.kind;
    setDialog(null);
    queueMicrotask(() => {
      if (kind === "discard") discardButtonRef.current?.focus();
    });
  };

  const dialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    } else if (event.key === "Tab") {
      const primary = dialogPrimaryRef.current;
      const secondary = dialogSecondaryRef.current;
      if (!primary || !secondary) return;
      if (event.shiftKey && document.activeElement === primary) {
        event.preventDefault();
        secondary.focus();
      } else if (!event.shiftKey && document.activeElement === secondary) {
        event.preventDefault();
        primary.focus();
      }
    }
  };

  const handleOperationKey = (
    event: KeyboardEvent<HTMLInputElement>,
    operations: readonly ChangeOperation[],
    index: number,
    review: RepositoryRefreshReviewDto,
  ): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + offset + operations.length) % operations.length;
      operationRefs.current.get(operations[next]!.operationId)?.focus();
    } else if (event.key === " ") {
      event.preventDefault();
      void updateSelection(review, operations[index]!.operationId);
    }
  };

  const renderRecovery = currentRecovery.visible ? (
    <section className="repository-recovery" aria-labelledby="repository-recovery-heading">
      <h2 id="repository-recovery-heading">Repository unavailable</h2>
      <p role={currentRecovery.error ? "alert" : "status"}>{currentRecovery.message}</p>
      <p>Accepted indexed metadata remains available in IntentArc while the source is recovered.</p>
      <div className="repository-refresh__actions">
        <button type="button" disabled={actionBusyRef.current} onClick={() => void retrySource()}>
          Retry
        </button>
        {desktopRepository === null
          ? <p>Locate is available in the desktop app.</p>
          : (
              <button type="button" disabled={actionBusyRef.current} onClick={() => void locateSource()}>
                Locate repository
              </button>
            )}
        <button type="button" disabled={actionBusyRef.current} onClick={() => setDialog({ kind: "detach" })}>
          Detach repository
        </button>
      </div>
    </section>
  ) : null;

  let content;
  if (currentState.status === "loading") {
    content = <p role="status">Loading repository refresh…</p>;
  } else if (currentState.status === "error") {
    content = (
      <div role="alert" className="repository-refresh__message">
        <p>{currentState.message}</p>
        <button type="button" onClick={() => setReloadGeneration((value) => value + 1)}>
          Try again
        </button>
      </div>
    );
  } else if (currentState.status === "empty") {
    const needsAttach =
      (currentSourceStatus === null && !hasPrimaryRepository) ||
      currentSourceStatus === "detached";
    content = (
      <div className="repository-refresh__start">
        {currentState.message !== null ? <p role="status">{currentState.message}</p> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
        {!currentRecovery.visible && needsAttach ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            void attachSource();
          }}>
            <label htmlFor="repository-attach-path">Repository folder</label>
            <div className="repository-refresh__actions">
              <input
                id="repository-attach-path"
                value={attachPath}
                onChange={(event) => setAttachPathState({
                  projectId,
                  path: event.currentTarget.value,
                })}
              />
              {desktopRepository === null ? null : (
                <button type="button" onClick={() => void browseAttachSource()}>Browse</button>
              )}
              <button type="submit">Attach and review</button>
            </div>
          </form>
        ) : !currentRecovery.visible ? (
          <button ref={startButtonRef} type="button" onClick={() => void startScan()}>
            Scan repository
          </button>
        ) : null}
        <p>Scans are manual and read-only. IntentArc never watches or edits the repository.</p>
      </div>
    );
  } else if (currentState.status === "scanning") {
    content = (
      <section className="repository-refresh__progress" aria-labelledby="repository-scan-heading">
        <h2 id="repository-scan-heading">Scanning repository</h2>
        <progress max={100} value={currentState.progress}>Scan progress</progress>
        <p role="status" aria-live="polite">{currentState.detail}</p>
        <button type="button" onClick={cancelScan}>Cancel scan</button>
      </section>
    );
  } else if (currentState.status === "outcome") {
    content = (
      <section className="repository-refresh__outcome" aria-labelledby="repository-outcome-heading">
        <h2 id="repository-outcome-heading">Refresh outcome</h2>
        <p role="status">{currentState.message}</p>
        <a href={`/projects/${encodeURIComponent(projectId)}/documentation`}>Return to Documentation</a>
      </section>
    );
  } else {
    const { review } = currentState;
    const groupByKind = new Map(review.diff.groups.map((group) => [group.kind, group]));
    const exclusionCounts = Object.entries(review.exclusionCounts)
      .filter((entry): entry is [string, number] => entry[1] > 0)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const exclusionTotal = exclusionCounts.reduce(
      (total, [, count]) => total + count,
      0,
    );
    const conflictOperationIds = new Set(
      groupByKind.get("conflicted")?.entries.map(({ operationId }) => operationId) ?? [],
    );
    const selected = new Set(review.selectedOperationIds);
    const reviewConflict = currentConflict?.snapshotId === review.snapshotId
      ? currentConflict
      : review.state === "conflicted"
        ? {
            projectId,
            snapshotId: review.snapshotId,
            message: "Repository evidence or project state changed. Review a fresh scan.",
          }
        : null;
    content = (
      <div className="repository-refresh__review">
        <div className="repository-refresh__review-status">
          {currentState.resumed ? <p role="status">Resumed pending review</p> : null}
          {currentState.scanComplete ? (
            <>
              <progress max={100} value={100}>Scan progress</progress>
              <p role="status">Scan complete</p>
            </>
          ) : null}
          <dl><div><dt>Snapshot</dt><dd>{review.snapshotId}</dd></div></dl>
        </div>
        {review.warningCounts.working_tree_dirty
          ? (
              <p className="repository-refresh__warning" role="status">
                The working tree has {review.warningCounts.working_tree_dirty} uncommitted changes. Review the captured facts carefully.
              </p>
            )
          : null}
        {reviewConflict ? <p role="alert">{reviewConflict.message}</p> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
        {actionStatus ? <p role="status">{actionStatus}</p> : null}

        <section className="repository-refresh__facts" aria-labelledby="repository-facts-heading">
          <h2 id="repository-facts-heading">Repository facts</h2>
          <p>These are observed index facts. They are not selectable project meaning.</p>
          <div className="repository-refresh__groups">
            {diffKinds.map((kind) => {
              const entries = groupByKind.get(kind)?.entries ?? [];
              const count = kind === "excluded" ? exclusionTotal : entries.length;
              return (
                <section key={kind} aria-labelledby={`repository-diff-${kind}`}>
                  <h3 id={`repository-diff-${kind}`}>{readable(kind)} ({count})</h3>
                  {kind === "excluded" ? (
                    exclusionCounts.length === 0 ? <p>None</p> : (
                      <ul>{exclusionCounts.map(([reason, reasonCount]) => (
                        <li key={reason}>{readable(reason)}: {reasonCount}</li>
                      ))}</ul>
                    )
                  ) : entries.length === 0 ? <p>None</p> : (
                    <ul>{entries.map((entry) => (
                      <li key={entry.operationId}>
                        <span>{entry.previousPath ?? "New"}</span>
                        {entry.currentPath !== null && entry.previousPath !== entry.currentPath
                          ? <span aria-hidden="true"> → </span>
                          : null}
                        {entry.currentPath !== null && entry.previousPath !== entry.currentPath
                          ? <span>{entry.currentPath}</span>
                          : null}
                      </li>
                    ))}</ul>
                  )}
                </section>
              );
            })}
          </div>
        </section>

        <section className="repository-refresh__meaning" aria-labelledby="repository-meaning-heading">
          <h2 id="repository-meaning-heading">Proposed project meaning</h2>
          <p>Inferences start unselected. Selected items create a governed proposal; they do not become accepted automatically.</p>
          {review.diff.semanticOperations.length === 0
            ? <p>No project meaning was inferred from this refresh.</p>
            : (
                <ul aria-label="Semantic proposals">
                  {review.diff.semanticOperations.map((operation, index, operations) => {
                    const isConflicting =
                      conflictOperationIds.has(operation.operationId) ||
                      reviewConflict !== null;
                    return (
                      <li key={operation.operationId} className={isConflicting ? "repository-refresh__semantic--conflict" : undefined}>
                        <label>
                          <input
                            ref={(element) => {
                              if (element === null) operationRefs.current.delete(operation.operationId);
                              else operationRefs.current.set(operation.operationId, element);
                            }}
                            type="checkbox"
                            checked={selected.has(operation.operationId)}
                            disabled={
                              selectionPending || applyPending ||
                              reviewConflict !== null || currentRecovery.visible
                            }
                            onChange={() => void updateSelection(review, operation.operationId)}
                            onKeyDown={(event) => handleOperationKey(event, operations, index, review)}
                          />
                          <span>{operationSummary(operation)}</span>
                        </label>
                        <span>{isConflicting ? "Conflicting proposal" : "Pending inference"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
        </section>

        <div className="repository-refresh__actions">
          {reviewConflict !== null ? (
            <button type="button" onClick={() => void scanAgain(review)}>Scan again</button>
          ) : !currentRecovery.visible ? (
            <button
              type="button"
              disabled={selectionPending || applyPending}
              onClick={() => void applyReview(review)}
            >
              {selected.size === 0
                ? "Accept repository refresh"
                : "Accept refresh and create proposal"}
            </button>
          ) : null}
          <button
            ref={discardButtonRef}
            type="button"
            disabled={selectionPending || applyPending}
            onClick={() => setDialog({ kind: "discard", review })}
          >
            Discard candidate
          </button>
          <a href={`/projects/${encodeURIComponent(projectId)}/documentation`}>
            Leave and resume later
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="repository-refresh">
      <div className="stage__header">
        <div>
          <p className="stage__eyebrow">Repository · explicit review</p>
          <h1>Repository refresh</h1>
          <p className="stage__lede">
            Compare read-only repository facts, then decide whether any inferred meaning should become a proposal.
          </p>
        </div>
      </div>
      {content}
      {renderRecovery}
      {dialog !== null ? (
        <div
          className="repository-refresh__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="repository-refresh-dialog-title"
          onKeyDown={dialogKeyDown}
        >
          <h2 id="repository-refresh-dialog-title">
            {dialog.kind === "discard" ? "Discard repository refresh?" : "Detach repository?"}
          </h2>
          <p>
            {dialog.kind === "discard"
              ? "The reviewed candidate and its selections will be removed. Accepted repository facts stay unchanged."
              : "IntentArc will stop refreshing this source. Accepted indexed metadata stays in the archive."}
          </p>
          <div className="repository-refresh__actions">
            <button ref={dialogPrimaryRef} type="button" onClick={closeDialog}>
              {dialog.kind === "discard" ? "Keep review" : "Keep repository"}
            </button>
            <button ref={dialogSecondaryRef} type="button" onClick={() => {
              if (dialog.kind === "discard") void discardCandidate(dialog.review);
              else void detachSource();
            }}>
              {dialog.kind === "discard" ? "Discard refresh" : "Confirm detach"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
