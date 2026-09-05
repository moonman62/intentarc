import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ContextItem,
  OutboundDestinationSnapshot,
  OutboundDisclosure,
  OutboundFinding,
  OutboundFindingCounts,
  OutboundRelease,
  TaskContextPack,
} from "../domain/index.js";
import {
  neutralHierarchyVocabulary,
  outboundDestinationSnapshotSchema,
  outboundFindingSchema,
  outboundReleaseSchema,
  taskContextPackSchema,
} from "../domain/index.js";
import { OutboundSafetyError } from "./errors.js";
import {
  detectText,
  detectorPriorities,
  OUTBOUND_DETECTOR_VERSION,
  OUTBOUND_SAFETY_POLICY_VERSION,
  type DetectedSpan,
} from "./detectors.js";

export { OUTBOUND_DETECTOR_VERSION, OUTBOUND_SAFETY_POLICY_VERSION } from "./detectors.js";

export interface OutboundScan {
  detectorVersion: "1";
  safetyPolicyVersion: "1";
  candidateDigest: string;
  findings: OutboundFinding[];
  redactedPreview: TaskContextPack;
  redactedDestination: OutboundDestinationSnapshot;
}

export interface OutboundSourcePackShape {
  hierarchyVocabularyPresent: boolean;
}

export interface OutboundSafetyEngine {
  scan(pack: TaskContextPack, destination: OutboundDestinationSnapshot): OutboundScan;
  scanStoredPack(
    pack: TaskContextPack,
    destination: OutboundDestinationSnapshot,
    sourcePackShape: OutboundSourcePackShape,
  ): OutboundScan;
  createRelease(input: {
    requestId: string;
    releaseId: string;
    pack: TaskContextPack;
    sourcePackShape?: OutboundSourcePackShape;
    destination: OutboundDestinationSnapshot;
    scan: OutboundScan;
    includeFindingIds: readonly string[];
    releasedAt: string;
  }): OutboundRelease;
  reveal(
    pack: TaskContextPack,
    destination: OutboundDestinationSnapshot,
    finding: OutboundFinding,
  ): string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export interface OutboundRequestHashInput {
  projectId: string;
  taskId: string;
  budgetTokens: number;
  destinationId: string;
  destinationRevision: number;
  detectorVersion: string;
  safetyPolicyVersion: string;
}

export const computeOutboundRequestHash = (
  input: OutboundRequestHashInput,
): string => sha256(JSON.stringify({
  projectId: input.projectId,
  taskId: input.taskId,
  budgetTokens: input.budgetTokens,
  destinationId: input.destinationId,
  destinationRevision: input.destinationRevision,
  detectorVersion: input.detectorVersion,
  safetyPolicyVersion: input.safetyPolicyVersion,
}));

const findingKey = (digest: string, span: DetectedSpan): string => sha256([
  digest, span.detectorId, span.path, span.start, span.end,
].join("\u0000"));

const pointer = (segment: string | number): string => String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

const canonicalPack = (pack: TaskContextPack): TaskContextPack => ({
  id: pack.id,
  projectId: pack.projectId,
  taskId: pack.taskId,
  projectRevision: pack.projectRevision,
  generatedAt: pack.generatedAt,
  budgetTokens: pack.budgetTokens,
  estimatedTokens: pack.estimatedTokens,
  ...(pack.hierarchyVocabulary
    ? { hierarchyVocabulary: { ...pack.hierarchyVocabulary } }
    : {}),
  stableFrame: pack.stableFrame.map(canonicalContextItem),
  task: canonicalContextItem(pack.task),
  related: pack.related.map(canonicalContextItem),
  omissions: pack.omissions.map((omission) => ({ recordId: omission.recordId, kind: omission.kind, reason: omission.reason, retrievalRef: omission.retrievalRef })),
  sourceRevisions: pack.sourceRevisions.map((source) => ({ recordId: source.recordId, revision: source.revision })),
});

function canonicalContextItem(item: ContextItem): ContextItem {
  return {
    record: {
      id: item.record.id,
      projectId: item.record.projectId,
      kind: item.record.kind,
      status: item.record.status,
      title: item.record.title,
      body: item.record.body,
      sourceKind: item.record.sourceKind,
      sourceRef: item.record.sourceRef,
      revision: item.record.revision,
      createdAt: item.record.createdAt,
      updatedAt: item.record.updatedAt,
    },
    mandatory: item.mandatory,
    relevance: item.relevance,
    relationshipKind: item.relationshipKind,
  };
}

const canonicalDestination = (destination: OutboundDestinationSnapshot): OutboundDestinationSnapshot => ({
  id: destination.id,
  revision: destination.revision,
  clientLabel: destination.clientLabel,
  type: destination.type,
  providerLabel: destination.providerLabel,
  modelLabel: destination.modelLabel,
  accountBoundaryLabel: destination.accountBoundaryLabel,
  dataBoundary: destination.dataBoundary,
});

const candidateDigest = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
): string => sha256(JSON.stringify({
  pack: canonicalPack(pack),
  destination: canonicalDestination(destination),
}));

