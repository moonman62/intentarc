import type { IntentArcDatabase } from "./database.js";

export interface Migration {
  readonly version: number;
  readonly sql: string;
  readonly initialize?: (
    database: IntentArcDatabase,
    context: { storeId: string; now: string },
  ) => void;
}

export const repositoryImportReceiptsTableSql = `
  CREATE TABLE repository_import_receipts (
    manifest_digest TEXT NOT NULL PRIMARY KEY
      CHECK (
        length(manifest_digest) = 64
        AND manifest_digest NOT GLOB '*[^0-9a-f]*'
      ),
    project_id TEXT NOT NULL UNIQUE
      CHECK (
        length(trim(project_id)) > 0
        AND project_id = trim(project_id)
      )
      REFERENCES projects(id) ON DELETE RESTRICT,
    repository_fingerprint TEXT NOT NULL
      CHECK (
        length(repository_fingerprint) = 64
        AND repository_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
    scanner_version TEXT NOT NULL
      CHECK (
        length(trim(scanner_version)) > 0
        AND scanner_version = trim(scanner_version)
      ),
    ruleset_version TEXT NOT NULL
      CHECK (
        length(trim(ruleset_version)) > 0
        AND ruleset_version = trim(ruleset_version)
      ),
    manifest_version INTEGER NOT NULL
      CHECK (
        typeof(manifest_version) = 'integer'
        AND manifest_version = 1
      ),
    record_count INTEGER NOT NULL
      CHECK (
        typeof(record_count) = 'integer'
        AND record_count >= 0
      ),
    relationship_count INTEGER NOT NULL
      CHECK (
        typeof(relationship_count) = 'integer'
        AND relationship_count >= 0
      ),
    initial_snapshot_digest TEXT NOT NULL
      CHECK (
        length(initial_snapshot_digest) = 64
        AND initial_snapshot_digest NOT GLOB '*[^0-9a-f]*'
      ),
    initial_snapshot_json TEXT NOT NULL
      CHECK (
        json_valid(initial_snapshot_json)
        AND json_type(initial_snapshot_json) = 'object'
      ),
    created_at TEXT NOT NULL
      CHECK (
        length(trim(created_at)) > 0
        AND created_at = trim(created_at)
      )
  )
`;

export const repositoryImportReceiptsNoUpdateTriggerSql = `
  CREATE TRIGGER repository_import_receipts_no_update
  BEFORE UPDATE ON repository_import_receipts
  BEGIN
    SELECT RAISE(ABORT, 'repository import receipts are append-only');
  END
`;

export const repositoryImportReceiptsNoDeleteTriggerSql = `
  CREATE TRIGGER repository_import_receipts_no_delete
  BEFORE DELETE ON repository_import_receipts
  BEGIN
    SELECT RAISE(ABORT, 'repository import receipts are append-only');
  END
`;

export const changeProposalsTableSql = `
  CREATE TABLE change_proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    profile_id TEXT REFERENCES client_profiles(id),
    source_task_id TEXT,
    predecessor_proposal_id TEXT REFERENCES change_proposals(id),
    base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'accepted', 'rejected', 'conflicted', 'withdrawn')
    ),
    rationale TEXT NOT NULL,
    idempotency_key TEXT,
    request_hash TEXT,
    review_reason TEXT,
    reviewer_actor TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    origin_type TEXT NOT NULL CHECK (
      origin_type IN ('profile', 'repository_refresh')
    ),
    repository_snapshot_id TEXT,
    CHECK (
      (origin_type = 'profile'
        AND profile_id IS NOT NULL
        AND repository_snapshot_id IS NULL
        AND idempotency_key IS NOT NULL
        AND request_hash IS NOT NULL)
      OR
      (origin_type = 'repository_refresh'
        AND profile_id IS NULL
        AND repository_snapshot_id IS NOT NULL
        AND idempotency_key IS NULL
        AND request_hash IS NULL
        AND source_task_id IS NULL
        AND predecessor_proposal_id IS NULL)
    ),
    FOREIGN KEY (repository_snapshot_id, project_id)
      REFERENCES repository_snapshots(id, project_id) ON DELETE RESTRICT
  )
`;

export const proposalOperationsTableSql = `
  CREATE TABLE proposal_operations (
    proposal_id TEXT NOT NULL
      REFERENCES change_proposals(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    operation_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    expected_record_revision INTEGER CHECK (
      expected_record_revision IS NULL OR expected_record_revision > 0
    ),
    payload_json TEXT NOT NULL,
    PRIMARY KEY (proposal_id, position),
    UNIQUE (proposal_id, operation_id)
  )
`;

export const proposalOperationsNoUpdateTriggerSql = `
  CREATE TRIGGER proposal_operations_no_update
  BEFORE UPDATE ON proposal_operations
  BEGIN
    SELECT RAISE(ABORT, 'proposal operations are immutable');
  END
`;

