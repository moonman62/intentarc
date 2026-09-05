import {
  GovernanceError,
  ProjectNotFoundError,
  RecordNotFoundError,
  RelationshipAlreadyExistsError,
  createProjectInputSchema,
  createRecordInputSchema,
  createRelationshipInputSchema,
  hierarchyVocabularySchema,
  isHierarchyRecordKind,
  neutralHierarchyVocabulary,
  simpleHierarchyVocabulary,
  softwareHierarchyVocabulary,
  type CreateProjectInput,
  type CreateRecordInput,
  type CreateRelationshipInput,
  type HierarchyVocabulary,
  type Project,
  type ProjectRecord,
  type RecordRelationship,
  type RepositorySource,
} from "../domain/index.js";
import type { IntentArcDatabase } from "./database.js";
import {
  mapProjectRecordRow,
  mapProjectRow,
  type ProjectRecordRow,
  type ProjectRow,
  mapRecordRelationshipRow,
  type RecordRelationshipRow,
} from "./row-mappers.js";

export interface ProjectReadStore {
  withReadSnapshot<Result>(read: () => Result): Result;
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  getHierarchyVocabulary(projectId: string): HierarchyVocabulary;
  getRecord(projectId: string, recordId: string): ProjectRecord | null;
  listRecords(projectId: string): ProjectRecord[];
  listRelationships(projectId: string): RecordRelationship[];
  listRelationshipsForRecord(
    projectId: string,
    recordId: string,
  ): RecordRelationship[];
}

export interface UpdateHierarchyVocabularyInput {
  projectId: string;
  expectedProjectRevision: number;
  vocabulary: HierarchyVocabulary;
}

export interface UpdateHierarchyVocabularyResult {
  projectRevision: number;
  hierarchyVocabulary: HierarchyVocabulary;
}

export interface ProjectStore extends ProjectReadStore {
  createProject(input: CreateProjectInput): Project;
  updateHierarchyVocabulary(
    input: UpdateHierarchyVocabularyInput,
  ): UpdateHierarchyVocabularyResult;
  /** @internal Foundation storage compatibility only; authoritative writes use ChangeService. */
  createRecord(input: CreateRecordInput): ProjectRecord;
  /** @internal Foundation storage compatibility only; authoritative writes use ChangeService. */
  createRelationship(input: CreateRelationshipInput): RecordRelationship;
  attachRepositorySource(input: {
    projectId: string;
    expectedProjectRevision: number;
    root: string;
    canonicalSubpath: string | null;
    repositoryIdentity: string;
  }): Project;
  locateRepositorySource(input: {
    projectId: string;
    expectedProjectRevision: number;
    root: string;
    repositoryIdentity: string;
  }): Project;
  detachRepositorySource(input: {
    projectId: string;
    expectedProjectRevision: number;
  }): Project;
  markRepositorySourceUnavailable(
    claim: RepositorySourceScanClaim,
  ): "changed" | "already_unavailable" | "stale";
  reactivateRepositorySource(claim: RepositorySourceScanClaim): boolean;
}

export interface RepositorySourceScanClaim extends Pick<
  RepositorySource,
  | "id"
  | "projectId"
  | "root"
  | "canonicalSubpath"
  | "repositoryIdentity"
  | "status"
  | "currentSnapshotId"
> {
  readonly expectedProjectRevision: number;
}

