import {
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  isHierarchyRecordKind,
  type AuthorityMode,
  type ClientExecutionMode,
  type ClientProfileSummary,
  type HierarchyVocabulary,
  type OutboundDataBoundary,
  type OutboundDestination,
  type ProfileProjectAuthority,
  type Project,
  type ProjectRecord,
  type RecordKind,
} from "../domain/index.js";
import type { GovernanceStore } from "../storage/governance-store.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import type { DestinationService } from "./destination-service.js";
import type { ProfileService } from "./profile-service.js";

export interface ProjectProfileOption {
  profileId: string;
  name: string;
  executionMode: ClientExecutionMode;
  knowledgeAuthorityMode: AuthorityMode;
  lastUsedAt: string | null;
  destination: {
    clientLabel: string;
    providerLabel: string;
    modelLabel: string | null;
    dataBoundary: OutboundDataBoundary;
  } | null;
}

export interface ProjectHubView {
  project: Project;
  recordsByKind: Partial<Record<RecordKind, number>>;
  currentOutcome: ProjectRecord | null;
  currentTask: ProjectRecord | null;
  attention: ProjectRecord | null;
  pendingProposalCount: number;
}

export type ProjectFocusPathSegment = Pick<
  ProjectRecord,
  "id" | "projectId" | "kind" | "status" | "title"
>;

export type DashboardHierarchyKind =
  | "outcome"
  | "initiative"
  | "deliverable"
  | "milestone"
  | "task";

export interface DashboardHierarchyParentContext {
  recordId: string;
  parentKind: DashboardHierarchyKind | null;
}

export interface ProjectDashboardView extends ProjectHubView {
  hierarchyVocabulary: HierarchyVocabulary;
  hierarchyParentContexts: DashboardHierarchyParentContext[];
  currentFocusPath: ProjectFocusPathSegment[];
  recentRecords: ProjectRecord[];
}

export interface TaskHandoffView {
  project: Project;
  task: ProjectRecord;
  currentOutcome: ProjectRecord | null;
  relatedRecords: ProjectRecord[];
  profiles: ProjectProfileOption[];
}

export interface ProjectViewService {
  listHubProjects(): ProjectHubView[];
  getDashboard(projectId: string): ProjectDashboardView;
  getTaskHandoff(projectId: string, taskId: string): TaskHandoffView;
}

export interface ProjectViewServiceDependencies {
  projectStore: ProjectReadStore;
  governanceStore: Pick<GovernanceStore, "listProposals">;
  profileService: Pick<ProfileService, "listProfiles">;
  destinationService: Pick<DestinationService, "getCurrent">;
}

const newestFirst = (left: ProjectRecord, right: ProjectRecord): number =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.id.localeCompare(right.id);

const choose = (
  records: ProjectRecord[],
  kind: ProjectRecord["kind"],
  statuses: ProjectRecord["status"][],
): ProjectRecord | null => {
  for (const status of statuses) {
    const match = records
      .filter((record) => record.kind === kind && record.status === status)
      .sort(newestFirst)[0];
    if (match) return match;
  }
  return null;
};

const toProfileOption = (
  summary: ClientProfileSummary,
  authority: ProfileProjectAuthority,
  destination: OutboundDestination | null,
): ProjectProfileOption => ({
  profileId: summary.profile.id,
  name: summary.profile.name,
  executionMode: summary.profile.executionMode,
  knowledgeAuthorityMode: authority.mode,
  lastUsedAt: summary.profile.lastUsedAt,
  destination: destination?.status !== "enabled"
    ? null
    : {
        clientLabel: destination.clientLabel,
        providerLabel: destination.providerLabel,
        modelLabel: destination.modelLabel,
        dataBoundary: destination.dataBoundary,
      },
});

const compareProfileOptions = (
  left: ProjectProfileOption,
  right: ProjectProfileOption,
): number => {
  if (left.lastUsedAt !== right.lastUsedAt) {
    if (left.lastUsedAt === null) return 1;
    if (right.lastUsedAt === null) return -1;
    return right.lastUsedAt.localeCompare(left.lastUsedAt);
  }

  return left.name.localeCompare(right.name) || left.profileId.localeCompare(right.profileId);
};

const buildHubView = (
  project: Project,
  records: ProjectRecord[],
  pendingProposalCount: number,
): ProjectHubView => {
  const recordsByKind: ProjectHubView["recordsByKind"] = {};

  for (const record of records) {
    recordsByKind[record.kind] = (recordsByKind[record.kind] ?? 0) + 1;
  }

  return {
    project,
    recordsByKind,
    currentOutcome: choose(records, "outcome", ["active", "accepted"]),
    currentTask: choose(records, "task", ["active", "blocked"]),
    attention:
      choose(records, "task", ["blocked"]) ??
      choose(records, "risk", ["active"]) ??
      choose(records, "question", ["active"]),
    pendingProposalCount,
  };
};

type HierarchyProjectRecord = ProjectRecord & { kind: DashboardHierarchyKind };

const isHierarchyProjectRecord = (
  record: ProjectRecord,
): record is HierarchyProjectRecord => isHierarchyRecordKind(record.kind);

