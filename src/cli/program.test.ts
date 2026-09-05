import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplication, type IntentArcApplication } from "../app/create-application.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import { DurabilityError } from "../durability/errors.js";
import type { DurabilityService } from "../durability/service.js";
import {
  CoordinationError,
  type AuthenticatedProfile,
  type ProfileCredentials,
} from "../domain/index.js";
import { GovernanceError } from "../domain/index.js";
import { RepositoryImportError } from "../import/errors.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import {
  createProgram,
  formatRepositoryImportErrorForCli,
} from "./program.js";

type CapturedOutput = {
  readonly write: (chunk: string) => boolean;
  text(): string;
};

const captureOutput = (): CapturedOutput => {
  let output = "";

  return {
    write: (chunk) => {
      output += chunk;
      return true;
    },
    text: () => output,
  };
};

type CoordinationInputFileStatDouble = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type CoordinationInputFileSystemDouble = {
  lstat(path: string): CoordinationInputFileStatDouble;
  open(path: string): number;
  fstat(fileDescriptor: number): CoordinationInputFileStatDouble;
  read(
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ): number;
  close(fileDescriptor: number): void;
};

const coordinationFileStat = (
  overrides: Partial<CoordinationInputFileStatDouble> = {},
): CoordinationInputFileStatDouble => ({
  dev: 1,
  ino: 2,
  size: 1,
  mtimeMs: 10,
  ctimeMs: 10,
  isFile: () => true,
  isSymbolicLink: () => false,
  ...overrides,
});

const profileCredentials: ProfileCredentials = {
  profileId: "profile-1",
  token: "coordination-token-must-not-leak",
};

const principal: AuthenticatedProfile = {
  id: "profile-1",
  name: "Coordination worker",
  status: "enabled",
  credentialGeneration: "generation-1",
};

const timestamp = "2026-08-15T08:00:00.000Z";
const task = {
  id: "task-1",
  projectId: "project-1",
  kind: "task" as const,
  status: "active" as const,
  title: "Expose coordination CLI",
  body: "Add the authenticated coordination command group.",
  sourceKind: "human" as const,
  sourceRef: null,
  revision: 7,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const nextTask = { ...task, id: "task-2", title: "Next task", revision: 4 };
const readiness = {
  task,
  blockers: [],
  liveClaimId: null,
  liveDelegationId: null,
};
const claim = {
  id: "claim-1",
  projectId: "project-1",
  taskId: "task-1",
  profileId: "profile-1",
  delegationId: null,
  state: "active" as const,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  contextPackId: "pack-1",
  acquiredAt: timestamp,
  expiresAt: "2026-08-15T08:30:00.000Z",
  absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
  endedAt: null,
  latestCheckpointId: null,
};
const claimEvent = {
  id: "event-claim-1",
  category: "claim" as const,
  projectId: claim.projectId,
  taskId: claim.taskId,
  profileId: claim.profileId,
  claimId: claim.id,
  delegationId: null,
  checkpointId: null,
  submissionId: null,
  proposalId: null,
  priorState: null,
  resultingState: "active",
  projectRevision: claim.baseProjectRevision,
  taskRevision: claim.baseTaskRevision,
  detail: null,
  createdAt: claim.acquiredAt,
};
const customHierarchyVocabulary = {
  preset: "neutral" as const,
  outcome: "Goal",
  initiative: "Workstream",
  deliverable: "Result",
  milestone: "Checkpoint",
  task: "Action",
  nestedTask: "Step",
};
const neutralHierarchyVocabulary = {
  preset: "neutral" as const,
  outcome: "Outcome",
  initiative: "Initiative",
  deliverable: "Deliverable",
  milestone: "Milestone",
  task: "Work item",
  nestedTask: "Subtask",
};
const contextPack = {
  id: "pack-1",
  projectId: "project-1",
  taskId: "task-1",
  projectRevision: 3,
  generatedAt: timestamp,
  budgetTokens: 4_096,
  estimatedTokens: 100,
  hierarchyVocabulary: customHierarchyVocabulary,
  stableFrame: [],
  task: {
    record: task,
    mandatory: true,
    relevance: "active_task" as const,
    relationshipKind: null,
  },
  related: [],
  omissions: [],
  sourceRevisions: [{ recordId: "task-1", revision: 7 }],
};
const verificationEvidence = { tests: ["pnpm test"], artifacts: [] };
const checkpointDocument = {
  summary: "Implemented the coordination CLI.",
  completedWork: ["Added commands."],
  remainingWork: ["Run verification."],
  blockers: [],
  verificationEvidence,
  repositoryEvidence: null,
};
const savedCheckpoint = {
  ...checkpointDocument,
  id: "checkpoint-1",
  claimId: "claim-1",
  sequence: 1,
  createdAt: timestamp,
  projectRevision: 3,
  taskRevision: 7,
  contextPackId: "pack-1",
};
const delegation = {
  id: "delegation-1",
  projectId: "project-1",
  taskId: "task-1",
  parentProfileId: "profile-1",
  childProfileId: "profile-child",
  state: "offered" as const,
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  scope: { summary: "Implement Task 8.", constraints: [] },
  allowedOutputs: ["create_record", "update_record"],
  offeredAt: timestamp,
  deadline: "2026-08-15T10:00:00.000Z",
  acceptedAt: null,
  endedAt: null,
  claimId: null,
};
const submission = {
  id: "submission-1",
  claimId: "claim-1",
  checkpointId: "checkpoint-1",
  profileId: "profile-1",
  projectId: "project-1",
  taskId: "task-1",
  baseProjectRevision: 3,
  baseTaskRevision: 7,
  contextPackId: "pack-1",
  summary: "Task 8 is complete.",
  verificationEvidence,
  repositoryEvidence: null,
  proposalId: "proposal-1",
  state: "submitted" as const,
  submittedAt: timestamp,
  decidedAt: null,
};
const proposal = {
  id: "proposal-1",
  projectId: "project-1",
  origin: { type: "profile" as const, profileId: "profile-1" },
  sourceTaskId: "task-1",
  predecessorProposalId: null,
  baseProjectRevision: 3,
  state: "pending" as const,
  rationale: "Complete the coordinated task.",
  idempotencyKey: "coordination:submit-1",
  requestHash: "a".repeat(64),
  reviewReason: null,
  reviewerActor: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  reviewedAt: null,
};

const coordinationInputs = {
  claim: {
    projectId: "project-1",
    taskId: "task-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    contextBudgetTokens: 4_096,
    acceptedDelegationId: null,
    idempotencyKey: "claim-1",
  },
  renew: {
    claimId: "claim-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    idempotencyKey: "renew-1",
  },
  checkpoint: {
    claimId: "claim-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    checkpoint: checkpointDocument,
    idempotencyKey: "checkpoint-1",
  },
  transition: {
    claimId: "claim-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    action: "pause" as const,
    idempotencyKey: "pause-1",
  },
  switch: {
    currentClaimId: "claim-1",
    projectId: "project-1",
    currentTaskId: "task-1",
    expectedCurrentProjectRevision: 3,
    expectedCurrentTaskRevision: 7,
    checkpoint: checkpointDocument,
    terminalAction: "pause" as const,
    nextTaskId: "task-2",
    expectedNextProjectRevision: 3,
    expectedNextTaskRevision: 4,
    nextContextBudgetTokens: 4_096,
    acceptedDelegationId: null,
    idempotencyKey: "switch-1",
  },
  delegate: {
    projectId: "project-1",
    taskId: "task-1",
    childProfileId: "profile-child",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    scope: { summary: "Implement Task 8.", constraints: [] },
    allowedOutputs: ["create_record", "update_record"],
    deadline: "2026-08-15T10:00:00.000Z",
    idempotencyKey: "delegate-1",
  },
  acceptDelegation: {
    delegationId: "delegation-1",
    projectId: "project-1",
    taskId: "task-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    idempotencyKey: "accept-1",
  },
  revokeDelegation: {
    delegationId: "delegation-1",
    projectId: "project-1",
    taskId: "task-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    idempotencyKey: "revoke-1",
  },
  submit: {
    claimId: "claim-1",
    checkpointId: "checkpoint-1",
    expectedProjectRevision: 3,
    expectedTaskRevision: 7,
    submission: {
      summary: "Task 8 is complete.",
      verificationEvidence,
      repositoryEvidence: null,
      changes: { rationale: "Complete the coordinated task.", operations: [] },
    },
    idempotencyKey: "submit-1",
  },
};

const temporaryInputDirectories: string[] = [];
const writeCoordinationInput = (value: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), "intentarc-coordination-cli-"));
  temporaryInputDirectories.push(directory);
  const path = join(directory, "input.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
};

