import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import type {
  RepositoryDocumentFormat,
  RepositoryDocumentKind,
  RepositoryObservationCandidate,
  RepositoryObservationInput,
  RepositoryScanProgress,
} from "../domain/repository-index-model.js";
import { repositoryObservationCandidateSchema } from "../domain/repository-index-schemas.js";
import type {
  ImportExclusion,
  ImportWarning,
  RepositorySourceRole,
} from "../domain/import-model.js";
import {
  REPOSITORY_RULESET_VERSION,
  REPOSITORY_SCANNER_VERSION,
} from "../domain/import-model.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  classifyFilesystemPath,
  hasBinaryExtension,
  inspectFileContent,
  isEligibleUntrackedText,
  isHardExcludedPath,
  isKnownSecretPath,
  MAX_TEXT_FILE_BYTES,
  resolveCanonicalSubpath,
} from "../import/filesystem-policy.js";
import {
  readGitRepositoryStateAsync,
  revalidateGitRepositoryFilesystemClaimAsync,
  type GitRepositoryObservationState,
} from "../import/git-repository.js";
import { detectText } from "../outbound/detectors.js";
import {
  inspectRepositoryPath,
  readSafeRepositoryFileAsync,
  type RepositoryPathInspection,
  type SafeFileReaderDependencies,
} from "./safe-file-reader.js";

export const MAX_OBSERVED_FILES = 100_000;
export const MAX_OBSERVED_DEPTH = 64;
export const MAX_OBSERVED_METADATA_BYTES = 64 * 1024 * 1024;

const FILESYSTEM_BATCH_SIZE = 64;

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolvePromise) => setImmediate(resolvePromise));

export type RepositoryObservationLimit = "files" | "depth" | "metadata";

export class RepositoryObservationLimitError extends Error {
  readonly limit: RepositoryObservationLimit;

  constructor(limit: RepositoryObservationLimit) {
    super("Repository observation exceeded a safe local scan limit.");
    this.name = "RepositoryObservationLimitError";
    this.limit = limit;
  }
}

export type RepositoryObservationDriftReason =
  | "root"
  | "branch"
  | "head"
  | "ruleset"
  | "scanner"
  | "path_set"
  | "content_hash"
  | "metadata"
  | "fingerprint";

export class RepositoryObservationDriftError extends Error {
  readonly reason: RepositoryObservationDriftReason;

  constructor(reason: RepositoryObservationDriftReason) {
    super("Repository observation has drifted.");
    this.name = "RepositoryObservationDriftError";
    this.reason = reason;
  }
}

export interface RepositoryObservationScanner {
  scan(
    input: { root: string; canonicalSubpath: string | null },
    options: {
      signal: AbortSignal;
      onProgress(progress: RepositoryScanProgress): void;
    },
  ): Promise<RepositoryObservationCandidate>;
  verify(candidate: RepositoryObservationCandidate, signal?: AbortSignal): Promise<void>;
}

export interface RepositoryObservationScannerDependencies extends SafeFileReaderDependencies {
  readonly readGitRepositoryStateAsync?: (
    root: string,
    signal: AbortSignal,
  ) => Promise<GitRepositoryObservationState>;
}

interface DiscoveredFile {
  readonly path: string;
  readonly sourceStatus: "tracked" | "untracked";
  readonly inspected: Extract<RepositoryPathInspection, { readonly kind: "file" }>;
}

interface HashedFile {
  readonly path: string;
  readonly sourceStatus: "tracked" | "untracked";
  readonly sha256: string;
  readonly byteSize: number;
  readonly detectedAsText: boolean;
  readonly findingCounts: Readonly<Record<"credential" | "sensitive", number>>;
}

const normalizeCanonicalRoot = (inputRoot: string): string => {
  try {
    const root = realpathSync(resolve(inputRoot));
    if (!lstatSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new RepositoryImportError("repository_not_found", {
        path: normalizePath(resolve(inputRoot)),
      });
    }
    throw new RepositoryImportError("repository_root_invalid", {
      path: normalizePath(resolve(inputRoot)),
    });
  }
};

const sameFilesystemPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase()
    : normalizePath(left) === normalizePath(right);

const canonicalSubpathFor = (
  root: string,
  input: string | null,
): string | null => {
  const canonical = resolveCanonicalSubpath(root, input);
  try {
    const kind = canonical.subpath === null
      ? lstatSync(canonical.path).isDirectory() ? "directory" : "other"
      : classifyFilesystemPath(root, canonical.subpath).kind;
    if (kind !== "directory") throw new Error("not a directory");
  } catch {
    throw new RepositoryImportError("canonical_path_invalid", {
      path: canonical.subpath ?? "repository",
    });
  }
  return canonical.subpath === null
    ? null
    : process.platform === "win32"
      ? normalizePath(relative(root, realpathSync.native(canonical.path)))
      : canonical.subpath;
};

