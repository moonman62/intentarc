import {
  InMemoryTransport,
  type InMemoryTransport as InMemoryTransportInstance,
} from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../app/create-application.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import { DurabilityError } from "../durability/errors.js";
import type { AuthenticatedProfile } from "../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../test-support/database.js";
import { runIntentArcMcp } from "./bin.js";
import { createIntentArcMcpServer } from "./server.js";

describe("IntentArc MCP profile authentication", () => {
  let temporaryDatabase: TemporaryDatabase | undefined;
  let application: IntentArcApplication | undefined;
  let peerTransport: InMemoryTransportInstance | undefined;
  let runtimeTransport: InMemoryTransportInstance | undefined;

  afterEach(async () => {
    await peerTransport?.close();
    await runtimeTransport?.close();
    application?.close();

    if (temporaryDatabase) {
      removeTemporaryDatabase(temporaryDatabase);
    }
  });

  const openApplication = (): IntentArcApplication => {
    temporaryDatabase = createTemporaryDatabase();
    application = createApplication({ databasePath: temporaryDatabase.path });
    return application;
  };

  const linkedRuntimeTransport = (): InMemoryTransportInstance => {
    [peerTransport, runtimeTransport] = InMemoryTransport.createLinkedPair();
    return runtimeTransport;
  };

  it.each([
    { label: "absent", credentials: {} },
    {
      label: "whitespace-only",
      credentials: {
        INTENTARC_PROFILE_ID: " \t ",
        INTENTARC_PROFILE_TOKEN: "\n ",
      },
    },
  ])("authenticates null and constructs an anonymous server when credentials are $label", async ({
    credentials,
  }) => {
    const actualApplication = openApplication();
    const authenticate = vi.spyOn(
      actualApplication.service.profiles,
      "authenticate",
    );
    const principals: Array<AuthenticatedProfile | null> = [];
    let closes = 0;
    let diagnostics = "";

    await runIntentArcMcp({
      environment: {
        INTENTARC_DB_PATH: temporaryDatabase!.path,
        ...credentials,
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: () => undefined,
      openApplication: async () => ({
        service: actualApplication.service,
        close: () => {
          closes += 1;
          actualApplication.close();
        },
      }),
      createServer: (
        service: IntentArcService,
        principal: AuthenticatedProfile | null,
      ): McpServer => {
        principals.push(principal);
        return createIntentArcMcpServer(service, principal);
      },
      createTransport: linkedRuntimeTransport,
    });

    expect(authenticate).toHaveBeenCalledExactlyOnceWith(null);
    expect(principals).toEqual([null]);
    expect(diagnostics).toBe("");

    await runtimeTransport!.close();
    await new Promise<void>((complete) => setImmediate(complete));
    expect(closes).toBe(1);
  });

  it("trims valid credentials, authenticates once, and passes only the principal into server construction", async () => {
    const actualApplication = openApplication();
    const created = actualApplication.service.profiles.createProfile({
      name: "MCP agent",
    });
    const authenticate = vi.spyOn(
      actualApplication.service.profiles,
      "authenticate",
    );
    const principals: Array<AuthenticatedProfile | null> = [];
    let diagnostics = "";

    await runIntentArcMcp({
      environment: {
        INTENTARC_DB_PATH: temporaryDatabase!.path,
        INTENTARC_PROFILE_ID: `  ${created.profile.id} `,
        INTENTARC_PROFILE_TOKEN: ` ${created.token}\t`,
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: () => undefined,
      openApplication: async () => actualApplication,
      createServer: (
        service: IntentArcService,
        principal: AuthenticatedProfile | null,
      ): McpServer => {
        principals.push(principal);
        return createIntentArcMcpServer(service, principal);
      },
      createTransport: linkedRuntimeTransport,
    });

    expect(authenticate).toHaveBeenCalledExactlyOnceWith({
      profileId: created.profile.id,
      token: created.token,
    });
    expect(principals).toEqual([{
      id: created.profile.id,
      name: "MCP agent",
      status: "enabled",
      credentialGeneration: created.profile.tokenRotatedAt,
    }]);
    expect(diagnostics).toBe("");
    expect(diagnostics).not.toContain(created.token);

    await runtimeTransport!.close();
  });

  it("uses explicitly supplied archive and credentials without reading CLI environment variables", async () => {
    const actualApplication = openApplication();
    const created = actualApplication.service.profiles.createProfile({
      name: "Desktop bridge",
    });
    const authenticate = vi.spyOn(
      actualApplication.service.profiles,
      "authenticate",
    );
    const openedPaths: string[] = [];
    const startupOrder: string[] = [];
    let diagnostics = "";

    await runIntentArcMcp({
      databasePath: temporaryDatabase!.path,
      credentials: {
        profileId: ` ${created.profile.id} `,
        profileToken: `\t${created.token}\n`,
      },
      environment: {},
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: () => undefined,
      onCredentialsConsumed: () => {
        startupOrder.push("credentials-consumed");
      },
      openApplication: async ({ databasePath }) => {
        openedPaths.push(databasePath);
        return actualApplication;
      },
      createServer: (
        service: IntentArcService,
        principal: AuthenticatedProfile | null,
      ): McpServer => {
        startupOrder.push("server-created");
        return createIntentArcMcpServer(service, principal);
      },
      createTransport: linkedRuntimeTransport,
    });

    expect(openedPaths).toEqual([temporaryDatabase!.path]);
    expect(authenticate).toHaveBeenCalledExactlyOnceWith({
      profileId: created.profile.id,
      token: created.token,
    });
    expect(startupOrder).toEqual([
      "credentials-consumed",
      "server-created",
    ]);
    expect(diagnostics).toBe("");

    await runtimeTransport!.close();
  });

  it.each([
    {
      label: "stdin close",
      trigger: (signals: EventEmitter, stdin: EventEmitter) => {
        stdin.emit("close");
      },
    },
    {
      label: "SIGTERM",
      trigger: (signals: EventEmitter, stdin: EventEmitter) => {
        signals.emit("SIGTERM");
      },
    },
  ])("notifies the headless lifecycle once after $label closes MCP resources", async ({
    trigger,
  }) => {
    const actualApplication = openApplication();
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const exitCodes: number[] = [];
    let closes = 0;

    await runIntentArcMcp({
      databasePath: temporaryDatabase!.path,
      signalSource: signals,
      stdin,
      setExitCode: () => undefined,
      openApplication: async () => ({
        service: actualApplication.service,
        close: () => {
          closes += 1;
          actualApplication.close();
        },
      }),
      createTransport: linkedRuntimeTransport,
      onShutdown: async (exitCode) => {
        exitCodes.push(exitCode);
      },
    });

    trigger(signals, stdin);
    await new Promise<void>((complete) => setImmediate(complete));

    expect(closes).toBe(1);
    expect(exitCodes).toEqual([0]);

    stdin.emit("close");
    signals.emit("SIGTERM");
    await new Promise<void>((complete) => setImmediate(complete));
    expect(exitCodes).toEqual([0]);
  });

  it.each([
    {
      label: "partial",
      prepare: (service: IntentArcService) => {
        const created = service.profiles.createProfile({ name: "Partial" });
        return {
          environment: {
            INTENTARC_PROFILE_ID: created.profile.id,
            INTENTARC_PROFILE_TOKEN: " \t ",
          },
          code: "profile_required",
          secret: created.profile.id,
        };
      },
    },
    {
      label: "invalid",
      prepare: (service: IntentArcService) => {
        const created = service.profiles.createProfile({ name: "Invalid" });
        return {
          environment: {
            INTENTARC_PROFILE_ID: created.profile.id,
            INTENTARC_PROFILE_TOKEN: "wrong-secret-token",
          },
          code: "invalid_profile_credentials",
          secret: "wrong-secret-token",
        };
      },
    },
    {
      label: "disabled",
      prepare: (service: IntentArcService) => {
        const created = service.profiles.createProfile({ name: "Disabled" });
        service.profiles.setEnabled(created.profile.id, false);
        return {
          environment: {
            INTENTARC_PROFILE_ID: created.profile.id,
            INTENTARC_PROFILE_TOKEN: created.token,
          },
          code: "profile_disabled",
          secret: created.token,
        };
      },
    },
  ])("fails startup safely for $label credentials without constructing a server", async ({
    prepare,
  }) => {
    const actualApplication = openApplication();
    const configured = prepare(actualApplication.service);
    let applicationCreations = 0;
    let applicationCloses = 0;
    let serverCreations = 0;
    let transportCreations = 0;
    let exitCode: number | undefined;
    let diagnostics = "";

    await runIntentArcMcp({
      environment: {
        INTENTARC_DB_PATH: temporaryDatabase!.path,
        ...configured.environment,
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: (code) => {
        exitCode = code;
      },
      openApplication: async () => {
        applicationCreations += 1;
        return {
          service: actualApplication.service,
          close: () => {
            applicationCloses += 1;
            actualApplication.close();
          },
        };
      },
      createServer: () => {
        serverCreations += 1;
        throw new Error("Server must not be created");
      },
      createTransport: () => {
        transportCreations += 1;
        throw new Error("Transport must not be created");
      },
    });

    expect(applicationCreations).toBe(1);
    expect(applicationCloses).toBe(1);
    expect(serverCreations).toBe(0);
    expect(transportCreations).toBe(0);
    expect(exitCode).toBe(1);
    expect(diagnostics).toBe(`${configured.code}\n`);
    expect(diagnostics).not.toContain(configured.secret);
  });

  it.each([
    {
      label: "durability",
      error: new DurabilityError("migration_failed", {
        originalSchemaVersion: 2,
        requestedSchemaVersion: 3,
        transactionPreserved: true,
        recoveryAction: "restore_verified_backup",
      }),
      diagnostic: "migration_failed\n",
    },
    {
      label: "unexpected",
      error: new Error("sensitive preparation failure"),
      diagnostic: "IntentArc MCP failed to start.\n",
    },
  ])("sanitizes $label preparation failures before MCP resources exist", async ({
    error,
    diagnostic,
  }) => {
    let serverCreations = 0;
    let transportCreations = 0;
    let exitCode: number | undefined;
    let diagnostics = "";

    await runIntentArcMcp({
      environment: {
        INTENTARC_DB_PATH: temporaryDatabase?.path ?? "intentarc.sqlite",
      },
      stderr: {
        write: (message) => {
          diagnostics += message;
        },
      },
      signalSource: new EventEmitter(),
      stdin: new EventEmitter(),
      setExitCode: (code) => {
        exitCode = code;
      },
      openApplication: async () => {
        throw error;
      },
      createServer: () => {
        serverCreations += 1;
        throw new Error("Server must not be created");
      },
      createTransport: () => {
        transportCreations += 1;
        throw new Error("Transport must not be created");
      },
    });

    expect(serverCreations).toBe(0);
    expect(transportCreations).toBe(0);
    expect(exitCode).toBe(1);
    expect(diagnostics).toBe(diagnostic);
    expect(diagnostics).not.toContain("sensitive preparation failure");
    expect(diagnostics).not.toContain("Store migration failed.");
  });
});
