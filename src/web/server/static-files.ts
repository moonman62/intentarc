import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { API_RESPONSE_CONTENT_SECURITY_POLICY } from "./router.js";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StaticFileRequest {
  staticRoot: string;
  requestedPath: string;
}

export const serveStaticFile = async (
  request: StaticFileRequest,
  response: ServerResponse,
): Promise<void> => {
  if (!isAbsolute(request.staticRoot)) {
    writeEmpty(response, 500);
    return;
  }

  const rawPathname = request.requestedPath.split("?", 1)[0] ?? "/";
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    writeEmpty(response, 400);
    return;
  }

  if (
    !pathname.startsWith("/") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.split("/").includes("..")
  ) {
    writeEmpty(response, 400);
    return;
  }

  const root = resolve(request.staticRoot);
  let candidate = resolve(root, pathname.slice(1));
  if (pathname === "/") {
    candidate = resolve(root, "index.html");
  }

  if (!isContained(root, candidate)) {
    writeEmpty(response, 400);
    return;
  }

  let target = candidate;
  if (!(await isRegularFile(target))) {
    if (extname(pathname) !== "") {
      writeEmpty(response, 404);
      return;
    }
    target = resolve(root, "index.html");
  }

  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    if (!isContained(canonicalRoot, canonicalTarget)) {
      writeEmpty(response, 400);
      return;
    }

    const contents = await readFile(canonicalTarget);
    const contentType = MIME_TYPES[extname(canonicalTarget).toLowerCase()];
    if (!contentType) {
      writeEmpty(response, 404);
      return;
    }

    response.writeHead(200, {
      "content-type": contentType,
      "content-length": contents.byteLength,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...contentSecurityPolicyHeader(response),
    });
    response.end(contents);
  } catch {
    writeEmpty(response, 404);
  }
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const isContained = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    );
};

const writeEmpty = (response: ServerResponse, statusCode: number): void => {
  response.writeHead(statusCode, {
    "content-length": "0",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...contentSecurityPolicyHeader(response),
  });
  response.end();
};

const contentSecurityPolicyHeader = (
  response: ServerResponse,
): { "content-security-policy"?: string } =>
  response.hasHeader("content-security-policy")
    ? {}
    : { "content-security-policy": API_RESPONSE_CONTENT_SECURITY_POLICY };
