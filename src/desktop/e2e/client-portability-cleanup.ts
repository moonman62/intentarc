import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  link,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { z } from "zod";
import type {
  SupervisorProcessIdentity,
  SupervisorSettlementResult,
} from "./client-portability-supervisor-client.js";
import {
  probeWindowsProcessIdentity,
  runBoundedWindowsCommand,
} from "./client-portability-windows-settlement.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^\d+$/;
const ROOT_PREFIX = "intentarc-client-portability-live-";
const RECEIPT_BASENAME = ".intentarc-client-portability-recovery.json";
const RECEIPT_SCHEMA = "intentarc.client-portability-recovery/v1";
const MAX_IDENTITIES = 256;
const MAX_ENTRIES = 1_024;
const MAX_DEPTH = 32;
const MAX_RECEIPT_BYTES = 64 * 1_024;
const CLEANUP_TIMEOUT_MS = 5_000;
const WINDOWS_SYSTEM32_BOUNDARY = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";
const WINDOWS_PATH_OBSERVATION_OUTPUT_CAP_BYTES = 1_024;
const WINDOWS_HANDLE_DELETE_OUTPUT_CAP_BYTES = 1_024;

const WINDOWS_PATH_BOUNDARY_SCRIPT = String.raw`
& {
$ErrorActionPreference = 'Stop'
$temporaryParent = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$args[0]))
$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$args[1]))
$includeTree = [string]$args[2]
$reparse = [System.IO.FileAttributes]::ReparsePoint
$directory = [System.IO.FileAttributes]::Directory
function Test-Ordinary([string]$path) {
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band $reparse) -ne 0) {
    [Console]::Out.Write('reparse')
    exit 4
  }
  return $attributes
}
try {
  $parentFull = [System.IO.Path]::GetFullPath($temporaryParent)
  $rootFull = [System.IO.Path]::GetFullPath($root)
  $volume = [System.IO.Path]::GetPathRoot($parentFull)
  $current = $volume
  [void](Test-Ordinary $current)
  $relativeParent = $parentFull.Substring($volume.Length).TrimStart([char[]]@('\','/'))
  if ($relativeParent.Length -gt 0) {
    foreach ($segment in $relativeParent.Split([char[]]@('\','/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $current = [System.IO.Path]::Combine($current, $segment)
      [void](Test-Ordinary $current)
    }
  }
  [void](Test-Ordinary $rootFull)
  if ($includeTree -eq '1') {
    $stack = [System.Collections.Stack]::new()
    $stack.Push(@($rootFull, 0))
    $count = 0
    while ($stack.Count -gt 0) {
      $item = $stack.Pop()
      $directoryPath = [string]$item[0]
      $depth = [int]$item[1]
      foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directoryPath)) {
        $count += 1
        if ($count -gt 1024) {
          [Console]::Out.Write('bounded')
          exit 5
        }
        $attributes = Test-Ordinary $entry
        if (($attributes -band $directory) -ne 0) {
          $childDepth = $depth + 1
          if ($childDepth -gt 32) {
            [Console]::Out.Write('bounded')
            exit 5
          }
          $stack.Push(@($entry, $childDepth))
        }
      }
    }
  }
  [Console]::Out.Write('safe')
  exit 0
} catch {
  [Console]::Out.Write('failed')
  exit 3
}
}
`.trim();

