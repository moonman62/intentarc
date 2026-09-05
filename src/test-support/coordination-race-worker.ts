import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { connect } from "node:net";
import { createApplication } from "../app/create-application.js";
import { CoordinationError } from "../domain/index.js";

type WorkerInput = {
  databasePath: string;
  profileId: string;
  projectId: string;
  taskId: string;
  projectRevision: number;
  taskRevision: number;
  barrierPort: number;
  resultPort: number;
};

type WorkerResult =
  | {
      outcome: "success";
      profileId: string;
      claimId: string;
      contextPackId: string;
    }
  | {
      outcome: "error";
      profileId: string;
      code: "claim_conflict";
    }
  | {
      outcome: "failure";
      code: "coordination_unavailable";
    };

const SOCKET_TIMEOUT_MS = 10_000;
const CREDENTIAL_FRAME_LIMIT_BYTES = 4_096;
const fixedFailure = {
  outcome: "failure",
  code: "coordination_unavailable",
} as const;

const closedText = (value: string): boolean =>
  value.length > 0 && value.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value);

const decimalInteger = (
  value: string,
  minimum: number,
  maximum: number,
): number => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid worker argument");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Invalid worker argument");
  }
  return parsed;
};

const sameCanonicalPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;

const validateDatabasePath = (databasePath: string): void => {
  if (!isAbsolute(databasePath) || resolve(databasePath) !== databasePath) {
    throw new Error("Invalid worker database path");
  }
  const canonicalTemporaryRoot = realpathSync.native(tmpdir());
  const lexicalParent = dirname(databasePath);
  const parentStat = lstatSync(lexicalParent);
  const databaseStat = lstatSync(databasePath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    !databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error("Invalid worker database path");
  }
  const canonicalParent = realpathSync.native(lexicalParent);
  const canonicalDatabase = realpathSync.native(databasePath);
  const directChild = relative(canonicalTemporaryRoot, canonicalParent);
  if (directChild === "" || directChild.startsWith("..") || isAbsolute(directChild) ||
    directChild.includes(sep) || !basename(canonicalParent).startsWith("intentarc-") ||
    basename(canonicalDatabase) !== "intentarc.sqlite" ||
    !sameCanonicalPath(dirname(canonicalDatabase), canonicalParent)) {
    throw new Error("Invalid worker database path");
  }
  if (typeof process.getuid === "function") {
    const owner = process.getuid();
    if (parentStat.uid !== owner || databaseStat.uid !== owner) {
      throw new Error("Invalid worker database path");
    }
  }
};

const parseInput = (arguments_: string[]): WorkerInput => {
  if (arguments_.length !== 8) throw new Error("Invalid worker argument count");
  const [databasePath, profileId, projectId, taskId,
    projectRevisionText, taskRevisionText, barrierPortText, resultPortText] = arguments_ as [
      string, string, string, string, string, string, string, string,
    ];
  if (!databasePath) throw new Error("Invalid worker database path");
  validateDatabasePath(databasePath);
  if (![profileId, projectId, taskId].every(
    (value): value is string => typeof value === "string" && closedText(value),
  )) {
    throw new Error("Invalid worker identity");
  }
  const barrierPort = decimalInteger(barrierPortText, 1, 65_535);
  const resultPort = decimalInteger(resultPortText, 1, 65_535);
  if (barrierPort === resultPort) throw new Error("Worker ports must be distinct");

  return {
    databasePath,
    profileId,
    projectId,
    taskId,
    projectRevision: decimalInteger(projectRevisionText, 0, Number.MAX_SAFE_INTEGER),
    taskRevision: decimalInteger(taskRevisionText, 1, Number.MAX_SAFE_INTEGER),
    barrierPort,
    resultPort,
  };
};

const readCredential = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > CREDENTIAL_FRAME_LIMIT_BYTES) {
      throw new Error("Invalid credential frame");
    }
    chunks.push(bytes);
  }
  const frame = Buffer.concat(chunks, totalBytes).toString("utf8");
  if (!frame.endsWith("\n") || frame.indexOf("\n") !== frame.length - 1) {
    throw new Error("Invalid credential frame");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(frame.slice(0, -1));
  } catch {
    throw new Error("Invalid credential frame");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid credential frame");
  }
  const credential = decoded as Record<string, unknown>;
  if (Object.keys(credential).join(",") !== "profileToken" ||
    typeof credential.profileToken !== "string" || !closedText(credential.profileToken)) {
    throw new Error("Invalid credential frame");
  }
  return credential.profileToken;
};

const waitForBarrier = (port: number): Promise<void> =>
  new Promise((resolveBarrier, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let body = "";
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Barrier timeout")));
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 6) socket.destroy(new Error("Invalid barrier"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      socket.destroy();
      if (body !== "start\n") {
        reject(new Error("Invalid barrier"));
        return;
      }
      resolveBarrier();
    });
  });

const sendResult = (port: number, result: WorkerResult): Promise<void> =>
  new Promise((resolveResult, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Result timeout")));
    socket.once("connect", () => socket.end(JSON.stringify(result)));
    socket.once("error", reject);
    socket.once("close", (hadError) => {
      if (!hadError) resolveResult();
    });
  });

const run = async (arguments_: string[]): Promise<void> => {
  const input = parseInput(arguments_);
  const token = await readCredential();
  await waitForBarrier(input.barrierPort);
  const application = createApplication({ databasePath: input.databasePath });
  try {
    const principal = application.service.profiles.authenticate({
      profileId: input.profileId,
      token,
    });
    if (!principal) throw new Error("Authentication failed");
    try {
      const claimed = application.service.coordination.claimTask({
        projectId: input.projectId,
        taskId: input.taskId,
        expectedProjectRevision: input.projectRevision,
        expectedTaskRevision: input.taskRevision,
        contextBudgetTokens: 100,
        acceptedDelegationId: null,
        idempotencyKey: "race-claim",
      }, principal);
      await sendResult(input.resultPort, {
        outcome: "success",
        profileId: input.profileId,
        claimId: claimed.claim.id,
        contextPackId: claimed.contextPack.id,
      });
    } catch (error) {
      if (!(error instanceof CoordinationError) || error.code !== "claim_conflict") throw error;
      await sendResult(input.resultPort, {
        outcome: "error",
        profileId: input.profileId,
        code: "claim_conflict",
      });
    }
  } finally {
    application.close();
  }
};

const arguments_ = process.argv.slice(2);
let failurePort: number | null = null;
try {
  failurePort = decimalInteger(arguments_.at(-1) ?? "", 1, 65_535);
} catch {
  failurePort = null;
}

try {
  await run(arguments_);
} catch {
  if (failurePort !== null) {
    await sendResult(failurePort, fixedFailure).catch(() => undefined);
  }
  process.exitCode = 1;
}