const buildHierarchyParents = (
  projectId: string,
  records: ProjectRecord[],
  relationships: ReturnType<ProjectReadStore["listRelationships"]>,
): Map<string, HierarchyProjectRecord> => {
  const recordsById = new Map(
    records
      .filter((record) => record.projectId === projectId)
      .map((record) => [record.id, record]),
  );
  const parentsByChild = new Map<string, string[]>();
  for (const relationship of relationships) {
    const parent = recordsById.get(relationship.fromRecordId);
    const child = recordsById.get(relationship.toRecordId);
    if (
      relationship.projectId !== projectId ||
      relationship.kind !== "parent_of" ||
      !parent ||
      !child ||
      !isHierarchyRecordKind(parent.kind) ||
      !isHierarchyRecordKind(child.kind)
    ) continue;
    const parents = parentsByChild.get(relationship.toRecordId) ?? [];
    parents.push(relationship.fromRecordId);
    parentsByChild.set(relationship.toRecordId, parents);
  }
  for (const parents of parentsByChild.values()) parents.sort();

  return new Map(
    [...parentsByChild.entries()].flatMap(([childId, parentIds]) => {
      const parent = recordsById.get(parentIds[0]!);
      return parent && isHierarchyProjectRecord(parent)
        ? [[childId, parent] as const]
        : [];
    }),
  );
};

const buildCurrentFocusPath = (
  hierarchyParents: ReadonlyMap<string, HierarchyProjectRecord>,
  focus: ProjectRecord | null,
): ProjectFocusPathSegment[] => {
  if (!focus) return [];

  const path = [focus];
  const visited = new Set([focus.id]);
  let childId = focus.id;
  while (true) {
    const parent = hierarchyParents.get(childId);
    if (!parent || visited.has(parent.id)) break;
    path.unshift(parent);
    visited.add(parent.id);
    childId = parent.id;
  }
  return path.map(({ id, projectId: recordProjectId, kind, status, title }) => ({
    id,
    projectId: recordProjectId,
    kind,
    status,
    title,
  }));
};

const buildHierarchyParentContexts = (
  projectedRecords: Array<Pick<ProjectRecord, "id" | "kind"> | null>,
  hierarchyParents: ReadonlyMap<string, HierarchyProjectRecord>,
): DashboardHierarchyParentContext[] => {
  const recordsById = new Map(
    projectedRecords
      .filter((record): record is Pick<ProjectRecord, "id" | "kind"> => record !== null)
      .filter((record) => isHierarchyRecordKind(record.kind))
      .map((record) => [record.id, record]),
  );
  return [...recordsById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => ({
      recordId: record.id,
      parentKind: hierarchyParents.get(record.id)?.kind ?? null,
    }));
};

export const createProjectViewService = ({
  projectStore,
  governanceStore,
  profileService,
  destinationService,
}: ProjectViewServiceDependencies): ProjectViewService => ({
  listHubProjects(): ProjectHubView[] {
    return projectStore.withReadSnapshot(() => projectStore.listProjects().map(
      (project) => buildHubView(
        project,
        projectStore.listRecords(project.id),
        governanceStore.listProposals({ projectId: project.id, state: "pending" }).length,
      ),
    ));
  },

  getDashboard(projectId: string): ProjectDashboardView {
    return projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(projectId);
      if (!project) throw new ProjectNotFoundError(projectId);

      const records = projectStore.listRecords(project.id);
      const hub = buildHubView(
        project,
        records,
        governanceStore.listProposals({ projectId: project.id, state: "pending" }).length,
      );
      const relationships = projectStore.listRelationships(project.id);
      const hierarchyParents = buildHierarchyParents(project.id, records, relationships);
      const currentFocusPath = buildCurrentFocusPath(
        hierarchyParents,
        hub.currentTask ?? hub.currentOutcome,
      );
      const recentRecords = records
        .filter((record) => record.status !== "archived")
        .sort(newestFirst)
        .slice(0, 5);
      return {
        ...hub,
        hierarchyVocabulary: projectStore.getHierarchyVocabulary(project.id),
        hierarchyParentContexts: buildHierarchyParentContexts(
          [
            hub.currentOutcome,
            hub.currentTask,
            hub.attention,
            ...recentRecords,
            ...currentFocusPath,
          ],
          hierarchyParents,
        ),
        currentFocusPath,
        recentRecords,
      };
    });
  },

  getTaskHandoff(projectId: string, taskId: string): TaskHandoffView {
    return projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(projectId);
      if (!project) throw new ProjectNotFoundError(projectId);

      const task = projectStore.getRecord(project.id, taskId);
      if (!task) throw new RecordNotFoundError(taskId);
      if (task.kind !== "task") throw new InvalidTaskError(taskId);

      const records = projectStore.listRecords(project.id);
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const relatedRecordIds = new Set(
        projectStore.listRelationshipsForRecord(project.id, task.id).map(
          (relationship) =>
            relationship.fromRecordId === task.id
              ? relationship.toRecordId
              : relationship.fromRecordId,
        ),
      );
      const relatedRecords = [...relatedRecordIds]
        .filter((recordId) => recordId !== task.id)
        .map((recordId) => recordsById.get(recordId))
        .filter((record): record is ProjectRecord => record !== undefined)
        .sort((left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id),
        );
      const profiles = profileService.listProfiles()
        .filter(({ profile }) => profile.status === "enabled")
        .flatMap((summary) => {
          const authority = summary.authorities.find(
            (candidate) => candidate.authority.projectId === project.id,
          )?.authority;
          return authority
            ? [toProfileOption(
                summary,
                authority,
                destinationService.getCurrent(summary.profile.id),
              )]
            : [];
        })
        .sort(compareProfileOptions);

      return {
        project,
        task,
        currentOutcome: choose(records, "outcome", ["active", "accepted"]),
        relatedRecords,
        profiles,
      };
    });
  },
});
