// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, apiRequest } from "./api.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  test("sends JSON requests with same-origin credentials", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ project: { id: "project-one" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchStub);

    const result = await apiRequest<{ project: { id: string } }>(
      "/api/projects",
      { method: "POST", body: JSON.stringify({ name: "One" }) },
    );

    expect(result.project.id).toBe("project-one");
    expect(fetchStub).toHaveBeenCalledWith("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "One" }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
  });

  test("throws the server's typed error contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "Project not found",
          recoverable: true,
        },
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const error = await apiRequest("/api/projects/missing")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("PROJECT_NOT_FOUND");
    expect((error as ApiError).message).toBe("Project not found");
    expect((error as ApiError).recoverable).toBe(true);
    expect((error as ApiError).status).toBe(404);
  });

  test("adds coordination credentials to exactly one request without changing its URL", async () => {
    const fetchStub = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    vi.stubGlobal("fetch", fetchStub);

    await apiRequest(
      "/api/projects/project-1/coordination/ready?limit=20",
      {},
      { profileId: "profile-1", token: "private-token" },
    );
    await apiRequest("/api/projects");

    const [firstPath, firstInit] = fetchStub.mock.calls[0]!;
    const firstHeaders = new Headers((firstInit as RequestInit).headers);
    expect(firstPath).toBe(
      "/api/projects/project-1/coordination/ready?limit=20",
    );
    expect(firstHeaders.get("X-IntentArc-Profile-Id")).toBe("profile-1");
    expect(firstHeaders.get("Authorization")).toBe("Bearer private-token");
    const secondHeaders = new Headers(
      (fetchStub.mock.calls[1]![1] as RequestInit).headers,
    );
    expect(secondHeaders.has("X-IntentArc-Profile-Id")).toBe(false);
    expect(secondHeaders.has("Authorization")).toBe(false);
  });

  test.each([
    ["object", {
      Authorization: "Bearer attacker-token",
      "X-IntentArc-Profile-Id": "attacker-profile",
      "X-Custom": "object-value",
    }],
    ["tuples", [
      ["Authorization", "Bearer attacker-token"],
      ["X-IntentArc-Profile-Id", "attacker-profile"],
      ["X-Custom", "tuple-value"],
    ]],
    ["Headers", new Headers({
      Authorization: "Bearer attacker-token",
      "X-IntentArc-Profile-Id": "attacker-profile",
      "X-Custom": "headers-value",
    })],
  ] satisfies Array<[string, HeadersInit]>) (
    "overwrites protected coordination headers and preserves custom headers for %s input",
    async (_label, headers) => {
      const fetchStub = vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));
      vi.stubGlobal("fetch", fetchStub);

      await apiRequest(
        "/api/projects/project-safe/coordination/ready",
        { headers },
        { profileId: "profile-safe", token: "token-safe" },
      );

      const [path, requestInit] = fetchStub.mock.calls[0]!;
      const requestHeaders = new Headers((requestInit as RequestInit).headers);
      expect(path).toBe("/api/projects/project-safe/coordination/ready");
      expect(requestHeaders.get("Authorization")).toBe("Bearer token-safe");
      expect(requestHeaders.get("X-IntentArc-Profile-Id")).toBe("profile-safe");
      expect(requestHeaders.get("X-Custom")).toMatch(/^(object|tuple|headers)-value$/);
      expect(JSON.stringify(requestInit)).not.toContain("attacker-token");
      expect(JSON.stringify(requestInit)).not.toContain("attacker-profile");
    },
  );

  test("does not disclose coordination credentials through API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          code: "coordination_authority_denied",
          message: "Coordination authority is denied.",
          recoverable: true,
        },
      }), { status: 403, headers: { "Content-Type": "application/json" } }),
    ));

    const error = await apiRequest(
      "/api/projects/project-1/coordination/ready",
      {},
      { profileId: "profile-private", token: "token-private" },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error)).not.toContain("profile-private");
    expect(JSON.stringify(error)).not.toContain("token-private");
    expect(String(error)).not.toContain("token-private");
  });
});
