import { createHash } from "node:crypto";
import type {
  RepositoryDiffEntry,
  RepositoryDiffKind,
  RepositoryNodeObservation,
  RepositoryObservationInput,
  RepositorySnapshotDiff,
} from "../domain/repository-index-model.js";
import { repositorySnapshotDiffSchema } from "../domain/repository-index-schemas.js";
import type { ChangeOperation } from "../domain/governance-model.js";
import type { GitStatusEntry } from "../import/git-repository.js";

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const MAX_DISPLAY_PATH_LENGTH = 240;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g;
const tokenDelimiterRun = /[-_.\s]+/gu;
const evidenceArtifactTokens = new Set(["evidence", "report", "result", "results"]);
const supportArtifactTokens = new Set([
  "fixture",
  "fixtures",
  "input",
  "inputs",
  "sample",
  "samples",
  "snapshot",
  "snapshots",
]);

const pathTokensFor = (path: string): readonly (readonly string[])[] =>
  normalizePath(path.replace(controlCharacters, ""))
    .toLowerCase()
    .split("/")
    .map((segment) => segment.split(tokenDelimiterRun).filter(Boolean));

const isSupportArtifactTokens = (tokens: readonly string[]): boolean =>
  tokens.some((token) => supportArtifactTokens.has(token)) ||
  tokens.includes("testdata") ||
  tokens.some((token, index) => token === "test" && tokens[index + 1] === "data");

const isConservativeEvidenceArtifact = (path: string): boolean => {
  const segments = pathTokensFor(path);
  const name = segments.at(-1) ?? [];
  return name.some((token) => evidenceArtifactTokens.has(token)) &&
    !segments.some(isSupportArtifactTokens);
};

const displayPathFor = (path: string): string => {
  const canonical = normalizePath(path.replace(controlCharacters, ""))
    .replace(tokenDelimiterRun, (run) => {
      if (run.trim() === "") return " ";
      return run.length === 1 ? run : "-";
    })
    .trim() || "repository artifact";
  if (canonical.length <= MAX_DISPLAY_PATH_LENGTH) return canonical;
  const headLength = Math.floor((MAX_DISPLAY_PATH_LENGTH - 1) / 2);
  const tailLength = MAX_DISPLAY_PATH_LENGTH - 1 - headLength;
  return `${canonical.slice(0, headLength)}…${canonical.slice(-tailLength)}`;
};

const candidateNodeId = (value: RepositoryObservationInput): string | null =>
  "nodeId" in value && typeof value.nodeId === "string" ? value.nodeId : null;

const sameObservation = (
  accepted: RepositoryNodeObservation,
  candidate: RepositoryObservationInput,
): boolean =>
  accepted.kind === candidate.kind &&
  accepted.sha256 === candidate.sha256 &&
  accepted.byteSize === candidate.byteSize &&
  accepted.sourceStatus === candidate.sourceStatus &&
  accepted.role === candidate.role &&
  accepted.documentKind === candidate.documentKind &&
  accepted.documentFormat === candidate.documentFormat &&
  accepted.contentEligible === candidate.contentEligible &&
  accepted.instructionClient === candidate.instructionClient &&
  accepted.instructionScope === candidate.instructionScope;

const operationIdFor = (
  kind: RepositoryDiffKind,
  previousNodeId: string | null,
  currentNodeId: string | null,
  previousPath: string | null,
  currentPath: string | null,
): string => `repository-diff-${createHash("sha256").update(JSON.stringify([
  kind,
  previousNodeId,
  currentNodeId,
  previousPath,
  currentPath,
])).digest("hex")}`;

const meaningOperationIdFor = (
  path: string,
  sha256: string | null,
): string => `repository-meaning-${createHash("sha256").update(JSON.stringify([
  "new_test_evidence",
  path,
  sha256,
])).digest("hex")}`;

const entry = (
  kind: RepositoryDiffKind,
  previousNodeId: string | null,
  currentNodeId: string | null,
  previousPath: string | null,
  currentPath: string | null,
): RepositoryDiffEntry => ({
  operationId: operationIdFor(
    kind,
    previousNodeId,
    currentNodeId,
    previousPath,
    currentPath,
  ),
  kind,
  previousNodeId,
  currentNodeId,
  previousPath,
  currentPath,
});

const compareEntries = (left: RepositoryDiffEntry, right: RepositoryDiffEntry): number =>
  compareOrdinal(left.previousPath ?? "", right.previousPath ?? "") ||
  compareOrdinal(left.currentPath ?? "", right.currentPath ?? "") ||
  compareOrdinal(left.previousNodeId ?? "", right.previousNodeId ?? "") ||
  compareOrdinal(left.currentNodeId ?? "", right.currentNodeId ?? "");

interface RenameClaim {
  readonly originalPath: string;
  readonly path: string;
}

