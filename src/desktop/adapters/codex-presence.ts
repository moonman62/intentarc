import { resolveWindowsPowerShellInvocation } from "../../system/windows-powershell.js";
import { AiAdapterError, type CommandRunner } from "./types.js";

export interface CodexProductPresenceProbe {
  detect(): Promise<boolean>;
}

export interface CreateCodexProductPresenceProbeOptions {
  readonly runner: CommandRunner;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveNative?: (path: string) => string;
}

const CODEX_PRODUCT_QUERY =
  "if (Get-AppxPackage -Name 'OpenAI.Codex') { [Console]::Out.Write('present') }";

export const createCodexProductPresenceProbe = ({
  runner,
  platform = process.platform,
  environment = process.env,
  resolveNative,
}: CreateCodexProductPresenceProbeOptions): CodexProductPresenceProbe => ({
  detect: async () => {
    if (platform !== "win32") return false;
    const powerShell = resolveWindowsPowerShellInvocation(
      environment,
      resolveNative,
    );
    const result = await runner.run(powerShell.executablePath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      CODEX_PRODUCT_QUERY,
    ], {
      environment: powerShell.environment,
    });
    if (result.stderr.trim().length > 0) {
      throw new AiAdapterError("command_failed", { stderr: result.stderr });
    }
    return result.stdout.trim() === "present";
  },
});
