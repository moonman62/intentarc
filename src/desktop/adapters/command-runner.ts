import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";
import type { Readable } from "node:stream";
import {
  AiAdapterError,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
} from "./types.js";

export const ADAPTER_MAX_OUTPUT_BYTES = 64 * 1024;
export const ADAPTER_COMMAND_TIMEOUT_MS = 15_000;

interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly detached: boolean;
  readonly windowsHide: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

type TerminateProcessTree = (
  child: SpawnedProcess,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  maximumWaitMs: number,
) => Promise<boolean>;

export interface CreateCommandRunnerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly terminationGraceMs?: number;
  readonly windowsTreeTerminationMs?: number;
  readonly spawnProcess?: SpawnProcess;
  readonly terminateProcessTree?: TerminateProcessTree;
}

const hasErrorCode = (
  error: unknown,
  codes: readonly string[],
): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  typeof (error as NodeJS.ErrnoException).code === "string" &&
  codes.includes((error as NodeJS.ErrnoException).code!);

const executableExtensions = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  name: string,
): readonly string[] => {
  if (platform !== "win32" || extname(name)) return [""];
  return (environment.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((extension) => extension.trim().toUpperCase())
    .filter((extension) => extension === ".COM" || extension === ".EXE");
};

const pathListDelimiter = (platform: NodeJS.Platform): string =>
  platform === "win32" ? ";" : ":";

const isCodexStorePrivateExecutable = (path: string): boolean =>
  /(?:^|[\\/])WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex\.(?:com|exe)$/i
    .test(path);

const isPortableExecutable = async (path: string): Promise<boolean> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const handle = await open(path, "r");
    try {
      const signature = Buffer.alloc(2);
      const { bytesRead } = await handle.read(signature, 0, 2, 0);
      return bytesRead === 2 && signature.toString("ascii") === "MZ";
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return false;
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw new AiAdapterError("executable_missing", {}, { cause: error });
  }
};

