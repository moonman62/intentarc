import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  importApplyResultSchema,
  projectRecordSchema,
  projectSchema,
  proposedImportRecordSchema,
  proposedImportRelationshipSchema,
  recordRelationshipSchema,
  repositoryImportManifestSchema,
  type ImportApplyResult,
  type Project,
  type ProjectRecord,
  type RecordRelationship,
  type RepositoryImportManifest,
} from "../domain/index.js";
import { RepositoryImportError } from "../import/errors.js";
import { assertDatabaseOutsideRepository } from "../import/output-containment.js";
import type { IntentArcDatabase } from "./database.js";
import { validateParentHierarchy } from "./project-store.js";
import {
  createInitialRepositorySnapshot,
  serializeInitialRepositorySnapshot,
} from "./repository-import-evidence.js";

export interface ApplyInitialRepositorySnapshotInput {
  readonly manifest: RepositoryImportManifest;
  readonly manifestDigest: string;
  readonly repositoryFingerprint: string;
}

export interface RepositoryImportStore {
  findByDigest(manifestDigest: string): ImportApplyResult | null;
  applyInitialSnapshot(
    input: ApplyInitialRepositorySnapshotInput,
  ): ImportApplyResult;
}

export interface RepositoryImportStoreDependencies {
  readonly now?: () => string;
  readonly newId?: (
    prefix: "project" | "record" | "relationship" | "audit",
  ) => string;
}

type ReceiptRow = {
  manifest_digest: string;
  project_id: string;
  repository_fingerprint: string;
};

type PlannedRecord = {
  readonly record: ProjectRecord;
  readonly localKey: string;
};

type PlannedRelationship = {
  readonly relationship: RecordRelationship;
};

type ImportPlan = {
  readonly project: Project & { readonly revision: 1 };
  readonly records: readonly PlannedRecord[];
  readonly relationships: readonly PlannedRelationship[];
  readonly auditId: string;
  readonly manifestDigest: string;
  readonly repositoryFingerprint: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly manifestVersion: number;
  readonly initialSnapshotDigest: string;
  readonly initialSnapshotJson: string;
};

type SqliteError = Error & { code?: string };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const importFailed = (): RepositoryImportError<"import_failed"> =>
  new RepositoryImportError("import_failed", {});

const mapStorageError = (error: unknown): RepositoryImportError => {
  if (error instanceof RepositoryImportError) return error;
  const code = error instanceof Error
    ? (error as SqliteError).code
    : undefined;
  if (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return new RepositoryImportError("import_conflict", { count: 1 });
  }
  return importFailed();
};

const replayResult = (row: ReceiptRow): ImportApplyResult =>
  importApplyResultSchema.parse({
    projectId: row.project_id,
    manifestDigest: row.manifest_digest,
    repositoryFingerprint: row.repository_fingerprint,
    revisionBefore: 0,
    revisionAfter: 1,
    replayed: true,
  });

