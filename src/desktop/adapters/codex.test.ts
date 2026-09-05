import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codexConfig from "./codex-config.js";
import { createCodexConfigManager } from "./codex-config.js";
import { createCodexAdapter } from "./codex.js";
import type { CodexProductPresenceProbe } from "./codex-presence.js";
import { createAiAdapterRegistry } from "./registry.js";
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from "./types.js";
import { AiAdapterError } from "./types.js";

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];
  executable: string | null = "C:\\Tools\\codex.exe";
  readonly outcomes: Array<CommandResult | Error> = [];

  async findExecutable(): Promise<string | null> {
    return this.executable;
  }

  async run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push({
      command,
      args: [...args],
      ...(options === undefined ? {} : { options }),
    });
    const outcome = this.outcomes.shift() ?? { stdout: "", stderr: "" };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

const codexInspection = (
  command: string,
  args: readonly string[],
  enabled = true,
  serverName = "intentarc",
): CommandResult => ({
  stdout: JSON.stringify({
    name: serverName,
    enabled,
    disabled_reason: enabled ? null : "disabled in config",
    transport: {
      type: "stdio",
      command,
      args,
      env: null,
      env_vars: [],
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  }),
  stderr: "",
});

const temporaryRoots: string[] = [];

const codexProductPresence = (
  present: boolean,
): CodexProductPresenceProbe => ({
  detect: async () => present,
});

const escapeTomlString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const codexConfigSource = (input: {
  readonly bridgeExecutable: string;
  readonly connectionId: string;
  readonly enabled: boolean;
  readonly model?: string;
}): string => [
  "# preserve this user setting",
  `model = "${input.model ?? "gpt-5.4"}"`,
  "",
  "[mcp_servers.intentarc]",
  `command = "${escapeTomlString(input.bridgeExecutable)}"`,
  `args = ["--connection", "${escapeTomlString(input.connectionId)}"]`,
  `enabled = ${input.enabled}`,
  "",
].join("\n");

class ConfigBackedCodexRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];

  constructor(private readonly configPath: string) {}

  async findExecutable(): Promise<string | null> {
    return "C:\\Tools\\codex.exe";
  }

  async run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push({
      command,
      args: [...args],
      ...(options === undefined ? {} : { options }),
    });
    if (
      args.length === 4 &&
      args[0] === "mcp" &&
      args[1] === "get" &&
      args[2] === "intentarc" &&
      args[3] === "--json"
    ) {
      const loaded = parse(await readFile(this.configPath, "utf8")) as {
        mcp_servers?: {
          intentarc?: {
            command?: unknown;
            args?: unknown;
            enabled?: unknown;
          };
        };
      };
      const entry = loaded.mcp_servers?.intentarc;
      if (
        typeof entry?.command !== "string" ||
        !Array.isArray(entry.args) ||
        !entry.args.every((argument) => typeof argument === "string") ||
        typeof entry.enabled !== "boolean"
      ) {
        throw new Error("Test Codex config entry is incomplete.");
      }
      return codexInspection(entry.command, entry.args, entry.enabled);
    }
    if (
      args.length === 7 &&
      args[0] === "mcp" &&
      args[1] === "add" &&
      args[2] === "intentarc" &&
      args[3] === "--" &&
      args[5] === "--connection"
    ) {
      await writeFile(this.configPath, codexConfigSource({
        bridgeExecutable: args[4]!,
        connectionId: args[6]!,
        enabled: true,
      }), "utf8");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected Codex command: ${args.join(" ")}`);
  }
}

const createConfigBackedCodex = async (originalSource: string) => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-codex-adapter-"));
  temporaryRoots.push(root);
  const configPath = join(root, "config.toml");
  await writeFile(configPath, originalSource, "utf8");
  const runner = new ConfigBackedCodexRunner(configPath);
  const adapter = createCodexAdapter({
    runner,
    config: createCodexConfigManager({ configPath }),
  });
  return { adapter, configPath, runner };
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("Codex adapter", () => {
  it("uses a supplied server name for missing detection, inspection, and connect commands", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-codex-00000000-0000-4000-8000-000000000001";
    const bridgeExecutable = "C:\\Program Files\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: `No MCP server named '${serverName}' found.`,
      }),
      { stdout: "", stderr: "" },
      codexInspection(
        bridgeExecutable,
        ["--connection", connectionId],
        true,
        serverName,
      ),
    );

    await expect(createCodexAdapter({ runner, serverName }).connect({
      bridgeExecutable,
      connectionId,
    })).resolves.toEqual({ restartRequired: true });

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", serverName, "--json"],
      ["mcp", "add", serverName, "--", bridgeExecutable, "--connection", connectionId],
      ["mcp", "get", serverName, "--json"],
    ]);
  });

  it("uses a supplied server name for rollback compensation and removal", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-codex-00000000-0000-4000-8000-000000000001";
    const bridgeExecutable = "C:\\Program Files\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    const rollback = vi.fn(async () => undefined);
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: `No MCP server named '${serverName}' found.`,
      }),
      new AiAdapterError("command_failed", { exitCode: 1, stderr: "write failed" }),
      codexInspection(
        bridgeExecutable,
        ["--connection", connectionId],
        true,
        serverName,
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        bridgeExecutable,
        ["--connection", connectionId],
        true,
        serverName,
      ),
      { stdout: "", stderr: "" },
    );
    const config = {
      inspect: vi.fn(async () => "unknown" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback,
      })),
      remove: vi.fn(async () => undefined),
    };
    const adapter = createCodexAdapter({ runner, config, serverName });

    await expect(adapter.connect({ bridgeExecutable, connectionId }))
      .rejects.toMatchObject({ code: "command_failed" });
    await expect(adapter.remove()).resolves.toBeUndefined();

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", serverName, "--json"],
      ["mcp", "add", serverName, "--", bridgeExecutable, "--connection", connectionId],
      ["mcp", "get", serverName, "--json"],
      ["mcp", "remove", serverName],
      ["mcp", "get", serverName, "--json"],
      ["mcp", "remove", serverName],
    ]);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("fails closed for a custom server name when the Codex MCP command is unavailable", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-codex-00000000-0000-4000-8000-000000000001";
    const config = {
      inspect: vi.fn(async () => "connected" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
      })),
      remove: vi.fn(async () => undefined),
    };
    runner.outcomes.push(new AiAdapterError("command_failed", {
      exitCode: 2,
      stderr: "error: unrecognized subcommand 'mcp'",
    }));

    await expect(createCodexAdapter({ runner, config, serverName }).connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_failed" });

    expect(config.prepareConnection).not.toHaveBeenCalled();
    expect(config.inspect).not.toHaveBeenCalled();
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", serverName, "--json"],
    ]);
  });

  it("does not construct the default config manager for a custom server name", () => {
    const runner = new RecordingRunner();
    const factory = vi.spyOn(codexConfig, "createCodexConfigManager");

    try {
      expect(createCodexAdapter({
        runner,
        serverName: "intentarc-acceptance-codex-00000000-0000-4000-8000-000000000001",
      }).id).toBe("codex");
      expect(factory).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });

  it("rejects an invalid supplied server name before invoking Codex", () => {
    const runner = new RecordingRunner();

    expect(() => createCodexAdapter({ runner, serverName: "intentarc unsafe" }))
      .toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    expect(runner.calls).toEqual([]);
  });

  it("connects the stable bridge with a dedicated opaque connection argument", async () => {
    const runner = new RecordingRunner();
    const codexPath = runner.executable!;
    const bridgeExecutable =
      "C:\\Program Files\\IntentArc\\bridge\\current\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    const codex = createCodexAdapter({ runner });
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: "No MCP server named 'intentarc' found.",
      }),
      { stdout: "", stderr: "" },
      codexInspection(
        bridgeExecutable,
        ["--connection", connectionId],
      ),
    );

    await expect(codex.connect({
      bridgeExecutable,
      connectionId,
    })).resolves.toMatchObject({ restartRequired: true });
    expect(runner.calls[0]).toEqual({
      command: codexPath,
      args: ["mcp", "get", "intentarc", "--json"],
    });
    expect(runner.calls[1]).toEqual({
      command: codexPath,
      args: [
        "mcp",
        "add",
        "intentarc",
        "--",
        bridgeExecutable,
        "--connection",
        connectionId,
      ],
    });
    expect(runner.calls[2]).toEqual({
      command: codexPath,
      args: ["mcp", "get", "intentarc", "--json"],
    });
  });

  it("detects a supported Codex executable and version", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ stdout: "codex-cli 0.116.0\n", stderr: "" });

    await expect(createCodexAdapter({ runner }).detect()).resolves.toEqual({
      availability: "ready",
      reason: "connector_ready",
      version: "0.116.0",
    });
  });

  it("reports Codex as not installed when no executable is detected", async () => {
    const runner = new RecordingRunner();
    runner.executable = null;

    await expect(createCodexAdapter({
      runner,
      productPresence: codexProductPresence(false),
    }).detect()).resolves.toEqual({
      availability: "not_detected",
      reason: "not_installed",
      version: null,
    });
  });

  it("reports CLI setup required when the Codex Store product is present", async () => {
    const runner = new RecordingRunner();
    runner.executable = null;

    await expect(createCodexAdapter({
      runner,
      productPresence: codexProductPresence(true),
    }).detect()).resolves.toEqual({
      availability: "setup_required",
      reason: "cli_missing",
      version: null,
    });
    expect(runner.calls).toEqual([]);
  });

  it.each([
    "access_denied",
    "executable_missing",
  ] as const)(
    "lets a %s product-presence failure escape for Task 2 isolation",
    async (code) => {
      const runner = new RecordingRunner();
      runner.executable = null;
      const failure = new AiAdapterError(code);

      await expect(createCodexAdapter({
        runner,
        productPresence: {
          detect: async () => {
            throw failure;
          },
        },
      }).detect()).rejects.toBe(failure);
    },
  );

  it("reports unsupported Codex version output as setup required", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ stdout: "Codex release unknown", stderr: "" });

    await expect(createCodexAdapter({ runner }).detect()).resolves.toEqual({
      availability: "setup_required",
      reason: "unsupported_version",
      version: null,
    });
  });

  it.each([
    ["access_denied", "access_blocked"],
    ["executable_missing", "cli_missing"],
  ] as const)(
    "maps a %s Codex version probe to %s",
    async (code, reason) => {
      const runner = new RecordingRunner();
      runner.outcomes.push(new AiAdapterError(code));

      await expect(createCodexAdapter({ runner }).detect()).resolves.toEqual({
        availability: "setup_required",
        reason,
        version: null,
      });
    },
  );

  it("inspects the documented Codex JSON output", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(codexInspection(
      "IntentArc Bridge.exe",
      ["--connection", "connection-1"],
    ));

    await expect(createCodexAdapter({ runner }).inspect()).resolves.toBe(
      "connected",
    );
    expect(runner.calls[0]?.args).toEqual([
      "mcp",
      "get",
      "intentarc",
      "--json",
    ]);
  });

  it("reports a disabled exact Codex entry as present but unhealthy", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-codex-run";
    runner.outcomes.push(codexInspection(
      "IntentArc Bridge.exe",
      ["--connection", "connection-1"],
      false,
      serverName,
    ));

    await expect(createCodexAdapter({ runner, serverName }).inspect()).resolves.toBe(
      "unknown",
    );
  });

  it("preserves disabled-entry inspection for the default product connection", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(codexInspection(
      "IntentArc Bridge.exe",
      ["--connection", "connection-1"],
      false,
    ));

    await expect(createCodexAdapter({ runner }).inspect()).resolves.toBe(
      "not_connected",
    );
  });

  it("replays an exact existing Codex connection without adding it again", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    };
    runner.outcomes.push(codexInspection(
      input.bridgeExecutable,
      ["--connection", input.connectionId],
    ));

    await expect(createCodexAdapter({ runner }).connect(input)).resolves.toEqual({
      restartRequired: true,
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("re-enables an exact disabled Codex connection and verifies the result", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    };
    runner.outcomes.push(
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
      ),
    );

    await expect(createCodexAdapter({ runner }).connect(input)).resolves.toEqual({
      restartRequired: true,
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
      [
        "mcp",
        "add",
        "intentarc",
        "--",
        input.bridgeExecutable,
        "--connection",
        input.connectionId,
      ],
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("restores a disabled entry after an enabled repair has a downstream failure", async () => {
    const previous = {
      bridgeExecutable: "C:\\Old\\IntentArc Bridge.exe",
      connectionId: "old-connection",
      enabled: false,
    };
    const input = {
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const originalSource = codexConfigSource(previous);
    const { adapter, configPath } = await createConfigBackedCodex(
      originalSource,
    );
    const attempt = await adapter.prepareConnection(input);

    await attempt.apply();
    expect(await readFile(configPath, "utf8")).toBe(codexConfigSource({
      ...input,
      enabled: true,
    }));

    await attempt.rollback();

    expect(await readFile(configPath, "utf8")).toBe(originalSource);
  });

  it("refuses compensation when the enabled attempted entry is concurrently disabled", async () => {
    const previous = {
      bridgeExecutable: "C:\\Old\\IntentArc Bridge.exe",
      connectionId: "old-connection",
      enabled: false,
    };
    const input = {
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const { adapter, configPath } = await createConfigBackedCodex(
      codexConfigSource(previous),
    );
    const attempt = await adapter.prepareConnection(input);
    await attempt.apply();
    const concurrentSource = codexConfigSource({
      ...input,
      enabled: false,
      model: "gpt-5.6",
    });
    await writeFile(configPath, concurrentSource, "utf8");

    await expect(attempt.rollback()).rejects.toMatchObject({
      code: "compensation_conflict",
    });
    expect(await readFile(configPath, "utf8")).toBe(concurrentSource);
  });

  it("keeps an already-enabled exact entry byte-identical and does not add it again", async () => {
    const input = {
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const originalSource = codexConfigSource({
      ...input,
      enabled: true,
    });
    const { adapter, configPath, runner } = await createConfigBackedCodex(
      originalSource,
    );
    const attempt = await adapter.prepareConnection(input);

    await expect(attempt.apply()).resolves.toEqual({
      restartRequired: true,
    });

    expect(await readFile(configPath, "utf8")).toBe(originalSource);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("leaves a successful disabled-entry repair enabled", async () => {
    const input = {
      bridgeExecutable: "C:\\New\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const { adapter, configPath } = await createConfigBackedCodex(
      codexConfigSource({
        bridgeExecutable: "C:\\Old\\IntentArc Bridge.exe",
        connectionId: "old-connection",
        enabled: false,
      }),
    );
    const attempt = await adapter.prepareConnection(input);

    await expect(attempt.apply()).resolves.toEqual({
      restartRequired: true,
    });

    expect(await readFile(configPath, "utf8")).toBe(codexConfigSource({
      ...input,
      enabled: true,
    }));
  });

  it("fails when Codex leaves a repaired connection disabled", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    };
    runner.outcomes.push(
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
    );

    await expect(
      createCodexAdapter({ runner }).connect(input),
    ).rejects.toMatchObject({ code: "configuration_failed" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
      [
        "mcp",
        "add",
        "intentarc",
        "--",
        input.bridgeExecutable,
        "--connection",
        input.connectionId,
      ],
      ["mcp", "get", "intentarc", "--json"],
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("repairs a recognizably old IntentArc bridge vector", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    runner.outcomes.push(
      codexInspection(
        "C:\\Old\\bridge\\IntentArc Bridge.exe",
        ["--connection", "old-connection"],
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
      ),
    );

    await expect(createCodexAdapter({ runner }).connect(input)).resolves.toEqual({
      restartRequired: true,
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
      [
        "mcp",
        "add",
        "intentarc",
        "--",
        input.bridgeExecutable,
        "--connection",
        input.connectionId,
      ],
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("restores a pre-existing owned vector when repair verification fails", async () => {
    const runner = new RecordingRunner();
    const previous = {
      bridgeExecutable: "C:\\Old\\bridge\\IntentArc Bridge.exe",
      connectionId: "old-connection",
    };
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const rollback = vi.fn(async () => undefined);
    const config = {
      inspect: vi.fn(async () => "connected" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback,
      })),
      remove: vi.fn(async () => undefined),
    };
    runner.outcomes.push(
      codexInspection(
        previous.bridgeExecutable,
        ["--connection", previous.connectionId],
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        previous.bridgeExecutable,
        ["--connection", previous.connectionId],
      ),
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
      ),
    );

    await expect(
      createCodexAdapter({ runner, config }).connect(input),
    ).rejects.toMatchObject({ code: "configuration_failed" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
      [
        "mcp",
        "add",
        "intentarc",
        "--",
        input.bridgeExecutable,
        "--connection",
        input.connectionId,
      ],
      ["mcp", "get", "intentarc", "--json"],
      ["mcp", "get", "intentarc", "--json"],
    ]);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("restores the exact disabled owned vector when repair verification fails", async () => {
    const runner = new RecordingRunner();
    const previous = {
      bridgeExecutable: "C:\\Old\\bridge\\IntentArc Bridge.exe",
      connectionId: "old-connection",
    };
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const rollback = vi.fn(async () => undefined);
    const config = {
      inspect: vi.fn(async () => "connected" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback,
      })),
      remove: vi.fn(async () => undefined),
    };
    runner.outcomes.push(
      codexInspection(
        previous.bridgeExecutable,
        ["--connection", previous.connectionId],
        false,
      ),
      { stdout: "", stderr: "" },
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
    );

    await expect(
      createCodexAdapter({ runner, config }).connect(input),
    ).rejects.toMatchObject({ code: "configuration_failed" });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("restores the exact snapshot when Codex add fails after mutating the entry", async () => {
    const runner = new RecordingRunner();
    const previous = {
      bridgeExecutable: "C:\\Old\\bridge\\IntentArc Bridge.exe",
      connectionId: "old-connection",
    };
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const rollback = vi.fn(async () => undefined);
    const config = {
      inspect: vi.fn(async () => "connected" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback,
      })),
      remove: vi.fn(async () => undefined),
    };
    runner.outcomes.push(
      codexInspection(
        previous.bridgeExecutable,
        ["--connection", previous.connectionId],
        false,
      ),
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: "write completed before command reported failure",
      }),
      codexInspection(
        input.bridgeExecutable,
        ["--connection", input.connectionId],
        false,
      ),
    );

    await expect(
      createCodexAdapter({ runner, config }).connect(input),
    ).rejects.toMatchObject({ code: "command_failed" });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("refuses compensation when a failed add leaves an unrelated entry", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "new-connection",
    };
    const rollback = vi.fn(async () => undefined);
    const config = {
      inspect: vi.fn(async () => "unknown" as const),
      connect: vi.fn(async () => undefined),
      prepareConnection: vi.fn(async () => ({
        apply: vi.fn(async () => undefined),
        rollback,
      })),
      remove: vi.fn(async () => undefined),
    };
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: "No MCP server named 'intentarc' found.",
      }),
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: "write failed",
      }),
      codexInspection("C:\\Other\\unmanaged-server.exe", ["serve"]),
    );

    await expect(
      createCodexAdapter({ runner, config }).connect(input),
    ).rejects.toMatchObject({ code: "configuration_failed" });
    expect(rollback).not.toHaveBeenCalled();
    expect(runner.calls.map(({ args }) => args)).not.toContainEqual([
      "mcp",
      "remove",
      "intentarc",
    ]);
  });

  it("refuses an unmanaged same-name Codex entry before invoking add", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(codexInspection(
      "C:\\Other\\unmanaged-server.exe",
      ["serve"],
    ));

    await expect(createCodexAdapter({ runner }).connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
    ]);
  });

  it("uses the marked TOML fallback only when the Codex MCP command is unavailable", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(new AiAdapterError("command_failed", {
      exitCode: 2,
      stderr: "error: unrecognized subcommand 'mcp'",
    }));
    const fallbackCalls: Array<{
      bridgeExecutable: string;
      connectionId: string;
    }> = [];
    const codex = createCodexAdapter({
      runner,
      config: {
        inspect: async () => "connected",
        connect: async (input) => {
          fallbackCalls.push(input);
        },
        prepareConnection: async (input) => ({
          apply: async () => {
            fallbackCalls.push(input);
          },
          rollback: async () => undefined,
        }),
        remove: async () => {},
      },
    });
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "opaque-1",
    };

    await expect(codex.connect(input)).resolves.toEqual({
      restartRequired: true,
    });
    expect(fallbackCalls).toEqual([input]);
  });

  it("does not hide ordinary Codex command failures behind the fallback", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(new AiAdapterError("command_failed", {
      exitCode: 1,
      stderr: "configuration is managed by policy",
    }));
    const codex = createCodexAdapter({ runner });

    await expect(codex.connect({
      bridgeExecutable: "C:\\IntentArc Bridge.exe",
      connectionId: "opaque-1",
    })).rejects.toMatchObject({ code: "command_failed" });
  });

  it("removes only the named IntentArc server through Codex", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(codexInspection(
      "C:\\Program Files\\IntentArc Bridge.exe",
      ["--connection", "connection-1"],
    ));

    await createCodexAdapter({ runner }).remove();

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc", "--json"],
      ["mcp", "remove", "intentarc"],
    ]);
  });

  it("refuses to remove an unmanaged same-name Codex entry", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(codexInspection("other-server", ["serve"]));

    await expect(createCodexAdapter({ runner }).remove()).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("requires manual launch instead of opening an unsafe shell", async () => {
    const runner = new RecordingRunner();

    await expect(createCodexAdapter({ runner }).launch({
      repositoryPath: "C:\\repo with spaces",
      request: { action: "project_setup", runId: "run-1" },
    })).resolves.toBe("manual_required");
    expect(runner.calls).toEqual([]);
  });
});

describe("createAiAdapterRegistry", () => {
  it("registers only the portable Codex and Claude Code adapters", () => {
    const runner = new RecordingRunner();

    const registry = createAiAdapterRegistry({ runner });

    expect([...registry.keys()]).toEqual(["codex", "claude-code"]);
    expect(registry.get("codex")?.id).toBe("codex");
    expect(registry.get("claude-code")?.id).toBe("claude-code");
  });

  it("injects Codex product presence into CLI availability detection", async () => {
    const runner = new RecordingRunner();
    runner.executable = null;
    const registry = createAiAdapterRegistry({
      runner,
      codexProductPresence: codexProductPresence(true),
    });

    await expect(registry.get("codex")?.detect()).resolves.toEqual({
      availability: "setup_required",
      reason: "cli_missing",
      version: null,
    });
  });
});
