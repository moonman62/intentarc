import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationError, type AuthenticatedProfile } from "../domain/index.js";
import { createContextPackStore } from "../storage/context-pack-store.js";
import {
  createCoordinationStore,
  type AuthorizedClaimCommand,
  type AuthorizedDelegationCommand,
  type CoordinationStore,
} from "../storage/coordination-store.js";
import { openDatabase, type IntentArcDatabase } from "../storage/database.js";
import { createProfileStore } from "../storage/profile-store.js";
import { createProjectStore } from "../storage/project-store.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { createContextService } from "./context-service.js";
import { createChangeService } from "./change-service.js";
import { createCoordinationService } from "./coordination-service.js";
import { createProfileService } from "./profile-service.js";
import { createProposalService } from "./proposal-service.js";

const t0 = "2026-08-15T10:00:00.000Z";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const checkpoint = (summary = "Progress") => ({
  summary,
  completedWork: ["Implemented storage"],
  remainingWork: ["Run verification"],
  blockers: [],
  verificationEvidence: { tests: ["focused tests"], artifacts: [] },
  repositoryEvidence: null,
});

describe("CoordinationService", () => {
  let database: IntentArcDatabase | undefined;
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporary) removeTemporaryDatabase(temporary);
    temporary = undefined;
  });

  const setup = (withAuthority = true) => {
    temporary = createTemporaryDatabase();
    database = openDatabase(temporary.path, { now: () => t0, storeId: "coordination-service-test" });
    database.prepare(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES ('project-1', 'Project', 4, NULL, ?, ?)
    `).run(t0, t0);
    for (const [ordinal, taskId] of ["task-current", "task-next"].entries()) {
      database.prepare(`
        INSERT INTO project_records
          (id, project_id, kind, status, title, body, source_kind, source_ref, revision, created_at, updated_at)
        VALUES (?, 'project-1', 'task', 'active', ?, 'Body', 'human', NULL, 1, ?, ?)
      `).run(taskId, taskId, `2026-08-15T09:00:0${ordinal}.000Z`, t0);
    }
    const profileStore = createProfileStore(database);
    const profileIds = withAuthority
      ? ["profile-1", "authority-1", "audit-profile", "profile-2", "authority-2", "audit-child"]
      : ["profile-1", "audit-profile", "profile-2", "authority-2", "audit-child"];
    const profileService = createProfileService({
      profileStore,
      now: () => t0,
      newId: () => profileIds.shift() ?? "audit-later",
      generateToken: () => "raw-token-never-forwarded",
    });
    profileService.createProfile({
      name: "Worker",
      ...(withAuthority ? { projectId: "project-1" } : {}),
    });
    profileService.createProfile({ name: "Child", projectId: "project-1" });
    const principal = profileService.authenticate({
      profileId: "profile-1",
      token: "raw-token-never-forwarded",
    })!;
    const childPrincipal = profileService.authenticate({
      profileId: "profile-2",
      token: "raw-token-never-forwarded",
    })!;
    const projectStore = createProjectStore(database, { now: () => t0, newId: () => "unused-project-id" });
    let packOrdinal = 0;
    const contextService = createContextService({
      projectStore,
      contextPackStore: createContextPackStore(database),
      now: () => t0,
      newId: () => `pack-${++packOrdinal}`,
      estimateTokens: () => 1,
    });
    const coordinationStore = createCoordinationStore(database, { now: () => t0 });
    let governanceOrdinal = 0;
    const governanceStore = createGovernanceStore(database, {
      newId: (prefix) => `${prefix}-coordination-${++governanceOrdinal}`,
    });
    const changeService = createChangeService({
      governanceStore,
      profileStore,
      now: () => t0,
    });
    const proposalService = createProposalService({ governanceStore, now: () => t0 });
    let coordinationOrdinal = 0;
    const allocatedIds: string[] = [];
    const newId = (prefix: string) => {
      const id = `${prefix}-${++coordinationOrdinal}`;
      allocatedIds.push(id);
      return id;
    };
    const service = createCoordinationService({
      coordinationStore,
      changeService,
      contextService,
      profileService,
      profileStore,
      now: () => t0,
      newId,
    });
    return {
      profileStore, profileService, principal, childPrincipal, coordinationStore,
      governanceStore, changeService, proposalService, contextService, service, allocatedIds, newId,
    };
  };

  const claimInput = () => ({
    projectId: "project-1",
    taskId: "task-current",
    expectedProjectRevision: 4,
    expectedTaskRevision: 1,
    contextBudgetTokens: 100,
    acceptedDelegationId: null,
    idempotencyKey: "claim-1",
  });

  const delegationInput = (taskId = "task-next") => ({
    projectId: "project-1",
    taskId,
    childProfileId: "profile-2",
    expectedProjectRevision: 4,
    expectedTaskRevision: 1,
    scope: { summary: "Implement the bounded task.", constraints: ["Keep tests focused."] },
    allowedOutputs: ["create_record", "update_record"],
    deadline: "2026-08-15T11:00:00.000Z",
    idempotencyKey: `delegate-${taskId}`,
  });

  const coordinationSnapshot = () => database!.prepare(`
    SELECT (SELECT COUNT(*) FROM context_packs) AS contexts,
           (SELECT COUNT(*) FROM task_claims) AS claims,
           (SELECT COUNT(*) FROM task_delegations) AS delegations,
           (SELECT COUNT(*) FROM task_checkpoints) AS checkpoints,
           (SELECT COUNT(*) FROM coordination_events) AS events,
           (SELECT COUNT(*) FROM coordination_idempotency) AS replays
  `).get();

  const captureError = (operation: () => unknown): unknown => {
    try {
      operation();
    } catch (error) {
      return error;
    }
    throw new Error("expected operation to throw");
  };

  const expectClosedError = (
    error: unknown,
    code: "coordination_authority_denied" | "coordination_unavailable",
    message: "Coordination authority is denied." | "Coordination is unavailable.",
  ) => {
    expect(error).toMatchObject({ name: "CoordinationError", code, message });
    expect(Object.keys(error as object).sort()).toEqual(["code", "name"]);
    expect("cause" in (error as object)).toBe(false);
    expect(JSON.stringify(error)).toBe(JSON.stringify({ code, name: "CoordinationError" }));
  };

  it("parses, authorizes, hashes, preallocates exact IDs, and builds context inside store calls", () => {
    const fixture = setup();
    let capturedClaim: AuthorizedClaimCommand | undefined;
    const capturingStore: CoordinationStore = {
      ...fixture.coordinationStore,
      claim(command, createContext) {
        capturedClaim = command;
        return fixture.coordinationStore.claim(command, createContext);
      },
    };
    const service = createCoordinationService({
      coordinationStore: capturingStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });

    expect(service.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
    }, fixture.principal).tasks).toHaveLength(2);
    const claimed = service.claimTask(claimInput(), fixture.principal);
    expect(capturedClaim).toMatchObject({
      profileId: "profile-1",
      credentialGeneration: t0,
      requestHash: sha(JSON.stringify(claimInput())),
      now: t0,
      ids: { claimId: "coordination-claim-1", eventId: "coordination-event-2" },
      input: claimInput(),
    });
    expect(JSON.stringify(capturedClaim)).not.toContain("raw-token-never-forwarded");
    expect(claimed.contextPack).toMatchObject({ id: "pack-1", taskId: "task-current" });
    const saved = service.checkpointClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpoint(),
      idempotencyKey: "checkpoint-1",
    }, fixture.principal);
    expect(saved).toMatchObject({ checkpoint: { id: "coordination-checkpoint-3", sequence: 1 } });
    const switched = service.switchTask({
      currentClaimId: claimed.claim.id,
      projectId: "project-1",
      currentTaskId: "task-current",
      expectedCurrentProjectRevision: 4,
      expectedCurrentTaskRevision: 1,
      checkpoint: checkpoint("Switch checkpoint"),
      terminalAction: "pause",
      nextTaskId: "task-next",
      expectedNextProjectRevision: 4,
      expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 100,
      acceptedDelegationId: null,
      idempotencyKey: "switch-1",
    }, fixture.principal);
    expect(switched).toMatchObject({
      checkpoint: { id: "coordination-checkpoint-6", sequence: 2 },
      nextClaim: { id: "coordination-claim-7", taskId: "task-next" },
      contextPack: { id: "pack-2", taskId: "task-next" },
    });
    expect(fixture.allocatedIds).toEqual([
      "coordination-claim-1", "coordination-event-2",
      "coordination-checkpoint-3", "coordination-event-4", "coordination-event-5",
      "coordination-checkpoint-6", "coordination-claim-7", "coordination-event-8",
      "coordination-event-9", "coordination-event-10",
    ]);
  });

  it("creates, accepts, and claims a delegation as the exact current parent and child", () => {
    const fixture = setup();
    const beforeAuthorities = database!.prepare(`
      SELECT profile_id, project_id, mode FROM profile_project_authorities ORDER BY profile_id
    `).all();

    const offered = fixture.service.createDelegation(delegationInput(), fixture.principal);
    expect(offered.delegation).toMatchObject({
      id: "coordination-delegation-1",
      parentProfileId: "profile-1",
      childProfileId: "profile-2",
      state: "offered",
      allowedOutputs: ["create_record", "update_record"],
    });
    const accepted = fixture.service.acceptDelegation({
      delegationId: offered.delegation.id,
      projectId: "project-1",
      taskId: "task-next",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "accept-task-next",
    }, fixture.childPrincipal);
    expect(accepted.delegation).toMatchObject({ state: "accepted", acceptedAt: t0 });
    const claimed = fixture.service.claimTask({
      ...claimInput(),
      taskId: "task-next",
      acceptedDelegationId: offered.delegation.id,
      idempotencyKey: "claim-delegated",
    }, fixture.childPrincipal);
    expect(claimed.claim).toMatchObject({
      id: "coordination-claim-4",
      profileId: "profile-2",
      delegationId: offered.delegation.id,
    });
    expect(database!.prepare("SELECT state, claim_id FROM task_delegations").get())
      .toEqual({ state: "claimed", claim_id: "coordination-claim-4" });
    expect(database!.prepare(`
      SELECT profile_id, project_id, mode FROM profile_project_authorities ORDER BY profile_id
    `).all()).toEqual(beforeAuthorities);
    expect(fixture.allocatedIds).toEqual([
      "coordination-delegation-1", "coordination-event-2",
      "coordination-event-3",
      "coordination-claim-4", "coordination-event-5",
    ]);
  });

  it("binds delegation idempotency to the original precision while storing a canonical deadline", () => {
    const fixture = setup();
    const input = {
      ...delegationInput(),
      deadline: "2026-08-15T11:00:00Z",
      idempotencyKey: "delegate-original-precision",
    };
    let captured: AuthorizedDelegationCommand | undefined;
    const coordinationStore: CoordinationStore = {
      ...fixture.coordinationStore,
      createDelegation(command) {
        captured = command;
        return fixture.coordinationStore.createDelegation(command);
      },
    };
    const service = createCoordinationService({
      coordinationStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });

    const result = service.createDelegation(input, fixture.principal);
    const replay = service.createDelegation(input, fixture.principal);

    expect(captured).toMatchObject({
      requestHash: sha(JSON.stringify(input)),
      input: { deadline: "2026-08-15T11:00:00Z" },
    });
    expect(result.delegation.deadline).toBe("2026-08-15T11:00:00.000Z");
    expect(replay).toEqual(result);
    expect(database!.prepare("SELECT deadline FROM task_delegations").get())
      .toEqual({ deadline: "2026-08-15T11:00:00.000Z" });
  });

  it("enforces delegation resolver role and scope before authority, hashing, IDs, or store mutation", () => {
    const fixture = setup();
    const offered = fixture.service.createDelegation(delegationInput(), fixture.principal);
    const before = coordinationSnapshot();
    const allocatedBefore = [...fixture.allocatedIds];

    const attempts = [
      () => fixture.service.acceptDelegation({
        delegationId: offered.delegation.id,
        projectId: "project-1",
        taskId: "task-next",
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        idempotencyKey: "parent-cannot-accept",
      }, fixture.principal),
      () => fixture.service.acceptDelegation({
        delegationId: offered.delegation.id,
        projectId: "project-1",
        taskId: "task-current",
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        idempotencyKey: "cross-scope-task",
      }, fixture.childPrincipal),
      () => fixture.service.revokeDelegation({
        delegationId: offered.delegation.id,
        projectId: "project-1",
        taskId: "task-next",
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        idempotencyKey: "child-cannot-revoke-parent-record",
      }, fixture.childPrincipal),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
      expect(coordinationSnapshot()).toEqual(before);
      expect(fixture.allocatedIds).toEqual(allocatedBefore);
    }
  });

  it("lets the exact parent revoke after the accepted child is disabled", () => {
    const fixture = setup();
    const offered = fixture.service.createDelegation(delegationInput(), fixture.principal);
    fixture.service.acceptDelegation({
      delegationId: offered.delegation.id,
      projectId: "project-1",
      taskId: "task-next",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "accept-before-disable",
    }, fixture.childPrincipal);
    fixture.profileService.setEnabled("profile-2", false);

    expect(fixture.service.revokeDelegation({
      delegationId: offered.delegation.id,
      projectId: "project-1",
      taskId: "task-next",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "revoke-disabled-child",
    }, fixture.principal).delegation).toMatchObject({
      id: offered.delegation.id,
      state: "revoked",
      endedAt: t0,
    });
  });

  it("never lets the delegation parent perform child claim operations", () => {
    const fixture = setup();
    const offered = fixture.service.createDelegation(delegationInput(), fixture.principal);
    fixture.service.acceptDelegation({
      delegationId: offered.delegation.id,
      projectId: "project-1",
      taskId: "task-next",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "accept-task-next",
    }, fixture.childPrincipal);
    const delegatedClaimInput = {
      ...claimInput(), taskId: "task-next", acceptedDelegationId: offered.delegation.id,
      idempotencyKey: "claim-delegated",
    };
    expect(() => fixture.service.claimTask(delegatedClaimInput, fixture.principal))
      .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
    const claimed = fixture.service.claimTask(delegatedClaimInput, fixture.childPrincipal);
    const before = coordinationSnapshot();

    const parentAttempts = [
      () => fixture.service.checkpointClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        checkpoint: checkpoint(), idempotencyKey: "parent-checkpoint",
      }, fixture.principal),
      () => fixture.service.renewClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        idempotencyKey: "parent-renew",
      }, fixture.principal),
      () => fixture.service.switchTask({
        currentClaimId: claimed.claim.id,
        projectId: "project-1",
        currentTaskId: "task-next",
        expectedCurrentProjectRevision: 4,
        expectedCurrentTaskRevision: 1,
        checkpoint: checkpoint(),
        terminalAction: "pause",
        nextTaskId: "task-current",
        expectedNextProjectRevision: 4,
        expectedNextTaskRevision: 1,
        nextContextBudgetTokens: 100,
        acceptedDelegationId: null,
        idempotencyKey: "parent-switch",
      }, fixture.principal),
      () => fixture.service.submitTaskResult({
        claimId: claimed.claim.id,
        checkpointId: "checkpoint-child",
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        submission: {
          summary: "Attempt parent submit.",
          verificationEvidence: { tests: [], artifacts: [] },
          repositoryEvidence: null,
          changes: { rationale: "Attempt parent submit.", operations: [] },
        },
        idempotencyKey: "parent-submit",
      }, fixture.principal),
    ];
    for (const attempt of parentAttempts) {
      expect(attempt).toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
      expect(coordinationSnapshot()).toEqual(before);
    }
  });

  it("requires an enabled authoritative child when offering a delegation", () => {
    for (const arrange of [
      () => database!.prepare("DELETE FROM profile_project_authorities WHERE profile_id = 'profile-2'").run(),
      () => database!.prepare("UPDATE client_profiles SET status = 'disabled' WHERE id = 'profile-2'").run(),
    ]) {
      const fixture = setup();
      arrange();
      const before = coordinationSnapshot();

      expect(() => fixture.service.createDelegation(delegationInput(), fixture.principal))
        .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
      expect(fixture.allocatedIds).toEqual([]);
      expect(coordinationSnapshot()).toEqual(before);
      database!.close();
      database = undefined;
      removeTemporaryDatabase(temporary!);
      temporary = undefined;
    }
  });

  it("uses the owner-only scope resolver and current project authority before claim-scoped mutation", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const otherPrincipal: AuthenticatedProfile = { ...fixture.principal, id: "profile-other" };
    const before = coordinationSnapshot();

    expect(() => fixture.service.renewClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "renew-other",
    }, otherPrincipal)).toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
    expect(coordinationSnapshot()).toEqual(before);
  });

  it("submits zero-operation worker evidence as one governed completion proposal", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const saved = fixture.service.checkpointClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpoint(),
      idempotencyKey: "checkpoint-submit",
    }, fixture.principal);
    const input = {
      claimId: claimed.claim.id,
      checkpointId: saved.checkpoint.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      submission: {
        summary: "Work is complete.",
        verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Complete the coordinated task.", operations: [] },
      },
      idempotencyKey: "submit-result-1",
    };

    const result = fixture.service.submitTaskResult(input, fixture.principal);

    expect(result).toMatchObject({
      claim: { state: "submitted" },
      submission: { state: "submitted", checkpointId: saved.checkpoint.id },
      proposal: {
        state: "pending",
        projectId: "project-1",
        sourceTaskId: "task-current",
        baseProjectRevision: 4,
        rationale: "Complete the coordinated task.",
      },
    });
    expect(fixture.proposalService.get(result.proposal.id).operations).toEqual([{
      operationId: expect.stringMatching(/^coordination-task-completion-/),
      type: "update_record",
      recordId: "task-current",
      expectedRecordRevision: 1,
      patch: { status: "completed" },
    }]);
    expect(fixture.service.submitTaskResult(input, fixture.principal)).toEqual(result);
    expect(() => fixture.service.submitTaskResult({
      ...input,
      submission: { ...input.submission, summary: "Different bytes." },
    }, fixture.principal)).toThrowError(expect.objectContaining({
      code: "coordination_idempotency_conflict",
    }));
  });

  it("keeps a full-direct profile coordination submission proposal-only", () => {
    const fixture = setup();
    database!.prepare("UPDATE profile_project_authorities SET mode = 'full_direct' WHERE profile_id = 'profile-1'")
      .run();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const saved = fixture.service.checkpointClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpoint(),
      idempotencyKey: "checkpoint-full-direct",
    }, fixture.principal);

    const result = fixture.service.submitTaskResult({
      claimId: claimed.claim.id,
      checkpointId: saved.checkpoint.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      submission: {
        summary: "Complete under full direct authority.",
        verificationEvidence: { tests: ["focused"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Require human review.", operations: [] },
      },
      idempotencyKey: "submission-full-direct",
    }, fixture.principal);

    expect(result.proposal.state).toBe("pending");
    expect(database!.prepare("SELECT status FROM project_records WHERE id = 'task-current'").get())
      .toEqual({ status: "active" });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM change_proposals").get())
      .toEqual({ count: 1 });
  });

  it("fails closed before store mutation after profile revocation or credential rotation", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const sensitiveInput = {
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpoint("secret-document-content"),
      idempotencyKey: "secret-idempotency-key",
    };
    const mutationCalls = [
      () => fixture.service.claimTask({
        ...claimInput(), taskId: "task-next", idempotencyKey: "claim-after-revocation",
      }, fixture.principal),
      () => fixture.service.renewClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        idempotencyKey: "renew-after-revocation",
      }, fixture.principal),
      () => fixture.service.checkpointClaim(sensitiveInput, fixture.principal),
      () => fixture.service.transitionClaim({
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        action: "pause", idempotencyKey: "pause-after-revocation",
      }, fixture.principal),
      () => fixture.service.switchTask({
        currentClaimId: claimed.claim.id,
        projectId: "project-1",
        currentTaskId: "task-current",
        expectedCurrentProjectRevision: 4,
        expectedCurrentTaskRevision: 1,
        checkpoint: checkpoint("secret-switch-document"),
        terminalAction: "pause",
        nextTaskId: "task-next",
        expectedNextProjectRevision: 4,
        expectedNextTaskRevision: 1,
        nextContextBudgetTokens: 100,
        acceptedDelegationId: null,
        idempotencyKey: "switch-after-revocation",
      }, fixture.principal),
    ];
    database!.prepare("UPDATE client_profiles SET status = 'disabled' WHERE id = 'profile-1'").run();
    let before = coordinationSnapshot();
    for (const call of mutationCalls) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "coordination_authority_denied" });
      expect(String(caught)).not.toMatch(/claim-|project-|task-|secret|raw-token|sqlite|path/i);
      expect(coordinationSnapshot()).toEqual(before);
    }

    database!.prepare(`
      UPDATE client_profiles SET status = 'enabled', token_rotated_at = '2026-08-15T10:01:00.000Z'
      WHERE id = 'profile-1'
    `).run();
    before = coordinationSnapshot();
    for (const call of mutationCalls) {
      expect(call).toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
      expect(coordinationSnapshot()).toEqual(before);
    }
    expect(fixture.allocatedIds).toEqual(["coordination-claim-1", "coordination-event-2"]);
  });

  it("parses strict schemas before principal revalidation or ID allocation", () => {
    const fixture = setup();
    let revalidations = 0;
    const service = createCoordinationService({
      coordinationStore: fixture.coordinationStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: {
        revalidatePrincipal(principal) {
          revalidations += 1;
          return fixture.profileService.revalidatePrincipal(principal);
        },
      },
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });
    const injected = "C:\\private\\token-secret-document";
    const error = captureError(() => service.claimTask({
      ...claimInput(),
      [injected]: "attacker-value",
    } as never, fixture.principal));

    expectClosedError(error, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(error)).not.toContain(injected);
    expect(revalidations).toBe(0);
    expect(fixture.allocatedIds).toEqual([]);
    expect(coordinationSnapshot()).toEqual({
      contexts: 0, claims: 0, delegations: 0, checkpoints: 0, events: 0, replays: 0,
    });
  });

  it("sanitizes an unexpected principal revalidation dependency failure before authority lookup", () => {
    const fixture = setup();
    let authorityLookups = 0;
    const service = createCoordinationService({
      coordinationStore: fixture.coordinationStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: {
        revalidatePrincipal() {
          throw new Error("C:\\private\\revalidate-token-secret");
        },
      },
      profileStore: {
        getAuthority(profileId, projectId) {
          authorityLookups += 1;
          return fixture.profileStore.getAuthority(profileId, projectId);
        },
      },
      now: () => t0,
      newId: fixture.newId,
    });

    const error = captureError(() => service.claimTask(claimInput(), fixture.principal));
    expectClosedError(error, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(error)).not.toMatch(/private|revalidate-token-secret/i);
    expect(authorityLookups).toBe(0);
    expect(fixture.allocatedIds).toEqual([]);
  });

  it("sanitizes an owner-scope resolver failure on a claim-scoped operation", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    let authorityLookups = 0;
    const service = createCoordinationService({
      coordinationStore: {
        ...fixture.coordinationStore,
        getOwnedClaimSnapshot() {
          throw new Error("claim-secret C:\\private\\scope-database");
        },
      },
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: {
        getAuthority(profileId, projectId) {
          authorityLookups += 1;
          return fixture.profileStore.getAuthority(profileId, projectId);
        },
      },
      now: () => t0,
      newId: fixture.newId,
    });

    const error = captureError(() => service.renewClaim({
      claimId: claimed.claim.id,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: "renew-scope-failure",
    }, fixture.principal));
    expectClosedError(error, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(error)).not.toMatch(/claim-secret|private|scope-database/i);
    expect(authorityLookups).toBe(0);
    expect(fixture.allocatedIds).toEqual(["coordination-claim-1", "coordination-event-2"]);
  });

  it("resolves only the current authorized owner's exact claim snapshot without mutation", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const before = coordinationSnapshot();

    expect(fixture.service.resolveOwnedClaimSnapshot(claimed.claim.id, fixture.principal))
      .toEqual(claimed.claim);
    const error = captureError(() =>
      fixture.service.resolveOwnedClaimSnapshot(claimed.claim.id, fixture.childPrincipal)
    );
    expectClosedError(
      error,
      "coordination_authority_denied",
      "Coordination authority is denied.",
    );
    expect(coordinationSnapshot()).toEqual(before);
    expect(JSON.stringify(error)).not.toContain(claimed.claim.id);
  });

  it("resolves an authorized delegation's exact immutable snapshot without mutation", () => {
    const fixture = setup();
    const offered = fixture.service.createDelegation(delegationInput(), fixture.principal);
    const input = {
      delegationId: offered.delegation.id,
      projectId: offered.delegation.projectId,
      taskId: offered.delegation.taskId,
    };
    const before = coordinationSnapshot();

    expect(fixture.service.resolveAuthorizedDelegation(input, fixture.principal, "parent"))
      .toEqual(offered.delegation);
    expect(fixture.service.resolveAuthorizedDelegation(input, fixture.childPrincipal, "child"))
      .toEqual(offered.delegation);
    const error = captureError(() =>
      fixture.service.resolveAuthorizedDelegation(input, fixture.childPrincipal, "parent")
    );
    expectClosedError(error, "coordination_authority_denied", "Coordination authority is denied.");
    expect(coordinationSnapshot()).toEqual(before);
    expect(JSON.stringify(error)).not.toContain(offered.delegation.id);
  });

  it("rejects a wrong transport project before every claim-scoped mutation or ID allocation", () => {
    const fixture = setup();
    const claimed = fixture.service.claimTask(claimInput(), fixture.principal);
    const mutationCalls = { renew: 0, checkpoint: 0, transition: 0, submit: 0 };
    const guardedStore: CoordinationStore = {
      ...fixture.coordinationStore,
      renew(command) {
        mutationCalls.renew += 1;
        return fixture.coordinationStore.renew(command);
      },
      checkpoint(command) {
        mutationCalls.checkpoint += 1;
        return fixture.coordinationStore.checkpoint(command);
      },
      transition(command) {
        mutationCalls.transition += 1;
        return fixture.coordinationStore.transition(command);
      },
      submit(command, createProposal) {
        mutationCalls.submit += 1;
        return fixture.coordinationStore.submit(command, createProposal);
      },
    };
    const service = createCoordinationService({
      coordinationStore: guardedStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });
    const expectedProject = { expectedProjectId: "project-other" };
    const before = coordinationSnapshot();
    const calls = [
      () => service.renewClaim({
        claimId: claimed.claim.id,
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        idempotencyKey: "wrong-project-renew",
      }, fixture.principal, expectedProject),
      () => service.checkpointClaim({
        claimId: claimed.claim.id,
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        checkpoint: checkpoint("Wrong project checkpoint"),
        idempotencyKey: "wrong-project-checkpoint",
      }, fixture.principal, expectedProject),
      () => service.transitionClaim({
        claimId: claimed.claim.id,
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        action: "pause",
        idempotencyKey: "wrong-project-transition",
      }, fixture.principal, expectedProject),
      () => service.submitTaskResult({
        claimId: claimed.claim.id,
        checkpointId: "checkpoint-never-read",
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        submission: {
          summary: "Must not submit across projects.",
          verificationEvidence: { tests: [], artifacts: [] },
          repositoryEvidence: null,
          changes: { rationale: "Must remain scoped.", operations: [] },
        },
        idempotencyKey: "wrong-project-submit",
      }, fixture.principal, expectedProject),
    ];

    for (const call of calls) {
      expect(call).toThrowError(expect.objectContaining({
        code: "coordination_authority_denied",
      }));
      expect(coordinationSnapshot()).toEqual(before);
    }
    expect(mutationCalls).toEqual({ renew: 0, checkpoint: 0, transition: 0, submit: 0 });
    expect(fixture.allocatedIds).toEqual([
      "coordination-claim-1",
      "coordination-event-2",
    ]);
  });

  it("sanitizes an authority dependency failure before project-scoped ID allocation", () => {
    const fixture = setup();
    const service = createCoordinationService({
      coordinationStore: fixture.coordinationStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: {
        getAuthority() {
          throw new Error("project-secret C:\\private\\authority-database");
        },
      },
      now: () => t0,
      newId: fixture.newId,
    });

    const error = captureError(() => service.claimTask(claimInput(), fixture.principal));
    expectClosedError(error, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(error)).not.toMatch(/project-secret|private|authority-database/i);
    expect(fixture.allocatedIds).toEqual([]);
  });

  it("denies missing project authority before context creation or store mutation", () => {
    const fixture = setup(false);

    expect(() => fixture.service.claimTask(claimInput(), fixture.principal))
      .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
    expect(fixture.allocatedIds).toEqual([]);
    expect(coordinationSnapshot()).toEqual({
      contexts: 0, claims: 0, delegations: 0, checkpoints: 0, events: 0, replays: 0,
    });
  });

  it("replaces internal store failures with a fixed public error", () => {
    const fixture = setup();
    const failingStore: CoordinationStore = {
      ...fixture.coordinationStore,
      claim() {
        throw new Error("C:\\private\\workspace claim-secret raw-token-never-forwarded document-content");
      },
    };
    const service = createCoordinationService({
      coordinationStore: failingStore,
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });
    let caught: unknown;

    try {
      service.claimTask(claimInput(), fixture.principal);
    } catch (error) {
      caught = error;
    }
    expectClosedError(caught, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(caught)).not.toMatch(/private|workspace|claim-secret|raw-token|document-content/i);
  });

  it("reconstructs a known coordination error instead of exposing a tainted dependency instance", () => {
    const fixture = setup();
    const tainted = new CoordinationError("claim_conflict") as CoordinationError & {
      cause?: unknown;
      data?: unknown;
      unexpected?: unknown;
    };
    tainted.message = "claim-secret C:\\private\\tainted-message";
    tainted.cause = new Error("raw-token-never-forwarded");
    tainted.data = { document: "secret-document-content" };
    tainted.unexpected = "attacker-data";
    const service = createCoordinationService({
      coordinationStore: {
        ...fixture.coordinationStore,
        claim() { throw tainted; },
      },
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });

    const error = captureError(() => service.claimTask(claimInput(), fixture.principal));
    expect(error).not.toBe(tainted);
    expect(error).toMatchObject({
      name: "CoordinationError",
      code: "claim_conflict",
      message: "Task claim conflicts with current coordination state.",
    });
    expect(Object.keys(error as object).sort()).toEqual(["code", "name"]);
    expect("cause" in (error as object)).toBe(false);
    expect("data" in (error as object)).toBe(false);
    expect("unexpected" in (error as object)).toBe(false);
    expect(JSON.stringify(error)).toBe(JSON.stringify({
      code: "claim_conflict",
      name: "CoordinationError",
    }));
    expect(JSON.stringify(error)).not.toMatch(/secret|private|token|attacker/i);
  });

  it("fails closed when a coordination error code accessor is hostile", () => {
    const fixture = setup();
    const hostile = new CoordinationError("claim_conflict");
    Object.defineProperty(hostile, "code", {
      configurable: true,
      enumerable: true,
      get() { throw new Error("code-secret C:\\private\\getter-cause"); },
    });
    const service = createCoordinationService({
      coordinationStore: {
        ...fixture.coordinationStore,
        claim() { throw hostile; },
      },
      changeService: fixture.changeService,
      contextService: fixture.contextService,
      profileService: fixture.profileService,
      profileStore: fixture.profileStore,
      now: () => t0,
      newId: fixture.newId,
    });

    const error = captureError(() => service.claimTask(claimInput(), fixture.principal));
    expectClosedError(error, "coordination_unavailable", "Coordination is unavailable.");
    expect(JSON.stringify(error)).not.toMatch(/code-secret|private|getter-cause/i);
  });
});