export const compareRepositoryObservations = (
  accepted: readonly RepositoryNodeObservation[],
  candidate: readonly RepositoryObservationInput[],
  gitEntries: readonly GitStatusEntry[],
): RepositorySnapshotDiff => {
  const acceptedByPath = new Map(
    accepted.map((value) => [normalizePath(value.path), value] as const),
  );
  const candidateByPath = new Map(
    candidate.map((value) => [normalizePath(value.path), value] as const),
  );
  const matchedAccepted = new Set<string>();
  const matchedCandidate = new Set<string>();
  const entries: RepositoryDiffEntry[] = [];

  for (const path of [...acceptedByPath.keys()].sort(compareOrdinal)) {
    const prior = acceptedByPath.get(path)!;
    const current = candidateByPath.get(path);
    if (!current) continue;
    matchedAccepted.add(path);
    matchedCandidate.add(path);
    const currentNodeId = candidateNodeId(current) ?? prior.nodeId;
    const kind: RepositoryDiffKind = prior.kind !== current.kind
      ? "conflicted"
      : sameObservation(prior, current)
        ? "unchanged"
        : "changed";
    entries.push(entry(kind, prior.nodeId, currentNodeId, path, path));
  }

  const claimKeys = new Set<string>();
  const claims: RenameClaim[] = [];
  const addClaim = (originalPath: string, path: string): void => {
    const normalizedOriginal = normalizePath(originalPath);
    const normalizedCurrent = normalizePath(path);
    if (
      matchedAccepted.has(normalizedOriginal) ||
      matchedCandidate.has(normalizedCurrent) ||
      !acceptedByPath.has(normalizedOriginal) ||
      !candidateByPath.has(normalizedCurrent)
    ) return;
    const key = `${normalizedOriginal}\0${normalizedCurrent}`;
    if (claimKeys.has(key)) return;
    claimKeys.add(key);
    claims.push({ originalPath: normalizedOriginal, path: normalizedCurrent });
  };

  for (const status of gitEntries) {
    if (
      status.originalPath !== null &&
      (status.index === "R" || status.worktree === "R")
    ) addClaim(status.originalPath, status.path);
  }
  const acceptedByNodeId = new Map(accepted.map((value) => [value.nodeId, value] as const));
  for (const current of candidate) {
    const nodeId = candidateNodeId(current);
    const prior = nodeId === null ? undefined : acceptedByNodeId.get(nodeId);
    if (prior && prior.path !== current.path) addClaim(prior.path, current.path);
  }

  const originalCounts = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  for (const claim of claims) {
    originalCounts.set(claim.originalPath, (originalCounts.get(claim.originalPath) ?? 0) + 1);
    currentCounts.set(claim.path, (currentCounts.get(claim.path) ?? 0) + 1);
  }
  for (const claim of claims.sort((left, right) =>
    compareOrdinal(left.originalPath, right.originalPath) ||
    compareOrdinal(left.path, right.path))) {
    const prior = acceptedByPath.get(claim.originalPath)!;
    const current = candidateByPath.get(claim.path)!;
    const ambiguous = originalCounts.get(claim.originalPath) !== 1 ||
      currentCounts.get(claim.path) !== 1;
    if (ambiguous) continue;
    const kind: RepositoryDiffKind = prior.kind !== current.kind
      ? "conflicted"
      : "moved";
    const currentNodeId = kind === "moved"
      ? prior.nodeId
      : candidateNodeId(current);
    entries.push(entry(
      kind,
      prior.nodeId,
      currentNodeId,
      claim.originalPath,
      claim.path,
    ));
    matchedAccepted.add(claim.originalPath);
    matchedCandidate.add(claim.path);
  }

  for (const [path, prior] of acceptedByPath) {
    if (!matchedAccepted.has(path)) {
      entries.push(entry("removed", prior.nodeId, null, path, null));
    }
  }
  for (const [path, current] of candidateByPath) {
    if (!matchedCandidate.has(path)) {
      entries.push(entry("added", null, candidateNodeId(current), null, path));
    }
  }

  const byKind = new Map<RepositoryDiffKind, RepositoryDiffEntry[]>();
  for (const value of entries) {
    const group = byKind.get(value.kind) ?? [];
    group.push(value);
    byKind.set(value.kind, group);
  }
  const groups = [...byKind.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([kind, values]) => ({ kind, entries: values.sort(compareEntries) }));
  const semanticOperations: ChangeOperation[] = (byKind.get("added") ?? [])
    .map(({ currentPath }) => currentPath === null
      ? undefined
      : candidateByPath.get(currentPath))
    .filter((observation): observation is RepositoryObservationInput =>
      observation !== undefined &&
      observation.kind === "file" &&
      observation.sourceStatus === "tracked" &&
      observation.role === "test" &&
      observation.contentEligible &&
      observation.documentKind === "test_evidence" &&
      isConservativeEvidenceArtifact(observation.path))
    .sort((left, right) => compareOrdinal(left.path, right.path))
    .map((observation) => {
      const operationId = meaningOperationIdFor(observation.path, observation.sha256);
      const displayPath = displayPathFor(observation.path);
      return {
        operationId,
        type: "create_record",
        localRef: operationId,
        kind: "evidence",
        status: "provisional",
        title: `Repository test evidence: ${displayPath}`,
        body: `Repository refresh observed new test evidence at ${displayPath}. Review it before accepting this project evidence.`,
      };
    });
  return repositorySnapshotDiffSchema.parse({ groups, semanticOperations });
};
