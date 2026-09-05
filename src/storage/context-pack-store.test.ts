import { afterEach, describe, expect, it } from "vitest";
import {
  neutralHierarchyVocabulary,
  softwareHierarchyVocabulary,
  type HierarchyVocabulary,
  type TaskContextPack,
} from "../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createContextPackStore } from "./context-pack-store.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";

const timestamp = "2026-08-03T10:00:00.000Z";

describe("context pack store", () => {
  let temporaryDatabase: TemporaryDatabase | undefined;
  let database: IntentArcDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
    database = undefined;
    temporaryDatabase = undefined;
  });

  it("returns only the latest persisted pack for the requested project", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path, { now: () => timestamp });
    for (const projectId of ["project-1", "project-2"]) {
      database.prepare(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES (?, ?, 1, NULL, ?, ?)
      `).run(projectId, projectId, timestamp, timestamp);
      database.prepare(`
        INSERT INTO project_records VALUES (?, ?, 'task', 'active', ?, 'Current task', 'human', NULL, 1, ?, ?)
      `).run(`task-${projectId}`, projectId, projectId, timestamp, timestamp);
    }
    const store = createContextPackStore(database);
    const pack = (
      id: string,
      projectId: string,
      generatedAt: string,
      hierarchyVocabulary?: HierarchyVocabulary,
    ): TaskContextPack => ({
      id,
      projectId,
      taskId: `task-${projectId}`,
      projectRevision: 1,
      generatedAt,
      budgetTokens: 2_000,
      estimatedTokens: 100,
      stableFrame: [],
      task: {
        record: {
          id: `task-${projectId}`,
          projectId,
          kind: "task",
          status: "active",
          title: projectId,
          body: "Current task",
          sourceKind: "human",
          sourceRef: null,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        mandatory: true,
        relevance: "active_task",
        relationshipKind: null,
      },
      related: [],
      omissions: [],
      sourceRevisions: [],
      ...(hierarchyVocabulary ? { hierarchyVocabulary } : {}),
    });
    const legacyPack = pack(
      "pack-old",
      "project-1",
      "2026-08-03T09:00:00.000Z",
    );
    store.save(legacyPack);
    database.prepare(
      "UPDATE context_packs SET content_json = ? WHERE id = ?",
    ).run(JSON.stringify(legacyPack), legacyPack.id);
    store.save(pack("pack-other", "project-2", "2026-08-03T12:00:00.000Z"));
    store.save(pack(
      "pack-new",
      "project-1",
      "2026-08-03T11:00:00.000Z",
      softwareHierarchyVocabulary,
    ));

    expect(store.getLatestIdForProject("project-1")).toBe("pack-new");
    expect(store.getLatestIdForProject("project-missing")).toBeNull();
    expect(store.get("pack-old")?.hierarchyVocabulary).toEqual(
      neutralHierarchyVocabulary,
    );
    const storedLegacyPack = store.getWithStoredShape("pack-old");
    expect(storedLegacyPack).toMatchObject({
      hierarchyVocabularyPresent: false,
      pack: {
        id: "pack-old",
      },
    });
    expect(Object.hasOwn(
      storedLegacyPack?.pack ?? {},
      "hierarchyVocabulary",
    )).toBe(false);
    expect(store.getWithStoredShape("pack-new")).toMatchObject({
      hierarchyVocabularyPresent: true,
      pack: {
        id: "pack-new",
        hierarchyVocabulary: softwareHierarchyVocabulary,
      },
    });
    expect(store.get("pack-new")?.hierarchyVocabulary).toEqual(
      softwareHierarchyVocabulary,
    );
  });
});