afterEach(() => {
  for (const directory of temporaryInputDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createService = (): IntentArcService =>
  ({
    createProject: vi.fn(),
    listProjects: vi.fn(),
    getProjectSummary: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    createRelationship: vi.fn(),
    getTaskContext: vi.fn(),
    profiles: {
      createProfile: vi.fn(),
      listProfiles: vi.fn(),
      setAuthority: vi.fn(),
      addScope: vi.fn(),
      removeScope: vi.fn(),
      rotateToken: vi.fn(),
      setEnabled: vi.fn(),
      authenticate: vi.fn().mockReturnValue(principal),
      revalidatePrincipal: vi.fn().mockReturnValue(principal),
    },
    coordination: {
      resolveOwnedClaimSnapshot: vi.fn().mockReturnValue(claim),
      resolveAuthorizedDelegation: vi.fn((_input, _principal, requiredRole) =>
        requiredRole === "child"
          ? { ...delegation, childProfileId: principal.id }
          : delegation),
      listReadyTasks: vi.fn().mockReturnValue({
        tasks: [readiness],
        nextCursor: null,
        projectRevision: 3,
      }),
      getCoordinationState: vi.fn().mockReturnValue({
        projectRevision: 3,
        task,
        claim,
        delegation: null,
        latestCheckpoint: null,
        submission: null,
        events: [claimEvent],
      }),
      claimTask: vi.fn().mockReturnValue({ claim, readiness, contextPack }),
      renewClaim: vi.fn().mockReturnValue({ claim }),
      checkpointClaim: vi.fn().mockReturnValue({
        claim: { ...claim, latestCheckpointId: savedCheckpoint.id },
        checkpoint: savedCheckpoint,
      }),
      transitionClaim: vi.fn().mockReturnValue({
        claim: { ...claim, state: "paused", endedAt: timestamp },
      }),
      switchTask: vi.fn().mockReturnValue({
        previousClaim: {
          ...claim,
          state: "paused",
          endedAt: timestamp,
          latestCheckpointId: savedCheckpoint.id,
        },
        nextClaim: {
          ...claim,
          id: "claim-2",
          taskId: "task-2",
          baseTaskRevision: 4,
          contextPackId: "pack-2",
        },
        checkpoint: savedCheckpoint,
        contextPack: {
          ...contextPack,
          id: "pack-2",
          taskId: "task-2",
          hierarchyVocabulary: neutralHierarchyVocabulary,
          task: { ...contextPack.task, record: nextTask },
          sourceRevisions: [{ recordId: "task-2", revision: 4 }],
        },
      }),
      createDelegation: vi.fn().mockReturnValue({ delegation }),
      acceptDelegation: vi.fn().mockReturnValue({
        delegation: {
          ...delegation,
          childProfileId: principal.id,
          state: "accepted",
          acceptedAt: timestamp,
        },
      }),
      revokeDelegation: vi.fn().mockReturnValue({
        delegation: { ...delegation, state: "revoked", endedAt: timestamp },
      }),
      submitTaskResult: vi.fn().mockReturnValue({
        claim: {
          ...claim, state: "submitted", endedAt: timestamp,
          latestCheckpointId: "checkpoint-1",
        },
        submission,
        proposal,
      }),
    },
    proposals: {
      list: vi.fn(),
      get: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
      withdraw: vi.fn(),
    },
    listAuditEvents: vi.fn(),
  }) as unknown as IntentArcService;

const createDurabilityService = (): DurabilityService => ({
  checkIntegrity: vi.fn(),
  createBackup: vi.fn(),
  listBackups: vi.fn(),
  verifyBackup: vi.fn(),
  restoreBackup: vi.fn(),
});

const run = async (
  arguments_: string[],
  service = createService(),
  options: {
    isTTY?: boolean;
    confirm?: boolean;
    databasePath?: string;
    durabilityService?: DurabilityService;
    targetExists?: boolean;
    profileCredentials?: ProfileCredentials | null;
  } = {},
) => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const confirmationService = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? true),
  };
  const program = createProgram({
    service,
    stdout,
    stderr,
    stdin: { isTTY: options.isTTY },
    confirmationService,
    databasePath: options.databasePath,
    durabilityService: options.durabilityService,
    targetExists: () => options.targetExists ?? false,
    profileCredentials: options.profileCredentials ?? null,
  });

  await program.parseAsync(arguments_, { from: "user" });

  return {
    service,
    stdout: stdout.text(),
    stderr: stderr.text(),
    confirmationService,
  };
};

const createProgramHarness = (
  service = createService(),
  options: {
    isTTY?: boolean;
    confirm?: boolean;
    profileCredentials?: ProfileCredentials | null;
    coordinationInputFileSystem?: CoordinationInputFileSystemDouble;
  } = {},
) => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const confirmationService = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? true),
  };
  const program = createProgram({
    service,
    stdout,
    stderr,
    stdin: { isTTY: options.isTTY },
    confirmationService,
    profileCredentials: options.profileCredentials ?? null,
    ...(options.coordinationInputFileSystem === undefined
      ? {}
      : { coordinationInputFileSystem: options.coordinationInputFileSystem }),
  });
  return { service, stdout, stderr, confirmationService, program };
};

