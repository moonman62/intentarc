import { spawn } from "node:child_process";
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveWindowsPowerShellInvocation } from "../src/system/windows-powershell.js";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PUBLISHER_BYTES = 64 * 1024;
const MAX_AGGREGATE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_DIRECTORIES = 128;
const MAX_ENTRIES = 512;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 2_000;
const responseKeys = ["category", "id", "manifestBytes", "ok", "publisherBytes", "rows"];

const coordinatorError = () => new Error("IntentArc signed artifact coordinator failed.");
const cleanupError = () => new Error("IntentArc signed artifact cleanup failed.");

const FIXED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = $null
$manifestRecord = $null
$publisherRecord = $null
$artifactRecords = [System.Collections.ArrayList]::new()
$directoryRecords = [System.Collections.ArrayList]::new()
$ancestorHandles = [System.Collections.ArrayList]::new()
$directoryByRelative = $null
$rootBarrier = $null
$openedExpected = $false
$settled = $false
$expectedChildren = $null
$selfTestHook = $null
$selfTestFired = $false
$selfTestOutcome = ''
$identityPreopenedRecord = $null

$bootstrapAssembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  [Reflection.AssemblyName]::new('IntentArc.JobBootstrap'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$bootstrapModule = $bootstrapAssembly.DefineDynamicModule('IntentArc.JobBootstrap')
$bootstrapBuilder = $bootstrapModule.DefineType('IntentArcJobBootstrap',
  [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
$pinvokeAttributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
$preserveSignature = [Reflection.MethodImplAttributes]::PreserveSig
$createJob = $bootstrapBuilder.DefinePInvokeMethod('CreateJobObject', 'kernel32.dll', $pinvokeAttributes,
  [Reflection.CallingConventions]::Standard, [IntPtr], [Type[]]@([IntPtr], [string]),
  [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
$createJob.SetImplementationFlags($createJob.GetMethodImplementationFlags() -bor $preserveSignature)
$setJob = $bootstrapBuilder.DefinePInvokeMethod('SetInformationJobObject', 'kernel32.dll', $pinvokeAttributes,
  [Reflection.CallingConventions]::Standard, [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32]),
  [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::None)
$setJob.SetImplementationFlags($setJob.GetMethodImplementationFlags() -bor $preserveSignature)
$assignJob = $bootstrapBuilder.DefinePInvokeMethod('AssignProcessToJobObject', 'kernel32.dll', $pinvokeAttributes,
  [Reflection.CallingConventions]::Standard, [bool], [Type[]]@([IntPtr], [IntPtr]),
  [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::None)
$assignJob.SetImplementationFlags($assignJob.GetMethodImplementationFlags() -bor $preserveSignature)
$bootstrap = $bootstrapBuilder.CreateType()
$jobHandle = $bootstrap::CreateJobObject([IntPtr]::Zero, $null)
if ($jobHandle -eq [IntPtr]::Zero) { throw 'bootstrap' }
$jobInformation = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
try {
  for ($offset=0; $offset -lt 144; $offset += 4) { [Runtime.InteropServices.Marshal]::WriteInt32($jobInformation, $offset, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($jobInformation, 16, 0x2000)
  if (-not $bootstrap::SetInformationJobObject($jobHandle, 9, $jobInformation, 144) -or
    -not $bootstrap::AssignProcessToJobObject($jobHandle, [Diagnostics.Process]::GetCurrentProcess().Handle)) { throw 'bootstrap' }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($jobInformation) }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class IntentArcBundleNative {
  public static string SelfTestOutcome = "";
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME CreationTime; public FILETIME LastAccessTime;
    public FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh;
    public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandle(SafeFileHandle handle,
    out BY_HANDLE_FILE_INFORMATION info);

  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }
  [StructLayout(LayoutKind.Sequential)]
  private struct OVERLAPPED_NATIVE {
    public IntPtr Internal; public IntPtr InternalHigh; public uint Offset; public uint OffsetHigh; public IntPtr Event;
  }
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes,
    out IO_STATUS_BLOCK status, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition,
    uint options, IntPtr eaBuffer, uint eaLength);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
    IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern SafeFileHandle ReOpenFile(SafeFileHandle original, uint access, uint share, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool ReadDirectoryChangesW(SafeFileHandle directory, IntPtr buffer, uint length,
    bool subtree, uint filter, out uint returned, IntPtr overlapped, IntPtr completionRoutine);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetOverlappedResult(SafeFileHandle handle, IntPtr overlapped, out uint transferred, bool wait);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr handle);

  private const uint GENERIC_READ = 0x80000000;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint FILE_LIST_DIRECTORY = 0x00000001;
  private const uint FILE_SHARE_READ = 1;
  private const uint FILE_OPEN = 1;
  private const uint FILE_DIRECTORY_FILE = 1;
  private const uint FILE_NON_DIRECTORY_FILE = 0x40;
  private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
  private const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x4000;
  private const uint FILE_OPEN_REPARSE_POINT = 0x200000;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_FLAG_OVERLAPPED = 0x40000000;

  private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, bool directory, bool asynchronous) {
    IntPtr text = Marshal.StringToHGlobalUni(name);
    IntPtr unicode = IntPtr.Zero;
    try {
      UNICODE_STRING value = new UNICODE_STRING {
        Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)((name.Length + 1) * 2)), Buffer = text
      };
      unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UNICODE_STRING>());
      Marshal.StructureToPtr(value, unicode, false);
      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf<OBJECT_ATTRIBUTES>(), RootDirectory = parent.DangerousGetHandle(),
        ObjectName = unicode, Attributes = 0x40
      };
      IO_STATUS_BLOCK status;
      uint options = FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT |
        (asynchronous ? 0 : FILE_SYNCHRONOUS_IO_NONALERT) | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
      uint access = GENERIC_READ | (asynchronous ? 0 : SYNCHRONIZE) | (directory ? FILE_LIST_DIRECTORY : 0);
      SafeFileHandle handle;
      int result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, 0,
        FILE_SHARE_READ, FILE_OPEN, options, IntPtr.Zero, 0);
      if (result < 0 || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new IOException("open"); }
      return handle;
    } finally {
      if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
      Marshal.FreeHGlobal(text);
    }
  }

  public static SafeFileHandle OpenRelativeDirectory(SafeFileHandle parent, string name) { return OpenRelative(parent, name, true, false); }
  public static SafeFileHandle OpenRelativeFile(SafeFileHandle parent, string name) { return OpenRelative(parent, name, false, false); }
  private static SafeFileHandle OpenRelativeWatcher(SafeFileHandle parent, string name) { return OpenRelative(parent, name, true, true); }

  public static SafeFileHandle[] OpenAnchoredDirectory(string absolutePath, string selfTestHook) {
    string full = Path.GetFullPath(absolutePath);
    string volume = Path.GetPathRoot(full);
    if (volume == null || volume.Length != 3 || volume[1] != ':') throw new IOException("root");
    var handles = new List<SafeFileHandle>();
    SafeFileHandle current = CreateFile(volume, FILE_LIST_DIRECTORY | SYNCHRONIZE, FILE_SHARE_READ,
      IntPtr.Zero, 3, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (current.IsInvalid) { current.Dispose(); throw new IOException("root"); }
    handles.Add(current);
    try {
      string remainder = full.Substring(volume.Length);
      string[] parts = remainder.Split(new [] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
      for (int index = 0; index < parts.Length; index++) {
        string part = parts[index];
        try { current = OpenRelativeDirectory(current, part); }
        catch {
          if (selfTestHook == "initial-real-reparse-swap" && index == parts.Length - 1) SelfTestOutcome = "reparse-authority";
          throw;
        }
        handles.Add(current);
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(current, out info) || (info.Attributes & 0x410) != 0x10 || info.NumberOfLinks != 1) {
          if (selfTestHook == "initial-real-reparse-swap" && (info.Attributes & 0x400) != 0) SelfTestOutcome = "reparse-authority";
          throw new IOException("ancestry");
        }
      }
      return handles.ToArray();
    } catch { foreach (SafeFileHandle handle in handles) handle.Dispose(); throw; }
  }

  public static string[] EnumerateDirectory(SafeFileHandle directory, int maximumEntries) {
    if (maximumEntries < 0) throw new IOException("entry-budget");
    const int size = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    var names = new List<string>();
    try {
      bool restart = true;
      while (true) {
        bool ok = GetFileInformationByHandleEx(directory, restart ? 11 : 10, buffer, size);
        restart = false;
        if (!ok) {
          int error = Marshal.GetLastWin32Error();
          if (error == 18) break;
          throw new Win32Exception(error);
        }
        int offset = 0;
        while (true) {
          int next = Marshal.ReadInt32(buffer, offset);
          int length = Marshal.ReadInt32(buffer, offset + 60);
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), length / 2);
          if (name != "." && name != "..") {
            if (names.Count >= maximumEntries) {
              SelfTestOutcome = "in-loop-entry-budget";
              throw new IOException("entry-budget");
            }
            names.Add(name);
          }
          if (next == 0) break;
          offset += next;
        }
      }
      return names.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public sealed class DirectoryBarrier : IDisposable {
    private static int Pending;
    private sealed class Operation : IDisposable {
      internal SafeFileHandle Handle; internal IntPtr Buffer; internal IntPtr Overlapped; internal IntPtr Event;
      private bool issued; private bool terminal; private bool disposed; internal bool CompletedCancellation;
      internal Operation(SafeFileHandle parent, string leaf, bool subtree) : this(parent, leaf, subtree, false, 65536) {}
      internal Operation(SafeFileHandle parent, string leaf, bool subtree, bool failAfterIssue, int bufferSize) {
        try {
          Handle = OpenRelativeWatcher(parent, leaf);
          Buffer = Marshal.AllocHGlobal(bufferSize);
          Event = CreateEvent(IntPtr.Zero, true, false, null);
          if (Event == IntPtr.Zero) throw new IOException("watch-event");
          OVERLAPPED_NATIVE value = new OVERLAPPED_NATIVE { Event = Event };
          Overlapped = Marshal.AllocHGlobal(Marshal.SizeOf<OVERLAPPED_NATIVE>());
          Marshal.StructureToPtr(value, Overlapped, false);
          uint ignored;
          if (!ReadDirectoryChangesW(Handle, Buffer, (uint)bufferSize, subtree, 0x00000003, out ignored, Overlapped, IntPtr.Zero))
            throw new IOException("watch-read");
          issued = true;
          System.Threading.Interlocked.Increment(ref Pending);
          if (failAfterIssue) throw new IOException("watch-construction");
        } catch {
          try { Release(); } catch {}
          throw;
        }
      }
      private static bool Classify(bool success, uint bytes, int error, bool cancellationRequested) {
        if (success) {
          if (bytes == 0) throw new IOException("watch-lost");
          return true;
        }
        if (cancellationRequested && error == 995) return false;
        throw new IOException("watch-terminal");
      }
      internal bool Complete(bool cancel) {
        if (terminal) return !CompletedCancellation;
        bool cancellationRequested = false;
        if (cancel) {
          cancellationRequested = CancelIoEx(Handle, Overlapped);
          if (!cancellationRequested && Marshal.GetLastWin32Error() != 1168) throw new IOException("watch-cancel");
        }
        if (WaitForSingleObject(Event, 0xFFFFFFFF) != 0) throw new IOException("watch-wait");
        uint bytes;
        bool success = GetOverlappedResult(Handle, Overlapped, out bytes, false);
        int error = success ? 0 : Marshal.GetLastWin32Error();
        terminal = true;
        System.Threading.Interlocked.Decrement(ref Pending);
        bool changed = Classify(success, bytes, error, cancellationRequested);
        CompletedCancellation = !changed && error == 995;
        return changed;
      }
      private void Release() {
        Exception failure = null;
        if (issued && !terminal) { try { Complete(true); } catch (Exception error) { failure = error; } }
        if (!issued || terminal) {
          if (Handle != null) { Handle.Dispose(); Handle = null; }
          if (Event != IntPtr.Zero) { CloseHandle(Event); Event = IntPtr.Zero; }
          if (Overlapped != IntPtr.Zero) { Marshal.FreeHGlobal(Overlapped); Overlapped = IntPtr.Zero; }
          if (Buffer != IntPtr.Zero) { Marshal.FreeHGlobal(Buffer); Buffer = IntPtr.Zero; }
        }
        disposed = true;
        if (failure != null) throw new IOException("watch-cleanup", failure);
      }
      public void Dispose() { if (!disposed) Release(); }
      internal static void AssertZeroByteFails() { Classify(true, 0, 0, true); }
    }
    private readonly SafeFileHandle parent; private readonly string leaf; private readonly bool subtree; private Operation current;
    public DirectoryBarrier(SafeFileHandle parent, string leaf, bool subtree) {
      this.parent = parent; this.leaf = leaf; this.subtree = subtree; current = new Operation(parent, leaf, subtree);
    }
    public bool Rotate() {
      Operation next = new Operation(parent, leaf, subtree);
      try { return current.Complete(true); }
      finally { current.Dispose(); current = next; }
    }
    public bool Finish() { try { return current.Complete(true); } finally { try { current.Dispose(); } finally { current = null; } } }
    public void Dispose() { if (current != null) { try { current.Dispose(); } finally { current = null; } } }
    public static bool SelfTestZeroByte() {
      try { Operation.AssertZeroByteFails(); return false; } catch (IOException) { return true; }
    }
    public static bool SelfTestPendingDispose(SafeFileHandle parent, string leaf) {
      int before = Pending;
      Operation operation = new Operation(parent, leaf, false);
      if (Pending != before + 1) return false;
      operation.Dispose();
      return operation.CompletedCancellation && Pending == before;
    }
    public static bool SelfTestPartialConstructor(SafeFileHandle parent, string leaf) {
      int before = Pending;
      try { new Operation(parent, leaf, false, true, 65536); return false; }
      catch (IOException) { return Pending == before; }
    }
    public static string SelfTestDelayedCompletion(SafeFileHandle parent, string leaf, string path) {
      Operation operation = new Operation(parent, leaf, true);
      string mutation = Path.Combine(path, "delayed-kernel-notification.bin");
      var writer = new System.Threading.Thread(() => {
        System.Threading.Thread.Sleep(100);
        File.WriteAllBytes(mutation, new byte[] { 7, 8, 9 });
      });
      writer.IsBackground = true;
      writer.Start();
      bool pendingBeforeWait = !writer.Join(0);
      try { return pendingBeforeWait && operation.Complete(false) ? "delayed-kernel-change" : "unexpected"; }
      finally { writer.Join(); operation.Dispose(); }
    }
    public static string SelfTestOverflow(SafeFileHandle parent, string leaf, string path) {
      Operation operation = new Operation(parent, leaf, true, false, 64);
      string mutation = Path.Combine(path, "overflow-" + new string('x', 96) + ".bin");
      File.WriteAllBytes(mutation, new byte[] { 1 });
      try {
        operation.Complete(false);
        return "unexpected";
      } catch (IOException error) { return error.Message == "watch-lost" ? "notification-lost-evidence" : "unexpected"; }
      finally { operation.Dispose(); }
    }
  }
}
'@

function Send-Response([int]$id, [bool]$ok, [string]$category, [string]$manifestBytes,
  [string]$publisherBytes, [object[]]$rows) {
  [ordered]@{ category=$category; id=$id; manifestBytes=$manifestBytes; ok=$ok;
    publisherBytes=$publisherBytes; rows=@($rows) } |
    ConvertTo-Json -Compress -Depth 5 | Write-Output
  [Console]::Out.Flush()
}

function Get-Info($handle) {
  $info = New-Object IntentArcBundleNative+BY_HANDLE_FILE_INFORMATION
  if (-not [IntentArcBundleNative]::GetFileInformationByHandle($handle, [ref]$info)) { throw 'coordinator' }
  return $info
}

function Get-Length($info) {
  return ([long]$info.FileSizeHigh * 4294967296L) + [long]$info.FileSizeLow
}

function Same-Identity($left, $right) {
  return $left.VolumeSerialNumber -eq $right.VolumeSerialNumber -and
    $left.FileIndexHigh -eq $right.FileIndexHigh -and $left.FileIndexLow -eq $right.FileIndexLow
}

function Open-OrdinaryFile($parent, [string]$leaf, [long]$maximum, [long]$exact) {
  $handle = [IntentArcBundleNative]::OpenRelativeFile($parent, $leaf)
  try {
    $info = Get-Info $handle
    if (($info.Attributes -band 0x10) -ne 0 -or ($info.Attributes -band 0x400) -ne 0 -or
      $info.NumberOfLinks -ne 1) { throw 'coordinator' }
    $length = Get-Length $info
    if ($length -lt 0 -or $length -gt $maximum -or ($exact -ge 0 -and $length -ne $exact)) {
      throw 'coordinator'
    }
    $stream = [System.IO.FileStream]::new($handle, [System.IO.FileAccess]::Read, 65536, $false)
    return [pscustomobject]@{ Parent=$parent; Leaf=$leaf; Stream=$stream; Info=$info; Length=$length; Sha256=$null }
  } catch {
    $handle.Dispose()
    throw
  }
}

function New-DirectoryRecord([string]$relative, $parent, [string]$leaf, $handle) {
  $info = Get-Info $handle
  if (($info.Attributes -band 0x10) -eq 0 -or ($info.Attributes -band 0x400) -ne 0 -or
    $info.NumberOfLinks -ne 1) { $handle.Dispose(); throw 'coordinator' }
  try { $barrier = [IntentArcBundleNative+DirectoryBarrier]::new($parent, $leaf, $false) }
  catch { throw ([string]$_.Exception.InnerException.Message) }
  $testPath = if ($relative.Length -eq 0) { $root } else { [System.IO.Path]::Combine($root, $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)) }
  return [pscustomobject]@{ Relative=$relative; Parent=$parent; Leaf=$leaf; Handle=$handle; Info=$info; Barrier=$barrier; TestPath=$testPath }
}

