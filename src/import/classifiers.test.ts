import { describe, expect, it } from "vitest";
import type { DiscoveredRepository } from "./discovery-model.js";
import { classifyRepository } from "./classifiers.js";

const hash = (character: string): string => character.repeat(64);

const source = (
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

const discovery: DiscoveredRepository = {
  scannerVersion: "1",
  rulesetVersion: "1",
  repository: {
    root: "C:/synthetic/example-game",
    canonicalSubpath: "godot",
    branch: "main",
    head: "b".repeat(40),
    fingerprint: hash("c"),
  },
  discovery: {
    sources: [],
    binaryCollections: [
      {
        directory: "",
        role: "asset",
        extensions: [".png"],
        count: 1,
        byteSize: 64,
      },
      {
        directory: "godot/assets",
        role: "asset",
        extensions: [".png", ".wav"],
        count: 3,
        byteSize: 256,
      },
    ],
    warnings: [],
    exclusions: [],
  },
  selectedSources: [
    source("README.md", "supporting_document", "# Example Game\n"),
    source("docs/current-handoff.md", "supporting_document", "# Current handoff\n"),
    source(
      "godot/project.godot",
      "canonical_source",
      `[application]
config/name="Example Game"
run/main_scene="res://src/ui/Main.tscn"
config/features=PackedStringArray("4.7")

[autoload]
Data="*res://src/core/data.gd"
Run="*res://src/core/run_state.gd"
`,
    ),
    source("godot/src/core/data.gd", "canonical_source", "extends Node\n"),
    source("godot/src/content/cards.gd", "canonical_source", "extends Resource\n"),
    source("godot/src/ui/main.gd", "canonical_source", "extends Control\n"),
    source("godot/tests/test_run.gd", "test", "extends Node\n"),
    source("godot/tools/export.gd", "tool", "extends EditorScript\n"),
    source("js/prototype.js", "archived_source", "export const prototype = true;\n"),
    source("src/legacy.js", "archived_source", "export const legacy = true;\n"),
    source("tests/legacy.test.js", "test", "export const test = true;\n"),
    source("tools/build.js", "tool", "export const build = true;\n"),
  ],
};

describe("repository classification", () => {
  it("extracts bounded Godot INI facts without parsing project scripts", () => {
    expect(classifyRepository(discovery).godot).toEqual({
      projectName: "Example Game",
      engineFeatures: ["4.7"],
      mainScene: "res://src/ui/Main.tscn",
      autoloads: ["Data", "Run"],
    });
  });

  it("classifies canonical directories, archived source, and supporting documents", () => {
    const classified = classifyRepository(discovery);

    expect(classified.components).toEqual([
      {
        key: "component.archived-prototype",
        title: "Archived prototype",
        status: "archived",
        sourceRefs: [
          ".",
          "js/prototype.js",
          "src/legacy.js",
          "tests/legacy.test.js",
          "tools/build.js",
        ],
      },
      {
        key: "component.assets",
        title: "Assets",
        status: "accepted",
        sourceRefs: ["godot/assets"],
      },
      {
        key: "component.content",
        title: "Content",
        status: "accepted",
        sourceRefs: ["godot/src/content/cards.gd"],
      },
      {
        key: "component.core",
        title: "Runtime core",
        status: "accepted",
        sourceRefs: ["godot/src/core/data.gd"],
      },
      {
        key: "component.tests",
        title: "Tests",
        status: "accepted",
        sourceRefs: ["godot/tests/test_run.gd"],
      },
      {
        key: "component.tools",
        title: "Tools",
        status: "accepted",
        sourceRefs: ["godot/tools/export.gd"],
      },
      {
        key: "component.ui",
        title: "UI",
        status: "accepted",
        sourceRefs: ["godot/src/ui/main.gd"],
      },
    ]);
    expect(classified.supportingDocuments).toEqual([
      "README.md",
      "docs/current-handoff.md",
    ]);
  });

  it("classifies a generic repository without Godot metadata or a canonical subpath", () => {
    const generic: DiscoveredRepository = {
      ...discovery,
      repository: {
        ...discovery.repository,
        root: "C:/synthetic/generic-toolkit",
        canonicalSubpath: null,
      },
      discovery: {
        ...discovery.discovery,
        binaryCollections: [{
          directory: "assets",
          role: "asset",
          extensions: [".png"],
          count: 1,
          byteSize: 64,
        }],
      },
      selectedSources: [
        source("README.md", "supporting_document", "# Generic toolkit\n"),
        source("src/core/index.ts", "canonical_source", "export const core = true;\n"),
        source("tests/core.test.ts", "test", "export const tested = true;\n"),
        source("tools/build.ts", "tool", "export const build = true;\n"),
      ],
    };

    expect(classifyRepository(generic)).toEqual({
      godot: null,
      components: [
        {
          key: "component.assets",
          title: "Assets",
          status: "accepted",
          sourceRefs: ["assets"],
        },
        {
          key: "component.core",
          title: "Runtime core",
          status: "accepted",
          sourceRefs: ["src/core/index.ts"],
        },
        {
          key: "component.tests",
          title: "Tests",
          status: "accepted",
          sourceRefs: ["tests/core.test.ts"],
        },
        {
          key: "component.tools",
          title: "Tools",
          status: "accepted",
          sourceRefs: ["tools/build.ts"],
        },
      ],
      supportingDocuments: ["README.md"],
    });
  });
});