/** Validates the complete authoritative relationship set without recursion. */
export const validateParentHierarchy = (
  projectId: string,
  records: readonly ProjectRecord[],
  relationships: readonly RecordRelationship[],
): void => {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();

  for (const relationship of relationships) {
    const from = recordsById.get(relationship.fromRecordId);
    const to = recordsById.get(relationship.toRecordId);
    if (
      relationship.projectId !== projectId || !from || !to ||
      from.projectId !== projectId || to.projectId !== projectId
    ) {
      throw new GovernanceError(
        "validation_failed",
        "Hierarchy relationships must remain inside one project",
      );
    }
    if (relationship.kind !== "parent_of") continue;
    if (from.id === to.id) {
      throw new GovernanceError("validation_failed", "A record cannot be its own parent");
    }
    if (!isHierarchyRecordKind(from.kind) || !isHierarchyRecordKind(to.kind)) {
      throw new GovernanceError(
        "validation_failed",
        "Hierarchy relationships require outcomes, initiatives, deliverables, milestones, or tasks",
      );
    }
    const previousParent = parentByChild.get(to.id);
    if (previousParent && previousParent !== from.id) {
      throw new GovernanceError(
        "validation_failed",
        "A hierarchy record cannot have more than one parent",
      );
    }
    parentByChild.set(to.id, from.id);
    const children = childrenByParent.get(from.id) ?? [];
    children.push(to.id);
    childrenByParent.set(from.id, children);
  }

  for (const children of childrenByParent.values()) children.sort();
  const visited = new Set<string>();
  const active = new Set<string>();
  for (const start of [...recordsById.keys()].sort()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; nextChild: number }> = [{ id: start, nextChild: 0 }];
    active.add(start);
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
      if (active.has(child)) {
        throw new GovernanceError(
          "validation_failed",
          "Hierarchy relationships cannot contain a cycle",
        );
      }
      if (!visited.has(child)) {
        active.add(child);
        stack.push({ id: child, nextChild: 0 });
      }
    }
  }
};

export interface ProjectStoreDependencies {
  now: () => string;
  newId: (
    prefix: "project" | "record" | "relationship" | "repository-source" | "audit",
  ) => string;
}

export class RepositorySourceRevisionConflictError extends Error {
  constructor(readonly projectId: string) {
    super("Repository source recovery conflicts with the project revision.");
    this.name = "RepositorySourceRevisionConflictError";
  }
}

const projectColumns = `
  id,
  name,
  revision,
  primary_repository_path,
  created_at,
  updated_at
`;

const recordColumns = `
  id,
  project_id,
  kind,
  status,
  title,
  body,
  source_kind,
  source_ref,
  revision,
  created_at,
  updated_at
`;

const relationshipColumns = `
  id,
  project_id,
  from_record_id,
  to_record_id,
  kind,
  created_at
`;

type SqliteError = Error & { code?: string };

const isDuplicateRelationshipConstraint = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const sqliteError = error as SqliteError;

  return (
    sqliteError.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    sqliteError.message.includes(
      "record_relationships.from_record_id, record_relationships.to_record_id, record_relationships.kind",
    )
  );
};

const isBusySnapshot = (error: unknown): boolean =>
  error instanceof Error &&
  (error as SqliteError).code === "SQLITE_BUSY_SNAPSHOT";

const retryBusySnapshot = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (!isBusySnapshot(error)) {
      throw error;
    }

    return operation();
  }
};

