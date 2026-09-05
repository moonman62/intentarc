import { randomUUID } from "node:crypto";
import {
  createBackupService,
  type BackupService,
} from "./backup-service.js";
import {
  createBundleRepository,
  defaultBackupRoot,
  type BundleRepository,
} from "./bundles.js";
import { createDurabilityCoordinator } from "./coordinator.js";
import {
  createIntegrityChecker,
  type IntegrityChecker,
} from "./integrity.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";
import {
  createLeaseManager,
  type LeaseManager,
} from "./leases.js";
import type {
  BackupSummary,
  CreateBackupInput,
  IntegrityReport,
  RestoreBackupInput,
  RestoreResult,
  VerifiedBackup,
} from "./model.js";
import {
  createRestoreService,
  type RestoreService,
} from "./restore-service.js";

export interface DurabilityService {
  checkIntegrity(databasePath: string): Promise<IntegrityReport>;
  createBackup(input: CreateBackupInput): Promise<BackupSummary>;
  listBackups(
    databasePath: string,
    root?: string,
  ): Promise<BackupSummary[]>;
  verifyBackup(bundlePath: string): Promise<VerifiedBackup>;
  restoreBackup(input: RestoreBackupInput): Promise<RestoreResult>;
}

export interface DurabilityServiceOptions {
  readonly now?: () => string;
  readonly newId?: () => string;
}

type DurabilityComponents = {
  readonly checker: IntegrityChecker;
  readonly repository: BundleRepository;
  readonly leaseManager: LeaseManager;
  readonly backupService: BackupService;
  readonly restoreService: RestoreService;
};

const createComponents = (
  options: DurabilityServiceOptions,
): DurabilityComponents => {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;
  const checker = createIntegrityChecker({ now });
  const repository = createBundleRepository(checker);
  const leaseManager = createLeaseManager();
  const backupService = createBackupService({
    checker,
    repository,
    leaseManager,
    now,
    newId,
  });
  const coordinator = createDurabilityCoordinator({
    checker,
    leaseManager,
    backupService,
    now,
    newId,
  });
  const restoreService = createRestoreService({
    repository,
    backupService,
    coordinator,
    checker,
    leaseManager,
    now,
    newId,
  });
  return {
    checker,
    repository,
    leaseManager,
    backupService,
    restoreService,
  };
};

export const createDurabilityService = (
  options: DurabilityServiceOptions = {},
): DurabilityService => {
  const {
    checker,
    repository,
    leaseManager,
    backupService,
    restoreService,
  } = createComponents(options);

  return {
    async checkIntegrity(databasePath) {
      const canonicalPath = canonicalDatabasePath(databasePath);
      const lease = leaseManager.acquireActive(canonicalPath);
      try {
        return checker.checkPath(canonicalPath, "full");
      } finally {
        lease.release();
      }
    },

    createBackup(input) {
      return backupService.create(input);
    },

    listBackups(databasePath, root) {
      return repository.list(
        root ?? defaultBackupRoot(canonicalDatabasePath(databasePath)),
      );
    },

    verifyBackup(bundlePath) {
      return repository.verify(bundlePath);
    },

    restoreBackup(input) {
      return restoreService.restore(input);
    },
  };
};