const compareSpans = (left: DetectedSpan, right: DetectedSpan): number => {
  const action = Number(right.requiredAction === "forced_redact") - Number(left.requiredAction === "forced_redact");
  if (action !== 0) return action;
  const severity = Number(right.severity === "credential") - Number(left.severity === "credential");
  if (severity !== 0) return severity;
  const confidence = Number(right.confidence === "high") - Number(left.confidence === "high");
  if (confidence !== 0) return confidence;
  const length = (right.end - right.start) - (left.end - left.start);
  if (length !== 0) return length;
  const priority = (detectorPriorities[left.detectorId] ?? Number.MAX_SAFE_INTEGER) - (detectorPriorities[right.detectorId] ?? Number.MAX_SAFE_INTEGER);
  if (priority !== 0) return priority;
  return left.detectorId.localeCompare(right.detectorId);
};

const canonicalSpanOrder = (left: DetectedSpan, right: DetectedSpan): number =>
  left.path.localeCompare(right.path) || left.start - right.start || left.end - right.end || left.detectorId.localeCompare(right.detectorId);

const spansOverlap = (left: DetectedSpan, right: DetectedSpan): boolean => left.path === right.path && left.start < right.end && right.start < left.end;

const resolveOverlaps = (spans: DetectedSpan[]): DetectedSpan[] => {
  const selected: DetectedSpan[] = [];
  for (const candidate of [...spans].sort(compareSpans)) {
    if (!selected.some((existing) => spansOverlap(candidate, existing))) selected.push(candidate);
  }
  return selected.sort(canonicalSpanOrder);
};

type StringLeaf = { path: string; value: string; set(value: string): void };

const packStringLeaves = (pack: TaskContextPack): StringLeaf[] => {
  const leaves: StringLeaf[] = [];
  const add = (object: Record<string, unknown>, key: string, path: string): void => {
    const value = object[key];
    if (typeof value === "string") leaves.push({ path, value, set: (replacement) => { object[key] = replacement; } });
  };
  const visitItem = (item: ContextItem, path: string): void => {
    const record = item.record as unknown as Record<string, unknown>;
    for (const key of ["id", "projectId", "kind", "status", "title", "body", "sourceKind", "sourceRef", "createdAt", "updatedAt"]) add(record, key, `${path}/record/${pointer(key)}`);
    add(item as unknown as Record<string, unknown>, "relevance", `${path}/relevance`);
    add(item as unknown as Record<string, unknown>, "relationshipKind", `${path}/relationshipKind`);
  };
  const root = pack as unknown as Record<string, unknown>;
  for (const key of ["id", "projectId", "taskId", "generatedAt"]) add(root, key, `/${pointer(key)}`);
  if (pack.hierarchyVocabulary) {
    const vocabulary = pack.hierarchyVocabulary as unknown as Record<
      string,
      unknown
    >;
    for (
      const key of [
        "outcome",
        "initiative",
        "deliverable",
        "milestone",
        "task",
        "nestedTask",
      ]
    ) {
      add(
        vocabulary,
        key,
        `/hierarchyVocabulary/${pointer(key)}`,
      );
    }
  }
  pack.stableFrame.forEach((item, index) => visitItem(item, `/stableFrame/${index}`));
  visitItem(pack.task, "/task");
  pack.related.forEach((item, index) => visitItem(item, `/related/${index}`));
  pack.omissions.forEach((omission, index) => {
    const object = omission as unknown as Record<string, unknown>;
    for (const key of ["recordId", "kind", "reason", "retrievalRef"]) add(object, key, `/omissions/${index}/${pointer(key)}`);
  });
  pack.sourceRevisions.forEach((source, index) => add(source as unknown as Record<string, unknown>, "recordId", `/sourceRevisions/${index}/recordId`));
  return leaves;
};

