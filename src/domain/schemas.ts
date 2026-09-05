import { z } from "zod";
import type {
  HierarchyVocabulary,
  RecordKind,
  RecordStatus,
  RelationshipKind,
  SourceKind,
} from "./model.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const sourceReferenceSchema = nonEmptyStringSchema;

export const recordKindSchema: z.ZodType<RecordKind> = z.enum([
  "vision",
  "outcome",
  "initiative",
  "deliverable",
  "constraint",
  "non_goal",
  "milestone",
  "task",
  "decision",
  "component",
  "evidence",
  "risk",
  "question",
  "exclusion",
  "idea",
]);

const hierarchyLabelSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((label) => label === label.trim(), {
    message: "Hierarchy labels must not have leading or trailing whitespace",
  })
  .refine((label) => !/[\u0000-\u001F\u007F-\u009F]/.test(label), {
    message: "Hierarchy labels must not contain control characters",
  });

export const hierarchyVocabularySchema: z.ZodType<HierarchyVocabulary> = z
  .object({
    preset: z.enum(["neutral", "software", "simple"]),
    outcome: hierarchyLabelSchema,
    initiative: hierarchyLabelSchema,
    deliverable: hierarchyLabelSchema,
    milestone: hierarchyLabelSchema,
    task: hierarchyLabelSchema,
    nestedTask: hierarchyLabelSchema,
  })
  .strict();

export const neutralHierarchyVocabulary: HierarchyVocabulary = {
  preset: "neutral",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
};

export const softwareHierarchyVocabulary: HierarchyVocabulary = {
  preset: "software",
  outcome: "Product outcome",
  initiative: "Epic",
  deliverable: "Feature",
  milestone: "Milestone",
  task: "Story or Task",
  nestedTask: "Subtask",
};

export const simpleHierarchyVocabulary: HierarchyVocabulary = {
  preset: "simple",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Task",
  nestedTask: "Subtask",
};

export const recordStatusSchema: z.ZodType<RecordStatus> = z.enum([
  "provisional",
  "accepted",
  "active",
  "blocked",
  "completed",
  "rejected",
  "superseded",
  "archived",
]);

export const sourceKindSchema: z.ZodType<SourceKind> = z.enum([
  "human",
  "repository",
  "agent",
  "import",
]);

export const relationshipKindSchema: z.ZodType<RelationshipKind> = z.enum([
  "depends_on",
  "implements",
  "constrained_by",
  "decided_by",
  "evidenced_by",
  "parent_of",
  "related_to",
]);

const isSyntacticallyAbsoluteRepositoryPath = (path: string): boolean =>
  path.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);

const absoluteRepositoryPathSchema = nonEmptyStringSchema.refine(
  isSyntacticallyAbsoluteRepositoryPath,
  {
    message: "Repository path must be absolute",
  },
);

export const createProjectInputSchema = z
  .object({
    name: nonEmptyStringSchema,
    primaryRepositoryPath: absoluteRepositoryPathSchema.optional(),
    hierarchyVocabulary: hierarchyVocabularySchema.optional(),
  })
  .strict();

export const createRecordInputSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    kind: recordKindSchema,
    status: recordStatusSchema,
    title: nonEmptyStringSchema,
    body: nonEmptyStringSchema,
    sourceKind: sourceKindSchema,
    sourceRef: sourceReferenceSchema.nullable(),
  })
  .strict();

export const createRelationshipInputSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    fromRecordId: nonEmptyStringSchema,
    toRecordId: nonEmptyStringSchema,
    kind: relationshipKindSchema,
  })
  .strict()
  .refine((relationship) => relationship.fromRecordId !== relationship.toRecordId, {
    message: "Relationships must link different records",
    path: ["toRecordId"],
  });

export const projectSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    revision: nonNegativeIntegerSchema,
    primaryRepositoryPath: absoluteRepositoryPathSchema.nullable(),
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  })
  .strict();

export const projectRecordSchema = z
  .object({
    id: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    kind: recordKindSchema,
    status: recordStatusSchema,
    title: nonEmptyStringSchema,
    body: nonEmptyStringSchema,
    sourceKind: sourceKindSchema,
    sourceRef: sourceReferenceSchema.nullable(),
    revision: positiveIntegerSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  })
  .strict();

export const recordRelationshipSchema = z
  .object({
    id: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    fromRecordId: nonEmptyStringSchema,
    toRecordId: nonEmptyStringSchema,
    kind: relationshipKindSchema,
    createdAt: nonEmptyStringSchema,
  })
  .strict()
  .refine((relationship) => relationship.fromRecordId !== relationship.toRecordId, {
    message: "Relationships must link different records",
    path: ["toRecordId"],
  });

export const contextItemSchema = z
  .object({
    record: projectRecordSchema,
    mandatory: z.boolean(),
    relevance: z.enum(["stable_frame", "active_task", "linked"]),
    relationshipKind: relationshipKindSchema.nullable(),
  })
  .strict();

export const contextOmissionSchema = z
  .object({
    recordId: nonEmptyStringSchema,
    kind: recordKindSchema,
    reason: z.literal("budget"),
    retrievalRef: nonEmptyStringSchema,
  })
  .strict();

export const taskContextPackSchema = z
  .object({
    id: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    projectRevision: positiveIntegerSchema,
    generatedAt: nonEmptyStringSchema,
    budgetTokens: positiveIntegerSchema,
    estimatedTokens: positiveIntegerSchema,
    hierarchyVocabulary: hierarchyVocabularySchema
      .optional()
      .default(neutralHierarchyVocabulary),
    stableFrame: z.array(contextItemSchema),
    task: contextItemSchema,
    related: z.array(contextItemSchema),
    omissions: z.array(contextOmissionSchema),
    sourceRevisions: z.array(
      z
        .object({
          recordId: nonEmptyStringSchema,
          revision: positiveIntegerSchema,
        })
        .strict(),
    ),
  })
  .strict();
