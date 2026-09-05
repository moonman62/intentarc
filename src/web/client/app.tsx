import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  HubProject,
  ProjectDashboardResponse,
  ProjectHubResponse,
} from "../contracts.js";
import { apiRequest } from "./api.js";
import { AppShell } from "./components/app-shell.js";
import { AsyncState } from "./components/async-state.js";
import { IdeaCaptureProvider } from "./components/idea-capture.js";
import { StatusChip } from "./components/status-chip.js";
import {
  getDesktopApi,
  type IntentArcDesktopApi,
} from "./desktop-api.js";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
} from "./preferences.js";
import { parseProjectMapRoute, projectMapPath } from "./project-map-route.js";
import { navigate, useLocationRoute, useRoute } from "./router.js";
import {
  HandoffDesk,
} from "./screens/handoff-desk.js";
import {
  ProjectHub,
  selectActiveProject,
  type ProjectCreatedHandler,
} from "./screens/project-hub.js";
import {
  ProjectHome,
  type ProjectDashboardLoadEvent,
} from "./screens/project-home.js";
import { ProposalsScreen } from "./screens/proposals.js";
import { IdeasScreen } from "./screens/ideas.js";
import { IdeaDetailScreen } from "./screens/idea-detail.js";
import {
  ImportProjectScreen,
  type ProjectAppliedHandler,
} from "./screens/import-project.js";
import { AiConnections } from "./screens/ai-connections.js";
import { DesktopWelcome } from "./screens/desktop-welcome.js";
import { Documentation } from "./screens/documentation.js";
import { RepositoryRefresh } from "./screens/repository-refresh.js";
import { ProjectMap } from "./screens/project-map.js";
import { RepositoryExplorer } from "./screens/repository-explorer.js";
import { WorkQueue } from "./screens/work-queue.js";
import { RepositorySelectionProvider } from "./components/repository-selection.js";

type ProjectsLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: HubProject[] };

interface DashboardNavigationState {
  projectId: string;
  generation: number;
  currentTaskId: string | null;
}

const projectRoutePattern = /^\/projects\/([^/]+)/;
const handoffRoutePattern =
  /^\/projects\/([^/]+)\/tasks\/([^/]+)\/handoff\/?$/;
const proposalsRoutePattern = /^\/projects\/([^/]+)\/proposals\/?$/;
const ideasRoutePattern = /^\/projects\/([^/]+)\/ideas\/?$/;
const ideaDetailRoutePattern = /^\/projects\/([^/]+)\/ideas\/([^/]+)\/?$/;
const documentationRoutePattern =
  /^\/projects\/([^/]+)\/documentation(?:\/([^/]+))?\/?$/;
const repositoryRefreshRoutePattern =
  /^\/projects\/([^/]+)\/repository\/refresh\/?$/;
const repositoryExplorerRoutePattern = /^\/projects\/([^/]+)\/repository\/?$/;
const mapRoutePattern = /^\/projects\/([^/]+)\/map\/?$/;
const workRoutePattern = /^\/projects\/([^/]+)\/work\/?$/;

type ProjectRouteSelection =
  | { kind: "global" }
  | { kind: "project"; projectId: string }
  | { kind: "invalid" };

const projectRouteSelection = (route: string): ProjectRouteSelection => {
  if (route === "/projects/import") return { kind: "global" };
  const encodedId = projectRoutePattern.exec(route)?.[1];
  if (!encodedId) return { kind: "global" };
  try {
    return { kind: "project", projectId: decodeURIComponent(encodedId) };
  } catch {
    return { kind: "invalid" };
  }
};

const handoffIdsFromRoute = (
  route: string,
): { projectId: string; taskId: string } | null => {
  const match = handoffRoutePattern.exec(route);
  if (!match) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]!),
      taskId: decodeURIComponent(match[2]!),
    };
  } catch {
    return null;
  }
};

const proposalsProjectIdFromRoute = (route: string): string | null => {
  const encodedId = proposalsRoutePattern.exec(route)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
};

type WorkRouteSelection =
  | { kind: "valid"; projectId: string; taskId: string | null }
  | { kind: "invalid" };