export const proposalOperationsNoDeleteTriggerSql = `
  CREATE TRIGGER proposal_operations_no_delete
  BEFORE DELETE ON proposal_operations
  WHEN EXISTS (
    SELECT 1 FROM change_proposals WHERE id = OLD.proposal_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'proposal operations are immutable');
  END
`;

export const humanChangeIdempotencyResultsTableSql = `
  CREATE TABLE human_change_idempotency_results (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    operation_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, operation_scope, idempotency_key)
  )
`;

export const changeProposalsProjectStateIndexSql = `
  CREATE INDEX idx_change_proposals_project_state_created_at
    ON change_proposals(project_id, state, created_at)
`;

export const changeProposalsProfileIdempotencyIndexSql = `
  CREATE UNIQUE INDEX idx_change_proposals_profile_idempotency
    ON change_proposals(profile_id, project_id, idempotency_key)
    WHERE origin_type = 'profile'
`;

export const changeProposalsRepositorySnapshotIndexSql = `
  CREATE UNIQUE INDEX idx_change_proposals_repository_snapshot
    ON change_proposals(repository_snapshot_id)
    WHERE origin_type = 'repository_refresh'
`;

export const taskClaimsTableSql = `
  CREATE TABLE task_claims (
    id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE RESTRICT,
    delegation_id TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('active', 'paused', 'released', 'submitted', 'expired', 'reconciled')
    ),
    base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
    base_task_revision INTEGER NOT NULL CHECK (base_task_revision > 0),
    context_pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE RESTRICT,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    ended_at TEXT,
    latest_checkpoint_id TEXT,
    CHECK (expires_at <= absolute_expires_at),
    FOREIGN KEY (task_id, project_id)
      REFERENCES project_records(id, project_id) ON DELETE RESTRICT
  )
`;

export const taskCheckpointsTableSql = `
  CREATE TABLE task_checkpoints (
    id TEXT NOT NULL PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES task_claims(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    document_json TEXT NOT NULL CHECK (
      json_valid(document_json)
      AND json_type(document_json) = 'object'
      AND length(CAST(document_json AS BLOB)) <= 65536
    ),
    created_at TEXT NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    context_pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE RESTRICT,
    UNIQUE (claim_id, sequence)
  )
`;

export const taskDelegationsTableSql = `
  CREATE TABLE task_delegations (
    id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    parent_profile_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE RESTRICT,
    child_profile_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (
      state IN ('offered', 'accepted', 'revoked', 'expired', 'claimed', 'completed')
    ),
    base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
    base_task_revision INTEGER NOT NULL CHECK (base_task_revision > 0),
    scope_json TEXT NOT NULL CHECK (
      json_valid(scope_json)
      AND json_type(scope_json) = 'object'
      AND length(CAST(scope_json AS BLOB)) <= 32768
    ),
    allowed_outputs_json TEXT NOT NULL CHECK (
      json_valid(allowed_outputs_json)
      AND json_type(allowed_outputs_json) = 'array'
      AND length(CAST(allowed_outputs_json AS BLOB)) <= 32768
    ),
    offered_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    accepted_at TEXT,
    ended_at TEXT,
    claim_id TEXT REFERENCES task_claims(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, project_id)
      REFERENCES project_records(id, project_id) ON DELETE RESTRICT
  )
`;

export const taskSubmissionsTableSql = `
  CREATE TABLE task_submissions (
    id TEXT NOT NULL PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES task_claims(id) ON DELETE RESTRICT,
    checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
    profile_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES project_records(id) ON DELETE RESTRICT,
    base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
    base_task_revision INTEGER NOT NULL CHECK (base_task_revision > 0),
    context_pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE RESTRICT,
    document_json TEXT NOT NULL CHECK (
      json_valid(document_json)
      AND json_type(document_json) = 'object'
      AND length(CAST(document_json AS BLOB)) <= 262144
    ),
    proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (
      state IN ('submitted', 'conflicted', 'accepted', 'rejected', 'withdrawn')
    ),
    submitted_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE (proposal_id),
    CHECK (
      (state = 'submitted' AND decided_at IS NULL)
      OR (state IN ('conflicted', 'accepted', 'rejected', 'withdrawn')
          AND decided_at IS NOT NULL)
    )
  )
`;

export const coordinationEventsTableSql = `
  CREATE TABLE coordination_events (
    id TEXT NOT NULL PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN (
      'ready_evaluation', 'claim', 'renewal', 'checkpoint', 'pause', 'release',
      'switch', 'expiry', 'delegation_offer', 'delegation_accept',
      'delegation_revoke', 'submission', 'conflict', 'reconciliation'
    )),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL,
    profile_id TEXT,
    claim_id TEXT,
    delegation_id TEXT,
    checkpoint_id TEXT,
    submission_id TEXT,
    proposal_id TEXT,
    prior_state TEXT,
    resulting_state TEXT,
    project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    detail TEXT,
    created_at TEXT NOT NULL
  )
`;