const WINDOWS_HANDLE_DELETE_SCRIPT = String.raw`
& {
param(
  [string]$rootEncoded,
  [string]$quarantineEncoded,
  [string]$parentEncoded,
  [string]$maximumMillisecondsText,
  [string]$rootDeviceText,
  [string]$rootInodeText
)
$ErrorActionPreference = 'Stop'
$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($rootEncoded))
$quarantine = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($quarantineEncoded))
$parent = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($parentEncoded))
$maximumMilliseconds = [int64]::Parse($maximumMillisecondsText, [Globalization.CultureInfo]::InvariantCulture)
$expectedRootDevice = [uint64]::Parse($rootDeviceText, [Globalization.CultureInfo]::InvariantCulture)
$expectedRootInode = [uint64]::Parse($rootInodeText, [Globalization.CultureInfo]::InvariantCulture)
$clock = [Diagnostics.Stopwatch]::StartNew()
$state = @{
  ConfirmedRemoved = 0
  ObservedEntries = 0
  RootFinalPath = $null
}
$rootNode = $null
$parentNode = $null

function Require-Time {
  if ($clock.ElapsedMilliseconds -gt $maximumMilliseconds) {
    throw 'cleanup deadline'
  }
}

function Add-NativeMethod(
  [Reflection.Emit.TypeBuilder]$builder,
  [string]$name,
  [string]$library,
  [Type]$returnType,
  [Type[]]$parameterTypes,
  [Runtime.InteropServices.CharSet]$characterSet
) {
  $attributes = [Reflection.MethodAttributes]::Public -bor
    [Reflection.MethodAttributes]::Static -bor
    [Reflection.MethodAttributes]::PinvokeImpl
  $method = $builder.DefinePInvokeMethod(
    $name,
    $library,
    $attributes,
    [Reflection.CallingConventions]::Standard,
    $returnType,
    $parameterTypes,
    [Runtime.InteropServices.CallingConvention]::Winapi,
    $characterSet)
  $method.SetImplementationFlags(
    $method.GetMethodImplementationFlags() -bor
    [Reflection.MethodImplAttributes]::PreserveSig)
}

function Initialize-NativeBoundary {
  $assemblyName = [Reflection.AssemblyName]::new(
    'IntentArcHandleBoundDelete_' + [Guid]::NewGuid().ToString('N'))
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    $assemblyName,
    [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule($assemblyName.Name)
  $builder = $module.DefineType(
    'IntentArcHandleBoundDeleteNative',
    [Reflection.TypeAttributes]::Public -bor
    [Reflection.TypeAttributes]::Sealed -bor
    [Reflection.TypeAttributes]::Abstract)

  Add-NativeMethod $builder 'CreateFileW' 'kernel32.dll' ([IntPtr]) ([Type[]]@(
    [string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]
  )) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod $builder 'GetFileInformationByHandleEx' 'kernel32.dll' ([bool]) ([Type[]]@(
    [IntPtr], [int32], [IntPtr], [uint32]
  )) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod $builder 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) ([Type[]]@(
    [IntPtr], [IntPtr]
  )) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod $builder 'GetFinalPathNameByHandleW' 'kernel32.dll' ([uint32]) ([Type[]]@(
    [IntPtr], [Text.StringBuilder], [uint32], [uint32]
  )) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod $builder 'SetFileInformationByHandle' 'kernel32.dll' ([bool]) ([Type[]]@(
    [IntPtr], [int32], [IntPtr], [uint32]
  )) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod $builder 'NtQueryDirectoryFile' 'ntdll.dll' ([int32]) ([Type[]]@(
    [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr],
    [uint32], [int32], [bool], [IntPtr], [bool]
  )) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod $builder 'NtSetInformationFile' 'ntdll.dll' ([int32]) ([Type[]]@(
    [IntPtr], [IntPtr], [IntPtr], [uint32], [int32]
  )) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod $builder 'CloseHandle' 'kernel32.dll' ([bool]) ([Type[]]@(
    [IntPtr]
  )) ([Runtime.InteropServices.CharSet]::None)

  $nativeType = $builder.CreateType()
  $script:nativeMethods = @{}
  foreach ($name in @(
    'CreateFileW',
    'GetFileInformationByHandleEx',
    'GetFileInformationByHandle',
    'GetFinalPathNameByHandleW',
    'SetFileInformationByHandle',
    'NtQueryDirectoryFile',
    'NtSetInformationFile',
    'CloseHandle'
  )) {
    $script:nativeMethods[$name] = $nativeType.GetMethod($name)
  }
}

function Invoke-Native([string]$name, [object[]]$arguments) {
  return $script:nativeMethods[$name].Invoke($null, $arguments)
}

function Throw-Win32 {
  throw [ComponentModel.Win32Exception]::new(
    [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

function Close-Node($node) {
  if ($null -eq $node -or $node.Closed) { return }
  $node.Closed = $true
  [void](Invoke-Native 'CloseHandle' ([object[]]@([IntPtr]$node.Handle)))
}

function Expected-FinalPath([string]$path) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($full.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $full }
  if ($full.StartsWith('\\', [StringComparison]::Ordinal)) {
    return '\\?\UNC\' + $full.Substring(2)
  }
  return '\\?\' + $full
}

function Get-FinalPath([IntPtr]$handle) {
  $builder = [Text.StringBuilder]::new(32768)
  $length = [uint32](Invoke-Native 'GetFinalPathNameByHandleW' ([object[]]@(
    $handle, $builder, [uint32]$builder.Capacity, [uint32]0
  )))
  if ($length -eq 0 -or $length -ge $builder.Capacity) { Throw-Win32 }
  return $builder.ToString().TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Open-Exact([string]$path, [string]$kind) {
  Require-Time
  $deleteAccess = [uint32]0x00010000
  $listDirectory = [uint32]0x00000001
  $readAttributes = [uint32]0x00000080
  $desiredAccess = $listDirectory -bor $readAttributes
  if ($kind -ne 'parent') { $desiredAccess = $desiredAccess -bor $deleteAccess }
  $handle = [IntPtr](Invoke-Native 'CreateFileW' ([object[]]@(
    $path,
    [uint32]$desiredAccess,
    [uint32]0x00000007,
    [IntPtr]::Zero,
    [uint32]3,
    [uint32]0x02200000,
    [IntPtr]::Zero
  )))
  if ($handle -eq [IntPtr]::new(-1)) { Throw-Win32 }
  $node = @{
    Handle = $handle
    Directory = $false
    FinalPath = $null
    Closed = $false
  }
  try {
    $attributeBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
    try {
      if (-not [bool](Invoke-Native 'GetFileInformationByHandleEx' ([object[]]@(
        $handle, [int32]9, $attributeBuffer, [uint32]8
      )))) { Throw-Win32 }
      $attributes = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($attributeBuffer, 0)
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeBuffer)
    }
    if (($attributes -band [uint32]0x00000400) -ne 0) { throw 'reparse point' }
    $node.Directory = (($attributes -band [uint32]0x00000010) -ne 0)
    if (-not $node.Directory -and $kind -ne 'child') { throw 'directory required' }

    if ($kind -eq 'root') {
      $identityBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
      try {
        if (-not [bool](Invoke-Native 'GetFileInformationByHandle' ([object[]]@(
          $handle, $identityBuffer
        )))) { Throw-Win32 }
        $device = [uint64][uint32][Runtime.InteropServices.Marshal]::ReadInt32($identityBuffer, 28)
        $high = [uint64][uint32][Runtime.InteropServices.Marshal]::ReadInt32($identityBuffer, 44)
        $low = [uint64][uint32][Runtime.InteropServices.Marshal]::ReadInt32($identityBuffer, 48)
        $inode = ($high -shl 32) -bor $low
        if ($device -ne $expectedRootDevice -or $inode -ne $expectedRootInode) {
          throw 'root identity changed'
        }
      } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($identityBuffer)
      }
    }

    $actual = Get-FinalPath $handle
    $expected = Expected-FinalPath $path
    if (-not $actual.Equals($expected, [StringComparison]::Ordinal)) {
      throw 'path changed'
    }
    if ($kind -eq 'child') {
      if (-not $actual.StartsWith(
        $state.RootFinalPath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::Ordinal
      )) { throw 'outside root' }
    }
    $node.FinalPath = $actual
    return $node
  } catch {
    Close-Node $node
    throw
  }
}

function Rename-OpenedRoot(
  $node,
  $openedParent,
  [string]$targetName,
  [string]$expectedTarget
) {
  Require-Time
  $nameBytes = [Text.Encoding]::Unicode.GetBytes($targetName)
  $rootDirectoryOffset = if ([IntPtr]::Size -eq 8) { 8 } else { 4 }
  $lengthOffset = $rootDirectoryOffset + [IntPtr]::Size
  $nameOffset = $lengthOffset + 4
  $bufferSize = $nameOffset + $nameBytes.Length
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufferSize)
  try {
    [Runtime.InteropServices.Marshal]::Copy(
      ([byte[]]::new($bufferSize)),
      0,
      $buffer,
      $bufferSize)
    [Runtime.InteropServices.Marshal]::WriteIntPtr(
      $buffer,
      $rootDirectoryOffset,
      [IntPtr]$openedParent.Handle)
    [Runtime.InteropServices.Marshal]::WriteInt32(
      $buffer,
      $lengthOffset,
      $nameBytes.Length)
    [Runtime.InteropServices.Marshal]::Copy(
      $nameBytes,
      0,
      [IntPtr]::Add($buffer, $nameOffset),
      $nameBytes.Length)
    $ioStatus = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size * 2)
    try {
      $status = [int32](Invoke-Native 'NtSetInformationFile' ([object[]]@(
        [IntPtr]$node.Handle, $ioStatus, $buffer, [uint32]$bufferSize, [int32]10
      )))
      if ($status -ne 0) { throw 'rename failed' }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($ioStatus)
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $actual = Get-FinalPath ([IntPtr]$node.Handle)
  $expected = Expected-FinalPath $expectedTarget
  if (-not $actual.Equals($expected, [StringComparison]::Ordinal)) {
    throw 'rename path changed'
  }
  $node.FinalPath = $actual
  $state.RootFinalPath = $actual
}

function Read-Children($directory) {
  $children = [Collections.Generic.List[string]]::new()
  $bufferSize = 128 * 1024
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufferSize)
  $ioStatus = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size * 2)
  try {
    $restart = $true
    while ($true) {
      Require-Time
      $status = [int32](Invoke-Native 'NtQueryDirectoryFile' ([object[]]@(
        [IntPtr]$directory.Handle,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        $ioStatus,
        $buffer,
        [uint32]$bufferSize,
        [int32]3,
        $false,
        [IntPtr]::Zero,
        [bool]$restart
      )))
      $restart = $false
      if ($status -eq -2147483642) { break }
      if ($status -ne 0) { throw 'directory query' }
      $returnedBytes = if ([IntPtr]::Size -eq 8) {
        [uint64][Runtime.InteropServices.Marshal]::ReadInt64($ioStatus, [IntPtr]::Size)
      } else {
        [uint64][uint32][Runtime.InteropServices.Marshal]::ReadInt32(
          $ioStatus,
          [IntPtr]::Size)
      }
      if ($returnedBytes -eq 0 -or $returnedBytes -gt $bufferSize) {
        throw 'directory query'
      }
      $offset = 0
      while ($true) {
        if ($offset -lt 0 -or ($offset + 94) -gt $returnedBytes) {
          throw 'directory query'
        }
        $nextOffset = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, $offset)
        $nameBytes = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, $offset + 60)
        if (
          $nameBytes -lt 0 -or
          ($nameBytes % 2) -ne 0 -or
          ($offset + 94 + $nameBytes) -gt $returnedBytes
        ) { throw 'directory query' }
        $name = [Runtime.InteropServices.Marshal]::PtrToStringUni(
          [IntPtr]::Add($buffer, $offset + 94),
          $nameBytes / 2)
        if ($name -cne '.' -and $name -cne '..') {
          if (
            [string]::IsNullOrEmpty($name) -or
            [IO.Path]::IsPathRooted($name) -or
            $name.IndexOf([IO.Path]::DirectorySeparatorChar) -ge 0 -or
            $name.IndexOf([IO.Path]::AltDirectorySeparatorChar) -ge 0
          ) { throw 'directory entry' }
          $state.ObservedEntries += 1
          if ($state.ObservedEntries -gt 1024) { throw 'entry bound' }
          $children.Add($name)
        }
        if ($nextOffset -eq 0) { break }
        if ($nextOffset -lt 94 -or ($offset + $nextOffset) -ge $returnedBytes) {
          throw 'directory query'
        }
        $offset += $nextOffset
      }
    }
    return ,$children
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($ioStatus)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}

function Remove-OpenedNode($node, [bool]$countEntry) {
  Require-Time
  $disposition = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($disposition, 0, 1)
    if (-not [bool](Invoke-Native 'SetFileInformationByHandle' ([object[]]@(
      [IntPtr]$node.Handle, [int32]4, $disposition, [uint32]4
    )))) { Throw-Win32 }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($disposition)
  }
  Close-Node $node
  if ($countEntry) { $state.ConfirmedRemoved += 1 }
  [Threading.Thread]::Sleep(1)
}

function Remove-Node([string]$path, [int]$depth, $node, [bool]$isRoot) {
  try {
    Require-Time
    if ($node.Directory) {
      if ($depth -gt 32) { throw 'depth bound' }
      $children = Read-Children $node
      $children.Sort([StringComparer]::OrdinalIgnoreCase)
      for ($index = $children.Count - 1; $index -ge 0; $index -= 1) {
        $childPath = [IO.Path]::Combine($path, $children[$index])
        $childNode = Open-Exact $childPath 'child'
        try {
          Remove-Node $childPath ($depth + 1) $childNode $false
        } finally {
          Close-Node $childNode
        }
      }
    }
    Remove-OpenedNode $node (-not $isRoot)
  } finally {
    if (-not $isRoot) { Close-Node $node }
  }
}

$output = $null
$exitCode = 3
try {
  Initialize-NativeBoundary
  Require-Time
  $parentNode = Open-Exact $parent 'parent'
  $rootNode = Open-Exact $root 'root'
  if (-not $rootNode.FinalPath.StartsWith(
    $parentNode.FinalPath + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::Ordinal
  )) { throw 'root parent changed' }
  Rename-OpenedRoot $rootNode $parentNode ([IO.Path]::GetFileName($quarantine)) $quarantine
  Remove-Node $quarantine 0 $rootNode $true
  $output = 'removed:{0}' -f $state.ConfirmedRemoved
  $exitCode = 0
} catch {
  if ($null -ne $rootNode -and -not $rootNode.Closed) {
    try {
      Rename-OpenedRoot $rootNode $parentNode ([IO.Path]::GetFileName($root)) $root
    } catch {
      # The exact residue is validated by the parent process.
    }
  }
  $output = 'cleanup_failed:{0}' -f $state.ConfirmedRemoved
} finally {
  Close-Node $rootNode
  Close-Node $parentNode
}
[Console]::Out.Write($output)
exit $exitCode
}
`.trim();

