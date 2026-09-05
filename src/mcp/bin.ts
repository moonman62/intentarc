#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  openIntentArcApplication,
  type CreateApplicationOptions,
  type IntentArcApplication,
} from "../app/create-application.js";
import type { IntentArcService } from "../core/intentarc-service.js";
import { DurabilityError } from "../durability/errors.js";
import {
  GovernanceError,
  type AuthenticatedProfile,
} from "../domain/index.js";
import { isMainModule } from "../system/main-module.js";
import { createIntentArcMcpServer } from "./server.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface DiagnosticWriter {
  write(message: string): unknown;
}

interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

type StdinLifecycleEvent = "end" | "close";

interface StdinSource {
  once(event: StdinLifecycleEvent, listener: () => void): unknown;
  off(event: StdinLifecycleEvent, listener: () => void): unknown;
}

export interface McpCredentials {
  profileId: string;
  profileToken: string;
}

export interface RunIntentArcMcpOptions {
  databasePath?: string;
  credentials?: McpCredentials;
  onCredentialsConsumed?: () => void;
  onShutdown?: (exitCode: number) => void | Promise<void>;
  environment?: Partial<Record<string, string | undefined>>;
  stderr?: DiagnosticWriter;
  signalSource?: SignalSource;
  stdin?: StdinSource;
  setExitCode?: (code: number) => void;
  openApplication?: (
    options: CreateApplicationOptions,
  ) => Promise<IntentArcApplication>;
  createServer?: (
    service: IntentArcService,
    principal: AuthenticatedProfile | null,
  ) => McpServer;
  createTransport?: () => Transport;
}

export const runIntentArcMcp = async ({
  databasePath,
  credentials,
  onCredentialsConsumed,
  onShutdown,
  environment = process.env,
  stderr = process.stderr,
  signalSource = process,
  stdin = process.stdin,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  openApplication = openIntentArcApplication,
  createServer = createIntentArcMcpServer,
  createTransport = () => new StdioServerTransport(),
}: RunIntentArcMcpOptions = {}): Promise<void> => {
  let requestedExitCode: number | undefined;
  let shutdownNotified = false;
  const requestExitCode = (code: number): void => {
    requestedExitCode = code;
    setExitCode(code);
  };
  const notifyShutdown = async (): Promise<void> => {
    if (shutdownNotified) return;
    shutdownNotified = true;
    await onShutdown?.(requestedExitCode ?? 0);
  };
  const configuredDatabasePath = databasePath?.trim() || environment.INTENTARC_DB_PATH?.trim();

  if (!configuredDatabasePath) {
    stderr.write("INTENTARC_DB_PATH is required.\n");
    requestExitCode(1);
    await notifyShutdown();
    return;
  }

  let application: IntentArcApplication | undefined;
  let server: McpServer | undefined;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | undefined;
  const preparationSettled = Promise.withResolvers<void>();
  let authenticationFailureCode:
    | "profile_required"
    | "invalid_profile_credentials"
    | "profile_disabled"
    | undefined;

  const reportShutdownFailure = (): void => {
    stderr.write("IntentArc MCP failed to close.\n");
    requestExitCode(1);
  };
  const onSignal = (): void => {
    void shutdown().catch(reportShutdownFailure);
  };
  const onStdinClosed = (): void => {
    void shutdown().catch(reportShutdownFailure);
  };
  const removeShutdownListeners = (): void => {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
    stdin.off("end", onStdinClosed);
    stdin.off("close", onStdinClosed);
  };
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownRequested = true;
    removeShutdownListeners();
    shutdownPromise = (async () => {
      await preparationSettled.promise;
      let shutdownError: unknown;

      try {
        await server?.close();
      } catch (error) {
        shutdownError = error;
      }

      try {
        application?.close();
      } catch (error) {
        shutdownError ??= error;
      }

      if (shutdownError) requestExitCode(1);
      await notifyShutdown();

      if (shutdownError) {
        throw shutdownError;
      }
    })();

    return shutdownPromise;
  };

  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);
  stdin.once("end", onStdinClosed);
  stdin.once("close", onStdinClosed);

  try {
    try {
      application = await openApplication({
        databasePath: resolve(configuredDatabasePath),
      });
    } finally {
      preparationSettled.resolve();
    }

    if (shutdownRequested) {
      try {
        await shutdown();
      } catch {
        // The lifecycle listener reports shutdown failures.
      }
      return;
    }

    let presentedProfileId = credentials?.profileId;
    let presentedProfileToken = credentials?.profileToken;
    if (!credentials) {
      presentedProfileId = environment.INTENTARC_PROFILE_ID;
      presentedProfileToken = environment.INTENTARC_PROFILE_TOKEN;
    }
    let principal: AuthenticatedProfile | null;
    try {
      presentedProfileId = presentedProfileId?.trim();
      presentedProfileToken = presentedProfileToken?.trim();
      principal = application.service.profiles.authenticate(
        presentedProfileId || presentedProfileToken
          ? {
              ...(presentedProfileId
                ? { profileId: presentedProfileId }
                : {}),
              ...(presentedProfileToken
                ? { token: presentedProfileToken }
                : {}),
            }
          : null,
      );
    } catch (error) {
      if (
        error instanceof GovernanceError &&
        (error.code === "profile_required" ||
          error.code === "invalid_profile_credentials" ||
          error.code === "profile_disabled")
      ) {
        authenticationFailureCode = error.code;
      }
      throw error;
    } finally {
      presentedProfileId = undefined;
      presentedProfileToken = undefined;
      credentials = undefined;
      onCredentialsConsumed?.();
    }

    server = createServer(application.service, principal);
    server.server.onclose = () => {
      void shutdown().catch(reportShutdownFailure);
    };

    await server.connect(createTransport());
  } catch (error) {
    stderr.write(
      authenticationFailureCode
        ? `${authenticationFailureCode}\n`
        : error instanceof DurabilityError
          ? `${error.code}\n`
        : "IntentArc MCP failed to start.\n",
    );
    requestExitCode(1);

    try {
      await shutdown();
    } catch {
      reportShutdownFailure();
    }
  }
};

if (isMainModule(process.argv[1], import.meta.url)) {
  void runIntentArcMcp();
}
