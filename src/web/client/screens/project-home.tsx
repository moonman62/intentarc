import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
} from "lucide-react";
import {
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isHierarchyRecordKind,
  type ProjectRecord,
} from "../../../domain/index.js";
import {
  apiPath,
  projectDashboardResponseSchemaFor,
  type ProjectDashboardResponse,
} from "../../contracts.js";
import { ApiError, apiRequest } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import {
  hierarchyLabel,
  type HierarchyKind,
} from "../components/hierarchy-label.js";
import { boundedPreview } from "../components/record-preview.js";
import { StatusChip, type StatusTone } from "../components/status-chip.js";
import { navigate } from "../router.js";

type DashboardState =
  | { status: "loading"; projectId: string }
  | {
      status: "error";
      projectId: string;
      message: string;
      recoverable: boolean;
    }
  | {
      status: "ready";
      projectId: string;
      dashboard: ProjectDashboardResponse;
    };

export interface ProjectHomeProps {
  projectId: string;
  onDashboardLoad?: (event: ProjectDashboardLoadEvent) => void;
}

export type ProjectDashboardLoadEvent =
  | {
      status: "loading";
      projectId: string;
      generation: number;
    }
  | {
      status: "error";
      projectId: string;
      generation: number;
    }
  | {
      status: "ready";
      projectId: string;
      generation: number;
      dashboard: ProjectDashboardResponse;
    };

let nextDashboardLoadGeneration = 0;

class InvalidProjectDashboardResponseError extends Error {
  constructor() {
    super("Could not validate this project dashboard.");
    this.name = "InvalidProjectDashboardResponseError";
  }
}

const toDisplayLabel = (value: string): string =>
  value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
const isHierarchyKind = (
  kind: ProjectRecord["kind"],
): kind is HierarchyKind => isHierarchyRecordKind(kind);

const statusTone = (status: ProjectRecord["status"]): StatusTone =>
  status === "blocked" || status === "rejected"
    ? "attention"
    : status === "active" || status === "accepted" || status === "completed"
      ? "active"
      : "neutral";

const followLink = (
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
): void => {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  event.preventDefault();
  navigate(path);
};

function RecordStatus({ record }: { record: ProjectRecord }) {
  const Icon = record.status === "blocked" || record.status === "rejected"
    ? AlertTriangle
    : record.status === "accepted" || record.status === "completed"
      ? Check
      : CircleDot;
  return (
    <StatusChip tone={statusTone(record.status)}>
      <Icon aria-hidden="true" size={12} strokeWidth={2.2} />
      {toDisplayLabel(record.status)}
    </StatusChip>
  );
}