export interface PortabilityCleanupInput {
  readonly runId: string;
  readonly root: string;
  readonly temporaryParent: string;
  readonly sessions: readonly SupervisorSettlementResult[];
  readonly requestsDrained: boolean;
  readonly workspaceClosed: boolean;
  readonly configurationAbsent: boolean;
}

export type PortabilityCleanupResult =
  | { readonly status: "removed"; readonly removedEntries: number }
  | {
    readonly status: "cleanup_failed";
    readonly category: "root";
    readonly residuePath: string | null;
    readonly removedEntries: number | null;
  }
  | {
    readonly status: "preserved";
    readonly receiptPath: string | null;
    readonly recoveryCommand: string | null;
    readonly category: "settlement" | "workspace" | "configuration" | "root";
  };

interface ValidatedRoot {
  readonly runId: string;
  readonly canonicalRoot: string;
  readonly canonicalParent: string;
}

const settlementCapability = Symbol("client-portability-settlement");

interface SettlementCapability extends ValidatedRoot {
  readonly [settlementCapability]: true;
  readonly issuedAt: number;
  readonly identities: readonly SupervisorProcessIdentity[];
}

interface DeniedAuthority extends ValidatedRoot {
  readonly denied: true;
  readonly category: "settlement" | "workspace" | "configuration" | "root";
  readonly identities: readonly SupervisorProcessIdentity[];
  readonly recoverable: boolean;
}

