import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  taskCheckpointSchema,
  type AuthenticatedProfile,
  type SubmitChangeSetInput,
  type TaskContextPack,
} from "../domain/index.js";
import { createChangeService } from "../core/change-service.js";
import { createProposalService } from "../core/proposal-service.js";
import { createIntegrityChecker } from "../durability/integrity.js";
import { openDatabase, type IntentArcDatabase } from "./database.js";
import {
  createCoordinationStore,
  type AuthorizedAcceptDelegationCommand,
  type AuthorizedClaimCommand,
  type AuthorizedCheckpointCommand,
  type AuthorizedDelegationCommand,
  type AuthorizedRevokeDelegationCommand,
  type AuthorizedSubmissionCommand,
  type AuthorizedSwitchCommand,
  type CoordinationStoreTestFailpoint,
} from "./coordination-store.js";
import { createContextPackStore } from "./context-pack-store.js";
import { createGovernanceStore } from "./governance-store.js";
import { createProfileStore } from "./profile-store.js";
import { listReadyTasksInputSchema } from "../domain/coordination-schemas.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

const t0 = "2026-08-15T10:00:00.000Z";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("CoordinationStore", () => {
  let temporary: TemporaryDatabase | undefined;
  let database: IntentArcDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporary) removeTemporaryDatabase(temporary);
    temporary = undefined;
  });

  const setup = (projectId = "project-1") => {
    temporary = createTemporaryDatabase();
    database = openDatabase(temporary.path, { now: () => t0, storeId: "store-test" });
    database.prepare(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?)
    `).run(
      projectId, "Project", 4, t0, t0,
    );
    database.prepare(`
      INSERT INTO client_profiles
        (id, name, status, token_hash, created_at, updated_at, token_rotated_at, last_used_at, execution_mode)
      VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
    `).run("profile-1", "Profile", "a".repeat(64), t0, t0, t0);
    database.prepare(`
      INSERT INTO client_profiles
        (id, name, status, token_hash, created_at, updated_at, token_rotated_at, last_used_at, execution_mode)
      VALUES (?, ?, 'enabled', ?, ?, ?, ?, NULL, 'safe')
    `).run("profile-2", "Other", "b".repeat(64), t0, t0, t0);
    for (const [id, profile] of [["authority-1", "profile-1"], ["authority-2", "profile-2"]]) {
      database.prepare(`INSERT INTO profile_project_authorities VALUES (?, ?, ?, 'proposal', ?, ?)`).run(
        id, profile, projectId, t0, t0,
      );
    }
    let ordinal = 0;
    const addRecord = (id: string, kind = "task", status = "active") => {
      ordinal += 1;
      database!.prepare(`
        INSERT INTO project_records
          (id, project_id, kind, status, title, body, source_kind, source_ref, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Body', 'human', NULL, 1, ?, ?)
      `).run(id, projectId, kind, status, id, `2026-08-15T09:00:${String(ordinal).padStart(2, "0")}.000Z`, t0);
    };
    const relate = (from: string, to: string) => database!.prepare(`
      INSERT INTO record_relationships VALUES (?, ?, ?, ?, 'depends_on', ?)
    `).run(`rel-${from}-${to}`, projectId, from, to, t0);
    return { database, addRecord, relate };
  };

  const pack = (taskId: string): TaskContextPack => ({
    id: `pack-${taskId}`,
    projectId: "project-1",
    taskId,
    projectRevision: 4,
    generatedAt: t0,
    budgetTokens: 100,
    estimatedTokens: 10,
    stableFrame: [],
    task: {
      record: {
        id: taskId, projectId: "project-1", kind: "task", status: "active",
        title: taskId, body: "Body", sourceKind: "human", sourceRef: null,
        revision: 1, createdAt: t0, updatedAt: t0,
      },
      mandatory: true,
      relevance: "active_task",
      relationshipKind: null,
    },
    related: [],
    omissions: [],
    sourceRevisions: [{ recordId: taskId, revision: 1 }],
  });

  const claimCommand = (taskId: string, profileId = "profile-1"): AuthorizedClaimCommand => ({
    profileId,
    credentialGeneration: t0,
    requestHash: sha(`${profileId}:${taskId}`),
    now: t0,
    ids: { claimId: `claim-${profileId}-${taskId}`, eventId: `event-${profileId}-${taskId}` },
    input: {
      projectId: "project-1",
      taskId,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      contextBudgetTokens: 100,
      acceptedDelegationId: null,
      idempotencyKey: `claim-${taskId}`,
    },
  });

  const delegationCommand = (taskId = "task-ready"): AuthorizedDelegationCommand => ({
    profileId: "profile-1",
    credentialGeneration: t0,
    requestHash: sha(`delegate:${taskId}`),
    now: t0,
    ids: { delegationId: `delegation-${taskId}`, eventId: `event-delegate-${taskId}` },
    input: {
      projectId: "project-1",
      taskId,
      childProfileId: "profile-2",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      scope: { summary: "Implement the bounded task.", constraints: ["Keep tests focused."] },
      allowedOutputs: ["create_record", "update_record"],
      deadline: "2026-08-15T11:00:00.000Z",
      idempotencyKey: `delegate-${taskId}`,
    },
  });

  const acceptDelegationCommand = (
    delegationId = "delegation-task-ready",
    timestamp = "2026-08-15T10:05:00.000Z",
  ): AuthorizedAcceptDelegationCommand => ({
    profileId: "profile-2",
    credentialGeneration: t0,
    requestHash: sha(`accept:${delegationId}`),
    now: timestamp,
    ids: { eventId: `event-accept-${delegationId}` },
    input: {
      delegationId,
      projectId: "project-1",
      taskId: "task-ready",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: `accept-${delegationId}`,
    },
  });

  const revokeDelegationCommand = (
    delegationId = "delegation-task-ready",
  ): AuthorizedRevokeDelegationCommand => ({
    profileId: "profile-1",
    credentialGeneration: t0,
    requestHash: sha(`revoke:${delegationId}`),
    now: "2026-08-15T10:10:00.000Z",
    ids: { eventId: `event-revoke-${delegationId}` },
    input: {
      delegationId,
      projectId: "project-1",
      taskId: "task-ready",
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      idempotencyKey: `revoke-${delegationId}`,
    },
  });

  const checkpointDocument = () => ({
    summary: "Progress",
    completedWork: ["Implemented storage"],
    remainingWork: ["Run verification"],
    blockers: [],
    verificationEvidence: { tests: ["focused tests"], artifacts: [] },
    repositoryEvidence: null,
  });

  const checkpointCommand = (
    claimId: string,
    key = "checkpoint-1",
    timestamp = "2026-08-15T10:10:00.000Z",
  ): AuthorizedCheckpointCommand => ({
    profileId: "profile-1",
    credentialGeneration: t0,
    requestHash: sha(key),
    now: timestamp,
    ids: {
      checkpointId: `checkpoint-${key}`,
      checkpointEventId: `event-${key}`,
      renewalEventId: `event-renewal-${key}`,
    },
    input: {
      claimId,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      checkpoint: checkpointDocument(),
      idempotencyKey: key,
    },
  });

  const switchCommand = (claimId: string): AuthorizedSwitchCommand => ({
    profileId: "profile-1",
    credentialGeneration: t0,
    requestHash: sha("switch-1"),
    now: "2026-08-15T10:10:00.000Z",
    ids: {
      checkpointId: "checkpoint-switch",
      nextClaimId: "claim-next",
      checkpointEventId: "z-event-switch-checkpoint",
      transitionEventId: "a-event-switch-pause",
      claimEventId: "event-switch-claim",
    },
    input: {
      currentClaimId: claimId,
      projectId: "project-1",
      currentTaskId: "task-current",
      expectedCurrentProjectRevision: 4,
      expectedCurrentTaskRevision: 1,
      checkpoint: checkpointDocument(),
      terminalAction: "pause",
      nextTaskId: "task-next",
      expectedNextProjectRevision: 4,
      expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 100,
      acceptedDelegationId: null,
      idempotencyKey: "switch-1",
    },
  });

  const submissionCommand = (
    claimId: string,
    checkpointId: string,
    overrides: Partial<AuthorizedSubmissionCommand["input"]> = {},
  ): AuthorizedSubmissionCommand => {
    const input = {
      claimId,
      checkpointId,
      expectedProjectRevision: 4,
      expectedTaskRevision: 1,
      submission: {
        summary: "Completed the claimed work.",
        verificationEvidence: { tests: ["pnpm test"], artifacts: [] },
        repositoryEvidence: null,
        changes: { rationale: "Reconcile the completed task.", operations: [] },
      },
      idempotencyKey: "submission-1",
      ...overrides,
    };
    return {
      profileId: "profile-1",
      credentialGeneration: t0,
      requestHash: sha(JSON.stringify(input)),
      now: "2026-08-15T10:15:00.000Z",
      ids: { submissionId: "submission-1", eventId: "event-submission-1" },
      input,
    };
  };

  const governance = (fixture: ReturnType<typeof setup>, profileId = "profile-1") => {
    let ordinal = 0;
    const governanceStore = createGovernanceStore(fixture.database, {
      newId: (prefix) => `${prefix}-submission-${++ordinal}`,
    });
    const profileStore = createProfileStore(fixture.database);
    const changeService = createChangeService({
      governanceStore,
      profileStore,
      now: () => "2026-08-15T10:15:00.000Z",
    });
    const principal: AuthenticatedProfile = {
      id: profileId,
      name: "Profile",
      status: "enabled",
      credentialGeneration: t0,
    };
    return {
      governanceStore,
      proposalService: createProposalService({
        governanceStore,
        now: () => "2026-08-15T10:30:00.000Z",
      }),
      submit: (input: SubmitChangeSetInput, forceConflict = false) =>
        changeService.submitProfileProposal(principal, input, { forceConflict }),
    };
  };

  const dumpCoordinationRows = (fixture: { database: IntentArcDatabase }) => ({
    contexts: fixture.database.prepare("SELECT * FROM context_packs ORDER BY id").all(),
    claims: fixture.database.prepare("SELECT * FROM task_claims ORDER BY id").all(),
    delegations: fixture.database.prepare("SELECT * FROM task_delegations ORDER BY id").all(),
    checkpoints: fixture.database.prepare("SELECT * FROM task_checkpoints ORDER BY id").all(),
    events: fixture.database.prepare("SELECT * FROM coordination_events ORDER BY rowid").all(),
    idempotency: fixture.database.prepare("SELECT * FROM coordination_idempotency ORDER BY rowid").all(),
  });

  it("creates one bounded delegation reservation and replays it exactly", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const command = delegationCommand();

    const first = store.createDelegation(command);
    expect(first).toMatchObject({
      delegation: {
        id: "delegation-task-ready",
        projectId: "project-1",
        taskId: "task-ready",
        parentProfileId: "profile-1",
        childProfileId: "profile-2",
        state: "offered",
        baseProjectRevision: 4,
        baseTaskRevision: 1,
        allowedOutputs: ["create_record", "update_record"],
        offeredAt: t0,
        deadline: "2026-08-15T11:00:00.000Z",
        acceptedAt: null,
        endedAt: null,
        claimId: null,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(first.delegation), "utf8")).toBeLessThanOrEqual(32_768);
    expect(store.createDelegation(command)).toEqual(first);
    expect(fixture.database.prepare("SELECT category, prior_state, resulting_state FROM coordination_events").all())
      .toEqual([{ category: "delegation_offer", prior_state: null, resulting_state: "offered" }]);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM profile_project_authorities").get())
      .toEqual({ count: 2 });

    const competing = delegationCommand();
    competing.ids = { delegationId: "delegation-competing", eventId: "event-competing" };
    competing.requestHash = sha("delegate-competing");
    competing.input.idempotencyKey = "delegate-competing";
    expect(() => store.createDelegation(competing))
      .toThrowError(expect.objectContaining({ code: "delegation_conflict" }));
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_delegations").get())
      .toEqual({ count: 1 });
  });

  it("rejects delegation unless the task is ready, actors are distinct and enabled with authority, and scope is closed", () => {
    const cases: Array<{
      name: string;
      arrange: (fixture: ReturnType<typeof setup>, command: AuthorizedDelegationCommand) => void;
      code: string;
    }> = [
      {
        name: "claimed task",
        arrange(fixture) {
          const store = createCoordinationStore(fixture.database, { now: () => t0 });
          store.claim(claimCommand("task-ready"), () => pack("task-ready"));
        },
        code: "claim_conflict",
      },
      {
        name: "same parent and child",
        arrange(_fixture, command) { command.input.childProfileId = "profile-1"; },
        code: "delegation_conflict",
      },
      {
        name: "disabled child",
        arrange(fixture) {
          fixture.database.prepare("UPDATE client_profiles SET status = 'disabled' WHERE id = 'profile-2'").run();
        },
        code: "coordination_authority_denied",
      },
      {
        name: "missing child authority",
        arrange(fixture) {
          fixture.database.prepare("DELETE FROM profile_project_authorities WHERE profile_id = 'profile-2'").run();
        },
        code: "coordination_authority_denied",
      },
      {
        name: "elapsed deadline",
        arrange(_fixture, command) { command.input.deadline = t0; },
        code: "delegation_expired",
      },
      {
        name: "duplicate outputs",
        arrange(_fixture, command) { command.input.allowedOutputs = ["update_record", "update_record"]; },
        code: "delegation_conflict",
      },
      {
        name: "oversized complete JSON",
        arrange(_fixture, command) {
          command.input.scope.summary = "x".repeat(32_700);
        },
        code: "delegation_conflict",
      },
    ];

    for (const testCase of cases) {
      const fixture = setup();
      fixture.addRecord("task-ready");
      const command = delegationCommand();
      testCase.arrange(fixture, command);
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const before = dumpCoordinationRows(fixture);

      expect(() => store.createDelegation(command), testCase.name)
        .toThrowError(expect.objectContaining({ code: testCase.code }));
      expect(dumpCoordinationRows(fixture), testCase.name).toEqual(before);
      fixture.database.close();
      database = undefined;
      removeTemporaryDatabase(temporary!);
      temporary = undefined;
    }
  });

  it("resolves only an actor's delegation role without expiring or mutating state", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => "2026-08-15T12:00:00.000Z" });
    store.createDelegation(delegationCommand());
    const before = dumpCoordinationRows(fixture);

    expect(store.getDelegationScope("delegation-task-ready", "profile-1"))
      .toEqual({ projectId: "project-1", taskId: "task-ready", role: "parent" });
    expect(store.getDelegationScope("delegation-task-ready", "profile-2"))
      .toEqual({ projectId: "project-1", taskId: "task-ready", role: "child" });
    expect(store.getDelegationScope("delegation-task-ready", "profile-other")).toBeNull();
    expect(store.getDelegationScope("delegation-missing", "profile-1")).toBeNull();
    expect(store.getDelegationForActor("delegation-task-ready", "profile-1"))
      .toMatchObject({
        role: "parent",
        delegation: {
          id: "delegation-task-ready",
          projectId: "project-1",
          taskId: "task-ready",
          parentProfileId: "profile-1",
          childProfileId: "profile-2",
          state: "offered",
        },
      });
    expect(store.getDelegationForActor("delegation-task-ready", "profile-2"))
      .toMatchObject({ role: "child", delegation: { id: "delegation-task-ready" } });
    expect(store.getDelegationForActor("delegation-task-ready", "profile-other")).toBeNull();
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("selects causally later same-timestamp claims and delegations with their evidence", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });

    const parentCommand = claimCommand("task-ready");
    parentCommand.ids.claimId = "claim-z-parent-earlier";
    parentCommand.input.idempotencyKey = "claim-parent-earlier";
    parentCommand.requestHash = sha("claim-parent-earlier");
    const parent = store.claim(parentCommand, () => ({
      ...pack("task-ready"),
      id: "pack-parent-earlier",
    }));
    store.transition({
      profileId: "profile-1",
      credentialGeneration: t0,
      requestHash: sha("release-parent-earlier"),
      now: t0,
      ids: { eventId: "event-release-parent-earlier" },
      input: {
        claimId: parent.claim.id,
        expectedProjectRevision: 4,
        expectedTaskRevision: 1,
        action: "release",
        idempotencyKey: "release-parent-earlier",
      },
    });

    const earlierDelegation = delegationCommand();
    earlierDelegation.ids.delegationId = "delegation-z-earlier";
    earlierDelegation.ids.eventId = "event-delegation-earlier";
    earlierDelegation.input.idempotencyKey = "delegation-earlier";
    earlierDelegation.requestHash = sha("delegation-earlier");
    store.createDelegation(earlierDelegation);
    const revokeEarlier = revokeDelegationCommand("delegation-z-earlier");
    revokeEarlier.now = t0;
    revokeEarlier.input.idempotencyKey = "revoke-delegation-earlier";
    revokeEarlier.requestHash = sha("revoke-delegation-earlier");
    store.revokeDelegation(revokeEarlier);

    const laterDelegation = delegationCommand();
    laterDelegation.ids.delegationId = "delegation-a-later";
    laterDelegation.ids.eventId = "event-delegation-later";
    laterDelegation.input.idempotencyKey = "delegation-later";
    laterDelegation.requestHash = sha("delegation-later");
    store.createDelegation(laterDelegation);
    const acceptLater = acceptDelegationCommand("delegation-a-later", t0);
    acceptLater.input.idempotencyKey = "accept-delegation-later";
    acceptLater.requestHash = sha("accept-delegation-later");
    store.acceptDelegation(acceptLater);

    const childCommand = claimCommand("task-ready", "profile-2");
    childCommand.ids.claimId = "claim-a-child-later";
    childCommand.input.acceptedDelegationId = "delegation-a-later";
    childCommand.input.idempotencyKey = "claim-child-later";
    childCommand.requestHash = sha("claim-child-later");
    const child = store.claim(childCommand, () => ({
      ...pack("task-ready"),
      id: "pack-child-later",
    }));
    const childCheckpoint = checkpointCommand(child.claim.id, "child-later", t0);
    childCheckpoint.profileId = "profile-2";
    childCheckpoint.requestHash = sha("checkpoint-child-later");
    const checkpointed = store.checkpoint(childCheckpoint);
    const childSubmission = submissionCommand(child.claim.id, checkpointed.checkpoint.id, {
      idempotencyKey: "submission-child-later",
    });
    childSubmission.profileId = "profile-2";
    childSubmission.now = t0;
    childSubmission.requestHash = sha(JSON.stringify(childSubmission.input));
    const submitted = store.submit(
      childSubmission,
      governance(fixture, "profile-2").submit as never,
    );

    expect(store.getCoordinationState({
      projectId: "project-1",
      taskId: "task-ready",
      expectedProjectRevision: 4,
    }, "profile-2")).toMatchObject({
      claim: { id: "claim-a-child-later", profileId: "profile-2", state: "submitted" },
      delegation: {
        id: "delegation-a-later",
        state: "claimed",
        claimId: "claim-a-child-later",
      },
      latestCheckpoint: { id: checkpointed.checkpoint.id, claimId: "claim-a-child-later" },
      submission: {
        id: submitted.submission.id,
        claimId: "claim-a-child-later",
        checkpointId: checkpointed.checkpoint.id,
      },
    });
  });

  it("accepts only the exact child before the fixed delegation deadline and revokes only as the parent", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    store.createDelegation(delegationCommand());

    const wrongChild = acceptDelegationCommand();
    wrongChild.profileId = "profile-1";
    expect(() => store.acceptDelegation(wrongChild))
      .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
    const acceptedCommand = acceptDelegationCommand();
    const accepted = store.acceptDelegation(acceptedCommand);
    expect(accepted.delegation).toMatchObject({
      state: "accepted", acceptedAt: "2026-08-15T10:05:00.000Z",
      deadline: "2026-08-15T11:00:00.000Z",
    });
    expect(store.acceptDelegation(acceptedCommand)).toEqual(accepted);

    const wrongParent = revokeDelegationCommand();
    wrongParent.profileId = "profile-2";
    expect(() => store.revokeDelegation(wrongParent))
      .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));
    const revokedCommand = revokeDelegationCommand();
    const revoked = store.revokeDelegation(revokedCommand);
    expect(revoked.delegation).toMatchObject({ state: "revoked", endedAt: revokedCommand.now });
    expect(store.revokeDelegation(revokedCommand)).toEqual(revoked);
    expect(fixture.database.prepare(`
      SELECT category, prior_state, resulting_state FROM coordination_events ORDER BY rowid
    `).all()).toEqual([
      { category: "delegation_offer", prior_state: null, resulting_state: "offered" },
      { category: "delegation_accept", prior_state: "offered", resulting_state: "accepted" },
      { category: "delegation_revoke", prior_state: "accepted", resulting_state: "revoked" },
    ]);
  });

  it("rejects delegation acceptance at the exact deadline with no partial expiry event", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    store.createDelegation(delegationCommand());
    const before = dumpCoordinationRows(fixture);

    expect(() => store.acceptDelegation(acceptDelegationCommand(
      "delegation-task-ready", "2026-08-15T11:00:00.000Z",
    ))).toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("rejects equivalent-instant delegation acceptance at the exact precision boundary", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);
    const before = dumpCoordinationRows(fixture);

    expect(() => store.acceptDelegation(acceptDelegationCommand(
      "delegation-task-ready", "2026-08-15T11:00:00.000Z",
    ))).toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("rejects equivalent-instant delegation revocation at the exact precision boundary", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);
    store.acceptDelegation(acceptDelegationCommand());
    const revoke = revokeDelegationCommand();
    revoke.now = "2026-08-15T11:00:00.000Z";
    const before = dumpCoordinationRows(fixture);

    expect(() => store.revokeDelegation(revoke))
      .toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("allows the authorized parent to revoke exact scope after the child is disabled", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offered = store.createDelegation(delegationCommand());
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    fixture.database.prepare("UPDATE client_profiles SET status = 'disabled' WHERE id = 'profile-2'").run();

    expect(store.revokeDelegation(revokeDelegationCommand(offered.delegation.id)).delegation)
      .toMatchObject({ state: "revoked", endedAt: "2026-08-15T10:10:00.000Z" });
  });

  it("rejects an equivalent-instant direct delegated claim with no context or partial linkage", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);
    store.acceptDelegation(acceptDelegationCommand());
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.input.acceptedDelegationId = "delegation-task-ready";
    delegated.now = "2026-08-15T11:00:00.000Z";
    const before = dumpCoordinationRows(fixture);
    let contextCalls = 0;

    expect(() => store.claim(delegated, () => {
      contextCalls += 1;
      return pack("task-ready");
    })).toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(contextCalls).toBe(0);
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("rejects an equivalent-instant delegated switch with no partial checkpoint or transition", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const currentCommand = claimCommand("task-current", "profile-2");
    currentCommand.now = "2026-08-15T10:40:00.000Z";
    const current = store.claim(currentCommand, () => pack("task-current"));
    const offer = delegationCommand("task-next");
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);
    const accept = acceptDelegationCommand("delegation-task-next");
    accept.input.taskId = "task-next";
    store.acceptDelegation(accept);
    const command = switchCommand(current.claim.id);
    command.profileId = "profile-2";
    command.now = "2026-08-15T11:00:00.000Z";
    command.input.acceptedDelegationId = "delegation-task-next";
    const before = dumpCoordinationRows(fixture);
    let contextCalls = 0;

    expect(() => store.switchTask(command, () => {
      contextCalls += 1;
      return pack("task-next");
    })).toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(contextCalls).toBe(0);
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("expires an equivalent-instant delegation before readiness at the exact precision boundary", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    let readNow = t0;
    let eventOrdinal = 0;
    const store = createCoordinationStore(fixture.database, {
      now: () => readNow,
      newId: () => `event-expiry-${++eventOrdinal}`,
    });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);
    readNow = "2026-08-15T11:00:00.000Z";

    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
    }, "profile-1")).toMatchObject({
      tasks: [{ task: { id: "task-ready" }, blockers: [], liveDelegationId: null }],
    });
    expect(fixture.database.prepare("SELECT state, deadline, ended_at FROM task_delegations").get())
      .toEqual({
        state: "expired",
        deadline: "2026-08-15T11:00:00.000Z",
        ended_at: "2026-08-15T11:00:00.000Z",
      });
    expect(fixture.database.prepare("SELECT category, prior_state, resulting_state FROM coordination_events ORDER BY rowid").all())
      .toEqual([
        { category: "delegation_offer", prior_state: null, resulting_state: "offered" },
        { category: "expiry", prior_state: "offered", resulting_state: "expired" },
      ]);
  });

  it("keeps an equivalent-precision delegation live one millisecond before its deadline", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T11:00:00Z";
    store.createDelegation(offer);

    expect(store.acceptDelegation(acceptDelegationCommand(
      "delegation-task-ready", "2026-08-15T10:59:59.999Z",
    )).delegation).toMatchObject({
      state: "accepted",
      deadline: "2026-08-15T11:00:00.000Z",
      acceptedAt: "2026-08-15T10:59:59.999Z",
    });
  });

  it("fails closed on an invalid delegation operation timestamp without mutation", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand();
    offer.now = "not-a-date";
    const before = dumpCoordinationRows(fixture);

    expect(() => store.createDelegation(offer))
      .toThrowError(expect.objectContaining({ code: "coordination_unavailable" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it.each([
    ["date-only timestamp", "2026-08-15"],
    ["impossible calendar date", "2026-02-30T10:00:00Z"],
    ["non-UTC offset", "2026-08-15T10:00:00+01:00"],
    ["locale date form", "08/15/2026 10:00:00"],
    ["throwing non-string value", {
      [Symbol.toPrimitive]() { throw new Error("runtime-coercion-secret"); },
      toString() { throw new Error("runtime-string-secret"); },
    }],
  ] as Array<[string, unknown]>) (
    "fails closed for a %s passed as an untyped delegation operation time",
    (_case, runtimeNow) => {
      const fixture = setup();
      fixture.addRecord("task-ready");
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const offer = delegationCommand();
      (offer as { now: unknown }).now = runtimeNow;
      const before = dumpCoordinationRows(fixture);
      let caught: unknown;

      try {
        store.createDelegation(offer);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        name: "CoordinationError",
        code: "coordination_unavailable",
        message: "Coordination is unavailable.",
      });
      expect(Object.keys(caught as object).sort()).toEqual(["code", "name"]);
      expect(JSON.stringify(caught)).not.toMatch(/runtime|coercion|string|secret/i);
      expect(dumpCoordinationRows(fixture)).toEqual(before);
    },
  );

  it("requires accepted exact-child delegation claims and atomically links the exact claim id", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    store.createDelegation(delegationCommand());

    expect(() => store.claim(claimCommand("task-ready"), () => pack("task-ready")))
      .toThrowError(expect.objectContaining({ code: "delegation_conflict" }));
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.input.acceptedDelegationId = "delegation-task-ready";
    delegated.ids = { claimId: "claim-exact-child", eventId: "event-exact-child" };
    expect(() => store.claim(delegated, () => pack("task-ready")))
      .toThrowError(expect.objectContaining({ code: "delegation_conflict" }));

    store.acceptDelegation(acceptDelegationCommand());
    const parentClaim = claimCommand("task-ready", "profile-1");
    parentClaim.input.acceptedDelegationId = "delegation-task-ready";
    expect(() => store.claim(parentClaim, () => pack("task-ready")))
      .toThrowError(expect.objectContaining({ code: "coordination_authority_denied" }));

    const claimed = store.claim(delegated, () => pack("task-ready"));
    expect(claimed.claim).toMatchObject({
      id: "claim-exact-child", profileId: "profile-2", delegationId: "delegation-task-ready",
    });
    expect(fixture.database.prepare("SELECT state, claim_id FROM task_delegations").get())
      .toEqual({ state: "claimed", claim_id: "claim-exact-child" });
    expect(fixture.database.prepare("SELECT delegation_id FROM task_claims WHERE id = 'claim-exact-child'").get())
      .toEqual({ delegation_id: "delegation-task-ready" });
  });

  it("lists an active task with no dependencies as ready", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });

    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 20, cursor: null,
    }, "profile-1")).toMatchObject({
      tasks: [{ task: { id: "task-ready" }, blockers: [] }],
      nextCursor: null,
      projectRevision: 4,
    });
  });

  it("claims a ready task and rejects a competing profile", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });

    expect(() => store.claim(claimCommand("task-ready"), () => pack("task-ready"))).not.toThrow();
    let losingCallbackCalls = 0;
    expect(() => store.claim(claimCommand("task-ready", "profile-2"), () => {
      losingCallbackCalls += 1;
      return { ...pack("task-ready"), id: "pack-second" };
    })).toThrowError(expect.objectContaining({ code: "claim_conflict" }));
    expect(losingCallbackCalls).toBe(0);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_claims").get()).toEqual({ count: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM context_packs").get()).toEqual({ count: 1 });
  });

  it("reports stable blockers for incomplete, missing, non-task, and cyclic dependencies", () => {
    const fixture = setup();
    for (const id of ["task-a", "task-b", "task-completed", "task-blocked"]) fixture.addRecord(id);
    fixture.addRecord("done", "task", "completed");
    fixture.addRecord("not-task", "milestone", "active");
    fixture.addRecord("blocked-dependency", "task", "blocked");
    fixture.addRecord("task-blocked-dependency");
    fixture.addRecord("task-not-active", "task", "blocked");
    fixture.relate("task-a", "task-b");
    fixture.relate("task-b", "task-a");
    fixture.relate("task-completed", "done");
    fixture.relate("task-blocked", "not-task");
    fixture.relate("task-blocked-dependency", "blocked-dependency");
    fixture.database.pragma("foreign_keys = OFF");
    fixture.database.prepare(`INSERT INTO record_relationships VALUES (?, 'project-1', ?, ?, 'depends_on', ?)`).run(
      "rel-missing", "task-blocked", "missing", t0,
    );
    fixture.database.pragma("foreign_keys = ON");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });

    const byId = new Map(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 20, cursor: null,
    }, "profile-1").tasks.map((task) => [task.task.id, task.blockers]));
    expect(byId.get("task-a")).toEqual(["dependency_cycle:task-a", "dependency_incomplete:task-b"]);
    expect(byId.get("task-b")).toEqual(["dependency_cycle:task-b", "dependency_incomplete:task-a"]);
    expect(byId.get("task-completed")).toEqual([]);
    expect(byId.get("task-blocked")).toEqual(["dependency_missing:missing", "dependency_not_task:not-task"]);
    expect(byId.get("task-blocked-dependency")).toEqual(["dependency_incomplete:blocked-dependency"]);
    expect(byId.has("task-not-active")).toBe(false);
  });

  it("reports active and submitted claims and live delegations as blockers", () => {
    const fixture = setup();
    for (const id of ["task-active", "task-submitted", "task-delegated"]) fixture.addRecord(id);
    for (const [id, task, state] of [
      ["claim-active", "task-active", "active"],
      ["claim-submitted", "task-submitted", "submitted"],
    ]) {
      const context = pack(task);
      fixture.database.prepare(`INSERT INTO context_packs VALUES (?, ?, ?, 4, 100, 10, ?, ?)`).run(
        context.id, "project-1", task, JSON.stringify(context), t0,
      );
      fixture.database.prepare(`
        INSERT INTO task_claims VALUES (?, 'project-1', ?, 'profile-1', NULL, ?, 4, 1, ?, ?, ?, ?, NULL, NULL)
      `).run(id, task, state, context.id, t0, "2026-08-15T10:30:00.000Z", "2026-08-15T14:00:00.000Z");
    }
    fixture.database.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-1', 'project-1', 'task-delegated', 'profile-1', 'profile-2', 'offered',
        4, 1, '{"summary":"Help","constraints":[]}', '["checkpoint"]', ?,
        '2026-08-15T11:00:00.000Z', NULL, NULL, NULL
      )
    `).run(t0);
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const tasks = store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 20, cursor: null,
    }, "profile-1").tasks;
    const byId = new Map(tasks.map((task) => [task.task.id, task]));

    expect(byId.get("task-active")).toMatchObject({ blockers: ["claim_active:claim-active"], liveClaimId: "claim-active" });
    expect(byId.get("task-submitted")).toMatchObject({ blockers: ["claim_submitted:claim-submitted"], liveClaimId: "claim-submitted" });
    expect(byId.get("task-delegated")).toMatchObject({ blockers: ["delegation_live:delegation-1"], liveDelegationId: "delegation-1" });
  });

  it("sorts by task ID and binds the cursor to project revision and filters", () => {
    const fixture = setup();
    for (const id of ["task-z", "task-a", "task-m"]) fixture.addRecord(id);
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const first = store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 2, cursor: null,
    }, "profile-1");
    expect(first.tasks.map(({ task }) => task.id)).toEqual(["task-a", "task-m"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 2, cursor: first.nextCursor,
    }, "profile-1").tasks.map(({ task }) => task.id)).toEqual(["task-z"]);
    expect(() => store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 3, cursor: first.nextCursor,
    }, "profile-1")).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
    fixture.database.prepare("UPDATE projects SET revision = 5 WHERE id = 'project-1'").run();
    expect(() => store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 5, limit: 2, cursor: first.nextCursor,
    }, "profile-1")).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
  });

  it("round-trips a generated cursor containing maximum-byte valid identifiers through the public schema", () => {
    const maximumUtf8Identifier = "\u0800".repeat(200);
    const laterMaximumUtf8Identifier = "\u0801".repeat(200);
    const fixture = setup(maximumUtf8Identifier);
    fixture.addRecord(maximumUtf8Identifier);
    fixture.addRecord(laterMaximumUtf8Identifier);
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const input = {
      projectId: maximumUtf8Identifier,
      expectedProjectRevision: 4,
      limit: 1,
      cursor: null,
    };

    const first = store.listReadyTasks(input, "profile-1");
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor!.length).toBeGreaterThan(200);
    const parsed = listReadyTasksInputSchema.parse({ ...input, cursor: first.nextCursor });
    expect(store.listReadyTasks(parsed, "profile-1").tasks.map(({ task }) => task.id))
      .toEqual([laterMaximumUtf8Identifier]);
  });

  it("continues pages in SQLite binary order across BMP and non-BMP task IDs", () => {
    const fixture = setup();
    const bmpId = `task-\uE000`;
    const nonBmpId = `task-\u{10000}`;
    fixture.addRecord(nonBmpId);
    fixture.addRecord(bmpId);
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const first = store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 1, cursor: null,
    }, "profile-1");
    const second = store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 1, cursor: first.nextCursor,
    }, "profile-1");

    expect(first.tasks.map(({ task }) => task.id)).toEqual([bmpId]);
    expect(second.tasks.map(({ task }) => task.id)).toEqual([nonBmpId]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects padded, standard, malformed, and non-canonical cursor encodings before use", () => {
    const fixture = setup("project-\uFFFF");
    fixture.addRecord("task-\uFFFF");
    fixture.addRecord("task-\uFFFFx");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const input = {
      projectId: "project-\uFFFF", expectedProjectRevision: 4, limit: 1, cursor: null,
    };
    const cursor = store.listReadyTasks(input, "profile-1").nextCursor!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const paddingBits = cursor.length % 4 === 2 ? 4 : cursor.length % 4 === 3 ? 2 : 0;
    expect(paddingBits).toBeGreaterThan(0);
    const lastIndex = alphabet.indexOf(cursor.at(-1)!);
    const nonCanonical = `${cursor.slice(0, -1)}${alphabet[lastIndex + 1]!}`;
    const standard = cursor.replaceAll("-", "+").replaceAll("_", "/");
    expect(standard).not.toBe(cursor);
    const malformed = `${cursor.slice(0, 5)}$${cursor.slice(5)}`;

    for (const rejected of [`${cursor}=`, standard, malformed, nonCanonical]) {
      expect(() => store.listReadyTasks({ ...input, cursor: rejected }, "profile-1"))
        .toThrowError(expect.objectContaining({ code: "revision_conflict" }));
    }
  });

  it("replays the exact canonical result without invoking context creation again", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const command = claimCommand("task-ready");
    const first = store.claim(command, () => pack("task-ready"));

    const replay = store.claim(command, () => { throw new Error("must not run"); });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(() => store.claim({ ...command, requestHash: "f".repeat(64) }, () => pack("task-ready")))
      .toThrowError(expect.objectContaining({ code: "coordination_idempotency_conflict" }));
  });

  it("expires elapsed claims before readiness at the exact boundary", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    let now = t0;
    const store = createCoordinationStore(fixture.database, {
      now: () => now,
      newId: () => "event-expiry",
    });
    store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    now = "2026-08-15T10:30:00.000Z";

    const task = store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 20, cursor: null,
    }, "profile-2").tasks[0]!;
    expect(task).toMatchObject({ blockers: [], liveClaimId: null });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_claims").get()).toEqual({
      state: "expired", ended_at: now,
    });
    expect(fixture.database.prepare("SELECT category FROM coordination_events WHERE id = 'event-expiry'").get())
      .toEqual({ category: "expiry" });
    expect(store.getCoordinationState({
      projectId: "project-1", taskId: "task-ready", expectedProjectRevision: 4,
    }, "profile-1")).toMatchObject({
      task: { id: "task-ready" }, claim: { state: "expired" }, events: [{ category: "claim" }, { category: "expiry" }],
    });
  });

  it("expires the exact claimed delegation with its elapsed delegated claim", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    let readNow = t0;
    let eventOrdinal = 0;
    const store = createCoordinationStore(fixture.database, {
      now: () => readNow,
      newId: () => `event-delegated-expiry-${++eventOrdinal}`,
    });
    const offered = store.createDelegation(delegationCommand());
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.now = "2026-08-15T10:06:00.000Z";
    delegated.input.acceptedDelegationId = offered.delegation.id;
    const claimed = store.claim(delegated, () => pack("task-ready"));
    readNow = "2026-08-15T10:36:00.000Z";

    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, limit: 20, cursor: null,
    }, "profile-1").tasks[0]).toMatchObject({ blockers: [], liveClaimId: null, liveDelegationId: null });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_claims WHERE id = ?")
      .get(claimed.claim.id)).toEqual({ state: "expired", ended_at: readNow });
    expect(fixture.database.prepare("SELECT state, ended_at, claim_id FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({
      state: "expired", ended_at: readNow, claim_id: claimed.claim.id,
    });
    expect(fixture.database.prepare(`
      SELECT category, claim_id, delegation_id, prior_state, resulting_state
      FROM coordination_events WHERE category = 'expiry'
    `).get()).toEqual({
      category: "expiry", claim_id: claimed.claim.id, delegation_id: offered.delegation.id,
      prior_state: "active", resulting_state: "expired",
    });
    const expiryIntegrityIssues = createIntegrityChecker({ now: () => readNow })
      .checkConnection(fixture.database, "full").issues;
    expect(expiryIntegrityIssues.map(({ code }) => code), JSON.stringify(expiryIntegrityIssues))
      .not.toContain("coordination_state_invalid");
  });

  it("expires a delegated claim at its delegation deadline even after renewal extends the lease", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    fixture.addRecord("task-unrelated");
    let readNow = t0;
    let eventOrdinal = 0;
    const store = createCoordinationStore(fixture.database, {
      now: () => readNow,
      newId: () => `event-deadline-expiry-${++eventOrdinal}`,
    });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T10:45:00.000Z";
    const offered = store.createDelegation(offer);
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.input.acceptedDelegationId = offered.delegation.id;
    const claimed = store.claim(delegated, () => pack("task-ready"));
    const unrelated = store.createDelegation(delegationCommand("task-unrelated"));
    const renewed = store.renew({
      profileId: "profile-2", credentialGeneration: t0,
      requestHash: sha("renew-past-delegation-deadline"),
      now: "2026-08-15T10:20:00.000Z",
      ids: { eventId: "event-renew-past-delegation-deadline" },
      input: {
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        idempotencyKey: "renew-past-delegation-deadline",
      },
    });
    expect(renewed.claim.expiresAt).toBe("2026-08-15T10:50:00.000Z");
    readNow = "2026-08-15T10:45:00.000Z";

    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
    }, "profile-1").tasks[0]).toMatchObject({
      blockers: [], liveClaimId: null, liveDelegationId: null,
    });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_claims WHERE id = ?")
      .get(claimed.claim.id)).toEqual({ state: "expired", ended_at: readNow });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({ state: "expired", ended_at: readNow });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
      .get(unrelated.delegation.id)).toEqual({ state: "offered", ended_at: null });
    expect(fixture.database.prepare(`
      SELECT claim_id, delegation_id, category FROM coordination_events WHERE category = 'expiry'
    `).all()).toEqual([{
      claim_id: claimed.claim.id,
      delegation_id: offered.delegation.id,
      category: "expiry",
    }]);
  });

  it.each(["renew", "checkpoint", "pause", "release"] as const)(
    "%s after a delegation deadline commits exact linked expiry before returning claim_expired",
    (operation) => {
      const fixture = setup();
      fixture.addRecord("task-ready");
      let eventOrdinal = 0;
      const store = createCoordinationStore(fixture.database, {
        now: () => t0,
        newId: () => `event-command-deadline-${++eventOrdinal}`,
      });
      const offer = delegationCommand();
      offer.input.deadline = "2026-08-15T10:25:00.000Z";
      const offered = store.createDelegation(offer);
      store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
      const delegated = claimCommand("task-ready", "profile-2");
      delegated.input.acceptedDelegationId = offered.delegation.id;
      const claimed = store.claim(delegated, () => pack("task-ready"));
      const afterDeadline = "2026-08-15T10:25:00.000Z";

      const invoke = (() => {
        if (operation === "renew") return () => store.renew({
            profileId: "profile-2", credentialGeneration: t0,
            requestHash: sha("renew-after-delegation-deadline"), now: afterDeadline,
            ids: { eventId: "event-unused-renew" },
            input: {
              claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
              idempotencyKey: "renew-after-delegation-deadline",
            },
          });
        if (operation === "checkpoint") return () => {
            const command = checkpointCommand(claimed.claim.id, "after-delegation-deadline", afterDeadline);
            command.profileId = "profile-2";
            command.requestHash = sha("checkpoint-after-delegation-deadline");
            return store.checkpoint(command);
          };
        return () => store.transition({
          profileId: "profile-2", credentialGeneration: t0,
          requestHash: sha(`${operation}-after-delegation-deadline`), now: afterDeadline,
          ids: { eventId: `event-unused-${operation}` },
          input: {
            claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
            action: operation, idempotencyKey: `${operation}-after-delegation-deadline`,
          },
        });
      })();
      expect(invoke).toThrowError(expect.objectContaining({ code: "claim_expired" }));
      expect(fixture.database.prepare("SELECT state, ended_at FROM task_claims WHERE id = ?")
        .get(claimed.claim.id)).toEqual({ state: "expired", ended_at: afterDeadline });
      expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
        .get(offered.delegation.id)).toEqual({ state: "expired", ended_at: afterDeadline });
      expect(fixture.database.prepare(`
        SELECT claim_id, delegation_id FROM coordination_events WHERE category = 'expiry'
      `).all()).toEqual([{ claim_id: claimed.claim.id, delegation_id: offered.delegation.id }]);
    },
  );

  it.each(["switch", "submit"] as const)(
    "%s after a delegation deadline commits linked expiry without partial command writes",
    (operation) => {
      const fixture = setup();
      fixture.addRecord(operation === "switch" ? "task-current" : "task-ready");
      if (operation === "switch") fixture.addRecord("task-next");
      const taskId = operation === "switch" ? "task-current" : "task-ready";
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const offer = delegationCommand(taskId);
      offer.input.deadline = "2026-08-15T10:25:00.000Z";
      const offered = store.createDelegation(offer);
      const accept = acceptDelegationCommand(offered.delegation.id);
      accept.input.taskId = taskId;
      store.acceptDelegation(accept);
      const delegated = claimCommand(taskId, "profile-2");
      delegated.input.acceptedDelegationId = offered.delegation.id;
      const claimed = store.claim(delegated, () => pack(taskId));
      const afterDeadline = "2026-08-15T10:25:00.000Z";

      let invoke: () => unknown;
      if (operation === "switch") {
        const command = switchCommand(claimed.claim.id);
        command.profileId = "profile-2";
        command.now = afterDeadline;
        command.requestHash = sha("switch-after-delegation-deadline");
        command.input.idempotencyKey = "switch-after-delegation-deadline";
        invoke = () => store.switchTask(command, () => pack("task-next"));
      } else {
        const checkpoint = checkpointCommand(
          claimed.claim.id,
          "before-delegation-deadline",
          "2026-08-15T10:20:00.000Z",
        );
        checkpoint.profileId = "profile-2";
        const saved = store.checkpoint(checkpoint);
        const command = submissionCommand(claimed.claim.id, saved.checkpoint.id);
        command.profileId = "profile-2";
        command.now = afterDeadline;
        command.requestHash = sha("submit-after-delegation-deadline");
        command.input.idempotencyKey = "submit-after-delegation-deadline";
        invoke = () => store.submit(command, () => { throw new Error("proposal must not be created"); });
      }

      expect(invoke).toThrowError(expect.objectContaining({ code: "claim_expired" }));
      expect(fixture.database.prepare("SELECT state, ended_at FROM task_claims WHERE id = ?")
        .get(claimed.claim.id)).toEqual({ state: "expired", ended_at: afterDeadline });
      expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
        .get(offered.delegation.id)).toEqual({ state: "expired", ended_at: afterDeadline });
      expect(fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM coordination_events
        WHERE category = 'expiry' AND claim_id = ? AND delegation_id = ?
      `).get(claimed.claim.id, offered.delegation.id)).toEqual({ count: 1 });
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_submissions").get())
        .toEqual({ count: 0 });
      if (operation === "switch") {
        expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_checkpoints").get())
          .toEqual({ count: 0 });
        expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_claims").get())
          .toEqual({ count: 1 });
      }
    },
  );

  it("rolls back deadline expiry for both linked rows when its exact event append fails", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    let readNow = t0;
    const store = createCoordinationStore(fixture.database, {
      now: () => readNow,
      newId: () => delegationCommand().ids.eventId,
    });
    const offer = delegationCommand();
    offer.input.deadline = "2026-08-15T10:25:00.000Z";
    const offered = store.createDelegation(offer);
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.input.acceptedDelegationId = offered.delegation.id;
    const claimed = store.claim(delegated, () => pack("task-ready"));
    const before = dumpCoordinationRows(fixture);
    readNow = "2026-08-15T10:25:00.000Z";

    expect(() => store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
    }, "profile-1")).toThrow(/UNIQUE constraint failed/);
    expect(dumpCoordinationRows(fixture)).toEqual(before);
    expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?")
      .get(claimed.claim.id)).toEqual({ state: "active" });
  });

  it("renews for thirty minutes without passing the exact four-hour horizon", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    expect(claimed.claim).toMatchObject({
      expiresAt: "2026-08-15T10:30:00.000Z",
      absoluteExpiresAt: "2026-08-15T14:00:00.000Z",
    });
    fixture.database.prepare("UPDATE task_claims SET expires_at = absolute_expires_at WHERE id = ?")
      .run(claimed.claim.id);
    const renewed = store.renew({
      profileId: "profile-1", credentialGeneration: t0, requestHash: sha("renew"),
      now: "2026-08-15T13:45:00.000Z", ids: { eventId: "event-renew" },
      input: { claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1, idempotencyKey: "renew-1" },
    });
    expect(renewed.claim.expiresAt).toBe("2026-08-15T14:00:00.000Z");
    expect(() => store.renew({
      profileId: "profile-1", credentialGeneration: t0, requestHash: sha("renew-2"),
      now: "2026-08-15T14:00:00.000Z", ids: { eventId: "event-renew-2" },
      input: { claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1, idempotencyKey: "renew-2" },
    })).toThrowError(expect.objectContaining({ code: "lease_horizon_reached" }));
  });

  it("resolves only the owning profile's immutable claim snapshot without expiring or mutating it", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    fixture.database.prepare("UPDATE task_claims SET expires_at = ? WHERE id = ?")
      .run(t0, claimed.claim.id);
    const before = dumpCoordinationRows(fixture);

    expect(store.getOwnedClaimSnapshot(claimed.claim.id, "profile-1"))
      .toEqual({ ...claimed.claim, expiresAt: t0 });
    expect(store.getOwnedClaimSnapshot(claimed.claim.id, "profile-2")).toBeNull();
    expect(store.getOwnedClaimSnapshot("claim-unknown", "profile-1")).toBeNull();
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("rolls back context rows and events when context creation throws", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const contextStore = createContextPackStore(fixture.database);

    expect(() => store.claim(claimCommand("task-ready"), () => {
      contextStore.save(pack("task-ready"));
      throw new Error("context failed");
    })).toThrow("context failed");
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM context_packs").get()).toEqual({ count: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_claims").get()).toEqual({ count: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM coordination_events").get()).toEqual({ count: 0 });
  });

  it("acquires the immediate write lock before invoking context creation", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const competingDatabase = openDatabase(temporary!.path);
    competingDatabase.pragma("busy_timeout = 1");
    try {
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const competingStore = createCoordinationStore(competingDatabase, { now: () => t0 });
      const result = store.claim(claimCommand("task-ready"), () => {
        expect(() => competingStore.claim(
          claimCommand("task-ready", "profile-2"),
          () => ({ ...pack("task-ready"), id: "pack-competing" }),
        )).toThrowError(expect.objectContaining({ code: "SQLITE_BUSY" }));
        return pack("task-ready");
      });
      expect(result.claim.profileId).toBe("profile-1");
    } finally {
      competingDatabase.close();
    }
  });

  it("transitions an owned active claim to paused", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const transitioned = store.transition({
      profileId: "profile-1", credentialGeneration: t0, requestHash: sha("pause"), now: t0,
      ids: { eventId: "event-pause" },
      input: {
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        action: "pause", idempotencyKey: "pause-1",
      },
    });
    expect(transitioned.claim).toMatchObject({ state: "paused", endedAt: t0 });
  });

  it.each(["pause", "release"] as const)(
    "%s terminalizes only the exact claimed delegation and restores readiness",
    (action) => {
      const fixture = setup();
      fixture.addRecord("task-ready");
      fixture.addRecord("task-unrelated");
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const offered = store.createDelegation(delegationCommand());
      store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
      const delegated = claimCommand("task-ready", "profile-2");
      delegated.input.acceptedDelegationId = offered.delegation.id;
      const claimed = store.claim(delegated, () => pack("task-ready"));
      const unrelated = store.createDelegation(delegationCommand("task-unrelated"));
      const commandNow = "2026-08-15T10:20:00.000Z";

      const result = store.transition({
        profileId: "profile-2", credentialGeneration: t0,
        requestHash: sha(`delegated-${action}`), now: commandNow,
        ids: { eventId: `event-delegated-${action}` },
        input: {
          claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
          action, idempotencyKey: `delegated-${action}`,
        },
      });

      expect(result.claim).toMatchObject({ state: action === "pause" ? "paused" : "released", endedAt: commandNow });
      expect(fixture.database.prepare("SELECT state, ended_at, claim_id FROM task_delegations WHERE id = ?")
        .get(offered.delegation.id)).toEqual({
        state: "revoked", ended_at: commandNow, claim_id: claimed.claim.id,
      });
      expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
        .get(unrelated.delegation.id)).toEqual({ state: "offered", ended_at: null });
      expect(fixture.database.prepare(`
        SELECT category, claim_id, delegation_id FROM coordination_events WHERE id = ?
      `).get(`event-delegated-${action}`)).toEqual({
        category: action, claim_id: claimed.claim.id, delegation_id: offered.delegation.id,
      });
      expect(store.listReadyTasks({
        projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
      }, "profile-2").tasks.find(({ task }) => task.id === "task-ready")).toMatchObject({
        blockers: [], liveClaimId: null, liveDelegationId: null,
      });
    },
  );

  it("rolls back delegated claim and delegation terminalization when the exact event cannot append", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offered = store.createDelegation(delegationCommand());
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegated = claimCommand("task-ready", "profile-2");
    delegated.input.acceptedDelegationId = offered.delegation.id;
    const claimed = store.claim(delegated, () => pack("task-ready"));
    const before = dumpCoordinationRows(fixture);

    expect(() => store.transition({
      profileId: "profile-2", credentialGeneration: t0,
      requestHash: sha("delegated-event-collision"), now: "2026-08-15T10:20:00.000Z",
      ids: { eventId: delegationCommand().ids.eventId },
      input: {
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        action: "release", idempotencyKey: "delegated-event-collision",
      },
    })).toThrow(/UNIQUE constraint failed/);
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("releases a submitted claim only after a terminal non-accepted submission decision", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    fixture.database.prepare(`
      INSERT INTO task_checkpoints VALUES (
        'checkpoint-1', ?, 1,
        '{"summary":"Progress","completedWork":[],"remainingWork":[],"blockers":[],"verificationEvidence":{"tests":[],"artifacts":[]},"repositoryEvidence":null}',
        ?, 4, 1, ?
      )
    `).run(claimed.claim.id, t0, claimed.claim.contextPackId);
    fixture.database.prepare(`
      INSERT INTO change_proposals (
        id, project_id, profile_id, source_task_id, predecessor_proposal_id,
        base_project_revision, state, rationale, idempotency_key, request_hash,
        review_reason, reviewer_actor, created_at, updated_at, reviewed_at,
        origin_type, repository_snapshot_id
      ) VALUES (
        'proposal-1', 'project-1', 'profile-1', 'task-ready', NULL,
        4, 'pending', 'Rationale', 'proposal-key', ?, NULL, NULL, ?, ?, NULL,
        'profile', NULL
      )
    `).run("c".repeat(64), t0, t0);
    fixture.database.prepare(`
      INSERT INTO task_submissions VALUES (
        'submission-1', ?, 'checkpoint-1', 'profile-1', 'project-1', 'task-ready',
        4, 1, ?,
        '{"summary":"Submitted","verificationEvidence":{"tests":[],"artifacts":[]},"repositoryEvidence":null}',
        'proposal-1', 'submitted', ?, NULL
      )
    `).run(claimed.claim.id, claimed.claim.contextPackId, t0);
    fixture.database.prepare("UPDATE task_claims SET state = 'submitted' WHERE id = ?").run(claimed.claim.id);
    const command = {
      profileId: "profile-1", credentialGeneration: t0, requestHash: sha("release-submitted"), now: t0,
      ids: { eventId: "event-release-submitted" },
      input: {
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        action: "release" as const, idempotencyKey: "release-submitted",
      },
    };

    expect(() => store.transition(command)).toThrowError(expect.objectContaining({ code: "claim_conflict" }));
    fixture.database.prepare(`UPDATE task_submissions SET state = 'conflicted', decided_at = ? WHERE id = 'submission-1'`).run(t0);
    expect(store.transition(command).claim.state).toBe("released");
  });

  it("appends immutable monotonic checkpoints, advances the latest pointer, and renews within the claim horizon", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const firstCommand = checkpointCommand(claimed.claim.id);
    const first = store.checkpoint(firstCommand);
    firstCommand.input.checkpoint.summary = "Mutated after storage";
    fixture.database.prepare("UPDATE task_claims SET expires_at = absolute_expires_at WHERE id = ?")
      .run(claimed.claim.id);
    const second = store.checkpoint(checkpointCommand(
      claimed.claim.id,
      "checkpoint-2",
      "2026-08-15T13:50:00.000Z",
    ));

    expect(first.checkpoint).toMatchObject({
      id: "checkpoint-checkpoint-1",
      sequence: 1,
      summary: "Progress",
      projectRevision: 4,
      taskRevision: 1,
      contextPackId: claimed.claim.contextPackId,
    });
    expect(second.checkpoint.sequence).toBe(2);
    expect(second.claim).toMatchObject({
      latestCheckpointId: "checkpoint-checkpoint-2",
      expiresAt: "2026-08-15T14:00:00.000Z",
      absoluteExpiresAt: "2026-08-15T14:00:00.000Z",
    });
    expect(fixture.database.prepare("SELECT document_json FROM task_checkpoints WHERE id = ?")
      .get(first.checkpoint.id)).toEqual({ document_json: JSON.stringify(checkpointDocument()) });
    expect(fixture.database.prepare(`
      SELECT id, category FROM coordination_events WHERE checkpoint_id IS NOT NULL ORDER BY rowid
    `).all()).toEqual([
      { id: "event-checkpoint-1", category: "checkpoint" },
      { id: "event-renewal-checkpoint-1", category: "renewal" },
      { id: "event-checkpoint-2", category: "checkpoint" },
      { id: "event-renewal-checkpoint-2", category: "renewal" },
    ]);
  });

  it("persists and replays an exact 64 KiB checkpoint document inside the bounded record envelope", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const base = { ...checkpointDocument(), summary: "" };
    const fixedBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    const maximumDocument = { ...base, summary: "x".repeat(65_536 - fixedBytes) };
    const command = checkpointCommand(claimed.claim.id, "maximum");
    command.input.checkpoint = maximumDocument;
    command.requestHash = sha(JSON.stringify(command.input));

    const first = store.checkpoint(command);
    const replay = store.checkpoint(command);

    expect(Buffer.byteLength(JSON.stringify(maximumDocument), "utf8")).toBe(65_536);
    expect(taskCheckpointSchema.parse(first.checkpoint)).toEqual(first.checkpoint);
    expect(replay).toEqual(first);
    expect(fixture.database.prepare(
      "SELECT length(CAST(document_json AS BLOB)) AS bytes FROM task_checkpoints WHERE id = ?",
    ).get(first.checkpoint.id)).toEqual({ bytes: 65_536 });
  });

  it("rejects unowned, stale, expired, and oversized checkpoints without mutation", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const baseline = dumpCoordinationRows(fixture);
    const cases: AuthorizedCheckpointCommand[] = [
      { ...checkpointCommand(claimed.claim.id, "wrong-owner"), profileId: "profile-2" },
      {
        ...checkpointCommand(claimed.claim.id, "stale-project"),
        input: { ...checkpointCommand(claimed.claim.id).input, expectedProjectRevision: 3, idempotencyKey: "stale-project" },
      },
      {
        ...checkpointCommand(claimed.claim.id, "stale-task"),
        input: { ...checkpointCommand(claimed.claim.id).input, expectedTaskRevision: 2, idempotencyKey: "stale-task" },
      },
      {
        ...checkpointCommand(claimed.claim.id, "oversized"),
        input: {
          ...checkpointCommand(claimed.claim.id).input,
          checkpoint: { ...checkpointDocument(), summary: "x".repeat(65_536) },
          idempotencyKey: "oversized",
        },
      },
      checkpointCommand(claimed.claim.id, "expired", "2026-08-15T10:30:00.000Z"),
    ];

    for (const command of cases) expect(() => store.checkpoint(command)).toThrow();
    expect(dumpCoordinationRows(fixture)).toEqual(baseline);
  });

  it("replays one checkpoint result without duplicating checkpoints, renewals, or events", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const command = checkpointCommand(claimed.claim.id);
    const first = store.checkpoint(command);
    const replayed = store.checkpoint(command);

    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first));
    expect(fixture.database.prepare(`
      SELECT (SELECT COUNT(*) FROM task_checkpoints) AS checkpoints,
             (SELECT COUNT(*) FROM coordination_events) AS events,
             (SELECT COUNT(*) FROM coordination_idempotency WHERE operation = 'checkpoint') AS replays
    `).get()).toEqual({ checkpoints: 1, events: 3, replays: 1 });
  });

  it("switches tasks atomically with checkpoint, transition, and claim events in exact order", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = store.claim(claimCommand("task-current"), () => pack("task-current"));
    const result = store.switchTask(switchCommand(current.claim.id), () => pack("task-next"));

    expect(result).toMatchObject({
      previousClaim: { id: current.claim.id, state: "paused", latestCheckpointId: "checkpoint-switch" },
      nextClaim: { id: "claim-next", taskId: "task-next", state: "active" },
      checkpoint: { id: "checkpoint-switch", sequence: 1 },
      contextPack: { id: "pack-task-next", taskId: "task-next" },
    });
    expect(fixture.database.prepare(`
      SELECT id, category, task_id FROM coordination_events
      WHERE id IN ('z-event-switch-checkpoint', 'a-event-switch-pause', 'event-switch-claim')
      ORDER BY rowid
    `).all()).toEqual([
      { id: "z-event-switch-checkpoint", category: "checkpoint", task_id: "task-current" },
      { id: "a-event-switch-pause", category: "pause", task_id: "task-current" },
      { id: "event-switch-claim", category: "claim", task_id: "task-next" },
    ]);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM coordination_events").get())
      .toEqual({ count: 4 });
    expect(store.getCoordinationState({
      projectId: "project-1", taskId: "task-current", expectedProjectRevision: 4,
    }, "profile-1").events.map(({ category }) => category))
      .toEqual(["claim", "checkpoint", "pause"]);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM coordination_idempotency WHERE operation = 'switch'").get())
      .toEqual({ count: 1 });
  });

  it("terminalizes the exact current delegation when a delegated worker switches tasks", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offer = delegationCommand("task-current");
    const offered = store.createDelegation(offer);
    const accept = acceptDelegationCommand(offered.delegation.id);
    accept.input.taskId = "task-current";
    store.acceptDelegation(accept);
    const delegated = claimCommand("task-current", "profile-2");
    delegated.input.acceptedDelegationId = offered.delegation.id;
    const current = store.claim(delegated, () => pack("task-current"));
    const command = switchCommand(current.claim.id);
    command.profileId = "profile-2";
    command.requestHash = sha("delegated-switch");
    command.input.idempotencyKey = "delegated-switch";

    const result = store.switchTask(command, () => pack("task-next"));

    expect(result.previousClaim).toMatchObject({ state: "paused", endedAt: command.now });
    expect(fixture.database.prepare("SELECT state, ended_at, claim_id FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({
      state: "revoked", ended_at: command.now, claim_id: current.claim.id,
    });
    expect(fixture.database.prepare(`
      SELECT claim_id, delegation_id, category FROM coordination_events WHERE id = ?
    `).get(command.ids.transitionEventId)).toEqual({
      claim_id: current.claim.id,
      delegation_id: offered.delegation.id,
      category: "pause",
    });
  });

  it("does not expire or emit events for unrelated elapsed coordination while switching", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    fixture.addRecord("task-unrelated");
    const setupStore = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = setupStore.claim(claimCommand("task-current"), () => pack("task-current"));
    const unrelated = setupStore.claim(
      claimCommand("task-unrelated", "profile-2"),
      () => pack("task-unrelated"),
    );
    fixture.database.prepare("UPDATE task_claims SET expires_at = ? WHERE id = ?")
      .run(t0, unrelated.claim.id);
    const before = dumpCoordinationRows(fixture);
    const store = createCoordinationStore(fixture.database, {
      now: () => t0,
      newId() { throw new Error("switch must not allocate opportunistic expiry IDs"); },
    });

    expect(() => store.switchTask(switchCommand(current.claim.id), () => pack("task-next")))
      .not.toThrow();
    expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?").get(unrelated.claim.id))
      .toEqual({ state: "active" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM coordination_events").get())
      .toEqual({ count: before.events.length + 3 });
  });

  it("expires a stale next-task claim before the three command-owned switch events", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const setupStore = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = setupStore.claim(claimCommand("task-current"), () => pack("task-current"));
    const stale = setupStore.claim(claimCommand("task-next", "profile-2"), () => pack("task-next"));
    fixture.database.prepare("UPDATE task_claims SET expires_at = ? WHERE id = ?")
      .run(t0, stale.claim.id);
    const store = createCoordinationStore(fixture.database, {
      now: () => t0,
      newId: () => "event-next-expiry",
    });

    expect(store.switchTask(switchCommand(current.claim.id), () => pack("task-next")))
      .toMatchObject({ nextClaim: { id: "claim-next", state: "active" } });
    expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?").get(stale.claim.id))
      .toEqual({ state: "expired" });
    expect(fixture.database.prepare(`
      SELECT id, category FROM coordination_events
      WHERE id IN ('event-next-expiry', 'z-event-switch-checkpoint', 'a-event-switch-pause', 'event-switch-claim')
      ORDER BY rowid
    `).all()).toEqual([
      { id: "event-next-expiry", category: "expiry" },
      { id: "z-event-switch-checkpoint", category: "checkpoint" },
      { id: "a-event-switch-pause", category: "pause" },
      { id: "event-switch-claim", category: "claim" },
    ]);
  });

  it("rejects an elapsed accepted delegation without mutating switch state", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = store.claim(claimCommand("task-current"), () => pack("task-current"));
    fixture.database.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-expired', 'project-1', 'task-next', 'profile-2', 'profile-1', 'accepted',
        4, 1, '{"summary":"Help","constraints":[]}', '["checkpoint"]', ?, ?, ?, NULL, NULL
      )
    `).run(t0, t0, t0);
    const command = switchCommand(current.claim.id);
    command.input.acceptedDelegationId = "delegation-expired";
    const before = dumpCoordinationRows(fixture);

    expect(() => store.switchTask(command, () => pack("task-next")))
      .toThrowError(expect.objectContaining({ code: "delegation_expired" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("does not disclose expiry for an accepted delegation outside the switch scope", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    fixture.database.prepare(`
      INSERT INTO projects (
        id, name, revision, primary_repository_path, created_at, updated_at
      ) VALUES ('project-2', 'Other', 1, NULL, ?, ?)
    `).run(t0, t0);
    fixture.database.prepare(`
      INSERT INTO project_records
        (id, project_id, kind, status, title, body, source_kind, source_ref, revision, created_at, updated_at)
      VALUES ('task-other', 'project-2', 'task', 'active', 'Other', 'Body', 'human', NULL, 1, ?, ?)
    `).run(t0, t0);
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = store.claim(claimCommand("task-current"), () => pack("task-current"));
    fixture.database.prepare(`
      INSERT INTO task_delegations VALUES (
        'delegation-other-project', 'project-2', 'task-other', 'profile-2', 'profile-1', 'accepted',
        1, 1, '{"summary":"Help","constraints":[]}', '["checkpoint"]', ?, ?, ?, NULL, NULL
      )
    `).run(t0, t0, t0);
    const command = switchCommand(current.claim.id);
    command.input.acceptedDelegationId = "delegation-other-project";
    const before = dumpCoordinationRows(fixture);

    expect(() => store.switchTask(command, () => pack("task-next")))
      .toThrowError(expect.objectContaining({ code: "delegation_conflict" }));
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  it("validates both sides of a switch before context creation or mutation", () => {
    const fixture = setup();
    fixture.addRecord("task-current");
    fixture.addRecord("task-next");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const current = store.claim(claimCommand("task-current"), () => pack("task-current"));
    const before = dumpCoordinationRows(fixture);
    let contextCalls = 0;
    const invalid = switchCommand(current.claim.id);
    invalid.input.expectedNextTaskRevision = 2;

    expect(() => store.switchTask(invalid, () => {
      contextCalls += 1;
      return pack("task-next");
    })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
    expect(contextCalls).toBe(0);
    expect(dumpCoordinationRows(fixture)).toEqual(before);
  });

  for (const failAfter of [
    "context_creation",
    "checkpoint_insert",
    "old_claim_transition",
    "new_claim_insert",
  ] satisfies CoordinationStoreTestFailpoint[]) {
    it(`rolls back every switch row after the ${failAfter} failpoint`, () => {
      const fixture = setup();
      fixture.addRecord("task-current");
      fixture.addRecord("task-next");
      const contextStore = createContextPackStore(fixture.database);
      const baseStore = createCoordinationStore(fixture.database, { now: () => t0 });
      const current = baseStore.claim(claimCommand("task-current"), () => pack("task-current"));
      const before = dumpCoordinationRows(fixture);
      const store = createCoordinationStore(fixture.database, {
        now: () => t0,
        testOnlyFailpoint(step) {
          if (step === failAfter) throw new Error(`injected failure: ${step}`);
        },
      });

      expect(() => store.switchTask(switchCommand(current.claim.id), () => {
        const next = pack("task-next");
        contextStore.save(next);
        return next;
      })).toThrow(`injected failure: ${failAfter}`);
      expect(dumpCoordinationRows(fixture)).toEqual(before);
    });
  }

  it("creates one governed submission with the protocol-owned completion and replays exactly", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
    const command = submissionCommand(claimed.claim.id, saved.checkpoint.id);
    const governed = governance(fixture);

    let proposalCalls = 0;
    const submitProposal = ((input: SubmitChangeSetInput) => {
      proposalCalls += 1;
      return governed.submit(input);
    }) as never;
    const first = store.submit(command, submitProposal);
    expect(first).toMatchObject({
      claim: { id: claimed.claim.id, state: "submitted" },
      submission: {
        id: "submission-1",
        checkpointId: saved.checkpoint.id,
        state: "submitted",
        summary: "Completed the claimed work.",
      },
      proposal: {
        projectId: "project-1",
        sourceTaskId: "task-ready",
        baseProjectRevision: 4,
        state: "pending",
        rationale: "Reconcile the completed task.",
      },
    });
    expect(governed.governanceStore.getProposal(first.proposal.id)?.operations).toEqual([{
      operationId: expect.stringMatching(/^coordination-task-completion-/),
      type: "update_record",
      recordId: "task-ready",
      expectedRecordRevision: 1,
      patch: { status: "completed" },
    }]);
    expect(first.proposal.idempotencyKey).toMatch(/^coordination-submission-/);
    expect(store.submit(command, submitProposal)).toEqual(first);
    expect(proposalCalls).toBe(1);
    expect(fixture.database.prepare(`
      SELECT (SELECT COUNT(*) FROM task_submissions) AS submissions,
             (SELECT COUNT(*) FROM change_proposals) AS proposals,
             (SELECT COUNT(*) FROM coordination_events WHERE category = 'submission') AS events,
             (SELECT COUNT(*) FROM coordination_idempotency WHERE operation = 'submit') AS replays
    `).get()).toEqual({ submissions: 1, proposals: 1, events: 1, replays: 1 });
  });

  it("preserves worker evidence as an idempotent conflicted submission after revision drift", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
    const command = submissionCommand(claimed.claim.id, saved.checkpoint.id);
    fixture.database.prepare("UPDATE projects SET revision = 5 WHERE id = 'project-1'").run();
    fixture.database.prepare(`
      UPDATE project_records SET revision = 2, title = 'Concurrent reviewed title'
      WHERE id = 'task-ready'
    `).run();
    const governed = governance(fixture);

    const first = store.submit(command, governed.submit as never);

    expect(first).toMatchObject({
      claim: { id: claimed.claim.id, state: "submitted" },
      submission: {
        claimId: claimed.claim.id,
        checkpointId: saved.checkpoint.id,
        baseProjectRevision: 4,
        baseTaskRevision: 1,
        state: "conflicted",
        decidedAt: command.now,
      },
      proposal: {
        projectId: "project-1",
        sourceTaskId: "task-ready",
        baseProjectRevision: 4,
        state: "conflicted",
      },
    });
    expect(store.submit(command, () => { throw new Error("must replay"); })).toEqual(first);
    const beforeReview = dumpCoordinationRows(fixture);
    expect(() => governed.proposalService.accept(first.proposal.id))
      .toThrowError(expect.objectContaining({ code: "proposal_not_pending" }));
    expect(dumpCoordinationRows(fixture)).toEqual(beforeReview);
    expect(fixture.database.prepare(`
      SELECT category, claim_id, checkpoint_id, submission_id, proposal_id,
             project_revision, task_revision, resulting_state
      FROM coordination_events WHERE id = 'event-submission-1'
    `).get()).toEqual({
      category: "conflict",
      claim_id: claimed.claim.id,
      checkpoint_id: saved.checkpoint.id,
      submission_id: "submission-1",
      proposal_id: first.proposal.id,
      project_revision: 4,
      task_revision: 1,
      resulting_state: "conflicted",
    });
  });

  it("forces a conflicted proposal when only the claimed task revision drifted", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
    const command = submissionCommand(claimed.claim.id, saved.checkpoint.id, {
      idempotencyKey: "task-only-drift",
    });
    command.requestHash = sha(JSON.stringify(command.input));
    fixture.database.prepare("UPDATE project_records SET revision = 2 WHERE id = 'task-ready'").run();

    expect(store.submit(command, governance(fixture).submit as never)).toMatchObject({
      claim: { state: "submitted" },
      submission: { state: "conflicted", baseProjectRevision: 4, baseTaskRevision: 1 },
      proposal: { state: "conflicted", baseProjectRevision: 4 },
    });
  });

  it("rejects stale, uncheckpointed, expired, mismatched-context, and invalid submission evidence", () => {
    const cases: Array<{
      name: string;
      arrange: (fixture: ReturnType<typeof setup>, store: ReturnType<typeof createCoordinationStore>, command: AuthorizedSubmissionCommand) => void;
      code: string;
    }> = [
      { name: "missing checkpoint", arrange(_fixture, _store, command) { command.input.checkpointId = "missing"; }, code: "submission_stale" },
      { name: "expired claim", arrange(_fixture, _store, command) { command.now = "2026-08-15T10:41:00.000Z"; }, code: "claim_expired" },
      { name: "stale project", arrange(_fixture, _store, command) { command.input.expectedProjectRevision = 3; }, code: "revision_conflict" },
      { name: "stale task", arrange(_fixture, _store, command) { command.input.expectedTaskRevision = 2; }, code: "revision_conflict" },
      {
        name: "stale context pack",
        arrange(fixture, _store, command) {
          fixture.database.prepare(`
            INSERT INTO context_packs
            SELECT 'pack-stale', project_id, task_id, project_revision, budget_tokens,
              estimated_tokens, content_json, created_at
            FROM context_packs WHERE id = 'pack-task-ready'
          `).run();
          fixture.database.prepare(`
            INSERT INTO task_checkpoints VALUES (
              'checkpoint-stale-context', ?, 2, ?, ?, 4, 1, 'pack-stale'
            )
          `).run(command.input.claimId, JSON.stringify(checkpointDocument()), command.now);
          fixture.database.prepare("UPDATE task_claims SET latest_checkpoint_id = 'checkpoint-stale-context' WHERE id = ?")
            .run(command.input.claimId);
          command.input.checkpointId = "checkpoint-stale-context";
        },
        code: "submission_stale",
      },
      { name: "wrong profile", arrange(_fixture, _store, command) { command.profileId = "profile-2"; }, code: "coordination_authority_denied" },
      {
        name: "oversized evidence",
        arrange(_fixture, _store, command) { command.input.submission.summary = "x".repeat(262_145); },
        code: "submission_invalid",
      },
      {
        name: "duplicate operation IDs",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [
            { operationId: "duplicate", type: "update_record", recordId: "task-ready", expectedRecordRevision: 1, patch: { title: "A" } },
            { operationId: "duplicate", type: "create_record", kind: "outcome", status: "provisional", title: "B", body: "B" },
          ];
        },
        code: "submission_invalid",
      },
      {
        name: "generated operation ID collision",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [{
            operationId: `coordination-task-completion-${sha(command.input.idempotencyKey)}`,
            type: "update_record", recordId: "task-ready", expectedRecordRevision: 1,
            patch: { title: "Worker-owned collision" },
          }];
        },
        code: "submission_invalid",
      },
      {
        name: "worker completion operation",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [{
            operationId: "worker-completion", type: "update_record", recordId: "task-ready",
            expectedRecordRevision: 1, patch: { status: "completed" },
          }];
        },
        code: "submission_invalid",
      },
      {
        name: "worker update collides with protocol task completion",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [{
            operationId: "worker-task-title", type: "update_record", recordId: "task-ready",
            expectedRecordRevision: 1, patch: { title: "Worker title" },
          }];
        },
        code: "submission_invalid",
      },
      {
        name: "duplicate update targets",
        arrange(fixture, _store, command) {
          fixture.addRecord("decision-shared", "decision", "accepted");
          command.input.submission.changes.operations = [
            { operationId: "update-a", type: "update_record", recordId: "decision-shared", expectedRecordRevision: 1, patch: { title: "A" } },
            { operationId: "update-b", type: "update_record", recordId: "decision-shared", expectedRecordRevision: 1, patch: { body: "B" } },
          ];
        },
        code: "submission_invalid",
      },
      {
        name: "duplicate local refs",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [
            { operationId: "create-a", type: "create_record", localRef: "same", kind: "outcome", status: "provisional", title: "A", body: "A" },
            { operationId: "create-b", type: "create_record", localRef: "same", kind: "evidence", status: "provisional", title: "B", body: "B" },
          ];
        },
        code: "submission_invalid",
      },
      {
        name: "forward local reference",
        arrange(_fixture, _store, command) {
          command.input.submission.changes.operations = [
            { operationId: "rel-first", type: "create_relationship", from: { localRef: "later" }, to: { recordId: "task-ready" }, kind: "supports" },
            { operationId: "create-later", type: "create_record", localRef: "later", kind: "evidence", status: "provisional", title: "Later", body: "Later" },
          ];
        },
        code: "submission_invalid",
      },
    ];
    for (const testCase of cases) {
      const fixture = setup();
      fixture.addRecord("task-ready");
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
      const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
      const command = submissionCommand(claimed.claim.id, saved.checkpoint.id);
      testCase.arrange(fixture, store, command);
      command.requestHash = sha(JSON.stringify(command.input));
      const before = dumpCoordinationRows(fixture);

      expect(() => store.submit(command, governance(fixture).submit as never), testCase.name)
        .toThrowError(expect.objectContaining({ code: testCase.code }));
      expect(dumpCoordinationRows(fixture), testCase.name).toEqual(before);
      expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM change_proposals").get())
        .toEqual({ count: 0 });
      fixture.database.close();
      database = undefined;
      removeTemporaryDatabase(temporary!);
      temporary = undefined;
    }
  });

  it("narrows delegated submission operations to stored allowed output types", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offeredCommand = delegationCommand();
    offeredCommand.input.allowedOutputs = ["create_record"];
    const offered = store.createDelegation(offeredCommand);
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegatedClaim = claimCommand("task-ready", "profile-2");
    delegatedClaim.now = "2026-08-15T10:06:00.000Z";
    delegatedClaim.input.acceptedDelegationId = offered.delegation.id;
    delegatedClaim.input.idempotencyKey = "claim-delegated-submission";
    delegatedClaim.requestHash = sha("delegated-submission-claim");
    const claimed = store.claim(delegatedClaim, () => pack("task-ready"));
    const checkpointed = checkpointCommand(claimed.claim.id, "delegated-submission");
    checkpointed.profileId = "profile-2";
    checkpointed.requestHash = sha("delegated-submission-checkpoint");
    const saved = store.checkpoint(checkpointed);
    const disallowed = submissionCommand(claimed.claim.id, saved.checkpoint.id, {
      submission: {
        summary: "Disallowed delegated output.",
        verificationEvidence: { tests: [], artifacts: [] },
        repositoryEvidence: null,
        changes: {
          rationale: "Attempt an output outside the delegation.",
          operations: [{
            operationId: "worker-update", type: "update_record", recordId: "task-ready",
            expectedRecordRevision: 1, patch: { title: "Outside scope" },
          }],
        },
      },
    });
    disallowed.profileId = "profile-2";
    disallowed.requestHash = sha(JSON.stringify(disallowed.input));
    expect(() => store.submit(disallowed, governance(fixture, "profile-2").submit as never))
      .toThrowError(expect.objectContaining({ code: "submission_invalid" }));
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM change_proposals").get())
      .toEqual({ count: 0 });

    const allowed = submissionCommand(claimed.claim.id, saved.checkpoint.id, {
      submission: {
        summary: "Allowed delegated output.",
        verificationEvidence: { tests: ["focused"], artifacts: [] },
        repositoryEvidence: null,
        changes: {
          rationale: "Create the delegated outcome and complete the task.",
          operations: [{
            operationId: "worker-create", type: "create_record", kind: "outcome",
            status: "provisional", title: "Delegated result", body: "Reviewed result.",
          }],
        },
      },
      idempotencyKey: "submission-allowed",
    });
    allowed.profileId = "profile-2";
    allowed.requestHash = sha(JSON.stringify(allowed.input));
    allowed.ids = { submissionId: "submission-allowed", eventId: "event-submission-allowed" };
    const delegatedGovernance = governance(fixture, "profile-2");
    const result = store.submit(allowed, delegatedGovernance.submit as never);
    expect(result.proposal.origin).toEqual({ type: "profile", profileId: "profile-2" });
    expect(fixture.database.prepare(`
      SELECT operation_type FROM proposal_operations WHERE proposal_id = ? ORDER BY position
    `).all(result.proposal.id)).toEqual([
      { operation_type: "create_record" },
      { operation_type: "update_record" },
    ]);
    delegatedGovernance.proposalService.reject({
      proposalId: result.proposal.id,
      reason: "Delegated result needs another attempt.",
    });
    expect(store.transition({
      profileId: "profile-2", credentialGeneration: t0,
      requestHash: sha("release-delegated-submission"), now: "2026-08-15T11:01:00.000Z",
      ids: { eventId: "event-release-delegated-submission" },
      input: {
        claimId: claimed.claim.id, expectedProjectRevision: 4, expectedTaskRevision: 1,
        action: "release", idempotencyKey: "release-delegated-submission",
      },
    }).claim.state).toBe("released");
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({
      state: "revoked",
      ended_at: "2026-08-15T11:01:00.000Z",
    });
    expect(store.listReadyTasks({
      projectId: "project-1", expectedProjectRevision: 4, cursor: null, limit: 10,
    }, "profile-2").tasks.map(({ task }) => task.id)).toContain("task-ready");
    expect(createIntegrityChecker({ now: () => "2026-08-15T11:01:00.000Z" })
      .checkConnection(fixture.database, "full").issues.map(({ code }) => code))
      .not.toContain("coordination_state_invalid");
  });

  it("keeps a submitted claim's exact delegation reconcilable after its deadline", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const offered = store.createDelegation(delegationCommand());
    store.acceptDelegation(acceptDelegationCommand(offered.delegation.id));
    const delegatedClaim = claimCommand("task-ready", "profile-2");
    delegatedClaim.now = "2026-08-15T10:06:00.000Z";
    delegatedClaim.input.acceptedDelegationId = offered.delegation.id;
    delegatedClaim.input.idempotencyKey = "claim-delegated-deadline";
    delegatedClaim.requestHash = sha("claim-delegated-deadline");
    const claimed = store.claim(delegatedClaim, () => pack("task-ready"));
    const checkpointed = checkpointCommand(claimed.claim.id, "delegated-deadline");
    checkpointed.profileId = "profile-2";
    checkpointed.requestHash = sha("checkpoint-delegated-deadline");
    const saved = store.checkpoint(checkpointed);
    const submission = submissionCommand(claimed.claim.id, saved.checkpoint.id, {
      idempotencyKey: "submission-delegated-deadline",
    });
    submission.profileId = "profile-2";
    submission.requestHash = sha(JSON.stringify(submission.input));
    const governed = governance(fixture, "profile-2");
    const result = store.submit(submission, governed.submit as never);

    const afterDeadline = createCoordinationStore(fixture.database, {
      now: () => "2026-08-15T11:01:00.000Z",
    });
    afterDeadline.getCoordinationState({
      projectId: "project-1",
      taskId: "task-ready",
      expectedProjectRevision: 4,
    }, "profile-2");
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({ state: "claimed", ended_at: null });

    const lateProposalService = createProposalService({
      governanceStore: governed.governanceStore,
      now: () => "2026-08-15T11:05:00.000Z",
    });
    expect(lateProposalService.accept(result.proposal.id)).toMatchObject({ outcome: "applied" });
    expect(fixture.database.prepare("SELECT status FROM project_records WHERE id = 'task-ready'").get())
      .toEqual({ status: "completed" });
    expect(fixture.database.prepare("SELECT state FROM task_submissions WHERE id = ?")
      .get(result.submission.id)).toEqual({ state: "accepted" });
    expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?")
      .get(claimed.claim.id)).toEqual({ state: "reconciled" });
    expect(fixture.database.prepare("SELECT state, ended_at FROM task_delegations WHERE id = ?")
      .get(offered.delegation.id)).toEqual({
      state: "completed",
      ended_at: "2026-08-15T11:05:00.000Z",
    });
    expect(fixture.database.prepare(`
      SELECT profile_id, claim_id, delegation_id, checkpoint_id,
             submission_id, proposal_id, resulting_state
      FROM coordination_events WHERE category = 'reconciliation'
    `).get()).toEqual({
      profile_id: "profile-2",
      claim_id: claimed.claim.id,
      delegation_id: offered.delegation.id,
      checkpoint_id: saved.checkpoint.id,
      submission_id: result.submission.id,
      proposal_id: result.proposal.id,
      resulting_state: "reconciled",
    });
    expect(createIntegrityChecker({ now: () => "2026-08-15T11:05:00.000Z" })
      .checkConnection(fixture.database, "full").issues.map(({ code }) => code))
      .not.toContain("coordination_state_invalid");
  });

  it("appends one exact reconciliation event when governance accepts a coordinated submission", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
    const governed = governance(fixture);
    const command = submissionCommand(claimed.claim.id, saved.checkpoint.id);
    const submitted = store.submit(command, governed.submit as never);

    expect(governed.proposalService.accept(submitted.proposal.id)).toMatchObject({
      outcome: "applied",
      projectRevision: 5,
    });
    expect(fixture.database.prepare(`
      SELECT id, category, project_id, task_id, profile_id, claim_id,
             delegation_id, checkpoint_id, submission_id, proposal_id,
             prior_state, resulting_state, project_revision, task_revision,
             detail, created_at
      FROM coordination_events
      WHERE category = 'reconciliation'
    `).all()).toEqual([{
      id: `coordination-event-${sha(submitted.proposal.id)}`,
      category: "reconciliation",
      project_id: "project-1",
      task_id: "task-ready",
      profile_id: "profile-1",
      claim_id: claimed.claim.id,
      delegation_id: null,
      checkpoint_id: saved.checkpoint.id,
      submission_id: submitted.submission.id,
      proposal_id: submitted.proposal.id,
      prior_state: "submitted",
      resulting_state: "reconciled",
      project_revision: 5,
      task_revision: 2,
      detail: "Governed proposal accepted.",
      created_at: "2026-08-15T10:30:00.000Z",
    }]);

    expect(store.submit(command, governed.submit as never)).toEqual(submitted);
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM coordination_events
      WHERE category = 'reconciliation'
    `).get()).toEqual({ count: 1 });
  });

  it("rolls back governance acceptance when reconciliation event persistence fails", () => {
    const fixture = setup();
    fixture.addRecord("task-ready");
    const store = createCoordinationStore(fixture.database, { now: () => t0 });
    const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
    const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
    const governed = governance(fixture);
    const submitted = store.submit(
      submissionCommand(claimed.claim.id, saved.checkpoint.id),
      governed.submit as never,
    );
    const reconciliationEventId = `coordination-event-${sha(submitted.proposal.id)}`;
    fixture.database.prepare(`
      INSERT INTO coordination_events (
        id, category, project_id, task_id, profile_id, claim_id,
        delegation_id, checkpoint_id, submission_id, proposal_id,
        prior_state, resulting_state, project_revision, task_revision,
        detail, created_at
      ) VALUES (?, 'ready_evaluation', 'project-1', 'task-ready', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 4, 1, 'collision sentinel', ?)
    `).run(reconciliationEventId, t0);
    const before = dumpCoordinationRows(fixture);

    expect(() => governed.proposalService.accept(submitted.proposal.id))
      .toThrowError(/UNIQUE constraint failed: coordination_events.id/);

    expect(dumpCoordinationRows(fixture)).toEqual(before);
    expect(fixture.database.prepare(`
      SELECT revision FROM projects WHERE id = 'project-1'
    `).get()).toEqual({ revision: 4 });
    expect(fixture.database.prepare(`
      SELECT status, revision FROM project_records WHERE id = 'task-ready'
    `).get()).toEqual({ status: "active", revision: 1 });
    expect(governed.governanceStore.getProposal(submitted.proposal.id)).toMatchObject({
      state: "pending",
      reviewedAt: null,
    });
    expect(fixture.database.prepare(`
      SELECT state, decided_at FROM task_submissions WHERE id = ?
    `).get(submitted.submission.id)).toEqual({ state: "submitted", decided_at: null });
    expect(fixture.database.prepare(`
      SELECT state FROM task_claims WHERE id = ?
    `).get(claimed.claim.id)).toEqual({ state: "submitted" });
  });

  it("rolls back proposal and coordination rows across either side of submission failure", () => {
    for (const failure of ["proposal", "coordination"] as const) {
      const fixture = setup();
      fixture.addRecord("task-ready");
      const baseStore = createCoordinationStore(fixture.database, { now: () => t0 });
      const claimed = baseStore.claim(claimCommand("task-ready"), () => pack("task-ready"));
      const saved = baseStore.checkpoint(checkpointCommand(claimed.claim.id));
      const governed = governance(fixture);
      const store = createCoordinationStore(fixture.database, {
        now: () => t0,
        testOnlyFailpoint(step) {
          if (failure === "coordination" && step === ("proposal_creation" as never)) {
            throw new Error("coordination insertion failed");
          }
        },
      });

      expect(() => store.submit(
        submissionCommand(claimed.claim.id, saved.checkpoint.id),
        ((input: SubmitChangeSetInput) => {
          const result = governed.submit(input);
          if (failure === "proposal") throw new Error("proposal failed");
          return result;
        }) as never,
      )).toThrow(failure === "proposal" ? "proposal failed" : "coordination insertion failed");
      expect(fixture.database.prepare(`
        SELECT (SELECT COUNT(*) FROM task_submissions) AS submissions,
               (SELECT COUNT(*) FROM change_proposals) AS proposals,
               (SELECT COUNT(*) FROM proposal_operations) AS operations,
               (SELECT COUNT(*) FROM coordination_idempotency WHERE operation = 'submit') AS replays,
               (SELECT COUNT(*) FROM idempotency_results) AS governance_replays,
               (SELECT COUNT(*) FROM audit_events) AS governance_audits
      `).get()).toEqual({
        submissions: 0, proposals: 0, operations: 0, replays: 0,
        governance_replays: 0, governance_audits: 0,
      });
      expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?").get(claimed.claim.id))
        .toEqual({ state: "active" });
      fixture.database.close();
      database = undefined;
      removeTemporaryDatabase(temporary!);
      temporary = undefined;
    }
  });

  it("projects proposal conflict, rejection, withdrawal, and acceptance without rebasing submission evidence", () => {
    for (const decision of ["conflict", "reject", "withdraw", "accept"] as const) {
      const fixture = setup();
      fixture.addRecord("task-ready");
      const store = createCoordinationStore(fixture.database, { now: () => t0 });
      const claimed = store.claim(claimCommand("task-ready"), () => pack("task-ready"));
      const saved = store.checkpoint(checkpointCommand(claimed.claim.id));
      const governed = governance(fixture);
      const submitted = store.submit(
        submissionCommand(claimed.claim.id, saved.checkpoint.id),
        governed.submit as never,
      );
      const immutableBefore = fixture.database.prepare(`
        SELECT base_project_revision, base_task_revision, context_pack_id, document_json
        FROM task_submissions WHERE id = ?
      `).get(submitted.submission.id);

      if (decision === "conflict") {
        fixture.database.prepare("UPDATE projects SET revision = 5 WHERE id = 'project-1'").run();
        expect(governed.proposalService.accept(submitted.proposal.id)).toMatchObject({ outcome: "conflicted" });
      } else if (decision === "reject") {
        governed.proposalService.reject({ proposalId: submitted.proposal.id, reason: "Needs more work." });
      } else if (decision === "withdraw") {
        governed.proposalService.withdraw({ proposalId: submitted.proposal.id, reason: "Worker superseded it." });
      } else {
        expect(governed.proposalService.accept(submitted.proposal.id)).toMatchObject({ outcome: "applied" });
      }

      const expectedState = decision === "accept" ? "accepted"
        : decision === "conflict" ? "conflicted"
        : decision === "reject" ? "rejected" : "withdrawn";
      expect(fixture.database.prepare("SELECT state FROM task_submissions WHERE id = ?").get(submitted.submission.id))
        .toEqual({ state: expectedState });
      expect(fixture.database.prepare(`
        SELECT base_project_revision, base_task_revision, context_pack_id, document_json
        FROM task_submissions WHERE id = ?
      `).get(submitted.submission.id)).toEqual(immutableBefore);
      expect(fixture.database.prepare("SELECT state FROM task_claims WHERE id = ?").get(claimed.claim.id))
        .toEqual({ state: decision === "accept" ? "reconciled" : "submitted" });
      expect(fixture.database.prepare("SELECT status FROM project_records WHERE id = 'task-ready'").get())
        .toEqual({ status: decision === "accept" ? "completed" : "active" });
      expect(fixture.database.prepare("SELECT base_project_revision FROM change_proposals WHERE id = ?")
        .get(submitted.proposal.id)).toEqual({ base_project_revision: 4 });

      if (decision !== "accept") {
        expect(store.transition({
          profileId: "profile-1", credentialGeneration: t0,
          requestHash: sha(`release-${decision}`), now: "2026-08-15T10:31:00.000Z",
          ids: { eventId: `event-release-${decision}` },
          input: {
            claimId: claimed.claim.id,
            expectedProjectRevision: decision === "conflict" ? 5 : 4,
            expectedTaskRevision: 1,
            action: "release",
            idempotencyKey: `release-${decision}`,
          },
        }).claim.state).toBe("released");
      }
      fixture.database.close();
      database = undefined;
      removeTemporaryDatabase(temporary!);
      temporary = undefined;
    }
  });
});
