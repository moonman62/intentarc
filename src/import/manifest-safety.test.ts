import { describe, expect, it } from "vitest";
import { importInspectionSchema } from "../domain/import-schemas.js";
import type {
  ProposedImportRecord,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import { detectText } from "../outbound/detectors.js";
import { computeImportManifestDigest } from "./canonical-manifest.js";
import { RepositoryImportError } from "./errors.js";
import {
  inspectImportManifest,
  normalizeManifestSafety,
} from "./manifest-safety.js";

const forced = "api_key=synthetic-secret-ABC123456789xyz";
const possible = "owner@example.invalid";
const hash = (character: string): string => character.repeat(64);

const record = (
  override: Partial<ProposedImportRecord> = {},
): ProposedImportRecord => ({
  key: "component.core",
  kind: "component",
  status: "accepted",
  title: "Runtime core",
  body: "Canonical runtime component.",
  sourceKind: "repository",
  sourceRef: "godot/src/core/run.gd",
  sourceRefs: ["godot/src/core/run.gd"],
  curationReason: null,
  ...override,
});

const baseManifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: "2026-07-28T12:00:00.000Z",
  repository: {
    root: "C:/synthetic/example-game",
    canonicalSubpath: "godot",
    branch: "main",
    head: "a".repeat(40),
    fingerprint: hash("b"),
  },
  discovery: {
    sources: [{
      path: "godot/src/core/run.gd",
      status: "tracked",
      role: "canonical_source",
      byteSize: 16,
      sha256: hash("c"),
      extraction: { title: null, headings: [] },
    }],
    binaryCollections: [],
    warnings: [{ code: "working_tree_dirty", count: 1 }],
    exclusions: [{ path: "node_modules", reason: "hard_exclusion", count: 1 }],
  },
  proposal: {
    project: {
      name: "Example Game",
      primaryRepositoryPath: "C:/synthetic/example-game",
    },
    records: [record()],
    relationships: [],
  },
});

const thrownBy = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
};

