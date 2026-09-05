import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const timestampSchema = z.iso.datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const fileNameSchema = nonEmptyStringSchema.refine(
  (file) => !/[\\/]/.test(file) && file !== "." && file !== "..",
  { message: "Diagnostic file names must be relative file names" },
);

export type IntegrityLevel = "compatibility" | "full";

export const integrityIssueCodeSchema = z.enum([
  "database_unreadable",
  "schema_version_invalid",
  "unsupported_schema",
  "schema_object_missing",
  "store_metadata_invalid",
  "integrity_check_failed",
  "foreign_key_violation",
  "record_revision_mismatch",
  "revision_snapshot_invalid",
  "cross_project_relationship",
  "hierarchy_endpoint_invalid",
  "hierarchy_multiple_parents",
  "hierarchy_cycle",
  "cross_project_context_pack",
  "cross_project_governance_reference",
  "stored_json_invalid",
  "credential_hash_invalid",
  "outbound_state_invalid",
  "repository_import_state_invalid",
  "repository_index_state_invalid",
  "coordination_state_invalid",
  "proposal_origin_invalid",
  "proposal_operation_invalid",
  "proposal_project_invalid",
  "proposal_snapshot_invalid",
]);

export type IntegrityIssueCode = z.infer<typeof integrityIssueCodeSchema>;

const integrityIssueDefinition: Record<
  IntegrityIssueCode,
  { severity: IntegrityIssue["severity"]; description: string }
> = {
  database_unreadable: {
    severity: "error",
    description: "Database cannot be read.",
  },
  schema_version_invalid: {
    severity: "error",
    description: "Schema version is invalid.",
  },
  unsupported_schema: {
    severity: "error",
    description: "Schema version is unsupported.",
  },
  schema_object_missing: {
    severity: "error",
    description: "Required schema object is missing.",
  },
  store_metadata_invalid: {
    severity: "error",
    description: "Store metadata is invalid.",
  },
  integrity_check_failed: {
    severity: "error",
    description: "Database integrity check failed.",
  },
  foreign_key_violation: {
    severity: "error",
    description: "Foreign key integrity check failed.",
  },
  record_revision_mismatch: {
    severity: "error",
    description: "Record revision does not match its snapshot.",
  },
  revision_snapshot_invalid: {
    severity: "error",
    description: "Record revision snapshot is invalid.",
  },
  cross_project_relationship: {
    severity: "error",
    description: "Relationship crosses project boundaries.",
  },
  hierarchy_endpoint_invalid: {
    severity: "error",
    description: "Hierarchy relationship has a non-hierarchy endpoint.",
  },
  hierarchy_multiple_parents: {
    severity: "error",
    description: "Hierarchy record has multiple parents.",
  },
  hierarchy_cycle: {
    severity: "error",
    description: "Hierarchy relationships contain a cycle.",
  },
  cross_project_context_pack: {
    severity: "error",
    description: "Context pack crosses project boundaries.",
  },
  cross_project_governance_reference: {
    severity: "error",
    description: "Governance reference crosses project boundaries.",
  },
  stored_json_invalid: {
    severity: "error",
    description: "Stored structured data is invalid.",
  },
  credential_hash_invalid: {
    severity: "error",
    description: "Credential hash is invalid.",
  },
  outbound_state_invalid: {
    severity: "error",
    description: "Outbound safety state is invalid.",
  },
  repository_import_state_invalid: {
    severity: "error",
    description: "Repository import state is invalid.",
  },
  repository_index_state_invalid: {
    severity: "error",
    description: "Repository index state is invalid.",
  },
  coordination_state_invalid: {
    severity: "error",
    description: "Coordination state is invalid.",
  },
  proposal_origin_invalid: {
    severity: "error",
    description: "Proposal origin state is invalid.",
  },
  proposal_operation_invalid: {
    severity: "error",
    description: "Proposal operation state is invalid.",
  },
  proposal_project_invalid: {
    severity: "error",
    description: "Proposal project ownership is invalid.",
  },
  proposal_snapshot_invalid: {
    severity: "error",
    description: "Proposal repository snapshot is invalid.",
  },
};

export const integrityIssueDescriptionFor = (code: IntegrityIssueCode): string =>
  integrityIssueDefinition[code].description;

export interface IntegrityIssue {
  code: string;
  severity: "error" | "warning";
  description: string;
}

export interface IntegrityReport {
  level: "compatibility" | "full";
  passed: boolean;
  checkedAt: string;
  storeId: string | null;
  schemaVersion: number | null;
  issues: IntegrityIssue[];
}

export type BackupReason = "manual" | "pre-migration" | "pre-restore";

