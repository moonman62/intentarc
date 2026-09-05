import { describe, expect, it, vi } from "vitest";
import { CoordinationError } from "./errors.js";
import {
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  checkpointDocumentSchema,
  claimTaskInputSchema,
  coordinationStateInputSchema,
  createDelegationInputSchema,
  listReadyTasksInputSchema,
  opaqueCoordinationCursorSchema,
  readyTaskPageSchema,
  renewClaimInputSchema,
  renewClaimResultSchema,
  revokeDelegationInputSchema,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  taskClaimSchema,
  taskCheckpointSchema,
  transitionClaimInputSchema,
} from "./coordination-schemas.js";

const verificationEvidence = {
  tests: ["pnpm test"],
  artifacts: ["artifact-1"],
};

const repositoryEvidence = {
  branch: "codex/coordination",
  worktree: "C:/projects/coordination",
  commits: ["abc123"],
  artifacts: [],
};

const checkpoint = {
  summary: "Implemented the coordination boundary.",
  completedWork: ["Defined strict schemas."],
  remainingWork: ["Run the focused tests."],
  blockers: [],
  verificationEvidence,
  repositoryEvidence,
};

const validClaimInput = {
  projectId: "project-1",
  taskId: "task-1",
  expectedProjectRevision: 3,
  expectedTaskRevision: 7,
  contextBudgetTokens: 4096,
  acceptedDelegationId: null,
  idempotencyKey: "claim-task-1",
};

const validCheckpointInput = {
  claimId: "claim-1",
  expectedProjectRevision: 3,
  expectedTaskRevision: 7,
  checkpoint,
  idempotencyKey: "checkpoint-1",
};

const validSwitchInput = {
  currentClaimId: "claim-1",
  projectId: "project-1",
  currentTaskId: "task-1",
  expectedCurrentProjectRevision: 3,
  expectedCurrentTaskRevision: 7,
  checkpoint,
  terminalAction: "pause" as const,
  nextTaskId: "task-2",
  expectedNextProjectRevision: 3,
  expectedNextTaskRevision: 4,
  nextContextBudgetTokens: 4096,
  acceptedDelegationId: null,
  idempotencyKey: "switch-1",
};

const validDelegationInput = {
  projectId: "project-1",
  taskId: "task-1",
  childProfileId: "profile-child",
  expectedProjectRevision: 3,
  expectedTaskRevision: 7,
  scope: {
    summary: "Implement only the claimed task.",
    constraints: ["Do not modify deployment configuration."],
  },
  allowedOutputs: ["create_record", "update_record"],
  deadline: "2026-08-15T12:00:00.000Z",
  idempotencyKey: "delegate-1",
};

const validSubmissionInput = {
  claimId: "claim-1",
  checkpointId: "checkpoint-1",
  expectedProjectRevision: 3,
  expectedTaskRevision: 7,
  submission: {
    summary: "Coordination contracts are complete.",
    verificationEvidence,
    repositoryEvidence,
    changes: {
      rationale: "Submit the completed coordination contracts.",
      operations: [],
    },
  },
  idempotencyKey: "submit-1",
};

const validTaskClaim = {
  id: "claim-1",
  projectId: "project-1",
  taskId: "task-1",
  profileId: "profile-1",
  delegationId: null,
  state: "active" as const,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  contextPackId: "pack-1",
  acquiredAt: "2026-08-15T08:00:00.000Z",
  expiresAt: "2026-08-15T08:30:00.000Z",
  absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
  endedAt: null,
  latestCheckpointId: null,
};

