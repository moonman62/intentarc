import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { DurabilityError } from "../durability/errors.js";
import { canonicalDatabasePath } from "../durability/filesystem-identity.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import { runMigrations } from "../durability/migration-runner.js";
import {
  integrityIssueCodeSchema,
  type IntegrityReport,
} from "../durability/model.js";
import { migrations } from "./migrations.js";

export type IntentArcDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly now?: () => string;
  readonly storeId?: string;
}

const integrityFailure = (report: IntegrityReport): DurabilityError =>
  new DurabilityError("integrity_failed", {
    issueCodes: integrityIssueCodeSchema.array().parse(
      report.issues.map(({ code }) => code),
    ),
  });

export const configureDatabase = (
  database: IntentArcDatabase,
): IntentArcDatabase => {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");
  return database;
};

export const openDatabase = (
  path: string,
  options: OpenDatabaseOptions = {},
): IntentArcDatabase => {
  let database: IntentArcDatabase | undefined;

  try {
    const openedDatabase = new Database(canonicalDatabasePath(path));
    database = openedDatabase;
    configureDatabase(openedDatabase);
    const currentVersion = openedDatabase.pragma("user_version", {
      simple: true,
    }) as number;
    const requestedVersion = migrations.at(-1)!.version;
    const checker = createIntegrityChecker(
      options.now === undefined ? {} : { now: options.now },
    );

    if (currentVersion === 0) {
      const objectCount = openedDatabase.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master",
      ).get() as { count: number };
      if (objectCount.count !== 0) {
        throw new DurabilityError("unsupported_schema");
      }
      const now = options.now ?? (() => new Date().toISOString());
      runMigrations({
        database: openedDatabase,
        currentVersion,
        storeId: options.storeId ?? `store-${randomUUID()}`,
        now: now(),
        validateBeforeCommit(connection) {
          const report = checker.checkConnection(connection, "full");
          if (!report.passed) throw integrityFailure(report);
        },
      });
    } else if (currentVersion !== requestedVersion) {
      throw new DurabilityError("unsupported_schema");
    } else {
      const report = checker.checkConnection(openedDatabase, "compatibility");
      if (!report.passed) {
        if (report.issues.some(({ code }) => code === "unsupported_schema")) {
          throw new DurabilityError("unsupported_schema");
        }
        throw integrityFailure(report);
      }
    }

    return openedDatabase;
  } catch (error) {
    database?.close();
    throw error;
  }
};
