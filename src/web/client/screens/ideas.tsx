import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { ProjectRecord } from "../../../domain/index.js";
import {
  apiPath,
  type IdeaInboxItemDto,
  type IdeaInboxPageResponse,
} from "../../contracts.js";
import { apiRequest } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { useIdeaCapture } from "../components/idea-capture.js";
import {
  StatusChip,
  type StatusTone,
} from "../components/status-chip.js";
import { navigate } from "../router.js";

export interface IdeasScreenProps {
  projectId: string;
}

type IdeasState =
  | { status: "loading"; projectId: string }
  | {
      status: "error";
      projectId: string;
      message: string;
    }
  | {
      status: "ready";
      projectId: string;
      items: IdeaInboxItemDto[];
      hasMore: boolean;
      nextCursor: string | null;
      loadingMore: boolean;
      loadMoreError: string | null;
      paginationAnnouncement: string | null;
    };

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formattedDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : dateTimeFormatter.format(date);
};

const displayLabel = (value: string): string =>
  value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());

const statusTone = (status: ProjectRecord["status"]): StatusTone =>
  status === "blocked" || status === "rejected"
    ? "attention"
    : status === "active" || status === "accepted" || status === "completed"
      ? "active"
      : "neutral";

const pageBelongsToProject = (
  page: IdeaInboxPageResponse,
  projectId: string,
): boolean => page.projectId === projectId &&
  page.items.every((item) => item.projectId === projectId);

const crossProjectMessage =
  "The idea inbox returned data for another project. Please retry.";

const appendUniqueItems = (
  current: IdeaInboxItemDto[],
  incoming: IdeaInboxItemDto[],
): IdeaInboxItemDto[] => {
  const seen = new Set(current.map(({ id }) => id));
  const unique = incoming.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...current, ...unique];
};

const ideaPath = (item: IdeaInboxItemDto): string =>
  `/projects/${encodeURIComponent(item.projectId)}/ideas/${encodeURIComponent(item.id)}`;

const followRoute = (event: MouseEvent<HTMLAnchorElement>): void => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  navigate(`${event.currentTarget.pathname}${event.currentTarget.search}`);
};

function IdeaCard({ item }: { item: IdeaInboxItemDto }) {
  const detailPath = ideaPath(item);
  return (
    <li>
      <article className="idea-card" aria-label={item.title}>
        <div className="idea-card__heading">
          <h2>
            <a href={detailPath} onClick={followRoute}>{item.title}</a>
          </h2>
          <StatusChip tone={statusTone(item.status)}>
            {displayLabel(item.status)}
          </StatusChip>
        </div>
        <p>{item.bodyPreview}</p>
        <div className="idea-card__meta">
          <span>Captured</span>
          <time dateTime={item.createdAt}>{formattedDate(item.createdAt)}</time>
        </div>
        <a className="text-link" href={detailPath} onClick={followRoute}>
          View idea
        </a>
        {item.context.length > 0
          ? (
              <ul
                className="idea-card__context"
                aria-label={`Context for ${item.title}`}
              >
                {item.context.map((context) => (
                  <li key={context.id}>
                    <span>
                      {context.kind === "task"
                        ? "Task"
                        : displayLabel(context.kind)}
                    </span>
                    <strong>{context.title}</strong>
                  </li>
                ))}
              </ul>
            )
          : null}
      </article>
    </li>
  );
}

