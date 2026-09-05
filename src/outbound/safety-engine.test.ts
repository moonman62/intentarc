import { describe, expect, it } from "vitest";
import {
  neutralHierarchyVocabulary,
  softwareHierarchyVocabulary,
  type OutboundDestinationSnapshot,
  type TaskContextPack,
} from "../domain/index.js";
import { OutboundSafetyError } from "./errors.js";
import {
  computeOutboundReleaseDigest,
  createOutboundSafetyEngine,
  detectPack,
} from "./safety-engine.js";
import { detectText } from "./detectors.js";

const timestamp = "2026-07-27T00:00:00.000Z";

const forcedFindingsInRelease = (value: unknown): ReturnType<typeof detectText> => {
  if (typeof value === "string") {
    return detectText("/release", value).filter((finding) => finding.requiredAction === "forced_redact");
  }
  if (Array.isArray(value)) return value.flatMap(forcedFindingsInRelease);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(forcedFindingsInRelease);
  return [];
};

const destination: OutboundDestinationSnapshot = {
  id: "destination-1",
  revision: 1,
  clientLabel: "Synthetic workstation",
  type: "ide_managed",
  providerLabel: "Synthetic provider",
  modelLabel: null,
  accountBoundaryLabel: null,
  dataBoundary: "remote",
};

