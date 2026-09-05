import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { ProjectRecord } from "../../../domain/index.js";
import {
  apiPath,
  ideaDetailResponseSchema,
  type IdeaDetailResponse,
} from "../../contracts.js";
import { ApiError, apiRequest } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import {
  StatusChip,
  type StatusTone,
} from "../components/status-chip.js";
import { navigate } from "../router.js";

export interface IdeaDetailScreenProps {
  projectId: string;
  ideaId: string;
}

type IdeaDetailState =
  | { status: "loading"; projectId: string; ideaId: string }
  | { status: "not_found"; projectId: string; ideaId: string }
  | { status: "error"; projectId: string; ideaId: string; message: string; recoverable: boolean }
  | { status: "ready"; projectId: string; ideaId: string; detail: IdeaDetailResponse };

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formattedDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : dateTimeFormatter.format(date);
};

const displayLabel = (value: string): string =>
  value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());

const statusTone = (status: ProjectRecord["status"]): StatusTone =>
  status === "blocked" || status === "rejected"
    ? "attention"
    : status === "active" || status === "accepted" || status === "completed"
      ? "active"
      : "neutral";

const followRoute = (event: MouseEvent<HTMLAnchorElement>): void => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  navigate(`${event.currentTarget.pathname}${event.currentTarget.search}`);
};

const detailMatchesRoute = (
  detail: IdeaDetailResponse,
  projectId: string,
  ideaId: string,
): boolean => detail.projectId === projectId && detail.id === ideaId;

export function IdeaDetailScreen({ projectId, ideaId }: IdeaDetailScreenProps) {
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<IdeaDetailState>(() => ({
    status: "loading",
    projectId,
    ideaId,
  }));
  const generationRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    setState({ status: "loading", projectId, ideaId });
    apiRequest<unknown>(
      apiPath("projects", projectId, "ideas", ideaId),
      { signal: controller.signal },
    ).then((payload) => ideaDetailResponseSchema.parse(payload)).then(
      (detail) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        if (!detailMatchesRoute(detail, projectId, ideaId)) {
          setState({
            status: "error",
            projectId,
            ideaId,
            message: detail.projectId !== projectId
              ? "The idea detail did not match the current project."
              : "The idea detail returned another idea.",
            recoverable: false,
          });
          return;
        }
        setState({ status: "ready", projectId, ideaId, detail });
      },
      (reason: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        if (reason instanceof ApiError && reason.status === 404) {
          setState({ status: "not_found", projectId, ideaId });
          return;
        }
        setState({
          status: "error",
          projectId,
          ideaId,
          message: reason instanceof ApiError
            ? reason.message
            : "Could not read this idea.",
          recoverable: reason instanceof ApiError && reason.recoverable,
        });
      },
    );
    return () => controller.abort();
  }, [ideaId, projectId, retryKey]);

  const renderedState = state.projectId === projectId && state.ideaId === ideaId
    ? state
    : { status: "loading", projectId, ideaId } as const;

  if (renderedState.status === "loading") {
    return <AsyncState state="loading" message="Reading the complete idea…" />;
  }
  if (renderedState.status === "not_found") {
    const ideasPath = `/projects/${encodeURIComponent(projectId)}/ideas`;
    return (
      <AsyncState
        state="empty"
        title="Idea not found"
        message="This idea is not available in the project inbox."
        action={(
          <a className="text-link" href={ideasPath} onClick={followRoute}>
            Back to Ideas
          </a>
        )}
      />
    );
  }
  if (renderedState.status === "error") {
    return (
      <AsyncState
        state="error"
        title="Could not load idea"
        message={renderedState.message}
        action={renderedState.recoverable
          ? (
              <button
                className="primary-action"
                type="button"
                onClick={() => setRetryKey((key) => key + 1)}
              >
                Retry idea
              </button>
            )
          : null}
      />
    );
  }

  const { detail } = renderedState;
  return (
    <article className="idea-detail" aria-labelledby="idea-detail-title">
      <a
        className="text-link"
        href={`/projects/${encodeURIComponent(projectId)}/ideas`}
        onClick={followRoute}
      >
        Back to Ideas
      </a>
      <header className="idea-detail__header">
        <StatusChip tone={statusTone(detail.status)}>
          {displayLabel(detail.status)}
        </StatusChip>
        <h1 id="idea-detail-title">{detail.title}</h1>
      </header>
      <p className="idea-detail__body">{detail.body}</p>
      <section aria-labelledby="idea-detail-context">
        <h2 id="idea-detail-context">Related context</h2>
        {detail.context.length === 0
          ? <p>No task or component context was linked.</p>
          : (
              <ul className="idea-detail__context">
                {detail.context.map((context) => (
                  <li key={context.id}>
                    <a
                      href={`/projects/${encodeURIComponent(projectId)}/map?focusRecordId=${encodeURIComponent(context.id)}`}
                      onClick={followRoute}
                    >
                      {displayLabel(context.kind)} · {context.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
      </section>
      <section aria-labelledby="idea-detail-provenance">
        <h2 id="idea-detail-provenance">Current record</h2>
        <dl className="idea-detail__metadata">
          <div><dt>Source</dt><dd>{displayLabel(detail.sourceKind)}</dd></div>
          {detail.sourceRef === null
            ? null
            : <div><dt>Source reference</dt><dd>{detail.sourceRef}</dd></div>}
          <div><dt>Revision</dt><dd>Revision {detail.revision}</dd></div>
          <div><dt>Captured</dt><dd><time dateTime={detail.createdAt}>{formattedDate(detail.createdAt)}</time></dd></div>
          <div><dt>Updated</dt><dd><time dateTime={detail.updatedAt}>{formattedDate(detail.updatedAt)}</time></dd></div>
        </dl>
      </section>
    </article>
  );
}
