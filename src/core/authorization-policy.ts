import type {
  AuthorityMode,
  ChangeOperationType,
  ProfileScope,
  RecordKind,
  RelationshipKind,
} from "../domain/index.js";

export type AuthorizationDecision =
  | {
      action: "apply";
      mode: "full_direct" | "scoped_direct";
      matchedScopeIds: string[];
    }
  | {
      action: "propose";
      mode: "proposal" | "scoped_direct";
      unmatchedOperationIds: string[];
    }
  | {
      action: "deny";
      code: "project_authority_missing";
      reason: string;
    };

export interface OperationFacts {
  operationId: string;
  operationType: ChangeOperationType;
  recordKind: RecordKind | null;
  fromRecordKind: RecordKind | null;
  toRecordKind: RecordKind | null;
  relationshipKind: RelationshipKind | null;
}

export interface AuthorizeInput {
  mode: AuthorityMode | null;
  scopes: readonly ProfileScope[];
  operations: readonly OperationFacts[];
}

const fieldMatches = <Value>(
  scopeValue: Value | null,
  actualValue: Value | null,
): boolean => scopeValue === null || scopeValue === actualValue;

const matchingScope = (
  operation: OperationFacts,
  scopes: readonly ProfileScope[],
): ProfileScope | undefined => scopes.find((scope) =>
  scope.operationType === operation.operationType &&
  fieldMatches(scope.recordKind, operation.recordKind) &&
  fieldMatches(scope.fromRecordKind, operation.fromRecordKind) &&
  fieldMatches(scope.toRecordKind, operation.toRecordKind) &&
  fieldMatches(scope.relationshipKind, operation.relationshipKind),
);

export const authorize = ({ mode, scopes, operations }: AuthorizeInput): AuthorizationDecision => {
  if (mode === null) {
    return {
      action: "deny",
      code: "project_authority_missing",
      reason: "No authority exists for this profile and project",
    };
  }

  if (mode === "proposal") {
    return {
      action: "propose",
      mode,
      unmatchedOperationIds: operations.map(({ operationId }) => operationId),
    };
  }

  if (mode === "full_direct") {
    return {
      action: "apply",
      mode,
      matchedScopeIds: [],
    };
  }

  const matchedScopeIds: string[] = [];
  const unmatchedOperationIds: string[] = [];
  for (const operation of operations) {
    const scope = matchingScope(operation, scopes);
    if (scope) {
      matchedScopeIds.push(scope.id);
    } else {
      unmatchedOperationIds.push(operation.operationId);
    }
  }

  if (unmatchedOperationIds.length > 0) {
    return {
      action: "propose",
      mode,
      unmatchedOperationIds,
    };
  }

  return {
    action: "apply",
    mode,
    matchedScopeIds,
  };
};