describe("coordination input schemas", () => {
  it.each([
    ["claim", claimTaskInputSchema, validClaimInput],
    ["checkpoint", checkpointClaimInputSchema, validCheckpointInput],
    ["switch", switchTaskInputSchema, validSwitchInput],
    ["delegation", createDelegationInputSchema, validDelegationInput],
    ["submission", submitTaskResultInputSchema, validSubmissionInput],
  ])("keeps the %s contract closed", (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
    expect(() => schema.parse({ ...value, unknown: true })).toThrow();
  });

  it("rejects empty identifiers and non-integer revisions", () => {
    expect(() => claimTaskInputSchema.parse({ ...validClaimInput, taskId: "  " })).toThrow();
    expect(() => claimTaskInputSchema.parse({ ...validClaimInput, expectedTaskRevision: 7.5 })).toThrow();
  });

  it("rejects invalid transitions and mismatched switch references", () => {
    expect(() => switchTaskInputSchema.parse({ ...validSwitchInput, terminalAction: "submitted" })).toThrow();
    expect(() => switchTaskInputSchema.parse({ ...validSwitchInput, expectedNextProjectRevision: 4 })).toThrow();
    expect(() => switchTaskInputSchema.parse({ ...validSwitchInput, nextTaskId: "task-1" })).toThrow();
  });

  it("rejects duplicate list entries and control characters", () => {
    expect(() => createDelegationInputSchema.parse({
      ...validDelegationInput,
      allowedOutputs: ["update_record", "update_record"],
    })).toThrow();
    expect(() => checkpointClaimInputSchema.parse({
      ...validCheckpointInput,
      checkpoint: { ...checkpoint, summary: "Invalid\u0000summary" },
    })).toThrow();
  });

  it("accepts a maximum-size checkpoint document after bounded record metadata is added", () => {
    const emptySummary = { ...checkpoint, summary: "" };
    const fixedBytes = new TextEncoder().encode(JSON.stringify(emptySummary)).byteLength;
    const maximumDocument = {
      ...emptySummary,
      summary: "x".repeat(65_536 - fixedBytes),
    };
    expect(new TextEncoder().encode(JSON.stringify(maximumDocument))).toHaveLength(65_536);
    expect(checkpointDocumentSchema.parse(maximumDocument)).toEqual(maximumDocument);

    expect(taskCheckpointSchema.parse({
      ...maximumDocument,
      id: "checkpoint-1",
      claimId: "claim-1",
      sequence: 1,
      createdAt: "2026-08-15T08:10:00.000Z",
      projectRevision: 3,
      taskRevision: 7,
      contextPackId: "pack-1",
    }).summary).toHaveLength(maximumDocument.summary.length);
  });

  it("accepts only the closed governance operation vocabulary for delegation outputs", () => {
    expect(createDelegationInputSchema.parse(validDelegationInput).allowedOutputs).toEqual([
      "create_record",
      "update_record",
    ]);
    expect(() => createDelegationInputSchema.parse({
      ...validDelegationInput,
      allowedOutputs: ["tests"],
    })).toThrow();
  });

  it("rejects documents beyond their canonical byte limits", () => {
    expect(() => checkpointClaimInputSchema.parse({
      ...validCheckpointInput,
      checkpoint: { ...checkpoint, summary: "x".repeat(65_536) },
    })).toThrow("Checkpoint exceeds 64 KiB");
    expect(() => createDelegationInputSchema.parse({
      ...validDelegationInput,
      scope: { ...validDelegationInput.scope, summary: "x".repeat(32_768) },
    })).toThrow("Delegation scope exceeds 32 KiB");
    expect(() => submitTaskResultInputSchema.parse({
      ...validSubmissionInput,
      submission: { ...validSubmissionInput.submission, summary: "x".repeat(262_144) },
    })).toThrow("Submission exceeds 256 KiB");
  });

  it("requires submission checkpoints and claimed task changes to agree", () => {
    expect(() => submitTaskResultInputSchema.parse({
      ...validSubmissionInput,
      checkpointId: "  ",
    })).toThrow();
    expect(() => submitTaskResultInputSchema.parse({
      ...validSubmissionInput,
      submission: {
        ...validSubmissionInput.submission,
        changes: {
          ...validSubmissionInput.submission.changes,
          operations: [{
            operationId: "complete-wrong-task",
            type: "update_record",
            recordId: "task-2",
            expectedRecordRevision: 7,
            patch: { status: "completed" },
          }],
        },
      },
    })).toThrow();
  });
});

describe("coordination operation coverage", () => {
  it.each([
    ["list ready tasks", listReadyTasksInputSchema, {
      projectId: "project-1", expectedProjectRevision: 3, cursor: null, limit: 25,
    }],
    ["coordination state", coordinationStateInputSchema, {
      projectId: "project-1", taskId: "task-1", expectedProjectRevision: 3,
    }],
    ["renew claim", renewClaimInputSchema, {
      claimId: "claim-1", expectedProjectRevision: 3, expectedTaskRevision: 7, idempotencyKey: "renew-1",
    }],
    ["transition claim", transitionClaimInputSchema, {
      claimId: "claim-1", expectedProjectRevision: 3, expectedTaskRevision: 7, action: "pause", idempotencyKey: "pause-1",
    }],
    ["accept delegation", acceptDelegationInputSchema, {
      delegationId: "delegation-1", projectId: "project-1", taskId: "task-1", expectedProjectRevision: 3, expectedTaskRevision: 7, idempotencyKey: "accept-1",
    }],
    ["revoke delegation", revokeDelegationInputSchema, {
      delegationId: "delegation-1", projectId: "project-1", taskId: "task-1", expectedProjectRevision: 3, expectedTaskRevision: 7, idempotencyKey: "revoke-1",
    }],
  ])("keeps the %s operation contract closed", (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
    expect(() => schema.parse({ ...value, unknown: true })).toThrow();
  });

  it.each([
    ["padded base64url", "eyJjdXJzb3IiOnRydWV9="],
    ["standard base64 plus", "YWJj+"],
    ["standard base64 slash", "YWJj/"],
    ["non-alphabet character", "YWJj$"],
    ["non-canonical trailing bits", "AB"],
  ])("rejects a %s cursor", (_case, cursor) => {
    expect(() => listReadyTasksInputSchema.parse({
      projectId: "project-1",
      expectedProjectRevision: 3,
      cursor,
      limit: 25,
    })).toThrow();
  });

  it("round-trips a maximum-shaped canonical cursor through ready-page output", () => {
    const lastTaskId = `task-${"x".repeat(48)}`;
    const cursor = Buffer.from(JSON.stringify({
      projectId: "project-1",
      projectRevision: 3,
      filterHash: "a".repeat(64),
      lastTaskId,
    }), "utf8").toString("base64url");

    expect(cursor.length).toBeGreaterThan(200);
    expect(opaqueCoordinationCursorSchema.parse(cursor)).toBe(cursor);
    expect(readyTaskPageSchema.parse({
      tasks: [],
      nextCursor: cursor,
      projectRevision: 3,
    })).toEqual({ tasks: [], nextCursor: cursor, projectRevision: 3 });
  });
});

