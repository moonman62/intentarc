import {
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  type ContextItem,
  type ProjectRecord,
  type RecordKind,
  type RecordRelationship,
  type RecordStatus,
  type RelationshipKind,
  type TaskContextPack,
} from "../domain/index.js";
import type { ContextPackStore } from "../storage/context-pack-store.js";
import type { ProjectReadStore } from "../storage/project-store.js";

export interface GetTaskContextInput {
  projectId: string;
  taskId: string;
  budgetTokens: number;
}

export interface ContextService {
  getTaskContext(input: GetTaskContextInput): TaskContextPack;
}

export interface ContextServiceDependencies {
  projectStore: ProjectReadStore;
  contextPackStore: ContextPackStore;
  now: () => string;
  newId: () => string;
  estimateTokens: (text: string) => number;
}

const stableFrameKindOrder: readonly RecordKind[] = [
  "vision",
  "outcome",
  "constraint",
  "non_goal",
];

const relationshipKindRanks = {
  decided_by: 0,
  evidenced_by: 1,
  implements: 2,
  depends_on: 3,
  constrained_by: 4,
  parent_of: 5,
  related_to: 6,
} satisfies Record<RelationshipKind, number>;

const relatedStatuses = new Set<RecordStatus>([
  "accepted",
  "active",
  "provisional",
  "blocked",
  "completed",
]);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableFrameKindRank = (kind: RecordKind): number =>
  stableFrameKindOrder.indexOf(kind);

const relationshipKindRank = (kind: RelationshipKind): number =>
  relationshipKindRanks[kind];

const createContextItem = (
  record: ProjectRecord,
  mandatory: boolean,
  relevance: ContextItem["relevance"],
  relationshipKind: RelationshipKind | null,
): ContextItem => ({
  record,
  mandatory,
  relevance,
  relationshipKind,
});

export const estimateContextItemTokens = (
  item: ContextItem,
  estimateTokens: (text: string) => number,
): number => estimateTokens(`${item.record.title}\n${item.record.body}`);

type RelatedCandidate = {
  record: ProjectRecord;
  relationshipKind: RelationshipKind;
};

const linkedRecordId = (
  relationship: RecordRelationship,
  taskId: string,
): string =>
  relationship.fromRecordId === taskId
    ? relationship.toRecordId
    : relationship.fromRecordId;

export const createContextService = ({
  projectStore,
  contextPackStore,
  now,
  newId,
  estimateTokens,
}: ContextServiceDependencies): ContextService => ({
  getTaskContext(input: GetTaskContextInput): TaskContextPack {
    const pack = projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(input.projectId);

      if (!project) {
        throw new ProjectNotFoundError(input.projectId);
      }

      const hierarchyVocabulary = projectStore.getHierarchyVocabulary(
        project.id,
      );

      const task = projectStore.getRecord(input.projectId, input.taskId);

      if (!task) {
        throw new RecordNotFoundError(input.taskId);
      }

      if (task.kind !== "task") {
        throw new InvalidTaskError(task.id);
      }

      const stableFrame = projectStore
        .listRecords(project.id)
        .filter(
          (record) =>
            record.status === "accepted" &&
            stableFrameKindOrder.includes(record.kind),
        )
        .sort(
          (left, right) =>
            stableFrameKindRank(left.kind) - stableFrameKindRank(right.kind) ||
            compareStrings(left.id, right.id),
        )
        .map((record) =>
          createContextItem(record, true, "stable_frame", null),
        );
      const taskItem = createContextItem(task, true, "active_task", null);
      const mandatoryRecordIds = new Set([
        task.id,
        ...stableFrame.map((item) => item.record.id),
      ]);
      const candidatesByRecordId = new Map<string, RelatedCandidate>();

      for (const relationship of projectStore.listRelationshipsForRecord(
        project.id,
        task.id,
      )) {
        const recordId = linkedRecordId(relationship, task.id);

        if (mandatoryRecordIds.has(recordId)) {
          continue;
        }

        const record = projectStore.getRecord(project.id, recordId);

        if (!record || !relatedStatuses.has(record.status)) {
          continue;
        }

        const current = candidatesByRecordId.get(record.id);

        if (
          !current ||
          relationshipKindRank(relationship.kind) <
            relationshipKindRank(current.relationshipKind)
        ) {
          candidatesByRecordId.set(record.id, {
            record,
            relationshipKind: relationship.kind,
          });
        }
      }

      const candidates = [...candidatesByRecordId.values()].sort(
        (left, right) =>
          relationshipKindRank(left.relationshipKind) -
            relationshipKindRank(right.relationshipKind) ||
          compareStrings(left.record.kind, right.record.kind) ||
          compareStrings(left.record.id, right.record.id),
      );
      const related: ContextItem[] = [];
      const omissions: TaskContextPack["omissions"] = [];
      let estimatedTokens = [...stableFrame, taskItem].reduce(
        (total, item) =>
          total + estimateContextItemTokens(item, estimateTokens),
        0,
      );

      for (const candidate of candidates) {
        const item = createContextItem(
          candidate.record,
          false,
          "linked",
          candidate.relationshipKind,
        );
        const candidateTokens = estimateContextItemTokens(item, estimateTokens);

        if (estimatedTokens + candidateTokens <= input.budgetTokens) {
          related.push(item);
          estimatedTokens += candidateTokens;
          continue;
        }

        omissions.push({
          recordId: candidate.record.id,
          kind: candidate.record.kind,
          reason: "budget",
          retrievalRef: `intentarc://projects/${project.id}/records/${candidate.record.id}`,
        });
      }

      const includedItems = [...stableFrame, taskItem, ...related];

      return {
        id: newId(),
        projectId: project.id,
        taskId: task.id,
        projectRevision: project.revision,
        generatedAt: now(),
        budgetTokens: input.budgetTokens,
        estimatedTokens,
        hierarchyVocabulary,
        stableFrame,
        task: taskItem,
        related,
        omissions,
        sourceRevisions: includedItems
          .map((item) => ({
            recordId: item.record.id,
            revision: item.record.revision,
          }))
          .sort((left, right) => compareStrings(left.recordId, right.recordId)),
      } satisfies TaskContextPack;
    });

    contextPackStore.save(pack);
    return pack;
  },
});
