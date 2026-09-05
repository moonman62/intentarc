import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";
import {
  authenticateStableBridgeTarget,
  BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY,
  inspectIntrinsicBridgeIdentity,
  readBridgeActivationTransaction,
  recoverBridgeActivation,
  type AuthenticatedBridgeLaunch,
  type BridgePayloadVerification,
  type InstallBridgeVersionInput,
} from "../desktop/bridge-install.js";
import { desktopSettingsRoot } from "../desktop/paths.js";
import {
  createDesktopSettingsStore,
  type DesktopConnectionBase,
} from "../desktop/settings.js";
import { isMainModule } from "../system/main-module.js";
import {
  bridgeAuthorizedPredecessor,
  bridgeBuildIdentity,
} from "../system/bridge-build-identity.js";
import {
  resolveOsRootedWindowsPowerShellPath,
  resolveWindowsPowerShellInvocation,
} from "../system/windows-powershell.js";

export { resolveOsRootedWindowsPowerShellPath };

interface DiagnosticWriter {
  write(message: string): unknown;
}

export interface DesktopMcpConnection {
  databasePath: string;
  profileId: DesktopConnectionBase["profileId"];
  profileToken: DesktopConnectionBase["profileToken"];
}

export interface RunIntentArcBridgeOptions {
  argv?: readonly string[];
  environment?: Partial<Record<string, string | undefined>>;
  homeDirectory?: string;
  stderr?: DiagnosticWriter;
  setExitCode?: (code: number) => void;
  loadConnection?: (
    connectionId: string,
  ) => DesktopMcpConnection | undefined | Promise<DesktopMcpConnection | undefined>;
  runMcp?: (
    connection: DesktopMcpConnection,
    onCredentialsConsumed: () => void,
    onShutdown: () => Promise<void>,
  ) => Promise<void>;
  runHealthCheck?: () => Promise<void>;
  delegateStableLaunch?: () => Promise<boolean>;
  stdout?: DiagnosticWriter;
}

const selectedConnectionId = (argv: readonly string[]): string | undefined => {
  if (argv.length !== 2 || argv[0] !== "--connection") return undefined;
  const connectionId = argv[1];
  return connectionId && !connectionId.startsWith("--") ? connectionId : undefined;
};

const loadPrivateConnection = (
  connectionId: string,
  environment: Partial<Record<string, string | undefined>>,
  homeDirectory: string,
): DesktopMcpConnection | undefined => {
  const settings = createDesktopSettingsStore(desktopSettingsRoot({
    platform: process.platform,
    environment,
    homeDirectory,
  })).read();
  const connection = settings.connections.find(({ id }) => id === connectionId);

  if (!settings.archivePath || !connection) return undefined;

  return {
    databasePath: settings.archivePath,
    profileId: connection.profileId,
    profileToken: connection.profileToken,
  };
};

const quoteWindowsArgument = (value: string): string => {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let quoted = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === "\"") {
      quoted += "\\".repeat((backslashes * 2) + 1);
      quoted += "\"";
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += character;
      backslashes = 0;
    }
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

