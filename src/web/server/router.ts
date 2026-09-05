import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import {
  CoordinationError,
  GovernanceError,
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  RelationshipAlreadyExistsError,
} from "../../domain/index.js";
import { ImportApiError } from "./import-api-error.js";

const MAX_BODY_BYTES = 1_048_576;

const drainRequest = (request: IncomingMessage): void => {
  const cleanup = (): void => {
    request.off("error", cleanup);
    request.off("end", cleanup);
    request.off("close", cleanup);
  };
  request.once("error", cleanup);
  request.once("end", cleanup);
  request.once("close", cleanup);
  request.resume();
};
export const API_RESPONSE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox";

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

class InvalidJsonError extends Error {}
class RequestBodyTooLargeError extends Error {}
class UnsupportedContentTypeError extends Error {}

export class ApiRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "ApiRouteError";
  }
}

export class ApiJsonResponse {
  constructor(
    readonly statusCode: number,
    readonly value: unknown,
  ) {
    if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299) {
      throw new TypeError("API JSON success status must be 2xx");
    }
  }
}

export class ApiBinaryResponse {
  constructor(
    readonly bytes: Uint8Array,
    readonly contentType: string,
  ) {}
}

export class ApiNdjsonResponse {
  constructor(readonly run: (context: {
    signal: AbortSignal;
    write(value: unknown): Promise<void>;
  }) => Promise<void>) {}
}

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp;
  handle(input: {
    match: RegExpExecArray;
    body: unknown;
    url: URL;
    headers: IncomingMessage["headers"];
    rawHeaders: readonly string[];
    signal: AbortSignal;
  }): Promise<unknown> | unknown;
}

export const createApiHandler = (
  routes: ApiRoute[],
): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  async (request, response) => {
    let disposeLifecycle = (): void => undefined;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = findRoute(routes, request.method, url.pathname);
      if (!route) {
        writeError(response, 404, {
          code: "not_found",
          message: "The requested API route was not found.",
          recoverable: true,
        });
        return;
      }
      const lifecycle = requestLifecycle(request, response);
      disposeLifecycle = lifecycle.dispose;

      const body =
        route.route.method === "POST" ||
        route.route.method === "PUT" ||
        route.route.method === "PATCH" ||
        route.route.method === "DELETE"
        ? await readMutationBody(request)
        : undefined;
      const result = await route.route.handle({
        match: route.match,
        body,
        url,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        signal: lifecycle.signal,
      });
      if (result instanceof ApiNdjsonResponse) {
        await writeNdjson(request, response, result, lifecycle.signal);
      } else if (result instanceof ApiBinaryResponse) {
        writeBinary(response, result);
      } else if (result instanceof ApiJsonResponse) {
        writeJson(response, result.statusCode, result.value);
      } else {
        writeJson(response, 200, result);
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
      } else {
        writeNormalizedError(response, error);
      }
    } finally {
      disposeLifecycle();
    }
  };

const findRoute = (
  routes: ApiRoute[],
  method: string | undefined,
  pathname: string,
): { route: ApiRoute; match: RegExpExecArray } | undefined => {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    route.pattern.lastIndex = 0;
    const match = route.pattern.exec(pathname);
    if (
      match &&
      match.index === 0 &&
      match[0].length === pathname.length
    ) {
      return { route, match };
    }
  }

  return undefined;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    drainRequest(request);
    throw new RequestBodyTooLargeError();
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        settle(() => reject(new RequestBodyTooLargeError()));
        drainRequest(request);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => settle(() => {
      if (byteLength === 0) {
        resolve(undefined);
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, byteLength));
        resolve(JSON.parse(text));
      } catch {
        reject(new InvalidJsonError());
      }
    });
    const onError = (error: Error): void => settle(() => reject(error));
    const onAborted = (): void => settle(() => reject(
      new DOMException("Client disconnected", "AbortError"),
    ));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
};

