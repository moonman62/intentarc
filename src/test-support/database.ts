import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "../storage/migrations.js";

export type TemporaryDatabase = {
  readonly directory: string;
  readonly path: string;
};

export const createTemporaryDatabase = (): TemporaryDatabase => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc-"));

  return {
    directory,
    path: join(directory, "intentarc.sqlite"),
  };
};

export const removeTemporaryDatabase = (database: TemporaryDatabase): void => {
  rmSync(database.directory, { recursive: true, force: true });
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

/** Captures selected (or all) application rows as deterministic bytes without migrating or mutating. */
export const captureDatabaseRows = (
  path: string,
  includedTables?: readonly string[],
): Buffer => {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const availableTables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name COLLATE BINARY
    `).all() as Array<{ name: string }>;
    const availableNames = new Set(availableTables.map(({ name }) => name));
    const selectedNames = includedTables === undefined
      ? availableTables.map(({ name }) => name)
      : [...new Set(includedTables)].sort();
    if (selectedNames.some((name) => !availableNames.has(name))) {
      throw new Error("Snapshot table does not exist");
    }
    const snapshot = selectedNames.map((name) => ({
      name,
      rows: database.prepare(
        `SELECT * FROM ${quoteIdentifier(name)} ORDER BY rowid`,
      ).all(),
    }));
    return Buffer.from(JSON.stringify(snapshot), "utf8");
  } finally {
    database.close();
  }
};

/** Creates a historical schema fixture without invoking openDatabase migrations. */
export const createVersionedDatabaseFixture = (
  path: string,
  version: 1 | 2 | 3 | 4,
): Database.Database => {
  const database = new Database(path);
  for (const migration of migrations) {
    if (migration.version > version) break;
    database.exec(migration.sql);
  }
  database.pragma(`user_version = ${version}`);
  return database;
};
