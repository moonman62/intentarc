import type { z } from "zod";
import type {
  createProjectInputSchema,
  createRecordInputSchema,
  createRelationshipInputSchema,
} from "./schemas.js";

export type RecordKind =
  | "vision"
  | "outcome"
  | "initiative"
  | "deliverable"
  | "constraint"
  | "non_goal"
  | "milestone"
  | "task"
  | "decision"
  | "component"
  | "evidence"
  | "risk"
  | "question"
  | "exclusion"
  | "idea";

export type RecordStatus =
  | "provisional"
  | "accepted"
  | "active"
  | "blocked"
  | "completed"
  | "rejected"
  | "superseded"
  | "archived";

export type SourceKind = "human" | "repository" | "agent" | "import";

export type HierarchyPreset = "neutral" | "software" | "simple";

export interface HierarchyVocabulary {
  preset: HierarchyPreset;
  outcome: string;
  initiative: string;
  deliverable: string;
  milestone: string;
  task: string;
  nestedTask: string;
}

export type RelationshipKind =
  | "depends_on"
  | "implements"
  | "constrained_by"
  | "decided_by"
  | "evidenced_by"
  | "parent_of"
  | "related_to";

export interface Project {
  id: string;
  name: string;
  revision: number;
  primaryRepositoryPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  projectId: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  body: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordRelationship {
  id: string;
  projectId: string;
  fromRecordId: string;
  toRecordId: string;
  kind: RelationshipKind;
  createdAt: string;
}

export interface CreateProjectInput
  extends z.infer<typeof createProjectInputSchema> {}

export interface CreateRecordInput
  extends z.infer<typeof createRecordInputSchema> {}

export interface CreateRelationshipInput
  extends z.infer<typeof createRelationshipInputSchema> {}

export interface ContextItem {
  record: ProjectRecord;
  mandatory: boolean;
  relevance: "stable_frame" | "active_task" | "linked";
  relationshipKind: RelationshipKind | null;
}

export interface ContextOmission {
  recordId: string;
  kind: RecordKind;
  reason: "budget";
  retrievalRef: string;
}

export interface TaskContextPack {
  id: string;
  projectId: string;
  taskId: string;
  projectRevision: number;
  generatedAt: string;
  budgetTokens: number;
  estimatedTokens: number;
  hierarchyVocabulary?: HierarchyVocabulary;
  stableFrame: ContextItem[];
  task: ContextItem;
  related: ContextItem[];
  omissions: ContextOmission[];
  sourceRevisions: Array<{ recordId: string; revision: number }>;
}
