import { z } from "zod";
import {
  GovernanceError,
  ProjectNotFoundError,
  type ProjectRecord,
  type RecordRelationship,
  type RecordStatus,
  type SourceKind,
} from "../domain/index.js";
import { RecordNotFoundError } from "../domain/errors.js";
import type {
  GovernanceStore,
} from "../storage/governance-store.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import {
  canonicalizeIdeaCaptureText,
  computeIdeaCaptureRequestHash,
  IDEA_CAPTURE_OPERATION_SCOPE,
  MAX_IDEA_CODE_POINTS,
  MAX_IDEA_TITLE_CODE_POINTS,
  parseStoredHumanChangeReplay,
  serializeIdeaCaptureReplayPayload,
} from "../storage/human-change-replay.js";

export { MAX_IDEA_CODE_POINTS, MAX_IDEA_TITLE_CODE_POINTS };
export const MAX_IDEA_PREVIEW_CODE_POINTS = 280;

export interface IdeaContextSummary {
  id: string;
  kind: "task" | "component";
  title: string;
  status: RecordStatus;
}

export interface IdeaInboxItem {
  id: string;
  projectId: string;
  revision: number;
  status: RecordStatus;
  title: string;
  bodyPreview: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  context: IdeaContextSummary[];
}

export interface CaptureIdeaInput {
  projectId: string;
  expectedProjectRevision: number;
  captureRequestId: string;
  text: string;
  contextRecordIds?: readonly string[];
}

export interface CaptureIdeaResult {
  projectRevision: number;
  item: IdeaInboxItem;
}

export interface IdeaInboxInput {
  projectId: string;
  limit?: number;
  cursor?: string;
}

export interface IdeaInboxPage {
  projectId: string;
  projectRevision: number;
  items: IdeaInboxItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface IdeaDetailInput {
  projectId: string;
  ideaId: string;
}

export interface IdeaDetail {
  id: string;
  projectId: string;
  revision: number;
  status: RecordStatus;
  title: string;
  body: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  context: IdeaContextSummary[];
}

export class IdeaContextInvalidError extends Error {
  constructor() {
    super("Idea context is invalid");
    this.name = "IdeaContextInvalidError";
  }
}

export class IdeaServiceUnavailableError extends Error {
  constructor() {
    super("The idea service is temporarily unavailable.");
    this.name = "IdeaServiceUnavailableError";
  }
}

const codePoints = (value: string): string[] => Array.from(value);

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const normalizeIdeaText = (raw: string): { title: string; body: string } => {
  try {
    return canonicalizeIdeaCaptureText(raw);
  } catch {
    throw new GovernanceError("validation_failed", "Idea text is invalid");
  }
};

export const previewIdeaBody = (body: string): string => {
  const points = codePoints(body);
  return points.length <= MAX_IDEA_PREVIEW_CODE_POINTS
    ? body
    : `${points.slice(0, MAX_IDEA_PREVIEW_CODE_POINTS - 1).join("")}…`;
};

const captureIdeaInputSchema = z.object({
  projectId: z.string().trim().min(1).max(512),
  expectedProjectRevision: z.number().int().nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  captureRequestId: z.string().trim().min(1).max(128),
  text: z.string(),
  contextRecordIds: z.array(z.string().trim().min(1).max(512))
    .max(100)
    .optional(),
}).strict();

const ideaInboxInputSchema = z.object({
  projectId: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
}).strict();

const ideaDetailInputSchema = z.object({
  projectId: z.string().trim().min(1).max(512),
  ideaId: z.string().trim().min(1).max(512),
}).strict();

const ideaInboxCursorSchema = z.object({
  v: z.literal(1),
  projectId: z.string().trim().min(1).max(512),
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().trim().min(1).max(512),
}).strict();

type IdeaInboxCursor = z.infer<typeof ideaInboxCursorSchema>;

const isUnavailableSqliteError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_READONLY" ||
    code === "SQLITE_IOERR" ||
    code === "SQLITE_FULL" ||
    code === "SQLITE_CANTOPEN" ||
    code === "SQLITE_PROTOCOL" ||
    code.startsWith("SQLITE_LOCKED_") ||
    code.startsWith("SQLITE_READONLY_") ||
    code.startsWith("SQLITE_IOERR_")
  );
};

