import { describe, expect, it } from "vitest";
import {
  CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES,
  applySupervisorProtocolFrame,
  createSupervisorFrameDecoder,
  encodeSupervisorFrame,
  parseSupervisorFrame,
  type SupervisorFrame,
  type SupervisorProtocolState,
} from "./client-portability-supervisor-protocol.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_ID = `codex-${RUN_ID}`;
const NONCE = "a".repeat(64);
const INVALID = "Client portability supervisor protocol is invalid.";
const encoder = new TextEncoder();

const asBytes = (input: string | Uint8Array) =>
  typeof input === "string" ? encoder.encode(input) : input;

const request = (
  operation: "connect" | "callTool" | "close" | "status",
  number: number,
  payload: unknown = {},
): SupervisorFrame => ({
  version: 1,
  kind: "request",
  runId: RUN_ID,
  sessionId: SESSION_ID,
  nonce: NONCE,
  requestId: `123e4567-e89b-42d3-a456-4266141740${number.toString().padStart(2, "0")}`,
  operation,
  payload,
});

const response = (number: number, payload: unknown): SupervisorFrame => ({
  version: 1,
  kind: "response",
  runId: RUN_ID,
  sessionId: SESSION_ID,
  nonce: NONCE,
  requestId: `123e4567-e89b-42d3-a456-4266141740${number.toString().padStart(2, "0")}`,
  payload,
});

const terminal = (payload: { status: "closed" | "failed" }): SupervisorFrame => ({
  version: 1,
  kind: "terminal",
  runId: RUN_ID,
  sessionId: SESSION_ID,
  nonce: NONCE,
  payload,
});

const initialState = (): SupervisorProtocolState => ({
  phase: "starting",
  pendingRequestIds: new Set(),
  seenRequestIds: new Set(),
  terminalSeen: false,
});

const apply = (frames: readonly SupervisorFrame[]) =>
  frames.reduce(applySupervisorProtocolFrame, initialState());

