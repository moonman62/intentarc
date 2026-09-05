import { describe, expect, it } from "vitest";
import { repositoryImportManifestSchema } from "../domain/import-schemas.js";
import type { DiscoveredRepository } from "./discovery-model.js";
import { RepositoryImportError } from "./errors.js";
import { generateImportManifest } from "./manifest-generator.js";

const hash = (character: string): string => character.repeat(64);

const selectedSource = (
  path: string,
  role: DiscoveredRepository["selectedSources"][number]["role"],
  text: string,
): DiscoveredRepository["selectedSources"][number] => ({
  path,
  status: "tracked",
  role,
  byteSize: Buffer.byteLength(text),
  sha256: hash("a"),
  extraction: { title: null, headings: [] },
  text,
  provisional: false,
});

const discovered = (
  root = "C:/synthetic/example-game",
  projectText = `[application]\nconfig/name="Example Game"\n`,
): DiscoveredRepository => {
  const selectedSources = [
    selectedSource("README.md", "supporting_document", "# Marketing prose with TODOs\n"),
    selectedSource("docs/current-handoff.md", "supporting_document", "# Ship everything tomorrow\n"),
    selectedSource("docs/specs/combat.md", "supporting_document", "# Decide all combat details\n"),
    selectedSource("godot/project.godot", "canonical_source", projectText),
    selectedSource("godot/src/core/run.gd", "canonical_source", "extends Node\n"),
    selectedSource("godot/src/ui/main.gd", "canonical_source", "extends Control\n"),
    selectedSource("js/prototype.js", "archived_source", "export const old = true;\n"),
  ];
  return {
    scannerVersion: "1",
    rulesetVersion: "1",
    repository: {
      root,
      canonicalSubpath: "godot",
      branch: "main",
      head: "b".repeat(40),
      fingerprint: hash("c"),
    },
    discovery: {
      sources: selectedSources.map(({ text: _text, provisional: _provisional, ...source }) => source),
      binaryCollections: [],
      warnings: [
        { code: "multiple_worktrees", count: 3 },
        { code: "working_tree_dirty", count: 2 },
      ],
      exclusions: [],
    },
    selectedSources,
  };
};