describe("browser-safe coordination schema helpers", () => {
  it.each([
    [
      "checkpoint",
      checkpointClaimInputSchema,
      { ...validCheckpointInput, checkpoint: { ...checkpoint, summary: "BMP é and non-BMP 🧭" } },
      { ...validCheckpointInput, checkpoint: { ...checkpoint, summary: "🧭".repeat(17_000) } },
      "Checkpoint exceeds 64 KiB",
    ],
    [
      "delegation",
      createDelegationInputSchema,
      { ...validDelegationInput, scope: { ...validDelegationInput.scope, summary: "BMP é and non-BMP 🧭" } },
      { ...validDelegationInput, scope: { ...validDelegationInput.scope, summary: "é".repeat(17_000) } },
      "Delegation scope exceeds 32 KiB",
    ],
    [
      "submission",
      submitTaskResultInputSchema,
      { ...validSubmissionInput, submission: { ...validSubmissionInput.submission, summary: "BMP é and non-BMP 🧭" } },
      { ...validSubmissionInput, submission: { ...validSubmissionInput.submission, summary: "🧭".repeat(66_000) } },
      "Submission exceeds 256 KiB",
    ],
  ])("applies %s UTF-8 byte bounds without Node Buffer", (
    _name,
    schema,
    valid,
    oversized,
    expectedMessage,
  ) => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(schema.parse(valid)).toEqual(valid);
      expect(() => schema.parse(oversized)).toThrow(expectedMessage);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips canonical base64url without Node Buffer and rejects malformed padding bits", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(opaqueCoordinationCursorSchema.parse("eyJvayI6dHJ1ZX0"))
        .toBe("eyJvayI6dHJ1ZX0");
      for (const malformed of ["eyJvayI6dHJ1ZX0=", "AB", "A", "YWJj+", "YWJj/"]) {
        expect(() => opaqueCoordinationCursorSchema.parse(malformed)).toThrow();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("task claim time invariants", () => {
  it("requires a four-hour absolute horizon and an in-horizon expiry", () => {
    expect(taskClaimSchema.parse(validTaskClaim)).toEqual(validTaskClaim);
    expect(() => taskClaimSchema.parse({
      ...validTaskClaim,
      absoluteExpiresAt: "2026-08-15T11:59:59.999Z",
    })).toThrow("four hours");
    expect(() => taskClaimSchema.parse({
      ...validTaskClaim,
      expiresAt: validTaskClaim.acquiredAt,
    })).toThrow("after acquiredAt");
    expect(() => taskClaimSchema.parse({
      ...validTaskClaim,
      expiresAt: "2026-08-15T12:00:00.001Z",
    })).toThrow("absoluteExpiresAt");
  });

  it("uses the same lease-valid claim shape for renewal results", () => {
    expect(renewClaimResultSchema.parse({ claim: validTaskClaim })).toEqual({
      claim: validTaskClaim,
    });
  });
});

describe("coordination errors", () => {
  it("exposes only a stable code and fixed public message", () => {
    const error = new CoordinationError("claim_conflict");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("claim_conflict");
    expect(error.message).toBe("Task claim conflicts with current coordination state.");
    expect(Object.keys(error)).toEqual(["code", "name"]);
  });

  it("maps untyped invalid codes to the closed unavailable fallback", () => {
    const error = new CoordinationError("untrusted-code" as never);

    expect(error.code).toBe("coordination_unavailable");
    expect(error.message).toBe("Coordination is unavailable.");
    expect(error.message).not.toContain("untrusted-code");
  });
});
