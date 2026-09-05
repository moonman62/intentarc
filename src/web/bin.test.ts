import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { runIntentArcWeb } from "./bin.js";
import {
  startWebServer,
  type RunningWebServer,
} from "./server/http-server.js";

describe("IntentArc web binary", () => {
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => {
    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  it("starts on loopback and prints one safe JSON startup line with the launch URL", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const seed = createApplication({ databasePath: temporaryDatabase.path });
    seed.service.createProject({ name: "database-content-must-stay-private" });
    const profile = seed.service.profiles.createProfile({ name: "Local agent" });
    seed.close();

    const signals = new EventEmitter();
    let stdout = "";
    let stderr = "";
    const closed = Promise.withResolvers<void>();

    await runIntentArcWeb({
      argv: ["--db", temporaryDatabase.path, "--port", "0"],
      stdout: { write: (message) => { stdout += message; } },
      stderr: { write: (message) => { stderr += message; } },
      signalSource: signals,
      setExitCode: () => undefined,
      sessionToken: "deterministic-web-launch-token",
      openApplication: async ({ databasePath }) =>
        createApplication({ databasePath }),
      startServer: async (options) => {
        const actual = await startWebServer(options);
        return {
          ...actual,
          async close(): Promise<void> {
            await actual.close();
            closed.resolve();
          },
        };
      },
    });

    const line = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      event: "intentarc_web_started",
      host: "127.0.0.1",
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/\?key=deterministic-web-launch-token$/,
      ),
    });
    expect(line.port).toEqual(expect.any(Number));
    expect(stdout.split("\n")).toHaveLength(2);
    expect(stdout).not.toContain("database-content-must-stay-private");
    expect(stdout).not.toContain(profile.token);
    expect(stderr).toBe("");

    signals.emit("SIGINT");
    await closed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("requires --db without opening application resources", async () => {
    let applicationOpens = 0;
    let exitCode: number | undefined;
    let stderr = "";

    await runIntentArcWeb({
      argv: [],
      stdout: { write: () => undefined },
      stderr: { write: (message) => { stderr += message; } },
      signalSource: new EventEmitter(),
      setExitCode: (code) => { exitCode = code; },
      openApplication: async () => {
        applicationOpens += 1;
        throw new Error("must not open");
      },
    });

    expect(applicationOpens).toBe(0);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("required option '--db <path>'");
  });

  it("parses repeatable development origins and the requested port", async () => {
    const signals = new EventEmitter();
    const calls: Array<{
      port: number | undefined;
      origins: string[] | undefined;
    }> = [];

    await runIntentArcWeb({
      argv: [
        "--db", "relative.sqlite",
        "--port", "49000",
        "--dev-origin", "http://127.0.0.1:5173",
        "--dev-origin", "http://127.0.0.1:5174",
      ],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      signalSource: signals,
      setExitCode: () => undefined,
      sessionToken: "options-token",
      openApplication: async () => ({
        service: {} as IntentArcApplication["service"],
        close: () => undefined,
      }),
      startServer: async (options) => {
        calls.push({
          port: options.port,
          origins: options.allowedMutationOrigins,
        });
        return {
          origin: "http://127.0.0.1:49000",
          launchUrl: "http://127.0.0.1:49000/?key=options-token",
          close: async () => undefined,
        };
      },
    });

    expect(calls).toEqual([{
      port: 49_000,
      origins: [
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
      ],
    }]);
    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("closes the HTTP server and application only once across both signals", async () => {
    const signals = new EventEmitter();
    let serverCloses = 0;
    let applicationCloses = 0;

    await runIntentArcWeb({
      argv: ["--db", "intentarc.sqlite"],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      signalSource: signals,
      setExitCode: () => undefined,
      openApplication: async () => ({
        service: {} as IntentArcApplication["service"],
        close: () => { applicationCloses += 1; },
      }),
      startServer: async (): Promise<RunningWebServer> => ({
        origin: "http://127.0.0.1:47861",
        launchUrl: "http://127.0.0.1:47861/?key=hidden",
        close: async () => { serverCloses += 1; },
      }),
    });

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(serverCloses).toBe(1);
    expect(applicationCloses).toBe(1);
  });

  it("sanitizes unexpected startup failures", async () => {
    let stderr = "";
    let exitCode: number | undefined;

    await runIntentArcWeb({
      argv: ["--db", "private.sqlite"],
      stdout: { write: () => undefined },
      stderr: { write: (message) => { stderr += message; } },
      signalSource: new EventEmitter(),
      setExitCode: (code) => { exitCode = code; },
      openApplication: async () => {
        throw new Error("secret profile token at C:\\private.sqlite");
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toBe("IntentArc web failed to start.\n");
    expect(stderr).not.toContain("profile token");
    expect(stderr).not.toContain("private.sqlite");
  });
});
