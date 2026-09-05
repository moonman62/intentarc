import Database from "better-sqlite3";
import { z } from "zod";
import {
  changeOperationSchema,
  changeOperationsSchema,
  checkpointResultSchema,
  checkpointDocumentSchema,
  claimTaskResultSchema,
  coordinationIdempotencyOperations,
  coordinationEventSchema,
  delegationScopeSchema,
  delegationResultSchema,
  hierarchyVocabularySchema,
  isHierarchyRecordKind,
  neutralHierarchyVocabulary,
  outboundDestinationSchema,
  outboundDestinationSnapshotSchema,
  outboundDisclosureSchema,
  outboundFindingCountsSchema,
  outboundFindingSchema,
  outboundReleaseSchema,
  parseStoredSubmissionResult,
  projectRecordSchema,
  repositoryLinkSchema,
  repositoryNodeObservationSchema,
  repositoryNodeSchema,
  repositoryRefreshReviewSchema,
  repositorySnapshotSchema,
  repositorySourceSchema,
  submissionDocumentSchema,
  submissionResultSchema,
  switchTaskResultSchema,
  taskCheckpointSchema,
  taskClaimSchema,
  taskDelegationSchema,
  taskSubmissionSchema,
  transitionClaimResultSchema,
  renewClaimResultSchema,
  taskContextPackSchema,
  type OutboundDestination,
  type OutboundDestinationSnapshot,
  type OutboundFinding,
  type OutboundFindingCounts,
  type OutboundRelease,
  type TaskContextPack,
  type CoordinationEvent,
} from "../domain/index.js";
import {
  selectedCheckpointHistoryIsCoherent,
  selectedClaimHistoryIsCoherent,
  selectedDelegationHistoryIsCoherent,
  selectedSubmissionHistoryIsCoherent,
  taskClaimLifecycleIsCoherent,
  taskDelegationLifecycleIsCoherent,
} from "../domain/coordination-semantics.js";
import {
  computeOutboundRequestHash,
  computeOutboundReleaseDigest,
  createOutboundSafetyEngine,
  OUTBOUND_DETECTOR_VERSION,
  OUTBOUND_SAFETY_POLICY_VERSION,
} from "../outbound/safety-engine.js";
import type { IntentArcDatabase } from "../storage/database.js";
import { parseStoredHumanChangeReplay } from "../storage/human-change-replay.js";
import {
  changeProposalsProfileIdempotencyIndexSql,
  changeProposalsProjectStateIndexSql,
  changeProposalsRepositorySnapshotIndexSql,
  changeProposalsTableSql,
  coordinationEventsNoDeleteTriggerSql,
  coordinationEventsNoUpdateTriggerSql,
  coordinationEventsTableSql,
  coordinationIdempotencyTableSql,
  coordinationProposalStateSyncTriggerSql,
  humanChangeIdempotencyResultsTableSql,
  migrations,
  proposalOperationsNoDeleteTriggerSql,
  proposalOperationsNoUpdateTriggerSql,
  proposalOperationsTableSql,
  repositoryImportReceiptsNoDeleteTriggerSql,
  repositoryImportReceiptsNoUpdateTriggerSql,
  repositoryImportReceiptsTableSql,
  taskCheckpointsNoDeleteTriggerSql,
  taskCheckpointsNoUpdateTriggerSql,
  taskCheckpointsTableSql,
  taskClaimsOneActiveIndexSql,
  taskClaimsOneSubmittedIndexSql,
  taskClaimsTableSql,
  taskDelegationsOneLiveIndexSql,
  taskDelegationsTableSql,
  taskSubmissionsImmutableFieldsTriggerSql,
  taskSubmissionsNoDeleteTriggerSql,
  taskSubmissionsTableSql,
} from "../storage/migrations.js";
import {
  coordinationEventReferencesAreApplicable,
  hasExactCoordinationEventTransition,
} from "../domain/coordination-semantics.js";
import { parseInitialRepositorySnapshot } from "../storage/repository-import-evidence.js";
import {
  integrityIssueDescriptionFor,
  type IntegrityIssue,
  type IntegrityIssueCode,
  type IntegrityLevel,
  type IntegrityReport,
} from "./model.js";
import { canonicalDatabasePath } from "./filesystem-identity.js";

export interface IntegrityChecker {
  checkPath(path: string, level: IntegrityLevel): IntegrityReport;
  checkConnection(database: IntentArcDatabase, level: IntegrityLevel): IntegrityReport;
}

type SchemaObject = readonly ["table" | "index" | "trigger", string];

const versionOneObjects: readonly SchemaObject[] = [
  ["table", "projects"],
  ["table", "project_records"],
  ["table", "project_record_revisions"],
  ["table", "record_relationships"],
  ["table", "context_packs"],
  ["index", "idx_records_project_kind_status"],
  ["index", "idx_relationships_from"],
  ["index", "idx_relationships_to"],
];

const versionTwoObjects: readonly SchemaObject[] = [
  ...versionOneObjects,
  ["table", "client_profiles"],
  ["table", "profile_project_authorities"],
  ["table", "profile_scopes"],
  ["table", "change_proposals"],
  ["table", "proposal_operations"],
  ["table", "idempotency_results"],
  ["table", "audit_events"],
  ["index", "idx_profile_project_authorities_profile_project"],
  ["index", "idx_change_proposals_project_state_created_at"],
  ["index", "idx_audit_events_project_created_at"],
  ["trigger", "audit_events_no_update"],
  ["trigger", "audit_events_no_delete"],
];

const versionThreeObjects: readonly SchemaObject[] = [
  ...versionTwoObjects,
  ["table", "store_metadata"],
];

const versionFourObjects: readonly SchemaObject[] = [
  ...versionThreeObjects,
  ["table", "outbound_destinations"],
  ["table", "outbound_policies"],
  ["table", "outbound_requests"],
  ["table", "outbound_findings"],
  ["table", "outbound_releases"],
  ["index", "idx_outbound_destinations_current_profile"],
  ["index", "idx_outbound_requests_profile_created_at"],
  ["index", "idx_outbound_requests_project_status_created_at"],
  ["index", "idx_outbound_findings_request_ordinal"],
  ["index", "idx_outbound_policies_lookup"],
  ["trigger", "outbound_releases_no_update"],
  ["trigger", "outbound_releases_no_delete"],
];

const versionFiveObjects: readonly SchemaObject[] = [
  ...versionFourObjects,
  ["table", "repository_import_receipts"],
  ["trigger", "repository_import_receipts_no_update"],
  ["trigger", "repository_import_receipts_no_delete"],
];

const versionSixObjects: readonly SchemaObject[] = versionFiveObjects;

const versionSevenObjects: readonly SchemaObject[] = [
  ...versionSixObjects,
  ["table", "repository_sources"],
  ["table", "repository_snapshots"],
  ["table", "repository_nodes"],
  ["table", "repository_node_observations"],
  ["table", "repository_links"],
  ["table", "repository_refresh_reviews"],
  ["index", "idx_project_records_id_project"],
  ["index", "idx_repository_snapshots_source_created_at"],
  ["index", "idx_repository_nodes_source_kind"],
  ["index", "idx_repository_node_observations_snapshot_path"],
  ["index", "idx_repository_node_observations_node"],
  ["index", "idx_repository_links_snapshot_from"],
  ["index", "idx_repository_links_record_target"],
  ["index", "idx_repository_links_node_target"],
  ["index", "idx_repository_refresh_reviews_source_state"],
  ["index", "idx_repository_refresh_reviews_pending_source"],
];

const versionEightObjects: readonly SchemaObject[] = [
  ...versionSevenObjects,
  ["index", "idx_change_proposals_profile_idempotency"],
  ["index", "idx_change_proposals_repository_snapshot"],
  ["trigger", "proposal_operations_no_update"],
  ["trigger", "proposal_operations_no_delete"],
];

const versionNineObjects: readonly SchemaObject[] = [
  ...versionEightObjects,
  ["table", "human_change_idempotency_results"],
];

const versionTenObjects: readonly SchemaObject[] = [
  ...versionNineObjects,
  ["table", "task_claims"],
  ["table", "task_checkpoints"],
  ["table", "task_delegations"],
  ["table", "task_submissions"],
  ["table", "coordination_events"],
  ["table", "coordination_idempotency"],
  ["index", "idx_task_claims_one_active"],
  ["index", "idx_task_claims_one_submitted"],
  ["index", "idx_task_delegations_one_live"],
  ["trigger", "task_checkpoints_no_update"],
  ["trigger", "task_checkpoints_no_delete"],
  ["trigger", "task_submissions_immutable_fields"],
  ["trigger", "task_submissions_no_delete"],
  ["trigger", "coordination_events_no_update"],
  ["trigger", "coordination_events_no_delete"],
  ["trigger", "coordination_proposal_state_sync"],
];

const versionElevenObjects: readonly SchemaObject[] = versionTenObjects;

const schemaObjectsFor = (version: number): readonly SchemaObject[] => {
  if (version === 1) return versionOneObjects;
  if (version === 2) return versionTwoObjects;
  if (version === 3) return versionThreeObjects;
  if (version === 4) return versionFourObjects;
  if (version === 5) return versionFiveObjects;
  if (version === 6) return versionSixObjects;
  if (version === 7) return versionSevenObjects;
  if (version === 8) return versionEightObjects;
  if (version === 9) return versionNineObjects;
  if (version === 10) return versionTenObjects;
  if (version === 11) return versionElevenObjects;
  return [];
};

const createIntegrityIssue = (code: IntegrityIssueCode): IntegrityIssue => ({
  code,
  severity: "error",
  description: integrityIssueDescriptionFor(code),
});

const addIssue = (issues: IntegrityIssue[], code: IntegrityIssueCode): void => {
  for (const issue of issues) {
    if (issue.code === code) return;
  }
  issues.push(createIntegrityIssue(code));
};

const parseJson = (json: string, parse: (value: unknown) => unknown): boolean => {
  try {
    parse(JSON.parse(json));
    return true;
  } catch {
    return false;
  }
};

const checkedAtReport = (
  level: IntegrityLevel,
  now: () => string,
  storeId: string | null,
  schemaVersion: number | null,
  issues: IntegrityIssue[],
): IntegrityReport => ({
  level,
  passed: issues.length === 0,
  checkedAt: now(),
  storeId,
  schemaVersion,
  issues,
});

type SchemaCheckResult = {
  readonly schemaVersion: number | null;
  readonly storeId: string | null;
};

const storeTimestampSchema = z.iso.datetime();

const isValidTimestamp = (value: string): boolean =>
  storeTimestampSchema.safeParse(value).success;

const normalizeSchemaSql = (sql: string): string =>
  sql
    .trim()
    .replace(/;+\s*$/, "")
    .replace(/"([a-z_][a-z0-9_]*)"/gi, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();

const hasCanonicalSchemaSql = (
  database: IntentArcDatabase,
  type: "table" | "trigger",
  name: string,
  expectedSql: string,
): boolean => {
  const row = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = ? AND name = ?
  `).get(type, name) as { sql: unknown } | undefined;
  return (
    typeof row?.sql === "string" &&
    normalizeSchemaSql(row.sql) === normalizeSchemaSql(expectedSql)
  );
};

const hasCanonicalRepositoryImportReceiptStructure = (
  database: IntentArcDatabase,
): boolean => {
  if (
    !hasCanonicalSchemaSql(
      database,
      "table",
      "repository_import_receipts",
      repositoryImportReceiptsTableSql,
    ) ||
    !hasCanonicalSchemaSql(
      database,
      "trigger",
      "repository_import_receipts_no_update",
      repositoryImportReceiptsNoUpdateTriggerSql,
    ) ||
    !hasCanonicalSchemaSql(
      database,
      "trigger",
      "repository_import_receipts_no_delete",
      repositoryImportReceiptsNoDeleteTriggerSql,
    )
  ) {
    return false;
  }

  const columns = database.pragma(
    "table_info(repository_import_receipts)",
  ) as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const expectedColumns = [
    ["manifest_digest", "TEXT", 1, 1],
    ["project_id", "TEXT", 1, 0],
    ["repository_fingerprint", "TEXT", 1, 0],
    ["scanner_version", "TEXT", 1, 0],
    ["ruleset_version", "TEXT", 1, 0],
    ["manifest_version", "INTEGER", 1, 0],
    ["record_count", "INTEGER", 1, 0],
    ["relationship_count", "INTEGER", 1, 0],
    ["initial_snapshot_digest", "TEXT", 1, 0],
    ["initial_snapshot_json", "TEXT", 1, 0],
    ["created_at", "TEXT", 1, 0],
  ] as const;
  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => {
      const expected = expectedColumns[index];
      return (
        expected === undefined ||
        column.cid !== index ||
        column.name !== expected[0] ||
        column.type.toUpperCase() !== expected[1] ||
        column.notnull !== expected[2] ||
        column.dflt_value !== null ||
        column.pk !== expected[3]
      );
    })
  ) {
    return false;
  }

  const indexes = database.pragma(
    "index_list(repository_import_receipts)",
  ) as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (
    indexes.length !== 2 ||
    indexes.some((index) =>
      index.unique !== 1 ||
      index.partial !== 0 ||
      (index.origin !== "pk" && index.origin !== "u")
    )
  ) {
    return false;
  }
  const indexedColumns = indexes.map((index) => {
    const indexColumns = database.pragma(
      `index_info(${JSON.stringify(index.name)})`,
    ) as { seqno: number; cid: number; name: string }[];
    return indexColumns.length === 1 && indexColumns[0]?.seqno === 0
      ? indexColumns[0].name
      : null;
  }).sort();
  if (
    indexedColumns.length !== 2 ||
    indexedColumns[0] !== "manifest_digest" ||
    indexedColumns[1] !== "project_id"
  ) {
    return false;
  }

  const foreignKeys = database.pragma(
    "foreign_key_list(repository_import_receipts)",
  ) as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  return (
    foreignKeys.length === 1 &&
    foreignKeys[0]?.seq === 0 &&
    foreignKeys[0].table === "projects" &&
    foreignKeys[0].from === "project_id" &&
    foreignKeys[0].to === "id" &&
    foreignKeys[0].on_update === "NO ACTION" &&
    foreignKeys[0].on_delete === "RESTRICT" &&
    foreignKeys[0].match === "NONE"
  );
};

const hasCanonicalClientProfileExecutionModeColumn = (
  database: IntentArcDatabase,
): boolean => {
  const row = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'client_profiles'
  `).get() as { sql: unknown } | undefined;
  return (
    typeof row?.sql === "string" &&
    normalizeSchemaSql(row.sql).includes(
      "execution_mode text not null default 'safe' check (execution_mode in ('safe','trusted','custom'))",
    )
  );
};

type StoredParentRelationship = {
  readonly project_id: string;
  readonly from_record_id: string;
  readonly to_record_id: string;
  readonly from_project_id: string;
  readonly to_project_id: string;
  readonly from_kind: string;
  readonly to_kind: string;
};

const checkHierarchySemanticState = (
  relationships: readonly StoredParentRelationship[],
  issues: IntegrityIssue[],
): void => {
  const parentsByChild = new Map<string, Set<string>>();
  const childrenByParent = new Map<string, string[]>();
  const nodes = new Set<string>();

  for (const relationship of relationships) {
    if (
      !isHierarchyRecordKind(relationship.from_kind) ||
      !isHierarchyRecordKind(relationship.to_kind)
    ) {
      addIssue(issues, "hierarchy_endpoint_invalid");
      continue;
    }
    if (
      relationship.project_id !== relationship.from_project_id ||
      relationship.project_id !== relationship.to_project_id
    ) {
      continue;
    }

    const parent = `${relationship.project_id}\0${relationship.from_record_id}`;
    const child = `${relationship.project_id}\0${relationship.to_record_id}`;
    nodes.add(parent);
    nodes.add(child);
    const parents = parentsByChild.get(child) ?? new Set<string>();
    parents.add(parent);
    parentsByChild.set(child, parents);
    if (parents.size > 1) addIssue(issues, "hierarchy_multiple_parents");
    const children = childrenByParent.get(parent) ?? [];
    children.push(child);
    childrenByParent.set(parent, children);
  }

  for (const children of childrenByParent.values()) children.sort();
  const visited = new Set<string>();
  const active = new Set<string>();
  for (const start of [...nodes].sort()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; nextChild: number }> = [{
      id: start,
      nextChild: 0,
    }];
    active.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = childrenByParent.get(frame.id) ?? [];
      if (frame.nextChild >= children.length) {
        active.delete(frame.id);
        visited.add(frame.id);
        stack.pop();
        continue;
      }
      const child = children[frame.nextChild]!;
      frame.nextChild += 1;
      if (active.has(child)) {
        addIssue(issues, "hierarchy_cycle");
        return;
      }
      if (!visited.has(child)) {
        active.add(child);
        stack.push({ id: child, nextChild: 0 });
      }
    }
  }
};

