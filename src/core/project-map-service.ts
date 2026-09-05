import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  GovernanceError,
  ProjectNotFoundError,
  RecordNotFoundError,
  normalizedRepositoryPathSchema,
  type ProjectRecord,
  type ImportExclusionReason,
  type HierarchyVocabulary,
  type RecordKind,
  type RecordRelationship,
  type RecordStatus,
  type RelationshipKind,
  type RepositoryDocumentFormat,
  type RepositoryDocumentKind,
  type RepositoryLinkBasis,
  type RepositoryLinkKind,
  type RepositoryNodeKind,
  type RepositorySourceRole,
  type RepositorySourceStatus,
} from "../domain/index.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import type {
  RepositoryExplorerStoreCursor,
  RepositoryIndexStore,
} from "../storage/repository-index-store.js";

export interface MapRecordSummary {
  id: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  revision: number;
}

export interface OutcomeProgress {
  childStatuses: Partial<Record<RecordStatus, number>>;
  childrenWithEvidence: number;
  childCount: number;
}

export interface ProjectMapHierarchyNode extends MapRecordSummary {
  parentId: string | null;
  childCount: number;
}

export interface ProjectMapView {
  projectId: string;
  projectName: string;
  projectRevision: number;
  hierarchyVocabulary: HierarchyVocabulary;
  selectedRecordId: string | null;
  scopeRecordId: string | null;
  selectedPath: MapRecordSummary[];
  hierarchyNodes: ProjectMapHierarchyNode[];
  hierarchyEdges: LabeledRecordEdge[];
  unplacedRecordIds: string[];
  progress: OutcomeProgress;
}

export interface LabeledRecordEdge {
  id: string;
  kind: RelationshipKind;
  label: string;
  fromRecordId: string;
  fromLabel: string;
  toRecordId: string;
  toLabel: string;
}

export interface FocusedRecordRelation {
  depth: 1 | 2;
  edge: LabeledRecordEdge;
  record: MapRecordSummary;
}

export interface RepositoryAttachment {
  linkId: string;
  nodeId: string;
  path: string;
  nodeKind: RepositoryNodeKind;
  linkKind: RepositoryLinkKind;
  linkLabel: string;
  basis: RepositoryLinkBasis;
  documentKind: RepositoryDocumentKind | null;
  documentFormat: RepositoryDocumentFormat | null;
  role: RepositorySourceRole;
}

export type AttachmentsByBasis = Record<RepositoryLinkBasis, RepositoryAttachment[]>;

export interface ConnectedRecordDetail {
  projectId: string;
  projectRevision: number;
  record: ProjectRecord;
  relations: FocusedRecordRelation[];
  attachmentsByBasis: AttachmentsByBasis;
}

export interface SanitizedRepositoryNode {
  nodeId: string;
  parentNodeId: string | null;
  path: string;
  kind: RepositoryNodeKind;
  role: RepositorySourceRole;
  documentKind: RepositoryDocumentKind | null;
  documentFormat: RepositoryDocumentFormat | null;
  contentEligible: boolean;
}

export type RepositoryConnection = {
  linkId: string;
  kind: RepositoryLinkKind;
  label: string;
  basis: RepositoryLinkBasis;
} & (
  | { record: MapRecordSummary; node: null }
  | { record: null; node: SanitizedRepositoryNode }
);

export interface ConnectedRepositoryDetail {
  projectId: string;
  snapshotId: string;
  node: SanitizedRepositoryNode;
  linksByBasis: Record<RepositoryLinkBasis, RepositoryConnection[]>;
}

export interface ProjectMapService {
  getProjectMap(
    projectId: string,
    selectedRecordId?: string,
    scopeRecordId?: string,
  ): ProjectMapView;
  getRecordDetail(projectId: string, recordId: string): ConnectedRecordDetail;
  getRepositoryNodeDetail(projectId: string, nodeId: string): ConnectedRepositoryDetail;
  getRepositoryTree(input: RepositoryExplorerRequest): RepositoryExplorerTreeView;
}

