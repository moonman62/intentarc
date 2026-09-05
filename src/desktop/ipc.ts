import { isAbsolute, posix, win32 } from "node:path";
import { z } from "zod";
import { AiAdapterError } from "./adapters/types.js";
import { validateManualClientLabel } from "../domain/manual-client-label.js";
import type {
  DesktopConnectionService,
} from "./connections/service.js";
import type { DesktopSettingsStore } from "./settings.js";
import type {
  DesktopUpdateService,
  DesktopUpdateStatus,
} from "./updates.js";

export const DESKTOP_IPC_CHANNELS = {
  aiList: "intentarc:ai:list",
  aiConnect: "intentarc:ai:connect",
  aiCreateManual: "intentarc:ai:create-manual",
  aiTest: "intentarc:ai:test",
  aiRemove: "intentarc:ai:remove",
  aiRemoveManual: "intentarc:ai:remove-manual",
  aiLaunchForProject: "intentarc:ai:launch-for-project",
  lifecycleGetState: "intentarc:lifecycle:get-state",
  lifecycleChooseArchive: "intentarc:lifecycle:choose-archive",
  lifecycleCompleteOnboarding: "intentarc:lifecycle:complete-onboarding",
  lifecycleRestart: "intentarc:lifecycle:restart",
  updatesGetStatus: "intentarc:updates:get-status",
  updatesApplyAndRestart: "intentarc:updates:apply-and-restart",
  documentsOpenRepositoryFile: "intentarc:documents:open-repository-file",
  documentsOpenExternalHttps: "intentarc:documents:open-external-https",
  repositoryChooseDirectory: "intentarc:repository:choose-directory",
} as const;

export interface DesktopIpcMain {
  handle(
    channel: string,
    listener: (event: DesktopIpcEvent, payload?: unknown) => Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}

export interface DesktopIpcFrame {
  readonly url: string;
}

export interface DesktopIpcWebContents {
  readonly mainFrame: DesktopIpcFrame;
}

export interface DesktopIpcEvent {
  readonly sender: DesktopIpcWebContents;
  readonly senderFrame: DesktopIpcFrame;
}

export interface TrustedDesktopRenderer {
  readonly webContents: DesktopIpcWebContents;
  readonly mainFrame: DesktopIpcFrame;
  readonly origin: string;
}

export interface RegisterDesktopIpcHandlersOptions {
  readonly ipcMain: DesktopIpcMain;
  readonly connections: DesktopConnectionService;
  readonly documents?: {
    resolveExternalOpen(projectId: string, nodeId: string):
      | { status: "openable"; absolutePath: string }
      | { status: "stale" | "missing" | "unavailable" | "blocked" };
  };
  readonly openPath?: (absolutePath: string) => Promise<string>;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly updates?: DesktopUpdateService;
  readonly settings: DesktopSettingsStore;
  readonly defaultArchivePath: string;
  readonly activeArchivePath: string;
  readonly pathPlatform?: NodeJS.Platform;
  readonly trustedRenderer: TrustedDesktopRenderer;
  readonly selectArchivePath: () => Promise<string | null>;
  readonly selectRepositoryDirectory?: () => Promise<string | null>;
  readonly requestRelaunch: () => boolean;
}

const adapterIdSchema = z.enum(["codex", "claude-code"]);
const identifierSchema = z.string().trim().min(1).max(512);
const manualLabelSchema = z
  .string()
  .refine((value) => validateManualClientLabel(value).valid)
  .transform((value) => {
    const validation = validateManualClientLabel(value);
    return validation.valid ? validation.label : value.trim();
  });
const manualCreateInputSchema = z
  .object({ label: manualLabelSchema })
  .strict();
const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(32_767)
  .refine(
    (value) =>
      isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value),
    "An absolute path is required",
  );