export const createProjectStore = (
  database: IntentArcDatabase,
  dependencies: ProjectStoreDependencies,
): ProjectStore => {
  const insertProject = database.prepare(`
    INSERT INTO projects (
      id, name, revision, primary_repository_path, hierarchy_vocabulary_json,
      created_at, updated_at
    ) VALUES (
      @id, @name, @revision, @primaryRepositoryPath, @hierarchyVocabularyJson,
      @createdAt, @updatedAt
    )
  `);
  const insertProjectAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_admin',
      'project_created', @projectId, NULL, NULL, 0, 'applied', NULL, @createdAt
    )
  `);
  const selectProjectById = database.prepare(
    `SELECT ${projectColumns} FROM projects WHERE id = ?`,
  );
  const selectProjects = database.prepare(
    `SELECT ${projectColumns} FROM projects ORDER BY created_at ASC, id ASC`,
  );
  const selectHierarchyVocabularyByProjectId = database.prepare(
    "SELECT hierarchy_vocabulary_json FROM projects WHERE id = ?",
  );
  const updateHierarchyVocabularyAtRevision = database.prepare(`
    UPDATE projects
    SET hierarchy_vocabulary_json = @hierarchyVocabularyJson,
        revision = revision + 1,
        updated_at = @updatedAt
    WHERE id = @projectId AND revision = @expectedProjectRevision
  `);
  const insertHierarchyVocabularyAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_admin',
      'hierarchy_vocabulary_updated', @projectId, NULL, @expectedProjectRevision,
      @revisionAfter, 'applied', NULL, @createdAt
    )
  `);
  const insertRecord = database.prepare(`
    INSERT INTO project_records (
      id, project_id, kind, status, title, body, source_kind, source_ref,
      revision, created_at, updated_at
    ) VALUES (
      @id, @projectId, @kind, @status, @title, @body, @sourceKind, @sourceRef,
      @revision, @createdAt, @updatedAt
    )
  `);
  const insertRecordRevision = database.prepare(`
    INSERT INTO project_record_revisions (record_id, revision, snapshot_json, created_at)
    VALUES (@recordId, @revision, @snapshotJson, @createdAt)
  `);
  const incrementProjectRevision = database.prepare(`
    UPDATE projects
    SET revision = revision + 1, updated_at = @updatedAt
    WHERE id = @projectId
  `);
  const selectRecordById = database.prepare(
    `SELECT ${recordColumns} FROM project_records WHERE project_id = ? AND id = ?`,
  );
  const selectRecordsByProjectId = database.prepare(
    `SELECT ${recordColumns} FROM project_records
     WHERE project_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const insertRelationship = database.prepare(`
    INSERT INTO record_relationships (
      id, project_id, from_record_id, to_record_id, kind, created_at
    ) VALUES (
      @id, @projectId, @fromRecordId, @toRecordId, @kind, @createdAt
    )
  `);
  const selectRelationshipsForRecord = database.prepare(`
    SELECT ${relationshipColumns}
    FROM record_relationships
    WHERE project_id = @projectId
      AND (from_record_id = @recordId OR to_record_id = @recordId)
    ORDER BY kind, from_record_id, to_record_id, id
  `);
  const selectRelationshipsByProjectId = database.prepare(`
    SELECT ${relationshipColumns}
    FROM record_relationships
    WHERE project_id = ?
    ORDER BY kind, from_record_id, to_record_id, id
  `);
  const updateLocatedProject = database.prepare(`
    UPDATE projects
    SET primary_repository_path = @root,
        revision = revision + 1,
        updated_at = @updatedAt
    WHERE id = @projectId AND revision = @expectedProjectRevision
  `);
  const selectRepositorySourceState = database.prepare(`
    SELECT id, status FROM repository_sources WHERE project_id = ?
  `);
  const insertAttachedSource = database.prepare(`
    INSERT INTO repository_sources (
      id, project_id, root, canonical_subpath, repository_identity, status,
      current_snapshot_id, created_at, updated_at
    ) VALUES (
      @id, @projectId, @root, @canonicalSubpath, @repositoryIdentity, 'available',
      NULL, @updatedAt, @updatedAt
    )
  `);
  const updateDetachedSourceRegistration = database.prepare(`
    UPDATE repository_sources
    SET root = @root,
        canonical_subpath = @canonicalSubpath,
        repository_identity = @repositoryIdentity,
        status = 'available',
        updated_at = @updatedAt
    WHERE project_id = @projectId AND status = 'detached'
  `);
  const updateLocatedSource = database.prepare(`
    UPDATE repository_sources
    SET root = @root, status = 'available', updated_at = @updatedAt
    WHERE project_id = @projectId AND repository_identity = @repositoryIdentity
  `);
  const updateDetachedProject = database.prepare(`
    UPDATE projects
    SET primary_repository_path = NULL,
        revision = revision + 1,
        updated_at = @updatedAt
    WHERE id = @projectId AND revision = @expectedProjectRevision
  `);
  const updateDetachedSource = database.prepare(`
    UPDATE repository_sources
    SET status = 'detached', updated_at = @updatedAt
    WHERE project_id = @projectId
  `);
  const updateUnavailableSource = database.prepare(`
    UPDATE repository_sources
    SET status = 'unavailable', updated_at = @updatedAt
    WHERE id = @id
      AND project_id = @projectId
      AND root = @root
      AND canonical_subpath IS @canonicalSubpath
      AND repository_identity = @repositoryIdentity
      AND status = 'available'
      AND current_snapshot_id IS @currentSnapshotId
      AND EXISTS (
        SELECT 1 FROM projects
        WHERE projects.id = @projectId
          AND projects.revision = @expectedProjectRevision
          AND projects.primary_repository_path = @root
      )
  `);
  const selectUnavailableSourceClaim = database.prepare(`
    SELECT 1 AS matched
    FROM repository_sources
    JOIN projects ON projects.id = repository_sources.project_id
    WHERE repository_sources.id = @id
      AND repository_sources.project_id = @projectId
      AND repository_sources.root = @root
      AND repository_sources.canonical_subpath IS @canonicalSubpath
      AND repository_sources.repository_identity = @repositoryIdentity
      AND repository_sources.status = 'unavailable'
      AND repository_sources.current_snapshot_id IS @currentSnapshotId
      AND projects.revision = @expectedProjectRevision
      AND projects.primary_repository_path = @root
  `);
  const reactivateUnavailableSource = database.prepare(`
    UPDATE repository_sources
    SET status = 'available', updated_at = @updatedAt
    WHERE id = @id
      AND project_id = @projectId
      AND root = @root
      AND canonical_subpath IS @canonicalSubpath
      AND repository_identity = @repositoryIdentity
      AND status = 'unavailable'
      AND current_snapshot_id IS @currentSnapshotId
      AND EXISTS (
        SELECT 1 FROM projects
        WHERE projects.id = @projectId
          AND projects.revision = @expectedProjectRevision
          AND projects.primary_repository_path = @root
      )
  `);
  const insertSourceRecoveryAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_admin',
      @actionCategory, @projectId, NULL, @expectedProjectRevision,
      @revisionAfter, 'applied', NULL, @createdAt
    )
  `);

  const getProject = (projectId: string): Project | null => {
    const row = selectProjectById.get(projectId) as ProjectRow | undefined;

    return row ? mapProjectRow(row) : null;
  };

  const getHierarchyVocabulary = (projectId: string): HierarchyVocabulary => {
    const row = selectHierarchyVocabularyByProjectId.get(projectId) as
      | { hierarchy_vocabulary_json: string }
      | undefined;

    if (!row) throw new ProjectNotFoundError(projectId);

    return hierarchyVocabularySchema.parse(
      JSON.parse(row.hierarchy_vocabulary_json),
    );
  };

  const createProjectTransaction = database.transaction(
    (input: CreateProjectInput): Project => {
      const timestamp = dependencies.now();
      const project: Project = {
        id: dependencies.newId("project"),
        name: input.name,
        revision: 0,
        primaryRepositoryPath: input.primaryRepositoryPath ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const hierarchyVocabularyJson = JSON.stringify(
        hierarchyVocabularySchema.parse(
          input.hierarchyVocabulary ?? neutralHierarchyVocabulary,
        ),
      );

      insertProject.run({ ...project, hierarchyVocabularyJson });
      insertProjectAudit.run({
        id: dependencies.newId("audit"),
        projectId: project.id,
        createdAt: timestamp,
      });
      return project;
    },
  );

  const hierarchyVocabularyUpdateTransaction = database.transaction(
    (input: UpdateHierarchyVocabularyInput): UpdateHierarchyVocabularyResult => {
      if (
        input.projectId.length === 0 ||
        input.projectId !== input.projectId.trim() ||
        !Number.isSafeInteger(input.expectedProjectRevision) ||
        input.expectedProjectRevision < 0 ||
        input.expectedProjectRevision >= Number.MAX_SAFE_INTEGER
      ) {
        throw new GovernanceError(
          "validation_failed",
          "Hierarchy vocabulary update input is invalid",
        );
      }
      const project = getProject(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);
      if (project.revision !== input.expectedProjectRevision) {
        throw new GovernanceError(
          "project_revision_conflict",
          "Project revision changed before hierarchy vocabulary update",
          {
            projectId: input.projectId,
            expectedProjectRevision: input.expectedProjectRevision,
            currentProjectRevision: project.revision,
          },
        );
      }
      const vocabulary = hierarchyVocabularySchema.parse(input.vocabulary);
      const canonicalVocabulary = {
        neutral: neutralHierarchyVocabulary,
        software: softwareHierarchyVocabulary,
        simple: simpleHierarchyVocabulary,
      }[vocabulary.preset];
      if (JSON.stringify(vocabulary) !== JSON.stringify(canonicalVocabulary)) {
        throw new GovernanceError(
          "validation_failed",
          "Hierarchy vocabulary must match a canonical preset",
        );
      }
      const updatedAt = dependencies.now();
      const update = updateHierarchyVocabularyAtRevision.run({
        projectId: input.projectId,
        expectedProjectRevision: input.expectedProjectRevision,
        hierarchyVocabularyJson: JSON.stringify(vocabulary),
        updatedAt,
      });
      if (update.changes !== 1) {
        throw new GovernanceError(
          "project_revision_conflict",
          "Project revision changed before hierarchy vocabulary update",
        );
      }
      const projectRevision = input.expectedProjectRevision + 1;
      insertHierarchyVocabularyAudit.run({
        id: dependencies.newId("audit"),
        projectId: input.projectId,
        expectedProjectRevision: input.expectedProjectRevision,
        revisionAfter: projectRevision,
        createdAt: updatedAt,
      });
      return { projectRevision, hierarchyVocabulary: vocabulary };
    },
  );

  const createRecordTransaction = database.transaction(
    (input: CreateRecordInput): ProjectRecord => {
      if (!getProject(input.projectId)) {
        throw new ProjectNotFoundError(input.projectId);
      }

      const timestamp = dependencies.now();
      const record: ProjectRecord = {
        id: dependencies.newId("record"),
        projectId: input.projectId,
        kind: input.kind,
        status: input.status,
        title: input.title,
        body: input.body,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      insertRecord.run(record);
      insertRecordRevision.run({
        recordId: record.id,
        revision: record.revision,
        snapshotJson: JSON.stringify(record),
        createdAt: record.createdAt,
      });
      incrementProjectRevision.run({
        projectId: record.projectId,
        updatedAt: timestamp,
      });

      const row = selectRecordById.get(record.projectId, record.id) as
        | ProjectRecordRow
        | undefined;

      if (!row) {
        throw new Error(`Created record could not be read: ${record.id}`);
      }

      return mapProjectRecordRow(row);
    },
  );

  const createRelationshipTransaction = database.transaction(
    (input: CreateRelationshipInput): RecordRelationship => {
      const fromRecord = selectRecordById.get(
        input.projectId,
        input.fromRecordId,
      ) as ProjectRecordRow | undefined;

      if (!fromRecord) {
        throw new RecordNotFoundError(input.fromRecordId);
      }

      const toRecord = selectRecordById.get(
        input.projectId,
        input.toRecordId,
      ) as ProjectRecordRow | undefined;

      if (!toRecord) {
        throw new RecordNotFoundError(input.toRecordId);
      }

      const relationship: RecordRelationship = {
        id: dependencies.newId("relationship"),
        projectId: input.projectId,
        fromRecordId: input.fromRecordId,
        toRecordId: input.toRecordId,
        kind: input.kind,
        createdAt: dependencies.now(),
      };

      validateParentHierarchy(
        input.projectId,
        (selectRecordsByProjectId.all(input.projectId) as ProjectRecordRow[])
          .map(mapProjectRecordRow),
        [
          ...(selectRelationshipsByProjectId.all(input.projectId) as RecordRelationshipRow[])
            .map(mapRecordRelationshipRow),
          relationship,
        ],
      );

      try {
        insertRelationship.run(relationship);
      } catch (error) {
        if (isDuplicateRelationshipConstraint(error)) {
          throw new RelationshipAlreadyExistsError(
            relationship.fromRecordId,
            relationship.toRecordId,
            relationship.kind,
          );
        }

        throw error;
      }

      incrementProjectRevision.run({
        projectId: relationship.projectId,
        updatedAt: relationship.createdAt,
      });

      return relationship;
    },
  );

  const sourceRecoveryTransaction = database.transaction((input: {
    projectId: string;
    expectedProjectRevision: number;
    root?: string;
    repositoryIdentity?: string;
    action: "locate" | "detach";
  }): Project => {
    const project = getProject(input.projectId);
    if (!project) throw new ProjectNotFoundError(input.projectId);
    if (project.revision !== input.expectedProjectRevision) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    const updatedAt = dependencies.now();
    const located = input.action === "locate";
    const sourceResult = located
      ? updateLocatedSource.run({
          projectId: input.projectId,
          root: input.root!,
          repositoryIdentity: input.repositoryIdentity!,
          updatedAt,
        })
      : updateDetachedSource.run({ projectId: input.projectId, updatedAt });
    if (sourceResult.changes !== 1) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    const projectResult = located
      ? updateLocatedProject.run({
          projectId: input.projectId,
          expectedProjectRevision: input.expectedProjectRevision,
          root: input.root!,
          updatedAt,
        })
      : updateDetachedProject.run({
          projectId: input.projectId,
          expectedProjectRevision: input.expectedProjectRevision,
          updatedAt,
        });
    if (projectResult.changes !== 1) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    insertSourceRecoveryAudit.run({
      id: dependencies.newId("audit"),
      projectId: input.projectId,
      actionCategory: located
        ? "repository_source_located"
        : "repository_source_detached",
      expectedProjectRevision: input.expectedProjectRevision,
      revisionAfter: input.expectedProjectRevision + 1,
      createdAt: updatedAt,
    });
    return getProject(input.projectId)!;
  });

  const attachRepositorySourceTransaction = database.transaction((input: {
    projectId: string;
    expectedProjectRevision: number;
    root: string;
    canonicalSubpath: string | null;
    repositoryIdentity: string;
  }): Project => {
    const project = getProject(input.projectId);
    if (!project) throw new ProjectNotFoundError(input.projectId);
    if (project.revision !== input.expectedProjectRevision) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    const existing = selectRepositorySourceState.get(input.projectId) as
      | { id: string; status: string }
      | undefined;
    if (existing !== undefined && existing.status !== "detached") {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    const updatedAt = dependencies.now();
    if (existing === undefined) {
      insertAttachedSource.run({
        ...input,
        id: dependencies.newId("repository-source"),
        updatedAt,
      });
    } else if (updateDetachedSourceRegistration.run({ ...input, updatedAt }).changes !== 1) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    if (updateLocatedProject.run({ ...input, updatedAt }).changes !== 1) {
      throw new RepositorySourceRevisionConflictError(input.projectId);
    }
    insertSourceRecoveryAudit.run({
      id: dependencies.newId("audit"),
      projectId: input.projectId,
      actionCategory: "repository_source_attached",
      expectedProjectRevision: input.expectedProjectRevision,
      revisionAfter: input.expectedProjectRevision + 1,
      createdAt: updatedAt,
    });
    return getProject(input.projectId)!;
  });

  const sourceUnavailableTransaction = database.transaction((
    claim: RepositorySourceScanClaim,
  ): "changed" | "already_unavailable" | "stale" => {
    const project = getProject(claim.projectId);
    if (!project) throw new ProjectNotFoundError(claim.projectId);
    const updatedAt = dependencies.now();
    const sourceResult = updateUnavailableSource.run({ ...claim, updatedAt });
    if (sourceResult.changes === 1) {
      insertSourceRecoveryAudit.run({
        id: dependencies.newId("audit"),
        projectId: claim.projectId,
        actionCategory: "repository_source_unavailable",
        expectedProjectRevision: claim.expectedProjectRevision,
        revisionAfter: claim.expectedProjectRevision,
        createdAt: updatedAt,
      });
      return "changed";
    }
    return selectUnavailableSourceClaim.get(claim) === undefined
      ? "stale"
      : "already_unavailable";
  });

  const sourceReactivationTransaction = database.transaction((
    claim: RepositorySourceScanClaim,
  ): boolean => {
    const project = getProject(claim.projectId);
    if (!project) throw new ProjectNotFoundError(claim.projectId);
    const updatedAt = dependencies.now();
    const result = reactivateUnavailableSource.run({ ...claim, updatedAt });
    if (result.changes !== 1) return false;
    insertSourceRecoveryAudit.run({
      id: dependencies.newId("audit"),
      projectId: claim.projectId,
      actionCategory: "repository_source_reactivated",
      expectedProjectRevision: claim.expectedProjectRevision,
      revisionAfter: claim.expectedProjectRevision,
      createdAt: updatedAt,
    });
    return true;
  });

  return {
    withReadSnapshot<Result>(read: () => Result): Result {
      return database.transaction(read).deferred();
    },

    createProject(input: CreateProjectInput): Project {
      const parsedInput = createProjectInputSchema.parse(input);

      return createProjectTransaction.immediate(parsedInput);
    },

    updateHierarchyVocabulary(
      input: UpdateHierarchyVocabularyInput,
    ): UpdateHierarchyVocabularyResult {
      return retryBusySnapshot(() => hierarchyVocabularyUpdateTransaction.immediate(input));
    },

    listProjects(): Project[] {
      return (selectProjects.all() as ProjectRow[]).map(mapProjectRow);
    },

    getProject,

    getHierarchyVocabulary,

    createRecord(input: CreateRecordInput): ProjectRecord {
      const parsedInput = createRecordInputSchema.parse(input);

      return retryBusySnapshot(() => createRecordTransaction(parsedInput));
    },

    getRecord(projectId: string, recordId: string): ProjectRecord | null {
      const row = selectRecordById.get(projectId, recordId) as
        | ProjectRecordRow
        | undefined;

      return row ? mapProjectRecordRow(row) : null;
    },

    listRecords(projectId: string): ProjectRecord[] {
      return (selectRecordsByProjectId.all(projectId) as ProjectRecordRow[]).map(
        mapProjectRecordRow,
      );
    },

    createRelationship(input: CreateRelationshipInput): RecordRelationship {
      const parsedInput = createRelationshipInputSchema.parse(input);

      return retryBusySnapshot(() =>
        createRelationshipTransaction(parsedInput),
      );
    },

    listRelationships(projectId: string): RecordRelationship[] {
      return (
        selectRelationshipsByProjectId.all(projectId) as RecordRelationshipRow[]
      ).map(mapRecordRelationshipRow);
    },

    locateRepositorySource(input) {
      return sourceRecoveryTransaction.immediate({ ...input, action: "locate" });
    },

    attachRepositorySource(input) {
      return attachRepositorySourceTransaction.immediate(input);
    },

    detachRepositorySource(input) {
      return sourceRecoveryTransaction.immediate({ ...input, action: "detach" });
    },

    markRepositorySourceUnavailable(claim) {
      return sourceUnavailableTransaction.immediate(claim);
    },

    reactivateRepositorySource(claim) {
      return sourceReactivationTransaction.immediate(claim);
    },

    listRelationshipsForRecord(
      projectId: string,
      recordId: string,
    ): RecordRelationship[] {
      return (
        selectRelationshipsForRecord.all({ projectId, recordId }) as RecordRelationshipRow[]
      ).map(mapRecordRelationshipRow);
    },
  };
};
