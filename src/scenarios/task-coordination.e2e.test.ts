import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication, type IntentArcApplication } from "../app/create-application.js";
import { createChangeService } from "../core/change-service.js";
import { createContextService } from "../core/context-service.js";
import { createCoordinationService } from "../core/coordination-service.js";
import { createProfileService } from "../core/profile-service.js";
import { createContextPackStore } from "../storage/context-pack-store.js";
import { createCoordinationStore } from "../storage/coordination-store.js";
import { openDatabase } from "../storage/database.js";
import { createGovernanceStore } from "../storage/governance-store.js";
import { createProfileStore } from "../storage/profile-store.js";
import { createProjectStore } from "../storage/project-store.js";
import {
  captureDatabaseRows,
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

type RaceSuccess = {
  outcome: "success";
  profileId: string;
  claimId: string;
  contextPackId: string;
};

type RaceConflict = {
  outcome: "error";
  profileId: string;
  code: "claim_conflict";
};

type RaceResult = RaceSuccess | RaceConflict;

type WorkerFailure = {
  outcome: "failure";
  code: "coordination_unavailable";
};

type WorkerResult = RaceResult | WorkerFailure;

type DatabaseTableRows = {
  name: string;
  rows: Array<Record<string, unknown>>;
};

const RACE_TIMEOUT_MS = 15_000;
const scenarioNow = "2026-08-15T10:00:00.000Z";
const fixedWorkerFailure: WorkerFailure = {
  outcome: "failure",
  code: "coordination_unavailable",
};
const raceWorkerPath = fileURLToPath(
  new URL("../test-support/coordination-race-worker.ts", import.meta.url),
);

const captureTableRows = (path: string): DatabaseTableRows[] =>
  JSON.parse(captureDatabaseRows(path).toString("utf8")) as DatabaseTableRows[];

const rowsFor = (
  snapshot: readonly DatabaseTableRows[],
  name: string,
): Array<Record<string, unknown>> => {
  const table = snapshot.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Missing database table ${name}`);
  return table.rows;
};

const parseWorkerResult = (value: unknown): WorkerResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Race worker returned a non-object result");
  }
  const result = value as Record<string, unknown>;
  if (result.outcome === "success") {
    if (Object.keys(result).sort().join(",") !== "claimId,contextPackId,outcome,profileId" ||
      ![result.profileId, result.claimId, result.contextPackId].every(
        (item) => typeof item === "string" && item.length > 0,
      )) {
      throw new Error("Race worker returned an open success result");
    }
    return result as RaceSuccess;
  }
  if (result.outcome === "error") {
    if (Object.keys(result).sort().join(",") !== "code,outcome,profileId" ||
      typeof result.profileId !== "string" || result.profileId.length === 0 ||
      result.code !== "claim_conflict") {
      throw new Error("Race worker returned an open error result");
    }
    return result as RaceConflict;
  }
  if (result.outcome === "failure") {
    if (Object.keys(result).sort().join(",") !== "code,outcome" ||
      result.code !== "coordination_unavailable") {
      throw new Error("Race worker returned an open failure result");
    }
    return result as WorkerFailure;
  }
  throw new Error("Race worker returned an unknown outcome");
};

const listen = async (server: Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Race server did not bind a TCP port");
  }
  return address.port;
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
};

const waitForClose = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });

const runClaimRace = async (input: {
  databasePath: string;
  projectId: string;
  taskId: string;
  projectRevision: number;
  taskRevision: number;
  profiles: Array<{ profileId: string; token: string }>;
}): Promise<{
  results: RaceResult[];
  children: ChildProcess[];
  stderrs: string[];
  argvs: string[][];
}> => {
  const barrierSockets: Socket[] = [];
  const resultSockets: Socket[] = [];
  const socketCloses: Promise<void>[] = [];
  const barrierServer = createServer((socket) => {
    barrierSockets.push(socket);
    socketCloses.push(new Promise((resolve) => socket.once("close", resolve)));
    if (barrierSockets.length === input.profiles.length) {
      for (const waiting of barrierSockets) waiting.end("start\n");
    }
  });
  const results: RaceResult[] = [];
  let resolveResults: (() => void) | undefined;
  let rejectResults: ((reason: unknown) => void) | undefined;
  const allResults = new Promise<void>((resolve, reject) => {
    resolveResults = resolve;
    rejectResults = reject;
  });
  const resultServer = createServer((socket) => {
    resultSockets.push(socket);
    socketCloses.push(new Promise((resolve) => socket.once("close", resolve)));
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4_096) socket.destroy();
    });
    socket.once("end", () => {
      try {
        const parsed = parseWorkerResult(JSON.parse(body));
        if (parsed.outcome === "failure") {
          throw new Error("Race worker reported a closed startup failure");
        }
        results.push(parsed);
        if (results.length === input.profiles.length) resolveResults?.();
      } catch (error) {
        rejectResults?.(error);
      }
    });
  });
  const barrierPort = await listen(barrierServer);
  const resultPort = await listen(resultServer);
  const stderrs = input.profiles.map(() => "");
  const argvs: string[][] = [];
  const children = input.profiles.map(({ profileId, token }, index) => {
    const argv = [
      "--import",
      "tsx",
      raceWorkerPath,
      input.databasePath,
      profileId,
      input.projectId,
      input.taskId,
      String(input.projectRevision),
      String(input.taskRevision),
      String(barrierPort),
      String(resultPort),
    ];
    argvs.push(argv);
    const child = childProcess.spawn(process.execPath, argv, {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrs[index] += chunk;
      if (stderrs[index]!.length > 4_096 && child.exitCode === null) child.kill();
    });
    child.stdin!.once("error", () => undefined);
    child.stdin!.end(`${JSON.stringify({ profileToken: token })}\n`);
    return child;
  });
  const closes = children.map(waitForClose);
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      Promise.all([allResults, ...closes]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Claim race exceeded 15 seconds")), RACE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(closes);
    for (const socket of [...barrierSockets, ...resultSockets]) socket.destroy();
    await Promise.all([closeServer(barrierServer), closeServer(resultServer)]);
    await Promise.allSettled(socketCloses);
  }

  return { results, children, stderrs, argvs };
};

const runWorkerAttempt = async (input: {
  databasePath: string;
  profileId: string;
  projectId: string;
  taskId: string;
  projectRevision: number;
  taskRevision: number;
  credentialFrame: string;
}): Promise<{
  argv: string[];
  result: WorkerResult;
  stderr: string;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  durationMs: number;
}> => {
  const barrierServer = createServer((socket) => socket.end("start\n"));
  const resultFrames: Array<Buffer | null> = [];
  const resultSockets = new Set<Socket>();
  const resultServer = createServer((socket) => {
    resultSockets.add(socket);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let invalid = false;
    let captured = false;
    const capture = () => {
      if (captured) return;
      captured = true;
      resultFrames.push(invalid ? null : Buffer.concat(chunks, bytes));
    };
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4_096) {
        invalid = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      capture();
    });
    socket.once("close", (hadError) => {
      if (hadError) invalid = true;
      capture();
      resultSockets.delete(socket);
    });
  });
  const barrierPort = await listen(barrierServer);
  const resultPort = await listen(resultServer);
  const argv = [
    "--import",
    "tsx",
    raceWorkerPath,
    input.databasePath,
    input.profileId,
    input.projectId,
    input.taskId,
    String(input.projectRevision),
    String(input.taskRevision),
    String(barrierPort),
    String(resultPort),
  ];
  const startedAt = performance.now();
  const child = childProcess.spawn(process.execPath, argv, {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 4_096 && child.exitCode === null) child.kill();
  });
  child.stdin!.once("error", () => undefined);
  child.stdin!.end(input.credentialFrame);
  const closed = waitForClose(child);
  let resultServerClose: Promise<void> | undefined;
  const closeResultServer = (): Promise<void> => {
    resultServerClose ??= closeServer(resultServer);
    return resultServerClose;
  };
  const resultPromise = closed.then(async (): Promise<WorkerResult> => {
    await closeResultServer();
    if (resultFrames.length === 0) {
      throw new Error("Race worker returned no result");
    }
    if (resultFrames.length !== 1) {
      throw new Error("Race worker returned multiple results");
    }
    const frame = resultFrames[0];
    if (frame === null) {
      throw new Error("Race worker returned a malformed result");
    }
    try {
      return parseWorkerResult(JSON.parse(frame.toString("utf8")));
    } catch {
      throw new Error("Race worker returned a malformed result");
    }
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const [, result] = await Promise.race([
      Promise.all([closed, resultPromise]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Worker did not fail promptly")), 3_000);
      }),
    ]);
    return {
      argv,
      result,
      stderr,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const socket of resultSockets) socket.destroy();
    await Promise.allSettled([closed]);
    await Promise.all([closeServer(barrierServer), closeResultServer()]);
  }
};

const checkpoint = (summary: string) => ({
  summary,
  completedWork: ["Completed bounded work"],
  remainingWork: ["Reconcile the result"],
  blockers: [],
  verificationEvidence: { tests: ["scenario verification"], artifacts: [] },
  repositoryEvidence: null,
});

const createFailingSwitchService = (input: {
  databasePath: string;
  profileId: string;
  token: string;
}) => {
  const database = openDatabase(input.databasePath, { now: () => scenarioNow });
  const profileStore = createProfileStore(database);
  const profileService = createProfileService({
    profileStore,
    now: () => scenarioNow,
    newId: (prefix) => `${prefix}-unused`,
  });
  const projectStore = createProjectStore(database, {
    now: () => scenarioNow,
    newId: (prefix) => `${prefix}-unused`,
  });
  let contextOrdinal = 0;
  const contextService = createContextService({
    projectStore,
    contextPackStore: createContextPackStore(database),
    now: () => scenarioNow,
    newId: () => `context-rollback-${++contextOrdinal}`,
    estimateTokens: (text) => text.length,
  });
  let governanceOrdinal = 0;
  const governanceStore = createGovernanceStore(database, {
    newId: (prefix) => `${prefix}-rollback-${++governanceOrdinal}`,
  });
  const changeService = createChangeService({
    governanceStore,
    profileStore,
    now: () => scenarioNow,
  });
  const coordinationStore = createCoordinationStore(database, {
    now: () => scenarioNow,
    testOnlyFailpoint(step) {
      if (step === "context_creation") throw new Error("injected context failure");
    },
  });
  let coordinationOrdinal = 0;
  const service = createCoordinationService({
    coordinationStore,
    changeService,
    contextService,
    profileService,
    profileStore,
    now: () => scenarioNow,
    newId: (prefix) => `${prefix}-rollback-${++coordinationOrdinal}`,
  });
  const principal = profileService.authenticate({
    profileId: input.profileId,
    token: input.token,
  });
  if (!principal) {
    database.close();
    throw new Error("Rollback profile authentication failed");
  }
  return { database, principal, service };
};

describe("IntentArc task coordination acceptance", () => {
  const applications: IntentArcApplication[] = [];
  const temporaryDatabases: TemporaryDatabase[] = [];

  afterEach(() => {
    for (const application of applications.splice(0)) application.close();
    for (const temporary of temporaryDatabases.splice(0)) {
      removeTemporaryDatabase(temporary);
    }
  });

  it("keeps the race credential in one bounded stdin frame and out of argv, stderr, and results", async () => {
    const processLaunch = vi.mocked(childProcess.spawn);
    const launchCount = processLaunch.mock.calls.length;
    const temporary = createTemporaryDatabase();
    temporaryDatabases.push(temporary);
    const application = createApplication({ databasePath: temporary.path });
    applications.push(application);
    const project = application.service.createProject({ name: "Private race credential" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Private credential claim",
      body: "The worker credential must not enter process listings.",
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Private worker",
      projectId: project.id,
    });
    application.close();
    applications.pop();

    const attempted = await runWorkerAttempt({
      databasePath: temporary.path,
      profileId: created.profile.id,
      projectId: project.id,
      taskId: task.id,
      projectRevision: 1,
      taskRevision: 1,
      credentialFrame: `${JSON.stringify({ profileToken: created.token })}\n`,
    });

    expect(attempted.result).toMatchObject({
      outcome: "success",
      profileId: created.profile.id,
    });
    expect(attempted.exitCode).toBe(0);
    expect(attempted.signalCode).toBeNull();
    expect(attempted.stderr).toBe("");
    expect(attempted.argv).not.toContain(created.token);
    const workerLaunches = processLaunch.mock.calls.slice(launchCount);
    expect(workerLaunches).toHaveLength(1);
    expect(workerLaunches[0]![1]).toEqual(attempted.argv);
    expect(JSON.stringify(workerLaunches)).not.toContain(created.token);
    expect(JSON.stringify(attempted.result)).not.toContain(created.token);
    expect(attempted.stderr).not.toContain(created.token);
  }, 10_000);

  it.each([
    ["unknown field", (token: string) => `${JSON.stringify({ profileToken: token, extra: true })}\n`],
    ["two frames", (token: string) => `${JSON.stringify({ profileToken: token })}\n${JSON.stringify({ profileToken: token })}\n`],
    ["oversized frame", (token: string) => `${JSON.stringify({ profileToken: token, padding: "x".repeat(4_096) })}\n`],
  ])("returns one prompt silent closed failure for an invalid %s", async (_name, frame) => {
    const temporary = createTemporaryDatabase();
    temporaryDatabases.push(temporary);
    const application = createApplication({ databasePath: temporary.path });
    applications.push(application);
    const project = application.service.createProject({ name: "Invalid credential frame" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Reject invalid IPC",
      body: "Fail closed before opening the claim transaction.",
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Invalid-frame worker",
      projectId: project.id,
    });
    application.close();
    applications.pop();

    const attempted = await runWorkerAttempt({
      databasePath: temporary.path,
      profileId: created.profile.id,
      projectId: project.id,
      taskId: task.id,
      projectRevision: 1,
      taskRevision: 1,
      credentialFrame: frame(created.token),
    });

    expect(attempted.durationMs).toBeLessThan(3_000);
    expect(attempted.result).toEqual({
      outcome: "failure",
      code: "coordination_unavailable",
    });
    expect(attempted.exitCode).toBe(1);
    expect(attempted.signalCode).toBeNull();
    expect(attempted.stderr).toBe("");
    expect(attempted.argv).not.toContain(created.token);
    expect(JSON.stringify(attempted.result)).not.toContain(created.token);
  }, 10_000);

  it.each([
    ["malformed", ["{not-json"], "Race worker returned a malformed result"],
    ["multiple", [JSON.stringify(fixedWorkerFailure), JSON.stringify(fixedWorkerFailure)],
      "Race worker returned multiple results"],
    ["missing", [], "Race worker returned no result"],
  ] as const)("rejects a %s worker result deterministically", async (_name, frames, message) => {
    const temporary = createTemporaryDatabase();
    temporaryDatabases.push(temporary);
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    vi.mocked(childProcess.spawn).mockImplementationOnce((command, argv, options) => {
      const resultPort = Number(argv.at(-1));
      const child = actualChildProcess.spawn(command, [
        "-e",
        frames.length === 0 ? "" : "setTimeout(() => {}, 250)",
      ], options);
      for (const frame of frames) {
        const socket = connect({ host: "127.0.0.1", port: resultPort });
        socket.once("error", () => undefined);
        socket.end(frame);
      }
      return child;
    });

    await expect(runWorkerAttempt({
      databasePath: temporary.path,
      profileId: "profile-result-protocol",
      projectId: "project-result-protocol",
      taskId: "task-result-protocol",
      projectRevision: 1,
      taskRevision: 1,
      credentialFrame: `${JSON.stringify({ profileToken: "secret-result-protocol" })}\n`,
    })).rejects.toThrow(message);
  }, 10_000);

  it.runIf(process.platform !== "win32")(
    "rejects a temporary database reached through a file symlink before opening it",
    async () => {
      const temporary = createTemporaryDatabase();
      temporaryDatabases.push(temporary);
      const application = createApplication({ databasePath: temporary.path });
      applications.push(application);
      const project = application.service.createProject({ name: "Symlink containment" });
      const task = application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title: "Reject a linked database",
        body: "The worker must open only the owned ordinary fixture file.",
        sourceKind: "human",
        sourceRef: null,
      });
      const created = application.service.profiles.createProfile({
        name: "Symlink worker",
        projectId: project.id,
      });
      application.close();
      applications.pop();
      const linkDirectory = mkdtempSync(join(tmpdir(), "intentarc-link-"));
      const linkPath = join(linkDirectory, "intentarc.sqlite");
      symlinkSync(temporary.path, linkPath, "file");
      const before = captureDatabaseRows(temporary.path);
      try {
        const attempted = await runWorkerAttempt({
          databasePath: linkPath,
          profileId: created.profile.id,
          projectId: project.id,
          taskId: task.id,
          projectRevision: 1,
          taskRevision: 1,
          credentialFrame: `${JSON.stringify({ profileToken: created.token })}\n`,
        });
        expect(attempted.result).toEqual(fixedWorkerFailure);
        expect(attempted.exitCode).toBe(1);
        expect(attempted.stderr).toBe("");
        expect(captureDatabaseRows(temporary.path).equals(before)).toBe(true);
      } finally {
        unlinkSync(linkPath);
        rmSync(linkDirectory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects a temporary database reached through a junction escape before opening it",
    async () => {
      const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
      const targetDirectory = mkdtempSync(join(repositoryRoot, ".intentarc-junction-target-"));
      const targetPath = join(targetDirectory, "intentarc.sqlite");
      const junctionPath = join(tmpdir(), `intentarc-junction-${randomUUID()}`);
      const application = createApplication({ databasePath: targetPath });
      const project = application.service.createProject({ name: "Junction containment" });
      const task = application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title: "Reject a junction database",
        body: "The worker must not escape the canonical temporary root.",
        sourceKind: "human",
        sourceRef: null,
      });
      const created = application.service.profiles.createProfile({
        name: "Junction worker",
        projectId: project.id,
      });
      application.close();
      symlinkSync(targetDirectory, junctionPath, "junction");
      const before = captureDatabaseRows(targetPath);
      try {
        const attempted = await runWorkerAttempt({
          databasePath: join(junctionPath, "intentarc.sqlite"),
          profileId: created.profile.id,
          projectId: project.id,
          taskId: task.id,
          projectRevision: 1,
          taskRevision: 1,
          credentialFrame: `${JSON.stringify({ profileToken: created.token })}\n`,
        });
        expect(attempted.result).toEqual(fixedWorkerFailure);
        expect(attempted.exitCode).toBe(1);
        expect(attempted.stderr).toBe("");
        expect(captureDatabaseRows(targetPath).equals(before)).toBe(true);
      } finally {
        unlinkSync(junctionPath);
        rmSync(targetDirectory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("rejects an exact temporary-layout hard link to an external same-volume database", async ({ skip }) => {
    const linkDirectory = mkdtempSync(join(tmpdir(), "intentarc-"));
    const linkPath = join(linkDirectory, "intentarc.sqlite");
    const externalPath = join(tmpdir(), `intentarc-hardlink-external-${randomUUID()}.sqlite`);
    const application = createApplication({ databasePath: linkPath });
    const project = application.service.createProject({ name: "Hard-link containment" });
    const task = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Reject a hard-linked database",
      body: "The worker must not mutate a second name for an external database inode.",
      sourceKind: "human",
      sourceRef: null,
    });
    const created = application.service.profiles.createProfile({
      name: "Hard-link worker",
      projectId: project.id,
    });
    application.close();
    try {
      try {
        linkSync(linkPath, externalPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM", "EXDEV"].includes(code ?? "")) {
          skip(`Hard-link creation unavailable (${code})`);
          return;
        }
        throw error;
      }
      expect(lstatSync(externalPath).nlink).toBe(2);
      expect(lstatSync(linkPath).nlink).toBe(2);
      const before = captureDatabaseRows(externalPath);
      const attempted = await runWorkerAttempt({
        databasePath: linkPath,
        profileId: created.profile.id,
        projectId: project.id,
        taskId: task.id,
        projectRevision: 1,
        taskRevision: 1,
        credentialFrame: `${JSON.stringify({ profileToken: created.token })}\n`,
      });
      expect(attempted.result).toEqual(fixedWorkerFailure);
      expect(attempted.exitCode).toBe(1);
      expect(attempted.stderr).toBe("");
      expect(captureDatabaseRows(externalPath).equals(before)).toBe(true);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(linkDirectory, { recursive: true, force: true });
      rmSync(externalPath, { force: true });
    }
  }, 10_000);

  it("scenario 6 atomically checkpoints a substantial task switch and rolls back a context failure byte-for-byte", () => {
    const temporary = createTemporaryDatabase();
    temporaryDatabases.push(temporary);
    const application = createApplication({
      databasePath: temporary.path,
      now: () => scenarioNow,
    });
    applications.push(application);
    const project = application.service.createProject({ name: "Task switching" });
    const taskA = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Substantial current task",
      body: "Checkpoint this work before changing focus.",
      sourceKind: "human",
      sourceRef: null,
    });
    const taskB = application.service.createRecord({
      projectId: project.id,
      kind: "task",
      status: "active",
      title: "Next ready task",
      body: "Receive a distinct bounded context pack.",
      sourceKind: "human",
      sourceRef: null,
    });
    const createdProfile = application.service.profiles.createProfile({
      name: "Switching worker",
      projectId: project.id,
    });
    const principal = application.service.profiles.authenticate({
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    })!;
    const current = application.service.coordination.claimTask({
      projectId: project.id,
      taskId: taskA.id,
      expectedProjectRevision: 2,
      expectedTaskRevision: 1,
      contextBudgetTokens: 200,
      acceptedDelegationId: null,
      idempotencyKey: "scenario-6-claim-a",
    }, principal);
    const switched = application.service.coordination.switchTask({
      currentClaimId: current.claim.id,
      projectId: project.id,
      currentTaskId: taskA.id,
      expectedCurrentProjectRevision: 2,
      expectedCurrentTaskRevision: 1,
      checkpoint: checkpoint("Checkpoint before switching to task B"),
      terminalAction: "pause",
      nextTaskId: taskB.id,
      expectedNextProjectRevision: 2,
      expectedNextTaskRevision: 1,
      nextContextBudgetTokens: 200,
      acceptedDelegationId: null,
      idempotencyKey: "scenario-6-switch-b",
    }, principal);

    expect(switched.previousClaim).toMatchObject({
      id: current.claim.id,
      state: "paused",
      latestCheckpointId: switched.checkpoint.id,
    });
    expect(switched.checkpoint).toMatchObject({
      claimId: current.claim.id,
      contextPackId: current.contextPack.id,
      sequence: 1,
    });
    expect(switched.nextClaim).toMatchObject({
      taskId: taskB.id,
      state: "active",
      contextPackId: switched.contextPack.id,
    });
    expect(switched.contextPack.id).not.toBe(current.contextPack.id);
    expect(switched.contextPack.taskId).toBe(taskB.id);

    const database = openDatabase(temporary.path);
    try {
      expect(database.prepare(`
        SELECT category FROM coordination_events
        WHERE project_id = ? ORDER BY rowid
      `).all(project.id)).toEqual([
        { category: "claim" },
        { category: "checkpoint" },
        { category: "pause" },
        { category: "claim" },
      ]);
    } finally {
      database.close();
    }

    const beforeFailure = captureDatabaseRows(temporary.path);
    const failing = createFailingSwitchService({
      databasePath: temporary.path,
      profileId: createdProfile.profile.id,
      token: createdProfile.token,
    });
    try {
      expect(() => failing.service.switchTask({
        currentClaimId: switched.nextClaim.id,
        projectId: project.id,
        currentTaskId: taskB.id,
        expectedCurrentProjectRevision: 2,
        expectedCurrentTaskRevision: 1,
        checkpoint: checkpoint("This checkpoint must roll back"),
        terminalAction: "release",
        nextTaskId: taskA.id,
        expectedNextProjectRevision: 2,
        expectedNextTaskRevision: 1,
        nextContextBudgetTokens: 200,
        acceptedDelegationId: null,
        idempotencyKey: "scenario-6-rollback",
      }, failing.principal)).toThrowError(expect.objectContaining({
        code: "coordination_unavailable",
      }));
    } finally {
      failing.database.close();
    }
    const afterFailure = captureDatabaseRows(temporary.path);
    expect(afterFailure.equals(beforeFailure)).toBe(true);
  });

  it("scenario 7 reconciles two independent submissions without stale work overwriting newer knowledge", () => {
    const temporary = createTemporaryDatabase();
    temporaryDatabases.push(temporary);
    const application = createApplication({
      databasePath: temporary.path,
      now: () => scenarioNow,
    });
    applications.push(application);
    const project = application.service.createProject({ name: "Independent work" });
    const tasks = ["Independent task A", "Independent task B"].map((title) =>
      application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title,
        body: `${title} has a non-conflicting scope.`,
        sourceKind: "human",
        sourceRef: null,
      }),
    );
    const workers = ["Independent worker A", "Independent worker B"].map((name) => {
      const created = application.service.profiles.createProfile({
        name,
        projectId: project.id,
      });
      return {
        profileId: created.profile.id,
        principal: application.service.profiles.authenticate({
          profileId: created.profile.id,
          token: created.token,
        })!,
      };
    });

    const claims = tasks.map((task, index) =>
      application.service.coordination.claimTask({
        projectId: project.id,
        taskId: task.id,
        expectedProjectRevision: 2,
        expectedTaskRevision: 1,
        contextBudgetTokens: 200,
        acceptedDelegationId: null,
        idempotencyKey: `scenario-7-claim-${index}`,
      }, workers[index]!.principal),
    );
    const checkpoints = claims.map((claim, index) =>
      application.service.coordination.checkpointClaim({
        claimId: claim.claim.id,
        expectedProjectRevision: 2,
        expectedTaskRevision: 1,
        checkpoint: checkpoint(`Independent checkpoint ${index}`),
        idempotencyKey: `scenario-7-checkpoint-${index}`,
      }, workers[index]!.principal),
    );
    const submissions = claims.map((claim, index) =>
      application.service.coordination.submitTaskResult({
        claimId: claim.claim.id,
        checkpointId: checkpoints[index]!.checkpoint.id,
        expectedProjectRevision: 2,
        expectedTaskRevision: 1,
        submission: {
          summary: `Independent result ${index}`,
          verificationEvidence: {
            tests: [`independent verification ${index}`],
            artifacts: [],
          },
          repositoryEvidence: null,
          changes: {
            rationale: `Complete independent task ${index}.`,
            operations: [],
          },
        },
        idempotencyKey: `scenario-7-submit-${index}`,
      }, workers[index]!.principal),
    );

    expect(claims[0]!.claim.profileId).toBe(workers[0]!.profileId);
    expect(claims[1]!.claim.profileId).toBe(workers[1]!.profileId);
    expect(checkpoints.map(({ checkpoint: saved }) => saved.claimId)).toEqual(
      claims.map(({ claim }) => claim.id),
    );
    expect(submissions.map(({ submission }) => submission.profileId)).toEqual(
      workers.map(({ profileId }) => profileId),
    );
    expect(claims[0]!.contextPack.id).not.toBe(claims[1]!.contextPack.id);
    expect(application.service.proposals.accept(submissions[0]!.proposal.id)).toMatchObject({
      outcome: "applied",
      projectRevision: 3,
    });

    const conflictDeltaTables = new Set([
      "audit_events",
      "change_proposals",
      "idempotency_results",
      "task_submissions",
    ]);
    const beforeConflict = captureTableRows(temporary.path);
    expect(beforeConflict.map(({ name }) => name)).toContain("project_record_revisions");
    expect(application.service.proposals.accept(submissions[1]!.proposal.id)).toMatchObject({
      outcome: "conflicted",
    });
    const afterConflict = captureTableRows(temporary.path);
    expect(afterConflict.map(({ name }) => name)).toEqual(
      beforeConflict.map(({ name }) => name),
    );
    expect(afterConflict.filter(({ name }) => !conflictDeltaTables.has(name))).toEqual(
      beforeConflict.filter(({ name }) => !conflictDeltaTables.has(name)),
    );

    const conflictReason = "Proposal revisions changed before human acceptance";
    const proposalId = submissions[1]!.proposal.id;
    const proposalBefore = rowsFor(beforeConflict, "change_proposals")
      .find(({ id }) => id === proposalId)!;
    expect(rowsFor(afterConflict, "change_proposals")).toEqual(
      rowsFor(beforeConflict, "change_proposals").map((row) => row.id === proposalId
        ? {
            ...row,
            state: "conflicted",
            review_reason: conflictReason,
            reviewer_actor: "local_human",
            updated_at: scenarioNow,
            reviewed_at: scenarioNow,
          }
        : row),
    );
    expect(rowsFor(afterConflict, "task_submissions")).toEqual(
      rowsFor(beforeConflict, "task_submissions").map((row) =>
        row.id === submissions[1]!.submission.id
          ? { ...row, state: "conflicted", decided_at: scenarioNow }
          : row),
    );
    expect(rowsFor(afterConflict, "idempotency_results")).toEqual(
      rowsFor(beforeConflict, "idempotency_results").map((row) =>
        row.profile_id === workers[1]!.profileId &&
          row.idempotency_key === proposalBefore.idempotency_key
          ? {
              ...row,
              outcome: "conflicted",
              result_json: JSON.stringify({
                outcome: "conflicted",
                changeId: row.change_id,
                proposalId,
                state: "conflicted",
                currentProjectRevision: 3,
                replayed: false,
              }),
            }
          : row),
    );
    const auditBefore = rowsFor(beforeConflict, "audit_events");
    const auditAfter = rowsFor(afterConflict, "audit_events");
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(auditAfter.at(-1)).toEqual({
      id: expect.stringMatching(/^audit-/),
      project_id: project.id,
      actor_type: "local_human",
      profile_id: null,
      authority_mode: "human",
      scope_decision: "human_review",
      action_category: "proposal_conflicted",
      target_id: proposalId,
      idempotency_key: proposalBefore.idempotency_key,
      revision_before: 3,
      revision_after: 3,
      outcome: "conflicted",
      reason: conflictReason,
      created_at: scenarioNow,
    });

    const database = openDatabase(temporary.path);
    try {
      expect(database.prepare(`
        SELECT id, status, revision, title, body
        FROM project_records WHERE id IN (?, ?) ORDER BY id
      `).all(tasks[0]!.id, tasks[1]!.id)).toEqual([
        {
          id: tasks[0]!.id,
          status: "completed",
          revision: 2,
          title: tasks[0]!.title,
          body: tasks[0]!.body,
        },
        {
          id: tasks[1]!.id,
          status: "active",
          revision: 1,
          title: tasks[1]!.title,
          body: tasks[1]!.body,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)));
      expect(database.prepare(`
        SELECT id, state FROM task_submissions ORDER BY id
      `).all()).toEqual([
        { id: submissions[0]!.submission.id, state: "accepted" },
        { id: submissions[1]!.submission.id, state: "conflicted" },
      ].sort((left, right) => left.id.localeCompare(right.id)));
      expect(database.prepare("SELECT revision FROM projects WHERE id = ?")
        .get(project.id)).toEqual({ revision: 3 });
    } finally {
      database.close();
    }
  });

  it("scenario 8 lets a parent coordinate delegated children without launching or impersonating them", () => {
    const processLaunch = vi.mocked(childProcess.spawn);
    processLaunch.mockClear();
    const repositoryCalls: string[] = [];
    try {
      const temporary = createTemporaryDatabase();
      temporaryDatabases.push(temporary);
      const application = createApplication({
        databasePath: temporary.path,
        now: () => scenarioNow,
        repositoryImportDependencies: {
          scanner() {
            repositoryCalls.push("import-scan");
            throw new Error("Repository import must not run during coordination");
          },
          generator() {
            repositoryCalls.push("import-generate");
            throw new Error("Repository generation must not run during coordination");
          },
          driftVerifier() {
            repositoryCalls.push("import-drift");
            throw new Error("Repository drift verification must not run during coordination");
          },
        },
        repositoryRefreshDependencies: {
          scanner() {
            repositoryCalls.push("refresh-scan");
            throw new Error("Repository refresh must not run during coordination");
          },
        },
      });
      applications.push(application);
      const project = application.service.createProject({ name: "Parent orchestration" });
      const tasks = ["Delegated task A", "Delegated task B"].map((title) =>
        application.service.createRecord({
          projectId: project.id,
          kind: "task",
          status: "active",
          title,
          body: `${title} is bounded and ready.`,
          sourceKind: "human",
          sourceRef: null,
        }),
      );
      const parentCreated = application.service.profiles.createProfile({
        name: "Parent orchestrator",
        projectId: project.id,
      });
      const childCreated = ["Delegated child A", "Delegated child B"].map((name) =>
        application.service.profiles.createProfile({ name, projectId: project.id }),
      );
      const parent = application.service.profiles.authenticate({
        profileId: parentCreated.profile.id,
        token: parentCreated.token,
      })!;
      const children = childCreated.map((created) => ({
        profileId: created.profile.id,
        principal: application.service.profiles.authenticate({
          profileId: created.profile.id,
          token: created.token,
        })!,
      }));

      expect(application.service.coordination.listReadyTasks({
        projectId: project.id,
        expectedProjectRevision: 2,
        cursor: null,
        limit: 10,
      }, parent).tasks.map(({ task }) => task.id)).toEqual(
        tasks.map(({ id }) => id).sort(),
      );

      const delegations = tasks.map((task, index) =>
        application.service.coordination.createDelegation({
          projectId: project.id,
          taskId: task.id,
          childProfileId: children[index]!.profileId,
          expectedProjectRevision: 2,
          expectedTaskRevision: 1,
          scope: {
            summary: `Complete ${task.title}.`,
            constraints: ["Return bounded test evidence only."],
          },
          allowedOutputs: ["create_record"],
          deadline: "2026-08-15T11:00:00.000Z",
          idempotencyKey: `scenario-8-delegate-${index}`,
        }, parent),
      );
      const claims = delegations.map((delegated, index) => {
        application.service.coordination.acceptDelegation({
          delegationId: delegated.delegation.id,
          projectId: project.id,
          taskId: tasks[index]!.id,
          expectedProjectRevision: 2,
          expectedTaskRevision: 1,
          idempotencyKey: `scenario-8-accept-${index}`,
        }, children[index]!.principal);
        return application.service.coordination.claimTask({
          projectId: project.id,
          taskId: tasks[index]!.id,
          expectedProjectRevision: 2,
          expectedTaskRevision: 1,
          contextBudgetTokens: 200,
          acceptedDelegationId: delegated.delegation.id,
          idempotencyKey: `scenario-8-claim-${index}`,
        }, children[index]!.principal);
      });
      const checkpoints = claims.map((claimed, index) =>
        application.service.coordination.checkpointClaim({
          claimId: claimed.claim.id,
          expectedProjectRevision: 2,
          expectedTaskRevision: 1,
          checkpoint: checkpoint(`Delegated child checkpoint ${index}`),
          idempotencyKey: `scenario-8-checkpoint-${index}`,
        }, children[index]!.principal),
      );
      const submissions = claims.map((claimed, index) =>
        application.service.coordination.submitTaskResult({
          claimId: claimed.claim.id,
          checkpointId: checkpoints[index]!.checkpoint.id,
          expectedProjectRevision: 2,
          expectedTaskRevision: 1,
          submission: {
            summary: `Delegated child result ${index}`,
            verificationEvidence: {
              tests: [`delegated scenario ${index}`],
              artifacts: [],
            },
            repositoryEvidence: null,
            changes: {
              rationale: `Submit bounded delegated result ${index}.`,
              operations: [{
                operationId: `scenario-8-child-output-${index}`,
                type: "create_record",
                kind: "evidence",
                status: "provisional",
                title: `Delegated child evidence ${index}`,
                body: `Bounded evidence returned by delegated child ${index}.`,
              }],
            },
          },
          idempotencyKey: `scenario-8-submit-${index}`,
        }, children[index]!.principal),
      );

      const observed = tasks.map((task) =>
        application.service.coordination.getCoordinationState({
          projectId: project.id,
          taskId: task.id,
          expectedProjectRevision: 2,
        }, parent),
      );
      expect(observed.map((state) => ({
        claimOwner: state.claim?.profileId,
        claimState: state.claim?.state,
        delegationState: state.delegation?.state,
        submissionState: state.submission?.state,
      }))).toEqual(children.map((child) => ({
        claimOwner: child.profileId,
        claimState: "submitted",
        delegationState: "claimed",
        submissionState: "submitted",
      })));
      expect(submissions.map(({ proposal }) => proposal.origin)).toEqual(
        children.map((child) => ({ type: "profile", profileId: child.profileId })),
      );
      expect(submissions.every(({ proposal }) =>
        application.service.proposals.get(proposal.id).operations.some(
          (operation) => operation.type === "create_record",
        )
      )).toBe(true);
      expect(claims.every(({ claim }) => claim.profileId !== parent.id)).toBe(true);

      expect(application.service.proposals.accept(submissions[0]!.proposal.id)).toMatchObject({
        outcome: "applied",
        projectRevision: 3,
      });
      expect(application.service.proposals.accept(submissions[1]!.proposal.id)).toMatchObject({
        outcome: "conflicted",
        currentProjectRevision: 3,
      });
      const synthesis = application.service.submitChangeSet(parent, {
        projectId: project.id,
        baseProjectRevision: 3,
        idempotencyKey: "scenario-8-parent-synthesis",
        rationale: "Assemble the two bounded child results through governance.",
        sourceTaskId: null,
        predecessorProposalId: null,
        operations: [{
          operationId: "scenario-8-create-synthesis",
          type: "create_record",
          kind: "outcome",
          status: "provisional",
          title: "Governed delegated synthesis",
          body: `Accepted ${submissions[0]!.submission.id}; preserved conflict ${submissions[1]!.submission.id}.`,
        }],
      });
      expect(synthesis).toMatchObject({ outcome: "proposed", state: "pending" });
      if (synthesis.outcome !== "proposed") throw new Error("Expected parent synthesis proposal");
      expect(application.service.proposals.accept(synthesis.proposalId)).toMatchObject({
        outcome: "applied",
        projectRevision: 4,
      });

      const claimDatabase = openDatabase(temporary.path);
      try {
        const allTaskClaims = claimDatabase.prepare(`
          SELECT id, task_id, profile_id, delegation_id
          FROM task_claims
          WHERE task_id IN (?, ?)
          ORDER BY task_id, id
        `).all(tasks[0]!.id, tasks[1]!.id);
        expect(allTaskClaims).toHaveLength(2);
        expect(allTaskClaims).toEqual(claims.map((claimed, index) => ({
          id: claimed.claim.id,
          task_id: tasks[index]!.id,
          profile_id: children[index]!.profileId,
          delegation_id: delegations[index]!.delegation.id,
        })).sort((left, right) =>
          left.task_id.localeCompare(right.task_id) || left.id.localeCompare(right.id)));
        expect(allTaskClaims.filter((row) =>
          (row as { profile_id: string }).profile_id === parent.id)).toEqual([]);
        expect(claimDatabase.prepare("SELECT state FROM task_submissions WHERE id = ?")
          .get(submissions[0]!.submission.id)).toEqual({ state: "accepted" });
        expect(claimDatabase.prepare("SELECT state FROM task_submissions WHERE id = ?")
          .get(submissions[1]!.submission.id)).toEqual({ state: "conflicted" });
        expect(claimDatabase.prepare("SELECT state FROM task_delegations WHERE id = ?")
          .get(delegations[0]!.delegation.id)).toEqual({ state: "completed" });
        expect(claimDatabase.prepare("SELECT state FROM task_delegations WHERE id = ?")
          .get(delegations[1]!.delegation.id)).toEqual({ state: "claimed" });
        expect(claimDatabase.prepare(`
          SELECT profile_id, claim_id, delegation_id, submission_id, proposal_id
          FROM coordination_events WHERE category = 'reconciliation'
        `).all()).toEqual([{
          profile_id: children[0]!.profileId,
          claim_id: claims[0]!.claim.id,
          delegation_id: delegations[0]!.delegation.id,
          submission_id: submissions[0]!.submission.id,
          proposal_id: submissions[0]!.proposal.id,
        }]);
        expect(claimDatabase.prepare(`
          SELECT kind, status, title, body FROM project_records
          WHERE title = 'Governed delegated synthesis'
        `).get()).toEqual({
          kind: "outcome",
          status: "provisional",
          title: "Governed delegated synthesis",
          body: `Accepted ${submissions[0]!.submission.id}; preserved conflict ${submissions[1]!.submission.id}.`,
        });
      } finally {
        claimDatabase.close();
      }

      const beforeImpersonation = captureDatabaseRows(temporary.path);
      expect(() => application.service.coordination.checkpointClaim({
        claimId: claims[0]!.claim.id,
        expectedProjectRevision: 2,
        expectedTaskRevision: 1,
        checkpoint: checkpoint("Parent must not checkpoint child work"),
        idempotencyKey: "scenario-8-parent-impersonation",
      }, parent)).toThrowError(expect.objectContaining({
        code: "coordination_authority_denied",
      }));
      const afterImpersonation = captureDatabaseRows(temporary.path);
      expect(afterImpersonation.equals(beforeImpersonation)).toBe(true);
      expect(processLaunch).not.toHaveBeenCalled();
      expect(repositoryCalls).toEqual([]);
    } finally {
      processLaunch.mockClear();
    }
  });

  it("allows exactly one of two real processes to claim the same task in each of 10 races", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const processLaunch = vi.mocked(childProcess.spawn);
      const launchCount = processLaunch.mock.calls.length;
      const temporary = createTemporaryDatabase();
      temporaryDatabases.push(temporary);
      const application = createApplication({ databasePath: temporary.path });
      applications.push(application);
      const project = application.service.createProject({ name: `Race ${iteration}` });
      const task = application.service.createRecord({
        projectId: project.id,
        kind: "task",
        status: "active",
        title: "Exclusive work",
        body: "Only one profile may own this task.",
        sourceKind: "human",
        sourceRef: null,
      });
      const profiles = ["First contender", "Second contender"].map((name) => {
        const created = application.service.profiles.createProfile({
          name: `${name} ${iteration}`,
          projectId: project.id,
        });
        return { profileId: created.profile.id, token: created.token };
      });
      application.close();
      applications.pop();

      const raced = await runClaimRace({
        databasePath: temporary.path,
        projectId: project.id,
        taskId: task.id,
        projectRevision: 1,
        taskRevision: 1,
        profiles,
      });
      const successes = raced.results.filter(
        (result): result is RaceSuccess => result.outcome === "success",
      );
      const conflicts = raced.results.filter(
        (result): result is RaceConflict => result.outcome === "error",
      );

      expect(raced.results.map(({ profileId }) => profileId).sort()).toEqual(
        profiles.map(({ profileId }) => profileId).sort(),
      );
      expect(successes).toHaveLength(1);
      expect(conflicts).toEqual([
        expect.objectContaining({ outcome: "error", code: "claim_conflict" }),
      ]);
      expect(raced.children.every(
        (child) => child.exitCode === 0 && child.signalCode === null,
      )).toBe(true);
      expect(raced.stderrs).toEqual(["", ""]);
      const workerLaunches = processLaunch.mock.calls.slice(launchCount);
      expect(workerLaunches).toHaveLength(2);
      expect(workerLaunches.map((call) => call[1])).toEqual(raced.argvs);
      for (const profile of profiles) {
        expect(JSON.stringify(raced.argvs)).not.toContain(profile.token);
        expect(JSON.stringify(workerLaunches)).not.toContain(profile.token);
        expect(JSON.stringify(raced.results)).not.toContain(profile.token);
        expect(JSON.stringify(raced.stderrs)).not.toContain(profile.token);
      }

      const database = openDatabase(temporary.path);
      try {
        expect(database.prepare(`
          SELECT id, profile_id, context_pack_id
          FROM task_claims
          WHERE task_id = ? AND state = 'active'
        `).all(task.id)).toEqual([{
          id: successes[0]!.claimId,
          profile_id: successes[0]!.profileId,
          context_pack_id: successes[0]!.contextPackId,
        }]);
        expect(database.prepare(`
          SELECT id, task_id FROM context_packs WHERE task_id = ?
        `).all(task.id)).toEqual([{
          id: successes[0]!.contextPackId,
          task_id: task.id,
        }]);
        expect(database.prepare(`
          SELECT
            (SELECT COUNT(*) FROM task_claims WHERE task_id = ?) AS claims,
            (SELECT COUNT(*) FROM context_packs WHERE task_id = ?) AS contexts,
            (SELECT COUNT(*) FROM coordination_events WHERE task_id = ?) AS events,
            (SELECT COUNT(*) FROM coordination_idempotency WHERE project_id = ?) AS replays,
            (SELECT COUNT(*) FROM task_checkpoints) AS checkpoints,
            (SELECT COUNT(*) FROM task_delegations) AS delegations,
            (SELECT COUNT(*) FROM task_submissions) AS submissions
        `).get(task.id, task.id, task.id, project.id)).toEqual({
          claims: 1,
          contexts: 1,
          events: 1,
          replays: 1,
          checkpoints: 0,
          delegations: 0,
          submissions: 0,
        });
      } finally {
        database.close();
      }

      removeTemporaryDatabase(temporary);
      temporaryDatabases.pop();
    }
  }, 180_000);
});
