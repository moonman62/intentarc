import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), "scripts", "desktop-release-preflight-out-preservation.ps1");
const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const temporaryRoots: string[] = [];
const commit = "a".repeat(40);
const pnpmHash = "b".repeat(64);
const runId = "phase1-preflight-20260901-06";

const escapePowerShell = (value: string) => value.replaceAll("'", "''");
const encodePowerShell = (source: string) => Buffer.from(source, "utf16le").toString("base64");
const exists = async (path: string) => lstat(path).then(() => true).catch(() => false);

type Fixture = Awaited<ReturnType<typeof createFixture>>;

type TestChildResult = {
  started?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  canceled?: boolean;
  descendantsSettled?: boolean;
  outputOverflow?: boolean;
  infrastructureFailure?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  rootProcessId?: number | null;
  rootStartTimeUtc?: string | null;
};

const testChildResultSource = ({
  started = true,
  exitCode = 0,
  timedOut = false,
  canceled = false,
  descendantsSettled = true,
  outputOverflow = false,
  infrastructureFailure = false,
  stdoutBytes = 0,
  stderrBytes = 0,
  rootProcessId = started ? 424242 : null,
  rootStartTimeUtc = started ? "2026-08-31T12:00:00.0000000Z" : null,
}: TestChildResult = {}) => `[ordered]@{
  startAttempted = $true
  started = $${started}
  exitCode = ${exitCode === null ? "$null" : `[int]${exitCode}`}
  timedOut = $${timedOut}
  canceled = $${canceled}
  descendantsSettled = $${descendantsSettled}
  outputOverflow = $${outputOverflow}
  infrastructureFailure = $${infrastructureFailure}
  stdoutBytes = [int64]${stdoutBytes}
  stderrBytes = [int64]${stderrBytes}
  jobName = $contract.jobName
  rootProcessId = ${rootProcessId === null ? "$null" : `[int]${rootProcessId}`}
  rootStartTimeUtc = ${rootStartTimeUtc === null ? "$null" : `'${rootStartTimeUtc}'`}
  assignmentSucceeded = $${rootProcessId !== null && rootStartTimeUtc !== null}
}`;

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "intentarc-preflight-out-preservation-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const superpowers = join(repositoryRoot, ".superpowers");
  const preservationParent = join(superpowers, "preflight-out-preservation");
  const runRoot = join(preservationParent, runId);
  const sourcePath = join(repositoryRoot, "out");
  const destinationPath = join(runRoot, "out");
  const childProfilePath = join(runRoot, "profile");
  const childLocalAppDataPath = join(runRoot, "localappdata");
  const childRoamingAppDataPath = join(childLocalAppDataPath, "Roaming");
  const statePath = join(preservationParent, `${runId}.json`);
  const receiptPath = join(superpowers, "preflight", "desktop-release", `${runId}.json`);
  const pnpmExecutable = join(root, "tools", "pnpm.exe");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(superpowers, { recursive: true });
  await mkdir(dirname(pnpmExecutable), { recursive: true });
  await writeFile(pnpmExecutable, "inert pnpm fixture", "utf8");
  return {
    root,
    repositoryRoot,
    superpowers,
    preservationParent,
    runRoot,
    sourcePath,
    destinationPath,
    childProfilePath,
    childLocalAppDataPath,
    childRoamingAppDataPath,
    statePath,
    receiptPath,
    pnpmExecutable,
  };
};

const resultKeys = [
  "category", "childExitCode", "childStarted", "cleanupCategory",
  "outRestored", "phase", "schema", "status",
];

const validReceipt = () => ({
  schemaVersion: 2,
  runId,
  status: "passed",
  failureCategory: null,
  checks: {
    "focused-tests": "passed",
    "server-typecheck": "passed",
    "web-typecheck": "passed",
    "adapter-strict": "passed",
  },
  git: {
    statusScope: "tracked-only",
    diffCheckPassed: true,
    productDiffClean: true,
    statusClean: true,
    statusEntryCount: 0,
  },
  source: { before: "1".repeat(64), after: "1".repeat(64), unchanged: true },
  packageJson: { before: "2".repeat(64), after: "2".repeat(64), unchanged: true },
  vendor: { before: "3".repeat(64), after: "3".repeat(64), unchanged: true },
  out: { absentBefore: true, absentAfter: true },
});

const contractSource = (fixture: Fixture, overrides = "") => `
$script:moveCalls = [System.Collections.Generic.List[string]]::new()
$script:childCalls = 0
$script:childObservation = $null
$contract = [ordered]@{
  repositoryRoot = '${escapePowerShell(fixture.repositoryRoot)}'
  superpowersPath = '${escapePowerShell(fixture.superpowers)}'
  preservationParent = '${escapePowerShell(fixture.preservationParent)}'
  runRoot = '${escapePowerShell(fixture.runRoot)}'
  sourcePath = '${escapePowerShell(fixture.sourcePath)}'
  destinationPath = '${escapePowerShell(fixture.destinationPath)}'
  childProfilePath = '${escapePowerShell(fixture.childProfilePath)}'
  childLocalAppDataPath = '${escapePowerShell(fixture.childLocalAppDataPath)}'
  childRoamingAppDataPath = '${escapePowerShell(fixture.childRoamingAppDataPath)}'
  statePath = '${escapePowerShell(fixture.statePath)}'
  receiptPath = '${escapePowerShell(fixture.receiptPath)}'
  branch = 'master'
  runId = '${runId}'
  jobName = 'IntentArc.Preflight.${runId}.test'
  maximumBytesPerStream = 1048576
  timeoutMilliseconds = 30000
  getRepositoryState = { [ordered]@{ branch = 'master'; commit = '${commit}'; statusRows = @() } }
  getPnpmSha256 = { param($Path) '${pnpmHash}' }
  getStableDirectoryIdentity = {
    param($Path)
    if ($Path -ieq '${escapePowerShell(fixture.sourcePath)}' -or
        $Path -ieq '${escapePowerShell(fixture.destinationPath)}' -or
        $Path -ieq '${escapePowerShell(fixture.runRoot)}' -or
        $Path -ieq '${escapePowerShell(fixture.childProfilePath)}' -or
        $Path -ieq '${escapePowerShell(fixture.childLocalAppDataPath)}') {
      Initialize-IntentArcPreflightNativeProcessType
      [IntentArc.Preflight.DirectoryRenameSession]::ReadPathIdentity($Path)
    } else { '00000001:0000000000000001' }
  }
  getStableFileIdentity = { param($Path) '00000002:0000000000000002' }
  moveDirectory = { param($Source, $Destination) $script:moveCalls.Add("$Source\`n$Destination"); [IO.Directory]::Move($Source, $Destination) }
  invokeChild = {
    param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds)
    $script:childCalls++
    ${testChildResultSource()}
  }
}
${overrides}
`;

const successChildOverride = (fixture: Fixture, body = "") => `
$contract.invokeChild = {
  param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds)
  $script:childCalls++
  $script:childObservation = [ordered]@{
    executable = $Executable
    arguments = @($ArgumentList)
    workingDirectory = $WorkingDirectory
    sourceExists = [IO.Directory]::Exists('${escapePowerShell(fixture.sourcePath)}')
    destinationExists = [IO.Directory]::Exists('${escapePowerShell(fixture.destinationPath)}')
  }
  ${body}
  [IO.Directory]::CreateDirectory('${escapePowerShell(dirname(fixture.receiptPath))}') | Out-Null
  [IO.File]::WriteAllText('${escapePowerShell(fixture.receiptPath)}', '${escapePowerShell(JSON.stringify(validReceipt()))}')
  ${testChildResultSource()}
}
`;

const directoryHandleHelperSource = `
if ($null -eq ('IntentArc.Preflight.TestDirectoryHandle' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace IntentArc.Preflight {
  public static class TestDirectoryHandle {
    const uint DELETE = 0x00010000;
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Open(string path, uint share) {
      IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES, share, IntPtr.Zero, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
      return handle;
    }
    public static IntPtr OpenDeleteBlocking(string path) {
      IntPtr handle = CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES, 0, IntPtr.Zero, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
      return handle;
    }
    public static void Close(IntPtr handle) { if (handle != IntPtr.Zero && handle != InvalidHandle) CloseHandle(handle); }
  }
}
'@ -Language CSharp -ErrorAction Stop
}
`;

const inPlaceJunctionHelperSource = `
if ($null -eq ('IntentArc.Preflight.TestInPlaceJunction' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
namespace IntentArc.Preflight {
  public static class TestInPlaceJunction {
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;
    const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
      uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(IntPtr handle, uint controlCode, byte[] input, uint inputSize,
      IntPtr output, uint outputSize, out uint bytesReturned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    public static bool TryCreate(string path, string target) {
      IntPtr handle = CreateFileW(path, GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == InvalidHandle) return false;
      try {
        string substitute = @"\\??\\" + Path.GetFullPath(target);
        string print = Path.GetFullPath(target);
        byte[] substituteBytes = Encoding.Unicode.GetBytes(substitute);
        byte[] printBytes = Encoding.Unicode.GetBytes(print);
        int pathBytes = substituteBytes.Length + 2 + printBytes.Length + 2;
        byte[] buffer = new byte[16 + pathBytes];
        Array.Copy(BitConverter.GetBytes(IO_REPARSE_TAG_MOUNT_POINT), 0, buffer, 0, 4);
        Array.Copy(BitConverter.GetBytes((ushort)(8 + pathBytes)), 0, buffer, 4, 2);
        Array.Copy(BitConverter.GetBytes((ushort)0), 0, buffer, 8, 2);
        Array.Copy(BitConverter.GetBytes((ushort)substituteBytes.Length), 0, buffer, 10, 2);
        Array.Copy(BitConverter.GetBytes((ushort)(substituteBytes.Length + 2)), 0, buffer, 12, 2);
        Array.Copy(BitConverter.GetBytes((ushort)printBytes.Length), 0, buffer, 14, 2);
        Array.Copy(substituteBytes, 0, buffer, 16, substituteBytes.Length);
        Array.Copy(printBytes, 0, buffer, 18 + substituteBytes.Length, printBytes.Length);
        uint returned;
        return DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, buffer, (uint)buffer.Length,
          IntPtr.Zero, 0, out returned, IntPtr.Zero);
      } finally { CloseHandle(handle); }
    }
  }
}
'@ -Language CSharp -ErrorAction Stop
}
`;

const heldDirectorySwapHelperSource = `
if ($null -eq ('IntentArc.Preflight.TestHeldDirectorySwap' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
namespace IntentArc.Preflight {
  public sealed class TestHeldDirectorySwap : IDisposable {
    const uint DELETE = 0x00010000;
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint FILE_LIST_DIRECTORY = 0x00000001;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const int FileRenameInformation = 10;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
      uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr handle,
      out IO_STATUS_BLOCK ioStatus, IntPtr information, uint length, int informationClass);

    IntPtr original = InvalidHandle;
    IntPtr replacement = InvalidHandle;
    IntPtr sourceParent = InvalidHandle;
    IntPtr escapedParent = InvalidHandle;
    string sourceLeaf;
    string escapedLeaf;

    static IntPtr Open(string path, uint access) {
      IntPtr handle = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
      return handle;
    }

    public TestHeldDirectorySwap(string originalPath, string escapedPath, string replacementPath) {
      try {
        string sourceParentPath = Path.GetDirectoryName(originalPath);
        string escapedParentPath = Path.GetDirectoryName(escapedPath);
        sourceLeaf = Path.GetFileName(originalPath);
        escapedLeaf = Path.GetFileName(escapedPath);
        sourceParent = Open(sourceParentPath, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY);
        escapedParent = Open(escapedParentPath, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY);
        original = Open(originalPath, DELETE | FILE_READ_ATTRIBUTES);
        replacement = Open(replacementPath, DELETE | FILE_READ_ATTRIBUTES);
      } catch { Dispose(); throw; }
    }

    static void Rename(IntPtr item, IntPtr parent, string leaf) {
      byte[] name = Encoding.Unicode.GetBytes(leaf);
      int rootOffset = IntPtr.Size == 8 ? 8 : 4;
      int lengthOffset = rootOffset + IntPtr.Size;
      int nameOffset = lengthOffset + sizeof(uint);
      int size = nameOffset + name.Length;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
        Marshal.WriteIntPtr(buffer, rootOffset, parent);
        Marshal.WriteInt32(buffer, lengthOffset, name.Length);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
        IO_STATUS_BLOCK ioStatus;
        int status = NtSetInformationFile(item, out ioStatus, buffer, (uint)size, FileRenameInformation);
        if (status != 0) throw new InvalidOperationException("native-rename-status:" + status.ToString("x8"));
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    public void Swap() {
      Rename(original, escapedParent, escapedLeaf);
      Rename(replacement, sourceParent, sourceLeaf);
      Dispose();
    }

    public void Dispose() {
      if (replacement != InvalidHandle) { CloseHandle(replacement); replacement = InvalidHandle; }
      if (original != InvalidHandle) { CloseHandle(original); original = InvalidHandle; }
      if (escapedParent != InvalidHandle) { CloseHandle(escapedParent); escapedParent = InvalidHandle; }
      if (sourceParent != InvalidHandle) { CloseHandle(sourceParent); sourceParent = InvalidHandle; }
    }
  }
}
'@ -Language CSharp -ErrorAction Stop
}
`;

const receiptChildOverride = (fixture: Fixture, receipt: unknown | null) => `
$contract.invokeChild = {
  param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds)
  $script:childCalls++
  ${receipt === null ? "" : `
  [IO.Directory]::CreateDirectory('${escapePowerShell(dirname(fixture.receiptPath))}') | Out-Null
  [IO.File]::WriteAllText('${escapePowerShell(fixture.receiptPath)}', '${escapePowerShell(JSON.stringify(receipt))}')`}
  ${testChildResultSource()}
}
`;

const restoreArguments = (fixture: Fixture) => [
  "'-RestoreOnly'",
  "'-ExpectedCommit'",
  `'${commit}'`,
  "'-PnpmExecutable'",
  `'${escapePowerShell(fixture.pnpmExecutable)}'`,
  "'-ExpectedPnpmSha256'",
  `'${pnpmHash}'`,
].join(", ");

const prepareRecovery = async (fixture: Fixture) => {
  const command = [
    `. '${escapePowerShell(scriptPath)}'`,
    "Initialize-IntentArcPreflightNativeProcessType",
    `$source = '${escapePowerShell(fixture.sourcePath)}'`,
    `$destination = '${escapePowerShell(fixture.destinationPath)}'`,
    `$runRoot = '${escapePowerShell(fixture.runRoot)}'`,
    `$profile = '${escapePowerShell(fixture.childProfilePath)}'`,
    `$localAppData = '${escapePowerShell(fixture.childLocalAppDataPath)}'`,
    `$roaming = '${escapePowerShell(fixture.childRoamingAppDataPath)}'`,
    `$expectedCommit = '${commit}'`,
    `$pnpmPath = '${escapePowerShell(fixture.pnpmExecutable)}'`,
    `$pnpmSha256 = '${pnpmHash}'`,
    `$jobName = 'IntentArc.Preflight.${runId}.test'`,
    "$item = Get-Item -LiteralPath $source -Force -ErrorAction Stop",
    "$attributes = [IO.File]::GetAttributes($source)",
    "$now = [DateTime]::UtcNow.ToString('o')",
    "[IO.Directory]::CreateDirectory($runRoot) | Out-Null",
    "[IO.Directory]::CreateDirectory($profile) | Out-Null",
    "[IO.Directory]::CreateDirectory($localAppData) | Out-Null",
    "[IO.Directory]::CreateDirectory($roaming) | Out-Null",
    "$profileItem = Get-Item -LiteralPath $profile -Force -ErrorAction Stop",
    "$localItem = Get-Item -LiteralPath $localAppData -Force -ErrorAction Stop",
    "$opaqueIdentity = [ordered]@{",
    "  canonicalPath = [IO.Path]::GetFullPath($item.FullName)",
    "  attributes = [int]$attributes",
    "  creationTimeUtc = $item.CreationTimeUtc.ToString('o')",
    "  lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')",
    "  stableIdentity = [IntentArc.Preflight.DirectoryRenameSession]::ReadPathIdentity($source)",
    "}",
    "$profileIdentity = [ordered]@{ canonicalPath = [IO.Path]::GetFullPath($profileItem.FullName); attributes = [int][IO.File]::GetAttributes($profile); stableIdentity = [IntentArc.Preflight.DirectoryRenameSession]::ReadPathIdentity($profile) }",
    "$localIdentity = [ordered]@{ canonicalPath = [IO.Path]::GetFullPath($localItem.FullName); attributes = [int][IO.File]::GetAttributes($localAppData); stableIdentity = [IntentArc.Preflight.DirectoryRenameSession]::ReadPathIdentity($localAppData) }",
    `$state = [ordered]@{
      schema = 'intentarc.preflight-out-preservation-state/v2'
      sourcePath = $source
      destinationPath = $destination
      runId = '${runId}'
      expectedCommit = $expectedCommit
      directory = $opaqueIdentity
      ownedRoots = [ordered]@{ profile = $profileIdentity; localAppData = $localIdentity }
      pnpm = [ordered]@{ path = $pnpmPath; sha256 = $pnpmSha256 }
      child = [ordered]@{
        jobName = $jobName; rootProcessId = $null; rootStartTimeUtc = $null
        assignmentStatus = 'not-attempted'; settlementStatus = 'not-started'
        terminationReason = 'not-started'; exitCode = $null
        stdoutBytes = [int64]0; stderrBytes = [int64]0
        outputOverflow = $false; timedOut = $false; canceled = $false; infrastructureFailure = $false
      }
      recovery = [ordered]@{ mode = 'none'; sourcePhase = $null; settlementProvenAt = $null }
      cleanup = [ordered]@{
        localAppDataStatus = 'pending'; profileStatus = 'pending'
        runRootStatus = 'pending'; category = 'none'
      }
      timestamps = [ordered]@{
        preparedAt = $now; preservedAt = $now; childStartedAt = $null
        childSettledAt = $null; restoredAt = $null; completedAt = $null
      }
      phase = 'preserved'
    }`,
    "[IO.Directory]::Move($source, $destination)",
    `$state | ConvertTo-Json -Depth 12 -Compress | ForEach-Object { [IO.File]::WriteAllText('${escapePowerShell(fixture.statePath)}', $_, [Text.UTF8Encoding]::new($false)) }`,
    "$state | ConvertTo-Json -Depth 12 -Compress",
  ].join("\r\n");
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  });
  return JSON.parse(result.stdout);
};

const omitKey = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));

const childSettledState = (state: any, overrides: Record<string, unknown> = {}) => ({
  ...state,
  phase: "child-settled",
  child: {
    ...state.child,
    rootProcessId: 1,
    rootStartTimeUtc: state.timestamps.preservedAt,
    assignmentStatus: "assigned",
    settlementStatus: "settled",
    terminationReason: "normal-exit",
    exitCode: 0,
    ...overrides,
  },
  timestamps: {
    ...state.timestamps,
    childStartedAt: state.timestamps.preservedAt,
    childSettledAt: state.timestamps.preservedAt,
  },
});

type PrimaryOutcomeEvidence = {
  phase: "validated" | "prepared" | "preserved" | "child-started" | "child-settled" | "restored" | "complete";
  childStarted: boolean;
  childExitCode: number | null;
  outRestored: boolean;
  cleanupCategory: "none" | "residue-invalid";
  childSettlementFailed: boolean;
  restorationConflict: boolean;
  restorationFailed: boolean;
  restorationRestored: boolean;
  stateCategory: "none" | "preservation-state-invalid" | "state-evidence-invalid";
  preservationFailed: boolean;
  repositoryInvalid: boolean;
  pnpmBindingInvalid: boolean;
  childCategory: "none" | "preflight-start-failed" | "preflight-failed" | "preflight-timeout" | "preflight-canceled";
  receiptInvalid: boolean;
};

const successfulExecuteEvidence = (): PrimaryOutcomeEvidence => ({
  phase: "complete",
  childStarted: true,
  childExitCode: 0,
  outRestored: true,
  cleanupCategory: "none",
  childSettlementFailed: false,
  restorationConflict: false,
  restorationFailed: false,
  restorationRestored: true,
  stateCategory: "none",
  preservationFailed: false,
  repositoryInvalid: false,
  pnpmBindingInvalid: false,
  childCategory: "none",
  receiptInvalid: false,
});

const successfulRecoveryEvidence = (): PrimaryOutcomeEvidence => ({
  ...successfulExecuteEvidence(),
  childStarted: false,
  childExitCode: null,
});

const resolvePrimaryOutcome = async (
  mode: "-Execute" | "-RestoreOnly",
  evidence: PrimaryOutcomeEvidence,
  controllerPath = scriptPath,
) => {
  const fixture = await createFixture();
  const output = JSON.parse((await runCore(fixture, {
    controllerPath,
    argumentsVector: mode === "-Execute" ? undefined : restoreArguments(fixture),
    overrides: `$contract['primaryOutcomeEvidenceForTest'] = '${escapePowerShell(JSON.stringify(evidence))}' | ConvertFrom-Json`,
  })).stdout);
  return output.result as Record<string, unknown>;
};

const classifyRetainedState = async (fixture: Fixture, state: any) => {
  await writeFile(fixture.statePath, JSON.stringify(state), "utf8");
  await mkdir(fixture.sourcePath);
  return JSON.parse((await runCore(fixture, { argumentsVector: restoreArguments(fixture) })).stdout);
};

const runCore = async (
  fixture: Fixture,
  options: { argumentsVector?: string; overrides?: string; after?: string; env?: NodeJS.ProcessEnv; controllerPath?: string } = {},
) => {
  const argumentsVector = options.argumentsVector ?? [
    "'-Execute'",
    "'-ExpectedCommit'",
    `'${commit}'`,
    "'-PnpmExecutable'",
    `'${escapePowerShell(fixture.pnpmExecutable)}'`,
    "'-ExpectedPnpmSha256'",
    `'${pnpmHash}'`,
  ].join(", ");
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    `. '${escapePowerShell(options.controllerPath ?? scriptPath)}'`,
    contractSource(fixture, options.overrides),
    `$result = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @(${argumentsVector}) -TestContract $contract`,
    options.after ?? "[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls } | ConvertTo-Json -Depth 12 -Compress",
  ].join("\r\n");
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ...options.env },
    maxBuffer: 64 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
};

const establishModifyOnlyInheritedParent = async (fixture: Fixture, createParent = true) => {
  const command = [
    `$superpowers = '${escapePowerShell(fixture.superpowers)}'`,
    `$parent = '${escapePowerShell(fixture.preservationParent)}'`,
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$system = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)",
    "$administrators = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
    "$modify = [Security.AccessControl.DirectorySecurity]::new()",
    "$modify.SetOwner($current)",
    "$modify.SetAccessRuleProtection($true, $false)",
    "$modify.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::Modify, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))",
    "$modify.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))",
    "$modify.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administrators, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))",
    "[IO.DirectoryInfo]::new($superpowers).SetAccessControl($modify)",
    createParent ? "[IO.Directory]::CreateDirectory($parent) | Out-Null" : "$null = $null",
    createParent ? "$beforeProtected = [IO.DirectoryInfo]::new($parent).GetAccessControl().AreAccessRulesProtected" : "$beforeProtected = $null",
    "$closed = [Security.AccessControl.DirectorySecurity]::new()",
    "$closed.SetOwner($current)",
    "$closed.SetAccessRuleProtection($true, $false)",
    "foreach ($sid in @($current, $system, $administrators)) { $closed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)) }",
    "$postChangeError = $null",
    createParent ? "try { [IO.DirectoryInfo]::new($parent).SetAccessControl($closed) } catch { $postChangeError = $_.Exception.InnerException.GetType().FullName }" : "$postChangeError = $null",
    "[ordered]@{ beforeProtected = $beforeProtected; postChangeError = $postChangeError } | ConvertTo-Json -Compress",
  ].join("\r\n");
  const output = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
  });
  return JSON.parse(output.stdout) as { beforeProtected: boolean; postChangeError: string | null };
};

const readProductionStateAccess = async (fixture: Fixture) => {
  const command = [
    `. '${escapePowerShell(scriptPath)}'`,
    "Initialize-IntentArcPreflightNativeProcessType",
    `$parent = '${escapePowerShell(fixture.preservationParent)}'`,
    `$state = '${escapePowerShell(fixture.statePath)}'`,
    "[ordered]@{",
    "  parentProtected = [IO.DirectoryInfo]::new($parent).GetAccessControl().AreAccessRulesProtected",
    "  stateProtected = [IO.FileInfo]::new($state).GetAccessControl().AreAccessRulesProtected",
    "  valid = [IntentArc.Preflight.StateFileSecurity]::Validate($state, $parent)",
    "} | ConvertTo-Json -Compress",
  ].join("\r\n");
  const output = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
  });
  return JSON.parse(output.stdout) as { parentProtected: boolean; stateProtected: boolean; valid: boolean };
};

const expectClosedResult = (result: Record<string, unknown>) => {
  expect(Object.keys(result).sort()).toEqual(resultKeys);
  expect(result.schema).toBe("intentarc.preflight-out-preservation-result/v2");
  expect(["PASS", "RECOVERED", "REFUSED", "FAIL"]).toContain(result.status);
  expect([
    "none", "recovery-restored", "arguments-invalid", "repository-invalid", "preflight-id-used", "out-source-invalid",
    "preservation-state-invalid", "state-evidence-invalid", "pnpm-binding-invalid", "out-preservation-failed",
    "preflight-start-failed", "preflight-failed", "preflight-timeout", "preflight-canceled", "child-settlement-failed",
    "out-restoration-conflict", "out-restoration-failed", "receipt-invalid", "residue-invalid",
  ]).toContain(result.category);
  expect(["none", "residue-invalid"]).toContain(result.cleanupCategory);
  expect(["validated", "prepared", "preserved", "child-started", "child-settled", "restored", "complete"]).toContain(result.phase);
  expect(typeof result.childStarted).toBe("boolean");
  expect(result.childExitCode === null ||
    (Number.isInteger(result.childExitCode) &&
     result.childExitCode >= -2147483648 && result.childExitCode <= 2147483647)).toBe(true);
  expect(typeof result.outRestored).toBe("boolean");
};

