import {
  importInspectionSchema,
} from "../domain/import-schemas.js";
import type {
  ImportInspection,
  ImportInspectionClaimSummary,
  ImportInspectionRecordSummary,
  ImportSensitiveFindingSummary,
  ProposedImportRecord,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import type { RecordKind } from "../domain/model.js";
import {
  detectText,
  detectorPriorities,
  OUTBOUND_DETECTOR_VERSION,
  type DetectedSpan,
} from "../outbound/detectors.js";
import {
  computeImportManifestDigest,
  normalizeImportManifest,
} from "./canonical-manifest.js";
import { RepositoryImportError } from "./errors.js";

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const pointer = (segment: string | number): string =>
  String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

export interface ImportSafetyFinding {
  readonly detectorId: string;
  readonly detectorVersion: typeof OUTBOUND_DETECTOR_VERSION;
  readonly category: DetectedSpan["category"];
  readonly confidence: DetectedSpan["confidence"];
  readonly severity: DetectedSpan["severity"];
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly requiredAction: DetectedSpan["requiredAction"];
}

export interface SafeManifestResult {
  readonly manifest: RepositoryImportManifest;
  readonly findings: readonly ImportSafetyFinding[];
  readonly digest: string;
}

interface StringLeaf {
  readonly path: string;
  readonly value: string;
  readonly blockPossible: boolean;
  readonly set: (replacement: string) => void;
}

const manifestStringLeaves = (
  manifest: RepositoryImportManifest,
): StringLeaf[] => {
  const leaves: StringLeaf[] = [];
  const add = (
    object: Record<string, unknown>,
    key: string,
    path: string,
    blockPossible: boolean,
  ): void => {
    const value = object[key];
    if (typeof value !== "string") return;
    leaves.push({
      path,
      value,
      blockPossible,
      set: (replacement) => {
        object[key] = replacement;
      },
    });
  };
  const addArray = (
    values: string[],
    path: string,
    blockPossible: boolean,
  ): void => {
    values.forEach((value, index) => leaves.push({
      path: `${path}/${index}`,
      value,
      blockPossible,
      set: (replacement) => {
        values[index] = replacement;
      },
    }));
  };

  const repository = manifest.repository as unknown as Record<string, unknown>;
  for (const key of ["root", "canonicalSubpath", "branch", "head", "fingerprint"]) {
    add(repository, key, `/repository/${pointer(key)}`, true);
  }

  manifest.discovery.sources.forEach((source, index) => {
    const sourceObject = source as unknown as Record<string, unknown>;
    add(sourceObject, "path", `/discovery/sources/${index}/path`, true);
    add(sourceObject, "status", `/discovery/sources/${index}/status`, true);
    add(sourceObject, "role", `/discovery/sources/${index}/role`, true);
    add(sourceObject, "sha256", `/discovery/sources/${index}/sha256`, true);
    const extraction = source.extraction as unknown as Record<string, unknown>;
    add(extraction, "title", `/discovery/sources/${index}/extraction/title`, false);
    addArray(
      source.extraction.headings,
      `/discovery/sources/${index}/extraction/headings`,
      false,
    );
  });
  manifest.discovery.binaryCollections.forEach((collection, index) => {
    const object = collection as unknown as Record<string, unknown>;
    add(object, "directory", `/discovery/binaryCollections/${index}/directory`, true);
    add(object, "role", `/discovery/binaryCollections/${index}/role`, true);
    addArray(
      collection.extensions,
      `/discovery/binaryCollections/${index}/extensions`,
      true,
    );
  });
  manifest.discovery.warnings.forEach((warning, index) => {
    add(
      warning as unknown as Record<string, unknown>,
      "code",
      `/discovery/warnings/${index}/code`,
      true,
    );
  });
  manifest.discovery.exclusions.forEach((exclusion, index) => {
    const object = exclusion as unknown as Record<string, unknown>;
    add(object, "path", `/discovery/exclusions/${index}/path`, true);
    add(object, "reason", `/discovery/exclusions/${index}/reason`, true);
  });

  const project = manifest.proposal.project as unknown as Record<string, unknown>;
  add(project, "name", "/proposal/project/name", true);
  add(project, "primaryRepositoryPath", "/proposal/project/primaryRepositoryPath", true);

  manifest.proposal.records.forEach((record, index) => {
    const object = record as unknown as Record<string, unknown>;
    for (const key of ["key", "kind", "status", "sourceKind"]) {
      add(object, key, `/proposal/records/${index}/${pointer(key)}`, true);
    }
    for (const key of ["title", "body", "curationReason"]) {
      add(object, key, `/proposal/records/${index}/${pointer(key)}`, false);
    }
    add(object, "sourceRef", `/proposal/records/${index}/sourceRef`, true);
    addArray(record.sourceRefs, `/proposal/records/${index}/sourceRefs`, true);
  });

  manifest.proposal.relationships.forEach((relationship, index) => {
    const object = relationship as unknown as Record<string, unknown>;
    for (const key of ["fromKey", "toKey", "kind"]) {
      add(
        object,
        key,
        `/proposal/relationships/${index}/${pointer(key)}`,
        true,
      );
    }
  });
  return leaves;
};

const compareSpanPriority = (left: DetectedSpan, right: DetectedSpan): number => {
  const action = Number(right.requiredAction === "forced_redact") -
    Number(left.requiredAction === "forced_redact");
  if (action !== 0) return action;
  const severity = Number(right.severity === "credential") -
    Number(left.severity === "credential");
  if (severity !== 0) return severity;
  const confidence = Number(right.confidence === "high") -
    Number(left.confidence === "high");
  if (confidence !== 0) return confidence;
  const length = (right.end - right.start) - (left.end - left.start);
  if (length !== 0) return length;
  const priority = (detectorPriorities[left.detectorId] ?? Number.MAX_SAFE_INTEGER) -
    (detectorPriorities[right.detectorId] ?? Number.MAX_SAFE_INTEGER);
  if (priority !== 0) return priority;
  return compareOrdinal(left.detectorId, right.detectorId);
};

const canonicalSpanOrder = (left: DetectedSpan, right: DetectedSpan): number =>
  compareOrdinal(left.path, right.path) ||
  left.start - right.start ||
  left.end - right.end ||
  compareOrdinal(left.detectorId, right.detectorId);

const overlaps = (left: DetectedSpan, right: DetectedSpan): boolean =>
  left.path === right.path && left.start < right.end && right.start < left.end;

const localRepositoryIdentityPaths = new Set([
  "/repository/root",
  "/proposal/project/primaryRepositoryPath",
]);

const isRequiredLocalRepositoryIdentity = (span: DetectedSpan): boolean =>
  span.category === "local_user_path" &&
  localRepositoryIdentityPaths.has(span.path);

const resolveOverlaps = (spans: readonly DetectedSpan[]): DetectedSpan[] => {
  const selected: DetectedSpan[] = [];
  for (const span of [...spans].sort(compareSpanPriority)) {
    if (!selected.some((existing) => overlaps(span, existing))) selected.push(span);
  }
  return selected.sort(canonicalSpanOrder);
};

const toFinding = (span: DetectedSpan): ImportSafetyFinding => ({
  detectorId: span.detectorId,
  detectorVersion: OUTBOUND_DETECTOR_VERSION,
  category: span.category,
  confidence: span.confidence,
  severity: span.severity,
  path: span.path,
  start: span.start,
  end: span.end,
  requiredAction: span.requiredAction,
});

const strictNormalizedManifest = (
  manifest: RepositoryImportManifest,
): RepositoryImportManifest => {
  try {
    return normalizeImportManifest(manifest);
  } catch {
    throw new RepositoryImportError("manifest_invalid", {});
  }
};

export const normalizeManifestSafety = (
  input: RepositoryImportManifest,
): SafeManifestResult => {
  const manifest = strictNormalizedManifest(input);
  const leaves = manifestStringLeaves(manifest);
  const leafByPath = new Map(leaves.map((leaf) => [leaf.path, leaf]));
  const spans = resolveOverlaps(
    leaves.flatMap((leaf) =>
      detectText(leaf.path, leaf.value)
        .filter((span) => !isRequiredLocalRepositoryIdentity(span))
    ),
  );
  const blocked = spans.filter((span) =>
    span.requiredAction === "forced_redact" ||
    leafByPath.get(span.path)?.blockPossible === true,
  );
  if (blocked.length > 0) {
    throw new RepositoryImportError("sensitive_content_blocked", {
      count: blocked.length,
    });
  }

  const numbered = spans.map((span, index) => ({
    span,
    placeholder: `[REDACTED:${span.category.toUpperCase()}:${index + 1}]`,
  }));
  const replacementsByPath = new Map<string, typeof numbered>();
  for (const replacement of numbered) {
    const replacements = replacementsByPath.get(replacement.span.path) ?? [];
    replacements.push(replacement);
    replacementsByPath.set(replacement.span.path, replacements);
  }
  for (const [path, replacements] of replacementsByPath) {
    const leaf = leafByPath.get(path);
    if (leaf === undefined) {
      throw new RepositoryImportError("manifest_invalid", {});
    }
    let value = leaf.value;
    for (const replacement of [...replacements].sort(
      (left, right) => right.span.start - left.span.start ||
        right.span.end - left.span.end ||
        compareOrdinal(right.span.detectorId, left.span.detectorId),
    )) {
      value = `${value.slice(0, replacement.span.start)}${replacement.placeholder}${value.slice(replacement.span.end)}`;
    }
    leaf.set(value);
  }

  const normalized = strictNormalizedManifest(manifest);
  return {
    manifest: normalized,
    findings: spans.map(toFinding),
    digest: computeImportManifestDigest(normalized),
  };
};

const recordSummary = (
  record: ProposedImportRecord,
): ImportInspectionRecordSummary => ({
  key: record.key,
  kind: record.kind,
  status: record.status,
  title: record.title,
  sourceKind: record.sourceKind,
  sourceRef: record.sourceRef,
});

const claimSummary = (
  record: ProposedImportRecord,
): ImportInspectionClaimSummary => ({
  key: record.key,
  kind: record.kind,
  status: record.status,
  title: record.title,
  sourceKind: record.sourceKind,
  curationReason: record.curationReason,
});

const countedEntries = <Value extends string>(
  values: readonly Value[],
): Array<readonly [Value, number]> => {
  const counts = new Map<Value, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right));
};

