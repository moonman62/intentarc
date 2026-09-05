import { describe, expect, test } from "vitest";
import type { ProjectMapResponse } from "../../contracts.js";
import { hierarchyLabel } from "./hierarchy-label.js";

type RecordSummary = ProjectMapResponse["selectedPath"][number];

const record = (
  id: string,
  kind: RecordSummary["kind"],
): RecordSummary => ({
  id,
  kind,
  status: kind === "task" ? "active" : "accepted",
  title: `${kind} ${id}`,
  revision: 1,
});

const software: ProjectMapResponse["hierarchyVocabulary"] = {
  preset: "software",
  outcome: "Product outcome",
  initiative: "Epic",
  deliverable: "Feature",
  milestone: "Milestone",
  task: "Story or Task",
  nestedTask: "Subtask",
};

const neutral: ProjectMapResponse["hierarchyVocabulary"] = {
  preset: "neutral",
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
};

describe("hierarchyLabel", () => {
  test.each([
    [record("initiative", "initiative"), record("outcome", "outcome"), software, "Epic"],
    [record("deliverable", "deliverable"), record("initiative", "initiative"), software, "Feature"],
    [record("story", "task"), record("deliverable", "deliverable"), software, "Story or Task"],
    [record("subtask", "task"), record("story", "task"), software, "Subtask"],
    [record("milestone", "milestone"), record("initiative", "initiative"), neutral, "Milestone"],
  ] as const)(
    "maps $0.kind under $1.kind through the selected vocabulary",
    (child, parent, vocabulary, expected) => {
      expect(hierarchyLabel(child, parent, vocabulary)).toBe(expected);
    },
  );

  test("rejects a non-hierarchy record instead of assigning a misleading label", () => {
    expect(() => hierarchyLabel(
      record("decision", "decision") as never,
      null,
      neutral,
    )).toThrow("Unsupported hierarchy record kind: decision");
  });
});
