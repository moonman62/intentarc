import { describe, expect, it } from "vitest";
import type {
  AuthenticatedProfile,
  AuthorityMode,
  AuthorityWithScopes,
  ChangeOperation,
  CreateRecordInput,
  CreateRelationshipInput,
  HumanRecordUpdateInput,
  ProfileScope,
  ProjectRecord,
  RecordRelationship,
  SubmitChangeSetInput,
} from "../domain/index.js";
import { GovernanceError } from "../domain/index.js";
import type {
  ApplyDirectCommand,
  ApplyHumanChangeCommand,
  AppliedChangeSetResult,
  CreateProposalCommand,
  RecordSubmissionRejectionCommand,
  SubmissionRejectionResult,
  SubmissionResult,
} from "../storage/governance-store.js";
import {
  createChangeService,
  type ChangeServiceDependencies,
} from "./change-service.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const principal: AuthenticatedProfile = {
  id: "profile-authenticated",
  name: "Authenticated agent",
  status: "enabled",
  credentialGeneration: timestamp,
};

const createOperation: ChangeOperation = {
  operationId: "operation-create",
  type: "create_record",
  localRef: "decision",
  kind: "decision",
  status: "provisional",
  title: "Governed decision",
  body: "Route this operation through governance.",
};

const input = (
  operations: ChangeOperation[] = [createOperation],
): SubmitChangeSetInput => ({
  projectId: "project-1",
  baseProjectRevision: 4,
  idempotencyKey: "request-1",
  rationale: "Apply the authenticated change.",
  sourceTaskId: null,
  predecessorProposalId: null,
  operations,
});

const scope = (
  overrides: Partial<ProfileScope> = {},
): ProfileScope => ({
  id: "scope-decision",
  authorityId: "authority-1",
  operationType: "create_record",
  recordKind: "decision",
  fromRecordKind: null,
  toRecordKind: null,
  relationshipKind: null,
  createdAt: timestamp,
  ...overrides,
});