export const createRepositoryImportStore = (
  database: IntentArcDatabase,
  dependencies: RepositoryImportStoreDependencies = {},
): RepositoryImportStore => {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newId = dependencies.newId ??
    ((prefix: "project" | "record" | "relationship" | "audit") =>
      `${prefix}-${randomUUID()}`);

  const selectReceipt = database.prepare(`
    SELECT manifest_digest, project_id, repository_fingerprint
    FROM repository_import_receipts
    WHERE manifest_digest = ?
  `);
  const insertProject = database.prepare(`
    INSERT INTO projects (
      id, name, revision, primary_repository_path, created_at, updated_at
    ) VALUES (
      @id, @name, @revision, @primaryRepositoryPath, @createdAt, @updatedAt
    )
  `);
  const insertRecord = database.prepare(`
    INSERT INTO project_records (
      id, project_id, kind, status, title, body, source_kind, source_ref,
      revision, created_at, updated_at
    ) VALUES (
      @id, @projectId, @kind, @status, @title, @body, @sourceKind, @sourceRef,
      @revision, @createdAt, @updatedAt
    )
  `);
  const insertRecordRevision = database.prepare(`
    INSERT INTO project_record_revisions (
      record_id, revision, snapshot_json, created_at
    ) VALUES (
      @recordId, @revision, @snapshotJson, @createdAt
    )
  `);
  const insertRelationship = database.prepare(`
    INSERT INTO record_relationships (
      id, project_id, from_record_id, to_record_id, kind, created_at
    ) VALUES (
      @id, @projectId, @fromRecordId, @toRecordId, @kind, @createdAt
    )
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO repository_import_receipts (
      manifest_digest, project_id, repository_fingerprint, scanner_version,
      ruleset_version, manifest_version, record_count, relationship_count,
      initial_snapshot_digest, initial_snapshot_json, created_at
    ) VALUES (
      @manifestDigest, @projectId, @repositoryFingerprint, @scannerVersion,
      @rulesetVersion, @manifestVersion, @recordCount, @relationshipCount,
      @initialSnapshotDigest, @initialSnapshotJson, @createdAt
    )
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_import',
      'repository_import_applied', @projectId, NULL, 0,
      1, 'applied', NULL, @createdAt
    )
  `);

  const findByDigest = (manifestDigest: string): ImportApplyResult | null => {
    try {
      const digest = sha256Schema.parse(manifestDigest);
      const row = selectReceipt.get(digest) as ReceiptRow | undefined;
      return row === undefined ? null : replayResult(row);
    } catch (error) {
      throw mapStorageError(error);
    }
  };

  const applyTransaction = database.transaction((plan: ImportPlan): ImportApplyResult => {
    const existing = selectReceipt.get(plan.manifestDigest) as
      | ReceiptRow
      | undefined;
    if (existing !== undefined) return replayResult(existing);

    insertProject.run(plan.project);
    for (const { record } of plan.records) {
      insertRecord.run(record);
      insertRecordRevision.run({
        recordId: record.id,
        revision: record.revision,
        snapshotJson: JSON.stringify(record),
        createdAt: record.createdAt,
      });
    }
    for (const { relationship } of plan.relationships) {
      insertRelationship.run(relationship);
    }
    insertReceipt.run({
      manifestDigest: plan.manifestDigest,
      projectId: plan.project.id,
      repositoryFingerprint: plan.repositoryFingerprint,
      scannerVersion: plan.scannerVersion,
      rulesetVersion: plan.rulesetVersion,
      manifestVersion: plan.manifestVersion,
      recordCount: plan.records.length,
      relationshipCount: plan.relationships.length,
      initialSnapshotDigest: plan.initialSnapshotDigest,
      initialSnapshotJson: plan.initialSnapshotJson,
      createdAt: plan.project.createdAt,
    });
    insertAudit.run({
      id: plan.auditId,
      projectId: plan.project.id,
      createdAt: plan.project.createdAt,
    });

    return importApplyResultSchema.parse({
      projectId: plan.project.id,
      manifestDigest: plan.manifestDigest,
      repositoryFingerprint: plan.repositoryFingerprint,
      revisionBefore: 0,
      revisionAfter: 1,
      replayed: false,
    });
  });

  return {
    findByDigest,

    applyInitialSnapshot(
      input: ApplyInitialRepositorySnapshotInput,
    ): ImportApplyResult {
      try {
        const parsedManifest = repositoryImportManifestSchema.parse(
          input.manifest,
        );
        assertDatabaseOutsideRepository(
          parsedManifest.repository.root,
          database.name,
        );
        const replay = findByDigest(input.manifestDigest);
        if (replay !== null) return replay;
        const parsedRecords = proposedImportRecordSchema.array().parse(
          parsedManifest.proposal.records,
        );
        const parsedRelationships = proposedImportRelationshipSchema.array()
          .parse(parsedManifest.proposal.relationships);
        const digest = sha256Schema.parse(input.manifestDigest);
        const fingerprint = sha256Schema.parse(input.repositoryFingerprint);
        const createdAt = z.iso.datetime().parse(now());
        const projectId = newId("project");
        const project = projectSchema.parse({
          id: projectId,
          name: parsedManifest.proposal.project.name,
          revision: 1,
          primaryRepositoryPath:
            parsedManifest.proposal.project.primaryRepositoryPath,
          createdAt,
          updatedAt: createdAt,
        }) as Project & { revision: 1 };
        const records: PlannedRecord[] = parsedRecords.map((proposed) => ({
          localKey: proposed.key,
          record: projectRecordSchema.parse({
            id: newId("record"),
            projectId: project.id,
            kind: proposed.kind,
            status: proposed.status,
            title: proposed.title,
            body: proposed.body,
            sourceKind: proposed.sourceKind,
            sourceRef: proposed.sourceRef,
            revision: 1,
            createdAt,
            updatedAt: createdAt,
          }),
        }));
        const recordIdsByLocalKey = new Map(
          records.map(({ localKey, record }) => [localKey, record.id] as const),
        );
        const relationships: PlannedRelationship[] = parsedRelationships.map(
          (proposed) => {
            const fromRecordId = recordIdsByLocalKey.get(proposed.fromKey);
            const toRecordId = recordIdsByLocalKey.get(proposed.toKey);
            if (fromRecordId === undefined || toRecordId === undefined) {
              throw importFailed();
            }
            return {
              relationship: recordRelationshipSchema.parse({
                id: newId("relationship"),
                projectId: project.id,
                fromRecordId,
                toRecordId,
                kind: proposed.kind,
                createdAt,
              }),
            };
          },
        );
        validateParentHierarchy(
          project.id,
          records.map(({ record }) => record),
          relationships.map(({ relationship }) => relationship),
        );
        const initialSnapshot = serializeInitialRepositorySnapshot(
          createInitialRepositorySnapshot(
            project.id,
            records.map(({ record }) => record),
            relationships.map(({ relationship }) => relationship),
          ),
        );
        const plan: ImportPlan = {
          project,
          records,
          relationships,
          auditId: newId("audit"),
          manifestDigest: digest,
          repositoryFingerprint: fingerprint,
          scannerVersion: parsedManifest.scannerVersion,
          rulesetVersion: parsedManifest.rulesetVersion,
          manifestVersion: parsedManifest.manifestVersion,
          initialSnapshotDigest: initialSnapshot.digest,
          initialSnapshotJson: initialSnapshot.json,
        };

        return applyTransaction.immediate(plan);
      } catch (error) {
        throw mapStorageError(error);
      }
    },
  };
};
