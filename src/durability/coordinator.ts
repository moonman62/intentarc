import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  configureDatabase,
  openDatabase,
  type IntentArcDatabase,
  type OpenDatabaseOptions,
} from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import {
  createBackupService,
  type BackupService,
} from "./backup-service.js";
import { createBundleRepository } from "./bundles.js";
import { DurabilityError } from "./errors.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";
import {
  createIntegrityChecker,
  type IntegrityChecker,
} from "./integrity.js";
import {
  createLeaseManager,
  type LeaseHandle,
  type LeaseManager,
} from "./leases.js";
import { runMigrations } from "./migration-runner.js";
import {
  integrityIssueCodeSchema,
  type BackupSummary,
  type IntegrityReport,
} from "./model.js";

export interface PreparedStore {
  readonly database: IntentArcDatabase;
  readonly storeId: string;
  close(): void;
}

export interface DurabilityCoordinator {
  prepareForApplication(databasePath: string): Promise<PreparedStore>;
  migrateStagedBackup(input: {
    databasePath: string;
    storeId: string;
  }): void;
}

type OpenCurrentDatabase = (
  path: string,
  options?: OpenDatabaseOptions,
) => IntentArcDatabase;

export interface DurabilityCoordinatorOptions {
  readonly checker?: IntegrityChecker;
  readonly leaseManager?: LeaseManager;
  readonly backupService?: BackupService;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly openCurrentDatabase?: OpenCurrentDatabase;
}

const requestedSchemaVersion = migrations.at(-1)!.version;

const issueCodesFor = (report: IntegrityReport) =>
  integrityIssueCodeSchema.array().parse(
    report.issues.map(({ code }) => code),
  );

const requirePassed = (report: IntegrityReport): IntegrityReport => {
  if (report.passed) return report;
  if (report.issues.some(({ code }) => code === "unsupported_schema")) {
    throw new DurabilityError("unsupported_schema");
  }
  throw new DurabilityError("integrity_failed", {
    issueCodes: issueCodesFor(report),
  });
};

const closeOwnedConnection = (
  database: IntentArcDatabase | undefined,
): void => {
  if (database?.open) database.close();
};

const releaseOwnedLease = (lease: LeaseHandle | undefined): void => {
  lease?.release();
};

const preparedStore = (
  database: IntentArcDatabase,
  storeId: string,
  activeLease: LeaseHandle,
): PreparedStore => {
  let closed = false;
  return {
    database,
    storeId,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        activeLease.release();
      }
    },
  };
};

const migrationFailure = (
  fromSchemaVersion: number,
  backup: BackupSummary,
  transactionPreserved: boolean,
): DurabilityError =>
  new DurabilityError("migration_failed", {
    originalSchemaVersion: fromSchemaVersion,
    requestedSchemaVersion,
    transactionPreserved,
    backupId: backup.manifest.backupId,
    bundlePath: backup.bundlePath,
  });