describe("import manifest safety", () => {
  it.each([
    String.raw`C:\Users\Synthetic Developer\source\example-game`,
    "/home/synthetic-developer/source/example-game",
  ])("retains the required local repository identity at %s", (repositoryRoot) => {
    const manifest = baseManifest();
    manifest.repository.root = repositoryRoot;
    manifest.proposal.project.primaryRepositoryPath = repositoryRoot;

    const result = normalizeManifestSafety(manifest);

    expect(result.manifest.repository.root).toBe(repositoryRoot);
    expect(result.manifest.proposal.project.primaryRepositoryPath).toBe(
      repositoryRoot,
    );
    expect(result.findings).toEqual([]);
  });

  it.each([
    [
      "email",
      String.raw`C:\Users\owner@example.invalid\source\example-game`,
      "owner@example.invalid",
    ],
    [
      "provider token",
      String.raw`C:\Users\sk-proj-SyntheticTokenValue0123456789\source\example-game`,
      "SyntheticTokenValue",
    ],
    [
      "phone number",
      String.raw`C:\Users\351-210-555-0101\source\example-game`,
      "351-210-555-0101",
    ],
    [
      "network address",
      "/home/192.168.10.20/source/example-game",
      "192.168.10.20",
    ],
  ])("blocks an overlapping %s in local repository identity paths", (
    _label,
    repositoryRoot,
    matchedValue,
  ) => {
    const manifest = baseManifest();
    manifest.repository.root = repositoryRoot;
    manifest.proposal.project.primaryRepositoryPath = repositoryRoot;

    const error = thrownBy(() => normalizeManifestSafety(manifest));

    expect(error).toMatchObject({
      code: "sensitive_content_blocked",
      details: { count: 2 },
    });
    expect(JSON.stringify(error)).not.toContain(matchedValue);
  });

  it("blocks forced credential findings without exposing matched values", () => {
    const manifest = baseManifest();
    manifest.proposal.records[0] = record({ body: `Synthetic canary ${forced}` });

    const error = thrownBy(() => normalizeManifestSafety(manifest));

    expect(error).toBeInstanceOf(RepositoryImportError);
    expect(error).toMatchObject({
      code: "sensitive_content_blocked",
      details: { count: 1 },
    });
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });

  it.each(["title", "body"] as const)(
    "normalizes possible values in record %s before computing the semantic digest",
    (field) => {
      const manifest = baseManifest();
      manifest.proposal.records[0] = record({
        [field]: `Contact ${possible} for review.`,
      });
      const rawDigest = computeImportManifestDigest(manifest);

      const result = normalizeManifestSafety(manifest);

      expect(result.manifest.proposal.records[0]![field]).toBe(
        "Contact [REDACTED:EMAIL:1] for review.",
      );
      expect(result.findings).toEqual([
        expect.objectContaining({
          detectorId: "email",
          category: "email",
          confidence: "possible",
          severity: "sensitive",
          path: `/proposal/records/0/${field}`,
          requiredAction: "redact_by_default",
        }),
      ]);
      expect(JSON.stringify(result.findings)).not.toContain(possible);
      expect(result.digest).toBe(computeImportManifestDigest(result.manifest));
      expect(result.digest).not.toBe(rawDigest);
      expect(manifest.proposal.records[0]![field]).toContain(possible);
    },
  );

  it.each([
    [
      "project identity",
      (manifest: RepositoryImportManifest) => {
        manifest.proposal.project.name = `Project ${possible}`;
      },
    ],
    [
      "repository root",
      (manifest: RepositoryImportManifest) => {
        manifest.repository.root = `C:/synthetic/${possible}`;
        manifest.proposal.project.primaryRepositoryPath =
          manifest.repository.root;
      },
    ],
    [
      "selected-source path",
      (manifest: RepositoryImportManifest) => {
        manifest.discovery.sources[0]!.path = `godot/src/${possible}.gd`;
        manifest.proposal.records[0] = record({
          sourceRef: manifest.discovery.sources[0]!.path,
          sourceRefs: [manifest.discovery.sources[0]!.path],
        });
      },
    ],
    [
      "record provenance",
      (manifest: RepositoryImportManifest) => {
        manifest.discovery.sources[0]!.path = possible;
        manifest.proposal.records[0] = record({
          sourceRef: possible,
          sourceRefs: [possible],
        });
      },
    ],
  ] as const)("blocks possible findings in %s fields", (_label, mutate) => {
    const manifest = baseManifest();
    mutate(manifest);

    expect(thrownBy(() => normalizeManifestSafety(manifest))).toMatchObject({
      code: "sensitive_content_blocked",
      details: { count: expect.any(Number) },
    });
  });

  it("inspects only safe summaries, active links, claims, counts, and aggregate findings", () => {
    const manifest = baseManifest();
    manifest.discovery.sources.push({
      path: "README.md",
      status: "tracked",
      role: "supporting_document",
      byteSize: 18,
      sha256: hash("d"),
      extraction: { title: "Product direction", headings: [] },
    });
    manifest.proposal.records = [
      record(),
      record({
        key: "project.vision",
        kind: "vision",
        title: "Product direction",
        body: "Explicit stable direction.",
        sourceRef: "README.md",
        sourceRefs: ["README.md"],
      }),
      record({
        key: "task.current",
        kind: "task",
        status: "active",
        title: "Curated current task",
        body: `Coordinate with ${possible}.`,
        sourceKind: "import",
        sourceRef: null,
        sourceRefs: [],
        curationReason: "Curated by the local import workflow.",
      }),
      record({
        key: "risk.dirty",
        kind: "risk",
        status: "provisional",
        title: "Dirty working tree",
        body: "Scanner reported local changes.",
        sourceKind: "import",
        sourceRef: null,
        sourceRefs: [],
        curationReason: "Synthesized from repository warning working_tree_dirty.",
      }),
    ];
    manifest.proposal.relationships = [{
      fromKey: "task.current",
      toKey: "component.core",
      kind: "implements",
    }];

    const inspection = inspectImportManifest(manifest);

    expect(importInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(inspection.manifestDigest).toBe(
      normalizeManifestSafety(manifest).digest,
    );
    expect(inspection.counts).toEqual({
      recordsByKind: [
        { kind: "component", count: 1 },
        { kind: "risk", count: 1 },
        { kind: "task", count: 1 },
        { kind: "vision", count: 1 },
      ],
      recordsByStatus: [
        { status: "accepted", count: 2 },
        { status: "active", count: 1 },
        { status: "provisional", count: 1 },
      ],
      recordsBySourceKind: [
        { sourceKind: "import", count: 2 },
        { sourceKind: "repository", count: 2 },
      ],
    });
    expect(inspection.stableFrame).toEqual([
      expect.objectContaining({ key: "project.vision", kind: "vision" }),
    ]);
    expect(inspection.activeTasks).toEqual([
      expect.objectContaining({
        key: "task.current",
        title: "Curated current task",
        directLinks: [{
          fromKey: "task.current",
          toKey: "component.core",
          kind: "implements",
        }],
      }),
    ]);
    expect(inspection.curatedOrProvisionalClaims.map(({ key }) => key)).toEqual([
      "risk.dirty",
      "task.current",
    ]);
    expect(inspection.sensitiveFindings).toEqual([
      { category: "email", severity: "sensitive", count: 1 },
    ]);
    expect(inspection.warnings).toEqual(manifest.discovery.warnings);
    expect(inspection.exclusions).toEqual(manifest.discovery.exclusions);
    expect(inspection).not.toHaveProperty("manifest");
    expect(JSON.stringify(inspection)).not.toContain(possible);
  });

  it("includes only accepted stable-kind records in the stable frame", () => {
    const manifest = baseManifest();
    manifest.proposal.records = [
      record({
        key: "stable.accepted",
        kind: "vision",
        status: "accepted",
        title: "Accepted direction",
      }),
      record({
        key: "stable.provisional",
        kind: "outcome",
        status: "provisional",
        title: "Provisional outcome",
      }),
      record({
        key: "stable.rejected",
        kind: "constraint",
        status: "rejected",
        title: "Rejected constraint",
      }),
      record({
        key: "stable.archived",
        kind: "non_goal",
        status: "archived",
        title: "Archived non-goal",
      }),
      record({
        key: "stable.superseded",
        kind: "vision",
        status: "superseded",
        title: "Superseded direction",
      }),
    ];

    expect(inspectImportManifest(manifest).stableFrame).toEqual([
      expect.objectContaining({
        key: "stable.accepted",
        kind: "vision",
        status: "accepted",
      }),
    ]);
  });

  it("numbers multiple possible findings deterministically across leaves and within one leaf", () => {
    const manifest = baseManifest();
    manifest.proposal.records[0] = record({
      title: "Contact title.owner@example.invalid.",
      body: "First alpha.owner@example.invalid then beta.owner@example.invalid.",
    });

    const result = normalizeManifestSafety(manifest);

    expect(result.manifest.proposal.records[0]).toMatchObject({
      title: "Contact [REDACTED:EMAIL:3].",
      body: "First [REDACTED:EMAIL:1] then [REDACTED:EMAIL:2].",
    });
    expect(result.findings.map(({ path }) => path)).toEqual([
      "/proposal/records/0/body",
      "/proposal/records/0/body",
      "/proposal/records/0/title",
    ]);
    expect(result.findings[0]!.start).toBeLessThan(result.findings[1]!.start);
    expect(result.findings.every(({ detectorId }) => detectorId === "email")).toBe(true);
  });

  it("collapses overlapping possible and forced spans in favor of the forced detector", () => {
    const canary = "postgres://synthetic:password@example.invalid/database";
    const rawFindings = detectText("/proposal/records/0/body", canary);
    expect(rawFindings.map(({ category }) => category)).toEqual(
      expect.arrayContaining(["credential_uri", "email"]),
    );
    const manifest = baseManifest();
    manifest.proposal.records[0] = record({ body: canary });

    expect(thrownBy(() => normalizeManifestSafety(manifest))).toMatchObject({
      code: "sensitive_content_blocked",
      details: { count: 1 },
    });
  });
});