export interface BackupManifest {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  reason: "manual" | "pre-migration" | "pre-restore";
  storeId: string;
  schemaVersion: number;
  applicationVersion: string;
  byteSize: number;
  sha256: string;
}

export interface BackupSummary {
  manifest: BackupManifest;
  bundlePath: string;
  verificationStatus: "not_checked" | "verified";
}

export interface VerifiedBackup extends BackupSummary {
  snapshotPath: string;
  integrity: IntegrityReport & { passed: true };
  verificationStatus: "verified";
}

export interface DiagnosticCaptureManifest {
  formatVersion: 1;
  captureId: string;
  createdAt: string;
  classification: "unverified_diagnostic";
  storeId: string | null;
  schemaVersion: number | null;
  issueCodes: string[];
  files: string[];
}

export interface CreateBackupInput {
  databasePath: string;
  outputRoot?: string;
  reason: BackupReason;
}

export interface RestoreBackupInput {
  targetDatabasePath: string;
  bundlePath: string;
  confirmed: boolean;
  allowDifferentStore: boolean;
}

export interface RestoreResult {
  backupId: string;
  targetDatabasePath: string;
  storeId: string;
  schemaVersion: number;
  preRestoreBackup: BackupSummary | null;
  diagnosticCapturePath: string | null;
}

export const integrityLevelSchema = z.enum(["compatibility", "full"]);

export const integrityIssueSchema = z
  .object({
    code: integrityIssueCodeSchema,
    severity: z.enum(["error", "warning"]),
    description: z.string(),
  })
  .strict()
  .superRefine((issue, context) => {
    const definition = integrityIssueDefinition[issue.code];
    if (issue.description !== definition.description) {
      context.addIssue({
        code: "custom",
        path: ["description"],
        message: "Integrity issue description must match its code",
      });
    }
    if (issue.severity !== definition.severity) {
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "Integrity issue severity must match its code",
      });
    }
  });

export const integrityReportSchema = z
  .object({
    level: integrityLevelSchema,
    passed: z.boolean(),
    checkedAt: timestampSchema,
    storeId: nonEmptyStringSchema.nullable(),
    schemaVersion: nonNegativeIntegerSchema.nullable(),
    issues: z.array(integrityIssueSchema),
  })
  .strict();

export const backupReasonSchema = z.enum([
  "manual",
  "pre-migration",
  "pre-restore",
]);

export const backupManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    backupId: nonEmptyStringSchema,
    createdAt: timestampSchema,
    reason: backupReasonSchema,
    storeId: nonEmptyStringSchema,
    schemaVersion: nonNegativeIntegerSchema,
    applicationVersion: nonEmptyStringSchema,
    byteSize: nonNegativeIntegerSchema,
    sha256: sha256Schema,
  })
  .strict();

export const backupSummarySchema = z
  .object({
    manifest: backupManifestSchema,
    bundlePath: nonEmptyStringSchema,
    verificationStatus: z.enum(["not_checked", "verified"]),
  })
  .strict();

export const verifiedBackupSchema = z
  .object({
    manifest: backupManifestSchema,
    bundlePath: nonEmptyStringSchema,
    verificationStatus: z.literal("verified"),
    snapshotPath: nonEmptyStringSchema,
    integrity: integrityReportSchema.extend({ passed: z.literal(true) }).strict(),
  })
  .strict();

export const diagnosticCaptureManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    captureId: nonEmptyStringSchema,
    createdAt: timestampSchema,
    classification: z.literal("unverified_diagnostic"),
    storeId: nonEmptyStringSchema.nullable(),
    schemaVersion: nonNegativeIntegerSchema.nullable(),
    issueCodes: z.array(nonEmptyStringSchema),
    files: z.array(fileNameSchema),
  })
  .strict();

export const createBackupInputSchema = z
  .object({
    databasePath: nonEmptyStringSchema,
    outputRoot: nonEmptyStringSchema.optional(),
    reason: backupReasonSchema,
  })
  .strict();

export const restoreBackupInputSchema = z
  .object({
    targetDatabasePath: nonEmptyStringSchema,
    bundlePath: nonEmptyStringSchema,
    confirmed: z.boolean(),
    allowDifferentStore: z.boolean(),
  })
  .strict();

export const restoreResultSchema = z
  .object({
    backupId: nonEmptyStringSchema,
    targetDatabasePath: nonEmptyStringSchema,
    storeId: nonEmptyStringSchema,
    schemaVersion: nonNegativeIntegerSchema,
    preRestoreBackup: backupSummarySchema.nullable(),
    diagnosticCapturePath: nonEmptyStringSchema.nullable(),
  })
  .strict();
