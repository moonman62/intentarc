export type AiAdapterId = "codex" | "claude-code";

export type AiConnectionStatus = "connected" | "not_connected" | "unknown";

export type AiConnectorAvailability =
  | "ready"
  | "setup_required"
  | "not_detected";

export type AiAvailabilityReason =
  | "connector_ready"
  | "not_installed"
  | "cli_missing"
  | "access_blocked"
  | "unsupported_version"
  | "probe_failed";

export interface AiAdapterDetection {
  readonly availability: AiConnectorAvailability;
  readonly reason: AiAvailabilityReason;
  readonly version: string | null;
}

export type AiAdapterErrorCode =
  | "access_denied"
  | "executable_missing"
  | "command_failed"
  | "command_timeout"
  | "command_cleanup_failed"
  | "unsupported_output"
  | "configuration_conflict"
  | "compensation_conflict"
  | "configuration_invalid"
  | "configuration_failed";

export interface AiAdapterErrorDetails {
  readonly exitCode?: number;
  readonly stderr?: string;
}

const adapterErrorMessage = (code: AiAdapterErrorCode): string =>
  ({
    access_denied: "The AI client executable could not be accessed.",
    executable_missing: "The AI client executable is unavailable.",
    command_failed: "The AI client command failed.",
    command_timeout: "The AI client command timed out.",
    command_cleanup_failed: "The AI client command could not be safely terminated.",
    unsupported_output: "The AI client returned unsupported output.",
    configuration_conflict: "The AI client configuration is owned by another source.",
    compensation_conflict: "The AI client configuration changed during rollback.",
    configuration_invalid: "The AI client configuration is invalid.",
    configuration_failed: "The AI client configuration could not be updated.",
  })[code];

export class AiAdapterError extends Error {
  readonly code: AiAdapterErrorCode;
  readonly details: Readonly<AiAdapterErrorDetails>;

  constructor(
    code: AiAdapterErrorCode,
    details: Readonly<AiAdapterErrorDetails> = {},
    options?: ErrorOptions,
  ) {
    super(adapterErrorMessage(code), options);
    this.name = "AiAdapterError";
    this.code = code;
    this.details = details;
  }
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  findExecutable(name: string): Promise<string | null>;
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export interface AiConnectionAttempt {
  apply(): Promise<{ restartRequired: boolean }>;
  rollback(): Promise<void>;
}

export interface AiClientAdapter {
  readonly id: AiAdapterId;
  detect(): Promise<AiAdapterDetection>;
  inspect(): Promise<AiConnectionStatus>;
  prepareConnection(input: {
    bridgeExecutable: string;
    connectionId: string;
  }): Promise<AiConnectionAttempt>;
  connect(input: {
    bridgeExecutable: string;
    connectionId: string;
  }): Promise<{ restartRequired: boolean }>;
  remove(): Promise<void>;
  launch(input: {
    repositoryPath: string;
    request?: { action: "project_setup"; runId: string };
  }): Promise<"launched" | "manual_required">;
}
