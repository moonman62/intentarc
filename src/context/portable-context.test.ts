import { describe, expect, it } from "vitest";
import type {
  ContextItem,
  HierarchyVocabulary,
  ProjectRecord,
  TaskContextPack,
} from "../domain/index.js";
import {
  simpleHierarchyVocabulary,
  softwareHierarchyVocabulary,
} from "../domain/index.js";
import { formatTaskContextPack } from "./portable-context.js";

const timestamp = "2026-07-29T10:00:00.000Z";

const item = (
  record: Partial<ProjectRecord> & Pick<ProjectRecord, "id" | "kind" | "title" | "body">,
  mandatory: boolean,
  relevance: ContextItem["relevance"],
): ContextItem => ({
  record: {
    projectId: "project-1",
    status: record.kind === "task" ? "active" : "accepted",
    sourceKind: "human",
    sourceRef: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...record,
  },
  mandatory,
  relevance,
  relationshipKind: null,
});

describe("formatTaskContextPack", () => {
  it("encodes every vocabulary role exactly once with lossless labels", () => {
    const vocabulary: HierarchyVocabulary = {
      preset: "software",
      outcome: "Outcome \u2028 > \"north\"",
      initiative: "Shared \u202e / Δ",
      deliverable: "Shared \u202e / Δ",
      milestone: "Milestone\u2029: [gate]",
      task: "Task \u2066| isolate\u2069",
      nestedTask: "Subtask \u200emark \u{E0001}`review`",
    };
    const pack: TaskContextPack = {
      id: "context-exact-vocabulary",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 7,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 100,
      hierarchyVocabulary: vocabulary,
      stableFrame: [],
      task: item({
        id: "task-1",
        kind: "task",
        title: "Carry exact hierarchy labels",
        body: "Keep portable text authoritative.",
      }, true, "active_task"),
      related: [],
      omissions: [],
      sourceRevisions: [{ recordId: "task-1", revision: 1 }],
    };

    const markdown = formatTaskContextPack(pack);
    const vocabularyLines = markdown.split("\n").filter((line) =>
      line.startsWith("Hierarchy vocabulary (JSON): ")
    );

    expect(vocabularyLines).toEqual([
      "Hierarchy vocabulary (JSON): " +
      '{"preset":"software","outcome":"Outcome \\u2028 > \\"north\\"","initiative":"Shared \\u202e / Δ","deliverable":"Shared \\u202e / Δ","milestone":"Milestone\\u2029: [gate]","task":"Task \\u2066| isolate\\u2069","nestedTask":"Subtask \\u200emark \\udb40\\udc01`review`"}',
    ]);
    const encoded = vocabularyLines[0]!.slice("Hierarchy vocabulary (JSON): ".length);
    expect(encoded).not.toMatch(/[\p{Zl}\p{Zp}\p{Cf}]/u);
    expect(JSON.parse(encoded)).toEqual(vocabulary);
    for (const role of [
      "preset",
      "outcome",
      "initiative",
      "deliverable",
      "milestone",
      "task",
      "nestedTask",
    ]) {
      expect(encoded.match(new RegExp(`"${role}":`, "g"))).toHaveLength(1);
    }
  });

  it("renders deterministic portable Markdown with explicit omissions", () => {
    const pack: TaskContextPack = {
      id: "context-1",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 7,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 321,
      stableFrame: [
        item({
          id: "vision-1",
          kind: "vision",
          title: "Deterministic runs",
          body: "Keep generated encounters reproducible.",
        }, true, "stable_frame"),
      ],
      task: item({
        id: "task-1",
        kind: "task",
        title: "Verify deterministic encounter seeds",
        body: "Confirm identical seeds produce identical encounters.",
      }, true, "active_task"),
      related: [],
      omissions: [{
        recordId: "decision-2",
        kind: "decision",
        reason: "budget",
        retrievalRef: "record:decision-2",
      }],
      sourceRevisions: [
        { recordId: "vision-1", revision: 1 },
        { recordId: "task-1", revision: 1 },
      ],
    };

    const markdown = formatTaskContextPack(pack);

    expect(markdown).toContain(
      "# Task Context: Verify deterministic encounter seeds",
    );
    expect(markdown).toContain("## Project frame");
    expect(markdown).toContain(
      'Hierarchy vocabulary (JSON): {"preset":"neutral","outcome":"Outcome","initiative":"Initiative","deliverable":"Deliverable","milestone":"Milestone","task":"Work item","nestedTask":"Subtask"}',
    );
    expect(markdown).toContain("## Explicit omissions");
    expect(markdown).toContain(
      "- `decision-2` omitted for budget; retrieve with `record:decision-2`",
    );
    expect(formatTaskContextPack(pack)).toBe(markdown);
  });

  it("keeps parent-linked records portable without repository content", () => {
    const parent = item({
      id: "outcome-1",
      kind: "outcome",
      title: "Ship the outcome spine",
      body: "Keep hierarchy authoritative.",
    }, false, "linked");
    parent.relationshipKind = "parent_of";
    const pack: TaskContextPack = {
      id: "context-parent",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 7,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 100,
      stableFrame: [],
      task: item({
        id: "task-1",
        kind: "task",
        title: "Build hierarchy",
        body: "Add parent relationships.",
      }, true, "active_task"),
      related: [parent],
      omissions: [],
      sourceRevisions: [
        { recordId: "outcome-1", revision: 1 },
        { recordId: "task-1", revision: 1 },
      ],
    };

    expect(formatTaskContextPack(pack)).toContain("### Ship the outcome spine");
  });

  it("renders Software vocabulary in fixed semantic order", () => {
    const pack: TaskContextPack = {
      id: "context-software",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 7,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 100,
      hierarchyVocabulary: softwareHierarchyVocabulary,
      stableFrame: [],
      task: item({
        id: "task-1",
        kind: "task",
        title: "Build hierarchy",
        body: "Carry project labels.",
      }, true, "active_task"),
      related: [],
      omissions: [],
      sourceRevisions: [{ recordId: "task-1", revision: 1 }],
    };

    expect(formatTaskContextPack(pack)).toContain(
      'Hierarchy vocabulary (JSON): {"preset":"software","outcome":"Product outcome","initiative":"Epic","deliverable":"Feature","milestone":"Milestone","task":"Story or Task","nestedTask":"Subtask"}',
    );
  });

  it("renders the complete Simple vocabulary", () => {
    const pack: TaskContextPack = {
      id: "context-simple",
      projectId: "project-1",
      taskId: "task-1",
      projectRevision: 7,
      generatedAt: timestamp,
      budgetTokens: 4_000,
      estimatedTokens: 100,
      hierarchyVocabulary: simpleHierarchyVocabulary,
      stableFrame: [],
      task: item({
        id: "task-1",
        kind: "task",
        title: "Simplify hierarchy",
        body: "Display only used Simple tiers.",
      }, true, "active_task"),
      related: [],
      omissions: [],
      sourceRevisions: [{ recordId: "task-1", revision: 1 }],
    };

    expect(pack.hierarchyVocabulary).toEqual({
      preset: "simple",
      outcome: "Outcome",
      initiative: "Initiative",
      deliverable: "Deliverable",
      milestone: "Milestone",
      task: "Task",
      nestedTask: "Subtask",
    });
    expect(formatTaskContextPack(pack)).toContain(
      'Hierarchy vocabulary (JSON): {"preset":"simple","outcome":"Outcome","initiative":"Initiative","deliverable":"Deliverable","milestone":"Milestone","task":"Task","nestedTask":"Subtask"}',
    );
  });
});
