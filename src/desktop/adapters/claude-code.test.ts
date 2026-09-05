import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";
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
  executable: string | null = "C:\\Tools\\claude.exe";
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

const claudeInspection = (input: {
  readonly serverName?: string;
  readonly bridgeExecutable: string;
  readonly connectionId: string;
  readonly status?: string;
}): CommandResult => ({
  stdout: [
    `${input.serverName ?? "intentarc"}:`,
    "  Scope: User config (available in all your projects)",
    `  Status: ${input.status ?? "✓ Connected"}`,
    "  Type: stdio",
    `  Command: ${input.bridgeExecutable}`,
    `  Args: --connection ${input.connectionId}`,
    "  Environment:",
    "",
  ].join("\n"),
  stderr: "",
});

describe("Claude Code adapter", () => {
  it("uses a supplied server name for missing detection, inspection, and connect commands", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-claude-00000000-0000-4000-8000-000000000002";
    const bridgeExecutable = "C:\\Program Files\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: `No MCP server named \"${serverName}\" in user scope`,
      }),
      { stdout: "", stderr: "" },
      claudeInspection({ serverName, bridgeExecutable, connectionId }),
    );

    await expect(createClaudeCodeAdapter({ runner, serverName }).connect({
      bridgeExecutable,
      connectionId,
    })).resolves.toEqual({ restartRequired: true });

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", serverName],
      ["mcp", "add", "--transport", "stdio", "--scope", "user", serverName, "--", bridgeExecutable, "--connection", connectionId],
      ["mcp", "get", serverName],
    ]);
  });

  it("uses a supplied server name for rollback compensation and removal", async () => {
    const runner = new RecordingRunner();
    const serverName = "intentarc-acceptance-claude-00000000-0000-4000-8000-000000000002";
    const bridgeExecutable = "C:\\Program Files\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: `No MCP server named \"${serverName}\" in user scope`,
      }),
      { stdout: "", stderr: "" },
      claudeInspection({
        serverName,
        bridgeExecutable: "C:\\Other\\server.exe",
        connectionId: "other",
      }),
      claudeInspection({ serverName, bridgeExecutable, connectionId }),
      { stdout: "", stderr: "" },
      claudeInspection({ serverName, bridgeExecutable, connectionId }),
      { stdout: "", stderr: "" },
    );
    const adapter = createClaudeCodeAdapter({ runner, serverName });

    await expect(adapter.connect({ bridgeExecutable, connectionId }))
      .rejects.toMatchObject({ code: "configuration_failed" });
    await expect(adapter.remove()).resolves.toBeUndefined();

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["mcp", "get", serverName],
      ["mcp", "add", "--transport", "stdio", "--scope", "user", serverName, "--", bridgeExecutable, "--connection", connectionId],
      ["mcp", "get", serverName],
      ["mcp", "get", serverName],
      ["mcp", "remove", "--scope", "user", serverName],
      ["mcp", "get", serverName],
      ["mcp", "remove", "--scope", "user", serverName],
    ]);
  });

  it("rejects an invalid supplied server name before invoking Claude Code", () => {
    const runner = new RecordingRunner();

    expect(() => createClaudeCodeAdapter({ runner, serverName: "intentarc unsafe" }))
      .toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    expect(runner.calls).toEqual([]);
  });

  it("connects the stable bridge at user scope with separate arguments", async () => {
    const claudeRunner = new RecordingRunner();
    const bridgeExecutable =
      "C:\\Program Files\\IntentArc\\bridge\\current\\IntentArc Bridge.exe";
    const connectionId = "connection-1";
    const claude = createClaudeCodeAdapter({ runner: claudeRunner });
    claudeRunner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: 'No MCP server named "intentarc" in user scope',
      }),
      { stdout: "Added stdio MCP server intentarc", stderr: "" },
      {
        stdout: [
          "intentarc:",
          "  Scope: User config (available in all your projects)",
          "  Status: ✓ Connected",
          "  Type: stdio",
          `  Command: ${bridgeExecutable}`,
          `  Args: --connection ${connectionId}`,
          "  Environment:",
          "",
        ].join("\n"),
        stderr: "",
      },
    );

    await expect(claude.connect({
      bridgeExecutable,
      connectionId,
    })).resolves.toEqual({ restartRequired: true });
    expect(claudeRunner.calls[0]?.args).toEqual([
      "mcp",
      "get",
      "intentarc",
    ]);
    expect(claudeRunner.calls[1]?.args).toEqual([
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      "intentarc",
      "--",
      bridgeExecutable,
      "--connection",
      connectionId,
    ]);
    expect(claudeRunner.calls[2]?.args).toEqual([
      "mcp",
      "get",
      "intentarc",
    ]);
  });

  it("rejects an add that does not persist the requested bridge connection", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    };
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: 'No MCP server named "intentarc" in user scope',
      }),
      { stdout: "Added stdio MCP server intentarc", stderr: "" },
      {
        stdout: [
          "intentarc:",
          "  Scope: User config (available in all your projects)",
          "  Status: ✓ Connected",
          "  Type: stdio",
          "  Command: C:\\Other\\server.exe",
          "  Args: serve",
          "  Environment:",
          "",
        ].join("\n"),
        stderr: "",
      },
    );

    await expect(createClaudeCodeAdapter({ runner }).connect(input))
      .rejects.toMatchObject({ code: "configuration_failed" });
  });

  it("detects Claude Code and extracts its version", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      stdout: "2.1.187 (Claude Code)\n",
      stderr: "",
    });

    await expect(createClaudeCodeAdapter({ runner }).detect()).resolves.toEqual({
      availability: "ready",
      reason: "connector_ready",
      version: "2.1.187",
    });
  });

  it("reports Claude Code as not installed when no executable is detected", async () => {
    const runner = new RecordingRunner();
    runner.executable = null;

    await expect(createClaudeCodeAdapter({ runner }).detect()).resolves.toEqual({
      availability: "not_detected",
      reason: "not_installed",
      version: null,
    });
  });

  it("reports unsupported Claude Code version output as setup required", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ stdout: "Claude Code release unknown", stderr: "" });

    await expect(createClaudeCodeAdapter({ runner }).detect()).resolves.toEqual({
      availability: "setup_required",
      reason: "unsupported_version",
      version: null,
    });
  });

  it.each([
    ["access_denied", "access_blocked"],
    ["executable_missing", "cli_missing"],
  ] as const)(
    "maps a %s Claude Code version probe to %s",
    async (code, reason) => {
      const runner = new RecordingRunner();
      runner.outcomes.push(new AiAdapterError(code));

      await expect(createClaudeCodeAdapter({ runner }).detect()).resolves.toEqual({
        availability: "setup_required",
        reason,
        version: null,
      });
    },
  );

  it("inspects the named user-scoped server", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      stdout: [
        "intentarc:",
        "  Scope: User config (available in all your projects)",
        "  Status: ✓ Connected",
        "  Type: stdio",
        "  Command: C:\\Program Files\\IntentArc Bridge.exe",
        "  Args: --connection connection-1",
        "  Environment:",
        "",
      ].join("\n"),
      stderr: "",
    });

    await expect(createClaudeCodeAdapter({ runner }).inspect()).resolves.toBe(
      "connected",
    );
    expect(runner.calls[0]?.args).toEqual(["mcp", "get", "intentarc"]);
  });

  it.each([
    "× Failed to connect",
    "⏸ Pending approval (run claude to approve)",
    "× Rejected (see disabledMcpjsonServers in settings)",
  ])("maps an unhealthy %s server to unknown", async (status) => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      stdout: [
        "intentarc:",
        "  Scope: User config (available in all your projects)",
        `  Status: ${status}`,
        "  Type: stdio",
        "  Command: C:\\Program Files\\IntentArc Bridge.exe",
        "  Args: --connection connection-1",
        "  Environment:",
        "",
      ].join("\n"),
      stderr: "",
    });

    await expect(createClaudeCodeAdapter({ runner }).inspect()).resolves.toBe(
      "unknown",
    );
  });

  it("replays an exact existing user-scoped connection without adding it again", async () => {
    const runner = new RecordingRunner();
    const input = {
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    };
    runner.outcomes.push({
      stdout: [
        "intentarc:",
        "  Scope: User config (available in all your projects)",
        "  Status: × Failed to connect",
        "  Type: stdio",
        `  Command: ${input.bridgeExecutable}`,
        `  Args: --connection ${input.connectionId}`,
        "  Environment:",
        "",
      ].join("\n"),
      stderr: "",
    });

    await expect(
      createClaudeCodeAdapter({ runner }).connect(input),
    ).resolves.toEqual({ restartRequired: true });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc"],
    ]);
  });

  it("refuses a conflicting same-name Claude server before mutation", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      stdout: [
        "intentarc:",
        "  Scope: User config (available in all your projects)",
        "  Status: ✓ Connected",
        "  Type: stdio",
        "  Command: C:\\Other\\server.exe",
        "  Args: serve",
        "  Environment:",
        "",
      ].join("\n"),
      stderr: "",
    });

    await expect(createClaudeCodeAdapter({ runner }).connect({
      bridgeExecutable: "C:\\Program Files\\IntentArc Bridge.exe",
      connectionId: "connection-1",
    })).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects empty successful inspection output as unsupported", async () => {
    const runner = new RecordingRunner();

    await expect(createClaudeCodeAdapter({ runner }).inspect()).rejects.toMatchObject({
      code: "unsupported_output",
    });
  });

  it("removes only the user-scoped IntentArc server", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      stdout: [
        "intentarc:",
        "  Scope: User config (available in all your projects)",
        "  Status: × Failed to connect",
        "  Type: stdio",
        "  Command: C:\\Program Files\\IntentArc Bridge.exe",
        "  Args: --connection connection-1",
        "  Environment:",
        "",
      ].join("\n"),
      stderr: "",
    });

    await createClaudeCodeAdapter({ runner }).remove();

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc"],
      [
      "mcp",
      "remove",
      "--scope",
      "user",
      "intentarc",
      ],
    ]);
  });

  it("treats an already-absent user-scoped removal as success", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: 'No MCP server named "intentarc" in user scope',
      }),
    );

    await expect(createClaudeCodeAdapter({ runner }).remove()).resolves.toBeUndefined();
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["mcp", "get", "intentarc"],
    ]);
  });

  it.each([
    'No MCP server named "intentarc-other" in user scope',
    'No MCP server named "other-intentarc" in user scope',
    'MCP server intentarc.other does not exist.',
    'No MCP server named "intentarc\' in user scope',
    "No MCP server named 'intentarc` in user scope",
  ])("does not accept a longer prefix-collision missing name: %s", async (stderr) => {
    const runner = new RecordingRunner();
    runner.outcomes.push(new AiAdapterError("command_failed", {
      exitCode: 1,
      stderr,
    }));

    await expect(createClaudeCodeAdapter({ runner }).inspect())
      .rejects.toMatchObject({ code: "command_failed" });
  });

  it.each([
    'No MCP server named "intentarc" in user scope.',
    "No MCP server named 'INTENTARC' in user scope!",
    "MCP server `IntentArc` does not exist.",
    "MCP server intentarc not found.",
  ])("accepts only the exact missing name across casing and punctuation: %s", async (stderr) => {
    const runner = new RecordingRunner();
    runner.outcomes.push(new AiAdapterError("command_failed", {
      exitCode: 1,
      stderr,
    }));

    await expect(createClaudeCodeAdapter({ runner }).inspect())
      .resolves.toBe("not_connected");
  });

  it("treats a concurrent already-absent remove result as success", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(
      {
        stdout: [
          "intentarc:",
          "  Scope: User config (available in all your projects)",
          "  Status: × Failed to connect",
          "  Type: stdio",
          "  Command: C:\\Program Files\\IntentArc Bridge.exe",
          "  Args: --connection connection-1",
          "  Environment:",
          "",
        ].join("\n"),
        stderr: "",
      },
      new AiAdapterError("command_failed", {
        exitCode: 1,
        stderr: 'No MCP server named "intentarc" in user scope',
      }),
    );

    await expect(createClaudeCodeAdapter({ runner }).remove()).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(2);
  });

  it("requires manual launch instead of invoking a shell", async () => {
    const runner = new RecordingRunner();

    await expect(createClaudeCodeAdapter({ runner }).launch({
      repositoryPath: "C:\\repo",
    })).resolves.toBe("manual_required");
    expect(runner.calls).toEqual([]);
  });
});
