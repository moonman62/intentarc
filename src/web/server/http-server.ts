import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { IntentArcApplication } from "../../app/create-application.js";
import { createApplicationRoutes } from "./api-routes.js";
import {
  API_RESPONSE_CONTENT_SECURITY_POLICY,
  createApiHandler,
} from "./router.js";
import {
  exchangeLaunchToken,
  isAllowedMutationOrigin,
  isAuthenticated,
} from "./session.js";
import { serveStaticFile } from "./static-files.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STATIC_ROOT = fileURLToPath(
  new URL("../../web-client/", import.meta.url),
);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'";

export interface StartWebServerOptions {
  application: IntentArcApplication;
  port?: number;
  sessionToken?: string;
  staticRoot?: string;
  allowedMutationOrigins?: string[];
  contentSecurityPolicy?: string;
}

export interface RunningWebServer {
  origin: string;
  launchUrl: string;
  close(): Promise<void>;
}

export const startWebServer = async (
  options: StartWebServerOptions,
): Promise<RunningWebServer> => {
  const sessionToken = options.sessionToken ??
    randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(sessionToken)) {
    throw new Error("The web session token is not cookie-safe.");
  }

  const additionalOrigins = (options.allowedMutationOrigins ?? []).map(
    validateLoopbackHttpOrigin,
  );
  const apiHandler = createApiHandler(
    createApplicationRoutes(options.application),
  );
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  let origin = "";
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      origin,
      sessionToken,
      allowedMutationOrigins: new Set([origin, ...additionalOrigins]),
      staticRoot,
      apiHandler,
      contentSecurityPolicy: options.contentSecurityPolicy ??
        DEFAULT_CONTENT_SECURITY_POLICY,
    }).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: {
            code: "internal_error",
            message: "The request could not be completed.",
            recoverable: false,
          },
        });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 47_861, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    origin,
    launchUrl: `${origin}/?key=${encodeURIComponent(sessionToken)}`,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
};

interface HandleRequestInput {
  request: IncomingMessage;
  response: ServerResponse;
  origin: string;
  sessionToken: string;
  allowedMutationOrigins: ReadonlySet<string>;
  staticRoot: string;
  apiHandler: ReturnType<typeof createApiHandler>;
  contentSecurityPolicy: string;
}

const handleRequest = async ({
  request,
  response,
  origin,
  sessionToken,
  allowedMutationOrigins,
  staticRoot,
  apiHandler,
  contentSecurityPolicy,
}: HandleRequestInput): Promise<void> => {
  response.setHeader("content-security-policy", contentSecurityPolicy);
  response.setHeader("x-frame-options", "DENY");
  const url = new URL(request.url ?? "/", origin);

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    const exchange = exchangeLaunchToken({
      url,
      expectedToken: sessionToken,
    });
    if (exchange) {
      response.writeHead(303, {
        location: exchange.redirect,
        "set-cookie": exchange.cookie,
        "cache-control": "no-store",
        "content-length": "0",
      });
      response.end();
      return;
    }
  }

  if (!isAuthenticated(request.headers.cookie, sessionToken)) {
    writeJson(response, 401, {
      error: {
        code: "unauthorized",
        message: "A local browser session is required.",
        recoverable: true,
      },
    });
    return;
  }

  if (
    MUTATION_METHODS.has(request.method ?? "") &&
    ![...allowedMutationOrigins].some((allowedOrigin) =>
      isAllowedMutationOrigin(request.headers.origin, allowedOrigin)
    )
  ) {
    writeJson(response, 403, {
      error: {
        code: "forbidden_origin",
        message: "Mutation requests require an allowed loopback origin.",
        recoverable: true,
      },
    });
    return;
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    await apiHandler(request, response);
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "The requested route was not found.",
        recoverable: true,
      },
    });
    return;
  }

  await serveStaticFile({
    staticRoot,
    requestedPath: request.url ?? "/",
  }, response);
};

const validateLoopbackHttpOrigin = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Development origins must be a loopback HTTP origin.");
  }

  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Development origins must be a loopback HTTP origin.");
  }

  return url.origin;
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": API_RESPONSE_CONTENT_SECURITY_POLICY,
  });
  response.end(serialized);
};