const workSelectionFromRoute = (
  route: string,
  locationRoute: string,
): WorkRouteSelection | null => {
  const encodedId = workRoutePattern.exec(route)?.[1];
  if (!encodedId) return null;
  try {
    const projectId = decodeURIComponent(encodedId);
    const searchIndex = locationRoute.indexOf("?");
    if (searchIndex < 0) return { kind: "valid", projectId, taskId: null };
    const rawQuery = locationRoute.slice(searchIndex + 1);
    if (!rawQuery.startsWith("taskId=") || rawQuery.includes("&")) {
      return { kind: "invalid" };
    }
    const encodedTaskId = rawQuery.slice("taskId=".length);
    const taskId = decodeURIComponent(encodedTaskId);
    if (taskId.length === 0 || encodeURIComponent(taskId) !== encodedTaskId) {
      return { kind: "invalid" };
    }
    return { kind: "valid", projectId, taskId };
  } catch {
    return { kind: "invalid" };
  }
};

const ideasProjectIdFromRoute = (route: string): string | null => {
  const encodedId = ideasRoutePattern.exec(route)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
};

const ideaDetailIdsFromRoute = (
  route: string,
): { projectId: string; ideaId: string } | null => {
  const match = ideaDetailRoutePattern.exec(route);
  if (!match) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]!),
      ideaId: decodeURIComponent(match[2]!),
    };
  } catch {
    return null;
  }
};

const documentationIdsFromRoute = (
  route: string,
): { projectId: string; nodeId: string | null } | null => {
  const match = documentationRoutePattern.exec(route);
  if (!match) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]!),
      nodeId: match[2] === undefined ? null : decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
};

const repositoryRefreshProjectIdFromRoute = (route: string): string | null => {
  const encodedId = repositoryRefreshRoutePattern.exec(route)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
};

const repositoryExplorerIdsFromRoute = (
  route: string,
  locationRoute: string,
): { projectId: string; nodeId: string | null } | null => {
  const encodedId = repositoryExplorerRoutePattern.exec(route)?.[1];
  if (!encodedId) return null;
  try {
    const query = locationRoute.includes("?")
      ? locationRoute.slice(locationRoute.indexOf("?") + 1)
      : "";
    const values = new URLSearchParams(query).getAll("nodeId");
    if (values.length > 1) return null;
    return {
      projectId: decodeURIComponent(encodedId),
      nodeId: values[0] === undefined || values[0] === "" ? null : values[0],
    };
  } catch {
    return null;
  }
};

function ProjectOrientation({
  project,
  route,
}: {
  project: HubProject | null;
  route: string;
}) {
  const isProposals = route.endsWith("/proposals");
  const isContext = route.includes("/handoff");
  const title = isProposals
    ? "Proposals"
    : isContext
      ? "Handoff Desk"
      : project?.project.name ?? "Project";
  const lede = isProposals
    ? "Review proposed changes before they become part of the project archive."
    : isContext
      ? "Carry the current task with its decisions, constraints, and evidence intact."
      : "Keep the project’s current outcome and task in view as work moves between clients.";

  return (
    <>
      <div className="stage__header">
        <div>
          <p className="stage__eyebrow">
            {isContext ? "Context · current task" : "Active project"}
          </p>
          <h1>{title}</h1>
          <p className="stage__lede">{lede}</p>
        </div>
        {project
          ? (
              <StatusChip tone={project.attention ? "attention" : "active"}>
                {project.attention ? "Needs attention" : "In continuity"}
              </StatusChip>
            )
          : null}
      </div>
      <section className="orientation-block" aria-labelledby="current-focus">
        <div>
          <h2 id="current-focus">Current focus</h2>
          <p>
            {project?.currentTask?.title
              ?? project?.currentOutcome?.title
              ?? "Select a current task to prepare a handoff."}
          </p>
        </div>
        {project
          ? (
              <dl className="orientation-facts">
                <div>
                  <dt>Project ID</dt>
                  <dd>{project.project.id}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{project.project.revision}</dd>
                </div>
                <div>
                  <dt>Proposals</dt>
                  <dd>{project.pendingProposalCount} pending</dd>
                </div>
              </dl>
            )
          : null}
      </section>
    </>
  );
}

