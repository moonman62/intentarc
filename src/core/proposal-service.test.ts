import { describe, expect, it } from "vitest";
import {
  GovernanceError,
  type ChangeProposal,
  type CreateRepositoryRefreshProposalInput,
  type ProposalFilter,
} from "../domain/index.js";
import {
  type AcceptProposalCommand,
  type ChangeProposalDetail,
  type ChangeProposalSummary,
  type CreateRepositoryRefreshProposalCommand,
  type ProposalDecisionResult,
  type RejectProposalCommand,
  type WithdrawProposalCommand,
} from "../storage/governance-store.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { openDatabase } from "../storage/database.js";
import { createTemporaryDatabase, removeTemporaryDatabase } from "../test-support/database.js";
import { createProposalService } from "./proposal-service.js";

const timestamp = "2026-07-27T14:00:00.000Z";

const proposal = (
  overrides: Partial<ChangeProposalDetail> = {},
): ChangeProposalDetail => ({
  id: "proposal-1",
  projectId: "project-1",
  origin: { type: "profile", profileId: "profile-1" },
  sourceTaskId: "task-1",
  predecessorProposalId: null,
  baseProjectRevision: 1,
  state: "pending",
  rationale: "Review this proposal.",
  idempotencyKey: "proposal-key",
  requestHash: "a".repeat(64),
  reviewReason: null,
  reviewerActor: null,
  createdAt: "2026-07-27T12:00:00.000Z",
  updatedAt: "2026-07-27T12:00:00.000Z",
  reviewedAt: null,
  operations: [{
    operationId: "operation-1",
    type: "update_record",
    recordId: "task-1",
    expectedRecordRevision: 1,
    patch: { status: "completed" },
  }],
  ...overrides,
});

const summary = (detail: ChangeProposalDetail): ChangeProposalSummary => ({
  id: detail.id,
  projectId: detail.projectId,
  origin: detail.origin,
  sourceTaskId: detail.sourceTaskId,
  predecessorProposalId: detail.predecessorProposalId,
  baseProjectRevision: detail.baseProjectRevision,
  state: detail.state,
  rationale: detail.rationale,
  idempotencyKey: detail.idempotencyKey,
  reviewReason: detail.reviewReason,
  reviewerActor: detail.reviewerActor,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  reviewedAt: detail.reviewedAt,
});

