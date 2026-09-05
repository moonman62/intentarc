import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

describe("authoritative change governance final regressions", () => {
  let application: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    application?.close();
    application = undefined;
    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
      temporaryDatabase = undefined;
    }
  });

  it("replays an applied relationship removal before inspecting the missing relationship", () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T16:00:00.000Z",
    });
    const project = application.service.createProject({ name: "IntentArc" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Govern change",
      body: "Exercise removal idempotency.",
      sourceKind: "human",
      sourceRef: null,
    });
    const decision = application.service.createRecord({
      projectId: project.id,
      kind: "decision",
      status: "accepted",
      title: "Apply governance",
      body: "Keep the replay independent of current relationship state.",
      sourceKind: "human",
      sourceRef: null,
    });
    const relationship = application.service.createRelationship({
      projectId: project.id,
      fromRecordId: task.id,
      toRecordId: decision.id,
      kind: "decided_by",
      expectedProjectRevision: 2,
    });
    const created = application.service.profiles.createProfile({
      name: "Direct agent",
      projectId: project.id,
    });
    application.service.profiles.setAuthority({
      profileId: created.profile.id,
      projectId: project.id,
      mode: "full_direct",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const input = {
      projectId: project.id,
      baseProjectRevision: 3,
      idempotencyKey: "remove-once",
      rationale: "Remove this relationship once.",
      sourceTaskId: task.id,
      predecessorProposalId: null,
      operations: [{
        operationId: "remove-relationship",
        type: "remove_relationship" as const,
        relationshipId: relationship.id,
      }],
    };

    const first = application.service.submitChangeSet(principal, input);
    const replay = application.service.submitChangeSet(principal, input);
    const conflict = application.service.submitChangeSet(principal, {
      ...input,
      rationale: "A different request must not reuse the removal key.",
    });

    expect(first).toMatchObject({
      outcome: "applied",
      projectRevision: 4,
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(conflict).toEqual({
      outcome: "rejected",
      changeId: first.changeId,
      code: "idempotency_conflict",
      reason: "The idempotency key was already used for a different request",
      replayed: false,
    });
    expect(
      application.service.getProjectSummary(project.id).project.revision,
    ).toBe(4);
    expect(
      application.service.listAuditEvents({
        projectId: project.id,
        actionCategory: "idempotent_replay",
      }),
    ).toHaveLength(1);
    expect(
      application.service.listAuditEvents({
        projectId: project.id,
        actionCategory: "idempotency_conflict",
      }),
    ).toHaveLength(1);
  });

  it("keeps a missing-authority rejection stable after authority is granted", () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-07-27T16:00:00.000Z",
    });
    const project = application.service.createProject({ name: "IntentArc" });
    const created = application.service.profiles.createProfile({
      name: "Initially unauthorized agent",
    });
    const principal = application.service.profiles.authenticate({
      profileId: created.profile.id,
      token: created.token,
    })!;
    const input = {
      projectId: project.id,
      baseProjectRevision: 0,
      idempotencyKey: "missing-authority",
      rationale: "Do not change this decision after authority changes.",
      sourceTaskId: null,
      predecessorProposalId: null,
      operations: [{
        operationId: "create-after-authority",
        type: "create_record" as const,
        kind: "decision" as const,
        status: "provisional" as const,
        title: "Must remain absent",
        body: "The first rejection owns this idempotency key.",
      }],
    };

    const first = application.service.submitChangeSet(principal, input);
    application.service.profiles.setAuthority({
      profileId: created.profile.id,
      projectId: project.id,
      mode: "full_direct",
    });
    const replay = application.service.submitChangeSet(principal, input);

    expect(first).toEqual({
      outcome: "rejected",
      changeId: expect.any(String),
      code: "project_authority_missing",
      reason: "project_authority_missing",
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      application.service.getProjectSummary(project.id).project.revision,
    ).toBe(0);
    expect(
      application.service.listMyChanges(created.profile.id, project.id),
    ).toEqual([
      expect.objectContaining({
        changeId: first.changeId,
        outcome: "rejected",
      }),
    ]);
  });
});
