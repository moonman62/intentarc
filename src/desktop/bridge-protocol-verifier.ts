import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "../app/create-application.js";
import {
  BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY,
  type BridgeActivationTransaction,
  type BridgePayloadVerification,
} from "./bridge-install.js";
import { createDesktopSettingsStore } from "./settings.js";

const verificationTimeoutMilliseconds = 15_000;
const childSettlementTimeoutMilliseconds = 5_000;
const requiredTools = [
  "get_my_change",
  "get_project_summary",
  "get_released_context",
  "list_my_changes",
  "list_projects",
  "request_task_context",
  "submit_change_set",
] as const;

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const bridgeProtocolEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
  appData: string,
  activationTransaction?: BridgeActivationTransaction,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0].toLowerCase() !==
          BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY.toLowerCase(),
    ),
  ),
  APPDATA: appData,
  ...(activationTransaction === undefined
    ? {}
    : {
      [BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY]:
        activationTransaction.transactionId,
    }),
});

export type BridgeProtocolVerifier = (
  input: BridgePayloadVerification,
) => Promise<void>;

export interface BridgeProtocolChildLike {
  readonly exitCode: number | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface BridgeProtocolChildSettlementDependencies {
  readonly now: () => number;
  readonly scheduleDeadline: (
    expire: () => void,
    milliseconds: number,
  ) => () => void;
}

const defaultChildSettlementDependencies:
  BridgeProtocolChildSettlementDependencies = {
    now: () => performance.now(),
    scheduleDeadline: (expire, milliseconds) => {
      const timer = setTimeout(expire, milliseconds);
      return () => clearTimeout(timer);
    },
  };

export interface RetainedBridgeProtocolChild {
  readonly hasCloseProof: () => boolean;
  readonly settle: (closeClient: () => Promise<void>) => Promise<void>;
}

export const retainBridgeProtocolChild = (
  child: BridgeProtocolChildLike,
  dependencies: BridgeProtocolChildSettlementDependencies =
    defaultChildSettlementDependencies,
): RetainedBridgeProtocolChild => {
  let exitObserved = child.exitCode !== null;
  let observedExitCode = child.exitCode;
  let closeObserved = false;
  let processError: Error | undefined;
  let resolveLifecycle!: () => void;
  const lifecycle = new Promise<void>((resolve) => {
    resolveLifecycle = resolve;
  });
  const resolveIfClosed = (): void => {
    if (exitObserved && closeObserved) resolveLifecycle();
  };
  const onError = (error: Error): void => {
    processError = error;
  };
  const onExit = (code: number | null): void => {
    exitObserved = true;
    observedExitCode = code;
    resolveIfClosed();
  };
  const onClose = (): void => {
    closeObserved = true;
    resolveIfClosed();
  };
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);

  let settlement: Promise<void> | undefined;
  return {
    hasCloseProof: () => exitObserved && closeObserved,
    settle: (closeClient) => {
      if (settlement) return settlement;
      settlement = (async () => {
        const deadline =
          dependencies.now() + childSettlementTimeoutMilliseconds;
        let expire!: () => void;
        const expiration = new Promise<void>((_resolve, reject) => {
          expire = () => reject(
            processError ?? new Error(
              "IntentArc bridge MCP protocol child settlement timed out.",
            ),
          );
        });
        const cancelDeadline = dependencies.scheduleDeadline(
          expire,
          Math.max(0, deadline - dependencies.now()),
        );
        let closeError: unknown;
        let killRequested = false;
        const closeAndSettle = async (): Promise<void> => {
          try {
            await closeClient();
          } catch (error) {
            closeError = error;
          }
          if (!closeObserved && !killRequested) {
            killRequested = true;
            try {
              child.kill("SIGKILL");
            } catch (error) {
              closeError ??= error;
            }
          }
          await lifecycle;
          if (processError) throw processError;
          if (observedExitCode !== 0) {
            throw new Error(
              "IntentArc bridge MCP protocol process exited unsuccessfully.",
            );
          }
          if (closeError !== undefined) throw closeError;
        };
        try {
          await Promise.race([closeAndSettle(), expiration]);
        } finally {
          cancelDeadline();
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("close", onClose);
        }
      })();
      return settlement;
    },
  };
};

