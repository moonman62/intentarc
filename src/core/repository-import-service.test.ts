import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImportApplyResult,
  ImportInspection,
  RepositoryImportManifest,
} from "../domain/import-model.js";
import {
  computeImportManifestDigest,
} from "../import/canonical-manifest.js";
import { RepositoryImportError } from "../import/errors.js";
import { generateImportManifest } from "../import/manifest-generator.js";
import { normalizeManifestSafety } from "../import/manifest-safety.js";
import { discoverRepository } from "../import/repository-scanner.js";
import type { RepositoryImportStore } from "../storage/repository-import-store.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../test-support/repository-fixture.js";
import {
  createRepositoryImportService,
  createRepositoryImportTools,
} from "./repository-import-service.js";

const timestamp = "2026-07-28T12:00:00.000Z";
const repositoryFingerprint = "b".repeat(64);
const repositoryFixtures: RepositoryFixture[] = [];

afterEach(() => {
  while (repositoryFixtures.length > 0) {
    repositoryFixtures.pop()!.cleanup();
  }
});

const manifest = (): RepositoryImportManifest => ({
  manifestVersion: 1,
  scannerVersion: "1",
  rulesetVersion: "1",
  createdAt: timestamp,
  repository: {
    root: "C:/projects/example",
    canonicalSubpath: "game",
    branch: "main",
    head: "c".repeat(40),
    fingerprint: repositoryFingerprint,
  },
  discovery: {
    sources: [{
      path: "game/project.godot",
      status: "tracked",
      role: "canonical_source",
      byteSize: 42,
      sha256: "d".repeat(64),
      extraction: {
        title: "Example",
        headings: [],
      },
    }],
    binaryCollections: [],
    warnings: [],
    exclusions: [],
  },
  proposal: {
    project: {
      name: "Imported project",
      primaryRepositoryPath: "C:/projects/example",
    },
    records: [{
      key: "task",
      kind: "task",
      status: "active",
      title: "Implement onboarding",
      body: "PRIVATE RECORD BODY",
      sourceKind: "repository",
      sourceRef: "game/project.godot",
      sourceRefs: ["game/project.godot"],
      curationReason: null,
    }],
    relationships: [],
  },
});

const applyResult = (
  digest: string,
  replayed = false,
): ImportApplyResult => ({
  projectId: "project-1",
  manifestDigest: digest,
  repositoryFingerprint,
  revisionBefore: 0,
  revisionAfter: 1,
  replayed,
});

const emptyStore = (): RepositoryImportStore => ({
  findByDigest: () => null,
  applyInitialSnapshot: ({ manifest: candidate, manifestDigest }) =>
    applyResult(manifestDigest, candidate.repository.fingerprint !== repositoryFingerprint),
});

describe("repository import tools", () => {
  it("scans with the exact repository inputs and passes discovery to the generator", () => {
    const candidate = manifest();
    const discovery = { marker: "discovery" };
    const scanner = vi.fn(() => discovery);
    const generator = vi.fn(() => candidate);
    const tools = createRepositoryImportTools({
      scanner: scanner as never,
      generator: generator as never,
    });

    expect(tools.scan({
      repositoryPath: "C:/projects/example",
      canonicalSubpath: "game",
    })).toBe(candidate);
    expect(scanner).toHaveBeenCalledWith({
      root: "C:/projects/example",
      canonicalSubpath: "game",
    });
    expect(generator).toHaveBeenCalledWith(discovery);
  });

  it("strictly validates unknown manifests and exposes no normalized manifest or record bodies", () => {
    const tools = createRepositoryImportTools();

    expect(() => tools.inspect({
      ...manifest(),
      unexpected: true,
    })).toThrowError(expect.objectContaining({
      code: "manifest_invalid",
      details: {},
    }));

    const inspection = tools.inspect(manifest());
    expect(inspection).toMatchObject({
      manifestDigest: computeImportManifestDigest(manifest()),
      activeTasks: [{
        key: "task",
        title: "Implement onboarding",
      }],
    });
    expect(inspection).not.toHaveProperty("normalizedManifest");
    expect(JSON.stringify(inspection)).not.toContain("PRIVATE RECORD BODY");
  });

  it("retains safe finding counts while omitting and redacting record bodies", () => {
    const candidate = manifest();
    candidate.proposal.records[0]!.body =
      "Contact owner@example.com for review.";
    const tools = createRepositoryImportTools();

    const inspection = tools.inspect(candidate);

    expect(inspection.sensitiveFindings).toEqual([{
      category: "email",
      severity: "sensitive",
      count: 1,
    }]);
    expect(JSON.stringify(inspection)).not.toContain("owner@example.com");
    expect(JSON.stringify(inspection)).not.toContain("[REDACTED:EMAIL:1]");
  });
});

