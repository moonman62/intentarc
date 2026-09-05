import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../../app/create-application.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../../test-support/database.js";
import { startWebServer, type RunningWebServer } from "./http-server.js";

describe("authenticated loopback HTTP server", () => {
  let temporaryDatabase: TemporaryDatabase;
  let staticRoot: string;
  let application: IntentArcApplication;
  let running: RunningWebServer | undefined;
  let activeSocket: Socket | undefined;

  beforeEach(() => {
    temporaryDatabase = createTemporaryDatabase();
    staticRoot = mkdtempSync(join(tmpdir(), "intentarc-http-static-"));
    writeFileSync(join(staticRoot, "index.html"), "<main>Local only</main>");
    writeFileSync(join(staticRoot, "app.js"), "export {};");
    application = createApplication({ databasePath: temporaryDatabase.path });
  });

  afterEach(async () => {
    activeSocket?.destroy();
    activeSocket = undefined;
    await running?.close();
    application.close();
    removeTemporaryDatabase(temporaryDatabase);
    rmSync(staticRoot, { recursive: true, force: true });
  });

  it("settles repeated close calls while an incomplete HTTP connection remains active", async () => {
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "active-connection-token",
      staticRoot,
    });
    const serverUrl = new URL(running.origin);
    const socket = connect({
      host: serverUrl.hostname,
      port: Number(serverUrl.port),
    });
    activeSocket = socket;
    await once(socket, "connect");
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${serverUrl.host}\r\n`,
    );
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("error", () => undefined);

    const firstClose = running.close();
    expect(running.close()).toBe(firstClose);

    await settleWithin(
      Promise.all([socketClosed, firstClose]),
      500,
      "The HTTP server did not close its active connection.",
    );
  });

  it("exchanges a launch key and authenticates real API and static requests", async () => {
    application.service.createProject({ name: "Loopback" });
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "deterministic-launch-token",
      staticRoot,
    });

    expect(running.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.launchUrl).toBe(
      `${running.origin}/?key=deterministic-launch-token`,
    );

    const unauthenticated = await fetch(`${running.origin}/api/projects`);
    expect(unauthenticated.status).toBe(401);

    const exchange = await fetch(running.launchUrl, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(exchange.headers.get("x-frame-options")).toBe("DENY");
    expect(exchange.headers.get("location")).toBe("/");
    const cookie = exchange.headers.get("set-cookie")!;
    expect(cookie).toContain(
      "intentarc_session=deterministic-launch-token; HttpOnly; SameSite=Strict; Path=/",
    );

    const authenticated = await fetch(`${running.origin}/api/projects`, {
      headers: { cookie },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(authenticated.headers.get("x-frame-options")).toBe("DENY");
    expect(await authenticated.json()).toMatchObject({
      projects: [{ project: { name: "Loopback" } }],
    });

    const staticResponse = await fetch(running.origin, {
      headers: { cookie },
    });
    expect(staticResponse.status).toBe(200);
    expect(staticResponse.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(staticResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(await staticResponse.text()).toBe("<main>Local only</main>");

    const staticAsset = await fetch(`${running.origin}/app.js`, {
      headers: { cookie },
    });
    expect(staticAsset.status).toBe(200);
    expect(staticAsset.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(staticAsset.headers.get("x-frame-options")).toBe("DENY");
    expect(await staticAsset.text()).toBe("export {};");

    const missingStatic = await fetch(`${running.origin}/assets/missing.js`, {
      headers: { cookie },
    });
    expect(missingStatic.status).toBe(404);
    expect(missingStatic.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(missingStatic.headers.get("x-frame-options")).toBe("DENY");
  });

  it("exposes only the minimal unauthenticated health response", async () => {
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "health-token",
      staticRoot,
    });

    const response = await fetch(`${running.origin}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("uses the strict API CSP for documentation errors rejected before routing", async () => {
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "document-boundary-token",
      staticRoot,
    });
    const documentUrl =
      `${running.origin}/api/projects/project-1/documents/node-1`;

    const unauthenticated = await fetch(documentUrl);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );

    const exchange = await fetch(running.launchUrl, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")!;
    const forbiddenMutation = await fetch(documentUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: "{}",
    });
    expect(forbiddenMutation.status).toBe(403);
    expect(forbiddenMutation.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );
  });

  it("requires the exact allowed loopback origin for mutations", async () => {
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "mutation-token",
      staticRoot,
    });
    const exchange = await fetch(running.launchUrl, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")!;
    const body = JSON.stringify({
      name: "Mutation",
      primaryRepositoryPath: null,
    });

    const missingOrigin = await fetch(`${running.origin}/api/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(missingOrigin.status).toBe(403);

    const hostileOrigin = await fetch(`${running.origin}/api/projects`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body,
    });
    expect(hostileOrigin.status).toBe(403);

    const allowed = await fetch(`${running.origin}/api/projects`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: running.origin,
      },
      body,
    });
    expect(allowed.status).toBe(200);
  });

  it("requires the exact allowed loopback origin for idea capture", async () => {
    const project = application.service.createProject({ name: "Ideas" });
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "idea-mutation-token",
      staticRoot,
    });
    const exchange = await fetch(running.launchUrl, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")!;
    const url = `${running.origin}/api/projects/${project.id}/ideas`;
    const body = JSON.stringify({
      expectedProjectRevision: project.revision,
      captureRequestId: "capture-request-1",
      text: "Origin-bound idea",
    });

    for (const origin of [undefined, "http://evil.example"]) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          ...(origin === undefined ? {} : { origin }),
        },
        body,
      });
      expect(response.status).toBe(403);
    }

    const allowed = await fetch(url, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: running.origin,
      },
      body,
    });
    expect(allowed.status).toBe(201);
  });

  it.each([
    "http://localhost:5173",
    "http://0.0.0.0:5173",
    "https://127.0.0.1:5173",
    "http://*.example:5173",
  ])("rejects non-exact loopback development origin %s", async (origin) => {
    await expect(startWebServer({
      application,
      port: 0,
      sessionToken: "origin-token",
      staticRoot,
      allowedMutationOrigins: [origin],
    })).rejects.toThrow("loopback HTTP origin");
  });

  it("accepts an explicit 127.0.0.1 development origin for mutations", async () => {
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "dev-token",
      staticRoot,
      allowedMutationOrigins: ["http://127.0.0.1:5173"],
    });
    const exchange = await fetch(running.launchUrl, { redirect: "manual" });

    const response = await fetch(`${running.origin}/api/projects`, {
      method: "POST",
      headers: {
        cookie: exchange.headers.get("set-cookie")!,
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({
        name: "Vite",
        primaryRepositoryPath: null,
      }),
    });

    expect(response.status).toBe(200);
  });

  it("serves the strict packaged desktop content security policy", async () => {
    const desktopPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    running = await startWebServer({
      application,
      port: 0,
      sessionToken: "desktop-policy-token",
      staticRoot,
      contentSecurityPolicy: desktopPolicy,
    });
    const exchange = await fetch(running.launchUrl, { redirect: "manual" });
    const response = await fetch(running.origin, {
      headers: { cookie: exchange.headers.get("set-cookie")! },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(desktopPolicy);
  });
});

const settleWithin = async <T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};