function ArchiveApp({
  desktop,
}: {
  desktop: IntentArcDesktopApi | null;
}) {
  const route = useRoute();
  const locationRoute = useLocationRoute();
  const [reloadKey, setReloadKey] = useState(0);
  const [projectState, setProjectState] = useState<ProjectsLoadState>({
    status: "loading",
  });
  const [dashboardNavigation, setDashboardNavigation] =
    useState<DashboardNavigationState | null>(null);
  const projectLoadControllerRef = useRef<AbortController | null>(null);
  const ideaRefreshControllerRef = useRef<{
    projectId: string;
    controller: AbortController;
  } | null>(null);

  useEffect(() => {
    ideaRefreshControllerRef.current?.controller.abort();
    ideaRefreshControllerRef.current = null;
    projectLoadControllerRef.current?.abort();
    const controller = new AbortController();
    projectLoadControllerRef.current = controller;
    setProjectState({ status: "loading" });
    apiRequest<ProjectHubResponse>("/api/projects", {
      signal: controller.signal,
    }).then(
      ({ projects }) => {
        if (controller.signal.aborted) return;
        setProjectState({ status: "ready", projects });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setProjectState({
          status: "error",
          message: reason instanceof Error
            ? reason.message
            : "Could not read the project archive.",
        });
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  const commitCreatedProject = useCallback<ProjectCreatedHandler>(
    async (project, signal) => {
      projectLoadControllerRef.current?.abort();
      const { projects } = await apiRequest<ProjectHubResponse>(
        "/api/projects",
        { signal },
      );
      if (signal.aborted) return;
      if (!projects.some(({ project: entry }) => entry.id === project.id)) {
        throw new Error("The created project is not available in the archive.");
      }
      setProjectState({ status: "ready", projects });
      savePreference(preferenceKeys.activeProject, project.id);
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    },
    [],
  );

  const commitImportedProject = useCallback<ProjectAppliedHandler>(
    async (projectId, signal) => {
      projectLoadControllerRef.current?.abort();
      const { projects } = await apiRequest<ProjectHubResponse>(
        "/api/projects",
        { signal },
      );
      if (signal.aborted) return;
      if (!projects.some(({ project }) => project.id === projectId)) {
        throw new Error("The imported project is not available in the archive.");
      }
      setProjectState({ status: "ready", projects });
      savePreference(preferenceKeys.activeProject, projectId);
      navigate(`/projects/${encodeURIComponent(projectId)}`);
    },
    [],
  );

  const routeProject = projectRouteSelection(route);
  const routeProjectId = routeProject.kind === "project"
    ? routeProject.projectId
    : null;
  const invalidProjectRoute = routeProject.kind === "invalid";
  const preferredProjectId = loadPreference(
    preferenceKeys.activeProject,
  );
  const activeProjectId = invalidProjectRoute
    ? null
    : routeProjectId ?? preferredProjectId;
  const projects = projectState.status === "ready"
    ? projectState.projects
    : [];
  const activeProject = invalidProjectRoute
    ? null
    : routeProjectId
    ? projects.find(({ project }) => project.id === routeProjectId) ?? null
    : selectActiveProject(projects, activeProjectId);
  const navigationProjectId = projectState.status === "ready"
    ? activeProject?.project.id ?? null
    : invalidProjectRoute ? null : activeProjectId;
  const routeCurrentTaskId = dashboardNavigation?.projectId === routeProjectId
    ? dashboardNavigation.currentTaskId
    : null;
  const ideaCaptureProject = activeProject
    ? {
        id: activeProject.project.id,
        name: activeProject.project.name,
        revision: activeProject.project.revision,
        context: activeProject.currentTask
          ? [{
              id: activeProject.currentTask.id,
              kind: "task" as const,
              title: activeProject.currentTask.title,
            }]
          : [],
      }
    : null;

  const commitIdeaCaptureRevision = useCallback((
    projectId: string,
    revision: number,
  ) => {
    setProjectState((current) => {
      if (current.status !== "ready") return current;
      let changed = false;
      const nextProjects = current.projects.map((entry) => {
        if (
          entry.project.id !== projectId ||
          revision <= entry.project.revision
        ) return entry;
        changed = true;
        return {
          ...entry,
          project: { ...entry.project, revision },
          recordsByKind: {
            ...entry.recordsByKind,
            idea: (entry.recordsByKind.idea ?? 0) + 1,
          },
        };
      });
      return changed
        ? { status: "ready", projects: nextProjects }
        : current;
    });
  }, []);

  const refreshIdeaProject = useCallback(async (
    projectId: string,
  ): Promise<number> => {
    projectLoadControllerRef.current?.abort();
    ideaRefreshControllerRef.current?.controller.abort();
    const controller = new AbortController();
    const request = { projectId, controller };
    ideaRefreshControllerRef.current = request;
    try {
      const { projects: refreshedProjects } = await apiRequest<ProjectHubResponse>(
        "/api/projects",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        throw new DOMException("The project refresh was superseded.", "AbortError");
      }
      const refreshedProject = refreshedProjects.find(
        ({ project: entry }) => entry.id === projectId,
      );
      if (!refreshedProject) {
        throw new Error("The refreshed project is not available in the archive.");
      }
      setProjectState({ status: "ready", projects: refreshedProjects });
      return refreshedProject.project.revision;
    } finally {
      if (ideaRefreshControllerRef.current === request) {
        ideaRefreshControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const request = ideaRefreshControllerRef.current;
    if (request && request.projectId !== ideaCaptureProject?.id) {
      request.controller.abort();
      ideaRefreshControllerRef.current = null;
    }
  }, [ideaCaptureProject?.id]);

  useEffect(() => () => {
    ideaRefreshControllerRef.current?.controller.abort();
    ideaRefreshControllerRef.current = null;
  }, []);

  const handleDashboardLoad = useCallback(
    (event: ProjectDashboardLoadEvent) => {
      setDashboardNavigation((current) => {
        if (event.status === "loading") {
          return {
            projectId: event.projectId,
            generation: event.generation,
            currentTaskId: null,
          };
        }
        if (
          current?.projectId !== event.projectId ||
          current.generation !== event.generation
        ) return current;
        if (event.status === "error") {
          return {
            ...current,
            currentTaskId: null,
          };
        }
        return {
          projectId: event.projectId,
          generation: event.generation,
          currentTaskId: event.dashboard.currentTask?.id ?? null,
        };
      });
    },
    [],
  );

  useEffect(() => {
    if (routeProjectId) {
      savePreference(preferenceKeys.activeProject, routeProjectId);
    }
  }, [routeProjectId]);

  const isImport = route === "/projects/import";
  const isProjects = route === "/" || route === "/projects";
  const isAiConnections = route === "/settings/ai" && desktop !== null;
  const isProjectHome = routeProjectId !== null &&
    /^\/projects\/[^/]+\/?$/.test(route);
  const handoffIds = handoffIdsFromRoute(route);
  const proposalsProjectId = proposalsProjectIdFromRoute(route);
  const workSelection = workSelectionFromRoute(route, locationRoute);
  const invalidWorkRoute = workSelection?.kind === "invalid";
  const workProjectId = workSelection?.kind === "valid"
    ? workSelection.projectId
    : null;
  const ideaDetailIds = ideaDetailIdsFromRoute(route);
  const isIdeaDetailRoute = ideaDetailRoutePattern.test(route);
  const ideasProjectId = ideasProjectIdFromRoute(route);
  const isIdeasRoute = ideasRoutePattern.test(route);
  const documentationIds = documentationIdsFromRoute(route);
  const repositoryRefreshProjectId = repositoryRefreshProjectIdFromRoute(route);
  const repositoryExplorerIds = repositoryExplorerIdsFromRoute(route, locationRoute);
  const mapIds = parseProjectMapRoute(route, locationRoute);
  const invalidMapRoute = mapRoutePattern.test(route) && mapIds === null;

  const commitMapDashboard = useCallback((dashboard: ProjectDashboardResponse) => {
    setProjectState((current) => {
      if (current.status !== "ready") return current;
      return {
        status: "ready",
        projects: current.projects.map((project) => (
          project.project.id === dashboard.project.id
            ? {
                project: dashboard.project,
                recordsByKind: dashboard.recordsByKind,
                currentOutcome: dashboard.currentOutcome,
                currentTask: dashboard.currentTask,
                attention: dashboard.attention,
                pendingProposalCount: dashboard.pendingProposalCount,
              }
            : project
        )),
      };
    });
  }, []);

  return (
    <RepositorySelectionProvider>
    <IdeaCaptureProvider
      project={ideaCaptureProject}
      onProjectRevision={commitIdeaCaptureRevision}
      refreshProject={refreshIdeaProject}
    >
      <AppShell
        activeProject={navigationProjectId
          ? {
              id: navigationProjectId,
              name: activeProject?.project.name ?? navigationProjectId,
              ...(routeCurrentTaskId
                ? { currentTaskId: routeCurrentTaskId }
                : {}),
            }
          : null}
      >
      <section className="stage">
        {isAiConnections
          ? (
              <>
                <div className="stage__header">
                  <div>
                    <p className="stage__eyebrow">
                      Desktop · AI connections
                    </p>
                    <h1>Set up with AI</h1>
                    <p className="stage__lede">
                      Connect a supported AI client to IntentArc’s local bridge,
                      then test or remove the connection here.
                    </p>
                  </div>
                </div>
                <AiConnections ai={desktop.ai} />
              </>
            )
          : isProjects
          ? <ProjectHub
              state={projectState}
              retry={() => setReloadKey((key) => key + 1)}
              onProjectCreated={commitCreatedProject}
            />
              : isImport
            ? (
                <>
                  <div className="stage__header">
                    <div>
                      <h1>Import project</h1>
                    </div>
                  </div>
                  <ImportProjectScreen
                    onProjectApplied={commitImportedProject}
                  />
                </>
              )
              : invalidProjectRoute && !isIdeaDetailRoute
                ? <p role="status">The project route is invalid.</p>
              : handoffIds
              ? (
                  <div className="handoff-work-recovery">
                    <a
                      className="secondary-action"
                      href={`/projects/${encodeURIComponent(handoffIds.projectId)}/work?taskId=${encodeURIComponent(handoffIds.taskId)}`}
                      onClick={(event) => {
                        if (
                          event.button !== 0 || event.metaKey || event.ctrlKey ||
                          event.shiftKey || event.altKey
                        ) return;
                        event.preventDefault();
                        navigate(`/projects/${encodeURIComponent(handoffIds.projectId)}/work?taskId=${encodeURIComponent(handoffIds.taskId)}`);
                      }}
                    >
                      Recover in Work Queue
                    </a>
                    <HandoffDesk
                      projectId={handoffIds.projectId}
                      taskId={handoffIds.taskId}
                    />
                  </div>
                )
              : invalidWorkRoute
                ? <p role="status">The Work Queue route is invalid.</p>
              : invalidMapRoute
                ? <p role="status">The Project map route is invalid.</p>
              : isIdeaDetailRoute
                ? projectState.status === "loading"
                  ? <AsyncState state="loading" message="Loading project…" />
                  : projectState.status === "error"
                    ? (
                        <AsyncState
                          state="error"
                          title="Could not load project"
                          message={projectState.message}
                          action={
                            <button
                              className="secondary-action"
                              type="button"
                              onClick={() => setReloadKey((key) => key + 1)}
                            >
                              Try again
                            </button>
                          }
                        />
                      )
                    : ideaDetailIds &&
                        activeProject?.project.id === ideaDetailIds.projectId
                      ? (
                          <IdeaDetailScreen
                            projectId={ideaDetailIds.projectId}
                            ideaId={ideaDetailIds.ideaId}
                          />
                        )
                      : (
                          <AsyncState
                            state="empty"
                            title="Idea unavailable"
                            message="This idea route is not available in the archive."
                          />
                        )
              : isIdeasRoute
                ? projectState.status === "loading"
                  ? <AsyncState state="loading" message="Loading project…" />
                  : projectState.status === "error"
                    ? (
                        <AsyncState
                          state="error"
                          title="Could not load project"
                          message={projectState.message}
                          action={
                            <button
                              className="secondary-action"
                              type="button"
                              onClick={() => setReloadKey((key) => key + 1)}
                            >
                              Try again
                            </button>
                          }
                        />
                      )
                    : ideasProjectId &&
                        activeProject?.project.id === ideasProjectId
                      ? <IdeasScreen projectId={ideasProjectId} />
                      : (
                          <AsyncState
                            state="empty"
                            title="Project not found"
                            message="This project is not available in the archive."
                          />
                        )
              : proposalsProjectId
                ? <ProposalsScreen projectId={proposalsProjectId} />
              : workProjectId
                ? projectState.status === "loading"
                  ? <AsyncState state="loading" message="Loading project…" />
                  : projectState.status === "error"
                    ? (
                        <AsyncState
                          state="error"
                          title="Could not load project"
                          message={projectState.message}
                          action={(
                            <button
                              className="secondary-action"
                              type="button"
                              onClick={() => setReloadKey((key) => key + 1)}
                            >Try again</button>
                          )}
                        />
                      )
                    : activeProject?.project.id === workProjectId
                      ? (
                          <WorkQueue
                            key={workProjectId}
                            projectId={workProjectId}
                            projectRevision={activeProject.project.revision}
                            desktopAiAvailable={desktop !== null}
                            ownerSummary={{
                              projectName: activeProject.project.name,
                              taskCount: activeProject.recordsByKind.task ?? 0,
                              currentTask: activeProject.currentTask
                                ? {
                                    title: activeProject.currentTask.title,
                                    status: activeProject.currentTask.status,
                                  }
                                : null,
                            }}
                            initialTaskId={workSelection?.kind === "valid"
                              ? workSelection.taskId ?? activeProject.currentTask?.id ?? null
                              : activeProject.currentTask?.id ?? null}
                          />
                        )
                      : (
                          <AsyncState
                            state="empty"
                            title="Project not found"
                            message="This project is not available in the archive."
                          />
                        )
              : mapIds
                ? activeProject?.project.id === mapIds.projectId
                  ? <ProjectMap
                      projectId={mapIds.projectId}
                      projectRevision={activeProject.project.revision}
                      focusRecordId={mapIds.focusRecordId}
                      scopeRecordId={mapIds.scopeRecordId}
                      onSelectProject={() => navigate(projectMapPath(mapIds.projectId, {
                        focusRecordId: null,
                        scopeRecordId: null,
                      }))}
                      onSelectRecord={(recordId, scopeRecordId) => navigate(
                        projectMapPath(mapIds.projectId, { focusRecordId: recordId, scopeRecordId }),
                      )}
                      onClearSelection={(scopeRecordId) => navigate(
                        projectMapPath(mapIds.projectId, {
                          focusRecordId: null,
                          scopeRecordId,
                        }),
                      )}
                      onFocusBranch={(recordId) => navigate(
                        projectMapPath(mapIds.projectId, {
                          focusRecordId: recordId,
                          scopeRecordId: recordId,
                        }),
                      )}
                      onNavigateAttachment={(path) => navigate(path)}
                      onShowWholeProject={(selectedRecordId) => navigate(
                        projectMapPath(mapIds.projectId, {
                          focusRecordId: selectedRecordId,
                          scopeRecordId: null,
                        }),
                      )}
                      onDashboardRefetched={commitMapDashboard}
                    />
                  : <p role="status">Loading project…</p>
              : repositoryRefreshProjectId
                ? activeProject?.project.id === repositoryRefreshProjectId
                  ? (
                      <RepositoryRefresh
                        key={repositoryRefreshProjectId}
                        projectId={repositoryRefreshProjectId}
                        projectRevision={activeProject.project.revision}
                        hasPrimaryRepository={
                          activeProject.project.primaryRepositoryPath !== null
                        }
                        desktopRepository={desktop?.repository ?? null}
                      />
                    )
                  : <p role="status">Loading project…</p>
              : repositoryExplorerIds
                ? activeProject?.project.id === repositoryExplorerIds.projectId
                  ? <RepositoryExplorer
                      projectId={repositoryExplorerIds.projectId}
                      selectedNodeId={repositoryExplorerIds.nodeId}
                      onSelectNode={(nodeId) => navigate(
                        `/projects/${encodeURIComponent(repositoryExplorerIds.projectId)}/repository${
                          nodeId === null ? "" : `?nodeId=${encodeURIComponent(nodeId)}`
                        }`,
                      )}
                    />
                  : <p role="status">Loading project…</p>
              : documentationIds
                ? (
                    <Documentation
                      projectId={documentationIds.projectId}
                      selectedNodeId={documentationIds.nodeId}
                      desktopDocuments={desktop?.documents ?? null}
                      onSelectNode={(nodeId) => navigate(
                        `/projects/${encodeURIComponent(documentationIds.projectId)}/documentation${
                          nodeId === null ? "" : `/${encodeURIComponent(nodeId)}`
                        }`,
                      )}
                    />
                  )
              : isProjectHome && routeProjectId
              ? (
                  <ProjectHome
                    projectId={routeProjectId}
                    onDashboardLoad={handleDashboardLoad}
                  />
                )
              : (
                <ProjectOrientation project={activeProject} route={route} />
              )}
      </section>
      </AppShell>
    </IdeaCaptureProvider>
    </RepositorySelectionProvider>
  );
}

export function App() {
  const desktop = getDesktopApi();
  const archive = <ArchiveApp desktop={desktop} />;

  return desktop
    ? (
        <DesktopWelcome lifecycle={desktop.lifecycle}>
          {archive}
        </DesktopWelcome>
      )
    : archive;
}