const heldLaunchScript = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$nativeSource = @'",
  "using System;",
  "using System.ComponentModel;",
  "using System.IO;",
  "using Microsoft.Win32.SafeHandles;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "",
  "public sealed class IntentArcChildProcess : IDisposable",
  "{",
  "    private IntPtr processHandle;",
  "",
  "    internal IntentArcChildProcess(IntPtr processHandle)",
  "    {",
  "        this.processHandle = processHandle;",
  "    }",
  "",
  "    public int WaitForExit()",
  "    {",
  "        if (NativeMethods.WaitForSingleObject(processHandle, UInt32.MaxValue) == UInt32.MaxValue)",
  "            throw new Win32Exception(Marshal.GetLastWin32Error());",
  "        uint exitCode;",
  "        if (!NativeMethods.GetExitCodeProcess(processHandle, out exitCode))",
  "            throw new Win32Exception(Marshal.GetLastWin32Error());",
  "        return unchecked((int)exitCode);",
  "    }",
  "",
  "    public void Dispose()",
  "    {",
  "        if (processHandle != IntPtr.Zero)",
  "        {",
  "            NativeMethods.CloseHandle(processHandle);",
  "            processHandle = IntPtr.Zero;",
  "        }",
  "    }",
  "}",
  "",
  "public static class NativeMethods",
  "{",
  "    private const uint STARTF_USESTDHANDLES = 0x00000100;",
  "    private const uint CREATE_NO_WINDOW = 0x08000000;",
  "    private const uint GENERIC_READ = 0x80000000;",
  "    private const uint FILE_SHARE_READ = 0x00000001;",
  "    private const uint OPEN_EXISTING = 3;",
  "    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;",
  "    private const int STD_INPUT_HANDLE = -10;",
  "    private const int STD_OUTPUT_HANDLE = -11;",
  "    private const int STD_ERROR_HANDLE = -12;",
  "",
  "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "    private struct STARTUPINFO",
  "    {",
  "        public uint cb;",
  "        public string lpReserved;",
  "        public string lpDesktop;",
  "        public string lpTitle;",
  "        public uint dwX;",
  "        public uint dwY;",
  "        public uint dwXSize;",
  "        public uint dwYSize;",
  "        public uint dwXCountChars;",
  "        public uint dwYCountChars;",
  "        public uint dwFillAttribute;",
  "        public uint dwFlags;",
  "        public ushort wShowWindow;",
  "        public ushort cbReserved2;",
  "        public IntPtr lpReserved2;",
  "        public IntPtr hStdInput;",
  "        public IntPtr hStdOutput;",
  "        public IntPtr hStdError;",
  "    }",
  "",
  "    [StructLayout(LayoutKind.Sequential)]",
  "    private struct PROCESS_INFORMATION",
  "    {",
  "        public IntPtr hProcess;",
  "        public IntPtr hThread;",
  "        public uint dwProcessId;",
  "        public uint dwThreadId;",
  "    }",
  "",
  "    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "    private static extern bool CreateProcessW(",
  "        string applicationName,",
  "        StringBuilder commandLine,",
  "        IntPtr processAttributes,",
  "        IntPtr threadAttributes,",
  "        bool inheritHandles,",
  "        uint creationFlags,",
  "        IntPtr environment,",
  "        string currentDirectory,",
  "        ref STARTUPINFO startupInfo,",
  "        out PROCESS_INFORMATION processInformation);",
  "",
  "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);",
  "",
  "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "    internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);",
  "",
  "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "    internal static extern bool CloseHandle(IntPtr handle);",
  "",
  "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "    private static extern IntPtr GetStdHandle(int standardHandle);",
  "",
  "    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "    private static extern IntPtr CreateFileW(",
  "        string fileName,",
  "        uint desiredAccess,",
  "        uint shareMode,",
  "        IntPtr securityAttributes,",
  "        uint creationDisposition,",
  "        uint flagsAndAttributes,",
  "        IntPtr templateFile);",
  "",
  "    public static FileStream OpenLocked(string path)",
  "    {",
  "        var handle = CreateFileW(",
  "            path,",
  "            GENERIC_READ,",
  "            FILE_SHARE_READ,",
  "            IntPtr.Zero,",
  "            OPEN_EXISTING,",
  "            FILE_ATTRIBUTE_NORMAL,",
  "            IntPtr.Zero);",
  "        if (handle == new IntPtr(-1))",
  "            throw new Win32Exception(Marshal.GetLastWin32Error());",
  "        return new FileStream(new SafeFileHandle(handle, true), FileAccess.Read);",
  "    }",
  "",
  "    public static IntentArcChildProcess Start(string applicationName, string arguments)",
  "    {",
  "        var startupInfo = new STARTUPINFO();",
  "        startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));",
  "        startupInfo.dwFlags = STARTF_USESTDHANDLES;",
  "        startupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);",
  "        startupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);",
  "        startupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);",
  "        var commandLine = new StringBuilder(\"\\\"\" + applicationName + \"\\\"\");",
  "        if (!String.IsNullOrEmpty(arguments)) commandLine.Append(\" \").Append(arguments);",
  "        PROCESS_INFORMATION processInformation;",
  "        if (!CreateProcessW(",
  "            applicationName,",
  "            commandLine,",
  "            IntPtr.Zero,",
  "            IntPtr.Zero,",
  "            true,",
  "            CREATE_NO_WINDOW,",
  "            IntPtr.Zero,",
  "            null,",
  "            ref startupInfo,",
  "            out processInformation))",
  "            throw new Win32Exception(Marshal.GetLastWin32Error());",
  "        CloseHandle(processInformation.hThread);",
  "        return new IntentArcChildProcess(processInformation.hProcess);",
  "    }",
  "}",
  "'@",
  "Add-Type -TypeDefinition $nativeSource",
  "$target = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_TARGET', 'Process')",
  "$expectedDigest = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_SHA256', 'Process')",
  "$expectedIdentity = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_IDENTITY', 'Process')",
  "$expectedMode = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_MODE', 'Process')",
  "$expectedThumbprint = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_THUMBPRINT', 'Process')",
  "$expectedSubject = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_SUBJECT', 'Process')",
  "$arguments = [Environment]::GetEnvironmentVariable('INTENTARC_HELD_ARGUMENTS', 'Process')",
  "$stream = $null",
  "$child = $null",
  "$exitCode = 1",
  "try {",
  "  $stream = [NativeMethods]::OpenLocked($target)",
  "  $sha = [System.Security.Cryptography.SHA256]::Create()",
  "  try { $actualDigest = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
  "  if ($actualDigest -cne $expectedDigest) { throw 'digest mismatch' }",
  "  if ($expectedMode -ceq 'signed-release') {",
  "    $signature = Get-AuthenticodeSignature -LiteralPath $target",
  "    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'signature invalid' }",
  "    if ($signature.SignerCertificate.Thumbprint -ine $expectedThumbprint -or $signature.SignerCertificate.Subject -cne $expectedSubject) { throw 'publisher mismatch' }",
  "  }",
  "  $identityStart = New-Object System.Diagnostics.ProcessStartInfo",
  "  $identityStart.FileName = $target",
  "  $identityStart.Arguments = '--bridge-identity'",
  "  $identityStart.UseShellExecute = $false",
  "  $identityStart.CreateNoWindow = $true",
  "  $identityStart.RedirectStandardInput = $true",
  "  $identityStart.RedirectStandardOutput = $true",
  "  $identityStart.RedirectStandardError = $true",
  "  $identity = [System.Diagnostics.Process]::Start($identityStart)",
  "  $identity.StandardInput.Close()",
  "  $identityOutput = $identity.StandardOutput.ReadToEnd()",
  "  $null = $identity.StandardError.ReadToEnd()",
  "  $identity.WaitForExit()",
  "  if ($identity.ExitCode -ne 0 -or $identityOutput.Trim() -cne $expectedIdentity) { throw 'identity mismatch' }",
  "  $delayText = [Environment]::GetEnvironmentVariable('INTENTARC_TEST_HELD_LAUNCH_DELAY_MS', 'Process')",
  "  if ($delayText -match '^[0-9]{1,5}$') { $delay = [Int32]$delayText; if ($delay -gt 0 -and $delay -le 10000) { Start-Sleep -Milliseconds $delay } }",
  "  foreach ($key in @('INTENTARC_HELD_TARGET','INTENTARC_HELD_SHA256','INTENTARC_HELD_IDENTITY','INTENTARC_HELD_MODE','INTENTARC_HELD_THUMBPRINT','INTENTARC_HELD_SUBJECT','INTENTARC_HELD_ARGUMENTS','INTENTARC_TEST_HELD_LAUNCH_DELAY_MS')) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }",
  "  $child = [NativeMethods]::Start($target, $arguments)",
  "  $stream.Dispose()",
  "  $stream = $null",
  "  $exitCode = $child.WaitForExit()",
  "} catch { $exitCode = 1 } finally { if ($null -ne $child) { $child.Dispose() }; if ($null -ne $stream) { $stream.Dispose() } }",
  "exit $exitCode",
].join("\n");

