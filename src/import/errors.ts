import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative();

const isSafeNormalizedPath = (value: string): boolean => {
  if (value.length === 0 || value.length > 4096 || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value) && !/^[A-Za-z]:\//.test(value)) return false;

  const isUncPath = value.startsWith("//");
  const path = /^[A-Za-z]:\//.test(value)
    ? value.slice(3)
    : isUncPath
      ? value.slice(2)
      : value.startsWith("/")
        ? value.slice(1)
        : value;
  const segments = path.split("/");
  return path.length > 0 &&
    (!isUncPath || segments.length >= 2) &&
    segments.every((segment) =>
      segment.length > 0 && segment !== "." && segment !== "..",
    );
};

const safeNormalizedPathSchema = z.string().refine(isSafeNormalizedPath, {
  message: "Path must be normalized and safe to disclose",
});

export const repositoryImportErrorCodes = [
  "repository_not_found",
  "repository_root_invalid",
  "canonical_path_invalid",
  "path_escape",
  "unsupported_repository",
  "manifest_exists",
  "manifest_invalid",
  "manifest_digest_mismatch",
  "source_drift",
  "sensitive_content_blocked",
  "import_conflict",
  "import_failed",
] as const;

export type RepositoryImportErrorCode = (typeof repositoryImportErrorCodes)[number];

export type RepositoryImportErrorDetailsByCode = {
  repository_not_found: { path: string };
  repository_root_invalid: { path: string };
  canonical_path_invalid: { path: string };
  path_escape: { path: string };
  unsupported_repository: { path: string };
  manifest_exists: { path: string };
  manifest_invalid: {};
  manifest_digest_mismatch: { expectedDigest: string; actualDigest: string };
  source_drift: { expectedDigest: string; actualDigest: string };
  sensitive_content_blocked: { count: number };
  import_conflict: { count: number };
  import_failed: {};
};

const messages = {
  repository_not_found: "Repository was not found.",
  repository_root_invalid: "Repository root is invalid.",
  canonical_path_invalid: "Canonical repository path is invalid.",
  path_escape: "Path escapes the repository root.",
  unsupported_repository: "Repository is unsupported.",
  manifest_exists: "Import manifest already exists.",
  manifest_invalid: "Import manifest is invalid.",
  manifest_digest_mismatch: "Import manifest digest does not match confirmation.",
  source_drift: "Repository sources have changed.",
  sensitive_content_blocked: "Sensitive content blocks this import.",
  import_conflict: "Import conflicts with existing state.",
  import_failed: "Repository import failed.",
} satisfies Record<RepositoryImportErrorCode, string>;

export const repositoryImportErrorDetailsSchemas = {
  repository_not_found: z.object({ path: safeNormalizedPathSchema }).strict(),
  repository_root_invalid: z.object({ path: safeNormalizedPathSchema }).strict(),
  canonical_path_invalid: z.object({ path: safeNormalizedPathSchema }).strict(),
  path_escape: z.object({ path: safeNormalizedPathSchema }).strict(),
  unsupported_repository: z.object({ path: safeNormalizedPathSchema }).strict(),
  manifest_exists: z.object({ path: safeNormalizedPathSchema }).strict(),
  manifest_invalid: z.object({}).strict(),
  manifest_digest_mismatch: z.object({ expectedDigest: sha256Schema, actualDigest: sha256Schema }).strict(),
  source_drift: z.object({ expectedDigest: sha256Schema, actualDigest: sha256Schema }).strict(),
  sensitive_content_blocked: z.object({ count: countSchema }).strict(),
  import_conflict: z.object({ count: countSchema }).strict(),
  import_failed: z.object({}).strict(),
} satisfies Record<RepositoryImportErrorCode, z.ZodType>;

export class RepositoryImportError<
  Code extends RepositoryImportErrorCode = RepositoryImportErrorCode,
> extends Error {
  readonly code: Code;
  readonly details: Readonly<RepositoryImportErrorDetailsByCode[Code]>;

  constructor(code: Code, details: RepositoryImportErrorDetailsByCode[Code]) {
    super(messages[code]);
    this.name = "RepositoryImportError";
    this.code = code;
    this.details = repositoryImportErrorDetailsSchemas[code].parse(details) as
      RepositoryImportErrorDetailsByCode[Code];
  }
}