const destinationStringLeaves = (
  destination: OutboundDestinationSnapshot,
): StringLeaf[] => {
  const leaves: StringLeaf[] = [];
  const object = destination as unknown as Record<string, unknown>;
  for (
    const key of [
      "id",
      "clientLabel",
      "type",
      "providerLabel",
      "modelLabel",
      "accountBoundaryLabel",
      "dataBoundary",
    ]
  ) {
    const value = object[key];
    if (typeof value === "string") {
      leaves.push({
        path: `/destination/${pointer(key)}`,
        value,
        set: (replacement) => {
          object[key] = replacement;
        },
      });
    }
  }
  return leaves;
};

type OutboundCandidate = {
  pack: TaskContextPack;
  destination: OutboundDestinationSnapshot;
};

const candidateStringLeaves = (
  candidate: OutboundCandidate,
): StringLeaf[] => [
  ...packStringLeaves(candidate.pack),
  ...destinationStringLeaves(candidate.destination),
];

export const maskOutboundDestination = (
  destination: OutboundDestinationSnapshot,
  findings: readonly Pick<OutboundFinding, "path">[],
): OutboundDestinationSnapshot => {
  const masked = canonicalDestination(structuredClone(destination));
  for (
    const path of new Set(
      findings
        .map(({ path: findingPath }) => findingPath)
        .filter((findingPath) => findingPath.startsWith("/destination/")),
    )
  ) {
    const leaf = destinationStringLeaves(masked).find(
      (candidate) => candidate.path === path,
    );
    if (!leaf) throw new OutboundSafetyError("outbound_safety_failed", {});
    leaf.set("[REDACTED:DESTINATION]");
  }
  return outboundDestinationSnapshotSchema.parse(masked);
};

export const detectPack = (pack: TaskContextPack): DetectedSpan[] => {
  const parsed = taskContextPackSchema.parse(pack);
  return resolveOverlaps(
    packStringLeaves(parsed).flatMap(({ path, value }) => detectText(path, value)),
  );
};

const detectCandidate = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
): DetectedSpan[] => resolveOverlaps(
  candidateStringLeaves({ pack, destination })
    .flatMap(({ path, value }) => detectText(path, value)),
);

const toFindings = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
): OutboundFinding[] => {
  const digest = candidateDigest(pack, destination);
  return detectCandidate(pack, destination).map((span, ordinal) => ({
    id: `finding-${findingKey(digest, span)}`,
    ordinal,
    detectorId: span.detectorId,
    detectorVersion: OUTBOUND_DETECTOR_VERSION,
    category: span.category,
    confidence: span.confidence,
    severity: span.severity,
    path: span.path,
    start: span.start,
    end: span.end,
    findingKey: findingKey(digest, span),
    requiredAction: span.path.startsWith("/destination/")
      ? "forced_redact"
      : span.requiredAction,
    decision: null,
  }));
};

const readPath = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
  path: string,
): string | undefined => candidateStringLeaves({ pack, destination })
  .find((leaf) => leaf.path === path)?.value;