const assignment = (
  mode: AuthorityMode,
  scopes: ProfileScope[] = [],
): AuthorityWithScopes => ({
  authority: {
    id: "authority-1",
    profileId: principal.id,
    projectId: "project-1",
    mode,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  scopes,
});

type HarnessOptions = {
  assignment: AuthorityWithScopes | null;
  facts?: ReturnType<
    ChangeServiceDependencies["governanceStore"]["inspectChangeSet"]
  >;
  proposalResult?: SubmissionResult;
  directResult?: SubmissionResult;
  earlyResult?: SubmissionResult | null;
  rejectionResult?: SubmissionRejectionResult;
  humanResult?: AppliedChangeSetResult;
  securityError?: GovernanceError;
};

const harness = ({
  assignment: currentAssignment,
  facts = {
    projectRevision: 4,
    operations: [{
      operationId: "operation-create",
      operationType: "create_record",
      recordKind: "decision",
      fromRecordKind: null,
      toRecordKind: null,
      relationshipKind: null,
    }],
  },
  proposalResult = {
    outcome: "proposed",
    changeId: "change-1",
    proposalId: "proposal-1",
    state: "pending",
    replayed: false,
  },
  directResult = {
    outcome: "applied",
    changeId: "change-1",
    projectId: "project-1",
    revisionBefore: 4,
    revisionAfter: 5,
    operations: [],
    replayed: false,
  },
  earlyResult = null,
  rejectionResult = {
    outcome: "rejected",
    changeId: "change-rejected",
    code: "project_authority_missing",
    reason: "project_authority_missing",
    replayed: false,
  },
  humanResult = {
    outcome: "applied",
    projectId: "project-1",
    revisionBefore: 4,
    revisionAfter: 5,
    operations: [],
  },
  securityError,
}: HarnessOptions) => {
  const calls = {
    securityChecks: [] as AuthenticatedProfile[],
    idempotencyResolutions: [] as Parameters<
      ChangeServiceDependencies["governanceStore"]["resolveSubmissionIdempotency"]
    >[0][],
    authorities: [] as Array<{ profileId: string; projectId: string }>,
    inspections: [] as Array<{
      projectId: string;
      operations: ChangeOperation[];
    }>,
    proposals: [] as CreateProposalCommand[],
    directs: [] as ApplyDirectCommand[],
    rejections: [] as RecordSubmissionRejectionCommand[],
    humans: [] as ApplyHumanChangeCommand[],
  };

  const profileStore: ChangeServiceDependencies["profileStore"] = {
    revalidatePrincipal(currentPrincipal) {
      calls.securityChecks.push(currentPrincipal);
      if (securityError) throw securityError;
      return currentPrincipal;
    },
    getAuthority(profileId, projectId) {
      calls.authorities.push({ profileId, projectId });
      return currentAssignment;
    },
  };
  const governanceStore: ChangeServiceDependencies["governanceStore"] = {
    resolveSubmissionIdempotency(command) {
      calls.idempotencyResolutions.push(command);
      return earlyResult;
    },
    inspectChangeSet(projectId, operations) {
      calls.inspections.push({ projectId, operations });
      return facts;
    },
    createProposal(command) {
      calls.proposals.push(command);
      return proposalResult;
    },
    applyDirect(command) {
      calls.directs.push(command);
      return directResult;
    },
    recordSubmissionRejection(command) {
      calls.rejections.push(command);
      return rejectionResult;
    },
    applyHumanChange(command) {
      calls.humans.push(command);
      return humanResult;
    },
  };

  return {
    calls,
    service: createChangeService({
      profileStore,
      governanceStore,
      now: () => timestamp,
    }),
  };
};

describe("authenticated change routing", () => {
  it("validates current principal security before authority or state routing", () => {
    const { calls, service } = harness({
      assignment: assignment("full_direct"),
      securityError: new GovernanceError(
        "profile_disabled",
        "profile_disabled",
      ),
    });

    expect(() => service.submitProfileChange(principal, input())).toThrow(
      expect.objectContaining<Partial<GovernanceError>>({
        code: "profile_disabled",
      }),
    );
    expect(calls.securityChecks).toEqual([principal]);
    expect(calls.authorities).toHaveLength(0);
    expect(calls.idempotencyResolutions).toHaveLength(0);
    expect(calls.inspections).toHaveLength(0);
    expect(calls.proposals).toHaveLength(0);
    expect(calls.directs).toHaveLength(0);
    expect(calls.rejections).toHaveLength(0);
  });

  it("audits and rejects a valid authenticated submission with no project assignment", () => {
    const { calls, service } = harness({ assignment: null });

    expect(service.submitProfileChange(principal, input())).toEqual({
      outcome: "rejected",
      changeId: "change-rejected",
      code: "project_authority_missing",
      reason: "project_authority_missing",
      replayed: false,
    });
    expect(calls.authorities).toEqual([{
      profileId: "profile-authenticated",
      projectId: "project-1",
    }]);
    expect(calls.rejections).toEqual([{
      profileId: "profile-authenticated",
      credentialGeneration: timestamp,
      input: input(),
      rejectedAt: timestamp,
    }]);
    expect(calls.inspections).toHaveLength(0);
    expect(calls.proposals).toHaveLength(0);
    expect(calls.directs).toHaveLength(0);
  });

  it("routes proposal authority to exactly one complete proposal under the authenticated principal", () => {
    const { calls, service } = harness({ assignment: assignment("proposal") });
    const submitted = input();

    expect(service.submitProfileChange(principal, submitted)).toEqual({
      outcome: "proposed",
      changeId: "change-1",
      proposalId: "proposal-1",
      state: "pending",
      replayed: false,
    });
    expect(calls.inspections).toEqual([{
      projectId: "project-1",
      operations: submitted.operations,
    }]);
    expect(calls.proposals).toEqual([{
      profileId: "profile-authenticated",
      credentialGeneration: timestamp,
      authorityMode: "proposal",
      scopeDecision: "proposal_mode",
      input: submitted,
      submittedAt: timestamp,
    }]);
    expect(calls.directs).toHaveLength(0);
  });

  it("applies a scoped direct set only when every operation matches a scope", () => {
    const { calls, service } = harness({
      assignment: assignment("scoped_direct", [scope()]),
    });

    service.submitProfileChange(principal, input());

    expect(calls.directs).toEqual([{
      profileId: "profile-authenticated",
      credentialGeneration: timestamp,
      authorityMode: "scoped_direct",
      scopeDecision: "scope-decision",
      input: input(),
      completedAt: timestamp,
    }]);
    expect(calls.proposals).toHaveLength(0);
  });

  it("stores one complete proposal when a scoped direct set has a mixed match", () => {
    const operations: ChangeOperation[] = [
      createOperation,
      {
        operationId: "operation-task",
        type: "create_record",
        kind: "task",
        status: "provisional",
        title: "Unmatched task",
        body: "This operation forces the complete set to proposal.",
      },
    ];
    const { calls, service } = harness({
      assignment: assignment("scoped_direct", [scope()]),
      facts: {
        projectRevision: 4,
        operations: [
          {
            operationId: "operation-create",
            operationType: "create_record",
            recordKind: "decision",
            fromRecordKind: null,
            toRecordKind: null,
            relationshipKind: null,
          },
          {
            operationId: "operation-task",
            operationType: "create_record",
            recordKind: "task",
            fromRecordKind: null,
            toRecordKind: null,
            relationshipKind: null,
          },
        ],
      },
    });

    service.submitProfileChange(principal, input(operations));

    expect(calls.proposals).toHaveLength(1);
    expect(calls.proposals[0]).toMatchObject({
      profileId: "profile-authenticated",
      authorityMode: "scoped_direct",
      scopeDecision: "scope_fallback",
      input: { operations },
    });
    expect(calls.directs).toHaveLength(0);
  });

  it("maps a full direct applied result to the public project revision shape", () => {
    const appliedRecord: ProjectRecord = {
      id: "record-1",
      projectId: "project-1",
      kind: "decision",
      status: "provisional",
      title: "Governed decision",
      body: "Route this operation through governance.",
      sourceKind: "agent",
      sourceRef: principal.id,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { calls, service } = harness({
      assignment: assignment("full_direct"),
      directResult: {
        outcome: "applied",
        changeId: "change-applied",
        projectId: "project-1",
        revisionBefore: 4,
        revisionAfter: 5,
        operations: [{
          operationId: "operation-create",
          type: "create_record",
          record: appliedRecord,
        }],
        replayed: true,
      },
    });

    expect(service.submitProfileChange(principal, input())).toEqual({
      outcome: "applied",
      changeId: "change-applied",
      projectRevision: 5,
      operations: [{
        operationId: "operation-create",
        type: "create_record",
        record: appliedRecord,
      }],
      replayed: true,
    });
    expect(calls.directs[0]).toMatchObject({
      profileId: "profile-authenticated",
      authorityMode: "full_direct",
      scopeDecision: "full_direct",
    });
    expect(calls.proposals).toHaveLength(0);
  });

  it("routes a full-direct coordination result to a governed proposal without changing ordinary routing", () => {
    const { calls, service } = harness({ assignment: assignment("full_direct") });

    expect(service.submitProfileProposal(principal, input())).toEqual({
      outcome: "proposed",
      changeId: "change-1",
      proposalId: "proposal-1",
      state: "pending",
      replayed: false,
    });
    expect(calls.inspections).toEqual([{
      projectId: "project-1",
      operations: input().operations,
    }]);
    expect(calls.proposals).toEqual([expect.objectContaining({
      profileId: principal.id,
      credentialGeneration: timestamp,
      authorityMode: "full_direct",
      scopeDecision: "proposal_only",
      input: input(),
    })]);
    expect(calls.directs).toEqual([]);
  });

  it("binds forced coordination conflict semantics to resolution and proposal creation", () => {
    const { calls, service } = harness({ assignment: assignment("proposal") });

    service.submitProfileProposal(principal, input(), { forceConflict: true });

    expect(calls.idempotencyResolutions).toEqual([expect.objectContaining({
      forceConflict: true,
      input: input(),
    })]);
    expect(calls.proposals).toEqual([expect.objectContaining({
      forceConflict: true,
      input: input(),
    })]);
  });

  it("maps a replay of an accepted proposal from its stored project revision", () => {
    const { calls, service } = harness({
      assignment: assignment("proposal"),
      proposalResult: {
        outcome: "applied",
        changeId: "change-accepted",
        proposalId: "proposal-accepted",
        projectRevision: 5,
        operations: [],
        replayed: true,
      },
    });

    expect(service.submitProfileChange(principal, input())).toEqual({
      outcome: "applied",
      changeId: "change-accepted",
      projectRevision: 5,
      operations: [],
      replayed: true,
    });
    expect(calls.proposals).toHaveLength(1);
    expect(calls.directs).toHaveLength(0);
  });

  it("returns a structured stale direct conflict without proposing or leaking store-only fields", () => {
    const { calls, service } = harness({
      assignment: assignment("full_direct"),
      directResult: {
        outcome: "conflicted",
        changeId: "change-conflict",
        code: "project_revision_conflict",
        currentProjectRevision: 7,
        expectedProjectRevision: 4,
        replayed: false,
      },
    });

    expect(service.submitProfileChange(principal, input())).toEqual({
      outcome: "conflicted",
      changeId: "change-conflict",
      currentProjectRevision: 7,
      replayed: false,
    });
    expect(calls.directs).toHaveLength(1);
    expect(calls.proposals).toHaveLength(0);
  });

  it("preserves safe rejected fields from the selected store route", () => {
    const { service } = harness({
      assignment: assignment("proposal"),
      proposalResult: {
        outcome: "rejected",
        changeId: "change-existing",
        code: "idempotency_conflict",
        reason: "The idempotency key belongs to another request",
        replayed: false,
      },
    });

    expect(service.submitProfileChange(principal, input())).toEqual({
      outcome: "rejected",
      changeId: "change-existing",
      code: "idempotency_conflict",
      reason: "The idempotency key belongs to another request",
      replayed: false,
    });
  });
});

describe("human compatibility writes", () => {
  it("preserves caller record provenance and returns only the created record", () => {
    const created: ProjectRecord = {
      id: "record-human",
      projectId: "project-1",
      kind: "evidence",
      status: "accepted",
      title: "Repository evidence",
      body: "Preserve the original source.",
      sourceKind: "repository",
      sourceRef: "docs/evidence.md",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { calls, service } = harness({
      assignment: null,
      humanResult: {
        outcome: "applied",
        projectId: "project-1",
        revisionBefore: 4,
        revisionAfter: 5,
        operations: [{
          operationId: "human-create-record",
          type: "create_record",
          record: created,
        }],
      },
    });
    const createInput: CreateRecordInput = {
      projectId: "project-1",
      kind: "evidence",
      status: "accepted",
      title: "Repository evidence",
      body: "Preserve the original source.",
      sourceKind: "repository",
      sourceRef: "docs/evidence.md",
    };

    expect(service.applyHumanRecord(createInput)).toEqual(created);
    expect(calls.humans).toEqual([{
      projectId: "project-1",
      rationale: "Create project record",
      operations: [{
        operationId: "human-create-record",
        type: "create_record",
        kind: "evidence",
        status: "accepted",
        title: "Repository evidence",
        body: "Preserve the original source.",
        sourceKind: "repository",
        sourceRef: "docs/evidence.md",
      }],
      completedAt: timestamp,
    }]);
  });

  it.each(["initiative", "deliverable"] as const)(
    "preserves the %s kind through direct human record creation",
    (kind) => {
      const created: ProjectRecord = {
        id: `record-${kind}`,
        projectId: "project-1",
        kind,
        status: "accepted",
        title: `Created ${kind}`,
        body: `Keep ${kind} as a first-class governed node.`,
        sourceKind: "human",
        sourceRef: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const { calls, service } = harness({
        assignment: null,
        humanResult: {
          outcome: "applied",
          projectId: "project-1",
          revisionBefore: 4,
          revisionAfter: 5,
          operations: [{
            operationId: "human-create-record",
            type: "create_record",
            record: created,
          }],
        },
      });

      expect(service.applyHumanRecord({
        projectId: "project-1",
        kind,
        status: "accepted",
        title: `Created ${kind}`,
        body: `Keep ${kind} as a first-class governed node.`,
        sourceKind: "human",
        sourceRef: null,
      })).toEqual(created);
      expect(calls.humans[0]?.operations[0]).toMatchObject({ kind });
    },
  );

  it("passes the expected record revision and returns only the updated record", () => {
    const updated: ProjectRecord = {
      id: "record-1",
      projectId: "project-1",
      kind: "task",
      status: "completed",
      title: "Completed task",
      body: "Done.",
      sourceKind: "human",
      sourceRef: null,
      revision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { calls, service } = harness({
      assignment: null,
      humanResult: {
        outcome: "applied",
        projectId: "project-1",
        revisionBefore: 4,
        revisionAfter: 5,
        operations: [{
          operationId: "human-update-record",
          type: "update_record",
          record: updated,
        }],
      },
    });
    const updateInput: HumanRecordUpdateInput = {
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 2,
      patch: { title: "Completed task", status: "completed" },
    };

    expect(service.applyHumanRecordUpdate(updateInput)).toEqual(updated);
    expect(calls.humans[0]).toMatchObject({
      projectId: "project-1",
      operations: [{
        operationId: "human-update-record",
        type: "update_record",
        recordId: "record-1",
        expectedRecordRevision: 2,
        patch: { title: "Completed task", status: "completed" },
      }],
    });
  });

  it("returns only the created relationship from a human link", () => {
    const relationship: RecordRelationship = {
      id: "relationship-human",
      projectId: "project-1",
      fromRecordId: "task-1",
      toRecordId: "decision-1",
      kind: "decided_by",
      createdAt: timestamp,
    };
    const { calls, service } = harness({
      assignment: null,
      humanResult: {
        outcome: "applied",
        projectId: "project-1",
        revisionBefore: 4,
        revisionAfter: 5,
        operations: [{
          operationId: "human-create-relationship",
          type: "create_relationship",
          relationship,
        }],
      },
    });
    const relationshipInput: CreateRelationshipInput & { expectedProjectRevision: number } = {
      projectId: "project-1",
      fromRecordId: "task-1",
      toRecordId: "decision-1",
      kind: "decided_by",
      expectedProjectRevision: 4,
    };

    expect(service.applyHumanRelationship(relationshipInput)).toEqual(relationship);
    expect(calls.humans[0]).toMatchObject({
      projectId: "project-1",
      operations: [{
        operationId: "human-create-relationship",
        type: "create_relationship",
        from: { recordId: "task-1" },
        to: { recordId: "decision-1" },
        kind: "decided_by",
      }],
    });
  });

  it("removes a relationship through an exact-revision audited human change", () => {
    const relationship: RecordRelationship = {
      id: "relationship-human",
      projectId: "project-1",
      fromRecordId: "outcome-1",
      toRecordId: "task-1",
      kind: "parent_of",
      createdAt: timestamp,
    };
    const { calls, service } = harness({
      assignment: null,
      humanResult: {
        outcome: "applied",
        projectId: "project-1",
        revisionBefore: 4,
        revisionAfter: 5,
        operations: [{
          operationId: "human-remove-relationship",
          type: "remove_relationship",
          relationship,
        }],
      },
    });

    expect(service.applyHumanRelationshipRemoval({
      projectId: "project-1",
      relationshipId: relationship.id,
      expectedProjectRevision: 4,
    })).toEqual(relationship);
    expect(calls.humans[0]).toMatchObject({
      projectId: "project-1",
      expectedProjectRevision: 4,
      rationale: "Remove record relationship",
      operations: [{
        operationId: "human-remove-relationship",
        type: "remove_relationship",
        relationshipId: relationship.id,
      }],
    });
  });
});