export const coordinationIdempotencyTableSql = `
  CREATE TABLE coordination_idempotency (
    profile_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, project_id, operation, idempotency_key),
    FOREIGN KEY (profile_id, project_id)
      REFERENCES profile_project_authorities(profile_id, project_id)
      ON DELETE RESTRICT
  )
`;

export const taskClaimsOneActiveIndexSql = `
  CREATE UNIQUE INDEX idx_task_claims_one_active
    ON task_claims(task_id) WHERE state = 'active'
`;

export const taskClaimsOneSubmittedIndexSql = `
  CREATE UNIQUE INDEX idx_task_claims_one_submitted
    ON task_claims(task_id) WHERE state = 'submitted'
`;

export const taskDelegationsOneLiveIndexSql = `
  CREATE UNIQUE INDEX idx_task_delegations_one_live
    ON task_delegations(task_id)
    WHERE state IN ('offered', 'accepted', 'claimed')
`;

export const taskCheckpointsNoUpdateTriggerSql = `
  CREATE TRIGGER task_checkpoints_no_update
  BEFORE UPDATE ON task_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'task checkpoints are append-only');
  END
`;

export const taskCheckpointsNoDeleteTriggerSql = `
  CREATE TRIGGER task_checkpoints_no_delete
  BEFORE DELETE ON task_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'task checkpoints are append-only');
  END
`;

export const taskSubmissionsImmutableFieldsTriggerSql = `
  CREATE TRIGGER task_submissions_immutable_fields
  BEFORE UPDATE ON task_submissions
  WHEN NEW.id IS NOT OLD.id
    OR NEW.claim_id IS NOT OLD.claim_id
    OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
    OR NEW.profile_id IS NOT OLD.profile_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.task_id IS NOT OLD.task_id
    OR NEW.base_project_revision IS NOT OLD.base_project_revision
    OR NEW.base_task_revision IS NOT OLD.base_task_revision
    OR NEW.context_pack_id IS NOT OLD.context_pack_id
    OR NEW.document_json IS NOT OLD.document_json
    OR NEW.proposal_id IS NOT OLD.proposal_id
    OR NEW.submitted_at IS NOT OLD.submitted_at
    OR NOT (
      OLD.state = 'submitted'
      AND NEW.state IN ('accepted', 'rejected', 'conflicted', 'withdrawn')
      AND NEW.decided_at IS NOT NULL
    )
  BEGIN
    SELECT RAISE(ABORT, 'task submission payload is immutable');
  END
`;

export const taskSubmissionsNoDeleteTriggerSql = `
  CREATE TRIGGER task_submissions_no_delete
  BEFORE DELETE ON task_submissions
  BEGIN
    SELECT RAISE(ABORT, 'task submissions are durable');
  END
`;

export const coordinationEventsNoUpdateTriggerSql = `
  CREATE TRIGGER coordination_events_no_update
  BEFORE UPDATE ON coordination_events
  BEGIN
    SELECT RAISE(ABORT, 'coordination events are append-only');
  END
`;

export const coordinationEventsNoDeleteTriggerSql = `
  CREATE TRIGGER coordination_events_no_delete
  BEFORE DELETE ON coordination_events
  BEGIN
    SELECT RAISE(ABORT, 'coordination events are append-only');
  END
`;

export const coordinationProposalStateSyncTriggerSql = `
  CREATE TRIGGER coordination_proposal_state_sync
  AFTER UPDATE OF state ON change_proposals
  WHEN NEW.state <> OLD.state
  BEGIN
    UPDATE task_submissions
      SET state = CASE NEW.state
        WHEN 'accepted' THEN 'accepted'
        WHEN 'rejected' THEN 'rejected'
        WHEN 'conflicted' THEN 'conflicted'
        WHEN 'withdrawn' THEN 'withdrawn'
        ELSE state END,
        decided_at = CASE WHEN NEW.state = 'pending' THEN NULL ELSE NEW.updated_at END
      WHERE proposal_id = NEW.id;
    UPDATE task_claims SET state = 'reconciled', ended_at = NEW.updated_at
      WHERE id IN (SELECT claim_id FROM task_submissions WHERE proposal_id = NEW.id)
        AND NEW.state = 'accepted';
    UPDATE task_delegations SET state = 'completed', ended_at = NEW.updated_at
      WHERE state = 'claimed'
        AND NEW.state = 'accepted'
        AND EXISTS (
          SELECT 1
          FROM task_submissions
          JOIN task_claims ON task_claims.id = task_submissions.claim_id
          WHERE task_submissions.proposal_id = NEW.id
            AND task_claims.delegation_id = task_delegations.id
            AND task_delegations.claim_id = task_claims.id
        );
  END
`;

const schemaEightChangeProposalsTableSql = changeProposalsTableSql
  .replace("CREATE TABLE change_proposals", "CREATE TABLE change_proposals_v8")
  .replace(
    "REFERENCES change_proposals(id)",
    "REFERENCES change_proposals_v8(id)",
  );