const writeNormalizedError = (
  response: ServerResponse,
  error: unknown,
): void => {
  if (error instanceof InvalidJsonError) {
    writeError(response, 400, {
      code: "invalid_json",
      message: "Request body must be valid JSON.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof RequestBodyTooLargeError) {
    writeError(response, 413, {
      code: "body_too_large",
      message: "Request body exceeds the one MiB limit.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof ApiRouteError) {
    writeError(response, error.statusCode, {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    });
    return;
  }

  if (error instanceof UnsupportedContentTypeError) {
    writeError(response, 415, {
      code: "unsupported_media_type",
      message: "Mutation request bodies must use application/json.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof ZodError) {
    writeError(response, 400, {
      code: "invalid_request",
      message: "The request did not pass validation.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof ImportApiError) {
    const rescanRequired = error.code === "import_rescan_required";
    writeError(response, rescanRequired ? 409 : 400, {
      code: error.code,
      message: rescanRequired
        ? "Repository evidence changed or is no longer valid. Scan again before applying."
        : "The repository selection could not be inspected.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof RelationshipAlreadyExistsError) {
    writeError(response, 409, {
      code: "conflict",
      message: "The requested change conflicts with existing data.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof ProjectNotFoundError || error instanceof RecordNotFoundError) {
    writeError(response, 404, {
      code: "not_found",
      message: "The requested resource was not found.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof InvalidTaskError) {
    writeError(response, 400, {
      code: "invalid_request",
      message: "The requested resource is not a task.",
      recoverable: true,
    });
    return;
  }

  if (error instanceof CoordinationError) {
    let stable = new CoordinationError("coordination_unavailable");
    try {
      stable = new CoordinationError(error.code);
    } catch {
      // Preserve the fixed unavailable error when an untrusted instance has
      // a hostile code accessor.
    }
    const status = stable.code === "coordination_unavailable"
      ? 503
      : stable.code === "coordination_authority_denied"
        ? 403
        : stable.code === "checkpoint_invalid" || stable.code === "submission_invalid"
          ? 400
          : 409;
    writeError(response, status, {
      code: stable.code,
      message: stable.message,
      recoverable: true,
    });
    return;
  }

  if (error instanceof GovernanceError) {
    if (error.code === "internal_error") {
      writeInternalError(response);
      return;
    }

    const conflict = error.code.endsWith("_conflict") ||
      error.code === "proposal_conflicted" ||
      error.code === "proposal_not_pending";
    writeError(response, conflict ? 409 : 400, {
      code: error.code,
      message: conflict
        ? "The request conflicts with the current state."
        : "The request did not pass domain validation.",
      recoverable: true,
    });
    return;
  }

  writeInternalError(response);
};

const writeInternalError = (response: ServerResponse): void => {
  writeError(response, 500, {
    code: "internal_error",
    message: "The request could not be completed.",
    recoverable: false,
  });
};

const writeError = (
  response: ServerResponse,
  statusCode: number,
  error: ApiErrorBody["error"],
): void => {
  writeJson(response, statusCode, { error });
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const serialized = JSON.stringify(value ?? null);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": API_RESPONSE_CONTENT_SECURITY_POLICY,
  });
  response.end(serialized);
};

const readMutationBody = async (request: IncomingMessage): Promise<unknown> => {
  const declaredLength = Number(request.headers["content-length"]);
  const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0) ||
    request.headers["transfer-encoding"] !== undefined;
  if (
    hasBody &&
    !isJsonContentType(request.headers["content-type"])
  ) {
    request.resume();
    throw new UnsupportedContentTypeError();
  }
  return readJsonBody(request);
};

const httpTokenSchema = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const isQuotedString = (value: string): boolean => {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === "\\") {
      index += 1;
      if (index >= value.length - 1) return false;
      const escaped = value.charCodeAt(index);
      if (escaped !== 0x09 && (escaped < 0x20 || escaped > 0x7e)) return false;
      continue;
    }
    if (
      code !== 0x09 &&
      !(code >= 0x20 && code <= 0x21) &&
      !(code >= 0x23 && code <= 0x5b) &&
      !(code >= 0x5d && code <= 0x7e)
    ) return false;
  }
  return true;
};

const isJsonContentType = (input: string | undefined): boolean => {
  if (input === undefined || /[\r\n]/.test(input)) return false;
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ";") {
      segments.push(input.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return false;
  segments.push(input.slice(start));
  if (segments.shift()?.trim().toLowerCase() !== "application/json") return false;
  return segments.every((rawParameter) => {
    const parameter = rawParameter.trim();
    const equals = parameter.indexOf("=");
    if (equals <= 0) return false;
    const name = parameter.slice(0, equals).trim();
    const value = parameter.slice(equals + 1).trim();
    return httpTokenSchema.test(name) &&
      (httpTokenSchema.test(value) || isQuotedString(value));
  });
};

const writeBinary = (
  response: ServerResponse,
  result: ApiBinaryResponse,
): void => {
  response.writeHead(200, {
    "content-type": result.contentType,
    "content-length": result.bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": API_RESPONSE_CONTENT_SECURITY_POLICY,
  });
  response.end(result.bytes);
};

const writeNdjson = async (
  request: IncomingMessage,
  response: ServerResponse,
  result: ApiNdjsonResponse,
  signal: AbortSignal,
): Promise<void> => {
  const begin = (): void => {
    if (response.headersSent) return;
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": API_RESPONSE_CONTENT_SECURITY_POLICY,
    });
    response.flushHeaders();
  };
  await result.run({
    signal,
    async write(value) {
      signal.throwIfAborted();
      begin();
      await writeWithBackpressure(
        request,
        response,
        signal,
        `${JSON.stringify(value)}\n`,
      );
    },
  });
  begin();
  if (!response.writableEnded) response.end();
};

const disconnectError = (): DOMException =>
  new DOMException("Client disconnected", "AbortError");

const requestLifecycle = (
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const abort = (reason: unknown = disconnectError()): void => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const onRequestClose = (): void => {
    if (request.aborted || !request.complete) abort();
  };
  const onRequestError = (error: Error): void => abort(error);
  const onResponseError = (error: Error): void => abort(error);
  request.once("aborted", abort);
  request.once("close", onRequestClose);
  request.once("error", onRequestError);
  response.once("close", abort);
  response.once("error", onResponseError);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      request.off("close", onRequestClose);
      request.off("error", onRequestError);
      response.off("close", abort);
      response.off("error", onResponseError);
    },
  };
};

export const writeWithBackpressure = async (
  request: Pick<IncomingMessage, "once" | "off" | "aborted" | "complete">,
  response: Pick<ServerResponse, "write" | "once" | "off">,
  signal: AbortSignal,
  chunk: string,
): Promise<void> => {
  signal.throwIfAborted();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onDisconnect);
      response.off("error", onError);
      request.off("aborted", onDisconnect);
      request.off("close", onRequestClose);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onDrain = (): void => settle(resolve);
    const onDisconnect = (): void => settle(() => reject(disconnectError()));
    const onRequestClose = (): void => {
      if (request.aborted || !request.complete) onDisconnect();
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onAbort = (): void => settle(() => reject(signal.reason ?? disconnectError()));
    response.once("drain", onDrain);
    response.once("close", onDisconnect);
    response.once("error", onError);
    request.once("aborted", onDisconnect);
    request.once("close", onRequestClose);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  signal.throwIfAborted();
};