type CleanupAuthority = SettlementCapability | DeniedAuthority;

interface RecoveryReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly runId: string;
  readonly root: string;
  readonly identities: readonly SupervisorProcessIdentity[];
  readonly categories: readonly ["process_settlement"];
  readonly createdAt: number;
}

const receiptSchema = z.strictObject({
  schema: z.literal(RECEIPT_SCHEMA),
  runId: z.string().regex(UUID_PATTERN),
  root: z.string().min(1).max(4_096),
  identities: z.array(z.strictObject({
    pid: z.number().int().positive().safe(),
    startTime: z.string().regex(DECIMAL_PATTERN).max(64),
  })).min(1).max(MAX_IDENTITIES),
  categories: z.tuple([z.literal("process_settlement")]),
  createdAt: z.number().int().nonnegative().safe(),
});

const preserved = (
  category: "settlement" | "workspace" | "configuration" | "root",
  receiptPath: string | null = null,
): PortabilityCleanupResult => Object.freeze({
  status: "preserved" as const,
  receiptPath,
  recoveryCommand: receiptPath === null ? null : formatRecoveryCommand(receiptPath),
  category,
});

const samePath = (left: string, right: string): boolean =>
  left === right;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null
  && (error as NodeJS.ErrnoException).code === "ENOENT";

const pathIsAbsent = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isMissing(error);
  }
};

const exactWindowsSystemExecutable = (relativePath: string): string => {
  const normalizedRelativePath = win32.normalize(relativePath);
  if (
    process.platform !== "win32"
    || win32.isAbsolute(normalizedRelativePath)
    || normalizedRelativePath === ".."
    || normalizedRelativePath.startsWith(`..${win32.sep}`)
  ) throw new Error("Windows system boundary unavailable.");
  const candidate = win32.join(WINDOWS_SYSTEM32_BOUNDARY, normalizedRelativePath);
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Windows system boundary unavailable.");
  }
  const canonical = realpathSync.native(candidate);
  const requiredSuffix = `${win32.sep}System32${win32.sep}${normalizedRelativePath}`
    .toLowerCase();
  if (!win32.resolve(canonical).toLowerCase().endsWith(requiredSuffix)) {
    throw new Error("Windows system boundary unavailable.");
  }
  return canonical;
};

export type ClientPortabilityWindowsPathBoundaryResult =
  | "safe"
  | "reparse"
  | "bounded"
  | "failed"
  | "unsupported";

export const inspectClientPortabilityWindowsPathBoundary = async (input: {
  readonly root: string;
  readonly temporaryParent: string;
  readonly includeTree: boolean;
  readonly deadline: number;
}): Promise<ClientPortabilityWindowsPathBoundaryResult> => {
  if (process.platform !== "win32") return "unsupported";
  try {
    if (
      !isAbsolute(input.root)
      || !isAbsolute(input.temporaryParent)
      || input.root !== resolve(input.root)
      || input.temporaryParent !== resolve(input.temporaryParent)
      || !Number.isFinite(input.deadline)
      || input.deadline <= Date.now()
    ) return "failed";
    const powershell = exactWindowsSystemExecutable(
      win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    const result = await runBoundedWindowsCommand(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PATH_BOUNDARY_SCRIPT,
      Buffer.from(input.temporaryParent, "utf16le").toString("base64"),
      Buffer.from(input.root, "utf16le").toString("base64"),
      input.includeTree ? "1" : "0",
    ], input.deadline, WINDOWS_PATH_OBSERVATION_OUTPUT_CAP_BYTES);
    const output = result.stdout.trim();
    if (result.exitCode === 0 && output === "safe") return "safe";
    if (result.exitCode === 4 && output === "reparse") return "reparse";
    if (result.exitCode === 5 && output === "bounded") return "bounded";
    return "failed";
  } catch {
    return "failed";
  }
};

const requireOrdinaryAncestors = async (absolutePath: string): Promise<void> => {
  const root = parsePath(absolutePath).root;
  const suffix = relative(root, absolutePath);
  const segments = suffix === "" ? [] : suffix.split(sep);
  let candidate = root;
  const rootMetadata = await lstat(candidate);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("unsafe");
  for (const segment of segments) {
    candidate = join(candidate, segment);
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe");
  }
};