export function IdeasScreen({ projectId }: IdeasScreenProps) {
  const {
    available: captureAvailable,
    clearLatestCapture,
    latestCapture,
    open,
  } = useIdeaCapture();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<IdeasState>(() => ({
    status: "loading",
    projectId,
  }));
  const generationRef = useRef(0);
  const paginationControllerRef = useRef<AbortController | null>(null);
  const latestCaptureRef = useRef(latestCapture);
  latestCaptureRef.current = latestCapture;
  const matchingLatestCaptureId = latestCapture?.projectId === projectId
    ? latestCapture.item.id
    : null;
  const observedLatestCaptureRef = useRef({
    projectId,
    captureId: matchingLatestCaptureId,
  });

  useEffect(() => {
    paginationControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    setState({ status: "loading", projectId });
    apiRequest<IdeaInboxPageResponse>(
      apiPath("projects", projectId, "ideas"),
      { signal: controller.signal },
    ).then(
      (page) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        if (!pageBelongsToProject(page, projectId)) {
          setState({
            status: "error",
            projectId,
            message: crossProjectMessage,
          });
          return;
        }
        const latest = latestCaptureRef.current;
        if (
          latest?.projectId === projectId &&
          page.items.some(({ id }) => id === latest.item.id)
        ) {
          clearLatestCapture(projectId, latest.item.id);
        }
        setState({
          status: "ready",
          projectId,
          items: appendUniqueItems([], page.items),
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          loadingMore: false,
          loadMoreError: null,
          paginationAnnouncement: null,
        });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        setState({
          status: "error",
          projectId,
          message: reason instanceof Error
            ? reason.message
            : "Could not read the idea inbox.",
        });
      },
    );
    return () => controller.abort();
  }, [clearLatestCapture, projectId, reloadKey]);

  useEffect(() => {
    const observed = observedLatestCaptureRef.current;
    if (observed.projectId !== projectId) {
      observedLatestCaptureRef.current = {
        projectId,
        captureId: matchingLatestCaptureId,
      };
      return;
    }
    if (observed.captureId === matchingLatestCaptureId) return;
    observedLatestCaptureRef.current = {
      projectId,
      captureId: matchingLatestCaptureId,
    };
    if (matchingLatestCaptureId !== null) {
      setReloadKey((key) => key + 1);
    }
  }, [matchingLatestCaptureId, projectId]);

  useEffect(() => () => paginationControllerRef.current?.abort(), []);

  const loadMore = () => {
    if (
      state.status !== "ready" ||
      state.projectId !== projectId ||
      state.loadingMore ||
      !state.hasMore ||
      state.nextCursor === null
    ) return;

    paginationControllerRef.current?.abort();
    const controller = new AbortController();
    paginationControllerRef.current = controller;
    const generation = ++generationRef.current;
    const cursor = state.nextCursor;
    setState((current) => current.status === "ready" &&
        current.projectId === projectId
      ? {
          ...current,
          loadingMore: true,
          loadMoreError: null,
          paginationAnnouncement: null,
        }
      : current);
    apiRequest<IdeaInboxPageResponse>(
      `${apiPath("projects", projectId, "ideas")}?cursor=${encodeURIComponent(cursor)}`,
      { signal: controller.signal },
    ).then(
      (page) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        if (!pageBelongsToProject(page, projectId)) {
          setState((current) => current.status === "ready" &&
              current.projectId === projectId
            ? {
                ...current,
                loadingMore: false,
                loadMoreError: crossProjectMessage,
              }
            : current);
          return;
        }
        const latest = latestCaptureRef.current;
        if (
          latest?.projectId === projectId &&
          page.items.some(({ id }) => id === latest.item.id)
        ) {
          clearLatestCapture(projectId, latest.item.id);
        }
        setState((current) => {
          if (current.status !== "ready" || current.projectId !== projectId) {
            return current;
          }
          const items = appendUniqueItems(current.items, page.items);
          const appendedCount = items.length - current.items.length;
          return {
            ...current,
            items,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            loadingMore: false,
            loadMoreError: null,
            paginationAnnouncement: `${appendedCount} more ${
              appendedCount === 1 ? "idea" : "ideas"
            } loaded.${page.hasMore ? "" : " All ideas are loaded."}`,
          };
        });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        setState((current) => current.status === "ready" &&
            current.projectId === projectId
          ? {
              ...current,
              loadingMore: false,
              loadMoreError: reason instanceof Error
                ? reason.message
                : "Could not load more ideas.",
            }
          : current);
      },
    );
  };

  const content = state.projectId !== projectId || state.status === "loading"
    ? (
        <AsyncState state="loading" message="Reading the idea inbox…" />
      )
    : state.status === "error" && latestCapture?.projectId === projectId
      ? (
          <>
            <div className="idea-inbox-recovery" role="status">
              <p>Idea saved. The inbox could not refresh yet.</p>
              <button
                className="primary-action"
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Retry ideas
              </button>
            </div>
            <ul className="idea-inbox" aria-label="Idea inbox">
              <IdeaCard item={latestCapture.item} />
            </ul>
          </>
        )
      : state.status === "error"
      ? (
          <AsyncState
            state="error"
            title="Could not load ideas"
            message={state.message}
            action={(
              <button
                className="primary-action"
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Retry ideas
              </button>
            )}
          />
        )
      : state.items.length === 0
        ? (
            <AsyncState
              state="empty"
              title="No ideas captured yet."
              message="Captured ideas will collect here for later review."
              action={captureAvailable
                ? (
                <button
                  className="primary-action"
                  type="button"
                  onClick={open}
                >
                  Capture idea
                </button>
                )
                : null}
            />
          )
        : (
            <>
              <ul className="idea-inbox" aria-label="Idea inbox">
                {state.items.map((item) => (
                  <IdeaCard key={item.id} item={item} />
                ))}
              </ul>
              {state.loadMoreError
                ? <p className="form-error" role="alert">{state.loadMoreError}</p>
                : null}
              {(state.hasMore && state.nextCursor !== null) ||
                  state.paginationAnnouncement !== null
                ? (
                    <div className="ideas-load-more">
                      <button
                        className="secondary-action"
                        type="button"
                        disabled={
                          state.loadingMore ||
                          !state.hasMore ||
                          state.nextCursor === null
                        }
                        onClick={loadMore}
                      >
                        {state.loadingMore
                          ? "Loading more…"
                          : state.hasMore
                            ? "Load more"
                            : "All ideas loaded"}
                      </button>
                      {state.paginationAnnouncement
                        ? <p role="status">{state.paginationAnnouncement}</p>
                        : null}
                    </div>
                  )
                : null}
            </>
          );

  return (
    <div className="ideas-screen">
      <header className="ideas-header">
        <div>
          <p className="stage__eyebrow">Project inbox</p>
          <h1>Ideas</h1>
        </div>
        {captureAvailable
          ? (
              <button className="primary-action" type="button" onClick={open}>
                Capture idea
              </button>
            )
          : null}
      </header>
      {content}
    </div>
  );
}