describe("IntentArc CLI program", () => {
  const databasePath = resolve("relative", "intentarc.sqlite");

  it("formats only closed, schema-valid repository import error details", () => {
    const expectedDigest = "a".repeat(64);
    const actualDigest = "b".repeat(64);
    const error = new RepositoryImportError("manifest_digest_mismatch", {
      expectedDigest,
      actualDigest,
    });

    expect(formatRepositoryImportErrorForCli(error)).toBe(
      "manifest_digest_mismatch: Import manifest digest does not match confirmation. " +
        `Details: {\"expectedDigest\":\"${expectedDigest}\",\"actualDigest\":\"${actualDigest}\"}`,
    );

    Object.assign(error, {
      details: {
        expectedDigest,
        actualDigest,
        manifest: "PRIVATE RECORD BODY",
      },
    });
    expect(formatRepositoryImportErrorForCli(error)).toBeUndefined();
  });

  it("maps every durability command to strict absolute-path service inputs and JSON outputs", async () => {
    const durability = createDurabilityService();
    const integrity = { command: "integrity" };
    const created = { command: "created" };
    const listed = [{ command: "listed" }];
    const verified = { command: "verified" };
    vi.mocked(durability.checkIntegrity).mockResolvedValue(integrity as never);
    vi.mocked(durability.createBackup).mockResolvedValue(created as never);
    vi.mocked(durability.listBackups).mockResolvedValue(listed as never);
    vi.mocked(durability.verifyBackup).mockResolvedValue(verified as never);

    const integrityResult = await run(["integrity", "check"], undefined, {
      databasePath,
      durabilityService: durability,
    });
    const createResult = await run(
      ["backup", "create", "--output", "relative/backups"],
      undefined,
      { databasePath, durabilityService: durability },
    );
    const listResult = await run(
      ["backup", "list", "--root", "relative/archive"],
      undefined,
      { databasePath, durabilityService: durability },
    );
    const verifyResult = await run(
      ["backup", "verify", "--backup", "relative/manual.intentarc-backup"],
      undefined,
      { durabilityService: durability },
    );

    expect(durability.checkIntegrity).toHaveBeenCalledWith(databasePath);
    expect(durability.createBackup).toHaveBeenCalledWith({
      databasePath,
      outputRoot: resolve("relative/backups"),
      reason: "manual",
    });
    expect(durability.listBackups).toHaveBeenCalledWith(
      databasePath,
      resolve("relative/archive"),
    );
    expect(durability.verifyBackup).toHaveBeenCalledWith(
      resolve("relative/manual.intentarc-backup"),
    );
    expect(integrityResult.stdout).toBe(
      `${JSON.stringify(integrity, null, 2)}\n`,
    );
    expect(createResult.stdout).toBe(`${JSON.stringify(created, null, 2)}\n`);
    expect(listResult.stdout).toBe(`${JSON.stringify(listed, null, 2)}\n`);
    expect(verifyResult.stdout).toBe(`${JSON.stringify(verified, null, 2)}\n`);
  });

  it("uses default backup roots without manufacturing optional inputs", async () => {
    const durability = createDurabilityService();
    vi.mocked(durability.createBackup).mockResolvedValue({} as never);
    vi.mocked(durability.listBackups).mockResolvedValue([]);

    await run(["backup", "create"], undefined, {
      databasePath,
      durabilityService: durability,
    });
    await run(["backup", "list"], undefined, {
      databasePath,
      durabilityService: durability,
    });

    expect(durability.createBackup).toHaveBeenCalledWith({
      databasePath,
      reason: "manual",
    });
    expect(durability.listBackups).toHaveBeenCalledWith(databasePath);
  });

  it("prompts before restoring an existing target and forwards confirmation and identity override", async () => {
    const durability = createDurabilityService();
    const restored = { command: "restored" };
    vi.mocked(durability.restoreBackup).mockResolvedValue(restored as never);

    const result = await run(
      [
        "backup",
        "restore",
        "--backup",
        "relative/manual.intentarc-backup",
        "--allow-different-store",
      ],
      undefined,
      {
        databasePath,
        durabilityService: durability,
        isTTY: true,
        confirm: true,
        targetExists: true,
      },
    );

    expect(result.confirmationService.confirm).toHaveBeenCalledWith(
      "Restore over the existing store?",
    );
    expect(durability.restoreBackup).toHaveBeenCalledWith({
      targetDatabasePath: databasePath,
      bundlePath: resolve("relative/manual.intentarc-backup"),
      confirmed: true,
      allowDifferentStore: true,
    });
    expect(result.stdout).toBe(`${JSON.stringify(restored, null, 2)}\n`);
  });

  it("cancels a declined existing-target restore without calling the service", async () => {
    const durability = createDurabilityService();

    const result = await run(
      ["backup", "restore", "--backup", "relative/manual.intentarc-backup"],
      undefined,
      {
        databasePath,
        durabilityService: durability,
        isTTY: true,
        confirm: false,
        targetExists: true,
      },
    );

    expect(result.stdout).toBe(
      `${JSON.stringify({ cancelled: true }, null, 2)}\n`,
    );
    expect(durability.restoreBackup).not.toHaveBeenCalled();
  });

  it("prompts when only a crash sidecar remains at the restore target", async () => {
    const durability = createDurabilityService();
    const targetExists = vi.fn(
      (path: string) => path === `${databasePath}-wal`,
    );
    vi.mocked(durability.restoreBackup).mockResolvedValue({} as never);
    const harness = createProgramHarness(undefined, {
      isTTY: true,
      confirm: true,
    });
    const program = createProgram({
      service: harness.service,
      durabilityService: durability,
      databasePath,
      stdout: harness.stdout,
      stderr: harness.stderr,
      stdin: { isTTY: true },
      confirmationService: harness.confirmationService,
      targetExists,
    });

    await program.parseAsync(
      ["backup", "restore", "--backup", "relative/manual.intentarc-backup"],
      { from: "user" },
    );

    expect(targetExists.mock.calls.map(([path]) => path)).toEqual([
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]);
    expect(harness.confirmationService.confirm).toHaveBeenCalledWith(
      "Restore over the existing store?",
    );
    expect(durability.restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true }),
    );
  });

  it("requires --yes for non-TTY restore and does not treat the identity override as confirmation", async () => {
    const durability = createDurabilityService();
    const harness = createProgramHarness();
    const program = createProgram({
      service: harness.service,
      durabilityService: durability,
      databasePath,
      stdout: harness.stdout,
      stderr: harness.stderr,
      stdin: { isTTY: false },
      confirmationService: harness.confirmationService,
      targetExists: () => true,
    });

    await expect(
      program.parseAsync(
        [
          "backup",
          "restore",
          "--backup",
          "relative/manual.intentarc-backup",
          "--allow-different-store",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe(
      "confirmation_required: Restore confirmation is required.\n",
    );
    expect(durability.restoreBackup).not.toHaveBeenCalled();
  });

  it("--yes bypasses prompting and reaches restore with confirmed true", async () => {
    const durability = createDurabilityService();
    vi.mocked(durability.restoreBackup).mockResolvedValue({} as never);

    const result = await run(
      [
        "backup",
        "restore",
        "--backup",
        "relative/manual.intentarc-backup",
        "--yes",
      ],
      undefined,
      {
        databasePath,
        durabilityService: durability,
        isTTY: true,
        targetExists: true,
      },
    );

    expect(result.confirmationService.confirm).not.toHaveBeenCalled();
    expect(durability.restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, allowDifferentStore: false }),
    );
  });

  it("prints the stable durability error and its safe typed recovery details", async () => {
    const durability = createDurabilityService();
    vi.mocked(durability.createBackup).mockRejectedValue(
      new DurabilityError("backup_failed", { recoveryAction: "retry" }),
    );
    const harness = createProgramHarness();
    const program = createProgram({
      service: harness.service,
      durabilityService: durability,
      databasePath,
      stdout: harness.stdout,
      stderr: harness.stderr,
      stdin: { isTTY: false },
      confirmationService: harness.confirmationService,
    });

    await expect(
      program.parseAsync(["backup", "create"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe(
      "backup_failed: Backup operation failed. Recovery details: " +
        "{\"recoveryAction\":\"retry\"}\n",
    );
    expect(harness.stderr.text()).not.toMatch(
      /stack|select|secret|cause/i,
    );
  });

  it("prints the product and package version without invoking the service", async () => {
    const service = createService();
    const stdout = captureOutput();
    const stderr = captureOutput();
    const program = createProgram({
      service,
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
    });

    await expect(
      program.parseAsync(["--version"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 0 });

    expect(stdout.text()).toBe("intentarc 0.1.0\n");
    expect(stderr.text()).toBe("");
    expect(service.createProject).not.toHaveBeenCalled();
    expect(service.listProjects).not.toHaveBeenCalled();
    expect(service.getProjectSummary).not.toHaveBeenCalled();
    expect(service.createRecord).not.toHaveBeenCalled();
    expect(service.createRelationship).not.toHaveBeenCalled();
    expect(service.getTaskContext).not.toHaveBeenCalled();
  });

  it("prints one JSON document for project list and invokes the service once", async () => {
    const service = createService();
    const projects = [
      {
        id: "project-1",
        name: "IntentArc",
        revision: 0,
        primaryRepositoryPath: null,
        createdAt: "2026-07-26T12:00:00.000Z",
        updatedAt: "2026-07-26T12:00:00.000Z",
      },
    ];
    vi.mocked(service.listProjects).mockReturnValue(projects);

    const result = await run(["project", "list"], service);

    expect(result.stdout).toBe(`${JSON.stringify(projects, null, 2)}\n`);
    expect(result.stderr).toBe("");
    expect(service.listProjects).toHaveBeenCalledTimes(1);
  });

  it("maps record add options to the service input", async () => {
    const service = createService();
    const created = { id: "record-1" };
    vi.mocked(service.createRecord).mockReturnValue(created as never);

    const result = await run(
      [
        "record",
        "add",
        "--project",
        "project-1",
        "--kind",
        "task",
        "--status",
        "active",
        "--title",
        "Ship CLI",
        "--body",
        "Use a JSON contract.",
        "--source-kind",
        "agent",
        "--source-ref",
        "task-8",
      ],
      service,
    );

    expect(service.createRecord).toHaveBeenCalledWith({
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Ship CLI",
      body: "Use a JSON contract.",
      sourceKind: "agent",
      sourceRef: "task-8",
    });
    expect(result.stdout).toBe(`${JSON.stringify(created, null, 2)}\n`);
  });

  it("maps record link options to the service input", async () => {
    const service = createService();
    const created = { id: "relationship-1" };
    vi.mocked(service.createRelationship).mockReturnValue(created as never);

    const result = await run(
      [
        "record",
        "link",
        "--project",
        "project-1",
        "--from",
        "record-1",
        "--to",
        "record-2",
        "--kind",
        "implements",
        "--expected-revision",
        "7",
      ],
      service,
    );

    expect(service.createRelationship).toHaveBeenCalledWith({
      projectId: "project-1",
      fromRecordId: "record-1",
      toRecordId: "record-2",
      kind: "implements",
      expectedProjectRevision: 7,
    });
    expect(result.stdout).toBe(`${JSON.stringify(created, null, 2)}\n`);
  });

  it("maps record update options to a strict revisioned patch", async () => {
    const service = createService();
    vi.mocked(service.updateRecord).mockReturnValue({ id: "record-1" } as never);

    await run(
      [
        "record",
        "update",
        "--project",
        "project-1",
        "--record",
        "record-1",
        "--expected-revision",
        "3",
        "--title",
        "Governed title",
        "--status",
        "accepted",
      ],
      service,
    );

    expect(service.updateRecord).toHaveBeenCalledWith({
      projectId: "project-1",
      recordId: "record-1",
      expectedRecordRevision: 3,
      patch: { title: "Governed title", status: "accepted" },
    });
  });

  it("emits profile creation credentials in one JSON document", async () => {
    const service = createService();
    const created = {
      profile: { id: "profile-1", name: "Build agent" },
      token: "one-time-token",
    };
    vi.mocked(service.profiles.createProfile).mockReturnValue(created as never);

    const result = await run(
      [
        "profile",
        "create",
        "--name",
        "Build agent",
        "--project",
        "project-1",
      ],
      service,
    );

    expect(service.profiles.createProfile).toHaveBeenCalledWith({
      name: "Build agent",
      projectId: "project-1",
    });
    expect(JSON.parse(result.stdout)).toEqual(created);
  });

  it("lists profiles without rendering token or hash fields", async () => {
    const service = createService();
    const profiles = [{
      profile: {
        id: "profile-1",
        name: "Build agent",
        status: "enabled",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        tokenRotatedAt: "2026-07-27T00:00:00.000Z",
        lastUsedAt: null,
      },
      authorities: [],
    }];
    vi.mocked(service.profiles.listProfiles).mockReturnValue([{
      ...profiles[0],
      profile: {
        ...profiles[0]!.profile,
        token: "one-time-secret",
        tokenHash: "credential-hash",
      },
    }] as never);

    const result = await run(["profile", "list"], service);

    expect(JSON.parse(result.stdout)).toEqual(profiles);
    expect(result.stdout).not.toMatch(/tokenHash|"token"\s*:/);
  });

  it("maps profile authority administration commands", async () => {
    const service = createService();
    vi.mocked(service.profiles.setAuthority).mockReturnValue({
      id: "authority-1",
    } as never);

    const result = await run(
      [
        "profile",
        "set-authority",
        "--profile",
        "profile-1",
        "--project",
        "project-1",
        "--mode",
        "scoped_direct",
      ],
      service,
      { isTTY: true, confirm: true },
    );

    expect(service.profiles.setAuthority).toHaveBeenCalledWith({
      profileId: "profile-1",
      projectId: "project-1",
      mode: "scoped_direct",
    });
    expect(result.confirmationService.confirm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.stdout)).toEqual({ id: "authority-1" });
  });

  it("resolves add-scope authority from the profile and project assignment", async () => {
    const service = createService();
    vi.mocked(service.profiles.listProfiles).mockReturnValue([{
      profile: { id: "profile-1" },
      authorities: [{
        authority: {
          id: "authority-1",
          profileId: "profile-1",
          projectId: "project-1",
        },
        scopes: [],
      }],
    }] as never);
    vi.mocked(service.profiles.addScope).mockReturnValue({ id: "scope-1" } as never);

    await run(
      [
        "profile",
        "add-scope",
        "--profile",
        "profile-1",
        "--project",
        "project-1",
        "--operation",
        "create_relationship",
        "--from-record-kind",
        "task",
        "--to-record-kind",
        "evidence",
        "--relationship-kind",
        "evidenced_by",
      ],
      service,
    );

    expect(service.profiles.addScope).toHaveBeenCalledWith({
      authorityId: "authority-1",
      operationType: "create_relationship",
      recordKind: null,
      fromRecordKind: "task",
      toRecordKind: "evidence",
      relationshipKind: "evidenced_by",
    });
  });

  it("acknowledges scope removal after the void service method succeeds", async () => {
    const service = createService();

    const result = await run(
      ["profile", "remove-scope", "--scope", "scope-1"],
      service,
    );

    expect(service.profiles.removeScope).toHaveBeenCalledWith("scope-1");
    expect(JSON.parse(result.stdout)).toEqual({
      removed: true,
      scopeId: "scope-1",
    });
  });

  it("emits rotated credentials in one JSON document", async () => {
    const service = createService();
    const rotated = { profileId: "profile-1", token: "replacement-token" };
    vi.mocked(service.profiles.rotateToken).mockReturnValue(rotated);

    const result = await run(
      ["profile", "rotate-token", "--profile", "profile-1"],
      service,
    );

    expect(service.profiles.rotateToken).toHaveBeenCalledWith("profile-1");
    expect(JSON.parse(result.stdout)).toEqual(rotated);
  });

  it.each([
    ["enable", true],
    ["disable", false],
  ] as const)("maps profile %s to setEnabled", async (command, enabled) => {
    const service = createService();
    vi.mocked(service.profiles.setEnabled).mockReturnValue({
      id: "profile-1",
      status: enabled ? "enabled" : "disabled",
    } as never);

    await run(["profile", command, "--profile", "profile-1"], service);

    expect(service.profiles.setEnabled).toHaveBeenCalledWith(
      "profile-1",
      enabled,
    );
  });

  it("maps proposal list filters and show identifiers", async () => {
    const service = createService();
    vi.mocked(service.proposals.list).mockReturnValue([]);
    vi.mocked(service.proposals.get).mockReturnValue({
      id: "proposal-1",
    } as never);

    const listed = await run(
      [
        "proposal",
        "list",
        "--project",
        "project-1",
        "--state",
        "conflicted",
      ],
      service,
    );
    const shown = await run(
      ["proposal", "show", "--proposal", "proposal-1"],
      service,
    );

    expect(service.proposals.list).toHaveBeenCalledWith({
      projectId: "project-1",
      state: "conflicted",
    });
    expect(service.proposals.get).toHaveBeenCalledWith("proposal-1");
    expect(JSON.parse(listed.stdout)).toEqual([]);
    expect(JSON.parse(shown.stdout)).toEqual({ id: "proposal-1" });
  });

  it("maps proposal decisions and their reasons", async () => {
    const service = createService();
    vi.mocked(service.proposals.accept).mockReturnValue({
      proposal: { id: "proposal-1", state: "accepted" },
    } as never);
    vi.mocked(service.proposals.reject).mockReturnValue({
      id: "proposal-2",
      state: "rejected",
    } as never);
    vi.mocked(service.proposals.withdraw).mockReturnValue({
      id: "proposal-3",
      state: "withdrawn",
    } as never);

    await run(["proposal", "accept", "--proposal", "proposal-1"], service);
    await run(
      [
        "proposal",
        "reject",
        "--proposal",
        "proposal-2",
        "--reason",
        "Unsafe change",
      ],
      service,
    );
    await run(
      [
        "proposal",
        "withdraw",
        "--proposal",
        "proposal-3",
        "--reason",
        "Superseded",
      ],
      service,
    );

    expect(service.proposals.accept).toHaveBeenCalledWith("proposal-1");
    expect(service.proposals.reject).toHaveBeenCalledWith({
      proposalId: "proposal-2",
      reason: "Unsafe change",
    });
    expect(service.proposals.withdraw).toHaveBeenCalledWith({
      proposalId: "proposal-3",
      reason: "Superseded",
    });
  });

  it("maps the audit limit as an integer for storage clamping", async () => {
    const service = createService();
    vi.mocked(service.listAuditEvents).mockReturnValue([]);

    await run(
      ["audit", "list", "--project", "project-1", "--limit", "500"],
      service,
    );

    expect(service.listAuditEvents).toHaveBeenCalledWith({
      projectId: "project-1",
      limit: 500,
    });
  });

  it.each([
    ["profile", "set-authority", "--profile", "p", "--project", "x", "--mode", "proposal"],
    ["profile", "add-scope", "--profile", "p", "--project", "x", "--operation", "create_record"],
    ["profile", "remove-scope", "--scope", "s"],
    ["profile", "rotate-token", "--profile", "p"],
    ["profile", "enable", "--profile", "p"],
    ["profile", "disable", "--profile", "p"],
    ["proposal", "accept", "--proposal", "p"],
    ["proposal", "reject", "--proposal", "p", "--reason", "No"],
  ])("cancels confirmed TTY mutations without invoking them: %s %s", async (...arguments_) => {
    const service = createService();
    vi.mocked(service.profiles.listProfiles).mockReturnValue([{
      profile: { id: "p" },
      authorities: [{
        authority: { id: "a", profileId: "p", projectId: "x" },
        scopes: [],
      }],
    }] as never);

    const result = await run(arguments_, service, {
      isTTY: true,
      confirm: false,
    });

    expect(JSON.parse(result.stdout)).toEqual({ cancelled: true });
    expect(result.confirmationService.confirm).toHaveBeenCalledTimes(1);
    const mutationCalls = [
      service.profiles.setAuthority,
      service.profiles.addScope,
      service.profiles.removeScope,
      service.profiles.rotateToken,
      service.profiles.setEnabled,
      service.proposals.accept,
      service.proposals.reject,
    ].reduce((total, method) => total + vi.mocked(method).mock.calls.length, 0);
    expect(mutationCalls).toBe(0);
  });

  it("does not confirm withdrawal or non-TTY mutations", async () => {
    const service = createService();
    vi.mocked(service.proposals.withdraw).mockReturnValue({
      id: "proposal-1",
    } as never);
    const nonTty = await run(
      ["profile", "disable", "--profile", "profile-1"],
      service,
      { isTTY: false },
    );
    const withdrawal = await run(
      [
        "proposal",
        "withdraw",
        "--proposal",
        "proposal-1",
        "--reason",
        "Superseded",
      ],
      service,
      { isTTY: true },
    );

    expect(nonTty.confirmationService.confirm).not.toHaveBeenCalled();
    expect(withdrawal.confirmationService.confirm).not.toHaveBeenCalled();
  });

  it("keeps trusted local context get mapped directly with its default budget", async () => {
    const service = createService();
    vi.mocked(service.getTaskContext).mockReturnValue({ id: "context-1" } as never);

    await run(
      ["context", "get", "--project", "project-1", "--task", "record-1"],
      service,
    );

    expect(service.getTaskContext).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "record-1",
      budgetTokens: 4_000,
    });
  });

  it("reports an invalid record enum with exit code 2 before calling the service", async () => {
    const service = createService();
    const stdout = captureOutput();
    const stderr = captureOutput();
    const program = createProgram({
      service,
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
    });

    await expect(
      program.parseAsync(
        [
          "record",
          "add",
          "--project",
          "project-1",
          "--kind",
          "unknown",
          "--status",
          "active",
          "--title",
          "Bad kind",
          "--body",
          "This must not reach the service.",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ exitCode: 2 });

    expect(stderr.text()).toBe("Invalid command input.\n");
    expect(stdout.text()).toBe("");
    expect(service.createRecord).not.toHaveBeenCalled();
  });

  it("reports a budget below one with exit code 2 before calling the service", async () => {
    const service = createService();
    const stdout = captureOutput();
    const stderr = captureOutput();
    const program = createProgram({
      service,
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
    });

    await expect(
      program.parseAsync(
        [
          "context",
          "get",
          "--project",
          "project-1",
          "--task",
          "record-1",
          "--budget",
          "0",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ exitCode: 2 });

    expect(stderr.text()).toBe("Invalid command input.\n");
    expect(stdout.text()).toBe("");
    expect(service.getTaskContext).not.toHaveBeenCalled();
  });

  it("reports a missing required option with exit code 2 before calling the service", async () => {
    const service = createService();
    const stdout = captureOutput();
    const stderr = captureOutput();
    const program = createProgram({
      service,
      stdout,
      stderr,
      stdin: { isTTY: false },
      confirmationService: { confirm: vi.fn() },
    });

    await expect(
      program.parseAsync(["project", "create"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });

    expect(stderr.text()).toContain("required option '--name <name>' not specified");
    expect(stdout.text()).toBe("");
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it.each([
    ["profile", "create", "--name", "  "],
    ["profile", "set-authority", "--profile", "p", "--project", "x", "--mode", "root"],
    ["profile", "add-scope", "--profile", "p", "--project", "x", "--operation", "create_record", "--from-record-kind", "task"],
    ["profile", "add-scope", "--profile", "p", "--project", "x", "--operation", "create_relationship", "--record-kind", "task"],
    ["proposal", "list", "--project", "x", "--state", "reviewed"],
    ["proposal", "reject", "--proposal", "p", "--reason", "  "],
    ["proposal", "withdraw", "--proposal", "p", "--reason", "  "],
    ["record", "update", "--project", "x", "--record", "r", "--expected-revision", "0", "--title", "x"],
    ["record", "update", "--project", "x", "--record", "r", "--expected-revision", "1"],
    ["audit", "list", "--project", "x", "--limit", "0"],
    ["audit", "list", "--project", "x", "--limit", "501"],
    ["audit", "list", "--project", "x", "--limit", "1.5"],
  ])("rejects invalid governance input before service invocation: %s %s", async (...arguments_) => {
    const harness = createProgramHarness();

    await expect(
      harness.program.parseAsync(arguments_, { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stdout.text()).toBe("");
    const calls = [
      harness.service.updateRecord,
      harness.service.profiles.createProfile,
      harness.service.profiles.setAuthority,
      harness.service.profiles.listProfiles,
      harness.service.profiles.addScope,
      harness.service.proposals.list,
      harness.service.proposals.reject,
      harness.service.proposals.withdraw,
      harness.service.listAuditEvents,
    ].reduce((total, method) => total + vi.mocked(method).mock.calls.length, 0);
    expect(calls).toBe(0);
  });

  it("reports a missing project authority as a safe governance error", async () => {
    const service = createService();
    vi.mocked(service.profiles.listProfiles).mockReturnValue([]);
    const harness = createProgramHarness(service);

    await expect(
      harness.program.parseAsync(
        [
          "profile",
          "add-scope",
          "--profile",
          "profile-1",
          "--project",
          "project-1",
          "--operation",
          "create_record",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toContain("Project authority is missing");
    expect(service.profiles.addScope).not.toHaveBeenCalled();
  });

  it("reports expected governance failures without credential details", async () => {
    const service = createService();
    vi.mocked(service.proposals.accept).mockImplementation(() => {
      throw new GovernanceError(
        "proposal_not_pending",
        "Proposal is not pending",
        { token: "must-not-leak" },
      );
    });
    const harness = createProgramHarness(service);

    await expect(
      harness.program.parseAsync(
        ["proposal", "accept", "--proposal", "proposal-1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe("Proposal is not pending\n");
    expect(harness.stderr.text()).not.toContain("must-not-leak");
  });
});

describe("IntentArc coordination CLI", () => {
  it.each([
    {
      command: [
        "coordination", "ready", "--project", "project-1",
        "--expected-project-revision", "3", "--limit", "25",
      ],
      method: "listReadyTasks" as const,
      input: {
        projectId: "project-1",
        expectedProjectRevision: 3,
        cursor: null,
        limit: 25,
      },
      output: { tasks: [readiness], nextCursor: null, projectRevision: 3 },
    },
    {
      command: [
        "coordination", "state", "--project", "project-1", "--task", "task-1",
        "--expected-project-revision", "3",
      ],
      method: "getCoordinationState" as const,
      input: { projectId: "project-1", taskId: "task-1", expectedProjectRevision: 3 },
      output: {
        projectRevision: 3,
        task,
        claim,
        delegation: null,
        latestCheckpoint: null,
        submission: null,
        events: [claimEvent],
      },
    },
  ])("maps coordination $method bounded flags to authenticated public JSON", async ({
    command,
    method,
    input,
    output,
  }) => {
    const service = createService();
    const result = await run(command, service, { profileCredentials });

    expect(service.profiles.authenticate).toHaveBeenCalledWith(profileCredentials);
    expect(service.profiles.revalidatePrincipal).toHaveBeenCalledWith(principal);
    expect(service.coordination[method]).toHaveBeenCalledWith(input, principal);
    expect(
      vi.mocked(service.profiles.authenticate).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(service.profiles.revalidatePrincipal).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(service.profiles.revalidatePrincipal).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(service.coordination[method]).mock.invocationCallOrder[0]!,
    );
    expect(result.stdout).toBe(`${JSON.stringify(output, null, 2)}\n`);
    expect(result.stderr).toBe("");
  });

  it.each([
    {
      command: "claim",
      method: "claimTask" as const,
      input: coordinationInputs.claim,
      output: { claim, readiness, contextPack },
    },
    {
      command: "renew",
      method: "renewClaim" as const,
      input: coordinationInputs.renew,
      output: { claim },
    },
    {
      command: "checkpoint",
      method: "checkpointClaim" as const,
      input: coordinationInputs.checkpoint,
      output: {
        claim: { ...claim, latestCheckpointId: savedCheckpoint.id },
        checkpoint: savedCheckpoint,
      },
    },
    {
      command: "transition",
      method: "transitionClaim" as const,
      input: coordinationInputs.transition,
      output: { claim: { ...claim, state: "paused", endedAt: timestamp } },
    },
    {
      command: "switch",
      method: "switchTask" as const,
      input: coordinationInputs.switch,
      output: {
        previousClaim: {
          ...claim,
          state: "paused",
          endedAt: timestamp,
          latestCheckpointId: savedCheckpoint.id,
        },
        nextClaim: {
          ...claim,
          id: "claim-2",
          taskId: "task-2",
          baseTaskRevision: 4,
          contextPackId: "pack-2",
        },
        checkpoint: savedCheckpoint,
        contextPack: {
          ...contextPack,
          id: "pack-2",
          taskId: "task-2",
          hierarchyVocabulary: neutralHierarchyVocabulary,
          task: { ...contextPack.task, record: nextTask },
          sourceRevisions: [{ recordId: "task-2", revision: 4 }],
        },
      },
    },
    {
      command: "delegate",
      method: "createDelegation" as const,
      input: coordinationInputs.delegate,
      output: { delegation },
    },
    {
      command: "accept-delegation",
      method: "acceptDelegation" as const,
      input: coordinationInputs.acceptDelegation,
      output: {
        delegation: {
          ...delegation,
          childProfileId: principal.id,
          state: "accepted",
          acceptedAt: timestamp,
        },
      },
    },
    {
      command: "revoke-delegation",
      method: "revokeDelegation" as const,
      input: coordinationInputs.revokeDelegation,
      output: { delegation: { ...delegation, state: "revoked", endedAt: timestamp } },
    },
    {
      command: "submit",
      method: "submitTaskResult" as const,
      input: coordinationInputs.submit,
      output: {
        claim: {
          ...claim, state: "submitted", endedAt: timestamp,
          latestCheckpointId: "checkpoint-1",
        },
        submission,
        proposal,
      },
    },
  ])("maps coordination $command from one strict input document", async ({
    command,
    method,
    input,
    output,
  }) => {
    const service = createService();
    const inputPath = writeCoordinationInput(input);
    const result = await run(
      ["coordination", command, "--input", inputPath],
      service,
      { profileCredentials },
    );

    expect(service.profiles.authenticate).toHaveBeenCalledWith(profileCredentials);
    expect(service.profiles.revalidatePrincipal).toHaveBeenCalledWith(principal);
    if (["renewClaim", "checkpointClaim", "transitionClaim", "submitTaskResult"].includes(method)) {
      expect(service.coordination[method]).toHaveBeenCalledWith(
        input,
        principal,
        { expectedProjectId: claim.projectId },
      );
    } else {
      expect(service.coordination[method]).toHaveBeenCalledWith(input, principal);
    }
    expect(
      vi.mocked(service.profiles.authenticate).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(service.profiles.revalidatePrincipal).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(service.profiles.revalidatePrincipal).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(service.coordination[method]).mock.invocationCallOrder[0]!,
    );
    expect(result.stdout).toBe(`${JSON.stringify(output, null, 2)}\n`);
    expect(result.stderr).toBe("");
  });

  it("round-trips an exact 64 KiB checkpoint document through the CLI boundary", async () => {
    const emptyMaximumCheckpoint = { ...checkpointDocument, summary: "" };
    const maximumCheckpoint = {
      ...emptyMaximumCheckpoint,
      summary: "x".repeat(
        65_536 - Buffer.byteLength(JSON.stringify(emptyMaximumCheckpoint), "utf8"),
      ),
    };
    const input = { ...coordinationInputs.checkpoint, checkpoint: maximumCheckpoint };
    const saved = { ...savedCheckpoint, ...maximumCheckpoint };
    const service = createService();
    vi.mocked(service.coordination.checkpointClaim).mockReturnValue({
      claim: { ...claim, latestCheckpointId: saved.id },
      checkpoint: saved,
    });

    const result = await run(
      ["coordination", "checkpoint", "--input", writeCoordinationInput(input)],
      service,
      { profileCredentials },
    );

    expect(Buffer.byteLength(JSON.stringify(maximumCheckpoint), "utf8")).toBe(65_536);
    expect(JSON.parse(result.stdout).checkpoint.summary).toHaveLength(maximumCheckpoint.summary.length);

    vi.mocked(service.coordination.switchTask).mockReturnValue({
      previousClaim: {
        ...claim, state: "paused", endedAt: timestamp, latestCheckpointId: saved.id,
      },
      nextClaim: {
        ...claim, id: "claim-2", taskId: "task-2", baseTaskRevision: 4,
        contextPackId: "pack-2",
      },
      checkpoint: saved,
      contextPack: {
        ...contextPack, id: "pack-2", taskId: "task-2",
        hierarchyVocabulary: neutralHierarchyVocabulary,
        task: { ...contextPack.task, record: nextTask },
        sourceRevisions: [{ recordId: "task-2", revision: 4 }],
      },
    });
    const switched = await run(
      ["coordination", "switch", "--input", writeCoordinationInput({
        ...coordinationInputs.switch,
        checkpoint: maximumCheckpoint,
      })],
      service,
      { profileCredentials },
    );
    expect(JSON.parse(switched.stdout).checkpoint.summary)
      .toHaveLength(maximumCheckpoint.summary.length);
  });

  it("accepts a valid equivalent delegation deadline spelling and returns its canonical instant", async () => {
    const service = createService();
    const input = {
      ...coordinationInputs.delegate,
      deadline: "2026-08-15T10:00Z",
      idempotencyKey: "delegate-equivalent-deadline",
    };

    const result = await run(
      ["coordination", "delegate", "--input", writeCoordinationInput(input)],
      service,
      { profileCredentials },
    );

    expect(JSON.parse(result.stdout).delegation.deadline)
      .toBe("2026-08-15T10:00:00.000Z");
  });

  it.each([
    ["release", "transition", {
      ...coordinationInputs.transition,
      action: "release",
      idempotencyKey: "release-1",
    }, "Release task claim?", "transitionClaim"],
    ["switch", "switch", coordinationInputs.switch, "Switch task?", "switchTask"],
    [
      "delegation revocation",
      "revoke-delegation",
      coordinationInputs.revokeDelegation,
      "Revoke task delegation?",
      "revokeDelegation",
    ],
    ["final submission", "submit", coordinationInputs.submit, "Submit final task result?", "submitTaskResult"],
  ] as const)("preserves confirmation for %s", async (
    _label,
    command,
    input,
    prompt,
    method,
  ) => {
    const service = createService();
    const result = await run(
      ["coordination", command, "--input", writeCoordinationInput(input)],
      service,
      { profileCredentials, isTTY: true, confirm: false },
    );

    expect(result.confirmationService.confirm).toHaveBeenCalledWith(prompt);
    expect(service.coordination[method]).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({ cancelled: true });
    expect(result.stderr).toBe("");
  });

  it("does not confirm pause or non-TTY coordination mutations", async () => {
    const ttyPause = await run(
      [
        "coordination",
        "transition",
        "--input",
        writeCoordinationInput(coordinationInputs.transition),
      ],
      createService(),
      { profileCredentials, isTTY: true },
    );
    const nonTtySwitch = await run(
      ["coordination", "switch", "--input", writeCoordinationInput(coordinationInputs.switch)],
      createService(),
      { profileCredentials, isTTY: false },
    );

    expect(ttyPause.confirmationService.confirm).not.toHaveBeenCalled();
    expect(nonTtySwitch.confirmationService.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["missing credentials", null],
    ["partial credentials", { profileId: "profile-1" }],
  ] as const)("rejects %s before a coordination service call", async (_label, credentials) => {
    const service = createService();
    vi.mocked(service.profiles.authenticate).mockReturnValue(null);
    const harness = createProgramHarness(service, { profileCredentials: credentials });

    await expect(harness.program.parseAsync([
      "coordination", "ready", "--project", "project-1",
      "--expected-project-revision", "3",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe("Profile credentials are required.\n");
    expect(harness.stdout.text()).toBe("");
    expect(service.coordination.listReadyTasks).not.toHaveBeenCalled();
  });

  it.each([
    ["relative input path", "relative/private.json"],
    ["malformed private JSON", undefined],
    ["oversized input", "oversized"],
  ])("rejects %s with exit 2 without disclosing the input", async (_label, candidate) => {
    const privateText = "PRIVATE_RAW_JSON coordination-token-must-not-leak";
    const inputPath = candidate === undefined
      ? writeCoordinationInput({ privateText })
      : candidate === "oversized"
        ? writeCoordinationInput({ ...coordinationInputs.claim, padding: "x".repeat(300_000) })
        : candidate;
    if (candidate === undefined) {
      writeFileSync(inputPath, `{ ${privateText}`, "utf8");
    }
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync(
      ["coordination", "claim", "--input", inputPath],
      { from: "user" },
    )).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.stderr.text()).not.toContain(inputPath);
    expect(harness.stderr.text()).not.toContain(privateText);
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
  });

  it("maps a coordination rejection to exit 1 with only its stable public message", async () => {
    const privatePath = resolve("private", "coordination-input.json");
    const error = new CoordinationError("claim_conflict");
    Object.assign(error, {
      token: profileCredentials.token,
      inputPath: privatePath,
      cause: new Error("PRIVATE_RAW_JSON"),
    });
    const service = createService();
    vi.mocked(service.coordination.claimTask).mockImplementation(() => {
      throw error;
    });
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", writeCoordinationInput(coordinationInputs.claim),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe(
      "Task claim conflicts with current coordination state.\n",
    );
    expect(harness.stderr.text()).not.toMatch(
      /coordination-token-must-not-leak|PRIVATE_RAW_JSON|coordination-input\.json|stack|cause/i,
    );
    expect(harness.stdout.text()).toBe("");
  });

  it("fails closed when a service result contains a non-public field", async () => {
    const service = createService();
    vi.mocked(service.coordination.renewClaim).mockReturnValue({
      claim,
      token: profileCredentials.token,
    } as never);
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", "renew", "--input", writeCoordinationInput(coordinationInputs.renew),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stdout.text()).toBe("");
    expect(harness.stderr.text()).toBe("Command failed.\n");
    expect(harness.stderr.text()).not.toContain(profileCredentials.token);
  });

  it("fails closed when every schema-valid claim-scoped result has a same-project foreign task", async () => {
    const foreignTaskId = "task-private-foreign";
    const foreignClaim = { ...claim, taskId: foreignTaskId };
    const cases = [
      {
        command: "renew",
        input: coordinationInputs.renew,
        configure(service: IntentArcService) {
          vi.mocked(service.coordination.renewClaim).mockReturnValue({ claim: foreignClaim });
        },
      },
      {
        command: "checkpoint",
        input: coordinationInputs.checkpoint,
        configure(service: IntentArcService) {
          vi.mocked(service.coordination.checkpointClaim).mockReturnValue({
            claim: { ...foreignClaim, latestCheckpointId: savedCheckpoint.id },
            checkpoint: savedCheckpoint,
          });
        },
      },
      {
        command: "transition",
        input: coordinationInputs.transition,
        configure(service: IntentArcService) {
          vi.mocked(service.coordination.transitionClaim).mockReturnValue({
            claim: { ...foreignClaim, state: "paused", endedAt: timestamp },
          });
        },
      },
      {
        command: "submit",
        input: coordinationInputs.submit,
        configure(service: IntentArcService) {
          vi.mocked(service.coordination.submitTaskResult).mockReturnValue({
            claim: {
              ...foreignClaim,
              state: "submitted",
              endedAt: timestamp,
              latestCheckpointId: savedCheckpoint.id,
            },
            submission: { ...submission, taskId: foreignTaskId },
            proposal: { ...proposal, sourceTaskId: foreignTaskId },
          });
        },
      },
    ];
    for (const testCase of cases) {
      const service = createService();
      testCase.configure(service);
      const harness = createProgramHarness(service, { profileCredentials });
      await expect(harness.program.parseAsync([
        "coordination", testCase.command, "--input", writeCoordinationInput(testCase.input),
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(harness.stdout.text()).toBe("");
      expect(harness.stderr.text()).toBe("Command failed.\n");
      expect(harness.stderr.text()).not.toContain(foreignTaskId);
    }
  });

  it("rejects wrong output revisions for ready, checkpoint, and submission", async () => {
    const cases = [
      {
        command: ["coordination", "ready", "--project", "project-1",
          "--expected-project-revision", "3"],
        mutate(service: IntentArcService) {
          vi.mocked(service.coordination.listReadyTasks).mockReturnValue({
            tasks: [readiness], nextCursor: null, projectRevision: 4,
          });
        },
      },
      {
        command: ["coordination", "checkpoint", "--input",
          writeCoordinationInput(coordinationInputs.checkpoint)],
        mutate(service: IntentArcService) {
          vi.mocked(service.coordination.checkpointClaim).mockReturnValue({
            claim: { ...claim, latestCheckpointId: savedCheckpoint.id },
            checkpoint: { ...savedCheckpoint, projectRevision: 4, taskRevision: 8 },
          });
        },
      },
      {
        command: ["coordination", "submit", "--input",
          writeCoordinationInput(coordinationInputs.submit)],
        mutate(service: IntentArcService) {
          vi.mocked(service.coordination.submitTaskResult).mockReturnValue({
            claim: { ...claim, state: "submitted", latestCheckpointId: savedCheckpoint.id },
            submission: { ...submission, baseProjectRevision: 4, baseTaskRevision: 8 },
            proposal: { ...proposal, baseProjectRevision: 4 },
          });
        },
      },
    ];
    for (const testCase of cases) {
      const service = createService();
      testCase.mutate(service);
      const harness = createProgramHarness(service, { profileCredentials });
      await expect(harness.program.parseAsync(testCase.command, { from: "user" }))
        .rejects.toMatchObject({ exitCode: 1 });
      expect(harness.stdout.text()).toBe("");
      expect(harness.stderr.text()).toBe("Command failed.\n");
    }
  });

  it("does not accept profile credentials as command-line flags", async () => {
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", "ready", "--project", "project-1",
      "--expected-project-revision", "3", "--profile-token", profileCredentials.token!,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).not.toContain(profileCredentials.token);
    expect(service.profiles.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ["inline profile token", "--profile-token=INLINE_TOKEN_MUST_NOT_LEAK"],
    ["inline profile ID", "--profile-id=INLINE_PROFILE_MUST_NOT_LEAK"],
  ])("sanitizes coordination Commander diagnostics for an %s", async (
    _label,
    privateArgument,
  ) => {
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", "ready", "--project", "project-1",
      "--expected-project-revision", "3", privateArgument,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.stderr.text()).not.toContain(privateArgument);
    expect(service.profiles.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "before the coordination command",
      [
        "--profile-token=BEFORE_COORDINATION_MUST_NOT_LEAK",
        "coordination", "ready", "--project", "project-1",
        "--expected-project-revision", "3",
      ],
      "BEFORE_COORDINATION_MUST_NOT_LEAK",
    ],
    [
      "at the coordination command",
      [
        "coordination", "--profile-id=AT_COORDINATION_MUST_NOT_LEAK",
        "ready", "--project", "project-1",
        "--expected-project-revision", "3",
      ],
      "AT_COORDINATION_MUST_NOT_LEAK",
    ],
    [
      "after the coordination subcommand",
      [
        "coordination", "ready", "--project", "project-1",
        "--expected-project-revision", "3",
        "--profile-token=AFTER_COORDINATION_MUST_NOT_LEAK",
      ],
      "AFTER_COORDINATION_MUST_NOT_LEAK",
    ],
  ])("sanitizes private argv %s", async (_label, arguments_, privateValue) => {
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync(arguments_, { from: "user" }))
      .rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.stderr.text()).not.toContain(privateValue);
    expect(service.profiles.authenticate).not.toHaveBeenCalled();
  });

  it("preserves non-coordination Commander diagnostics", async () => {
    const privateArgument = "--profile-token=NON_COORDINATION_VALUE";
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "project", "list", privateArgument,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe(
      `error: unknown option '${privateArgument}'\n`,
    );
  });

  it("does not select coordination sanitization from an unrelated argument value", async () => {
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "project", "create", "--name", "coordination", "--unexpected",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("error: unknown option '--unexpected'\n");
  });

  it("sanitizes inline raw JSON in coordination Commander diagnostics", async () => {
    const rawJson = '{"token":"INLINE_RAW_JSON_MUST_NOT_LEAK"}';
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input",
      writeCoordinationInput(coordinationInputs.claim), rawJson,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.stderr.text()).not.toContain(rawJson);
    expect(service.profiles.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "00",
    "03",
    "+3",
    "-0",
    "0x3",
    "3e0",
    "3.0",
    " 3 ",
  ])("rejects noncanonical ready/state revision spelling %j", async (revision) => {
    for (const command of [
      ["coordination", "ready", "--project", "project-1"],
      ["coordination", "state", "--project", "project-1", "--task", "task-1"],
    ]) {
      const service = createService();
      const harness = createProgramHarness(service, { profileCredentials });

      await expect(harness.program.parseAsync([
        ...command,
        `--expected-project-revision=${revision}`,
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

      expect(harness.stderr.text()).toBe("Invalid command input.\n");
      expect(service.profiles.authenticate).not.toHaveBeenCalled();
    }
  });

  it.each(["00", "01", "+1", "1e1", "1.0", " 1 "])(
    "rejects noncanonical ready limit spelling %j before authentication",
    async (limit) => {
      const service = createService();
      const harness = createProgramHarness(service, { profileCredentials });

      await expect(harness.program.parseAsync([
        "coordination", "ready", "--project", "project-1",
        "--expected-project-revision", "3", `--limit=${limit}`,
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

      expect(harness.stderr.text()).toBe("Invalid command input.\n");
      expect(service.profiles.authenticate).not.toHaveBeenCalled();
    },
  );

  it("reads coordination input through one bounded stable file handle", async () => {
    const serialized = Buffer.from(JSON.stringify(coordinationInputs.claim), "utf8");
    const stableStat = coordinationFileStat({ size: serialized.byteLength });
    let offset = 0;
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => stableStat),
      open: vi.fn(() => 41),
      fstat: vi.fn(() => stableStat),
      read: vi.fn((fileDescriptor, buffer, bufferOffset, length) => {
        expect(fileDescriptor).toBe(41);
        const count = Math.min(length, serialized.byteLength - offset);
        if (count <= 0) return 0;
        serialized.copy(buffer, bufferOffset, offset, offset + count);
        offset += count;
        return count;
      }),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "claim.json"),
    ], { from: "user" });

    expect(fileSystem.open).toHaveBeenCalledTimes(1);
    expect(fileSystem.read).toHaveBeenCalled();
    expect(fileSystem.close).toHaveBeenCalledWith(41);
    expect(service.coordination.claimTask).toHaveBeenCalledOnce();
  });

  it("caps an underreported growing input at max plus one byte", async () => {
    const underreported = coordinationFileStat({ size: 1 });
    const read = vi.fn((
      _fileDescriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
    ) => {
      buffer.fill(0x20, offset, offset + length);
      return length;
    });
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => underreported),
      open: vi.fn(() => 42),
      fstat: vi.fn(() => underreported),
      read,
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "growing.json"),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(read.mock.calls.reduce((total, call) => total + call[3], 0)).toBe(16 * 1_024 + 1);
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
    expect(fileSystem.close).toHaveBeenCalledWith(42);
  });

  it.each([
    ["symbolic link", coordinationFileStat({
      isFile: () => false,
      isSymbolicLink: () => true,
    })],
    ["special file", coordinationFileStat({ isFile: () => false })],
  ])("rejects a coordination input %s before opening it", async (_label, pathStat) => {
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => pathStat),
      open: vi.fn(() => 43),
      fstat: vi.fn(() => pathStat),
      read: vi.fn(() => 0),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "aliased.json"),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(fileSystem.lstat).toHaveBeenCalledOnce();
    expect(fileSystem.open).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
  });

  it("opens a regular input nonblocking and rejects a FIFO substitution before reading", async () => {
    const inputPath = resolve("private", "fifo-swap.json");
    const regular = coordinationFileStat();
    const fifo = coordinationFileStat({ isFile: () => false });
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => regular),
      open: vi.fn(() => 46),
      fstat: vi.fn(() => fifo),
      read: vi.fn(() => 0),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", inputPath,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(fileSystem.open).toHaveBeenCalledWith(inputPath, {
      nonBlocking: true,
      noFollow: true,
    });
    expect(fileSystem.read).not.toHaveBeenCalled();
    expect(fileSystem.close).toHaveBeenCalledWith(46);
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
  });

  it("uses no-follow open and rejects a symlink substituted after lstat without reading", async () => {
    const inputPath = resolve("private", "symlink-swap.json");
    const regular = coordinationFileStat();
    const open = vi.fn((_path: string, options?: unknown) => {
      expect(options).toEqual({ nonBlocking: true, noFollow: true });
      throw new Error("simulated no-follow rejection");
    });
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => regular),
      open,
      fstat: vi.fn(() => regular),
      read: vi.fn(() => 0),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", inputPath,
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(open).toHaveBeenCalledWith(inputPath, {
      nonBlocking: true,
      noFollow: true,
    });
    expect(fileSystem.fstat).not.toHaveBeenCalled();
    expect(fileSystem.read).not.toHaveBeenCalled();
    expect(fileSystem.close).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 from a stable coordination input handle", async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const stable = coordinationFileStat({ size: invalidUtf8.byteLength });
    let offset = 0;
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => stable),
      open: vi.fn(() => 47),
      fstat: vi.fn(() => stable),
      read: vi.fn((_fd, buffer, bufferOffset, length) => {
        const count = Math.min(length, invalidUtf8.byteLength - offset);
        if (count <= 0) return 0;
        invalidUtf8.copy(buffer, bufferOffset, offset, offset + count);
        offset += count;
        return count;
      }),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "invalid-utf8.json"),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(fileSystem.close).toHaveBeenCalledWith(47);
    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
  });

  it("rejects growth detected by post-read handle metadata", async () => {
    const serialized = Buffer.from(JSON.stringify(coordinationInputs.claim), "utf8");
    const before = coordinationFileStat({ size: serialized.byteLength });
    const after = coordinationFileStat({ size: serialized.byteLength + 1 });
    let offset = 0;
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn(() => before),
      open: vi.fn(() => 44),
      fstat: vi.fn()
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(after),
      read: vi.fn((_fd, buffer, bufferOffset, length) => {
        const count = Math.min(length, serialized.byteLength - offset);
        if (count <= 0) return 0;
        serialized.copy(buffer, bufferOffset, offset, offset + count);
        offset += count;
        return count;
      }),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "growth.json"),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
    expect(fileSystem.close).toHaveBeenCalledWith(44);
  });

  it("rejects a pathname swap detected after reading the open handle", async () => {
    const serialized = Buffer.from(JSON.stringify(coordinationInputs.claim), "utf8");
    const opened = coordinationFileStat({ size: serialized.byteLength, ino: 2 });
    const swapped = coordinationFileStat({ size: serialized.byteLength, ino: 99 });
    let offset = 0;
    const fileSystem: CoordinationInputFileSystemDouble = {
      lstat: vi.fn()
        .mockReturnValueOnce(opened)
        .mockReturnValueOnce(swapped),
      open: vi.fn(() => 45),
      fstat: vi.fn(() => opened),
      read: vi.fn((_fd, buffer, bufferOffset, length) => {
        const count = Math.min(length, serialized.byteLength - offset);
        if (count <= 0) return 0;
        serialized.copy(buffer, bufferOffset, offset, offset + count);
        offset += count;
        return count;
      }),
      close: vi.fn(),
    };
    const service = createService();
    const harness = createProgramHarness(service, {
      profileCredentials,
      coordinationInputFileSystem: fileSystem,
    });

    await expect(harness.program.parseAsync([
      "coordination", "claim", "--input", resolve("private", "swapped.json"),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(service.coordination.claimTask).not.toHaveBeenCalled();
    expect(fileSystem.close).toHaveBeenCalledWith(45);
  });

  it.each([
    ["claim", "claimTask", coordinationInputs.claim],
    ["renew", "renewClaim", coordinationInputs.renew],
    ["checkpoint", "checkpointClaim", coordinationInputs.checkpoint],
    ["transition", "transitionClaim", coordinationInputs.transition],
    ["switch", "switchTask", coordinationInputs.switch],
    ["delegate", "createDelegation", coordinationInputs.delegate],
    ["accept-delegation", "acceptDelegation", coordinationInputs.acceptDelegation],
    ["revoke-delegation", "revokeDelegation", coordinationInputs.revokeDelegation],
    ["submit", "submitTaskResult", coordinationInputs.submit],
  ] as const)("rejects malformed %s documents before public invocation", async (
    command,
    method,
    input,
  ) => {
    const service = createService();
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", command, "--input",
      writeCoordinationInput({ ...input, privateUnknown: "MUST_NOT_LEAK" }),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.stderr.text()).not.toContain("MUST_NOT_LEAK");
    expect(service.coordination[method]).not.toHaveBeenCalled();
  });

  it.each([
    ["claim", "claimTask", coordinationInputs.claim],
    ["renew", "renewClaim", coordinationInputs.renew],
    ["checkpoint", "checkpointClaim", coordinationInputs.checkpoint],
    ["transition", "transitionClaim", coordinationInputs.transition],
    ["switch", "switchTask", coordinationInputs.switch],
    ["delegate", "createDelegation", coordinationInputs.delegate],
    ["accept-delegation", "acceptDelegation", coordinationInputs.acceptDelegation],
    ["revoke-delegation", "revokeDelegation", coordinationInputs.revokeDelegation],
    ["submit", "submitTaskResult", coordinationInputs.submit],
  ] as const)("fails closed on non-public %s output", async (command, method, input) => {
    const service = createService();
    vi.mocked(service.coordination[method]).mockReturnValue({
      privateResult: "PRIVATE_RESULT_MUST_NOT_LEAK",
    } as never);
    const harness = createProgramHarness(service, { profileCredentials });

    await expect(harness.program.parseAsync([
      "coordination", command, "--input", writeCoordinationInput(input),
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stdout.text()).toBe("");
    expect(harness.stderr.text()).toBe("Command failed.\n");
    expect(harness.stderr.text()).not.toContain("PRIVATE_RESULT_MUST_NOT_LEAK");
  });

  it("accepts a non-null production-shaped ready cursor without a CLI-local projection", async () => {
    const lastTaskId = `task-${"x".repeat(48)}`;
    const cursor = Buffer.from(JSON.stringify({
      projectId: "project-1",
      projectRevision: 3,
      filterHash: "a".repeat(64),
      lastTaskId,
    }), "utf8").toString("base64url");
    expect(cursor.length).toBeGreaterThan(200);
    const service = createService();
    vi.mocked(service.coordination.listReadyTasks).mockReturnValue({
      tasks: [{ ...readiness, task: { ...task, id: lastTaskId } }],
      nextCursor: cursor,
      projectRevision: 3,
    });

    const result = await run([
      "coordination", "ready", "--project", "project-1",
      "--expected-project-revision", "3",
      "--limit", "1",
    ], service, { profileCredentials });

    expect(JSON.parse(result.stdout)).toMatchObject({ nextCursor: cursor });
    expect(result.stderr).toBe("");
  });

  it("fails closed on duplicate, short-page, and repeated ready pagination output", async () => {
    const cursor = Buffer.from(JSON.stringify({ page: "private-ready-page" }), "utf8")
      .toString("base64url");
    const cases = [
      {
        arguments: ["--limit", "2"],
        output: { tasks: [readiness, readiness], nextCursor: null, projectRevision: 3 },
      },
      {
        arguments: ["--limit", "2"],
        output: { tasks: [readiness], nextCursor: cursor, projectRevision: 3 },
      },
      {
        arguments: ["--limit", "1", "--cursor", cursor],
        output: { tasks: [readiness], nextCursor: cursor, projectRevision: 3 },
      },
    ];
    for (const testCase of cases) {
      const service = createService();
      vi.mocked(service.coordination.listReadyTasks).mockReturnValue(testCase.output);
      const harness = createProgramHarness(service, { profileCredentials });
      await expect(harness.program.parseAsync([
        "coordination", "ready", "--project", "project-1",
        "--expected-project-revision", "3", ...testCase.arguments,
      ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(harness.stdout.text()).toBe("");
      expect(harness.stderr.text()).toBe("Command failed.\n");
      expect(harness.stderr.text()).not.toContain("private-ready-page");
    }
  });
});

describe("IntentArc CLI integration", () => {
  let application: IntentArcApplication | undefined;
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    application?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("persists a project across separate CLI invocations", async () => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });

    const created = await run(
      ["project", "create", "--name", "IntentArc"],
      application.service,
    );
    const listed = await run(["project", "list"], application.service);

    expect(JSON.parse(created.stdout)).toMatchObject({ name: "IntentArc" });
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ name: "IntentArc" }),
    ]);
  });
});
