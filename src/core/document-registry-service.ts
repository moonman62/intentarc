import { lstatSync } from "node:fs";
import { extname, resolve } from "node:path";
import { ProjectNotFoundError } from "../domain/errors.js";
import type {
  DocumentRegistryEntry,
  RepositoryDocumentFormat,
  RepositoryDocumentFreshness,
  RepositoryDocumentKind,
  RepositoryLinkBasis,
  RepositoryLinkSummary,
} from "../domain/repository-index-model.js";
import type { RepositorySourceRole } from "../domain/import-model.js";
import { normalizedRepositoryPathSchema } from "../domain/repository-index-schemas.js";
import {
  inspectFileContent,
  isHardExcludedPath,
  isKnownSecretPath,
} from "../import/filesystem-policy.js";
import {
  inspectRepositoryPath,
  readSafeRepositoryFile,
  type SafeFileReaderDependencies,
} from "../repository/safe-file-reader.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import type { RepositoryIndexStore } from "../storage/repository-index-store.js";

export interface DocumentRegistryFilter {
  locationPrefix?: string;
  role?: RepositorySourceRole;
  format?: RepositoryDocumentFormat;
  linkedRecordId?: string;
  relevance?: "current_task";
  freshness?: RepositoryDocumentFreshness;
  linkBasis?: RepositoryLinkBasis;
  unlinked?: boolean;
}

export interface DocumentFacet<Value extends string> {
  readonly value: Value;
  readonly count: number;
}

export interface DocumentRegistryView {
  readonly projectId: string;
  readonly snapshotId: string | null;
  readonly documents: DocumentRegistryEntry[];
  readonly facets: {
    readonly documentKinds: DocumentFacet<RepositoryDocumentKind>[];
    readonly formats: DocumentFacet<RepositoryDocumentFormat>[];
    readonly roles: DocumentFacet<RepositorySourceRole>[];
    readonly freshness: DocumentFacet<RepositoryDocumentFreshness>[];
  };
}

export type DocumentNativeCapability =
  | "renderable"
  | "previewable"
  | "unsupported"
  | "blocked";

export interface DocumentDetailView {
  readonly document: DocumentRegistryEntry;
  readonly linksByBasis: Record<RepositoryLinkBasis, RepositoryLinkSummary[]>;
  readonly nativeCapability: DocumentNativeCapability;
  readonly externalOpenEligible: boolean;
}

export type DocumentReadResult =
  | { status: "renderable"; format: "markdown" | "plain_text"; text: string; sha256: string }
  | { status: "previewable"; format: "image" | "pdf"; sha256: string }
  | { status: "unsupported"; format: string }
  | { status: "stale" | "missing" | "unavailable" | "blocked" };

export type DocumentPreviewResult =
  | { status: "previewable"; format: "image" | "pdf"; mediaType: string; bytes: Uint8Array; sha256: string }
  | { status: "unsupported" | "stale" | "missing" | "unavailable" | "blocked" };

export type DocumentExternalOpenResult =
  | { status: "openable"; absolutePath: string }
  | { status: "stale" | "missing" | "unavailable" | "blocked" };

export interface DocumentRegistryService {
  list(projectId: string, filter: DocumentRegistryFilter): DocumentRegistryView;
  get(projectId: string, nodeId: string): DocumentDetailView;
  read(
    projectId: string,
    nodeId: string,
    expectedSnapshotId: string,
  ): DocumentReadResult;
  readPreview(
    projectId: string,
    nodeId: string,
    expectedSnapshotId: string,
  ): DocumentPreviewResult;
  resolveExternalOpen(
    projectId: string,
    nodeId: string,
  ): DocumentExternalOpenResult;
}

export interface DocumentRegistryServiceDependencies {
  readonly projectStore: Pick<ProjectReadStore, "getProject" | "listRecords">;
  readonly store: Pick<
    RepositoryIndexStore,
    "getSource" | "getCurrentSnapshot" | "listObservations" | "listLinks"
  >;
  readonly readerDependencies?: SafeFileReaderDependencies;
}