function Hash-Record($record) {
  $record.Stream.Position = 0
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($record.Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $record.Stream.Position = 0 }
}

function Read-Record($record) {
  $bytes = New-Object byte[] ([int]$record.Length)
  $offset = 0
  $record.Stream.Position = 0
  while ($offset -lt $bytes.Length) {
    $count = $record.Stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -eq 0) { throw 'coordinator' }
    $offset += $count
  }
  $record.Stream.Position = 0
  return $bytes
}

function Assert-PathIdentity($record, [bool]$directory) {
  if ($directory) {
    $reopened = [IntentArcBundleNative]::OpenRelativeDirectory($record.Parent, $record.Leaf)
    try {
      if ($reopened.IsInvalid -or -not (Same-Identity $record.Info (Get-Info $reopened))) {
        if ($selfTestHook -eq 'preopen-real-file-substitution' -or $selfTestHook -eq 'postopen-real-file-substitution') { $script:selfTestOutcome='identity-mismatch' }
        throw 'coordinator'
      }
    } finally { $reopened.Dispose() }
  } else {
    $reopened = Open-OrdinaryFile $record.Parent $record.Leaf $record.Length $record.Length
    try {
      if (-not (Same-Identity $record.Info $reopened.Info)) {
        if ($selfTestHook -eq 'preopen-real-file-substitution' -or $selfTestHook -eq 'postopen-real-file-substitution') { $script:selfTestOutcome='identity-mismatch' }
        throw 'coordinator'
      }
    }
    finally { $reopened.Stream.Dispose() }
  }
}