export interface RepositoryExplorerFilter {
  search?: string;
  relevance?: "current_task";
  changed?: boolean;
  category?: "documentation" | "test";
  documentKind?: RepositoryDocumentKind;
  role?: RepositorySourceRole;
  unlinked?: boolean;
  contextIncluded?: boolean;
  state?: "current" | "stale" | "unavailable" | "excluded";
  exclusionReason?: ImportExclusionReason;
}

export interface RepositoryExplorerRequest {
  projectId: string;
  parentNodeId?: string | null;
  pageSize?: number;
  cursor?: string;
  filter?: RepositoryExplorerFilter;
}

export interface RepositoryExplorerNode {
  nodeId: string;
  parentNodeId: string | null;
  path: string;
  kind: RepositoryNodeKind;
  role: RepositorySourceRole;
  documentKind: RepositoryDocumentKind | null;
  documentFormat: RepositoryDocumentFormat | null;
  sourceStatus: "tracked" | "untracked" | "derived";
  state: "current" | "stale" | "unavailable";
  contentEligible: boolean;
  childCount: number;
  changed: boolean;
  linked: boolean;
  currentTaskRelevant: boolean;
  contextIncluded: boolean;
}

export interface RepositoryExplorerTreeView {
  projectId: string;
  snapshotId: string | null;
  parentNodeId: string | null;
  sourceStatus: RepositorySourceStatus | null;
  request: {
    parentNodeId: string | null;
    pageSize: number;
    filter: RepositoryExplorerFilter;
  };
  items: RepositoryExplorerNode[];
  exclusions: Array<{ reason: ImportExclusionReason; count: number }>;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProjectMapServiceDependencies {
  projectStore: ProjectReadStore;
  repositoryStore: Pick<
    RepositoryIndexStore,
    | "getSource"
    | "getCurrentSnapshot"
    | "getObservation"
    | "listObservations"
    | "listLinks"
    | "listExplorerChildren"
  >;
  currentContextPackId?: (projectId: string) => string | null;
}

const hierarchyKinds = new Set<RecordKind>([
  "outcome",
  "initiative",
  "deliverable",
  "milestone",
  "task",
]);
const bases: RepositoryLinkBasis[] = ["accepted", "observed", "inferred", "conflicting"];
const maximumParentCandidates = 10_000;
const defaultExplorerPageSize = 200;
const maximumExplorerPageSize = 1_000;
const explorerCursorVersion = 1;
const exclusionReasons = [
  "hard_exclusion",
  "ignored",
  "unsupported_text",
  "oversized_text",
  "link_not_followed",
  "untracked_not_eligible",
  "known_secret_path",
] as const satisfies readonly ImportExclusionReason[];

const explorerFilterSchema = z.object({
  search: z.string().trim().min(1).max(256)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  relevance: z.literal("current_task").optional(),
  changed: z.boolean().optional(),
  category: z.enum(["documentation", "test"]).optional(),
  documentKind: z.enum([
    "overview", "specification", "decision_support", "operational_guide",
    "test_evidence", "ai_instruction", "unlinked",
  ]).optional(),
  role: z.enum([
    "canonical_source", "supporting_document", "test", "tool", "asset",
    "archived_source",
  ]).optional(),
  unlinked: z.boolean().optional(),
  contextIncluded: z.boolean().optional(),
  state: z.enum(["current", "stale", "unavailable", "excluded"]).optional(),
  exclusionReason: z.enum(exclusionReasons).optional(),
}).strict().superRefine((filter, context) => {
  if (filter.exclusionReason !== undefined && filter.state !== "excluded") {
    context.addIssue({
      code: "custom",
      path: ["exclusionReason"],
      message: "An exclusion reason requires the excluded state filter",
    });
  }
});

const explorerRequestSchema = z.object({
  projectId: z.string().min(1).max(512).refine((value) => value === value.trim()),
  parentNodeId: z.string().min(1).max(512).refine((value) => value === value.trim())
    .nullable().optional(),
  pageSize: z.number().int().min(1).max(maximumExplorerPageSize).optional(),
  cursor: z.string().min(1).max(8_192).optional(),
  filter: explorerFilterSchema.optional(),
}).strict();

const explorerCursorPayloadSchema = z.object({
  v: z.literal(explorerCursorVersion),
  projectId: z.string().min(1).max(512),
  snapshotId: z.string().min(1).max(512),
  parentNodeId: z.string().min(1).max(512).nullable(),
  pageSize: z.number().int().min(1).max(maximumExplorerPageSize),
  filterKey: z.string().max(4_096),
  contextPackId: z.string().min(1).max(512).nullable(),
  currentTaskId: z.string().min(1).max(512).nullable(),
  sourceStatus: z.enum(["available", "unavailable", "detached"]),
  projectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["directory", "file"]),
  path: normalizedRepositoryPathSchema,
  nodeId: z.string().min(1).max(512),
}).strict();

