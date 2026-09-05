import { z } from "zod";
import {
  outboundDestinationSnapshotSchema,
  outboundFindingCountsSchema,
  outboundFindingDecisionSchema,
  outboundFindingSchema,
  outboundReleaseSchema,
  outboundRequestFilterSchema,
  outboundRequestStatusSchema,
  outboundRequestSummarySchema,
  type OutboundDestinationSnapshot,
  type OutboundFinding,
  type OutboundFindingCounts,
  type OutboundFindingDecision,
  type OutboundRelease,
  type OutboundRequestFilter,
  type OutboundRequestStatus,
  type OutboundRequestSummary,
} from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import {
  computeOutboundReleaseDigest,
  maskOutboundDestination,
  OUTBOUND_DETECTOR_VERSION,
  OUTBOUND_SAFETY_POLICY_VERSION,
} from "../outbound/safety-engine.js";
import type { IntentArcDatabase } from "./database.js";

export interface StoredOutboundRequest extends OutboundRequestSummary {
  idempotencyKey: string;
  requestHash: string;
  candidateDigest: string;
  decisionActor: string | null;
  decisionReason: string | null;
}

export interface OutboundAudit {
  id: string;
  createdAt: string;
}

export interface OutboundPolicyScope {
  profileId: string;
  projectId: string;
  destinationId: string;
  destinationRevision: number;
  detectorVersion: string;
  safetyPolicyVersion: string;
}

export interface OutboundPolicy extends OutboundPolicyScope {
  mode: "manual" | "auto_release_clean";
  createdAt: string;
  updatedAt: string;
}

export type OutboundRequestAuditActor =
  | { actorType: "profile"; profileId: string }
  | { actorType: "local_human"; profileId: null };

export interface CreateOutboundRequestCommand {
  request: StoredOutboundRequest;
  findings: OutboundFinding[];
  release: OutboundRelease | null;
  audit: OutboundAudit;
  scanAudit: OutboundAudit;
  auditActor: OutboundRequestAuditActor;
}

export interface ApproveStoredOutboundRequestCommand {
  requestId: string;
  decisions: Array<{
    findingId: string;
    decision: OutboundFindingDecision;
  }>;
  release: OutboundRelease;
  policy: OutboundPolicy | null;
  decisionActor: string;
  decisionReason: string;
  decidedAt: string;
  audit: OutboundAudit;
  policyAudit?: OutboundAudit | null;
}

export interface DenyStoredOutboundRequestCommand {
  requestId: string;
  decisionActor: string;
  decisionReason: string;
  decidedAt: string;
  audit: OutboundAudit;
}

export interface RecordOutboundRetrievalCommand {
  requestId: string;
  releaseId: string;
  profileId: string;
  destination: OutboundDestinationSnapshot;
  audit: OutboundAudit;
}

export interface DisableOutboundPolicyCommand {
  scope: OutboundPolicyScope;
  disabledAt: string;
  audit: OutboundAudit;
}

export interface OutboundContextStore {
  resolveIdempotency(
    profileId: string,
    key: string,
  ): StoredOutboundRequest | null;
  createRequest(command: CreateOutboundRequestCommand): StoredOutboundRequest;
  getRequest(requestId: string): StoredOutboundRequest | null;
  listRequests(filter: OutboundRequestFilter): OutboundRequestSummary[];
  getFindings(requestId: string): OutboundFinding[];
  approve(command: ApproveStoredOutboundRequestCommand): OutboundRelease;
  deny(command: DenyStoredOutboundRequestCommand): StoredOutboundRequest;
  getReleaseForRequest(requestId: string): OutboundRelease | null;
  recordRetrieval(command: RecordOutboundRetrievalCommand): void;
  getPolicy(scope: OutboundPolicyScope): OutboundPolicy | null;
  disablePolicy(command: DisableOutboundPolicyCommand): void;
}

const identifierSchema = z.string().trim().min(1).max(200);
const nullableIdentifierSchema = identifierSchema.nullable();
const timestampSchema = z.iso.datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const outboundRequestAuditActorSchema: z.ZodType<OutboundRequestAuditActor> =
  z.discriminatedUnion("actorType", [
    z.object({
      actorType: z.literal("profile"),
      profileId: identifierSchema,
    }).strict(),
    z.object({
      actorType: z.literal("local_human"),
      profileId: z.null(),
    }).strict(),
  ]);

const storedOutboundRequestSchema: z.ZodType<StoredOutboundRequest> = z.object({
  requestId: identifierSchema,
  profileId: identifierSchema,
  projectId: identifierSchema,
  taskId: identifierSchema,
  sourcePackId: identifierSchema,
  destination: outboundDestinationSnapshotSchema,
  status: outboundRequestStatusSchema,
  projectRevision: z.number().int().nonnegative(),
  budgetTokens: z.number().int().positive(),
  originalEstimatedTokens: z.number().int().nonnegative(),
  findingCounts: outboundFindingCountsSchema,
  detectorVersion: identifierSchema,
  safetyPolicyVersion: identifierSchema,
  releaseId: nullableIdentifierSchema,
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  idempotencyKey: identifierSchema.max(128),
  requestHash: sha256Schema,
  candidateDigest: sha256Schema,
  decisionActor: nullableIdentifierSchema,
  decisionReason: nullableIdentifierSchema,
}).strict();