interface BridgeProtocolClientLike {
  readonly connect: (transport: unknown) => Promise<void>;
  readonly listTools: () => Promise<{
    readonly tools: readonly { readonly name: string }[];
  }>;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface BridgeProtocolVerifierDependencies {
  readonly createTemporaryRoot: () => Promise<string>;
  readonly prepareWorkspace: (input: {
    readonly appData: string;
    readonly archivePath: string;
    readonly connectionId: string;
  }) => void | Promise<void>;
  readonly createTransport: (input: {
    readonly executablePath: string;
    readonly appData: string;
    readonly connectionId: string;
    readonly activationTransaction?: BridgeActivationTransaction;
  }) => unknown;
  readonly createClient: () => BridgeProtocolClientLike;
  readonly getTransportChild: (
    transport: unknown,
  ) => BridgeProtocolChildLike | undefined;
  readonly subscribeDiagnostics?: (
    transport: unknown,
    append: (diagnostics: string) => void,
  ) => void;
  readonly removeTemporaryRoot: (root: string) => Promise<void>;
  readonly childSettlementDependencies:
    BridgeProtocolChildSettlementDependencies;
}

const prepareBridgeProtocolWorkspace: BridgeProtocolVerifierDependencies[
  "prepareWorkspace"
] = ({ appData, archivePath, connectionId }) => {
  const application = createApplication({ databasePath: archivePath });
  const created = application.service.profiles.createProfile({
    name: "Installer protocol verification",
  });
  application.close();
  createDesktopSettingsStore(join(appData, "IntentArc")).write({
    schemaVersion: 2,
    archivePath,
    onboardingCompleted: true,
    connections: [{
      id: connectionId,
      kind: "managed",
      adapterId: "codex",
      profileId: created.profile.id,
      profileToken: created.token,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }],
  });
};

const defaultBridgeProtocolVerifierDependencies:
  BridgeProtocolVerifierDependencies = {
    createTemporaryRoot: () =>
      mkdtemp(join(tmpdir(), "intentarc-bridge-protocol-")),
    prepareWorkspace: prepareBridgeProtocolWorkspace,
    createTransport: (input) => new StdioClientTransport({
      command: input.executablePath,
      args: ["--connection", input.connectionId],
      env: bridgeProtocolEnvironment(
        inheritedEnvironment(),
        input.appData,
        input.activationTransaction,
      ),
      stderr: "pipe",
    }),
    createClient: () => {
      const client = new Client({
        name: "IntentArc installer protocol verification",
        version: "1.0.0",
      });
      return {
        connect: (transport) =>
          client.connect(transport as StdioClientTransport),
        listTools: () => client.listTools(),
        callTool: (input) => client.callTool(input),
        close: () => client.close(),
      };
    },
    getTransportChild: (transport) =>
      (transport as { _process?: ChildProcess })._process,
    subscribeDiagnostics: (transport, append) => {
      (transport as StdioClientTransport).stderr?.on("data", (chunk) => {
        append(chunk.toString());
      });
    },
    removeTemporaryRoot: (root) =>
      rm(root, { recursive: true, force: true }),
    childSettlementDependencies: defaultChildSettlementDependencies,
  };

export const verifyBridgeProtocolCompatibilityWithDependencies = async (
  input: BridgePayloadVerification,
  dependencies: BridgeProtocolVerifierDependencies,
): Promise<void> => {
    const root = await dependencies.createTemporaryRoot();
    const appData = join(root, "Roaming");
    const archivePath = join(root, "verification.sqlite");
    const connectionId = "installer-protocol-verification";
    let transport: unknown;
    let client: BridgeProtocolClientLike | undefined;
    let retainedChild: RetainedBridgeProtocolChild | undefined;
    let timer: NodeJS.Timeout | undefined;
    let diagnostics = "";
    const failures: unknown[] = [];
    let childSettlementRequired = false;

    try {
      await dependencies.prepareWorkspace({
        appData,
        archivePath,
        connectionId,
      });
      transport = dependencies.createTransport({
        executablePath: input.executablePath,
        appData,
        connectionId,
        ...(input.activationTransaction === undefined
          ? {}
          : { activationTransaction: input.activationTransaction }),
      });
      dependencies.subscribeDiagnostics?.(transport, (value) => {
        diagnostics += value;
      });
      client = dependencies.createClient();

      const verify = async (): Promise<void> => {
        childSettlementRequired = true;
        await client!.connect(transport!);
        const child = dependencies.getTransportChild(transport!);
        if (!child) {
          throw new Error(
            "IntentArc bridge MCP protocol process ownership is unavailable.",
          );
        }
        retainedChild = retainBridgeProtocolChild(
          child,
          dependencies.childSettlementDependencies,
        );
        const listed = await client!.listTools();
        const names = new Set(listed.tools.map(({ name }) => name));
        if (requiredTools.some((name) => !names.has(name))) {
          throw new Error(
            "IntentArc bridge MCP tool compatibility check failed.",
          );
        }
        const result = await client!.callTool({
          name: "list_projects",
          arguments: {},
        });
        if (
          typeof result === "object" &&
          result !== null &&
          "isError" in result &&
          result.isError === true
        ) {
          throw new Error(
            "IntentArc bridge MCP archive compatibility check failed.",
          );
        }
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            "IntentArc bridge MCP protocol verification timed out.",
          ));
        }, verificationTimeoutMilliseconds);
      });
      await Promise.race([verify(), timeout]);
    } catch (error) {
      failures.push(error);
    }
    if (timer) clearTimeout(timer);
    if (client) {
      try {
        if (retainedChild) {
          await retainedChild.settle(() => client!.close());
        } else {
          await client.close();
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (diagnostics !== "") {
      failures.push(
        new Error(
          "IntentArc bridge MCP protocol verification produced diagnostics.",
        ),
      );
    }
    if (
      !childSettlementRequired ||
      retainedChild?.hasCloseProof() === true
    ) {
      try {
        await dependencies.removeTemporaryRoot(root);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "IntentArc bridge MCP protocol verification lifecycle failed.",
      );
    }
  };

export const verifyBridgeProtocolCompatibility: BridgeProtocolVerifier =
  (input) => verifyBridgeProtocolCompatibilityWithDependencies(
    input,
    defaultBridgeProtocolVerifierDependencies,
  );
