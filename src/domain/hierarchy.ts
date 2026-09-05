import type { RecordKind } from "./model.js";

const hierarchyRecordKinds: ReadonlySet<RecordKind> = new Set([
  "outcome",
  "initiative",
  "deliverable",
  "milestone",
  "task",
]);

export const isHierarchyRecordKind = (kind: string): boolean =>
  hierarchyRecordKinds.has(kind as RecordKind);