const withIdeaServiceAvailability = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (isUnavailableSqliteError(error)) throw new IdeaServiceUnavailableError();
    throw error;
  }
};

const invalidInboxCursor = (): never => {
  throw new GovernanceError("validation_failed", "Idea inbox cursor is invalid");
};

const encodeInboxCursor = (cursor: IdeaInboxCursor): string => Buffer.from(
  JSON.stringify({
    v: cursor.v,
    projectId: cursor.projectId,
    createdAt: cursor.createdAt,
    id: cursor.id,
  }),
  "utf8",
).toString("base64url");

const decodeInboxCursor = (encoded: string): IdeaInboxCursor => {
  try {
    const cursor = ideaInboxCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (encodeInboxCursor(cursor) !== encoded) invalidInboxCursor();
    return cursor;
  } catch {
    return invalidInboxCursor();
  }
};

const ideaContextSummary = (record: ProjectRecord): IdeaContextSummary => {
  if (record.kind !== "task" && record.kind !== "component") {
    throw new GovernanceError("internal_error", "Idea context result is invalid");
  }
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
  };
};

const qualifyingIdeaContext = (
  ideaId: string,
  recordsById: ReadonlyMap<string, ProjectRecord>,
  relationships: readonly RecordRelationship[],
): ProjectRecord[] => {
  const targetIds = new Set<string>();
  for (const relationship of relationships) {
    if (relationship.fromRecordId === ideaId && relationship.kind === "related_to") {
      targetIds.add(relationship.toRecordId);
    }
  }
  return [...targetIds]
    .map((targetId) => recordsById.get(targetId))
    .filter((target): target is ProjectRecord =>
      target !== undefined && (target.kind === "task" || target.kind === "component"),
    )
    .sort((left, right) => compareText(left.kind, right.kind)
      || compareText(left.title, right.title)
      || compareText(left.id, right.id));
};

const ideaItem = (
  record: ProjectRecord,
  context: readonly IdeaContextSummary[],
): IdeaInboxItem => {
  if (record.kind !== "idea") {
    throw new GovernanceError("internal_error", "Idea result is invalid");
  }
  return {
    id: record.id,
    projectId: record.projectId,
    revision: record.revision,
    status: record.status,
    title: record.title,
    bodyPreview: previewIdeaBody(record.body),
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    context: [...context],
  };
};

export interface IdeaService {
  capture(input: CaptureIdeaInput): CaptureIdeaResult;
  listInbox(input: IdeaInboxInput): IdeaInboxPage;
  getDetail(input: IdeaDetailInput): IdeaDetail;
}

export interface IdeaServiceDependencies {
  projectStore: Pick<
    ProjectReadStore,
    "withReadSnapshot" | "getProject" | "listRecords" | "listRelationships"
  >;
  governanceStore: Pick<GovernanceStore, "applyHumanChange">;
  now: () => string;
}