const cleanupPolicyFailures = (source: string) => {
  const normalized = source.replaceAll("\r\n", "\n");
  const failures: string[] = [];
  const openEntry = normalized.match(/static IntPtr OpenEntry\(IntPtr parentHandle, string leaf, bool directory\) \{[\s\S]*?^        \}/m)?.[0];
  const openRoot = normalized.match(/static IntPtr OpenRoot\(string path\) \{[\s\S]*?^        \}/m)?.[0];
  const markDelete = normalized.match(/static CleanupResult MarkDelete\(IntPtr handle\) \{[\s\S]*?^        \}/m)?.[0];
  if (!openEntry || !openEntry.includes("RootDirectory = parentHandle") ||
      !openEntry.includes("NtOpenFile(out handle, access, ref attributes, out ioStatus, FILE_SHARE_READ, options)") ||
      openEntry.includes("FILE_SHARE_WRITE") || openEntry.includes("FILE_SHARE_DELETE") || openEntry.includes("CreateFileW(")) {
    failures.push("exclusive-handle-relative-child-open");
  }
  if (!openRoot || !openRoot.includes("FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING") ||
      openRoot.includes("FILE_SHARE_WRITE") || openRoot.includes("FILE_SHARE_DELETE")) {
    failures.push("exclusive-root-open");
  }
  if (!normalized.includes("childHandle = OpenEntry(directoryHandle, leaf, enumeratedDirectory)")) {
    failures.push("handle-relative-child-call");
  }
  if (!normalized.includes("string openedIdentity = DirectoryRenameSession.ReadIdentity(childHandle)") ||
      !normalized.includes("EnumerationMatchesHandle(data, opened, openedIdentity)")) {
    failures.push("enumerated-opened-identity");
  }
  if (!markDelete || !/SetFileInformationByHandle\(\s*handle\s*,\s*FileDispositionInfo/.test(markDelete) ||
      !normalized.includes(": MarkDelete(childHandle);") || !normalized.includes("return MarkDelete(directoryHandle);")) {
    failures.push("same-handle-disposition");
  }
  return failures;
};

const releaseLifecyclePolicyFailures = (source: string) => {
  const normalized = source.replaceAll("\r\n", "\n");
  const powerShellOnly = normalized.replace(/Add-Type -TypeDefinition @'\n[\s\S]*?\n'@/, "");
  const section = (startMarker: string, endMarker: string) => {
    const start = powerShellOnly.indexOf(startMarker);
    const end = start < 0 ? -1 : powerShellOnly.indexOf(endMarker, start + startMarker.length);
    return start >= 0 && end > start ? powerShellOnly.slice(start, end) : "";
  };
  const lifecycleAuthority = [
    /\b(?:signtool|certutil|makecert|makeappx|makemsix|msiexec|electron-builder|electron-forge)(?:\.exe)?\b/i,
    /\b(?:Set-AuthenticodeSignature|New-SelfSignedCertificate|Import-PfxCertificate|Export-PfxCertificate|Import-Certificate|Remove-Item\s+Cert:|Publish-Module)\b/i,
    /(?:^|[^A-Za-z0-9_])Cert:\\/im,
    /\b(?:signed-release|bridge-native-release|desktop:make|release:make)\b/i,
    /desktop:release(?!:preflight)\b/i,
    /(?:['"]publish['"]|\b(?:npm|pnpm|dotnet)\s+publish\b)/i,
    /\bStart-Process\b|\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(/i,
    /^\s*(?:saps|start|iex|Invoke-Expression|icm|Invoke-Command|ii|Invoke-Item|sajb|Start-Job)\b/im,
    /\[(?:System\.)?Diagnostics\.Process\]\s*::|\.Start\s*\(/i,
    /\b(?:Set-Alias|New-Alias|Set-Variable|New-Variable|InvokeScript)\b/i,
    /\b(?:Set-Item|si)\b[^\r\n]*\bVariable:/i,
  ];
  const authorizedContractCommands = new Set([
    "contract.afterownedchildopen", "contract.afterownedrootguardrelease", "contract.afterstablerecoveryopen",
    "contract.beforelocalappdataguard", "contract.beforeownedchildopen", "contract.beforeownedlayoutcreation",
    "contract.beforeownedlocalappdatacleanup", "contract.beforeownedprofilecleanup",
    "contract.beforerecoveryparentguard",
    "contract.beforeownedrootdisposition", "contract.beforeownedrootguards", "contract.beforepreparedstatewrite",
    "contract.beforereceiptboundaryguard", "contract.beforerecoveryidentityverification",
    "contract.beforerunrootcleanup", "contract.beforestablerecovery", "contract.beforestablerecoveryopen",
    "contract.beforestablerename", "contract.beforestatepersistence", "contract.beforestatepromotion",
    "contract.getpnpmsha256", "contract.getrepositorystate", "contract.getstabledirectoryidentity",
    "contract.getstablefileidentity", "contract.invokechild", "contract.movedirectory", "contract.onstatewritten",
    "contract.protectstateaccess", "contract.provechildabsent", "contract.validatestateaccess",
    "contract.verifyrecoveryidentityaftermove",
  ]);
  const dynamicCommands = [...normalized.matchAll(/&\s+\$((?:Contract|contract)\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1].toLowerCase());
  const dynamicCommandVariables = [...new Set(dynamicCommands.filter((command) => !command.includes(".")))];
  const unauthorizedDynamicCommand = dynamicCommands.some((command) => {
    if (command.includes(".")) return !authorizedContractCommands.has(command);
    if (command === "beforeread") return false;
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literalDefinitions = normalized.match(new RegExp(`^\\s*\\$${escaped}\\s*=\\s*\\{`, "gmi"))?.length ?? 0;
    const assignments = normalized.match(new RegExp(`^\\s*\\$(?:\\{${escaped}\\}|${escaped})\\s*=`, "gmi"))?.length ?? 0;
    return literalDefinitions !== 1 || assignments !== 1;
  });
  const bracedDynamicCommand = /&\s+\$\{[^}\r\n]+\}/i.test(normalized);
  const unsupportedCallOperator = [...powerShellOnly.matchAll(/&\s+(\S+)/g)]
    .some((match) => !/^\$(?:(?:Contract|contract)\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\b/.test(match[1]));
  const literalExternalCommand = /&\s+['"][^'"\r\n]+['"]/.test(normalized);
  const refDynamicCommand = dynamicCommandVariables.some((command) => {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\[ref\\]\\s*\\$(?:\\{${escaped}\\}|${escaped})\\b`, "i").test(powerShellOnly);
  });
  const dynamicNativeStaticLaunch = /\$[A-Za-z_][A-Za-z0-9_]*\s*::\s*(?:Run|RunForTest|RunForStandardOutput)\s*\(/i.test(powerShellOnly);
  const reflectedNativeLaunch = /\.(?:GetMethod|InvokeMember)\s*\(/i.test(powerShellOnly);
  const initializerStart = normalized.indexOf("function Initialize-IntentArcPreflightNativeProcessType {");
  const controllerStart = normalized.indexOf("function Invoke-IntentArcPreflightOutPreservation {");
  const entrypointStart = normalized.indexOf("if ($MyInvocation.InvocationName -ne '.') {");
  const closedSourceTopology = initializerStart > 0 && controllerStart > initializerStart && entrypointStart > controllerStart;
  const productionContractScope = closedSourceTopology ? normalized.slice(0, initializerStart) : "";
  const nativeInitializerScope = closedSourceTopology ? normalized.slice(initializerStart, controllerStart) : "";
  const controllerFunctionScope = closedSourceTopology ? normalized.slice(controllerStart, entrypointStart) : "";
  const entrypointScope = closedSourceTopology ? normalized.slice(entrypointStart) : "";
  const boundGitScope = section("    $invokeBoundGit = {", "    $invokeChild = {");
  const childScope = section("    $invokeChild = {", "    $getKeys = {");
  const allowedGitLaunch = `[IntentArc.Preflight.NativeProcess]::RunForStandardOutput(
            [string]$Contract.gitExecutable,
            [string[]]$arguments,
            [string]$Contract.repositoryRoot,
            $environment,
            30000,
            1000,
            65536,
            ([string]$Contract.jobName + '.git')
        )`;
  const allowedChildLaunch = `[IntentArc.Preflight.NativeProcess]::Run(
                    $nativeExecutable,
                    [string[]]$nativeArguments,
                    [string]$Contract.repositoryRoot,
                    $environment,
                    [int]$Contract.timeoutMilliseconds,
                    $descendantGrace,
                    [int]$Contract.maximumBytesPerStream,
                    [string]$Contract.jobName
                )`;
  const allowedTestLaunch = `[IntentArc.Preflight.NativeProcess]::RunForTest(
                    $nativeExecutable,
                    [string[]]$nativeArguments,
                    [string]$Contract.repositoryRoot,
                    $environment,
                    [int]$Contract.timeoutMilliseconds,
                    $descendantGrace,
                    [int]$Contract.maximumBytesPerStream,
                    [string]$Contract.jobName,
                    [string]$Contract.nativeFault
                )`;
  // Readable checks enumerate the three approved launch sites; the four semantic source segments close every
  // transitive executable authority, including the production contract and embedded native implementation.
  const boundGitAuthoritySha256 = createHash("sha256").update(boundGitScope).digest("hex");
  const childAuthoritySha256 = createHash("sha256").update(childScope).digest("hex");
  const productionContractAuthoritySha256 = createHash("sha256").update(productionContractScope).digest("hex");
  const nativeInitializerAuthoritySha256 = createHash("sha256").update(nativeInitializerScope).digest("hex");
  const controllerFunctionAuthoritySha256 = createHash("sha256").update(controllerFunctionScope).digest("hex");
  const entrypointAuthoritySha256 = createHash("sha256").update(entrypointScope).digest("hex");
  const closedNativeLaunchAuthority =
    closedSourceTopology &&
    (powerShellOnly.match(/\[IntentArc\.Preflight\.NativeProcess\]::Run\(/g)?.length ?? 0) === 1 &&
    (powerShellOnly.match(/\[IntentArc\.Preflight\.NativeProcess\]::RunForStandardOutput\(/g)?.length ?? 0) === 1 &&
    (powerShellOnly.match(/\[IntentArc\.Preflight\.NativeProcess\]::RunForTest\(/g)?.length ?? 0) === 1 &&
    (boundGitScope.match(/\[IntentArc\.Preflight\.NativeProcess\]::RunForStandardOutput\(/g)?.length ?? 0) === 1 &&
    (childScope.match(/\[IntentArc\.Preflight\.NativeProcess\]::Run\(/g)?.length ?? 0) === 1 &&
    (childScope.match(/\[IntentArc\.Preflight\.NativeProcess\]::RunForTest\(/g)?.length ?? 0) === 1 &&
    boundGitScope.includes(allowedGitLaunch) && childScope.includes(allowedChildLaunch) && childScope.includes(allowedTestLaunch) &&
    boundGitScope.includes("$arguments = @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', [string]$Contract.repositoryRoot) + @($GitArguments)") &&
    (boundGitScope.match(/^\s*\$arguments\s*=/gm)?.length ?? 0) === 1 &&
    (boundGitScope.match(/\$arguments\b/gi)?.length ?? 0) === 2 &&
    childScope.includes("$nativeExecutable = $Executable\n        $nativeArguments = $argumentList\n        $descendantGrace = 2000") &&
    (childScope.match(/^\s*\$nativeExecutable\s*=/gm)?.length ?? 0) === 2 &&
    (childScope.match(/^\s*\$nativeArguments\s*=/gm)?.length ?? 0) === 2 &&
    (childScope.match(/^\s*\$descendantGrace\s*=/gm)?.length ?? 0) === 2 &&
    (childScope.match(/\$nativeExecutable\b/gi)?.length ?? 0) === 5 &&
    (childScope.match(/\$nativeArguments\b/gi)?.length ?? 0) === 4 &&
    (powerShellOnly.match(/\$invokeChild\b/gi)?.length ?? 0) === 2 &&
    (powerShellOnly.match(/\[IntentArc\.Preflight\.NativeProcess\]/gi)?.length ?? 0) === 4 &&
    boundGitAuthoritySha256 === "f06251ed4cfc2e3f89765635ba77c1118ddd88fa721d9cb042757f37456aca4c" &&
    childAuthoritySha256 === "0bf392960eb245372064535ab14d8998336e900fd92b754d6abb6dd7c3b969b9" &&
    productionContractAuthoritySha256 === "b99ee5a18b2f62395ae45047c1b2581a5f8cde73adde7d319161a7e1920d658a" &&
    nativeInitializerAuthoritySha256 === "fb3c873bafdfa265611ecf7306bbc92619857235df04876ced5072bb32b14dc3" &&
    controllerFunctionAuthoritySha256 === "a26649b3cdc019c3518059c7cca31c0920f00b62fc56a2f2c6cc1436dd4c7f1b" &&
    entrypointAuthoritySha256 === "2141bf9d469016eb8e91c50e3acb8e5554ed6be7197713ca057b7b4aa1cf8fa7";
  return lifecycleAuthority.some((pattern) => pattern.test(normalized)) ||
    unauthorizedDynamicCommand || bracedDynamicCommand || unsupportedCallOperator || literalExternalCommand ||
    refDynamicCommand || dynamicNativeStaticLaunch || reflectedNativeLaunch || !closedNativeLaunchAuthority
    ? ["no-release-lifecycle-call"] : [];
};

const controllerInvariantFailures = (source: string) => {
  const normalized = source.replaceAll("\r\n", "\n");
  const failures: string[] = [];
  const count = (pattern: RegExp) => normalized.match(pattern)?.length ?? 0;
  const section = (startMarker: string, endMarker: string) => {
    const start = normalized.indexOf(startMarker);
    const end = start < 0 ? -1 : normalized.indexOf(endMarker, start + startMarker.length);
    return start >= 0 && end > start ? normalized.slice(start, end) : "";
  };

  const ownedLayoutScope = section(
    "        Initialize-IntentArcPreflightNativeProcessType\n        $superpowersSetupGuard",
    "        $timestamps.preparedAt = & $now",
  );
  const executeSetupScope = section(
    "    try {\n        Initialize-IntentArcPreflightNativeProcessType\n        $superpowersSetupGuard",
    "    } catch {",
  );
  const superpowersGuard = ownedLayoutScope.indexOf(
    "$superpowersSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(",
  );
  const stateProtection = ownedLayoutScope.indexOf("if (-not (& $protectStateAccess $contract))");
  const preservationParentGuard = ownedLayoutScope.indexOf(
    "$preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenOrCreateProtectedStateParent(",
  );
  const runRootCreation = ownedLayoutScope.indexOf(
    "$runRootSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive(",
  );
  if (!ownedLayoutScope ||
      !(superpowersGuard >= 0 && superpowersGuard < preservationParentGuard &&
        preservationParentGuard < stateProtection && stateProtection < runRootCreation) ||
      (ownedLayoutScope.match(/\[IntentArc\.Preflight\.DirectoryComponentGuard\]::OpenForCreation\(/g)?.length ?? 0) !== 3 ||
      (ownedLayoutScope.match(/\[IntentArc\.Preflight\.DirectoryComponentGuard\]::OpenOrCreateProtectedStateParent\(/g)?.length ?? 0) !== 1 ||
      (ownedLayoutScope.match(/\[IntentArc\.Preflight\.DirectoryComponentGuard\]::CreateExclusive\(/g)?.length ?? 0) !== 4 ||
      !ownedLayoutScope.includes("$profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($runRootSetupGuard, 'profile')") ||
      !ownedLayoutScope.includes("$localAppDataGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($runRootSetupGuard, 'localappdata')") ||
      !ownedLayoutScope.includes("$roamingSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive($localAppDataGuard, 'Roaming')") ||
      /\[IO\.Directory\]::CreateDirectory\(\[string\]\$contract\.(?:runRoot|childProfilePath|childLocalAppDataPath|childRoamingAppDataPath)\)/.test(ownedLayoutScope)) {
    failures.push("handle-relative-owned-layout");
  }

  if (count(/intentarc\.preflight-out-preservation-state\/v2/g) !== 2 ||
      /intentarc\.preflight-out-preservation-state\/v1/.test(normalized)) failures.push("closed-v2-state-schema");
  if (count(/phase1-preflight-20260901-06/g) !== 2 || normalized.includes("phase1-preflight-20260830-05")) {
    failures.push("fixed-id06-identity");
  }
  const preparedJournal = normalized.indexOf(
    "        $preparedWriteAttempted = $true\n        & $writeState $contract $state\n        $preparedStateDurable = $true",
  );
  const preservationMove = normalized.indexOf(
    "            & $moveDirectory $contract ([string]$contract.sourcePath) ([string]$contract.destinationPath)",
  );
  if (preparedJournal < 0 || preservationMove < 0 || preparedJournal >= preservationMove) failures.push("prepared-before-rename");
  const childIntent = normalized.indexOf("        $timestamps.childStartedAt = & $now");
  const childIntentJournal = childIntent < 0 ? -1 : normalized.indexOf("            & $writeState $contract $state", childIntent);
  const childInvocation = normalized.indexOf("            $child = & $invokeChild $contract $pnpmExecutable");
  if (childIntent < 0 || childIntentJournal < 0 || childInvocation < 0 ||
      !(childIntent < childIntentJournal && childIntentJournal < childInvocation)) failures.push("intent-before-child");
  if (!normalized.includes("        maximumBytesPerStream = 1048576")) failures.push("one-megabyte-output-cap");
  if (!normalized.includes("        $environment['APPDATA'] = [IO.Path]::GetFullPath([string]$Contract.childRoamingAppDataPath)")) {
    failures.push("closed-appdata-routing");
  }
  const stableOwnedBoundary = section("    $stableDirectoryBoundaryMatches = {", "    $newOwnedRootEvidence = {");
  const expectedStableOwnedBoundary = `
    $stableDirectoryBoundaryMatches = {
        param($Expected, [string] $LiteralPath)
        $actual = & $getOrdinaryDirectoryIdentity $LiteralPath
        if ($null -eq $actual) { return $false }
        $actualStableIdentity = & $getStableDirectoryIdentity $contract $LiteralPath
        return [string]::Equals(
            [string]$actual.canonicalPath,
            [IO.Path]::GetFullPath($LiteralPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -and (([int]$actual.attributes -band [int][IO.FileAttributes]::Directory) -ne 0) -and
            (([int]$actual.attributes -band [int][IO.FileAttributes]::ReparsePoint) -eq 0) -and
            (([int]$Expected.attributes -band [int][IO.FileAttributes]::Directory) -ne 0) -and
            (([int]$Expected.attributes -band [int][IO.FileAttributes]::ReparsePoint) -eq 0) -and
            [string]$actualStableIdentity -ceq [string]$Expected.stableIdentity
    }
  `;
  const stableOwnedBoundaryClosed = stableOwnedBoundary.replace(/\s+/g, " ").trim() ===
    expectedStableOwnedBoundary.replace(/\s+/g, " ").trim();
  if (!stableOwnedBoundaryClosed || /creationTimeUtc|lastWriteTimeUtc/.test(stableOwnedBoundary)) {
    failures.push("owned-root-boundary-metadata");
  }
  const heldOwnedBoundary = section("    $heldDirectoryBoundaryMatches = {", "    $removeOwnedRoot = {");
  const ownedRemovalScope = section("    $removeOwnedRoot = {", "    $removeRunRoot = {");
  const ownedRemovalAuthoritySha256 = createHash("sha256").update(ownedRemovalScope).digest("hex");
  const persistedAuthorityStart = normalized.indexOf("    $stableDirectoryBoundaryMatches = {");
  const persistedAuthorityEnd = persistedAuthorityStart < 0 ? -1 : normalized.indexOf(
    "\n}\n\nif ($MyInvocation.InvocationName -ne '.') {",
    persistedAuthorityStart,
  );
  const persistedAuthorityScope = persistedAuthorityStart >= 0 && persistedAuthorityEnd > persistedAuthorityStart
    ? normalized.slice(persistedAuthorityStart, persistedAuthorityEnd + 2) : "";
  const persistedAuthoritySha256 = createHash("sha256").update(persistedAuthorityScope).digest("hex");
  const expectedHeldOwnedBoundary = `
    $heldDirectoryBoundaryMatches = {
        param($Expected, [string] $LiteralPath, $Guard)
        if ($null -eq $Guard -or [string]$Guard.Identity -cne [string]$Expected.stableIdentity) { return $false }
        $actual = & $getOrdinaryDirectoryIdentity $LiteralPath
        return $null -ne $actual -and
            [string]::Equals([string]$actual.canonicalPath, [IO.Path]::GetFullPath($LiteralPath), [StringComparison]::OrdinalIgnoreCase) -and
            [int]$actual.attributes -eq [int]$Expected.attributes
    }
  `;
  const recoveryScope = section(
    "    if ($mode -ceq '-RestoreOnly') {\n        try {\n        Initialize-IntentArcPreflightNativeProcessType",
    "    $timestamps = [ordered]@{",
  );
  const lowerRecoveryScope = recoveryScope.toLowerCase();
  const profileAuthorityAssignments = recoveryScope.match(/\$profileIdentity(?:\s*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\r\n]+\]))*\s*=/gi)?.length ?? 0;
  const localAuthorityAssignments = recoveryScope.match(/\$localAppDataIdentity(?:\s*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\r\n]+\]))*\s*=/gi)?.length ?? 0;
  if (!recoveryScope || recoveryScope.includes("$newOwnedRootEvidence") ||
      !stableOwnedBoundaryClosed ||
      heldOwnedBoundary.replace(/\s+/g, " ").trim() !== expectedHeldOwnedBoundary.replace(/\s+/g, " ").trim() ||
      ownedRemovalAuthoritySha256 !== "ec41fc99461f131a5d65acc9e78cd78d4a2cc9c6f47670203802536d1c830eed" ||
      persistedAuthoritySha256 !== "11699e0c313aee4a0cfc9169cb5caacccc009ef9fc74164b9452a9abc7564d02" ||
      profileAuthorityAssignments !== 1 || localAuthorityAssignments !== 1 ||
      (lowerRecoveryScope.match(/\$profileidentity\b/g)?.length ?? 0) !== 4 ||
      (lowerRecoveryScope.match(/\$localappdataidentity\b/g)?.length ?? 0) !== 4 ||
      !lowerRecoveryScope.includes("$profileidentity = $state.ownedroots.profile") ||
      !lowerRecoveryScope.includes("$localappdataidentity = $state.ownedroots.localappdata") ||
      (lowerRecoveryScope.match(/\$state\.ownedroots\b/g)?.length ?? 0) !== 2 ||
      /\$state\.ownedroots\.(?:profile|localappdata)[^\r\n]*=/i.test(recoveryScope) ||
      /\$getStableDirectoryIdentity\s+\$contract\s+(?:\(\[string\]\s*)?\$contract\.child(?:Profile|LocalAppData)Path/i.test(recoveryScope)) {
    failures.push("persisted-recovery-identity");
  }
  const heldBoundaryCalls = normalized.match(/& \$heldDirectoryBoundaryMatches\b/g)?.length ?? 0;
  const ownedRemovalCalls = normalized.match(/& \$removeOwnedRoot\b/g)?.length ?? 0;
  const stableBoundaryReferences = normalized.match(/\$stableDirectoryBoundaryMatches\b/gi)?.length ?? 0;
  const heldBoundaryReferences = normalized.match(/\$heldDirectoryBoundaryMatches\b/gi)?.length ?? 0;
  const ownedRemovalReferences = normalized.match(/\$removeOwnedRoot\b/gi)?.length ?? 0;
  if (heldBoundaryCalls !== 6 || ownedRemovalCalls !== 4 ||
      stableBoundaryReferences !== 6 || heldBoundaryReferences !== 7 || ownedRemovalReferences !== 5 ||
      (normalized.match(/& \$heldDirectoryBoundaryMatches \$profileIdentity \(\[string\]\$contract\.childProfilePath\) \$profileGuard/g)?.length ?? 0) !== 2 ||
      (normalized.match(/& \$heldDirectoryBoundaryMatches \$localAppDataIdentity \(\[string\]\$contract\.childLocalAppDataPath\) \$localAppDataGuard/g)?.length ?? 0) !== 2 ||
      (normalized.match(/& \$heldDirectoryBoundaryMatches \$boundaryIdentities\.childProfilePath \(\[string\]\$contract\.childProfilePath\) \$profileGuard/g)?.length ?? 0) !== 1 ||
      (normalized.match(/& \$heldDirectoryBoundaryMatches \$boundaryIdentities\.childLocalAppDataPath \(\[string\]\$contract\.childLocalAppDataPath\) \$localAppDataGuard/g)?.length ?? 0) !== 1 ||
      (normalized.match(/& \$removeOwnedRoot \$contract \$profileIdentity \$contract\.childProfilePath \$profileGuard/g)?.length ?? 0) !== 1 ||
      (normalized.match(/& \$removeOwnedRoot \$contract \$localAppDataIdentity \$contract\.childLocalAppDataPath \$localAppDataGuard/g)?.length ?? 0) !== 1 ||
      (normalized.match(/& \$removeOwnedRoot \$contract \$state\.ownedRoots\.profile \$contract\.childProfilePath \$profileGuard/g)?.length ?? 0) !== 1 ||
      (normalized.match(/& \$removeOwnedRoot \$contract \$state\.ownedRoots\.localAppData \$contract\.childLocalAppDataPath \$localAppDataGuard/g)?.length ?? 0) !== 1) {
    failures.push("persisted-recovery-identity");
  }
  if (!recoveryScope ||
      (recoveryScope.match(/\[IntentArc\.Preflight\.DirectoryComponentGuard\]::Open\(\[string\]\$contract\.childProfilePath\)/g)?.length ?? 0) !== 1 ||
      (recoveryScope.match(/\[IntentArc\.Preflight\.DirectoryComponentGuard\]::Open\(\[string\]\$contract\.childLocalAppDataPath\)/g)?.length ?? 0) !== 1 ||
      !recoveryScope.includes("& $heldDirectoryBoundaryMatches $profileIdentity") ||
      !recoveryScope.includes("& $heldDirectoryBoundaryMatches $localAppDataIdentity")) {
    failures.push("recovery-held-guards");
  }
  if ((recoveryScope.match(/\$profileStatus\s*=\s*& \$removeOwnedRoot/g)?.length ?? 0) !== 1 ||
      (recoveryScope.match(/\$localAppDataStatus\s*=\s*& \$removeOwnedRoot/g)?.length ?? 0) !== 1 ||
      !recoveryScope.includes("$profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard") ||
      !recoveryScope.includes("$localAppDataStatus = & $removeOwnedRoot $contract $localAppDataIdentity $contract.childLocalAppDataPath $localAppDataGuard")) {
    failures.push("recovery-authority-flow");
  }
  if ((normalized.match(/\[IntentArc\.Preflight\.OwnedDirectoryCleaner\]::RemoveTreeNoFollow\(/g)?.length ?? 0) !== 1 ||
      !ownedRemovalScope.includes(
    "[IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity",
  ) || /\[(?:(?:System\.)?IO\.)?Directory\]::Delete\([^\r\n]*,\s*\$true\s*\)|\bRemove-Item\b[^\r\n]*-(?:Recurse|r)\b|\.Delete\(\s*\$true\s*\)|\bDeleteDirectory\s*\(/i.test(normalized)) {
    failures.push("owned-recursive-target");
  }
  const resolverScope = section("    $resolvePrimaryOutcome = {", "    $projectResolvedOutcome = {");
  const projectionScope = section("    $projectResolvedOutcome = {", "    $protectStateAccess = {");
  const directFooterStart = normalized.indexOf("if ($MyInvocation.InvocationName -ne '.') {");
  const directFooterScope = directFooterStart < 0 ? "" : normalized.slice(directFooterStart);
  const directAuthorityStart = normalized.indexOf("    return & $projectResolvedOutcome $mode $executeEvidence");
  const directAuthorityScope = directAuthorityStart < 0 ? "" : normalized.slice(directAuthorityStart);
  const directAuthoritySha256 = createHash("sha256").update(directAuthorityScope).digest("hex");
  const expectedProjectionScope = `
    $projectResolvedOutcome = {
        param([string] $Mode, $Evidence)
        $primary = & $resolvePrimaryOutcome $Mode $Evidence
        $projectedChildStarted = if ($Mode -ceq '-RestoreOnly') { $false } else { [bool]$Evidence.childStarted }
        $projectedChildExitCode = if ($Mode -ceq '-RestoreOnly') { $null } else { $Evidence.childExitCode }
        return & $result ([string]$primary.status) ([string]$primary.category) ([string]$primary.phase) $projectedChildStarted $projectedChildExitCode ([bool]$Evidence.outRestored) ([string]$primary.cleanupCategory)
    }
  `;
  if ((resolverScope.match(/\$primary\.category = 'residue-invalid'/g)?.length ?? 0) !== 1 ||
      !resolverScope.includes("} elseif ($cleanupCategory -ceq 'residue-invalid') {") ||
      /\$primary\.(?:status|category)\s*=\s*\$cleanupCategory/.test(resolverScope) ||
      !/\$primary\.status = 'RECOVERED'; \$primary\.category = 'recovery-restored'\n\s*}\n\s*}\n\s*return \[ordered\]@\{/.test(resolverScope)) {
    failures.push("cleanup-secondary-projection");
  }
  if ((resolverScope.match(/\$primary\.status = 'PASS'/g)?.length ?? 0) !== 0 ||
      (resolverScope.match(/\$primary\.status = 'RECOVERED'; \$primary\.category = 'recovery-restored'/g)?.length ?? 0) !== 1 ||
      !resolverScope.includes("            status = [string]$primary.status\n            category = [string]$primary.category\n            phase = [string]$primary.phase\n            cleanupCategory = $cleanupCategory") ||
      /['"]PASS['"]/.test(recoveryScope) ||
      /(?:function|filter)\s+(?:(?:global|script):)?ConvertTo-Json\b/i.test(normalized) ||
      /\bConvertTo-Json\b/i.test(directFooterScope) ||
      !directFooterScope.includes("$actualResultKeys = @($controllerResult.Keys)") ||
      !directFooterScope.includes("if ($controllerResult.status -cne 'PASS') { exit 1 }\n    exit 0") ||
      directAuthoritySha256 !== "0e1ae12ebda9c7d23529ba6cc990c474ab47bd0c97124c921d84f23a4d30a8a8" ||
      projectionScope.replace(/\s+/g, " ").trim() !== expectedProjectionScope.replace(/\s+/g, " ").trim()) {
    failures.push("restore-only-non-authorizing");
  }
  const writeStateScope = section("    $writeState = {", "    $writeAdvancedStateIfValid = {");
  if ((writeStateScope.match(/\$preservationParentSetupGuard\.MatchesPath\(\[string\]\$Contract\.preservationParent\)/g)?.length ?? 0) !== 2 ||
      !recoveryScope.includes("$preservationParentSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation(") ||
      !normalized.includes("OpenOrCreateProtectedStateParent") ||
      executeSetupScope.includes("$preservationParentSetupGuard.Dispose()") ||
      executeSetupScope.includes("$superpowersSetupGuard.Dispose()")) {
    failures.push("continuous-state-parent-authority");
  }
  if (!normalized.includes("} finally {\n        if ($preservationAttempted -and $restorationAuthorized)")) failures.push("finally-restoration");
  if (count(/& \$invokeChild /g) !== 1) failures.push("single-child-site");
  if (count(/\[string\]::Equals\(\$Destination, \[string\]\$Contract\.(?:destinationPath|sourcePath), \[StringComparison\]::OrdinalIgnoreCase\)/g) !== 2) failures.push("exact-destination");
  if (!normalized.includes("if ($sourceStateAfter -ceq 'absent' -and $destinationStateAfter -ceq 'present')") ||
      !normalized.includes("elseif ($sourceStateAfter -ceq 'present' -and $destinationStateAfter -ceq 'absent')")) failures.push("restoration-conflicts");
  if (!normalized.includes("$resultStatuses = @('PASS', 'RECOVERED', 'REFUSED', 'FAIL')") ||
      !normalized.includes("$resultPhases = @('validated', 'prepared', 'preserved', 'child-started', 'child-settled', 'restored', 'complete')") ||
      !normalized.includes("'receipt-invalid', 'residue-invalid'") ||
      !normalized.includes("cleanupCategory = $CleanupCategory")) failures.push("closed-result-enums");
  if (!normalized.includes("'--dir', [string]$Contract.repositoryRoot,\n            'run', 'desktop:release:preflight',\n            '--run-id', [string]$Contract.runId,\n            '--tracked-only'")) failures.push("direct-child-vector");
  if (!normalized.includes("if ($null -eq $TestContract -or $contract.useStableRename -eq $true)") ||
      !normalized.includes("$null -eq $TestContract -or $contract.useStableRecovery -eq $true") ||
      !normalized.includes("if ($null -eq $TestContract -or $contract.useStableReceiptBoundary -eq $true)")) failures.push("stable-production-selection");
  if (!normalized.includes("MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH") ||
      !normalized.includes("[IntentArc.Preflight.StateFileSecurity]::PromoteStateFile($temporary, [string]$Contract.statePath)")) failures.push("write-through-state-promotion");
  failures.push(...cleanupPolicyFailures(normalized));
  failures.push(...releaseLifecyclePolicyFailures(normalized));
  return failures;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

windowsOnly("desktop release preflight opaque out preservation", () => {
  it("is dormant when dot-sourced", async () => {
    // Break caught: import-time execution could touch the fixed production paths.
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$script:mutations = 0",
      "function global:Start-Process { $script:mutations++; throw 'secret-start-trap' }",
      "function global:Move-Item { $script:mutations++; throw 'secret-move-trap' }",
      "function global:Remove-Item { $script:mutations++; throw 'secret-remove-trap' }",
      `. '${escapePowerShell(scriptPath)}'`,
      "[ordered]@{ mutations = $script:mutations; available = $null -ne (Get-Command Invoke-IntentArcPreflightOutPreservation -CommandType Function) } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    expect(JSON.parse(result.stdout)).toEqual({ mutations: 0, available: true });
    expect(result.stderr).toBe("");
  });

  it("[id06-contract] ID06 accepts the ordered execute vector", async () => {
    // Break caught: an ID06 parser must retain the one supported execution vector.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture)).stdout);
    expect(output.result.category).not.toBe("arguments-invalid");
    expect(output.childCalls).toBe(1);
    expectClosedResult(output.result);
  });

  it("[id06-contract] ID06 accepts the ordered restore vector", async () => {
    // Break caught: recovery has a separately ordered, closed public vector.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
    })).stdout);
    expect(output.result.category).not.toBe("arguments-invalid");
    expect(output.result.outRestored).toBe(true);
    expectClosedResult(output.result);
  });

  it.each([
    ["case drift", "'-execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["reordered", "'-ExpectedCommit', '" + commit + "', '-Execute', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["duplicated", "'-Execute', '-ExpectedCommit', '" + commit + "', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["omitted", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe'"],
    ["combined modes", "'-Execute', '-RestoreOnly', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["common parameter", "'-Verbose'"],
    ["eighth token", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "', '-NoProfile'"],
    ["wildcard", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm*.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["quote", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pn\"pm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["control character", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm\u0001.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["device path", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', '\\\\?\\C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["UNC/nonlocal path", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', '\\\\server\\\\share\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["wrong executable leaf", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\npm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["malformed commit", "'-Execute', '-ExpectedCommit', 'ABC', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["malformed hash", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', 'ABC'"],
    ["relative executable", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
  ])("[id06-contract] ID06 rejects the %s vector", async (_name, argumentsVector) => {
    // Break caught: accepting any alternate token, mode, or executable expands the public command surface.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, { argumentsVector })).stdout);
    expect(output.result).toMatchObject({
      status: "REFUSED", category: "arguments-invalid", childStarted: false, outRestored: false,
    });
    expectClosedResult(output.result);
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
  });

  it("[id06-contract] ID06 emits only the closed v2 result keys, types, and enums", async () => {
    // Break caught: a public result with an omitted cleanup field or open enum cannot be safely consumed.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture)).stdout);
    expectClosedResult(output.result);
  });

  it("[id06-contract] ID06 fixes the controller production source policy", async () => {
    // Break caught: a retained ID05 namespace or unbounded child-output policy targets the wrong production boundary.
    const command = [
      `. '${escapePowerShell(scriptPath)}'`,
      "$contract = New-IntentArcPreflightOutPreservationProductionContract",
      "[ordered]@{ runId = $contract.runId; childRoamingAppDataPath = $contract.childRoamingAppDataPath; jobName = $contract.jobName; maximumBytesPerStream = $contract.maximumBytesPerStream; timeoutMilliseconds = $contract.timeoutMilliseconds } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const output = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    });
    expect(JSON.parse(output.stdout)).toEqual({
      runId: "phase1-preflight-20260901-06",
      childRoamingAppDataPath: "C:\\projects\\Project Manager\\.superpowers\\preflight-out-preservation\\phase1-preflight-20260901-06\\localappdata\\Roaming",
      jobName: "IntentArc.Preflight.phase1-preflight-20260901-06",
      maximumBytesPerStream: 1048576,
      timeoutMilliseconds: 2700000,
    });
  });

  it.each([
    ["reordered", "'-ExpectedCommit', '" + commit + "', '-Execute', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["missing", "'-Execute', '-ExpectedCommit', '" + commit + "'"],
    ["duplicate", "'-Execute', '-ExpectedCommit', '" + commit + "', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["extra", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "', '-Force'"],
    ["common parameter", "'-Verbose'"],
    ["malformed commit", "'-Execute', '-ExpectedCommit', 'ABC', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["malformed hash", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', 'ABC'"],
    ["relative executable", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["wrong executable leaf", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\npm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["wildcard", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', 'C:\\\\tools\\\\pnpm*.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
    ["device path", "'-Execute', '-ExpectedCommit', '" + commit + "', '-PnpmExecutable', '\\\\?\\C:\\\\tools\\\\pnpm.exe', '-ExpectedPnpmSha256', '" + pnpmHash + "'"],
  ])("refuses the %s public argument vector", async (_name, vector) => {
    // Break caught: a loose parser could admit an unreviewed execution vector.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, { argumentsVector: vector })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "arguments-invalid", childStarted: false, outRestored: false });
    expectClosedResult(output.result);
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
  });

  it.each([
    ["wrong branch", "$contract.getRepositoryState = { [ordered]@{ branch = 'feature'; commit = '" + commit + "'; statusRows = @() } }", "repository-invalid"],
    ["wrong commit", "$contract.getRepositoryState = { [ordered]@{ branch = 'master'; commit = '" + "c".repeat(40) + "'; statusRows = @() } }", "repository-invalid"],
    ["tracked status", "$contract.getRepositoryState = { [ordered]@{ branch = 'master'; commit = '" + commit + "'; statusRows = @(' M tracked.txt') } }", "repository-invalid"],
    ["pnpm drift", `$contract.getPnpmSha256 = { param($Path) '${"c".repeat(64)}' }`, "pnpm-binding-invalid"],
  ])("refuses %s before preservation", async (_name, overrides, category) => {
    // Break caught: precondition drift must never permit a rename or child start.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, { overrides })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category, childStarted: false, outRestored: false });
    expectClosedResult(output.result);
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("refuses a used receipt before preservation", async () => {
    // Break caught: an occupied receipt makes ID05 terminal and non-retryable.
    const fixture = await createFixture();
    await mkdir(dirname(fixture.receiptPath), { recursive: true });
    await writeFile(fixture.receiptPath, JSON.stringify(validReceipt()), "utf8");
    const output = JSON.parse((await runCore(fixture)).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preflight-id-used" });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
  });

  it.each(["root", "superpowers", "source", "destination", "preservation-parent", "run-root"]) (
    "refuses an invalid %s exact entry before child start",
    async (kind) => {
      // Break caught: files/reparse/occupied exact entries must fail closed before mutation.
      const fixture = await createFixture();
      if (kind === "root") {
        await rm(fixture.repositoryRoot, { recursive: true, force: true });
        await writeFile(fixture.repositoryRoot, "file", "utf8");
      } else if (kind === "superpowers") {
        await rm(fixture.superpowers, { recursive: true, force: true });
        await writeFile(fixture.superpowers, "file", "utf8");
      } else if (kind === "source") {
        await rm(fixture.sourcePath, { recursive: true, force: true });
        await writeFile(fixture.sourcePath, "file", "utf8");
      } else if (kind === "destination") {
        await mkdir(fixture.destinationPath, { recursive: true });
      } else if (kind === "preservation-parent") {
        await writeFile(fixture.preservationParent, "file", "utf8");
      } else {
        await mkdir(fixture.runRoot, { recursive: true });
      }
      const output = JSON.parse((await runCore(fixture)).stdout);
      expect(output.result.status).toBe("REFUSED");
      expect(["repository-invalid", "out-source-invalid", "preservation-state-invalid"]).toContain(output.result.category);
      expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    },
  );

  it.each(["source missing", "source reparse", "preservation-parent reparse", "run-root reparse", "pnpm reparse"]) (
    "refuses a %s fixture before preservation",
    async (kind) => {
      // Break caught: absence or a reparse boundary must never be treated as the fixed ordinary entry.
      const fixture = await createFixture();
      const target = join(fixture.root, `reparse-target-${kind.replaceAll(" ", "-")}`);
      if (kind === "source missing") {
        await rm(fixture.sourcePath, { recursive: true, force: true });
      } else if (kind === "source reparse") {
        await rm(fixture.sourcePath, { recursive: true, force: true });
        await mkdir(target);
        await symlink(target, fixture.sourcePath, "junction");
      } else if (kind === "preservation-parent reparse") {
        await mkdir(target);
        await symlink(target, fixture.preservationParent, "junction");
      } else if (kind === "run-root reparse") {
        await mkdir(fixture.preservationParent);
        await mkdir(target);
        await symlink(target, fixture.runRoot, "junction");
      } else {
        await rm(fixture.pnpmExecutable, { force: true });
        await mkdir(target);
        await symlink(target, fixture.pnpmExecutable, "junction");
      }

      const output = JSON.parse((await runCore(fixture)).stdout);
      expect(output.result.status).toBe("REFUSED");
      expect(["out-source-invalid", "preservation-state-invalid", "pnpm-binding-invalid"]).toContain(output.result.category);
      expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    },
  );

  it("refuses an indeterminate preservation-parent exact entry before mutation", async () => {
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `function global:Get-Item {
  [CmdletBinding()]
  param([string] $LiteralPath, [switch] $Force)
  if ([string]::Equals([IO.Path]::GetFullPath($LiteralPath), '${escapePowerShell(fixture.preservationParent)}', [StringComparison]::OrdinalIgnoreCase)) {
    throw [UnauthorizedAccessException]::new('injected-indeterminate-entry')
  }
  & 'Microsoft.PowerShell.Management\\Get-Item' @PSBoundParameters
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.preservationParent)).toBe(false);
  });

  it("does not disclose arbitrary failures, child output, paths, environment values, or secrets", async () => {
    // Break caught: exception serialization could leak uncontrolled host data.
    const fixture = await createFixture();
    const secret = "TOP-SECRET-SENTINEL";
    const output = (await runCore(fixture, {
      overrides: `$contract.getRepositoryState = { throw '${secret} ${escapePowerShell(fixture.root)} child-output environment-value' }`,
    })).stdout;
    const parsed = JSON.parse(output);
    expectClosedResult(parsed.result);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(fixture.root);
    expect(output).not.toContain("child-output");
    expect(output).not.toContain("environment-value");
  });

  it("renames the opaque directory out and back exactly once while the child observes canonical out absent", async () => {
    // Break caught: copying, merging, a wrong destination, or missing restoration changes the observable namespace contract.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "opaque-sentinel.bin");
    const bytes = Buffer.from([0, 255, 17, 0, 99, 42]);
    await writeFile(sentinel, bytes);

    const output = JSON.parse((await runCore(fixture, {
      overrides: successChildOverride(fixture),
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; childObservation = $script:childObservation; sourceExists = [IO.Directory]::Exists('${escapePowerShell(fixture.sourcePath)}'); destinationExists = [IO.Directory]::Exists('${escapePowerShell(fixture.destinationPath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);

    expect(output.result).toEqual({
      schema: "intentarc.preflight-out-preservation-result/v2",
      status: "PASS",
      category: "none",
      cleanupCategory: "none",
      phase: "complete",
      childStarted: true,
      childExitCode: 0,
      outRestored: true,
    });
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(output.childCalls).toBe(1);
    expect(output.childObservation).toEqual({
      executable: fixture.pnpmExecutable,
      arguments: ["--dir", fixture.repositoryRoot, "run", "desktop:release:preflight", "--run-id", runId, "--tracked-only"],
      workingDirectory: fixture.repositoryRoot,
      sourceExists: false,
      destinationExists: true,
    });
    expect(output).toMatchObject({ sourceExists: true, destinationExists: false });
    expect(await readFile(sentinel)).toEqual(bytes);
  });

  it.each([
    ["nonzero exit", testChildResultSource({ exitCode: 7 }), "preflight-failed", true, 7],
    ["start failure", testChildResultSource({ started: false, exitCode: null, infrastructureFailure: true }), "preflight-start-failed", false, null],
    ["timeout", testChildResultSource({ exitCode: null, timedOut: true }), "preflight-timeout", true, null],
    ["cancellation", testChildResultSource({ exitCode: null, canceled: true }), "preflight-canceled", true, null],
  ])("restores after child %s", async (_name, childResult, category, childStarted, childExitCode) => {
    // Break caught: any child settlement path that skips finally can strand opaque out at the destination.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = { param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds) $script:childCalls++; ${childResult} }`,
    })).stdout);

    expect(output.result).toMatchObject({ status: "FAIL", category, childStarted, childExitCode, outRestored: true });
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(output.childCalls).toBe(1);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("restores after post-child repository validation drift", async () => {
    // Break caught: a validation exception or drift after preservation must not bypass restoration.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:repositoryChecks = 0
$contract.getRepositoryState = {
  $script:repositoryChecks++
  if ($script:repositoryChecks -ge 3) { throw 'TOP-SECRET-VALIDATION-FAILURE' }
  [ordered]@{ branch = 'master'; commit = '${commit}'; statusRows = @() }
}`,
      after: `[ordered]@{ result = $result; childCalls = $script:childCalls; repositoryChecks = $script:repositoryChecks } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "repository-invalid", outRestored: true });
    expect(output).toMatchObject({ childCalls: 1, repositoryChecks: 4 });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("restores after the bound pnpm identity drifts", async () => {
    // Break caught: a changed child executable binding must fail after exact restoration, not strand out.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:pnpmChecks = 0
$contract.getPnpmSha256 = {
  param($Path)
  $script:pnpmChecks++
  if ($script:pnpmChecks -ge 3) { '${"c".repeat(64)}' } else { '${pnpmHash}' }
}`,
      after: `[ordered]@{ result = $result; childCalls = $script:childCalls; pnpmChecks = $script:pnpmChecks } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "pnpm-binding-invalid", outRestored: true });
    expect(output).toMatchObject({ childCalls: 1, pnpmChecks: 4 });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("restores after a same-content pnpm file identity substitution", async () => {
    // Break caught: matching path, hash, length, and timestamps cannot substitute for the originally held file identity.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, "$script:fileIdentityDrift = $true")}
$script:fileIdentityDrift = $false
$contract.getStableFileIdentity = {
  param($Path)
  if ($script:fileIdentityDrift) { '00000003:0000000000000003' } else { '00000002:0000000000000002' }
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "pnpm-binding-invalid", outRestored: true, childStarted: true });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it.each([
    ["both present", "[IO.Directory]::CreateDirectory('SOURCE') | Out-Null"],
    ["both absent", "[IO.Directory]::Delete('DESTINATION')"],
  ])("stops without a second move when restoration finds %s", async (_name, actionTemplate) => {
    // Break caught: conflict handling must never delete, merge, overwrite, or guess which exact entry wins.
    const fixture = await createFixture();
    const action = actionTemplate
      .replace("SOURCE", escapePowerShell(fixture.sourcePath))
      .replace("DESTINATION", escapePowerShell(fixture.destinationPath));
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = { param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds) $script:childCalls++; ${action}; ${testChildResultSource({ exitCode: 9 })} }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict", outRestored: false });
    expect(output.moveCalls).toEqual([`${fixture.sourcePath}\n${fixture.destinationPath}`]);
    expect(output.childCalls).toBe(1);
  });

  it("refuses PASS when the restored directory metadata drifts", async () => {
    // Break caught: restoring a substituted or modified host entry must not be reported as the captured opaque directory.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: successChildOverride(fixture, `[IO.Directory]::SetLastWriteTimeUtc('${escapePowerShell(fixture.destinationPath)}', [DateTime]::UtcNow.AddMinutes(-5))`),
    })).stdout);
    expect(output.result.status).toBe("FAIL");
    expect(output.result.category).toBe("out-restoration-failed");
    expect(output.result.outRestored).toBe(false);
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("[id06-contract] journals a retained run root when exact nonrecursive deletion finds residue", async () => {
    // Break caught: recursively deleting runRoot, or leaving cleanup pending, can erase unrelated residue or forge successful cleanup.
    const fixture = await createFixture();
    const residue = join(fixture.runRoot, "unrelated-residue.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: successChildOverride(fixture, `[IO.File]::WriteAllBytes('${escapePowerShell(residue)}', [byte[]](7,8,9))`),
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid",
      phase: "complete", outRestored: true,
    });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "complete",
      cleanup: { profileStatus: "removed", localAppDataStatus: "removed", runRootStatus: "retained", category: "residue-invalid" },
    });
    expect(await readFile(residue)).toEqual(Buffer.from([7, 8, 9]));
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("returns RECOVERED/recovery-restored for the retained opaque destination without invoking a child", async () => {
    // Break caught: recovery must restore only from bounded state and cannot resume the terminal preflight child.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "recovery-sentinel.bin");
    const bytes = Buffer.from([5, 4, 3, 2, 1, 0, 255]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);

    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryProofCalls = 0
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $true }`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; proofCalls = $script:recoveryProofCalls } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toEqual({
      schema: "intentarc.preflight-out-preservation-result/v2",
      status: "RECOVERED",
      category: "recovery-restored",
      cleanupCategory: "none",
      phase: "complete",
      childStarted: false,
      childExitCode: null,
      outRestored: true,
    });
    expect(output.moveCalls).toEqual([`${fixture.destinationPath}\n${fixture.sourcePath}`]);
    expect(output.childCalls).toBe(0);
    expect(output.proofCalls).toBe(1);
    expect(await readFile(sentinel)).toEqual(bytes);
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "complete",
      recovery: { mode: "restore-only", sourcePhase: "preserved" },
      cleanup: { profileStatus: "removed", localAppDataStatus: "removed", runRootStatus: "removed", category: "none" },
    });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("does not clean recovery roots when the durable restored write fails", async () => {
    // Break caught: recovery must not spend persisted cleanup authority until the restored state is durably promoted.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryRestoredWriteAttempts = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'restored') {
    $script:recoveryRestoredWriteAttempts++
    throw 'recovery-restored-write-fault'
  }
}`,
      after: `[ordered]@{ result = $result; attempts = $script:recoveryRestoredWriteAttempts; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", phase: "preserved", outRestored: true });
    expect(output.attempts).toBe(1);
    expect(output.state).toMatchObject({
      phase: "preserved",
      recovery: { mode: "restore-only", sourcePhase: "preserved" },
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(output.state.recovery.settlementProvenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("reports restored when recovery cleanup completes but terminal state promotion fails", async () => {
    // Break caught: a failed complete write must not return a forged terminal phase after destructive cleanup.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryCompleteWriteAttempts = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'complete') {
    $script:recoveryCompleteWriteAttempts++
    throw 'recovery-complete-write-fault'
  }
}`,
      after: `[ordered]@{ result = $result; attempts = $script:recoveryCompleteWriteAttempts; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "none", phase: "restored", outRestored: true });
    expect(output.attempts).toBe(1);
    expect(output.state).toMatchObject({
      phase: "restored",
      recovery: { mode: "restore-only", sourcePhase: "preserved" },
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(output.state.recovery.settlementProvenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("retains observed recovery residue when terminal state promotion fails", async () => {
    // Break caught: a failed complete journal must not erase the bounded cleanup outcome observed before that write.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.beforeOwnedProfileCleanup = { param($Guard) throw 'injected-recovery-cleanup-residue' }
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'complete') {
    throw 'recovery-complete-write-fault-with-residue'
  }
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "residue-invalid",
      phase: "restored", childStarted: false, childExitCode: null, outRestored: true,
    });
    expect(output.state).toMatchObject({
      phase: "restored",
      recovery: { mode: "restore-only", sourcePhase: "preserved" },
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("releases a recovery owned-root guard when cleanup rejects before disposing it", async () => {
    // Break caught: nulling a rejected recovery guard leaks its no-delete root/ancestor handles past the controller return.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const marker = join(fixture.childProfilePath, "must-remain.bin");
    const releasedProfile = join(fixture.root, "released-recovery-profile");
    const markerBytes = Buffer.from([66, 0, 14, 8]);
    await writeFile(marker, markerBytes);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.beforeOwnedProfileCleanup = { param($Guard) throw 'reject-before-guard-dispose' }`,
      after: `$guardReleased = $false
try {
  [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(releasedProfile)}')
  $guardReleased = $true
} catch {}
[ordered]@{ result = $result; guardReleased = $guardReleased; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "RECOVERED", category: "recovery-restored", cleanupCategory: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toMatchObject({ profileStatus: "invalid", localAppDataStatus: "removed", runRootStatus: "retained" });
    expect(output.guardReleased).toBe(true);
    expect(await readFile(join(releasedProfile, "must-remain.bin"))).toEqual(markerBytes);
  });

  it.each([
    ["both present", "both-present"],
    ["both absent", "both-absent"],
    ["source present and destination absent", "source-present-destination-absent"],
  ])("recovery refuses %s without mutation", async (_name, condition) => {
    // Break caught: recovery cannot choose, delete, overwrite, or merge when exact source/destination state conflicts.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    if (condition === "both-present") await mkdir(fixture.sourcePath);
    else if (condition === "both-absent") await rm(fixture.destinationPath, { recursive: true, force: true });
    else await rename(fixture.destinationPath, fixture.sourcePath);
    const stateBytes = await readFile(fixture.statePath, "utf8");

    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryProofCalls = 0
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $true }`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; proofCalls = $script:recoveryProofCalls } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "out-restoration-conflict", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output.moveCalls).toEqual([]);
    expect(output.childCalls).toBe(0);
    expect(output.proofCalls).toBe(1);
    expect(await readFile(fixture.statePath, "utf8")).toBe(stateBytes);
  });

  it("lets failed child absence proof override a recovery namespace conflict", async () => {
    // Break caught: returning on the matrix before proving child absence skips the highest safety row.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    await mkdir(fixture.sourcePath);
    const stateBytes = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: "$contract['proveChildAbsent'] = { param($Child) $false }",
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "child-settlement-failed", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output.moveCalls).toEqual([]);
    expect(output.childCalls).toBe(0);
    expect(await readFile(fixture.statePath, "utf8")).toBe(stateBytes);
  });

  it("[v2 state] accepts the exact retained preserved schema before evaluating namespace conflict", async () => {
    // Break caught: retaining the v1 top-level validator would refuse the exact v2 recovery authority.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict" });
    expect(output.moveCalls).toEqual([]);
    expect(output.childCalls).toBe(0);
  });

  it.each([
    ["top level", (state: any) => ({ ...state, unexpected: true })],
    ["opaque directory", (state: any) => ({ ...state, directory: { ...state.directory, unexpected: true } })],
    ["owned roots", (state: any) => ({ ...state, ownedRoots: { ...state.ownedRoots, unexpected: true } })],
    ["owned-root leaf", (state: any) => ({ ...state, ownedRoots: { ...state.ownedRoots, profile: { ...state.ownedRoots.profile, unexpected: true } } })],
    ["pnpm", (state: any) => ({ ...state, pnpm: { ...state.pnpm, unexpected: true } })],
    ["child", (state: any) => ({ ...state, child: { ...state.child, unexpected: true } })],
    ["recovery", (state: any) => ({ ...state, recovery: { ...state.recovery, unexpected: true } })],
    ["cleanup", (state: any) => ({ ...state, cleanup: { ...state.cleanup, unexpected: true } })],
    ["timestamps", (state: any) => ({ ...state, timestamps: { ...state.timestamps, unexpected: true } })],
  ])("[v2 state] rejects an extra field at the %s depth", async (_depth, mutate) => {
    // Break caught: an open object at any depth could persist unreviewed output, environment, or path evidence.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, mutate(state));
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
    expect(output.moveCalls).toEqual([]);
  });

  it.each([
    ["top level", (state: any) => omitKey(state, "ownedRoots")],
    ["opaque directory", (state: any) => ({ ...state, directory: omitKey(state.directory, "stableIdentity") })],
    ["owned roots", (state: any) => ({ ...state, ownedRoots: omitKey(state.ownedRoots, "localAppData") })],
    ["owned-root leaf", (state: any) => ({ ...state, ownedRoots: { ...state.ownedRoots, profile: omitKey(state.ownedRoots.profile, "attributes") } })],
    ["pnpm", (state: any) => ({ ...state, pnpm: omitKey(state.pnpm, "sha256") })],
    ["child", (state: any) => ({ ...state, child: omitKey(state.child, "terminationReason") })],
    ["recovery", (state: any) => ({ ...state, recovery: omitKey(state.recovery, "sourcePhase") })],
    ["cleanup", (state: any) => ({ ...state, cleanup: omitKey(state.cleanup, "runRootStatus") })],
    ["timestamps", (state: any) => ({ ...state, timestamps: omitKey(state.timestamps, "childSettledAt") })],
  ])("[v2 state] rejects a missing field at the %s depth", async (_depth, mutate) => {
    // Break caught: accepting partial objects would make a missing safety fact indistinguishable from its safe value.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, mutate(state));
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it.each([1, 2147483647])("[PID] accepts the signed 32-bit boundary %s in a coherent settled tuple", async (rootProcessId) => {
    // Break caught: an off-by-one PID range would reject a real Windows process identity at a documented boundary.
    const fixture = await createFixture();
    const state = childSettledState(await prepareRecovery(fixture), { rootProcessId });
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict" });
  });

  it.each([0, -1, 2147483648, 1.5, "1"]) ("[PID] rejects invalid root PID %s", async (rootProcessId) => {
    // Break caught: coercing or widening a PID could bind recovery evidence to no process or the wrong process.
    const fixture = await createFixture();
    const state = childSettledState(await prepareRecovery(fixture), { rootProcessId });
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it.each([0, 9007199254740991])("[v2 state] accepts safe byte counter boundary %s", async (stdoutBytes) => {
    // Break caught: an incorrect safe-integer bound would discard exact bounded stream evidence.
    const fixture = await createFixture();
    const state = childSettledState(await prepareRecovery(fixture), { stdoutBytes });
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict" });
  });

  it.each([9007199254740992, -1, 0.5, "0"]) ("[v2 state] rejects unsafe byte counter %s", async (stdoutBytes) => {
    // Break caught: coercion, fractional counters, negatives, or JSON-unsafe magnitudes could corrupt durable output evidence.
    const fixture = await createFixture();
    const state = childSettledState(await prepareRecovery(fixture), { stdoutBytes });
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it.each([
    ["UInt32", "[uint32]0"],
    ["UInt64", "[uint64]0"],
    ["Decimal", "[decimal]0"],
    ["Double", "[double]0"],
    ["BigInteger", "[System.Numerics.BigInteger]::Zero"],
  ])("[v2 state] rejects in-memory %s counters instead of coercing them", async (_type, expression) => {
    // Break caught: an in-memory unsigned, floating, decimal, or wider numeric value must not be coerced into durable JSON evidence.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.beforePreparedStateWrite = { param($State) $State.child.stdoutBytes = ${expression} }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it("[v2 state] normalizes accepted deserialized counters to Int64 before persistence", async () => {
    // Break caught: retaining PowerShell 5.1 Int32 counters in memory would make later projections type-dependent.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:counterTypes = $null
$contract.beforePreparedStateWrite = { param($State) $State.child.stdoutBytes = [int]0; $State.child.stderrBytes = [int]0 }
$contract.onStateWritten = { param($State) $script:counterTypes = @($State.child.stdoutBytes.GetType().FullName, $State.child.stderrBytes.GetType().FullName); throw 'stop-after-normalization' }`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; counterTypes = @($script:counterTypes) } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0, counterTypes: ["System.Int64", "System.Int64"] });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({ phase: "prepared", child: { stdoutBytes: 0, stderrBytes: 0 } });
  });

  it.each([
    ["output-overflow", { terminationReason: "output-overflow", exitCode: null, stdoutBytes: 1048577, outputOverflow: true }],
    ["timeout", { terminationReason: "timeout", exitCode: null, timedOut: true }],
    ["canceled before creation", { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", terminationReason: "canceled", exitCode: null, canceled: true }],
    ["canceled after creation", { terminationReason: "canceled", exitCode: null, canceled: true }],
    ["infrastructure failure before creation", { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", terminationReason: "infrastructure-failure", exitCode: null, infrastructureFailure: true }],
    ["infrastructure failure after creation", { terminationReason: "infrastructure-failure", exitCode: -1, infrastructureFailure: true }],
    ["settlement failure after attempted creation", { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: null, infrastructureFailure: true }],
    ["settlement failure after assigned creation", { assignmentStatus: "assigned", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: -1, infrastructureFailure: true }],
    ["settlement failure with unknown absent identity", { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "unknown", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: null, infrastructureFailure: true }],
    ["settlement failure with unknown present identity", { assignmentStatus: "unknown", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: null, infrastructureFailure: true }],
  ])("[tuple] accepts the approved %s evidence row", async (_name, overrides) => {
    // Break caught: narrowing a documented terminal tuple would strand valid durable child evidence as unrecoverable.
    const fixture = await createFixture();
    const state = childSettledState(await prepareRecovery(fixture), overrides);
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict" });
  });

  it("[recovery] accepts an exact restore-only proof without rewriting the retained child tuple", async () => {
    // Break caught: rejecting the documented restore-only triple would make a durably proven recovery record unusable after host loss.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    state.recovery = { mode: "restore-only", sourcePhase: "preserved", settlementProvenAt: state.timestamps.preservedAt };
    const output = await classifyRetainedState(fixture, state);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-conflict" });
  });

  it.each([
    ["prepared intent attempted child creation", (state: any) => ({ ...state, phase: "prepared", timestamps: { ...state.timestamps, preservedAt: null }, child: { ...state.child, assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "unknown" } })],
    ["child-started retained not-started evidence", (state: any) => ({ ...state, phase: "child-started", timestamps: { ...state.timestamps, childStartedAt: state.timestamps.preservedAt } })],
    ["normal exit omitted its exit code", (state: any) => childSettledState(state, { exitCode: null })],
    ["overflow stayed within the stream limit", (state: any) => childSettledState(state, { terminationReason: "output-overflow", exitCode: null, stdoutBytes: 1048576, outputOverflow: true })],
    ["timeout also claimed cancellation", (state: any) => childSettledState(state, { terminationReason: "timeout", exitCode: null, timedOut: true, canceled: true })],
    ["settlement failure omitted infrastructure failure", (state: any) => childSettledState(state, { assignmentStatus: "unknown", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: null })],
    ["assigned child omitted both identity fields", (state: any) => childSettledState(state, { rootProcessId: null, rootStartTimeUtc: null })],
  ])("[tuple] rejects contradiction: %s", async (_name, mutate) => {
    // Break caught: independently valid enum values must not combine into a false child lifecycle claim.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, mutate(state));
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it.each([
    ["preserved phase omitted preservedAt", (state: any) => ({ ...state, timestamps: { ...state.timestamps, preservedAt: null } })],
    ["preserved phase populated childStartedAt", (state: any) => ({ ...state, timestamps: { ...state.timestamps, childStartedAt: state.timestamps.preservedAt } })],
    ["child-settled phase omitted childSettledAt", (state: any) => ({ ...childSettledState(state), timestamps: { ...childSettledState(state).timestamps, childSettledAt: null } })],
    ["timestamps moved backwards", (state: any) => ({ ...state, timestamps: { ...state.timestamps, preparedAt: "2026-09-01T12:00:01.0000000Z", preservedAt: "2026-09-01T12:00:00.0000000Z" } })],
    ["settlement proof predates execute evidence", (state: any) => ({ ...state, recovery: { mode: "restore-only", sourcePhase: "preserved", settlementProvenAt: "2020-01-01T00:00:00.0000000Z" } })],
  ])("[timestamp] rejects contradiction: %s", async (_name, mutate) => {
    // Break caught: nullable or non-monotonic phase times could authorize recovery before its prerequisite evidence existed.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, mutate(state));
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it.each([
    ["removed status before complete", (state: any) => ({ ...state, cleanup: { ...state.cleanup, profileStatus: "removed" } })],
    ["residue category while statuses are pending", (state: any) => ({ ...state, cleanup: { ...state.cleanup, category: "residue-invalid" } })],
    ["run root removed while an owned root was retained", (state: any) => ({ ...childSettledState(state), phase: "complete", cleanup: { localAppDataStatus: "removed", profileStatus: "retained", runRootStatus: "removed", category: "residue-invalid" }, timestamps: { ...childSettledState(state).timestamps, restoredAt: state.timestamps.preservedAt, completedAt: state.timestamps.preservedAt } })],
  ])("[cleanup consistency] rejects contradiction: %s", async (_name, mutate) => {
    // Break caught: cleanup status/category combinations must not claim complete removal without all three exact roots removed.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    const output = await classifyRetainedState(fixture, mutate(state));
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid" });
  });

  it("[cleanup consistency] persists the exact successful complete cleanup row", async () => {
    // Break caught: a validator that only rejects contradictions but rejects the all-removed terminal row can never durably finish cleanup.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.beforePreparedStateWrite = {
  param($State)
  $at = [string]$State.timestamps.preparedAt
  $State.phase = 'complete'
  $State.child.rootProcessId = [int]1
  $State.child.rootStartTimeUtc = $at
  $State.child.assignmentStatus = 'assigned'
  $State.child.settlementStatus = 'settled'
  $State.child.terminationReason = 'normal-exit'
  $State.child.exitCode = [int]0
  $State.timestamps.preservedAt = $at
  $State.timestamps.childStartedAt = $at
  $State.timestamps.childSettledAt = $at
  $State.timestamps.restoredAt = $at
  $State.timestamps.completedAt = $at
  $State.cleanup.localAppDataStatus = 'removed'
  $State.cleanup.profileStatus = 'removed'
  $State.cleanup.runRootStatus = 'removed'
}
$contract.onStateWritten = { param($State) throw 'stop-after-complete-state' }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "complete",
      cleanup: { localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "removed", category: "none" },
    });
  });

  it.each([
    ["extra field", (state: any) => ({ ...state, secret: "TOP-SECRET-STATE" })],
    ["wrong source", (state: any) => ({ ...state, sourcePath: `${state.sourcePath}-other` })],
    ["wrong destination", (state: any) => ({ ...state, destinationPath: `${state.destinationPath}-other` })],
    ["wrong run", (state: any) => ({ ...state, runId: "phase1-preflight-20260830-04" })],
    ["wrong commit", (state: any) => ({ ...state, expectedCommit: "c".repeat(40) })],
    ["wrong pnpm", (state: any) => ({ ...state, pnpm: { ...state.pnpm, sha256: "c".repeat(64) } })],
    ["malformed phase", (state: any) => ({ ...state, phase: "running" })],
  ])("recovery refuses a state with %s without moving", async (_name, mutate) => {
    // Break caught: a broadened or mismatched retained record could authorize restoration of the wrong exact entry.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    await writeFile(fixture.statePath, JSON.stringify(mutate(state)), "utf8");

    const output = JSON.parse((await runCore(fixture, { argumentsVector: restoreArguments(fixture) })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false, outRestored: false });
    expect(output.moveCalls).toEqual([]);
    expect(output.childCalls).toBe(0);
    expect(await exists(fixture.destinationPath)).toBe(true);
    expect(await exists(fixture.sourcePath)).toBe(false);
  });

  it.each([
    ["prepared timestamp retained in preserved phase", (state: any) => ({ ...state, timestamps: { ...state.timestamps, preservedAt: null } })],
    ["future phase timestamp populated", (state: any) => ({ ...state, timestamps: { ...state.timestamps, completedAt: state.timestamps.preservedAt } })],
    ["timestamps out of order", (state: any) => ({ ...state, timestamps: { ...state.timestamps, preparedAt: "2026-08-31T12:00:01.0000000Z", preservedAt: "2026-08-31T12:00:00.0000000Z" } })],
    ["root pid without root start", (state: any) => ({ ...state, child: { ...state.child, rootProcessId: 42, assignmentStatus: "assigned", settlementStatus: "settled" } })],
    ["unsettled preserved child", (state: any) => ({ ...state, child: { ...state.child, assignmentStatus: "unknown", settlementStatus: "unsettled" } })],
  ])("recovery refuses incoherent state: %s", async (_name, mutate) => {
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    await writeFile(fixture.statePath, JSON.stringify(mutate(state)), "utf8");
    const output = JSON.parse((await runCore(fixture, { argumentsVector: restoreArguments(fixture) })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", outRestored: false });
    expect(output.moveCalls).toEqual([]);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it("refuses recovery when the locked state file identity changes during read", async () => {
    // Break caught: a same-account path swap must not change the state object between validation and authorization.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:stateIdentityDrift = $false
$contract.beforeStateRead = { $script:stateIdentityDrift = $true }
$contract.getStableFileIdentity = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.statePath)}' -and $script:stateIdentityDrift) { '00000004:0000000000000004' }
  else { '00000002:0000000000000002' }
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", outRestored: false });
    expect(output.moveCalls).toEqual([]);
  });

  it("refuses recovery when state ownership or DACL validation fails", async () => {
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.validateStateAccess = { param($StatePath, $ParentPath) $false }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", outRestored: false });
    expect(output.moveCalls).toEqual([]);
  });

  it("protects production state access for the current user and rejects a broad ACE", async () => {
    const fixture = await createFixture();
    const secureParent = join(fixture.root, "secure-state-parent");
    const secureState = join(secureParent, "state.json");
    const command = [
      `. '${escapePowerShell(scriptPath)}'`,
      "Initialize-IntentArcPreflightNativeProcessType",
      `[IntentArc.Preflight.StateFileSecurity]::ProtectParent('${escapePowerShell(secureParent)}')`,
      `[IO.File]::WriteAllText('${escapePowerShell(secureState)}', '{}')`,
      `[IntentArc.Preflight.StateFileSecurity]::ProtectFile('${escapePowerShell(secureState)}')`,
      `$closed = [IntentArc.Preflight.StateFileSecurity]::Validate('${escapePowerShell(secureState)}', '${escapePowerShell(secureParent)}')`,
      `$security = [IO.FileInfo]::new('${escapePowerShell(secureState)}').GetAccessControl()`,
      "$everyone = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid, $null)",
      "$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow))",
      `[IO.FileInfo]::new('${escapePowerShell(secureState)}').SetAccessControl($security)`,
      `$broad = [IntentArc.Preflight.StateFileSecurity]::Validate('${escapePowerShell(secureState)}', '${escapePowerShell(secureParent)}')`,
      "[ordered]@{ closed = $closed; broad = $broad } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const output = JSON.parse((await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    })).stdout);
    expect(output).toEqual({ closed: true, broad: false });
  });

  it.each([
    ["weakened state rights", `$security = [Security.AccessControl.FileSecurity]::new()
$security.SetOwner($current)
$security.SetAccessRuleProtection($true, $false)
$weakened = [Security.AccessControl.FileSystemRights]([int][Security.AccessControl.FileSystemRights]::FullControl -band (-bnot [int][Security.AccessControl.FileSystemRights]::TakeOwnership))
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, $weakened, [Security.AccessControl.AccessControlType]::Allow))
[IO.FileInfo]::new($state).SetAccessControl($security)`],
    ["missing state trustees", `$security = [Security.AccessControl.FileSecurity]::new()
$security.SetOwner($current)
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
[IO.FileInfo]::new($state).SetAccessControl($security)`],
    ["state deny rule", `$security = [IO.FileInfo]::new($state).GetAccessControl()
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Deny))
[IO.FileInfo]::new($state).SetAccessControl($security)`],
    ["missing parent trustees", `$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($current)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
[IO.DirectoryInfo]::new($parent).SetAccessControl($security)`],
  ])("rejects exact state security with %s", async (_name, mutation) => {
    // Break caught: owner protection plus an allowlist is insufficient if required trustees/rights are missing or a deny rule is present.
    const fixture = await createFixture();
    const secureParent = join(fixture.root, "exact-secure-state-parent");
    const secureState = join(secureParent, "state.json");
    const command = [
      `. '${escapePowerShell(scriptPath)}'`,
      "Initialize-IntentArcPreflightNativeProcessType",
      `$parent = '${escapePowerShell(secureParent)}'`,
      `$state = '${escapePowerShell(secureState)}'`,
      "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
      "[IntentArc.Preflight.StateFileSecurity]::ProtectParent($parent)",
      "[IO.File]::WriteAllText($state, '{}')",
      "[IntentArc.Preflight.StateFileSecurity]::ProtectFile($state)",
      mutation,
      "$valid = [IntentArc.Preflight.StateFileSecurity]::Validate($state, $parent)",
      "[IntentArc.Preflight.StateFileSecurity]::ProtectParent($parent)",
      "[IntentArc.Preflight.StateFileSecurity]::ProtectFile($state)",
      "$valid | ConvertTo-Json -Compress",
    ].join("\r\n");
    const output = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    });
    expect(JSON.parse(output.stdout)).toBe(false);
  });

  it("protects and validates the flushed temporary state identity before its first promotion", async () => {
    // Break caught: promoting the first temporary identity before applying its exact file ACL leaves authoritative evidence unsafe on host loss.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:temporaryPromotionObservation = $null
$contract['useProductionStateSecurity'] = $true
$contract.beforeStatePromotion = {
  param($State, $TemporaryPath)
  $script:temporaryPromotionObservation = [ordered]@{
    phase = [string]$State.phase
    temporaryProtected = [IntentArc.Preflight.StateFileSecurity]::Validate(
      [string]$TemporaryPath,
      '${escapePowerShell(fixture.preservationParent)}'
    )
    authoritativePresent = [IO.File]::Exists('${escapePowerShell(fixture.statePath)}')
  }
  throw 'host-loss-before-first-promotion'
}`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; observation = $script:temporaryPromotionObservation } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({
      moveCalls: [],
      childCalls: 0,
      observation: { phase: "prepared", temporaryProtected: true, authoritativePresent: false },
    });
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it("creates the protected parent at creation time under a Modify-only host", async () => {
    const fixture = await createFixture();
    await establishModifyOnlyInheritedParent(fixture, false);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract['useProductionStateSecurity'] = $true`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(await readProductionStateAccess(fixture)).toEqual({ parentProtected: true, stateProtected: true, valid: true });
  });

  it("replaces an exact empty Modify-only parent with a protected creation-time parent", async () => {
    // Break caught: post-creation SetAccessControl fails when the host grants Modify without ChangePermissions.
    const fixture = await createFixture();
    const baseline = await establishModifyOnlyInheritedParent(fixture);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract['useProductionStateSecurity'] = $true`,
    })).stdout);
    const access = await readProductionStateAccess(fixture);
    expect(baseline).toEqual({ beforeProtected: false, postChangeError: "System.UnauthorizedAccessException" });
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(access).toEqual({ parentProtected: true, stateProtected: true, valid: true });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("refuses a nonempty exact Modify-only parent without deleting its entry", async () => {
    // Break caught: repairing an inherited parent must never enumerate or recursively delete an occupied directory.
    const fixture = await createFixture();
    const sentinel = join(fixture.preservationParent, "must-survive.bin");
    const sentinelBytes = Buffer.from([91, 0, 17, 203]);
    await establishModifyOnlyInheritedParent(fixture);
    await writeFile(sentinel, sentinelBytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract['useProductionStateSecurity'] = $true`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await readFile(sentinel)).toEqual(sentinelBytes);
    expect(await exists(fixture.runRoot)).toBe(false);
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it("refuses an exact empty Modify-only parent while a stable handle prevents deletion", async () => {
    const fixture = await createFixture();
    await establishModifyOnlyInheritedParent(fixture);
    const command = [
      `. '${escapePowerShell(scriptPath)}'`,
      "Initialize-IntentArcPreflightNativeProcessType",
      `$parent = '${escapePowerShell(fixture.preservationParent)}'`,
      "$guard = [IntentArc.Preflight.DirectoryComponentGuard]::Open($parent)",
      "$errorType = $null",
      "try { [IntentArc.Preflight.StateFileSecurity]::ProtectParent($parent) } catch { $errorType = $_.Exception.InnerException.GetType().FullName } finally { $guard.Dispose() }",
      "$security = [IO.DirectoryInfo]::new($parent).GetAccessControl()",
      "[ordered]@{ errorType = $errorType; present = [IO.Directory]::Exists($parent); protected = $security.AreAccessRulesProtected } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ present: true, protected: false });
    expect(JSON.parse(result.stdout).errorType).toBeTruthy();
  });

  it("refuses an oversized retained state before JSON materialization", async () => {
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    await writeFile(fixture.statePath, `${JSON.stringify(state)}${" ".repeat(70 * 1024)}`, "utf8");
    const output = JSON.parse((await runCore(fixture, { argumentsVector: restoreArguments(fixture) })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", outRestored: false });
    expect(output.moveCalls).toEqual([]);
  });

  it("restores but rejects an oversized otherwise-valid receipt before JSON materialization", async () => {
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = {
  [IO.Directory]::CreateDirectory('${escapePowerShell(dirname(fixture.receiptPath))}') | Out-Null
  [IO.File]::WriteAllText('${escapePowerShell(fixture.receiptPath)}', '${escapePowerShell(JSON.stringify(validReceipt()))}' + [string]::new(' ', 307200))
  ${testChildResultSource()}
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "receipt-invalid", outRestored: true });
  });

  it.each([
    ["missing", null],
    ["malformed", { schemaVersion: 2 }],
    ["extra field", { ...validReceipt(), extra: true }],
    ["wrong run", { ...validReceipt(), runId: "phase1-preflight-20260830-04" }],
    ["failed status", { ...validReceipt(), status: "failed", failureCategory: "focused-tests" }],
    ["wrong scope", { ...validReceipt(), git: { ...validReceipt().git, statusScope: "full" } }],
    ["dirty rows", { ...validReceipt(), git: { ...validReceipt().git, statusEntryCount: 1 } }],
    ["failed check", { ...validReceipt(), checks: { ...validReceipt().checks, "focused-tests": "failed" } }],
    ["out present before", { ...validReceipt(), out: { absentBefore: false, absentAfter: true } }],
    ["out present after", { ...validReceipt(), out: { absentBefore: true, absentAfter: false } }],
  ])("restores but rejects a %s receipt", async (_name, receipt) => {
    // Break caught: child exit zero alone must never close ID05 without the exact successful v2 receipt.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, { overrides: receiptChildOverride(fixture, receipt) })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "receipt-invalid", childStarted: true, childExitCode: 0, outRestored: true });
    expect(output.childCalls).toBe(1);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("journals durable native settlement and restoration authority phases in order", async () => {
    // Break caught: missing a flushed phase boundary makes host-loss state ambiguous or retryable.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:statePhases = [System.Collections.Generic.List[string]]::new()
$script:lastDurablePhase = $null
$script:profileCleanupDurablePhase = $null
$script:localCleanupDurablePhase = $null
$contract.onStateWritten = {
  param($State)
  $script:lastDurablePhase = [string]$State.phase
  $script:statePhases.Add($script:lastDurablePhase)
}
$contract.beforeOwnedProfileCleanup = { param($Guard) $script:profileCleanupDurablePhase = $script:lastDurablePhase }
$contract.beforeOwnedLocalAppDataCleanup = { param($Guard) $script:localCleanupDurablePhase = $script:lastDurablePhase }`,
      after: `[ordered]@{ result = $result; phases = @($script:statePhases); profileCleanupDurablePhase = $script:profileCleanupDurablePhase; localCleanupDurablePhase = $script:localCleanupDurablePhase } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result.status).toBe("PASS");
    expect(output.phases).toEqual([
      "prepared", "preserved", "child-started", "child-settled", "child-settled", "restored", "complete",
    ]);
    expect(output.profileCleanupDurablePhase).toBe("restored");
    expect(output.localCleanupDurablePhase).toBe("restored");
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(Object.keys(state).sort()).toEqual([
      "child", "cleanup", "destinationPath", "directory", "expectedCommit", "ownedRoots", "phase", "pnpm",
      "recovery", "runId", "schema", "sourcePath", "timestamps",
    ]);
    expect(state).toMatchObject({
      schema: "intentarc.preflight-out-preservation-state/v2",
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      runId,
      expectedCommit: commit,
      pnpm: { path: fixture.pnpmExecutable, sha256: pnpmHash },
      child: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0, stdoutBytes: 0, stderrBytes: 0 },
      recovery: { mode: "none", sourcePhase: null, settlementProvenAt: null },
      cleanup: { localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "removed", category: "none" },
      phase: "complete",
    });
    expect(state.timestamps.childSettledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.timestamps.restoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.timestamps.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(state.child).sort()).toEqual([
      "assignmentStatus", "canceled", "exitCode", "infrastructureFailure", "jobName", "outputOverflow",
      "rootProcessId", "rootStartTimeUtc", "settlementStatus", "stderrBytes", "stdoutBytes", "terminationReason", "timedOut",
    ]);
  });

  it("reports durable-state failure without cleanup when the execute restored write throws", async () => {
    // Break caught: a thrown restored journal write after a verified move-back must not rewrite physical restoration as failed.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:executeRestoredWriteAttempts = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'none' -and [string]$State.phase -ceq 'restored') {
    $script:executeRestoredWriteAttempts++
    throw 'execute-restored-write-fault'
  }
}`,
      after: `[ordered]@{ result = $result; attempts = $script:executeRestoredWriteAttempts; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", phase: "child-settled", outRestored: true });
    expect(output.attempts).toBe(1);
    expect(output.state).toMatchObject({
      phase: "child-settled",
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(true);
  });

  it("reports durable-state failure when execute cleanup completes but terminal promotion fails", async () => {
    // Break caught: a complete-write fault after physical cleanup is journal evidence failure, not filesystem residue.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:executeCompleteWriteAttempts = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'none' -and [string]$State.phase -ceq 'complete') {
    $script:executeCompleteWriteAttempts++
    throw 'execute-complete-write-fault'
  }
}`,
      after: `[ordered]@{ result = $result; attempts = $script:executeCompleteWriteAttempts; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "none", phase: "restored", outRestored: true });
    expect(output.attempts).toBe(1);
    expect(output.state).toMatchObject({
      phase: "restored",
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("retains observed execute residue when terminal state promotion fails", async () => {
    // Break caught: complete-journal failure remains primary while the already-observed cleanup outcome stays visible.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.beforeOwnedProfileCleanup = { param($Guard) throw 'injected-execute-cleanup-residue' }
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'none' -and [string]$State.phase -ceq 'complete') {
    throw 'execute-complete-write-fault-with-residue'
  }
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "residue-invalid",
      phase: "restored", outRestored: true,
    });
    expect(output.state).toMatchObject({
      phase: "restored",
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("holds the validated ancestors before protecting state or creating the owned layout", async () => {
    // Break caught: a path-based protection/create sequence can mutate through a concurrently swapped .superpowers or preservation parent.
    const fixture = await createFixture();
    const movedSuperpowers = join(fixture.root, "moved-superpowers-before-layout");
    const movedParent = join(fixture.root, "moved-preservation-parent-before-layout");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:ownedLayoutHookCalled = $false
$script:superpowersSwapBlocked = $false
$script:parentSwapBlocked = $false
$contract['beforeOwnedLayoutCreation'] = {
  $script:ownedLayoutHookCalled = $true
  try { [IO.Directory]::Move('${escapePowerShell(fixture.superpowers)}', '${escapePowerShell(movedSuperpowers)}') }
  catch { $script:superpowersSwapBlocked = $true }
  try { [IO.Directory]::Move('${escapePowerShell(fixture.preservationParent)}', '${escapePowerShell(movedParent)}') }
  catch { $script:parentSwapBlocked = $true }
}`,
      after: `[ordered]@{
  result = $result
  hookCalled = $script:ownedLayoutHookCalled
  superpowersSwapBlocked = $script:superpowersSwapBlocked
  parentSwapBlocked = $script:parentSwapBlocked
  moveCalls = @($script:moveCalls)
  childCalls = $script:childCalls
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      hookCalled: true, superpowersSwapBlocked: true, parentSwapBlocked: true,
      childCalls: 1, result: { status: "PASS", category: "none", outRestored: true },
    });
    expect(await exists(movedSuperpowers)).toBe(false);
    expect(await exists(movedParent)).toBe(false);
  });

  it("holds the exact preservation parent across state protection and layout admission", async () => {
    // Break caught: protecting by path and only then opening a guard can adopt a same-ACL replacement directory.
    const fixture = await createFixture();
    await mkdir(fixture.preservationParent);
    const movedParent = join(fixture.root, "protected-parent-replaced-before-guard");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:parentProtectionCalls = 0
$script:parentProtectionSwapBlocked = $false
$contract.protectStateAccess = {
  param($StatePath, $ParentPath)
  $script:parentProtectionCalls++
  if ($script:parentProtectionCalls -eq 1) {
    try {
      [IO.Directory]::Move($ParentPath, '${escapePowerShell(movedParent)}')
      [IO.Directory]::CreateDirectory($ParentPath) | Out-Null
    } catch { $script:parentProtectionSwapBlocked = $true }
  }
  return $true
}`,
      after: `[ordered]@{
  result = $result
  protectionCalls = $script:parentProtectionCalls
  swapBlocked = $script:parentProtectionSwapBlocked
  moveCalls = @($script:moveCalls)
  childCalls = $script:childCalls
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      protectionCalls: expect.any(Number), swapBlocked: true, childCalls: 1,
      result: { status: "PASS", category: "none", outRestored: true },
    });
    expect(output.protectionCalls).toBeGreaterThan(0);
    expect(await exists(movedParent)).toBe(false);
  });

  it("holds the exact preservation parent through execute terminal journaling", async () => {
    // Break caught: releasing every ancestor handle before complete persistence can redirect the terminal journal.
    const fixture = await createFixture();
    const movedParent = join(fixture.root, "execute-parent-replaced-before-complete");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:executeCompleteSwapAttempted = $false
$script:executeCompleteSwapBlocked = $false
$contract.beforeStatePersistence = {
  param($State)
  if (-not $script:executeCompleteSwapAttempted -and
      [string]$State.recovery.mode -ceq 'none' -and [string]$State.phase -ceq 'complete') {
    $script:executeCompleteSwapAttempted = $true
    try {
      [IO.Directory]::Move('${escapePowerShell(fixture.preservationParent)}', '${escapePowerShell(movedParent)}')
      [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.preservationParent)}') | Out-Null
    } catch { $script:executeCompleteSwapBlocked = $true }
  }
}`,
      after: `[ordered]@{
  result = $result
  attempted = $script:executeCompleteSwapAttempted
  blocked = $script:executeCompleteSwapBlocked
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      attempted: true, blocked: true,
      result: { status: "PASS", category: "none", phase: "complete", outRestored: true },
    });
    expect(await exists(movedParent)).toBe(false);
  });

  it("holds the exact superpowers ancestor through execute terminal journaling without an independent receipt guard", async () => {
    // Break caught: a leaf-only state-parent handle cannot stop an ancestor swap after stable restoration authority is released.
    const fixture = await createFixture();
    const movedSuperpowers = join(fixture.root, "execute-superpowers-replaced-before-complete");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract['useProductionStateSecurity'] = $true
$contract['useStableReceiptBoundary'] = $false
$script:executeCompleteAncestorSwapAttempted = $false
$script:executeCompleteAncestorSwapBlocked = $false
$contract.beforeStatePersistence = {
  param($State)
  if (-not $script:executeCompleteAncestorSwapAttempted -and
      [string]$State.recovery.mode -ceq 'none' -and [string]$State.phase -ceq 'complete') {
    $script:executeCompleteAncestorSwapAttempted = $true
    try {
      [IO.Directory]::Move('${escapePowerShell(fixture.superpowers)}', '${escapePowerShell(movedSuperpowers)}')
      [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.preservationParent)}') | Out-Null
    } catch { $script:executeCompleteAncestorSwapBlocked = $true }
  }
}`,
      after: `[ordered]@{
  result = $result
  attempted = $script:executeCompleteAncestorSwapAttempted
  blocked = $script:executeCompleteAncestorSwapBlocked
  childCalls = $script:childCalls
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      attempted: true, blocked: true, childCalls: 1,
      result: { status: "PASS", category: "none", phase: "complete", outRestored: true },
    });
    expect(await exists(movedSuperpowers)).toBe(false);
  });

  it("holds the exact preservation parent through recovery terminal journaling", async () => {
    // Break caught: recovery must not release its ancestor authority before the complete journal is durable.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const movedParent = join(fixture.root, "recovery-parent-replaced-before-complete");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryCompleteSwapAttempted = $false
$script:recoveryCompleteSwapBlocked = $false
$contract.beforeStatePersistence = {
  param($State)
  if (-not $script:recoveryCompleteSwapAttempted -and
      [string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'complete') {
    $script:recoveryCompleteSwapAttempted = $true
    try {
      [IO.Directory]::Move('${escapePowerShell(fixture.preservationParent)}', '${escapePowerShell(movedParent)}')
      [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.preservationParent)}') | Out-Null
    } catch { $script:recoveryCompleteSwapBlocked = $true }
  }
}`,
      after: `[ordered]@{
  result = $result
  attempted = $script:recoveryCompleteSwapAttempted
  blocked = $script:recoveryCompleteSwapBlocked
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      attempted: true, blocked: true,
      result: { status: "RECOVERED", category: "recovery-restored", phase: "complete", outRestored: true },
    });
    expect(await exists(movedParent)).toBe(false);
  });

  it("returns a closed refusal when the recovery parent disappears before guard acquisition", async () => {
    // Break caught: guard acquisition races are controller refusals, not escaping exceptions or generic wrapper failures.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const movedParent = join(fixture.root, "recovery-parent-moved-before-guard");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryParentGuardHookCalled = $false
$contract['beforeRecoveryParentGuard'] = {
  $script:recoveryParentGuardHookCalled = $true
  [IO.Directory]::Move('${escapePowerShell(fixture.preservationParent)}', '${escapePowerShell(movedParent)}')
}`,
      after: `[ordered]@{
  result = $result
  hookCalled = $script:recoveryParentGuardHookCalled
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      hookCalled: true,
      result: {
        status: "REFUSED", category: "preservation-state-invalid", phase: "validated",
        childStarted: false, childExitCode: null, outRestored: false,
      },
    });
    expect(await exists(movedParent)).toBe(true);
  });

  it("refuses a concurrently occupied run root instead of adopting it as controller-owned", async () => {
    // Break caught: CreateDirectory is not exclusive and can adopt an attacker-created ordinary run root between absence proof and creation.
    const fixture = await createFixture();
    const marker = join(fixture.runRoot, "not-controller-owned.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:ownedLayoutHookCalled = $false
$contract['beforeOwnedLayoutCreation'] = {
  $script:ownedLayoutHookCalled = $true
  [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.runRoot)}') | Out-Null
  [IO.File]::WriteAllBytes('${escapePowerShell(marker)}', [byte[]](51, 0, 99))
}`,
      after: `[ordered]@{
  result = $result
  hookCalled = $script:ownedLayoutHookCalled
  moveCalls = @($script:moveCalls)
  childCalls = $script:childCalls
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({
      hookCalled: true, moveCalls: [], childCalls: 0,
      result: { status: "REFUSED", category: "preservation-state-invalid", childStarted: false, outRestored: false },
    });
    expect(await readFile(marker)).toEqual(Buffer.from([51, 0, 99]));
    expect(await exists(fixture.statePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("records protected prepared state only after ordinary roots and both held identities exist", async () => {
    // Break caught: writing prepared before creating Roaming or opening both no-delete-share guards would persist unusable cleanup authority.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:preparedObservation = $null
$contract['useProductionStateSecurity'] = $true
$contract.onStateWritten = {
  param($State)
  if ([string]$State.phase -cne 'prepared') { return }
  $ordinary = $true
  foreach ($path in @(
    '${escapePowerShell(fixture.runRoot)}',
    '${escapePowerShell(fixture.childProfilePath)}',
    '${escapePowerShell(fixture.childLocalAppDataPath)}',
    '${escapePowerShell(fixture.childRoamingAppDataPath)}'
  )) {
    $attributes = [IO.File]::GetAttributes($path)
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $ordinary = $false }
  }
  $profileHeld = $false
  $localHeld = $false
  try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(fixture.childProfilePath)}.held') } catch { $profileHeld = $true }
  try { [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(fixture.childLocalAppDataPath)}.held') } catch { $localHeld = $true }
  $script:preparedObservation = [ordered]@{
    ordinary = $ordinary
    profileHeld = $profileHeld
    localHeld = $localHeld
    profileIdentity = [string]$State.ownedRoots.profile.stableIdentity
    localIdentity = [string]$State.ownedRoots.localAppData.stableIdentity
  }
  throw 'host-loss-prepared'
}`,
      after: `$profileReleased = $false
$localReleased = $false
try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(fixture.childProfilePath)}.released'); $profileReleased = $true } catch { }
try { [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(fixture.childLocalAppDataPath)}.released'); $localReleased = $true } catch { }
[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; observation = $script:preparedObservation; profileReleased = $profileReleased; localReleased = $localReleased } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0, profileReleased: true, localReleased: true });
    expect(output.observation).toMatchObject({ ordinary: true, profileHeld: true, localHeld: true });
    expect(output.observation.profileIdentity).toMatch(/^[a-f0-9]{8}:[a-f0-9]{16}$/);
    expect(output.observation.localIdentity).toMatch(/^[a-f0-9]{8}:[a-f0-9]{16}$/);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({ phase: "prepared" });
    expect(await readProductionStateAccess(fixture)).toEqual({ parentProtected: true, stateProtected: true, valid: true });
  });

  it("disposes the held profile guard when opening the local-app-data guard fails", async () => {
    // Break caught: leaking the first guard on a second-guard failure would pin a controller-owned root after refusing execution.
    const fixture = await createFixture();
    const displacedLocal = `${fixture.childLocalAppDataPath}.ordinary`;
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.beforeLocalAppDataGuard = {
  [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(displacedLocal)}')
  [IO.File]::WriteAllText('${escapePowerShell(fixture.childLocalAppDataPath)}', 'not-a-directory')
}`,
      after: `$profileReleased = $false
try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(fixture.childProfilePath)}.released'); $profileReleased = $true } catch { }
[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; profileReleased = $profileReleased } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0, profileReleased: true });
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it("refuses a nonordinary Roaming root before opening guards, renaming out, or starting a child", async () => {
    // Break caught: CreateDirectory succeeding on a replaced Roaming entry must not be treated as proof of an ordinary directory.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.beforeOwnedRootGuards = {
  [IO.Directory]::Delete('${escapePowerShell(fixture.childRoamingAppDataPath)}')
  [IO.File]::WriteAllText('${escapePowerShell(fixture.childRoamingAppDataPath)}', 'not-a-directory')
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it("revalidates Roaming after owned-root capture at the last boundary before prepared persistence", async () => {
    // Break caught: replacing Roaming after its initial check must not leave a valid-looking prepared state that authorizes rename and launch.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.beforePreparedStateWrite = {
  param($State)
  [IO.Directory]::Delete('${escapePowerShell(fixture.childRoamingAppDataPath)}')
  [IO.File]::WriteAllText('${escapePowerShell(fixture.childRoamingAppDataPath)}', 'not-a-directory')
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(await exists(fixture.statePath)).toBe(false);
  });

  it.each([
    ["preserved", "preserved"],
    ["child-started", "child-started"],
  ])("retains valid protected %s state after injected host loss", async (faultPhase, expectedPhase) => {
    // Break caught: a post-move or prelaunch interruption must leave exact durable authority and must not start a child before intent is durable.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract['useProductionStateSecurity'] = $true
$contract.onStateWritten = { param($State) if ([string]$State.phase -ceq '${faultPhase}') { throw 'host-loss-${faultPhase}' } }`,
    })).stdout);
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", outRestored: true });
    expect(output.childCalls).toBe(0);
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(state.phase).toBe(expectedPhase);
    expect(await readProductionStateAccess(fixture)).toEqual({ parentProtected: true, stateProtected: true, valid: true });
  });

  it.each([
    ["preserved", "prepared"],
    ["child-started", "preserved"],
  ])("retains the last protected state when the %s phase write fails", async (faultPhase, expectedPhase) => {
    // Break caught: a real persistence failure after rename or before child creation must retain the prior durable phase and start no child.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract['useProductionStateSecurity'] = $true
$contract.beforeStatePersistence = { param($State) if ([string]$State.phase -ceq '${faultPhase}') { throw 'state-write-failure-${faultPhase}' } }`,
    })).stdout);
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", outRestored: true });
    expect(output.childCalls).toBe(0);
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(state.phase).toBe(expectedPhase);
    expect(await readProductionStateAccess(fixture)).toEqual({ parentProtected: true, stateProtected: true, valid: true });
  });

  it("forbids rename when the prepared state cannot be locked and re-read as the promoted identity", async () => {
    // Break caught: treating a flush/promote as sufficient without a locked identity-stable reread could authorize rename from swapped state evidence.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:stateIdentityDrift = $false
$contract.beforeStateRead = { $script:stateIdentityDrift = $true }
$contract.getStableFileIdentity = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.statePath)}' -and $script:stateIdentityDrift) { '00000004:0000000000000004' }
  else { '00000002:0000000000000002' }
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0 });
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({ phase: "prepared" });
  });

  it("has no path-based recursive deletion in the controller source policy", async () => {
    // Break caught: retaining Directory.Delete(path, true) bypasses the handle-validated no-follow cleaner even if junction fixtures happen to survive.
    const source = await readFile(scriptPath, "utf8");
    expect(cleanupPolicyFailures(source)).toEqual([]);
    expect(source).not.toMatch(/Get-ChildItem|EnumerateFiles|EnumerateDirectories|GetFiles|GetDirectories|Copy-Item|Move-Item|Remove-Item|Start-Process|Invoke-Expression|[&]\s*(?:['"])?cmd(?:\.exe)?\b/i);
    expect(source).toContain("public static string RemoveTreeNoFollow(string rootPath, string expectedStableIdentity)");
    expect(source).toContain("uint access = DELETE | FILE_READ_ATTRIBUTES");
    expect(source).toContain("FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS");
    expect(source).toContain("NtOpenFile(out handle, access, ref attributes, out ioStatus, FILE_SHARE_READ, options)");
    expect(source).toContain("childHandle = OpenEntry(directoryHandle, leaf, enumeratedDirectory)");
    expect(source).not.toContain("FILE_SHARE_DELETE");
    const openEntry = source.match(/static IntPtr OpenEntry\(IntPtr parentHandle, string leaf, bool directory\) \{[\s\S]*?^        \}/m)?.[0];
    expect(openEntry).toBeTruthy();
    expect(openEntry).not.toContain("FILE_SHARE_WRITE");
    expect(openEntry).not.toContain("FILE_SHARE_DELETE");
    const openRoot = source.match(/static IntPtr OpenRoot\(string path\) \{[\s\S]*?^        \}/m)?.[0];
    expect(openRoot).toBeTruthy();
    expect(openRoot).not.toContain("FILE_SHARE_WRITE");
    expect(openRoot).not.toContain("FILE_SHARE_DELETE");
    expect(source).toContain("ReadDirectoryEntries(directoryHandle, out entries)");
    expect(source).toContain("string openedIdentity = DirectoryRenameSession.ReadIdentity(childHandle)");
    expect(source).toContain("EnumerationMatchesHandle(data, opened, openedIdentity)");
    const markDelete = source.match(/static CleanupResult MarkDelete\(IntPtr handle\) \{[\s\S]*?^        \}/m)?.[0];
    expect(markDelete).toBeTruthy();
    expect(markDelete).toMatch(/SetFileInformationByHandle\(\s*handle\s*,\s*FileDispositionInfo/);
    const removeEmpty = source.match(/public static string RemoveEmptyNoFollow\(string rootPath, string expectedStableIdentity\) \{[\s\S]*?^        \}/m)?.[0];
    expect(removeEmpty).toBeTruthy();
    expect(removeEmpty).toContain("BeforeRootDispositionForTest(rootPath)");
    expect(removeEmpty).toContain("ReadTag(root)");
    expect(removeEmpty).toContain("DirectoryRenameSession.ReadIdentity(root)");
    expect(source).toContain("foreach (string component in DirectoryRenameSession.Components(canonicalRoot))");
    expect(source).toContain("leaf.IndexOf(':') >= 0");
    expect(source).toContain("leaf.IndexOf(Path.DirectorySeparatorChar) >= 0");
    expect(source).toContain("leaf.IndexOf(Path.AltDirectorySeparatorChar) >= 0");
    expect(source).toContain("leaf == \".\" || leaf == \"..\"");
    expect(source).not.toContain("FindFirstFileW");
    expect(source).not.toContain("FindNextFileW");
    expect(source).not.toMatch(/(?:\[IO\.)?Directory\]?(?:::|\.)Delete\s*\(/i);
    expect(source).not.toMatch(/release:make|Set-AuthenticodeSignature|[&]\s*(?:['"])?(?:signtool|certutil)(?:\.exe)?|Setup\.exe/i);
    expect(source.match(/& \$invokeChild /g)).toHaveLength(1);
    expect(source).toContain("finally {");
    expect(source).toContain("[IO.Directory]::Move($Source, $Destination)");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(source).toContain("EXTENDED_STARTUPINFO_PRESENT");
    expect(source).toContain("SetAccessRuleProtection(true, false)");
  });

  it("[id06-contract] ID06 kills controller mutants with dedicated structural and behavioral safety checks", async () => {
    // Mutants are written only under the same-volume temporary fixture and are never invoked as production controllers.
    const fixture = await createFixture();
    const source = await readFile(scriptPath, "utf8");
    expect(controllerInvariantFailures(source)).toEqual([]);
    const mutants: Array<[string, string, (value: string) => string]> = [
      ["v1-state-schema", "closed-v2-state-schema", (value) => value.replaceAll("intentarc.preflight-out-preservation-state/v2", "intentarc.preflight-out-preservation-state/v1")],
      ["id05-production-literal", "fixed-id06-identity", (value) => value.replace("phase1-preflight-20260901-06", "phase1-preflight-20260830-05")],
      ["missing-pre-rename-journal", "prepared-before-rename", (value) => value.replace(
        "        $preparedWriteAttempted = $true\n        & $writeState $contract $state\n        $preparedStateDurable = $true",
        "        $preparedWriteAttempted = $true\n        $preparedStateDurable = $true",
      )],
      ["child-before-intent-journal", "intent-before-child", (value) => value
        .replace("        try {\n            $child = & $invokeChild $contract $pnpmExecutable", "        try {\n            $child = $child")
        .replace(
          "        $timestamps.childStartedAt = & $now\n        try {\n            & $writeState $contract $state",
          "        $timestamps.childStartedAt = & $now\n        $child = & $invokeChild $contract $pnpmExecutable\n        try {\n            & $writeState $contract $state",
        )],
      ["finally-restoration", "finally-restoration", (value) => value.replace("} finally {\n        if ($preservationAttempted -and $restorationAuthorized)", "} if ($false) {\n        if ($preservationAttempted -and $restorationAuthorized)")],
      ["second-child-site", "single-child-site", (value) => value.replace("            $child = & $invokeChild $contract $pnpmExecutable", "            $child = & $invokeChild $contract $pnpmExecutable\n            $child = & $invokeChild $contract $pnpmExecutable")],
      ["former-output-cap", "one-megabyte-output-cap", (value) => value.replace("        maximumBytesPerStream = 1048576", "        maximumBytesPerStream = 65536")],
      ["omitted-appdata", "closed-appdata-routing", (value) => value.replace("        $environment['APPDATA'] = [IO.Path]::GetFullPath([string]$Contract.childRoamingAppDataPath)\n", "")],
      ["profile-full-metadata-cleanup", "owned-root-boundary-metadata", (value) => value.replace(
        "            [string]$actualStableIdentity -ceq [string]$Expected.stableIdentity",
        "            [string]$actualStableIdentity -ceq [string]$Expected.stableIdentity -and\n            [string]$actual.lastWriteTimeUtc -ceq [string]$Expected.lastWriteTimeUtc",
      )],
      ["stable-helper-adopts-reopened-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "        $actualStableIdentity = & $getStableDirectoryIdentity $contract $LiteralPath",
        "        $actualStableIdentity = & $getStableDirectoryIdentity $contract $LiteralPath\n        $authority = $Expected\n        $authority['stableIdentity'] = [string]$actualStableIdentity",
      )],
      ["recaptured-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)",
        "                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)\n                $profileIdentity = & $newOwnedRootEvidence $contract.childProfilePath $profileGuard.Identity",
      )],
      ["reassigned-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $profileIdentity = $state.ownedRoots.profile",
        "            $profileIdentity = $state.ownedRoots.profile\n            $profileIdentity.stableIdentity = & $getStableDirectoryIdentity $contract ([string]$contract.childProfilePath)",
      )],
      ["bracket-reassigned-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $profileIdentity = $state.ownedRoots.profile",
        "            $profileIdentity = $state.ownedRoots.profile\n            $profileIdentity['stableIdentity'] = [string]$localAppDataIdentity.stableIdentity",
      )],
      ["alias-reassigned-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $profileIdentity = $state.ownedRoots.profile",
        "            $profileIdentity = $state.ownedRoots.profile\n            $profileAuthority = $profileIdentity\n            $profileAuthority['stableIdentity'] = [string]$localAppDataIdentity.stableIdentity",
      )],
      ["case-drift-reassigned-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)",
        "                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)\n                $PROFILEIDENTITY['stableIdentity'] = [string]$profileGuard.Identity",
      )],
      ["helper-adopts-reopened-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "        if ($null -eq $Guard -or [string]$Guard.Identity -cne [string]$Expected.stableIdentity) { return $false }",
        "        $Expected.stableIdentity = [string]$Guard.Identity\n        if ($null -eq $Guard -or [string]$Guard.Identity -cne [string]$Expected.stableIdentity) { return $false }",
      )],
      ["removal-helper-adopts-post-release-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $Guard.Dispose()\n            if ($null -ne $TestContract -and $null -ne $Contract.afterOwnedRootGuardRelease)",
        "            $Guard.Dispose()\n            $ExpectedIdentity.stableIdentity = & $getStableDirectoryIdentity $Contract $LiteralPath\n            if ($null -ne $TestContract -and $null -ne $Contract.afterOwnedRootGuardRelease)",
      )],
      ["stable-helper-ref-rebinding", "persisted-recovery-identity", (value) => value.replace(
        "            $profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard",
        "            $stableBoundaryReference = [ref]$stableDirectoryBoundaryMatches\n            $stableBoundaryReference.Value = { param($Expected, [string] $LiteralPath) $Expected.stableIdentity = & $getStableDirectoryIdentity $contract $LiteralPath; $true }\n            $profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard",
      )],
      ["stable-helper-provider-rebinding", "persisted-recovery-identity", (value) => value.replace(
        "            $profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard",
        "            (Get-Variable -Name stableDirectoryBoundaryMatches).Value = { param($Expected, [string] $LiteralPath) $Expected.stableIdentity = & $getStableDirectoryIdentity $contract $LiteralPath; $true }\n            $profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard",
      )],
      ["state-owned-root-recaptured-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $profileIdentity = $state.ownedRoots.profile",
        "            $profileIdentity = $state.ownedRoots.profile\n            $state.ownedRoots.profile.stableIdentity = & $getStableDirectoryIdentity $contract $contract.childProfilePath",
      )],
      ["state-alias-recaptured-recovery-identity", "persisted-recovery-identity", (value) => value.replace(
        "            $profileIdentity = $state.ownedRoots.profile",
        "            $profileIdentity = $state.ownedRoots.profile\n            $shadow = $state.ownedRoots.profile\n            $shadow['stableIdentity'] = [string]$profileGuard.Identity",
      )],
      ["wrong-recovery-cleanup-guard", "recovery-authority-flow", (value) => value.replace(
        "$profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $profileGuard",
        "$profileStatus = & $removeOwnedRoot $contract $profileIdentity $contract.childProfilePath $null",
      )],
      ["recursive-non-owned-deletion", "owned-recursive-target", (value) => value.replace(
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,",
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    [string]$Contract.runRoot,",
      )],
      ["second-recursive-non-owned-deletion", "owned-recursive-target", (value) => value.replace(
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )",
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )\n                [void][IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow([string]$Contract.runRoot, [string]$ExpectedIdentity.stableIdentity)",
      )],
      ["alternate-recursive-non-owned-deletion", "owned-recursive-target", (value) => value.replace(
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )",
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )\n                [IO.Directory]::Delete([string]$Contract.runRoot, $true)",
      )],
      ["system-io-recursive-non-owned-deletion", "owned-recursive-target", (value) => value.replace(
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )",
        "                $treeResult = [IntentArc.Preflight.OwnedDirectoryCleaner]::RemoveTreeNoFollow(\n                    $LiteralPath,\n                    [string]$ExpectedIdentity.stableIdentity\n                )\n                [System.IO.Directory]::Delete([string]$Contract.runRoot, $true)",
      )],
      ["cleanup-overwrites-primary", "cleanup-secondary-projection", (value) => value.replace(
        "        return [ordered]@{\n            status = [string]$primary.status",
        "        if ($cleanupCategory -ceq 'residue-invalid') { $primary.status = 'FAIL'; $primary.category = 'residue-invalid' }\n        return [ordered]@{\n            status = [string]$primary.status",
      )],
      ["cleanup-variable-overwrites-primary", "cleanup-secondary-projection", (value) => value.replace(
        "        return [ordered]@{\n            status = [string]$primary.status",
        "        $primary.status = 'FAIL'; $primary.category = $cleanupCategory\n        return [ordered]@{\n            status = [string]$primary.status",
      )],
      ["restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "$primary.status = 'RECOVERED'; $primary.category = 'recovery-restored'",
        "$primary.status = 'PASS'; $primary.category = 'none'",
      )],
      ["late-restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "$primary.status = 'RECOVERED'; $primary.category = 'recovery-restored'",
        "$primary.status = 'RECOVERED'; $primary.category = 'recovery-restored'\n                $primary.status = 'PASS'; $primary.category = 'none'",
      )],
      ["returned-restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "            status = [string]$primary.status",
        "            status = $(if ($Mode -ceq '-RestoreOnly') { 'PASS' } else { [string]$primary.status })",
      )],
      ["projected-restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "        $primary = & $resolvePrimaryOutcome $Mode $Evidence",
        "        $primary = & $resolvePrimaryOutcome $Mode $Evidence\n        if ($Mode -ceq '-RestoreOnly') { $primary.status = 'PASS'; $primary.category = 'none' }",
      )],
      ["projected-split-restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "        $primary = & $resolvePrimaryOutcome $Mode $Evidence",
        "        $primary = & $resolvePrimaryOutcome $Mode $Evidence\n        if ($Mode -ceq '-RestoreOnly') { $primary.status = ('P' + 'ASS'); $primary.category = 'none' }",
      )],
      ["direct-footer-split-restore-only-pass", "restore-only-non-authorizing", (value) => value.replace(
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)",
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)\n        if ([string]$controllerResult.status -ceq 'RECOVERED') { $controllerResult.status = ('P' + 'ASS'); $controllerResult.category = 'none' }",
      )],
      ["direct-footer-shadowed-serializer-pass", "restore-only-non-authorizing", (value) => value.replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        "function ConvertTo-Json { process { '{\"schema\":\"intentarc.preflight-out-preservation-result/v2\",\"status\":\"PASS\",\"category\":\"none\",\"cleanupCategory\":\"none\",\"phase\":\"complete\",\"childStarted\":false,\"childExitCode\":null,\"outRestored\":true}' } }\n\nif ($MyInvocation.InvocationName -ne '.') {",
      )],
      ["direct-footer-qualified-shadowed-serializer-pass", "restore-only-non-authorizing", (value) => value.replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        "function global:Microsoft.PowerShell.Utility\\ConvertTo-Json { process { '{\"schema\":\"intentarc.preflight-out-preservation-result/v2\",\"status\":\"PASS\",\"category\":\"none\",\"cleanupCategory\":\"none\",\"phase\":\"complete\",\"childStarted\":false,\"childExitCode\":null,\"outRestored\":true}' } }\n\nif ($MyInvocation.InvocationName -ne '.') {",
      )],
      ["direct-footer-module-shadowed-serializer-pass", "restore-only-non-authorizing", (value) => value.replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        "$shadowModule = New-Module -Name ('Microsoft.PowerShell.' + 'Utility') -ScriptBlock { Set-Item -Path ('function:' + ('ConvertTo-' + 'Json')) -Value { process { '{\"status\":\"PASS\"}' } }; Export-ModuleMember -Function ('ConvertTo-' + 'Json') }; Import-Module $shadowModule -Force\n\nif ($MyInvocation.InvocationName -ne '.') {",
      )],
      ["missing-recovery-handle", "recovery-held-guards", (value) => value.replace(
        "                $profileGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open([string]$contract.childProfilePath)",
        "                $profileGuard = $null",
      )],
      ["path-created-owned-layout", "handle-relative-owned-layout", (value) => value.replace(
        "        $runRootSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::CreateExclusive(\n            $preservationParentSetupGuard,\n            [IO.Path]::GetFileName([string]$contract.runRoot)\n        )",
        "        [void][IO.Directory]::CreateDirectory([string]$contract.runRoot)\n        $runRootSetupGuard = [IntentArc.Preflight.DirectoryComponentGuard]::OpenForCreation([string]$contract.runRoot)",
      )],
      ["release-lifecycle-call", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & 'C:\\Windows\\System32\\signtool.exe' 'sign'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-production-contract-split-tool", "no-release-lifecycle-call", (value) => value.replace(
        "        gitExecutable = 'C:\\Program Files\\Git\\cmd\\git.exe'\n        gitDirectory = 'C:\\Program Files\\Git\\cmd'\n        gitSha256 = '54194a1af7cfb6730448ce14b8f2c1dddd9f950b7f995dc351c1ed16eb179249'",
        "        gitExecutable = ('C:\\Windows\\System32\\sign' + 'tool.exe')\n        gitDirectory = 'C:\\Windows\\System32'\n        gitSha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
      )],
      ["release-lifecycle-prelude-braced-native-run", "no-release-lifecycle-call", (value) => value.replace(
        "function Invoke-IntentArcPreflightOutPreservation {",
        "Initialize-IntentArcPreflightNativeProcessType\n$preludeNativeType = (('IntentArc.Preflight.Native' + 'Process') -as [type])\n$null = ${preludeNativeType}::Run(('sign' + 'tool.exe'), [string[]]@('sign'), [IO.Path]::GetTempPath(), [Collections.Generic.Dictionary[string,string]]::new(), 30000, 1000, 65536, 'IntentArc.Preflight.mutant')\n\nfunction Invoke-IntentArcPreflightOutPreservation {",
      )],
      ["release-lifecycle-csharp-split-process-start", "no-release-lifecycle-call", (value) => value.replace(
        "            var result = new NativeProcessResult { StartAttempted = true, DescendantsSettled = true, JobName = jobName };",
        "            Process.Start(\"sign\" + \"tool.exe\");\n            var result = new NativeProcessResult { StartAttempted = true, DescendantsSettled = true, JobName = jobName };",
      )],
      ["release-lifecycle-csharp-rewrites-native-executable", "no-release-lifecycle-call", (value) => value.replace(
        "            var result = new NativeProcessResult { StartAttempted = true, DescendantsSettled = true, JobName = jobName };",
        "            executable = \"sign\" + \"tool.exe\";\n            var result = new NativeProcessResult { StartAttempted = true, DescendantsSettled = true, JobName = jobName };",
      )],
      ["release-lifecycle-start-process", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    Start-Process 'signtool.exe' -ArgumentList 'sign'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-dotnet-process", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    [Diagnostics.Process]::Start('signtool.exe', 'sign')\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-publish", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & $pnpmExecutable 'publish'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-unquoted-publish", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & $pnpmExecutable publish\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-pack", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & $pnpmExecutable pack\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-split-tool", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    $tool = 'sign' + 'tool.exe'\n    & $tool 'sign'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-split-verb", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    $verb = 'pub' + 'lish'\n    & $pnpmExecutable $verb\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-reassigned-authorized-command", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $invokeChild = 'sign' + 'tool.exe'\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-braced-command", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & ${pnpmExecutable} publish\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-start-process-alias", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    $tool = 'sign' + 'tool.exe'\n    saps $tool 'sign'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-instance-process", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    $tool = 'sign' + 'tool.exe'\n    [Diagnostics.Process]::new().Start($tool)\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-expression-command", "no-release-lifecycle-call", (value) => value.replace(
        "    $schema = 'intentarc.preflight-out-preservation-result/v2'",
        "    & ('sign' + 'tool.exe') 'sign'\n    $schema = 'intentarc.preflight-out-preservation-result/v2'",
      )],
      ["release-lifecycle-variable-provider-reassignment", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            Set-Item -LiteralPath Variable:invokeChild -Value ('sign' + 'tool.exe')\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-native-run-split-tool", "no-release-lifecycle-call", (value) => value.replace(
        "                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
        "                $null = [IntentArc.Preflight.NativeProcess]::Run(\n                    ('sign' + 'tool.exe'),\n                    [string[]]@('sign'),\n                    [string]$Contract.repositoryRoot,\n                    $environment,\n                    30000,\n                    1000,\n                    65536,\n                    ([string]$Contract.jobName + '.mutant')\n                )\n                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
      )],
      ["release-lifecycle-native-output-split-publish", "no-release-lifecycle-call", (value) => value.replace(
        "        $standardOutput = [IntentArc.Preflight.NativeProcess]::RunForStandardOutput(\n",
        "        $null = [IntentArc.Preflight.NativeProcess]::RunForStandardOutput(\n            [string]$pnpmExecutable,\n            [string[]]@(('pub' + 'lish')),\n            [string]$Contract.repositoryRoot,\n            $environment,\n            30000,\n            1000,\n            65536,\n            ([string]$Contract.jobName + '.mutant')\n        )\n        $standardOutput = [IntentArc.Preflight.NativeProcess]::RunForStandardOutput(\n",
      )],
      ["release-lifecycle-native-indexed-split-publish", "no-release-lifecycle-call", (value) => value.replace(
        "                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
        "                $nativeArguments[0] = ('pub' + 'lish')\n                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
      )],
      ["release-lifecycle-native-ref-split-tool", "no-release-lifecycle-call", (value) => value.replace(
        "                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
        "                $nativeExecutableReference = [ref]$nativeExecutable\n                $nativeExecutableReference.Value = ('sign' + 'tool.exe')\n                $native = [IntentArc.Preflight.NativeProcess]::Run(\n",
      )],
      ["release-lifecycle-invoke-child-ref-rebinding", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $invokeChildReference = [ref]$invokeChild\n            $invokeChildReference.Value = ('sign' + 'tool.exe')\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-invoke-child-provider-rebinding", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            (Get-Variable -Name invokeChild).Value = ('sign' + 'tool.exe')\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-native-type-alias-run", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $nativeRunnerType = [IntentArc.Preflight.NativeProcess]\n            $null = $nativeRunnerType::Run(('sign' + 'tool.exe'), [string[]]@('sign'), [string]$contract.repositoryRoot, [Collections.Generic.Dictionary[string,string]]::new(), 30000, 1000, 65536, ([string]$contract.jobName + '.mutant'))\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-native-type-alias-output", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $nativeRunnerType = [IntentArc.Preflight.NativeProcess]\n            $null = $nativeRunnerType::RunForStandardOutput([string]$pnpmExecutable, [string[]]@(('pub' + 'lish')), [string]$contract.repositoryRoot, [Collections.Generic.Dictionary[string,string]]::new(), 30000, 1000, 65536, ([string]$contract.jobName + '.mutant'))\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-native-braced-type-alias", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $nativeRunnerType = (('IntentArc.Preflight.Native' + 'Process') -as [type])\n            $null = ${nativeRunnerType}::Run(('sign' + 'tool.exe'), [string[]]@('sign'), [string]$contract.repositoryRoot, [Collections.Generic.Dictionary[string,string]]::new(), 30000, 1000, 65536, ([string]$contract.jobName + '.mutant'))\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["release-lifecycle-native-reflection", "no-release-lifecycle-call", (value) => value.replace(
        "            $child = & $invokeChild $contract $pnpmExecutable",
        "            $nativeRunnerType = (('IntentArc.Preflight.' + 'NativeProcess') -as [type])\n            $nativeRunnerMethod = @($nativeRunnerType.GetMethods() | Where-Object { $_.Name -ceq ('R' + 'un') })[0]\n            $null = $nativeRunnerMethod.Invoke($null, [object[]]@(('sign' + 'tool.exe'), [string[]]@('sign'), [string]$contract.repositoryRoot, [Collections.Generic.Dictionary[string,string]]::new(), 30000, 1000, 65536, ([string]$contract.jobName + '.mutant')))\n            $child = & $invokeChild $contract $pnpmExecutable",
      )],
      ["early-state-ancestor-guard-disposal", "continuous-state-parent-authority", (value) => value.replace(
        "        if ($null -ne $runRootSetupGuard) { $runRootSetupGuard.Dispose(); $runRootSetupGuard = $null }",
        "        if ($null -ne $runRootSetupGuard) { $runRootSetupGuard.Dispose(); $runRootSetupGuard = $null }\n        if ($null -ne $superpowersSetupGuard) { $superpowersSetupGuard.Dispose(); $superpowersSetupGuard = $null }",
      )],
      ["weakened-destination", "exact-destination", (value) => value.replace("[string]::Equals($Destination, [string]$Contract.destinationPath, [StringComparison]::OrdinalIgnoreCase)", "$true")],
      ["removed-conflict-guards", "restoration-conflicts", (value) => value.replace("if ($sourceStateAfter -ceq 'absent' -and $destinationStateAfter -ceq 'present')", "if ($true)").replace("elseif ($sourceStateAfter -ceq 'present' -and $destinationStateAfter -ceq 'absent')", "elseif ($true)")],
      ["opened-result-enums", "closed-result-enums", (value) => value.replace("$resultStatuses = @('PASS', 'RECOVERED', 'REFUSED', 'FAIL')", "$resultStatuses = @('PASS', 'RECOVERED', 'REFUSED', 'FAIL', 'OPEN')")],
      ["altered-child-vector", "direct-child-vector", (value) => value.replace("            '--tracked-only'", "            '--include-untracked'")],
      ["disabled-stable-production", "stable-production-selection", (value) => value.replace("if ($null -eq $TestContract -or $contract.useStableRename -eq $true)", "if ($contract.useStableRename -eq $true)")],
      ["disabled-stable-recovery-production", "stable-production-selection", (value) => value.replace("($null -eq $TestContract -or $contract.useStableRecovery -eq $true)", "($contract.useStableRecovery -eq $true)")],
      ["removed-state-write-through", "write-through-state-promotion", (value) => value.replace("MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH", "MOVEFILE_REPLACE_EXISTING")],
      ["cleanup-write-sharing", "exclusive-handle-relative-child-open", (value) => value.replace("NtOpenFile(out handle, access, ref attributes, out ioStatus, FILE_SHARE_READ, options)", "NtOpenFile(out handle, access, ref attributes, out ioStatus, FILE_SHARE_READ | FILE_SHARE_WRITE, options)")],
      ["cleanup-delete-sharing", "exclusive-root-open", (value) => value.replace("FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING", "FILE_SHARE_READ | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING")],
      ["cleanup-path-child-open", "handle-relative-child-call", (value) => value.replace("childHandle = OpenEntry(directoryHandle, leaf, enumeratedDirectory)", "childHandle = OpenEntry(IntPtr.Zero, childPath, enumeratedDirectory)")],
      ["cleanup-missing-identity-match", "enumerated-opened-identity", (value) => value.replace("EnumerationMatchesHandle(data, opened, openedIdentity)", "true")],
      ["cleanup-wrong-disposition-handle", "same-handle-disposition", (value) => value.replace(": MarkDelete(childHandle);", ": MarkDelete(directoryHandle);")],
    ];
    const mutantPaths = new Map<string, string>();
    for (const [name, expectedFailure, mutate] of mutants) {
      const mutant = mutate(source.replaceAll("\r\n", "\n"));
      expect(mutant, `${name} mutation must change source`).not.toBe(source.replaceAll("\r\n", "\n"));
      const mutantPath = join(fixture.root, `${name}.ps1`);
      await writeFile(mutantPath, mutant, "utf8");
      mutantPaths.set(name, mutantPath);
      expect.soft(controllerInvariantFailures(await readFile(mutantPath, "utf8")), name).toContain(expectedFailure);
    }

    const restorationFixture = await createFixture();
    const restorationOutput = JSON.parse((await runCore(restorationFixture, {
      controllerPath: mutantPaths.get("finally-restoration"),
      overrides: successChildOverride(restorationFixture),
    })).stdout);
    expect(restorationOutput.result.outRestored === true &&
      await exists(restorationFixture.sourcePath) && !await exists(restorationFixture.destinationPath),
    "removed finally must fail the restoration behavior check").toBe(false);

    const cardinalityFixture = await createFixture();
    const cardinalityOutput = JSON.parse((await runCore(cardinalityFixture, {
      controllerPath: mutantPaths.get("second-child-site"),
      overrides: successChildOverride(cardinalityFixture),
    })).stdout);
    expect(cardinalityOutput.childCalls, "second child must fail the one-child behavior check").not.toBe(1);

    const conflictFixture = await createFixture();
    const conflictOutput = JSON.parse((await runCore(conflictFixture, {
      controllerPath: mutantPaths.get("removed-conflict-guards"),
      overrides: successChildOverride(conflictFixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(conflictFixture.sourcePath)}') | Out-Null`),
    })).stdout);
    expect(conflictOutput.moveCalls.length === 1 &&
      await exists(conflictFixture.sourcePath) && await exists(conflictFixture.destinationPath),
    "removed guards must fail the no-mutation conflict behavior check").toBe(false);

    const vectorFixture = await createFixture();
    const vectorOutput = JSON.parse((await runCore(vectorFixture, {
      controllerPath: mutantPaths.get("altered-child-vector"),
      overrides: successChildOverride(vectorFixture),
      after: "[ordered]@{ result = $result; childObservation = $script:childObservation } | ConvertTo-Json -Depth 12 -Compress",
    })).stdout);
    expect(vectorOutput.childObservation.arguments,
      "altered vector must fail the exact child-command behavior check").not.toEqual([
      "--dir", vectorFixture.repositoryRoot, "run", "desktop:release:preflight", "--run-id", runId, "--tracked-only",
    ]);

    const cleanupOverrideOutput = await resolvePrimaryOutcome("-Execute", {
      ...successfulExecuteEvidence(),
      childExitCode: 7,
      childCategory: "preflight-failed",
      cleanupCategory: "residue-invalid",
    }, mutantPaths.get("cleanup-variable-overwrites-primary"));
    expect(cleanupOverrideOutput,
      "cleanup override must fail the primary-category behavior check").toMatchObject({
      status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid",
    });

    const lateRecoveryPassOutput = await resolvePrimaryOutcome(
      "-RestoreOnly",
      successfulRecoveryEvidence(),
      mutantPaths.get("late-restore-only-pass"),
    );
    expect(lateRecoveryPassOutput,
      "late recovery PASS must fail the non-authorizing behavior check").toMatchObject({
      status: "PASS", category: "none", childStarted: false, childExitCode: null,
    });

    const returnedRecoveryPassOutput = await resolvePrimaryOutcome(
      "-RestoreOnly",
      successfulRecoveryEvidence(),
      mutantPaths.get("returned-restore-only-pass"),
    );
    expect(returnedRecoveryPassOutput,
      "returned recovery PASS must fail the non-authorizing behavior check").toMatchObject({
      status: "PASS", category: "recovery-restored", childStarted: false, childExitCode: null,
    });

  }, 30_000);

  it("direct restore-only footer cannot serialize PASS or exit zero after a split-string status mutant", async () => {
    // Break caught: the direct-process footer is the final release authority and must reject forged status and serialization.
    const fixture = await createFixture();

    const source = (await readFile(scriptPath, "utf8")).replaceAll("\r\n", "\n");
    const directContract = contractSource(fixture,
      `$contract['primaryOutcomeEvidenceForTest'] = '${escapePowerShell(JSON.stringify(successfulRecoveryEvidence()))}' | ConvertFrom-Json`);
    const directSource = source.replace(
      "if ($MyInvocation.InvocationName -ne '.') {",
      `${directContract}\nif ($MyInvocation.InvocationName -ne '.') {`,
    );
    const statusMutant = directSource.replace(
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)",
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args) -TestContract $contract\n        if ([string]$controllerResult.status -ceq 'RECOVERED') { $controllerResult.status = ('P' + 'ASS'); $controllerResult.category = 'none' }",
    );
    const serializerMutant = directSource
      .replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        "function ConvertTo-Json { process { '{\"schema\":\"intentarc.preflight-out-preservation-result/v2\",\"status\":\"PASS\",\"category\":\"none\",\"cleanupCategory\":\"none\",\"phase\":\"complete\",\"childStarted\":false,\"childExitCode\":null,\"outRestored\":true}' } }\n\nif ($MyInvocation.InvocationName -ne '.') {",
      )
      .replace(
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)",
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args) -TestContract $contract",
      );
    const qualifiedSerializerMutant = directSource
      .replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        "function global:Microsoft.PowerShell.Utility\\ConvertTo-Json { process { '{\"schema\":\"intentarc.preflight-out-preservation-result/v2\",\"status\":\"PASS\",\"category\":\"none\",\"cleanupCategory\":\"none\",\"phase\":\"complete\",\"childStarted\":false,\"childExitCode\":null,\"outRestored\":true}' } }\n\nif ($MyInvocation.InvocationName -ne '.') {",
      )
      .replace(
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)",
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args) -TestContract $contract",
      );
    const moduleShadow = [
      "$shadowSerializerModule = New-Module -Name ('Microsoft.PowerShell.' + 'Utility') -ScriptBlock {",
      "    Set-Item -Path ('function:' + ('ConvertTo-' + 'Json')) -Value { process { '{\"schema\":\"intentarc.preflight-out-preservation-result/v2\",\"status\":\"PASS\",\"category\":\"none\",\"cleanupCategory\":\"none\",\"phase\":\"complete\",\"childStarted\":false,\"childExitCode\":null,\"outRestored\":true}' } }",
      "    Export-ModuleMember -Function ('ConvertTo-' + 'Json')",
      "}",
      "Import-Module $shadowSerializerModule -Force",
    ].join("\n");
    const moduleSerializerMutant = directSource
      .replace(
        "if ($MyInvocation.InvocationName -ne '.') {",
        `${moduleShadow}\n\nif ($MyInvocation.InvocationName -ne '.') {`,
      )
      .replace(
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args)",
        "        $controllerResult = Invoke-IntentArcPreflightOutPreservation -ArgumentsVector @($args) -TestContract $contract",
      );

    const invokeDirectMutant = async (name: string, mutant: string) => {
      expect(mutant, `${name} must change source`).not.toBe(source);
      const mutantPath = join(fixture.root, `${name}.ps1`);
      await writeFile(mutantPath, mutant, "utf8");
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      try {
        const output = await execFileAsync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-File", mutantPath,
          "-RestoreOnly", "-ExpectedCommit", commit,
          "-PnpmExecutable", fixture.pnpmExecutable,
          "-ExpectedPnpmSha256", pnpmHash,
        ], {
          encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
          windowsHide: true, timeout: 30_000,
        });
        stdout = output.stdout;
        stderr = output.stderr;
      } catch (error: any) {
        exitCode = Number(error.code);
        stdout = String(error.stdout);
        stderr = String(error.stderr);
      }
      const raw = stdout.trim();
      const parsed = JSON.parse(raw);
      expectClosedResult(parsed);
      expect(raw.split(/\r?\n/)).toHaveLength(1);
      expect(stderr).toBe("");
      return { exitCode, parsed };
    };

    const statusOutcome = await invokeDirectMutant("direct-footer-split-restore-only-pass", statusMutant);
    expect(statusOutcome).toMatchObject({ exitCode: 1, parsed: { status: "FAIL", category: "repository-invalid" } });
    const serializerOutcome = await invokeDirectMutant("direct-footer-shadowed-serializer-pass", serializerMutant);
    expect(serializerOutcome).toMatchObject({
      exitCode: 1,
      parsed: { status: "RECOVERED", category: "recovery-restored", childStarted: false, childExitCode: null },
    });
    const qualifiedSerializerOutcome = await invokeDirectMutant(
      "direct-footer-qualified-shadowed-serializer-pass",
      qualifiedSerializerMutant,
    );
    expect.soft(qualifiedSerializerOutcome).toMatchObject({
      exitCode: 1,
      parsed: { status: "RECOVERED", category: "recovery-restored", childStarted: false, childExitCode: null },
    });
    const moduleSerializerOutcome = await invokeDirectMutant(
      "direct-footer-module-shadowed-serializer-pass",
      moduleSerializerMutant,
    );
    expect.soft(moduleSerializerOutcome).toMatchObject({
      exitCode: 1,
      parsed: { status: "RECOVERED", category: "recovery-restored", childStarted: false, childExitCode: null },
    });
  }, 30_000);

  it("preserves opaque contents with injected enumerate, read, hash, copy, write, and delete access traps", async () => {
    // Break caught: metadata-only namespace renames must succeed even when descendant traversal and content access are denied.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "opaque-access-trap.bin");
    const bytes = Buffer.from([0, 255, 17, 34, 51, 68, 85]);
    await writeFile(sentinel, bytes);
    const setup = [
      `$source = [IO.DirectoryInfo]::new('${escapePowerShell(fixture.sourcePath)}')`,
      `$file = [IO.FileInfo]::new('${escapePowerShell(sentinel)}')`,
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$sourceSecurity = $source.GetAccessControl()",
      "$fileSecurity = $file.GetAccessControl()",
      "$sourceSddl = $sourceSecurity.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)",
      "$fileSddl = $fileSecurity.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)",
      "$sourceSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ListDirectory, [Security.AccessControl.AccessControlType]::Deny))",
      "$contentRights = [Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::Delete",
      "$fileSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $contentRights, [Security.AccessControl.AccessControlType]::Deny))",
      "$source.SetAccessControl($sourceSecurity)",
      "$file.SetAccessControl($fileSecurity)",
      "[ordered]@{ source = $sourceSddl; file = $fileSddl } | ConvertTo-Json -Compress",
    ].join("\r\n");
    const original = JSON.parse((await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(setup)], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
    })).stdout);
    let output: any;
    try {
      output = JSON.parse((await runCore(fixture, { overrides: successChildOverride(fixture) })).stdout);
    } finally {
      const restore = [
        `$sourceSecurity = [Security.AccessControl.DirectorySecurity]::new()`,
        `$sourceSecurity.SetSecurityDescriptorSddlForm('${escapePowerShell(original.source)}', [Security.AccessControl.AccessControlSections]::Access)`,
        `[IO.DirectoryInfo]::new('${escapePowerShell(fixture.sourcePath)}').SetAccessControl($sourceSecurity)`,
        `$fileSecurity = [Security.AccessControl.FileSecurity]::new()`,
        `$fileSecurity.SetSecurityDescriptorSddlForm('${escapePowerShell(original.file)}', [Security.AccessControl.AccessControlSections]::Access)`,
        `[IO.FileInfo]::new('${escapePowerShell(sentinel)}').SetAccessControl($fileSecurity)`,
      ].join("\r\n");
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(restore)], {
        encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true,
      });
    }
    expect(output.result).toMatchObject({ status: "PASS", category: "none", outRestored: true });
    expect(await readFile(sentinel)).toEqual(bytes);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("restores when the first rename succeeds and its boundary then throws", async () => {
    // Break caught: setting the restoration guard only after Move returns can strand out when a post-move exception is raised.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.moveDirectory = {
  param($Source, $Destination)
  $script:moveCalls.Add("$Source\`n$Destination")
  [IO.Directory]::Move($Source, $Destination)
  if ($script:moveCalls.Count -eq 1) { throw 'move-completed-then-faulted' }
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", outRestored: true });
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("settles a real surviving descendant before restoring and returns one JSON value", async () => {
    // Break caught: waiting only for the direct child permits a descendant to mutate after opaque out is restored.
    const fixture = await createFixture();
    const marker = join(fixture.root, "descendant-survived.txt");
    const helper = join(fixture.root, "spawn-descendant.cjs");
    const descendantSource = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`;
    await writeFile(helper, [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)}, ${JSON.stringify(JSON.stringify(validReceipt()))});`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' }).unref();`,
      "process.stdout.write('TOP-SECRET-CHILD-OUTPUT');",
    ].join("\n"), "utf8");
    const nativeArguments = [helper].map((value) => `'${escapePowerShell(value)}'`).join(", ");
    const raw = (await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @(${nativeArguments})
$contract['nativeChildGraceMilliseconds'] = 300`,
    })).stdout;
    const output = JSON.parse(raw);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(raw).not.toContain("TOP-SECRET-CHILD-OUTPUT");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await exists(marker)).toBe(false);
    expect(await exists(fixture.sourcePath)).toBe(true);
  }, 10_000);

  it("exposes only native child settlement metadata, never captured output", async () => {
    // Break caught: a public output-bearing native result can accidentally disclose terminal evidence through PowerShell projection.
    const command = [
      `. '${escapePowerShell(scriptPath)}'`,
      "Initialize-IntentArcPreflightNativeProcessType",
      "@([IntentArc.Preflight.NativeProcessResult].GetProperties().Name | Sort-Object) | ConvertTo-Json -Compress",
    ].join("\r\n");
    const properties = JSON.parse((await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true },
    )).stdout);
    expect(properties).toEqual([
      "AssignmentSucceeded", "Canceled", "DescendantsSettled", "ExitCode", "InfrastructureFailure", "JobName",
      "OutputOverflow", "RootProcessId", "RootStartTimeUtc", "StandardErrorBytes", "StandardOutputBytes",
      "StartAttempted", "Started", "TimedOut",
    ]);
  });

  it.each([
    {
      name: "normal exit 0",
      stdoutBytes: 0,
      exitCode: 0,
      expectedResult: { status: "PASS", category: "none", childStarted: true, childExitCode: 0, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
      writesReceipt: true,
    },
    {
      name: "normal nonzero exit",
      stdoutBytes: 0,
      stderrBytes: 23,
      exitCode: 7,
      expectedResult: { status: "FAIL", category: "preflight-failed", childStarted: true, childExitCode: 7, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 7 },
    },
    {
      name: "65537 bytes",
      stdoutBytes: 65537,
      exitCode: 0,
      expectedResult: { status: "PASS", category: "none", childStarted: true, childExitCode: 0, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
      writesReceipt: true,
    },
    {
      name: "1048576 bytes exactly",
      stdoutBytes: 1048576,
      exitCode: 0,
      expectedResult: { status: "PASS", category: "none", childStarted: true, childExitCode: 0, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
      writesReceipt: true,
    },
    {
      name: "1048577-byte output-overflow",
      stdoutBytes: 1048577,
      exitCode: 0,
      marker: true,
      expectedResult: { status: "FAIL", category: "preflight-failed", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "output-overflow", exitCode: null, outputOverflow: true },
    },
    {
      name: "1048577-byte stderr output-overflow",
      stdoutBytes: 0,
      stderrBytes: 1048577,
      exitCode: 0,
      expectedResult: { status: "FAIL", category: "preflight-failed", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "output-overflow", exitCode: null, outputOverflow: true },
    },
    {
      name: "independent stream limits whose sum exceeds 1048576",
      stdoutBytes: 600000,
      stderrBytes: 600000,
      exitCode: 0,
      writesReceipt: true,
      expectedResult: { status: "PASS", category: "none", childStarted: true, childExitCode: 0, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
    },
    {
      name: "timeout",
      stdoutBytes: 18,
      exitCode: null,
      timeoutMilliseconds: 150,
      marker: true,
      keepAlive: true,
      expectedResult: { status: "FAIL", category: "preflight-timeout", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "timeout", exitCode: null, timedOut: true },
    },
    {
      name: "pre-create cancellation",
      stdoutBytes: 0,
      exitCode: null,
      nativeFault: "pre-create-cancellation",
      marker: true,
      expectedResult: { status: "FAIL", category: "preflight-canceled", childStarted: false, childExitCode: null, outRestored: true },
      expectedChild: { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", settlementStatus: "settled", terminationReason: "canceled", exitCode: null, canceled: true },
    },
    {
      name: "post-create cancellation",
      stdoutBytes: 0,
      exitCode: null,
      nativeFault: "post-create-cancellation",
      marker: true,
      expectedResult: { status: "FAIL", category: "preflight-canceled", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "canceled", exitCode: null, canceled: true },
    },
    {
      name: "pre-create infrastructure failure",
      stdoutBytes: 0,
      exitCode: null,
      missingExecutable: true,
      expectedResult: { status: "FAIL", category: "preflight-start-failed", childStarted: false, childExitCode: null, outRestored: true },
      expectedChild: { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", settlementStatus: "settled", terminationReason: "infrastructure-failure", exitCode: null, infrastructureFailure: true },
    },
    {
      name: "post-create infrastructure failure",
      stdoutBytes: 0,
      exitCode: null,
      nativeFault: "post-create-infrastructure-failure",
      expectedResult: { status: "FAIL", category: "preflight-failed", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "infrastructure-failure", exitCode: null, infrastructureFailure: true },
    },
    {
      name: "post-create infrastructure identity-capture failure",
      stdoutBytes: 0,
      exitCode: null,
      nativeFault: "identity-capture-failure",
      expectedResult: { status: "FAIL", category: "preflight-failed", childStarted: true, childExitCode: null, outRestored: true },
      expectedChild: { rootProcessId: null, rootStartTimeUtc: null, assignmentStatus: "attempted", settlementStatus: "settled", terminationReason: "infrastructure-failure", exitCode: null, infrastructureFailure: true },
    },
    {
      name: "root descendant settlement failure",
      stdoutBytes: 0,
      exitCode: 0,
      nativeFault: "root-wait-failure",
      expectedResult: { status: "FAIL", category: "child-settlement-failed", childStarted: true, childExitCode: 0, outRestored: false },
      expectedChild: { assignmentStatus: "assigned", settlementStatus: "unsettled", terminationReason: "settlement-failed", exitCode: 0, infrastructureFailure: true },
      expectedStatePhase: "child-settled",
    },
  ])("projects the exact native child settlement tuple for $name", async (testCase) => {
    // Break caught: a wrong native flag, byte bound, precedence branch, or identity row can persist false child termination evidence.
    const fixture = await createFixture();
    const helper = join(fixture.root, "native-outcome-child.cjs");
    const marker = join(fixture.root, "native-outcome-late-marker.txt");
    const source = [
      "const fs = require('node:fs');",
      testCase.writesReceipt
        ? `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(fixture.receiptPath)}, ${JSON.stringify(JSON.stringify(validReceipt()))});`
        : "",
      testCase.stdoutBytes > 0
        ? `fs.writeSync(1, Buffer.concat([Buffer.from('TOP-SECRET'), Buffer.alloc(${testCase.stdoutBytes} - 10, 65)]));`
        : "",
      testCase.stderrBytes
        ? `fs.writeSync(2, Buffer.concat([Buffer.from('ERR-TOP-SECRET'), Buffer.alloc(${testCase.stderrBytes} - 14, 66)]));`
        : "",
      testCase.marker ? `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 1000);` : "",
      testCase.keepAlive ? "setInterval(() => {}, 10000);" : "",
      testCase.exitCode === null ? "" : `process.exitCode = ${testCase.exitCode};`,
    ].filter(Boolean).join("\n");
    await writeFile(helper, source, "utf8");
    const nativeFault = testCase.nativeFault ? `$contract['nativeFault'] = '${testCase.nativeFault}'` : "";
    const timeout = testCase.timeoutMilliseconds ? `$contract.timeoutMilliseconds = ${testCase.timeoutMilliseconds}` : "";
    const nativeExecutable = testCase.missingExecutable ? join(fixture.root, "missing-native-child.exe") : process.execPath;
    const execution = await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(nativeExecutable)}'
$contract['nativeChildArguments'] = @('${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100
${timeout}
${nativeFault}`,
      after: `$state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json
Initialize-IntentArcPreflightNativeProcessType
$settlementProven = [IntentArc.Preflight.NativeProcess]::ProveSettlement(
  [string]$state.child.jobName,
  $(if ($null -eq $state.child.rootProcessId) { 0 } else { [int]$state.child.rootProcessId }),
  [string]$state.child.rootStartTimeUtc
)
[ordered]@{ result = $result; state = $state; settlementProven = $settlementProven } | ConvertTo-Json -Depth 12 -Compress`,
    });
    const raw = execution.stdout;
    const output = JSON.parse(raw);
    expect(output.result).toMatchObject(testCase.expectedResult);
    expect(Object.keys(output.state.child).sort()).toEqual([
      "assignmentStatus", "canceled", "exitCode", "infrastructureFailure", "jobName", "outputOverflow",
      "rootProcessId", "rootStartTimeUtc", "settlementStatus", "stderrBytes", "stdoutBytes", "terminationReason", "timedOut",
    ]);
    expect(output.state.child).toMatchObject({
      jobName: `IntentArc.Preflight.${runId}.test`,
      stdoutBytes: testCase.stdoutBytes,
      stderrBytes: testCase.stderrBytes ?? 0,
      outputOverflow: false,
      timedOut: false,
      canceled: false,
      infrastructureFailure: false,
      ...testCase.expectedChild,
    });
    if (testCase.expectedChild.assignmentStatus === "assigned") {
      expect(output.state.child.rootProcessId).toBeGreaterThan(0);
      expect(output.state.child.rootStartTimeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(output.state.phase).toBe(testCase.expectedStatePhase ?? "complete");
    expect(output.settlementProven).toBe(true);
    expect(raw).not.toContain("TOP-SECRET");
    expect(execution.stderr).toBe("");
    if (testCase.marker) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await exists(marker)).toBe(false);
    }
  }, 15_000);

  it.each([
    ["child-settlement journal", 1, false],
    ["immediately-before-restoration settlement authority", 2, true],
  ])("restores through the safe path after a %s write fault", async (_name, faultAttempt, injectLaterDrift) => {
    // Break caught: a failed outcome boundary must not strand opaque out, erase durable evidence, or clean before a restored journal exists.
    const fixture = await createFixture();
    const helper = join(fixture.root, "settlement-journal-child.cjs");
    await writeFile(helper, [
      "const fs = require('node:fs');",
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)}, ${JSON.stringify(JSON.stringify(validReceipt()))});`,
    ].join("\n"), "utf8");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100
$script:settlementWriteAttempts = 0
$script:durablePhases = [System.Collections.Generic.List[string]]::new()
$script:postSettlementDrift = $false
$contract.getRepositoryState = {
  if ($script:postSettlementDrift) { [ordered]@{ branch = 'drift'; commit = '${commit}'; statusRows = @() } }
  else { [ordered]@{ branch = 'master'; commit = '${commit}'; statusRows = @() } }
}
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.phase -ceq 'child-settled') {
    $script:settlementWriteAttempts++
    if ($script:settlementWriteAttempts -eq ${faultAttempt}) {
      if ($${injectLaterDrift}) { $script:postSettlementDrift = $true }
      throw 'injected-settlement-state-write-fault'
    }
  }
}
$contract.onStateWritten = { param($State) $script:durablePhases.Add([string]$State.phase) }`,
      after: `$state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json
Initialize-IntentArcPreflightNativeProcessType
$settlementProven = [IntentArc.Preflight.NativeProcess]::ProveSettlement([string]$state.child.jobName, [int]$state.child.rootProcessId, [string]$state.child.rootStartTimeUtc)
[ordered]@{ result = $result; state = $state; phases = @($script:durablePhases); settlementWriteAttempts = $script:settlementWriteAttempts; settlementProven = $settlementProven; moveCalls = @($script:moveCalls) } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", outRestored: true });
    expect(output.settlementProven).toBe(true);
    expect(output.settlementWriteAttempts).toBe(2);
    expect(output.phases).toEqual(["prepared", "preserved", "child-started", "child-settled", "restored", "complete"]);
    expect(output.state).toMatchObject({
      phase: "complete",
      cleanup: { profileStatus: "removed", localAppDataStatus: "removed", runRootStatus: "removed", category: "none" },
      child: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
    });
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(await exists(fixture.statePath)).toBe(true);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  }, 15_000);

  it("retains owned roots when overflow evidence lacks an over-limit counter", async () => {
    // Break caught: treating writeAdvancedStateIfValid=false as durable can erase recovery roots without any valid restored authority.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = { ${testChildResultSource({ exitCode: null, outputOverflow: true })} }`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: true, outRestored: true });
    expect(output.state).toMatchObject({
      phase: "child-started",
      child: { assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "unknown" },
    });
    expect(await exists(fixture.statePath)).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(true);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("reports the durable child-settled phase when restoration fails after the first settlement write fault", async () => {
    // Break caught: a successful pre-restoration authority rewrite must advance the reported durable phase even if the rename later fails.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:settlementWriteAttempts = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.phase -ceq 'child-settled') {
    $script:settlementWriteAttempts++
    if ($script:settlementWriteAttempts -eq 1) { throw 'first-settlement-write-fault' }
  }
}
$contract.moveDirectory = {
  param($Source, $Destination)
  $script:moveCalls.Add("$Source\`n$Destination")
  if ($script:moveCalls.Count -eq 2) { throw 'restoration-rename-fault' }
  [IO.Directory]::Move($Source, $Destination)
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json; settlementWriteAttempts = $script:settlementWriteAttempts; moveCalls = @($script:moveCalls) } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-failed", phase: "child-settled", outRestored: false });
    expect(output.settlementWriteAttempts).toBe(2);
    expect(output.state).toMatchObject({
      phase: "child-settled",
      child: { assignmentStatus: "assigned", settlementStatus: "settled", terminationReason: "normal-exit", exitCode: 0 },
    });
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it("drains bounded child output without disclosure and fails closed on overflow", async () => {
    // Break caught: unread pipes can deadlock restoration, while unbounded or inherited output can corrupt the one-JSON interface.
    const fixture = await createFixture();
    const helper = join(fixture.root, "overflow-child.cjs");
    await writeFile(helper, [
      "const fs = require('node:fs');",
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)}, ${JSON.stringify(JSON.stringify(validReceipt()))});`,
      "process.stdout.write(Buffer.concat([Buffer.from('TOP-SECRET-OVERFLOW'), Buffer.alloc(1048577 - 19, 65)]));",
    ].join("\n"), "utf8");
    const raw = (await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100`,
    })).stdout;
    expect(JSON.parse(raw).result).toMatchObject({ status: "FAIL", category: "preflight-failed", childStarted: true, outRestored: true });
    expect(raw).not.toContain("TOP-SECRET-OVERFLOW");
  }, 10_000);

  it("terminates the Job promptly when output overflows before the root exits", async () => {
    // Break caught: computing overflow only after a full root wait lets an over-limit child remain active and mutate later.
    const fixture = await createFixture();
    const marker = join(fixture.root, "overflow-late-marker.txt");
    const helper = join(fixture.root, "blocking-overflow-child.cjs");
    await writeFile(helper, [
      "process.stdout.write(Buffer.alloc(1048577, 65));",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1200);`,
      "setInterval(() => {}, 10000);",
    ].join("\n"), "utf8");
    const raw = (await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract.timeoutMilliseconds = 5000
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100`,
    })).stdout;
    expect(JSON.parse(raw).result).toMatchObject({ status: "FAIL", category: "preflight-failed", childStarted: true, outRestored: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  it("normalizes overflow discovered while timeout termination drains buffered output", async () => {
    // Break caught: late drain counters must not persist output-overflow together with the subordinate timeout flag.
    const fixture = await createFixture();
    const helper = join(fixture.root, "timeout-overflow-child.cjs");
    await writeFile(helper, [
      "process.stdout.write(Buffer.alloc(1048577, 65));",
      "setInterval(() => {}, 10000);",
    ].join("\n"), "utf8");
    const execution = await runCore(fixture, {
      overrides: `$contract.invokeChild = {
  Initialize-IntentArcPreflightNativeProcessType
  $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $environment['SystemRoot'] = [Environment]::GetEnvironmentVariable('SystemRoot')
  $environment['WINDIR'] = [Environment]::GetEnvironmentVariable('WINDIR')
  $environment['ComSpec'] = [Environment]::GetEnvironmentVariable('ComSpec')
  $native = [IntentArc.Preflight.NativeProcess]::Run(
    '${escapePowerShell(process.execPath)}',
    [string[]]@('${escapePowerShell(helper)}'),
    '${escapePowerShell(fixture.repositoryRoot)}',
    $environment,
    5000,
    100,
    1048576,
    [string]$contract.jobName
  )
  $script:nativeJobName = [string]$native.JobName
  $script:nativeRootProcessId = [int]$native.RootProcessId
  $script:nativeRootStartTimeUtc = [string]$native.RootStartTimeUtc
  $native.TimedOut = $true
  $script:rawNative = [ordered]@{
    started = $native.Started
    stdoutBytes = $native.StandardOutputBytes
    outputOverflow = $native.OutputOverflow
    timedOut = $native.TimedOut
    descendantsSettled = $native.DescendantsSettled
  }
  return $native
}
$script:zeroJobMembersBeforeRestoration = $false
$contract.moveDirectory = {
  param($Source, $Destination)
  $script:moveCalls.Add("$Source\`n$Destination")
  if ($script:moveCalls.Count -eq 2) {
    $script:zeroJobMembersBeforeRestoration = [IntentArc.Preflight.NativeProcess]::ProveSettlement(
      $script:nativeJobName,
      $script:nativeRootProcessId,
      $script:nativeRootStartTimeUtc
    )
  }
  [IO.Directory]::Move($Source, $Destination)
}`,
      after: `$state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json
[ordered]@{ result = $result; state = $state; rawNative = $script:rawNative; zeroJobMembersBeforeRestoration = $script:zeroJobMembersBeforeRestoration; moveCalls = @($script:moveCalls) } | ConvertTo-Json -Depth 12 -Compress`,
    });
    const raw = execution.stdout;
    const output = JSON.parse(raw);
    expect(output.rawNative).toEqual({
      started: true,
      stdoutBytes: 1048577,
      outputOverflow: true,
      timedOut: true,
      descendantsSettled: true,
    });
    expect(output.result).toMatchObject({ status: "FAIL", category: "preflight-failed", childStarted: true, outRestored: true });
    expect(output.state.child.stdoutBytes).toBe(1048577);
    expect(output.state).toMatchObject({
      phase: "complete",
      cleanup: { profileStatus: "removed", localAppDataStatus: "removed", runRootStatus: "removed", category: "none" },
      child: {
        assignmentStatus: "assigned",
        settlementStatus: "settled",
        terminationReason: "output-overflow",
        exitCode: null,
        stdoutBytes: 1048577,
        outputOverflow: true,
        timedOut: false,
        canceled: false,
        infrastructureFailure: false,
      },
    });
    expect(output.zeroJobMembersBeforeRestoration).toBe(true);
    expect(output.moveCalls).toEqual([
      `${fixture.sourcePath}\n${fixture.destinationPath}`,
      `${fixture.destinationPath}\n${fixture.sourcePath}`,
    ]);
    expect(raw).not.toContain("state-evidence-invalid");
    expect(execution.stderr).toBe("");
  }, 10_000);

  it("inherits only the explicit stdio handle list into the native child", async () => {
    // Break caught: bInheritHandles without STARTUPINFOEX can leak unrelated inheritable controller handles.
    const fixture = await createFixture();
    const leakedHandleMarker = join(fixture.root, "unrelated-inheritable-handle.bin");
    const helper = [
      `const fs=require('fs');`,
      `try{fs.writeSync(Number(process.argv[1]),Buffer.from('LEAK'));}catch{}`,
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))},{recursive:true});`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)},${JSON.stringify(JSON.stringify(validReceipt()))});`,
    ].join("");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IntentArcTestHandleInheritance {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
}
'@
$script:unrelated = [IO.FileStream]::new('${escapePowerShell(leakedHandleMarker)}', [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
$script:unrelatedHandle = $script:unrelated.SafeFileHandle.DangerousGetHandle()
if (-not [IntentArcTestHandleInheritance]::SetHandleInformation($script:unrelatedHandle, 1, 1)) { throw 'inherit-test-setup-failed' }
$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('-e', '${escapePowerShell(helper)}', $script:unrelatedHandle.ToInt64().ToString())
$contract['nativeChildGraceMilliseconds'] = 100`,
      after: `$script:unrelated.Dispose(); [ordered]@{ result = $result } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", outRestored: true });
    expect(await readFile(leakedHandleMarker)).toEqual(Buffer.alloc(0));
  });

  it.each([
    ["assignment-failure", "preflight-start-failed", true],
    ["pre-assignment-exception", "preflight-start-failed", true],
    ["termination-failure", "child-settlement-failed", false],
    ["root-wait-failure", "child-settlement-failed", false],
  ])("handles native %s without unsafe restoration", async (nativeFault, category, outRestored) => {
    const fixture = await createFixture();
    const helper = [
      `const fs=require('fs');`,
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))},{recursive:true});`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)},${JSON.stringify(JSON.stringify(validReceipt()))});`,
    ].join("");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('-e', '${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100
$contract['nativeFault'] = '${nativeFault}'`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category, outRestored });
    expect(await exists(fixture.sourcePath)).toBe(outRestored);
    expect(await exists(fixture.destinationPath)).toBe(!outRestored);
  });

  it("keeps the native fault seam outside the public production vector", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("[IntentArc.Preflight.NativeProcess]::RunForTest");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
    expect(source).toContain("InitializeProcThreadAttributeList(attributeList, 2");
    expect(source).toContain("attributeListInitialized");
    expect(source).toMatch(/if \(\$null -ne \$TestContract -and[^\r\n]*nativeFault/);
    expect(source).not.toMatch(/New-IntentArcPreflightOutPreservationProductionContract[\s\S]{0,1600}nativeFault/);
  });

  it("does not restore when zero active descendants cannot be proven", async () => {
    // Break caught: restoring after uncertain child-tree settlement re-exposes user out to a potentially live descendant.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = {
  param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutMilliseconds)
  $script:childCalls++
  ${testChildResultSource({ descendantsSettled: false })}
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "child-settlement-failed", childStarted: true, outRestored: false });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
    expect(output.state.child).toEqual({
      jobName: `IntentArc.Preflight.${runId}.test`,
      rootProcessId: 424242,
      rootStartTimeUtc: "2026-08-31T12:00:00.0000000Z",
      assignmentStatus: "assigned",
      settlementStatus: "unsettled",
      terminationReason: "settlement-failed",
      exitCode: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputOverflow: false,
      timedOut: false,
      canceled: false,
      infrastructureFailure: true,
    });
    expect(output.state.phase).toBe("child-settled");
    expect(output.state.timestamps.childSettledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("retains out when the child boundary throws after start becomes uncertain", async () => {
    // Break caught: a WaitForExit/native-boundary exception cannot truthfully be reclassified as a definite pre-start failure.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: "$contract.invokeChild = { throw 'post-create-boundary-failure' }",
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "child-settlement-failed", childStarted: false, outRestored: false });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it("keeps child settlement failure terminal when later repository and pnpm checks drift", async () => {
    // Break caught: post-child validation must not hide the reason restoration was deliberately prohibited.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$script:repositoryChecks = 0
$contract.getRepositoryState = {
  $script:repositoryChecks++
  if ($script:repositoryChecks -ge 3) { [ordered]@{ branch = 'drift'; commit = '${commit}'; statusRows = @() } }
  else { [ordered]@{ branch = 'master'; commit = '${commit}'; statusRows = @() } }
}
$contract.invokeChild = { ${testChildResultSource({ descendantsSettled: false })} }
$contract.getPnpmSha256 = { param($Path) if ($script:repositoryChecks -ge 3) { '${"c".repeat(64)}' } else { '${pnpmHash}' } }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "child-settlement-failed", outRestored: false });
  });

  it.each([
    ["structured unsettled result", `$contract.invokeChild = { ${testChildResultSource({ descendantsSettled: false })} }`],
    ["escaped child exception", `$contract.invokeChild = { throw 'post-start-boundary-fault' }`],
  ])("keeps child settlement failure terminal after %s before outcome journaling", async (_name, childOverride) => {
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: childOverride,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "child-settlement-failed", outRestored: false });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it.each([
    ["returns false", "$false"],
    ["throws", "throw 'injected-child-absence-proof-fault'"],
  ])("recovery retains out when child absence proof %s", async (_name, proofBody) => {
    // Break caught: RestoreOnly cannot treat a retained child-started phase as proof that the prior job is gone.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    state.phase = "child-started";
    state.timestamps.childStartedAt = state.timestamps.preservedAt;
    state.child = {
      ...state.child,
      rootProcessId: null,
      rootStartTimeUtc: null,
      assignmentStatus: "attempted",
      settlementStatus: "unsettled",
      terminationReason: "unknown",
    };
    const stateBytes = JSON.stringify(state);
    await writeFile(fixture.statePath, stateBytes, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract['proveChildAbsent'] = { param($Child) ${proofBody} }`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "child-settlement-failed", cleanupCategory: "none",
      phase: "validated", outRestored: false, childStarted: false, childExitCode: null,
    });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
    expect(await readFile(fixture.statePath, "utf8")).toBe(stateBytes);
  });

  it("proves child absence without rewriting the historical child-started tuple", async () => {
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    state.phase = "child-started";
    state.timestamps.childStartedAt = state.timestamps.preservedAt;
    state.child = {
      ...state.child,
      rootProcessId: null,
      rootStartTimeUtc: null,
      assignmentStatus: "attempted",
      settlementStatus: "unsettled",
      terminationReason: "unknown",
    };
    await writeFile(fixture.statePath, JSON.stringify(state), "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: "$contract['proveChildAbsent'] = { param($Child) $true }",
    })).stdout);
    expect(output.result).toMatchObject({ status: "RECOVERED", category: "recovery-restored", phase: "complete", outRestored: true });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "complete",
      recovery: { mode: "restore-only", sourcePhase: "child-started" },
      cleanup: { profileStatus: "removed", localAppDataStatus: "removed", runRootStatus: "removed", category: "none" },
      child: { assignmentStatus: "attempted", settlementStatus: "unsettled", terminationReason: "unknown" },
    });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("recovery proves the named job absent for host loss before PID journaling", async () => {
    // Break caught: host loss inside NativeProcess.Run can retain child-started with the deterministic job name but no returned PID yet.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    state.phase = "child-started";
    state.timestamps.childStartedAt = state.timestamps.preservedAt;
    state.child = {
      ...state.child,
      assignmentStatus: "attempted",
      settlementStatus: "unsettled",
      terminationReason: "unknown",
    };
    await writeFile(fixture.statePath, JSON.stringify(state), "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: "$contract['proveChildAbsent'] = { param($Child) $false }",
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "child-settlement-failed", outRestored: false });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it("uses a bound direct Git boundary with sanitized configuration and bounded output", async () => {
    // Break caught: ambient `git`, PATH, GIT_DIR, or hostile global fsmonitor configuration can redirect repository validation.
    const source = await readFile(scriptPath, "utf8");
    expect(source).not.toMatch(/&\s+git(?:\.exe)?\b/i);
    expect(source).toContain("core.fsmonitor=false");
    expect(source).toContain("CREATE_SUSPENDED");
    expect(source).toContain("BuildEnvironment");
    expect(source).toContain("GIT_CONFIG_NOSYSTEM");
  });

  it("ignores ambient Git redirection and PATH substitution at the real bound boundary", async () => {
    // Break caught: source-shape assertions alone cannot prove hostile GIT_* and PATH values are absent from CreateProcessW.
    const fixture = await createFixture();
    const gitExecutable = (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command git.exe -CommandType Application | Select-Object -First 1).Source"], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    })).stdout.trim();
    const gitSha256 = createHash("sha256").update(await readFile(gitExecutable)).digest("hex");
    await writeFile(join(fixture.repositoryRoot, "tracked.txt"), "tracked\n", "utf8");
    const git = (args: string[]) => execFileAsync(gitExecutable, args, {
      cwd: fixture.repositoryRoot,
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    await git(["init", "-b", "master"]);
    await git(["add", "tracked.txt"]);
    await git(["-c", "user.name=IntentArc Test", "-c", "user.email=test@intentarc.invalid", "commit", "-m", "fixture"]);
    const actualCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const poisonBin = join(fixture.root, "poison-bin");
    const poisonConfig = join(fixture.root, "poison.gitconfig");
    await mkdir(poisonBin);
    await writeFile(join(poisonBin, "git.cmd"), "@echo TOP-SECRET-POISON-GIT\r\n@exit /b 0\r\n", "utf8");
    await writeFile(poisonConfig, "[core]\n\tfsmonitor = poison-command\n", "utf8");
    const argumentsVector = [
      "'-Execute'", "'-ExpectedCommit'", `'${actualCommit}'`, "'-PnpmExecutable'",
      `'${escapePowerShell(fixture.pnpmExecutable)}'`, "'-ExpectedPnpmSha256'", `'${pnpmHash}'`,
    ].join(", ");
    const raw = (await runCore(fixture, {
      argumentsVector,
      overrides: `${successChildOverride(fixture)}
$contract.Remove('getRepositoryState')
$contract.branch = 'master'
$contract['gitExecutable'] = '${escapePowerShell(gitExecutable)}'
$contract['gitDirectory'] = '${escapePowerShell(dirname(gitExecutable))}'
$contract['gitSha256'] = '${gitSha256}'`,
      env: {
        PATH: `${poisonBin};${process.env.PATH ?? ""}`,
        GIT_DIR: join(fixture.root, "redirected.git"),
        GIT_WORK_TREE: join(fixture.root, "redirected-worktree"),
        GIT_CONFIG_GLOBAL: poisonConfig,
      },
    })).stdout;
    expect(JSON.parse(raw).result).toMatchObject({ status: "PASS", category: "none", outRestored: true });
    expect(raw).not.toContain("TOP-SECRET-POISON-GIT");
  }, 20_000);

  it("threads the exact Git binding into the child evidence gateway", async () => {
    // Break caught: sanitizing only the controller's Git calls leaves the preflight evidence checks vulnerable to ambient `git`.
    const fixture = await createFixture();
    const gitExecutable = (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command git.exe -CommandType Application | Select-Object -First 1).Source"], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    })).stdout.trim();
    const gitSha256 = createHash("sha256").update(await readFile(gitExecutable)).digest("hex");
    const git = (args: string[]) => execFileAsync(gitExecutable, args, {
      cwd: fixture.repositoryRoot,
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    await git(["init", "-b", "master"]);
    const previous = {
      executable: process.env.INTENTARC_PREFLIGHT_GIT_EXECUTABLE,
      sha256: process.env.INTENTARC_PREFLIGHT_GIT_SHA256,
      gitDir: process.env.GIT_DIR,
      global: process.env.GIT_CONFIG_GLOBAL,
    };
    process.env.INTENTARC_PREFLIGHT_GIT_EXECUTABLE = gitExecutable;
    process.env.INTENTARC_PREFLIGHT_GIT_SHA256 = gitSha256;
    process.env.GIT_DIR = join(fixture.root, "redirected.git");
    process.env.GIT_CONFIG_GLOBAL = join(fixture.root, "missing-hostile-config");
    try {
      const evidence = await import("../../../scripts/desktop-release-preflight-evidence.mjs");
      await expect(evidence.runReadOnlyGitGates({ packageRoot: fixture.repositoryRoot, statusScope: "tracked-only" })).resolves.toEqual({
        diffCheckPassed: true,
        productDiffClean: true,
        statusClean: true,
        statusEntryCount: 0,
      });
    } finally {
      for (const [name, value] of Object.entries({
        INTENTARC_PREFLIGHT_GIT_EXECUTABLE: previous.executable,
        INTENTARC_PREFLIGHT_GIT_SHA256: previous.sha256,
        GIT_DIR: previous.gitDir,
        GIT_CONFIG_GLOBAL: previous.global,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 20_000);

  it("binds lifecycle Node ahead of malicious pnpm siblings and node_modules bins", async () => {
    // Break caught: npm lifecycle PATH injection must not select an attacker-controlled node.cmd over the frozen node.exe.
    const fixture = await createFixture();
    const marker = join(fixture.root, "malicious-node-selected.txt");
    const statusPath = join(fixture.root, "node-resolution-status.txt");
    const repositoryBin = join(fixture.repositoryRoot, "node_modules", ".bin");
    await mkdir(repositoryBin, { recursive: true });
    const poison = `@echo off\r\n>"${marker}" echo poison\r\nexit /b 91\r\n`;
    await writeFile(join(dirname(fixture.pnpmExecutable), "node.cmd"), poison, "utf8");
    await writeFile(join(repositoryBin, "node.cmd"), poison, "utf8");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const inner = [
      `if (process.execPath.toLowerCase() !== process.env.NODE.toLowerCase()) process.exit(81);`,
      `if (process.execPath.toLowerCase() !== process.env.npm_node_execpath.toLowerCase()) process.exit(82);`,
    ].join("");
    const helper = [
      `const {spawnSync}=require('child_process');`,
      `const child=spawnSync('node',['-e',${JSON.stringify(inner)}],{stdio:'inherit',env:process.env});`,
      `require('fs').writeFileSync(${JSON.stringify(statusPath)},String(child.status)+':'+String(child.error&&child.error.message));`,
      `if(child.status===0){require('fs').mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))},{recursive:true});require('fs').writeFileSync(${JSON.stringify(fixture.receiptPath)},${JSON.stringify(JSON.stringify(validReceipt()))});}`,
      `process.exit(child.status === null ? 83 : child.status);`,
    ].join("");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract['nodeExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nodeDirectory'] = '${escapePowerShell(dirname(process.execPath))}'
$contract['nodeSha256'] = '${nodeSha256}'
$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('-e', '${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100`,
    })).stdout);
    expect(await readFile(statusPath, "utf8")).toBe("0:undefined");
    expect(await exists(fixture.receiptPath)).toBe(true);
    expect(JSON.parse(await readFile(fixture.receiptPath, "utf8"))).toEqual(validReceipt());
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(await exists(marker)).toBe(false);
  });

  it("routes exact APPDATA and profile variables while holding both owned roots", async () => {
    // Break caught: omitting APPDATA or routing any profile variable outside the two guarded leaves exposes ambient user configuration.
    const fixture = await createFixture();
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const observation = join(fixture.root, "child-profile-observation.json");
    const movedProfile = join(fixture.root, "moved-child-profile");
    const movedLocalAppData = join(fixture.root, "moved-child-localappdata");
    const helper = [
      `const fs=require('fs');`,
      `const path=require('path');`,
      `const profile=${JSON.stringify(fixture.childProfilePath)};`,
      `const localapp=${JSON.stringify(fixture.childLocalAppDataPath)};`,
      `const roaming=${JSON.stringify(fixture.childRoamingAppDataPath)};`,
      `const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();`,
      `if(!same(process.env.APPDATA,roaming))process.exit(80);`,
      `if(!same(process.env.HOME,profile)||!same(process.env.USERPROFILE,profile))process.exit(81);`,
      `if(!fs.lstatSync(profile).isDirectory()||fs.readdirSync(profile).length!==0)process.exit(82);`,
      `let held=false;try{fs.renameSync(profile,${JSON.stringify(movedProfile)});}catch{held=true;}if(!held)process.exit(83);`,
      `const localEntries=fs.readdirSync(localapp);if(!same(process.env.LOCALAPPDATA,localapp)||!fs.lstatSync(localapp).isDirectory()||localEntries.length!==1||localEntries[0].toLowerCase()!=='roaming'||!fs.lstatSync(path.join(localapp,localEntries[0])).isDirectory())process.exit(84);`,
      `let localHeld=false;try{fs.renameSync(localapp,${JSON.stringify(movedLocalAppData)});}catch{localHeld=true;}if(!localHeld)process.exit(85);`,
      `fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({appdata:process.env.APPDATA,home:process.env.HOME,profile:process.env.USERPROFILE,localapp:process.env.LOCALAPPDATA,held,localHeld}));`,
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))},{recursive:true});`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)},${JSON.stringify(JSON.stringify(validReceipt()))});`,
    ].join("");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract['nodeExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nodeDirectory'] = '${escapePowerShell(dirname(process.execPath))}'
$contract['nodeSha256'] = '${nodeSha256}'
$contract.Remove('invokeChild')
$contract['useNativeChild'] = $true
$contract['nativeChildExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nativeChildArguments'] = @('-e', '${escapePowerShell(helper)}')
$contract['nativeChildGraceMilliseconds'] = 100`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(JSON.parse(await readFile(observation, "utf8"))).toEqual({
      appdata: fixture.childRoamingAppDataPath,
      home: fixture.childProfilePath,
      profile: fixture.childProfilePath,
      localapp: fixture.childLocalAppDataPath,
      held: true,
      localHeld: true,
    });
    expect(await exists(fixture.childLocalAppDataPath)).toBe(false);
    expect(await exists(fixture.childProfilePath)).toBe(false);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("transfers each held owned-root guard into its exact cleanup boundary", async () => {
    // Break caught: disposing both guards before cleanup lets either exact owned-root path be replaced between authority validation and deletion.
    const fixture = await createFixture();
    const escapedLocal = `${fixture.childLocalAppDataPath}.escaped`;
    const escapedProfile = `${fixture.childProfilePath}.escaped`;
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:ownedRootCleanupHandoffs = [Collections.Generic.List[object]]::new()
$contract.beforeOwnedLocalAppDataCleanup = {
  param($Guard)
  $held = $false
  try { [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(escapedLocal)}') } catch { $held = $true }
  $script:ownedRootCleanupHandoffs.Add([ordered]@{
    root = 'localAppData'
    held = $held
    identity = [string]$Guard.Identity
    profilePresent = [IO.Directory]::Exists('${escapePowerShell(fixture.childProfilePath)}')
  })
}
$contract.beforeOwnedProfileCleanup = {
  param($Guard)
  $held = $false
  try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(escapedProfile)}') } catch { $held = $true }
  $script:ownedRootCleanupHandoffs.Add([ordered]@{
    root = 'profile'
    held = $held
    identity = [string]$Guard.Identity
    localAppDataAbsent = -not [IO.Directory]::Exists('${escapePowerShell(fixture.childLocalAppDataPath)}')
  })
}`,
      after: `[ordered]@{ result = $result; handoffs = @($script:ownedRootCleanupHandoffs) } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", outRestored: true });
    expect(output.handoffs).toMatchObject([
      { root: "profile", held: true, identity: expect.stringMatching(/^[a-f0-9]{8}:[a-f0-9]{16}$/), localAppDataAbsent: false },
      { root: "localAppData", held: true, identity: expect.stringMatching(/^[a-f0-9]{8}:[a-f0-9]{16}$/), profilePresent: false },
    ]);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(false);
    expect(await exists(fixture.childProfilePath)).toBe(false);
  });

  it("retains the still-held local owned root when its cleanup handoff faults", async () => {
    // Break caught: a second-root cleanup fault must keep that guard authoritative while durably projecting the already-removed first root.
    const fixture = await createFixture();
    const releasedLocal = `${fixture.childLocalAppDataPath}.released`;
    const releasedProfile = `${fixture.childProfilePath}.released`;
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:localHeldAtCleanupFault = $false
$contract.beforeOwnedLocalAppDataCleanup = {
  param($Guard)
  try { [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(fixture.childLocalAppDataPath)}.escaped') } catch { $script:localHeldAtCleanupFault = $true }
  throw 'owned-root-cleanup-boundary-fault'
}`,
      after: `$localReleased = $false
$profileReleased = $false
try { [IO.Directory]::Move('${escapePowerShell(fixture.childLocalAppDataPath)}', '${escapePowerShell(releasedLocal)}'); $localReleased = $true } catch { }
try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(releasedProfile)}'); $profileReleased = $true } catch { }
[ordered]@{ result = $result; heldAtFault = $script:localHeldAtCleanupFault; localReleased = $localReleased; profileReleased = $profileReleased; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid", outRestored: true });
    expect(output).toMatchObject({ heldAtFault: true, localReleased: true, profileReleased: false });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "invalid", profileStatus: "removed", runRootStatus: "retained", category: "residue-invalid",
    });
  });

  it("removes ordinary descendants after profile mutation in an owned root", async () => {
    // Break caught: comparing captured timestamps or using an empty-only profile delete rejects expected child-owned profile mutation.
    const fixture = await createFixture();
    const nested = join(fixture.childProfilePath, "cache", "child-owned-residue.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[Threading.Thread]::Sleep(1100)
[IO.Directory]::CreateDirectory('${escapePowerShell(dirname(nested))}') | Out-Null
 [IO.File]::WriteAllBytes('${escapePowerShell(nested)}', [byte[]]@(9, 0, 237, 4))`)}
$script:profileLastWriteBefore = $null
$script:profileTimestampChanged = $false
$contract.beforePreparedStateWrite = {
  param($State)
  $script:profileLastWriteBefore = [IO.Directory]::GetLastWriteTimeUtc('${escapePowerShell(fixture.childProfilePath)}')
}
$contract.beforeOwnedProfileCleanup = {
  param($Guard)
  $script:profileTimestampChanged = [IO.Directory]::GetLastWriteTimeUtc('${escapePowerShell(fixture.childProfilePath)}') -ne $script:profileLastWriteBefore
}`,
      after: `[ordered]@{ result = $result; profileTimestampChanged = $script:profileTimestampChanged } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(output.profileTimestampChanged).toBe(true);
    expect(await exists(nested)).toBe(false);
    expect(await exists(fixture.childProfilePath)).toBe(false);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("removes ordinary descendants and junctions under both owned roots without touching external sentinels", async () => {
    // Break caught: following either reparse descendant, or cleaning only local app data, can erase external data or strand profile residue.
    const fixture = await createFixture();
    const localOwned = join(fixture.childLocalAppDataPath, "cache", "pnpm-owned-residue.bin");
    const profileOwned = join(fixture.childProfilePath, "cache", "profile-owned-residue.bin");
    const outsideLocal = join(fixture.root, "outside-localapp-target");
    const outsideProfile = join(fixture.root, "outside-profile-target");
    const outsideLocalSentinel = join(outsideLocal, "must-survive.bin");
    const outsideProfileSentinel = join(outsideProfile, "must-survive.bin");
    const localJunction = join(fixture.childLocalAppDataPath, "escape-junction");
    const profileJunction = join(fixture.childProfilePath, "escape-junction");
    const outsideLocalBytes = Buffer.from([31, 0, 199, 7]);
    const outsideProfileBytes = Buffer.from([41, 0, 201, 8]);
    await mkdir(outsideLocal);
    await mkdir(outsideProfile);
    await writeFile(outsideLocalSentinel, outsideLocalBytes);
    await writeFile(outsideProfileSentinel, outsideProfileBytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(dirname(localOwned))}') | Out-Null
[IO.Directory]::CreateDirectory('${escapePowerShell(dirname(profileOwned))}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(localOwned)}', [byte[]]@(10, 0, 238, 5))
[IO.File]::WriteAllBytes('${escapePowerShell(profileOwned)}', [byte[]]@(11, 0, 239, 6))
New-Item -ItemType Junction -Path '${escapePowerShell(localJunction)}' -Target '${escapePowerShell(outsideLocal)}' -ErrorAction Stop | Out-Null
New-Item -ItemType Junction -Path '${escapePowerShell(profileJunction)}' -Target '${escapePowerShell(outsideProfile)}' -ErrorAction Stop | Out-Null`),
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(await exists(localOwned)).toBe(false);
    expect(await exists(profileOwned)).toBe(false);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(false);
    expect(await exists(fixture.childProfilePath)).toBe(false);
    expect(await readFile(outsideLocalSentinel)).toEqual(outsideLocalBytes);
    expect(await readFile(outsideProfileSentinel)).toEqual(outsideProfileBytes);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it.each(["directory", "file", "junction"])("marks a %s owned root replacement after identity capture invalid", async (kind) => {
    // Break caught: deleting a replacement at the captured profile path transfers durable cleanup authority to an attacker-controlled entry.
    const fixture = await createFixture();
    const capturedProfile = join(fixture.root, `captured-profile-${kind}`);
    const outsideTarget = join(fixture.root, `outside-profile-${kind}`);
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const replacementMarker = join(fixture.childProfilePath, "replacement-marker.bin");
    const outsideBytes = Buffer.from([51, 0, 203, 9]);
    await mkdir(outsideTarget);
    await writeFile(outsideSentinel, outsideBytes);
    const replacement = kind === "directory"
      ? `[IO.Directory]::CreateDirectory('${escapePowerShell(fixture.childProfilePath)}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(replacementMarker)}', [byte[]]@(1, 3, 5, 7))`
      : kind === "file"
        ? `[IO.File]::WriteAllBytes('${escapePowerShell(fixture.childProfilePath)}', [byte[]]@(2, 4, 6, 8))`
        : `New-Item -ItemType Junction -Path '${escapePowerShell(fixture.childProfilePath)}' -Target '${escapePowerShell(outsideTarget)}' -ErrorAction Stop | Out-Null`;
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.afterOwnedRootGuardRelease = {
  param($Path)
  if ($Path -ine '${escapePowerShell(fixture.childProfilePath)}') { return }
  [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(capturedProfile)}')
  ${replacement}
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state).toMatchObject({
      phase: "complete",
      cleanup: { profileStatus: "invalid", localAppDataStatus: "removed", runRootStatus: "retained", category: "residue-invalid" },
    });
    expect(await exists(capturedProfile)).toBe(true);
    if (kind === "directory") expect(await readFile(replacementMarker)).toEqual(Buffer.from([1, 3, 5, 7]));
    if (kind === "file") expect(await readFile(fixture.childProfilePath)).toEqual(Buffer.from([2, 4, 6, 8]));
    if (kind === "junction") expect((await lstat(fixture.childProfilePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
  });

  it("marks an owned root missing before cleanup invalid", async () => {
    // Break caught: absence before handle-authorized deletion is not evidence that the controller removed its captured root.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.afterOwnedRootGuardRelease = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.childProfilePath)}') { [IO.Directory]::Delete($Path, $false) }
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "invalid", runRootStatus: "retained", category: "residue-invalid",
    });
    expect(await exists(fixture.childProfilePath)).toBe(false);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("retains an owned root when a no-share handle blocks the authorized DELETE open after identity recheck", async () => {
    // Break caught: mapping a deletion-only sharing conflict to invalid misstates a determinate same-object boundary; falling back would delete it.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
${directoryHandleHelperSource}
$script:indeterminateOwnedHandle = [IntPtr]::Zero
$contract.afterOwnedRootGuardRelease = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.childProfilePath)}') {
    $script:indeterminateOwnedHandle = [IntentArc.Preflight.TestDirectoryHandle]::OpenDeleteBlocking($Path)
  }
}`,
      after: `$ownedPresentBeforeClose = [IO.Directory]::Exists('${escapePowerShell(fixture.childProfilePath)}')
[IntentArc.Preflight.TestDirectoryHandle]::Close($script:indeterminateOwnedHandle)
$ownedPresentAfterClose = [IO.Directory]::Exists('${escapePowerShell(fixture.childProfilePath)}')
[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json; presentBeforeClose = $ownedPresentBeforeClose; presentAfterClose = $ownedPresentAfterClose } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toMatchObject({ profileStatus: "retained", localAppDataStatus: "removed", runRootStatus: "retained" });
    expect(output.presentAfterClose).toBe(true);
    expect(await exists(fixture.childProfilePath)).toBe(true);
  });

  it("retains an owned root while a deletion-blocking handle remains open", async () => {
    // Break caught: falling back to path deletion after a DELETE-sharing failure bypasses the validated handle boundary.
    const fixture = await createFixture();
    const marker = join(fixture.childProfilePath, "must-remain.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.File]::WriteAllBytes('${escapePowerShell(marker)}', [byte[]]@(71, 0, 17, 2))`)}
${directoryHandleHelperSource}
$script:ownedDeletionBlocker = [IntPtr]::Zero
$contract.beforeOwnedProfileCleanup = {
  param($Guard)
    $script:ownedDeletionBlocker = [IntentArc.Preflight.DirectoryComponentGuard]::Open('${escapePowerShell(fixture.childProfilePath)}')
}`,
      after: `$script:ownedDeletionBlocker.Dispose()
[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toMatchObject({ profileStatus: "retained", localAppDataStatus: "removed", runRootStatus: "retained" });
    expect(await readFile(marker)).toEqual(Buffer.from([71, 0, 17, 2]));
  });

  it("removes an owned root after its deletion-blocking handle is released before cleanup", async () => {
    // Break caught: treating any historical sharing conflict as permanent can retain a root after current handle authority is available.
    const fixture = await createFixture();
    const marker = join(fixture.childProfilePath, "released", "remove-me.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(dirname(marker))}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(marker)}', [byte[]]@(72, 0, 18, 3))`)}
$script:releasedOwnedBlocker = $false
$contract.beforeOwnedProfileCleanup = {
  param($Guard)
  $temporaryGuard = [IntentArc.Preflight.DirectoryComponentGuard]::Open('${escapePowerShell(fixture.childProfilePath)}')
  try {
    try { [IO.Directory]::Move('${escapePowerShell(fixture.childProfilePath)}', '${escapePowerShell(fixture.childProfilePath)}.blocked') }
    catch { $script:releasedOwnedBlocker = $true }
  } finally { $temporaryGuard.Dispose() }
}`,
      after: `[ordered]@{ result = $result; released = $script:releasedOwnedBlocker; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", phase: "complete", outRestored: true });
    expect(output.released).toBe(true);
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "removed", category: "none",
    });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("blocks a child swap after the no-delete-share cleanup handle opens", async () => {
    // Break caught: releasing the validated child handle before same-handle disposition reopens a path-swap window.
    const fixture = await createFixture();
    const child = join(fixture.childProfilePath, "held-child");
    const escaped = join(fixture.root, "escaped-held-child");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(child)}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(join(child, "remove-me.bin"))}', [byte[]]@(3, 1, 4, 1))`)}
$script:validatedChildSwapBlocked = $false
$contract.afterOwnedChildOpen = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(child)}') {
    try { [IO.Directory]::Move('${escapePowerShell(child)}', '${escapePowerShell(escaped)}') }
    catch { $script:validatedChildSwapBlocked = $true }
  }
}`,
      after: `[ordered]@{ result = $result; swapBlocked = $script:validatedChildSwapBlocked } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", phase: "complete", outRestored: true });
    expect(output.swapBlocked).toBe(true);
    expect(await exists(escaped)).toBe(false);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("blocks in-place junction conversion after the validated child handle opens", async () => {
    // Break caught: write-sharing a validated empty directory lets a reparse point appear before path enumeration follows it.
    const fixture = await createFixture();
    const child = join(fixture.childProfilePath, "in-place-child");
    const outsideTarget = join(fixture.root, "outside-in-place-target");
    const controlDirectory = join(fixture.root, "in-place-positive-control");
    const controlTarget = join(fixture.root, "outside-in-place-control-target");
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const controlSentinel = join(controlTarget, "must-also-survive.bin");
    const outsideBytes = Buffer.from([93, 0, 211, 12]);
    const controlBytes = Buffer.from([94, 0, 212, 13]);
    await mkdir(outsideTarget);
    await mkdir(controlDirectory);
    await mkdir(controlTarget);
    await writeFile(outsideSentinel, outsideBytes);
    await writeFile(controlSentinel, controlBytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(child)}') | Out-Null`)}
${inPlaceJunctionHelperSource}
$script:inPlacePositiveControlApplied = [IntentArc.Preflight.TestInPlaceJunction]::TryCreate(
  '${escapePowerShell(controlDirectory)}', '${escapePowerShell(controlTarget)}')
$script:inPlaceJunctionApplied = $false
$contract.afterOwnedChildOpen = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(child)}') {
    $script:inPlaceJunctionApplied = [IntentArc.Preflight.TestInPlaceJunction]::TryCreate(
      '${escapePowerShell(child)}', '${escapePowerShell(outsideTarget)}')
  }
}`,
      after: `[ordered]@{ result = $result; positiveControlApplied = $script:inPlacePositiveControlApplied; junctionApplied = $script:inPlaceJunctionApplied } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", phase: "complete", outRestored: true });
    expect(output.positiveControlApplied).toBe(true);
    expect(output.junctionApplied).toBe(false);
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
    expect(await readFile(controlSentinel)).toEqual(controlBytes);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("retains an owned root when a concurrent child appears before final disposition", async () => {
    // Break caught: retrying or recursively sweeping a concurrent addition turns a bounded post-order pass into an unbounded deletion loop.
    const fixture = await createFixture();
    const concurrent = join(fixture.childProfilePath, "concurrent-addition.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:concurrentOwnedAddition = $false
$contract.beforeOwnedRootDisposition = {
  param($Path)
  if (-not $script:concurrentOwnedAddition -and $Path -ieq '${escapePowerShell(fixture.childProfilePath)}') {
    [IO.File]::WriteAllBytes('${escapePowerShell(concurrent)}', [byte[]]@(91, 0, 19, 4))
    $script:concurrentOwnedAddition = $true
  }
}`,
      after: `[ordered]@{ result = $result; added = $script:concurrentOwnedAddition; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.added).toBe(true);
    expect(output.state.cleanup).toMatchObject({ profileStatus: "retained", localAppDataStatus: "removed", runRootStatus: "retained" });
    expect(await readFile(concurrent)).toEqual(Buffer.from([91, 0, 19, 4]));
  });

  it("revalidates a cleanup race that swaps an enumerated ordinary child to a junction", async () => {
    // Break caught: deleting an enumerated child by its stale path can follow a post-enumeration junction into an external target.
    const fixture = await createFixture();
    const raceChild = join(fixture.childProfilePath, "race-child");
    const escapedOriginal = join(fixture.root, "escaped-race-child");
    const escapedOriginalMarker = join(escapedOriginal, "ordinary.bin");
    const outsideTarget = join(fixture.root, "outside-race-target");
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const outsideBytes = Buffer.from([61, 0, 205, 10]);
    await mkdir(outsideTarget);
    await writeFile(outsideSentinel, outsideBytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(raceChild)}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(join(raceChild, "ordinary.bin"))}', [byte[]]@(8, 6, 4, 2))`)}
$script:cleanupRaceApplied = $false
$contract.beforeOwnedChildOpen = {
  param($Path)
  if (-not $script:cleanupRaceApplied -and $Path -ieq '${escapePowerShell(raceChild)}') {
    [IO.Directory]::Move('${escapePowerShell(raceChild)}', '${escapePowerShell(escapedOriginal)}')
    New-Item -ItemType Junction -Path '${escapePowerShell(raceChild)}' -Target '${escapePowerShell(outsideTarget)}' -ErrorAction Stop | Out-Null
    $script:cleanupRaceApplied = $true
  }
}`,
      after: `[ordered]@{ result = $result; raceApplied = $script:cleanupRaceApplied; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.raceApplied).toBe(true);
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "retained", runRootStatus: "retained", category: "residue-invalid",
    });
    expect(await readFile(escapedOriginalMarker)).toEqual(Buffer.from([8, 6, 4, 2]));
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
    expect((await lstat(raceChild)).isSymbolicLink()).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("blocks an enumerated ordinary child replacement while its owned root is pinned", async () => {
    // Break caught: write/delete sharing on the pinned root permits a different same-type object to replace an enumerated child.
    const fixture = await createFixture();
    const raceChild = join(fixture.childProfilePath, "same-type-race-child");
    const escapedOriginal = join(fixture.root, "escaped-same-type-child");
    const outsideTarget = join(fixture.root, "outside-same-type-target");
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const outsideBytes = Buffer.from([95, 0, 213, 13]);
    const swapHelperPath = join(fixture.root, "held-directory-swap-helper.ps1");
    await mkdir(outsideTarget);
    await writeFile(outsideSentinel, outsideBytes);
    await writeFile(swapHelperPath, heldDirectorySwapHelperSource, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture, `[IO.Directory]::CreateDirectory('${escapePowerShell(raceChild)}') | Out-Null`)}
. '${escapePowerShell(swapHelperPath)}'
$script:sameTypeRaceApplied = $false
$script:sameTypeSessionOpened = $false
$script:sameTypeBeforeOpenSeen = $false
$script:sameTypeSwapError = $null
$script:sameTypeSeenPaths = [System.Collections.Generic.List[string]]::new()
$script:sameTypeSwap = $null
$contract.beforeOwnedProfileCleanup = {
  param($Guard)
  $script:sameTypeSwap = [IntentArc.Preflight.TestHeldDirectorySwap]::new(
    '${escapePowerShell(raceChild)}', '${escapePowerShell(escapedOriginal)}', '${escapePowerShell(outsideTarget)}')
  $script:sameTypeSessionOpened = $true
}
$contract.beforeOwnedChildOpen = {
  param($Path)
  $script:sameTypeBeforeOpenSeen = $true
  $script:sameTypeSeenPaths.Add([string]$Path)
  if (-not $script:sameTypeRaceApplied -and $Path -ieq '${escapePowerShell(raceChild)}') {
    try {
      $script:sameTypeSwap.Swap()
      $script:sameTypeRaceApplied = $true
    } catch {
      $script:sameTypeSwapError = $_.Exception.ToString()
    }
  }
}`,
      after: `if ($null -ne $script:sameTypeSwap) { $script:sameTypeSwap.Dispose() }
[ordered]@{ result = $result; raceApplied = $script:sameTypeRaceApplied; sessionOpened = $script:sameTypeSessionOpened; beforeOpenSeen = $script:sameTypeBeforeOpenSeen; swapError = $script:sameTypeSwapError; seenPaths = @($script:sameTypeSeenPaths); state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.seenPaths).toContain(raceChild);
    expect(output.swapError).toContain("native-rename-status:c0000043");
    expect(output).toMatchObject({ sessionOpened: true, beforeOpenSeen: true, raceApplied: false });
    expect(output.state.cleanup).toMatchObject({ profileStatus: "retained", localAppDataStatus: "removed", runRootStatus: "retained" });
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("blocks in-place run-root junction conversion on the validated disposition handle", async () => {
    // Break caught: write-sharing the nonrecursive run-root handle leaves a reparse conversion window before same-handle disposition.
    const fixture = await createFixture();
    const outsideTarget = join(fixture.root, "outside-run-root-in-place-target");
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const controlDirectory = join(fixture.root, "run-root-in-place-positive-control");
    const controlTarget = join(fixture.root, "outside-run-root-in-place-control-target");
    const controlSentinel = join(controlTarget, "must-also-survive.bin");
    const outsideBytes = Buffer.from([97, 0, 215, 14]);
    const controlBytes = Buffer.from([98, 0, 216, 15]);
    await mkdir(outsideTarget);
    await mkdir(controlDirectory);
    await mkdir(controlTarget);
    await writeFile(outsideSentinel, outsideBytes);
    await writeFile(controlSentinel, controlBytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
${inPlaceJunctionHelperSource}
$script:runRootPositiveControlApplied = [IntentArc.Preflight.TestInPlaceJunction]::TryCreate(
  '${escapePowerShell(controlDirectory)}', '${escapePowerShell(controlTarget)}')
$script:runRootCleanupHookSeen = $false
$script:runRootDispositionState = [pscustomobject]@{ Seen = $false; JunctionApplied = $false }
$contract.beforeRunRootDisposition = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.runRoot)}') {
    $script:runRootDispositionState.Seen = $true
    $script:runRootDispositionState.JunctionApplied = [IntentArc.Preflight.TestInPlaceJunction]::TryCreate(
      '${escapePowerShell(fixture.runRoot)}', '${escapePowerShell(outsideTarget)}')
  }
}
$contract.beforeRunRootCleanup = {
  $script:runRootCleanupHookSeen = $true
}`,
      after: `$callbackCleared = $null -eq [IntentArc.Preflight.OwnedDirectoryCleaner]::BeforeRootDispositionForTest
