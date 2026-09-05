import { randomUUID } from "node:crypto";
import { createChangeService } from "../core/change-service.js";
import {
  createCoordinationService,
  type CoordinationIdPrefix,
} from "../core/coordination-service.js";
import { createContextService } from "../core/context-service.js";
import { createDestinationService } from "../core/destination-service.js";
import { createDocumentRegistryService } from "../core/document-registry-service.js";
import { createIdeaService } from "../core/idea-service.js";
import { createOutboundContextService } from "../core/outbound-context-service.js";
import {
  createIntentArcService,
  type IntentArcService,
} from "../core/intentarc-service.js";
import { createProfileService } from "../core/profile-service.js";
import {
  createProjectProfileSetupService,
} from "../core/project-profile-setup-service.js";
import { createProposalService } from "../core/proposal-service.js";
import { createProjectMapService } from "../core/project-map-service.js";
import { createProjectViewService } from "../core/project-view-service.js";
import {
  createRepositoryImportService,
  type RepositoryImportServiceDependencies,
} from "../core/repository-import-service.js";
import {
  createRepositoryRefreshService,
  type RepositoryRefreshServiceDependencies,
} from "../core/repository-refresh-service.js";
import { createContextPackStore } from "../storage/context-pack-store.js";
import { createCoordinationStore } from "../storage/coordination-store.js";
import {
  openDatabase,
  type IntentArcDatabase,
} from "../storage/database.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { createProfileStore } from "../storage/profile-store.js";
import { createOutboundDestinationStore } from "../storage/outbound-destination-store.js";
import { createOutboundContextStore } from "../storage/outbound-context-store.js";
import { createProjectStore } from "../storage/project-store.js";
import { createRepositoryImportStore } from "../storage/repository-import-store.js";
import { createRepositoryIndexStore } from "../storage/repository-index-store.js";
import { createDurabilityCoordinator } from "../durability/coordinator.js";
import { createOutboundSafetyEngine } from "../outbound/safety-engine.js";

export type IntentArcIdPrefix =
  | "project"
  | "record"
  | "relationship"
  | "context"
  | "profile"
  | "authority"
  | "scope"
  | "change"
  | "proposal"
  | "claim"
  | "checkpoint"
  | "delegation"
  | "submission"
  | "coordination-event"
  | "destination"
  | "outbound-request"
  | "outbound-release"
  | "repository-source"
  | "repository-snapshot"
  | "repository-node"
  | "repository-link"
  | "audit";

export interface CreateApplicationOptions {
  databasePath: string;
  now?: () => string;
  newId?: (prefix: IntentArcIdPrefix) => string;
  repositoryImportDependencies?: RepositoryImportApplicationDependencies;
  repositoryRefreshDependencies?: RepositoryRefreshApplicationDependencies;
}

export interface IntentArcApplication {
  service: IntentArcService;
  close(): void;
}

export interface CreateApplicationFromDatabaseOptions {
  database: IntentArcDatabase;
  closeDatabase: () => void;
  now?: () => string;
  newId?: (prefix: IntentArcIdPrefix) => string;
  repositoryImportDependencies?: RepositoryImportApplicationDependencies;
  repositoryRefreshDependencies?: RepositoryRefreshApplicationDependencies;
}

export type RepositoryImportApplicationDependencies = Pick<
  RepositoryImportServiceDependencies,
  "scanner" | "generator" | "driftVerifier"
>;

export type RepositoryRefreshApplicationDependencies = Pick<
  RepositoryRefreshServiceDependencies,
  "scanner"
>;

const defaultNow = (): string => new Date().toISOString();

const defaultNewId = (prefix: IntentArcIdPrefix): string =>
  `${prefix}-${randomUUID()}`;

const coordinationIdPrefixes: Record<CoordinationIdPrefix, IntentArcIdPrefix> = {
  "coordination-claim": "claim",
  "coordination-checkpoint": "checkpoint",
  "coordination-delegation": "delegation",
  "coordination-event": "coordination-event",
  "coordination-submission": "submission",
};

