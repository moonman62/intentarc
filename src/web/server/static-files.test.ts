import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveStaticFile } from "./static-files.js";

describe("static file containment", () => {
  let directory: string;
  let staticRoot: string;
  let origin: string;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "intentarc-static-"));
    staticRoot = join(directory, "web-client");
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<main>IntentArc</main>");
    writeFileSync(join(staticRoot, "assets", "app.js"), "export {};");
    writeFileSync(join(directory, "secret"), "must not be served");

    server = createServer((incoming, response) => {
      void serveStaticFile({
        staticRoot,
        requestedPath: incoming.url ?? "/",
      }, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const rawGet = (path: string): Promise<{
    status: number;
    body: string;
    contentType: string | undefined;
    headers: import("node:http").IncomingHttpHeaders;
  }> => new Promise((resolve, reject) => {
    const address = server.address() as AddressInfo;
    const outgoing = request({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: "GET",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode!,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: response.headers["content-type"],
        headers: response.headers,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

  it("serves an asset resolved beneath the configured absolute root", async () => {
    const response = await fetch(`${origin}/assets/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(await response.text()).toBe("export {};");
  });

  it("rejects traversal outside the configured static root", async () => {
    const response = await rawGet("/../../secret");

    expect(response.status).toBe(400);
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(response.body).not.toContain("must not be served");
  });

  it("serves index.html for extensionless client routes", async () => {
    const response = await fetch(`${origin}/projects/project-1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toBe("<main>IntentArc</main>");
  });

  it("returns 404 instead of index.html for a missing hashed asset", async () => {
    const response = await fetch(`${origin}/assets/app-deadbeef.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<main>");
  });
});
