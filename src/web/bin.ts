#!/usr/bin/env node
import { resolve } from "node:path";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
} from "commander";
import type {
  CreateApplicationOptions,
  IntentArcApplication,
} from "../app/create-application.js";
import { openIntentArcApplication } from "../app/create-application.js";
import { isMainModule } from "../system/main-module.js";
import {
  startWebServer,
  type RunningWebServer,
  type StartWebServerOptions,
} from "./server/http-server.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface Writer {
  write(message: string): unknown;
}

interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface RunIntentArcWebOptions {
  argv?: string[];
  stdout?: Writer;
  stderr?: Writer;
  signalSource?: SignalSource;
  setExitCode?: (code: number) => void;
  sessionToken?: string;
  openApplication?: (
    options: CreateApplicationOptions,
  ) => Promise<IntentArcApplication>;
  startServer?: (
    options: StartWebServerOptions,
  ) => Promise<RunningWebServer>;
}

export const runIntentArcWeb = async (
  {
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    signalSource = process,
    setExitCode = (code) => {
      process.exitCode = code;
    },
    sessionToken,
    openApplication = openIntentArcApplication,
    startServer = startWebServer,
  }: RunIntentArcWebOptions = {},
): Promise<void> => {
  const program = new Command()
    .name("intentarc-web")
    .requiredOption("--db <path>", "path to the IntentArc database")
    .option(
      "--port <port>",
      "loopback HTTP port",
      parsePort,
      47_861,
    )
    .option(
      "--dev-origin <origin>",
      "additional 127.0.0.1 development origin",
      collectValue,
      [],
    )
    .configureOutput({
      writeOut: (message) => { stdout.write(message); },
      writeErr: (message) => { stderr.write(message); },
    })
    .exitOverride();

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      setExitCode(2);
      return;
    }
    throw error;
  }

  const parsed = program.opts<{
    db: string;
    port: number;
    devOrigin: string[];
  }>();
  let application: IntentArcApplication | undefined;
  let server: RunningWebServer | undefined;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | undefined;
  const startupSettled = Promise.withResolvers<void>();

  const removeSignalListeners = (): void => {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownRequested = true;
    removeSignalListeners();
    shutdownPromise = (async () => {
      await startupSettled.promise;
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
      if (shutdownError) {
        throw shutdownError;
      }
    })();
    return shutdownPromise;
  };
  const reportShutdownFailure = (): void => {
    stderr.write("IntentArc web failed to close.\n");
    setExitCode(1);
  };
  const onSignal = (): void => {
    void shutdown().catch(reportShutdownFailure);
  };

  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);

  try {
    try {
      application = await openApplication({
        databasePath: resolve(parsed.db),
      });
      if (!shutdownRequested) {
        server = await startServer({
          application,
          port: parsed.port,
          allowedMutationOrigins: parsed.devOrigin,
          ...(sessionToken === undefined ? {} : { sessionToken }),
        });
      }
    } finally {
      startupSettled.resolve();
    }

    if (shutdownRequested) {
      await shutdown();
      return;
    }

    const startedUrl = new URL(server!.origin);
    stdout.write(`${JSON.stringify({
      event: "intentarc_web_started",
      url: server!.launchUrl,
      host: "127.0.0.1",
      port: Number(startedUrl.port),
    })}\n`);
  } catch {
    stderr.write("IntentArc web failed to start.\n");
    setExitCode(1);
    try {
      await shutdown();
    } catch {
      reportShutdownFailure();
    }
  }
};

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError(
      "Port must be an integer between 0 and 65535.",
    );
  }
  return port;
};

const collectValue = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

if (isMainModule(process.argv[1], import.meta.url)) {
  void runIntentArcWeb();
}