const harness = (storedProposal: ChangeProposalDetail | null = proposal()) => {
  const calls = {
    filters: [] as ProposalFilter[],
    accepted: [] as AcceptProposalCommand[],
    rejected: [] as RejectProposalCommand[],
    withdrawn: [] as WithdrawProposalCommand[],
    repositoryRefreshCreated: [] as CreateRepositoryRefreshProposalCommand[],
  };
  const acceptedResult: ProposalDecisionResult = {
    outcome: "applied",
    changeId: "change-1",
    proposalId: "proposal-1",
    projectRevision: 2,
    operations: [{
      operationId: "operation-1",
      type: "update_record",
      record: {
        id: "task-1",
        projectId: "project-1",
        kind: "task",
        status: "completed",
        title: "Task",
        body: "Completed through review.",
        sourceKind: "human",
        sourceRef: null,
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }],
  };
  const governanceStore = {
    listProposals(filter: ProposalFilter): ChangeProposalSummary[] {
      calls.filters.push(filter);
      return storedProposal ? [summary(storedProposal)] : [];
    },
    getProposal(proposalId: string): ChangeProposalDetail | null {
      return storedProposal?.id === proposalId ? storedProposal : null;
    },
    acceptProposal(command: AcceptProposalCommand): ProposalDecisionResult {
      calls.accepted.push(command);
      return acceptedResult;
    },
    rejectProposal(command: RejectProposalCommand): ChangeProposalDetail {
      calls.rejected.push(command);
      return proposal({
        state: "rejected",
        reviewReason: command.reason,
        reviewerActor: "local_human",
        updatedAt: command.reviewedAt,
        reviewedAt: command.reviewedAt,
      });
    },
    withdrawProposal(command: WithdrawProposalCommand): ChangeProposalDetail {
      calls.withdrawn.push(command);
      return proposal({
        state: "withdrawn",
        reviewReason: command.reason,
        reviewerActor: "local_human",
        updatedAt: command.reviewedAt,
        reviewedAt: command.reviewedAt,
      });
    },
    createRepositoryRefreshProposal(
      command: CreateRepositoryRefreshProposalCommand,
    ): ChangeProposalDetail {
      calls.repositoryRefreshCreated.push(command);
      return proposal({
        id: "proposal-refresh",
        origin: {
          type: "repository_refresh",
          repositorySnapshotId: command.input.repositorySnapshotId,
        },
        sourceTaskId: null,
        idempotencyKey: null,
        requestHash: null,
        rationale: command.input.rationale,
        operations: command.input.operations,
      });
    },
  };
  return {
    calls,
    acceptedResult,
    service: createProposalService({
      governanceStore,
      now: () => timestamp,
    }),
  };
};

describe("proposal service", () => {
  it("projects a coordination proposal rejection without completing or releasing the claimed task", () => {
    const temporary = createTemporaryDatabase();
    const database = openDatabase(temporary.path);
    try {
      database.exec(`
        INSERT INTO projects (
          id, name, revision, primary_repository_path, created_at, updated_at
        ) VALUES ('project-coordination', 'Project', 1, NULL, '${timestamp}', '${timestamp}');
        INSERT INTO project_records
          (id, project_id, kind, status, title, body, source_kind, source_ref, revision, created_at, updated_at)
        VALUES ('task-coordination', 'project-coordination', 'task', 'active', 'Task', 'Body', 'human', NULL, 1, '${timestamp}', '${timestamp}');
        INSERT INTO client_profiles
          (id, name, status, token_hash, created_at, updated_at, token_rotated_at, last_used_at)
        VALUES ('profile-coordination', 'Worker', 'enabled', '${"a".repeat(64)}', '${timestamp}', '${timestamp}', '${timestamp}', NULL);
        INSERT INTO profile_project_authorities VALUES
          ('authority-coordination', 'profile-coordination', 'project-coordination', 'proposal', '${timestamp}', '${timestamp}');
        INSERT INTO context_packs VALUES
          ('pack-coordination', 'project-coordination', 'task-coordination', 1, 100, 1, '{}', '${timestamp}');
        INSERT INTO task_claims VALUES
          ('claim-coordination', 'project-coordination', 'task-coordination', 'profile-coordination', NULL,
           'submitted', 1, 1, 'pack-coordination', '${timestamp}', '2026-07-27T14:30:00.000Z',
           '2026-07-27T18:00:00.000Z', '${timestamp}', 'checkpoint-coordination');
        INSERT INTO task_checkpoints VALUES
          ('checkpoint-coordination', 'claim-coordination', 1, '{}', '${timestamp}', 1, 1, 'pack-coordination');
      `);
      const ids = ["change-coordination", "proposal-coordination", "audit-coordination"];
      const governanceStore = createGovernanceStore(database, {
        newId: () => ids.shift() ?? "unexpected",
      });
      const created = governanceStore.createProposal({
        profileId: "profile-coordination",
        credentialGeneration: timestamp,
        authorityMode: "proposal",
        scopeDecision: "proposal_mode",
        submittedAt: timestamp,
        input: {
          projectId: "project-coordination",
          baseProjectRevision: 1,
          idempotencyKey: "coordination-submission",
          rationale: "Complete the task.",
          sourceTaskId: "task-coordination",
          predecessorProposalId: null,
          operations: [{
            operationId: "coordination-task-completion",
            type: "update_record",
            recordId: "task-coordination",
            expectedRecordRevision: 1,
            patch: { status: "completed" },
          }],
        },
      });
      expect(created).toMatchObject({ proposalId: "proposal-coordination" });
      database.prepare(`INSERT INTO task_submissions VALUES (
        'submission-coordination', 'claim-coordination', 'checkpoint-coordination',
        'profile-coordination', 'project-coordination', 'task-coordination', 1, 1,
        'pack-coordination', '{}', 'proposal-coordination', 'submitted', ?, NULL
      )`).run(timestamp);
      const service = createProposalService({ governanceStore, now: () => timestamp });

      expect(service.reject({ proposalId: "proposal-coordination", reason: "Needs verification." }))
        .toMatchObject({ state: "rejected" });
      expect(database.prepare("SELECT state FROM task_submissions WHERE id = 'submission-coordination'").get())
        .toEqual({ state: "rejected" });
      expect(database.prepare("SELECT state FROM task_claims WHERE id = 'claim-coordination'").get())
        .toEqual({ state: "submitted" });
      expect(database.prepare("SELECT status FROM project_records WHERE id = 'task-coordination'").get())
        .toEqual({ status: "active" });
    } finally {
      database.close();
      removeTemporaryDatabase(temporary);
    }
  });

  it("lists normalized filters and returns proposal detail without exposing storage concerns", () => {
    const { calls, service } = harness();

    expect(service.list({
      projectId: " project-1 ",
      state: "pending",
    })).toEqual([expect.objectContaining({
      id: "proposal-1",
      state: "pending",
    })]);
    expect(calls.filters).toEqual([{
      projectId: "project-1",
      state: "pending",
    }]);
    expect(service.get(" proposal-1 ")).toEqual(proposal());
  });

  it("maps a missing proposal to a safe domain error for reads and decisions", () => {
    const { service } = harness(null);

    for (const decide of [
      () => service.get("missing"),
      () => service.accept("missing"),
      () => service.reject({ proposalId: "missing", reason: "Reject it." }),
      () => service.withdraw({
        proposalId: "missing",
        reason: "Withdraw it.",
      }),
    ]) {
      expect(decide).toThrowError(
        expect.objectContaining<Partial<GovernanceError>>({
          code: "validation_failed",
          message: "Proposal not found",
        }),
      );
    }
  });

  it("accepts with local command time and no fabricated review reason", () => {
    const { acceptedResult, calls, service } = harness();

    expect(service.accept(" proposal-1 ")).toEqual(acceptedResult);
    expect(calls.accepted).toEqual([{
      proposalId: "proposal-1",
      reason: null,
      reviewedAt: timestamp,
    }]);
  });

  it("creates a strict local repository refresh proposal without profile credentials", () => {
    const { calls, service } = harness();
    const input: CreateRepositoryRefreshProposalInput = {
      projectId: "project-1",
      repositorySnapshotId: "snapshot-candidate",
      baseProjectRevision: 1,
      rationale: "Create reviewed repository meaning.",
      operations: [{
        operationId: "operation-1",
        type: "update_record",
        recordId: "task-1",
        expectedRecordRevision: 1,
        patch: { status: "completed" },
      }],
    };

    expect(service.createRepositoryRefresh({
      ...input,
      projectId: " project-1 ",
      repositorySnapshotId: " snapshot-candidate ",
      rationale: " Create reviewed repository meaning. ",
    })).toMatchObject({
      id: "proposal-refresh",
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "snapshot-candidate",
      },
      idempotencyKey: null,
      requestHash: null,
    });
    expect(calls.repositoryRefreshCreated).toEqual([{
      input,
      createdAt: timestamp,
    }]);
  });

  it("requires and normalizes human reasons for rejection and withdrawal", () => {
    const { calls, service } = harness();

    expect(service.reject({
      proposalId: " proposal-1 ",
      reason: "  It contradicts the accepted decision.  ",
    })).toMatchObject<Partial<ChangeProposal>>({
      state: "rejected",
      reviewReason: "It contradicts the accepted decision.",
      reviewedAt: timestamp,
    });
    expect(service.withdraw({
      proposalId: " proposal-1 ",
      reason: "  The profile superseded this proposal.  ",
    })).toMatchObject<Partial<ChangeProposal>>({
      state: "withdrawn",
      reviewReason: "The profile superseded this proposal.",
      reviewedAt: timestamp,
    });
    expect(calls.rejected).toEqual([{
      proposalId: "proposal-1",
      reason: "It contradicts the accepted decision.",
      reviewedAt: timestamp,
    }]);
    expect(calls.withdrawn).toEqual([{
      proposalId: "proposal-1",
      reason: "The profile superseded this proposal.",
      reviewedAt: timestamp,
    }]);
  });

  it("rejects blank identifiers and reasons before starting a decision", () => {
    const { calls, service } = harness();

    expect(() => service.accept(" ")).toThrowError(
      expect.objectContaining({ name: "ZodError" }),
    );
    expect(() => service.reject({
      proposalId: "proposal-1",
      reason: " ",
    })).toThrowError(expect.objectContaining({ name: "ZodError" }));
    expect(() => service.withdraw({
      proposalId: "proposal-1",
      reason: "\n\t",
    })).toThrowError(expect.objectContaining({ name: "ZodError" }));
    expect(calls.accepted).toEqual([]);
    expect(calls.rejected).toEqual([]);
    expect(calls.withdrawn).toEqual([]);
  });
});
