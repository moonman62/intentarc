import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  projectRecordSchema,
  recordRelationshipSchema,
  recordStatusSchema,
} from "../domain/index.js";

export const IDEA_CAPTURE_OPERATION_SCOPE = "idea_capture";
export const MAX_IDEA_CODE_POINTS = 16_384;
export const MAX_IDEA_TITLE_CODE_POINTS = 160;
export const MAX_HUMAN_CHANGE_IDEMPOTENCY_KEY_LENGTH = 128;

const codePoints = (value: string): string[] => Array.from(value);

export const canonicalizeIdeaCaptureText = (
  raw: string,
): { title: string; body: string } => {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  const points = codePoints(body);
  if (points.length === 0 || points.length > MAX_IDEA_CODE_POINTS) {
    throw new Error("Idea text is invalid");
  }
  const first = body.split("\n").find((line) => line.trim().length > 0)!.trim();
  const titlePoints = codePoints(first);
  const title = titlePoints.length <= MAX_IDEA_TITLE_CODE_POINTS
    ? first
    : `${titlePoints.slice(0, MAX_IDEA_TITLE_CODE_POINTS - 1).join("")}…`;
  return { title, body };
};

export const computeIdeaCaptureRequestHash = (input: {
  projectId: string;
  expectedProjectRevision: number;
  body: string;
  contextRecordIds: readonly string[];
}): string => createHash("sha256").update(JSON.stringify({
  v: 1,
  projectId: input.projectId,
  expectedProjectRevision: input.expectedProjectRevision,
  body: input.body,
  contextRecordIds: [...input.contextRecordIds],
})).digest("hex");

const canonicalString = z.string().min(1).refine(
  (value) => value === value.trim(),
  "Stored replay metadata must be canonical",
);
const canonicalProjectIdSchema = canonicalString.max(512);
const canonicalIdempotencyKeySchema = canonicalString.max(
  MAX_HUMAN_CHANGE_IDEMPOTENCY_KEY_LENGTH,
);
const requestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ideaCaptureIdempotencySchema = z.object({
  operationScope: z.literal(IDEA_CAPTURE_OPERATION_SCOPE),
  key: canonicalIdempotencyKeySchema,
  requestHash: requestHashSchema,
  replayPayloadJson: z.string(),
}).strict();

const storedHumanChangeResultSchema = z.object({
  outcome: z.literal("applied"),
  projectId: canonicalProjectIdSchema,
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().nonnegative(),
  replayPayloadJson: z.string(),
  operations: z.array(z.discriminatedUnion("type", [
    z.object({
      operationId: canonicalString,
      type: z.literal("create_record"),
      record: projectRecordSchema,
    }).strict(),
    z.object({
      operationId: canonicalString,
      type: z.literal("update_record"),
      record: projectRecordSchema,
    }).strict(),
    z.object({
      operationId: canonicalString,
      type: z.literal("create_relationship"),
      relationship: recordRelationshipSchema,
    }).strict(),
    z.object({
      operationId: canonicalString,
      type: z.literal("remove_relationship"),
      relationship: recordRelationshipSchema,
    }).strict(),
  ])).min(1),
}).strict();

const ideaContextReplaySchema = z.array(z.object({
  projectId: canonicalProjectIdSchema,
  id: canonicalString.max(512),
  kind: z.enum(["task", "component"]),
  title: z.string().min(1),
  status: recordStatusSchema,
}).strict()).max(100);

const storedHumanChangeReplayMetadataSchema = z.object({
  projectId: canonicalProjectIdSchema,
  operationScope: z.literal(IDEA_CAPTURE_OPERATION_SCOPE),
  idempotencyKey: canonicalIdempotencyKeySchema,
  requestHash: requestHashSchema,
}).strict();

const ideaContextReplayEnvelopeSchema = z.object({
  v: z.literal(1),
  context: ideaContextReplaySchema,
  semanticHash: requestHashSchema,
}).strict();

export type StoredHumanChangeResult = z.infer<
  typeof storedHumanChangeResultSchema
>;
export type StoredIdeaCaptureContext = z.infer<
  typeof ideaContextReplaySchema
>;

export interface StoredHumanChangeReplay {
  projectId: string;
  operationScope: string;
  idempotencyKey: string;
  requestHash: string;
  resultJson: string;
}

