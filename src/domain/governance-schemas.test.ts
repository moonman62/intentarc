import { describe, expect, it } from "vitest";
import { GovernanceError } from "./errors.js";
import {
  addScopeInputSchema,
  auditEventSchema,
  auditFilterSchema,
  changeProposalSchema,
  clientProfileSchema,
  createRepositoryRefreshProposalInputSchema,
  createProfileInputSchema,
  humanRecordUpdateInputSchema,
  idempotencyResultRowSchema,
  isRecordStatusTransitionAllowed,
  profileProjectAuthoritySchema,
  profileScopeSchema,
  proposalFilterSchema,
  proposalOperationRowSchema,
  proposalOriginSchema,
  setAuthorityInputSchema,
  storedClientProfileSchema,
  submitChangeSetInputSchema,
} from "./governance-schemas.js";

const validSet = {
  projectId: "project-1",
  baseProjectRevision: 0,
  idempotencyKey: "task-1:request-1",
  rationale: "Implement the accepted governance design.",
  sourceTaskId: "task-1",
  predecessorProposalId: null,
  operations: [
    {
      operationId: "create-task",
      type: "create_record" as const,
      localRef: "new-task",
      kind: "task" as const,
      status: "provisional" as const,
      title: "Implement governance",
      body: "Define the governance domain contract.",
    },
    {
      operationId: "update-task",
      type: "update_record" as const,
      recordId: "task-existing",
      expectedRecordRevision: 1,
      patch: { status: "active" as const },
    },
    {
      operationId: "relate-task",
      type: "create_relationship" as const,
      from: { recordId: "task-existing" },
      to: { localRef: "new-task" },
      kind: "depends_on" as const,
    },
    {
      operationId: "remove-relationship",
      type: "remove_relationship" as const,
      relationshipId: "relationship-old",
    },
  ],
};

describe("submit change-set input schema", () => {
  it("accepts one valid operation of every supported type", () => {
    expect(submitChangeSetInputSchema.parse(validSet)).toEqual(validSet);
  });

  it("accepts parent hierarchy creation through the governed change boundary", () => {
    const hierarchy = {
      ...validSet,
      operations: [{
        operationId: "parent-outcome",
        type: "create_relationship" as const,
        from: { recordId: "outcome-1" },
        to: { recordId: "milestone-1" },
        kind: "parent_of" as const,
      }],
    };

    expect(submitChangeSetInputSchema.parse(hierarchy)).toEqual(hierarchy);
  });

  it("accepts initiative and deliverable creation through governed proposals", () => {
    const hierarchyNodes = {
      ...validSet,
      operations: [
        {
          operationId: "create-initiative",
          type: "create_record" as const,
          localRef: "initiative",
          kind: "initiative" as const,
          status: "provisional" as const,
          title: "Portable hierarchy",
          body: "Group related deliverables.",
        },
        {
          operationId: "create-deliverable",
          type: "create_record" as const,
          localRef: "deliverable",
          kind: "deliverable" as const,
          status: "provisional" as const,
          title: "Guided project map",
          body: "Deliver the navigable map.",
        },
      ],
    };

    expect(submitChangeSetInputSchema.parse(hierarchyNodes)).toEqual(hierarchyNodes);
  });

  it("normalizes omitted nullable provenance to null", () => {
    const { sourceTaskId: _sourceTaskId, predecessorProposalId: _predecessorProposalId, ...withoutProvenance } = validSet;

    expect(submitChangeSetInputSchema.parse(withoutProvenance)).toEqual({
      ...withoutProvenance,
      sourceTaskId: null,
      predecessorProposalId: null,
    });
  });

  it("rejects an empty operation list", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({ ...validSet, operations: [] }),
    ).toThrow();
  });

  it("rejects duplicate operation identifiers", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          validSet.operations[0],
          { ...validSet.operations[1], operationId: "create-task" },
        ],
      }),
    ).toThrow("operationId");
  });

  it("rejects whitespace-equivalent duplicate update_record targets", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          {
            ...validSet.operations[1],
            operationId: "update-task-first",
            recordId: " task-existing ",
            expectedRecordRevision: 1,
          },
          {
            ...validSet.operations[1],
            operationId: "update-task-second",
            recordId: "task-existing",
            expectedRecordRevision: 2,
          },
        ],
      }),
    ).toThrow("update_record");
  });

  it("rejects duplicate create local references", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          validSet.operations[0],
          { ...validSet.operations[0], operationId: "create-task-copy" },
        ],
      }),
    ).toThrow("localRef");
  });

  it("rejects an update patch with no fields", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [{ ...validSet.operations[1], patch: {} }],
      }),
    ).toThrow();
  });

  it("rejects a self-relationship after reference normalization", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          validSet.operations[0],
          {
            operationId: "self-relationship",
            type: "create_relationship",
            from: { localRef: "new-task" },
            to: { localRef: "new-task" },
            kind: "related_to",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects unknown local references", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          {
            operationId: "unknown-reference",
            type: "create_relationship",
            from: { recordId: "task-existing" },
            to: { localRef: "missing" },
            kind: "related_to",
          },
        ],
      }),
    ).toThrow("localRef");
  });

  it("rejects forward local references", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({
        ...validSet,
        operations: [
          {
            operationId: "forward-reference",
            type: "create_relationship",
            from: { recordId: "task-existing" },
            to: { localRef: "new-task" },
            kind: "related_to",
          },
          validSet.operations[0],
        ],
      }),
    ).toThrow("localRef");
  });

  it("rejects blank rationale, negative revisions, and extra keys", () => {
    expect(() =>
      submitChangeSetInputSchema.parse({ ...validSet, rationale: "  " }),
    ).toThrow();
    expect(() =>
      submitChangeSetInputSchema.parse({ ...validSet, baseProjectRevision: -1 }),
    ).toThrow();
    expect(() =>
      submitChangeSetInputSchema.parse({ ...validSet, untracked: true }),
    ).toThrow();
  });
});

