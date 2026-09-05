import { describe, expect, it } from "vitest";
import type {
  RepositoryNodeObservation,
  RepositoryObservationInput,
} from "../domain/repository-index-model.js";
import type { GitStatusEntry } from "../import/git-repository.js";
import { compareRepositoryObservations } from "./observation-diff.js";

const file = (
  path: string,
  hash: string,
  overrides: Partial<RepositoryObservationInput> = {},
): RepositoryObservationInput => ({
  path,
  kind: "file",
  sha256: hash.repeat(64),
  byteSize: 12,
  sourceStatus: "tracked",
  role: "supporting_document",
  documentKind: "specification",
  documentFormat: "markdown",
  contentEligible: true,
  instructionClient: null,
  instructionScope: null,
  ...overrides,
});

const directory = (path: string): RepositoryObservationInput => ({
  path,
  kind: "directory",
  sha256: null,
  byteSize: 0,
  sourceStatus: "derived",
  role: "supporting_document",
  documentKind: null,
  documentFormat: null,
  contentEligible: false,
  instructionClient: null,
  instructionScope: null,
});

const accepted = (
  nodeId: string,
  observation: RepositoryObservationInput,
): RepositoryNodeObservation => ({
  snapshotId: "snapshot-accepted",
  nodeId,
  parentNodeId: null,
  ...observation,
});

const rename = (originalPath: string, path: string): GitStatusEntry => ({
  index: "R",
  worktree: " ",
  originalPath,
  path,
});

const flatEntries = (
  result: ReturnType<typeof compareRepositoryObservations>,
) => result.groups.flatMap(({ entries }) => entries);