const resolveClaudeNpmNativeExecutable = async (
  directory: string,
  name: string,
): Promise<string | null> => {
  if (name.toLowerCase() !== "claude") return null;
  const shimPath = join(directory, "claude.cmd");
  let source: string;
  try {
    const metadata = await lstat(shimPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    ) {
      return null;
    }
    source = await readFile(shimPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return null;
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw new AiAdapterError("executable_missing", {}, { cause: error });
  }
  const supportedTarget =
    /"%(?:dp0%|~dp0)\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe"\s+%\*/i;
  if (!supportedTarget.test(source)) return null;

  const nativeExecutable = join(
    directory,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  if (!(await isPortableExecutable(nativeExecutable))) return null;
  try {
    await access(nativeExecutable, constants.X_OK);
    return nativeExecutable;
  } catch (error) {
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return null;
    throw new AiAdapterError("executable_missing", {}, { cause: error });
  }
};

const codexNpmNativeLayouts = [
  [
    "node_modules",
    "@openai",
    "codex",
    "vendor",
    "x86_64-pc-windows-msvc",
    "codex",
    "codex.exe",
  ],
  [
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "codex",
    "codex.exe",
  ],
  [
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  ],
] as const;

const modernCodexNpmLauncher = [
  /^@echo off$/i,
  /^goto start$/i,
  /^:find_dp0$/i,
  /^set dp0=%~dp0$/i,
  /^exit \/b$/i,
  /^:start$/i,
  /^setlocal$/i,
  /^call :find_dp0$/i,
  /^$/,
  /^if exist "%dp0%\\node\.exe" \($/i,
  /^[ \t]+set "_prog=%dp0%\\node\.exe"$/i,
  /^\) else \($/i,
  /^[ \t]+set "_prog=node"$/i,
  /^[ \t]+set pathext=%pathext:;\.js;=;%$/i,
  /^\)$/,
  /^$/,
  /^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & "%_prog%"[ \t]+"%dp0%\\node_modules\\@openai\\codex\\bin\\codex\.js"[ \t]+%\*$/i,
] as const;

const legacyCodexNpmLauncher = [
  /^@if exist "%~dp0\\node\.exe" \($/i,
  /^[ \t]+"%~dp0\\node\.exe"[ \t]+"%~dp0\\node_modules\\@openai\\codex\\bin\\codex\.js"[ \t]+%\*$/i,
  /^\) else \($/i,
  /^[ \t]+@setlocal$/i,
  /^[ \t]+@set pathext=%pathext:;\.js;=;%$/i,
  /^[ \t]+node[ \t]+"%~dp0\\node_modules\\@openai\\codex\\bin\\codex\.js"[ \t]+%\*$/i,
  /^\)$/,
] as const;

const matchesCodexNpmLauncher = (
  lines: readonly string[],
  expected: readonly RegExp[],
): boolean =>
  lines.length === expected.length &&
  expected.every((pattern, index) => pattern.test(lines[index]!));

const hasSupportedCodexLauncherTarget = (source: string): boolean => {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd());
  return matchesCodexNpmLauncher(lines, modernCodexNpmLauncher) ||
    matchesCodexNpmLauncher(lines, legacyCodexNpmLauncher);
};

const isCanonicalFilePath = async (path: string): Promise<boolean> => {
  try {
    return (await realpath(path)).toLowerCase() === resolve(path).toLowerCase();
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return false;
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw new AiAdapterError("executable_missing", {}, { cause: error });
  }
};

const resolveCodexNpmNativeExecutable = async (
  directory: string,
  name: string,
): Promise<string | null> => {
  if (name.toLowerCase() !== "codex") return null;
  const shimPath = join(directory, "codex.cmd");
  let source: string;
  try {
    const metadata = await lstat(shimPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    ) {
      return null;
    }
    source = await readFile(shimPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return null;
    if (hasErrorCode(error, ["EACCES", "EPERM"])) {
      throw new AiAdapterError("access_denied", {}, { cause: error });
    }
    throw new AiAdapterError("executable_missing", {}, { cause: error });
  }
  if (!hasSupportedCodexLauncherTarget(source)) return null;

  for (const layout of codexNpmNativeLayouts) {
    const nativeExecutable = join(directory, ...layout);
    if (!(await isCanonicalFilePath(nativeExecutable))) continue;
    if (!(await isPortableExecutable(nativeExecutable))) continue;
    try {
      await access(nativeExecutable, constants.X_OK);
      return nativeExecutable;
    } catch (error) {
      if (hasErrorCode(error, ["EACCES", "EPERM"])) {
        throw new AiAdapterError("access_denied", {}, { cause: error });
      }
      if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) continue;
      throw new AiAdapterError("executable_missing", {}, { cause: error });
    }
  }
  return null;
};

const findExecutable = async (
  name: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> => {
  const suppliedPath =
    isAbsolute(name) || name.includes("/") || name.includes("\\");
  if (suppliedPath && !isAbsolute(name)) return null;
  const pathDirectories = suppliedPath
    ? [""]
    : (environment.PATH ?? "")
        .split(pathListDelimiter(platform))
        .filter((entry) => entry.length > 0);
  const standardUserNpmDirectory =
    platform === "win32" &&
      !suppliedPath &&
      environment.APPDATA &&
      win32.isAbsolute(environment.APPDATA)
      ? win32.join(environment.APPDATA, "npm")
      : null;
  const directories = standardUserNpmDirectory === null ||
      pathDirectories.some((directory) =>
        win32.normalize(directory).toLowerCase() ===
          win32.normalize(standardUserNpmDirectory).toLowerCase()
      )
    ? pathDirectories
    : [...pathDirectories, standardUserNpmDirectory];
  let denied = false;

  for (const directory of directories) {
    for (const extension of executableExtensions(platform, environment, name)) {
      const candidate = suppliedPath ? `${name}${extension}` : join(directory, `${name}${extension}`);
      try {
        const metadata = await lstat(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const canonicalCandidate = await realpath(candidate);
        if (isCodexStorePrivateExecutable(canonicalCandidate)) continue;
        await access(canonicalCandidate, constants.X_OK);
        return canonicalCandidate;
      } catch (error) {
        if (hasErrorCode(error, ["EACCES", "EPERM"])) denied = true;
        else if (!hasErrorCode(error, ["ENOENT", "ENOTDIR"])) {
          throw new AiAdapterError("executable_missing", {}, { cause: error });
        }
      }
    }
    if (platform === "win32" && !suppliedPath) {
      const nativeClaude = await resolveClaudeNpmNativeExecutable(
        directory,
        name,
      );
      if (nativeClaude !== null) return nativeClaude;
      const nativeCodex = await resolveCodexNpmNativeExecutable(
        directory,
        name,
      );
      if (nativeCodex !== null) return nativeCodex;
    }
  }

  if (denied) throw new AiAdapterError("access_denied");
  return null;
};

const appendBounded = (
  target: Buffer[],
  chunk: string | Buffer,
  remaining: { bytes: number },
): void => {
  if (remaining.bytes <= 0) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const accepted = bytes.subarray(0, remaining.bytes);
  if (accepted.length > 0) {
    target.push(accepted);
    remaining.bytes -= accepted.length;
  }
};

const startupError = (error: Error): AiAdapterError => {
  if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) {
    return new AiAdapterError("executable_missing", {}, { cause: error });
  }
  if (hasErrorCode(error, ["EACCES", "EPERM"])) {
    return new AiAdapterError("access_denied", {}, { cause: error });
  }
  return new AiAdapterError("command_failed", {}, { cause: error });
};

const terminateWithTaskkill = async (
  pid: number,
  environment: NodeJS.ProcessEnv,
  maximumWaitMs: number,
): Promise<boolean> => {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return false;
  const taskkillPath = win32.join(systemRoot, "System32", "taskkill.exe");
  return new Promise((resolve) => {
    let settled = false;
    let terminator: ReturnType<typeof spawn>;
    const finish = (terminated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(terminated);
    };
    try {
      terminator = spawn(
        taskkillPath,
        ["/pid", String(pid), "/t", "/f"],
        {
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      resolve(false);
      return;
    }
    terminator.once("error", () => finish(false));
    terminator.once("close", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      terminator.kill("SIGKILL");
      finish(false);
    }, maximumWaitMs);
  });
};

const terminateProcessTree = async (
  child: SpawnedProcess,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  maximumWaitMs: number,
): Promise<boolean> => {
  const pid = child.pid;
  if (platform === "win32" && typeof pid === "number") {
    return terminateWithTaskkill(pid, environment, maximumWaitMs);
  }
  if (platform !== "win32" && typeof pid === "number") {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      // Fall back to the direct child when its process group already exited.
    }
  }
  child.kill("SIGKILL");
  return true;
};

const killDirectChildBestEffort = (child: SpawnedProcess): void => {
  try {
    child.kill("SIGKILL");
  } catch {
    // The public result reflects whether tree cleanup was proven.
  }
};

export const createCommandRunner = (
  options: CreateCommandRunnerOptions = {},
): CommandRunner => {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? ADAPTER_COMMAND_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? ADAPTER_MAX_OUTPUT_BYTES;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  const windowsTreeTerminationMs = options.windowsTreeTerminationMs ?? 5_000;
  if (!Number.isInteger(windowsTreeTerminationMs) || windowsTreeTerminationMs <= 0) {
    throw new Error("Windows tree termination bound must be a positive integer.");
  }
  const terminateTree = options.terminateProcessTree ?? terminateProcessTree;
  const spawnProcess: SpawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as SpawnedProcess);

  return {
    findExecutable: (name) => findExecutable(name, platform, environment),
    run: (command, args, runOptions) =>
      new Promise<CommandResult>((resolve, reject) => {
        let child: SpawnedProcess;
        try {
          child = spawnProcess(command, [...args], {
            ...(runOptions?.cwd === undefined ? {} : { cwd: runOptions.cwd }),
            env: runOptions?.environment ?? environment,
            shell: false,
            detached: platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(startupError(error instanceof Error ? error : new Error("Command startup failed.")));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const remaining = { bytes: maxOutputBytes };
        let settled = false;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (
          handler: () => void,
        ): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handler();
        };

        child.stdout.on("data", (chunk: string | Buffer) => {
          appendBounded(stdout, chunk, remaining);
        });
        child.stderr.on("data", (chunk: string | Buffer) => {
          appendBounded(stderr, chunk, remaining);
        });
        child.once("error", (error) => {
          if (timedOut) return;
          finish(() => reject(startupError(error)));
        });
        child.once("close", (code) => {
          const output = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
          if (timedOut) return;
          finish(() => {
            if (code !== 0) {
              reject(new AiAdapterError("command_failed", {
                ...(code === null ? {} : { exitCode: code }),
                ...(output.stderr.length === 0
                  ? {}
                  : { stderr: output.stderr }),
              }));
            } else {
              resolve(output);
            }
          });
        });

        timer = setTimeout(() => {
          timedOut = true;
          void terminateTree(
            child,
            platform,
            runOptions?.environment ?? environment,
            platform === "win32" ? windowsTreeTerminationMs : terminationGraceMs,
          ).then(
            (cleaned) => {
              if (!cleaned) killDirectChildBestEffort(child);
              finish(() => reject(new AiAdapterError(
                platform === "win32" && !cleaned
                  ? "command_cleanup_failed"
                  : "command_timeout",
              )));
            },
            () => {
              killDirectChildBestEffort(child);
              finish(() => reject(new AiAdapterError(
                platform === "win32"
                  ? "command_cleanup_failed"
                  : "command_timeout",
              )));
            },
          );
        }, timeoutMs);
      }),
  };
};