describe("record status transitions", () => {
  it("allows correction and reopening from ordinary statuses", () => {
    expect(isRecordStatusTransitionAllowed("provisional", "active")).toBe(true);
    expect(isRecordStatusTransitionAllowed("completed", "accepted")).toBe(true);
  });

  it("protects explicitly closed statuses from resurrection", () => {
    expect(isRecordStatusTransitionAllowed("rejected", "archived")).toBe(true);
    expect(isRecordStatusTransitionAllowed("rejected", "active")).toBe(false);
    expect(isRecordStatusTransitionAllowed("superseded", "archived")).toBe(true);
    expect(isRecordStatusTransitionAllowed("archived", "archived")).toBe(true);
    expect(isRecordStatusTransitionAllowed("archived", "active")).toBe(false);
  });
});

describe("governance profile and persistence schemas", () => {
  const profile = {
    id: "profile-1",
    name: "Build agent",
    status: "enabled" as const,
    executionMode: "safe" as const,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    tokenRotatedAt: "2026-07-27T00:00:00.000Z",
    lastUsedAt: null,
  };

  it("keeps token hashes out of the public profile schema", () => {
    expect(clientProfileSchema.parse(profile)).toEqual(profile);
    expect(() =>
      clientProfileSchema.parse({ ...profile, tokenHash: "a".repeat(64) }),
    ).toThrow();
    expect(
      storedClientProfileSchema.parse({ ...profile, tokenHash: "a".repeat(64) }),
    ).toEqual({ ...profile, tokenHash: "a".repeat(64) });
    expect(() =>
      storedClientProfileSchema.parse({ ...profile, tokenHash: "A".repeat(64) }),
    ).toThrow();
  });

  it("accepts declared execution modes and rejects unsupported modes", () => {
    expect(clientProfileSchema.parse({ ...profile, executionMode: "safe" }))
      .toMatchObject({ executionMode: "safe" });
    expect(() =>
      clientProfileSchema.parse({ ...profile, executionMode: "dangerous" }),
    ).toThrow();
  });

  it("accepts strict authority and scope rows with explicit nullable wildcards", () => {
    expect(
      profileProjectAuthoritySchema.parse({
        id: "authority-1",
        profileId: "profile-1",
        projectId: "project-1",
        mode: "scoped_direct",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      }),
    ).toMatchObject({ mode: "scoped_direct" });
    expect(
      profileScopeSchema.parse({
        id: "scope-1",
        authorityId: "authority-1",
        operationType: "create_relationship",
        recordKind: null,
        fromRecordKind: "task",
        toRecordKind: null,
        relationshipKind: "depends_on",
        createdAt: "2026-07-27T00:00:00.000Z",
      }),
    ).toMatchObject({ fromRecordKind: "task" });
  });

  it("accepts the documented proposal, operation, result, and audit row shapes", () => {
    expect(
      changeProposalSchema.parse({
        id: "proposal-1",
        projectId: "project-1",
        origin: { type: "profile", profileId: "profile-1" },
        sourceTaskId: null,
        predecessorProposalId: null,
        baseProjectRevision: 0,
        state: "pending",
        rationale: "Need review before applying.",
        idempotencyKey: "task-1:request-1",
        requestHash: "b".repeat(64),
        reviewReason: null,
        reviewerActor: null,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        reviewedAt: null,
      }),
    ).toMatchObject({ state: "pending" });
    expect(
      proposalOperationRowSchema.parse({
        proposalId: "proposal-1",
        position: 0,
        operationId: "create-task",
        operationType: "create_record",
        payloadJson: "{\"kind\":\"task\"}",
        expectedRecordRevision: null,
      }),
    ).toMatchObject({ position: 0 });
    expect(
      idempotencyResultRowSchema.parse({
        profileId: "profile-1",
        projectId: "project-1",
        idempotencyKey: "task-1:request-1",
        changeId: "proposal-1",
        requestHash: "b".repeat(64),
        outcome: "proposed",
        resultJson: "{}",
        createdAt: "2026-07-27T00:00:00.000Z",
      }),
    ).toMatchObject({ outcome: "proposed" });
    expect(
      auditEventSchema.parse({
        id: "audit-1",
        projectId: "project-1",
        actorType: "profile",
        profileId: "profile-1",
        authorityMode: "scoped_direct",
        scopeDecision: "allowed",
        actionCategory: "change_set",
        targetId: "proposal-1",
        idempotencyKey: "task-1:request-1",
        revisionBefore: 0,
        revisionAfter: 1,
        outcome: "proposed",
        reason: null,
        createdAt: "2026-07-27T00:00:00.000Z",
      }),
    ).toMatchObject({ actorType: "profile" });
  });

  it("accepts nonempty persisted request hashes without imposing token-hash rules", () => {
    expect(
      changeProposalSchema.parse({
        id: "proposal-1",
        projectId: "project-1",
        origin: { type: "profile", profileId: "profile-1" },
        sourceTaskId: null,
        predecessorProposalId: null,
        baseProjectRevision: 0,
        state: "pending",
        rationale: "Need review before applying.",
        idempotencyKey: "task-1:request-1",
        requestHash: "request-hash-v1",
        reviewReason: null,
        reviewerActor: null,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        reviewedAt: null,
      }),
    ).toMatchObject({ requestHash: "request-hash-v1" });
  });

  it("uses strict discriminated origins and a client-free repository refresh input", () => {
    expect(proposalOriginSchema.parse({
      type: "profile",
      profileId: " profile-1 ",
    })).toEqual({ type: "profile", profileId: "profile-1" });
    expect(proposalOriginSchema.parse({
      type: "repository_refresh",
      repositorySnapshotId: " snapshot-1 ",
    })).toEqual({
      type: "repository_refresh",
      repositorySnapshotId: "snapshot-1",
    });
    expect(() => proposalOriginSchema.parse({
      type: "repository_refresh",
      repositorySnapshotId: "snapshot-1",
      profileId: "profile-1",
    })).toThrow();

    const input = {
      projectId: " project-1 ",
      repositorySnapshotId: " snapshot-1 ",
      baseProjectRevision: 7,
      rationale: " Propose repository-derived meaning. ",
      operations: [validSet.operations[0]],
    };
    expect(createRepositoryRefreshProposalInputSchema.parse(input)).toEqual({
      projectId: "project-1",
      repositorySnapshotId: "snapshot-1",
      baseProjectRevision: 7,
      rationale: "Propose repository-derived meaning.",
      operations: [validSet.operations[0]],
    });
    expect(() => createRepositoryRefreshProposalInputSchema.parse({
      ...input,
      idempotencyKey: "fake-client-key",
    })).toThrow();
  });
});