const validateRootBoundary = async (
  runId: string,
  rootInput: string,
  parentInput: string,
): Promise<ValidatedRoot> => {
  if (
    !UUID_PATTERN.test(runId)
    || !isAbsolute(rootInput)
    || !isAbsolute(parentInput)
    || rootInput !== resolve(rootInput)
    || parentInput !== resolve(parentInput)
    || basename(rootInput) !== `${ROOT_PREFIX}${runId}`
    || !samePath(dirname(rootInput), parentInput)
  ) throw new Error("unsafe");

  await requireOrdinaryAncestors(parentInput);
  await requireOrdinaryAncestors(rootInput);
  const [canonicalParent, canonicalRoot] = await Promise.all([
    realpath(parentInput),
    realpath(rootInput),
  ]);
  if (
    !samePath(canonicalParent, parentInput)
    || !samePath(canonicalRoot, rootInput)
    || !samePath(dirname(canonicalRoot), canonicalParent)
    || basename(canonicalRoot) !== `${ROOT_PREFIX}${runId}`
  ) throw new Error("unsafe");
  return Object.freeze({ runId, canonicalRoot, canonicalParent });
};

const exactIdentity = (value: unknown): value is SupervisorProcessIdentity => {
  try {
    const candidate = value as Partial<SupervisorProcessIdentity>;
    return Number.isSafeInteger(candidate.pid)
      && (candidate.pid ?? 0) > 0
      && typeof candidate.startTime === "string"
      && DECIMAL_PATTERN.test(candidate.startTime)
      && candidate.startTime.length <= 64;
  } catch {
    return false;
  }
};

const captureSessionEvidence = (
  sessions: readonly SupervisorSettlementResult[],
): {
  readonly settled: boolean;
  readonly processRecoverable: boolean;
  readonly identities: readonly SupervisorProcessIdentity[];
}
  | undefined => {
  try {
    if (!Array.isArray(sessions) || sessions.length !== 2) return undefined;
    const retained = new Map<number, SupervisorProcessIdentity>();
    let allSettled = true;
    let processRecoverable = true;
    let blockedSessionSeen = false;
    for (const session of sessions) {
      if (
        session === null
        || typeof session !== "object"
        || !["settled", "blocked", "unsupported"].includes(session.status)
        || !Array.isArray(session.retained)
      ) return undefined;
      if (
        (session.status === "settled" && session.category !== "none")
        || (session.status === "unsupported" && session.category !== "platform")
        || (session.status === "blocked"
          && (session.category === "none" || session.category === "platform"))
      ) return undefined;
      if (session.status !== "settled") allSettled = false;
      if (session.status === "unsupported") processRecoverable = false;
      if (session.status === "blocked") {
        blockedSessionSeen = true;
        if (session.category !== "child_handle" || session.retained.length === 0) {
          processRecoverable = false;
        }
      }
      for (const identity of session.retained) {
        if (!exactIdentity(identity)) return undefined;
        const existing = retained.get(identity.pid);
        if (existing !== undefined && existing.startTime !== identity.startTime) return undefined;
        if (existing === undefined) {
          if (retained.size >= MAX_IDENTITIES) return undefined;
          retained.set(identity.pid, Object.freeze({
            pid: identity.pid,
            startTime: identity.startTime,
          }));
        }
      }
    }
    return Object.freeze({
      settled: allSettled,
      processRecoverable: processRecoverable && blockedSessionSeen,
      identities: Object.freeze([...retained.values()]),
    });
  } catch {
    return undefined;
  }
};

const deniedAuthority = (
  root: ValidatedRoot,
  category: DeniedAuthority["category"],
  identities: readonly SupervisorProcessIdentity[],
  recoverable: boolean,
): DeniedAuthority => Object.freeze({
  ...root,
  denied: true,
  category,
  identities,
  recoverable,
});

const capability = (
  root: ValidatedRoot,
  identities: readonly SupervisorProcessIdentity[],
): SettlementCapability => Object.freeze({
  ...root,
  [settlementCapability]: true as const,
  issuedAt: Date.now(),
  identities,
});

const hasSettlementCapability = (value: CleanupAuthority): value is SettlementCapability =>
  settlementCapability in value && value[settlementCapability] === true;

const repeatHandleReleaseProbe = async (root: ValidatedRoot): Promise<boolean> => {
  if (process.platform === "win32" && await inspectClientPortabilityWindowsPathBoundary({
    root: root.canonicalRoot,
    temporaryParent: root.canonicalParent,
    includeTree: false,
    deadline: Date.now() + CLEANUP_TIMEOUT_MS,
  }) !== "safe") return false;
  const probe = `${root.canonicalRoot}.settlement-${root.runId}`;
  if (!await pathIsAbsent(probe)) return false;
  let moved = false;
  try {
    await rename(root.canonicalRoot, probe);
    moved = true;
    const probeMetadata = await lstat(probe);
    if (!probeMetadata.isDirectory() || probeMetadata.isSymbolicLink()) throw new Error("unsafe");
    await rename(probe, root.canonicalRoot);
    moved = false;
    await validateRootBoundary(root.runId, root.canonicalRoot, root.canonicalParent);
    return true;
  } catch {
    if (moved && await pathIsAbsent(root.canonicalRoot)) {
      try { await rename(probe, root.canonicalRoot); }
      catch { return false; }
    }
    return false;
  }
};

