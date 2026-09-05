import type { IntentArcDatabase } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";
import { DurabilityError } from "./errors.js";

export interface RunMigrationsOptions {
  readonly database: IntentArcDatabase;
  readonly currentVersion: number;
  readonly storeId: string;
  readonly now: string;
  readonly validateBeforeCommit: (database: IntentArcDatabase) => void;
}

export const runMigrations = ({
  database,
  currentVersion,
  storeId,
  now,
  validateBeforeCommit,
}: RunMigrationsOptions): void => {
  const requestedVersion = migrations.at(-1)!.version;
  if (
    !Number.isInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > requestedVersion
  ) {
    throw new DurabilityError("unsupported_schema");
  }

  const pending = migrations.filter(
    (migration) => migration.version > currentVersion,
  );

  database.transaction(() => {
    for (const migration of pending) {
      database.exec(migration.sql);
      migration.initialize?.(database, { storeId, now });
      database.pragma(`user_version = ${migration.version}`);
    }
    validateBeforeCommit(database);
  })();
};