export const createIdeaService = ({
  projectStore,
  governanceStore,
  now,
}: IdeaServiceDependencies): IdeaService => ({
  capture(raw) {
    const input = captureIdeaInputSchema.parse(raw);
    return withIdeaServiceAvailability(() => {
      const normalized = normalizeIdeaText(input.text);
      const contextIds = [...new Set(input.contextRecordIds ?? [])];
      const context = projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);
      const byId = new Map(
        projectStore.listRecords(input.projectId).map((record) => [record.id, record]),
      );
      return contextIds.map((id) => {
        const record = byId.get(id);
        if (!record || (record.kind !== "task" && record.kind !== "component")) {
          throw new IdeaContextInvalidError();
        }
        return record;
      });
      });
      const contextSummary = context.map(ideaContextSummary);
      const replayContext = contextSummary.map((summary) => ({
        projectId: input.projectId,
        ...summary,
      }));
      const requestHash = computeIdeaCaptureRequestHash({
        projectId: input.projectId,
        expectedProjectRevision: input.expectedProjectRevision,
        body: normalized.body,
        contextRecordIds: contextIds,
      });
      const replayPayloadJson = serializeIdeaCaptureReplayPayload({
        projectId: input.projectId,
        operationScope: IDEA_CAPTURE_OPERATION_SCOPE,
        idempotencyKey: input.captureRequestId,
        requestHash,
      }, replayContext);
      const applied = governanceStore.applyHumanChange({
        projectId: input.projectId,
        expectedProjectRevision: input.expectedProjectRevision,
        rationale: "Capture project idea",
        operations: [{
          operationId: "human-capture-idea",
          type: "create_record",
          localRef: "captured-idea",
          kind: "idea",
          status: "provisional",
          title: normalized.title,
          body: normalized.body,
          sourceKind: "human",
          sourceRef: "web:idea-capture",
        }, ...context.map((record, index) => ({
          operationId: `human-link-idea-context-${index + 1}`,
          type: "create_relationship" as const,
          from: { localRef: "captured-idea" },
          to: { recordId: record.id },
          kind: "related_to" as const,
        }))],
        completedAt: now(),
        idempotency: {
          operationScope: IDEA_CAPTURE_OPERATION_SCOPE,
          key: input.captureRequestId,
          requestHash,
          replayPayloadJson,
        },
      });
      let validatedReplay;
      try {
        validatedReplay = parseStoredHumanChangeReplay({
          projectId: input.projectId,
          operationScope: IDEA_CAPTURE_OPERATION_SCOPE,
          idempotencyKey: input.captureRequestId,
          requestHash,
          resultJson: JSON.stringify(applied),
        });
      } catch {
        throw new GovernanceError(
          "internal_error",
          "Idea capture result is invalid",
        );
      }
      const result = validatedReplay.result;
      const created = result.operations[0];
      if (
        result.projectId !== input.projectId ||
        created?.type !== "create_record"
      ) {
        throw new GovernanceError(
          "internal_error",
          "Idea capture result is invalid",
        );
      }
      return {
        projectRevision: result.revisionAfter,
        item: ideaItem(
          created.record,
          validatedReplay.context.map(({ projectId: _projectId, ...summary }) =>
            summary
          ),
        ),
      };
    });
  },

  listInbox(raw) {
    const input = ideaInboxInputSchema.parse(raw);
    return withIdeaServiceAvailability(() => projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);
      const cursor = input.cursor === undefined ? null : decodeInboxCursor(input.cursor);
      if (cursor && cursor.projectId !== project.id) invalidInboxCursor();
      const recordsById = new Map(
        projectStore.listRecords(project.id).map((record) => [record.id, record]),
      );
      const ideas = [...recordsById.values()]
        .filter((record) => record.kind === "idea")
        .sort((left, right) => compareText(right.createdAt, left.createdAt)
          || compareText(right.id, left.id));
      const afterCursor = cursor === null
        ? ideas
        : ideas.filter((record) => record.createdAt < cursor.createdAt
          || (record.createdAt === cursor.createdAt && record.id < cursor.id));
      const limit = input.limit ?? 25;
      const candidates = afterCursor.slice(0, limit + 1);
      const hasMore = candidates.length > limit;
      const pageRecords = candidates.slice(0, limit);
      const relationships = projectStore.listRelationships(project.id);
      const items = pageRecords.map((record) => {
        const context = qualifyingIdeaContext(record.id, recordsById, relationships);
        return ideaItem(record, context.map(ideaContextSummary));
      });
      const finalItem = items.at(-1);

      return {
        projectId: project.id,
        projectRevision: project.revision,
        items,
        hasMore,
        nextCursor: hasMore && finalItem
          ? encodeInboxCursor({
            v: 1,
            projectId: project.id,
            createdAt: finalItem.createdAt,
            id: finalItem.id,
          })
          : null,
      };
    }));
  },

  getDetail(raw) {
    const input = ideaDetailInputSchema.parse(raw);
    return withIdeaServiceAvailability(() => projectStore.withReadSnapshot(() => {
      const project = projectStore.getProject(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);
      const records = projectStore.listRecords(project.id);
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const record = recordsById.get(input.ideaId);
      if (!record || record.kind !== "idea") throw new RecordNotFoundError(input.ideaId);
      const context = qualifyingIdeaContext(
        record.id,
        recordsById,
        projectStore.listRelationships(project.id),
      );
      return {
        id: record.id,
        projectId: record.projectId,
        revision: record.revision,
        status: record.status,
        title: record.title,
        body: record.body,
        sourceKind: record.sourceKind,
        sourceRef: record.sourceRef,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        context: context.map(ideaContextSummary),
      };
    }));
  },
});