function DashboardContent({
  dashboard,
}: {
  dashboard: ProjectDashboardResponse;
}) {
  const projectPath = `/projects/${encodeURIComponent(dashboard.project.id)}`;
  const taskPath = dashboard.currentTask
    ? `${projectPath}/tasks/${encodeURIComponent(dashboard.currentTask.id)}/handoff`
    : null;
  const proposalPath = `${projectPath}/proposals`;
  const proposalLabel = dashboard.pendingProposalCount === 1
    ? "1 pending proposal"
    : `${dashboard.pendingProposalCount} pending proposals`;
  const hasAttention = dashboard.attention !== null
    || dashboard.pendingProposalCount > 0;
  const mapPath = `${projectPath}/map`;
  const mapFocusPath = (recordId: string): string =>
    `${mapPath}?focusRecordId=${encodeURIComponent(recordId)}`;
  const recordPath = (record: ProjectRecord): string => record.kind === "task"
    ? `${projectPath}/tasks/${encodeURIComponent(record.id)}/handoff`
    : mapFocusPath(record.id);
  const hierarchyParentKinds = new Map(
    dashboard.hierarchyParentContexts.map(({ recordId, parentKind }) => [
      recordId,
      parentKind,
    ]),
  );
  const recordKindLabel = (
    record: Pick<ProjectRecord, "id" | "kind">,
  ): string => {
    if (!isHierarchyKind(record.kind)) return toDisplayLabel(record.kind);
    const parentKind = hierarchyParentKinds.get(record.id) ?? null;
    return hierarchyLabel(
      { kind: record.kind },
      parentKind === null ? null : { kind: parentKind },
      dashboard.hierarchyVocabulary,
    );
  };
  const recordOpenLabel = (
    record: Pick<ProjectRecord, "id" | "kind">,
  ): string => isHierarchyKind(record.kind)
    ? recordKindLabel(record)
    : record.kind;
  const currentTaskLabel = dashboard.currentTask
    ? recordKindLabel(dashboard.currentTask)
    : dashboard.hierarchyVocabulary.task;

  return (
    <div className="project-home">
      <header className="project-home__header">
        <h1>Overview</h1>
      </header>

      <div className="project-overview">
        <section
          className="project-overview__state"
          aria-label="Project state"
        >
          <p className="project-home__section-label">Project state</p>
          <h2 id="project-state-heading" className="project-overview__wrap">
            {dashboard.project.name}
          </h2>
          <code className="project-overview__identity">
            {dashboard.project.id}
          </code>
          <a
            className="text-link project-overview__record-link"
            href={mapPath}
            onClick={(event) => followLink(event, mapPath)}
          >
            Open project map
            <ArrowUpRight aria-hidden="true" size={16} />
          </a>
        </section>

        <section
          className="project-overview__focus"
          aria-label="Current focus"
        >
          <p className="project-home__section-label">Current focus</p>
          <nav
            aria-label="Current focus path"
            className="project-overview__path"
          >
            <ol>
              <li>
                <a
                  aria-label={`Project: ${dashboard.project.name} (${dashboard.project.id})`}
                  href={mapPath}
                  onClick={(event) => followLink(event, mapPath)}
                >
                  <span>Project</span>
                  <strong className="project-overview__wrap">
                    {dashboard.project.name}
                  </strong>
                  <code>{dashboard.project.id}</code>
                </a>
              </li>
              {dashboard.currentFocusPath.map((record) => {
                const path = mapFocusPath(record.id);
                const kind = recordKindLabel(record);
                return (
                  <li key={record.id}>
                    <ChevronRight aria-hidden="true" size={15} />
                    <a
                      aria-label={`${kind}: ${record.title} (${record.id})`}
                      href={path}
                      onClick={(event) => followLink(event, path)}
                    >
                      <span>{kind}</span>
                      <strong className="project-overview__wrap">
                        {record.title}
                      </strong>
                      <code>{record.id}</code>
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="project-overview__focus-content">
            {!dashboard.currentOutcome
              ? (
                  <p className="project-overview__missing">
                    {dashboard.hierarchyVocabulary.outcome} not established
                  </p>
                )
              : null}
            <div className="project-overview__task">
              <div className="project-overview__task-heading">
                <p className="project-overview__item-label">
                  Current {currentTaskLabel}
                </p>
                {dashboard.currentTask
                  ? <RecordStatus record={dashboard.currentTask} />
                  : null}
              </div>
              {dashboard.currentTask
                ? (
                    <>
                      <h3 className="project-overview__wrap">
                        {dashboard.currentTask.title}
                      </h3>
                      {dashboard.currentTask.body
                        ? (
                            <p className="project-overview__wrap">
                              {boundedPreview(dashboard.currentTask.body)}
                            </p>
                          )
                        : null}
                      {taskPath
                        ? (
                            <a
                              className="primary-action"
                              href={taskPath}
                              aria-label={`Open ${currentTaskLabel}: ${dashboard.currentTask.title}`}
                              onClick={(event) => followLink(event, taskPath)}
                            >
                              Open {currentTaskLabel}
                              <ArrowUpRight aria-hidden="true" size={17} />
                            </a>
                          )
                        : null}
                    </>
                  )
                : (
                    <h2 id="current-focus-heading">
                      No {dashboard.hierarchyVocabulary.task} in focus
                    </h2>
                  )}
            </div>
          </div>
        </section>

        {hasAttention
          ? (
              <section
                className="project-overview__attention"
                aria-label="Attention"
              >
                <p className="project-home__section-label">Attention</p>
                {dashboard.attention
                  ? (
                    <div>
                      <h2 id="attention-heading" className="project-overview__wrap">
                        <a
                          aria-label={`Open ${recordOpenLabel(dashboard.attention)} ${dashboard.attention.title}`}
                          href={recordPath(dashboard.attention)}
                          onClick={(event) => followLink(
                            event,
                            recordPath(dashboard.attention!),
                          )}
                        >
                          {dashboard.attention.title}
                        </a>
                      </h2>
                      <RecordStatus record={dashboard.attention} />
                      {dashboard.attention.body
                        ? (
                            <p className="project-overview__wrap">
                              {boundedPreview(dashboard.attention.body)}
                            </p>
                          )
                        : null}
                    </div>
                  )
                  : null}
                {dashboard.pendingProposalCount > 0
                  ? (
                      <div className="project-overview__proposals">
                        <a
                          className="secondary-action"
                          href={proposalPath}
                          onClick={(event) => followLink(event, proposalPath)}
                        >
                          {proposalLabel}
                          <ArrowUpRight aria-hidden="true" size={16} />
                        </a>
                      </div>
                    )
                  : null}
              </section>
            )
          : null}

        {dashboard.recentRecords.length > 0
          ? (
              <section
                className="project-overview__recent"
                aria-label="Recent changes"
              >
                <p className="project-home__section-label">Recent changes</p>
                <h2 id="recent-changes-heading">Recent changes</h2>
                <ul className="recent-changes__list" aria-label="Recent changes">
                  {dashboard.recentRecords.slice(0, 5).map((record) => (
                    <li key={record.id}>
                      <div>
                        <span className="recent-changes__kind">
                          {recordKindLabel(record)}
                        </span>
                        <strong className="project-overview__wrap">
                          <a
                            aria-label={`Open ${recordOpenLabel(record)} ${record.title}`}
                            href={recordPath(record)}
                            onClick={(event) => followLink(
                              event,
                              recordPath(record),
                            )}
                          >
                            {record.title}
                          </a>
                        </strong>
                      </div>
                      <RecordStatus record={record} />
                    </li>
                  ))}
                </ul>
              </section>
            )
          : null}
      </div>
    </div>
  );
}

export function ProjectHome({
  projectId,
  onDashboardLoad,
}: ProjectHomeProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<DashboardState>(() => ({
    status: "loading",
    projectId,
  }));
  const onDashboardLoadRef = useRef(onDashboardLoad);

  useEffect(() => {
    onDashboardLoadRef.current = onDashboardLoad;
  }, [onDashboardLoad]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++nextDashboardLoadGeneration;
    setState({ status: "loading", projectId });
    onDashboardLoadRef.current?.({
      status: "loading",
      projectId,
      generation,
    });
    apiRequest<unknown>(
      apiPath("projects", projectId, "dashboard"),
      { signal: controller.signal },
    ).then((body) => {
      const parsed = projectDashboardResponseSchemaFor(projectId).safeParse(body);
      if (!parsed.success) throw new InvalidProjectDashboardResponseError();
      return parsed.data;
    }).then(
      (dashboard) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", projectId, dashboard });
        onDashboardLoadRef.current?.({
          status: "ready",
          projectId,
          generation,
          dashboard,
        });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          projectId,
          message: reason instanceof InvalidProjectDashboardResponseError
            ? reason.message
            : reason instanceof Error
            ? reason.message
            : "Could not read this project dashboard.",
          recoverable: reason instanceof ApiError ? reason.recoverable : true,
        });
        onDashboardLoadRef.current?.({
          status: "error",
          projectId,
          generation,
        });
      },
    );
    return () => controller.abort();
  }, [projectId, reloadKey]);

  if (state.projectId !== projectId || state.status === "loading") {
    return (
      <AsyncState
        state="loading"
        message="Reading the project path…"
      />
    );
  }

  if (state.status === "error") {
    return (
      <AsyncState
        state="error"
        title="Could not load the project dashboard"
        message={state.message}
        action={state.recoverable
          ? (
              <button
                className="primary-action"
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Retry dashboard
              </button>
            )
          : undefined}
      />
    );
  }

  return <DashboardContent dashboard={state.dashboard} />;
}
