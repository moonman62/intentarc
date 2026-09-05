import { describe, expect, it } from "vitest";
import type {
  ImportApplyResult,
  ImportInspection,
  RepositoryImportManifest,
} from "./import-model.js";
import {
  importApplyResultSchema,
  importInspectionSchema,
  repositoryImportManifestSchema,
} from "./import-schemas.js";

const digest = (character: string): string => character.repeat(64);

const manifest: RepositoryImportManifest = {
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
    sources: [],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Fixture",
      primaryRepositoryPath: "C:\\projects\\fixture",
    },
    records: [],
    relationships: [],
  },
};

const recordsManifest = (): RepositoryImportManifest => ({
  ...manifest,
  discovery: {
    ...manifest.discovery,
    sources: [
      {
        path: "README.md",
        status: "tracked",
        role: "supporting_document",
        byteSize: 10,
        sha256: digest("c"),
        extraction: { title: "Fixture", headings: ["Fixture"] },
      },
      {
        path: "docs/overview.md",
        status: "tracked",
        role: "supporting_document",
        byteSize: 20,
        sha256: digest("d"),
        extraction: { title: "Overview", headings: ["Overview"] },
      },
    ],
  },
  proposal: {
    ...manifest.proposal,
    records: [
      {
        key: "project.overview",
        kind: "component",
        status: "accepted",
        title: "Overview",
        body: "Repository overview.",
        sourceKind: "repository",
        sourceRef: "README.md",
        sourceRefs: ["README.md"],
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
    ],
  },
});

describe("repository import manifest contracts", () => {
  it("accepts the exact strict public manifest shape", () => {
    expect(repositoryImportManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() => repositoryImportManifestSchema.parse({ ...manifest, unknown: true })).toThrow();
  });

  it("rejects unknown nested fields and malformed repository identity", () => {
    expect(() => repositoryImportManifestSchema.parse({
      ...manifest,
      repository: { ...manifest.repository, unsafe: true },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...manifest,
      repository: { ...manifest.repository, head: "A".repeat(40) },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...manifest,
      repository: { ...manifest.repository, fingerprint: "b".repeat(63) },
    })).toThrow();
  });

  it("accepts only exact SHA-1 or SHA-256 Git object IDs", () => {
    expect(repositoryImportManifestSchema.parse({
      ...manifest,
      repository: { ...manifest.repository, head: "c".repeat(64) },
    }).repository.head).toBe("c".repeat(64));
    for (const length of [39, 41, 63, 65]) {
      expect(() => repositoryImportManifestSchema.parse({
        ...manifest,
        repository: { ...manifest.repository, head: "c".repeat(length) },
      })).toThrow();
    }
  });

  it("rejects canonical paths that are absolute, escaping, or not normalized", () => {
    for (const canonicalSubpath of ["C:/outside", "/outside", "godot/../outside", "godot//scenes", "godot\\scenes"]) {
      expect(() => repositoryImportManifestSchema.parse({
        ...manifest,
        repository: { ...manifest.repository, canonicalSubpath },
      })).toThrow();
    }
  });

  it("rejects non-normalized discovery paths", () => {
    expect(() => repositoryImportManifestSchema.parse({
      ...manifest,
      discovery: {
        ...manifest.discovery,
        sources: [{
          path: "src/../main.ts",
          status: "tracked",
          role: "canonical_source",
          byteSize: 10,
          sha256: digest("c"),
          extraction: { title: null, headings: [] },
        }],
      },
    })).toThrow();
  });

  it("uses the empty directory only for root-level binary collections", () => {
    const rootBinary = {
      directory: "",
      role: "asset",
      extensions: [".png"],
      count: 1,
      byteSize: 4,
    } as const;
    const nestedBinary = {
      ...rootBinary,
      directory: "repository-root",
      byteSize: 5,
    };
    const withDistinctBinaryDirectories: RepositoryImportManifest = {
      ...manifest,
      discovery: {
        ...manifest.discovery,
        binaryCollections: [rootBinary, nestedBinary],
      },
    };

    expect(repositoryImportManifestSchema.parse(withDistinctBinaryDirectories)
      .discovery.binaryCollections).toEqual([rootBinary, nestedBinary]);
  });

  it("rejects duplicate record keys, dangling local keys, self-links, and duplicate tuples", () => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;
    const relationship = valid.proposal.relationships[0]!;

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: { ...valid.proposal, records: [overview!, { ...task!, key: overview!.key }] },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        relationships: [{ ...relationship, toKey: "missing.record" }],
      },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        relationships: [{ ...relationship, toKey: relationship.fromKey }],
      },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        relationships: [relationship, { ...relationship }],
      },
    })).toThrow();
  });

  it("requires source provenance or a curation reason for each proposed record", () => {
    const valid = recordsManifest();
    const [overview] = valid.proposal.records;

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        records: [{ ...overview!, sourceRef: null, sourceRefs: [], curationReason: null }],
        relationships: [],
      },
    })).toThrow();
  });

  it("rejects whitespace-only provenance without altering meaningful surrounding whitespace", () => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: { ...valid.proposal, records: [{ ...overview!, sourceRef: "   " }, task!] },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: { ...valid.proposal, records: [{ ...overview!, sourceRef: null, sourceRefs: ["\t"] }, task!] },
    })).toThrow();
    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        records: [{ ...overview!, sourceRef: null, sourceRefs: [], curationReason: " \n " }, task!],
      },
    })).toThrow();

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        records: [{
          ...overview!,
          sourceRef: " README.md ",
          sourceRefs: [" docs/overview.md "],
          curationReason: " Curated from explicit repository facts. ",
        }, task!],
      },
    })).toThrow();
  });

  it.each([
    ["absolute", "C:/outside.md"],
    ["traversal", "../../outside.md"],
    ["NUL", "docs/\0outside.md"],
    ["arbitrary prose", "repository evidence described in prose"],
    ["oversized", "a".repeat(1_025)],
    ["undiscovered", "docs/missing.md"],
  ])("rejects a %s repository provenance reference", (_name, sourceRef) => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        records: [{
          ...overview!,
          sourceRef,
          sourceRefs: [sourceRef],
        }, task!],
      },
    })).toThrow();
  });

  it("ties the primary source reference to the first discovered source reference", () => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;

    for (const record of [
      {
        ...overview!,
        sourceRef: "README.md",
        sourceRefs: ["docs/overview.md"],
      },
      {
        ...overview!,
        sourceRef: null,
        sourceRefs: ["README.md"],
      },
      {
        ...overview!,
        sourceRef: "README.md",
        sourceRefs: [],
      },
    ]) {
      expect(() => repositoryImportManifestSchema.parse({
        ...valid,
        proposal: {
          ...valid.proposal,
          records: [record, task!],
        },
      })).toThrow();
    }
  });

  it("accepts the explicit root reference only for a discovered root binary collection", () => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;
    const rootEvidence = {
      ...overview!,
      sourceRef: ".",
      sourceRefs: ["."],
    };

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        records: [rootEvidence, task!],
      },
    })).toThrow();
    expect(repositoryImportManifestSchema.parse({
      ...valid,
      discovery: {
        ...valid.discovery,
        binaryCollections: [{
          directory: "",
          role: "asset",
          extensions: [".png"],
          count: 1,
          byteSize: 20,
        }],
      },
      proposal: {
        ...valid.proposal,
        records: [rootEvidence, task!],
      },
    }).proposal.records[0]).toEqual(rootEvidence);
  });

  it("distinguishes direct repository evidence from curated claims", () => {
    const valid = recordsManifest();
    const [overview, task] = valid.proposal.records;

    for (const record of [
      {
        ...overview!,
        curationReason: "This is actually a curated synthesis.",
      },
      {
        ...overview!,
        sourceKind: "agent" as const,
        curationReason: null,
      },
      {
        ...overview!,
        sourceKind: "human" as const,
        curationReason: "Curated locally.",
      },
    ]) {
      expect(() => repositoryImportManifestSchema.parse({
        ...valid,
        proposal: {
          ...valid.proposal,
          records: [record, task!],
        },
      })).toThrow();
    }
  });

  it("rejects noncanonical persisted project and record strings", () => {
    const valid = recordsManifest();
    const [overview] = valid.proposal.records;

    for (const proposal of [
      {
        ...valid.proposal,
        project: { ...valid.proposal.project, name: " Imported project " },
      },
      {
        ...valid.proposal,
        records: [{ ...overview!, title: " Overview " }],
        relationships: [],
      },
      {
        ...valid.proposal,
        records: [{ ...overview!, body: " \n\t " }],
        relationships: [],
      },
      {
        ...valid.proposal,
        records: [{ ...overview!, body: "Repository overview. " }],
        relationships: [],
      },
    ]) {
      expect(() => repositoryImportManifestSchema.parse({
        ...valid,
        proposal,
      })).toThrow();
    }
  });

  it("requires the proposed primary repository path to match the discovered root", () => {
    const valid = recordsManifest();

    expect(() => repositoryImportManifestSchema.parse({
      ...valid,
      proposal: {
        ...valid.proposal,
        project: {
          ...valid.proposal.project,
          primaryRepositoryPath: "C:/projects/outside",
        },
      },
    })).toThrow();
  });

  it("accepts strict inspection summaries without a manifest body or matched values", () => {
    const inspection: ImportInspection = {
      manifestDigest: digest("a"),
      repository: manifest.repository,
      project: manifest.proposal.project,
      counts: {
        recordsByKind: [{ kind: "task", count: 1 }],
        recordsByStatus: [{ status: "active", count: 1 }],
        recordsBySourceKind: [{ sourceKind: "repository", count: 1 }],
      },
      stableFrame: [{
        key: "project.overview",
        kind: "component",
        status: "accepted",
        title: "Overview",
        sourceKind: "repository",
        sourceRef: "README.md",
      }],
      activeTasks: [{
        key: "project.task",
        kind: "task",
        status: "active",
        title: "Current task",
        sourceKind: "import",
        sourceRef: null,
        directLinks: [{ fromKey: "project.task", toKey: "project.overview", kind: "implements" }],
      }],
      curatedOrProvisionalClaims: [{
        key: "project.task",
        kind: "task",
        status: "provisional",
        title: "Current task",
        sourceKind: "import",
        curationReason: "Imported for local review.",
      }],
      sensitiveFindings: [{ category: "api_token", severity: "credential", count: 1 }],
      warnings: [],
      exclusions: [],
    };

    expect(importInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(() => importInspectionSchema.parse({ ...inspection, normalizedManifest: manifest })).toThrow();
    expect(() => importInspectionSchema.parse({
      ...inspection,
      activeTasks: [{ ...inspection.activeTasks[0]!, directLinks: [{
        ...inspection.activeTasks[0]!.directLinks[0]!, rawMatchedValue: "synthetic",
      }] }],
    })).toThrow();
    expect(() => importInspectionSchema.parse({
      ...inspection,
      activeTasks: [{ ...inspection.activeTasks[0]!, status: "completed" }],
    })).toThrow();
    expect(() => importInspectionSchema.parse({
      ...inspection,
      curatedOrProvisionalClaims: [{
        ...inspection.curatedOrProvisionalClaims[0]!, status: "accepted", curationReason: null,
      }],
    })).toThrow();
  });

  it("accepts and strictly validates import apply results", () => {
    const result: ImportApplyResult = {
      projectId: "project-1",
      manifestDigest: digest("a"),
      repositoryFingerprint: digest("b"),
      revisionBefore: 0,
      revisionAfter: 1,
      replayed: false,
    };

    expect(importApplyResultSchema.parse(result)).toEqual(result);
    expect(() => importApplyResultSchema.parse({ ...result, databaseError: "synthetic" })).toThrow();
  });
});
