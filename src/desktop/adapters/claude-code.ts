import {
  AiAdapterError,
  type AiConnectionAttempt,
  type AiClientAdapter,
  type CommandRunner,
} from "./types.js";

export interface CreateClaudeCodeAdapterOptions {
  readonly runner: CommandRunner;
  readonly executableName?: string;
  readonly serverName?: string;
}

const defaultServerName = "intentarc";
const isSupportedServerName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const versionFrom = (output: string): string | null =>
  output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;

const isMissingServer = (error: unknown, serverName: string): boolean =>
  error instanceof AiAdapterError &&
  error.code === "command_failed" &&
  typeof error.details.stderr === "string" &&
  (() => {
    const name = escapeRegex(serverName);
    const exactName = `(?:\"${name}\"|'${name}'|\\x60${name}\\x60|${name}(?![A-Za-z0-9._-]))`;
    return [
      new RegExp(`\\bNo MCP server named\\s+${exactName}(?=\\s|[.!,:;]|$)`, "i"),
      new RegExp(`\\bMCP server\\s+${exactName}\\s+(?:not found|does not exist)\\b`, "i"),
    ].some((pattern) => pattern.test(error.details.stderr as string));
  })();

interface ClaudeInspection {
  readonly scope: string;
  readonly status: string;
  readonly type: string;
  readonly command: string;
  readonly args: string;
}

const parseInspection = (source: string, serverName: string): ClaudeInspection => {
  if (!new RegExp(`^\\s*${escapeRegex(serverName)}:\\s*$`, "im").test(source)) {
    throw new AiAdapterError("unsupported_output");
  }
  const fields = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /^\s{2}(Scope|Status|Type|Command|Args):\s*(.*)$/,
    );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  if (
    !fields.has("scope") ||
    !fields.has("status") ||
    !fields.has("type") ||
    !fields.has("command") ||
    !fields.has("args")
  ) {
    throw new AiAdapterError("unsupported_output");
  }
  return {
    scope: fields.get("scope")!,
    status: fields.get("status")!,
    type: fields.get("type")!,
    command: fields.get("command")!,
    args: fields.get("args")!,
  };
};

const isUserScoped = (inspection: ClaudeInspection): boolean =>
  /^User config\b/i.test(inspection.scope);

const isHealthy = (inspection: ClaudeInspection): boolean =>
  /\bConnected\b/i.test(inspection.status) &&
  !/\b(?:Failed|Pending|Rejected)\b/i.test(inspection.status);

const isIntentArcBridgeCommand = (command: string): boolean =>
  /^IntentArc Bridge(?:\.exe)?$/i.test(
    command.split(/[\\/]/).at(-1) ?? "",
  );

const hasIntentArcConnectionArgument = (args: string): boolean =>
  /^--connection\s+\S(?:.*\S)?$/.test(args);

const isIntentArcOwned = (inspection: ClaudeInspection): boolean =>
  isUserScoped(inspection) &&
  inspection.type.toLowerCase() === "stdio" &&
  isIntentArcBridgeCommand(inspection.command) &&
  hasIntentArcConnectionArgument(inspection.args);

const sameCommand = (left: string, right: string): boolean =>
  left.replaceAll("/", "\\").toLowerCase() ===
  right.replaceAll("/", "\\").toLowerCase();

const matchesConnection = (
  inspection: ClaudeInspection,
  input: { bridgeExecutable: string; connectionId: string },
): boolean =>
  isIntentArcOwned(inspection) &&
  sameCommand(inspection.command, input.bridgeExecutable) &&
  inspection.args === `--connection ${input.connectionId}`;

export const createClaudeCodeAdapter = ({
  runner,
  executableName = "claude",
  serverName = defaultServerName,
}: CreateClaudeCodeAdapterOptions): AiClientAdapter => {
  if (!isSupportedServerName(serverName)) {
    throw new AiAdapterError("configuration_invalid");
  }
  const executable = (): Promise<string | null> =>
    runner.findExecutable(executableName);
  const requiredExecutable = async (): Promise<string> => {
    const path = await executable();
    if (path === null) throw new AiAdapterError("executable_missing");
    return path;
  };

  const prepareConnection = async (
    input: { bridgeExecutable: string; connectionId: string },
  ): Promise<AiConnectionAttempt> => {
    const path = await requiredExecutable();
    try {
      const result = await runner.run(path, ["mcp", "get", serverName]);
      const inspection = parseInspection(result.stdout, serverName);
      if (!matchesConnection(inspection, input)) {
        throw new AiAdapterError("configuration_conflict");
      }
      return {
        apply: async () => ({ restartRequired: true }),
        rollback: async () => undefined,
      };
    } catch (error) {
      if (!isMissingServer(error, serverName)) throw error;
    }

    return {
      apply: async () => {
        await runner.run(path, [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          serverName,
          "--",
          input.bridgeExecutable,
          "--connection",
          input.connectionId,
        ]);
        const verification = await runner.run(path, [
          "mcp",
          "get",
          serverName,
        ]);
        if (!matchesConnection(parseInspection(verification.stdout, serverName), input)) {
          throw new AiAdapterError("configuration_failed");
        }
        return { restartRequired: true };
      },
      rollback: async () => {
        try {
          const result = await runner.run(path, ["mcp", "get", serverName]);
          if (!matchesConnection(parseInspection(result.stdout, serverName), input)) return;
        } catch (error) {
          if (isMissingServer(error, serverName)) return;
          throw error;
        }
        await runner.run(path, [
          "mcp",
          "remove",
          "--scope",
          "user",
          serverName,
        ]);
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
              "Claude Code connection restoration failed.",
            ),
          },
        );
      }
      throw error;
    }
  };

  return {
    id: "claude-code",
    detect: async () => {
      try {
        const path = await executable();
        if (path === null) {
          return {
            availability: "not_detected",
            reason: "not_installed",
            version: null,
          };
        }
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
      }
    },
    inspect: async () => {
      const path = await executable();
      if (path === null) return "not_connected";
      let result;
      try {
        result = await runner.run(path, ["mcp", "get", serverName]);
      } catch (error) {
        if (isMissingServer(error, serverName)) return "not_connected";
        throw error;
      }
      const inspection = parseInspection(result.stdout, serverName);
      return isIntentArcOwned(inspection) && isHealthy(inspection)
        ? "connected"
        : "unknown";
    },
    prepareConnection,
    connect,
    remove: async () => {
      const path = await requiredExecutable();
      try {
        const result = await runner.run(path, ["mcp", "get", serverName]);
        if (!isIntentArcOwned(parseInspection(result.stdout, serverName))) {
          throw new AiAdapterError("configuration_conflict");
        }
      } catch (error) {
        if (isMissingServer(error, serverName)) return;
        throw error;
      }
      try {
        await runner.run(path, [
          "mcp",
          "remove",
          "--scope",
          "user",
          serverName,
        ]);
      } catch (error) {
        if (!isMissingServer(error, serverName)) throw error;
      }
    },
    launch: async () => "manual_required",
  };
};