const hasCanonicalHierarchyVocabularyStructure = (
  database: IntentArcDatabase,
): boolean => {
  const canonicalVocabularyJson = JSON.stringify(neutralHierarchyVocabulary);
  const columns = database.pragma("table_info(projects)") as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const expectedColumns = [
    ["id", "TEXT", 0, null, 1],
    ["name", "TEXT", 1, null, 0],
    ["revision", "INTEGER", 1, null, 0],
    ["primary_repository_path", "TEXT", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0],
    ["updated_at", "TEXT", 1, null, 0],
    [
      "hierarchy_vocabulary_json",
      "TEXT",
      1,
      `'${canonicalVocabularyJson}'`,
      0,
    ],
  ] as const;
  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => {
      const expected = expectedColumns[index];
      return expected === undefined ||
        column.cid !== index ||
        column.name !== expected[0] ||
        column.type.toUpperCase() !== expected[1] ||
        column.notnull !== expected[2] ||
        column.dflt_value !== expected[3] ||
        column.pk !== expected[4];
    })
  ) {
    return false;
  }

  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'
  `).get() as { sql: unknown } | undefined;
  const normalizeProjectSql = (sql: string): string =>
    sql.trim()
      .replace(/;+\s*$/, "")
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .toLowerCase();
  return typeof row?.sql === "string" && normalizeProjectSql(row.sql).includes(
    normalizeProjectSql(
      `hierarchy_vocabulary_json text not null default '${canonicalVocabularyJson}' check (json_valid(hierarchy_vocabulary_json) and json_type(hierarchy_vocabulary_json) = 'object')`,
    ),
  );
};

const hasCompositeForeignKey = (
  database: IntentArcDatabase,
  table: string,
  parentTable: string,
  columns: readonly (readonly [string, string])[],
): boolean => {
  const rows = database.pragma(`foreign_key_list(${table})`) as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
  }[];
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return [...groups.values()].some((group) => {
    const ordered = [...group].sort((left, right) => left.seq - right.seq);
    return ordered.length === columns.length &&
      ordered.every((row, index) =>
        row.table === parentTable &&
        row.from === columns[index]?.[0] &&
        row.to === columns[index]?.[1]
      );
  });
};

const hasCanonicalRepositoryIndexStructure = (
  database: IntentArcDatabase,
): boolean => {
  const tableSql = (name: string): string | null => {
    const row = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name) as { sql: unknown } | undefined;
    return typeof row?.sql === "string" ? normalizeSchemaSql(row.sql) : null;
  };
  const snapshotsSql = tableSql("repository_snapshots");
  const linksSql = tableSql("repository_links");
  const reviewsSql = tableSql("repository_refresh_reviews");
  if (
    snapshotsSql === null ||
    linksSql === null ||
    reviewsSql === null ||
    !snapshotsSql.includes("json_valid(warning_counts_json)") ||
    !snapshotsSql.includes("json_valid(exclusion_counts_json)") ||
    !snapshotsSql.includes("json_valid(finding_counts_json)") ||
    !linksSql.includes(
      "check ((to_record_id is null) <> (to_node_id is null))",
    ) ||
    !reviewsSql.includes("json_valid(selected_operation_ids_json)") ||
    !reviewsSql.includes("check ((state = 'pending') = (decided_at is null))")
  ) {
    return false;
  }

  const observationIndexes = database.pragma(
    "index_list(repository_node_observations)",
  ) as { name: string; unique: number; partial: number }[];
  const pathIndex = observationIndexes.find(
    ({ name }) => name === "idx_repository_node_observations_snapshot_path",
  );
  const reviewIndexes = database.pragma(
    "index_list(repository_refresh_reviews)",
  ) as { name: string; unique: number; partial: number }[];
  const pendingIndex = reviewIndexes.find(
    ({ name }) => name === "idx_repository_refresh_reviews_pending_source",
  );
  const indexColumns = (name: string): string[] =>
    (database.pragma(`index_info(${JSON.stringify(name)})`) as {
      seqno: number;
      name: string;
    }[])
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name: column }) => column);
  const pendingIndexSql = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get("idx_repository_refresh_reviews_pending_source") as {
    sql: unknown;
  } | undefined;

  return pathIndex?.unique === 1 && pathIndex.partial === 0 &&
    indexColumns(pathIndex.name).join("\0") === "snapshot_id\0path" &&
    pendingIndex?.unique === 1 && pendingIndex.partial === 1 &&
    indexColumns(pendingIndex.name).join("\0") === "source_id" &&
    typeof pendingIndexSql?.sql === "string" &&
    normalizeSchemaSql(pendingIndexSql.sql) === normalizeSchemaSql(`
      CREATE UNIQUE INDEX idx_repository_refresh_reviews_pending_source
        ON repository_refresh_reviews(source_id) WHERE state = 'pending'
    `) &&
    hasCompositeForeignKey(
      database,
      "repository_sources",
      "repository_snapshots",
      [["current_snapshot_id", "id"], ["id", "source_id"]],
    ) &&
    hasCompositeForeignKey(
      database,
      "repository_links",
      "project_records",
      [["to_record_id", "id"], ["project_id", "project_id"]],
    ) &&
    hasCompositeForeignKey(
      database,
      "repository_links",
      "repository_node_observations",
      [["snapshot_id", "snapshot_id"], ["to_node_id", "node_id"]],
    );
};

const hasCanonicalProposalStructure = (
  database: IntentArcDatabase,
): boolean => {
  if (
    !hasCanonicalSchemaSql(
      database,
      "table",
      "change_proposals",
      changeProposalsTableSql,
    ) ||
    !hasCanonicalSchemaSql(
      database,
      "table",
      "proposal_operations",
      proposalOperationsTableSql,
    )
  ) {
    return false;
  }

  type ExpectedColumn = readonly [
    name: string,
    type: string,
    notNull: number,
    primaryKey: number,
  ];
  const hasExactColumns = (
    table: string,
    expectedColumns: readonly ExpectedColumn[],
  ): boolean => {
    const columns = database.pragma(`table_info(${table})`) as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];
    return columns.length === expectedColumns.length &&
      columns.every((column, index) => {
        const expected = expectedColumns[index];
        return expected !== undefined &&
          column.cid === index &&
          column.name === expected[0] &&
          column.type.toUpperCase() === expected[1] &&
          column.notnull === expected[2] &&
          column.dflt_value === null &&
          column.pk === expected[3];
      });
  };
  const expectedProposalColumns = [
    ["id", "TEXT", 0, 1],
    ["project_id", "TEXT", 1, 0],
    ["profile_id", "TEXT", 0, 0],
    ["source_task_id", "TEXT", 0, 0],
    ["predecessor_proposal_id", "TEXT", 0, 0],
    ["base_project_revision", "INTEGER", 1, 0],
    ["state", "TEXT", 1, 0],
    ["rationale", "TEXT", 1, 0],
    ["idempotency_key", "TEXT", 0, 0],
    ["request_hash", "TEXT", 0, 0],
    ["review_reason", "TEXT", 0, 0],
    ["reviewer_actor", "TEXT", 0, 0],
    ["created_at", "TEXT", 1, 0],
    ["updated_at", "TEXT", 1, 0],
    ["reviewed_at", "TEXT", 0, 0],
    ["origin_type", "TEXT", 1, 0],
    ["repository_snapshot_id", "TEXT", 0, 0],
  ] as const;
  const expectedOperationColumns = [
    ["proposal_id", "TEXT", 1, 1],
    ["position", "INTEGER", 1, 2],
    ["operation_id", "TEXT", 1, 0],
    ["operation_type", "TEXT", 1, 0],
    ["expected_record_revision", "INTEGER", 0, 0],
    ["payload_json", "TEXT", 1, 0],
  ] as const;
  if (
    !hasExactColumns("change_proposals", expectedProposalColumns) ||
    !hasExactColumns("proposal_operations", expectedOperationColumns)
  ) {
    return false;
  }

  type ExpectedForeignKey = readonly [
    parentTable: string,
    from: readonly string[],
    to: readonly string[],
    onDelete: string,
  ];
  const hasExactForeignKeys = (
    table: string,
    expected: readonly ExpectedForeignKey[],
  ): boolean => {
    const rows = database.pragma(`foreign_key_list(${table})`) as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }[];
    const grouped = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.id) ?? [];
      group.push(row);
      grouped.set(row.id, group);
    }
    const actual = [...grouped.values()].map((group) => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      return JSON.stringify([
        ordered[0]?.table,
        ordered.map(({ from }) => from),
        ordered.map(({ to }) => to),
        ordered[0]?.on_delete,
        ordered.every(({ on_update }) => on_update === "NO ACTION"),
        ordered.every(({ match }) => match === "NONE"),
      ]);
    }).sort();
    const canonical = expected.map(([parent, from, to, onDelete]) =>
      JSON.stringify([parent, from, to, onDelete, true, true])
    ).sort();
    return actual.length === canonical.length &&
      actual.every((value, index) => value === canonical[index]);
  };
  if (
    !hasExactForeignKeys("change_proposals", [
      ["projects", ["project_id"], ["id"], "CASCADE"],
      ["client_profiles", ["profile_id"], ["id"], "NO ACTION"],
      ["change_proposals", ["predecessor_proposal_id"], ["id"], "NO ACTION"],
      [
        "repository_snapshots",
        ["repository_snapshot_id", "project_id"],
        ["id", "project_id"],
        "RESTRICT",
      ],
    ]) ||
    !hasExactForeignKeys("proposal_operations", [
      ["change_proposals", ["proposal_id"], ["id"], "CASCADE"],
    ])
  ) {
    return false;
  }

  const exactIndex = (name: string, expectedSql: string): boolean => {
    const row = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get(name) as { sql: unknown } | undefined;
    return typeof row?.sql === "string" &&
      normalizeSchemaSql(row.sql) === normalizeSchemaSql(expectedSql);
  };

  return exactIndex(
    "idx_change_proposals_project_state_created_at",
    changeProposalsProjectStateIndexSql,
  ) && exactIndex(
    "idx_change_proposals_profile_idempotency",
    changeProposalsProfileIdempotencyIndexSql,
  ) && exactIndex(
    "idx_change_proposals_repository_snapshot",
    changeProposalsRepositorySnapshotIndexSql,
  ) && hasCanonicalSchemaSql(
    database,
    "trigger",
    "proposal_operations_no_update",
    proposalOperationsNoUpdateTriggerSql,
  ) && hasCanonicalSchemaSql(
    database,
    "trigger",
    "proposal_operations_no_delete",
    proposalOperationsNoDeleteTriggerSql,
  );
};

const hasCanonicalCoordinationStructure = (
  database: IntentArcDatabase,
): boolean => {
  const tables = [
    ["task_claims", taskClaimsTableSql],
    ["task_checkpoints", taskCheckpointsTableSql],
    ["task_delegations", taskDelegationsTableSql],
    ["task_submissions", taskSubmissionsTableSql],
    ["coordination_events", coordinationEventsTableSql],
    ["coordination_idempotency", coordinationIdempotencyTableSql],
  ] as const;
  const triggers = [
    ["task_checkpoints_no_update", taskCheckpointsNoUpdateTriggerSql],
    ["task_checkpoints_no_delete", taskCheckpointsNoDeleteTriggerSql],
    ["task_submissions_immutable_fields", taskSubmissionsImmutableFieldsTriggerSql],
    ["task_submissions_no_delete", taskSubmissionsNoDeleteTriggerSql],
    ["coordination_events_no_update", coordinationEventsNoUpdateTriggerSql],
    ["coordination_events_no_delete", coordinationEventsNoDeleteTriggerSql],
    ["coordination_proposal_state_sync", coordinationProposalStateSyncTriggerSql],
  ] as const;
  const indexes = [
    ["idx_task_claims_one_active", taskClaimsOneActiveIndexSql],
    ["idx_task_claims_one_submitted", taskClaimsOneSubmittedIndexSql],
    ["idx_task_delegations_one_live", taskDelegationsOneLiveIndexSql],
  ] as const;

  if (!tables.every(([name, sql]) =>
    hasCanonicalSchemaSql(database, "table", name, sql)
  ) || !triggers.every(([name, sql]) =>
    hasCanonicalSchemaSql(database, "trigger", name, sql)
  )) {
    return false;
  }

  return indexes.every(([name, expectedSql]) => {
    const row = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get(name) as { sql: unknown } | undefined;
    return typeof row?.sql === "string" &&
      normalizeSchemaSql(row.sql) === normalizeSchemaSql(expectedSql);
  });
};

const checkSchema = (
  database: IntentArcDatabase,
  issues: IntegrityIssue[],
): SchemaCheckResult => {
  let schemaVersion: number;
  try {
    schemaVersion = database.pragma("user_version", { simple: true }) as number;
  } catch {
    addIssue(issues, "database_unreadable");
    return { schemaVersion: null, storeId: null };
  }

  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    addIssue(issues, "schema_version_invalid");
    return { schemaVersion: null, storeId: null };
  }

  const objectCount = database
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master")
    .get() as { count: number };
  if (schemaVersion === 0) {
    if (objectCount.count > 0) addIssue(issues, "schema_version_invalid");
    return { schemaVersion, storeId: null };
  }

  if (schemaVersion > migrations.at(-1)!.version) {
    addIssue(issues, "unsupported_schema");
    return { schemaVersion, storeId: null };
  }

  const required = schemaObjectsFor(schemaVersion);
  const findObject = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
  );
  for (const [type, name] of required) {
    if (!findObject.get(type, name)) addIssue(issues, "schema_object_missing");
  }
  if (schemaVersion >= 5) {
    try {
      if (!hasCanonicalRepositoryImportReceiptStructure(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 6) {
    try {
      if (!hasCanonicalClientProfileExecutionModeColumn(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 7) {
    try {
      if (!hasCanonicalRepositoryIndexStructure(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 8) {
    try {
      if (!hasCanonicalProposalStructure(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 9) {
    try {
      if (!hasCanonicalSchemaSql(
        database,
        "table",
        "human_change_idempotency_results",
        humanChangeIdempotencyResultsTableSql,
      )) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 10) {
    try {
      if (!hasCanonicalCoordinationStructure(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }
  if (schemaVersion >= 11) {
    try {
      if (!hasCanonicalHierarchyVocabularyStructure(database)) {
        addIssue(issues, "schema_object_missing");
      }
    } catch {
      addIssue(issues, "schema_object_missing");
    }
  }

  let storeId: string | null = null;
  if (schemaVersion >= 3) {
    try {
      const rows = database.prepare(`
        SELECT singleton, store_id, created_at
        FROM store_metadata
        ORDER BY singleton
      `).all() as {
        singleton: number;
        store_id: string;
        created_at: string;
      }[];
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        row.singleton !== 1 ||
        typeof row.store_id !== "string" ||
        row.store_id.trim().length === 0 ||
        typeof row.created_at !== "string" ||
        !isValidTimestamp(row.created_at)
      ) {
        addIssue(issues, "store_metadata_invalid");
      } else {
        storeId = row.store_id;
      }
    } catch {
      addIssue(issues, "store_metadata_invalid");
    }
  }

  return { schemaVersion, storeId };
};

type OutboundDestinationRow = {
  destination_id: string;
  revision: number;
  profile_id: string;
  client_label: string;
  destination_type: OutboundDestinationSnapshot["type"];
  provider_label: string;
  model_label: string | null;
  account_boundary_label: string | null;
  data_boundary: OutboundDestinationSnapshot["dataBoundary"];
  status: OutboundDestination["status"];
  is_current: number;
  created_at: string;
  updated_at: string;
};

const destinationForRow = (
  row: OutboundDestinationRow,
): OutboundDestination => outboundDestinationSchema.parse({
  id: row.destination_id,
  profileId: row.profile_id,
  revision: row.revision,
  clientLabel: row.client_label,
  type: row.destination_type,
  providerLabel: row.provider_label,
  modelLabel: row.model_label,
  accountBoundaryLabel: row.account_boundary_label,
  dataBoundary: row.data_boundary,
  status: row.status,
  current: row.is_current === 1
    ? true
    : row.is_current === 0
    ? false
    : row.is_current,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const snapshotForDestination = (
  destination: OutboundDestination,
): OutboundDestinationSnapshot => outboundDestinationSnapshotSchema.parse({
  id: destination.id,
  revision: destination.revision,
  clientLabel: destination.clientLabel,
  type: destination.type,
  providerLabel: destination.providerLabel,
  modelLabel: destination.modelLabel,
  accountBoundaryLabel: destination.accountBoundaryLabel,
  dataBoundary: destination.dataBoundary,
});

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const countsForFindings = (
  findings: readonly OutboundFinding[],
): OutboundFindingCounts => ({
  total: findings.length,
  credential: findings.filter(({ severity }) => severity === "credential").length,
  sensitive: findings.filter(({ severity }) => severity === "sensitive").length,
  forcedRedact: findings.filter(
    ({ requiredAction }) => requiredAction === "forced_redact",
  ).length,
  redactByDefault: findings.filter(
    ({ requiredAction }) => requiredAction === "redact_by_default",
  ).length,
  redacted: findings.filter(({ decision }) => decision !== "include_once").length,
  includedOnce: findings.filter(
    ({ decision }) => decision === "include_once",
  ).length,
});

const outboundIdentifierSchema = z.string().trim().min(1).max(200);
const outboundSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const integrityPolicySchema = z.object({
  profileId: outboundIdentifierSchema,
  projectId: outboundIdentifierSchema,
  destinationId: outboundIdentifierSchema,
  destinationRevision: z.number().int().positive(),
  detectorVersion: outboundIdentifierSchema,
  safetyPolicyVersion: outboundIdentifierSchema,
  mode: z.enum(["manual", "auto_release_clean"]),
  createdAt: storeTimestampSchema,
  updatedAt: storeTimestampSchema,
}).strict();

const integrityRequestSchema = z.object({
  id: outboundIdentifierSchema,
  profileId: outboundIdentifierSchema,
  projectId: outboundIdentifierSchema,
  taskId: outboundIdentifierSchema,
  sourcePackId: outboundIdentifierSchema,
  idempotencyKey: outboundIdentifierSchema.max(128),
  requestHash: outboundSha256Schema,
  destinationId: outboundIdentifierSchema,
  destinationRevision: z.number().int().positive(),
  detectorVersion: outboundIdentifierSchema,
  safetyPolicyVersion: outboundIdentifierSchema,
  candidateDigest: outboundSha256Schema,
  status: z.enum(["review_required", "released", "denied"]),
  decisionActor: outboundIdentifierSchema.nullable(),
  decisionReason: outboundIdentifierSchema.nullable(),
  releaseId: outboundIdentifierSchema.nullable(),
  createdAt: storeTimestampSchema,
  decidedAt: storeTimestampSchema.nullable(),
}).strict();

const integrityAuditSchema = z.object({
  id: outboundIdentifierSchema,
  projectId: outboundIdentifierSchema.nullable(),
  actorType: z.enum(["profile", "local_human"]),
  profileId: outboundIdentifierSchema.nullable(),
  authorityMode: outboundIdentifierSchema.nullable(),
  scopeDecision: outboundIdentifierSchema,
  actionCategory: outboundIdentifierSchema,
  targetId: outboundIdentifierSchema.nullable(),
  idempotencyKey: z.string().nullable(),
  revisionBefore: z.number().int().nullable(),
  revisionAfter: z.number().int().nullable(),
  outcome: outboundIdentifierSchema,
  reason: z.string().trim().min(1).max(500),
  createdAt: storeTimestampSchema,
}).strict();

type IntegrityPolicy = z.infer<typeof integrityPolicySchema>;
type IntegrityRequest = z.infer<typeof integrityRequestSchema>;
type IntegrityAudit = z.infer<typeof integrityAuditSchema>;

type ContextPackRow = {
  id: string;
  project_id: string;
  task_id: string;
  project_revision: number;
  budget_tokens: number;
  estimated_tokens: number;
  content_json: string;
  created_at: string;
};

type OutboundRequestRow = {
  id: string;
  profile_id: string;
  project_id: string;
  task_id: string;
  source_pack_id: string;
  idempotency_key: string;
  request_hash: string;
  destination_id: string;
  destination_revision: number;
  destination_snapshot_json: string;
  detector_version: string;
  safety_policy_version: string;
  candidate_digest: string;
  status: IntegrityRequest["status"];
  finding_counts_json: string;
  decision_actor: string | null;
  decision_reason: string | null;
  release_id: string | null;
  created_at: string;
  decided_at: string | null;
};

type OutboundFindingRow = {
  id: string;
  request_id: string;
  ordinal: number;
  detector_id: string;
  detector_version: string;
  category: OutboundFinding["category"];
  confidence: OutboundFinding["confidence"];
  severity: OutboundFinding["severity"];
  field_path: string;
  start_offset: number;
  end_offset: number;
  finding_key: string;
  required_action: OutboundFinding["requiredAction"];
  decision: OutboundFinding["decision"];
};

type OutboundReleaseRow = {
  id: string;
  request_id: string;
  source_pack_id: string;
  content_json: string;
  disclosure_json: string;
  sha256: string;
  released_at: string;
};

type RequestIntegrityState = {
  request: IntegrityRequest;
  snapshot: OutboundDestinationSnapshot | undefined;
  counts: OutboundFindingCounts | undefined;
  pack: TaskContextPack | undefined;
  scan: ReturnType<ReturnType<typeof createOutboundSafetyEngine>["scan"]> |
    undefined;
};

const scanAuditReason = (
  counts: OutboundFindingCounts,
  request: IntegrityRequest,
): string =>
  `scan_completed:total:${counts.total};` +
  `credential:${counts.credential};` +
  `sensitive:${counts.sensitive};` +
  `forced_redact:${counts.forcedRedact};` +
  `redact_by_default:${counts.redactByDefault};` +
  `detector_version:${request.detectorVersion};` +
  `safety_policy_version:${request.safetyPolicyVersion};` +
  `destination_revision:${request.destinationRevision}`;

const policyAuditReason = (
  detectorVersion: string,
  safetyPolicyVersion: string,
  destinationRevision: number,
): string =>
  `policy_enabled:detector_version:${detectorVersion};` +
  `safety_policy_version:${safetyPolicyVersion};` +
  `destination_revision:${destinationRevision}`;

const checkOutboundSemanticState = (
  database: IntentArcDatabase,
  issues: IntegrityIssue[],
): void => {
  let invalid = false;
  const markInvalid = (): void => {
    invalid = true;
  };
  const safetyEngine = createOutboundSafetyEngine();

  try {
    const destinationRows = database.prepare(`
      SELECT
        destination_id, revision, profile_id, client_label,
        destination_type, provider_label, model_label,
        account_boundary_label, data_boundary, status, is_current,
        created_at, updated_at
      FROM outbound_destinations
      ORDER BY profile_id, revision, destination_id
    `).all() as OutboundDestinationRow[];
    const destinationsByKey = new Map<string, OutboundDestination>();
    const destinationRowsByProfile = new Map<string, OutboundDestinationRow[]>();
    const destinationProfilesById = new Map<string, Set<string>>();
    for (const row of destinationRows) {
      const profileRows = destinationRowsByProfile.get(row.profile_id) ?? [];
      profileRows.push(row);
      destinationRowsByProfile.set(row.profile_id, profileRows);
      const identityProfiles = destinationProfilesById.get(row.destination_id) ??
        new Set<string>();
      identityProfiles.add(row.profile_id);
      destinationProfilesById.set(row.destination_id, identityProfiles);
      try {
        const destination = destinationForRow(row);
        destinationsByKey.set(
          `${destination.id}\u0000${destination.revision}`,
          destination,
        );
        if (
          Date.parse(destination.updatedAt) < Date.parse(destination.createdAt)
        ) {
          markInvalid();
        }
      } catch {
        markInvalid();
      }
    }
    for (const rows of destinationRowsByProfile.values()) {
      const ordered = [...rows].sort((left, right) =>
        left.revision - right.revision
      );
      const current = ordered.filter(({ is_current }) => is_current === 1);
      if (
        new Set(ordered.map(({ destination_id }) => destination_id)).size !== 1 ||
        current.length !== 1 ||
        current[0]?.revision !== ordered.at(-1)?.revision
      ) {
        markInvalid();
      }
      for (let index = 0; index < ordered.length; index += 1) {
        if (ordered[index]?.revision !== index + 1) markInvalid();
      }
    }
    for (const profiles of destinationProfilesById.values()) {
      if (profiles.size !== 1) markInvalid();
    }

    const projectIds = new Set(
      (database.prepare("SELECT id FROM projects ORDER BY id").all() as {
        id: string;
      }[]).map(({ id }) => id),
    );
    const taskRows = database.prepare(`
      SELECT id, project_id, kind
      FROM project_records
      ORDER BY id
    `).all() as {
      id: string;
      project_id: string;
      kind: string;
    }[];
    const tasksById = new Map(taskRows.map((row) => [row.id, row] as const));
    const revisionSnapshotRows = database.prepare(`
      SELECT record_id, revision, snapshot_json
      FROM project_record_revisions
      ORDER BY record_id, revision
    `).all() as {
      record_id: string;
      revision: number;
      snapshot_json: string;
    }[];
    const revisionSnapshotsByKey = new Map(
      revisionSnapshotRows.map((row) => [
        `${row.record_id}\u0000${row.revision}`,
        row.snapshot_json,
      ] as const),
    );

    const packRows = database.prepare(`
      SELECT
        id, project_id, task_id, project_revision, budget_tokens,
        estimated_tokens, content_json, created_at
      FROM context_packs
      ORDER BY id
    `).all() as ContextPackRow[];
    const packsById = new Map<string, TaskContextPack>();
    const packIdsWithoutHierarchyVocabulary = new Set<string>();
    for (const row of packRows) {
      try {
        const storedPack: unknown = JSON.parse(row.content_json);
        const hierarchyVocabularyPresent = storedPack !== null &&
          typeof storedPack === "object" &&
          Object.hasOwn(storedPack, "hierarchyVocabulary");
        if (!hierarchyVocabularyPresent) {
          packIdsWithoutHierarchyVocabulary.add(row.id);
        }
        let packValue: TaskContextPack = taskContextPackSchema.parse(
          storedPack,
        );
        if (!hierarchyVocabularyPresent) {
          const {
            hierarchyVocabulary: _legacyMissingVocabulary,
            ...legacyPack
          } = packValue;
          packValue = legacyPack;
        }
        packsById.set(row.id, packValue);
        if (
          packValue.id !== row.id ||
          packValue.projectId !== row.project_id ||
          packValue.taskId !== row.task_id ||
          packValue.projectRevision !== row.project_revision ||
          packValue.budgetTokens !== row.budget_tokens ||
          packValue.estimatedTokens !== row.estimated_tokens ||
          packValue.generatedAt !== row.created_at
        ) {
          markInvalid();
        }
        const includedItems = [
          ...packValue.stableFrame,
          packValue.task,
          ...packValue.related,
        ];
        const includedRecordIds = includedItems.map(({ record }) => record.id);
        const expectedSourceRevisions = includedItems
          .map(({ record }) => ({
            recordId: record.id,
            revision: record.revision,
          }))
          .sort((left, right) =>
            left.recordId < right.recordId
              ? -1
              : left.recordId > right.recordId
                ? 1
                : 0
          );
        const task = tasksById.get(packValue.taskId);
        if (
          task?.project_id !== packValue.projectId ||
          task.kind !== "task" ||
          packValue.task.record.id !== packValue.taskId ||
          packValue.task.record.kind !== "task" ||
          packValue.task.mandatory !== true ||
          packValue.task.relevance !== "active_task" ||
          packValue.task.relationshipKind !== null ||
          packValue.stableFrame.some((item) =>
            item.mandatory !== true ||
            item.relevance !== "stable_frame" ||
            item.relationshipKind !== null
          ) ||
          packValue.related.some((item) =>
            item.mandatory !== false ||
            item.relevance !== "linked" ||
            item.relationshipKind === null
          ) ||
          new Set(includedRecordIds).size !== includedRecordIds.length ||
          !equalJson(packValue.sourceRevisions, expectedSourceRevisions)
        ) {
          markInvalid();
        }
        for (const item of includedItems) {
          const rawSnapshot = revisionSnapshotsByKey.get(
            `${item.record.id}\u0000${item.record.revision}`,
          );
          try {
            const snapshot = projectRecordSchema.parse(
              JSON.parse(rawSnapshot ?? ""),
            );
            if (
              item.record.projectId !== packValue.projectId ||
              !equalJson(item.record, snapshot)
            ) {
              markInvalid();
            }
          } catch {
            markInvalid();
          }
        }
      } catch {
        markInvalid();
      }
    }

    const policyRows = database.prepare(`
      SELECT
        profile_id, project_id, destination_id, destination_revision,
        detector_version, safety_policy_version, mode, created_at, updated_at
      FROM outbound_policies
      ORDER BY profile_id, project_id, destination_id, destination_revision,
        detector_version, safety_policy_version
    `).all() as {
      profile_id: string;
      project_id: string;
      destination_id: string;
      destination_revision: number;
      detector_version: string;
      safety_policy_version: string;
      mode: IntegrityPolicy["mode"];
      created_at: string;
      updated_at: string;
    }[];
    const policies: IntegrityPolicy[] = [];
    for (const row of policyRows) {
      try {
        const policy = integrityPolicySchema.parse({
          profileId: row.profile_id,
          projectId: row.project_id,
          destinationId: row.destination_id,
          destinationRevision: row.destination_revision,
          detectorVersion: row.detector_version,
          safetyPolicyVersion: row.safety_policy_version,
          mode: row.mode,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        policies.push(policy);
        const destination = destinationsByKey.get(
          `${policy.destinationId}\u0000${policy.destinationRevision}`,
        );
        if (
          !projectIds.has(policy.projectId) ||
          destination?.profileId !== policy.profileId ||
          destination.current !== true ||
          destination.status !== "enabled" ||
          policy.detectorVersion !== OUTBOUND_DETECTOR_VERSION ||
          policy.safetyPolicyVersion !== OUTBOUND_SAFETY_POLICY_VERSION ||
          Date.parse(policy.updatedAt) < Date.parse(policy.createdAt)
        ) {
          markInvalid();
        }
      } catch {
        markInvalid();
      }
    }

    const requestRows = database.prepare(`
      SELECT
        id, profile_id, project_id, task_id, source_pack_id,
        idempotency_key, request_hash, destination_id,
        destination_revision, destination_snapshot_json, detector_version,
        safety_policy_version, candidate_digest, status,
        finding_counts_json, decision_actor, decision_reason, release_id,
        created_at, decided_at
      FROM outbound_requests
      ORDER BY id
    `).all() as OutboundRequestRow[];
    const requestStates = new Map<string, RequestIntegrityState>();
    for (const row of requestRows) {
      let request: IntegrityRequest | undefined;
      try {
        request = integrityRequestSchema.parse({
          id: row.id,
          profileId: row.profile_id,
          projectId: row.project_id,
          taskId: row.task_id,
          sourcePackId: row.source_pack_id,
          idempotencyKey: row.idempotency_key,
          requestHash: row.request_hash,
          destinationId: row.destination_id,
          destinationRevision: row.destination_revision,
          detectorVersion: row.detector_version,
          safetyPolicyVersion: row.safety_policy_version,
          candidateDigest: row.candidate_digest,
          status: row.status,
          decisionActor: row.decision_actor,
          decisionReason: row.decision_reason,
          releaseId: row.release_id,
          createdAt: row.created_at,
          decidedAt: row.decided_at,
        });
      } catch {
        markInvalid();
      }

      let snapshot: OutboundDestinationSnapshot | undefined;
      try {
        snapshot = outboundDestinationSnapshotSchema.parse(
          JSON.parse(row.destination_snapshot_json),
        );
      } catch {
        markInvalid();
      }

      let counts: OutboundFindingCounts | undefined;
      try {
        counts = outboundFindingCountsSchema.parse(
          JSON.parse(row.finding_counts_json),
        );
      } catch {
        markInvalid();
      }

      if (request === undefined) continue;
      const state: RequestIntegrityState = {
        request,
        snapshot,
        counts,
        pack: undefined,
        scan: undefined,
      };
      requestStates.set(request.id, state);
      const task = tasksById.get(request.taskId);
      const packValue = packsById.get(request.sourcePackId);
      const destination = destinationsByKey.get(
        `${request.destinationId}\u0000${request.destinationRevision}`,
      );
      if (
        task?.project_id !== request.projectId ||
        task.kind !== "task" ||
        packValue?.projectId !== request.projectId ||
        packValue?.taskId !== request.taskId ||
        packValue.id !== request.sourcePackId ||
        destination?.profileId !== request.profileId ||
        snapshot === undefined ||
        destination === undefined ||
        !equalJson(snapshot, snapshotForDestination(destination)) ||
        request.detectorVersion !== OUTBOUND_DETECTOR_VERSION ||
        request.safetyPolicyVersion !== OUTBOUND_SAFETY_POLICY_VERSION
      ) {
        markInvalid();
      }
      if (packValue !== undefined) {
        state.pack = packValue;
        if (
          request.requestHash !== computeOutboundRequestHash({
            projectId: request.projectId,
            taskId: request.taskId,
            budgetTokens: packValue.budgetTokens,
            destinationId: request.destinationId,
            destinationRevision: request.destinationRevision,
            detectorVersion: request.detectorVersion,
            safetyPolicyVersion: request.safetyPolicyVersion,
          })
        ) {
          markInvalid();
        }
      }
      if (packValue !== undefined && snapshot !== undefined) {
        try {
          const scan = safetyEngine.scanStoredPack(packValue, snapshot, {
            hierarchyVocabularyPresent:
              !packIdsWithoutHierarchyVocabulary.has(request.sourcePackId),
          });
          state.scan = scan;
          if (scan.candidateDigest !== request.candidateDigest) markInvalid();
        } catch {
          markInvalid();
        }
      }

      const terminal = request.status !== "review_required";
      if (
        (
          request.status === "review_required" &&
          (
            request.decisionActor !== null ||
            request.decisionReason !== null ||
            request.releaseId !== null ||
            request.decidedAt !== null
          )
        ) ||
        (
          request.status === "denied" &&
          (
            request.decisionActor !== "local_human" ||
            request.decisionReason !== "denied" ||
            request.releaseId !== null ||
            request.decidedAt === null
          )
        ) ||
        (
          request.status === "released" &&
          (
            request.releaseId === null ||
            request.decidedAt === null ||
            !(
              (
                request.decisionActor === "local_human" &&
                request.decisionReason === "approved"
              ) ||
              (
                request.decisionActor === "policy" &&
                request.decisionReason === "auto_release_clean"
              )
            )
          )
        ) ||
        (
          terminal &&
          request.decidedAt !== null &&
          Date.parse(request.decidedAt) < Date.parse(request.createdAt)
        )
      ) {
        markInvalid();
      }
    }

    const findingRows = database.prepare(`
      SELECT
        id, request_id, ordinal, detector_id, detector_version, category,
        confidence, severity, field_path, start_offset, end_offset,
        finding_key, required_action, decision
      FROM outbound_findings
      ORDER BY request_id, ordinal, id
    `).all() as OutboundFindingRow[];
    const findingsByRequest = new Map<string, OutboundFinding[]>();
    for (const row of findingRows) {
      try {
        outboundIdentifierSchema.parse(row.request_id);
        const finding = outboundFindingSchema.parse({
          id: row.id,
          ordinal: row.ordinal,
          detectorId: row.detector_id,
          detectorVersion: row.detector_version,
          category: row.category,
          confidence: row.confidence,
          severity: row.severity,
          path: row.field_path,
          start: row.start_offset,
          end: row.end_offset,
          findingKey: row.finding_key,
          requiredAction: row.required_action,
          decision: row.decision,
        });
        const findings = findingsByRequest.get(row.request_id) ?? [];
        findings.push(finding);
        findingsByRequest.set(row.request_id, findings);
        if (!requestStates.has(row.request_id)) markInvalid();
      } catch {
        markInvalid();
      }
    }
    for (const state of requestStates.values()) {
      const findings = findingsByRequest.get(state.request.id) ?? [];
      const undecidedFindings = findings.map((finding) => ({
        ...finding,
        decision: null,
      }));
      if (
        state.scan !== undefined &&
        !equalJson(undecidedFindings, state.scan.findings)
      ) {
        markInvalid();
      }
      if (
        state.counts !== undefined &&
        !equalJson(state.counts, countsForFindings(findings))
      ) {
        markInvalid();
      }
      if (
        (
          state.request.status === "released" &&
          findings.some(({ decision }) => decision === null)
        ) ||
        (
          state.request.status !== "released" &&
          findings.some(({ decision }) => decision !== null)
        ) ||
        (
          state.request.decisionActor === "policy" &&
          findings.length !== 0
        )
      ) {
        markInvalid();
      }
    }

    const releaseRows = database.prepare(`
      SELECT
        id, request_id, source_pack_id, content_json, disclosure_json,
        sha256, released_at
      FROM outbound_releases
      ORDER BY id
    `).all() as OutboundReleaseRow[];
    const releaseRowsByRequest = new Map<string, OutboundReleaseRow[]>();
    const parsedReleasesById = new Map<string, OutboundRelease>();
    for (const row of releaseRows) {
      const related = releaseRowsByRequest.get(row.request_id) ?? [];
      related.push(row);
      releaseRowsByRequest.set(row.request_id, related);
      let contentValue: unknown;
      let disclosureValue: unknown;
      try {
        contentValue = JSON.parse(row.content_json);
        taskContextPackSchema.parse(contentValue);
      } catch {
        markInvalid();
      }
      try {
        disclosureValue = JSON.parse(row.disclosure_json);
      } catch {
        markInvalid();
      }
      try {
        outboundDisclosureSchema.parse(disclosureValue);
      } catch {
        markInvalid();
      }
      try {
        const release = outboundReleaseSchema.parse({
          releaseId: row.id,
          requestId: row.request_id,
          sourcePackId: row.source_pack_id,
          releasedAt: row.released_at,
          sha256: row.sha256,
          disclosure: disclosureValue,
          pack: contentValue,
        });
        const hasStoredHierarchyVocabulary = contentValue !== null &&
          typeof contentValue === "object" &&
          Object.hasOwn(contentValue, "hierarchyVocabulary");
        if (!hasStoredHierarchyVocabulary) {
          delete release.pack.hierarchyVocabulary;
        }
        parsedReleasesById.set(row.id, release);
        const digest = computeOutboundReleaseDigest(release);
        if (
          release.sha256 !== digest ||
          release.disclosure.releaseDigest !== digest
        ) {
          markInvalid();
        }
      } catch {
        markInvalid();
      }
      if (!requestStates.has(row.request_id)) markInvalid();
    }

    for (const state of requestStates.values()) {
      const rows = releaseRowsByRequest.get(state.request.id) ?? [];
      if (
        (
          state.request.status === "released" &&
          (
            rows.length !== 1 ||
            rows[0]?.id !== state.request.releaseId
          )
        ) ||
        (
          state.request.status !== "released" &&
          (rows.length !== 0 || state.request.releaseId !== null)
        )
      ) {
        markInvalid();
      }
      const row = rows[0];
      if (
        state.request.status !== "released" ||
        row === undefined ||
        state.pack === undefined ||
        state.snapshot === undefined ||
        state.scan === undefined
      ) {
        continue;
      }
      const release = parsedReleasesById.get(row.id);
      const findings = findingsByRequest.get(state.request.id) ?? [];
      if (
        release === undefined ||
        row.source_pack_id !== state.request.sourcePackId ||
        row.released_at !== state.request.decidedAt
      ) {
        markInvalid();
        continue;
      }
      try {
        const expected = safetyEngine.createRelease({
          requestId: state.request.id,
          releaseId: row.id,
          pack: state.pack,
          sourcePackShape: {
            hierarchyVocabularyPresent:
              !packIdsWithoutHierarchyVocabulary.has(
                state.request.sourcePackId,
              ),
          },
          destination: state.snapshot,
          scan: state.scan,
          includeFindingIds: findings
            .filter(({ decision }) => decision === "include_once")
            .map(({ id }) => id),
          releasedAt: row.released_at,
        });
        let expectedForStoredShape = expected;
        if (!Object.hasOwn(release.pack, "hierarchyVocabulary")) {
          if (
            !packIdsWithoutHierarchyVocabulary.has(
              state.request.sourcePackId,
            ) ||
            !equalJson(
              taskContextPackSchema.parse(state.pack).hierarchyVocabulary,
              neutralHierarchyVocabulary,
            )
          ) {
            markInvalid();
            continue;
          }
          const {
            hierarchyVocabulary: _legacyMissingVocabulary,
            ...legacyPack
          } = expected.pack;
          const provisional: OutboundRelease = {
            ...expected,
            pack: legacyPack,
            sha256: "0".repeat(64),
            disclosure: {
              ...expected.disclosure,
              releaseDigest: "0".repeat(64),
            },
          };
          const legacyDigest = computeOutboundReleaseDigest(provisional);
          expectedForStoredShape = {
            ...provisional,
            sha256: legacyDigest,
            disclosure: {
              ...provisional.disclosure,
              releaseDigest: legacyDigest,
            },
          };
        }
        if (!equalJson(release, expectedForStoredShape)) markInvalid();
      } catch {
        markInvalid();
      }
    }

    const auditRows = database.prepare(`
      SELECT
        id, project_id, actor_type, profile_id, authority_mode,
        scope_decision, action_category, target_id, idempotency_key,
        revision_before, revision_after, outcome, reason, created_at
      FROM audit_events
      WHERE action_category LIKE 'outbound_%'
      ORDER BY created_at, id
    `).all() as {
      id: string;
      project_id: string | null;
      actor_type: "profile" | "local_human";
      profile_id: string | null;
      authority_mode: string | null;
      scope_decision: string;
      action_category: string;
      target_id: string | null;
      idempotency_key: string | null;
      revision_before: number | null;
      revision_after: number | null;
      outcome: string;
      reason: string;
      created_at: string;
    }[];
    const audits: IntegrityAudit[] = [];
    for (const row of auditRows) {
      try {
        const audit = integrityAuditSchema.parse({
          id: row.id,
          projectId: row.project_id,
          actorType: row.actor_type,
          profileId: row.profile_id,
          authorityMode: row.authority_mode,
          scopeDecision: row.scope_decision,
          actionCategory: row.action_category,
          targetId: row.target_id,
          idempotencyKey: row.idempotency_key,
          revisionBefore: row.revision_before,
          revisionAfter: row.revision_after,
          outcome: row.outcome,
          reason: row.reason,
          createdAt: row.created_at,
        });
        audits.push(audit);
        if (audit.idempotencyKey !== null || audit.outcome !== "applied") {
          markInvalid();
        }
      } catch {
        markInvalid();
      }
    }

    const nullRevisions = (audit: IntegrityAudit): boolean =>
      audit.revisionBefore === null && audit.revisionAfter === null;
    for (const state of requestStates.values()) {
      const request = state.request;
      const created = audits.filter((audit) =>
        audit.actionCategory === "outbound_request_created" &&
        audit.targetId === request.id
      );
      const scanned = audits.filter((audit) =>
        audit.actionCategory === "outbound_scan_completed" &&
        audit.targetId === request.id
      );
      const approved = audits.filter((audit) =>
        audit.actionCategory === "outbound_request_approved" &&
        audit.targetId === request.id
      );
      const denied = audits.filter((audit) =>
        audit.actionCategory === "outbound_request_denied" &&
        audit.targetId === request.id
      );
      const initialStatus = request.decisionActor === "policy"
        ? "released"
        : "review_required";
      const createdAudit = created[0];
      if (
        created.length !== 1 ||
        createdAudit?.projectId !== request.projectId ||
        createdAudit.actorType !== "profile" ||
        createdAudit.profileId !== request.profileId ||
        createdAudit.authorityMode !== null ||
        createdAudit.scopeDecision !== "outbound_safety" ||
        createdAudit.reason !== `request_status:${initialStatus}` ||
        createdAudit.createdAt !== request.createdAt ||
        !nullRevisions(createdAudit)
      ) {
        markInvalid();
      }
      const scanAudit = scanned[0];
      const initialCounts = state.scan === undefined
        ? undefined
        : countsForFindings(state.scan.findings);
      if (
        scanned.length !== 1 ||
        initialCounts === undefined ||
        scanAudit?.projectId !== request.projectId ||
        scanAudit.actorType !== "profile" ||
        scanAudit.profileId !== request.profileId ||
        scanAudit.authorityMode !== null ||
        scanAudit.scopeDecision !== "outbound_safety" ||
        scanAudit.reason !== scanAuditReason(initialCounts, request) ||
        scanAudit.createdAt !== request.createdAt ||
        !nullRevisions(scanAudit)
      ) {
        markInvalid();
      }
      const expectsApproval = request.status === "released" &&
        request.decisionActor === "local_human";
      const approvalAudit = approved[0];
      if (
        (expectsApproval ? approved.length !== 1 : approved.length !== 0) ||
        (
          expectsApproval &&
          (
            approvalAudit?.projectId !== request.projectId ||
            approvalAudit.actorType !== "local_human" ||
            approvalAudit.profileId !== null ||
            approvalAudit.authorityMode !== "human" ||
            approvalAudit.scopeDecision !== "human_admin" ||
            approvalAudit.reason !== "approved" ||
            approvalAudit.createdAt !== request.decidedAt ||
            !nullRevisions(approvalAudit)
          )
        )
      ) {
        markInvalid();
      }
      const expectsDenial = request.status === "denied";
      const denialAudit = denied[0];
      if (
        (expectsDenial ? denied.length !== 1 : denied.length !== 0) ||
        (
          expectsDenial &&
          (
            denialAudit?.projectId !== request.projectId ||
            denialAudit.actorType !== "local_human" ||
            denialAudit.profileId !== null ||
            denialAudit.authorityMode !== "human" ||
            denialAudit.scopeDecision !== "human_admin" ||
            denialAudit.reason !== "denied" ||
            denialAudit.createdAt !== request.decidedAt ||
            !nullRevisions(denialAudit)
          )
        )
      ) {
        markInvalid();
      }
    }

    for (const audit of audits) {
      if (
        [
          "outbound_request_created",
          "outbound_scan_completed",
          "outbound_request_approved",
          "outbound_request_denied",
        ].includes(audit.actionCategory)
      ) {
        if (
          audit.targetId === null ||
          !requestStates.has(audit.targetId)
        ) {
          markInvalid();
        }
        continue;
      }
      if (audit.actionCategory === "outbound_release_retrieved") {
        const state = audit.targetId === null
          ? undefined
          : requestStates.get(audit.targetId);
        if (
          state?.request.status !== "released" ||
          audit.projectId !== state.request.projectId ||
          audit.actorType !== "profile" ||
          audit.profileId !== state.request.profileId ||
          audit.authorityMode !== null ||
          audit.scopeDecision !== "outbound_safety" ||
          audit.reason !== "release_retrieved" ||
          !nullRevisions(audit)
        ) {
          markInvalid();
        }
        continue;
      }
      if (audit.actionCategory === "outbound_policy_enabled") {
        const state = audit.targetId === null
          ? undefined
          : requestStates.get(audit.targetId);
        if (
          state?.request.status !== "released" ||
          state.request.decisionActor !== "local_human" ||
          state.scan?.findings.length !== 0 ||
          audit.projectId !== state.request.projectId ||
          audit.actorType !== "local_human" ||
          audit.profileId !== null ||
          audit.authorityMode !== "human" ||
          audit.scopeDecision !== "human_admin" ||
          audit.reason !== policyAuditReason(
            state.request.detectorVersion,
            state.request.safetyPolicyVersion,
            state.request.destinationRevision,
          ) ||
          audit.createdAt !== state.request.decidedAt ||
          !nullRevisions(audit)
        ) {
          markInvalid();
        }
        continue;
      }
      if (audit.actionCategory === "outbound_policy_disabled") {
        if (
          audit.projectId !== audit.targetId ||
          audit.actorType !== "local_human" ||
          audit.profileId !== null ||
          audit.authorityMode !== "human" ||
          audit.scopeDecision !== "human_admin" ||
          audit.reason !== "policy_disabled" ||
          !nullRevisions(audit)
        ) {
          markInvalid();
        }
        continue;
      }
      if (
        audit.actionCategory === "outbound_destination_set" ||
        audit.actionCategory === "outbound_destination_disabled"
      ) {
        if (
          audit.projectId !== null ||
          audit.actorType !== "local_human" ||
          audit.profileId !== null ||
          audit.authorityMode !== "human" ||
          audit.scopeDecision !== "human_admin" ||
          audit.targetId === null ||
          audit.revisionAfter === null ||
          audit.revisionAfter < 1 ||
          audit.reason !== `destination_revision:${audit.revisionAfter}`
        ) {
          markInvalid();
        }
        continue;
      }
      markInvalid();
    }

    for (const policy of policies) {
      if (policy.mode !== "auto_release_clean") continue;
      const hasEnablingAudit = audits.some((audit) => {
        if (
          audit.actionCategory !== "outbound_policy_enabled" ||
          audit.createdAt !== policy.updatedAt ||
          audit.targetId === null
        ) {
          return false;
        }
        const state = requestStates.get(audit.targetId);
        return state !== undefined &&
          state.request.profileId === policy.profileId &&
          state.request.projectId === policy.projectId &&
          state.request.destinationId === policy.destinationId &&
          state.request.destinationRevision === policy.destinationRevision &&
          state.request.detectorVersion === policy.detectorVersion &&
          state.request.safetyPolicyVersion === policy.safetyPolicyVersion;
      });
      if (!hasEnablingAudit) markInvalid();
    }
  } catch {
    addIssue(issues, "schema_object_missing");
    markInvalid();
  }

  if (invalid) addIssue(issues, "outbound_state_invalid");
};

const repositoryImportVersionSchema = z.string()
  .min(1)
  .refine((value) => value === value.trim());
const repositoryImportIdentifierSchema = z.string()
  .min(1)
  .refine((value) => value === value.trim());
const repositoryImportSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const repositoryImportReceiptSchema = z.object({
  manifestDigest: repositoryImportSha256Schema,
  projectId: repositoryImportIdentifierSchema,
  repositoryFingerprint: repositoryImportSha256Schema,
  scannerVersion: repositoryImportVersionSchema,
  rulesetVersion: repositoryImportVersionSchema,
  manifestVersion: z.literal(1),
  recordCount: z.number().int().nonnegative(),
  relationshipCount: z.number().int().nonnegative(),
  initialSnapshotDigest: repositoryImportSha256Schema,
  initialSnapshotJson: z.string(),
  createdAt: storeTimestampSchema,
}).strict();

const repositoryImportAuditSchema = z.object({
  id: repositoryImportIdentifierSchema,
  projectId: repositoryImportIdentifierSchema.nullable(),
  actorType: z.string(),
  profileId: z.string().nullable(),
  authorityMode: z.string().nullable(),
  scopeDecision: z.string().nullable(),
  actionCategory: z.string(),
  targetId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  revisionBefore: z.number().int().nullable(),
  revisionAfter: z.number().int().nullable(),
  outcome: z.string(),
  reason: z.string().nullable(),
  createdAt: storeTimestampSchema,
}).strict();

type RepositoryImportReceipt = z.infer<
  typeof repositoryImportReceiptSchema
>;
type RepositoryImportAudit = z.infer<typeof repositoryImportAuditSchema>;

const checkRepositoryImportSemanticState = (
  database: IntentArcDatabase,
  issues: IntegrityIssue[],
): void => {
  let invalid = false;
  const markInvalid = (): void => {
    invalid = true;
  };

  try {
    const projectRows = database.prepare(
      "SELECT id, revision FROM projects ORDER BY id",
    ).all() as { id: string; revision: number }[];
    const projectRevisions = new Map(
      projectRows.map(({ id, revision }) => [id, revision] as const),
    );
    const receiptRows = database.prepare(`
      SELECT
        manifest_digest, project_id, repository_fingerprint,
        scanner_version, ruleset_version, manifest_version, record_count,
        relationship_count, initial_snapshot_digest, initial_snapshot_json,
        created_at
      FROM repository_import_receipts
      ORDER BY manifest_digest
    `).all() as {
      manifest_digest: unknown;
      project_id: unknown;
      repository_fingerprint: unknown;
      scanner_version: unknown;
      ruleset_version: unknown;
      manifest_version: unknown;
      record_count: unknown;
      relationship_count: unknown;
      initial_snapshot_digest: unknown;
      initial_snapshot_json: unknown;
      created_at: unknown;
    }[];
    const receipts: RepositoryImportReceipt[] = [];
    for (const row of receiptRows) {
      const result = repositoryImportReceiptSchema.safeParse({
        manifestDigest: row.manifest_digest,
        projectId: row.project_id,
        repositoryFingerprint: row.repository_fingerprint,
        scannerVersion: row.scanner_version,
        rulesetVersion: row.ruleset_version,
        manifestVersion: row.manifest_version,
        recordCount: row.record_count,
        relationshipCount: row.relationship_count,
        initialSnapshotDigest: row.initial_snapshot_digest,
        initialSnapshotJson: row.initial_snapshot_json,
        createdAt: row.created_at,
      });
      if (!result.success) {
        markInvalid();
        continue;
      }
      receipts.push(result.data);
      const projectRevision = projectRevisions.get(result.data.projectId);
      const snapshot = parseInitialRepositorySnapshot(
        result.data.initialSnapshotJson,
        result.data.initialSnapshotDigest,
      );
      if (
        projectRevision === undefined ||
        !Number.isInteger(projectRevision) ||
        projectRevision < 1 ||
        snapshot === null ||
        snapshot.projectId !== result.data.projectId ||
        snapshot.recordIds.length !== result.data.recordCount ||
        snapshot.relationships.length !== result.data.relationshipCount
      ) {
        markInvalid();
        continue;
      }
      for (const recordId of snapshot.recordIds) {
        const revision = database.prepare(`
          SELECT snapshot_json
          FROM project_record_revisions
          WHERE record_id = ? AND revision = 1
        `).get(recordId) as { snapshot_json: unknown } | undefined;
        if (typeof revision?.snapshot_json !== "string") {
          markInvalid();
          continue;
        }
        try {
          const record = projectRecordSchema.parse(
            JSON.parse(revision.snapshot_json) as unknown,
          );
          if (
            record.id !== recordId ||
            record.projectId !== result.data.projectId ||
            record.revision !== 1
          ) {
            markInvalid();
          }
        } catch {
          markInvalid();
        }
      }
    }

    const auditRows = database.prepare(`
      SELECT
        id, project_id, actor_type, profile_id, authority_mode,
        scope_decision, action_category, target_id, idempotency_key,
        revision_before, revision_after, outcome, reason, created_at
      FROM audit_events
      WHERE action_category = 'repository_import_applied'
      ORDER BY created_at, id
    `).all() as {
      id: unknown;
      project_id: unknown;
      actor_type: unknown;
      profile_id: unknown;
      authority_mode: unknown;
      scope_decision: unknown;
      action_category: unknown;
      target_id: unknown;
      idempotency_key: unknown;
      revision_before: unknown;
      revision_after: unknown;
      outcome: unknown;
      reason: unknown;
      created_at: unknown;
    }[];
    const audits: RepositoryImportAudit[] = [];
    for (const row of auditRows) {
      const result = repositoryImportAuditSchema.safeParse({
        id: row.id,
        projectId: row.project_id,
        actorType: row.actor_type,
        profileId: row.profile_id,
        authorityMode: row.authority_mode,
        scopeDecision: row.scope_decision,
        actionCategory: row.action_category,
        targetId: row.target_id,
        idempotencyKey: row.idempotency_key,
        revisionBefore: row.revision_before,
        revisionAfter: row.revision_after,
        outcome: row.outcome,
        reason: row.reason,
        createdAt: row.created_at,
      });
      if (!result.success) {
        markInvalid();
        continue;
      }
      audits.push(result.data);
    }

    const auditMatchesReceipt = (
      audit: RepositoryImportAudit,
      receipt: RepositoryImportReceipt,
    ): boolean =>
      audit.projectId === receipt.projectId &&
      audit.actorType === "local_human" &&
      audit.profileId === null &&
      audit.authorityMode === "human" &&
      audit.scopeDecision === "human_import" &&
      audit.actionCategory === "repository_import_applied" &&
      audit.targetId === receipt.projectId &&
      audit.idempotencyKey === null &&
      audit.revisionBefore === 0 &&
      audit.revisionAfter === 1 &&
      audit.outcome === "applied" &&
      audit.reason === null &&
      audit.createdAt === receipt.createdAt;

    for (const receipt of receipts) {
      const matches = audits.filter(
        (audit) => audit.projectId === receipt.projectId,
      );
      if (matches.length !== 1 || !auditMatchesReceipt(matches[0]!, receipt)) {
        markInvalid();
      }
    }
    for (const audit of audits) {
      const matches = receipts.filter(
        (receipt) => receipt.projectId === audit.projectId,
      );
      if (matches.length !== 1 || !auditMatchesReceipt(audit, matches[0]!)) {
        markInvalid();
      }
    }
  } catch {
    addIssue(issues, "schema_object_missing");
    markInvalid();
  }

  if (invalid) addIssue(issues, "repository_import_state_invalid");
};

const checkRepositoryIndexSemanticState = (
  database: IntentArcDatabase,
  issues: IntegrityIssue[],
): void => {
  let invalid = false;
  const markInvalid = (): void => {
    invalid = true;
  };
  const parseStoredJson = (value: unknown): unknown | undefined => {
    if (typeof value !== "string") {
      addIssue(issues, "stored_json_invalid");
      markInvalid();
      return undefined;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      addIssue(issues, "stored_json_invalid");
      markInvalid();
      return undefined;
    }
  };

  try {
    const sourceRows = database.prepare(`
      SELECT
        id, project_id, root, canonical_subpath, repository_identity,
        status, current_snapshot_id, created_at, updated_at
      FROM repository_sources
      ORDER BY id
    `).all() as Record<string, unknown>[];
    const snapshotRows = database.prepare(`
      SELECT
        id, source_id, project_id, state, base_snapshot_id,
        base_project_revision, branch, head, fingerprint, scanner_version,
        ruleset_version, warning_counts_json, exclusion_counts_json,
        finding_counts_json, created_at, decided_at, applied_at
      FROM repository_snapshots
      ORDER BY id
    `).all() as Record<string, unknown>[];
    const nodeRows = database.prepare(`
      SELECT id, source_id, kind, created_at
      FROM repository_nodes
      ORDER BY id
    `).all() as Record<string, unknown>[];
    const observationRows = database.prepare(`
      SELECT
        snapshot_id, node_id, source_id, parent_node_id, path, kind,
        sha256, byte_size, source_status, role, document_kind,
        document_format, content_eligible, instruction_client,
        instruction_scope
      FROM repository_node_observations
      ORDER BY snapshot_id, node_id
    `).all() as Record<string, unknown>[];
    const linkRows = database.prepare(`
      SELECT
        id, project_id, snapshot_id, source_id, from_node_id,
        to_record_id, to_node_id, kind, basis, created_at
      FROM repository_links
      ORDER BY id
    `).all() as Record<string, unknown>[];
    const reviewRows = database.prepare(`
      SELECT
        project_id, source_id, snapshot_id, state,
        selected_operation_ids_json, created_at, updated_at, decided_at
      FROM repository_refresh_reviews
      ORDER BY snapshot_id
    `).all() as Record<string, unknown>[];
    const projectRecords = database.prepare(`
      SELECT id, project_id FROM project_records ORDER BY id
    `).all() as { id: string; project_id: string }[];

    type Source = ReturnType<typeof repositorySourceSchema.parse>;
    type Snapshot = ReturnType<typeof repositorySnapshotSchema.parse>;
    type Node = ReturnType<typeof repositoryNodeSchema.parse>;
    type Observation = ReturnType<typeof repositoryNodeObservationSchema.parse>;
    type Link = ReturnType<typeof repositoryLinkSchema.parse>;
    type Review = ReturnType<typeof repositoryRefreshReviewSchema.parse>;
    const sources = new Map<string, Source>();
    const snapshots = new Map<string, Snapshot>();
    const nodes = new Map<string, Node>();
    const observations = new Map<string, Observation & { sourceId: string }>();
    const links: (Link & { sourceId: string })[] = [];
    const reviews: Review[] = [];

    for (const row of sourceRows) {
      const result = repositorySourceSchema.safeParse({
        id: row.id,
        projectId: row.project_id,
        root: row.root,
        canonicalSubpath: row.canonical_subpath,
        repositoryIdentity: row.repository_identity,
        status: row.status,
        currentSnapshotId: row.current_snapshot_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      if (!result.success) {
        markInvalid();
      } else {
        sources.set(result.data.id, result.data);
      }
    }

    for (const row of snapshotRows) {
      const warningCounts = parseStoredJson(row.warning_counts_json);
      const exclusionCounts = parseStoredJson(row.exclusion_counts_json);
      const findingCounts = parseStoredJson(row.finding_counts_json);
      const result = repositorySnapshotSchema.safeParse({
        id: row.id,
        sourceId: row.source_id,
        projectId: row.project_id,
        state: row.state,
        baseSnapshotId: row.base_snapshot_id,
        baseProjectRevision: row.base_project_revision,
        branch: row.branch,
        head: row.head,
        fingerprint: row.fingerprint,
        scannerVersion: row.scanner_version,
        rulesetVersion: row.ruleset_version,
        warningCounts,
        exclusionCounts,
        findingCounts,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        appliedAt: row.applied_at,
      });
      if (!result.success) {
        if (result.error.issues.some(({ path }) =>
          path[0] === "warningCounts" ||
          path[0] === "exclusionCounts" ||
          path[0] === "findingCounts"
        )) {
          addIssue(issues, "stored_json_invalid");
        }
        markInvalid();
      } else {
        snapshots.set(result.data.id, result.data);
      }
    }

    for (const row of nodeRows) {
      const result = repositoryNodeSchema.safeParse({
        id: row.id,
        sourceId: row.source_id,
        kind: row.kind,
        createdAt: row.created_at,
      });
      if (!result.success) {
        markInvalid();
      } else {
        nodes.set(result.data.id, result.data);
      }
    }

    for (const row of observationRows) {
      const result = repositoryNodeObservationSchema.safeParse({
        snapshotId: row.snapshot_id,
        nodeId: row.node_id,
        parentNodeId: row.parent_node_id,
        path: row.path,
        kind: row.kind,
        sha256: row.sha256,
        byteSize: row.byte_size,
        sourceStatus: row.source_status,
        role: row.role,
        documentKind: row.document_kind,
        documentFormat: row.document_format,
        contentEligible: row.content_eligible === 1
          ? true
          : row.content_eligible === 0
          ? false
          : row.content_eligible,
        instructionClient: row.instruction_client,
        instructionScope: row.instruction_scope,
      });
      if (!result.success || typeof row.source_id !== "string") {
        markInvalid();
      } else {
        observations.set(
          `${result.data.snapshotId}\0${result.data.nodeId}`,
          { ...result.data, sourceId: row.source_id },
        );
      }
    }

    for (const row of linkRows) {
      const result = repositoryLinkSchema.safeParse({
        id: row.id,
        projectId: row.project_id,
        snapshotId: row.snapshot_id,
        fromNodeId: row.from_node_id,
        toRecordId: row.to_record_id,
        toNodeId: row.to_node_id,
        kind: row.kind,
        basis: row.basis,
        createdAt: row.created_at,
      });
      if (!result.success || typeof row.source_id !== "string") {
        markInvalid();
      } else {
        links.push({ ...result.data, sourceId: row.source_id });
      }
    }

    for (const row of reviewRows) {
      const selectedOperationIds = parseStoredJson(
        row.selected_operation_ids_json,
      );
      const result = repositoryRefreshReviewSchema.safeParse({
        projectId: row.project_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        state: row.state,
        selectedOperationIds,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        decidedAt: row.decided_at,
      });
      if (!result.success) {
        if (result.error.issues.some(
          ({ path }) => path[0] === "selectedOperationIds",
        )) {
          addIssue(issues, "stored_json_invalid");
        }
        markInvalid();
      } else {
        reviews.push(result.data);
      }
    }

    for (const source of sources.values()) {
      if (source.currentSnapshotId === null) continue;
      const current = snapshots.get(source.currentSnapshotId);
      if (
        current === undefined ||
        current.sourceId !== source.id ||
        current.projectId !== source.projectId ||
        current.state !== "accepted"
      ) {
        markInvalid();
      }
    }
    for (const snapshot of snapshots.values()) {
      const source = sources.get(snapshot.sourceId);
      const base = snapshot.baseSnapshotId === null
        ? undefined
        : snapshots.get(snapshot.baseSnapshotId);
      if (
        source === undefined ||
        source.projectId !== snapshot.projectId ||
        (snapshot.baseSnapshotId !== null && (
          base === undefined || base.sourceId !== snapshot.sourceId
        ))
      ) {
        markInvalid();
      }
    }
    for (const node of nodes.values()) {
      if (!sources.has(node.sourceId)) markInvalid();
    }
    for (const observation of observations.values()) {
      const snapshot = snapshots.get(observation.snapshotId);
      const node = nodes.get(observation.nodeId);
      const parent = observation.parentNodeId === null
        ? undefined
        : observations.get(
          `${observation.snapshotId}\0${observation.parentNodeId}`,
        );
      if (
        snapshot === undefined ||
        node === undefined ||
        observation.sourceId !== snapshot.sourceId ||
        observation.sourceId !== node.sourceId ||
        observation.kind !== node.kind ||
        (observation.parentNodeId !== null && parent === undefined)
      ) {
        markInvalid();
      }
    }
    const recordProjects = new Map(
      projectRecords.map((record) => [record.id, record.project_id] as const),
    );
    for (const link of links) {
      const snapshot = snapshots.get(link.snapshotId);
      const from = observations.get(`${link.snapshotId}\0${link.fromNodeId}`);
      const toNode = link.toNodeId === null
        ? undefined
        : observations.get(`${link.snapshotId}\0${link.toNodeId}`);
      if (
        snapshot === undefined ||
        snapshot.projectId !== link.projectId ||
        snapshot.sourceId !== link.sourceId ||
        from === undefined ||
        (link.toNodeId !== null && toNode === undefined) ||
        (link.toRecordId !== null &&
          recordProjects.get(link.toRecordId) !== link.projectId)
      ) {
        markInvalid();
      }
    }
    for (const review of reviews) {
      const snapshot = snapshots.get(review.snapshotId);
      const expectedSnapshotState = review.state === "pending"
        ? "candidate"
        : review.state === "applied"
        ? "accepted"
        : "discarded";
      if (
        snapshot === undefined ||
        snapshot.sourceId !== review.sourceId ||
        snapshot.projectId !== review.projectId ||
        snapshot.state !== expectedSnapshotState
      ) {
        markInvalid();
      }
    }
  } catch {
    addIssue(issues, "schema_object_missing");
    markInvalid();
  }

  if (invalid) addIssue(issues, "repository_index_state_invalid");
};

const checkCoordinationSemanticState = (
  database: IntentArcDatabase,
  issues: IntegrityIssue[],
): void => {
  let invalid = false;
  const markInvalid = (): void => { invalid = true; };

  try {
    const tasks = database.prepare(`
      SELECT id, project_id, kind FROM project_records
    `).all() as { id: string; project_id: string; kind: string }[];
    const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
    const profileIds = new Set((database.prepare(`
      SELECT id FROM client_profiles
    `).all() as { id: string }[]).map(({ id }) => id));
    const packs = database.prepare(`
      SELECT id, project_id, task_id FROM context_packs
    `).all() as { id: string; project_id: string; task_id: string }[];
    const packsById = new Map(packs.map((pack) => [pack.id, pack] as const));

    const claimRows = database.prepare(`
      SELECT id, project_id, task_id, profile_id, delegation_id, state,
        base_project_revision, base_task_revision, context_pack_id,
        acquired_at, expires_at, absolute_expires_at, ended_at,
        latest_checkpoint_id
      FROM task_claims ORDER BY id
    `).all() as Record<string, any>[];
    const claimsById = new Map<string, Record<string, any>>();
    for (const row of claimRows) {
      claimsById.set(row.id as string, row);
      const task = tasksById.get(row.task_id as string);
      const pack = packsById.get(row.context_pack_id as string);
      const terminalTimestampIsCoherent = row.state === "active"
        ? row.ended_at === null
        : row.ended_at !== null;
      if (
        task?.kind !== "task" || task.project_id !== row.project_id ||
        pack?.project_id !== row.project_id || pack?.task_id !== row.task_id ||
        !terminalTimestampIsCoherent ||
        !taskClaimLifecycleIsCoherent({
          state: row.state,
          acquiredAt: row.acquired_at,
          expiresAt: row.expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
          endedAt: row.ended_at,
        }) ||
        !taskClaimSchema.safeParse({
          id: row.id,
          projectId: row.project_id,
          taskId: row.task_id,
          profileId: row.profile_id,
          delegationId: row.delegation_id,
          state: row.state,
          baseProjectRevision: row.base_project_revision,
          baseTaskRevision: row.base_task_revision,
          contextPackId: row.context_pack_id,
          acquiredAt: row.acquired_at,
          expiresAt: row.expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
          endedAt: row.ended_at,
          latestCheckpointId: row.latest_checkpoint_id,
        }).success
      ) markInvalid();
    }

    const checkpointRows = database.prepare(`
      SELECT id, claim_id, sequence, document_json, created_at,
        project_revision, task_revision, context_pack_id
      FROM task_checkpoints ORDER BY claim_id, sequence, id
    `).all() as Record<string, any>[];
    const checkpointsById = new Map<string, Record<string, any>>();
    const nextSequence = new Map<string, number>();
    for (const row of checkpointRows) {
      checkpointsById.set(row.id as string, row);
      const expected = nextSequence.get(row.claim_id as string) ?? 1;
      nextSequence.set(row.claim_id as string, expected + 1);
      if (row.sequence !== expected) markInvalid();
      const claim = claimsById.get(row.claim_id as string);
      if (claim === undefined || row.context_pack_id !== claim.context_pack_id) {
        markInvalid();
      }
      let document: unknown;
      try {
        document = checkpointDocumentSchema.parse(JSON.parse(row.document_json as string));
      } catch {
        addIssue(issues, "stored_json_invalid");
        markInvalid();
        continue;
      }
      if (!taskCheckpointSchema.safeParse({
        id: row.id,
        claimId: row.claim_id,
        sequence: row.sequence,
        createdAt: row.created_at,
        ...(document as Record<string, unknown>),
        projectRevision: row.project_revision,
        taskRevision: row.task_revision,
        contextPackId: row.context_pack_id,
      }).success) markInvalid();
    }
    for (const claim of claimRows) {
      if (
        claim.latest_checkpoint_id !== null &&
        checkpointsById.get(claim.latest_checkpoint_id as string)?.claim_id !== claim.id
      ) markInvalid();
    }

    const delegationRows = database.prepare(`
      SELECT id, project_id, task_id, parent_profile_id, child_profile_id,
        state, base_project_revision, base_task_revision, scope_json,
        allowed_outputs_json, offered_at, deadline, accepted_at, ended_at,
        claim_id
      FROM task_delegations ORDER BY id
    `).all() as Record<string, any>[];
    const delegationsById = new Map<string, Record<string, any>>();
    for (const row of delegationRows) {
      delegationsById.set(row.id as string, row);
      let scope: unknown;
      let allowedOutputs: unknown;
      try {
        scope = delegationScopeSchema.parse(JSON.parse(row.scope_json as string));
        allowedOutputs = JSON.parse(row.allowed_outputs_json as string);
      } catch {
        addIssue(issues, "stored_json_invalid");
        markInvalid();
        continue;
      }
      const claim = row.claim_id === null
        ? undefined
        : claimsById.get(row.claim_id as string);
      const task = tasksById.get(row.task_id as string);
      const acceptedTimestampIsCoherent = row.accepted_at === null ||
        (row.accepted_at >= row.offered_at && row.accepted_at < row.deadline);
      const endedTimestampIsCoherent = row.ended_at === null ||
        (row.ended_at >= (row.accepted_at ?? row.offered_at));
      const stateReferencesAreCoherent = (() => {
        switch (row.state) {
          case "offered":
            return row.accepted_at === null && row.ended_at === null && row.claim_id === null;
          case "accepted":
            return row.accepted_at !== null && row.ended_at === null && row.claim_id === null;
          case "claimed":
            return row.accepted_at !== null && row.ended_at === null && claim !== undefined &&
              (claim.state === "active" || claim.state === "submitted") &&
              claim.acquired_at >= row.accepted_at && claim.acquired_at < row.deadline;
          case "revoked":
            return row.ended_at !== null && (claim === undefined ||
              ((claim.state === "paused" || claim.state === "released") &&
                claim.ended_at === row.ended_at));
          case "expired":
            return row.ended_at !== null && (claim === undefined ||
              (claim.state === "expired" && claim.ended_at === row.ended_at));
          case "completed":
            return row.accepted_at !== null && row.ended_at !== null &&
              claim !== undefined && claim.state === "reconciled" &&
              claim.ended_at === row.ended_at;
          default:
            return false;
        }
      })();
      if (
        task?.kind !== "task" || task.project_id !== row.project_id ||
        !acceptedTimestampIsCoherent || !endedTimestampIsCoherent ||
        !stateReferencesAreCoherent ||
        !taskDelegationLifecycleIsCoherent({
          state: row.state,
          offeredAt: row.offered_at,
          deadline: row.deadline,
          acceptedAt: row.accepted_at,
          endedAt: row.ended_at,
          claimId: row.claim_id,
        }) ||
        (row.claim_id !== null && (
          claim === undefined || claim.project_id !== row.project_id ||
          claim.task_id !== row.task_id || claim.profile_id !== row.child_profile_id ||
          claim.delegation_id !== row.id
        )) ||
        !taskDelegationSchema.safeParse({
          id: row.id,
          projectId: row.project_id,
          taskId: row.task_id,
          parentProfileId: row.parent_profile_id,
          childProfileId: row.child_profile_id,
          state: row.state,
          baseProjectRevision: row.base_project_revision,
          baseTaskRevision: row.base_task_revision,
          scope,
          allowedOutputs,
          offeredAt: row.offered_at,
          deadline: row.deadline,
          acceptedAt: row.accepted_at,
          endedAt: row.ended_at,
          claimId: row.claim_id,
        }).success
      ) markInvalid();
    }
    for (const claim of claimRows) {
      if (claim.delegation_id === null) continue;
      const delegation = delegationsById.get(claim.delegation_id as string);
      const expectedDelegationStates: Record<string, readonly string[]> = {
        active: ["claimed"],
        paused: ["revoked"],
        released: ["revoked", "expired"],
        submitted: ["claimed"],
        expired: ["expired"],
        reconciled: ["completed"],
      };
      if (delegation?.claim_id !== claim.id ||
        !expectedDelegationStates[claim.state as string]?.includes(delegation?.state as string)) {
        markInvalid();
      }
    }

    const proposals = database.prepare(`
      SELECT id, project_id, profile_id, source_task_id, state, updated_at
      FROM change_proposals
    `).all() as Record<string, any>[];
    const proposalsById = new Map(proposals.map((row) => [row.id as string, row] as const));
    const submissionRows = database.prepare(`
      SELECT id, claim_id, checkpoint_id, profile_id, project_id, task_id,
        base_project_revision, base_task_revision, context_pack_id,
        document_json, proposal_id, state, submitted_at, decided_at
      FROM task_submissions ORDER BY id
    `).all() as Record<string, any>[];
    const submissionsById = new Map<string, Record<string, any>>();
    for (const row of submissionRows) {
      submissionsById.set(row.id as string, row);
      let document: ReturnType<typeof submissionDocumentSchema.parse>;
      try {
        document = submissionDocumentSchema.parse(JSON.parse(row.document_json as string));
      } catch {
        addIssue(issues, "stored_json_invalid");
        markInvalid();
        continue;
      }
      const claim = claimsById.get(row.claim_id as string);
      const checkpoint = checkpointsById.get(row.checkpoint_id as string);
      const proposal = proposalsById.get(row.proposal_id as string);
      const expectedSubmissionState = proposal?.state === "pending"
        ? "submitted"
        : proposal?.state;
      const claimStateIsCoherent = proposal?.state === "accepted"
        ? claim?.state === "reconciled"
        : proposal?.state === "pending"
        ? claim?.state === "submitted"
        : claim?.state === "submitted" || claim?.state === "released";
      const linkedDelegation = claim?.delegation_id === null || claim?.delegation_id === undefined
        ? undefined
        : delegationsById.get(claim.delegation_id as string);
      const delegationStateIsCoherent = proposal?.state !== "accepted" ||
        claim?.delegation_id === null || (
          linkedDelegation?.claim_id === claim?.id &&
          linkedDelegation?.state === "completed" &&
          linkedDelegation?.ended_at === proposal.updated_at
        );
      const releasedDelegationIsCoherent = claim?.state !== "released" ||
        claim?.delegation_id === null || (
          linkedDelegation?.claim_id === claim?.id &&
          (linkedDelegation?.state === "revoked" || linkedDelegation?.state === "expired") &&
          linkedDelegation?.ended_at !== null
        );
      const submittedDelegationIsCoherent = claim?.state !== "submitted" ||
        claim?.delegation_id === null || (
          linkedDelegation?.claim_id === claim?.id &&
          linkedDelegation?.state === "claimed" &&
          linkedDelegation?.ended_at === null
        );
      if (
        claim === undefined || checkpoint?.claim_id !== row.claim_id ||
        row.profile_id !== claim.profile_id || row.project_id !== claim.project_id ||
        row.task_id !== claim.task_id || row.context_pack_id !== claim.context_pack_id ||
        row.base_project_revision !== claim.base_project_revision ||
        row.base_task_revision !== claim.base_task_revision ||
        proposal?.project_id !== row.project_id ||
        proposal?.source_task_id !== row.task_id || proposal?.profile_id !== row.profile_id ||
        expectedSubmissionState !== row.state || !claimStateIsCoherent ||
        !delegationStateIsCoherent || !releasedDelegationIsCoherent ||
        !submittedDelegationIsCoherent ||
        !taskSubmissionSchema.safeParse({
          id: row.id,
          claimId: row.claim_id,
          checkpointId: row.checkpoint_id,
          profileId: row.profile_id,
          projectId: row.project_id,
          taskId: row.task_id,
          baseProjectRevision: row.base_project_revision,
          baseTaskRevision: row.base_task_revision,
          contextPackId: row.context_pack_id,
          summary: document.summary,
          verificationEvidence: document.verificationEvidence,
          repositoryEvidence: document.repositoryEvidence,
          proposalId: row.proposal_id,
          state: row.state,
          submittedAt: row.submitted_at,
          decidedAt: row.decided_at,
        }).success
      ) markInvalid();
    }
    const submissionByClaim = new Map<string, Record<string, any>[]>();
    for (const submission of submissionRows) {
      const rows = submissionByClaim.get(submission.claim_id as string) ?? [];
      rows.push(submission);
      submissionByClaim.set(submission.claim_id as string, rows);
    }

    const eventRows = database.prepare(`
      SELECT id, category, project_id, task_id, profile_id, claim_id,
        delegation_id, checkpoint_id, submission_id, proposal_id, prior_state,
        resulting_state, project_revision, task_revision, detail, created_at
      FROM coordination_events ORDER BY id
    `).all() as Record<string, any>[];
    const semanticEvents: CoordinationEvent[] = eventRows.map((row) => ({
      id: row.id as string,
      category: row.category as CoordinationEvent["category"],
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      profileId: row.profile_id as string | null,
      claimId: row.claim_id as string | null,
      delegationId: row.delegation_id as string | null,
      checkpointId: row.checkpoint_id as string | null,
      submissionId: row.submission_id as string | null,
      proposalId: row.proposal_id as string | null,
      priorState: row.prior_state as string | null,
      resultingState: row.resulting_state as string | null,
      projectRevision: row.project_revision as number,
      taskRevision: row.task_revision as number,
      detail: row.detail as string | null,
      createdAt: row.created_at as string,
    }));
    const eventsForClaim = new Map<string, Record<string, any>[]>();
    const eventsForDelegation = new Map<string, Record<string, any>[]>();
    const eventsForCheckpoint = new Map<string, Record<string, any>[]>();
    const eventsForSubmission = new Map<string, Record<string, any>[]>();
    const indexEvent = (
      index: Map<string, Record<string, any>[]>,
      id: unknown,
      row: Record<string, any>,
    ): void => {
      if (typeof id !== "string") return;
      const rows = index.get(id) ?? [];
      rows.push(row);
      index.set(id, rows);
    };
    for (const row of eventRows) {
      indexEvent(eventsForClaim, row.claim_id, row);
      indexEvent(eventsForDelegation, row.delegation_id, row);
      indexEvent(eventsForCheckpoint, row.checkpoint_id, row);
      indexEvent(eventsForSubmission, row.submission_id, row);
      const task = tasksById.get(row.task_id as string);
      const claim = row.claim_id === null
        ? undefined
        : claimsById.get(row.claim_id as string);
      const delegation = row.delegation_id === null
        ? undefined
        : delegationsById.get(row.delegation_id as string);
      const checkpoint = row.checkpoint_id === null
        ? undefined
        : checkpointsById.get(row.checkpoint_id as string);
      const submission = row.submission_id === null
        ? undefined
        : submissionsById.get(row.submission_id as string);
      const proposal = row.proposal_id === null
        ? undefined
        : proposalsById.get(row.proposal_id as string);
      const actorIsCoherent = row.profile_id === null
        ? row.category === "ready_evaluation"
        : profileIds.has(row.profile_id as string) &&
          (claim === undefined || claim.profile_id === row.profile_id) &&
          (submission === undefined || submission.profile_id === row.profile_id) &&
          (proposal === undefined || proposal.profile_id === row.profile_id) &&
          (delegation === undefined || claim !== undefined ||
            (row.category === "delegation_offer" || row.category === "delegation_revoke"
              ? delegation.parent_profile_id === row.profile_id
              : delegation.child_profile_id === row.profile_id));
      const exactLineageIsCoherent =
        (claim === undefined || (claim.project_id === row.project_id && claim.task_id === row.task_id)) &&
        (delegation === undefined || (delegation.project_id === row.project_id &&
          delegation.task_id === row.task_id &&
          (claim === undefined || (delegation.claim_id === claim.id && claim.delegation_id === delegation.id)))) &&
        (checkpoint === undefined || (claim !== undefined && checkpoint.claim_id === claim.id)) &&
        (submission === undefined || (claim !== undefined && checkpoint !== undefined &&
          submission.project_id === row.project_id && submission.task_id === row.task_id &&
          submission.claim_id === claim.id && submission.checkpoint_id === checkpoint.id)) &&
        (proposal === undefined || (proposal.project_id === row.project_id &&
          proposal.source_task_id === row.task_id &&
          (submission === undefined || submission.proposal_id === proposal.id)));
      const referencesAreExact = (() => {
        if (!coordinationEventReferencesAreApplicable({
          category: row.category as CoordinationEvent["category"],
          claimId: row.claim_id as string | null,
          delegationId: row.delegation_id as string | null,
          checkpointId: row.checkpoint_id as string | null,
          submissionId: row.submission_id as string | null,
          proposalId: row.proposal_id as string | null,
        })) return false;
        const noCheckpointSubmissionProposal = row.checkpoint_id === null &&
          row.submission_id === null && row.proposal_id === null;
        const exactClaimDelegation = claim !== undefined &&
          row.delegation_id === claim.delegation_id;
        switch (row.category) {
          case "ready_evaluation":
            return row.claim_id === null && row.delegation_id === null &&
              row.checkpoint_id === null && row.submission_id === null && row.proposal_id === null;
          case "claim":
          case "pause":
          case "release":
          case "switch":
            return exactClaimDelegation && noCheckpointSubmissionProposal;
          case "renewal":
            return claim !== undefined && row.delegation_id === null &&
              row.submission_id === null && row.proposal_id === null &&
              (row.checkpoint_id === null || checkpoint?.claim_id === claim.id);
          case "checkpoint":
            return claim !== undefined && checkpoint?.claim_id === claim.id &&
              row.delegation_id === null && row.submission_id === null && row.proposal_id === null;
          case "expiry":
            return noCheckpointSubmissionProposal && (
              (claim !== undefined && exactClaimDelegation) ||
              (claim === undefined && delegation !== undefined)
            );
          case "delegation_offer":
          case "delegation_accept":
          case "delegation_revoke":
            return delegation !== undefined && row.claim_id === null &&
              row.checkpoint_id === null && row.submission_id === null && row.proposal_id === null;
          case "submission":
          case "conflict":
          case "reconciliation":
            return claim !== undefined && checkpoint !== undefined && submission !== undefined &&
              proposal !== undefined && exactClaimDelegation;
          default:
            return false;
        }
      })();
      const transitionIsExact = hasExactCoordinationEventTransition(
        row.category as CoordinationEvent["category"],
        row.prior_state as string | null,
        row.resulting_state as string | null,
      );
      const linkedStateIsCoherent = (() => {
        const linkedSubmissions = claim === undefined
          ? []
          : submissionByClaim.get(claim.id as string) ?? [];
        switch (row.category) {
          case "pause":
            return claim?.state === "paused" && linkedSubmissions.length === 0;
          case "release":
            return claim?.state === "released" && (
              (row.prior_state === "active" && linkedSubmissions.length === 0) ||
              (row.prior_state === "submitted" && linkedSubmissions.length === 1 &&
                ["conflicted", "rejected", "withdrawn"].includes(
                  linkedSubmissions[0]?.state as string,
                ))
            );
          case "expiry":
            return claim !== undefined
              ? row.prior_state === "active" && claim.state === "expired" &&
                  linkedSubmissions.length === 0 &&
                  (delegation === undefined || delegation.state === "expired")
              : delegation?.state === "expired" &&
                  ["offered", "accepted", "claimed"].includes(row.prior_state as string);
          case "delegation_accept":
            return delegation !== undefined && delegation.accepted_at !== null;
          case "delegation_revoke":
            return delegation?.state === "revoked";
          case "conflict":
            return submission?.state === "conflicted";
          case "reconciliation":
            return claim?.state === "reconciled" && submission?.state === "accepted" &&
              (delegation === undefined || delegation.state === "completed");
          default:
            return true;
        }
      })();
      if (
        task?.project_id !== row.project_id ||
        !actorIsCoherent || !exactLineageIsCoherent || !referencesAreExact ||
        !transitionIsExact || !linkedStateIsCoherent ||
        !coordinationEventSchema.safeParse({
          id: row.id,
          category: row.category,
          projectId: row.project_id,
          taskId: row.task_id,
          profileId: row.profile_id,
          claimId: row.claim_id,
          delegationId: row.delegation_id,
          checkpointId: row.checkpoint_id,
          submissionId: row.submission_id,
          proposalId: row.proposal_id,
          priorState: row.prior_state,
          resultingState: row.resulting_state,
          projectRevision: row.project_revision,
          taskRevision: row.task_revision,
          detail: row.detail,
          createdAt: row.created_at,
        }).success
      ) markInvalid();
    }

    const countCategory = (
      rows: readonly Record<string, any>[] | undefined,
      categories: readonly string[],
    ): number => (rows ?? []).filter((row) => categories.includes(row.category as string)).length;
    for (const claim of claimRows) {
      const claimEvents = eventsForClaim.get(claim.id as string) ?? [];
      const linkedSubmissions = submissionByClaim.get(claim.id as string) ?? [];
      const initialSubmissionEvents = countCategory(claimEvents, ["submission", "conflict"]);
      const reconciliationEvents = countCategory(claimEvents, ["reconciliation"]);
      const pauseCount = countCategory(claimEvents, ["pause"]);
      const releaseCount = countCategory(claimEvents, ["release"]);
      const expiryCount = countCategory(claimEvents, ["expiry"]);
      const terminalCounts: Record<string, number> = {
        paused: pauseCount,
        released: releaseCount,
        expired: expiryCount,
      };
      const selectedSubmission = linkedSubmissions[0];
      if (linkedSubmissions.length > 1 || !selectedClaimHistoryIsCoherent({
        id: claim.id as string,
        delegationId: claim.delegation_id as string | null,
        state: claim.state,
        acquiredAt: claim.acquired_at as string,
        expiresAt: claim.expires_at as string,
        absoluteExpiresAt: claim.absolute_expires_at as string,
        endedAt: claim.ended_at as string | null,
      }, selectedSubmission === undefined ? null : {
        state: selectedSubmission.state,
        submittedAt: selectedSubmission.submitted_at as string,
        decidedAt: selectedSubmission.decided_at as string | null,
      }, semanticEvents)) markInvalid();
      if (countCategory(claimEvents, ["claim"]) !== 1) markInvalid();
      if (["active", "submitted", "reconciled"].includes(claim.state as string)) {
        if (pauseCount + releaseCount + expiryCount !== 0) markInvalid();
      } else if (terminalCounts[claim.state as string] !== 1 ||
        Object.entries(terminalCounts).some(([state, count]) => state !== claim.state && count !== 0)) {
        markInvalid();
      }
      switch (claim.state) {
        case "submitted":
        case "reconciled":
          if (linkedSubmissions.length !== 1 || initialSubmissionEvents !== 1) markInvalid();
          break;
        case "released":
          if (linkedSubmissions.length > 1 || initialSubmissionEvents !== linkedSubmissions.length ||
            (linkedSubmissions.length === 1 && ![
              "conflicted", "rejected", "withdrawn",
            ].includes(linkedSubmissions[0]?.state as string))) markInvalid();
          break;
        default:
          if (linkedSubmissions.length !== 0 || initialSubmissionEvents !== 0) markInvalid();
      }
      if (claim.state === "reconciled") {
        if (linkedSubmissions[0]?.state !== "accepted" || reconciliationEvents !== 1) markInvalid();
      } else if (reconciliationEvents !== 0) {
        markInvalid();
      }
    }
    for (const checkpoint of checkpointRows) {
      const claim = claimsById.get(checkpoint.claim_id as string);
      if (claim === undefined || !selectedCheckpointHistoryIsCoherent({
        id: checkpoint.id as string,
        claimId: checkpoint.claim_id as string,
        createdAt: checkpoint.created_at as string,
        projectRevision: checkpoint.project_revision as number,
        taskRevision: checkpoint.task_revision as number,
        contextPackId: checkpoint.context_pack_id as string,
      }, {
        id: claim.id as string,
        contextPackId: claim.context_pack_id as string,
        acquiredAt: claim.acquired_at as string,
        expiresAt: claim.expires_at as string,
        absoluteExpiresAt: claim.absolute_expires_at as string,
        endedAt: claim.ended_at as string | null,
      }, semanticEvents)) markInvalid();
      if (countCategory(eventsForCheckpoint.get(checkpoint.id as string), ["checkpoint"]) !== 1) {
        markInvalid();
      }
    }
    for (const submission of submissionRows) {
      const submissionEvents = eventsForSubmission.get(submission.id as string) ?? [];
      const proposal = proposalsById.get(submission.proposal_id as string);
      const authoritativeDecisionAt = submission.state === "submitted"
        ? null
        : (proposal?.updated_at as string | undefined) ?? null;
      if (!selectedSubmissionHistoryIsCoherent({
        id: submission.id as string,
        state: submission.state,
        submittedAt: submission.submitted_at as string,
        decidedAt: submission.decided_at as string | null,
      }, semanticEvents, authoritativeDecisionAt)) markInvalid();
      if (countCategory(submissionEvents, ["submission", "conflict"]) !== 1) markInvalid();
      const reconciliationEvents = countCategory(submissionEvents, ["reconciliation"]);
      if (submission.state === "accepted" ? reconciliationEvents !== 1 : reconciliationEvents !== 0) {
        markInvalid();
      }
    }
    for (const delegation of delegationRows) {
      const delegationEvents = eventsForDelegation.get(delegation.id as string) ?? [];
      const linkedClaim = delegation.claim_id === null
        ? undefined
        : claimsById.get(delegation.claim_id as string);
      const linkedSubmissions = linkedClaim === undefined
        ? []
        : submissionByClaim.get(linkedClaim.id as string) ?? [];
      if (!selectedDelegationHistoryIsCoherent({
        id: delegation.id as string,
        state: delegation.state,
        offeredAt: delegation.offered_at as string,
        deadline: delegation.deadline as string,
        acceptedAt: delegation.accepted_at as string | null,
        endedAt: delegation.ended_at as string | null,
        claimId: delegation.claim_id as string | null,
      }, semanticEvents, linkedClaim === undefined ? null : {
        id: linkedClaim.id as string,
        state: linkedClaim.state,
        acquiredAt: linkedClaim.acquired_at as string,
        expiresAt: linkedClaim.expires_at as string,
        absoluteExpiresAt: linkedClaim.absolute_expires_at as string,
        endedAt: linkedClaim.ended_at as string | null,
      }, linkedSubmissions.length === 1 ? {
        state: linkedSubmissions[0]!.state,
        submittedAt: linkedSubmissions[0]!.submitted_at as string,
        decidedAt: linkedSubmissions[0]!.decided_at as string | null,
      } : null)) markInvalid();
      if (countCategory(delegationEvents, ["delegation_offer"]) !== 1) markInvalid();
      const acceptCount = countCategory(delegationEvents, ["delegation_accept"]);
      if (delegation.accepted_at === null ? acceptCount !== 0 : acceptCount !== 1) markInvalid();
      const terminalCount = (() => {
        switch (delegation.state) {
          case "revoked":
            return countCategory(delegationEvents, ["delegation_revoke", "pause", "release"]);
          case "expired":
            return countCategory(delegationEvents, ["expiry"]);
          case "completed":
            return countCategory(delegationEvents, ["reconciliation"]);
          default:
            return countCategory(delegationEvents, [
              "delegation_revoke", "pause", "release", "expiry", "reconciliation",
            ]);
        }
      })();
      if (["revoked", "expired", "completed"].includes(delegation.state as string)
        ? terminalCount !== 1
        : terminalCount !== 0) markInvalid();
      if (delegation.claim_id !== null &&
        countCategory(delegationEvents, ["claim"]) !== 1) markInvalid();
    }

    const claimReferenceIsCoherent = (
      claim: Record<string, any>,
      replay: { profile_id: string; project_id: string },
    ): boolean => {
      const stored = claimsById.get(claim.id as string);
      return stored !== undefined &&
        claim.projectId === replay.project_id && claim.profileId === replay.profile_id &&
        claim.projectId === stored.project_id && claim.taskId === stored.task_id &&
        claim.profileId === stored.profile_id && claim.contextPackId === stored.context_pack_id &&
        claim.delegationId === stored.delegation_id;
    };
    const checkpointReferenceIsCoherent = (
      checkpoint: Record<string, any>,
      claimId: string,
    ): boolean => {
      const stored = checkpointsById.get(checkpoint.id as string);
      return stored !== undefined && checkpoint.claimId === claimId &&
        stored.claim_id === claimId && checkpoint.sequence === stored.sequence &&
        checkpoint.contextPackId === stored.context_pack_id;
    };
    const delegationReferenceIsCoherent = (
      delegation: Record<string, any>,
      replay: { profile_id: string; project_id: string },
      actor: "parent" | "child",
    ): boolean => {
      const stored = delegationsById.get(delegation.id as string);
      const actorProfile = actor === "parent"
        ? delegation.parentProfileId
        : delegation.childProfileId;
      return stored !== undefined && delegation.projectId === replay.project_id &&
        actorProfile === replay.profile_id && delegation.projectId === stored.project_id &&
        delegation.taskId === stored.task_id &&
        delegation.parentProfileId === stored.parent_profile_id &&
        delegation.childProfileId === stored.child_profile_id;
    };
    const submissionReferenceIsCoherent = (
      submission: Record<string, any>,
      replay: { profile_id: string; project_id: string },
    ): boolean => {
      const stored = submissionsById.get(submission.id as string);
      return stored !== undefined && submission.projectId === replay.project_id &&
        submission.profileId === replay.profile_id && submission.claimId === stored.claim_id &&
        submission.checkpointId === stored.checkpoint_id &&
        submission.proposalId === stored.proposal_id && submission.taskId === stored.task_id &&
        submission.contextPackId === stored.context_pack_id;
    };
    const proposalReferenceIsCoherent = (
      proposal: Record<string, any>,
      replay: { profile_id: string; project_id: string },
    ): boolean => {
      const stored = proposalsById.get(proposal.id as string);
      return stored !== undefined && proposal.projectId === replay.project_id &&
        proposal.origin?.type === "profile" &&
        proposal.origin.profileId === replay.profile_id &&
        proposal.sourceTaskId === stored.source_task_id;
    };

    const idempotencyRows = database.prepare(`
      SELECT profile_id, project_id, operation, request_hash, result_json, created_at
      FROM coordination_idempotency
      ORDER BY profile_id, project_id, operation, idempotency_key
    `).all() as {
      profile_id: string;
      project_id: string;
      operation: string;
      request_hash: string;
      result_json: string;
      created_at: string;
    }[];
    for (const row of idempotencyRows) {
      let result: Record<string, any>;
      try {
        const json = JSON.parse(row.result_json);
        switch (row.operation) {
          case coordinationIdempotencyOperations.claim:
            result = claimTaskResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.renew:
            result = renewClaimResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.checkpoint:
            result = checkpointResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.transition:
            result = transitionClaimResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.switch:
            result = switchTaskResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.createDelegation:
          case coordinationIdempotencyOperations.acceptDelegation:
          case coordinationIdempotencyOperations.revokeDelegation:
            result = delegationResultSchema.parse(json);
            break;
          case coordinationIdempotencyOperations.submit:
            result = submissionResultSchema.parse(json);
            break;
          default:
            throw new Error("Unsupported coordination replay operation");
        }
      } catch {
        addIssue(issues, "stored_json_invalid");
        markInvalid();
        continue;
      }

      let coherent = false;
      switch (row.operation) {
        case coordinationIdempotencyOperations.claim:
          coherent = claimReferenceIsCoherent(result.claim, row) &&
            result.readiness.task.id === result.claim.taskId &&
            result.readiness.task.projectId === row.project_id &&
            result.readiness.liveClaimId === null &&
            result.contextPack.id === result.claim.contextPackId &&
            result.contextPack.projectId === row.project_id &&
            result.contextPack.taskId === result.claim.taskId;
          break;
        case coordinationIdempotencyOperations.renew:
        case coordinationIdempotencyOperations.transition:
          coherent = claimReferenceIsCoherent(result.claim, row);
          break;
        case coordinationIdempotencyOperations.checkpoint:
          coherent = claimReferenceIsCoherent(result.claim, row) &&
            checkpointReferenceIsCoherent(result.checkpoint, result.claim.id);
          break;
        case coordinationIdempotencyOperations.switch:
          coherent = claimReferenceIsCoherent(result.previousClaim, row) &&
            claimReferenceIsCoherent(result.nextClaim, row) &&
            checkpointReferenceIsCoherent(result.checkpoint, result.previousClaim.id) &&
            result.contextPack.id === result.nextClaim.contextPackId &&
            result.contextPack.projectId === row.project_id &&
            result.contextPack.taskId === result.nextClaim.taskId;
          break;
        case coordinationIdempotencyOperations.createDelegation:
          coherent = delegationReferenceIsCoherent(result.delegation, row, "parent");
          coherent = coherent && result.delegation.state === "offered" &&
            result.delegation.acceptedAt === null && result.delegation.endedAt === null &&
            result.delegation.claimId === null;
          break;
        case coordinationIdempotencyOperations.revokeDelegation:
          coherent = delegationReferenceIsCoherent(result.delegation, row, "parent") &&
            result.delegation.state === "revoked" && result.delegation.endedAt !== null &&
            result.delegation.claimId === null;
          break;
        case coordinationIdempotencyOperations.acceptDelegation:
          coherent = delegationReferenceIsCoherent(result.delegation, row, "child");
          coherent = coherent && result.delegation.state === "accepted" &&
            result.delegation.acceptedAt !== null && result.delegation.endedAt === null &&
            result.delegation.claimId === null;
          break;
        case coordinationIdempotencyOperations.submit:
          coherent = claimReferenceIsCoherent(result.claim, row) &&
            submissionReferenceIsCoherent(result.submission, row) &&
            proposalReferenceIsCoherent(result.proposal, row) &&
            result.submission.claimId === result.claim.id &&
            result.submission.proposalId === result.proposal.id;
          break;
      }
      if (!coherent) markInvalid();
      if (!/^[a-f0-9]{64}$/.test(row.request_hash) || !isValidTimestamp(row.created_at)) {
        markInvalid();
      }
    }
  } catch {
    addIssue(issues, "schema_object_missing");
    markInvalid();
  }

  if (invalid) addIssue(issues, "coordination_state_invalid");
};

const runFullChecks = (
  database: IntentArcDatabase,
  schemaVersion: number,
  issues: IntegrityIssue[],
): void => {
  try {
    const integrityRows = database.pragma("integrity_check") as {
      integrity_check?: unknown;
    }[];
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      addIssue(issues, "integrity_check_failed");
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) {
      addIssue(issues, "foreign_key_violation");
    }
  } catch {
    addIssue(issues, "database_unreadable");
    return;
  }

  if (schemaVersion < 1 || schemaVersion > migrations.at(-1)!.version) return;

  if (schemaVersion >= 11) {
    try {
      const rows = database.prepare(`
        SELECT hierarchy_vocabulary_json FROM projects
      `).all() as { hierarchy_vocabulary_json: string }[];
      if (rows.some((row) => !parseJson(
        row.hierarchy_vocabulary_json,
        hierarchyVocabularySchema.parse,
      ))) {
        addIssue(issues, "stored_json_invalid");
      }
    } catch {
      addIssue(issues, "stored_json_invalid");
    }
  }

  try {
    const currentRecords = database.prepare(`
      SELECT
        id,
        project_id,
        kind,
        status,
        title,
        body,
        source_kind,
        source_ref,
        revision,
        created_at,
        updated_at
      FROM project_records
      ORDER BY id
    `).all() as {
      id: string;
      project_id: string;
      kind: string;
      status: string;
      title: string;
      body: string;
      source_kind: string;
      source_ref: string | null;
      revision: number;
      created_at: string;
      updated_at: string;
    }[];
    const recordsById = new Map(
      currentRecords.map((record) => [record.id, record] as const),
    );
    const snapshots = database.prepare(`
      SELECT record_id, revision, snapshot_json
      FROM project_record_revisions
      ORDER BY record_id, revision
    `).all() as {
      record_id: string;
      revision: number;
      snapshot_json: string;
    }[];
    const revisionsByRecord = new Map<string, number[]>();

    for (const row of snapshots) {
      const revisions = revisionsByRecord.get(row.record_id) ?? [];
      revisions.push(row.revision);
      revisionsByRecord.set(row.record_id, revisions);

      const current = recordsById.get(row.record_id);
      if (current === undefined) {
        addIssue(issues, "record_revision_mismatch");
      }

      let snapshot: ReturnType<typeof projectRecordSchema.parse> | undefined;
      try {
        snapshot = projectRecordSchema.parse(JSON.parse(row.snapshot_json));
      } catch {
        addIssue(issues, "revision_snapshot_invalid");
        continue;
      }

      if (
        current === undefined ||
        snapshot.id !== row.record_id ||
        snapshot.projectId !== current.project_id ||
        snapshot.revision !== row.revision
      ) {
        addIssue(issues, "record_revision_mismatch");
      }

      if (
        current !== undefined &&
        row.revision === current.revision &&
        (
          snapshot.id !== current.id ||
          snapshot.projectId !== current.project_id ||
          snapshot.kind !== current.kind ||
          snapshot.status !== current.status ||
          snapshot.title !== current.title ||
          snapshot.body !== current.body ||
          snapshot.sourceKind !== current.source_kind ||
          snapshot.sourceRef !== current.source_ref ||
          snapshot.revision !== current.revision ||
          snapshot.createdAt !== current.created_at ||
          snapshot.updatedAt !== current.updated_at
        )
      ) {
        addIssue(issues, "record_revision_mismatch");
      }
    }

    for (const record of currentRecords) {
      const revisions = revisionsByRecord.get(record.id) ?? [];
      if (
        revisions.length !== record.revision ||
        revisions.some((revision, index) => revision !== index + 1)
      ) {
        addIssue(issues, "record_revision_mismatch");
      }
    }

    const relationships = database.prepare(`
      SELECT record_relationships.id
      FROM record_relationships
      JOIN project_records AS from_records
        ON from_records.id = record_relationships.from_record_id
      JOIN project_records AS to_records
        ON to_records.id = record_relationships.to_record_id
      WHERE record_relationships.project_id <> from_records.project_id
         OR record_relationships.project_id <> to_records.project_id
         OR from_records.project_id <> to_records.project_id
    `).all();
    if (relationships.length > 0) addIssue(issues, "cross_project_relationship");

    const parentRelationships = database.prepare(`
      SELECT
        record_relationships.project_id,
        record_relationships.from_record_id,
        record_relationships.to_record_id,
        from_records.project_id AS from_project_id,
        to_records.project_id AS to_project_id,
        from_records.kind AS from_kind,
        to_records.kind AS to_kind
      FROM record_relationships
      JOIN project_records AS from_records
        ON from_records.id = record_relationships.from_record_id
      JOIN project_records AS to_records
        ON to_records.id = record_relationships.to_record_id
      WHERE record_relationships.kind = 'parent_of'
      ORDER BY
        record_relationships.project_id,
        record_relationships.from_record_id,
        record_relationships.to_record_id,
        record_relationships.id
    `).all() as StoredParentRelationship[];
    checkHierarchySemanticState(parentRelationships, issues);

    const contextPacks = database.prepare(`
      SELECT context_packs.content_json, context_packs.project_id, task_records.project_id AS task_project_id
      FROM context_packs
      LEFT JOIN project_records AS task_records ON task_records.id = context_packs.task_id
    `).all() as { content_json: string; project_id: string; task_project_id: string }[];
    for (const row of contextPacks) {
      if (row.project_id !== row.task_project_id) {
        addIssue(issues, "cross_project_context_pack");
      }
      if (!parseJson(row.content_json, taskContextPackSchema.parse)) {
        addIssue(issues, "stored_json_invalid");
      }
    }
  } catch {
    addIssue(issues, "schema_object_missing");
    return;
  }

  if (schemaVersion < 2) return;

  try {
    const proposals = database.prepare(`
      SELECT change_proposals.id
      FROM change_proposals
      LEFT JOIN project_records AS source_tasks
        ON source_tasks.id = change_proposals.source_task_id
      LEFT JOIN change_proposals AS predecessors
        ON predecessors.id = change_proposals.predecessor_proposal_id
      WHERE (change_proposals.source_task_id IS NOT NULL
             AND (
               source_tasks.id IS NULL
               OR source_tasks.project_id <> change_proposals.project_id
               OR source_tasks.kind <> 'task'
             ))
         OR (change_proposals.predecessor_proposal_id IS NOT NULL
             AND (
               predecessors.id IS NULL
               OR predecessors.project_id <> change_proposals.project_id
             ))
    `).all();
    if (proposals.length > 0) addIssue(issues, "cross_project_governance_reference");

    const operations = database.prepare(`
      SELECT
        proposal_id, position, operation_id, operation_type,
        expected_record_revision, payload_json
      FROM proposal_operations
      ORDER BY proposal_id, position
    `).all() as {
      proposal_id: string;
      position: number;
      operation_id: string;
      operation_type: string;
      expected_record_revision: number | null;
      payload_json: string;
    }[];
    const positions = new Map<string, number>();
    const proposalOperationCounts = new Map<string, number>();
    const parsedOperationsByProposal = new Map<
      string,
      ReturnType<typeof changeOperationSchema.parse>[]
    >();
    const proposalsWithInvalidOperationRows = new Set<string>();
    for (const row of operations) {
      const expectedPosition = positions.get(row.proposal_id) ?? 0;
      positions.set(row.proposal_id, expectedPosition + 1);
      proposalOperationCounts.set(
        row.proposal_id,
        (proposalOperationCounts.get(row.proposal_id) ?? 0) + 1,
      );
      let operation: ReturnType<typeof changeOperationSchema.parse> | null = null;
      try {
        operation = changeOperationSchema.parse(JSON.parse(row.payload_json));
      } catch {
        if (schemaVersion >= 8) {
          addIssue(issues, "proposal_operation_invalid");
        } else {
          addIssue(issues, "stored_json_invalid");
        }
      }
      const expectedRecordRevision = operation?.type === "update_record"
        ? operation.expectedRecordRevision
        : null;
      const rowIsValid = row.position === expectedPosition &&
        operation !== null &&
        row.operation_id === operation.operationId &&
        row.operation_type === operation.type &&
        row.expected_record_revision === expectedRecordRevision;
      if (
        schemaVersion >= 8 &&
        !rowIsValid
      ) {
        addIssue(issues, "proposal_operation_invalid");
        proposalsWithInvalidOperationRows.add(row.proposal_id);
      } else if (schemaVersion >= 8 && operation !== null) {
        const proposalOperations = parsedOperationsByProposal.get(
          row.proposal_id,
        ) ?? [];
        proposalOperations.push(operation);
        parsedOperationsByProposal.set(row.proposal_id, proposalOperations);
      }
    }

    if (schemaVersion >= 8) {
      for (const [proposalId, proposalOperations] of parsedOperationsByProposal) {
        if (
          !proposalsWithInvalidOperationRows.has(proposalId) &&
          !changeOperationsSchema.safeParse(proposalOperations).success
        ) {
          addIssue(issues, "proposal_operation_invalid");
        }
      }
    }

    if (schemaVersion >= 8) {
      const proposalRows = database.prepare(`
        SELECT
          proposals.id, proposals.project_id, proposals.origin_type,
          proposals.profile_id, proposals.repository_snapshot_id,
          proposals.idempotency_key, proposals.request_hash,
          proposals.source_task_id, proposals.predecessor_proposal_id,
          proposals.state, profiles.id AS existing_profile_id,
          snapshots.id AS existing_snapshot_id,
          snapshots.project_id AS snapshot_project_id,
          snapshots.state AS snapshot_state
        FROM change_proposals AS proposals
        LEFT JOIN client_profiles AS profiles
          ON profiles.id = proposals.profile_id
        LEFT JOIN repository_snapshots AS snapshots
          ON snapshots.id = proposals.repository_snapshot_id
        ORDER BY proposals.id
      `).all() as {
        id: string;
        project_id: string;
        origin_type: string;
        profile_id: string | null;
        repository_snapshot_id: string | null;
        idempotency_key: string | null;
        request_hash: string | null;
        source_task_id: string | null;
        predecessor_proposal_id: string | null;
        state: string;
        existing_profile_id: string | null;
        existing_snapshot_id: string | null;
        snapshot_project_id: string | null;
        snapshot_state: string | null;
      }[];
      for (const proposal of proposalRows) {
        const profileOrigin = proposal.origin_type === "profile" &&
          proposal.profile_id !== null &&
          proposal.existing_profile_id === proposal.profile_id &&
          proposal.repository_snapshot_id === null &&
          proposal.idempotency_key !== null &&
          proposal.request_hash !== null;
        const refreshOrigin = proposal.origin_type === "repository_refresh" &&
          proposal.profile_id === null &&
          proposal.repository_snapshot_id !== null &&
          proposal.idempotency_key === null &&
          proposal.request_hash === null &&
          proposal.source_task_id === null &&
          proposal.predecessor_proposal_id === null;
        if (!profileOrigin && !refreshOrigin) {
          addIssue(issues, "proposal_origin_invalid");
        }
        if (refreshOrigin) {
          if (
            proposal.existing_snapshot_id !== null &&
            proposal.snapshot_project_id !== proposal.project_id
          ) {
            addIssue(issues, "proposal_project_invalid");
          }
          if (
            proposal.existing_snapshot_id === null ||
            (proposal.state === "pending" &&
              proposal.snapshot_state !== "candidate")
          ) {
            addIssue(issues, "proposal_snapshot_invalid");
          }
        }
        if ((proposalOperationCounts.get(proposal.id) ?? 0) === 0) {
          addIssue(issues, "proposal_operation_invalid");
        }
      }
    }

    const results = database.prepare(
      "SELECT result_json FROM idempotency_results ORDER BY profile_id, project_id, idempotency_key",
    ).all() as { result_json: string }[];
    for (const row of results) {
      try {
        parseStoredSubmissionResult(row.result_json);
      } catch {
        addIssue(issues, "stored_json_invalid");
      }
    }

    if (schemaVersion >= 9) {
      const humanChangeResults = database.prepare(`
        SELECT
          project_id, operation_scope, idempotency_key, request_hash,
          result_json, created_at
        FROM human_change_idempotency_results
        ORDER BY project_id, operation_scope, idempotency_key
      `).all() as {
        project_id: string;
        operation_scope: string;
        idempotency_key: string;
        request_hash: string;
        result_json: string;
        created_at: string;
      }[];
      for (const row of humanChangeResults) {
        try {
          if (
            !isValidTimestamp(row.created_at)
          ) {
            throw new Error("Stored human change replay metadata is invalid");
          }
          parseStoredHumanChangeReplay({
            projectId: row.project_id,
            operationScope: row.operation_scope,
            idempotencyKey: row.idempotency_key,
            requestHash: row.request_hash,
            resultJson: row.result_json,
          });
        } catch {
          addIssue(issues, "stored_json_invalid");
        }
      }
    }

    const invalidProfiles = database.prepare(
      "SELECT id FROM client_profiles WHERE token_hash GLOB '*[^a-f0-9]*' OR length(token_hash) <> 64",
    ).all();
    if (invalidProfiles.length > 0) addIssue(issues, "credential_hash_invalid");
  } catch {
    addIssue(issues, "schema_object_missing");
  }

  if (schemaVersion >= 4) {
    checkOutboundSemanticState(database, issues);
  }
  if (schemaVersion >= 5) {
    checkRepositoryImportSemanticState(database, issues);
  }
  if (schemaVersion >= 7) {
    checkRepositoryIndexSemanticState(database, issues);
  }
  if (schemaVersion >= 10) {
    checkCoordinationSemanticState(database, issues);
  }
};

export const createIntegrityChecker = (options: { now?: () => string } = {}): IntegrityChecker => {
  const now = options.now ?? (() => new Date().toISOString());
  const checkConnection = (database: IntentArcDatabase, level: IntegrityLevel): IntegrityReport => {
    const issues: IntegrityIssue[] = [];
    let schemaVersion: number | null = null;
    let storeId: string | null = null;
    try {
      const schema = checkSchema(database, issues);
      schemaVersion = schema.schemaVersion;
      storeId = schema.storeId;
      if (level === "full" && schemaVersion !== null) {
        runFullChecks(database, schemaVersion, issues);
      }
    } catch {
      addIssue(issues, "database_unreadable");
    }
    return checkedAtReport(level, now, storeId, schemaVersion, issues);
  };

  return {
    checkPath(path, level) {
      let database: IntentArcDatabase | undefined;
      try {
        database = new Database(canonicalDatabasePath(path), {
          readonly: true,
          fileMustExist: true,
        });
        return checkConnection(database, level);
      } catch {
        return checkedAtReport(
          level,
          now,
          null,
          null,
          [createIntegrityIssue("database_unreadable")],
        );
      } finally {
        database?.close();
      }
    },
    checkConnection,
  };
};
