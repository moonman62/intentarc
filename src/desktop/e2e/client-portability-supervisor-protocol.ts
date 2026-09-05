import { z } from "zod";

export const CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION = 1;
export const CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES = 1024 * 1024;

export type SupervisorOperation = "connect" | "callTool" | "close" | "status";

export interface SupervisorRequestFrame {
  readonly version: typeof CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION;
  readonly kind: "request";
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly requestId: string;
  readonly operation: SupervisorOperation;
  readonly payload: unknown;
}

export interface SupervisorResponseFrame {
  readonly version: typeof CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly requestId: string;
  readonly payload: unknown;
}

export interface SupervisorBridgeIdentityFrame {
  readonly version: typeof CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION;
  readonly kind: "bridge_identity";
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly payload: {
    readonly pid: number;
    readonly startTime: string;
  };
}

export interface SupervisorTerminalFrame {
  readonly version: typeof CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION;
  readonly kind: "terminal";
  readonly runId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly payload:
    | { readonly status: "closed" }
    | {
      readonly status: "failed";
      readonly category:
        | "supervisor_startup"
        | "supervisor_protocol"
        | "journey"
        | "graceful_close";
    };
}

export type SupervisorFrame =
  | SupervisorRequestFrame
  | SupervisorResponseFrame
  | SupervisorBridgeIdentityFrame
  | SupervisorTerminalFrame;

export interface SupervisorFrameDecoder {
  push(chunk: Uint8Array): readonly SupervisorFrame[];
  end(): readonly SupervisorFrame[];
}

export interface SupervisorProtocolState {
  readonly phase: "starting" | "ready" | "closing" | "terminal";
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly seenRequestIds: ReadonlySet<string>;
  readonly terminalSeen: boolean;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly nonce?: string;
  readonly bridgeIdentitySeen?: boolean;
}

const invalidProtocol = (): never => {
  throw new Error("Client portability supervisor protocol is invalid.");
};

const baseFrameSchema = z.strictObject({
  version: z.literal(CLIENT_PORTABILITY_SUPERVISOR_PROTOCOL_VERSION),
  runId: z.string().uuid(),
  sessionId: z.string().regex(/^(codex|claude)-[a-f0-9-]{36}$/),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
});

const requestSchema = baseFrameSchema.extend({
  kind: z.literal("request"),
  requestId: z.string().uuid(),
  operation: z.enum(["connect", "callTool", "close", "status"]),
  payload: z.unknown(),
}).strict();

const responseSchema = baseFrameSchema.extend({
  kind: z.literal("response"),
  requestId: z.string().uuid(),
  payload: z.unknown(),
}).strict();

const bridgeIdentitySchema = baseFrameSchema.extend({
  kind: z.literal("bridge_identity"),
  payload: z.strictObject({
    pid: z.number().int().positive(),
    startTime: z.string().min(1),
  }),
}).strict();

const terminalSchema = baseFrameSchema.extend({
  kind: z.literal("terminal"),
  payload: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("closed") }),
    z.strictObject({
      status: z.literal("failed"),
      category: z.enum([
        "supervisor_startup",
        "supervisor_protocol",
        "journey",
        "graceful_close",
      ]),
    }),
  ]),
}).strict();

const frameSchema = z.discriminatedUnion("kind", [
  requestSchema,
  responseSchema,
  bridgeIdentitySchema,
  terminalSchema,
]);

const textEncoder = new TextEncoder();

const requireValidFrame = (value: unknown): SupervisorFrame => {
  const result = frameSchema.safeParse(value);
  if (!result.success) invalidProtocol();
  return result.data as SupervisorFrame;
};

const hasForbiddenByte = (bytes: Uint8Array) =>
  bytes.some((byte) => byte === 0 || byte === 0x0a || byte === 0x0d);

const scanForDuplicateObjectKeys = (text: string): void => {
  let index = 0;

  const fail = (): never => invalidProtocol();
  const skipWhitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return fail();
        }
      }
      if (character < " ") fail();
      if (character === "\\") {
        index += 1;
        const escape = text[index] ?? fail();
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail();
      }
      index += 1;
    }
    return fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail();
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (true) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail();
        index += 1;
      }
    }
    if (character === '"') {
      parseString();
      return;
    }
    const start = index;
    while (
      index < text.length
      && !/[\t\n\r ,}\]]/.test(text[index]!)
    ) index += 1;
    if (start === index) fail();
  };

  try {
    parseValue();
    skipWhitespace();
    if (index !== text.length) fail();
  } catch {
    return invalidProtocol();
  }
};

