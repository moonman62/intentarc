import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProfileService } from "../../core/profile-service.js";
import type {
  AiAdapterId,
  AiAvailabilityReason,
  AiClientAdapter,
  AiConnectionStatus,
  AiConnectorAvailability,
} from "../adapters/types.js";
import type { AiAdapterRegistry } from "../adapters/registry.js";
import type {
  DesktopManualConnection,
  DesktopManagedConnection,
  DesktopSettings,
  DesktopSettingsStore,
} from "../settings.js";

export interface DesktopAiConnectionState {
  readonly adapterId: AiAdapterId;
  readonly status: AiConnectionStatus;
  readonly availability: AiConnectorAvailability;
  readonly availabilityReason: AiAvailabilityReason;
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
  readonly adapterId: AiAdapterId;
  readonly status: "connected";
  readonly profileId: string;
  readonly restartRequired: boolean;
}

export interface DesktopAiRemoveResult {
  readonly adapterId: AiAdapterId;
  readonly status: "not_connected";
  readonly profileId: string | null;
}

export interface DesktopAiLaunchInput {
  readonly adapterId: AiAdapterId;
  readonly repositoryPath: string;
  readonly request?: {
    readonly action: "project_setup";
    readonly runId: string;
  };
}

export interface DesktopAiLaunchResult {
  readonly adapterId: AiAdapterId;
  readonly result: "launched" | "manual_required";
}

export interface DesktopConnectionService {
  list(): Promise<DesktopAiCatalog>;
  createManual(input: {
    readonly label: string;
  }): Promise<DesktopManualConnectionSetup>;
  removeManual(id: string): Promise<{ readonly id: string }>;
  connect(adapterId: AiAdapterId): Promise<DesktopAiConnectResult>;
  test(adapterId: AiAdapterId): Promise<DesktopAiConnectionState>;
  remove(adapterId: AiAdapterId): Promise<DesktopAiRemoveResult>;
  launchForProject(input: DesktopAiLaunchInput): Promise<DesktopAiLaunchResult>;
}

export interface BridgeHealthCheckInput {
  readonly bridgeExecutable: string;
  readonly connectionId: string;
  readonly profileId: string;
}

export interface BridgeHealthChecker {
  check(input: BridgeHealthCheckInput): Promise<void>;
}

export interface CreateDesktopConnectionServiceOptions {
  readonly profiles: ProfileService;
  readonly settings: DesktopSettingsStore;
  readonly adapters: AiAdapterRegistry;
  readonly bridgeExecutable: string;
  readonly health?: BridgeHealthChecker;
  readonly now?: () => string;
  readonly newConnectionId?: () => string;
}

interface BridgeHealthClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  close(): Promise<void>;
}

interface BridgeHealthTransport {
  readonly stderr?: {
    on(event: "data", listener: () => void): unknown;
  } | null;
}

export interface CreateBridgeHealthCheckerOptions {
  readonly timeoutMilliseconds?: number;
  readonly environment?: Partial<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly createTransport?: (
    input: StdioServerParameters,
  ) => BridgeHealthTransport;
  readonly createClient?: () => BridgeHealthClient;
}

const adapterLabels: Readonly<Record<AiAdapterId, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

const profileFor = (
  profiles: ProfileService,
  profileId: string,
) => profiles.listProfiles().find(({ profile }) => profile.id === profileId);

const connectionFor = (
  settings: DesktopSettings,
  adapterId: AiAdapterId,
): DesktopManagedConnection | undefined =>
  settings.connections.find(
    (connection): connection is DesktopManagedConnection =>
      connection.kind === "managed" && connection.adapterId === adapterId,
  );

const manualConnectionFor = (
  settings: DesktopSettings,
  id: string,
): DesktopManualConnection | undefined =>
  settings.connections.find(
    (connection): connection is DesktopManualConnection =>
      connection.kind === "manual-mcp" && connection.id === id,
  );

const requiredAdapter = (
  adapters: AiAdapterRegistry,
  adapterId: AiAdapterId,
): AiClientAdapter => {
  const adapter = adapters.get(adapterId);
  if (!adapter) throw new Error("Unsupported desktop AI adapter.");
  return adapter;
};

const windowsBridgeEnvironmentKeys = [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMFILES",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
] as const;
const posixBridgeEnvironmentKeys = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
] as const;