const issueAutomaticAuthority = async (
  input: PortabilityCleanupInput,
  root: ValidatedRoot,
): Promise<CleanupAuthority> => {
  const evidence = captureSessionEvidence(input.sessions);
  if (evidence === undefined) return deniedAuthority(root, "settlement", [], false);
  if (process.platform !== "win32") {
    return deniedAuthority(root, "settlement", evidence.identities, false);
  }
  if (input.workspaceClosed !== true) {
    return deniedAuthority(root, "workspace", evidence.identities, false);
  }
  if (input.configurationAbsent !== true) {
    return deniedAuthority(root, "configuration", evidence.identities, false);
  }
  if (!evidence.settled || input.requestsDrained !== true) {
    return deniedAuthority(
      root,
      "settlement",
      evidence.identities,
      input.requestsDrained === true && evidence.processRecoverable,
    );
  }
  if (!await repeatHandleReleaseProbe(root)) {
    return deniedAuthority(root, "workspace", evidence.identities, false);
  }
  return capability(root, evidence.identities);
};

interface WalkEntry {
  readonly relativePath: string;
  readonly directory: boolean;
}

type WindowsHandleDeleteResult =
  | { readonly status: "removed"; readonly removedEntries: number }
  | { readonly status: "cleanup_failed"; readonly removedEntries: number };

const removeWindowsHandleBoundRoot = async (
  root: string,
  quarantine: string,
  parent: string,
  rootDevice: bigint,
  rootInode: bigint,
  deadline: number,
): Promise<WindowsHandleDeleteResult> => {
  const remaining = deadline - Date.now();
  if (process.platform !== "win32" || remaining <= 0) throw new Error("bounded");
  const powershell = exactWindowsSystemExecutable(
    win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const result = await runBoundedWindowsCommand(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_HANDLE_DELETE_SCRIPT,
    Buffer.from(root, "utf16le").toString("base64"),
    Buffer.from(quarantine, "utf16le").toString("base64"),
    Buffer.from(parent, "utf16le").toString("base64"),
    String(Math.max(1, remaining - 500)),
    rootDevice.toString(10),
    rootInode.toString(10),
  ], deadline, WINDOWS_HANDLE_DELETE_OUTPUT_CAP_BYTES);
  const output = result.stdout.trim();
  const match = /^(removed|cleanup_failed):(0|[1-9]\d{0,3})$/.exec(output);
  if (match === null) throw new Error("cleanup helper");
  const removedEntries = Number(match[2]);
  if (!Number.isSafeInteger(removedEntries) || removedEntries > MAX_ENTRIES) {
    throw new Error("cleanup helper");
  }
  if (result.exitCode === 0 && match[1] === "removed") {
    return Object.freeze({ status: "removed", removedEntries });
  }
  if (result.exitCode === 3 && match[1] === "cleanup_failed") {
    return Object.freeze({ status: "cleanup_failed", removedEntries });
  }
  throw new Error("cleanup helper");
};

class CleanupFailedError extends Error {
  readonly residuePath: string | null;
  readonly removedEntries: number | null;

  constructor(residuePath: string | null, removedEntries: number | null) {
    super("Client portability cleanup completion is uncertain.");
    this.residuePath = residuePath;
    this.removedEntries = removedEntries;
  }
}

const containedRelative = (root: string, candidate: string): string => {
  const child = relative(root, candidate);
  if (
    child === ""
    || child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  ) throw new Error("unsafe");
  return child;
};

const collectBoundedEntries = async (
  root: string,
  deadline: number,
): Promise<readonly WalkEntry[]> => {
  const entries: WalkEntry[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || Date.now() > deadline) throw new Error("bounded");
    const directoryHandle = await opendir(directory);
    for await (const directoryEntry of directoryHandle) {
      if (Date.now() > deadline || entries.length >= MAX_ENTRIES) throw new Error("bounded");
      const name = directoryEntry.name;
      const candidate = join(directory, name);
      const relativePath = containedRelative(root, candidate);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) throw new Error("reparse");
      if (metadata.isDirectory()) {
        entries.push(Object.freeze({ relativePath, directory: true }));
        await walk(candidate, depth + 1);
      } else if (metadata.isFile()) {
        entries.push(Object.freeze({ relativePath, directory: false }));
      } else {
        throw new Error("reparse");
      }
    }
  };
  await walk(root, 0);
  return Object.freeze(entries);
};

const removeBoundedRoot = async (authority: CleanupAuthority): Promise<number> => {
  if (!hasSettlementCapability(authority)) throw new Error("authority");
  if (
    Date.now() < authority.issuedAt
    || Date.now() - authority.issuedAt > CLEANUP_TIMEOUT_MS
  ) throw new Error("authority");
  const root = await validateRootBoundary(
    authority.runId,
    authority.canonicalRoot,
    authority.canonicalParent,
  );
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  if (process.platform === "win32" && await inspectClientPortabilityWindowsPathBoundary({
    root: root.canonicalRoot,
    temporaryParent: root.canonicalParent,
    includeTree: true,
    deadline,
  }) !== "safe") throw new Error("reparse");
  const entries = await collectBoundedEntries(root.canonicalRoot, deadline);
  if (Date.now() > deadline) throw new Error("bounded");

  const quarantine = `${root.canonicalRoot}.cleanup-${randomUUID()}`;
  if (!await pathIsAbsent(quarantine)) throw new Error("unsafe");
  const rootIdentity = await lstat(root.canonicalRoot, { bigint: true });
  let removedEntries: number | null = 0;
  let destructiveUncertain = false;
  try {
    if (process.platform === "win32") {
      destructiveUncertain = true;
      removedEntries = null;
      const result = await removeWindowsHandleBoundRoot(
        root.canonicalRoot,
        quarantine,
        root.canonicalParent,
        rootIdentity.dev,
        rootIdentity.ino,
        deadline,
      );
      removedEntries = result.removedEntries;
      if (result.status !== "removed" || removedEntries !== entries.length) {
        throw new Error("cleanup helper");
      }
    } else {
      await rename(root.canonicalRoot, quarantine);
      if (!await pathIsAbsent(root.canonicalRoot)) throw new Error("unsafe");
      const quarantineMetadata = await lstat(quarantine, { bigint: true });
      if (
        !quarantineMetadata.isDirectory()
        || quarantineMetadata.isSymbolicLink()
        || quarantineMetadata.dev !== rootIdentity.dev
        || quarantineMetadata.ino !== rootIdentity.ino
      ) throw new Error("unsafe");
      removedEntries = 0;
      for (const entry of [...entries].reverse()) {
        if (Date.now() > deadline) throw new Error("bounded");
        const candidate = join(quarantine, entry.relativePath);
        containedRelative(quarantine, candidate);
        const metadata = await lstat(candidate, { bigint: true });
        if (metadata.isSymbolicLink() || metadata.isDirectory() !== entry.directory) {
          throw new Error("reparse");
        }
        if (entry.directory) await rmdir(candidate);
        else await unlink(candidate);
        removedEntries += 1;
      }
      await rmdir(quarantine);
    }
    if (!await pathIsAbsent(quarantine) || !await pathIsAbsent(root.canonicalRoot)) {
      throw new Error("absence");
    }
    return entries.length;
  } catch (error) {
    let residuePath: string | null = null;
    if (process.platform !== "win32" && await pathIsAbsent(root.canonicalRoot)) {
      try {
        await rename(quarantine, root.canonicalRoot);
      } catch {
        // Exact residue identity is observed below.
      }
    }
    for (const candidate of [root.canonicalRoot, quarantine]) {
      try {
        const metadata = await lstat(candidate, { bigint: true });
        if (
          metadata.isDirectory()
          && !metadata.isSymbolicLink()
          && metadata.dev === rootIdentity.dev
          && metadata.ino === rootIdentity.ino
          && samePath(await realpath(candidate), candidate)
        ) {
          residuePath = candidate;
          break;
        }
      } catch { /* This candidate is not the exact residue. */ }
    }
    if (
      destructiveUncertain
      || (removedEntries ?? 0) > 0
      || !samePath(residuePath ?? "", root.canonicalRoot)
    ) {
      throw new CleanupFailedError(residuePath, removedEntries);
    }
    throw error;
  }
};

