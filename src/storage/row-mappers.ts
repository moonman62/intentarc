import type {
  Project,
  ProjectRecord,
  RecordKind,
  RecordRelationship,
  RecordStatus,
  RelationshipKind,
  SourceKind,
} from "../domain/index.js";

export type ProjectRow = {
  id: string;
  name: string;
  revision: number;
  primary_repository_path: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectRecordRow = {
  id: string;
  project_id: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  body: string;
  source_kind: SourceKind;
  source_ref: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type RecordRelationshipRow = {
  id: string;
  project_id: string;
  from_record_id: string;
  to_record_id: string;
  kind: RelationshipKind;
  created_at: string;
};

export const mapProjectRow = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  revision: row.revision,
  primaryRepositoryPath: row.primary_repository_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapProjectRecordRow = (row: ProjectRecordRow): ProjectRecord => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  status: row.status,
  title: row.title,
  body: row.body,
  sourceKind: row.source_kind,
  sourceRef: row.source_ref,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapRecordRelationshipRow = (
  row: RecordRelationshipRow,
): RecordRelationship => ({
  id: row.id,
  projectId: row.project_id,
  fromRecordId: row.from_record_id,
  toRecordId: row.to_record_id,
  kind: row.kind,
  createdAt: row.created_at,
});