const schemaEightProposalOperationsTableSql = proposalOperationsTableSql
  .replace("CREATE TABLE proposal_operations", "CREATE TABLE proposal_operations_v8")
  .replace(
    "REFERENCES change_proposals(id)",
    "REFERENCES change_proposals_v8(id)",
  );

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        primary_repository_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_record_revisions (
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, revision)
      );

      CREATE TABLE record_relationships (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_record_id TEXT NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
        to_record_id TEXT NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (from_record_id, to_record_id, kind),
        CHECK (from_record_id <> to_record_id)
      );

      CREATE TABLE context_packs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
        project_revision INTEGER NOT NULL,
        budget_tokens INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_records_project_kind_status
        ON project_records(project_id, kind, status);
      CREATE INDEX idx_relationships_from ON record_relationships(from_record_id);
      CREATE INDEX idx_relationships_to ON record_relationships(to_record_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE client_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        token_rotated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE profile_project_authorities (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (
          mode IN ('proposal', 'scoped_direct', 'full_direct')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (profile_id, project_id)
      );

      CREATE TABLE profile_scopes (
        id TEXT PRIMARY KEY,
        authority_id TEXT NOT NULL
          REFERENCES profile_project_authorities(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        record_kind TEXT,
        from_record_kind TEXT,
        to_record_kind TEXT,
        relationship_kind TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE change_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES client_profiles(id),
        source_task_id TEXT,
        predecessor_proposal_id TEXT REFERENCES change_proposals(id),
        base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'accepted', 'rejected', 'conflicted', 'withdrawn')
        ),
        rationale TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        review_reason TEXT,
        reviewer_actor TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE (profile_id, project_id, idempotency_key)
      );

      CREATE TABLE proposal_operations (
        proposal_id TEXT NOT NULL
          REFERENCES change_proposals(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        expected_record_revision INTEGER CHECK (
          expected_record_revision IS NULL OR expected_record_revision > 0
        ),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (proposal_id, position),
        UNIQUE (proposal_id, operation_id)
      );

      CREATE TABLE idempotency_results (
        profile_id TEXT NOT NULL REFERENCES client_profiles(id),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        change_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, project_id, idempotency_key)
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        actor_type TEXT NOT NULL,
        profile_id TEXT,
        authority_mode TEXT,
        scope_decision TEXT,
        action_category TEXT NOT NULL,
        target_id TEXT,
        idempotency_key TEXT,
        revision_before INTEGER,
        revision_after INTEGER,
        outcome TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;

      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;

      CREATE INDEX idx_profile_project_authorities_profile_project
        ON profile_project_authorities(profile_id, project_id);
      CREATE INDEX idx_change_proposals_project_state_created_at
        ON change_proposals(project_id, state, created_at);
      CREATE INDEX idx_audit_events_project_created_at
        ON audit_events(project_id, created_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `,
    initialize(database, context) {
      database.prepare(`
        INSERT INTO store_metadata (singleton, store_id, created_at)
        VALUES (1, ?, ?)
      `).run(context.storeId, context.now);
    },
  },
  {
    version: 4,
    sql: `
      CREATE TABLE outbound_destinations (
        destination_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        profile_id TEXT NOT NULL REFERENCES client_profiles(id),
        client_label TEXT NOT NULL,
        destination_type TEXT NOT NULL CHECK (
          destination_type IN ('local_model','direct_provider','gateway','ide_managed','unknown')
        ),
        provider_label TEXT NOT NULL,
        model_label TEXT,
        account_boundary_label TEXT,
        data_boundary TEXT NOT NULL CHECK (
          data_boundary IN ('local','remote','mixed','unknown')
        ),
        status TEXT NOT NULL CHECK (status IN ('enabled','disabled')),
        is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (destination_id, revision),
        UNIQUE (profile_id, revision)
      );

      CREATE UNIQUE INDEX idx_outbound_destinations_current_profile
        ON outbound_destinations(profile_id) WHERE is_current = 1;

      CREATE TABLE outbound_policies (
        profile_id TEXT NOT NULL REFERENCES client_profiles(id),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL,
        destination_revision INTEGER NOT NULL CHECK (destination_revision > 0),
        detector_version TEXT NOT NULL,
        safety_policy_version TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('manual','auto_release_clean')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          profile_id, project_id, destination_id, destination_revision,
          detector_version, safety_policy_version
        ),
        FOREIGN KEY (destination_id, destination_revision)
          REFERENCES outbound_destinations(destination_id, revision)
      );

      CREATE TABLE outbound_requests (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES client_profiles(id),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES project_records(id),
        source_pack_id TEXT NOT NULL REFERENCES context_packs(id),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        destination_id TEXT NOT NULL,
        destination_revision INTEGER NOT NULL CHECK (destination_revision > 0),
        destination_snapshot_json TEXT NOT NULL,
        detector_version TEXT NOT NULL,
        safety_policy_version TEXT NOT NULL,
        candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
        status TEXT NOT NULL CHECK (
          status IN ('review_required','released','denied')
        ),
        finding_counts_json TEXT NOT NULL,
        decision_actor TEXT,
        decision_reason TEXT,
        release_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE (profile_id, idempotency_key),
        FOREIGN KEY (destination_id, destination_revision)
          REFERENCES outbound_destinations(destination_id, revision)
      );

      CREATE TABLE outbound_findings (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES outbound_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        detector_id TEXT NOT NULL,
        detector_version TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('high','possible')),
        severity TEXT NOT NULL CHECK (severity IN ('credential','sensitive')),
        field_path TEXT NOT NULL,
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        finding_key TEXT NOT NULL CHECK (length(finding_key) = 64),
        required_action TEXT NOT NULL CHECK (
          required_action IN ('forced_redact','redact_by_default')
        ),
        decision TEXT CHECK (decision IS NULL OR decision IN ('redact','include_once')),
        UNIQUE (request_id, ordinal),
        UNIQUE (request_id, finding_key)
      );

      CREATE TABLE outbound_releases (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES outbound_requests(id),
        source_pack_id TEXT NOT NULL REFERENCES context_packs(id),
        content_json TEXT NOT NULL,
        disclosure_json TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        released_at TEXT NOT NULL
      );

      CREATE TRIGGER outbound_releases_no_update
      BEFORE UPDATE ON outbound_releases
      BEGIN
        SELECT RAISE(ABORT, 'outbound releases are immutable');
      END;

      CREATE TRIGGER outbound_releases_no_delete
      BEFORE DELETE ON outbound_releases
      BEGIN
        SELECT RAISE(ABORT, 'outbound releases are immutable');
      END;

      CREATE INDEX idx_outbound_requests_profile_created_at
        ON outbound_requests(profile_id, created_at DESC);
      CREATE INDEX idx_outbound_requests_project_status_created_at
        ON outbound_requests(project_id, status, created_at DESC);
      CREATE INDEX idx_outbound_findings_request_ordinal
        ON outbound_findings(request_id, ordinal);
      CREATE INDEX idx_outbound_policies_lookup
        ON outbound_policies(
          profile_id, project_id, destination_id, destination_revision,
          detector_version, safety_policy_version
        );
    `,
  },
  {
    version: 5,
    sql: `
      ${repositoryImportReceiptsTableSql};
      ${repositoryImportReceiptsNoUpdateTriggerSql};
      ${repositoryImportReceiptsNoDeleteTriggerSql};
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE client_profiles
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe'
        CHECK (execution_mode IN ('safe','trusted','custom'));
    `,
  },
  {
    version: 7,
    sql: `
      CREATE UNIQUE INDEX idx_project_records_id_project
        ON project_records(id, project_id);

      CREATE TABLE repository_sources (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(trim(id)) > 0 AND id = trim(id)),
        project_id TEXT NOT NULL UNIQUE
          CHECK (length(trim(project_id)) > 0 AND project_id = trim(project_id))
          REFERENCES projects(id) ON DELETE CASCADE,
        root TEXT NOT NULL
          CHECK (length(trim(root)) > 0 AND root = trim(root)),
        canonical_subpath TEXT
          CHECK (
            canonical_subpath IS NULL OR (
              length(canonical_subpath) > 0
              AND canonical_subpath = trim(canonical_subpath)
              AND canonical_subpath NOT LIKE '/%'
              AND canonical_subpath NOT LIKE '%\\%'
              AND canonical_subpath NOT LIKE '%//%'
              AND canonical_subpath NOT GLOB '[A-Za-z]:*'
              AND ('/' || canonical_subpath || '/') NOT LIKE '%/./%'
              AND ('/' || canonical_subpath || '/') NOT LIKE '%/../%'
            )
          ),
        repository_identity TEXT NOT NULL
          CHECK (
            length(trim(repository_identity)) > 0
            AND repository_identity = trim(repository_identity)
          ),
        status TEXT NOT NULL
          CHECK (status IN ('available','unavailable','detached')),
        current_snapshot_id TEXT,
        created_at TEXT NOT NULL
          CHECK (length(trim(created_at)) > 0 AND created_at = trim(created_at)),
        updated_at TEXT NOT NULL
          CHECK (length(trim(updated_at)) > 0 AND updated_at = trim(updated_at)),
        UNIQUE (id, project_id),
        FOREIGN KEY (current_snapshot_id, id)
          REFERENCES repository_snapshots(id, source_id)
      );

      CREATE TABLE repository_snapshots (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(trim(id)) > 0 AND id = trim(id)),
        source_id TEXT NOT NULL
          CHECK (length(trim(source_id)) > 0 AND source_id = trim(source_id))
          REFERENCES repository_sources(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL
          CHECK (length(trim(project_id)) > 0 AND project_id = trim(project_id))
          REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL
          CHECK (state IN ('candidate','accepted','discarded')),
        base_snapshot_id TEXT,
        base_project_revision INTEGER NOT NULL
          CHECK (
            typeof(base_project_revision) = 'integer'
            AND base_project_revision >= 0
          ),
        branch TEXT
          CHECK (
            branch IS NULL OR (
              length(trim(branch)) > 0
              AND branch = trim(branch)
            )
          ),
        head TEXT
          CHECK (
            head IS NULL OR (
              length(head) BETWEEN 40 AND 64
              AND head NOT GLOB '*[^0-9a-f]*'
            )
          ),
        fingerprint TEXT NOT NULL
          CHECK (
            length(fingerprint) = 64
            AND fingerprint NOT GLOB '*[^0-9a-f]*'
          ),
        scanner_version TEXT NOT NULL
          CHECK (
            length(trim(scanner_version)) > 0
            AND scanner_version = trim(scanner_version)
          ),
        ruleset_version TEXT NOT NULL
          CHECK (
            length(trim(ruleset_version)) > 0
            AND ruleset_version = trim(ruleset_version)
          ),
        warning_counts_json TEXT NOT NULL
          CHECK (
            json_valid(warning_counts_json)
            AND json_type(warning_counts_json) = 'object'
          ),
        exclusion_counts_json TEXT NOT NULL
          CHECK (
            json_valid(exclusion_counts_json)
            AND json_type(exclusion_counts_json) = 'object'
          ),
        finding_counts_json TEXT NOT NULL
          CHECK (
            json_valid(finding_counts_json)
            AND json_type(finding_counts_json) = 'object'
          ),
        created_at TEXT NOT NULL
          CHECK (length(trim(created_at)) > 0 AND created_at = trim(created_at)),
        decided_at TEXT,
        applied_at TEXT,
        UNIQUE (id, source_id),
        UNIQUE (id, project_id),
        UNIQUE (id, source_id, project_id),
        CHECK (
          (state = 'candidate' AND decided_at IS NULL AND applied_at IS NULL)
          OR (state = 'accepted' AND decided_at IS NOT NULL AND applied_at IS NOT NULL)
          OR (state = 'discarded' AND decided_at IS NOT NULL AND applied_at IS NULL)
        ),
        FOREIGN KEY (source_id, project_id)
          REFERENCES repository_sources(id, project_id) ON DELETE CASCADE,
        FOREIGN KEY (base_snapshot_id, source_id)
          REFERENCES repository_snapshots(id, source_id)
      );

      CREATE TABLE repository_nodes (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(trim(id)) > 0 AND id = trim(id)),
        source_id TEXT NOT NULL
          CHECK (length(trim(source_id)) > 0 AND source_id = trim(source_id))
          REFERENCES repository_sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('directory','file')),
        created_at TEXT NOT NULL
          CHECK (length(trim(created_at)) > 0 AND created_at = trim(created_at)),
        UNIQUE (id, source_id)
      );

      CREATE TABLE repository_node_observations (
        snapshot_id TEXT NOT NULL
          REFERENCES repository_snapshots(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL
          REFERENCES repository_nodes(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL
          REFERENCES repository_sources(id) ON DELETE CASCADE,
        parent_node_id TEXT,
        path TEXT NOT NULL
          CHECK (
            length(path) > 0
            AND path = trim(path)
            AND path NOT LIKE '/%'
            AND path NOT LIKE '%\\%'
            AND path NOT LIKE '%//%'
            AND path NOT GLOB '[A-Za-z]:*'
            AND ('/' || path || '/') NOT LIKE '%/./%'
            AND ('/' || path || '/') NOT LIKE '%/../%'
          ),
        kind TEXT NOT NULL CHECK (kind IN ('directory','file')),
        sha256 TEXT,
        byte_size INTEGER NOT NULL
          CHECK (typeof(byte_size) = 'integer' AND byte_size >= 0),
        source_status TEXT NOT NULL
          CHECK (source_status IN ('tracked','untracked','derived')),
        role TEXT NOT NULL CHECK (
          role IN (
            'canonical_source','supporting_document','test','tool','asset',
            'archived_source'
          )
        ),
        document_kind TEXT CHECK (
          document_kind IS NULL OR document_kind IN (
            'overview','specification','decision_support','operational_guide',
            'test_evidence','ai_instruction','unlinked'
          )
        ),
        document_format TEXT CHECK (
          document_format IS NULL OR document_format IN (
            'markdown','plain_text','image','pdf','unsupported'
          )
        ),
        content_eligible INTEGER NOT NULL CHECK (content_eligible IN (0,1)),
        instruction_client TEXT,
        instruction_scope TEXT,
        PRIMARY KEY (snapshot_id, node_id),
        UNIQUE (snapshot_id, path),
        CHECK (
          (kind = 'file' AND sha256 IS NOT NULL
            AND length(sha256) = 64
            AND sha256 NOT GLOB '*[^0-9a-f]*')
          OR (kind = 'directory' AND sha256 IS NULL)
        ),
        CHECK (
          kind <> 'directory' OR (
            byte_size = 0
            AND source_status = 'derived'
            AND document_kind IS NULL
            AND document_format IS NULL
            AND content_eligible = 0
          )
        ),
        CHECK (document_kind IS NULL OR document_format IS NOT NULL),
        CHECK (
          (document_kind = 'ai_instruction'
            AND instruction_client IS NOT NULL
            AND length(trim(instruction_client)) > 0
            AND instruction_client = trim(instruction_client)
            AND instruction_scope IS NOT NULL
            AND length(trim(instruction_scope)) > 0
            AND instruction_scope = trim(instruction_scope))
          OR (document_kind IS NULL OR document_kind <> 'ai_instruction')
            AND instruction_client IS NULL
            AND instruction_scope IS NULL
        ),
        FOREIGN KEY (snapshot_id, source_id)
          REFERENCES repository_snapshots(id, source_id) ON DELETE CASCADE,
        FOREIGN KEY (node_id, source_id)
          REFERENCES repository_nodes(id, source_id) ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id, parent_node_id)
          REFERENCES repository_node_observations(snapshot_id, node_id)
      );

      CREATE TABLE repository_links (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(trim(id)) > 0 AND id = trim(id)),
        project_id TEXT NOT NULL
          REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL
          REFERENCES repository_snapshots(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL
          REFERENCES repository_sources(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL,
        to_record_id TEXT,
        to_node_id TEXT,
        kind TEXT NOT NULL
          CHECK (kind IN ('documents','implements','evidences','related_to')),
        basis TEXT NOT NULL
          CHECK (basis IN ('accepted','observed','inferred','conflicting')),
        created_at TEXT NOT NULL
          CHECK (length(trim(created_at)) > 0 AND created_at = trim(created_at)),
        CHECK ((to_record_id IS NULL) <> (to_node_id IS NULL)),
        FOREIGN KEY (snapshot_id, source_id, project_id)
          REFERENCES repository_snapshots(id, source_id, project_id)
          ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id, from_node_id)
          REFERENCES repository_node_observations(snapshot_id, node_id)
          ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id, to_node_id)
          REFERENCES repository_node_observations(snapshot_id, node_id)
          ON DELETE CASCADE,
        FOREIGN KEY (to_record_id, project_id)
          REFERENCES project_records(id, project_id) ON DELETE CASCADE
      );

      CREATE TABLE repository_refresh_reviews (
        project_id TEXT NOT NULL
          REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL
          REFERENCES repository_sources(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL PRIMARY KEY
          REFERENCES repository_snapshots(id) ON DELETE CASCADE,
        state TEXT NOT NULL
          CHECK (state IN ('pending','applied','cancelled','conflicted')),
        selected_operation_ids_json TEXT NOT NULL
          CHECK (
            json_valid(selected_operation_ids_json)
            AND json_type(selected_operation_ids_json) = 'array'
          ),
        created_at TEXT NOT NULL
          CHECK (length(trim(created_at)) > 0 AND created_at = trim(created_at)),
        updated_at TEXT NOT NULL
          CHECK (length(trim(updated_at)) > 0 AND updated_at = trim(updated_at)),
        decided_at TEXT,
        CHECK ((state = 'pending') = (decided_at IS NULL)),
        FOREIGN KEY (source_id, project_id)
          REFERENCES repository_sources(id, project_id) ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id, source_id, project_id)
          REFERENCES repository_snapshots(id, source_id, project_id)
          ON DELETE CASCADE
      );

      CREATE INDEX idx_repository_snapshots_source_created_at
        ON repository_snapshots(source_id, created_at DESC);
      CREATE INDEX idx_repository_nodes_source_kind
        ON repository_nodes(source_id, kind);
      CREATE UNIQUE INDEX idx_repository_node_observations_snapshot_path
        ON repository_node_observations(snapshot_id, path);
      CREATE INDEX idx_repository_node_observations_node
        ON repository_node_observations(node_id, snapshot_id);
      CREATE INDEX idx_repository_links_snapshot_from
        ON repository_links(snapshot_id, from_node_id);
      CREATE INDEX idx_repository_links_record_target
        ON repository_links(project_id, to_record_id)
        WHERE to_record_id IS NOT NULL;
      CREATE INDEX idx_repository_links_node_target
        ON repository_links(snapshot_id, to_node_id)
        WHERE to_node_id IS NOT NULL;
      CREATE INDEX idx_repository_refresh_reviews_source_state
        ON repository_refresh_reviews(source_id, state, created_at DESC);
      CREATE UNIQUE INDEX idx_repository_refresh_reviews_pending_source
        ON repository_refresh_reviews(source_id) WHERE state = 'pending';
    `,
  },
  {
    version: 8,
    sql: `
      ${schemaEightChangeProposalsTableSql};

      ${schemaEightProposalOperationsTableSql};

      INSERT INTO change_proposals_v8 (
        id, project_id, profile_id, source_task_id, predecessor_proposal_id,
        base_project_revision, state, rationale, idempotency_key, request_hash,
        review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
        origin_type, repository_snapshot_id
      )
      SELECT
        id, project_id, profile_id, source_task_id, predecessor_proposal_id,
        base_project_revision, state, rationale, idempotency_key, request_hash,
        review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
        'profile', NULL
      FROM change_proposals;

      INSERT INTO proposal_operations_v8 (
        proposal_id, position, operation_id, operation_type,
        expected_record_revision, payload_json
      )
      SELECT
        proposal_id, position, operation_id, operation_type,
        expected_record_revision, payload_json
      FROM proposal_operations
      ORDER BY proposal_id, position;

      CREATE TEMP TABLE schema_8_copy_verification (
        verified INTEGER NOT NULL CHECK (verified = 1)
      );
      INSERT INTO schema_8_copy_verification (verified)
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM change_proposals)
          = (SELECT COUNT(*) FROM change_proposals_v8)
        AND (SELECT COUNT(*) FROM proposal_operations)
          = (SELECT COUNT(*) FROM proposal_operations_v8)
        AND NOT EXISTS (
          SELECT
            id, project_id, profile_id, source_task_id,
            predecessor_proposal_id, base_project_revision, state, rationale,
            idempotency_key, request_hash, review_reason, reviewer_actor,
            created_at, updated_at, reviewed_at, 'profile', NULL
          FROM change_proposals
          EXCEPT
          SELECT
            id, project_id, profile_id, source_task_id,
            predecessor_proposal_id, base_project_revision, state, rationale,
            idempotency_key, request_hash, review_reason, reviewer_actor,
            created_at, updated_at, reviewed_at, origin_type,
            repository_snapshot_id
          FROM change_proposals_v8
        )
        AND NOT EXISTS (
          SELECT
            id, project_id, profile_id, source_task_id,
            predecessor_proposal_id, base_project_revision, state, rationale,
            idempotency_key, request_hash, review_reason, reviewer_actor,
            created_at, updated_at, reviewed_at, origin_type,
            repository_snapshot_id
          FROM change_proposals_v8
          EXCEPT
          SELECT
            id, project_id, profile_id, source_task_id,
            predecessor_proposal_id, base_project_revision, state, rationale,
            idempotency_key, request_hash, review_reason, reviewer_actor,
            created_at, updated_at, reviewed_at, 'profile', NULL
          FROM change_proposals
        )
        AND NOT EXISTS (
          SELECT
            proposal_id, position, operation_id, operation_type,
            expected_record_revision, payload_json
          FROM proposal_operations
          EXCEPT
          SELECT
            proposal_id, position, operation_id, operation_type,
            expected_record_revision, payload_json
          FROM proposal_operations_v8
        )
        AND NOT EXISTS (
          SELECT
            proposal_id, position, operation_id, operation_type,
            expected_record_revision, payload_json
          FROM proposal_operations_v8
          EXCEPT
          SELECT
            proposal_id, position, operation_id, operation_type,
            expected_record_revision, payload_json
          FROM proposal_operations
        )
      THEN 1 ELSE 0 END;
      DROP TABLE schema_8_copy_verification;

      DROP TABLE proposal_operations;
      DROP TABLE change_proposals;
      ALTER TABLE change_proposals_v8 RENAME TO change_proposals;
      ALTER TABLE proposal_operations_v8 RENAME TO proposal_operations;

      ${proposalOperationsNoUpdateTriggerSql};
      ${proposalOperationsNoDeleteTriggerSql};

      ${changeProposalsProjectStateIndexSql};
      ${changeProposalsProfileIdempotencyIndexSql};
      ${changeProposalsRepositorySnapshotIndexSql};
    `,
  },
  {
    version: 9,
    sql: `
      ${humanChangeIdempotencyResultsTableSql};
    `,
  },
  {
    version: 10,
    sql: `
      ${taskClaimsTableSql};
      ${taskCheckpointsTableSql};
      ${taskDelegationsTableSql};
      ${taskSubmissionsTableSql};
      ${coordinationEventsTableSql};
      ${coordinationIdempotencyTableSql};

      ${taskClaimsOneActiveIndexSql};
      ${taskClaimsOneSubmittedIndexSql};
      ${taskDelegationsOneLiveIndexSql};

      ${taskCheckpointsNoUpdateTriggerSql};
      ${taskCheckpointsNoDeleteTriggerSql};
      ${taskSubmissionsImmutableFieldsTriggerSql};
      ${taskSubmissionsNoDeleteTriggerSql};
      ${coordinationEventsNoUpdateTriggerSql};
      ${coordinationEventsNoDeleteTriggerSql};
      ${coordinationProposalStateSyncTriggerSql};
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE projects ADD COLUMN hierarchy_vocabulary_json TEXT NOT NULL
        DEFAULT '{"preset":"neutral","outcome":"Outcome","initiative":"Initiative","deliverable":"Deliverable","milestone":"Milestone","task":"Work item","nestedTask":"Subtask"}'
        CHECK (
          json_valid(hierarchy_vocabulary_json)
          AND json_type(hierarchy_vocabulary_json) = 'object'
        );
    `,
  },
];