function Invoke-SelfTestHook([string]$point, $directory) {
  if (-not $selfTestFired -and $selfTestHook -eq $point) {
    $script:selfTestFired = $true
    [System.IO.File]::WriteAllBytes([System.IO.Path]::Combine($directory.TestPath, 'unlisted-after-snapshot.bin'), [byte[]](1,2,3))
  }
}

function Invoke-SettlementAncestorSwapHook {
  if (-not $selfTestFired -and $selfTestHook -eq 'settlement-real-ancestor-swap') {
    $script:selfTestFired = $true
    $swap = $root + '.swap'
    try {
      [System.IO.Directory]::Move($root, $swap)
    } catch {
      [System.IO.File]::WriteAllText($root + '.attack-denied', 'denied')
    }
  }
}

function Get-TestArtifactPath([string]$relative) {
  return [System.IO.Path]::Combine($root, $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
}

function Open-ReplaceableAbsolute([string]$path, [string]$leaf) {
  $handle = [IntentArcBundleNative]::CreateFile($path, [uint32]2147483648, [uint32]5, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle.IsInvalid) { $handle.Dispose(); throw 'coordinator' }
  $info = Get-Info $handle
  if (($info.Attributes -band 0x10) -ne 0 -or ($info.Attributes -band 0x400) -ne 0 -or $info.NumberOfLinks -ne 1) { $handle.Dispose(); throw 'coordinator' }
  $stream = [System.IO.FileStream]::new($handle, [System.IO.FileAccess]::Read, 65536, $false)
  return [pscustomobject]@{ Parent=$null; Leaf=$leaf; Stream=$stream; Info=$info; Length=(Get-Length $info); Sha256=$null }
}

function Prepare-IdentitySelfTest {
  $preview = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($root, 'bundle.json')) | ConvertFrom-Json
  $relative = [string]$preview.files[0].path
  $separator = $relative.LastIndexOf('/')
  $leaf = if ($separator -lt 0) { $relative } else { $relative.Substring($separator + 1) }
  $path = Get-TestArtifactPath $relative
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $original = Open-ReplaceableAbsolute $path $leaf
  [System.IO.File]::Move($path, $root + '.identity-original')
  [System.IO.File]::WriteAllBytes($path, $bytes)
  if ($selfTestHook -eq 'postopen-real-file-substitution') {
    $replacement = Open-ReplaceableAbsolute $path $leaf
    $original.Stream.Dispose()
    [System.IO.File]::Move($path, $root + '.identity-replacement')
    [System.IO.File]::Move($root + '.identity-original', $path)
    $script:identityPreopenedRecord = $replacement
  } else { $script:identityPreopenedRecord = $original }
  $script:selfTestFired = $true
}