describe("baseline import manifest generation", () => {
  it("generates strict repository facts, evidence, components, and warning risks", () => {
    const manifest = generateImportManifest(discovered(), {
      createdAt: "2026-07-28T12:00:00.000Z",
    });

    expect(repositoryImportManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.proposal.project).toEqual({
      name: "Example Game",
      primaryRepositoryPath: "C:/synthetic/example-game",
    });
    expect(manifest.discovery).not.toHaveProperty("selectedSources");

    const records = manifest.proposal.records;
    expect(records.filter((record) => record.kind === "evidence").map((record) => record.sourceRef))
      .toEqual([
        "docs/current-handoff.md",
        "docs/specs/combat.md",
        "godot/project.godot",
        "README.md",
      ]);
    expect(records.filter((record) => record.kind === "component")).toMatchObject([
      { key: "component.archived-prototype", status: "archived", sourceKind: "repository" },
      { key: "component.core", status: "accepted", sourceKind: "repository" },
      { key: "component.ui", status: "accepted", sourceKind: "repository" },
    ]);
    expect(records.filter((record) => record.kind === "risk")).toMatchObject([
      {
        key: "risk.multiple-worktrees",
        status: "provisional",
        sourceKind: "import",
        curationReason: expect.stringContaining("repository warning"),
      },
      {
        key: "risk.working-tree-dirty",
        status: "provisional",
        sourceKind: "import",
        curationReason: expect.stringContaining("repository warning"),
      },
    ]);
    expect(records.filter((record) =>
      ["task", "decision", "vision", "outcome"].includes(record.kind),
    )).toEqual([]);
    expect(records.filter((record) => record.sourceKind === "repository").every(
      (record) => record.curationReason === null && record.sourceRefs.length > 0,
    )).toBe(true);
  });

  it("falls back to the normalized repository basename when Godot has no project name", () => {
    const manifest = generateImportManifest(
      discovered("C:/synthetic/fallback-project/", "[application]\nrun/main_scene=\"res://Main.tscn\"\n"),
      { createdAt: "2026-07-28T12:00:00.000Z" },
    );

    expect(manifest.proposal.project.name).toBe("fallback-project");
  });

  it("blocks a scanner-generated manifest when an explicit project name is a credential", () => {
    const canary = "api_key=synthetic-secret-ABC123456789xyz";
    const discovery = discovered(
      "C:/synthetic/blocked-project",
      `[application]\nconfig/name="${canary}"\n`,
    );

    expect(() => generateImportManifest(discovery, {
      createdAt: "2026-07-28T12:00:00.000Z",
    })).toThrowError(RepositoryImportError);
    try {
      generateImportManifest(discovery, {
        createdAt: "2026-07-28T12:00:00.000Z",
      });
      expect.unreachable("Generated a manifest containing a forced credential");
    } catch (error) {
      expect(error).toMatchObject({ code: "sensitive_content_blocked" });
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    }
  });

  it("retains every noncanonical source role and binary collection in the archived proposal", () => {
    const baseline = discovered();
    const additionalSources = [
      selectedSource("src/legacy.js", "archived_source", "export const legacy = true;\n"),
      selectedSource("tests/legacy.test.js", "test", "export const tested = true;\n"),
      selectedSource("tools/build.js", "tool", "export const build = true;\n"),
    ];
    const candidate: DiscoveredRepository = {
      ...baseline,
      discovery: {
        ...baseline.discovery,
        sources: [
          ...baseline.discovery.sources,
          ...additionalSources.map(({ text: _text, provisional: _provisional, ...source }) => source),
        ],
        binaryCollections: [{
          directory: "",
          role: "asset",
          extensions: [".png"],
          count: 2,
          byteSize: 128,
        }],
      },
      selectedSources: [...baseline.selectedSources, ...additionalSources],
    };

    const manifest = generateImportManifest(candidate, {
      createdAt: "2026-07-28T12:00:00.000Z",
    });

    expect(manifest.proposal.records.find(
      ({ key }) => key === "component.archived-prototype",
    )).toMatchObject({
      status: "archived",
      sourceRefs: [
        ".",
        "js/prototype.js",
        "src/legacy.js",
        "tests/legacy.test.js",
        "tools/build.js",
      ],
    });
  });

  it("preserves colliding evidence slugs with path-derived keys independent of enumeration order", () => {
    const sources = [
      selectedSource("README.md", "supporting_document", "# Markdown README\n"),
      selectedSource("README.txt", "supporting_document", "Text README\n"),
      selectedSource("docs/spec/a-b.md", "supporting_document", "# Hyphen spec\n"),
      selectedSource("docs/spec/a_b.md", "supporting_document", "# Underscore spec\n"),
    ];
    const publicSources = sources.map(
      ({ text: _text, provisional: _provisional, ...source }) => source,
    );
    const baseline = discovered("C:/synthetic/collision-project", "");
    const candidate: DiscoveredRepository = {
      ...baseline,
      repository: { ...baseline.repository, canonicalSubpath: null },
      discovery: {
        ...baseline.discovery,
        sources: publicSources,
        warnings: [],
      },
      selectedSources: sources,
    };
    const reversed: DiscoveredRepository = {
      ...candidate,
      discovery: {
        ...candidate.discovery,
        sources: [...publicSources].reverse(),
      },
      selectedSources: [...sources].reverse(),
    };

    const first = generateImportManifest(candidate, {
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    const second = generateImportManifest(reversed, {
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    const evidence = first.proposal.records.filter(({ kind }) => kind === "evidence");

    expect(evidence.map(({ sourceRef }) => sourceRef).sort()).toEqual([
      "README.md",
      "README.txt",
      "docs/spec/a-b.md",
      "docs/spec/a_b.md",
    ]);
    expect(new Set(evidence.map(({ key }) => key)).size).toBe(4);
    expect(second.proposal.records).toEqual(first.proposal.records);
  });

  it("uses the repository basename for a generic repository without project.godot", () => {
    const readme = selectedSource(
      "README.md",
      "supporting_document",
      "# Generic repository\n",
    );
    const core = selectedSource(
      "src/core/index.ts",
      "canonical_source",
      "export const core = true;\n",
    );
    const baseline = discovered("C:/synthetic/generic-toolkit", "");
    const candidate: DiscoveredRepository = {
      ...baseline,
      repository: { ...baseline.repository, canonicalSubpath: null },
      discovery: {
        ...baseline.discovery,
        sources: [readme, core].map(
          ({ text: _text, provisional: _provisional, ...source }) => source,
        ),
        warnings: [],
      },
      selectedSources: [readme, core],
    };

    expect(generateImportManifest(candidate, {
      createdAt: "2026-07-28T12:00:00.000Z",
    }).proposal.project.name).toBe("generic-toolkit");
  });
});