export class DocumentNotFoundError extends Error {
  constructor(readonly nodeId: string) {
    super(`Document not found: ${nodeId}`);
    this.name = "DocumentNotFoundError";
  }
}

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const markdownExtensions = new Set([".md", ".markdown", ".mdown"]);
const plainTextExtensions = new Set([".txt", ".text", ".rst"]);
const imageExtensions = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const formatForPath = (path: string): RepositoryDocumentFormat => {
  const extension = extname(path).toLowerCase();
  if (markdownExtensions.has(extension)) return "markdown";
  if (plainTextExtensions.has(extension)) return "plain_text";
  if (imageExtensions.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  return "unsupported";
};

const blockedObservation = (observation: {
  readonly path: string;
  readonly documentFormat: RepositoryDocumentFormat | null;
  readonly contentEligible: boolean;
}): boolean => isHardExcludedPath(observation.path) ||
  isKnownSecretPath(observation.path) ||
  (!observation.contentEligible && observation.documentFormat !== "unsupported");

const rootIsAvailable = (root: string): boolean => {
  try {
    return lstatSync(root).isDirectory();
  } catch {
    return false;
  }
};

const mediaTypeFor = (format: "image" | "pdf", bytes: Buffer): string | null => {
  if (format === "pdf") {
    return bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
      ? "application/pdf"
      : null;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return "image/jpeg";
  const header = bytes.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) return "image/x-icon";
  return null;
};

const nativeCapabilityFor = (
  entry: DocumentRegistryEntry,
): DocumentNativeCapability => {
  if (entry.freshness === "blocked") return "blocked";
  if (entry.documentFormat === "markdown" || entry.documentFormat === "plain_text") {
    return "renderable";
  }
  if (entry.documentFormat === "image" || entry.documentFormat === "pdf") {
    return "previewable";
  }
  return "unsupported";
};

const emptyFacets = (): DocumentRegistryView["facets"] => ({
  documentKinds: [],
  formats: [],
  roles: [],
  freshness: [],
});

const facetsFor = (documents: readonly DocumentRegistryEntry[]): DocumentRegistryView["facets"] => {
  const count = <Value extends string>(values: readonly Value[]): DocumentFacet<Value>[] =>
    [...new Set(values)]
      .sort(compareOrdinal)
      .map((value) => ({
        value,
        count: values.filter((candidate) => candidate === value).length,
      }));
  return {
    documentKinds: count(documents.map(({ documentKind }) => documentKind)),
    formats: count(documents.map(({ documentFormat }) => documentFormat)),
    roles: count(documents.map(({ role }) => role)),
    freshness: count(documents.map(({ freshness }) => freshness)),
  };
};

export const createDocumentRegistryService = (
  { projectStore, store, readerDependencies = {} }: DocumentRegistryServiceDependencies,
): DocumentRegistryService => {
  const requireProject = (projectId: string): void => {
    if (!projectStore.getProject(projectId)) throw new ProjectNotFoundError(projectId);
  };

  const acceptedState = (projectId: string) => {
    requireProject(projectId);
    const source = store.getSource(projectId);
    const snapshot = store.getCurrentSnapshot(projectId);
    if (
      source === null ||
      snapshot === null ||
      snapshot.projectId !== projectId ||
      snapshot.sourceId !== source.id ||
      snapshot.state !== "accepted"
    ) return null;
    const observations = store.listObservations(snapshot.id);
    const links = store.listLinks(projectId)
      .filter((link) => link.snapshotId === snapshot.id);
    return { source, snapshot, observations, links };
  };

  const freshnessFor = (
    source: NonNullable<ReturnType<typeof acceptedState>>["source"],
    observation: NonNullable<ReturnType<typeof acceptedState>>["observations"][number],
  ): RepositoryDocumentFreshness => {
    if (blockedObservation(observation)) return "blocked";
    if (source.status !== "available" || !rootIsAvailable(source.root)) {
      return "unavailable";
    }
    if (
      observation.kind !== "file" ||
      observation.sha256 === null ||
      observation.documentFormat === null
    ) return "blocked";
    if (formatForPath(observation.path) !== observation.documentFormat) return "stale";
    const inspected = inspectRepositoryPath(source.root, observation.path);
    if (inspected.kind === "link") return "stale";
    if (inspected.kind !== "file") return "missing";
    try {
      const read = readSafeRepositoryFile(
        source.root,
        observation.path,
        inspected,
        "hash",
        readerDependencies,
      );
      if (read.kind !== "file") return "unavailable";
      return read.byteSize === observation.byteSize && read.sha256 === observation.sha256
        ? "current"
        : "stale";
    } catch {
      return "stale";
    }
  };

  const entriesFor = (projectId: string): DocumentRegistryEntry[] => {
    const state = acceptedState(projectId);
    if (state === null) return [];
    const linksByNode = new Map<string, RepositoryLinkSummary[]>();
    for (const link of state.links) {
      const summary: RepositoryLinkSummary = {
        kind: link.kind,
        basis: link.basis,
        toRecordId: link.toRecordId,
        toNodeId: link.toNodeId,
      };
      const summaries = linksByNode.get(link.fromNodeId) ?? [];
      summaries.push(summary);
      linksByNode.set(link.fromNodeId, summaries);
    }
    return state.observations
      .filter((observation) =>
        observation.kind === "file" &&
        observation.documentFormat !== null &&
        (
          observation.documentKind !== null ||
          observation.role === "supporting_document" ||
          observation.role === "asset"
        ))
      .map((observation): DocumentRegistryEntry => ({
        projectId,
        snapshotId: state.snapshot.id,
        nodeId: observation.nodeId,
        path: observation.path,
        documentKind: observation.documentKind ?? "unlinked",
        documentFormat: observation.documentFormat!,
        role: observation.role,
        freshness: freshnessFor(state.source, observation),
        contentEligible: observation.contentEligible,
        instructionClient: observation.instructionClient,
        instructionScope: observation.instructionScope,
        links: [...(linksByNode.get(observation.nodeId) ?? [])].sort((left, right) =>
          compareOrdinal(left.basis, right.basis) ||
          compareOrdinal(left.kind, right.kind) ||
          compareOrdinal(left.toRecordId ?? "", right.toRecordId ?? "") ||
          compareOrdinal(left.toNodeId ?? "", right.toNodeId ?? "")),
      }))
      .sort((left, right) =>
        compareOrdinal(left.path, right.path) || compareOrdinal(left.nodeId, right.nodeId));
  };

  const entryFor = (projectId: string, nodeId: string): DocumentRegistryEntry => {
    const entry = entriesFor(projectId).find((candidate) => candidate.nodeId === nodeId);
    if (!entry) throw new DocumentNotFoundError(nodeId);
    return entry;
  };

  const readCurrent = (
    projectId: string,
    nodeId: string,
    mode: "hash" | "content" | "preview",
  ) => {
    const entry = entryFor(projectId, nodeId);
    if (entry.freshness !== "current") return { entry, read: null } as const;
    const state = acceptedState(projectId)!;
    const observation = state.observations.find((item) => item.nodeId === nodeId)!;
    const inspected = inspectRepositoryPath(state.source.root, observation.path);
    if (inspected.kind !== "file") return { entry: { ...entry, freshness: "stale" as const }, read: null } as const;
    try {
      const read = readSafeRepositoryFile(
        state.source.root,
        observation.path,
        inspected,
        mode,
        readerDependencies,
      );
      if (
        read.kind !== "file" ||
        read.byteSize !== observation.byteSize ||
        (read.sha256 !== null && read.sha256 !== observation.sha256)
      ) return { entry: { ...entry, freshness: "stale" as const }, read: null } as const;
      return { entry, read } as const;
    } catch {
      return { entry: { ...entry, freshness: "stale" as const }, read: null } as const;
    }
  };

  const statusOnly = (
    freshness: RepositoryDocumentFreshness,
  ): Extract<DocumentReadResult, { status: "stale" | "missing" | "unavailable" | "blocked" }> => ({
    status: freshness === "current" ? "stale" : freshness,
  });

  return {
    list(projectId, filter) {
      let documents = entriesFor(projectId);
      const snapshotId = documents[0]?.snapshotId ?? acceptedState(projectId)?.snapshot.id ?? null;
      if (filter.locationPrefix !== undefined) {
        const prefix = normalizedRepositoryPathSchema.parse(filter.locationPrefix);
        documents = documents.filter(({ path }) =>
          path === prefix || path.startsWith(`${prefix}/`));
      }
      if (filter.role !== undefined) {
        documents = documents.filter(({ role }) => role === filter.role);
      }
      if (filter.format !== undefined) {
        documents = documents.filter(({ documentFormat }) =>
          documentFormat === filter.format);
      }
      if (filter.linkedRecordId !== undefined) {
        documents = documents.filter(({ links }) =>
          links.some(({ toRecordId }) => toRecordId === filter.linkedRecordId));
      }
      if (filter.relevance === "current_task") {
        const currentTask = projectStore.listRecords(projectId)
          .filter(({ kind, status }) =>
            kind === "task" && (status === "active" || status === "blocked"))
          .sort((left, right) =>
            compareOrdinal(left.status === "active" ? "0" : "1", right.status === "active" ? "0" : "1") ||
            compareOrdinal(right.updatedAt, left.updatedAt) ||
            compareOrdinal(left.id, right.id))[0];
        documents = currentTask === undefined
          ? []
          : documents.filter(({ links }) =>
              links.some(({ toRecordId }) => toRecordId === currentTask.id));
      }
      if (filter.freshness !== undefined) {
        documents = documents.filter(({ freshness }) => freshness === filter.freshness);
      }
      if (filter.linkBasis !== undefined) {
        documents = documents.filter(({ links }) =>
          links.some(({ basis }) => basis === filter.linkBasis));
      }
      if (filter.unlinked !== undefined) {
        documents = documents.filter(({ links }) =>
          links.every(({ toRecordId }) => toRecordId === null) === filter.unlinked);
      }
      return {
        projectId,
        snapshotId,
        documents,
        facets: documents.length === 0 ? emptyFacets() : facetsFor(documents),
      };
    },

    get(projectId, nodeId) {
      const document = entryFor(projectId, nodeId);
      const linksByBasis: DocumentDetailView["linksByBasis"] = {
        accepted: [],
        conflicting: [],
        inferred: [],
        observed: [],
      };
      for (const link of document.links) linksByBasis[link.basis].push(link);
      const nativeCapability = nativeCapabilityFor(document);
      return {
        document,
        linksByBasis,
        nativeCapability,
        externalOpenEligible: document.freshness === "current" && nativeCapability !== "blocked",
      };
    },

    read(projectId, nodeId, expectedSnapshotId) {
      if (acceptedState(projectId)?.snapshot.id !== expectedSnapshotId) {
        return { status: "stale" };
      }
      const initial = entryFor(projectId, nodeId);
      if (initial.freshness !== "current") return statusOnly(initial.freshness);
      if (initial.documentFormat === "unsupported") {
        return { status: "unsupported", format: initial.documentFormat };
      }
      const mode = initial.documentFormat === "markdown" || initial.documentFormat === "plain_text"
        ? "content"
        : "hash";
      const { entry, read } = readCurrent(projectId, nodeId, mode);
      if (entry.freshness !== "current" || read === null) return statusOnly(entry.freshness);
      if (acceptedState(projectId)?.snapshot.id !== expectedSnapshotId) {
        return { status: "stale" };
      }
      if (initial.documentFormat === "image" || initial.documentFormat === "pdf") {
        return {
          status: "previewable",
          format: initial.documentFormat,
          sha256: read.sha256!,
        };
      }
      if (read.content === null || read.sha256 === null) return { status: "blocked" };
      const inspectedContent = inspectFileContent(initial.path, read.content);
      if (inspectedContent.kind !== "text") return { status: "stale" };
      return {
        status: "renderable",
        format: initial.documentFormat,
        text: inspectedContent.text,
        sha256: read.sha256,
      };
    },

    readPreview(projectId, nodeId, expectedSnapshotId) {
      if (acceptedState(projectId)?.snapshot.id !== expectedSnapshotId) {
        return { status: "stale" };
      }
      const initial = entryFor(projectId, nodeId);
      if (initial.freshness !== "current") return statusOnly(initial.freshness);
      if (initial.documentFormat !== "image" && initial.documentFormat !== "pdf") {
        return { status: "unsupported" };
      }
      const { entry, read } = readCurrent(projectId, nodeId, "preview");
      if (entry.freshness !== "current" || read === null) return statusOnly(entry.freshness);
      if (acceptedState(projectId)?.snapshot.id !== expectedSnapshotId) {
        return { status: "stale" };
      }
      if (read.content === null || read.sha256 === null) return { status: "unsupported" };
      const mediaType = mediaTypeFor(initial.documentFormat, read.content);
      if (mediaType === null) return { status: "stale" };
      return {
        status: "previewable",
        format: initial.documentFormat,
        mediaType,
        bytes: read.content,
        sha256: read.sha256,
      };
    },

    resolveExternalOpen(projectId, nodeId) {
      const initial = entryFor(projectId, nodeId);
      if (initial.freshness !== "current") return statusOnly(initial.freshness);
      const { entry, read } = readCurrent(projectId, nodeId, "hash");
      if (entry.freshness !== "current" || read === null) {
        return statusOnly(entry.freshness);
      }
      const state = acceptedState(projectId);
      if (state === null || state.snapshot.id !== initial.snapshotId) {
        return { status: "stale" };
      }
      const observation = state.observations.find((item) =>
        item.nodeId === nodeId && item.kind === "file"
      );
      if (observation === undefined) return { status: "stale" };
      return {
        status: "openable",
        absolutePath: resolve(state.source.root, ...observation.path.split("/")),
      };
    },

  };
};
