import {
  FolderInput,
  Plus,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Project } from "../../../domain/index.js";
import type { HubProject, ProjectHubResponse } from "../../contracts.js";
import { apiRequest } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
} from "../preferences.js";
import { navigate } from "../router.js";

export type ProjectsLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: HubProject[] };

export interface ProjectHubProps {
  state?: ProjectsLoadState;
  retry?: () => void;
  onProjectCreated?: ProjectCreatedHandler;
}

export interface ProjectCreationInput {
  name: string;
  primaryRepositoryPath: string | null;
}

export type ProjectCreatedHandler = (
  project: Project,
  signal: AbortSignal,
) => Promise<void>;

export const selectActiveProject = (
  projects: HubProject[],
  preferredId: string | null,
): HubProject | null =>
  projects.find(({ project }) => project.id === preferredId) ??
  [...projects].sort((left, right) =>
    right.project.updatedAt.localeCompare(left.project.updatedAt) ||
    left.project.id.localeCompare(right.project.id)
  )[0] ??
  null;

const activityDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const followRoute = (
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
) => {
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

const projectPath = (id: string): string =>
  `/projects/${encodeURIComponent(id)}`;

const defaultProjectCreatedHandler: ProjectCreatedHandler = async (
  project,
  signal,
) => {
  if (signal.aborted) return;
  savePreference(preferenceKeys.activeProject, project.id);
  navigate(projectPath(project.id));
};

export function useProjectCreation(
  onProjectCreated: ProjectCreatedHandler = defaultProjectCreatedHandler,
) {
  const controllerRef = useRef<AbortController | null>(null);
  const postedProjectRef = useRef<Project | null>(null);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);

  useEffect(
    () => () => controllerRef.current?.abort(),
    [],
  );

  const createProject = useCallback(async (
    input: ProjectCreationInput,
  ): Promise<boolean> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      let project = postedProjectRef.current;
      if (!project) {
        const response = await apiRequest<{ project: Project }>(
          "/api/projects",
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify(input),
          },
        );
        project = response.project;
        if (!controller.signal.aborted) {
          postedProjectRef.current = project;
          setPendingProject(project);
        }
      }
      if (controller.signal.aborted) return false;
      await onProjectCreated(project, controller.signal);
      postedProjectRef.current = null;
      if (controller.signal.aborted) return false;
      setPendingProject(null);
      return true;
    } catch (reason) {
      if (controller.signal.aborted) return false;
      throw reason;
    }
  }, [onProjectCreated]);

  return { createProject, pendingProject };
}