const pathWithinCanonical = (
  path: string,
  canonicalSubpath: string | null,
): boolean => canonicalSubpath === null ||
  path === canonicalSubpath ||
  path.startsWith(`${canonicalSubpath}/`);

const roleFor = (
  path: string,
  canonicalSubpath: string | null,
  binary: boolean,
): RepositorySourceRole => {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (binary) return "asset";
  if (basename(lower).startsWith("readme") || segments.includes("docs")) {
    return "supporting_document";
  }
  if (
    segments.some((segment) => segment === "test" || segment === "tests") ||
    /\.(?:spec|test)\.[^.]+$/.test(lower)
  ) {
    return "test";
  }
  if (segments.some((segment) => segment === "tool" || segment === "tools")) {
    return "tool";
  }
  if (pathWithinCanonical(path, canonicalSubpath)) return "canonical_source";
  return canonicalSubpath === null ? "canonical_source" : "archived_source";
};

const firstHardExcludedPath = (path: string): string | null => {
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    if (isHardExcludedPath(segments[index]!)) {
      return segments.slice(0, index + 1).join("/");
    }
  }
  return null;
};

const addExclusion = (
  exclusions: Map<string, ImportExclusion>,
  path: string | null,
  reason: ImportExclusion["reason"],
): void => {
  const key = `${reason}\0${path ?? ""}`;
  const prior = exclusions.get(key);
  exclusions.set(key, { path, reason, count: (prior?.count ?? 0) + 1 });
};

const sortExclusions = (values: Iterable<ImportExclusion>): ImportExclusion[] =>
  [...values].sort((left, right) =>
    compareOrdinal(left.reason, right.reason) ||
    compareOrdinal(left.path ?? "", right.path ?? ""),
  );

const sortWarnings = (values: readonly ImportWarning[]): ImportWarning[] =>
  [...values].sort((left, right) => compareOrdinal(left.code, right.code));

const renameEvidenceFor = (
  entries: GitRepositoryObservationState["entries"],
  observations: readonly RepositoryObservationInput[],
): { originalPath: string; path: string }[] => {
  const observedFiles = new Set(
    observations
      .filter(({ kind }) => kind === "file")
      .map(({ path }) => path),
  );
  return entries
    .filter((entry): entry is typeof entry & { originalPath: string } =>
      entry.originalPath !== null &&
      (entry.index === "R" || entry.worktree === "R") &&
      firstHardExcludedPath(entry.originalPath) === null &&
      firstHardExcludedPath(entry.path) === null &&
      !isKnownSecretPath(entry.originalPath) &&
      !isKnownSecretPath(entry.path) &&
      observedFiles.has(entry.path))
    .map(({ originalPath, path }) => ({ originalPath, path }))
    .sort((left, right) =>
      compareOrdinal(left.originalPath, right.originalPath) ||
      compareOrdinal(left.path, right.path));
};

const imageExtensions = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const markdownExtensions = new Set([".md", ".markdown", ".mdown"]);
const plainTextExtensions = new Set([".txt", ".text", ".rst"]);