const formatRecoveryCommand = (receiptPath: string): string => {
  const escaped = receiptPath.replace(/[`$"]/g, (character) => `\`${character}`);
  return `pnpm desktop:test:client-portability:cleanup -- --receipt "${escaped}"`;
};

const scanForDuplicateObjectKeys = (text: string): void => {
  let index = 0;
  const fail = (): never => { throw new Error("invalid"); };
  const skipWhitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)) as string; }
        catch { return fail(); }
      }
      if (character < " ") fail();
      if (character === "\\") {
        index += 1;
        const escape = text[index] ?? fail();
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail();
      }
      index += 1;
    }
    return fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index] !== ",") fail();
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index] !== ",") fail();
        index += 1;
      }
    }
    if (character === '"') { parseString(); return; }
    const start = index;
    while (index < text.length && !/[\t\n\r ,}\]]/.test(text[index]!)) index += 1;
    if (start === index) fail();
  };
  parseValue();
  skipWhitespace();
  if (index !== text.length) fail();
};

const parseRecoveryReceipt = (bytes: Uint8Array): RecoveryReceipt => {
  if (
    bytes.length === 0
    || bytes.length > MAX_RECEIPT_BYTES
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) throw new Error("invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  scanForDuplicateObjectKeys(text);
  const parsed = receiptSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("invalid");
  const seen = new Map<number, string>();
  for (const identity of parsed.data.identities) {
    const existing = seen.get(identity.pid);
    if (existing !== undefined) throw new Error("invalid");
    seen.set(identity.pid, identity.startTime);
  }
  return Object.freeze({
    ...parsed.data,
    identities: Object.freeze(parsed.data.identities.map((identity) => Object.freeze({ ...identity }))),
    categories: Object.freeze(["process_settlement"] as const),
  });
};

const readBoundedReceipt = async (
  file: Awaited<ReturnType<typeof open>>,
): Promise<Uint8Array> => {
  const bytes = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset === 0 || offset > MAX_RECEIPT_BYTES) throw new Error("invalid");
  return bytes.subarray(0, offset);
};

const writeAtomicReceipt = async (
  root: ValidatedRoot,
  identities: readonly SupervisorProcessIdentity[],
): Promise<string> => {
  if (identities.length === 0 || identities.length > MAX_IDENTITIES) throw new Error("invalid");
  const receiptPath = join(root.canonicalRoot, RECEIPT_BASENAME);
  if (!samePath(dirname(receiptPath), root.canonicalRoot) || !await pathIsAbsent(receiptPath)) {
    throw new Error("invalid");
  }
  const temporaryPath = join(
    root.canonicalRoot,
    `${RECEIPT_BASENAME}.${randomUUID()}.tmp`,
  );
  const receipt: RecoveryReceipt = {
    schema: RECEIPT_SCHEMA,
    runId: root.runId,
    root: root.canonicalRoot,
    identities,
    categories: ["process_settlement"],
    createdAt: Date.now(),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(receipt));
  if (encoded.length > MAX_RECEIPT_BYTES) throw new Error("invalid");
  if (process.platform === "win32" && await inspectClientPortabilityWindowsPathBoundary({
    root: root.canonicalRoot,
    temporaryParent: root.canonicalParent,
    includeTree: false,
    deadline: Date.now() + CLEANUP_TIMEOUT_MS,
  }) !== "safe") throw new Error("invalid");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(encoded);
    await file.sync();
    await validateRootBoundary(root.runId, root.canonicalRoot, root.canonicalParent);
    if (process.platform === "win32" && await inspectClientPortabilityWindowsPathBoundary({
      root: root.canonicalRoot,
      temporaryParent: root.canonicalParent,
      includeTree: false,
      deadline: Date.now() + CLEANUP_TIMEOUT_MS,
    }) !== "safe") throw new Error("invalid");
    await link(temporaryPath, receiptPath);
    published = true;
    const [sourceMetadata, metadata] = await Promise.all([file.stat(), lstat(receiptPath)]);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || sourceMetadata.dev !== metadata.dev
      || sourceMetadata.ino !== metadata.ino
    ) throw new Error("invalid");
    await validateRootBoundary(root.runId, root.canonicalRoot, root.canonicalParent);
    if (process.platform === "win32" && await inspectClientPortabilityWindowsPathBoundary({
      root: root.canonicalRoot,
      temporaryParent: root.canonicalParent,
      includeTree: false,
      deadline: Date.now() + CLEANUP_TIMEOUT_MS,
    }) !== "safe") throw new Error("invalid");
    if (!samePath(await realpath(receiptPath), receiptPath)) throw new Error("invalid");
    await unlink(temporaryPath);
    await file.close();
    file = undefined;
    return receiptPath;
  } catch (error) {
    if (file !== undefined) {
      if (published) {
        try {
          const [sourceMetadata, receiptMetadata] = await Promise.all([
            file.stat(),
            lstat(receiptPath),
          ]);
          if (
            sourceMetadata.dev === receiptMetadata.dev
            && sourceMetadata.ino === receiptMetadata.ino
          ) await unlink(receiptPath);
        } catch { /* Never unlink a path whose published identity is uncertain. */ }
      }
      try { await file.close(); } catch { /* Preserve the original failure. */ }
    }
    try { await unlink(temporaryPath); } catch { /* The root remains preserved. */ }
    throw error;
  }
};

