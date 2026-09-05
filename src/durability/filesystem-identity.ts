import {
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DurabilityError } from "./errors.js";

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const isMissing = (error: unknown): boolean =>
  hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");

const identityUnsafe = (): never => {
  throw new DurabilityError("maintenance_conflict");
};

/**
 * Returns one filesystem spelling for a database path.
 *
 * Existing symbolic-link and directory aliases resolve to their real target.
 * A missing database resolves through its nearest existing ancestor. Existing
 * primary files with multiple hard links are rejected because no pathname can
 * provide a unique place for SQLite sidecars or IntentArc lease state.
 */
export const canonicalDatabasePath = (databasePath: string): string => {
  let candidate = resolve(databasePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) return identityUnsafe();
      const parent = dirname(candidate);
      if (parent === candidate) return identityUnsafe();
      missingSegments.push(basename(candidate));
      candidate = parent;
      continue;
    }

    try {
      const canonicalAncestor = realpathSync(candidate);
      const ancestor = statSync(canonicalAncestor, { bigint: true });
      if (missingSegments.length === 0) {
        if (!ancestor.isFile() || ancestor.nlink !== 1n) {
          return identityUnsafe();
        }
        return canonicalAncestor;
      }
      if (!ancestor.isDirectory()) return identityUnsafe();
      return resolve(
        canonicalAncestor,
        ...missingSegments.reverse(),
      );
    } catch (error) {
      if (error instanceof DurabilityError) throw error;
      return identityUnsafe();
    }
  }
};
