import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  openIntentArcApplication,
  type IntentArcApplication,
} from "../../app/create-application.js";
import {
  assertRepositorySourceUnchanged,
  captureRepositorySource,
} from "../../test-support/repository-source-snapshot.js";
import { createRepositoryObservationScanner } from "../../repository/observation-scanner.js";
import { startWebServer } from "../server/http-server.js";
import {
  ownedE2eDatabaseFromEnvironment,
  ownedE2eStructuredRepositoryFromEnvironment,
} from "./e2e-runner.js";

const E2E_PORT = 47_862;
const E2E_CONTROL_PORT = 47_863;
const E2E_SESSION_TOKEN = "intentarc-e2e-session";
const E2E_CONTROL_TOKEN = "intentarc-e2e-control";
const E2E_TIMESTAMP = "2026-07-29T12:00:00.000Z";

const temporaryDatabase = ownedE2eDatabaseFromEnvironment();
const structuredRepository = ownedE2eStructuredRepositoryFromEnvironment();
let application: IntentArcApplication | null = null;
let runningServer: Awaited<ReturnType<typeof startWebServer>> | null = null;
let controlServer: Server | null = null;
let shutdownPromise: Promise<void> | null = null;
let lifecycle = Promise.resolve();
const scanner = createRepositoryObservationScanner();

const pauseForVisibleProgress = (): void => {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    75,
  );
};

const assertStructuredSource = (): void => {
  const expected = JSON.parse(
    readFileSync(structuredRepository.snapshotPath, "utf8"),
  ) as ReturnType<typeof captureRepositorySource>;
  assertRepositorySourceUnchanged(structuredRepository.root, expected);
};

const captureIdeasBoundary = () => {
  if (!application) throw new Error("IntentArc is not running");
  const dashboard = application.service.views.getDashboard("project-1");
  return structuredClone({
    currentOutcome: dashboard.currentOutcome,
    currentTask: dashboard.currentTask,
    attention: dashboard.attention,
    pendingProposalCount: dashboard.pendingProposalCount,
    repositoryRefresh: application.service.repositoryRefresh.get("project-2"),
    repositoryTree: application.service.projectMap.getRepositoryTree({
      projectId: "project-2",
      pageSize: 1_000,
    }),
  });
};

let ideasBoundary: ReturnType<typeof captureIdeasBoundary> | null = null;

const updateStructuredSnapshot = (): void => {
  writeFileSync(
    structuredRepository.snapshotPath,
    JSON.stringify(captureRepositorySource(structuredRepository.root)),
    "utf8",
  );
};

const startProduct = async (): Promise<void> => {
  application = await openIntentArcApplication({
    databasePath: temporaryDatabase.path,
    now: () => E2E_TIMESTAMP,
    repositoryRefreshDependencies: {
      scanner: {
        scan: (input, options) => scanner.scan(input, {
          ...options,
          onProgress(progress) {
            options.onProgress(progress);
            if (progress.phase !== "finalizing") pauseForVisibleProgress();
          },
        }),
        verify: (candidate, signal) => scanner.verify(candidate, signal),
      },
    },
  });
  try {
    runningServer = await startWebServer({
      application,
      port: E2E_PORT,
      sessionToken: E2E_SESSION_TOKEN,
      staticRoot: path.resolve("dist/web-client"),
    });
  } catch (error) {
    application.close();
    application = null;
    throw error;
  }
};

const stopProduct = async (): Promise<void> => {
  const server = runningServer;
  const currentApplication = application;
  runningServer = null;
  application = null;
  await server?.close();
  currentApplication?.close();
};

const runLifecycle = <Result>(operation: () => Promise<Result>): Promise<Result> => {
  const result = lifecycle.then(operation, operation);
  lifecycle = result.then(() => undefined, () => undefined);
  return result;
};

const writeResponse = (
  response: import("node:http").ServerResponse,
  status: number,
  body = "",
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

const prepareDocumentChange = (): void => {
  assertStructuredSource();
  writeFileSync(
    path.join(structuredRepository.root, "README.md"),
    "# Browser knowledge\n\nThis document changed after acceptance.\n",
  );
  updateStructuredSnapshot();
};

const prepareSemanticChange = (): void => {
  assertStructuredSource();
  const evidencePath = path.join(
    structuredRepository.root,
    "tests",
    "release-evidence.md",
  );
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    "# Release evidence\n\nBrowser verification awaits governed review.\n",
  );
  execFileSync("git", ["-C", structuredRepository.root, "add", "tests/release-evidence.md"], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  updateStructuredSnapshot();
};

const startControlServer = async (): Promise<void> => {
  controlServer = createServer((request, response) => {
    if (request.headers["x-intentarc-e2e-control"] !== E2E_CONTROL_TOKEN) {
      writeResponse(response, 403, JSON.stringify({ error: "forbidden" }));
      return;
    }
    const route = new URL(request.url ?? "/", `http://127.0.0.1:${E2E_CONTROL_PORT}`).pathname;
    if (request.method !== "POST") {
      writeResponse(response, 405, JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    void runLifecycle(async () => {
      if (route === "/restart") {
        await stopProduct();
        await startProduct();
        return { restarted: true };
      }
      if (route === "/prepare-ideas-boundary") {
        ideasBoundary = captureIdeasBoundary();
        return { prepared: "ideas-boundary" };
      }
      if (route === "/finalize-ideas") {
        if (!ideasBoundary) throw new Error("Ideas boundary was not prepared");
        const before = ideasBoundary;
        const after = captureIdeasBoundary();
        ideasBoundary = null;
        assertStructuredSource();
        if (!isDeepStrictEqual(after, before)) {
          throw new Error(
            "Idea capture changed current work or repository refresh truth",
          );
        }
        return { unchanged: true };
      }
      if (route === "/prepare-document-change") {
        prepareDocumentChange();
        return { prepared: "document" };
      }
      if (route === "/prepare-semantic-change") {
        prepareSemanticChange();
        return { prepared: "semantic" };
      }
      if (route === "/finalize") {
        assertStructuredSource();
        return { unchanged: true };
      }
      throw Object.assign(new Error("Unknown control route."), { status: 404 });
    }).then(
      (body) => writeResponse(response, 200, JSON.stringify(body)),
      (error: unknown) => writeResponse(
        response,
        typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : 500,
        JSON.stringify({
          error: error instanceof Error ? error.message : "control_failed",
        }),
      ),
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    controlServer!.once("error", rejectListen);
    controlServer!.listen(E2E_CONTROL_PORT, "127.0.0.1", () => {
      controlServer!.off("error", rejectListen);
      resolveListen();
    });
  });
};

const closeControlServer = async (): Promise<void> => {
  const server = controlServer;
  controlServer = null;
  if (!server) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
};

const shutdown = (): Promise<void> => {
  shutdownPromise ??= runLifecycle(async () => {
    await closeControlServer();
    await stopProduct();
  });
  return shutdownPromise;
};

const main = async (): Promise<void> => {
  await startProduct();
  await startControlServer();
  process.stdout.write("INTENTARC_E2E_READY\n");
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "E2E shutdown failed"}\n`,
      );
      process.exitCode = 1;
    });
  });
}

await main().catch(async (error: unknown) => {
  await shutdown().catch(() => undefined);
  throw error;
});