export const createDurabilityCoordinator = (
  options: DurabilityCoordinatorOptions = {},
): DurabilityCoordinator => {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;
  const checker = options.checker ?? createIntegrityChecker({ now });
  const leaseManager = options.leaseManager ?? createLeaseManager();
  const backupService = options.backupService ?? createBackupService({
    checker,
    repository: createBundleRepository(checker),
    leaseManager,
    now,
    newId,
  });
  const openCurrentDatabase =
    options.openCurrentDatabase ?? openDatabase;

  const validateFull = (database: IntentArcDatabase): void => {
    requirePassed(checker.checkConnection(database, "full"));
  };

  const openPrepared = (
    databasePath: string,
    expectedStoreId?: string,
    existingActiveLease?: LeaseHandle,
  ): PreparedStore => {
    let activeLease = existingActiveLease;
    let database: IntentArcDatabase | undefined;
    try {
      activeLease ??= leaseManager.acquireActive(databasePath);
      database = openCurrentDatabase(databasePath);
      const report = requirePassed(
        checker.checkConnection(database, "compatibility"),
      );
      if (
        report.schemaVersion !== requestedSchemaVersion ||
        report.storeId === null
      ) {
        throw new DurabilityError("unsupported_schema");
      }
      if (
        expectedStoreId !== undefined &&
        report.storeId !== expectedStoreId
      ) {
        throw new DurabilityError("store_identity_mismatch");
      }
      const result = preparedStore(database, report.storeId, activeLease);
      database = undefined;
      activeLease = undefined;
      return result;
    } finally {
      const ownedDatabase = database;
      database = undefined;
      try {
        closeOwnedConnection(ownedDatabase);
      } finally {
        releaseOwnedLease(activeLease);
      }
    }
  };

  const preparedUnderMaintenance = (
    databasePath: string,
    expectedStoreId: string,
    database: IntentArcDatabase,
    maintenance: LeaseHandle,
  ): PreparedStore => {
    let ownedDatabase: IntentArcDatabase | undefined = database;
    let ownedMaintenance: LeaseHandle | undefined = maintenance;
    let activeLease: LeaseHandle | undefined;
    try {
      const report = requirePassed(
        checker.checkConnection(database, "compatibility"),
      );
      if (
        report.schemaVersion !== requestedSchemaVersion ||
        report.storeId === null
      ) {
        throw new DurabilityError("unsupported_schema");
      }
      if (report.storeId !== expectedStoreId) {
        throw new DurabilityError("store_identity_mismatch");
      }

      activeLease = leaseManager.handoffMaintenanceToActive(
        databasePath,
        maintenance,
      );
      ownedMaintenance = undefined;
      const result = preparedStore(
        database,
        report.storeId,
        activeLease,
      );
      ownedDatabase = undefined;
      activeLease = undefined;
      return result;
    } finally {
      const databaseToClose = ownedDatabase;
      ownedDatabase = undefined;
      try {
        closeOwnedConnection(databaseToClose);
      } finally {
        try {
          releaseOwnedLease(activeLease);
        } finally {
          releaseOwnedLease(ownedMaintenance);
        }
      }
    }
  };

  const initializeNew = (
    databasePath: string,
  ): PreparedStore => {
    let maintenance: LeaseHandle | undefined;
    let database: IntentArcDatabase | undefined;
    const storeId = `store-${newId()}`;
    try {
      maintenance = leaseManager.acquireMaintenance(databasePath);
      database = openCurrentDatabase(databasePath, {
        now,
        storeId,
      });
      const result = preparedUnderMaintenance(
        databasePath,
        storeId,
        database,
        maintenance,
      );
      database = undefined;
      maintenance = undefined;
      return result;
    } finally {
      const ownedDatabase = database;
      database = undefined;
      try {
        closeOwnedConnection(ownedDatabase);
      } finally {
        releaseOwnedLease(maintenance);
      }
    }
  };

  const migrateOld = async (
    databasePath: string,
  ): Promise<PreparedStore> => {
    let maintenance: LeaseHandle | undefined;
    let database: IntentArcDatabase | undefined;
    let backup: BackupSummary | undefined;
    let fromSchemaVersion: number | undefined;
    try {
      maintenance = leaseManager.acquireMaintenance(databasePath);
      const compatibilityReport = requirePassed(
        checker.checkPath(databasePath, "compatibility"),
      );
      if (compatibilityReport.schemaVersion === requestedSchemaVersion) {
        const currentStoreId = compatibilityReport.storeId;
        if (currentStoreId === null) {
          throw new DurabilityError("integrity_failed", {
            issueCodes: issueCodesFor(compatibilityReport),
          });
        }
        database = openCurrentDatabase(databasePath);
        const result = preparedUnderMaintenance(
          databasePath,
          currentStoreId,
          database,
          maintenance,
        );
        database = undefined;
        maintenance = undefined;
        return result;
      }
      if (
        compatibilityReport.schemaVersion === null ||
        compatibilityReport.schemaVersion < 1 ||
        compatibilityReport.schemaVersion >= requestedSchemaVersion
      ) {
        throw new DurabilityError("unsupported_schema");
      }

      const oldReport = requirePassed(checker.checkPath(databasePath, "full"));
      fromSchemaVersion = oldReport.schemaVersion ?? undefined;
      if (
        fromSchemaVersion === undefined ||
        fromSchemaVersion < 1 ||
        fromSchemaVersion >= requestedSchemaVersion
      ) {
        throw new DurabilityError("unsupported_schema");
      }

      const storeId =
        compatibilityReport.storeId ?? `store-${newId()}`;
      database = new Database(canonicalDatabasePath(databasePath), {
        fileMustExist: true,
      });
      configureDatabase(database);
      backup = await backupService.createFromConnection(database, {
        databasePath,
        reason: "pre-migration",
        storeId,
      });
      if (backup.verificationStatus !== "verified") {
        throw new DurabilityError("backup_failed");
      }

      try {
        runMigrations({
          database,
          currentVersion: fromSchemaVersion,
          storeId,
          now: now(),
          validateBeforeCommit: validateFull,
        });
      } catch {
        throw migrationFailure(fromSchemaVersion, backup, true);
      }

      try {
        const migratedDatabase = database;
        database = undefined;
        closeOwnedConnection(migratedDatabase);
        database = openCurrentDatabase(databasePath);
        const result = preparedUnderMaintenance(
          databasePath,
          storeId,
          database,
          maintenance,
        );
        database = undefined;
        maintenance = undefined;
        return result;
      } catch {
        throw migrationFailure(fromSchemaVersion, backup, false);
      }
    } finally {
      const ownedDatabase = database;
      database = undefined;
      try {
        closeOwnedConnection(ownedDatabase);
      } finally {
        releaseOwnedLease(maintenance);
      }
    }
  };

  return {
    async prepareForApplication(databasePath) {
      const canonicalPath = canonicalDatabasePath(databasePath);
      if (!existsSync(canonicalPath)) {
        return initializeNew(canonicalPath);
      }

      let activeLease: LeaseHandle | undefined;
      try {
        activeLease = leaseManager.acquireActive(canonicalPath);
        const report = requirePassed(
          checker.checkPath(canonicalPath, "compatibility"),
        );
        if (report.schemaVersion === requestedSchemaVersion) {
          const currentActiveLease = activeLease;
          activeLease = undefined;
          return openPrepared(
            canonicalPath,
            report.storeId ?? undefined,
            currentActiveLease,
          );
        }
        if (report.schemaVersion === 0) {
          const emptyStoreActiveLease = activeLease;
          activeLease = undefined;
          emptyStoreActiveLease.release();
          return initializeNew(canonicalPath);
        }
        if (
          report.schemaVersion !== null &&
          report.schemaVersion > 0 &&
          report.schemaVersion < requestedSchemaVersion
        ) {
          const oldStoreActiveLease = activeLease;
          activeLease = undefined;
          oldStoreActiveLease.release();
          return migrateOld(canonicalPath);
        }
        throw new DurabilityError("unsupported_schema");
      } finally {
        releaseOwnedLease(activeLease);
      }
    },

    migrateStagedBackup(input) {
      let database: IntentArcDatabase | undefined;
      try {
        database = new Database(canonicalDatabasePath(input.databasePath), {
          fileMustExist: true,
        });
        configureDatabase(database);
        const currentVersion = database.pragma("user_version", {
          simple: true,
        }) as number;
        if (currentVersion > requestedSchemaVersion || currentVersion < 0) {
          throw new DurabilityError("unsupported_schema");
        }
        if (currentVersion < requestedSchemaVersion) {
          runMigrations({
            database,
            currentVersion,
            storeId: input.storeId,
            now: now(),
            validateBeforeCommit: validateFull,
          });
        } else {
          const report = requirePassed(
            checker.checkConnection(database, "full"),
          );
          if (report.storeId !== input.storeId) {
            throw new DurabilityError("store_identity_mismatch");
          }
        }
      } finally {
        closeOwnedConnection(database);
      }
    },
  };
};
