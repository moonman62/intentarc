import { describe, expect, it } from "vitest";
import {
  DurabilityError,
  durabilityErrorCodeSchema,
  durabilityErrorDetailsSchema,
} from "./errors.js";
import {
  backupManifestSchema,
  backupReasonSchema,
  diagnosticCaptureManifestSchema,
  integrityIssueDescriptionFor,
  integrityIssueSchema,
  integrityReportSchema,
  restoreResultSchema,
  verifiedBackupSchema,
} from "./model.js";

const manifest = {
  formatVersion: 1,
  backupId: "backup-1",
  createdAt: "2026-07-27T12:00:00.000Z",
  reason: "manual",
  storeId: "store-1",
  schemaVersion: 2,
  applicationVersion: "intentarc 0.0.0",
  byteSize: 42,
  sha256: "a".repeat(64),
} as const;

describe("durability contracts", () => {
  it("accepts a version-one backup manifest", () => {
    expect(backupManifestSchema.parse(manifest)).toMatchObject({
      reason: "manual",
      schemaVersion: 2,
    });
  });

  it("rejects fields outside a persisted backup manifest", () => {
    expect(() =>
      backupManifestSchema.parse({
        ...manifest,
        sourcePath: "C:/private/store.sqlite",
      }),
    ).toThrow();
  });

  it("rejects unsupported manifest formats, malformed digests, and negative sizes", () => {
    expect(() =>
      backupManifestSchema.parse({ ...manifest, formatVersion: 2 }),
    ).toThrow();
    expect(() =>
      backupManifestSchema.parse({ ...manifest, sha256: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      backupManifestSchema.parse({ ...manifest, byteSize: -1 }),
    ).toThrow();
  });

  it("uses the complete backup reason vocabulary", () => {
    expect(backupReasonSchema.options).toEqual([
      "manual",
      "pre-migration",
      "pre-restore",
    ]);
  });

  it("accepts only canonical integrity issue descriptions", () => {
    expect(integrityIssueDescriptionFor("foreign_key_violation")).toBe(
      "Foreign key integrity check failed.",
    );
    expect(integrityIssueDescriptionFor("store_metadata_invalid")).toBe(
      "Store metadata is invalid.",
    );
    expect(integrityIssueDescriptionFor("outbound_state_invalid")).toBe(
      "Outbound safety state is invalid.",
    );
    expect(integrityIssueDescriptionFor("coordination_state_invalid")).toBe(
      "Coordination state is invalid.",
    );
    expect(
      integrityIssueSchema.parse({
        code: "foreign_key_violation",
        severity: "error",
        description: integrityIssueDescriptionFor("foreign_key_violation"),
      }),
    ).toMatchObject({ severity: "error" });
    expect(() =>
      integrityIssueSchema.parse({
        code: "foreign_key_violation",
        severity: "error",
        description: "Project delivery plan is ready.",
      }),
    ).toThrow();
    expect(() =>
      integrityIssueSchema.parse({
        code: "foreign_key_violation",
        severity: "error",
        description: "SELECT body FROM records",
      }),
    ).toThrow();
    expect(() =>
      integrityIssueSchema.parse({
        code: "foreign_key_violation",
        severity: "error",
        description: "password=unredacted-secret",
      }),
    ).toThrow();
  });

  it("selects canonical error messages and permits only structured recovery details", () => {
    expect(() =>
      durabilityErrorDetailsSchema.parse({
        recoveryGuidance: "Read the project record body first.",
      }),
    ).toThrow();
    expect(() =>
      durabilityErrorDetailsSchema.parse({
        password: "unredacted-secret",
      }),
    ).toThrow();
    expect(() =>
      durabilityErrorDetailsSchema.parse({ rawSql: "SELECT body FROM records" }),
    ).toThrow();

    const error = new DurabilityError("migration_failed", {
      issueCodes: ["schema_object_missing"],
      originalSchemaVersion: 2,
      requestedSchemaVersion: 3,
      transactionPreserved: true,
      backupId: "backup-1",
      bundlePath: "C:/backups/backup-1.intentarc-backup",
      diagnosticCapturePath: "C:/diagnostics/target.intentarc-diagnostic",
      recoveryAction: "restore_verified_backup",
    });

    expect(error.message).toBe("Store migration failed.");
    expect(new DurabilityError("backup_failed").message).toBe(
      "Backup operation failed.",
    );
    expect(error.details).toEqual({
        issueCodes: ["schema_object_missing"],
        originalSchemaVersion: 2,
        requestedSchemaVersion: 3,
        transactionPreserved: true,
        backupId: "backup-1",
        bundlePath: "C:/backups/backup-1.intentarc-backup",
        diagnosticCapturePath: "C:/diagnostics/target.intentarc-diagnostic",
        recoveryAction: "restore_verified_backup",
    });
  });

  it("rejects unsafe error codes passed through an unsafe cast", () => {
    const unsafeCode = "SELECT password FROM C:/private/store.sqlite";
    let constructedError: DurabilityError | undefined;

    expect(() => {
      constructedError = new DurabilityError(unsafeCode as never);
    }).toThrow();
    expect(constructedError).toBeUndefined();
  });

  it("strictly parses returned integrity, verification, diagnostic, and restore documents", () => {
    const integrity = {
      level: "full",
      passed: true,
      checkedAt: "2026-07-27T12:00:00.000Z",
      storeId: "store-1",
      schemaVersion: 3,
      issues: [],
    } as const;

    expect(integrityReportSchema.parse(integrity)).toEqual(integrity);
    expect(
      verifiedBackupSchema.parse({
        manifest,
        bundlePath: "C:/backups/backup.intentarc-backup",
        verificationStatus: "verified",
        snapshotPath: "C:/backups/backup.intentarc-backup/database.sqlite",
        integrity,
      }),
    ).toMatchObject({ verificationStatus: "verified" });
    expect(
      diagnosticCaptureManifestSchema.parse({
        formatVersion: 1,
        captureId: "capture-1",
        createdAt: "2026-07-27T12:00:00.000Z",
        classification: "unverified_diagnostic",
        storeId: null,
        schemaVersion: null,
        issueCodes: ["integrity_failed"],
        files: ["database.sqlite", "database.sqlite-wal"],
      }),
    ).toMatchObject({ classification: "unverified_diagnostic" });
    expect(
      restoreResultSchema.parse({
        backupId: "backup-1",
        targetDatabasePath: "C:/data/intentarc.sqlite",
        storeId: "store-1",
        schemaVersion: 3,
        preRestoreBackup: null,
        diagnosticCapturePath: null,
      }),
    ).toMatchObject({ backupId: "backup-1" });
    expect(() => integrityReportSchema.parse({ ...integrity, rawSql: "SELECT 1" })).toThrow();
  });

  it("exposes every stable durability error code", () => {
    expect(durabilityErrorCodeSchema.options).toEqual([
      "integrity_failed",
      "backup_failed",
      "backup_invalid",
      "backup_destination_invalid",
      "maintenance_conflict",
      "unsupported_schema",
      "migration_failed",
      "restore_failed",
      "store_identity_mismatch",
      "confirmation_required",
    ]);
  });
});