const packWithSyntheticSecrets: TaskContextPack = {
  id: "pack-1",
  projectId: "project-1",
  taskId: "task-1",
  projectRevision: 1,
  generatedAt: timestamp,
  budgetTokens: 4000,
  estimatedTokens: 80,
  hierarchyVocabulary: neutralHierarchyVocabulary,
  stableFrame: [],
  task: {
    record: {
      id: "task-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Synthetic outbound task",
      body: "api_key=sk-proj-SyntheticTokenValue0123456789 owner@example.invalid",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  },
  related: [],
  omissions: [],
  sourceRevisions: [{ recordId: "task-1", revision: 1 }],
};

describe("outbound safety engine", () => {
  it("scans destination strings in the candidate and masks matched metadata in releases", () => {
    const engine = createOutboundSafetyEngine();
    const pack = structuredClone(packWithSyntheticSecrets);
    pack.task.record.body = "Synthetic task content without findings.";
    const destinationToken = "sk-proj-SyntheticDestinationToken0123456789";
    const destinationEmail = "destination.owner@example.invalid";
    const sensitiveDestination: OutboundDestinationSnapshot = {
      ...destination,
      clientLabel: `Client ${destinationToken}`,
      providerLabel: `Provider ${destinationEmail}`,
    };
    const rawDestination = structuredClone(sensitiveDestination);

    const scan = engine.scan(pack, sensitiveDestination);
    const baseline = engine.scan(pack, destination);

    expect(scan.candidateDigest).not.toBe(baseline.candidateDigest);
    expect(scan.findings.map(({ path }) => path)).toEqual([
      "/destination/clientLabel",
      "/destination/providerLabel",
    ]);

    const release = engine.createRelease({
      requestId: "request-destination-metadata",
      releaseId: "release-destination-metadata",
      pack,
      destination: sensitiveDestination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });
    const serializedDisclosure = JSON.stringify(release.disclosure);
    expect(serializedDisclosure).not.toContain(destinationToken);
    expect(serializedDisclosure).not.toContain(destinationEmail);
    expect(sensitiveDestination).toEqual(rawDestination);
  });

  it("reveals exactly one matched destination span for local human inspection", () => {
    const engine = createOutboundSafetyEngine();
    const pack = structuredClone(packWithSyntheticSecrets);
    pack.task.record.body = "Synthetic task content without findings.";
    const destinationEmail = "destination.owner@example.invalid";
    const sensitiveDestination: OutboundDestinationSnapshot = {
      ...destination,
      providerLabel: `Provider ${destinationEmail}`,
    };
    const finding = engine.scan(pack, sensitiveDestination).findings.find(
      ({ path }) => path === "/destination/providerLabel",
    );

    expect(finding).toBeDefined();
    const reveal = engine.reveal as unknown as (
      candidatePack: TaskContextPack,
      candidateDestination: OutboundDestinationSnapshot,
      candidateFinding: NonNullable<typeof finding>,
    ) => string;
    expect(reveal(pack, sensitiveDestination, finding!)).toBe(destinationEmail);
  });

  it("resolves overlaps deterministically and never mutates the raw pack", () => {
    const raw = structuredClone(packWithSyntheticSecrets);
    const engine = createOutboundSafetyEngine();
    const scan = engine.scan(raw, destination);

    expect(raw).toEqual(packWithSyntheticSecrets);
    expect(scan.findings).toHaveLength(2);
    expect(scan.findings.map((finding) => finding.id)).toEqual([
      "finding-85ae451b754fdab80c6de7de0107d9d39823183b659c45cad830557753ab13bb",
      "finding-fa4fa76d4a43ba44f0010ba0953bfc8f7f2be22dcabb5f0ca128efde315be3f4",
    ]);
    expect(scan.findings.map((finding) => finding.id)).toEqual(
      scan.findings.map((finding) => `finding-${finding.findingKey}`),
    );
    expect(scan.redactedPreview.task.record.body).toContain("[REDACTED:API_TOKEN:1]");
    expect(scan.redactedPreview.task.record.body).toContain("[REDACTED:EMAIL:2]");
  });

  it("cannot include a forced credential but can include one possible finding", () => {
    const engine = createOutboundSafetyEngine();
    const scan = engine.scan(packWithSyntheticSecrets, destination);
    const forcedFinding = scan.findings.find((finding) => finding.requiredAction === "forced_redact");
    const possibleEmailFinding = scan.findings.find((finding) => finding.category === "email");

    expect(forcedFinding).toBeDefined();
    expect(possibleEmailFinding).toBeDefined();
    expect(() => engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: packWithSyntheticSecrets,
      destination,
      scan,
      includeFindingIds: [forcedFinding!.id],
      releasedAt: timestamp,
    })).toThrowError(OutboundSafetyError);

    const released = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: packWithSyntheticSecrets,
      destination,
      scan,
      includeFindingIds: [possibleEmailFinding!.id],
      releasedAt: timestamp,
    });
    expect(released.disclosure.findingCounts.includedOnce).toBe(1);
  });

  it("keeps a legacy source reference longer than 200 characters inspectable and approvable", () => {
    const engine = createOutboundSafetyEngine();
    const legacySourceReference = `legacy://${"s".repeat(512)}`;
    const pack = structuredClone(packWithSyntheticSecrets);
    pack.task.record.body = "Synthetic task content without findings.";
    pack.task.record.sourceRef = legacySourceReference;

    const scan = engine.scan(pack, destination);
    const released = engine.createRelease({
      requestId: "request-legacy-source-reference",
      releaseId: "release-legacy-source-reference",
      pack,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });

    expect(scan.redactedPreview.task.record.sourceRef).toBe(
      legacySourceReference,
    );
    expect(released.pack.task.record.sourceRef).toBe(legacySourceReference);
    expect(released.disclosure.sourceRecords[0]?.sourceRef).toBe(
      legacySourceReference,
    );
  });

  it("rejects unknown finding IDs", () => {
    const engine = createOutboundSafetyEngine();
    const scan = engine.scan(packWithSyntheticSecrets, destination);

    expect(() => engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: packWithSyntheticSecrets,
      destination,
      scan,
      includeFindingIds: ["finding-not-in-scan"],
      releasedAt: timestamp,
    })).toThrowError(OutboundSafetyError);
  });

  it.each([
    ["unknown top-level field", { unexpected: true }],
    ["blank request ID", { requestId: " " }],
    ["invalid release timestamp", { releasedAt: "not-a-timestamp" }],
    ["invalid inclusion ID", { includeFindingIds: [" "] }],
  ])("strict-parses createRelease input with a canonical error for %s", (_, override) => {
    const engine = createOutboundSafetyEngine();
    const pack = structuredClone(packWithSyntheticSecrets);
    pack.task.record.body = "Synthetic task content without findings.";
    const scan = engine.scan(pack, destination);
    const input = {
      requestId: "request-strict-input",
      releaseId: "release-strict-input",
      pack,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
      ...override,
    };

    try {
      engine.createRelease(input);
      expect.unreachable("createRelease accepted malformed top-level input");
    } catch (error) {
      expect(error).toBeInstanceOf(OutboundSafetyError);
      expect(error).toMatchObject({ code: "outbound_safety_failed", details: {} });
    }
  });

  it("redacts forced metadata duplicates before returning the exact release object", () => {
    const engine = createOutboundSafetyEngine();
    const pack = structuredClone(packWithSyntheticSecrets);
    const metadataToken = "sk-proj-SyntheticMetadataToken0123456789";
    pack.id = metadataToken;
    pack.projectId = metadataToken;
    pack.taskId = metadataToken;
    pack.task.record.id = metadataToken;
    pack.task.record.projectId = metadataToken;
    pack.task.record.sourceRef = metadataToken;
    pack.omissions = [{ recordId: metadataToken, kind: "task", reason: "budget", retrievalRef: metadataToken }];
    const scan = engine.scan(pack, destination);
    const released = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });

    expect(detectPack(released.pack)
      .filter((finding) => finding.requiredAction === "forced_redact")).toEqual([]);
    expect(forcedFindingsInRelease(released)).toEqual([]);
  });

  it("uses one digest for the release and its disclosure", () => {
    const engine = createOutboundSafetyEngine();
    const scan = engine.scan(packWithSyntheticSecrets, destination);
    const softwareScan = engine.scan({
      ...packWithSyntheticSecrets,
      hierarchyVocabulary: softwareHierarchyVocabulary,
    }, destination);
    const released = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: packWithSyntheticSecrets,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });

    expect(released.sha256).toBe("49ccd332398e8637a7ffbbb314f140ad6ec4979fcf04fa14625e77b24c4add87");
    expect(released.sha256).toBe(released.disclosure.releaseDigest);
    expect(softwareScan.candidateDigest).not.toBe(scan.candidateDigest);
    expect(computeOutboundReleaseDigest({ ...released, requestId: "request-2" })).not.toBe(released.sha256);
    expect(computeOutboundReleaseDigest({
      ...released,
      pack: { ...released.pack, task: { ...released.pack.task, record: { ...released.pack.task.record, title: "Changed synthetic title" } } },
    })).not.toBe(released.sha256);
    expect(computeOutboundReleaseDigest({
      ...released,
      pack: {
        ...released.pack,
        hierarchyVocabulary: softwareHierarchyVocabulary,
      },
    })).not.toBe(released.sha256);

    const {
      hierarchyVocabulary: _legacyMissingVocabulary,
      ...legacyPack
    } = released.pack;
    expect(computeOutboundReleaseDigest({
      ...released,
      pack: legacyPack,
    })).toBe("fc3db359f4142167eff28d91720f5754bb4a3a5b92583384dceaf6b26ccd1d00");
  });

  it("reconstructs only a genuine missing-field Neutral source with historical digests", () => {
    const engine = createOutboundSafetyEngine();
    const {
      hierarchyVocabulary: _legacyMissingVocabulary,
      ...legacyPack
    } = packWithSyntheticSecrets;
    const sourcePackShape = { hierarchyVocabularyPresent: false } as const;

    const scan = engine.scanStoredPack(
      legacyPack,
      destination,
      sourcePackShape,
    );
    const currentScan = engine.scan(legacyPack, destination);
    const explicitlyPresentScan = engine.scanStoredPack(
      packWithSyntheticSecrets,
      destination,
      { hierarchyVocabularyPresent: true },
    );

    expect(scan.candidateDigest).toBe(
      "545d992a7aa9197b34e7bfcd47f677bb811309df09e4c75a14f0f220e820f524",
    );
    expect(scan.findings.map(({ id }) => id)).toEqual([
      "finding-a6a493e9172ca6237d1ca0d6a7e73366ef9ffcb1861837b2aa2509e4eac04b8d",
      "finding-d948bfcfbfd617bae9107e7772930026220fadb556c652eba3070b88aad14c1b",
    ]);
    expect(Object.hasOwn(scan.redactedPreview, "hierarchyVocabulary")).toBe(
      false,
    );
    expect(currentScan.candidateDigest).not.toBe(scan.candidateDigest);
    expect(explicitlyPresentScan).toEqual(currentScan);
    expect(
      Object.hasOwn(currentScan.redactedPreview, "hierarchyVocabulary"),
    ).toBe(true);

    const release = engine.createRelease({
      requestId: "request-1",
      releaseId: "release-1",
      pack: legacyPack,
      sourcePackShape,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    });
    expect(Object.hasOwn(release.pack, "hierarchyVocabulary")).toBe(false);
    expect(release.sha256).toBe(
      "fc3db359f4142167eff28d91720f5754bb4a3a5b92583384dceaf6b26ccd1d00",
    );

    expect(() => engine.scanStoredPack(
      {
        ...legacyPack,
        hierarchyVocabulary: softwareHierarchyVocabulary,
      },
      destination,
      sourcePackShape,
    )).toThrowError(OutboundSafetyError);
    expect(() => engine.scanStoredPack(
      packWithSyntheticSecrets,
      destination,
      sourcePackShape,
    )).toThrowError(OutboundSafetyError);
    expect(() => engine.scanStoredPack(
      legacyPack,
      destination,
      { hierarchyVocabularyPresent: true },
    )).toThrowError(OutboundSafetyError);
    expect(() => engine.createRelease({
      requestId: "request-marker-mismatch",
      releaseId: "release-marker-mismatch",
      pack: packWithSyntheticSecrets,
      sourcePackShape,
      destination,
      scan,
      includeFindingIds: [],
      releasedAt: timestamp,
    })).toThrowError(OutboundSafetyError);
    expect(() => engine.createRelease({
      requestId: "request-marker-mismatch",
      releaseId: "release-marker-mismatch",
      pack: legacyPack,
      sourcePackShape: { hierarchyVocabularyPresent: true },
      destination,
      scan: currentScan,
      includeFindingIds: [],
      releasedAt: timestamp,
    })).toThrowError(OutboundSafetyError);
  });
});
