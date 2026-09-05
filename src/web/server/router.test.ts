import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { AddressInfo } from "node:net";
import { ZodError } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinationError,
  GovernanceError,
  RelationshipAlreadyExistsError,
} from "../../domain/index.js";
import {
  API_RESPONSE_CONTENT_SECURITY_POLICY,
  ApiJsonResponse,
  createApiHandler,
  writeWithBackpressure,
  type ApiRoute,
} from "./router.js";

describe("API router", () => {
  const openServers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }),
    ));
  });

  const start = async (routes: ApiRoute[]): Promise<string> => {
    const server = createServer(createApiHandler(routes));
    openServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  };

  it("matches the exact method and exposes decoded named route parameters", async () => {
    const origin = await start([{
      method: "GET",
      pattern: /^\/api\/projects\/(?<projectId>[^/]+)$/,
      handle: ({ match }) => ({
        projectId: decodeURIComponent(match.groups!.projectId!),
      }),
    }]);

    const response = await fetch(`${origin}/api/projects/project%20one`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId: "project one" });

    const wrongMethod = await fetch(`${origin}/api/projects/project%20one`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(404);
  });

  it("writes an explicit successful JSON status with every safe API header", async () => {
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/created$/,
      handle: () => new ApiJsonResponse(201, { created: true }),
    }]);

    const response = await fetch(`${origin}/api/created`, { method: "POST" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy"))
      .toBe(API_RESPONSE_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([199, 300, 200.5])(
    "rejects unsafe explicit API JSON success status %s",
    (statusCode) => {
      expect(() => new ApiJsonResponse(statusCode, null))
        .toThrow("API JSON success status must be 2xx");
    },
  );

  it("returns 400 for invalid JSON without invoking the route", async () => {
    let calls = 0;
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/projects$/,
      handle: () => {
        calls += 1;
        return {};
      },
    }]);

    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON.",
        recoverable: true,
      },
    });
    expect(calls).toBe(0);
  });

  it("rejects invalid UTF-8 coordination JSON before schema or service work", async () => {
    let calls = 0;
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/coordination-mutation$/,
      handle: () => ({ calls: ++calls }),
    }]);
    const prefix = Buffer.from('{"value":"', "utf8");
    const suffix = Buffer.from('"}', "utf8");
    const body = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);

    const response = await fetch(`${origin}/api/coordination-mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON.",
        recoverable: true,
      },
    });
    expect(calls).toBe(0);
  });

  it("returns 413 for bodies over one MiB without invoking the route", async () => {
    let calls = 0;
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/projects$/,
      handle: () => {
        calls += 1;
        return {};
      },
    }]);

    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "body_too_large", recoverable: true },
    });
    expect(calls).toBe(0);
  });

  it("rejects an oversized chunked coordination body before arbitrary EOF", async () => {
    let calls = 0;
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/coordination-mutation$/,
      handle: () => ({ calls: ++calls }),
    }]);
    const target = new URL(`${origin}/api/coordination-mutation`);
    let request: ReturnType<typeof httpRequest> | undefined;
    const responsePromise = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      request.once("error", reject);
      request.write(Buffer.alloc(1_048_577, 0x78));
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("oversized chunked request waited for EOF")),
            1_000,
          );
        }),
      ]);
      expect(result.status).toBe(413);
      expect(result.body).toMatchObject({ error: { code: "body_too_large" } });
      expect(calls).toBe(0);
    } finally {
      if (timeout) clearTimeout(timeout);
      request?.destroy();
    }
  });

  it("accepts exactly application/json with valid parameters and rejects lookalikes", async () => {
    let calls = 0;
    const origin = await start([{
      method: "POST",
      pattern: /^\/api\/strict-json$/,
      handle: () => ({ calls: ++calls }),
    }]);
    for (const contentType of [
      "application/json",
      "Application/JSON; charset=utf-8",
      "application/json; profile=reviewed; note=\"quoted value\"",
    ]) {
      const response = await fetch(`${origin}/api/strict-json`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: "{}",
      });
      expect(response.status).toBe(200);
    }
    for (const contentType of [
      "application/jsonp",
      "application/json-patch+json",
      "application/json; charset",
      "application/json; =utf-8",
      "application/json; note=\"unterminated",
      "application/json; note=bad value",
    ]) {
      const response = await fetch(`${origin}/api/strict-json`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: "{}",
      });
      expect(response.status, contentType).toBe(415);
    }
    expect(calls).toBe(3);
  });

  it("rejects backpressured writes on close and removes every waiter", async () => {
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), {
      write: () => false,
    });
    const pending = writeWithBackpressure(
      request as never,
      response as never,
      new AbortController().signal,
      "{\"type\":\"progress\"}\n",
    );

    response.emit("close");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (const event of ["drain", "close", "error"]) {
      expect(response.listenerCount(event), `response ${event}`).toBe(0);
    }
    for (const event of ["aborted", "close", "error"]) {
      expect(request.listenerCount(event), `request ${event}`).toBe(0);
    }
  });

  it.each([
    {
      label: "Zod validation",
      error: new ZodError([{
        code: "custom",
        path: ["name"],
        message: "Database token should never be echoed",
      }]),
      status: 400,
      code: "invalid_request",
    },
    {
      label: "domain validation",
      error: new GovernanceError(
        "validation_failed",
        "Sensitive domain detail",
      ),
      status: 400,
      code: "validation_failed",
    },
    {
      label: "domain conflict",
      error: new RelationshipAlreadyExistsError("a", "b", "related_to"),
      status: 409,
      code: "conflict",
    },
  ])("normalizes $label errors without exposing their details", async ({
    error,
    status,
    code,
  }) => {
    const origin = await start([{
      method: "GET",
      pattern: /^\/api\/failure$/,
      handle: () => {
        throw error;
      },
    }]);

    const response = await fetch(`${origin}/api/failure`);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(status);
    expect(serialized).toContain(`"code":"${code}"`);
    expect(serialized).not.toContain(error.message);
  });

  it.each([
    ["checkpoint_invalid", 400],
    ["coordination_authority_denied", 403],
    ["claim_conflict", 409],
    ["coordination_unavailable", 503],
  ] as const)("maps coordination error %s to its stable HTTP status", async (code, status) => {
    const origin = await start([{
      method: "GET",
      pattern: /^\/api\/coordination-failure$/,
      handle: () => { throw new CoordinationError(code); },
    }]);

    const response = await fetch(`${origin}/api/coordination-failure`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: {
        code,
        message: new CoordinationError(code).message,
        recoverable: true,
      },
    });
  });

  it("reconstructs coordination errors without disclosing mutable fields", async () => {
    const tainted = new CoordinationError("claim_conflict");
    tainted.message = "private-token C:\\private\\coordination.sqlite";
    Object.defineProperty(tainted, "code", {
      enumerable: true,
      get() { return "claim_conflict"; },
    });
    const origin = await start([{
      method: "GET",
      pattern: /^\/api\/coordination-failure$/,
      handle: () => { throw tainted; },
    }]);

    const response = await fetch(`${origin}/api/coordination-failure`);
    const text = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "claim_conflict",
        message: "Task claim conflicts with current coordination state.",
        recoverable: true,
      },
    });
    expect(text).not.toMatch(/private-token|coordination\.sqlite/i);
  });

  it("returns a generic 500 response with no stack, path, or failure detail", async () => {
    const origin = await start([{
      method: "GET",
      pattern: /^\/api\/failure$/,
      handle: () => {
        throw new Error("secret at C:\\private\\database.sqlite");
      },
    }]);

    const response = await fetch(`${origin}/api/failure`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        recoverable: false,
      },
    });
    expect(body).not.toContain("database.sqlite");
    expect(body).not.toContain("router.test");
  });
});
