import { describe, expect, it } from "vitest";
import { RepositoryImportError, repositoryImportErrorCodes } from "./errors.js";

describe("repository import errors", () => {
  it("uses canonical messages and validates safe details for every code", () => {
    const cases = [
      ["repository_not_found", { path: "C:/projects/fixture" }, "Repository was not found."],
      ["repository_root_invalid", { path: "C:/projects/fixture" }, "Repository root is invalid."],
      ["canonical_path_invalid", { path: "godot/scenes" }, "Canonical repository path is invalid."],
      ["path_escape", { path: "outside/file.txt" }, "Path escapes the repository root."],
      ["unsupported_repository", { path: "C:/projects/fixture" }, "Repository is unsupported."],
      ["manifest_exists", { path: "C:/projects/fixture/import.json" }, "Import manifest already exists."],
      ["manifest_invalid", {}, "Import manifest is invalid."],
      ["manifest_digest_mismatch", { expectedDigest: "a".repeat(64), actualDigest: "b".repeat(64) }, "Import manifest digest does not match confirmation."],
      ["source_drift", { expectedDigest: "a".repeat(64), actualDigest: "b".repeat(64) }, "Repository sources have changed."],
      ["sensitive_content_blocked", { count: 2 }, "Sensitive content blocks this import."],
      ["import_conflict", { count: 1 }, "Import conflicts with existing state."],
      ["import_failed", {}, "Repository import failed."],
    ] as const;

    expect(repositoryImportErrorCodes).toHaveLength(cases.length);
    for (const [code, details, message] of cases) {
      const error = new RepositoryImportError(code, details);
      expect(error.name).toBe("RepositoryImportError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.details).toEqual(details);
    }
  });

  it("rejects arbitrary messages, unsafe paths, invalid digests, and unknown detail fields", () => {
    expect(() => new RepositoryImportError("manifest_invalid", { message: "leak" } as never)).toThrow();
    expect(() => new RepositoryImportError("path_escape", { path: "../secret" })).toThrow();
    expect(() => new RepositoryImportError("path_escape", { path: "C:relative" })).toThrow();
    expect(() => new RepositoryImportError("source_drift", {
      expectedDigest: "A".repeat(64), actualDigest: "b".repeat(64),
    })).toThrow();
    expect(() => new RepositoryImportError("import_conflict", { count: 1, rawError: "SQL" } as never)).toThrow();
  });

  it("accepts a normalized absolute Windows UNC path as safe error detail", () => {
    expect(new RepositoryImportError("manifest_exists", {
      path: "//server/share/candidate.json",
    }).details).toEqual({
      path: "//server/share/candidate.json",
    });
  });
});