function Start-HungDescendant {
  $lockPath = [System.IO.Path]::Combine($root, 'hung-descendant.lock')
  $readyPath = [System.IO.Path]::Combine($root, 'hung-descendant.ready')
  $quotedLock = $lockPath.Replace("'", "''")
  $quotedReady = $readyPath.Replace("'", "''")
  $body = '$stream=[IO.File]::Open(''' + $quotedLock + ''',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[IO.File]::WriteAllText(''' + $quotedReady + ''',''ready'');while($true){[Threading.Thread]::Sleep(1000)}'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $info.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  [void][Diagnostics.Process]::Start($info)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($readyPath)) {
    if ($watch.ElapsedMilliseconds -gt 5000) { throw 'coordinator' }
    [Threading.Thread]::Sleep(10)
  }
}

function Assert-Topology {
  $entryCount = 0
  $deepest = $directoryRecords | Sort-Object { $_.Relative.Length } -Descending | Select-Object -First 1
  foreach ($record in $directoryRecords) {
    $actual = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $remainingEntries = ${MAX_ENTRIES} - $entryCount
    foreach ($entry in [IntentArcBundleNative]::EnumerateDirectory($record.Handle, $remainingEntries)) {
      $entryCount += 1
      if ($entryCount -gt ${MAX_ENTRIES}) { throw 'coordinator' }
      if (-not $actual.Add($entry)) { throw 'coordinator' }
    }
    if ($record.Relative -eq $deepest.Relative) { Invoke-SelfTestHook 'after-inner-snapshot' $record }
    $expected = $expectedChildren[$record.Relative]
    if ($actual.Count -ne $expected.Count) { throw 'coordinator' }
    foreach ($name in $actual) { if (-not $expected.Contains($name)) { throw 'coordinator' } }
    Assert-PathIdentity $record $true
    if ($record.Relative -eq $deepest.Relative) { Invoke-SelfTestHook 'after-inner-identity' $record }
  }
}

function Dispose-All {
  $failed = $false
  if ($identityPreopenedRecord -ne $null) { try { $identityPreopenedRecord.Stream.Dispose() } catch { $failed=$true }; $script:identityPreopenedRecord=$null }
  foreach ($record in $artifactRecords) { try { $record.Stream.Dispose() } catch { $failed = $true } }
  $artifactRecords.Clear()
  if ($publisherRecord -ne $null) { try { $publisherRecord.Stream.Dispose() } catch { $failed = $true }; $script:publisherRecord=$null }
  if ($manifestRecord -ne $null) { try { $manifestRecord.Stream.Dispose() } catch { $failed = $true }; $script:manifestRecord=$null }
  foreach ($record in $directoryRecords) {
    try { $record.Barrier.Dispose() } catch { $failed=$true }
    try { $record.Handle.Dispose() } catch { $failed=$true }
  }
  $directoryRecords.Clear()
  if ($rootBarrier -ne $null) { try { $rootBarrier.Dispose() } catch { $failed=$true }; $script:rootBarrier=$null }
  foreach ($handle in $ancestorHandles) { try { $handle.Dispose() } catch { $failed=$true } }
  $ancestorHandles.Clear()
  if ($jobHandle -ne $null) { }
  if ($failed) { throw 'cleanup' }
}

try {
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    $id = 0
    try {
      $request = $line | ConvertFrom-Json
      $id = [int]$request.id
      $names = @($request.PSObject.Properties.Name | Sort-Object)
      if (($names -join ',') -ne 'bundleRoot,command,id,manifest,selfTestHook') { throw 'coordinator' }
      if ($request.command -eq 'readManifest') {
        if ($root -ne $null) { throw 'coordinator' }
        $selfTestHook = [string]$request.selfTestHook
        $root = [System.IO.Path]::GetFullPath([string]$request.bundleRoot)
        if ($selfTestHook -eq 'preopen-real-file-substitution' -or $selfTestHook -eq 'postopen-real-file-substitution') { Prepare-IdentitySelfTest }
        $anchored = @([IntentArcBundleNative]::OpenAnchoredDirectory($root, $selfTestHook))
        if ($anchored.Count -lt 2) { throw 'coordinator' }
        for ($index=0; $index -lt $anchored.Count - 1; $index += 1) { [void]$ancestorHandles.Add($anchored[$index]) }
        $rootHandle = $anchored[-1]
        $rootParent = $anchored[-2]
        $rootLeaf = [System.IO.Path]::GetFileName($root.TrimEnd([System.IO.Path]::DirectorySeparatorChar))
        if ($selfTestHook -eq 'zero-byte-success' -and -not [IntentArcBundleNative+DirectoryBarrier]::SelfTestZeroByte()) { throw 'coordinator' }
        if ($selfTestHook -eq 'pending-watcher-dispose' -and -not [IntentArcBundleNative+DirectoryBarrier]::SelfTestPendingDispose($rootParent, $rootLeaf)) { throw 'coordinator' }
        if ($selfTestHook -eq 'constructor-partial-failure' -and -not [IntentArcBundleNative+DirectoryBarrier]::SelfTestPartialConstructor($rootParent, $rootLeaf)) { throw 'coordinator' }
        $manifestRecord = Open-OrdinaryFile $rootHandle 'bundle.json' ${MAX_MANIFEST_BYTES} -1
        $manifestRecord.Sha256 = Hash-Record $manifestRecord
        $bytes = Read-Record $manifestRecord
        Send-Response $id $true '' ([Convert]::ToBase64String($bytes)) '' @()
      } elseif ($request.command -eq 'openExpected') {
        if ($manifestRecord -eq $null -or $openedExpected -or $request.manifest -eq $null) { throw 'coordinator' }
        $selfTestHook = [string]$request.selfTestHook
        $files = @($request.manifest.files)
        if ($files.Count -lt 1 -or $files.Count -gt 64) { throw 'coordinator' }
        $expectedChildren = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
        $expectedChildren.Add('', [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal))
        [void]$expectedChildren[''].Add('bundle.json'); [void]$expectedChildren[''].Add('publisher.cer')
        $total = 0L
        foreach ($file in $files) {
          $relative = [string]$file.path
          if ($relative.Length -eq 0 -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '^[A-Za-z]:') { throw 'coordinator' }
          $segments = @($relative.Split('/'))
          if ($segments.Count - 1 -gt ${MAX_DEPTH}) { throw 'coordinator' }
          $directory = ''
          for ($index=0; $index -lt $segments.Count - 1; $index += 1) {
            $child = $segments[$index]
            [void]$expectedChildren[$directory].Add($child)
            $directory = if ($directory.Length -eq 0) { $child } else { $directory + '/' + $child }
            if (-not $expectedChildren.ContainsKey($directory)) {
              $expectedChildren.Add($directory, [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal))
            }
          }
          if (-not $expectedChildren[$directory].Add($segments[-1])) { throw 'coordinator' }
          $length = [long]$file.bytes
          if ($length -lt 0 -or $total -gt (${MAX_AGGREGATE_BYTES}L - $length)) { throw 'coordinator' }
          $total += $length
        }
        if ($expectedChildren.Count -gt ${MAX_DIRECTORIES}) { throw 'coordinator' }
        $expectedEntryCount = 0
        foreach ($children in $expectedChildren.Values) { $expectedEntryCount += $children.Count }
        if ($expectedEntryCount -gt ${MAX_ENTRIES}) { throw 'coordinator' }
        $directoryByRelative = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
        $rootRecord = New-DirectoryRecord '' $rootParent $rootLeaf $rootHandle
        [void]$directoryRecords.Add($rootRecord); $directoryByRelative.Add('', $rootRecord)
        $rootBarrier = [IntentArcBundleNative+DirectoryBarrier]::new($rootParent, $rootLeaf, $true)
        foreach ($directory in ($expectedChildren.Keys | Where-Object { $_ -ne '' } | Sort-Object { @($_.Split('/')).Count })) {
          $separator = $directory.LastIndexOf('/')
          $parentRelative = if ($separator -lt 0) { '' } else { $directory.Substring(0, $separator) }
          $leaf = if ($separator -lt 0) { $directory } else { $directory.Substring($separator + 1) }
          $parentRecord = $directoryByRelative[$parentRelative]
          $handle = [IntentArcBundleNative]::OpenRelativeDirectory($parentRecord.Handle, $leaf)
          $record = New-DirectoryRecord $directory $parentRecord.Handle $leaf $handle
          [void]$directoryRecords.Add($record); $directoryByRelative.Add($directory, $record)
        }
        Assert-Topology
        if ($rootBarrier.Rotate()) { throw 'coordinator' }
        Assert-PathIdentity $manifestRecord $false
        $publisherRecord = Open-OrdinaryFile $rootHandle 'publisher.cer' ${MAX_PUBLISHER_BYTES} -1
        if ($publisherRecord.Length -eq 0) { throw 'coordinator' }
        $publisherRecord.Sha256 = Hash-Record $publisherRecord
        if ($publisherRecord.Sha256 -ne [string]$request.manifest.publisher.cerSha256) { throw 'coordinator' }
        $publisherBytes = Read-Record $publisherRecord
        $rows = [System.Collections.ArrayList]::new()
        $remaining = ${MAX_AGGREGATE_BYTES}L
        foreach ($file in $files) {
          $length = [long]$file.bytes
          $relative = [string]$file.path
          $separator = $relative.LastIndexOf('/')
          $parentRelative = if ($separator -lt 0) { '' } else { $relative.Substring(0, $separator) }
          $leaf = if ($separator -lt 0) { $relative } else { $relative.Substring($separator + 1) }
          if ($identityPreopenedRecord -ne $null) {
            $record=$identityPreopenedRecord; $script:identityPreopenedRecord=$null
            $record.Parent=$directoryByRelative[$parentRelative].Handle; $record.Leaf=$leaf
          } else { $record = Open-OrdinaryFile $directoryByRelative[$parentRelative].Handle $leaf $length $length }
          if ($record.Length -ne $length) { $record.Stream.Dispose(); throw 'coordinator' }
          if ($length -gt $remaining) { $record.Stream.Dispose(); throw 'coordinator' }
          $remaining -= $length
          $record.Sha256 = Hash-Record $record
          if ($record.Sha256 -ne [string]$file.sha256) { $record.Stream.Dispose(); throw 'coordinator' }
          [void]$artifactRecords.Add($record)
          [void]$rows.Add([ordered]@{ bytes=$record.Length; path=[string]$file.path; sha256=$record.Sha256 })
        }
        if ($selfTestHook -eq 'hung-descendant-cleanup') { Start-HungDescendant }
        $openedExpected = $true
        Send-Response $id $true '' '' ([Convert]::ToBase64String($publisherBytes)) @($rows)
      } elseif ($request.command -eq 'settle') {
        if (-not $openedExpected -or $settled) { throw 'coordinator' }
        Assert-Topology
        Invoke-SettlementAncestorSwapHook
        if ($selfTestHook -eq 'delayed-kernel-completion' -or $selfTestHook -eq 'notification-buffer-overflow') {
          $watchLeaf = $rootLeaf + '.watch-self-test'
          $watchPath = $root + '.watch-self-test'
          if ($selfTestHook -eq 'delayed-kernel-completion') {
            $script:selfTestOutcome=[IntentArcBundleNative+DirectoryBarrier]::SelfTestDelayedCompletion($rootParent, $watchLeaf, $watchPath)
          } else {
            $script:selfTestOutcome=[IntentArcBundleNative+DirectoryBarrier]::SelfTestOverflow($rootParent, $watchLeaf, $watchPath)
          }
        }
        Assert-PathIdentity $manifestRecord $false
        if ((Hash-Record $manifestRecord) -ne $manifestRecord.Sha256) { throw 'coordinator' }
        Assert-PathIdentity $publisherRecord $false
        if ((Hash-Record $publisherRecord) -ne $publisherRecord.Sha256) { throw 'coordinator' }
        foreach ($record in $artifactRecords) {
          Assert-PathIdentity $record $false
          if ((Hash-Record $record) -ne $record.Sha256) { throw 'coordinator' }
        }
        foreach ($record in $directoryRecords) { Assert-PathIdentity $record $true }
        foreach ($record in $directoryRecords) { if ($record.Barrier.Finish()) { throw 'coordinator' } }
        if ($rootBarrier.Rotate()) { throw 'coordinator' }
        if ($selfTestHook -eq 'post-terminal-check-mutation') {
          $script:selfTestFired = $true
          [System.IO.File]::WriteAllBytes([System.IO.Path]::Combine($root, 'post-terminal-check.bin'), [byte[]](4,5,6))
        }
        if ($rootBarrier.Finish()) { throw 'coordinator' }
        $settled = $true
        Send-Response $id $true $selfTestOutcome '' '' @()
      } elseif ($request.command -eq 'close') {
        if ($selfTestHook -eq 'hung-descendant-cleanup') { while ($true) { [Threading.Thread]::Sleep(1000) } }
        Dispose-All
        Send-Response $id $true '' '' '' @()
        break
      } else { throw 'coordinator' }
    } catch {
      $nativeOutcome = [IntentArcBundleNative]::SelfTestOutcome
      $category = if ([string]$_.Exception.Message -eq 'cleanup') { 'cleanup' } elseif ($selfTestOutcome) { $selfTestOutcome } elseif ($nativeOutcome) { $nativeOutcome } else { 'coordinator' }
      Send-Response $id $false $category '' '' @()
      if ($request.command -eq 'close') { break }
    }
  }
} finally { try { Dispose-All } catch {} }
`;
const fixedPayload = gzipSync(Buffer.from(FIXED_SCRIPT, "utf8")).toString("base64");
const INVOCATION_SCRIPT = `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${fixedPayload}'));$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);iex $r.ReadToEnd();#IntentArcBundleNative`;

const isClosedObject = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.keys(value).sort();
  return names.length === keys.length && names.every((name, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return name === keys[index] && descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
};

const isRow = (row) => isClosedObject(row, ["bytes", "path", "sha256"])
  && typeof row.path === "string"
  && Number.isSafeInteger(row.bytes)
  && row.bytes >= 0
  && typeof row.sha256 === "string"
  && /^[0-9a-f]{64}$/.test(row.sha256);

let commandLineSelfTestHook = null;
let commandLineSelfTestOutcome = "";

export const openSignedArtifactSession = async (input) => {
  if (!isClosedObject(input, ["bundleRoot"])) throw coordinatorError();
  const { bundleRoot } = input;
  if (process.platform !== "win32" || typeof bundleRoot !== "string" || bundleRoot.length === 0
    || bundleRoot.length > 32_767 || bundleRoot.includes("\0") || !isAbsolute(bundleRoot)) {
    throw coordinatorError();
  }
  const invocation = resolveWindowsPowerShellInvocation(process.env);
  const child = spawn(invocation.executablePath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", INVOCATION_SCRIPT], {
      env: { SystemRoot: invocation.environment.SystemRoot, WINDIR: invocation.environment.WINDIR },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

  let nextId = 1;
  let responseBytes = 0;
  let ended = false;
  let closed = false;
  let closing = false;
  let closePromise;
  let manifestRead = false;
  let expectedOpened = false;
  let evidence = Object.freeze([]);
  const pending = new Map();
  const termination = new Promise((resolve) => child.once("close", resolve));
  const failPending = () => {
    ended = true;
    for (const waiter of pending.values()) waiter.reject(coordinatorError());
    pending.clear();
  };
  child.once("error", failPending);
  child.once("exit", failPending);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    responseBytes += Buffer.byteLength(line, "utf8");
    if (responseBytes > MAX_RESPONSE_BYTES) { child.kill(); failPending(); return; }
    let response;
    try { response = JSON.parse(line); } catch { failPending(); return; }
    if (!isClosedObject(response, responseKeys)) { failPending(); return; }
    const waiter = pending.get(response.id);
    if (!waiter) { failPending(); return; }
    pending.delete(response.id);
    responseBytes = 0;
    if (commandLineSelfTestHook && response.category) commandLineSelfTestOutcome = response.category;
    if (response.ok !== true) waiter.reject(response.category === "cleanup" ? cleanupError() : coordinatorError());
    else waiter.resolve(response);
  });

  const request = (command, manifest = null) => new Promise((resolve, reject) => {
    if (ended || closed || (closing && command !== "close")) { reject(coordinatorError()); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const selfTestHook = commandLineSelfTestHook;
    let line;
    try {
      line = JSON.stringify({ bundleRoot, command, id, manifest, selfTestHook });
      if (Buffer.byteLength(line, "utf8") > MAX_MANIFEST_BYTES + 65_536) throw coordinatorError();
      child.stdin.write(`${line}\n`, "utf8", (error) => {
        if (error && pending.delete(id)) reject(coordinatorError());
      });
    } catch {
      pending.delete(id);
      reject(coordinatorError());
    }
  });

  const session = {
    async readManifest() {
      if (manifestRead) throw coordinatorError();
      const response = await request("readManifest");
      if (typeof response.manifestBytes !== "string") throw coordinatorError();
      const bytes = Buffer.from(response.manifestBytes, "base64");
      if (bytes.length > MAX_MANIFEST_BYTES || bytes.toString("base64") !== response.manifestBytes) throw coordinatorError();
      manifestRead = true;
      return bytes;
    },
    async openExpected(manifest) {
      if (!manifestRead || expectedOpened) throw coordinatorError();
      const response = await request("openExpected", manifest);
      if (typeof response.publisherBytes !== "string" || !Array.isArray(response.rows)
        || response.rows.length > 64 || !response.rows.every(isRow)) throw coordinatorError();
      const publisherBytes = Buffer.from(response.publisherBytes, "base64");
      if (publisherBytes.length === 0 || publisherBytes.length > MAX_PUBLISHER_BYTES
        || publisherBytes.toString("base64") !== response.publisherBytes) throw coordinatorError();
      evidence = Object.freeze(response.rows.map((row) => Object.freeze({ path: row.path, bytes: row.bytes, sha256: row.sha256 })));
      expectedOpened = true;
      return Object.freeze({ publisherBytes, rows: evidence });
    },
    get evidence() { return evidence; },
    async settle() {
      if (!expectedOpened) throw coordinatorError();
      await request("settle");
    },
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let failure;
        let responseTimer;
        try {
          await Promise.race([
            request("close"),
            new Promise((_, reject) => { responseTimer = setTimeout(() => reject(cleanupError()), CLOSE_TIMEOUT_MS); }),
          ]);
        } catch { failure = cleanupError(); }
        clearTimeout(responseTimer);
        closed = true;
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) {
          let timer;
          await Promise.race([
            termination,
            new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); }),
          ]);
          clearTimeout(timer);
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          failure = cleanupError();
          let killTimer;
          await Promise.race([
            termination,
            new Promise((resolve) => { killTimer = setTimeout(resolve, CLOSE_TIMEOUT_MS); }),
          ]);
          clearTimeout(killTimer);
        }
        if (child.exitCode === null && child.signalCode === null) failure = cleanupError();
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
  return Object.freeze(session);
};

const runSelfTest = async () => {
  const hook = process.argv[3];
  const bundleRoot = process.argv[4];
  const openingHooks = new Set([
    "after-inner-snapshot", "after-inner-identity", "initial-real-reparse-swap",
    "zero-byte-success", "pending-watcher-dispose", "constructor-partial-failure",
    "in-loop-entry-budget",
  ]);
  const settlementHooks = new Set([
    "settlement-real-ancestor-swap", "preopen-real-file-substitution",
    "postopen-real-file-substitution", "delayed-kernel-completion",
    "post-terminal-check-mutation", "notification-buffer-overflow",
  ]);
  const successHooks = new Set([
    "zero-byte-success", "pending-watcher-dispose", "constructor-partial-failure",
    "settlement-real-ancestor-swap",
  ]);
  if ((!openingHooks.has(hook) && !settlementHooks.has(hook) && hook !== "hung-descendant-cleanup") || !bundleRoot) process.exitCode = 2;
  else {
    commandLineSelfTestHook = hook;
    commandLineSelfTestOutcome = "";
    let session;
    let injectedPath;
    let rejected = false;
    const attackMarker = `${bundleRoot}.attack-denied`;
    if (hook === "initial-real-reparse-swap") {
      const target = `${bundleRoot}.replacement-target`;
      cpSync(bundleRoot, target, { recursive: true });
      renameSync(bundleRoot, `${bundleRoot}.original`);
      symlinkSync(target, bundleRoot, "junction");
    }
    if (hook === "delayed-kernel-completion" || hook === "notification-buffer-overflow") {
      mkdirSync(`${bundleRoot}.watch-self-test`);
    }
    try {
      session = await openSignedArtifactSession({ bundleRoot });
      const manifest = JSON.parse((await session.readManifest()).toString("utf8"));
      injectedPath = join(bundleRoot, dirname(manifest.files[0].path), "unlisted-after-snapshot.bin");
      await session.openExpected(manifest);
      if (settlementHooks.has(hook)) await session.settle();
      if (hook === "hung-descendant-cleanup") await session.close();
    } catch {
      rejected = true;
    } finally {
      if (session) { try { await session.close(); } catch {} }
      if (existsSync(`${bundleRoot}.original`)) {
        rmSync(bundleRoot, { recursive: true, force: true });
        renameSync(`${bundleRoot}.original`, bundleRoot);
      }
      if (existsSync(`${bundleRoot}.swap`)) renameSync(`${bundleRoot}.swap`, bundleRoot);
      rmSync(`${bundleRoot}.replacement`, { recursive: true, force: true });
      rmSync(`${bundleRoot}.replacement-target`, { recursive: true, force: true });
      rmSync(`${bundleRoot}.identity-original`, { force: true });
      rmSync(`${bundleRoot}.identity-replacement`, { force: true });
      rmSync(`${bundleRoot}.watch-self-test`, { recursive: true, force: true });
    }
    const denied = existsSync(attackMarker);
    rmSync(attackMarker, { force: true });
    const causalExpected = new Map([
      ["initial-real-reparse-swap", "reparse-authority"],
      ["preopen-real-file-substitution", "identity-mismatch"],
      ["postopen-real-file-substitution", "identity-mismatch"],
      ["delayed-kernel-completion", "delayed-kernel-change"],
      ["notification-buffer-overflow", "notification-lost-evidence"],
      ["in-loop-entry-budget", "in-loop-entry-budget"],
    ]);
    if (causalExpected.has(hook)) {
      const outcome = commandLineSelfTestOutcome || "missing";
      process.stdout.write(JSON.stringify({ hook, outcome }));
      const shouldReject = hook === "initial-real-reparse-swap"
        || hook === "in-loop-entry-budget"
        || hook.includes("file-substitution");
      process.exitCode = outcome === causalExpected.get(hook) && rejected === shouldReject ? 0 : 4;
    } else if (successHooks.has(hook) ? rejected : !rejected) process.exitCode = 3;
    else if (hook === "settlement-real-ancestor-swap" && !denied) process.exitCode = 4;
    else if (hook === "hung-descendant-cleanup") {
      const lockPath = join(bundleRoot, "hung-descendant.lock");
      const readyPath = join(bundleRoot, "hung-descendant.ready");
      try {
        if (!existsSync(lockPath) || !existsSync(readyPath)) throw new Error("missing");
        const descriptor = openSync(lockPath, "r+");
        closeSync(descriptor);
        process.exitCode = 0;
      } catch { process.exitCode = 4; }
    } else if (hook === "after-inner-snapshot" || hook === "after-inner-identity") {
      process.exitCode = typeof injectedPath === "string" && existsSync(injectedPath) ? 0 : 4;
    } else process.exitCode = existsSync(bundleRoot) ? 0 : 4;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  && process.argv[2] === "--self-test") await runSelfTest();
