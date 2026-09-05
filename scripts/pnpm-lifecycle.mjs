import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

const javascriptEntryPoints = new Set(["pnpm.cjs", "pnpm.js", "pnpm.mjs"]);

const copyArguments = (lifecycleArguments) => {
  if (
    !Array.isArray(lifecycleArguments) ||
    lifecycleArguments.length === 0 ||
    lifecycleArguments.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error("IntentArc pnpm lifecycle arguments are invalid.");
  }
  return [...lifecycleArguments];
};

export const createPnpmLifecycleInvocation = (
  cliPath,
  lifecycleArguments,
  { platform = process.platform, nodeExecutable = process.execPath } = {},
) => {
  const argumentsCopy = copyArguments(lifecycleArguments);
  const name = basename(cliPath).toLowerCase();
  if (javascriptEntryPoints.has(name)) {
    return { command: nodeExecutable, arguments: [cliPath, ...argumentsCopy] };
  }
  if (
    (platform === "win32" && name === "pnpm.exe") ||
    (platform !== "win32" && name === "pnpm")
  ) {
    return { command: cliPath, arguments: argumentsCopy };
  }
  throw new Error("IntentArc pnpm lifecycle entry point is unsupported.");
};

export const resolvePnpmLifecycleInvocation = async (
  environment,
  lifecycleArguments,
  runtime = {},
) => {
  const configuredPath = environment.npm_execpath?.trim();
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error(
      "IntentArc must run through a pnpm lifecycle with an absolute npm_execpath.",
    );
  }
  const cliPath = await realpath(configuredPath);
  if (!(await stat(cliPath)).isFile()) {
    throw new Error("IntentArc pnpm lifecycle entry point is not a file.");
  }
  return createPnpmLifecycleInvocation(cliPath, lifecycleArguments, runtime);
};
