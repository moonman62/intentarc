import { z } from "zod";
import { integrityIssueCodeSchema } from "./model.js";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const backupIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const backupBundlePathSchema = z
  .string()
  .trim()
  .regex(/^[^\r\n]+\.intentarc-backup$/);
const diagnosticCapturePathSchema = z
  .string()
  .trim()
  .regex(/^[^\r\n]+\.intentarc-diagnostic$/);

export const durabilityErrorCodeSchema = z.enum([
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

export type DurabilityErrorCode = z.infer<typeof durabilityErrorCodeSchema>;

export const durabilityErrorMessageFor = (
  code: DurabilityErrorCode,
): string =>
  ({
    integrity_failed: "Store integrity check failed.",
    backup_failed: "Backup operation failed.",
    backup_invalid: "Backup bundle is invalid.",
    backup_destination_invalid: "Backup destination is invalid.",
    maintenance_conflict: "Store maintenance is unavailable.",
    unsupported_schema: "Store schema is unsupported.",
    migration_failed: "Store migration failed.",
    restore_failed: "Store restore failed.",
    store_identity_mismatch: "Store identity does not match.",
    confirmation_required: "Restore confirmation is required.",
  })[code];

export const recoveryActionSchema = z.enum([
  "retry",
  "restore_verified_backup",
  "inspect_diagnostic_capture",
]);

export const durabilityErrorDetailsSchema = z
  .object({
    issueCodes: z.array(integrityIssueCodeSchema).optional(),
    originalSchemaVersion: nonNegativeIntegerSchema.optional(),
    requestedSchemaVersion: nonNegativeIntegerSchema.optional(),
    transactionPreserved: z.boolean().optional(),
    backupId: backupIdSchema.optional(),
    bundlePath: backupBundlePathSchema.optional(),
    recoveryAction: recoveryActionSchema.optional(),
    originalReinstated: z.boolean().optional(),
    diagnosticCapturePath: diagnosticCapturePathSchema.optional(),
  })
  .strict();

export type DurabilityErrorDetails = z.infer<typeof durabilityErrorDetailsSchema>;

export class DurabilityError extends Error {
  readonly code: DurabilityErrorCode;
  readonly details: Readonly<DurabilityErrorDetails>;

  constructor(
    code: DurabilityErrorCode,
    details: Readonly<DurabilityErrorDetails> = {},
  ) {
    const parsedCode = durabilityErrorCodeSchema.parse(code);
    const parsedDetails = durabilityErrorDetailsSchema.parse(details);
    super(durabilityErrorMessageFor(parsedCode));
    this.code = parsedCode;
    this.details = parsedDetails;
    this.name = "DurabilityError";
  }
}
