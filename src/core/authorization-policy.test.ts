import { describe, expect, it } from "vitest";
import type {
  ChangeOperationType,
  ProfileScope,
  RecordKind,
  RelationshipKind,
} from "../domain/index.js";
import { authorize, type OperationFacts } from "./authorization-policy.js";

const operation = (
  operationId: string,
  operationType: ChangeOperationType,
  facts: Partial<Omit<OperationFacts, "operationId" | "operationType">> = {},
): OperationFacts => ({
  operationId,
  operationType,
  recordKind: null,
  fromRecordKind: null,
  toRecordKind: null,
  relationshipKind: null,
  ...facts,
});

const scope = (
  id: string,
  operationType: ChangeOperationType,
  facts: {
    recordKind?: RecordKind | null;
    fromRecordKind?: RecordKind | null;
    toRecordKind?: RecordKind | null;
    relationshipKind?: RelationshipKind | null;
  } = {},
): ProfileScope => ({
  id,
  authorityId: "authority-1",
  operationType,
  recordKind: null,
  fromRecordKind: null,
  toRecordKind: null,
  relationshipKind: null,
  createdAt: "2026-07-27T10:00:00.000Z",
  ...facts,
});

describe("authority policy", () => {
  const facts = [operation("operation-1", "update_record", { recordKind: "task" })];

  it.each([
    ["proposal", "propose"],
    ["full_direct", "apply"],
  ] as const)("routes %s to %s", (mode, action) => {
    expect(authorize({ mode, scopes: [], operations: facts }).action).toBe(action);
  });

  it("returns proposal operation ids in input order", () => {
    expect(authorize({
      mode: "proposal",
      scopes: [],
      operations: [
        operation("operation-2", "create_record", { recordKind: "task" }),
        operation("operation-1", "update_record", { recordKind: "task" }),
      ],
    })).toEqual({
      action: "propose",
      mode: "proposal",
      unmatchedOperationIds: ["operation-2", "operation-1"],
    });
  });

  it("denies when project authority is missing", () => {
    expect(authorize({ mode: null, scopes: [], operations: facts })).toEqual({
      action: "deny",
      code: "project_authority_missing",
      reason: "No authority exists for this profile and project",
    });
  });

  it("applies a scoped-direct record operation when its record kind matches", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-task", "update_record", { recordKind: "task" })],
      operations: facts,
    })).toEqual({
      action: "apply",
      mode: "scoped_direct",
      matchedScopeIds: ["scope-task"],
    });
  });

  it("proposes a scoped-direct record operation when its record kind does not match", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-decision", "update_record", { recordKind: "decision" })],
      operations: facts,
    })).toEqual({
      action: "propose",
      mode: "scoped_direct",
      unmatchedOperationIds: ["operation-1"],
    });
  });

  it("treats nullable scope kind fields as wildcards", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-any-record", "update_record")],
      operations: facts,
    })).toEqual({
      action: "apply",
      mode: "scoped_direct",
      matchedScopeIds: ["scope-any-record"],
    });
  });

  it("requires every relationship kind fact to match within one scope row", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [
        scope("scope-endpoints", "create_relationship", {
          fromRecordKind: "task",
          toRecordKind: "component",
          relationshipKind: "related_to",
        }),
        scope("scope-kind", "create_relationship", {
          fromRecordKind: "decision",
          toRecordKind: "component",
          relationshipKind: "implements",
        }),
      ],
      operations: [operation("relationship-1", "create_relationship", {
        fromRecordKind: "task",
        toRecordKind: "component",
        relationshipKind: "implements",
      })],
    })).toEqual({
      action: "propose",
      mode: "scoped_direct",
      unmatchedOperationIds: ["relationship-1"],
    });
  });

  it("applies a relationship only when one scope row matches its source target and link kinds", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-relationship", "create_relationship", {
        fromRecordKind: "task",
        toRecordKind: "component",
        relationshipKind: "implements",
      })],
      operations: [operation("relationship-1", "create_relationship", {
        fromRecordKind: "task",
        toRecordKind: "component",
        relationshipKind: "implements",
      })],
    })).toEqual({
      action: "apply",
      mode: "scoped_direct",
      matchedScopeIds: ["scope-relationship"],
    });
  });

  it("requires the operation type to match even when scope kind fields are wildcards", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-create", "create_record")],
      operations: facts,
    })).toEqual({
      action: "propose",
      mode: "scoped_direct",
      unmatchedOperationIds: ["operation-1"],
    });
  });

  it("proposes the entire mixed set and keeps unmatched ids in input order", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [scope("scope-task", "update_record", { recordKind: "task" })],
      operations: [
        operation("permitted", "update_record", { recordKind: "task" }),
        operation("unpermitted-first", "update_record", { recordKind: "decision" }),
        operation("unpermitted-second", "create_record", { recordKind: "task" }),
      ],
    })).toEqual({
      action: "propose",
      mode: "scoped_direct",
      unmatchedOperationIds: ["unpermitted-first", "unpermitted-second"],
    });
  });

  it("returns the first matching scope id for each operation in input order", () => {
    expect(authorize({
      mode: "scoped_direct",
      scopes: [
        scope("scope-first", "update_record", { recordKind: "task" }),
        scope("scope-second", "update_record", { recordKind: "task" }),
      ],
      operations: [
        operation("operation-2", "update_record", { recordKind: "task" }),
        operation("operation-1", "update_record", { recordKind: "task" }),
      ],
    })).toEqual({
      action: "apply",
      mode: "scoped_direct",
      matchedScopeIds: ["scope-first", "scope-first"],
    });
  });
});