export const createBridgeHealthEnvironment = (
  environment: Partial<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> => {
  const keys = platform === "win32"
    ? windowsBridgeEnvironmentKeys
    : posixBridgeEnvironmentKeys;
  const selected: Record<string, string> = {};
  for (const key of keys) {
    const value = environment[key];
    if (value === undefined || value.startsWith("()")) continue;
    selected[key] = value;
  }
  return selected;
};

const withTimeout = async <Result>(
  operation: Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("IntentArc bridge health check timed out.")),
          timeoutMilliseconds,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const createBridgeHealthChecker = ({
  timeoutMilliseconds = 10_000,
  environment = process.env,
  platform = process.platform,
  createTransport = (input) => new StdioClientTransport(input),
  createClient = () => {
    const client = new Client({
      name: "IntentArc Desktop connection check",
      version: "0.1.0",
    });
    return {
      connect: (transport: unknown) =>
        client.connect(transport as Transport),
      listTools: () => client.listTools(),
      close: () => client.close(),
    };
  },
}: CreateBridgeHealthCheckerOptions = {}): BridgeHealthChecker => ({
  async check(input): Promise<void> {
    const transport = createTransport({
      command: input.bridgeExecutable,
      args: ["--connection", input.connectionId],
      env: createBridgeHealthEnvironment(environment, platform),
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = createClient();

    try {
      await withTimeout(client.connect(transport), timeoutMilliseconds);
      const tools = await withTimeout(client.listTools(), timeoutMilliseconds);
      if (!tools.tools.some(({ name }) => name === "submit_change_set")) {
        throw new Error("IntentArc bridge profile authentication failed.");
      }
    } catch (error) {
      throw new Error("IntentArc bridge health check failed.", {
        cause: error,
      });
    } finally {
      await withTimeout(client.close(), timeoutMilliseconds).catch(() => undefined);
    }
  },
});

const replaceConnection = (
  settings: DesktopSettings,
  previous: DesktopManagedConnection | undefined,
  next: DesktopManagedConnection,
): DesktopSettings => ({
  ...settings,
  connections: previous
    ? settings.connections.map((connection) =>
        connection.id === previous.id ? next : connection)
    : [...settings.connections, next],
});

const sameConnection = (
  left: DesktopManagedConnection,
  right: DesktopManagedConnection,
): boolean =>
  left.id === right.id &&
  left.adapterId === right.adapterId &&
  left.profileId === right.profileId &&
  left.profileToken === right.profileToken &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt;

const sameManualConnection = (
  left: DesktopManualConnection,
  right: DesktopManualConnection,
): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.profileId === right.profileId &&
  left.profileToken === right.profileToken &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt;

const manualSummary = (
  connection: DesktopManualConnection,
): DesktopManualConnectionSummary => ({
  id: connection.id,
  label: connection.label,
  profileId: connection.profileId,
  state: "setup_created",
  createdAt: connection.createdAt,
});

export const createDesktopConnectionService = ({
  profiles,
  settings,
  adapters,
  bridgeExecutable,
  health = createBridgeHealthChecker(),
  now = () => new Date().toISOString(),
  newConnectionId = randomUUID,
}: CreateDesktopConnectionServiceOptions): DesktopConnectionService => {
  let mutationTail = Promise.resolve();
  const failedHealthAdapters = new Set<AiAdapterId>();
  const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const connectionState = async (
    adapter: AiClientAdapter,
    respectFailedHealth = true,
  ): Promise<DesktopAiConnectionState> => {
    const currentSettings = settings.read();
    const connection = connectionFor(currentSettings, adapter.id);
    const summary = connection
      ? profileFor(profiles, connection.profileId)
      : undefined;
    let detected;
    try {
      detected = await adapter.detect();
    } catch {
      return {
        adapterId: adapter.id,
        status: summary ? "unknown" : "not_connected",
        availability: "setup_required",
        availabilityReason: "probe_failed",
        version: null,
        profileId: connection?.profileId ?? null,
      };
    }

    if (detected.availability !== "ready") {
      return {
        adapterId: adapter.id,
        status: summary ? "unknown" : "not_connected",
        availability: detected.availability,
        availabilityReason: detected.reason,
        version: detected.version,
        profileId: connection?.profileId ?? null,
      };
    }

    let status: AiConnectionStatus;
    try {
      status = await adapter.inspect();
    } catch {
      return {
        adapterId: adapter.id,
        status: "unknown",
        availability: detected.availability,
        availabilityReason: detected.reason,
        version: detected.version,
        profileId: connection?.profileId ?? null,
      };
    }
    if (connection && summary?.profile.status === "disabled") {
      status = "not_connected";
    } else if (status === "connected" && (!connection || !summary)) {
      status = "unknown";
    } else if (
      status === "connected" &&
      respectFailedHealth &&
      failedHealthAdapters.has(adapter.id)
    ) {
      status = "unknown";
    }
    return {
      adapterId: adapter.id,
      status,
      availability: detected.availability,
      availabilityReason: detected.reason,
      version: detected.version,
      profileId: connection?.profileId ?? null,
    };
  };

  const connect = async (
    adapterId: AiAdapterId,
  ): Promise<DesktopAiConnectResult> => {
    const adapter = requiredAdapter(adapters, adapterId);
    const originalSettings = settings.read();
    const previous = connectionFor(originalSettings, adapterId);
    const previousProfile = previous
      ? profileFor(profiles, previous.profileId)
      : undefined;
    let connection = previous;
    let createdProfileId: string | undefined;
    let enabledForReconnect = false;
    let adapterAttempt:
      | Awaited<ReturnType<AiClientAdapter["prepareConnection"]>>
      | undefined;
    let adapterApplyStarted = false;

    if (!connection || !previousProfile) {
      const created = profiles.createProfile({
        name: adapterLabels[adapterId],
        executionMode: "safe",
      });
      createdProfileId = created.profile.id;
      const timestamp = now();
      connection = {
        id: newConnectionId(),
        kind: "managed",
        adapterId,
        profileId: created.profile.id,
        profileToken: created.token,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        const currentSettings = settings.read();
        if (previous) {
          const currentPrevious = currentSettings.connections.find(
            ({ id }) => id === previous.id,
          );
          if (
            !currentPrevious ||
            currentPrevious.kind !== "managed" ||
            !sameConnection(currentPrevious, previous)
          ) {
            throw new Error("Desktop connection settings changed.");
          }
        }
        settings.write(
          replaceConnection(currentSettings, previous, connection),
        );
      } catch (error) {
        profiles.setEnabled(created.profile.id, false);
        throw error;
      }
    }

    try {
      const currentProfile = profileFor(profiles, connection.profileId);
      if (currentProfile?.profile.status === "disabled") {
        profiles.setEnabled(connection.profileId, true);
        enabledForReconnect = true;
      }
      adapterAttempt = await adapter.prepareConnection({
        bridgeExecutable,
        connectionId: connection.id,
      });
      await health.check({
        bridgeExecutable,
        connectionId: connection.id,
        profileId: connection.profileId,
      });
      adapterApplyStarted = true;
      const configured = await adapterAttempt.apply();
      failedHealthAdapters.delete(adapterId);
      return {
        adapterId,
        status: "connected",
        profileId: connection.profileId,
        restartRequired: configured.restartRequired,
      };
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (createdProfileId) {
        try {
          profiles.setEnabled(createdProfileId, false);
        } catch (failure) {
          rollbackFailures.push(failure);
        }
        try {
          const currentSettings = settings.read();
          const currentConnection = currentSettings.connections.find(
            ({ id }) => id === connection.id,
          );
          if (
            currentConnection?.kind === "managed" &&
            sameConnection(currentConnection, connection)
          ) {
            settings.write({
              ...currentSettings,
              connections: previous
                ? currentSettings.connections.map((candidate) =>
                    candidate.id === connection.id ? previous : candidate)
                : currentSettings.connections.filter(
                    ({ id }) => id !== connection.id,
                  ),
            });
          }
        } catch (failure) {
          rollbackFailures.push(failure);
        }
      } else if (enabledForReconnect) {
        try {
          profiles.setEnabled(connection.profileId, false);
        } catch (failure) {
          rollbackFailures.push(failure);
        }
      }
      if (adapterAttempt && adapterApplyStarted) {
        try {
          await adapterAttempt.rollback();
        } catch (failure) {
          rollbackFailures.push(failure);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "Desktop AI connection rollback failed.",
        );
      }
      throw error;
    }
  };

  const createManual = async (
    input: { readonly label: string },
  ): Promise<DesktopManualConnectionSetup> => {
    const created = profiles.createProfile({
      name: input.label,
      executionMode: "safe",
    });
    const timestamp = now();
    const connection: DesktopManualConnection = {
      id: newConnectionId(),
      kind: "manual-mcp",
      label: input.label,
      profileId: created.profile.id,
      profileToken: created.token,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      const currentSettings = settings.read();
      settings.write({
        ...currentSettings,
        connections: [...currentSettings.connections, connection],
      });
      await health.check({
        bridgeExecutable,
        connectionId: connection.id,
        profileId: connection.profileId,
      });
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      try {
        profiles.setEnabled(connection.profileId, false);
      } catch (failure) {
        rollbackFailures.push(failure);
      }
      try {
        const currentSettings = settings.read();
        const currentConnection = manualConnectionFor(
          currentSettings,
          connection.id,
        );
        if (
          currentConnection &&
          sameManualConnection(currentConnection, connection)
        ) {
          settings.write({
            ...currentSettings,
            connections: currentSettings.connections.filter(
              ({ id }) => id !== connection.id,
            ),
          });
        }
      } catch (failure) {
        rollbackFailures.push(failure);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "Manual MCP connection rollback failed.",
        );
      }
      throw error;
    }

    return {
      ...manualSummary(connection),
      command: bridgeExecutable,
      args: ["--connection", connection.id],
    };
  };

  return {
    list: async () => {
      const currentSettings = settings.read();
      return {
        automatic: await Promise.all(
          [...adapters.values()].map((adapter) => connectionState(adapter)),
        ),
        manual: currentSettings.connections
          .filter(
            (connection): connection is DesktopManualConnection =>
              connection.kind === "manual-mcp",
          )
          .map(manualSummary),
      };
    },

    createManual: (input) => serialize(() => createManual(input)),

    removeManual: (id) =>
      serialize(async () => {
        const originalSettings = settings.read();
        const connection = manualConnectionFor(originalSettings, id);
        if (!connection) throw new Error("Unknown manual MCP connection.");

        const summary = profileFor(profiles, connection.profileId);
        if (summary?.profile.status === "enabled") {
          profiles.setEnabled(connection.profileId, false);
        }

        const currentSettings = settings.read();
        const currentConnection = manualConnectionFor(currentSettings, id);
        if (
          !currentConnection ||
          !sameManualConnection(currentConnection, connection)
        ) {
          throw new Error("Desktop connection settings changed.");
        }
        settings.write({
          ...currentSettings,
          connections: currentSettings.connections.filter(
            ({ id: candidateId }) => candidateId !== id,
          ),
        });
        return { id };
      }),

    connect: (adapterId) => serialize(() => connect(adapterId)),

    async test(adapterId): Promise<DesktopAiConnectionState> {
      const adapter = requiredAdapter(adapters, adapterId);
      const state = await connectionState(adapter, false);
      if (state.status !== "connected" || state.profileId === null) return state;
      const connection = connectionFor(settings.read(), adapterId);
      if (!connection) {
        return { ...state, status: "unknown", profileId: null };
      }
      try {
        await health.check({
          bridgeExecutable,
          connectionId: connection.id,
          profileId: connection.profileId,
        });
      } catch (error) {
        failedHealthAdapters.add(adapterId);
        throw error;
      }
      failedHealthAdapters.delete(adapterId);
      return state;
    },

    remove: (adapterId) =>
      serialize(async () => {
        const adapter = requiredAdapter(adapters, adapterId);
        const connection = connectionFor(settings.read(), adapterId);
        if (connection) {
          const summary = profileFor(profiles, connection.profileId);
          if (summary?.profile.status === "enabled") {
            profiles.setEnabled(connection.profileId, false);
          }
        }
        await adapter.remove();
        failedHealthAdapters.delete(adapterId);
        return {
          adapterId,
          status: "not_connected",
          profileId: connection?.profileId ?? null,
        };
      }),

    async launchForProject(input): Promise<DesktopAiLaunchResult> {
      const adapter = requiredAdapter(adapters, input.adapterId);
      const result = await adapter.launch({
        repositoryPath: input.repositoryPath,
        ...(input.request === undefined ? {} : { request: input.request }),
      });
      return { adapterId: input.adapterId, result };
    },
  };
};
