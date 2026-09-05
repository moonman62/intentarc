import {
  createCodexConfigManager,
  type CodexConfigManager,
} from "./codex-config.js";
import {
  createCodexProductPresenceProbe,
  type CodexProductPresenceProbe,
} from "./codex-presence.js";
import {
  AiAdapterError,
  type AiAdapterDetection,
  type AiConnectionAttempt,
  type AiClientAdapter,
  type CommandRunner,
} from "./types.js";

export interface CreateCodexAdapterOptions {
  readonly runner: CommandRunner;
  readonly executableName?: string;
  readonly serverName?: string;
  readonly config?: CodexConfigManager;
  readonly productPresence?: CodexProductPresenceProbe;
}

const defaultServerName = "intentarc";
const isSupportedServerName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const versionFrom = (output: string): string | null =>
  output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;

const isMcpCommandUnavailable = (error: unknown): boolean =>
  error instanceof AiAdapterError &&
  error.code === "command_failed" &&
  typeof error.details.stderr === "string" &&
  [
    /unrecognized subcommand ['"]?mcp/i,
    /unknown (?:command|subcommand) ['"]?mcp/i,
    /invalid (?:command|subcommand) ['"]?mcp/i,
    /unexpected argument ['"]?mcp/i,
  ].some((pattern) => pattern.test(error.details.stderr!));

const isMissingServer = (error: unknown, serverName: string): boolean =>
  error instanceof AiAdapterError &&
  error.code === "command_failed" &&
  typeof error.details.stderr === "string" &&
  new RegExp(
    `No MCP server named ['"]${escapeRegex(serverName)}['"] found`,
    "i",
  ).test(error.details.stderr);

interface CodexInspection {
  readonly enabled: boolean;
  readonly transportType: string;
  readonly command: string | null;
  readonly args: readonly string[] | null;
}

const parseInspection = (
  source: string,
  serverName: string,
): CodexInspection => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new AiAdapterError("unsupported_output", {}, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AiAdapterError("unsupported_output");
  }
  const result = value as Record<string, unknown>;
  if (
    result.name !== serverName ||
    typeof result.enabled !== "boolean" ||
    result.transport === null ||
    typeof result.transport !== "object" ||
    Array.isArray(result.transport)
  ) {
    throw new AiAdapterError("unsupported_output");
  }
  const transport = result.transport as Record<string, unknown>;
  if (typeof transport.type !== "string") {
    throw new AiAdapterError("unsupported_output");
  }
  const args =
    Array.isArray(transport.args) &&
    transport.args.every((argument) => typeof argument === "string")
      ? transport.args as string[]
      : null;
  return {
    enabled: result.enabled,
    transportType: transport.type,
    command:
      typeof transport.command === "string" ? transport.command : null,
    args,
  };
};

const isIntentArcBridgeCommand = (command: string): boolean =>
  /^IntentArc Bridge(?:\.exe)?$/i.test(
    command.split(/[\\/]/).at(-1) ?? "",
  );

const isIntentArcOwned = (inspection: CodexInspection): boolean =>
  inspection.transportType === "stdio" &&
  inspection.command !== null &&
  isIntentArcBridgeCommand(inspection.command) &&
  inspection.args?.length === 2 &&
  inspection.args[0] === "--connection" &&
  typeof inspection.args[1] === "string" &&
  inspection.args[1].length > 0;

const sameCommand = (left: string, right: string): boolean =>
  left.replaceAll("/", "\\").toLowerCase() ===
  right.replaceAll("/", "\\").toLowerCase();

const matchesConnection = (
  inspection: CodexInspection,
  input: { bridgeExecutable: string; connectionId: string },
): boolean =>
  inspection.enabled &&
  isIntentArcOwned(inspection) &&
  inspection.command !== null &&
  sameCommand(inspection.command, input.bridgeExecutable) &&
  inspection.args?.[1] === input.connectionId;

const matchesConnectionVector = (
  inspection: CodexInspection,
  input: { bridgeExecutable: string; connectionId: string },
): boolean =>
  isIntentArcOwned(inspection) &&
  inspection.command !== null &&
  sameCommand(inspection.command, input.bridgeExecutable) &&
  inspection.args?.[1] === input.connectionId;

const matchesManagedState = (
  inspection: CodexInspection,
  input: { bridgeExecutable: string; connectionId: string },
  expectedEnabled: boolean,
): boolean =>
  inspection.enabled === expectedEnabled &&
  matchesConnectionVector(inspection, input);

const sameInspection = (
  left: CodexInspection,
  right: CodexInspection,
): boolean =>
  left.enabled === right.enabled &&
  left.transportType === right.transportType &&
  left.command !== null &&
  right.command !== null &&
  sameCommand(left.command, right.command) &&
  left.args !== null &&
  right.args !== null &&
  left.args.length === right.args.length &&
  left.args.every((argument, index) => argument === right.args![index]);

export const createCodexAdapter = ({
  runner,
  executableName = "codex",
  serverName = defaultServerName,
  config,
  productPresence = createCodexProductPresenceProbe({ runner }),
}: CreateCodexAdapterOptions): AiClientAdapter => {
  if (!isSupportedServerName(serverName)) {
    throw new AiAdapterError("configuration_invalid");
  }
  let resolvedConfig = config;
  const defaultConfig = (): CodexConfigManager => {
    resolvedConfig ??= createCodexConfigManager();
    return resolvedConfig;
  };
  const executable = (): Promise<string | null> =>
    runner.findExecutable(executableName);
  const requiredExecutable = async (): Promise<string> => {
    const path = await executable();
    if (path === null) throw new AiAdapterError("executable_missing");
    return path;
  };
  const verifyMcpConnection = async (
    path: string,
    input: { bridgeExecutable: string; connectionId: string },
  ): Promise<void> => {
    const result = await runner.run(path, [
      "mcp",
      "get",
      serverName,
      "--json",
    ]);
    if (!matchesConnection(parseInspection(result.stdout, serverName), input)) {
      throw new AiAdapterError("configuration_failed");
    }
  };

  const prepareConnection = async (
    input: { bridgeExecutable: string; connectionId: string },
  ): Promise<AiConnectionAttempt> => {
    const path = await requiredExecutable();
    const configAttempt = serverName === defaultServerName
      ? await defaultConfig().prepareConnection(input)
      : null;
    let inspection: CodexInspection | null;
    try {
      const result = await runner.run(path, [
        "mcp",
        "get",
        serverName,
        "--json",
      ]);
      inspection = parseInspection(result.stdout, serverName);
    } catch (error) {
      if (isMcpCommandUnavailable(error)) {
        if (configAttempt === null) {
          throw new AiAdapterError("configuration_failed", {}, { cause: error });
        }
        return {
          apply: async () => {
            await configAttempt.apply();
            if (await defaultConfig().inspect() !== "connected") {
              throw new AiAdapterError("configuration_failed");
            }
            return { restartRequired: true };
          },
          rollback: configAttempt.rollback,
        };
      }
      if (!isMissingServer(error, serverName)) throw error;
      inspection = null;
    }

    if (inspection !== null) {
      if (matchesConnection(inspection, input)) {
        return {
          apply: async () => ({ restartRequired: true }),
          rollback: async () => undefined,
        };
      }
      if (!isIntentArcOwned(inspection)) {
        throw new AiAdapterError("configuration_conflict");
      }
    }
    let expectedAttemptEnabled = inspection?.enabled ?? true;

    return {
      apply: async () => {
        try {
          await runner.run(path, [
            "mcp",
            "add",
            serverName,
            "--",
            input.bridgeExecutable,
            "--connection",
            input.connectionId,
          ]);
          await verifyMcpConnection(path, input);
        } catch (error) {
          if (isMcpCommandUnavailable(error)) {
            if (configAttempt === null) {
              throw new AiAdapterError("configuration_failed", {}, { cause: error });
            }
            await configAttempt.apply();
            if (await defaultConfig().inspect() !== "connected") {
              throw new AiAdapterError("configuration_failed");
            }
          } else {
            throw error;
          }
        }
        expectedAttemptEnabled = true;
        return { restartRequired: true };
      },
      rollback: async () => {
        try {
          const result = await runner.run(path, [
            "mcp",
            "get",
            serverName,
            "--json",
          ]);
          const current = parseInspection(result.stdout, serverName);
          if (
            inspection !== null &&
            sameInspection(current, inspection)
          ) {
            return;
          }
          if (!matchesManagedState(current, input, expectedAttemptEnabled)) {
            throw new AiAdapterError("compensation_conflict");
          }
        } catch (error) {
          if (isMissingServer(error, serverName)) {
            if (inspection === null) return;
            throw new AiAdapterError("compensation_conflict", {}, {
              cause: error,
            });
          }
          if (!isMcpCommandUnavailable(error) || configAttempt === null) throw error;
        }
        if (configAttempt === null) {
          if (inspection !== null) {
            throw new AiAdapterError("compensation_conflict");
          }
          try {
            await runner.run(path, ["mcp", "remove", serverName]);
          } catch (error) {
            if (!isMissingServer(error, serverName)) throw error;
          }
          return;
        }
        await configAttempt.rollback(expectedAttemptEnabled);
      },
    };
  };

  const connect = async (
    input: { bridgeExecutable: string; connectionId: string },
  ): Promise<{ restartRequired: boolean }> => {
    const attempt = await prepareConnection(input);
    try {
      return await attempt.apply();
    } catch (error) {
      try {
        await attempt.rollback();
      } catch (restoreError) {
        throw new AiAdapterError(
          "configuration_failed",
          {},
          {
            cause: new AggregateError(
              [error, restoreError],
              "Codex connection restoration failed.",
            ),
          },
        );
      }
      throw error;
    }
  };

  const detectionFromCliFailure = (
    error: unknown,
  ): AiAdapterDetection => {
    if (error instanceof AiAdapterError && error.code === "access_denied") {
      return {
        availability: "setup_required",
        reason: "access_blocked",
        version: null,
      };
    }
    if (
      error instanceof AiAdapterError &&
      error.code === "executable_missing"
    ) {
      return {
        availability: "setup_required",
        reason: "cli_missing",
        version: null,
      };
    }
    throw error;
  };

  return {
    id: "codex",
    detect: async () => {
      let path: string | null;
      try {
        path = await executable();
      } catch (error) {
        return detectionFromCliFailure(error);
      }
      if (path === null) {
        return await productPresence.detect()
          ? {
              availability: "setup_required",
              reason: "cli_missing",
              version: null,
            }
          : {
              availability: "not_detected",
              reason: "not_installed",
              version: null,
            };
      }
      try {
        const result = await runner.run(path, ["--version"]);
        const version = versionFrom(`${result.stdout}\n${result.stderr}`);
        if (version === null) {
          return {
            availability: "setup_required",
            reason: "unsupported_version",
            version: null,
          };
        }
        return {
          availability: "ready",
          reason: "connector_ready",
          version,
        };
      } catch (error) {
        return detectionFromCliFailure(error);
      }
    },
    inspect: async () => {
      const path = await executable();
      if (path === null) return "not_connected";
      try {
        const result = await runner.run(path, [
          "mcp",
          "get",
          serverName,
          "--json",
        ]);
        const inspection = parseInspection(result.stdout, serverName);
        if (!inspection.enabled) {
          return serverName === defaultServerName ? "not_connected" : "unknown";
        }
        return isIntentArcOwned(inspection) ? "connected" : "unknown";
      } catch (error) {
        if (isMissingServer(error, serverName)) return "not_connected";
        if (isMcpCommandUnavailable(error) && serverName === defaultServerName) {
          return defaultConfig().inspect();
        }
        throw error;
      }
    },
    prepareConnection,
    connect,
    remove: async () => {
      const path = await requiredExecutable();
      try {
        const result = await runner.run(path, [
          "mcp",
          "get",
          serverName,
          "--json",
        ]);
        if (!isIntentArcOwned(parseInspection(result.stdout, serverName))) {
          throw new AiAdapterError("configuration_conflict");
        }
      } catch (error) {
        if (isMissingServer(error, serverName)) return;
        if (isMcpCommandUnavailable(error) && serverName === defaultServerName) {
          await defaultConfig().remove();
          return;
        }
        throw error;
      }
      try {
        await runner.run(path, ["mcp", "remove", serverName]);
      } catch (error) {
        if (isMissingServer(error, serverName)) return;
        if (isMcpCommandUnavailable(error) && serverName === defaultServerName) {
          await defaultConfig().remove();
        } else {
          throw error;
        }
      }
    },
    launch: async () => "manual_required",
  };
};