export const finalizeClientPortabilityCleanup = async (
  input: PortabilityCleanupInput,
): Promise<PortabilityCleanupResult> => {
  let root: ValidatedRoot;
  try {
    root = await validateRootBoundary(input.runId, input.root, input.temporaryParent);
  } catch {
    return preserved("root");
  }

  let authority: CleanupAuthority;
  try {
    authority = await issueAutomaticAuthority(input, root);
  } catch {
    return preserved("root");
  }
  if (!hasSettlementCapability(authority)) {
    if (authority.category === "settlement" && authority.recoverable) {
      try {
        return preserved("settlement", await writeAtomicReceipt(root, authority.identities));
      } catch {
        return preserved("settlement");
      }
    }
    return preserved(authority.category);
  }
  try {
    return Object.freeze({
      status: "removed" as const,
      removedEntries: await removeBoundedRoot(authority),
    });
  } catch (error) {
    if (error instanceof CleanupFailedError) {
      return Object.freeze({
        status: "cleanup_failed" as const,
        category: "root" as const,
        residuePath: error.residuePath,
        removedEntries: error.removedEntries,
      });
    }
    return preserved("root");
  }
};

export const cleanupPreservedClientPortabilityRoot = async (
  receiptPathInput: string,
): Promise<PortabilityCleanupResult> => {
  let receipt: RecoveryReceipt;
  let root: ValidatedRoot;
  let receiptPath: string;
  let receiptDevice: number;
  let receiptInode: number;
  let receiptDigest: string;
  try {
    if (
      typeof receiptPathInput !== "string"
      || !isAbsolute(receiptPathInput)
      || receiptPathInput !== resolve(receiptPathInput)
      || basename(receiptPathInput) !== RECEIPT_BASENAME
    ) throw new Error("invalid");
    receiptPath = receiptPathInput;
    const metadata = await lstat(receiptPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error("invalid");
    }
    const file = await open(receiptPath, "r");
    let bytes: Uint8Array;
    try {
      const openedMetadata = await file.stat();
      if (
        !openedMetadata.isFile()
        || openedMetadata.dev !== metadata.dev
        || openedMetadata.ino !== metadata.ino
      ) throw new Error("invalid");
      bytes = await readBoundedReceipt(file);
      receiptDevice = openedMetadata.dev;
      receiptInode = openedMetadata.ino;
    }
    finally { await file.close(); }
    receiptDigest = createHash("sha256").update(bytes).digest("hex");
    receipt = parseRecoveryReceipt(bytes);
    if (!samePath(dirname(receiptPath), receipt.root)) throw new Error("invalid");
    root = await validateRootBoundary(receipt.runId, receipt.root, dirname(receipt.root));
    if (!samePath(await realpath(receiptPath), receiptPath)) throw new Error("invalid");
  } catch {
    return preserved("root");
  }

  const preserveValidatedReceipt = async (
    category: "settlement" | "workspace" | "root",
  ): Promise<PortabilityCleanupResult> => {
    try {
      const metadata = await lstat(receiptPath);
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.dev !== receiptDevice
        || metadata.ino !== receiptInode
        || !samePath(await realpath(receiptPath), receiptPath)
      ) return preserved(category);
      const file = await open(receiptPath, "r");
      let bytes: Uint8Array;
      try {
        const openedMetadata = await file.stat();
        if (
          openedMetadata.dev !== receiptDevice
          || openedMetadata.ino !== receiptInode
        ) return preserved(category);
        bytes = await readBoundedReceipt(file);
      } finally { await file.close(); }
      if (createHash("sha256").update(bytes).digest("hex") !== receiptDigest) {
        return preserved(category);
      }
      parseRecoveryReceipt(bytes);
      await validateRootBoundary(receipt.runId, receipt.root, dirname(receipt.root));
      return preserved(category, receiptPath);
    } catch {
      return preserved(category);
    }
  };

  if (process.platform !== "win32") return preserveValidatedReceipt("settlement");
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  for (const identity of receipt.identities) {
    if (Date.now() >= deadline) return preserveValidatedReceipt("settlement");
    let status: string;
    try { status = (await probeWindowsProcessIdentity(identity, deadline)).status; }
    catch { return preserveValidatedReceipt("settlement"); }
    if (status === "present" || (status !== "absent" && status !== "identity_mismatch")) {
      return preserveValidatedReceipt("settlement");
    }
  }
  if (!await repeatHandleReleaseProbe(root)) return preserveValidatedReceipt("workspace");
  const authority = capability(root, receipt.identities);
  try {
    return Object.freeze({
      status: "removed" as const,
      removedEntries: await removeBoundedRoot(authority),
    });
  } catch (error) {
    if (error instanceof CleanupFailedError) {
      return Object.freeze({
        status: "cleanup_failed" as const,
        category: "root" as const,
        residuePath: error.residuePath,
        removedEntries: error.removedEntries,
      });
    }
    return preserveValidatedReceipt("root");
  }
};
