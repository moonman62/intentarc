import { describe, expect, it } from "vitest";
import {
  contextItemSchema,
  contextOmissionSchema,
  createProjectInputSchema,
  createRecordInputSchema,
  createRelationshipInputSchema,
  hierarchyVocabularySchema,
  neutralHierarchyVocabulary,
  projectRecordSchema,
  projectSchema,
  recordKindSchema,
  recordRelationshipSchema,
  relationshipKindSchema,
  simpleHierarchyVocabulary,
  softwareHierarchyVocabulary,
  taskContextPackSchema,
} from "./schemas.js";

describe("hierarchy vocabulary schemas", () => {
  const softwareVocabulary = {
    preset: "software",
    outcome: "Product outcome",
    initiative: "Epic",
    deliverable: "Feature",
    milestone: "Milestone",
    task: "Story or task",
    nestedTask: "Subtask",
  };

  const neutralVocabulary = {
    preset: "neutral",
    outcome: "Outcome",
    initiative: "Initiative",
    deliverable: "Deliverable",
    milestone: "Milestone",
    task: "Work item",
    nestedTask: "Subtask",
  };

  it("accepts initiative and deliverable record kinds", () => {
    expect(recordKindSchema.parse("initiative")).toBe("initiative");
    expect(recordKindSchema.parse("deliverable")).toBe("deliverable");
  });

  it("accepts a complete software vocabulary", () => {
    expect(hierarchyVocabularySchema.parse(softwareVocabulary)).toEqual(
      softwareVocabulary,
    );
  });

  it.each([
    [
      "Neutral",
      neutralHierarchyVocabulary,
      {
        preset: "neutral",
        outcome: "Outcome",
        initiative: "Initiative",
        deliverable: "Deliverable",
        milestone: "Milestone",
        task: "Work item",
        nestedTask: "Subtask",
      },
    ],
    [
      "Software",
      softwareHierarchyVocabulary,
      {
        preset: "software",
        outcome: "Product outcome",
        initiative: "Epic",
        deliverable: "Feature",
        milestone: "Milestone",
        task: "Story or Task",
        nestedTask: "Subtask",
      },
    ],
    [
      "Simple",
      simpleHierarchyVocabulary,
      {
        preset: "simple",
        outcome: "Outcome",
        initiative: "Initiative",
        deliverable: "Deliverable",
        milestone: "Milestone",
        task: "Task",
        nestedTask: "Subtask",
      },
    ],
  ])("parses the exact canonical %s vocabulary", (_name, vocabulary, expected) => {
    expect(hierarchyVocabularySchema.parse(vocabulary)).toEqual(expected);
  });

  it.each([
    ["one character", "x"],
    ["40 characters", "x".repeat(40)],
  ])("accepts a hierarchy label with %s", (_boundary, label) => {
    expect(
      hierarchyVocabularySchema.parse({
        ...neutralVocabulary,
        initiative: label,
      }),
    ).toEqual({ ...neutralVocabulary, initiative: label });
  });

  it("rejects an empty hierarchy label", () => {
    expect(() =>
      hierarchyVocabularySchema.parse({ ...neutralVocabulary, outcome: "" }),
    ).toThrow();
  });

  it.each([
    ["unknown presets", { ...neutralVocabulary, preset: "product" }],
    ["unknown keys", { ...neutralVocabulary, extra: true }],
    ["missing labels", { preset: "neutral", outcome: "Outcome" }],
    ["leading whitespace", { ...neutralVocabulary, initiative: " Initiative" }],
    ["trailing whitespace", { ...neutralVocabulary, initiative: "Initiative " }],
    ["labels longer than 40 characters", { ...neutralVocabulary, initiative: "I".repeat(41) }],
    ["control characters", { ...neutralVocabulary, initiative: "Initiative\nname" }],
  ])("rejects %s", (_reason, vocabulary) => {
    expect(() => hierarchyVocabularySchema.parse(vocabulary)).toThrow();
  });
});