const noInputSchema = z.undefined();
const optionalAbsolutePathSchema = absolutePathSchema.nullable();
const documentOpenInputSchema = z.object({
  projectId: identifierSchema,
  nodeId: identifierSchema,
}).strict();
const openedResultSchema = z.object({ opened: z.literal(true) }).strict();
const externalHttpsSchema = z.string().min(1).max(8_192).refine((value) => {
  if (
    value.trim() !== value ||
    !/^https:\/\/[^/?#\\]+(?:[/?#]|$)/.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== "";
  } catch {
    return false;
  }
});

const connectionStatusSchema = z.enum([
  "connected",
  "not_connected",
  "unknown",
]);
const connectorAvailabilitySchema = z.enum([
  "ready",
  "setup_required",
  "not_detected",
]);
const availabilityReasonSchema = z.enum([
  "connector_ready",
  "not_installed",
  "cli_missing",
  "access_blocked",
  "unsupported_version",
  "probe_failed",
]);
const connectionStateSchema = z
  .object({
    adapterId: adapterIdSchema,
    status: connectionStatusSchema,
    availability: connectorAvailabilitySchema,
    availabilityReason: availabilityReasonSchema,
    version: z.string().min(1).max(512).nullable(),
    profileId: identifierSchema.nullable(),
  })
  .strict();
const manualConnectionSummarySchema = z
  .object({
    id: identifierSchema,
    label: manualLabelSchema,
    profileId: identifierSchema,
    state: z.literal("setup_created"),
    createdAt: z.string().min(1).max(128),
  })
  .strict();
const manualConnectionSetupSchema = manualConnectionSummarySchema
  .extend({
    command: absolutePathSchema,
    args: z.tuple([z.literal("--connection"), identifierSchema]),
  })
  .strict()
  .refine(({ id, args }) => args[1] === id);
const manualRemoveResultSchema = z
  .object({ id: identifierSchema })
  .strict();
const aiCatalogSchema = z
  .object({
    automatic: z.array(connectionStateSchema),
    manual: z.array(manualConnectionSummarySchema),
  })
  .strict();
const connectResultSchema = z
  .object({
    adapterId: adapterIdSchema,
    status: z.literal("connected"),
    profileId: identifierSchema,
    restartRequired: z.boolean(),
  })
  .strict();
const removeResultSchema = z
  .object({
    adapterId: adapterIdSchema,
    status: z.literal("not_connected"),
    profileId: identifierSchema.nullable(),
  })
  .strict();
const launchInputSchema = z
  .object({
    adapterId: adapterIdSchema,
    repositoryPath: absolutePathSchema,
    request: z
      .object({
        action: z.literal("project_setup"),
        runId: identifierSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const launchResultSchema = z
  .object({
    adapterId: adapterIdSchema,
    result: z.enum(["launched", "manual_required"]),
  })
  .strict();
const lifecycleStateSchema = z
  .object({
    archivePath: absolutePathSchema,
    onboardingCompleted: z.boolean(),
    restartRequired: z.boolean(),
  })
  .strict();
const lifecycleRestartResultSchema = z
  .object({ restarting: z.literal(true) })
  .strict();
const updateStatusSchema: z.ZodType<DesktopUpdateStatus> =
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("disabled") }).strict(),
    z.object({ state: z.literal("idle") }).strict(),
    z.object({ state: z.literal("checking") }).strict(),
    z.object({ state: z.literal("available") }).strict(),
    z.object({
      state: z.literal("downloaded"),
      version: z.string().min(1).max(128),
    }).strict(),
    z.object({ state: z.literal("error") }).strict(),
  ]);
const updateApplyResultSchema = z
  .object({ restarting: z.boolean() })
  .strict();

const publicOperationError = (error: unknown): Error => {
  if (error instanceof AiAdapterError) return new Error(error.message);
  if (
    error instanceof Error &&
    [
      "IntentArc bridge health check failed.",
      "Unsupported desktop AI adapter.",
    ].includes(error.message)
  ) {
    return new Error(error.message);
  }
  return new Error("Desktop operation failed.");
};

const isTrustedEvent = (
  event: DesktopIpcEvent,
  trustedRenderer: TrustedDesktopRenderer,
): boolean => {
  if (
    event?.sender !== trustedRenderer.webContents ||
    event.senderFrame !== trustedRenderer.mainFrame ||
    event.sender.mainFrame !== trustedRenderer.mainFrame
  ) {
    return false;
  }
  try {
    return new URL(event.senderFrame.url).origin === trustedRenderer.origin;
  } catch {
    return false;
  }
};

const handler = <Input, Output>(
  trustedRenderer: TrustedDesktopRenderer,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  operation: (input: Input) => Output | Promise<Output>,
) =>
  async (event: DesktopIpcEvent, payload?: unknown): Promise<Output> => {
    if (!isTrustedEvent(event, trustedRenderer)) {
      throw new Error("Unauthorized desktop request.");
    }
    let input: Input;
    try {
      input = inputSchema.parse(payload);
    } catch {
      throw new Error("Invalid desktop request.");
    }

    let output: Output;
    try {
      output = await operation(input);
    } catch (error) {
      throw publicOperationError(error);
    }
    try {
      return outputSchema.parse(output);
    } catch {
      throw new Error("Desktop operation failed.");
    }
  };

export const registerDesktopIpcHandlers = ({
  ipcMain,
  connections,
  documents = {
    resolveExternalOpen: () => ({ status: "blocked" }),
  },
  openPath = async () => "Desktop file opening is unavailable.",
  openExternal = async () => {
    throw new Error("Desktop external opening is unavailable.");
  },
  updates = {
    getStatus: () => ({ state: "disabled" }),
    applyAndRestart: () => false,
    dispose: () => undefined,
  },
  settings,
  defaultArchivePath,
  activeArchivePath,
  pathPlatform = process.platform,
  trustedRenderer,
  selectArchivePath,
  selectRepositoryDirectory = async () => null,
  requestRelaunch,
}: RegisterDesktopIpcHandlersOptions): (() => void) => {
  const channels = Object.values(DESKTOP_IPC_CHANNELS);
  const register = <Input, Output>(
    channel: string,
    inputSchema: z.ZodType<Input>,
    outputSchema: z.ZodType<Output>,
    operation: (input: Input) => Output | Promise<Output>,
  ): void => {
    ipcMain.handle(
      channel,
      handler(trustedRenderer, inputSchema, outputSchema, operation),
    );
  };
  const normalizePath = pathPlatform === "win32"
    ? (path: string) => win32.normalize(path).toLowerCase()
    : (path: string) => posix.normalize(path);
  const lifecycleState = () => {
    const current = settings.read();
    const archivePath = current.archivePath ?? defaultArchivePath;
    return {
      archivePath,
      onboardingCompleted: current.onboardingCompleted,
      restartRequired:
        normalizePath(archivePath) !== normalizePath(activeArchivePath),
    };
  };

  register(
    DESKTOP_IPC_CHANNELS.aiList,
    noInputSchema,
    aiCatalogSchema,
    () => connections.list(),
  );
  register(
    DESKTOP_IPC_CHANNELS.documentsOpenRepositoryFile,
    documentOpenInputSchema,
    openedResultSchema,
    async ({ projectId, nodeId }) => {
      const resolved = documents.resolveExternalOpen(projectId, nodeId);
      if (resolved.status !== "openable") {
        throw new Error("Repository document is not current and openable.");
      }
      const shellError = await openPath(resolved.absolutePath);
      if (shellError !== "") throw new Error("Could not open repository document.");
      return { opened: true as const };
    },
  );
  register(
    DESKTOP_IPC_CHANNELS.documentsOpenExternalHttps,
    externalHttpsSchema,
    openedResultSchema,
    async (url) => {
      await openExternal(url);
      return { opened: true as const };
    },
  );
  register(
    DESKTOP_IPC_CHANNELS.updatesGetStatus,
    noInputSchema,
    updateStatusSchema,
    () => updates.getStatus(),
  );
  register(
    DESKTOP_IPC_CHANNELS.updatesApplyAndRestart,
    noInputSchema,
    updateApplyResultSchema,
    () => ({ restarting: updates.applyAndRestart() }),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiConnect,
    adapterIdSchema,
    connectResultSchema,
    (adapterId) => connections.connect(adapterId),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiCreateManual,
    manualCreateInputSchema,
    manualConnectionSetupSchema,
    (input) => connections.createManual(input),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiTest,
    adapterIdSchema,
    connectionStateSchema,
    (adapterId) => connections.test(adapterId),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiRemove,
    adapterIdSchema,
    removeResultSchema,
    (adapterId) => connections.remove(adapterId),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiRemoveManual,
    identifierSchema,
    manualRemoveResultSchema,
    (id) => connections.removeManual(id),
  );
  register(
    DESKTOP_IPC_CHANNELS.aiLaunchForProject,
    launchInputSchema,
    launchResultSchema,
    (input) => connections.launchForProject({
      adapterId: input.adapterId,
      repositoryPath: input.repositoryPath,
      ...(input.request === undefined ? {} : { request: input.request }),
    }),
  );
  register(
    DESKTOP_IPC_CHANNELS.repositoryChooseDirectory,
    noInputSchema,
    optionalAbsolutePathSchema,
    selectRepositoryDirectory,
  );
  register(
    DESKTOP_IPC_CHANNELS.lifecycleGetState,
    noInputSchema,
    lifecycleStateSchema,
    lifecycleState,
  );
  register(
    DESKTOP_IPC_CHANNELS.lifecycleChooseArchive,
    noInputSchema,
    lifecycleStateSchema,
    async () => {
      const selected = await selectArchivePath();
      if (selected === null) return lifecycleState();
      const archivePath = absolutePathSchema.parse(selected);
      const current = settings.read();
      settings.write({ ...current, archivePath });
      return lifecycleState();
    },
  );
  register(
    DESKTOP_IPC_CHANNELS.lifecycleCompleteOnboarding,
    noInputSchema,
    lifecycleStateSchema,
    () => {
      const current = settings.read();
      if (!current.onboardingCompleted || current.archivePath === null) {
        settings.write({
          ...current,
          archivePath: current.archivePath ?? defaultArchivePath,
          onboardingCompleted: true,
        });
      }
      return lifecycleState();
    },
  );
  register(
    DESKTOP_IPC_CHANNELS.lifecycleRestart,
    noInputSchema,
    lifecycleRestartResultSchema,
    () => {
      const current = lifecycleState();
      if (!current.onboardingCompleted || !current.restartRequired) {
        throw new Error("Restart is not available.");
      }
      if (!requestRelaunch()) throw new Error("Could not restart IntentArc.");
      return { restarting: true };
    },
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
