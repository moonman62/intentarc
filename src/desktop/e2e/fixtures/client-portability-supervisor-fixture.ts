import { spawn } from "node:child_process";
import {
  CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES,
  createSupervisorFrameDecoder,
  encodeSupervisorFrame,
  type SupervisorRequestFrame,
  type SupervisorResponseFrame,
} from "../client-portability-supervisor-protocol.js";

type FixtureMode =
  | "connect-fail-after-child"
  | "connect-hang"
  | "call-hang"
  | "close-hang"
  | "close-success"
  | "stubborn-hang"
  | "late-identity-at-abort"
  | "malformed-frame"
  | "truncated-frame"
  | "excess-stdout"
  | "excess-stderr"
  | "abrupt-exit";

declare const __INTENTARC_SUPERVISOR_FIXTURE_MODE__: FixtureMode;

const mode = __INTENTARC_SUPERVISOR_FIXTURE_MODE__;
const decoder = createSupervisorFrameDecoder();
let keepAlive: NodeJS.Timeout | undefined;
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

const respond = (request: SupervisorRequestFrame, payload: unknown): void => {
  const frame: SupervisorResponseFrame = {
    version: 1,
    kind: "response",
    runId: request.runId,
    sessionId: request.sessionId,
    nonce: request.nonce,
    requestId: request.requestId,
    payload,
  };
  process.stdout.write(encodeSupervisorFrame(frame));
};

const closeTerminal = (request: SupervisorRequestFrame): void => {
  process.stdout.write(encodeSupervisorFrame({
    version: 1,
    kind: "terminal",
    runId: request.runId,
    sessionId: request.sessionId,
    nonce: request.nonce,
    payload: { status: "closed" },
  }));
};

const handleConnect = (request: SupervisorRequestFrame): void => {
  if (mode === "stubborn-hang") {
    keepAlive ??= setInterval(() => undefined, 1_000);
    return;
  }
  if (mode === "connect-hang") return;
  if (mode === "abrupt-exit") process.exit(19);
  if (mode === "excess-stderr") {
    process.stderr.write(Buffer.alloc(64 * 1024 + 1, 0x78));
    return;
  }
  if (mode === "excess-stdout") {
    process.stdout.write(Buffer.alloc(
      CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES * 4 + 1,
      0x78,
    ));
    return;
  }
  if (mode === "truncated-frame") {
    process.stdout.write('{"version":1');
    return;
  }
  if (mode === "malformed-frame") {
    process.stdout.write(encodeSupervisorFrame({
      version: 1,
      kind: "response",
      runId: request.runId,
      sessionId: request.sessionId,
      nonce: "b".repeat(64),
      requestId: request.requestId,
      payload: { status: "ready" },
    }));
    return;
  }
  if (mode === "connect-fail-after-child") {
    const child = spawn(process.execPath, ["--eval", ""], {
      env: {},
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    if (child.pid !== undefined) {
      process.stdout.write(encodeSupervisorFrame({
        version: 1,
        kind: "bridge_identity",
        runId: request.runId,
        sessionId: request.sessionId,
        nonce: request.nonce,
        payload: { pid: child.pid, startTime: `${child.pid}001` },
      }));
    }
    respond(request, { status: "failed", category: "supervisor_startup" });
    process.stdout.write(encodeSupervisorFrame({
      version: 1,
      kind: "terminal",
      runId: request.runId,
      sessionId: request.sessionId,
      nonce: request.nonce,
      payload: { status: "failed", category: "supervisor_startup" },
    }));
    return;
  }
  respond(request, { status: "ready" });
};

const handleRequest = (request: SupervisorRequestFrame): void => {
  if (request.operation === "connect") {
    handleConnect(request);
    return;
  }
  if (request.operation === "callTool" && mode === "call-hang") {
    setTimeout(() => respond(request, { structuredContent: { late: true } }), 125);
    return;
  }
  if (request.operation === "callTool" && mode === "late-identity-at-abort") {
    const detached = spawn(process.execPath, [
      "--eval",
      "setTimeout(() => process.exit(0), 750); setInterval(() => undefined, 1000)",
    ], {
      detached: true,
      env: {},
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    detached.unref();
    const detachedPid = detached.pid;
    if (detachedPid === undefined) process.exit(31);
    const response: SupervisorResponseFrame = {
      version: 1,
      kind: "response",
      runId: request.runId,
      sessionId: request.sessionId,
      nonce: request.nonce,
      requestId: request.requestId,
      payload: { status: "failed", category: "supervisor_protocol" },
    };
    setTimeout(() => process.stdout.write(encodeSupervisorFrame(response)), 75);
    setTimeout(() => process.stdout.write(encodeSupervisorFrame({
        version: 1,
        kind: "bridge_identity",
        runId: request.runId,
        sessionId: request.sessionId,
        nonce: request.nonce,
        payload: { pid: detachedPid, startTime: `${detachedPid}000` },
      })), 85);
    return;
  }
  if (request.operation === "close" && (mode === "close-hang" || mode === "close-success")) {
    respond(request, { status: "closed" });
    setTimeout(
      () => closeTerminal(request),
      mode === "close-hang" ? 125 : 75,
    );
    return;
  }
  respond(request, { status: "failed", category: "supervisor_protocol" });
};

if (process.argv.length !== 3 || process.argv[2] !== "--supervisor") {
  process.exitCode = 23;
} else {
  for await (const chunk of process.stdin) {
    for (const frame of decoder.push(chunk as Uint8Array)) {
      if (frame.kind !== "request") process.exit(29);
      handleRequest(frame);
    }
  }
}
