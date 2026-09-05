import { describe, expect, it } from "vitest";
import type { RepositoryImportManifest } from "../domain/import-model.js";
import { computeImportManifestDigest, normalizeImportManifest } from "./canonical-manifest.js";

const digest = (character: string): string => character.repeat(64);

const manifestAtNoon: RepositoryImportManifest = {
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: "2026-07-28T12:00:00.000Z",
  repository: {
    root: "C:\\projects\\fixture",
    canonicalSubpath: "godot",
    branch: "master",
    head: "a".repeat(40),
    fingerprint: digest("b"),
  },
  discovery: {
    sources: [
      {
        path: "README.md",
        status: "tracked",
        role: "supporting_document",
        byteSize: 10,
        sha256: digest("c"),
        extraction: { title: "Fixture", headings: ["Overview", "Setup"] },
      },
      {
        path: "godot/main.gd",
        status: "tracked",
        role: "canonical_source",
        byteSize: 20,
        sha256: digest("d"),
        extraction: { title: null, headings: [] },
      },
    ],
    binaryCollections: [
      { directory: "godot/assets", role: "asset", extensions: [".png", ".wav"], count: 2, byteSize: 30 },
      { directory: "godot/audio", role: "asset", extensions: [".ogg", ".wav"], count: 3, byteSize: 40 },
    ],
    warnings: [
      { code: "working_tree_dirty", count: 1 },
      { code: "multiple_worktrees", count: 2 },
    ],
    exclusions: [
      { path: "node_modules", reason: "hard_exclusion", count: 5 },
      { path: "tmp/dump.txt", reason: "oversized_text", count: 1 },
    ],
  },
  proposal: {
    project: { name: "Fixture", primaryRepositoryPath: "C:\\projects\\fixture" },
    records: [
      {
        key: "project.overview",
        kind: "component",
        status: "accepted",
        title: "Overview",
        body: "First line\r\nSecond line",
        sourceKind: "repository",
        sourceRef: "README.md",
        sourceRefs: ["README.md", "godot/main.gd"],
        curationReason: null,
      },
      {
        key: "project.task",
        kind: "task",
        status: "active",
        title: "Current task",
        body: "Finish the fixture.",
        sourceKind: "import",
        sourceRef: null,
        sourceRefs: [],
        curationReason: "Recorded by the local import workflow.",
      },
    ],
    relationships: [
      { fromKey: "project.task", toKey: "project.overview", kind: "implements" },
      { fromKey: "project.overview", toKey: "project.task", kind: "related_to" },
    ],
  },
};

const manifestAtOne: RepositoryImportManifest = {
  ...manifestAtNoon,
  createdAt: "2026-07-28T13:00:00.000Z",
};

const reorderedArrays: RepositoryImportManifest = {
  ...manifestAtNoon,
  discovery: {
    ...manifestAtNoon.discovery,
    sources: [...manifestAtNoon.discovery.sources].reverse(),
    binaryCollections: manifestAtNoon.discovery.binaryCollections.map((collection) => ({
      ...collection,
      extensions: [...collection.extensions].reverse(),
    })).reverse(),
    warnings: [...manifestAtNoon.discovery.warnings].reverse(),
    exclusions: [...manifestAtNoon.discovery.exclusions].reverse(),
  },
  proposal: {
    ...manifestAtNoon.proposal,
    records: [...manifestAtNoon.proposal.records].reverse(),
    relationships: [...manifestAtNoon.proposal.relationships].reverse(),
  },
};

const changedProposal: RepositoryImportManifest = {
  ...manifestAtNoon,
  proposal: {
    ...manifestAtNoon.proposal,
    records: [{ ...manifestAtNoon.proposal.records[0]!, body: "Changed body." }, manifestAtNoon.proposal.records[1]!],
  },
};

describe("canonical import manifests", () => {
  it("excludes only createdAt from the semantic digest", () => {
    expect(computeImportManifestDigest(manifestAtNoon)).toBe(
      computeImportManifestDigest(manifestAtOne),
    );
  });

  it("sorts every set-like manifest array ordinally without mutating input", () => {
    expect(computeImportManifestDigest(reorderedArrays)).toBe(
      computeImportManifestDigest(manifestAtNoon),
    );
    expect(normalizeImportManifest(reorderedArrays).proposal.records.map((record) => record.key))
      .toEqual(["project.overview", "project.task"]);
    expect(reorderedArrays.proposal.records.map((record) => record.key))
      .toEqual(["project.task", "project.overview"]);
  });

  it("changes the digest when curated proposal content changes", () => {
    expect(computeImportManifestDigest(changedProposal)).not.toBe(
      computeImportManifestDigest(manifestAtNoon),
    );
  });
});