describe("client portability supervisor protocol", () => {
  it("encodes, decodes, and applies a correlated close response before the terminal receipt", () => {
    const valid = [
      request("connect", 1),
      response(1, { status: "ready" }),
      request("callTool", 2),
      response(2, { structuredContent: { ok: true } }),
      request("close", 3),
      response(3, { status: "closed" }),
      terminal({ status: "closed" }),
    ];

    const decoder = createSupervisorFrameDecoder();
    const decoded = valid.flatMap((frame) => decoder.push(encodeSupervisorFrame(frame)));

    expect(decoded).toEqual(valid);
    expect(decoder.end()).toEqual([]);
    expect(apply(decoded)).toMatchObject({
      phase: "terminal",
      terminalSeen: true,
      pendingRequestIds: new Set(),
    });
  });

  it("accepts fragmented UTF-8 frames only after their LF terminator", () => {
    const encoded = encodeSupervisorFrame(request("connect", 1, { name: "João" }));
    const decoder = createSupervisorFrameDecoder();

    expect(decoder.push(encoded.slice(0, encoded.length - 1))).toEqual([]);
    expect(decoder.push(encoded.slice(encoded.length - 1))).toEqual([request("connect", 1, { name: "João" })]);
  });

  it.each([
    ["duplicate top-level key", '{"version":1,"version":1}'],
    ["duplicate nested key", '{"payload":{"name":"a","name":"b"}}'],
    ["unknown key", JSON.stringify({ ...request("status", 1), extra: true })],
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28])],
    ["oversized frame", new Uint8Array(1024 * 1024 + 1)],
  ] as const)("rejects %s", (_name, input) => {
    expect(() => parseSupervisorFrame(asBytes(input))).toThrow(INVALID);
  });

  it("rejects a syntactically valid frame that exceeds the inclusive byte ceiling", () => {
    const oversized = JSON.stringify({
      ...request("status", 1),
      payload: "x".repeat(CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES),
    });

    expect(() => parseSupervisorFrame(asBytes(oversized))).toThrow(INVALID);
  });

  it("rejects a repeated decoded key inside an otherwise valid request payload", () => {
    const duplicateNestedKey = `{"version":1,"kind":"request","runId":"${RUN_ID}","sessionId":"${SESSION_ID}","nonce":"${NONCE}","requestId":"123e4567-e89b-42d3-a456-426614174001","operation":"status","payload":{"name":"a","\\u006eame":"b"}}`;

    expect(() => parseSupervisorFrame(asBytes(duplicateNestedKey))).toThrow(INVALID);
  });

  it("rejects output whose JSON bytes plus the LF exceed the inclusive byte ceiling", () => {
    const oversized = {
      ...request("status", 1),
      payload: "x".repeat(CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES),
    } as SupervisorFrame;

    expect(() => encodeSupervisorFrame(oversized)).toThrow(INVALID);
  });

  it.each([
    ["a CR-delimited frame", encoder.encode('{"version":1}\r')],
    ["a NUL-containing frame", encoder.encode('{"version":1}\0')],
  ])("rejects %s", (_name, input) => {
    expect(() => parseSupervisorFrame(input)).toThrow(INVALID);
  });

  it.each([
    ["call before connect", [request("callTool", 1)]],
    ["second connect", [request("connect", 1), response(1, { status: "ready" }), request("connect", 2)]],
    ["request after close", [request("connect", 1), response(1, { status: "ready" }), request("close", 2), response(2, { status: "closed" }), request("status", 3)]],
    ["duplicate request ID", [request("connect", 1), response(1, { status: "ready" }), request("status", 1)]],
    ["unsolicited response", [response(1, { status: "ready" })]],
    ["mismatched run identity", [request("connect", 1), { ...response(1, { status: "ready" }), runId: "123e4567-e89b-42d3-a456-426614174001" }]],
    ["mismatched session identity", [request("connect", 1), { ...response(1, { status: "ready" }), sessionId: `claude-${RUN_ID}` }]],
    ["mismatched nonce", [request("connect", 1), { ...response(1, { status: "ready" }), nonce: "b".repeat(64) }]],
    ["two terminal frames", [request("connect", 1), response(1, { status: "ready" }), request("close", 2), response(2, { status: "closed" }), terminal({ status: "closed" }), terminal({ status: "closed" })]],
  ] as const)("rejects %s", (_name, frames) => {
    expect(() => apply(frames)).toThrow(INVALID);
  });

  it("rejects a second connect while the first connect response is pending", () => {
    expect(() => apply([
      request("connect", 1),
      request("connect", 2),
    ])).toThrow(INVALID);
  });

  it("rejects partially initialized identity state instead of rebinding it", () => {
    const partial = { ...initialState(), runId: RUN_ID };
    const started = applySupervisorProtocolFrame(initialState(), request("connect", 1));
    const missingNonce = { ...started, nonce: undefined };

    expect(() => applySupervisorProtocolFrame(partial, request("connect", 1))).toThrow(INVALID);
    expect(() => applySupervisorProtocolFrame(missingNonce, response(1, { status: "ready" }))).toThrow(INVALID);
  });

  it("rejects EOF with a partial line", () => {
    const decoder = createSupervisorFrameDecoder();
    const encoded = encodeSupervisorFrame(request("connect", 1));

    expect(decoder.push(encoded.slice(0, encoded.length - 1))).toEqual([]);
    expect(() => decoder.end()).toThrow(INVALID);
  });

  it("returns fresh state and leaves prior correlation sets unchanged", () => {
    const before = initialState();
    const after = applySupervisorProtocolFrame(before, request("connect", 1));

    expect(after).not.toBe(before);
    expect(after.pendingRequestIds).not.toBe(before.pendingRequestIds);
    expect(before.pendingRequestIds).toEqual(new Set());
    expect(before.seenRequestIds).toEqual(new Set());
    expect(after.pendingRequestIds).toEqual(new Set([request("connect", 1).requestId]));
  });
});
