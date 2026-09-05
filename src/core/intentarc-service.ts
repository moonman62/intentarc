import {
  GovernanceError,
  ProjectNotFoundError,
  type AuditEvent,
  type AuthenticatedProfile,
  type CoordinationService,
  type CreateProjectInput,
  type CreateRecordInput,
  type HumanRecordUpdateInput,
  type Project,
  type ProjectRecord,
  type RecordKind,
  type RecordRelationship,
  type SubmitChangeSetInput,
  type TaskContextPack,
} from "../domain/index.js";
import type {
  AuditQueryFilter,
  GovernanceStore,
  ProfileChangeDetail,
  ProfileChangeSummary,
} from "../storage/governance-store.js";
import type {
  ProjectReadStore,
  ProjectStore,
  UpdateHierarchyVocabularyInput,
  UpdateHierarchyVocabularyResult,
} from "../storage/project-store.js";
import type {
  ChangeService,
  ChangeSubmissionResult,
  HumanRelationshipCreateInput,
  HumanRelationshipRemovalInput,
} from "./change-service.js";
import type { ContextService, GetTaskContextInput } from "./context-service.js";
import type { DestinationService } from "./destination-service.js";
import type { DocumentRegistryService } from "./document-registry-service.js";
import type { IdeaService } from "./idea-service.js";
import type { OutboundContextService } from "./outbound-context-service.js";
import type { ProfileService } from "./profile-service.js";
import type { ProposalService } from "./proposal-service.js";
import type { ProjectMapService } from "./project-map-service.js";
import type {
  ProjectProfileSetupService,
} from "./project-profile-setup-service.js";
import type { ProjectViewService } from "./project-view-service.js";
import type { RepositoryImportService } from "./repository-import-service.js";
import type { RepositoryRefreshService } from "./repository-refresh-service.js";

export interface ProjectSummary {
  project: Project;
  recordsByKind: Partial<Record<RecordKind, number>>;
  activeTasks: Array<Pick<ProjectRecord, "id" | "title" | "status">>;
}

export interface IntentArcService {
  createProject(input: CreateProjectInput): Project;
  updateHierarchyVocabulary(
    input: UpdateHierarchyVocabularyInput,
  ): UpdateHierarchyVocabularyResult;
  listProjects(): Project[];
  getProjectSummary(projectId: string): ProjectSummary;
  createRecord(input: CreateRecordInput): ProjectRecord;
  updateRecord(input: HumanRecordUpdateInput): ProjectRecord;
  createRelationship(input: HumanRelationshipCreateInput): RecordRelationship;
  removeRelationship(input: HumanRelationshipRemovalInput): RecordRelationship;
  getTaskContext(input: GetTaskContextInput): TaskContextPack;
  destinations: DestinationService;
  outbound: OutboundContextService;
  imports: RepositoryImportService;
  repositoryRefresh: RepositoryRefreshService;
  documents: DocumentRegistryService;
  projectMap: ProjectMapService;
  profiles: ProfileService;
  profileSetup: ProjectProfileSetupService;
  proposals: ProposalService;
  views: ProjectViewService;
  ideas: IdeaService;
  coordination: CoordinationService;
  submitChangeSet(
    principal: AuthenticatedProfile,
    input: SubmitChangeSetInput,
  ): ChangeSubmissionResult;
  listMyChanges(
    profileId: string,
    projectId: string,
  ): ProfileChangeSummary[];
  getMyChange(profileId: string, changeId: string): ProfileChangeDetail;
  listAuditEvents(input: AuditQueryFilter): AuditEvent[];
}

export interface IntentArcServiceDependencies {
  projectStore: Pick<ProjectStore, "createProject" | "updateHierarchyVocabulary"> & ProjectReadStore;
  contextService: ContextService;
  destinationService: DestinationService;
  outbound: OutboundContextService;
  repositoryImportService: RepositoryImportService;
  repositoryRefreshService: RepositoryRefreshService;
  documentRegistryService: DocumentRegistryService;
  projectMapService: ProjectMapService;
  profileService: ProfileService;
  profileSetupService: ProjectProfileSetupService;
  changeService: ChangeService;
  ideaService: IdeaService;
  coordinationService: CoordinationService;
  proposalService: ProposalService;
  viewService: ProjectViewService;
  governanceStore: Pick<
    GovernanceStore,
    "listProfileChanges" | "getProfileChange" | "listAuditEvents"
  >;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const createIntentArcService = ({
  projectStore,
  contextService,
  destinationService,
  outbound,
  repositoryImportService,
  repositoryRefreshService,
  documentRegistryService,
  projectMapService,
  profileService,
  profileSetupService,
  changeService,
  ideaService,
  coordinationService,
  proposalService,
  viewService,
  governanceStore,
}: IntentArcServiceDependencies): IntentArcService => ({
  createProject: (input) => projectStore.createProject(input),

  updateHierarchyVocabulary: (input) => projectStore.updateHierarchyVocabulary(input),

  listProjects: () => projectStore.listProjects(),

  getProjectSummary(projectId) {
    const project = projectStore.getProject(projectId);

    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    const recordsByKind: ProjectSummary["recordsByKind"] = {};
    const activeTasks: ProjectSummary["activeTasks"] = [];

    for (const record of projectStore.listRecords(project.id)) {
      recordsByKind[record.kind] = (recordsByKind[record.kind] ?? 0) + 1;

      if (record.kind === "task" && (record.status === "active" || record.status === "blocked")) {
        activeTasks.push({
          id: record.id,
          title: record.title,
          status: record.status,
        });
      }
    }

    activeTasks.sort(
      (left, right) =>
        compareStrings(left.status, right.status) || compareStrings(left.id, right.id),
    );

    return { project, recordsByKind, activeTasks };
  },

  createRecord: (input) => changeService.applyHumanRecord(input),

  updateRecord: (input) => changeService.applyHumanRecordUpdate(input),

  createRelationship: (input) => changeService.applyHumanRelationship(input),

  removeRelationship: (input) =>
    changeService.applyHumanRelationshipRemoval(input),

  getTaskContext: (input) => contextService.getTaskContext(input),

  destinations: destinationService,

  outbound,

  imports: repositoryImportService,

  repositoryRefresh: repositoryRefreshService,

  documents: documentRegistryService,

  projectMap: projectMapService,

  profiles: profileService,

  profileSetup: profileSetupService,

  proposals: proposalService,

  views: viewService,

  ideas: ideaService,

  coordination: coordinationService,

  submitChangeSet: (principal, input) =>
    changeService.submitProfileChange(principal, input),

  listMyChanges: (profileId, projectId) =>
    governanceStore.listProfileChanges({ profileId, projectId }),

  getMyChange(profileId, changeId) {
    const change = governanceStore.getProfileChange(profileId, changeId);
    if (!change) {
      throw new GovernanceError("validation_failed", "Change not found");
    }
    return change;
  },

  listAuditEvents: (input) => governanceStore.listAuditEvents(input),
});
