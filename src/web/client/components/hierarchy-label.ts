import type { ProjectMapResponse } from "../../contracts.js";

export type HierarchyKind =
  | "outcome"
  | "initiative"
  | "deliverable"
  | "milestone"
  | "task";

type RecordSummary = ProjectMapResponse["selectedPath"][number];

export type HierarchyRecordSummary = Omit<RecordSummary, "kind"> & {
  readonly kind: HierarchyKind;
};

export type HierarchyVocabulary = ProjectMapResponse["hierarchyVocabulary"];

export const hierarchyLabel = (
  record: Pick<HierarchyRecordSummary, "kind">,
  parent: Pick<HierarchyRecordSummary, "kind"> | null,
  vocabulary: HierarchyVocabulary,
): string => {
  if (record.kind === "task" && parent?.kind === "task") {
    return vocabulary.nestedTask;
  }

  switch (record.kind) {
    case "outcome":
    case "initiative":
    case "deliverable":
    case "milestone":
    case "task":
      return vocabulary[record.kind];
    default:
      throw new Error(`Unsupported hierarchy record kind: ${String(record.kind)}`);
  }
};