const heldLaunchEncodedCommand = Buffer.from(
  heldLaunchScript,
  "utf16le",
).toString("base64");

export const launchAuthenticatedBridgeTarget = async (
  launch: AuthenticatedBridgeLaunch,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> => {
  if (process.platform !== "win32") {
    throw new Error("IntentArc held bridge launch requires Windows.");
  }
  const identity = {
    formatVersion: launch.identity.formatVersion,
    releaseVersion: launch.identity.releaseVersion,
    buildMode: launch.identity.buildMode,
    supportSha256: launch.identity.supportSha256,
  };
  const powerShell = resolveWindowsPowerShellInvocation(environment);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const helper = spawn(powerShell.executablePath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      heldLaunchEncodedCommand,
    ], {
      env: {
        ...powerShell.environment,
        INTENTARC_HELD_TARGET: launch.targetPath,
        INTENTARC_HELD_SHA256: launch.executableSha256,
        INTENTARC_HELD_IDENTITY: JSON.stringify(identity),
        INTENTARC_HELD_MODE: launch.identity.buildMode,
        INTENTARC_HELD_THUMBPRINT:
          launch.identity.publisher?.thumbprint ?? "",
        INTENTARC_HELD_SUBJECT: launch.identity.publisher?.subject ?? "",
        INTENTARC_HELD_ARGUMENTS: argv.map(quoteWindowsArgument).join(" "),
        INTENTARC_TEST_HELD_LAUNCH_DELAY_MS:
          environment.INTENTARC_TEST_HELD_LAUNCH_DELAY_MS ?? "",
      },
      stdio: "inherit",
      windowsHide: true,
    });
    helper.once("error", reject);
    helper.once("close", (code) => {
      resolveExit(code ?? 1);
    });
  });
  return exitCode;
};