describe("repository import service", () => {
  it("normalizes, derives, confirms, checks replay, verifies drift, then stores the normalized manifest", () => {
    const candidate = manifest();
    candidate.proposal.records[0]!.body =
      "Contact owner@example.com for review.";
    const normalized = normalizeManifestSafety(candidate);
    expect(normalized.manifest.proposal.records[0]!.body).toBe(
      "Contact [REDACTED:EMAIL:1] for review.",
    );
    const calls: string[] = [];
    const safetyNormalizer = vi.fn((input: RepositoryImportManifest) => {
      calls.push("normalize");
      return normalizeManifestSafety(input);
    });
    const inspector = vi.fn((input: RepositoryImportManifest): ImportInspection => {
      calls.push("inspect");
      return createRepositoryImportTools().inspect(input);
    });
    const store: RepositoryImportStore = {
      findByDigest(digest) {
        calls.push(`receipt:${digest}`);
        return null;
      },
      applyInitialSnapshot(input) {
        calls.push(`store:${input.manifestDigest}`);
        expect(input).toEqual({
          manifest: normalized.manifest,
          manifestDigest: normalized.digest,
          repositoryFingerprint,
        });
        return applyResult(input.manifestDigest);
      },
    };
    const driftVerifier = vi.fn((input: RepositoryImportManifest) => {
      calls.push(`drift:${input.repository.fingerprint}`);
      expect(input).toEqual(normalized.manifest);
    });
    const service = createRepositoryImportService({
      store,
      safetyNormalizer,
      inspector,
      driftVerifier,
    });

    expect(service.apply({
      manifest: candidate,
      confirmedDigest: normalized.digest,
    })).toEqual(applyResult(normalized.digest));
    expect(calls).toEqual([
      "normalize",
      "inspect",
      `receipt:${normalized.digest}`,
      `drift:${repositoryFingerprint}`,
      `store:${normalized.digest}`,
    ]);
  });

  it("rejects an inexact confirmation before receipt lookup", () => {
    const candidate = manifest();
    const digest = computeImportManifestDigest(candidate);
    const store = {
      ...emptyStore(),
      findByDigest: vi.fn(() => null),
    };
    const driftVerifier = vi.fn();
    const service = createRepositoryImportService({ store, driftVerifier });

    expect(() => service.apply({
      manifest: candidate,
      confirmedDigest: "e".repeat(64),
    })).toThrowError(expect.objectContaining({
      code: "manifest_digest_mismatch",
      details: {
        expectedDigest: digest,
        actualDigest: "e".repeat(64),
      },
    }));
    expect(store.findByDigest).not.toHaveBeenCalled();
    expect(driftVerifier).not.toHaveBeenCalled();
  });

  it("returns an existing receipt as replayed before source verification", () => {
    const candidate = manifest();
    const digest = computeImportManifestDigest(candidate);
    const store: RepositoryImportStore = {
      findByDigest: () => applyResult(digest, false),
      applyInitialSnapshot: vi.fn(),
    };
    const driftVerifier = vi.fn(() => {
      throw new Error("must not verify a replay");
    });
    const service = createRepositoryImportService({ store, driftVerifier });

    expect(service.apply({
      manifest: candidate,
      confirmedDigest: digest,
    })).toEqual(applyResult(digest, true));
    expect(driftVerifier).not.toHaveBeenCalled();
    expect(store.applyInitialSnapshot).not.toHaveBeenCalled();
  });

  it("normalizes invalid input without leaking validation details", () => {
    const service = createRepositoryImportService({
      store: emptyStore(),
      driftVerifier: vi.fn(),
    });

    let caught: unknown;
    try {
      service.apply({
        manifest: {
          ...manifest(),
          proposal: {
            ...manifest().proposal,
            records: [{ privateCanary: "do not leak this" }],
          },
        },
        confirmedDigest: "e".repeat(64),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RepositoryImportError);
    expect(caught).toMatchObject({ code: "manifest_invalid", details: {} });
    expect(String(caught)).not.toContain("privateCanary");
    expect(JSON.stringify(caught)).not.toContain("do not leak this");
  });

  it("preserves source drift and never reaches the atomic store", () => {
    const candidate = manifest();
    const digest = computeImportManifestDigest(candidate);
    const store = {
      ...emptyStore(),
      applyInitialSnapshot: vi.fn(),
    };
    const service = createRepositoryImportService({
      store,
      driftVerifier: () => {
        throw new RepositoryImportError("source_drift", {
          expectedDigest: repositoryFingerprint,
          actualDigest: "f".repeat(64),
        });
      },
    });

    expect(() => service.apply({
      manifest: candidate,
      confirmedDigest: digest,
    })).toThrowError(expect.objectContaining({
      code: "source_drift",
      details: {
        expectedDigest: repositoryFingerprint,
        actualDigest: "f".repeat(64),
      },
    }));
    expect(store.applyInitialSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["canonical repository root", (value: RepositoryImportManifest) => {
      value.repository.root = `${value.repository.root}/.`;
      value.proposal.project.primaryRepositoryPath = value.repository.root;
    }],
    ["Git repository root identity", (value: RepositoryImportManifest) => {
      value.repository.root = `${value.repository.root}/game`;
      value.proposal.project.primaryRepositoryPath = value.repository.root;
    }],
    ["branch", (value: RepositoryImportManifest) => {
      value.repository.branch = "false-branch";
    }],
    ["HEAD", (value: RepositoryImportManifest) => {
      value.repository.head = "f".repeat(40);
    }],
    ["canonical subpath", (value: RepositoryImportManifest) => {
      value.repository.canonicalSubpath = null;
    }],
    ["selected source paths", (value: RepositoryImportManifest) => {
      const originalPath = value.discovery.sources[0]!.path;
      const replacementPath = `${originalPath}.moved`;
      value.discovery.sources[0] = {
        ...value.discovery.sources[0]!,
        path: replacementPath,
      };
      value.proposal.records = value.proposal.records.map((record) => ({
        ...record,
        sourceRef: record.sourceRef === originalPath
          ? replacementPath
          : record.sourceRef,
        sourceRefs: record.sourceRefs.map((sourceRef) =>
          sourceRef === originalPath ? replacementPath : sourceRef
        ),
      }));
    }],
    ["selected source content hashes", (value: RepositoryImportManifest) => {
      value.discovery.sources[0]!.sha256 = "e".repeat(64);
    }],
  ])("uses production verification to reject a false %s claim without writes", (
    _name,
    mutate,
  ) => {
    const repository = createRepositoryFixture({
      "README.md": "# Fixture\n",
      "game/project.godot": "[application]\nconfig/name=\"Fixture\"\n",
      "game/src/main.gd": "extends Node\n",
    }, {
      parentDirectory: process.cwd(),
    });
    repositoryFixtures.push(repository);
    const candidate = generateImportManifest(discoverRepository({
      root: repository.root,
      canonicalSubpath: "game",
    }), {
      createdAt: timestamp,
    });
    mutate(candidate);
    const store: RepositoryImportStore = {
      findByDigest: () => null,
      applyInitialSnapshot: vi.fn(),
    };
    const service = createRepositoryImportService({ store });

    expect(() => service.apply({
      manifest: candidate,
      confirmedDigest: computeImportManifestDigest(candidate),
    })).toThrowError(expect.objectContaining({
      code: "source_drift",
      message: "Repository sources have changed.",
      details: {
        expectedDigest: candidate.repository.fingerprint,
        actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    }));
    expect(store.applyInitialSnapshot).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects a persisted primary repository path that differs from discovery before writes", () => {
    const candidate = manifest();
    candidate.proposal.project.primaryRepositoryPath =
      `${candidate.repository.root}/other`;
    const store: RepositoryImportStore = {
      findByDigest: vi.fn(() => null),
      applyInitialSnapshot: vi.fn(),
    };
    const service = createRepositoryImportService({
      store,
      driftVerifier: vi.fn(),
    });

    expect(() => service.apply({
      manifest: candidate,
      confirmedDigest: "e".repeat(64),
    })).toThrowError(expect.objectContaining({
      code: "manifest_invalid",
      details: {},
    }));
    expect(store.findByDigest).not.toHaveBeenCalled();
    expect(store.applyInitialSnapshot).not.toHaveBeenCalled();
  });

  it.each(["lookup", "apply"] as const)(
    "normalizes unexpected %s store failures without leaking their messages",
    (failurePoint) => {
      const candidate = manifest();
      const digest = computeImportManifestDigest(candidate);
      const store: RepositoryImportStore = {
        findByDigest() {
          if (failurePoint === "lookup") {
            throw new Error("PRIVATE LOOKUP FAILURE");
          }
          return null;
        },
        applyInitialSnapshot() {
          throw new Error("PRIVATE APPLY FAILURE");
        },
      };
      const service = createRepositoryImportService({
        store,
        driftVerifier: vi.fn(),
      });

      let caught: unknown;
      try {
        service.apply({
          manifest: candidate,
          confirmedDigest: digest,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RepositoryImportError);
      expect(caught).toMatchObject({ code: "import_failed", details: {} });
      expect(String(caught)).not.toContain("PRIVATE");
      expect(JSON.stringify(caught)).not.toContain("PRIVATE");
    },
  );
});
