import {
  CorruptStoredContextPackError,
  taskContextPackSchema,
  type TaskContextPack,
} from "../domain/index.js";
import type { IntentArcDatabase } from "./database.js";

export interface ContextPackStore {
  save(pack: TaskContextPack): void;
  get(packId: string): TaskContextPack | null;
  getWithStoredShape(packId: string): StoredContextPack | null;
  getLatestIdForProject(projectId: string): string | null;
}

export interface StoredContextPack {
  pack: TaskContextPack;
  hierarchyVocabularyPresent: boolean;
}

type StoredContextPackRow = {
  content_json: string;
};

export const createContextPackStore = (
  database: IntentArcDatabase,
): ContextPackStore => {
  const insertContextPack = database.prepare(`
    INSERT INTO context_packs (
      id,
      project_id,
      task_id,
      project_revision,
      budget_tokens,
      estimated_tokens,
      content_json,
      created_at
    ) VALUES (
      @id,
      @projectId,
      @taskId,
      @projectRevision,
      @budgetTokens,
      @estimatedTokens,
      @contentJson,
      @createdAt
    )
  `);
  const selectContextPackById = database.prepare(`
    SELECT content_json
    FROM context_packs
    WHERE id = ?
  `);
  const selectLatestContextPackIdForProject = database.prepare(`
    SELECT id
    FROM context_packs
    WHERE project_id = ?
    ORDER BY created_at COLLATE BINARY DESC, id COLLATE BINARY DESC
    LIMIT 1
  `);

  const readStoredPack = (packId: string): StoredContextPack | null => {
    const row = selectContextPackById.get(packId) as
      | StoredContextPackRow
      | undefined;

    if (!row) {
      return null;
    }

    try {
      const storedPack: unknown = JSON.parse(row.content_json);
      const hierarchyVocabularyPresent = storedPack !== null &&
        typeof storedPack === "object" &&
        Object.hasOwn(storedPack, "hierarchyVocabulary");
      let pack: TaskContextPack = taskContextPackSchema.parse(storedPack);
      if (!hierarchyVocabularyPresent) {
        const {
          hierarchyVocabulary: _legacyMissingVocabulary,
          ...legacyPack
        } = pack;
        pack = legacyPack;
      }
      return {
        pack,
        hierarchyVocabularyPresent,
      };
    } catch {
      throw new CorruptStoredContextPackError(packId);
    }
  };

  return {
    save(pack: TaskContextPack): void {
      const parsedPack = taskContextPackSchema.parse(pack);

      insertContextPack.run({
        id: parsedPack.id,
        projectId: parsedPack.projectId,
        taskId: parsedPack.taskId,
        projectRevision: parsedPack.projectRevision,
        budgetTokens: parsedPack.budgetTokens,
        estimatedTokens: parsedPack.estimatedTokens,
        contentJson: JSON.stringify(parsedPack),
        createdAt: parsedPack.generatedAt,
      });
    },

    get(packId: string): TaskContextPack | null {
      const storedPack = readStoredPack(packId);
      return storedPack === null
        ? null
        : taskContextPackSchema.parse(storedPack.pack);
    },

    getWithStoredShape(packId: string): StoredContextPack | null {
      return readStoredPack(packId);
    },

    getLatestIdForProject(projectId: string): string | null {
      const row = selectLatestContextPackIdForProject.get(projectId) as
        | { id: string }
        | undefined;
      return row?.id ?? null;
    },
  };
};