describe("governance management input schemas", () => {
  it("accepts the strict profile, authority, scope, and filter boundaries", () => {
    expect(createProfileInputSchema.parse({ name: "Build agent" })).toEqual({
      name: "Build agent",
    });
    expect(
      setAuthorityInputSchema.parse({
        profileId: "profile-1",
        projectId: "project-1",
        mode: "proposal",
      }),
    ).toMatchObject({ mode: "proposal" });
    expect(
      addScopeInputSchema.parse({
        authorityId: "authority-1",
        operationType: "update_record",
        recordKind: "task",
        fromRecordKind: null,
        toRecordKind: null,
        relationshipKind: null,
      }),
    ).toMatchObject({ operationType: "update_record" });
    expect(proposalFilterSchema.parse({ state: "pending" })).toEqual({ state: "pending" });
    expect(auditFilterSchema.parse({ profileId: "profile-1" })).toEqual({
      profileId: "profile-1",
    });
  });

  it("rejects unknown fields at every management boundary", () => {
    expect(() => createProfileInputSchema.parse({ name: "Build agent", extra: true })).toThrow();
    expect(() => proposalFilterSchema.parse({ state: "pending", extra: true })).toThrow();
    expect(() => auditFilterSchema.parse({ profileId: "profile-1", extra: true })).toThrow();
  });
});

describe("human record update input schema", () => {
  it("accepts a strict mutable patch with a positive expected revision", () => {
    expect(
      humanRecordUpdateInputSchema.parse({
        projectId: "project-1",
        recordId: "record-1",
        expectedRecordRevision: 2,
        patch: {
          title: "Updated title",
          status: "completed",
        },
      }),
    ).toEqual({
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 2,
      patch: {
        title: "Updated title",
        status: "completed",
      },
    });
  });

  it.each([
    {
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 0,
      patch: { title: "Updated title" },
    },
    {
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 1,
      patch: {},
    },
    {
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 1,
      patch: { sourceKind: "human" },
    },
    {
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 1,
      patch: { title: "Updated title" },
      sourceRef: "immutable",
    },
  ])("rejects invalid revisions, empty patches, and immutable fields", (input) => {
    expect(() => humanRecordUpdateInputSchema.parse(input)).toThrow();
  });
});

describe("governance errors", () => {
  it("retains a machine-readable code and safe caller-supplied identifiers", () => {
    const error = new GovernanceError("operation_denied", "Operation denied", {
      projectId: "project-1",
      profileId: "profile-1",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("operation_denied");
    expect(error.details).toEqual({ projectId: "project-1", profileId: "profile-1" });
  });
});
