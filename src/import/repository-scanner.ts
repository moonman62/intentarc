import { createHash } from "node:crypto";
import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  relative,
  resolve,
} from "node:path";
import type {
  BinaryCollection,
  ImportExclusion,
  ImportWarning,
  RepositoryImportManifest,
  RepositoryImportSource,
  RepositorySourceRole,
} from "../domain/import-model.js";
import {
  IMPORT_MANIFEST_VERSION,
  REPOSITORY_RULESET_VERSION,
  REPOSITORY_SCANNER_VERSION,
} from "../domain/import-model.js";
import type {
  DiscoveredRepository,
  DiscoveredTextSource,
  RepositoryDiscoveryInput,
} from "./discovery-model.js";
import { RepositoryImportError } from "./errors.js";
import {
  classifyFilesystemPath,
  hasBinaryExtension,
  inspectFileContent,
  isEligibleUntrackedText,
  isHardExcludedPath,
  isKnownSecretPath,
  MAX_TEXT_FILE_BYTES,
  resolveCanonicalSubpath,
} from "./filesystem-policy.js";
import {
  readGitRepositoryState,
  type GitRepositoryIdentity,
  type GitRepositoryState,
} from "./git-repository.js";
import {
  inspectRepositoryPath,
  readSafeRepositoryFile,
  type SafeFileReaderDependencies,
} from "../repository/safe-file-reader.js";

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

export interface RepositoryScannerDependencies extends SafeFileReaderDependencies {
  readonly readGitRepositoryState?: (root: string) => GitRepositoryState;
  readonly readGitRepositoryIdentity?: (root: string) => GitRepositoryIdentity;
}

interface FingerprintSource {
  readonly path: string;
  readonly sha256: string;
}

interface FingerprintInput {
  readonly branch: string | null;
  readonly head: string | null;
  readonly canonicalSubpath: string | null;
  readonly rulesetVersion: string;
  readonly sources: readonly FingerprintSource[];
}

const fingerprint = (input: FingerprintInput): string =>
  sha256(JSON.stringify(input));