export interface ValidatedIdeaCaptureReplay {
  result: StoredHumanChangeResult;
  context: StoredIdeaCaptureContext;
}

type StoredHumanChangeReplayMetadata = z.infer<
  typeof storedHumanChangeReplayMetadataSchema
>;

const computeIdeaCaptureContextSemanticHash = (
  metadata: StoredHumanChangeReplayMetadata,
  context: StoredIdeaCaptureContext,
): string => createHash("sha256").update(JSON.stringify({
  v: 1,
  projectId: metadata.projectId,
  operationScope: metadata.operationScope,
  idempotencyKey: metadata.idempotencyKey,
  requestHash: metadata.requestHash,
  context,
})).digest("hex");

export const serializeIdeaCaptureReplayPayload = (
  rawMetadata: StoredHumanChangeReplayMetadata,
  rawContext: StoredIdeaCaptureContext,
): string => {
  const metadata = storedHumanChangeReplayMetadataSchema.parse(rawMetadata);
  const context = ideaContextReplaySchema.parse(rawContext);
  if (!isDeepStrictEqual(rawContext, context)) {
    throw new Error("Idea capture replay context is not canonical");
  }
  return JSON.stringify({
    v: 1,
    context,
    semanticHash: computeIdeaCaptureContextSemanticHash(metadata, context),
  });
};

export const parseStoredHumanChangeReplay = (
  row: StoredHumanChangeReplay,
): ValidatedIdeaCaptureReplay => {
  const metadata = storedHumanChangeReplayMetadataSchema.parse({
    projectId: row.projectId,
    operationScope: row.operationScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
  });
  const rawResult: unknown = JSON.parse(row.resultJson);
  const result = storedHumanChangeResultSchema.parse(rawResult);
  if (!isDeepStrictEqual(rawResult, result)) {
    throw new Error("Stored idea capture result is not canonical");
  }
  const rawReplayPayload: unknown = JSON.parse(result.replayPayloadJson);
  const replayPayload = ideaContextReplayEnvelopeSchema.parse(rawReplayPayload);
  if (
    !isDeepStrictEqual(rawReplayPayload, replayPayload) ||
    replayPayload.semanticHash !== computeIdeaCaptureContextSemanticHash(
      metadata,
      replayPayload.context,
    )
  ) {
    throw new Error("Stored idea capture replay context is invalid");
  }
  const context = replayPayload.context;
  const created = result.operations[0];
  if (
    result.projectId !== metadata.projectId ||
    result.revisionAfter !== result.revisionBefore + 1 ||
    created?.type !== "create_record" ||
    created.operationId !== "human-capture-idea"
  ) {
    throw new Error("Stored idea capture result ownership is invalid");
  }
  const idea = created.record;
  const normalized = canonicalizeIdeaCaptureText(idea.body);
  if (
    idea.projectId !== metadata.projectId ||
    idea.kind !== "idea" ||
    idea.status !== "provisional" ||
    idea.sourceKind !== "human" ||
    idea.sourceRef !== "web:idea-capture" ||
    idea.revision !== 1 ||
    normalized.body !== idea.body ||
    normalized.title !== idea.title ||
    result.operations.length !== context.length + 1
  ) {
    throw new Error("Stored idea capture record is invalid");
  }
  const seenContextIds = new Set<string>();
  for (const [index, summary] of context.entries()) {
    const operation = result.operations[index + 1];
    if (
      summary.projectId !== metadata.projectId ||
      seenContextIds.has(summary.id) ||
      operation?.type !== "create_relationship" ||
      operation.operationId !== `human-link-idea-context-${index + 1}` ||
      operation.relationship.projectId !== metadata.projectId ||
      operation.relationship.kind !== "related_to" ||
      operation.relationship.fromRecordId !== idea.id ||
      operation.relationship.toRecordId !== summary.id
    ) {
      throw new Error("Stored idea capture context is invalid");
    }
    seenContextIds.add(summary.id);
  }
  const computedHash = computeIdeaCaptureRequestHash({
    projectId: metadata.projectId,
    expectedProjectRevision: result.revisionBefore,
    body: idea.body,
    contextRecordIds: context.map(({ id }) => id),
  });
  if (metadata.requestHash !== computedHash) {
    throw new Error("Stored idea capture request hash is invalid");
  }
  return { result, context };
};
