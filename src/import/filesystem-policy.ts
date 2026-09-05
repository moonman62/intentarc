import { lstatSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { RepositoryImportError } from "./errors.js";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const NUL_PROBE_BYTES = 8192;

export const HARD_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  ".godot",
  "build",
  "dist",
  "tmp",
  "temp",
  "__pycache__",
  ".cache",
  "staging",
]);

const KNOWN_SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".eleven_key",
  "credentials.json",
  "service-account.json",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".dll",
  ".dylib",
  ".exe",
  ".flac",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export const hasBinaryExtension = (relativePath: string): boolean =>
  BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase());

const normalizeRelativePath = (path: string): string =>
  path.replaceAll("\\", "/");

const comparisonKey = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path;

const safeRootPath = (path: string): string =>
  resolve(path).replaceAll("\\", "/");

const isContained = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "") return true;
  if (isAbsolute(pathFromRoot)) return false;
  const normalized = normalizeRelativePath(pathFromRoot);
  return normalized !== ".." && !normalized.startsWith("../");
};

export const resolveContainedPath = (
  repositoryRoot: string,
  candidatePath: string,
): string => {
  const root = resolve(repositoryRoot);
  const candidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(root, candidatePath);
  if (
    comparisonKey(root) !== comparisonKey(candidate) &&
    !isContained(root, candidate)
  ) {
    throw new RepositoryImportError("path_escape", {
      path: safeRootPath(candidate),
    });
  }
  return candidate;
};

export interface CanonicalSubpath {
  readonly path: string;
  readonly subpath: string | null;
}

export const resolveCanonicalSubpath = (
  repositoryRoot: string,
  canonicalSubpath: string | null | undefined,
): CanonicalSubpath => {
  const root = resolve(repositoryRoot);
  if (canonicalSubpath === undefined || canonicalSubpath === null) {
    return { path: root, subpath: null };
  }

  const normalized = normalizeRelativePath(canonicalSubpath);
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    isAbsolute(canonicalSubpath) ||
    /^[A-Za-z]:/.test(canonicalSubpath) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new RepositoryImportError("canonical_path_invalid", {
      path: "canonical-subpath",
    });
  }

  let path: string;
  try {
    path = resolveContainedPath(root, canonicalSubpath);
  } catch {
    throw new RepositoryImportError("canonical_path_invalid", {
      path: "canonical-subpath",
    });
  }
  return { path, subpath: normalized };
};

export type FilesystemPathKind = "file" | "directory" | "link" | "other";

export interface ClassifiedFilesystemPath {
  readonly path: string;
  readonly kind: FilesystemPathKind;
}

export const classifyFilesystemPath = (
  repositoryRoot: string,
  relativePath: string,
): ClassifiedFilesystemPath => {
  const normalizedPath = normalizeRelativePath(relativePath);
  const segments = normalizedPath.split("/");
  let path = resolve(repositoryRoot);
  let status: ReturnType<typeof lstatSync> | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    path = resolveContainedPath(repositoryRoot, join(path, segments[index]!));
    status = lstatSync(path);
    if (status.isSymbolicLink()) {
      return {
        path: segments.slice(0, index + 1).join("/"),
        kind: "link",
      };
    }
  }
  if (status === undefined) {
    throw new RepositoryImportError("path_escape", { path: "repository" });
  }
  const kind: FilesystemPathKind = status.isSymbolicLink()
    ? "link"
    : status.isFile()
      ? "file"
      : status.isDirectory()
        ? "directory"
        : "other";
  return { path: normalizedPath, kind };
};

export const isHardExcludedPath = (relativePath: string): boolean =>
  normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => HARD_EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));

export const isKnownSecretPath = (relativePath: string): boolean =>
  KNOWN_SECRET_BASENAMES.has(basename(relativePath).toLowerCase());

export const isEligibleUntrackedText = (relativePath: string): boolean => {
  const normalized = normalizeRelativePath(relativePath);
  const lower = normalized.toLowerCase();
  const name = basename(normalized);
  return (
    name.toLowerCase().startsWith("readme") ||
    (lower.startsWith("docs/") &&
      (lower.endsWith(".md") || lower.endsWith(".txt"))) ||
    name.toLowerCase() === "project.godot" ||
    name.toLowerCase() === "export_presets.cfg"
  );
};

export type FileContentInspection =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "oversized" };

export const inspectFileContent = (
  relativePath: string,
  content: Buffer,
): FileContentInspection => {
  if (content.byteLength > MAX_TEXT_FILE_BYTES) return { kind: "oversized" };
  if (hasBinaryExtension(relativePath)) {
    return { kind: "binary" };
  }
  if (content.subarray(0, NUL_PROBE_BYTES).includes(0)) {
    return { kind: "binary" };
  }

  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(content),
    };
  } catch {
    return { kind: "binary" };
  }
};
