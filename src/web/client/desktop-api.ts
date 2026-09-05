export type DesktopAiAdapterId = "codex" | "claude-code";

export type DesktopAiConnectionStatus =
  | "connected"
  | "not_connected"
  | "unknown";

export type DesktopAiConnectorAvailability =
  | "ready"
  | "setup_required"
  | "not_detected";

export type DesktopAiAvailabilityReason =
  | "connector_ready"
  | "not_installed"
  | "cli_missing"
  | "access_blocked"
  | "unsupported_version"
  | "probe_failed";

export interface DesktopAiConnectionState {
  readonly adapterId: DesktopAiAdapterId;
  readonly status: DesktopAiConnectionStatus;
  readonly availability: DesktopAiConnectorAvailability;
  readonly availabilityReason: DesktopAiAvailabilityReason;
  readonly version: string | null;
  readonly profileId: string | null;
}

export interface DesktopAiCatalog {
  readonly automatic: DesktopAiConnectionState[];
  readonly manual: DesktopManualConnectionSummary[];
}

export interface DesktopManualConnectionSummary {
  readonly id: string;
  readonly label: string;
  readonly profileId: string;
  readonly state: "setup_created";
  readonly createdAt: string;
}

export interface DesktopManualConnectionSetup
  extends DesktopManualConnectionSummary {
  readonly command: string;
  readonly args: readonly ["--connection", string];
}

export interface DesktopAiConnectResult {
  readonly adapterId: DesktopAiAdapterId;
  readonly status: "connected";
  readonly profileId: string;
  readonly restartRequired: boolean;
}

export interface DesktopAiRemoveResult {
  readonly adapterId: DesktopAiAdapterId;
  readonly status: "not_connected";
  readonly profileId: string | null;
}

export interface DesktopAiLaunchInput {
  readonly adapterId: DesktopAiAdapterId;
  readonly repositoryPath: string;
  readonly request?: {
    readonly action: "project_setup";
    readonly runId: string;
  };
}

export interface DesktopAiLaunchResult {
  readonly adapterId: DesktopAiAdapterId;
  readonly result: "launched" | "manual_required";
}

export interface DesktopAiApi {
  list(): Promise<DesktopAiCatalog>;
  createManual(input: {
    readonly label: string;
  }): Promise<DesktopManualConnectionSetup>;
  removeManual(id: string): Promise<{ readonly id: string }>;
  connect(adapterId: DesktopAiAdapterId): Promise<DesktopAiConnectResult>;
  test(adapterId: DesktopAiAdapterId): Promise<DesktopAiConnectionState>;
  remove(adapterId: DesktopAiAdapterId): Promise<DesktopAiRemoveResult>;
  launchForProject(
    input: DesktopAiLaunchInput,
  ): Promise<DesktopAiLaunchResult>;
}

export interface DesktopLifecycleState {
  readonly archivePath: string;
  readonly onboardingCompleted: boolean;
  readonly restartRequired: boolean;
}

export interface DesktopLifecycleApi {
  getState(): Promise<DesktopLifecycleState>;
  chooseArchive(): Promise<DesktopLifecycleState>;
  completeOnboarding(): Promise<DesktopLifecycleState>;
  restart(): Promise<{ readonly restarting: true }>;
}

export type DesktopUpdateStatus =
  | { readonly state: "disabled" }
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available" }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "error" };

export interface DesktopUpdatesApi {
  getStatus(): Promise<DesktopUpdateStatus>;
  applyAndRestart(): Promise<{ readonly restarting: boolean }>;
}

export interface DesktopDocumentsApi {
  readonly externalOpenAvailable: true;
  openRepositoryFile(
    projectId: string,
    nodeId: string,
  ): Promise<{ readonly opened: true }>;
  openExternalHttps(url: string): Promise<{ readonly opened: true }>;
}

export interface DesktopRepositoryApi {
  chooseRepositoryDirectory(): Promise<string | null>;
}

export interface IntentArcDesktopApi {
  readonly ai: DesktopAiApi;
  readonly lifecycle: DesktopLifecycleApi;
  readonly updates: DesktopUpdatesApi;
  readonly documents: DesktopDocumentsApi;
  readonly repository: DesktopRepositoryApi;
}

declare global {
  interface Window {
    intentArcDesktop?: IntentArcDesktopApi;
  }
}

export const getDesktopApi = (): IntentArcDesktopApi | null =>
  window.intentArcDesktop ?? null;