[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json; positiveControlApplied = $script:runRootPositiveControlApplied; cleanupHookSeen = $script:runRootCleanupHookSeen; callbackCleared = $callbackCleared; dispositionSeen = $script:runRootDispositionState.Seen; junctionApplied = $script:runRootDispositionState.JunctionApplied } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", phase: "complete", outRestored: true });
    expect(output).toMatchObject({ positiveControlApplied: true, cleanupHookSeen: true, callbackCleared: true, dispositionSeen: true, junctionApplied: false });
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
    expect(await readFile(controlSentinel)).toEqual(controlBytes);
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("marks a run root missing before cleanup invalid after both owned removals", async () => {
    // Break caught: projecting a preexisting absence as removed forges controller ownership of the terminal run-root transition.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.beforeRunRootCleanup = { [IO.Directory]::Delete('${escapePowerShell(fixture.runRoot)}', $false) }`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "invalid", category: "residue-invalid",
    });
    expect(await exists(fixture.runRoot)).toBe(false);
  });

  it("marks the run root invalid when destination reappears after both owned removals", async () => {
    // Break caught: ignoring destination absence can delete the run root around a replacement at the preserved-out path.
    const fixture = await createFixture();
    const replacementMarker = join(fixture.destinationPath, "replacement-must-remain.bin");
    const replacementBytes = Buffer.from([97, 0, 215, 14]);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.beforeOwnedLocalAppDataCleanup = {
  param($Guard)
  [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.destinationPath)}') | Out-Null
  [IO.File]::WriteAllBytes('${escapePowerShell(replacementMarker)}', [byte[]]@(97, 0, 215, 14))
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "invalid", category: "residue-invalid",
    });
    expect(await readFile(replacementMarker)).toEqual(replacementBytes);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it.each(["directory", "junction"])("marks a %s run root replacement invalid", async (kind) => {
    // Break caught: an exact-path nonrecursive delete must not remove a runRoot replacement introduced after both owned roots are gone.
    const fixture = await createFixture();
    const capturedRunRoot = join(fixture.root, `captured-run-root-${kind}`);
    const outsideTarget = join(fixture.root, `outside-run-root-${kind}`);
    const outsideSentinel = join(outsideTarget, "must-survive.bin");
    const replacementMarker = join(fixture.runRoot, "replacement-marker.bin");
    const outsideBytes = Buffer.from([81, 0, 207, 11]);
    await mkdir(outsideTarget);
    await writeFile(outsideSentinel, outsideBytes);
    const replacement = kind === "directory"
      ? `[IO.Directory]::CreateDirectory('${escapePowerShell(fixture.runRoot)}') | Out-Null
[IO.File]::WriteAllBytes('${escapePowerShell(replacementMarker)}', [byte[]]@(9, 7, 5, 3))`
      : `New-Item -ItemType Junction -Path '${escapePowerShell(fixture.runRoot)}' -Target '${escapePowerShell(outsideTarget)}' -ErrorAction Stop | Out-Null`;
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.beforeRunRootCleanup = {
  [IO.Directory]::Move('${escapePowerShell(fixture.runRoot)}', '${escapePowerShell(capturedRunRoot)}')
  ${replacement}
}`,
      after: `[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "invalid", category: "residue-invalid",
    });
    expect(await exists(capturedRunRoot)).toBe(true);
    if (kind === "directory") expect(await readFile(replacementMarker)).toEqual(Buffer.from([9, 7, 5, 3]));
    if (kind === "junction") expect((await lstat(fixture.runRoot)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsideSentinel)).toEqual(outsideBytes);
  });

  it("retains a run root when a no-share handle blocks its authorized DELETE open after identity recheck", async () => {
    // Break caught: a deletion-only sharing conflict must retain runRoot without a path fallback or a forged removed transition.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
${directoryHandleHelperSource}
$script:indeterminateRunRootHandle = [IntPtr]::Zero
$contract.beforeRunRootCleanup = {
    $script:indeterminateRunRootHandle = [IntentArc.Preflight.TestDirectoryHandle]::OpenDeleteBlocking('${escapePowerShell(fixture.runRoot)}')
}`,
      after: `$runRootPresentBeforeClose = [IO.Directory]::Exists('${escapePowerShell(fixture.runRoot)}')
[IntentArc.Preflight.TestDirectoryHandle]::Close($script:indeterminateRunRootHandle)
$runRootPresentAfterClose = [IO.Directory]::Exists('${escapePowerShell(fixture.runRoot)}')
[ordered]@{ result = $result; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json; presentBeforeClose = $runRootPresentBeforeClose; presentAfterClose = $runRootPresentAfterClose } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "residue-invalid", phase: "complete", outRestored: true });
    expect(output.state.cleanup).toEqual({
      localAppDataStatus: "removed", profileStatus: "removed", runRootStatus: "retained", category: "residue-invalid",
    });
    expect(output.presentAfterClose).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("runs the exact pnpm preflight gate under a closed lifecycle environment", async () => {
    // Break caught: hostile npm config, NODE_OPTIONS, ComSpec, or a writable cmd.exe shadow must not forge the receipt.
    const fixture = await createFixture();
    const resolveApplication = async (name: string) => (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Command ${name} -CommandType Application | Select-Object -First 1).Source`], {
      encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH }, windowsHide: true,
    })).stdout.trim();
    const pnpmShim = await resolveApplication("pnpm.CMD");
    const pnpmShimSource = await readFile(pnpmShim, "utf8");
    const pnpmRelative = pnpmShimSource.match(/"%~dp0\\([^"\r\n]+pnpm\.exe)"/i)?.[1];
    expect(pnpmRelative).toBeTruthy();
    const pnpmExecutable = join(dirname(pnpmShim), pnpmRelative!);
    const cmdExecutable = await resolveApplication("cmd.exe");
    const pnpmSha256 = createHash("sha256").update(await readFile(pnpmExecutable)).digest("hex");
    const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const cmdSha256 = createHash("sha256").update(await readFile(cmdExecutable)).digest("hex");
    const hostileProfile = join(fixture.root, "hostile-profile");
    const hostileLocalAppData = join(fixture.root, "hostile-localappdata");
    const closedProfile = fixture.childProfilePath;
    const poisonMarker = join(fixture.root, "poison-lifecycle-selected.txt");
    const gateMarker = join(fixture.root, "exact-preflight-gate.json");
    const poisonShell = join(fixture.root, "poison-shell.cmd");
    const poisonNodeOptions = join(fixture.root, "poison-node-options.cjs");
    const poisonNodeExe = join(fixture.repositoryRoot, "node.exe");
    const poisonNodeCmd = join(fixture.repositoryRoot, "node.cmd");
    const repositoryBin = join(fixture.repositoryRoot, "node_modules", ".bin");
    await mkdir(hostileProfile, { recursive: true });
    await mkdir(join(hostileLocalAppData, "pnpm", "config"), { recursive: true });
    await mkdir(repositoryBin, { recursive: true });
    await writeFile(poisonShell, `@echo off\r\n>"${poisonMarker}" echo shell\r\nexit /b 0\r\n`, "utf8");
    await writeFile(poisonNodeOptions, `require('fs').writeFileSync(${JSON.stringify(poisonMarker)},'node-options');process.exit(88)`, "utf8");
    await writeFile(poisonNodeExe, "not-the-bound-node", "utf8");
    await writeFile(poisonNodeCmd, `@echo off\r\n>"${poisonMarker}" echo current-directory-node\r\nexit /b 0\r\n`, "utf8");
    const hostileConfig = `script-shell=${poisonShell}\nnode-options=--require ${poisonNodeOptions}\n`;
    await writeFile(join(hostileProfile, ".npmrc"), hostileConfig, "utf8");
    await writeFile(join(hostileLocalAppData, "pnpm", "config", "config.yaml"), [
      `nodeOptions: ${JSON.stringify(`--require ${poisonNodeOptions}`)}`,
      `scriptShell: ${JSON.stringify(poisonShell)}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(join(fixture.repositoryRoot, ".npmrc"), hostileConfig, "utf8");
    await writeFile(join(repositoryBin, "cmd.exe"), "not-a-system-command-processor", "utf8");
    const gateScript = [
      `const fs=require('fs');`,
      `const path=require('path');`,
      `const expected=['--run-id',${JSON.stringify(runId)},'--tracked-only'];`,
      `fs.writeFileSync(${JSON.stringify(gateMarker)},JSON.stringify({args:process.argv.slice(2),userconfig:process.env.npm_config_userconfig,globalconfig:process.env.npm_config_globalconfig,nodeOptions:process.env.NODE_OPTIONS,npmNodeOptions:process.env.npm_config_node_options,cmd:process.env.ComSpec,shell:process.env.npm_config_script_shell,home:process.env.HOME,profile:process.env.USERPROFILE}));`,
      `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected))process.exit(71);`,
      `const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();`,
      `if(!same(process.env.USERPROFILE,${JSON.stringify(closedProfile)})||!same(process.env.HOME,${JSON.stringify(closedProfile)}))process.exit(72);`,
      `if(process.env.npm_config_userconfig&&process.env.npm_config_userconfig!=='NUL'||process.env.npm_config_globalconfig&&process.env.npm_config_globalconfig!=='NUL')process.exit(73);`,
      `if(process.env.NODE_OPTIONS!=='--no-warnings'||process.env.npm_config_node_options&&process.env.npm_config_node_options!=='--no-warnings')process.exit(74);`,
      `if(!same(process.env.ComSpec,${JSON.stringify(cmdExecutable)})||process.env.npm_config_script_shell&&!same(process.env.npm_config_script_shell,${JSON.stringify(cmdExecutable)}))process.exit(75);`,
      `if(process.env.NoDefaultCurrentDirectoryInExePath!=='1'||!same(process.execPath,${JSON.stringify(process.execPath)}))process.exit(76);`,
      `if(!same(process.env.LOCALAPPDATA,${JSON.stringify(fixture.childLocalAppDataPath)}))process.exit(77);`,
      `fs.writeFileSync(${JSON.stringify(gateMarker)},JSON.stringify({args:process.argv.slice(2),cmd:process.env.ComSpec}));`,
      `fs.mkdirSync(${JSON.stringify(dirname(fixture.receiptPath))},{recursive:true});`,
      `fs.writeFileSync(${JSON.stringify(fixture.receiptPath)},${JSON.stringify(JSON.stringify(validReceipt()))});`,
    ].join("");
    await writeFile(join(fixture.repositoryRoot, "preflight-env-gate.cjs"), gateScript, "utf8");
    await writeFile(join(fixture.repositoryRoot, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@11.0.8",
      scripts: { "desktop:release:preflight": "node preflight-env-gate.cjs" },
    }), "utf8");
    await rm(join(fixture.repositoryRoot, ".npmrc"), { force: true });
    const runHostileControl = async () => execFileAsync(pnpmExecutable, [
      "--dir", fixture.repositoryRoot, "run", "desktop:release:preflight", "--run-id", runId, "--tracked-only",
    ], {
      cwd: fixture.repositoryRoot,
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PATH: `${dirname(process.execPath)};${process.env.PATH}`,
        PATHEXT: process.env.PATHEXT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: hostileProfile,
        USERPROFILE: hostileProfile,
        LOCALAPPDATA: hostileLocalAppData,
        ComSpec: cmdExecutable,
        NoDefaultCurrentDirectoryInExePath: "1",
        npm_config_userconfig: "NUL",
        npm_config_globalconfig: "NUL",
      },
      timeout: 10_000,
      windowsHide: true,
    }).then((value) => ({ stdout: value.stdout, stderr: value.stderr })).catch((error: { stdout?: string; stderr?: string; message?: string }) => ({
      stdout: error.stdout,
      stderr: error.stderr,
      message: error.message,
    }));
    const hostileControl = await runHostileControl();
    const hostileControlDiagnostic = `${hostileControl.stdout ?? ""}\n${hostileControl.stderr ?? ""}\n${hostileControl.message ?? ""}`;
    expect(hostileControlDiagnostic).toContain("ERR_PNPM_INVALID_SCRIPT_SHELL_WINDOWS");
    expect(await exists(gateMarker), "hostile config.yaml must prevent the legitimate gate before controller isolation").toBe(false);
    expect(await exists(poisonMarker), "pnpm rejects a hostile .cmd script shell before it can run").toBe(false);
    await writeFile(join(hostileLocalAppData, "pnpm", "config", "config.yaml"), [
      `nodeOptions: ${JSON.stringify(`--require ${poisonNodeOptions}`)}`,
      "",
    ].join("\n"), "utf8");
    const hostileNodeOptionsControl = await runHostileControl();
    expect(
      await exists(poisonMarker),
      `an independent hostile config.yaml nodeOptions control must run the poison module: ${JSON.stringify(hostileNodeOptionsControl)}; gate=${await exists(gateMarker)}`,
    ).toBe(true);
    expect(await exists(gateMarker), "hostile config.yaml nodeOptions must run before the legitimate gate").toBe(false);
    await rm(poisonMarker, { force: true });
    await writeFile(join(hostileLocalAppData, "pnpm", "config", "config.yaml"), [
      `nodeOptions: ${JSON.stringify(`--require ${poisonNodeOptions}`)}`,
      `scriptShell: ${JSON.stringify(poisonShell)}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(join(fixture.repositoryRoot, ".npmrc"), hostileConfig, "utf8");
    const argumentsVector = [
      "'-Execute'", "'-ExpectedCommit'", `'${commit}'`, "'-PnpmExecutable'",
      `'${escapePowerShell(pnpmExecutable)}'`, "'-ExpectedPnpmSha256'", `'${pnpmSha256}'`,
    ].join(", ");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector,
      overrides: `$contract.Remove('invokeChild')
$contract.getPnpmSha256 = { param($Path) '${pnpmSha256}' }
$contract['nodeExecutable'] = '${escapePowerShell(process.execPath)}'
$contract['nodeDirectory'] = '${escapePowerShell(dirname(process.execPath))}'
$contract['nodeSha256'] = '${nodeSha256}'
$contract['cmdExecutable'] = '${escapePowerShell(cmdExecutable)}'
$contract['cmdDirectory'] = '${escapePowerShell(dirname(cmdExecutable))}'
$contract['cmdSha256'] = '${cmdSha256}'`,
      env: {
        USERPROFILE: hostileProfile,
        HOME: hostileProfile,
        LOCALAPPDATA: hostileLocalAppData,
        NODE_OPTIONS: `--require ${poisonNodeOptions}`,
        npm_config_node_options: `--require ${poisonNodeOptions}`,
        npm_config_userconfig: join(hostileProfile, ".npmrc"),
        npm_config_script_shell: poisonShell,
        ComSpec: poisonShell,
      },
    })).stdout);
    const poisonSelected = await exists(poisonMarker);
    const gateWritten = await exists(gateMarker);
    const gateDiagnostic = gateWritten ? await readFile(gateMarker, "utf8") : "absent";
    const profileEntries = await exists(closedProfile) ? await readdir(closedProfile) : [];
    const localAppDataEntries = await exists(fixture.childLocalAppDataPath) ? await readdir(fixture.childLocalAppDataPath) : [];
    const localAppDataTree = await exists(fixture.childLocalAppDataPath) ? await readdir(fixture.childLocalAppDataPath, { recursive: true }) : [];
    expect(output.result, `poison=${poisonSelected}; gate=${gateDiagnostic}; profile=${JSON.stringify(profileEntries)}; localapp=${JSON.stringify(localAppDataEntries)}; tree=${JSON.stringify(localAppDataTree)}; result=${JSON.stringify(output.result)}`).toMatchObject({ status: "PASS", category: "none", childStarted: true, outRestored: true });
    expect(JSON.parse(await readFile(gateMarker, "utf8"))).toEqual({ args: ["--run-id", runId, "--tracked-only"], cmd: cmdExecutable });
    expect(await exists(poisonMarker)).toBe(false);
  }, 20_000);

  it("uses stable rename handles when a validated ancestor is swapped", async () => {
    // Break caught: path-based rename can redirect opaque out after validation when .superpowers is replaced by a junction.
    const fixture = await createFixture();
    const original = join(fixture.repositoryRoot, ".superpowers-original");
    const replacement = join(fixture.root, "replacement-superpowers");
    const replacementRunRoot = join(replacement, "preflight-out-preservation", runId);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.Remove('moveDirectory')
$contract['useStableRename'] = $true
$contract['beforeStableRename'] = {
  [IO.Directory]::Move('${escapePowerShell(fixture.superpowers)}', '${escapePowerShell(original)}')
  [IO.Directory]::CreateDirectory('${escapePowerShell(replacementRunRoot)}') | Out-Null
  New-Item -ItemType Junction -Path '${escapePowerShell(fixture.superpowers)}' -Target '${escapePowerShell(replacement)}' -ErrorAction Stop | Out-Null
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "repository-invalid", outRestored: true, childStarted: false });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(join(replacementRunRoot, "out"))).toBe(false);
    expect(await exists(join(replacement, "preflight-out-preservation", `${runId}.json`))).toBe(false);
  });

  it("renames and restores the same opaque directory through stable handles", async () => {
    // Break caught: merely pinning ancestors without using handle-relative rename would leave the production path unexercised.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "stable-handle-sentinel.bin");
    const bytes = Buffer.from([0, 19, 255, 7, 0]);
    await writeFile(sentinel, bytes);
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$contract.Remove('moveDirectory')
$contract['useStableRename'] = $true`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", outRestored: true, childStarted: true });
    expect(await readFile(sentinel)).toEqual(bytes);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("holds every receipt ancestor ordinary through the child and receipt read", async () => {
    // Break caught: the child must not replace desktop-release with a junction after its path was validated.
    const fixture = await createFixture();
    const receiptParent = dirname(fixture.receiptPath);
    const movedParent = join(fixture.root, "moved-desktop-release");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRename'] = $true
$contract['useStableReceiptBoundary'] = $true
${successChildOverride(fixture, `$script:receiptAncestorSwapBlocked = $false
try { [IO.Directory]::Move('${escapePowerShell(receiptParent)}', '${escapePowerShell(movedParent)}') }
catch { $script:receiptAncestorSwapBlocked = $true }` )}`,
      after: `[ordered]@{ result = $result; blocked = $script:receiptAncestorSwapBlocked } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "PASS", category: "none", outRestored: true });
    expect(output.blocked).toBe(true);
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("does not clean owned roots when the preservation move fails before namespace mutation", async () => {
    // Break caught: treating source-present as sufficient cleanup authority can remove owned roots while the last durable journal is prepared.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.moveDirectory = {
  param($Source, $Destination)
  $script:moveCalls.Add("$Source\`n$Destination")
  throw 'move-failed-before-mutation'
}`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "out-preservation-failed", phase: "prepared", outRestored: true,
    });
    expect(output.moveCalls).toEqual([`${fixture.sourcePath}\n${fixture.destinationPath}`]);
    expect(output.state).toMatchObject({
      phase: "prepared",
      cleanup: { profileStatus: "pending", localAppDataStatus: "pending", runRootStatus: "pending", category: "none" },
    });
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(true);
    expect(await exists(fixture.runRoot)).toBe(true);
  });

  it("rejects a receipt ancestor junction swap before child start and restores out", async () => {
    const fixture = await createFixture();
    const receiptParent = dirname(fixture.receiptPath);
    const originalParent = join(fixture.root, "original-desktop-release");
    const replacementParent = join(fixture.root, "replacement-desktop-release");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRename'] = $true
$contract['useStableReceiptBoundary'] = $true
$contract.beforeReceiptBoundaryGuard = {
  [IO.Directory]::Move('${escapePowerShell(receiptParent)}', '${escapePowerShell(originalParent)}')
  [IO.Directory]::CreateDirectory('${escapePowerShell(replacementParent)}') | Out-Null
  New-Item -ItemType Junction -Path '${escapePowerShell(receiptParent)}' -Target '${escapePowerShell(replacementParent)}' -ErrorAction Stop | Out-Null
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", childStarted: false, outRestored: true });
    expect(output.childCalls).toBe(0);
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("restores and rejects a receipt whose stable identity changes during locked read", async () => {
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `${successChildOverride(fixture)}
$script:receiptIdentityDrift = $false
$contract.beforeReceiptRead = { $script:receiptIdentityDrift = $true }
$contract.getStableFileIdentity = {
  param($Path)
  if ($Path -ieq '${escapePowerShell(fixture.receiptPath)}' -and $script:receiptIdentityDrift) { '00000005:0000000000000005' }
  else { '00000002:0000000000000002' }
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "receipt-invalid", outRestored: true });
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("restores through the same handle when post-rename identity verification throws", async () => {
    // Break caught: setting AtDestination after verification makes a successful native rename irreversible when verification faults.
    const fixture = await createFixture();
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRename'] = $true
$contract['failStableIdentityVerification'] = $true`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "state-evidence-invalid", outRestored: true, childStarted: false });
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("recovers through stable handles under the documented quiescent-host boundary", async () => {
    // Break caught: production recovery must not silently fall back to the path-based test seam.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "stable-recovery-sentinel.bin");
    const bytes = Buffer.from([11, 0, 244, 3]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "RECOVERED", category: "recovery-restored", outRestored: true, childStarted: false });
    expect(await readFile(sentinel)).toEqual(bytes);
  });

  it("rejects a retained-directory replacement before recovery proof journaling or move", async () => {
    // Break caught: a path snapshot followed by an unbound handle open can move a replacement directory into canonical out.
    const fixture = await createFixture();
    const genuineSentinel = join(fixture.sourcePath, "genuine-retained-sentinel.bin");
    const genuineBytes = Buffer.from([31, 0, 222, 7]);
    await writeFile(genuineSentinel, genuineBytes);
    await prepareRecovery(fixture);
    const retainedGenuine = join(fixture.root, "retained-genuine-out");
    const replacementSentinel = join(fixture.destinationPath, "replacement-sentinel.bin");
    const stateBytes = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true
$contract['beforeStableRecoveryOpen'] = {
  [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(retainedGenuine)}')
  [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.destinationPath)}') | Out-Null
  [IO.File]::WriteAllBytes('${escapePowerShell(replacementSentinel)}', [byte[]](18, 0, 19))
}`,
      after: `[ordered]@{ result = $result; childCalls = $script:childCalls; stateBytes = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "REFUSED", category: "preservation-state-invalid", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output).toMatchObject({ childCalls: 0, stateBytes });
    expect(await readFile(join(retainedGenuine, "genuine-retained-sentinel.bin"))).toEqual(genuineBytes);
    expect(await readFile(replacementSentinel)).toEqual(Buffer.from([18, 0, 19]));
    expect(await exists(fixture.sourcePath)).toBe(false);
  });

  it("lets failed child absence proof override a retained identity mismatch without rewriting or moving", async () => {
    // Break caught: returning on invalid retained authority before unconditional child proof violates top settlement precedence.
    const fixture = await createFixture();
    const genuineSentinel = join(fixture.sourcePath, "genuine-settlement-sentinel.bin");
    const genuineBytes = Buffer.from([57, 0, 199, 4]);
    await writeFile(genuineSentinel, genuineBytes);
    await prepareRecovery(fixture);
    const retainedGenuine = join(fixture.root, "retained-genuine-settlement-out");
    const replacementSentinel = join(fixture.destinationPath, "replacement-settlement-sentinel.bin");
    const stateBytes = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract['useStableRecovery'] = $true
$script:recoveryProofCalls = 0
$contract['beforeStableRecoveryOpen'] = {
  [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(retainedGenuine)}')
  [IO.Directory]::CreateDirectory('${escapePowerShell(fixture.destinationPath)}') | Out-Null
  [IO.File]::WriteAllBytes('${escapePowerShell(replacementSentinel)}', [byte[]](58, 0, 200, 5))
}
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $false }`,
      after: `[ordered]@{ result = $result; proofCalls = $script:recoveryProofCalls; childCalls = $script:childCalls; moveCalls = @($script:moveCalls); stateBytes = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "child-settlement-failed", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output).toMatchObject({ proofCalls: 1, childCalls: 0, moveCalls: [], stateBytes });
    expect(await readFile(join(retainedGenuine, "genuine-settlement-sentinel.bin"))).toEqual(genuineBytes);
    expect(await readFile(replacementSentinel)).toEqual(Buffer.from([58, 0, 200, 5]));
    expect(await exists(fixture.sourcePath)).toBe(false);
  });

  it("lets failed child absence proof override stable recovery acquisition failure without rewriting or moving", async () => {
    // Break caught: restoration failure is lower precedence than an unproven child settlement boundary.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "settlement-before-restoration-failure.bin");
    const bytes = Buffer.from([59, 0, 201, 6]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);
    const stateBytes = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract['useStableRecovery'] = $true
$script:recoveryProofCalls = 0
$contract['afterStableRecoveryOpen'] = { throw 'injected-stable-recovery-boundary-failure' }
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $false }`,
      after: `[ordered]@{ result = $result; proofCalls = $script:recoveryProofCalls; childCalls = $script:childCalls; moveCalls = @($script:moveCalls); stateBytes = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "child-settlement-failed", cleanupCategory: "none",
      phase: "validated", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output).toMatchObject({ proofCalls: 1, childCalls: 0, moveCalls: [], stateBytes });
    expect(await readFile(join(fixture.destinationPath, "settlement-before-restoration-failure.bin"))).toEqual(bytes);
    expect(await exists(fixture.destinationPath)).toBe(true);
    expect(await exists(fixture.sourcePath)).toBe(false);
  });

  it("holds one admitted recovery session through proof, move verification, and restored persistence", async () => {
    // Break caught: releasing the identity-bound session at any later boundary reopens a namespace replacement window.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "held-recovery-sentinel.bin");
    const bytes = Buffer.from([73, 0, 91, 255]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);
    const childProofDiverted = join(fixture.root, "diverted-during-child-proof");
    const proofWriteDiverted = join(fixture.root, "diverted-during-settlement-proof-write");
    const preMoveDiverted = join(fixture.root, "diverted-after-proof-before-move");
    const postMoveDiverted = join(fixture.root, "diverted-during-post-move-verification");
    const restoredWriteDiverted = join(fixture.root, "diverted-during-restored-write");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true
$script:childProofBlocked = $false
$script:proofPersistenceBlocked = $false
$script:preMoveBlocked = $false
$script:postMoveVerificationBlocked = $false
$script:restoredPersistenceBlocked = $false
$contract['proveChildAbsent'] = {
  param($Child)
  try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(childProofDiverted)}') }
  catch { $script:childProofBlocked = $true }
  $true
}
$contract['beforeStableRecovery'] = {
  try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(preMoveDiverted)}') }
  catch { $script:preMoveBlocked = $true }
}
$contract['beforeRecoveryIdentityVerification'] = {
  try { [IO.Directory]::Move('${escapePowerShell(fixture.sourcePath)}', '${escapePowerShell(postMoveDiverted)}') }
  catch { $script:postMoveVerificationBlocked = $true }
}
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and
      [string]$State.phase -ceq [string]$State.recovery.sourcePhase) {
    try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(proofWriteDiverted)}') }
    catch { $script:proofPersistenceBlocked = $true }
  } elseif ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'restored') {
    try { [IO.Directory]::Move('${escapePowerShell(fixture.sourcePath)}', '${escapePowerShell(restoredWriteDiverted)}') }
    catch { $script:restoredPersistenceBlocked = $true }
  }
}`,
      after: `[ordered]@{
  result = $result
  childCalls = $script:childCalls
  childProofBlocked = $script:childProofBlocked
  proofPersistenceBlocked = $script:proofPersistenceBlocked
  preMoveBlocked = $script:preMoveBlocked
  postMoveVerificationBlocked = $script:postMoveVerificationBlocked
  restoredPersistenceBlocked = $script:restoredPersistenceBlocked
} | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "RECOVERED", category: "recovery-restored", phase: "complete",
      childStarted: false, childExitCode: null, outRestored: true,
    });
    expect(output).toMatchObject({
      childCalls: 0,
      childProofBlocked: true,
      proofPersistenceBlocked: true,
      preMoveBlocked: true,
      postMoveVerificationBlocked: true,
      restoredPersistenceBlocked: true,
    });
    expect(await readFile(sentinel)).toEqual(bytes);
    for (const diverted of [childProofDiverted, proofWriteDiverted, preMoveDiverted, postMoveDiverted, restoredWriteDiverted]) {
      expect(await exists(diverted)).toBe(false);
    }
  });

  it.each([
    ["child proof", "child-proof"],
    ["settlement-proof persistence", "proof-persistence"],
    ["post-proof/pre-move", "pre-move"],
    ["post-move verification", "post-move-verification"],
    ["restored-state persistence", "restored-persistence"],
  ] as const)("kills an early stable-session disposal before %s", async (_name, stage) => {
    // Break caught: the boundary probes must fail against a controller that releases and nulls the admitted session early.
    const fixture = await createFixture();
    const sentinelName = `held-session-mutant-${stage}.bin`;
    const sentinel = join(fixture.sourcePath, sentinelName);
    const bytes = Buffer.from([74, stage.length, 92, 254]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);
    const diverted = join(fixture.root, `diverted-${stage}-mutant`);
    const normalizedController = (await readFile(scriptPath, "utf8")).replaceAll("\r\n", "\n");
    const mutations = {
      "child-proof": {
        marker: "        try {\n            $childAbsent = if (",
        replacement: "        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }\n        try {\n            $childAbsent = if (",
        hook: `$contract['proveChildAbsent'] = {
  param($Child)
  $script:replacementAttempted = $true
  try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(diverted)}'); $script:replacementSucceeded = $true } catch {}
  $true
}`,
      },
      "proof-persistence": {
        marker: "        $state.recovery.settlementProvenAt = [DateTime]::UtcNow.ToString('o')\n        try {\n            & $writeState $contract $state",
        replacement: "        $state.recovery.settlementProvenAt = [DateTime]::UtcNow.ToString('o')\n        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }\n        try {\n            & $writeState $contract $state",
        hook: `$contract['proveChildAbsent'] = { param($Child) $true }
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and
      [string]$State.phase -ceq [string]$State.recovery.sourcePhase) {
    $script:replacementAttempted = $true
    try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(diverted)}'); $script:replacementSucceeded = $true } catch {}
  }
}`,
      },
      "pre-move": {
        marker: "                if ($null -ne $TestContract -and $null -ne $contract.beforeStableRecovery) {",
        replacement: "                $stableRenameSession.Dispose()\n                $stableRenameSession = $null\n                if ($null -ne $TestContract -and $null -ne $contract.beforeStableRecovery) {",
        hook: `$contract['proveChildAbsent'] = { param($Child) $true }