export const createApplicationFromDatabase = ({
  database,
  closeDatabase,
  now = defaultNow,
  newId = defaultNewId,
  repositoryImportDependencies = {},
  repositoryRefreshDependencies = {},
}: CreateApplicationFromDatabaseOptions): IntentArcApplication => {
  const projectStore = createProjectStore(database, { now, newId });
  const contextPackStore = createContextPackStore(database);
  const profileStore = createProfileStore(database);
  const destinationStore = createOutboundDestinationStore(database);
  const outboundStore = createOutboundContextStore(database);
  const governanceStore = createGovernanceStore(database, { newId });
  const repositoryImportStore = createRepositoryImportStore(database, {
    now,
    newId,
  });
  const repositoryIndexStore = createRepositoryIndexStore(database, {
    now,
    newId,
  });
  const immediateTransaction = {
    run<Result>(operation: () => Result): Result {
      return database.transaction(operation).immediate();
    },
  };
  const contextService = createContextService({
    projectStore,
    contextPackStore,
    now,
    newId: () => newId("context"),
    estimateTokens: (text) => text.length,
  });
  const profileService = createProfileService({
    profileStore,
    now,
    newId,
  });
  const changeService = createChangeService({
    profileStore,
    governanceStore,
    now,
  });
  const coordinationStore = createCoordinationStore(database, {
    now,
    newId: () => newId("coordination-event"),
  });
  const coordinationService = createCoordinationService({
    coordinationStore,
    changeService,
    contextService,
    profileService,
    profileStore,
    now,
    newId: (prefix) => newId(coordinationIdPrefixes[prefix]),
  });
  const ideaService = createIdeaService({
    projectStore,
    governanceStore,
    now,
  });
  const proposalService = createProposalService({
    governanceStore,
    now,
  });
  const destinationService = createDestinationService({
    destinationStore,
    profileStore,
    now,
    newId,
  });
  const outbound = createOutboundContextService({
    contextService,
    contextPackStore,
    profileService,
    destinationService,
    outboundStore,
    safetyEngine: createOutboundSafetyEngine(),
    now,
    newId,
  });
  const repositoryImportService = createRepositoryImportService({
    ...repositoryImportDependencies,
    store: repositoryImportStore,
  });
  const repositoryRefreshService = createRepositoryRefreshService({
    ...repositoryRefreshDependencies,
    projectStore,
    store: repositoryIndexStore,
    proposalStore: governanceStore,
    transaction: immediateTransaction,
    now,
  });
  const documentRegistryService = createDocumentRegistryService({
    projectStore,
    store: repositoryIndexStore,
  });
  const projectMapService = createProjectMapService({
    projectStore,
    repositoryStore: repositoryIndexStore,
    currentContextPackId: (projectId) => contextPackStore.getLatestIdForProject(projectId),
  });
  const viewService = createProjectViewService({
    projectStore,
    governanceStore,
    profileService,
    destinationService,
  });
  const profileSetupService = createProjectProfileSetupService({
    transaction: immediateTransaction,
    profileService,
    destinationService,
    viewService,
  });
  const service = createIntentArcService({
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
    governanceStore,
    viewService,
  });
  let closed = false;

  return {
    service,
    close(): void {
      if (closed) {
        return;
      }

      closed = true;
      closeDatabase();
    },
  };
};

export const createApplication = ({
  databasePath,
  now = defaultNow,
  newId = defaultNewId,
  repositoryImportDependencies = {},
  repositoryRefreshDependencies = {},
}: CreateApplicationOptions): IntentArcApplication => {
  const database = openDatabase(databasePath, { now });
  try {
    return createApplicationFromDatabase({
      database,
      closeDatabase: () => database.close(),
      now,
      newId,
      repositoryImportDependencies,
      repositoryRefreshDependencies,
    });
  } catch (error) {
    database.close();
    throw error;
  }
};

export const openIntentArcApplication = async ({
  databasePath,
  now = defaultNow,
  newId = defaultNewId,
  repositoryImportDependencies = {},
  repositoryRefreshDependencies = {},
}: CreateApplicationOptions): Promise<IntentArcApplication> => {
  const prepared = await createDurabilityCoordinator({ now })
    .prepareForApplication(databasePath);
  try {
    return createApplicationFromDatabase({
      database: prepared.database,
      closeDatabase: prepared.close,
      now,
      newId,
      repositoryImportDependencies,
      repositoryRefreshDependencies,
    });
  } catch (error) {
    prepared.close();
    throw error;
  }
};