type ExplorerCursorPayload = z.infer<typeof explorerCursorPayloadSchema>;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareRecords = (left: ProjectRecord, right: ProjectRecord): number =>
  compareStrings(left.kind, right.kind) ||
  compareStrings(left.title, right.title) ||
  compareStrings(left.id, right.id);

const compareRelationships = (left: RecordRelationship, right: RecordRelationship): number =>
  compareStrings(left.kind, right.kind) ||
  compareStrings(left.fromRecordId, right.fromRecordId) ||
  compareStrings(left.toRecordId, right.toRecordId) ||
  compareStrings(left.id, right.id);

const summary = (record: ProjectRecord): MapRecordSummary => ({
  id: record.id,
  kind: record.kind,
  status: record.status,
  title: record.title,
  revision: record.revision,
});

const edgeLabel = (kind: string): string => kind.replaceAll("_", " ");

const emptyAttachments = (): AttachmentsByBasis => ({
  accepted: [], observed: [], inferred: [], conflicting: [],
});

const emptyRepositoryLinks = (): Record<RepositoryLinkBasis, RepositoryConnection[]> => ({
  accepted: [], observed: [], inferred: [], conflicting: [],
});

export const createProjectMapService = ({
  projectStore,
  repositoryStore,
  currentContextPackId = () => null,
}: ProjectMapServiceDependencies): ProjectMapService => {
  const readProject = (projectId: string) => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    const records = projectStore.listRecords(projectId);
    const relationships = projectStore.listRelationships(projectId);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    return { project, records, relationships, recordsById };
  };

  const acceptedRepository = (projectId: string) => {
    const snapshot = repositoryStore.getCurrentSnapshot(projectId);
    if (!snapshot || snapshot.projectId !== projectId || snapshot.state !== "accepted") {
      return { snapshot: null, observations: [], links: [] };
    }
    const observations = repositoryStore.listObservations(snapshot.id)
      .filter((item) => item.snapshotId === snapshot.id);
    const links = repositoryStore.listLinks(projectId)
      .filter((link) => link.projectId === projectId && link.snapshotId === snapshot.id);
    return { snapshot, observations, links };
  };

  const canonicalFilter = (filter: RepositoryExplorerFilter): string => JSON.stringify({
    ...(filter.search === undefined ? {} : { search: filter.search }),
    ...(filter.relevance === undefined ? {} : { relevance: filter.relevance }),
    ...(filter.changed === undefined ? {} : { changed: filter.changed }),
    ...(filter.category === undefined ? {} : { category: filter.category }),
    ...(filter.documentKind === undefined ? {} : { documentKind: filter.documentKind }),
    ...(filter.role === undefined ? {} : { role: filter.role }),
    ...(filter.unlinked === undefined ? {} : { unlinked: filter.unlinked }),
    ...(filter.contextIncluded === undefined ? {} : { contextIncluded: filter.contextIncluded }),
    ...(filter.state === undefined ? {} : { state: filter.state }),
    ...(filter.exclusionReason === undefined ? {} : { exclusionReason: filter.exclusionReason }),
  });

  const cursorSignature = (payload: string, repositoryIdentity: string): Buffer =>
    createHmac("sha256", repositoryIdentity)
      .update("intentarc:repository-explorer-cursor:v1\0")
      .update(payload)
      .digest();

  const encodeCursor = (
    payload: ExplorerCursorPayload,
    repositoryIdentity: string,
  ): string => {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = cursorSignature(encodedPayload, repositoryIdentity).toString("base64url");
    return `${encodedPayload}.${signature}`;
  };

  const decodeCursor = (
    cursor: string,
    repositoryIdentity: string,
  ): ExplorerCursorPayload => {
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new GovernanceError("validation_failed", "Repository Explorer cursor is invalid");
    }
    let supplied: Buffer;
    try {
      supplied = Buffer.from(parts[1], "base64url");
    } catch {
      throw new GovernanceError("validation_failed", "Repository Explorer cursor is invalid");
    }
    const expected = cursorSignature(parts[0], repositoryIdentity);
    if (
      supplied.toString("base64url") !== parts[1] ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new GovernanceError("validation_failed", "Repository Explorer cursor is invalid");
    }
    try {
      return explorerCursorPayloadSchema.parse(
        (() => {
          const decoded = Buffer.from(parts[0], "base64url");
          if (decoded.toString("base64url") !== parts[0]) throw new Error("non-canonical");
          return JSON.parse(decoded.toString("utf8"));
        })(),
      );
    } catch {
      throw new GovernanceError("validation_failed", "Repository Explorer cursor is invalid");
    }
  };

  const currentTaskId = (records: readonly ProjectRecord[]): string | null =>
    records
      .filter(({ kind, status }) =>
        kind === "task" && (status === "active" || status === "blocked"))
      .sort((left, right) =>
        compareStrings(left.status === "active" ? "0" : "1", right.status === "active" ? "0" : "1") ||
        compareStrings(right.updatedAt, left.updatedAt) ||
        compareStrings(left.id, right.id))[0]?.id ?? null;

  return {
    getProjectMap(projectId, selectedRecordId, scopeRecordId) {
      return projectStore.withReadSnapshot(() => {
        const { project, records, relationships, recordsById } = readProject(projectId);
        const hierarchyVocabulary = projectStore.getHierarchyVocabulary(projectId);
        const hierarchyRecords = records.filter((record) => hierarchyKinds.has(record.kind));
        if (hierarchyRecords.length > maximumParentCandidates) {
          throw new GovernanceError(
            "project_map_limit_exceeded",
            "Project map supports at most 10,000 hierarchy records.",
          );
        }

        const parentRelationships = relationships
          .filter((relationship) => relationship.kind === "parent_of")
          .filter((relationship) => {
            const parent = recordsById.get(relationship.fromRecordId);
            const child = recordsById.get(relationship.toRecordId);
            return Boolean(parent && child && hierarchyKinds.has(parent.kind) && hierarchyKinds.has(child.kind));
          })
          .sort(compareRelationships);
        const parentByChild = new Map<string, string>();
        const childrenByParent = new Map<string, ProjectRecord[]>();
        for (const relationship of parentRelationships) {
          const child = recordsById.get(relationship.toRecordId)!;
          if (parentByChild.has(child.id)) {
            throw new GovernanceError(
              "validation_failed",
              "A map hierarchy record cannot have more than one parent",
            );
          }
          parentByChild.set(child.id, relationship.fromRecordId);
          const children = childrenByParent.get(relationship.fromRecordId) ?? [];
          children.push(child);
          childrenByParent.set(relationship.fromRecordId, children);
        }
        for (const children of childrenByParent.values()) children.sort(compareRecords);
        const visited = new Set<string>();
        const active = new Set<string>();
        for (const record of [...hierarchyRecords].sort(compareRecords)) {
          if (visited.has(record.id)) continue;
          const stack: Array<{ id: string; nextChild: number }> = [{ id: record.id, nextChild: 0 }];
          active.add(record.id);
          while (stack.length > 0) {
            const frame = stack[stack.length - 1]!;
            const children = childrenByParent.get(frame.id) ?? [];
            if (frame.nextChild >= children.length) {
              active.delete(frame.id);
              visited.add(frame.id);
              stack.pop();
              continue;
            }
            const child = children[frame.nextChild]!;
            frame.nextChild += 1;
            if (active.has(child.id)) {
              throw new GovernanceError(
                "validation_failed",
                "Map hierarchy cannot contain a cycle",
              );
            }
            if (!visited.has(child.id)) {
              active.add(child.id);
              stack.push({ id: child.id, nextChild: 0 });
            }
          }
        }

        const roots = hierarchyRecords
          .filter((record) => record.kind === "outcome" && !parentByChild.has(record.id))
          .sort(compareRecords);
        const unplaced = hierarchyRecords
          .filter((record) => record.kind !== "outcome" && !parentByChild.has(record.id))
          .sort(compareRecords);
        const hierarchyNodes: ProjectMapHierarchyNode[] = [];
        for (const startingRecords of [roots, unplaced]) {
          const stack = [...startingRecords].reverse();
          while (stack.length > 0) {
            const record = stack.pop()!;
            const children = childrenByParent.get(record.id) ?? [];
            hierarchyNodes.push({
              ...summary(record),
              parentId: parentByChild.get(record.id) ?? null,
              childCount: children.length,
            });
            for (let index = children.length - 1; index >= 0; index -= 1) {
              stack.push(children[index]!);
            }
          }
        }

        const labeledEdge = (relationship: RecordRelationship): LabeledRecordEdge => {
          const from = recordsById.get(relationship.fromRecordId)!;
          const to = recordsById.get(relationship.toRecordId)!;
          return {
            id: relationship.id,
            kind: relationship.kind,
            label: edgeLabel(relationship.kind),
            fromRecordId: from.id,
            fromLabel: from.title,
            toRecordId: to.id,
            toLabel: to.title,
          };
        };
        const selected = selectedRecordId === undefined
          ? null
          : recordsById.get(selectedRecordId) ?? null;
        if (selectedRecordId !== undefined && (!selected || !hierarchyKinds.has(selected.kind))) {
          throw new GovernanceError(
            "validation_failed",
            "Map selection must be a hierarchy record in the requested project",
          );
        }
        const reversedSelectedPath: ProjectRecord[] = [];
        if (selected) {
          const seen = new Set<string>();
          let cursor: ProjectRecord | undefined = selected;
          while (cursor && !seen.has(cursor.id)) {
            seen.add(cursor.id);
            reversedSelectedPath.push(cursor);
            const parentId = parentByChild.get(cursor.id);
            cursor = parentId ? recordsById.get(parentId) : undefined;
          }
        }
        const selectedPath = reversedSelectedPath.reverse();
        const scope = scopeRecordId === undefined ? null : recordsById.get(scopeRecordId) ?? null;
        if (
          scopeRecordId !== undefined &&
          (!selected || !scope || !hierarchyKinds.has(scope.kind) ||
            !selectedPath.some((record) => record.id === scope.id))
        ) {
          throw new GovernanceError(
            "validation_failed",
            "Map scope must be the selected hierarchy record or one of its ancestors",
          );
        }
        const progressChildren = selected ? childrenByParent.get(selected.id) ?? [] : roots;
        const recordsWithEvidence = new Set<string>();
        for (const relationship of relationships) {
          if (relationship.kind !== "evidenced_by") continue;
          recordsWithEvidence.add(relationship.fromRecordId);
          recordsWithEvidence.add(relationship.toRecordId);
        }
        const childStatuses: Partial<Record<RecordStatus, number>> = {};
        let childrenWithEvidence = 0;
        for (const child of progressChildren) {
          childStatuses[child.status] = (childStatuses[child.status] ?? 0) + 1;
          if (recordsWithEvidence.has(child.id)) childrenWithEvidence += 1;
        }

        return {
          projectId,
          projectName: project.name,
          projectRevision: project.revision,
          hierarchyVocabulary,
          selectedRecordId: selected?.id ?? null,
          scopeRecordId: scope?.id ?? null,
          selectedPath: selectedPath.map(summary),
          hierarchyNodes,
          hierarchyEdges: parentRelationships.map(labeledEdge),
          unplacedRecordIds: unplaced.map(({ id }) => id),
          progress: {
            childStatuses,
            childrenWithEvidence,
            childCount: progressChildren.length,
          },
        };
      });
    },

    getRecordDetail(projectId, recordId) {
      return projectStore.withReadSnapshot(() => {
        const { project, relationships, recordsById } = readProject(projectId);
        const record = recordsById.get(recordId);
        if (!record) throw new RecordNotFoundError(recordId);
        const relations: FocusedRecordRelation[] = [];
        const seenEdges = new Set<string>();
        const firstLevelRecords = new Set<string>();
        const addRelation = (relationship: RecordRelationship, depth: 1 | 2, sourceId: string) => {
          if (seenEdges.has(relationship.id)) return;
          const otherId = relationship.fromRecordId === sourceId
            ? relationship.toRecordId
            : relationship.fromRecordId;
          const other = recordsById.get(otherId);
          const from = recordsById.get(relationship.fromRecordId);
          const to = recordsById.get(relationship.toRecordId);
          if (!other || !from || !to) return;
          seenEdges.add(relationship.id);
          if (depth === 1) firstLevelRecords.add(other.id);
          relations.push({
            depth,
            record: summary(other),
            edge: {
              id: relationship.id,
              kind: relationship.kind,
              label: edgeLabel(relationship.kind),
              fromRecordId: from.id,
              fromLabel: from.title,
              toRecordId: to.id,
              toLabel: to.title,
            },
          });
        };
        for (const relationship of relationships) {
          if (relationship.fromRecordId === record.id || relationship.toRecordId === record.id) {
            addRelation(relationship, 1, record.id);
          }
        }
        for (const relatedId of firstLevelRecords) {
          for (const relationship of relationships) {
            if (
              relationship.kind !== "parent_of" &&
              (relationship.fromRecordId === relatedId || relationship.toRecordId === relatedId)
            ) addRelation(relationship, 2, relatedId);
          }
        }
        relations.sort((left, right) =>
          left.depth - right.depth ||
          compareStrings(left.edge.kind, right.edge.kind) ||
          compareStrings(left.record.title, right.record.title) ||
          compareStrings(left.record.id, right.record.id) ||
          compareStrings(left.edge.id, right.edge.id)
        );

        const attachmentsByBasis = emptyAttachments();
        const repository = acceptedRepository(projectId);
        const observationsById = new Map(repository.observations.map((item) => [item.nodeId, item]));
        for (const link of repository.links) {
          if (link.toRecordId !== record.id) continue;
          const observation = observationsById.get(link.fromNodeId);
          if (!observation) continue;
          attachmentsByBasis[link.basis].push({
            linkId: link.id,
            nodeId: observation.nodeId,
            path: normalizedRepositoryPathSchema.parse(observation.path),
            nodeKind: observation.kind,
            linkKind: link.kind,
            linkLabel: edgeLabel(link.kind),
            basis: link.basis,
            documentKind: observation.documentKind,
            documentFormat: observation.documentFormat,
            role: observation.role,
          });
        }
        for (const basis of bases) {
          attachmentsByBasis[basis].sort((left, right) =>
            compareStrings(left.linkKind, right.linkKind) ||
            compareStrings(left.path, right.path) ||
            compareStrings(left.linkId, right.linkId)
          );
        }
        return { projectId, projectRevision: project.revision, record, relations, attachmentsByBasis };
      });
    },

    getRepositoryNodeDetail(projectId, nodeId) {
      return projectStore.withReadSnapshot(() => {
        const { recordsById } = readProject(projectId);
        const repository = acceptedRepository(projectId);
        const observation = repository.observations.find((item) => item.nodeId === nodeId);
        if (!repository.snapshot || !observation) {
          throw new GovernanceError("validation_failed", "Repository node not found");
        }
        const linksByBasis = emptyRepositoryLinks();
        const observationsById = new Map(repository.observations.map((item) => [item.nodeId, item]));
        for (const link of repository.links) {
          if (link.fromNodeId === nodeId && link.toRecordId) {
            const record = recordsById.get(link.toRecordId);
            if (!record) continue;
            linksByBasis[link.basis].push({
              linkId: link.id,
              kind: link.kind,
              label: edgeLabel(link.kind),
              basis: link.basis,
              record: summary(record),
              node: null,
            });
            continue;
          }
          const connectedNodeId = link.fromNodeId === nodeId
            ? link.toNodeId
            : link.toNodeId === nodeId
              ? link.fromNodeId
              : null;
          if (!connectedNodeId) continue;
          const connected = observationsById.get(connectedNodeId);
          if (!connected) continue;
          linksByBasis[link.basis].push({
            linkId: link.id,
            kind: link.kind,
            label: edgeLabel(link.kind),
            basis: link.basis,
            record: null,
            node: {
              nodeId: connected.nodeId,
              parentNodeId: connected.parentNodeId,
              path: normalizedRepositoryPathSchema.parse(connected.path),
              kind: connected.kind,
              role: connected.role,
              documentKind: connected.documentKind,
              documentFormat: connected.documentFormat,
              contentEligible: connected.contentEligible,
            },
          });
        }
        for (const basis of bases) {
          linksByBasis[basis].sort((left, right) =>
            compareStrings(left.kind, right.kind) ||
            compareStrings(left.record?.title ?? "", right.record?.title ?? "") ||
            compareStrings(
              left.record?.id ?? left.node?.nodeId ?? "",
              right.record?.id ?? right.node?.nodeId ?? "",
            ) ||
            compareStrings(left.linkId, right.linkId)
          );
        }
        return {
          projectId,
          snapshotId: repository.snapshot.id,
          node: {
            nodeId: observation.nodeId,
            parentNodeId: observation.parentNodeId,
            path: normalizedRepositoryPathSchema.parse(observation.path),
            kind: observation.kind,
            role: observation.role,
            documentKind: observation.documentKind,
            documentFormat: observation.documentFormat,
            contentEligible: observation.contentEligible,
          },
          linksByBasis,
        };
      });
    },

    getRepositoryTree(input) {
      const parsed = explorerRequestSchema.parse(input);
      return projectStore.withReadSnapshot(() => {
        const { project, records } = readProject(parsed.projectId);
        const parentNodeId = parsed.parentNodeId ?? null;
        const pageSize = parsed.pageSize ?? defaultExplorerPageSize;
        const parsedFilter = explorerFilterSchema.parse(parsed.filter ?? {});
        const filter = JSON.parse(canonicalFilter(
          parsedFilter as unknown as RepositoryExplorerFilter,
        )) as RepositoryExplorerFilter;
        const source = repositoryStore.getSource(parsed.projectId);
        const snapshot = repositoryStore.getCurrentSnapshot(parsed.projectId);
        const truthCurrentTaskId = currentTaskId(records);
        const truthContextPackId = currentContextPackId(parsed.projectId);
        const request = {
          parentNodeId,
          pageSize,
          filter,
        };
        if (
          !source || !snapshot || snapshot.projectId !== parsed.projectId ||
          snapshot.state !== "accepted" || source.currentSnapshotId !== snapshot.id
        ) {
          if (parsed.cursor !== undefined || parentNodeId !== null) {
            throw new GovernanceError("validation_failed", "Repository Explorer cursor is stale");
          }
          return {
            projectId: parsed.projectId,
            snapshotId: null,
            parentNodeId,
            sourceStatus: source?.status ?? null,
            request,
            items: [],
            exclusions: [],
            hasMore: false,
            nextCursor: null,
          };
        }

        const nodeSpecificExclusionFilter =
          filter.search !== undefined || filter.relevance !== undefined ||
          filter.changed !== undefined ||
          filter.category !== undefined || filter.documentKind !== undefined ||
          filter.role !== undefined || filter.unlinked !== undefined ||
          filter.contextIncluded !== undefined;
        const exclusions = exclusionReasons
          .map((reason) => ({ reason, count: snapshot.exclusionCounts[reason] ?? 0 }))
          .filter(({ reason, count }) =>
            count > 0 && !nodeSpecificExclusionFilter &&
            (filter.exclusionReason === undefined || filter.exclusionReason === reason));
        if (filter.state === "excluded") {
          if (parsed.cursor !== undefined) {
            throw new GovernanceError("validation_failed", "Repository Explorer cursor is invalid");
          }
          return {
            projectId: parsed.projectId,
            snapshotId: snapshot.id,
            parentNodeId,
            sourceStatus: source.status,
            request,
            items: [],
            exclusions,
            hasMore: false,
            nextCursor: null,
          };
        }

        if (parentNodeId !== null) {
          const parent = repositoryStore.getObservation(snapshot.id, parentNodeId);
          if (
            !parent || parent.snapshotId !== snapshot.id ||
            parent.nodeId !== parentNodeId || parent.kind !== "directory"
          ) {
            throw new GovernanceError("validation_failed", "Repository Explorer parent was not found");
          }
        }

        const filterKey = canonicalFilter(filter);
        let after: RepositoryExplorerStoreCursor | undefined;
        if (parsed.cursor !== undefined) {
          const cursor = decodeCursor(parsed.cursor, source.repositoryIdentity);
          if (
            cursor.projectId !== parsed.projectId ||
            cursor.snapshotId !== snapshot.id ||
            cursor.parentNodeId !== parentNodeId ||
            cursor.pageSize !== pageSize ||
            cursor.filterKey !== filterKey ||
            cursor.contextPackId !== truthContextPackId ||
            cursor.currentTaskId !== truthCurrentTaskId ||
            cursor.sourceStatus !== source.status ||
            cursor.projectRevision !== project.revision
          ) {
            throw new GovernanceError("validation_failed", "Repository Explorer cursor is stale");
          }
          after = { kind: cursor.kind, path: cursor.path, nodeId: cursor.nodeId };
        }
        const rows = repositoryStore.listExplorerChildren({
          projectId: parsed.projectId,
          snapshotId: snapshot.id,
          parentNodeId,
          limit: pageSize + 1,
          ...(after === undefined ? {} : { after }),
          currentTaskId: truthCurrentTaskId,
          contextPackId: truthContextPackId,
          filter,
        });
        const visibleRows = rows.slice(0, pageSize);
        const state: RepositoryExplorerNode["state"] = source.status === "available"
          ? "current"
          : source.status === "detached"
            ? "stale"
            : "unavailable";
        const items = visibleRows.map(({ observation, ...facts }) => {
          if (
            observation.snapshotId !== snapshot.id ||
            observation.parentNodeId !== parentNodeId
          ) {
            throw new GovernanceError("internal_error", "Repository Explorer store response is unbound");
          }
          return {
            nodeId: observation.nodeId,
            parentNodeId: observation.parentNodeId,
            path: normalizedRepositoryPathSchema.parse(observation.path),
            kind: observation.kind,
            role: observation.role,
            documentKind: observation.documentKind,
            documentFormat: observation.documentFormat,
            sourceStatus: observation.sourceStatus,
            state,
            contentEligible: observation.contentEligible,
            childCount: facts.childCount,
            changed: facts.changed,
            linked: facts.linked,
            currentTaskRelevant: facts.currentTaskRelevant,
            contextIncluded: facts.contextIncluded,
          };
        });
        const hasMore = rows.length > pageSize;
        const last = hasMore ? items.at(-1) : undefined;
        const nextCursor = last === undefined
          ? null
          : encodeCursor({
              v: explorerCursorVersion,
              projectId: parsed.projectId,
              snapshotId: snapshot.id,
              parentNodeId,
              pageSize,
              filterKey,
              contextPackId: truthContextPackId,
              currentTaskId: truthCurrentTaskId,
              sourceStatus: source.status,
              projectRevision: project.revision,
              kind: last.kind,
              path: last.path,
              nodeId: last.nodeId,
            }, source.repositoryIdentity);
        return {
          projectId: parsed.projectId,
          snapshotId: snapshot.id,
          parentNodeId,
          sourceStatus: source.status,
          request,
          items,
          exclusions,
          hasMore,
          nextCursor,
        };
      });
    },
  };
};