describe("repository observation comparison", () => {
  it("keeps path identity first and classifies metadata changes independently from unchanged files", () => {
    const result = compareRepositoryObservations(
      [
        accepted("node-z", file("z.md", "a")),
        accepted("node-a", file("a.md", "b")),
      ],
      [file("a.md", "c"), file("z.md", "a")],
      [rename("a.md", "z.md")],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["changed", "unchanged"]);
    expect(result.groups).toMatchObject([
      {
        kind: "changed",
        entries: [{ previousNodeId: "node-a", previousPath: "a.md", currentPath: "a.md" }],
      },
      {
        kind: "unchanged",
        entries: [{ previousNodeId: "node-z", previousPath: "z.md", currentPath: "z.md" }],
      },
    ]);
    expect(result.semanticOperations).toEqual([]);
  });

  it("moves only with one exact Git originalPath-to-path claim and preserves the accepted node identity", () => {
    const result = compareRepositoryObservations(
      [accepted("node-guide", file("docs/old.md", "d"))],
      [file("docs/new.md", "d")],
      [rename("docs/old.md", "docs/new.md")],
    );

    expect(result.groups).toEqual([{
      kind: "moved",
      entries: [{
        operationId: expect.any(String),
        kind: "moved",
        previousNodeId: "node-guide",
        currentNodeId: "node-guide",
        previousPath: "docs/old.md",
        currentPath: "docs/new.md",
      }],
    }]);
  });

  it("reports same-hash ambiguity as removal and addition, never as a guessed move", () => {
    const result = compareRepositoryObservations(
      [accepted("node-old", file("old.md", "e"))],
      [file("copy-a.md", "e"), file("copy-b.md", "e")],
      [],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["added", "removed"]);
    expect(flatEntries(result)).toMatchObject([
      { kind: "added", previousPath: null, currentPath: "copy-a.md" },
      { kind: "added", previousPath: null, currentPath: "copy-b.md" },
      { kind: "removed", previousPath: "old.md", currentPath: null },
    ]);
    expect(flatEntries(result).some(({ kind }) => kind === "moved")).toBe(false);
  });

  it("does not transfer identity for Git copy evidence", () => {
    const result = compareRepositoryObservations(
      [accepted("node-old", file("old.md", "e"))],
      [file("copy.md", "e")],
      [{ index: "C", worktree: " ", originalPath: "old.md", path: "copy.md" }],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["added", "removed"]);
  });

  it("compares derived directories as repository facts and keeps ordinal group and entry ordering", () => {
    const result = compareRepositoryObservations(
      [
        accepted("node-z", file("z-old.md", "f")),
        accepted("node-docs", directory("docs")),
        accepted("node-b", file("b-old.md", "f")),
      ],
      [
        directory("new"),
        file("a-new.md", "a"),
        directory("docs"),
        file("z-new.md", "b"),
      ],
      [],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["added", "removed", "unchanged"]);
    expect(result.groups[0]!.entries.map(({ currentPath }) => currentPath)).toEqual([
      "a-new.md",
      "new",
      "z-new.md",
    ]);
    expect(result.groups[1]!.entries.map(({ previousPath }) => previousPath)).toEqual([
      "b-old.md",
      "z-old.md",
    ]);
    expect(result.groups[2]!.entries[0]).toMatchObject({
      previousNodeId: "node-docs",
      previousPath: "docs",
      currentPath: "docs",
    });
  });

  it("marks a path-stable kind replacement as a conflicting identity", () => {
    const result = compareRepositoryObservations(
      [accepted("node-kind", file("same", "a"))],
      [directory("same")],
      [],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["conflicted"]);
    expect(result.groups[0]!.entries.map(({ previousPath, currentPath }) => ({
      previousPath,
      currentPath,
    }))).toEqual([{ previousPath: "same", currentPath: "same" }]);
  });

  it("reports ambiguous Git rename claims as removals and additions", () => {
    const result = compareRepositoryObservations(
      [accepted("node-old", file("old.md", "b"))],
      [file("one.md", "b"), file("two.md", "b")],
      [rename("old.md", "one.md"), rename("old.md", "two.md")],
    );

    expect(result.groups.map(({ kind }) => kind)).toEqual(["added", "removed"]);
    expect(flatEntries(result).some(({ kind }) => kind === "moved")).toBe(false);
  });

  it("derives stable operation IDs from facts rather than caller ordering", () => {
    const prior = [
      accepted("node-b", file("b.md", "b")),
      accepted("node-a", file("a.md", "a")),
    ];
    const next = [file("d.md", "d"), file("c.md", "c")];

    const first = compareRepositoryObservations(prior, next, []);
    const second = compareRepositoryObservations([...prior].reverse(), [...next].reverse(), []);

    expect(second).toEqual(first);
  });

  it("prepares new eligible test evidence as a deterministic unaccepted evidence proposal", () => {
    const observation = file("tests/refresh-evidence.txt", "a", {
      role: "test",
      documentKind: "test_evidence",
      documentFormat: "plain_text",
      contentEligible: true,
    });

    const first = compareRepositoryObservations([], [observation], []);
    const second = compareRepositoryObservations([], [observation], []);

    expect(first.semanticOperations).toEqual([{
      operationId: expect.stringMatching(/^repository-meaning-/),
      type: "create_record",
      localRef: expect.stringMatching(/^repository-meaning-/),
      kind: "evidence",
      status: "provisional",
      title: "Repository test evidence: tests/refresh-evidence.txt",
      body: "Repository refresh observed new test evidence at tests/refresh-evidence.txt. Review it before accepting this project evidence.",
    }]);
    expect(second.semanticOperations).toEqual(first.semanticOperations);
  });

  it("does not prepare untracked or non-test documents as project meaning", () => {
    const evidence = file("tests/refresh-evidence.txt", "a", {
      role: "test",
      documentKind: "test_evidence",
      documentFormat: "plain_text",
      contentEligible: true,
    });

    expect(compareRepositoryObservations([], [{
      ...evidence,
      sourceStatus: "untracked",
    }], []).semanticOperations).toEqual([]);
    expect(compareRepositoryObservations([], [{
      ...evidence,
      role: "supporting_document",
    }], []).semanticOperations).toEqual([]);
  });

  it.each([
    "tests/fixtures/evidence.txt",
    "tests/inputs/report.md",
    "tests/snapshots/results.txt",
    "tests/sample-results.md",
    "tests/sam\u007fple-results.md",
    "tests/test--data/report.md",
    "tests/fi\u0080xtures/report.md",
    "tests/test..\u009f--data/evidence.txt",
  ])("does not treat ordinary test support artifact %s as semantic evidence", (path) => {
    const observation = file(path, "a", {
      role: "test",
      documentKind: "test_evidence",
      documentFormat: path.endsWith(".md") ? "markdown" : "plain_text",
      contentEligible: true,
    });

    expect(compareRepositoryObservations([], [observation], []).semanticOperations)
      .toEqual([]);
  });

  it("normalizes C1 controls for classification and display without changing raw identity", () => {
    const path = "tests\u0080/refresh-evidence.txt";
    const rawObservation = file(path, "a", {
      role: "test",
      documentKind: "test_evidence",
      documentFormat: "plain_text",
      contentEligible: true,
    });
    const cleanObservation = { ...rawObservation, path: "tests/refresh-evidence.txt" };

    const first = compareRepositoryObservations([], [rawObservation], [])
      .semanticOperations[0];
    const second = compareRepositoryObservations([], [rawObservation], [])
      .semanticOperations[0];
    const clean = compareRepositoryObservations([], [cleanObservation], [])
      .semanticOperations[0];

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: "create_record",
      title: "Repository test evidence: tests/refresh-evidence.txt",
      body: "Repository refresh observed new test evidence at tests/refresh-evidence.txt. Review it before accepting this project evidence.",
    });
    expect(first?.operationId).not.toBe(clean?.operationId);
  });

  it("uses bounded control-free display copy for an evidence path without changing its identity", () => {
    const path = `\u0001\u0081 ${"long-segment/".repeat(24)}refresh---evidence...txt \u007f\u009f`;
    const observation = file(path, "a", {
      role: "test",
      documentKind: "test_evidence",
      documentFormat: "plain_text",
      contentEligible: true,
    });

    const operation = compareRepositoryObservations([], [observation], [])
      .semanticOperations[0];

    expect(operation).toMatchObject({
      operationId: expect.stringMatching(/^repository-meaning-/),
      type: "create_record",
      kind: "evidence",
      status: "provisional",
    });
    expect(operation).toHaveProperty("title", expect.stringMatching(
      /^Repository test evidence: \S.*\S$/,
    ));
    expect(operation).toHaveProperty("body", expect.stringMatching(
      /^Repository refresh observed new test evidence at \S.*project evidence\.$/,
    ));
    if (operation?.type !== "create_record") throw new Error("Expected evidence record");
    expect(operation.localRef).toBe(operation.operationId);
    expect(operation.title).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(operation.body).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(operation.title).not.toContain("---");
    expect(operation.title).not.toContain("...");
    expect(operation.title.length).toBeLessThanOrEqual(266);
    expect(operation.body.length).toBeLessThanOrEqual(353);
  });
});
