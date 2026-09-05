import { describe, expect, it } from "vitest";
import {
  documentRegistryEntrySchema,
  repositoryLinkSchema,
  repositoryNodeSchema,
  repositoryNodeObservationSchema,
  repositoryObservationCandidateSchema,
  repositoryRefreshReviewSchema,
  repositoryScanProgressSchema,
  repositorySnapshotDiffSchema,
  repositorySnapshotSchema,
  repositorySourceSchema,
} from "./repository-index-schemas.js";

const timestamp = "2026-08-02T12:00:00.000Z";
const sha256 = "a".repeat(64);

const source = {
  id: "repository-source-1",
  projectId: "project-1",
  root: "C:\\projects\\intentarc",
  canonicalSubpath: null,
  repositoryIdentity: "git:C:/projects/intentarc/.git",
  status: "available" as const,
  currentSnapshotId: "repository-snapshot-1",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const snapshot = {
  id: "repository-snapshot-1",
  sourceId: source.id,
  projectId: source.projectId,
  state: "accepted" as const,
  baseSnapshotId: null,
  baseProjectRevision: 7,
  branch: "main",
  head: "b".repeat(40),
  fingerprint: sha256,
  scannerVersion: "2",
  rulesetVersion: "2",
  warningCounts: { working_tree_dirty: 1 },
  exclusionCounts: { ignored: 2 },
  findingCounts: { sensitive: 0 },
  createdAt: timestamp,
  decidedAt: timestamp,
  appliedAt: timestamp,
};

const observation = {
  snapshotId: snapshot.id,
  nodeId: "repository-node-readme",
  parentNodeId: null,
  path: "README.md",
  kind: "file" as const,
  sha256,
  byteSize: 1_024,
  sourceStatus: "tracked" as const,
  role: "supporting_document" as const,
  documentKind: "overview" as const,
  documentFormat: "markdown" as const,
  contentEligible: true,
  instructionClient: null,
  instructionScope: null,
};

const node = {
  id: observation.nodeId,
  sourceId: source.id,
  kind: observation.kind,
  createdAt: timestamp,
};

const link = {
  id: "repository-link-1",
  projectId: source.projectId,
  snapshotId: snapshot.id,
  fromNodeId: observation.nodeId,
  toRecordId: "record-outcome-1",
  toNodeId: null,
  kind: "documents" as const,
  basis: "accepted" as const,
  createdAt: timestamp,
};

const diff = {
  groups: [{
    kind: "unchanged" as const,
    entries: [{
      operationId: "repository-operation-1",
      kind: "unchanged" as const,
      previousNodeId: observation.nodeId,
      currentNodeId: observation.nodeId,
      previousPath: observation.path,
      currentPath: observation.path,
    }],
  }],
  semanticOperations: [],
};

describe("repository index schemas", () => {
  it("accepts one complete content-free repository model", () => {
    expect(repositorySourceSchema.parse(source)).toEqual(source);
    expect(repositorySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(repositoryNodeSchema.parse(node)).toEqual(node);
    expect(repositoryNodeObservationSchema.parse(observation)).toEqual(observation);
    expect(repositoryLinkSchema.parse(link)).toEqual(link);
    expect(repositorySnapshotDiffSchema.parse(diff)).toEqual(diff);
    expect(repositoryScanProgressSchema.parse({
      phase: "finalizing",
      processed: 4,
      total: 4,
    })).toEqual({ phase: "finalizing", processed: 4, total: 4 });
    expect(repositoryRefreshReviewSchema.parse({
      projectId: source.projectId,
      sourceId: source.id,
      snapshotId: snapshot.id,
      state: "pending",
      selectedOperationIds: ["repository-operation-1"],
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
    })).toMatchObject({ state: "pending" });
    expect(documentRegistryEntrySchema.parse({
      projectId: source.projectId,
      snapshotId: snapshot.id,
      nodeId: observation.nodeId,
      path: observation.path,
      documentKind: observation.documentKind,
      documentFormat: observation.documentFormat,
      role: observation.role,
      freshness: "current",
      contentEligible: true,
      instructionClient: null,
      instructionScope: null,
      links: [{
        kind: link.kind,
        basis: link.basis,
        toRecordId: link.toRecordId,
        toNodeId: link.toNodeId,
      }],
    })).toMatchObject({ path: "README.md", freshness: "current" });
  });

  it("rejects unknown keys at top-level and nested boundaries", () => {
    expect(() => repositorySourceSchema.parse({ ...source, content: "secret" })).toThrow();
    expect(() => repositorySnapshotSchema.parse({
      ...snapshot,
      warningCounts: { working_tree_dirty: 1 },
      undocumented: true,
    })).toThrow();
    expect(() => repositorySnapshotDiffSchema.parse({
      ...diff,
      groups: [{ ...diff.groups[0], entries: [{ ...diff.groups[0]!.entries[0], extra: true }] }],
    })).toThrow();
  });

  it("rejects invalid SHA-256 metadata", () => {
    expect(() => repositorySnapshotSchema.parse({
      ...snapshot,
      fingerprint: "A".repeat(64),
    })).toThrow();
    expect(() => repositoryNodeObservationSchema.parse({
      ...observation,
      sha256: "short",
    })).toThrow();
  });

  it("accepts only exact SHA-1 or SHA-256 Git object IDs", () => {
    expect(repositorySnapshotSchema.parse({
      ...snapshot,
      head: "c".repeat(64),
    }).head).toBe("c".repeat(64));
    for (const length of [39, 41, 63, 65]) {
      expect(() => repositorySnapshotSchema.parse({
        ...snapshot,
        head: "c".repeat(length),
      })).toThrow();
    }
  });

  it("rejects absolute or non-normalized observation paths", () => {
    for (const path of ["C:\\projects\\intentarc\\README.md", "/repo/README.md", "docs/../README.md"]) {
      expect(() => repositoryNodeObservationSchema.parse({
        ...observation,
        path,
      })).toThrow();
    }
  });

  it("requires hashes for files and forbids hashes for directories", () => {
    expect(() => repositoryNodeObservationSchema.parse({
      ...observation,
      sha256: null,
    })).toThrow();
    expect(() => repositoryNodeObservationSchema.parse({
      ...observation,
      kind: "directory",
      sha256,
      byteSize: 0,
      documentKind: null,
      documentFormat: null,
    })).toThrow();
  });

  it("requires repository links to have exactly one target", () => {
    expect(() => repositoryLinkSchema.parse({
      ...link,
      toNodeId: "repository-node-other",
    })).toThrow();
    expect(() => repositoryLinkSchema.parse({
      ...link,
      toRecordId: null,
    })).toThrow();
  });

  it("rejects unsupported lifecycle values", () => {
    expect(() => repositorySourceSchema.parse({ ...source, status: "archived" })).toThrow();
    expect(() => repositorySnapshotSchema.parse({ ...snapshot, state: "pending" })).toThrow();
    expect(() => repositoryRefreshReviewSchema.parse({
      projectId: source.projectId,
      sourceId: source.id,
      snapshotId: snapshot.id,
      state: "accepted",
      selectedOperationIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: timestamp,
    })).toThrow();
  });

  it("accepts a strict pre-persistence observation candidate", () => {
    expect(repositoryObservationCandidateSchema.parse({
      root: source.root,
      canonicalSubpath: source.canonicalSubpath,
      repositoryIdentity: source.repositoryIdentity,
      branch: snapshot.branch,
      head: snapshot.head,
      fingerprint: snapshot.fingerprint,
      scannerVersion: snapshot.scannerVersion,
      rulesetVersion: snapshot.rulesetVersion,
      warnings: [{ code: "working_tree_dirty", count: 1 }],
      exclusions: [{ path: null, reason: "known_secret_path", count: 1 }],
      findingCounts: { sensitive: 1 },
      observations: [{
        path: observation.path,
        kind: observation.kind,
        sha256: observation.sha256,
        byteSize: observation.byteSize,
        sourceStatus: observation.sourceStatus,
        role: observation.role,
        documentKind: observation.documentKind,
        documentFormat: observation.documentFormat,
        contentEligible: observation.contentEligible,
        instructionClient: observation.instructionClient,
        instructionScope: observation.instructionScope,
      }],
      links: [{
        fromPath: observation.path,
        toRecordId: link.toRecordId,
        toPath: null,
        kind: link.kind,
        basis: link.basis,
      }],
    })).toMatchObject({ repositoryIdentity: source.repositoryIdentity });
  });

  it("rejects unbounded progress and duplicate persisted selections", () => {
    expect(() => repositoryScanProgressSchema.parse({
      phase: "hashing",
      processed: 5,
      total: 4,
    })).toThrow();
    expect(() => repositoryRefreshReviewSchema.parse({
      projectId: source.projectId,
      sourceId: source.id,
      snapshotId: snapshot.id,
      state: "pending",
      selectedOperationIds: ["operation-1", "operation-1"],
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
    })).toThrow();
  });
});