const pathWithinCanonical = (
  path: string,
  canonicalSubpath: string | null,
): boolean =>
  canonicalSubpath === null ||
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
  if (
    basename(lower).startsWith("readme") ||
    segments.includes("docs")
  ) {
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

interface MutableBinaryCollection {
  directory: string;
  role: RepositorySourceRole;
  extensions: Set<string>;
  count: number;
  byteSize: number;
}

const binaryDirectory = (path: string): string => {
  const directory = normalizePath(dirname(path));
  return directory === "." ? "" : directory;
};

const binaryExtension = (path: string): string =>
  extname(path).toLowerCase() || ".bin";

const addBinary = (
  collections: Map<string, MutableBinaryCollection>,
  path: string,
  byteSize: number,
  canonicalSubpath: string | null,
): void => {
  const directory = binaryDirectory(path);
  const role = roleFor(path, canonicalSubpath, true);
  const key = `${directory}\0${role}`;
  const collection = collections.get(key) ?? {
    directory,
    role,
    extensions: new Set<string>(),
    count: 0,
    byteSize: 0,
  };
  collection.extensions.add(binaryExtension(path));
  collection.count += 1;
  collection.byteSize += byteSize;
  collections.set(key, collection);
};

const addExclusion = (
  exclusions: Map<string, ImportExclusion>,
  path: string | null,
  reason: ImportExclusion["reason"],
): void => {
  const key = `${reason}\0${path ?? ""}`;
  const prior = exclusions.get(key);
  exclusions.set(key, {
    path,
    reason,
    count: (prior?.count ?? 0) + 1,
  });
};

const publicSource = (source: DiscoveredTextSource): RepositoryImportSource => ({
  path: source.path,
  status: source.status,
  role: source.role,
  byteSize: source.byteSize,
  sha256: source.sha256,
  extraction: {
    title: source.extraction.title,
    headings: [...source.extraction.headings],
  },
});

const sortExclusions = (values: Iterable<ImportExclusion>): ImportExclusion[] =>
  [...values].sort((left, right) =>
    compareOrdinal(left.reason, right.reason) ||
    compareOrdinal(left.path ?? "", right.path ?? ""),
  );

const sortWarnings = (values: readonly ImportWarning[]): ImportWarning[] =>
  [...values].sort((left, right) => compareOrdinal(left.code, right.code));

const normalizeCanonicalRoot = (inputRoot: string): string => {
  try {
    const root = realpathSync(resolve(inputRoot));
    const status = lstatSync(root);
    if (!status.isDirectory()) throw new Error("not a directory");
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

export const discoverRepository = (
  input: RepositoryDiscoveryInput,
  dependencies: RepositoryScannerDependencies = {},
): DiscoveredRepository => {
  const root = normalizeCanonicalRoot(input.root);
  const gitState = (dependencies.readGitRepositoryState ?? readGitRepositoryState)(root);
  if (!sameFilesystemPath(root, gitState.root)) {
    throw new RepositoryImportError("repository_root_invalid", {
      path: normalizePath(root),
    });
  }

  const canonical = resolveCanonicalSubpath(root, input.canonicalSubpath);
  try {
    const canonicalKind = canonical.subpath === null
      ? lstatSync(canonical.path).isDirectory() ? "directory" : "other"
      : classifyFilesystemPath(root, canonical.subpath).kind;
    if (canonicalKind !== "directory") {
      throw new Error("canonical path is not a directory");
    }
  } catch {
    throw new RepositoryImportError("canonical_path_invalid", {
      path: canonical.subpath ?? "repository",
    });
  }
  const canonicalSubpath = canonical.subpath === null
    ? null
    : process.platform === "win32"
      ? normalizePath(relative(root, realpathSync.native(canonical.path)))
      : canonical.subpath;

  const tracked = new Set(gitState.tracked);
  const candidates = [...new Set([...gitState.tracked, ...gitState.untracked])]
    .sort(compareOrdinal);
  const selectedSources: DiscoveredTextSource[] = [];
  const exclusions = new Map<string, ImportExclusion>();
  const binaryCollections = new Map<string, MutableBinaryCollection>();

  for (const path of candidates) {
    const hardExcluded = firstHardExcludedPath(path);
    if (hardExcluded !== null) {
      addExclusion(exclusions, hardExcluded, "hard_exclusion");
      continue;
    }
    if (isKnownSecretPath(path)) {
      addExclusion(exclusions, null, "known_secret_path");
      continue;
    }

    const inspectedPath = inspectRepositoryPath(root, path);
    if (inspectedPath.kind === "link") {
      addExclusion(exclusions, inspectedPath.path, "link_not_followed");
      continue;
    }
    if (inspectedPath.kind === "unsupported") {
      addExclusion(exclusions, path, "unsupported_text");
      continue;
    }

    const status = tracked.has(path) ? "tracked" : "untracked";
    if (status === "untracked" && !isEligibleUntrackedText(path)) {
      addExclusion(exclusions, path, "untracked_not_eligible");
      continue;
    }

    if (hasBinaryExtension(path)) {
      const opened = readSafeRepositoryFile(
        root,
        path,
        inspectedPath,
        "metadata",
        dependencies,
      );
      if (opened.kind === "unsupported") {
        addExclusion(exclusions, path, "unsupported_text");
        continue;
      }
      addBinary(binaryCollections, path, opened.byteSize, canonicalSubpath);
      continue;
    }
    if (inspectedPath.status.size > BigInt(MAX_TEXT_FILE_BYTES)) {
      const opened = readSafeRepositoryFile(
        root,
        path,
        inspectedPath,
        "metadata",
        dependencies,
      );
      if (opened.kind === "unsupported") {
        addExclusion(exclusions, path, "unsupported_text");
        continue;
      }
      addExclusion(exclusions, path, "oversized_text");
      continue;
    }

    const opened = readSafeRepositoryFile(
      root,
      path,
      inspectedPath,
      "content",
      dependencies,
    );
    if (opened.kind === "unsupported" || opened.content === null) {
      addExclusion(exclusions, path, "unsupported_text");
      continue;
    }
    const content = opened.content;
    const inspectedContent = inspectFileContent(path, content);
    if (inspectedContent.kind === "oversized") {
      addExclusion(exclusions, path, "oversized_text");
      continue;
    }
    if (inspectedContent.kind === "binary") {
      addBinary(binaryCollections, path, opened.byteSize, canonicalSubpath);
      continue;
    }

    selectedSources.push({
      path,
      status,
      role: roleFor(path, canonicalSubpath, false),
      byteSize: opened.byteSize,
      sha256: sha256(content),
      extraction: { title: null, headings: [] },
      text: inspectedContent.text,
      provisional: status === "untracked",
    });
  }

  selectedSources.sort((left, right) => compareOrdinal(left.path, right.path));
  const sources = selectedSources.map(publicSource);
  const binaryCollectionsOutput: BinaryCollection[] = [...binaryCollections.values()]
    .map((collection) => ({
      directory: collection.directory,
      role: collection.role,
      extensions: [...collection.extensions].sort(compareOrdinal),
      count: collection.count,
      byteSize: collection.byteSize,
    }))
    .sort((left, right) =>
      compareOrdinal(left.directory, right.directory) ||
      compareOrdinal(left.role, right.role),
    );

  const warnings: ImportWarning[] = [];
  if (gitState.worktreeCount > 1) {
    warnings.push({ code: "multiple_worktrees", count: gitState.worktreeCount });
  }
  const untrackedDocumentCount = selectedSources.filter(
    (source) => source.status === "untracked",
  ).length;
  if (untrackedDocumentCount > 0) {
    warnings.push({ code: "untracked_document", count: untrackedDocumentCount });
  }
  if (gitState.entries.length > 0) {
    warnings.push({ code: "working_tree_dirty", count: gitState.entries.length });
  }

  const repositoryFingerprint = fingerprint({
    branch: gitState.branch,
    head: gitState.head,
    canonicalSubpath,
    rulesetVersion: REPOSITORY_RULESET_VERSION,
    sources: sources.map(({ path, sha256: sourceHash }) => ({
      path,
      sha256: sourceHash,
    })),
  });

  return {
    scannerVersion: REPOSITORY_SCANNER_VERSION,
    rulesetVersion: REPOSITORY_RULESET_VERSION,
    repository: {
      root: normalizePath(root),
      canonicalSubpath,
      branch: gitState.branch,
      head: gitState.head,
      fingerprint: repositoryFingerprint,
    },
    discovery: {
      sources,
      binaryCollections: binaryCollectionsOutput,
      warnings: sortWarnings(warnings),
      exclusions: sortExclusions(exclusions.values()),
    },
    selectedSources,
  };
};

const sourceClaims = (
  sources: readonly RepositoryImportSource[],
): FingerprintSource[] =>
  [...sources]
    .sort((left, right) => compareOrdinal(left.path, right.path))
    .map(({ path, sha256: sourceHash }) => ({
      path,
      sha256: sourceHash,
    }));

const sameSourceClaims = (
  expected: readonly FingerprintSource[],
  actual: readonly FingerprintSource[],
): boolean =>
  expected.length === actual.length &&
  expected.every((source, index) =>
    source.path === actual[index]!.path &&
    source.sha256 === actual[index]!.sha256
  );

const snapshotClaimDigest = (snapshot: DiscoveredRepository): string =>
  sha256(JSON.stringify({
    scannerVersion: snapshot.scannerVersion,
    rulesetVersion: snapshot.rulesetVersion,
    repository: snapshot.repository,
    sources: sourceClaims(snapshot.discovery.sources),
  }));

const sourceDrift = (
  manifest: RepositoryImportManifest,
  actualDigest: string,
): RepositoryImportError<"source_drift"> =>
  new RepositoryImportError("source_drift", {
    expectedDigest: manifest.repository.fingerprint,
    actualDigest,
  });

export const verifyRepositorySnapshot = (
  manifest: RepositoryImportManifest,
  dependencies: RepositoryScannerDependencies = {},
): void => {
  let actual: DiscoveredRepository;
  try {
    actual = discoverRepository({
      root: manifest.repository.root,
      canonicalSubpath: manifest.repository.canonicalSubpath,
    }, dependencies);
  } catch (error) {
    const reason = error instanceof RepositoryImportError
      ? error.code
      : "verification_failed";
    throw sourceDrift(manifest, sha256(`source_drift\0${reason}`));
  }

  const expectedSources = sourceClaims(manifest.discovery.sources);
  const actualSources = sourceClaims(actual.discovery.sources);
  const claimsMatch =
    manifest.manifestVersion === IMPORT_MANIFEST_VERSION &&
    manifest.scannerVersion === actual.scannerVersion &&
    manifest.rulesetVersion === actual.rulesetVersion &&
    normalizePath(manifest.repository.root) === actual.repository.root &&
    normalizePath(manifest.proposal.project.primaryRepositoryPath) ===
      actual.repository.root &&
    manifest.repository.branch === actual.repository.branch &&
    manifest.repository.head === actual.repository.head &&
    manifest.repository.canonicalSubpath ===
      actual.repository.canonicalSubpath &&
    sameSourceClaims(expectedSources, actualSources) &&
    manifest.repository.fingerprint === actual.repository.fingerprint;

  if (!claimsMatch) {
    const actualDigest = actual.repository.fingerprint ===
        manifest.repository.fingerprint
      ? snapshotClaimDigest(actual)
      : actual.repository.fingerprint;
    throw sourceDrift(manifest, actualDigest);
  }
};