const activationOwnerMarker = (
  environment: NodeJS.ProcessEnv,
): string | undefined => {
  const matches = Object.entries(environment).filter(([key]) =>
    key.toLowerCase() ===
      BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY.toLowerCase()
  );
  return matches.length === 1 ? matches[0]?.[1] : undefined;
};

const recoveryProtocolVerifierArgument =
  "--bridge-activation-protocol-verifier";
const versionDirectoryPattern = /^\d+\.\d+\.\d+-[a-f0-9]{16}$/;

const activationOwnerEnvironment = (
  environment: NodeJS.ProcessEnv,
  transactionId: string,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) =>
    key.toLowerCase() !==
      BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY.toLowerCase()
  )),
  [BRIDGE_ACTIVATION_OWNER_ENVIRONMENT_KEY]: transactionId,
});

const verifyRecoveryProtocolBoundary: InstallBridgeVersionInput["verify"] =
  async (input) => {
    const transaction = input.activationTransaction;
    if (!transaction) {
      throw new Error(
        "IntentArc recovery protocol verification requires an activation transaction.",
      );
    }
    const target = await authenticateStableBridgeTarget(input.executablePath);
    if (
      !target ||
      dirname(target.targetPath).toLowerCase() !==
        input.versionDirectory.toLowerCase()
    ) {
      throw new Error(
        "IntentArc recovery protocol verifier target is not authenticated.",
      );
    }
    const exitCode = await launchAuthenticatedBridgeTarget(
      target,
      [recoveryProtocolVerifierArgument],
      activationOwnerEnvironment(process.env, transaction.transactionId),
    );
    if (exitCode !== 0) {
      throw new Error("IntentArc recovery protocol verification failed.");
    }
    return inspectIntrinsicBridgeIdentity(input.executablePath);
  };