const initialFormatFor = (path: string): RepositoryDocumentFormat => {
  const extension = extname(path).toLowerCase();
  if (markdownExtensions.has(extension)) return "markdown";
  if (plainTextExtensions.has(extension)) return "plain_text";
  if (imageExtensions.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  return "unsupported";
};

interface InstructionLabels {
  readonly client: string;
  readonly scope: string;
}

const instructionLabelsFor = (path: string): InstructionLabels | null => {
  const lower = path.toLowerCase();
  const name = basename(lower);
  let client: string | null = null;
  if (name === "agents.md") client = "codex";
  else if (name === "claude.md") client = "claude-code";
  else if (name === "gemini.md") client = "gemini";
  else if (lower === ".github/copilot-instructions.md") client = "github-copilot";
  else if (name === ".cursorrules" || lower.startsWith(".cursor/rules/")) client = "cursor";
  if (client === null) return null;
  const directory = normalizePath(dirname(path));
  return { client, scope: directory === "." ? "repository" : directory };
};

const documentKindFor = (
  path: string,
  format: RepositoryDocumentFormat,
  instruction: InstructionLabels | null,
): RepositoryDocumentKind | null => {
  if (instruction !== null) return "ai_instruction";
  if (format === "unsupported") return null;
  if (format === "image" || format === "pdf") return "unlinked";

  const lower = path.toLowerCase();
  const name = basename(lower);
  const segments = lower.split("/");
  if (name.startsWith("readme") || name.includes("overview")) return "overview";
  if (/\b(?:spec|specification|requirements?|architecture)\b/.test(lower.replaceAll(/[-_.\/]/g, " "))) {
    return "specification";
  }
  if (
    segments.includes("decisions") ||
    /^(?:adr|rfc|decision)[-_]?\d*/.test(name)
  ) {
    return "decision_support";
  }
  if (
    segments.some((segment) => segment === "test" || segment === "tests") ||
    /(?:test|evidence)/.test(name)
  ) {
    return "test_evidence";
  }
  if (/(?:guide|runbook|playbook|operations?|manual)/.test(name)) {
    return "operational_guide";
  }
  return "unlinked";
};

const parentDirectories = (path: string): string[] => {
  const segments = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
};

const assertMetadataBudget = (
  observations: readonly RepositoryObservationInput[],
): void => {
  if (Buffer.byteLength(JSON.stringify(observations), "utf8") > MAX_OBSERVED_METADATA_BYTES) {
    throw new RepositoryObservationLimitError("metadata");
  }
};

const candidateFingerprint = (
  candidate: Omit<RepositoryObservationCandidate, "fingerprint">,
): string => sha256(JSON.stringify(candidate));

const observationPaths = (
  candidate: RepositoryObservationCandidate,
): string[] => candidate.observations.map(({ path }) => path);

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const scanRepository = async (
  input: { root: string; canonicalSubpath: string | null },
  options: {
    signal: AbortSignal;
    onProgress(progress: RepositoryScanProgress): void;
  },
  dependencies: RepositoryObservationScannerDependencies,
): Promise<RepositoryObservationCandidate> => {
  const { signal, onProgress } = options;
  signal.throwIfAborted();
  const root = normalizeCanonicalRoot(input.root);
  signal.throwIfAborted();
  const gitState = await (
    dependencies.readGitRepositoryStateAsync ?? readGitRepositoryStateAsync
  )(root, signal);
  signal.throwIfAborted();
  if (!sameFilesystemPath(root, gitState.root)) {
    throw new RepositoryImportError("repository_root_invalid", {
      path: normalizePath(root),
    });
  }
  const canonicalSubpath = canonicalSubpathFor(root, input.canonicalSubpath);
  signal.throwIfAborted();

  const tracked = new Set(gitState.tracked);
  const candidates = [...new Set([...gitState.tracked, ...gitState.untracked])]
    .sort(compareOrdinal);
  if (candidates.length > MAX_OBSERVED_FILES) {
    throw new RepositoryObservationLimitError("files");
  }
  const total = candidates.length * 3 + 1;
  onProgress({ phase: "discovering", processed: 0, total });
  signal.throwIfAborted();
  const exclusions = new Map<string, ImportExclusion>();
  const discovered: DiscoveredFile[] = [];

  for (let start = 0; start < candidates.length; start += FILESYSTEM_BATCH_SIZE) {
    signal.throwIfAborted();
    const end = Math.min(start + FILESYSTEM_BATCH_SIZE, candidates.length);
    for (let index = start; index < end; index += 1) {
      const path = candidates[index]!;
      const hardExcluded = firstHardExcludedPath(path);
      if (hardExcluded !== null) {
        addExclusion(exclusions, hardExcluded, "hard_exclusion");
        continue;
      }
      if (isKnownSecretPath(path)) {
        addExclusion(exclusions, null, "known_secret_path");
        continue;
      }
      const sourceStatus = tracked.has(path) ? "tracked" : "untracked";
      if (sourceStatus === "untracked" && !isEligibleUntrackedText(path)) {
        addExclusion(exclusions, path, "untracked_not_eligible");
        continue;
      }
      if (path.split("/").length > MAX_OBSERVED_DEPTH) {
        throw new RepositoryObservationLimitError("depth");
      }
      const inspected = inspectRepositoryPath(root, path);
      if (inspected.kind === "link") {
        addExclusion(exclusions, inspected.path, "link_not_followed");
      } else if (inspected.kind === "unsupported") {
        addExclusion(exclusions, path, "unsupported_text");
      } else {
        discovered.push({ path, sourceStatus, inspected });
      }
    }
    signal.throwIfAborted();
    onProgress({ phase: "discovering", processed: end, total });
    signal.throwIfAborted();
    await yieldToEventLoop();
    signal.throwIfAborted();
  }

  const hashed: HashedFile[] = [];
  const findingCounts = { credential: 0, sensitive: 0 };
  onProgress({ phase: "hashing", processed: candidates.length, total });
  signal.throwIfAborted();
  for (let start = 0; start < discovered.length; start += FILESYSTEM_BATCH_SIZE) {
    signal.throwIfAborted();
    const end = Math.min(start + FILESYSTEM_BATCH_SIZE, discovered.length);
    for (let index = start; index < end; index += 1) {
      const file = discovered[index]!;
      const binaryExtension = hasBinaryExtension(file.path);
      if (
        !binaryExtension &&
        file.inspected.status.size > BigInt(MAX_TEXT_FILE_BYTES)
      ) {
        const read = await readSafeRepositoryFileAsync(
          root,
          file.path,
          file.inspected,
          "metadata",
          signal,
          dependencies,
        );
        if (read.kind === "unsupported") {
          addExclusion(exclusions, file.path, "unsupported_text");
        } else {
          addExclusion(exclusions, file.path, "oversized_text");
        }
        continue;
      }

      const read = await readSafeRepositoryFileAsync(
        root,
        file.path,
        file.inspected,
        binaryExtension ? "hash" : "content",
        signal,
        dependencies,
      );
      if (read.kind === "unsupported" || read.sha256 === null) {
        addExclusion(exclusions, file.path, "unsupported_text");
        continue;
      }

      let detectedAsText = false;
      const fileFindingCounts = { credential: 0, sensitive: 0 };
      if (read.content !== null) {
        const content = inspectFileContent(file.path, read.content);
        if (content.kind === "text") {
          detectedAsText = true;
          for (const finding of detectText(file.path, content.text)) {
            fileFindingCounts[finding.severity] += 1;
            findingCounts[finding.severity] += 1;
          }
        }
      }
      hashed.push({
        path: file.path,
        sourceStatus: file.sourceStatus,
        sha256: read.sha256,
        byteSize: read.byteSize,
        detectedAsText,
        findingCounts: fileFindingCounts,
      });
    }
    signal.throwIfAborted();
    onProgress({
      phase: "hashing",
      processed: candidates.length + end,
      total,
    });
    signal.throwIfAborted();
    await yieldToEventLoop();
    signal.throwIfAborted();
  }

  const fileObservations: RepositoryObservationInput[] = [];
  onProgress({ phase: "classifying", processed: candidates.length * 2, total });
  signal.throwIfAborted();
  for (let start = 0; start < hashed.length; start += FILESYSTEM_BATCH_SIZE) {
    signal.throwIfAborted();
    const end = Math.min(start + FILESYSTEM_BATCH_SIZE, hashed.length);
    for (let index = start; index < end; index += 1) {
      const file = hashed[index]!;
      const initialFormat = initialFormatFor(file.path);
      const format = (
          initialFormat === "markdown" || initialFormat === "plain_text"
        ) && !file.detectedAsText
        ? "unsupported"
        : initialFormat;
      const instruction = instructionLabelsFor(file.path);
      const documentKind = documentKindFor(file.path, format, instruction);
      const findingCount = file.findingCounts.credential + file.findingCounts.sensitive;
      const contentEligible = (
        format === "markdown" ||
        format === "plain_text" ||
        format === "image" ||
        format === "pdf"
      ) && findingCount === 0;
      const binary = format === "image" || format === "pdf" ||
        (!file.detectedAsText && hasBinaryExtension(file.path));
      fileObservations.push({
        path: file.path,
        kind: "file",
        sha256: file.sha256,
        byteSize: file.byteSize,
        sourceStatus: file.sourceStatus,
        role: roleFor(file.path, canonicalSubpath, binary),
        documentKind,
        documentFormat: format,
        contentEligible,
        instructionClient: instruction?.client ?? null,
        instructionScope: instruction?.scope ?? null,
      });
    }
    onProgress({
      phase: "classifying",
      processed: candidates.length * 2 + end,
      total,
    });
    signal.throwIfAborted();
    await yieldToEventLoop();
    signal.throwIfAborted();
  }

  const directoryPaths = new Set<string>();
  for (const observation of fileObservations) {
    for (const directory of parentDirectories(observation.path)) {
      directoryPaths.add(directory);
    }
  }
  const directoryObservations: RepositoryObservationInput[] = [...directoryPaths]
    .sort(compareOrdinal)
    .map((path) => ({
      path,
      kind: "directory",
      sha256: null,
      byteSize: 0,
      sourceStatus: "derived",
      role: roleFor(path, canonicalSubpath, false),
      documentKind: null,
      documentFormat: null,
      contentEligible: false,
      instructionClient: null,
      instructionScope: null,
    }));
  const observations = [...fileObservations, ...directoryObservations]
    .sort((left, right) => compareOrdinal(left.path, right.path));
  assertMetadataBudget(observations);

  const warnings: ImportWarning[] = [];
  if (gitState.worktreeCount > 1) {
    warnings.push({ code: "multiple_worktrees", count: gitState.worktreeCount });
  }
  const untrackedCount = fileObservations.filter(
    ({ sourceStatus }) => sourceStatus === "untracked",
  ).length;
  if (untrackedCount > 0) {
    warnings.push({ code: "untracked_document", count: untrackedCount });
  }
  if (gitState.entries.length > 0) {
    warnings.push({ code: "working_tree_dirty", count: gitState.entries.length });
  }

  const nonZeroFindingCounts = Object.fromEntries(
    Object.entries(findingCounts).filter(([, count]) => count > 0),
  );
  signal.throwIfAborted();
  await revalidateGitRepositoryFilesystemClaimAsync(
    root,
    gitState.repositoryFilesystemClaim,
    signal,
  );
  const withoutFingerprint: Omit<RepositoryObservationCandidate, "fingerprint"> = {
    root: normalizePath(root),
    canonicalSubpath,
    repositoryIdentity: gitState.repositoryIdentity,
    branch: gitState.branch,
    head: gitState.head,
    scannerVersion: REPOSITORY_SCANNER_VERSION,
    rulesetVersion: REPOSITORY_RULESET_VERSION,
    warnings: sortWarnings(warnings),
    exclusions: sortExclusions(exclusions.values()),
    findingCounts: nonZeroFindingCounts,
    renameEvidence: renameEvidenceFor(gitState.entries, observations),
    observations,
    links: [],
  };
  signal.throwIfAborted();
  const candidate = repositoryObservationCandidateSchema.parse({
    ...withoutFingerprint,
    fingerprint: candidateFingerprint(withoutFingerprint),
  });
  onProgress({ phase: "finalizing", processed: total, total });
  signal.throwIfAborted();
  return candidate;
};

const drift = (reason: RepositoryObservationDriftReason): never => {
  throw new RepositoryObservationDriftError(reason);
};

const verifyCandidate = async (
  candidate: RepositoryObservationCandidate,
  signal: AbortSignal,
  dependencies: RepositoryObservationScannerDependencies,
): Promise<void> => {
  signal.throwIfAborted();
  if (candidate.rulesetVersion !== REPOSITORY_RULESET_VERSION) drift("ruleset");
  if (candidate.scannerVersion !== REPOSITORY_SCANNER_VERSION) drift("scanner");

  const actual = await scanRepository(
      { root: candidate.root, canonicalSubpath: candidate.canonicalSubpath },
      { signal, onProgress: () => undefined },
      dependencies,
    ).catch((error: unknown) => {
      if (error instanceof RepositoryObservationDriftError) throw error;
      signal.throwIfAborted();
      return drift("root");
    });
  signal.throwIfAborted();

  if (candidate.root !== actual.root ||
    candidate.canonicalSubpath !== actual.canonicalSubpath ||
    candidate.repositoryIdentity !== actual.repositoryIdentity) drift("root");
  if (candidate.branch !== actual.branch) drift("branch");
  if (candidate.head !== actual.head) drift("head");
  if (candidate.rulesetVersion !== actual.rulesetVersion) drift("ruleset");
  if (candidate.scannerVersion !== actual.scannerVersion) drift("scanner");

  const expectedPaths = observationPaths(candidate);
  const actualPaths = observationPaths(actual);
  if (!sameStrings(expectedPaths, actualPaths)) drift("path_set");
  for (let index = 0; index < candidate.observations.length; index += 1) {
    if (candidate.observations[index]!.sha256 !== actual.observations[index]!.sha256) {
      drift("content_hash");
    }
  }
  const { fingerprint: _expectedFingerprint, ...expectedWithoutFingerprint } = candidate;
  const { fingerprint: _actualFingerprint, ...actualWithoutFingerprint } = actual;
  if (JSON.stringify(expectedWithoutFingerprint) !== JSON.stringify(actualWithoutFingerprint)) {
    drift("metadata");
  }
  if (candidate.fingerprint !== actual.fingerprint) drift("fingerprint");
};

export const createRepositoryObservationScanner = (
  dependencies: RepositoryObservationScannerDependencies = {},
): RepositoryObservationScanner => ({
  scan: (input, options) => scanRepository(input, options, dependencies),
  verify: (candidate, signal = new AbortController().signal) =>
    verifyCandidate(candidate, signal, dependencies),
});