const replacementCandidate = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
  findings: readonly OutboundFinding[],
  included: ReadonlySet<string>,
): OutboundCandidate => {
  const derived: OutboundCandidate = {
    pack: canonicalPack(structuredClone(pack)),
    destination: maskOutboundDestination(destination, findings),
  };
  const redacted = findings.filter((finding) => !included.has(finding.id)).sort((left, right) =>
    left.path.localeCompare(right.path) || left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  const numbered = redacted.map((finding, index) => ({ finding, placeholder: `[REDACTED:${finding.category.toUpperCase()}:${index + 1}]` }));
  for (const [path, replacements] of Map.groupBy(numbered, ({ finding }) => finding.path)) {
    if (path.startsWith("/destination/")) continue;
    const leaf = candidateStringLeaves(derived).find(
      (candidate) => candidate.path === path,
    );
    if (!leaf) throw new OutboundSafetyError("outbound_safety_failed", {});
    let value = leaf.value;
    for (const replacement of [...(replacements ?? [])].sort((left, right) => right.finding.start - left.finding.start)) {
      value = `${value.slice(0, replacement.finding.start)}${replacement.placeholder}${value.slice(replacement.finding.end)}`;
    }
    leaf.set(value);
  }
  return derived;
};

const findingCounts = (findings: readonly OutboundFinding[], included: ReadonlySet<string>): OutboundFindingCounts => ({
  total: findings.length,
  credential: findings.filter((finding) => finding.severity === "credential").length,
  sensitive: findings.filter((finding) => finding.severity === "sensitive").length,
  forcedRedact: findings.filter((finding) => finding.requiredAction === "forced_redact").length,
  redactByDefault: findings.filter((finding) => finding.requiredAction === "redact_by_default").length,
  redacted: findings.length - included.size,
  includedOnce: included.size,
});

const estimateReleasedTokens = (pack: TaskContextPack): number => {
  const text = [...pack.stableFrame, pack.task, ...pack.related]
    .map((item) => `${item.record.title}\n${item.record.body}`).join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
};

const releaseContainsForcedPattern = (value: unknown): boolean => {
  if (typeof value === "string") return detectText("/release", value).some((finding) => finding.requiredAction === "forced_redact");
  if (Array.isArray(value)) return value.some(releaseContainsForcedPattern);
  if (value !== null && typeof value === "object") return Object.values(value).some(releaseContainsForcedPattern);
  return false;
};

const canonicalDisclosure = (disclosure: OutboundDisclosure, omitDigest: boolean): Omit<OutboundDisclosure, "releaseDigest"> | OutboundDisclosure => {
  const value = {
    destination: canonicalDestination(disclosure.destination),
    sourcePackId: disclosure.sourcePackId,
    projectId: disclosure.projectId,
    taskId: disclosure.taskId,
    projectRevision: disclosure.projectRevision,
    sourceRecords: disclosure.sourceRecords.map((record) => ({ recordId: record.recordId, kind: record.kind, revision: record.revision, sourceKind: record.sourceKind, sourceRef: record.sourceRef })),
    omissions: disclosure.omissions.map((omission) => ({ recordId: omission.recordId, kind: omission.kind, reason: omission.reason, retrievalRef: omission.retrievalRef })),
    requestedBudgetTokens: disclosure.requestedBudgetTokens,
    originalEstimatedTokens: disclosure.originalEstimatedTokens,
    releasedEstimatedTokens: disclosure.releasedEstimatedTokens,
    findingCounts: { ...disclosure.findingCounts },
    detectorVersion: disclosure.detectorVersion,
    safetyPolicyVersion: disclosure.safetyPolicyVersion,
    ...(omitDigest ? {} : { releaseDigest: disclosure.releaseDigest }),
    releasedAt: disclosure.releasedAt,
  };
  return value as Omit<OutboundDisclosure, "releaseDigest"> | OutboundDisclosure;
};

export const computeOutboundReleaseDigest = (release: OutboundRelease): string => sha256(JSON.stringify({
  releaseId: release.releaseId,
  requestId: release.requestId,
  sourcePackId: release.sourcePackId,
  releasedAt: release.releasedAt,
  disclosure: canonicalDisclosure(release.disclosure, true),
  pack: canonicalPack(release.pack),
}));

const scanSchema = z.object({
  detectorVersion: z.literal(OUTBOUND_DETECTOR_VERSION),
  safetyPolicyVersion: z.literal(OUTBOUND_SAFETY_POLICY_VERSION),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(outboundFindingSchema),
  redactedPreview: taskContextPackSchema,
  redactedDestination: outboundDestinationSnapshotSchema,
}).strict();

const sourcePackShapeSchema = z.object({
  hierarchyVocabularyPresent: z.boolean(),
}).strict();

const identifierSchema = z.string().trim().min(1).max(200);
const createReleaseInputSchema = z.object({
  requestId: identifierSchema,
  releaseId: identifierSchema,
  pack: taskContextPackSchema,
  sourcePackShape: sourcePackShapeSchema.optional(),
  destination: outboundDestinationSnapshotSchema,
  scan: scanSchema,
  includeFindingIds: z.array(identifierSchema).max(200).refine(
    (findingIds) => new Set(findingIds).size === findingIds.length,
    { message: "Finding inclusions must be unique" },
  ),
  releasedAt: z.iso.datetime(),
}).strict();

const assertSourcePackShape = (
  pack: TaskContextPack,
  sourcePackShape: OutboundSourcePackShape,
): OutboundSourcePackShape => {
  let parsedShape: OutboundSourcePackShape;
  try {
    parsedShape = sourcePackShapeSchema.parse(sourcePackShape);
  } catch {
    throw new OutboundSafetyError("outbound_safety_failed", {});
  }
  if (
    Object.hasOwn(pack, "hierarchyVocabulary") !==
      parsedShape.hierarchyVocabularyPresent
  ) {
    throw new OutboundSafetyError("outbound_safety_failed", {});
  }
  return parsedShape;
};

const packForStoredShape = (
  pack: TaskContextPack,
  sourcePackShape: OutboundSourcePackShape,
): TaskContextPack => {
  if (sourcePackShape.hierarchyVocabularyPresent) return pack;
  if (
    JSON.stringify(pack.hierarchyVocabulary) !==
      JSON.stringify(neutralHierarchyVocabulary)
  ) {
    throw new OutboundSafetyError("outbound_safety_failed", {});
  }
  const {
    hierarchyVocabulary: _legacyMissingVocabulary,
    ...legacyPack
  } = pack;
  return legacyPack;
};

const scanCandidate = (
  pack: TaskContextPack,
  destination: OutboundDestinationSnapshot,
): OutboundScan => {
  const findings = toFindings(pack, destination);
  const redacted = replacementCandidate(
    pack,
    destination,
    findings,
    new Set(),
  );
  return {
    detectorVersion: OUTBOUND_DETECTOR_VERSION,
    safetyPolicyVersion: OUTBOUND_SAFETY_POLICY_VERSION,
    candidateDigest: candidateDigest(pack, destination),
    findings,
    redactedPreview: redacted.pack,
    redactedDestination: redacted.destination,
  };
};

export const createOutboundSafetyEngine = (): OutboundSafetyEngine => ({
  scan(pack, destination) {
    const parsedPack = taskContextPackSchema.parse(pack);
    const parsedDestination = outboundDestinationSnapshotSchema.parse(destination);
    return scanCandidate(parsedPack, parsedDestination);
  },

  scanStoredPack(pack, destination, sourcePackShape) {
    const parsedShape = assertSourcePackShape(pack, sourcePackShape);
    const parsedPack = taskContextPackSchema.parse(pack);
    const parsedDestination = outboundDestinationSnapshotSchema.parse(
      destination,
    );
    return scanCandidate(
      packForStoredShape(parsedPack, parsedShape),
      parsedDestination,
    );
  },

  createRelease(input) {
    let parsedInput: z.infer<typeof createReleaseInputSchema>;
    try {
      if (input.sourcePackShape !== undefined) {
        assertSourcePackShape(input.pack, input.sourcePackShape);
      }
      parsedInput = createReleaseInputSchema.parse(input);
    } catch {
      throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    const parsedPack = parsedInput.sourcePackShape
      ? packForStoredShape(parsedInput.pack, parsedInput.sourcePackShape)
      : parsedInput.pack;
    const parsedDestination = parsedInput.destination;
    const parsedScan = parsedInput.scan as OutboundScan;
    if (parsedInput.sourcePackShape?.hierarchyVocabularyPresent === false) {
      delete parsedScan.redactedPreview.hierarchyVocabulary;
    }
    const freshScan = scanCandidate(parsedPack, parsedDestination);
    if (parsedScan.candidateDigest !== freshScan.candidateDigest || JSON.stringify(parsedScan) !== JSON.stringify(freshScan)) {
      throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    const known = new Map(freshScan.findings.map((finding) => [finding.id, finding]));
    const included = new Set(parsedInput.includeFindingIds);
    for (const findingId of included) {
      const finding = known.get(findingId);
      if (!finding || finding.requiredAction === "forced_redact") throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    const releaseCandidate = replacementCandidate(
      parsedPack,
      parsedDestination,
      freshScan.findings,
      included,
    );
    const releasePack = releaseCandidate.pack;
    if (detectPack(releasePack).some((finding) => finding.requiredAction === "forced_redact")) {
      throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    const disclosure: OutboundDisclosure = {
      destination: releaseCandidate.destination,
      sourcePackId: releasePack.id,
      projectId: releasePack.projectId,
      taskId: releasePack.taskId,
      projectRevision: releasePack.projectRevision,
      sourceRecords: [...releasePack.stableFrame, releasePack.task, ...releasePack.related].map((item) => ({ recordId: item.record.id, kind: item.record.kind, revision: item.record.revision, sourceKind: item.record.sourceKind, sourceRef: item.record.sourceRef })),
      omissions: releasePack.omissions.map((omission) => ({ ...omission })),
      requestedBudgetTokens: releasePack.budgetTokens,
      originalEstimatedTokens: releasePack.estimatedTokens,
      releasedEstimatedTokens: estimateReleasedTokens(releasePack),
      findingCounts: findingCounts(freshScan.findings, included),
      detectorVersion: OUTBOUND_DETECTOR_VERSION,
      safetyPolicyVersion: OUTBOUND_SAFETY_POLICY_VERSION,
      releaseDigest: "0".repeat(64),
      releasedAt: parsedInput.releasedAt,
    };
    const provisional: OutboundRelease = {
      releaseId: parsedInput.releaseId,
      requestId: parsedInput.requestId,
      sourcePackId: releasePack.id,
      releasedAt: parsedInput.releasedAt,
      sha256: "0".repeat(64),
      disclosure,
      pack: releasePack,
    };
    if (releaseContainsForcedPattern(provisional)) {
      throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    const digest = computeOutboundReleaseDigest(provisional);
    const release: OutboundRelease = { ...provisional, sha256: digest, disclosure: { ...disclosure, releaseDigest: digest } };
    const parsedRelease = outboundReleaseSchema.parse(release);
    if (parsedInput.sourcePackShape?.hierarchyVocabularyPresent === false) {
      delete parsedRelease.pack.hierarchyVocabulary;
    }
    return parsedRelease;
  },

  reveal(pack, destination, finding) {
    const parsedPack = taskContextPackSchema.parse(pack);
    const parsedDestination = outboundDestinationSnapshotSchema.parse(destination);
    const parsedFinding = outboundFindingSchema.parse(finding);
    const value = readPath(parsedPack, parsedDestination, parsedFinding.path);
    if (value === undefined || parsedFinding.end > value.length || parsedFinding.start >= parsedFinding.end) {
      throw new OutboundSafetyError("outbound_safety_failed", {});
    }
    return value.slice(parsedFinding.start, parsedFinding.end);
  },
});