const runRecoveryProtocolVerification = async ({
  executablePath,
  environment,
}: {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<void> => {
  if (
    !isAbsolute(executablePath) ||
    basename(executablePath).toLowerCase() !== "intentarc bridge.exe"
  ) {
    throw new Error("IntentArc recovery verifier path is malformed.");
  }
  const versionDirectoryPath = dirname(executablePath);
  const versionsRoot = dirname(versionDirectoryPath);
  const bridgeRoot = dirname(versionsRoot);
  const versionDirectory = basename(versionDirectoryPath);
  if (
    !versionDirectoryPattern.test(versionDirectory) ||
    basename(versionsRoot).toLowerCase() !== "versions" ||
    basename(bridgeRoot).toLowerCase() !== "bridge"
  ) {
    throw new Error("IntentArc recovery verifier path is malformed.");
  }
  const binaryRoot = dirname(bridgeRoot);
  const transaction = await readBridgeActivationTransaction({ binaryRoot });
  if (
    !transaction ||
    activationOwnerMarker(environment) !== transaction.transactionId
  ) {
    throw new Error("IntentArc recovery verifier ownership is invalid.");
  }
  const { verifyBridgeProtocolCompatibility } = await import(
    "../desktop/bridge-protocol-verifier.js"
  );
  await verifyBridgeProtocolCompatibility({
    phase: "active",
    executablePath: join(
      bridgeRoot,
      "current",
      "IntentArc Bridge.exe",
    ),
    versionDirectory: versionDirectoryPath,
    binaryRoot,
    activationTransaction: transaction,
  });
};

export const delegateStableBridgeLaunch = async ({
  executablePath = process.execPath,
  argv = process.argv.slice(2),
  environment = process.env,
  setExitCode = (code: number) => {
    process.exitCode = code;
  },
  launchTarget = launchAuthenticatedBridgeTarget,
  authenticateTarget = authenticateStableBridgeTarget,
  readActivationTransaction = readBridgeActivationTransaction,
  recoverActivation = recoverBridgeActivation,
  verifyRecoveryProtocol = verifyRecoveryProtocolBoundary,
}: {
  readonly executablePath?: string;
  readonly argv?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly setExitCode?: (code: number) => void;
  readonly launchTarget?: typeof launchAuthenticatedBridgeTarget;
  readonly authenticateTarget?: typeof authenticateStableBridgeTarget;
  readonly readActivationTransaction?: typeof readBridgeActivationTransaction;
  readonly recoverActivation?: typeof recoverBridgeActivation;
  readonly verifyRecoveryProtocol?: (
    input: BridgePayloadVerification,
  ) => ReturnType<InstallBridgeVersionInput["verify"]>;
} = {}): Promise<boolean> => {
  const isStableLauncher =
    isAbsolute(executablePath) &&
    basename(executablePath).toLowerCase() === "intentarc bridge.exe" &&
    basename(dirname(executablePath)).toLowerCase() === "current" &&
    basename(dirname(dirname(executablePath))).toLowerCase() === "bridge";
  if (isStableLauncher) {
    const binaryRoot = dirname(dirname(dirname(executablePath)));
    const transaction = await readActivationTransaction({ binaryRoot });
    const ownsVerification = transaction !== undefined &&
      activationOwnerMarker(environment) === transaction.transactionId;
    if (transaction && !ownsVerification) {
      await recoverActivation({
        binaryRoot,
        inspectLauncherIdentity: inspectIntrinsicBridgeIdentity,
        verify: verifyRecoveryProtocol,
      });
    }
  }
  const target = await authenticateTarget(executablePath);
  if (!target) return false;
  const exitCode = await launchTarget(target, argv, environment);
  setExitCode(exitCode);
  return true;
};

export const runIntentArcBridge = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  homeDirectory = homedir(),
  stderr = process.stderr,
  stdout = process.stdout,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  loadConnection = (connectionId) =>
    loadPrivateConnection(connectionId, environment, homeDirectory),
  runMcp = async (connection, releaseConnection, releaseProcessReference) => {
    const { runIntentArcMcp } = await import("../mcp/bin.js");
    const credentials = {
      profileId: connection.profileId,
      profileToken: connection.profileToken,
    };
    await runIntentArcMcp({
      databasePath: connection.databasePath,
      credentials,
      onCredentialsConsumed: () => {
        credentials.profileToken = "";
        connection.profileToken = "";
        releaseConnection();
      },
      onShutdown: releaseProcessReference,
    });
  },
  runHealthCheck = async () => {
    const { default: Database } = await import("better-sqlite3");
    const database = new Database(":memory:");
    try {
      database.prepare("SELECT 1").get();
    } finally {
      database.close();
    }
  },
  delegateStableLaunch = () => delegateStableBridgeLaunch({
    argv,
    environment,
    setExitCode,
  }),
}: RunIntentArcBridgeOptions = {}): Promise<void> => {
  const rejectLaunch = (): void => {
    stderr.write("Invalid IntentArc bridge launch arguments.\n");
    setExitCode(2);
  };

  if (argv.length === 1 && argv[0] === "--bridge-identity") {
    stdout.write(`${JSON.stringify(bridgeBuildIdentity)}\n`);
    return;
  }

  if (argv.length === 1 && argv[0] === "--bridge-authorized-predecessor") {
    stdout.write(`${JSON.stringify(bridgeAuthorizedPredecessor)}\n`);
    return;
  }

  if (argv.length === 1 && argv[0] === recoveryProtocolVerifierArgument) {
    try {
      await runRecoveryProtocolVerification({
        executablePath: process.execPath,
        environment,
      });
    } catch {
      setExitCode(1);
    }
    return;
  }

  try {
    if (await delegateStableLaunch()) return;
  } catch {
    stderr.write("IntentArc bridge launcher failed.\n");
    setExitCode(1);
    return;
  }

  if (argv.length === 1 && argv[0] === "--health-check") {
    try {
      await runHealthCheck();
    } catch {
      stderr.write("IntentArc bridge health check failed.\n");
      setExitCode(1);
    }
    return;
  }

  const connectionId = selectedConnectionId(argv);
  if (!connectionId) {
    rejectLaunch();
    return;
  }

  let connection: DesktopMcpConnection | undefined;
  try {
    connection = await loadConnection(connectionId);
  } catch {
    rejectLaunch();
    return;
  }

  if (!connection) {
    rejectLaunch();
    return;
  }

  let selectedConnection: DesktopMcpConnection | undefined = connection;
  const releaseConnection = (): void => {
    if (!selectedConnection) return;
    selectedConnection.profileToken = "";
    selectedConnection = undefined;
    connection = undefined;
  };
  try {
    await runMcp(
      selectedConnection,
      releaseConnection,
      async () => undefined,
    );
  } finally {
    releaseConnection();
  }
};

if (isSea() || isMainModule(process.argv[1], import.meta.url)) {
  void runIntentArcBridge();
}