export const parseSupervisorFrame = (line: Uint8Array): SupervisorFrame => {
  if (
    line.length + 1 > CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES
    || hasForbiddenByte(line)
  ) invalidProtocol();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    scanForDuplicateObjectKeys(text);
    return requireValidFrame(JSON.parse(text));
  } catch {
    return invalidProtocol();
  }
};

export const encodeSupervisorFrame = (frame: SupervisorFrame): Uint8Array => {
  try {
    requireValidFrame(frame);
    const encoded = textEncoder.encode(JSON.stringify(frame));
    parseSupervisorFrame(encoded);
    if (encoded.length + 1 > CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES) {
      invalidProtocol();
    }
    const output = new Uint8Array(encoded.length + 1);
    output.set(encoded);
    output[output.length - 1] = 0x0a;
    return output;
  } catch {
    return invalidProtocol();
  }
};

export const createSupervisorFrameDecoder = (): SupervisorFrameDecoder => {
  let buffered: number[] = [];

  return {
    push(chunk) {
      const frames: SupervisorFrame[] = [];
      for (const byte of chunk) {
        if (byte === 0 || byte === 0x0d) invalidProtocol();
        if (byte === 0x0a) {
          frames.push(parseSupervisorFrame(new Uint8Array(buffered)));
          buffered = [];
          continue;
        }
        buffered.push(byte);
        if (buffered.length + 1 > CLIENT_PORTABILITY_SUPERVISOR_MAX_FRAME_BYTES) {
          invalidProtocol();
        }
      }
      return frames;
    },
    end() {
      if (buffered.length > 0) invalidProtocol();
      return [];
    },
  };
};

const hasUnboundInitialIdentity = (state: SupervisorProtocolState) =>
  state.phase === "starting"
  && state.pendingRequestIds.size === 0
  && state.seenRequestIds.size === 0
  && !state.terminalSeen
  && !state.bridgeIdentitySeen
  && state.runId === undefined
  && state.sessionId === undefined
  && state.nonce === undefined;

const matchingIdentity = (state: SupervisorProtocolState, frame: SupervisorFrame) =>
  hasUnboundInitialIdentity(state)
  || (
    state.runId !== undefined
    && state.sessionId !== undefined
    && state.nonce !== undefined
    && state.runId === frame.runId
    && state.sessionId === frame.sessionId
    && state.nonce === frame.nonce
  );

const withIdentity = (state: SupervisorProtocolState, frame: SupervisorFrame) => ({
  runId: state.runId ?? frame.runId,
  sessionId: state.sessionId ?? frame.sessionId,
  nonce: state.nonce ?? frame.nonce,
});

export const applySupervisorProtocolFrame = (
  state: SupervisorProtocolState,
  frame: SupervisorFrame,
): SupervisorProtocolState => {
  requireValidFrame(frame);
  if (!matchingIdentity(state, frame) || state.terminalSeen) invalidProtocol();

  const pendingRequestIds = new Set(state.pendingRequestIds);
  const seenRequestIds = new Set(state.seenRequestIds);
  const identity = withIdentity(state, frame);

  if (frame.kind === "request") {
    if (seenRequestIds.has(frame.requestId)) invalidProtocol();
    const allowed = state.phase === "starting"
      ? frame.operation === "connect" && seenRequestIds.size === 0
      : state.phase === "ready"
        ? frame.operation === "callTool" || frame.operation === "close" || frame.operation === "status"
        : false;
    if (!allowed) invalidProtocol();
    pendingRequestIds.add(frame.requestId);
    seenRequestIds.add(frame.requestId);
    return {
      ...state,
      ...identity,
      phase: frame.operation === "close" ? "closing" : state.phase,
      pendingRequestIds,
      seenRequestIds,
    };
  }

  if (frame.kind === "response") {
    if (!pendingRequestIds.delete(frame.requestId)) invalidProtocol();
    return {
      ...state,
      ...identity,
      phase: state.phase === "starting" ? "ready" : state.phase,
      pendingRequestIds,
      seenRequestIds,
    };
  }

  if (frame.kind === "bridge_identity") {
    if (state.bridgeIdentitySeen || state.seenRequestIds.size === 0) invalidProtocol();
    return {
      ...state,
      ...identity,
      pendingRequestIds,
      seenRequestIds,
      bridgeIdentitySeen: true,
    };
  }

  const closed = frame.payload.status === "closed";
  if (
    (closed && (state.phase !== "closing" || pendingRequestIds.size !== 0))
    || (!closed && (state.seenRequestIds.size === 0 || pendingRequestIds.size !== 0))
  ) invalidProtocol();
  return {
    ...state,
    ...identity,
    phase: "terminal",
    pendingRequestIds,
    seenRequestIds,
    terminalSeen: true,
  };
};
