import { afterEach, describe, expect, it } from "vitest";
import {
  neutralHierarchyVocabulary,
  type OutboundFinding,
  type OutboundFindingCounts,
  type OutboundRelease,
  type TaskContextPack,
} from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import {
  computeOutboundRequestHash,
  computeOutboundReleaseDigest,
  createOutboundSafetyEngine,
} from "../outbound/safety-engine.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createContextPackStore } from "./context-pack-store.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import {
  createOutboundContextStore,
  type CreateOutboundRequestCommand,
  type OutboundAudit,
  type OutboundPolicy,
  type StoredOutboundRequest,
} from "./outbound-context-store.js";

const timestamp = "2026-07-27T10:00:00.000Z";
const secondTimestamp = "2026-07-27T10:01:00.000Z";
const secret = "synthetic-secret-value";
const sha = "a".repeat(64);

const taskRecord = {
  id: "task-1",
  projectId: "project-1",
  kind: "task" as const,
  status: "active" as const,
  title: "Store outbound state",
  body: `Never persist ${secret} as a matched value.`,
  sourceKind: "human" as const,
  sourceRef: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const pack: TaskContextPack = {
  id: "pack-1",
  projectId: "project-1",
  taskId: "task-1",
  projectRevision: 1,
  generatedAt: timestamp,
  budgetTokens: 4000,
  estimatedTokens: 120,
  hierarchyVocabulary: neutralHierarchyVocabulary,
  stableFrame: [],
  task: {
    record: taskRecord,
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  },
  related: [],
  omissions: [],
  sourceRevisions: [{ recordId: "task-1", revision: 1 }],
};

const destination = {
  id: "destination-1",
  revision: 1,
  clientLabel: "Claude Code laptop",
  type: "ide_managed" as const,
  providerLabel: "Anthropic",
  modelLabel: null,
  accountBoundaryLabel: "personal subscription",
  dataBoundary: "remote" as const,
};

const emptyCounts: OutboundFindingCounts = {
  total: 0,
  credential: 0,
  sensitive: 0,
  forcedRedact: 0,
  redactByDefault: 0,
  redacted: 0,
  includedOnce: 0,
};

const findingCounts: OutboundFindingCounts = {
  total: 1,
  credential: 0,
  sensitive: 1,
  forcedRedact: 0,
  redactByDefault: 1,
  redacted: 1,
  includedOnce: 0,
};

const finding: OutboundFinding = {
  id: "finding-1",
  ordinal: 0,
  detectorId: "email-detector",
  detectorVersion: "1",
  category: "email",
  confidence: "possible",
  severity: "sensitive",
  path: "/task/record/body",
  start: 14,
  end: 36,
  findingKey: "b".repeat(64),
  requiredAction: "redact_by_default",
  decision: null,
};

const audit = (
  id: string,
  _actionCategory = "outbound_request_created",
): OutboundAudit => ({
  id,
  createdAt: timestamp,
});

const request = (
  overrides: Partial<StoredOutboundRequest> = {},
): StoredOutboundRequest => ({
  requestId: "request-1",
  profileId: "profile-1",
  projectId: "project-1",
  taskId: "task-1",
  sourcePackId: "pack-1",
  idempotencyKey: "request-key",
  requestHash: sha,
  destination,
  detectorVersion: "1",
  safetyPolicyVersion: "1",
  candidateDigest: "c".repeat(64),
  status: "review_required",
  findingCounts,
  decisionActor: null,
  decisionReason: null,
  releaseId: null,
  createdAt: timestamp,
  decidedAt: null,
  projectRevision: 1,
  budgetTokens: 4000,
  originalEstimatedTokens: 120,
  ...overrides,
});

const release = (
  overrides: Partial<OutboundRelease> = {},
): OutboundRelease => {
  const provisional: OutboundRelease = {
    releaseId: "release-1",
    requestId: "request-1",
    sourcePackId: "pack-1",
    releasedAt: secondTimestamp,
    sha256: "d".repeat(64),
    disclosure: {
      destination,
      sourcePackId: "pack-1",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 1,
      sourceRecords: [{
        recordId: "task-1",
        kind: "task",
        revision: 1,
        sourceKind: "human",
        sourceRef: null,
      }],
      omissions: [],
      requestedBudgetTokens: 4000,
      originalEstimatedTokens: 120,
      releasedEstimatedTokens: 80,
      findingCounts: {
        ...findingCounts,
        redacted: 1,
      },
      detectorVersion: "1",
      safetyPolicyVersion: "1",
      releaseDigest: "d".repeat(64),
      releasedAt: secondTimestamp,
    },
    pack: {
      ...pack,
      task: {
        ...pack.task,
        record: {
          ...pack.task.record,
          body: "Never persist [REDACTED:SENSITIVE] as a matched value.",
        },
      },
    },
    ...overrides,
  };
  const digest = computeOutboundReleaseDigest(provisional);
  return {
    ...provisional,
    sha256: digest,
    disclosure: {
      ...provisional.disclosure,
      releaseDigest: digest,
    },
  };
};

const policy: OutboundPolicy = {
  profileId: "profile-1",
  projectId: "project-1",
  destinationId: "destination-1",
  destinationRevision: 1,
  detectorVersion: "1",
  safetyPolicyVersion: "1",
  mode: "auto_release_clean",
  createdAt: secondTimestamp,
  updatedAt: secondTimestamp,
};

describe("outbound context store", () => {
  let database: IntentArcDatabase | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
  });

  const setup = (): {
    database: IntentArcDatabase;
    store: ReturnType<typeof createOutboundContextStore>;
  } => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (
        'project-1', 'IntentArc', 1, NULL, '${timestamp}', '${timestamp}'
      );
      INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at,
        token_rotated_at, last_used_at
      ) VALUES (
        'profile-1', 'Build agent', 'enabled', '${"e".repeat(64)}',
        '${timestamp}', '${timestamp}', '${timestamp}', NULL
      );
      INSERT INTO project_records (
        id, project_id, kind, status, title, body, source_kind, source_ref,
        revision, created_at, updated_at
      ) VALUES (
        'task-1', 'project-1', 'task', 'active', 'Store outbound state',
        'Never persist ${secret} as a matched value.',
        'human', NULL, 1, '${timestamp}', '${timestamp}'
      );
      INSERT INTO outbound_destinations (
        destination_id, revision, profile_id, client_label, destination_type,
        provider_label, model_label, account_boundary_label, data_boundary,
        status, is_current, created_at, updated_at
      ) VALUES (
        'destination-1', 1, 'profile-1', 'Claude Code laptop', 'ide_managed',
        'Anthropic', NULL, 'personal subscription', 'remote',
        'enabled', 1, '${timestamp}', '${timestamp}'
      );
    `);
    database.prepare(`
      INSERT INTO project_record_revisions (
        record_id, revision, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      "task-1",
      1,
      JSON.stringify(taskRecord),
      timestamp,
    );
    createContextPackStore(database).save(pack);
    return { database, store: createOutboundContextStore(database) };
  };

  const create = (
    store: ReturnType<typeof createOutboundContextStore>,
    overrides: Partial<CreateOutboundRequestCommand> = {},
  ): StoredOutboundRequest => store.createRequest({
    request: request(),
    findings: [finding],
    release: null,
    audit: audit("audit-create"),
    scanAudit: audit("audit-scan"),
    auditActor: { actorType: "profile", profileId: "profile-1" },
    ...overrides,
  });

  it("atomically creates a strict request, plaintext-free findings, and audit", () => {
    const { database: db, store } = setup();

    expect(create(store)).toEqual(request());
    expect(store.getFindings("request-1")).toEqual([finding]);
    expect(JSON.stringify(db.prepare(`
      SELECT findings.*, audits.*
      FROM outbound_findings AS findings
      JOIN audit_events AS audits ON audits.target_id = findings.request_id
    `).all())).not.toContain(secret);
    expect(db.prepare(`
      SELECT project_id, actor_type, profile_id, authority_mode,
             scope_decision, action_category, target_id, idempotency_key,
             outcome, reason
      FROM audit_events WHERE id = 'audit-create'
    `).get()).toEqual({
      project_id: "project-1",
      actor_type: "profile",
      profile_id: "profile-1",
      authority_mode: null,
      scope_decision: "outbound_safety",
      action_category: "outbound_request_created",
      target_id: "request-1",
      idempotency_key: null,
      outcome: "applied",
      reason: "request_status:review_required",
    });
    expect(db.prepare(`
      SELECT action_category, target_id, idempotency_key, reason
      FROM audit_events WHERE id = 'audit-scan'
    `).get()).toEqual({
      action_category: "outbound_scan_completed",
      target_id: "request-1",
      idempotency_key: null,
      reason:
        "scan_completed:total:1;credential:0;sensitive:1;" +
        "forced_redact:0;redact_by_default:1;detector_version:1;" +
        "safety_policy_version:1;destination_revision:1",
    });
  });

  it("records local-human request and scan actors without a destination profile identity", () => {
    const { database: db, store } = setup();

    create(store, {
      auditActor: { actorType: "local_human", profileId: null },
    });

    expect(db.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events
      WHERE id IN ('audit-create', 'audit-scan')
      ORDER BY id
    `).all()).toEqual([
      {
        actor_type: "local_human",
        profile_id: null,
        action_category: "outbound_request_created",
      },
      {
        actor_type: "local_human",
        profile_id: null,
        action_category: "outbound_scan_completed",
      },
    ]);
  });

  it("rejects a profile audit actor that does not match the destination profile", () => {
    const { database: db, store } = setup();

    expect(() => create(store, {
      auditActor: { actorType: "profile", profileId: "profile-2" },
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_findings) AS findings,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ requests: 0, findings: 0, audits: 0 });
  });

  it("persists a recomputable pending scan that passes full integrity", () => {
    const { database: db, store } = setup();
    const scan = createOutboundSafetyEngine().scan(pack, destination);
    const pendingCounts = {
      total: scan.findings.length,
      credential: scan.findings.filter(
        ({ severity }) => severity === "credential",
      ).length,
      sensitive: scan.findings.filter(
        ({ severity }) => severity === "sensitive",
      ).length,
      forcedRedact: scan.findings.filter(
        ({ requiredAction }) => requiredAction === "forced_redact",
      ).length,
      redactByDefault: scan.findings.filter(
        ({ requiredAction }) => requiredAction === "redact_by_default",
      ).length,
      redacted: scan.findings.length,
      includedOnce: 0,
    };

    expect(create(store, {
      request: request({
        findingCounts: pendingCounts,
        requestHash: computeOutboundRequestHash({
          projectId: pack.projectId,
          taskId: pack.taskId,
          budgetTokens: pack.budgetTokens,
          destinationId: destination.id,
          destinationRevision: destination.revision,
          detectorVersion: scan.detectorVersion,
          safetyPolicyVersion: scan.safetyPolicyVersion,
        }),
        candidateDigest: scan.candidateDigest,
      }),
      findings: scan.findings,
    })).toMatchObject({ findingCounts: pendingCounts });
    expect(createIntegrityChecker().checkConnection(db, "full")).toMatchObject({
      passed: true,
      issues: [],
    });
  });

  it("rejects non-contiguous finding ordinals without partial state", () => {
    const { database: db, store } = setup();

    expect(() => create(store, {
      findings: [{ ...finding, ordinal: 2 }],
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_findings) AS findings,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ requests: 0, findings: 0, audits: 0 });
  });

  it("rejects a destination snapshot that differs from its stored revision", () => {
    const { database: db, store } = setup();

    expect(() => create(store, {
      request: request({
        destination: {
          ...destination,
          providerLabel: "Mismatched provider",
        },
      }),
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_requests").get())
      .toEqual({ count: 0 });
  });

  it("rejects a destination revision owned by another profile", () => {
    const { database: db, store } = setup();
    db.prepare(`
      INSERT INTO client_profiles (
        id, name, status, token_hash, created_at, updated_at,
        token_rotated_at, last_used_at
      ) VALUES (
        'profile-2', 'Other agent', 'enabled', ?, ?, ?, ?, NULL
      )
    `).run("f".repeat(64), timestamp, timestamp, timestamp);

    expect(() => create(store, {
      request: request({
        profileId: "profile-2",
        idempotencyKey: "profile-2-key",
      }),
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_requests").get())
      .toEqual({ count: 0 });
  });

  it("rejects caller-controlled audit prose and rolls back request state", () => {
    const { database: db, store } = setup();

    expect(() => create(store, {
      audit: {
        ...audit("audit-unsafe"),
        actorType: "local_human",
        profileId: null,
        projectId: null,
        actionCategory: "caller_controlled",
        targetId: "wrong-target",
        reason: secret,
      } as unknown as OutboundAudit,
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(JSON.stringify(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_findings) AS findings,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get())).not.toContain(secret);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_findings) AS findings,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ requests: 0, findings: 0, audits: 0 });
  });

  it("rejects a released create whose disclosure does not match its request", () => {
    const { database: db, store } = setup();
    const mismatchedRelease = release({
      disclosure: {
        ...release().disclosure,
        projectId: "project-other",
      },
    });

    expect(() => store.createRequest({
      request: request({
        status: "released",
        findingCounts: {
          ...findingCounts,
          redacted: 1,
        },
        decisionActor: "policy",
        decisionReason: "auto_release_clean",
        releaseId: "release-1",
        decidedAt: secondTimestamp,
      }),
      findings: [{ ...finding, decision: "redact" }],
      release: mismatchedRelease,
      audit: audit("audit-create"),
      scanAudit: audit("audit-scan"),
      auditActor: { actorType: "profile", profileId: "profile-1" },
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_releases) AS releases,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ requests: 0, releases: 0, audits: 0 });
  });

  it("rolls back request, findings, and release when the audit cannot commit", () => {
    const { database: db, store } = setup();
    db.prepare(`
      INSERT INTO audit_events (
        id, project_id, actor_type, profile_id, authority_mode, scope_decision,
        action_category, target_id, idempotency_key, revision_before,
        revision_after, outcome, reason, created_at
      ) VALUES (
        'audit-create', NULL, 'local_human', NULL, NULL, NULL,
        'existing', NULL, NULL, NULL, NULL, 'applied', NULL, ?
      )
    `).run(timestamp);

    expect(() => create(store)).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM outbound_findings) AS findings,
        (SELECT COUNT(*) FROM outbound_releases) AS releases
    `).get()).toEqual({ requests: 0, findings: 0, releases: 0 });
  });

  it("resolves exact profile idempotency and lists safe newest-first filters", () => {
    const { store } = setup();
    create(store);
    store.createRequest({
      request: request({
        requestId: "request-2",
        idempotencyKey: "second-key",
        status: "denied",
        findingCounts: emptyCounts,
        decisionActor: "local_human",
        decisionReason: "denied",
        createdAt: secondTimestamp,
        decidedAt: secondTimestamp,
      }),
      findings: [],
      release: null,
      audit: {
        ...audit("audit-second"),
      },
      scanAudit: audit("audit-second-scan"),
      auditActor: { actorType: "profile", profileId: "profile-1" },
    });

    expect(store.resolveIdempotency("profile-1", "request-key")).toEqual(request());
    expect(store.resolveIdempotency("profile-1", "missing")).toBeNull();
    expect(store.listRequests({
      profileId: "profile-1",
      projectId: "project-1",
      status: "denied",
    })).toEqual([expect.objectContaining({ requestId: "request-2" })]);
    expect(store.listRequests({}).map(({ requestId }) => requestId)).toEqual([
      "request-2",
      "request-1",
    ]);
  });

  it("approves by compare-and-set with finding decisions, release, and audit", () => {
    const { database: db, store } = setup();
    create(store);

    expect(store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    })).toEqual(release());
    expect(store.getRequest("request-1")).toMatchObject({
      status: "released",
      releaseId: "release-1",
      decisionActor: "local_human",
      decisionReason: "approved",
      findingCounts: {
        ...findingCounts,
        redacted: 1,
      },
    });
    expect(store.getFindings("request-1")).toEqual([{
      ...finding,
      decision: "redact",
    }]);
    expect(db.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events WHERE id = 'audit-approve'
    `).get()).toEqual({
      actor_type: "local_human",
      profile_id: null,
      action_category: "outbound_request_approved",
    });
  });

  it("persists a real safety-engine release with a separately computed released estimate", () => {
    const { store } = setup();
    const engine = createOutboundSafetyEngine();
    const scan = engine.scan(pack, destination);
    const engineRelease = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: secondTimestamp,
    });
    const pendingCounts = {
      ...engineRelease.disclosure.findingCounts,
    };
    store.createRequest({
      request: request({
        candidateDigest: scan.candidateDigest,
        detectorVersion: scan.detectorVersion,
        safetyPolicyVersion: scan.safetyPolicyVersion,
        findingCounts: pendingCounts,
      }),
      findings: scan.findings,
      release: null,
      audit: audit("audit-create"),
      scanAudit: audit("audit-scan"),
      auditActor: { actorType: "profile", profileId: "profile-1" },
    });

    expect(engineRelease.disclosure.releasedEstimatedTokens)
      .not.toBe(engineRelease.pack.estimatedTokens);
    expect(store.approve({
      requestId: "request-1",
      decisions: scan.findings.map(({ id }) => ({
        findingId: id,
        decision: "redact" as const,
      })),
      release: engineRelease,
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-engine-approve", "outbound_request_approved"),
    })).toEqual(engineRelease);
  });

  it("persists an optional exact-scope policy only with a clean approval", () => {
    const { store } = setup();
    store.createRequest({
      request: request({ findingCounts: emptyCounts }),
      findings: [],
      release: null,
      audit: audit("audit-create"),
      scanAudit: audit("audit-scan"),
      auditActor: { actorType: "profile", profileId: "profile-1" },
    });
    const cleanRelease = release({
      disclosure: {
        ...release().disclosure,
        findingCounts: emptyCounts,
        releasedEstimatedTokens: pack.estimatedTokens,
      },
      pack,
    });

    store.approve({
      requestId: "request-1",
      decisions: [],
      release: cleanRelease,
      policy,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
      policyAudit: audit("audit-policy", "outbound_policy_enabled"),
    });

    expect(store.getPolicy({
      profileId: "profile-1",
      projectId: "project-1",
      destinationId: "destination-1",
      destinationRevision: 1,
      detectorVersion: "1",
      safetyPolicyVersion: "1",
    })).toEqual(policy);
  });

  it("rejects incomplete decisions, mismatched disclosure counts, and invalid release digests", () => {
    const cases: Array<{
      name: string;
      decisions: Array<{ findingId: string; decision: "redact" }>;
      terminalRelease: OutboundRelease;
    }> = [
      {
        name: "incomplete decisions",
        decisions: [],
        terminalRelease: release(),
      },
      {
        name: "mismatched disclosure counts",
        decisions: [{ findingId: "finding-1", decision: "redact" }],
        terminalRelease: release({
          disclosure: {
            ...release().disclosure,
            findingCounts: emptyCounts,
          },
        }),
      },
      {
        name: "invalid digest",
        decisions: [{ findingId: "finding-1", decision: "redact" }],
        terminalRelease: {
          ...release(),
          sha256: "f".repeat(64),
        },
      },
    ];

    for (const testCase of cases) {
      const { database: db, store } = setup();
      create(store);

      expect(() => store.approve({
        requestId: "request-1",
        decisions: testCase.decisions,
        release: testCase.terminalRelease,
        policy: null,
        decisionActor: "local_human",
        decisionReason: testCase.name.replaceAll(" ", "_"),
        decidedAt: secondTimestamp,
        audit: audit(`audit-${testCase.name}`, "outbound_request_approved"),
      }), testCase.name).toThrowError(expect.objectContaining({
        code: "outbound_safety_failed",
      }));
      expect(store.getRequest("request-1"), testCase.name).toMatchObject({
        status: "review_required",
        releaseId: null,
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM outbound_releases",
      ).get(), testCase.name).toEqual({ count: 0 });

      database?.close();
      database = undefined;
      removeTemporaryDatabase(temporaryDatabase!);
      temporaryDatabase = undefined;
    }
  });

  it("rolls back every approval side effect when its audit fails", () => {
    const { database: db, store } = setup();
    create(store);

    expect(() => store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-create", "outbound_request_approved"),
    })).toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
    expect(store.getRequest("request-1")).toMatchObject({
      status: "review_required",
      releaseId: null,
    });
    expect(store.getFindings("request-1")).toEqual([finding]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_releases").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_policies").get())
      .toEqual({ count: 0 });
  });

  it("permits exactly one approve-or-deny terminal transition", () => {
    const { store } = setup();
    create(store);
    store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    });

    expect(() => store.deny({
      requestId: "request-1",
      decisionActor: "local_human",
      decisionReason: "denied",
      decidedAt: "2026-07-27T10:02:00.000Z",
      audit: audit("audit-deny", "outbound_request_denied"),
    })).toThrowError(expect.objectContaining({
      name: "OutboundSafetyError",
      code: "outbound_request_conflict",
      details: { requestId: "request-1" },
    }));
  });

  it("denies without creating a release", () => {
    const { database: db, store } = setup();
    create(store);

    expect(store.deny({
      requestId: "request-1",
      decisionActor: "local_human",
      decisionReason: "denied",
      decidedAt: secondTimestamp,
      audit: audit("audit-deny", "outbound_request_denied"),
    })).toMatchObject({
      requestId: "request-1",
      status: "denied",
      releaseId: null,
    });
    expect(store.getReleaseForRequest("request-1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_releases").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events WHERE id = 'audit-deny'
    `).get()).toEqual({
      actor_type: "local_human",
      profile_id: null,
      action_category: "outbound_request_denied",
    });
  });

  it("reads the exact immutable release artifact", () => {
    const { database: db, store } = setup();
    create(store);
    store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    });

    expect(store.getReleaseForRequest("request-1")).toEqual(release());
    expect(() => db.prepare(`
      UPDATE outbound_releases SET sha256 = ? WHERE id = 'release-1'
    `).run("f".repeat(64))).toThrow(/immutable/);
    expect(store.getReleaseForRequest("request-1")).toEqual(release());
  });

  it("preserves a pre-v11 release's missing vocabulary marker for legacy digest verification", () => {
    const { database: db, store } = setup();
    create(store);
    const legacyRelease = release();
    const {
      hierarchyVocabulary: _legacyMissingVocabulary,
      ...legacyPack
    } = legacyRelease.pack;

    db.prepare(`
      INSERT INTO outbound_releases (
        id, request_id, source_pack_id, content_json, disclosure_json,
        sha256, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "release-pre-v11",
      legacyRelease.requestId,
      legacyRelease.sourcePackId,
      JSON.stringify(legacyPack),
      JSON.stringify({
        ...legacyRelease.disclosure,
        releaseDigest: "d".repeat(64),
      }),
      "d".repeat(64),
      legacyRelease.releasedAt,
    );

    const storedRelease = store.getReleaseForRequest(legacyRelease.requestId);

    expect(storedRelease).not.toBeNull();
    expect(Object.hasOwn(
      storedRelease!.pack,
      "hierarchyVocabulary",
    )).toBe(false);
  });

  it("commits a privacy-safe retrieval audit before signaling success", () => {
    const { database: db, store } = setup();
    create(store);
    store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    });

    store.recordRetrieval({
      requestId: "request-1",
      releaseId: "release-1",
      profileId: "profile-1",
      destination,
      audit: {
        ...audit("audit-retrieval", "outbound_release_retrieved"),
      },
    });
    const retrieval = db.prepare(`
      SELECT action_category, target_id, reason
      FROM audit_events WHERE id = 'audit-retrieval'
    `).get();
    expect(retrieval).toEqual({
      action_category: "outbound_release_retrieved",
      target_id: "request-1",
      reason: "release_retrieved",
    });
    expect(JSON.stringify(retrieval)).not.toContain(secret);

    expect(() => store.recordRetrieval({
      requestId: "request-1",
      releaseId: "release-1",
      profileId: "profile-1",
      destination,
      audit: {
        ...audit("audit-retrieval", "outbound_release_retrieved"),
      },
    })).toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
  });

  it("rejects retrieval when the destination changes between service validation and store audit", () => {
    const { database: db, store } = setup();
    create(store);
    store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    });
    db.transaction(() => {
      db.prepare(`
        UPDATE outbound_destinations SET is_current = 0
        WHERE profile_id = 'profile-1' AND is_current = 1
      `).run();
      db.prepare(`
        INSERT INTO outbound_destinations (
          destination_id, revision, profile_id, client_label, destination_type,
          provider_label, model_label, account_boundary_label, data_boundary,
          status, is_current, created_at, updated_at
        ) VALUES (
          'destination-1', 2, 'profile-1', 'Changed client', 'ide_managed',
          'Changed provider', NULL, NULL, 'remote',
          'enabled', 1, ?, ?
        )
      `).run(secondTimestamp, secondTimestamp);
    })();

    expect(() => store.recordRetrieval({
      requestId: "request-1",
      releaseId: "release-1",
      profileId: "profile-1",
      destination,
      audit: audit("audit-stale-retrieval", "outbound_release_retrieved"),
    })).toThrowError(expect.objectContaining({
      code: "outbound_destination_changed",
      details: {
        requestId: "request-1",
        expectedRevision: 1,
        currentRevision: 2,
      },
    }));
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE id = 'audit-stale-retrieval'
    `).get()).toEqual({ count: 0 });
  });

  it("holds the retrieval destination check and audit under one writer lock", () => {
    const { database: db, store } = setup();
    create(store);
    store.approve({
      requestId: "request-1",
      decisions: [{ findingId: "finding-1", decision: "redact" }],
      release: release(),
      policy: null,
      decisionActor: "local_human",
      decisionReason: "approved",
      decidedAt: secondTimestamp,
      audit: audit("audit-approve", "outbound_request_approved"),
    });
    let barrierArrivals = 0;
    let blockedConcurrentWrites = 0;
    db.function("retrieval_race_barrier", () => {
      barrierArrivals += 1;
      const contender = openDatabase(temporaryDatabase!.path);
      try {
        contender.pragma("busy_timeout = 0");
        contender.prepare(`
          UPDATE outbound_destinations SET is_current = 0
          WHERE profile_id = 'profile-1' AND is_current = 1
        `).run();
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "SQLITE_BUSY"
        ) {
          blockedConcurrentWrites += 1;
        } else {
          throw error;
        }
      } finally {
        contender.close();
      }
      return 0;
    });
    db.exec(`
      CREATE TEMP TRIGGER retrieval_race_barrier_trigger
      BEFORE INSERT ON audit_events
      WHEN NEW.action_category = 'outbound_release_retrieved'
      BEGIN
        SELECT retrieval_race_barrier();
      END
    `);

    store.recordRetrieval({
      requestId: "request-1",
      releaseId: "release-1",
      profileId: "profile-1",
      destination,
      audit: audit("audit-locked-retrieval", "outbound_release_retrieved"),
    });

    expect({ barrierArrivals, blockedConcurrentWrites }).toEqual({
      barrierArrivals: 1,
      blockedConcurrentWrites: 1,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE id = 'audit-locked-retrieval'
    `).get()).toEqual({ count: 1 });
  });

  it("looks up policies only by the complete exact scope", () => {
    const { store } = setup();
    store.disablePolicy({
      scope: {
        profileId: "profile-1",
        projectId: "project-1",
        destinationId: "destination-1",
        destinationRevision: 1,
        detectorVersion: "1",
        safetyPolicyVersion: "1",
      },
      disabledAt: secondTimestamp,
      audit: audit("audit-disable", "outbound_policy_disabled"),
    });

    expect(store.getPolicy({
      profileId: "profile-1",
      projectId: "project-1",
      destinationId: "destination-1",
      destinationRevision: 1,
      detectorVersion: "1",
      safetyPolicyVersion: "1",
    })).toMatchObject({ mode: "manual" });
    expect(store.getPolicy({
      profileId: "profile-1",
      projectId: "project-1",
      destinationId: "destination-1",
      destinationRevision: 1,
      detectorVersion: "1",
      safetyPolicyVersion: "policy-v2",
    })).toBeNull();
  });

  it("disables policy and writes its audit atomically", () => {
    const { database: db, store } = setup();
    store.disablePolicy({
      scope: {
        profileId: "profile-1",
        projectId: "project-1",
        destinationId: "destination-1",
        destinationRevision: 1,
        detectorVersion: "1",
        safetyPolicyVersion: "1",
      },
      disabledAt: secondTimestamp,
      audit: audit("audit-disable", "outbound_policy_disabled"),
    });

    expect(store.getPolicy({
      profileId: "profile-1",
      projectId: "project-1",
      destinationId: "destination-1",
      destinationRevision: 1,
      detectorVersion: "1",
      safetyPolicyVersion: "1",
    })).toEqual({ ...policy, mode: "manual" });
    expect(db.prepare(`
      SELECT actor_type, profile_id, action_category
      FROM audit_events WHERE id = 'audit-disable'
    `).get()).toEqual({
      actor_type: "local_human",
      profile_id: null,
      action_category: "outbound_policy_disabled",
    });
  });

  it.each([
    "unsupported_version",
    "wrong_profile",
    "historical_revision",
  ] as const)("rejects an integrity-invalid policy scope: %s", (scenario) => {
    const { database: db, store } = setup();
    const scope = {
      profileId: "profile-1",
      projectId: "project-1",
      destinationId: "destination-1",
      destinationRevision: 1,
      detectorVersion: "1",
      safetyPolicyVersion: "1",
    };
    if (scenario === "unsupported_version") {
      scope.safetyPolicyVersion = "unsupported";
    } else if (scenario === "wrong_profile") {
      db.prepare(`
        INSERT INTO client_profiles (
          id, name, status, token_hash, created_at, updated_at,
          token_rotated_at, last_used_at
        ) VALUES (
          'profile-2', 'Other agent', 'enabled', ?, ?, ?, ?, NULL
        )
      `).run("f".repeat(64), timestamp, timestamp, timestamp);
      scope.profileId = "profile-2";
    } else {
      db.exec(`
        UPDATE outbound_destinations SET is_current = 0
        WHERE profile_id = 'profile-1';
        INSERT INTO outbound_destinations (
          destination_id, revision, profile_id, client_label, destination_type,
          provider_label, model_label, account_boundary_label, data_boundary,
          status, is_current, created_at, updated_at
        ) VALUES (
          'destination-1', 2, 'profile-1', 'Claude Code laptop', 'ide_managed',
          'Anthropic', NULL, 'personal subscription', 'remote',
          'enabled', 1, '${secondTimestamp}', '${secondTimestamp}'
        );
      `);
    }

    expect(() => store.disablePolicy({
      scope,
      disabledAt: secondTimestamp,
      audit: audit(`audit-${scenario}`, "outbound_policy_disabled"),
    })).toThrowError(expect.objectContaining({
      code: "outbound_safety_failed",
    }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_policies) AS policies,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ policies: 0, audits: 0 });
  });

  it("normalizes corrupt stored JSON and mapper failures to a canonical safe error", () => {
    const { database: db, store } = setup();
    create(store);
    db.prepare(`
      UPDATE outbound_requests
      SET destination_snapshot_json = '{"clientLabel":"corrupt"}'
      WHERE id = 'request-1'
    `).run();

    let thrown: unknown;
    try {
      store.getRequest("request-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OutboundSafetyError);
    expect(thrown).toMatchObject({
      code: "outbound_safety_failed",
      details: {},
      message: "Outbound safety processing failed.",
    });
    expect(JSON.stringify(thrown)).not.toContain("clientLabel");
  });

  it("rejects a released create without a release and leaves no partial state", () => {
    const { database: db, store } = setup();

    expect(() => store.createRequest({
      request: request({
        status: "released",
        releaseId: "release-1",
        decidedAt: timestamp,
        decisionActor: "policy",
        decisionReason: "auto_release_clean",
      }),
      findings: [finding],
      release: null,
      audit: audit("audit-create"),
      scanAudit: audit("audit-scan"),
      auditActor: { actorType: "profile", profileId: "profile-1" },
    })).toThrowError(expect.objectContaining({ code: "outbound_safety_failed" }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outbound_requests) AS requests,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get()).toEqual({ requests: 0, audits: 0 });
  });
});
