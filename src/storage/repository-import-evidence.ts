import { createHash } from "node:crypto";
import { z } from "zod";
import {
  relationshipKindSchema,
  type ProjectRecord,
  type RecordRelationship,
} from "../domain/index.js";

const canonicalIdentifierSchema = z.string().min(1).refine(
  (value) => value === value.trim(),
);

const snapshotRelationshipSchema = z.object({
  id: canonicalIdentifierSchema,
  fromRecordId: canonicalIdentifierSchema,
  toRecordId: canonicalIdentifierSchema,
  kind: relationshipKindSchema,
}).strict().refine(
  ({ fromRecordId, toRecordId }) => fromRecordId !== toRecordId,
  { path: ["toRecordId"], message: "Snapshot relationships cannot self-link" },
);

export const initialRepositorySnapshotSchema = z.object({
  version: z.literal(1),
  projectId: canonicalIdentifierSchema,
  recordIds: z.array(canonicalIdentifierSchema),
  relationships: z.array(snapshotRelationshipSchema),
}).strict().superRefine((snapshot, context) => {
  const recordIds = new Set(snapshot.recordIds);
  if (recordIds.size !== snapshot.recordIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordIds"],
      message: "Initial record IDs must be unique",
    });
  }
  const relationshipIds = new Set<string>();
  const relationshipTuples = new Set<string>();
  snapshot.relationships.forEach((relationship, index) => {
    if (relationshipIds.has(relationship.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationships", index, "id"],
        message: "Initial relationship IDs must be unique",
      });
    }
    relationshipIds.add(relationship.id);
    const tuple =
      `${relationship.fromRecordId}\0${relationship.toRecordId}\0${relationship.kind}`;
    if (relationshipTuples.has(tuple)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationships", index],
        message: "Initial relationship tuples must be unique",
      });
    }
    relationshipTuples.add(tuple);
    if (
      !recordIds.has(relationship.fromRecordId) ||
      !recordIds.has(relationship.toRecordId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationships", index],
        message: "Initial relationships must reference initial records",
      });
    }
  });
  const sortedRecordIds = [...snapshot.recordIds].sort();
  if (
    sortedRecordIds.some((recordId, index) =>
      recordId !== snapshot.recordIds[index]
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordIds"],
      message: "Initial record IDs must use canonical order",
    });
  }
  const sortedRelationships = [...snapshot.relationships].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  if (
    sortedRelationships.some((relationship, index) =>
      relationship !== snapshot.relationships[index]
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relationships"],
      message: "Initial relationships must use canonical order",
    });
  }
});

export type InitialRepositorySnapshot = z.infer<
  typeof initialRepositorySnapshotSchema
>;

export const createInitialRepositorySnapshot = (
  projectId: string,
  records: readonly ProjectRecord[],
  relationships: readonly RecordRelationship[],
): InitialRepositorySnapshot =>
  initialRepositorySnapshotSchema.parse({
    version: 1,
    projectId,
    recordIds: records.map(({ id }) => id).sort(),
    relationships: relationships
      .map(({ id, fromRecordId, toRecordId, kind }) => ({
        id,
        fromRecordId,
        toRecordId,
        kind,
      }))
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ),
  });

export const serializeInitialRepositorySnapshot = (
  snapshot: InitialRepositorySnapshot,
): { readonly json: string; readonly digest: string } => {
  const parsed = initialRepositorySnapshotSchema.parse(snapshot);
  const json = JSON.stringify(parsed);
  return {
    json,
    digest: createHash("sha256").update(json, "utf8").digest("hex"),
  };
};

export const parseInitialRepositorySnapshot = (
  json: string,
  expectedDigest: string,
): InitialRepositorySnapshot | null => {
  try {
    const parsed = initialRepositorySnapshotSchema.parse(
      JSON.parse(json) as unknown,
    );
    const serialized = serializeInitialRepositorySnapshot(parsed);
    return serialized.json === json && serialized.digest === expectedDigest
      ? parsed
      : null;
  } catch {
    return null;
  }
};
