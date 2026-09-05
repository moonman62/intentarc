import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDatabaseOutsideRepository,
  assertOutputOutsideRepository,
} from "./output-containment.js";

describe("repository import output containment", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    temporaryDirectories.splice(0).forEach((directory) => {
      rmSync(directory, { recursive: true, force: true });
    });
  });

  const fixture = () => {
    const workspace = mkdtempSync(join(tmpdir(), "intentarc-output-"));
    temporaryDirectories.push(workspace);
    const repository = join(workspace, "repository");
    mkdirSync(repository);
    return { workspace, repository };
  };

  it("allows a sibling output but rejects direct and canonical aliases below the repository", () => {
    const { workspace, repository } = fixture();
    const alias = join(workspace, "repository-alias");
    symlinkSync(
      repository,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertOutputOutsideRepository(
        repository,
        join(workspace, "repository-output", "manifest.json"),
      )
    ).not.toThrow();
    expect(() =>
      assertOutputOutsideRepository(
        repository,
        join(repository, "manifest.json"),
      )
    ).toThrow(expect.objectContaining({ code: "path_escape" }));
    expect(() =>
      assertOutputOutsideRepository(
        repository,
        join(alias, "nested", "manifest.json"),
      )
    ).toThrow(expect.objectContaining({ code: "path_escape" }));
  });

  it("fails closed when the nearest existing output ancestor is not a directory", () => {
    const { workspace, repository } = fixture();
    const fileAncestor = join(workspace, "not-a-directory");
    writeFileSync(fileAncestor, "synthetic");

    expect(() =>
      assertOutputOutsideRepository(
        repository,
        join(fileAncestor, "manifest.json"),
      )
    ).toThrow(expect.objectContaining({ code: "path_escape" }));
  });

  it("checks every SQLite and lease artifact location", () => {
    const { repository } = fixture();

    expect(() =>
      assertDatabaseOutsideRepository(
        repository,
        join(repository, "intentarc.sqlite"),
      )
    ).toThrow(expect.objectContaining({ code: "path_escape" }));
  });
});