function CreateProjectDialog({
  onClose,
  createProject,
  pendingProject,
}: {
  onClose: () => void;
  createProject: ReturnType<typeof useProjectCreation>["createProject"];
  pendingProject: Project | null;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (pendingProject) {
      retryRef.current?.focus();
    } else {
      nameRef.current?.focus();
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!submitting) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), a[href]",
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
        (pendingProject ? retryRef.current : nameRef.current)?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, pendingProject, submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const repositoryPath = String(form.get("repositoryPath") ?? "");
    if (!pendingProject && name.trim().length === 0) {
      setError("Enter a project name to continue.");
      nameRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const completed = await createProject({
        name: name.trim(),
        primaryRepositoryPath:
          repositoryPath.trim().length === 0
            ? null
            : repositoryPath.trim(),
      });
      if (!completed) return;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create the project.",
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="project-dialog-layer">
      <button
        className="project-dialog-scrim"
        type="button"
        aria-label="Close new project dialog"
        disabled={submitting}
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <div className="project-dialog__header">
          <div>
            <p className="stage__eyebrow">New archive record</p>
            <h2 id="new-project-title">Start new project</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close new project dialog"
            disabled={submitting}
            onClick={onClose}
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>
        <form
          className="project-dialog__form"
          aria-label="Start new project"
          onSubmit={submit}
        >
          <div className="field">
            <label htmlFor="new-project-name">Project name</label>
            <input
              ref={nameRef}
              id="new-project-name"
              name="name"
              maxLength={200}
              disabled={Boolean(pendingProject)}
              aria-describedby={error
                ? "new-project-error"
                : pendingProject
                  ? "new-project-retry"
                  : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="new-project-repository">
              Repository path <span>(optional)</span>
            </label>
            <input
              id="new-project-repository"
              name="repositoryPath"
              disabled={Boolean(pendingProject)}
              placeholder="C:\projects\your-project"
            />
            <p className="field__hint">
              Use the absolute local path when a repository already exists.
            </p>
          </div>
          {error
            ? (
                <p id="new-project-error" className="form-error" role="alert">
                  {error}
                </p>
              )
            : null}
          {pendingProject
            ? (
                <p id="new-project-retry" role="status">
                  {pendingProject.name} was created. Retry loading it from the
                  archive; it will not be created again.
                </p>
              )
            : null}
          <div className="project-dialog__actions">
            <button
              className="secondary-action"
              type="button"
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              ref={retryRef}
              className="primary-action"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? pendingProject
                  ? "Retrying…"
                  : "Creating…"
                : pendingProject
                  ? "Retry opening project"
                  : "Create project"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EmptyProjectHub() {
  return (
    <AsyncState
      state="empty"
      title="No projects yet"
      message="Create or import a project."
    />
  );
}

function ProjectList({ projects }: {
  projects: HubProject[];
}) {
  return (
    <ul className="project-list" aria-label="Projects">
      {projects.map((entry) => {
        const path = projectPath(entry.project.id);
        const focus = entry.currentTask?.title ?? entry.currentOutcome?.title;
        const status = entry.attention
          ? `Needs attention: ${entry.attention.title}`
          : null;
        const activityDate = activityDateFormatter.format(
          new Date(entry.project.updatedAt),
        );
        return (
          <li key={entry.project.id} className="project-card">
            <article>
              <h3 className="project-card__name">{entry.project.name}</h3>
              {focus
                ? <p className="project-card__focus">Current focus: {focus}</p>
                : null}
              {status
                ? <p className="project-card__status">{status}</p>
                : null}
              <p className="project-card__activity">
                Last activity: <time dateTime={entry.project.updatedAt}>
                  {activityDate}
                </time>
              </p>
              <a
                className="secondary-action project-card__open"
                href={path}
                aria-label={`Open ${entry.project.name}`}
                onClick={(event) => {
                  savePreference(preferenceKeys.activeProject, entry.project.id);
                  followRoute(event, path);
                }}
              >
                Open
              </a>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectHub({
  state: controlledState,
  retry,
  onProjectCreated,
}: ProjectHubProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [internalState, setInternalState] = useState<ProjectsLoadState>({
    status: "loading",
  });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const startNewRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusAfterCloseRef = useRef(false);
  const projectCreation = useProjectCreation(onProjectCreated);

  useEffect(() => {
    if (controlledState) return;
    const controller = new AbortController();
    setInternalState({ status: "loading" });
    apiRequest<ProjectHubResponse>("/api/projects", {
      signal: controller.signal,
    }).then(
      ({ projects }) => {
        setInternalState({ status: "ready", projects });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setInternalState({
          status: "error",
          message: reason instanceof Error
            ? reason.message
            : "Could not read the project archive.",
        });
      },
    );
    return () => controller.abort();
  }, [controlledState, reloadKey]);

  const closeCreateDialog = useCallback(() => {
    returnFocusAfterCloseRef.current = true;
    setCreateDialogOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (createDialogOpen || !returnFocusAfterCloseRef.current) return;
    returnFocusAfterCloseRef.current = false;
    startNewRef.current?.focus();
  }, [createDialogOpen]);

  const state = controlledState ?? internalState;

  const openCreateDialog = (event: MouseEvent<HTMLButtonElement>) => {
    startNewRef.current = event.currentTarget;
    setCreateDialogOpen(true);
  };

  const header = (
    <header className="project-hub__header">
      <h1 id="projects-title">Projects</h1>
      {state.status === "ready"
        ? (
            <div className="project-hub__actions">
              <button
                ref={startNewRef}
                className="primary-action"
                type="button"
                onClick={openCreateDialog}
              >
                <Plus aria-hidden="true" size={17} />
                Start new
              </button>
              <a
                className="secondary-action"
                href="/projects/import"
                onClick={(event) => followRoute(event, "/projects/import")}
              >
                <FolderInput aria-hidden="true" size={17} />
                Import Project
              </a>
            </div>
          )
        : null}
    </header>
  );

  if (state.status === "loading") {
    return (
      <section className="project-hub" aria-labelledby="projects-title">
        {header}
        <AsyncState state="loading" message="Reading the project archive…" />
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="project-hub" aria-labelledby="projects-title">
        {header}
        <AsyncState
          state="error"
          message={state.message}
          action={
            <button
              className="secondary-action"
              type="button"
              onClick={retry ?? (() => setReloadKey((key) => key + 1))}
            >
              Try again
            </button>
          }
        />
      </section>
    );
  }

  const activeProject = selectActiveProject(
    state.projects,
    loadPreference(preferenceKeys.activeProject),
  );
  const projects = activeProject
    ? [
        activeProject,
        ...state.projects
          .filter(({ project }) => project.id !== activeProject.project.id)
          .sort((left, right) =>
            right.project.updatedAt.localeCompare(left.project.updatedAt) ||
            left.project.id.localeCompare(right.project.id)
          ),
      ]
    : [];

  return (
    <>
      <section className="project-hub" aria-labelledby="projects-title">
        {header}
        {projects.length > 0
          ? <ProjectList projects={projects} />
          : <EmptyProjectHub />}
      </section>
      {createDialogOpen
        ? (
            <CreateProjectDialog
              onClose={closeCreateDialog}
              createProject={projectCreation.createProject}
              pendingProject={projectCreation.pendingProject}
            />
          )
        : null}
    </>
  );
}