const outboundAuditSchema: z.ZodType<OutboundAudit> = z.object({
  id: identifierSchema,
  createdAt: timestampSchema,
}).strict();

const outboundPolicyScopeSchema: z.ZodType<OutboundPolicyScope> = z.object({
  profileId: identifierSchema,
  projectId: identifierSchema,
  destinationId: identifierSchema,
  destinationRevision: z.number().int().positive(),
  detectorVersion: identifierSchema,
  safetyPolicyVersion: identifierSchema,
}).strict();

const outboundPolicySchema: z.ZodType<OutboundPolicy> = z.object({
  profileId: identifierSchema,
  projectId: identifierSchema,
  destinationId: identifierSchema,
  destinationRevision: z.number().int().positive(),
  detectorVersion: identifierSchema,
  safetyPolicyVersion: identifierSchema,
  mode: z.enum(["manual", "auto_release_clean"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const findingDecisionSchema = z.object({
  findingId: identifierSchema,
  decision: outboundFindingDecisionSchema,
}).strict();

const findingDecisionsSchema = z.array(findingDecisionSchema).refine(
  (decisions) =>
    new Set(decisions.map(({ findingId }) => findingId)).size ===
      decisions.length,
  { message: "Finding decisions must be unique" },
);

type OutboundRequestRow = {
  id: string;
  profile_id: string;
  project_id: string;
  task_id: string;
  source_pack_id: string;
  idempotency_key: string;
  request_hash: string;
  destination_snapshot_json: string;
  detector_version: string;
  safety_policy_version: string;
  candidate_digest: string;
  status: OutboundRequestStatus;
  finding_counts_json: string;
  decision_actor: string | null;
  decision_reason: string | null;
  release_id: string | null;
  created_at: string;
  decided_at: string | null;
  project_revision: number;
  budget_tokens: number;
  estimated_tokens: number;
};

type OutboundFindingRow = {
  id: string;
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
  decision: OutboundFindingDecision | null;
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

type OutboundPolicyRow = {
  profile_id: string;
  project_id: string;
  destination_id: string;
  destination_revision: number;
  detector_version: string;
  safety_policy_version: string;
  mode: OutboundPolicy["mode"];
  created_at: string;
  updated_at: string;
};

type RequestDestinationRow = {
  profile_id: string;
  destination_id: string;
  revision: number;
  client_label: string;
  destination_type: OutboundDestinationSnapshot["type"];
  provider_label: string;
  model_label: string | null;
  account_boundary_label: string | null;
  data_boundary: OutboundDestinationSnapshot["dataBoundary"];
};

type CurrentDestinationRow = RequestDestinationRow & {
  status: "enabled" | "disabled";
};

const requestColumns = `
  requests.id, requests.profile_id, requests.project_id, requests.task_id,
  requests.source_pack_id, requests.idempotency_key, requests.request_hash,
  requests.destination_snapshot_json, requests.detector_version,
  requests.safety_policy_version, requests.candidate_digest, requests.status,
  requests.finding_counts_json, requests.decision_actor,
  requests.decision_reason, requests.release_id, requests.created_at,
  requests.decided_at, packs.project_revision, packs.budget_tokens,
  packs.estimated_tokens
`;

const findingColumns = `
  id, ordinal, detector_id, detector_version, category, confidence, severity,
  field_path, start_offset, end_offset, finding_key, required_action, decision
`;

const policyColumns = `
  profile_id, project_id, destination_id, destination_revision,
  detector_version, safety_policy_version, mode, created_at, updated_at
`;

const mapRequestRow = (row: OutboundRequestRow): StoredOutboundRequest =>
  storedOutboundRequestSchema.parse({
    requestId: row.id,
    profileId: row.profile_id,
    projectId: row.project_id,
    taskId: row.task_id,
    sourcePackId: row.source_pack_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    destination: outboundDestinationSnapshotSchema.parse(
      JSON.parse(row.destination_snapshot_json),
    ),
    detectorVersion: row.detector_version,
    safetyPolicyVersion: row.safety_policy_version,
    candidateDigest: row.candidate_digest,
    status: row.status,
    projectRevision: row.project_revision,
    budgetTokens: row.budget_tokens,
    originalEstimatedTokens: row.estimated_tokens,
    findingCounts: outboundFindingCountsSchema.parse(
      JSON.parse(row.finding_counts_json),
    ),
    decisionActor: row.decision_actor,
    decisionReason: row.decision_reason,
    releaseId: row.release_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  });

const toRequestSummary = (
  request: StoredOutboundRequest,
): OutboundRequestSummary => outboundRequestSummarySchema.parse({
  requestId: request.requestId,
  profileId: request.profileId,
  projectId: request.projectId,
  taskId: request.taskId,
  sourcePackId: request.sourcePackId,
  destination: request.destination,
  status: request.status,
  projectRevision: request.projectRevision,
  budgetTokens: request.budgetTokens,
  originalEstimatedTokens: request.originalEstimatedTokens,
  findingCounts: request.findingCounts,
  detectorVersion: request.detectorVersion,
  safetyPolicyVersion: request.safetyPolicyVersion,
  releaseId: request.releaseId,
  createdAt: request.createdAt,
  decidedAt: request.decidedAt,
});

const mapFindingRow = (row: OutboundFindingRow): OutboundFinding =>
  outboundFindingSchema.parse({
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

const parseReleasePreservingPackShape = (value: unknown): OutboundRelease => {
  const rawPack = value !== null && typeof value === "object" &&
      "pack" in value
    ? value.pack
    : undefined;
  const hasStoredHierarchyVocabulary = rawPack !== null &&
    typeof rawPack === "object" &&
    Object.hasOwn(rawPack, "hierarchyVocabulary");
  const release = outboundReleaseSchema.parse(value);
  if (!hasStoredHierarchyVocabulary) {
    delete release.pack.hierarchyVocabulary;
  }
  return release;
};

const mapReleaseRow = (row: OutboundReleaseRow): OutboundRelease => {
  const storedPack: unknown = JSON.parse(row.content_json);
  const hasStoredHierarchyVocabulary = storedPack !== null &&
    typeof storedPack === "object" &&
    Object.hasOwn(storedPack, "hierarchyVocabulary");
  const release = outboundReleaseSchema.parse({
    releaseId: row.id,
    requestId: row.request_id,
    sourcePackId: row.source_pack_id,
    releasedAt: row.released_at,
    sha256: row.sha256,
    disclosure: JSON.parse(row.disclosure_json),
    pack: storedPack,
  });

  if (!hasStoredHierarchyVocabulary) {
    delete release.pack.hierarchyVocabulary;
  }

  return release;
};

const mapPolicyRow = (row: OutboundPolicyRow): OutboundPolicy =>
  outboundPolicySchema.parse({
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

const countsForFindings = (
  findings: readonly OutboundFinding[],
): OutboundFindingCounts => outboundFindingCountsSchema.parse({
  total: findings.length,
  credential: findings.filter(({ severity }) => severity === "credential").length,
  sensitive: findings.filter(({ severity }) => severity === "sensitive").length,
  forcedRedact: findings.filter(
    ({ requiredAction }) => requiredAction === "forced_redact",
  ).length,
  redactByDefault: findings.filter(
    ({ requiredAction }) => requiredAction === "redact_by_default",
  ).length,
  redacted: findings.filter(
    ({ decision }) => decision !== "include_once",
  ).length,
  includedOnce: findings.filter(
    ({ decision }) => decision === "include_once",
  ).length,
});

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const normalizeStoreFailure = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OutboundSafetyError) throw error;
    throw new OutboundSafetyError("outbound_safety_failed", {});
  }
};

const normalizeReleaseFailure = <Result>(
  requestId: string,
  operation: () => Result,
): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OutboundSafetyError) throw error;
    throw new OutboundSafetyError("outbound_release_invalid", { requestId });
  }
};

export const createOutboundContextStore = (
  database: IntentArcDatabase,
): OutboundContextStore => {
  const requestFrom = `
    FROM outbound_requests AS requests
    JOIN context_packs AS packs ON packs.id = requests.source_pack_id
  `;
  const selectRequest = database.prepare(`
    SELECT ${requestColumns}
    ${requestFrom}
    WHERE requests.id = ?
  `);
  const selectIdempotency = database.prepare(`
    SELECT ${requestColumns}
    ${requestFrom}
    WHERE requests.profile_id = ? AND requests.idempotency_key = ?
  `);
  const selectSourcePack = database.prepare(`
    SELECT project_id, task_id, project_revision, budget_tokens, estimated_tokens
    FROM context_packs WHERE id = ?
  `);
  const selectRequestDestination = database.prepare(`
    SELECT
      profile_id, destination_id, revision, client_label, destination_type,
      provider_label, model_label, account_boundary_label, data_boundary
    FROM outbound_destinations
    WHERE destination_id = ? AND revision = ?
  `);
  const insertRequest = database.prepare(`
    INSERT INTO outbound_requests (
      id, profile_id, project_id, task_id, source_pack_id, idempotency_key,
      request_hash, destination_id, destination_revision,
      destination_snapshot_json, detector_version, safety_policy_version,
      candidate_digest, status, finding_counts_json, decision_actor,
      decision_reason, release_id, created_at, decided_at
    ) VALUES (
      @requestId, @profileId, @projectId, @taskId, @sourcePackId,
      @idempotencyKey, @requestHash, @destinationId, @destinationRevision,
      @destinationSnapshotJson, @detectorVersion, @safetyPolicyVersion,
      @candidateDigest, @status, @findingCountsJson, @decisionActor,
      @decisionReason, @releaseId, @createdAt, @decidedAt
    )
  `);
  const insertFinding = database.prepare(`
    INSERT INTO outbound_findings (
      id, request_id, ordinal, detector_id, detector_version, category,
      confidence, severity, field_path, start_offset, end_offset, finding_key,
      required_action, decision
    ) VALUES (
      @id, @requestId, @ordinal, @detectorId, @detectorVersion, @category,
      @confidence, @severity, @path, @start, @end, @findingKey,
      @requiredAction, @decision
    )
  `);
  const selectFindings = database.prepare(`
    SELECT ${findingColumns}
    FROM outbound_findings
    WHERE request_id = ?
    ORDER BY ordinal, id
  `);
  const updateFindingDecision = database.prepare(`
    UPDATE outbound_findings SET decision = @decision
    WHERE request_id = @requestId AND id = @findingId
  `);
  const updateFindingCounts = database.prepare(`
    UPDATE outbound_requests SET finding_counts_json = ?
    WHERE id = ?
  `);
  const releaseRequest = database.prepare(`
    UPDATE outbound_requests
    SET status = 'released', decision_actor = @decisionActor,
        decision_reason = @decisionReason, release_id = @releaseId,
        decided_at = @decidedAt
    WHERE id = @requestId AND status = 'review_required'
  `);
  const denyRequest = database.prepare(`
    UPDATE outbound_requests
    SET status = 'denied', decision_actor = @decisionActor,
        decision_reason = @decisionReason, release_id = NULL,
        decided_at = @decidedAt
    WHERE id = @requestId AND status = 'review_required'
  `);
  const insertRelease = database.prepare(`
    INSERT INTO outbound_releases (
      id, request_id, source_pack_id, content_json, disclosure_json,
      sha256, released_at
    ) VALUES (
      @releaseId, @requestId, @sourcePackId, @contentJson, @disclosureJson,
      @sha256, @releasedAt
    )
  `);
  const selectRelease = database.prepare(`
    SELECT
      id, request_id, source_pack_id, content_json, disclosure_json,
      sha256, released_at
    FROM outbound_releases
    WHERE request_id = ?
  `);
  const selectReleaseIdentity = database.prepare(`
    SELECT status, profile_id, project_id, release_id,
           destination_id, destination_revision, destination_snapshot_json
    FROM outbound_requests WHERE id = ?
  `);
  const selectCurrentDestination = database.prepare(`
    SELECT
      profile_id, destination_id, revision, client_label, destination_type,
      provider_label, model_label, account_boundary_label, data_boundary,
      status
    FROM outbound_destinations
    WHERE profile_id = ? AND is_current = 1
  `);
  const selectPolicy = database.prepare(`
    SELECT ${policyColumns}
    FROM outbound_policies
    WHERE profile_id = @profileId
      AND project_id = @projectId
      AND destination_id = @destinationId
      AND destination_revision = @destinationRevision
      AND detector_version = @detectorVersion
      AND safety_policy_version = @safetyPolicyVersion
  `);
  const selectPolicyDestination = database.prepare(`
    SELECT profile_id, is_current
    FROM outbound_destinations
    WHERE destination_id = ? AND revision = ?
  `);
  const upsertPolicy = database.prepare(`
    INSERT INTO outbound_policies (
      profile_id, project_id, destination_id, destination_revision,
      detector_version, safety_policy_version, mode, created_at, updated_at
    ) VALUES (
      @profileId, @projectId, @destinationId, @destinationRevision,
      @detectorVersion, @safetyPolicyVersion, @mode, @createdAt, @updatedAt
    )
    ON CONFLICT (
      profile_id, project_id, destination_id, destination_revision,
      detector_version, safety_policy_version
    ) DO UPDATE SET
      mode = excluded.mode,
      updated_at = excluded.updated_at
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, @actorType, @profileId, @authorityMode, @scopeDecision,
      @actionCategory, @targetId, @idempotencyKey, NULL,
      NULL, @outcome, @reason, @createdAt
    )
  `);

  const storedRequest = (requestId: string): StoredOutboundRequest | null => {
    const row = selectRequest.get(requestId) as OutboundRequestRow | undefined;
    return row ? mapRequestRow(row) : null;
  };

  const writeAudit = (
    auditValue: OutboundAudit,
    derived: {
      projectId: string | null;
      profileId: string | null;
      actorType: "profile" | "local_human";
      authorityMode: string | null;
      scopeDecision: string;
      actionCategory:
        | "outbound_request_created"
        | "outbound_scan_completed"
        | "outbound_request_approved"
        | "outbound_request_denied"
        | "outbound_release_retrieved"
        | "outbound_policy_enabled"
        | "outbound_policy_disabled";
      targetId: string | null;
      idempotencyKey: string | null;
      reason: string;
    },
  ): void => {
    const parsed = outboundAuditSchema.parse(auditValue);
    insertAudit.run({
      id: parsed.id,
      createdAt: parsed.createdAt,
      ...derived,
      outcome: "applied",
    });
  };

  const writeRelease = (release: OutboundRelease): void => {
    const parsed = parseReleasePreservingPackShape(release);
    insertRelease.run({
      ...parsed,
      contentJson: JSON.stringify(parsed.pack),
      disclosureJson: JSON.stringify(parsed.disclosure),
    });
  };

  const assertPolicyScopeIsValid = (scope: OutboundPolicyScope): void => {
    const destinationRow = selectPolicyDestination.get(
      scope.destinationId,
      scope.destinationRevision,
    ) as { profile_id: string; is_current: number } | undefined;
    if (
      scope.detectorVersion !== OUTBOUND_DETECTOR_VERSION ||
      scope.safetyPolicyVersion !== OUTBOUND_SAFETY_POLICY_VERSION ||
      destinationRow?.profile_id !== scope.profileId ||
      destinationRow.is_current !== 1
    ) {
      throw new Error("Outbound policy scope is not current");
    }
  };

  const assertReleaseMatchesRequest = (
    requestValue: StoredOutboundRequest,
    releaseValue: OutboundRelease,
    terminalCounts: OutboundFindingCounts,
    findings: readonly OutboundFinding[],
  ): void => {
    const digest = computeOutboundReleaseDigest(releaseValue);
    const releaseDestination = maskOutboundDestination(
      requestValue.destination,
      findings,
    );
    if (
      releaseValue.requestId !== requestValue.requestId ||
      releaseValue.sourcePackId !== requestValue.sourcePackId ||
      releaseValue.pack.id !== requestValue.sourcePackId ||
      releaseValue.pack.projectId !== requestValue.projectId ||
      releaseValue.pack.taskId !== requestValue.taskId ||
      releaseValue.pack.projectRevision !== requestValue.projectRevision ||
      releaseValue.pack.budgetTokens !== requestValue.budgetTokens ||
      releaseValue.disclosure.sourcePackId !== requestValue.sourcePackId ||
      releaseValue.disclosure.projectId !== requestValue.projectId ||
      releaseValue.disclosure.taskId !== requestValue.taskId ||
      releaseValue.disclosure.projectRevision !== requestValue.projectRevision ||
      releaseValue.disclosure.requestedBudgetTokens !==
        requestValue.budgetTokens ||
      releaseValue.disclosure.originalEstimatedTokens !==
        requestValue.originalEstimatedTokens ||
      !equalJson(releaseValue.disclosure.destination, releaseDestination) ||
      !equalJson(releaseValue.disclosure.findingCounts, terminalCounts) ||
      releaseValue.disclosure.detectorVersion !==
        requestValue.detectorVersion ||
      releaseValue.disclosure.safetyPolicyVersion !==
        requestValue.safetyPolicyVersion ||
      releaseValue.disclosure.releasedAt !== releaseValue.releasedAt ||
      releaseValue.sha256 !== digest ||
      releaseValue.disclosure.releaseDigest !== digest
    ) {
      throw new Error("Outbound release does not match its request");
    }
  };

  const scanAuditReason = (request: StoredOutboundRequest): string =>
    `scan_completed:total:${request.findingCounts.total};` +
    `credential:${request.findingCounts.credential};` +
    `sensitive:${request.findingCounts.sensitive};` +
    `forced_redact:${request.findingCounts.forcedRedact};` +
    `redact_by_default:${request.findingCounts.redactByDefault};` +
    `detector_version:${request.detectorVersion};` +
    `safety_policy_version:${request.safetyPolicyVersion};` +
    `destination_revision:${request.destination.revision}`;

  const policyAuditReason = (policy: OutboundPolicy): string =>
    `policy_enabled:detector_version:${policy.detectorVersion};` +
    `safety_policy_version:${policy.safetyPolicyVersion};` +
    `destination_revision:${policy.destinationRevision}`;

  const createRequestTransaction = database.transaction(
    (command: CreateOutboundRequestCommand): StoredOutboundRequest => {
      const parsedRequest = storedOutboundRequestSchema.parse(command.request);
      const auditActor = outboundRequestAuditActorSchema.parse(
        command.auditActor,
      );
      const parsedFindings = z.array(outboundFindingSchema)
        .parse(command.findings)
        .sort((left, right) => left.ordinal - right.ordinal);
      const parsedRelease = command.release === null
        ? null
        : parseReleasePreservingPackShape(command.release);
      if (
        auditActor.actorType === "profile" &&
        auditActor.profileId !== parsedRequest.profileId
      ) {
        throw new Error("Profile audit actor does not match request profile");
      }
      if (
        parsedFindings.some(({ ordinal }, index) => ordinal !== index)
      ) {
        throw new Error("Finding ordinals must be contiguous");
      }
      if (
        !equalJson(
          parsedRequest.findingCounts,
          countsForFindings(parsedFindings),
        )
      ) {
        throw new Error("Request finding counts do not match");
      }
      const existing = selectIdempotency.get(
        parsedRequest.profileId,
        parsedRequest.idempotencyKey,
      ) as OutboundRequestRow | undefined;
      if (existing) {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: mapRequestRow(existing).requestId,
        });
      }
      const packRow = selectSourcePack.get(parsedRequest.sourcePackId) as
        | {
          project_id: string;
          task_id: string;
          project_revision: number;
          budget_tokens: number;
          estimated_tokens: number;
        }
        | undefined;
      if (
        !packRow ||
        packRow.project_id !== parsedRequest.projectId ||
        packRow.task_id !== parsedRequest.taskId ||
        packRow.project_revision !== parsedRequest.projectRevision ||
        packRow.budget_tokens !== parsedRequest.budgetTokens ||
        packRow.estimated_tokens !== parsedRequest.originalEstimatedTokens
      ) {
        throw new Error("Request source pack metadata does not match");
      }
      const destinationRow = selectRequestDestination.get(
        parsedRequest.destination.id,
        parsedRequest.destination.revision,
      ) as RequestDestinationRow | undefined;
      const storedDestination = destinationRow === undefined
        ? null
        : outboundDestinationSnapshotSchema.parse({
          id: destinationRow.destination_id,
          revision: destinationRow.revision,
          clientLabel: destinationRow.client_label,
          type: destinationRow.destination_type,
          providerLabel: destinationRow.provider_label,
          modelLabel: destinationRow.model_label,
          accountBoundaryLabel: destinationRow.account_boundary_label,
          dataBoundary: destinationRow.data_boundary,
        });
      if (
        destinationRow?.profile_id !== parsedRequest.profileId ||
        !equalJson(storedDestination, parsedRequest.destination)
      ) {
        throw new Error("Request destination snapshot does not match");
      }
      if (
        (parsedRequest.status === "released") !== (parsedRelease !== null) ||
        (
          parsedRelease === null
            ? parsedRequest.releaseId !== null
            : parsedRequest.releaseId !== parsedRelease.releaseId
        ) ||
        (parsedRelease !== null && (
          parsedRelease.requestId !== parsedRequest.requestId ||
          parsedRelease.sourcePackId !== parsedRequest.sourcePackId
        ))
      ) {
        throw new Error("Request and release state do not match");
      }
      if (parsedRelease) {
        if (parsedFindings.some(({ decision }) => decision === null)) {
          throw new Error("Released findings require terminal decisions");
        }
        assertReleaseMatchesRequest(
          parsedRequest,
          parsedRelease,
          parsedRequest.findingCounts,
          parsedFindings,
        );
      }
      insertRequest.run({
        ...parsedRequest,
        destinationId: parsedRequest.destination.id,
        destinationRevision: parsedRequest.destination.revision,
        destinationSnapshotJson: JSON.stringify(parsedRequest.destination),
        findingCountsJson: JSON.stringify(parsedRequest.findingCounts),
      });
      for (const parsedFinding of parsedFindings) {
        insertFinding.run({
          ...parsedFinding,
          requestId: parsedRequest.requestId,
        });
      }
      if (parsedRelease) writeRelease(parsedRelease);
      writeAudit(command.audit, {
        projectId: parsedRequest.projectId,
        ...auditActor,
        authorityMode: auditActor.actorType === "local_human" ? "human" : null,
        scopeDecision: "outbound_safety",
        actionCategory: "outbound_request_created",
        targetId: parsedRequest.requestId,
        idempotencyKey: null,
        reason: `request_status:${parsedRequest.status}`,
      });
      writeAudit(command.scanAudit, {
        projectId: parsedRequest.projectId,
        ...auditActor,
        authorityMode: auditActor.actorType === "local_human" ? "human" : null,
        scopeDecision: "outbound_safety",
        actionCategory: "outbound_scan_completed",
        targetId: parsedRequest.requestId,
        idempotencyKey: null,
        reason: scanAuditReason(parsedRequest),
      });
      const inserted = storedRequest(parsedRequest.requestId);
      if (!inserted) throw new Error("Inserted outbound request was not found");
      return inserted;
    },
  );

  const approveTransaction = database.transaction(
    (command: ApproveStoredOutboundRequestCommand): OutboundRelease => {
      const parsedRelease = parseReleasePreservingPackShape(command.release);
      const decisions = findingDecisionsSchema.parse(command.decisions);
      const parsedPolicy = command.policy === null
        ? null
        : outboundPolicySchema.parse(command.policy);
      const parsedPolicyAudit = command.policyAudit === undefined ||
          command.policyAudit === null
        ? null
        : outboundAuditSchema.parse(command.policyAudit);
      timestampSchema.parse(command.decidedAt);
      identifierSchema.parse(command.decisionActor);
      identifierSchema.parse(command.decisionReason);
      const pendingRequest = storedRequest(command.requestId);
      if (!pendingRequest || pendingRequest.status !== "review_required") {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: command.requestId,
        });
      }
      const pendingFindings = (
        selectFindings.all(command.requestId) as OutboundFindingRow[]
      ).map(mapFindingRow);
      const decisionByFindingId = new Map(
        decisions.map((decision) => [decision.findingId, decision.decision]),
      );
      if (
        decisions.length !== pendingFindings.length ||
        pendingFindings.some(({ id }) => !decisionByFindingId.has(id))
      ) {
        throw new Error("Approval decisions do not cover every finding");
      }
      const terminalFindings = pendingFindings.map((storedFinding) =>
        outboundFindingSchema.parse({
          ...storedFinding,
          decision: decisionByFindingId.get(storedFinding.id),
        })
      );
      const terminalCounts = countsForFindings(terminalFindings);
      assertReleaseMatchesRequest(
        pendingRequest,
        parsedRelease,
        terminalCounts,
        terminalFindings,
      );
      if (
        (
          parsedPolicy !== null &&
          (
            parsedPolicy.mode !== "auto_release_clean" ||
            pendingRequest.findingCounts.total !== 0 ||
            parsedPolicy.profileId !== pendingRequest.profileId ||
            parsedPolicy.projectId !== pendingRequest.projectId ||
            parsedPolicy.destinationId !== pendingRequest.destination.id ||
            parsedPolicy.destinationRevision !==
              pendingRequest.destination.revision ||
            parsedPolicy.detectorVersion !==
              pendingRequest.detectorVersion ||
            parsedPolicy.safetyPolicyVersion !==
              pendingRequest.safetyPolicyVersion
          )
        )
      ) {
        throw new Error("Approval terminal state does not match");
      }
      if (
        (parsedPolicy === null) !== (parsedPolicyAudit === null)
      ) {
        throw new Error("Policy state and audit must be committed together");
      }
      if (parsedPolicy) assertPolicyScopeIsValid(parsedPolicy);
      const result = releaseRequest.run({
        requestId: command.requestId,
        releaseId: parsedRelease.releaseId,
        decisionActor: command.decisionActor,
        decisionReason: command.decisionReason,
        decidedAt: command.decidedAt,
      });
      if (result.changes !== 1) {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: command.requestId,
        });
      }
      for (const decision of decisions) {
        const decisionResult = updateFindingDecision.run({
          requestId: command.requestId,
          ...decision,
        });
        if (decisionResult.changes !== 1) {
          throw new OutboundSafetyError("outbound_request_conflict", {
            requestId: command.requestId,
          });
        }
      }
      const persistedTerminalFindings = (
        selectFindings.all(command.requestId) as OutboundFindingRow[]
      ).map(mapFindingRow);
      updateFindingCounts.run(
        JSON.stringify(countsForFindings(persistedTerminalFindings)),
        command.requestId,
      );
      writeRelease(parsedRelease);
      if (parsedPolicy) upsertPolicy.run(parsedPolicy);
      const request = storedRequest(command.requestId);
      if (!request) throw new Error("Approved request was not found");
      writeAudit(command.audit, {
        projectId: request.projectId,
        profileId: null,
        actorType: "local_human",
        authorityMode: "human",
        scopeDecision: "human_admin",
        actionCategory: "outbound_request_approved",
        targetId: command.requestId,
        idempotencyKey: null,
        reason: "approved",
      });
      if (parsedPolicy && parsedPolicyAudit) {
        writeAudit(parsedPolicyAudit, {
          projectId: request.projectId,
          profileId: null,
          actorType: "local_human",
          authorityMode: "human",
          scopeDecision: "human_admin",
          actionCategory: "outbound_policy_enabled",
          targetId: command.requestId,
          idempotencyKey: null,
          reason: policyAuditReason(parsedPolicy),
        });
      }
      const row = selectRelease.get(command.requestId) as
        | OutboundReleaseRow
        | undefined;
      if (!row) throw new Error("Approved release was not found");
      return mapReleaseRow(row);
    },
  );

  const denyTransaction = database.transaction(
    (command: DenyStoredOutboundRequestCommand): StoredOutboundRequest => {
      timestampSchema.parse(command.decidedAt);
      identifierSchema.parse(command.decisionActor);
      identifierSchema.parse(command.decisionReason);
      const result = denyRequest.run(command);
      if (result.changes !== 1) {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: command.requestId,
        });
      }
      const request = storedRequest(command.requestId);
      if (!request) throw new Error("Denied request was not found");
      writeAudit(command.audit, {
        projectId: request.projectId,
        profileId: null,
        actorType: "local_human",
        authorityMode: "human",
        scopeDecision: "human_admin",
        actionCategory: "outbound_request_denied",
        targetId: command.requestId,
        idempotencyKey: null,
        reason: "denied",
      });
      return request;
    },
  );

  const recordRetrievalTransaction = database.transaction(
    (command: RecordOutboundRetrievalCommand): void => {
      const expectedDestination = outboundDestinationSnapshotSchema.parse(
        command.destination,
      );
      const identity = selectReleaseIdentity.get(command.requestId) as
        | {
          status: OutboundRequestStatus;
          profile_id: string;
          project_id: string;
          release_id: string | null;
          destination_id: string;
          destination_revision: number;
          destination_snapshot_json: string;
        }
        | undefined;
      const releaseRow = selectRelease.get(command.requestId) as
        | OutboundReleaseRow
        | undefined;
      const currentRow = selectCurrentDestination.get(command.profileId) as
        | CurrentDestinationRow
        | undefined;
      const currentDestination = currentRow === undefined
        ? null
        : outboundDestinationSnapshotSchema.parse({
          id: currentRow.destination_id,
          revision: currentRow.revision,
          clientLabel: currentRow.client_label,
          type: currentRow.destination_type,
          providerLabel: currentRow.provider_label,
          modelLabel: currentRow.model_label,
          accountBoundaryLabel: currentRow.account_boundary_label,
          dataBoundary: currentRow.data_boundary,
        });
      if (
        !identity ||
        identity.status !== "released" ||
        identity.profile_id !== command.profileId ||
        identity.release_id !== command.releaseId ||
        releaseRow?.id !== command.releaseId
      ) {
        throw new OutboundSafetyError("outbound_release_invalid", {
          requestId: command.requestId,
        });
      }
      let storedSnapshot: OutboundDestinationSnapshot;
      try {
        storedSnapshot = outboundDestinationSnapshotSchema.parse(
          JSON.parse(identity.destination_snapshot_json),
        );
      } catch {
        throw new OutboundSafetyError("outbound_release_invalid", {
          requestId: command.requestId,
        });
      }
      if (
        identity.destination_id !== expectedDestination.id ||
        identity.destination_revision !== expectedDestination.revision ||
        !equalJson(storedSnapshot, expectedDestination) ||
        currentRow?.status !== "enabled" ||
        currentDestination === null ||
        !equalJson(currentDestination, expectedDestination)
      ) {
        throw new OutboundSafetyError("outbound_destination_changed", {
          requestId: command.requestId,
          expectedRevision: expectedDestination.revision,
          currentRevision: currentDestination?.revision ??
            expectedDestination.revision,
        });
      }
      writeAudit(command.audit, {
        projectId: identity.project_id,
        profileId: command.profileId,
        actorType: "profile",
        authorityMode: null,
        scopeDecision: "outbound_safety",
        actionCategory: "outbound_release_retrieved",
        targetId: command.requestId,
        idempotencyKey: null,
        reason: "release_retrieved",
      });
    },
  );

  const disablePolicyTransaction = database.transaction(
    (command: DisableOutboundPolicyCommand): void => {
      const scope = outboundPolicyScopeSchema.parse(command.scope);
      timestampSchema.parse(command.disabledAt);
      assertPolicyScopeIsValid(scope);
      upsertPolicy.run({
        ...scope,
        mode: "manual",
        createdAt: command.disabledAt,
        updatedAt: command.disabledAt,
      });
      writeAudit(command.audit, {
        projectId: scope.projectId,
        profileId: null,
        actorType: "local_human",
        authorityMode: "human",
        scopeDecision: "human_admin",
        actionCategory: "outbound_policy_disabled",
        targetId: scope.projectId,
        idempotencyKey: null,
        reason: "policy_disabled",
      });
    },
  );

  return {
    resolveIdempotency(
      profileId: string,
      key: string,
    ): StoredOutboundRequest | null {
      return normalizeStoreFailure(() => {
        const row = selectIdempotency.get(profileId, key) as
          | OutboundRequestRow
          | undefined;
        return row ? mapRequestRow(row) : null;
      });
    },

    createRequest(command: CreateOutboundRequestCommand): StoredOutboundRequest {
      return normalizeStoreFailure(
        () => createRequestTransaction.immediate(command),
      );
    },

    getRequest(requestId: string): StoredOutboundRequest | null {
      return normalizeStoreFailure(() => storedRequest(requestId));
    },

    listRequests(filter: OutboundRequestFilter): OutboundRequestSummary[] {
      return normalizeStoreFailure(() => {
        const parsed = outboundRequestFilterSchema.parse(filter);
        const clauses: string[] = [];
        const parameters: unknown[] = [];
        if (parsed.profileId !== undefined) {
          clauses.push("requests.profile_id = ?");
          parameters.push(parsed.profileId);
        }
        if (parsed.projectId !== undefined) {
          clauses.push("requests.project_id = ?");
          parameters.push(parsed.projectId);
        }
        if (parsed.status !== undefined) {
          clauses.push("requests.status = ?");
          parameters.push(parsed.status);
        }
        const where = clauses.length === 0
          ? ""
          : `WHERE ${clauses.join(" AND ")}`;
        const rows = database.prepare(`
          SELECT ${requestColumns}
          ${requestFrom}
          ${where}
          ORDER BY requests.created_at DESC, requests.id DESC
        `).all(...parameters) as OutboundRequestRow[];
        return rows.map((row) => toRequestSummary(mapRequestRow(row)));
      });
    },

    getFindings(requestId: string): OutboundFinding[] {
      return normalizeStoreFailure(
        () => (selectFindings.all(requestId) as OutboundFindingRow[])
          .map(mapFindingRow),
      );
    },

    approve(command: ApproveStoredOutboundRequestCommand): OutboundRelease {
      return normalizeStoreFailure(() => approveTransaction.immediate(command));
    },

    deny(command: DenyStoredOutboundRequestCommand): StoredOutboundRequest {
      return normalizeStoreFailure(() => denyTransaction.immediate(command));
    },

    getReleaseForRequest(requestId: string): OutboundRelease | null {
      return normalizeReleaseFailure(requestId, () => {
        const row = selectRelease.get(requestId) as
          | OutboundReleaseRow
          | undefined;
        return row ? mapReleaseRow(row) : null;
      });
    },

    recordRetrieval(command: RecordOutboundRetrievalCommand): void {
      normalizeStoreFailure(() => recordRetrievalTransaction.immediate(command));
    },

    getPolicy(scope: OutboundPolicyScope): OutboundPolicy | null {
      return normalizeStoreFailure(() => {
        const parsed = outboundPolicyScopeSchema.parse(scope);
        const row = selectPolicy.get(parsed) as OutboundPolicyRow | undefined;
        return row ? mapPolicyRow(row) : null;
      });
    },

    disablePolicy(command: DisableOutboundPolicyCommand): void {
      normalizeStoreFailure(() => disablePolicyTransaction.immediate(command));
    },
  };
};
