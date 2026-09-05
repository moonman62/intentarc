import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_MAX_OUTPUT_BYTES,
  createCommandRunner,
} from "./command-runner.js";
import { AiAdapterError } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-command-runner-"));
  temporaryRoots.push(root);
  return root;
};

const createTemporaryPathDirectory = async (): Promise<string> => {
  const directory = await mkdtemp("intentarc-command-runner-posix-");
  temporaryRoots.push(directory);
  return directory;
};

const codexLauncherSource = (
  target = "node_modules\\@openai\\codex\\bin\\codex.js",
): string => [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  "",
].join("\r\n");

const legacyCodexLauncherSource = (
  target = "node_modules\\@openai\\codex\\bin\\codex.js",
): string => [
  '@IF EXIST "%~dp0\\node.exe" (',
  `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  `  node  "%~dp0\\${target}" %*`,
  ")",
  "",
].join("\r\n");

const codexNativeLayouts = [
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

const createCodexRunner = (
  root: string,
): ReturnType<typeof createCommandRunner> => createCommandRunner({
  platform: "win32",
  environment: {
    PATH: root,
    PATHEXT: ".COM;.EXE;.CMD",
  },
});

const createStorePrivateExecutable = async (
  root: string,
): Promise<{ directory: string; executable: string }> => {
  const directory = join(
    root,
    "WindowsApps",
    "OpenAI.Codex_26.727.4816.0_x64__2p2nqsd0c76g0",
    "app",
    "resources",
  );
  const executable = join(directory, "codex.exe");
  await mkdir(directory, { recursive: true });
  await writeFile(executable, Buffer.from("MZ-private"));
  return { directory, executable };
};

const WINDOWS_PROCESS_MARKER_SCRIPT = [
  "& { param([int]$TargetProcessId, [string]$Marker)",
  "$target = Get-CimInstance -ClassName Win32_Process",
  "  -Filter ('ProcessId = {0}' -f $TargetProcessId) -ErrorAction Stop;",
  "if ($null -eq $target) { 'missing'; exit 0 };",
  "if ([string]$target.CommandLine -like ('*' + $Marker + '*')) { 'match' } else { 'different' }",
  "}",
].join(" ");

const processMatchesMarker = (pid: number, marker: string): boolean => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PROCESS_MARKER_SCRIPT,
      String(pid),
      marker,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  );
  return result.status !== 0 || result.stdout.trim() === "match";
};

const waitForMarkedProcessesToExit = async (
  pids: readonly number[],
  marker: string,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processMatchesMarker(pid, marker))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !processMatchesMarker(pid, marker));
};

const cleanupWindowsProcessTree = (pid: number): void => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) return;
  spawnSync(
    join(systemRoot, "System32", "taskkill.exe"),
    ["/pid", String(pid), "/t", "/f"],
    {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  );
};

describe("createCommandRunner", () => {
  it.each(["darwin", "linux"] as const)(
    "finds codex through a colon-delimited PATH for injected %s",
    async (platform) => {
      const missingDirectory = await createTemporaryPathDirectory();
      const executableDirectory = await createTemporaryPathDirectory();
      const executable = join(executableDirectory, "codex");
      await writeFile(executable, "#!/bin/sh\n");
      await chmod(executable, 0o755);
      const runner = createCommandRunner({
        platform,
        environment: { PATH: `${missingDirectory}:${executableDirectory}` },
      });

      await expect(runner.findExecutable("codex")).resolves.toBe(
        await realpath(executable),
      );
    },
  );

  it.each(["darwin", "linux"] as const)(
    "rejects a relative executable candidate for injected %s",
    async (platform) => {
      const directory = await createTemporaryPathDirectory();
      const relativeExecutable = join(directory, "codex");
      await writeFile(relativeExecutable, "#!/bin/sh\n");
      await chmod(relativeExecutable, 0o755);
      const runner = createCommandRunner({ platform, environment: {} });

      await expect(runner.findExecutable(relativeExecutable)).resolves.toBeNull();
    },
  );

  it.each(["darwin", "linux"] as const)(
    "rejects a directory candidate for injected %s",
    async (platform) => {
      const directory = await createTemporaryPathDirectory();
      await mkdir(join(directory, "codex"));
      const runner = createCommandRunner({
        platform,
        environment: { PATH: directory },
      });

      await expect(runner.findExecutable("codex")).resolves.toBeNull();
    },
  );

  it.each(["darwin", "linux"] as const)(
    "resolves an executable through a directory symlink for injected %s",
    async (platform) => {
      const directory = await createTemporaryPathDirectory();
      const linkedDirectory = `${directory}-linked`;
      const executable = join(directory, "codex");
      await writeFile(executable, "#!/bin/sh\n");
      await chmod(executable, 0o755);
      await symlink(await realpath(directory), linkedDirectory, "junction");
      temporaryRoots.push(linkedDirectory);
      const runner = createCommandRunner({
        platform,
        environment: { PATH: linkedDirectory },
      });

      await expect(runner.findExecutable("codex")).resolves.toBe(
        await realpath(executable),
      );
    },
  );

  it("rejects a file-symlink candidate with a different canonical leaf for injected darwin and linux", async (context) => {
    const directory = await createTemporaryPathDirectory();
    const target = join(directory, "codex-target");
    const alias = join(directory, "codex");
    await writeFile(target, "#!/bin/sh\n");
    await chmod(target, 0o755);
    try {
      await symlink(target, alias, "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip(
          "Windows file-symlink creation requires an unavailable privilege",
        );
        return;
      }
      throw error;
    }

    for (const platform of ["darwin", "linux"] as const) {
      const runner = createCommandRunner({
        platform,
        environment: { PATH: directory },
      });

      await expect(runner.findExecutable("codex")).resolves.toBeNull();
    }
  });

  it("resolves a direct Windows executable without a shell", async () => {
    const root = await createTemporaryRoot();
    const executable = join(root, "claude.exe");
    await writeFile(executable, Buffer.from("MZ-direct"));
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        PATH: root,
        PATHEXT: ".COM;.EXE;.CMD",
      },
    });

    await expect(runner.findExecutable("claude")).resolves.toSatisfy(
      (path: string | null) => path?.toLowerCase() === executable.toLowerCase(),
    );
  });

  it("resolves the native Claude executable behind a supported npm cmd shim", async () => {
    const root = await createTemporaryRoot();
    const nativeDirectory = join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
    );
    const nativeExecutable = join(nativeDirectory, "claude.exe");
    await mkdir(nativeDirectory, { recursive: true });
    await writeFile(
      join(root, "claude.cmd"),
      [
        "@ECHO off",
        "SETLOCAL",
        '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        PATH: root,
        PATHEXT: ".COM;.EXE;.CMD",
      },
    });

    await expect(runner.findExecutable("claude")).resolves.toBe(
      nativeExecutable,
    );
  });

  it("does not trust a Claude cmd shim that targets another executable", async () => {
    const root = await createTemporaryRoot();
    const nativeDirectory = join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
    );
    await mkdir(nativeDirectory, { recursive: true });
    await writeFile(
      join(root, "claude.cmd"),
      '@ECHO off\r\n"C:\\Other\\claude.exe" %*\r\n',
      "utf8",
    );
    await writeFile(join(nativeDirectory, "claude.exe"), Buffer.from("MZ-native"));
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        PATH: root,
        PATHEXT: ".COM;.EXE;.CMD",
      },
    });

    await expect(runner.findExecutable("claude")).resolves.toBeNull();
  });

  it.each(codexNativeLayouts)(
    "resolves the native Codex executable from an official npm payload layout",
    async (...nativePathParts) => {
      const root = await createTemporaryRoot();
      const nativeExecutable = join(root, ...nativePathParts);
      await mkdir(join(nativeExecutable, ".."), { recursive: true });
      await writeFile(join(root, "codex.cmd"), codexLauncherSource(), "utf8");
      await writeFile(nativeExecutable, Buffer.from("MZ-native"));

      await expect(
        createCodexRunner(root).findExecutable("codex"),
      ).resolves.toBe(nativeExecutable);
    },
  );

  it("finds a newly installed Codex CLI in the standard user npm directory without restarting", async () => {
    const root = await createTemporaryRoot();
    const npmDirectory = join(root, "npm");
    const nativeExecutable = join(
      npmDirectory,
      ...codexNativeLayouts.at(-1)!,
    );
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(
      join(npmDirectory, "codex.cmd"),
      codexLauncherSource(),
      "utf8",
    );
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        APPDATA: root,
        PATH: join(root, "old-path"),
        PATHEXT: ".COM;.EXE;.CMD",
      },
    });

    await expect(runner.findExecutable("codex")).resolves.toBe(
      nativeExecutable,
    );
  });

  it("finds a newly installed Claude Code CLI in the standard user npm directory without restarting", async () => {
    const root = await createTemporaryRoot();
    const npmDirectory = join(root, "npm");
    const nativeDirectory = join(
      npmDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
    );
    const nativeExecutable = join(nativeDirectory, "claude.exe");
    await mkdir(nativeDirectory, { recursive: true });
    await writeFile(
      join(npmDirectory, "claude.cmd"),
      [
        "@ECHO off",
        "SETLOCAL",
        '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        APPDATA: root,
        PATH: join(root, "old-path"),
        PATHEXT: ".COM;.EXE;.CMD",
      },
    });

    await expect(runner.findExecutable("claude")).resolves.toBe(
      nativeExecutable,
    );
  });

  it.each([
    [
      "modern cmd-shim casing and spacing",
      codexLauncherSource()
        .replace("@ECHO off", "@ECHO OFF")
        .replace('"%_prog%"  "%dp0%', '"%_prog%" "%dp0%'),
    ],
    [
      "legacy conditional Node launcher",
      legacyCodexLauncherSource(),
    ],
  ])("resolves Codex through a safe %s", async (_case, launcherSource) => {
    const root = await createTemporaryRoot();
    const nativeExecutable = join(root, ...codexNativeLayouts[0]);
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(join(root, "codex.cmd"), launcherSource, "utf8");
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBe(nativeExecutable);
  });

  it("does not trust a symbolic-link Codex npm payload", async () => {
    const root = await createTemporaryRoot();
    const nativeDirectory = join(root, ...codexNativeLayouts[0].slice(0, -1));
    const nativeExecutable = join(nativeDirectory, "codex.exe");
    const linkedDirectory = join(root, "linked-codex");
    await mkdir(join(nativeDirectory, ".."), { recursive: true });
    await mkdir(linkedDirectory, { recursive: true });
    await writeFile(join(root, "codex.cmd"), codexLauncherSource(), "utf8");
    await writeFile(join(linkedDirectory, "codex.exe"), Buffer.from("MZ-native"));
    await symlink(linkedDirectory, nativeDirectory, "junction");

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBeNull();
  });

  it("does not trust a non-PE Codex npm payload", async () => {
    const root = await createTemporaryRoot();
    const nativeExecutable = join(root, ...codexNativeLayouts[0]);
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(join(root, "codex.cmd"), codexLauncherSource(), "utf8");
    await writeFile(nativeExecutable, Buffer.from("not-a-portable-executable"));

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBeNull();
  });

  it("does not trust a Codex cmd shim with an unexpected launcher target", async () => {
    const root = await createTemporaryRoot();
    const nativeExecutable = join(root, ...codexNativeLayouts[0]);
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(
      join(root, "codex.cmd"),
      codexLauncherSource("node_modules\\other-package\\bin\\codex.js"),
      "utf8",
    );
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "an arbitrary command prefix",
      'call node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ],
    [
      "batch metacharacters",
      'evil.exe & node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ],
    [
      "a non-invocation reference",
      'echo "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ],
  ])("does not trust a Codex cmd shim containing %s", async (_case, source) => {
    const root = await createTemporaryRoot();
    const nativeExecutable = join(root, ...codexNativeLayouts[0]);
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(join(root, "codex.cmd"), source, "utf8");
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBeNull();
  });

  it("does not resolve a Codex payload outside the fixed npm layouts", async () => {
    const root = await createTemporaryRoot();
    const nativeExecutable = join(root, "node_modules", "@openai", "codex", "codex.exe");
    await mkdir(join(nativeExecutable, ".."), { recursive: true });
    await writeFile(join(root, "codex.cmd"), codexLauncherSource(), "utf8");
    await writeFile(nativeExecutable, Buffer.from("MZ-native"));

    await expect(
      createCodexRunner(root).findExecutable("codex"),
    ).resolves.toBeNull();
  });

  it("does not return the Codex Store app private resource executable", async () => {
    const root = await createTemporaryRoot();
    const privateDirectory = (await createStorePrivateExecutable(root)).directory;
    const runner = createCommandRunner({
      platform: "win32",
      environment: {
        PATH: privateDirectory,
        PATHEXT: ".EXE",
      },
    });

    await expect(runner.findExecutable("codex")).resolves.toBeNull();
  });

  it("does not return a file-symlink alias to the Codex Store private executable", async (context) => {
    const root = await createTemporaryRoot();
    const privateExecutable = (await createStorePrivateExecutable(root)).executable;
    const aliasDirectory = join(root, "file-alias");
    const aliasExecutable = join(aliasDirectory, "codex.exe");
    await mkdir(aliasDirectory, { recursive: true });
    try {
      await symlink(privateExecutable, aliasExecutable, "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip(
          "Windows file-symlink creation requires an unavailable privilege",
        );
        return;
      }
      throw error;
    }
    const runner = createCommandRunner({
      platform: "win32",
      environment: { PATH: aliasDirectory, PATHEXT: ".EXE" },
    });

    await expect(runner.findExecutable("codex")).resolves.toBeNull();
  });

  it("does not return a directory-junction alias to the Codex Store private executable", async () => {
    const root = await createTemporaryRoot();
    const privateDirectory = (await createStorePrivateExecutable(root)).directory;
    const aliasDirectory = join(root, "junction-alias");
    await symlink(privateDirectory, aliasDirectory, "junction");
    const runner = createCommandRunner({
      platform: "win32",
      environment: { PATH: aliasDirectory, PATHEXT: ".EXE" },
    });

    await expect(runner.findExecutable("codex")).resolves.toBeNull();
  });

  it("keeps arguments containing spaces as separate process arguments", async () => {
    const runner = createCommandRunner();

    const result = await runner.run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "C:\\Program Files\\IntentArc Bridge.exe",
      "connection with spaces",
    ]);

    expect(JSON.parse(result.stdout)).toEqual([
      "C:\\Program Files\\IntentArc Bridge.exe",
      "connection with spaces",
    ]);
  });

  it("bounds captured stderr to 64 KiB", async () => {
    const runner = createCommandRunner();

    const result = await runner.run(process.execPath, [
      "-e",
      `process.stderr.write("x".repeat(${ADAPTER_MAX_OUTPUT_BYTES + 4096}))`,
    ]);

    expect(Buffer.byteLength(result.stderr)).toBe(ADAPTER_MAX_OUTPUT_BYTES);
  });

  it("kills a child that exceeds the configured timeout", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    const runner = createCommandRunner({
      timeoutMs: 5,
      spawnProcess: () => child,
    });

    await expect(runner.run("codex", ["--version"])).rejects.toMatchObject({
      code: "command_timeout",
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("waits for successful Windows tree cleanup before reporting timeout", async () => {
    let finishCleanup!: (cleaned: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => {
      finishCleanup = resolve;
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const runner = createCommandRunner({
      platform: "win32",
      timeoutMs: 1,
      terminateProcessTree: () => cleanup,
      spawnProcess: () => child,
    });
    const result = runner.run("codex", ["--version"]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit("close", null, "SIGTERM");

    await expect(Promise.race([
      result.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ])).resolves.toBe("pending");
    finishCleanup(true);
    await expect(result).rejects.toMatchObject({ code: "command_timeout" });
  });

  it("ignores a child error after timeout while Windows tree cleanup is pending", async () => {
    let finishCleanup!: (cleaned: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => {
      finishCleanup = resolve;
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const runner = createCommandRunner({
      platform: "win32",
      timeoutMs: 1,
      terminateProcessTree: () => cleanup,
      spawnProcess: () => child,
    });
    const result = runner.run("codex", ["--version"]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit("error", Object.assign(new Error("late child error"), {
      code: "EACCES",
    }));

    await expect(Promise.race([
      result.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ])).resolves.toBe("pending");
    finishCleanup(true);
    await expect(result).rejects.toMatchObject({ code: "command_timeout" });
  });

  it("reports failed Windows tree cleanup distinctly", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const runner = createCommandRunner({
      platform: "win32",
      timeoutMs: 1,
      terminateProcessTree: async () => false,
      spawnProcess: () => child,
    });

    await expect(runner.run("codex", ["--version"]))
      .rejects.toMatchObject({ code: "command_cleanup_failed" });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("contains a rejected Windows tree cleanup and reports it distinctly", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const runner = createCommandRunner({
      platform: "win32",
      timeoutMs: 1,
      terminateProcessTree: async () => {
        throw new Error("tree cleanup rejected");
      },
      spawnProcess: () => child,
    });

    await expect(runner.run("codex", ["--version"]))
      .rejects.toMatchObject({ code: "command_cleanup_failed" });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it.each([
    ["resolved false", async () => false],
    ["rejected", async () => { throw new Error("cleanup rejected"); }],
  ] as const)(
    "preserves non-Windows timeout semantics when cleanup is %s",
    async (_caseName, terminateProcessTree) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      const runner = createCommandRunner({
        platform: "linux",
        timeoutMs: 1,
        terminateProcessTree,
        spawnProcess: () => child,
      });

      await expect(runner.run("codex", ["--version"]))
        .rejects.toMatchObject({ code: "command_timeout" });
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    },
  );

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid Windows tree-cleanup bound %s",
    (windowsTreeTerminationMs) => {
      expect(() => createCommandRunner({ windowsTreeTerminationMs }))
        .toThrow("Windows tree termination bound must be a positive integer.");
    },
  );

  it.runIf(process.platform === "win32")(
    "terminates a timed-out Windows helper and its grandchild within a bounded interval",
    async () => {
      const root = await createTemporaryRoot();
      const pidFile = join(root, "pids.json");
      const marker = `intentarc-command-runner-${randomUUID()}`;
      const childSource = [
        `/* ${marker}-helper */`,
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        "const grandchild = spawn(process.execPath,",
        `  ["-e", ${JSON.stringify(`/* ${marker}-grandchild */ setInterval(() => {}, 1000)`)}],`,
        '  { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
        "writeFileSync(process.argv[1], JSON.stringify({",
        "  helper: process.pid,",
        "  grandchild: grandchild.pid,",
        "}));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runner = createCommandRunner({ timeoutMs: 250 });
      let pids: { helper: number; grandchild: number } | undefined;

      try {
        const outcome = await Promise.race([
          runner.run(process.execPath, ["-e", childSource, pidFile]).then(
            () => "unexpected_success" as const,
            (error: unknown) => error,
          ),
          new Promise<"still_pending">((resolve) =>
            setTimeout(() => resolve("still_pending"), 8_000)
          ),
        ]);
        pids = JSON.parse(await readFile(pidFile, "utf8")) as {
          helper: number;
          grandchild: number;
        };

        expect(outcome).toMatchObject({ code: "command_timeout" });
        await expect(
          waitForMarkedProcessesToExit(
            [pids.helper, pids.grandchild],
            marker,
            5_000,
          ),
        ).resolves.toBe(true);
      } finally {
        if (pids) {
          cleanupWindowsProcessTree(pids.helper);
          cleanupWindowsProcessTree(pids.grandchild);
        }
      }
    },
    20_000,
  );

  it("always disables shell execution", async () => {
    let observedOptions: { shell?: boolean } | undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const runner = createCommandRunner({
      spawnProcess: (_command, _args, options) => {
        observedOptions = options;
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });

    await runner.run("codex", ["mcp", "list"]);

    expect(observedOptions?.shell).toBe(false);
  });

  it.each([
    ["ENOENT", "executable_missing"],
    ["EACCES", "access_denied"],
    ["EPERM", "access_denied"],
  ] as const)("maps %s startup failures to %s", async (osCode, adapterCode) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const runner = createCommandRunner({
      spawnProcess: () => {
        queueMicrotask(() => {
          const error = Object.assign(new Error("sanitized"), { code: osCode });
          child.emit("error", error);
        });
        return child;
      },
    });

    const failure = runner.run("missing", []);

    await expect(failure).rejects.toBeInstanceOf(AiAdapterError);
    await expect(failure).rejects.toMatchObject({ code: adapterCode });
  });

  it("maps nonzero exits to typed errors without including command arguments", async () => {
    const runner = createCommandRunner();

    const failure = runner.run(process.execPath, [
      "-e",
      'process.stderr.write("failed"); process.exit(7)',
      "sensitive-value",
    ]);

    await expect(failure).rejects.toMatchObject({
      code: "command_failed",
      details: { exitCode: 7, stderr: "failed" },
    });
    await expect(failure).rejects.not.toHaveProperty("details.args");
    await expect(failure).rejects.not.toHaveProperty("message", expect.stringContaining("sensitive-value"));
  });
});
