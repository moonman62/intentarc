import { describe, expect, it } from "vitest";
import {
  approveOutboundRequestInputSchema,
  getReleasedContextResultSchema,
  outboundDestinationSchema,
  outboundFindingSchema,
  outboundReleaseSchema,
  outboundRequestFilterSchema,
  requestTaskContextInputSchema,
  setOutboundDestinationInputSchema,
} from "./index.js";

const timestamp = "2026-07-27T00:00:00.000Z";
const digest = "a".repeat(64);

const pack = {
  id: "pack-1",
  projectId: "project-1",
  taskId: "task-1",
  projectRevision: 1,
  generatedAt: timestamp,
  budgetTokens: 4000,
  estimatedTokens: 320,
  stableFrame: [],
  task: {
    record: {
      id: "task-1",
      projectId: "project-1",
      kind: "task" as const,
      status: "active" as const,
      title: "Safe outbound context",
      body: "Synthetic task content.",
      sourceKind: "human" as const,
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    mandatory: true,
    relevance: "active_task" as const,
    relationshipKind: null,
  },
  related: [],
  omissions: [],
  sourceRevisions: [{ recordId: "task-1", revision: 1 }],
};

const destination = {
  id: "destination-1",
  profileId: "profile-1",
  revision: 1,
  clientLabel: "Codex workstation",
  type: "ide_managed" as const,
  providerLabel: "OpenAI",
  modelLabel: null,
  accountBoundaryLabel: null,
  dataBoundary: "remote" as const,
  status: "enabled" as const,
  current: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const destinationSnapshot = {
  id: destination.id,
  revision: destination.revision,
  clientLabel: destination.clientLabel,
  type: destination.type,
  providerLabel: destination.providerLabel,
  modelLabel: destination.modelLabel,
  accountBoundaryLabel: destination.accountBoundaryLabel,
  dataBoundary: destination.dataBoundary,
};

const findingCounts = {
  total: 1,
  credential: 0,
  sensitive: 1,
  forcedRedact: 0,
  redactByDefault: 1,
  redacted: 1,
  includedOnce: 0,
};

const requestSummary = {
  requestId: "request-1",
  profileId: "profile-1",
  projectId: "project-1",
  taskId: "task-1",
  sourcePackId: "pack-1",
  destination: destinationSnapshot,
  status: "review_required" as const,
  projectRevision: 1,
  budgetTokens: 4000,
  originalEstimatedTokens: 320,
  findingCounts,
  detectorVersion: "detector-v1",
  safetyPolicyVersion: "policy-v1",
  releaseId: null,
  createdAt: timestamp,
  decidedAt: null,
};

const releaseFixture = {
  releaseId: "release-1",
  requestId: "request-1",
  sourcePackId: "pack-1",
  releasedAt: timestamp,
  sha256: digest,
  disclosure: {
    destination: destinationSnapshot,
    sourcePackId: "pack-1",
    projectId: "project-1",
    taskId: "task-1",
    projectRevision: 1,
    sourceRecords: [
      {
        recordId: "task-1",
        kind: "task" as const,
        revision: 1,
        sourceKind: "human" as const,
        sourceRef: null,
      },
    ],
    omissions: [],
    requestedBudgetTokens: 4000,
    originalEstimatedTokens: 320,
    releasedEstimatedTokens: 320,
    findingCounts,
    detectorVersion: "detector-v1",
    safetyPolicyVersion: "policy-v1",
    releaseDigest: digest,
    releasedAt: timestamp,
  },
  pack,
};

describe("outbound contracts", () => {
  it("accepts one strict human-declared destination", () => {
    expect(outboundDestinationSchema.parse(destination)).toMatchObject({
      revision: 1,
      current: true,
    });
  });

  it.each([
    ["local_model", "local"],
    ["direct_provider", "remote"],
    ["gateway", "mixed"],
    ["ide_managed", "unknown"],
    ["unknown", "remote"],
  ] as const)("accepts destination type %s and boundary %s", (type, dataBoundary) => {
    expect(outboundDestinationSchema.parse({ ...destination, type, dataBoundary })).toMatchObject({
      type,
      dataBoundary,
    });
  });

  it("rejects unsafe labels and unknown destination fields", () => {
    expect(() => outboundDestinationSchema.parse({
      ...destination,
      clientLabel: "Unsafe\nlabel",
    })).toThrow();
    expect(() => outboundDestinationSchema.parse({ ...destination, extra: true })).toThrow();
  });

  it("accepts both destination status branches", () => {
    expect(outboundDestinationSchema.parse({ ...destination, status: "disabled" })).toMatchObject({
      status: "disabled",
    });
  });

  it.each([
    "private_key",
    "api_token",
    "authorization",
    "credential_uri",
    "secret_assignment",
    "high_entropy",
    "email",
    "phone",
    "network_address",
    "local_user_path",
  ] as const)("accepts finding category %s", (category) => {
    expect(outboundFindingSchema.parse({
      id: `finding-${category}`,
      ordinal: 0,
      detectorId: "detector-1",
      detectorVersion: "v1",
      category,
      confidence: "possible",
      severity: "sensitive",
      path: "/task/record/body",
      start: 2,
      end: 5,
      findingKey: "finding-key-1",
      requiredAction: "redact_by_default",
      decision: "include_once",
    })).toMatchObject({ category });
  });

  it.each([
    ["forced_redact", "redact"],
    ["redact_by_default", "redact"],
    ["redact_by_default", "include_once"],
    ["redact_by_default", null],
  ] as const)("accepts finding action %s with decision %s", (requiredAction, decision) => {
    expect(outboundFindingSchema.parse({
      id: "finding-credential",
      ordinal: 1,
      detectorId: "detector-1",
      detectorVersion: "v1",
      category: "private_key",
      confidence: "high",
      severity: "credential",
      path: "/stableFrame/0/record/body",
      start: 0,
      end: 10,
      findingKey: "finding-key-2",
      requiredAction,
      decision,
    })).toMatchObject({ requiredAction, decision });
  });

  it("rejects malformed finding ranges, paths, and forced inclusions", () => {
    const finding = {
      id: "finding-1",
      ordinal: 0,
      detectorId: "detector-1",
      detectorVersion: "v1",
      category: "api_token" as const,
      confidence: "high" as const,
      severity: "credential" as const,
      path: "/task/record/body",
      start: 2,
      end: 5,
      findingKey: "finding-key-1",
      requiredAction: "forced_redact" as const,
      decision: null,
    };
    expect(() => outboundFindingSchema.parse({ ...finding, end: 2 })).toThrow("non-empty");
    expect(() => outboundFindingSchema.parse({ ...finding, path: "task.body" })).toThrow();
    expect(() => outboundFindingSchema.parse({ ...finding, decision: "include_once" })).toThrow(
      "cannot be included",
    );
  });

  it("rejects an unknown nested disclosure field and invalid digests", () => {
    expect(() => outboundReleaseSchema.parse({
      ...releaseFixture,
      disclosure: { ...releaseFixture.disclosure, rawSecret: "synthetic" },
    })).toThrow();
    expect(() => outboundReleaseSchema.parse({ ...releaseFixture, sha256: "not-a-digest" })).toThrow();
    expect(() => outboundReleaseSchema.parse({
      ...releaseFixture,
      disclosure: { ...releaseFixture.disclosure, releaseDigest: "A".repeat(64) },
    })).toThrow();
  });

  it("keeps legacy source references longer than 200 characters representable in disclosure", () => {
    const legacySourceReference = `legacy://${"s".repeat(512)}`;
    const sourceRecord = releaseFixture.disclosure.sourceRecords[0]!;
    const withLegacySourceReference = {
      ...releaseFixture,
      disclosure: {
        ...releaseFixture.disclosure,
        sourceRecords: [{
          ...sourceRecord,
          sourceRef: legacySourceReference,
        }],
      },
      pack: {
        ...releaseFixture.pack,
        task: {
          ...releaseFixture.pack.task,
          record: {
            ...releaseFixture.pack.task.record,
            sourceRef: legacySourceReference,
          },
        },
      },
    };

    expect(outboundReleaseSchema.parse(withLegacySourceReference).disclosure
      .sourceRecords[0]?.sourceRef).toBe(legacySourceReference);
    expect(() => outboundReleaseSchema.parse({
      ...withLegacySourceReference,
      disclosure: {
        ...withLegacySourceReference.disclosure,
        sourceRecords: [{
          ...sourceRecord,
          sourceRef: "   ",
        }],
      },
    })).toThrow();
  });

  it.each(["released", "review_required", "denied"] as const)(
    "accepts the %s retrieval branch without cross-branch content",
    (status) => {
      const result = status === "released"
        ? { status, release: releaseFixture }
        : { status, request: { ...requestSummary, status } };
      expect(getReleasedContextResultSchema.parse(result)).toMatchObject({ status });
    },
  );

  it("rejects content attached to a review-required retrieval", () => {
    expect(() => getReleasedContextResultSchema.parse({
      status: "review_required",
      request: requestSummary,
      release: releaseFixture,
    })).toThrow();
  });

  it("requires a bounded idempotency key and positive budget", () => {
    expect(() => requestTaskContextInputSchema.parse({
      projectId: "project-1",
      taskId: "task-1",
      budgetTokens: 0,
      idempotencyKey: "request-1",
    })).toThrow();
    expect(() => requestTaskContextInputSchema.parse({
      projectId: "project-1",
      taskId: "task-1",
      budgetTokens: 1,
      idempotencyKey: "x".repeat(129),
    })).toThrow();
  });

  it("validates strict destination, approval, and listing commands", () => {
    expect(setOutboundDestinationInputSchema.parse({
      profileId: "profile-1",
      clientLabel: "Codex workstation",
      type: "ide_managed",
      providerLabel: "OpenAI",
      modelLabel: null,
      accountBoundaryLabel: null,
      dataBoundary: "remote",
    })).toMatchObject({ type: "ide_managed" });
    expect(approveOutboundRequestInputSchema.parse({
      requestId: "request-1",
      rememberClean: false,
      includeFindingIds: ["finding-1"],
    })).toMatchObject({ includeFindingIds: ["finding-1"] });
    expect(outboundRequestFilterSchema.parse({
      projectId: "project-1",
      status: "review_required",
    })).toMatchObject({ status: "review_required" });
    expect(() => approveOutboundRequestInputSchema.parse({
      requestId: "request-1",
      rememberClean: false,
      includeFindingIds: ["finding-1", "finding-1"],
    })).toThrow();
  });
});