const stableFrameKinds = new Set<RecordKind>([
  "vision",
  "outcome",
  "constraint",
  "non_goal",
]);

const findingSummaries = (
  findings: readonly ImportSafetyFinding[],
): ImportSensitiveFindingSummary[] => {
  const counts = new Map<string, ImportSensitiveFindingSummary>();
  for (const finding of findings) {
    const key = `${finding.category}\u0000${finding.severity}`;
    const prior = counts.get(key);
    counts.set(key, {
      category: finding.category,
      severity: finding.severity,
      count: (prior?.count ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((left, right) =>
    compareOrdinal(left.category, right.category) ||
    compareOrdinal(left.severity, right.severity),
  );
};

export const inspectImportManifest = (
  input: RepositoryImportManifest,
): ImportInspection => {
  const safe = normalizeManifestSafety(input);
  const records = safe.manifest.proposal.records;
  const relationships = safe.manifest.proposal.relationships;

  const inspection: ImportInspection = {
    manifestDigest: safe.digest,
    repository: { ...safe.manifest.repository },
    project: { ...safe.manifest.proposal.project },
    counts: {
      recordsByKind: countedEntries(records.map(({ kind }) => kind))
        .map(([kind, count]) => ({ kind, count })),
      recordsByStatus: countedEntries(records.map(({ status }) => status))
        .map(([status, count]) => ({ status, count })),
      recordsBySourceKind: countedEntries(records.map(({ sourceKind }) => sourceKind))
        .map(([sourceKind, count]) => ({ sourceKind, count })),
    },
    stableFrame: records
      .filter((record) =>
        record.status === "accepted" && stableFrameKinds.has(record.kind)
      )
      .map(recordSummary),
    activeTasks: records
      .filter((record) => record.kind === "task" && record.status === "active")
      .map((record) => ({
        ...recordSummary(record),
        kind: "task",
        status: "active",
        directLinks: relationships
          .filter(({ fromKey, toKey }) => fromKey === record.key || toKey === record.key)
          .map((relationship) => ({ ...relationship })),
      })),
    curatedOrProvisionalClaims: records
      .filter((record) => record.status === "provisional" || record.curationReason !== null)
      .map(claimSummary),
    sensitiveFindings: findingSummaries(safe.findings),
    warnings: safe.manifest.discovery.warnings.map((warning) => ({ ...warning })),
    exclusions: safe.manifest.discovery.exclusions.map((exclusion) => ({ ...exclusion })),
  };
  return importInspectionSchema.parse(inspection);
};
