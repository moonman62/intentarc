import { describe, expect, it } from "vitest";
import { createCodexProductPresenceProbe } from "./codex-presence.js";
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from "./types.js";

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];

  constructor(private readonly outcome: CommandResult | Error) {}

  async findExecutable(): Promise<string | null> {
    return null;
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
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const resolvedPowerShell =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const createWindowsProbe = (runner: CommandRunner) =>
  createCodexProductPresenceProbe({
    runner,
    platform: "win32",
    environment: {
      PATH: "C:\\untrusted",
      SystemRoot: "C:\\untrusted-root",
      KEEP: "safe",
    },
    resolveNative: () => resolvedPowerShell,
  });

describe("Codex product presence", () => {
  it("queries exactly the Codex Store package through OS-rooted Windows PowerShell", async () => {
    const runner = new RecordingRunner({ stdout: "present\r\n", stderr: "" });

    await expect(createWindowsProbe(runner).detect()).resolves.toBe(true);
    expect(runner.calls).toEqual([{
      command: resolvedPowerShell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if (Get-AppxPackage -Name 'OpenAI.Codex') { [Console]::Out.Write('present') }",
      ],
      options: {
        environment: {
          KEEP: "safe",
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
        },
      },
    }]);
  });

  it("reports the Codex Store package as absent for empty output", async () => {
    const runner = new RecordingRunner({ stdout: "", stderr: "" });

    await expect(createWindowsProbe(runner).detect()).resolves.toBe(false);
  });

  it("rejects a non-terminating Get-AppxPackage error reported on stderr", async () => {
    const stderr = [
      "Get-AppxPackage : Access is denied.",
      "At line:1 char:5",
      "+ if (Get-AppxPackage -Name 'OpenAI.Codex') { ... }",
    ].join("\r\n");
    const runner = new RecordingRunner({ stdout: "", stderr });

    await expect(createWindowsProbe(runner).detect()).rejects.toMatchObject({
      code: "command_failed",
      details: { stderr },
    });
  });

  it("does not spawn a product probe outside Windows", async () => {
    const runner = new RecordingRunner(new Error("must not run"));
    const probe = createCodexProductPresenceProbe({
      runner,
      platform: "linux",
      environment: {},
      resolveNative: () => {
        throw new Error("must not resolve");
      },
    });

    await expect(probe.detect()).resolves.toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("rejects command failures for availability isolation", async () => {
    const failure = new Error("PowerShell failed");
    const runner = new RecordingRunner(failure);

    await expect(createWindowsProbe(runner).detect()).rejects.toBe(failure);
  });
});