describe("domain input schemas", () => {
  const validRecord = {
    projectId: "project-1",
    kind: "task",
    status: "active",
    title: "Add focused context",
    body: "Return only the records needed for this task.",
    sourceKind: "human",
    sourceRef: "cli",
  };

  it("accepts a complete record using the domain vocabulary", () => {
    expect(createRecordInputSchema.parse(validRecord)).toEqual(validRecord);
  });

  it("accepts explicit parent hierarchy relationships", () => {
    expect(relationshipKindSchema.parse("parent_of")).toBe("parent_of");
  });

  it("preserves non-empty source references beyond 200 characters across persistence", () => {
    const legacySourceReference = `legacy://${"s".repeat(512)}`;
    const persisted = {
      ...validRecord,
      id: "record-source-boundary",
      sourceRef: legacySourceReference,
      revision: 1,
      createdAt: "2026-07-26T20:00:00.000Z",
      updatedAt: "2026-07-26T20:00:00.000Z",
    };

    expect(createRecordInputSchema.parse({
      ...validRecord,
      sourceRef: legacySourceReference,
    }).sourceRef).toBe(legacySourceReference);
    expect(projectRecordSchema.parse(persisted).sourceRef).toBe(
      legacySourceReference,
    );
    expect(() => createRecordInputSchema.parse({
      ...validRecord,
      sourceRef: "   ",
    })).toThrow();
    expect(() => projectRecordSchema.parse({
      ...persisted,
      sourceRef: "   ",
    })).toThrow();
  });

  it("rejects a record with an unknown kind", () => {
    expect(() =>
      createRecordInputSchema.parse({ ...validRecord, kind: "unknown" }),
    ).toThrow();
  });

  it("rejects a record whose title is only whitespace", () => {
    expect(() =>
      createRecordInputSchema.parse({ ...validRecord, title: "   " }),
    ).toThrow();
  });

  it("rejects fields outside the record contract", () => {
    expect(() =>
      createRecordInputSchema.parse({ ...validRecord, untracked: true }),
    ).toThrow();
  });

  it("rejects a relationship that links a record to itself", () => {
    expect(() =>
      createRelationshipInputSchema.parse({
        projectId: "project-1",
        fromRecordId: "task-1",
        toRecordId: "task-1",
        kind: "related_to",
      }),
    ).toThrow("different records");
  });

  it("rejects a blank project name", () => {
    expect(() => createProjectInputSchema.parse({ name: "   " })).toThrow();
  });

  it("accepts an absolute repository path without reading it", () => {
    expect(
      createProjectInputSchema.parse({
        name: "IntentArc",
        primaryRepositoryPath: "C:\\missing\\intentarc",
      }),
    ).toEqual({
      name: "IntentArc",
      primaryRepositoryPath: "C:\\missing\\intentarc",
    });
  });

  it("accepts a UNC repository path without reading it", () => {
    expect(
      createProjectInputSchema.parse({
        name: "IntentArc",
        primaryRepositoryPath: "\\\\server\\share\\repo",
      }),
    ).toEqual({
      name: "IntentArc",
      primaryRepositoryPath: "\\\\server\\share\\repo",
    });
  });
});

describe("persisted domain schemas", () => {
  const persistedRecord = {
    id: "record-1",
    projectId: "project-1",
    kind: "task",
    status: "active",
    title: "Add focused context",
    body: "Return only the records needed for this task.",
    sourceKind: "human",
    sourceRef: "cli",
    revision: 1,
    createdAt: "2026-07-26T20:00:00.000Z",
    updatedAt: "2026-07-26T20:00:00.000Z",
  };

  const contextItem = {
    record: persistedRecord,
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  };

  const contextPack = {
    id: "pack-1",
    projectId: "project-1",
    taskId: "record-1",
    projectRevision: 1,
    generatedAt: "2026-07-26T20:00:00.000Z",
    budgetTokens: 100,
    estimatedTokens: 90,
    stableFrame: [],
    task: contextItem,
    related: [],
    omissions: [],
    sourceRevisions: [{ recordId: "record-1", revision: 1 }],
  };

  it("accepts a persisted project at initial revision zero", () => {
    expect(
      projectSchema.parse({
        id: "project-1",
        name: "IntentArc",
        revision: 0,
        primaryRepositoryPath: null,
        createdAt: "2026-07-26T20:00:00.000Z",
        updatedAt: "2026-07-26T20:00:00.000Z",
      }),
    ).toMatchObject({ revision: 0 });
  });

  it("rejects a persisted record with a non-positive revision", () => {
    expect(() =>
      projectRecordSchema.parse({ ...persistedRecord, revision: 0 }),
    ).toThrow();
  });

  it("rejects a persisted self-relationship", () => {
    expect(() =>
      recordRelationshipSchema.parse({
        id: "relationship-1",
        projectId: "project-1",
        fromRecordId: "record-1",
        toRecordId: "record-1",
        kind: "related_to",
        createdAt: "2026-07-26T20:00:00.000Z",
      }),
    ).toThrow("different records");
  });

  it("rejects an unknown field in a nested context record", () => {
    expect(() =>
      contextItemSchema.parse({
        ...contextItem,
        record: { ...persistedRecord, untracked: true },
      }),
    ).toThrow();
  });

  it("rejects an invalid context-omission reason", () => {
    expect(() =>
      contextOmissionSchema.parse({
        recordId: "record-1",
        kind: "task",
        reason: "capacity",
        retrievalRef: "search:record-1",
      }),
    ).toThrow();
  });

  it("rejects a context pack with a non-positive token budget", () => {
    expect(() =>
      taskContextPackSchema.parse({ ...contextPack, budgetTokens: 0 }),
    ).toThrow();
  });

  it("rejects unknown fields nested in a context pack source revision", () => {
    expect(() =>
      taskContextPackSchema.parse({
        ...contextPack,
        sourceRevisions: [
          { recordId: "record-1", revision: 1, untracked: true },
        ],
      }),
    ).toThrow();
  });

  it("defaults a pre-v11 context pack to the exact Neutral vocabulary", () => {
    expect(taskContextPackSchema.parse(contextPack).hierarchyVocabulary).toEqual(
      neutralHierarchyVocabulary,
    );
  });

  it("preserves an explicit context-pack vocabulary", () => {
    expect(taskContextPackSchema.parse({
      ...contextPack,
      hierarchyVocabulary: softwareHierarchyVocabulary,
    }).hierarchyVocabulary).toEqual(softwareHierarchyVocabulary);
  });
});