$contract['beforeStableRecovery'] = {
  $script:replacementAttempted = $true
  try { [IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}', '${escapePowerShell(diverted)}'); $script:replacementSucceeded = $true } catch {}
}`,
      },
      "post-move-verification": {
        marker: "        try {\n            if ($null -ne $TestContract -and $null -ne $contract.beforeRecoveryIdentityVerification) {",
        replacement: "        try {\n            if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }\n            if ($null -ne $TestContract -and $null -ne $contract.beforeRecoveryIdentityVerification) {",
        hook: `$contract['proveChildAbsent'] = { param($Child) $true }
$contract['beforeRecoveryIdentityVerification'] = {
  $script:replacementAttempted = $true
  try { [IO.Directory]::Move('${escapePowerShell(fixture.sourcePath)}', '${escapePowerShell(diverted)}'); $script:replacementSucceeded = $true } catch {}
}`,
      },
      "restored-persistence": {
        marker: "        try {\n            if (-not (& $writeAdvancedStateIfValid $contract $state)) { throw 'state-invalid' }",
        replacement: "        if ($null -ne $stableRenameSession) { $stableRenameSession.Dispose(); $stableRenameSession = $null }\n        try {\n            if (-not (& $writeAdvancedStateIfValid $contract $state)) { throw 'state-invalid' }",
        hook: `$contract['proveChildAbsent'] = { param($Child) $true }
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq 'restored') {
    $script:replacementAttempted = $true
    try { [IO.Directory]::Move('${escapePowerShell(fixture.sourcePath)}', '${escapePowerShell(diverted)}'); $script:replacementSucceeded = $true } catch {}
  }
}`,
      },
    } as const;
    const mutation = mutations[stage];
    const mutantController = normalizedController.replace(mutation.marker, mutation.replacement);
    expect(mutantController).not.toBe(normalizedController);
    const mutantPath = join(fixture.root, `controller-${stage}-early-disposal.ps1`);
    await writeFile(mutantPath, mutantController, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      controllerPath: mutantPath,
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true
$script:replacementAttempted = $false
$script:replacementSucceeded = $false
${mutation.hook}`,
      after: `[ordered]@{ result = $result; attempted = $script:replacementAttempted; succeeded = $script:replacementSucceeded; childCalls = $script:childCalls } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output).toMatchObject({ attempted: true, succeeded: true, childCalls: 0 });
    expect(() => expect(output).toMatchObject({ attempted: true, succeeded: false, childCalls: 0 })).toThrow();
    expect(await readFile(join(diverted, sentinelName))).toEqual(bytes);
  });

  it("releases the stable recovery session when post-move identity verification fails", async () => {
    // Break caught: an identity-failure return must not leak the no-delete handle that recovery relies on.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true
$contract['verifyRecoveryIdentityAfterMove'] = { param($Expected) $false }`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-failed", outRestored: false });
    await expect(rm(fixture.sourcePath, { recursive: true, force: true })).resolves.toBeUndefined();
  });

  it("blocks an ancestor junction swap before stable recovery", async () => {
    // Break caught: reopening the recovery destination by path after validation reintroduces the ancestor TOCTOU.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const original = join(fixture.repositoryRoot, ".superpowers-original");
    const replacement = join(fixture.root, "replacement-recovery-superpowers");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$contract.Remove('moveDirectory')
$contract['useStableRecovery'] = $true
$contract['beforeStableRecovery'] = {
  [IO.Directory]::Move('${escapePowerShell(fixture.superpowers)}', '${escapePowerShell(original)}')
  [IO.Directory]::CreateDirectory('${escapePowerShell(replacement)}') | Out-Null
  New-Item -ItemType Junction -Path '${escapePowerShell(fixture.superpowers)}' -Target '${escapePowerShell(replacement)}' -ErrorAction Stop | Out-Null
}`,
    })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "out-restoration-failed", outRestored: false, childStarted: false });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it("rejects same-hash pnpm reparse drift after the child and restores out", async () => {
    // Break caught: hash-only revalidation accepts a reparse substitution when the injected hash boundary reports unchanged content.
    const fixture = await createFixture();
    const target = join(fixture.root, "pnpm-reparse-target");
    const body = `[IO.File]::Delete('${escapePowerShell(fixture.pnpmExecutable)}')
[IO.Directory]::CreateDirectory('${escapePowerShell(target)}') | Out-Null
New-Item -ItemType Junction -Path '${escapePowerShell(fixture.pnpmExecutable)}' -Target '${escapePowerShell(target)}' -ErrorAction Stop | Out-Null`;
    const output = JSON.parse((await runCore(fixture, { overrides: successChildOverride(fixture, body) })).stdout);
    expect(output.result).toMatchObject({ status: "FAIL", category: "pnpm-binding-invalid", outRestored: true, childStarted: true });
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  it("recovery rejects non-integral state metadata before moving", async () => {
    // Break caught: coercing arbitrary JSON numbers to Int32 weakens the closed state schema.
    const fixture = await createFixture();
    const state = await prepareRecovery(fixture);
    state.directory.attributes = Number(state.directory.attributes) + 0.5;
    await writeFile(fixture.statePath, JSON.stringify(state), "utf8");
    const output = JSON.parse((await runCore(fixture, { argumentsVector: restoreArguments(fixture) })).stdout);
    expect(output.result).toMatchObject({ status: "REFUSED", category: "preservation-state-invalid", outRestored: false });
    expect(output.moveCalls).toEqual([]);
    expect(await exists(fixture.destinationPath)).toBe(true);
  });

  it.each([
    ["child-settlement safety row", { childSettlementFailed: true, restorationRestored: false, phase: "child-settled", outRestored: false }, { status: "FAIL", category: "child-settlement-failed", phase: "child-settled", cleanupCategory: "none" }],
    ["restoration-conflict safety row", { restorationConflict: true, restorationFailed: true, restorationRestored: false, stateCategory: "state-evidence-invalid", preservationFailed: true, repositoryInvalid: true, pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid", outRestored: false }, { status: "FAIL", category: "out-restoration-conflict", cleanupCategory: "residue-invalid" }],
    ["restoration-failed safety row", { restorationFailed: true, restorationRestored: false, stateCategory: "state-evidence-invalid", preservationFailed: true, repositoryInvalid: true, pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid", outRestored: false }, { status: "FAIL", category: "out-restoration-failed", cleanupCategory: "residue-invalid" }],
    ["state-evidence row", { stateCategory: "state-evidence-invalid", preservationFailed: true, repositoryInvalid: true, pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "residue-invalid" }],
    ["preservation row", { preservationFailed: true, repositoryInvalid: true, pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "out-preservation-failed", cleanupCategory: "residue-invalid" }],
    ["repository row", { repositoryInvalid: true, pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "repository-invalid", cleanupCategory: "residue-invalid" }],
    ["pnpm row", { pnpmBindingInvalid: true, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "pnpm-binding-invalid", cleanupCategory: "residue-invalid" }],
    ["child start row", { childStarted: false, childExitCode: null, childCategory: "preflight-start-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "preflight-start-failed", cleanupCategory: "residue-invalid" }],
    ["child failure row", { childExitCode: 7, childCategory: "preflight-failed", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "preflight-failed", cleanupCategory: "residue-invalid" }],
    ["child timeout row", { childExitCode: null, childCategory: "preflight-timeout", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "preflight-timeout", cleanupCategory: "residue-invalid" }],
    ["child cancellation row", { childExitCode: null, childCategory: "preflight-canceled", receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "preflight-canceled", cleanupCategory: "residue-invalid" }],
    ["receipt row", { receiptInvalid: true, cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "receipt-invalid", cleanupCategory: "residue-invalid" }],
    ["cleanup row", { cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "residue-invalid", cleanupCategory: "residue-invalid" }],
    ["success row", {}, { status: "PASS", category: "none", cleanupCategory: "none" }],
  ])("[precedence] execute resolves the complete %s evidence set", async (_name, overrides, expected) => {
    // Break caught: temporal category writes or cleanup replacement can select a lower-ranked row from the same final evidence set.
    const result = await resolvePrimaryOutcome("-Execute", { ...successfulExecuteEvidence(), ...overrides } as PrimaryOutcomeEvidence);
    expect(result).toMatchObject(expected);
    expectClosedResult(result);
  });

  it.each([
    ["settlement safety row", { childSettlementFailed: true, restorationRestored: false, phase: "child-settled", outRestored: false }, { status: "FAIL", category: "child-settlement-failed", cleanupCategory: "none" }],
    ["settlement over invalid retained authority row", { childSettlementFailed: true, restorationRestored: false, stateCategory: "preservation-state-invalid", phase: "validated", outRestored: false }, { status: "FAIL", category: "child-settlement-failed", phase: "validated", cleanupCategory: "none" }],
    ["settlement over restoration failure row", { childSettlementFailed: true, restorationFailed: true, restorationRestored: false, phase: "validated", outRestored: false }, { status: "FAIL", category: "child-settlement-failed", phase: "validated", cleanupCategory: "none" }],
    ["restoration conflict safety row", { restorationConflict: true, restorationFailed: true, restorationRestored: false, stateCategory: "state-evidence-invalid", cleanupCategory: "residue-invalid", outRestored: false }, { status: "FAIL", category: "out-restoration-conflict", cleanupCategory: "residue-invalid" }],
    ["restoration failure safety row", { restorationFailed: true, restorationRestored: false, stateCategory: "state-evidence-invalid", cleanupCategory: "residue-invalid", outRestored: false }, { status: "FAIL", category: "out-restoration-failed", cleanupCategory: "residue-invalid" }],
    ["invalid retained authority row", { restorationRestored: false, stateCategory: "preservation-state-invalid", phase: "validated", outRestored: false }, { status: "REFUSED", category: "preservation-state-invalid", cleanupCategory: "none" }],
    ["durable state failure row", { stateCategory: "state-evidence-invalid", cleanupCategory: "residue-invalid" }, { status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "residue-invalid" }],
    ["recovered cleanup residue row", { cleanupCategory: "residue-invalid" }, { status: "RECOVERED", category: "recovery-restored", cleanupCategory: "residue-invalid" }],
    ["RECOVERED/recovery-restored row", {}, { status: "RECOVERED", category: "recovery-restored", cleanupCategory: "none" }],
  ])("[precedence] restore-only resolves the complete %s evidence set", async (_name, overrides, expected) => {
    // Break caught: recovery may only project restoration evidence; it cannot inherit execute PASS authority.
    const result = await resolvePrimaryOutcome("-RestoreOnly", { ...successfulRecoveryEvidence(), ...overrides } as PrimaryOutcomeEvidence);
    expect(result).toMatchObject({ childStarted: false, childExitCode: null, ...expected });
    expect(result.status).not.toBe("PASS");
    expectClosedResult(result);
  });

  it("[precedence] restore-only suppresses any historical child projection", async () => {
    const result = await resolvePrimaryOutcome("-RestoreOnly", {
      ...successfulRecoveryEvidence(), childStarted: true, childExitCode: 91,
    });
    expect(result).toMatchObject({
      status: "RECOVERED", category: "recovery-restored",
      childStarted: false, childExitCode: null,
    });
  });

  it("[precedence] retains child failure as primary when cleanup also leaves residue", async () => {
    // Break caught: cleanup is a secondary projection and cannot overwrite a previously evidenced child failure.
    const fixture = await createFixture();
    const residue = join(fixture.runRoot, "precedence-residue.bin");
    const output = JSON.parse((await runCore(fixture, {
      overrides: `$contract.invokeChild = {
  [IO.File]::WriteAllBytes('${escapePowerShell(residue)}', [byte[]](91, 0, 17))
  ${testChildResultSource({ exitCode: 7 })}
}`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "preflight-failed", cleanupCategory: "residue-invalid",
      phase: "complete", childStarted: true, childExitCode: 7, outRestored: true,
    });
    expect(await readFile(residue)).toEqual(Buffer.from([91, 0, 17]));
  });

  it.each([
    ["prepared", (state: any) => ({
      ...state,
      phase: "prepared",
      timestamps: { ...state.timestamps, preservedAt: null },
    })],
    ["preserved", (state: any) => state],
    ["child-started/unknown/unsettled", (state: any) => ({
      ...state,
      phase: "child-started",
      child: {
        ...state.child,
        assignmentStatus: "attempted",
        settlementStatus: "unsettled",
        terminationReason: "unknown",
      },
      timestamps: { ...state.timestamps, childStartedAt: state.timestamps.preservedAt },
    })],
    ["child-settled/normal", (state: any) => childSettledState(state)],
    ["child-settled/settlement-failed/unsettled", (state: any) => childSettledState(state, {
      settlementStatus: "unsettled",
      terminationReason: "settlement-failed",
      exitCode: null,
      infrastructureFailure: true,
    })],
  ])("returns RECOVERED/recovery-restored from recoverable %s authority without changing child history", async (_name, makeState) => {
    // Break caught: restore-only must prove absence and restore from every admitted source phase without treating history as release authority.
    const fixture = await createFixture();
    const state = makeState(await prepareRecovery(fixture));
    await writeFile(fixture.statePath, JSON.stringify(state), "utf8");
    const originalChild = structuredClone(state.child);
    const originalHistory = {
      preparedAt: state.timestamps.preparedAt,
      preservedAt: state.timestamps.preservedAt,
      childStartedAt: state.timestamps.childStartedAt,
      childSettledAt: state.timestamps.childSettledAt,
    };
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryProofCalls = 0
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $true }`,
      after: `[ordered]@{ result = $result; childCalls = $script:childCalls; proofCalls = $script:recoveryProofCalls; state = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') | ConvertFrom-Json } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "RECOVERED", category: "recovery-restored", cleanupCategory: "none",
      phase: "complete", childStarted: false, childExitCode: null, outRestored: true,
    });
    expect(output.result.status).not.toBe("PASS");
    expect(output.childCalls).toBe(0);
    expect(output.proofCalls).toBe(1);
    expect(output.state.child).toEqual(originalChild);
    expect(output.state.timestamps).toMatchObject(originalHistory);
    expect(output.state.timestamps.restoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(output.state.timestamps.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(output.state.recovery).toMatchObject({ mode: "restore-only", sourcePhase: state.phase });
    expect(output.state.recovery.settlementProvenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it.each([
    ["indeterminate source probe", "source-indeterminate", "FAIL", "out-restoration-failed"],
    ["indeterminate destination probe", "destination-indeterminate", "FAIL", "out-restoration-failed"],
    ["nonordinary source file", "source-file", "FAIL", "out-restoration-conflict"],
    ["nonordinary source reparse", "source-reparse", "FAIL", "out-restoration-conflict"],
    ["nonordinary destination file", "destination-file", "FAIL", "out-restoration-conflict"],
    ["nonordinary destination reparse", "destination-reparse", "FAIL", "out-restoration-conflict"],
  ])("recovery fails closed for an %s with byte-identical state", async (_name, condition, status, category) => {
    // Break caught: an uncertain or nonordinary namespace probe cannot authorize a move, rewrite recovery, or spend cleanup authority.
    const fixture = await createFixture();
    const sentinel = join(fixture.sourcePath, "boundary-sentinel.bin");
    const bytes = Buffer.from([203, 0, 14, 255, 9]);
    await writeFile(sentinel, bytes);
    await prepareRecovery(fixture);
    const retainedOpaque = join(fixture.root, "retained-opaque-boundary");
    const reparseTarget = join(fixture.root, "boundary-reparse-target");
    let retainedSentinel = join(fixture.destinationPath, "boundary-sentinel.bin");
    let overrides = "";
    if (condition === "source-indeterminate" || condition === "destination-indeterminate") {
      const indeterminatePath = condition === "source-indeterminate" ? fixture.sourcePath : fixture.destinationPath;
      overrides = `function global:Get-Item {
  [CmdletBinding()]
  param([string] $LiteralPath, [switch] $Force)
  if ([string]::Equals([IO.Path]::GetFullPath($LiteralPath), '${escapePowerShell(indeterminatePath)}', [StringComparison]::OrdinalIgnoreCase)) {
    throw [UnauthorizedAccessException]::new('injected-recovery-indeterminate-entry')
  }
  & 'Microsoft.PowerShell.Management\\Get-Item' @PSBoundParameters
}`;
    } else if (condition === "source-file") {
      await writeFile(fixture.sourcePath, bytes);
    } else if (condition === "source-reparse") {
      await mkdir(reparseTarget);
      await symlink(reparseTarget, fixture.sourcePath, "junction");
    } else {
      await mkdir(dirname(retainedOpaque), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[IO.Directory]::Move('${escapePowerShell(fixture.destinationPath)}','${escapePowerShell(retainedOpaque)}')`],
          { windowsHide: true }, (error) => error ? reject(error) : resolve());
      });
      retainedSentinel = join(retainedOpaque, "boundary-sentinel.bin");
      if (condition === "destination-file") {
        await writeFile(fixture.destinationPath, bytes);
      } else {
        await mkdir(reparseTarget);
        await symlink(reparseTarget, fixture.destinationPath, "junction");
      }
    }
    const stateBytes = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `${overrides}
$script:recoveryProofCalls = 0
$contract['proveChildAbsent'] = { param($Child) $script:recoveryProofCalls++; $true }`,
      after: `[ordered]@{ result = $result; moveCalls = @($script:moveCalls); childCalls = $script:childCalls; proofCalls = $script:recoveryProofCalls; stateBytes = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({ status, category, cleanupCategory: "none", phase: "validated", childStarted: false, childExitCode: null, outRestored: false });
    expect(output).toMatchObject({ moveCalls: [], childCalls: 0, proofCalls: 1, stateBytes });
    expect(await readFile(retainedSentinel)).toEqual(bytes);
    if (condition === "source-file") expect(await readFile(fixture.sourcePath)).toEqual(bytes);
    if (condition === "source-reparse" || condition === "destination-reparse") expect((await lstat(condition === "source-reparse" ? fixture.sourcePath : fixture.destinationPath)).isSymbolicLink()).toBe(true);
    if (condition === "destination-file") expect(await readFile(fixture.destinationPath)).toEqual(bytes);
  });

  it("[settlement proof] journals restore-only authority before restoration and fails without mutation when that write faults", async () => {
    // Break caught: moving before a durable recovery settlement proof spends retained authority that was never journaled.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    const before = await readFile(fixture.statePath, "utf8");
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides: `$script:recoveryProofWrites = 0
$contract.beforeStatePersistence = {
  param($State)
  if ([string]$State.recovery.mode -ceq 'restore-only' -and [string]$State.phase -ceq [string]$State.recovery.sourcePhase) {
    $script:recoveryProofWrites++
    throw 'recovery-settlement-proof-write-fault'
  }
}`,
      after: `[ordered]@{ result = $result; proofWrites = $script:recoveryProofWrites; moveCalls = @($script:moveCalls); stateBytes = [IO.File]::ReadAllText('${escapePowerShell(fixture.statePath)}') } | ConvertTo-Json -Depth 12 -Compress`,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "FAIL", category: "state-evidence-invalid", cleanupCategory: "none",
      phase: "preserved", childStarted: false, childExitCode: null, outRestored: false,
    });
    expect(output).toMatchObject({ proofWrites: 1, moveCalls: [], stateBytes: before });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.destinationPath)).toBe(true);
    expect(await exists(fixture.childProfilePath)).toBe(true);
    expect(await exists(fixture.childLocalAppDataPath)).toBe(true);
  });

  it.each(["repository", "pnpm-file"])("returns RECOVERED/recovery-restored despite unrelated current %s drift", async (drift) => {
    // Break caught: restore-only compares its exact vector to persisted v2 authority and cannot require current release readiness.
    const fixture = await createFixture();
    await prepareRecovery(fixture);
    if (drift === "pnpm-file") await rm(fixture.pnpmExecutable);
    const overrides = drift === "repository"
      ? `$contract.getRepositoryState = { [ordered]@{ branch = 'drift'; commit = '${"c".repeat(40)}'; statusRows = @(' M unrelated') } }`
      : "";
    const output = JSON.parse((await runCore(fixture, {
      argumentsVector: restoreArguments(fixture),
      overrides,
    })).stdout);
    expect(output.result).toMatchObject({
      status: "RECOVERED", category: "recovery-restored", phase: "complete",
      childStarted: false, childExitCode: null, outRestored: true,
    });
    expect(output.childCalls).toBe(0);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(fixture.destinationPath)).toBe(false);
  });

  it("[id06-contract] ID06 direct invocation emits exactly one closed JSON value on refusal", async () => {
    // Break caught: an unfenced footer exception or diagnostic stream can leak paths/secrets or append text to the machine interface.
    let failure: any;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", scriptPath, "TOP-SECRET-FOOTER"], {
        encoding: "utf8",
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        windowsHide: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeTruthy();
    const raw = String(failure.stdout).trim();
    const parsed = JSON.parse(raw);
    expectClosedResult(parsed);
    expect(parsed).toMatchObject({ status: "REFUSED", category: "arguments-invalid", childStarted: false, outRestored: false });
    expect(raw.split(/\r?\n/)).toHaveLength(1);
    expect(raw).not.toContain("TOP-SECRET-FOOTER");
    expect(String(failure.stderr)).toBe("");
  });
});
